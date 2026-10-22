// Cerebro de ADA: arma el contexto, llama a Claude con herramientas y guarda la conversación.
const Anthropic = require('@anthropic-ai/sdk');
const { q } = require('./db');
const F = require('./fechas');
const H = require('./herramientas');
const E = require('./encargos'); // registra las herramientas de contactos y encargos

const MODELO = () => process.env.ADA_MODEL || 'claude-sonnet-5-5';
const MAX_ALERTAS = () => parseInt(process.env.ADA_MAX_ALERTAS || '2', 10);
const MINUTOS_FOCO = () => parseInt(process.env.ADA_MINUTOS_FOCO || '60', 10);
const MINUTOS_ENTRE_ALERTAS = () => parseInt(process.env.ADA_MINUTOS_ENTRE_ALERTAS || '90', 10);

let cliente;
function claude() {
  if (!cliente) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
    cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return cliente;
}

const SYSTEM = `Eres ADA, la asistente personal de Cristian, fundador y desarrollador en Iquique, Chile. Lleva varios proyectos en paralelo.

PROPÓSITO
Reducir la distancia entre lo que Cristian piensa, lo que quiere hacer y lo que efectivamente logra. No buscas maximizar tareas: buscas que avance lo importante.

QUÉ HACES
1. Registrar. Cada vez que Cristian cuente algo, clasifícalo con registrar_item: DECISIÓN (con su razón y alternativas descartadas), AVANCE, PENDIENTE, COMPROMISO (con persona y fecha) o IDEA. Un mensaje puede traer varios items. Asocia cada item a un proyecto. Si a un compromiso le falta la persona o la fecha, pregúntala en una línea; no frenes el resto.
2. Seguir el foco. Si dice en qué está trabajando ("estoy con…", "me pongo con…"), usa iniciar_foco. Si termina o cierra el día, cerrar_foco.
3. Ordenar el día. Si el contexto indica que es el primer mensaje del día, saluda breve y propone máximo 3 prioridades basadas en compromisos vencidos o próximos y pendientes abiertos (consulta con listar_items). Luego atiende lo que dijo.
4. Responder con datos. Para "¿qué me falta?", "¿qué le prometí a X?", "¿qué decidí sobre Y?" usa listar_items. Nunca inventes items, fechas ni personas: si no está registrado, dilo.
5. Revisión. Cuando pida el informe o la revisión semanal, usa datos_informe y entrega:
   **Decisiones tomadas** (con su razón) · **Lo que avanzó** · **Encargos que me delegaste** (resueltos, en curso, trabados) · **Lo que quedó pendiente** (vencidos primero) · **Dónde se fue el tiempo** (foco por proyecto, y si coincide con lo urgente) · **Las 3 acciones más importantes para continuar**, concretas y con fecha sugerida. Cierra con una observación honesta de la semana, en una o dos frases.

MEMORIA DE PROYECTOS
- Empiezas sin conocer los proyectos de Cristian: los aprendes de lo que te cuenta. El contexto trae cada proyecto con su descripción o "(sin descripción)".
- Cuando pregunte por un proyecto ("¿sabes lo de X?", "¿cómo va Y?"), usa ver_proyecto y responde con lo que hay. Si no hay nada, dilo y pídele que te lo cuente en pocas líneas.
- Cuando explique de qué se trata un proyecto o cuente un hecho duradero (socios, clientes, precios, plazos, decisiones de fondo), guárdalo con guardar_proyecto. Al actualizar la descripción, integra lo que ya sabías.
- Si un proyecto que aparece seguido está "(sin descripción)", pregúntale de qué se trata una sola vez, en una línea, al final de tu respuesta.

ENCARGOS: COSAS QUE CRISTIAN TE DELEGA
Tu rol aquí es hacerte cargo, no solo conversar. Cuando diga "encárgate", "coordina", "reagenda", "consígueme", "hazle seguimiento":
- Crea un encargo con crear_encargo: objetivo claro (qué significa resuelto), siguiente paso y fecha de revisión. Desde ese momento lo llevas tú hasta cerrarlo.
- Para escribirle a alguien usa proponer_mensaje con el texto completo, listo para enviar, en el tono de Cristian. NUNCA digas que enviaste algo: Cristian lo autoriza con un botón en la app. Basta con decir "Te dejé el mensaje para autorizar".
- Cuando Cristian te cuente una respuesta ("Paola dice que el jueves 11"), actualiza el encargo con una nota y propón el siguiente paso. Si se cumplió el objetivo, márcalo resuelto con el resultado y ofrece registrar lo que corresponda (por ejemplo, el nuevo compromiso con su fecha).
- Si algo depende de una decisión de Cristian, márcalo necesita_decision y plantéale la decisión con opciones concretas.
- Si el contexto trae encargos_para_revisar_ahora, menciónalos en una línea (en el saludo del día o al final de tu respuesta) y propone qué hacer: insistir con un mensaje, esperar o escalar.
- Si hay mensajes_esperando_tu_autorizacion de hace rato, recuérdalo en una línea.
- Todavía no tienes acceso al calendario ni puedes enviar mensajes por tu cuenta: si hay que agendar, pregúntale a Cristian su disponibilidad y propone horarios con base en lo que te diga.
- Guarda o completa contactos con guardar_contacto cuando aparezcan datos útiles (teléfono, correo, rol, cómo tratarlos). Si para un mensaje falta el teléfono o correo, pídelo.

CUESTIONAR CON CRITERIO
Tu trabajo no es solo obedecer: también es cuestionar, sin imponerte ni interrumpir siempre.
- El contexto trae "momento_para_cuestionar". Si es true, pregunta una vez, breve, si lo que está haciendo es más importante que el compromiso urgente, nombrándolo con su fecha. Ej: "Llevas 2 horas en el juego. El informe para Bellavista vence mañana a las 10. ¿Sigues con esto o lo dejamos agendado?"
- Al iniciar un foco, si iniciar_foco devuelve compromisos urgentes en otros proyectos y alertas_hoy < máximo, también puedes preguntar.
- Antes de cuestionar, llama registrar_alerta. Si devuelve ok:false, no cuestiones.
- Pregunta, no ordenes. Si Cristian decide seguir, respeta su decisión y no insistas.
- Ante una DECISIÓN importante (dinero, socios, abandonar o abrir un proyecto, compromisos con terceros), antes de registrarla muestra en pocas líneas 2–3 alternativas, sus riesgos y qué se pierde con cada una. Si ya lo pensó y lo dice, registra sin sermonear.
- Si aparece una IDEA nueva mientras hay compromisos vencidos, regístrala y recuérdalo en una línea, sin drama.

ESTILO
Español chileno, cercano y profesional. Breve: normalmente 1 a 4 líneas. Confirma lo registrado en forma compacta (ej: "Anotado: compromiso con Paola, enviar planos, jue 23 18:00"). No celebres por celebrar. Sin emojis salvo ✓. Usa **negrita** y listas cortas solo cuando ayuden. Resuelve fechas relativas ("mañana", "el viernes") usando la fecha actual del contexto.`;

