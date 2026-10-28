// Exportación privada del diagnóstico de una conversación (solo Cristian). Reconstruye la cronología
// con lo que quedó guardado: mensajes (solo hora y largo), herramientas usadas (nombre, sobre qué
// archivo o búsqueda, error, tamaño), lecturas repetidas, respuestas que faltan, entregables, gasto del
// día y, desde que existe, el registro por llamada. NO incluye el contenido de documentos, ni los
// mensajes (salvo un extracto opcional y anonimizado de lo que escribió la persona), ni claves.
const { q, qPrincipal } = require('./db');
const Registro = require('./registro');

// Quita datos personales y secretos de cualquier texto que salga en la exportación.
function anonimizar(t) {
  return String(t == null ? '' : t)
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[clave]')
    .replace(/(Bearer|Token)\s+[A-Za-z0-9._-]{10,}/gi, '$1 [clave]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo]')
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/g, '[rut]')
    .replace(/\+?56\s?9\s?\d{4}\s?\d{4}\b/g, '[teléfono]')
    .replace(/\b\d{7,}\b/g, '[número]');
}

function leerJSON(t) {
  try { return JSON.parse(t); } catch (_) { return null; }
}

// Nombres de archivo que aparecen en el resultado de una herramienta (sin su contenido).
function nombresDeArchivo(resultado) {
  const out = new Set();
  const re = /"(?:nombre|name|titulo)":"([^"]{1,140})"/g;
  let m;
  while ((m = re.exec(String(resultado || ''))) && out.size < 60) out.add(anonimizar(m[1]));
  return [...out];
}

function herramientasDe(revisado) {
  const lista = leerJSON(revisado) || [];
  return lista.map((h) => {
    const entrada = leerJSON(h.entrada) || {};
    const res = String(h.resultado || '');
    const resObj = leerJSON(res) || {};
    return {
      herramienta: h.herramienta,
      objetivo: anonimizar(Registro.objetivo(h.herramienta, entrada, resObj) || (typeof h.entrada === 'string' && !leerJSON(h.entrada) ? '(entrada recortada)' : '')),
      error: /"error"\s*:/.test(res) ? anonimizar((res.match(/"error"\s*:\s*"([^"]{0,160})/) || [])[1] || 'sí') : null,
      largo_resultado: res.length,
      resultado_recortado_al_guardar: res.length >= 3990,
      archivos_mencionados: h.herramienta === 'web_search' ? [] : nombresDeArchivo(res).slice(0, 12),
    };
  });
}

async function conversacionesDelDia(dia) {
  const desde = new Date(`${dia}T00:00:00`);
  const hasta = new Date(desde.getTime() + 24 * 3600 * 1000);
  return q(
    `SELECT c.id, c.titulo, c.inicio, c.fin, COUNT(m.id) AS mensajes
     FROM conversaciones c LEFT JOIN mensajes m ON m.conversacion_id = c.id
     WHERE (c.inicio < ? AND (c.fin IS NULL OR c.fin >= ?)) OR (m.creado_en >= ? AND m.creado_en < ?)
     GROUP BY c.id, c.titulo, c.inicio, c.fin ORDER BY c.inicio`,
    [hasta, desde, desde, hasta]
  );
}

