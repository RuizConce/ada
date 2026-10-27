// Laboratorio de voz: compara la conversación actual con dos prototipos.
//  A) Tiempo real + Claude: el micrófono se transcribe en vivo (Deepgram) y responde ADA/Claude con voz rápida.
//  B) Voz a voz + ADA: OpenAI Realtime conversa directo y le pide a ADA lo que requiere datos o acciones.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  let token = null;
  try { token = localStorage.getItem('ada_token'); } catch (_) {}
  let convId = null;
  try { convId = parseInt(localStorage.getItem('ada_conv'), 10) || null; } catch (_) {}

  const api = async (ruta, op = {}) => {
    const r = await fetch(ruta, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(op.headers || {}) } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    return d;
  };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const md = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n/g, '<br>');

  // ---------- Pantalla ----------
  const DESC = {
    A: 'El micrófono queda abierto y se transcribe en vivo (Deepgram, con tus contactos y proyectos como palabras clave). Detecta cuándo terminaste aunque hagas pausas, y puedes interrumpir a ADA hablándole. El cerebro es la misma ADA con Claude; la voz es Aura (Deepgram), muy rápida.',
    B: 'Un modelo de voz a voz (OpenAI Realtime) conversa contigo con entonación humana y casi sin demora. Cuando hay que revisar o hacer algo (agenda, correo, Drive, encargos), se lo pide a ADA y te cuenta el resultado.',
    actual: 'Conversa un rato con ADA en la pantalla normal y vuelve aquí para calificarla, así comparamos con los mismos criterios.',
  };
  let modo = 'A';
  function elegirModo(m) {
    if (sesion) return;
    modo = m;
    $$('.modos [data-modo]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.modo === m)));
    $('#lab-desc').textContent = DESC[m];
    $('#lab-boton').textContent = m === 'actual' ? 'Ir a ADA' : 'Empezar';
  }
  $$('.modos [data-modo]').forEach((b) => b.addEventListener('click', () => elegirModo(b.dataset.modo)));

  const fase = (t) => { $('#lab-fase').textContent = t; };
  const error = (t) => { $('#lab-error').textContent = t || ''; };
  let lineaParcial = null;
  function linea(quien, texto, parcial = false) {
    const cont = $('#lab-transcripcion');
    if (lineaParcial && lineaParcial.dataset.quien === quien) { lineaParcial.innerHTML = quien === 'ada' ? md(texto) : esc(`“${texto}”`); if (!parcial) { lineaParcial.classList.remove('parcial'); lineaParcial = null; } cont.scrollTop = cont.scrollHeight; return; }
    const p = document.createElement('p');
    p.className = `linea ${quien}${parcial ? ' parcial' : ''}`;
    p.dataset.quien = quien;
    p.innerHTML = quien === 'ada' ? md(texto) : esc(`“${texto}”`);
    cont.appendChild(p);
    if (parcial) lineaParcial = p;
    cont.scrollTop = cont.scrollHeight;
  }

  // ---------- Métricas ----------
  let demoras = [];
  let turnos = 0;
  let interrupciones = 0;
  let inicioSesion = 0;
  const mediana = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
  const p95 = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) * 0.95)] : null; };
  const seg = (ms) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`);
  function registrarDemora(ms) {
    if (!(ms > 0 && ms < 60000)) return;
    demoras.push(ms);
    $('#m-ultima').textContent = seg(ms);
    $('#m-mediana').textContent = seg(mediana(demoras));
  }
  function contarTurno() { turnos += 1; $('#m-turnos').textContent = String(turnos); }

  // ---------- Hablar (modo A): cola de frases con voz del servidor ----------
  const reproductor = new Audio();
  let colaVoz = [];
  let hablando = false;
  let fraseActual = '';
  let alPrimerAudio = null;
  // Palabras que ADA dijo en esta respuesta: lo que Deepgram oiga y coincida con ellas es su eco.
  const normal = (w) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const palabrasDe = (t) => t.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(normal);
  let dichoPorAda = new Set();
  let ecoHasta = 0;
  function decir(frase) {
    const texto = frase.replace(/\[\[PANTALLA\]\][\s\S]*$/, '').replace(/[*_#`]/g, '').trim();
    if (!texto) return;
    for (const w of palabrasDe(texto)) dichoPorAda.add(w);
    const audio = fetch('/api/voz', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ texto, proveedor: 'deepgram' }) })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null);
    colaVoz.push({ texto, audio });
    if (!hablando) siguiente();
  }
  async function siguiente() {
    const item = colaVoz.shift();
    if (!item) {
      if (hablando) ecoHasta = performance.now() + 1500; // el eco de la última frase puede llegar un poco después
      hablando = false;
      reproductor.volume = 1;
      $('#lab-boton').classList.remove('hablando');
      if (sesion && !pensando) fase('Te escucho…');
      return;
    }
    hablando = true;
    $('#lab-boton').classList.add('hablando');
    const url = await item.audio;
    if (!hablando) return; // la interrumpieron mientras cargaba
    if (!url) { siguiente(); return; }
    fraseActual = item.texto;
    if (alPrimerAudio) { alPrimerAudio(); alPrimerAudio = null; }
    fase('ADA está hablando · háblale para interrumpir');
    reproductor.src = url;
    reproductor.onended = () => { URL.revokeObjectURL(url); siguiente(); };
    reproductor.onerror = () => siguiente();
    reproductor.play().catch(() => siguiente());
  }
  function callar() {
    // La frase en curso todavía trae el eco del comienzo ("…propuesta, espera"): se sigue limpiando un rato.
    if (hablando) ecoHasta = performance.now() + 4000;
    colaVoz = [];
    hablando = false;
    fraseActual = '';
    reproductor.pause();
    reproductor.volume = 1;
    $('#lab-boton').classList.remove('hablando');
  }

  // Corta el texto en frases para empezar a hablar apenas llega la primera.
  function cortador(alFrase) {
    let buf = '';
    let pantalla = false;
    return {
      agregar(d) {
        if (pantalla) return;
        buf += d;
        const i = buf.indexOf('[[PANTALLA]]');
        if (i >= 0) { const antes = buf.slice(0, i); buf = ''; pantalla = true; if (antes.trim()) alFrase(antes); return; }
        let m;
        while ((m = buf.match(/^([\s\S]*?[.!?…:;])\s+/))) { buf = buf.slice(m[0].length); if (m[1].trim()) alFrase(m[1]); }
      },
      terminar() { if (!pantalla && buf.trim()) alFrase(buf); buf = ''; },
    };
  }

  // ---------- Preguntarle a ADA (lo usan A y B) ----------
  let pensando = false;
  let controlTurno = null;
  async function preguntarAda(texto, { hablarEnVivo = false, alTexto } = {}) {
    controlTurno = new AbortController();
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mensaje: texto, voz: true, conversacion_id: convId }),
      signal: controlTurno.signal,
    });
    if (!res.ok || !res.body) throw new Error(`ADA respondió ${res.status}`);
    const lector = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let respuesta = '';
    let detalle = '';
    const docs = [];
    let fin = null;
    const corte = hablarEnVivo ? cortador(decir) : null;
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const bloque = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let tipo = 'message';
        let datos = '';
        for (const l of bloque.split('\n')) {
          if (l.startsWith('event: ')) tipo = l.slice(7).trim();
          else if (l.startsWith('data: ')) datos += l.slice(6);
        }
        if (!datos) continue;
        const d = JSON.parse(datos);
        if (tipo === 'conversacion') { convId = d.conversacion_id; try { localStorage.setItem('ada_conv', String(convId)); } catch (_) {} }
        else if (tipo === 'texto') { respuesta += d.delta; if (corte) corte.agregar(d.delta); if (alTexto) alTexto(respuesta); }
        else if (tipo === 'detalle') { detalle += d.delta; $('#lab-detalle').innerHTML = md(detalle); }
        else if (tipo === 'estado') { if (!hablando) fase(d.texto); }
        else if (tipo === 'documento') { docs.push(d.titulo); $('#lab-docs').textContent = `📄 En tu archivo: ${docs.join(', ')}`; }
        else if (tipo === 'fin') fin = d;
        else if (tipo === 'error') throw new Error(d.error);
      }
    }
    if (corte) corte.terminar();
    const detalleFinal = (fin && fin.detalle) || detalle;
    if (detalleFinal) $('#lab-detalle').innerHTML = md(detalleFinal);
    return { respuesta: (fin && fin.respuesta) || respuesta, detalle: detalleFinal, documentos: docs };
  }

  // ---------- Modo A: oído en tiempo real ----------
  let sesion = null;
  const CONECTORES = /(?:^|\s)(de|del|el|la|los|las|un|una|que|y|o|a|al|en|con|para|por|pero|porque|como|mi|tu|su|eh|em|este|osea|o sea|entonces|cuando|si|le|lo|me|se)$/i;
  const graciaPara = (t) => (/,$/.test(t.trim()) || CONECTORES.test(t.trim().replace(/[.!?…]+$/, '')) ? 1800 : 0);
  // Lo que se oye puede venir mezclado: el eco de ADA por el parlante + la voz de la persona
  // ("encontré el correo… espera, espera"). Se queda con lo que ADA NO dijo.
  const CORTE = new Set(['espera', 'esperate', 'para', 'pare', 'oye', 'ada', 'alto', 'momento', 'perdon', 'disculpa', 'stop', 'no']);
  function loNuevo(t) {
    const ws = t.split(/\s+/).filter(Boolean);
    const i = ws.findIndex((w) => { const n = palabrasDe(w)[0]; return n && n.length > 1 && !dichoPorAda.has(n); });
    if (i < 0) return { texto: '', palabras: [], corte: false };
    const resto = ws.slice(i).join(' ');
    const palabras = palabrasDe(resto).filter((w) => !dichoPorAda.has(w));
    return { texto: resto, palabras, corte: palabras.some((w) => CORTE.has(w)) };
  }

  async function empezarA() {
    const st = await api('/api/lab/estado');
    if (!st.deepgram) throw new Error('Falta DEEPGRAM_API_KEY en Railway (ver instrucciones).');
    const micro = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const codigo = `class C extends AudioWorkletProcessor { process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor('captura', C);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })));
    const nodo = new AudioWorkletNode(ctx, 'captura');
    ctx.createMediaStreamSource(micro).connect(nodo);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/oido?token=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';
    const razon = ctx.sampleRate / 16000;
    let pendienteAudio = [];
    nodo.port.onmessage = (e) => {
      // 48 kHz → 16 kHz, entero de 16 bits.
      const x = e.data;
      const n = Math.floor(x.length / razon);
      const out = new Int16Array(n);
      for (let k = 0; k < n; k++) out[k] = Math.max(-1, Math.min(1, x[Math.floor(k * razon)])) * 0x7fff;
      pendienteAudio.push(out);
      if (pendienteAudio.length >= 8 && ws.readyState === 1) {
        const total = pendienteAudio.reduce((a, b) => a + b.length, 0);
        const junto = new Int16Array(total);
        let o = 0;
        for (const b of pendienteAudio) { junto.set(b, o); o += b.length; }
        ws.send(junto.buffer);
        pendienteAudio = [];
      }
    };
    let finales = [];
    let timerEnvio = null;
    let timerVolumen = null;
    let finDeHabla = 0;
    const textoUsuario = () => finales.join(' ').replace(/\s+/g, ' ').trim();
    function programarEnvio() {
      clearTimeout(timerEnvio);
      const t = textoUsuario();
      if (!t) return;
      timerEnvio = setTimeout(() => turno(), graciaPara(t));
    }
    async function turno() {
      const t = textoUsuario();
      if (!t || pensando) return;
      finales = [];
      callar(); // si quedaba algo por decir de la respuesta anterior, se descarta
      dichoPorAda = new Set();
      linea('yo', t);
      contarTurno();
      pensando = true;
      fase('ADA está pensando…');
      const t0 = finDeHabla || performance.now();
      alPrimerAudio = () => registrarDemora(performance.now() - t0);
      let actual = null;
      try {
        await preguntarAda(t, { hablarEnVivo: true, alTexto: (r) => { actual = r; linea('ada', r.split('[[PANTALLA]]')[0], true); } });
        if (actual) linea('ada', actual.split('[[PANTALLA]]')[0]);
      } catch (e) {
        if (e.name !== 'AbortError') error(e.message);
      } finally {
        pensando = false;
        if (!hablando) fase('Te escucho…');
        if (textoUsuario()) programarEnvio(); // habló mientras pensaba
      }
    }
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'Listo') { fase(`Te escucho… (${m.palabras_clave} nombres propios cargados)`); return; }
      if (m.type === 'Error') { error(m.mensaje); return; }
      if (m.type === 'SpeechStarted' && hablando) {
        // Empezó a sonar una voz encima: baja el volumen de ADA para oírla mejor (y que el eco no la tape).
        reproductor.volume = 0.3;
        clearTimeout(timerVolumen);
        timerVolumen = setTimeout(() => { if (hablando) reproductor.volume = 1; }, 1800);
        return;
      }
      if (m.type === 'Results') {
        const t = (m.texto || '').trim();
        if (!t) return;
        let propio = t;
        if (hablando || performance.now() < ecoHasta) {
          const n = loNuevo(t);
          if (hablando) {
            // Interrumpir: dos palabras que ADA no dijo, o una palabra de corte ("espera", "oye", "para").
            if (n.palabras.length >= 2 || n.corte) {
              callar();
              if (controlTurno) controlTurno.abort();
              interrupciones += 1;
              fase('Te escucho…');
            } else return; // es su propio eco
          }
          if (!n.texto) return; // eco que llegó justo después de que terminó de hablar
          propio = n.texto;
        }
        clearTimeout(timerEnvio);
        if (m.is_final) { finales.push(propio); linea('yo', textoUsuario(), true); } else linea('yo', `${textoUsuario()} ${propio}`.trim(), true);
        if (m.speech_final) { finDeHabla = performance.now(); programarEnvio(); }
      } else if (m.type === 'UtteranceEnd') {
        if (!finDeHabla || performance.now() - finDeHabla > 1500) finDeHabla = performance.now() - 1000;
        programarEnvio();
      }
    };
    ws.onclose = () => { if (sesion) { error('Se cortó la conexión del micrófono.'); terminar(); } };
    const keepAlive = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"KeepAlive"}'); }, 6000);
    return {
      cerrar() {
        clearInterval(keepAlive);
        clearTimeout(timerEnvio);
        try { ws.close(); } catch (_) {}
        micro.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        callar();
        if (controlTurno) controlTurno.abort();
      },
    };
  }

  // ---------- Modo B: voz a voz (OpenAI Realtime por WebRTC) ----------
  async function empezarB() {
    const st = await api('/api/lab/estado');
    if (!st.openai) throw new Error('Falta OPENAI_API_KEY en Railway (ver instrucciones).');
    fase('Conectando…');
    const t = await api('/api/lab/realtime/token', { method: 'POST' });
    const pc = new RTCPeerConnection();
    const salida = new Audio();
    salida.autoplay = true;
    pc.ontrack = (e) => { salida.srcObject = e.streams[0]; };
    const micro = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    pc.addTrack(micro.getTracks()[0]);
    const dc = pc.createDataChannel('oai-events');
    const mandar = (o) => { if (dc.readyState === 'open') dc.send(JSON.stringify(o)); };
    let finDeHabla = 0;
    let textoAda = '';
    let adaHablando = false;
    const llamadasHechas = new Set();
    let usoTokens = { entrada: 0, salida: 0 };

    async function usarAda(callId, args) {
      if (llamadasHechas.has(callId)) return;
      llamadasHechas.add(callId);
      let pedido = '';
      try { pedido = JSON.parse(args || '{}').pedido || ''; } catch (_) {}
      fase(`ADA trabajando: ${pedido.slice(0, 60)}…`);
      let salidaHerramienta;
      try {
        const r = await preguntarAda(pedido);
        salidaHerramienta = {
          respuesta: r.respuesta,
          ...(r.detalle ? { detalle_en_pantalla: r.detalle.slice(0, 2500) } : {}),
          ...(r.documentos.length ? { documentos_en_pantalla: r.documentos } : {}),
        };
      } catch (e) {
        salidaHerramienta = { error: `No se pudo: ${e.message}` };
      }
      mandar({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(salidaHerramienta).slice(0, 6000) } });
      mandar({ type: 'response.create' });
    }

    dc.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      switch (m.type) {
        case 'input_audio_buffer.speech_started':
          if (adaHablando) interrupciones += 1;
          fase('Te escucho…');
          break;
        case 'input_audio_buffer.speech_stopped':
          finDeHabla = performance.now();
          fase('ADA está pensando…');
          break;
        case 'conversation.item.input_audio_transcription.completed':
          if (m.transcript && m.transcript.trim()) { linea('yo', m.transcript.trim()); contarTurno(); }
          break;
        case 'response.created':
          textoAda = '';
          break;
        case 'output_audio_buffer.started':
          adaHablando = true;
          $('#lab-boton').classList.add('hablando');
          fase('ADA está hablando · háblale para interrumpir');
          if (finDeHabla) { registrarDemora(performance.now() - finDeHabla); finDeHabla = 0; }
          break;
        case 'output_audio_buffer.stopped':
        case 'output_audio_buffer.cleared':
          adaHablando = false;
          $('#lab-boton').classList.remove('hablando');
          fase('Te escucho…');
          break;
        case 'response.output_audio_transcript.delta':
          textoAda += m.delta || '';
          linea('ada', textoAda, true);
          break;
        case 'response.output_audio_transcript.done':
          if (textoAda) linea('ada', textoAda);
          break;
        case 'response.function_call_arguments.done':
          usarAda(m.call_id, m.arguments);
          break;
        case 'response.done': {
          const r = m.response || {};
          for (const it of r.output || []) if (it.type === 'function_call') usarAda(it.call_id, it.arguments);
          if (r.usage) { usoTokens.entrada += r.usage.input_tokens || 0; usoTokens.salida += r.usage.output_tokens || 0; }
          break;
        }
        case 'error':
          error((m.error && m.error.message) || 'Error de la voz');
          break;
        default:
      }
    };
    dc.onopen = () => {
      fase('Conectada. Habla cuando quieras.');
      mandar({ type: 'response.create', response: { instructions: 'Saluda en una frase corta, por su nombre, y pregúntale en qué anda.' } });
    };
    const oferta = await pc.createOffer();
    await pc.setLocalDescription(oferta);
    const r = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST', body: oferta.sdp, headers: { Authorization: `Bearer ${t.value}`, 'Content-Type': 'application/sdp' },
    });
    if (!r.ok) throw new Error(`OpenAI no aceptó la conexión (${r.status}): ${(await r.text()).slice(0, 200)}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
    return {
      uso: () => usoTokens,
      cerrar() {
        try { dc.close(); } catch (_) {}
        pc.getSenders().forEach((s) => s.track && s.track.stop());
        pc.close();
        salida.srcObject = null;
        if (controlTurno) controlTurno.abort();
      },
    };
  }

  // ---------- Empezar / terminar ----------
  async function empezar() {
    error('');
    if (modo === 'actual') { location.href = '/'; return; }
    demoras = []; turnos = 0; interrupciones = 0;
    $('#m-turnos').textContent = '0'; $('#m-ultima').textContent = '—'; $('#m-mediana').textContent = '—';
    $('#lab-transcripcion').innerHTML = ''; $('#lab-detalle').innerHTML = ''; $('#lab-docs').textContent = '';
    $('#lab-boton').disabled = true;
    try {
      sesion = modo === 'A' ? await empezarA() : await empezarB();
      inicioSesion = performance.now();
      $('#lab-boton').textContent = 'Terminar';
      $('#lab-boton').classList.add('activo');
      $('#lab-terminar').hidden = false;
    } catch (e) {
      sesion = null;
      error(e.name === 'NotAllowedError' ? 'Necesito permiso para usar el micrófono.' : e.message);
      fase('No se pudo empezar.');
    } finally {
      $('#lab-boton').disabled = false;
    }
  }
  function terminar() {
    if (!sesion) return;
    const s = sesion;
    sesion = null;
    s.cerrar();
    datosSesion = { modo, turnos, duracion_s: Math.round((performance.now() - inicioSesion) / 1000), demora_mediana_ms: mediana(demoras), demora_p95_ms: p95(demoras), interrupciones, datos: { demoras, uso: s.uso ? s.uso() : undefined } };
    $('#lab-boton').textContent = 'Empezar';
    $('#lab-boton').classList.remove('activo', 'hablando');
    $('#lab-terminar').hidden = true;
    fase('Sesión terminada. Califícala abajo.');
  }
  $('#lab-boton').addEventListener('click', () => {
    if (!sesion) return empezar();
    if (hablando) { callar(); if (controlTurno) controlTurno.abort(); interrupciones += 1; fase('Te escucho…'); return; } // tocar = interrumpir
    terminar();
  });
  $('#lab-terminar').addEventListener('click', terminar);

  // ---------- Calificar ----------
  let datosSesion = null;
  const notas = {};
  $$('.estrellas').forEach((cont) => {
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = String(n);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        notas[cont.dataset.nota] = n;
        [...cont.children].forEach((x) => x.setAttribute('aria-pressed', String(Number(x.textContent) <= n)));
      });
      cont.appendChild(b);
    }
  });
  $('#lab-guardar').addEventListener('click', async () => {
    try {
      await api('/api/lab/sesiones', { method: 'POST', body: JSON.stringify({ ...(datosSesion || { modo }), modo: (datosSesion && datosSesion.modo) || modo, ...notas, comentario: $('#lab-comentario').value }) });
      $('#lab-comentario').value = '';
      $$('.estrellas button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      Object.keys(notas).forEach((k) => delete notas[k]);
      datosSesion = null;
      fase('Calificación guardada ✓');
      pintarResultados();
    } catch (e) { error(e.message); }
  });

  async function pintarResultados() {
    try {
      const r = await api('/api/lab/sesiones');
      if (!r.modos.length) return;
      const nombre = { A: 'A · Tiempo real', B: 'B · Voz a voz', actual: 'Actual' };
      $('#lab-resultados').innerHTML = `<table><tr><th>Modo</th><th>Sesiones</th><th>Demora</th><th>Natural</th><th>Entendió</th><th>Sirvió</th></tr>${
        r.modos.map((m) => `<tr><td>${nombre[m.modo] || m.modo}</td><td>${m.sesiones}</td><td>${seg(m.demora_ms)}</td><td>${m.naturalidad ?? '—'}</td><td>${m.comprension ?? '—'}</td><td>${m.utilidad ?? '—'}</td></tr>`).join('')
      }</table>`;
    } catch (_) {}
  }

  // ---------- Inicio ----------
  (async () => {
    elegirModo('A');
    if (!token) { error('Entra primero a ADA con tu nombre y clave.'); $('#lab-boton').disabled = true; return; }
    try {
      const st = await api('/api/lab/estado');
      $('#lab-claves').textContent = `Deepgram: ${st.deepgram ? 'lista ✓' : 'falta la clave'} · OpenAI: ${st.openai ? `lista ✓ (${st.modelo_realtime}, voz ${st.voz_realtime})` : 'falta la clave'}`;
      pintarResultados();
    } catch (e) {
      error(e.message.includes('Solo Cristian') ? 'El laboratorio es solo para el administrador.' : e.message);
      $('#lab-boton').disabled = true;
    }
  })();
})();
