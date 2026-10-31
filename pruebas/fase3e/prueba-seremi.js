// Fase 3e a escala (simulada): carpeta ficticia de 98 archivos con subcarpetas, requisitos 18–47 de una lista de 47,
// perfil SEREMI, lotes internos de 20 en UNA sola auditoría, inventario completo, protección de datos y solo lectura.
const { spawn, execSync } = require('child_process');
const S = __dirname;
const D = require('../datos-ficticios/prueba-seremi.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql --default-character-set=utf8mb4 -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString().trim();
const CLAVE = 'seremi-clave-fija-0123456789-abcdefghijklmnopqrs';
process.env.ADA_CLAVE_DATOS = CLAVE; process.env.ANTHROPIC_API_KEY = 'x';
const Cifrado = require('../../src/cifrado');
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk;
async function arrancar() {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago', ADA_CLAVE_DATOS: CLAVE,
      ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_DRIVE_CARPETAS_LECTURA: 'carpeta-seremi',
      ADA_TRABAJO_LEASE_MS: '3000', ADA_TRABAJO_CICLO_MS: '150', ADA_TURNOS_2MIN: '100', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-seremi.json'), FAKE_H_EXTRACCION_OMITIR: '32,47' } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const post = (ruta, b) => api(ruta, { method: 'POST', body: JSON.stringify(b || {}) });
async function chat(input) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: JSON.stringify({ mensaje: `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input }] })}`, tarjetas: ['auditoria_propuesta@1'] }) });
  const t = await r.text();
  const eventos = t.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { tipo: e.slice(7), d: JSON.parse(d.slice(6)) }; });
  const fin = eventos.find((e) => e.tipo === 'fin');
  const m = (fin ? fin.d.respuesta : '').match(/DATOS=(.*)$/s);
  const ev = eventos.filter((e) => e.tipo === 'auditoria_propuesta').map((e) => e.d);
  return { tarjeta: ev[0], datos: m ? JSON.parse(m[1]) : null };
}
const esperar = async (id, cada) => { for (let i = 0; i < 1500; i++) { const a = (await api(`/api/auditorias/${id}/avance`)).d; if (cada) cada(a); if (['completado', 'bloqueado', 'cancelado', 'pausado_presupuesto'].includes(a.estado)) return a; await dormir(150); } return null; };
const descargas = (st, id) => (st.export[id] || 0) + ((st.media || {})[id] || 0);

