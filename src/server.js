// Servidor HTTP de ADA.
if (!process.env.TZ) process.env.TZ = 'America/Santiago';

const path = require('path');
const express = require('express');
const { q, initDb, comoUsuario, prepararInvitado } = require('./db');
const U = require('./usuarios');
const H = require('./herramientas');
const Metricas = require('./metricas');
const Avisos = require('./avisos');
const { MODELO_RAPIDO, MODELO_PROFUNDO } = require('./claude');
const Agenda = require('./agenda');
const Lab = require('./lab');
const { conversar, construirContexto, cancelar } = require('./ada');
const E = require('./encargos');
const C = require('./conversaciones');
const Voz = require('./voz');
const G = require('./google');
const A = require('./archivos');

const app = express();
app.set('trust proxy', 1); // Railway está detrás de un proxy
app.use(express.json({ limit: '200kb' }));
// Versión del servidor: si cambia (nuevo deploy), la app abierta en el teléfono se recarga sola cuando está libre.
const VERSION = process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now());
app.use('/api', (req, res, next) => { res.set('X-ADA-Version', VERSION); next(); });
// La app (html, js, css) se revalida siempre: así una versión nueva llega en la siguiente apertura y no queda
// una app.js vieja en la caché del teléfono hasta por una hora. Íconos y demás sí se guardan 1 hora.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h',
  setHeaders: (res, ruta) => { if (/\.(html|js|css|json)$/.test(ruta)) res.set('Cache-Control', 'no-cache'); },
}));

// ---------- Acceso: cada persona con su nombre y su clave ----------

const intentos = new Map(); // freno básico a fuerza bruta
app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  const reg = intentos.get(ip) || { n: 0, hasta: 0 };
  if (reg.hasta > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  if (!process.env.ADA_PASSWORD) return res.status(500).json({ error: 'Falta configurar ADA_PASSWORD' });
  const { nombre, password } = req.body || {};
  try {
    const r = await U.ingresar(nombre, password);
    if (r) {
      intentos.delete(ip);
      return res.json(r);
    }
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  reg.n += 1;
  if (reg.n >= 5) { reg.hasta = Date.now() + 10 * 60 * 1000; reg.n = 0; }
  intentos.set(ip, reg);
  res.status(401).json({ error: 'Clave incorrecta' });
});

// Identifica a la persona y ejecuta todo lo que sigue con SU base de datos.
async function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  let u = null;
  try { u = await U.desdeToken(token); } catch (_) {}
  if (!u) return res.status(401).json({ error: 'No autorizado' });
  req.usuario = u;
  if (u.id !== 1) {
    try { await prepararInvitado(u.id); } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  comoUsuario(u, next);
}

function soloAdmin(req, res, next) {
  if (req.usuario && req.usuario.admin) return next();
  res.status(403).json({ error: 'Solo Cristian puede hacer esto' });
}

// ---------- API ----------

// Si el service worker aún no está activo, lo compartido no se puede leer: se abre la app igual.
app.post('/compartir', (req, res) => res.redirect(303, '/?compartido=0'));

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Freno de gasto ----------
// 1) ADA_PAUSA=si en Railway: ADA no llama a Claude (interruptor de emergencia).
// 2) Ráfagas: más de 8 turnos en 2 minutos, o el mismo mensaje repetido, se frenan (p. ej. la app
//    escuchando música o una TV y mandando cada frase a Claude).
const turnosRecientes = new Map(); // persona → [{t, texto}]
function freno(req, res, next) {
  if (process.env.ADA_PAUSA === 'si') return res.status(503).json({ error: 'ADA está en pausa (ADA_PAUSA=si en Railway).', freno: true });
  const texto = String((req.body && req.body.mensaje) || '').trim();
  const uid = req.usuario ? req.usuario.id : 0;
  const ahora = Date.now();
  const lista = (turnosRecientes.get(uid) || []).filter((x) => ahora - x.t < 2 * 60 * 1000);
  const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]/g, '').replace(/\s+/g, ' ').trim();
  const limite = parseInt(process.env.ADA_TURNOS_2MIN, 10) || 8;
  if (lista.length >= limite) {
    console.warn(`Freno u${uid}: ${lista.length} turnos en 2 minutos`);
    return res.status(429).json({ error: 'Pausé la conversación: llegaron demasiados mensajes seguidos (¿música o TV cerca?). Toca para seguir.', freno: true });
  }
  if (texto && lista.some((x) => ahora - x.t < 60 * 1000 && norm(x.texto) === norm(texto))) {
    return res.status(429).json({ error: 'Ese mensaje ya me llegó recién; no lo repito.', freno: true });
  }
  lista.push({ t: ahora, texto });
  turnosRecientes.set(uid, lista);
  next();
}

