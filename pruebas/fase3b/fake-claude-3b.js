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
    const estados = res.map((b) => { try { const g = JSON.parse(b.content).guardado; return g ? `${g.estado}${g.motivo ? `:${g.motivo}` : ''}${g.en_carpeta_de_prueba !== undefined ? `:carpeta=${g.en_carpeta_de_prueba}` : ''}` : 'error'; } catch (_) { return 'error'; } });
    return { id: `msg_${n}`, stop_reason: 'end_turn', usage: uso, content: [{ type: 'text', text: `Listo: ${res.length} lecturas en el último paso, ${guardado} desde lo guardado, ${errores} con error. Estados=${estados.join(',')}` }] };
  }
  const h = texto.match(/HERR (\{[\s\S]*\})\s*$/);
  if (h) {
    const { llamadas } = JSON.parse(h[1]);
    if (pasos === 0) return { id: `msg_${n}`, stop_reason: 'tool_use', usage: uso, content: llamadas.map((x, i) => ({ type: 'tool_use', id: `h${n}_${i}`, name: x.name, input: x.input || {} })) };
    const ultimo = req.messages[req.messages.length - 1];
    const res = ultimo.content.filter((b) => b.type === 'tool_result').map((b) => { const r = JSON.parse(b.content); return r.bloqueado_prueba ? 'BLOQUEADO' : r.error ? `ERROR:${String(r.error).slice(0, 120)}` : r.drive_error ? `LOCAL:${String(r.drive_error).slice(0, 40)}` : 'OK'; });
    const datos = ultimo.content.filter((b) => b.type === 'tool_result').map((b) => { try { return JSON.parse(b.content); } catch (_) { return null; } });
    return { id: `msg_${n}`, stop_reason: 'end_turn', usage: uso, content: [{ type: 'text', text: `RES=${JSON.stringify(res)}\nDATOS=${JSON.stringify(datos)}` }] };
  }
  if (/ESTADO GUARDADO/.test(texto)) {
    if (pasos === 0) return { id: `msg_${n}`, stop_reason: 'tool_use', usage: uso, content: [{ type: 'tool_use', id: `e${n}`, name: 'estado_guardado_documentos', input: {} }] };
    const ultimo = req.messages[req.messages.length - 1];
    return { id: `msg_${n}`, stop_reason: 'end_turn', usage: uso, content: [{ type: 'text', text: `ESTADO=${ultimo.content[0].content}` }] };
  }
  if (/QUE LEISTE/.test(texto)) {
    const nota = texto.match(/leíste de verdad en esta conversación \((\d+)\)/);
    return { id: `msg_${n}`, stop_reason: 'end_turn', usage: uso, content: [{ type: 'text', text: `DOCS=${nota ? nota[1] : 0}` }] };
  }
  return { id: `msg_${n}`, stop_reason: 'end_turn', usage: uso, content: [{ type: 'text', text: 'ok' }] };
}