(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM auditoria_propuestas');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await ctl('/control/archivos', { archivos: [{ id: 'carpeta-seremi', name: 'Andaluz_SEREMI_para_subir (ficticia)', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { id: 'carpeta-otra', name: 'Otra carpeta', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { id: 'FUERA1', name: 'Documento fuera.pdf', mimeType: 'application/pdf', texto: 'Fuera de la carpeta.', md5Checksum: 'f1', version: 1, parents: ['carpeta-otra'] },
    ...D.carpetas, ...D.archivos] });
  await arrancar();
  const resumen = {};
  try {
    // ---- 1. Propuesta: inventario de 98 archivos (sin descargar nada salvo la lista de requisitos) ----
    let c = await chat({ norma_id: D.norma_id, carpeta_id: 'carpeta-seremi', rango: { desde: 18, hasta: 47 }, perfil: 'seremi', motivo: 'Requisitos 18 al 47 para la SEREMI' });
    const pA = c.tarjeta;
    const inv = pA && pA.inventario;
    console.log('   inventario:', JSON.stringify(inv), '· subcarpetas', pA && pA.subcarpetas);
    ok(inv && inv.total === 98 && pA.subcarpetas === 3, 'inventario de los 98 archivos, incluidas 3 subcarpetas');
    ok(inv.por_estado['fuente de requisitos'] === 1 && inv.por_estado['duplicado exacto'] === 2 && inv.por_estado['no legible (formato)'] === 3 && inv.por_estado['excluido: posible dato sensible'] === 6 && inv.por_estado.incluido === 86,
      'estados: 1 fuente, 2 duplicados exactos, 3 no legibles, 6 con posible dato sensible, 86 a auditar (Traslado de pacientes incluido)');
    ok(pA.sensibles.map((a) => a.nombre).sort().join(' | ') === '33_Registro_pacientes_ENO.pdf | 41_Listado_pacientes_curaciones.pdf | CI_consentimiento_botox.pdf | Cedula_identidad_director_tecnico.pdf | Certificados_SIS_personal.pdf | Ficha_clinica_paciente_ejemplo.pdf' && !pA.sensibles.some((a) => /Traslado/.test(a.nombre)), `sensibles listados: ${pA.sensibles.map((a) => a.nombre).join(', ')}`);
    ok(pA.versiones.some((a) => /Manual_normas_procedimientos_v1/.test(a.nombre)) && pA.versiones.some((a) => /v2_final/.test(a.nombre) && /más reciente/.test(a.detalle)), 'detecta las dos versiones del Manual y cuál es la más reciente');
    ok(pA.duplicados.every((a) => /mismo contenido que/.test(a.detalle)), `duplicados: ${pA.duplicados.map((a) => `${a.nombre} (${a.detalle})`).join('; ')}`);
    let st = await ctl('/control/stats');
    ok(D.archivos.filter((a) => a.id !== D.norma_id).every((a) => descargas(st, a.id) === 0), 'antes de aprobar: ningún documento de la carpeta se descargó (solo la lista de requisitos)');
    c = await chat({ norma_id: D.norma_id, carpeta_id: 'carpeta-otra', rango: { desde: 18, hasta: 47 }, perfil: 'seremi' });
    ok(!c.tarjeta && /no es una carpeta autorizada/.test(JSON.stringify(c.datos)), 'otra carpeta de Drive: rechazada (solo la carpeta autorizada)');
    const fuera = (await post('/api/extracciones/cierre/leer', { archivo_id: 'FUERA1' })).d;
    ok(fuera.resultado === 'fuera de la carpeta de prueba', 'un archivo fuera de las carpetas autorizadas no se lee');

    // ---- 2. Extracción de requisitos → lista 18–47 con su numeración original ----
    let r = await post(`/api/auditorias/propuestas/${pA.id}/aprobar`, { presupuesto: pA.presupuesto_sugerido, origen: 'tarjeta_chat' });
    let a = await esperar(r.d.trabajo_id);
    let pB = (await api('/api/auditorias/propuestas')).d.find((x) => a.lista_propuesta && x.id === a.lista_propuesta.propuesta_id);
    const r24 = pB.requisitos.find((x) => x.id === '24'); const r38 = pB.requisitos.find((x) => x.id === '38');
    ok(/^a\) Si se usan gases.*; b\) Si se usan gases/.test(r24.texto) && /a\) .*; b\) .*; c\) .*; d\) /.test(r38.texto) && pB.subapartados.join(' · ') === '24 (24a, 24b) · 34 (34a, 34b) · 35 (35a, 35b) · 38 (38a, 38b, 38c, 38d)',
      `subapartados dentro de su requisito: ${pB.subapartados.join(' · ')}`);
    ok(pB.recuperados.join(',') === '32,47' && pB.faltantes.length === 0 && /copiado literalmente de la norma/.test(pB.requisitos.find((x) => x.id === '47').fuente) && pB.requisitos.find((x) => x.id === '47').texto === 'MANUAL DE BIOSEGURIDAD Contar con un manual de bioseguridad del establecimiento.' && pB.requisitos.find((x) => x.id === '32').texto === 'CONSENTIMIENTO INFORMADO Contar con un consentimiento informado tipo para cada procedimiento.' && pB.recuperados_detalle.find((x) => x.numero === 32).termina_antes_de === 33,
      `32 y 47 (que la IA no separó) tomados literalmente del texto de la norma, sin inventar: «${pB.requisitos.find((x) => x.id === '32').texto}»`);
    console.log('   presupuesto mínimo K1 con 30 filas agrupadas:', pB.presupuesto_minimo.K1, '· sugerido', pB.presupuesto_sugerido);
    // ---- 2b. Una tarjeta hecha con la versión anterior (34 filas, faltan 32 y 47) se corrige sin volver a pagar ----
    const fila0 = sql(`SELECT datos_cifrado FROM auditoria_propuestas WHERE id='${pB.id}'`);
    const viejo = Cifrado.descifrarJSON(fila0);
    viejo.requisitos = viejo.requisitos.filter((x) => !['32', '47'].includes(x.id)).flatMap((x) => (x.subapartados ? x.subapartados.map((y) => ({ id: y.id, texto: y.texto, fuente: y.fuente })) : [x]));
    viejo.faltantes = [32, 47]; delete viejo.recuperados; delete viejo.subapartados;
    sql(`UPDATE auditoria_propuestas SET datos_cifrado='${Cifrado.cifrarJSON(viejo)}' WHERE id='${pB.id}'`);
    const viejaCard = (await api('/api/auditorias/propuestas')).d.find((x) => x.id === pB.id);
    ok(viejaCard.requisitos.length === 34 && !viejaCard.agrupada, `tarjeta con el formato anterior: ${viejaCard.requisitos.length} filas, faltan 32 y 47 (como en la carpeta real)`);
    const intento = await post(`/api/auditorias/propuestas/${pB.id}/aprobar`, { presupuesto: 9, configuracion: 'K1', origen: 'tarjeta_chat' });
    ok(intento.status === 409 && /Primero corrige la lista/.test(intento.d.error) && sql(`SELECT estado FROM auditoria_propuestas WHERE id='${pB.id}'`) === 'pendiente', 'el servidor no permite aprobar una lista sin corregir, aunque el presupuesto alcance');
    const llamadasExtr = sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${r.d.trabajo_id}'`);
    const stAntes = await ctl('/control/stats');
    const rh = await post(`/api/auditorias/propuestas/${pB.id}/rehacer-lista`);
    const stDespues = await ctl('/control/stats');
    ok(descargas(stDespues, 'SREQ') === descargas(stAntes, 'SREQ') && JSON.stringify(stDespues.export) === JSON.stringify(stAntes.export), 'corregir la lista no descarga nada de Drive (usa el texto ya guardado de la norma)');
    ok(rh.status === 200 && rh.d.nueva.requisitos.length === 30 && rh.d.nueva.agrupada && rh.d.llamadas_ia_nuevas === 0 && sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${r.d.trabajo_id}'`) === llamadasExtr && sql(`SELECT estado FROM auditoria_propuestas WHERE id='${pB.id}'`) === 'descartada',
      `«Corregir la lista»: 30 filas, sin llamadas nuevas a la IA ni costo; la tarjeta anterior queda reemplazada`);
    pB = rh.d.nueva;
    ok(pB && pB.requisitos.map((x) => x.id).join(',') === Array.from({ length: 30 }, (_, i) => String(i + 18)).join(','), `lista: ${pB && pB.requisitos.length} requisitos con sus números originales 18…47`);
    ok(pB.perfil === 'seremi' && pB.faltantes.length === 0 && pB.lotes === 5 && pB.inventario.total === 98, `la tarjeta 2 conserva perfil SEREMI, inventario y lotes (${pB.lotes} lotes de hasta 20)`);

    // ---- 3. Aprobación incluyendo UN archivo sensible (con RUT ficticio) → una sola auditoría en lotes ----
    r = await post(`/api/auditorias/propuestas/${pB.id}/aprobar`, { presupuesto: pB.presupuesto_sugerido, configuracion: 'K1', origen: 'tarjeta_chat', incluir_ids: ['C_SIS'] });
    ok(r.status === 200, `auditoría aprobada (K1, tope US$${pB.presupuesto_sugerido}), incluyendo «Certificados_SIS_personal.pdf» por decisión expresa`);
    const tB = r.d.trabajo_id;
    const visto = new Set();
    for (let i = 0; i < 1500; i++) { const x = (await api(`/api/auditorias/${tB}/avance`)).d; visto.add(`${x.lotes_hechos}/${x.lotes_total}`); if (x.lotes_hechos >= 2 || x.estado !== 'ejecutando') break; await dormir(100); }
    srv.kill('SIGKILL'); await dormir(800); await arrancar(); const cortado = true; // corte del servidor a mitad de los lotes
    a = await esperar(tB, (x) => { visto.add(`${x.lotes_hechos}/${x.lotes_total}`); });
    ok(a.estado === 'completado', `auditoría: ${a.estado}${a.motivo ? ` (${a.motivo})` : ''}; lotes ${[...visto].join(' → ')}`);
    const t = (await api(`/api/trabajos/${tB}?resultado=1`)).d;
    const filas = t.resultado.matriz.filas;
    const pasos = t.detalle_pasos;
    const nExtraer = pasos.filter((p) => p.tipo === 'aud_extraer').length; const nLotes = pasos.filter((p) => p.tipo === 'aud_seleccionar_lote').length;
    ok(Number(sql(`SELECT COUNT(*) FROM trabajos WHERE tipo='auditoria' AND creado_en >= (SELECT creado_en FROM trabajos WHERE id='${tB}')`)) === 1 && nExtraer === 87 && nLotes === 5 && pasos.some((p) => p.clave === 'seleccionar'),
      `UNA sola auditoría: 87 archivos leídos en 5 lotes internos y una consolidación (${pasos.length} pasos)`);

    // ---- 4. Matriz única 18–47 con clasificación SEREMI ----
    ok(filas.map((f) => f.requisito).join(',') === Array.from({ length: 30 }, (_, i) => String(i + 18)).join(','), 'matriz única con los 30 requisitos, números originales 18 al 47, sin omitir ni duplicar');
    const det = D.resultado_correcto.map((x) => { const f = filas.find((y) => y.requisito === x.id); return { id: x.id, esperado: x.presentacion, obtenido: f && f.presentacion, ok: f && f.presentacion === x.presentacion }; });
    resumen.precision = `${det.filter((x) => x.ok).length}/30`;
    ok(det.every((x) => x.ok), `clasificación SEREMI ${resumen.precision}${det.some((x) => !x.ok) ? ` (fallan: ${det.filter((x) => !x.ok).map((x) => `${x.id} ${x.obtenido}≠${x.esperado}`).join(', ')})` : ''}`);
    const conteo = filas.reduce((m, f) => { m[f.clasificacion] = (m[f.clasificacion] || 0) + 1; return m; }, {});
    console.log('   clasificación:', JSON.stringify(conteo));
    ok(filas.every((f) => f.accion && /[.!?…)»"”]$/.test(f.accion) && f.justificacion), 'cada requisito con observación y acción concreta completa');
    ok(filas.filter((f) => f.presentacion === 'listo').every((f) => f.evidencias.length && f.evidencias.every((e) => e.verificada && e.archivo && e.ubicacion && e.cita)), 'LISTO PARA SUBIR solo con archivo, cita verificada y ubicación');
    const loteDe = (id) => ((pasos.find((p) => p.clave === `extraer:${id}`) || {}).etapa || '');
    const f20 = filas.find((f) => f.requisito === '20');
    const lotes20 = [...new Set(f20.evidencias.map((e) => loteDe(e.archivo_id)))];
    ok(f20.presentacion === 'listo' && lotes20.length === 2, `requisito 20 acreditado con documentos de lotes distintos (${lotes20.join(' y ')})`);
    ok(filas.find((f) => f.requisito === '35').presentacion === 'revisar' && /Plano_evacuacion_piso_1\.jpg/.test(filas.find((f) => f.requisito === '35').accion), '35: el plano está solo en imagen → REQUIERE REVISIÓN, nombrando el archivo (no “no encontrado”)');
    ok(filas.find((f) => f.requisito === '37').presentacion === 'revisar' && /escaneado/.test(filas.find((f) => f.requisito === '37').accion), '37: el certificado está escaneado sin texto → REQUIERE REVISIÓN');
    const fila = (id) => filas.find((f) => f.requisito === id);
    ok(fila('31').presentacion === 'revisar' && /versión válida/.test(fila('31').accion) && /Manual_normas_procedimientos_v1\.pdf/.test(fila('31').accion), `31: dos versiones del manual → REQUIERE REVISIÓN, sin asumir que la más reciente es la válida («${fila('31').accion}»)`);
    ok(fila('32').presentacion === 'revisar' && /CI_consentimiento_botox\.pdf/.test(fila('32').accion) && fila('34').presentacion === 'revisar' && /Cedula_identidad_director_tecnico\.pdf/.test(fila('34').accion),
      '32 y 34: la evidencia podría estar en archivos sensibles no analizados → REQUIERE REVISIÓN nombrándolos, no NO ENCONTRADO');
    ok(fila('26').presentacion === 'revisar' && /firma/.test(fila('26').accion) && fila('46').presentacion === 'revisar' && /completo/.test(fila('46').accion), '26 (firma) y 46 (la IA dejó algo por comprobar): REQUIERE REVISIÓN con qué comprobar');
    ok(fila('20').presentacion === 'listo' && fila('43').presentacion === 'listo', '20 (vigencia con fecha citada) y 43 (archivo SIS incluido por ti): LISTO PARA SUBIR');
    ok(fila('33').presentacion === 'revisar' && /33_Registro_pacientes_ENO\.pdf/.test(fila('33').accion), '33: un archivo omitido lleva su número → REQUIERE REVISIÓN, no NO ENCONTRADO');
    ok(fila('41').presentacion === 'revisar' && /41_Listado_pacientes_curaciones\.pdf/.test(fila('41').accion) && /Reponer el botiquín/i.test(fila('41').accion), '41: lo leído diría HAY QUE MODIFICAR, pero hay un archivo omitido con su número → REQUIERE REVISIÓN (con la corrección como siguiente paso)');
    ok(fila('38').presentacion === 'modificar' && /subapartados b, c y d/.test(fila('38').accion) && /a\) .*d\) /.test(fila('38').texto_requisito), '38: una sola fila con sus 4 subapartados; la acción dice cuáles faltan');
    const av = (await api(`/api/auditorias/${tB}/avance`)).d;
    ok(av.resumen_seremi && av.resumen_seremi.listo.join(',') === '18,19,20,22,25,27,39,40,42,43,47' && av.resumen_seremi.no_encontrado.join(',') === '23,36,44', `respuesta sencilla: ${Object.entries(av.resumen_seremi || {}).map(([k, v]) => `${k} ${v.join(',')}`).join(' · ')}`);

    // ---- 5. Descargas, solo lectura y datos personales ----
    st = await ctl('/control/stats');
    const incluidos = D.archivos.filter((x) => !['SREQ', 'S_ENO', 'S_BOT', 'S_CEDULA', 'S_FICHA', 'S_CI', 'IMG_PLANO', 'IMG_LOGO', 'ZIP_FOTOS', 'DUP_LAVADO', 'DUP_RECLAMOS'].includes(x.id));
    ok(incluidos.every((x) => descargas(st, x.id) === 1), `los 87 archivos auditados se descargaron una sola vez cada uno${cortado ? ', incluso con el corte del servidor' : ''} ${incluidos.filter((x) => descargas(st, x.id) !== 1).map((x) => `${x.id}=${descargas(st, x.id)}`).join(' ')}`);
    ok(['S_ENO', 'S_BOT', 'S_CEDULA', 'S_FICHA', 'S_CI', 'IMG_PLANO', 'IMG_LOGO', 'ZIP_FOTOS', 'DUP_LAVADO', 'DUP_RECLAMOS'].every((id) => descargas(st, id) === 0), `cédula, ficha, consentimiento, imágenes y duplicados: nunca se descargaron ${['S_ENO', 'S_BOT', 'S_CEDULA', 'S_FICHA', 'S_CI', 'IMG_PLANO', 'IMG_LOGO', 'ZIP_FOTOS', 'DUP_LAVADO', 'DUP_RECLAMOS'].map((id) => `${id}=${descargas(st, id)}`).join(' ')}`);
    ok(!Object.keys(st.escrituras).length && Object.keys(st.copias_en || {}).every((k) => k === 'root'), `ninguna escritura en la carpeta; copias temporales solo fuera de ella (${JSON.stringify(st.copias_en)}) y borradas`);
    ok(!(st.vivos || []).length, 'no queda ninguna copia temporal');
    const guardado = sql(`SELECT resultado_cifrado FROM trabajo_pasos WHERE trabajo_id='${tB}' AND resultado_cifrado IS NOT NULL`).split('\n').filter(Boolean).map((x) => JSON.stringify(Cifrado.descifrarJSON(x))).join('\n');
    ok(!guardado.includes('9.876.543-2') && /\[RUT\]/.test(guardado), 'el RUT del archivo sensible incluido no llega a la selección, la matriz ni los entregables ([RUT])');

    // ---- 6. Entregables ----
    const e = await post('/api/descargas', { tipo: 'auditoria', id: tB });
    const ExcelJS = require('exceljs'); const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(Buffer.from(await (await fetch(`http://localhost:3200${e.d.url}`)).arrayBuffer()));
    const hojas = libro.worksheets.map((w) => w.name).join(',');
    const encab = []; libro.getWorksheet('Matriz').getRow(1).eachCell((x) => encab.push(String(x.value)));
    const inventario = []; libro.getWorksheet('Inventario').eachRow((row, n) => { if (n > 1) inventario.push({ nombre: String(row.getCell(2).value), categoria: String(row.getCell(4).value), estado: String(row.getCell(5).value), rel: String(row.getCell(7).value || '') }); });
    const cat = inventario.reduce((m, x) => { m[x.categoria] = (m[x.categoria] || 0) + 1; return m; }, {});
    ok(cat['Fuente de requisitos'] === 1 && cat.Auditado === 86 && cat['Omitido (justificado)'] === 11, `inventario por categoría: ${JSON.stringify(cat)} (87 leídos: 86 incluidos + 1 sensible que incluiste; el escaneo sin texto queda omitido)`);
    const invDe = (n) => inventario.find((x) => x.nombre === n) || {};
    ok(/revisar a mano para [\d, ]*35/.test(invDe('Plano_evacuacion_piso_1.jpg').rel) && /revisar a mano para [\d, ]*34/.test(invDe('Cedula_identidad_director_tecnico.pdf').rel) && /evidencia en 20/.test(invDe('Z_Certificado_RCP_Carla_Soto.pdf').rel) && invDe('Certificados_SIS_personal.pdf').estado === 'auditado por tu decisión (posible dato sensible)',
      `cada archivo omitido dice para qué requisito revisarlo; cada auditado, en qué requisito aporta evidencia ${JSON.stringify(['Plano_evacuacion_piso_1.jpg', 'Cedula_identidad_director_tecnico.pdf', 'Z_Certificado_RCP_Carla_Soto.pdf', 'Certificados_SIS_personal.pdf'].map((n) => [invDe(n).rel, invDe(n).estado]))}`);
    ok(hojas === 'Matriz,Evidencias,Resumen,Inventario' && encab.slice(0, 8).join(' | ') === 'Requisito | Texto del requisito | Clasificación SEREMI | Archivo | Cita principal | Ubicación | Justificación | Acción concreta', `Excel: ${hojas}; columnas ${encab.slice(0, 8).join(' | ')}`);
    ok(inventario.length === 98 && inventario.find((x) => /escaneado/.test(x.nombre)).estado === 'omitido: sin texto (¿escaneado?)',
      `hoja Inventario con los 98 archivos y el estado final de cada uno (${inventario.length} filas; ${JSON.stringify(inventario.reduce((m, x) => { m[x.estado] = (m[x.estado] || 0) + 1; return m; }, {}))})`);
    const w = await post('/api/descargas', { tipo: 'auditoria_informe', id: tB });
    const par = await require('../../src/archivos').textoDeWord(Buffer.from(await (await fetch(`http://localhost:3200${w.d.url}`)).arrayBuffer()));
    ok(par.includes('21 — HAY QUE MODIFICAR') && par.includes('23 — NO ENCONTRADO') && par.includes('30 — REQUIERE REVISIÓN') && par.some((x) => /^21 \(prioridad alta\): Agregar al programa/.test(x)), 'informe Word: hallazgos por clasificación y acciones concretas');
    const pagado = Number(sql(`SELECT COALESCE(SUM(costo_usd),0) FROM llamadas_ia WHERE trabajo_id='${tB}'`));
    ok(Math.abs(t.gastado_usd - pagado) < 1e-6 && t.resultado.costos.real_usd <= t.presupuesto_usd, `costo real US$${t.resultado.costos.real_usd.toFixed(4)} de US$${t.presupuesto_usd} (${t.resultado.costos.llamadas} llamadas; el informe no usa otra llamada)`);
    resumen.costo = t.resultado.costos.real_usd; resumen.tope = t.presupuesto_usd;
    // ---- 7. Borrar los textos de ESTA auditoría (después de descargar), sin tocar otras extracciones ----
    sql(`INSERT INTO extracciones (usuario_id, archivo_id, version, nombre, caracteres, texto_cifrado, estado, extraido_en, vence_en) VALUES (1, 'OTRO-DOC', 'v1', 'Otro documento guardado.pdf', 10, NULL, 'valida', NOW(), NOW() + INTERVAL 30 DAY)`);
    const antes = Number(sql("SELECT COUNT(*) FROM extracciones WHERE archivo_id <> 'OTRO-DOC'"));
    ok((await api(`/api/auditorias/${tB}/avance`)).d.textos_guardados === antes && antes >= 88, `antes de borrar: ${antes} textos guardados (cifrados) de esta auditoría`);
    const cifrados = sql("SELECT COUNT(*) FROM extracciones WHERE archivo_id <> 'OTRO-DOC' AND texto_cifrado LIKE 'v%:%'");
    ok(Number(cifrados) === antes && !sql("SELECT texto_cifrado FROM extracciones WHERE archivo_id = 'C_SIS'").includes('Superintendencia'), 'los textos completos guardados están cifrados (ninguno legible en la base)');
    const b = (await post(`/api/auditorias/${tB}/borrar-extracciones`)).d;
    ok(b.extracciones_borradas === antes && sql("SELECT COUNT(*) FROM extracciones WHERE archivo_id <> 'OTRO-DOC'") === '0' && sql("SELECT COUNT(*) FROM extracciones WHERE archivo_id = 'OTRO-DOC'") === '1',
      `borrado específico: ${b.extracciones_borradas} textos de esta auditoría eliminados; la otra extracción guardada sigue intacta`);
    const frags = sql(`SELECT resultado_cifrado FROM trabajo_pasos WHERE trabajo_id='${tB}' AND tipo IN ('aud_seleccionar_lote','aud_seleccionar')`).split('\n').filter(Boolean).map((x) => Cifrado.descifrarJSON(x));
    ok(frags.length === 6 && frags.every((r) => r.textos_borrados && r.fragmentos.every((f) => f.texto === '')), `también se vaciaron ${b.fragmentos_vaciados} fragmentos de texto guardados en los pasos`);
    const e2 = await post('/api/descargas', { tipo: 'auditoria', id: tB }); const w2 = await post('/api/descargas', { tipo: 'auditoria_informe', id: tB });
    ok(e2.status === 200 && w2.status === 200 && (await fetch(`http://localhost:3200${e2.d.url}`)).status === 200 && (await api(`/api/auditorias/${tB}/avance`)).d.textos_guardados === 0, 'después de borrar, el Excel y el informe siguen descargables; la tarjeta indica 0 textos guardados');
    sql("DELETE FROM extracciones WHERE archivo_id = 'OTRO-DOC'");
    const k = (await api(`/api/auditorias/propuestas/${pB.id.slice(0, 8)}/constancia`)).d;
    ok(k.resultado === 'correcto' && k.aprobacion && (k.aprobacion.origen.via === 'tarjeta_chat'), `constancia de la aprobación: ${k.resultado}`);
  } catch (err) { ok(false, `excepción: ${err.stack}`); console.log(srv.log.slice(-4000)); }
  console.log('RESUMEN', JSON.stringify(resumen));
  try { srv.kill(); } catch (_) {}
  drive.kill();
  setTimeout(() => process.exit(), 300);
})();
