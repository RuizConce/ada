// Informes Word completos (corrección tras la prueba H real: la recomendación de R5 quedó "Revisar cómo se l").
//  1. Comprobación del Word (unitaria): detecta líneas ausentes, cortadas o a media frase.
//  2. Auditoría H con la IA devolviendo una recomendación cortada, una respuesta cortada por largo, o siempre cortada:
//     el informe que se entrega nunca trae texto incompleto.
const { spawn, execSync } = require('child_process');
const S = __dirname;
const H = require('../datos-ficticios/prueba-h.json');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://ada:ada@localhost:3306/ada';
const A = require('../../src/archivos');
const ctl = async (ruta, body) => (await fetch(`http://localhost:9933${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let srv; let tk;
async function arrancar(extra) {
  srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: `${S}/../..`, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago', ADA_CLAVE_DATOS: 'word-completo-clave-0123456789-abcdefghijklmnopq',
      ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_TRABAJO_CICLO_MS: '200', ADA_TURNOS_2MIN: '100', ADA_TOPE_DIARIO: '1000',
      FAKE_H: require.resolve('../datos-ficticios/prueba-h.json'), ...extra } });
  srv.log = ''; srv.stdout.on('data', (d) => { srv.log += d; }); srv.stderr.on('data', (d) => { srv.log += d; });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
}
const api = async (ruta, op = {}) => { const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
const post = (ruta, body) => api(ruta, { method: 'POST', body: JSON.stringify(body || {}) });
async function proponer(input) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: JSON.stringify({ mensaje: `[${Date.now()}] HERR ${JSON.stringify({ llamadas: [{ name: 'proponer_auditoria', input }] })}`, tarjetas: ['auditoria_propuesta@1'] }) });
  return (await r.text()).split('\n\n').filter((b) => b.startsWith('event: auditoria_propuesta')).map((b) => JSON.parse(b.split('\n')[1].slice(6)))[0];
}
async function esperar(id) { for (let i = 0; i < 300; i++) { const a = (await api(`/api/auditorias/${id}/avance`)).d; if (['completado', 'bloqueado', 'cancelado'].includes(a.estado)) return a; await dormir(200); } return null; }
async function auditoriaH() {
  let p = await proponer({ norma_id: 'HN', carpeta_id: 'carpeta-prueba' });
  let r = await post(`/api/auditorias/propuestas/${p.id}/aprobar`, { presupuesto: p.presupuesto_sugerido });
  const a = await esperar(r.d.trabajo_id);
  p = (await api('/api/auditorias/propuestas')).d.find((x) => x.id === a.lista_propuesta.propuesta_id);
  r = await post(`/api/auditorias/propuestas/${p.id}/aprobar`, { presupuesto: p.presupuesto_sugerido });
  const fin = await esperar(r.d.trabajo_id);
  const e = await post('/api/descargas', { tipo: 'auditoria_informe', id: r.d.trabajo_id });
  const buf = e.status === 200 ? Buffer.from(await (await fetch(`http://localhost:3200${e.d.url}`)).arrayBuffer()) : null;
  const t = (await api(`/api/trabajos/${r.d.trabajo_id}?resultado=1`)).d;
  return { fin, buf, t, id: r.d.trabajo_id };
}
const recsDe = async (buf) => { const p = await A.textoDeWord(buf); const i = p.findIndex((x) => x === '4. Recomendaciones'); const j = p.findIndex((x) => x === '5. Método y límites'); return p.slice(i + 2, j); };

(async () => {
  // ---- 1. Comprobación del Word ----
  const md = '## Hallazgos\n- R5 (prioridad alta): Revisar cómo se l\n- R6 (prioridad alta): Habilitar un recinto exclusivo y señalizado.\n| Estado | N |\n| --- | --- |\n| Cumple | 3 |';
  const buf = await A.crearWord({ titulo: 'Prueba', contenido: md });
  let c = await A.comprobarWord(buf, { titulo: 'Prueba', contenido: md }, { estricto: true });
  ok(!c.ok && c.problemas.some((x) => /termina a media frase: «…R5 \(prioridad alta\): Revisar cómo se l»/.test(x)), `estricto: detecta "Revisar cómo se l" (${c.problemas[0]})`);
  c = await A.comprobarWord(buf, { titulo: 'Prueba', contenido: md });
  ok(c.ok && c.advertencias.length === 1, 'no estricto (Word del chat): lo entrega con una advertencia para ADA');
  const otro = await A.crearWord({ titulo: 'Prueba', contenido: md.replace('señalizado.', 'señal') });
  c = await A.comprobarWord(otro, { titulo: 'Prueba', contenido: md });
  ok(!c.ok && c.problemas.some((x) => /incompleto o ausente/.test(x)), `si el Word no trae una línea completa, no se entrega (${c.problemas[0]})`);
  const bien = md.replace('Revisar cómo se l', 'Revisar cómo se lleva el registro de validación y renovarla.');
  c = await A.comprobarWord(await A.crearWord({ titulo: 'Prueba', contenido: bien }), { titulo: 'Prueba', contenido: bien }, { estricto: true });
  ok(c.ok && !c.problemas.length, 'un Word completo pasa la comprobación estricta');

  // ---- 2. Auditoría H con recomendaciones defectuosas ----
  try { execSync('service mariadb status >/dev/null 2>&1 || service mariadb start', { stdio: 'ignore' }); } catch (_) {}
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql('DELETE FROM extracciones'); sql('DELETE FROM auditoria_propuestas');
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await ctl('/control/archivos', { archivos: [
    { id: 'carpeta-prueba', name: 'Prueba ADA', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    { id: 'HN', name: H.norma.nombre, mimeType: 'application/pdf', texto: H.norma.texto, md5Checksum: 'hn', version: 1, parents: ['carpeta-prueba'] },
    ...H.documentos.map((d) => ({ id: d.id, name: d.nombre, mimeType: 'application/pdf', texto: d.texto, md5Checksum: d.id, version: 1, parents: ['carpeta-prueba'] })),
  ] });
  try {
    for (const [modo, espera] of [['cortada_una_vez', 'IA'], ['max_tokens_una_vez', 'IA'], ['siempre_cortada', 'plantilla']]) {
      await arrancar({ FAKE_H_REC: modo });
      const { fin, buf: w, t, id } = await auditoriaH();
      const recs = w ? await recsDe(w) : [];
      const r5 = recs.find((x) => x.startsWith('R5 ('));
      const llamadasInf = sql(`SELECT COUNT(*) FROM llamadas_ia l JOIN trabajo_pasos p ON p.id = l.paso_id WHERE l.trabajo_id='${id}' AND p.clave='informe'`);
      ok(fin.estado === 'completado' && !recs.some((x) => /Revisar cómo se l$/.test(x)) && recs.length === 5 && recs.every((x) => /[.!?…)»"”]$/.test(x)) && t.resultado.informe.origen_recomendaciones.startsWith(espera),
        `${modo}: informe entregado sin texto cortado (${recs.length} recomendaciones completas, origen ${t.resultado.informe.origen_recomendaciones}, ${llamadasInf} llamadas al informe); R5: «${(r5 || '').slice(0, 60)}»`);
      srv.kill(); await dormir(600);
    }
  } catch (e) { ok(false, `excepción: ${e.stack}`); console.log(srv.log.slice(-3000)); }
  try { srv.kill(); } catch (_) {}
  drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
  setTimeout(() => process.exit(), 300);
})();
