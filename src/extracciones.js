// Extracciones (Fase 3b): el texto de cada documento de Drive se extrae una sola vez por versión,
// se guarda cifrado en la base de la persona (solo con su consentimiento) y se reutiliza tanto en la
// conversación como en los encargos. Antes de reutilizar se comprueba en Drive el acceso y la versión.
//
// Reglas:
// - Identidad: persona + archivo + versión (binarios: version + md5; nativos de Google: version + modifiedTime).
// - Sin consentimiento o sin clave de cifrado: se lee igual, pero no se guarda nada.
// - Si Drive dice que no existe o no hay permiso: se invalida (se borra el texto) y no se muestra.
// - Si no se puede comprobar el acceso (error temporal): no se muestra lo guardado hasta confirmarlo.
// - Dos pedidos simultáneos del mismo archivo y versión: una sola descarga (en el proceso y entre procesos).
// - Vence a los 30 días desde que se extrajo; se puede borrar todo en cualquier momento.
// - Los registros (extraccion_eventos) guardan solo id, versión, tramo y tamaños: nunca texto.
const crypto = require('crypto');
const { q, qPrincipal, getPool, usuario } = require('./db');
const Cifrado = require('./cifrado');

const RETENCION_DIAS = () => parseInt(process.env.ADA_EXTRACCIONES_DIAS, 10) || 30;
const MAX_SIMULTANEAS = 3;
const VERSION_CONSENTIMIENTO = 1;
const TEXTO_CONSENTIMIENTO = 'Para no volver a descargar ni convertir los mismos documentos cada vez, puedo guardar el texto que extraigo de tus archivos de Drive, cifrado (AES-256-GCM) en tu base privada, por un máximo de 30 días. Solo lo reutilizo si el archivo no cambió y sigues teniendo acceso; si cambia o pierdes el acceso, lo descarto. Puedes borrarlo todo cuando quieras desde Ajustes. Si no aceptas, sigo leyendo tus documentos igual, sin guardar nada.';

const err = (m, extra = {}) => Object.assign(new Error(m), extra);
const ahora = () => new Date();
// Apagado por defecto en producción. ADA_EXTRACCIONES=prueba: solo guarda archivos de la carpeta de prueba
// (ADA_DRIVE_CARPETA_PRUEBA), para la prueba con Drive real. ADA_EXTRACCIONES=si: todos los archivos.
const modo = () => (['si', 'prueba'].includes(process.env.ADA_EXTRACCIONES) ? process.env.ADA_EXTRACCIONES : 'no');
const habilitado = () => modo() !== 'no' && usuario().id === 1;
const enAlcance = (meta) => modo() !== 'prueba' || (!!process.env.ADA_DRIVE_CARPETA_PRUEBA && (meta.parents || []).includes(process.env.ADA_DRIVE_CARPETA_PRUEBA));

// ---------- Consentimiento ----------

async function consentimiento() {
  const [r] = await q("SELECT datos FROM integraciones WHERE nombre = 'extracciones_consentimiento'");
  const d = r ? JSON.parse(r.datos) : {};
  return { estado: d.estado || 'sin_responder', fecha: d.fecha || null, version: d.version || null };
}

async function responderConsentimiento(acepto) {
  if (usuario().id !== 1) throw err('Guardar documentos está disponible solo para la cuenta principal en esta etapa.', { status: 403 });
  const datos = { estado: acepto ? 'aceptado' : 'rechazado', fecha: ahora().toISOString(), version: VERSION_CONSENTIMIENTO };
  await q(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', ?, ?)
    ON DUPLICATE KEY UPDATE datos = VALUES(datos), actualizado_en = VALUES(actualizado_en)`, [JSON.stringify(datos), ahora()]);
  let borradas = 0;
  if (!acepto) borradas = (await borrarTodo({ motivo: 'consentimiento_retirado' })).borradas;
  return { ...datos, borradas };
}

// ¿Se puede guardar? Devuelve el motivo si no.
async function puedeGuardar() {
  if (!habilitado()) return { ok: false, motivo: 'no_habilitado' };
  if (!Cifrado.disponible()) return { ok: false, motivo: 'sin_clave' };
  const c = await consentimiento();
  if (c.estado !== 'aceptado') return { ok: false, motivo: c.estado === 'rechazado' ? 'sin_consentimiento' : 'consentimiento_pendiente' };
  return { ok: true };
}

// ---------- Registro de eventos (sin contenido) ----------

async function evento(tipo, ctx = {}, datos = {}) {
  try {
    await qPrincipal(`INSERT INTO extraccion_eventos (usuario_id, tipo, motivo, archivo_id, nombre, version, origen, conversacion_id, turno_id, trabajo_id, paso_id,
        desde, hasta, caracteres, duracion_ms, instancia, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [usuario().id, tipo, datos.motivo ? String(datos.motivo).slice(0, 60) : null, datos.archivoId ? String(datos.archivoId).slice(0, 128) : null,
      datos.nombre ? String(datos.nombre).slice(0, 250) : null,
      datos.version ? String(datos.version).slice(0, 120) : null, ctx.origen || (ctx.trabajoId ? 'trabajo' : 'chat'),
      ctx.conversacionId || null, ctx.turnoId || null, ctx.trabajoId || null, ctx.pasoId || null,
      datos.desde != null ? datos.desde : null, datos.hasta != null ? datos.hasta : null, datos.caracteres != null ? datos.caracteres : null,
      datos.duracionMs != null ? datos.duracionMs : null, require('./registro').INSTANCIA, ahora()]);
  } catch (e) {
    console.error('Extracciones (registro):', e.message);
  }
}

