// Minimal offline cache for the installed web app (PWA).
// Bump CACHE when you change files so phones pick up the new version.
const CACHE = 'handheld-v5';
const FILES = [
  './', 'index.html', 'mobile.html', 'style.css', 'mobile.css', 'ui.js', 'ui-mobile.js',
  'handheld.js', 'three.min.js', 'game/game.js', 'game/demo.js', 'manifest.webmanifest',
  'game/gb/gb.js', 'game/gb/cpu.js', 'game/gb/ppu.js', 'game/gb/apu.js', 'game/gb/cart.js',
  'icons/icon-192.png', 'icons/icon-512.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && new URL(e.request.url).origin === location.origin) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  })));
});
