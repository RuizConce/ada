// Fase 3c — Auditoría mínima: 1 documento y pocos requisitos aprobados por Cristian, con evidencia
// verificable y un Excel. Usa el motor persistente de la Fase 3a (pasos, lease, presupuesto, reanudar) y
// la capa de extracciones de la Fase 3b (el documento se descarga una vez y se reutiliza). No es un
// sistema aparte: solo agrega tipos de paso y la verificación final del tipo "auditoria".
//
// Quién hace qué:
// - Código: leer/reutilizar el texto, dividirlo en fragmentos, elegir los pertinentes a cada requisito,
//   comprobar que la cita existe tal cual en el documento, armar la matriz y el Excel, y verificar todo.
// - IA (Haiku o Sonnet según la configuración K1/K2/K3): solo clasificar un requisito con los fragmentos
//   que le corresponden. Nunca recibe el documento completo si es largo, ni el historial de la conversación.
// - Nada se marca "cumple" sin una cita encontrada textualmente en el documento.
const crypto = require('crypto');
const { qPrincipal, usuario } = require('./db');
const Trabajos = require('./trabajos');
const Cifrado = require('./cifrado');
const Registro = require('./registro');
const C = require('./claude');

const CONFIGS = {
  K1: { nombre: 'Solo Sonnet', modelos: ['profundo', 'profundo'], escalar: false },
  K2: { nombre: 'Solo Haiku', modelos: ['rapido', 'rapido'], escalar: false },
  K3: { nombre: 'Haiku y Sonnet solo cuando una regla lo exige', modelos: ['rapido', 'profundo'], escalar: true },
};
const ESTADOS_IA = ['cumple', 'parcial', 'no_cumple', 'contradictorio', 'sin_evidencia', 'no_aplica_justificado'];
const CON_CITA = ['cumple', 'parcial', 'no_cumple', 'contradictorio'];
// Fase 3e: auditorías de mayor escala (prueba I: 15 documentos y 20 requisitos; J: 47 requisitos).
const MAX_REQUISITOS = 60;
const MAX_ARCHIVOS = 20;
const MAX_EVIDENCIAS = 4;           // citas por requisito (pueden venir de archivos distintos)
const FRAGS_POR_REQUISITO = 8;      // fragmentos que recibe la IA por requisito en documentos largos
const FRAGS_POR_ARCHIVO = 3;        // para que un archivo largo no tape a los demás
const CARACTERES_POR_REQUISITO = 7000;
const MAX_CITA = 300;
const DOC_CORTO = 4000; // documentos más cortos se envían completos (en fragmentos)
const err = (m, status = 400) => Object.assign(new Error(m), { status });
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const modeloDe = (nivel) => (nivel === 'profundo' ? C.MODELO_PROFUNDO() : C.MODELO_RAPIDO());

// ---------- Fragmentos (código) ----------

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const STOP = new Set('para debe deben cada como entre sobre desde hasta este esta estos estas todo toda todos todas tiene tienen contar cuenta menos mismo misma donde cuando sido sera seran hace hacer puede pueden segun otro otra otros otras dicho dicha solo tambien aunque porque pero muy mas menos'.split(' '));
// Raíces de las palabras con contenido (y siglas como RCP o PQS, que son cortas pero muy informativas).
const raices = (t) => {
  const siglas = (String(t || '').match(/\b[A-ZÁÉÍÓÚÑ]{2,5}\b/g) || []).map((x) => norm(x));
  return new Set(norm(t).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 6)).concat(siglas));
};

function fragmentar(texto, largo = 700) {
  const partes = String(texto).split(/\n+/);
  const frags = [];
  let actual = ''; let desde = 0; let pos = 0;
  for (const p of partes) {
    const ini = String(texto).indexOf(p, pos);
    if (ini >= 0) pos = ini + p.length;
    const nuevaPagina = /^\s*p[aá]gina\s+\d+/i.test(p);
    if (actual && (actual.length + p.length > largo || nuevaPagina)) { frags.push({ desde, texto: actual }); actual = ''; }
    if (!actual) desde = ini >= 0 ? ini : pos;
    actual = actual ? `${actual}\n${p}` : p;
  }
  if (actual.trim()) frags.push({ desde, texto: actual });
  let pagina = null;
  return frags.filter((f) => f.texto.trim()).map((f, i) => {
    const m = f.texto.match(/p[aá]gina\s+(\d+)/i);
    if (m) pagina = m[1];
    return { id: `F${i + 1}`, ubicacion: pagina ? `página ${pagina}` : `fragmento ${i + 1}`, desde: f.desde, hasta: f.desde + f.texto.length, texto: f.texto };
  });
}

// Fragmentos pertinentes a un requisito, entre TODOS los documentos. Código, sin IA: puntaje por raíces y siglas
// compartidas con el requisito; como máximo FRAGS_POR_ARCHIVO de un mismo archivo (la evidencia suele estar
// repartida: una nómina en un archivo y los certificados en otro) y un tope de caracteres.
function pertinentes(requisito, frags, textoTotal) {
  if (textoTotal.length <= DOC_CORTO) return { fragmentos: frags, criterio: 'documentos cortos: todos los fragmentos' };
  const r = raices(requisito);
  const puntaje = frags.map((f) => { const fr = raices(f.texto); let n = 0; for (const x of r) if (fr.has(x)) n += 1; return { f, n }; })
    .filter((x) => x.n >= Math.min(2, r.size)).sort((a, b) => b.n - a.n || a.f.orden - b.f.orden);
  const elegidos = []; const porArchivo = {}; let chars = 0;
  for (const { f } of puntaje) {
    if (elegidos.length >= FRAGS_POR_REQUISITO) break;
    const k = f.archivo_id || '';
    if ((porArchivo[k] || 0) >= FRAGS_POR_ARCHIVO) continue;
    if (chars + f.texto.length > CARACTERES_POR_REQUISITO && elegidos.length) continue;
    elegidos.push(f); porArchivo[k] = (porArchivo[k] || 0) + 1; chars += f.texto.length;
  }
  elegidos.sort((a, b) => a.orden - b.orden);
  const archivos = new Set(elegidos.map((f) => f.archivo_id)).size;
  return { fragmentos: elegidos, criterio: elegidos.length ? `palabras del requisito: ${elegidos.length} de ${frags.length} fragmentos, de ${archivos} archivo(s)` : 'ningún fragmento menciona el requisito' };
}

// Minimización de datos personales (piloto con documentos reales): antes de fragmentar, el código reemplaza
// RUT/RUN, correos, teléfonos y fechas de nacimiento por marcas. Así nunca llegan a la IA, ni al Excel, ni al
// informe; las citas se verifican contra el texto ya enmascarado. Solo se cuentan (nunca se guardan los valores).
const MASCARAS = [
  ['rut', /\b\d{1,2}(?:\.\d{3}){2}\s?-\s?[\dkK]\b|\b\d{7,8}\s?-\s?[\dkK]\b/g, '[RUT]'],
  ['correo', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[correo]'],
  ['telefono', /(?:\+?56[\s-]?)?(?:\(?0?\d{1,2}\)?[\s-]?)?\b9[\s-]?\d{4}[\s-]?\d{4}\b|\+56[\s-]?\d{1,2}[\s-]?\d{3}[\s-]?\d{4}\b/g, '[teléfono]'],
  ['nacimiento', /(fecha\s+de\s+nacimiento\s*:?\s*)\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}/gi, '$1[fecha]'],
];
function minimizar(texto) {
  let t = String(texto);
  const conteo = {};
  for (const [nombre, re, marca] of MASCARAS) t = t.replace(re, (...m) => { conteo[nombre] = (conteo[nombre] || 0) + 1; return marca.replace('$1', m[1] || ''); });
  return { texto: t, conteo };
}

