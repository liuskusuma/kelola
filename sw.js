// Supaya Kelola tetap terbuka tanpa internet.
// Naikkan VERSION setiap kali ada file yang berubah.
const VERSION = 'kelola-v25';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/logo.png',
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
  'js/kategori.js',
  'js/warna.js',
  'js/grafik.js',
  'js/excel.js',
  'js/penjualan.js',
  'js/tagihan.js',
  'js/staff.js',
  'js/faceid.js',
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

// Notifikasi pengingat tagihan dari server (lihat supabase/functions/pengingat-tagihan).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { isi: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.judul || 'Kelola', {
    body: d.isi || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || 'kelola-tagihan',
    data: { url: d.url || './?buka=tagihan' },
  }));
});

// Notifikasi disentuh: buka Kelola di daftar tagihan Belum lunas.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const buka = list.find((w) => w.url.startsWith(self.registration.scope));
    if (buka) {
      buka.postMessage({ buka: 'tagihan' });
      return buka.focus();
    }
    return self.clients.openWindow(url);
  }));
});
