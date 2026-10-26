// Herramientas que ADA puede usar (tool use de Claude) y su implementación en MySQL.
const { q } = require('./db');
const F = require('./fechas');

const TIPOS = ['decision', 'avance', 'pendiente', 'compromiso', 'idea'];
const ESTADOS = ['abierto', 'hecho', 'descartado'];

// ---------- Proyectos ----------

async function resolverProyecto(nombre, { crear = true } = {}) {
  if (!nombre || !String(nombre).trim()) return null;
  const limpio = String(nombre).trim();
  let rows = await q('SELECT id, nombre FROM proyectos WHERE LOWER(nombre) = LOWER(?)', [limpio]);
  if (rows.length) return rows[0];
  rows = await q(
    'SELECT id, nombre FROM proyectos WHERE LOWER(nombre) LIKE LOWER(?) ORDER BY CHAR_LENGTH(nombre) LIMIT 1',
    [`%${limpio}%`]
  );
  if (rows.length) return rows[0];
  if (!crear) return null;
  const r = await q('INSERT INTO proyectos (nombre, creado_en) VALUES (?, ?)', [limpio.slice(0, 120), new Date()]);
  return { id: r.insertId, nombre: limpio.slice(0, 120), nuevo: true };
}

async function listarProyectos() {
  return q("SELECT id, nombre, estado, descripcion FROM proyectos WHERE estado <> 'cerrado' ORDER BY nombre");
}

// Memoria de proyectos: qué es cada uno y hechos clave que Cristian le cuenta a ADA.
async function guardarProyecto(a) {
  if (!a.nombre || !String(a.nombre).trim()) throw new Error('nombre es obligatorio');
  const p = await resolverProyecto(a.nombre);
  if (a.nuevo_nombre) await q('UPDATE proyectos SET nombre = ? WHERE id = ?', [a.nuevo_nombre.trim().slice(0, 120), p.id]);
  if (a.descripcion !== undefined) await q('UPDATE proyectos SET descripcion = ? WHERE id = ?', [a.descripcion, p.id]);
  if (a.estado) {
    if (!['activo', 'pausado', 'cerrado'].includes(a.estado)) throw new Error('estado debe ser activo, pausado o cerrado');
    await q('UPDATE proyectos SET estado = ? WHERE id = ?', [a.estado, p.id]);
  }
  if (a.dato) await q('INSERT INTO proyecto_notas (proyecto_id, texto, creado_en) VALUES (?, ?, ?)', [p.id, a.dato, new Date()]);
  return verProyecto({ nombre: a.nuevo_nombre || p.nombre });
}

async function verProyecto(a) {
  const p = await resolverProyecto(a.nombre, { crear: false });
  if (!p) return { error: `No conozco un proyecto llamado "${a.nombre}". Pregúntale a Cristian qué es y guárdalo con guardar_proyecto.` };
  const [[info], notas, abiertos, recientes, encargos] = await Promise.all([
    q('SELECT nombre, estado, descripcion FROM proyectos WHERE id = ?', [p.id]),
    q('SELECT texto, creado_en FROM proyecto_notas WHERE proyecto_id = ? ORDER BY id DESC LIMIT 30', [p.id]),
    q(`${SELECT_ITEMS} WHERE i.proyecto_id = ? AND i.estado = 'abierto' ORDER BY i.fecha_limite IS NULL, i.fecha_limite LIMIT 20`, [p.id]),
    q(`${SELECT_ITEMS} WHERE i.proyecto_id = ? AND i.tipo IN ('decision','avance') ORDER BY i.creado_en DESC LIMIT 10`, [p.id]),
    q(`SELECT e.id, e.titulo, e.estado FROM encargos e WHERE e.proyecto_id = ? AND e.estado NOT IN ('resuelto','cancelado')`, [p.id]).catch(() => []),
  ]);
  return {
    proyecto: info.nombre,
    estado: info.estado,
    descripcion: info.descripcion || '(sin descripción: pregúntale a Cristian de qué se trata)',
    datos_clave: notas.reverse().map((n) => `${F.fmt(n.creado_en).slice(0, 10)}: ${n.texto}`),
    abiertos: abiertos.map(itemPublico),
    decisiones_y_avances_recientes: recientes.map(itemPublico),
    encargos_activos: encargos,
  };
}