// La cita debe existir tal cual en el fragmento (se toleran espacios, comillas y "…" entre trozos).
const limpia = (t) => norm(t).replace(/[“”«»"']/g, '').replace(/\s+/g, ' ').trim();
function citaVerificada(cita, fragmento) {
  if (!cita || !fragmento) return false;
  const base = limpia(fragmento.texto);
  const trozos = String(cita).split(/\.\.\.|…|\[\.\.\.\]/).map(limpia).filter(Boolean);
  if (!trozos.length) return false;
  let pos = 0;
  for (const t of trozos) {
    if (t.length < 6) continue;
    const i = base.indexOf(t, pos);
    if (i < 0) return false;
    pos = i + t.length;
  }
  return trozos.some((t) => t.length >= 6);
}

// ---------- Llamada a la IA (un requisito) ----------

const SISTEMA = `Eres auditora de cumplimiento. Evalúas UN requisito contra fragmentos de uno o más documentos y respondes solo con la herramienta evaluar_requisito.
Estados:
- cumple: TODAS las partes del requisito están acreditadas.
- parcial: una parte de lo exigido está acreditada y otra no (por ejemplo: se cumple en algunos lugares, elementos, personas o plazos y en otros no, o hay un avance incompleto).
- no_cumple: ninguna parte esencial está acreditada, o la evidencia contradice el requisito (por ejemplo, una cantidad, medida o vigencia menor a la exigida).
- contradictorio: los documentos se contradicen sobre un hecho decisivo (uno lo acredita y otro dice lo contrario) y con los fragmentos no se puede saber cuál es correcto. Exige al menos una cita a favor y una en contra.
- sin_evidencia: los fragmentos no dicen nada que permita evaluarlo.
- no_aplica_justificado: el requisito es condicional y la evidencia muestra que la condición no se da (explica por qué en la justificación).
Cómo evaluar: si el requisito tiene varias partes o exige algo "en cada", "todos", "ambos" o "al menos", revisa parte por parte. Si al menos una parte está acreditada y otra no, el estado es parcial, no no_cumple. Reserva no_cumple para cuando nada de lo esencial se cumple o la evidencia lo contradice. La evidencia puede estar repartida en varios archivos (por ejemplo, una nómina en uno y los certificados en otro): cita todo lo necesario.
Reglas: usa solo los fragmentos. Cada evidencia es una cita copiada textual de UN fragmento (sin cambiar palabras; máximo 300 caracteres; puedes unir trozos del mismo fragmento con "..."), con el id de ese fragmento y si apoya el cumplimiento (a_favor) o lo contradice (en_contra). Hasta ${MAX_EVIDENCIAS} evidencias. Nunca marques cumple sin una cita que lo pruebe. La justificación es breve (1 a 3 frases) y dice qué parte está acreditada y cuál no.`;
const HERRAMIENTA = {
  name: 'evaluar_requisito',
  description: 'Entrega la evaluación del requisito.',
  input_schema: {
    type: 'object',
    properties: {
      estado: { type: 'string', enum: ESTADOS_IA },
      evidencias: {
        type: 'array', maxItems: MAX_EVIDENCIAS,
        description: 'citas textuales que sostienen el estado; vacío solo si es sin_evidencia',
        items: {
          type: 'object',
          properties: {
            fragmento: { type: 'string', description: 'id del fragmento (F1, F2…)' },
            cita: { type: 'string', description: 'texto copiado tal cual del fragmento' },
            aporta: { type: 'string', enum: ['a_favor', 'en_contra'] },
          },
          required: ['fragmento', 'cita', 'aporta'],
        },
      },
      justificacion: { type: 'string' },
    },
    required: ['estado', 'justificacion'],
  },
};

// Forzar la herramienta (tool_choice "tool") no está permitido en todos los modelos: Claude Sonnet 5.5 y
// Opus 5.5 lo rechazan con un error 400 (documentación de Anthropic, "Define tools"). Para esos se usa "auto"
// con la instrucción de responder solo con la herramienta; el código igual revisa que la respuesta la use.
// Si otro modelo también lo rechaza, se recuerda y se repite la llamada con "auto".
const SIN_FORZAR = new Set();
const forzarPermitido = (modelo) => /haiku/i.test(modelo) && !SIN_FORZAR.has(modelo);
const eleccionHerramienta = (modelo) => (forzarPermitido(modelo) ? { type: 'tool', name: 'evaluar_requisito' } : { type: 'auto' });
const rechazaForzado = (e) => e && e.status === 400 && /tool_choice|forced tool|forzad/i.test(String(e.message || ''));

function pedido(nivel, requisito, sel, nota) {
  const varios = new Set(sel.fragmentos.map((f) => f.nombre).filter(Boolean)).size > 1;
  const frags = sel.fragmentos.map((f) => `[${f.id} · ${varios ? `${f.nombre} · ` : ''}${f.ubicacion}]\n${f.texto}`).join('\n\n');
  return {
    model: modeloDe(nivel),
    max_tokens: 1200,
    system: SISTEMA,
    tools: [HERRAMIENTA],
    tool_choice: eleccionHerramienta(modeloDe(nivel)),
    messages: [{ role: 'user', content: `Requisito ${requisito.id}: ${requisito.texto}\n\n${varios ? 'Fragmentos de los documentos' : `Fragmentos del documento «${sel.nombre}»`}:\n\n${frags || '(ninguno)'}${nota ? `\n\n${nota}` : ''}` }],
  };
}

// Revisa la respuesta con reglas objetivas (código). Devuelve { valido, motivo, evaluacion }.
// Cada evidencia debe existir textual en el fragmento que indica; si UNA no se verifica, se pide corregir.
function revisar(resp, sel, requisito, nivel, config) {
  const b = (resp.content || []).find((x) => x.type === 'tool_use' && x.name === 'evaluar_requisito');
  if (!b || resp.stop_reason === 'max_tokens') return { valido: false, motivo: b ? 'formato: respuesta cortada' : 'formato: respondió sin usar la herramienta' };
  const e = b.input || {};
  if (!ESTADOS_IA.includes(e.estado)) return { valido: false, motivo: `formato: estado "${e.estado}" no permitido` };
  // Compatibilidad: una sola cita en los campos de antes.
  const brutas = Array.isArray(e.evidencias) ? e.evidencias : (e.cita ? [{ fragmento: e.fragmento, cita: e.cita, aporta: e.estado === 'no_cumple' ? 'en_contra' : 'a_favor' }] : []);
  if (brutas.length > MAX_EVIDENCIAS) return { valido: false, motivo: `más de ${MAX_EVIDENCIAS} evidencias` };
  const evidencias = [];
  for (const x of brutas) {
    const frag = sel.fragmentos.find((f) => f.id === String(x.fragmento || '').trim());
    const cita = String(x.cita || '').trim();
    if (!cita) continue;
    if (cita.length > MAX_CITA) return { valido: false, motivo: `cita de ${cita.length} caracteres (máximo ${MAX_CITA})` };
    if (!frag) return { valido: false, motivo: `la cita no indica un fragmento válido (${x.fragmento || 'vacío'})` };
    if (!citaVerificada(cita, frag)) return { valido: false, motivo: `la cita de ${frag.id} no aparece textual en el documento` };
    evidencias.push({ fragmento: frag.id, cita, aporta: x.aporta === 'en_contra' ? 'en_contra' : 'a_favor', ubicacion: frag.ubicacion, verificada: true,
      archivo_id: frag.archivo_id || null, nombre: frag.nombre || null, version: frag.version || null });
  }
  // Una misma cita del mismo fragmento repetida no cuenta dos veces.
  const unicas = evidencias.filter((x, i) => evidencias.findIndex((y) => y.fragmento === x.fragmento && limpia(y.cita) === limpia(x.cita)) === i);
  const ev = { estado: e.estado, evidencias: unicas, justificacion: String(e.justificacion || '').trim() };
  if (CON_CITA.includes(ev.estado) && !unicas.length) return { valido: false, motivo: `"${ev.estado}" sin cita`, evaluacion: ev };
  if (ev.estado === 'contradictorio' && !(unicas.some((x) => x.aporta === 'a_favor') && unicas.some((x) => x.aporta === 'en_contra'))) return { valido: false, motivo: '"contradictorio" necesita una cita a favor y otra en contra', evaluacion: ev };
  if (ev.estado === 'no_aplica_justificado' && ev.justificacion.length < 20) return { valido: false, motivo: '"no aplica" sin justificación suficiente', evaluacion: ev };
  // Campos de la fila (compatibles con la 3c): la evidencia principal es la primera.
  const p = unicas[0];
  Object.assign(ev, { fragmento: p ? p.fragmento : null, cita: p ? p.cita : '', ubicacion: p ? p.ubicacion : null, cita_verificada: !!p,
    ...(p && p.archivo_id ? { archivo_id: p.archivo_id, nombre: p.nombre, version: p.version } : {}) });
  if (config.escalar && nivel === 'rapido') {
    const motivo = motivoEscalar(requisito.texto, ev);
    if (motivo) return { valido: true, segundaOpinion: motivo, evaluacion: ev };
  }
  return { valido: true, evaluacion: ev };
}

// Cuándo una respuesta de Haiku necesita segunda opinión (K3). Reglas generales, no de un documento:
// 1. Requisito condicional ("si", "cuando", "salvo"…) resuelto como "cumple" o "no aplica".
// 2. Cualquier "no cumple": es el hallazgo con más consecuencias y donde se confunde con "parcial" (caso R2).
// 3. Requisito con varias partes o cuantificado ("cada", "todos", "ambos", "al menos", cifras) resuelto
//    como "cumple" o "no cumple": son los que admiten un "parcial".
// 4. La justificación describe algo incompleto ("solo", "falta", "pendiente", "aún no", "pero"…) y el estado
//    es "cumple" o "no cumple": la explicación y la clasificación no coinciden.
const CONDICIONAL = /\b(si|cuando|en caso|salvo|excepto|siempre que)\b/;
const CUANTIFICADO = /\b(cada|todos|todas|todo el|toda la|ambos|ambas|al menos|como minimo|minimo|maximo|ningun|ninguna)\b|\d/;
const INCOMPLETO = /\b(solo|solamente|unicamente|falta|faltan|pendiente|pendientes|aun no|todavia no|pero|sin embargo|excepto|salvo|parcial|parcialmente|incompleto|incompleta|en tramite|encargado|encargada)\b/;
function motivoEscalar(textoRequisito, ev) {
  const req = norm(textoRequisito);
  const just = norm(ev.justificacion);
  if (CONDICIONAL.test(req) && ['no_aplica_justificado', 'cumple'].includes(ev.estado)) return 'requisito condicional';
  if (ev.estado === 'no_cumple') return 'hallazgo de no cumplimiento';
  if (ev.estado === 'contradictorio') return 'documentos contradictorios';
  if (CUANTIFICADO.test(req) && ev.estado === 'cumple') return 'requisito con varias partes o cantidades';
  if (INCOMPLETO.test(just) && ev.estado === 'cumple') return 'la justificación describe algo incompleto';
  return null;
}

async function llamar(params, ctx, intento) {
  try {
    return await llamarUna(params, ctx, intento);
  } catch (e) {
    if (!rechazaForzado(e) || !params.tool_choice || params.tool_choice.type === 'auto') throw e;
    SIN_FORZAR.add(params.model);
    console.warn(`Auditoría: ${params.model} no acepta herramienta forzada; se repite con tool_choice auto.`);
    return llamarUna({ ...params, tool_choice: { type: 'auto' } }, ctx, intento);
  }
}

async function llamarUna(params, ctx, intento) {
  const t0 = Date.now();
  const estimado = C.estimarCosto(params);
  try {
    const resp = await C.claude().messages.create(params, ctx.senal ? { signal: ctx.senal } : undefined);
    const reg = await Registro.llamada({ origen: 'trabajo', turnoId: ctx.trabajoId, trabajoId: ctx.trabajoId, pasoId: ctx.pasoId, paso: intento, modelo: params.model,
      usage: resp.usage || {}, duracionMs: Date.now() - t0, stopReason: resp.stop_reason, requestId: resp._request_id || resp.id, estimado, herramientas: (params.tools || []).map((x) => x.name).join(',') });
    return { resp, costo: reg.costo, estimado };
  } catch (e) {
    await Registro.llamada({ origen: 'trabajo', turnoId: ctx.trabajoId, trabajoId: ctx.trabajoId, pasoId: ctx.pasoId, paso: intento, modelo: params.model,
      usage: {}, duracionMs: Date.now() - t0, error: e.message, estimado });
    if (ctx.senal && ctx.senal.aborted) throw Object.assign(new Error('cancelado'), { cancelado: true });
    throw e;
  }
}

// ---------- Pasos ----------

// Fragmentos de todos los documentos, cada uno una sola vez; por requisito se guardan solo sus ids.
function fragmentosDeSeleccion(s, requisitoId) {
  const porReq = s.por_requisito.find((x) => x.requisito === requisitoId) || {};
  if (Array.isArray(porReq.fragmentos)) return porReq.fragmentos; // formato 3c
  const mapa = new Map((s.fragmentos || []).map((f) => [f.id, f]));
  return (porReq.ids || []).map((id) => mapa.get(id)).filter(Boolean);
}

const EJECUTORES = {
  // Texto de los documentos (reutilizado de la Fase 3b: ninguno se vuelve a descargar) → fragmentos
  // pertinentes por requisito. Código, sin IA.
  async aud_seleccionar({ entrada, trabajoId, pasoId }) {
    const Drive = require('./drive');
    const ids = entrada.archivo_ids || [entrada.archivo_id];
    const docs = [];
    let frags = [];
    let texto = '';
    for (const id of ids) {
      const doc = await Drive.textoParaTrabajo(id, { trabajoId, pasoId });
      if (!doc.texto.trim()) throw new Error(`El documento «${doc.nombre}» no tiene texto extraíble`);
      let enmascarados = null;
      if (entrada.minimizar !== false) { const m = minimizar(doc.texto); doc.texto = m.texto; enmascarados = m.conteo; }
      docs.push({ archivo_id: doc.archivo_id, nombre: doc.nombre, version: doc.version, fuente: doc.fuente, caracteres: doc.texto.length, enmascarados });
      const propios = fragmentar(doc.texto).map((f) => ({ ...f, archivo_id: doc.archivo_id, nombre: doc.nombre, version: doc.version }));
      frags = frags.concat(propios);
      texto += `${doc.texto}\n`;
    }
    frags = frags.map((f, i) => ({ ...f, id: `F${i + 1}`, orden: i }));
    const porRequisito = entrada.requisitos.map((r) => {
      const p = pertinentes(r.texto, frags, texto);
      return { requisito: r.id, criterio: p.criterio, ids: p.fragmentos.map((f) => f.id) };
    });
    const unico = docs.length === 1 ? docs[0] : {};
    return { resultado: { docs, archivo_id: unico.archivo_id, nombre: unico.nombre, version: unico.version, caracteres: texto.length, total_fragmentos: frags.length,
      fragmentos: frags.map(({ id, ubicacion, texto: t, archivo_id: a, nombre, version, orden }) => ({ id, ubicacion, texto: t, archivo_id: a, nombre, version, orden })),
      por_requisito: porRequisito }, costo: 0 };
  },

  // Clasificar UN requisito con la IA según K1/K2/K3, y comprobar cada evidencia con código.
  async aud_verificar({ entrada, previos, trabajoId, pasoId, senal }) {
    const config = CONFIGS[entrada.config] || CONFIGS.K3;
    const selPaso = [...previos].reverse().find((p) => p.resultado && p.resultado.por_requisito);
    if (!selPaso) throw new Error('falta la selección de fragmentos');
    const s = selPaso.resultado;
    const sel = { nombre: s.nombre || 'documentos', fragmentos: fragmentosDeSeleccion(s, entrada.requisito.id) };
    const base = { requisito: entrada.requisito.id, texto_requisito: entrada.requisito.texto, archivo_id: s.archivo_id || null, nombre: s.nombre || null, version: s.version || null, config: entrada.config };
    if (!sel.fragmentos.length) {
      // Nada en los documentos habla del requisito: lo dice el código, sin gastar en IA.
      return { resultado: { ...base, estado: 'sin_evidencia', evidencias: [], cita: '', cita_verificada: false, ubicacion: null, justificacion: 'Ningún fragmento de los documentos menciona este requisito.', modelo: 'código', intentos: [], escalado: false }, costo: 0, llamadasRegistradas: true };
    }
    const ctx = { trabajoId, pasoId, senal };
    const intentos = [];
    let costo = 0;
    let elegida = null;
    let nota = null;
    for (let i = 0; i < config.modelos.length; i++) {
      const nivel = config.modelos[i];
      const { resp, costo: c } = await llamar(pedido(nivel, entrada.requisito, sel, nota), ctx, i + 1);
      costo += c;
      const r = revisar(resp, sel, entrada.requisito, nivel, config);
      intentos.push({ modelo: modeloDe(nivel), nivel, valido: r.valido, motivo: r.motivo || (r.segundaOpinion ? `segunda opinión: ${r.segundaOpinion}` : null), estado: r.evaluacion ? r.evaluacion.estado : null, costo_usd: c });
      if (r.valido) {
        elegida = { ...r.evaluacion, modelo: modeloDe(nivel) }; // una respuesta válida posterior (más capaz) reemplaza a la anterior
        if (r.segundaOpinion && i < config.modelos.length - 1) { nota = `Revisión independiente (${r.segundaOpinion}): evalúa desde cero, parte por parte, y distingue con cuidado cumple, parcial, no_cumple, contradictorio y no_aplica_justificado.`; continue; }
        break;
      }
      if (elegida) break; // la segunda opinión no se pudo verificar: queda la respuesta válida anterior
      nota = `Tu respuesta anterior no se pudo verificar (${r.motivo}). Corrígela: cada cita debe copiarse textual del fragmento que indicas.`;
    }
    if (!elegida) {
      return { resultado: { ...base, estado: 'no_evaluado', evidencias: [], cita: '', cita_verificada: false, ubicacion: null, justificacion: `No se pudo verificar la evidencia: ${intentos.map((x) => x.motivo).filter(Boolean).join('; ')}`, modelo: intentos.map((x) => x.modelo).join(' → '), intentos, escalado: intentos.some((x) => x.nivel === 'profundo') && config.escalar }, costo, llamadasRegistradas: true };
    }
    return { resultado: { ...base, ...elegida, cita: elegida.cita.slice(0, MAX_CITA), intentos, escalado: config.escalar && intentos.some((x) => x.nivel === 'profundo') }, costo, llamadasRegistradas: true };
  },

  async aud_consolidar({ entrada, previos }) {
    const filas = entrada.requisitos.map((r) => {
      const p = [...previos].reverse().find((x) => x.resultado && x.resultado.requisito === r.id && x.clave.startsWith('verificar:'));
      const v = p ? p.resultado : { estado: 'no_evaluado', justificacion: 'paso sin resultado' };
      return { requisito: r.id, texto_requisito: r.texto, fuente_norma: r.fuente || '', estado: v.estado, justificacion: v.justificacion || '', cita: v.cita || '', cita_verificada: !!v.cita_verificada,
        ubicacion: v.ubicacion || '', archivo_id: v.archivo_id || null, archivo_version: v.version || null, archivo: v.nombre || null, modelo: v.modelo || '', escalado: !!v.escalado, paso: p ? p.clave : null,
        evidencias: (v.evidencias || (v.cita ? [{ cita: v.cita, aporta: 'a_favor', ubicacion: v.ubicacion, archivo_id: v.archivo_id, nombre: v.nombre, version: v.version, verificada: !!v.cita_verificada }] : []))
          .map((x) => ({ cita: x.cita, aporta: x.aporta, ubicacion: x.ubicacion || '', archivo_id: x.archivo_id || null, archivo: x.nombre || null, archivo_version: x.version || null, verificada: !!x.verificada })) };
    });
    return { resultado: { filas, total: filas.length }, costo: 0 };
  },

  async aud_excel({ previos, entrada, trabajoId }) {
    const consol = [...previos].reverse().find((p) => p.resultado && Array.isArray(p.resultado.filas));
    if (!consol) throw new Error('no hay matriz consolidada');
    const sel = [...previos].reverse().find((p) => p.resultado && p.resultado.por_requisito);
    const filas = consol.resultado.filas;
    const ExcelJS = require('exceljs');
    const libro = new ExcelJS.Workbook();
    libro.creator = 'ADA';
    const hoja = libro.addWorksheet('Matriz');
    hoja.columns = COLUMNAS.map((c) => ({ header: TITULOS[c], width: ANCHOS[c] || 18 }));
    hoja.getRow(1).font = { bold: true };
    for (const f of filas) hoja.addRow(COLUMNAS.map((c) => celda(f, c)));
    hoja.eachRow((row) => { row.alignment = { wrapText: true, vertical: 'top' }; });
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
    const ev = libro.addWorksheet('Evidencias');
    ev.columns = COLUMNAS_EV.map((c) => ({ header: TITULOS[c], width: ANCHOS[c] || 18 }));
    ev.getRow(1).font = { bold: true };
    for (const x of evidenciasPlanas(filas)) ev.addRow(COLUMNAS_EV.map((c) => (x[c] == null ? '' : String(x[c]))));
    ev.eachRow((row) => { row.alignment = { wrapText: true, vertical: 'top' }; });
    const res = libro.addWorksheet('Resumen');
    const conteo = conteoEstados(filas);
    res.columns = [{ width: 34 }, { width: 70 }];
    res.addRow(['Trabajo', trabajoId]);
    res.addRow(['Huella de los requisitos aprobados', entrada.requisitos_hash || '']);
    res.addRow(['Configuración', `${entrada.config} — ${(CONFIGS[entrada.config] || {}).nombre || ''}`]);
    res.addRow(['Requisitos', filas.length]);
    for (const e of ORDEN_ESTADOS) res.addRow([`  ${ETIQUETA[e]}`, conteo[e] || 0]);
    res.addRow(['Documentos auditados', sel ? sel.resultado.docs.length : '']);
    for (const d of (sel ? sel.resultado.docs : [])) res.addRow([`  ${d.nombre}`, `versión ${d.version}`]);
    const totalMasc = (sel ? sel.resultado.docs : []).reduce((a, d) => { for (const [k, n] of Object.entries(d.enmascarados || {})) a[k] = (a[k] || 0) + n; return a; }, {});
    res.addRow(['Datos personales enmascarados antes del análisis', Object.keys(totalMasc).length ? Object.entries(totalMasc).map(([k, n]) => `${n} ${k === 'telefono' ? 'teléfonos' : k === 'correo' ? 'correos' : k === 'nacimiento' ? 'fechas de nacimiento' : 'RUT'}`).join(', ') : 'ninguno encontrado']);
    res.addRow(['Generado', new Date().toISOString()]);
    const buf = Buffer.from(await libro.xlsx.writeBuffer());
    return { resultado: { nombre: 'auditoria.xlsx', xlsx_b64: buf.toString('base64'), huella: hash(buf.toString('base64')), filas: filas.length, evidencias: evidenciasPlanas(filas).length }, costo: 0 };
  },

  // Informe ejecutivo (Word). Los HALLAZGOS los arma el código desde la matriz verificada (hechos con cita);
  // las RECOMENDACIONES las propone la IA en una sola llamada, solo sobre los hallazgos (sin documentos), y van
  // en una sección aparte, marcadas como propuestas.
  async aud_informe({ previos, entrada, trabajoId, pasoId, senal }) {
    const consol = [...previos].reverse().find((p) => p.resultado && Array.isArray(p.resultado.filas));
    if (!consol) throw new Error('no hay matriz consolidada');
    const sel = [...previos].reverse().find((p) => p.resultado && p.resultado.por_requisito);
    const filas = consol.resultado.filas;
    const pendientes = filas.filter((f) => !['cumple', 'no_aplica_justificado'].includes(f.estado));
    let recomendaciones = []; let costo = 0; let origenRec = 'sin hallazgos que corregir';
    if (pendientes.length) {
      const r = await recomendar(pendientes, { trabajoId, pasoId, senal }, entrada.config);
      recomendaciones = r.recomendaciones; costo = r.costo; origenRec = r.origen;
    }
    const md = informeMarkdown({ filas, recomendaciones, origenRec, trabajoId, entrada, docs: sel ? sel.resultado.docs : [] });
    const { crearWord, comprobarWord } = require('./archivos');
    const titulo = 'Informe ejecutivo de auditoría';
    const buf = await crearWord({ titulo, contenido: md });
    // Comprobación antes de entregar: el Word trae cada línea completa y ningún párrafo termina a media frase.
    const c = await comprobarWord(buf, { titulo, contenido: md }, { estricto: true });
    if (!c.ok) throw new Error(`el informe salió incompleto y no se entrega: ${c.problemas.slice(0, 3).join('; ')}`);
    return { resultado: { nombre: 'informe.docx', docx_b64: buf.toString('base64'), huella: hash(buf.toString('base64')), md_huella: hash(md), md, hallazgos: pendientes.length, recomendaciones: recomendaciones.length, origen_recomendaciones: origenRec, comprobacion: { parrafos: c.parrafos, completo: true } },
      costo, llamadasRegistradas: true };
  },
};

// ---------- Entregables: columnas, textos y recomendaciones ----------

const ORDEN_ESTADOS = ['cumple', 'parcial', 'no_cumple', 'contradictorio', 'sin_evidencia', 'no_aplica_justificado', 'no_evaluado'];
const ETIQUETA = { cumple: 'Cumple', parcial: 'Cumple parcialmente', no_cumple: 'No cumple', contradictorio: 'Evidencia contradictoria', sin_evidencia: 'Sin evidencia', no_aplica_justificado: 'No aplica (justificado)', no_evaluado: 'No evaluado' };
const COLUMNAS = ['requisito', 'texto_requisito', 'fuente_norma', 'estado', 'justificacion', 'n_evidencias', 'cita', 'archivo', 'archivo_version', 'ubicacion', 'modelo'];
const COLUMNAS_EV = ['requisito', 'n', 'aporta', 'archivo', 'archivo_version', 'ubicacion', 'cita', 'verificada'];
const TITULOS = { requisito: 'Requisito', texto_requisito: 'Texto del requisito', fuente_norma: 'Fuente en la norma', estado: 'Estado', justificacion: 'Justificación', n_evidencias: 'N.º de evidencias',
  cita: 'Cita principal', archivo: 'Archivo', archivo_version: 'Versión', ubicacion: 'Ubicación', modelo: 'Modelo', n: 'N.º', aporta: 'Aporta', verificada: 'Cita verificada' };
const ANCHOS = { requisito: 10, texto_requisito: 50, fuente_norma: 40, estado: 22, justificacion: 50, cita: 50, archivo: 30, archivo_version: 26, ubicacion: 14, modelo: 24, aporta: 12 };
const celda = (f, c) => (c === 'n_evidencias' ? String((f.evidencias || []).length) : c === 'archivo' ? (f.archivo || '') : String(f[c] == null ? '' : f[c]));
const evidenciasPlanas = (filas) => filas.flatMap((f) => (f.evidencias || []).map((x, i) => ({ requisito: f.requisito, n: String(i + 1), aporta: x.aporta === 'en_contra' ? 'en contra' : 'a favor',
  archivo: x.archivo || '', archivo_version: x.archivo_version || '', ubicacion: x.ubicacion || '', cita: x.cita, verificada: x.verificada ? 'sí' : 'no' })));
const conteoEstados = (filas) => filas.reduce((a, f) => { a[f.estado] = (a[f.estado] || 0) + 1; return a; }, {});

const SISTEMA_REC = `Eres consultora de cumplimiento. Recibes hallazgos ya verificados de una auditoría documental. Para CADA hallazgo propones una acción concreta y realista para subsanarlo, con prioridad (alta, media o baja). No inventes hechos nuevos ni cambies los hallazgos: si la evidencia es contradictoria o falta, recomienda aclarar o reunir la evidencia. Cada acción en 1 o 2 frases completas, terminadas en punto (máximo 400 caracteres). Responde solo con la herramienta proponer_recomendaciones, una recomendación por hallazgo.`;
const HERRAMIENTA_REC = {
  name: 'proponer_recomendaciones',
  description: 'Entrega una recomendación por hallazgo.',
  input_schema: { type: 'object', properties: { recomendaciones: { type: 'array', items: { type: 'object', properties: {
    requisito: { type: 'string' }, accion: { type: 'string' }, prioridad: { type: 'string', enum: ['alta', 'media', 'baja'] } }, required: ['requisito', 'accion', 'prioridad'] } } }, required: ['recomendaciones'] },
};
// El informe usa el modelo más capaz de la configuración aprobada (K1/K3: Sonnet; K2: Haiku), nunca otro.
const modeloInforme = (config) => modeloDe((CONFIGS[config] || CONFIGS[CONFIG_PROVISIONAL]).modelos.slice(-1)[0]);
function pedidoRecomendaciones(pendientes, nota, config) {
  const lista = pendientes.map((f) => `- ${f.requisito} (${ETIQUETA[f.estado]}): ${f.texto_requisito}\n  Hallazgo: ${f.justificacion}`).join('\n');
  return { model: modeloInforme(config), max_tokens: Math.min(16000, 800 + pendientes.length * 300), system: SISTEMA_REC, tools: [HERRAMIENTA_REC], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: `Hallazgos (${pendientes.length}):\n${lista}${nota ? `\n\n${nota}` : ''}` }] };
}
// Una acción es válida solo si está COMPLETA: largo razonable y termina en cierre de frase. Nunca se recorta:
// un texto largo o cortado se rechaza y se pide de nuevo (la causa del "Revisar cómo se l" de la prueba H).
const MAX_ACCION = 700;
const CIERRE_FRASE = /[.!?…)»"”]$/;
function accionValida(t) {
  const a = String(t || '').replace(/\s+/g, ' ').trim();
  if (a.length < 10) return 'muy corta';
  if (a.length > MAX_ACCION) return `muy larga (${a.length} caracteres)`;
  if (!CIERRE_FRASE.test(a)) return 'termina a media frase';
  return null;
}
async function recomendar(pendientes, ctx, config) {
  const ids = new Set(pendientes.map((f) => f.requisito));
  let costo = 0; let nota = null; let extra = 0;
  for (let intento = 1; intento <= 3; intento++) {
    const params = pedidoRecomendaciones(pendientes, nota, config);
    params.max_tokens = Math.min(16000, params.max_tokens + extra);
    const { resp, costo: c } = await llamar(params, ctx, intento);
    costo += c;
    // Respuesta cortada por largo: no se usa ninguna parte; se pide de nuevo con más espacio y más breve.
    if (resp.stop_reason === 'max_tokens') { extra += 2000; nota = 'Tu respuesta anterior se cortó por largo. Sé más breve: una o dos frases completas por acción.'; continue; }
    const b = (resp.content || []).find((x) => x.type === 'tool_use' && x.name === 'proponer_recomendaciones');
    const lista = b && Array.isArray(b.input.recomendaciones) ? b.input.recomendaciones : [];
    const rechazos = [];
    const validas = [];
    for (const r of lista) {
      if (!ids.has(String(r.requisito))) continue;
      const motivo = accionValida(r.accion);
      if (motivo) { rechazos.push(`${r.requisito}: ${motivo}`); continue; }
      validas.push({ requisito: String(r.requisito), accion: String(r.accion).replace(/\s+/g, ' ').trim(), prioridad: ['alta', 'media', 'baja'].includes(r.prioridad) ? r.prioridad : 'media' });
    }
    const unicas = [...new Map(validas.map((r) => [r.requisito, r])).values()];
    if (unicas.length === ids.size) return { recomendaciones: pendientes.map((f) => unicas.find((r) => r.requisito === f.requisito)), costo, origen: 'IA' };
    const faltan = [...ids].filter((x) => !unicas.some((r) => r.requisito === x));
    nota = `Faltó una recomendación completa para: ${faltan.join(', ')}${rechazos.length ? ` (${rechazos.join('; ')})` : ''}. Entrega exactamente una por hallazgo, cada una en 1 o 2 frases completas terminadas en punto.`;
  }
  // Si la IA no entrega una acción completa por hallazgo, no se inventa ni se recorta: queda una acción genérica marcada como tal.
  return { recomendaciones: pendientes.map((f) => ({ requisito: f.requisito, accion: f.estado === 'contradictorio' ? 'Aclarar la contradicción entre documentos y conservar la evidencia vigente.' : f.estado === 'sin_evidencia' || f.estado === 'no_evaluado' ? 'Reunir y presentar la evidencia documental de este requisito.' : 'Subsanar el incumplimiento y documentar la corrección.', prioridad: 'media', generica: true })), costo, origen: 'plantilla (la IA no entregó una acción completa por hallazgo)' };
}