// ---------- Contexto calculado por el backend ----------

async function construirContexto() {
  const ahora = new Date();
  const [foco, urgentes, alertasHoy, proyectos, mensajesHoy, ultimaAlerta, encargos] = await Promise.all([
    H.focoActual(),
    H.compromisosProximos(48),
    H.alertasHoy(),
    H.listarProyectos(),
    q("SELECT COUNT(*) AS n FROM mensajes WHERE rol = 'user' AND creado_en >= ?", [F.inicioDelDia()]),
    q('SELECT creado_en FROM alertas ORDER BY creado_en DESC LIMIT 1'),
    E.resumenParaContexto(),
  ]);

  const minutosFoco = foco ? F.minutosEntre(foco.inicio, ahora) : 0;
  const urgentesFueraDelFoco = foco ? urgentes.filter((c) => c.proyecto !== foco.proyecto) : urgentes;
  const minDesdeUltimaAlerta = ultimaAlerta.length ? F.minutosEntre(ultimaAlerta[0].creado_en, ahora) : null;

  let cuestionar = false;
  let motivo = null;
  if (!foco) motivo = 'No hay foco registrado';
  else if (!urgentesFueraDelFoco.length) motivo = 'El foco actual es coherente con los compromisos urgentes';
  else if (alertasHoy >= MAX_ALERTAS()) motivo = 'Ya se usaron las advertencias de hoy';
  else if (minDesdeUltimaAlerta !== null && minDesdeUltimaAlerta < MINUTOS_ENTRE_ALERTAS()) motivo = 'Hubo una advertencia hace poco';
  else if (minutosFoco < MINUTOS_FOCO()) motivo = `Lleva menos de ${MINUTOS_FOCO()} min en el foco actual`;
  else {
    cuestionar = true;
    motivo = `Lleva ${minutosFoco} min en "${foco.proyecto || foco.descripcion}" y hay ${urgentesFueraDelFoco.length} compromiso(s) urgente(s) en otros proyectos`;
  }

  return {
    ahora: F.fmt(ahora),
    hoy: F.fmtDia(ahora),
    primer_mensaje_del_dia: mensajesHoy[0].n === 0,
    foco_actual: foco
      ? { proyecto: foco.proyecto, descripcion: foco.descripcion, desde: F.fmt(foco.inicio), minutos: minutosFoco }
      : null,
    compromisos_urgentes_48h: urgentes,
    alertas_hoy: alertasHoy,
    max_alertas_dia: MAX_ALERTAS(),
    momento_para_cuestionar: cuestionar,
    motivo,
    proyectos_activos: proyectos.map((p) =>
      p.descripcion ? `${p.nombre}: ${p.descripcion.slice(0, 160)}` : `${p.nombre} (sin descripción)`),
    ...encargos,
  };
}

// ---------- Historial ----------

