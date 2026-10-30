// Fase 3e — Prueba H (simulada): una pauta normativa ficticia y 5 documentos ficticios, todo pedido desde el chat.
//  1. ADA propone extraer los requisitos de la norma (tarjeta, nada empieza).  2. Aprobación → encargo de extracción.
//  3. La lista (10 requisitos, sin duplicados ni inventados) queda como propuesta pendiente para aprobar.
//  4. Aprobación → auditoría K1 de 5 documentos: sin descargas redundantes, evidencias de uno o varios archivos,
//     parcial / no cumple / sin evidencia / contradicción / no aplica.  5. Excel consolidado + informe ejecutivo,
//     verificados contra el trabajo aprobado.  6. Progreso y presupuesto por paso; recuperación tras un corte.
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const S = __dirname;
const H = require('../datos-ficticios/prueba-h.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql --default-character-set=utf8mb4 -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString().trim();
const CLAVE = `h-${crypto.randomBytes(32).toString('base64')}`;
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk;
async function arrancar(extra = {}) {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: CLAVE, ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba',
      ADA_TRABAJO_LEASE_MS: '3000', ADA_TRABAJO_CICLO_MS: '200', ADA_TURNOS_2MIN: '100', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-h.json'), ...extra } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (_) { d = t; } return { status: r.status, d }; };
const post = (ruta, body) => api(ruta, { method: 'POST', body: JSON.stringify(body || {}) });
async function chat(llamadas, conv = null) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: JSON.stringify({ mensaje: `[${Date.now()}] HERR ${JSON.stringify({ llamadas })}`, conversacion_id: conv, tarjetas: ['auditoria_propuesta@1'] }) });
  const t = await r.text();
  const eventos = t.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { tipo: e.slice(7), d: JSON.parse(d.slice(6)) }; });
  const fin = eventos.find((e) => e.tipo === 'fin');
  const m = (fin ? fin.d.respuesta : '').match(/DATOS=(.*)$/s);
  return { eventos, datos: m ? JSON.parse(m[1]) : [], conv: (eventos.find((e) => e.tipo === 'conversacion') || { d: {} }).d.conversacion_id };
}
async function esperar(id, ms = 60000, alVer) {
  const fin = Date.now() + ms; let av;
  while (Date.now() < fin) { av = (await api(`/api/auditorias/${id}/avance`)).d; if (alVer) await alVer(av); if (['completado', 'bloqueado', 'cancelado', 'pausado_presupuesto'].includes(av.estado)) return av; await dormir(200); }
  return av;
}
const descargasDe = (st, id) => (st.export[id] || 0) + ((st.media || {})[id] || 0);
const usd = (n) => `US$${Number(n).toFixed(4)}`;
const resumen = {};

