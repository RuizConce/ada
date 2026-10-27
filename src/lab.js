// Laboratorio de voz: prototipos para comparar con la conversación actual.
//  A) "Oído" en tiempo real: el micrófono llega por WebSocket y se transcribe en vivo con Deepgram
//     (con los nombres de contactos y proyectos como palabras clave). El cerebro sigue siendo ADA/Claude.
//  B) Voz a voz: OpenAI Realtime conversa directo con la persona por WebRTC y le delega a ADA
//     todo lo que requiere datos o acciones. Aquí solo se entrega un token temporal.
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { q, comoUsuario, prepararInvitado } = require('./db');
const U = require('./usuarios');
const F = require('./fechas');

const configurado = () => ({
  deepgram: !!process.env.DEEPGRAM_API_KEY,
  openai: !!process.env.OPENAI_API_KEY,
  modelo_realtime: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
  voz_realtime: process.env.OPENAI_REALTIME_VOZ || 'marin',
  voz_deepgram: process.env.DEEPGRAM_VOZ || 'aura-2-carina-es',
});

// ---------- Palabras clave (para que escuche bien nombres propios) ----------

async function palabrasClave(nombrePersona) {
  const [contactos, proyectos] = await Promise.all([
    q('SELECT nombre, alias FROM contactos ORDER BY actualizado_en DESC LIMIT 60'),
    q("SELECT nombre FROM proyectos WHERE estado = 'activo' ORDER BY id DESC LIMIT 30"),
  ]);
  const set = new Set();
  const agregar = (t) => {
    const limpio = String(t || '').replace(/[^\p{L}\p{N} +-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (limpio.length >= 3 && limpio.length <= 40 && !/^(mi|la|el) /i.test(limpio)) set.add(limpio);
  };
  agregar(nombrePersona);
  agregar('ADA');
  for (const p of proyectos) agregar(p.nombre);
  for (const c of contactos) {
    agregar(c.nombre);
    for (const a of String(c.alias || '').split('|')) agregar(a);
  }
  return [...set].slice(0, 60);
}

// ---------- A) Oído en tiempo real (proxy WebSocket → Deepgram) ----------

// Modo reunión: separa a quienes hablan (diarize), espera pausas más largas y, si se pide traducir,
// reconoce varios idiomas mezclados (language=multi).
function urlDeepgram(terminos, { reunion = false, multi = false } = {}) {
  const p = new URLSearchParams({
    model: process.env.DEEPGRAM_MODELO || 'nova-3',
    language: multi ? 'multi' : (process.env.DEEPGRAM_IDIOMA || 'es'),
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    endpointing: process.env.DEEPGRAM_ENDPOINTING || '400',
    utterance_end_ms: '1200',
    vad_events: 'true',
    smart_format: 'true',
    punctuate: 'true',
  });
  if (reunion) {
    p.set('diarize', 'true');
    p.set('endpointing', '700');
    p.set('utterance_end_ms', '1500');
  }
  for (const t of terminos) p.append('keyterm', t);
  return `${process.env.DEEPGRAM_URL || 'wss://api.deepgram.com'}/v1/listen?${p}`;
}

function conectarOido(server) {
  const wss = new WebSocketServer({ server, path: '/ws/oido', maxPayload: 1 << 20 });
  wss.on('connection', async (cliente, req) => {
    const enviar = (o) => { if (cliente.readyState === WebSocket.OPEN) cliente.send(JSON.stringify(o)); };
    let arriba = null;
    try {
      const params = new URL(req.url, 'http://x').searchParams;
      const token = params.get('token');
      const reunion = params.get('modo') === 'reunion';
      const multi = reunion && params.get('idioma') === 'multi';
      const u = await U.desdeToken(token);
      if (!u) { enviar({ type: 'Error', mensaje: 'No autorizado' }); return cliente.close(); }
      // El modo reunión es para todos; el laboratorio, solo para el administrador.
      if (!reunion && !u.admin && process.env.ADA_LAB_TODOS !== 'si') { enviar({ type: 'Error', mensaje: 'El laboratorio es solo para el administrador' }); return cliente.close(); }
      if (!process.env.DEEPGRAM_API_KEY) { enviar({ type: 'Error', mensaje: 'Falta DEEPGRAM_API_KEY en Railway' }); return cliente.close(); }
      if (u.id !== 1) await prepararInvitado(u.id);
      const terminos = await comoUsuario(u, () => palabrasClave(u.nombre));
      arriba = new WebSocket(urlDeepgram(terminos, { reunion, multi }), { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
      const pendiente = [];
      arriba.on('open', () => {
        enviar({ type: 'Listo', palabras_clave: terminos.length });
        for (const b of pendiente.splice(0)) arriba.send(b);
      });
      arriba.on('message', (datos, binario) => {
        if (binario) return;
        let m;
        try { m = JSON.parse(datos.toString()); } catch (_) { return; }
        if (m.type === 'Results') {
          const alt = (m.channel && m.channel.alternatives && m.channel.alternatives[0]) || {};
          const r = { type: 'Results', texto: alt.transcript || '', is_final: !!m.is_final, speech_final: !!m.speech_final };
          if (reunion) {
            // Quién habla: el hablante con más palabras en este tramo.
            const cuenta = {};
            for (const w of alt.words || []) if (Number.isInteger(w.speaker)) cuenta[w.speaker] = (cuenta[w.speaker] || 0) + 1;
            const top = Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0];
            r.hablante = top ? parseInt(top[0], 10) : null;
            r.idioma = (alt.languages && alt.languages[0]) || null;
            r.inicio = typeof m.start === 'number' ? m.start : null;
          }
          enviar(r);
        } else if (m.type === 'SpeechStarted' || m.type === 'UtteranceEnd') {
          enviar({ type: m.type });
        } else if (m.type === 'Error') {
          enviar({ type: 'Error', mensaje: m.description || m.message || 'Error de Deepgram' });
        }
      });
      arriba.on('unexpected-response', (_r, res) => {
        let cuerpo = '';
        res.on('data', (c) => { cuerpo += c; });
        res.on('end', () => { enviar({ type: 'Error', mensaje: `Deepgram respondió ${res.statusCode}: ${cuerpo.slice(0, 200)}` }); cliente.close(); });
      });
      arriba.on('error', (e) => { enviar({ type: 'Error', mensaje: `Deepgram: ${e.message}` }); });
      arriba.on('close', () => { if (cliente.readyState === WebSocket.OPEN) cliente.close(); });
      // Audio del teléfono → Deepgram (PCM 16 bits, 16 kHz, mono).
      cliente.on('message', (datos, binario) => {
        if (!binario) {
          const t = datos.toString();
          if (t === '{"type":"KeepAlive"}' && arriba.readyState === WebSocket.OPEN) arriba.send(t);
          return;
        }
        if (arriba.readyState === WebSocket.OPEN) arriba.send(datos);
        else if (arriba.readyState === WebSocket.CONNECTING && pendiente.length < 50) pendiente.push(datos);
      });
    } catch (e) {
      enviar({ type: 'Error', mensaje: e.message });
      cliente.close();
    }
    cliente.on('close', () => {
      if (arriba && arriba.readyState === WebSocket.OPEN) {
        try { arriba.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
        arriba.close();
      } else if (arriba) {
        try { arriba.terminate(); } catch (_) {}
      }
    });
  });
  return wss;
}

// ---------- B) Voz a voz (OpenAI Realtime): token temporal con la personalidad y el contexto de ADA ----------

function instruccionesRealtime(u, ctx) {
  const datos = {
    hoy: ctx.hoy,
    ahora: ctx.ahora,
    foco_actual: ctx.foco_actual,
    compromisos_urgentes: (ctx.compromisos_urgentes_48h || []).slice(0, 8),
    agenda_proximas_36h: ctx.agenda_proximas_36h,
    proyectos: ctx.proyectos_activos,
    encargos_activos: (ctx.encargos_activos || []).map((e) => `${e.titulo} (${e.estado})`).slice(0, 8),
    correos_no_leidos: ctx.correos_no_leidos_recientes,
    conversaciones_recientes: ctx.conversaciones_recientes,
  };
  return `Eres ADA, la asistente ejecutiva y colega de trabajo de ${u.nombre}. Hablas por voz, en español chileno natural (cercano, sin exagerar modismos), con criterio propio, curiosa y directa.

CÓMO CONVERSAS
- Es una conversación, no un informe: turnos cortos (una o dos frases), una idea a la vez, y devuelves la palabra. Más largo solo si están analizando algo.
- No todo es una orden: si piensa en voz alta o explora ideas, conversa, aporta un ángulo, cuestiona con respeto si algo no cuadra, y pregunta solo lo que hace avanzar.
- Nada de frases de servicio al cliente, ni repetir lo que dijo, ni listas de lo que sabes hacer.

TU SISTEMA (MUY IMPORTANTE)
- Para cualquier cosa que necesite datos reales o hacer algo —su agenda, correos, Drive, contactos, pendientes, encargos, registrar o recordar algo, agendar, redactar mensajes, buscar en internet, preparar documentos o informes— usa la herramienta "ada". Pásale el pedido completo y claro, en primera persona como lo diría ${u.nombre}. Ella lo hace y te devuelve el resultado.
- Antes de llamarla, di en pocas palabras que lo estás revisando ("Déjame ver tu agenda"). Si tarda, puedes decir que sigues en eso.
- Cuando vuelva el resultado, cuéntalo breve y natural. Si trae detalle o un documento, di que lo dejaste en pantalla. Nunca inventes datos, nombres ni correos: si no está en el resultado ni en el contexto, pregúntale o usa la herramienta.
- Los mensajes y correos nunca se envían solos: ${u.nombre} los autoriza con un botón en pantalla.
- Montos en pesos chilenos ("15.000 pesos").

CONTEXTO ACTUAL (real, del sistema)
${JSON.stringify(datos, null, 1)}`;
}

const HERRAMIENTA_ADA = {
  type: 'function',
  name: 'ada',
  description: 'Pide a ADA (el sistema con memoria, agenda, correo, Drive, contactos, internet y documentos) que haga o averigüe algo. Devuelve lo que respondió y lo que dejó en pantalla.',
  parameters: {
    type: 'object',
    properties: { pedido: { type: 'string', description: 'El pedido completo, claro, como lo diría la persona.' } },
    required: ['pedido'],
  },
};

async function tokenRealtime(u, construirContexto) {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('Falta OPENAI_API_KEY en Railway'), { status: 400 });
  const ctx = await construirContexto();
  const c = configurado();
  const sesion = {
    type: 'realtime',
    model: c.modelo_realtime,
    instructions: instruccionesRealtime(u, ctx),
    audio: {
      input: {
        transcription: { model: process.env.OPENAI_TRANSCRIPCION || 'gpt-4o-mini-transcribe', language: 'es' },
        turn_detection: { type: 'semantic_vad', eagerness: process.env.OPENAI_VAD_EAGERNESS || 'low' },
      },
      output: { voice: c.voz_realtime },
    },
    tools: [HERRAMIENTA_ADA],
    tool_choice: 'auto',
  };
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': crypto.createHash('sha256').update(`ada-${u.id}`).digest('hex'),
    },
    body: JSON.stringify({ session: sesion }),
  });
  const d = await res.json().catch(() => ({}));
  const sinCredito = res.status === 429 || /quota|billing|credit/i.test(JSON.stringify(d.error || ''));
  if (sinCredito) throw Object.assign(new Error('OpenAI no tiene crédito cargado: el modo B no funciona hasta cargar saldo. Usa A (Deepgram) o Actual.'), { status: 402 });
  if (!res.ok) throw Object.assign(new Error(`OpenAI respondió ${res.status}: ${(d.error && d.error.message) || 'error'}`), { status: 502 });
  return { value: d.value || (d.client_secret && d.client_secret.value), expira: d.expires_at, modelo: c.modelo_realtime };
}

