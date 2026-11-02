// Flujo completo en el teléfono (390×900), carpeta ficticia: pego el enlace → autorizo la carpeta (solo lectura, con
// contraseña, expediente y lista) → reviso inventario, lista y presupuesto → apruebo → descargo Excel y Word con el
// nombre del expediente → en Ajustes veo la carpeta y la revoco.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const os = require('os');
const S = __dirname;
const D = require('../datos-ficticios/prueba-seremi.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql --default-character-set=utf8mb4 -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
const foto = (p, n) => p.screenshot({ path: `${os.tmpdir()}/v-exp-${n}.png` });
const PASS = 'clave-ui-ADA';
const txt = Object.fromEntries(D.archivos.map((a) => [a.id, a.texto]));
(async () => {
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM auditoria_propuestas'); sql('DELETE FROM extracciones');
  try { sql('DELETE FROM carpetas_autorizadas'); sql('DELETE FROM listas_requisitos'); } catch (_) {}
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [{ id: 'carpeta-seremi', name: 'Andaluz (ficticia)', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }, ...D.carpetas, ...D.archivos,
    { id: 'carpeta-cliente2', name: 'Clinica_Dos_SEREMI', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], propietario: 'Cliente Dos' },
    { id: 'C2_NOMINA', name: 'Nomina_personal.pdf', mimeType: 'application/pdf', texto: txt.A_NOMINA, md5Checksum: 'c2n', version: 1, parents: ['carpeta-cliente2'] },
    { id: 'C2_GASES', name: 'NO_APLICA_gases.pdf', mimeType: 'application/pdf', texto: txt.A_GASES, md5Checksum: 'c2g', version: 1, parents: ['carpeta-cliente2'] },
    { id: 'C2_CEDULA', name: 'Cedula_director.pdf', mimeType: 'application/pdf', texto: 'Cédula ficticia.', md5Checksum: 'c2c', version: 1, parents: ['carpeta-cliente2'] }] }) });
  const srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: PASS, ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'exp-ui-clave-fija-0123456789-abcdefghijklmnopq', ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_DRIVE_CARPETAS_LECTURA: 'carpeta-seremi',
      ADA_TRABAJO_CICLO_MS: '150', ADA_TURNOS_2MIN: '200', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-seremi.json'), FAKE_H_EXTRACCION_OMITIR: '32,47' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  p.on('pageerror', (e) => console.log('ERROR JS:', e.message));
  const enviar = async (txt2) => { if (!(await p.isVisible('#mensaje'))) await p.$eval('#teclado', (e) => e.click()).catch(() => {}); await p.fill('#mensaje', txt2); await p.$eval('#enviar', (e) => e.click()); };
  const herr = (input) => `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input }] })}`;
  try {
    await p.goto('http://localhost:3200/');
    await p.fill('#nombre', 'Cristian'); await p.fill('#password', PASS); await p.click('button[type=submit]');
    await p.waitForTimeout(1200); await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
    // Preparación: la lista SEREMI 18–47 (extracción de Andaluz) guardada desde su tarjeta.
    await enviar(herr({ norma_id: D.norma_id, carpeta_id: 'carpeta-seremi', rango: { desde: 18, hasta: 47 }, perfil: 'seremi' }));
    await p.waitForSelector('text=Aprobar extracción', { timeout: 10000 }); await p.click('text=Aprobar extracción');
    await p.waitForSelector('text=Guardar esta lista para reutilizarla', { timeout: 30000 });
    await p.click('text=Guardar esta lista para reutilizarla');
    ok(await p.inputValue('.aud-lista-nombre') === 'SEREMI 18–47', 'la tarjeta de la lista propone el nombre «SEREMI 18–47»');
    await p.fill('.aud-lista-nota', 'Cotejar con el original la frase sobre evaluación anestésica.');
    await p.click('text=Confirmar y guardar la lista');
    await p.waitForSelector('text=Lista guardada', { timeout: 8000 });
    ok(sql("SELECT nombre FROM listas_requisitos WHERE estado='activa'") === 'SEREMI 18–47', 'lista guardada desde el teléfono');
    await p.click('.tarjeta-auditoria[data-propuesta] >> text=Descartar').catch(() => {});

    // 1. Pego el enlace (como lo haría ADA con el mensaje) → tarjeta de autorización.
    await enviar(herr({ carpeta: 'https://drive.google.com/drive/folders/carpeta-cliente2?usp=sharing', lista: 'SEREMI 18–47' }));
    await p.waitForSelector('text=Autorizar carpeta (solo lectura)', { timeout: 10000 });
    let t = await p.textContent('.tarjeta-carpeta');
    ok(/Carpeta: Clinica_Dos_SEREMI · propietario en Drive: Cliente Dos/.test(t) && /No escribe, no mueve ni borra nada/.test(t), 'tarjeta: carpeta, propietario y qué permite (solo lectura)');
    await p.waitForFunction(() => document.querySelector('.tarjeta-carpeta .aud-lista option') && /SEREMI 18–47/.test(document.querySelector('.tarjeta-carpeta .aud-lista').selectedOptions[0].textContent));
    ok(true, 'la lista «SEREMI 18–47» viene seleccionada');
    await p.fill('.tarjeta-carpeta .aud-exp', 'Clínica Ficticia Dos');
    await p.fill('.tarjeta-carpeta .aud-clave', 'equivocada');
    await p.click('.tarjeta-carpeta >> text=Autorizar solo lectura');
    await p.waitForTimeout(800);
    ok(sql('SELECT COUNT(*) FROM carpetas_autorizadas') === '0' && await p.inputValue('.tarjeta-carpeta .aud-clave') === '' && await p.inputValue('.tarjeta-carpeta .aud-exp') === 'Clínica Ficticia Dos', 'contraseña equivocada: no autoriza, borra la contraseña y conserva el nombre del expediente escrito');
    await p.$eval('.tarjeta-carpeta', (e) => e.scrollIntoView()); await foto(p, '1-autorizar');
    await p.fill('.tarjeta-carpeta .aud-clave', PASS);
    await p.click('.tarjeta-carpeta >> text=Autorizar solo lectura');
    // 2. Propuesta: expediente, lista, inventario y presupuesto.
    await p.waitForSelector('text=Expediente: Clínica Ficticia Dos', { timeout: 10000 });
    t = await p.textContent('.tarjeta-auditoria[data-propuesta]');
    ok(/Lista: «SEREMI 18–47» \(validada el \d{4}-\d{2}-\d{2}\) · documento de origen: sin cambios/.test(t) && /evaluación anestésica/.test(t) && /Inventario: 3 archivos · 2 a auditar/.test(t) && /Cedula_director\.pdf/.test(t) && /presupuesto mínimo a reservar/.test(t),
      'tarjeta de auditoría: expediente, lista (con su observación), inventario con el archivo sensible excluido y presupuesto');
    ok((await p.inputValue('.tarjeta-auditoria[data-propuesta] .aud-req')).split('\n').length === 30, '30 requisitos de la lista guardada, sin extraer de nuevo');
    await p.$eval('.tarjeta-auditoria[data-propuesta]', (e) => e.scrollIntoView()); await foto(p, '2-propuesta');
    // 3. Apruebo y recibo.
    await p.click('.tarjeta-auditoria[data-propuesta] >> text=Aprobar y empezar');
    await p.waitForFunction(() => /Auditoría terminada/.test(document.querySelector('#entregas').textContent), null, { timeout: 90000 });
    t = await p.textContent('#entregas');
    ok(/Expediente: Clínica Ficticia Dos · Trabajo/.test(t) && /Puedes subir/.test(t), 'tarjeta final con el expediente y la respuesta sencilla');
    await p.$$eval('.tarjeta-auditoria', (l) => l[l.length - 1].scrollIntoView()); await foto(p, '3-final');
    const [dx] = await Promise.all([p.waitForEvent('download'), p.click('#entregas >> text=Descargar Excel')]);
    const [dw] = await Promise.all([p.waitForEvent('download'), p.click('#entregas >> text=Descargar informe')]);
    ok(/^auditoria-clinica-ficticia-dos-.*\.xlsx$/.test(dx.suggestedFilename()) && /^informe-auditoria-clinica-ficticia-dos-.*\.docx$/.test(dw.suggestedFilename()), `descargas con el expediente: ${dx.suggestedFilename()} · ${dw.suggestedFilename()}`);
    // 4. Ajustes: la carpeta aparece y se revoca.
    await p.$eval('#abrir-ajustes', (e) => e.click()); await p.waitForTimeout(800);
    await p.$eval('#ajuste-auditoria', (e) => { e.hidden = false; e.scrollIntoView(); });
    await p.evaluate(() => document.querySelector('#aud-actualizar') && document.querySelector('#aud-actualizar').click());
    await p.waitForSelector('#aud-carpetas >> text=Clínica Ficticia Dos', { timeout: 8000 });
    ok(/Clínica Ficticia Dos · «Clinica_Dos_SEREMI» · solo lectura/.test(await p.textContent('#aud-carpetas')) && /SEREMI 18–47 · 30 requisitos/.test(await p.textContent('#aud-listas')), 'Ajustes: carpeta autorizada (solo lectura) y lista guardada');
    await p.$eval('#aud-carpetas', (e) => e.scrollIntoView()); await foto(p, '4-ajustes');
    await p.click('#aud-carpetas >> text=Revocar'); await p.click('#aud-carpetas >> text=Confirmar revocación');
    await p.waitForFunction(() => /revocada/.test(document.querySelector('#aud-carpetas').textContent), null, { timeout: 8000 });
    ok(sql("SELECT estado FROM carpetas_autorizadas WHERE id='carpeta-cliente2'") === 'revocada', 'revocada desde Ajustes con dos toques');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= 390), 'sin desplazamiento horizontal en el teléfono');
  } catch (e) { ok(false, `excepción: ${e.message}`); await foto(p, 'error'); }
  await b.close(); srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