// ---------- Versión e identidad ----------

const BINARIO = (m) => !String(m || '').startsWith('application/vnd.google-apps.');
function claveVersion(meta) {
  if (BINARIO(meta.mimeType)) return `v${meta.version || '?'}:md5:${meta.md5Checksum || meta.modifiedTime || '?'}`;
  return `v${meta.version || '?'}:mod:${meta.modifiedTime || '?'}`;
}

// ---------- Exclusión (una sola descarga por archivo y versión) ----------

const enVuelo = new Map(); // clave → promesa de la extracción en curso en este proceso
let activas = 0;
const cola = [];
async function turnoDeExtraccion(fn) {
  if (activas >= MAX_SIMULTANEAS) await new Promise((r) => cola.push(r));
  activas += 1;
  try { return await fn(); } finally { activas -= 1; const s = cola.shift(); if (s) s(); }
}

// Bloqueo entre procesos (dos instancias durante un despliegue): GET_LOCK en una conexión propia.
async function conBloqueo(nombre, fn) {
  const cx = await getPool().getConnection();
  try {
    const [[r]] = await cx.query('SELECT GET_LOCK(?, 120) AS ok', [nombre]);
    if (!r || r.ok !== 1) throw err('No pude obtener el turno para extraer este archivo; intenta de nuevo.', { temporal: true });
    try {
      const tq = async (sql, params = []) => (await cx.query(sql, params))[0];
      return await fn(tq);
    } finally {
      await cx.query('SELECT RELEASE_LOCK(?)', [nombre]).catch(() => {});
    }
  } finally {
    cx.release();
  }
}

// ---------- Errores temporales y reintento controlado ----------

// 403 de Drive puede ser límite de uso (temporal) o falta de permiso; 401 es la conexión con Google, no el archivo.
const LIMITE = /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded|backendError/i;
const esTemporal = (e) => !!(e && (e.temporal || e.status === 429 || (e.status >= 500 && e.status <= 599) || (e.status === 403 && LIMITE.test(e.razon || ''))
  || (!e.status && !e.sinAcceso && /fetch failed|ECONN|ETIMEDOUT|socket|network|terminated/i.test(e.message || ''))));
const esSinAcceso = (e) => !!(e && !esTemporal(e) && !e.config && (e.sinAcceso || e.status === 404 || e.status === 403));

async function conReintento(fn, ctx, datos, etiqueta) {
  try {
    return await fn();
  } catch (e) {
    if (!esTemporal(e)) throw e;
    await evento('reintento', ctx, { ...datos, motivo: `${etiqueta}:${e.status || 'red'}` });
    await new Promise((r) => setTimeout(r, parseInt(process.env.ADA_EXTRACCIONES_ESPERA_MS, 10) || 400));
    return fn();
  }
}

// ---------- Invalidar, vencer, borrar ----------

async function invalidarArchivo(archivoId, motivo, ctx) {
  const r = await q("UPDATE extracciones SET estado = 'invalidada', motivo = ?, texto_cifrado = NULL, invalidada_en = ? WHERE usuario_id = ? AND archivo_id = ? AND estado = 'valida'",
    [motivo, ahora(), usuario().id, archivoId]);
  if (r.affectedRows) await evento('invalidacion', ctx, { archivoId, motivo });
  return r.affectedRows;
}

async function limpiarVencidas() {
  const r = await q('DELETE FROM extracciones WHERE usuario_id = ? AND vence_en < ?', [usuario().id, ahora()]);
  if (r.affectedRows) await evento('vencida', { origen: 'limpieza' }, { motivo: `${r.affectedRows} vencidas` });
  return r.affectedRows;
}

async function borrarTodo({ motivo = 'borrado_voluntario' } = {}) {
  const antes = await q("SELECT archivo_id, nombre, version FROM extracciones WHERE usuario_id = ? AND estado = 'valida'", [usuario().id]);
  const r = await q('DELETE FROM extracciones WHERE usuario_id = ?', [usuario().id]);
  for (const f of antes) await evento('borrado', { origen: 'ajustes' }, { archivoId: f.archivo_id, nombre: f.nombre, version: f.version, motivo });
  if (!antes.length) await evento('borrado', { origen: 'ajustes' }, { motivo: `${motivo} (nada guardado)` });
  return { borradas: antes.length, registros_eliminados: r.affectedRows };
}

async function borrarArchivo(archivoId) {
  const [f] = await q("SELECT nombre FROM extracciones WHERE usuario_id = ? AND archivo_id = ? ORDER BY id DESC LIMIT 1", [usuario().id, String(archivoId)]);
  const r = await q('DELETE FROM extracciones WHERE usuario_id = ? AND archivo_id = ?', [usuario().id, String(archivoId)]);
  await evento('borrado', { origen: 'ajustes' }, { archivoId, nombre: f && f.nombre, motivo: 'borrado_voluntario' });
  return { borradas: r.affectedRows };
}

// ---------- Núcleo ----------

