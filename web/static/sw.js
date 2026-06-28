// Service worker SpendTrack: делает PWA устанавливаемой и работающей офлайн.
// Приложение полностью локальное (данные в IndexedDB), сети нет — поэтому здесь
// стратегия «сначала кэш» для оболочки, с фоновым обновлением. На file:// (внутри
// Android-WebView) воркер не запускается, и это нормально: там и так всё локально.
const CACHE = "spendtrack-v6";
const SHELL = [
  ".", "index.html", "styles.css",
  "core.js", "store.js", "localapi.js", "app.js",
  "icons/favicon.svg", "manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : null))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => hit || caches.match("index.html"));
      return hit || net;
    })
  );
});
