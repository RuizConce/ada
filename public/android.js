// Dentro de la app de Android (WebView) el reconocimiento de voz del navegador no existe.
// Se reemplaza, con la misma interfaz que usa app.js, por:
//  1) Deepgram en vivo (micrófono → servidor de ADA → Deepgram), que entiende mejor los nombres propios;
//  2) si Deepgram no está disponible, el reconocedor de voz de Android (puente nativo).
(() => {
  const P = window.AdaAndroid;
  if (!P) return;
  document.documentElement.classList.add('en-android');

  // ---------- Reconocedor nativo de Android (respaldo) ----------
  let actualNativo = null;
  let siguienteId = 1;
  class ReconocimientoNativo {
    constructor() { this.lang = 'es-CL'; this.interimResults = true; this.continuous = false; this.maxAlternatives = 1; this._id = 0; }
    start() {
      if (actualNativo && actualNativo !== this) { try { actualNativo.abort(); } catch (_) {} }
      actualNativo = this;
      this._id = siguienteId++;
      P.escuchar(this._id, this.lang || 'es-CL', !!this.interimResults);
    }
    stop() { if (actualNativo === this) P.dejarDeEscuchar(this._id); }
    abort() { if (actualNativo === this) P.cancelarEscucha(this._id); }
  }
  const resultados = (finales, parcial) => {
    const lista = finales.map((t) => { const r = [{ transcript: t, confidence: 1 }]; r.isFinal = true; return r; });
    if (parcial) { const r = [{ transcript: parcial, confidence: 1 }]; r.isFinal = false; lista.push(r); }
    return { results: lista, resultIndex: 0 };
  };
  window.__adaVoz = (id, tipo, dato) => {
    const r = actualNativo;
    if (!r || r._id !== id) return;
    if (tipo === 'inicio' && r.onstart) r.onstart();
    else if (tipo === 'parcial' && r.onresult && r.interimResults) r.onresult(resultados([], dato));
    else if (tipo === 'final' && r.onresult) r.onresult(resultados([dato], ''));
    else if (tipo === 'error' && r.onerror) r.onerror({ error: dato });
    else if (tipo === 'fin') { actualNativo = null; if (r.onend) r.onend(); }
  };

  // ---------- Deepgram en vivo ----------
  // Una sola conexión (micrófono + WebSocket) que se mantiene abierta durante la conversación;
  // el audio se envía solo mientras alguien escucha. Se cierra sola tras 25 s sin uso.
  let usarNativo = false;
  const Oido = { ws: null, ctx: null, micro: null, abriendo: null, oyente: null, cierre: null, keep: null };
  function cerrarOido() {
    clearInterval(Oido.keep);
    try { if (Oido.ws) Oido.ws.close(); } catch (_) {}
    try { if (Oido.micro) Oido.micro.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (Oido.ctx) Oido.ctx.close(); } catch (_) {}
    Oido.ws = null; Oido.ctx = null; Oido.micro = null; Oido.abriendo = null;
  }
  function abrirOido() {
    if (Oido.ws && Oido.ws.readyState === 1) return Promise.resolve();
    if (Oido.abriendo) return Oido.abriendo;
    Oido.abriendo = (async () => {
      let token = null;
      try { token = localStorage.getItem('ada_token'); } catch (_) {}
      if (!token) throw Object.assign(new Error('sin sesión'), { codigo: 'not-allowed' });
      const micro = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
        .catch(() => { throw Object.assign(new Error('micrófono'), { codigo: 'not-allowed' }); });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const codigo = 'class C extends AudioWorkletProcessor { process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor(\'captura\', C);';
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })));
      const nodo = new AudioWorkletNode(ctx, 'captura');
      ctx.createMediaStreamSource(micro).connect(nodo);
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/oido?modo=voz&token=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      Object.assign(Oido, { ws, ctx, micro });
      const razon = ctx.sampleRate / 16000;
      let pendiente = [];
      nodo.port.onmessage = (e) => {
        if (!Oido.oyente) { pendiente = []; return; }
        const x = e.data;
        const n = Math.floor(x.length / razon);
        const out = new Int16Array(n);
        for (let k = 0; k < n; k++) out[k] = Math.max(-1, Math.min(1, x[Math.floor(k * razon)])) * 0x7fff;
        pendiente.push(out);
        if (pendiente.length >= 6 && ws.readyState === 1) {
          const total = pendiente.reduce((a, b) => a + b.length, 0);
          const junto = new Int16Array(total);
          let o = 0;
          for (const b of pendiente) { junto.set(b, o); o += b.length; }
          ws.send(junto.buffer);
          pendiente = [];
        }
      };
      Oido.keep = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"KeepAlive"}'); }, 5000);
      await new Promise((ok, mal) => {
        const t = setTimeout(() => mal(Object.assign(new Error('Deepgram no respondió'), { codigo: 'network' })), 8000);
        ws.onmessage = (ev) => {
          let m;
          try { m = JSON.parse(ev.data); } catch (_) { return; }
          if (m.type === 'Listo') { clearTimeout(t); ok(); return; }
          if (m.type === 'Error') { clearTimeout(t); mal(Object.assign(new Error(m.mensaje), { codigo: /DEEPGRAM_API_KEY/.test(m.mensaje) ? 'sin-deepgram' : 'network' })); return; }
          if (Oido.oyente) Oido.oyente._mensaje(m);
        };
        ws.onclose = () => { clearTimeout(t); mal(Object.assign(new Error('conexión cerrada'), { codigo: 'network' })); };
      });
      ws.onclose = () => { const o = Oido.oyente; cerrarOido(); if (o) o._terminar('network'); };
    })();
    Oido.abriendo.catch(() => cerrarOido());
    return Oido.abriendo;
  }

  class ReconocimientoDeepgram {
    constructor() { this.lang = 'es-CL'; this.interimResults = true; this.continuous = false; this.maxAlternatives = 1; this._activo = false; }
    start() {
      if (Oido.oyente && Oido.oyente !== this) Oido.oyente._terminar();
      clearTimeout(Oido.cierre);
      this._finales = [];
      this._parcial = '';
      this._activo = true;
      Oido.oyente = this;
      abrirOido().then(() => {
        if (!this._activo) return;
        if (this.onstart) this.onstart();
        // Sin voz en 8 s: termina como lo haría el navegador.
        this._sinVoz = setTimeout(() => { if (this._activo && !this._finales.length && !this._parcial) this._terminar('no-speech'); }, 8000);
      }).catch((e) => {
        if (!this._activo) return;
        if (e.codigo === 'sin-deepgram' || e.codigo === 'network') usarNativo = true; // la próxima vez, el de Android
        this._terminar(e.codigo || 'network');
      });
    }
    _emitir() {
      if (this.onresult) this.onresult(resultados(this._finales, this._parcial));
    }
    _mensaje(m) {
      if (!this._activo) return;
      if (m.type === 'Results' && m.texto) {
        clearTimeout(this._sinVoz);
        if (m.is_final) { this._finales.push(m.texto); this._parcial = ''; } else this._parcial = m.texto;
        this._emitir();
        if (m.speech_final && this._finales.length) this._terminar();
      } else if (m.type === 'UtteranceEnd' && (this._finales.length || this._parcial)) {
        if (this._parcial) { this._finales.push(this._parcial); this._parcial = ''; this._emitir(); }
        this._terminar();
      }
    }
    _terminar(error) {
      if (!this._activo) return;
      this._activo = false;
      clearTimeout(this._sinVoz);
      if (Oido.oyente === this) Oido.oyente = null;
      if (this._parcial) { this._finales.push(this._parcial); this._parcial = ''; this._emitir(); }
      if (error && this.onerror) this.onerror({ error });
      clearTimeout(Oido.cierre);
      Oido.cierre = setTimeout(() => { if (!Oido.oyente) cerrarOido(); }, 25000);
      if (this.onend) this.onend();
    }
    stop() { this._terminar(); }
    abort() { this._parcial = ''; this._terminar(); }
  }

  // app.js crea uno por turno: se elige en ese momento (Deepgram, o Android si Deepgram falló).
  function Reconocimiento() {
    return usarNativo ? new ReconocimientoNativo() : new ReconocimientoDeepgram();
  }
  window.SpeechRecognition = Reconocimiento;
  window.webkitSpeechRecognition = Reconocimiento;
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (Oido.oyente) Oido.oyente._terminar(); cerrarOido(); } });
  window.__adaOido = { cerrar: cerrarOido, modo: () => (usarNativo ? 'android' : 'deepgram') };
})();
