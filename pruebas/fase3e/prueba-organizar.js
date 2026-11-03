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
const esperarPlan = async (tId) => { for (let i = 0; i < 80; i++) { const x = (await api('/api/auditorias/propuestas')).d.find((y) => y.tipo === 'plan_copias' && (!tId || y.auditoria_trabajo === tId)); if (x) return x; await dormir(250); } return null; };
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
      && !/12\.345\.678|juan\.perez|1234 5678|Firmar la solicitud|Page \d|requisitos y documentos»?\s*\|/.test(txtL) && !pL.tabla.inferidas.filter((n) => n !== 12).length
      && /Requisito: Contrato de trabajo del químico farmacéutico responsable\. \| Qué subir/.test(pL.requisitos[4].fuente) && /Requisito: Plano del local del botiquín con sus medidas\. \| Qué subir/.test(pL.requisitos[6].fuente)
      && /\| Estado: Listo$/.test(pL.requisitos[8].fuente),
      `lista desde la tabla: 22 de 22 (páginas ${pL.tabla && pL.tabla.paginas}), columnas y estado de referencia por fila, el «2» suelto no es requisito y la página 3 queda fuera sin datos personales`);
    // «Corregir la lista (sin costo)» sobre la tabla: texto ya guardado, sin descargas ni llamadas a la IA
    const stA = await ctl('/control/stats'); const llamA = sql('SELECT COUNT(*) FROM llamadas_ia');
    const rh = await post(`/api/auditorias/propuestas/${pL.id}/rehacer-lista`);
    const stB = await ctl('/control/stats');
    ok(rh.status === 200 && rh.d.nueva.requisitos.length === 22 && rh.d.nueva.tabla && rh.d.nueva.tabla.filas === 22 && rh.d.llamadas_ia_nuevas === 0 
      && JSON.stringify(stA.export) === JSON.stringify(stB.export) && rh.d.nueva.requisitos[3].texto.includes('responsable del botiquín'),
      `«Corregir la lista»: 22 de 22 desde la tabla, sin llamadas a la IA ni descargas (${rh.status} ${rh.d.error || ''} n=${rh.d.nueva && rh.d.nueva.requisitos.length} ia=${rh.d.llamadas_ia_nuevas} llam=${llamA}→${sql('SELECT COUNT(*) FROM llamadas_ia')} exp=${JSON.stringify(stA.export) === JSON.stringify(stB.export)} r4=${rh.d.nueva && rh.d.nueva.requisitos[3].texto.slice(0, 120)})`);
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
    // ---- Caso real dd8008fd: el informe (último paso) falla y el trabajo queda bloqueado. «Reintentar» repite SOLO ese
    // paso (sin IA, sin descargas), la tarjeta explica dónde se detuvo y qué pasó, y al terminar aparece el plan de copias.
    {
      const planAntes = await esperarPlan(tAud);
      sql(`DELETE FROM auditoria_propuestas WHERE id='${planAntes.id}'`);
      sql(`UPDATE trabajo_pasos SET estado='fallido', intentos=3, error='el informe salió incompleto y no se entrega: termina a media frase: «…Plano del local»' WHERE trabajo_id='${tAud}' AND tipo='aud_informe'`);
      sql(`UPDATE trabajos SET estado='bloqueado', motivo='paso informe: el informe salió incompleto y no se entrega: termina a media frase', resultado_cifrado=NULL, terminado_en=NULL WHERE id='${tAud}'`);
      sql(`INSERT INTO trabajo_eventos (trabajo_id, tipo, detalle, actor, creado_en) VALUES ('${tAud}', 'bloqueado', 'paso informe: el informe salió incompleto y no se entrega: termina a media frase', 'ejecutor', NOW())`);
      const finAntes = sql(`SELECT GROUP_CONCAT(fin ORDER BY orden) FROM trabajo_pasos WHERE trabajo_id='${tAud}' AND tipo<>'aud_informe'`);
      const llamAntes = sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${tAud}'`); const gastoAntes = sql(`SELECT gastado_usd FROM trabajos WHERE id='${tAud}'`);
      const stR = await ctl('/control/stats');
      const av = (await api(`/api/auditorias/${tAud}/avance`)).d;
      ok(av && av.paso_fallido && av.paso_fallido.tipo === 'aud_informe' && !av.paso_fallido.usa_ia && av.conservado && av.conservado.pasos === av.pasos_total - 1,
        `bloqueado: la tarjeta dice en qué paso se detuvo («${av && av.paso_fallido && av.paso_fallido.nombre}»), por qué, y que ${av && av.conservado && av.conservado.pasos} pasos están guardados`);
      const rr = await post(`/api/trabajos/${tAud}/reintentar`);
      ok(rr.status === 200, `reintento aceptado (${rr.status} ${rr.d.error || ''})`);
      const fin = await esperar(tAud);
      const av2 = (await api(`/api/auditorias/${tAud}/avance`)).d;
      ok(fin.estado === 'completado' && av2.reintento && av2.reintento.resultado === 'resuelto' && /aud_informe|informe/.test(av2.reintento.detalle || ''), `tras el reintento: ${fin.estado}; constancia «${av2.reintento && av2.reintento.detalle}»`);
      const stR2 = await ctl('/control/stats');
      ok(sql(`SELECT GROUP_CONCAT(fin ORDER BY orden) FROM trabajo_pasos WHERE trabajo_id='${tAud}' AND tipo<>'aud_informe'`) === finAntes && sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${tAud}'`) === llamAntes
        && sql(`SELECT gastado_usd FROM trabajos WHERE id='${tAud}'`) === gastoAntes && JSON.stringify(stR.export) === JSON.stringify(stR2.export),
        'solo se repitió el informe: los demás pasos intactos, sin llamadas a la IA, sin gasto nuevo y sin descargas');
      await esperarPlan(tAud); await dormir(500);
      const planes = (await api('/api/auditorias/propuestas')).d.filter((x) => x.tipo === 'plan_copias' && x.auditoria_trabajo === tAud);
      ok(planes.length === 1, `al terminar aparece el plan de copias para aprobar (una sola tarjeta: ${planes.length})`);
    }
    // ---- Aprobación 4: plan de copias (vista previa completa) ----
    let plan = await esperarPlan(tAud);
    const nombres = plan.plan.map((f) => f.nombre_copia);
    if (process.env.VER) console.log(plan.plan.map((f) => `${f.nombre_copia} [${f.pertinencia}${f.opcional ? ' opc' : ''}${f.sensible ? ' sens' : ''}] ${f.acredita}`).join('\n'), '\nDESC', JSON.stringify(plan.descartadas, null, 0), '\nAJ', JSON.stringify(plan.ajustes));
    ok(plan && plan.plan.length === 22 && plan.copias === 20 && plan.opcionales === 1 && plan.resultados_nombre === NOMBRE, `plan: ${plan && plan.plan.length} filas (${plan && plan.copias} marcadas por defecto, ${plan && plan.opcionales} relacionada sin leer, desmarcada) en «${plan && plan.resultados_nombre}»`);
    ok(plan.plan.find((f) => f.requisito === '7' && !f.opcional && /no tiene texto/i.test(f.acredita)) && plan.plan.some((f) => f.requisito === '15' && f.opcional && /relacionado por su nombre/.test(f.acredita)), 'pertinencia: el plano sin texto del 7 se propone como PENDIENTE (ADA no puede leerlo); el archivo examinado sin cita del 15 va DESMARCADO');
    {
      // «Revisar el plan otra vez (sin costo)»: con los resultados guardados, sin IA, sin descargas y sin escribir en Drive.
      const stP = await ctl('/control/stats'); const llP = sql('SELECT COUNT(*) FROM llamadas_ia');
      const rg = await post(`/api/auditorias/propuestas/${plan.id}/regenerar-plan`);
      const stP2 = await ctl('/control/stats');
      ok(rg.status === 200 && rg.d.llamadas_ia_nuevas === 0 && JSON.stringify(stP.export) === JSON.stringify(stP2.export) && !Object.keys(stP2.escrituras_en || {}).length
        && rg.d.propuesta.plan.length === plan.plan.length && rg.d.entregables.excel.listo && rg.d.entregables.excel.filas === 22 && rg.d.entregables.informe.listo && rg.d.entregables.informe.comprobado,
        `regenerar el plan: sin IA, sin descargas ni escrituras; Excel (${rg.d.entregables && rg.d.entregables.excel.filas} filas) e informe comprobados (${rg.status} ${rg.d.error || ''})`);
      const pend = (await api('/api/auditorias/propuestas')).d.filter((x) => x.tipo === 'plan_copias' && x.auditoria_trabajo === plan.auditoria_trabajo);
      ok(pend.length === 1 && pend[0].id === rg.d.propuesta.id && rg.d.propuesta.revision && rg.d.propuesta.version_plan === 3, 'el plan anterior se reemplaza: queda una sola tarjeta, la de la revisión comprobada');
      plan = rg.d.propuesta;
      // Revisión del expediente: resumen en la tarjeta, Excel y Word REVISADOS para descargar, diagnóstico para compartir.
      const av = (await api(`/api/auditorias/${plan.auditoria_trabajo}/avance`)).d;
      ok(av.revision && av.revision.coherencia.ok && av.revision.version >= 2 && Object.values(av.revision.resumen).flat().length === 22, `tarjeta: revisión ${av.revision && av.revision.version} coherente con los 22 requisitos clasificados`);
      const dx = await post('/api/descargas', { tipo: 'auditoria', id: plan.auditoria_trabajo });
      const dw = await post('/api/descargas', { tipo: 'auditoria_informe', id: plan.auditoria_trabajo });
      const dd = await post('/api/descargas', { tipo: 'diagnostico_expediente', id: plan.auditoria_trabajo });
      const wpar = await require('../../src/archivos').textoDeWord(Buffer.from(await (await fetch(`http://localhost:3200${dw.d.url}`)).arrayBuffer()));
      const diag = await (await fetch(`http://localhost:3200${dd.d.url}`)).json();
      ok(/^auditoria-revisada-v\d+-/.test(dx.d.nombre) && /^informe-revisado-v\d+-/.test(dw.d.nombre) && wpar.some((x) => /^Situación: /.test(x)) && !wpar.some((x) => /respuesta cortada|formato:/i.test(x)) && diag.requisitos.length === 22 && !JSON.stringify(diag).includes('12.345.678'),
        `descargas revisadas: ${dx.d.nombre} · ${dw.d.nombre} · diagnóstico (22 requisitos, sin datos personales)`);
    }
    ok(nombres.includes('04_Contrato_QF_y_nombramiento.pdf') && nombres.includes('05_Contrato_QF_y_nombramiento.pdf'), 'un archivo que acredita dos requisitos → una copia identificada para cada uno (04_ y 05_)');
    ok(nombres.includes('10_Registro_temperatura_enero.pdf') && nombres.includes('10_Registro_temperatura_febrero.pdf'), 'un requisito con dos documentos → ambos llevan su número (10_)');
    ok(nombres.includes('09_PENDIENTE_Procedimiento_recepcion.pdf') && nombres.includes('18_PENDIENTE_Declaracion_condiciones_sanitarias.pdf') && nombres.includes('01_PENDIENTE_Solicitud_autorizacion_botiquin.pdf'), 'parciales y por revisar (firma) → prefijo PENDIENTE');
    ok(nombres.includes('12_NO_APLICA_estupefacientes.pdf') && !plan.plan.some((f) => f.archivo_id === 'D_SENUELO' && !f.opcional) && plan.sin_copia.map((x) => x.requisito).join() === '21',
      'NO APLICA con su declaración; el archivo de nombre engañoso NO se copia; 7, 15 y 21 sin copia, con lo que falta');
    ok(plan.plan.every((f) => (f.cita || f.pertinencia === 'relacionado') && f.estado) && plan.sin_copia.find((x) => x.requisito === '21').accion.length > 10, 'cada copia tiene su evidencia citada; cada faltante dice qué conseguir');
    const sens = plan.plan.find((f) => f.archivo_id === 'D_RUT');
    ok(sens && sens.sensible && sens.nombre_copia === '02_RUT_empresa.pdf', 'el RUT (sensible) aparece marcado y solo se copia si lo autorizas');
    {
      // Caso del teléfono: un plan PENDIENTE hecho antes de la revisión comprobada (versión 2). Al reiniciar el servidor
      // (despliegue), se revisa solo, sin IA ni Drive, y queda un único plan nuevo.
      process.env.ADA_CLAVE_DATOS = CLAVE; const Cif = require('../../src/cifrado');
      const my = await require('mysql2/promise').createConnection('mysql://ada:ada@localhost:3306/ada');
      const [[fila]] = await my.query('SELECT datos_cifrado FROM auditoria_propuestas WHERE id = ?', [plan.id]);
      const viejo = Cif.descifrarJSON(fila.datos_cifrado); viejo.version_plan = 2; delete viejo.revision;
      await my.query('UPDATE auditoria_propuestas SET datos_cifrado = ? WHERE id = ?', [Cif.cifrarJSON(viejo), plan.id]); await my.end();
      const stB0 = await ctl('/control/stats'); const llB0 = sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${plan.auditoria_trabajo}'`);
      srv.kill('SIGKILL'); await dormir(800); await arrancar();
      let nuevos = [];
      for (let i = 0; i < 60 && !(nuevos.length === 1 && nuevos[0].version_plan === 3); i++) { await dormir(500); nuevos = (await api('/api/auditorias/propuestas')).d.filter((x) => x.tipo === 'plan_copias' && x.auditoria_trabajo === plan.auditoria_trabajo); }
      const stB1 = await ctl('/control/stats');
      if (!nuevos.length) console.log('LOG', srv.log.slice(-1500));
      ok(nuevos.length === 1 && nuevos[0] && nuevos[0].id !== plan.id && nuevos[0].version_plan === 3 && sql(`SELECT estado FROM auditoria_propuestas WHERE id='${plan.id}'`) === 'descartada'
        && sql(`SELECT COUNT(*) FROM llamadas_ia WHERE trabajo_id='${plan.auditoria_trabajo}'`) === llB0 && JSON.stringify(stB0.export) === JSON.stringify(stB1.export) && !Object.keys(stB1.escrituras_en || {}).length,
        'al reiniciar, el plan anterior a la revisión se rehace solo: un único plan comprobado, sin IA, sin descargas ni escrituras');
      plan = nuevos[0] || plan;
    }
    r = await post(`/api/auditorias/propuestas/${plan.id}/aprobar-copias`, { password: 'equivocada' });
    st = await ctl('/control/stats');
    ok(r.status === 400 && !Object.keys(st.escrituras_en || {}).length, 'contraseña equivocada: no se crea carpeta ni copia');
    ok((await post(`/api/auditorias/propuestas/${plan.id}/aprobar`, { presupuesto: 9, origen: 'tarjeta_chat' })).status === 409, 'el plan de copias no se puede aprobar por la ruta de auditorías');
    // Apruebo: incluyo el RUT y omito una copia (el registro de febrero).
    r = await post(`/api/auditorias/propuestas/${plan.id}/aprobar-copias`, { password: PASS, incluir_sensibles: [sens.clave], omitir: ['10:D_TEMP2', `7:${plan.plan.find((f) => f.requisito === '7').archivo_id}`] });
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
    ok(entregables.length === 2 && entregables.some((f) => f.name.startsWith(`${NOMBRE} — Matriz de requisitos (revisión `)) && entregables.some((f) => f.name.startsWith(`${NOMBRE} — Resumen (revisión `)), `el Excel y el Word (de la revisión) también quedaron dentro de la carpeta de resultados: ${entregables.map((f) => f.name).join(' | ')}`);
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
    ok(enc.join(' | ') === 'N.º | Requisito | Clasificación | Situación | Documentos pertinentes | Evidencia (cita textual) | Archivos por revisar a mano | Qué falta o qué revisar | Estado declarado en la lista | Cambio respecto de la auditoría | Copias en la carpeta (enlaces)' && filasX.length === 22 && libro.getWorksheet('Documentos por requisito'), `Excel: exactamente 22 requisitos, con la hoja «Documentos por requisito» (A–E)`);
    const f4 = filasX.find((x) => x[0] === '4'); const f21 = filasX.find((x) => x[0] === '21'); const f10 = filasX.find((x) => x[0] === '10');
    ok(f4[2] === 'LISTO' && /^04_Contrato_QF_y_nombramiento\.pdf — https:\/\/drive\.simulado\/copia-/.test(f4[10]) && /Nombramiento del químico/.test(f4[5]), 'fila 4: LISTO, evidencia citada, nombre de la copia y enlace a la copia');
    ok(f21[2] === 'NO ENCONTRADO' && !f21[10] && f21[7].length > 10, 'fila 21: NO ENCONTRADO, sin copia, con qué documento conseguir');
    ok(/10_Registro_temperatura_enero\.pdf/.test(f10[10]) && !/febrero/.test(f10[10]), 'fila 10: solo la copia aprobada');
    const w = await post('/api/descargas', { tipo: 'auditoria_informe', id: tCop });
    const par = await require('../../src/archivos').textoDeWord(Buffer.from(await (await fetch(`http://localhost:3200${w.d.url}`)).arrayBuffer()));
    ok(par.some((x) => /^Expediente: Botiquín Andaluz \(ficticio\)/.test(x)) && par.some((x) => /Copias en la carpeta de resultados/.test(x)) && par.some((x) => /^21 — NO ENCONTRADO/.test(x)) && par.some((x) => /09_PENDIENTE_Procedimiento_recepcion\.pdf — https/.test(x)), 'Word: requisitos, pendientes, faltantes y copias con enlace');
    ok(/^auditoria-botiquin-andaluz-ficticio-/.test(e.d.nombre), `descarga con el expediente: ${e.d.nombre}`);
    // ---- Segunda entrega en la MISMA carpeta (caso dd8008fd): se revisa otra vez, las 19 copias ya hechas se reconocen
    // (no se duplican) y se agrega solo lo que marques; Excel y Word nuevos con TODOS los enlaces.
    {
      const tA = plan.auditoria_trabajo;
      const rv = await post(`/api/auditorias/${tA}/revisar-expediente`);
      const p2 = (await api('/api/auditorias/propuestas')).d.find((x) => x.tipo === 'plan_copias' && x.auditoria_trabajo === tA);
      const ya = p2.plan.filter((f) => f.ya_copiada);
      if (process.env.VER) console.log("NUEVAS", JSON.stringify(p2.plan.filter((f) => !f.ya_copiada && !f.opcional && !f.sensible).map((f) => [f.requisito, f.archivo, f.pertinencia]))); if (process.env.VER) console.log("P2", JSON.stringify((await api("/api/auditorias/propuestas")).d.filter((x) => x.tipo === "plan_copias").map((x) => [x.id.slice(0,8), x.auditoria_trabajo.slice(0,8), x.version_plan, !!x.carpeta_existente, x.revision && x.revision.version])), p2 && JSON.stringify({ c: p2.carpeta_existente, n: (p2.copias_existentes || []).length, ya: ya.length, copias: p2.copias, id: p2.id, prev: plan.id }));
      ok(rv.status === 200 && p2 && p2.carpeta_existente && p2.carpeta_existente.id === resId && ya.length === 19 && p2.copias === 0, `plan nuevo: reutiliza la carpeta existente y reconoce las ${ya.length} copias ya hechas (0 duplicados marcados)`);
      const extra = p2.plan.find((f) => f.requisito === '7' && f.opcional);
      const ap = await post(`/api/auditorias/propuestas/${p2.id}/aprobar-copias`, { password: PASS, incluir_sensibles: [extra.clave] });
      const fin2 = await esperar(ap.d.trabajo_id);
      const en2 = await (await fetch(`http://localhost:9933/drive/v3/files?q=${encodeURIComponent(`'${resId}' in parents and trashed = false`)}&pageSize=200`)).json();
      const cps = en2.files.filter((f) => f.appProperties && f.appProperties.ada_origen);
      const ent2 = en2.files.filter((f) => f.appProperties && f.appProperties.ada_entregable);
      ok(ap.status === 200 && ap.d.copias === 1 && fin2.estado === 'completado' && cps.length === 20 && new Set(cps.map((f) => f.name)).size === 20 && cps.some((f) => f.name === '07_PENDIENTE_Plano_local_botiquin.jpg'),
        `se agregó solo la copia marcada a la misma carpeta: ${cps.length} copias, sin duplicados (${fin2.estado} ${fin2.motivo || ''})`);
      const ex2 = await post('/api/descargas', { tipo: 'auditoria', id: ap.d.trabajo_id });
      const lb = new ExcelJS.Workbook(); await lb.xlsx.load(Buffer.from(await (await fetch(`http://localhost:3200${ex2.d.url}`)).arrayBuffer()));
      const enl = []; lb.getWorksheet('Requisitos').eachRow((row, n) => { if (n > 1) enl.push(String(row.getCell(11).value || '')); });
      ok(ent2.length === 4 && enl.join('\n').split('https://').length - 1 === 20, `Excel nuevo con los enlaces de las 20 copias (anteriores y nueva); entregables en la carpeta: ${ent2.length}`);
    }
    // ---- Lote pedido (requisitos 3 al 7) con archivos indicados por la persona: plan solo de ese lote, en la MISMA
    // carpeta, sin duplicar lo ya copiado, RESPALDO desmarcado, FALTA si un archivo no existe; nada se copia sin aprobar.
    {
      const tA = plan.auditoria_trabajo;
      const en0 = (await (await fetch(`http://localhost:9933/drive/v3/files?q=${encodeURIComponent(`'${resId}' in parents and trashed = false`)}&pageSize=200`)).json()).files.filter((f) => f.appProperties && f.appProperties.ada_origen).length;
      const lo = await post(`/api/auditorias/${tA}/lote`, { clave: 'prueba-3-7', nombre: 'Botiquín — requisitos 3 al 7', requisitos: [3, 4, 5, 6, 7], asignaciones: [
        { requisito: 3, tipo: 'buscar', patron: 'constituc', descripcion: 'certificado de constitución' },
        { requisito: 4, tipo: 'pendiente', archivo: 'Titulo QF.pdf' }, { requisito: 5, tipo: 'pendiente', archivo: 'Listado_medicamentos.pdf', falta: 'Comprobar a la vista botiquín, refrigerador y evacuación.' },
        { requisito: 6, tipo: 'respaldo', archivo: 'Horario_funcionamiento.pdf' }, { requisito: 7, tipo: 'respaldo', archivo: 'No_existe_en_la_carpeta.pdf' } ] });
      const pl = (await api('/api/auditorias/propuestas')).d.filter((x) => x.tipo === 'plan_copias' && x.auditoria_trabajo === tA);
      const L = pl[0]; const R = (n) => L.plan.filter((f) => f.requisito === String(n));
      ok(lo.status === 200 && pl.length === 1 && L.lote && L.carpeta_existente.id === resId && R(3)[0].ya_copiada && R(4)[0].nombre_copia === '04_PENDIENTE_Titulo_QF.pdf' && !R(4)[0].opcional && !R(5)[0].opcional
        && R(6)[0].opcional && R(6)[0].nombre_copia === '06_RESPALDO_Horario_funcionamiento.pdf' && L.sin_copia.some((x) => x.requisito === '7' && x.estado === 'FALTA') && L.copias === 2,
        `lote 3–7: una sola tarjeta, misma carpeta, 3 ya copiado, 4 y 5 marcados (PENDIENTE), 6 RESPALDO desmarcado, 7 FALTA (${lo.status} ${lo.d.error || ''})`);
      const en1 = (await (await fetch(`http://localhost:9933/drive/v3/files?q=${encodeURIComponent(`'${resId}' in parents and trashed = false`)}&pageSize=200`)).json()).files.filter((f) => f.appProperties && f.appProperties.ada_origen).length;
      ok(en1 === en0, 'preparar el lote no crea ninguna copia');
      const ap = await post(`/api/auditorias/propuestas/${L.id}/aprobar-copias`, { password: PASS, incluir_sensibles: [R(6)[0].clave] });
      const fin3 = await esperar(ap.d.trabajo_id);
      const en2 = (await (await fetch(`http://localhost:9933/drive/v3/files?q=${encodeURIComponent(`'${resId}' in parents and trashed = false`)}&pageSize=200`)).json()).files.filter((f) => f.appProperties && f.appProperties.ada_origen);
      ok(ap.d.copias === 3 && fin3.estado === 'completado' && en2.length === en0 + 3 && new Set(en2.map((f) => f.name)).size === en2.length && ['04_PENDIENTE_Titulo_QF.pdf', '05_PENDIENTE_Listado_medicamentos.pdf', '06_RESPALDO_Horario_funcionamiento.pdf'].every((n) => en2.some((f) => f.name === n)),
        `aprobado el lote: 3 copias agregadas a la misma carpeta, sin duplicados (${fin3.estado} ${fin3.motivo || ''})`);
    }
    // ---- Tercer lote: búsqueda por CONTENIDO (texto guardado), grupos principal/anexo/alternativa, respaldo opcional y FALTA.
    {
      const tA = plan.auditoria_trabajo;
      const cuenta = async () => (await (await fetch(`http://localhost:9933/drive/v3/files?q=${encodeURIComponent(`'${resId}' in parents and trashed = false`)}&pageSize=200`)).json()).files.filter((f) => f.appProperties && f.appProperties.ada_origen).length;
      const c0 = await cuenta();
      const lo = await post(`/api/auditorias/${tA}/lote`, { clave: 'prueba-8-12', nombre: 'Botiquín — requisitos 8 al 12', requisitos: [8, 9, 10, 11, 12], asignaciones: [
        { requisito: 8, tipo: 'buscar_contenido', descripcion: 'el procedimiento de reclamos', contenido: 'reclamos de usuarios', excluir: 'formulario', marcar_si: 'usuarios' },
        { requisito: 9, tipo: 'grupo', contenido: 'temperatura', archivos: [{ archivo: 'Registro_temperatura_enero.pdf', rol: 'principal' }, { archivo: 'Registro_temperatura_febrero.pdf', rol: 'anexo' }, { archivo: 'Programa_capacitacion.pdf', rol: 'alternativa' }] },
        { requisito: 11, tipo: 'buscar_contenido', clase: 'respaldo', marcar: false, si_no: 'NO APLICA — POR CONFIRMAR', descripcion: 'una boleta de agua', contenido: 'agua potable', excluir: 'formulario' },
        { requisito: 12, tipo: 'buscar_contenido', descripcion: 'un convenio de control de plagas', contenido: 'control de plagas', nombres: 'plaga', excluir: 'laboratorio' } ] });
      const L = (await api('/api/auditorias/propuestas')).d.find((x) => x.tipo === 'plan_copias' && x.auditoria_trabajo === tA);
      const R = (n) => L.plan.filter((f) => f.requisito === String(n));
      const r9 = R(9); if (process.env.VER) console.log('L3', JSON.stringify(L.plan.map((f) => [f.requisito, f.rol, f.opcional, f.nombre_copia, f.acredita.slice(0, 80)])), JSON.stringify(L.sin_copia));
      ok(lo.status === 200 && L.lote.nombre === 'Botiquín — requisitos 8 al 12' && R(8).length >= 1 && R(8).every((f) => /su contenido lo menciona/i.test(f.acredita))
        && r9.find((f) => f.rol === 'principal' && !f.opcional) && r9.find((f) => f.rol === 'anexo' && !f.opcional && /_PENDIENTE_ANEXO_/.test(f.nombre_copia)) && r9.find((f) => f.rol === 'alternativa' && f.opcional)
        && R(11).length === 1 && R(11)[0].opcional && /RESPALDO/.test(R(11)[0].nombre_copia) && L.sin_copia.some((x) => x.requisito === '12' && x.estado === 'FALTA') && !R(10).length,
        `lote 8–12: contenido (8: ${R(8).map((f) => f.archivo).join(', ')}), grupo del 9 (principal, anexo, alternativa desmarcada), 11 respaldo desmarcado, 12 FALTA (${lo.status} ${lo.d.error || ''})`);
      ok((await cuenta()) === c0, 'preparar el tercer lote no crea ninguna copia');
    }
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
