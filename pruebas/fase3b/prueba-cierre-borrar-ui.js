// Cierre 3b (interfaz): "Borrar solo lo guardado de este archivo" borra la extracción de ESE archivo y deja las demás.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const S = __dirname;
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
(async () => {
  sql('DELETE FROM extracciones');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [
    { id: 'BORRABLE1', name: 'PRUEBA_BORRABLE_FASE_3B.pdf', mimeType: 'application/pdf', texto: 'Ficticio borrable.', md5Checksum: 'b1', version: 1, parents: ['carpeta-prueba'] },
    { id: 'QUEDA1', name: 'Otro ficticio.pdf', mimeType: 'application/pdf', texto: 'Ficticio que queda.', md5Checksum: 'q1', version: 1, parents: ['carpeta-prueba'] },
  ] }) });
  const srv = spawn('node', ['src/server.js'], { cwd: `${S}/../..`, stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'borrar-ui-clave-fija-0123456789-abcdefghijklmnop', ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  p.on('pageerror', (e) => console.log('ERROR JS:', e.message));
  await p.goto('http://localhost:3200/');
  await p.fill('#nombre', 'Cristian'); await p.fill('#password', 'p'); await p.click('button[type=submit]');
  await p.waitForTimeout(1200);
  await p.$eval('#abrir-ajustes', (e) => e.click()); await p.waitForTimeout(800);
  await p.$eval('#cierre-3b', (e) => { e.open = true; e.scrollIntoView(); });
  for (const id of ['BORRABLE1', 'QUEDA1']) { await p.fill('#cierre-archivo', id); await p.click('#cierre-leer'); await p.waitForFunction(() => /guardada cifrada/.test(document.querySelector('#cierre-lectura').textContent), null, { timeout: 8000 }); }
  ok(sql("SELECT COUNT(*) FROM extracciones WHERE estado='valida'") === '2', 'dos extracciones guardadas');
  await p.fill('#cierre-archivo', 'BORRABLE1');
  await p.click('#cierre-borrar');
  ok(await p.textContent('#cierre-borrar') === 'Confirmar: borrar solo este archivo' && sql("SELECT COUNT(*) FROM extracciones") === '2', 'el primer toque solo pide confirmar (no borra nada)');
  await p.click('#cierre-borrar');
  await p.waitForFunction(() => /borrado lo guardado de este archivo/.test(document.querySelector('#cierre-lectura').textContent), null, { timeout: 8000 });
  ok(sql("SELECT COUNT(*) FROM extracciones WHERE archivo_id='BORRABLE1'") === '0' && sql("SELECT COUNT(*) FROM extracciones WHERE archivo_id='QUEDA1' AND estado='valida'") === '1', 'se borró solo PRUEBA_BORRABLE_FASE_3B; la otra extracción sigue');
  await p.click('#cierre-leer');
  await p.waitForFunction(() => /descargada y guardada cifrada/.test(document.querySelector('#cierre-lectura').textContent), null, { timeout: 8000 });
  await p.click('#cierre-comprobar');
  await p.waitForFunction(() => /5\. Borrado voluntario/.test(document.querySelector('#cierre-salida').textContent), null, { timeout: 8000 });
  ok(/✓ 5\. Borrado voluntario/.test(await p.textContent('#cierre-salida')), 'la verificación 5 queda aprobada');
  await b.close(); srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
