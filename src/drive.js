// Google Drive: buscar, leer, analizar, ordenar y editar los archivos de Cristian.
// Leer y buscar es libre; mover, renombrar, enviar a la papelera o editar exige confirmación.
const G = require('./google');
const H = require('./herramientas');
const Extracciones = require('./extracciones');
const { qPrincipal, usuario } = require('./db');

// ADA_DRIVE_URL solo existe en el entorno de pruebas (Drive simulado); en producción se usa Google.
const SIMULADO = process.env.ADA_DRIVE_URL || '';
const DRIVE = SIMULADO ? `${SIMULADO}/drive/v3` : 'https://www.googleapis.com/drive/v3';
const SHEETS = SIMULADO ? `${SIMULADO}/sheets/v4/spreadsheets` : 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = SIMULADO ? `${SIMULADO}/docs/v1/documents` : 'https://docs.googleapis.com/v1/documents';
const CAMPOS = 'id,name,mimeType,modifiedTime,webViewLink,parents,size,owners(displayName)';
const CAMPOS_VERSION = `${CAMPOS},version,md5Checksum,trashed`;
const PREFIJO_TEMPORAL = 'ADA temporal - ';

const TIPOS = {
  'application/vnd.google-apps.document': 'Google Docs',
  'application/vnd.google-apps.spreadsheet': 'Google Sheets',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.folder': 'Carpeta',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.ms-excel': 'Excel',
  'text/csv': 'CSV',
  'text/plain': 'Texto',
};
const FILTRO_TIPO = {
  documento: "(mimeType = 'application/vnd.google-apps.document' or mimeType contains 'wordprocessingml' or mimeType = 'application/msword')",
  hoja: "(mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType contains 'spreadsheetml' or mimeType = 'application/vnd.ms-excel' or mimeType = 'text/csv')",
  pdf: "mimeType = 'application/pdf'",
  carpeta: "mimeType = 'application/vnd.google-apps.folder'",
  presentacion: "(mimeType = 'application/vnd.google-apps.presentation' or mimeType contains 'presentationml')",
  imagen: "mimeType contains 'image/'",
};

async function conectado() {
  if (SIMULADO) return true;
  const e = await G.estado();
  return e.conectado;
}

async function gfetch(url, opciones = {}) {
  const token = SIMULADO ? 'simulado' : await G.tokenAcceso();
  let res;
  try {
    res = await fetch(url, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opciones.body && !opciones.sinJson ? { 'Content-Type': 'application/json' } : {}),
      ...(opciones.headers || {}),
    },
    });
  } catch (e) {
    throw Object.assign(new Error(`No pude conectar con Google Drive (${e.message})`), { temporal: true });
  }
  if (opciones.crudo) {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(`Google Drive respondió ${res.status}`), { status: res.status, razon: razonDe(data) });
    }
    return res;
  }
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `Google respondió ${res.status}`;
    if (/has not been used|is disabled/i.test(msg)) {
      throw Object.assign(new Error(`Falta habilitar una API en Google Cloud (${msg.match(/(Google \w+ API|\w+\.googleapis\.com)/)?.[0] || 'Drive/Sheets/Docs'}).`), { status: res.status, config: true });
    }
    throw Object.assign(new Error(msg), { status: res.status, razon: razonDe(data) });
  }
  return data;
}
const razonDe = (data) => (data && data.error && Array.isArray(data.error.errors) && data.error.errors[0] ? data.error.errors[0].reason : '') || '';

const comillas = (t) => String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function archivoPublico(f) {
  return {
    id: f.id,
    nombre: f.name,
    tipo: TIPOS[f.mimeType] || f.mimeType,
    modificado: f.modifiedTime ? f.modifiedTime.slice(0, 16).replace('T', ' ') : undefined,
    enlace: f.webViewLink,
    carpeta_id: f.parents ? f.parents[0] : undefined,
    dueño: f.owners && f.owners[0] ? f.owners[0].displayName : undefined,
  };
}

const SIN_CONFIRMAR = {
  error: 'Falta la confirmación de Cristian. Dile exactamente qué vas a cambiar en su Drive (qué archivos y cómo) y espera su "sí". Después vuelve a llamar con confirmado: true.',
};

// ---------- Buscar y explorar ----------

