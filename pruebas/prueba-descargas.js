// Descargas por enlace temporal: el teléfono descarga Word/Excel/documentos con un enlace normal (sin "blob:").
const { spawn, execSync } = require('child_process');
const os = require('os');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql --default-character-set=utf8mb4 -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
const B = 'http://localhost:3200';
(async () => {
  const srv = spawn('node', ['-r', `${__dirname}/fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${__dirname}/..`, stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'descargas-clave-de-prueba-0123456789-abcdefghijk' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch(`${B}/api/ajustes`); break; } catch (_) {} }
  const tk = (await (await fetch(`${B}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
  const api = async (ruta, body) => { const r = await fetch(`${B}${ruta}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
  try {
    // Un archivo Excel creado por ADA (crear_archivo) y un documento entregado.
    const conv = sql("INSERT INTO conversaciones (modo, inicio) VALUES ('texto', NOW()); SELECT LAST_INSERT_ID();");
    sql(`INSERT INTO documentos (titulo, contenido, creado_en) VALUES ('Acta de prueba ñandú', 'Contenido del acta.', NOW())`);
    const docId = sql('SELECT MAX(id) FROM documentos');
    const H = await fetch(`${B}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
      body: JSON.stringify({ mensaje: `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'crear_archivo', input: { tipo: 'excel', titulo: 'Costos de prueba', hojas: [{ nombre: 'Hoja1', columnas: ['Ítem', 'Monto'], filas: [['A', 1000]] }] } }] })}` }) });
    await H.text();
    const archId = sql('SELECT MAX(id) FROM archivos');
    ok(Number(archId) > 0, `hay un archivo creado por ADA (${archId})`);

    // 1. Pedir el enlace (con sesión) y descargar SIN sesión, como lo hace el gestor de descargas de Android.
    let r = await api('/api/descargas', { tipo: 'archivo', id: archId });
    ok(r.status === 200 && /^\/descargas\/[\w-]{43}$/.test(r.d.url) && /\.xlsx$/.test(r.d.nombre), `enlace temporal: ${r.d.url && r.d.url.slice(0, 20)}… (${r.d.nombre})`);
    let x = await fetch(`${B}${r.d.url}`);
    let buf = Buffer.from(await x.arrayBuffer());
    ok(x.status === 200 && /attachment/.test(x.headers.get('content-disposition')) && buf.slice(0, 2).toString() === 'PK' && x.headers.get('cache-control') === 'no-store', `descarga sin sesión: ${x.headers.get('content-disposition')}`);
    x = await fetch(`${B}${r.d.url}`);
    ok(x.status === 200, 'el mismo enlace sirve de nuevo durante su vigencia (reintentos del gestor de descargas)');

    // 2. Documento (Markdown) con nombre con tildes.
    r = await api('/api/descargas', { tipo: 'documento', id: docId });
    x = await fetch(`${B}${r.d.url}`);
    const md = await x.text();
    ok(x.status === 200 && md.startsWith('# Acta de prueba ñandú') && /filename\*=UTF-8''Acta%20de%20prueba%20%C3%B1and%C3%BA\.md/.test(x.headers.get('content-disposition')), 'documento .md con nombre con tildes');

    // 3. Inválidos y ajenos.
    ok((await fetch(`${B}/descargas/${'x'.repeat(43)}`)).status === 410, 'un enlace inventado o vencido responde 410 con un mensaje claro');
    ok((await api('/api/descargas', { tipo: 'archivo', id: 999999 })).status === 404, 'un archivo que no existe no recibe enlace');
    ok((await api('/api/descargas', { tipo: 'otra_cosa', id: 1 })).status === 400, 'tipo no permitido');
    ok((await fetch(`${B}/api/descargas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"tipo":"archivo","id":1}' })).status === 401, 'sin sesión no se puede pedir un enlace');

    // 4. La app (html/js/css) se revalida siempre.
    x = await fetch(`${B}/app.js`);
    ok(x.headers.get('cache-control') === 'no-cache', `app.js con Cache-Control: ${x.headers.get('cache-control')}`);
  } catch (e) { ok(false, e.stack); }
  srv.kill();
  if (!process.argv.includes('--ui')) setTimeout(() => process.exit(), 300);
})();

// ---- En la app (navegador, tamaño teléfono): el botón "Descargar" de un Excel creado por ADA usa el enlace temporal ----
if (process.argv.includes('--ui')) (async () => {
  await dormir(1500);
  const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
  const srv = spawn('node', ['-r', `${__dirname}/fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${__dirname}/..`, stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago', ADA_TURNOS_2MIN: '100',
      ADA_CLAVE_DATOS: 'descargas-clave-de-prueba-0123456789-abcdefghijk' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch(`${B}/api/ajustes`); break; } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  const pedidas = [];
  p.on('request', (r) => { if (/\/descargas\//.test(r.url())) pedidas.push(r.url()); });
  await p.goto(`${B}/`);
  await p.fill('#nombre', 'Cristian'); await p.fill('#password', 'p'); await p.click('button[type=submit]');
  await p.waitForTimeout(1200);
  await p.$eval('.hoja-fondo', (e) => e.click()).catch(() => {});
  await p.$eval('#teclado', (e) => e.click());
  await p.fill('#mensaje', `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'crear_archivo', input: { tipo: 'excel', titulo: 'Planilla desde el chat', hojas: [{ nombre: 'Hoja1', columnas: ['Ítem', 'Monto'], filas: [['A', 1000]] }] } }] })}`);
  await p.$eval('#enviar', (e) => e.click());
  await p.waitForSelector('.entrega-archivo', { timeout: 8000 });
  const [d] = await Promise.all([p.waitForEvent('download'), p.click('.entrega-archivo >> text=Descargar')]);
  const ruta = `${os.tmpdir()}/descarga-ui.xlsx`; await d.saveAs(ruta);
  ok(d.suggestedFilename() === 'Planilla desde el chat.xlsx' && require('fs').statSync(ruta).size > 3000 && /\/descargas\/[\w-]{43}$/.test(d.url()), `el botón Descargar baja «${d.suggestedFilename()}» por enlace temporal (no blob:)`);
  ok(/Descargando «Planilla desde el chat.xlsx»/.test(await p.textContent('body')), 'avisa en pantalla que está descargando');
  await b.close(); srv.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
  setTimeout(() => process.exit(), 300);
})();