// ---------- Items ----------

function itemPublico(r) {
  return {
    id: r.id,
    tipo: r.tipo,
    texto: r.texto,
    razon: r.razon || undefined,
    proyecto: r.proyecto || undefined,
    persona: r.persona || undefined,
    fecha_limite: r.fecha_limite ? F.fmt(r.fecha_limite) : undefined,
    estado: r.estado,
    importante: r.importante ? true : undefined,
    en_calendario: r.evento_id ? true : undefined,
    creado: F.fmt(r.creado_en),
  };
}

// ---------- Preferencias de la persona ----------

const AVISOS_DEFECTO = {
  activos: true,
  despertar: '07:30',
  resumen: '07:45',
  silencio_desde: '22:00',
  cierre: '18:30',
  max_dia: 3,
  seguimiento: true,
  correos: true,
  cierre_activo: true,
};
const PREF_DEFECTO = { tareas_auto: true, modelo_modo: 'auto' };
async function preferencias() {
  const [r] = await q("SELECT datos FROM integraciones WHERE nombre = 'preferencias'");
  const guardadas = r ? JSON.parse(r.datos) : {};
  return { ...PREF_DEFECTO, ...guardadas, avisos: { ...AVISOS_DEFECTO, ...(guardadas.avisos || {}) } };
}
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
async function guardarPreferencias(cambios = {}) {
  const nuevas = { ...(await preferencias()) };
  if (cambios.tareas_auto !== undefined) nuevas.tareas_auto = !!cambios.tareas_auto;
  if (cambios.modelo_modo !== undefined) {
    if (!['auto', 'rapido', 'profundo'].includes(cambios.modelo_modo)) throw new Error('modelo_modo debe ser auto, rapido o profundo');
    nuevas.modelo_modo = cambios.modelo_modo;
  }
  if (cambios.avisos && typeof cambios.avisos === 'object') {
    const a = { ...nuevas.avisos };
    for (const k of ['despertar', 'resumen', 'silencio_desde', 'cierre']) {
      const v = cambios.avisos[k];
      if (v === undefined) continue;
      if (v === '' || v === null) a[k] = ''; // vacío = desactivado
      else if (HORA.test(v)) a[k] = v;
      else throw new Error(`Hora no válida para ${k}: usa HH:MM`);
    }
    for (const k of ['activos', 'seguimiento', 'correos', 'cierre_activo']) if (cambios.avisos[k] !== undefined) a[k] = !!cambios.avisos[k];
    if (cambios.avisos.max_dia !== undefined) a.max_dia = Math.max(0, Math.min(10, parseInt(cambios.avisos.max_dia, 10) || 0));
    nuevas.avisos = a;
  }
  await q(
    `INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('preferencias', ?, ?)
     ON DUPLICATE KEY UPDATE datos = VALUES(datos), actualizado_en = VALUES(actualizado_en)`,
    [JSON.stringify(nuevas), new Date()]
  );
  return nuevas;
}

// ---------- Tareas en Google Calendar ----------

const G = () => require('./google'); // carga tarde: google.js también registra herramientas aquí
const conHora = (t) => /\d{1,2}:\d{2}/.test(String(t || ''));
const agendable = (tipo) => tipo === 'pendiente' || tipo === 'compromiso';