async function exportar(conversacionId, { conTexto = false, usuarioId = 1 } = {}) {
  const [conv] = await q('SELECT id, titulo, inicio, fin FROM conversaciones WHERE id = ?', [conversacionId]);
  if (!conv) throw Object.assign(new Error('No existe esa conversación'), { status: 404 });
  const mensajes = await q('SELECT id, rol, contenido, revisado, creado_en FROM mensajes WHERE conversacion_id = ? ORDER BY id', [conversacionId]);
  const cronologia = [];
  const conteo = new Map();
  const repetidas = new Map();
  const archivos = new Set();
  mensajes.forEach((m, i) => {
    const siguiente = mensajes[i + 1];
    const fila = {
      n: i + 1,
      hora: m.creado_en,
      rol: m.rol === 'user' ? 'persona' : 'ADA',
      largo_caracteres: String(m.contenido || '').length,
    };
    if (m.rol === 'user') {
      if (conTexto) fila.extracto = anonimizar(String(m.contenido).replace(/\s+/g, ' ').slice(0, 160));
      // Mensaje sin respuesta guardada: la respuesta se cortó (reinicio, cierre, error) o nunca terminó.
      if (!siguiente || siguiente.rol === 'user') fila.sin_respuesta_guardada = true;
    } else {
      const hs = herramientasDe(m.revisado);
      fila.herramientas = hs;
      fila.cantidad_herramientas = hs.length;
      fila.posible_limite_de_pasos = hs.length >= 9;
      const previo = mensajes[i - 1];
      if (previo) fila.segundos_desde_el_mensaje = Math.round((new Date(m.creado_en) - new Date(previo.creado_en)) / 1000);
      for (const h of hs) {
        conteo.set(h.herramienta, (conteo.get(h.herramienta) || 0) + 1);
        const k = `${h.herramienta} | ${h.objetivo}`;
        repetidas.set(k, (repetidas.get(k) || 0) + 1);
        if (/^leer_|^ver_/.test(h.herramienta)) for (const a of h.archivos_mencionados.slice(0, 1)) archivos.add(a);
      }
      const p = String(m.contenido || '');
      if (/presupuesto|Detuve el trabajo|no alcancé a armarte|Se me fue la respuesta/.test(p)) fila.respuesta_de_aviso = (p.match(/(Paré aquí[^.]*\.|Detuve el trabajo[^.]*\.|no alcancé a armarte[^.]*\.|Se me fue la respuesta[^.]*\.)/) || [''])[0];
    }
    cronologia.push(fila);
  });

  const dia = new Date(conv.inicio);
  const inicioDia = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate());
  const finDia = new Date(inicioDia.getTime() + 24 * 3600 * 1000);
  const diaClave = `${inicioDia.getFullYear()}-${String(inicioDia.getMonth() + 1).padStart(2, '0')}-${String(inicioDia.getDate()).padStart(2, '0')}`;
  const [entregables, consumo, llamadas, turnos] = await Promise.all([
    q('SELECT id, titulo, creado_en, CHAR_LENGTH(contenido) AS largo FROM documentos WHERE conversacion_id = ? ORDER BY id', [conversacionId]),
    qPrincipal('SELECT modelo, turnos, busquedas, costo_usd FROM consumo WHERE usuario_id = ? AND dia = ?', [usuarioId, diaClave]),
    qPrincipal(`SELECT turno_id, paso, origen, modelo, input_tokens, output_tokens, cache_creacion, cache_lectura, busquedas, costo_usd,
        costo_estimado, duracion_ms, stop_reason, herramientas, error, creado_en FROM llamadas_ia
      WHERE usuario_id = ? AND conversacion_id = ? ORDER BY creado_en, paso`, [usuarioId, conversacionId]).catch(() => []),
    qPrincipal('SELECT turno_id, origen, estado, motivo, llamadas, costo_usd, inicio, fin FROM turnos_ia WHERE usuario_id = ? AND conversacion_id = ? ORDER BY inicio', [usuarioId, conversacionId]).catch(() => []),
  ]);
  const [{ antes_del_dia: llamadasDia }] = await qPrincipal('SELECT COUNT(*) AS antes_del_dia FROM llamadas_ia WHERE usuario_id = ? AND creado_en >= ? AND creado_en < ?', [usuarioId, inicioDia, finDia]).catch(() => [{ antes_del_dia: 0 }]);

  return {
    generado_en: new Date(),
    conversacion: { id: conv.id, titulo: anonimizar(conv.titulo || ''), inicio: conv.inicio, fin: conv.fin },
    advertencias: [
      'Los tokens por llamada solo existen desde que se activó el registro por llamada (27/10/2026, cerca de las 22:15). Antes, solo hay costo estimado agregado por día (consumo) y, en los logs de Railway, una línea por mensaje.',
      'La hora de cada herramienta no se guardaba: se conoce la hora del mensaje de ADA que las usó (al terminar ese mensaje).',
      'Los resultados de herramientas se guardaban recortados a 4.000 caracteres: los nombres de archivo listados pueden estar incompletos.',
      'Un mensaje de la persona "sin respuesta guardada" indica que la respuesta se cortó (reinicio del servidor, error o cierre) o que llegó otro mensaje antes.',
      llamadasDia ? null : 'No hay registro por llamada para ese día.',
    ].filter(Boolean),
    resumen: {
      mensajes: mensajes.length,
      mensajes_sin_respuesta_guardada: cronologia.filter((f) => f.sin_respuesta_guardada).length,
      herramientas_por_tipo: Object.fromEntries([...conteo.entries()].sort((a, b) => b[1] - a[1])),
      llamadas_repetidas: [...repetidas.entries()].filter(([, v]) => v > 1).map(([k, v]) => ({ operacion: k, veces: v })).sort((a, b) => b.veces - a.veces),
      documentos_abiertos: [...archivos],
      respuestas_con_posible_limite_de_pasos: cronologia.filter((f) => f.posible_limite_de_pasos).length,
    },
    cronologia,
    entregables: entregables.map((d) => ({ ...d, titulo: anonimizar(d.titulo) })),
    consumo_estimado_del_dia_completo: consumo.map((c) => ({ ...c, costo_usd: Number(c.costo_usd) })),
    llamadas_registradas: llamadas.map((l) => ({ ...l, costo_usd: Number(l.costo_usd), costo_estimado: l.costo_estimado == null ? null : Number(l.costo_estimado) })),
    turnos_registrados: turnos.map((t) => ({ ...t, costo_usd: Number(t.costo_usd), motivo: anonimizar(t.motivo || '') })),
  };
}

module.exports = { exportar, conversacionesDelDia, anonimizar };