// Textos que vienen de otros (requisitos escritos a mano, justificaciones) se cierran con punto si no lo traen,
// para que el informe nunca muestre una frase abierta. Los textos de la IA ya llegan completos (se validan antes).
const frase = (t) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return !x || /[.!?…:;)\]»"”]$/.test(x) ? x : `${x}.`; };
function informeMarkdown({ filas, recomendaciones, origenRec, trabajoId, entrada, docs }) {
  const conteo = conteoEstados(filas);
  const pendientes = filas.filter((f) => !['cumple', 'no_aplica_justificado'].includes(f.estado));
  const ref = (x) => `${x.archivo || 'documento'}${x.ubicacion ? `, ${x.ubicacion}` : ''}`;
  const l = [];
  l.push(`Trabajo ${trabajoId} · Configuración ${entrada.config} · Requisitos aprobados: ${filas.length} (huella ${String(entrada.requisitos_hash || '').slice(0, 12)})`);
  l.push(`Generado por ADA el ${new Date().toISOString().slice(0, 10)}.`);
  l.push('', '## 1. Alcance');
  l.push(`Se revisaron ${docs.length} documento(s) contra ${filas.length} requisito(s) aprobados:`);
  for (const d of docs) l.push(`- ${d.nombre} (versión ${d.version})`);
  l.push('', '## 2. Resumen');
  l.push('| Estado | Requisitos |', '| --- | --- |');
  for (const e of ORDEN_ESTADOS) if (conteo[e]) l.push(`| ${ETIQUETA[e]} | ${conteo[e]} |`);
  l.push(`| Total | ${filas.length} |`);
  l.push('', '## 3. Hallazgos');
  l.push('Hechos verificados: cada uno se apoya en citas encontradas textualmente en los documentos.');
  if (!pendientes.length) l.push('- No hay hallazgos: todos los requisitos se cumplen o no aplican.');
  for (const f of pendientes) {
    l.push(`### ${f.requisito} — ${ETIQUETA[f.estado]}`);
    l.push(`Requisito: ${frase(f.texto_requisito)}`);
    l.push(`Hallazgo: ${frase(f.justificacion)}`);
    for (const x of f.evidencias || []) l.push(`- Evidencia ${x.aporta === 'en_contra' ? 'en contra' : 'a favor'} (${ref(x)}): «${x.cita}»`);
  }
  const cumplen = filas.filter((f) => ['cumple', 'no_aplica_justificado'].includes(f.estado));
  if (cumplen.length) {
    l.push('', '### Requisitos cumplidos o que no aplican');
    for (const f of cumplen) l.push(`- ${f.requisito} — ${ETIQUETA[f.estado]}: ${frase(f.justificacion)}`);
  }
  l.push('', '## 4. Recomendaciones');
  l.push(`Propuestas de ADA para subsanar los hallazgos (origen: ${origenRec}). No son hallazgos ni hechos verificados: son sugerencias para decidir.`);
  if (!recomendaciones.length) l.push('- Sin recomendaciones: no hay hallazgos que subsanar.');
  for (const r of recomendaciones) l.push(`- ${r.requisito} (prioridad ${r.prioridad}${r.generica ? ', genérica' : ''}): ${r.accion}`);
  l.push('', '## 5. Método y límites');
  l.push('- La evaluación usa solo los documentos indicados; lo que no está en ellos figura como sin evidencia.');
  l.push('- Cada cita fue comprobada por código contra el texto del documento; el detalle completo está en el Excel (hojas Matriz y Evidencias).');
  l.push('- Las recomendaciones son propuestas y requieren revisión profesional.');
  const masc = docs.reduce((a, d) => a + Object.values(d.enmascarados || {}).reduce((x, y) => x + y, 0), 0);
  if (masc) l.push(`- Antes del análisis se enmascararon ${masc} datos personales (RUT, correos, teléfonos o fechas de nacimiento); las citas los muestran como [RUT], [correo], [teléfono] o [fecha].`);
  return l.join('\n');
}