// ---------- Sesiones de prueba y calificaciones ----------

async function guardarSesion(b = {}) {
  const num = (x) => (Number.isFinite(+x) ? +x : null);
  const modo = ['actual', 'A', 'B'].includes(b.modo) ? b.modo : null;
  if (!modo) throw new Error('modo debe ser actual, A o B');
  const nota = (x) => (Number.isInteger(+x) && +x >= 1 && +x <= 5 ? +x : null);
  await q(
    `INSERT INTO lab_voz (modo, turnos, duracion_s, demora_mediana_ms, demora_p95_ms, interrupciones, naturalidad, comprension, utilidad, comentario, datos, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [modo, num(b.turnos), num(b.duracion_s), num(b.demora_mediana_ms), num(b.demora_p95_ms), num(b.interrupciones),
      nota(b.naturalidad), nota(b.comprension), nota(b.utilidad), String(b.comentario || '').slice(0, 1000) || null,
      JSON.stringify(b.datos || {}).slice(0, 4000), new Date()]
  );
  return { ok: true };
}

async function resumenSesiones() {
  const filas = await q('SELECT * FROM lab_voz ORDER BY id DESC LIMIT 60');
  const porModo = {};
  for (const f of filas) (porModo[f.modo] = porModo[f.modo] || []).push(f);
  const prom = (xs, k) => {
    const v = xs.map((x) => x[k]).filter((x) => x !== null && x !== undefined);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };
  return {
    modos: Object.entries(porModo).map(([modo, xs]) => ({
      modo, sesiones: xs.length,
      demora_ms: prom(xs, 'demora_mediana_ms'), naturalidad: prom(xs, 'naturalidad'), comprension: prom(xs, 'comprension'), utilidad: prom(xs, 'utilidad'),
    })),
    ultimas: filas.slice(0, 12).map((f) => ({ modo: f.modo, cuando: F.fmt(f.creado_en), turnos: f.turnos, demora_ms: f.demora_mediana_ms, naturalidad: f.naturalidad, comprension: f.comprension, utilidad: f.utilidad, comentario: f.comentario })),
  };
}

module.exports = { configurado, conectarOido, tokenRealtime, guardarSesion, resumenSesiones, palabrasClave, urlDeepgram, instruccionesRealtime };
