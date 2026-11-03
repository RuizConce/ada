// Caso REAL dd8008fd (Botiquín Andaluz), reproducido con los nueve problemas que mostró el diagnóstico real: archivos
// numerados para el expediente SEREMI anterior, citas que solo PIDEN un documento, listados de otro tema, evaluaciones
// incompletas y dos copias que ya existen en la carpeta de resultados. Sin IA ni Drive.
process.env.ADA_CLAVE_DATOS = 'x'.repeat(40); process.env.DATABASE_URL = 'mysql://ada:ada@localhost:3306/ada';
const A = require('../../src/auditoria');
const { crearWord } = require('../../src/archivos');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const T = (req, subir) => `Requisito: ${req}. Qué subir para Andaluz: ${subir}.`;
const ev = (archivo_id, archivo, cita, aporta = 'a_favor') => ({ archivo_id, archivo, cita, verificada: true, aporta, ubicacion: 'página 1' });
const REQ = {
  1: ['Formulario complementario', 'Formulario complementario descargable, lleno y firmado por el representante legal'],
  2: ['Inicio de actividades en el SII', 'Certificado de inicio de actividades del SII'],
  3: ['Escritura de constitución de la sociedad', 'Escritura pública con sus modificaciones'],
  4: ['Dominio o uso del inmueble', 'Contrato de arriendo o escritura que acredite el uso del inmueble'],
  5: ['Plano del local', 'Plano con la ubicación del botiquín, el refrigerador y las vías de evacuación'],
  6: ['Recepción definitiva municipal', 'Certificado de recepción definitiva'],
  7: ['Certificado de número municipal', 'Certificado de número emitido por la municipalidad'],
  8: ['Nombramiento del químico farmacéutico', 'Resolución de nombramiento del químico farmacéutico'],
  9: ['Instalación de gas', 'Declaración TC6 firmada (no hay instalación de gas)'],
  10: ['Registro de temperatura del refrigerador', 'Registro mensual de temperaturas del refrigerador'],
  11: ['Agua potable', 'Boleta de agua o certificado de dotación de agua potable'],
  12: ['Libro de control de estupefacientes', 'Libro foliado de estupefacientes'],
  13: ['Sala de espera', 'Fotografías de la sala de espera'],
  14: ['Bodega de inflamables', 'Declaración de bodega de inflamables'],
  15: ['Calibración del termómetro', 'Certificado de calibración del termómetro'],
  16: ['Listado del personal del botiquín', 'Nómina del personal con sus funciones'],
  17: ['Cédula de identidad del encargado', 'Copia de la cédula de identidad del encargado por ambos lados'],
  18: ['Condiciones sanitarias del local', 'Declaración de condiciones sanitarias'],
  19: ['Equipamiento y mobiliario', 'Listado de equipamiento y mobiliario del botiquín'],
  20: ['Procedimiento de reclamos', 'Procedimiento de reclamos de usuarios'],
  21: ['Listado de medicamentos', 'Listado de medicamentos que mantendrá el botiquín'],
  22: ['Botiquín naviero', 'Certificado de la autoridad marítima (solo botiquines navieros)'],
};
const NOAPLICA = ['6', '7', '11', '13', '14', '22'];
const FORM = ev('FORM', '01_Formulario_complementario_Andaluz_firmado.pdf', 'Adjuntar boleta de agua potable del último mes.');
const TC6 = ev('TC6', '08.1_Declaracion_TC6_Andaluz_firmada.pdf', 'Declaración TC6: el local no cuenta con instalación de gas.');
const PERS = ev('PERS', 'Listado_personal.pdf', 'Listado del personal: químico farmacéutico y auxiliar.');
const EQUI = ev('EQUI', 'Listado_equipamiento.pdf', 'Listado de equipamiento: refrigerador, estanterías y mesón.');
const lbl = { listo: 'LISTO', modificar: 'PARCIAL', revisar: 'REQUIERE REVISIÓN', no_encontrado: 'NO ENCONTRADO', no_aplica: 'NO APLICA' };
const base = (n, presentacion, extra = {}) => ({ requisito: String(n), texto_requisito: T(...REQ[n]), presentacion, clasificacion: lbl[presentacion], estado: presentacion === 'listo' ? 'cumple' : 'sin_evidencia', justificacion: 'Evaluado por la IA.', accion: presentacion === 'listo' ? '' : 'Conseguir el documento.', evidencias: [], ...extra });
const fallo = (n) => ({ ...base(n, 'revisar'), estado: 'no_evaluado', justificacion: 'No se pudo verificar la evidencia: formato: respuesta cortada', accion: 'Revisar este requisito manualmente: ADA no pudo verificar la evidencia con citas textuales.' });
const filas = [
  base(1, 'no_encontrado'),
  base(2, 'listo', { evidencias: [ev('SII', '02_Inicio_actividades_SII.pdf', 'Certificado de inicio de actividades emitido por el SII.')] }),
  fallo(3), fallo(4), base(5, 'no_encontrado'), base(6, 'no_encontrado'),
  base(7, 'no_aplica', { justificacion: 'La declaración indica que no aplica.', evidencias: [TC6] }),
  base(8, 'listo', { evidencias: [ev('QF', 'Nombramiento_QF.pdf', 'Resolución de nombramiento del químico farmacéutico.')] }),
  base(9, 'no_encontrado'), fallo(10),
  base(11, 'listo', { evidencias: [FORM] }),
  base(12, 'listo', { evidencias: [ev('EST', 'Libro_estupefacientes.pdf', 'Libro foliado de control de estupefacientes.')] }),
  base(13, 'no_encontrado'), base(14, 'no_encontrado'), fallo(15),
  base(16, 'listo', { evidencias: [PERS] }),
  base(17, 'no_encontrado'), fallo(18),
  base(19, 'listo', { evidencias: [EQUI] }), fallo(20),
  base(21, 'listo', { evidencias: [PERS, EQUI] }),
  base(22, 'no_encontrado'),
];
const inventario = [
  ['FORM', '01_Formulario_complementario_Andaluz_firmado.pdf'], ['SII', '02_Inicio_actividades_SII.pdf'], ['ESC', '03_Escritura_sociedad.pdf'], ['ARR', '04_CONTRATOS DE ARRIENDO.pdf'],
  ['PL', '05_plano1erPiso_merged.pdf'], ['TC6', '08.1_Declaracion_TC6_Andaluz_firmada.pdf'], ['QF', 'Nombramiento_QF.pdf'], ['TEMP', '10_Registro_temperaturas_2026.pdf'],
  ['EST', 'Libro_estupefacientes.pdf'], ['TERM', 'Certificado_calibracion_termometro.pdf'], ['PERS', 'Listado_personal.pdf'], ['FICHA', '17_Ficha_clinica_universal.pdf', 'excluido: posible dato sensible'],
  ['COND', '18_Declaracion_condiciones_sanitarias.pdf'], ['EQUI', 'Listado_equipamiento.pdf'], ['RECL', 'Procedimiento_reclamos_usuarios.pdf'],
  ['S12', '12_Protocolo_esterilizacion.pdf'], ['S21', '21_Sala_de_procedimientos.pdf'], ['S31', '31_LIBRO_RECLAMOS.pdf'], ['S43', '43_Plan_de_emergencia.pdf'],
].map(([id, nombre, estado]) => ({ id, nombre, estado: estado || 'incluido' }));
const requisitos = filas.map((f) => ({ id: f.requisito, estado_declarado: NOAPLICA.includes(f.requisito) ? 'No aplica' : 'Listo' }));
const lectura = Object.fromEntries(inventario.map((a) => [a.id, a.id === 'PL' ? 'sin_texto' : 'ok']));
const vistos = { 1: new Set(['FORM']), 13: new Set(['S21']) }; // la IA examinó el formulario para el 1 y no halló «descargable»/«lleno»
const existentes = [{ requisito: '02', archivo_id: 'SII', copia_id: 'c1', copia_nombre: '02_Inicio_actividades_SII.pdf', url: 'https://drive/c1' }, { requisito: '08', archivo_id: 'QF', copia_id: 'c2', copia_nombre: '08_Nombramiento_QF.pdf', url: 'https://drive/c2' }];
(async () => {
  const r0 = A._revisarFilas(filas, inventario, { requisitos, expediente: 'Autorización Botiquín Andaluz', lectura, vistos });
  const F = (n) => r0.filas.find((f) => f.requisito === String(n));
  const pr = (n, id) => (F(n).por_revisar || []).find((x) => x.archivo_id === id);
  const usa = (n, id) => (F(n).evidencias || []).some((e) => e.archivo_id === id && e.aporta !== 'en_contra');
  ok(F(1).presentacion === 'revisar' && pr(1, 'FORM') && pr(1, 'FORM').fuerte, `1: reconoce el formulario existente → ${F(1).clasificacion}: ${F(1).accion}`);
  ok(F(4).presentacion === 'revisar' && pr(4, 'ARR') && /uso del inmueble/.test(pr(4, 'ARR').que_revisar), `4: contrato de arriendo candidato con qué verificar → ${pr(4, 'ARR') && pr(4, 'ARR').que_revisar}`);
  ok(F(5).presentacion === 'revisar' && pr(5, 'PL') && pr(5, 'PL').tipo === 'sin_texto' && /refrigerador/.test(pr(5, 'PL').que_revisar) && /evacuaci/.test(pr(5, 'PL').que_revisar), `5: plano existente, revisión visual exacta → ${pr(5, 'PL') && pr(5, 'PL').que_revisar}`);
  ok(F(9).presentacion === 'revisar' && usa(9, 'TC6') && /firma/i.test(F(9).accion) && !usa(7, 'TC6'), `9: considera la declaración TC6 y pide verificar la firma → ${F(9).accion}`);
  ok(!usa(11, 'FORM') && r0.descartadas.some((d) => d.requisito === '11' && /solo pide/.test(d.motivo)) && F(11).presentacion === 'no_aplica_pc', `11: el formulario que PIDE la boleta no es prueba de agua potable → ${F(11).clasificacion}`);
  ok(!usa(17, 'FICHA') && !pr(17, 'FICHA') && F(17).presentacion === 'no_encontrado', `17: la ficha clínica no se relaciona con la cédula → ${F(17).clasificacion}`);
  ok(!usa(21, 'PERS') && !usa(21, 'EQUI') && r0.descartadas.filter((d) => d.requisito === '21').length === 2 && usa(16, 'PERS') && usa(19, 'EQUI'), `21: los listados de personal y equipamiento no acreditan medicamentos (siguen en 16 y 19) → ${F(21).clasificacion}`);
  ok(F(22).presentacion === 'no_aplica_pc' && /No aplica/.test(F(22).justificacion), `22: no aplica, por confirmar → ${F(22).justificacion}`);
  const inc = ['3', '10', '15', '18', '20'].map((n) => F(n));
  ok(inc.every((f) => f.presentacion === 'revisar' && f.evaluacion_incompleta && (f.por_revisar || []).length && /Abrir «/.test(f.accion) && !/respuesta cortada|formato:/.test(f.justificacion + f.accion)), `3, 10, 15, 18 y 20: evaluación incompleta con archivo y dato a verificar → ${inc.map((f) => `${f.requisito}: ${(f.por_revisar[0] || {}).archivo}`).join('; ')}`);
  ok(F(2).presentacion === 'listo' && F(8).presentacion === 'listo' && F(12).presentacion === 'listo', '2, 8 y 12 siguen LISTOS con su evidencia pertinente');
  ok(r0.filas.every((f) => !(f.presentacion === 'no_encontrado' && (f.por_revisar || []).length)), 'ningún NO ENCONTRADO tiene un documento existente relacionado');
  // Plan, entregables y comprobación (lo que hace el servidor antes de entregar), con dos copias ya existentes.
  const r = { ...r0, version: 2, expediente: 'Autorización Botiquín Andaluz', reanalisis: { requisitos: [], costo_estimado_usd: 0 } };
  const plan = A._planDeCopias(r.filas, inventario, { revisadas: true, descartadas: r.descartadas, sinEvidencia: r.sinEvidencia, copiasExistentes: existentes });
  r.plan = plan; r.previas = { copias: existentes };
  const P = (n, id) => plan.plan.find((c) => c.requisito === String(n) && c.archivo_id === id);
  ok(P(2, 'SII').ya_copiada && P(8, 'QF').ya_copiada && plan.plan.filter((c) => !c.ya_copiada && ((c.requisito === '2' && c.archivo_id === 'SII') || (c.requisito === '8' && c.archivo_id === 'QF'))).length === 0, 'plan: las 2 copias existentes se reconocen y no se duplican');
  ok(P(1, 'FORM') && P(1, 'FORM').opcional && /PENDIENTE/.test(P(1, 'FORM').nombre_copia) && P(9, 'TC6') && /PENDIENTE/.test(P(9, 'TC6').nombre_copia) && P(5, 'PL') && P(4, 'ARR'), `plan: copias adicionales PENDIENTE: ${plan.plan.filter((c) => !c.ya_copiada).map((c) => c.nombre_copia).join(', ')}`);
  ok(!P(7, 'TC6') && !P(11, 'FORM') && !P(21, 'PERS') && !P(21, 'EQUI') && !plan.plan.some((c) => c.archivo_id === 'FICHA'), 'plan: nada de gas en 7, formulario en 11, listados en 21 ni ficha clínica');
  const md = A._informeExpedienteMd(r, { trabajoId: 'dd8008fd-prueba', expediente: 'Autorización Botiquín Andaluz', carpeta: { nombre: 'Andaluz_Botiquin' } });
  const wordBuf = await crearWord({ titulo: 'Expediente revisado', contenido: md });
  const excelBuf = await A._excelExpediente(r, { trabajoId: 'dd8008fd-prueba', expediente: 'Autorización Botiquín Andaluz', inventario, lectura, copias: existentes, plan: plan.plan });
  const c = await A._coherenciaExpediente(r, { excelBuf, md, wordBuf, plan, inventario, total: 22 });
  ok(c.ok, `coherencia de Excel, Word y plan (${c.problemas.join('; ') || 'sin problemas'})`);
  const ExcelJS = require('exceljs'); const lib = new ExcelJS.Workbook(); await lib.xlsx.load(excelBuf);
  const hAE = lib.getWorksheet('Documentos por requisito'); const filasAE = []; hAE.eachRow((row, i) => { if (i > 1) filasAE.push(row.values.slice(1).map((x) => String(x == null ? '' : x))); });
  const ae = (n, arch) => filasAE.find((x) => x[0] === String(n) && x[1] === arch);
  ok(ae(5, '05_plano1erPiso_merged.pdf')[3].startsWith('no: sin texto') && /por confirmar/.test(ae(5, '05_plano1erPiso_merged.pdf')[4]) && /^copiada|^ya copiada/.test(ae(2, '02_Inicio_actividades_SII.pdf')[6]) && ae(2, '02_Inicio_actividades_SII.pdf')[7] === 'https://drive/c1' && /^no: /.test(ae(21, 'Listado_personal.pdf')[4]),
    'Excel: A (existe), B (leído), C (pertinente), D (completo/parcial) y E (copia con enlace) por separado');
  ok(new Set(filasAE.map((x) => x[0])).size === 22 && /## 4\. Copias en la carpeta de resultados/.test(md) && md.includes('https://drive/c1'), 'Excel y Word cubren los 22 requisitos e incluyen los enlaces de las copias');
  if (process.env.VER) for (const f of r.filas) console.log(`${f.requisito} ${f.clasificacion} | ${f.justificacion} | ${f.accion}`);
  setTimeout(() => process.exit(), 100);
})();
