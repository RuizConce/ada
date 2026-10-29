// Fase 3d — Auditoría pedida desde la conversación, con Drive y Claude simulados:
// ADA propone (archivos, requisitos, configuración y presupuesto) → nada empieza → Cristian aprueba con el botón
// → encargo persistente con avance real → Excel descargable → la tarjeta se recupera al recargar.
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const S = __dirname;
const datos = require('/home/claude/ada/pruebas/datos-ficticios/prueba-a.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const CLAVE = `aud-${crypto.randomBytes(32).toString('base64')}`;
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk;
async function arrancar() {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: '/home/claude/ada', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: CLAVE, ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba',
      ADA_TRABAJO_LEASE_MS: '3000', ADA_TRABAJO_CICLO_MS: '300', FAKE_AUDITOR: 'lento', FAKE_LENTO_MS: '700' } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (_) { d = t; } return { status: r.status, d }; };
const post = (ruta, body) => api(ruta, { method: 'POST', body: JSON.stringify(body || {}) });
let nonce = 0;
async function chat(llamadas) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: JSON.stringify({ mensaje: `[${++nonce}] HERR ${JSON.stringify({ llamadas })}` }) });
  const t = await r.text();
  const eventos = t.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { tipo: e.slice(7), d: JSON.parse(d.slice(6)) }; });
  const fin = eventos.find((e) => e.tipo === 'fin');
  return { eventos, texto: fin ? fin.d.respuesta : '' };
}
const REQ = datos.documento_base.requisitos;
const nTrabajos = () => Number(sql("SELECT COUNT(*) FROM trabajos WHERE tipo='auditoria'"));

