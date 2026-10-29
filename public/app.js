(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let token = null;
  let convId = null;          // conversación en curso
  let yo = null;              // persona que usa ADA: { id, nombre, admin }
  let ocupado = false;        // esperando respuesta del servidor
  let llamadasActuales = [];  // botones "Llamar" de la última respuesta
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
  // Nueva versión publicada: la app abierta usaría código viejo (ej.: sin el botón Llamar).
  // Se recarga sola apenas está libre (sin conversación en curso).
  let versionCargada = null;
  let versionNueva = false;
  function notarVersion(v) {
    if (!v) return;
    if (!versionCargada) versionCargada = v;
    else if (v !== versionCargada) versionNueva = true;
  }
  function recargarSiHayVersion() {
    if (!versionNueva || ocupado || conversando) return false;
    location.reload();
    return true;
  }

  async function api(ruta, opciones = {}) {
    const res = await fetch(ruta, {
      ...opciones,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opciones.headers || {}) },
    });
    notarVersion(res.headers.get('X-ADA-Version'));
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

  // Detalle que ADA deja para mirar (no se lee en voz).
  function mostrarDetalle(texto) {
    const d = $('#detalle');
    if (!d) return;
    d.hidden = !texto;
    d.querySelector('.detalle-cuerpo').innerHTML = texto ? md(texto) : '';
  }

  // ---------- Entregas: documentos y mensajes por autorizar ----------
  const ICONO_DOC = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 3.5h7l4.5 4.5v12.5H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3.5V8h4.5M9.5 12.5h6M9.5 16h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  let autorizaciones = [];
  let consentimientoPendiente = null; // pregunta para guardar extracciones cifradas (Fase 3b)

  const ICONO_ARCHIVO = {
    word: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 3.5h7l4.5 4.5v12.5H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.5 11.5l1.2 5 1.3-4 1.3 4 1.2-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    excel: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 9.5h16M4 14.5h16M10 4v16" stroke="currentColor" stroke-width="1.6"/></svg>',
  };

  // Descargas: se pide al servidor un enlace temporal (5 min) y se abre como descarga normal.
  // En la app de Android, el WebView entrega ese enlace al sistema (los "blob:" no se pueden guardar ahí);
  // en el navegador, el enlace descarga con su nombre. Si algo falla, se avisa: nunca queda en silencio.
  async function descargar(tipo, id, boton) {
    const texto = boton ? boton.textContent : '';
    if (boton) { boton.disabled = true; boton.textContent = 'Preparando…'; }
    try {
      const r = await api('/api/descargas', { method: 'POST', body: JSON.stringify({ tipo, id }) });
      const enl = document.createElement('a');
      enl.href = r.url;
      enl.download = r.nombre;
      enl.rel = 'noopener';
      document.body.appendChild(enl);
      enl.click();
      setTimeout(() => enl.remove(), 1000);
      aviso(window.AdaAndroid ? `Descargando «${r.nombre}»: queda en la carpeta Descargas del teléfono.` : `Descargando «${r.nombre}».`);
    } catch (e) {
      aviso(`No se pudo descargar: ${e.message}`, true);
    }
    if (boton) { boton.disabled = false; boton.textContent = texto; }
  }
  const descargarArchivo = (a, boton) => descargar('archivo', a.id, boton);

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
    for (const l of llamadasActuales) cont.appendChild(tarjetaLlamada(l));
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
    if (consentimientoPendiente) cont.appendChild(tarjetaConsentimiento(consentimientoPendiente));
    for (const p of propuestasAuditoria) cont.appendChild(tarjetaPropuestaAuditoria(p));
    for (const a of encargosAuditoria.values()) cont.appendChild(tarjetaEncargoAuditoria(a));
  }

  // ---------- Auditorías desde la conversación (Fase 3d) ----------
  // ADA propone; nada empieza ni se gasta hasta tocar "Aprobar". El avance viene de la base (real, no estimado).
  const TARJETAS_SOPORTADAS = ['auditoria_propuesta@1']; // el servidor solo promete tarjetas que esta versión sabe dibujar
  let propuestasAuditoria = [];
  const encargosAuditoria = new Map();
  let audChatTimer = null;
  const usdAud = (n) => `US$${Number(n || 0).toFixed(4).replace('.', ',')}`;
  const ESTADO_AUD = { cumple: 'Cumple', parcial: 'Parcial', no_cumple: 'No cumple', sin_evidencia: 'Sin evidencia', no_aplica_justificado: 'No aplica (justificado)', no_evaluado: 'No evaluado' };
  const ETAPA_AUD = { ejecutando: 'Trabajando', pausado: 'En pausa', pausado_presupuesto: 'Detenido: se acabó el presupuesto', bloqueado: 'Detenido por un error', completado: 'Terminada', cancelado: 'Cancelada', fallido: 'Falló', esperando_aprobacion: 'Esperando aprobación' };

  function tarjetaPropuestaAuditoria(p) {
    const t = document.createElement('div');
    t.className = 'tarjeta tarjeta-auditoria';
    t.dataset.propuesta = p.id;
    t.innerHTML = '<div class="tarjeta-cab"><span><strong>Auditoría propuesta</strong></span><em class="aud-estado"></em></div><p class="meta aud-archivos"></p>'
      + '<label class="aud-campo">Requisitos (uno por línea: R1 | texto)<textarea rows="5" class="aud-req"></textarea></label>'
      + '<div class="aud-fila"><label class="aud-campo">Configuración<select class="aud-conf"></select></label><label class="aud-campo">Presupuesto US$<input type="number" step="0.01" min="0.01" class="aud-pres"></label></div>'
      + '<p class="meta aud-est"></p><div class="tarjeta-botones"><button type="button" class="principal">Aprobar y empezar</button><button type="button" class="descartar">Descartar</button></div>';
    t.querySelector('.aud-estado').textContent = `Pendiente · ${p.id.slice(0, 8)}`;
    t.querySelector('.aud-archivos').textContent = `${p.archivos.map((a) => a.nombre).join(' · ')}${p.motivo ? ` — ${p.motivo}` : ''}`;
    t.querySelector('.aud-req').value = p.requisitos.map((r) => `${r.id} | ${r.texto}`).join('\n');
    const sel = t.querySelector('.aud-conf');
    for (const k of ['K1', 'K2', 'K3']) { const o = document.createElement('option'); o.value = k; o.textContent = k === 'K1' ? 'K1 · Sonnet (recomendada)' : k === 'K2' ? 'K2 · Haiku (económica)' : 'K3 · Haiku con escalamiento'; sel.appendChild(o); }
    sel.value = p.configuracion;
    const pres = t.querySelector('.aud-pres');
    const est = t.querySelector('.aud-est');
    const pintarEst = () => {
      const min = p.presupuesto_minimo[sel.value];
      est.textContent = `Costo estimado (peor caso) ${usdAud(p.estimados ? p.estimados[sel.value] : p.estimado_usd)} · presupuesto mínimo a reservar ${usdAud(min)}. Solo se cobra lo real, y nada hasta que apruebes.`;
      if (!pres.dataset.tocado) pres.value = String(Math.ceil(min * 100) / 100);
    };
    pres.addEventListener('input', () => { pres.dataset.tocado = '1'; });
    sel.addEventListener('change', pintarEst);
    pintarEst();
    const botones = t.querySelectorAll('.tarjeta-botones button');
    t.querySelector('.principal').addEventListener('click', async () => {
      const requisitos = t.querySelector('.aud-req').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
        const [a, ...b] = l.split('|'); return b.length ? { id: a.trim(), texto: b.join('|').trim() } : { id: `R${i + 1}`, texto: l };
      });
      botones.forEach((b) => { b.disabled = true; });
      try {
        const r = await api(`/api/auditorias/propuestas/${p.id}/aprobar`, { method: 'POST', body: JSON.stringify({ presupuesto: parseFloat(pres.value), requisitos, configuracion: sel.value }) });
        propuestasAuditoria = propuestasAuditoria.filter((x) => x.id !== p.id);
        encargosAuditoria.set(r.trabajo_id, { id: r.trabajo_id, propuesta_id: r.propuesta_id, config: r.configuracion, estado: r.estado, pasos_hechos: 0, pasos_total: 0, requisitos_evaluados: 0, requisitos_total: requisitos.length, costo_real_usd: 0, presupuesto_usd: r.presupuesto });
        pintarEntregas();
        if (!$('#ajuste-auditoria').hidden) pintarPendientesAjustes();
        seguirAuditorias();
      } catch (e) { botones.forEach((b) => { b.disabled = false; }); aviso(e.message, true); }
    });
    t.querySelector('.descartar').addEventListener('click', async () => {
      botones.forEach((b) => { b.disabled = true; });
      try { await api(`/api/auditorias/propuestas/${p.id}/descartar`, { method: 'POST' }); } catch (_) {}
      propuestasAuditoria = propuestasAuditoria.filter((x) => x.id !== p.id);
      pintarEntregas();
      if (!$('#ajuste-auditoria').hidden) pintarPendientesAjustes();
    });
    return t;
  }

  function tarjetaEncargoAuditoria(a) {
    const t = document.createElement('div');
    t.className = 'tarjeta tarjeta-auditoria';
    t.dataset.trabajo = a.id;
    t.innerHTML = '<div class="tarjeta-cab"><span><strong>Auditoría en curso</strong></span><em class="aud-estado"></em></div>'
      + '<div class="aud-barra"><i></i></div><p class="meta aud-avance"></p><ul class="aud-matriz"></ul><div class="tarjeta-botones"></div>';
    const terminado = a.estado === 'completado';
    t.querySelector('strong').textContent = terminado ? 'Auditoría terminada' : 'Auditoría en curso';
    t.querySelector('.aud-estado').textContent = a.estado === 'ejecutando' && a.estado_real === 'esperando ejecutor' ? 'Esperando turno' : (ETAPA_AUD[a.estado] || a.estado);
    const pct = a.pasos_total ? Math.round((100 * a.pasos_hechos) / a.pasos_total) : 0;
    t.querySelector('.aud-barra i').style.width = `${pct}%`;
    t.querySelector('.aud-avance').textContent = `Trabajo ${a.id.slice(0, 8)}${a.propuesta_id ? ` (propuesta ${a.propuesta_id.slice(0, 8)})` : ''}${a.config ? ` · ${a.config}` : ''} · ${a.etapa ? `${a.etapa} · ` : ''}Requisitos evaluados ${a.requisitos_evaluados}/${a.requisitos_total} · pasos ${a.pasos_hechos}/${a.pasos_total || '…'} · gastado ${usdAud(a.costo_real_usd)} de ${usdAud(a.presupuesto_usd)}${a.reserva_activa_usd ? ` · reservado ahora ${usdAud(a.reserva_activa_usd)}` : ''}${a.motivo && !terminado ? ` · ${a.motivo}` : ''}`;
    const ul = t.querySelector('.aud-matriz');
    for (const f of a.matriz || []) {
      const li = document.createElement('li');
      li.textContent = `${f.requisito}: ${ESTADO_AUD[f.estado] || f.estado}${f.cita_verificada ? ` · cita verificada (${f.ubicacion})` : ''}`;
      li.className = `aud-${f.estado}`;
      ul.appendChild(li);
    }
    const botones = t.querySelector('.tarjeta-botones');
    const boton = (texto, fn, clase) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = texto; if (clase) b.className = clase; b.addEventListener('click', () => fn(b)); botones.appendChild(b); return b; };
    const accion = async (b, ruta, cuerpo) => { b.disabled = true; try { await api(`/api/trabajos/${a.id}/${ruta}`, { method: 'POST', body: JSON.stringify(cuerpo || {}) }); seguirAuditorias(); } catch (e) { b.disabled = false; aviso(e.message, true); } };
    if (terminado && a.excel_listo) {
      boton('Descargar Excel', (b) => descargar('auditoria', a.id, b), 'principal');
      boton('Cerrar', () => cerrarAuditoria(a.id), 'descartar');
    }
    if (a.estado === 'pausado_presupuesto') {
      boton('Ampliar presupuesto…', (b) => {
        if (b.dataset.paso !== '1') { b.dataset.paso = '1'; b.textContent = 'Confirmar: +US$1 (solo se gasta lo real)'; return; }
        accion(b, 'ampliar', { monto: 1 });
      }, 'principal');
    }
    if (a.estado === 'bloqueado') {
      boton('Reintentar desde el paso que falló', (b) => {
        if (b.dataset.paso !== '1') { b.dataset.paso = '1'; b.textContent = 'Confirmar reintento (lo hecho no se vuelve a pagar)'; return; }
        accion(b, 'reintentar');
      }, 'principal');
    }
    if (['ejecutando', 'pausado', 'pausado_presupuesto', 'bloqueado'].includes(a.estado)) {
      boton('Cancelar', (b) => {
        if (b.dataset.paso !== '1') { b.dataset.paso = '1'; b.textContent = 'Confirmar cancelación'; return; }
        accion(b, 'cancelar');
      }, 'descartar');
    }
    if (['cancelado', 'fallido'].includes(a.estado)) boton('Cerrar', () => cerrarAuditoria(a.id), 'descartar');
    return t;
  }

  // La app confirma al servidor si la tarjeta quedó dibujada (evidencia para ver_auditoria y el diagnóstico).
  function recibirPropuestaAuditoria(d) {
    propuestasAuditoria = propuestasAuditoria.filter((x) => x.id !== d.id).concat([d]);
    let estado = 'mostrada';
    try {
      pintarEntregas();
      const el = document.querySelector(`#entregas [data-propuesta="${d.id}"] .principal`);
      if (!el) estado = 'error_al_mostrar';
      else el.closest('.tarjeta').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (e) { estado = 'error_al_mostrar'; }
    api(`/api/auditorias/propuestas/${d.id}/tarjeta`, { method: 'POST', body: JSON.stringify({ estado }) }).catch(() => {});
    if (estado !== 'mostrada') aviso('No pude mostrar la tarjeta de la auditoría. Está guardada en Ajustes → Auditoría → Propuestas pendientes.', true);
  }

  // Una tarjeta cerrada no vuelve a aparecer al recargar (preferencia de este navegador).
  const cerradasAud = () => { try { return JSON.parse(localStorage.getItem('ada_aud_cerradas') || '[]'); } catch (_) { return []; } };
  function cerrarAuditoria(id) {
    encargosAuditoria.delete(id);
    try { localStorage.setItem('ada_aud_cerradas', JSON.stringify(cerradasAud().concat([id]).slice(-20))); } catch (_) {}
    pintarEntregas();
  }

  async function seguirAuditorias() {
    clearTimeout(audChatTimer);
    let vivas = false;
    for (const id of [...encargosAuditoria.keys()]) {
      try {
        const a = await api(`/api/auditorias/${id}/avance`);
        const antes = encargosAuditoria.get(id);
        encargosAuditoria.set(id, a);
        if (antes && antes.estado !== 'completado' && a.estado === 'completado') aviso('La auditoría terminó: el Excel está listo para descargar.');
        if (a.estado === 'ejecutando') vivas = true;
      } catch (_) {}
    }
    pintarEntregas();
    if (vivas) audChatTimer = setTimeout(seguirAuditorias, 2000);
  }

  async function pintarPendientesAjustes() {
    const cont = $('#aud-pendientes');
    cont.innerHTML = '';
    try {
      const lista = await api('/api/auditorias/propuestas');
      if (!lista.length) { cont.innerHTML = '<p class="meta">No hay propuestas pendientes.</p>'; return; }
      for (const p of lista) cont.appendChild(tarjetaPropuestaAuditoria(p));
    } catch (e) { cont.textContent = e.message; }
  }

  // Al abrir la app: recupera las auditorías en curso (o terminadas hace poco) para que la tarjeta no se pierda.
  async function cargarAuditoriasActivas() {
    // Solo la cuenta principal tiene auditorías; para las demás el servidor responde 403 y no se muestra nada.
    try {
      const r = await api('/api/auditorias/activas');
      const cerradas = cerradasAud();
      for (const a of r.trabajos || []) if (!cerradas.includes(a.id)) encargosAuditoria.set(a.id, a);
      // Propuestas pendientes: vuelven siempre (no se pueden "cerrar", solo aprobar o descartar).
      for (const p of r.propuestas || []) if (!propuestasAuditoria.some((x) => x.id === p.id)) propuestasAuditoria.push(p);
      pintarEntregas();
      if ((r.trabajos || []).length) seguirAuditorias();
    } catch (_) {}
  }

  // Consentimiento explícito para guardar (cifrado, máx. 30 días) lo que ADA extrae de los documentos.
  function tarjetaConsentimiento(c) {
    const t = document.createElement('div');
    t.className = 'tarjeta tarjeta-consentimiento';
    t.innerHTML = '<div class="tarjeta-cab"><span><strong>¿Guardo lo que extraigo de tus documentos?</strong></span></div><p class="meta"></p>'
      + '<div class="tarjeta-botones"><button type="button" class="principal">Aceptar y guardar cifrado</button><button type="button" class="descartar">No guardar</button></div>';
    t.querySelector('p').textContent = c.texto;
    const responder = async (acepto) => {
      t.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await api('/api/extracciones/consentimiento', { method: 'POST', body: JSON.stringify({ acepto }) });
        consentimientoPendiente = null;
        pintarEntregas();
        aviso(acepto ? 'Listo: guardo cifrado lo que extraiga (máx. 30 días). Lo borras cuando quieras en Ajustes.' : 'Entendido: no guardo nada. Sigo leyendo tus documentos igual.');
        if (!$('#ajuste-cifrado').hidden) pintarDocumentosGuardados();
      } catch (e) {
        t.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        aviso(e.message, true);
      }
    };
    t.querySelector('.principal').addEventListener('click', () => responder(true));
    t.querySelector('.descartar').addEventListener('click', () => responder(false));
    return t;
  }

  // Botón para llamar: marca desde el teléfono solo cuando Cristian lo toca.
  const fono = (t) => {
    const d = String(t || '');
    const m = d.match(/^56(9)(\d{4})(\d{4})$/);
    return m ? `+56 ${m[1]} ${m[2]} ${m[3]}` : `+${d}`;
  };
  function tarjetaLlamada(l) {
    const caja = document.createElement('div');
    caja.className = 'entrega-llamada';
    const a = document.createElement('a');
    a.className = 'entrega-doc';
    a.href = `tel:+${l.telefono}`;
    a.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M6.6 3.5h2.6l1.4 4-2 1.6a12 12 0 0 0 6.3 6.3l1.6-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span><small>Llamar</small><strong></strong></span><em></em>';
    a.querySelector('strong').textContent = l.nombre || fono(l.telefono);
    a.querySelector('em').textContent = l.nombre ? fono(l.telefono) : '';
    caja.appendChild(a);
    if (l.motivo || (l.puntos && l.puntos.length)) {
      const n = document.createElement('div');
      n.className = 'llamada-puntos';
      if (l.motivo) { const p = document.createElement('p'); p.textContent = l.motivo; n.appendChild(p); }
      if (l.puntos && l.puntos.length) {
        const ul = document.createElement('ul');
        for (const x of l.puntos) { const li = document.createElement('li'); li.textContent = x; ul.appendChild(li); }
        n.appendChild(ul);
      }
      caja.appendChild(n);
    }
    return caja;
  }

  // En la app de Android, ADA marca sola (tu orden de voz es la autorización), con 3 segundos para cancelar.
  let llamadaPendiente = null;
  function llamarDirecto(l) {
    if (llamadaPendiente) clearInterval(llamadaPendiente.timer);
    let quedan = 3;
    const cajas = document.querySelectorAll('.entrega-llamada');
    const caja = cajas[cajas.length - 1] || $('#entregas');
    const barra = document.createElement('div');
    barra.className = 'llamada-cuenta';
    barra.innerHTML = '<span></span><button type="button">Cancelar</button>';
    const txt = barra.querySelector('span');
    const pintar = () => { txt.textContent = `Llamando a ${l.nombre || fono(l.telefono)} en ${quedan}…`; };
    pintar();
    caja.appendChild(barra);
    const cancelar = () => { clearInterval(llamadaPendiente && llamadaPendiente.timer); llamadaPendiente = null; barra.remove(); };
    barra.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); cancelar(); aviso('Llamada cancelada.'); });
    llamadaPendiente = {
      timer: setInterval(() => {
        quedan -= 1;
        if (quedan > 0) return pintar();
        cancelar();
        detenerVoz();
        try { window.AdaAndroid.llamar(String(l.telefono)); } catch (_) { location.href = `tel:+${l.telefono}`; }
      }, 1000),
    };
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
  $('#doc-descargar').addEventListener('click', (ev) => { if (docAbierto) descargar('documento', docAbierto.id, ev.currentTarget); });

  // ---------- Voz de ADA ----------
  // Prioridad: voz neuronal del servidor (natural). Respaldo: voz del teléfono.
  const sintesis = window.speechSynthesis;
  const reproductor = new Audio();
  reproductor.preload = 'auto';
  let vozServidor = false;          // se activa si /api/ajustes informa un proveedor
  let vozServidorConfigurada = false; // el servidor tiene voz natural (aunque ahora esté en pausa por fallas)
  let timerVuelveVoz = null;
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
  // Si la voz natural falla (por ejemplo, mientras el servidor se reinicia), se usa la del teléfono
  // un rato y luego se vuelve a intentar la natural. Antes quedaba desactivada toda la sesión.
  function pausarVozServidor() {
    vozServidor = false;
    clearTimeout(timerVuelveVoz);
    timerVuelveVoz = setTimeout(() => {
      if (!vozServidorConfigurada) return;
      vozServidor = true;
      fallosServidor = 0;
      if (!acuses.length) prepararAcuses();
    }, 45000);
  }

  function pedirAudio(frase, señal, reintento = true, { precarga = false } = {}) {
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
      // Un corte de red momentáneo no debe dejar a ADA muda a mitad de frase: se reintenta una vez.
      if (reintento && !(señal && señal.aborted)) return pedirAudio(frase, señal, false, { precarga });
      if (precarga) return null; // los acuses precargados no cuentan como falla de la conversación
      fallosServidor += 1;
      if (fallosServidor >= 2) {
        pausarVozServidor();
        aviso('La voz natural falló; por un momento ADA usará la voz del teléfono.', true);
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
  // Lo que dice ADA mientras trabaja en silencio, según lo que está haciendo.
  function fraseDeAvance(estado, n) {
    const e = (estado || '').toLowerCase();
    let base;
    if (e.includes('leyendo') || e.includes('drive')) base = n === 1 ? 'Sigo revisando los archivos.' : 'Sigo leyendo, es harto material.';
    else if (e.includes('preparando') || e.includes('armando') || e.includes('planilla') || e.includes('editando')) base = n === 1 ? 'Sigo armando el documento, dame un poco más.' : 'Ya casi lo tengo.';
    else if (e.includes('internet')) base = n === 1 ? 'Sigo buscando información.' : 'Estoy cruzando lo que encontré.';
    else if (e.includes('correo')) base = 'Sigo revisando tu correo.';
    else base = n === 1 ? 'Sigo en eso, dame un momento.' : 'Ya casi.';
    return base;
  }

  function crearLocutor({ alEmpezar, antes, alSonar, alFrase, alQuedarLibre } = {}) {
    try { reproductor.volume = 1; } catch (_) {} // por si una interrupción anterior lo dejó bajo
    const cola = [];
    let sono = false;
    const medida = { tts_ms: null };
    const dichas = []; // frases que alcanzaron a sonar (para saber qué escuchó si la interrumpen)
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
        if (!sono) { sono = true; locutor.sonando = true; if (alSonar) alSonar(medida); }
        dichas.push(item.frase);
        locutor.reproduciendo = true;
        if (alFrase) alFrase();
        if (url) { await reproducir(url, cancelado); URL.revokeObjectURL(url); }
        else await decirConNavegador(item.frase, cancelado);
        locutor.reproduciendo = false;
        locutor.ultimaFrase = performance.now();
      }
      trabajando = false;
      // Se quedó sin nada que decir, pero la respuesta sigue (ADA trabajando con herramientas).
      if (!detenido && !cerrado && !cola.length && alQuedarLibre) alQuedarLibre();
      if (detenido || (cerrado && !cola.length)) resolverFin();
    }

    const locutor = {
      decir(texto) {
        if (detenido || silenciada) return;
        const frase = textoParaHablar(texto);
        if (!frase || !/[\p{L}\p{N}]/u.test(frase)) return;
        let audio = null;
        if (vozServidor) {
          const t = performance.now();
          audio = pedirAudio(frase, control.signal);
          if (medida.tts_ms === null) { medida.tts_ms = -1; audio.then(() => { medida.tts_ms = Math.round(performance.now() - t); }); }
        }
        cola.push({ frase, audio });
        bombear();
      },
      cerrar() {
        cerrado = true;
        if (!trabajando && !cola.length) resolverFin();
      },
      detener() {
        if (detenido) return;
        // Interrumpida: quedaba algo por decir (en la cola, sin cerrar, o sonando ahora).
        locutor.interrumpida = cola.length > 0 || !cerrado || trabajando;
        detenido = true;
        cola.length = 0;
        control.abort();
        reproductor.pause();
        if (sintesis) sintesis.cancel();
        resolverFin();
      },
      get hablando() { return empezo && !detenido; },
      get detenido() { return detenido; },
      get ocupado() { return locutor.reproduciendo || cola.length > 0 || trabajando; },
      dichas,
      interrumpida: false,
      sonando: false,
      reproduciendo: false,
      ultimaFrase: 0,
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

  // Detecta si la persona le habla encima a ADA. Para no confundir su propia voz (el parlante)
  // con la de la persona: mide el eco mientras ADA suena, y ante una sospecha baja el volumen
  // y confirma que la voz sigue (el eco baja con el volumen; la voz de la persona no).
  async function vigilarInterrupcion(alDetectar, { bajar = () => {}, subir = () => {} } = {}) {
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
    const eco = []; // niveles recientes mientras ADA habla y nadie la interrumpe
    let activo = 0;
    let sospecha = 0; // cuadros desde que se bajó el volumen
    let terminado = false;
    const inicio = performance.now();
    const nivelEco = () => {
      if (!eco.length) return 0;
      const v = [...eco].sort((a, b) => a - b);
      return v[Math.floor(v.length * 0.9)]; // el 90% del eco queda bajo esto
    };
    const intervalo = setInterval(() => {
      analizador.getFloatTimeDomainData(datos);
      let suma = 0;
      for (const v of datos) suma += v * v;
      const rms = Math.sqrt(suma / datos.length);
      if (performance.now() - inicio < 900) { eco.push(rms); return; } // calibra con ADA ya sonando
      const umbral = Math.max(0.05, nivelEco() * 1.8);
      if (sospecha) {
        // Volumen bajado: si sigue habiendo voz fuerte, es la persona.
        sospecha += 1;
        activo = rms > umbral * 0.8 ? activo + 1 : activo - 2;
        if (activo >= 10) { parar(); alDetectar(); return; }
        if (activo <= 0 || sospecha > 16) { sospecha = 0; activo = 0; subir(); } // era eco o ruido
        return;
      }
      if (rms > umbral) activo += 1;
      else { activo = Math.max(0, activo - 1); eco.push(rms); if (eco.length > 120) eco.shift(); }
      if (activo >= 7) { sospecha = 1; bajar(); } // ~350 ms de voz: se confirma con el volumen bajo
    }, 50);
    function parar() {
      if (terminado) return;
      terminado = true;
      clearInterval(intervalo);
      subir();
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
      const url = await pedirAudio(texto, undefined, true, { precarga: true });
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

  // Busca en la conversación la respuesta de ADA al último mensaje, hasta que aparezca (máx. ~5 minutos).
  let recuperando = null;
  function recuperarRespuesta(conv, texto) {
    if (recuperando) recuperando.cancelar();
    let vivo = true;
    let intentos = 0;
    recuperando = { cancelar: () => { vivo = false; }, revisar: () => revisar() };
    setFase('pensando', 'Se cortó la conexión, pero sigo trabajando…');
    let enCurso = false;
    let proximo = null;
    async function revisar() {
      if (!vivo || enCurso) return;
      enCurso = true;
      clearTimeout(proximo);
      intentos += 1;
      try {
        const d = await api(`/api/conversaciones/${conv}`);
        const iYo = d.mensajes.map((m) => m.rol === 'user' && m.contenido === texto).lastIndexOf(true);
        const resp = iYo >= 0 ? d.mensajes.slice(iYo + 1).find((m) => m.rol === 'assistant') : null;
        if (resp) {
          vivo = false;
          recuperando = null;
          const [hablado, enPantalla] = resp.contenido.split('\n\n[En pantalla]\n');
          mostrarAda(hablado.replace(/\n\[Te interrumpió[^\]]*\]$/, ''));
          mostrarDetalle(enPantalla || '');
          docsActuales = d.documentos.map((x) => ({ id: x.id, titulo: x.titulo }));
          archivosActuales = (d.archivos || []).map((x) => ({ id: x.id, nombre: x.nombre, tipo: x.tipo, drive_url: x.drive_url }));
          pintarEntregas();
          cargarAutorizaciones();
          actualizarEstado();
          setFase('reposo');
          aviso('Listo, aquí está la respuesta.');
          return;
        }
      } catch (_) {}
      enCurso = false;
      if (intentos >= 60) { vivo = false; recuperando = null; setFase('reposo'); aviso('No pude recuperar la respuesta. Pregúntale de nuevo.', true); return; }
      proximo = setTimeout(revisar, 5000);
    }
    proximo = setTimeout(revisar, 3000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && recuperando) recuperando.revisar(); });

  async function enviar(texto, opciones = {}) {
    if (recuperando) { recuperando.cancelar(); recuperando = null; }
    texto = (texto || '').trim();
    if (!texto || ocupado) return null;
    if (llamadasActuales.length) { llamadasActuales = []; pintarEntregas(); }
    // "Modo reunión" / "toma acta de la reunión": abre el modo reunión.
    const n = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/^(ada,? )?(activa |pon(te)? (en )?|abre |entra (en|al) )?(el )?modo reunion\b|^(ada,? )?(toma|tomame|levanta) (el )?acta\b|^(ada,? )?(graba|escucha) (la|esta) reunion\b/.test(n)) {
      location.href = '/reunion.html';
      return null;
    }
    ocupado = true;
    pintarControles();
    mostrarYo(opciones.mostrar || texto);
    mostrarAda('');
    setFase('pensando');

    const hablar = !silenciada;
    const inicio = opciones.desde || performance.now();
    let medicion = null;
    let ultimoEstado = '';
    let terminado = false;
    const opcionesLocutor = {
      alEmpezar: () => setFase('hablando'),
      alFrase: () => setFase('hablando'),
      // Calló pero sigue trabajando: que se vea en qué está (antes quedaba "ADA está hablando" en silencio).
      alQuedarLibre: () => { if (!terminado) setFase('pensando', ultimoEstado || 'Sigo en eso…'); },
      alSonar: (m) => { if (!medicion) medicion = { hasta_audio_ms: Math.round(performance.now() - inicio), medida: m }; },
    };
    let locutor = hablar ? crearLocutor({ ...opcionesLocutor, antes: opciones.antes }) : null;
    // Si trabaja en silencio un buen rato, cuenta en qué está (máximo 3 veces).
    let ultimaActividad = performance.now();
    let avisosAvance = 0;
    const vigiaAvance = setInterval(() => {
      if (terminado || !locutor || locutor.detenido || locutor.ocupado || silenciada) return;
      const quieto = performance.now() - Math.max(ultimaActividad, locutor.ultimaFrase || 0);
      if (quieto > 14000 && avisosAvance < 3) {
        avisosAvance += 1;
        ultimaActividad = performance.now();
        locutor.decir(fraseDeAvance(ultimoEstado, avisosAvance));
      }
    }, 1000);
    let detalleTexto = '';
    mostrarDetalle('');
    const cortador = crearCortador((frase) => locutor && locutor.decir(frase));
    let acumulado = '';
    let resultado = null;
    let errorFlujo = null;

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mensaje: texto, voz: !!opciones.voz, acuse: opciones.acuse || null, conversacion_id: convId, tarjetas: TARJETAS_SOPORTADAS }),
      });
      if (res.status === 401) { salir(); throw new Error('Sesión expirada'); }
      if (!res.ok || !res.body) {
        // Un freno del servidor (pausa, ráfaga de mensajes) termina la conversación por voz: no se reintenta.
        errorFlujo = (await res.json().catch(() => ({}))).error || `Error ${res.status}`;
        throw new Error(errorFlujo);
      }
      await leerFlujo(res, (tipo, d) => {
        if (tipo === 'conversacion') {
          if (d.conversacion_id !== convId) { docsActuales = []; archivosActuales = []; pintarEntregas(); }
          guardarConv(d.conversacion_id);
        } else if (tipo === 'texto') {
          ultimaActividad = performance.now();
          acumulado += d.delta;
          mostrarAda(acumulado);
          cortador.agregar(d.delta);
        } else if (tipo === 'detalle') {
          detalleTexto += d.delta;
          mostrarDetalle(detalleTexto);
        } else if (tipo === 'estado') {
          ultimoEstado = d.texto;
          // Si la interrumpieron antes, lo que diga después de trabajar se habla igual (con un locutor nuevo).
          if (locutor && locutor.detenido && hablar && !silenciada) locutor = crearLocutor(opcionesLocutor);
          if (!locutor || !locutor.reproduciendo) setFase('pensando', d.texto);
        } else if (tipo === 'llamada') {
          llamadasActuales.push(d);
          pintarEntregas();
          if (window.AdaAndroid) llamarDirecto(d);
        } else if (tipo === 'auditoria_propuesta') {
          recibirPropuestaAuditoria(d);
        } else if (tipo === 'consentimiento_extracciones') {
          consentimientoPendiente = d;
          pintarEntregas();
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
      terminado = true;
      clearInterval(vigiaAvance);
      if (errorFlujo) throw new Error(errorFlujo);
      if (!resultado) throw new Error('La respuesta se cortó');
      cortador.terminar();
      if (locutor) locutor.cerrar();
      mostrarAda(resultado.respuesta);
      if (resultado.detalle) mostrarDetalle(resultado.detalle);
      if (locutor) {
        const convInt = convId;
        locutor.fin.then(() => {
          if (!locutor.interrumpida || !convInt) return;
          // La última frase quedó a medias: lo seguro es contar solo las anteriores como escuchadas.
          const escuchado = locutor.dichas.slice(0, -1).join(' ');
          api(`/api/conversaciones/${convInt}/interrumpida`, { method: 'POST', body: JSON.stringify({ escuchado }) }).catch(() => {});
        });
      }
      if (locutor && opciones.voz) {
        const convMedida = convId;
        locutor.fin.then(() => {
          if (!medicion) return;
          api('/api/metricas', { method: 'POST', body: JSON.stringify({ conversacion_id: convMedida, hasta_audio_ms: medicion.hasta_audio_ms, tts_ms: medicion.medida.tts_ms > 0 ? medicion.medida.tts_ms : undefined }) }).catch(() => {});
        });
      }
      if (resultado.documentos && resultado.documentos.length && !opciones.voz) {
        abrirDocumento(resultado.documentos[resultado.documentos.length - 1].id);
      }
      actualizarEstado();
      if ((resultado.acciones || []).some((x) => x.herramienta === 'proponer_mensaje')) cargarAutorizaciones();
      // Si ADA propuso una auditoría, se relee desde el servidor: la tarjeta aparece aunque el evento se haya perdido.
      if ((resultado.acciones || []).some((x) => /auditoria/.test(x.herramienta || ''))) cargarAuditoriasActivas();
      return { respuesta: resultado.respuesta, locutor };
    } catch (e) {
      terminado = true;
      clearInterval(vigiaAvance);
      if (locutor) locutor.detener();
      // Se cortó la conexión (celular en segundo plano, mala señal) pero ADA sigue trabajando en el servidor:
      // se espera su respuesta en vez de darla por perdida.
      if (!errorFlujo && convId) {
        recuperarRespuesta(convId, texto);
        return null;
      }
      aviso(`${e.message}. Inténtalo de nuevo.`, true);
      return null;
    } finally {
      ocupado = false;
      pintarControles();
      if (!conversando && !recuperando) {
        if (locutor) {
          locutor.fin.then(() => { if (!conversando && !ocupado && !recuperando) setFase('reposo'); });
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

  function iniciarConversacion(primerMensaje) {
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
    if (typeof primerMensaje === 'string') turnoDeAda(primerMensaje); // ADA habla primero
    else escucharTurno();
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
    if (ocupado) detenerTrabajo(); // terminar la conversación también detiene el trabajo en curso
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
    recargarSiHayVersion();
  }

  // Si la frase quedó a medias ("el correo de…"), espera un poco más antes de responder.
  const CONECTORES = /(?:^|\s)(de|del|el|la|los|las|un|una|que|y|o|a|al|en|con|para|por|pero|porque|como|mi|tu|su|sus|mis|eh|em|este|esta|osea|o sea|entonces|cuando|donde|si|le|les|lo|me|se|muy|más|mas|hasta|desde|sobre|entre)$/i;
  const CORTAS_COMPLETAS = /^(sí|si|no|ya|ok|okay|dale|listo|gracias|chao|chau|bueno|perfecto|claro|exacto|nada|hola)\b/i;
  function graciaPara(t) {
    const limpio = t.trim().replace(/[.!?…]+$/, '');
    if (/,$/.test(limpio) || CONECTORES.test(limpio)) return 2300;
    const n = limpio.split(/\s+/).length;
    if (n <= 2 && !CORTAS_COMPLETAS.test(limpio)) return 1200;
    return 0;
  }
  const unir = (a, b) => [a, b].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  let acumulado = '';
  let timerGracia;

  function escucharTurno(continuar = false) {
    if (!conversando) return;
    if (!continuar) acumulado = '';
    textoFinal = '';
    textoParcial = '';
    setFase('escuchando', continuar ? 'Te sigo escuchando…' : undefined);
    if (!continuar) fetch('/api/precalentar', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
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
      mostrarYo(unir(acumulado, textoActual()));
      clearTimeout(timerGracia);
      clearTimeout(timerSilencio);
      timerSilencio = setTimeout(() => { if (rec) rec.stop(); }, SILENCIO_MS);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        aviso(window.AdaAndroid ? 'ADA no tiene permiso para el micrófono. Actívalo en Ajustes del teléfono → Apps → ADA → Permisos.' : 'ADA no tiene permiso para usar el micrófono. Actívalo en los ajustes del navegador.', true);
        detenerVoz();
      } else if (e.error === 'network' || e.error === 'audio-capture' || e.error === 'sin-deepgram') {
        aviso(e.error === 'audio-capture' ? 'No pude usar el micrófono (¿otra app lo está ocupando?).' : 'Se cortó la escucha; vuelvo a intentar.', true);
      }
    };
    rec.onend = () => {
      clearTimeout(timerSilencio);
      clearTimeout(timerGracia);
      rec = null;
      if (!conversando) return;
      const nuevo = textoActual();
      const t = unir(acumulado, nuevo);
      // Terminó la espera extra sin que dijera nada más: se responde con lo acumulado.
      if (continuar && !nuevo && t) { silenciosSeguidos = 0; turnoDeAda(t); return; }
      if (t && nuevo) {
        const espera = graciaPara(t);
        if (espera) {
          acumulado = t;
          escucharTurno(true);
          timerGracia = setTimeout(() => { if (rec) rec.stop(); }, espera);
          return;
        }
      }
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
    const desde = performance.now();
    acumulado = '';
    setFase('pensando');
    const acuse = decirAcuse();
    const r = await enviar(texto, { voz: true, acuse: acuse && acuse.texto, antes: acuse && acuse.termino, desde });
    if (!conversando) return;
    if (!r) { detenerVoz(); return; }
    if (r.locutor) {
      // Mientras ADA habla, si Cristian habla encima, ella se calla y lo escucha.
      let pararVigia = () => {};
      const empezarVigia = async () => {
        pararVigia = await vigilarInterrupcion(() => {
          if (r.locutor) r.locutor.detener();
          setFase('escuchando', 'Te escuché, te escucho…');
        }, {
          bajar: () => { reproductor.volume = 0.25; },
          subir: () => { reproductor.volume = 1; },
        });
      };
      // Se vigila recién cuando el audio suena de verdad (antes, el silencio engañaba la calibración).
      const vigiaTardio = setInterval(() => { if (r.locutor.sonando) { clearInterval(vigiaTardio); empezarVigia(); } }, 120);
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
    // Mientras ADA trabaja (fuera de una conversación por voz), el botón la detiene de verdad.
    btnHablar.disabled = false;
    if (ocupado && !conversando) $('#hablar-texto').textContent = 'Detener';
    btnHablar.classList.toggle('detener', ocupado && !conversando);
    $('#enviar').disabled = ocupado;
    $('#cerrar-conv').hidden = conversando || !convId;
  }

  function detenerTrabajo() {
    api('/api/cancelar', { method: 'POST' }).then((r) => { if (r.cancelado) aviso('Detengo el trabajo…'); }).catch(() => {});
  }
  btnHablar.addEventListener('click', () => {
    if (ocupado && !conversando) { detenerTrabajo(); return; }
    if (conversando) cerrarConversacion();
    else iniciarConversacion();
  });

  // Tocar cualquier parte del escenario mientras ADA habla la hace callar.
  $('.escenario').addEventListener('click', (e) => {
    if (e.target.id === 'cerrar-conv') return;
    if (locutorActual && locutorActual.reproduciendo) detenerHabla();
    else if (ocupado) setFase('pensando', 'Sigo trabajando en esto…'); // tocar mientras trabaja no la calla
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
    deepgram: 'Voz natural de Deepgram ✓',
    google: 'Voz natural de Google ✓',
    elevenlabs: 'Voz natural de ElevenLabs ✓',
    openai: 'Voz natural de OpenAI ✓',
    navegador: 'Voz del teléfono (robótica). Para una voz natural, configura una clave de voz en Railway.',
  };

  async function cargarAjustes() {
    try {
      const a = await api('/api/ajustes');
      const antes = vozServidor;
      vozServidorConfigurada = a.voz.proveedor !== 'navegador';
      vozServidor = vozServidorConfigurada;
      fallosServidor = 0;
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
      const faltan = g.faltan_permisos || [];
      const nombres = [...new Set(faltan.map((p) => (p.startsWith('gmail') ? 'Gmail' : p.startsWith('contacts') ? 'Contactos' : p.startsWith('drive') ? 'Drive' : 'Calendar')))];
      if (nombres.length) {
        ayuda.hidden = false;
        ayuda.textContent = `Falta darle acceso a: ${nombres.join(', ')}. Reconecta y marca "Seleccionar todo" en los permisos de Google.`;
        acciones.appendChild(botonConectar(`Reconectar para dar acceso a ${nombres.join(' y ')}`));
      }
      // Diagnóstico: ¿ADA puede leer de verdad los contactos de Google?
      const pc = document.createElement('button');
      pc.type = 'button';
      pc.textContent = 'Probar contactos';
      pc.addEventListener('click', async () => {
        pc.disabled = true;
        pc.textContent = 'Revisando…';
        try {
          const r = await api('/api/google/contactos/prueba');
          ayuda.hidden = false;
          ayuda.textContent = r.error
            ? `✗ Contactos no disponibles: ${r.error}`
            : `✓ ADA ve ${r.total} contactos de Google${r.ejemplos.length ? ` (por ejemplo: ${r.ejemplos.join(', ')})` : ''}.`;
        } catch (e) { ayuda.hidden = false; ayuda.textContent = `✗ ${e.message}`; }
        pc.disabled = false;
        pc.textContent = 'Probar contactos';
      });
      acciones.appendChild(pc);
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
    $('#op-tareas').checked = !a.preferencias || a.preferencias.tareas_auto !== false;
    pintarAvisos(a);
    if (a.usuario) {
      yo = a.usuario;
      $('#sesion-de').textContent = `Entraste como ${a.usuario.nombre}${a.usuario.admin ? ' (administrador)' : ''}.`;
      $('#ajuste-personas').hidden = !a.usuario.admin;
      $('#ajuste-lab').hidden = !a.usuario.admin;
      $('#ajuste-cifrado').hidden = !a.usuario.admin;
      $('#ajuste-auditoria').hidden = !a.usuario.admin;
      if (a.usuario.admin) { pintarCifrado(); pintarDocumentosGuardados(); pintarAuditorias(); pintarPendientesAjustes(); }
      if (a.usuario.admin) pintarPersonas();
    }
    $('#ia-estado').textContent = `Modelos: ${a.modelo} · Búsqueda en internet: ${a.internet ? 'activa ✓' : 'desactivada'}`;
    const modo = (a.preferencias && a.preferencias.modelo_modo) || 'auto';
    $$('#modelo-modo [data-modo]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.modo === modo)));
    pintarTiempos(a.tiempos);
  }

  $('#op-tareas').addEventListener('change', async (e) => {
    try {
      await api('/api/preferencias', { method: 'POST', body: JSON.stringify({ tareas_auto: e.target.checked }) });
      aviso(e.target.checked ? 'ADA agendará tus tareas en Google Calendar.' : 'ADA ya no agendará tareas sola.');
    } catch (err) {
      e.target.checked = !e.target.checked;
      aviso(err.message, true);
    }
  });

  // Tiempos y costos medidos (para comparar y saber dónde se va la demora).
  function pintarTiempos(t) {
    const cont = $('#ia-tiempos');
    cont.innerHTML = '';
    if (!t || !t.turnos) { cont.innerHTML = '<p class="meta">Conversa unos turnos por voz y aquí verás los tiempos.</p>'; return; }
    const seg = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '—');
    const e = t.etapas || {};
    const filas = [
      ['ADA empieza a hablar', e.hasta_que_habla], ['Preparar contexto', e.contexto], ['Primera palabra del modelo', e.primer_texto],
      ['Herramientas', e.herramientas], ['Voz (primera frase)', e.voz_primera_frase], ['Respuesta completa', e.total_servidor],
    ];
    const t1 = document.createElement('table');
    t1.innerHTML = `<caption>Últimos ${t.turnos} turnos</caption><tr><th>Etapa</th><th>Mediana</th><th>Peor 5%</th></tr>` +
      filas.map(([n, v]) => `<tr><td>${n}</td><td>${seg(v && v.mediana)}</td><td>${seg(v && v.p95)}</td></tr>`).join('');
    cont.appendChild(t1);
    if (t.modelos && t.modelos.length) {
      const t2 = document.createElement('table');
      const nombre = (m) => (m.nivel === 'profundo' ? 'A fondo' : m.nivel === 'rapido' ? 'Rápido' : m.nivel);
      t2.innerHTML = '<caption>Por modelo</caption><tr><th>Modo</th><th>Turnos</th><th>Empieza a hablar</th><th>Costo por turno</th></tr>' +
        t.modelos.map((m) => `<tr><td>${nombre(m)}<br><small>${m.modelo}</small></td><td>${m.turnos}</td><td>${seg(m.hasta_que_habla_ms ?? m.primer_texto_ms)}</td><td>${(m.costo_promedio_usd * 950).toFixed(1)} pesos</td></tr>`).join('');
      cont.appendChild(t2);
      const nota = document.createElement('p');
      nota.className = 'meta';
      nota.textContent = 'Costo aproximado (dólar a 950 pesos), según los precios publicados de cada modelo.';
      cont.appendChild(nota);
    }
  }
  $$('#modelo-modo [data-modo]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/api/preferencias', { method: 'POST', body: JSON.stringify({ modelo_modo: b.dataset.modo }) });
      $$('#modelo-modo [data-modo]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      aviso(b.dataset.modo === 'auto' ? 'ADA elegirá el modelo según la conversación.' : b.dataset.modo === 'rapido' ? 'ADA usará siempre el modelo rápido.' : 'ADA usará siempre el modelo para pensar a fondo.');
    } catch (e) { aviso(e.message, true); }
  }));

  // ---------- Personas de la prueba (solo Cristian) ----------

  // Estado de la clave de cifrado (solo lectura, solo administrador). Nunca recibe ni muestra la clave.
  // ---------- Auditoría mínima (Fase 3c) ----------
  const FICTICIOS = [
    'R1 | La sala debe contar con un extintor PQS de al menos 6 kg con carga vigente. | cumple',
    'R2 | Debe existir un plano de evacuación visible en cada piso del recinto (el recinto tiene 2 pisos). | parcial',
    'R3 | Si se esterilizan materiales en el recinto, el autoclave debe tener validación anual vigente. | no_aplica_justificado',
  ];
  function datosAuditoria() {
    const lineas = $('#aud-requisitos').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const requisitos = []; const esperado = [];
    lineas.forEach((l, i) => {
      const [id, texto, est] = l.split('|').map((x) => (x || '').trim());
      const rid = texto ? id : `R${i + 1}`;
      requisitos.push({ id: rid, texto: texto || id });
      if (est) esperado.push({ id: rid, estado: est });
    });
    return { archivo_id: $('#aud-archivo').value.trim(), requisitos, esperado, configuracion: $('#aud-config').value };
  }
  const usd = (n) => `US$${Number(n || 0).toFixed(4).replace('.', ',')}`;
  $('#aud-ficticios').addEventListener('click', () => { $('#aud-requisitos').value = FICTICIOS.join('\n'); });
  $('#aud-estimar').addEventListener('click', async () => {
    const out = $('#aud-estimacion');
    try {
      const d = datosAuditoria();
      const e = await api('/api/auditorias/estimar', { method: 'POST', body: JSON.stringify(d) });
      const k = d.configuracion;
      const minimo = k === 'comparar' ? e.presupuesto_minimo_comparar : e.presupuesto_minimo[k];
      out.textContent = `Peor caso estimado: K1 ${usd(e.por_configuracion.K1)} · K2 ${usd(e.por_configuracion.K2)} · K3 ${usd(e.por_configuracion.K3)}. Presupuesto mínimo para ${k === 'comparar' ? 'las tres' : k}: ${usd(minimo)}. ${e.nota}`;
      if (!$('#aud-presupuesto').value) $('#aud-presupuesto').value = String(Math.ceil(minimo * 100) / 100);
    } catch (err) { out.textContent = err.message; }
    out.hidden = false;
  });
  $('#aud-empezar').addEventListener('click', async () => {
    const d = { ...datosAuditoria(), presupuesto: parseFloat($('#aud-presupuesto').value) };
    if (!confirm(`¿Apruebas estos ${d.requisitos.length} requisitos y un presupuesto de US$${d.presupuesto} para ${d.configuracion === 'comparar' ? 'K1, K2 y K3' : d.configuracion}?`)) return;
    try { await api('/api/auditorias', { method: 'POST', body: JSON.stringify(d) }); aviso('Auditoría en marcha.'); pintarAuditorias(); }
    catch (err) { aviso(err.message, true); }
  });
  $('#aud-actualizar').addEventListener('click', () => { pintarAuditorias(); pintarPendientesAjustes(); });
  let audTimer = null;
  async function pintarAuditorias() {
    const cont = $('#aud-lista');
    let lista = [];
    try { lista = await api('/api/auditorias'); } catch (err) { cont.textContent = err.message; return; }
    cont.innerHTML = '';
    if (!lista.length) cont.textContent = 'Aún no hay auditorías.';
    for (const a of lista) {
      const c = document.createElement('div');
      c.className = 'aud-tarjeta';
      const titulo = document.createElement('strong'); titulo.textContent = `${a.config || ''} · ${a.estado_real || a.estado}`;
      const meta = document.createElement('p'); meta.className = 'meta';
      const prec = a.precision ? ` · precisión ${a.precision.aciertos}/${a.precision.total}` : '';
      meta.textContent = a.costos ? `Costo real ${usd(a.costos.real_usd)} en ${a.costos.llamadas} llamadas · reservas acumuladas ${usd(a.costos.reservado_total_usd)} · reserva activa ahora ${usd(a.reservado_usd)} · presupuesto ${usd(a.presupuesto_usd)}${prec}${a.modelos && a.modelos.length ? ` · ${a.modelos.join(' / ')}` : ''}${a.motivo && a.estado !== 'completado' ? ` · ${a.motivo}` : ''}` : (a.motivo || '');
      c.append(titulo, meta);
      if (!a.matriz && a.pasos_detalle) {
        const ul = document.createElement('ul');
        for (const x of a.pasos_detalle) { const li = document.createElement('li'); li.textContent = `${x.paso}: ${x.estado}${x.resultado ? ` → ${x.resultado}${x.cita_verificada ? ' (cita verificada)' : ''}` : ''}${x.error ? ` · ${x.error}` : ''}`; ul.appendChild(li); }
        c.appendChild(ul);
      }
      if (a.estado === 'bloqueado') {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Reintentar desde el paso que falló';
        b.addEventListener('click', async () => { if (!confirm('¿Reintentar desde el paso que falló? Lo ya hecho se conserva y no se vuelve a pagar.')) return; try { await api(`/api/trabajos/${a.id}/reintentar`, { method: 'POST' }); pintarAuditorias(); } catch (err) { aviso(err.message, true); } });
        c.appendChild(b);
      }
      if (a.matriz) {
        const ul = document.createElement('ul');
        for (const f of a.matriz) { const li = document.createElement('li'); li.textContent = `${f.requisito}: ${f.estado}${f.cita_verificada ? ` (cita verificada, ${f.ubicacion})` : ''}`; ul.appendChild(li); }
        c.appendChild(ul);
      }
      const botones = document.createElement('div'); botones.className = 'ajuste-botones';
      if (a.estado === 'completado') {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Descargar Excel';
        b.addEventListener('click', () => descargar('auditoria', a.id, b));
        botones.appendChild(b);
      }
      if (['ejecutando', 'pausado', 'pausado_presupuesto', 'bloqueado', 'propuesto'].includes(a.estado)) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Cancelar';
        b.addEventListener('click', async () => { try { await api(`/api/trabajos/${a.id}/cancelar`, { method: 'POST' }); pintarAuditorias(); } catch (err) { aviso(err.message, true); } });
        botones.appendChild(b);
      }
      if (botones.children.length) c.appendChild(botones);
      cont.appendChild(c);
    }
    clearTimeout(audTimer);
    if (lista.some((a) => a.estado === 'ejecutando') && !$('#vista-ajustes').hidden) audTimer = setTimeout(pintarAuditorias, 3000);
  }

  async function pintarCifrado() {
    const pon = (id, t, clase) => { const e = $(id); e.textContent = t; e.className = clase || ''; };
    pon('#cif-configurada', 'Consultando…');
    try {
      const c = await api('/api/cifrado');
      pon('#cif-configurada', c.configurada ? 'Sí' : 'No', c.configurada ? 'cif-ok' : 'cif-mal');
      pon('#cif-id', c.id_clave && /^[0-9a-f]{8}$/.test(c.id_clave) ? c.id_clave : '—');
      pon('#cif-anterior', c.anterior ? 'Sí' : 'No');
      pon('#cif-error', c.error ? String(c.error) : 'Ninguno', c.error ? 'cif-mal' : '');
    } catch (e) {
      pon('#cif-configurada', 'No se pudo consultar', 'cif-mal');
      pon('#cif-id', '—'); pon('#cif-anterior', '—'); pon('#cif-error', e.message, 'cif-mal');
    }
  }
  $('#cif-revisar').addEventListener('click', pintarCifrado);

  // Documentos guardados (Fase 3b): estado del consentimiento, cuántos hay y botones para borrar. Nunca muestra texto.
  async function pintarDocumentosGuardados() {
    const caja = $('#docs-guardados');
    try {
      const r = await api('/api/extracciones');
      const est = r.consentimiento.estado;
      $('#dg-modo').textContent = r.modo === 'prueba'
        ? `Prueba: solo se abre la carpeta …${r.carpeta_prueba_termina_en || '(falta configurar)'}; el resto de Drive está bloqueado`
        : r.modo === 'si' ? 'Encendido (todos tus documentos)' : 'Apagado (lee sin guardar)';
      $('#dg-consentimiento').textContent = est === 'aceptado' ? `Aceptado (${new Date(r.consentimiento.fecha).toLocaleDateString('es-CL')})` : est === 'rechazado' ? 'No guardar' : 'Sin responder';
      $('#dg-cantidad').textContent = `${r.documentos} (${Math.round(r.caracteres / 1000)} mil caracteres)`;
      $('#dg-retencion').textContent = `${r.retencion_dias} días desde que se extrae`;
      $('#dg-temporales').textContent = String(r.temporales_pendientes);
      $('#dg-aceptar').hidden = est === 'aceptado';
      $('#dg-retirar').hidden = est !== 'aceptado';
      $('#dg-reintentar').hidden = !r.temporales_pendientes;
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      const m = await api(`/api/extracciones/metricas?desde=${encodeURIComponent(hoy.toISOString())}`);
      const filas = [['Documentos únicos', m.documentos_unicos], ['Consultas de permisos y versión', m.consultas_metadatos], ['Descargas de contenido', m.descargas],
        ['Extracciones nuevas (cifradas)', m.extracciones_nuevas], ['Reutilizaciones', m.reutilizaciones], ['Lecturas sin guardar', m.lecturas_sin_guardar],
        ['Operaciones redundantes', m.operaciones_redundantes], ['Lecturas bloqueadas fuera de la carpeta', m.bloqueados_fuera_de_prueba],
        ['Escrituras bloqueadas fuera de la carpeta', m.escrituras_bloqueadas], ['Intentos de escritura en Drive', m.escrituras_drive_intentadas],
        ['Escrituras en Drive sin error', m.escrituras_drive_sin_error], ['Reintentos', m.reintentos_justificados]];
      const dl = $('#dg-metricas');
      dl.innerHTML = '';
      for (const [k, v] of filas) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = String(v ?? 0); dl.append(dt, dd); }
      const ev = await api(`/api/extracciones/eventos?desde=${encodeURIComponent(hoy.toISOString())}`);
      const NOMBRES = { consulta_metadatos: 'verificó acceso', descarga: 'descargó', extraccion_nueva: 'extracción nueva cifrada', extraccion_sin_guardar: 'leyó sin guardar',
        reutilizacion: 'reutilizó lo guardado', bloqueado_prueba: 'lectura bloqueada (fuera de la carpeta)', escritura_bloqueada: 'escritura bloqueada (fuera de la carpeta)',
        invalidacion: 'invalidó', sin_acceso: 'sin acceso', verificacion_fallida: 'no pudo verificar', reintento: 'reintento', redundante: 'REDUNDANTE',
        temporal_borrado: 'borró copia temporal', temporal_fallido: 'copia temporal sin borrar', vencida: 'vencida', borrado: 'borrado' };
      const hora = (h) => new Date(h).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const lineas = [...ev.extracciones.map((e) => [e.hora, `${hora(e.hora)} · ${NOMBRES[e.evento] || e.evento}${e.archivo ? ` · ${e.archivo}` : ''}${e.motivo ? ` · ${e.motivo}` : ''}`]),
        ...ev.escrituras_drive.map((o) => [o.hora, `${hora(o.hora)} · ${o.herramienta} · ${o.ok ? 'hecho' : `no hecho: ${o.error}`}`])]
        .sort((a, b) => new Date(b[0]) - new Date(a[0])).map((x) => x[1]);
      const det = $('#dg-detalle');
      det.innerHTML = '';
      if (!lineas.length) det.textContent = 'Sin actividad hoy.';
      for (const l of lineas.slice(0, 60)) { const d = document.createElement('div'); d.textContent = l; det.appendChild(d); }
      caja.hidden = false;
    } catch (e) {
      $('#dg-consentimiento').textContent = e.message;
      caja.hidden = false;
    }
  }
  $('#dg-verif-generar').addEventListener('click', async () => {
    const dia = $('#dg-verif-desde').value || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    $('#dg-verif-desde').value = dia;
    $('#dg-verif-json').textContent = 'Preparando…';
    $('#dg-verif-salida').hidden = false;
    try {
      const desde = new Date(`${dia}T00:00:00`);
      const r = await api(`/api/extracciones/verificacion?desde=${encodeURIComponent(desde.toISOString())}`);
      $('#dg-verif-json').textContent = JSON.stringify(r, null, 2);
    } catch (e) { $('#dg-verif-json').textContent = e.message; }
  });
  $('#dg-verif-copiar').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#dg-verif-json').textContent); aviso('Informe copiado.'); }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('#dg-verif-json')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); aviso('Selecciónalo y cópialo.'); }
  });
  $('#dg-aceptar').addEventListener('click', async () => {
    try { await api('/api/extracciones/consentimiento', { method: 'POST', body: JSON.stringify({ acepto: true }) }); consentimientoPendiente = null; pintarEntregas(); aviso('Listo: guardo cifrado lo que extraiga (máx. 30 días).'); } catch (e) { aviso(e.message, true); }
    pintarDocumentosGuardados();
  });
  $('#dg-retirar').addEventListener('click', async () => {
    if (!confirm('¿Dejar de guardar y borrar todos los documentos guardados?')) return;
    try { const r = await api('/api/extracciones/consentimiento', { method: 'POST', body: JSON.stringify({ acepto: false }) }); aviso(`Listo: no guardo más y borré ${r.borradas} documento(s).`); } catch (e) { aviso(e.message, true); }
    pintarDocumentosGuardados();
  });
  $('#dg-borrar').addEventListener('click', async () => {
    if (!confirm('¿Borrar todos los documentos guardados? Se volverán a extraer cuando hagan falta.')) return;
    try { const r = await api('/api/extracciones', { method: 'DELETE' }); aviso(`Borré ${r.borradas} documento(s) guardado(s).`); } catch (e) { aviso(e.message, true); }
    pintarDocumentosGuardados();
  });
  $('#dg-reintentar').addEventListener('click', async () => {
    try { const r = await api('/api/extracciones/temporales/reintentar', { method: 'POST' }); aviso(`Copias temporales: ${r.borrados} borradas, ${r.fallidos} con error, ${r.omitidos} sin la marca de ADA (no se tocaron).`); } catch (e) { aviso(e.message, true); }
    pintarDocumentosGuardados();
  });

  // Exportación del diagnóstico (solo Cristian).
  $('#diag-buscar').addEventListener('click', async () => {
    const lista = $('#diag-lista');
    lista.textContent = 'Buscando…';
    try {
      const convs = await api(`/api/diagnostico/conversaciones?dia=${encodeURIComponent($('#diag-dia').value)}`);
      lista.innerHTML = convs.length ? '' : '<p class="meta">No hay conversaciones ese día.</p>';
      for (const c of convs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'diag-conv';
        b.textContent = `${new Date(c.inicio).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })} · ${c.titulo || 'Sin título'} · ${c.mensajes} mensajes`;
        b.addEventListener('click', async () => {
          $('#diag-json').textContent = 'Preparando…';
          $('#diag-salida').hidden = false;
          try {
            const opciones = [$('#diag-texto').checked ? 'texto=1' : '', $('#diag-registros').checked ? 'registros=1' : ''].filter(Boolean).join('&');
            const d = await api(`/api/diagnostico/conversaciones/${c.id}${opciones ? `?${opciones}` : ''}`);
            $('#diag-json').textContent = JSON.stringify(d, null, 2);
          } catch (e) { $('#diag-json').textContent = e.message; }
        });
        lista.appendChild(b);
      }
    } catch (e) { lista.textContent = e.message; }
  });
  $('#diag-copiar').addEventListener('click', async () => {
    const t = $('#diag-json').textContent;
    try { await navigator.clipboard.writeText(t); aviso('Diagnóstico copiado.'); }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('#diag-json')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); aviso('Selecciónalo y cópialo.'); }
  });

  // Gasto por mensaje: cada turno con sus llamadas a Claude, modelos, tokens y herramientas (sin contenido).
  async function pintarGastoTurnos() {
    const caja = $('#gasto-turnos');
    let turnos = [];
    try { turnos = await api('/api/gasto/turnos'); } catch (_) { caja.hidden = true; return; }
    caja.hidden = !turnos.length;
    const lista = $('#gasto-lista');
    lista.innerHTML = '';
    const usd = (n) => `US$${Number(n || 0).toFixed(3).replace('.', ',')}`;
    const miles = (n) => `${Math.round((n || 0) / 1000)}k`;
    for (const t of turnos.slice(0, 40)) {
      const d = document.createElement('details');
      d.className = 'gasto-turno';
      const h = new Date(t.inicio);
      const quien = t.usuario_id === 1 ? '' : ` · invitado ${t.usuario_id}`;
      d.innerHTML = '<summary><span class="g-hora"></span><span class="g-que"></span><strong class="g-usd"></strong></summary><div class="g-det">Cargando…</div>';
      d.querySelector('.g-hora').textContent = h.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
      d.querySelector('.g-que').textContent = `${t.llamadas} llamada${t.llamadas === 1 ? '' : 's'} · ${String(t.modelos || '').replace(/claude-/g, '')} · ${miles(t.entrada)} entrada / ${miles(t.salida)} salida${t.busquedas ? ` · ${t.busquedas} búsq.` : ''}${t.encargo_id ? ` · encargo #${t.encargo_id}` : ''}${quien}${t.error ? ' · ⚠' : ''}`;
      d.querySelector('.g-usd').textContent = usd(t.costo_usd);
      d.addEventListener('toggle', async () => {
        if (!d.open || d.dataset.cargado) return;
        d.dataset.cargado = '1';
        try {
          const det = await api(`/api/gasto/turnos/${t.turno_id}`);
          const div = d.querySelector('.g-det');
          div.innerHTML = '';
          for (const l of det.llamadas) {
            const p = document.createElement('p');
            p.textContent = `Paso ${l.paso} · ${l.modelo.replace('claude-', '')} · ${(l.duracion_ms / 1000 || 0).toFixed(1)} s · ${l.input_tokens} ent / ${l.output_tokens} sal / caché ${l.cache_creacion}+${l.cache_lectura} · ${usd(l.costo_usd)} · ${l.stop_reason || ''}${l.herramientas ? ` → ${l.herramientas}` : ''}${l.error ? ` · error: ${l.error}` : ''}`;
            div.appendChild(p);
          }
          if (det.herramientas.length) {
            const ul = document.createElement('ul');
            for (const o of det.herramientas) {
              const li = document.createElement('li');
              li.textContent = `${o.herramienta}${o.objetivo ? ` (${o.objetivo})` : ''}${o.repetida ? ' · repetida, no se ejecutó' : ''}${o.ok ? '' : ` · error: ${o.error}`}`;
              ul.appendChild(li);
            }
            div.appendChild(ul);
          }
        } catch (e) { d.querySelector('.g-det').textContent = e.message; }
      });
      lista.appendChild(d);
    }
  }

  async function pintarPersonas() {
    const cont = $('#lista-personas');
    let lista = [];
    let consumo = null;
    try { [lista, consumo] = await Promise.all([api('/api/usuarios'), api('/api/consumo').catch(() => null)]); } catch (e) { cont.textContent = e.message; return; }
    const usd = (n) => `US$${(n || 0).toFixed(2).replace('.', ',')}`;
    const gasto = (id) => consumo && consumo.personas.find((x) => x.id === id);
    const res = $('#consumo-resumen');
    if (consumo) {
      const yo = gasto(1) || {};
      res.textContent = `Gasto estimado en IA este mes: ${usd(consumo.total_mes)} (hoy ${usd(consumo.total_hoy)}). Tú: ${usd(yo.mes)}.`
        + (consumo.tope_invitado > 0 ? ` Tope por invitado: ${usd(consumo.tope_invitado)} al día; al pasarlo sigue con el modelo rápido.` : '');
      res.hidden = false;
    }
    pintarGastoTurnos();
    $('#diag').hidden = false;
    if (!$('#diag-dia').value) $('#diag-dia').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    cont.innerHTML = '';
    if (!lista.length) { cont.innerHTML = '<p class="meta">Aún no invitas a nadie.</p>'; return; }
    for (const p of lista) {
      const fila = document.createElement('div');
      fila.className = `persona${p.activo ? '' : ' inactiva'}`;
      fila.innerHTML = '<div class="quien"><strong></strong><small></small></div><button type="button" class="nueva"></button><button type="button" class="activo"></button>';
      const nombre = p.nota && p.nota !== p.nombre && p.nombre !== 'Invitado' ? `${p.nombre} (${p.nota})` : p.nombre;
      fila.querySelector('strong').textContent = nombre;
      fila.querySelector('small').textContent = !p.activo ? 'Sin acceso'
        : p.ultimo_ingreso ? `Último ingreso: ${fechaCorta(p.ultimo_ingreso)}` : 'Todavía no entra';
      const g = gasto(p.id);
      if (g && g.mes > 0) {
        fila.querySelector('small').textContent += ` · Hoy ${usd(g.hoy)} · Mes ${usd(g.mes)}`
          + (g.profundo_mes > 0 ? ` (${Math.round((g.profundo_mes / g.mes) * 100)}% Sonnet)` : '')
          + (consumo.tope_invitado > 0 && g.hoy >= consumo.tope_invitado ? ' · llegó al tope de hoy' : '');
      }
      const nueva = fila.querySelector('.nueva');
      nueva.textContent = 'Nueva clave';
      nueva.addEventListener('click', async () => {
        try {
          const r = await api(`/api/usuarios/${p.id}/clave`, { method: 'POST' });
          mostrarInvitacion(p.nota || p.nombre, r.clave);
          pintarPersonas();
        } catch (e) { aviso(e.message, true); }
      });
      const act = fila.querySelector('.activo');
      act.textContent = p.activo ? 'Quitar acceso' : 'Devolver acceso';
      act.addEventListener('click', async () => {
        try {
          await api(`/api/usuarios/${p.id}/activo`, { method: 'POST', body: JSON.stringify({ activo: !p.activo }) });
          aviso(p.activo ? `${nombre} ya no puede entrar.` : `${nombre} puede volver a entrar.`);
          pintarPersonas();
        } catch (e) { aviso(e.message, true); }
      });
      cont.appendChild(fila);
    }
  }

  let invitacionTexto = '';
  function mostrarInvitacion(para, clave) {
    $('#inv-para').textContent = para || 'la persona';
    $('#inv-clave').textContent = clave;
    invitacionTexto = `Hola${para ? ` ${para}` : ''}, te invito a probar ADA, mi asistente personal con IA.\n\n` +
      `1. Entra a ${location.origin}\n2. Escribe tu nombre y esta clave: ${clave}\n` +
      '3. Instálala en tu teléfono: en Chrome, menú ⋮ → "Instalar app" (en iPhone: Safari → Compartir → "Agregar a inicio").\n\n' +
      'Háblale como a una asistente: cuéntale qué tienes que hacer, tus pendientes y tus ideas. Cada uno tiene su propia ADA, privada.';
    $('#invitacion').hidden = false;
  }
  $('#form-persona').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nota = $('#persona-nota').value.trim();
    try {
      const r = await api('/api/usuarios', { method: 'POST', body: JSON.stringify({ nota }) });
      $('#persona-nota').value = '';
      mostrarInvitacion(nota, r.clave);
      pintarPersonas();
    } catch (err) { aviso(err.message, true); }
  });
  $('#inv-whatsapp').addEventListener('click', () => window.open(`https://wa.me/?text=${encodeURIComponent(invitacionTexto)}`, '_blank'));
  $('#inv-copiar').addEventListener('click', async (ev) => {
    const ok = await copiar(invitacionTexto);
    ev.target.textContent = ok ? 'Copiada ✓' : 'No se pudo';
    setTimeout(() => { ev.target.textContent = 'Copiar invitación'; }, 1800);
  });

  // Elegir voz: escuchar cada una y dejar la que guste.
  const muestraVoz = () => `Hola${yo && yo.nombre ? ` ${yo.nombre}` : ''}, soy ADA. ¿En qué te ayudo hoy?`;

  async function probarVoz(nombre, boton) {
    desbloquearVoz();
    detenerHabla();
    const texto = boton.textContent;
    boton.textContent = '…';
    try {
      const res = await fetch('/api/voz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: muestraVoz(), voz: nombre }),
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

  // Diagnóstico: prueba cada paso de la voz y dice exactamente cuál falla.
  async function probarVoz() {
    const out = $('#voz-diagnostico');
    out.hidden = false;
    const pasos = [];
    const mostrar = () => { out.textContent = pasos.join('\n'); };
    desbloquearVoz();
    pasos.push(silenciada ? '✗ ADA está en silencio (botón del parlante arriba). Tócalo para que hable.' : '✓ ADA no está en silencio.');
    mostrar();
    let url = null;
    if (vozServidorConfigurada) {
      const t = performance.now();
      try {
        const res = await fetch('/api/voz', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ texto: 'Hola, ¿me escuchas bien?' }) });
        if (res.status === 204) pasos.push('✗ El servidor no tiene voz natural configurada (se usará la del teléfono).');
        else if (!res.ok) pasos.push(`✗ La voz natural falló: ${(await res.json().catch(() => ({}))).error || `error ${res.status}`}`);
        else {
          url = URL.createObjectURL(await res.blob());
          pasos.push(`✓ Voz de Google lista (${((performance.now() - t) / 1000).toFixed(1)} s).`);
          vozServidor = true; // si estaba en pausa, vuelve
          fallosServidor = 0;
        }
      } catch (e) { pasos.push(`✗ No se pudo pedir la voz al servidor: ${e.message}`); }
    } else {
      pasos.push('• El servidor no tiene voz natural configurada: se usa la del teléfono.');
    }
    mostrar();
    if (url) {
      try {
        reproductor.volume = 1;
        reproductor.src = url;
        await reproductor.play();
        pasos.push('✓ El teléfono la está reproduciendo. Si no escuchas nada, sube el volumen multimedia (no el del timbre).');
      } catch (e) {
        pasos.push(e.name === 'NotAllowedError' ? '✗ El navegador bloqueó el audio. Toca la pantalla y vuelve a probar.' : `✗ El teléfono no pudo reproducir el audio: ${e.name} ${e.message}`);
      }
    } else if (sintesis) {
      const u = new SpeechSynthesisUtterance('Hola, ¿me escuchas bien?');
      u.lang = 'es-CL';
      u.onerror = (e) => { pasos.push(`✗ La voz del teléfono falló: ${e.error}`); mostrar(); };
      u.onstart = () => { pasos.push('✓ Hablando con la voz del teléfono.'); mostrar(); };
      sintesis.speak(u);
    } else {
      pasos.push('✗ Este navegador no tiene voz. Usa Chrome.');
    }
    mostrar();
  }
  $('#probar-voz').addEventListener('click', probarVoz);

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
      fila.querySelector('small').textContent = [v.genero, v.idioma === 'España' ? 'España' : '', v.linea && v.linea !== 'Chirp 3 HD' ? v.linea : ''].filter(Boolean).join(' · ');
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

  // Teclado abierto en el teléfono: la esfera se esconde para que no se aplaste la pantalla.
  $('#mensaje').addEventListener('focus', () => { if (window.matchMedia('(max-width: 700px)').matches) $('#app').classList.add('escribiendo'); });
  $('#mensaje').addEventListener('blur', () => setTimeout(() => $('#app').classList.remove('escribiendo'), 150));

  // ---------- Bienvenida (primera vez de cada invitado) ----------
  const PRIMER_MENSAJE = 'Hola ADA, es mi primera vez. Cuéntame brevemente qué haces y conozcámonos.';
  function mostrarBienvenida() {
    $('#bienvenida-titulo').textContent = `Hola${yo && yo.nombre ? `, ${yo.nombre}` : ''} 👋`;
    $('#hoja-bienvenida').hidden = false;
  }
  async function cerrarBienvenida() {
    $('#hoja-bienvenida').hidden = true;
    api('/api/preferencias', { method: 'POST', body: JSON.stringify({ bienvenida_vista: true }) }).catch(() => {});
  }
  $('#bienvenida-voz').addEventListener('click', () => {
    cerrarBienvenida();
    desbloquearVoz();
    if (!Reconocimiento) { enviar(PRIMER_MENSAJE, { mostrar: '👋 Primera vez' }); return; }
    if (silenciada) $('#silencio').click(); // para conversar, que hable
    iniciarConversacion(PRIMER_MENSAJE);
  });
  $('#bienvenida-texto').addEventListener('click', () => {
    cerrarBienvenida();
    mostrarTeclado(true);
    enviar(PRIMER_MENSAJE, { mostrar: '👋 Primera vez' });
  });
  $('#ver-bienvenida').addEventListener('click', () => { $('#vista-ajustes').hidden = true; mostrarBienvenida(); });

  // ---------- Avisos al teléfono ----------
  const soportaPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64aBytes = (b64) => {
    const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  };
  async function suscripcionActual() {
    if (!soportaPush()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function activarAvisos() {
    if (!soportaPush()) throw new Error('Este navegador no permite avisos. En Android usa Chrome; en iPhone, instala ADA en la pantalla de inicio.');
    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted') throw new Error('No diste permiso para avisos. Puedes activarlo en los ajustes del navegador (Notificaciones).');
    const { publicKey } = await api('/api/push/clave');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aBytes(publicKey) });
    const dispositivo = /android/i.test(navigator.userAgent) ? 'Android' : /iphone|ipad/i.test(navigator.userAgent) ? 'iPhone/iPad' : 'Computador';
    await api('/api/push/suscribir', { method: 'POST', body: JSON.stringify({ suscripcion: sub.toJSON(), dispositivo }) });
  }

  async function pintarAvisos(a) {
    const estado = $('#avisos-estado');
    const acciones = $('#avisos-acciones');
    acciones.innerHTML = '';
    const av = (a.preferencias && a.preferencias.avisos) || {};
    $('#av-despertar').value = av.despertar || '';
    $('#av-resumen').value = av.resumen || '';
    $('#av-cierre').value = av.cierre || '';
    $('#av-silencio').value = av.silencio_desde || '';
    $('#av-seguimiento').checked = av.seguimiento !== false;
    $('#av-correos').checked = av.correos !== false;
    $('#av-fin-tarea').checked = av.fin_tarea !== false;
    $('#av-correo-fin').checked = av.correo_fin_tarea !== false;
    $('#av-cierre-activo').checked = av.cierre_activo !== false;
    let sub = null;
    try { sub = await suscripcionActual(); } catch (_) {}
    const permitido = soportaPush() && Notification.permission === 'granted';
    if (sub && permitido) {
      estado.innerHTML = '<span class="estado-ok">Activados en este dispositivo ✓</span>';
      const probar = document.createElement('button');
      probar.type = 'button';
      probar.textContent = 'Probar aviso';
      probar.addEventListener('click', async () => {
        try { await api('/api/push/probar', { method: 'POST' }); aviso('Listo, debería llegarte un aviso ahora.'); } catch (e) { aviso(e.message, true); }
      });
      const apagar = document.createElement('button');
      apagar.type = 'button';
      apagar.textContent = 'Desactivar aquí';
      apagar.addEventListener('click', async () => {
        try { await api('/api/push/desuscribir', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); } catch (_) {}
        aviso('Avisos desactivados en este dispositivo.');
        abrirAjustes();
      });
      acciones.append(probar, apagar);
      // Por si el servidor no la tenía (otra persona en el mismo teléfono, o se borró).
      api('/api/push/suscribir', { method: 'POST', body: JSON.stringify({ suscripcion: sub.toJSON() }) }).catch(() => {});
    } else {
      estado.textContent = soportaPush() ? 'Desactivados en este dispositivo.' : 'Este navegador no permite avisos.';
      if (soportaPush()) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'principal';
        b.textContent = 'Activar avisos en este teléfono';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { await activarAvisos(); aviso('Avisos activados ✓'); abrirAjustes(); } catch (e) { aviso(e.message, true); b.disabled = false; }
        });
        acciones.appendChild(b);
      }
    }
  }

  async function guardarAvisos() {
    try {
      await api('/api/preferencias', { method: 'POST', body: JSON.stringify({ avisos: {
        despertar: $('#av-despertar').value, resumen: $('#av-resumen').value, cierre: $('#av-cierre').value,
        silencio_desde: $('#av-silencio').value, seguimiento: $('#av-seguimiento').checked,
        correos: $('#av-correos').checked, cierre_activo: $('#av-cierre-activo').checked,
        fin_tarea: $('#av-fin-tarea').checked, correo_fin_tarea: $('#av-correo-fin').checked,
      } }) });
      aviso('Avisos guardados.');
    } catch (e) { aviso(e.message, true); }
  }
  ['#av-despertar', '#av-resumen', '#av-cierre', '#av-silencio', '#av-seguimiento', '#av-correos', '#av-cierre-activo', '#av-fin-tarea', '#av-correo-fin']
    .forEach((id) => $(id).addEventListener('change', guardarAvisos));

  // Al abrir ADA desde un aviso: una tarjeta para escuchar lo que corresponde (el toque permite el sonido).
  const LLAMADOS = {
    despertar: { texto: 'Buenos días ☀️ ¿Vemos el día?', pedido: 'Buenos días. ¿Qué tengo hoy?' },
    resumen: { texto: 'Tu resumen del día está listo.', pedido: 'Dame el resumen de hoy: reuniones, tareas, lo atrasado y los encargos por revisar. Corto, con el detalle en pantalla, y dime por dónde partirías.' },
    encargo: { texto: 'Hay un encargo para revisar.', pedido: (id) => `Revisemos el encargo #${id}: en qué está y cuál es el siguiente paso.` },
    correo: { texto: 'Te respondieron un correo.', pedido: (id) => `Léeme el correo nuevo (id ${id}) y dime si hay que responder.` },
    cierre: { texto: 'Quedan cosas de hoy por cerrar.', pedido: '¿Qué me quedó pendiente de hoy? Ayúdame a cerrar el día: qué muevo y qué marco hecho.' },
  };
  let pedidoLlamado = null;
  function mostrarLlamado(url) {
    let p;
    try { p = new URL(url, location.origin).searchParams; } catch (_) { return; }
    const tipo = p.get('aviso');
    const l = LLAMADOS[tipo];
    if (!l) return;
    const id = (p.get('id') || '').slice(0, 80);
    pedidoLlamado = typeof l.pedido === 'function' ? l.pedido(id) : l.pedido;
    $('#llamado .llamado-texto').textContent = l.texto;
    $('#llamado').hidden = false;
    if (location.search) history.replaceState(null, '', '/');
  }
  $('#llamado-si').addEventListener('click', () => {
    $('#llamado').hidden = true;
    if (pedidoLlamado) enviar(pedidoLlamado, { voz: true });
    pedidoLlamado = null;
  });
  $('#llamado-no').addEventListener('click', () => { $('#llamado').hidden = true; pedidoLlamado = null; });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.tipo === 'aviso' && token) mostrarLlamado(e.data.url); });
  }

  // ---------- Agenda ----------
  let agendaDesde = null; // lunes de la semana que se muestra
  const claveDia = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function lunesDe(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

  function filaTarea(t, conFecha) {
    const f = document.createElement('div');
    f.className = `fila-agenda${t.estado === 'hecho' ? ' hecha' : ''}`;
    f.innerHTML = '<span class="hora"></span><button type="button" class="marca"></button><div class="que"><span class="txt"></span><small></small></div>';
    f.querySelector('.hora').textContent = t.hora || (conFecha ? '' : 'Día');
    if (conFecha) f.querySelector('.hora').textContent = t.fecha.slice(8, 10) + '/' + t.fecha.slice(5, 7);
    const marca = f.querySelector('.marca');
    marca.innerHTML = t.estado === 'hecho' ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
    marca.setAttribute('aria-label', t.estado === 'hecho' ? 'Marcar pendiente' : 'Marcar hecha');
    f.querySelector('.txt').textContent = `${t.importante ? '⭐ ' : ''}${t.texto}`;
    f.querySelector('small').textContent = [t.proyecto, t.persona && `con ${t.persona}`, t.en_calendario && '📅'].filter(Boolean).join(' · ');
    marca.addEventListener('click', async () => {
      marca.disabled = true;
      try {
        await api(`/api/items/${t.id}`, { method: 'POST', body: JSON.stringify({ estado: t.estado === 'hecho' ? 'abierto' : 'hecho' }) });
        pintarAgenda();
        actualizarEstado();
      } catch (e) { aviso(e.message, true); marca.disabled = false; }
    });
    return f;
  }

  function filaEvento(e) {
    const f = document.createElement('div');
    f.className = 'fila-agenda evento';
    f.innerHTML = '<span class="hora"></span><span class="punto-evento"></span><div class="que"><span class="txt"></span><small></small></div>';
    f.querySelector('.hora').textContent = e.hora || 'Día';
    f.querySelector('.txt').textContent = e.titulo;
    f.querySelector('small').textContent = [e.fin && e.hora ? `hasta ${e.fin}` : '', e.ubicacion].filter(Boolean).join(' · ');
    return f;
  }

  async function pintarAgenda() {
    if (!agendaDesde) agendaDesde = lunesDe(new Date());
    const cont = $('#agenda-dias');
    let s;
    try { s = await api(`/api/agenda?desde=${claveDia(agendaDesde)}&dias=7`); } catch (e) { cont.textContent = e.message; return; }
    const hechas = s.dias.reduce((n, d) => n + d.tareas.filter((t) => t.estado === 'hecho').length, 0);
    const total = s.dias.reduce((n, d) => n + d.tareas.length, 0);
    $('#agenda-resumen').textContent = `${total ? `${hechas} de ${total} tareas hechas esta semana` : 'Sin tareas con fecha esta semana'}` +
      (s.calendario === 'conectado' ? ' · con tu Google Calendar' : s.calendario === 'no conectado' ? ' · conecta Google en Ajustes para ver tus reuniones' : '');
    const venc = $('#agenda-vencidas');
    venc.innerHTML = '';
    venc.hidden = !s.vencidas.length;
    if (s.vencidas.length) {
      const h = document.createElement('h3');
      h.textContent = `Atrasadas (${s.vencidas.length})`;
      venc.appendChild(h);
      for (const t of s.vencidas) venc.appendChild(filaTarea(t, true));
    }
    cont.innerHTML = '';
    for (const d of s.dias) {
      const caja = document.createElement('section');
      caja.className = `dia${d.hoy ? ' hoy' : ''}${d.pasado ? ' pasado' : ''}`;
      const h = document.createElement('h3');
      h.innerHTML = '<span></span><small></small>';
      h.querySelector('span').textContent = d.hoy ? `Hoy · ${d.nombre}` : d.nombre;
      const pend = d.tareas.filter((t) => t.estado !== 'hecho').length;
      h.querySelector('small').textContent = d.tareas.length ? `${d.tareas.length - pend}/${d.tareas.length} hechas` : '';
      caja.appendChild(h);
      // Eventos y tareas juntos, por hora (lo "del día" al final).
      const filas = [
        ...d.eventos.map((e) => ({ hora: e.hora || '99', el: filaEvento(e) })),
        ...d.tareas.map((t) => ({ hora: t.hora || '99', el: filaTarea(t) })),
      ].sort((a, b) => a.hora.localeCompare(b.hora));
      if (!filas.length) {
        const p = document.createElement('p');
        p.className = 'dia-vacio';
        p.textContent = 'Libre';
        caja.appendChild(p);
      }
      for (const f of filas) caja.appendChild(f.el);
      cont.appendChild(caja);
      if (d.hoy && !s.vencidas.length) setTimeout(() => caja.scrollIntoView({ block: 'start' }), 50);
    }
  }
  async function abrirAgenda() {
    abrirPanel('#vista-agenda');
    agendaDesde = lunesDe(new Date());
    pintarAgenda();
  }
  $('#abrir-agenda').addEventListener('click', abrirAgenda);
  $('#agenda-antes').addEventListener('click', () => { agendaDesde.setDate(agendaDesde.getDate() - 7); pintarAgenda(); });
  $('#agenda-despues').addEventListener('click', () => { agendaDesde.setDate(agendaDesde.getDate() + 7); pintarAgenda(); });
  $('#agenda-hoy').addEventListener('click', () => { agendaDesde = lunesDe(new Date()); pintarAgenda(); });

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
    yo = null;
    guardarConv(null);
    try { localStorage.removeItem('ada_token'); } catch (_) {}
    try { $('#nombre').value = localStorage.getItem('ada_nombre') || ''; } catch (_) {}
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
    const ajustes = cargarAjustes();
    await retomarConversacion();
    actualizarEstado();
    cargarAutorizaciones();
    cargarAuditoriasActivas();
    revisarCompartido();
    if (new URLSearchParams(location.search).has('aviso')) mostrarLlamado(location.href);
    // Abierta con el botón del asistente, el mosaico o el acceso directo "Hablar con ADA": escucha de inmediato.
    if (new URLSearchParams(location.search).get('escuchar') === '1') {
      history.replaceState(null, '', '/');
      setTimeout(() => iniciarConversacion(), 300);
    }
    // Primera vez de un invitado: bienvenida.
    const aj = await ajustes;
    if (aj && aj.usuario) yo = aj.usuario;
    if (aj && aj.usuario && aj.usuario.id !== 1 && !(aj.preferencias && aj.preferencias.bienvenida_vista)) mostrarBienvenida();
  }

  $('#ver-clave').addEventListener('click', () => {
    const c = $('#password');
    c.type = c.type === 'password' ? 'text' : 'password';
    $('#ver-clave').textContent = c.type === 'password' ? 'Ver' : 'Ocultar';
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const nombre = $('#nombre').value.trim();
      const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ nombre, password: $('#password').value.trim() }) });
      token = r.token;
      yo = r.usuario;
      try { localStorage.setItem('ada_token', token); localStorage.setItem('ada_nombre', nombre); } catch (_) {}
      $('#password').value = '';
      entrar();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  setInterval(async () => {
    if (!token) return;
    if (!document.hidden) await actualizarEstado();
    recargarSiHayVersion();
  }, 60000);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden && conversando) detenerVoz();
    if (!document.hidden && token) {
      await actualizarEstado();
      if (recargarSiHayVersion()) return;
      cargarAutorizaciones(); cargarAjustes(); // al volver, se reintenta la voz natural
    }
  });

  // La app de Android llama a esto cuando ya estaba abierta y se pide hablar (asistente, mosaico).
  window.adaEscuchar = () => { if (token && !conversando && !ocupado) iniciarConversacion(); };

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (token) entrar(); else salir();
})();
