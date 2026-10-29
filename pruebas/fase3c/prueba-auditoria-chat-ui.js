// Fase 3d (interfaz): tarjeta de propuesta en el chat → Aprobar → tarjeta de avance → Excel desde el chat → se recupera al recargar.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const S = __dirname;
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
(async () => {
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql("DELETE FROM trabajos WHERE tipo='auditoria'");
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  const datos = require('/home/claude/ada/pruebas/datos-ficticios/prueba-a.json');
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [{ id: 'AUD1', name: 'Expediente ficticio Sala Aurora.pdf', mimeType: 'application/pdf', texto: datos.documento_evidencia.texto, md5Checksum: 'u', version: 1, parents: ['carpeta-prueba'] }] }) });
  const arrancar = () => spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: '/home/claude/ada', stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'ui-3d-clave-fija-para-esta-prueba-0123456789-abcdef', ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba',
      ADA_TRABAJO_CICLO_MS: '300', FAKE_AUDITOR: 'lento', FAKE_LENTO_MS: '2500' } });
  let srv = arrancar();
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  p.on('pageerror', (e) => console.log('ERROR JS:', e.message));
  await p.goto('http://localhost:3200/');
  await p.fill('#nombre', 'Cristian'); await p.fill('#password', 'p'); await p.click('button[type=submit]');
  await p.waitForTimeout(1200);
  await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
  const req = datos.documento_base.requisitos;
  await p.$eval('#teclado', (e) => e.click());
  await p.fill('#mensaje', `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input: { archivo_ids: ['AUD1'], requisitos: req, motivo: 'Prueba desde el chat' } }] })}`);
  await p.$eval('#enviar', (e) => e.click());
  await p.waitForSelector('.tarjeta-auditoria', { timeout: 8000 });
  let txt = await p.textContent('.tarjeta-auditoria');
  ok(/Auditoría propuesta/.test(txt) && /Sala Aurora/.test(txt) && /Solo se cobra lo real, y nada hasta que apruebes/.test(txt), 'en el chat aparece la tarjeta de propuesta (archivo, requisitos, costo)');
  ok((await p.inputValue('.tarjeta-auditoria .aud-req')).split('\n').length === 3 && await p.inputValue('.tarjeta-auditoria .aud-conf') === 'K1' && Number(await p.inputValue('.tarjeta-auditoria .aud-pres')) > 0, 'requisitos editables, K1 por defecto y presupuesto sugerido');
  ok(Number(sql("SELECT COUNT(*) FROM trabajos WHERE tipo='auditoria'")) === 0, 'antes de aprobar no existe ningún encargo');
  await p.$eval('.tarjeta-auditoria', (e) => e.scrollIntoView());
  await p.screenshot({ path: `${require("os").tmpdir()}/v-aud-propuesta.png` });
  await p.click('.tarjeta-auditoria >> text=Aprobar y empezar');
  await p.waitForFunction(() => /Auditoría en curso/.test(document.querySelector('#entregas').textContent) && /Requisitos evaluados [12]\/3/.test(document.querySelector('#entregas').textContent), null, { timeout: 20000 });
  ok(true, 'tras aprobar, la tarjeta muestra el avance real (requisitos evaluados, pasos, gastado)');
  await p.$eval('.tarjeta-auditoria', (e) => e.scrollIntoView());
  await p.screenshot({ path: `${require("os").tmpdir()}/v-aud-avance.png` });
  // Recarga a mitad de camino: la tarjeta vuelve sola.
  await p.reload(); await p.waitForTimeout(1500);
  await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
  await p.waitForFunction(() => /Auditoría (en curso|terminada)/.test(document.querySelector('#entregas').textContent), null, { timeout: 8000 });
  ok(true, 'al recargar la app, la tarjeta del encargo se recupera');
  await p.waitForFunction(() => /Auditoría terminada/.test(document.querySelector('#entregas').textContent), null, { timeout: 30000 });
  txt = await p.textContent('#entregas');
  ok(/R1: Cumple · cita verificada/.test(txt) && /R2: Parcial/.test(txt) && /R3: No aplica/.test(txt) && /Descargar Excel/.test(txt), 'al terminar muestra el resultado por requisito y el botón del Excel');
  await p.$eval('.tarjeta-auditoria', (e) => e.scrollIntoView());
  await p.screenshot({ path: `${require("os").tmpdir()}/v-aud-terminada.png` });
  const [descarga] = await Promise.all([p.waitForEvent('download'), p.click('#entregas >> text=Descargar Excel')]);
  const ruta = `${require("os").tmpdir()}/auditoria-chat.xlsx`; await descarga.saveAs(ruta);
  ok(require('fs').statSync(ruta).size > 3000, 'descarga el Excel desde el chat');
  await b.close(); srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
