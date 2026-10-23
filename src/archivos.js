// Archivos que ADA crea: Word (.docx) y Excel (.xlsx). Se guardan en la base para descargarlos
// y, si Google está conectado, también en la carpeta "ADA" de Drive como Google Docs / Sheets.
const docx = require('docx');
const ExcelJS = require('exceljs');
const { q } = require('./db');
const H = require('./herramientas');

const MIME = {
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const EXT = { word: 'docx', excel: 'xlsx' };

// ---------- Word desde markdown ----------

function trozos(texto) {
  // **negrita**, *cursiva* → TextRun
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  let i = 0;
  let m;
  while ((m = re.exec(texto))) {
    if (m.index > i) out.push(new docx.TextRun(texto.slice(i, m.index)));
    const t = m[0];
    if (t.startsWith('**')) out.push(new docx.TextRun({ text: t.slice(2, -2), bold: true }));
    else out.push(new docx.TextRun({ text: t.slice(1, -1), italics: true }));
    i = m.index + t.length;
  }
  if (i < texto.length) out.push(new docx.TextRun(texto.slice(i)));
  return out.length ? out : [new docx.TextRun('')];
}

function filaTabla(linea) {
  return linea.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function tablaWord(lineas) {
  const filas = lineas.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map(filaTabla);
  const columnas = Math.max(...filas.map((f) => f.length));
  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    rows: filas.map((f, i) => new docx.TableRow({
      tableHeader: i === 0,
      children: Array.from({ length: columnas }, (_, j) => new docx.TableCell({
        shading: i === 0 ? { fill: 'E7F7EF' } : undefined,
        children: [new docx.Paragraph({ children: i === 0 ? [new docx.TextRun({ text: f[j] || '', bold: true })] : trozos(f[j] || '') })],
      })),
    })),
  });
}

async function crearWord({ titulo, contenido }) {
  const hijos = [new docx.Paragraph({ text: titulo, heading: docx.HeadingLevel.TITLE })];
  const lineas = String(contenido || '').split('\n');
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const bloque = [];
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) bloque.push(lineas[i++]);
      i -= 1;
      hijos.push(tablaWord(bloque));
      hijos.push(new docx.Paragraph(''));
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    const ul = l.match(/^\s*[-•*]\s+(.*)/);
    const ol = l.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) {
      const nivel = [docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_2, docx.HeadingLevel.HEADING_3][h[1].length - 1];
      hijos.push(new docx.Paragraph({ heading: nivel, children: [new docx.TextRun(h[2].replace(/\*\*/g, ''))] }));
    } else if (ul) {
      hijos.push(new docx.Paragraph({ bullet: { level: 0 }, children: trozos(ul[1]) }));
    } else if (ol) {
      hijos.push(new docx.Paragraph({ numbering: { reference: 'numeros', level: 0 }, children: trozos(ol[1]) }));
    } else if (/^\s*---+\s*$/.test(l)) {
      hijos.push(new docx.Paragraph({ border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } } }));
    } else if (l.trim()) {
      hijos.push(new docx.Paragraph({ children: trozos(l), spacing: { after: 120 } }));
    }
  }
  const doc = new docx.Document({
    creator: 'ADA',
    title: titulo,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [{
        reference: 'numeros',
        levels: [{ level: 0, format: docx.LevelFormat.DECIMAL, text: '%1.', alignment: docx.AlignmentType.START }],
      }],
    },
    sections: [{ children: hijos }],
  });
  return docx.Packer.toBuffer(doc);
}

// ---------- Excel ----------

function valorCelda(v) {
  if (typeof v === 'string' && v.startsWith('=')) return { formula: v.slice(1) };
  if (typeof v === 'string' && /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(v.trim())) {
    return Number(v.replace(/\./g, '').replace(',', '.')); // "15.000" → 15000
  }
  return v;
}

