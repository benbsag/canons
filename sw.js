// Minimal service worker — caches the app shell so Wine Cave opens
// instantly and works offline once installed to the home screen.
//
// Strategy: NETWORK-FIRST for same-origin GETs. The newest deploy is served
// whenever the device is online, and the cache is updated in the background;
// the cache is only used as a fallback when offline. This means a new Netlify
// deploy shows up after a single reload — no need to hand-bump a version on
// every change. (Bump CACHE_NAME only if you want to force-purge old caches.)
const CACHE_NAME = "wine-cave-shell-v7";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./research.js",
  "./research-api.js",
  "./storage.js",
  "./sync.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Only handle GET requests; let everything else pass straight to the network.
  if (event.request.method !== "GET") return;

  const isSameOrigin = new URL(event.request.url).origin === self.location.origin;
  // Cross-origin (e.g. Google Fonts): don't intervene.
  if (!isSameOrigin) return;

  // Network-first: fetch the latest, refresh the cache, fall back to cache
  // (then to the cached index.html for navigations) when offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === "navigate") return caches.match("./index.html");
          return cached;
        })
      )
  );
});
