// Dentro de la app de Android (WebView), el reconocimiento de voz del navegador no existe:
// se reemplaza por el de Android a través del puente nativo, con la misma interfaz que usa app.js.
(() => {
  const P = window.AdaAndroid;
  if (!P) return;
  document.documentElement.classList.add('en-android');
  let actual = null;
  let siguienteId = 1;

  class ReconocimientoAndroid {
    constructor() {
      this.lang = 'es-CL';
      this.interimResults = true;
      this.continuous = false;
      this.maxAlternatives = 1;
      this.onresult = null; this.onerror = null; this.onend = null; this.onstart = null;
      this._id = 0;
    }
    start() {
      if (actual && actual !== this) { try { actual.abort(); } catch (_) {} }
      actual = this;
      this._id = siguienteId++;
      P.escuchar(this._id, this.lang || 'es-CL', !!this.interimResults);
    }
    stop() { if (actual === this) P.dejarDeEscuchar(this._id); }
    abort() { if (actual === this) P.cancelarEscucha(this._id); }
  }
  const resultado = (texto, final) => {
    const r = [{ transcript: texto, confidence: 1 }];
    r.isFinal = final;
    return { results: [r], resultIndex: 0 };
  };
  // El lado nativo llama a esto con lo que va oyendo.
  window.__adaVoz = (id, tipo, dato) => {
    const r = actual;
    if (!r || r._id !== id) return;
    if (tipo === 'inicio' && r.onstart) r.onstart();
    else if (tipo === 'parcial' && r.onresult && r.interimResults) r.onresult(resultado(dato, false));
    else if (tipo === 'final' && r.onresult) r.onresult(resultado(dato, true));
    else if (tipo === 'error' && r.onerror) r.onerror({ error: dato });
    else if (tipo === 'fin') { actual = null; if (r.onend) r.onend(); }
  };
  window.SpeechRecognition = ReconocimientoAndroid;
  window.webkitSpeechRecognition = ReconocimientoAndroid;
})();
