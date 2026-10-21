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
  function vacio() {
    chat.innerHTML = `<div class="vacio"><strong>Hola, Cristian.</strong>Cuéntame qué decidiste, qué avanzaste, qué quedó pendiente o qué prometiste. Yo lo ordeno.</div>`;
  }

  function burbuja(rol, texto, acciones = []) {
    const v = chat.querySelector('.vacio');
    if (v) v.remove();
    const div = document.createElement('div');
    div.className = `msg ${rol}`;
    if (rol === 'assistant') div.innerHTML = md(texto);
    else div.textContent = texto;
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
      if (e.foco) pill(`● ${e.foco.proyecto || e.foco.descripcion} · ${e.foco.minutos} min`, 'foco');
      else pill('Sin foco');
      for (const u of (e.urgentes || []).slice(0, 3)) {
        pill(`${u.vencido ? 'Vencido' : corto(u.fecha_limite)} · ${u.texto}`, u.vencido ? 'vencido' : 'urgente');
      }
    } catch (_) {}
  }

  // ---------- Enviar ----------
  async function enviar(texto) {
    texto = (texto || '').trim();
    if (!texto || ocupado) return;
    ocupado = true;
    btnEnviar.disabled = true;
    burbuja('user', texto);
    input.value = '';
    ajustar();
    const pensando = escribiendo();
    try {
      const r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ mensaje: texto }) });
      pensando.remove();
      burbuja('assistant', r.respuesta, r.acciones || []);
      actualizarEstado();
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) actualizarEstado(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (token) entrar(); else salir();
})();
