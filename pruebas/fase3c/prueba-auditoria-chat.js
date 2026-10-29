// Fase 3d — Auditoría pedida desde la conversación (Drive y Claude simulados). Regresión de la conversación 60:
//  1) propuesta nueva desde el chat · 2) tarjeta correcta · 3) reaparece al recargar · 4) ningún trabajo antes de aprobar
//  5) aprobar · 6) se ejecuta exactamente lo aprobado (requisitos, modelo, presupuesto) · 7) avance del trabajo correcto
//  8) Excel desde la tarjeta final · 9) una auditoría antigua nunca se confunde con la actual.
// Además: app antigua que no sabe dibujar la tarjeta → ADA no dice que hay tarjeta; carrera de doble aprobación; corte del servidor.
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const S = __dirname;
const datos = require('../datos-ficticios/prueba-a.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
const CLAVE = `aud-${crypto.randomBytes(32).toString('base64')}`;
process.env.ADA_CLAVE_DATOS = CLAVE;
const Cifrado = require('../../src/cifrado');
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk;
async function arrancar() {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: CLAVE, ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba',
      ADA_TRABAJO_LEASE_MS: '3000', ADA_TRABAJO_CICLO_MS: '300', FAKE_AUDITOR: 'lento', FAKE_LENTO_MS: '700', ADA_TURNOS_2MIN: '100' } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (_) { d = t; } return { status: r.status, d }; };
const post = (ruta, body) => api(ruta, { method: 'POST', body: JSON.stringify(body || {}) });
const TARJETAS = ['auditoria_propuesta@1'];
let nonce = 0;
async function chat(llamadas, { conv = null, tarjetas = TARJETAS } = {}) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: JSON.stringify({ mensaje: `[${Date.now()}-${++nonce}] HERR ${JSON.stringify({ llamadas })}`, conversacion_id: conv, tarjetas }) });
  const t = await r.text();
  const eventos = t.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { tipo: e.slice(7), d: JSON.parse(d.slice(6)) }; });
  const fin = eventos.find((e) => e.tipo === 'fin');
  const texto = fin ? fin.d.respuesta : '';
  const m = texto.match(/DATOS=(.*)$/s);
  return { eventos, texto, datos: m ? JSON.parse(m[1]) : [], conv: (eventos.find((e) => e.tipo === 'conversacion') || { d: {} }).d.conversacion_id };
}
const REQ = datos.documento_base.requisitos;
const nTrabajos = () => Number(sql("SELECT COUNT(*) FROM trabajos WHERE tipo='auditoria'"));
const activos = () => Number(sql("SELECT COUNT(*) FROM trabajos WHERE tipo='auditoria' AND estado IN ('ejecutando','esperando_aprobacion','pausado','propuesto')"));
async function esperarFin(id, ms = 40000) {
  const fin = Date.now() + ms; let av;
  while (Date.now() < fin) { av = (await api(`/api/auditorias/${id}/avance`)).d; if (['completado', 'bloqueado', 'cancelado'].includes(av.estado)) return av; await dormir(250); }
  return av;
}

