// Claude simulado para la Fase 3b: ejecuta lecturas de Drive guionadas desde el mensaje.
//   "LEE {"lotes":[[{"id":"R01","desde":0,"max":2000}, ...], [...]]}" → un paso por lote, todas las lecturas del lote en paralelo.
//   "QUE LEISTE" → responde "DOCS=<n>" con el número de documentos que trae la nota del sistema.
const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: ['/home/claude/ada'] });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

function responder(req) {
  let desde = req.messages.length - 1;
  while (desde > 0 && typeof req.messages[desde].content !== 'string') desde -= 1;
  const texto = String(req.messages[desde].content);
  const pasos = req.messages.slice(desde + 1).filter((m) => m.role === 'assistant').length;
  const uso = { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  n += 1;
  const m = texto.match(/LEE (\{[\s\S]*\})\s*$/);
  if (m) {
    const { lotes } = JSON.parse(m[1]);
    if (pasos < lotes.length) {
      return { id: `msg_${n}`, stop_reason: 'tool_use', usage: uso, content: [{ type: 'text', text: '' }, ...lotes[pasos].map((x, i) => ({ type: 'tool_use', id: `t${n}_${i}`, name: 'leer_drive', input: { id: x.id, ...(x.desde ? { desde: x.desde } : {}), ...(x.max ? { max_caracteres: x.max } : {}) } }))] };
    }
    const ultimo = req.messages[req.messages.length - 1];
    const res = Array.isArray(ultimo.content) ? ultimo.content.filter((b) => b.type === 'tool_result') : [];
    const errores = res.filter((b) => b.is_error).length;
    const guardado = res.filter((b) => /"fuente":"guardado"/.test(b.content)).length;
    return { id: `msg_${n}`, stop_reason: 'end_turn', usage: uso, content: [{ type: 'text', text: `Listo: ${res.length} lecturas en el último paso, ${guardado} desde lo guardado, ${errores} con error.` }] };
  }
  if (/QUE LEISTE/.test(texto)) {
    const nota = texto.match(/leíste de verdad en esta conversación \((\d+)\)/);
    return { id: `msg_${n}`, stop_reason: 'end_turn', usage: uso, content: [{ type: 'text', text: `DOCS=${nota ? nota[1] : 0}` }] };
  }
  return { id: `msg_${n}`, stop_reason: 'end_turn', usage: uso, content: [{ type: 'text', text: 'ok' }] };
}

class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async (req) => {
        // Títulos y resúmenes de conversación, etc.
        return { id: `msg_x${++n}`, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: '{"titulo":"Prueba","resumen":"Prueba de extracciones.","proyecto":null}' }] };
      },
      stream: (req) => {
        const h = {};
        let abortado = false;
        let rechazar;
        const emitir = (ev, x) => (h[ev] || []).forEach((f) => f(x));
        const p = new Promise((ok, mal) => {
          rechazar = mal;
          (async () => {
            await dormir(5);
            const r = responder(req);
            emitir('streamEvent', { type: 'message_start', message: { usage: { ...r.usage, output_tokens: 1 } } });
            if (abortado) return;
            for (const b of r.content) if (b.type === 'text' && b.text) emitir('text', b.text);
            emitir('streamEvent', { type: 'message_delta', usage: { output_tokens: r.usage.output_tokens } });
            ok({ ...r, _request_id: `req_fake_${n}` });
          })().catch(mal);
        });
        return {
          on(ev, fn) { (h[ev] = h[ev] || []).push(fn); return this; },
          finalMessage: () => p,
          abort() { abortado = true; const e = new Error('Request was aborted.'); e.name = 'APIUserAbortError'; rechazar(e); },
        };
      },
    };
  }
}
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };
