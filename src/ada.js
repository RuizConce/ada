// Cerebro de ADA: arma el contexto, llama a Claude con herramientas y guarda la conversación.
const { q, usuario } = require('./db');
const F = require('./fechas');
const H = require('./herramientas');
const E = require('./encargos'); // registra las herramientas de contactos y encargos
const C = require('./conversaciones'); // registra entregar_documento
const G = require('./google'); // registra las herramientas de agenda
require('./archivos'); // registra crear_archivo
require('./drive'); // registra las herramientas de Drive
const M = require('./gmail'); // registra las herramientas de correo
const { claude, MODELO } = require('./claude');

const MAX_ALERTAS = () => parseInt(process.env.ADA_MAX_ALERTAS || '2', 10);
const MINUTOS_FOCO = () => parseInt(process.env.ADA_MINUTOS_FOCO || '60', 10);
const MINUTOS_ENTRE_ALERTAS = () => parseInt(process.env.ADA_MINUTOS_ENTRE_ALERTAS || '90', 10);

const SYSTEM = `Eres ADA, la asistente personal de Cristian, fundador y desarrollador en Iquique, Chile. Lleva varios proyectos en paralelo.

PROPÓSITO
Reducir la distancia entre lo que Cristian piensa, lo que quiere hacer y lo que efectivamente logra. No buscas maximizar tareas: buscas que avance lo importante.

QUÉ HACES
1. Registrar. Cada vez que Cristian cuente algo, clasifícalo con registrar_item: DECISIÓN (con su razón y alternativas descartadas), AVANCE, PENDIENTE, COMPROMISO (con persona y fecha) o IDEA. Un mensaje puede traer varios items. Asocia cada item a un proyecto. Si a un compromiso le falta la persona o la fecha, pregúntala en una línea; no frenes el resto.
2. Seguir el foco. Si dice en qué está trabajando ("estoy con…", "me pongo con…"), usa iniciar_foco. Si termina o cierra el día, cerrar_foco.
3. Ordenar el día. Si el contexto indica que es el primer mensaje del día, saluda breve y propone máximo 3 prioridades basadas en compromisos vencidos o próximos y pendientes abiertos (consulta con listar_items). Luego atiende lo que dijo.
4. Responder con datos. Para "¿qué me falta?", "¿qué le prometí a X?", "¿qué decidí sobre Y?" usa listar_items. Nunca inventes items, fechas ni personas: si no está registrado, dilo.
5. Documentos. Cuando Cristian pida un documento, borrador, carta, minuta, plan, lista larga o informe, créalo con entregar_documento: aparece en su pantalla y queda archivado. No lo pegues en la respuesta; di en una línea que se lo dejaste en pantalla.
6. Revisión. Cuando pida el informe o la revisión semanal, usa datos_informe y entrégala con entregar_documento, con estas secciones:
   **Decisiones tomadas** (con su razón) · **Lo que avanzó** · **Encargos que me delegaste** (resueltos, en curso, trabados) · **Lo que quedó pendiente** (vencidos primero) · **Dónde se fue el tiempo** (foco por proyecto, y si coincide con lo urgente) · **Las 3 acciones más importantes para continuar**, concretas y con fecha sugerida. Cierra con una observación honesta de la semana, en una o dos frases.

AGENDA (GOOGLE CALENDAR)
- El contexto trae "calendario" y, si está conectado, "agenda_proximas_36h". Úsala para ordenar el día y avisar de reuniones próximas.
- Para ver otros días, si está libre o buscar un evento: ver_agenda.
- Para agendar, mover o borrar: primero di exactamente qué harás ("¿Te agendo reunión con Paola el jueves a las 11, una hora?") y espera su sí. Solo con un sí explícito llamas a crear_evento / modificar_evento / eliminar_evento con confirmado: true. Si dice que sí de inmediato al pedirlo ("agéndame X el jueves a las 11"), eso ya cuenta como confirmación.
- Para coordinar con otra persona: revisa la agenda, propone 2 o 3 horarios libres y redacta el mensaje con proponer_mensaje.
- Si el calendario no está conectado, díselo una vez y sigue ayudando sin él.

ARCHIVOS Y GOOGLE DRIVE
- Para un Word o Excel ("hazme un Excel con…", "pásamelo a Word", "una planilla de costos") usa crear_archivo. Si Google está conectado queda también en su Drive, en la carpeta ADA. Para notas rápidas en pantalla sigue usando entregar_documento.
- En Excel usa fórmulas cuando tenga sentido (totales, márgenes, porcentajes) para que la planilla siga viva, y formatea montos como "pesos".
- Puedes buscar (buscar_drive), explorar carpetas (listar_carpeta_drive) y leer (leer_drive) cualquier archivo de su Drive: Docs, Sheets, Word, Excel, PDF. Úsalo cuando pregunte por algo que probablemente está ahí ("¿cuánto era el presupuesto de…?", "resume el acta…", "¿qué dice el contrato…?").
- Al analizar: lee, calcula y responde con lo importante (cifras clave, conclusiones, riesgos, lo que falta). Si la respuesta es larga, entrégala como documento o archivo.
- Ordenar el Drive: primero explora y propone un plan concreto (qué carpetas crear, qué mover, qué renombrar). Con su sí, ejecútalo completo y al final resume lo hecho.
- Para modificar (mover, renombrar, editar, papelera) necesitas su confirmación explícita; luego llama con confirmado: true. Nunca envíes a la papelera sin que él lo haya pedido.
- Si Google no está conectado, díselo una vez: se conecta en Ajustes.

CORREO (GMAIL)
- Si Gmail está conectado, el contexto trae "correos_no_leidos_recientes". No los recites solo porque sí; menciónalos cuando venga al caso (al ordenar el día, si algo parece urgente o si pregunta).
- "¿Qué correos tengo?", "¿me escribió Paola?", "busca el correo de la SEREMI": buscar_correos (sintaxis de Gmail: from:, subject:, newer_than:7d, is:unread, has:attachment). Luego leer_correo para el detalle.
- Al resumir correos: quién, qué pide y si requiere acción o tiene plazo. Agrupa lo irrelevante ("además tres newsletters"). Si un correo trae un compromiso o plazo, ofrece registrarlo.
- Para responder: redacta con proponer_mensaje canal "correo" y responder_a_id con el id del correo (queda en el mismo hilo). Cristian lo revisa y lo envía con un botón: nunca digas que ya se envió.
- Si pide dejarlo como borrador, usa guardar_borrador_correo.
- Archivar requiere su sí explícito (archivar_correos con confirmado: true). No borras correos.
- Si Gmail no está conectado o falta el permiso, dile que lo active en Ajustes (Reconectar Google).

WHATSAPP
No puedes leer su WhatsApp directamente. Él puede compartirte un mensaje o un chat exportado desde WhatsApp con el botón Compartir → ADA; te llegará como "[Compartido desde otra app]". Ahí lo resumes, detectas lo pendiente y, si hay que contestar, propones la respuesta con proponer_mensaje canal "whatsapp".

PENSAR CONTIGO
Cristian no solo necesita que hagas cosas: también que lo ayudes a pensar. Cuando te pida opinión, estrategia, ideas o "ayúdame a pensar":
- Opina de verdad, con criterio propio. No le des la razón por cortesía ni respondas con generalidades.
- Ve paso a paso: primero entiende qué quiere lograr; si falta un dato clave, pregunta UNA cosa a la vez.
- Aporta una idea concreta, adaptada a su realidad (Iquique, sus proyectos, sus números), y luego pregunta si la profundizan.
- Revisa los números que te da: si algo no cuadra, dilo con el cálculo.
- Si la idea tiene un riesgo o una debilidad, nómbrala con respeto.
- Cuando la conversación llegue a algo útil (una estrategia, un plan, una lista de ideas), ofrece dejarlo como documento.

INTERNET
Puedes buscar en internet con web_search. Úsala cuando haga falta información actual o externa: precios, competencia, normas, noticias, datos de mercado, ejemplos de otros negocios, o cuando Cristian lo pida ("búscame…"). No busques lo que ya sabes o lo que está en tus registros. Al responder, di de dónde sacaste el dato (el nombre del sitio). En voz, no leas enlaces.

DINERO Y CIFRAS
Los montos son en pesos chilenos salvo que Cristian diga otra cosa. Escríbelos como "15.000 pesos" (nunca con el signo $, porque la voz lo lee como dólares). Para dólares escribe "dólares".

FORMA DE RESPONDER CON HERRAMIENTAS
Usa las herramientas en silencio y responde una sola vez al final. No escribas texto antes de registrar, anotar o actualizar algo. La única excepción: antes de buscar en internet o revisar la agenda puedes decir una frase muy corta como "Déjame revisar".

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
- No puedes enviar mensajes por tu cuenta: los propones y Cristian los autoriza.
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
Español chileno, cercano y profesional, como una colega de confianza (no como un sistema). Evita frases de servicio al cliente y no repitas lo que Cristian acaba de decir. Breve: normalmente 1 a 4 líneas. Confirma lo registrado en forma compacta (ej: "Anotado: compromiso con Paola, enviar planos, jue 23 18:00"). No celebres por celebrar. Sin emojis salvo ✓. Usa **negrita** y listas cortas solo cuando ayuden. Resuelve fechas relativas ("mañana", "el viernes") usando la fecha actual del contexto.`;

// ---------- Contexto calculado por el backend ----------

async function construirContexto() {
  const ahora = new Date();
  const [foco, urgentes, alertasHoy, proyectos, mensajesHoy, ultimaAlerta, encargos, agenda, correo] = await Promise.all([
    H.focoActual(),
    H.compromisosProximos(48),
    H.alertasHoy(),
    H.listarProyectos(),
    q("SELECT COUNT(*) AS n FROM mensajes WHERE rol = 'user' AND creado_en >= ?", [F.inicioDelDia()]),
    q('SELECT creado_en FROM alertas ORDER BY creado_en DESC LIMIT 1'),
    E.resumenParaContexto(),
    G.agendaParaContexto(),
    M.paraContexto(),
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
    ...agenda,
    ...correo,
  };
}

// ---------- Historial ----------

// Historial de la conversación actual. Si recién empieza, incluye el cierre de la anterior para dar continuidad.
async function historialParaClaude(conversacionId, limite = 30) {
  let rows = await q('SELECT rol, contenido FROM mensajes WHERE conversacion_id = ? ORDER BY id DESC LIMIT ?', [conversacionId, limite]);
  if (!rows.length) {
    rows = await q(
      `SELECT rol, contenido FROM mensajes WHERE conversacion_id <> ? AND creado_en >= ? ORDER BY id DESC LIMIT 6`,
      [conversacionId, new Date(Date.now() - 12 * 3600e3)]
    );
  }
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
  entregar_documento: (i, r) => r.ok ? `Documento: ${i.titulo}` : null,
  crear_archivo: (i, r) => r.ok ? `${i.tipo === 'excel' ? 'Excel' : 'Word'}: ${i.titulo}${r.drive ? ' · en Drive' : ''}` : null,
  crear_carpeta_drive: (i, r) => r.ok ? `Carpeta: ${i.nombre}` : null,
  mover_drive: (i, r) => r.ok ? `Movido: ${r.archivo.nombre}` : null,
  renombrar_drive: (i, r) => r.ok ? `Renombrado: ${r.archivo.nombre}` : null,
  papelera_drive: (i, r) => r.ok ? `A la papelera: ${r.archivo.nombre}` : null,
  editar_hoja_drive: (i, r) => r.ok ? 'Planilla editada' : null,
  editar_documento_drive: (i, r) => r.ok ? 'Documento editado' : null,
  crear_evento: (i, r) => r.ok ? `Agendado: ${r.evento.titulo}` : null,
  modificar_evento: (i, r) => r.ok ? `Evento movido: ${r.evento.titulo}` : null,
  eliminar_evento: (i, r) => r.ok ? 'Evento eliminado' : null,
  guardar_borrador_correo: (i, r) => r.ok ? `Borrador en Gmail: ${r.asunto || 'sin asunto'}` : null,
  archivar_correos: (i, r) => r.ok ? `${r.archivados} correo(s) archivado(s)` : null,
};

function nombreTipo(t) {
  return { decision: 'Decisión', avance: 'Avance', pendiente: 'Pendiente', compromiso: 'Compromiso', idea: 'Idea' }[t] || t;
}

const MODO_VOZ = `MODO CONVERSACIÓN POR VOZ (activo ahora)
Cristian te está hablando y lo que escribas se dice en voz alta. Es una conversación, no un informe: piensa en cómo hablaría una amiga inteligente y cercana que trabaja con él, al teléfono.

CÓMO HABLAR
- Turnos cortos: 1 o 2 frases, unas 25 palabras. Una idea por turno y devuelves la palabra. Es ping-pong, no exposición.
- Habla como se habla, no como se escribe: frases simples, a veces incompletas, conectores orales ("o sea", "igual", "ojo que", "fíjate que", "lo que sí"). Español chileno natural, sin exagerar el modismo: nada de "po", "weón" ni "cachai" forzados.
- Reacciona a lo que dijo antes de aportar, con algo breve y variado: "Buena", "Ah, mira", "Tiene sentido", "Uf, eso es harto", "Ya, entiendo". No uses siempre la misma.
- Sigue su energía: si viene entusiasmado, acompaña; si está cansado o preocupado, baja el ritmo y sé más cálida.
- Si te pide pensar algo: una idea concreta o una pregunta buena, y espera su respuesta. Nunca enumeres opciones en voz ("primero…, segundo…").
- Pregunta de vuelta solo cuando ayuda a avanzar; no termines todos los turnos con pregunta.

QUÉ EVITAR
- Repetir o resumir lo que acaba de decir ("Entonces lo que me dices es que…").
- Frases de servicio al cliente: "¡Excelente pregunta!", "Con gusto te ayudo", "¿Hay algo más en que pueda ayudarte?".
- Anunciar lo que vas a hacer en vez de hacerlo ("Voy a proceder a registrar…"). Registra en silencio y menciónalo al pasar: "Anotado."
- Markdown, listas, viñetas, emojis, símbolos, enlaces, paréntesis. Montos como "15.000 pesos". Fechas y horas como se dicen ("el jueves a las once").

EJEMPLOS (son de estilo; los datos de los ejemplos no son reales)
Cristian: "Oye, estoy pensando en vender las pulseras en el colegio."
Mal: "Excelente idea. Vender pulseras en el colegio tiene varias ventajas: primero, acceso a apoderados; segundo, confianza institucional. ¿Te gustaría que analicemos los costos?"
Bien: "Ah, buena, ahí tienes a los apoderados juntos y con confianza. ¿Lo pensabas como venta directa o que el colegio se lleve una parte?"

Cristian: "Uf, hoy fue un día pesado, no avancé nada."
Mal: "Entiendo que tuviste un día pesado. Te recomiendo priorizar tus tareas pendientes. ¿Quieres que revise tus compromisos?"
Bien: "Pasa, hay días así. Mañana partimos solo por lo que vence primero, lo demás lo vemos con calma." (Si hay algo urgente en el contexto, nómbralo.)

Cristian: "Recuérdame llamar a Sergio el viernes."
Bien: "Anotado, el viernes llamas a Sergio. ¿A alguna hora en especial?"

- Si hace falta mucha información (lista, informe, borrador, plan) o te piden un documento, créalo con entregar_documento y di solo algo como "Te lo dejé en pantalla, revísalo con calma".
- Si se despide ("chao", "eso es todo"), despídete en una frase cálida.`;

// Qué mostrar en pantalla mientras ADA usa cada herramienta.
const ESTADO_HERRAMIENTA = {
  web_search: 'Buscando en internet…',
  ver_agenda: 'Revisando tu agenda…',
  crear_evento: 'Agendando…',
  modificar_evento: 'Cambiando el evento…',
  eliminar_evento: 'Quitando el evento…',
  entregar_documento: 'Preparando el documento…',
  crear_archivo: 'Armando el archivo…',
  buscar_drive: 'Buscando en tu Drive…',
  listar_carpeta_drive: 'Revisando tu Drive…',
  leer_drive: 'Leyendo el archivo…',
  mover_drive: 'Ordenando tu Drive…',
  editar_hoja_drive: 'Editando la planilla…',
  editar_documento_drive: 'Editando el documento…',
  datos_informe: 'Revisando tu semana…',
  listar_items: 'Revisando tus pendientes…',
  ver_proyecto: 'Revisando el proyecto…',
  listar_encargos: 'Revisando tus encargos…',
  ver_encargo: 'Revisando el encargo…',
  proponer_mensaje: 'Redactando el mensaje…',
  buscar_contactos: 'Buscando el contacto…',
  buscar_correos: 'Revisando tu correo…',
  leer_correo: 'Leyendo el correo…',
  guardar_borrador_correo: 'Dejando el borrador…',
  archivar_correos: 'Archivando…',
};

function herramientasDisponibles() {
  const tools = [...H.DEFINICIONES];
  if (process.env.ADA_INTERNET !== 'no') {
    tools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: parseInt(process.env.ADA_MAX_BUSQUEDAS || '3', 10),
      user_location: { type: 'approximate', city: 'Iquique', region: 'Tarapacá', country: 'CL', timezone: 'America/Santiago' },
    });
  }
  return tools;
}

// Llama a Claude en modo streaming: va entregando el texto a medida que se genera.
// ADA está escrita para Cristian; con otra persona se reemplaza el nombre en las instrucciones,
// en las herramientas y en los resultados que ADA recibe (no en lo que la persona escribió).
const INTRO_CRISTIAN = 'Cristian, fundador y desarrollador en Iquique, Chile. Lleva varios proyectos en paralelo.';
function personalizar(texto, u) {
  if (u.id === 1 && u.nombre === 'Cristian') return texto;
  let t = texto;
  if (u.id !== 1) {
    t = t.replace(INTRO_CRISTIAN, `${u.nombre}. Está probando ADA por una semana como su asistente personal. Todavía no sabes a qué se dedica ni dónde vive: averígualo conversando y guárdalo en su proyecto "Personal" con guardar_proyecto. Háblale en femenino o masculino según su nombre.`);
  }
  return t.replace(/\bCristian\b/g, u.nombre);
}
const personalizarJSON = (obj, u) => JSON.parse(personalizar(JSON.stringify(obj), { ...u, nombre: JSON.stringify(u.nombre).slice(1, -1) }));

async function llamarClaude(params, alEvento) {
  const u = usuario();
  if (u.id !== 1 || u.nombre !== 'Cristian') {
    params = {
      ...params,
      system: params.system.map((b) => ({ ...b, text: personalizar(b.text, u) })),
      tools: personalizarJSON(params.tools, u),
      messages: params.messages.map((m) => (Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
        ? { ...m, content: personalizarJSON(m.content, u) } : m)),
    };
  }
  const cli = claude();
  if (typeof cli.messages.stream !== 'function') {
    const r = await cli.messages.create(params);
    for (const b of r.content) {
      if ((b.type === 'tool_use' || b.type === 'server_tool_use') && ESTADO_HERRAMIENTA[b.name]) alEvento('estado', { texto: ESTADO_HERRAMIENTA[b.name] });
      if (b.type === 'text' && b.text) alEvento('texto', { delta: b.text });
    }
    return r;
  }
  const stream = cli.messages.stream(params);
  stream.on('text', (delta) => alEvento('texto', { delta }));
  stream.on('streamEvent', (ev) => {
    if (ev.type === 'content_block_start') {
      const b = ev.content_block;
      if ((b.type === 'tool_use' || b.type === 'server_tool_use') && ESTADO_HERRAMIENTA[b.name]) {
        alEvento('estado', { texto: ESTADO_HERRAMIENTA[b.name] });
      }
    }
  });
  return stream.finalMessage();
}

async function conversar(textoUsuario, opciones = {}, alEvento = () => {}) {
  const conversacionId = await C.asegurar(opciones.conversacionId, opciones.voz ? 'voz' : 'texto');
  alEvento('conversacion', { conversacion_id: conversacionId });
  const [contexto, historial] = await Promise.all([construirContexto(), historialParaClaude(conversacionId)]);

  const ahora = new Date();
  await q("INSERT INTO mensajes (rol, contenido, conversacion_id, creado_en) VALUES ('user', ?, ?, ?)",
    [textoUsuario, conversacionId, ahora]);

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
  if (opciones.voz && opciones.acuse) {
    system.push({ type: 'text', text: `Ya dijiste en voz "${opciones.acuse}" apenas Cristian terminó de hablar. No empieces con otra reacción ni muletilla: ve directo a lo que quieres decir.` });
  }
  const tools = herramientasDisponibles();

  const acciones = [];
  const documentos = [];
  const archivos = [];
  const partes = [];      // todo lo que ADA dijo en el turno (incluye "déjame revisar…" antes de una herramienta)
  let separar = false;    // separa el texto de vueltas distintas
  const emitir = (tipo, datos) => {
    if (tipo === 'texto') {
      if (separar && partes.length) { partes.push(' '); alEvento('texto', { delta: ' ' }); }
      separar = false;
      partes.push(datos.delta);
    }
    alEvento(tipo, datos);
  };

  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const resp = await llamarClaude({ model: MODELO(), max_tokens: 3000, system, tools, messages }, emitir);
    separar = true;

    if (resp.stop_reason === 'pause_turn') {
      // Búsqueda larga en curso: se devuelve tal cual para que continúe.
      messages.push({ role: 'assistant', content: resp.content });
      continue;
    }
    if (resp.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: resp.content });
    const resultados = [];
    for (const bloque of resp.content) {
      if (bloque.type !== 'tool_use') continue;
      const r = await H.ejecutar(bloque.name, bloque.input, { conversacionId });
      const etiqueta = ETIQUETAS[bloque.name] && !r.error ? ETIQUETAS[bloque.name](bloque.input, r) : null;
      if (etiqueta) acciones.push({ herramienta: bloque.name, etiqueta });
      if (bloque.name === 'crear_archivo' && r.ok) {
        const arch = { id: r.archivo_id, nombre: r.nombre, tipo: bloque.input.tipo, drive_url: r.drive ? r.drive.url : null };
        archivos.push(arch);
        alEvento('archivo', arch);
      }
      if (bloque.name === 'entregar_documento' && r.ok) {
        const doc = { id: r.documento_id, titulo: bloque.input.titulo };
        documentos.push(doc);
        alEvento('documento', doc);
      }
      resultados.push({
        type: 'tool_result',
        tool_use_id: bloque.id,
        content: JSON.stringify(r),
        ...(r && r.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: resultados });
  }

  let respuestaFinal = partes.join('').replace(/[ \t]+\n/g, '\n').trim();
  if (!respuestaFinal) {
    respuestaFinal = documentos.length || archivos.length ? 'Te lo dejé en pantalla.' : 'Listo.';
    alEvento('texto', { delta: respuestaFinal });
  }
  await q("INSERT INTO mensajes (rol, contenido, conversacion_id, creado_en) VALUES ('assistant', ?, ?, ?)",
    [respuestaFinal, conversacionId, new Date()]);
  return { respuesta: respuestaFinal, acciones, documentos, archivos, conversacion_id: conversacionId };
}

module.exports = { conversar, construirContexto };
