// Caso real Botiquín Andaluz (trabajo dd8008fd) reproducido: la carpeta tiene archivos numerados para el expediente
// SEREMI ANTERIOR (08_gas, 17_ficha clínica, 04_arriendo, 05_plano…), la auditoría asoció mal algunas citas y una
// evaluación terminó con «respuesta cortada». La revisión (sin IA) debe dejar los 22 requisitos coherentes y el Excel,
// el Word y el plan de copias sin ninguna asociación descartada.
process.env.ADA_CLAVE_DATOS = 'x'.repeat(40); process.env.DATABASE_URL = 'mysql://ada:ada@localhost:3306/ada';
const A = require('../../src/auditoria');
const { crearWord } = require('../../src/archivos');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const T = (req, subir) => `Requisito: ${req}. Qué subir para Andaluz: ${subir}.`;
const ev = (archivo_id, archivo, cita, aporta = 'a_favor') => ({ archivo_id, archivo, cita, verificada: true, aporta, ubicacion: 'página 1' });
const GAS = ev('GAS', '08_NO_APLICA_Instalaciones_de_gas.pdf', 'Declaración TC6: el local no cuenta con instalación de gas.');
const FORM = ev('FORM', 'Formulario_complementario.pdf', 'Formulario complementario de la solicitud, con el inicio de actividades indicado.');
const REQ = {
  1: ['Solicitud de autorización de botiquín firmada', 'Solicitud firmada por el representante legal'], 2: ['Inicio de actividades en el SII', 'Certificado de inicio de actividades del SII'],
  3: ['Escritura de constitución de la sociedad', 'Escritura pública'], 4: ['Dominio o uso del inmueble', 'Contrato de arriendo o escritura del inmueble'],
  5: ['Plano con ubicación del botiquín', 'Plano a escala del local'], 6: ['Recepción definitiva municipal', 'Certificado de recepción definitiva'],
  7: ['Certificado de número municipal', 'Certificado de número emitido por la municipalidad'], 8: ['Nombramiento del químico farmacéutico', 'Resolución de nombramiento'],
  9: ['Instalación de gas', 'Declaración TC6 firmada (no hay instalación de gas)'], 10: ['Registro de temperatura del refrigerador', 'Registro mensual de temperaturas'],
  11: ['Agua potable', 'Certificado de dotación de agua potable'], 12: ['Libro de control de estupefacientes', 'Libro foliado'], 13: ['Sala de espera', 'Fotografías de la sala'],
  14: ['Bodega de inflamables', 'Declaración'], 15: ['Calibración del termómetro', 'Certificado de calibración'], 16: ['Programa de capacitación del personal', 'Programa anual'],
  17: ['Cédula de identidad del representante legal', 'Copia de la cédula por ambos lados'], 18: ['Condiciones sanitarias del local', 'Declaración de condiciones sanitarias'],
  19: ['Procedimiento de dispensación', 'Procedimiento escrito'], 20: ['Procedimiento de reclamos', 'Procedimiento de reclamos de usuarios'], 21: ['Póliza de seguro', 'Póliza vigente'], 22: ['Ascensor', 'Certificado de ascensor'],
};
const NOAPLICA = ['6', '7', '11', '13', '14', '22'];
const base = (n, presentacion, extra = {}) => ({ requisito: String(n), texto_requisito: T(...REQ[n]), presentacion, clasificacion: { listo: 'LISTO', modificar: 'PARCIAL', revisar: 'REQUIERE REVISIÓN', no_encontrado: 'NO ENCONTRADO', no_aplica: 'NO APLICA' }[presentacion], estado: presentacion === 'listo' ? 'cumple' : 'sin_evidencia', justificacion: 'Evaluado por la IA.', accion: presentacion === 'listo' ? '' : 'Conseguir el documento.', evidencias: [], ...extra });
const filas = [
  base(1, 'listo', { evidencias: [ev('SOL', '01_Solicitud_autorizacion.pdf', 'Solicitud de autorización de botiquín firmada por el representante legal.')] }),
  base(2, 'listo', { evidencias: [ev('SII', '02_Inicio_actividades_SII.pdf', 'Certificado de inicio de actividades emitido por el SII.'), FORM] }),
  base(3, 'listo', { evidencias: [ev('ESC', '03_Escritura_constitucion.pdf', 'Escritura de constitución de la sociedad.')] }),
  base(4, 'no_encontrado'), base(5, 'no_encontrado'), base(6, 'no_encontrado'),
  base(7, 'no_aplica', { justificacion: 'El documento de gas indica que no aplica.', evidencias: [GAS] }),
  base(8, 'listo', { evidencias: [ev('QF', 'Nombramiento_QF.pdf', 'Resolución de nombramiento del químico farmacéutico.')] }),
  base(9, 'no_encontrado'),
  base(10, 'listo', { evidencias: [ev('TEMP', 'Registro_temperatura.pdf', 'Registro de temperatura del refrigerador: 4 °C.')] }),
  base(11, 'no_encontrado', { evidencias: [GAS, FORM] }),
  { ...base(12, 'revisar'), estado: 'no_evaluado', justificacion: 'No se pudo verificar la evidencia: formato: respuesta cortada; formato: respuesta cortada', accion: 'Revisar este requisito manualmente: ADA no pudo verificar la evidencia con citas textuales.' },
  base(13, 'no_encontrado'), base(14, 'no_encontrado'), base(15, 'no_encontrado'),
  base(16, 'listo', { evidencias: [ev('CAP', 'Programa_capacitacion.pdf', 'Programa anual de capacitación del personal.')] }),
  base(17, 'listo', { evidencias: [ev('FICHA', '17_Ficha_clinica_paciente.pdf', 'Nombre del paciente y número de ficha.')] }),
  base(18, 'modificar', { justificacion: 'Falta la firma.', accion: 'Firmar la declaración.', evidencias: [ev('COND', 'Declaracion_condiciones_sanitarias.pdf', 'Declaro que el local cumple las condiciones sanitarias.')] }),
  base(19, 'listo', { evidencias: [ev('DISP', 'Procedimiento_dispensacion.pdf', 'Procedimiento de dispensación de medicamentos.')] }),
  base(20, 'listo', { evidencias: [ev('RECL', 'Procedimiento_reclamos.pdf', 'Procedimiento de reclamos de usuarios.')] }),
  base(21, 'no_encontrado'), base(22, 'no_encontrado'),
];
const inventario = [
  ['SOL', '01_Solicitud_autorizacion.pdf'], ['SII', '02_Inicio_actividades_SII.pdf'], ['ESC', '03_Escritura_constitucion.pdf'], ['ARR', '04_CONTRATOS DE ARRIENDO.pdf'], ['PL', '05_plano1erPiso_merged.pdf'],
  ['GAS', '08_NO_APLICA_Instalaciones_de_gas.pdf'], ['FORM', 'Formulario_complementario.pdf'], ['QF', 'Nombramiento_QF.pdf'], ['TEMP', 'Registro_temperatura.pdf'], ['CAP', 'Programa_capacitacion.pdf'],
  ['FICHA', '17_Ficha_clinica_paciente.pdf', 'excluido: posible dato sensible'], ['COND', 'Declaracion_condiciones_sanitarias.pdf'], ['DISP', 'Procedimiento_dispensacion.pdf'], ['RECL', 'Procedimiento_reclamos.pdf'],
  ['S12', '12_Protocolo_esterilizacion.pdf'], ['S21', '21_Sala_de_procedimientos.pdf'], ['S31', '31_LIBRO_RECLAMOS.pdf'], ['S43', '43_Plan_de_emergencia.pdf'], ['S19', '19_Registro_de_capacitaciones.pdf'],
].map(([id, nombre, estado]) => ({ id, nombre, estado: estado || 'incluido' }));
const requisitos = filas.map((f) => ({ id: f.requisito, estado_declarado: NOAPLICA.includes(f.requisito) ? 'No aplica' : 'Listo' }));
const lectura = Object.fromEntries(inventario.map((a) => [a.id, a.id === 'PL' ? 'sin_texto' : 'ok']));
(async () => {
  const vistos = { 13: new Set(['S21']), 20: new Set(['RECL', 'S31']) }; // la IA ya examinó la «sala de procedimientos» para la sala de espera
  const r0 = A._revisarFilas(filas, inventario, { requisitos, expediente: 'Autorización Botiquín Andaluz', lectura, vistos });
  const F = (n) => r0.filas.find((f) => f.requisito === String(n));
  ok(!r0.numeracion.usar, `la numeración de los archivos (expediente SEREMI anterior) se detecta como ajena y se ignora (${r0.numeracion.iguales}/${r0.numeracion.casos})`);
  ok(F(7).presentacion === 'no_aplica_pc' && !F(7).evidencias.length && r0.descartadas.some((d) => d.requisito === '7' && d.archivo_id === 'GAS'), `7 (número municipal): el documento de gas no es evidencia → ${F(7).clasificacion}`);
  ok(F(9).presentacion === 'revisar' && F(9).evidencias.some((e) => e.archivo_id === 'GAS' && e.reubicada_desde === '7') && /TC6|gas/i.test(F(9).accion), `9 (gas): la declaración TC6 se reubica para revisar → ${F(9).clasificacion}: ${F(9).accion}`);
  ok(F(4).presentacion === 'revisar' && F(4).por_revisar.some((x) => x.archivo_id === 'ARR'), `4 (dominio del inmueble): el contrato de arriendo se examina → ${F(4).clasificacion}`);
  ok(F(5).presentacion === 'revisar' && F(5).por_revisar.some((x) => x.archivo_id === 'PL' && x.tipo === 'sin_texto'), `5 (plano): el plano sin texto se identifica con lo que hay que mirar → ${F(5).clasificacion}`);
  ok(F(17).presentacion !== 'listo' && !F(17).evidencias.length && !F(17).por_revisar.some((x) => x.archivo_id === 'FICHA') && r0.descartadas.some((d) => d.requisito === '17' && d.archivo_id === 'FICHA'), `17 (cédula): la ficha clínica no la acredita ni se relaciona por su número → ${F(17).clasificacion}`);
  ok(F(11).presentacion === 'no_aplica_pc' && !F(11).evidencias.length, `11 (agua potable): sin documentos ajenos → ${F(11).clasificacion}`);
  ok(F(2).presentacion === 'listo' && F(2).evidencias.find((e) => e.archivo_id === 'SII').pertinencia === 'principal' && F(2).evidencias.find((e) => e.archivo_id === 'FORM').pertinencia === 'apoyo', '2 (SII): certificado principal, formulario solo de apoyo');
  ok(F(12).presentacion === 'revisar' && F(12).evaluacion_incompleta && !/respuesta cortada|formato:/i.test(F(12).justificacion + F(12).accion), `12: la evaluación incompleta se dice en lenguaje claro: «${F(12).justificacion}»`);
  ok(['6', '13', '14', '22'].every((n) => F(n).presentacion === 'no_aplica_pc') && F(21).presentacion === 'no_encontrado' && F(15).presentacion === 'no_encontrado', 'declarados «No aplica» sin nada que los contradiga → POR CONFIRMAR; 15 y 21 realmente no encontrados');
  ok(r0.filas.every((f) => !['listo', 'no_aplica'].includes(f.presentacion) ? f.accion.length > 10 : true), 'todo lo que no está listo dice qué falta');
  // Entregables + comprobación de coherencia (lo mismo que hace el servidor antes de entregar).
  const r = { ...r0, version: 1, expediente: 'Autorización Botiquín Andaluz', reanalisis: { requisitos: [{ requisito: '12', motivo: 'la evaluación automática no se completó.', archivos: [], costo_estimado_usd: 0.03 }], costo_estimado_usd: 0.03 } };
  const plan = A._planDeCopias(r.filas, inventario, { revisadas: true, descartadas: r.descartadas, sinEvidencia: r.sinEvidencia });
  const md = A._informeExpedienteMd(r, { trabajoId: 'dd8008fd-prueba', expediente: 'Autorización Botiquín Andaluz', carpeta: { nombre: 'Andaluz_Botiquin' } });
  const wordBuf = await crearWord({ titulo: 'Expediente revisado', contenido: md });
  const excelBuf = await A._excelExpediente(r, { trabajoId: 'dd8008fd-prueba', expediente: 'Autorización Botiquín Andaluz', inventario, lectura });
  const c = await A._coherenciaExpediente(r, { excelBuf, md, wordBuf, plan, inventario, total: 22 });
  ok(c.ok, `coherencia: Excel, Word y plan concuerdan (${c.problemas.join('; ') || 'sin problemas'})`);
  ok(!plan.plan.some((x) => x.requisito === '7' || x.requisito === '11' || (x.requisito === '17' && x.archivo_id === 'FICHA')) && plan.plan.some((x) => x.requisito === '9' && x.archivo_id === 'GAS' && x.clase === 'pendiente') && plan.plan.some((x) => x.requisito === '5' && x.archivo_id === 'PL' && x.opcional), 'plan: nada para 7, 11 ni la ficha en 17; TC6 como PENDIENTE en 9; plano desmarcado en 5');
  ok(!/respuesta cortada|formato:/i.test(md) && /## 3\. Documentos que ADA no pudo comprobar con texto/.test(md) && /05_plano1erPiso_merged\.pdf/.test(md), 'Word: sin mensajes técnicos y con la lista exacta de documentos que no se pudieron comprobar');
  // La comprobación detecta errores: si una asociación descartada se cuela como evidencia, no se entrega.
  const malo = { ...r, filas: r.filas.map((f) => (f.requisito === '7' ? { ...f, presentacion: 'no_aplica', evidencias: [{ ...GAS, pertinencia: 'principal' }] } : f)) };
  const mdM = A._informeExpedienteMd(malo, { trabajoId: 'dd8008fd-prueba', expediente: 'X' });
  const c2 = await A._coherenciaExpediente(malo, { excelBuf: await A._excelExpediente(malo, { trabajoId: 'dd8008fd-prueba', expediente: 'X', inventario, lectura }), md: mdM, wordBuf: await crearWord({ titulo: 'Expediente revisado', contenido: mdM }), plan, inventario, total: 22 });
  ok(!c2.ok && c2.problemas.some((x) => /7: evidencia no pertinente|descartado y aparece/.test(x)), `la comprobación rechaza una asociación descartada que reaparece (${c2.problemas.slice(0, 2).join('; ')})`);
  if (process.env.VER) for (const f of r.filas) console.log(`${f.requisito} ${f.clasificacion} | ${f.justificacion} | ${f.accion}`);
  setTimeout(() => process.exit(), 100);
})();
