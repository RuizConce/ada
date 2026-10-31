// Lista por número (rango): subapartados dentro de su fila, números con el mismo texto no se pierden, un número que la
// IA no separó se toma literalmente de la norma y uno que no está en la norma se informa como ausente (no se inventa).
process.env.ADA_CLAVE_DATOS = 'x'.repeat(40); process.env.DATABASE_URL = 'mysql://ada:ada@localhost:3306/ada';
const { _listaRango: listaRango } = require('../../src/auditoria');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const norma = ['Página 1', '18. Contar con nómina del personal.', '19. Contar con registro de capacitaciones.', '20. Contar con registro de capacitaciones.',
  '21. Equipos:', 'a) Programa de mantención.', 'b) Registro de mantenciones.', '23. Contar con plan de emergencia.', 'Nota final: fin.'].join('\n');
const bloques = [{ bloque: 1, requisitos: [
  { referencia: '18', texto: 'Contar con nómina del personal.', cita: 'Contar con nómina del personal.' },
  { referencia: '19', texto: 'Contar con registro de capacitaciones.', cita: 'Contar con registro de capacitaciones.' },
  { referencia: '20', texto: 'Contar con registro de capacitaciones.', cita: 'Contar con registro de capacitaciones.' },
  { referencia: '21 a)', texto: 'Programa de mantención.', cita: 'Programa de mantención.' },
  { referencia: '21 b)', texto: 'Registro de mantenciones.', cita: 'Registro de mantenciones.' },
] }];
const r = listaRango(bloques, { desde: 18, hasta: 23 }, norma);
ok(r.requisitos.map((x) => x.id).join(',') === '18,19,20,21,23', `filas: ${r.requisitos.map((x) => x.id).join(',')}`);
ok(r.requisitos.find((x) => x.id === '20'), '19 y 20 tienen el mismo texto: ninguno se pierde como "duplicado"');
ok(r.requisitos.find((x) => x.id === '21').texto === 'a) Programa de mantención; b) Registro de mantenciones.' && r.subapartados.join() === '21 (21a, 21b)', '21 a) y 21 b) en una sola fila');
ok(r.recuperados.join() === '23' && /copiado literalmente/.test(r.requisitos.find((x) => x.id === '23').fuente), '23 (no extraído por la IA) se toma literalmente de la norma');
ok(r.faltantes.join() === '22', '22 no está en la norma: se informa como ausente, no se inventa');
setTimeout(() => process.exit(), 200);
