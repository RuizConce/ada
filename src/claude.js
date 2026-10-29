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
    // Reintentos acotados (el SDK reintenta por defecto 2 veces errores de red/saturación).
    cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: Math.max(0, parseInt(process.env.ADA_REINTENTOS_CLAUDE ?? '1', 10) || 0) });
  }
  return cliente;
}

// ---------- Elegir modelo (sin llamada extra: reglas simples, en microsegundos) ----------

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Pensar, opinar, analizar, decidir, explorar ideas: aquí sí vale Sonnet.
// (Antes también activaban Sonnet palabras de objetos o temas como "planilla", "excel", "listado", "resume",
// "precio" o "clientes": una búsqueda o una actualización de una planilla terminaba pagando Sonnet. Caso conv. 58.)
const PROFUNDO = /\b(piensalo|pensemos|ayudame a pensar|que opinas|que piensas|tu opinion|que harias|analiza|analizame|analisis|analicemos|estrategi\w*|conviene|convendria|deberia|decidir|que decido|compara|comparar|comparame|evalua|evaluar|evaluame|propuesta|plan de|planifi\w*|lluvia de ideas|ideas para|tengo (varias |unas |algunas |un par de )?ideas|se me ocurrio|que te parece|por que|como podria|como puedo|como hago para|que hago|recomienda|recomiendame|recomendarias|riesgos?|pros y contras|alternativas?|cuanto (deberia |debo |podria )?cobrar|diagnostic\w*|prioriza|priorizar|en que me enfoco|cuestiona|informe|redacta (un|una) (propuesta|carta|informe))\b/;
// Operaciones concretas (buscar, abrir, leer, anotar, agendar, actualizar, mover…): modelo rápido aunque
// mencionen una planilla, un Excel o un documento. Si además piden pensar o analizar, gana PROFUNDO.
const OPERATIVO = /^(oye ada,?\s*|ada,?\s*|por favor,?\s*|porfa,?\s*|(si|ok|dale|ya|bueno|listo|perfecto),?\s*|ahora,?\s*)?(busca|buscame|encuentra|encuentrame|abre|abreme|lee|leeme|muestra|muestrame|mira|revisa|revisame|actualiza|actualizame|agrega|agregale|anade|anota|anotame|apunta|registra|guarda|agenda|agendame|recuerdame|mueve|renombra|borra|elimina|marca|cambia|corrige|copia|manda|envia|enviale|llama|llamame|crea|sube|descarga|lista|listame|resume|resumeme|dame|pasame|cual es|donde esta|que tengo|que dice|cuantos|cuantas|confirma|sigue|continua)\b/;
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
  else if (OPERATIVO.test(t) || COMANDO.test(t)) { nivel = 'rapido'; motivo = 'operación concreta (buscar, leer, anotar, actualizar…)'; }
  else if (palabras > 35) { nivel = 'profundo'; motivo = 'mensaje largo (está desarrollando una idea)'; }
  else if (antes === 'profundo' && (ACUSE.test(t) || palabras > 3)) {
    // Sigue la conversación de fondo (incluido "sí", "no", "dale" como respuesta a una pregunta).
    nivel = 'profundo'; motivo = 'continúa una conversación de fondo';
  }
  if (t.startsWith('[compartido desde otra app')) { nivel = 'profundo'; motivo = 'analizar algo compartido'; }
  if (conversacionId) nivelAnterior.set(conversacionId, nivel);
  return { modelo: nivel === 'profundo' ? MODELO_PROFUNDO() : MODELO_RAPIDO(), nivel, motivo };
}

// ---------- Costo estimado (USD por millón de tokens; ajustable con ADA_PRECIOS) ----------

// Haiku 5.5 cobra 5 veces más toda la solicitud (entrada, salida y caché) cuando el prompt pasa de
// 100.000 tokens (contando caché). Precios de terceros: verificar con la consola de Anthropic.
const PRECIOS_BASE = {
  haiku: { entrada: 0.10, salida: 0.50, cache_escritura: 0.125, cache_lectura: 0.01, umbral: 100000, factor: 5 },
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
  const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const f = p.umbral && prompt > p.umbral ? (p.factor || 1) : 1;
  return f * ((u.input_tokens || 0) * p.entrada + (u.output_tokens || 0) * p.salida +
    (u.cache_creation_input_tokens || 0) * p.cache_escritura + (u.cache_read_input_tokens || 0) * p.cache_lectura) / 1e6;
}

// Estimación ANTES de llamar, con margen de seguridad: el prompt se cuenta sin descuento de caché
// (~3 caracteres por token, conservador para español), la salida como hasta 4.096 tokens (o el máximo
// pedido si es menor), +US$0,03 si puede buscar en internet, y todo ×1,25.
const MARGEN = () => { const n = parseFloat(process.env.ADA_MARGEN_ESTIMACION); return Number.isFinite(n) && n >= 1 ? n : 1.25; };
function estimarCosto(params = {}) {
  const chars = JSON.stringify(params.system || '').length + JSON.stringify(params.messages || []).length + JSON.stringify(params.tools || []).length;
  const entrada = Math.ceil(chars / 3);
  const salida = Math.min(params.max_tokens || 4096, 4096);
  const busca = (params.tools || []).some((t) => t && t.type && String(t.type).startsWith('web_search')) ? 0.03 : 0;
  return (costoUSD(params.model || '', { input_tokens: entrada, output_tokens: salida }) + busca) * MARGEN();
}

module.exports = { claude, MODELO, MODELO_RAPIDO, MODELO_PROFUNDO, elegirModelo, costoUSD, estimarCosto };
