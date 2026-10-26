// Agenda visual: tareas de ADA por día (hechas y pendientes) y eventos de Google Calendar.
// También arma el resumen del día para el aviso de la mañana, solo con datos reales.
const { q } = require('./db');
const F = require('./fechas');

const pad = (n) => String(n).padStart(2, '0');
const diaClave = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hora = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// Sin hora real se guarda a las 23:59: se muestra como "durante el día".
const horaTarea = (d) => (d.getHours() === 23 && d.getMinutes() === 59 ? null : hora(d));

function desdeTexto(t) {
  const m = String(t || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : F.inicioDelDia();
}

const SELECT = `SELECT i.id, i.tipo, i.texto, i.persona, i.fecha_limite, i.estado, i.importante, i.evento_id, p.nombre AS proyecto
  FROM items i LEFT JOIN proyectos p ON p.id = i.proyecto_id`;

function tareaPublica(r) {
  const f = new Date(r.fecha_limite);
  return {
    id: r.id,
    texto: r.texto,
    tipo: r.tipo,
    hora: horaTarea(f),
    estado: r.estado,
    importante: !!r.importante || undefined,
    proyecto: r.proyecto || undefined,
    persona: r.persona || undefined,
    en_calendario: !!r.evento_id || undefined,
  };
}

async function eventosGoogle(desde, hasta, idsDeTareas) {
  const G = require('./google');
  if (!(await G.calendarioDisponible())) return { estado: 'no conectado', eventos: [] };
  try {
    const r = await G.verAgenda({ desde: diaClave(desde), hasta: `${diaClave(hasta)} 23:59` });
    const eventos = r.eventos
      .filter((e) => !idsDeTareas.has(e.id))
      .map((e) => {
        const todoElDia = e.inicio.includes('todo el día');
        return { titulo: e.titulo, fecha: e.inicio.slice(0, 10), hora: todoElDia ? null : e.inicio.slice(11, 16), fin: e.fin ? e.fin.slice(11, 16) : null, ubicacion: e.ubicacion };
      });
    return { estado: 'conectado', eventos };
  } catch (e) {
    return { estado: `no se pudo leer: ${e.message}`, eventos: [] };
  }
}

async function semana({ desde: desdeT, dias = 7 } = {}) {
  const desde = desdeTexto(desdeT);
  const n = Math.max(1, Math.min(31, parseInt(dias, 10) || 7));
  const hasta = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate() + n - 1, 23, 59, 59);
  const hoy = F.inicioDelDia();
  const [filas, vencidas] = await Promise.all([
    q(`${SELECT} WHERE i.tipo IN ('pendiente','compromiso') AND i.estado <> 'descartado'
       AND i.fecha_limite BETWEEN ? AND ? ORDER BY i.fecha_limite`, [desde, hasta]),
    q(`${SELECT} WHERE i.tipo IN ('pendiente','compromiso') AND i.estado = 'abierto'
       AND i.fecha_limite < ? ORDER BY i.fecha_limite LIMIT 30`, [hoy]),
  ]);
  const ids = new Set(filas.map((r) => r.evento_id).filter(Boolean));
  const google = await eventosGoogle(desde, hasta, ids);
  const lista = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate() + i);
    const clave = diaClave(d);
    lista.push({
      fecha: clave,
      nombre: `${F.DIAS[d.getDay()]} ${d.getDate()}`,
      hoy: clave === diaClave(hoy),
      pasado: d < hoy,
      tareas: filas.filter((r) => diaClave(new Date(r.fecha_limite)) === clave).map(tareaPublica),
      eventos: google.eventos.filter((e) => e.fecha === clave),
    });
  }
  return {
    desde: diaClave(desde),
    dias: lista,
    vencidas: vencidas.map((r) => ({ ...tareaPublica(r), fecha: diaClave(new Date(r.fecha_limite)) })),
    calendario: google.estado,
  };
}

// Resumen breve para la notificación de la mañana (sin IA: solo datos, nada inventado).
async function resumenDelDia() {
  const hoyT = diaClave(new Date());
  const s = await semana({ desde: hoyT, dias: 1 });
  const dia = s.dias[0];
  const [{ n: encargos }] = await q(
    "SELECT COUNT(*) AS n FROM encargos WHERE estado IN ('en_curso','esperando_autorizacion','esperando_respuesta','necesita_decision') AND revisar_en IS NOT NULL AND revisar_en <= ?",
    [new Date(new Date().setHours(23, 59, 59, 0))]
  );
  const partes = [];
  for (const e of dia.eventos.slice(0, 3)) partes.push(`${e.hora || 'Todo el día'} ${e.titulo}`);
  if (dia.eventos.length > 3) partes.push(`y ${dia.eventos.length - 3} eventos más`);
  const abiertas = dia.tareas.filter((t) => t.estado === 'abierto');
  if (abiertas.length) {
    const prim = abiertas.slice(0, 2).map((t) => `${t.hora ? `${t.hora} ` : ''}${t.texto}`).join(' · ');
    partes.push(`Tareas: ${prim}${abiertas.length > 2 ? ` (+${abiertas.length - 2})` : ''}`);
  }
  if (s.vencidas.length) partes.push(`${s.vencidas.length} atrasada${s.vencidas.length > 1 ? 's' : ''}`);
  if (encargos) partes.push(`${encargos} encargo${encargos > 1 ? 's' : ''} por revisar`);
  return {
    texto: partes.length ? partes.join(' · ') : 'Día despejado: sin reuniones ni vencimientos. ¿Qué quieres lograr hoy?',
    vacio: !partes.length,
  };
}

module.exports = { semana, resumenDelDia, diaClave, hora };
