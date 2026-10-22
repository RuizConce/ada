(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let token = null;
  let convId = null;          // conversación en curso
  let ocupado = false;        // esperando respuesta del servidor
  let docsActuales = [];      // documentos entregados en la conversación en curso
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
    hablando: 'ADA está hablando · toca para interrumpir',
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

  function pintarEntregas() {
    const cont = $('#entregas');
    cont.innerHTML = '';
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

  async function resolver(a, decision, contenido) {
    try {
      await api(`/api/acciones/${a.id}`, { method: 'POST', body: JSON.stringify({ decision, contenido, conversacion_id: convId }) });
      aviso(decision === 'enviar' ? 'Listo, ADA hará el seguimiento.' : 'Mensaje descartado.');
    } catch (e) {
      aviso(e.message, true);
    }
    cargarAutorizaciones();
    actualizarEstado();
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
    const hayEnlace = !!enlace(a, a.contenido, a.asunto);
    principal.textContent = hayEnlace
      ? (a.canal === 'whatsapp' ? 'Enviar por WhatsApp' : a.canal === 'correo' ? 'Enviar por correo' : 'Llamar')
      : 'Copiar y marcar enviado';
    if (!hayEnlace && a.canal !== 'otro') {
      const av = document.createElement('div');
      av.className = 'tarjeta-aviso';
      av.textContent = `Falta el ${a.canal === 'correo' ? 'correo' : 'teléfono'} de ${para}. Díselo a ADA.`;
      t.appendChild(av);
    }
    principal.addEventListener('click', async () => {
      const texto = area.value;
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

  // ---------- Hablar con el servidor ----------
  async function enviar(texto, opciones = {}) {
    texto = (texto || '').trim();
    if (!texto || ocupado) return null;
    ocupado = true;
    pintarControles();
    mostrarYo(texto);
    mostrarAda('');
    if (!conversando) setFase('pensando');
    try {
      const r = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ mensaje: texto, voz: !!opciones.voz, conversacion_id: convId }),
      });
      if (r.conversacion_id !== convId) docsActuales = [];
      guardarConv(r.conversacion_id);
      mostrarAda(r.respuesta);
      if (r.documentos && r.documentos.length) {
        docsActuales.push(...r.documentos);
        pintarEntregas();
        if (!opciones.voz) abrirDocumento(r.documentos[r.documentos.length - 1].id);
      }
      actualizarEstado();
      if ((r.acciones || []).some((x) => x.herramienta === 'proponer_mensaje')) cargarAutorizaciones();
      // Fuera del modo conversación (texto o dictado del teclado), ADA también responde en voz.
      if (!opciones.voz && !silenciada) {
        ocupado = false;
        setFase('hablando');
        hablar(r.respuesta).then(() => { if (!conversando && orbe.dataset.fase === 'hablando') setFase('reposo'); });
      }
      return r.respuesta;
    } catch (e) {
      mostrarAda('');
      aviso(`${e.message}. Inténtalo de nuevo.`, true);
      return null;
    } finally {
      ocupado = false;
      if (!conversando && orbe.dataset.fase !== 'hablando') setFase('reposo');
      pintarControles();
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
    desbloquearVoz();
    if (silenciada) { detenerHabla(); if (!conversando) setFase('reposo'); }
    aviso(silenciada ? 'ADA en silencio: solo responde escrito.' : 'ADA vuelve a hablar.');
  });

  // ---------- Conversación por voz ----------
  const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SILENCIO_MS = 1400;
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
    setFase('reposo');
    pintarControles();
  }

  // Termina la conversación: la guarda en el archivo con título y carpeta.
  async function cerrarConversacion() {
    detenerVoz();
    if (!convId) return;
    const id = convId;
    guardarConv(null);
    docsActuales = [];
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
      // Se reconstruye el texto completo en cada evento, en vez de ir sumando.
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
    const respuesta = await enviar(texto, { voz: true });
    if (!conversando) return;
    if (!respuesta) { detenerVoz(); return; }
    setFase('hablando');
    await hablar(respuesta);
    if (!conversando) return;
    if (DESPEDIDA.test(texto)) { cerrarConversacion(); return; }
    escucharTurno();
  }

  // ---------- Voz de ADA ----------
  const sintesis = window.speechSynthesis;

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

  // En Android las voces cargan con retraso: espera un poco a que aparezcan.
  function esperarVoces() {
    return new Promise((resolve) => {
      if (!sintesis || sintesis.getVoices().length) { resolve(); return; }
      const listo = () => { clearTimeout(t); sintesis.removeEventListener('voiceschanged', listo); resolve(); };
      const t = setTimeout(listo, 1500);
      sintesis.addEventListener('voiceschanged', listo);
    });
  }

  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

  // Divide en frases cortas: Chrome corta o ignora textos largos.
  function enFrases(texto) {
    const partes = texto.match(/[^.!?¿¡\n]+[.!?]*|[¿¡][^?!]+[?!]/g) || [texto];
    const out = [];
    let actual = '';
    for (const p of partes.map((s) => s.trim()).filter(Boolean)) {
      if ((actual + ' ' + p).length > 180 && actual) { out.push(actual); actual = p; }
      else actual = actual ? `${actual} ${p}` : p;
    }
    if (actual) out.push(actual);
    return out;
  }

  let avisoVozMostrado = false;
  function avisarFalloVoz(error) {
    if (avisoVozMostrado) return;
    avisoVozMostrado = true;
    const motivo = error === 'not-allowed'
      ? 'el navegador bloqueó el audio: toca la pantalla una vez y vuelve a intentar'
      : error === 'language-unavailable' || error === 'voice-unavailable'
        ? 'tu teléfono no tiene voz en español. Instálala en Ajustes → Texto a voz'
        : `el teléfono no pudo reproducir la voz (${error})`;
    aviso(`ADA no pudo hablar: ${motivo}.`, true);
  }

  function textoParaHablar(t) {
    return t
      .replace(/\*\*|__|`/g, '')
      .replace(/^#+\s*/gm, '')
      .replace(/^\s*[-•*]\s+/gm, '')
      .replace(/✓/g, '')
      .replace(/https?:\/\/\S+/g, 'el enlace')
      .replace(/\n{2,}/g, '. ')
      .trim();
  }

  // Habla frase por frase. Devuelve una promesa que se cumple al terminar (o al interrumpir).
  let interrumpido = false;
  let terminarFraseActual = null;

  function decirFrase(frase, voz) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(frase);
      if (voz) u.voice = voz;
      u.lang = voz ? voz.lang : 'es-US';
      u.rate = 1.05;
      let listo = false;
      const fin = (error) => {
        if (listo) return;
        listo = true;
        clearTimeout(respaldo);
        clearInterval(despertador);
        terminarFraseActual = null;
        resolve(error || null);
      };
      // Respaldo por si el navegador nunca avisa que terminó.
      const respaldo = setTimeout(() => fin(), 3000 + frase.length * 110);
      // Chrome a veces se "duerme" a mitad de frase: un resume() periódico lo despierta.
      const despertador = setInterval(() => { if (sintesis.paused) sintesis.resume(); }, 2000);
      terminarFraseActual = () => fin();
      u.onend = () => fin();
      u.onerror = (e) => fin(e.error === 'interrupted' || e.error === 'canceled' ? null : (e.error || 'error'));
      sintesis.speak(u);
    });
  }

  async function hablar(texto) {
    if (!sintesis || !texto) return;
    interrumpido = false;
    await esperarVoces();
    // Cancelar y hablar de inmediato hace que Chrome en Android ignore la nueva voz.
    if (sintesis.speaking || sintesis.pending) { sintesis.cancel(); await pausa(200); }
    const voz = elegirVoz();
    for (const frase of enFrases(textoParaHablar(texto))) {
      if (interrumpido) break;
      const error = await decirFrase(frase, voz);
      if (error) { avisarFalloVoz(error); break; }
    }
  }

  function detenerHabla() {
    interrumpido = true;
    if (sintesis) sintesis.cancel();
    if (terminarFraseActual) terminarFraseActual();
  }

  // iOS solo permite hablar si antes hubo un toque del usuario.
  let vozDesbloqueada = false;
  function desbloquearVoz() {
    if (vozDesbloqueada || !sintesis) return;
    sintesis.getVoices(); // dispara la carga de voces en Android
    const u = new SpeechSynthesisUtterance('.');
    u.volume = 0;
    u.rate = 2;
    sintesis.speak(u);
    vozDesbloqueada = true;
  }
  if (sintesis) sintesis.onvoiceschanged = () => {};

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

  orbe.addEventListener('click', () => {
    const fase = orbe.dataset.fase;
    if (fase === 'hablando') { detenerHabla(); return; }      // interrumpir: vuelve a escuchar
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
    await retomarConversacion();
    actualizarEstado();
    cargarAutorizaciones();
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
