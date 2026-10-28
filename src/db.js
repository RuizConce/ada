// Conexión a MySQL y creación automática del esquema.
const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');

// Cada persona tiene su propia base de datos: Cristian (id 1) usa la principal y cada invitado
// una aparte (railway_u2, railway_u3…). Así nadie ve lo de otro, ni su agenda ni su correo.
const sesion = new AsyncLocalStorage();
const CRISTIAN = { id: 1, nombre: 'Cristian', admin: true };
const usuario = () => sesion.getStore() || CRISTIAN;
const comoUsuario = (u, fn) => sesion.run(u, fn);

const PROYECTOS_INICIALES = [
  'Huayca',
  'PROTEGE+',
  'Eliss Conecta',
  'Autorización SEREMI Andaluz',
  'Autorización SEREMI Bellavista',
  'Personal',
];

const pools = new Map();

function urlBase() {
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!url) throw new Error('Falta DATABASE_URL (en Railway: ${{MySQL.MYSQL_URL}})');
  return new URL(url);
}
const basePrincipal = () => decodeURIComponent(urlBase().pathname.replace(/^\//, ''));
const baseDe = (id) => (id === 1 ? basePrincipal() : `${basePrincipal()}_u${parseInt(id, 10)}`);

function poolDe(id) {
  if (!pools.has(id)) {
    const u = urlBase();
    u.pathname = `/${encodeURIComponent(baseDe(id))}`;
    pools.set(id, mysql.createPool({
      uri: u.toString(),
      waitForConnections: true,
      connectionLimit: id === 1 ? 5 : 2,
      // Las fechas se guardan y leen en la hora local del proceso (TZ=America/Santiago).
      timezone: 'local',
      dateStrings: false,
      charset: 'utf8mb4',
    }));
  }
  return pools.get(id);
}

const getPool = () => poolDe(usuario().id);

// Consulta en la base de la persona que está usando ADA.
async function q(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

// Consulta en la base principal (lista de personas con acceso).
async function qPrincipal(sql, params = []) {
  const [rows] = await poolDe(1).query(sql, params);
  return rows;
}

// Transacción en la base principal: fn recibe una consulta ligada a la misma conexión.
// Si fn lanza un error, se deshace todo.
async function transaccionPrincipal(fn) {
  const cx = await poolDe(1).getConnection();
  try {
    await cx.beginTransaction();
    const tq = async (sql, params = []) => (await cx.query(sql, params))[0];
    const r = await fn(tq);
    await cx.commit();
    return r;
  } catch (e) {
    try { await cx.rollback(); } catch (_) {}
    throw e;
  } finally {
    cx.release();
  }
}

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS lab_voz (
    id INT AUTO_INCREMENT PRIMARY KEY,
    modo VARCHAR(10) NOT NULL,
    turnos INT NULL,
    duracion_s INT NULL,
    demora_mediana_ms INT NULL,
    demora_p95_ms INT NULL,
    interrupciones INT NULL,
    naturalidad TINYINT NULL,
    comprension TINYINT NULL,
    utilidad TINYINT NULL,
    comentario TEXT NULL,
    datos TEXT NULL,
    creado_en DATETIME NOT NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS push_suscripciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    endpoint VARCHAR(500) NOT NULL,
    datos TEXT NOT NULL,
    dispositivo VARCHAR(160) NULL,
    creado_en DATETIME NOT NULL,
    UNIQUE KEY uniq_endpoint (endpoint)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS avisos_enviados (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(30) NOT NULL,
    clave VARCHAR(200) NOT NULL,
    titulo VARCHAR(200) NULL,
    enviado_en DATETIME NOT NULL,
    INDEX idx_tipo_clave (tipo, clave),
    INDEX idx_enviado (enviado_en)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
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
  `CREATE TABLE IF NOT EXISTS reuniones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo VARCHAR(200) NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'grabando',
    traducir TINYINT NOT NULL DEFAULT 0,
    transcripcion MEDIUMTEXT NULL,
    documento_id INT NULL,
    inicio DATETIME NOT NULL,
    fin DATETIME NULL
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
  ['acciones', 'responder_a', 'ALTER TABLE acciones ADD COLUMN responder_a VARCHAR(64) NULL'],
  ['mensajes', 'revisado', 'ALTER TABLE mensajes ADD COLUMN revisado MEDIUMTEXT NULL'],
  ['items', 'evento_id', 'ALTER TABLE items ADD COLUMN evento_id VARCHAR(255) NULL'],
  ['contactos', 'alias', 'ALTER TABLE contactos ADD COLUMN alias TEXT NULL'],
  ['items', 'importante', 'ALTER TABLE items ADD COLUMN importante TINYINT NOT NULL DEFAULT 0'],
];

async function initDb() {
  await comoUsuario(CRISTIAN, () => prepararBase(PROYECTOS_INICIALES));
  await qPrincipal(`CREATE TABLE IF NOT EXISTS usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(80) NOT NULL,
    clave_hash VARCHAR(200) NULL,
    admin TINYINT NOT NULL DEFAULT 0,
    activo TINYINT NOT NULL DEFAULT 1,
    version INT NOT NULL DEFAULT 1,
    nota VARCHAR(160) NULL,
    creado_en DATETIME NOT NULL,
    ultimo_ingreso DATETIME NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // Registro de cada llamada a Claude y de cada herramienta (sin contenido: solo metadatos).
  await qPrincipal(`CREATE TABLE IF NOT EXISTS llamadas_ia (
    id CHAR(36) PRIMARY KEY,
    usuario_id INT NOT NULL,
    conversacion_id INT NULL,
    turno_id CHAR(36) NOT NULL,
    encargo_id INT NULL,
    paso INT NOT NULL,
    modelo VARCHAR(80) NOT NULL,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cache_creacion INT NOT NULL DEFAULT 0,
    cache_lectura INT NOT NULL DEFAULT 0,
    busquedas INT NOT NULL DEFAULT 0,
    costo_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    duracion_ms INT NULL,
    stop_reason VARCHAR(40) NULL,
    herramientas VARCHAR(400) NULL,
    request_id VARCHAR(120) NULL,
    error VARCHAR(300) NULL,
    creado_en DATETIME NOT NULL,
    INDEX idx_turno (turno_id), INDEX idx_conv (usuario_id, conversacion_id), INDEX idx_dia (usuario_id, creado_en)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // Columnas agregadas después de crear llamadas_ia.
  for (const [col, sql] of [
    ['origen', "ALTER TABLE llamadas_ia ADD COLUMN origen VARCHAR(20) NOT NULL DEFAULT 'conversacion'"],
    ['costo_estimado', 'ALTER TABLE llamadas_ia ADD COLUMN costo_estimado DECIMAL(12,6) NULL'],
    ['trabajo_id', 'ALTER TABLE llamadas_ia ADD COLUMN trabajo_id CHAR(36) NULL, ADD INDEX idx_trabajo (trabajo_id)'],
    ['paso_id', 'ALTER TABLE llamadas_ia ADD COLUMN paso_id CHAR(36) NULL'],
  ]) {
    const [{ n }] = await qPrincipal("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llamadas_ia' AND COLUMN_NAME = ?", [col]);
    if (!n) await qPrincipal(sql);
  }
  // Un registro por turno (cada mensaje o tarea interna) con su estado final.
  await qPrincipal(`CREATE TABLE IF NOT EXISTS turnos_ia (
    turno_id CHAR(36) PRIMARY KEY,
    usuario_id INT NOT NULL,
    conversacion_id INT NULL,
    origen VARCHAR(20) NOT NULL DEFAULT 'conversacion',
    estado VARCHAR(30) NOT NULL,
    motivo VARCHAR(300) NULL,
    llamadas INT NOT NULL DEFAULT 0,
    costo_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    instancia VARCHAR(40) NULL,
    inicio DATETIME(3) NOT NULL,
    fin DATETIME(3) NULL,
    INDEX idx_estado (estado), INDEX idx_usuario (usuario_id, inicio)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // ---------- Etapa 3: encargos complejos persistentes (trabajos) ----------
  // Un solo trabajo activo por persona: columna generada + índice único (vale con solicitudes simultáneas).
  await qPrincipal(`CREATE TABLE IF NOT EXISTS trabajos (
    id CHAR(36) PRIMARY KEY,
    usuario_id INT NOT NULL,
    tipo VARCHAR(40) NOT NULL,
    titulo VARCHAR(200) NOT NULL,
    objetivo_cifrado MEDIUMTEXT NULL,
    esperado_cifrado MEDIUMTEXT NULL,
    estado VARCHAR(30) NOT NULL,
    activo_usuario INT AS (CASE WHEN estado IN ('propuesto','ejecutando','esperando_aprobacion','pausado','pausado_presupuesto','bloqueado') THEN usuario_id ELSE NULL END) STORED,
    presupuesto_usd DECIMAL(12,6) NOT NULL,
    gastado_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    estimado_total_usd DECIMAL(12,6) NULL,
    etapa VARCHAR(40) NULL,
    pasos_total INT NOT NULL DEFAULT 0,
    pasos_hechos INT NOT NULL DEFAULT 0,
    pausa_solicitada TINYINT NOT NULL DEFAULT 0,
    cancelar_solicitado TINYINT NOT NULL DEFAULT 0,
    lease_de VARCHAR(80) NULL,
    lease_hasta DATETIME(3) NULL,
    lease_epoch INT NOT NULL DEFAULT 0,
    motivo VARCHAR(300) NULL,
    resultado_cifrado MEDIUMTEXT NULL,
    resultado_hash CHAR(64) NULL,
    creado_en DATETIME(3) NOT NULL,
    aprobado_en DATETIME(3) NULL,
    actualizado_en DATETIME(3) NOT NULL,
    terminado_en DATETIME(3) NULL,
    UNIQUE KEY uq_un_activo (activo_usuario),
    INDEX idx_estado (estado, lease_hasta)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await qPrincipal(`CREATE TABLE IF NOT EXISTS trabajo_pasos (
    id CHAR(36) PRIMARY KEY,
    trabajo_id CHAR(36) NOT NULL,
    clave VARCHAR(190) NOT NULL,
    orden INT NOT NULL,
    etapa VARCHAR(40) NULL,
    tipo VARCHAR(40) NOT NULL,
    entrada_cifrada MEDIUMTEXT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    intentos INT NOT NULL DEFAULT 0,
    max_intentos INT NOT NULL DEFAULT 3,
    externo TINYINT NOT NULL DEFAULT 0,
    efecto_clave VARCHAR(190) NULL,
    efecto_estado VARCHAR(20) NULL,
    lease_epoch INT NULL,
    estimado_usd DECIMAL(12,6) NULL,
    costo_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    resultado_cifrado MEDIUMTEXT NULL,
    resultado_hash CHAR(64) NULL,
    error VARCHAR(300) NULL,
    inicio DATETIME(3) NULL,
    fin DATETIME(3) NULL,
    UNIQUE KEY uq_paso (trabajo_id, clave),
    INDEX idx_trabajo (trabajo_id, estado, orden)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await qPrincipal(`CREATE TABLE IF NOT EXISTS trabajo_eventos (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    trabajo_id CHAR(36) NOT NULL,
    tipo VARCHAR(40) NOT NULL,
    detalle VARCHAR(300) NULL,
    monto DECIMAL(12,6) NULL,
    actor VARCHAR(60) NULL,
    creado_en DATETIME(3) NOT NULL,
    INDEX idx_trabajo (trabajo_id, id)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // Reservas de presupuesto en MySQL: valen entre procesos y reinicios; vencen solas.
  await qPrincipal(`CREATE TABLE IF NOT EXISTS reservas_ia (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT NOT NULL,
    trabajo_id CHAR(36) NULL,
    paso_id CHAR(36) NULL,
    turno_id CHAR(36) NULL,
    monto DECIMAL(12,6) NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'activa',
    costo_real DECIMAL(12,6) NULL,
    creado_en DATETIME(3) NOT NULL,
    vence_en DATETIME(3) NOT NULL,
    INDEX idx_usuario (usuario_id, estado, vence_en),
    INDEX idx_trabajo (trabajo_id, estado)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // Sistema externo SIMULADO para probar que una acción con efecto fuera de ADA no se repite.
  await qPrincipal(`CREATE TABLE IF NOT EXISTS efectos_simulados (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    clave VARCHAR(190) NOT NULL,
    trabajo_id CHAR(36) NOT NULL,
    creado_en DATETIME(3) NOT NULL,
    INDEX idx_clave (clave)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await qPrincipal(`CREATE TABLE IF NOT EXISTS operaciones_herramienta (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT NOT NULL,
    conversacion_id INT NULL,
    turno_id CHAR(36) NOT NULL,
    llamada_id CHAR(36) NULL,
    herramienta VARCHAR(80) NOT NULL,
    objetivo VARCHAR(240) NULL,
    ok TINYINT NOT NULL DEFAULT 1,
    error VARCHAR(300) NULL,
    tamano_resultado INT NULL,
    repetida TINYINT NOT NULL DEFAULT 0,
    duracion_ms INT NULL,
    creado_en DATETIME NOT NULL,
    INDEX idx_turno (turno_id), INDEX idx_conv (usuario_id, conversacion_id)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // Gasto estimado en Claude por persona, día y modelo.
  await qPrincipal(`CREATE TABLE IF NOT EXISTS consumo (
    usuario_id INT NOT NULL,
    dia DATE NOT NULL,
    modelo VARCHAR(80) NOT NULL,
    turnos INT NOT NULL DEFAULT 0,
    busquedas INT NOT NULL DEFAULT 0,
    costo_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    PRIMARY KEY (usuario_id, dia, modelo)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // Cristian es siempre el id 1 (su clave es ADA_PASSWORD, no se guarda).
  await qPrincipal("INSERT IGNORE INTO usuarios (id, nombre, admin, creado_en) VALUES (1, 'Cristian', 1, ?)", [new Date()]);
}

const preparadas = new Set([1]);
// Crea (una vez) la base propia de un invitado.
async function prepararInvitado(id) {
  if (preparadas.has(id)) return;
  await qPrincipal(`CREATE DATABASE IF NOT EXISTS \`${baseDe(id).replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await comoUsuario({ id }, () => prepararBase(['Personal']));
  preparadas.add(id);
}

async function prepararBase(proyectosIniciales) {
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
    for (const nombre of proyectosIniciales) {
      await q('INSERT INTO proyectos (nombre, creado_en) VALUES (?, ?)', [nombre, ahora]);
    }
    console.log(`ADA: proyectos iniciales creados (${proyectosIniciales.length}) en ${baseDe(usuario().id)}`);
  }
}

module.exports = { q, qPrincipal, transaccionPrincipal, initDb, getPool, usuario, comoUsuario, prepararInvitado, baseDe };
