/**
 * Giftlio service worker.
 *
 * Strategy:
 * - Precache the app shell (HTML/CSS/JS/manifest/icons) on install.
 * - Navigation requests (the app shell): network-first, falling back to the
 *   cached shell when offline, so users always get the latest deploy when
 *   online but the app still opens when offline.
 * - Same-origin static assets: stale-while-revalidate (serve from cache
 *   instantly, refresh the cache in the background).
 * - Cross-origin static assets (Google Fonts, the Supabase SDK from the
 *   CDN): stale-while-revalidate as well, so they still work offline after
 *   the first successful load.
 * - Anything going to Supabase itself (auth/rest/storage APIs), and any
 *   non-GET request (POST/PATCH/DELETE), is left completely untouched and
 *   goes straight to the network. Gift card listings, orders, and auth must
 *   always be live data, and mutating requests must never be served from a
 *   cache.
 */

const CACHE_VERSION = 'v5';
const STATIC_CACHE = `cardswap-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `cardswap-runtime-${CACHE_VERSION}`;

// Core app shell. env-config.js is intentionally NOT precached here -- it's
// handled as network-first at runtime so a fresh deploy's Supabase config
// is always picked up when the user is online.
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/supabase-client.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon-64.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isSupabaseRequest(url) {
  return url.hostname.endsWith('.supabase.co');
}

function isNavigationRequest(request) {
  return request.mode === 'navigate';
}

async function networkFirst(request, cacheName, fallbackUrl) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      // Cache both normal (basic) and opaque (no-cors cross-origin) responses.
      if (response && (response.status === 200 || response.type === 'opaque')) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || (await networkFetch) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept non-GET requests (signup, login, place order, submit
  // card, admin approve/reject, etc. must always hit the network directly).
  if (request.method !== 'GET') return;

  // Never cache anything going to Supabase -- always live data.
  if (isSupabaseRequest(url)) return;

  // App shell navigations: network-first with offline fallback to the
  // cached index.html so the SPA still opens when offline.
  if (isNavigationRequest(request)) {
    event.respondWith(networkFirst(request, STATIC_CACHE, '/index.html'));
    return;
  }

  // env-config.js: network-first so a redeploy's config is picked up
  // immediately when online, but still available offline from cache.
  if (url.pathname.endsWith('/env-config.js')) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  // The actual app code (app.js, supabase-client.js, style.css) --
  // network-first too. stale-while-revalidate was used here originally,
  // but that always serves whatever was cached LAST time and only
  // refreshes in the background for next load -- during active,
  // frequent deployment that meant staying one version behind
  // indefinitely unless enough time passed between reloads for the
  // background refresh to catch up. Correctness matters more than the
  // performance gain here.
  const isCoreAppCode = url.pathname.endsWith('/app.js') || url.pathname.endsWith('/supabase-client.js') || url.pathname.endsWith('/style.css');
  if (isCoreAppCode) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  // Same-origin static assets and known cross-origin static assets
  // (Google Fonts, Supabase JS SDK CDN): stale-while-revalidate. Fine
  // here -- these change rarely if ever, so the performance benefit is
  // worth it without the staleness risk.
  const isSameOrigin = url.origin === self.location.origin;
  const isKnownStaticCdn =
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com' ||
    url.hostname === 'cdn.jsdelivr.net';

  if (isSameOrigin || isKnownStaticCdn) {
    event.respondWith(staleWhileRevalidate(request, isSameOrigin ? STATIC_CACHE : RUNTIME_CACHE));
  }
});