// Publica el item en el calendario si corresponde. Nunca hace fallar el registro.
async function sincronizarTarea(row, { fechaTexto, agendar, importante } = {}) {
  try {
    if (agendar === false || !agendable(row.tipo) || !row.fecha_limite || row.estado !== 'abierto') return null;
    if (!(await preferencias()).tareas_auto) return { agendado: false, motivo: 'agendar tareas automáticamente está desactivado en Ajustes' };
    if (!(await G().calendarioDisponible())) return { agendado: false, motivo: 'Google Calendar no está conectado' };
    const { inicio, hora_supuesta } = G().momentoTarea(new Date(row.fecha_limite), conHora(fechaTexto));
    if (inicio < new Date(Date.now() - 5 * 60000)) return { agendado: false, motivo: 'la fecha ya pasó' };
    const t = { texto: row.texto, persona: row.persona, proyecto: row.proyecto, importante: !!(importante ?? row.importante), inicio };
    const r = await G().agendarTarea(t);
    await q('UPDATE items SET evento_id = ?, importante = ? WHERE id = ?', [r.evento_id, t.importante ? 1 : 0, row.id]);
    return {
      agendado: true,
      aviso: r.inicio,
      ...(hora_supuesta ? { hora_supuesta: 'No dijo hora: quedó con aviso a esa hora; menciónalo por si quiere otra.' } : {}),
      avisos: t.importante ? 'celular (a la hora y 30 min antes) y correo (1 día y 1 hora antes)' : 'celular (a la hora y 15 min antes)',
    };
  } catch (e) {
    return { agendado: false, motivo: `no se pudo agendar: ${e.message}` };
  }
}

const SELECT_ITEMS = `SELECT i.*, p.nombre AS proyecto FROM items i LEFT JOIN proyectos p ON p.id = i.proyecto_id`;

