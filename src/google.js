// Google Calendar: conexión OAuth con la cuenta de Cristian y herramientas de agenda para ADA.
// Ver la agenda es libre; crear, mover o eliminar exige que Cristian lo haya confirmado.
const crypto = require('crypto');
const { q } = require('./db');
const F = require('./fechas');
const H = require('./herramientas');

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive', // leer, ordenar y editar Drive (incluye Docs y Sheets)
];
const CALENDARIO = () => process.env.GOOGLE_CALENDAR_ID || 'primary';
const ZONA = 'America/Santiago';

const configurado = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function urlBase(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
const redirectUri = (req) => `${urlBase(req)}/api/google/callback`;

// ---------- Tokens guardados ----------

async function leer() {
  const [r] = await q("SELECT datos FROM integraciones WHERE nombre = 'google'");
  if (!r) return null;
  return typeof r.datos === 'string' ? JSON.parse(r.datos) : r.datos;
}

async function guardar(datos) {
  await q(
    `INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('google', ?, ?)
     ON DUPLICATE KEY UPDATE datos = VALUES(datos), actualizado_en = VALUES(actualizado_en)`,
    [JSON.stringify(datos), new Date()]
  );
}

async function estado() {
  const d = configurado() ? await leer() : null;
  return { configurado: configurado(), conectado: !!(d && d.refresh_token), cuenta: d ? d.email : null };
}

// ---------- OAuth ----------

const enlaces = new Map(); // nonce de un solo uso → vence en 10 min

function crearEnlace(req) {
  const nonce = crypto.randomBytes(16).toString('hex');
  enlaces.set(nonce, Date.now() + 10 * 60 * 1000);
  return `${urlBase(req)}/api/google/conectar?n=${nonce}`;
}

function firmar(valor) {
  return crypto.createHmac('sha256', process.env.ADA_PASSWORD || 'ada').update(`google:${valor}`).digest('hex').slice(0, 32);
}

function urlAutorizacion(req, nonce) {
  const vence = enlaces.get(nonce);
  enlaces.delete(nonce);
  if (!vence || vence < Date.now()) return null;
  const ts = Date.now().toString(36);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: `${ts}.${firmar(ts)}`,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function recibirCallback(req) {
  const { code, state, error } = req.query;
  if (error) throw new Error(`Google respondió: ${error}`);
  const [ts, firma] = String(state || '').split('.');
  if (!ts || firma !== firmar(ts) || Date.now() - parseInt(ts, 36) > 15 * 60 * 1000) throw new Error('Enlace vencido o inválido');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  });
  const t = await res.json();
  if (!res.ok) throw new Error(t.error_description || t.error || 'No se pudo obtener el token');
  const anterior = await leer();
  let email = null;
  try {
    const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } });
    email = (await u.json()).email || null;
  } catch (_) {}
  await guardar({
    refresh_token: t.refresh_token || (anterior && anterior.refresh_token),
    access_token: t.access_token,
    vence: Date.now() + (t.expires_in - 60) * 1000,
    email,
  });
  cacheAgenda = null;
}

async function desconectar() {
  const d = await leer();
  if (d && d.refresh_token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(d.refresh_token)}`, { method: 'POST' }).catch(() => {});
  }
  await q("DELETE FROM integraciones WHERE nombre = 'google'");
  cacheAgenda = null;
  return { ok: true };
}

async function tokenAcceso() {
  if (!configurado()) throw new Error('Google (Calendar y Drive) no está configurado en el servidor.');
  const d = await leer();
  if (!d || !d.refresh_token) throw new Error('Google no está conectado. Cristian puede conectarlo en Ajustes (ícono de engranaje).');
  if (d.access_token && d.vence > Date.now()) return d.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: d.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const t = await res.json();
  if (!res.ok) {
    if (t.error === 'invalid_grant') {
      await q("DELETE FROM integraciones WHERE nombre = 'google'");
      throw new Error('La conexión con Google venció. Cristian debe volver a conectarla en Ajustes.');
    }
    throw new Error(t.error_description || t.error || 'No se pudo renovar el acceso a Google');
  }
  await guardar({ ...d, access_token: t.access_token, vence: Date.now() + (t.expires_in - 60) * 1000 });
  return t.access_token;
}

async function api(ruta, opciones = {}) {
  const token = await tokenAcceso();
  const res = await fetch(`https://www.googleapis.com/calendar/v3${ruta}`, {
    ...opciones,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opciones.headers || {}) },
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `Google Calendar respondió ${res.status}`);
  return data;
}