app.post('/api/chat', auth, unTrabajoALaVez, freno, async (req, res) => {
  const texto = String((req.body && req.body.mensaje) || '').trim();
  if (!texto) return res.status(400).json({ error: 'Mensaje vacío' });
  if (texto.length > 24000) return res.status(400).json({ error: 'Mensaje demasiado largo' });
  try {
    res.json(await conversar(texto, {
      voz: req.body.voz === true,
      conversacionId: parseInt(req.body.conversacion_id, 10) || null,
    }));
  } catch (e) {
    console.error('Error en /api/chat:', e);
    if (e.status === 409) return res.status(409).json({ error: e.message });
    const status = e.status === 529 || e.status === 503 ? 503 : 500;
    res.status(status).json({ error: status === 503 ? 'Claude está saturado, intenta en un momento.' : `Error: ${e.message}` });
  }
});

// Respuesta en tiempo real (Server-Sent Events): texto a medida que se genera, estados y documentos.
function unTrabajoALaVez(req, res, next) {
  if (require('./ada').trabajando(req.usuario.id)) {
    return res.status(409).json({ error: 'Todavía estoy trabajando en tu mensaje anterior. Espera a que termine o tócame Detener.', freno: true });
  }
  next();
}
app.post('/api/chat/stream', auth, unTrabajoALaVez, freno, async (req, res) => {
  const texto = String((req.body && req.body.mensaje) || '').trim();
  if (!texto) return res.status(400).json({ error: 'Mensaje vacío' });
  if (texto.length > 24000) return res.status(400).json({ error: 'Mensaje demasiado largo' });
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const enviarEvento = (tipo, datos) => res.write(`event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`);
  // Mantiene viva la conexión mientras ADA piensa o busca.
  const latido = setInterval(() => res.write(': latido\n\n'), 15000);
  try {
    const acuse = typeof req.body.acuse === 'string' ? req.body.acuse.slice(0, 20).replace(/[^\p{L} .,]/gu, '') : null;
    const r = await conversar(texto, {
      voz: req.body.voz === true,
      acuse,
      conversacionId: parseInt(req.body.conversacion_id, 10) || null,
      // Tarjetas que la app abierta sabe dibujar (una versión antigua no las declara).
      tarjetas: Array.isArray(req.body.tarjetas) ? req.body.tarjetas.map(String).slice(0, 10) : [],
    }, enviarEvento);
    enviarEvento('fin', r);
    // Encargo largo terminado: aviso al teléfono y resultado a su propio correo.
    require('./fintarea').avisarFin(texto, r).catch((e) => console.error('Fin de tarea:', e.message));
  } catch (e) {
    console.error('Error en /api/chat/stream:', e);
    const saturado = e.status === 529 || e.status === 503;
    enviarEvento('error', { error: saturado ? 'Claude está saturado, intenta en un momento.' : `Error: ${e.message}` });
  } finally {
    clearInterval(latido);
    res.end();
  }
});

// Audio de una frase con la voz neuronal configurada. 204 = usar la voz del teléfono.
// Al empezar a escuchar, el teléfono avisa: se prepara el contexto (agenda, correo) mientras la persona habla.
app.post('/api/precalentar', auth, (req, res) => {
  construirContexto().catch(() => {});
  res.json({ ok: true });
});

app.post('/api/metricas', auth, (req, res) => {
  const b = req.body || {};
  const num = (x) => (Number.isFinite(x) && x >= 0 && x < 120000 ? Math.round(x) : undefined);
  Metricas.completarTurno(parseInt(b.conversacion_id, 10) || null, { hasta_audio_ms: num(b.hasta_audio_ms), tts_ms: num(b.tts_ms) });
  res.json({ ok: true });
});

