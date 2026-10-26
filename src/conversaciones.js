// Conversaciones: cada sesión con ADA (desde que la abres hasta que la cierras) queda archivada
// con título, resumen y proyecto. También guarda los documentos que ADA entrega en pantalla.
const { q, usuario } = require('./db');
const F = require('./fechas');
const H = require('./herramientas');
const { claude, MODELO_RAPIDO } = require('./claude');

const MINUTOS_INACTIVIDAD = () => parseInt(process.env.ADA_MINUTOS_CONVERSACION || '30', 10);

// ---------- Ciclo de vida ----------

async function ultimaActividad(id) {
  const [r] = await q('SELECT MAX(creado_en) AS ultima FROM mensajes WHERE conversacion_id = ?', [id]);
  return r && r.ultima ? new Date(r.ultima) : null;
}

// Devuelve el id de una conversación abierta y vigente; si no hay, crea una nueva.
async function asegurar(id, modo = 'texto') {
  if (id) {
    const [c] = await q('SELECT id, inicio, fin, modo FROM conversaciones WHERE id = ?', [id]);
    if (c && !c.fin) {
      const ultima = (await ultimaActividad(c.id)) || new Date(c.inicio);
      if (F.minutosEntre(ultima) < MINUTOS_INACTIVIDAD()) {
        if (modo === 'voz' && c.modo !== 'voz') await q("UPDATE conversaciones SET modo = 'voz' WHERE id = ?", [c.id]);
        return c.id;
      }
    }
  }
  cerrarInactivas().catch((e) => console.error('cerrarInactivas:', e.message));
  const r = await q('INSERT INTO conversaciones (modo, inicio) VALUES (?, ?)', [modo === 'voz' ? 'voz' : 'texto', new Date()]);
  return r.insertId;
}

async function cerrarInactivas() {
  const abiertas = await q('SELECT id, inicio FROM conversaciones WHERE fin IS NULL');
  for (const c of abiertas) {
    const ultima = (await ultimaActividad(c.id)) || new Date(c.inicio);
    if (F.minutosEntre(ultima) >= MINUTOS_INACTIVIDAD()) await cerrar(c.id);
  }
}

async function cerrar(id) {
  const [c] = await q('SELECT * FROM conversaciones WHERE id = ?', [id]);
  if (!c) return { ok: false, error: 'No existe esa conversación' };
  const mensajes = await q('SELECT rol, contenido FROM mensajes WHERE conversacion_id = ? ORDER BY id', [id]);
  if (!mensajes.length) {
    await q('DELETE FROM conversaciones WHERE id = ?', [id]);
    return { ok: true, vacia: true };
  }
  const fin = (await ultimaActividad(id)) || new Date();
  await q('UPDATE conversaciones SET fin = COALESCE(fin, ?) WHERE id = ?', [fin, id]);
  if (!c.titulo) {
    try {
      await titular(id, mensajes);
    } catch (e) {
      // Si falla el título automático, usa el inicio del primer mensaje.
      const primero = (mensajes.find((m) => m.rol === 'user') || mensajes[0]).contenido;
      await q('UPDATE conversaciones SET titulo = ? WHERE id = ? AND titulo IS NULL', [recortar(primero, 60), id]);
      console.error('titular:', e.message);
    }
  }
  const [final] = await q(`${SELECT_CONV} WHERE c.id = ?`, [id]);
  return { ok: true, conversacion: convPublica(final) };
}

function recortar(t, n) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Pide a Claude un título, resumen y proyecto para la conversación.
async function titular(id, mensajes) {
  const proyectos = (await H.listarProyectos()).map((p) => p.nombre);
  let transcripcion = mensajes.map((m) => `${m.rol === 'user' ? usuario().nombre : 'ADA'}: ${m.contenido}`).join('\n');
  if (transcripcion.length > 8000) transcripcion = `${transcripcion.slice(0, 3000)}\n[…]\n${transcripcion.slice(-4500)}`;
  const resp = await claude().messages.create({
    model: MODELO_RAPIDO(),
    max_tokens: 300,
    system: `Archivas conversaciones entre ${usuario().nombre} y su asistente ADA. Respondes solo con JSON válido, sin texto adicional.`,
    messages: [{
      role: 'user',
      content: `Proyectos existentes: ${JSON.stringify(proyectos)}

Conversación:
${transcripcion}

Devuelve JSON con:
- "titulo": máximo 7 palabras, concreto, en español (ej: "Reagendar reunión con Paola").
- "resumen": 1 o 2 frases con lo que se habló, decidió o quedó pendiente.
- "proyecto": el nombre EXACTO de uno de los proyectos existentes si la conversación trata principalmente de él; si no, null.`,
    }],
  });
  const texto = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = JSON.parse(texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1));
  let proyectoId = null;
  if (json.proyecto && proyectos.includes(json.proyecto)) {
    const p = await H.resolverProyecto(json.proyecto, { crear: false });
    proyectoId = p ? p.id : null;
  }
  await q(
    'UPDATE conversaciones SET titulo = ?, resumen = ?, proyecto_id = COALESCE(proyecto_id, ?) WHERE id = ?',
    [recortar(json.titulo || 'Conversación', 120), json.resumen || null, proyectoId, id]
  );
}

// ---------- Consultas ----------

const SELECT_CONV = `SELECT c.*, p.nombre AS proyecto,
    (SELECT COUNT(*) FROM mensajes m WHERE m.conversacion_id = c.id) AS n_mensajes,
    (SELECT COUNT(*) FROM documentos d WHERE d.conversacion_id = c.id) + (SELECT COUNT(*) FROM archivos a WHERE a.conversacion_id = c.id) AS n_documentos
  FROM conversaciones c LEFT JOIN proyectos p ON p.id = c.proyecto_id`;

