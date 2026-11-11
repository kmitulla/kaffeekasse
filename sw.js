// Service Worker – macht die App offline nutzbar (App-Hülle wird gecacht,
// die Daten selbst cached Firestore separat).
const CACHE = "kaffeekasse-v11";

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/firebase.js",
  "./js/vendor/firebase.js",
  "./js/firebase-config.js",
  "./js/balance.js",
  "./js/export.js",
  "./js/icons.js",
  "./js/payment.js",
  "./js/qrcode.js",
  "./manifest.webmanifest",
  "./icons/favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Nur eigene Dateien per GET – Firebase-Verbindungen (Daten, Anmeldung)
  // werden nie abgefangen oder zwischengespeichert.
  if (req.method !== "GET" || url.origin !== location.origin) return;

  // Seitenaufrufe immer unter der festen App-Adresse cachen – nie mit
  // Parametern (z. B. dem geheimen Einmal-Code aus Passwort-E-Mails).
  const cacheKey = req.mode === "navigate" ? "./index.html" : url.pathname;

  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(cacheKey, copy));
      }
      return res;
    }).catch(() =>
      caches.match(cacheKey).then((hit) => hit || caches.match("./index.html"))
    )
  );
});