async function registrarItem(a) {
  if (!TIPOS.includes(a.tipo)) throw new Error(`tipo debe ser uno de: ${TIPOS.join(', ')}`);
  if (!a.texto || !String(a.texto).trim()) throw new Error('texto es obligatorio');
  const proyecto = await resolverProyecto(a.proyecto);
  const ahora = new Date();
  const estado = a.tipo === 'avance' || a.tipo === 'decision' ? 'hecho' : 'abierto';
  const r = await q(
    `INSERT INTO items (tipo, texto, razon, proyecto_id, persona, fecha_limite, estado, creado_en, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.tipo, a.texto.trim(), a.razon || null, proyecto ? proyecto.id : null, a.persona || null,
      F.parse(a.fecha_limite), estado, ahora, ahora]
  );
  const [row] = await q(`${SELECT_ITEMS} WHERE i.id = ?`, [r.insertId]);
  const calendario = await sincronizarTarea(row, { fechaTexto: a.fecha_limite, agendar: a.agendar, importante: a.importante });
  return {
    ok: true,
    item: itemPublico(row),
    proyecto_nuevo: proyecto && proyecto.nuevo ? proyecto.nombre : undefined,
    ...(calendario ? { calendario } : {}),
  };
}

async function actualizarItem(a) {
  const [actual] = await q('SELECT * FROM items WHERE id = ?', [a.id]);
  if (!actual) throw new Error(`No existe el item ${a.id}`);
  const sets = [];
  const params = [];
  if (a.estado !== undefined) {
    if (!ESTADOS.includes(a.estado)) throw new Error(`estado debe ser: ${ESTADOS.join(', ')}`);
    sets.push('estado = ?'); params.push(a.estado);
  }
  if (a.texto !== undefined) { sets.push('texto = ?'); params.push(a.texto); }
  if (a.razon !== undefined) { sets.push('razon = ?'); params.push(a.razon); }
  if (a.persona !== undefined) { sets.push('persona = ?'); params.push(a.persona); }
  if (a.fecha_limite !== undefined) { sets.push('fecha_limite = ?'); params.push(F.parse(a.fecha_limite)); }
  if (a.tipo !== undefined) {
    if (!TIPOS.includes(a.tipo)) throw new Error(`tipo debe ser uno de: ${TIPOS.join(', ')}`);
    sets.push('tipo = ?'); params.push(a.tipo);
  }
  if (a.proyecto !== undefined) {
    const p = await resolverProyecto(a.proyecto);
    sets.push('proyecto_id = ?'); params.push(p ? p.id : null);
  }
  if (!sets.length && a.importante === undefined && a.agendar === undefined) throw new Error('No indicaste nada que cambiar');
  if (a.importante !== undefined) { sets.push('importante = ?'); params.push(a.importante ? 1 : 0); }
  sets.push('actualizado_en = ?'); params.push(new Date());
  params.push(a.id);
  await q(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, params);
  const [row] = await q(`${SELECT_ITEMS} WHERE i.id = ?`, [a.id]);
  const calendario = await actualizarEnCalendario(row, a);
  return { ok: true, item: itemPublico(row), ...(calendario ? { calendario } : {}) };
}

// Mantiene el evento del calendario al día con el item.
async function actualizarEnCalendario(row, a) {
  if (!row.evento_id) {
    if (a.fecha_limite !== undefined || a.agendar === true) return sincronizarTarea(row, { fechaTexto: a.fecha_limite, agendar: a.agendar, importante: a.importante });
    return null;
  }
  try {
    if (row.estado === 'descartado' || a.agendar === false) {
      await G().actualizarTarea(row.evento_id, { borrar: true });
      await q('UPDATE items SET evento_id = NULL WHERE id = ?', [row.id]);
      return { quitado_del_calendario: true };
    }
    const fecha = new Date(row.fecha_limite || Date.now());
    const cambioFecha = a.fecha_limite !== undefined && row.fecha_limite;
    const inicio = cambioFecha ? G().momentoTarea(fecha, conHora(a.fecha_limite)).inicio : null;
    await G().actualizarTarea(row.evento_id, {
      texto: row.texto, persona: row.persona, proyecto: row.proyecto, importante: !!row.importante,
      hecho: row.estado === 'hecho', ...(inicio ? { inicio } : {}),
    });
    return row.estado === 'hecho' ? { marcado_hecho_en_calendario: true } : { calendario_actualizado: true, ...(inicio ? { aviso: F.fmt(inicio) } : {}) };
  } catch (e) {
    return { calendario_error: e.message };
  }
}

async function listarItems(a = {}) {
  const where = [];
  const params = [];
  if (a.tipo) { where.push('i.tipo = ?'); params.push(a.tipo); }
  if (a.estado) { where.push('i.estado = ?'); params.push(a.estado); }
  if (a.proyecto) {
    const p = await resolverProyecto(a.proyecto, { crear: false });
    if (!p) return { items: [], nota: `No hay un proyecto llamado "${a.proyecto}"` };
    where.push('i.proyecto_id = ?'); params.push(p.id);
  }
  if (a.persona) { where.push('i.persona LIKE ?'); params.push(`%${a.persona}%`); }
  if (a.texto) { where.push('(i.texto LIKE ? OR i.razon LIKE ?)'); params.push(`%${a.texto}%`, `%${a.texto}%`); }
  if (a.desde) { where.push('i.creado_en >= ?'); params.push(F.parse(a.desde.length <= 10 ? `${a.desde} 00:00` : a.desde)); }
  if (a.hasta) { where.push('i.creado_en <= ?'); params.push(F.parse(a.hasta)); }
  if (a.vence_antes_de) { where.push('i.fecha_limite IS NOT NULL AND i.fecha_limite <= ?'); params.push(F.parse(a.vence_antes_de)); }
  const limite = Math.min(Math.max(parseInt(a.limite, 10) || 30, 1), 100);
  const orden = a.vence_antes_de ? 'i.fecha_limite ASC' : 'i.creado_en DESC';
  const rows = await q(
    `${SELECT_ITEMS} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orden} LIMIT ${limite}`,
    params
  );
  return { total: rows.length, items: rows.map(itemPublico) };
}

// ---------- Foco ----------

async function focoActual() {
  const rows = await q(
    `SELECT f.*, p.nombre AS proyecto FROM foco f LEFT JOIN proyectos p ON p.id = f.proyecto_id
     WHERE f.fin IS NULL ORDER BY f.inicio DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function cerrarFoco() {
  const f = await focoActual();
  if (!f) return { ok: true, nota: 'No había un foco abierto' };
  const fin = new Date();
  await q('UPDATE foco SET fin = ? WHERE fin IS NULL', [fin]);
  return { ok: true, cerrado: { proyecto: f.proyecto, descripcion: f.descripcion, minutos: F.minutosEntre(f.inicio, fin) } };
}

async function iniciarFoco(a) {
  const anterior = await cerrarFoco();
  const p = await resolverProyecto(a.proyecto);
  const ahora = new Date();
  await q('INSERT INTO foco (proyecto_id, descripcion, inicio) VALUES (?, ?, ?)',
    [p ? p.id : null, a.descripcion || null, ahora]);
  // Para que ADA pueda cuestionar en el momento de cambiar de foco.
  const urgentes = await compromisosProximos(48);
  const enOtroProyecto = urgentes.filter((c) => !p || c.proyecto !== p.nombre);
  return {
    ok: true,
    foco: { proyecto: p ? p.nombre : null, descripcion: a.descripcion || null, inicio: F.fmt(ahora) },
    foco_anterior: anterior.cerrado,
    compromisos_urgentes_en_otros_proyectos: enOtroProyecto,
    alertas_hoy: await alertasHoy(),
  };
}

// ---------- Alertas ----------

async function alertasHoy() {
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM alertas WHERE creado_en >= ?', [F.inicioDelDia()]);
  return n;
}

async function registrarAlerta(a) {
  const n = await alertasHoy();
  const max = parseInt(process.env.ADA_MAX_ALERTAS || '2', 10);
  if (n >= max) return { ok: false, motivo: `Ya hiciste ${n} advertencias hoy (máximo ${max}). No insistas.` };
  await q('INSERT INTO alertas (item_id, mensaje, creado_en) VALUES (?, ?, ?)', [a.item_id || null, a.mensaje, new Date()]);
  return { ok: true, alertas_hoy: n + 1 };
}

// ---------- Compromisos próximos ----------

async function compromisosProximos(horas = 48) {
  const limite = new Date(Date.now() + horas * 3600 * 1000);
  const rows = await q(
    `${SELECT_ITEMS} WHERE i.estado = 'abierto' AND i.tipo IN ('compromiso','pendiente')
     AND i.fecha_limite IS NOT NULL AND i.fecha_limite <= ? ORDER BY i.fecha_limite ASC LIMIT 15`,
    [limite]
  );
  const ahora = new Date();
  return rows.map((r) => ({ ...itemPublico(r), vencido: new Date(r.fecha_limite) < ahora }));
}

// ---------- Informe ----------

async function datosInforme(a = {}) {
  const desde = a.desde ? F.parse(a.desde.length <= 10 ? `${a.desde} 00:00` : a.desde) : F.inicioDeSemana();
  const hasta = a.hasta ? F.parse(a.hasta) : new Date();
  const enRango = `${SELECT_ITEMS} WHERE i.creado_en BETWEEN ? AND ?`;
  const [decisiones, avances, ideas, completados, abiertos, focoRows] = await Promise.all([
    q(`${enRango} AND i.tipo = 'decision' ORDER BY i.creado_en`, [desde, hasta]),
    q(`${enRango} AND i.tipo = 'avance' ORDER BY i.creado_en`, [desde, hasta]),
    q(`${enRango} AND i.tipo = 'idea' ORDER BY i.creado_en`, [desde, hasta]),
    q(`${SELECT_ITEMS} WHERE i.tipo IN ('pendiente','compromiso') AND i.estado = 'hecho'
       AND i.actualizado_en BETWEEN ? AND ? ORDER BY i.actualizado_en`, [desde, hasta]),
    q(`${SELECT_ITEMS} WHERE i.tipo IN ('pendiente','compromiso') AND i.estado = 'abierto'
       ORDER BY i.fecha_limite IS NULL, i.fecha_limite ASC, i.creado_en ASC LIMIT 60`),
    q(`SELECT p.nombre AS proyecto, f.inicio, f.fin FROM foco f LEFT JOIN proyectos p ON p.id = f.proyecto_id
       WHERE f.inicio BETWEEN ? AND ?`, [desde, hasta]),
  ]);
  const minutosPorProyecto = {};
  for (const f of focoRows) {
    const fin = f.fin ? new Date(f.fin) : new Date();
    const k = f.proyecto || 'Sin proyecto';
    minutosPorProyecto[k] = (minutosPorProyecto[k] || 0) + F.minutosEntre(f.inicio, fin);
  }
  const [{ n: alertas }] = await q('SELECT COUNT(*) AS n FROM alertas WHERE creado_en BETWEEN ? AND ?', [desde, hasta]);
  const encargos = await q(
    `SELECT e.id, e.titulo, e.estado, e.resultado, e.siguiente_paso, c.nombre AS contacto,
       (SELECT COUNT(*) FROM acciones a WHERE a.encargo_id = e.id AND a.estado = 'ejecutada') AS mensajes_enviados
     FROM encargos e LEFT JOIN contactos c ON c.id = e.contacto_id
     WHERE e.creado_en BETWEEN ? AND ? OR e.actualizado_en BETWEEN ? AND ? ORDER BY e.id`,
    [desde, hasta, desde, hasta]
  ).catch(() => []);
  return {
    periodo: { desde: F.fmt(desde), hasta: F.fmt(hasta) },
    decisiones: decisiones.map(itemPublico),
    avances: avances.map(itemPublico),
    pendientes_y_compromisos_cerrados: completados.map(itemPublico),
    pendientes_y_compromisos_abiertos: abiertos.map(itemPublico),
    ideas_nuevas: ideas.map(itemPublico),
    tiempo_de_foco_minutos_por_proyecto: minutosPorProyecto,
    advertencias_hechas: alertas,
    encargos_delegados: encargos,
  };
}

// ---------- Definiciones para Claude ----------

const DEFINICIONES = [
  {
    name: 'registrar_item',
    description: 'Registra una nota clasificada: decision (algo que Cristian decidió, con su razón), avance (algo que se logró), pendiente (algo por hacer), compromiso (algo prometido a alguien, con persona y fecha) o idea. Úsala cada vez que Cristian cuente algo que encaje en estas categorías. Un mensaje puede generar varios items.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: TIPOS },
        texto: { type: 'string', description: 'Redacción breve y clara, en tercera persona o infinitivo. Ej: "Enviar informe de planos a la SEREMI".' },
        proyecto: { type: 'string', description: 'Nombre del proyecto. Usa uno existente si corresponde; si no existe, se crea.' },
        razon: { type: 'string', description: 'Para decisiones: por qué se decidió y qué alternativas se descartaron.' },
        persona: { type: 'string', description: 'Con quién es el compromiso o a quién involucra.' },
        fecha_limite: { type: 'string', description: 'YYYY-MM-DD o YYYY-MM-DD HH:MM. Resuelve "mañana", "el viernes", etc. con la fecha actual del contexto. Pon la hora solo si Cristian la dijo.' },
        importante: { type: 'boolean', description: 'Trámites, plazos con consecuencias, pagos, reuniones con otras personas o si él dice que es importante: además del aviso al celular, llega un correo de recordatorio.' },
        agendar: { type: 'boolean', description: 'Por defecto los pendientes y compromisos con fecha se agendan solos en Google Calendar. Usa false solo si Cristian pide no agendarlo.' },
      },
      required: ['tipo', 'texto'],
    },
  },
  {
    name: 'actualizar_item',
    description: 'Modifica un item existente: marcarlo hecho o descartado, cambiar fecha, texto, proyecto, persona o tipo. Si estaba agendado, el calendario se actualiza solo (hecho queda con ✔, descartado se quita, nueva fecha mueve el aviso). Busca primero el id con listar_items si no lo tienes.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        estado: { type: 'string', enum: ESTADOS },
        texto: { type: 'string' },
        razon: { type: 'string' },
        persona: { type: 'string' },
        fecha_limite: { type: 'string' },
        proyecto: { type: 'string' },
        tipo: { type: 'string', enum: TIPOS },
        importante: { type: 'boolean' },
        agendar: { type: 'boolean', description: 'true para publicarlo en el calendario si no estaba; false para sacarlo del calendario' },
      },
      required: ['id'],
    },
  },
  {
    name: 'listar_items',
    description: 'Busca items registrados con filtros. Sirve para responder "¿qué me falta?", "¿qué le prometí a X?", "¿qué decidí sobre Y?". Nunca inventes items: si no aparece, dilo.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: TIPOS },
        estado: { type: 'string', enum: ESTADOS },
        proyecto: { type: 'string' },
        persona: { type: 'string' },
        texto: { type: 'string', description: 'Búsqueda por palabra en texto o razón' },
        desde: { type: 'string', description: 'Fecha de creación desde (YYYY-MM-DD)' },
        hasta: { type: 'string', description: 'Fecha de creación hasta' },
        vence_antes_de: { type: 'string', description: 'Solo items con fecha límite hasta esta fecha, ordenados por vencimiento' },
        limite: { type: 'integer' },
      },
    },
  },
  {
    name: 'iniciar_foco',
    description: 'Registra en qué está trabajando Cristian ahora (cierra el foco anterior). Úsala cuando diga "estoy con X", "me pongo con Y", "voy a trabajar en Z". Devuelve los compromisos urgentes de otros proyectos para que puedas cuestionar si corresponde.',
    input_schema: {
      type: 'object',
      properties: {
        proyecto: { type: 'string' },
        descripcion: { type: 'string', description: 'Qué está haciendo concretamente' },
      },
      required: ['proyecto'],
    },
  },
  {
    name: 'cerrar_foco',
    description: 'Cierra el foco actual cuando Cristian termina, se toma un descanso o cierra el día.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'registrar_alerta',
    description: 'Registra que le hiciste una advertencia o cuestionamiento a Cristian sobre sus prioridades. Llámala SIEMPRE que lo cuestiones, antes de responder. Si devuelve ok:false, no hagas la advertencia.',
    input_schema: {
      type: 'object',
      properties: {
        mensaje: { type: 'string', description: 'Resumen de la advertencia' },
        item_id: { type: 'integer', description: 'Compromiso o pendiente que motiva la advertencia' },
      },
      required: ['mensaje'],
    },
  },
  {
    name: 'datos_informe',
    description: 'Obtiene los datos para la revisión del período: decisiones, avances, pendientes cerrados y abiertos, ideas, tiempo de foco por proyecto y advertencias. Por defecto, desde el lunes de esta semana hasta ahora.',
    input_schema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'YYYY-MM-DD' },
        hasta: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
  },
];

