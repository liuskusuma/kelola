# Kelola

Aplikasi web untuk UMKM: hitung harga jual dari modal, catat penjualan di kasir, dan pantau omzet serta laba.
Bisa dipasang di layar utama HP (iPhone dan Android) dan tetap jalan tanpa internet.

## Fitur

- **Produk + kalkulator harga jual.** Modal per satuan bisa diisi sendiri, dihitung dari resep, atau dari isi paket. Kelola memberi tiga saran harga jual (hemat, standar, premium) dari target margin, dibulatkan ke Rp500.
- **Bahan baku dan resep.** Catat bahan dengan harga beli per kemasan (misalnya gula Rp18.000 per 1.000 gram). Resep berisi bahan, jumlah yang dipakai, hasil jadi, dan biaya lain seperti gas atau kemasan. Modal per porsi dihitung otomatis.
- **Peringatan harga bahan.** Kalau harga bahan diubah, Kelola menunjukkan produk yang modalnya ikut berubah dan menyarankan harga jual baru yang menjaga margin lama.
- **Paket.** Gabungkan beberapa produk jadi satu harga; modalnya jumlah modal isinya.
- **Stok otomatis.** Produk yang stoknya dihitung berkurang saat terjual. Produk resep tanpa stok (dibuat saat dipesan) mengurangi stok bahannya. Tombol **Produksi** menambah stok produk jadi dan mengurangi bahan.
- **Kasir.** Ketuk produk untuk menambah ke keranjang, isi uang diterima, kembalian dihitung otomatis.
- **Struk untuk WhatsApp.** Setiap penjualan bisa dibuatkan struk bergambar untuk dikirim lewat WhatsApp, disimpan sebagai gambar, atau dikirim sebagai teks.
- **Laporan.** Omzet, laba kotor, pengeluaran, laba bersih, jumlah transaksi, margin rata-rata, produk terlaris, dan riwayat penjualan (hari ini, 7 hari, bulan ini, semua).
- **Grafik penjualan.** Laporan menampilkan batang Omzet dan Laba kotor per jam (hari ini), per hari (sampai 2 bulan), atau per bulan. Sentuh batang untuk melihat angkanya, atau buka **Lihat sebagai tabel**.
- **Laporan per tanggal.** Selain Hari ini, 7 hari, Bulan ini, dan Semua, pilih **Tanggal** untuk melihat laporan dari tanggal berapa sampai tanggal berapa saja.
- **QRIS.** Owner menyimpan gambar QRIS usaha di Akun → Pembayaran QRIS. Di kasir muncul tombol **QRIS** untuk ditunjukkan ke pembeli, juga di HP staff. Hanya owner yang bisa mengganti gambarnya.
- **Bayar nanti dan tagihan WhatsApp.** Di kasir pilih cara bayar: Tunai, QRIS, atau Bayar nanti (isi nama dan nomor WA pembeli). Penjualan yang belum lunas muncul di Laporan → **Belum lunas**. Tombol **Tagih via WA** membuka WhatsApp dengan pesan tagihan yang sudah terisi, dan **Catat bayar** mencatat pembayaran (boleh dicicil, tunai atau QRIS) sampai lunas.
- **Logo dan warna usaha.** Owner bisa mengganti logo di pojok kiri atas dan memilih warna aplikasi dari warna-warna logonya (Akun → Logo & warna usaha). Berlaku juga di HP staff dan di gambar struk.
- **Pengeluaran.** Catat biaya seperti sewa, listrik, atau gaji supaya laba bersih terlihat.
- **Foto produk.** Ambil langsung dari kamera atau pilih dari galeri. Foto diperkecil otomatis supaya ringan, lalu tampil di kasir dan daftar produk.
- **Bahasa dan tampilan.** Di tab Akun bisa memilih Bahasa Indonesia atau English, dan tampilan Terang (bawaan), Gelap, atau Ikuti HP. Pilihan ini disimpan per perangkat.
- **Login + simpan ke cloud.** Masuk dengan email dan kata sandi supaya data tidak hilang dan bisa dibuka di beberapa perangkat.
- **Akun staff.** Owner membuat kode undangan di tab Akun. Staff daftar dengan email sendiri di HP-nya, lalu memasukkan kode itu. Akun staff hanya bisa membuka Kasir: modal, laba, bahan baku, dan laporan tidak pernah dikirim ke HP staff. Penjualan staff masuk ke laporan owner (dengan tanda "oleh Budi", misalnya) dan memotong stok saat Kelola di HP owner terbuka dan tersambung internet.
- **Mode kasir dengan PIN.** Untuk HP atau tablet kasir yang dipakai bersama: owner mengunci perangkat itu ke kasir dengan PIN. Produk dan Laporan disembunyikan sampai PIN dimasukkan. Ini hanya menyembunyikan tampilan di perangkat itu; untuk staff yang tidak boleh tahu modal sama sekali, pakai akun staff.