// Auditora simulada (Fase 3c). Respuestas correctas conocidas para los datos ficticios de la prueba A;
// FAKE_AUDITOR cambia el comportamiento: haiku_falla_cita (Haiku cita mal R2), cumple_sin_cita (R1 "cumple" sin cita),
// lento (cada llamada tarda), caro (informa muchos tokens).
const CORRECTO = {
  R1: { estado: 'cumple', cita: 'extintor PQS de 6 kg, recarga realizada en septiembre de 2026, vigente hasta septiembre de 2027', justificacion: 'El certificado acredita un extintor PQS de 6 kg con carga vigente.' },
  R2: { estado: 'parcial', cita: 'se instaló el plano de evacuación en el primer piso. El plano del segundo piso está encargado y aún no se instala', justificacion: 'Hay plano en el primer piso, pero falta el del segundo.' },
  R3: { estado: 'no_aplica_justificado', cita: 'no se esteriliza material en el recinto', justificacion: 'El requisito aplica solo si se esteriliza en el recinto y el expediente indica que no se esteriliza.' },
};
global.__auditor = { llamadas: [] };
async function auditar(req) {
  const modo = process.env.FAKE_AUDITOR || 'correcto';
  const haiku = /haiku/.test(req.model);
  const texto = req.messages[0].content;
  const id = (texto.match(/^Requisito (\S+):/) || [])[1];
  const frags = [...texto.matchAll(/\[(F\d+) · [^\]]+\]\n([\s\S]*?)(?=\n\n\[F\d+ · |\n\nTu respuesta|\n\nEl requisito|$)/g)].map((m) => ({ id: m[1], texto: m[2] }));
  if (modo === 'lento') await dormir(parseInt(process.env.FAKE_LENTO_MS || '1500', 10));
  let r = { ...(CORRECTO[id] || { estado: 'sin_evidencia', cita: '', justificacion: 'Sin información.' }) };
  if (process.env.FAKE_CASOS) {
    const casos = require(process.env.FAKE_CASOS).simulado;
    if (casos[id]) r = { ...casos[id][haiku ? 'haiku' : 'sonnet'] };
  }
  if (modo === 'haiku_falla_cita' && haiku && id === 'R2') r.cita = 'el plano de evacuación está en ambos pisos del recinto';
  if (modo === 'cumple_sin_cita' && id === 'R1') r = { estado: 'cumple', cita: '', justificacion: 'Se cumple.' };
  const f = frags.find((x) => r.cita && x.texto.includes(r.cita.split('...')[0].trim())) || (process.env.FAKE_CASOS ? null : frags.find((x) => r.cita && x.texto.toLowerCase().includes('plano')));
  global.__auditor.llamadas.push({ modelo: req.model, id });
  const entrada = Math.ceil((JSON.stringify(req.system) + texto + JSON.stringify(req.tools)).length / 3);
  const usage = modo === 'caro' ? { input_tokens: 400000, output_tokens: 4000 } : { input_tokens: entrada, output_tokens: 120 };
  return { id: `msg_a${++n}`, stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: `a${n}`, name: 'evaluar_requisito', input: { estado: r.estado, fragmento: f ? f.id : '', cita: r.cita, justificacion: r.justificacion } }] };
}

