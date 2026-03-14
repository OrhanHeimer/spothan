// ── Spothan Service Worker ──
// Strategy:
//   App shell (HTML, CSS, JS, fonts) → Cache-first (instant loads, works offline)
//   Map tiles (OpenStreetMap)        → Cache-first with network fallback (saves data, works offline)
//   API calls (weather, geocoding)   → Network-first with cache fallback (fresh data when online)
//   Everything else                  → Network-first

const CACHE_VERSION  = 'spothan-v1';
const TILE_CACHE     = 'spothan-tiles-v1';
const API_CACHE      = 'spothan-api-v1';

// Files that make up the app shell — cached on install
const APP_SHELL = [
  '/',
  '/index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js',
];

// ── INSTALL — pre-cache app shell ──
self.addEventListener('install', event => {
  console.log('[SW] Installing…');
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => {
        console.log('[SW] Pre-caching app shell');
        // Cache each item individually so one failure doesn't break the whole install
        return Promise.allSettled(
          APP_SHELL.map(url => cache.add(url).catch(e => console.warn('[SW] Failed to cache:', url, e)))
        );
      })
      .then(() => self.skipWaiting()) // activate immediately without waiting for old SW to die
  );
});

// ── ACTIVATE — clean up old caches ──
self.addEventListener('activate', event => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION && key !== TILE_CACHE && key !== API_CACHE)
          .map(key => { console.log('[SW] Deleting old cache:', key); return caches.delete(key); })
      )
    ).then(() => self.clients.claim()) // take control of all open tabs immediately
  );
});

// ── FETCH — route requests to the right strategy ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests (POST, etc.)
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http requests
  if (!url.protocol.startsWith('http')) return;

  // ── MAP TILES — cache-first, long TTL ──
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // ── API CALLS — network-first, cache fallback ──
  if (
    url.hostname.includes('api.open-meteo.com') ||      // weather
    url.hostname.includes('photon.komoot.io') ||         // geocoding
    url.hostname.includes('nominatim.openstreetmap.org') // reverse geocoding
  ) {
    event.respondWith(networkFirstStrategy(event.request, API_CACHE, 60 * 60 * 1000)); // 1hr cache
    return;
  }

  // ── GOOGLE FONTS — cache-first ──
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirstStrategy(event.request, CACHE_VERSION));
    return;
  }

  // ── APP SHELL — cache-first ──
  if (url.hostname === self.location.hostname || url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirstStrategy(event.request, CACHE_VERSION));
    return;
  }

  // ── DEFAULT — network-first ──
  event.respondWith(networkFirstStrategy(event.request, CACHE_VERSION));
});

// ─────────────────────────────────────────────
// STRATEGIES
// ─────────────────────────────────────────────

// Cache-first: return cached version instantly, update cache in background
async function cacheFirstStrategy(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    // Offline and not cached — return a simple offline page for navigation requests
    if (request.mode === 'navigate') return offlinePage();
    throw e;
  }
}

// Network-first: try network, fall back to cache; optional maxAge to skip stale cache
async function networkFirstStrategy(request, cacheName, maxAge = Infinity) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) {
      // Check age if maxAge is set
      const dateHeader = cached.headers.get('date');
      if (dateHeader && maxAge < Infinity) {
        const age = Date.now() - new Date(dateHeader).getTime();
        if (age > maxAge) throw e; // too stale, don't serve
      }
      return cached;
    }
    if (request.mode === 'navigate') return offlinePage();
    throw e;
  }
}

// Tile strategy: cache-first with a 7-day TTL and a 500-tile limit
async function tileStrategy(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    const dateHeader = cached.headers.get('date');
    const age = dateHeader ? Date.now() - new Date(dateHeader).getTime() : 0;
    if (age < 7 * 24 * 60 * 60 * 1000) return cached; // fresh enough
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      await trimCache(TILE_CACHE, 500); // keep max 500 tiles (~5MB)
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    if (cached) return cached; // serve stale tile if offline
    throw e;
  }
}

// Trim a cache to maxItems entries (oldest first)
async function trimCache(cacheName, maxItems) {
  const cache  = await caches.open(cacheName);
  const keys   = await cache.keys();
  if (keys.length > maxItems) {
    await cache.delete(keys[0]);
  }
}

// Minimal offline fallback page
function offlinePage() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Spothan — Offline</title>
  <style>
    body{margin:0;font-family:sans-serif;background:#0d0d0d;color:#f5f0ea;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px;box-sizing:border-box;}
    h1{font-size:28px;margin-bottom:12px;}
    p{font-size:15px;color:#a09a94;max-width:300px;line-height:1.6;}
    button{margin-top:28px;padding:14px 28px;background:#ff3c00;color:white;border:none;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer;}
  </style>
</head>
<body>
  <div style="font-size:52px;margin-bottom:16px">🗺️</div>
  <h1>You're offline</h1>
  <p>Spothan needs a connection to load the map. Connect to Wi-Fi or mobile data and try again.</p>
  <button onclick="location.reload()">Try again</button>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
