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
const ESTADOS_IA = ['cumple', 'parcial', 'no_cumple', 'sin_evidencia', 'no_aplica_justificado'];
const CON_CITA = ['cumple', 'parcial', 'no_cumple'];
const MAX_REQUISITOS = 10;
const MAX_ARCHIVOS = 5;
const MAX_CITA = 300;
const DOC_CORTO = 4000; // documentos más cortos se envían completos (en fragmentos)
const err = (m, status = 400) => Object.assign(new Error(m), { status });
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const modeloDe = (nivel) => (nivel === 'profundo' ? C.MODELO_PROFUNDO() : C.MODELO_RAPIDO());

// ---------- Fragmentos (código) ----------

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const STOP = new Set('para debe deben cada como entre sobre desde hasta este esta estos estas todo toda todos todas tiene tienen contar cuenta menos mismo misma donde cuando sido sera seran hace hacer puede pueden segun otro otra otros otras dicho dicha solo tambien aunque porque pero muy mas menos'.split(' '));
const raices = (t) => new Set(norm(t).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 6)));

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

function pertinentes(requisito, frags, textoTotal) {
  if (textoTotal.length <= DOC_CORTO) return { fragmentos: frags, criterio: 'documento corto: todos los fragmentos' };
  const r = raices(requisito);
  const puntaje = frags.map((f) => { const fr = raices(f.texto); let n = 0; for (const x of r) if (fr.has(x)) n += 1; return { f, n }; });
  const elegidos = puntaje.filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 4).map((x) => x.f).sort((a, b) => a.desde - b.desde);
  return { fragmentos: elegidos, criterio: elegidos.length ? `palabras del requisito (${elegidos.length} de ${frags.length} fragmentos)` : 'ningún fragmento menciona el requisito' };
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
- sin_evidencia: los fragmentos no dicen nada que permita evaluarlo.
- no_aplica_justificado: el requisito es condicional y la evidencia muestra que la condición no se da (explica por qué en la justificación).
Cómo evaluar: si el requisito tiene varias partes o exige algo "en cada", "todos", "ambos" o "al menos", revisa parte por parte. Si al menos una parte está acreditada y otra no, el estado es parcial, no no_cumple. Reserva no_cumple para cuando nada de lo esencial se cumple o la evidencia lo contradice.
Reglas: usa solo los fragmentos. La cita se copia textual de UN fragmento (sin cambiar palabras; máximo 300 caracteres; puedes unir trozos del mismo fragmento con "..."). Nunca marques cumple sin una cita que lo pruebe. La justificación es breve (1 o 2 frases) y dice qué parte está acreditada y qué parte no.`;
const HERRAMIENTA = {
  name: 'evaluar_requisito',
  description: 'Entrega la evaluación del requisito.',
  input_schema: {
    type: 'object',
    properties: {
      estado: { type: 'string', enum: ESTADOS_IA },
      fragmento: { type: 'string', description: 'id del fragmento de donde sale la cita (F1, F2…); vacío si no hay cita' },
      cita: { type: 'string', description: 'texto copiado tal cual del fragmento' },
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
    max_tokens: 600,
    system: SISTEMA,
    tools: [HERRAMIENTA],
    tool_choice: eleccionHerramienta(modeloDe(nivel)),
    messages: [{ role: 'user', content: `Requisito ${requisito.id}: ${requisito.texto}\n\n${varios ? 'Fragmentos de los documentos' : `Fragmentos del documento «${sel.nombre}»`}:\n\n${frags || '(ninguno)'}${nota ? `\n\n${nota}` : ''}` }],
  };
}

// Revisa la respuesta con reglas objetivas (código). Devuelve { valido, motivo, evaluacion }.
function revisar(resp, sel, requisito, nivel, config) {
  const b = (resp.content || []).find((x) => x.type === 'tool_use' && x.name === 'evaluar_requisito');
  if (!b || resp.stop_reason === 'max_tokens') return { valido: false, motivo: b ? 'formato: respuesta cortada' : 'formato: respondió sin usar la herramienta' };
  const e = b.input || {};
  if (!ESTADOS_IA.includes(e.estado)) return { valido: false, motivo: `formato: estado "${e.estado}" no permitido` };
  const frag = sel.fragmentos.find((f) => f.id === String(e.fragmento || '').trim());
  const ev = { estado: e.estado, fragmento: frag ? frag.id : null, ubicacion: frag ? frag.ubicacion : null, cita: String(e.cita || '').trim(), justificacion: String(e.justificacion || '').trim(),
    ...(frag && frag.archivo_id ? { archivo_id: frag.archivo_id, nombre: frag.nombre, version: frag.version } : {}) };
  if (ev.cita.length > MAX_CITA) return { valido: false, motivo: `cita de ${ev.cita.length} caracteres (máximo ${MAX_CITA})`, evaluacion: ev };
  const necesitaCita = CON_CITA.includes(ev.estado);
  if (necesitaCita && !ev.cita) return { valido: false, motivo: `"${ev.estado}" sin cita`, evaluacion: ev };
  if (ev.cita) {
    if (!frag) return { valido: false, motivo: 'la cita no indica un fragmento válido', evaluacion: ev };
    if (!citaVerificada(ev.cita, frag)) return { valido: false, motivo: 'la cita no aparece textual en el documento', evaluacion: ev };
  }
  if (ev.estado === 'no_aplica_justificado' && ev.justificacion.length < 20) return { valido: false, motivo: '"no aplica" sin justificación suficiente', evaluacion: ev };
  ev.cita_verificada = !!ev.cita;
  // K3: reglas objetivas (código) para pedir segunda opinión a Sonnet cuando Haiku responde algo delicado.
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
      usage: resp.usage || {}, duracionMs: Date.now() - t0, stopReason: resp.stop_reason, requestId: resp._request_id || resp.id, estimado, herramientas: 'evaluar_requisito' });
    return { resp, costo: reg.costo, estimado };
  } catch (e) {
    await Registro.llamada({ origen: 'trabajo', turnoId: ctx.trabajoId, trabajoId: ctx.trabajoId, pasoId: ctx.pasoId, paso: intento, modelo: params.model,
      usage: {}, duracionMs: Date.now() - t0, error: e.message, estimado });
    if (ctx.senal && ctx.senal.aborted) throw Object.assign(new Error('cancelado'), { cancelado: true });
    throw e;
  }
}

// ---------- Pasos ----------

const EJECUTORES = {
  // Texto del documento (reutilizado de la Fase 3b) → fragmentos pertinentes por requisito. Código, sin IA.
  async aud_seleccionar({ entrada, trabajoId, pasoId }) {
    const Drive = require('./drive');
    const ids = entrada.archivo_ids || [entrada.archivo_id];
    const docs = [];
    let frags = [];
    let texto = '';
    for (const id of ids) {
      const doc = await Drive.textoParaTrabajo(id, { trabajoId, pasoId });
      if (!doc.texto.trim()) throw new Error(`El documento «${doc.nombre}» no tiene texto extraíble`);
      docs.push({ archivo_id: doc.archivo_id, nombre: doc.nombre, version: doc.version, fuente: doc.fuente, caracteres: doc.texto.length });
      const propios = fragmentar(doc.texto).map((f) => ({ ...f, archivo_id: doc.archivo_id, nombre: doc.nombre, version: doc.version }));
      frags = frags.concat(propios);
      texto += `${doc.texto}\n`;
    }
    frags = frags.map((f, i) => ({ ...f, id: `F${i + 1}` }));
    const porRequisito = entrada.requisitos.map((r) => {
      const p = pertinentes(r.texto, frags, texto);
      return { requisito: r.id, criterio: p.criterio, fragmentos: p.fragmentos };
    });
    const unico = docs.length === 1 ? docs[0] : {};
    return { resultado: { docs, archivo_id: unico.archivo_id, nombre: unico.nombre, version: unico.version, caracteres: texto.length, total_fragmentos: frags.length, por_requisito: porRequisito }, costo: 0 };
  },

  // Clasificar UN requisito con la IA según K1/K2/K3, y comprobar la evidencia con código.
  async aud_verificar({ entrada, previos, trabajoId, pasoId, senal }) {
    const config = CONFIGS[entrada.config] || CONFIGS.K3;
    const selPaso = [...previos].reverse().find((p) => p.resultado && p.resultado.por_requisito);
    if (!selPaso) throw new Error('falta la selección de fragmentos');
    const s = selPaso.resultado;
    const porReq = s.por_requisito.find((x) => x.requisito === entrada.requisito.id) || { fragmentos: [] };
    const sel = { nombre: s.nombre || 'documentos', fragmentos: porReq.fragmentos };
    // Con un documento, la fila lleva ese archivo; con varios, el del fragmento citado (se completa al elegir).
    const base = { requisito: entrada.requisito.id, texto_requisito: entrada.requisito.texto, archivo_id: s.archivo_id || null, nombre: s.nombre || null, version: s.version || null, config: entrada.config };
    if (!sel.fragmentos.length) {
      // Nada en el documento habla del requisito: lo dice el código, sin gastar en IA.
      return { resultado: { ...base, estado: 'sin_evidencia', cita: '', cita_verificada: false, ubicacion: null, justificacion: 'Ningún fragmento de los documentos menciona este requisito.', modelo: 'código', intentos: [], escalado: false }, costo: 0, llamadasRegistradas: true };
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
        if (r.segundaOpinion && i < config.modelos.length - 1) { nota = `Revisión independiente (${r.segundaOpinion}): evalúa desde cero, parte por parte, y distingue con cuidado cumple, parcial, no_cumple y no_aplica_justificado.`; continue; }
        break;
      }
      if (elegida) break; // la segunda opinión no se pudo verificar: queda la respuesta válida anterior
      nota = `Tu respuesta anterior no se pudo verificar (${r.motivo}). Corrígela: la cita debe copiarse textual de un fragmento.`;
    }
    if (!elegida) {
      return { resultado: { ...base, estado: 'no_evaluado', cita: '', cita_verificada: false, ubicacion: null, justificacion: `No se pudo verificar la evidencia: ${intentos.map((x) => x.motivo).filter(Boolean).join('; ')}`, modelo: intentos.map((x) => x.modelo).join(' → '), intentos, escalado: intentos.some((x) => x.nivel === 'profundo') && config.escalar }, costo, llamadasRegistradas: true };
    }
    return { resultado: { ...base, ...elegida, cita: elegida.cita.slice(0, MAX_CITA), intentos, escalado: config.escalar && intentos.some((x) => x.nivel === 'profundo') }, costo, llamadasRegistradas: true };
  },

  async aud_consolidar({ entrada, previos }) {
    const filas = entrada.requisitos.map((r) => {
      const p = [...previos].reverse().find((x) => x.resultado && x.resultado.requisito === r.id && x.clave.startsWith('verificar:'));
      const v = p ? p.resultado : { estado: 'no_evaluado', justificacion: 'paso sin resultado' };
      return { requisito: r.id, texto_requisito: r.texto, estado: v.estado, justificacion: v.justificacion || '', cita: v.cita || '', cita_verificada: !!v.cita_verificada,
        ubicacion: v.ubicacion || '', archivo_id: v.archivo_id || null, archivo_version: v.version || null, archivo: v.nombre || null, modelo: v.modelo || '', escalado: !!v.escalado, paso: p ? p.clave : null };
    });
    return { resultado: { filas, total: filas.length }, costo: 0 };
  },

  async aud_excel({ previos, entrada }) {
    const consol = [...previos].reverse().find((p) => p.resultado && Array.isArray(p.resultado.filas));
    if (!consol) throw new Error('no hay matriz consolidada');
    const ExcelJS = require('exceljs');
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Matriz');
    hoja.columns = [
      { header: 'Requisito', width: 10 }, { header: 'Texto del requisito', width: 50 }, { header: 'Estado', width: 22 }, { header: 'Justificación', width: 50 },
      { header: 'Cita', width: 50 }, { header: 'Ubicación', width: 14 }, { header: 'Archivo', width: 30 }, { header: 'Versión', width: 30 }, { header: 'Modelo', width: 28 },
    ];
    hoja.getRow(1).font = { bold: true };
    for (const f of consol.resultado.filas) hoja.addRow([f.requisito, f.texto_requisito, f.estado, f.justificacion, f.cita, f.ubicacion, f.archivo || '', f.archivo_version || '', f.modelo]);
    hoja.eachRow((row) => { row.alignment = { wrapText: true, vertical: 'top' }; });
    const res = libro.addWorksheet('Datos');
    res.addRow(['Configuración', `${entrada.config} — ${(CONFIGS[entrada.config] || {}).nombre || ''}`]);
    res.addRow(['Generado', new Date().toISOString()]);
    const buf = Buffer.from(await libro.xlsx.writeBuffer());
    return { resultado: { nombre: 'auditoria.xlsx', xlsx_b64: buf.toString('base64'), huella: hash(buf.toString('base64')), filas: consol.resultado.filas.length }, costo: 0 };
  },
};

// ---------- Verificación final (código) ----------

const COLUMNAS = ['requisito', 'texto_requisito', 'estado', 'justificacion', 'cita', 'ubicacion', 'archivo', 'archivo_version', 'modelo'];
async function verificar(t, pasos, esperado, { integridad }) {
  const problemas = integridad(pasos);
  const objetivo = Cifrado.descifrarJSON(t.objetivo_cifrado) || {};
  const ids = (objetivo.requisitos || []).map((r) => r.id);
  const consol = pasos.filter((p) => p.tipo === 'aud_consolidar').pop();
  const matriz = consol && consol.resultado_cifrado ? Cifrado.descifrarJSON(consol.resultado_cifrado) : null;
  if (!matriz) problemas.push('no hay matriz consolidada');
  else {
    const vistos = matriz.filas.map((f) => f.requisito);
    if (vistos.length !== ids.length || vistos.some((x, i) => x !== ids[i])) problemas.push(`la matriz tiene ${vistos.join(', ')} y lo aprobado es ${ids.join(', ')}`);
    for (const f of matriz.filas) {
      if (!Trabajos.ESTADOS_EVIDENCIA.includes(f.estado)) problemas.push(`${f.requisito}: estado inválido "${f.estado}"`);
      if (CON_CITA.includes(f.estado) && !(f.cita && f.cita_verificada && f.archivo_id && f.archivo_version && f.ubicacion)) problemas.push(`${f.requisito}: "${f.estado}" sin evidencia verificable completa`);
      if (f.estado === 'no_aplica_justificado' && !f.justificacion) problemas.push(`${f.requisito}: "no aplica" sin justificación`);
    }
  }
  // El Excel se relee y se coteja celda por celda con la matriz.
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
      const hoja = libro.getWorksheet('Matriz');
      const filas = [];
      hoja.eachRow((row, n) => { if (n > 1) filas.push(COLUMNAS.map((_, i) => { const v = row.getCell(i + 1).value; return v == null ? '' : String(v); })); });
      excel = { filas: filas.length, columnas: COLUMNAS.length };
      if (matriz) {
        if (filas.length !== matriz.filas.length) problemas.push(`el Excel tiene ${filas.length} filas y la matriz ${matriz.filas.length}`);
        else filas.forEach((x, i) => {
          const m = matriz.filas[i];
          COLUMNAS.forEach((c, j) => { const esperadoCelda = c === 'archivo' ? (m.archivo || '') : String(m[c] == null ? '' : m[c]); if (x[j] !== esperadoCelda) problemas.push(`Excel fila ${i + 1}, ${c}: no coincide con la matriz`); });
        });
      }
    } catch (e) { problemas.push(`no se pudo releer el Excel: ${e.message}`); }
  }
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
      config: objetivo.config, excel,
      precision: precision.length ? { aciertos: precision.filter((x) => x.acierto).length, total: precision.length, detalle: precision } : null,
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
  const requisitos = (d.requisitos || []).map((r, i) => ({ id: String(r.id || `R${i + 1}`).trim().slice(0, 12), texto: String(r.texto || '').trim().slice(0, 600) })).filter((r) => r.texto);
  if (!requisitos.length || requisitos.length > MAX_REQUISITOS) throw err(`Entre 1 y ${MAX_REQUISITOS} requisitos`);
  if (new Set(requisitos.map((r) => r.id)).size !== requisitos.length) throw err('Hay ids de requisito repetidos');
  for (const r of requisitos) if (!/^[\w.-]{1,12}$/.test(r.id)) throw err(`Id de requisito inválido: ${r.id}`);
  const esperado = (d.esperado || []).filter((x) => x && x.id && x.estado).map((x) => ({ id: String(x.id), estado: String(x.estado) }));
  for (const x of esperado) if (!Trabajos.ESTADOS_EVIDENCIA.includes(x.estado)) throw err(`Estado esperado inválido para ${x.id}: ${x.estado}`);
  return { archivo_ids, archivo_id: archivo_ids[0], requisitos, esperado };
}

// Estimación previa por configuración (peor caso: segundo intento incluido). Sirve para proponer presupuesto.
function estimar({ requisitos, config }) {
  const k = CONFIGS[config];
  const fragmentos = 'x'.repeat(DOC_CORTO);
  return requisitos.reduce((a, r) => a + k.modelos.reduce((b, nivel) => b + C.estimarCosto(pedido(nivel, r, { nombre: 'documento', fragmentos: [{ id: 'F1', ubicacion: 'p', texto: fragmentos }] }, null)), 0), 0);
}
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
    const est = estimar({ requisitos: [r], config });
    pasos.push({ clave: `verificar:${r.id}`, tipo: 'aud_verificar', etapa: 'verificación', entrada: { requisito: r, config }, estimado: Number(est.toFixed(6)) });
  }
  pasos.push({ clave: 'consolidar', tipo: 'aud_consolidar', etapa: 'consolidación', entrada: { requisitos: e.requisitos } });
  pasos.push({ clave: 'excel', tipo: 'aud_excel', etapa: 'entregable', entrada: { config } });
  return pasos;
}

async function crearYAprobar(e, config, presupuesto, serie) {
  const objetivo = { archivo_id: e.archivo_id, archivo_ids: e.archivo_ids, requisitos: e.requisitos, esperado: e.esperado, config, requisitos_hash: hash(JSON.stringify(e.requisitos)), ...(serie ? { serie } : {}) };
  const t = await Trabajos.crear({ tipo: 'auditoria', titulo: `Auditoría mínima ${config} (${e.requisitos.length} requisitos)`, objetivo, presupuesto, pasos: pasosDe(e, config) });
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
  return crearYAprobar(e, config, presupuesto, null);
}

// Serie de comparación: al completar una configuración, empieza la siguiente (presupuesto ya aprobado).
async function alTerminar(t, final) {
  const objetivo = Cifrado.descifrarJSON(t.objetivo_cifrado) || {};
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

async function proponer(d, ctx = {}) {
  if (usuario().id !== 1) throw err('La auditoría está disponible solo para la cuenta principal en esta etapa.', 403);
  const archivos = await archivosDeLaPropuesta(d);
  const config = CONFIGS[d.configuracion] ? d.configuracion : CONFIG_PROVISIONAL;
  const e = validarEntrada({ archivo_ids: archivos.map((a) => a.id), requisitos: d.requisitos });
  const est = estimacion({ archivo_ids: e.archivo_ids, requisitos: e.requisitos });
  const id = crypto.randomUUID();
  const datos = { archivos, requisitos: e.requisitos, config, motivo: String(d.motivo || '').slice(0, 300), estimacion: est };
  await qPrincipal('INSERT INTO auditoria_propuestas (id, usuario_id, conversacion_id, estado, datos_cifrado, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, usuario().id, ctx.conversacionId || null, 'pendiente', Cifrado.cifrarJSON(datos), new Date(), new Date()]);
  const tarjeta = { id, archivos, requisitos: e.requisitos, configuracion: config, configuraciones: est.configuraciones, estimados: est.por_configuracion, estimado_usd: est.por_configuracion[config],
    presupuesto_sugerido: Math.ceil(est.presupuesto_minimo[config] * 100) / 100, presupuesto_minimo: est.presupuesto_minimo, motivo: datos.motivo };
  if (typeof ctx.emitir === 'function') ctx.emitir('auditoria_propuesta', tarjeta);
  return {
    ok: true, propuesta_id: id, archivos: archivos.map((a) => a.nombre), requisitos: e.requisitos.length, configuracion: config,
    presupuesto_sugerido_usd: tarjeta.presupuesto_sugerido, costo_estimado_peor_caso_usd: tarjeta.estimado_usd,
    nota: 'Le mostré en pantalla la tarjeta para revisar los requisitos y aprobar el presupuesto. NO ha empezado: empieza solo cuando Cristian toque "Aprobar" en la tarjeta. Díselo en una frase (cuántos requisitos, configuración y presupuesto sugerido) y no digas que ya está en marcha.',
  };
}

async function propuesta(id) {
  const [p] = await qPrincipal('SELECT * FROM auditoria_propuestas WHERE id = ? AND usuario_id = ?', [id, usuario().id]);
  if (!p) throw err('No existe esa propuesta', 404);
  return { ...p, datos: Cifrado.descifrarJSON(p.datos_cifrado) };
}

// La aprobación es el botón de la tarjeta (requisitos, posiblemente editados, y presupuesto explícito).
async function aprobarPropuesta(id, { presupuesto, requisitos, configuracion } = {}) {
  const p = await propuesta(id);
  if (p.estado !== 'pendiente') throw err(`La propuesta ya está "${p.estado}"`, 409);
  const datos = p.datos;
  const trabajo = await crear({ archivo_ids: datos.archivos.map((a) => a.id), requisitos: requisitos && requisitos.length ? requisitos : datos.requisitos,
    configuracion: configuracion || datos.config, presupuesto });
  await qPrincipal("UPDATE auditoria_propuestas SET estado = 'aprobada', trabajo_id = ?, actualizado_en = ? WHERE id = ? AND estado = 'pendiente'", [trabajo.id, new Date(), id]);
  return { ok: true, trabajo_id: trabajo.id, estado: trabajo.estado };
}

async function descartarPropuesta(id) {
  const p = await propuesta(id);
  if (p.estado !== 'pendiente') throw err(`La propuesta ya está "${p.estado}"`, 409);
  await qPrincipal("UPDATE auditoria_propuestas SET estado = 'descartada', actualizado_en = ? WHERE id = ?", [new Date(), id]);
  return { ok: true };
}

// Avance real para la conversación y la tarjeta del chat (desde la base, no estimado).
async function avance(trabajoId) {
  let id = trabajoId;
  if (!id) {
    const [u] = await qPrincipal("SELECT id FROM trabajos WHERE usuario_id = ? AND tipo = 'auditoria' ORDER BY creado_en DESC LIMIT 1", [usuario().id]);
    if (!u) return { hay: false, nota: 'No hay auditorías todavía.' };
    id = u.id;
  }
  const v = await Trabajos.ver(id, { conResultado: true });
  if (v.tipo !== 'auditoria') throw err('No es una auditoría', 404);
  const pasos = v.detalle_pasos;
  const verif = pasos.filter((p) => p.tipo === 'aud_verificar');
  const r = v.resultado || {};
  const costos = r.costos || await costosDe(id);
  return {
    hay: true, id: v.id, estado: v.estado, estado_real: v.estado_real, motivo: v.motivo, etapa: v.etapa,
    pasos_hechos: v.pasos.hechos, pasos_total: v.pasos.total,
    requisitos_evaluados: verif.filter((p) => p.estado === 'hecho').length, requisitos_total: verif.length,
    costo_real_usd: Number(costos.real_usd.toFixed(5)), presupuesto_usd: v.presupuesto_usd, reserva_activa_usd: v.reservado_usd,
    excel_listo: v.estado === 'completado',
    matriz: r.matriz ? r.matriz.filas.map((f) => ({ requisito: f.requisito, estado: f.estado, cita_verificada: f.cita_verificada, ubicacion: f.ubicacion, archivo: f.archivo })) : null,
    config: r.config || (v.titulo.match(/K\d/) || [])[0],
  };
}

async function activas() {
  const filas = await qPrincipal(`SELECT id FROM trabajos WHERE usuario_id = ? AND tipo = 'auditoria'
    AND (estado IN ('ejecutando','pausado','pausado_presupuesto','bloqueado','esperando_aprobacion') OR (estado = 'completado' AND terminado_en > ?)) ORDER BY creado_en DESC LIMIT 3`,
  [usuario().id, new Date(Date.now() - 6 * 3600e3)]);
  const out = [];
  for (const f of filas) { try { out.push(await avance(f.id)); } catch (_) {} }
  return out;
}

const H = require('./herramientas');
H.registrar([
  {
    name: 'proponer_auditoria',
    description: 'Propone una auditoría de cumplimiento sobre uno o más documentos de Drive (o los de una carpeta) contra una lista de requisitos. NO la inicia: muestra a Cristian una tarjeta con los archivos, los requisitos, la configuración y el presupuesto sugerido para que la apruebe con un botón. Durante la prueba solo acepta documentos de la carpeta de prueba. Hasta 10 requisitos y 5 documentos.',
    input_schema: {
      type: 'object',
      properties: {
        archivo_ids: { type: 'array', items: { type: 'string' }, description: 'ids de los documentos a auditar' },
        carpeta_id: { type: 'string', description: 'o una carpeta: se auditan sus documentos con texto' },
        requisitos: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', description: 'R1, R2…' }, texto: { type: 'string' } }, required: ['texto'] }, description: 'requisitos claros y verificables, uno por elemento' },
        configuracion: { type: 'string', enum: ['K1', 'K2', 'K3'], description: 'omítela: por ahora se usa K1 (Sonnet), salvo que Cristian pida otra' },
        motivo: { type: 'string', description: 'para qué es la auditoría, en una frase' },
      },
      required: ['requisitos'],
    },
  },
  {
    name: 'ver_auditoria',
    description: 'Avance real de una auditoría (la última si no se indica id): estado, requisitos evaluados, costo real, presupuesto y, si terminó, el resultado por requisito y si el Excel está listo.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
  },
], {
  proponer_auditoria: (a, ctx) => proponer(a, ctx),
  ver_auditoria: (a) => avance(a.id),
});

Trabajos.extender({ tipo: 'auditoria', ejecutores: EJECUTORES, verificar, alTerminar });

module.exports = { crear, estimacion, listar, excel, proponer, aprobarPropuesta, descartarPropuesta, avance, activas, CONFIG_PROVISIONAL, CONFIGS, fragmentar, pertinentes, citaVerificada, costosDe };