async function buscar(a = {}) {
  const partes = ['trashed = false'];
  if (a.texto) {
    const t = comillas(a.texto);
    partes.push(`(name contains '${t}' or fullText contains '${t}')`);
  }
  if (a.tipo && FILTRO_TIPO[a.tipo]) partes.push(FILTRO_TIPO[a.tipo]);
  if (a.carpeta_id) partes.push(`'${comillas(a.carpeta_id)}' in parents`);
  if (a.modificado_desde) partes.push(`modifiedTime > '${new Date(a.modificado_desde).toISOString()}'`);
  const params = new URLSearchParams({
    q: partes.join(' and '),
    fields: `files(${CAMPOS})`,
    pageSize: String(Math.min(parseInt(a.limite, 10) || 20, 50)),
    orderBy: a.texto ? '' : 'modifiedTime desc',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  if (!params.get('orderBy')) params.delete('orderBy');
  const r = await gfetch(`${DRIVE}/files?${params}`);
  return { total: r.files.length, archivos: r.files.map(archivoPublico) };
}

async function listarCarpeta(a = {}) {
  const id = !a.carpeta_id || a.carpeta_id === 'raiz' ? 'root' : a.carpeta_id;
  const params = new URLSearchParams({
    q: `'${comillas(id)}' in parents and trashed = false`,
    fields: `files(${CAMPOS})`,
    pageSize: '100',
    orderBy: 'folder,name',
  });
  const r = await gfetch(`${DRIVE}/files?${params}`);
  const archivos = r.files.map(archivoPublico);
  return { carpeta_id: id, total: archivos.length, carpetas: archivos.filter((f) => f.tipo === 'Carpeta'), archivos: archivos.filter((f) => f.tipo !== 'Carpeta') };
}

// ---------- Leer ----------

// Devuelve un tramo del texto; si queda más, indica desde dónde seguir leyendo.
function recortar(textoCompleto, max, desdeDado = 0) {
  const desde = Math.max(0, Math.min(desdeDado, textoCompleto.length));
  const texto = textoCompleto.slice(desde, desde + max);
  const fin = desde + texto.length;
  if (fin >= textoCompleto.length) return { texto, completo: desde === 0, ...(desde ? { leido_desde: desde, hasta_el_final: true } : {}) };
  return { texto, completo: false, leido_desde: desde, quedan_caracteres: textoCompleto.length - fin, para_seguir: { desde: fin } };
}

async function leerHoja(id, maxFilas = 300) {
  const meta = await gfetch(`${SHEETS}/${id}?fields=properties.title,sheets.properties(title,gridProperties)`);
  const hojas = meta.sheets.map((s) => s.properties.title);
  const rangos = hojas.map((h) => `ranges=${encodeURIComponent(`'${h.replace(/'/g, "''")}'!A1:AD${maxFilas}`)}`).join('&');
  const v = await gfetch(`${SHEETS}/${id}/values:batchGet?${rangos}&valueRenderOption=FORMATTED_VALUE`);
  return {
    titulo: meta.properties.title,
    hojas: v.valueRanges.map((r, i) => ({
      nombre: hojas[i],
      filas_totales: meta.sheets[i].properties.gridProperties.rowCount,
      valores: r.values || [],
    })),
  };
}

// Registro de copias temporales que no se pudieron borrar (solo las que ADA creó y anotó).
async function anotarTemporal(copia, original, estado, error) {
  await qPrincipal(`INSERT INTO temporales_drive (usuario_id, copia_id, original_id, nombre, estado, error, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE estado = VALUES(estado), error = VALUES(error), actualizado_en = VALUES(actualizado_en), intentos = intentos + 1`,
  [usuario().id, copia.id, original.id, `${PREFIJO_TEMPORAL}${original.name}`.slice(0, 250), estado, error ? String(error).slice(0, 300) : null, new Date(), new Date()]).catch(() => {});
}

// Borra una copia temporal propia: espera la confirmación y reintenta una vez. Nunca toca el original.
async function borrarTemporal(copia, original, ctx) {
  if (!copia || !copia.id || copia.id === original.id) return { ok: false };
  let ultimo = null;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      await gfetch(`${DRIVE}/files/${encodeURIComponent(copia.id)}?supportsAllDrives=true`, { method: 'DELETE' });
      await Extracciones.evento('temporal_borrado', ctx, { archivoId: original.id, motivo: intento > 1 ? 'al_reintento' : null });
      return { ok: true };
    } catch (e) {
      if (e.status === 404) return { ok: true }; // ya no está
      ultimo = e;
      if (intento === 1) await Extracciones.evento('reintento', ctx, { archivoId: original.id, motivo: `borrar_temporal:${e.status || 'red'}` });
    }
  }
  await Extracciones.evento('temporal_fallido', ctx, { archivoId: original.id, motivo: String(ultimo && (ultimo.status || 'red')) });
  await anotarTemporal(copia, original, 'pendiente', ultimo && ultimo.message);
  console.warn(`Drive: no se pudo borrar una copia temporal propia (copia ${copia.id}, de ${original.id}); queda anotada para reintentar.`);
  return { ok: false };
}

