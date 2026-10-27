// Contactos, encargos delegados y acciones que requieren autorización de Cristian.
// Principio: ADA propone; el backend guarda la propuesta; solo un botón de Cristian la ejecuta.
const { q } = require('./db');
const F = require('./fechas');
const H = require('./herramientas');
const K = require('./contactos');

const ESTADOS = ['en_curso', 'esperando_autorizacion', 'esperando_respuesta', 'necesita_decision', 'resuelto', 'cancelado'];
const ACTIVOS = ESTADOS.slice(0, 4);
const CANALES = ['whatsapp', 'correo', 'llamada', 'otro'];
const HORAS_SEGUIMIENTO = () => parseInt(process.env.ADA_HORAS_SEGUIMIENTO || '24', 10);

// ---------- Utilidades ----------

function normalizarTelefono(t) {
  if (!t) return null;
  let d = String(t).replace(/\D/g, '');
  if (d.length === 9 && d.startsWith('9')) d = `56${d}`; // celular chileno sin código de país
  return d || null;
}

const SELECT_CONTACTO = 'SELECT id, nombre, alias, relacion, organizacion, email, telefono, notas FROM contactos';

function contactoPublico(c) {
  if (!c) return null;
  const o = { id: c.id, nombre: c.nombre };
  const alias = Array.isArray(c.alias) ? c.alias : K.aLista(c.alias);
  if (alias.length) o.alias = alias;
  for (const k of ['relacion', 'organizacion', 'email', 'telefono', 'notas']) if (c[k]) o[k] = c[k];
  return o;
}

const candidatoPublico = (c) => ({
  nombre: c.nombre, fuente: c.fuente, ...(c.id ? { id: c.id } : {}),
  ...(c.alias && c.alias.length ? { alias: c.alias } : {}),
  ...(c.relacion ? { relacion: c.relacion } : {}), ...(c.organizacion ? { organizacion: c.organizacion } : {}),
  ...(c.email ? { email: c.email } : {}), ...(c.telefono ? { telefono: c.telefono } : {}),
  ...(c.notas ? { notas: c.notas } : {}),
  parecido: c.puntaje,
});

