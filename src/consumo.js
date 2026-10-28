// Cuánto gasta cada persona en Claude (estimado), por día y modelo. Sirve para ver el costo real
// de ADA por usuario y para poner un tope diario a los invitados (al pasarlo, siguen con el modelo rápido).
const { qPrincipal, usuario } = require('./db');
const { diaClave } = require('./agenda');

const COSTO_BUSQUEDA = 0.01; // US$10 por mil búsquedas web

const tope = () => {
  const n = parseFloat(process.env.ADA_TOPE_INVITADO);
  return Number.isFinite(n) ? n : 0.5;
};

async function registrar({ modelo, costo, busquedas = 0 }) {
  const u = usuario();
  const total = (costo || 0) + busquedas * COSTO_BUSQUEDA;
  await qPrincipal(
    `INSERT INTO consumo (usuario_id, dia, modelo, turnos, busquedas, costo_usd) VALUES (?, ?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE turnos = turnos + 1, busquedas = busquedas + VALUES(busquedas), costo_usd = costo_usd + VALUES(costo_usd)`,
    [u.id, diaClave(new Date()), String(modelo).slice(0, 80), busquedas, total]
  );
  return total;
}

// Gasto de hoy: lo registrado llamada por llamada (incluye turnos que se cortaron a mitad) o, si es
// mayor, lo registrado al final de cada turno.
async function gastoHoy(uid = usuario().id) {
  const ahora = new Date();
  const inicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const [[r], [l]] = await Promise.all([
    qPrincipal('SELECT COALESCE(SUM(costo_usd), 0) AS c FROM consumo WHERE usuario_id = ? AND dia = ?', [uid, diaClave(ahora)]),
    qPrincipal("SELECT COALESCE(SUM(costo_usd), 0) AS c FROM llamadas_ia WHERE usuario_id = ? AND creado_en >= ? AND origen <> 'simulacion'", [uid, inicio]).catch(() => [{ c: 0 }]),
  ]);
  return Math.max(Number(r.c), Number(l.c));
}

// ---------- Presupuestos ----------
const num = (v, def) => { const n = parseFloat(v); return Number.isFinite(n) ? n : def; };
const topeTurno = () => num(process.env.ADA_TOPE_TURNO, 0.6);          // por cada mensaje (todas sus llamadas)
const topeDiarioDueno = () => num(process.env.ADA_TOPE_DIARIO, 5);    // Cristian: sobre esto, solo modelo rápido
const topeDuro = (u) => (u.admin || u.id === 1) ? num(process.env.ADA_TOPE_DIARIO_MAX, topeDiarioDueno() * 2) : num(process.env.ADA_TOPE_INVITADO_MAX, tope() * 2);

// Estado del presupuesto del día para quien habla: 'ok', 'rapido' (solo Haiku) o 'detenido' (no se llama a Claude).
const alertasEnviadas = new Set();
async function presupuestoDelDia() {
  const u = usuario();
  const gasto = await gastoHoy(u.id);
  const blando = (u.admin || u.id === 1) ? topeDiarioDueno() : tope();
  const duro = topeDuro(u);
  let nivel = 'ok';
  if (duro > 0 && gasto >= duro) nivel = 'detenido';
  else if (blando > 0 && gasto >= blando) nivel = 'rapido';
  // Alertas al teléfono de Cristian al 80% y 100% del tope del día (una vez por nivel y día).
  const pct = blando > 0 ? gasto / blando : 0;
  const marca = pct >= 1 ? 100 : pct >= 0.8 ? 80 : 0;
  const clave = `${u.id}:${diaClave(new Date())}:${marca}`;
  if (marca && !alertasEnviadas.has(clave)) {
    alertasEnviadas.add(clave);
    try {
      const { comoUsuario } = require('./db');
      const Avisos = require('./avisos');
      const quien = u.id === 1 ? 'Tu ADA' : `ADA de ${u.nombre || `invitado ${u.id}`}`;
      await comoUsuario({ id: 1, nombre: 'Cristian', admin: true }, () => Avisos.enviar({
        titulo: `Gasto de IA: ${marca}% del tope de hoy`,
        cuerpo: `${quien} lleva US$${gasto.toFixed(2)} hoy (tope US$${blando.toFixed(2)}${marca === 100 ? '; desde ahora solo modelo rápido' : ''}).`,
        url: '/', tag: `gasto-${u.id}`,
      }));
    } catch (e) { console.error('Alerta de gasto:', e.message); }
    console.warn(`Gasto u${u.id}: US$${gasto.toFixed(2)} = ${Math.round(pct * 100)}% del tope diario`);
  }
  return { gasto, tope: blando, duro, nivel };
}

// ¿Este turno debe ir con el modelo rápido porque el invitado ya llegó a su tope del día?
async function sobreTope() {
  const u = usuario();
  if (u.admin || u.id === 1 || tope() <= 0) return false;
  return (await gastoHoy(u.id)) >= tope();
}

