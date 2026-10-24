// Gmail: buscar, leer y resumir correos; preparar respuestas (Cristian las envía con un botón);
// dejar borradores y archivar con confirmación.
const G = require('./google');
const { usuario } = require('./db');
const H = require('./herramientas');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gfetch(ruta, opciones = {}) {
  const token = await G.tokenAcceso();
  const res = await fetch(`${API}${ruta}`, {
    ...opciones,
    headers: { Authorization: `Bearer ${token}`, ...(opciones.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `Gmail respondió ${res.status}`;
    if (res.status === 403 && /insufficient|scope/i.test(msg)) {
      throw new Error('Falta el permiso de Gmail. Cristian debe reconectar Google en Ajustes para activarlo.');
    }
    if (/has not been used|is disabled/i.test(msg)) {
      throw new Error('La Gmail API no está habilitada. Cristian mismo puede activarla (es su proyecto): Google Cloud → proyecto ADAIA → APIs y servicios → Biblioteca → Gmail API → Habilitar. Después hay que esperar unos minutos; no hace falta reconectar.');
    }
    throw new Error(msg);
  }
  return data;
}

// ---------- Utilidades ----------

const cabecera = (msg, nombre) => {
  const h = (msg.payload && msg.payload.headers || []).find((x) => x.name.toLowerCase() === nombre.toLowerCase());
  return h ? h.value : '';
};

function decodificar(b64) {
  return Buffer.from(String(b64 || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function htmlATexto(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Recorre las partes del correo: texto, html y adjuntos.
function partes(payload, acc = { texto: '', html: '', adjuntos: [] }) {
  if (!payload) return acc;
  if (payload.filename) acc.adjuntos.push(payload.filename);
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data && !payload.filename) acc.texto += decodificar(payload.body.data);
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data && !payload.filename) acc.html += decodificar(payload.body.data);
  for (const p of payload.parts || []) partes(p, acc);
  return acc;
}

// Quita citas del correo anterior para que el texto sea legible.
function sinCitas(texto) {
  const corte = texto.search(/\n(El .{5,80} escribió:|On .{5,80} wrote:|-----Original Message-----|De: .+\nEnviado)/i);
  const limpio = corte > 0 ? texto.slice(0, corte) : texto;
  return limpio.split('\n').filter((l) => !l.startsWith('>')).join('\n').trim();
}

function resumenMensaje(m) {
  return {
    id: m.id,
    hilo_id: m.threadId,
    de: cabecera(m, 'From'),
    para: cabecera(m, 'To') || undefined,
    asunto: cabecera(m, 'Subject') || '(sin asunto)',
    fecha: cabecera(m, 'Date'),
    extracto: m.snippet,
    no_leido: (m.labelIds || []).includes('UNREAD') || undefined,
    importante: (m.labelIds || []).includes('IMPORTANT') || undefined,
  };
}

// ---------- Herramientas ----------

async function buscar(a = {}) {
  let consulta = a.consulta || '';
  if (a.no_leidos) consulta += ' is:unread';
  if (!consulta.trim()) consulta = 'in:inbox newer_than:3d';
  const limite = Math.min(parseInt(a.limite, 10) || 10, 25);
  const lista = await gfetch(`/messages?${new URLSearchParams({ q: consulta.trim(), maxResults: String(limite) })}`);
  const ids = (lista.messages || []).map((m) => m.id);
  const meta = await Promise.all(ids.map((id) => gfetch(
    `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
  )));
  return { consulta: consulta.trim(), total: meta.length, correos: meta.map(resumenMensaje) };
}

async function leer(a = {}) {
  if (!a.id) throw new Error('id es obligatorio (búscalo con buscar_correos)');
  const m = await gfetch(`/messages/${encodeURIComponent(a.id)}?format=full`);
  const p = partes(m.payload);
  let cuerpo = p.texto || htmlATexto(p.html);
  cuerpo = sinCitas(cuerpo);
  if (cuerpo.length > 15000) cuerpo = `${cuerpo.slice(0, 15000)}\n[…recortado]`;
  const r = { ...resumenMensaje(m), cuerpo, adjuntos: p.adjuntos.length ? p.adjuntos : undefined };
  if (a.con_hilo) {
    const hilo = await gfetch(`/threads/${m.threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    r.hilo = (hilo.messages || []).map((x) => ({ id: x.id, de: cabecera(x, 'From'), fecha: cabecera(x, 'Date'), extracto: x.snippet }));
  }
  return r;
}

async function archivar(a = {}) {
  if (a.confirmado !== true) {
    return { error: 'Falta la confirmación de Cristian. Dile qué correos vas a archivar y espera su "sí"; luego llama con confirmado: true.' };
  }
  const ids = Array.isArray(a.ids) ? a.ids : [a.id].filter(Boolean);
  if (!ids.length) throw new Error('Indica el id o los ids de los correos');
  await gfetch('/messages/batchModify', { method: 'POST', body: JSON.stringify({ ids, removeLabelIds: ['INBOX'] }) });
  return { ok: true, archivados: ids.length };
}

async function marcarLeido(a = {}) {
  const ids = Array.isArray(a.ids) ? a.ids : [a.id].filter(Boolean);
  if (!ids.length) throw new Error('Indica el id o los ids');
  await gfetch('/messages/batchModify', { method: 'POST', body: JSON.stringify({ ids, removeLabelIds: ['UNREAD'] }) });
  return { ok: true, marcados: ids.length };
}

// ---------- Componer y enviar ----------

function codificarCabecera(t) {
  return /^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t, 'utf8').toString('base64')}?=`;
}

// Arma el correo (RFC 2822) y, si es respuesta, lo engancha al hilo original.
async function construirCorreo({ para, asunto, cuerpo, responderA }) {
  let hiloId;
  const cab = [];
  if (responderA) {
    const orig = await gfetch(`/messages/${encodeURIComponent(responderA)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
    hiloId = orig.threadId;
    const msgId = cabecera(orig, 'Message-ID');
    if (msgId) {
      cab.push(`In-Reply-To: ${msgId}`);
      cab.push(`References: ${[cabecera(orig, 'References'), msgId].filter(Boolean).join(' ')}`);
    }
    if (!para) para = cabecera(orig, 'Reply-To') || cabecera(orig, 'From');
    if (!asunto) {
      const s = cabecera(orig, 'Subject');
      asunto = /^re:/i.test(s) ? s : `Re: ${s}`;
    }
  }
  if (!para) throw new Error('Falta el destinatario del correo');
  const crudo = [
    `To: ${para}`,
    `Subject: ${codificarCabecera(asunto || '')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    ...cab,
    '',
    cuerpo,
  ].join('\r\n');
  const raw = Buffer.from(crudo, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { raw, threadId: hiloId, para, asunto };
}

async function guardarBorrador(a = {}) {
  if (!a.cuerpo) throw new Error('cuerpo es obligatorio');
  const c = await construirCorreo({ para: a.para, asunto: a.asunto, cuerpo: a.cuerpo, responderA: a.responder_a_id });
  const d = await gfetch('/drafts', { method: 'POST', body: JSON.stringify({ message: { raw: c.raw, threadId: c.threadId } }) });
  return { ok: true, borrador_id: d.id, para: c.para, asunto: c.asunto, nota: 'Quedó como borrador en su Gmail; no fue enviado.' };
}

// Lo llama el servidor solo cuando Cristian toca "Enviar desde Gmail" en la tarjeta.
async function enviar({ para, asunto, cuerpo, responderA }) {
  const c = await construirCorreo({ para, asunto, cuerpo, responderA });
  const m = await gfetch('/messages/send', { method: 'POST', body: JSON.stringify({ raw: c.raw, threadId: c.threadId }) });
  return { ok: true, id: m.id, para: c.para };
}

async function disponible() {
  return G.tienePermiso('gmail');
}

// Correos recientes no leídos para el contexto (con caché corta).
const cache = new Map(); // por persona
async function paraContexto() {
  try {
    if (!(await disponible())) return {};
    const c = cache.get(usuario().id);
    if (c && c.hasta > Date.now()) return c.datos;
    const r = await Promise.race([
      buscar({ consulta: 'in:inbox is:unread newer_than:2d -category:promotions -category:social', limite: 6 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tiempo')), 3000)),
    ]);
    const datos = {
      correo: 'Gmail conectado',
      correos_no_leidos_recientes: r.correos.map((c) => `${c.de.replace(/<.*>/, '').trim()}: ${c.asunto}`),
    };
    cache.set(usuario().id, { datos, hasta: Date.now() + 3 * 60 * 1000 });
    return datos;
  } catch (_) {
    return {};
  }
}

H.registrar([
  {
    name: 'buscar_correos',
    description: 'Busca en el Gmail de Cristian con la sintaxis de búsqueda de Gmail (ej: "from:paola", "subject:SEREMI", "has:attachment newer_than:7d", "is:important"). Sin consulta, muestra la bandeja de entrada de los últimos 3 días.',
    input_schema: {
      type: 'object',
      properties: {
        consulta: { type: 'string' },
        no_leidos: { type: 'boolean' },
        limite: { type: 'integer' },
      },
    },
  },
  {
    name: 'leer_correo',
    description: 'Lee un correo completo (remitente, asunto, cuerpo sin citas y adjuntos). Con con_hilo: true trae también el resto de la conversación.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, con_hilo: { type: 'boolean' } }, required: ['id'] },
  },
  {
    name: 'guardar_borrador_correo',
    description: 'Deja un borrador en el Gmail de Cristian (no lo envía). Úsala cuando pida "déjalo en borrador". Para responder un correo, indica responder_a_id y se engancha al hilo.',
    input_schema: {
      type: 'object',
      properties: {
        para: { type: 'string' }, asunto: { type: 'string' }, cuerpo: { type: 'string' },
        responder_a_id: { type: 'string', description: 'id del correo que se responde' },
      },
      required: ['cuerpo'],
    },
  },
  {
    name: 'archivar_correos',
    description: 'Archiva correos (los saca de la bandeja de entrada, no los borra). Requiere confirmación.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, confirmado: { type: 'boolean' } },
      required: ['ids', 'confirmado'],
    },
  },
  {
    name: 'marcar_leidos',
    description: 'Marca correos como leídos.',
    input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
  },
], {
  buscar_correos: buscar,
  leer_correo: leer,
  guardar_borrador_correo: guardarBorrador,
  archivar_correos: archivar,
  marcar_leidos: marcarLeido,
});

module.exports = { enviar, disponible, paraContexto, buscar, leer, construirCorreo };