async function crearExcel({ titulo, hojas }) {
  if (!Array.isArray(hojas) || !hojas.length) throw new Error('Excel necesita al menos una hoja con columnas y filas');
  const libro = new ExcelJS.Workbook();
  libro.creator = 'ADA';
  for (const h of hojas) {
    const hoja = libro.addWorksheet(String(h.nombre || 'Hoja').slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
    const columnas = h.columnas || [];
    if (columnas.length) {
      hoja.addRow(columnas);
      const fila = hoja.getRow(1);
      fila.font = { bold: true, color: { argb: 'FF04140D' } };
      fila.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5EEAA8' } };
      hoja.views = [{ state: 'frozen', ySplit: 1 }];
    }
    for (const f of h.filas || []) hoja.addRow((Array.isArray(f) ? f : Object.values(f)).map(valorCelda));
    // Formatos de número por columna (opcional): "pesos", "porcentaje", "fecha", "numero"
    (h.formatos || []).forEach((formato, j) => {
      const col = hoja.getColumn(j + 1);
      if (formato === 'pesos') col.numFmt = '"$"#,##0';
      else if (formato === 'porcentaje') col.numFmt = '0.0%';
      else if (formato === 'numero') col.numFmt = '#,##0.##';
      else if (formato === 'fecha') col.numFmt = 'dd-mm-yyyy';
    });
    hoja.columns.forEach((col) => {
      let ancho = 10;
      col.eachCell({ includeEmpty: false }, (c) => {
        const largo = String(c.value && c.value.formula ? c.value.formula : c.value ?? '').length;
        ancho = Math.max(ancho, Math.min(largo + 2, 60));
      });
      col.width = ancho;
    });
  }
  return Buffer.from(await libro.xlsx.writeBuffer());
}

// ---------- Guardar y entregar ----------

function nombreArchivo(titulo, tipo) {
  const base = String(titulo).replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 80) || 'archivo';
  return `${base}.${EXT[tipo]}`;
}

async function crearArchivo(a, ctx = {}) {
  const tipo = a.tipo === 'excel' ? 'excel' : a.tipo === 'word' ? 'word' : null;
  if (!tipo) throw new Error('tipo debe ser "word" o "excel"');
  if (!a.titulo) throw new Error('titulo es obligatorio');
  const datos = tipo === 'word' ? await crearWord(a) : await crearExcel(a);
  const nombre = nombreArchivo(a.titulo, tipo);
  const r = await q(
    'INSERT INTO archivos (conversacion_id, nombre, tipo, mime, datos, creado_en) VALUES (?, ?, ?, ?, ?, ?)',
    [ctx.conversacionId || null, nombre, tipo, MIME[tipo], datos, new Date()]
  );
  const resultado = { ok: true, archivo_id: r.insertId, nombre };

  // Si Google Drive está conectado, también lo deja ahí como Google Docs / Sheets.
  if (a.guardar_en_drive !== false) {
    try {
      const D = require('./drive');
      if (await D.conectado()) {
        const subido = await D.subirComoGoogle({ nombre: a.titulo, datos, tipo, carpetaId: a.carpeta_drive_id });
        await q('UPDATE archivos SET drive_id = ?, drive_url = ? WHERE id = ?', [subido.id, subido.url, r.insertId]);
        resultado.drive = { id: subido.id, url: subido.url, carpeta: subido.carpeta };
      }
    } catch (e) {
      resultado.drive_error = e.message;
    }
  }
  resultado.nota = 'El archivo ya aparece en la pantalla de Cristian para descargar' +
    (resultado.drive ? ' y quedó en su Google Drive (carpeta ADA).' : '.') + ' No repitas su contenido.';
  return resultado;
}

async function obtenerArchivo(id) {
  const [a] = await q('SELECT * FROM archivos WHERE id = ?', [id]);
  return a || null;
}

H.registrar([{
  name: 'crear_archivo',
  description: 'Crea un archivo Word (.docx) o Excel (.xlsx) para Cristian: informes, actas, cartas, cotizaciones, presupuestos, planillas de costos, listas de contactos, etc. Aparece en su pantalla para descargar y, si Google está conectado, queda también en su Drive como Google Docs o Sheets. Úsala cuando pida un "Word", "Excel", "planilla", "archivo" o algo que vaya a imprimir, enviar o editar. Para notas rápidas en pantalla usa entregar_documento.',
  input_schema: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['word', 'excel'] },
      titulo: { type: 'string' },
      contenido: { type: 'string', description: 'Solo Word: contenido en markdown (# títulos, listas, **negrita**, tablas con |)' },
      hojas: {
        type: 'array',
        description: 'Solo Excel: una o más hojas',
        items: {
          type: 'object',
          properties: {
            nombre: { type: 'string' },
            columnas: { type: 'array', items: { type: 'string' } },
            filas: { type: 'array', items: { type: 'array', items: {} }, description: 'Valores; números como números. Fórmulas como texto que empieza con "=" (ej: "=B2*C2", "=SUMA(D2:D10)" se escribe "=SUM(D2:D10)").' },
            formatos: { type: 'array', items: { type: 'string', enum: ['', 'pesos', 'porcentaje', 'numero', 'fecha'] }, description: 'Formato por columna, en orden' },
          },
          required: ['columnas', 'filas'],
        },
      },
      guardar_en_drive: { type: 'boolean', description: 'Por defecto true si Google está conectado' },
      carpeta_drive_id: { type: 'string', description: 'Carpeta de Drive donde guardarlo (por defecto, la carpeta ADA)' },
    },
    required: ['tipo', 'titulo'],
  },
}], { crear_archivo: crearArchivo });

module.exports = { crearWord, crearExcel, crearArchivo, obtenerArchivo };