// Un contacto de Google que se usa queda guardado en ADA (así la próxima vez es inmediato).
async function importar(c) {
  const ahora = new Date();
  const r = await q(
    `INSERT INTO contactos (nombre, alias, relacion, organizacion, email, telefono, notas, creado_en, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.nombre.slice(0, 160), (c.alias || []).join('|') || null, c.relacion || null, c.organizacion || null,
      c.email || null, c.telefono || null, `Importado de ${c.fuente}`, ahora, ahora]
  );
  const [row] = await q(`${SELECT_CONTACTO} WHERE id = ?`, [r.insertId]);
  return row;
}

class ContactoAmbiguo extends Error {}

// Encuentra a la persona aunque se diga distinto. Si hay dudas, no adivina: pide elegir.
async function resolverContacto(nombre, { crear = false } = {}) {
  if (!nombre || !String(nombre).trim()) return null;
  const limpio = String(nombre).trim();
  const [exacto] = await q(`${SELECT_CONTACTO} WHERE LOWER(nombre) = LOWER(?)`, [limpio]);
  if (exacto) return exacto;
  const r = await K.encontrar(limpio);
  if (r.confianza === 'alta') {
    const c = r.candidatos[0];
    return c.fuente === 'ADA' ? (await q(`${SELECT_CONTACTO} WHERE id = ?`, [c.id]))[0] : importar(c);
  }
  if (r.confianza === 'varios') {
    const lista = r.candidatos.map((c) => `${c.nombre}${c.organizacion ? ` (${c.organizacion})` : ''}${c.relacion ? ` [${c.relacion}]` : ''} — ${c.fuente}`).join('; ');
    throw new ContactoAmbiguo(`No estoy segura de a quién se refiere con "${limpio}". Posibles: ${lista}. Pregúntale a Cristian cuál es (sin adivinar) y vuelve a llamar con el nombre exacto. Si confirma un apodo o relación, guárdalo con guardar_contacto (alias / relacion).`);
  }
  if (!crear) return null;
  const ahora = new Date();
  const ins = await q('INSERT INTO contactos (nombre, creado_en, actualizado_en) VALUES (?, ?, ?)', [limpio.slice(0, 160), ahora, ahora]);
  return { id: ins.insertId, nombre: limpio.slice(0, 160), nuevo: true };
}

async function anotar(encargoId, texto) {
  await q('INSERT INTO bitacora (encargo_id, texto, creado_en) VALUES (?, ?, ?)', [encargoId, texto, new Date()]);
}

const SELECT_ENCARGO = `SELECT e.*, c.nombre AS contacto, p.nombre AS proyecto FROM encargos e
  LEFT JOIN contactos c ON c.id = e.contacto_id LEFT JOIN proyectos p ON p.id = e.proyecto_id`;

function encargoPublico(e) {
  const o = { id: e.id, titulo: e.titulo, estado: e.estado };
  if (e.objetivo) o.objetivo = e.objetivo;
  if (e.contacto) o.contacto = e.contacto;
  if (e.proyecto) o.proyecto = e.proyecto;
  if (e.siguiente_paso) o.siguiente_paso = e.siguiente_paso;
  if (e.revisar_en) o.revisar_en = F.fmt(e.revisar_en);
  if (e.resultado) o.resultado = e.resultado;
  o.actualizado = F.fmt(e.actualizado_en);
  return o;
}

// ---------- Contactos ----------

async function guardarContacto(a) {
  if (!a.nombre || !String(a.nombre).trim()) throw new Error('nombre es obligatorio');
  const campos = ['relacion', 'organizacion', 'email', 'telefono', 'notas'];
  const ahora = new Date();
  const aliasNuevos = (Array.isArray(a.alias) ? a.alias : K.aLista(String(a.alias || '').replace(/,/g, '|')))
    .map((x) => String(x).trim().slice(0, 60)).filter(Boolean);
  let existente = a.id ? (await q(`${SELECT_CONTACTO} WHERE id = ?`, [a.id]))[0] : null;
  if (!existente) existente = (await q(`${SELECT_CONTACTO} WHERE LOWER(nombre) = LOWER(?)`, [a.nombre.trim()]))[0];
  if (existente) {
    const sets = ['nombre = ?', 'actualizado_en = ?'];
    const params = [a.nombre.trim(), ahora];
    if (aliasNuevos.length) {
      const todos = [...K.aLista(existente.alias)];
      for (const x of aliasNuevos) if (!todos.some((y) => K.normalizar(y) === K.normalizar(x))) todos.push(x);
      sets.push('alias = ?'); params.push(todos.join('|'));
    }
    for (const k of campos) {
      if (a[k] === undefined) continue;
      let v = a[k];
      if (k === 'notas' && existente.notas && v && !String(v).includes(existente.notas)) v = `${existente.notas}\n${v}`;
      sets.push(`${k} = ?`); params.push(v || null);
    }
    params.push(existente.id);
    await q(`UPDATE contactos SET ${sets.join(', ')} WHERE id = ?`, params);
    const [c] = await q(`${SELECT_CONTACTO} WHERE id = ?`, [existente.id]);
    return { ok: true, actualizado: true, contacto: contactoPublico(c) };
  }
  const r = await q(
    `INSERT INTO contactos (nombre, alias, relacion, organizacion, email, telefono, notas, creado_en, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.nombre.trim(), aliasNuevos.join('|') || null, a.relacion || null, a.organizacion || null, a.email || null, a.telefono || null, a.notas || null, ahora, ahora]
  );
  const [c] = await q(`${SELECT_CONTACTO} WHERE id = ?`, [r.insertId]);
  return { ok: true, creado: true, contacto: contactoPublico(c) };
}