// ---------- Verificación final (código) ----------

async function leerHoja(libro, nombre, columnas) {
  const hoja = libro.getWorksheet(nombre);
  if (!hoja) return null;
  const filas = [];
  hoja.eachRow((row, n) => { if (n > 1) filas.push(columnas.map((_, i) => { const v = row.getCell(i + 1).value; return v == null ? '' : String(v); })); });
  return filas;
}

// Texto plano de un .docx (para comprobar el informe sin depender de cómo se ve).
async function textoDocx(b64) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
  const xml = await zip.file('word/document.xml').async('string');
  return xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

async function verificar(t, pasos, esperado, opciones) {
  const objetivo = Cifrado.descifrarJSON(t.objetivo_cifrado) || {};
  if (objetivo.modo === 'requisitos') return verificarRequisitos(t, pasos, objetivo, opciones);
  const problemas = opciones.integridad(pasos);
  const ids = (objetivo.requisitos || []).map((r) => r.id);
  const consol = pasos.filter((p) => p.tipo === 'aud_consolidar').pop();
  const matriz = consol && consol.resultado_cifrado ? Cifrado.descifrarJSON(consol.resultado_cifrado) : null;
  if (!matriz) problemas.push('no hay matriz consolidada');
  else {
    const vistos = matriz.filas.map((f) => f.requisito);
    if (new Set(vistos).size !== vistos.length) problemas.push('la matriz tiene requisitos duplicados');
    if (vistos.length !== ids.length || vistos.some((x, i) => x !== ids[i])) problemas.push(`la matriz tiene ${vistos.join(', ')} y lo aprobado es ${ids.join(', ')}`);
    for (const f of matriz.filas) {
      if (!Trabajos.ESTADOS_EVIDENCIA.includes(f.estado)) problemas.push(`${f.requisito}: estado inválido "${f.estado}"`);
      if (CON_CITA.includes(f.estado) && !(f.cita && f.cita_verificada && f.archivo_id && f.archivo_version && f.ubicacion)) problemas.push(`${f.requisito}: "${f.estado}" sin evidencia verificable completa`);
      for (const x of f.evidencias || []) if (!(x.verificada && x.cita && x.archivo_id && x.archivo_version && x.ubicacion)) problemas.push(`${f.requisito}: una evidencia sin archivo, versión, ubicación o cita verificada`);
      if (f.estado === 'contradictorio' && !((f.evidencias || []).some((x) => x.aporta === 'a_favor') && (f.evidencias || []).some((x) => x.aporta === 'en_contra'))) problemas.push(`${f.requisito}: "contradictorio" sin evidencia a favor y en contra`);
      if (f.estado === 'no_aplica_justificado' && !f.justificacion) problemas.push(`${f.requisito}: "no aplica" sin justificación`);
    }
  }
  // Excel: se relee y se coteja celda por celda (Matriz y Evidencias), y que corresponde a ESTE trabajo.
  const ent = pasos.filter((p) => p.tipo === 'aud_excel').pop();
  let excel = null;
  if (!ent) problemas.push('falta el Excel');
  else {
    try {
      const e = Cifrado.descifrarJSON(ent.resultado_cifrado);
      if (hash(e.xlsx_b64) !== e.huella) problemas.push('el Excel no coincide con su huella');
      const ExcelJS = require('exceljs');
      const libro = new ExcelJS.Workbook();
      await libro.xlsx.load(Buffer.from(e.xlsx_b64, 'base64'));
      const filas = await leerHoja(libro, 'Matriz', COLUMNAS);
      const evs = await leerHoja(libro, 'Evidencias', COLUMNAS_EV);
      const resumen = await leerHoja(libro, 'Resumen', [0, 1]);
      if (!filas) problemas.push('el Excel no tiene la hoja Matriz');
      excel = { filas: filas ? filas.length : 0, evidencias: evs ? evs.length : 0, columnas: COLUMNAS.length, hojas: libro.worksheets.map((w) => w.name) };
      if (matriz && filas) {
        if (filas.length !== matriz.filas.length) problemas.push(`el Excel tiene ${filas.length} filas y la matriz ${matriz.filas.length}`);
        else filas.forEach((x, i) => { COLUMNAS.forEach((c, j) => { if (x[j] !== celda(matriz.filas[i], c)) problemas.push(`Excel fila ${i + 1}, ${c}: no coincide con la matriz`); }); });
        const ids2 = filas.map((x) => x[0]);
        if (new Set(ids2).size !== ids2.length) problemas.push('el Excel repite requisitos');
        if (ids.some((x) => !ids2.includes(x))) problemas.push(`el Excel omite ${ids.filter((x) => !ids2.includes(x)).join(', ')}`);
        const planas = evidenciasPlanas(matriz.filas);
        if (!evs) problemas.push('el Excel no tiene la hoja Evidencias');
        else if (evs.length !== planas.length) problemas.push(`la hoja Evidencias tiene ${evs.length} filas y la matriz ${planas.length} evidencias`);
        else evs.forEach((x, i) => { COLUMNAS_EV.forEach((c, j) => { if (x[j] !== String(planas[i][c] == null ? '' : planas[i][c])) problemas.push(`Evidencias fila ${i + 1}, ${c}: no coincide`); }); });
      }
      // Hoja Resumen: el número de trabajo y la huella de los requisitos aprobados (la fila 1 es la del trabajo).
      const libroTrabajo = libro.getWorksheet('Resumen');
      const v = (n) => (libroTrabajo ? String(libroTrabajo.getRow(n).getCell(2).value || '') : '');
      if (!libroTrabajo || v(1) !== t.id) problemas.push('el Excel no indica este trabajo');
      if (!libroTrabajo || v(2) !== String(objetivo.requisitos_hash || '')) problemas.push('el Excel no corresponde a los requisitos aprobados');
      if (resumen === null) problemas.push('el Excel no tiene la hoja Resumen');
    } catch (e) { problemas.push(`no se pudo releer el Excel: ${e.message}`); }
  }
  // Informe ejecutivo (Fase 3e): existe, corresponde a este trabajo y separa hallazgos de recomendaciones.
  const pasoInforme = pasos.filter((p) => p.tipo === 'aud_informe').pop();
  let informe = null;
  if (pasoInforme) {
    try {
      const e = Cifrado.descifrarJSON(pasoInforme.resultado_cifrado);
      if (hash(e.docx_b64) !== e.huella) problemas.push('el informe no coincide con su huella');
      if (e.md) {
        const c = await require('./archivos').comprobarWord(Buffer.from(e.docx_b64, 'base64'), { titulo: 'Informe ejecutivo de auditoría', contenido: e.md }, { estricto: true });
        for (const x of c.problemas) problemas.push(`informe: ${x}`);
      } else problemas.push('el informe no guardó su contenido para comprobarlo');
      const texto = await textoDocx(e.docx_b64);
      const iH = texto.indexOf('3. Hallazgos'); const iR = texto.indexOf('4. Recomendaciones'); const iM = texto.indexOf('5. Método y límites');
      if (!texto.includes(t.id)) problemas.push('el informe no indica este trabajo');
      if (!texto.includes(String(objetivo.requisitos_hash || '').slice(0, 12))) problemas.push('el informe no corresponde a los requisitos aprobados');
      if (!(iH > 0 && iR > iH && iM > iR)) problemas.push('el informe no separa Hallazgos y Recomendaciones');
      if (matriz && iH > 0 && iR > iH) {
        const hallazgos = texto.slice(iH, iR); const recs = texto.slice(iR, iM > 0 ? iM : undefined);
        const pend = matriz.filas.filter((f) => !['cumple', 'no_aplica_justificado'].includes(f.estado));
        for (const f of pend) {
          if (!hallazgos.includes(`${f.requisito} — `)) problemas.push(`el informe omite el hallazgo ${f.requisito}`);
          if (!recs.includes(`${f.requisito} (prioridad`)) problemas.push(`el informe no tiene recomendación para ${f.requisito}`);
        }
        for (const f of matriz.filas.filter((x) => ['cumple', 'no_aplica_justificado'].includes(x.estado))) if (recs.includes(`${f.requisito} (prioridad`)) problemas.push(`el informe recomienda sobre ${f.requisito}, que no es hallazgo`);
        const total = (texto.match(/Total\s*\n?\s*(\d+)/) || [])[1];
        if (Number(total) !== matriz.filas.length) problemas.push(`el resumen del informe dice ${total} requisitos y la matriz ${matriz.filas.length}`);
        informe = { hallazgos: pend.length, recomendaciones: e.recomendaciones, origen_recomendaciones: e.origen_recomendaciones, caracteres: texto.length };
      }
    } catch (e) { problemas.push(`no se pudo releer el informe: ${e.message}`); }
  } else if (objetivo.informe) problemas.push('falta el informe ejecutivo');
  // Precisión frente al resultado correcto conocido (no bloquea: es la medida de calidad).
  const correcto = (objetivo.esperado || []).filter((x) => x && x.id && x.estado);
  const precision = correcto.length && matriz ? correcto.map((x) => {
    const f = matriz.filas.find((y) => y.requisito === x.id);
    return { requisito: x.id, esperado: x.estado, obtenido: f ? f.estado : null, acierto: !!f && f.estado === x.estado };
  }) : [];
  const costos = await costosDe(t.id);
  return {
    ok: !problemas.length, problemas, matriz,
    extra: {
      config: objetivo.config, excel, informe,
      precision: precision.length ? { aciertos: precision.filter((x) => x.acierto).length, total: precision.length, detalle: precision } : null,
      conteo: matriz ? conteoEstados(matriz.filas) : null,
      costos,
      escalados: matriz ? matriz.filas.filter((f) => f.escalado).length : 0,
      modelos: matriz ? [...new Set(matriz.filas.map((f) => f.modelo))] : [],
    },
  };
}

// Costo real estimado (tokens informados × tabla de precios) frente a reservas preventivas.
async function costosDe(trabajoId) {
  const [l] = await qPrincipal(`SELECT COUNT(*) AS llamadas, COALESCE(SUM(costo_usd),0) AS real_usd, COALESCE(SUM(costo_estimado),0) AS estimado_usd,
      COALESCE(SUM(input_tokens),0) AS entrada, COALESCE(SUM(output_tokens),0) AS salida, SUM(error IS NOT NULL) AS con_error FROM llamadas_ia WHERE trabajo_id = ?`, [trabajoId]);
  const porModelo = await qPrincipal('SELECT modelo, COUNT(*) AS llamadas, COALESCE(SUM(costo_usd),0) AS real_usd FROM llamadas_ia WHERE trabajo_id = ? GROUP BY modelo', [trabajoId]);
  const [r] = await qPrincipal('SELECT COUNT(*) AS reservas, COALESCE(SUM(monto),0) AS reservado_usd, COALESCE(MAX(monto),0) AS mayor_reserva FROM reservas_ia WHERE trabajo_id = ?', [trabajoId]);
  return {
    llamadas: Number(l.llamadas), llamadas_con_error: Number(l.con_error || 0), real_usd: Number(l.real_usd), estimado_previo_usd: Number(l.estimado_usd),
    tokens_entrada: Number(l.entrada), tokens_salida: Number(l.salida),
    por_modelo: porModelo.map((x) => ({ modelo: x.modelo, llamadas: Number(x.llamadas), real_usd: Number(x.real_usd) })),
    reservas: Number(r.reservas), reservado_total_usd: Number(r.reservado_usd), mayor_reserva_usd: Number(r.mayor_reserva),
    nota: 'real_usd = tokens informados por Anthropic × tabla de precios de ADA. estimado_previo y reservas = cálculos preventivos antes de cada llamada/paso. Ninguno es la factura (Consola de Anthropic).',
  };
}

// ---------- Crear (requisitos y presupuesto aprobados en el mismo acto) ----------

function validarEntrada(d) {
  if (usuario().id !== 1) throw err('La auditoría está disponible solo para la cuenta principal en esta etapa.', 403);
  const archivo_ids = [...new Set((Array.isArray(d.archivo_ids) && d.archivo_ids.length ? d.archivo_ids : [d.archivo_id]).filter(Boolean).map(String))];
  if (!archivo_ids.length || archivo_ids.length > MAX_ARCHIVOS) throw err(`Indica entre 1 y ${MAX_ARCHIVOS} documentos (de la carpeta de prueba)`);
  for (const id of archivo_ids) if (!/^[\w-]{3,128}$/.test(id)) throw err(`Id de documento inválido: ${id}`);
  const requisitos = (d.requisitos || []).map((r, i) => ({ id: String(r.id || `R${i + 1}`).trim().slice(0, 12), texto: String(r.texto || '').trim().slice(0, 600),
    ...(r.fuente ? { fuente: String(r.fuente).trim().slice(0, 400) } : {}) })).filter((r) => r.texto);
  if (!requisitos.length || requisitos.length > MAX_REQUISITOS) throw err(`Entre 1 y ${MAX_REQUISITOS} requisitos`);
  if (new Set(requisitos.map((r) => r.id)).size !== requisitos.length) throw err('Hay ids de requisito repetidos');
  for (const r of requisitos) if (!/^[\w.-]{1,12}$/.test(r.id)) throw err(`Id de requisito inválido: ${r.id}`);
  const esperado = (d.esperado || []).filter((x) => x && x.id && x.estado).map((x) => ({ id: String(x.id), estado: String(x.estado) }));
  for (const x of esperado) if (!Trabajos.ESTADOS_EVIDENCIA.includes(x.estado)) throw err(`Estado esperado inválido para ${x.id}: ${x.estado}`);
  return { archivo_ids, archivo_id: archivo_ids[0], requisitos, esperado };
}