// Busca una extracción válida de esta versión. Devuelve el contenido descifrado o null.
async function buscarValida(archivoId, version, tq = q) {
  const [f] = await tq("SELECT id, version, texto_cifrado, vence_en, caracteres, extraido_en FROM extracciones WHERE usuario_id = ? AND archivo_id = ? AND estado = 'valida' ORDER BY id DESC LIMIT 1",
    [usuario().id, archivoId]);
  if (!f) return { fila: null };
  if (f.version !== version) return { fila: f, otraVersion: true };
  if (new Date(f.vence_en) <= ahora()) return { fila: f, vencida: true };
  try {
    return { fila: f, contenido: JSON.parse(Cifrado.descifrar(f.texto_cifrado)) };
  } catch (e) {
    return { fila: f, ilegible: true };
  }
}

// Obtiene el contenido de un archivo: lo guardado si sigue valiendo, o lo extrae una vez.
// drive = { metadatos(id) → meta, extraer(meta, ctx) → contenido }  (contenido: { tipo:'texto', texto } | { tipo:'hoja', ... })
async function obtener(archivoId, drive, ctx = {}) {
  archivoId = String(archivoId);
  const t0 = Date.now();
  // 1. Acceso y versión, siempre en Drive (consulta liviana, sin descargar).
  let meta;
  try {
    meta = await conReintento(async () => {
      await evento('consulta_metadatos', ctx, { archivoId });
      return drive.metadatos(archivoId);
    }, ctx, { archivoId }, 'metadatos');
  } catch (e) {
    if (esSinAcceso(e)) {
      await evento('sin_acceso', ctx, { archivoId, motivo: `drive_${e.status || 'sin_permiso'}` });
      await invalidarArchivo(archivoId, 'sin_acceso', ctx);
      throw err('Este archivo ya no existe o ya no tienes acceso a él en Drive. Si tenía algo guardado de él, lo descarté.', { sinAcceso: true });
    }
    if (esTemporal(e)) {
      await evento('verificacion_fallida', ctx, { archivoId, motivo: String(e.status || 'red') });
      throw err('No pude comprobar en Drive que sigues teniendo acceso a este archivo (falla temporal de Google). Por seguridad no muestro lo guardado hasta confirmarlo: intenta de nuevo en un momento.', { temporal: true });
    }
    throw e;
  }
  if (meta.trashed) {
    await evento('sin_acceso', ctx, { archivoId, nombre: meta.name, motivo: 'en_papelera' });
    await invalidarArchivo(archivoId, 'en_papelera', ctx);
    throw err('Este archivo está en la papelera de Drive. Si tenía algo guardado de él, lo descarté.', { sinAcceso: true });
  }
  const version = claveVersion(meta);
  if (drive.leible && !drive.leible(meta)) return { meta, version, noLeible: true };
  // Durante la prueba (ADA_EXTRACCIONES=prueba) solo se lee contenido de la carpeta de prueba: lo de fuera se
  // rechaza aquí, en el servidor, antes de descargar, convertir o reutilizar nada (también lo guardado antes).
  const autorizado = drive.autorizado ? await drive.autorizado(meta) : enCarpetaDePrueba(meta);
  if (modo() === 'prueba' && usuario().id === 1 && !autorizado) {
    await evento('bloqueado_prueba', ctx, { archivoId, version, nombre: meta.name });
    throw err('Archivo fuera de la carpeta autorizada para la prueba: no lo abrí. Durante la prueba de guardado (Fase 3b) solo puedo abrir el contenido de archivos de la carpeta de prueba; se vuelve a la normalidad al terminar la prueba.', { bloqueado: true, status: 403 });
  }
  const guardar = (modo() !== 'prueba' || autorizado) ? await puedeGuardar() : { ok: false, motivo: 'fuera_de_prueba' };

  // 2. Reutilizar si hay una extracción válida de esta misma versión.
  let motivoNueva = 'primera';
  if (guardar.ok) {
    const b = await buscarValida(archivoId, version);
    if (b.contenido) {
      await q('UPDATE extracciones SET usos = usos + 1, ultimo_acceso = ? WHERE id = ?', [ahora(), b.fila.id]);
      await evento('reutilizacion', ctx, { archivoId, version, caracteres: b.fila.caracteres, duracionMs: Date.now() - t0 });
      return { meta, version, contenido: b.contenido, fuente: 'guardado', extraido_en: b.fila.extraido_en };
    }
    if (b.otraVersion) { await invalidarArchivo(archivoId, 'version_nueva', ctx); motivoNueva = 'version_nueva'; }
    else if (b.vencida) { await q('DELETE FROM extracciones WHERE id = ?', [b.fila.id]); await evento('vencida', ctx, { archivoId, version }); motivoNueva = 'vencida'; }
    else if (b.ilegible) { await invalidarArchivo(archivoId, 'clave_distinta', ctx); motivoNueva = 'clave_distinta'; }
  } else {
    motivoNueva = guardar.motivo;
  }

  // 3. Extraer una sola vez (pedidos simultáneos esperan la misma descarga).
  const clave = `${usuario().id}:${archivoId}:${version}`;
  if (enVuelo.has(clave)) {
    const r = await enVuelo.get(clave);
    await evento('reutilizacion', ctx, { archivoId, version, motivo: 'simultanea', caracteres: r.caracteres, duracionMs: Date.now() - t0 });
    return { meta, version, contenido: r.contenido, fuente: 'simultanea', extraido_en: r.extraido_en };
  }
  const trabajo = (async () => turnoDeExtraccion(async () => {
    const extraerYa = async (tq) => {
      if (tq && guardar.ok) {
        // Otro proceso pudo terminarla mientras esperábamos el bloqueo.
        const b = await buscarValida(archivoId, version, tq);
        if (b.contenido) return { contenido: b.contenido, caracteres: b.fila.caracteres, extraido_en: b.fila.extraido_en, deOtroProceso: true };
      }
      if (guardar.ok) {
        const [ya] = await (tq || q)("SELECT COUNT(*) AS n FROM extracciones WHERE usuario_id = ? AND archivo_id = ? AND version = ? AND estado = 'valida' AND vence_en > ?",
          [usuario().id, archivoId, version, ahora()]);
        if (ya && ya.n > 0) await evento('redundante', ctx, { archivoId, version, motivo: 'habia_extraccion_valida' });
      }
      const tD = Date.now();
      const contenido = await conReintento(async () => {
        await evento('descarga', ctx, { archivoId, version });
        return drive.extraer(meta, ctx);
      }, ctx, { archivoId, version }, 'descarga');
      const plano = JSON.stringify(contenido);
      const caracteres = contenido.tipo === 'texto' ? contenido.texto.length : plano.length;
      const extraido_en = ahora();
      if (guardar.ok) {
        const vence = new Date(extraido_en.getTime() + RETENCION_DIAS() * 86400e3);
        await (tq || q)(`INSERT INTO extracciones (usuario_id, archivo_id, version, md5, nombre, mime, caracteres, texto_cifrado, estado, extraido_en, vence_en, ultimo_acceso, usos)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'valida', ?, ?, ?, 0)
            ON DUPLICATE KEY UPDATE texto_cifrado = VALUES(texto_cifrado), estado = 'valida', motivo = NULL, invalidada_en = NULL, caracteres = VALUES(caracteres),
              extraido_en = VALUES(extraido_en), vence_en = VALUES(vence_en), ultimo_acceso = VALUES(ultimo_acceso), nombre = VALUES(nombre)`,
        [usuario().id, archivoId, version, meta.md5Checksum || null, String(meta.name || '').slice(0, 250), String(meta.mimeType || '').slice(0, 120), caracteres,
          Cifrado.cifrar(plano), extraido_en, vence, extraido_en]);
        await evento('extraccion_nueva', ctx, { archivoId, version, motivo: motivoNueva, caracteres, duracionMs: Date.now() - tD });
      } else {
        await evento('extraccion_sin_guardar', ctx, { archivoId, version, motivo: motivoNueva, caracteres, duracionMs: Date.now() - tD });
      }
      return { contenido, caracteres, extraido_en };
    };
    if (!guardar.ok) return extraerYa(null);
    const nombreBloqueo = `ada_ext_${crypto.createHash('sha1').update(clave).digest('hex').slice(0, 40)}`;
    return conBloqueo(nombreBloqueo, extraerYa);
  }))();
  enVuelo.set(clave, trabajo);
  try {
    const r = await trabajo;
    if (r.deOtroProceso) {
      await evento('reutilizacion', ctx, { archivoId, version, motivo: 'otro_proceso', caracteres: r.caracteres, duracionMs: Date.now() - t0 });
      return { meta, version, contenido: r.contenido, fuente: 'guardado', extraido_en: r.extraido_en };
    }
    return { meta, version, contenido: r.contenido, fuente: guardar.ok ? 'drive_guardado' : 'drive_sin_guardar', extraido_en: r.extraido_en, motivo: motivoNueva, sinGuardar: !guardar.ok ? guardar.motivo : null };
  } finally {
    enVuelo.delete(clave);
  }
}

