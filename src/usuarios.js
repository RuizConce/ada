// Personas con acceso a ADA: Cristian (administrador) y los invitados de la prueba.
const crypto = require('crypto');
const { qPrincipal, prepararInvitado } = require('./db');

const secreto = () => process.env.ADA_PASSWORD || '';

function igualSeguro(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function hashClave(clave) {
  const sal = crypto.randomBytes(16).toString('hex');
  return `${sal}:${crypto.scryptSync(clave, sal, 32).toString('hex')}`;
}

function claveCorrecta(clave, hash) {
  if (!hash) return false;
  const [sal, h] = hash.split(':');
  return igualSeguro(crypto.scryptSync(clave, sal, 32).toString('hex'), h);
}

// Claves fáciles de dictar: sin letras que se confunden (0/O, 1/l).
function generarClave() {
  const letras = 'abcdefghjkmnpqrstuvwxyz';
  const num = '23456789';
  const elegir = (s, n) => Array.from({ length: n }, () => s[crypto.randomInt(s.length)]).join('');
  return `${elegir(letras, 4)}-${elegir(num, 4)}`;
}

// ---------- Sesiones ----------

const firma = (id, version) => crypto.createHmac('sha256', secreto()).update(`ada-sesion-v2:${id}:${version}`).digest('hex');
const crearToken = (u) => `${u.id}.${u.version}.${firma(u.id, u.version)}`;

const cache = new Map(); // id → { u, hasta }
async function porId(id) {
  const c = cache.get(id);
  if (c && c.hasta > Date.now()) return c.u;
  const [u] = await qPrincipal('SELECT id, nombre, admin, activo, version FROM usuarios WHERE id = ?', [id]);
  cache.set(id, { u: u || null, hasta: Date.now() + 30 * 1000 });
  return u || null;
}

async function desdeToken(token) {
  if (!secreto()) return null;
  const [id, version, f] = String(token || '').split('.');
  const n = parseInt(id, 10);
  if (!n || !f || !igualSeguro(f, firma(n, version))) return null;
  const u = await porId(n);
  if (!u || !u.activo || String(u.version) !== version) return null;
  return { id: u.id, nombre: u.nombre, admin: !!u.admin };
}

const limpiarNombre = (t) => String(t || '').replace(/[<>"`\n\r]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

// Ingreso con nombre y clave. El nombre es como ADA llamará a la persona.
async function ingresar(nombreDado, clave) {
  const nombre = limpiarNombre(nombreDado);
  if (!nombre) throw Object.assign(new Error('Escribe tu nombre'), { status: 400 });
  if (!clave) throw Object.assign(new Error('Escribe tu clave'), { status: 400 });
  let u = null;
  if (secreto() && igualSeguro(clave, secreto())) {
    [u] = await qPrincipal('SELECT * FROM usuarios WHERE id = 1');
  } else {
    const filas = await qPrincipal('SELECT * FROM usuarios WHERE id <> 1 AND activo = 1 AND clave_hash IS NOT NULL');
    u = filas.find((x) => claveCorrecta(String(clave).trim().toLowerCase(), x.clave_hash)) || null;
  }
  if (!u) return null;
  if (u.id !== 1) await prepararInvitado(u.id);
  await qPrincipal('UPDATE usuarios SET nombre = ?, ultimo_ingreso = ? WHERE id = ?', [nombre, new Date(), u.id]);
  cache.delete(u.id);
  return { token: crearToken(u), usuario: { id: u.id, nombre, admin: !!u.admin } };
}

// ---------- Administración (solo Cristian) ----------

async function listar() {
  const filas = await qPrincipal('SELECT id, nombre, nota, activo, creado_en, ultimo_ingreso FROM usuarios WHERE id <> 1 ORDER BY id');
  return filas.map((u) => ({ ...u, activo: !!u.activo }));
}

async function crear({ nota } = {}) {
  const clave = generarClave();
  const etiqueta = limpiarNombre(nota) || null;
  const r = await qPrincipal(
    'INSERT INTO usuarios (nombre, clave_hash, nota, creado_en) VALUES (?, ?, ?, ?)',
    [etiqueta || 'Invitado', hashClave(clave), etiqueta, new Date()]
  );
  await prepararInvitado(r.insertId);
  return { id: r.insertId, clave, nota: etiqueta };
}

// Nueva clave: la anterior deja de servir y se cierran sus sesiones.
async function nuevaClave(id) {
  const clave = generarClave();
  const r = await qPrincipal('UPDATE usuarios SET clave_hash = ?, version = version + 1, activo = 1 WHERE id = ? AND id <> 1', [hashClave(clave), id]);
  if (!r.affectedRows) throw new Error('No existe esa persona');
  cache.delete(id);
  return { id, clave };
}

async function cambiarActivo(id, activo) {
  const r = await qPrincipal('UPDATE usuarios SET activo = ?, version = version + 1 WHERE id = ? AND id <> 1', [activo ? 1 : 0, id]);
  if (!r.affectedRows) throw new Error('No existe esa persona');
  cache.delete(id);
  return { ok: true, activo: !!activo };
}

module.exports = { ingresar, desdeToken, listar, crear, nuevaClave, cambiarActivo, generarClave };