function convPublica(c) {
  return {
    id: c.id,
    titulo: c.titulo || (c.fin ? 'Conversación' : 'Conversación en curso'),
    resumen: c.resumen,
    proyecto: c.proyecto,
    proyecto_id: c.proyecto_id,
    modo: c.modo,
    inicio: c.inicio,
    fin: c.fin,
    abierta: !c.fin,
    n_mensajes: c.n_mensajes,
    n_documentos: c.n_documentos,
  };
}

async function listar({ proyecto_id: proyectoId, texto } = {}) {
  const where = ['EXISTS (SELECT 1 FROM mensajes m WHERE m.conversacion_id = c.id)'];
  const params = [];
  if (proyectoId === 'general') where.push('c.proyecto_id IS NULL');
  else if (proyectoId) { where.push('c.proyecto_id = ?'); params.push(parseInt(proyectoId, 10)); }
  if (texto) {
    where.push(`(c.titulo LIKE ? OR c.resumen LIKE ? OR EXISTS
      (SELECT 1 FROM mensajes m WHERE m.conversacion_id = c.id AND m.contenido LIKE ?))`);
    params.push(`%${texto}%`, `%${texto}%`, `%${texto}%`);
  }
  const rows = await q(`${SELECT_CONV} WHERE ${where.join(' AND ')} ORDER BY c.inicio DESC LIMIT 100`, params);
  return rows.map(convPublica);
}

async function carpetas() {
  const rows = await q(`
    SELECT p.id, p.nombre, COUNT(c.id) AS n FROM conversaciones c
    JOIN proyectos p ON p.id = c.proyecto_id
    WHERE EXISTS (SELECT 1 FROM mensajes m WHERE m.conversacion_id = c.id)
    GROUP BY p.id, p.nombre ORDER BY MAX(c.inicio) DESC`);
  const [{ n: general }] = await q(`SELECT COUNT(*) AS n FROM conversaciones c WHERE c.proyecto_id IS NULL
    AND EXISTS (SELECT 1 FROM mensajes m WHERE m.conversacion_id = c.id)`);
  const [{ n: total }] = await q(`SELECT COUNT(*) AS n FROM conversaciones c
    WHERE EXISTS (SELECT 1 FROM mensajes m WHERE m.conversacion_id = c.id)`);
  return { total, general, proyectos: rows };
}

async function detalle(id) {
  const [c] = await q(`${SELECT_CONV} WHERE c.id = ?`, [id]);
  if (!c) return null;
  const [mensajes, documentos, archivos] = await Promise.all([
    q('SELECT id, rol, contenido, creado_en FROM mensajes WHERE conversacion_id = ? ORDER BY id', [id]),
    q('SELECT id, titulo, creado_en FROM documentos WHERE conversacion_id = ? ORDER BY id', [id]),
    q('SELECT id, nombre, tipo, drive_url, creado_en FROM archivos WHERE conversacion_id = ? ORDER BY id', [id]),
  ]);
  return { conversacion: convPublica(c), mensajes, documentos, archivos };
}

async function moverConversacion(id, proyecto) {
  const p = proyecto ? await H.resolverProyecto(proyecto) : null;
  await q('UPDATE conversaciones SET proyecto_id = ? WHERE id = ?', [p ? p.id : null, id]);
  const [c] = await q(`${SELECT_CONV} WHERE c.id = ?`, [id]);
  return convPublica(c);
}

// ---------- Documentos ----------

async function obtenerDocumento(id) {
  const [d] = await q(
    `SELECT d.*, p.nombre AS proyecto FROM documentos d LEFT JOIN proyectos p ON p.id = d.proyecto_id WHERE d.id = ?`, [id]
  );
  return d || null;
}

async function entregarDocumento(a, ctx = {}) {
  if (!a.titulo || !a.contenido) throw new Error('titulo y contenido son obligatorios');
  const p = a.proyecto ? await H.resolverProyecto(a.proyecto) : null;
  const r = await q(
    'INSERT INTO documentos (conversacion_id, proyecto_id, titulo, contenido, creado_en) VALUES (?, ?, ?, ?, ?)',
    [ctx.conversacionId || null, p ? p.id : null, String(a.titulo).slice(0, 200), a.contenido, new Date()]
  );
  if (p && ctx.conversacionId) {
    await q('UPDATE conversaciones SET proyecto_id = COALESCE(proyecto_id, ?) WHERE id = ?', [p.id, ctx.conversacionId]);
  }
  return {
    ok: true,
    documento_id: r.insertId,
    nota: 'El documento ya está en la pantalla de Cristian. Dile en una frase que te lo dejaste ahí; no repitas su contenido.',
  };
}

H.registrar([{
  name: 'entregar_documento',
  description: 'Entrega un documento en la pantalla de Cristian: borradores, cartas, minutas, informes, listas largas, planes, la revisión semanal o cualquier texto que deba leer, copiar o guardar. Úsala siempre que pida "un documento", "redáctame", "hazme una lista", "mándamelo", o cuando la respuesta sea demasiado larga para decirla. Queda archivado con la conversación.',
  input_schema: {
    type: 'object',
    properties: {
      titulo: { type: 'string', description: 'Título claro del documento' },
      contenido: { type: 'string', description: 'Contenido completo en markdown (títulos con ##, listas, negritas)' },
      proyecto: { type: 'string', description: 'Proyecto al que pertenece, si aplica' },
    },
    required: ['titulo', 'contenido'],
  },
}], { entregar_documento: entregarDocumento });

module.exports = { asegurar, cerrar, listar, carpetas, detalle, moverConversacion, obtenerDocumento };
