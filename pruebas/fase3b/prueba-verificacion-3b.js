// Cierre Fase 3b: las 5 comprobaciones pendientes en secuencia, como se harán en Railway, y el informe de verificación.
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const S = __dirname;
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const CLAVE = `v-${crypto.randomBytes(32).toString('base64')}`;
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk; let n = 0;
async function arrancar() {
  srv = spawn('node', ['-r', `${S}/fake-claude-3b.js`, 'src/server.js'], { cwd: '/home/claude/ada', stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: CLAVE, ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_TURNOS_2MIN: '100' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
const api = async (ruta, op = {}) => (await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } })).json();
const lee = async (id) => { const t = await (await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: JSON.stringify({ mensaje: `[${++n}] LEE ${JSON.stringify({ lotes: [[{ id }]] })}` }) })).text(); return (t.match(/Estados=([^"]*)"/) || [])[1]; };
const texto = (v) => `PDF ficticio de prueba, versión ${v}. ` + 'x'.repeat(3000);
(async () => {
  sql('DELETE FROM extracciones'); sql('DELETE FROM extraccion_eventos'); sql('DELETE FROM temporales_drive');
  sql("DELETE FROM integraciones WHERE nombre='extracciones_consentimiento'");
  const drive = spawn('node', [`${S}/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await ctl('/control/archivos', { archivos: [{ id: 'PDF1', name: 'Prueba_3b_ficticio.pdf', mimeType: 'application/pdf', texto: texto(1), md5Checksum: 'md5-v1', version: 1, parents: ['carpeta-prueba'] }] });
  await arrancar();
  ok(/consentimiento_pendiente/.test(await lee('PDF1')), '1. primera lectura: pide consentimiento, no guarda');
  await api('/api/extracciones/consentimiento', { method: 'POST', body: JSON.stringify({ acepto: true }) });
  ok(/^extraccion_nueva_guardada/.test(await lee('PDF1')), '2. extracción nueva cifrada');
  // Reinicio real del servidor (en Railway: redeploy).
  srv.kill(); await dormir(800); await arrancar();
  ok(/^reutilizada/.test(await lee('PDF1')), '3. tras reiniciar: reutilizada');
  // Nueva versión del mismo archivo (mismo id).
  await ctl('/control/cambiar', { id: 'PDF1', cambios: { version: 2, md5Checksum: 'md5-v2', texto: texto(2) } });
  ok(/^extraccion_nueva_guardada/.test(await lee('PDF1')), '4. versión nueva: extracción nueva');
  ok(/^reutilizada/.test(await lee('PDF1')), '5. y luego se reutiliza la nueva');
  // Pérdida de acceso.
  await ctl('/control/cambiar', { id: 'PDF1', cambios: { acceso: false } });
  ok((await lee('PDF1')) === 'error', '6. sin acceso: bloqueado');
  await ctl('/control/cambiar', { id: 'PDF1', cambios: { acceso: true } });
  ok(/^extraccion_nueva_guardada/.test(await lee('PDF1')), '7. acceso devuelto: se extrae de nuevo (lo anterior se había descartado)');
  // Borrado voluntario.
  const b = await api('/api/extracciones', { method: 'DELETE' });
  ok(b.borradas === 1 && sql('SELECT COUNT(*) FROM extracciones') === '0', '8. borrado voluntario');
  const st = await ctl('/control/stats');
  const v = await api(`/api/extracciones/verificacion?desde=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}`);
  const a = v.archivos.find((x) => x.archivo === 'Prueba_3b_ficticio.pdf');
  console.log('   conteo:', JSON.stringify(a.conteo));
  const seq = a.secuencia.map((x) => `${x.evento}${x.motivo ? `:${x.motivo}` : ''}@s${x.servidor}${x.version ? `/${x.version}` : ''}`);
  console.log('   secuencia:', seq.join(' → '));
  const ext1 = a.secuencia.find((x) => x.evento === 'extraccion_nueva');
  const reu = a.secuencia.find((x) => x.evento === 'reutilizacion');
  ok(v.servidores === 2 && ext1.servidor === 1 && reu.servidor === 2 && ext1.version === reu.version, 'informe: la reutilización ocurrió en otro servidor (después del reinicio) con la misma versión');
  ok(a.conteo['invalidacion:version_nueva'] === 1 && a.conteo['extraccion_nueva:version_nueva'] === 1, 'informe: invalidación y extracción nueva por versión nueva');
  ok(a.conteo['invalidacion:sin_acceso'] === 1 && a.conteo['sin_acceso:drive_404'] === 1, 'informe: invalidación por pérdida de acceso');
  ok(a.conteo['borrado:borrado_voluntario'] === 1 && a.estado_actual === 'sin extracción guardada', 'informe: borrado voluntario por archivo y ya no queda extracción');
  ok(v.copias_temporales.borradas === a.conteo.descarga && v.copias_temporales.fallidas === 0 && v.copias_temporales.pendientes_ahora === 0 && st.vivos.length === 0,
    `copias temporales: ${v.copias_temporales.borradas} creadas y borradas (una por descarga), 0 pendientes; Drive simulado sin copias vivas`);
  ok(!JSON.stringify(v).includes('PDF ficticio de prueba'), 'el informe no trae contenido');
  srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
