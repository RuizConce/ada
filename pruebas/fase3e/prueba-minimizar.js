// Minimización de datos personales: RUT, correos, teléfonos y fechas de nacimiento se enmascaran antes del análisis.
// Unitaria + auditoría H con datos personales ficticios agregados: no llegan a la selección, al Excel ni al informe.
const { spawn, execSync } = require('child_process');
const S = __dirname;
const H = JSON.parse(JSON.stringify(require('../datos-ficticios/prueba-h.json')));
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString().trim();
const CLAVE = 'minimizar-clave-fija-0123456789-abcdefghijklmnop';
process.env.ADA_CLAVE_DATOS = CLAVE; process.env.ANTHROPIC_API_KEY = 'x';
const A = require('../../src/auditoria');
const Cifrado = require('../../src/cifrado');
const PII = ['12.345.678-9', '9876543-K', 'ana.rojas@correo.cl', '+56 9 8765 4321', '01/02/1980'];
(async () => {
  const m = A.minimizar('RUT 12.345.678-9 y RUN 9876543-K; ana.rojas@correo.cl; +56 9 8765 4321; Fecha de nacimiento: 01/02/1980. Resolución N° 2345 de 2024, folio 12345678, 15/03/2024, 6 kg.');
  ok(!PII.some((x) => m.texto.includes(x)) && m.conteo.rut === 2 && m.conteo.correo === 1 && m.conteo.telefono === 1 && m.conteo.nacimiento === 1, `enmascara RUT, RUN, correo, teléfono y fecha de nacimiento: ${JSON.stringify(m.conteo)}`);
  ok(/N° 2345 de 2024, folio 12345678, 15\/03\/2024, 6 kg/.test(m.texto), 'no toca resoluciones, folios, fechas comunes ni cantidades');
  // Auditoría H con datos personales en la nómina (HD2).
  const hd2 = H.documentos.find((d) => d.id === 'HD2');
  hd2.texto = hd2.texto.replace('la Dra. Ana Rojas, odontóloga;', 'la Dra. Ana Rojas, odontóloga, RUT 12.345.678-9, correo ana.rojas@correo.cl, teléfono +56 9 8765 4321, fecha de nacimiento: 01/02/1980;');
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM auditoria_propuestas');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [
    { id: 'carpeta-prueba', name: 'Prueba ADA', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { id: 'HN', name: H.norma.nombre, mimeType: 'application/pdf', texto: H.norma.texto, md5Checksum: 'hn', version: 1, parents: ['carpeta-prueba'] },
    ...H.documentos.map((d) => ({ id: d.id, name: d.nombre, mimeType: 'application/pdf', texto: d.texto, md5Checksum: `${d.id}-pii`, version: 1, parents: ['carpeta-prueba'] })),
  ] }) });
  const srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago', ADA_CLAVE_DATOS: CLAVE,
      ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_TRABAJO_CICLO_MS: '200', ADA_TURNOS_2MIN: '100', ADA_TOPE_DIARIO: '1000',
      FAKE_H: require.resolve('../datos-ficticios/prueba-h.json') } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
  const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
  const post = (ruta, b) => api(ruta, { method: 'POST', body: JSON.stringify(b || {}) });
  const esperar = async (id) => { for (let i = 0; i < 300; i++) { const a = (await api(`/api/auditorias/${id}/avance`)).d; if (['completado', 'bloqueado', 'cancelado'].includes(a.estado)) return a; await dormir(200); } return null; };
  try {
    const r0 = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
      body: JSON.stringify({ mensaje: `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input: { norma_id: 'HN', carpeta_id: 'carpeta-prueba' } }] })}`, tarjetas: ['auditoria_propuesta@1'] }) });
    const pA = (await r0.text()).split('\n\n').filter((b) => b.startsWith('event: auditoria_propuesta')).map((b) => JSON.parse(b.split('\n')[1].slice(6)))[0];
    let r = await post(`/api/auditorias/propuestas/${pA.id}/aprobar`, { presupuesto: pA.presupuesto_sugerido });
    const a = await esperar(r.d.trabajo_id);
    const pB = (await api('/api/auditorias/propuestas')).d.find((x) => x.id === a.lista_propuesta.propuesta_id);
    r = await post(`/api/auditorias/propuestas/${pB.id}/aprobar`, { presupuesto: pB.presupuesto_sugerido });
    const fin = await esperar(r.d.trabajo_id);
    const id = r.d.trabajo_id;
    // Lo que guarda la selección (lo que recibe la IA) y la matriz.
    const pasos = sql(`SELECT resultado_cifrado FROM trabajo_pasos WHERE trabajo_id='${id}' AND resultado_cifrado IS NOT NULL`).split('\n').filter(Boolean).map((x) => JSON.stringify(Cifrado.descifrarJSON(x)));
    const todo = pasos.join('\n');
    ok(fin.estado === 'completado' && !PII.some((x) => todo.includes(x)), `auditoría completa (${fin.estado}) y ningún dato personal en los fragmentos enviados a la IA, la matriz, el Excel ni el informe guardados`);
    ok(/\[RUT\]/.test(todo) && /\[correo\]/.test(todo), 'en su lugar aparecen las marcas [RUT], [correo]…');
    const e = await post('/api/descargas', { tipo: 'auditoria', id });
    const ExcelJS = require('exceljs'); const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(Buffer.from(await (await fetch(`http://localhost:3200${e.d.url}`)).arrayBuffer()));
    let fila = ''; libro.getWorksheet('Resumen').eachRow((row) => { if (/enmascarados/.test(String(row.getCell(1).value))) fila = String(row.getCell(2).value); });
    ok(fila === '1 RUT, 1 correos, 1 teléfonos, 1 fechas de nacimiento', `el Excel informa cuántos datos se enmascararon, sin los valores: "${fila}"`);
    const t = (await api(`/api/trabajos/${id}?resultado=1`)).d;
    ok(t.resultado.matriz.filas.find((f) => f.requisito === 'R4').estado === 'cumple', 'la evaluación no cambia: R4 sigue acreditado con la nómina enmascarada');
  } catch (err) { ok(false, err.stack); }
  srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
  setTimeout(() => process.exit(), 300);
})();