DEFINICIONES.push(
  {
    name: 'guardar_proyecto',
    description: 'Memoria de proyectos. Crea o actualiza un proyecto: qué es (descripcion), su estado, o agrega un dato clave (socio, cliente, precio, plazo, contexto). Úsala cuando Cristian explique de qué se trata un proyecto o cuente un hecho duradero sobre él. Los datos se acumulan.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        descripcion: { type: 'string', description: 'Qué es el proyecto, en 1–3 frases. Reemplaza la anterior: integra lo que ya había.' },
        dato: { type: 'string', description: 'Un hecho clave para recordar' },
        estado: { type: 'string', enum: ['activo', 'pausado', 'cerrado'] },
        nuevo_nombre: { type: 'string', description: 'Para renombrar' },
      },
      required: ['nombre'],
    },
  },
  {
    name: 'ver_proyecto',
    description: 'Todo lo que se sabe de un proyecto: descripción, datos clave, pendientes abiertos, decisiones y avances recientes, encargos activos. Úsala cuando Cristian pregunte por un proyecto ("¿sabes lo de X?", "¿cómo va Y?").',
    input_schema: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] },
  }
);

const IMPLEMENTACIONES = {
  guardar_proyecto: guardarProyecto,
  ver_proyecto: verProyecto,
  registrar_item: registrarItem,
  actualizar_item: actualizarItem,
  listar_items: listarItems,
  iniciar_foco: iniciarFoco,
  cerrar_foco: cerrarFoco,
  registrar_alerta: registrarAlerta,
  datos_informe: datosInforme,
};

// Permite que otros módulos (encargos, calendario…) agreguen herramientas.
function registrar(definiciones, implementaciones) {
  DEFINICIONES.push(...definiciones);
  Object.assign(IMPLEMENTACIONES, implementaciones);
}

async function ejecutar(nombre, input, ctx = {}) {
  const fn = IMPLEMENTACIONES[nombre];
  if (!fn) return { error: `Herramienta desconocida: ${nombre}` };
  try {
    return await fn(input || {}, ctx);
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  preferencias, guardarPreferencias,
  DEFINICIONES,
  ejecutar,
  registrar,
  resolverProyecto,
  focoActual,
  compromisosProximos,
  alertasHoy,
  listarProyectos,
};
