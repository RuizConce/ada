// Servidor HTTP de ADA.
if (!process.env.TZ) process.env.TZ = 'America/Santiago';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { q, initDb } = require('./db');
const { conversar, construirContexto } = require('./ada');
const E = require('./encargos');

const app = express();
app.set('trust proxy', 1); // Railway está detrás de un proxy
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

// ---------- Autenticación simple (una sola persona) ----------

function tokenEsperado() {
  const pass = process.env.ADA_PASSWORD;
  if (!pass) return null;
  return crypto.createHmac('sha256', pass).update('ada-sesion-v1').digest('hex');
}

function igualSeguro(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const intentos = new Map(); // freno básico a fuerza bruta
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const reg = intentos.get(ip) || { n: 0, hasta: 0 };
  if (reg.hasta > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  const esperado = tokenEsperado();
  if (!esperado) return res.status(500).json({ error: 'Falta configurar ADA_PASSWORD' });
  const { password } = req.body || {};
  if (password && igualSeguro(password, process.env.ADA_PASSWORD)) {
    intentos.delete(ip);
    return res.json({ token: esperado });
  }
  reg.n += 1;
  if (reg.n >= 5) { reg.hasta = Date.now() + 10 * 60 * 1000; reg.n = 0; }
  intentos.set(ip, reg);
  res.status(401).json({ error: 'Contraseña incorrecta' });
});

function auth(req, res, next) {
  const esperado = tokenEsperado();
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (esperado && token && igualSeguro(token, esperado)) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// ---------- API ----------

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/chat', auth, async (req, res) => {
  const texto = String((req.body && req.body.mensaje) || '').trim();
  if (!texto) return res.status(400).json({ error: 'Mensaje vacío' });
  if (texto.length > 8000) return res.status(400).json({ error: 'Mensaje demasiado largo' });
  try {
    res.json(await conversar(texto));
  } catch (e) {
    console.error('Error en /api/chat:', e);
    const status = e.status === 529 || e.status === 503 ? 503 : 500;
    res.status(status).json({ error: status === 503 ? 'Claude está saturado, intenta en un momento.' : `Error: ${e.message}` });
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
  const { decision, contenido } = req.body || {};
  try {
    res.json(await E.resolverAccion(parseInt(req.params.id, 10), decision, contenido));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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
      proyectos: c.proyectos_activos,
      encargos_activos: c.encargos_activos.length,
      encargos_por_revisar: c.encargos_para_revisar_ahora.length,
      por_autorizar: c.mensajes_esperando_tu_autorizacion,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Arranque ----------

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`ADA escuchando en :${PORT} (TZ ${process.env.TZ})`)))
  .catch((e) => {
    console.error('No pude iniciar la base de datos:', e.message);
    process.exit(1);
  });
