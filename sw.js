// Service Worker – macht die App offline nutzbar (App-Hülle wird gecacht,
// die Daten selbst cached Firestore separat).
const CACHE = "kaffeekasse-v5";

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/firebase.js",
  "./js/firebase-config.js",
  "./js/balance.js",
  "./js/export.js",
  "./js/icons.js",
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
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Firebase SDK vom CDN: einmal laden, dann dauerhaft aus dem Cache
  if (url.hostname === "www.gstatic.com") {
    event.respondWith(
      caches.match(event.request).then((hit) =>
        hit || fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
      )
    );
    return;
  }

  // Firestore/Auth-Traffic nie abfangen
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("firebaseapp.com")) return;

  // Eigene Dateien: Netz zuerst (damit Updates ankommen), sonst Cache
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      }).catch(() =>
        caches.match(event.request).then((hit) => hit || caches.match("./index.html"))
      )
    );
  }
});
