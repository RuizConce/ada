// Google Drive simulado (API v3 + Sheets v4 mínimas) con control de fallas y contadores.
// Uso: node fake-drive.js <puerto>
const http = require('http');
const puerto = parseInt(process.argv[2], 10) || 9933;

let archivos = new Map(); // id → { id, name, mimeType, version, md5Checksum, modifiedTime, trashed, parents, texto, acceso, appProperties, hojas }
let fallas = { meta: 0, meta403: 0, descarga: 0, borrado: 0, retardo_ms: 0, retardo_ids: [] };
let n = 0;
let stats;
function reset() { stats = { meta: {}, export: {}, media: {}, copias: {}, borrados: 0, borrado_fallido: 0, sheets: {}, total_meta: 0, total_descargas: 0, escrituras: {} }; }
reset();
const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function error(res, status, reason, message) { json(res, status, { error: { code: status, message: message || reason, errors: [{ reason }] } }); }
function leerCuerpo(req) { return new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch (_) { r({}); } }); }); }
const origen = (f) => (f.copiaDe ? archivos.get(f.copiaDe) : f);
const publico = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, version: String(f.version), md5Checksum: f.md5Checksum, modifiedTime: f.modifiedTime,
  trashed: !!f.trashed, parents: f.parents || ['carpeta-prueba'], webViewLink: `https://drive.simulado/${f.id}`, appProperties: f.appProperties, size: String((f.texto || '').length) });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    // ---- Control ----
    if (p === '/control/archivos' && req.method === 'POST') { const b = await leerCuerpo(req); for (const f of b.archivos) archivos.set(f.id, { acceso: true, version: 1, modifiedTime: '2026-10-01T10:00:00.000Z', ...f }); return json(res, 200, { ok: true, total: archivos.size }); }
    if (p === '/control/cambiar' && req.method === 'POST') { const b = await leerCuerpo(req); const f = archivos.get(b.id); Object.assign(f, b.cambios); return json(res, 200, publico(f)); }
    if (p === '/control/fallas' && req.method === 'POST') { fallas = { ...fallas, ...(await leerCuerpo(req)) }; return json(res, 200, fallas); }
    if (p === '/control/stats') return json(res, 200, { ...stats, vivos: [...archivos.values()].filter((f) => f.copiaDe).map((f) => ({ id: f.id, name: f.name, copiaDe: f.copiaDe })), existe: Object.fromEntries([...archivos.keys()].map((k) => [k, true])) });
    if (p === '/control/reset' && req.method === 'POST') { reset(); return json(res, 200, { ok: true }); }

    // ---- Escrituras (Sheets, Docs, subida, PATCH de Drive) ----
    let w = p.match(/^\/sheets\/v4\/spreadsheets\/([^/:]+)\/values\/[^/]+$/);
    if (w && (req.method === 'PUT' || req.method === 'POST')) { await leerCuerpo(req); inc(stats.escrituras, decodeURIComponent(w[1])); return json(res, 200, { updatedCells: 2, updatedRange: 'A1:B1', updates: { updatedRange: 'A2:B2' } }); }
    w = p.match(/^\/docs\/v1\/documents\/([^/:]+):batchUpdate$/);
    if (w) { await leerCuerpo(req); inc(stats.escrituras, decodeURIComponent(w[1])); return json(res, 200, { replies: [] }); }
    if (p === '/upload/drive/v3/files' && req.method === 'POST') { req.resume(); inc(stats.escrituras, 'subida'); n += 1; return json(res, 200, { id: `subido-${n}`, webViewLink: 'https://drive.simulado/subido' }); }
    if (p === '/drive/v3/files' && req.method === 'POST') {
      const b = await leerCuerpo(req); n += 1; const id = `carpeta-${n}`;
      archivos.set(id, { id, name: b.name, mimeType: b.mimeType, parents: b.parents || ['root'], acceso: true, version: 1 });
      inc(stats.escrituras, `crear:${(b.parents || ['root'])[0]}`); return json(res, 200, publico(archivos.get(id)));
    }
    w = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (w && req.method === 'PATCH') {
      const id = decodeURIComponent(w[1]); const f = archivos.get(id); const b = await leerCuerpo(req);
      if (!f) return error(res, 404, 'notFound');
      Object.assign(f, b);
      if (u.searchParams.get('addParents')) f.parents = [u.searchParams.get('addParents')];
      inc(stats.escrituras, id); return json(res, 200, publico(f));
    }

    // ---- Sheets ----
    let m = p.match(/^\/sheets\/v4\/spreadsheets\/([^/:]+)(\/values:batchGet)?$/);
    if (m) {
      const f = archivos.get(decodeURIComponent(m[1]));
      if (!f) return error(res, 404, 'notFound');
      const o = origen(f);
      if (m[2]) { inc(stats.sheets, o.id); stats.total_descargas += 1; }
      const hojas = o.hojas || [{ nombre: 'Hoja1', valores: [['a', 'b'], [String(o.texto || '').slice(0, 30), '1']] }];
      if (!m[2]) return json(res, 200, { properties: { title: o.name }, sheets: hojas.map((h) => ({ properties: { title: h.nombre, gridProperties: { rowCount: h.valores.length } } })) });
      return json(res, 200, { valueRanges: hojas.map((h) => ({ values: h.valores })) });
    }

    // ---- Drive ----
    if (p === '/drive/v3/files' && req.method === 'GET') {
      const padre = ((u.searchParams.get('q') || '').match(/'([^']+)' in parents/) || [])[1];
      return json(res, 200, { files: [...archivos.values()].filter((f) => !f.copiaDe && (!padre || (f.parents || ['carpeta-prueba']).includes(padre))).slice(0, 50).map(publico) });
    }
    m = p.match(/^\/drive\/v3\/files\/([^/]+)(\/copy|\/export)?$/);
    if (!m) return error(res, 404, 'notFound', 'ruta');
    const id = decodeURIComponent(m[1]);
    const f = archivos.get(id);
    if (req.method === 'DELETE') {
      if (fallas.borrado > 0) { fallas.borrado -= 1; stats.borrado_fallido += 1; return error(res, 500, 'backendError'); }
      if (!f) return error(res, 404, 'notFound');
      archivos.delete(id); stats.borrados += 1; res.writeHead(204); return res.end();
    }
    const esMeta = req.method === 'GET' && !m[2] && u.searchParams.get('alt') !== 'media';
    if (esMeta && (!f || !f.acceso)) { inc(stats.meta, id); stats.total_meta += 1; }
    if (!f || !f.acceso) return error(res, 404, 'notFound', `File not found: ${id}.`);
    if (m[2] === '/copy') {
      const b = await leerCuerpo(req);
      n += 1;
      const copia = { id: `copia-${n}`, name: b.name, mimeType: b.mimeType, version: 1, copiaDe: f.id, appProperties: b.appProperties, acceso: true, parents: f.parents };
      archivos.set(copia.id, copia); inc(stats.copias, f.id);
      return json(res, 200, { id: copia.id, name: copia.name });
    }
    if (m[2] === '/export' || u.searchParams.get('alt') === 'media') {
      const o = origen(f);
      if (fallas.descarga > 0) { fallas.descarga -= 1; return error(res, 503, 'backendError'); }
      if (fallas.retardo_ms && (!fallas.retardo_ids.length || fallas.retardo_ids.includes(o.id))) await dormir(fallas.retardo_ms);
      inc(m[2] === '/export' ? stats.export : stats.media, o.id); stats.total_descargas += 1;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(o.texto || '');
    }
    // metadatos
    inc(stats.meta, id); stats.total_meta += 1;
    if (fallas.meta > 0) { fallas.meta -= 1; return error(res, 503, 'backendError'); }
    if (fallas.meta403 > 0) { fallas.meta403 -= 1; return error(res, 403, 'userRateLimitExceeded'); }
    return json(res, 200, publico(f));
  } catch (e) {
    error(res, 500, 'interno', e.message);
  }
}).listen(puerto, () => console.log(`Drive simulado en :${puerto}`));
