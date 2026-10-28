// Etapa 3 — Encargos complejos persistentes ("trabajos").
// Un trabajo vive en MySQL: estado, pasos, presupuesto, gasto y eventos. Lo ejecuta un proceso dentro
// del servidor (ejecutar()), separado de la conversación y de la conexión de voz.
//
// Garantías:
// - Un solo trabajo activo por persona (índice único sobre columna generada).
// - Lease con "época" (fencing): quien toma un trabajo incrementa lease_epoch; toda escritura del
//   ejecutor exige su época, así un proceso viejo (reinicio con superposición) no puede guardar nada.
// - Pasos con clave única por trabajo; un paso 'hecho' nunca se vuelve a ejecutar.
// - Acciones externas: se anota la intención (efecto_clave, 'iniciado') ANTES de actuar y, al
//   recuperar, se consulta al sistema externo por esa clave antes de reintentar.
// - Presupuesto: reserva en MySQL antes de cada paso, con margen adaptativo y colchón; se liquida con
//   el costo real; si el real supera lo autorizado, el trabajo se pausa de inmediato.
// - Contenido (objetivo, entradas, resultados) siempre cifrado; nunca en logs.
// - "Completado" solo si la verificación final del tipo de trabajo aprueba el resultado.
const crypto = require('crypto');
const { qPrincipal, transaccionPrincipal, usuario, comoUsuario } = require('./db');
const Cifrado = require('./cifrado');
const Consumo = require('./consumo');
const Registro = require('./registro');

const ACTIVOS = ['propuesto', 'ejecutando', 'esperando_aprobacion', 'pausado', 'pausado_presupuesto', 'bloqueado'];
const LEASE_MS = () => parseInt(process.env.ADA_TRABAJO_LEASE_MS, 10) || 30000;
const PRESUPUESTO_DEFECTO = () => { const n = parseFloat(process.env.ADA_TRABAJO_PRESUPUESTO); return Number.isFinite(n) && n > 0 ? n : 2; };
const AMPLIACIONES = [1, 2];
// Fase 3a: solo trabajos simulados. Los tipos reales se habilitan en fases siguientes, tras sus pruebas.
const TIPOS_PERMITIDOS = () => String(process.env.ADA_TRABAJOS_TIPOS || 'simulacion').split(',').map((t) => t.trim()).filter(Boolean);
const INSTANCIA = Registro.INSTANCIA;

const nuevoId = () => crypto.randomUUID();
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = (v) => Number(v || 0);
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function evento(trabajoId, tipo, detalle, monto, actor) {
  await qPrincipal('INSERT INTO trabajo_eventos (trabajo_id, tipo, detalle, monto, actor, creado_en) VALUES (?, ?, ?, ?, ?, ?)',
    [trabajoId, tipo, detalle ? String(detalle).slice(0, 300) : null, monto == null ? null : monto, actor || null, new Date()]);
}

// ---------- Crear y aprobar ----------

