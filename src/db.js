// Conexión a MySQL y creación automática del esquema.
const mysql = require('mysql2/promise');

const PROYECTOS_INICIALES = [
  'Huayca',
  'PROTEGE+',
  'Eliss Conecta',
  'Autorización SEREMI Andaluz',
  'Autorización SEREMI Bellavista',
  'Personal',
];

let pool;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
    if (!url) throw new Error('Falta DATABASE_URL (en Railway: ${{MySQL.MYSQL_URL}})');
    pool = mysql.createPool({
      uri: url,
      waitForConnections: true,
      connectionLimit: 5,
      // Las fechas se guardan y leen en la hora local del proceso (TZ=America/Santiago).
      timezone: 'local',
      dateStrings: false,
      charset: 'utf8mb4',
    });
  }
  return pool;
}

async function q(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS proyectos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL UNIQUE,
    estado ENUM('activo','pausado','cerrado') NOT NULL DEFAULT 'activo',
    creado_en DATETIME NOT NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo ENUM('decision','avance','pendiente','compromiso','idea') NOT NULL,
    texto TEXT NOT NULL,
    razon TEXT NULL,
    proyecto_id INT NULL,
    persona VARCHAR(160) NULL,
    fecha_limite DATETIME NULL,
    estado ENUM('abierto','hecho','descartado') NOT NULL DEFAULT 'abierto',
    creado_en DATETIME NOT NULL,
    actualizado_en DATETIME NOT NULL,
    INDEX idx_tipo_estado (tipo, estado),
    INDEX idx_fecha_limite (fecha_limite),
    INDEX idx_creado (creado_en),
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS foco (
    id INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id INT NULL,
    descripcion VARCHAR(500) NULL,
    inicio DATETIME NOT NULL,
    fin DATETIME NULL,
    INDEX idx_abierto (fin),
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS alertas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_id INT NULL,
    mensaje TEXT NOT NULL,
    creado_en DATETIME NOT NULL,
    INDEX idx_creado (creado_en)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mensajes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rol ENUM('user','assistant') NOT NULL,
    contenido MEDIUMTEXT NOT NULL,
    creado_en DATETIME NOT NULL,
    INDEX idx_creado (creado_en)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];

async function initDb() {
  for (const sql of ESQUEMA) await q(sql);
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM proyectos');
  if (n === 0) {
    const ahora = new Date();
    for (const nombre of PROYECTOS_INICIALES) {
      await q('INSERT INTO proyectos (nombre, creado_en) VALUES (?, ?)', [nombre, ahora]);
    }
    console.log(`ADA: proyectos iniciales creados (${PROYECTOS_INICIALES.length})`);
  }
}

module.exports = { q, initDb, getPool };