// ---------- Consultas para Ajustes, métricas y la conversación ----------

async function resumen() {
  const c = await consentimiento();
  const [r] = await q("SELECT COUNT(*) AS n, COALESCE(SUM(caracteres),0) AS caracteres, MIN(vence_en) AS proximo_vencimiento FROM extracciones WHERE usuario_id = ? AND estado = 'valida' AND vence_en > ?",
    [usuario().id, ahora()]);
  const carpeta = process.env.ADA_DRIVE_CARPETA_PRUEBA || '';
  const pendientes = await qPrincipal("SELECT COUNT(*) AS n FROM temporales_drive WHERE usuario_id = ? AND estado = 'pendiente'", [usuario().id]).catch(() => [{ n: 0 }]);
  return {
    habilitado: habilitado(), modo: modo(), carpeta_prueba_configurada: !!carpeta, carpeta_prueba_termina_en: carpeta ? carpeta.slice(-6) : null, clave: Cifrado.disponible(), consentimiento: c, texto_consentimiento: TEXTO_CONSENTIMIENTO, retencion_dias: RETENCION_DIAS(),
    documentos: r.n, caracteres: Number(r.caracteres), proximo_vencimiento: r.proximo_vencimiento, temporales_pendientes: pendientes[0].n,
  };
}