// Convierte una copia temporal a formato Google para poder leer Word, Excel o PDF (texto completo).
async function extraerConvirtiendo(f, destino, ctx) {
  const copia = await gfetch(`${DRIVE}/files/${encodeURIComponent(f.id)}/copy?fields=id,name&supportsAllDrives=true`, {
    method: 'POST',
    body: JSON.stringify({ name: `${PREFIJO_TEMPORAL}${f.name}`, mimeType: destino, appProperties: { ada_temporal: '1', ada_original: f.id } }),
  });
  try {
    if (destino.endsWith('spreadsheet')) return { tipo: 'hoja', tipo_archivo: TIPOS[f.mimeType], ...(await leerHoja(copia.id)) };
    const res = await gfetch(`${DRIVE}/files/${copia.id}/export?mimeType=text/plain`, { crudo: true });
    return { tipo: 'texto', tipo_archivo: TIPOS[f.mimeType], texto: await res.text() };
  } finally {
    await borrarTemporal(copia, f, ctx);
  }
}

const LEIBLE = (m) => m === 'application/vnd.google-apps.spreadsheet' || m === 'application/vnd.google-apps.document' || m === 'application/vnd.google-apps.presentation'
  || m.startsWith('text/') || m.includes('spreadsheetml') || m === 'application/vnd.ms-excel'
  || m === 'application/pdf' || m.includes('wordprocessingml') || m === 'application/msword' || m.includes('opendocument.text') || m === 'application/rtf';

// Extrae el contenido completo de un archivo (código, sin IA). Lo usa la capa de extracciones.
async function extraerContenido(f, ctx) {
  const m = f.mimeType;
  if (m === 'application/vnd.google-apps.spreadsheet') return { tipo: 'hoja', tipo_archivo: 'Google Sheets', ...(await leerHoja(f.id)) };
  if (m === 'application/vnd.google-apps.document' || m === 'application/vnd.google-apps.presentation') {
    const res = await gfetch(`${DRIVE}/files/${f.id}/export?mimeType=text/plain`, { crudo: true });
    return { tipo: 'texto', tipo_archivo: TIPOS[m], texto: await res.text() };
  }
  if (m.startsWith('text/')) {
    const res = await gfetch(`${DRIVE}/files/${f.id}?alt=media`, { crudo: true });
    return { tipo: 'texto', tipo_archivo: TIPOS[m] || 'Texto', texto: await res.text() };
  }
  if (m.includes('spreadsheetml') || m === 'application/vnd.ms-excel') return extraerConvirtiendo(f, 'application/vnd.google-apps.spreadsheet', ctx);
  return extraerConvirtiendo(f, 'application/vnd.google-apps.document', ctx);
}