async function buscarContactos(a = {}) {
  const texto = (a.texto || '').trim();
  if (!texto) {
    const rows = await q(`${SELECT_CONTACTO} ORDER BY actualizado_en DESC LIMIT 20`);
    return { total: rows.length, contactos: rows.map(contactoPublico) };
  }
  const r = await K.encontrar(texto, { conGoogle: a.incluir_google !== false });
  const contactos = [];
  for (const c of r.candidatos) {
    const o = candidatoPublico(c);
    if (c.fuente === 'ADA') {
      o.encargos_activos = await q('SELECT id, titulo, estado FROM encargos WHERE contacto_id = ? AND estado IN (?) ORDER BY id DESC LIMIT 5', [c.id, ACTIVOS]);
    }
    contactos.push(o);
  }
  return {
    confianza: r.confianza,
    indicacion: r.confianza === 'alta' ? 'Coincidencia clara.'
      : r.confianza === 'varios' ? 'Hay más de una posibilidad: pregúntale a cuál se refiere antes de actuar.'
        : 'No encontré a nadie parecido. No inventes datos: pídeselos y guárdalos con guardar_contacto.',
    google_contactos: r.google_contactos,
    total: contactos.length,
    contactos,
  };
}

// ---------- Encargos ----------

async function crearEncargo(a) {
  if (!a.titulo || !String(a.titulo).trim()) throw new Error('titulo es obligatorio');
  const contacto = await resolverContacto(a.contacto, { crear: true });
  const proyecto = await H.resolverProyecto(a.proyecto);
  const ahora = new Date();
  const r = await q(
    `INSERT INTO encargos (titulo, objetivo, contacto_id, proyecto_id, estado, siguiente_paso, revisar_en, creado_en, actualizado_en)
     VALUES (?, ?, ?, ?, 'en_curso', ?, ?, ?, ?)`,
    [a.titulo.trim().slice(0, 300), a.objetivo || null, contacto ? contacto.id : null, proyecto ? proyecto.id : null,
      a.siguiente_paso || null, F.parse(a.revisar_en), ahora, ahora]
  );
  await anotar(r.insertId, 'Encargo creado');
  const [e] = await q(`${SELECT_ENCARGO} WHERE e.id = ?`, [r.insertId]);
  return {
    ok: true,
    encargo: encargoPublico(e),
    contacto_nuevo_sin_datos: contacto && contacto.nuevo ? contacto.nombre : undefined,
  };
}

