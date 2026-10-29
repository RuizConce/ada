// Fase 3e — Prueba I (simulada): 15 documentos ficticios y 20 requisitos extraídos de una pauta ficticia, todo desde el chat.
// Controles: precisión (estado y archivos de la evidencia), costo (por paso, total frente a lo estimado y aprobado,
// y qué pasa si un paso cuesta mucho más), recuperación (dos cortes del servidor), descargas sin redundancia y
// entregables completos (Excel con 20 filas, informe Word que pasa la comprobación estricta).
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const S = __dirname;
const I = require('../datos-ficticios/prueba-i.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql --default-character-set=utf8mb4 -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString().trim();
const CLAVE = `i-${crypto.randomBytes(32).toString('base64')}`;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://ada:ada@localhost:3306/ada';
const A = require('../../src/archivos');
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk;
async function arrancar(extra = {}) {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: CLAVE, ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba',
      ADA_TRABAJO_LEASE_MS: '3000', ADA_TRABAJO_CICLO_MS: '200', ADA_TURNOS_2MIN: '100', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-i.json'), ...extra } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
const cortar = async () => { srv.kill('SIGKILL'); await dormir(800); };
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (_) { d = t; } return { status: r.status, d }; };
const post = (ruta, body) => api(ruta, { method: 'POST', body: JSON.stringify(body || {}) });
async function chat(llamadas, conv = null) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: JSON.stringify({ mensaje: `[${Date.now()}] HERR ${JSON.stringify({ llamadas })}`, conversacion_id: conv, tarjetas: ['auditoria_propuesta@1'] }) });
  const t = await r.text();
  const eventos = t.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { tipo: e.slice(7), d: JSON.parse(d.slice(6)) }; });
  return { eventos, conv: (eventos.find((e) => e.tipo === 'conversacion') || { d: {} }).d.conversacion_id };
}
async function esperar(id, ms = 90000, cada) {
  const fin = Date.now() + ms; let av;
  while (Date.now() < fin) { av = (await api(`/api/auditorias/${id}/avance`)).d; if (cada) await cada(av); if (['completado', 'bloqueado', 'cancelado', 'pausado_presupuesto'].includes(av.estado)) return av; await dormir(150); }
  return av;
}
const descargasDe = (st, id) => (st.export[id] || 0) + ((st.media || {})[id] || 0);
const usd = (n) => `US$${Number(n).toFixed(4)}`;
async function cargarDrive() {
  await ctl('/control/reset', {});
  await ctl('/control/archivos', { archivos: [
    { id: 'carpeta-prueba', name: 'Prueba ADA', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { id: 'INORMA', name: I.norma.nombre, mimeType: 'application/pdf', texto: I.norma.texto, md5Checksum: 'in-v1', version: 1, parents: ['carpeta-prueba'] },
    ...I.documentos.map((d) => ({ id: d.id, name: d.nombre, mimeType: 'application/pdf', texto: d.texto, md5Checksum: `${d.id}-v1`, version: 1, parents: ['carpeta-prueba'] })),
  ] });
}
// Extracción aprobada → lista (paso 2). Devuelve la propuesta de auditoría pendiente.
async function hastaLaLista(conv) {
  const c = await chat([{ name: 'proponer_auditoria', input: { norma_id: 'INORMA', carpeta_id: 'carpeta-prueba', motivo: 'Prueba I' } }], conv);
  const pA = c.eventos.find((e) => e.tipo === 'auditoria_propuesta').d;
  const r = await post(`/api/auditorias/propuestas/${pA.id}/aprobar`, { presupuesto: pA.presupuesto_sugerido, origen: 'tarjeta_chat' });
  const av = await esperar(r.d.trabajo_id);
  const pB = (await api(`/api/auditorias/propuestas?conversacion_id=${c.conv}`)).d.find((x) => av.lista_propuesta && x.id === av.lista_propuesta.propuesta_id);
  return { pA, pB, tA: r.d.trabajo_id, avA: av, conv: c.conv };
}
const resumen = {};

(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM extraccion_eventos'); sql('DELETE FROM auditoria_propuestas');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await cargarDrive();
  await arrancar();
  try {
    // ================= I.1 — Corrida principal con dos cortes del servidor =================
    const { pA, pB, tA, avA, conv } = await hastaLaLista(null);
    ok(pA.archivos.length === 15 && pA.norma.nombre === I.norma.nombre, 'propuesta de extracción: la norma y 15 documentos a auditar');
    ok(avA.estado === 'completado' && pB && pB.requisitos.length === 20, `extracción: ${avA.estado}, ${pB && pB.requisitos.length} requisitos (costo ${usd(avA.costo_real_usd)})`);
    ok(pB && JSON.stringify(pB.requisitos.map((x) => x.texto)) === JSON.stringify(I.requisitos_esperados.map((x) => x.texto)), 'los 20 requisitos son los de la pauta, en orden; sin el duplicado, sin el inventado y sin los 3 artículos que no son requisitos');
    let st = await ctl('/control/stats');
    ok(I.documentos.every((d) => descargasDe(st, d.id) === 0), 'antes de aprobar la auditoría, ninguno de los 15 documentos se ha descargado');
    resumen.extraccion = { costo: avA.costo_real_usd, presupuesto: avA.presupuesto_usd };

    const estimado = pB.estimado_usd;
    let r = await post(`/api/auditorias/propuestas/${pB.id}/aprobar`, { presupuesto: pB.presupuesto_sugerido, configuracion: 'K1', origen: 'tarjeta_chat' });
    const tB = r.d.trabajo_id;
    ok(r.status === 200, `auditoría K1 aprobada: tope ${usd(pB.presupuesto_sugerido)} (estimado peor caso ${usd(estimado)})`);
    const visto = new Set();
    // Corte 1: durante la extracción de los documentos o al empezar la verificación.
    for (let i = 0; i < 300; i++) { const a = (await api(`/api/auditorias/${tB}/avance`)).d; visto.add(`${a.pasos_hechos}`); if (a.pasos_hechos >= 8) break; await dormir(50); }
    await cortar(); await arrancar();
    // Corte 2: a mitad de los requisitos.
    for (let i = 0; i < 300; i++) { const a = (await api(`/api/auditorias/${tB}/avance`)).d; visto.add(`${a.requisitos_evaluados}/20`); if (a.requisitos_evaluados >= 11) break; await dormir(50); }
    await cortar(); await arrancar();
    let av = await esperar(tB, 120000, (a) => visto.add(`${a.requisitos_evaluados}/20`));
    ok(av.estado === 'completado', `auditoría: ${av.estado}${av.motivo ? ` (${av.motivo})` : ''} tras 2 cortes del servidor`);
    const t = (await api(`/api/trabajos/${tB}?resultado=1`)).d;
    const R = t.resultado; const filas = R.matriz.filas;

    // --- Precisión: estado y archivos de la evidencia ---
    const det = I.resultado_correcto.map((x) => {
      const f = filas.find((y) => y.requisito === x.id);
      const archivos = f ? [...new Set(f.evidencias.map((e) => e.archivo_id))].sort() : [];
      return { id: x.id, esperado: x.estado, obtenido: f && f.estado, ok: !!f && f.estado === x.estado, archivosOk: JSON.stringify(archivos) === JSON.stringify(x.archivos) };
    });
    resumen.precision = `${det.filter((x) => x.ok).length}/20`;
    ok(det.every((x) => x.ok), `precisión de estado ${resumen.precision}${det.some((x) => !x.ok) ? ` (fallan: ${det.filter((x) => !x.ok).map((x) => `${x.id} ${x.obtenido}≠${x.esperado}`).join(', ')})` : ''}`);
    ok(det.every((x) => x.archivosOk), `evidencia en los archivos correctos en ${det.filter((x) => x.archivosOk).length}/20 (R4 y R7 con dos archivos; R5 y R11 contradicciones entre archivos)`);
    const conteo = filas.reduce((a, f) => { a[f.estado] = (a[f.estado] || 0) + 1; return a; }, {});
    ok(conteo.cumple === 8 && conteo.parcial === 3 && conteo.no_cumple === 3 && conteo.contradictorio === 2 && conteo.no_aplica_justificado === 2 && conteo.sin_evidencia === 2, `estados: ${JSON.stringify(conteo)}`);
    const selec = t.detalle_pasos.find((p) => p.tipo === 'aud_seleccionar');
    ok(!!selec, 'la selección de fragmentos se hizo una vez para los 20 requisitos');

    // --- Descargas y recuperación ---
    st = await ctl('/control/stats');
    const desc = Object.fromEntries(['INORMA', ...I.documentos.map((d) => d.id)].map((id) => [id, descargasDe(st, id)]));
    ok(Object.values(desc).every((n) => n === 1), `16 archivos, cada uno descargado una sola vez pese a los cortes (${Object.values(desc).join(',')})`);
    const porPaso = sql(`SELECT CONCAT(p.clave,'|',COUNT(*)) FROM llamadas_ia l JOIN trabajo_pasos p ON p.id = l.paso_id WHERE l.trabajo_id='${tB}' AND l.error IS NULL GROUP BY p.clave`).split('\n').filter(Boolean);
    const repetidos = porPaso.filter((x) => Number(x.split('|')[1]) > 1);
    const sinIA = filas.filter((f) => f.modelo === 'código').map((f) => f.requisito);
    ok(porPaso.length === 21 - sinIA.length && repetidos.length <= 2, `IA en ${porPaso.length} pasos (requisitos + informe); sin IA, por no tener ningún fragmento pertinente: ${sinIA.join(', ') || 'ninguno'}; repetidos por los cortes: ${repetidos.join(', ') || 'ninguno'} (como máximo uno por corte)`);
    ok(filas.length === 20 && new Set(filas.map((f) => f.requisito)).size === 20, 'matriz con 20 filas, sin duplicados tras los cortes');

    // --- Costos ---
    const pagado = Number(sql(`SELECT COALESCE(SUM(costo_usd),0) FROM llamadas_ia WHERE trabajo_id='${tB}'`));
    ok(Math.abs(t.gastado_usd - pagado) < 1e-6 && t.reservado_usd === 0, `presupuesto exacto: gastado ${usd(t.gastado_usd)} = llamadas ${usd(pagado)}; sin reservas activas`);
    const pasosIA = t.detalle_pasos.filter((p) => p.estimado_usd > 0);
    const sobre = pasosIA.filter((p) => p.costo_usd > p.estimado_usd * 1.0001);
    ok(!sobre.length, `ningún paso costó más que su estimado (${pasosIA.length} pasos; costo medio por requisito ${usd(R.costos.real_usd / 18)})`);
    ok(R.costos.real_usd <= estimado && R.costos.real_usd <= t.presupuesto_usd, `total ${usd(R.costos.real_usd)} ≤ estimado ${usd(estimado)} ≤ tope ${usd(t.presupuesto_usd)}`);
    resumen.auditoria = { costo: R.costos.real_usd, estimado, tope: t.presupuesto_usd, llamadas: R.costos.llamadas, pasos: t.detalle_pasos.length };

    // --- Entregables ---
    ok(R.excel.filas === 20 && R.excel.evidencias === filas.reduce((a, f) => a + f.evidencias.length, 0), `Excel: 20 filas y ${R.excel.evidencias} evidencias, cotejado celda por celda`);
    const e = await post('/api/descargas', { tipo: 'auditoria_informe', id: tB });
    const w = Buffer.from(await (await fetch(`http://localhost:3200${e.d.url}`)).arrayBuffer());
    const par = await A.textoDeWord(w);
    const iR = par.indexOf('4. Recomendaciones'); const iM = par.indexOf('5. Método y límites');
    const recs = par.slice(iR + 2, iM);
    ok(R.informe.hallazgos === 10 && recs.length === 10 && recs.every((x) => /[.!?…)»"”]$/.test(x)), `informe: 10 hallazgos (parcial, no cumple, contradictorio, sin evidencia) y 10 recomendaciones completas`);
    const lineas = par.filter((x, i) => i > 0 && !/^\d\. /.test(x) && !/^R\d+ — /.test(x) && !/^(Estado|Requisitos|Total|Cumple|Cumple parcialmente|No cumple|Evidencia contradictoria|Sin evidencia|No aplica \(justificado\)|\d+|Requisitos cumplidos o que no aplican)$/.test(x));
    ok(lineas.every((x) => /[.!?…:;)\]»"”'%]$|\d$/.test(x)), `ningún párrafo del informe termina a media frase (${lineas.length} párrafos revisados)`);

    // ================= I.2 — Un paso que cuesta mucho más de lo estimado =================
    await cortar();
    sql('DELETE FROM extracciones'); await cargarDrive();
    await arrancar({ FAKE_H_CARO: 'R8' });
    const x = await hastaLaLista(conv);
    r = await post(`/api/auditorias/propuestas/${x.pB.id}/aprobar`, { presupuesto: x.pB.presupuesto_sugerido, configuracion: 'K1', origen: 'tarjeta_chat' });
    const tC = r.d.trabajo_id;
    av = await esperar(tC, 90000);
    const tc = (await api(`/api/trabajos/${tC}`)).d;
    const r8 = tc.detalle_pasos.find((p) => p.clave === 'verificar:R8');
    const despues = tc.detalle_pasos.filter((p) => p.orden > r8.orden && p.estado === 'hecho' && p.estimado_usd > 0);
    ok(av.estado === 'pausado_presupuesto' && r8.estado === 'hecho' && !despues.length, `R8 costó ${usd(r8.costo_usd)} (estimado ${usd(r8.estimado_usd)}): el encargo se detuvo justo después ("${av.motivo.slice(0, 80)}…") y no gastó en ningún paso más`);
    const llamadasPausa = Number(sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${tC}'`));
    await dormir(1500);
    ok(Number(sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${tC}'`)) === llamadasPausa, 'en pausa no hace ninguna llamada más');
    let ampliaciones = 0;
    while (av.estado === 'pausado_presupuesto' && ampliaciones < 4) { await post(`/api/trabajos/${tC}/ampliar`, { monto: 2 }); ampliaciones += 1; av = await esperar(tC, 90000); }
    const tcf = (await api(`/api/trabajos/${tC}?resultado=1`)).d;
    const r8llamadas = Number(sql(`SELECT COUNT(*) FROM llamadas_ia l JOIN trabajo_pasos p ON p.id = l.paso_id WHERE l.trabajo_id='${tC}' AND p.clave='verificar:R8'`));
    ok(av.estado === 'completado' && r8llamadas === 1 && tcf.resultado.matriz.filas.length === 20, `con ${ampliaciones} ampliación(es) aprobadas termina; R8 no se repitió (1 llamada) y la matriz tiene 20 filas`);
    resumen.caro = { ampliaciones, gastado: tcf.gastado_usd, presupuesto_final: tcf.presupuesto_usd };
  } catch (err) { ok(false, `excepción: ${err.stack}`); console.log(srv.log.slice(-4000)); }
  console.log('\nRESUMEN', JSON.stringify(resumen));
  try { srv.kill(); } catch (_) {}
  drive.kill();
  setTimeout(() => process.exit(), 300);
})();
