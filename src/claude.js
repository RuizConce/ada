// Cliente único de Claude para todo el servidor.
const Anthropic = require('@anthropic-ai/sdk');

const MODELO = () => process.env.ADA_MODEL || 'claude-sonnet-5-5';

let cliente;
function claude() {
  if (!cliente) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
    cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return cliente;
}

module.exports = { claude, MODELO };