async function actualizarEncargo(a) {
  const [actual] = await q('SELECT * FROM encargos WHERE id = ?', [a.id]);
  if (!actual) throw new Error(`No existe el encargo ${a.id}`);
  const sets = [];
  const params = [];
  const cambios = [];
  if (a.estado !== undefined) {
    if (!ESTADOS.includes(a.estado)) throw new Error(`estado debe ser: ${ESTADOS.join(', ')}`);
    sets.push('estado = ?'); params.push(a.estado); cambios.push(`estado → ${a.estado}`);
    if (a.estado === 'resuelto' || a.estado === 'cancelado') { sets.push('revisar_en = NULL'); }
  }
  if (a.siguiente_paso !== undefined) { sets.push('siguiente_paso = ?'); params.push(a.siguiente_paso); cambios.push(`siguiente paso: ${a.siguiente_paso}`); }
  if (a.revisar_en !== undefined && !['resuelto', 'cancelado'].includes(a.estado)) {
    sets.push('revisar_en = ?'); params.push(F.parse(a.revisar_en)); cambios.push(`revisar: ${a.revisar_en}`);
  }
  if (a.resultado !== undefined) { sets.push('resultado = ?'); params.push(a.resultado); cambios.push(`resultado: ${a.resultado}`); }
  if (a.titulo !== undefined) { sets.push('titulo = ?'); params.push(a.titulo); }
  if (a.contacto !== undefined) {
    const c = await resolverContacto(a.contacto, { crear: true });
    sets.push('contacto_id = ?'); params.push(c ? c.id : null);
    cambios.push(`contacto: ${c ? c.nombre : 'ninguno'}`);
  }
  if (a.proyecto !== undefined) {
    const p = await H.resolverProyecto(a.proyecto);
    sets.push('proyecto_id = ?'); params.push(p ? p.id : null);
    cambios.push(`proyecto: ${p ? p.nombre : 'ninguno'}`);
  }
  if (a.objetivo !== undefined) { sets.push('objetivo = ?'); params.push(a.objetivo); }
  if (sets.length) {
    sets.push('actualizado_en = ?'); params.push(new Date());
    params.push(a.id);
    await q(`UPDATE encargos SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  if (a.nota || cambios.length) await anotar(a.id, [a.nota, ...cambios].filter(Boolean).join(' · '));
  if (!sets.length && !a.nota) throw new Error('No indicaste nada que cambiar');
  const [e] = await q(`${SELECT_ENCARGO} WHERE e.id = ?`, [a.id]);
  return { ok: true, encargo: encargoPublico(e) };
}

async function listarEncargos(a = {}) {
  const where = [];
  const params = [];
  if (a.estado) { where.push('e.estado = ?'); params.push(a.estado); }
  else if (a.incluir_cerrados !== true) { where.push('e.estado IN (?)'); params.push(ACTIVOS); }
  if (a.contacto) { where.push('c.nombre LIKE ?'); params.push(`%${a.contacto}%`); }
  if (a.proyecto) { where.push('p.nombre LIKE ?'); params.push(`%${a.proyecto}%`); }
  if (a.texto) { where.push('(e.titulo LIKE ? OR e.objetivo LIKE ?)'); params.push(`%${a.texto}%`, `%${a.texto}%`); }
  const rows = await q(
    `${SELECT_ENCARGO} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY e.revisar_en IS NULL, e.revisar_en ASC, e.actualizado_en DESC LIMIT 30`, params
  );
  return { total: rows.length, encargos: rows.map(encargoPublico) };
}

async function verEncargo(a) {
  const [e] = await q(`${SELECT_ENCARGO} WHERE e.id = ?`, [a.id]);
  if (!e) throw new Error(`No existe el encargo ${a.id}`);
  const [bit, acc, contacto] = await Promise.all([
    q('SELECT texto, creado_en FROM bitacora WHERE encargo_id = ? ORDER BY id', [a.id]),
    q('SELECT id, canal, destinatario, asunto, contenido, estado, creado_en FROM acciones WHERE encargo_id = ? ORDER BY id', [a.id]),
    e.contacto_id ? q(`${SELECT_CONTACTO} WHERE id = ?`, [e.contacto_id]) : Promise.resolve([]),
  ]);
  return {
    encargo: encargoPublico(e),
    contacto: contactoPublico(contacto[0]),
    bitacora: bit.map((b) => `${F.fmt(b.creado_en)}: ${b.texto}`),
    acciones: acc.map((x) => ({ ...x, creado_en: F.fmt(x.creado_en) })),
  };
}

// ---------- Acciones con autorización ----------

async function proponerAccion(a) {
  if (!CANALES.includes(a.canal)) throw new Error(`canal debe ser: ${CANALES.join(', ')}`);
  if (!a.contenido || !String(a.contenido).trim()) throw new Error('contenido es obligatorio');
  let encargo = null;
  if (a.encargo_id) {
    [encargo] = await q('SELECT * FROM encargos WHERE id = ?', [a.encargo_id]);
    if (!encargo) throw new Error(`No existe el encargo ${a.encargo_id}`);
  }
  let contacto = null;
  if (a.contacto) contacto = await resolverContacto(a.contacto);
  else if (encargo && encargo.contacto_id) [contacto] = await q(`${SELECT_CONTACTO} WHERE id = ?`, [encargo.contacto_id]);

  let destinatario = a.destinatario || null;
  if (!destinatario && contacto) {
    destinatario = a.canal === 'correo' ? contacto.email : (a.canal === 'whatsapp' || a.canal === 'llamada') ? contacto.telefono : null;
  }
  const responderA = a.canal === 'correo' && a.responder_a_id ? String(a.responder_a_id) : null;
  const faltaDato = (a.canal === 'whatsapp' || a.canal === 'llamada' || (a.canal === 'correo' && !responderA)) && !destinatario;

  const r = await q(
    `INSERT INTO acciones (encargo_id, canal, destinatario, contacto_id, asunto, contenido, responder_a, estado, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'propuesta', ?)`,
    [encargo ? encargo.id : null, a.canal, destinatario, contacto ? contacto.id : null, a.asunto || null, a.contenido.trim(), responderA, new Date()]
  );
  if (encargo) {
    await q("UPDATE encargos SET estado = 'esperando_autorizacion', actualizado_en = ? WHERE id = ?", [new Date(), encargo.id]);
    await anotar(encargo.id, `Propuesta de mensaje por ${a.canal}${contacto ? ` a ${contacto.nombre}` : ''} (esperando autorización)`);
  }
  return {
    ok: true,
    accion_id: r.insertId,
    nota: 'Cristian verá un botón para autorizar y enviar. NO digas que el mensaje fue enviado.' +
      (faltaDato ? ` Falta el ${a.canal === 'correo' ? 'correo' : 'teléfono'} del destinatario: pídeselo a Cristian y guárdalo con guardar_contacto; podrá enviarlo igual copiando el texto.` : ''),
  };
}

async function autorizacionesPendientes() {
  const rows = await q(
    `SELECT a.*, c.nombre AS contacto, e.titulo AS encargo FROM acciones a
     LEFT JOIN contactos c ON c.id = a.contacto_id LEFT JOIN encargos e ON e.id = a.encargo_id
     WHERE a.estado = 'propuesta' ORDER BY a.id`
  );
  const gmail = rows.some((r) => r.canal === 'correo') ? await correo().disponible().catch(() => false) : false;
  return rows.map((r) => ({
    id: r.id,
    encargo_id: r.encargo_id,
    encargo: r.encargo,
    canal: r.canal,
    contacto: r.contacto,
    destinatario: r.destinatario,
    telefono: r.canal === 'whatsapp' || r.canal === 'llamada' ? normalizarTelefono(r.destinatario) : null,
    asunto: r.asunto,
    contenido: r.contenido,
    responde_correo: !!r.responder_a,
    gmail: r.canal === 'correo' && gmail,
    creado: F.fmt(r.creado_en),
  }));
}

// Llamado SOLO desde el botón de la app (nunca por el modelo).
// Gmail se carga tarde para no crear dependencias circulares.
const correo = () => require('./gmail');

async function resolverAccion(id, decision, contenidoEditado, conversacionId = null, opciones = {}) {
  const [a] = await q(
    `SELECT a.*, c.nombre AS contacto FROM acciones a LEFT JOIN contactos c ON c.id = a.contacto_id WHERE a.id = ?`, [id]
  );
  if (!a) throw new Error('No existe esa acción');
  if (a.estado !== 'propuesta') throw new Error('Esa acción ya fue resuelta');
  const ahora = new Date();
  const quien = a.contacto || a.destinatario || 'el destinatario';
  if (decision === 'enviar') {
    const contenido = contenidoEditado && contenidoEditado.trim() ? contenidoEditado.trim() : a.contenido;
    const asunto = opciones.asunto && String(opciones.asunto).trim() ? String(opciones.asunto).trim() : a.asunto;
    let envio = null;
    // Con Gmail conectado, el botón envía el correo de verdad (Cristian ya lo autorizó al tocarlo).
    if (opciones.via === 'gmail') {
      if (a.canal !== 'correo') throw new Error('Solo los correos se envían por Gmail');
      envio = await correo().enviar({ para: a.destinatario, asunto, cuerpo: contenido, responderA: a.responder_a });
    }
    await q("UPDATE acciones SET estado = 'ejecutada', contenido = ?, asunto = ?, destinatario = COALESCE(destinatario, ?), resuelto_en = ? WHERE id = ?",
      [contenido, asunto, envio ? envio.para : null, ahora, id]);
    if (a.encargo_id) {
      const revisar = new Date(ahora.getTime() + HORAS_SEGUIMIENTO() * 3600e3);
      await q(
        "UPDATE encargos SET estado = 'esperando_respuesta', revisar_en = ?, actualizado_en = ? WHERE id = ?",
        [revisar, ahora, a.encargo_id]
      );
      await anotar(a.encargo_id, `Cristian autorizó y envió el mensaje por ${a.canal} a ${quien}${contenido !== a.contenido ? ' (editado)' : ''}. Revisar respuesta: ${F.fmt(revisar)}`);
    }
    await q("INSERT INTO mensajes (rol, contenido, conversacion_id, creado_en) VALUES ('user', ?, ?, ?)",
      [`[Desde botón] Autoricé y envié el mensaje por ${envio ? 'Gmail' : a.canal} a ${quien}${a.encargo_id ? ` (encargo #${a.encargo_id})` : ''}.`, conversacionId, ahora]);
    return { ok: true, estado: 'ejecutada', enviado_por_gmail: !!envio };
  }
  if (decision === 'rechazar') {
    await q("UPDATE acciones SET estado = 'rechazada', resuelto_en = ? WHERE id = ?", [ahora, id]);
    if (a.encargo_id) {
      await q("UPDATE encargos SET estado = 'en_curso', actualizado_en = ? WHERE id = ?", [ahora, a.encargo_id]);
      await anotar(a.encargo_id, `Cristian rechazó el mensaje propuesto para ${quien}`);
    }
    await q("INSERT INTO mensajes (rol, contenido, conversacion_id, creado_en) VALUES ('user', ?, ?, ?)",
      [`[Desde botón] Rechacé el mensaje propuesto para ${quien}${a.encargo_id ? ` (encargo #${a.encargo_id})` : ''}.`, conversacionId, ahora]);
    return { ok: true, estado: 'rechazada' };
  }
  throw new Error('Decisión no válida');
}

// Descartar lo pide la persona en la conversación (enviar, en cambio, solo con su botón).
async function descartarMensaje(a = {}) {
  const ids = a.todos ? (await q("SELECT id FROM acciones WHERE estado = 'propuesta'")).map((x) => x.id)
    : (Array.isArray(a.ids) ? a.ids : [a.id]).map((x) => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) throw new Error('Indica cuál (id) o todos: true');
  const ahora = new Date();
  let descartados = 0;
  for (const id of ids) {
    const [acc] = await q(`SELECT a.*, c.nombre AS contacto FROM acciones a LEFT JOIN contactos c ON c.id = a.contacto_id WHERE a.id = ? AND a.estado = 'propuesta'`, [id]);
    if (!acc) continue;
    await q("UPDATE acciones SET estado = 'rechazada', resuelto_en = ? WHERE id = ?", [ahora, id]);
    if (acc.encargo_id) {
      await q("UPDATE encargos SET estado = 'en_curso', actualizado_en = ? WHERE id = ? AND estado = 'esperando_autorizacion'", [ahora, acc.encargo_id]);
      await anotar(acc.encargo_id, `Cristian pidió descartar el mensaje para ${acc.contacto || acc.destinatario || 'el destinatario'}`);
    }
    descartados += 1;
  }
  return { ok: true, descartados, nota: 'Ya no aparecen para autorizar. No lo vuelvas a ofrecer.' };
}

// ---------- Contexto para ADA ----------

async function resumenParaContexto() {
  const ahora = new Date();
  const [activos, pendientes] = await Promise.all([
    q(`${SELECT_ENCARGO} WHERE e.estado IN (?) ORDER BY e.revisar_en IS NULL, e.revisar_en ASC LIMIT 15`, [ACTIVOS]),
    q(`SELECT a.id, a.canal, a.destinatario, a.asunto, c.nombre AS contacto FROM acciones a
       LEFT JOIN contactos c ON c.id = a.contacto_id WHERE a.estado = 'propuesta' ORDER BY a.id LIMIT 10`),
  ]);
  return {
    encargos_activos: activos.map(encargoPublico),
    encargos_para_revisar_ahora: activos.filter((e) => e.revisar_en && new Date(e.revisar_en) <= ahora).map((e) => e.id),
    mensajes_esperando_tu_autorizacion: pendientes.map((a) => `#${a.id} ${a.canal} a ${a.contacto || a.destinatario || 'sin destinatario'}${a.asunto ? ` (${a.asunto})` : ''}`),
  };
}

// ---------- Definiciones para Claude ----------

const DEFINICIONES = [
  {
    name: 'descartar_mensaje',
    description: 'Descarta mensajes que esperaban autorización (los del contexto "mensajes_esperando_tu_autorizacion", por su #id) cuando Cristian dice que no se envíen, que los borres o que no le preguntes más. No envía nada.',
    input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, todos: { type: 'boolean' } } },
  },
  {
    name: 'guardar_contacto',
    description: 'Crea o actualiza un contacto de Cristian (por nombre). Úsala cuando mencione datos de una persona: relación, apodos, organización, teléfono, correo o algo útil para tratarla. Cuando te enseñe cómo le dice a alguien ("mi señora se llama Iñora", "la Pao es Paola Díaz"), guarda la relación y el apodo en alias. Las notas y los alias se acumulan.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        alias: { type: 'array', items: { type: 'string' }, description: 'Cómo le dice Cristian: apodos o formas de referirse ("mi señora", "la Pao", "Iñora")' },
        relacion: { type: 'string', description: 'Ej: "socio", "encargada de Bellavista", "funcionaria SEREMI"' },
        organizacion: { type: 'string' },
        telefono: { type: 'string' },
        email: { type: 'string' },
        notas: { type: 'string', description: 'Datos útiles: cómo prefiere que le escriban, horarios, contexto' },
      },
      required: ['nombre'],
    },
  },
  {
    name: 'buscar_contactos',
    description: 'Encuentra a una persona aunque Cristian la nombre distinto: apodo, relación ("mi señora"), nombre mal escrito o sin tildes, nombre + organización ("Daniela de la escuela"). Busca en los contactos de ADA y en Google (libreta y personas con las que ha escrito por correo). Devuelve candidatos con su parecido y una confianza: si es "varios", pregunta a cuál se refiere; si es "ninguno", pide los datos. Úsala SIEMPRE antes de decir que no conoces a alguien.',
    input_schema: { type: 'object', properties: { texto: { type: 'string' }, incluir_google: { type: 'boolean' } } },
  },
  {
    name: 'crear_encargo',
    description: 'Crea un encargo: algo que Cristian te delega y que debes llevar hasta que quede resuelto (coordinar o reagendar una reunión, conseguir un documento, confirmar algo con alguien). Úsala cuando diga "encárgate", "coordina", "consígueme", "hazle seguimiento". Define siempre el siguiente paso y cuándo revisar.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Breve. Ej: "Reagendar reunión con Paola (Bellavista)"' },
        objetivo: { type: 'string', description: 'Qué significa que esté resuelto' },
        contacto: { type: 'string', description: 'Persona principal involucrada' },
        proyecto: { type: 'string' },
        siguiente_paso: { type: 'string' },
        revisar_en: { type: 'string', description: 'YYYY-MM-DD HH:MM: cuándo volver a mirarlo' },
      },
      required: ['titulo'],
    },
  },
  {
    name: 'actualizar_encargo',
    description: 'Actualiza un encargo: estado, siguiente paso, fecha de revisión, resultado o una nota para la bitácora. Usa "necesita_decision" cuando algo dependa de Cristian, y "resuelto" con resultado cuando el objetivo se cumplió.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        estado: { type: 'string', enum: ESTADOS },
        siguiente_paso: { type: 'string' },
        revisar_en: { type: 'string' },
        resultado: { type: 'string' },
        nota: { type: 'string', description: 'Qué pasó (ej: "Paola respondió que puede el jueves 11:00")' },
        titulo: { type: 'string' },
        objetivo: { type: 'string' },
        contacto: { type: 'string' },
        proyecto: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'listar_encargos',
    description: 'Lista encargos (por defecto los activos, ordenados por fecha de revisión).',
    input_schema: {
      type: 'object',
      properties: {
        estado: { type: 'string', enum: ESTADOS },
        incluir_cerrados: { type: 'boolean' },
        contacto: { type: 'string' },
        proyecto: { type: 'string' },
        texto: { type: 'string' },
      },
    },
  },
  {
    name: 'ver_encargo',
    description: 'Detalle de un encargo con su bitácora, mensajes propuestos/enviados y datos del contacto.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'proponer_mensaje',
    description: 'Prepara un mensaje para un tercero (WhatsApp, correo o guion de llamada). NO lo envía: queda esperando que Cristian lo autorice con un botón en la app. Úsala siempre que haya que escribirle a alguien. Redacta en el tono de Cristian: cercano, claro, breve y cordial.',
    input_schema: {
      type: 'object',
      properties: {
        encargo_id: { type: 'integer' },
        canal: { type: 'string', enum: CANALES },
        contacto: { type: 'string', description: 'Nombre del contacto (se usa su teléfono o correo guardado)' },
        destinatario: { type: 'string', description: 'Teléfono o correo explícito, si no está en el contacto' },
        asunto: { type: 'string', description: 'Solo para correo' },
        responder_a_id: { type: 'string', description: 'Solo correo: id del correo de Gmail que se responde (el destinatario y el asunto salen de ahí y queda en el mismo hilo)' },
        contenido: { type: 'string', description: 'Texto completo listo para enviar' },
      },
      required: ['canal', 'contenido'],
    },
  },
];