app.post('/api/voz', auth, async (req, res) => {
  const texto = String((req.body && req.body.texto) || '').trim();
  if (!texto) return res.status(400).json({ error: 'Texto vacío' });
  try {
    const vozPrueba = typeof req.body.voz === 'string' && /^([a-z]{2}-[A-Z]{2}-[\w-]+|aura-[\w-]+)$/.test(req.body.voz) ? req.body.voz : undefined;
    const audio = await Voz.sintetizar(texto, vozPrueba, req.body.proveedor === 'deepgram' ? 'deepgram' : undefined);
    if (!audio) return res.status(204).end();
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    res.send(audio);
  } catch (e) {
    console.error('Error en /api/voz:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/historial', auth, async (req, res) => {
  try {
    const rows = await q('SELECT id, rol, contenido, creado_en FROM mensajes ORDER BY id DESC LIMIT 60');
    res.json(rows.reverse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mensajes que ADA propuso y esperan el botón de Cristian.
app.get('/api/autorizaciones', auth, async (req, res) => {
  try {
    res.json(await E.autorizacionesPendientes());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/acciones/:id', auth, async (req, res) => {
  const { decision, contenido, conversacion_id: convId, asunto, via } = req.body || {};
  try {
    res.json(await E.resolverAccion(parseInt(req.params.id, 10), decision, contenido, parseInt(convId, 10) || null, { asunto, via }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Archivo de conversaciones y documentos ----------

const envolver = (fn) => async (req, res) => {
  try {
    const r = await fn(req);
    if (r === null || r === undefined) return res.status(404).json({ error: 'No encontrado' });
    res.json(r);
  } catch (e) {
    const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500) console.error(e);
    res.status(status).json({ error: e.message });
  }
};

app.get('/api/carpetas', auth, envolver(() => C.carpetas()));
app.get('/api/conversaciones', auth, envolver((req) => C.listar({ proyecto_id: req.query.proyecto, texto: req.query.q })));
app.get('/api/conversaciones/:id', auth, envolver((req) => C.detalle(parseInt(req.params.id, 10))));
// ADA fue interrumpida: se anota qué alcanzó a escuchar, para que no lo repita ni dé por dicho lo demás.
app.post('/api/conversaciones/:id/interrumpida', auth, envolver(async (req) => {
  const escuchado = String((req.body || {}).escuchado || '').slice(0, 1500);
  const [m] = await q("SELECT id, contenido FROM mensajes WHERE conversacion_id = ? AND rol = 'assistant' ORDER BY id DESC LIMIT 1", [parseInt(req.params.id, 10)]);
  if (!m || m.contenido.includes('[Te interrumpió')) return { ok: false };
  const nota = escuchado ? `[Te interrumpió; alcanzó a escuchar solo: «${escuchado}»]` : '[Te interrumpió antes de que alcanzaras a hablar]';
  await q('UPDATE mensajes SET contenido = ? WHERE id = ?', [`${m.contenido}\n${nota}`, m.id]);
  return { ok: true };
}));

app.post('/api/conversaciones/:id/cerrar', auth, envolver((req) => C.cerrar(parseInt(req.params.id, 10))));
app.post('/api/conversaciones/:id/proyecto', auth,
  envolver((req) => C.moverConversacion(parseInt(req.params.id, 10), (req.body || {}).proyecto || null)));
app.get('/api/documentos/:id', auth, envolver((req) => C.obtenerDocumento(parseInt(req.params.id, 10))));
// ---------- Descargas por enlace temporal (teléfono) ----------
const Descargas = require('./descargas');
// Qué se puede descargar y cómo se obtiene (siempre en el contexto de la persona dueña del enlace).
const DESCARGABLES = {
  archivo: async (id) => {
    const a = await A.obtenerArchivo(parseInt(id, 10));
    return a && { nombre: a.nombre, mime: a.mime, datos: a.datos };
  },
  auditoria: async (id, u) => {
    if (!u.admin) return null;
    const x = await Auditoria.excel(id);
    return { nombre: x.nombre, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', datos: x.datos };
  },
  auditoria_informe: async (id, u) => {
    if (!u.admin) return null;
    const x = await Auditoria.informe(id);
    return { nombre: x.nombre, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', datos: x.datos };
  },
  documento: async (id) => {
    const d = await C.obtenerDocumento(parseInt(id, 10));
    if (!d) return null;
    const nombre = `${String(d.titulo || 'documento').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'documento'}.md`;
    return { nombre, mime: 'text/markdown; charset=utf-8', datos: Buffer.from(`# ${d.titulo}\n\n${d.contenido}`, 'utf8') };
  },
};
app.post('/api/descargas', auth, async (req, res) => {
  try {
    const { tipo, id } = req.body || {};
    if (!DESCARGABLES[tipo] || !id) return res.status(400).json({ error: 'Descarga inválida' });
    // Se comprueba ahora que existe y que es de esta persona; si no, no se entrega enlace.
    const f = await DESCARGABLES[tipo](id, req.usuario);
    if (!f) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ...Descargas.crear(req.usuario, tipo, id), nombre: f.nombre });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/descargas/:token', (req, res) => {
  const e = Descargas.leer(req.params.token);
  if (!e) return res.status(410).type('text/plain; charset=utf-8').send('Este enlace de descarga venció. Vuelve a ADA y toca Descargar otra vez.');
  comoUsuario(e.usuario, async () => {
    try {
      if (e.usuario.id !== 1) await prepararInvitado(e.usuario.id);
      const f = await DESCARGABLES[e.tipo](e.id, e.usuario);
      if (!f) return res.status(404).type('text/plain; charset=utf-8').send('No encontrado');
      const ascii = f.nombre.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'archivo';
      res.set({
        'Content-Type': f.mime,
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.nombre)}`,
        'Content-Length': f.datos.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.send(f.datos);
    } catch (x) { res.status(x.status || 500).type('text/plain; charset=utf-8').send(`No se pudo descargar: ${x.message}`); }
  });
});
app.get('/api/archivos/:id', auth, async (req, res) => {
  try {
    const a = await A.obtenerArchivo(parseInt(req.params.id, 10));
    if (!a) return res.status(404).json({ error: 'No encontrado' });
    res.set({
      'Content-Type': a.mime,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.nombre)}`,
      'Cache-Control': 'no-store',
    });
    res.send(a.datos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Ajustes y Google Calendar ----------

app.get('/api/yo', auth, (req, res) => res.json(req.usuario));

// Personas de la prueba (solo Cristian).
app.get('/api/usuarios', auth, soloAdmin, envolver(() => U.listar()));
app.get('/api/google/contactos/prueba', auth, envolver(async () => {
  const Ct = require('./contactos');
  const r = await Ct.contactosGoogle({ fresco: true });
  return { total: r.lista.length, error: r.error || null, ejemplos: r.lista.filter((x) => x.nombre && !x.nombre.includes('@')).slice(0, 3).map((x) => x.nombre) };
}));
// ---------- Modo reunión ----------
const Reuniones = require('./reuniones');
app.get('/api/reuniones', auth, envolver(() => Reuniones.listar()));
app.post('/api/reuniones', auth, envolver((req) => Reuniones.crear(req.body || {})));
app.post('/api/reuniones/traducir', auth, envolver((req) => Reuniones.traducir((req.body || {}).texto)));
app.post('/api/reuniones/:id/segmentos', auth, envolver((req) => Reuniones.agregar(parseInt(req.params.id, 10), (req.body || {}).segmentos)));
app.post('/api/reuniones/:id/terminar', auth, envolver((req) => Reuniones.terminar(parseInt(req.params.id, 10), req.body || {})));
// Detener de verdad el trabajo en curso (no solo cerrar la pantalla).
app.post('/api/cancelar', auth, envolver((req) => cancelar(req.usuario.id)));
// Gasto detallado: por turno (cada mensaje) con sus llamadas a Claude y herramientas; solo Cristian.
const Registro = require('./registro');
app.get('/api/gasto/turnos', auth, soloAdmin, envolver((req) => {
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(req.query.dia || '') ? req.query.dia : null;
  const desde = dia ? new Date(`${dia}T00:00:00`) : new Date(Date.now() - 24 * 3600 * 1000);
  const hasta = dia ? new Date(desde.getTime() + 24 * 3600 * 1000) : new Date(Date.now() + 60000);
  return Registro.porTurno({ desde, hasta, usuarioId: parseInt(req.query.usuario, 10) || null });
}));
app.get('/api/gasto/turnos/:id', auth, soloAdmin, envolver((req) => Registro.detalleTurno(String(req.params.id).slice(0, 36))));
app.get('/api/gasto/encargos', auth, soloAdmin, envolver(() => Registro.porEncargo()));
// Exportación privada del diagnóstico (solo Cristian; sin documentos, datos personales ni claves).
const Diagnostico = require('./diagnostico');
app.get('/api/diagnostico/conversaciones', auth, soloAdmin, envolver((req) => {
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(req.query.dia || '') ? req.query.dia : new Date().toISOString().slice(0, 10);
  return Diagnostico.conversacionesDelDia(dia);
}));
app.get('/api/diagnostico/conversaciones/:id', auth, soloAdmin, envolver((req) =>
  Diagnostico.exportar(parseInt(req.params.id, 10), { conTexto: req.query.texto === '1', conRegistros: req.query.registros === '1', usuarioId: req.usuario.id })));
// ---------- Encargos complejos (Etapa 3; fase 3a: solo trabajos simulados, solo Cristian) ----------
const Trabajos = require('./trabajos');
// Fase 3c: auditoría mínima (1 documento de la carpeta de prueba, pocos requisitos aprobados, Excel verificado).
const Auditoria = require('./auditoria');
app.post('/api/auditorias/estimar', auth, soloAdmin, envolver((req) => Auditoria.estimacion(req.body || {})));
app.post('/api/auditorias', auth, soloAdmin, envolver((req) => Auditoria.crear(req.body || {})));
app.get('/api/auditorias', auth, soloAdmin, envolver(() => Auditoria.listar()));
app.post('/api/auditorias/propuestas/:id/aprobar', auth, soloAdmin, envolver((req) => Auditoria.aprobarPropuesta(req.params.id, req.body || {}, { ua: String(req.get('user-agent') || '').slice(0, 300) })));
app.get('/api/auditorias/propuestas/:id/constancia', auth, soloAdmin, envolver((req) => Auditoria.constancia(req.params.id)));
app.post('/api/auditorias/propuestas/:id/descartar', auth, soloAdmin, envolver((req) => Auditoria.descartarPropuesta(req.params.id)));
app.get('/api/auditorias/activas', auth, soloAdmin, envolver(() => Auditoria.activas()));
app.get('/api/auditorias/propuestas', auth, soloAdmin, envolver((req) => Auditoria.pendientes({ conversacionId: parseInt(req.query.conversacion_id, 10) || null })));
app.post('/api/auditorias/propuestas/:id/tarjeta', auth, soloAdmin, envolver((req) => Auditoria.marcarTarjeta(req.params.id, req.body || {})));
app.get('/api/auditorias/:id/avance', auth, soloAdmin, envolver((req) => Auditoria.avance(req.params.id)));
app.get('/api/auditorias/:id/excel', auth, soloAdmin, async (req, res) => {
  try {
    const x = await Auditoria.excel(req.params.id);
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${x.nombre}"` });
    res.send(x.datos);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/trabajos', auth, soloAdmin, envolver(() => Trabajos.listar()));
app.post('/api/trabajos', auth, soloAdmin, envolver((req) => Trabajos.crear(req.body || {})));
app.get('/api/trabajos/:id', auth, soloAdmin, envolver((req) => Trabajos.ver(req.params.id, { conResultado: req.query.resultado === '1' })));
for (const accion of ['aprobar', 'pausar', 'reanudar', 'cancelar', 'reintentar']) {
  app.post(`/api/trabajos/:id/${accion}`, auth, soloAdmin, envolver((req) => Trabajos[accion](req.params.id)));
}
app.post('/api/trabajos/:id/aprobar-paso', auth, soloAdmin, envolver((req) => Trabajos.aprobarPaso(req.params.id, { lista: (req.body || {}).lista })));
app.post('/api/auditorias/:id/borrar-extracciones', auth, soloAdmin, envolver((req) => Auditoria.borrarExtracciones(req.params.id)));
app.post('/api/trabajos/:id/ampliar', auth, soloAdmin, envolver((req) => Trabajos.ampliar(req.params.id, (req.body || {}).monto)));
// Cifrado: estado (sin revelar la clave) y recifrado tras rotar la clave.
const Cifrado = require('./cifrado');
app.get('/api/cifrado', auth, soloAdmin, envolver(() => Cifrado.estado()));
app.post('/api/cifrado/recifrar', auth, soloAdmin, envolver(() => Cifrado.recifrar([
  { tabla: 'trabajos', id: 'id', col: 'objetivo_cifrado' }, { tabla: 'trabajos', id: 'id', col: 'esperado_cifrado' },
  { tabla: 'trabajos', id: 'id', col: 'resultado_cifrado' }, { tabla: 'trabajo_pasos', id: 'id', col: 'entrada_cifrada' },
  { tabla: 'trabajo_pasos', id: 'id', col: 'resultado_cifrado' }, { tabla: 'extracciones', id: 'id', col: 'texto_cifrado', alFallar: "UPDATE extracciones SET texto_cifrado = NULL, estado = 'invalidada', motivo = 'clave_distinta' WHERE id = ?" },
])));
// Fase 3b: extracciones de documentos (solo la cuenta principal). Nunca devuelven texto de documentos.
const Extracciones = require('./extracciones');
app.get('/api/extracciones', auth, soloAdmin, envolver(async () => ({ ...(await Extracciones.resumen()), archivos: await Extracciones.listar() })));
// Cierre de la Fase 3b (solo lectura de metadatos y eventos; la lectura de verificación no usa IA).
app.post('/api/extracciones/cierre/leer', auth, soloAdmin, envolver((req) => require('./drive').lecturaVerificacion((req.body || {}).archivo_id)));
app.get('/api/extracciones/cierre', auth, soloAdmin, envolver(async (req) => {
  let vivas = null;
  try { vivas = (await require('./drive').copiasTemporalesVivas()).length; } catch (_) {}
  return Extracciones.cierre({ archivoId: req.query.archivo, desde: req.query.desde, copiasVivas: vivas });
}));
app.post('/api/extracciones/consentimiento', auth, soloAdmin, envolver((req) => Extracciones.responderConsentimiento(!!(req.body || {}).acepto)));
app.delete('/api/extracciones', auth, soloAdmin, envolver(() => Extracciones.borrarTodo()));
app.delete('/api/extracciones/:archivo', auth, soloAdmin, envolver((req) => Extracciones.borrarArchivo(req.params.archivo)));
app.get('/api/extracciones/metricas', auth, soloAdmin, envolver((req) => Extracciones.metricas({
  desde: req.query.desde, hasta: req.query.hasta, conversacionId: parseInt(req.query.conversacion, 10) || null, turnoId: req.query.turno || null, trabajoId: req.query.trabajo || null,
})));
app.get('/api/extracciones/verificacion', auth, soloAdmin, envolver((req) => Extracciones.verificacion({ desde: req.query.desde })));
app.get('/api/extracciones/eventos', auth, soloAdmin, envolver((req) => Extracciones.eventos({ desde: req.query.desde, limite: req.query.limite })));
app.post('/api/extracciones/temporales/reintentar', auth, soloAdmin, envolver(() => require('./drive').reintentarTemporales()));
app.get('/api/consumo', auth, soloAdmin, envolver(() => require('./consumo').resumen()));
app.post('/api/usuarios', auth, soloAdmin, envolver((req) => U.crear(req.body || {})));
app.post('/api/usuarios/:id/clave', auth, soloAdmin, envolver((req) => U.nuevaClave(parseInt(req.params.id, 10))));
app.post('/api/usuarios/:id/activo', auth, soloAdmin, envolver((req) => U.cambiarActivo(parseInt(req.params.id, 10), !!(req.body || {}).activo)));

// ---------- Avisos al teléfono ----------
app.get('/api/push/clave', auth, envolver(async () => ({ publicKey: (await Avisos.clavesVapid()).publicKey })));
app.post('/api/push/suscribir', auth, envolver((req) => Avisos.suscribir((req.body || {}).suscripcion, (req.body || {}).dispositivo)));
app.post('/api/push/desuscribir', auth, envolver((req) => Avisos.desuscribir((req.body || {}).endpoint)));
app.post('/api/push/probar', auth, envolver(async (req) => {
  const r = await Avisos.enviar({ titulo: 'ADA', cuerpo: `Así te voy a avisar, ${req.usuario.nombre}. ✓`, url: '/', tag: 'prueba' });
  if (!r.dispositivos) throw new Error('Este teléfono todavía no tiene los avisos activados');
  return r;
}));

// ---------- Laboratorio de voz (solo Cristian, para comparar prototipos) ----------
app.get('/api/lab/estado', auth, soloAdmin, envolver(() => Lab.configurado()));
app.post('/api/lab/realtime/token', auth, soloAdmin, envolver((req) => Lab.tokenRealtime(req.usuario, construirContexto)));
app.get('/api/lab/sesiones', auth, soloAdmin, envolver(() => Lab.resumenSesiones()));
app.post('/api/lab/sesiones', auth, soloAdmin, envolver((req) => Lab.guardarSesion(req.body || {})));

// ---------- Agenda visual ----------
app.get('/api/agenda', auth, envolver((req) => Agenda.semana({ desde: req.query.desde, dias: req.query.dias })));
app.post('/api/items/:id', auth, envolver(async (req) => {
  const estado = (req.body || {}).estado;
  if (!['hecho', 'abierto', 'descartado'].includes(estado)) throw new Error('Estado no válido');
  const r = await H.ejecutar('actualizar_item', { id: parseInt(req.params.id, 10), estado });
  if (r.error) throw new Error(r.error);
  return r;
}));

app.post('/api/preferencias', auth, envolver((req) => H.guardarPreferencias(req.body || {})));

app.get('/api/ajustes', auth, envolver(async (req) => ({
  usuario: req.usuario,
  preferencias: await H.preferencias(),
  tiempos: Metricas.resumen(),
  avisos: await Avisos.estado(),
  google: { ...(await G.estado()), redirect_uri: G.redirectUri(req) },
  voz: { proveedor: Voz.proveedor() },
  internet: process.env.ADA_INTERNET !== 'no',
  modelo: `${MODELO_RAPIDO()} (rápido) · ${MODELO_PROFUNDO()} (para pensar)`,
})));

app.get('/api/voces', auth, envolver(() => Voz.listarVoces()));
app.post('/api/voces', auth, envolver((req) => {
  const nombre = String((req.body || {}).voz || '');
  if (!/^([a-z]{2}-[A-Z]{2}-[\w-]+|aura-2-[a-z]+-es)$/.test(nombre)) throw new Error('Nombre de voz inválido');
  return Voz.elegirVoz(nombre);
}));

app.post('/api/google/enlace', auth, envolver(async (req) => {
  if (!G.configurado()) throw new Error('Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Railway');
  return { url: G.crearEnlace(req) };
}));

app.get('/api/google/conectar', (req, res) => {
  const url = G.configurado() ? G.urlAutorizacion(req, String(req.query.n || '')) : null;
  if (!url) return res.redirect('/?google=error&motivo=enlace');
  res.redirect(url);
});

app.get('/api/google/callback', async (req, res) => {
  try {
    await G.recibirCallback(req); // la persona viene firmada en el state
    res.redirect('/?google=ok');
  } catch (e) {
    console.error('Google callback:', e.message);
    res.redirect(`/?google=error&motivo=${encodeURIComponent(e.message)}`);
  }
});

app.post('/api/google/desconectar', auth, envolver(() => G.desconectar()));

app.get('/api/encargos', auth, async (req, res) => {
  try {
    res.json(await E.listarEncargos({ incluir_cerrados: req.query.todos === '1' }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/estado', auth, async (req, res) => {
  try {
    const c = await construirContexto();
    res.json({
      foco: c.foco_actual,
      urgentes: c.compromisos_urgentes_48h,
      alertas_hoy: c.alertas_hoy,
      proyectos: c.proyectos_activos.map((p) => p.replace(/(: .*| \(sin descripción\))$/, '')),
      encargos_activos: c.encargos_activos.length,
      encargos_por_revisar: c.encargos_para_revisar_ahora.length,
      por_autorizar: c.mensajes_esperando_tu_autorizacion.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Arranque ----------

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    const servidor = app.listen(PORT, () => console.log(`ADA escuchando en :${PORT} (TZ ${process.env.TZ})`));
    Lab.conectarOido(servidor); // oído en tiempo real del laboratorio (WebSocket)
    Avisos.iniciar();
    require('./registro').marcarInterrumpidos(); // turnos que el reinicio dejó a medias
    Trabajos.iniciar(); // ejecutor de encargos complejos (ADA_TRABAJOS=no lo apaga)
    // Extracciones vencidas (30 días): limpieza al arrancar y cada 6 horas (además, nunca se usan vencidas).
    const limpiar = () => comoUsuario({ id: 1, nombre: 'Cristian', admin: true }, () => Extracciones.limpiarVencidas()).catch((e) => console.error('Extracciones (limpieza):', e.message));
    limpiar();
    setInterval(limpiar, 6 * 3600e3).unref();
  })
  .catch((e) => {
    console.error('No pude iniciar la base de datos:', e.message);
    process.exit(1);
  });
