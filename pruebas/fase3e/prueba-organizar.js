// Organizar expediente (simulado): pego dos enlaces (requisitos y documentos) → autorizo ambas carpetas solo lectura →
// extracción de los 22 requisitos del PDF ubicado por su nombre → auditoría → PLAN DE COPIAS → apruebo con contraseña →
// carpeta nueva con copias numeradas, Excel (22 filas, con enlaces) y Word, ambos también en la carpeta. Originales
// intactos, escritura solo en la carpeta de resultados, sensibles con aprobación, y sin duplicados tras un corte.
const { spawn, execSync } = require('child_process');
const S = __dirname;
const D = require('../datos-ficticios/prueba-botiquin.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql --default-character-set=utf8mb4 -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString().trim();
const CLAVE = 'organizar-clave-fija-0123456789-abcdefghijklmnop';
const PASS = 'clave-organizar-ADA';
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
const NOMBRE = 'ADA — Botiquín Andaluz — Documentos organizados';
let srv; let tk;
const ENV = { PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: PASS, ADA_AVISOS: 'no', TZ: 'America/Santiago', ADA_CLAVE_DATOS: CLAVE,
  ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_DRIVE_CARPETAS_LECTURA: '', ADA_TRABAJO_LEASE_MS: '3000',
  ADA_TRABAJO_CICLO_MS: '150', ADA_TURNOS_2MIN: '200', ADA_TOPE_DIARIO: '1000', FAKE_H: require.resolve('../datos-ficticios/prueba-botiquin.json'), FAKE_H_EXTRACCION_OMITIR: '16' };
async function arrancar() {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ENV } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: PASS }) })).json()).token;
}
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const post = (ruta, b) => api(ruta, { method: 'POST', body: JSON.stringify(b || {}) });
async function chat(input) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: JSON.stringify({ mensaje: `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input }] })}`, tarjetas: ['auditoria_propuesta@1'] }) });
  const t = await r.text();
  const ev = t.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { tipo: e.slice(7), d: JSON.parse(d.slice(6)) }; });
  const fin = ev.find((e) => e.tipo === 'fin'); const m = (fin ? fin.d.respuesta : '').match(/DATOS=(.*)$/s);
  return { tarjeta: (ev.find((e) => e.tipo === 'auditoria_propuesta') || {}).d, datos: m ? JSON.parse(m[1]) : null };
}
const esperar = async (id, hasta = ['completado', 'bloqueado', 'cancelado', 'pausado_presupuesto']) => { for (let i = 0; i < 1500; i++) { const a = (await api(`/api/auditorias/${id}/avance`)).d; if (hasta.includes(a.estado)) return a; await dormir(150); } return null; };

