(() => {
  const $ = (s) => document.querySelector(s);
  const chat = $('#chat');
  const input = $('#mensaje');
  const btnEnviar = $('#enviar');
  let token = null;
  let ocupado = false;

  try { token = localStorage.getItem('ada_token'); } catch (_) {}

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
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function md(texto) {
    const lineas = texto.split('\n');
    let html = '';
    let lista = null;
    let parrafo = [];
    const cerrarParrafo = () => { if (parrafo.length) { html += `<p>${parrafo.map(inline).join('<br>')}</p>`; parrafo = []; } };
    const cerrarLista = () => { if (lista) { html += `</${lista}>`; lista = null; } };
    for (const l of lineas) {
      const ul = l.match(/^\s*[-•*]\s+(.*)/);
      const ol = l.match(/^\s*\d+[.)]\s+(.*)/);
      const h = l.match(/^#{1,4}\s+(.*)/);
      if (ul || ol) {
        cerrarParrafo();
        const tipo = ul ? 'ul' : 'ol';
        if (lista !== tipo) { cerrarLista(); html += `<${tipo}>`; lista = tipo; }
        html += `<li>${inline((ul || ol)[1])}</li>`;
      } else if (h) {
        cerrarParrafo(); cerrarLista();
        html += `<h3>${inline(h[1])}</h3>`;
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

  // ---------- Render ----------
  const ONDA = '<div class="onda quieta" aria-hidden="true">' + '<i></i>'.repeat(15) + '</div>';
  const ICONOS = {
    agenda: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    encargos: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 12.5l4 4 10-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    revision: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3.5V12h8.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  };

  function vacio() {
    chat.innerHTML = `
      <div class="hero">
        <div class="hero-etiqueta">Asistente IA</div>
        <div class="hero-nombre">ADA</div>
        ${ONDA}
        <h1>Hola, Cristian.</h1>
        <p>Háblame o escríbeme qué decidiste, qué avanzaste o qué prometiste. Yo lo ordeno y me hago cargo.</p>
        <div class="hero-tarjetas">
          <button type="button" data-texto="¿Qué me falta?">${ICONOS.agenda}Pendientes y agenda</button>
          <button type="button" data-texto="¿Cómo van mis encargos?">${ICONOS.encargos}Encargos</button>
          <button type="button" data-texto="Hazme la revisión semanal.">${ICONOS.revision}Revisión semanal</button>
        </div>
      </div>`;
    chat.querySelectorAll('.hero-tarjetas button').forEach((b) => b.addEventListener('click', () => enviar(b.dataset.texto)));
  }

  function burbuja(rol, texto, acciones = [], opciones = {}) {
    const v = chat.querySelector('.hero');
    if (v) v.remove();
    const div = document.createElement('div');
    div.className = `msg ${rol}`;
    if (rol === 'assistant') {
      div.innerHTML = md(texto);
      if (vozDisponible()) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'escuchar';
        b.textContent = '▶ Escuchar';
        b.addEventListener('click', () => hablar(texto, true));
        div.appendChild(b);
      }
    } else if (opciones.voz) {
      const et = document.createElement('span');
      et.className = 'via-voz';
      et.textContent = '🎙 Por voz';
      div.appendChild(et);
      div.appendChild(document.createTextNode(texto));
    } else {
      div.textContent = texto;
    }
    if (acciones.length) {
      const cont = document.createElement('div');
      cont.className = 'acciones';
      for (const a of acciones) {
        const s = document.createElement('span');
        s.className = `accion${a.herramienta === 'registrar_alerta' ? ' cuestiona' : ''}`;
        s.textContent = `✓ ${a.etiqueta}`;
        cont.appendChild(s);
      }
      div.appendChild(cont);
    }
    chat.appendChild(div);
    bajar();
    return div;
  }

  function bajar() { chat.scrollTop = chat.scrollHeight; }

  function escribiendo() {
    const div = document.createElement('div');
    div.className = 'msg assistant';
    div.innerHTML = '<span class="escribiendo"><span></span><span></span><span></span></span>';
    chat.appendChild(div);
    bajar();
    return div;
  }

  function corto(d) {
    // "2026-10-23 18:00 (jueves)" -> "jue 18:00"
    if (!d) return '';
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}) \((\w+)/u);
    if (!m) return d;
    const hoy = new Date();
    const f = new Date(+m[1], +m[2] - 1, +m[3]);
    const dif = Math.round((f - new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())) / 86400000);
    const dia = dif === 0 ? 'hoy' : dif === 1 ? 'mañana' : dif === -1 ? 'ayer' : m[5].slice(0, 3);
    return `${dia} ${m[4]}`;
  }

  let proyectos = [];
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
      else pill('Sin foco');
      if (e.encargos_activos) {
        pill(`${e.encargos_activos} encargo${e.encargos_activos > 1 ? 's' : ''}${e.encargos_por_revisar ? ` · ${e.encargos_por_revisar} por revisar` : ''}`,
          e.encargos_por_revisar ? 'urgente' : 'encargos');
      }
      for (const u of (e.urgentes || []).slice(0, 3)) {
        pill(`${u.vencido ? 'Vencido' : corto(u.fecha_limite)} · ${u.texto}`, u.vencido ? 'vencido' : 'urgente');
      }
    } catch (_) {}
  }

  // ---------- Mensajes por autorizar ----------
  const CANAL = { whatsapp: 'WhatsApp', correo: 'Correo', llamada: 'Llamada', otro: 'Mensaje' };

  function enlace(a, texto, asunto) {
    if (a.canal === 'whatsapp') {
      return a.telefono ? `https://wa.me/${a.telefono}?text=${encodeURIComponent(texto)}` : null;
    }
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
      await api(`/api/acciones/${a.id}`, { method: 'POST', body: JSON.stringify({ decision, contenido }) });
    } catch (e) {
      burbuja('error', e.message);
    }
    cargarAutorizaciones();
    actualizarEstado();
  }

  async function cargarAutorizaciones() {
    const cont = $('#autorizaciones');
    let lista = [];
    try { lista = await api('/api/autorizaciones'); } catch (_) { return; }
    cont.innerHTML = '';
    cont.hidden = !lista.length;
    for (const a of lista) {
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
      t.querySelector('.tarjeta-canal').textContent = CANAL[a.canal] || a.canal;
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
        const aviso = document.createElement('div');
        aviso.className = 'tarjeta-aviso';
        aviso.textContent = `Falta el ${a.canal === 'correo' ? 'correo' : 'teléfono'} de ${para}. Puedes dárselo a ADA en el chat.`;
        t.appendChild(aviso);
      }

      principal.addEventListener('click', async () => {
        const texto = area.value;
        const link = enlace(a, texto, asunto && asunto.value);
        // Abrir el enlace dentro del mismo toque (iOS bloquea aperturas diferidas).
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
        ev.target.textContent = ok ? 'Copiado ✓' : 'No se pudo copiar';
        setTimeout(() => { ev.target.textContent = 'Copiar'; }, 1800);
      });
      t.querySelector('.descartar').addEventListener('click', () => resolver(a, 'rechazar'));
      cont.appendChild(t);
    }
  }

  // ---------- Enviar ----------
  async function enviar(texto, opciones = {}) {
    texto = (texto || '').trim();
    if (!texto || ocupado) return;
    ocupado = true;
    btnEnviar.disabled = true;
    burbuja('user', texto, [], opciones);
    input.value = '';
    ajustar();
    const pensando = escribiendo();
    try {
      const r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ mensaje: texto }) });
      pensando.remove();
      burbuja('assistant', r.respuesta, r.acciones || []);
      // Si le hablaste, responde hablando (o siempre, si activaste la voz).
      if (opciones.voz || vozSalida) hablar(r.respuesta);
      actualizarEstado();
      if ((r.acciones || []).some((x) => x.herramienta === 'proponer_mensaje')) cargarAutorizaciones();
    } catch (e) {
      pensando.remove();
      const d = burbuja('error', `${e.message}. Tu mensaje no se perdió: tócalo para reintentar.`);
      d.style.cursor = 'pointer';
      d.addEventListener('click', () => { d.remove(); input.value = texto; ajustar(); input.focus(); });
    } finally {
      ocupado = false;
      btnEnviar.disabled = false;
    }
  }

  function ajustar() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  $('#form').addEventListener('submit', (e) => { e.preventDefault(); enviar(input.value); });
  input.addEventListener('input', ajustar);
  input.addEventListener('keydown', (e) => {
    // Enter envía en teclado físico; Shift+Enter agrega línea.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      enviar(input.value);
    }
  });

  // ---------- Voz: hablarle a ADA (dictado) ----------
  const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btnMic = $('#microfono');
  const panelEscucha = $('#escucha');
  const txtTranscripcion = $('#transcripcion');
  let rec = null;
  let textoFinal = '';
  let textoParcial = '';
  let cancelado = false;

  function mostrarTranscripcion() {
    const t = (textoFinal + ' ' + textoParcial).trim();
    txtTranscripcion.textContent = t || 'Escuchando…';
    txtTranscripcion.classList.toggle('vacia', !t);
  }

  function terminarEscucha() {
    panelEscucha.hidden = true;
    btnMic.classList.remove('activo');
    const t = (textoFinal + ' ' + textoParcial).trim();
    rec = null;
    if (!cancelado && t) enviar(t, { voz: true });
  }

  function escuchar() {
    if (ocupado) return;
    if (rec) { rec.stop(); return; }
    desbloquearVoz();
    if (!Reconocimiento) {
      burbuja('error', 'Este navegador no permite dictado. Usa Safari o Chrome, o el micrófono del teclado.');
      return;
    }
    detenerHabla();
    rec = new Reconocimiento();
    rec.lang = 'es-CL';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    textoFinal = '';
    textoParcial = '';
    cancelado = false;
    rec.onresult = (e) => {
      textoParcial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) textoFinal += ' ' + r[0].transcript;
        else textoParcial += r[0].transcript;
      }
      mostrarTranscripcion();
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        cancelado = true;
        burbuja('error', 'ADA no tiene permiso para usar el micrófono. Actívalo en los ajustes del navegador.');
      } else if (e.error === 'no-speech') {
        cancelado = true;
      }
    };
    rec.onend = terminarEscucha;
    try {
      rec.start();
      panelEscucha.hidden = false;
      btnMic.classList.add('activo');
      mostrarTranscripcion();
    } catch (_) {
      rec = null;
    }
  }

  btnMic.addEventListener('click', escuchar);
  $('#escucha-listo').addEventListener('click', () => { if (rec) rec.stop(); });
  $('#escucha-cancelar').addEventListener('click', () => { cancelado = true; if (rec) rec.abort(); });

  // ---------- Voz: ADA responde hablando ----------
  const sintesis = window.speechSynthesis;
  const btnVoz = $('#voz-salida');
  let vozSalida = false;
  try { vozSalida = localStorage.getItem('ada_voz') === '1'; } catch (_) {}

  function vozDisponible() { return !!sintesis; }

  function elegirVoz() {
    const voces = sintesis ? sintesis.getVoices() : [];
    return voces.find((v) => v.lang === 'es-CL')
      || voces.find((v) => /^es[-_](419|MX|US|AR|CO)/i.test(v.lang))
      || voces.find((v) => /^es/i.test(v.lang))
      || null;
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

  function hablar(texto, forzar = false) {
    if (!sintesis || (!forzar && !texto)) return;
    sintesis.cancel();
    const u = new SpeechSynthesisUtterance(textoParaHablar(texto));
    const v = elegirVoz();
    if (v) u.voice = v;
    u.lang = v ? v.lang : 'es-CL';
    u.rate = 1.05;
    sintesis.speak(u);
  }

  function detenerHabla() { if (sintesis) sintesis.cancel(); }

  // iOS solo permite hablar si antes hubo un toque del usuario.
  let vozDesbloqueada = false;
  function desbloquearVoz() {
    if (vozDesbloqueada || !sintesis) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    sintesis.speak(u);
    vozDesbloqueada = true;
  }

  function pintarBotonVoz() { btnVoz.setAttribute('aria-pressed', vozSalida ? 'true' : 'false'); }
  btnVoz.hidden = !vozDisponible();
  pintarBotonVoz();
  btnVoz.addEventListener('click', () => {
    vozSalida = !vozSalida;
    try { localStorage.setItem('ada_voz', vozSalida ? '1' : '0'); } catch (_) {}
    pintarBotonVoz();
    desbloquearVoz();
    if (!vozSalida) detenerHabla();
  });
  if (sintesis) sintesis.onvoiceschanged = () => {};
  $('#form').addEventListener('submit', desbloquearVoz, true);

  // ---------- Atajos ----------
  document.querySelectorAll('.atajos button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.accion === 'foco') return abrirHoja();
      enviar(b.dataset.texto);
    });
  });

  function abrirHoja() {
    const cont = $('#hoja-proyectos');
    cont.innerHTML = '';
    for (const p of proyectos) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p;
      b.addEventListener('click', () => {
        cerrarHoja();
        input.value = `Estoy con ${p}: `;
        ajustar();
        input.focus();
      });
      cont.appendChild(b);
    }
    const otro = document.createElement('button');
    otro.type = 'button';
    otro.textContent = 'Otra cosa…';
    otro.addEventListener('click', () => { cerrarHoja(); input.value = 'Estoy con '; ajustar(); input.focus(); });
    cont.appendChild(otro);
    $('#hoja').hidden = false;
  }
  function cerrarHoja() { $('#hoja').hidden = true; }
  document.querySelectorAll('[data-cerrar]').forEach((el) => el.addEventListener('click', cerrarHoja));

  // ---------- Sesión ----------
  function salir() {
    token = null;
    try { localStorage.removeItem('ada_token'); } catch (_) {}
    $('#app').hidden = true;
    $('#login').hidden = false;
  }

  async function entrar() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    try {
      const msgs = await api('/api/historial');
      chat.innerHTML = '';
      if (!msgs.length) vacio();
      let diaAnterior = '';
      for (const m of msgs) {
        const d = new Date(m.creado_en);
        const dia = d.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
        if (dia !== diaAnterior) {
          const h = document.createElement('div');
          h.className = 'hora';
          h.textContent = dia;
          chat.appendChild(h);
          diaAnterior = dia;
        }
        burbuja(m.rol, m.contenido);
      }
    } catch (e) {
      if (token) vacio();
    }
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

  // Refresca la barra de estado cada minuto y al volver a la app.
  setInterval(() => { if (token && !document.hidden) actualizarEstado(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && token) { actualizarEstado(); cargarAutorizaciones(); }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (token) entrar(); else salir();
})();
