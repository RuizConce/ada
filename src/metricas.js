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

const mediana = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.floor(v.length / 2)];
};

function resumen() {
  const lista = (porUsuario.get(usuario().id) || []).slice(-15);
  const campo = (f) => mediana(lista.map(f));
  return {
    turnos: lista.length,
    ms: {
      contexto: campo((x) => x.contexto_ms),
      primer_texto: campo((x) => x.primer_texto_ms),
      herramientas: campo((x) => x.herramientas_ms),
      total_servidor: campo((x) => x.total_ms),
      hasta_que_habla: campo((x) => x.cliente && x.cliente.hasta_audio_ms),
      voz_primera_frase: campo((x) => x.cliente && x.cliente.tts_ms),
    },
  };
}

module.exports = { registrar, completarTurno, resumen };