const metadatos = (id) => gfetch(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${CAMPOS_VERSION}&supportsAllDrives=true`);
const DRIVE_EXTRACCION = { metadatos, extraer: extraerContenido, leible: (m) => LEIBLE(m.mimeType || '') };

// Lee un archivo: lo guardado si sigue valiendo (misma versión y con acceso), o lo extrae una sola vez.
async function leer(a = {}, ctx = {}) {
  if (!a.id) throw new Error('id es obligatorio (búscalo con buscar_drive)');
  const max = Math.min(parseInt(a.max_caracteres, 10) || 20000, 60000);
  const desde = Math.max(0, parseInt(a.desde, 10) || 0);
  const contexto = { origen: ctx.trabajoId ? 'trabajo' : 'chat', conversacionId: ctx.conversacionId, turnoId: ctx.turnoId, trabajoId: ctx.trabajoId, pasoId: ctx.pasoId };
  // Carpetas y tipos sin texto: solo sus datos (no se descarga ni se extrae nada).
  const previo = await Extracciones.obtener(a.id, { metadatos, extraer: extraerContenido, leible: (m) => LEIBLE(m.mimeType || '') }, contexto);
  const f = previo.meta;
  const base = { id: f.id, nombre: f.name, enlace: f.webViewLink };
  if (previo.noLeible) {
    if (f.mimeType === 'application/vnd.google-apps.folder') return { ...base, tipo: 'Carpeta', ...(await listarCarpeta({ carpeta_id: f.id })) };
    return { ...base, tipo: TIPOS[f.mimeType] || f.mimeType, nota: 'No puedo leer el contenido de este tipo de archivo; solo sus datos.' };
  }
  const c = previo.contenido;
  const origen = previo.fuente === 'guardado' || previo.fuente === 'simultanea'
    ? { fuente: 'guardado', nota_fuente: 'Contenido ya extraído de esta misma versión: no se volvió a descargar.' }
    : { fuente: 'drive' };
  let cuerpo;
  if (c.tipo === 'hoja') {
    cuerpo = { tipo: c.tipo_archivo, titulo: c.titulo, hojas: c.hojas };
    await Extracciones.evento('lectura_tramo', contexto, { archivoId: f.id, nombre: f.name, version: previo.version, desde: 0, hasta: JSON.stringify(c).length, caracteres: JSON.stringify(c).length });
  } else {
    cuerpo = { tipo: c.tipo_archivo, ...recortar(c.texto, max, desde), ...(!c.texto.trim() ? { nota: 'Este archivo no tiene texto extraíble (probablemente es un escaneo o una imagen). No inventes su contenido.' } : {}) };
    await Extracciones.evento('lectura_tramo', contexto, { archivoId: f.id, nombre: f.name, version: previo.version, desde, hasta: Math.min(c.texto.length, desde + max), caracteres: c.texto.length });
  }
  // Lo que la conversación necesita saber de la capa de extracciones (sin claves ni variables).
  const guardado = previo.fuente === 'guardado' || previo.fuente === 'simultanea'
    ? { estado: 'reutilizada', descarga_nueva: false }
    : previo.fuente === 'drive_guardado'
      ? { estado: 'extraccion_nueva_guardada', descarga_nueva: true }
      : { estado: 'leido_sin_guardar', descarga_nueva: true, motivo: previo.sinGuardar || 'no_habilitado' };
  if (Extracciones.modo() === 'prueba') guardado.en_carpeta_de_prueba = Extracciones.enCarpetaDePrueba(f);
  const r = { ...base, version: previo.version, ...origen, guardado, ...cuerpo };
  if (previo.sinGuardar === 'consentimiento_pendiente' && contexto.origen === 'chat' && typeof ctx.emitir === 'function' && !ctx.consentimientoPedido) {
    ctx.consentimientoPedido = true;
    ctx.emitir('consentimiento_extracciones', { texto: Extracciones.TEXTO_CONSENTIMIENTO });
    r.aviso_guardado = 'Te aparece en pantalla una pregunta para guardar cifrado lo que extraigo de tus documentos (30 días como máximo). Menciónaselo en una frase: decide con los botones; si no acepta, todo sigue funcionando sin guardar.';
  }
  return r;
}

// Para los encargos (motor de trabajos): extrae o reutiliza sin devolver texto al resultado del paso.
// Hasta aprobar la prueba con Drive real, solo funciona con Drive simulado o en la carpeta de prueba aprobada.
async function obtenerParaTrabajo(archivoId, ctx) {
  const carpetaPrueba = process.env.ADA_DRIVE_CARPETA_PRUEBA || '';
  if (!SIMULADO && !carpetaPrueba) {
    throw Object.assign(new Error('Los encargos todavía no pueden leer documentos reales: solo Drive simulado o la carpeta de prueba aprobada.'), { status: 409, config: true });
  }
  return Extracciones.obtener(archivoId, {
    metadatos: async (id) => {
      const meta = await metadatos(id);
      if (!SIMULADO && !(carpetaPrueba && (meta.parents || []).includes(carpetaPrueba))) {
        throw Object.assign(new Error('Los encargos todavía no pueden leer documentos reales: solo Drive simulado o la carpeta de prueba aprobada.'), { status: 409, config: true });
      }
      return meta;
    },
    extraer: extraerContenido,
    leible: (m) => LEIBLE(m.mimeType || ''),
  }, { ...ctx, origen: 'trabajo' });
}

async function extraerParaTrabajo(archivoId, ctx) {
  const r = await obtenerParaTrabajo(archivoId, ctx);
  if (r.noLeible) return { archivo_id: r.meta.id, nombre: r.meta.name, version: r.version, caracteres: 0, fuente: 'sin_texto', guardado: false };
  const total = r.contenido.tipo === 'texto' ? r.contenido.texto.length : JSON.stringify(r.contenido).length;
  return { archivo_id: r.meta.id, nombre: r.meta.name, version: r.version, caracteres: total, fuente: r.fuente === 'guardado' || r.fuente === 'simultanea' ? 'guardado' : 'drive', guardado: !r.sinGuardar };
}

// Texto de un documento para un paso de encargo (Fase 3c): misma capa de extracciones (reutiliza si no
// cambió). Solo vive en memoria del paso; lo que se guarda del paso son fragmentos cifrados.
async function textoParaTrabajo(archivoId, ctx) {
  const r = await obtenerParaTrabajo(archivoId, ctx);
  if (r.noLeible) throw new Error('El archivo no es un documento con texto');
  const texto = r.contenido.tipo === 'texto' ? r.contenido.texto : (r.contenido.hojas || []).map((h) => `${h.nombre}\n${(h.valores || []).map((f) => f.join(' | ')).join('\n')}`).join('\n\n');
  return { texto, version: r.version, archivo_id: r.meta.id, nombre: r.meta.name, fuente: r.fuente === 'guardado' || r.fuente === 'simultanea' ? 'guardado' : 'drive' };
}

// Reintenta borrar las copias temporales propias que quedaron anotadas. Antes de borrar, comprueba que la
// copia lleva la marca de ADA y el nombre esperado: nunca borra originales ni archivos sin esa marca.
async function reintentarTemporales() {
  const filas = await qPrincipal("SELECT copia_id, original_id, nombre FROM temporales_drive WHERE usuario_id = ? AND estado = 'pendiente' LIMIT 50", [usuario().id]);
  let borrados = 0; let fallidos = 0; let omitidos = 0;
  for (const t of filas) {
    try {
      const m = await gfetch(`${DRIVE}/files/${encodeURIComponent(t.copia_id)}?fields=id,name,appProperties&supportsAllDrives=true`);
      const propio = m.appProperties && m.appProperties.ada_temporal === '1' && String(m.name || '').startsWith(PREFIJO_TEMPORAL) && m.id !== t.original_id;
      if (!propio) { omitidos += 1; await qPrincipal("UPDATE temporales_drive SET estado = 'omitido', actualizado_en = ? WHERE usuario_id = ? AND copia_id = ?", [new Date(), usuario().id, t.copia_id]); continue; }
      await gfetch(`${DRIVE}/files/${encodeURIComponent(t.copia_id)}?supportsAllDrives=true`, { method: 'DELETE' });
      borrados += 1;
      await qPrincipal("UPDATE temporales_drive SET estado = 'borrado', actualizado_en = ? WHERE usuario_id = ? AND copia_id = ?", [new Date(), usuario().id, t.copia_id]);
      await Extracciones.evento('temporal_borrado', { origen: 'ajustes' }, { archivoId: t.original_id, motivo: 'reintento_manual' });
    } catch (e) {
      if (e.status === 404) { borrados += 1; await qPrincipal("UPDATE temporales_drive SET estado = 'borrado', actualizado_en = ? WHERE usuario_id = ? AND copia_id = ?", [new Date(), usuario().id, t.copia_id]); continue; }
      fallidos += 1;
      await qPrincipal("UPDATE temporales_drive SET intentos = intentos + 1, error = ?, actualizado_en = ? WHERE usuario_id = ? AND copia_id = ?", [String(e.message).slice(0, 300), new Date(), usuario().id, t.copia_id]);
    }
  }
  return { revisados: filas.length, borrados, fallidos, omitidos };
}

// ---------- Ordenar ----------

// Durante la prueba de la Fase 3b (ADA_EXTRACCIONES=prueba), el servidor bloquea toda modificación en Drive
// fuera de la carpeta de prueba, aunque Cristian la autorice en la conversación. objetivos: [{ id, carpeta }]
// (carpeta: true si es una carpeta de destino, que puede ser la carpeta de prueba misma).
const FUERA_DE_PRUEBA = 'Archivo fuera de la carpeta autorizada para la prueba';
async function protegerEscritura(objetivos, accion, ctx = {}) {
  if (Extracciones.modo() !== 'prueba' || usuario().id !== 1) return;
  const carpetaPrueba = process.env.ADA_DRIVE_CARPETA_PRUEBA || '';
  const contexto = { origen: ctx.trabajoId ? 'trabajo' : 'chat', conversacionId: ctx.conversacionId, turnoId: ctx.turnoId };
  const bloquear = async (id, nombre, detalle) => {
    await Extracciones.evento('escritura_bloqueada', contexto, { archivoId: id || '(sin id)', nombre, motivo: accion });
    throw Object.assign(new Error(`${FUERA_DE_PRUEBA}: no hice ningún cambio (${detalle}). Durante la prueba de guardado solo se puede modificar lo que está en la carpeta de prueba, aunque lo autorices.`), { bloqueado: true, status: 403 });
  };
  for (const o of objetivos) {
    if (o.carpeta && carpetaPrueba && o.id === carpetaPrueba) continue;
    if (!o.id) await bloquear(null, null, o.carpeta ? 'el destino no es la carpeta de prueba' : 'sin archivo');
    let meta;
    try {
      await Extracciones.evento('consulta_metadatos', contexto, { archivoId: o.id, motivo: `antes_de_${accion}` });
      meta = await metadatos(o.id);
    } catch (e) {
      await bloquear(o.id, null, 'no pude comprobar dónde está');
    }
    if (!Extracciones.enCarpetaDePrueba(meta)) await bloquear(o.id, meta.name, o.carpeta ? 'el destino está fuera de la carpeta de prueba' : 'está fuera de la carpeta de prueba');
  }
}

async function crearCarpeta(a = {}, ctx = {}) {
  await protegerEscritura([{ id: a.dentro_de_id, carpeta: true }], 'crear_carpeta', ctx);
  if (!a.nombre) throw new Error('nombre es obligatorio');
  const f = await gfetch(`${DRIVE}/files?fields=${CAMPOS}`, {
    method: 'POST',
    body: JSON.stringify({
      name: a.nombre,
      mimeType: 'application/vnd.google-apps.folder',
      parents: a.dentro_de_id ? [a.dentro_de_id] : undefined,
    }),
  });
  return { ok: true, carpeta: archivoPublico(f) };
}

async function mover(a = {}, ctx = {}) {
  await protegerEscritura([{ id: a.id }, { id: a.carpeta_destino_id, carpeta: true }], 'mover', ctx);
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id || !a.carpeta_destino_id) throw new Error('id y carpeta_destino_id son obligatorios');
  const actual = await gfetch(`${DRIVE}/files/${encodeURIComponent(a.id)}?fields=parents`);
  const params = new URLSearchParams({ addParents: a.carpeta_destino_id, fields: CAMPOS });
  if (actual.parents && actual.parents.length) params.set('removeParents', actual.parents.join(','));
  const f = await gfetch(`${DRIVE}/files/${encodeURIComponent(a.id)}?${params}`, { method: 'PATCH', body: '{}' });
  return { ok: true, archivo: archivoPublico(f) };
}

async function renombrar(a = {}, ctx = {}) {
  await protegerEscritura([{ id: a.id }], 'renombrar', ctx);
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id || !a.nuevo_nombre) throw new Error('id y nuevo_nombre son obligatorios');
  const f = await gfetch(`${DRIVE}/files/${encodeURIComponent(a.id)}?fields=${CAMPOS}`, {
    method: 'PATCH', body: JSON.stringify({ name: a.nuevo_nombre }),
  });
  return { ok: true, archivo: archivoPublico(f) };
}

async function papelera(a = {}, ctx = {}) {
  await protegerEscritura([{ id: a.id }], 'papelera', ctx);
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id) throw new Error('id es obligatorio');
  const f = await gfetch(`${DRIVE}/files/${encodeURIComponent(a.id)}?fields=${CAMPOS}`, {
    method: 'PATCH', body: JSON.stringify({ trashed: true }),
  });
  return { ok: true, archivo: archivoPublico(f), nota: 'Quedó en la papelera de Drive; se puede recuperar por 30 días.' };
}

// ---------- Editar ----------

async function editarHoja(a = {}, ctx = {}) {
  await protegerEscritura([{ id: a.id }], 'editar_hoja', ctx);
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id || !Array.isArray(a.valores) || !a.valores.length) throw new Error('id y valores son obligatorios');
  let hoja = a.hoja;
  if (!hoja) {
    const meta = await gfetch(`${SHEETS}/${a.id}?fields=sheets.properties.title`);
    hoja = meta.sheets[0].properties.title;
  }
  const h = `'${hoja.replace(/'/g, "''")}'`;
  if (a.accion === 'actualizar') {
    if (!a.rango) throw new Error('Para actualizar indica el rango (ej: B5 o B5:D7)');
    const r = await gfetch(`${SHEETS}/${a.id}/values/${encodeURIComponent(`${h}!${a.rango}`)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', body: JSON.stringify({ values: a.valores }),
    });
    return { ok: true, celdas_actualizadas: r.updatedCells, rango: r.updatedRange };
  }
  const r = await gfetch(`${SHEETS}/${a.id}/values/${encodeURIComponent(`${h}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST', body: JSON.stringify({ values: a.valores }),
  });
  return { ok: true, filas_agregadas: a.valores.length, rango: r.updates && r.updates.updatedRange };
}

async function editarDocumento(a = {}, ctx = {}) {
  await protegerEscritura([{ id: a.id }], 'editar_documento', ctx);
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id) throw new Error('id es obligatorio');
  const pedidos = [];
  for (const r of a.reemplazar || []) {
    if (r.buscar) pedidos.push({ replaceAllText: { containsText: { text: r.buscar, matchCase: true }, replaceText: r.por || '' } });
  }
  if (a.agregar_al_final) pedidos.push({ insertText: { endOfSegmentLocation: {}, text: `\n${a.agregar_al_final}` } });
  if (!pedidos.length) throw new Error('Indica qué agregar o qué reemplazar');
  const r = await gfetch(`${DOCS}/${a.id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: pedidos }) });
  const reemplazos = (r.replies || []).reduce((n, x) => n + ((x.replaceAllText && x.replaceAllText.occurrencesChanged) || 0), 0);
  return { ok: true, reemplazos, agregado: !!a.agregar_al_final };
}