// Estado seguro para la conversación y Ajustes: sin claves, sin variables, sin contenido.
async function estadoPublico() {
  const u = usuario();
  if (u.id !== 1) return { disponible: false, motivo: 'Guardar documentos está disponible solo para la cuenta principal en esta etapa.' };
  const c = await consentimiento();
  const carpeta = process.env.ADA_DRIVE_CARPETA_PRUEBA || '';
  const [r] = await q("SELECT COUNT(*) AS n FROM extracciones WHERE usuario_id = ? AND estado = 'valida' AND vence_en > ?", [u.id, ahora()]);
  const m = modo();
  const listo = m !== 'no' && Cifrado.disponible() && (m !== 'prueba' || !!carpeta);
  return {
    modo: m,
    descripcion_modo: m === 'no' ? 'apagado: se lee sin guardar nada' : m === 'prueba' ? 'prueba: solo se puede abrir y guardar el contenido de la carpeta de prueba; lo de fuera está bloqueado hasta terminar la prueba' : 'encendido: se guarda lo que se lee',
    cifrado_listo: Cifrado.disponible(),
    carpeta_prueba_configurada: !!carpeta,
    carpeta_prueba_termina_en: carpeta ? carpeta.slice(-6) : null,
    consentimiento: c.estado,
    documentos_guardados: r.n,
    retencion_dias: RETENCION_DIAS(),
    puede_guardar: listo && c.estado === 'aceptado',
    siguiente_paso: !listo ? 'El guardado no está listo en el servidor: lee igual, sin guardar.'
      : c.estado === 'aceptado' ? 'Listo: lo que leas (dentro del alcance) se guarda cifrado y se reutiliza.'
        : c.estado === 'rechazado' ? 'Cristian eligió no guardar: lee igual, sin guardar.'
          : 'Al leer el primer documento dentro del alcance, la app le mostrará la tarjeta de consentimiento.',
  };
}

const enCarpetaDePrueba = (meta) => !!process.env.ADA_DRIVE_CARPETA_PRUEBA && (meta.parents || []).includes(process.env.ADA_DRIVE_CARPETA_PRUEBA);

async function listar() {
  return q("SELECT archivo_id, nombre, version, caracteres, extraido_en, vence_en, usos, ultimo_acceso FROM extracciones WHERE usuario_id = ? AND estado = 'valida' AND vence_en > ? ORDER BY ultimo_acceso DESC LIMIT 200",
    [usuario().id, ahora()]);
}

// Métricas de un período, una conversación, un turno o un trabajo. Sin contenido.
async function metricas({ desde, hasta, conversacionId, turnoId, trabajoId } = {}) {
  const cond = ['usuario_id = ?'];
  const p = [usuario().id];
  if (desde) { cond.push('creado_en >= ?'); p.push(new Date(desde)); }
  if (hasta) { cond.push('creado_en <= ?'); p.push(new Date(hasta)); }
  if (conversacionId) { cond.push('conversacion_id = ?'); p.push(conversacionId); }
  if (turnoId) { cond.push('turno_id = ?'); p.push(turnoId); }
  if (trabajoId) { cond.push('trabajo_id = ?'); p.push(trabajoId); }
  const w = cond.join(' AND ');
  const filas = await qPrincipal(`SELECT tipo, motivo, COUNT(*) AS n FROM extraccion_eventos WHERE ${w} GROUP BY tipo, motivo`, p);
  const cuenta = (tipo, filtro) => filas.filter((f) => f.tipo === tipo && (!filtro || filtro(f.motivo))).reduce((a, f) => a + f.n, 0);
  const [u] = await qPrincipal(`SELECT COUNT(DISTINCT archivo_id) AS n FROM extraccion_eventos WHERE ${w} AND tipo = 'consulta_metadatos'`, p);
  const porMotivo = (tipo) => Object.fromEntries(filas.filter((f) => f.tipo === tipo).map((f) => [f.motivo || 'sin_motivo', f.n]));
  // Costo por paso de IA (se usará de lleno en la Fase 3c).
  let costoPorPaso = [];
  if (trabajoId || turnoId || conversacionId) {
    const c2 = ['usuario_id = ?']; const p2 = [usuario().id];
    if (trabajoId) { c2.push('trabajo_id = ?'); p2.push(trabajoId); }
    if (turnoId) { c2.push('turno_id = ?'); p2.push(turnoId); }
    if (conversacionId) { c2.push('conversacion_id = ?'); p2.push(conversacionId); }
    costoPorPaso = (await qPrincipal(`SELECT COALESCE(paso_id, CONCAT(turno_id, '#', paso)) AS paso, modelo, COUNT(*) AS llamadas, SUM(input_tokens) AS entrada, SUM(output_tokens) AS salida,
        SUM(cache_lectura) AS cache_lectura, SUM(costo_usd) AS costo_usd FROM llamadas_ia WHERE ${c2.join(' AND ')} GROUP BY 1, 2 ORDER BY MIN(creado_en)`, p2))
      .map((x) => ({ ...x, costo_usd: Number(x.costo_usd) }));
  }
  // Intentos de escritura en Drive (de operaciones_herramienta: solo nombre de herramienta, resultado y error).
  const ESCRITURAS = ['editar_hoja_drive', 'editar_documento_drive', 'mover_drive', 'renombrar_drive', 'papelera_drive', 'crear_carpeta_drive', 'crear_archivo'];
  const c3 = ['usuario_id = ?', `herramienta IN (${ESCRITURAS.map(() => '?').join(',')})`]; const p3 = [usuario().id, ...ESCRITURAS];
  if (desde) { c3.push('creado_en >= ?'); p3.push(new Date(desde)); }
  if (hasta) { c3.push('creado_en <= ?'); p3.push(new Date(hasta)); }
  if (conversacionId) { c3.push('conversacion_id = ?'); p3.push(conversacionId); }
  if (turnoId) { c3.push('turno_id = ?'); p3.push(turnoId); }
  const [esc] = await qPrincipal(`SELECT COUNT(*) AS intentos, COALESCE(SUM(ok = 1 AND repetida = 0 AND (error IS NULL OR error = '')),0) AS hechas FROM operaciones_herramienta WHERE ${c3.join(' AND ')}`, p3).catch(() => [{ intentos: 0, hechas: 0 }]);
  return {
    escrituras_drive_intentadas: Number(esc.intentos),
    escrituras_drive_sin_error: Number(esc.hechas),
    documentos_unicos: u.n,
    consultas_metadatos: cuenta('consulta_metadatos'),
    descargas: cuenta('descarga'),
    extracciones_nuevas: cuenta('extraccion_nueva'),
    extracciones_nuevas_por_motivo: porMotivo('extraccion_nueva'),
    lecturas_sin_guardar: cuenta('extraccion_sin_guardar'),
    reutilizaciones: cuenta('reutilizacion'),
    reutilizaciones_simultaneas: cuenta('reutilizacion', (m) => m === 'simultanea' || m === 'otro_proceso'),
    reintentos_justificados: cuenta('reintento'),
    reintentos_por_motivo: porMotivo('reintento'),
    operaciones_redundantes: cuenta('redundante'),
    invalidaciones: porMotivo('invalidacion'),
    sin_acceso: cuenta('sin_acceso'),
    verificaciones_fallidas: cuenta('verificacion_fallida'),
    temporales_borrados: cuenta('temporal_borrado'),
    temporales_fallidos: cuenta('temporal_fallido'),
    bloqueados_fuera_de_prueba: cuenta('bloqueado_prueba'),
    escrituras_bloqueadas: cuenta('escritura_bloqueada'),
    costo_por_paso_ia: costoPorPaso,
  };
}