// Estimación previa por configuración (peor caso: segundo intento incluido). Sirve para proponer presupuesto.
function estimar({ requisitos, config, informe = true }) {
  const k = CONFIGS[config];
  const fragmentos = 'x'.repeat(CARACTERES_POR_REQUISITO);
  const verificar = requisitos.reduce((a, r) => a + k.modelos.reduce((b, nivel) => b + C.estimarCosto(pedido(nivel, r, { nombre: 'documento', fragmentos: [{ id: 'F1', ubicacion: 'p', texto: fragmentos }] }, null)), 0), 0);
  return verificar + (informe ? estimarInforme(requisitos, config) : 0);
}
// Peor caso del informe: todos los requisitos son hallazgos y hay un segundo intento.
const estimarInforme = (requisitos, config) => 2 * C.estimarCosto(pedidoRecomendaciones(requisitos.map((r) => ({ requisito: r.id, estado: 'no_cumple', texto_requisito: r.texto, justificacion: 'x'.repeat(200) })), null, config));
// Presupuesto mínimo: el motor reserva cada paso con su margen (×1,25 o más) y deja un colchón (US$0,02 o 5%).
const minimo = (est) => Number((est * 1.6 + 0.02).toFixed(4));
function estimacion(d) {
  const e = validarEntrada(d);
  const por = Object.fromEntries(Object.keys(CONFIGS).map((k) => [k, Number(estimar({ requisitos: e.requisitos, config: k }).toFixed(4))]));
  const minimos = Object.fromEntries(Object.entries(por).map(([k, v]) => [k, minimo(v)]));
  return {
    por_configuracion: por, presupuesto_minimo: minimos,
    comparar_las_tres: Number(Object.values(por).reduce((a, b) => a + b, 0).toFixed(4)),
    presupuesto_minimo_comparar: Number(Object.values(minimos).reduce((a, b) => a + b, 0).toFixed(4)),
    configuraciones: Object.fromEntries(Object.entries(CONFIGS).map(([k, v]) => [k, v.nombre])),
    nota: 'Estimación del peor caso (incluye un segundo intento por requisito). El gasto real suele ser bastante menor.',
  };
}

function pasosDe(e, config) {
  const pasos = e.archivo_ids.map((id) => ({ clave: `extraer:${id}`, tipo: 'extraer', etapa: 'extracción', entrada: { archivo_id: id } }));
  pasos.push({ clave: 'seleccionar', tipo: 'aud_seleccionar', etapa: 'fragmentos', entrada: { archivo_ids: e.archivo_ids, requisitos: e.requisitos } });
  for (const r of e.requisitos) {
    const est = estimar({ requisitos: [r], config, informe: false });
    pasos.push({ clave: `verificar:${r.id}`, tipo: 'aud_verificar', etapa: 'verificación', entrada: { requisito: r, config }, estimado: Number(est.toFixed(6)) });
  }
  const huella = hash(JSON.stringify(e.requisitos));
  pasos.push({ clave: 'consolidar', tipo: 'aud_consolidar', etapa: 'consolidación', entrada: { requisitos: e.requisitos } });
  pasos.push({ clave: 'excel', tipo: 'aud_excel', etapa: 'entregables', entrada: { config, requisitos_hash: huella } });
  pasos.push({ clave: 'informe', tipo: 'aud_informe', etapa: 'entregables', entrada: { config, requisitos_hash: huella }, estimado: Number(estimarInforme(e.requisitos, config).toFixed(6)) });
  return pasos;
}

async function crearYAprobar(e, config, presupuesto, serie, propuesta) {
  const objetivo = { archivo_id: e.archivo_id, archivo_ids: e.archivo_ids, requisitos: e.requisitos, esperado: e.esperado, config, requisitos_hash: hash(JSON.stringify(e.requisitos)), informe: true, ...(serie ? { serie } : {}), ...(propuesta ? { propuesta } : {}) };
  const t = await Trabajos.crear({ tipo: 'auditoria', titulo: `Auditoría ${config} (${e.requisitos.length} requisitos, ${e.archivo_ids.length} documento${e.archivo_ids.length === 1 ? '' : 's'})`, objetivo, presupuesto, pasos: pasosDe(e, config) });
  return Trabajos.aprobar(t.id);
}

// configuracion: K1 | K2 | K3 | comparar (las tres en serie, una tras otra, con el presupuesto total aprobado).
async function crear(d) {
  const e = validarEntrada(d);
  const config = String(d.configuracion || 'K3');
  const presupuesto = Number(d.presupuesto);
  if (!(presupuesto > 0)) throw err('Indica el presupuesto aprobado (US$)');
  const est = estimacion(d);
  if (config === 'comparar') {
    if (presupuesto + 1e-9 < est.presupuesto_minimo_comparar) throw err(`El presupuesto (US$${presupuesto}) es menor que el mínimo para las tres (US$${est.presupuesto_minimo_comparar})`);
    const factor = presupuesto / est.presupuesto_minimo_comparar;
    const presupuestos = Object.fromEntries(Object.entries(est.presupuesto_minimo).map(([k, v]) => [k, Number((v * factor).toFixed(4))]));
    const serie = { id: crypto.randomUUID(), restantes: ['K2', 'K3'], presupuestos, total: presupuesto, datos: e };
    return crearYAprobar(e, 'K1', presupuestos.K1, serie);
  }
  if (!CONFIGS[config]) throw err('Configuración inválida (K1, K2, K3 o comparar)');
  if (presupuesto + 1e-9 < est.presupuesto_minimo[config]) throw err(`El presupuesto (US$${presupuesto}) es menor que el mínimo para ${config} (US$${est.presupuesto_minimo[config]})`);
  return crearYAprobar(e, config, presupuesto, null, d.propuesta || null);
}

// ---------- Fase 3e: requisitos extraídos de un documento normativo ----------
// Un encargo propio, aprobado aparte y barato: lee la norma (capa 3b), la divide en bloques y la IA (Sonnet)
// propone los requisitos de cada bloque con una cita textual de la norma, que el código verifica. Al terminar,
// la lista queda como PROPUESTA pendiente: Cristian la revisa, la corrige y la aprueba con el presupuesto de la
// auditoría. Nada se analiza contra los documentos antes de esa aprobación.
const BLOQUE_NORMA = 6000;
const MAX_BLOQUES_NORMA = 15;
function bloquesDeNorma(texto) {
  const frags = fragmentar(texto, 900);
  const bloques = [];
  let actual = null;
  for (const f of frags) {
    if (!actual || (actual.texto.length + f.texto.length > BLOQUE_NORMA)) { actual = { n: bloques.length + 1, desde: f.desde, texto: '', ubicaciones: [] }; bloques.push(actual); }
    actual.texto += `${actual.texto ? '\n' : ''}${f.texto}`;
    actual.hasta = f.hasta;
    if (!actual.ubicaciones.includes(f.ubicacion)) actual.ubicaciones.push(f.ubicacion);
  }
  return bloques;
}
const SISTEMA_REQ = `Eres analista normativa. Lees un bloque de una norma, pauta o reglamento y extraes los requisitos que debe cumplir el establecimiento, la persona o la entidad regulada, para auditarlos después con documentos. Responde solo con la herramienta registrar_requisitos.
Cada requisito:
- es una obligación verificable con documentos (qué debe existir, tener, contar, registrar o acreditar);
- una obligación por requisito: si un artículo contiene obligaciones distintas, sepáralas; si una obligación tiene partes ("en cada piso", "todo el personal"), mantenla junta;
- se redacta fiel a la norma, sin agregar ni quitar exigencias, conservando las condiciones ("si…", "cuando…");
- trae la referencia (artículo, número, letra o sección) y una cita textual corta de la norma copiada tal cual del bloque (máximo 300 caracteres).
No incluyas definiciones, objeto, vigencia, sanciones, procedimientos de la autoridad ni recomendaciones no obligatorias. Si el bloque no tiene requisitos, entrega una lista vacía.`;
const HERRAMIENTA_REQ = {
  name: 'registrar_requisitos',
  description: 'Entrega los requisitos del bloque.',
  input_schema: { type: 'object', properties: { requisitos: { type: 'array', items: { type: 'object', properties: {
    referencia: { type: 'string', description: 'p. ej. "Art. 5" o "Art. 4, letra b"' }, texto: { type: 'string', description: 'el requisito, fiel a la norma' },
    cita: { type: 'string', description: 'texto copiado tal cual del bloque' } }, required: ['referencia', 'texto', 'cita'] } } }, required: ['requisitos'] },
};
const pedidoReq = (bloque, nombre, nota) => ({ model: C.MODELO_PROFUNDO(), max_tokens: 4000, system: SISTEMA_REQ, tools: [HERRAMIENTA_REQ], tool_choice: { type: 'auto' },
  messages: [{ role: 'user', content: `Norma «${nombre}», bloque ${bloque.n} (${bloque.ubicaciones.join(', ')}):\n\n${bloque.texto}${nota ? `\n\n${nota}` : ''}` }] });
const estimarBloque = (b) => 2 * C.estimarCosto(pedidoReq({ ...b, texto: 'x'.repeat(b.texto.length) }, 'norma', null));

Object.assign(EJECUTORES, {
  // Un bloque de la norma → requisitos con cita verificada contra el bloque. Los que no se verifican se descartan
  // (y se informan); si todos fallan, se pide corregir una vez.
  async aud_req_bloque({ entrada, trabajoId, pasoId, senal }) {
    const Drive = require('./drive');
    const doc = await Drive.textoParaTrabajo(entrada.norma_id, { trabajoId, pasoId });
    if (String(doc.version) !== String(entrada.version)) throw new Error(`La norma cambió desde la propuesta (versión ${entrada.version} → ${doc.version}); vuelve a proponer la extracción.`);
    const bloque = bloquesDeNorma(doc.texto)[entrada.n - 1];
    if (!bloque || hash(bloque.texto) !== entrada.huella) throw new Error('El bloque de la norma no coincide con el propuesto');
    const ctx = { trabajoId, pasoId, senal };
    let costo = 0; let nota = null; let validos = []; let descartados = [];
    for (let intento = 1; intento <= 2; intento++) {
      const { resp, costo: c } = await llamar(pedidoReq(bloque, doc.nombre, nota), ctx, intento);
      costo += c;
      const b = (resp.content || []).find((x) => x.type === 'tool_use' && x.name === 'registrar_requisitos');
      if (!b) { nota = 'Responde solo con la herramienta registrar_requisitos.'; continue; }
      const lista = Array.isArray(b.input.requisitos) ? b.input.requisitos : [];
      validos = []; descartados = [];
      for (const r of lista) {
        const texto = String(r.texto || '').trim(); const cita = String(r.cita || '').trim(); const referencia = String(r.referencia || '').trim().slice(0, 60);
        const motivo = texto.length < 15 ? 'texto muy corto' : texto.length > 600 ? 'texto muy largo' : !cita ? 'sin cita' : cita.length > MAX_CITA ? 'cita muy larga' : !citaVerificada(cita, { texto: bloque.texto }) ? 'la cita no está en la norma' : null;
        if (motivo) descartados.push({ referencia, motivo }); else validos.push({ referencia, texto, cita, bloque: bloque.n, ubicacion: (fragmentar(bloque.texto, 900).find((f) => citaVerificada(cita, f)) || {}).ubicacion || bloque.ubicaciones[0] });
      }
      if (validos.length || !lista.length) break;
      nota = `Ningún requisito se pudo verificar (${descartados.slice(0, 3).map((x) => x.motivo).join('; ')}). Copia cada cita tal cual del bloque.`;
    }
    return { resultado: { bloque: bloque.n, requisitos: validos, descartados }, costo, llamadasRegistradas: true };
  },

  // Une los bloques: quita duplicados (mismo texto) y numera R1…Rn en el orden de la norma. Código, sin IA.
  async aud_req_consolidar({ previos }) {
    const todos = previos.filter((p) => p.clave.startsWith('req_bloque:') && p.resultado).sort((a, b) => a.resultado.bloque - b.resultado.bloque).flatMap((p) => p.resultado.requisitos);
    const vistos = new Set(); const lista = []; const duplicados = [];
    for (const r of todos) { const k = limpia(r.texto); if (vistos.has(k)) { duplicados.push(r.referencia); continue; } vistos.add(k); lista.push(r); }
    const exceso = Math.max(0, lista.length - MAX_REQUISITOS);
    const requisitos = lista.slice(0, MAX_REQUISITOS).map((r, i) => ({ id: `R${i + 1}`, texto: r.texto, fuente: `${r.referencia}: «${r.cita}»`, referencia: r.referencia, cita_norma: r.cita, ubicacion_norma: r.ubicacion }));
    const descartados = previos.filter((p) => p.clave.startsWith('req_bloque:') && p.resultado).flatMap((p) => p.resultado.descartados || []);
    return { resultado: { requisitos, total: requisitos.length, duplicados, descartados, exceso }, costo: 0 };
  },
});

async function verificarRequisitos(t, pasos, objetivo, { integridad }) {
  const problemas = integridad(pasos);
  const p = pasos.filter((x) => x.tipo === 'aud_req_consolidar').pop();
  const r = p && p.resultado_cifrado ? Cifrado.descifrarJSON(p.resultado_cifrado) : null;
  if (!r) problemas.push('no hay lista de requisitos');
  else {
    if (!r.requisitos.length) problemas.push('no se encontró ningún requisito verificable en la norma');
    const ids = r.requisitos.map((x) => x.id);
    if (new Set(ids).size !== ids.length) problemas.push('ids de requisito repetidos');
    if (new Set(r.requisitos.map((x) => limpia(x.texto))).size !== ids.length) problemas.push('requisitos duplicados');
    for (const x of r.requisitos) if (!x.cita_norma || !x.referencia) problemas.push(`${x.id}: sin referencia o cita de la norma`);
  }
  const costos = await costosDe(t.id);
  return { ok: !problemas.length, problemas, matriz: null, extra: { modo: 'requisitos', lista: r, costos } };
}

// Serie de comparación: al completar una configuración, empieza la siguiente (presupuesto ya aprobado).
async function alTerminar(t, final) {
  const objetivo = Cifrado.descifrarJSON(t.objetivo_cifrado) || {};
  if (objetivo.modo === 'requisitos') return listaParaAprobar(t, objetivo, final);
  // Aviso al teléfono (Fase 3d): la auditoría terminó y el Excel está listo en el chat.
  if (process.env.ADA_AVISOS !== 'no' && !objetivo.serie) {
    const resumen = final && final.matriz ? final.matriz.filas.map((f) => `${f.requisito}: ${f.estado}`).join(' · ') : '';
    require('./avisos').enviar({ titulo: 'Auditoría lista', cuerpo: `${resumen}. El Excel está en el chat.`.slice(0, 200), url: '/', tag: `auditoria-${t.id.slice(0, 8)}` }).catch(() => {});
  }
  const serie = objetivo.serie;
  if (!serie || !serie.restantes || !serie.restantes.length) return;
  const [siguiente, ...resto] = serie.restantes;
  await crearYAprobar(serie.datos, siguiente, serie.presupuestos[siguiente], { ...serie, restantes: resto });
}