// ---------- Subir lo que ADA crea ----------

const carpetasAda = new Map(); // por persona
async function carpetaADA() {
  const uid = require('./db').usuario().id;
  if (carpetasAda.has(uid)) return carpetasAda.get(uid);
  let carpetaAdaId;
  const params = new URLSearchParams({
    q: "name = 'ADA' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
    fields: 'files(id)',
  });
  const r = await gfetch(`${DRIVE}/files?${params}`);
  if (r.files.length) carpetaAdaId = r.files[0].id;
  else carpetaAdaId = (await crearCarpeta({ nombre: 'ADA' })).carpeta.id;
  carpetasAda.set(uid, carpetaAdaId);
  return carpetaAdaId;
}

async function subirComoGoogle({ nombre, datos, tipo, carpetaId }) {
  // En la prueba, nada se sube fuera de la carpeta de prueba (tampoco a la carpeta ADA, que no se crea).
  await protegerEscritura([{ id: carpetaId, carpeta: true }], 'subir_archivo');
  const destino = carpetaId || (await carpetaADA());
  const meta = {
    name: nombre,
    mimeType: tipo === 'excel' ? 'application/vnd.google-apps.spreadsheet' : 'application/vnd.google-apps.document',
    parents: [destino],
  };
  const origen = tipo === 'excel'
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const limite = `ada${Date.now()}`;
  const cuerpo = Buffer.concat([
    Buffer.from(`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${limite}\r\nContent-Type: ${origen}\r\n\r\n`),
    datos,
    Buffer.from(`\r\n--${limite}--`),
  ]);
  const f = await gfetch(`${SIMULADO || 'https://www.googleapis.com'}/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    sinJson: true,
    headers: { 'Content-Type': `multipart/related; boundary=${limite}` },
    body: cuerpo,
  });
  return { id: f.id, url: f.webViewLink, carpeta: carpetaId ? undefined : 'ADA' };
}

// ---------- Definiciones para Claude ----------

const ID = { type: 'string', description: 'id del archivo (de buscar_drive o listar_carpeta_drive)' };
const CONF = { type: 'boolean', description: 'true solo si Cristian ya aprobó este cambio' };

H.registrar([
  {
    name: 'buscar_drive',
    description: 'Busca en el Google Drive de Cristian por nombre o contenido, con filtros de tipo, carpeta y fecha. Sin texto, muestra lo más reciente.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Palabras a buscar en el nombre o dentro del archivo' },
        tipo: { type: 'string', enum: Object.keys(FILTRO_TIPO) },
        carpeta_id: { type: 'string' },
        modificado_desde: { type: 'string', description: 'YYYY-MM-DD' },
        limite: { type: 'integer' },
      },
    },
  },
  {
    name: 'listar_carpeta_drive',
    description: 'Muestra el contenido de una carpeta de Drive (o la raíz con "raiz"). Úsala para conocer cómo está organizado antes de proponer un orden.',
    input_schema: { type: 'object', properties: { carpeta_id: { type: 'string', description: 'id de carpeta o "raiz"' } } },
  },
  {
    name: 'leer_drive',
    description: 'Lee el contenido de un archivo de Drive para resumirlo, analizarlo o responder preguntas: Google Docs, Sheets (con todas sus hojas), Slides, Word, Excel, PDF, CSV y texto. Si un documento largo viene incompleto, el resultado trae para_seguir.desde: vuelve a llamar con desde para leer lo que sigue.',
    input_schema: { type: 'object', properties: { id: ID, max_caracteres: { type: 'integer' }, desde: { type: 'integer', description: 'Carácter desde el que seguir leyendo un documento largo' } }, required: ['id'] },
  },
  {
    name: 'estado_guardado_documentos',
    description: 'Estado del guardado cifrado de documentos (Fase 3b), consultado al servidor: modo (apagado, prueba o encendido), si el cifrado está listo, si hay carpeta de prueba, el consentimiento de Cristian y cuántos documentos hay guardados. No muestra claves ni contenido. Úsala cuando necesites saber si puedes seguir con una prueba de lectura y guardado.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'crear_carpeta_drive',
    description: 'Crea una carpeta en Drive (en la raíz o dentro de otra).',
    input_schema: { type: 'object', properties: { nombre: { type: 'string' }, dentro_de_id: { type: 'string' } }, required: ['nombre'] },
  },
  {
    name: 'mover_drive',
    description: 'Mueve un archivo o carpeta a otra carpeta. Para ordenar varios, primero propón el plan completo a Cristian y, con su sí, ejecútalo.',
    input_schema: { type: 'object', properties: { id: ID, carpeta_destino_id: { type: 'string' }, confirmado: CONF }, required: ['id', 'carpeta_destino_id', 'confirmado'] },
  },
  {
    name: 'renombrar_drive',
    description: 'Cambia el nombre de un archivo o carpeta de Drive.',
    input_schema: { type: 'object', properties: { id: ID, nuevo_nombre: { type: 'string' }, confirmado: CONF }, required: ['id', 'nuevo_nombre', 'confirmado'] },
  },
  {
    name: 'papelera_drive',
    description: 'Envía un archivo a la papelera de Drive (recuperable 30 días). Nunca borres sin que Cristian lo pida y lo confirme.',
    input_schema: { type: 'object', properties: { id: ID, confirmado: CONF }, required: ['id', 'confirmado'] },
  },
  {
    name: 'editar_hoja_drive',
    description: 'Edita una planilla de Google Sheets: agregar filas al final (accion "agregar_filas") o actualizar celdas (accion "actualizar" con rango, ej "B5:D7"). Acepta fórmulas ("=SUM(B2:B9)").',
    input_schema: {
      type: 'object',
      properties: {
        id: ID,
        hoja: { type: 'string', description: 'Nombre de la pestaña (por defecto la primera)' },
        accion: { type: 'string', enum: ['agregar_filas', 'actualizar'] },
        rango: { type: 'string' },
        valores: { type: 'array', items: { type: 'array', items: {} } },
        confirmado: CONF,
      },
      required: ['id', 'accion', 'valores', 'confirmado'],
    },
  },
  {
    name: 'editar_documento_drive',
    description: 'Edita un Google Docs: agregar texto al final y/o reemplazar textos exactos.',
    input_schema: {
      type: 'object',
      properties: {
        id: ID,
        agregar_al_final: { type: 'string' },
        reemplazar: { type: 'array', items: { type: 'object', properties: { buscar: { type: 'string' }, por: { type: 'string' } } } },
        confirmado: CONF,
      },
      required: ['id', 'confirmado'],
    },
  },
], {
  buscar_drive: buscar,
  listar_carpeta_drive: listarCarpeta,
  leer_drive: leer,
  estado_guardado_documentos: () => Extracciones.estadoPublico(),
  crear_carpeta_drive: crearCarpeta,
  mover_drive: mover,
  renombrar_drive: renombrar,
  papelera_drive: papelera,
  editar_hoja_drive: editarHoja,
  editar_documento_drive: editarDocumento,
});

// Cierre 3b: lectura de verificación sin IA (mismo camino que leer_drive; devuelve solo metadatos, nunca el texto).
async function lecturaVerificacion(archivoId) {
  const t0 = Date.now();
  try {
    const r = await Extracciones.obtener(String(archivoId), DRIVE_EXTRACCION, { origen: 'verificacion' });
    if (r.noLeible) return { ok: false, resultado: 'no es un documento con texto' };
    const caracteres = r.contenido.tipo === 'texto' ? r.contenido.texto.length : JSON.stringify(r.contenido).length;
    return { ok: true, resultado: r.fuente === 'guardado' || r.fuente === 'simultanea' ? 'reutilizada (sin descargar)' : r.sinGuardar ? 'leída sin guardar' : 'descargada y guardada cifrada', archivo: r.meta.name, caracteres, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, resultado: e.sinAcceso ? 'sin acceso: lo guardado se descartó' : e.bloqueado ? 'fuera de la carpeta de prueba' : `error: ${e.message}`, ms: Date.now() - t0 };
  }
}

// Copias temporales de ADA que sigan vivas en Drive (solo nombres e ids; nunca contenido).
async function copiasTemporalesVivas() {
  const params = new URLSearchParams({ q: "appProperties has { key='ada_temporal' and value='1' } and trashed = false", fields: 'files(id,name,createdTime)', pageSize: '50' });
  const r = await gfetch(`${DRIVE}/files?${params}`);
  return (r.files || []).map((f) => ({ id_termina_en: f.id.slice(-6), nombre: f.name, creado: f.createdTime }));
}

module.exports = { conectado, lecturaVerificacion, copiasTemporalesVivas, subirComoGoogle, protegerEscritura, FUERA_DE_PRUEBA, buscar, leer, extraerParaTrabajo, textoParaTrabajo, reintentarTemporales, metadatos, DRIVE_EXTRACCION };
