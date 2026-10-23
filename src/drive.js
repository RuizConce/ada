// Google Drive: buscar, leer, analizar, ordenar y editar los archivos de Cristian.
// Leer y buscar es libre; mover, renombrar, enviar a la papelera o editar exige confirmación.
const G = require('./google');
const H = require('./herramientas');

const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const CAMPOS = 'id,name,mimeType,modifiedTime,webViewLink,parents,size,owners(displayName)';

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
  const e = await G.estado();
  return e.conectado;
}

async function gfetch(url, opciones = {}) {
  const token = await G.tokenAcceso();
  const res = await fetch(url, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opciones.body && !opciones.sinJson ? { 'Content-Type': 'application/json' } : {}),
      ...(opciones.headers || {}),
    },
  });
  if (opciones.crudo) {
    if (!res.ok) throw new Error(`Google Drive respondió ${res.status}`);
    return res;
  }
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `Google respondió ${res.status}`;
    if (/has not been used|is disabled/i.test(msg)) {
      throw new Error(`Falta habilitar una API en Google Cloud (${msg.match(/(Google \w+ API|\w+\.googleapis\.com)/)?.[0] || 'Drive/Sheets/Docs'}).`);
    }
    throw new Error(msg);
  }
  return data;
}

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

function recortar(texto, max) {
  if (texto.length <= max) return { texto, completo: true };
  return { texto: `${texto.slice(0, max)}\n[…recortado: ${texto.length - max} caracteres más]`, completo: false };
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

// Convierte una copia temporal a formato Google para poder leer Word, Excel o PDF.
async function leerConvirtiendo(f, destino, max) {
  const copia = await gfetch(`${DRIVE}/files/${f.id}/copy?fields=id`, {
    method: 'POST',
    body: JSON.stringify({ name: `ADA temporal - ${f.name}`, mimeType: destino }),
  });
  try {
    if (destino.endsWith('spreadsheet')) return { tipo: TIPOS[f.mimeType], ...(await leerHoja(copia.id)) };
    const res = await gfetch(`${DRIVE}/files/${copia.id}/export?mimeType=text/plain`, { crudo: true });
    return { tipo: TIPOS[f.mimeType], ...recortar(await res.text(), max) };
  } finally {
    gfetch(`${DRIVE}/files/${copia.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

async function leer(a = {}) {
  if (!a.id) throw new Error('id es obligatorio (búscalo con buscar_drive)');
  const max = Math.min(parseInt(a.max_caracteres, 10) || 20000, 60000);
  const f = await gfetch(`${DRIVE}/files/${encodeURIComponent(a.id)}?fields=${CAMPOS}&supportsAllDrives=true`);
  const base = { id: f.id, nombre: f.name, enlace: f.webViewLink };
  const m = f.mimeType;
  if (m === 'application/vnd.google-apps.spreadsheet') return { ...base, tipo: 'Google Sheets', ...(await leerHoja(f.id)) };
  if (m === 'application/vnd.google-apps.document' || m === 'application/vnd.google-apps.presentation') {
    const res = await gfetch(`${DRIVE}/files/${f.id}/export?mimeType=text/plain`, { crudo: true });
    return { ...base, tipo: TIPOS[m], ...recortar(await res.text(), max) };
  }
  if (m === 'application/vnd.google-apps.folder') return { ...base, tipo: 'Carpeta', ...(await listarCarpeta({ carpeta_id: f.id })) };
  if (m.startsWith('text/')) {
    const res = await gfetch(`${DRIVE}/files/${f.id}?alt=media`, { crudo: true });
    return { ...base, tipo: TIPOS[m] || 'Texto', ...recortar(await res.text(), max) };
  }
  if (m.includes('spreadsheetml') || m === 'application/vnd.ms-excel') {
    return { ...base, ...(await leerConvirtiendo(f, 'application/vnd.google-apps.spreadsheet', max)) };
  }
  if (m === 'application/pdf' || m.includes('wordprocessingml') || m === 'application/msword' || m.includes('opendocument.text') || m === 'application/rtf') {
    return { ...base, ...(await leerConvirtiendo(f, 'application/vnd.google-apps.document', max)) };
  }
  return { ...base, tipo: TIPOS[m] || m, nota: 'No puedo leer el contenido de este tipo de archivo; solo sus datos.' };
}

// ---------- Ordenar ----------

async function crearCarpeta(a = {}) {
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

async function mover(a = {}) {
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id || !a.carpeta_destino_id) throw new Error('id y carpeta_destino_id son obligatorios');
  const actual = await gfetch(`${DRIVE}/files/${encodeURIComponent(a.id)}?fields=parents`);
  const params = new URLSearchParams({ addParents: a.carpeta_destino_id, fields: CAMPOS });
  if (actual.parents && actual.parents.length) params.set('removeParents', actual.parents.join(','));
  const f = await gfetch(`${DRIVE}/files/${encodeURIComponent(a.id)}?${params}`, { method: 'PATCH', body: '{}' });
  return { ok: true, archivo: archivoPublico(f) };
}

async function renombrar(a = {}) {
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id || !a.nuevo_nombre) throw new Error('id y nuevo_nombre son obligatorios');
  const f = await gfetch(`${DRIVE}/files/${encodeURIComponent(a.id)}?fields=${CAMPOS}`, {
    method: 'PATCH', body: JSON.stringify({ name: a.nuevo_nombre }),
  });
  return { ok: true, archivo: archivoPublico(f) };
}

async function papelera(a = {}) {
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id) throw new Error('id es obligatorio');
  const f = await gfetch(`${DRIVE}/files/${encodeURIComponent(a.id)}?fields=${CAMPOS}`, {
    method: 'PATCH', body: JSON.stringify({ trashed: true }),
  });
  return { ok: true, archivo: archivoPublico(f), nota: 'Quedó en la papelera de Drive; se puede recuperar por 30 días.' };
}

// ---------- Editar ----------

async function editarHoja(a = {}) {
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

async function editarDocumento(a = {}) {
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

let carpetaAdaId = null;
async function carpetaADA() {
  if (carpetaAdaId) return carpetaAdaId;
  const params = new URLSearchParams({
    q: "name = 'ADA' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
    fields: 'files(id)',
  });
  const r = await gfetch(`${DRIVE}/files?${params}`);
  if (r.files.length) carpetaAdaId = r.files[0].id;
  else carpetaAdaId = (await crearCarpeta({ nombre: 'ADA' })).carpeta.id;
  return carpetaAdaId;
}

async function subirComoGoogle({ nombre, datos, tipo, carpetaId }) {
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
  const f = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
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
    description: 'Lee el contenido de un archivo de Drive para resumirlo, analizarlo o responder preguntas: Google Docs, Sheets (con todas sus hojas), Slides, Word, Excel, PDF, CSV y texto.',
    input_schema: { type: 'object', properties: { id: ID, max_caracteres: { type: 'integer' } }, required: ['id'] },
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
  crear_carpeta_drive: crearCarpeta,
  mover_drive: mover,
  renombrar_drive: renombrar,
  papelera_drive: papelera,
  editar_hoja_drive: editarHoja,
  editar_documento_drive: editarDocumento,
});

module.exports = { conectado, subirComoGoogle, buscar, leer };
