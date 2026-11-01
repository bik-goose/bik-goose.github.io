/* Goose's service worker (card #464).

   WHAT IT IS FOR: the shell opens with no line. Every shell file is
   precached at install, so the page, the key, the 988 rail and the sponsor's
   tel: link all come up in a dead zone.

   WHAT IT NEVER DOES:
   - It never touches /api/ or any other origin. The Mac's answers are his
     life and his private room; a cached copy would be a stale truth sitting
     on the phone's disk. Every API call goes straight to the network.
   - It never caches anything outside the SHELL list below.

   CACHE-FIRST, VERSIONED (the SPEC). The page is served from this cache
   until CACHE changes, so bump CACHE on every shell change, or the phone
   keeps the old page. Two lessons copied from Almanac's sw.js
   (~/Local Models/almanac-pwa/sw.js):
   - install fetches with cache:'reload', so GitHub Pages' own HTTP cache can
     never slip yesterday's file into today's version;
   - install is all or nothing (Almanac card #99): one missed file fails it,
     and the old version stays whole and live. */
const CACHE = "goose-shell-v2";
const PREFIX = "goose-shell-";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./app.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u =>
        fetch(u, { cache: "reload" }).then(r => {
          if (!r.ok) throw new Error("goose shell fetch failed: " + u + " " + r.status);
          return c.put(u, r);
        }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  // Only our own old versions: CacheStorage is shared by everything on this origin.
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith(PREFIX) && k !== CACHE)
                                .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The version that cannot lie (Almanac #8): the page asks, the worker answers
// with what is actually installed. Settings shows it.
self.addEventListener("message", e => {
  if (e.data && e.data.type === "VERSION" && e.source) {
    e.source.postMessage({ type: "VERSION", version: CACHE });
  }
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let u;
  try { u = new URL(req.url); } catch (err) { return; }
  if (u.origin !== self.location.origin) return;       // another origin: never cached, never answered
  if (u.pathname.indexOf("/api/") !== -1) return;      // the Mac's answers: never cached
  const base = new URL(self.registration.scope).pathname;
  if (!u.pathname.startsWith(base)) return;
  let rel = "./" + u.pathname.slice(base.length);
  if (rel === "./index.html") rel = "./";              // one copy of the page, under the scope root
  if (SHELL.indexOf(rel) === -1) return;               // not a shell file: the network, uncached
  e.respondWith(
    caches.open(CACHE)
      .then(c => c.match(rel))
      .then(hit => hit || fetch(req))
  );
});
