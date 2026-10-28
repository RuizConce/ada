// Modo reunión: ADA escucha la reunión completa (Deepgram, separando quién habla), guarda la
// transcripción a medida que avanza y al terminar arma el acta (Sonnet): resumen, acuerdos,
// tareas con responsable y fecha. Las tareas del dueño se agendan; el acta llega al teléfono y
// a su propio correo. Opcional: traducir al español lo que se diga en otro idioma.
const { q, usuario } = require('./db');
const { claude, MODELO_PROFUNDO, MODELO_RAPIDO, costoUSD } = require('./claude');
const H = require('./herramientas');

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function crear({ titulo, traducir } = {}) {
  const r = await q('INSERT INTO reuniones (titulo, traducir, inicio) VALUES (?, ?, ?)',
    [String(titulo || '').trim().slice(0, 200) || null, traducir ? 1 : 0, new Date()]);
  return { id: r.insertId };
}

async function obtener(id) {
  const [r] = await q('SELECT * FROM reuniones WHERE id = ?', [id]);
  if (!r) throw Object.assign(new Error('No existe esa reunión'), { status: 404 });
  return r;
}

// Segmentos finales: { hablante, texto, seg, traduccion }
async function agregar(id, segmentos = []) {
  const r = await obtener(id);
  if (r.estado !== 'grabando') throw new Error('La reunión ya terminó');
  const lineas = (Array.isArray(segmentos) ? segmentos : []).slice(0, 200)
    .filter((x) => x && String(x.texto || '').trim())
    .map((x) => {
      const quien = Number.isInteger(x.hablante) ? `Persona ${x.hablante + 1}` : 'Alguien';
      const tr = x.traduccion ? ` [traducción: ${String(x.traduccion).slice(0, 2000)}]` : '';
      return `[${mmss(Math.max(0, Number(x.seg) || 0))}] ${quien}: ${String(x.texto).trim().slice(0, 4000)}${tr}`;
    });
  if (!lineas.length) return { ok: true, agregados: 0 };
  await q('UPDATE reuniones SET transcripcion = CONCAT(COALESCE(transcripcion, \'\'), ?) WHERE id = ?', [`${lineas.join('\n')}\n`, id]);
  return { ok: true, agregados: lineas.length };
}

const HERRAMIENTA_ACTA = {
  name: 'entregar_acta',
  description: 'Entrega el acta de la reunión.',
  input_schema: {
    type: 'object',
    properties: {
      titulo: { type: 'string', description: 'Título corto y concreto de la reunión (tema principal).' },
      resumen: { type: 'string', description: 'Dos o tres frases: de qué se trató y qué se decidió. Se lee como aviso en el teléfono.' },
      acta: { type: 'string', description: 'Acta en markdown: ## Participantes, ## Temas tratados (bullets breves), ## Acuerdos, ## Tareas (responsable y fecha), ## Pendientes o dudas abiertas. Sin inventar nada que no se haya dicho.' },
      tareas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            texto: { type: 'string', description: 'Qué hay que hacer, en infinitivo.' },
            responsable: { type: 'string', description: 'Nombre o "Persona N"; vacío si no quedó claro.' },
            fecha_limite: { type: 'string', description: 'YYYY-MM-DD o YYYY-MM-DD HH:MM si se dijo; vacío si no.' },
            para_mi: { type: 'boolean', description: 'true si la tarea es del dueño de ADA (o nadie la tomó y le corresponde a él).' },
            importante: { type: 'boolean' },
          },
          required: ['texto', 'para_mi'],
        },
      },
    },
    required: ['titulo', 'resumen', 'acta', 'tareas'],
  },
};

