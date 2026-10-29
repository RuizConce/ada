// Exportación de diagnóstico: Drive/extracciones por archivo, registros internos tocados y selección de modelo.
const { spawn } = require('child_process');
const crypto = require('crypto');
const S = __dirname;
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const drive = spawn('node', [`${S}/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [
    { id: 'PX', name: 'Prospeccion_ficticia.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', md5Checksum: 'm', version: 1, parents: ['otra'], texto: 'x' }] }) });
  const srv = spawn('node', ['-r', `${S}/fake-claude-3b.js`, 'src/server.js'], { cwd: '/home/claude/ada', stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: `d-${crypto.randomBytes(32).toString('base64')}`, ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_TURNOS_2MIN: '100' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
  const chat = async (mensaje, conv) => { const t = await (await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: JSON.stringify({ mensaje, conversacion_id: conv }) })).text();
    const c = t.match(/event: conversacion\ndata: (\{.*\})/); return { conv: c && JSON.parse(c[1]).conversacion_id, t }; };
  const r1 = await chat(`actualiza la planilla de prospección HERR ${JSON.stringify({ llamadas: [{ name: 'leer_drive', input: { id: 'PX' } }, { name: 'registrar_item', input: { tipo: 'pendiente', texto: 'Contactar a Persona Ficticia — Colegio Ficticio', proyecto: 'Huayca' } }] })}`);
  const conv = r1.conv;
  const item = Number(require('child_process').execSync(`mysql -uada -pada ada -N -B -e "SELECT MAX(id) FROM items"`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString());
  await chat(`HERR ${JSON.stringify({ llamadas: [{ name: 'actualizar_item', input: { id: item, texto: 'Contactar a Claudio Ficticio — Colegio Ficticio' } }] })}`, conv);
  const get = async (q) => (await fetch(`http://localhost:3200/api/diagnostico/conversaciones/${conv}${q}`, { headers: { Authorization: `Bearer ${tk}` } })).json();
  const d = await get('');
  const px = d.drive_y_extracciones.por_archivo.find((a) => a.archivo === 'Prospeccion_ficticia.xlsx');
  ok(px && px.lecturas_bloqueadas === 1 && px.consultas_permisos === 1 && px.descargas === 0 && px.extracciones_nuevas === 0 && px.reutilizaciones === 0 && px.copias_temporales === 0, `por archivo: ${JSON.stringify(px)}`);
  ok(d.drive_y_extracciones.escrituras_en_drive.length === 0, 'sin escrituras en Drive');
  const it = d.registros_internos.items.find((x) => x.id === item);
  ok(it && it.creado === 1 && it.actualizado === 1 && it.existe && it.texto === undefined && it.largo_texto > 0, 'registros tocados sin texto por defecto');
  const d2 = await get('?registros=1');
  const it2 = d2.registros_internos.items.find((x) => x.id === item);
  ok(it2 && it2.texto === 'Contactar a Claudio Ficticio — Colegio Ficticio' && d2.registros_internos.posibles_duplicados.length === 0, `con la opción: texto final "${it2 && it2.texto}" y sin duplicados`);
  const conv2 = d.turnos_registrados.filter((t) => t.origen === 'conversacion').slice(-2);
  console.log('   turnos:', JSON.stringify(d.turnos_registrados.map((t) => [t.origen, t.seleccion])));
  ok(conv2.length === 2 && conv2.every((t) => /^(rapido|profundo): /.test(t.seleccion || '')), `selección de modelo por turno: ${conv2.map((t) => t.seleccion).join(' | ')}`);
  srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
