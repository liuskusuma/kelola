# Kelola

Aplikasi web statis (tanpa build step) untuk UMKM: kalkulator harga jual, kasir, laporan omzet/laba, plus login dan sinkronisasi cloud lewat Supabase. Nama sebelumnya: KalkuLaku, lalu UMKalc.

- Bahasa antarmuka, komentar kode, dan dokumen: Bahasa Indonesia yang sederhana. Pengguna adalah pemilik usaha kecil, kebanyakan memakai HP.
- Data bersifat local-first: semua perubahan lewat `store.put` / `store.remove` di `js/store.js`, lalu `scheduleSync()` di `js/app.js`. Jangan menulis ke Supabase langsung dari tampilan.
- Setiap catatan adalah satu baris di tabel `records` (`kind` = `produk`, `bahan`, `transaksi`, `pengeluaran`, atau `profil`). Konflik diselesaikan dengan "perubahan terbaru menang" berdasarkan `updated_at`.
- Desain: soft UI seperti aplikasi Bagi Rata (kartu menonjol, isian tertekan, judul Exo 2 miring), dominan putih dengan navy `#0a2a6e` dan kuning `#fecb10` dari logo (`icons/logo.svg`). Mode gelap memakai navy seperti tema Default Bagi Rata. Warna diatur lewat variabel CSS di `index.html`.
- Tampilan bawaan selalu terang (putih), walau HP memakai mode gelap; gelap hanya kalau dipilih di Akun (`data-tema` di `<html>`). Pengguna pernah mengeluh tampilan "dominan biru" karena HP-nya mode gelap.
- Semua teks antarmuka lewat `t('teks Indonesia')`; terjemahan Inggris ada di `js/bahasa.js`. Uji `tests/bahasa.test.js` gagal kalau ada teks tanpa terjemahan. Bahasa dan tema disimpan per perangkat (`kelola:pengaturan`), bukan di cloud.
- Foto produk disimpan sebagai data URL JPEG kecil (maks 480 px) di `produk.data.foto`.
- Kalau mengubah file yang di-cache, naikkan `VERSION` di `sw.js` dan tambahkan file baru ke daftar `FILES`.
- Rumus HPP, saran harga, dan potongan stok ada di `js/hitung.js` (tanpa DOM). Modal produk resep/paket selalu dihitung ulang dari harga bahan saat ini; `data.modal` hanya catatan HPP saat produk terakhir disimpan, dipakai untuk peringatan harga bahan.
- Uji: `node --test` untuk logika sinkronisasi dan rumus, dan `tests/e2e.js` (Playwright) untuk alur di browser.
- Akun staff (`supabase/staff.sql`, `js/staff.js`): staff tidak bisa membaca `records` owner. Produk untuk kasir staff diambil lewat fungsi `produk_kasir()` (tanpa modal/resep). Penjualan staff masuk ke tabel `penjualan_staff`; HP owner mengambilnya (sekaligus menandai `diproses`) lalu mengubahnya jadi `transaksi` biasa lewat `KelolaPenjualan.olahPenjualanStaff` di `js/penjualan.js`. Jangan pernah mengirim modal, laba, resep, atau bahan ke HP staff.
- Mode kasir PIN hanya menyembunyikan tampilan di satu perangkat (`kunci` di `kelola:pengaturan`, PIN disimpan sebagai hash); bukan pengaman data.
