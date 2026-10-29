// Fase 3d (interfaz, teléfono 390×900): tarjeta de propuesta en el chat → recargar (reaparece) → Aprobar → avance del
// trabajo correcto → Excel desde la tarjeta final. También: si el evento de la tarjeta se pierde en el camino, la tarjeta
// aparece igual (se relee del servidor al terminar el turno).
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const os = require('os');
const S = __dirname;
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString().trim();
const entregas = (p) => p.textContent('#entregas');
(async () => {
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql("DELETE FROM trabajos WHERE tipo='auditoria'"); sql('DELETE FROM auditoria_propuestas');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  const datos = require('../datos-ficticios/prueba-a.json');
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [{ id: 'AUD1', name: 'Expediente ficticio Sala Aurora.pdf', mimeType: 'application/pdf', texto: datos.documento_evidencia.texto, md5Checksum: 'u', version: 1, parents: ['carpeta-prueba'] }] }) });
  const srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'ui-3d-clave-fija-para-esta-prueba-0123456789-abcdef', ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba',
      ADA_TRABAJO_CICLO_MS: '300', FAKE_AUDITOR: 'lento', FAKE_LENTO_MS: '2500', ADA_TURNOS_2MIN: '100' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  p.on('pageerror', (e) => console.log('ERROR JS:', e.message));
  await p.goto('http://localhost:3200/');
  await p.fill('#nombre', 'Cristian'); await p.fill('#password', 'p'); await p.click('button[type=submit]');
  await p.waitForTimeout(1200);
  await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
  const req = datos.documento_base.requisitos;
  const pedir = async (input) => {
    await p.$eval('#teclado', (e) => e.click()).catch(() => {});
    await p.fill('#mensaje', `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input }] })}`);
    await p.$eval('#enviar', (e) => e.click());
  };

  // ---- 1–2. Propuesta → tarjeta correcta, y la app confirma que la dibujó ----
  await pedir({ archivo_ids: ['AUD1'], requisitos: req, motivo: 'Prueba desde el chat' });
  await p.waitForSelector('.tarjeta-auditoria[data-propuesta]', { timeout: 8000 });
  const propId = await p.$eval('.tarjeta-auditoria[data-propuesta]', (e) => e.dataset.propuesta);
  const txt = await entregas(p);
  ok(/Auditoría propuesta/.test(txt) && /Sala Aurora/.test(txt) && txt.includes(`Pendiente · ${propId.slice(0, 8)}`) && /Solo se cobra lo real, y nada hasta que apruebes/.test(txt), `tarjeta de la propuesta ${propId.slice(0, 8)} (archivo, requisitos, costo)`);
  ok((await p.inputValue('.tarjeta-auditoria .aud-req')).split('\n').length === 3 && await p.inputValue('.tarjeta-auditoria .aud-conf') === 'K1' && Number(await p.inputValue('.tarjeta-auditoria .aud-pres')) > 0, 'requisitos editables, K1 por defecto y presupuesto sugerido');
  await dormir(500);
  ok(sql(`SELECT tarjeta_estado FROM auditoria_propuestas WHERE id='${propId}'`) === 'mostrada', 'la app confirmó al servidor que la tarjeta quedó en pantalla');
  await p.$eval('.tarjeta-auditoria', (e) => e.scrollIntoView());
  await p.screenshot({ path: `${os.tmpdir()}/v-aud-propuesta.png` });

  // ---- 3–4. Recargar: la misma tarjeta vuelve; ningún trabajo antes de aprobar ----
  await p.reload(); await p.waitForTimeout(1500);
  await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
  await p.waitForSelector(`.tarjeta-auditoria[data-propuesta="${propId}"]`, { timeout: 8000 });
  ok(await p.$$eval('.tarjeta-auditoria[data-propuesta]', (l) => l.length) === 1, 'al recargar reaparece exactamente la misma tarjeta (sin duplicados)');
  ok(Number(sql("SELECT COUNT(*) FROM trabajos WHERE tipo='auditoria'")) === 0, 'antes de aprobar no existe ningún trabajo');

  // ---- 5–7. Aprobar desde la tarjeta → avance del trabajo de ESTA propuesta ----
  await p.click(`.tarjeta-auditoria[data-propuesta="${propId}"] >> text=Aprobar y empezar`);
  await p.waitForFunction(() => /Auditoría en curso/.test(document.querySelector('#entregas').textContent) && /Requisitos evaluados [12]\/3/.test(document.querySelector('#entregas').textContent), null, { timeout: 25000 });
  const trabajoId = sql(`SELECT trabajo_id FROM auditoria_propuestas WHERE id='${propId}'`);
  const t2 = await entregas(p);
  ok(t2.includes(`Trabajo ${trabajoId.slice(0, 8)} (propuesta ${propId.slice(0, 8)}) · K1`) && /de US\$0,1500/.test(t2), `la tarjeta de avance identifica el trabajo ${trabajoId.slice(0, 8)}, su propuesta, K1 y el presupuesto aprobado`);
  ok(!(await p.$('.tarjeta-auditoria[data-propuesta]')), 'la tarjeta de propuesta desaparece al aprobar');
  const k = await p.evaluate(async (id) => (await fetch(`/api/auditorias/propuestas/${id}/constancia`, { headers: { Authorization: `Bearer ${localStorage.getItem('ada_token')}` } })).json(), propId.slice(0, 8));
  ok(k.aprobacion && k.aprobacion.origen.via === 'tarjeta_chat' && k.aprobacion.origen.app === 'navegador', `la aprobación quedó registrada como hecha con el botón de la tarjeta del chat (${k.aprobacion && JSON.stringify(k.aprobacion.origen)})`);
  await p.$eval('.tarjeta-auditoria', (e) => e.scrollIntoView());
  await p.screenshot({ path: `${os.tmpdir()}/v-aud-avance.png` });

  // ---- 8. Excel desde la tarjeta final ----
  await p.waitForFunction(() => /Auditoría terminada/.test(document.querySelector('#entregas').textContent), null, { timeout: 40000 });
  const t3 = await entregas(p);
  ok(/R1: Cumple · cita verificada/.test(t3) && /R2: Parcial/.test(t3) && /R3: No aplica/.test(t3) && /Descargar Excel/.test(t3), 'al terminar: resultado por requisito y botón del Excel');
  await p.$eval('.tarjeta-auditoria', (e) => e.scrollIntoView());
  await p.screenshot({ path: `${os.tmpdir()}/v-aud-terminada.png` });
  const [descarga] = await Promise.all([p.waitForEvent('download'), p.click('#entregas >> text=Descargar Excel')]);
  const ruta = `${os.tmpdir()}/auditoria-chat.xlsx`; await descarga.saveAs(ruta);
  ok(require('fs').statSync(ruta).size > 3000 && descarga.suggestedFilename().includes(trabajoId.slice(0, 8)), `descarga el Excel del trabajo correcto (${descarga.suggestedFilename()})`);

  // ---- Evento perdido en el camino: la tarjeta aparece igual al terminar el turno ----
  await p.route('**/api/chat/stream', async (route) => {
    const r = await route.fetch();
    const cuerpo = (await r.text()).split('\n\n').filter((bloque) => !bloque.startsWith('event: auditoria_propuesta')).join('\n\n');
    await route.fulfill({ response: r, body: cuerpo });
  });
  await pedir({ archivo_ids: ['AUD1'], requisitos: req.slice(0, 1) });
  await p.waitForFunction(() => document.querySelectorAll('.tarjeta-auditoria[data-propuesta]').length === 1, null, { timeout: 10000 }).catch(() => {});
  ok(await p.$$eval('.tarjeta-auditoria[data-propuesta]', (l) => l.length) === 1, 'si el evento de la tarjeta se pierde, la propuesta aparece igual desde el servidor');
  await b.close(); srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