async function resumen() {
  const hoy = diaClave(new Date());
  const mes = `${hoy.slice(0, 7)}-01`;
  const filas = await qPrincipal(
    `SELECT u.id, u.nombre, u.nota,
       COALESCE(SUM(CASE WHEN c.dia = ? THEN c.costo_usd END), 0) AS hoy,
       COALESCE(SUM(c.costo_usd), 0) AS mes,
       COALESCE(SUM(CASE WHEN c.modelo LIKE '%sonnet%' OR c.modelo LIKE '%opus%' THEN c.costo_usd END), 0) AS profundo_mes,
       COALESCE(SUM(c.turnos), 0) AS turnos_mes
     FROM usuarios u LEFT JOIN consumo c ON c.usuario_id = u.id AND c.dia >= ?
     GROUP BY u.id, u.nombre, u.nota ORDER BY u.id`, [hoy, mes]
  );
  const personas = filas.map((f) => ({ id: f.id, nombre: f.nombre, nota: f.nota, hoy: Number(f.hoy), mes: Number(f.mes), profundo_mes: Number(f.profundo_mes), turnos_mes: Number(f.turnos_mes) }));
  return { tope_invitado: tope(), total_mes: personas.reduce((s, p) => s + p.mes, 0), total_hoy: personas.reduce((s, p) => s + p.hoy, 0), personas };
}

// ---------- Reserva antes de cada llamada ----------
// Las reservas viven en MySQL (tabla reservas_ia): valen entre procesos y reinicios y vencen solas
// (10 min por defecto) si el proceso que las hizo muere. La fila de la persona en `usuarios` se
// bloquea durante la reserva, así dos solicitudes simultáneas no pueden pasar juntas el tope.
async function reservado(uid = usuario().id) {
  const [r] = await qPrincipal("SELECT COALESCE(SUM(monto), 0) AS r FROM reservas_ia WHERE usuario_id = ? AND estado = 'activa' AND vence_en > ?", [uid, new Date()]);
  return Number(r.r);
}
async function reservar(estimado, { trabajoId = null, pasoId = null, turnoId = null, venceMs = 10 * 60 * 1000, tope = null } = {}) {
  const { transaccionPrincipal } = require('./db');
  const u = usuario();
  const gasto = await gastoHoy(u.id);
  const duro = tope != null ? tope : topeDuro(u);
  const r = await transaccionPrincipal(async (tq) => {
    await tq('SELECT id FROM usuarios WHERE id = ? FOR UPDATE', [u.id]);
    const ahora = new Date();
    const [{ r: ocupado }] = await tq("SELECT COALESCE(SUM(monto), 0) AS r FROM reservas_ia WHERE usuario_id = ? AND estado = 'activa' AND vence_en > ?", [u.id, ahora]);
    if (duro > 0 && gasto + Number(ocupado) + estimado > duro) {
      return { ok: false, gasto, duro, motivo: `tope diario: van US$${gasto.toFixed(2)} + US$${Number(ocupado).toFixed(2)} en curso; esta llamada (~US$${estimado.toFixed(2)}) pasaría el máximo de US$${duro.toFixed(2)}` };
    }
    const ins = await tq('INSERT INTO reservas_ia (usuario_id, trabajo_id, paso_id, turno_id, monto, estado, creado_en, vence_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [u.id, trabajoId, pasoId, turnoId, estimado, 'activa', ahora, new Date(ahora.getTime() + venceMs)]);
    return { ok: true, id: ins.insertId, gasto, duro };
  });
  if (!r.ok) return { ...r, liberar: async () => {} };
  let hecho = false;
  // liberar(costoReal): sin costo = no se usó; con costo = se liquidó con lo real.
  r.liberar = async (costoReal) => {
    if (hecho) return;
    hecho = true;
    try {
      await qPrincipal("UPDATE reservas_ia SET estado = ?, costo_real = ? WHERE id = ? AND estado = 'activa'", [costoReal == null ? 'liberada' : 'liquidada', costoReal == null ? null : costoReal, r.id]);
    } catch (e) { console.error('Reserva:', e.message); }
  };
  return r;
}

// ---------- Autorización de un mensaje que no cabe en el tope ----------
// Se guarda en la base de la persona (sobrevive reinicios) y vence a los 15 minutos.
const topeAutorizable = () => num(process.env.ADA_TOPE_TURNO_AUTORIZABLE, 2);
async function pedirAutorizacion(monto) {
  const { q } = require('./db');
  await q(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('autorizacion_turno', ?, ?)
    ON DUPLICATE KEY UPDATE datos = VALUES(datos), actualizado_en = VALUES(actualizado_en)`,
  [JSON.stringify({ monto, hasta: Date.now() + 15 * 60 * 1000 }), new Date()]);
}
async function autorizacionPendiente() {
  const { q } = require('./db');
  const [r] = await q("SELECT datos FROM integraciones WHERE nombre = 'autorizacion_turno'").catch(() => []);
  if (!r) return null;
  const d = JSON.parse(r.datos);
  return d && d.hasta > Date.now() && d.monto > 0 ? d : null;
}
async function usarAutorizacion() {
  const { q } = require('./db');
  await q("DELETE FROM integraciones WHERE nombre = 'autorizacion_turno'");
}

module.exports = { registrar, gastoHoy, sobreTope, resumen, tope, topeTurno, presupuestoDelDia, reservar, reservado, topeAutorizable, pedirAutorizacion, autorizacionPendiente, usarAutorizacion };
