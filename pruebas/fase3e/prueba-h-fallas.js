// Fase 3e — Prueba H, fallas controladas (simuladas): lo que NO debe pasar aunque la IA o los datos fallen.
//  a) La IA no encuentra requisitos en la norma → la extracción se detiene con un motivo claro y no se propone auditoría.
//  b) La norma cambia entre la propuesta y la aprobación → la extracción se detiene; no se extrae de otra versión.
//  c) La IA cita algo que no está en los documentos (R2, R6) → esos requisitos quedan "no evaluado", nunca "cumple";
//     el resto de la auditoría termina y los entregables lo reflejan.
const { spawn, execSync } = require('child_process');
const S = __dirname;
const H = require('../datos-ficticios/prueba-h.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk;
async function arrancar(extra = {}) {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'h-fallas-clave-fija-0123456789-abcdefghijklmnopq', ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba',
      ADA_TRABAJO_CICLO_MS: '200', ADA_TURNOS_2MIN: '100', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-h.json'), ...extra } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
const parar = async () => { srv.kill(); await dormir(600); };
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (_) { d = t; } return { status: r.status, d }; };
const post = (ruta, body) => api(ruta, { method: 'POST', body: JSON.stringify(body || {}) });
async function proponer(input) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: JSON.stringify({ mensaje: `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input }] })}`, tarjetas: ['auditoria_propuesta@1'] }) });
  const t = await r.text();
  const ev = t.split('\n\n').filter((b) => b.startsWith('event: auditoria_propuesta')).map((b) => JSON.parse(b.split('\n')[1].slice(6)));
  return ev[0];
}
async function esperar(id) { for (let i = 0; i < 300; i++) { const a = (await api(`/api/auditorias/${id}/avance`)).d; if (['completado', 'bloqueado', 'cancelado'].includes(a.estado)) return a; await dormir(200); } return null; }
(async () => {
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM auditoria_propuestas');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await ctl('/control/archivos', { archivos: [
    { id: 'carpeta-prueba', name: 'Prueba ADA', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { id: 'HN', name: H.norma.nombre, mimeType: 'application/pdf', texto: H.norma.texto, md5Checksum: 'hn-v1', version: 1, parents: ['carpeta-prueba'] },
    ...H.documentos.map((d) => ({ id: d.id, name: d.nombre, mimeType: 'application/pdf', texto: d.texto, md5Checksum: d.id, version: 1, parents: ['carpeta-prueba'] })),
  ] });
  try {
    // a) Norma sin requisitos reconocibles.
    await arrancar({ FAKE_H_EXTRACCION: 'vacia' });
    let p = await proponer({ norma_id: 'HN', carpeta_id: 'carpeta-prueba' });
    let r = await post(`/api/auditorias/propuestas/${p.id}/aprobar`, { presupuesto: p.presupuesto_sugerido });
    let a = await esperar(r.d.trabajo_id);
    ok(a.estado === 'bloqueado' && /ningún requisito/.test(a.motivo) && !a.lista_propuesta, `a) sin requisitos: la extracción se detiene ("${a.motivo}") y no se propone ninguna auditoría`);
    await post(`/api/trabajos/${r.d.trabajo_id}/cancelar`);
    await parar();

    // b) La norma cambia después de proponer.
    await arrancar();
    p = await proponer({ norma_id: 'HN', carpeta_id: 'carpeta-prueba' });
    await ctl('/control/cambiar', { id: 'HN', cambios: { version: 2, md5Checksum: 'hn-v2', texto: `${H.norma.texto}\nArtículo 13. Texto agregado después.` } });
    r = await post(`/api/auditorias/propuestas/${p.id}/aprobar`, { presupuesto: p.presupuesto_sugerido });
    a = await esperar(r.d.trabajo_id);
    ok(a.estado === 'bloqueado' && /La norma cambió desde la propuesta/.test(a.motivo) && Number(sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${r.d.trabajo_id}'`)) === 0, `b) norma modificada: se detiene sin llamar a la IA ("${a.motivo.slice(0, 90)}…")`);
    await post(`/api/trabajos/${r.d.trabajo_id}/cancelar`);
    await ctl('/control/cambiar', { id: 'HN', cambios: { version: 1, md5Checksum: 'hn-v1', texto: H.norma.texto } });
    await parar();

    // c) Citas que no están en los documentos.
    await arrancar({ FAKE_H_MAL: 'R2,R6' });
    p = await proponer({ norma_id: 'HN', carpeta_id: 'carpeta-prueba' });
    r = await post(`/api/auditorias/propuestas/${p.id}/aprobar`, { presupuesto: p.presupuesto_sugerido });
    a = await esperar(r.d.trabajo_id);
    const lista = (await api('/api/auditorias/propuestas')).d.find((x) => x.id === a.lista_propuesta.propuesta_id);
    r = await post(`/api/auditorias/propuestas/${lista.id}/aprobar`, { presupuesto: lista.presupuesto_sugerido });
    a = await esperar(r.d.trabajo_id);
    const t = (await api(`/api/trabajos/${r.d.trabajo_id}?resultado=1`)).d;
    const f = (id) => t.resultado.matriz.filas.find((x) => x.requisito === id);
    ok(a.estado === 'completado' && f('R2').estado === 'no_evaluado' && f('R6').estado === 'no_evaluado' && !f('R2').evidencias.length, `c) citas inventadas: R2 y R6 quedan "no evaluado" (nunca "cumple"); la auditoría termina (${a.estado})`);
    ok(t.resultado.informe.hallazgos === 6 && f('R1').estado === 'cumple' && f('R5').estado === 'contradictorio', 'c) el informe los cuenta como hallazgos a revisar (6: R2 y R6 sin evaluar, más R3, R5, R7 y R10) y el resto sigue correcto');
    const intentos = sql(`SELECT COUNT(*) FROM llamadas_ia l JOIN trabajo_pasos p ON p.id = l.paso_id WHERE l.trabajo_id='${r.d.trabajo_id}' AND p.clave IN ('verificar:R2','verificar:R6')`);
    ok(Number(intentos) === 4, `c) cada uno tuvo exactamente 2 intentos (uno de corrección) y se detuvo: ${intentos} llamadas`);
    await parar();
  } catch (e) { ok(false, `excepción: ${e.stack}`); console.log(srv.log.slice(-3000)); }
  try { srv.kill(); } catch (_) {}
  drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
  setTimeout(() => process.exit(), 300);
})();
