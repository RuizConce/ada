// Fase 3b (interfaz): tarjeta de consentimiento en el chat y sección "Documentos guardados" en Ajustes.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const S = __dirname;
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString().trim();
(async () => {
  sql('DELETE FROM extracciones'); sql('DELETE FROM extraccion_eventos'); sql("DELETE FROM integraciones WHERE nombre='extracciones_consentimiento'");
  const drive = spawn('node', [`${S}/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [{ id: 'U1', name: 'Ficticio.pdf', mimeType: 'application/pdf', texto: 'MARCA-UI texto ficticio', md5Checksum: 'x1', version: 1 }] }) });
  const srv = spawn('node', ['-r', `${S}/fake-claude-3b.js`, 'src/server.js'], { cwd: '/home/claude/ada', stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: `ui-${crypto.randomBytes(32).toString('base64')}`, ADA_EXTRACCIONES: 'si', ADA_DRIVE_URL: 'http://localhost:9933', ADA_TOPE_TURNO: '50', ADA_TURNOS_2MIN: '100' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  p.on('pageerror', (e) => console.log('ERROR JS:', e.message));
  await p.goto('http://localhost:3200/');
  await p.fill('#nombre', 'Cristian'); await p.fill('#password', 'p'); await p.click('button[type=submit]');
  await p.waitForTimeout(1200);
  await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
  await p.$eval('#teclado', (e) => e.click()); await p.fill('#mensaje', 'LEE {"lotes":[[{"id":"U1"}]]}');
  await p.$eval('#enviar', (e) => e.click());
  await p.waitForSelector('.tarjeta-consentimiento', { timeout: 8000 });
  const txt = await p.textContent('.tarjeta-consentimiento');
  ok(/cifrado/.test(txt) && /30 días/.test(txt) && /Aceptar y guardar cifrado/.test(txt) && /No guardar/.test(txt), 'en el chat aparece la tarjeta de consentimiento con sus dos botones');
  await p.screenshot({ path: `${S}/v-consentimiento.png` });
  ok(sql('SELECT COUNT(*) FROM extracciones') === '0', 'antes de responder no se guardó nada');
  await p.click('.tarjeta-consentimiento .principal');
  await p.waitForTimeout(800);
  ok(!(await p.$('.tarjeta-consentimiento')) && sql("SELECT datos FROM integraciones WHERE nombre='extracciones_consentimiento'").includes('aceptado'), 'al aceptar, la tarjeta desaparece y queda registrado');
  await p.fill('#mensaje', 'LEE {"lotes":[[{"id":"U1","desde":1}]]}');
  await p.$eval('#enviar', (e) => e.click());
  await p.waitForTimeout(1500);
  ok(sql("SELECT COUNT(*) FROM extracciones WHERE estado='valida'") === '1', 'la siguiente lectura queda guardada cifrada');
  await p.$eval('#abrir-ajustes', (e) => e.click());
  await p.waitForTimeout(1200);
  ok(!(await p.$eval('#docs-guardados', (e) => e.hidden)), 'Ajustes: sección Documentos guardados visible');
  const dg = await p.$eval('#docs-guardados', (e) => e.innerText);
  console.log('   ' + dg.replace(/\n+/g, ' | '));
  ok(/Extracciones nuevas \(cifradas\)\s*1/.test(dg) && /Descargas de contenido\s*2/.test(dg) && /Operaciones redundantes\s*0/.test(dg), 'Ajustes muestra las métricas de hoy');
  ok(/Aceptado/.test(dg) && /1 \(0 mil caracteres\)/.test(dg) && /30 días/.test(dg) && !dg.includes('MARCA-UI'), 'muestra consentimiento, cantidad y retención, sin contenido');
  await p.$eval('#docs-guardados', (e) => e.scrollIntoView());
  await p.screenshot({ path: `${S}/v-docs-guardados.png` });
  p.on('dialog', (d) => d.accept());
  await p.click('#dg-borrar');
  await p.waitForTimeout(800);
  ok(sql('SELECT COUNT(*) FROM extracciones') === '0' && /0 \(0 mil/.test(await p.textContent('#dg-cantidad')), 'Borrar documentos guardados: borra todo');
  await p.click('#dg-retirar');
  await p.waitForTimeout(800);
  ok(/No guardar/.test(await p.textContent('#dg-consentimiento')) && !(await p.$eval('#dg-aceptar', (e) => e.hidden)), 'Dejar de guardar: vuelve a "No guardar" y ofrece aceptar');
  await b.close(); srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
