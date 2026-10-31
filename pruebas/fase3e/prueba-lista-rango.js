// Lista por número (rango): subapartados dentro de su fila, números con el mismo texto no se pierden, un número que la
// IA no separó se toma literalmente de la norma y uno que no está en la norma se informa como ausente (no se inventa).
process.env.ADA_CLAVE_DATOS = 'x'.repeat(40); process.env.DATABASE_URL = 'mysql://ada:ada@localhost:3306/ada';
const { _listaRango: listaRango } = require('../../src/auditoria');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const norma = ['Página 1', '18. Contar con nómina del personal.', '19. Contar con registro de capacitaciones.', '20. Contar con registro de capacitaciones.',
  '21. Equipos:', 'a) Programa de mantención.', 'b) Registro de mantenciones.', '23. Contar con plan de emergencia (ver también el punto 22 del anexo).', 'Nota final: fin.'].join('\n');
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
ok(r.menciones[0].numero === 22 && /punto 22 del anexo/.test(r.menciones[0].fragmentos[0]), `y se muestra dónde aparece el número en el texto: «${r.menciones[0].fragmentos[0]}»`);
const r2 = listaRango(bloques, { desde: 18, hasta: 23 }, norma.replace(' (ver también el punto 22 del anexo)', ''));
ok(r2.menciones[0].fragmentos.length === 0, 'si el número no aparece en ninguna parte del texto, se dice así');
setTimeout(() => process.exit(), 200);

// Formato real de la guía (tabla convertida a texto): «-- 1 32 EN CASO DE QUE…», número en medio de la línea y título
// en MAYÚSCULAS. Se recupera el texto COMPLETO hasta el siguiente requisito, sin los restos de la tabla.
const guia = [
  'Página 4', '-- 1 31 LIBRO DE RECLAMOS Corresponde al libro foliado de reclamos.',
  '-- 1 32 EN CASO DE QUE SE QUIERA AUTORIZAR UN ESTABLECIMIENTO QUE ATIENDA MENORES DE EDAD Corresponde a la autorización del representante legal.',
  'Debe adjuntar:', 'a) Protocolo de atención de menores, aprobado por el director técnico.', 'b) Registro de 2 acompañantes autorizados.',
  '-- 1 33 REGISTRO ENO Corresponde al registro de enfermedades de notificación obligatoria.',
  'Página 9', '-- 1 46 PROTOCOLO EPP Corresponde al protocolo de elementos de protección.',
  '-- 1 47 MANUAL DE NORMAS Y PROCEDIMIENTOS Corresponde a un documento que describe todos los procedimientos clínicos y administrativos', 'del establecimiento, actualizado y firmado por el director técnico.',
].join('\n');
const b2 = [{ bloque: 1, requisitos: [
  { referencia: '31', texto: 'Libro de reclamos foliado.', cita: 'Corresponde al libro foliado de reclamos.' },
  { referencia: '33', texto: 'Registro ENO.', cita: 'Corresponde al registro de enfermedades de notificación obligatoria.' },
  { referencia: '46', texto: 'Protocolo EPP.', cita: 'Corresponde al protocolo de elementos de protección.' },
] }];
const g = listaRango(b2, { desde: 31, hasta: 47 }, guia);
const t32 = (g.requisitos.find((x) => x.id === '32') || {}).texto || '';
const t47 = (g.requisitos.find((x) => x.id === '47') || {}).texto || '';
ok(t32 === 'EN CASO DE QUE SE QUIERA AUTORIZAR UN ESTABLECIMIENTO QUE ATIENDA MENORES DE EDAD Corresponde a la autorización del representante legal. Debe adjuntar: a) Protocolo de atención de menores, aprobado por el director técnico. b) Registro de 2 acompañantes autorizados.',
  `32 completo, con sus subapartados y sin «-- 1» ni el 33: «${t32}»`);
ok(t47 === 'MANUAL DE NORMAS Y PROCEDIMIENTOS Corresponde a un documento que describe todos los procedimientos clínicos y administrativos del establecimiento, actualizado y firmado por el director técnico.', `47 completo (último del documento): «${t47}»`);
const d32 = g.recuperados_detalle.find((x) => x.numero === 32); const d47 = g.recuperados_detalle.find((x) => x.numero === 47);
ok(d32.termina_antes_de === 33 && d47.hasta_el_final && g.recuperados.join() === '32,47', 'la tarjeta puede mostrar dónde empieza y termina cada texto recuperado');
ok(g.faltantes.join() === '34,35,36,37,38,39,40,41,42,43,44,45', 'los números que no están en la guía de prueba siguen informándose como ausentes');