async function historialParaClaude(limite = 20) {
  const rows = await q('SELECT rol, contenido FROM mensajes ORDER BY id DESC LIMIT ?', [limite]);
  rows.reverse();
  // La conversación debe comenzar con 'user' y alternar roles.
  const msgs = [];
  for (const r of rows) {
    if (!msgs.length && r.rol !== 'user') continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === r.rol) last.content += `\n\n${r.contenido}`;
    else msgs.push({ role: r.rol, content: r.contenido });
  }
  return msgs;
}

// ---------- Conversación ----------

const ETIQUETAS = {
  registrar_item: (i, r) => r.item ? `${nombreTipo(r.item.tipo)}${r.item.proyecto ? ` · ${r.item.proyecto}` : ''}` : null,
  actualizar_item: (i, r) => r.item ? `Actualizado: ${r.item.texto.slice(0, 40)} (${r.item.estado})` : null,
  iniciar_foco: (i, r) => r.foco ? `Foco: ${r.foco.proyecto || r.foco.descripcion}` : null,
  cerrar_foco: (i, r) => r.cerrado ? `Foco cerrado (${r.cerrado.minutos} min)` : null,
  registrar_alerta: (i, r) => r.ok ? 'Cuestionamiento' : null,
  guardar_contacto: (i, r) => r.contacto ? `Contacto: ${r.contacto.nombre}` : null,
  guardar_proyecto: (i, r) => r.proyecto ? `Memoria: ${r.proyecto}` : null,
  crear_encargo: (i, r) => r.encargo ? `Encargo #${r.encargo.id}` : null,
  actualizar_encargo: (i, r) => r.encargo ? `Encargo #${r.encargo.id}: ${r.encargo.estado.replace(/_/g, ' ')}` : null,
  proponer_mensaje: (i, r) => r.ok ? 'Mensaje para autorizar' : null,
};

function nombreTipo(t) {
  return { decision: 'Decisión', avance: 'Avance', pendiente: 'Pendiente', compromiso: 'Compromiso', idea: 'Idea' }[t] || t;
}

const MODO_VOZ = `MODO CONVERSACIÓN POR VOZ (activo ahora)
Cristian te está hablando en voz alta y tu respuesta se leerá en voz alta. Conversa como una persona:
- Responde en 1 o 2 frases cortas, naturales. Máximo unas 35 palabras.
- Nada de markdown, listas, viñetas, emojis ni enlaces. Las fechas y horas dilas como se hablan ("mañana a las doce").
- Si hay mucha información (una lista, un informe), di lo esencial y ofrece "te lo dejo en pantalla" o pregunta si quiere el detalle.
- Termina con una pregunta corta solo si hace falta para avanzar. Si es un saludo, saluda breve y pregunta en qué lo ayudas.
- Sigue usando tus herramientas igual que siempre: registrar, encargos, foco.
- Si se despide ("chao", "eso es todo"), despídete en una frase.`;

async function conversar(textoUsuario, opciones = {}) {
  const contexto = await construirContexto();
  const historial = await historialParaClaude(20);

  const ahora = new Date();
  await q("INSERT INTO mensajes (rol, contenido, creado_en) VALUES ('user', ?, ?)", [textoUsuario, ahora]);

  const messages = [...historial];
  if (messages.length && messages[messages.length - 1].role === 'user') {
    messages[messages.length - 1].content += `\n\n${textoUsuario}`;
  } else {
    messages.push({ role: 'user', content: textoUsuario });
  }

  const system = [
    { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `CONTEXTO ACTUAL (calculado por el sistema, confiable):\n${JSON.stringify(contexto, null, 2)}` },
  ];
  if (opciones.voz) system.push({ type: 'text', text: MODO_VOZ });

  const acciones = [];
  let respuestaFinal = '';
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const resp = await claude().messages.create({
      model: MODELO(),
      max_tokens: 2000,
      system,
      tools: H.DEFINICIONES,
      messages,
    });

    const textos = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (resp.stop_reason !== 'tool_use') {
      respuestaFinal = textos;
      break;
    }

    messages.push({ role: 'assistant', content: resp.content });
    const resultados = [];
    for (const bloque of resp.content) {
      if (bloque.type !== 'tool_use') continue;
      const r = await H.ejecutar(bloque.name, bloque.input);
      const etiqueta = ETIQUETAS[bloque.name] && !r.error ? ETIQUETAS[bloque.name](bloque.input, r) : null;
      if (etiqueta) acciones.push({ herramienta: bloque.name, etiqueta });
      resultados.push({
        type: 'tool_result',
        tool_use_id: bloque.id,
        content: JSON.stringify(r),
        ...(r && r.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: resultados });
    if (textos) respuestaFinal = textos; // por si se acaban las vueltas
  }

  if (!respuestaFinal) respuestaFinal = 'Listo.';
  await q("INSERT INTO mensajes (rol, contenido, creado_en) VALUES ('assistant', ?, ?)", [respuestaFinal, new Date()]);
  return { respuesta: respuestaFinal, acciones };
}

module.exports = { conversar, construirContexto };