// ---------- Utilidades de fecha ----------

const pad = (n) => String(n).padStart(2, '0');
function localISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function soloFecha(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function desdeInicioDelDia(texto) {
  return F.parse(String(texto).length <= 10 ? `${texto} 00:00` : texto);
}

function eventoPublico(e) {
  const todoElDia = !!(e.start && e.start.date);
  const ini = todoElDia ? e.start.date : e.start && e.start.dateTime;
  const fin = todoElDia ? e.end.date : e.end && e.end.dateTime;
  return {
    id: e.id,
    titulo: e.summary || '(sin título)',
    inicio: todoElDia ? `${ini} (todo el día)` : F.fmt(new Date(ini)),
    fin: todoElDia ? undefined : F.fmt(new Date(fin)),
    ubicacion: e.location || undefined,
    descripcion: e.description ? e.description.slice(0, 300) : undefined,
    invitados: e.attendees ? e.attendees.length : undefined,
    meet: e.hangoutLink || undefined,
  };
}

// ---------- Herramientas ----------

async function verAgenda(a = {}) {
  const desde = a.desde ? desdeInicioDelDia(a.desde) : F.inicioDelDia();
  let hasta = a.hasta ? F.parse(a.hasta) : new Date(desde.getTime() + 24 * 3600e3 - 60000);
  if (hasta - desde > 31 * 24 * 3600e3) hasta = new Date(desde.getTime() + 31 * 24 * 3600e3);
  const params = new URLSearchParams({
    timeMin: desde.toISOString(),
    timeMax: hasta.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
    timeZone: ZONA,
  });
  if (a.texto) params.set('q', a.texto);
  const r = await api(`/calendars/${encodeURIComponent(CALENDARIO())}/events?${params}`);
  const eventos = (r.items || []).filter((e) => e.status !== 'cancelled').map(eventoPublico);
  return { desde: F.fmt(desde), hasta: F.fmt(hasta), total: eventos.length, eventos };
}

const SIN_CONFIRMAR = {
  error: 'Falta la confirmación de Cristian. Dile exactamente qué vas a hacer (título, día y hora) y espera su "sí". Después vuelve a llamar con confirmado: true.',
};

function cuerpoFechas(a, base = {}) {
  const cuerpo = {};
  if (a.todo_el_dia) {
    const d = desdeInicioDelDia(a.inicio);
    const finDia = a.fin ? desdeInicioDelDia(a.fin) : new Date(d.getTime() + 24 * 3600e3);
    cuerpo.start = { date: soloFecha(d) };
    cuerpo.end = { date: soloFecha(finDia > d ? finDia : new Date(d.getTime() + 24 * 3600e3)) };
    return cuerpo;
  }
  const inicio = F.parse(a.inicio);
  let fin;
  if (a.fin) fin = F.parse(a.fin);
  else if (a.duracion_minutos) fin = new Date(inicio.getTime() + a.duracion_minutos * 60000);
  else if (base.duracionMs) fin = new Date(inicio.getTime() + base.duracionMs);
  else fin = new Date(inicio.getTime() + 60 * 60000);
  if (fin <= inicio) throw new Error('La hora de término debe ser posterior al inicio');
  cuerpo.start = { dateTime: localISO(inicio), timeZone: ZONA };
  cuerpo.end = { dateTime: localISO(fin), timeZone: ZONA };
  return cuerpo;
}

async function crearEvento(a) {
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.titulo || !a.inicio) throw new Error('titulo e inicio son obligatorios');
  const cuerpo = { summary: a.titulo, ...cuerpoFechas(a) };
  if (a.descripcion) cuerpo.description = a.descripcion;
  if (a.ubicacion) cuerpo.location = a.ubicacion;
  const e = await api(`/calendars/${encodeURIComponent(CALENDARIO())}/events`, { method: 'POST', body: JSON.stringify(cuerpo) });
  cacheAgenda = null;
  return { ok: true, evento: eventoPublico(e) };
}

async function modificarEvento(a) {
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id) throw new Error('id es obligatorio (búscalo con ver_agenda)');
  const ruta = `/calendars/${encodeURIComponent(CALENDARIO())}/events/${encodeURIComponent(a.id)}`;
  const actual = await api(ruta);
  const cuerpo = {};
  if (a.titulo) cuerpo.summary = a.titulo;
  if (a.descripcion !== undefined) cuerpo.description = a.descripcion;
  if (a.ubicacion !== undefined) cuerpo.location = a.ubicacion;
  if (a.inicio) {
    const ini = actual.start.dateTime || actual.start.date;
    const fin = actual.end.dateTime || actual.end.date;
    Object.assign(cuerpo, cuerpoFechas(a, { duracionMs: new Date(fin) - new Date(ini) }));
  }
  const e = await api(ruta, { method: 'PATCH', body: JSON.stringify(cuerpo) });
  cacheAgenda = null;
  return { ok: true, evento: eventoPublico(e) };
}

