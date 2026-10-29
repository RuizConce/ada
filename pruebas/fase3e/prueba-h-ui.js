// Fase 3e (interfaz, teléfono 390×900): auditoría con norma desde el chat — tarjeta "Extraer requisitos" → aprobar →
// lista con fuentes (paso 2) → aprobar → avance → Excel e informe Word descargados desde la tarjeta final.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const S = __dirname;
const H = require('../datos-ficticios/prueba-h.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
const foto = (p, n) => p.screenshot({ path: `${os.tmpdir()}/v-h-${n}.png` });
(async () => {
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM auditoria_propuestas'); sql('DELETE FROM extracciones');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [
    { id: 'carpeta-prueba', name: 'Prueba ADA', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { id: 'HN', name: H.norma.nombre, mimeType: 'application/pdf', texto: H.norma.texto, md5Checksum: 'hn', version: 1, parents: ['carpeta-prueba'] },
    ...H.documentos.map((d) => ({ id: d.id, name: d.nombre, mimeType: 'application/pdf', texto: d.texto, md5Checksum: d.id, version: 1, parents: ['carpeta-prueba'] })),
  ] }) });
  const srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'ui-3e-clave-fija-para-esta-prueba-0123456789-abcdef', ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba',
      ADA_TRABAJO_CICLO_MS: '200', ADA_TURNOS_2MIN: '100', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-h.json') } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  p.on('pageerror', (e) => console.log('ERROR JS:', e.message));
  await p.goto('http://localhost:3200/');
  await p.fill('#nombre', 'Cristian'); await p.fill('#password', 'p'); await p.click('button[type=submit]');
  await p.waitForTimeout(1200);
  await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
  await p.$eval('#teclado', (e) => e.click());
  await p.fill('#mensaje', `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input: { norma_id: 'HN', carpeta_id: 'carpeta-prueba', motivo: 'Prueba H' } }] })}`);
  await p.$eval('#enviar', (e) => e.click());
  await p.waitForSelector('text=Extraer requisitos de la norma', { timeout: 8000 });
  let t = await p.textContent('#entregas');
  ok(/Paso 1 de 2/.test(t) && /Norma: Pauta ficticia/.test(t) && /Documentos a auditar después \(5\)/.test(t) && /Nada se analiza contra tus documentos/.test(t), 'tarjeta paso 1: norma, 5 documentos, costo y que nada se analiza todavía');
  await p.$eval('.tarjeta-auditoria', (e) => e.scrollIntoView()); await foto(p, '1-extraer');
  await p.click('text=Aprobar extracción');
  await p.waitForSelector('text=Revisa los 10 requisitos y aprueba la auditoría', { timeout: 20000 });
  t = await p.textContent('#entregas');
  ok(/Requisitos extraídos/.test(t) && /Lista de 10 requisitos lista/.test(t), 'la extracción termina y avisa que la lista está lista (paso 2)');
  const lineas = (await p.inputValue('.tarjeta-auditoria[data-propuesta] .aud-req')).split('\n');
  ok(lineas.length === 10 && lineas[0].startsWith('R1 | La sala de procedimientos') && lineas[9].startsWith('R10 |'), 'la tarjeta paso 2 trae los 10 requisitos editables');
  await p.click('text=Ver de dónde sale cada requisito en la norma');
  ok(/R5 · Art\. 5: «Si en el recinto se esteriliza/.test(await p.textContent('.aud-fuentes')), 'muestra la cita de la norma de cada requisito');
  await p.$eval('.tarjeta-auditoria[data-propuesta]', (e) => e.scrollIntoView()); await foto(p, '2-lista');
  await p.click('.tarjeta-auditoria[data-propuesta] >> text=Aprobar y empezar');
  await p.waitForFunction(() => /Auditoría terminada/.test(document.querySelector('#entregas').textContent), null, { timeout: 40000 });
  t = await p.textContent('#entregas');
  ok(/R4: Cumple/.test(t) && /R5: Contradictorio/.test(t) && /R10: Sin evidencia/.test(t) && /Descargar Excel/.test(t) && /Descargar informe/.test(t), 'tarjeta final: resultados por requisito y dos descargas (Excel e informe)');
  await p.$$eval('.tarjeta-auditoria', (l) => l[l.length - 1].scrollIntoView()); await foto(p, '3-final');
  const [dx] = await Promise.all([p.waitForEvent('download'), p.click('#entregas >> text=Descargar Excel')]);
  const [dw] = await Promise.all([p.waitForEvent('download'), p.click('#entregas >> text=Descargar informe')]);
  await dx.saveAs(`${os.tmpdir()}/h-ui.xlsx`); await dw.saveAs(`${os.tmpdir()}/h-ui.docx`);
  ok(/\.xlsx$/.test(dx.suggestedFilename()) && /^informe-auditoria-.*\.docx$/.test(dw.suggestedFilename()) && fs.statSync(`${os.tmpdir()}/h-ui.docx`).size > 5000, `descarga ${dx.suggestedFilename()} y ${dw.suggestedFilename()}`);
  await b.close(); srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
