// Selección de modelo del chat (Fase 3c): operaciones con Haiku, razonamiento con Sonnet, sin herencia tras operar.
process.env.ANTHROPIC_API_KEY = 'x';
const { elegirModelo } = require('/home/claude/ada/src/claude.js');
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALLA: ') + m); if (!c) process.exitCode = 1; };
const casos = [
  // [conversación, texto, nivel esperado]
  [1, 'Actualiza la planilla de prospección de centros de padres con el contacto de Claudio', 'rapido'],
  [1, 'sí, hazlo', 'rapido'],
  [2, 'Busca la planilla Prospeccion Centros de Padres Magaly', 'rapido'],
  [3, 'Lee el PDF de la carpeta de prueba', 'rapido'],
  [4, 'Resume el acta de la reunión', 'rapido'],
  [5, 'Anota esta idea: pulseras con QR para colegios', 'rapido'],
  [6, '¿Qué tengo mañana?', 'rapido'],
  [7, 'Revisa mi correo', 'rapido'],
  [8, 'Analiza la planilla de costos y dime qué conviene', 'profundo'],
  [8, 'sí', 'profundo'],
  [8, 'y qué riesgos ves en subir el precio', 'profundo'],
  [8, 'ok, anota la decisión', 'rapido'],
  [9, '¿Qué opinas de cobrar 5 mil por pulsera?', 'profundo'],
  [10, '¿Cuánto debería cobrar por el servicio de autorización SEREMI?', 'profundo'],
  [11, 'Ayúdame a pensar la estrategia de Huayca para diciembre', 'profundo'],
  [12, 'Hazme un informe de avance del proyecto Bellavista', 'profundo'],
  [13, 'Compara las dos propuestas de arriendo', 'profundo'],
  [14, 'Busca el Excel de ventas', 'rapido'],
  [15, 'hola', 'rapido'],
  [16, 'Ada, ¿me ayudas con Protege Más? Tengo varias ideas', 'profundo'],
  [16, 'sí, la primera es vender en colegios', 'profundo'],
];
for (const [conv, texto, esperado] of casos) {
  const r = elegirModelo(texto, { conversacionId: conv });
  ok(r.nivel === esperado, `"${texto}" → ${r.nivel} (${r.motivo})`);
}
console.log(process.exitCode ? 'HAY FALLAS' : 'TODO OK');