(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM extraccion_eventos'); sql('DELETE FROM auditoria_propuestas');
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
    // ---- 0. Una auditoría ANTIGUA ya completada (K3, US$0,10), lanzada desde Ajustes: el caso 32c19e64 de la conversación 60 ----
    const est0 = (await post('/api/auditorias/estimar', { archivo_id: 'AUD1', requisitos: REQ })).d;
    const vieja = (await post('/api/auditorias', { archivo_id: 'AUD1', requisitos: REQ, configuracion: 'K3', presupuesto: Math.max(0.1, est0.presupuesto_minimo.K3) })).d;
    const avVieja = await esperarFin(vieja.id);
    ok(avVieja.estado === 'completado', `auditoría antigua K3 completada (${vieja.id.slice(0, 8)})`);

    // ---- 1–2. Propuesta nueva desde el chat: tarjeta correcta ----
    const antes = nTrabajos();
    const iaAntes = Number(sql('SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id IS NOT NULL'));
    let c = await chat([{ name: 'proponer_auditoria', input: { archivo_ids: ['AUD1'], requisitos: REQ, motivo: 'Prueba de auditoría desde el chat' } }]);
    const conv = c.conv;
    const prop = (c.eventos.find((e) => e.tipo === 'auditoria_propuesta') || {}).d;
    const res = c.datos[0] || {};
    ok(prop && prop.id === res.propuesta_id && prop.requisitos.length === 3 && prop.archivos[0].id === 'AUD1', 'la tarjeta emitida corresponde a la propuesta creada (mismo id, archivo y 3 requisitos)');
    ok(prop && prop.configuracion === 'K1' && prop.presupuesto_sugerido >= prop.presupuesto_minimo.K1, `K1 y presupuesto sugerido US$${prop && prop.presupuesto_sugerido}`);
    ok(res.tarjeta === 'enviada' && res.estado === 'pendiente_de_aprobacion' && res.trabajo === null, 'el resultado de la herramienta dice "tarjeta enviada", pendiente y sin trabajo');
    ok(sql(`SELECT CONCAT(estado,'|',conversacion_id,'|',tarjeta_estado) FROM auditoria_propuestas WHERE id='${prop.id}'`) === `pendiente|${conv}|enviada`, 'la propuesta queda ligada a esta conversación');
    const fila = sql(`SELECT datos_cifrado FROM auditoria_propuestas WHERE id='${prop.id}'`);
    ok(fila.startsWith('v1:') && !fila.includes('extintor'), 'la propuesta se guarda cifrada');
    // La app confirma que la dibujó.
    await post(`/api/auditorias/propuestas/${prop.id}/tarjeta`, { estado: 'mostrada' });
    ok(sql(`SELECT tarjeta_estado FROM auditoria_propuestas WHERE id='${prop.id}'`) === 'mostrada', 'la app confirma que la tarjeta se mostró');

    // ---- 3. Recargar: la misma tarjeta vuelve desde el servidor ----
    const act = (await api('/api/auditorias/activas')).d;
    const deConv = (await api(`/api/auditorias/propuestas?conversacion_id=${conv}`)).d;
    ok(act.propuestas.some((p) => p.id === prop.id && p.presupuesto_sugerido === prop.presupuesto_sugerido) && deConv.length === 1 && deConv[0].id === prop.id, 'al recargar, la misma propuesta pendiente vuelve (por conversación y en general)');
    ok(!act.trabajos.some((t) => t.id === vieja.id), 'al recargar no aparece la auditoría antigua de Ajustes como si fuera del chat');

    // ---- 4. Antes de aprobar: ningún trabajo nuevo, ningún gasto; ver_auditoria no confunde con la antigua (9) ----
    ok(nTrabajos() === antes && activos() === 0 && Number(sql('SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id IS NOT NULL')) === iaAntes, 'antes de aprobar: 0 trabajos nuevos, 0 ejecutándose, 0 llamadas de trabajo');
    c = await chat([{ name: 'ver_auditoria', input: {} }], { conv });
    let ver = c.datos[0] || {};
    ok(ver.propuesta_id === prop.id && ver.estado_propuesta === 'pendiente' && ver.trabajo === null && ver.es_de_esta_conversacion === true, `ver_auditoria (sin id) devuelve la propuesta de esta conversación, pendiente y sin trabajo — no ${vieja.id.slice(0, 8)}`);
    ok(!JSON.stringify(ver).includes(vieja.id), 'ver_auditoria no menciona el trabajo antiguo');
    c = await chat([{ name: 'ver_auditoria', input: {} }]);
    ver = c.datos[0] || {};
    ok(ver.hay === false && !JSON.stringify(ver).includes(vieja.id) && c.conv !== conv, `en una conversación sin propuestas, ver_auditoria dice que no hay ninguna (no trae la antigua) [conv ${c.conv} vs ${conv}: ${JSON.stringify(ver).slice(0, 160)}]`);

    // ---- App antigua: no declara la tarjeta → la propuesta se guarda, pero ADA no dice que hay tarjeta ----
    c = await chat([{ name: 'proponer_auditoria', input: { archivo_ids: ['AUD1'], requisitos: REQ.slice(0, 1) } }], { tarjetas: [] });
    const vieja2 = c.datos[0] || {};
    ok(!c.eventos.some((e) => e.tipo === 'auditoria_propuesta') && vieja2.tarjeta === 'no_disponible' && /NO digas que hay una tarjeta/.test(vieja2.nota) && /cierre ADA/.test(vieja2.nota), 'app sin soporte: no se emite tarjeta y la herramienta le dice a ADA que no la afirme y cómo acceder');
    ok(sql(`SELECT CONCAT(estado,'|',tarjeta_estado) FROM auditoria_propuestas WHERE id='${vieja2.propuesta_id}'`) === 'pendiente|no_soportada' && (await api('/api/auditorias/propuestas')).d.some((p) => p.id === vieja2.propuesta_id), 'esa propuesta queda pendiente y accesible (Ajustes / al reabrir)');
    await post(`/api/auditorias/propuestas/${vieja2.propuesta_id}/descartar`);

    // ---- Fuera de la carpeta de prueba ----
    c = await chat([{ name: 'proponer_auditoria', input: { archivo_ids: ['AUDX'], requisitos: REQ } }]);
    ok(/fuera de la carpeta autorizada/.test(JSON.stringify(c.datos)) && !c.eventos.some((e) => e.tipo === 'auditoria_propuesta'), 'archivo fuera de la carpeta de prueba: rechazado, sin tarjeta');

    // ---- 5. Aprobar desde la tarjeta (con un requisito editado), con carrera de doble toque ----
    let r = await post(`/api/auditorias/propuestas/${prop.id}/aprobar`, { presupuesto: 0.001, configuracion: 'K1' });
    ok(r.status === 400 && sql(`SELECT estado FROM auditoria_propuestas WHERE id='${prop.id}'`) === 'pendiente', 'presupuesto bajo el mínimo: no empieza y sigue pendiente');
    const editados = REQ.map((x, i) => (i === 2 ? { ...x, texto: `${x.texto} (editado en la tarjeta)` } : x));
    const cuerpo = { presupuesto: prop.presupuesto_sugerido, requisitos: editados, configuracion: 'K1', origen: 'tarjeta_chat' };
    const [a1, a2] = await Promise.all([post(`/api/auditorias/propuestas/${prop.id}/aprobar`, cuerpo), post(`/api/auditorias/propuestas/${prop.id}/aprobar`, cuerpo)]);
    const okA = [a1, a2].filter((x) => x.status === 200);
    ok(okA.length === 1 && [a1, a2].some((x) => x.status === 409) && nTrabajos() === antes + 1, 'dos toques simultáneos en Aprobar: un solo trabajo');
    const id = okA[0].d.trabajo_id;
    ok(okA[0].d.propuesta_id === prop.id && okA[0].d.configuracion === 'K1' && okA[0].d.presupuesto === prop.presupuesto_sugerido, 'la respuesta de aprobación liga propuesta → trabajo con K1 y el presupuesto aprobado');

    // ---- 6. Se ejecuta exactamente lo aprobado ----
    const tObj = sql(`SELECT objetivo_cifrado FROM trabajos WHERE id='${id}'`);
    const tPres = sql(`SELECT presupuesto_usd FROM trabajos WHERE id='${id}'`);
    const tTit = sql(`SELECT titulo FROM trabajos WHERE id='${id}'`);
    const obj = Cifrado.descifrarJSON(tObj);
    const apr = Cifrado.descifrarJSON(sql(`SELECT aprobacion_cifrada FROM auditoria_propuestas WHERE id='${prop.id}'`));
    ok(JSON.stringify(obj.requisitos) === JSON.stringify(editados) && JSON.stringify(apr.requisitos) === JSON.stringify(editados) && obj.requisitos_hash === apr.requisitos_hash, 'el trabajo usa exactamente los requisitos aprobados (incluida la edición)');
    ok(obj.config === 'K1' && /K1/.test(tTit) && Math.abs(Number(tPres) - prop.presupuesto_sugerido) < 1e-9 && obj.propuesta.id === prop.id && obj.propuesta.conversacion_id === conv, `configuración K1, presupuesto US$${tPres}, y el trabajo guarda su propuesta y conversación`);

    // ---- 7. Avance del trabajo correcto ----
    const vistos = [];
    let av;
    for (let i = 0; i < 160; i++) {
      av = (await api(`/api/auditorias/${id}/avance`)).d;
      vistos.push(`${av.estado}:${av.requisitos_evaluados}/${av.requisitos_total}`);
      if (['completado', 'bloqueado', 'cancelado'].includes(av.estado)) break;
      if (i === 4) {
        c = await chat([{ name: 'ver_auditoria', input: {} }], { conv });
        ver = c.datos[0] || {};
        ok(ver.propuesta_id === prop.id && ver.trabajo && ver.trabajo.id === id && ver.aprobado.configuracion === 'K1' && ver.aprobado.presupuesto_usd === prop.presupuesto_sugerido && !JSON.stringify(ver).includes(vieja.id),
          `ver_auditoria a mitad de camino: trabajo ${id.slice(0, 8)} de esta propuesta (no ${vieja.id.slice(0, 8)}), K1, US$${ver.aprobado && ver.aprobado.presupuesto_usd}`);
      }
      await dormir(250);
    }
    ok(vistos.some((v) => /^ejecutando:[12]\/3/.test(v)), `avance real observado (${[...new Set(vistos)].join(' → ')})`);
    ok(av.id === id && av.propuesta_id === prop.id && av.conversacion_id === conv, 'el avance identifica trabajo, propuesta y conversación');
    ok(av.estado === 'completado' && av.excel_listo && av.matriz.map((f) => f.estado).join(',') === 'cumple,parcial,no_aplica_justificado', `terminó: ${av.matriz && av.matriz.map((f) => `${f.requisito}=${f.estado}`).join(', ')}`);
    const modelos = sql(`SELECT DISTINCT modelo FROM llamadas_ia WHERE trabajo_id='${id}'`).split('\n').filter(Boolean);
    ok(modelos.length === 1 && /sonnet/.test(modelos[0]), `K1: todas las llamadas del trabajo con Sonnet (${modelos.join(', ')})`);
    ok(av.costo_real_usd > 0 && av.costo_real_usd <= av.presupuesto_usd && av.reserva_activa_usd === 0, `costo real US$${av.costo_real_usd} de US$${av.presupuesto_usd}, sin reservas activas`);

    // ---- 8. Excel desde la tarjeta final ----
    const xr = await fetch(`http://localhost:3200/api/auditorias/${id}/excel`, { headers: { Authorization: `Bearer ${tk}` } });
    const buf = Buffer.from(await xr.arrayBuffer());
    ok(xr.status === 200 && buf.slice(0, 2).toString() === 'PK' && buf.length > 3000, `Excel del trabajo aprobado (${buf.length} bytes)`);
    const ExcelJS = require('exceljs');
    const libro = new ExcelJS.Workbook(); await libro.xlsx.load(buf);
    let tieneEdicion = false; libro.worksheets[0].eachRow((row) => { if (String(row.getCell(2).value || '').includes('(editado en la tarjeta)')) tieneEdicion = true; });
    ok(tieneEdicion, 'el Excel contiene el requisito tal como se aprobó (editado)');

    // ---- Constancia de aprobación (gobernanza), solo lectura ----
    const llamadasAntes = Number(sql('SELECT COUNT(*) FROM llamadas_ia'));
    const k = (await api(`/api/auditorias/propuestas/${prop.id.slice(0, 8)}/constancia`)).d;
    console.log(k.comprobaciones.map((x) => `     ${x}`).join('\n'));
    ok(k.resultado === 'correcto' && k.comprobaciones.length >= 10 && k.comprobaciones.every((x) => x.startsWith('✓')), `constancia por id corto: ${k.resultado} (${k.comprobaciones.length} comprobaciones)`);
    ok(k.aprobacion.origen.via === 'tarjeta_chat' && k.aprobacion.origen.usuario_id === 1 && k.aprobacion.configuracion === 'K1' && k.aprobacion.presupuesto_usd === prop.presupuesto_sugerido && k.aprobacion.requisitos.length === 3 && /editado en la tarjeta/.test(k.aprobacion.requisitos[2]),
      'la aprobación guarda origen (botón de la tarjeta, usuario 1), fecha, requisitos tal como se aprobaron, K1 y presupuesto');
    ok(new Date(k.trabajo.aprobado_en) <= new Date(k.trabajo.primer_paso.inicio) && new Date(k.aprobacion.en) <= new Date(k.trabajo.primera_llamada_ia.en), `aprobado ${k.trabajo.aprobado_en} antes del primer paso ${k.trabajo.primer_paso.inicio}`);
    ok(k.trabajo.eventos.some((e) => /propuesta_aprobada \(propuesta .{8} aprobada desde tarjeta_chat\)/.test(e)), 'el registro del trabajo anota desde dónde se aprobó');
    ok(Number(sql('SELECT COUNT(*) FROM llamadas_ia')) === llamadasAntes, 'consultar la constancia no ejecuta ni gasta nada');
    ok((await api('/api/auditorias/propuestas/zz/constancia')).status === 400 && (await api('/api/auditorias/propuestas/ffffffff/constancia')).status === 404, 'id inválido o inexistente: error claro');

    // ---- 9. La antigua y la nueva, separadas ----
    c = await chat([{ name: 'ver_auditoria', input: {} }], { conv });
    ver = c.datos[0] || {};
    ok(ver.trabajo && ver.trabajo.id === id && ver.trabajo.config === 'K1' && ver.trabajo.id !== vieja.id, 'al terminar, ver_auditoria sigue mostrando la nueva (K1), nunca la antigua K3');
    c = await chat([{ name: 'ver_auditoria', input: { trabajo_id: vieja.id } }], { conv });
    ver = c.datos[0] || {};
    ok(ver.id === vieja.id && /no nació de una propuesta del chat/.test(ver.nota || ''), 'la antigua solo aparece si se pide por su id, marcada como lanzada desde Ajustes');

    // ---- Descartar ----
    c = await chat([{ name: 'proponer_auditoria', input: { carpeta_id: 'carpeta-prueba', requisitos: REQ.slice(0, 1) } }], { conv });
    const prop2 = (c.eventos.find((e) => e.tipo === 'auditoria_propuesta') || {}).d;
    ok(prop2 && prop2.archivos.map((a) => a.id).sort().join(',') === 'AUD1,AUD2', 'por carpeta: solo los documentos de la carpeta de prueba');
    r = await post(`/api/auditorias/propuestas/${prop2.id}/descartar`);
    const r3 = await post(`/api/auditorias/propuestas/${prop2.id}/aprobar`, { presupuesto: 1 });
    ok(r.status === 200 && r3.status === 409 && nTrabajos() === antes + 1, 'una propuesta descartada no se puede aprobar');

    // ---- Corte del servidor durante la auditoría ----
    c = await chat([{ name: 'proponer_auditoria', input: { archivo_ids: ['AUD1'], requisitos: REQ } }]);
    const prop3 = c.eventos.find((e) => e.tipo === 'auditoria_propuesta').d;
    r = await post(`/api/auditorias/propuestas/${prop3.id}/aprobar`, { presupuesto: prop3.presupuesto_sugerido });
    for (let i = 0; i < 40; i++) { av = (await api(`/api/auditorias/${r.d.trabajo_id}/avance`)).d; if (av.requisitos_evaluados >= 1) break; await dormir(150); }
    srv.kill('SIGKILL'); await dormir(800);
    await arrancar();
    av = await esperarFin(r.d.trabajo_id);
    ok(av.estado === 'completado' && av.excel_listo && av.propuesta_id === prop3.id, 'tras un corte del servidor, el trabajo aprobado termina solo y sigue ligado a su propuesta');
  } catch (e) { ok(false, `excepción: ${e.stack}`); console.log(srv.log.slice(-3000)); }
  srv.kill(); drive.kill();
  setTimeout(() => process.exit(), 300);
})();