// Llamar: ADA busca el número y deja un botón; marca el teléfono de Cristian solo cuando él lo toca.
async function prepararLlamada(a) {
  let nombre = a.persona ? String(a.persona).trim() : '';
  let telefono = normalizarTelefono(a.telefono);
  if (!telefono) {
    if (!nombre) throw new Error('Dime a quién llamar (nombre) o el número');
    const c = await resolverContacto(nombre);
    if (!c) return { error: `No encontré a "${nombre}" en los contactos de ADA ni en Google. Pídele a Cristian el número (y guárdalo con guardar_contacto).` };
    nombre = c.nombre;
    telefono = normalizarTelefono(c.telefono);
    if (!telefono) return { error: `Tengo a ${c.nombre} pero sin teléfono. Pídele el número a Cristian y guárdalo con guardar_contacto.` };
  }
  const puntos = (Array.isArray(a.puntos) ? a.puntos : []).map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 6);
  return { ok: true, llamada: { nombre: nombre || null, telefono, motivo: a.motivo ? String(a.motivo).slice(0, 200) : null, puntos }, nota: 'En la pantalla quedó un botón para llamar: se marca cuando Cristian lo toca. Díselo en una frase.' };
}

DEFINICIONES.push({
  name: 'preparar_llamada',
  description: 'Cuando Cristian quiere llamar a alguien ("llama a Paola", "llámame a mi señora", "necesito hablar con el de la SEREMI"): busca el número en sus contactos (ADA y Google) y deja en pantalla un botón "Llamar" que marca desde su teléfono al tocarlo. ADA no llama sola. Si hay de qué hablar, agrega los puntos a tratar como ayuda-memoria.',
  input_schema: {
    type: 'object',
    properties: {
      persona: { type: 'string', description: 'Nombre, apodo o relación ("mi señora")' },
      telefono: { type: 'string', description: 'Solo si Cristian dictó un número' },
      motivo: { type: 'string', description: 'Para qué es la llamada, en pocas palabras' },
      puntos: { type: 'array', items: { type: 'string' }, description: 'Puntos a tratar (opcional, breves)' },
    },
  },
});

H.registrar(DEFINICIONES, {
  preparar_llamada: prepararLlamada,
  guardar_contacto: guardarContacto,
  buscar_contactos: buscarContactos,
  crear_encargo: crearEncargo,
  actualizar_encargo: actualizarEncargo,
  listar_encargos: listarEncargos,
  ver_encargo: verEncargo,
  proponer_mensaje: proponerAccion,
  descartar_mensaje: descartarMensaje,
});

module.exports = { resolverContacto, ContactoAmbiguo, autorizacionesPendientes, resolverAccion, resumenParaContexto, normalizarTelefono, listarEncargos };
