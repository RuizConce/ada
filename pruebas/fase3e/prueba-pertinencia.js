// Control de pertinencia del plan de copias (caso real del Botiquín Andaluz, generalizable): una cita «verificada» no basta;
// el archivo debe hablar de ESE requisito. Sin IA: se aplica sobre los resultados ya guardados de la auditoría.
process.env.ADA_CLAVE_DATOS = 'x'.repeat(40); process.env.DATABASE_URL = 'mysql://ada:ada@localhost:3306/ada';
const { _planDeCopias: planDeCopias } = require('../../src/auditoria');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const T = (req, subir) => `Requisito: ${req}. Qué subir para Andaluz: ${subir}.`;
const ev = (archivo_id, archivo, cita) => ({ archivo_id, archivo, cita, verificada: true, aporta: 'a_favor', ubicacion: 'página 1' });
const GAS = ev('G', '08_NO_APLICA_Instalaciones_de_gas.pdf', 'El local no cuenta con instalaciones de gas, según declaración TC6.');
const FORM = ev('F', 'Formulario_complementario.pdf', 'Formulario complementario de la solicitud de autorización, con el inicio de actividades indicado.');
const filas = [
  { requisito: '1', texto_requisito: T('Solicitud de autorización de botiquín firmada', 'Solicitud firmada por el representante legal'), presentacion: 'listo', clasificacion: 'LISTO', evidencias: [ev('S', '01_Solicitud_autorizacion.pdf', 'Solicitud de autorización de botiquín firmada por el representante legal.')] },
  { requisito: '2', texto_requisito: T('Inicio de actividades en el SII', 'Certificado de inicio de actividades del SII'), presentacion: 'listo', clasificacion: 'LISTO', evidencias: [ev('SII', '02_Inicio_actividades_SII.pdf', 'Certificado de inicio de actividades emitido por el SII.'), FORM] },
  { requisito: '3', texto_requisito: T('Escritura de constitución de la sociedad', 'Escritura pública'), presentacion: 'listo', clasificacion: 'LISTO', evidencias: [ev('E', '03_Escritura.pdf', 'Escritura de constitución de la sociedad.')] },
  { requisito: '4', texto_requisito: T('Dominio o uso del inmueble', 'Contrato de arriendo o escritura del inmueble'), presentacion: 'no_encontrado', clasificacion: 'NO ENCONTRADO', accion: 'Conseguir el contrato de arriendo.', evidencias: [] },
  { requisito: '5', texto_requisito: T('Plano con ubicación del botiquín', 'Plano a escala del local'), presentacion: 'modificar', clasificacion: 'PARCIAL', accion: 'Agregar la escala y la firma del plano.', evidencias: [] },
  { requisito: '6', texto_requisito: T('Recepción definitiva municipal', 'Certificado de recepción definitiva'), presentacion: 'no_encontrado', clasificacion: 'NO ENCONTRADO', evidencias: [] },
  { requisito: '7', texto_requisito: T('Certificado de número municipal', 'Certificado de número emitido por la municipalidad'), presentacion: 'no_aplica', clasificacion: 'NO APLICA', evidencias: [GAS] },
  { requisito: '8', texto_requisito: T('Instalación de gas', 'Declaración TC6 firmada (no hay instalación de gas)'), presentacion: 'no_aplica', clasificacion: 'NO APLICA', evidencias: [GAS] },
  { requisito: '11', texto_requisito: T('Agua potable', 'Certificado de dotación de agua potable'), presentacion: 'no_encontrado', clasificacion: 'NO ENCONTRADO', evidencias: [GAS, FORM] },
];
const inventario = [
  { id: 'S', nombre: '01_Solicitud_autorizacion.pdf', estado: 'incluido' }, { id: 'SII', nombre: '02_Inicio_actividades_SII.pdf', estado: 'incluido' }, { id: 'E', nombre: '03_Escritura.pdf', estado: 'incluido' },
  { id: 'ARR', nombre: '04_CONTRATOS DE ARRIENDO.pdf', estado: 'excluido: posible dato sensible' }, { id: 'PL', nombre: '05_plano1erPiso_merged.pdf', estado: 'incluido' },
  { id: 'G', nombre: '08_NO_APLICA_Instalaciones_de_gas.pdf', estado: 'incluido' }, { id: 'F', nombre: 'Formulario_complementario.pdf', estado: 'incluido' },
];
const requisitos = filas.map((f) => ({ id: f.requisito, estado_declarado: ['6', '7', '11'].includes(f.requisito) ? 'No aplica' : 'Listo' }));
const { plan, sinCopia, descartadas, ajustes } = planDeCopias(filas, inventario, { requisitos, expediente: 'Autorización Botiquín Andaluz', lectura: { PL: 'sin_texto' } });
const de = (r) => plan.filter((x) => x.requisito === r);
const marcadas = plan.filter((x) => !x.opcional && !x.sensible);
console.log(plan.map((x) => `${x.nombre_copia} [${x.pertinencia}${x.opcional ? ', desmarcada' : ''}]`).join('\n'));
ok(!plan.some((x) => x.requisito === '7') && descartadas.some((d) => d.requisito === '7' && /tratan del requisito 8|no tratan de lo que pide/.test(d.motivo)), '1. el documento de gas NO se copia para el 7 (número municipal) y queda descartado con su motivo');
ok(!de('11').length && descartadas.filter((d) => d.requisito === '11').length === 2, '2. agua potable (no encontrado / declarado no aplica): no se propone el documento de gas ni el formulario');
ok(de('2').length === 2 && de('2').find((x) => x.archivo_id === 'SII').pertinencia === 'principal' && !de('2').find((x) => x.archivo_id === 'SII').opcional && de('2').find((x) => x.archivo_id === 'F').opcional, '3. SII: el certificado va marcado; el formulario complementario queda DESMARCADO como apoyo');
const arr = de('4')[0];
ok(arr && arr.archivo === '04_CONTRATOS DE ARRIENDO.pdf' && arr.opcional && arr.sensible && /requiere tu autorización/.test(arr.acredita), `4. el contrato de arriendo aparece (desmarcado): ${arr && arr.acredita}`);
const pl = de('5')[0];
ok(pl && pl.archivo === '05_plano1erPiso_merged.pdf' && pl.opcional && /no tiene texto/i.test(pl.acredita) && /comprobar a la vista/.test(pl.falta) && /PENDIENTE/.test(pl.nombre_copia), `5. el plano aparece como parcial por revisar, con lo que falta: ${pl && pl.falta}`);
ok(ajustes['6'] && ajustes['11'] && /POR CONFIRMAR/.test(ajustes['6'].estado) && !/declaraci[oó]n firmada/i.test(ajustes['6'].nota) && sinCopia.some((x) => x.requisito === '6' && /POR CONFIRMAR/.test(x.estado)), '6. declarados «No aplica»: no se convierten en NO ENCONTRADO ni piden declaraciones; quedan «por confirmar»');
ok(de('8').length === 1 && de('8')[0].pertinencia === 'principal' && de('8')[0].clase === 'acredita', 'el documento de gas SÍ respalda el requisito de gas (8, no aplica)');
ok(marcadas.map((x) => x.requisito).sort().join() === '1,2,3,8', `marcadas por defecto solo las pertinentes: ${marcadas.map((x) => x.nombre_copia).join(', ')}`);
setTimeout(() => process.exit(), 100);
