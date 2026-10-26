// Avisos al teléfono (Web Push): despertar, resumen de la mañana, seguimiento de encargos,
// correos de personas con encargos abiertos y cierre de la tarde. Con horario de silencio,
// máximo diario y sin repetir. Todo sale de datos reales, nunca se inventan urgencias.
const webpush = require('web-push');
const { q, qPrincipal, comoUsuario, prepararInvitado } = require('./db');
const H = require('./herramientas');
const Agenda = require('./agenda');

// ---------- Claves VAPID (se crean solas la primera vez y quedan en la base) ----------

let claves = null;
async function clavesVapid() {
  if (claves) return claves;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    claves = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const [r] = await qPrincipal("SELECT datos FROM integraciones WHERE nombre = 'vapid'");
    if (r) claves = JSON.parse(r.datos);
    else {
      claves = webpush.generateVAPIDKeys();
      await qPrincipal("INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('vapid', ?, ?)", [JSON.stringify(claves), new Date()]);
    }
  }
  // Apple exige un contacto válido (mailto: o https:).
  const contacto = process.env.ADA_CONTACTO ? `mailto:${process.env.ADA_CONTACTO}` : (process.env.APP_URL || 'mailto:ada@example.com');
  webpush.setVapidDetails(contacto, claves.publicKey, claves.privateKey);
  return claves;
}

// ---------- Suscripciones (una por teléfono o computador) ----------

async function suscribir(sub, dispositivo) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('Suscripción inválida');
  if (!/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 500) throw new Error('Suscripción inválida');
  await q(
    `INSERT INTO push_suscripciones (endpoint, datos, dispositivo, creado_en) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE datos = VALUES(datos), dispositivo = VALUES(dispositivo)`,
    [sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), String(dispositivo || '').slice(0, 160) || null, new Date()]
  );
  return { ok: true };
}

async function desuscribir(endpoint) {
  await q('DELETE FROM push_suscripciones WHERE endpoint = ?', [String(endpoint || '')]);
  return { ok: true };
}

async function estado() {
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM push_suscripciones');
  const enviados = await q('SELECT tipo, titulo, enviado_en FROM avisos_enviados ORDER BY id DESC LIMIT 5');
  return { dispositivos: n, ultimos: enviados };
}

// ---------- Envío ----------

async function enviar({ titulo, cuerpo, url = '/', tag }) {
  await clavesVapid();
  const subs = await q('SELECT id, datos FROM push_suscripciones');
  let entregados = 0;
  const payload = JSON.stringify({ titulo, cuerpo, url, tag: tag || 'ada' });
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.datos), payload, { TTL: 60 * 60 });
      entregados += 1;
    } catch (e) {
      // El teléfono ya no acepta avisos (desinstaló o revocó el permiso): se borra.
      if (e.statusCode === 404 || e.statusCode === 410) await q('DELETE FROM push_suscripciones WHERE id = ?', [s.id]);
      else console.error('Aviso push:', e.statusCode || '', e.message);
    }
  }
  return { entregados, dispositivos: subs.length };
}

async function yaEnviado(tipo, clave) {
  const [r] = await q('SELECT id FROM avisos_enviados WHERE tipo = ? AND clave = ? LIMIT 1', [tipo, clave]);
  return !!r;
}

async function avisar(tipo, clave, contenido) {
  if (await yaEnviado(tipo, clave)) return false;
  // Se anota antes de enviar: aunque falle la red, nunca se repite el mismo aviso.
  await q('INSERT INTO avisos_enviados (tipo, clave, titulo, enviado_en) VALUES (?, ?, ?, ?)', [tipo, clave, String(contenido.titulo).slice(0, 200), new Date()]);
  await enviar(contenido);
  return true;
}

// ---------- Cuándo avisar ----------

const aMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const minDelDia = (d) => d.getHours() * 60 + d.getMinutes();
// Dentro de la hora siguiente a la programada (por si el servidor se reinició justo a esa hora).
const tocaAhora = (hhmm, ahora) => !!hhmm && minDelDia(ahora) >= aMin(hhmm) && minDelDia(ahora) < aMin(hhmm) + 60;

function enSilencio(av, ahora) {
  if (!av.silencio_desde) return false;
  const m = minDelDia(ahora);
  const desde = aMin(av.silencio_desde);
  const hasta = aMin(av.despertar || av.resumen || '07:00');
  return desde > hasta ? (m >= desde || m < hasta) : (m >= desde && m < hasta);
}

async function enviadosHoy(ahora) {
  const inicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM avisos_enviados WHERE enviado_en >= ? AND tipo IN ('seguimiento','correo','cierre')", [inicio]);
  return n;
}

const ultimaRevisionCorreo = new Map(); // por persona

