// ── Spothan Service Worker — Simplified ──
// Network-first for everything except map tiles
// This prevents stale CSS/JS from breaking the app

const CACHE_VERSION = 'spothan-v4';
const TILE_CACHE    = 'spothan-tiles-v4';

// ── INSTALL ──
self.addEventListener('install', event => {
  console.log('[SW] Installing v4…');
  self.skipWaiting();
});

// ── ACTIVATE — clean up old caches ──
self.addEventListener('activate', event => {
  console.log('[SW] Activating v4…');
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION && k !== TILE_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // Map tiles only — cache first
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // Everything else — always go to network
  event.respondWith(
    fetch(event.request).catch(() => {
      if (event.request.mode === 'navigate') return offlinePage();
    })
  );
});

async function tileStrategy(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch(e) {
    if (cached) return cached;
    throw e;
  }
}

function offlinePage() {
  return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Spothan — Offline</title>
<style>body{margin:0;font-family:sans-serif;background:#0d0d0d;color:#f5f0ea;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px;}
button{margin-top:28px;padding:14px 28px;background:#ff3c00;color:white;border:none;border-radius:14px;font-size:16px;cursor:pointer;}</style>
</head><body><div style="font-size:52px">🗺️</div><h1>You're offline</h1>
<p style="color:#a09a94">Spothan needs a connection to load.</p>
<button onclick="location.reload()">Try again</button></body></html>`,
    { headers: { 'Content-Type': 'text/html' } });
}
