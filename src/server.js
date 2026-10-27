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
const { conversar, construirContexto } = require('./ada');
const E = require('./encargos');
const C = require('./conversaciones');
const Voz = require('./voz');
const G = require('./google');
const A = require('./archivos');

const app = express();
app.set('trust proxy', 1); // Railway está detrás de un proxy
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

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

app.post('/api/chat', auth, async (req, res) => {
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
    const status = e.status === 529 || e.status === 503 ? 503 : 500;
    res.status(status).json({ error: status === 503 ? 'Claude está saturado, intenta en un momento.' : `Error: ${e.message}` });
  }
});

// Respuesta en tiempo real (Server-Sent Events): texto a medida que se genera, estados y documentos.
app.post('/api/chat/stream', auth, async (req, res) => {
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
    }, enviarEvento);
    enviarEvento('fin', r);
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
    console.error(e);
    res.status(500).json({ error: e.message });
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
  if (!/^[a-z]{2}-[A-Z]{2}-[\w-]+$/.test(nombre)) throw new Error('Nombre de voz inválido');
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
  })
  .catch((e) => {
    console.error('No pude iniciar la base de datos:', e.message);
    process.exit(1);
  });
