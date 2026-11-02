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

// Caso real: la IA etiquetó como «34 a)» un texto que en el documento está dentro del 32 (servicio externo de
// reprocesamiento). Se comprueba la ubicación de cada cita en el texto original y se quita del 34.
const guia3 = [
  '-- 1 32 SERVICIO EXTERNO DE REPROCESAMIENTO Si el reprocesamiento de dispositivos médicos se realiza en un servicio externo, presentar la autorización sanitaria de ese servicio externo.',
  '-- 1 33 REGISTRO ENO Corresponde al registro de enfermedades de notificación obligatoria.',
  '-- 1 34 DIRECTOR TÉCNICO Presentar la carta de aceptación del director técnico.', 'b) Presentar el certificado de título del director técnico.',
  '-- 1 35 PLANO Presentar el plano de evacuación.',
].join('\n');
const b3 = [{ bloque: 1, requisitos: [
  { referencia: '32', texto: 'Autorización sanitaria del servicio externo de reprocesamiento.', cita: 'presentar la autorización sanitaria de ese servicio externo' },
  { referencia: '33', texto: 'Registro ENO.', cita: 'Corresponde al registro de enfermedades de notificación obligatoria.' },
  { referencia: '34 a)', texto: 'Autorización sanitaria del servicio externo de reprocesamiento de dispositivos médicos.', cita: 'Si el reprocesamiento de dispositivos médicos se realiza en un servicio externo' },
  { referencia: '34 b)', texto: 'Carta de aceptación del director técnico.', cita: 'Presentar la carta de aceptación del director técnico.' },
  { referencia: '34 c)', texto: 'Certificado de título del director técnico.', cita: 'Presentar el certificado de título del director técnico.' },
  { referencia: '35', texto: 'Plano de evacuación.', cita: 'Presentar el plano de evacuación.' },
] }];
const g3 = listaRango(b3, { desde: 32, hasta: 35 }, guia3);
const t34 = g3.requisitos.find((x) => x.id === '34');
ok(g3.ubicacion.reubicados.length === 1 && g3.ubicacion.reubicados[0].referencia === '34 a)' && g3.ubicacion.reubicados[0].esta_en === 32 && g3.ubicacion.reubicados[0].destino === 'ya_estaba' && !g3.requisitos.find((x) => x.id === '32').subapartados && /^a\) Carta de aceptación.*; b\) Certificado de título/.test(t34.texto) && !/reprocesamiento/.test(t34.texto) && /carta de aceptación/i.test(t34.texto) && /certificado de título/i.test(t34.texto),
  `«34 a)» con texto del 32 sale del 34 y, como el 32 ya lo pide, no se repite; 34 queda: «${t34.texto}»`);
ok(g3.ubicacion.comprobados === 5 && !g3.ubicacion.sin_comprobar.length && g3.requisitos.length === 4, `los demás apartados se comprobaron en su número (${g3.ubicacion.comprobados})`);
// Y en la guía anterior (sin errores) no se quita nada.
ok(!listaRango(b2, { desde: 31, hasta: 47 }, guia).ubicacion.reubicados.length, 'si cada cita está en su número, no se quita nada');

// Caso real 2: «24 b)» (pabellón de cirugía mayor ambulatoria) está en el original dentro del 25. Se MUEVE al 25 (no
// desaparece). Y si el 25 no tuviera ítems extraídos, queda dentro de su texto completo tomado de la norma.
const guia4 = [
  '-- 1 24 CARRO DE PARO Contar con un procedimiento de uso y revisión del carro de paro.',
  '-- 1 25 PABELLÓN DE CIRUGÍA MAYOR AMBULATORIA Contar con sala de recuperación.', 'Todo establecimiento de salud que quiera autorizar una unidad de pabellón de cirugía mayor ambulatoria deberá contar con evaluación anestésica y evaluación de condiciones sociales del paciente.',
  '-- 1 26 ESTERILIZACIÓN Contar con registro de esterilización.',
].join('\n');
const item24b = { referencia: '24 b)', texto: 'Evaluación anestésica y de condiciones sociales del paciente para cirugía mayor ambulatoria.', cita: 'Todo establecimiento de salud que quiera autorizar una unidad de pabellón de cirugía mayor ambulatoria' };
const b4 = [{ bloque: 1, requisitos: [
  { referencia: '24 a)', texto: 'Procedimiento del carro de paro.', cita: 'Contar con un procedimiento de uso y revisión del carro de paro.' }, item24b,
  { referencia: '25', texto: 'Sala de recuperación.', cita: 'Contar con sala de recuperación.' },
  { referencia: '26', texto: 'Registro de esterilización.', cita: 'Contar con registro de esterilización.' },
] }];
const g4 = listaRango(b4, { desde: 24, hasta: 26 }, guia4);
const r25 = g4.requisitos.find((x) => x.id === '25'); const r24 = g4.requisitos.find((x) => x.id === '24');
ok(r24.texto === 'Procedimiento del carro de paro.' && /Sala de recuperación/.test(r25.texto) && /evaluación anestésica/i.test(r25.texto) && g4.ubicacion.reubicados[0].destino === 'movido' && /25 PABELLÓN DE CIRUGÍA/.test(g4.ubicacion.reubicados[0].encabezado),
  `«24 b)» se mueve al 25 (donde está en el original), no desaparece: 25 = «${r25.texto}»`);
