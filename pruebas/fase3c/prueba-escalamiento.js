// Fase 3c: reglas de escalamiento de K3 con seis casos ficticios de tipos distintos (prueba B).
// Las respuestas de Haiku y Sonnet son simuladas: esto prueba CUÁNDO se escala, no la precisión real.
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const S = __dirname;
const B = '/home/claude/ada/pruebas/datos-ficticios/prueba-b.json';
const datos = require(B);
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`mysql -uada -pada ada -N -B -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString().trim();
(async () => {
  sql("UPDATE trabajos SET estado='cancelado' WHERE estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado')");
  sql(`INSERT INTO integraciones (nombre, datos, actualizado_en) VALUES ('extracciones_consentimiento', '{"estado":"aceptado","fecha":"2026-10-29T00:00:00Z","version":1}', NOW()) ON DUPLICATE KEY UPDATE datos = VALUES(datos)`);
  const drive = spawn('node', [`${S}/../fase3b/fake-drive.js`, '9933'], { stdio: 'ignore' });
  await dormir(500);
  await fetch('http://localhost:9933/control/archivos', { method: 'POST', body: JSON.stringify({ archivos: [{ id: 'DEMO1', name: datos.documento.nombre, mimeType: 'application/pdf', texto: datos.documento.texto, md5Checksum: 'b1', version: 1, parents: ['carpeta-prueba'] }] }) });
  const srv = spawn('node', ['-r', `${S}/../fase3b/fake-claude-3b.js`, 'src/server.js'], { cwd: '/home/claude/ada', stdio: 'ignore',
    env: { ...process.env, PORT: '3200', DATABASE_URL: 'mysql://ada:ada@localhost:3306/ada', ANTHROPIC_API_KEY: 'fake', ADA_PASSWORD: 'p', ADA_AVISOS: 'no', TZ: 'America/Santiago', FAKE_CASOS: B,
      ADA_CLAVE_DATOS: `e-${crypto.randomBytes(32).toString('base64')}`, ADA_DRIVE_URL: 'http://localhost:9933', ADA_EXTRACCIONES: 'prueba', ADA_DRIVE_CARPETA_PRUEBA: 'carpeta-prueba', ADA_TRABAJO_CICLO_MS: '300' } });
  for (let i = 0; i < 60; i++) { await dormir(200); try { await fetch('http://localhost:3200/api/ajustes'); break; } catch (_) {} }
  const tk = (await (await fetch('http://localhost:3200/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Cristian', password: 'p' }) })).json()).token;
  const api = async (ruta, op = {}) => (await fetch(`http://localhost:3200${ruta}`, { ...op, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` } })).json();
  const correr = async (config) => {
    const est = await api('/api/auditorias/estimar', { method: 'POST', body: JSON.stringify({ archivo_id: 'DEMO1', requisitos: datos.requisitos }) });
    const t = await api('/api/auditorias', { method: 'POST', body: JSON.stringify({ archivo_id: 'DEMO1', requisitos: datos.requisitos, esperado: datos.resultado_correcto, configuracion: config, presupuesto: est.presupuesto_minimo[config] }) });
    let v; for (let i = 0; i < 120; i++) { v = await api(`/api/trabajos/${t.id}?resultado=1`); if (['completado', 'bloqueado'].includes(v.estado)) break; await dormir(250); }
    return v;
  };
  const k2 = await correr('K2');
  const k3 = await correr('K3');
  const k1 = await correr('K1');
  const fila = (v, id) => v.resultado.matriz.filas.find((f) => f.requisito === id);
  console.log('   requisito | correcto | K2 (solo Haiku) | K3 | escaló en K3');
  for (const c of datos.resultado_correcto) console.log(`   ${c.id} | ${c.estado} | ${fila(k2, c.id).estado} | ${fila(k3, c.id).estado} | ${fila(k3, c.id).escalado ? 'sí' : 'no'}`);
  const escalados = datos.requisitos.filter((r) => fila(k3, r.id).escalado).map((r) => r.id);
  ok(k2.estado === 'completado' && k3.estado === 'completado' && k1.estado === 'completado', 'las tres configuraciones completan');
  ok(escalados.join(',') === 'C1,C2,C4,C5', `K3 escala exactamente donde las reglas lo piden: ${escalados.join(', ')} (C1 no_cumple en un requisito "cada"; C2 no_cumple; C4 condicional; C5 justificación "pero faltan…" con "cumple")`);
  ok(!fila(k3, 'C3').escalado && !fila(k3, 'C6').escalado, 'no escala un "cumple" simple bien justificado (C3) ni un "sin evidencia" (C6)');
  ok(fila(k3, 'C1').estado === 'parcial' && fila(k3, 'C5').estado === 'parcial', 'el tipo de error de R2 (no_cumple o cumple donde corresponde parcial) se corrige en K3');
  ok(k2.resultado.precision.aciertos === 4 && k3.resultado.precision.aciertos === 6, `precisión simulada: K2 ${k2.resultado.precision.aciertos}/6, K3 ${k3.resultado.precision.aciertos}/6, K1 ${k1.resultado.precision.aciertos}/6`);
  console.log(`   costo simulado: K2 US$${k2.resultado.costos.real_usd.toFixed(5)} · K3 US$${k3.resultado.costos.real_usd.toFixed(5)} · K1 US$${k1.resultado.costos.real_usd.toFixed(5)}`);
  ok(k3.resultado.costos.real_usd < k1.resultado.costos.real_usd, 'K3 sigue costando menos que K1');
  srv.kill(); drive.kill();
  console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
