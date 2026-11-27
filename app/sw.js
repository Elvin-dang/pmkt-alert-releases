// PMKT Alert web viewer – service worker: opens offline / instantly after the first visit.
// - the page, its scripts and build.json: network first (a new release shows up on the next open), cache as fallback
// - Pyodide and the app bundle: versioned URLs → cache first, downloaded once
// - Supabase (sign-in, reports): never cached – reports stay encrypted on the server only
"use strict";
const CACHE = "pmkt-web-1.9.0-4399584ce2b3";
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const SHELL = ["./", "index.html", "build.json", "manifest.webmanifest", "styles.css", "app.js", "deck.js", "i18n.js", "i18n_en.js", "duck.png", "login-bg.jpg", "shim.js", "worker.js", "web.css", "vendor/chart.umd.min.js", "fonts/fira-code-latin-400.woff2", "fonts/fira-code-latin-500.woff2", "fonts/fira-code-latin-ext-400.woff2", "fonts/fira-code-latin-ext-500.woff2", "fonts/fira-sans-latin-400.woff2", "fonts/fira-sans-latin-500.woff2", "fonts/fira-sans-latin-600.woff2", "fonts/fira-sans-latin-700.woff2", "fonts/fira-sans-latin-ext-400.woff2", "fonts/fira-sans-latin-ext-500.woff2", "fonts/fira-sans-latin-ext-600.woff2", "fonts/fira-sans-latin-ext-700.woff2", "fonts/fira-sans-vietnamese-400.woff2", "fonts/fira-sans-vietnamese-500.woff2", "fonts/fira-sans-vietnamese-600.woff2", "fonts/fira-sans-vietnamese-700.woff2", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "bundle/app-15158e608e25.zip", "wheels/et_xmlfile-2.0.0-py3-none-any.whl", "wheels/openpyxl-3.1.5-py2.py3-none-any.whl"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pmkt-web-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const immutable = (url) => url.href.startsWith(PYODIDE) || /\/(wheels|bundle)\//.test(url.pathname);
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (immutable(url)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  } else if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
