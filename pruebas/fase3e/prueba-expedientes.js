// Expedientes (simulado): pegar el enlace de una carpeta NUEVA → autorizarla solo lectura con contraseña → elegir una
// lista guardada (SEREMI 18–47) sin volver a extraerla → inventario y presupuesto → aprobar → Excel y Word con el
// nombre del expediente. Aislamiento: la auditoría solo lee su carpeta (ni Andaluz, ni accesos directos, ni otras
// carpetas autorizadas). Límite de archivos avisado antes. Revocar corta el acceso.
const { spawn, execSync } = require('child_process');
const S = __dirname;
const D = require('../datos-ficticios/prueba-seremi.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql --default-character-set=utf8mb4 -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString().trim();
const CLAVE = 'expedientes-clave-fija-0123456789-abcdefghijklmn';
const PASS = 'clave-de-prueba-ADA';
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
const descargas = (st, id) => (st.export[id] || 0) + ((st.media || {})[id] || 0);
let srv; let tk;
const ENV = { PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: PASS, ADA_AVISOS: 'no', TZ: 'America/Santiago', ADA_CLAVE_DATOS: CLAVE,
  ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_DRIVE_CARPETAS_LECTURA: 'carpeta-seremi', // ninguna carpeta nueva en las variables
  ADA_TRABAJO_CICLO_MS: '150', ADA_TURNOS_2MIN: '200', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-seremi.json'), FAKE_H_EXTRACCION_OMITIR: '32,47' };
async function arrancar() {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ENV } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: PASS }) })).json()).token;
}
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const post = (ruta, b) => api(ruta, { method: 'POST', body: JSON.stringify(b || {}) });
let nonce = 0;
async function chat(input) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: JSON.stringify({ mensaje: `[${Date.now()}-${++nonce}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input }] })}`, tarjetas: ['auditoria_propuesta@1'] }) });
  const t = await r.text();
  const ev = t.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { tipo: e.slice(7), d: JSON.parse(d.slice(6)) }; });
  const fin = ev.find((e) => e.tipo === 'fin');
  const m = (fin ? fin.d.respuesta : '').match(/DATOS=(.*)$/s);
  return { tarjeta: (ev.find((e) => e.tipo === 'auditoria_propuesta') || {}).d, datos: m ? JSON.parse(m[1]) : null };
}
const esperar = async (id) => { for (let i = 0; i < 1500; i++) { const a = (await api(`/api/auditorias/${id}/avance`)).d; if (['completado', 'bloqueado', 'cancelado', 'pausado_presupuesto'].includes(a.estado)) return a; await dormir(150); } return null; };

