// Informe del expediente con datos reales «difíciles»: citas con saltos de línea (tablas y formularios), nombres de
// archivo sin punto final, nombre de lista sin cierre. Antes partían líneas y el informe se bloqueaba por «frases
// cortadas» en cada reintento (es código, sin IA: siempre daba el mismo resultado).
process.env.ADA_CLAVE_DATOS = 'x'.repeat(40); process.env.DATABASE_URL = 'mysql://ada:ada@localhost:3306/ada';
const { _informeMarkdown: informeMarkdown } = require('../../src/auditoria');
const { crearWord, comprobarWord } = require('../../src/archivos');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const ev = (cita, archivo) => ({ aporta: 'a_favor', archivo, ubicacion: 'página 1', cita });
  const filas = [
    { requisito: '5', texto_requisito: 'Requisito: Plano con ubicación del botiquín. Qué subir para Andaluz: Plano a escala', presentacion: 'modificar', clasificacion: 'PARCIAL', estado: 'parcial', justificacion: 'El plano no indica la escala\nni la firma', accion: 'Pedir el plano firmado', evidencias: [ev('Plano del local\ncon la ubicación del\n botiquín', 'Plano_local.pdf')] },
    { requisito: '8', texto_requisito: 'Requisito: Certificado de instalación de gas', presentacion: 'listo', clasificacion: 'LISTO', estado: 'cumple', justificacion: 'Declaración TC6 firmada (no hay instalación de gas)', archivo: 'TC6_declaracion.pdf', evidencias: [ev('Declaración TC6\nfirmada', 'TC6_declaracion.pdf')] },
    { requisito: '21', texto_requisito: 'Póliza de seguro', presentacion: 'no_encontrado', clasificacion: 'NO ENCONTRADO', estado: 'sin_evidencia', justificacion: 'No hay póliza', accion: 'Conseguir la póliza vigente', evidencias: [] },
  ];
  const docs = Array.from({ length: 49 }, (_, i) => ({ nombre: `doc${i}.pdf`, version: 'v1', enmascarados: {} }));
  const md = informeMarkdown({ filas, recomendaciones: filas.filter((f) => f.presentacion !== 'listo').map((f) => ({ requisito: f.requisito, accion: f.accion, prioridad: 'alta' })), origenRec: 'acciones de cada evaluación', trabajoId: 'dd8008fd-prueba',
    entrada: { perfil: 'expediente', config: 'K1', requisitos_hash: 'abc', expediente: 'Botiquín Andaluz', carpeta: { nombre: 'Botiquin_documentos', id: 'x1' }, lista: { nombre: 'Botiquín 1–22' } }, docs });
  const buf = await crearWord({ titulo: 'Informe ejecutivo de auditoría', contenido: md });
  const c = await comprobarWord(buf, { titulo: 'Informe ejecutivo de auditoría', contenido: md }, { estricto: true });
  ok(c.ok, `el informe pasa la comprobación estricta (${c.problemas.slice(0, 2).join('; ') || 'sin problemas'})`);
  ok(md.includes('«Plano del local con la ubicación del botiquín»'), 'las citas con saltos de línea quedan completas en una sola línea');
  ok(/Lista: Botiquín 1–22\.$/m.test(md), 'la línea del expediente termina con cierre de frase');
  // Y un corte real (texto que no llega al Word) se sigue detectando.
  const c2 = await comprobarWord(buf, { titulo: 'Informe ejecutivo de auditoría', contenido: `${md}\nEsta frase no está en el Word.` }, { estricto: true });
  ok(!c2.ok, 'un texto que no llegó al Word se sigue rechazando');
  setTimeout(() => process.exit(), 100);
})();
