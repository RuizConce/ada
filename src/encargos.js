// Contactos, encargos delegados y acciones que requieren autorización de Cristian.
// Principio: ADA propone; el backend guarda la propuesta; solo un botón de Cristian la ejecuta.
const { q } = require('./db');
const F = require('./fechas');
const H = require('./herramientas');

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

const SELECT_CONTACTO = 'SELECT id, nombre, relacion, organizacion, email, telefono, notas FROM contactos';

function contactoPublico(c) {
  if (!c) return null;
  const o = { id: c.id, nombre: c.nombre };
  for (const k of ['relacion', 'organizacion', 'email', 'telefono', 'notas']) if (c[k]) o[k] = c[k];
  return o;
}

async function resolverContacto(nombre, { crear = false } = {}) {
  if (!nombre || !String(nombre).trim()) return null;
  const limpio = String(nombre).trim();
  let rows = await q(`${SELECT_CONTACTO} WHERE LOWER(nombre) = LOWER(?)`, [limpio]);
  if (rows.length) return rows[0];
  rows = await q(`${SELECT_CONTACTO} WHERE LOWER(nombre) LIKE LOWER(?) ORDER BY CHAR_LENGTH(nombre) LIMIT 2`, [`%${limpio}%`]);
  if (rows.length === 1) return rows[0];
  if (!crear) return null;
  const ahora = new Date();
  const r = await q('INSERT INTO contactos (nombre, creado_en, actualizado_en) VALUES (?, ?, ?)', [limpio.slice(0, 160), ahora, ahora]);
  return { id: r.insertId, nombre: limpio.slice(0, 160), nuevo: true };
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
  let existente = a.id ? (await q(`${SELECT_CONTACTO} WHERE id = ?`, [a.id]))[0] : null;
  if (!existente) existente = (await q(`${SELECT_CONTACTO} WHERE LOWER(nombre) = LOWER(?)`, [a.nombre.trim()]))[0];
  if (existente) {
    const sets = ['nombre = ?', 'actualizado_en = ?'];
    const params = [a.nombre.trim(), ahora];
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
    `INSERT INTO contactos (nombre, relacion, organizacion, email, telefono, notas, creado_en, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.nombre.trim(), a.relacion || null, a.organizacion || null, a.email || null, a.telefono || null, a.notas || null, ahora, ahora]
  );
  const [c] = await q(`${SELECT_CONTACTO} WHERE id = ?`, [r.insertId]);
  return { ok: true, creado: true, contacto: contactoPublico(c) };
}

async function buscarContactos(a = {}) {
  const t = `%${(a.texto || '').trim()}%`;
  const rows = await q(
    `${SELECT_CONTACTO} WHERE nombre LIKE ? OR organizacion LIKE ? OR relacion LIKE ? OR notas LIKE ?
     ORDER BY nombre LIMIT 20`, [t, t, t, t]
  );
  const out = [];
  for (const c of rows) {
    const enc = await q(`SELECT id, titulo, estado FROM encargos WHERE contacto_id = ? AND estado IN (?) ORDER BY id DESC LIMIT 5`,
      [c.id, ACTIVOS]);
    out.push({ ...contactoPublico(c), encargos_activos: enc });
  }
  return { total: out.length, contactos: out };
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

// ---------- Contexto para ADA ----------

async function resumenParaContexto() {
  const ahora = new Date();
  const [activos, pendientes] = await Promise.all([
    q(`${SELECT_ENCARGO} WHERE e.estado IN (?) ORDER BY e.revisar_en IS NULL, e.revisar_en ASC LIMIT 15`, [ACTIVOS]),
    q("SELECT COUNT(*) AS n FROM acciones WHERE estado = 'propuesta'"),
  ]);
  return {
    encargos_activos: activos.map(encargoPublico),
    encargos_para_revisar_ahora: activos.filter((e) => e.revisar_en && new Date(e.revisar_en) <= ahora).map((e) => e.id),
    mensajes_esperando_tu_autorizacion: pendientes[0].n,
  };
}

// ---------- Definiciones para Claude ----------

const DEFINICIONES = [
  {
    name: 'guardar_contacto',
    description: 'Crea o actualiza un contacto de Cristian (por nombre). Úsala cuando mencione datos de una persona: relación, organización, teléfono, correo o algo útil para tratarla. Las notas se acumulan.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
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
    description: 'Busca contactos por nombre, organización, relación o notas, con sus encargos activos.',
    input_schema: { type: 'object', properties: { texto: { type: 'string' } } },
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

H.registrar(DEFINICIONES, {
  guardar_contacto: guardarContacto,
  buscar_contactos: buscarContactos,
  crear_encargo: crearEncargo,
  actualizar_encargo: actualizarEncargo,
  listar_encargos: listarEncargos,
  ver_encargo: verEncargo,
  proponer_mensaje: proponerAccion,
});

module.exports = { autorizacionesPendientes, resolverAccion, resumenParaContexto, normalizarTelefono, listarEncargos };