async function listar() {
  const filas = await qPrincipal("SELECT id FROM trabajos WHERE usuario_id = ? AND tipo = 'auditoria' ORDER BY creado_en DESC LIMIT 12", [usuario().id]);
  const out = [];
  for (const f of filas) {
    let v;
    try { v = await Trabajos.ver(f.id, { conResultado: true }); } catch (e) {
      if (e.sinClave) { out.push({ id: f.id, estado: 'ilegible', motivo: 'cifrado con otra clave (ADA_CLAVE_DATOS cambió)' }); continue; }
      throw e;
    }
    const r = v.resultado || {};
    // Avance paso a paso (también en encargos cancelados o bloqueados): qué quedó hecho y qué resultado se conservó.
    const pasosFilas = await qPrincipal('SELECT clave, tipo, estado, intentos, error, costo_usd, resultado_cifrado FROM trabajo_pasos WHERE trabajo_id = ? ORDER BY orden', [f.id]);
    const pasos_detalle = pasosFilas.map((p) => {
      const d = { paso: p.clave, estado: p.estado, intentos: p.intentos, costo_usd: Number(p.costo_usd || 0), ...(p.error ? { error: String(p.error).slice(0, 160) } : {}) };
      if (p.tipo === 'aud_verificar' && p.estado === 'hecho' && p.resultado_cifrado) {
        try { const x = Cifrado.descifrarJSON(p.resultado_cifrado); Object.assign(d, { resultado: x.estado, cita_verificada: !!x.cita_verificada, modelo: x.modelo }); } catch (_) {}
      }
      return d;
    });
    out.push({ pasos_detalle, id: v.id, titulo: v.titulo, estado: v.estado, estado_real: v.estado_real, motivo: v.motivo, pasos: v.pasos, presupuesto_usd: v.presupuesto_usd, gastado_usd: v.gastado_usd,
      reservado_usd: v.reservado_usd, config: r.config || (v.titulo.match(/K\d/) || [])[0], precision: r.precision || null, costos: r.costos || (await costosDe(v.id)), escalados: r.escalados, modelos: r.modelos,
      matriz: r.matriz ? r.matriz.filas.map((x) => ({ requisito: x.requisito, estado: x.estado, cita_verificada: x.cita_verificada, modelo: x.modelo, ubicacion: x.ubicacion })) : null,
      creado_en: v.creado_en, terminado_en: v.terminado_en });
  }
  return out;
}

async function informe(trabajoId) {
  const v = await Trabajos.ver(trabajoId);
  if (v.tipo !== 'auditoria') throw err('No es una auditoría', 404);
  const [p] = await qPrincipal("SELECT resultado_cifrado FROM trabajo_pasos WHERE trabajo_id = ? AND tipo = 'aud_informe' AND estado = 'hecho'", [trabajoId]);
  if (!p || v.estado !== 'completado') throw err('El informe todavía no está listo', 404);
  const e = Cifrado.descifrarJSON(p.resultado_cifrado);
  return { nombre: `informe-auditoria-${trabajoId.slice(0, 8)}.docx`, datos: Buffer.from(e.docx_b64, 'base64') };
}

async function excel(trabajoId) {
  const v = await Trabajos.ver(trabajoId);
  if (v.tipo !== 'auditoria') throw err('No es una auditoría', 404);
  const [p] = await qPrincipal("SELECT resultado_cifrado FROM trabajo_pasos WHERE trabajo_id = ? AND tipo = 'aud_excel' AND estado = 'hecho'", [trabajoId]);
  if (!p) throw err('El Excel todavía no está listo', 404);
  const e = Cifrado.descifrarJSON(p.resultado_cifrado);
  return { nombre: `auditoria-${trabajoId.slice(0, 8)}.xlsx`, datos: Buffer.from(e.xlsx_b64, 'base64') };
}

// ---------- Fase 3d: desde la conversación ----------
// ADA propone (archivos, requisitos, configuración y presupuesto sugerido); Cristian aprueba con un botón.
// Nada se ejecuta ni se gasta hasta esa aprobación.

const CONFIG_PROVISIONAL = 'K1'; // decisión del 29/10: K1 para auditorías de cumplimiento hasta tener más evidencia

async function archivosDeLaPropuesta(d) {
  const Drive = require('./drive');
  const Extracciones = require('./extracciones');
  let ids = Array.isArray(d.archivo_ids) ? d.archivo_ids.filter(Boolean).map(String) : [];
  if (d.archivo_id) ids.push(String(d.archivo_id));
  const archivos = [];
  if (d.carpeta_id) {
    // Una carpeta: sus documentos con texto (hasta el máximo), en orden.
    const lista = await Drive.DRIVE_EXTRACCION.metadatos(String(d.carpeta_id));
    if (lista.mimeType !== 'application/vnd.google-apps.folder') throw err('carpeta_id no es una carpeta');
    const H = require('./herramientas');
    const r = await H.ejecutar('listar_carpeta_drive', { carpeta_id: String(d.carpeta_id) }, {});
    if (r.error) throw err(r.error);
    ids = ids.concat((r.archivos || []).map((a) => a.id));
  }
  ids = [...new Set(ids)];
  for (const id of ids) {
    let meta;
    try { meta = await Drive.metadatos(id); } catch (e) { throw err(`No puedo ver el archivo ${id}: ${e.message}`); }
    if (Extracciones.modo() === 'prueba' && !Extracciones.enCarpetaDePrueba(meta)) throw err(`«${meta.name}» está fuera de la carpeta autorizada para la prueba: durante la prueba solo se auditan documentos de esa carpeta.`, 403);
    if (Drive.DRIVE_EXTRACCION.leible(meta)) archivos.push({ id: meta.id, nombre: meta.name });
  }
  if (!archivos.length) throw err('No encontré documentos con texto para auditar.');
  if (archivos.length > MAX_ARCHIVOS) throw err(`Son ${archivos.length} documentos; en esta etapa el máximo es ${MAX_ARCHIVOS}. Elige cuáles.`);
  return archivos;
}

