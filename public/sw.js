// Service worker mínimo: permite instalar la app y abrirla aunque la red falle.
// La API nunca se guarda en caché.
const CACHE = 'ada-v21';
const COMPARTIDO = 'ada-compartido';
const ARCHIVOS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== COMPARTIDO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// "Compartir con ADA" desde WhatsApp u otra app (Android): se guarda lo compartido y se abre la app.
async function recibirCompartido(request) {
  try {
    const datos = await request.formData();
    const partes = [];
    const titulo = datos.get('title');
    const texto = datos.get('text');
    const enlace = datos.get('url');
    if (titulo) partes.push(String(titulo));
    if (texto) partes.push(String(texto));
    if (enlace && !String(texto || '').includes(enlace)) partes.push(String(enlace));
    const nombres = [];
    for (const f of datos.getAll('archivos')) {
      if (f && typeof f.text === 'function') {
        nombres.push(f.name || 'archivo');
        partes.push(await f.text());
      }
    }
    const cache = await caches.open(COMPARTIDO);
    await cache.put('/compartido-datos', new Response(JSON.stringify({ texto: partes.join('\n\n'), archivos: nombres, en: Date.now() }), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch (_) {}
  return Response.redirect('/?compartido=1', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/compartir') {
    e.respondWith(recibirCompartido(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || e.request.mode === 'navigate' && url.search) return;
  // Red primero; caché solo como respaldo.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});

// ---------- Avisos de ADA ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { cuerpo: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'ADA', {
    body: d.cuerpo || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || 'ada',
    renotify: true,
    vibrate: [180, 80, 180],
    data: { url: d.url || '/' },
  }));
});

// Al tocar el aviso: abre ADA (o la trae al frente) en lo que corresponde.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const v of ventanas) {
      if (new URL(v.url).origin === self.location.origin) {
        await v.focus();
        v.postMessage({ tipo: 'aviso', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
