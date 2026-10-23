(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let token = null;
  let convId = null;          // conversación en curso
  let ocupado = false;        // esperando respuesta del servidor
  let docsActuales = [];      // documentos entregados en la conversación en curso
  let archivosActuales = [];  // archivos Word/Excel creados en la conversación en curso
  let proyectos = [];

  try {
    token = localStorage.getItem('ada_token');
    convId = parseInt(localStorage.getItem('ada_conv'), 10) || null;
  } catch (_) {}

  function guardarConv(id) {
    convId = id || null;
    try {
      if (convId) localStorage.setItem('ada_conv', String(convId));
      else localStorage.removeItem('ada_conv');
    } catch (_) {}
    pintarControles();
  }

  // ---------- API ----------
  async function api(ruta, opciones = {}) {
    const res = await fetch(ruta, {
      ...opciones,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opciones.headers || {}) },
    });
    if (res.status === 401 && ruta !== '/api/login') { salir(); throw new Error('Sesión expirada'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  // ---------- Markdown mínimo y seguro ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function md(texto) {
    const lineas = String(texto || '').split('\n');
    let html = '';
    let lista = null;
    let parrafo = [];
    const cerrarParrafo = () => { if (parrafo.length) { html += `<p>${parrafo.map(inline).join('<br>')}</p>`; parrafo = []; } };
    const cerrarLista = () => { if (lista) { html += `</${lista}>`; lista = null; } };
    for (const l of lineas) {
      const ul = l.match(/^\s*[-•*]\s+(.*)/);
      const ol = l.match(/^\s*\d+[.)]\s+(.*)/);
      const h = l.match(/^(#{1,4})\s+(.*)/);
      if (ul || ol) {
        cerrarParrafo();
        const tipo = ul ? 'ul' : 'ol';
        if (lista !== tipo) { cerrarLista(); html += `<${tipo}>`; lista = tipo; }
        html += `<li>${inline((ul || ol)[1])}</li>`;
      } else if (h) {
        cerrarParrafo(); cerrarLista();
        const nivel = Math.min(h[1].length + 1, 4);
        html += `<h${nivel}>${inline(h[2])}</h${nivel}>`;
      } else if (/^\s*---+\s*$/.test(l)) {
        cerrarParrafo(); cerrarLista(); html += '<hr>';
      } else if (!l.trim()) {
        cerrarParrafo(); cerrarLista();
      } else {
        cerrarLista();
        parrafo.push(l);
      }
    }
    cerrarParrafo(); cerrarLista();
    return html;
  }

  // ---------- Avisos ----------
  let timerAviso = null;
  function aviso(texto, error = false) {
    const a = $('#aviso');
    a.textContent = texto;
    a.classList.toggle('error', error);
    a.hidden = false;
    clearTimeout(timerAviso);
    timerAviso = setTimeout(() => { a.hidden = true; }, error ? 6000 : 3200);
  }

  function fechaCorta(d) {
    const f = new Date(d);
    const hoy = new Date();
    const ayer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1);
    const hora = f.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
    if (f.toDateString() === hoy.toDateString()) return `Hoy ${hora}`;
    if (f.toDateString() === ayer.toDateString()) return `Ayer ${hora}`;
    return `${f.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })} ${hora}`;
  }

  function duracion(a, b) {
    if (!a || !b) return '';
    const min = Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000));
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
  }

  // ---------- Escenario de voz ----------
  const orbe = $('#orbe');
  const txtFase = $('#fase');
  const subYo = $('#sub-yo');
  const subAda = $('#sub-ada');

  const TEXTO_FASE = {
    reposo: 'Toca para hablar con ADA',
    escuchando: 'Te escucho…',
    pensando: 'ADA está pensando…',
    hablando: 'ADA está hablando · tócala o háblale para interrumpir',
  };

  function setFase(fase, texto) {
    orbe.dataset.fase = fase;
    txtFase.textContent = texto || TEXTO_FASE[fase];
  }

  function mostrarYo(texto) {
    subYo.textContent = texto ? `“${texto}”` : '';
  }

  function mostrarAda(texto) {
    subAda.innerHTML = texto ? md(texto) : '';
    subAda.scrollTop = 0;
  }

  // ---------- Entregas: documentos y mensajes por autorizar ----------
  const ICONO_DOC = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 3.5h7l4.5 4.5v12.5H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3.5V8h4.5M9.5 12.5h6M9.5 16h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  let autorizaciones = [];

  const ICONO_ARCHIVO = {
    word: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 3.5h7l4.5 4.5v12.5H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.5 11.5l1.2 5 1.3-4 1.3 4 1.2-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    excel: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 9.5h16M4 14.5h16M10 4v16" stroke="currentColor" stroke-width="1.6"/></svg>',
  };

  async function descargarArchivo(a, boton) {
    const texto = boton.textContent;
    boton.textContent = '…';
    try {
      const res = await fetch(`/api/archivos/${a.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const enl = document.createElement('a');
      enl.href = url;
      enl.download = a.nombre;
      document.body.appendChild(enl);
      enl.click();
      setTimeout(() => { URL.revokeObjectURL(url); enl.remove(); }, 1000);
    } catch (e) {
      aviso(`No se pudo descargar: ${e.message}`, true);
    }
    boton.textContent = texto;
  }

  function tarjetaArchivo(a) {
    const t = document.createElement('div');
    t.className = 'entrega-doc entrega-archivo';
    t.innerHTML = `${ICONO_ARCHIVO[a.tipo] || ICONO_DOC}<span><small></small><strong></strong></span><div class="archivo-botones"></div>`;
    t.querySelector('small').textContent = a.tipo === 'excel' ? 'Excel' : 'Word';
    t.querySelector('strong').textContent = a.nombre;
    const botones = t.querySelector('.archivo-botones');
    const bajar = document.createElement('button');
    bajar.type = 'button';
    bajar.textContent = 'Descargar';
    bajar.addEventListener('click', () => descargarArchivo(a, bajar));
    botones.appendChild(bajar);
    if (a.drive_url) {
      const drive = document.createElement('a');
      drive.href = a.drive_url;
      drive.target = '_blank';
      drive.rel = 'noopener';
      drive.textContent = 'Abrir en Drive';
      botones.appendChild(drive);
    }
    return t;
  }

  function pintarEntregas() {
    const cont = $('#entregas');
    cont.innerHTML = '';
    for (const a of archivosActuales.slice().reverse()) cont.appendChild(tarjetaArchivo(a));
    for (const d of docsActuales.slice().reverse()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'entrega-doc';
      b.innerHTML = `${ICONO_DOC}<span><small>Documento</small><strong></strong></span><em>Abrir</em>`;
      b.querySelector('strong').textContent = d.titulo;
      b.addEventListener('click', () => abrirDocumento(d.id));
      cont.appendChild(b);
    }
    for (const a of autorizaciones) cont.appendChild(tarjetaAutorizacion(a));
  }

  const CANAL = { whatsapp: 'WhatsApp', correo: 'Correo', llamada: 'Llamada', otro: 'Mensaje' };

  function enlace(a, texto, asunto) {
    if (a.canal === 'whatsapp') return a.telefono ? `https://wa.me/${a.telefono}?text=${encodeURIComponent(texto)}` : null;
    if (a.canal === 'correo' && a.destinatario) {
      return `mailto:${encodeURIComponent(a.destinatario)}?subject=${encodeURIComponent(asunto || '')}&body=${encodeURIComponent(texto)}`;
    }
    if (a.canal === 'llamada' && a.telefono) return `tel:+${a.telefono}`;
    return null;
  }

  async function copiar(texto) {
    try { await navigator.clipboard.writeText(texto); return true; } catch (_) { return false; }
  }

  async function resolver(a, decision, contenido, extra = {}) {
    let ok = true;
    try {
      await api(`/api/acciones/${a.id}`, { method: 'POST', body: JSON.stringify({ decision, contenido, conversacion_id: convId, ...extra }) });
      aviso(decision !== 'enviar' ? 'Mensaje descartado.'
        : extra.via === 'gmail' ? 'Correo enviado desde tu Gmail. ADA hará el seguimiento.' : 'Listo, ADA hará el seguimiento.');
    } catch (e) {
      ok = false;
      aviso(extra.via === 'gmail' ? `No se pudo enviar: ${e.message}` : e.message, true);
    }
    cargarAutorizaciones();
    actualizarEstado();
    return ok;
  }

  function tarjetaAutorizacion(a) {
    const t = document.createElement('div');
    t.className = 'tarjeta';
    const para = a.contacto || a.destinatario || 'sin destinatario';
    t.innerHTML = `
      <div class="tarjeta-cab">
        <span><span class="tarjeta-canal"></span> → <strong class="para"></strong></span>
        <span class="enc"></span>
      </div>
      ${a.canal === 'correo' ? '<input class="asunto" placeholder="Asunto">' : ''}
      <textarea></textarea>
      <div class="tarjeta-botones">
        <button type="button" class="principal"></button>
        <button type="button" class="copiar">Copiar</button>
        <button type="button" class="descartar">Descartar</button>
      </div>`;
    t.querySelector('.tarjeta-canal').textContent = `Por autorizar · ${CANAL[a.canal] || a.canal}`;
    t.querySelector('.para').textContent = para;
    t.querySelector('.enc').textContent = a.encargo_id ? `Encargo #${a.encargo_id}` : '';
    const area = t.querySelector('textarea');
    area.value = a.contenido;
    const asunto = t.querySelector('.asunto');
    if (asunto) asunto.value = a.asunto || '';
    const principal = t.querySelector('.principal');
    const porGmail = !!a.gmail && (!!a.destinatario || !!a.responde_correo);
    const hayEnlace = !!enlace(a, a.contenido, a.asunto);
    principal.textContent = porGmail ? 'Enviar desde Gmail'
      : hayEnlace
        ? (a.canal === 'whatsapp' ? 'Enviar por WhatsApp' : a.canal === 'correo' ? 'Enviar por correo' : 'Llamar')
        : 'Copiar y marcar enviado';
    if (a.responde_correo) t.querySelector('.para').textContent = `${para} (respuesta)`;
    if (!porGmail && !hayEnlace && a.canal !== 'otro') {
      const av = document.createElement('div');
      av.className = 'tarjeta-aviso';
      av.textContent = `Falta el ${a.canal === 'correo' ? 'correo' : 'teléfono'} de ${para}. Díselo a ADA.`;
      t.appendChild(av);
    }
    principal.addEventListener('click', async () => {
      const texto = area.value;
      if (porGmail) {
        principal.disabled = true;
        principal.textContent = 'Enviando…';
        const ok = await resolver(a, 'enviar', texto, { via: 'gmail', asunto: asunto ? asunto.value : undefined });
        if (!ok) { principal.disabled = false; principal.textContent = 'Enviar desde Gmail'; }
        return;
      }
      const link = enlace(a, texto, asunto && asunto.value);
      if (link) {
        if (link.startsWith('http')) window.open(link, '_blank');
        else window.location.href = link;
      } else {
        await copiar(texto);
      }
      principal.disabled = true;
      resolver(a, 'enviar', texto);
    });
    t.querySelector('.copiar').addEventListener('click', async (ev) => {
      const ok = await copiar(area.value);
      ev.target.textContent = ok ? 'Copiado ✓' : 'No se pudo';
      setTimeout(() => { ev.target.textContent = 'Copiar'; }, 1800);
    });
    t.querySelector('.descartar').addEventListener('click', () => resolver(a, 'rechazar'));
    return t;
  }

  async function cargarAutorizaciones() {
    try { autorizaciones = await api('/api/autorizaciones'); } catch (_) { return; }
    pintarEntregas();
  }

  // ---------- Documento ----------
  let docAbierto = null;
  async function abrirDocumento(id) {
    try {
      docAbierto = await api(`/api/documentos/${id}`);
    } catch (e) {
      aviso(e.message, true);
      return;
    }
    $('#doc-titulo').textContent = docAbierto.titulo;
    $('#doc-cuerpo').innerHTML = md(docAbierto.contenido);
    $('#doc-compartir').hidden = !navigator.share;
    $('#doc').hidden = false;
  }
  $$('[data-cerrar-doc]').forEach((el) => el.addEventListener('click', () => { $('#doc').hidden = true; }));
  $('#doc-copiar').addEventListener('click', async () => {
    if (!docAbierto) return;
    aviso((await copiar(docAbierto.contenido)) ? 'Documento copiado' : 'No se pudo copiar', false);
  });
  $('#doc-compartir').addEventListener('click', () => {
    if (docAbierto && navigator.share) navigator.share({ title: docAbierto.titulo, text: docAbierto.contenido }).catch(() => {});
  });
  $('#doc-descargar').addEventListener('click', () => {
    if (!docAbierto) return;
    const blob = new Blob([`# ${docAbierto.titulo}\n\n${docAbierto.contenido}`], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${docAbierto.titulo.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'documento'}.md`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  // ---------- Voz de ADA ----------
  // Prioridad: voz neuronal del servidor (natural). Respaldo: voz del teléfono.
  const sintesis = window.speechSynthesis;
  const reproductor = new Audio();
  reproductor.preload = 'auto';
  let vozServidor = false;          // se activa si /api/ajustes informa un proveedor
  let fallosServidor = 0;

  // Limpia el texto para que suene bien: sin markdown y con los montos en pesos.
  function textoParaHablar(t) {
    return t
      .replace(/\*\*|__|`|#+\s*/g, '')
      .replace(/^\s*[-•*]\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/US\$\s?(\d{1,3}(?:[.,]\d{3})*(?:,\d+)?|\d+)(\s+mill(?:ón|ones))?/g, (m, n, mill) => `${n}${mill || ''} ${mill ? 'de ' : ''}dólares`)
      .replace(/\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+)(\s+mill(?:ón|ones))?(\s*CLP\b)?/g, (m, n, mill) => `${n}${mill || ''} ${mill ? 'de ' : ''}pesos`)
      .replace(/(\d)\s*CLP\b/g, '$1 pesos')
      .replace(/\bCLP\b/g, 'pesos')
      .replace(/✓/g, '')
      .replace(/\s*\n+\s*/g, '. ')
      .replace(/\.\s*\./g, '.')
      .trim();
  }

  function elegirVoz() {
    const voces = sintesis ? sintesis.getVoices() : [];
    const es = (v) => /^es([-_]|$)/i.test(v.lang);
    return voces.find((v) => /^es[-_]CL/i.test(v.lang))
      || voces.find((v) => /^es[-_](419|US|MX|AR|CO)/i.test(v.lang) && v.localService)
      || voces.find((v) => /^es[-_](419|US|MX|AR|CO)/i.test(v.lang))
      || voces.find((v) => es(v) && v.localService)
      || voces.find(es)
      || null;
  }

  let vocesEsperadas = false;
  function esperarVoces() {
    return new Promise((resolve) => {
      if (!sintesis || vocesEsperadas || sintesis.getVoices().length) { resolve(); return; }
      vocesEsperadas = true;
      const listo = () => { clearTimeout(t); sintesis.removeEventListener('voiceschanged', listo); resolve(); };
      const t = setTimeout(listo, 1500);
      sintesis.addEventListener('voiceschanged', listo);
    });
  }

  let avisoVozMostrado = false;
  function avisarFalloVoz(error) {
    if (avisoVozMostrado) return;
    avisoVozMostrado = true;
    const motivo = error === 'not-allowed'
      ? 'el navegador bloqueó el audio: toca la pantalla y vuelve a intentar'
      : error === 'language-unavailable' || error === 'voice-unavailable'
        ? 'tu teléfono no tiene voz en español (Ajustes → Texto a voz)'
        : `no se pudo reproducir la voz (${error})`;
    aviso(`ADA no pudo hablar: ${motivo}.`, true);
  }

  // Una frase con la voz del teléfono.
  function decirConNavegador(frase, cancelado) {
    return new Promise(async (resolve) => {
      if (!sintesis) { resolve(); return; }
      await esperarVoces();
      if (cancelado()) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(frase);
      const voz = elegirVoz();
      if (voz) u.voice = voz;
      u.lang = voz ? voz.lang : 'es-US';
      u.rate = 1.05;
      let listo = false;
      const fin = (error) => {
        if (listo) return;
        listo = true;
        clearTimeout(respaldo);
        clearInterval(despertador);
        if (error) avisarFalloVoz(error);
        resolve();
      };
      const respaldo = setTimeout(() => fin(), 3000 + frase.length * 110);
      const despertador = setInterval(() => {
        if (cancelado()) { sintesis.cancel(); fin(); }
        else if (sintesis.paused) sintesis.resume();
      }, 250);
      u.onend = () => fin();
      u.onerror = (e) => fin(e.error === 'interrupted' || e.error === 'canceled' ? null : (e.error || 'error'));
      sintesis.speak(u);
    });
  }

  // Pide el audio de una frase al servidor; devuelve una URL lista para reproducir o null.
  function pedirAudio(frase, señal) {
    return fetch('/api/voz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ texto: frase }),
      signal: señal,
    }).then(async (res) => {
      if (res.status === 204) { vozServidor = false; return null; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `voz ${res.status}`);
      fallosServidor = 0;
      return URL.createObjectURL(await res.blob());
    }).catch((e) => {
      if (e.name === 'AbortError') return null;
      fallosServidor += 1;
      if (fallosServidor >= 2) {
        vozServidor = false;
        aviso('La voz natural falló; ADA usará la voz del teléfono por ahora.', true);
        console.warn('Voz servidor:', e.message);
      }
      return null;
    });
  }

  function reproducir(url, cancelado) {
    return new Promise((resolve) => {
      let listo = false;
      const fin = () => {
        if (listo) return;
        listo = true;
        clearInterval(vigia);
        reproductor.onended = reproductor.onerror = null;
        resolve();
      };
      const vigia = setInterval(() => { if (cancelado()) { reproductor.pause(); fin(); } }, 100);
      reproductor.onended = fin;
      reproductor.onerror = fin;
      reproductor.src = url;
      reproductor.play().catch((e) => { if (e.name === 'NotAllowedError') avisarFalloVoz('not-allowed'); fin(); });
    });
  }

  // El locutor recibe frases a medida que llegan, precarga el audio y las dice en orden.
  // detener() la calla de inmediato (para interrumpir).
  let locutorActual = null;
  function crearLocutor({ alEmpezar, antes } = {}) {
    const cola = [];
    let cerrado = false;
    let detenido = false;
    let trabajando = false;
    let empezo = false;
    let resolverFin;
    const fin = new Promise((r) => { resolverFin = r; });
    const control = new AbortController();
    const cancelado = () => detenido;

    async function bombear() {
      if (trabajando) return;
      trabajando = true;
      if (antes) { await antes; antes = null; }
      while (cola.length && !detenido) {
        const item = cola.shift();
        if (!empezo) { empezo = true; if (alEmpezar) alEmpezar(); }
        const url = item.audio ? await item.audio : null;
        if (detenido) { if (url) URL.revokeObjectURL(url); break; }
        if (url) { await reproducir(url, cancelado); URL.revokeObjectURL(url); }
        else await decirConNavegador(item.frase, cancelado);
      }
      trabajando = false;
      if (detenido || (cerrado && !cola.length)) resolverFin();
    }

    const locutor = {
      decir(texto) {
        if (detenido || silenciada) return;
        const frase = textoParaHablar(texto);
        if (!frase || !/[\p{L}\p{N}]/u.test(frase)) return;
        cola.push({ frase, audio: vozServidor ? pedirAudio(frase, control.signal) : null });
        bombear();
      },
      cerrar() {
        cerrado = true;
        if (!trabajando && !cola.length) resolverFin();
      },
      detener() {
        if (detenido) return;
        detenido = true;
        cola.length = 0;
        control.abort();
        reproductor.pause();
        if (sintesis) sintesis.cancel();
        resolverFin();
      },
      get hablando() { return empezo && !detenido; },
      fin,
    };
    locutorActual = locutor;
    fin.then(() => { if (locutorActual === locutor) locutorActual = null; });
    return locutor;
  }

  function detenerHabla() {
    if (locutorActual) locutorActual.detener();
    if (sintesis) sintesis.cancel();
    reproductor.pause();
  }

  // iOS y Android solo permiten sonido después de un toque: se "despierta" el audio en el primer toque.
  let vozDesbloqueada = false;
  const SILENCIO_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  function desbloquearVoz() {
    if (vozDesbloqueada) return;
    vozDesbloqueada = true;
    try { reproductor.src = SILENCIO_WAV; reproductor.play().catch(() => {}); } catch (_) {}
    try { reproductorAcuse.src = SILENCIO_WAV; reproductorAcuse.play().catch(() => {}); } catch (_) {}
    if (sintesis) {
      sintesis.getVoices();
      const u = new SpeechSynthesisUtterance('.');
      u.volume = 0;
      u.rate = 2;
      sintesis.speak(u);
    }
  }
  document.addEventListener('pointerdown', desbloquearVoz, { once: true, capture: true });

  // Divide el texto que va llegando en frases completas para empezar a hablar cuanto antes.
  function crearCortador(alFrase) {
    let buffer = '';
    const corte = /^([\s\S]*?[.!?…:;](?=\s)|[\s\S]*?\n)\s*/;
    return {
      agregar(delta) {
        buffer += delta;
        // La primera vez, corta en una coma para empezar a hablar antes.
        if (!this.yaHablo) {
          const c = buffer.match(/^([\s\S]{28,}?[,;:])\s/);
          if (c && !/[.!?…](?=\s)/.test(c[1])) {
            buffer = buffer.slice(c[0].length);
            alFrase(c[1].trim());
            this.yaHablo = true;
          }
        }
        let m;
        while ((m = buffer.match(corte))) {
          const frase = m[1].trim();
          // Junta frases muy cortas con la siguiente, salvo la primera (para empezar rápido).
          if (frase.length < 12 && buffer.length - m[0].length < 40 && this.yaHablo) break;
          buffer = buffer.slice(m[0].length);
          if (frase) { alFrase(frase); this.yaHablo = true; }
        }
      },
      terminar() {
        const resto = buffer.trim();
        buffer = '';
        if (resto) alFrase(resto);
      },
      yaHablo: false,
    };
  }

  // ---------- Interrumpir hablando ----------
  // Mientras ADA habla, escucha el micrófono (con cancelación de eco). Si detecta tu voz, se calla.
  let interrumpirHablando = true;
  try { interrumpirHablando = localStorage.getItem('ada_interrumpir') !== '0'; } catch (_) {}

  async function vigilarInterrupcion(alDetectar) {
    if (!interrumpirHablando || !navigator.mediaDevices || !window.AudioContext && !window.webkitAudioContext) return () => {};
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    } catch (_) {
      return () => {};
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const fuente = ctx.createMediaStreamSource(stream);
    const analizador = ctx.createAnalyser();
    analizador.fftSize = 1024;
    fuente.connect(analizador);
    const datos = new Float32Array(analizador.fftSize);
    let base = 0;
    let muestras = 0;
    let activo = 0;
    let terminado = false;
    const inicio = performance.now();
    const intervalo = setInterval(() => {
      analizador.getFloatTimeDomainData(datos);
      let suma = 0;
      for (const v of datos) suma += v * v;
      const rms = Math.sqrt(suma / datos.length);
      if (performance.now() - inicio < 500) { base += rms; muestras += 1; return; } // calibra con el eco de ADA
      const umbral = Math.max(0.035, (base / Math.max(1, muestras)) * 3);
      activo = rms > umbral ? activo + 1 : Math.max(0, activo - 1);
      if (activo >= 6) { parar(); alDetectar(); } // ~300 ms de voz sostenida
    }, 50);
    function parar() {
      if (terminado) return;
      terminado = true;
      clearInterval(intervalo);
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    }
    return parar;
  }

  // ---------- Acuse inmediato ----------
  // Apenas Cristian termina de hablar, ADA dice algo breve ("Mmm", "Ya") mientras piensa la respuesta.
  const TEXTOS_ACUSE = ['Mmm.', 'Ya.', 'A ver.', 'Ajá.', 'Ya, ya.'];
  const reproductorAcuse = new Audio();
  let acuses = [];
  let ultimoAcuse = null;

  async function prepararAcuses() {
    acuses.forEach((a) => URL.revokeObjectURL(a.url));
    acuses = [];
    if (!vozServidor) return;
    for (const texto of TEXTOS_ACUSE) {
      const url = await pedirAudio(texto);
      if (url) acuses.push({ texto: texto.replace(/\.$/, ''), url });
    }
  }

  // Devuelve { texto, termino } o null si esta vez no corresponde.
  function decirAcuse() {
    if (!acuses.length || silenciada || Math.random() > 0.75) return null;
    const opciones = acuses.filter((a) => a !== ultimoAcuse);
    const a = opciones[Math.floor(Math.random() * opciones.length)];
    ultimoAcuse = a;
    const termino = new Promise((ok) => {
      const fin = () => { reproductorAcuse.onended = reproductorAcuse.onerror = null; ok(); };
      reproductorAcuse.onended = fin;
      reproductorAcuse.onerror = fin;
      reproductorAcuse.src = a.url;
      reproductorAcuse.play().catch(fin);
      setTimeout(fin, 2000);
    });
    return { texto: a.texto, termino };
  }

  // ---------- Hablar con el servidor (en tiempo real) ----------
  // Lee la respuesta como un flujo de eventos: texto a medida que se escribe, estados y documentos.
  async function leerFlujo(res, alEvento) {
    const lector = res.body.getReader();
    const decodificador = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      buffer += decodificador.decode(value, { stream: true });
      let corte;
      while ((corte = buffer.indexOf('\n\n')) >= 0) {
        const bloque = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        let tipo = 'message';
        let datos = '';
        for (const linea of bloque.split('\n')) {
          if (linea.startsWith('event: ')) tipo = linea.slice(7).trim();
          else if (linea.startsWith('data: ')) datos += linea.slice(6);
        }
        if (datos) alEvento(tipo, JSON.parse(datos));
      }
    }
  }

  async function enviar(texto, opciones = {}) {
    texto = (texto || '').trim();
    if (!texto || ocupado) return null;
    ocupado = true;
    pintarControles();
    mostrarYo(opciones.mostrar || texto);
    mostrarAda('');
    setFase('pensando');

    const hablar = !silenciada;
    const locutor = hablar ? crearLocutor({ alEmpezar: () => setFase('hablando'), antes: opciones.antes }) : null;
    const cortador = crearCortador((frase) => locutor && locutor.decir(frase));
    let acumulado = '';
    let resultado = null;
    let errorFlujo = null;

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mensaje: texto, voz: !!opciones.voz, acuse: opciones.acuse || null, conversacion_id: convId }),
      });
      if (res.status === 401) { salir(); throw new Error('Sesión expirada'); }
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
      await leerFlujo(res, (tipo, d) => {
        if (tipo === 'conversacion') {
          if (d.conversacion_id !== convId) { docsActuales = []; archivosActuales = []; pintarEntregas(); }
          guardarConv(d.conversacion_id);
        } else if (tipo === 'texto') {
          acumulado += d.delta;
          mostrarAda(acumulado);
          cortador.agregar(d.delta);
        } else if (tipo === 'estado') {
          if (!locutor || !locutor.hablando) setFase('pensando', d.texto);
        } else if (tipo === 'documento') {
          docsActuales.push(d);
          pintarEntregas();
        } else if (tipo === 'archivo') {
          archivosActuales.push(d);
          pintarEntregas();
        } else if (tipo === 'fin') {
          resultado = d;
        } else if (tipo === 'error') {
          errorFlujo = d.error;
        }
      });
      if (errorFlujo) throw new Error(errorFlujo);
      if (!resultado) throw new Error('La respuesta se cortó');
      cortador.terminar();
      if (locutor) locutor.cerrar();
      mostrarAda(resultado.respuesta);
      if (resultado.documentos && resultado.documentos.length && !opciones.voz) {
        abrirDocumento(resultado.documentos[resultado.documentos.length - 1].id);
      }
      actualizarEstado();
      if ((resultado.acciones || []).some((x) => x.herramienta === 'proponer_mensaje')) cargarAutorizaciones();
      return { respuesta: resultado.respuesta, locutor };
    } catch (e) {
      if (locutor) locutor.detener();
      aviso(`${e.message}. Inténtalo de nuevo.`, true);
      return null;
    } finally {
      ocupado = false;
      pintarControles();
      if (!conversando) {
        if (locutor) {
          locutor.fin.then(() => { if (!conversando && !ocupado) setFase('reposo'); });
        } else {
          setFase('reposo');
        }
      }
    }
  }

  // ---------- Silenciar ----------
  let silenciada = false;
  try { silenciada = localStorage.getItem('ada_silencio') === '1'; } catch (_) {}
  const btnSilencio = $('#silencio');
  function pintarSilencio() {
    btnSilencio.setAttribute('aria-pressed', silenciada ? 'true' : 'false');
    btnSilencio.title = silenciada ? 'ADA está en silencio: toca para que hable' : 'Silenciar a ADA';
  }
  pintarSilencio();
  btnSilencio.addEventListener('click', () => {
    silenciada = !silenciada;
    try { localStorage.setItem('ada_silencio', silenciada ? '1' : '0'); } catch (_) {}
    pintarSilencio();
    if (silenciada) { detenerHabla(); if (!conversando && !ocupado) setFase('reposo'); }
    aviso(silenciada ? 'ADA en silencio: solo responde escrito.' : 'ADA vuelve a hablar.');
  });

  // ---------- Conversación por voz ----------
  const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SILENCIO_MS = 1300;
  const DESPEDIDA = /\b(chao|chau|adi[oó]s|hasta luego|nos vemos|eso es todo|terminamos|termina la conversaci[oó]n)\b/i;

  let conversando = false;
  let rec = null;
  let textoFinal = '';
  let textoParcial = '';
  let timerSilencio = null;
  let silenciosSeguidos = 0;

  const textoActual = () => (textoFinal + ' ' + textoParcial).replace(/\s+/g, ' ').trim();

  // Algunos teléfonos entregan cada frase acumulada ("hola", "hola Ada", "hola Ada cómo estás"):
  // si una frase contiene a la anterior, se queda solo con la más completa.
  function quitarRepeticiones(frases) {
    const out = [];
    for (const f of frases) {
      if (!f) continue;
      const prev = out[out.length - 1];
      const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
      if (prev && norm(f).startsWith(norm(prev))) out[out.length - 1] = f;
      else if (prev && norm(prev).startsWith(norm(f))) continue;
      else out.push(f);
    }
    return out.join(' ');
  }

  function iniciarConversacion() {
    if (ocupado || conversando) return;
    desbloquearVoz();
    if (!Reconocimiento) {
      aviso('Este navegador no permite conversar por voz. Usa Chrome o Safari, o escríbele.', true);
      mostrarTeclado(true);
      return;
    }
    detenerHabla();
    conversando = true;
    silenciosSeguidos = 0;
    pintarControles();
    escucharTurno();
  }

  function detenerVoz() {
    conversando = false;
    clearTimeout(timerSilencio);
    if (rec) { try { rec.abort(); } catch (_) {} rec = null; }
    detenerHabla();
    if (!ocupado) setFase('reposo');
    pintarControles();
  }

  // Termina la conversación: la guarda en el archivo con título y carpeta.
  async function cerrarConversacion() {
    detenerVoz();
    if (!convId) return;
    const id = convId;
    guardarConv(null);
    docsActuales = [];
    archivosActuales = [];
    pintarEntregas();
    mostrarYo('');
    mostrarAda('');
    setFase('reposo', 'Guardando la conversación…');
    try {
      const r = await api(`/api/conversaciones/${id}/cerrar`, { method: 'POST' });
      if (r.conversacion) aviso(`Guardada: ${r.conversacion.titulo}${r.conversacion.proyecto ? ` · ${r.conversacion.proyecto}` : ''}`);
    } catch (_) {
      aviso('La conversación quedó guardada en el archivo.');
    }
    setFase('reposo');
  }

  function escucharTurno() {
    if (!conversando) return;
    textoFinal = '';
    textoParcial = '';
    setFase('escuchando');
    rec = new Reconocimiento();
    rec.lang = 'es-CL';
    rec.interimResults = true;
    // Modo no continuo: el navegador corta solo al detectar la pausa. En Android el modo
    // continuo reenvía lo ya dicho en cada resultado y duplica las palabras.
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const finales = [];
      let parcial = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finales.push(r[0].transcript.trim());
        else parcial = r[0].transcript.trim();
      }
      textoFinal = quitarRepeticiones(finales);
      textoParcial = parcial && !textoFinal.endsWith(parcial) ? parcial : '';
      mostrarYo(textoActual());
      clearTimeout(timerSilencio);
      timerSilencio = setTimeout(() => { if (rec) rec.stop(); }, SILENCIO_MS);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        aviso('ADA no tiene permiso para usar el micrófono. Actívalo en los ajustes del navegador.', true);
        detenerVoz();
      }
    };
    rec.onend = () => {
      clearTimeout(timerSilencio);
      rec = null;
      if (!conversando) return;
      const t = textoActual();
      if (!t) {
        silenciosSeguidos += 1;
        if (silenciosSeguidos >= 3) { detenerVoz(); setFase('reposo', 'Te dejo tranquilo. Toca para seguir hablando.'); return; }
        escucharTurno();
        return;
      }
      silenciosSeguidos = 0;
      turnoDeAda(t);
    };
    try { rec.start(); } catch (_) { detenerVoz(); }
  }

  async function turnoDeAda(texto) {
    setFase('pensando');
    const acuse = decirAcuse();
    const r = await enviar(texto, { voz: true, acuse: acuse && acuse.texto, antes: acuse && acuse.termino });
    if (!conversando) return;
    if (!r) { detenerVoz(); return; }
    if (r.locutor) {
      // Mientras ADA habla, si Cristian habla encima, ella se calla y lo escucha.
      let pararVigia = () => {};
      const empezarVigia = async () => {
        pararVigia = await vigilarInterrupcion(() => { if (r.locutor) r.locutor.detener(); });
      };
      if (r.locutor.hablando) empezarVigia();
      else r.locutor.fin.then(() => {}); // si aún no empieza, igual espera el final
      const vigiaTardio = setInterval(() => { if (r.locutor.hablando) { clearInterval(vigiaTardio); empezarVigia(); } }, 150);
      await r.locutor.fin;
      clearInterval(vigiaTardio);
      pararVigia();
      await new Promise((ok) => setTimeout(ok, 150)); // libera el micrófono antes de volver a escuchar
    }
    if (!conversando) return;
    if (DESPEDIDA.test(texto)) { cerrarConversacion(); return; }
    escucharTurno();
  }

  // ---------- Controles ----------
  const btnHablar = $('#hablar');

  function pintarControles() {
    btnHablar.classList.toggle('activo', conversando);
    $('#hablar-texto').textContent = conversando ? 'Terminar conversación' : (convId ? 'Seguir hablando' : 'Hablar con ADA');
    btnHablar.disabled = ocupado && !conversando;
    $('#enviar').disabled = ocupado;
    $('#cerrar-conv').hidden = conversando || !convId;
  }

  btnHablar.addEventListener('click', () => {
    if (conversando) cerrarConversacion();
    else iniciarConversacion();
  });

  // Tocar cualquier parte del escenario mientras ADA habla la hace callar.
  $('.escenario').addEventListener('click', (e) => {
    if (orbe.dataset.fase === 'hablando' && e.target.id !== 'cerrar-conv') detenerHabla();
  });
  orbe.addEventListener('click', () => {
    const fase = orbe.dataset.fase;
    if (fase === 'hablando') return;                            // ya lo maneja el escenario
    if (fase === 'escuchando') { if (rec) rec.stop(); return; } // ya terminé de hablar
    if (fase === 'reposo') iniciarConversacion();
  });

  // Botón pequeño para guardar una conversación de texto
  const cerrarBtn = document.createElement('button');
  cerrarBtn.id = 'cerrar-conv';
  cerrarBtn.type = 'button';
  cerrarBtn.className = 'cerrar-conv';
  cerrarBtn.textContent = 'Terminar y guardar esta conversación';
  cerrarBtn.hidden = true;
  cerrarBtn.addEventListener('click', cerrarConversacion);
  $('.escenario').appendChild(cerrarBtn);

  // Teclado (secundario)
  const input = $('#mensaje');
  function mostrarTeclado(mostrar) {
    const form = $('#form');
    form.hidden = mostrar === undefined ? !form.hidden : !mostrar;
    $('#teclado').setAttribute('aria-pressed', form.hidden ? 'false' : 'true');
    if (!form.hidden) input.focus();
  }
  $('#teclado').addEventListener('click', () => mostrarTeclado());

  function ajustar() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }
  $('#form').addEventListener('submit', (e) => {
    e.preventDefault();
    desbloquearVoz();
    const t = input.value;
    input.value = '';
    ajustar();
    enviar(t);
  });
  input.addEventListener('input', ajustar);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      $('#form').requestSubmit();
    }
  });

  $$('.atajos button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.accion === 'foco') return abrirHoja();
      enviar(b.dataset.texto);
    });
  });

  // ---------- Estado (barra superior) ----------
  function corto(d) {
    if (!d) return '';
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}) \((\S+)/u);
    if (!m) return d;
    const hoy = new Date();
    const f = new Date(+m[1], +m[2] - 1, +m[3]);
    const dif = Math.round((f - new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())) / 86400000);
    const dia = dif === 0 ? 'hoy' : dif === 1 ? 'mañana' : dif === -1 ? 'ayer' : m[5].slice(0, 3);
    return `${dia} ${m[4]}`;
  }

  async function actualizarEstado() {
    try {
      const e = await api('/api/estado');
      proyectos = e.proyectos || [];
      const cont = $('#estado');
      cont.innerHTML = '';
      const pill = (texto, clase) => {
        const s = document.createElement('span');
        s.className = `pastilla ${clase || ''}`;
        s.textContent = texto;
        cont.appendChild(s);
      };
      if (e.por_autorizar) pill(`${e.por_autorizar} por autorizar`, 'autorizar');
      if (e.foco) pill(`● ${e.foco.proyecto || e.foco.descripcion} · ${e.foco.minutos} min`, 'foco');
      for (const u of (e.urgentes || []).slice(0, 3)) {
        pill(`${u.vencido ? 'Vencido' : corto(u.fecha_limite)} · ${u.texto}`, u.vencido ? 'vencido' : 'urgente');
      }
      if (e.encargos_activos) {
        pill(`${e.encargos_activos} encargo${e.encargos_activos > 1 ? 's' : ''}${e.encargos_por_revisar ? ` · ${e.encargos_por_revisar} por revisar` : ''}`,
          e.encargos_por_revisar ? 'urgente' : 'encargos');
      }
    } catch (_) {}
  }

  // ---------- Selector de proyecto (Estoy con…) ----------
  function abrirHoja() {
    const cont = $('#hoja-proyectos');
    cont.innerHTML = '';
    for (const p of proyectos) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p;
      b.addEventListener('click', () => { cerrarHoja(); enviar(`Estoy con ${p}.`); });
      cont.appendChild(b);
    }
    const otro = document.createElement('button');
    otro.type = 'button';
    otro.textContent = 'Otra cosa…';
    otro.addEventListener('click', () => { cerrarHoja(); mostrarTeclado(true); input.value = 'Estoy con '; ajustar(); });
    cont.appendChild(otro);
    $('#hoja').hidden = false;
  }
  function cerrarHoja() { $('#hoja').hidden = true; }
  $$('[data-cerrar]').forEach((el) => el.addEventListener('click', cerrarHoja));

  // ---------- Archivo ----------
  let carpetaActiva = '';
  let timerBuscar = null;

  function abrirPanel(id) { $(id).hidden = false; }
  $$('[data-volver]').forEach((b) => b.addEventListener('click', () => { b.closest('.panel').hidden = true; }));

  async function abrirArchivo() {
    abrirPanel('#vista-archivo');
    await pintarCarpetas();
    await pintarLista();
  }
  $('#abrir-archivo').addEventListener('click', abrirArchivo);

  async function pintarCarpetas() {
    let c;
    try { c = await api('/api/carpetas'); } catch (e) { aviso(e.message, true); return; }
    const cont = $('#carpetas');
    cont.innerHTML = '';
    const chip = (valor, nombre, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'tab';
      b.className = 'carpeta';
      b.setAttribute('aria-selected', carpetaActiva === valor ? 'true' : 'false');
      b.innerHTML = `<span></span><b>${n}</b>`;
      b.querySelector('span').textContent = nombre;
      b.addEventListener('click', () => { carpetaActiva = valor; pintarCarpetas(); pintarLista(); });
      cont.appendChild(b);
    };
    chip('', 'Todas', c.total);
    for (const p of c.proyectos) chip(String(p.id), p.nombre, p.n);
    if (c.general) chip('general', 'General', c.general);
  }

  async function pintarLista() {
    const cont = $('#lista-conversaciones');
    const params = new URLSearchParams();
    if (carpetaActiva) params.set('proyecto', carpetaActiva);
    const qText = $('#buscar').value.trim();
    if (qText) params.set('q', qText);
    let lista = [];
    try { lista = await api(`/api/conversaciones?${params}`); } catch (e) { aviso(e.message, true); return; }
    cont.innerHTML = '';
    if (!lista.length) {
      cont.innerHTML = '<p class="vacio-lista">Todavía no hay conversaciones aquí.</p>';
      return;
    }
    for (const c of lista) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item-conv';
      b.innerHTML = `
        <span class="item-icono" aria-hidden="true"></span>
        <span class="item-texto"><strong></strong><small class="item-resumen"></small><small class="item-meta"></small></span>`;
      b.querySelector('.item-icono').textContent = c.modo === 'voz' ? '🎙' : '💬';
      b.querySelector('strong').textContent = c.titulo;
      b.querySelector('.item-resumen').textContent = c.resumen || '';
      const meta = [fechaCorta(c.inicio)];
      if (c.fin) meta.push(duracion(c.inicio, c.fin));
      if (c.abierta) meta.push('en curso');
      if (c.n_documentos) meta.push(`${c.n_documentos} doc.`);
      if (c.proyecto && !carpetaActiva) meta.push(c.proyecto);
      b.querySelector('.item-meta').textContent = meta.join(' · ');
      b.addEventListener('click', () => abrirDetalle(c.id));
      cont.appendChild(b);
    }
  }

  $('#buscar').addEventListener('input', () => {
    clearTimeout(timerBuscar);
    timerBuscar = setTimeout(pintarLista, 300);
  });

  async function abrirDetalle(id) {
    let d;
    try { d = await api(`/api/conversaciones/${id}`); } catch (e) { aviso(e.message, true); return; }
    const c = d.conversacion;
    $('#detalle-titulo').textContent = c.titulo;
    const meta = [fechaCorta(c.inicio)];
    if (c.fin) meta.push(duracion(c.inicio, c.fin));
    meta.push(c.modo === 'voz' ? 'por voz' : 'por texto');
    meta.push(c.proyecto || 'General');
    $('#detalle-meta').textContent = meta.join(' · ');
    $('#detalle-resumen').textContent = c.resumen || '';
    $('#detalle-resumen').hidden = !c.resumen;

    const docs = $('#detalle-documentos');
    docs.innerHTML = '';
    for (const doc of d.documentos) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'entrega-doc';
      b.innerHTML = `${ICONO_DOC}<span><small>Documento</small><strong></strong></span><em>Abrir</em>`;
      b.querySelector('strong').textContent = doc.titulo;
      b.addEventListener('click', () => abrirDocumento(doc.id));
      docs.appendChild(b);
    }

    for (const a of d.archivos || []) docs.appendChild(tarjetaArchivo(a));

    const cont = $('#detalle-mensajes');
    cont.innerHTML = '';
    for (const m of d.mensajes) {
      const div = document.createElement('div');
      div.className = `msg ${m.rol}`;
      if (m.rol === 'assistant') div.innerHTML = md(m.contenido);
      else div.textContent = m.contenido.replace(/^\[Desde botón\]\s*/, '');
      cont.appendChild(div);
    }

    const pie = $('#detalle-pie');
    pie.innerHTML = '';
    if (c.abierta && c.id === convId) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'principal';
      b.textContent = 'Volver a la conversación';
      b.addEventListener('click', () => { $('#vista-detalle').hidden = true; $('#vista-archivo').hidden = true; });
      pie.appendChild(b);
    } else {
      const label = document.createElement('label');
      label.className = 'mover';
      label.innerHTML = '<span>Carpeta</span><select></select>';
      const sel = label.querySelector('select');
      const opciones = ['General', ...proyectos];
      for (const nombre of opciones) {
        const o = document.createElement('option');
        o.value = nombre === 'General' ? '' : nombre;
        o.textContent = nombre;
        if ((c.proyecto || '') === o.value) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', async () => {
        try {
          await api(`/api/conversaciones/${c.id}/proyecto`, { method: 'POST', body: JSON.stringify({ proyecto: sel.value || null }) });
          aviso(`Movida a ${sel.value || 'General'}`);
          if (!$('#vista-archivo').hidden) { pintarCarpetas(); pintarLista(); }
        } catch (e) { aviso(e.message, true); }
      });
      pie.appendChild(label);
    }
    abrirPanel('#vista-detalle');
    cont.lastElementChild && cont.lastElementChild.scrollIntoView({ block: 'end' });
  }

  $('#ver-transcripcion').addEventListener('click', () => {
    if (convId) abrirDetalle(convId);
    else abrirArchivo();
  });

  // ---------- Ajustes ----------
  const NOMBRE_VOZ = {
    google: 'Voz natural de Google ✓',
    elevenlabs: 'Voz natural de ElevenLabs ✓',
    openai: 'Voz natural de OpenAI ✓',
    navegador: 'Voz del teléfono (robótica). Para una voz natural, configura una clave de voz en Railway.',
  };

  async function cargarAjustes() {
    try {
      const a = await api('/api/ajustes');
      const antes = vozServidor;
      vozServidor = a.voz.proveedor !== 'navegador';
      if (vozServidor && (!antes || !acuses.length)) prepararAcuses();
      return a;
    } catch (_) {
      return null;
    }
  }

  function botonConectar(texto) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'principal';
    b.textContent = texto;
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Abriendo Google…';
      try {
        const r = await api('/api/google/enlace', { method: 'POST' });
        // Respaldo: si el navegador no navega solo, queda un enlace para tocar.
        const manual = document.createElement('a');
        manual.className = 'enlace-manual';
        manual.href = r.url;
        manual.textContent = 'Si no se abre Google, toca aquí';
        b.parentNode.appendChild(manual);
        window.location.assign(r.url);
      } catch (e) {
        aviso(`No se pudo iniciar la conexión: ${e.message}`, true);
        b.disabled = false;
        b.textContent = texto;
      }
    });
    return b;
  }

  async function abrirAjustes() {
    abrirPanel('#vista-ajustes');
    $('#op-interrumpir').checked = interrumpirHablando;
    const a = await cargarAjustes();
    if (!a) return;
    const g = a.google;
    const estado = $('#google-estado');
    const acciones = $('#google-acciones');
    const ayuda = $('#google-ayuda');
    acciones.innerHTML = '';
    ayuda.hidden = true;
    if (!g.configurado) {
      estado.textContent = 'Falta configurarlo en el servidor.';
      ayuda.hidden = false;
      ayuda.innerHTML = `En Railway agrega <b>GOOGLE_CLIENT_ID</b> y <b>GOOGLE_CLIENT_SECRET</b>. En Google Cloud, la URI de redirección autorizada debe ser:<code></code>`;
      ayuda.querySelector('code').textContent = g.redirect_uri;
    } else if (g.conectado) {
      estado.innerHTML = '<span class="estado-ok">Conectado</span>';
      if (g.cuenta) estado.append(` · ${g.cuenta}`);
      const faltaGmail = (g.faltan_permisos || []).some((p) => p.startsWith('gmail'));
      if (faltaGmail) {
        ayuda.hidden = false;
        ayuda.textContent = 'Falta darle acceso a tu correo. Reconecta y acepta los permisos de Gmail.';
        acciones.appendChild(botonConectar('Reconectar para dar acceso a Gmail'));
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Desconectar';
      b.addEventListener('click', async () => {
        await api('/api/google/desconectar', { method: 'POST' }).catch(() => {});
        aviso('Google desconectado.');
        abrirAjustes();
      });
      acciones.appendChild(b);
    } else {
      estado.textContent = 'No conectado.';
      acciones.appendChild(botonConectar('Conectar Google (Calendar, Drive y Gmail)'));
    }
    $('#voz-estado').textContent = NOMBRE_VOZ[a.voz.proveedor] || a.voz.proveedor;
    pintarVoces();
    $('#ia-estado').textContent = `Modelo: ${a.modelo} · Búsqueda en internet: ${a.internet ? 'activa ✓' : 'desactivada'}`;
  }

  // Elegir voz: escuchar cada una y dejar la que guste.
  const MUESTRA_VOZ = 'Hola Cristian, soy ADA. ¿En qué te ayudo hoy?';

  async function probarVoz(nombre, boton) {
    desbloquearVoz();
    detenerHabla();
    const texto = boton.textContent;
    boton.textContent = '…';
    try {
      const res = await fetch('/api/voz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: MUESTRA_VOZ, voz: nombre }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      boton.textContent = '■';
      await reproducir(url, () => false);
      URL.revokeObjectURL(url);
    } catch (e) {
      aviso(`No se pudo probar la voz: ${e.message}`, true);
    }
    boton.textContent = texto;
  }

  // En Ajustes solo se muestra la voz actual; la lista completa se abre en una hoja encima.
  let datosVoces = null;
  let filtroGenero = 'todas';

  async function pintarVoces() {
    const cont = $('#voces');
    cont.innerHTML = '';
    try { datosVoces = await api('/api/voces'); } catch (e) { return; }
    if (!datosVoces.voces.length) return;
    const actual = datosVoces.voces.find((v) => v.nombre === datosVoces.actual);
    const fila = document.createElement('div');
    fila.className = 'voz actual';
    fila.innerHTML = '<span class="voz-nombre"><small>Voz actual</small><strong></strong></span><button type="button" class="probar" aria-label="Escuchar">▶</button><button type="button" class="usar">Cambiar voz</button>';
    fila.querySelector('strong').textContent = actual ? `${actual.etiqueta} · ${actual.genero.toLowerCase()}` : datosVoces.actual;
    fila.querySelector('.probar').addEventListener('click', (e) => probarVoz(datosVoces.actual, e.currentTarget));
    fila.querySelector('.usar').addEventListener('click', abrirSelectorVoces);
    cont.appendChild(fila);
  }

  function abrirSelectorVoces() {
    pintarSelectorVoces();
    $('#hoja-voces').hidden = false;
  }
  function cerrarSelectorVoces() {
    $('#hoja-voces').hidden = true;
    detenerHabla();
  }
  $$('[data-cerrar-voces]').forEach((el) => el.addEventListener('click', cerrarSelectorVoces));
  $$('#filtro-voces button').forEach((b) => b.addEventListener('click', () => {
    filtroGenero = b.dataset.filtro;
    pintarSelectorVoces();
  }));
  $('#voces-espana').addEventListener('change', pintarSelectorVoces);

  function pintarSelectorVoces() {
    if (!datosVoces) return;
    $$('#filtro-voces button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.filtro === filtroGenero ? 'true' : 'false'));
    const conEspana = $('#voces-espana').checked;
    const lista = datosVoces.voces.filter((v) =>
      (conEspana || v.idioma === 'Latinoamérica')
      && (filtroGenero === 'todas' || (filtroGenero === 'f' ? v.genero === 'Femenina' : v.genero === 'Masculina')));
    const cont = $('#lista-voces');
    cont.innerHTML = '';
    for (const v of lista) {
      const fila = document.createElement('div');
      fila.className = `voz-fila${v.nombre === datosVoces.actual ? ' actual' : ''}`;
      fila.innerHTML = '<button type="button" class="voz-play" aria-label="Escuchar">▶</button><span class="voz-nombre"><strong></strong><small></small></span>';
      fila.querySelector('strong').textContent = v.etiqueta;
      fila.querySelector('small').textContent = [v.genero, v.idioma === 'España' ? 'España' : '', v.linea !== 'Chirp 3 HD' ? v.linea : ''].filter(Boolean).join(' · ');
      fila.querySelector('.voz-play').addEventListener('click', (e) => probarVoz(v.nombre, e.currentTarget));
      if (v.nombre === datosVoces.actual) {
        const s = document.createElement('span');
        s.className = 'en-uso';
        s.textContent = 'En uso ✓';
        fila.appendChild(s);
      } else {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'usar';
        b.textContent = 'Usar';
        b.addEventListener('click', async () => {
          try {
            await api('/api/voces', { method: 'POST', body: JSON.stringify({ voz: v.nombre }) });
            datosVoces.actual = v.nombre;
            aviso(`ADA ahora habla con la voz ${v.etiqueta}.`);
            pintarSelectorVoces();
            pintarVoces();
            prepararAcuses();
          } catch (e) { aviso(e.message, true); }
        });
        fila.appendChild(b);
      }
      cont.appendChild(fila);
    }
    if (!lista.length) cont.innerHTML = '<p class="vacio-lista">No hay voces con ese filtro.</p>';
  }

  $('#abrir-ajustes').addEventListener('click', abrirAjustes);
  $('#op-interrumpir').addEventListener('change', (e) => {
    interrumpirHablando = e.target.checked;
    try { localStorage.setItem('ada_interrumpir', interrumpirHablando ? '1' : '0'); } catch (_) {}
  });
  $('#cerrar-sesion').addEventListener('click', () => { $('#vista-ajustes').hidden = true; salir(); });

  // Vuelta desde Google después de autorizar.
  function revisarRetornoGoogle() {
    const p = new URLSearchParams(window.location.search);
    if (!p.has('google')) return;
    if (p.get('google') === 'ok') aviso('Google conectado. ADA ya puede ver tu agenda, tu Drive y tu correo.');
    else aviso(`No se pudo conectar Google: ${p.get('motivo') || 'error'}`, true);
    history.replaceState(null, '', '/');
  }

  // ---------- Compartido desde WhatsApp u otra app ----------
  const MAX_COMPARTIDO = 20000;
  let compartido = null;

  async function revisarCompartido() {
    const p = new URLSearchParams(window.location.search);
    if (!p.has('compartido')) return;
    history.replaceState(null, '', '/');
    if (p.get('compartido') === '0' || !('caches' in window)) {
      aviso('No alcancé a recibir lo compartido. Vuelve a compartirlo ahora que ADA está abierta.', true);
      return;
    }
    try {
      const c = await caches.open('ada-compartido');
      const r = await c.match('/compartido-datos');
      if (!r) return;
      compartido = await r.json();
      await c.delete('/compartido-datos');
    } catch (_) { return; }
    if (!compartido || !compartido.texto || !compartido.texto.trim()) {
      compartido = null;
      aviso('Lo compartido venía vacío. Si es un chat, expórtalo "sin archivos".', true);
      return;
    }
    let t = compartido.texto.trim();
    // En chats largos lo reciente está al final: se conserva el final.
    if (t.length > MAX_COMPARTIDO) t = `[…solo lo más reciente…]\n${t.slice(-MAX_COMPARTIDO)}`;
    compartido.texto = t;
    const lineas = t.split('\n').length;
    $('#compartido-meta').textContent = compartido.archivos && compartido.archivos.length
      ? `${compartido.archivos.join(', ')} · ${lineas} líneas`
      : `${t.length} caracteres`;
    $('#compartido-texto').textContent = t.length > 1500 ? `${t.slice(0, 1500)}…` : t;
    $('#hoja-compartido').hidden = false;
  }

  function cerrarCompartido() {
    $('#hoja-compartido').hidden = true;
    compartido = null;
  }

  function pedirSobreCompartido(pedido, etiqueta) {
    if (!compartido || !pedido.trim()) return;
    const esChat = !!(compartido.archivos && compartido.archivos.length);
    const origen = esChat ? `chat exportado (${compartido.archivos.join(', ')})` : 'mensaje';
    const mensaje = `[Compartido desde otra app, probablemente WhatsApp · ${origen}]\n---\n${compartido.texto}\n---\n\n${pedido.trim()}`;
    cerrarCompartido();
    enviar(mensaje, { mostrar: `📎 Te compartí un ${esChat ? 'chat' : 'mensaje'} · ${etiqueta || pedido.trim()}` });
  }

  $$('[data-cerrar-compartido]').forEach((el) => el.addEventListener('click', cerrarCompartido));
  $$('#hoja-compartido [data-pedido]').forEach((b) => b.addEventListener('click', () => pedirSobreCompartido(b.dataset.pedido, b.textContent)));
  $('#compartido-form').addEventListener('submit', (e) => {
    e.preventDefault();
    pedirSobreCompartido($('#compartido-pedido').value);
    $('#compartido-pedido').value = '';
  });


  // ---------- Sesión ----------
  function salir() {
    token = null;
    detenerVoz();
    try { localStorage.removeItem('ada_token'); } catch (_) {}
    $('#app').hidden = true;
    $('#login').hidden = false;
  }

  async function retomarConversacion() {
    if (!convId) return;
    try {
      const d = await api(`/api/conversaciones/${convId}`);
      if (!d.conversacion.abierta) { guardarConv(null); return; }
      const ultimoYo = [...d.mensajes].reverse().find((m) => m.rol === 'user');
      const ultimaAda = [...d.mensajes].reverse().find((m) => m.rol === 'assistant');
      if (ultimoYo) mostrarYo(ultimoYo.contenido);
      if (ultimaAda) mostrarAda(ultimaAda.contenido);
      docsActuales = d.documentos.map((x) => ({ id: x.id, titulo: x.titulo }));
      archivosActuales = (d.archivos || []).map((x) => ({ id: x.id, nombre: x.nombre, tipo: x.tipo, drive_url: x.drive_url }));
      pintarEntregas();
    } catch (_) {
      guardarConv(null);
    }
  }

  async function entrar() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    setFase('reposo');
    pintarControles();
    revisarRetornoGoogle();
    cargarAjustes();
    await retomarConversacion();
    actualizarEstado();
    cargarAutorizaciones();
    revisarCompartido();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
      token = r.token;
      try { localStorage.setItem('ada_token', token); } catch (_) {}
      entrar();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  setInterval(() => { if (token && !document.hidden) actualizarEstado(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && conversando) detenerVoz();
    if (!document.hidden && token) { actualizarEstado(); cargarAutorizaciones(); }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (token) entrar(); else salir();
})();
