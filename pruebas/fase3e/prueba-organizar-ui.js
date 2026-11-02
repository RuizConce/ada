// Organizar expediente en el teléfono (390×900): las cuatro aprobaciones con botones.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const os = require('os');
const S = __dirname;
const D = require('../datos-ficticios/prueba-botiquin.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql --default-character-set=utf8mb4 -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
const foto = (p, n) => p.screenshot({ path: `${os.tmpdir()}/v-org-${n}.png` });
const PASS = 'clave-org-ui';
(async () => {
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM auditoria_propuestas'); sql('DELETE FROM extracciones');
  try { sql('DELETE FROM carpetas_autorizadas'); } catch (_) {}
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [...D.carpetas, ...D.archivos] }) });
  const srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: PASS, ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'org-ui-clave-fija-0123456789-abcdefghijklmnopq', ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_DRIVE_CARPETAS_LECTURA: '',
      ADA_TRABAJO_CICLO_MS: '150', ADA_TURNOS_2MIN: '200', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-botiquin.json'), FAKE_H_EXTRACCION_OMITIR: '16' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  p.on('pageerror', (e) => console.log('ERROR JS:', e.message));
  try {
    await p.goto('http://localhost:3200/');
    await p.fill('#nombre', 'Cristian'); await p.fill('#password', PASS); await p.click('button[type=submit]');
    await p.waitForTimeout(1200); await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
    if (!(await p.isVisible('#mensaje'))) await p.$eval('#teclado', (e) => e.click());
    await p.fill('#mensaje', `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input: { carpeta: 'https://drive.google.com/drive/folders/carpeta-botdocs?usp=drive_link', carpeta_requisitos: 'https://drive.google.com/drive/folders/carpeta-botreq?usp=drive_link', documento_requisitos: '00.Botiquín Andaluz — requisitos y documentos.pdf', rango: { desde: 1, hasta: 22 }, perfil: 'expediente', organizar: { nombre: 'ADA — Botiquín Andaluz — Documentos organizados' } } }] })}`);
    await p.$eval('#enviar', (e) => e.click());
    // 1. Autorizar las dos carpetas.
    await p.waitForSelector('text=Autorizar 2 carpetas (solo lectura)', { timeout: 10000 });
    let t = await p.textContent('.tarjeta-carpeta');
    ok(/Documentos: Botiquin_documentos/.test(t) && /Requisitos: Botiquin_requisitos/.test(t) && /se extraen de «00\.Botiquín Andaluz — requisitos y documentos\.pdf»/.test(t) && /carpeta NUEVA con copias/.test(t), '1: tarjeta con las dos carpetas, el documento de requisitos y el aviso de las copias');
    await p.fill('.tarjeta-carpeta .aud-exp', 'Botiquín Andaluz (ficticio)'); await p.fill('.tarjeta-carpeta .aud-clave', PASS);
    await p.$eval('.tarjeta-carpeta', (e) => e.scrollIntoView()); await foto(p, '1-autorizar');
    await p.click('.tarjeta-carpeta >> text=Autorizar solo lectura');
    // 2. Extraer requisitos.
    await p.waitForSelector('text=Aprobar extracción', { timeout: 10000 });
    ok(/Norma: 00\.Botiquín Andaluz/.test(await p.textContent('#entregas')), '2: tarjeta de extracción del PDF de requisitos');
    await p.click('text=Aprobar extracción');
    // 3. Lista de 22 + auditoría (incluyo el RUT).
    await p.waitForSelector('text=Revisa los 22 requisitos y aprueba la auditoría', { timeout: 30000 });
    t = await p.textContent('.tarjeta-auditoria[data-propuesta]');
    ok(/Requisitos 1 al 22: 22 de 22/.test(t) && /Tabla detectada/.test(t) && /referencia/i.test(t) && !/12\.345\.678|juan\.perez/.test(t), '3: 22 de 22 requisitos desde la tabla, estado del PDF solo como referencia, sin datos de la página 3');
    if (process.env.VER) console.log(t.slice(0, 1500));
    await p.check('.tarjeta-auditoria[data-propuesta] .aud-sensible input[value="D_RUT"]');
    await p.click('.tarjeta-auditoria[data-propuesta] >> text=Aprobar y empezar');
    // 4. Plan de copias.
    await p.waitForSelector('text=Plan de copias — Botiquín Andaluz (ficticio)', { timeout: 120000 });
    t = await p.textContent('.tarjeta-plan');
    ok(/Se creará la carpeta «ADA — Botiquín Andaluz — Documentos organizados» en la raíz de Mi unidad/.test(t) && /04_Contrato_QF_y_nombramiento\.pdf/.test(t) && /09_PENDIENTE_Procedimiento_recepcion\.pdf/.test(t) && /Sin documento para copiar \(3\)/.test(t), '4: vista previa completa: destino, nombres, PENDIENTE y lo que falta');
    ok(!(await p.isChecked('.tarjeta-plan input[value="2:D_RUT"]')) && /Crear carpeta y copiar \(19\)/.test(t), 'el RUT (sensible) viene desmarcado: 19 copias por defecto');
    await p.check('.tarjeta-plan input[value="2:D_RUT"]');
    await p.uncheck('.tarjeta-plan input[value="10:D_TEMP2"]');
    ok(/Crear carpeta y copiar \(19\)/.test(await p.textContent('.tarjeta-plan .tarjeta-botones')), 'marco el RUT y desmarco una copia: 19');
    await p.$eval('.tarjeta-plan', (e) => e.scrollIntoView()); await foto(p, '4-plan');
    await p.fill('.tarjeta-plan .aud-clave', PASS);
    await p.click('.tarjeta-plan >> text=/Crear carpeta y copiar/');
    await p.waitForSelector('text=Expediente organizado', { timeout: 60000 });
    const fin = p.locator('.tarjeta-auditoria[data-trabajo]', { hasText: 'Expediente organizado' });
    t = await fin.textContent();
    ok(/copias 19\/19/.test(t) && /Abrir la carpeta en Drive/.test(t), 'resultado: 19/19 copias y botón para abrir la carpeta en Drive');
    await fin.scrollIntoViewIfNeeded(); await foto(p, '5-final');
    const [dx] = await Promise.all([p.waitForEvent('download'), fin.locator('text=Descargar Excel').click()]);
    const [dw] = await Promise.all([p.waitForEvent('download'), fin.locator('text=Descargar Word').click()]);
    ok(/\.xlsx$/.test(dx.suggestedFilename()) && /\.docx$/.test(dw.suggestedFilename()), `descargas: ${dx.suggestedFilename()} · ${dw.suggestedFilename()}`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= 390), 'sin desplazamiento horizontal');
  } catch (e) { ok(false, `excepción: ${e.message}`); await foto(p, 'error'); }
  await b.close(); srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