const b5 = [{ bloque: 1, requisitos: b4[0].requisitos.filter((x) => x.referencia !== '25') }];
const g5 = listaRango(b5, { desde: 24, hasta: 26 }, guia4);
ok(g5.ubicacion.reubicados[0].destino === 'en_texto_completo' && /evaluación anestésica/.test(g5.requisitos.find((x) => x.id === '25').texto), 'si el 25 no tenía ítems extraídos, la exigencia queda dentro de su texto completo tomado de la norma');

// Búsqueda exacta de una frase en el original: entre qué encabezados está (la frase cruza saltos de línea).
const { _buscarFrase: buscarFrase } = require('../../src/auditoria');
const guia6 = [
  '-- 1 24 CARRO DE PARO Contar con un procedimiento de uso y revisión del carro de paro.',
  '-- 1 25 PABELLÓN DE CIRUGÍA MAYOR AMBULATORIA Contar con una unidad de pabellón de cirugía mayor ambulatoria con sala de recuperación.',
  'Todo establecimiento de salud que quiera autorizar una unidad de pabellón de cirugía mayor ambulatoria debe incluir en su solicitud un documento con la evaluación',
  'anestésica y la evaluación de condiciones sociales del paciente, que permita identificar si existen condiciones para un proceso de recuperación post quirúrgica adecuado en su domicilio.',
  '-- 1 26 ESTERILIZACIÓN Contar con registro de esterilización.',
].join('\n');
const frase = 'Todo establecimiento de salud que quiera autorizar una unidad de pabellón de cirugía mayor ambulatoria debe incluir en su solicitud un documento con la evaluación anestésica y la evaluación de condiciones sociales del paciente, que permita identificar si existen condiciones para un proceso de recuperación post quirúrgica adecuado en su domicilio';
const bf = buscarFrase(guia6, frase);
ok(bf.coincidencia === 'completa' && bf.encontrados.length === 1 && bf.encontrados[0].entre.anterior.numero === 25 && bf.encontrados[0].entre.siguiente.numero === 26 && /^25 PABELLÓN/.test(bf.encontrados[0].entre.anterior.encabezado),
  `frase completa encontrada entre «${bf.encontrados[0].entre.anterior.encabezado.slice(0, 40)}…» y «${bf.encontrados[0].entre.siguiente.encabezado.slice(0, 30)}…»`);
ok(buscarFrase(guia6, 'esta frase no existe en ninguna parte del documento').coincidencia === 'no_encontrada', 'una frase que no está en el original se informa como no encontrada');
// El 25 ya tiene un ítem con palabras parecidas (pabellón de cirugía mayor ambulatoria) pero es OTRA oración: el 24 b)
// movido se agrega; antes se descartaba por "parecido" y la exigencia se perdía.
const b6 = [{ bloque: 1, requisitos: [
  { referencia: '24 a)', texto: 'Procedimiento del carro de paro.', cita: 'Contar con un procedimiento de uso y revisión del carro de paro.' },
  { referencia: '24 b)', texto: 'Documento con evaluación anestésica y evaluación de condiciones sociales del paciente para cirugía mayor ambulatoria.', cita: 'Todo establecimiento de salud que quiera autorizar una unidad de pabellón de cirugía mayor ambulatoria' },
  { referencia: '25', texto: 'Unidad de pabellón de cirugía mayor ambulatoria con sala de recuperación.', cita: 'Contar con una unidad de pabellón de cirugía mayor ambulatoria con sala de recuperación.' },
  { referencia: '26', texto: 'Registro de esterilización.', cita: 'Contar con registro de esterilización.' },
] }];
const g6 = listaRango(b6, { desde: 24, hasta: 26 }, guia6);
const t25 = g6.requisitos.find((x) => x.id === '25').texto;
ok(g6.ubicacion.reubicados[0].destino === 'movido' && /sala de recuperación/.test(t25) && /evaluación anestésica/.test(t25) && g6.requisitos.length === 3, `aunque el 25 tenga palabras parecidas, la exigencia distinta se agrega (no se pierde): 25 = «${t25}»`);
