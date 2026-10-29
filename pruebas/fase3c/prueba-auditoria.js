// Fase 3c — Auditoría mínima con Drive y Claude simulados: 1 documento ficticio, 3 requisitos aprobados,
// resultado correcto conocido, extracción reutilizada (3b), K1/K2/K3, evidencia verificable, Excel
// verificado, costos y presupuesto, y recuperación tras un corte.
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const S = __dirname;
const datos = require('/home/claude/ada/pruebas/datos-ficticios/prueba-a.json');
const resultados = [];
const ok = (c, m) => { const l = (c ? 'ok - ' : 'FALLA: ') + m; console.log(l); resultados.push(l); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const CLAVE = `aud-${crypto.randomBytes(32).toString('base64')}`;
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk;
const logs = [];
async function arrancar(extra = {}) {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: '/home/claude/ada', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: CLAVE, ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba',
      ADA_TRABAJO_LEASE_MS: '3000', ADA_TRABAJO_CICLO_MS: '300', ...extra } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
async function parar(senal = 'SIGTERM') { srv.kill(senal); await dormir(700); logs.push(srv.log); }
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (_) { d = t; } return { status: r.status, d }; };
const post = (ruta, body) => api(ruta, { method: 'POST', body: JSON.stringify(body || {}) });
const REQ = datos.documento_base.requisitos;
const ESP = datos.resultado_correcto.map((x) => ({ id: x.id, estado: x.estado }));
async function esperar(id, estados = ['completado', 'bloqueado', 'cancelado', 'pausado_presupuesto'], ms = 30000) {
  const fin = Date.now() + ms; let v;
  while (Date.now() < fin) { v = (await api(`/api/trabajos/${id}?resultado=1`)).d; if (v && estados.includes(v.estado)) return v; await dormir(250); }
  return v;
}
const auditoria = (config, presupuesto, archivo = 'AUD1') => post('/api/auditorias', { archivo_id: archivo, requisitos: REQ, esperado: ESP, configuracion: config, presupuesto });
const llamadasDe = (id) => sql(`SELECT CONCAT(modelo,'|',IFNULL(error,'')) FROM llamadas_ia WHERE trabajo_id='${id}' ORDER BY creado_en`).split('\n').filter(Boolean);