// Propuesta de extraer los requisitos de una norma (paso 1 de una auditoría "con norma"). La norma se lee aquí
// con la capa 3b (código, sin IA) para saber cuántos bloques tiene y estimar el costo; la extracción con IA
// empieza solo con el botón Aprobar.
async function proponerExtraccion(d, ctx) {
  const Drive = require('./drive');
  const Extracciones = require('./extracciones');
  let meta;
  try { meta = await Drive.metadatos(String(d.norma_id)); } catch (e) { throw err(`No puedo ver la norma: ${e.message}`); }
  if (Extracciones.modo() === 'prueba' && !Extracciones.enCarpetaDePrueba(meta)) throw err(`«${meta.name}» está fuera de la carpeta autorizada para la prueba.`, 403);
  const archivos = (await archivosDeLaPropuesta({ ...d, norma_id: undefined })).filter((a) => a.id !== meta.id);
  if (!archivos.length) throw err('Faltan los documentos a auditar (además de la norma).');
  const doc = await Drive.textoParaTrabajo(meta.id, { conversacionId: ctx.conversacionId });
  const bloques = bloquesDeNorma(doc.texto);
  if (!bloques.length) throw err('La norma no tiene texto extraíble.');
  if (bloques.length > MAX_BLOQUES_NORMA) throw err(`La norma es muy larga para esta etapa (${doc.texto.length} caracteres, ${bloques.length} bloques; máximo ${MAX_BLOQUES_NORMA}).`);
  const extraccion = bloques.reduce((a, b) => a + estimarBloque(b), 0);
  // Referencia (no se aprueba aquí): una auditoría K1 de ~1 requisito por cada 450 caracteres de norma.
  const aprox = estimar({ requisitos: Array.from({ length: Math.min(MAX_REQUISITOS, Math.max(1, Math.round(doc.texto.length / 450))) }, (_, i) => ({ id: `R${i + 1}`, texto: 'x'.repeat(120) })), config: CONFIG_PROVISIONAL });
  const datos = {
    tipo: 'extraer_requisitos', archivos, config: CONFIG_PROVISIONAL, motivo: String(d.motivo || '').slice(0, 300),
    norma: { id: meta.id, nombre: doc.nombre, version: doc.version, caracteres: doc.texto.length, bloques: bloques.map((b) => ({ n: b.n, huella: hash(b.texto), caracteres: b.texto.length, ubicaciones: b.ubicaciones })) },
    estimacion: { extraccion_usd: Number(extraccion.toFixed(4)), presupuesto_minimo: minimo(extraccion), auditoria_aprox_usd: Number(aprox.toFixed(3)) },
  };
  const id = crypto.randomUUID();
  const puedeMostrar = Array.isArray(ctx.tarjetas) && ctx.tarjetas.includes(TARJETA);
  await qPrincipal('INSERT INTO auditoria_propuestas (id, usuario_id, conversacion_id, estado, datos_cifrado, tarjeta_estado, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, usuario().id, ctx.conversacionId || null, 'pendiente', Cifrado.cifrarJSON(datos), puedeMostrar ? 'enviada' : 'no_soportada', new Date(), new Date()]);
  const tarjeta = tarjetaDe(id, datos);
  if (puedeMostrar && typeof ctx.emitir === 'function') ctx.emitir('auditoria_propuesta', tarjeta);
  const base = { propuesta_id: id, tipo: 'extraer_requisitos', norma: doc.nombre, bloques: bloques.length, archivos: archivos.map((a) => a.nombre),
    presupuesto_sugerido_usd: tarjeta.presupuesto_sugerido, auditoria_aprox_usd: datos.estimacion.auditoria_aprox_usd, estado: 'pendiente_de_aprobacion', trabajo: null };
  if (!puedeMostrar) return { ...base, ok: false, tarjeta: 'no_disponible', nota: 'Quedó PENDIENTE, pero esta versión de la app no puede mostrar la tarjeta. NO digas que hay tarjeta; dile que cierre y vuelva a abrir ADA. Nada empezó ni se cobró.' };
  return { ...base, ok: true, tarjeta: 'enviada',
    nota: 'Es el paso 1 de 2: extraer los requisitos de la norma. Dile que debería ver la tarjeta "Extraer requisitos" con su costo y un botón Aprobar; que al terminar le mostraré la lista para revisarla y aprobarla junto con el presupuesto de la auditoría (paso 2), y que nada se analiza contra sus documentos antes de eso. Si no ve la tarjeta, que cierre y abra ADA. No ha empezado ni se ha cobrado nada.' };
}

// Al terminar la extracción: la lista queda como propuesta de auditoría PENDIENTE (paso 2), en la misma conversación.
async function listaParaAprobar(t, objetivo, final) {
  try { await crearListaParaAprobar(t, objetivo, final); } catch (e) {
    // Que no quede en silencio: el avance lo muestra y se puede reintentar sin volver a pagar la extracción.
    await Trabajos.evento(t.id, 'lista_error', String(e.message).slice(0, 300), null, 'ada').catch(() => {});
    throw e;
  }
}
async function crearListaParaAprobar(t, objetivo, final) {
  const lista = final && final.lista ? final.lista : null;
  if (!lista || !lista.requisitos.length) return;
  const archivos = objetivo.archivos;
  const e = validarEntrada({ archivo_ids: archivos.map((a) => a.id), requisitos: lista.requisitos });
  const est = estimacion({ archivo_ids: e.archivo_ids, requisitos: e.requisitos });
  const id = crypto.randomUUID();
  const datos = { tipo: 'auditoria', archivos, requisitos: e.requisitos, config: objetivo.config || CONFIG_PROVISIONAL, motivo: `Requisitos extraídos de «${objetivo.norma.nombre}»`,
    estimacion: est, origen: { extraccion_trabajo: t.id, extraccion_propuesta: objetivo.propuesta && objetivo.propuesta.id, norma: { id: objetivo.norma.id, nombre: objetivo.norma.nombre, version: objetivo.norma.version },
      duplicados: lista.duplicados.length, descartados: lista.descartados.length, exceso: lista.exceso } };
  await qPrincipal('INSERT INTO auditoria_propuestas (id, usuario_id, conversacion_id, estado, datos_cifrado, tarjeta_estado, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, usuario().id, objetivo.propuesta ? objetivo.propuesta.conversacion_id : null, 'pendiente', Cifrado.cifrarJSON(datos), 'por_mostrar', new Date(), new Date()]);
  await Trabajos.evento(t.id, 'lista_propuesta', `${e.requisitos.length} requisitos para aprobar (propuesta ${id.slice(0, 8)})`, null, 'ada').catch(() => {});
  if (process.env.ADA_AVISOS !== 'no') require('./avisos').enviar({ titulo: 'Requisitos listos para revisar', cuerpo: `Extraje ${e.requisitos.length} requisitos de «${objetivo.norma.nombre}». Revísalos y aprueba la auditoría en el chat.`, url: '/', tag: `auditoria-${id.slice(0, 8)}` }).catch(() => {});
}

// Versión de tarjeta que el cliente declara saber mostrar. Si la app abierta no la declara (por ejemplo,
// quedó abierta con una versión anterior), la propuesta se guarda igual, pero ADA NO dice que hay tarjeta.
const TARJETA = 'auditoria_propuesta@1';

function tarjetaDe(id, datos, estado = 'pendiente') {
  const est = datos.estimacion;
  if (datos.tipo === 'extraer_requisitos') {
    return { id, estado, tipo: 'extraer_requisitos', norma: { id: datos.norma.id, nombre: datos.norma.nombre, caracteres: datos.norma.caracteres, bloques: datos.norma.bloques.length },
      archivos: datos.archivos, estimado_usd: est.extraccion_usd, presupuesto_sugerido: Math.ceil(est.presupuesto_minimo * 100) / 100, presupuesto_minimo: est.presupuesto_minimo,
      estimado_auditoria_usd: est.auditoria_aprox_usd, motivo: datos.motivo };
  }
  return { tipo: 'auditoria', origen: datos.origen || null, id, estado, archivos: datos.archivos, requisitos: datos.requisitos, configuracion: datos.config, configuraciones: est.configuraciones,
    estimados: est.por_configuracion, estimado_usd: est.por_configuracion[datos.config],
    presupuesto_sugerido: Math.ceil(est.presupuesto_minimo[datos.config] * 100) / 100, presupuesto_minimo: est.presupuesto_minimo, motivo: datos.motivo };
}

async function proponer(d, ctx = {}) {
  if (usuario().id !== 1) throw err('La auditoría está disponible solo para la cuenta principal en esta etapa.', 403);
  if (d.norma_id && !(Array.isArray(d.requisitos) && d.requisitos.length)) return proponerExtraccion(d, ctx);
  const archivos = await archivosDeLaPropuesta(d);
  const config = CONFIGS[d.configuracion] ? d.configuracion : CONFIG_PROVISIONAL;
  const e = validarEntrada({ archivo_ids: archivos.map((a) => a.id), requisitos: d.requisitos });
  const est = estimacion({ archivo_ids: e.archivo_ids, requisitos: e.requisitos });
  const id = crypto.randomUUID();
  const datos = { archivos, requisitos: e.requisitos, config, motivo: String(d.motivo || '').slice(0, 300), estimacion: est };
  const puedeMostrar = Array.isArray(ctx.tarjetas) && ctx.tarjetas.includes(TARJETA);
  await qPrincipal('INSERT INTO auditoria_propuestas (id, usuario_id, conversacion_id, estado, datos_cifrado, tarjeta_estado, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, usuario().id, ctx.conversacionId || null, 'pendiente', Cifrado.cifrarJSON(datos), puedeMostrar ? 'enviada' : 'no_soportada', new Date(), new Date()]);
  const tarjeta = tarjetaDe(id, datos);
  if (puedeMostrar && typeof ctx.emitir === 'function') ctx.emitir('auditoria_propuesta', tarjeta);
  const base = {
    propuesta_id: id, archivos: archivos.map((a) => a.nombre), requisitos: e.requisitos.length, configuracion: config,
    presupuesto_sugerido_usd: tarjeta.presupuesto_sugerido, estado: 'pendiente_de_aprobacion', trabajo: null,
  };
  if (!puedeMostrar) {
    return { ...base, ok: false, tarjeta: 'no_disponible',
      nota: 'La propuesta quedó guardada como PENDIENTE, pero la app abierta en el teléfono es una versión anterior que no puede mostrar la tarjeta de aprobación. NO digas que hay una tarjeta en pantalla. Dile que cierre ADA por completo y la vuelva a abrir: la propuesta pendiente aparecerá sola en el chat (y también en Ajustes → Auditoría → Propuestas pendientes). Nada empezó ni se cobró.' };
  }
  return { ...base, ok: true, tarjeta: 'enviada',
    nota: 'Envié la tarjeta a la app. Aún no sé si se dibujó: dile que debería ver la tarjeta "Auditoría propuesta" con un botón Aprobar y que, si no la ve, cierre y vuelva a abrir ADA (o la busque en Ajustes → Auditoría → Propuestas pendientes). NO ha empezado ni se ha cobrado nada; empieza solo con el botón. Dilo en una o dos frases.' };
}

async function propuesta(id) {
  const [p] = await qPrincipal('SELECT * FROM auditoria_propuestas WHERE id = ? AND usuario_id = ?', [id, usuario().id]);
  if (!p) throw err('No existe esa propuesta', 404);
  return { ...p, datos: Cifrado.descifrarJSON(p.datos_cifrado), aprobacion: p.aprobacion_cifrada ? Cifrado.descifrarJSON(p.aprobacion_cifrada) : null };
}

// La app confirma que dibujó la tarjeta (o que falló al dibujarla). Es evidencia, no autoriza nada.
async function marcarTarjeta(id, { estado } = {}) {
  const e = ['mostrada', 'error_al_mostrar'].includes(estado) ? estado : 'mostrada';
  await propuesta(id);
  await qPrincipal('UPDATE auditoria_propuestas SET tarjeta_estado = ?, tarjeta_en = ? WHERE id = ? AND usuario_id = ?', [e, new Date(), id, usuario().id]);
  return { ok: true };
}

// La aprobación es el botón de la tarjeta: requisitos (posiblemente editados), configuración y presupuesto explícitos.
// Se "reclama" la propuesta de forma atómica, así dos toques simultáneos no crean dos encargos.
async function aprobarPropuesta(id, { presupuesto, requisitos, configuracion, origen } = {}, cliente = {}) {
  const enAprobacion = new Date().toISOString(); // el momento del botón, antes de crear el trabajo
  const p = await propuesta(id);
  const datos = p.datos;
  const via = ['tarjeta_chat', 'ajustes_pendientes'].includes(origen) ? origen : 'api';
  const deQuien = { via, usuario_id: usuario().id, app: /; wv\)/.test(cliente.ua || '') ? 'android' : cliente.ua ? 'navegador' : 'desconocida' };
  if (datos.tipo === 'extraer_requisitos') return aprobarExtraccion(p, Number(presupuesto), deQuien, enAprobacion);
  // Los requisitos editados en la tarjeta conservan su fuente en la norma (por id).
  const conFuente = (lista) => lista.map((r) => { const o = (datos.requisitos || []).find((x) => x.id === String(r.id || '').trim()); return o && o.fuente && !r.fuente ? { ...r, fuente: o.fuente } : r; });
  const aprobado = { archivo_ids: datos.archivos.map((a) => a.id), requisitos: requisitos && requisitos.length ? conFuente(requisitos) : datos.requisitos,
    configuracion: configuracion || datos.config, presupuesto: Number(presupuesto) };
  const e = validarEntrada(aprobado);
  if (!CONFIGS[aprobado.configuracion]) throw err('Configuración inválida (K1, K2 o K3)');
  const r = await qPrincipal("UPDATE auditoria_propuestas SET estado = 'aprobando', actualizado_en = ? WHERE id = ? AND usuario_id = ? AND estado = 'pendiente'", [new Date(), id, usuario().id]);
  if (!r.affectedRows) throw err(`La propuesta ya está "${p.estado}"`, 409);
  let trabajo;
  try {
    trabajo = await crear({ ...aprobado, requisitos: e.requisitos, propuesta: { id, conversacion_id: p.conversacion_id } });
  } catch (x) {
    await qPrincipal("UPDATE auditoria_propuestas SET estado = 'pendiente', actualizado_en = ? WHERE id = ? AND estado = 'aprobando'", [new Date(), id]);
    throw x;
  }
  // Origen de la aprobación: siempre una solicitud autenticada de la persona (ninguna herramienta de ADA aprueba).
  const constancia = { requisitos: e.requisitos, requisitos_hash: hash(JSON.stringify(e.requisitos)), configuracion: aprobado.configuracion, modelos: CONFIGS[aprobado.configuracion].modelos.map(modeloDe),
    presupuesto: aprobado.presupuesto, en: enAprobacion, origen: deQuien };
  await Trabajos.evento(trabajo.id, 'propuesta_aprobada', `propuesta ${id.slice(0, 8)} aprobada desde ${via}`, aprobado.presupuesto, `u${usuario().id}`).catch(() => {});
  await qPrincipal("UPDATE auditoria_propuestas SET estado = 'aprobada', trabajo_id = ?, aprobacion_cifrada = ?, actualizado_en = ? WHERE id = ?", [trabajo.id, Cifrado.cifrarJSON(constancia), new Date(), id]);
  return { ok: true, propuesta_id: id, trabajo_id: trabajo.id, estado: trabajo.estado, configuracion: aprobado.configuracion, presupuesto: aprobado.presupuesto };
}

async function aprobarExtraccion(p, presupuesto, deQuien, enAprobacion) {
  const datos = p.datos;
  if (!(presupuesto > 0)) throw err('Indica el presupuesto aprobado (US$)');
  if (presupuesto + 1e-9 < datos.estimacion.presupuesto_minimo) throw err(`El presupuesto (US$${presupuesto}) es menor que el mínimo para extraer (US$${datos.estimacion.presupuesto_minimo})`);
  const r = await qPrincipal("UPDATE auditoria_propuestas SET estado = 'aprobando', actualizado_en = ? WHERE id = ? AND usuario_id = ? AND estado = 'pendiente'", [new Date(), p.id, usuario().id]);
  if (!r.affectedRows) throw err(`La propuesta ya está "${p.estado}"`, 409);
  const n = datos.norma;
  const bloquesHash = hash(JSON.stringify(n.bloques.map((b) => b.huella)));
  let trabajo;
  try {
    const pasos = [{ clave: `extraer:${n.id}`, tipo: 'extraer', etapa: 'lectura de la norma', entrada: { archivo_id: n.id } }];
    for (const b of n.bloques) pasos.push({ clave: `req_bloque:${b.n}`, tipo: 'aud_req_bloque', etapa: 'requisitos', entrada: { norma_id: n.id, version: n.version, n: b.n, huella: b.huella }, estimado: Number(estimarBloque({ n: b.n, texto: 'x'.repeat(b.caracteres), ubicaciones: b.ubicaciones }).toFixed(6)) });
    pasos.push({ clave: 'req_consolidar', tipo: 'aud_req_consolidar', etapa: 'lista', entrada: {} });
    const objetivo = { modo: 'requisitos', norma: { id: n.id, nombre: n.nombre, version: n.version }, archivos: datos.archivos, config: datos.config, bloques_hash: bloquesHash, propuesta: { id: p.id, conversacion_id: p.conversacion_id } };
    const t = await Trabajos.crear({ tipo: 'auditoria', titulo: `Extraer requisitos de «${n.nombre}»`.slice(0, 200), objetivo, presupuesto, pasos });
    trabajo = await Trabajos.aprobar(t.id);
  } catch (x) {
    await qPrincipal("UPDATE auditoria_propuestas SET estado = 'pendiente', actualizado_en = ? WHERE id = ? AND estado = 'aprobando'", [new Date(), p.id]);
    throw x;
  }
  const constancia = { tipo: 'extraer_requisitos', norma: { id: n.id, version: n.version }, bloques_hash: bloquesHash, configuracion: 'extracción', modelos: [modeloDe('profundo')], presupuesto, en: enAprobacion, origen: deQuien, requisitos: [], requisitos_hash: null };
  await Trabajos.evento(trabajo.id, 'propuesta_aprobada', `propuesta ${p.id.slice(0, 8)} aprobada desde ${deQuien.via}`, presupuesto, `u${usuario().id}`).catch(() => {});
  await qPrincipal("UPDATE auditoria_propuestas SET estado = 'aprobada', trabajo_id = ?, aprobacion_cifrada = ?, actualizado_en = ? WHERE id = ?", [trabajo.id, Cifrado.cifrarJSON(constancia), new Date(), p.id]);
  return { ok: true, propuesta_id: p.id, trabajo_id: trabajo.id, estado: trabajo.estado, tipo: 'extraer_requisitos', configuracion: 'extracción', presupuesto };
}

async function descartarPropuesta(id) {
  const r = await qPrincipal("UPDATE auditoria_propuestas SET estado = 'descartada', actualizado_en = ? WHERE id = ? AND usuario_id = ? AND estado = 'pendiente'", [new Date(), id, usuario().id]);
  if (!r.affectedRows) { const p = await propuesta(id); throw err(`La propuesta ya está "${p.estado}"`, 409); }
  return { ok: true };
}

// Constancia de aprobación (gobernanza): reconstruye desde los registros guardados que la propuesta se aprobó
// con un acto de la persona, con qué requisitos, modelo y presupuesto, y que eso ocurrió ANTES del primer paso
// y de la primera llamada de IA del trabajo. Solo lee; no ejecuta nada.
async function constancia(idOPrefijo) {
  const ref = String(idOPrefijo || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{8,36}$/.test(ref)) throw err('Indica el id de la propuesta (al menos 8 caracteres)');
  const filas = await qPrincipal('SELECT id FROM auditoria_propuestas WHERE usuario_id = ? AND id LIKE ?', [usuario().id, `${ref}%`]);
  if (!filas.length) throw err('No encontré esa propuesta', 404);
  if (filas.length > 1) throw err('Hay más de una propuesta con ese comienzo; usa más caracteres', 409);
  const p = await propuesta(filas[0].id);
  const ms = (d) => (d ? new Date(d).getTime() : null);
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  const out = {
    propuesta: { id: p.id, conversacion_id: p.conversacion_id, estado: p.estado, creada_en: iso(p.creado_en), tarjeta: p.tarjeta_estado, tarjeta_en: iso(p.tarjeta_en),
      propuesto: { tipo: p.datos.tipo || 'auditoria', configuracion: p.datos.config, requisitos: (p.datos.requisitos || []).map((r) => r.id), archivos: p.datos.archivos.map((a) => a.nombre), ...(p.datos.norma ? { norma: p.datos.norma.nombre } : {}), ...(p.datos.origen ? { extraidos_por_trabajo: p.datos.origen.extraccion_trabajo } : {}) } },
    aprobacion: p.aprobacion ? { en: p.aprobacion.en, origen: p.aprobacion.origen || 'no registrado (aprobada antes de que se guardara el origen)', configuracion: p.aprobacion.configuracion,
      modelos: p.aprobacion.modelos || CONFIGS[p.aprobacion.configuracion].modelos.map(modeloDe), presupuesto_usd: p.aprobacion.presupuesto,
      requisitos: p.aprobacion.requisitos.map((r) => `${r.id}: ${r.texto}`), requisitos_hash: p.aprobacion.requisitos_hash } : null,
    trabajo: null, comprobaciones: [],
  };
  const chequeo = (ok, que) => out.comprobaciones.push(`${ok ? '✓' : '✗'} ${que}`);
  chequeo(!!p.aprobacion, 'la aprobación quedó guardada (cifrada) con fecha, requisitos, configuración y presupuesto');
  if (!p.trabajo_id) { chequeo(p.estado !== 'aprobada', 'sin trabajo asociado'); out.resultado = out.comprobaciones.every((c) => c.startsWith('✓')) ? 'correcto' : 'revisar'; return out; }
  const [t] = await qPrincipal('SELECT id, estado, titulo, presupuesto_usd, objetivo_cifrado, creado_en, aprobado_en FROM trabajos WHERE id = ?', [p.trabajo_id]);
  const eventos = await qPrincipal('SELECT tipo, detalle, actor, creado_en FROM trabajo_eventos WHERE trabajo_id = ? ORDER BY id', [p.trabajo_id]);
  const [primerPaso] = await qPrincipal('SELECT clave, inicio FROM trabajo_pasos WHERE trabajo_id = ? AND inicio IS NOT NULL ORDER BY inicio LIMIT 1', [p.trabajo_id]);
  const [primeraIA] = await qPrincipal('SELECT l.modelo, l.creado_en, p.inicio AS inicio_paso FROM llamadas_ia l LEFT JOIN trabajo_pasos p ON p.id = l.paso_id WHERE l.trabajo_id = ? ORDER BY l.creado_en, p.inicio LIMIT 1', [p.trabajo_id]);
  const modelosUsados = (await qPrincipal('SELECT DISTINCT modelo FROM llamadas_ia WHERE trabajo_id = ?', [p.trabajo_id])).map((x) => x.modelo);
  const obj = Cifrado.descifrarJSON(t.objetivo_cifrado) || {};
  out.trabajo = { id: t.id, estado: t.estado, configuracion: obj.config, presupuesto_usd: Number(t.presupuesto_usd), creado_en: iso(t.creado_en), aprobado_en: iso(t.aprobado_en),
    primer_paso: primerPaso ? { paso: primerPaso.clave, inicio: iso(primerPaso.inicio) } : null, primera_llamada_ia: primeraIA ? { modelo: primeraIA.modelo, en: iso(primeraIA.creado_en) } : null,
    modelos_usados: modelosUsados, eventos: eventos.map((e) => `${iso(e.creado_en)} · ${e.tipo}${e.detalle ? ` (${e.detalle})` : ''} · ${e.actor || '—'}`) };
  const a = p.aprobacion || {};
  const tAprob = ms(a.en);
  chequeo(obj.propuesta && obj.propuesta.id === p.id, 'el trabajo guarda esta propuesta como su origen');
  if (a.tipo === 'extraer_requisitos') {
    chequeo(obj.modo === 'requisitos' && obj.norma.id === a.norma.id && String(obj.norma.version) === String(a.norma.version) && obj.bloques_hash === a.bloques_hash, 'el trabajo extrae de la misma norma, versión y bloques aprobados');
  } else {
    chequeo(obj.requisitos_hash === a.requisitos_hash, 'el trabajo usa exactamente los requisitos aprobados');
    chequeo(obj.config === a.configuracion, `configuración aprobada = ejecutada (${a.configuracion})`);
  }
  chequeo(Math.abs(Number(t.presupuesto_usd) - Number(a.presupuesto)) < 1e-9, `presupuesto aprobado = del trabajo (US$${a.presupuesto})`);
  const esperados = (a.modelos || CONFIGS[a.configuracion] && CONFIGS[a.configuracion].modelos.map(modeloDe) || []);
  chequeo(modelosUsados.every((m) => esperados.includes(m)), `modelos usados dentro de los aprobados (${modelosUsados.join(', ') || 'ninguno'})`);
  chequeo(eventos.some((e) => e.tipo === 'aprobar' && /^u\d+$/.test(e.actor || '')), 'el registro del trabajo tiene el evento "aprobar" hecho por la persona');
  chequeo(ms(p.creado_en) <= ms(t.creado_en), 'la propuesta existía antes de crear el trabajo');
  if (primerPaso) chequeo(ms(t.aprobado_en) <= ms(primerPaso.inicio), `aprobado (${iso(t.aprobado_en)}) antes del primer paso (${iso(primerPaso.inicio)})`);
  // llamadas_ia guarda la hora al segundo: se compara con el segundo de la aprobación y, además, con el paso de esa llamada.
  if (primeraIA) chequeo(Math.floor(ms(t.aprobado_en) / 1000) * 1000 <= ms(primeraIA.creado_en) && (!primeraIA.inicio_paso || ms(t.aprobado_en) <= ms(primeraIA.inicio_paso)), 'aprobado antes de la primera llamada de IA del trabajo');
  if (tAprob && primerPaso) chequeo(Math.abs(tAprob - ms(t.aprobado_en)) < 60000, 'la constancia de la propuesta y la aprobación del trabajo coinciden (mismo acto)');
  out.resultado = out.comprobaciones.every((c) => c.startsWith('✓')) ? 'correcto' : 'revisar';
  return out;
}

// Avance real de un trabajo (desde la base). Siempre dice a qué propuesta y conversación pertenece.
async function avance(trabajoId) {
  if (!trabajoId) throw err('Falta el id del trabajo');
  const v = await Trabajos.ver(trabajoId, { conResultado: true });
  if (v.tipo !== 'auditoria') throw err('No es una auditoría', 404);
  const [prop] = await qPrincipal('SELECT id, conversacion_id FROM auditoria_propuestas WHERE trabajo_id = ? AND usuario_id = ?', [trabajoId, usuario().id]);
  const pasos = v.detalle_pasos;
  const verif = pasos.filter((p) => p.tipo === 'aud_verificar');
  const bloques = pasos.filter((p) => p.tipo === 'aud_req_bloque');
  const r = v.resultado || {};
  const costos = r.costos || await costosDe(trabajoId);
  let siguiente = null;
  if (bloques.length && v.estado === 'completado') {
    const todas = await qPrincipal('SELECT id, datos_cifrado, estado FROM auditoria_propuestas WHERE usuario_id = ? AND creado_en >= ? ORDER BY creado_en', [usuario().id, v.creado_en]);
    for (const x of todas) { try { const d = Cifrado.descifrarJSON(x.datos_cifrado); if (d.origen && d.origen.extraccion_trabajo === v.id) siguiente = { propuesta_id: x.id, estado: x.estado, requisitos: d.requisitos.length }; } catch (_) {} }
  }
  const errorLista = bloques.length && v.estado === 'completado' && !siguiente ? (v.eventos.filter((e) => e.tipo === 'lista_error').pop() || {}).detalle || null : null;
  return {
    modo: bloques.length ? 'requisitos' : 'auditoria', ...(errorLista ? { lista_error: errorLista } : {}), bloques_hechos: bloques.filter((p) => p.estado === 'hecho').length, bloques_total: bloques.length, lista_propuesta: siguiente,
    informe_listo: v.estado === 'completado' && pasos.some((p) => p.tipo === 'aud_informe' && p.estado === 'hecho'),
    conteo: r.conteo || null,
    hay: true, id: v.id, propuesta_id: prop ? prop.id : null, conversacion_id: prop ? prop.conversacion_id : null,
    estado: v.estado, estado_real: v.estado_real, motivo: v.motivo, etapa: v.etapa,
    pasos_hechos: v.pasos.hechos, pasos_total: v.pasos.total,
    requisitos_evaluados: verif.filter((p) => p.estado === 'hecho').length, requisitos_total: verif.length,
    costo_real_usd: Number(costos.real_usd.toFixed(5)), presupuesto_usd: v.presupuesto_usd, reserva_activa_usd: v.reservado_usd,
    excel_listo: v.estado === 'completado' && !bloques.length,
    matriz: r.matriz ? r.matriz.filas.map((f) => ({ requisito: f.requisito, estado: f.estado, cita_verificada: f.cita_verificada, ubicacion: f.ubicacion, archivo: f.archivo,
      evidencias: (f.evidencias || []).length, archivos: new Set((f.evidencias || []).map((x) => x.archivo_id)).size })) : null,
    config: r.config || (v.titulo.match(/K\d/) || [])[0], creado_en: v.creado_en,
  };
}

// ver_auditoria: SOLO la propuesta o el trabajo que corresponde. Sin id, la última propuesta de ESTA conversación;
// nunca "la última auditoría que exista" (así una antigua no se presenta como la actual).
async function estadoParaConversacion({ propuesta_id, trabajo_id } = {}, ctx = {}) {
  let p = null;
  if (propuesta_id) p = await propuesta(propuesta_id);
  else if (trabajo_id) {
    const [f] = await qPrincipal('SELECT id FROM auditoria_propuestas WHERE trabajo_id = ? AND usuario_id = ?', [trabajo_id, usuario().id]);
    if (f) p = await propuesta(f.id);
    else return { ...(await avance(trabajo_id)), nota: 'Este trabajo no nació de una propuesta del chat (se lanzó desde Ajustes).' };
  } else {
    if (!ctx.conversacionId) return { hay: false, nota: 'No sé en qué conversación estamos; pide el id de la propuesta.' };
    const [f] = await qPrincipal('SELECT id FROM auditoria_propuestas WHERE usuario_id = ? AND conversacion_id = ? ORDER BY creado_en DESC LIMIT 1', [usuario().id, ctx.conversacionId]);
    if (!f) return { hay: false, nota: 'En esta conversación no hay ninguna propuesta de auditoría. No informes auditorías de otras conversaciones como si fueran esta.' };
    try { p = await propuesta(f.id); } catch (e) {
      if (e.sinClave) return { hay: false, propuesta_id: f.id, nota: 'Hay una propuesta en esta conversación, pero está cifrada con una clave anterior y no se puede leer. No hay ningún trabajo asociado en ejecución.' };
      throw e;
    }
  }
  const base = { propuesta_id: p.id, conversacion_id: p.conversacion_id, es_de_esta_conversacion: !!ctx.conversacionId && p.conversacion_id === ctx.conversacionId,
    estado_propuesta: p.estado, tarjeta: p.tarjeta_estado, tipo: p.datos.tipo || 'auditoria', configuracion_propuesta: p.datos.config, archivos: p.datos.archivos.map((a) => a.nombre),
    requisitos: (p.datos.requisitos || []).length, ...(p.datos.norma ? { norma: p.datos.norma.nombre } : {}), ...(p.datos.origen ? { requisitos_extraidos_de: p.datos.origen.norma.nombre } : {}) };
  if (p.estado !== 'aprobada' || !p.trabajo_id) {
    return { ...base, trabajo: null,
      nota: p.estado === 'pendiente' ? 'Sigue pendiente de aprobación: no hay ningún trabajo en ejecución ni gasto. Empieza solo con el botón Aprobar de la tarjeta.' : `La propuesta está "${p.estado}"; no hay trabajo asociado.` };
  }
  const a = await avance(p.trabajo_id);
  return { ...base, aprobado: p.aprobacion ? { configuracion: p.aprobacion.configuracion, presupuesto_usd: p.aprobacion.presupuesto, requisitos: (p.aprobacion.requisitos || []).length } : null, trabajo: a,
    ...(a.modo === 'requisitos' && a.lista_propuesta ? { nota: `La extracción terminó: la lista de ${a.lista_propuesta.requisitos} requisitos es la propuesta ${a.lista_propuesta.propuesta_id.slice(0, 8)} (${a.lista_propuesta.estado}). Cristian la revisa y aprueba en su tarjeta.` } : {}) };
}

// Para la app: propuestas pendientes (de una conversación o todas) y trabajos de auditoría vivos o recién terminados.
async function pendientes({ conversacionId } = {}) {
  const filas = conversacionId
    ? await qPrincipal("SELECT id, estado, tarjeta_estado FROM auditoria_propuestas WHERE usuario_id = ? AND conversacion_id = ? AND estado = 'pendiente' ORDER BY creado_en", [usuario().id, conversacionId])
    : await qPrincipal("SELECT id, estado, tarjeta_estado FROM auditoria_propuestas WHERE usuario_id = ? AND estado = 'pendiente' AND creado_en > ? ORDER BY creado_en", [usuario().id, new Date(Date.now() - 7 * 864e5)]);
  const out = [];
  for (const f of filas) { try { const p = await propuesta(f.id); out.push({ ...tarjetaDe(p.id, p.datos), conversacion_id: p.conversacion_id }); } catch (_) {} }
  return out;
}

async function activas() {
  const filas = await qPrincipal(`SELECT t.id FROM trabajos t JOIN auditoria_propuestas p ON p.trabajo_id = t.id WHERE t.usuario_id = ? AND t.tipo = 'auditoria'
    AND (t.estado IN ('ejecutando','pausado','pausado_presupuesto','bloqueado','esperando_aprobacion') OR (t.estado = 'completado' AND t.terminado_en > ?)) ORDER BY t.creado_en DESC LIMIT 3`,
  [usuario().id, new Date(Date.now() - 6 * 3600e3)]);
  const out = [];
  for (const f of filas) { try { out.push(await avance(f.id)); } catch (_) {} }
  return { trabajos: out, propuestas: await pendientes() };
}

const H = require('./herramientas');
H.registrar([
  {
    name: 'proponer_auditoria',
    description: 'Propone una auditoría de cumplimiento sobre documentos de Drive (o los de una carpeta) contra requisitos: los que Cristian da, o los que se extraen de un documento normativo (norma_id). NO la inicia: guarda la propuesta y muestra una tarjeta para que Cristian la apruebe con un botón. Con norma_id hay dos aprobaciones: extraer la lista y, después, auditar con la lista revisada. Durante la prueba solo acepta documentos de la carpeta de prueba. Hasta 60 requisitos y 20 documentos.',
    input_schema: {
      type: 'object',
      properties: {
        archivo_ids: { type: 'array', items: { type: 'string' }, description: 'ids de los documentos a auditar' },
        carpeta_id: { type: 'string', description: 'o una carpeta: se auditan sus documentos con texto' },
        norma_id: { type: 'string', description: 'documento normativo (norma, pauta, reglamento) del que extraer los requisitos; si lo indicas, omite requisitos: primero se propone extraerlos y Cristian aprueba la lista' },
        requisitos: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', description: 'R1, R2…' }, texto: { type: 'string' } }, required: ['texto'] }, description: 'requisitos claros y verificables, uno por elemento' },
        configuracion: { type: 'string', enum: ['K1', 'K2', 'K3'], description: 'omítela: por ahora se usa K1 (Sonnet), salvo que Cristian pida otra' },
        motivo: { type: 'string', description: 'para qué es la auditoría, en una frase' },
      },
    },
  },
  {
    name: 'ver_auditoria',
    description: 'Estado de la auditoría de ESTA conversación (o de la propuesta/trabajo cuyo id se indique): si la propuesta sigue pendiente, si se aprobó y con qué, y el avance real del trabajo asociado (requisitos evaluados, costo, Excel). Nunca devuelve auditorías de otras conversaciones sin id.',
    input_schema: { type: 'object', properties: { propuesta_id: { type: 'string' }, trabajo_id: { type: 'string' } } },
  },
], {
  proponer_auditoria: (a, ctx) => proponer(a, ctx),
  ver_auditoria: (a, ctx) => estadoParaConversacion(a, ctx),
});

Trabajos.extender({ tipo: 'auditoria', ejecutores: EJECUTORES, verificar, alTerminar });

module.exports = { minimizar, informe, constancia, crear, estimacion, listar, excel, proponer, aprobarPropuesta, descartarPropuesta, avance, activas, pendientes, marcarTarjeta, estadoParaConversacion, TARJETA, CONFIG_PROVISIONAL, CONFIGS, fragmentar, pertinentes, citaVerificada, costosDe };
