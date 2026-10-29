# Kelola

Aplikasi web statis (tanpa build step) untuk UMKM: kalkulator harga jual, kasir, laporan omzet/laba, plus login dan sinkronisasi cloud lewat Supabase. Nama sebelumnya: KalkuLaku, lalu UMKalc.

- Bahasa antarmuka, komentar kode, dan dokumen: Bahasa Indonesia yang sederhana. Pengguna adalah pemilik usaha kecil, kebanyakan memakai HP.
- Data bersifat local-first: semua perubahan lewat `store.put` / `store.remove` di `js/store.js`, lalu `scheduleSync()` di `js/app.js`. Jangan menulis ke Supabase langsung dari tampilan.
- Setiap catatan adalah satu baris di tabel `records` (`kind` = `produk`, `transaksi`, atau `profil`). Konflik diselesaikan dengan "perubahan terbaru menang" berdasarkan `updated_at`.
- Kalau mengubah file yang di-cache, naikkan `VERSION` di `sw.js` dan tambahkan file baru ke daftar `FILES`.
- Uji: `node --test` untuk logika sinkronisasi, dan `tests/e2e.js` (Playwright) untuk alur di browser.
