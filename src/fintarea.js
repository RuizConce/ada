// Cuando ADA termina un encargo largo (informe, documento, archivo, análisis), avisa al teléfono
// con un resumen y manda el resultado al correo de la misma persona. Pactado de antemano y
// SOLO a su propia cuenta: nunca a terceros (eso sigue requiriendo su autorización).
const H = require('./herramientas');
const { q } = require('./db');

const limpio = (t) => String(t || '').replace(/\[\[PANTALLA\]\][\s\S]*$/, '').replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim();
const corto = (t, n) => (t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t);

function esEncargoLargo(r) {
  return (r.documentos && r.documentos.length) || (r.archivos && r.archivos.length)
    || (r.tiempos && r.tiempos.total_ms > 25000) || (r.detalle && r.detalle.length > 800);
}

async function avisarFin(pedido, r) {
  if (!r || !esEncargoLargo(r)) return { avisado: false };
  const { avisos: av } = await H.preferencias();
  const titulo = (r.documentos && r.documentos[0] && r.documentos[0].titulo)
    || (r.archivos && r.archivos[0] && r.archivos[0].nombre)
    || corto(limpio(pedido), 70);
  const resumen = corto(limpio(r.respuesta), 220);
  const hecho = { avisado: false, correo: false };

  if (av.activos && av.fin_tarea !== false) {
    try {
      const Avisos = require('./avisos');
      const ahora = new Date();
      if (!Avisos.enSilencio(av, ahora)) {
        await Avisos.enviar({ titulo: `Listo: ${titulo}`.slice(0, 120), cuerpo: resumen || 'Terminé lo que me pediste.', url: '/', tag: `fin-${r.conversacion_id || ''}` });
        hecho.avisado = true;
      }
    } catch (e) { console.error('Aviso fin de tarea:', e.message); }
  }

  if (av.correo_fin_tarea !== false) {
    try {
      const G = require('./google');
      const M = require('./gmail');
      const est = await G.estado();
      if (est.cuenta && (await M.disponible())) {
        const partes = [`Me pediste: ${limpio(pedido)}`, '', limpio(r.respuesta)];
        if (r.detalle) partes.push('', r.detalle);
        for (const d of r.documentos || []) {
          const [doc] = await q('SELECT titulo, contenido FROM documentos WHERE id = ?', [d.id]);
          if (doc) partes.push('', '────────────', doc.titulo, '', doc.contenido);
        }
        for (const a of r.archivos || []) partes.push('', `Archivo: ${a.nombre}${a.drive_url ? ` — ${a.drive_url}` : ' (descárgalo desde ADA)'}`);
        partes.push('', '— ADA');
        await M.enviar({ para: est.cuenta, asunto: `ADA · ${titulo}`.slice(0, 150), cuerpo: partes.join('\n') });
        hecho.correo = true;
      }
    } catch (e) { console.error('Correo fin de tarea:', e.message); }
  }
  return hecho;
}

module.exports = { avisarFin, esEncargoLargo };