async function eliminarEvento(a) {
  if (a.confirmado !== true) return SIN_CONFIRMAR;
  if (!a.id) throw new Error('id es obligatorio (búscalo con ver_agenda)');
  await api(`/calendars/${encodeURIComponent(CALENDARIO())}/events/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
  cacheAgenda = null;
  return { ok: true };
}

// Agenda de las próximas horas para el contexto de ADA (con caché corta para no demorar cada mensaje).
let cacheAgenda = null;
async function agendaParaContexto() {
  if (!configurado()) return { calendario: 'no configurado' };
  const d = await leer();
  if (!d || !d.refresh_token) return { calendario: 'no conectado (Cristian puede conectarlo en Ajustes)' };
  if (cacheAgenda && cacheAgenda.hasta > Date.now()) return cacheAgenda.datos;
  try {
    const ahora = new Date();
    const r = await Promise.race([
      verAgenda({ desde: localISO(ahora).replace('T', ' ').slice(0, 16), hasta: localISO(new Date(ahora.getTime() + 36 * 3600e3)).replace('T', ' ').slice(0, 16) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tiempo')), 3000)),
    ]);
    const datos = { calendario: 'conectado', agenda_proximas_36h: r.eventos.map((e) => `${e.inicio}: ${e.titulo}`) };
    cacheAgenda = { datos, hasta: Date.now() + 3 * 60 * 1000 };
    return datos;
  } catch (e) {
    return { calendario: `conectado, pero no pude leerlo ahora (${e.message})` };
  }
}

const FECHA = 'YYYY-MM-DD o YYYY-MM-DD HH:MM (hora de Chile). Resuelve "mañana", "el jueves" con la fecha del contexto.';

H.registrar([
  {
    name: 'ver_agenda',
    description: 'Consulta el Google Calendar de Cristian: qué tiene un día o un rango, si está libre, o busca un evento por texto. Por defecto, hoy. Úsala antes de proponer horarios o de mover algo.',
    input_schema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: FECHA },
        hasta: { type: 'string', description: FECHA },
        texto: { type: 'string', description: 'Buscar eventos que contengan este texto' },
      },
    },
  },
  {
    name: 'crear_evento',
    description: 'Crea un evento en el Google Calendar de Cristian. ANTES dile qué vas a agendar (título, día, hora) y espera que diga que sí; solo entonces llama con confirmado: true.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        inicio: { type: 'string', description: FECHA },
        fin: { type: 'string', description: FECHA },
        duracion_minutos: { type: 'integer', description: 'Si no hay hora de término (por defecto 60)' },
        todo_el_dia: { type: 'boolean' },
        descripcion: { type: 'string' },
        ubicacion: { type: 'string' },
        confirmado: { type: 'boolean', description: 'true solo si Cristian ya dijo que sí a este evento exacto' },
      },
      required: ['titulo', 'inicio', 'confirmado'],
    },
  },
  {
    name: 'modificar_evento',
    description: 'Mueve o cambia un evento existente (busca su id con ver_agenda). Si cambias el inicio sin fin, conserva la duración. ANTES confirma el cambio con Cristian y llama con confirmado: true.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        titulo: { type: 'string' },
        inicio: { type: 'string', description: FECHA },
        fin: { type: 'string', description: FECHA },
        descripcion: { type: 'string' },
        ubicacion: { type: 'string' },
        confirmado: { type: 'boolean' },
      },
      required: ['id', 'confirmado'],
    },
  },
  {
    name: 'eliminar_evento',
    description: 'Elimina un evento del calendario (busca su id con ver_agenda). ANTES confirma con Cristian y llama con confirmado: true.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, confirmado: { type: 'boolean' } },
      required: ['id', 'confirmado'],
    },
  },
], {
  ver_agenda: verAgenda,
  crear_evento: crearEvento,
  modificar_evento: modificarEvento,
  eliminar_evento: eliminarEvento,
});

module.exports = {
  configurado, estado, crearEnlace, urlAutorizacion, recibirCallback, desconectar, agendaParaContexto, redirectUri, tokenAcceso,
};
