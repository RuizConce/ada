// Fase 3b — Réplica del patrón de lecturas de Andaluz (27/10) con 48 documentos ficticios.
// Mismo orden, mismos documentos (renombrados R01..R48) y mismos puntos de inicio que la exportación:
// rondas de 57, 49 y 58 lecturas (164), una con un id inexistente. Después, un encargo con 47 pasos de extracción.
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const S = __dirname;
const R = require(`${S}/replica-andaluz.json`);
const resultados = [];
const ok = (c, m) => { const l = (c ? 'ok - ' : 'FALLA: ') + m; console.log(l); resultados.push(l); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const DRIVE = 'http://localhost:9933';
const procesos = {};
const ctl = async (ruta, body) => (await fetch(`${DRIVE}${ruta}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let token;
async function api(ruta, op = {}) {
  const r = await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch (_) { d = t; }
  return { status: r.status, d };
}
const post = (ruta, body) => api(ruta, { method: 'POST', body: JSON.stringify(body || {}) });
let nonce = 0;
async function chat(mensaje, conv) {
  const r = await fetch('http://localhost:3200/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ mensaje: `[${++nonce}] ${mensaje}`, conversacion_id: conv }) });
  const t = await r.text();
  const ev = t.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { tipo: e.slice(7), d: JSON.parse(d.slice(6)) }; });
  const fin = ev.find((e) => e.tipo === 'fin');
  return { conv: (ev.find((e) => e.tipo === 'conversacion') || { d: {} }).d.conversacion_id, texto: fin ? fin.d.respuesta : t.slice(0, 300) };
}
const lotes = (lecturas, n = 8) => { const out = []; for (let i = 0; i < lecturas.length; i += n) out.push(lecturas.slice(i, i + n).map(([id, desde]) => ({ id, ...(desde ? { desde } : {}) }))); return out; };

(async () => {
  for (const t of ['extraccion_eventos', 'temporales_drive', 'extracciones']) sql(`DELETE FROM ${t}`);
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  procesos.drive = spawn('node', [`${S}/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(600);
  // 47 documentos ficticios que existen (R42 es el id inexistente, como en Andaluz).
  const docs = R.docs.filter((d) => d.id !== R.falla).map((d) => {
    let t = `Documento ficticio ${d.id}. MARCA-REPLICA-${d.id}. `;
    while (t.length < d.largo) t += `Texto de relleno ficticio ${t.length} para ${d.id}. `;
    t = t.slice(0, d.largo);
    const word = !!d.word;
    return { id: d.id, name: `${d.id}_documento_ficticio.${word ? 'docx' : 'pdf'}`, mimeType: word ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf',
      texto: t, md5Checksum: crypto.createHash('md5').update(t).digest('hex'), version: 1 };
  });
  await ctl('/control/archivos', { archivos: docs });
  const largo = docs.find((d) => d.texto.length >= 100000);
  ok(docs.length === 47 && !!largo, `47 documentos ficticios + 1 id inexistente; el largo tiene ${largo.texto.length.toLocaleString('es-CL')} caracteres`);

  const p = spawn('node', ['-r', `${S}/fake-claude-3b.js`, 'src/server.js'], {
    cwd: '/home/claude/ada', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago',
      ADA_CLAVE_DATOS: `replica-${crypto.randomBytes(32).toString('base64')}`, ADA_EXTRACCIONES: 'si', ADA_DRIVE_URL: DRIVE, ADA_TRABAJO_CICLO_MS: '200',
      ADA_TOPE_TURNO: '50', ADA_TOPE_DIARIO: '500', ADA_TOPE_DIARIO_MAX: '1000', ADA_TURNOS_2MIN: '500' },
  });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  procesos.ada = p;
  for (let i = 0; i < 80; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  token = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
  await post('/api/extracciones/consentimiento', { acepto: true });
  await ctl('/control/reset', {});

  // ---- Tres rondas de conversación con el patrón exacto de Andaluz ----
  let conv = null;
  const porRonda = [];
  for (let i = 0; i < R.rondas.length; i++) {
    const antes = await ctl('/control/stats');
    const r = await chat(`LEE ${JSON.stringify({ lotes: lotes(R.rondas[i]) })}`, conv);
    conv = conv || r.conv;
    const despues = await ctl('/control/stats');
    porRonda.push({ lecturas: R.rondas[i].length, descargas: despues.total_descargas - antes.total_descargas, metadatos: despues.total_meta - antes.total_meta, texto: r.texto });
  }
  console.log('   por ronda:', JSON.stringify(porRonda.map((x) => ({ lecturas: x.lecturas, descargas: x.descargas, metadatos: x.metadatos }))));
  const mc = (await api(`/api/extracciones/metricas?conversacion=${conv}`)).d;
  const st = await ctl('/control/stats');
  const copias = Object.values(st.copias).reduce((a, b) => a + b, 0);
  const lecturas = Number(sql(`SELECT COUNT(*) FROM extraccion_eventos WHERE conversacion_id=${conv} AND tipo='lectura_tramo'`));
  ok(lecturas === 163, `163 lecturas servidas + 1 fallida por id inexistente (${lecturas})`);
  ok(mc.documentos_unicos === 48, `documentos únicos consultados: ${mc.documentos_unicos}`);
  ok(st.total_descargas === 47 && mc.descargas === 47, `descargas de contenido: ${st.total_descargas} según Drive simulado, ${mc.descargas} según ADA (una por documento)`);
  ok(mc.extracciones_nuevas === 47, `extracciones nuevas: ${mc.extracciones_nuevas}`);
  ok(mc.reutilizaciones === 116, `reutilizaciones: ${mc.reutilizaciones}`);
  ok(mc.operaciones_redundantes === 0, `operaciones redundantes: ${mc.operaciones_redundantes}`);
  ok(mc.consultas_metadatos === 164 && st.total_meta === 164, `consultas de permisos y versión: ${mc.consultas_metadatos} (Drive: ${st.total_meta}), separadas de las descargas`);
  ok(mc.reintentos_justificados === 0 && mc.sin_acceso === 1, `reintentos: ${mc.reintentos_justificados}; sin acceso: ${mc.sin_acceso} (el id inexistente)`);
  ok(copias === 47 && st.vivos.length === 0, `copias temporales: ${copias} creadas y todas borradas (${st.vivos.length} vivas)`);
  ok(porRonda[1].descargas === 0 && porRonda[2].descargas === 0, `rondas 2 y 3: 0 descargas (${porRonda[1].descargas}, ${porRonda[2].descargas})`);
  const largoLect = Number(sql(`SELECT COUNT(*) FROM extraccion_eventos WHERE conversacion_id=${conv} AND tipo='lectura_tramo' AND archivo_id='${largo.id}'`));
  ok(largoLect === 12 && (st.export[largo.id] || 0) === 1, `el documento de ${largo.texto.length.toLocaleString('es-CL')} caracteres: ${largoLect} lecturas por tramos y 1 sola descarga y conversión`);

  // ---- La conversación recuerda qué leyó ----
  const q = await chat('QUE LEISTE', conv);
  ok(q.texto === 'DOCS=47', `al preguntarle qué leyó, ADA recibe la lista real de documentos (${q.texto}; Andaluz: dijo solo 00_PENDIENTES)`);

  // ---- Encargo: 47 pasos de extracción sobre los mismos documentos ----
  const antesT = await ctl('/control/stats');
  const pasos = docs.map((d) => ({ clave: `extraer:${d.id}`, tipo: 'extraer', etapa: 'extraccion', entrada: { archivo_id: d.id } }));
  const t = await post('/api/trabajos', { titulo: 'Réplica Andaluz (ficticia)', presupuesto: 1, pasos });
  await post(`/api/trabajos/${t.d.id}/aprobar`);
  let v;
  for (let i = 0; i < 150; i++) { await dormir(200); v = (await api(`/api/trabajos/${t.d.id}`)).d; if (['completado', 'bloqueado', 'cancelado'].includes(v.estado)) break; }
  const despuesT = await ctl('/control/stats');
  const mt = (await api(`/api/extracciones/metricas?trabajo=${t.d.id}`)).d;
  ok(v.estado === 'completado', `encargo de 47 pasos: ${v.estado}`);
  ok(despuesT.total_descargas - antesT.total_descargas === 0 && mt.descargas === 0 && mt.reutilizaciones === 47 && mt.operaciones_redundantes === 0,
    `el encargo reutiliza lo que extrajo la conversación: ${despuesT.total_descargas - antesT.total_descargas} descargas, ${mt.reutilizaciones} reutilizaciones, ${mt.operaciones_redundantes} redundantes`);
  ok(Number(v.gastado_usd || 0) === 0 && mt.costo_por_paso_ia.length === 0, `extraer es código, sin IA: US$${Number(v.gastado_usd || 0).toFixed(2)} y 0 llamadas a Claude`);

  const resumen = { andaluz: { lecturas: 164, unicos: 48, fallidas: 1, descargas: 163, extracciones: 163, reutilizaciones: 0, redundantes: 116, entregables: 0 },
    replica: { lecturas: lecturas + 1, unicos: mc.documentos_unicos, fallidas: mc.sin_acceso, metadatos: mc.consultas_metadatos, descargas: mc.descargas, extracciones: mc.extracciones_nuevas, reutilizaciones: mc.reutilizaciones, redundantes: mc.operaciones_redundantes, copias, por_ronda: porRonda.map((x) => x.descargas) },
    encargo: { pasos: 47, descargas: mt.descargas, reutilizaciones: mt.reutilizaciones, redundantes: mt.operaciones_redundantes, metadatos: mt.consultas_metadatos } };
  fs.writeFileSync(`${S}/resultado-replica.json`, JSON.stringify(resumen, null, 2));
  fs.writeFileSync(`${S}/resultado-replica.txt`, resultados.join('\n') + '\n');
  ok(!p.log.includes('MARCA-REPLICA'), 'logs del servidor sin texto de documentos');
  p.kill(); procesos.drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); for (const k of Object.keys(procesos)) { try { procesos[k].kill(); } catch (_) {} } if (procesos.ada) console.error(procesos.ada.log.slice(-2000)); process.exit(1); });
