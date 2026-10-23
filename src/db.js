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
  `CREATE TABLE IF NOT EXISTS proyecto_notas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id INT NOT NULL,
    texto TEXT NOT NULL,
    creado_en DATETIME NOT NULL,
    INDEX idx_proyecto (proyecto_id),
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE
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
  `CREATE TABLE IF NOT EXISTS contactos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(160) NOT NULL,
    relacion VARCHAR(200) NULL,
    organizacion VARCHAR(200) NULL,
    email VARCHAR(200) NULL,
    telefono VARCHAR(40) NULL,
    notas TEXT NULL,
    creado_en DATETIME NOT NULL,
    actualizado_en DATETIME NOT NULL,
    INDEX idx_nombre (nombre)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS encargos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo VARCHAR(300) NOT NULL,
    objetivo TEXT NULL,
    contacto_id INT NULL,
    proyecto_id INT NULL,
    estado ENUM('en_curso','esperando_autorizacion','esperando_respuesta','necesita_decision','resuelto','cancelado')
      NOT NULL DEFAULT 'en_curso',
    siguiente_paso TEXT NULL,
    revisar_en DATETIME NULL,
    resultado TEXT NULL,
    creado_en DATETIME NOT NULL,
    actualizado_en DATETIME NOT NULL,
    INDEX idx_estado (estado),
    INDEX idx_revisar (revisar_en),
    FOREIGN KEY (contacto_id) REFERENCES contactos(id) ON DELETE SET NULL,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS acciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    encargo_id INT NULL,
    canal ENUM('whatsapp','correo','llamada','otro') NOT NULL DEFAULT 'whatsapp',
    destinatario VARCHAR(200) NULL,
    contacto_id INT NULL,
    asunto VARCHAR(300) NULL,
    contenido TEXT NOT NULL,
    estado ENUM('propuesta','ejecutada','rechazada') NOT NULL DEFAULT 'propuesta',
    creado_en DATETIME NOT NULL,
    resuelto_en DATETIME NULL,
    INDEX idx_estado (estado),
    FOREIGN KEY (encargo_id) REFERENCES encargos(id) ON DELETE CASCADE,
    FOREIGN KEY (contacto_id) REFERENCES contactos(id) ON DELETE SET NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS bitacora (
    id INT AUTO_INCREMENT PRIMARY KEY,
    encargo_id INT NOT NULL,
    texto TEXT NOT NULL,
    creado_en DATETIME NOT NULL,
    INDEX idx_encargo (encargo_id),
    FOREIGN KEY (encargo_id) REFERENCES encargos(id) ON DELETE CASCADE
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS integraciones (
    nombre VARCHAR(40) PRIMARY KEY,
    datos TEXT NOT NULL,
    actualizado_en DATETIME NOT NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS conversaciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo VARCHAR(200) NULL,
    resumen TEXT NULL,
    proyecto_id INT NULL,
    modo ENUM('voz','texto') NOT NULL DEFAULT 'texto',
    inicio DATETIME NOT NULL,
    fin DATETIME NULL,
    INDEX idx_inicio (inicio),
    INDEX idx_fin (fin),
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS documentos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversacion_id INT NULL,
    proyecto_id INT NULL,
    titulo VARCHAR(200) NOT NULL,
    contenido MEDIUMTEXT NOT NULL,
    creado_en DATETIME NOT NULL,
    INDEX idx_conv (conversacion_id),
    FOREIGN KEY (conversacion_id) REFERENCES conversaciones(id) ON DELETE SET NULL,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS archivos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversacion_id INT NULL,
    nombre VARCHAR(200) NOT NULL,
    tipo VARCHAR(20) NOT NULL,
    mime VARCHAR(120) NOT NULL,
    datos MEDIUMBLOB NOT NULL,
    drive_id VARCHAR(120) NULL,
    drive_url VARCHAR(500) NULL,
    creado_en DATETIME NOT NULL,
    INDEX idx_conv (conversacion_id),
    FOREIGN KEY (conversacion_id) REFERENCES conversaciones(id) ON DELETE SET NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mensajes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rol ENUM('user','assistant') NOT NULL,
    contenido MEDIUMTEXT NOT NULL,
    creado_en DATETIME NOT NULL,
    INDEX idx_creado (creado_en)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];

// Cambios sobre tablas ya existentes en producción (idempotentes).
const MIGRACIONES = [
  ['proyectos', 'descripcion', 'ALTER TABLE proyectos ADD COLUMN descripcion TEXT NULL'],
  ['mensajes', 'conversacion_id', 'ALTER TABLE mensajes ADD COLUMN conversacion_id INT NULL, ADD INDEX idx_conv (conversacion_id)'],
];

async function initDb() {
  for (const sql of ESQUEMA) await q(sql);
  for (const [tabla, columna, sql] of MIGRACIONES) {
    const [{ n }] = await q(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [tabla, columna]
    );
    if (n === 0) await q(sql);
  }
  // Mensajes de antes de que existieran las conversaciones: se archivan juntos.
  const [{ huerfanos, desde, hasta }] = await q(
    'SELECT COUNT(*) AS huerfanos, MIN(creado_en) AS desde, MAX(creado_en) AS hasta FROM mensajes WHERE conversacion_id IS NULL'
  );
  if (huerfanos > 0) {
    const r = await q(
      "INSERT INTO conversaciones (titulo, resumen, modo, inicio, fin) VALUES ('Primeras conversaciones', 'Mensajes anteriores al archivo de conversaciones.', 'texto', ?, ?)",
      [desde, hasta]
    );
    await q('UPDATE mensajes SET conversacion_id = ? WHERE conversacion_id IS NULL', [r.insertId]);
  }
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
