// Fase 3c (interfaz): lanzar la auditoría mínima desde Ajustes y descargar el Excel.
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
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  const datos = require('/home/claude/ada/pruebas/datos-ficticios/prueba-a.json');
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [{ id: 'AUD1', name: 'Expediente ficticio Sala Aurora.pdf', mimeType: 'application/pdf', texto: datos.documento_evidencia.texto, md5Checksum: 'u', version: 1, parents: ['carpeta-prueba'] }] }) });
  const srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: '/home/claude/ada', stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: `ui-${crypto.randomBytes(32).toString('base64')}`, ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_TRABAJO_CICLO_MS: '300' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  p.on('pageerror', (e) => console.log('ERROR JS:', e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:3200/');
  await p.fill('#nombre', 'Cristian'); await p.fill('#password', 'p'); await p.click('button[type=submit]');
  await p.waitForTimeout(1200);
  await p.$eval('#abrir-ajustes', (e) => e.click());
  await p.waitForTimeout(1000);
  ok(!(await p.$eval('#ajuste-auditoria', (e) => e.hidden)), 'Ajustes muestra la sección de auditoría (administrador)');
  await p.fill('#aud-archivo', 'AUD1');
  await p.click('#aud-ficticios');
  await p.click('#aud-estimar'); await p.waitForTimeout(700);
  const est = await p.textContent('#aud-estimacion');
  ok(/K1 US\$/.test(est) && /mínimo para K3/.test(est) && Number(await p.inputValue('#aud-presupuesto')) > 0, `estimación visible y presupuesto sugerido (${await p.inputValue('#aud-presupuesto')})`);
  await p.click('#aud-empezar');
  await p.waitForFunction(() => /completado/.test(document.querySelector('#aud-lista').textContent), null, { timeout: 30000 });
  const t = await p.textContent('#aud-lista');
  ok(/precisión 3\/3/.test(t) && /R1: cumple \(cita verificada, página 1\)/.test(t) && /Costo real US\$/.test(t) && /reserva activa ahora US\$0,0000/.test(t), 'la tarjeta muestra precisión, costo y la matriz con citas verificadas');
  await p.$eval('#ajuste-auditoria', (e) => e.scrollIntoView());
  await p.screenshot({ path: `${require("os").tmpdir()}/v-auditoria.png`, fullPage: false });
  const [descarga] = await Promise.all([p.waitForEvent('download'), p.click('#aud-lista >> text=Descargar Excel')]);
  const ruta = `${require("os").tmpdir()}/auditoria-ui.xlsx`; await descarga.saveAs(ruta);
  ok(require('fs').statSync(ruta).size > 3000, 'descarga el Excel');
  await b.close(); srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
