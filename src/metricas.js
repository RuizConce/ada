// Tiempos de cada turno de voz, para saber dónde se va la demora (contexto, modelo, herramientas, voz).
const { usuario } = require('./db');

const porUsuario = new Map(); // id → últimos turnos
const MAX = 40;

function registrar(m) {
  const uid = usuario().id;
  const lista = porUsuario.get(uid) || [];
  lista.push({ ...m, en: Date.now() });
  while (lista.length > MAX) lista.shift();
  porUsuario.set(uid, lista);
}

// Junta lo que mide el servidor (por turno) con lo que mide el teléfono (cuando empieza a sonar).
function completarTurno(conversacionId, cliente) {
  const lista = porUsuario.get(usuario().id) || [];
  const t = [...lista].reverse().find((x) => x.conversacion_id === conversacionId && !x.cliente);
  if (t) t.cliente = cliente;
  else registrar({ conversacion_id: conversacionId, cliente });
}

const valores = (xs) => xs.filter((x) => typeof x === 'number' && x >= 0).sort((a, b) => a - b);
const percentil = (xs, p) => {
  const v = valores(xs);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))];
};
const mediana = (xs) => percentil(xs, 0.5);

function etapas(lista) {
  const campo = (f) => ({ mediana: mediana(lista.map(f)), p95: percentil(lista.map(f), 0.95) });
  return {
    hasta_que_habla: campo((x) => x.cliente && x.cliente.hasta_audio_ms),
    contexto: campo((x) => x.contexto_ms),
    primer_texto: campo((x) => x.primer_texto_ms),
    herramientas: campo((x) => x.herramientas_ms),
    total_servidor: campo((x) => x.total_ms),
    voz_primera_frase: campo((x) => x.cliente && x.cliente.tts_ms),
  };
}

function resumen() {
  const lista = (porUsuario.get(usuario().id) || []).slice(-MAX);
  const porModelo = {};
  for (const x of lista) {
    if (!x.modelo) continue;
    (porModelo[x.nivel || x.modelo] = porModelo[x.nivel || x.modelo] || []).push(x);
  }
  const modelos = Object.entries(porModelo).map(([nivel, xs]) => ({
    nivel,
    modelo: xs[xs.length - 1].modelo,
    turnos: xs.length,
    primer_texto_ms: mediana(xs.map((x) => x.primer_texto_ms)),
    total_ms: mediana(xs.map((x) => x.total_ms)),
    hasta_que_habla_ms: mediana(xs.map((x) => x.cliente && x.cliente.hasta_audio_ms)),
    costo_promedio_usd: xs.reduce((a, x) => a + (x.costo_usd || 0), 0) / xs.length,
    costo_total_usd: xs.reduce((a, x) => a + (x.costo_usd || 0), 0),
  }));
  const e = etapas(lista);
  return {
    turnos: lista.length,
    ms: Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v.mediana])), // compatibilidad
    etapas: e,
    modelos,
  };
}

module.exports = { registrar, completarTurno, resumen };
