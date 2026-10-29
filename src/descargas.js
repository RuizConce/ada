// Descargas por enlace temporal (para el teléfono).
// La app de Android (WebView) no puede guardar los "blob:" que arma el navegador, y en el PWA a veces la descarga
// se pierde. En su lugar, la app pide un enlace de un solo propósito (válido 5 minutos, ligado a la persona y al
// archivo) y lo abre como una descarga normal: Android lo guarda en Descargas.
// El enlace no lleva la sesión: un token aleatorio de 256 bits, que solo vive en memoria y nunca se registra.
const crypto = require('crypto');

const VIGENCIA_MS = 5 * 60 * 1000;
const enlaces = new Map(); // token → { usuario, tipo, id, vence }

function limpiar() {
  const ahora = Date.now();
  for (const [t, e] of enlaces) if (e.vence < ahora) enlaces.delete(t);
}

function crear(usuario, tipo, id) {
  limpiar();
  if (enlaces.size > 500) throw Object.assign(new Error('Demasiadas descargas pendientes; intenta en un momento'), { status: 429 });
  const token = crypto.randomBytes(32).toString('base64url');
  enlaces.set(token, { usuario, tipo, id: String(id), vence: Date.now() + VIGENCIA_MS });
  return { url: `/descargas/${token}`, vence_en_s: VIGENCIA_MS / 1000 };
}

function leer(token) {
  limpiar();
  return /^[\w-]{43}$/.test(String(token)) ? enlaces.get(token) || null : null;
}

module.exports = { crear, leer, VIGENCIA_MS };
