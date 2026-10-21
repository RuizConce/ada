// Utilidades de fecha. Todo se interpreta en la hora local del proceso (TZ=America/Santiago).
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const pad = (n) => String(n).padStart(2, '0');

function fmt(d) {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())} (${DIAS[x.getDay()]})`;
}

function fmtDia(d) {
  return `${DIAS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Acepta "YYYY-MM-DD", "YYYY-MM-DD HH:MM" o "YYYY-MM-DDTHH:MM". Solo fecha → 23:59 de ese día.
function parse(texto) {
  if (texto === null || texto === undefined || texto === '') return null;
  const m = String(texto).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) throw new Error(`Fecha no válida: "${texto}". Usa YYYY-MM-DD o YYYY-MM-DD HH:MM`);
  const [, y, mo, da, h, mi] = m;
  const d = h !== undefined
    ? new Date(+y, +mo - 1, +da, +h, +mi, 0)
    : new Date(+y, +mo - 1, +da, 23, 59, 0);
  if (isNaN(d.getTime())) throw new Error(`Fecha no válida: "${texto}"`);
  return d;
}

function inicioDelDia(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
}

function inicioDeSemana(d = new Date()) {
  // Semana de lunes a domingo
  const x = inicioDelDia(d);
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x;
}

function minutosEntre(a, b = new Date()) {
  return Math.round((b - new Date(a)) / 60000);
}

module.exports = { fmt, fmtDia, parse, inicioDelDia, inicioDeSemana, minutosEntre, DIAS };
