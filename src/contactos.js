// Encontrar a la persona correcta aunque se diga distinto: "mi señora", "Iñora", "inora",
// "la Paoli", "Daniela de la escuela". Busca en los contactos de ADA (con alias y relación)
// y en los de Google (libreta y personas con las que se ha escrito por correo).
const { q, usuario } = require('./db');

// ---------- Normalización ----------

function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // tildes y ñ → n
    .replace(/[^a-z0-9@.+\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Palabras que no ayudan a identificar ("mi señora", "la Paola", "don Sergio").
const VACIAS = new Set(['mi', 'mis', 'el', 'la', 'los', 'las', 'don', 'dona', 'sr', 'sra', 'senor', 'de', 'del', 'a', 'al', 'con', 'para']);
const palabras = (t) => normalizar(t).split(' ').filter((w) => w && !VACIAS.has(w));

// Relaciones dichas de distintas formas → una sola clave.
const RELACIONES = {
  pareja: ['senora', 'esposa', 'esposo', 'mujer', 'marido', 'pareja', 'polola', 'pololo', 'novia', 'novio', 'conviviente', 'amor', 'gorda', 'gordo', 'negra', 'flaca'],
  madre: ['mama', 'madre', 'vieja', 'mami'],
  padre: ['papa', 'padre', 'viejo', 'papi'],
  hijo: ['hijo', 'hija', 'hijos'],
  hermano: ['hermano', 'hermana', 'hermanos'],
  suegro: ['suegro', 'suegra'],
  abuelo: ['abuelo', 'abuela', 'tata', 'lela'],
  tio: ['tio', 'tia'],
  primo: ['primo', 'prima'],
  jefe: ['jefe', 'jefa'],
  socio: ['socio', 'socia'],
  amigo: ['amigo', 'amiga'],
};
const RELACION_DE = {};
for (const [clave, formas] of Object.entries(RELACIONES)) for (const f of formas) RELACION_DE[f] = clave;
const relacionesEn = (t) => new Set(palabras(t).map((w) => RELACION_DE[w]).filter(Boolean));

// Versión "fonética" en español: suena igual → se escribe igual.
function fonetica(w) {
  return w
    .replace(/h/g, '')
    .replace(/v/g, 'b')
    .replace(/z/g, 's')
    .replace(/c([ei])/g, 's$1')
    .replace(/qu/g, 'k').replace(/c/g, 'k')
    .replace(/ll/g, 'y').replace(/i(?=[aeou])/g, 'y')
    .replace(/x/g, 'ks')
    .replace(/(.)\1+/g, '$1');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Parecido entre dos palabras (0 a 1).
function parecido(a, b) {
  if (a === b) return 1;
  if (a.length >= 3 && b.startsWith(a)) return 0.9; // "pao" → "paola"
  const fa = fonetica(a); const fb = fonetica(b);
  if (fa === fb) return 0.95; // "inora" ~ "iñora", "yanet" ~ "janet" no, pero "silbia" ~ "silvia" sí
  const d = Math.min(levenshtein(a, b), levenshtein(fa, fb));
  const largo = Math.max(a.length, b.length);
  if (largo <= 3) return d === 0 ? 1 : 0;
  return Math.max(0, 1 - d / largo) * (d <= 2 ? 0.92 : 0.7);
}

// Qué tan bien calza lo que dijo Cristian con un contacto (0 a 1).
function puntaje(consulta, c) {
  const pedidas = palabras(consulta);
  const relPedidas = relacionesEn(consulta);
  let mejor = 0;
  // Relación: "mi señora" ↔ relación "esposa"
  if (relPedidas.size) {
    const relContacto = relacionesEn(`${c.relacion || ''} ${(c.alias || []).join(' ')}`);
    for (const r of relPedidas) if (relContacto.has(r)) mejor = Math.max(mejor, 0.97);
  }
  const textos = [c.nombre, ...(c.alias || []), c.organizacion, c.email && c.email.split('@')[0]].filter(Boolean);
  let nombresPedidos = pedidas.filter((w) => !RELACION_DE[w]);
  let factor = 1;
  // "mi señora" sin relación guardada: puede ser un apodo parecido ("Mi Iñora"); se compara con menos peso.
  if (!nombresPedidos.length) { nombresPedidos = pedidas; factor = 0.9; }
  if (!nombresPedidos.length) return mejor;
  for (const t of textos) if (normalizar(t) === nombresPedidos.join(' ')) return Math.max(mejor, factor);
  // Todas las palabras del contacto juntas (nombre, apodos, organización): "Daniela de la escuela".
  const pozo = [...new Set(textos.flatMap(palabras))];
  if (pozo.length) {
    const s = nombresPedidos.map((w) => Math.max(...pozo.map((d) => parecido(w, d))));
    const prom = s.reduce((x, y) => x + y, 0) / s.length;
    mejor = Math.max(mejor, (Math.min(...s) >= 0.6 ? prom : prom * 0.6) * factor);
  }
  return mejor;
}

// ---------- Google Contacts ----------

const cacheGoogle = new Map(); // por persona: { lista, hasta, error }
async function contactosGoogle() {
  const G = require('./google');
  const uid = usuario().id;
  const c = cacheGoogle.get(uid);
  if (c && c.hasta > Date.now()) return c;
  // Sin permiso no se guarda en caché: apenas reconecte, ya funciona.
  if (!(await G.tienePermiso('contacts'))) return { lista: [], error: 'sin permiso de Contactos (reconectar Google en Ajustes)' };
  const token = await G.tokenAcceso();
  const pedir = async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((d.error && d.error.message) || `People API respondió ${res.status}`);
    return d;
  };
  const lista = [];
  let error = null;
  try {
    let pagina = '';
    for (let i = 0; i < 4; i++) {
      const d = await pedir(`https://people.googleapis.com/v1/people/me/connections?personFields=names,nicknames,emailAddresses,phoneNumbers,organizations,relations&pageSize=1000&sortOrder=LAST_MODIFIED_DESCENDING${pagina ? `&pageToken=${pagina}` : ''}`);
      for (const p of d.connections || []) lista.push(dePeople(p, 'Google Contactos'));
      if (!d.nextPageToken) break;
      pagina = d.nextPageToken;
    }
    // Personas con las que se ha escrito por correo aunque no estén guardadas.
    if (await G.tienePermiso('contacts.other')) {
      const d = await pedir('https://people.googleapis.com/v1/otherContacts?readMask=names,emailAddresses,phoneNumbers&pageSize=1000');
      for (const p of d.otherContacts || []) lista.push(dePeople(p, 'Gmail (le has escrito)'));
    }
  } catch (e) {
    error = /has not been used|disabled/i.test(e.message)
      ? 'falta habilitar la People API en Google Cloud'
      : e.message;
  }
  const r = { lista: lista.filter((x) => x.nombre || x.email), error, hasta: Date.now() + (error ? 60 : 15 * 60) * 1000 };
  cacheGoogle.set(uid, r);
  return r;
}

function dePeople(p, fuente) {
  const nombre = (p.names && p.names[0] && p.names[0].displayName) || '';
  const email = p.emailAddresses && p.emailAddresses[0] && p.emailAddresses[0].value;
  return {
    fuente,
    nombre: nombre || email,
    alias: (p.nicknames || []).map((n) => n.value),
    email: email || null,
    telefono: p.phoneNumbers && p.phoneNumbers[0] ? p.phoneNumbers[0].value : null,
    organizacion: p.organizations && p.organizations[0] ? p.organizations[0].name : null,
    relacion: (p.relations || []).map((r) => r.type).join(', ') || null,
  };
}

// ---------- Búsqueda ----------

const aLista = (alias) => String(alias || '').split('|').map((s) => s.trim()).filter(Boolean);

async function contactosLocales() {
  const rows = await q('SELECT id, nombre, alias, relacion, organizacion, email, telefono, notas FROM contactos');
  return rows.map((r) => ({ ...r, alias: aLista(r.alias), fuente: 'ADA' }));
}

// Devuelve candidatos ordenados. confianza: 'alta' (uno claro), 'varios' (preguntar) o 'ninguno'.
async function encontrar(consulta, { conGoogle = true, limite = 5 } = {}) {
  const locales = await contactosLocales();
  const google = conGoogle ? await contactosGoogle().catch((e) => ({ lista: [], error: e.message })) : { lista: [] };
  const vistos = new Set();
  const candidatos = [];
  for (const c of [...locales, ...google.lista]) {
    const clave = normalizar(c.email || c.telefono || c.nombre);
    const p = puntaje(consulta, c);
    if (p < 0.55) continue;
    // Si ya está en ADA (mismo correo o teléfono), no se repite el de Google.
    if (c.fuente !== 'ADA' && vistos.has(clave)) continue;
    if (c.fuente === 'ADA') vistos.add(clave);
    candidatos.push({ ...c, puntaje: Math.round(p * 100) / 100 });
  }
  candidatos.sort((a, b) => b.puntaje - a.puntaje || (a.fuente === 'ADA' ? -1 : 1));
  const top = candidatos.slice(0, limite);
  let confianza = 'ninguno';
  if (top.length) {
    const claro = top[0].puntaje >= 0.85 && (!top[1] || top[0].puntaje - top[1].puntaje >= 0.12);
    confianza = claro ? 'alta' : 'varios';
  }
  return { confianza, candidatos: top, google_contactos: google.error ? `no disponible: ${google.error}` : (conGoogle ? 'consultado' : 'no consultado') };
}

module.exports = { normalizar, puntaje, encontrar, aLista, contactosGoogle, RELACION_DE };
