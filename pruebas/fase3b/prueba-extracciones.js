// Fase 3b: extracciones cifradas y reutilizables (conversación y encargos) con Drive simulado.
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const S = __dirname;
const resultados = [];
const ok = (c, m) => { const l = (c ? 'ok - ' : 'FALLA: ') + m; console.log(l); resultados.push(l); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q, base = 'ada') => execSync(`mysql -uada -pada ${base} -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const CLAVE = `prueba3b-${crypto.randomBytes(32).toString('base64')}`;
const DRIVE = 'http://localhost:9933';
const procesos = {};

async function arrancarDrive() {
  const p = spawn('node', [`${S}/fake-drive.js`, '9933'], { stdio: ['ignore', 'pipe', 'pipe'] });
  procesos.drive = p;
  for (let i = 0; i < 40; i++) { await dormir(100); try { await fetch(`${DRIVE}/control/stats`); return; } catch (_) {} }
  throw new Error('no arrancó el Drive simulado');
}
async function arrancar(nombre, puerto, extra = {}) {
  const p = spawn('node', ['-r', `${S}/fake-claude-3b.js`, 'src/server.js'], {
    cwd: '/home/claude/ada', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(puerto), DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: CLAVE, ADA_EXTRACCIONES: 'si', ADA_DRIVE_URL: DRIVE, ADA_TRABAJO_LEASE_MS: '3000', ADA_TRABAJO_CICLO_MS: '300', ADA_EXTRACCIONES_ESPERA_MS: '50',
      // Claude es simulado: topes altos para medir solo la capa de extracciones.
      ADA_TOPE_TURNO: '50', ADA_TOPE_DIARIO: '500', ADA_TOPE_DIARIO_MAX: '1000', ADA_TURNOS_2MIN: '500', ...extra },
  });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  procesos[nombre] = p;
  for (let i = 0; i < 80; i++) { await dormir(200); try { await fetch(`http://localhost:${puerto}/api/ajustes`); return p; } catch (_) {} }
  throw new Error(`no arrancó ${nombre}: ${p.log.slice(-800)}`);
}
const logs = [];
async function parar(nombre, senal = 'SIGTERM') { const p = procesos[nombre]; if (p) { p.kill(senal); await dormir(700); logs.push(p.log); delete procesos[nombre]; } }