(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM extraccion_eventos');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  const texto = datos.documento_evidencia.texto;
  await ctl('/control/archivos', { archivos: [
    { id: 'AUD1', name: 'Expediente ficticio Sala Aurora.pdf', mimeType: 'application/pdf', texto, md5Checksum: 'aud-v1', version: 1, parents: ['carpeta-prueba'] },
    { id: 'AUDX', name: 'Documento fuera de la carpeta.pdf', mimeType: 'application/pdf', texto, md5Checksum: 'x', version: 1, parents: ['otra'] },
  ] });
  await arrancar();

  // ---- Estimación y presupuesto ----
  const est = await post('/api/auditorias/estimar', { archivo_id: 'AUD1', requisitos: REQ });
  console.log('   estimación:', JSON.stringify(est.d.por_configuracion), 'mínimos:', JSON.stringify(est.d.presupuesto_minimo));
  ok(est.status === 200 && est.d.por_configuracion.K2 < est.d.por_configuracion.K3 && est.d.por_configuracion.K3 < est.d.por_configuracion.K1, 'estimación previa por configuración: K2 < K3 < K1');
  let r = await auditoria('K3', 0.01);
  ok(r.status === 400 && /menor que el mínimo/.test(r.d.error), 'presupuesto bajo el mínimo: no empieza');

  // ---- K3 con respuestas correctas ----
  await ctl('/control/reset', {});
  r = await auditoria('K3', est.d.presupuesto_minimo.K3);
  ok(r.status === 200 && r.d.estado === 'ejecutando', 'K3: requisitos y presupuesto aprobados en un solo acto; empieza');
  let v = await esperar(r.d.id);
  ok(v.estado === 'completado', `K3: ${v.estado}${v.motivo ? ` (${v.motivo})` : ''}`);
  const res = v.resultado || {};
  ok(res.precision && res.precision.aciertos === 3 && res.precision.total === 3, `K3: precisión ${res.precision && res.precision.aciertos}/3 frente al resultado correcto`);
  const filas = res.matriz.filas;
  ok(filas.every((f) => f.cita_verificada && f.cita && f.ubicacion && f.archivo_id === 'AUD1' && f.archivo_version), 'cada requisito con cita verificada textualmente, ubicación, archivo y versión');
  ok(filas.map((f) => f.ubicacion).join(',') === 'página 1,página 2,página 3', `ubicaciones: ${filas.map((f) => f.ubicacion).join(', ')}`);
  const llK3 = llamadasDe(r.d.id);
  ok(llK3.length === 4 && llK3.filter((x) => /haiku/.test(x)).length === 3 && llK3.filter((x) => /sonnet/.test(x)).length === 1, `K3: 3 llamadas a Haiku y 1 a Sonnet (segunda opinión en R3, condicional): ${llK3.length} llamadas`);
  ok(res.costos.real_usd > 0 && res.costos.reservas >= 3 && res.costos.reservado_total_usd > res.costos.real_usd && res.costos.estimado_previo_usd > 0,
    `costos: real US$${res.costos.real_usd.toFixed(5)} · estimado previo US$${res.costos.estimado_previo_usd.toFixed(5)} · reservado US$${res.costos.reservado_total_usd.toFixed(5)} (${res.costos.reservas} reservas)`);
  ok(v.gastado_usd <= v.presupuesto_usd, `respetó el presupuesto (US$${v.gastado_usd.toFixed(5)} de US$${v.presupuesto_usd})`);
  let st = await ctl('/control/stats');
  ok(Object.values(st.export).reduce((a, b) => a + b, 0) === 1, `el documento se descargó y convirtió 1 vez (extraer) y la selección reutilizó la extracción (3b): ${JSON.stringify(st.export)}`);
  // Excel real
  const xr = await fetch(`http://localhost:3200/api/auditorias/${r.d.id}/excel`, { headers: { Authorization: `Bearer ${tk}` } });
  const buf = Buffer.from(await xr.arrayBuffer());
  fs.writeFileSync(`${S}/auditoria-K3.xlsx`, buf);
  const ExcelJS = require(require.resolve('exceljs', { paths: ['/home/claude/ada'] }));
  const libro = new ExcelJS.Workbook(); await libro.xlsx.load(buf);
  const hoja = libro.getWorksheet('Matriz');
  const ex = []; hoja.eachRow((row, n) => { if (n > 1) ex.push([row.getCell(1).value, row.getCell(3).value, row.getCell(5).value]); });
  ok(xr.status === 200 && ex.length === 3 && ex.map((x) => x[1]).join(',') === 'cumple,parcial,no_aplica_justificado' && ex.every((x) => x[2]), `Excel real: 3 filas con estados, citas y justificaciones (${ex.map((x) => `${x[0]}=${x[1]}`).join(', ')})`);

  // ---- Segunda auditoría del mismo documento: 0 descargas (reutiliza 3b) ----
  await ctl('/control/reset', {});
  r = await auditoria('K2', est.d.presupuesto_minimo.K2);
  v = await esperar(r.d.id);
  st = await ctl('/control/stats');
  ok(v.estado === 'completado' && Object.keys(st.export).length === 0 && st.total_meta === 2, `K2 sobre el mismo documento: ${v.estado}, 0 descargas (solo ${st.total_meta} consultas de permisos y versión)`);
  ok(llamadasDe(r.d.id).every((x) => /haiku/.test(x)) && v.resultado.precision.aciertos === 3, `K2 (solo Haiku): ${v.resultado.precision.aciertos}/3`);
  await parar();

  // ---- Haiku cita mal R2: K2 lo deja "no_evaluado"; K3 escala a Sonnet ----
  await arrancar({ FAKE_AUDITOR: 'haiku_falla_cita' });
  r = await auditoria('K2', est.d.presupuesto_minimo.K2);
  v = await esperar(r.d.id);
  const r2k2 = v.resultado.matriz.filas.find((f) => f.requisito === 'R2');
  ok(v.estado === 'completado' && r2k2.estado === 'no_evaluado' && !r2k2.cita_verificada && v.resultado.precision.aciertos === 2,
    `K2 con cita inventada: R2 queda "no_evaluado" (nunca cumple ni parcial sin evidencia); precisión 2/3`);
  r = await auditoria('K3', est.d.presupuesto_minimo.K3);
  v = await esperar(r.d.id);
  const r2k3 = v.resultado.matriz.filas.find((f) => f.requisito === 'R2');
  ok(v.estado === 'completado' && r2k3.estado === 'parcial' && r2k3.cita_verificada && /sonnet/.test(r2k3.modelo) && v.resultado.precision.aciertos === 3 && v.resultado.escalados >= 2,
    `K3 con la misma falla: R2 escala a Sonnet y queda "parcial" con cita verificada; precisión 3/3, ${v.resultado.escalados} requisitos escalados`);
  await parar();

  // ---- "cumple" sin cita nunca pasa ----
  await arrancar({ FAKE_AUDITOR: 'cumple_sin_cita' });
  r = await auditoria('K1', est.d.presupuesto_minimo.K1);
  v = await esperar(r.d.id);
  const r1 = v.resultado.matriz.filas.find((f) => f.requisito === 'R1');
  ok(r1.estado === 'no_evaluado' && /sin cita/.test(r1.justificacion), `"cumple" sin cita en los dos intentos: R1 queda "${r1.estado}"`);
  await parar();

  // ---- Presupuesto: si el costo real supera lo autorizado, se pausa ----
  await arrancar({ FAKE_AUDITOR: 'caro' });
  r = await auditoria('K1', est.d.presupuesto_minimo.K1);
  v = await esperar(r.d.id);
  ok(v.estado === 'pausado_presupuesto', `costo real muy superior al estimado: el encargo se pausa (${v.estado}: ${v.motivo})`);
  ok(sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${r.d.id}'`) === '1', 'se detuvo tras el primer paso caro (exceso acotado a un paso)');
  await post(`/api/trabajos/${r.d.id}/cancelar`);
  await parar();

  // ---- Recuperación tras un corte en medio de la verificación ----
  await arrancar({ FAKE_AUDITOR: 'lento', FAKE_LENTO_MS: '1500' });
  r = await auditoria('K1', est.d.presupuesto_minimo.K1);
  const id = r.d.id;
  for (let i = 0; i < 80; i++) { if (sql(`SELECT estado FROM trabajo_pasos WHERE trabajo_id='${id}' AND clave='verificar:R1'`) === 'hecho') break; await dormir(100); }
  await dormir(600); // en medio de verificar:R2
  ok(sql(`SELECT estado FROM trabajo_pasos WHERE trabajo_id='${id}' AND clave='verificar:R2'`) === 'en_curso', 'corte del servidor con verificar:R2 en curso');
  await parar('SIGKILL');
  await arrancar({ FAKE_AUDITOR: 'lento', FAKE_LENTO_MS: '200' });
  v = await esperar(id, ['completado', 'bloqueado'], 40000);
  const porPaso = sql(`SELECT p.clave, COUNT(l.id) FROM trabajo_pasos p LEFT JOIN llamadas_ia l ON l.paso_id = p.id AND l.error IS NULL WHERE p.trabajo_id='${id}' AND p.tipo='aud_verificar' GROUP BY p.clave ORDER BY p.clave`).replace(/\t/g, '=').split('\n');
  ok(v.estado === 'completado' && v.resultado.precision.aciertos === 3, `tras reiniciar retoma y completa (${v.estado}, ${v.resultado && v.resultado.precision.aciertos}/3)`);
  ok(porPaso[0] === 'verificar:R1=1' && porPaso[2] === 'verificar:R3=1', `lo hecho no se repite: llamadas exitosas por paso ${porPaso.join(', ')} (R2 se repite una vez porque el corte fue en medio de su llamada)`);
  await parar();

  // ---- Serie K1, K2, K3 (comparación) ----
  await arrancar();
  r = await auditoria('comparar', est.d.presupuesto_minimo_comparar);
  ok(r.status === 200, 'comparación K1/K2/K3 con un solo presupuesto aprobado');
  const fin = Date.now() + 60000; let lista = [];
  while (Date.now() < fin) {
    lista = (await api('/api/auditorias')).d.filter((x) => x.creado_en && new Date(x.creado_en) >= new Date(Date.now() - 120000));
    if (lista.filter((x) => x.estado === 'completado').length >= 3 && lista.slice(0, 3).every((x) => x.estado === 'completado')) break;
    await dormir(400);
  }
  const serie = lista.slice(0, 3).reverse();
  console.log('   comparación:'); for (const x of serie) console.log(`     ${x.config}: ${x.estado} · precisión ${x.precision ? `${x.precision.aciertos}/${x.precision.total}` : '-'} · ${x.costos.llamadas} llamadas · US$${x.costos.real_usd.toFixed(5)} · modelos ${x.modelos.join(' / ')}`);
  ok(serie.map((x) => x.config).join(',') === 'K1,K2,K3' && serie.every((x) => x.estado === 'completado'), 'la serie corrió K1, K2 y K3 en orden, una a la vez');
  fs.writeFileSync(`${S}/resultado-auditoria-serie.json`, JSON.stringify(serie, null, 2));

  await parar();

  // ---- Incidente del 29/10: la llamada a Sonnet falla con 400 en K3 (R3) ----
  await arrancar({ FAKE_SONNET_ERROR: 'si' });
  r = await auditoria('K3', est.d.presupuesto_minimo.K3);
  const idInc = r.d.id;
  v = await esperar(idInc, ['bloqueado', 'completado']);
  const pasosInc = sql(`SELECT CONCAT(clave,'=',estado) FROM trabajo_pasos WHERE trabajo_id='${idInc}' ORDER BY orden`).split('\n');
  ok(v.estado === 'bloqueado' && pasosInc.includes('verificar:R1=hecho') && pasosInc.includes('verificar:R2=hecho') && pasosInc.includes('verificar:R3=fallido'), `incidente reproducido: bloqueado en verificar:R3 con R1 y R2 hechos (${pasosInc.join(', ')})`);
  ok(sql(`SELECT COUNT(*) FROM reservas_ia WHERE trabajo_id='${idInc}' AND estado='activa'`) === '0', 'al bloquearse no queda ninguna reserva activa');
  const lst = (await api('/api/auditorias')).d.find((x) => x.id === idInc);
  ok(lst && lst.pasos_detalle.find((x) => x.paso === 'verificar:R1').resultado === 'cumple' && lst.pasos_detalle.find((x) => x.paso === 'verificar:R2').resultado === 'parcial', 'Ajustes muestra los resultados conservados de R1 y R2');
  await parar();
  // Con la corrección (Sonnet sin herramienta forzada), "Reintentar" sigue desde R3 sin repetir R1 ni R2.
  await arrancar();
  const antesR = sql(`SELECT COUNT(*) FROM llamadas_ia l JOIN trabajo_pasos p ON p.id = l.paso_id WHERE l.trabajo_id='${idInc}' AND p.clave IN ('verificar:R1','verificar:R2') AND l.error IS NULL`);
  await post(`/api/trabajos/${idInc}/reintentar`);
  v = await esperar(idInc, ['completado', 'bloqueado']);
  const despuesR = sql(`SELECT COUNT(*) FROM llamadas_ia l JOIN trabajo_pasos p ON p.id = l.paso_id WHERE l.trabajo_id='${idInc}' AND p.clave IN ('verificar:R1','verificar:R2') AND l.error IS NULL`);
  ok(v.estado === 'completado' && v.resultado.precision.aciertos === 3 && antesR === despuesR, `reintentar desde R3: ${v.estado}, ${v.resultado && v.resultado.precision.aciertos}/3, sin volver a llamar por R1 ni R2`);
  // Cancelar un encargo bloqueado libera todo.
  await parar();
  await arrancar({ FAKE_SONNET_ERROR: 'si' });
  r = await auditoria('K3', est.d.presupuesto_minimo.K3);
  v = await esperar(r.d.id, ['bloqueado']);
  await post(`/api/trabajos/${r.d.id}/cancelar`);
  const vc = (await api(`/api/trabajos/${r.d.id}`)).d;
  ok(vc.estado === 'cancelado' && vc.reservado_usd === 0 && sql(`SELECT COUNT(*) FROM reservas_ia WHERE trabajo_id='${r.d.id}' AND estado='activa'`) === '0', 'cancelar tras el error: cancelado y reservas liberadas (US$0 reservado)');
  await parar();
  // Si también Haiku rechazara la herramienta forzada: se recuerda y se repite con "auto".
  await arrancar({ FAKE_FORZADO_TODOS: 'si' });
  r = await auditoria('K2', est.d.presupuesto_minimo.K2);
  v = await esperar(r.d.id);
  ok(v.estado === 'completado' && v.resultado.precision.aciertos === 3, `modelo que rechaza la herramienta forzada: se repite con tool_choice auto y completa (${v.estado})`);
  await parar();
  await arrancar();

  // ---- Documento fuera de la carpeta de prueba: el encargo no lo lee ----
  r = await auditoria('K2', est.d.presupuesto_minimo.K2, 'AUDX');
  v = await esperar(r.d.id, ['bloqueado', 'completado']);
  ok(v.estado === 'bloqueado' && sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${r.d.id}'`) === '0', `documento fuera de la carpeta de prueba: encargo bloqueado sin llamar a la IA (${v.motivo})`);
  await post(`/api/trabajos/${r.d.id}/cancelar`);
  await parar();
  ok(!logs.join('\n').includes('vigente hasta septiembre de 2027'), 'los logs no contienen texto del documento');
  fs.writeFileSync(`${S}/resultado-auditoria.txt`, resultados.join('\n') + '\n');
  drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch(async (e) => { console.error(e); if (srv) { console.error(srv.log.slice(-2500)); srv.kill(); } process.exit(1); });