// Detalle de eventos recientes (para Ajustes y diagnóstico): solo hora, tipo, archivo y motivo.
async function eventos({ desde, limite = 60 } = {}) {
  const p = [usuario().id];
  let w = 'usuario_id = ?';
  if (desde) { w += ' AND creado_en >= ?'; p.push(new Date(desde)); }
  const ext = await qPrincipal(`SELECT creado_en, tipo, archivo_id, nombre, motivo, origen FROM extraccion_eventos WHERE ${w} AND tipo <> 'lectura_tramo' ORDER BY id DESC LIMIT ${Math.min(200, parseInt(limite, 10) || 60)}`, p);
  const ops = await qPrincipal(`SELECT creado_en, herramienta, ok, error FROM operaciones_herramienta WHERE ${w} AND herramienta IN ('editar_hoja_drive','editar_documento_drive','mover_drive','renombrar_drive','papelera_drive','crear_carpeta_drive','crear_archivo') ORDER BY id DESC LIMIT 30`, p).catch(() => []);
  return {
    extracciones: ext.map((e) => ({ hora: e.creado_en, evento: e.tipo, archivo: e.nombre || (e.archivo_id ? `…${String(e.archivo_id).slice(-6)}` : null), motivo: e.motivo, origen: e.origen })),
    escrituras_drive: ops.map((o) => ({ hora: o.creado_en, herramienta: o.herramienta, ok: !!o.ok && !o.error, error: o.error ? String(o.error).slice(0, 120) : null })),
  };
}