(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM extraccion_eventos'); sql('DELETE FROM auditoria_propuestas');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await ctl('/control/archivos', { archivos: [
    { id: 'carpeta-prueba', name: 'Prueba ADA', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { id: 'HN', name: H.norma.nombre, mimeType: 'application/pdf', texto: H.norma.texto, md5Checksum: 'hn-v1', version: 1, parents: ['carpeta-prueba'] },
    ...H.documentos.map((d) => ({ id: d.id, name: d.nombre, mimeType: 'application/pdf', texto: d.texto, md5Checksum: `${d.id}-v1`, version: 1, parents: ['carpeta-prueba'] })),
    { id: 'HX', name: 'Documento ajeno.pdf', mimeType: 'application/pdf', texto: 'Ajeno', md5Checksum: 'hx', version: 1, parents: ['otra'] },
  ] });
  await arrancar();
  try {
    // ---- 1. Propuesta de extracción desde el chat ----
    let c = await chat([{ name: 'proponer_auditoria', input: { norma_id: 'HN', carpeta_id: 'carpeta-prueba', motivo: 'Prueba H' } }]);
    const conv = c.conv;
    const pA = (c.eventos.find((e) => e.tipo === 'auditoria_propuesta') || {}).d;
    ok(pA && pA.tipo === 'extraer_requisitos' && pA.norma.nombre === H.norma.nombre && pA.archivos.length === 5 && !pA.archivos.some((a) => a.id === 'HN'), `tarjeta "Extraer requisitos": norma + 5 documentos a auditar (la norma no se audita a sí misma)`);
    ok(pA && pA.presupuesto_sugerido > 0 && pA.estimado_auditoria_usd > 0, `costo de extracción ${pA && usd(pA.estimado_usd)} (presupuesto sugerido ${pA && usd(pA.presupuesto_sugerido)}); referencia de la auditoría ~${pA && usd(pA.estimado_auditoria_usd)}`);
    let st = await ctl('/control/stats');
    ok(Number(sql("SELECT COUNT(*) FROM trabajos WHERE tipo='auditoria' AND estado <> 'cancelado' AND creado_en > NOW() - INTERVAL 1 MINUTE")) === 0 && H.documentos.every((d) => descargasDe(st, d.id) === 0),
      'antes de aprobar: ningún trabajo y ningún documento a auditar descargado (solo se leyó la norma para estimar)');
    c = await chat([{ name: 'proponer_auditoria', input: { norma_id: 'HX', carpeta_id: 'carpeta-prueba' } }], conv);
    ok(/fuera de las? carpetas? autorizadas?/.test(JSON.stringify(c.datos)), `una norma fuera de la carpeta de prueba se rechaza ${JSON.stringify(c.datos).slice(0, 300)}`);

    // ---- 2. Aprobación → extracción ----
    let r = await post(`/api/auditorias/propuestas/${pA.id}/aprobar`, { presupuesto: pA.presupuesto_sugerido, origen: 'tarjeta_chat' });
    ok(r.status === 200 && r.d.tipo === 'extraer_requisitos', 'aprobada la extracción: empieza el encargo de requisitos');
    const tA = r.d.trabajo_id;
    let vistos = new Set();
    let av = await esperar(tA, 30000, (a) => { vistos.add(`${a.bloques_hechos}/${a.bloques_total}`); });
    ok(av.estado === 'completado' && av.modo === 'requisitos', `extracción: ${av.estado}${av.motivo ? ` (${av.motivo})` : ''}, bloques ${[...vistos].join(' → ')}`);
    ok(av.lista_propuesta && av.lista_propuesta.requisitos === 10 && av.lista_propuesta.estado === 'pendiente', `la lista quedó como propuesta pendiente: ${av.lista_propuesta && av.lista_propuesta.requisitos} requisitos`);
    resumen.extraccion = { costo: av.costo_real_usd, presupuesto: av.presupuesto_usd };
    const res = (await api(`/api/trabajos/${tA}?resultado=1`)).d.resultado;
    ok(res.lista.duplicados.length === 1 && res.lista.descartados.some((x) => /no está en la norma/.test(x.motivo)), `sin duplicados (1 quitado) y sin inventados (cita que no está en la norma: descartada)`);

    // ---- 3. La lista para revisar ----
    const pend = (await api(`/api/auditorias/propuestas?conversacion_id=${conv}`)).d;
    const pB = pend.find((x) => x.id === av.lista_propuesta.propuesta_id);
    ok(pB && pB.tipo === 'auditoria' && pB.configuracion === 'K1' && pB.origen && pB.origen.extraccion_trabajo === tA, 'la propuesta de auditoría (K1) viene ligada al encargo de extracción y a esta conversación');
    const textos = pB.requisitos.map((x) => x.texto);
    ok(JSON.stringify(textos) === JSON.stringify(H.requisitos_esperados.map((x) => x.texto)) && pB.requisitos.map((x) => x.id).join(',') === H.requisitos_esperados.map((x) => x.id).join(','), 'los 10 requisitos coinciden con la norma, en orden, R1…R10');
    ok(pB.requisitos.every((x) => /^Art\. \d+: «.+»$/.test(x.fuente)), `cada requisito trae su fuente en la norma (p. ej. ${pB.requisitos[4].fuente.slice(0, 60)}…)`);
    ok(Number(sql(`SELECT COUNT(*) FROM trabajos WHERE id <> '${tA}' AND tipo='auditoria' AND estado='ejecutando'`)) === 0, 'con la lista lista, todavía no se audita nada (falta aprobarla)');
    ver = (await chat([{ name: 'ver_auditoria', input: {} }], conv)).datos[0];
    ok(ver.propuesta_id === pB.id && ver.estado_propuesta === 'pendiente' && ver.requisitos_extraidos_de === H.norma.nombre && ver.trabajo === null, 'ver_auditoria en la conversación: la lista pendiente de aprobar, sin trabajo');

    // ---- 4. Aprobación → auditoría de 5 documentos, con un corte del servidor a mitad ----
    r = await post(`/api/auditorias/propuestas/${pB.id}/aprobar`, { presupuesto: pB.presupuesto_sugerido, requisitos: pB.requisitos.map(({ id, texto }) => ({ id, texto })), configuracion: 'K1', origen: 'tarjeta_chat' });
    ok(r.status === 200 && r.d.configuracion === 'K1', `auditoría aprobada (K1, presupuesto ${usd(pB.presupuesto_sugerido)})`);
    const tB = r.d.trabajo_id;
    vistos = new Set();
    for (let i = 0; i < 200; i++) { av = (await api(`/api/auditorias/${tB}/avance`)).d; vistos.add(`${av.requisitos_evaluados}/10`); if (av.requisitos_evaluados >= 4 || av.estado !== 'ejecutando') break; await dormir(100); }
    const llamadasAntes = Number(sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${tB}' AND error IS NULL`));
    srv.kill('SIGKILL'); await dormir(800);
    await arrancar();
    av = await esperar(tB, 60000, (a) => { vistos.add(`${a.requisitos_evaluados}/10`); });
    ok(av.estado === 'completado', `auditoría: ${av.estado}${av.motivo ? ` (${av.motivo})` : ''}; avance ${[...vistos].join(' → ')}; corte del servidor con ${llamadasAntes} llamadas hechas`);
    const t = (await api(`/api/trabajos/${tB}?resultado=1`)).d;
    const R = t.resultado;
    const filas = R.matriz.filas;

    // Precisión frente al resultado correcto conocido.
    const det = H.resultado_correcto.map((x) => { const f = filas.find((y) => y.requisito === x.id); return { id: x.id, esperado: x.estado, obtenido: f && f.estado, ok: !!f && f.estado === x.estado }; });
    resumen.precision = `${det.filter((x) => x.ok).length}/10`;
    ok(det.every((x) => x.ok), `precisión 10/10 frente al resultado correcto (${det.map((x) => `${x.id}=${x.obtenido}`).join(', ')})`);
    // Evidencias.
    const r4 = filas.find((f) => f.requisito === 'R4');
    ok(new Set(r4.evidencias.map((e) => e.archivo_id)).size === 2 && r4.evidencias.every((e) => e.verificada && e.archivo_version && e.ubicacion), `R4 se acredita con evidencias de 2 archivos (${[...new Set(r4.evidencias.map((e) => e.archivo))].join(' + ')}), cada una con versión, página y cita verificada`);
    const r5 = filas.find((f) => f.requisito === 'R5');
    ok(r5.estado === 'contradictorio' && r5.evidencias.find((e) => e.aporta === 'a_favor').archivo_id === 'HD3' && r5.evidencias.find((e) => e.aporta === 'en_contra').archivo_id === 'HD4', 'R5 contradictorio: a favor en el registro (HD3), en contra en el acta (HD4)');
    const r10 = filas.find((f) => f.requisito === 'R10');
    ok(r10.estado === 'sin_evidencia' && r10.modelo === 'código', 'R10 sin evidencia, decidido por código sin gastar IA');
    ok(filas.filter((f) => ['cumple', 'parcial', 'no_cumple', 'contradictorio'].includes(f.estado)).every((f) => f.evidencias.length && f.evidencias.every((e) => e.verificada)), 'todo cumple / parcial / no cumple / contradictorio tiene citas verificadas');
    // Sin descargas redundantes.
    st = await ctl('/control/stats');
    const descargas = Object.fromEntries(['HN', ...H.documentos.map((d) => d.id)].map((id) => [id, descargasDe(st, id)]));
    ok(Object.values(descargas).every((n) => n === 1), `cada archivo se descargó una sola vez en todo el proceso, incluso con el corte (${JSON.stringify(descargas)})`);
    const llamadas = sql(`SELECT CONCAT(p.clave,'|',COUNT(*)) FROM llamadas_ia l JOIN trabajo_pasos p ON p.id = l.paso_id WHERE l.trabajo_id='${tB}' AND l.error IS NULL GROUP BY p.clave`).split('\n').filter(Boolean);
    const repetidas = llamadas.filter((x) => Number(x.split('|')[1]) > 1);
    ok(llamadas.length === 10 && repetidas.length <= 1, `IA en 10 pasos (9 requisitos + informe; R10 sin IA); tras el corte solo se repite, como máximo, el paso que estaba a medias (${repetidas.join(', ') || 'ninguno'})`);
    const pagado = Number(sql(`SELECT COALESCE(SUM(costo_usd),0) FROM llamadas_ia WHERE trabajo_id='${tB}'`));
    const [gastado] = sql(`SELECT gastado_usd FROM trabajos WHERE id='${tB}'`).split('\n').map(Number);
    ok(Math.abs(gastado - pagado) < 1e-6, `el presupuesto cuenta todo lo pagado, incluido el intento cortado (gastado US$${gastado.toFixed(5)} = llamadas US$${pagado.toFixed(5)})`);
    // Progreso y presupuesto por paso.
    const pasos = t.detalle_pasos;
    ok(pasos.every((p) => p.estado === 'hecho') && pasos.filter((p) => p.tipo === 'aud_verificar').every((p) => p.costo_usd >= 0 && p.estimado_usd > 0), `${pasos.length} pasos hechos, cada paso de IA con su estimado y su costo real`);
    ok(R.costos.real_usd <= t.presupuesto_usd && t.reservado_usd === 0, `costo real ${usd(R.costos.real_usd)} de ${usd(t.presupuesto_usd)} aprobado; sin reservas activas`);
    resumen.auditoria = { costo: R.costos.real_usd, presupuesto: t.presupuesto_usd, llamadas: R.costos.llamadas, pasos: pasos.length };
    // Entregables verificados.
    ok(R.excel.filas === 10 && R.excel.evidencias === filas.reduce((a, f) => a + f.evidencias.length, 0) && R.excel.hojas.join(',') === 'Matriz,Evidencias,Resumen,Inventario', `Excel consolidado: ${R.excel.filas} filas, ${R.excel.evidencias} evidencias, hojas ${R.excel.hojas.join('/')}`);
    ok(R.informe && R.informe.hallazgos === 5 && R.informe.recomendaciones === 5 && R.informe.origen_recomendaciones === 'IA', `informe ejecutivo: ${R.informe && R.informe.hallazgos} hallazgos y ${R.informe && R.informe.recomendaciones} recomendaciones, separados`);
    // Descargas reales de ambos entregables.
    const ExcelJS = require('exceljs'); const JSZip = require('jszip');
    let e = await post('/api/descargas', { tipo: 'auditoria', id: tB });
    let x = await fetch(`http://localhost:3200${e.d.url}`); const xl = Buffer.from(await x.arrayBuffer());
    const libro = new ExcelJS.Workbook(); await libro.xlsx.load(xl);
    const ids = []; libro.getWorksheet('Matriz').eachRow((row, n) => { if (n > 1) ids.push(String(row.getCell(1).value)); });
    ok(ids.join(',') === 'R1,R2,R3,R4,R5,R6,R7,R8,R9,R10' && String(libro.getWorksheet('Resumen').getRow(1).getCell(2).value) === tB, 'el Excel descargado: R1…R10 sin omitir ni duplicar, y lleva el número de este trabajo');
    e = await post('/api/descargas', { tipo: 'auditoria_informe', id: tB });
    x = await fetch(`http://localhost:3200${e.d.url}`); const dx = Buffer.from(await x.arrayBuffer());
    const xml = await (await JSZip.loadAsync(dx)).file('word/document.xml').async('string');
    const txt = xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
    const iH = txt.indexOf('3. Hallazgos'); const iR = txt.indexOf('4. Recomendaciones');
    const hall = txt.slice(iH, iR); const recs = txt.slice(iR);
    ok(e.d.nombre.endsWith('.docx') && txt.includes(tB) && iH > 0 && iR > iH && ['R3', 'R5', 'R6', 'R7', 'R10'].every((id) => hall.includes(`${id} — `) && recs.includes(`${id} (prioridad`)) && !['R1', 'R2', 'R4', 'R8', 'R9'].some((id) => recs.includes(`${id} (prioridad`)),
      `el informe Word descargado separa hallazgos (R3, R5, R6, R7, R10) de recomendaciones, solo sobre hallazgos (${dx.length} bytes)`);
    require('fs').writeFileSync(`${os.tmpdir()}/prueba-h.xlsx`, xl); require('fs').writeFileSync(`${os.tmpdir()}/prueba-h.docx`, dx);
    // Gobernanza.
    const kA = (await api(`/api/auditorias/propuestas/${pA.id.slice(0, 8)}/constancia`)).d;
    const kB = (await api(`/api/auditorias/propuestas/${pB.id.slice(0, 8)}/constancia`)).d;
    for (const k of [kA, kB]) for (const x of k.comprobaciones) if (x.startsWith('✗')) console.log('     ', x);
    ok(kA.resultado === 'correcto' && kB.resultado === 'correcto' && kB.propuesta.propuesto.extraidos_por_trabajo === tA, `constancias de ambas aprobaciones: ${kA.resultado} (${kA.comprobaciones.length}) y ${kB.resultado} (${kB.comprobaciones.length}); la auditoría declara de qué extracción salió su lista`);
    const verFin = (await chat([{ name: 'ver_auditoria', input: {} }], conv)).datos[0];
    ok(verFin.trabajo && verFin.trabajo.id === tB && verFin.trabajo.informe_listo && verFin.trabajo.excel_listo, 'ver_auditoria en la conversación: la auditoría con Excel e informe listos');
  } catch (err) { ok(false, `excepción: ${err.stack}`); console.log(srv.log.slice(-4000)); }
  console.log('\nRESUMEN', JSON.stringify(resumen));
  srv.kill(); drive.kill();
  setTimeout(() => process.exit(), 300);
})();
let ver;
