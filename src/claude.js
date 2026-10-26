// Cliente único de Claude y elección de modelo por turno:
// Haiku (rápido y barato) para lo simple; Sonnet para conversar a fondo, analizar y decidir.
const Anthropic = require('@anthropic-ai/sdk');

const MODELO = () => process.env.ADA_MODEL || 'claude-sonnet-5-5';
const MODELO_RAPIDO = () => process.env.ADA_MODEL_RAPIDO || process.env.ADA_MODEL || 'claude-haiku-5-5';
const MODELO_PROFUNDO = () => process.env.ADA_MODEL_PROFUNDO || 'claude-sonnet-5-5';

let cliente;
function claude() {
  if (!cliente) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
    cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return cliente;
}

// ---------- Elegir modelo (sin llamada extra: reglas simples, en microsegundos) ----------

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Pensar, opinar, analizar, decidir, explorar ideas.
const PROFUNDO = /\b(piensalo|pensemos|ayudame a pensar|que opinas|que piensas|tu opinion|que harias|analiza|analisis|analicemos|estrategi|conviene|convendria|deberia|decidir|decision|compara|comparar|evalua|evaluar|propuesta|plan de|planifi|ideas?|lluvia de ideas|por que|como podria|como puedo|que hago|recomienda|recomendarias|riesgo|pros y contras|alternativa|negocio|vender|ventas|precio|cobrar|crecer|clientes|informe|revisa como va|diagnostic|prioriza|priorizar|en que me enfoco|cuestiona)\b/;
// Órdenes simples y rápidas.
const COMANDO = /^(anota|anotame|apunta|registra|recuerdame|agenda|agendame|marca|marcalo|listo|ya lo hice|hecho|lo hice|borra|elimina|que hora|que dia|que tengo|chao|gracias|hola|buenos dias|buenas)\b/;
// Respuestas cortas que siguen el hilo anterior ("sí", "dale").
const ACUSE = /^(si|no|ya|ok|dale|claro|obvio|exacto|bueno|ya po)\b/;

const nivelAnterior = new Map(); // conversación → último nivel usado

function elegirModelo(texto, { conversacionId, modo = 'auto' } = {}) {
  const forzar = process.env.ADA_MODO_MODELO || modo;
  if (forzar === 'rapido') return { modelo: MODELO_RAPIDO(), nivel: 'rapido', motivo: 'ajuste: siempre rápido' };
  if (forzar === 'profundo') return { modelo: MODELO_PROFUNDO(), nivel: 'profundo', motivo: 'ajuste: siempre profundo' };
  const t = norm(texto).trim();
  const palabras = t.split(/\s+/).filter(Boolean).length;
  const antes = conversacionId ? nivelAnterior.get(conversacionId) : null;
  let nivel = 'rapido';
  let motivo = 'tarea o mensaje simple';
  if (PROFUNDO.test(t)) { nivel = 'profundo'; motivo = 'pide pensar, opinar o analizar'; }
  else if (palabras > 35) { nivel = 'profundo'; motivo = 'mensaje largo (está desarrollando una idea)'; }
  else if (antes === 'profundo' && !COMANDO.test(t) && (ACUSE.test(t) || palabras > 3)) {
    // Sigue la conversación de fondo (incluido "sí", "no", "dale" como respuesta a una pregunta).
    nivel = 'profundo'; motivo = 'continúa una conversación de fondo';
  }
  if (t.startsWith('[compartido desde otra app')) { nivel = 'profundo'; motivo = 'analizar algo compartido'; }
  if (conversacionId) nivelAnterior.set(conversacionId, nivel);
  return { modelo: nivel === 'profundo' ? MODELO_PROFUNDO() : MODELO_RAPIDO(), nivel, motivo };
}

// ---------- Costo estimado (USD por millón de tokens; ajustable con ADA_PRECIOS) ----------

const PRECIOS_BASE = {
  haiku: { entrada: 0.10, salida: 0.50, cache_escritura: 0.125, cache_lectura: 0.01 },
  sonnet: { entrada: 2.00, salida: 10.00, cache_escritura: 2.50, cache_lectura: 0.10 },
};
function precios(modelo) {
  let extra = {};
  try { extra = process.env.ADA_PRECIOS ? JSON.parse(process.env.ADA_PRECIOS) : {}; } catch (_) {}
  const familia = /haiku/.test(modelo) ? 'haiku' : /opus/.test(modelo) ? 'opus' : 'sonnet';
  return extra[modelo] || extra[familia] || PRECIOS_BASE[familia] || PRECIOS_BASE.sonnet;
}
function costoUSD(modelo, u = {}) {
  const p = precios(modelo);
  return ((u.input_tokens || 0) * p.entrada + (u.output_tokens || 0) * p.salida +
    (u.cache_creation_input_tokens || 0) * p.cache_escritura + (u.cache_read_input_tokens || 0) * p.cache_lectura) / 1e6;
}

module.exports = { claude, MODELO, MODELO_RAPIDO, MODELO_PROFUNDO, elegirModelo, costoUSD };