// pasos: [{ clave, tipo, etapa, entrada, externo, estimado }]
async function crear({ tipo = 'simulacion', titulo, objetivo, presupuesto, pasos = [], esperado = null }) {
  const u = usuario();
  if (u.id !== 1) throw err('Los encargos complejos están disponibles solo para la cuenta principal en esta etapa.', 403);
  if (!TIPOS_PERMITIDOS().includes(tipo)) throw err(`Tipo de trabajo no habilitado todavía: ${tipo}`, 403);
  if (!Cifrado.disponible()) throw err('Falta configurar ADA_CLAVE_DATOS en Railway: sin cifrado no se guardan encargos.', 503);
  if (!Array.isArray(pasos) || !pasos.length || pasos.length > 500) throw err('El trabajo necesita entre 1 y 500 pasos');
  const claves = new Set();
  for (const p of pasos) {
    if (!p.clave || !/^[\w:.\-]{1,190}$/.test(p.clave)) throw err(`Clave de paso inválida: ${p.clave}`);
    if (claves.has(p.clave)) throw err(`Clave de paso repetida: ${p.clave}`);
    claves.add(p.clave);
    if (!EJECUTORES[p.tipo]) throw err(`Tipo de paso desconocido: ${p.tipo}`);
  }
  const id = nuevoId();
  const ahora = new Date();
  const estimadoTotal = pasos.reduce((a, p) => a + num(p.estimado), 0);
  const pres = presupuesto > 0 ? Math.min(presupuesto, 50) : PRESUPUESTO_DEFECTO();
  try {
    await transaccionPrincipal(async (tq) => {
      await tq(`INSERT INTO trabajos (id, usuario_id, tipo, titulo, objetivo_cifrado, esperado_cifrado, estado, presupuesto_usd, estimado_total_usd,
          pasos_total, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, 'propuesto', ?, ?, ?, ?, ?)`,
      [id, u.id, tipo, String(titulo || 'Encargo').slice(0, 200), Cifrado.cifrarJSON(objetivo || null), Cifrado.cifrarJSON(esperado), pres, estimadoTotal, pasos.length, ahora, ahora]);
      let orden = 0;
      for (const p of pasos) {
        orden += 1;
        await tq(`INSERT INTO trabajo_pasos (id, trabajo_id, clave, orden, etapa, tipo, entrada_cifrada, externo, estimado_usd, max_intentos)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [nuevoId(), id, p.clave, orden, p.etapa || null, p.tipo, Cifrado.cifrarJSON(p.entrada || {}), p.externo ? 1 : 0, num(p.estimado), p.max_intentos || 3]);
      }
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' && /uq_un_activo/.test(e.message)) throw err('Ya tienes un encargo complejo activo. Termínalo, pausa o cancélalo antes de empezar otro.', 409);
    throw e;
  }
  await evento(id, 'propuesto', `presupuesto propuesto US$${pres.toFixed(2)}; estimado US$${estimadoTotal.toFixed(2)}`, pres, `u${u.id}`);
  return ver(id);
}

async function propio(id) {
  const [t] = await qPrincipal('SELECT * FROM trabajos WHERE id = ?', [String(id).slice(0, 36)]);
  if (!t || t.usuario_id !== usuario().id) throw err('No existe ese encargo', 404);
  return t;
}

// Cambio de estado del lado de la persona (no del ejecutor), con la fila bloqueada.
async function cambiar(id, desde, hacia, { tipo, detalle, monto, extra = {} } = {}) {
  const u = usuario();
  const r = await transaccionPrincipal(async (tq) => {
    const [t] = await tq('SELECT * FROM trabajos WHERE id = ? FOR UPDATE', [id]);
    if (!t || t.usuario_id !== u.id) throw err('No existe ese encargo', 404);
    if (!desde.includes(t.estado)) throw err(`El encargo está "${t.estado}"; no se puede ${tipo} desde ahí`, 409);
    const sets = ['estado = ?', 'actualizado_en = ?'];
    const vals = [hacia, new Date()];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); vals.push(v); }
    await tq(`UPDATE trabajos SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    return t;
  });
  await evento(id, tipo, detalle, monto, `u${u.id}`);
  return r;
}

async function aprobar(id) {
  await cambiar(id, ['propuesto'], 'ejecutando', { tipo: 'aprobar', detalle: 'presupuesto aprobado', extra: { aprobado_en: new Date() } });
  despertar();
  return ver(id);
}

// Aprobar un punto de control (p. ej. la lista de requisitos extraída): el paso queda hecho con lo
// aprobado y el trabajo sigue desde el paso siguiente. Opcionalmente, la persona corrige la lista.
async function aprobarPaso(id, { lista } = {}) {
  const u = usuario();
  await transaccionPrincipal(async (tq) => {
    const [t] = await tq('SELECT * FROM trabajos WHERE id = ? FOR UPDATE', [id]);
    if (!t || t.usuario_id !== u.id) throw err('No existe ese encargo', 404);
    if (t.estado !== 'esperando_aprobacion') throw err(`El encargo está "${t.estado}"; no hay nada que aprobar`, 409);
    const [p] = await tq("SELECT * FROM trabajo_pasos WHERE trabajo_id = ? AND estado = 'en_espera' ORDER BY orden LIMIT 1 FOR UPDATE", [id]);
    if (!p) throw err('No hay un punto de aprobación pendiente', 409);
    const propuesto = Cifrado.descifrarJSON(p.resultado_cifrado) || {};
    const aprobado = { ...propuesto, aprobado: true, lista: Array.isArray(lista) && lista.length ? lista : propuesto.lista, aprobado_en: new Date() };
    await tq("UPDATE trabajo_pasos SET estado = 'hecho', resultado_cifrado = ?, resultado_hash = ?, fin = ? WHERE id = ?",
      [Cifrado.cifrarJSON(aprobado), hash(JSON.stringify(aprobado)), new Date(), p.id]);
    await tq("UPDATE trabajos SET estado = 'ejecutando', pasos_hechos = pasos_hechos + 1, motivo = NULL, actualizado_en = ? WHERE id = ?", [new Date(), id]);
  });
  await evento(id, 'aprobar_paso', Array.isArray(lista) ? `lista corregida (${lista.length} ítems)` : 'lista aprobada', null, `u${u.id}`);
  despertar();
  return ver(id);
}

// Pausar: si nadie lo ejecuta, se pausa ya; si se está ejecutando, termina el paso en curso y no inicia otro.
async function pausar(id) {
  const t = await propio(id);
  if (t.estado !== 'ejecutando') throw err(`El encargo está "${t.estado}"`, 409);
  await qPrincipal("UPDATE trabajos SET pausa_solicitada = 1, actualizado_en = ? WHERE id = ? AND estado = 'ejecutando'", [new Date(), id]);
  await evento(id, 'pausa_solicitada', null, null, `u${usuario().id}`);
  const libre = !t.lease_hasta || new Date(t.lease_hasta) < new Date();
  if (libre) await cambiar(id, ['ejecutando'], 'pausado', { tipo: 'pausar', detalle: 'sin paso en curso', extra: { pausa_solicitada: 0 } });
  return ver(id);
}

async function reanudar(id) {
  await cambiar(id, ['pausado'], 'ejecutando', { tipo: 'reanudar', extra: { pausa_solicitada: 0, motivo: null } });
  despertar();
  return ver(id);
}

// Ampliar presupuesto (US$1 o US$2): sigue desde el paso siguiente, sin reiniciar nada.
async function ampliar(id, monto) {
  const m = Number(monto);
  if (!AMPLIACIONES.includes(m)) throw err('La ampliación es de US$1 o US$2');
  const u = usuario();
  await transaccionPrincipal(async (tq) => {
    const [t] = await tq('SELECT * FROM trabajos WHERE id = ? FOR UPDATE', [id]);
    if (!t || t.usuario_id !== u.id) throw err('No existe ese encargo', 404);
    if (!['pausado_presupuesto', 'ejecutando', 'pausado'].includes(t.estado)) throw err(`El encargo está "${t.estado}"`, 409);
    const nuevo = t.estado === 'pausado_presupuesto' ? 'ejecutando' : t.estado;
    await tq('UPDATE trabajos SET presupuesto_usd = presupuesto_usd + ?, estado = ?, motivo = NULL, actualizado_en = ? WHERE id = ?', [m, nuevo, new Date(), id]);
  });
  await evento(id, 'ampliar', `presupuesto +US$${m}`, m, `u${u.id}`);
  despertar();
  return ver(id);
}

// Cancelar: si nadie lo ejecuta, se cancela ya; si se ejecuta, el ejecutor corta el paso en curso.
async function cancelar(id) {
  const t = await propio(id);
  if (!ACTIVOS.includes(t.estado)) throw err(`El encargo ya está "${t.estado}"`, 409);
  await qPrincipal('UPDATE trabajos SET cancelar_solicitado = 1, actualizado_en = ? WHERE id = ?', [new Date(), id]);
  await evento(id, 'cancelacion_solicitada', null, null, `u${usuario().id}`);
  const enCurso = enEjecucion.get(id);
  if (enCurso) enCurso.abortar();
  const libre = t.estado !== 'ejecutando' || !t.lease_hasta || new Date(t.lease_hasta) < new Date();
  if (libre) {
    await cambiar(id, ACTIVOS, 'cancelado', { tipo: 'cancelar', extra: { terminado_en: new Date(), cancelar_solicitado: 0 } });
    await qPrincipal("UPDATE reservas_ia SET estado = 'liberada' WHERE trabajo_id = ? AND estado = 'activa'", [id]);
  }
  return ver(id);
}

// Reintentar un trabajo bloqueado: los pasos fallidos vuelven a pendiente (los hechos se conservan).
async function reintentar(id) {
  const t = await propio(id);
  if (t.estado !== 'bloqueado') throw err(`El encargo está "${t.estado}"`, 409);
  await qPrincipal("UPDATE trabajo_pasos SET estado = 'pendiente', intentos = 0, error = NULL WHERE trabajo_id = ? AND estado IN ('fallido', 'revision')", [id]);
  await cambiar(id, ['bloqueado'], 'ejecutando', { tipo: 'reintentar', extra: { motivo: null } });
  despertar();
  return ver(id);
}

// ---------- Consultar (progreso real, desde la base) ----------

async function ver(id, { conResultado = false } = {}) {
  const t = await propio(id);
  const pasos = await qPrincipal('SELECT clave, orden, etapa, tipo, estado, intentos, externo, efecto_estado, estimado_usd, costo_usd, error, inicio, fin FROM trabajo_pasos WHERE trabajo_id = ? ORDER BY orden', [id]);
  const eventos = await qPrincipal('SELECT tipo, detalle, monto, actor, creado_en FROM trabajo_eventos WHERE trabajo_id = ? ORDER BY id', [id]);
  const [{ r }] = await qPrincipal("SELECT COALESCE(SUM(monto), 0) AS r FROM reservas_ia WHERE trabajo_id = ? AND estado = 'activa' AND vence_en > ?", [id, new Date()]);
  const cuenta = (e) => pasos.filter((p) => p.estado === e).length;
  const vivo = t.estado === 'ejecutando' && t.lease_hasta && new Date(t.lease_hasta) > new Date();
  return {
    id: t.id, tipo: t.tipo, titulo: t.titulo, estado: t.estado,
    // Estado honesto: "ejecutando" sin nadie trabajando se informa como "esperando ejecutor".
    estado_real: t.estado === 'ejecutando' ? (vivo ? 'trabajando' : 'esperando ejecutor') : t.estado,
    motivo: t.motivo, etapa: t.etapa,
    presupuesto_usd: num(t.presupuesto_usd), gastado_usd: num(t.gastado_usd), reservado_usd: num(r), estimado_total_usd: num(t.estimado_total_usd),
    pasos: { total: pasos.length, hechos: cuenta('hecho'), pendientes: cuenta('pendiente'), en_curso: cuenta('en_curso'), en_espera: cuenta('en_espera'), fallidos: cuenta('fallido'), revision: cuenta('revision') },
    detalle_pasos: pasos.map((p) => ({ ...p, estimado_usd: num(p.estimado_usd), costo_usd: num(p.costo_usd) })),
    eventos,
    creado_en: t.creado_en, aprobado_en: t.aprobado_en, terminado_en: t.terminado_en,
    ...(conResultado && t.resultado_cifrado ? { resultado: Cifrado.descifrarJSON(t.resultado_cifrado) } : {}),
  };
}

async function listar() {
  return qPrincipal('SELECT id, tipo, titulo, estado, presupuesto_usd, gastado_usd, pasos_total, pasos_hechos, creado_en, terminado_en FROM trabajos WHERE usuario_id = ? ORDER BY creado_en DESC LIMIT 30', [usuario().id]);
}

// ---------- Ejecutores de pasos ----------
// Fase 3a: solo pasos SIMULADOS (sin Claude real, sin Drive, sin documentos de producción).
// Cada uno recibe { entrada, intento, señal, previos } y devuelve { resultado, costo, estimadoReal }.

const dormir = (ms, senal) => new Promise((ok, mal) => {
  const t = setTimeout(ok, ms);
  if (senal) senal.addEventListener('abort', () => { clearTimeout(t); mal(Object.assign(new Error('cancelado'), { cancelado: true })); }, { once: true });
});

// Sistema externo simulado: sin idempotencia propia (cada llamada crea una fila).
const Externo = {
  async buscar(clave) {
    const [r] = await qPrincipal('SELECT id FROM efectos_simulados WHERE clave = ? ORDER BY id LIMIT 1', [clave]);
    return r || null;
  },
  async crear(clave, trabajoId) {
    const r = await qPrincipal('INSERT INTO efectos_simulados (clave, trabajo_id, creado_en) VALUES (?, ?, ?)', [clave, trabajoId, new Date()]);
    return { id: r.insertId };
  },
};

const EJECUTORES = {
  // Simula una llamada a IA: demora, costo real (puede diferir del estimado) y fallas programadas.
  async sim_ia({ entrada, intento, senal }) {
    await dormir(entrada.ms || 50, senal);
    if (intento <= (entrada.fallar_veces || 0)) throw new Error(`falla simulada (intento ${intento})`);
    const r = { valor: entrada.valor !== undefined ? entrada.valor : null, requisito: entrada.requisito || null };
    for (const k of ['archivo_id', 'archivo_version', 'ubicacion', 'cita', 'justificacion']) if (entrada[k] != null) r[k] = entrada[k];
    return { resultado: r, costo: num(entrada.real !== undefined ? entrada.real : entrada.estimado) };
  },
  // Simula una acción con efecto fuera de ADA (p. ej. crear un archivo en Drive).
  async sim_externo({ entrada, senal, efectoClave, trabajoId, confirmarLease }) {
    const existente = await Externo.buscar(efectoClave);
    if (existente) return { resultado: { efecto_id: existente.id, reutilizado: true }, costo: 0 };
    await dormir(entrada.ms_antes || 0, senal);
    await confirmarLease(); // justo antes de actuar: si otro proceso tomó el trabajo, no se actúa
    const creado = await Externo.crear(efectoClave, trabajoId);
    await dormir(entrada.ms_despues || 0, senal); // ventana en que un corte deja el efecto hecho pero sin anotar
    return { resultado: { efecto_id: creado.id }, costo: 0 };
  },
  // Extracción de un documento (Fase 3b): código, sin IA. Usa la misma capa de extracciones que la
  // conversación: si el archivo no cambió y hay una extracción válida, no se vuelve a descargar.
  // El resultado del paso guarda solo metadatos (id, versión, tamaño, de dónde salió), nunca el texto.
  async extraer({ entrada, trabajoId, pasoId }) {
    if (!entrada.archivo_id) throw new Error('extraer necesita archivo_id');
    const Drive = require('./drive');
    const r = await Drive.extraerParaTrabajo(entrada.archivo_id, { trabajoId, pasoId });
    return { resultado: r, costo: 0 };
  },
  // Punto de control: propone una lista (p. ej. los requisitos extraídos) y espera aprobación humana.
  async sim_aprobacion({ entrada }) {
    return { esperar: true, resultado: { lista: entrada.lista || [], pregunta: entrada.pregunta || '¿Apruebas esta lista?' }, costo: 0 };
  },
  // Consolida las evidencias de los pasos previos en una matriz, con su trazabilidad completa.
  async sim_consolidar({ previos }) {
    const filas = previos.filter((p) => p.resultado && p.resultado.requisito).map((p) => ({
      requisito: p.resultado.requisito,
      estado: p.resultado.valor,
      archivo_id: p.resultado.archivo_id || null,
      archivo_version: p.resultado.archivo_version || null,
      ubicacion: p.resultado.ubicacion || null,
      cita: p.resultado.cita || null,
      justificacion: p.resultado.justificacion || null,
      paso: p.clave,
    }));
    return { resultado: { filas, total: filas.length }, costo: 0 };
  },
  // Genera un Excel real con la matriz. Se guarda cifrado con su huella, para releerlo y cotejarlo al verificar.
  async sim_entregable({ previos }) {
    const consol = [...previos].reverse().find((p) => p.resultado && Array.isArray(p.resultado.filas));
    if (!consol) throw new Error('no hay matriz consolidada para el entregable');
    const ExcelJS = require('exceljs');
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Matriz');
    hoja.addRow(['Requisito', 'Estado', 'Archivo', 'Versión', 'Ubicación', 'Paso']);
    for (const f of consol.resultado.filas) hoja.addRow([f.requisito, f.estado, f.archivo_id || '', f.archivo_version || '', f.ubicacion || '', f.paso]);
    const buf = Buffer.from(await libro.xlsx.writeBuffer());
    return { resultado: { nombre: 'matriz.xlsx', xlsx_b64: buf.toString('base64'), huella: hash(buf.toString('base64')), filas: consol.resultado.filas.length }, costo: 0 };
  },
};

// Verificación final por tipo de trabajo: "completado" solo si el resultado es íntegro y corresponde.
const ESTADOS_EVIDENCIA = ['cumple', 'parcial', 'no_cumple', 'sin_evidencia', 'no_evaluado', 'no_aplica_justificado'];
async function verificarResultado(t, pasos, esperado) {
  const problemas = [];
  for (const p of pasos) {
    if (p.estado !== 'hecho') problemas.push(`paso ${p.clave} quedó "${p.estado}"`);
    else if (p.resultado_cifrado) {
      // Integridad: el resultado guardado (descifrado) debe coincidir con su huella.
      let ok = false;
      try { ok = hash(JSON.stringify(Cifrado.descifrarJSON(p.resultado_cifrado))) === p.resultado_hash; } catch (_) { ok = false; }
      if (!ok) problemas.push(`resultado del paso ${p.clave} alterado o ilegible`);
    }
  }
  const consol = pasos.filter((p) => p.tipo === 'sim_consolidar').pop();
  let matriz = null;
  // Requisitos que la persona aprobó (punto de control); si no hubo, los del resultado esperado.
  const aprob = pasos.filter((p) => p.tipo === 'sim_aprobacion' && p.estado === 'hecho').pop();
  const aprobados = aprob ? (Cifrado.descifrarJSON(aprob.resultado_cifrado) || {}).lista || [] : null;
  const requeridos = (aprobados || (esperado && esperado.requisitos ? esperado.requisitos.map((r) => r.id) : [])).map((x) => (typeof x === 'object' ? x.id : x));
  if (consol && consol.resultado_cifrado) {
    matriz = Cifrado.descifrarJSON(consol.resultado_cifrado);
    const porReq = new Map(matriz.filas.map((f) => [f.requisito, f]));
    if (new Set(matriz.filas.map((f) => f.requisito)).size !== matriz.filas.length) problemas.push('hay requisitos duplicados en la matriz');
    if (requeridos.length && matriz.filas.length !== requeridos.length) problemas.push(`la matriz tiene ${matriz.filas.length} filas y hay ${requeridos.length} requisitos aprobados`);
    for (const id of requeridos) if (!porReq.has(id)) problemas.push(`falta el requisito ${id}`);
    for (const f of matriz.filas) {
      if (requeridos.length && !requeridos.includes(f.requisito)) problemas.push(`${f.requisito} no está en la lista aprobada`);
      if (!ESTADOS_EVIDENCIA.includes(f.estado)) { problemas.push(`estado inválido en ${f.requisito}: ${f.estado}`); continue; }
      // Trazabilidad: lo evaluado con evidencia debe decir de qué archivo, versión y ubicación sale.
      if (['cumple', 'parcial', 'no_cumple'].includes(f.estado) && !(f.archivo_id && f.archivo_version && f.ubicacion && f.cita)) problemas.push(`${f.requisito}: "${f.estado}" sin fuente completa (archivo, versión, ubicación y cita)`);
      if (f.estado === 'no_aplica_justificado' && !f.justificacion) problemas.push(`${f.requisito}: "no aplica" sin justificación`);
    }
    // Resultado correcto conocido (pruebas con datos ficticios): debe clasificar bien, no solo producir algo.
    if (esperado && Array.isArray(esperado.requisitos)) {
      for (const r of esperado.requisitos) {
        const f = porReq.get(r.id);
        if (f && r.estado && f.estado !== r.estado) problemas.push(`${r.id}: se obtuvo "${f.estado}" y lo correcto es "${r.estado}"`);
      }
    }
  } else if (requeridos.length) problemas.push('no hay matriz consolidada');
  // El entregable se relee y se coteja con la matriz: no basta con que exista un archivo.
  const ent = pasos.filter((p) => p.tipo === 'sim_entregable').pop();
  if (ent) {
    try {
      const e = Cifrado.descifrarJSON(ent.resultado_cifrado);
      if (hash(e.xlsx_b64) !== e.huella) problemas.push('el Excel no coincide con su huella (alterado)');
      const ExcelJS = require('exceljs');
      const libro = new ExcelJS.Workbook();
      await libro.xlsx.load(Buffer.from(e.xlsx_b64, 'base64'));
      const hoja = libro.getWorksheet('Matriz');
      const filas = [];
      hoja.eachRow((row, n) => { if (n > 1) filas.push({ requisito: row.getCell(1).value, estado: row.getCell(2).value, archivo_id: row.getCell(3).value || null }); });
      if (!matriz || filas.length !== matriz.filas.length) problemas.push(`el Excel tiene ${filas.length} filas y la matriz ${matriz ? matriz.filas.length : 0}`);
      else filas.forEach((x, i) => {
        const m = matriz.filas[i];
        if (x.requisito !== m.requisito || x.estado !== m.estado || (x.archivo_id || null) !== (m.archivo_id || null)) problemas.push(`el Excel no corresponde a la matriz en la fila ${i + 1} (${x.requisito})`);
      });
    } catch (e) { problemas.push(`no se pudo releer el Excel: ${e.message}`); }
  } else if (esperado && esperado.entregable) problemas.push('falta el entregable');
  return { ok: !problemas.length, problemas, matriz };
}

// ---------- El ejecutor ----------

const enEjecucion = new Map(); // trabajoId → { abortar }

// Margen adaptativo: si en este trabajo lo real ha superado lo estimado, el margen sube.
async function margenDe(trabajoId) {
  const filas = await qPrincipal("SELECT estimado_usd, costo_usd FROM trabajo_pasos WHERE trabajo_id = ? AND estado = 'hecho' AND estimado_usd > 0 ORDER BY fin DESC LIMIT 20", [trabajoId]);
  const razones = filas.map((f) => num(f.costo_usd) / num(f.estimado_usd)).filter((x) => Number.isFinite(x));
  const peor = razones.length ? Math.max(...razones) : 1;
  return Math.min(3, Math.max(1.25, peor * 1.1));
}

// Toma un trabajo libre (lease vencido) e incrementa su época. Devuelve la fila o null.
async function tomar(trabajoId) {
  const ahora = new Date();
  const r = await qPrincipal(
    `UPDATE trabajos SET lease_de = ?, lease_hasta = ?, lease_epoch = lease_epoch + 1, actualizado_en = ?
     WHERE id = ? AND estado = 'ejecutando' AND (lease_hasta IS NULL OR lease_hasta < ?)`,
    [INSTANCIA, new Date(ahora.getTime() + LEASE_MS()), ahora, trabajoId, ahora]
  );
  if (r.affectedRows !== 1) return null;
  const [t] = await qPrincipal('SELECT * FROM trabajos WHERE id = ?', [trabajoId]);
  return t && t.lease_de === INSTANCIA ? t : null;
}

async function renovar(t) {
  const r = await qPrincipal('UPDATE trabajos SET lease_hasta = ? WHERE id = ? AND lease_epoch = ? AND lease_de = ?', [new Date(Date.now() + LEASE_MS()), t.id, t.lease_epoch, INSTANCIA]);
  return r.affectedRows === 1;
}

// Cambio de estado del ejecutor: exige su época (si perdió el lease, no escribe nada).
async function estadoEjecutor(t, estado, motivo, extra = {}) {
  const sets = ['estado = ?', 'motivo = ?', 'lease_hasta = NULL', 'actualizado_en = ?'];
  const vals = [estado, motivo ? String(motivo).slice(0, 300) : null, new Date()];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); vals.push(v); }
  const r = await qPrincipal(`UPDATE trabajos SET ${sets.join(', ')} WHERE id = ? AND lease_epoch = ?`, [...vals, t.id, t.lease_epoch]);
  if (r.affectedRows === 1) await evento(t.id, estado, motivo, null, 'ejecutor');
  return r.affectedRows === 1;
}

// Recupera un paso que quedó "en curso" de una época anterior (reinicio o corte).
async function recuperarPaso(t, p) {
  const entradaP = Cifrado.descifrarJSON(p.entrada_cifrada) || {};
  if (p.externo && p.efecto_estado === 'iniciado' && entradaP.verificable === false) {
    // No se puede consultar si la acción externa alcanzó a hacerse: lo decide una persona.
    await qPrincipal("UPDATE trabajo_pasos SET estado = 'revision', error = 'acción externa sin confirmar: revisar antes de repetir' WHERE id = ? AND estado = 'en_curso'", [p.id]);
    await evento(t.id, 'paso_revision', `${p.clave}: no se puede confirmar si la acción externa se hizo`, null, 'ejecutor');
    return 'revision';
  }
  if (p.externo && p.efecto_estado === 'iniciado') {
    const hecho = await Externo.buscar(p.efecto_clave);
    if (hecho) {
      const obj = { efecto_id: hecho.id, recuperado: true };
      await qPrincipal("UPDATE trabajo_pasos SET estado = 'hecho', efecto_estado = 'confirmado', resultado_cifrado = ?, resultado_hash = ?, fin = ?, lease_epoch = ? WHERE id = ? AND estado = 'en_curso'",
        [Cifrado.cifrarJSON(obj), hash(JSON.stringify(obj)), new Date(), t.lease_epoch, p.id]);
      await evento(t.id, 'paso_recuperado', `${p.clave}: la acción externa ya estaba hecha; no se repite`, null, 'ejecutor');
      return 'hecho';
    }
  }
  const agotado = p.intentos >= p.max_intentos;
  await qPrincipal('UPDATE trabajo_pasos SET estado = ?, error = ? WHERE id = ? AND estado = \'en_curso\'',
    [agotado ? 'fallido' : 'pendiente', agotado ? 'se cortó en todos sus intentos' : 'cortado por reinicio; se reintenta', p.id]);
  await evento(t.id, 'paso_recuperado', `${p.clave}: ${agotado ? 'agotó sus intentos' : 'vuelve a pendiente'}`, null, 'ejecutor');
  return agotado ? 'fallido' : 'pendiente';
}

// Reserva el costo del paso dentro del presupuesto del trabajo (fila bloqueada) y del tope diario.
async function reservarPaso(t, p, requerido) {
  return transaccionPrincipal(async (tq) => {
    const [x] = await tq('SELECT presupuesto_usd, gastado_usd, lease_epoch, estado FROM trabajos WHERE id = ? FOR UPDATE', [t.id]);
    if (!x || x.lease_epoch !== t.lease_epoch || x.estado !== 'ejecutando') return { ok: false, perdido: true };
    const [{ r }] = await tq("SELECT COALESCE(SUM(monto), 0) AS r FROM reservas_ia WHERE trabajo_id = ? AND estado = 'activa' AND vence_en > ?", [t.id, new Date()]);
    const presupuesto = num(x.presupuesto_usd);
    const colchon = Math.max(0.02, presupuesto * 0.05);
    const disponible = presupuesto - num(x.gastado_usd) - num(r) - colchon;
    if (requerido > disponible) return { ok: false, presupuesto: true, disponible, requerido, gastado: num(x.gastado_usd) };
    return { ok: true };
  });
}

async function ejecutarPaso(t, p, senal) {
  const entrada = Cifrado.descifrarJSON(p.entrada_cifrada) || {};
  const margen = await margenDe(t.id);
  const requerido = num(p.estimado_usd) * margen;
  const pres = await reservarPaso(t, p, requerido);
  if (pres.perdido) return { perdido: true };
  if (!pres.ok) {
    await estadoEjecutor(t, 'pausado_presupuesto', `el siguiente paso (${p.clave}, ~US$${requerido.toFixed(3)} con margen ×${margen.toFixed(2)}) no cabe: quedan US$${Math.max(0, pres.disponible).toFixed(3)} sin contar el colchón`);
    return { pausado: true };
  }
  // Tope diario de la persona (reserva persistente).
  const reserva = await Consumo.reservar(requerido, { trabajoId: t.id, pasoId: p.id });
  if (!reserva.ok) {
    await estadoEjecutor(t, 'pausado_presupuesto', reserva.motivo);
    return { pausado: true };
  }
  const intento = p.intentos + 1;
  const efectoClave = p.externo ? `${t.id}:${p.clave}` : null;
  const ini = await qPrincipal(
    "UPDATE trabajo_pasos SET estado = 'en_curso', intentos = ?, lease_epoch = ?, inicio = ?, efecto_clave = ?, efecto_estado = ?, error = NULL WHERE id = ? AND estado = 'pendiente'",
    [intento, t.lease_epoch, new Date(), efectoClave, p.externo ? 'iniciado' : null, p.id]
  );
  if (ini.affectedRows !== 1) { await reserva.liberar(); return { perdido: true }; }
  // Solo quien tiene el lease vigente puede continuar.
  const [vigente] = await qPrincipal('SELECT lease_epoch FROM trabajos WHERE id = ?', [t.id]);
  if (!vigente || vigente.lease_epoch !== t.lease_epoch) { await reserva.liberar(); return { perdido: true }; }

  const previos = (await qPrincipal("SELECT clave, resultado_cifrado FROM trabajo_pasos WHERE trabajo_id = ? AND estado = 'hecho' ORDER BY orden", [t.id]))
    .map((x) => ({ clave: x.clave, resultado: Cifrado.descifrarJSON(x.resultado_cifrado) }));
  const t0 = Date.now();
  let salida;
  try {
    const confirmarLease = async () => {
      const [v] = await qPrincipal('SELECT lease_epoch, lease_de FROM trabajos WHERE id = ?', [t.id]);
      if (!v || v.lease_epoch !== t.lease_epoch || v.lease_de !== INSTANCIA || senal.aborted) throw Object.assign(new Error('perdió el turno de ejecución'), { cancelado: true, perdido: true });
    };
    salida = await EJECUTORES[p.tipo]({ entrada, intento, senal, previos, efectoClave, trabajoId: t.id, pasoId: p.id, confirmarLease });
  } catch (e) {
    const costoParcial = e.cancelado ? num(entrada.estimado) * 0.5 : 0;
    await Registro.llamada({ origen: 'simulacion', turnoId: t.id, trabajoId: t.id, pasoId: p.id, paso: intento, modelo: 'simulado', usage: {}, costoForzado: costoParcial, duracionMs: Date.now() - t0, error: e.cancelado ? 'cancelado' : e.message, estimado: requerido });
    await reserva.liberar(costoParcial);
    await qPrincipal('UPDATE trabajos SET gastado_usd = gastado_usd + ? WHERE id = ? AND lease_epoch = ?', [costoParcial, t.id, t.lease_epoch]);
    if (e.perdido) return { perdido: true }; // el nuevo dueño del trabajo recupera el paso
    if (e.cancelado) {
      await qPrincipal("UPDATE trabajo_pasos SET estado = 'pendiente', error = 'cancelado durante el paso', costo_usd = costo_usd + ? WHERE id = ? AND lease_epoch = ?", [costoParcial, p.id, t.lease_epoch]);
      return { cancelado: true };
    }
    const agotado = intento >= p.max_intentos;
    await qPrincipal('UPDATE trabajo_pasos SET estado = ?, error = ?, efecto_estado = NULL WHERE id = ? AND lease_epoch = ?', [agotado ? 'fallido' : 'pendiente', String(e.message).slice(0, 300), p.id, t.lease_epoch]);
    await evento(t.id, agotado ? 'paso_fallido' : 'paso_reintento', `${p.clave}: ${e.message}`, null, 'ejecutor');
    return { fallido: agotado };
  }
  if (salida.esperar) {
    await reserva.liberar(0);
    const r = await qPrincipal("UPDATE trabajo_pasos SET estado = 'en_espera', resultado_cifrado = ? WHERE id = ? AND lease_epoch = ? AND estado = 'en_curso'",
      [Cifrado.cifrarJSON(salida.resultado), p.id, t.lease_epoch]);
    if (r.affectedRows !== 1) return { perdido: true };
    await estadoEjecutor(t, 'esperando_aprobacion', `${p.clave}: necesita tu aprobación para seguir`);
    return { esperando: true };
  }
  const costo = num(salida.costo);
  if (costo > 0 || p.tipo === 'sim_ia') {
    await Registro.llamada({ origen: 'simulacion', turnoId: t.id, trabajoId: t.id, pasoId: p.id, paso: intento, modelo: 'simulado', usage: {}, costoForzado: costo, duracionMs: Date.now() - t0, stopReason: 'end_turn', estimado: requerido });
  }
  const res = Cifrado.cifrarJSON(salida.resultado);
  const resHash = hash(JSON.stringify(salida.resultado));
  const fin = await transaccionPrincipal(async (tq) => {
    const [x] = await tq('SELECT lease_epoch, presupuesto_usd, gastado_usd FROM trabajos WHERE id = ? FOR UPDATE', [t.id]);
    if (!x || x.lease_epoch !== t.lease_epoch) return { perdido: true }; // otro proceso tomó el trabajo: no se guarda nada
    const u = await tq(
      "UPDATE trabajo_pasos SET estado = 'hecho', resultado_cifrado = ?, resultado_hash = ?, costo_usd = costo_usd + ?, fin = ?, efecto_estado = IF(externo = 1, 'confirmado', NULL) WHERE id = ? AND lease_epoch = ? AND estado = 'en_curso'",
      [res, resHash, costo, new Date(), p.id, t.lease_epoch]
    );
    if (u.affectedRows !== 1) return { perdido: true };
    await tq('UPDATE trabajos SET gastado_usd = gastado_usd + ?, pasos_hechos = pasos_hechos + 1, etapa = ?, actualizado_en = ? WHERE id = ?', [costo, p.etapa, new Date(), t.id]);
    return { ok: true, exceso: num(x.gastado_usd) + costo > num(x.presupuesto_usd) };
  });
  await reserva.liberar(costo);
  if (fin.perdido) return { perdido: true };
  if (costo > requerido) await evento(t.id, 'desvio_costo', `${p.clave}: real US$${costo.toFixed(4)} > reservado US$${requerido.toFixed(4)}`, costo - requerido, 'ejecutor');
  if (fin.exceso) {
    await estadoEjecutor(t, 'pausado_presupuesto', 'el costo real superó el presupuesto: pausado de inmediato');
    return { pausado: true };
  }
  return { ok: true };
}

// Ejecuta un trabajo tomado hasta terminar, pausarse, cancelarse, bloquearse o perder el lease.
async function correr(t, { maxPasos = Infinity } = {}) {
  const control = new AbortController();
  enEjecucion.set(t.id, { abortar: () => control.abort() });
  const latido = setInterval(async () => {
    try {
      if (!(await renovar(t))) control.abort();
      const [f] = await qPrincipal('SELECT cancelar_solicitado FROM trabajos WHERE id = ?', [t.id]);
      if (f && f.cancelar_solicitado) control.abort();
    } catch (_) {}
  }, Math.max(500, Math.floor(LEASE_MS() / 3)));
  let hechos = 0;
  try {
    for (;;) {
      const [f] = await qPrincipal('SELECT estado, lease_epoch, pausa_solicitada, cancelar_solicitado FROM trabajos WHERE id = ?', [t.id]);
      if (!f || f.lease_epoch !== t.lease_epoch || f.estado !== 'ejecutando') return 'perdido';
      if (f.cancelar_solicitado) {
        await estadoEjecutor(t, 'cancelado', 'cancelado por la persona', { cancelar_solicitado: 0, terminado_en: new Date() });
        await qPrincipal("UPDATE reservas_ia SET estado = 'liberada' WHERE trabajo_id = ? AND estado = 'activa'", [t.id]);
        return 'cancelado';
      }
      if (f.pausa_solicitada) { await estadoEjecutor(t, 'pausado', 'pausado por la persona', { pausa_solicitada: 0 }); return 'pausado'; }
      if (hechos >= maxPasos) return 'limite_prueba';
      const pasos = await qPrincipal('SELECT * FROM trabajo_pasos WHERE trabajo_id = ? ORDER BY orden', [t.id]);
      const huerfano = pasos.find((p) => p.estado === 'en_curso' && p.lease_epoch !== t.lease_epoch);
      if (huerfano) { await recuperarPaso(t, huerfano); continue; }
      const fallido = pasos.find((p) => p.estado === 'fallido' || p.estado === 'revision');
      if (fallido) { await estadoEjecutor(t, 'bloqueado', `paso ${fallido.clave}: ${fallido.error || 'falló'}`); return 'bloqueado'; }
      const siguiente = pasos.find((p) => p.estado === 'pendiente');
      if (!siguiente) {
        const esperado = Cifrado.descifrarJSON(t.esperado_cifrado);
        const v = await verificarResultado(t, pasos, esperado);
        if (!v.ok) { await estadoEjecutor(t, 'bloqueado', `verificación final: ${v.problemas.slice(0, 3).join('; ')}`); return 'bloqueado'; }
        const final = { matriz: v.matriz, verificado: true };
        await estadoEjecutor(t, 'completado', 'verificación final aprobada', { terminado_en: new Date(), resultado_cifrado: Cifrado.cifrarJSON(final), resultado_hash: hash(JSON.stringify(final)) });
        return 'completado';
      }
      const r = await ejecutarPaso(t, siguiente, control.signal);
      if (r.perdido) return 'perdido';
      if (r.pausado) return 'pausado_presupuesto';
      if (r.esperando) return 'esperando_aprobacion';
      if (r.cancelado) continue; // el siguiente ciclo ve la solicitud de cancelación
      hechos += 1;
    }
  } finally {
    clearInterval(latido);
    enEjecucion.delete(t.id);
  }
}

// Bucle del servidor: busca trabajos en "ejecutando" sin lease vigente y los ejecuta de a uno.
let ocupado = false;
let temporizador = null;
async function ciclo() {
  if (ocupado) return;
  ocupado = true;
  try {
    const candidatos = await qPrincipal("SELECT id, usuario_id FROM trabajos WHERE estado = 'ejecutando' AND (lease_hasta IS NULL OR lease_hasta < ?) ORDER BY actualizado_en LIMIT 5", [new Date()]);
    for (const c of candidatos) {
      const [u] = await qPrincipal('SELECT id, nombre, admin FROM usuarios WHERE id = ?', [c.usuario_id]);
      if (!u) continue;
      await comoUsuario({ id: u.id, nombre: u.nombre, admin: !!u.admin }, async () => {
        const t = await tomar(c.id);
        if (t) {
          const fin = await correr(t);
          console.log(`Trabajo ${t.id.slice(0, 8)} (u${u.id}): ${fin}`);
        }
      });
    }
  } catch (e) {
    console.error('Ejecutor de trabajos:', e.message);
  } finally {
    ocupado = false;
  }
}
function despertar() { setTimeout(() => ciclo().catch(() => {}), 50); }
function iniciar() {
  if (process.env.ADA_TRABAJOS === 'no' || temporizador) return;
  temporizador = setInterval(() => ciclo().catch(() => {}), parseInt(process.env.ADA_TRABAJO_CICLO_MS, 10) || 2000);
}

module.exports = {
  crear, aprobar, aprobarPaso, pausar, reanudar, ampliar, cancelar, reintentar, ver, listar,
  iniciar, ciclo, tomar, correr, verificarResultado, ESTADOS_EVIDENCIA, PRESUPUESTO_DEFECTO,
};