## Cara kerja penyimpanan

Kelola menyimpan semua data di perangkat dulu, jadi tetap bisa dipakai tanpa internet. Setelah login, setiap perubahan dikirim ke cloud (Supabase) dan perubahan dari perangkat lain ditarik:

- Saat aplikasi dibuka, saat kembali online, saat aplikasi dibuka lagi dari latar belakang, setiap 60 detik, dan sekitar 1,5 detik setelah ada perubahan.
- Kalau satu catatan diubah di dua perangkat, **perubahan paling baru yang menang**. Versi lama dari HP yang lama offline tidak akan menimpa versi yang lebih baru (dijaga juga oleh trigger di database).
- Data yang dibuat sebelum login ikut tersimpan ke akun saat pertama kali login.
- Saat keluar, data di perangkat itu dihapus (tetap aman di cloud). Kalau masih ada perubahan yang belum terkirim, Kelola meminta konfirmasi dulu.

## Mengaktifkan cloud (sekali saja)

Tanpa langkah ini aplikasi tetap jalan, tapi data hanya tersimpan di perangkat.

1. Buat akun dan proyek gratis di [supabase.com](https://supabase.com) (pilih region **Southeast Asia (Singapore)**).
2. Buka **SQL Editor → New query**, tempel isi [`supabase/schema.sql`](supabase/schema.sql), lalu klik **Run**.
3. Buka **Authentication → URL Configuration**. Isi **Site URL** dengan alamat aplikasi, misalnya `https://liuskusuma.github.io/kelola/`, dan tambahkan alamat yang sama di **Redirect URLs**. Ini dipakai tautan konfirmasi email dan reset kata sandi.
4. Buka **Project Settings → API**. Salin **Project URL** dan kunci **anon public** ke [`js/config.js`](js/config.js).
5. Commit dan push. Kunci anon memang aman berada di kode publik karena setiap pengguna hanya bisa membaca dan mengubah datanya sendiri (Row Level Security).

### Menyiapkan fitur staff (sekali saja)

Buka **SQL Editor → New query**, tempel isi [`supabase/staff.sql`](supabase/staff.sql), lalu klik **Run**. Skrip ini aman dijalankan ulang, dan perlu dijalankan ulang setiap kali file itu berubah (misalnya supaya QRIS, logo, dan warna usaha tampil di HP staff). Sebelum dijalankan, bagian Staff di tab Akun menampilkan pesan "Fitur staff belum disiapkan".

Opsional: kalau ingin pengguna langsung bisa masuk tanpa konfirmasi email, matikan **Authentication → Providers → Email → Confirm email**.

## Hosting

Semua file statis, jadi bisa di GitHub Pages: repo → **Settings → Pages → Deploy from a branch → `main` / root**.

Setiap kali mengubah file aplikasi, naikkan `VERSION` di `sw.js` supaya HP pengguna mengambil versi baru.

## Struktur

| File | Isi |
|---|---|
| `index.html` | Tampilan dan gaya |
| `js/app.js` | Layar Kasir, Produk, Laporan, Akun, serta login |
| `js/hitung.js` | Rumus HPP dari resep, saran harga, dan potongan stok |
| `js/penjualan.js` | Mencatat dan membatalkan penjualan, serta mengolah penjualan dari akun staff |
| `js/grafik.js` | Mengelompokkan penjualan per jam/hari/bulan untuk grafik Laporan |
| `js/warna.js` | Mengambil warna dari logo dan membuat warna tampilan terang/gelap |
| `js/staff.js` | Undangan staff, data kasir di HP staff, dan PIN mode kasir |
| `js/bahasa.js` | Terjemahan Inggris dan pengaturan bahasa/tampilan per perangkat |
| `js/store.js` | Penyimpanan lokal (localStorage) |
| `js/sync.js` | Sinkronisasi dengan cloud |
| `js/config.js` | Alamat dan kunci Supabase |
| `supabase/schema.sql` | Tabel, trigger, dan aturan keamanan di Supabase |
| `supabase/staff.sql` | Tabel dan fungsi untuk akun staff |
| `vendor/` | Pustaka supabase-js 2.45.4 dan huruf Exo 2 (disimpan lokal supaya jalan offline) |
| `icons/logo.svg` | Logo Kelola (K putih dan kuning di atas navy); `logo-asli.jpg` adalah file aslinya |
| `sw.js`, `manifest.webmanifest`, `icons/icon-*.png` | Supaya bisa dipasang di layar utama dan jalan offline |

## Pengujian

```sh
node --test                       # logika sinkronisasi, rumus HPP, dan terjemahan
python3 -m http.server 8765 &     # lalu, dengan Playwright terpasang:
node tests/e2e.js                 # dua perangkat owner, satu HP staff, Supabase tiruan di browser
```
