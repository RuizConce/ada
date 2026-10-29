// Cierre de la Fase 3b (simulado): el procedimiento guiado de Ajustes con un PDF ficticio, de punta a punta.
// Lectura → reinicio real (otro proceso) → versión nueva → borrado voluntario → papelera, y la comprobación de las 5.
// También: con una copia temporal que no se pudo borrar, la verificación 4 NO se aprueba.
const { spawn, execSync } = require('child_process');
const S = __dirname;
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk;
async function arrancar() {
  srv = spawn('node', ['src/server.js'], { cwd: `${S}/../..`, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: 'cierre-3b-clave-fija-0123456789-abcdefghijklmnop', ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba' } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
const reiniciar = async () => { srv.kill(); await dormir(800); await arrancar(); };
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const leer = async (id) => (await api('/api/extracciones/cierre/leer', { method: 'POST', body: JSON.stringify({ archivo_id: id }) })).d;
const comprobar = async (id) => (await api(`/api/extracciones/cierre?archivo=${id}`)).d;
const estados = (c) => c.verificaciones.map((x) => (x.estado === 'aprobada' ? '✓' : '✗')).join('');
(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql('DELETE FROM extracciones'); sql("DELETE FROM extraccion_eventos WHERE archivo_id IN ('CIERRE1','CIERRE2')"); sql("DELETE FROM temporales_drive WHERE original_id IN ('CIERRE1','CIERRE2')");
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  const texto = 'Documento ficticio para el cierre de la Fase 3b. MARCA-CIERRE. Página 1. Contenido de prueba sin datos reales.';
  await ctl('/control/archivos', { archivos: [
    { id: 'CIERRE1', name: 'Cierre 3b ficticio.pdf', mimeType: 'application/pdf', texto, md5Checksum: 'c-v1', version: 1, parents: ['carpeta-prueba'] },
    { id: 'CIERRE2', name: 'Cierre 3b ficticio 2.pdf', mimeType: 'application/pdf', texto, md5Checksum: 'c2-v1', version: 1, parents: ['carpeta-prueba'] },
    { id: 'AJENO', name: 'Ajeno.pdf', mimeType: 'application/pdf', texto: 'x', md5Checksum: 'a', version: 1, parents: ['otra'] },
  ] });
  await arrancar();
  try {
    let c = await comprobar('CIERRE1');
    ok(c.resultado === '0 de 5 aprobadas' && c.verificaciones.every((x) => x.como_completarla), 'antes de empezar: 0 de 5, cada una con cómo completarla');
    let r = await leer('CIERRE1');
    ok(r.ok && r.resultado === 'descargada y guardada cifrada' && !JSON.stringify(r).includes('MARCA-CIERRE'), `paso 1, leer: ${r.resultado} (sin mostrar contenido)`);
    ok((await leer('AJENO')).resultado === 'fuera de la carpeta de prueba', 'un archivo fuera de la carpeta de prueba no se lee');
    // 2. Reinicio real (otro proceso).
    await reiniciar();
    r = await leer('CIERRE1');
    ok(r.resultado === 'reutilizada (sin descargar)', `paso 2, tras reiniciar: ${r.resultado}`);
    // 3. Versión nueva.
    await ctl('/control/cambiar', { id: 'CIERRE1', cambios: { version: 2, md5Checksum: 'c-v2', texto: `${texto} Versión 2.` } });
    r = await leer('CIERRE1');
    ok(r.resultado === 'descargada y guardada cifrada', `paso 3, versión nueva: ${r.resultado}`);
    // 4. Borrado voluntario.
    const b = await api('/api/extracciones/CIERRE1', { method: 'DELETE' });
    r = await leer('CIERRE1');
    ok(b.status === 200 && r.resultado === 'descargada y guardada cifrada', `paso 4, tras borrar lo guardado: ${r.resultado}`);
    // 5. Papelera.
    await ctl('/control/cambiar', { id: 'CIERRE1', cambios: { trashed: true } });
    r = await leer('CIERRE1');
    ok(!r.ok && r.resultado === 'sin acceso: lo guardado se descartó', `paso 5, en la papelera: ${r.resultado}`);
    c = await comprobar('CIERRE1');
    console.log(c.verificaciones.map((x) => `   ${x.estado === 'aprobada' ? '✓' : '✗'} ${x.n}. ${x.verificacion} — ${x.evidencia.join(' | ')}`).join('\n'));
    ok(c.resultado === 'LAS 5 APROBADAS' && c.servidores_vistos === 2, `comprobación: ${c.resultado} (${estados(c)}), 2 servidores`);
    ok(c.guardado_ahora.every((g) => !g.con_texto) && !JSON.stringify(c).includes('MARCA-CIERRE'), 'al final no queda texto guardado del archivo, y el informe no trae contenido');
    // Una copia temporal que no se pudo borrar: la 4 no se aprueba.
    await ctl('/control/fallas', { borrado: 2 });
    r = await leer('CIERRE2');
    c = await comprobar('CIERRE2');
    const v4 = c.verificaciones.find((x) => x.n === 4);
    ok(v4.estado === 'pendiente' && v4.evidencia.some((e) => /pendientes de borrar: 1/.test(e)) && v4.evidencia.some((e) => /vivas en tu Drive: 1/.test(e)), `con una copia sin borrar, la 4 queda pendiente (${v4.evidencia.join(' | ')})`);
  } catch (e) { ok(false, `excepción: ${e.stack}`); console.log(srv.log.slice(-3000)); }
  srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
  setTimeout(() => process.exit(), 300);
})();
