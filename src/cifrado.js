// Cifrado de contenido sensible (textos de documentos, resultados y evidencias de trabajos).
// AES-256-GCM. La clave NUNCA está en el código, la base ni los logs: viene de la variable de Railway
// ADA_CLAVE_DATOS (una frase aleatoria larga, mínimo 40 caracteres, guardada también en un gestor de
// contraseñas). De esa frase se deriva la clave real con HKDF-SHA256.
//
// Rotación: la clave vigente va en ADA_CLAVE_DATOS y la anterior en ADA_CLAVE_DATOS_ANTERIOR.
// Cada texto cifrado lleva el identificador de su clave (8 caracteres derivados de la clave, no la
// clave), así se puede descifrar con la anterior y volver a cifrar con la nueva (recifrar()).
const crypto = require('crypto');

const SAL = 'ada-cifrado-v1';
const MIN_LARGO = 40;

function derivar(frase) {
  if (!frase) return null;
  const f = String(frase).trim();
  if (f.length < MIN_LARGO) return { error: `ADA_CLAVE_DATOS es muy corta (${f.length} caracteres; mínimo ${MIN_LARGO})` };
  const clave = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(f, 'utf8'), Buffer.from(SAL), Buffer.from('ada-datos'), 32));
  const kid = crypto.createHash('sha256').update(clave).digest('hex').slice(0, 8);
  return { clave, kid };
}

let cache = null;
function claves() {
  const actual = process.env.ADA_CLAVE_DATOS || '';
  const anterior = process.env.ADA_CLAVE_DATOS_ANTERIOR || '';
  if (cache && cache.firma === `${actual.length}:${anterior.length}:${actual.slice(-4)}:${anterior.slice(-4)}`) return cache;
  const a = derivar(actual);
  const b = derivar(anterior);
  cache = {
    firma: `${actual.length}:${anterior.length}:${actual.slice(-4)}:${anterior.slice(-4)}`,
    vigente: a && !a.error ? a : null,
    anterior: b && !b.error ? b : null,
    error: (a && a.error) || (b && b.error) || null,
  };
  return cache;
}

function estado() {
  const c = claves();
  return { configurada: !!c.vigente, id_clave: c.vigente ? c.vigente.kid : null, anterior: c.anterior ? c.anterior.kid : null, error: c.error };
}

function disponible() {
  return !!claves().vigente;
}

// Texto → "v1:<kid>:<iv>:<tag>:<datos>" (base64). Sin clave configurada, se niega (nunca guarda en claro).
function cifrar(texto) {
  const c = claves();
  if (!c.vigente) throw Object.assign(new Error(c.error || 'Falta ADA_CLAVE_DATOS en Railway: no se puede guardar contenido protegido'), { status: 503 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', c.vigente.clave, iv);
  const datos = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  return `v1:${c.vigente.kid}:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${datos.toString('base64')}`;
}

function descifrar(sobre) {
  if (sobre == null) return null;
  const [v, kid, iv, tag, datos] = String(sobre).split(':');
  if (v !== 'v1' || !datos) throw new Error('Formato cifrado desconocido');
  const c = claves();
  const k = c.vigente && c.vigente.kid === kid ? c.vigente : c.anterior && c.anterior.kid === kid ? c.anterior : null;
  if (!k) throw Object.assign(new Error(`No está la clave ${kid} para descifrar (¿se cambió ADA_CLAVE_DATOS sin dejar la anterior?)`), { status: 503, sinClave: true });
  const d = crypto.createDecipheriv('aes-256-gcm', k.clave, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(datos, 'base64')), d.final()]).toString('utf8');
}

const cifrarJSON = (o) => (o == null ? null : cifrar(JSON.stringify(o)));
const descifrarJSON = (s) => (s == null ? null : JSON.parse(descifrar(s)));
const idDe = (sobre) => (sobre ? String(sobre).split(':')[1] : null);

// Vuelve a cifrar con la clave vigente todo lo que esté con la anterior.
// columnas: [{ tabla, id, col }] en la base principal.
async function recifrar(columnas) {
  const { qPrincipal } = require('./db');
  const c = claves();
  if (!c.vigente) throw new Error('Falta la clave vigente');
  let cambiados = 0;
  let anulados = 0;
  for (const { tabla, id, col, alFallar } of columnas) {
    const filas = await qPrincipal(`SELECT ${id} AS id, ${col} AS v FROM ${tabla} WHERE ${col} IS NOT NULL AND ${col} NOT LIKE ?`, [`v1:${c.vigente.kid}:%`]);
    for (const f of filas) {
      let claro;
      try {
        claro = descifrar(f.v);
      } catch (e) {
        // Datos recuperables (p. ej. extracciones, que se vuelven a extraer): se anulan en vez de detener todo.
        if (alFallar && e.sinClave) { await qPrincipal(alFallar, [f.id]); anulados += 1; continue; }
        throw e;
      }
      await qPrincipal(`UPDATE ${tabla} SET ${col} = ? WHERE ${id} = ?`, [cifrar(claro), f.id]);
      cambiados += 1;
    }
  }
  return { recifrados: cambiados, anulados, id_clave: c.vigente.kid };
}

module.exports = { estado, disponible, cifrar, descifrar, cifrarJSON, descifrarJSON, idDe, recifrar };