async function terminar(id, { nombres = {}, titulo } = {}) {
  const r = await obtener(id);
  if (r.estado === 'terminada' && r.documento_id) return { ya_terminada: true, documento_id: r.documento_id };
  const transcripcion = String(r.transcripcion || '').trim();
  await q("UPDATE reuniones SET estado = 'terminada', fin = ?, titulo = COALESCE(?, titulo) WHERE id = ?",
    [new Date(), String(titulo || '').trim().slice(0, 200) || null, id]);
  if (transcripcion.split(/\s+/).length < 15) return { vacia: true, mensaje: 'Se escuchó muy poco: no alcanza para un acta.' };

  const u = usuario();
  const quienes = Object.entries(nombres || {})
    .filter(([k, v]) => /^\d+$/.test(k) && String(v || '').trim())
    .map(([k, v]) => `Persona ${parseInt(k, 10) + 1} = ${String(v).trim().slice(0, 40)}`);
  const minutos = Math.max(1, Math.round(((r.fin || new Date()) - new Date(r.inicio)) / 60000));
  const pedido = [
    `Dueño de ADA: ${u.nombre || 'Cristian'}. Fecha y hora: ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.`,
    r.titulo || titulo ? `Título que dio: ${r.titulo || titulo}.` : '',
    quienes.length ? `Quién es quién: ${quienes.join('; ')}.` : 'No se sabe quién es cada persona: usa "Persona N" salvo que se deduzca claramente del diálogo (se llaman por su nombre).',
    `Duración aproximada: ${minutos} min. La transcripción es automática: puede tener errores; corrige nombres obvios, no inventes.`,
    r.traducir ? 'Parte de la reunión fue en otro idioma: el acta va en español.' : '',
    '', 'TRANSCRIPCIÓN:', transcripcion.slice(-180000),
  ].filter(Boolean).join('\n');

  const modelo = MODELO_PROFUNDO();
  const resp = await require('./registro').llamadaUnica('acta', {
    model: modelo,
    max_tokens: 8000,
    system: 'Eres ADA y redactas actas de reunión claras y útiles, en español de Chile, para quien te usa. Solo registras lo que se dijo. Acuerdos y tareas concretas, con responsable y fecha cuando existan. Las fechas relativas ("el jueves") se resuelven con la fecha de la reunión.',
    tools: [HERRAMIENTA_ACTA],
    tool_choice: { type: 'tool', name: 'entregar_acta' },
    messages: [{ role: 'user', content: pedido }],
  });
  try { await require('./consumo').registrar({ modelo, costo: costoUSD(modelo, resp.usage || {}) }); } catch (_) {}
  const bloque = (resp.content || []).find((b) => b.type === 'tool_use');
  if (!bloque) throw new Error('No se pudo armar el acta');
  const a = bloque.input;
  const fecha = new Date(r.inicio).toLocaleDateString('es-CL', { timeZone: 'America/Santiago', day: 'numeric', month: 'long', year: 'numeric' });
  const contenido = `*Reunión del ${fecha} · ${minutos} min*\n\n**Resumen:** ${a.resumen}\n\n${a.acta}\n\n---\n\n## Transcripción\n\n${transcripcion}`;
  const doc = await H.ejecutar('entregar_documento', { titulo: `Acta: ${a.titulo}`.slice(0, 200), contenido });
  if (doc.error) throw new Error(doc.error);
  await q('UPDATE reuniones SET documento_id = ?, titulo = ? WHERE id = ?', [doc.documento_id, String(a.titulo).slice(0, 200), id]);

  // Tareas: las suyas se anotan y agendan; las de otros quedan anotadas para seguimiento (sin calendario).
  const tareas = [];
  for (const t of (a.tareas || []).slice(0, 25)) {
    const res = await H.ejecutar('registrar_item', {
      tipo: 'pendiente',
      texto: t.para_mi ? t.texto : `${t.responsable ? `${t.responsable}: ` : ''}${t.texto}`,
      persona: t.para_mi ? undefined : (t.responsable || undefined),
      fecha_limite: t.fecha_limite || undefined,
      importante: !!t.importante,
      agendar: !!t.para_mi,
    });
    tareas.push({ ...t, registrada: !res.error });
  }

  const resultado = { titulo: a.titulo, resumen: a.resumen, acta: a.acta, tareas, documento_id: doc.documento_id };
  // Aviso al teléfono y acta a su propio correo (pactado, como los encargos largos).
  require('./fintarea').avisarFin(`Acta de la reunión: ${a.titulo}`, {
    respuesta: a.resumen, documentos: [{ id: doc.documento_id, titulo: `Acta: ${a.titulo}` }], archivos: [], tiempos: { total_ms: 60000 }, conversacion_id: `r${id}`,
  }).catch((e) => console.error('Aviso acta:', e.message));
  return resultado;
}

// Traduce al español una frase dicha en otro idioma (modelo rápido). "=" si ya estaba en español.
async function traducir(texto) {
  const t = String(texto || '').trim().slice(0, 3000);
  if (!t) return { traduccion: null };
  const modelo = MODELO_RAPIDO();
  const resp = await require('./registro').llamadaUnica('traduccion', {
    model: modelo,
    max_tokens: 600,
    system: 'Traduces al español de Chile, natural y fiel. Responde solo con la traducción. Si el texto ya está en español, responde exactamente: =',
    messages: [{ role: 'user', content: t }],
  });
  try { await require('./consumo').registrar({ modelo, costo: costoUSD(modelo, resp.usage || {}) }); } catch (_) {}
  const out = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { traduccion: !out || out === '=' ? null : out };
}

async function listar() {
  return q('SELECT id, titulo, estado, documento_id, inicio, fin FROM reuniones ORDER BY id DESC LIMIT 20');
}

module.exports = { crear, agregar, terminar, traducir, listar, obtener };