const tokens = {};
async function login(puerto, nombre = 'Cristian', password = 'p') {
  const r = await (await fetch(`http://localhost:${puerto}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre, password }) })).json();
  return r.token;
}
async function api(ruta, op = {}, puerto = 3200, tk = tokens.c) {
  const r = await fetch(`http://localhost:${puerto}${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch (_) { d = t; }
  return { status: r.status, d };
}
const post = (ruta, body, puerto, tk) => api(ruta, { method: 'POST', body: JSON.stringify(body || {}) }, puerto, tk);
const ctl = async (ruta, body) => (await fetch(`${DRIVE}${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();

// Conversación: manda un mensaje y devuelve los eventos SSE.
async function chat(mensaje, { conv = null, puerto = 3200, tk = tokens.c } = {}) {
  const r = await fetch(`http://localhost:${puerto}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: JSON.stringify({ mensaje, conversacion_id: conv }) });
  const t = await r.text();
  if (r.status !== 200) return { status: r.status, eventos: [], error: t };
  const eventos = t.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { tipo: e.slice(7), d: JSON.parse(d.slice(6)) }; });
  const fin = eventos.find((e) => e.tipo === 'fin');
  return { status: 200, eventos, fin: fin && fin.d, conv: (eventos.find((e) => e.tipo === 'conversacion') || { d: {} }).d.conversacion_id, texto: fin ? fin.d.respuesta : '' };
}
let nonce = 0;
const lee = (lotes, opciones) => chat(`[${++nonce}] LEE ${JSON.stringify({ lotes })}`, opciones);
const metricas = async (q = '') => (await api(`/api/extracciones/metricas${q}`)).d;
const stats = () => ctl('/control/stats');
const descargasDe = (st, id) => (st.export[id] || 0) + (st.media[id] || 0) + (st.sheets[id] || 0);
const nEventos = (tipo, extra = '') => Number(sql(`SELECT COUNT(*) FROM extraccion_eventos WHERE tipo='${tipo}' ${extra}`));
let ultimoEv = 0;
const desdeUltimo = () => Number(sql('SELECT COALESCE(MAX(id),0) FROM extraccion_eventos'));
const local = (ms) => { const d = new Date(Date.now() + ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

// Documentos ficticios. MARCA-SECRETA permite comprobar que el texto nunca aparece en claro.
const MARCA = 'MARCA-SECRETA-3B';
const texto = (id, largo = 3000, v = 1) => { let t = `Documento ficticio ${id} versión ${v}. ${MARCA}-${id}-v${v}. `; while (t.length < largo) t += `Párrafo de prueba ${t.length} del archivo ${id} con requisitos ficticios. `; return t.slice(0, largo); };
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
function doc(id, nombre, mimeType, largo = 3000) {
  const t = texto(id, largo);
  return { id, name: nombre, mimeType, texto: t, md5Checksum: mimeType.startsWith('application/vnd.google-apps') ? undefined : md5(t), version: 1, parents: ['carpeta-prueba'] };
}

(async () => {
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  for (const t of ['extraccion_eventos', 'temporales_drive']) sql(`DROP TABLE IF EXISTS ${t}`);
  sql('DROP TABLE IF EXISTS extracciones');
  sql("DELETE FROM integraciones WHERE nombre='extracciones_consentimiento'");
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  await arrancarDrive();
  const PDF = 'application/pdf'; const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; const GDOC = 'application/vnd.google-apps.document';
  await ctl('/control/archivos', { archivos: [
    doc('A1', '01_Formulario_ficticio.pdf', PDF), doc('A2', '02_Acta_ficticia.docx', DOCX), doc('A3', '03_Nota_ficticia', GDOC),
    doc('A4', '04_Permiso.pdf', PDF), doc('A5', '05_Version.pdf', PDF), doc('A6', '06_Lento.pdf', PDF), doc('A7', '07_Temporal.pdf', PDF),
    doc('A8', '08_Concurrente.pdf', PDF), doc('A9', '09_Vence.pdf', PDF),
    { id: 'H1', name: 'Planilla ficticia', mimeType: 'application/vnd.google-apps.spreadsheet', version: 1, texto: `${MARCA}-H1`, hojas: [{ nombre: 'Costos', valores: [['Ítem', 'Costo'], [`${MARCA}-H1`, '100']] }] },
    { id: 'C1', name: 'Carpeta ficticia', mimeType: 'application/vnd.google-apps.folder', version: 1 },
  ] });

  await arrancar('A', 3200);
  tokens.c = await login(3200);
  ok(!!tokens.c, 'sesión de Cristian');

  // ===== 1. Consentimiento antes de guardar el primer texto =====
  let r = await lee([[{ id: 'A1' }, { id: 'A2' }]]);
  const pedidos = r.eventos.filter((e) => e.tipo === 'consentimiento_extracciones');
  ok(r.status === 200 && pedidos.length === 1, `primera lectura desde el chat: la app recibe UNA pregunta de consentimiento (${pedidos.length})`);
  ok(pedidos[0] && /cifrado/.test(pedidos[0].d.texto) && /30 días/.test(pedidos[0].d.texto) && /borrarlo todo/.test(pedidos[0].d.texto) && /sin guardar nada/.test(pedidos[0].d.texto), 'la pregunta explica: cifrado, 30 días, borrar cuando quiera y que sin aceptar sigue funcionando');
  ok(Number(sql('SELECT COUNT(*) FROM extracciones')) === 0, 'sin respuesta: no se guardó nada');
  ok(/Listo: 2 lecturas/.test(r.texto), `el chat funciona igual sin guardar ("${r.texto}")`);
  let m = await metricas();
  ok(m.lecturas_sin_guardar === 2 && m.extracciones_nuevas === 0, `métricas: 2 lecturas sin guardar, 0 extracciones guardadas (${m.lecturas_sin_guardar}/${m.extracciones_nuevas})`);
  r = await post('/api/extracciones/consentimiento', { acepto: false });
  ok(r.status === 200 && r.d.estado === 'rechazado', 'responde "No guardar"');
  let st0 = await stats();
  r = await lee([[{ id: 'A1' }]]);
  let st1 = await stats();
  ok(!r.eventos.some((e) => e.tipo === 'consentimiento_extracciones') && Number(sql('SELECT COUNT(*) FROM extracciones')) === 0 && descargasDe(st1, 'A1') === descargasDe(st0, 'A1') + 1,
    'rechazado: no vuelve a preguntar, no guarda y relee desde Drive (sin almacenamiento persistente)');
  r = await post('/api/extracciones/consentimiento', { acepto: true });
  ok(r.status === 200 && r.d.estado === 'aceptado' && r.d.version === 1, 'acepta (queda registrado con fecha y versión del texto)');

  // ===== 2. Archivo sin cambios: no se vuelve a extraer =====
  await ctl('/control/reset', {}); desdeUltimo();
  r = await lee([[{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }, { id: 'H1' }]]);
  const conv1 = r.conv;
  let st = await stats();
  ok(['A1', 'A2', 'A3', 'H1'].every((id) => descargasDe(st, id) === 1), 'con consentimiento: cada archivo se descarga una vez');
  ok(Number(sql("SELECT COUNT(*) FROM extracciones WHERE estado='valida'")) === 4, '4 extracciones guardadas');
  ok((st.copias.A1 || 0) === 1 && (st.copias.A2 || 0) === 1 && !(st.copias.A3), 'PDF y Word se convierten con copia temporal; Google Docs se exporta directo');
  r = await lee([[{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }, { id: 'H1' }], [{ id: 'A1', desde: 1000, max: 500 }]], { conv: conv1 });
  st = await stats();
  ok(['A1', 'A2', 'A3', 'H1'].every((id) => descargasDe(st, id) === 1) && (st.copias.A1 || 0) === 1, 'segunda vez (y un tramo nuevo de A1): cero descargas y cero copias nuevas');
  ok(st.meta.A1 === 3 && st.meta.A2 === 2, `cada reutilización consulta antes permisos y versión (metadatos A1=${st.meta.A1}, A2=${st.meta.A2})`);
  ok(/5 lecturas|1 lecturas en el último paso, 1 desde lo guardado/.test(r.texto), `el resultado dice que salió de lo guardado ("${r.texto}")`);
  m = await metricas(`?conversacion=${conv1}`);
  ok(m.reutilizaciones === 5 && m.descargas === 4 && m.extracciones_nuevas === 4 && m.operaciones_redundantes === 0, `métricas de la conversación: 4 descargas, 4 nuevas, 5 reutilizaciones, 0 redundantes (${m.descargas}/${m.extracciones_nuevas}/${m.reutilizaciones}/${m.operaciones_redundantes})`);

  // ===== 3. La extracción se conserva tras reiniciar =====
  await parar('A');
  await arrancar('A', 3200);
  const antes = await stats();
  r = await lee([[{ id: 'A1' }, { id: 'A3' }]]);
  st = await stats();
  ok(descargasDe(st, 'A1') === descargasDe(antes, 'A1') && descargasDe(st, 'A3') === descargasDe(antes, 'A3'), 'tras reiniciar el servidor: se reutiliza sin descargar');
  ok(/2 desde lo guardado/.test(r.texto), `tras reiniciar sale de lo guardado ("${r.texto}")`);

  // ===== 4. Cambio de versión invalida la anterior =====
  const nuevo = texto('A5', 3000, 2);
  r = await lee([[{ id: 'A5' }]]);
  await ctl('/control/cambiar', { id: 'A5', cambios: { version: 2, texto: nuevo, md5Checksum: md5(nuevo), modifiedTime: '2026-10-28T10:00:00.000Z' } });
  r = await lee([[{ id: 'A5' }]]);
  st = await stats();
  ok(descargasDe(st, 'A5') === 2, 'versión nueva en Drive: se vuelve a extraer (2 descargas en total)');
  ok(sql("SELECT CONCAT(estado,'|',IFNULL(texto_cifrado,'NULL'),'|',motivo) FROM extracciones WHERE archivo_id='A5' AND version LIKE 'v1:%'") === 'invalidada|NULL|version_nueva', 'la extracción anterior queda invalidada y sin texto');
  ok(nEventos('extraccion_nueva', "AND archivo_id='A5' AND motivo='version_nueva'") === 1, 'registro: extracción nueva por "version_nueva"');
  r = await lee([[{ id: 'A5' }]]);
  ok(/1 desde lo guardado/.test(r.texto) && descargasDe(await stats(), 'A5') === 2, 'la versión nueva luego se reutiliza');

  // ===== 5. Pérdida de permisos: bloquea y borra =====
  await lee([[{ id: 'A4' }]]);
  ok(sql("SELECT estado FROM extracciones WHERE archivo_id='A4'") === 'valida', 'A4 guardado');
  await ctl('/control/cambiar', { id: 'A4', cambios: { acceso: false } });
  r = await lee([[{ id: 'A4' }]]);
  ok(/1 con error/.test(r.texto), `sin permiso: la lectura falla (${r.texto})`);
  ok(sql("SELECT CONCAT(estado,'|',IFNULL(texto_cifrado,'NULL'),'|',motivo) FROM extracciones WHERE archivo_id='A4'") === 'invalidada|NULL|sin_acceso', 'sin permiso: la extracción se invalida y su texto se borra');
  const revA4 = sql("SELECT revisado FROM mensajes WHERE revisado IS NOT NULL ORDER BY id DESC LIMIT 1");
  ok(!revA4.includes(`${MARCA}-A4`) && /ya no tienes acceso/.test(revA4), 'lo que recibió ADA es el aviso, no el contenido guardado');
  await ctl('/control/cambiar', { id: 'A4', cambios: { trashed: false, acceso: true } });

  // ===== 6. Error temporal al comprobar acceso: no muestra lo guardado =====
  await lee([[{ id: 'A6' }]]);
  await ctl('/control/fallas', { meta: 2 });
  r = await lee([[{ id: 'A6' }]]);
  ok(/1 con error/.test(r.texto), 'Drive falla dos veces seguidas al comprobar: no se muestra lo guardado');
  const revA6 = sql("SELECT revisado FROM mensajes WHERE revisado IS NOT NULL ORDER BY id DESC LIMIT 1");
  ok(/No pude comprobar/.test(revA6) && !revA6.includes(`${MARCA}-A6`), 'ADA recibe "no pude comprobar el acceso", sin contenido');
  ok(sql("SELECT estado FROM extracciones WHERE archivo_id='A6'") === 'valida', 'un error temporal NO invalida la extracción (no es pérdida de permiso)');
  await ctl('/control/fallas', { meta: 1 });
  r = await lee([[{ id: 'A6' }]]);
  ok(/1 desde lo guardado/.test(r.texto), 'una falla y el reintento controlado funciona: se reutiliza');
  await ctl('/control/fallas', { meta403: 1 });
  r = await lee([[{ id: 'A6' }]]);
  ok(/1 desde lo guardado/.test(r.texto) && sql("SELECT estado FROM extracciones WHERE archivo_id='A6'") === 'valida', '403 por límite de uso de Google: se trata como temporal (reintento), no como pérdida de permiso');
  ok(nEventos('reintento', "AND archivo_id='A6'") === 3 && nEventos('verificacion_fallida', "AND archivo_id='A6'") === 1, `reintentos justificados registrados (A6: ${nEventos('reintento', "AND archivo_id='A6'")}) y 1 verificación fallida`);
  await ctl('/control/fallas', { descarga: 1 });
  await lee([[{ id: 'A9' }]]);
  ok(sql("SELECT estado FROM extracciones WHERE archivo_id='A9'") === 'valida' && nEventos('reintento', "AND archivo_id='A9' AND motivo LIKE 'descarga%'") === 1, 'descarga con falla temporal: 1 reintento y queda guardada');

  // ===== 7. Sin acceso cruzado entre usuarios =====
  const inv = await post('/api/usuarios', { nota: 'Prueba 3b' });
  const tkInv = await login(3200, 'Invitada', inv.d.clave);
  r = await api('/api/extracciones', {}, 3200, tkInv);
  ok(r.status === 403, `invitada: no puede ver documentos guardados (${r.status})`);
  r = await post('/api/extracciones/consentimiento', { acepto: true }, 3200, tkInv);
  ok(r.status === 403, 'invitada: no puede activar el guardado (solo cuenta principal)');
  st0 = await stats();
  r = await lee([[{ id: 'A1' }]], { tk: tkInv });
  st1 = await stats();
  const baseInv = `ada_u${inv.d.id}`;
  ok(r.status === 200 && descargasDe(st1, 'A1') === descargasDe(st0, 'A1') + 1, 'invitada leyendo el mismo archivo: NO recibe lo guardado de Cristian (descarga propia)');
  ok(Number(sql('SELECT COUNT(*) FROM extracciones', baseInv)) === 0, 'y en su base no se guarda nada');
  ok(Number(sql(`SELECT COUNT(*) FROM extracciones WHERE usuario_id <> 1`)) === 0, 'la base de Cristian solo tiene extracciones de Cristian');

  // ===== 8. Cifradas y fuera de los logs =====
  const filas = sql("SELECT texto_cifrado FROM extracciones WHERE texto_cifrado IS NOT NULL").split('\n');
  ok(filas.length >= 5 && filas.every((f) => /^v1:[0-9a-f]{8}:/.test(f) && !f.includes(MARCA)), `extracciones cifradas (AES-256-GCM, ${filas.length} filas, sin texto en claro)`);
  const todoBD = execSync(`mysqldump -uada -pada ada 2>/dev/null`).toString();
  const enClaro = (todoBD.match(new RegExp(`${MARCA}-A\\d`, 'g')) || []).length;
  ok(enClaro === 0, `volcado completo de la base: el texto de los documentos no aparece en claro (${enClaro})`);

  // ===== 9. Caducidad a 30 días y borrado voluntario =====
  sql(`UPDATE extracciones SET vence_en = '${local(-60e3)}' WHERE archivo_id='A9'`);
  st0 = await stats();
  r = await lee([[{ id: 'A9' }]]);
  ok(descargasDe(await stats(), 'A9') === descargasDe(st0, 'A9') + 1 && nEventos('vencida', "AND archivo_id='A9'") === 1, 'vencida (más de 30 días): no se usa y se extrae de nuevo');
  const venceDias = Number(sql("SELECT ROUND(TIMESTAMPDIFF(HOUR, extraido_en, vence_en)/24) FROM extracciones WHERE archivo_id='A9' AND estado='valida'"));
  ok(venceDias === 30, `cada extracción vence a los ${venceDias} días`);
  sql(`UPDATE extracciones SET vence_en = '${local(-86400e3)}' WHERE archivo_id='A3'`);
  await parar('A'); await arrancar('A', 3200);
  ok(Number(sql("SELECT COUNT(*) FROM extracciones WHERE archivo_id='A3'")) === 0, 'la limpieza al arrancar borra las vencidas');
  r = await api('/api/extracciones/A2', { method: 'DELETE' });
  ok(r.d.borradas === 1 && Number(sql("SELECT COUNT(*) FROM extracciones WHERE archivo_id='A2'")) === 0, 'borrar un documento guardado');
  r = await api('/api/extracciones');
  ok(r.status === 200 && r.d.documentos >= 4 && !JSON.stringify(r.d).includes(MARCA), `Ajustes: ${r.d.documentos} documentos guardados, sin mostrar contenido`);
  r = await api('/api/extracciones', { method: 'DELETE' });
  ok(r.d.borradas >= 4 && Number(sql('SELECT COUNT(*) FROM extracciones')) === 0, `borrado voluntario de todo (${r.d.borradas})`);

  // ===== 10. Copias "ADA temporal": confirmación, reintento y registro =====
  await ctl('/control/reset', {});
  await ctl('/control/fallas', { borrado: 1 });
  await lee([[{ id: 'A7' }]]);
  st = await stats();
  ok(st.vivos.length === 0 && st.borrado_fallido === 1 && st.borrados === 1, 'falla al borrar la copia: reintento controlado y queda borrada');
  await ctl('/control/fallas', { borrado: 2 });
  await api('/api/extracciones/A7', { method: 'DELETE' });
  await lee([[{ id: 'A7' }]]);
  st = await stats();
  ok(st.vivos.length === 1 && Number(sql("SELECT COUNT(*) FROM temporales_drive WHERE estado='pendiente'")) === 1 && nEventos('temporal_fallido') === 1, 'dos fallas: la copia queda anotada como pendiente y el fallo registrado');
  // Una fila falsa que apunta a un ORIGINAL (sin la marca de ADA) nunca se borra.
  sql("INSERT INTO temporales_drive (usuario_id, copia_id, original_id, nombre, estado, creado_en, actualizado_en) VALUES (1, 'A1', 'X', 'ADA temporal - trampa', 'pendiente', NOW(), NOW())");
  r = await post('/api/extracciones/temporales/reintentar');
  st = await stats();
  ok(r.d.borrados === 1 && r.d.omitidos === 1 && st.vivos.length === 0 && st.existe.A1 === true, `reintento manual: borra la copia propia (${r.d.borrados}) y NO toca el original sin marca (${r.d.omitidos} omitido)`);

  // ===== 11. Simultáneos: una sola descarga (mismo proceso y dos procesos) =====
  await ctl('/control/fallas', { retardo_ms: 1200, retardo_ids: ['A8'] });
  await ctl('/control/reset', {});
  const t = await post('/api/trabajos', { titulo: 'Extraer A8', presupuesto: 1, pasos: [{ clave: 'extraer:A8', tipo: 'extraer', entrada: { archivo_id: 'A8' } }] });
  await post(`/api/trabajos/${t.d.id}/aprobar`);
  await dormir(450);
  r = await lee([[{ id: 'A8' }]]);
  await dormir(1500);
  st = await stats();
  ok(descargasDe(st, 'A8') === 1, `chat y encargo piden A8 al mismo tiempo: 1 descarga (${descargasDe(st, 'A8')})`);
  ok(nEventos('reutilizacion', "AND archivo_id='A8' AND motivo IN ('simultanea','otro_proceso')") >= 1, 'el segundo pedido esperó y reutilizó');
  // Dos instancias del servidor (como durante un despliegue).
  await arrancar('B', 3201);
  tokens.b = await login(3201);
  await ctl('/control/archivos', { archivos: [doc('B1', 'B1_Doble.pdf', PDF)] });
  await ctl('/control/fallas', { retardo_ms: 1200, retardo_ids: ['B1'] });
  const [x1, x2] = await Promise.all([lee([[{ id: 'B1' }]]), lee([[{ id: 'B1' }]], { puerto: 3201, tk: tokens.b })]);
  st = await stats();
  ok(x1.status === 200 && x2.status === 200 && descargasDe(st, 'B1') === 1, `dos procesos piden B1 a la vez: 1 descarga (${descargasDe(st, 'B1')}); el otro reutiliza`);
  await parar('B');
  await ctl('/control/fallas', { retardo_ms: 0, retardo_ids: [] });
  const tv = await api(`/api/trabajos/${t.d.id}?resultado=1`);
  ok(tv.d.estado === 'completado' && !JSON.stringify(tv.d).includes(MARCA), `el encargo terminó y su resultado guarda solo metadatos (${tv.d.estado})`);

  // ===== 12. Registro: cada extracción nueva y cada reutilización =====
  const desde12 = desdeUltimo();
  await ctl('/control/reset', {});
  await lee([[{ id: 'A1' }, { id: 'A1', desde: 10 }]]); // nueva + reutilización
  ok(nEventos('extraccion_nueva', `AND id > ${desde12} AND archivo_id='A1'`) === 1 && nEventos('reutilizacion', `AND id > ${desde12} AND archivo_id='A1'`) === 1 && nEventos('lectura_tramo', `AND id > ${desde12} AND archivo_id='A1'`) === 2,
    'cada extracción nueva, reutilización y tramo leído queda registrado (sin texto)');
  ok(sql(`SELECT COUNT(*) FROM extraccion_eventos WHERE id > ${desde12} AND (turno_id IS NULL OR conversacion_id IS NULL) AND tipo IN ('extraccion_nueva','reutilizacion')`) === '0', 'con su conversación y turno');
  ok(Number(sql("SELECT COUNT(*) FROM extraccion_eventos WHERE trabajo_id IS NOT NULL AND paso_id IS NOT NULL AND tipo IN ('extraccion_nueva','reutilizacion','descarga')")) >= 1, 'y en encargos, con su trabajo y paso');

  // ===== 13. Motor sin Drive simulado: no lee documentos reales =====
  await arrancar('R', 3202, { ADA_DRIVE_URL: '' });
  const tkR = await login(3202);
  const tr = await post('/api/trabajos', { titulo: 'Real', presupuesto: 1, pasos: [{ clave: 'extraer:real', tipo: 'extraer', entrada: { archivo_id: 'cualquiera' }, max_intentos: 1 }] }, 3202, tkR);
  await post(`/api/trabajos/${tr.d.id}/aprobar`, {}, 3202, tkR);
  await dormir(2500);
  const pr = sql(`SELECT CONCAT(estado,'|',error) FROM trabajo_pasos WHERE trabajo_id='${tr.d.id}'`);
  ok(/^fallido\|Los encargos/.test(pr) && /documentos reales/.test(pr), `sin Drive simulado ni carpeta de prueba aprobada, el encargo no lee documentos (${pr.slice(0, 60)})`);
  await post(`/api/trabajos/${tr.d.id}/cancelar`, {}, 3202, tkR);
  await parar('R');

  // ===== 13b. Apagado por defecto (producción sin ADA_EXTRACCIONES=si) =====
  await parar('A');
  await arrancar('O', 3203, { ADA_EXTRACCIONES: '' });
  const tkO = await login(3203);
  sql('DELETE FROM extracciones');
  r = await lee([[{ id: 'A1' }]], { puerto: 3203, tk: tkO });
  ok(r.status === 200 && !r.eventos.some((e) => e.tipo === 'consentimiento_extracciones') && sql('SELECT COUNT(*) FROM extracciones') === '0' && /1 lecturas/.test(r.texto),
    'sin ADA_EXTRACCIONES=si: lee igual, no pregunta y no guarda nada');
  await parar('O');
  // Modo "prueba": solo guarda archivos de la carpeta de prueba aprobada, aunque se pidan directo por id.
  await ctl('/control/archivos', { archivos: [{ ...doc('Z1', 'Z1_fuera.pdf', PDF), parents: ['otra-carpeta'] }, { ...doc('Z2', 'Z2_subcarpeta.pdf', PDF), parents: ['subcarpeta-de-prueba'] }] });
  sql("DELETE FROM integraciones WHERE nombre='extracciones_consentimiento'");
  sql('DELETE FROM extracciones');
  await arrancar('P', 3204, { ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba' });
  const tkP = await login(3204);
  r = await chat('ESTADO GUARDADO', { puerto: 3204, tk: tkP });
  const est = JSON.parse(r.texto.replace('ESTADO=', ''));
  ok(est.modo === 'prueba' && est.cifrado_listo === true && est.carpeta_prueba_configurada === true && est.carpeta_prueba_termina_en === 'prueba' && est.consentimiento === 'sin_responder' && est.puede_guardar === false && /tarjeta de consentimiento/.test(est.siguiente_paso),
    `ADA puede consultar al servidor si puede seguir (estado_guardado_documentos): modo ${est.modo}, cifrado listo, carpeta configurada, consentimiento ${est.consentimiento}`);
  ok(!/prueba3b-|ADA_CLAVE|DATABASE_URL/.test(r.texto), 'el estado no muestra claves ni variables');
  let s0 = await stats();
  r = await lee([[{ id: 'Z1' }, { id: 'Z2' }]], { puerto: 3204, tk: tkP });
  let s1 = await stats();
  ok(!r.eventos.some((e) => e.tipo === 'consentimiento_extracciones') && sql('SELECT COUNT(*) FROM extracciones') === '0', 'modo prueba, archivos fuera de la carpeta pedidos por id (y uno en una subcarpeta): no pide consentimiento ni guarda');
  ok(/Estados=leido_sin_guardar:fuera_de_prueba:carpeta=false,leido_sin_guardar:fuera_de_prueba:carpeta=false/.test(r.texto), `ADA recibe el motivo: ${r.texto.split('Estados=')[1]}`);
  r = await lee([[{ id: 'A1' }]], { puerto: 3204, tk: tkP });
  ok(r.eventos.filter((e) => e.tipo === 'consentimiento_extracciones').length === 1 && sql('SELECT COUNT(*) FROM extracciones') === '0' && /consentimiento_pendiente:carpeta=true/.test(r.texto),
    'archivo de la carpeta de prueba: aparece la tarjeta real de consentimiento y nada se guarda antes de aceptar');
  await post('/api/extracciones/consentimiento', { acepto: true }, 3204, tkP);
  s0 = await stats();
  r = await lee([[{ id: 'A1' }]], { puerto: 3204, tk: tkP });
  ok(/Estados=extraccion_nueva_guardada:carpeta=true/.test(r.texto) && descargasDe(await stats(), 'A1') === descargasDe(s0, 'A1') + 1, 'primera lectura tras aceptar: una descarga y extracción nueva guardada');
  s0 = await stats();
  r = await lee([[{ id: 'A1' }, { id: 'Z1' }]], { puerto: 3204, tk: tkP });
  s1 = await stats();
  ok(/Estados=reutilizada:carpeta=true,leido_sin_guardar:fuera_de_prueba:carpeta=false/.test(r.texto) && descargasDe(s1, 'A1') === descargasDe(s0, 'A1') && descargasDe(s1, 'Z1') === descargasDe(s0, 'Z1') + 1,
    'segunda lectura: A1 reutilizada sin descargar; Z1 (fuera) se lee sin guardar ni reutilizar');
  ok(sql("SELECT GROUP_CONCAT(archivo_id) FROM extracciones") === 'A1', 'en la base solo queda A1 (la carpeta de prueba)');
  r = await api('/api/extracciones', {}, 3204, tkP);
  ok(r.d.modo === 'prueba' && r.d.carpeta_prueba_termina_en === 'prueba', 'Ajustes muestra el modo del servidor y el final del id de la carpeta');
  await parar('P');
  await arrancar('A', 3200);

  // ===== 14. Logs del servidor sin texto de documentos =====
  await parar('A');
  const log = logs.join('\n');
  ok(!log.includes(MARCA), `logs de los servidores: sin texto de documentos (${log.length} caracteres revisados)`);
  fs.writeFileSync(`${S}/resultado-extracciones.txt`, resultados.join('\n') + '\n');
  procesos.drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch(async (e) => { console.error(e); for (const k of Object.keys(procesos)) { try { procesos[k].kill(); } catch (_) {} } for (const k of Object.keys(procesos)) if (procesos[k].log) console.error(k, procesos[k].log.slice(-2000)); process.exit(1); });