async function revisarPersona(u, ahora = new Date()) {
  const [{ n: subs }] = await q('SELECT COUNT(*) AS n FROM push_suscripciones');
  if (!subs) return [];
  const { avisos: av } = await H.preferencias();
  if (!av.activos) return [];
  const hoy = Agenda.diaClave(ahora);
  const nombre = u.nombre || '';
  const hechos = [];

  if (tocaAhora(av.despertar, ahora)) {
    const ok = await avisar('despertar', hoy, {
      titulo: `Buenos días${nombre ? `, ${nombre}` : ''} ☀️`,
      cuerpo: av.resumen ? `A las ${av.resumen} te tengo el resumen del día.` : 'Cuando quieras, vemos el día.',
      url: '/?aviso=despertar', tag: 'despertar',
    });
    if (ok) hechos.push('despertar');
  }
  if (tocaAhora(av.resumen, ahora)) {
    const r = await Agenda.resumenDelDia();
    const ok = await avisar('resumen', hoy, { titulo: 'Tu día', cuerpo: r.texto, url: '/?aviso=resumen', tag: 'resumen' });
    if (ok) hechos.push('resumen');
  }

  if (enSilencio(av, ahora)) return hechos;
  let quedan = av.max_dia - (await enviadosHoy(ahora));
  if (quedan <= 0) return hechos;

  // Seguimiento: encargos cuya fecha de revisión ya llegó.
  if (av.seguimiento && quedan > 0) {
    const [e] = await q(
      `SELECT e.id, e.titulo, e.siguiente_paso, e.revisar_en, c.nombre AS contacto FROM encargos e
       LEFT JOIN contactos c ON c.id = e.contacto_id
       WHERE e.estado IN ('en_curso','esperando_autorizacion','esperando_respuesta','necesita_decision')
       AND e.revisar_en IS NOT NULL AND e.revisar_en <= ? ORDER BY e.revisar_en LIMIT 1`, [ahora]
    );
    if (e && !(await yaEnviado('seguimiento', `${e.id}:${new Date(e.revisar_en).getTime()}`))) {
      await avisar('seguimiento', `${e.id}:${new Date(e.revisar_en).getTime()}`, {
        titulo: `Seguimiento: ${e.titulo}`.slice(0, 120),
        cuerpo: e.siguiente_paso || (e.contacto ? `¿Respondió ${e.contacto}? Revisémoslo.` : 'Toca para revisarlo con ADA.'),
        url: `/?aviso=encargo&id=${e.id}`, tag: `encargo-${e.id}`,
      });
      hechos.push('seguimiento');
      quedan -= 1;
    }
  }

  // Correos sin leer de personas con encargos abiertos (revisa cada 10 minutos).
  if (av.correos && quedan > 0 && (ultimaRevisionCorreo.get(u.id) || 0) < Date.now() - 10 * 60 * 1000) {
    ultimaRevisionCorreo.set(u.id, Date.now());
    try {
      const M = require('./gmail');
      if (await M.disponible()) {
        const correos = (await q(
          `SELECT DISTINCT c.email FROM encargos e JOIN contactos c ON c.id = e.contacto_id
           WHERE e.estado IN ('en_curso','esperando_respuesta','necesita_decision') AND c.email IS NOT NULL LIMIT 15`
        )).map((x) => x.email).filter((x) => /^[^\s()]+@[^\s()]+$/.test(x));
        if (correos.length) {
          const r = await M.buscar({ consulta: `is:unread newer_than:1d from:(${correos.join(' OR ')})`, limite: 3 });
          for (const c of r.correos) {
            if (quedan <= 0) break;
            const de = c.de.replace(/<.*>/, '').trim() || c.de;
            if (await avisar('correo', c.id, { titulo: `Respondió ${de}`.slice(0, 120), cuerpo: c.asunto, url: `/?aviso=correo&id=${encodeURIComponent(c.id)}`, tag: `correo-${c.id}` })) {
              hechos.push('correo');
              quedan -= 1;
            }
          }
        }
      }
    } catch (e) {
      console.error('Avisos correo:', e.message);
    }
  }

  // Cierre de la tarde: lo de hoy que sigue abierto.
  if (av.cierre_activo && quedan > 0 && tocaAhora(av.cierre, ahora)) {
    const s = await Agenda.semana({ desde: hoy, dias: 1 });
    const abiertas = s.dias[0].tareas.filter((t) => t.estado === 'abierto');
    if (abiertas.length) {
      const ok = await avisar('cierre', hoy, {
        titulo: abiertas.length === 1 ? 'Te queda una cosa de hoy' : `Te quedan ${abiertas.length} cosas de hoy`,
        cuerpo: abiertas.slice(0, 3).map((t) => t.texto).join(' · '),
        url: '/?aviso=cierre', tag: 'cierre',
      });
      if (ok) hechos.push('cierre');
    }
  }
  return hechos;
}

// Recorre a todas las personas con acceso, cada una en su propia base.
let corriendo = false;
async function revisarTodos(ahora = new Date()) {
  if (corriendo) return;
  corriendo = true;
  try {
    const usuarios = await qPrincipal('SELECT id, nombre, admin FROM usuarios WHERE activo = 1 AND (id = 1 OR ultimo_ingreso IS NOT NULL)');
    for (const u of usuarios) {
      try {
        if (u.id !== 1) await prepararInvitado(u.id);
        await comoUsuario({ id: u.id, nombre: u.nombre, admin: !!u.admin }, () => revisarPersona(u, ahora));
      } catch (e) {
        console.error(`Avisos u${u.id}:`, e.message);
      }
    }
  } finally {
    corriendo = false;
  }
}

function iniciar() {
  if (process.env.ADA_AVISOS === 'no') return;
  clavesVapid().catch((e) => console.error('VAPID:', e.message));
  setInterval(() => revisarTodos().catch((e) => console.error('Avisos:', e.message)), 60 * 1000);
}

module.exports = { clavesVapid, suscribir, desuscribir, estado, enviar, revisarPersona, revisarTodos, iniciar, enSilencio, tocaAhora };