// ---- Fase 3e ----
const usoDe = (req, salida = 300) => ({ input_tokens: Math.ceil((JSON.stringify(req.system) + JSON.stringify(req.messages) + JSON.stringify(req.tools)).length / 3.5), output_tokens: salida });
global.__h = { extraccion: 0, recomendaciones: 0, evaluaciones: 0 };
function extraerRequisitos(req) {
  const h = require(process.env.FAKE_H);
  const texto = String(req.messages[0].content);
  global.__h.extraccion += 1;
  const lista = (process.env.FAKE_H_EXTRACCION === 'vacia' ? [] : h.simulado.requisitos).filter((r) => process.env.FAKE_H_EXTRACCION === 'todas' || texto.includes(r.cita.split(' ').slice(0, 3).join(' ')));
  return { id: `msg_r${++n}`, stop_reason: 'tool_use', usage: usoDe(req, 80 * lista.length + 50), content: [{ type: 'tool_use', id: `r${n}`, name: 'registrar_requisitos', input: { requisitos: lista } }] };
}
function recomendaciones(req) {
  global.__h.recomendaciones += 1;
  const ids = [...String(req.messages[0].content).matchAll(/^- (\S+) \(/gm)].map((m) => m[1]);
  const modo = process.env.FAKE_H_REC || 'bien';
  const vez = global.__h.recomendaciones;
  const cortar = (modo === 'cortada_una_vez' && vez === 1) || modo === 'siempre_cortada';
  const lista = ids.map((id) => ({ requisito: id, accion: cortar && id === 'R5' ? 'Revisar cómo se l' : `Acción ficticia para subsanar el hallazgo ${id} y documentarla.`, prioridad: 'alta' }));
  if (modo === 'max_tokens_una_vez' && vez === 1) return { id: `msg_c${++n}`, stop_reason: 'max_tokens', usage: usoDe(req, req.max_tokens), content: [{ type: 'tool_use', id: `c${n}`, name: 'proponer_recomendaciones', input: { recomendaciones: lista.map((r) => ({ ...r, accion: r.accion.slice(0, 17) })) } }] };
  return { id: `msg_c${++n}`, stop_reason: 'tool_use', usage: usoDe(req, 60 * ids.length + 40), content: [{ type: 'tool_use', id: `c${n}`, name: 'proponer_recomendaciones', input: { recomendaciones: lista } }] };
}
function auditarH(req) {
  const h = require(process.env.FAKE_H);
  global.__h.evaluaciones += 1;
  const texto = String(req.messages[0].content);
  const id = (texto.match(/^Requisito (\S+):/) || [])[1];
  const frags = [...texto.matchAll(/\[(F\d+) · [^\]]+\]\n([\s\S]*?)(?=\n\n\[F\d+ · |\n\nTu respuesta|\n\nRevisión|$)/g)].map((m) => ({ id: m[1], texto: m[2] }));
  const r = h.simulado.evaluaciones[id] || { estado: 'sin_evidencia', evidencias: [], justificacion: 'Sin información.' };
  const mal = String(process.env.FAKE_H_MAL || '').split(',').includes(id);
  const evidencias = r.evidencias.map((e) => ({ fragmento: (frags.find((f) => f.texto.includes(e.cita)) || {}).id || 'F1', cita: mal ? `${e.cita} y además todo está perfecto` : e.cita, aporta: e.aporta }));
  // FAKE_H_CARO=R8: esa evaluación informa un consumo enorme (para probar el control de presupuesto).
  const caro = String(process.env.FAKE_H_CARO || '').split(',').includes(id);
  return { id: `msg_e${++n}`, stop_reason: 'tool_use', usage: caro ? { input_tokens: 1500000, output_tokens: 150 } : usoDe(req, 150), content: [{ type: 'tool_use', id: `e${n}`, name: 'evaluar_requisito', input: { estado: r.estado, evidencias, justificacion: r.justificacion } }] };
}

class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async (req, opciones) => {
        // Fase 3e (prueba H): extracción de requisitos de una norma y recomendaciones del informe.
        if (req.tools && req.tools.some((t) => t.name === 'registrar_requisitos')) return extraerRequisitos(req);
        if (req.tools && req.tools.some((t) => t.name === 'proponer_recomendaciones')) return recomendaciones(req);
        if (req.tools && req.tools.some((t) => t.name === 'evaluar_requisito') && process.env.FAKE_H) return auditarH(req);
        if (req.tools && req.tools.some((t) => t.name === 'evaluar_requisito')) {
          if (opciones && opciones.signal && opciones.signal.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
          // Igual que la API real: Sonnet/Opus 5.5 rechazan la herramienta forzada con 400.
          const forzado = req.tool_choice && ['tool', 'any'].includes(req.tool_choice.type);
          if (forzado && (!/haiku/.test(req.model) || process.env.FAKE_FORZADO_TODOS === 'si')) {
            throw Object.assign(new Error(`400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: forced tool use is not supported for model ${req.model}"}}`), { status: 400 });
          }
          const reqId = (String(req.messages[0].content).match(/^Requisito (\S+):/) || [])[1];
          if (process.env.FAKE_SONNET_ERROR === 'si' && !/haiku/.test(req.model) && (!process.env.FAKE_SONNET_ERROR_REQ || process.env.FAKE_SONNET_ERROR_REQ === reqId)) throw Object.assign(new Error('400 invalid_request_error (simulado)'), { status: 400 });
          return auditar(req);
        }
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
            for (const b of r.content) {
              if (b.type === 'tool_use') emitir('streamEvent', { type: 'content_block_start', content_block: { type: 'tool_use', name: b.name } });
              if (b.type === 'text' && b.text) emitir('text', b.text);
            }
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