// Informe de verificación (cierre de la Fase 3b): por archivo, la secuencia de eventos con hora, versión,
// instancia del servidor (para probar reinicios) y su estado actual. Sin contenido.
async function verificacion({ desde } = {}) {
  const u = usuario().id;
  const ini = desde ? new Date(desde) : new Date(Date.now() - 24 * 3600e3);
  const ev = await qPrincipal(`SELECT id, creado_en, tipo, motivo, archivo_id, nombre, version, origen, conversacion_id, instancia FROM extraccion_eventos
    WHERE usuario_id = ? AND creado_en >= ? AND tipo <> 'lectura_tramo' ORDER BY id`, [u, ini]);
  const corta = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 8) : null);
  const instancias = [...new Set(ev.map((e) => e.instancia).filter(Boolean))];
  const nInst = (i) => (i ? instancias.indexOf(i) + 1 : null);
  const archivos = new Map();
  for (const e of ev) {
    if (!e.archivo_id) continue;
    const a = archivos.get(e.archivo_id) || { archivo: e.nombre || `…${e.archivo_id.slice(-6)}`, id_termina_en: e.archivo_id.slice(-6), conteo: {}, secuencia: [] };
    if (e.nombre) a.archivo = e.nombre;
    const k = e.motivo && !['consulta_metadatos', 'descarga', 'reutilizacion'].includes(e.tipo) ? `${e.tipo}:${e.motivo}` : e.tipo;
    a.conteo[k] = (a.conteo[k] || 0) + 1;
    a.secuencia.push({ hora: e.creado_en, evento: e.tipo, motivo: e.motivo || undefined, version: corta(e.version) || undefined, servidor: nInst(e.instancia), conversacion: e.conversacion_id || undefined });
    archivos.set(e.archivo_id, a);
  }
  const ids = [...archivos.keys()];
  const filas = ids.length ? await q(`SELECT archivo_id, version, estado, motivo, extraido_en, vence_en, usos, ultimo_acceso, caracteres, (texto_cifrado IS NOT NULL) AS con_texto,
      (texto_cifrado LIKE 'v1:%') AS cifrado FROM extracciones WHERE usuario_id = ? AND archivo_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, [u, ...ids]) : [];
  for (const f of filas) {
    const a = archivos.get(f.archivo_id);
    (a.estado_actual = a.estado_actual || []).push({ version: corta(f.version), estado: f.estado, motivo: f.motivo || undefined, con_texto: !!f.con_texto, cifrado: !!f.cifrado,
      extraido_en: f.extraido_en, vence_en: f.vence_en, usos: f.usos, caracteres: f.caracteres });
  }
  for (const a of archivos.values()) if (!a.estado_actual) a.estado_actual = 'sin extracción guardada';
  const temporales = await qPrincipal('SELECT estado, COUNT(*) AS n FROM temporales_drive WHERE usuario_id = ? GROUP BY estado', [u]).catch(() => []);
  const borradosGenerales = ev.filter((e) => e.tipo === 'borrado' && !e.archivo_id).map((e) => ({ hora: e.creado_en, motivo: e.motivo }));
  return {
    generado_en: new Date(), desde: ini, modo: modo(), carpeta_prueba_termina_en: (process.env.ADA_DRIVE_CARPETA_PRUEBA || '').slice(-6) || null,
    servidores: instancias.length, nota_servidores: 'Cada número de "servidor" es una instancia distinta de ADA (un reinicio o despliegue crea una nueva).',
    nota_version: 'La versión se muestra como huella de 8 caracteres: si cambia, cambió el archivo en Drive.',
    archivos: [...archivos.values()],
    copias_temporales: { borradas: ev.filter((e) => e.tipo === 'temporal_borrado').length, fallidas: ev.filter((e) => e.tipo === 'temporal_fallido').length,
      pendientes_ahora: Number((temporales.find((t) => t.estado === 'pendiente') || { n: 0 }).n) },
    borrados_sin_archivo: borradosGenerales,
  };
}

// ---------- Cierre de la Fase 3b: las 5 verificaciones con un archivo de prueba ----------
// Se evalúan con los eventos registrados (sin contenido) y el estado actual de lo guardado. No ejecuta nada.
async function cierre({ archivoId, desde, copiasVivas = null }) {
  const u = usuario().id;
  if (!archivoId) throw Object.assign(new Error('Indica el id del archivo de prueba'), { status: 400 });
  const ini = desde ? new Date(desde) : new Date(Date.now() - 7 * 864e5);
  const ev = await qPrincipal(`SELECT id, creado_en, tipo, motivo, version, instancia, nombre FROM extraccion_eventos WHERE usuario_id = ? AND archivo_id = ? AND creado_en >= ? AND tipo <> 'lectura_tramo' ORDER BY id`, [u, String(archivoId), ini]);
  const filas = await q('SELECT version, estado, motivo, (texto_cifrado IS NOT NULL) AS con_texto, (texto_cifrado LIKE \'v1:%\') AS cifrado, extraido_en, vence_en FROM extracciones WHERE usuario_id = ? AND archivo_id = ? ORDER BY id', [u, String(archivoId)]);
  const temporales = await qPrincipal("SELECT COUNT(*) AS n FROM temporales_drive WHERE usuario_id = ? AND original_id = ? AND estado = 'pendiente'", [u, String(archivoId)]).catch(() => [{ n: 0 }]);
  const corta = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 8) : null);
  const inst = [...new Set(ev.map((e) => e.instancia).filter(Boolean))];
  const nInst = (i) => (i ? inst.indexOf(i) + 1 : null);
  const linea = (e) => `${new Date(e.creado_en).toISOString().slice(0, 19)} · ${e.tipo}${e.motivo ? `:${e.motivo}` : ''}${e.version ? ` · v${corta(e.version)}` : ''} · servidor ${nInst(e.instancia)}`;
  const res = [];
  const v = (n, nombre, ok, evidencia, falta) => res.push({ n, verificacion: nombre, estado: ok ? 'aprobada' : 'pendiente', evidencia, ...(ok ? {} : { como_completarla: falta }) });

  // 1. Persistencia tras un reinicio real: guardada en un servidor y reutilizada (sin descargar) en otro.
  const guardadas = ev.filter((e) => e.tipo === 'extraccion_nueva');
  let r1 = null;
  for (const g of guardadas) {
    const reuso = ev.find((e) => e.id > g.id && e.tipo === 'reutilizacion' && e.version === g.version && e.instancia && e.instancia !== g.instancia);
    if (reuso && !ev.some((e) => e.id > g.id && e.id < reuso.id && e.tipo === 'descarga' && e.instancia === reuso.instancia)) { r1 = [g, reuso]; break; }
  }
  v(1, 'Persistencia y reutilización después de un reinicio real de Railway', !!r1, r1 ? r1.map(linea) : [`servidores vistos: ${inst.length}`],
    'Lee el archivo (botón "Leer ahora"), reinicia el servicio en Railway (Restart) y vuelve a leerlo: debe reutilizarse en el servidor nuevo sin descargarse.');

  // 2. Versión nueva del mismo archivo (mismo id): se invalida lo guardado y se extrae de nuevo.
  const inv = ev.find((e) => e.tipo === 'invalidacion' && e.motivo === 'version_nueva');
  const nueva = inv && ev.find((e) => e.id > inv.id && e.tipo === 'extraccion_nueva' && e.motivo === 'version_nueva');
  const anterior = inv && [...ev].reverse().find((e) => e.id < inv.id && e.version);
  const ok2 = !!(inv && nueva && anterior && nueva.version !== anterior.version);
  v(2, 'Invalidación y nueva extracción con una versión nueva del mismo archivo', ok2, ok2 ? [linea(anterior), linea(inv), linea(nueva)] : [],
    'En Drive, sobre el mismo archivo: Administrar versiones → Subir una versión nueva (con algún cambio). Luego "Leer ahora": debe invalidar lo guardado y extraer la versión nueva.');

  // 3. Pérdida de acceso: en la papelera (o sin permiso) se descarta lo guardado y no se muestra nada.
  const perdida = ev.find((e) => e.tipo === 'sin_acceso');
  const invAcceso = perdida && ev.find((e) => e.tipo === 'invalidacion' && ['en_papelera', 'sin_acceso'].includes(e.motivo) && Math.abs(new Date(e.creado_en) - new Date(perdida.creado_en)) < 60000);
  const reusoDespues = perdida && ev.find((e) => e.id > perdida.id && e.tipo === 'reutilizacion' && !ev.some((x) => x.id > perdida.id && x.id < e.id && x.tipo === 'extraccion_nueva'));
  const sinTexto = !filas.some((f) => f.estado === 'valida' && f.con_texto) || ev.some((e) => perdida && e.id > perdida.id && e.tipo === 'extraccion_nueva');
  const ok3 = !!(perdida && (invAcceso || !filas.some((f) => f.estado === 'valida')) && !reusoDespues && sinTexto);
  v(3, 'Bloqueo de lo guardado al perder el acceso (papelera)', ok3, perdida ? [linea(perdida), ...(invAcceso ? [linea(invAcceso)] : []), `guardado con texto ahora: ${filas.some((f) => f.estado === 'valida' && f.con_texto) ? 'sí' : 'no'}`] : [],
    'Al final: envía el archivo a la papelera de Drive y toca "Leer ahora". Debe responder que no hay acceso y descartar lo guardado.');

  // 4. Copias temporales: cada conversión (PDF/Word) borra su copia; ninguna pendiente ni viva en Drive.
  const borradas = ev.filter((e) => e.tipo === 'temporal_borrado').length;
  const fallidas = ev.filter((e) => e.tipo === 'temporal_fallido').length;
  const pendientes = Number(temporales[0].n);
  const ok4 = borradas > 0 && pendientes === 0 && (copiasVivas === null || copiasVivas === 0);
  v(4, 'Confirmación de que se borran las copias temporales', ok4, [`copias borradas: ${borradas}`, `fallidas: ${fallidas}`, `pendientes de borrar: ${pendientes}`, `copias "ADA temporal" vivas en tu Drive: ${copiasVivas === null ? 'no consultado' : copiasVivas}`],
    'Usa un PDF o Word (se convierte con una copia temporal) y léelo al menos una vez; la copia debe borrarse y no quedar ninguna viva en Drive.');

  // 5. Borrado voluntario: se borra lo guardado y la siguiente lectura vuelve a descargar.
  const borr = ev.find((e) => e.tipo === 'borrado' && e.motivo === 'borrado_voluntario');
  const desc = borr && ev.find((e) => e.id > borr.id && e.tipo === 'descarga');
  const reuso5 = borr && ev.find((e) => e.id > borr.id && (!desc || e.id < desc.id) && e.tipo === 'reutilizacion');
  const ok5 = !!(borr && desc && !reuso5);
  v(5, 'Borrado voluntario de la extracción cifrada', ok5, ok5 ? [linea(borr), linea(desc)] : (borr ? [linea(borr), 'falta una lectura posterior'] : []),
    'En esta misma sección, "Borrar solo lo guardado de este archivo" y luego "Leer ahora": debe descargarlo de nuevo (no reutilizar).');

  return {
    generado_en: new Date(), archivo: (ev.find((e) => e.nombre) || {}).nombre || `…${String(archivoId).slice(-6)}`, archivo_id_termina_en: String(archivoId).slice(-6), desde: ini,
    modo: modo(), resultado: res.every((x) => x.estado === 'aprobada') ? 'LAS 5 APROBADAS' : `${res.filter((x) => x.estado === 'aprobada').length} de 5 aprobadas`,
    verificaciones: res, servidores_vistos: inst.length,
    guardado_ahora: filas.map((f) => ({ version: corta(f.version), estado: f.estado, motivo: f.motivo || undefined, con_texto: !!f.con_texto, cifrado: !!f.cifrado, vence_en: f.vence_en })),
    secuencia: ev.map(linea),
    nota: 'Solo metadatos y eventos: ningún contenido del documento. Las versiones se muestran como huella de 8 caracteres.',
  };
}

// Para la conversación: documentos ya leídos en una conversación (solo metadatos: id, versión y hasta dónde).
async function leidosEnConversacion(conversacionId) {
  if (!conversacionId) return [];
  return qPrincipal(`SELECT archivo_id, MAX(version) AS version, MAX(hasta) AS hasta, MAX(caracteres) AS total, MAX(nombre) AS nombre FROM extraccion_eventos
    WHERE usuario_id = ? AND conversacion_id = ? AND tipo = 'lectura_tramo' GROUP BY archivo_id ORDER BY MIN(id) LIMIT 80`,
  [usuario().id, conversacionId]).catch(() => []);
}

module.exports = {
  obtener, eventos, verificacion, cierre, estadoPublico, enCarpetaDePrueba, modo, consentimiento, responderConsentimiento, puedeGuardar, resumen, listar, metricas, borrarTodo, borrarArchivo, limpiarVencidas,
  invalidarArchivo, evento, claveVersion, leidosEnConversacion, habilitado, TEXTO_CONSENTIMIENTO, esTemporal, esSinAcceso,
};