// Carpeta NUEVA del cliente 2 (no está en ninguna variable): algunos documentos propios, una subcarpeta, un acceso
// directo a un archivo de Andaluz y otro a una carpeta ajena (no deben seguirse).
const txt = Object.fromEntries(D.archivos.map((a) => [a.id, a.texto]));
const C2 = [
  { id: 'carpeta-cliente2', name: 'Clinica_Dos_SEREMI', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], propietario: 'Cliente Dos' },
  { id: 'c2-sub-docs', name: 'Documentos', mimeType: 'application/vnd.google-apps.folder', parents: ['carpeta-cliente2'] },
  { id: 'C2_NOMINA', name: 'Nomina_personal.pdf', mimeType: 'application/pdf', texto: txt.A_NOMINA, md5Checksum: 'c2n', version: 1, parents: ['carpeta-cliente2'] },
  { id: 'C2_LAVADO', name: 'Lavado_de_manos.pdf', mimeType: 'application/pdf', texto: txt.A_LAVADO, md5Checksum: 'c2l', version: 1, parents: ['c2-sub-docs'] },
  { id: 'C2_GASES', name: 'NO_APLICA_gases.pdf', mimeType: 'application/pdf', texto: txt.A_GASES, md5Checksum: 'c2g', version: 1, parents: ['c2-sub-docs'] },
  { id: 'C2_ATAJO', name: 'Limpieza_y_desinfeccion (acceso directo)', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'A_LIMPIEZA', targetMimeType: 'application/pdf' }, md5Checksum: null, version: 1, parents: ['carpeta-cliente2'] },
  { id: 'C2_ATAJO_CARPETA', name: 'Carpeta de Andaluz (acceso directo)', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'carpeta-seremi', targetMimeType: 'application/vnd.google-apps.folder' }, version: 1, parents: ['carpeta-cliente2'] },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `C2_R${i}`, name: `Administrativo_${i}.pdf`, mimeType: 'application/pdf', texto: `Documento administrativo ficticio ${i} del cliente dos, sin relación con la pauta.`, md5Checksum: `c2r${i}`, version: 1, parents: [i % 2 ? 'c2-sub-docs' : 'carpeta-cliente2'] })),
];
const GRANDE = [{ id: 'carpeta-grande-x', name: 'Carpeta_grande', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
  ...Array.from({ length: 160 }, (_, i) => ({ id: `G${String(i).padStart(4, '0')}`, name: `Doc_${i}.pdf`, mimeType: 'application/pdf', texto: `Documento ${i}.`, md5Checksum: `g${i}`, version: 1, parents: ['carpeta-grande-x'] }))];

(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM auditoria_propuestas');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await ctl('/control/archivos', { archivos: [{ id: 'carpeta-seremi', name: 'Andaluz_SEREMI_para_subir (ficticia)', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }, ...D.carpetas, ...D.archivos, ...C2, ...GRANDE] });
  await arrancar();
  sql('DELETE FROM carpetas_autorizadas'); sql('DELETE FROM listas_requisitos');
  srv.kill(); await dormir(500); await arrancar(); // reinicia con la tabla vacía (la caché de carpetas se carga al arrancar)
  try {
    // ---- 0. Andaluz como en la realidad: extracción → lista corregida → auditoría TERMINADA. La tarjeta de la lista ya
    // no existe (se aprobó). La lista se guarda desde la auditoría terminada, sin IA ni costo.
    let c = await chat({ norma_id: D.norma_id, carpeta_id: 'carpeta-seremi', rango: { desde: 18, hasta: 47 }, perfil: 'seremi' });
    let r = await post(`/api/auditorias/propuestas/${c.tarjeta.id}/aprobar`, { presupuesto: c.tarjeta.presupuesto_sugerido, origen: 'tarjeta_chat' });
    const ext = await esperar(r.d.trabajo_id);
    const pB = (await api('/api/auditorias/propuestas')).d.find((x) => x.id === ext.lista_propuesta.propuesta_id);
    await post(`/api/auditorias/propuestas/${pB.id}/buscar-en-norma`, { frase: 'Contar con señalética de vías de evacuación.' });
    r = await post(`/api/auditorias/propuestas/${pB.id}/aprobar`, { presupuesto: pB.presupuesto_sugerido, configuracion: 'K1', origen: 'tarjeta_chat' });
    const tAndaluz = r.d.trabajo_id;
    ok((await esperar(tAndaluz)).estado === 'completado', `auditoría de Andaluz terminada (trabajo ${tAndaluz.slice(0, 8)}); su tarjeta de lista ya no está pendiente`);
    const term = (await api('/api/auditorias/terminadas')).d;
    ok(term[0].id === tAndaluz && term[0].excel && term[0].informe && term[0].requisitos === 30 && term[0].expediente, `«Auditorías terminadas» la muestra con Excel e informe: ${term[0] && term[0].expediente} · ${term[0] && term[0].ids}`);
    const v = (await api(`/api/auditorias/${tAndaluz}/requisitos`)).d;
    ok(v.total === 30 && v.completo && v.rango.desde === 18 && v.rango.hasta === 47 && v.fuente.id === D.norma_id && v.requisitos.find((x) => x.id === '47').texto.startsWith('MANUAL DE BIOSEGURIDAD') && v.notas.some((x) => /señalética/.test(x)),
      `en la base: ${v.total} requisitos del ${v.rango.desde} al ${v.rango.hasta} completos, textos íntegros (32 y 47 incluidos), fuente y observaciones`);
    const llamadas0 = sql('SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id IS NOT NULL'); const trabajos0 = sql('SELECT COUNT(*) FROM trabajos');
    r = await post(`/api/auditorias/${tAndaluz}/guardar-lista`, { nombre: 'SEREMI 18–47', nota: 'La frase sobre evaluación anestésica no apareció en el texto guardado: cotejar con el original.' });
    ok(r.status === 200 && r.d.requisitos === 30 && r.d.fuente.id === D.norma_id && sql('SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id IS NOT NULL') === llamadas0 && sql('SELECT COUNT(*) FROM trabajos') === trabajos0,
      `lista «SEREMI 18–47» guardada desde la auditoría terminada: ${r.d.requisitos} requisitos, sin llamadas a la IA ni trabajos nuevos`);
    ok((await post(`/api/auditorias/${tAndaluz}/guardar-lista`, { nombre: 'SEREMI 18–47' })).status === 409, 'no se guardan dos listas activas con el mismo nombre');
    // En OTRA conversación, ADA encuentra la auditoría y ofrece sus descargas (no la busca en Drive).
    const rv = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
      body: JSON.stringify({ mensaje: `[${Date.now()}-v] HERR ${JSON.stringify({ llamadas: [{ name: 'ver_auditoria', input: {} }, { name: 'ver_auditoria', input: { trabajo_id: tAndaluz } }, { name: 'listas_requisitos', input: {} }] })}`, tarjetas: ['auditoria_propuesta@1'] }) });
    const tv = await rv.text();
    ok(/auditorias_terminadas_de_otras_conversaciones/.test(tv) && /NO los busques en Drive/.test(tv) && tv.includes(`event: auditoria_trabajo\ndata: {"trabajo_id":"${tAndaluz}"}`), 'en otra conversación, ver_auditoria lista las auditorías terminadas y muestra la tarjeta con las descargas');
    ok(/Railway/.test(tv) && /carpeta-seremi/.test(tv) && /SEREMI 18–47/.test(tv), 'listas_requisitos informa la lista y también la carpeta de Andaluz como «configurada en Railway» (sin contradicciones)');
    r = { d: { id: (await api('/api/listas')).d[0].id } };
    const listaId = r.d.id;
    const llamadasAntes = Number(sql('SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id IS NOT NULL')); const trabajosAntes = sql("SELECT COUNT(*) FROM trabajos");
    let st0 = await ctl('/control/stats');

    // ---- 1. Pegar el enlace de una carpeta NO autorizada → tarjeta de autorización (no se lee nada) ----
    c = await chat({ carpeta: 'https://drive.google.com/drive/folders/carpeta-cliente2?usp=sharing', lista: 'seremi 18 al 47', motivo: 'Segunda auditoría SEREMI' });
    const pA = c.tarjeta;
    ok(pA && pA.tipo === 'autorizar_carpeta' && pA.carpeta.id === 'carpeta-cliente2' && pA.carpeta.nombre === 'Clinica_Dos_SEREMI' && pA.carpeta.propietario === 'Cliente Dos', `enlace pegado → tarjeta «Autorizar carpeta (solo lectura)» de «${pA && pA.carpeta.nombre}»`);
    let st = await ctl('/control/stats');
    ok(C2.every((f) => descargas(st, f.id) === 0) && JSON.stringify(st.export) === JSON.stringify(st0.export), 'antes de autorizar: ningún archivo de la carpeta nueva se abrió ni descargó');
    ok((await post(`/api/auditorias/propuestas/${pA.id}/aprobar`, { presupuesto: 9, origen: 'tarjeta_chat' })).status === 409, 'la tarjeta de carpeta no se puede «aprobar» como auditoría');
    r = await post(`/api/auditorias/propuestas/${pA.id}/autorizar-carpeta`, { expediente: 'Clínica Ficticia Dos', lista: listaId, password: 'equivocada' });
    ok(r.status === 400 && sql("SELECT COUNT(*) FROM carpetas_autorizadas") === '0', 'con una contraseña equivocada la carpeta NO se autoriza');

    // ---- 2. Autorizar con la contraseña → propuesta con inventario, lista guardada (sin extraer) y presupuesto ----
    r = await post(`/api/auditorias/propuestas/${pA.id}/autorizar-carpeta`, { expediente: 'Clínica Ficticia Dos', password: PASS }); // la lista viene del enlace pegado («seremi 18 al 47»)
    const p2 = r.d.propuesta;
    ok(r.status === 200 && r.d.carpeta.permiso === 'solo lectura' && p2 && p2.expediente === 'Clínica Ficticia Dos' && p2.carpeta.id === 'carpeta-cliente2', `carpeta autorizada (solo lectura) y propuesta del expediente «${p2 && p2.expediente}»`);
    ok(p2.lista.nombre === 'SEREMI 18–47' && p2.lista.fuente_estado === 'sin cambios' && p2.requisitos.length === 30 && p2.requisitos[0].id === '18' && p2.requisitos[29].id === '47' && Number(sql('SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id IS NOT NULL')) === llamadasAntes && sql('SELECT COUNT(*) FROM trabajos') === trabajosAntes,
      'usa la lista guardada: 30 requisitos 18–47, fuente sin cambios, SIN nueva extracción ni llamadas a la IA');
    ok(p2.lista.notas.some((x) => /evaluación anestésica/.test(x)), 'la observación pendiente (frase de evaluación anestésica) viaja con la lista');
    ok(p2.inventario.total === 17 && p2.subcarpetas === 1 && p2.inventario.por_estado['acceso directo (no se sigue)'] === 2 && p2.archivos.length === 15 && !p2.archivos.some((a) => /^A_|SREQ/.test(a.id)),
      `inventario solo de la carpeta nueva: ${JSON.stringify(p2.inventario.por_estado)} (accesos directos listados, no seguidos)`);
    st = await ctl('/control/stats');
    ok(C2.every((f) => descargas(st, f.id) === 0), 'tras autorizar: solo metadatos (inventario), ningún contenido descargado');
    ok(sql("SELECT estado FROM auditoria_propuestas WHERE id='" + pA.id + "'") === 'aprobada' && /solo lectura/.test(sql("SELECT expediente FROM carpetas_autorizadas WHERE id='carpeta-cliente2'")) === false && sql("SELECT expediente FROM carpetas_autorizadas WHERE id='carpeta-cliente2'") === 'Clínica Ficticia Dos',
      'queda registrada la carpeta con su expediente, sin tocar Railway');

    // ---- 3. Aislamiento directo en la capa de Drive (como lo usaría un paso de la auditoría) ----
    process.env.ADA_DRIVE_URL = 'http://localhost:9933'; process.env.DATABASE_URL = ENV.DATABASE_URL; process.env.ADA_CLAVE_DATOS = CLAVE; process.env.ADA_EXTRACCIONES = 'prueba'; process.env.ADA_DRIVE_CARPETAS_LECTURA = 'carpeta-seremi'; process.env.ADA_DRIVE_CARPETA_PRUEBA = 'carpeta-prueba';
    const Drive = require('../../src/drive'); await Drive.recargarCarpetas();
    const intento = async (id) => { try { await Drive.textoParaTrabajo(id, { trabajoId: null, pasoId: null, carpeta: 'carpeta-cliente2' }); return 'leído'; } catch (e) { return e.message; } };
    const a1 = await intento('A_NOMINA'); const a2 = await intento('C2_ATAJO'); const a3 = await intento('C2_LAVADO');
    ok(/no pertenece a la carpeta de este expediente/.test(a1), `con la carpeta del cliente 2, un archivo de Andaluz (también autorizado) se rechaza: «${a1}»`);
    ok(/acceso directo/.test(a2), `un acceso directo no se sigue: «${a2}»`);
    ok(a3 === 'leído', 'un archivo dentro de una subcarpeta del expediente sí se lee');
    const guardadaAntes = sql(`SELECT COUNT(*) FROM extracciones WHERE archivo_id='${D.norma_id}' AND estado='valida'`);
    const a4 = await intento(D.norma_id);
    ok(guardadaAntes === '1' && /no pertenece/.test(a4) && sql(`SELECT COUNT(*) FROM extracciones WHERE archivo_id='${D.norma_id}' AND estado='valida'`) === '1', 'el rechazo por aislamiento no borra lo guardado de la otra carpeta (la lista de requisitos de Andaluz sigue guardada)');

    // ---- 4. Aprobar → una auditoría que solo usa documentos de su carpeta ----
    st0 = await ctl('/control/stats');
    r = await post(`/api/auditorias/propuestas/${p2.id}/aprobar`, { presupuesto: p2.presupuesto_sugerido, configuracion: 'K1', origen: 'tarjeta_chat' });
    ok(r.status === 200, `auditoría aprobada (K1, tope US$${p2.presupuesto_sugerido})`);
    const a = await esperar(r.d.trabajo_id);
    ok(a.estado === 'completado' && a.expediente === 'Clínica Ficticia Dos', `auditoría: ${a.estado}; avance con expediente «${a.expediente}»`);
    const t = (await api(`/api/trabajos/${r.d.trabajo_id}?resultado=1`)).d;
    const filas = t.resultado.matriz.filas;
    const ids = new Set(C2.map((f) => f.id));
    ok(filas.length === 30 && filas.every((f) => (f.evidencias || []).every((e) => ids.has(e.archivo_id))), 'matriz de 30 requisitos; toda evidencia viene de archivos de la carpeta del cliente 2');
    st = await ctl('/control/stats');
    const andaluz = D.archivos.map((x) => x.id);
    ok(andaluz.every((id) => descargas(st, id) === descargas(st0, id)), 'durante la auditoría del cliente 2 no se leyó ningún archivo de Andaluz (ni el destino del acceso directo)');
    const f25 = filas.find((f) => f.requisito === '25'); const f18 = filas.find((f) => f.requisito === '18'); const f24 = filas.find((f) => f.requisito === '24');
    ok(f18.presentacion === 'listo' && f24.presentacion === 'no_aplica' && f25.presentacion === 'revisar' && /acceso directo/.test(f25.accion), `resultado propio: 18 listo (nómina), 24 no aplica (declaración con razón), 25 REQUIERE REVISIÓN por el acceso directo no seguido`);
    // ---- 5. Entregables con el expediente ----
    const e = await post('/api/descargas', { tipo: 'auditoria', id: r.d.trabajo_id });
    const w = await post('/api/descargas', { tipo: 'auditoria_informe', id: r.d.trabajo_id });
    ok(/^auditoria-clinica-ficticia-dos-/.test(e.d.nombre) && /^informe-auditoria-clinica-ficticia-dos-/.test(w.d.nombre), `archivos descargados con el expediente: ${e.d.nombre} · ${w.d.nombre}`);
    const ExcelJS = require('exceljs'); const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(Buffer.from(await (await fetch(`http://localhost:3200${e.d.url}`)).arrayBuffer()));
    const res = {}; libro.getWorksheet('Resumen').eachRow((row) => { res[String(row.getCell(1).value)] = String(row.getCell(2).value); });
    ok(res.Expediente === 'Clínica Ficticia Dos' && /Clinica_Dos_SEREMI \(id carpeta-cliente2\)/.test(res['Carpeta de origen']) && /SEREMI 18–47/.test(res['Lista de requisitos']), `Excel: Expediente «${res.Expediente}», carpeta «${res['Carpeta de origen']}», lista «${res['Lista de requisitos']}»`);
    const par = await require('../../src/archivos').textoDeWord(Buffer.from(await (await fetch(`http://localhost:3200${w.d.url}`)).arrayBuffer()));
    ok(par.some((x) => /Expediente: Clínica Ficticia Dos · Carpeta de origen: Clinica_Dos_SEREMI/.test(x)), 'Word: encabezado con expediente y carpeta de origen');

    // ---- 6. La fuente de la lista cambió → se avisa (no se usa a ciegas) ----
    await ctl('/control/cambiar', { id: D.norma_id, cambios: { version: 2, md5Checksum: 'sreq-v2' } });
    c = await chat({ carpeta: 'https://drive.google.com/drive/folders/carpeta-cliente2', lista: 'SEREMI 18–47' });
    ok(c.tarjeta && c.tarjeta.lista && /cambió/.test(c.tarjeta.lista.fuente_estado), `si el documento de origen cambió, la tarjeta lo advierte: «${c.tarjeta && c.tarjeta.lista.fuente_estado}»`);
    await post(`/api/auditorias/propuestas/${c.tarjeta.id}/descartar`);

    // ---- 7. Carpeta que supera el límite: se avisa antes, sin omitir archivos ----
    c = await chat({ carpeta: 'https://drive.google.com/drive/folders/carpeta-grande-x', lista: 'SEREMI 18–47' });
    r = await post(`/api/auditorias/propuestas/${c.tarjeta.id}/autorizar-carpeta`, { expediente: 'Grande', lista: listaId, password: PASS });
    ok(r.status === 400 && /160 documentos/.test(r.d.error) && /máximo por auditoría es 150/.test(r.d.error) && /No omití ninguno/.test(r.d.error), `límite: «${r.d.error}»`);

    // ---- 8. Revocar → ya no se puede leer, y volver a pegar el enlace pide autorizar de nuevo ----
    r = await post('/api/carpetas-autorizadas/carpeta-cliente2/revocar');
    const lista = (await api('/api/carpetas-autorizadas')).d;
    ok(r.status === 200 && lista.find((x) => x.id === 'carpeta-cliente2').estado === 'revocada', 'carpeta revocada desde ADA');
    c = await chat({ carpeta: 'https://drive.google.com/drive/folders/carpeta-cliente2', lista: 'SEREMI 18–47' });
    ok(c.tarjeta && c.tarjeta.tipo === 'autorizar_carpeta', 'tras revocar, pegar el enlace vuelve a pedir autorización');
    await Drive.recargarCarpetas();
    ok(/no pertenece a la carpeta/.test(await intento('C2_LAVADO')), 'tras revocar, ni siquiera un archivo de esa carpeta se puede leer');
    ok(!(await (async () => { try { await Drive.inventarioCarpeta('carpeta-cliente2'); return true; } catch (_) { return false; } })()), 'tras revocar, tampoco se puede inventariar');
    // ---- 9. Nunca se escribió en ninguna carpeta ----
    st = await ctl('/control/stats');
    ok(!Object.keys(st.escrituras || {}).length && Object.keys(st.copias_en || {}).every((k) => k === 'root'), `ninguna escritura en las carpetas; copias temporales solo fuera (${JSON.stringify(st.copias_en)})`);
  } catch (err) { ok(false, `excepción: ${err.stack}`); console.log(srv.log.slice(-3000)); }
  try { srv.kill(); } catch (_) {}
  drive.kill();
  setTimeout(() => process.exit(), 300);
})();
