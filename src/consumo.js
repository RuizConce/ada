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

async function gastoHoy(uid = usuario().id) {
  const [r] = await qPrincipal('SELECT COALESCE(SUM(costo_usd), 0) AS c FROM consumo WHERE usuario_id = ? AND dia = ?', [uid, diaClave(new Date())]);
  return Number(r.c);
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

module.exports = { registrar, gastoHoy, sobreTope, resumen, tope };
