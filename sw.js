// Supaya Kelola tetap terbuka tanpa internet.
// Naikkan VERSION setiap kali ada file yang berubah.
const VERSION = 'kelola-v9';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/logo.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/supabase-2.45.4.js',
  'vendor/fonts/exo-2-latin-700-normal.woff2',
  'vendor/fonts/exo-2-latin-700-italic.woff2',
  'vendor/fonts/exo-2-latin-800-normal.woff2',
  'vendor/fonts/exo-2-latin-800-italic.woff2',
  'js/config.js',
  'js/bahasa.js',
  'js/store.js',
  'js/hitung.js',
  'js/warna.js',
  'js/penjualan.js',
  'js/staff.js',
  'js/sync.js',
  'js/app.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// File aplikasi: ambil dari jaringan dulu, pakai cache kalau offline.
// Permintaan ke server lain (Supabase) tidak disentuh.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
