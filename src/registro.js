// Registro operativo de ADA: cada llamada a Claude y cada herramienta, con identificadores únicos
// (persona, conversación, turno, encargo, paso). SOLO metadatos: nunca mensajes, contenido de
// documentos, claves ni contraseñas. Sirve para saber cuánto costó cada encargo y frenar a tiempo.
const crypto = require('crypto');
const { qPrincipal, usuario } = require('./db');
const { costoUSD } = require('./claude');

const COSTO_BUSQUEDA = 0.01;
const nuevoId = () => crypto.randomUUID();
const corto = (t, n) => (t == null ? null : String(t).replace(/\s+/g, ' ').slice(0, n));

// Qué se tocó, sin contenido: ids, nombres de archivo, consultas de búsqueda (recortadas).
const CLAVES_OBJETIVO = ['id', 'archivo_id', 'carpeta_id', 'nombre', 'texto', 'consulta', 'titulo', 'desde', 'encargo_id', 'contacto', 'persona'];
function objetivo(nombre, input = {}, r = {}) {
  if (['proponer_mensaje', 'guardar_borrador_correo', 'entregar_documento', 'editar_documento_drive', 'editar_hoja_drive', 'crear_archivo'].includes(nombre)) {
    // Herramientas que llevan contenido redactado: solo el título o destinatario.
    return corto([input.titulo, input.contacto, input.canal, r && r.nombre].filter(Boolean).join(' · '), 240);
  }
  const partes = [];
  for (const k of CLAVES_OBJETIVO) if (input[k] !== undefined && typeof input[k] !== 'object') partes.push(`${k}=${corto(input[k], 80)}`);
  if (r && typeof r === 'object' && r.nombre && !partes.some((x) => x.startsWith('nombre='))) partes.push(`archivo=${corto(r.nombre, 80)}`);
  return corto(partes.join(' · '), 240);
}

function encargoDe(nombre, input = {}, r = {}) {
  if (Number.isInteger(input.encargo_id)) return input.encargo_id;
  if (/_encargo$/.test(nombre) && Number.isInteger(input.id)) return input.id;
  if (nombre === 'crear_encargo' && r && r.encargo && Number.isInteger(r.encargo.id)) return r.encargo.id;
  return null;
}

async function llamada(d) {
  const u = usuario();
  const id = nuevoId();
  const usage = d.usage || {};
  const busquedas = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  const costo = costoUSD(d.modelo, usage) + busquedas * COSTO_BUSQUEDA;
  try {
    await qPrincipal(
      `INSERT INTO llamadas_ia (id, usuario_id, conversacion_id, turno_id, encargo_id, paso, modelo, input_tokens, output_tokens,
        cache_creacion, cache_lectura, busquedas, costo_usd, duracion_ms, stop_reason, herramientas, request_id, error, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, u.id, d.conversacionId || null, d.turnoId, d.encargoId || null, d.paso, String(d.modelo).slice(0, 80),
        usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_creation_input_tokens || 0, usage.cache_read_input_tokens || 0,
        busquedas, costo, d.duracionMs || null, d.stopReason || null, corto(d.herramientas, 400), corto(d.requestId, 120),
        corto(d.error, 300), new Date()]
    );
  } catch (e) {
    console.error('Registro llamada:', e.message);
  }
  return { id, costo };
}

async function operacion(d) {
  const u = usuario();
  try {
    await qPrincipal(
      `INSERT INTO operaciones_herramienta (usuario_id, conversacion_id, turno_id, llamada_id, herramienta, objetivo, ok, error,
        tamano_resultado, repetida, duracion_ms, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.id, d.conversacionId || null, d.turnoId, d.llamadaId || null, String(d.herramienta).slice(0, 80),
        objetivo(d.herramienta, d.input, d.resultado), d.error ? 0 : 1, corto(d.error, 300),
        d.tamano || null, d.repetida ? 1 : 0, d.duracionMs || null, new Date()]
    );
  } catch (e) {
    console.error('Registro herramienta:', e.message);
  }
}

// ---------- Consultas (solo Cristian) ----------

async function porTurno({ desde, hasta, usuarioId } = {}) {
  const filas = await qPrincipal(
    `SELECT turno_id, usuario_id, conversacion_id, MAX(encargo_id) AS encargo_id, MIN(creado_en) AS inicio, MAX(creado_en) AS fin,
       COUNT(*) AS llamadas, GROUP_CONCAT(DISTINCT modelo) AS modelos, SUM(input_tokens) AS entrada, SUM(output_tokens) AS salida,
       SUM(cache_creacion) AS cache_creacion, SUM(cache_lectura) AS cache_lectura, SUM(busquedas) AS busquedas,
       SUM(costo_usd) AS costo_usd, SUM(duracion_ms) AS duracion_ms, MAX(error) AS error
     FROM llamadas_ia WHERE creado_en >= ? AND creado_en < ? ${usuarioId ? 'AND usuario_id = ?' : ''}
     GROUP BY turno_id, usuario_id, conversacion_id ORDER BY inicio DESC LIMIT 200`,
    [desde, hasta, ...(usuarioId ? [usuarioId] : [])]
  );
  return filas.map((f) => ({ ...f, costo_usd: Number(f.costo_usd) }));
}

async function detalleTurno(turnoId) {
  const [llamadas, herramientas] = await Promise.all([
    qPrincipal('SELECT * FROM llamadas_ia WHERE turno_id = ? ORDER BY paso, creado_en', [turnoId]),
    qPrincipal('SELECT herramienta, objetivo, ok, error, tamano_resultado, repetida, duracion_ms, creado_en FROM operaciones_herramienta WHERE turno_id = ? ORDER BY id', [turnoId]),
  ]);
  return { llamadas: llamadas.map((l) => ({ ...l, costo_usd: Number(l.costo_usd) })), herramientas };
}

async function porEncargo() {
  return qPrincipal(
    `SELECT usuario_id, encargo_id, COUNT(DISTINCT turno_id) AS turnos, COUNT(*) AS llamadas, SUM(costo_usd) AS costo_usd,
       MIN(creado_en) AS desde, MAX(creado_en) AS hasta
     FROM llamadas_ia WHERE encargo_id IS NOT NULL GROUP BY usuario_id, encargo_id ORDER BY hasta DESC LIMIT 100`
  );
}

module.exports = { nuevoId, llamada, operacion, porTurno, detalleTurno, porEncargo, objetivo, encargoDe };
