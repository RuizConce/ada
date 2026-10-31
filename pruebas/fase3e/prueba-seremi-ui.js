// Fase 3e a escala (interfaz, teléfono 390×900): carpeta ficticia de 98 archivos → tarjeta con inventario → aprobar
// extracción → tarjeta 2 con rango 18–47, faltantes y casillas de datos personales → marcar uno → avance por lotes →
// tarjeta final con la clasificación SEREMI y las dos descargas.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const os = require('os');
const S = __dirname;
const D = require('../datos-ficticios/prueba-seremi.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql --default-character-set=utf8mb4 -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
const CLAVE = 'ui-seremi-clave-fija-0123456789-abcdefghijklmnop'; process.env.ADA_CLAVE_DATOS = CLAVE;
const Cifrado = require('../../src/cifrado');
const foto = (p, n) => p.screenshot({ path: `${os.tmpdir()}/v-seremi-${n}.png` });
(async () => {
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM auditoria_propuestas'); sql('DELETE FROM extracciones');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [{ id: 'carpeta-seremi', name: 'Andaluz_SEREMI_para_subir (ficticia)', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }, ...D.carpetas, ...D.archivos] }) });
  const srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'ui-seremi-clave-fija-0123456789-abcdefghijklmnop', ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_DRIVE_CARPETAS_LECTURA: 'carpeta-seremi',
      ADA_TRABAJO_CICLO_MS: '150', ADA_TURNOS_2MIN: '100', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-seremi.json'), FAKE_H_EXTRACCION_OMITIR: '32,47', ADA_CLAVE_DATOS: CLAVE } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  p.on('pageerror', (e) => console.log('ERROR JS:', e.message));
  try {
    await p.goto('http://localhost:3200/');
    await p.fill('#nombre', 'Cristian'); await p.fill('#password', 'p'); await p.click('button[type=submit]');
    await p.waitForTimeout(1200);
    await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
    await p.$eval('#teclado', (e) => e.click());
    await p.fill('#mensaje', `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input: { norma_id: D.norma_id, carpeta_id: 'carpeta-seremi', rango: { desde: 18, hasta: 47 }, perfil: 'seremi' } }] })}`);
    await p.$eval('#enviar', (e) => e.click());
    await p.waitForSelector('text=Extraer requisitos de la norma', { timeout: 10000 });
    let t = await p.textContent('#entregas');
    ok(/Inventario: 98 archivos \(incluye 3 subcarpetas\) · 86 a auditar/.test(t) && /requisitos 18 al 47/.test(t) && /clasificación SEREMI/.test(t) && /y \d+ más/.test(t), 'tarjeta 1: inventario de 98, rango 18–47, perfil SEREMI y lista de archivos resumida');
    ok(/2 · duplicado exacto/.test(t) && /3 · no legible/.test(t) && /6 · excluido: posible dato sensible/.test(t) && /Versión: Manual_normas_procedimientos_v2_final\.pdf/.test(t) && /podrás incluir alguno en el paso 2/.test(t), 'tarjeta 1: duplicados, no legibles, versiones y posibles datos personales visibles');
    const anchoOk = await p.evaluate(() => document.documentElement.scrollWidth <= 390);
    ok(anchoOk, 'sin desplazamiento horizontal en el teléfono');
    await p.$eval('.tarjeta-auditoria', (e) => e.scrollIntoView()); await foto(p, '1-extraer');
    await p.click('text=Aprobar extracción');
    await p.waitForSelector('text=Revisa los 30 requisitos y aprueba la auditoría', { timeout: 30000 });
    t = await p.textContent('.tarjeta-auditoria[data-propuesta]');
    ok(/Requisitos 18 al 47: 30 de 30 en la lista · ninguno falta/.test(t) && /Subapartados dentro de su requisito: 24 \(24a, 24b\)/.test(t) && /Tomados literalmente del texto de la norma.*: 32, 47/.test(t) && (await p.inputValue('.tarjeta-auditoria[data-propuesta] .aud-req')).split('\n')[0].startsWith('18 | '), 'tarjeta 2: rango, ningún faltante y la lista con números originales desde el 18');
    ok(await p.$$eval('.tarjeta-auditoria[data-propuesta] .aud-sensible input', (l) => l.length) === 6 && /se enmascaran antes del análisis/.test(t), 'tarjeta 2: cuatro casillas de datos personales, desmarcadas');
    // Tarjeta con el formato anterior (como la de la carpeta real): botón para corregirla sin costo.
    const id0 = await p.$eval('.tarjeta-auditoria[data-propuesta]', (e) => e.dataset.propuesta);
    const viejo = Cifrado.descifrarJSON(sql(`SELECT datos_cifrado FROM auditoria_propuestas WHERE id='${id0}'`));
    viejo.requisitos = viejo.requisitos.filter((x) => !['32', '47'].includes(x.id)).flatMap((x) => (x.subapartados ? x.subapartados.map((y) => ({ id: y.id, texto: y.texto })) : [x]));
    viejo.faltantes = [32, 47]; delete viejo.recuperados; delete viejo.subapartados;
    sql(`UPDATE auditoria_propuestas SET datos_cifrado='${Cifrado.cifrarJSON(viejo)}' WHERE id='${id0}'`);
    await p.reload(); await p.waitForTimeout(1500); await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
    await p.waitForSelector('text=Corregir la lista (sin costo)', { timeout: 8000 });
    t = await p.textContent('.tarjeta-auditoria[data-propuesta]');
    ok(/28 de 30 en la lista/.test(t) && /No aparecen numerados.*32, 47/.test(t) && (await p.inputValue('.tarjeta-auditoria[data-propuesta] .aud-req')).split('\n').length === 34, 'tarjeta anterior: 34 filas, faltan 32 y 47, y ofrece «Corregir la lista (sin costo)»');
    await p.$eval('.aud-corregir', (e) => e.scrollIntoView()); await foto(p, '2a-corregir');
    await p.click('text=Corregir la lista (sin costo)');
    await p.waitForFunction(() => /30 de 30 en la lista/.test(document.querySelector('#entregas').textContent), null, { timeout: 8000 });
    ok((await p.inputValue('.tarjeta-auditoria[data-propuesta] .aud-req')).split('\n').length === 30 && !(await p.$('text=Corregir la lista (sin costo)')) && sql(`SELECT estado FROM auditoria_propuestas WHERE id='${id0}'`) === 'descartada',
      'al corregir: 30 filas del 18 al 47 y la tarjeta anterior queda reemplazada');
    await p.check('.tarjeta-auditoria[data-propuesta] .aud-sensible input[value="C_SIS"]');
    await p.$eval('.tarjeta-auditoria[data-propuesta]', (e) => e.scrollIntoView()); await foto(p, '2-lista');
    const propId = await p.$eval('.tarjeta-auditoria[data-propuesta]', (e) => e.dataset.propuesta);
    await p.click('.tarjeta-auditoria[data-propuesta] >> text=Aprobar y empezar');
    await p.waitForFunction(() => /Lotes [1-5]\/5 · archivos leídos/.test(document.querySelector('#entregas').textContent), null, { timeout: 30000 });
    ok(true, 'la tarjeta de avance muestra lotes y archivos leídos');
    await p.$$eval('.tarjeta-auditoria', (l) => l[l.length - 1].scrollIntoView()); await foto(p, '3-avance');
    await p.waitForFunction(() => /Auditoría terminada/.test(document.querySelector('#entregas').textContent), null, { timeout: 120000 });
    t = await p.textContent('#entregas');
    ok(/18: LISTO PARA SUBIR/.test(t) && /21: HAY QUE MODIFICAR/.test(t) && /23: NO ENCONTRADO/.test(t) && /30: REQUIERE REVISIÓN/.test(t) && /→ Agregar al programa/.test(t) && /Descargar Excel/.test(t) && /Descargar informe/.test(t), 'tarjeta final: clasificación SEREMI, acción en los no listos y las dos descargas');
    ok(/Puedes subir \(11\): 18, 19, 20, 22, 25, 27, 39, 40, 42, 43, 47/.test(t) && /Hay que modificar \(4\): 21, 28, 38, 45/.test(t) && /No se encuentran \(3\): 23, 36, 44/.test(t) && /No aplican \(justificado\) \(2\): 24, 29/.test(t) && /Revisar a mano \(10\)/.test(t),
      'tarjeta final: la respuesta sencilla primero (subir, modificar, no se encuentran, no aplican, revisar)');
    await p.$$eval('.tarjeta-auditoria', (l) => l[l.length - 1].scrollIntoView()); await foto(p, '4-final');
    await p.click('#entregas >> text=Borrar textos extraídos de esta auditoría');
    await p.waitForSelector('#entregas >> text=/Confirmar: borrar \\d+ textos guardados/');
    await p.click('#entregas >> text=/Confirmar: borrar/');
    await p.waitForFunction(() => /Textos extraídos de esta auditoría: borrados/.test(document.querySelector('#entregas').textContent), null, { timeout: 10000 });
    ok(sql("SELECT COUNT(*) FROM extracciones") === '0' && /Descargar Excel/.test(await p.textContent('#entregas')), 'borrar textos (dos toques): extracciones de esta auditoría eliminadas; Excel e informe siguen disponibles');
    const k = await p.evaluate(async (id) => (await fetch(`/api/auditorias/propuestas/${id}/constancia`, { headers: { Authorization: `Bearer ${localStorage.getItem('ada_token')}` } })).json(), propId.slice(0, 8));
    ok(k.aprobacion && JSON.stringify(k.aprobacion).includes('Certificados_SIS_personal.pdf') && k.aprobacion.origen.via === 'tarjeta_chat', `la constancia registra el archivo sensible incluido por la casilla (${JSON.stringify(k.aprobacion && k.aprobacion.sensibles_incluidos)})`);
  } catch (e) { ok(false, `excepción: ${e.message}`); await foto(p, 'error'); console.log((await p.textContent('#entregas')).slice(0, 600)); }
  await b.close(); srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