(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM auditoria_propuestas');
  try { sql('DELETE FROM carpetas_autorizadas'); } catch (_) {}
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await ctl('/control/archivos', { archivos: [...D.carpetas, ...D.archivos] });
  await arrancar();
  const docs = D.archivos.filter((a) => a.parents[0] !== 'carpeta-botreq');
  try {
    // ---- Aprobación 1: pego los dos enlaces → una tarjeta para autorizar AMBAS carpetas (solo lectura) ----
    let c = await chat({ carpeta: 'https://drive.google.com/drive/folders/carpeta-botdocs?usp=drive_link', carpeta_requisitos: 'https://drive.google.com/drive/folders/carpeta-botreq?usp=drive_link',
      documento_requisitos: '00.Botiquín Andaluz — requisitos y documentos.pdf', rango: { desde: 1, hasta: 22 }, perfil: 'expediente', organizar: { nombre: NOMBRE }, motivo: 'Autorización de botiquín' });
    const pA = c.tarjeta;
    ok(pA && pA.tipo === 'autorizar_carpeta' && pA.carpetas.length === 2 && pA.carpetas.map((x) => x.rol).sort().join() === 'documentos,requisitos' && pA.organizar && pA.documento_requisitos, 'una tarjeta autoriza las dos carpetas (documentos y requisitos), con el plan de organizar');
    let st = await ctl('/control/stats');
    ok(!Object.keys(st.export).length && !Object.keys(st.escrituras || {}).length, 'antes de autorizar: nada leído ni escrito');
    let r = await post(`/api/auditorias/propuestas/${pA.id}/autorizar-carpeta`, { expediente: 'Botiquín Andaluz (ficticio)', password: PASS });
    const pX = r.d.propuesta;
    ok(r.status === 200 && r.d.carpetas.length === 2 && pX && pX.tipo === 'extraer_requisitos' && pX.norma.nombre === '00.Botiquín Andaluz — requisitos y documentos.pdf',
      `ambas carpetas autorizadas solo lectura; ADA ubicó por su nombre «${pX && pX.norma.nombre}» y propone extraerlo`);
    ok(pX.inventario.total === 46 && pX.inventario.por_estado['excluido: posible dato sensible'] === 1 && pX.inventario.por_estado['duplicado exacto'] === 1, `inventario de los 46 documentos: ${JSON.stringify(pX.inventario.por_estado)}`);
    // ---- Aprobación 2: extracción → 22 requisitos desde la tabla del PDF (página 3 fuera) ----
    r = await post(`/api/auditorias/propuestas/${pX.id}/aprobar`, { presupuesto: pX.presupuesto_sugerido, origen: 'tarjeta_chat' });
    const ext = await esperar(r.d.trabajo_id);
    if (!ext.lista_propuesta) console.log('   extraccion:', JSON.stringify(ext).slice(0, 600));
    let pL = (await api('/api/auditorias/propuestas')).d.find((x) => x.id === ext.lista_propuesta.propuesta_id);
    const txtL = JSON.stringify(pL);
    ok(pL.requisitos.map((x) => x.id).join() === Array.from({ length: 22 }, (_, i) => String(i + 1)).join() && pL.tabla && pL.tabla.filas === 22 && /Procedimientos de recepción/.test(pL.requisitos[8].texto)
      && pL.requisitos[1].estado_declarado === 'Listo' && pL.requisitos[5].estado_declarado === 'No aplica' && /Copias/.test(pL.requisitos[11].texto) && pL.perfil === 'expediente'
      && !/12\.345\.678|juan\.perez|1234 5678|Firmar la solicitud/.test(txtL),
      `lista desde la tabla: 22 de 22 (páginas ${pL.tabla && pL.tabla.paginas}), columnas y estado de referencia por fila, el «2» suelto no es requisito y la página 3 queda fuera sin datos personales`);
    // «Corregir la lista (sin costo)» sobre la tabla: texto ya guardado, sin descargas ni llamadas a la IA
    const stA = await ctl('/control/stats'); const llamA = sql('SELECT COUNT(*) FROM llamadas_ia');
    const rh = await post(`/api/auditorias/propuestas/${pL.id}/rehacer-lista`);
    const stB = await ctl('/control/stats');
    ok(rh.status === 200 && rh.d.nueva.requisitos.length === 22 && rh.d.nueva.tabla && rh.d.nueva.tabla.filas === 22 && rh.d.llamadas_ia_nuevas === 0 && sql('SELECT COUNT(*) FROM llamadas_ia') === llamA
      && JSON.stringify(stA.export) === JSON.stringify(stB.export) && rh.d.nueva.requisitos[3].texto.includes('responsable del botiquín'),
      `«Corregir la lista»: 22 de 22 desde la tabla, sin llamadas a la IA ni descargas (${rh.status} ${rh.d.error || ''})`);
    if (rh.status === 200) pL = rh.d.nueva;
    // ---- Aprobación 3: auditoría (incluyo el RUT, sensible, para leerlo) ----
    r = await post(`/api/auditorias/propuestas/${pL.id}/aprobar`, { presupuesto: pL.presupuesto_sugerido, configuracion: 'K1', origen: 'tarjeta_chat', incluir_ids: ['D_RUT'] });
    const tAud = r.d.trabajo_id;
    const aud = await esperar(tAud);
    ok(aud.estado === 'completado' && aud.organizar, `auditoría ${aud.estado} ${aud.motivo || ''}`);
    const filas = (await api(`/api/trabajos/${tAud}?resultado=1`)).d.resultado.matriz.filas;
    const esperado = Object.fromEntries(D.resultado_correcto.map((x) => [x.id, x.presentacion]));
    const malas = filas.filter((f) => f.presentacion !== esperado[f.requisito]);
    ok(filas.length === 22 && !malas.length, `clasificación 22/22${malas.length ? ` (fallan ${malas.map((f) => `${f.requisito} ${f.presentacion}≠${esperado[f.requisito]}`).join(', ')})` : ''}`);
    ok(filas.find((f) => f.requisito === '9').clasificacion === 'PARCIAL' && filas.find((f) => f.requisito === '15').clasificacion === 'NO ENCONTRADO' && filas.find((f) => f.requisito === '1').clasificacion === 'REQUIERE REVISIÓN', 'estados del expediente: LISTO, PARCIAL, NO ENCONTRADO, NO APLICA, REQUIERE REVISIÓN (la firma no se da por verificada)');
    st = await ctl('/control/stats');
    ok(!Object.keys(st.escrituras_en || {}).length, 'el análisis no escribió nada en Drive');
    // ---- Aprobación 4: plan de copias (vista previa completa) ----
    const plan = (await api('/api/auditorias/propuestas')).d.find((x) => x.tipo === 'plan_copias');
    const nombres = plan.plan.map((f) => f.nombre_copia);
    ok(plan && plan.copias === 20 && plan.resultados_nombre === NOMBRE, `plan: ${plan && plan.copias} copias en «${plan && plan.resultados_nombre}»`);
    ok(nombres.includes('04_Contrato_QF_y_nombramiento.pdf') && nombres.includes('05_Contrato_QF_y_nombramiento.pdf'), 'un archivo que acredita dos requisitos → una copia identificada para cada uno (04_ y 05_)');
    ok(nombres.includes('10_Registro_temperatura_enero.pdf') && nombres.includes('10_Registro_temperatura_febrero.pdf'), 'un requisito con dos documentos → ambos llevan su número (10_)');
    ok(nombres.includes('09_PENDIENTE_Procedimiento_recepcion.pdf') && nombres.includes('18_PENDIENTE_Declaracion_condiciones_sanitarias.pdf') && nombres.includes('01_PENDIENTE_Solicitud_autorizacion_botiquin.pdf'), 'parciales y por revisar (firma) → prefijo PENDIENTE');
    ok(nombres.includes('12_NO_APLICA_estupefacientes.pdf') && !plan.plan.some((f) => f.archivo_id === 'D_SENUELO') && plan.sin_copia.map((x) => x.requisito).join() === '7,15,21',
      'NO APLICA con su declaración; el archivo de nombre engañoso NO se copia; 7, 15 y 21 sin copia, con lo que falta');
    ok(plan.plan.every((f) => f.cita && f.estado) && plan.sin_copia.find((x) => x.requisito === '21').accion.length > 10, 'cada copia tiene su evidencia citada; cada faltante dice qué conseguir');
    const sens = plan.plan.find((f) => f.archivo_id === 'D_RUT');
    ok(sens && sens.sensible && sens.nombre_copia === '02_RUT_empresa.pdf', 'el RUT (sensible) aparece marcado y solo se copia si lo autorizas');
    r = await post(`/api/auditorias/propuestas/${plan.id}/aprobar-copias`, { password: 'equivocada' });
    st = await ctl('/control/stats');
    ok(r.status === 400 && !Object.keys(st.escrituras_en || {}).length, 'contraseña equivocada: no se crea carpeta ni copia');
    ok((await post(`/api/auditorias/propuestas/${plan.id}/aprobar`, { presupuesto: 9, origen: 'tarjeta_chat' })).status === 409, 'el plan de copias no se puede aprobar por la ruta de auditorías');
    // Apruebo: incluyo el RUT y omito una copia (el registro de febrero).
    r = await post(`/api/auditorias/propuestas/${plan.id}/aprobar-copias`, { password: PASS, incluir_sensibles: [sens.clave], omitir: ['10:D_TEMP2'] });
    ok(r.status === 200 && r.d.copias === 19, `copias aprobadas: ${r.d.copias} (incluido el RUT por decisión expresa, omitida una)`);
    const tCop = r.d.trabajo_id;
    // Corte del servidor a mitad de las copias → reanuda sin duplicar.
    for (let i = 0; i < 300; i++) { const a = (await api(`/api/auditorias/${tCop}/avance`)).d; if ((a.copias_hechas || 0) >= 6 || a.estado !== 'ejecutando') break; await dormir(50); }
    srv.kill('SIGKILL'); await dormir(800); await arrancar();
    const fin = await esperar(tCop);
    if (fin.estado !== 'completado') console.log('   motivo:', fin.motivo, JSON.stringify(fin).slice(0, 400));
    ok(fin.estado === 'completado' && fin.modo === 'copias' && fin.copias_hechas === 19 && fin.resultados && fin.resultados.url, `trabajo de copias ${fin.estado} tras un corte: ${fin.copias_hechas}/${fin.copias_total} copias`);
    // ---- Comprobaciones en Drive ----
    st = await ctl('/control/stats');
    const resId = fin.resultados.id;
    const en = await (await fetch(`http://localhost:9933/drive/v3/files?q=${encodeURIComponent(`'${resId}' in parents and trashed = false`)}&pageSize=200`)).json();
    const copiasEn = en.files.filter((f) => f.appProperties && f.appProperties.ada_origen);
    const entregables = en.files.filter((f) => f.appProperties && f.appProperties.ada_entregable);
    ok(copiasEn.length === 19 && new Set(copiasEn.map((f) => f.name)).size === 19, `la carpeta de resultados tiene exactamente 19 copias, sin duplicados pese al corte`);
    ok(entregables.map((f) => f.name).sort().join(' | ') === `${NOMBRE} — Matriz de requisitos.xlsx | ${NOMBRE} — Resumen.docx`, 'el Excel y el Word también quedaron dentro de la carpeta de resultados');
    ok(Object.keys(st.escrituras_en).every((k) => k === resId || k === 'root') && (st.escrituras_en.root || 0) === 1, `solo se escribió en la carpeta de resultados (y se creó una vez en la raíz): ${JSON.stringify(st.escrituras_en)}`);
    const fuente = ['carpeta-botdocs', 'botdocs-procedimientos', 'carpeta-botreq'];
    ok(!Object.keys(st.escrituras_en).some((k) => fuente.includes(k)) && docs.every((a) => !st.escrituras[a.id]), 'ninguna escritura en las carpetas de origen ni en sus archivos');
    ok(!copiasEn.some((f) => f.appProperties.ada_origen === 'D_SENUELO' || f.appProperties.ada_origen === 'D_TEMP2'), 'no se copió el archivo sin evidencia ni el omitido');
    const t = (await api(`/api/trabajos/${tCop}?resultado=1`)).d;
    const ver = t.detalle_pasos ? null : null; // (detalles en el resultado)
    ok(t.estado === 'completado', 'verificación final aprobada (copias presentes con nombre, enlace y marca; originales con la misma versión)');
    // ---- Excel ----
    const e = await post('/api/descargas', { tipo: 'auditoria', id: tCop });
    const ExcelJS = require('exceljs'); const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(Buffer.from(await (await fetch(`http://localhost:3200${e.d.url}`)).arrayBuffer()));
    const h = libro.getWorksheet('Requisitos'); const enc = []; h.getRow(1).eachCell((x) => enc.push(String(x.value)));
    const filasX = []; h.eachRow((row, n) => { if (n > 1) filasX.push(row.values.slice(1).map((v) => String(v == null ? '' : v))); });
    ok(enc.join(' | ') === 'N.º | Requisito | Estado | Documentos encontrados | Evidencia | Qué falta o qué corregir | Nombre de la copia | Enlace a la copia' && filasX.length === 22, `Excel: exactamente 22 requisitos con las columnas pedidas`);
    const f4 = filasX.find((x) => x[0] === '4'); const f21 = filasX.find((x) => x[0] === '21'); const f10 = filasX.find((x) => x[0] === '10');
    ok(f4[2] === 'LISTO' && f4[6] === '04_Contrato_QF_y_nombramiento.pdf' && /^https:\/\/drive\.simulado\/copia-/.test(f4[7]) && /Nombramiento del químico/.test(f4[4]), 'fila 4: LISTO, evidencia citada, nombre de la copia y enlace a la copia');
    ok(f21[2] === 'NO ENCONTRADO' && !f21[6] && f21[5].length > 10, 'fila 21: NO ENCONTRADO, sin copia, con qué documento conseguir');
    ok(f10[6] === '10_Registro_temperatura_enero.pdf', 'fila 10: solo la copia aprobada');
    const w = await post('/api/descargas', { tipo: 'auditoria_informe', id: tCop });
    const par = await require('../../src/archivos').textoDeWord(Buffer.from(await (await fetch(`http://localhost:3200${w.d.url}`)).arrayBuffer()));
    ok(par.some((x) => /^Expediente: Botiquín Andaluz \(ficticio\)/.test(x)) && par.some((x) => /Documentos que faltan/.test(x)) && par.some((x) => /^21: /.test(x)) && par.some((x) => /09_PENDIENTE_Procedimiento_recepcion\.pdf/.test(x)), 'Word: aprovechados, pendientes, faltantes y acciones');
    ok(/^auditoria-botiquin-andaluz-ficticio-/.test(e.d.nombre), `descarga con el expediente: ${e.d.nombre}`);
    // ---- Seguridad en la capa de Drive ----
    Object.assign(process.env, { ADA_DRIVE_URL: 'http://localhost:9933', DATABASE_URL: ENV.DATABASE_URL, ADA_CLAVE_DATOS: CLAVE, ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETAS_LECTURA: '', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba' });
    const Drive = require('../../src/drive'); await Drive.recargarCarpetas();
    const intento = async (fn) => { try { await fn(); return 'permitido'; } catch (x) { return x.message; } };
    const encargo = plan.id;
    ok(/Destino no permitido/.test(await intento(() => Drive.copiarAResultados({ encargo, resultadosId: 'carpeta-botdocs', origenId: 'D_LISTADO', carpetaOrigen: 'carpeta-botdocs', requisito: '08', nombre: 'x.pdf' }))), 'copiar hacia una carpeta de origen: rechazado (solo la carpeta de resultados del encargo)');
    ok(/no pertenece a la carpeta de origen/.test(await intento(() => Drive.copiarAResultados({ encargo, resultadosId: resId, origenId: 'BREQ_OTRO', carpetaOrigen: 'carpeta-botdocs', requisito: '08', nombre: 'x.pdf' }))), 'copiar un archivo de fuera de la carpeta de documentos: rechazado');
    ok(/Destino no permitido/.test(await intento(() => Drive.subirAResultados({ encargo: 'otro-encargo', resultadosId: resId, rol: 'excel', nombre: 'x', mime: 'text/plain', datos: Buffer.from('x') }))), 'otro encargo no puede escribir en esta carpeta de resultados');
    const cs = (await api('/api/carpetas-autorizadas')).d;
    ok(cs.filter((x) => /solo lectura/.test(x.permiso)).length === 2 && cs.some((x) => x.id === resId && /resultados/.test(x.permiso)), 'Ajustes: dos carpetas solo lectura y la carpeta de resultados identificada aparte');
  } catch (err) { ok(false, `excepción: ${err.stack}`); console.log(srv.log.slice(-3000)); }
  try { srv.kill(); } catch (_) {}
  drive.kill();
  setTimeout(() => process.exit(), 300);
})();