(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM extraccion_eventos');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  const texto = datos.documento_evidencia.texto;
  await ctl('/control/archivos', { archivos: [
    { id: 'carpeta-prueba', name: 'Prueba ADA', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { id: 'AUD1', name: 'Expediente ficticio Sala Aurora.pdf', mimeType: 'application/pdf', texto, md5Checksum: 'aud-v1', version: 1, parents: ['carpeta-prueba'] },
    { id: 'AUD2', name: 'Anexo ficticio.pdf', mimeType: 'application/pdf', texto: 'Anexo ficticio sin información de extintores.', md5Checksum: 'aud2', version: 1, parents: ['carpeta-prueba'] },
    { id: 'AUDX', name: 'Documento fuera de la carpeta.pdf', mimeType: 'application/pdf', texto, md5Checksum: 'x', version: 1, parents: ['otra'] },
  ] });
  await arrancar();
  try {
    // ---- 1. ADA propone desde la conversación: tarjeta, sin empezar ni gastar ----
    const antes = nTrabajos();
    const iaAntes = Number(sql('SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id IS NOT NULL'));
    let c = await chat([{ name: 'proponer_auditoria', input: { archivo_ids: ['AUD1'], requisitos: REQ, motivo: 'Prueba de auditoría desde el chat' } }]);
    const prop = (c.eventos.find((e) => e.tipo === 'auditoria_propuesta') || {}).d;
    ok(prop && prop.id && prop.requisitos.length === 3 && prop.archivos[0].nombre === 'Expediente ficticio Sala Aurora.pdf', 'la conversación emite la tarjeta de propuesta con archivo y 3 requisitos');
    ok(prop && prop.configuracion === 'K1' && prop.presupuesto_sugerido >= prop.presupuesto_minimo.K1 && prop.estimados.K1 > 0, `configuración provisional K1 y presupuesto sugerido US$${prop && prop.presupuesto_sugerido} (mínimo ${prop && prop.presupuesto_minimo.K1})`);
    ok(/RES=\["OK"\]/.test(c.texto), `la herramienta respondió sin error: ${c.texto}`);
    ok(nTrabajos() === antes && Number(sql('SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id IS NOT NULL')) === iaAntes, 'proponer no crea el encargo ni gasta: nada empieza sin el botón');
    const fila = sql(`SELECT CONCAT(estado,'|',datos_cifrado) FROM auditoria_propuestas WHERE id='${prop.id}'`);
    ok(fila.startsWith('pendiente|v1:') && !fila.includes('extintor') && !fila.includes('Sala Aurora'), 'la propuesta queda guardada cifrada (sin requisitos ni nombres en claro)');

    // ---- 2. Fuera de la carpeta de prueba: rechazado por el servidor ----
    c = await chat([{ name: 'proponer_auditoria', input: { archivo_ids: ['AUDX'], requisitos: REQ } }]);
    ok(/ERROR:«Documento fuera de la carpeta.pdf» está fuera de la carpeta autorizada/.test(c.texto) && !c.eventos.some((e) => e.tipo === 'auditoria_propuesta'), `archivo fuera de la carpeta de prueba: rechazado, sin tarjeta (${c.texto})`);
    const stX = await ctl('/control/stats');
    ok(!stX.export.AUDX && !(stX.media || {}).AUDX, 'el archivo de fuera no se descargó');

    // ---- 3. Por carpeta: toma solo los documentos de la carpeta ----
    c = await chat([{ name: 'proponer_auditoria', input: { carpeta_id: 'carpeta-prueba', requisitos: REQ.slice(0, 1) } }]);
    const prop2 = (c.eventos.find((e) => e.tipo === 'auditoria_propuesta') || {}).d;
    ok(prop2 && prop2.archivos.map((a) => a.id).sort().join(',') === 'AUD1,AUD2', `por carpeta: ${prop2 && prop2.archivos.map((a) => a.nombre).join(' + ')}`);

    // ---- 4. Aprobación: solo con el botón y con presupuesto suficiente ----
    let r = await post(`/api/auditorias/propuestas/${prop.id}/aprobar`, { presupuesto: 0.001 });
    ok(r.status === 400 && /menor que el mínimo/.test(r.d.error) && sql(`SELECT estado FROM auditoria_propuestas WHERE id='${prop.id}'`) === 'pendiente', 'presupuesto bajo el mínimo: no empieza y la propuesta sigue pendiente');
    r = await post(`/api/auditorias/propuestas/${prop.id}/aprobar`, { presupuesto: prop.presupuesto_sugerido, requisitos: prop.requisitos, configuracion: 'K1' });
    ok(r.status === 200 && r.d.trabajo_id && r.d.estado === 'ejecutando', 'aprobada con el botón: encargo persistente en marcha');
    const id = r.d.trabajo_id;
    const r2 = await post(`/api/auditorias/propuestas/${prop.id}/aprobar`, { presupuesto: prop.presupuesto_sugerido });
    ok(r2.status === 409 && nTrabajos() === antes + 1, 'una segunda aprobación no crea otro encargo');

    // ---- 5. Avance real mientras trabaja ----
    const vistos = [];
    let av;
    for (let i = 0; i < 120; i++) {
      av = (await api(`/api/auditorias/${id}/avance`)).d;
      vistos.push(`${av.estado}:${av.requisitos_evaluados}/${av.requisitos_total}:${av.pasos_hechos}/${av.pasos_total}`);
      if (['completado', 'bloqueado', 'cancelado'].includes(av.estado)) break;
      await dormir(250);
    }
    const intermedio = vistos.find((v) => /^ejecutando:[12]\/3/.test(v));
    ok(!!intermedio, `avance real observado a mitad de camino (${[...new Set(vistos)].join(' → ')})`);
    ok(av.estado === 'completado' && av.excel_listo, `terminó: ${av.estado}${av.motivo ? ` (${av.motivo})` : ''}`);
    ok(av.matriz && av.matriz.map((f) => f.estado).join(',') === 'cumple,parcial,no_aplica_justificado' && av.matriz.every((f) => f.cita_verificada), `resultado por requisito: ${av.matriz && av.matriz.map((f) => `${f.requisito}=${f.estado}`).join(', ')}`);
    ok(av.costo_real_usd > 0 && av.costo_real_usd <= av.presupuesto_usd && av.reserva_activa_usd === 0, `costo real US$${av.costo_real_usd} de US$${av.presupuesto_usd}, sin reservas activas`);
    ok(sql(`SELECT estado FROM auditoria_propuestas WHERE id='${prop.id}'`) === 'aprobada' && sql(`SELECT trabajo_id FROM auditoria_propuestas WHERE id='${prop.id}'`) === id, 'la propuesta queda enlazada al encargo');

    // ---- 6. Excel desde el chat ----
    const xr = await fetch(`http://localhost:3200/api/auditorias/${id}/excel`, { headers: { Authorization: `Bearer ${tk}` } });
    const buf = Buffer.from(await xr.arrayBuffer());
    ok(xr.status === 200 && buf.slice(0, 2).toString() === 'PK' && buf.length > 3000, `Excel descargable (${buf.length} bytes)`);

    // ---- 7. ADA consulta el avance (ver_auditoria) ----
    c = await chat([{ name: 'ver_auditoria', input: {} }]);
    ok(/RES=\["OK"\]/.test(c.texto), 'ver_auditoria responde desde la base');

    // ---- 8. Al recargar, la tarjeta se recupera ----
    const act = (await api('/api/auditorias/activas')).d;
    ok(Array.isArray(act) && act.some((a) => a.id === id && a.excel_listo), 'al recargar la app, la auditoría reciente vuelve a aparecer con su Excel');

    // ---- 9. Descartar ----
    r = await post(`/api/auditorias/propuestas/${prop2.id}/descartar`);
    const r3 = await post(`/api/auditorias/propuestas/${prop2.id}/aprobar`, { presupuesto: 1 });
    ok(r.status === 200 && r3.status === 409 && nTrabajos() === antes + 1, 'una propuesta descartada no se puede aprobar después');

    // ---- 10. Un corte a mitad: la auditoría sigue al volver ----
    c = await chat([{ name: 'proponer_auditoria', input: { archivo_ids: ['AUD1'], requisitos: REQ } }]);
    const prop3 = c.eventos.find((e) => e.tipo === 'auditoria_propuesta').d;
    r = await post(`/api/auditorias/propuestas/${prop3.id}/aprobar`, { presupuesto: prop3.presupuesto_sugerido });
    for (let i = 0; i < 40; i++) { av = (await api(`/api/auditorias/${r.d.trabajo_id}/avance`)).d; if (av.requisitos_evaluados >= 1) break; await dormir(150); }
    srv.kill('SIGKILL'); await dormir(800);
    await arrancar();
    for (let i = 0; i < 120; i++) { av = (await api(`/api/auditorias/${r.d.trabajo_id}/avance`)).d; if (['completado', 'bloqueado'].includes(av.estado)) break; await dormir(300); }
    const llam = sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${r.d.trabajo_id}' AND error IS NULL`);
    ok(av.estado === 'completado' && av.excel_listo, `tras un corte del servidor la auditoría terminó sola (${av.estado}; ${llam} llamadas exitosas para 3 requisitos)`);
  } catch (e) { ok(false, `excepción: ${e.stack}`); console.log(srv.log.slice(-3000)); }
  srv.kill(); drive.kill();
  setTimeout(() => process.exit(), 300);
})();
