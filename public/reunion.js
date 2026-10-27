// Modo reunión: micrófono → Deepgram (con quién habla) → transcripción en vivo y guardada en ADA →
// al terminar, acta con acuerdos y tareas (y traducción en vivo si se pide).
(() => {
  const $ = (s) => document.querySelector(s);
  let token = null;
  try { token = localStorage.getItem('ada_token'); } catch (_) {}
  if (!token) { location.href = '/'; return; }

  const api = async (ruta, op = {}) => {
    const r = await fetch(ruta, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(op.headers || {}) } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    return d;
  };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function md(t) {
    const lineas = esc(t).split('\n');
    let html = '';
    let enLista = false;
    const inline = (x) => x.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*(.+?)\*(?=\W|$)/g, '$1<em>$2</em>');
    for (const l of lineas) {
      const item = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (item) { if (!enLista) { html += '<ul>'; enLista = true; } html += `<li>${inline(item[1])}</li>`; continue; }
      if (enLista) { html += '</ul>'; enLista = false; }
      const h = l.match(/^(#{1,3})\s+(.*)$/);
      if (h) html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`;
      else if (/^-{3,}$/.test(l.trim())) html += '<hr>';
      else if (l.trim()) html += `<p>${inline(l)}</p>`;
    }
    if (enLista) html += '</ul>';
    return html;
  }

  const fase = (t) => { $('#reu-fase').textContent = t; };
  const error = (t) => { $('#reu-error').textContent = t || ''; };
  const COLORES = ['#5eeaa8', '#7dd3fc', '#fcd34d', '#f9a8d4', '#c4b5fd', '#fdba74', '#a7f3d0', '#fda4af'];
  const nombres = {}; // hablante → nombre que puso la persona
  const nombreDe = (h) => (Number.isInteger(h) ? (nombres[h] || `Persona ${h + 1}`) : 'Alguien');

  let reunionId = null;
  let grabando = false;
  let t0 = 0;
  let reloj = null;
  let ws = null;
  let ctx = null;
  let micro = null;
  let wakeLock = null;
  let porGuardar = [];
  let timerGuardar = null;
  let reintentos = 0;
  let traducir = false;
  let parcial = null;
  const hablantes = new Set();

  function chip(h) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quien';
    b.dataset.h = String(h);
    b.style.background = Number.isInteger(h) ? COLORES[h % COLORES.length] : '#cbd5e1';
    b.textContent = nombreDe(h);
    if (Number.isInteger(h)) b.addEventListener('click', () => renombrar(h));
    return b;
  }
  function renombrar(h) {
    const n = (prompt(`¿Quién es ${nombreDe(h)}?`, nombres[h] || '') || '').trim().slice(0, 40);
    if (!n) return;
    nombres[h] = n;
    document.querySelectorAll(`.quien[data-h="${h}"]`).forEach((b) => { b.textContent = n; });
  }

  function pintar(texto, h, final) {
    const cont = $('#reu-texto');
    if (!parcial) {
      parcial = document.createElement('div');
      parcial.className = 'seg parcial';
      parcial.append(chip(h), document.createElement('span'));
      cont.appendChild(parcial);
    }
    const viejo = parcial.querySelector('.quien');
    if (viejo.dataset.h !== String(h)) viejo.replaceWith(chip(h));
    parcial.querySelector('span').textContent = texto;
    const el = parcial;
    if (final) { parcial.classList.remove('parcial'); parcial = null; }
    const abajo = cont.scrollHeight - cont.scrollTop - cont.clientHeight < 80;
    if (abajo) cont.scrollTop = cont.scrollHeight;
    return el;
  }

  async function guardar() {
    if (!porGuardar.length || !reunionId) return;
    const lote = porGuardar.splice(0, porGuardar.length);
    try { await api(`/api/reuniones/${reunionId}/segmentos`, { method: 'POST', body: JSON.stringify({ segmentos: lote }) }); }
    catch (_) { porGuardar = lote.concat(porGuardar); } // se reintenta en el siguiente ciclo
  }

  async function finalDe(texto, h) {
    hablantes.add(h);
    const el = pintar(texto, h, true);
    const seg = { hablante: h, texto, seg: (Date.now() - t0) / 1000 };
    porGuardar.push(seg);
    actualizarFase();
    if (traducir && texto.split(/\s+/).length >= 2) {
      try {
        const r = await api('/api/reuniones/traducir', { method: 'POST', body: JSON.stringify({ texto }) });
        if (r.traduccion) {
          seg.traduccion = r.traduccion;
          const s = document.createElement('span');
          s.className = 'trad';
          s.textContent = r.traduccion;
          el.appendChild(s);
          if (!porGuardar.includes(seg)) porGuardar.push({ ...seg, texto: `(traducción de lo anterior)`, traduccion: r.traduccion });
        }
      } catch (_) {}
    }
  }

  function actualizarFase() {
    const n = [...hablantes].filter(Number.isInteger).length;
    fase(`Escuchando${n ? ` · ${n === 1 ? '1 persona' : `${n} personas`}` : ''}. Toca para terminar y armar el acta.`);
  }

  async function abrirMicrofono() {
    micro = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const codigo = `class C extends AudioWorkletProcessor { process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor('captura', C);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })));
    const nodo = new AudioWorkletNode(ctx, 'captura');
    ctx.createMediaStreamSource(micro).connect(nodo);
    const razon = ctx.sampleRate / 16000;
    let pendiente = [];
    nodo.port.onmessage = (e) => {
      const x = e.data;
      const n = Math.floor(x.length / razon);
      const out = new Int16Array(n);
      for (let k = 0; k < n; k++) out[k] = Math.max(-1, Math.min(1, x[Math.floor(k * razon)])) * 0x7fff;
      pendiente.push(out);
      if (pendiente.length >= 8) {
        if (ws && ws.readyState === 1) {
          const total = pendiente.reduce((a, b) => a + b.length, 0);
          const junto = new Int16Array(total);
          let o = 0;
          for (const b of pendiente) { junto.set(b, o); o += b.length; }
          ws.send(junto.buffer);
        }
        pendiente = [];
      }
    };
  }

  function conectar() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/oido?modo=reunion${traducir ? '&idioma=multi' : ''}&token=${encodeURIComponent(token)}`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const keepAlive = setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"type":"KeepAlive"}'); }, 6000);
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.type === 'Listo') { reintentos = 0; error(''); actualizarFase(); return; }
      if (m.type === 'Error') { error(m.mensaje); return; }
      if (m.type !== 'Results' || !m.texto) return;
      const h = Number.isInteger(m.hablante) ? m.hablante : null;
      if (m.is_final) finalDe(m.texto, h);
      else pintar(m.texto, h, false);
    };
    ws.onclose = () => {
      clearInterval(keepAlive);
      if (!grabando) return;
      // Se cortó la conexión en medio de la reunión: reconecta sola.
      if (reintentos < 8) {
        reintentos += 1;
        fase('Se cortó la conexión, reconectando…');
        setTimeout(() => { if (grabando) conectar(); }, Math.min(8000, 1000 * reintentos));
      } else error('No pude reconectar. Lo escuchado hasta ahora quedó guardado; toca Terminar para armar el acta.');
    };
  }

  async function empezar() {
    error('');
    traducir = $('#reu-traducir').checked;
    $('#reu-boton').disabled = true;
    fase('Preparando…');
    try {
      await abrirMicrofono();
      const r = await api('/api/reuniones', { method: 'POST', body: JSON.stringify({ titulo: $('#reu-titulo').value, traducir }) });
      reunionId = r.id;
    } catch (e) {
      $('#reu-boton').disabled = false;
      error(/Permission|NotAllowed/i.test(e.name || e.message) ? 'Necesito permiso para usar el micrófono.' : e.message);
      fase('Toca Empezar cuando comience la reunión.');
      cerrarAudio();
      return;
    }
    grabando = true;
    t0 = Date.now();
    conectar();
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
    $('#reu-preparar').hidden = true;
    $('#reu-vivo').hidden = false;
    $('#reu-resultado').hidden = true;
    const b = $('#reu-boton');
    b.disabled = false;
    b.classList.add('grabando');
    b.textContent = 'Terminar y armar acta';
    $('#reu-reloj').hidden = false;
    reloj = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $('#reu-reloj').textContent = `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ''}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
    timerGuardar = setInterval(guardar, 8000);
    fase('Escuchando. Toca para terminar y armar el acta.');
  }

  function cerrarAudio() {
    try { if (micro) micro.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (ctx) ctx.close(); } catch (_) {}
    micro = null; ctx = null;
  }

  async function terminar(sinPreguntar = false) {
    if (!grabando) return;
    if (!sinPreguntar && !confirm('¿Terminar la reunión y armar el acta?')) return;
    grabando = false;
    clearInterval(reloj);
    clearInterval(timerGuardar);
    try { if (ws) ws.close(); } catch (_) {}
    cerrarAudio();
    try { if (wakeLock) await wakeLock.release(); } catch (_) {}
    if (parcial) { const t = parcial.querySelector('span').textContent; const h = parseInt(parcial.querySelector('.quien').dataset.h, 10); parcial.remove(); parcial = null; if (t) porGuardar.push({ hablante: Number.isInteger(h) ? h : null, texto: t, seg: (Date.now() - t0) / 1000 }); }
    const b = $('#reu-boton');
    b.classList.remove('grabando');
    b.disabled = true;
    b.textContent = 'Armando el acta…';
    fase('ADA está escribiendo el acta, puede tardar un minuto.');
    try {
      await guardar();
      if (porGuardar.length) await guardar();
      const r = await api(`/api/reuniones/${reunionId}/terminar`, { method: 'POST', body: JSON.stringify({ nombres, titulo: $('#reu-titulo').value }) });
      mostrarResultado(r);
    } catch (e) {
      error(`No pude armar el acta: ${e.message}. La transcripción quedó guardada.`);
      b.disabled = false;
      b.textContent = 'Reintentar acta';
      b.onclick = async () => { b.onclick = null; grabando = true; await terminar(true); };
      return;
    }
    b.textContent = 'Empezar';
    b.disabled = false;
    fase('Lista. Puedes empezar otra reunión.');
    $('#reu-reloj').hidden = true;
  }

  function mostrarResultado(r) {
    $('#reu-resultado').hidden = false;
    if (r.vacia) {
      $('#reu-r-titulo').textContent = 'No alcanzó para un acta';
      $('#reu-r-resumen').textContent = r.mensaje;
      $('#reu-r-tareas').innerHTML = '';
      $('#reu-r-acta').innerHTML = '';
      $('#reu-r-nota').textContent = '';
      return;
    }
    $('#reu-r-titulo').textContent = r.titulo || 'Acta lista';
    $('#reu-r-resumen').textContent = r.resumen || '';
    const tc = $('#reu-r-tareas');
    tc.innerHTML = '';
    for (const t of r.tareas || []) {
      const d = document.createElement('div');
      d.innerHTML = '<span></span><br><small></small>';
      d.querySelector('span').textContent = `${t.para_mi ? '📌 ' : ''}${t.texto}`;
      d.querySelector('small').textContent = [t.responsable || (t.para_mi ? 'Tú' : ''), t.fecha_limite, t.para_mi ? 'agendada' : 'para seguimiento'].filter(Boolean).join(' · ');
      tc.appendChild(d);
    }
    $('#reu-r-acta').innerHTML = md(r.acta || '');
    $('#reu-r-nota').textContent = 'El acta completa, con la transcripción, quedó en ADA y te llega al correo y al teléfono.';
    $('#reu-resultado').scrollIntoView({ behavior: 'smooth' });
  }

  $('#reu-boton').addEventListener('click', () => { if ($('#reu-boton').onclick) return; (grabando ? terminar() : empezar()); });
  $('#reu-otra').addEventListener('click', () => {
    $('#reu-resultado').hidden = true;
    $('#reu-vivo').hidden = true;
    $('#reu-preparar').hidden = false;
    $('#reu-texto').innerHTML = '';
    $('#reu-titulo').value = '';
    hablantes.clear();
    for (const k of Object.keys(nombres)) delete nombres[k];
    reunionId = null;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  window.addEventListener('beforeunload', (e) => { if (grabando) { guardar(); e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && grabando) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {} }
  });
  if (new URLSearchParams(location.search).get('titulo')) $('#reu-titulo').value = new URLSearchParams(location.search).get('titulo').slice(0, 120);
})();
