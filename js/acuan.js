// Harga acuan pasar untuk bahan baku (tanpa DOM, bisa diuji dengan `node --test`).
//
// Situs harga resmi (Panel Harga Bapanas, PIHPS Bank Indonesia, SP2KP Kemendag) tidak bisa
// dibaca otomatis dari aplikasi, jadi pemilik usaha mencatat sendiri harga pasar yang dilihatnya.
// Bahan menyimpan `acuan = { harga, tanggal }`:
// - harga: harga pasar untuk kemasan yang sama dengan bahan (isi dan satuan yang sama)
// - tanggal: kapan harga pasar itu dicek (YYYY-MM-DD)
(function (root) {
  'use strict';

  const BATAS = 10; // persen selisih harga beli dengan harga pasar
  const LAMA = 30; // hari sebelum harga pasar dianggap perlu dicek lagi

  // Jumlah hari dari `tanggal` (YYYY-MM-DD) sampai `hariIni` (Date).
  function umurHari(tanggal, hariIni) {
    const t = Date.parse(tanggal + 'T00:00:00');
    if (!Number.isFinite(t)) return null;
    const h = new Date(hariIni.getFullYear(), hariIni.getMonth(), hariIni.getDate()).getTime();
    return Math.max(0, Math.round((h - t) / 86400000));
  }

  // Perbandingan harga beli bahan dengan harga pasar yang dicatat.
  // Hasil: null kalau belum ada harga pasar, atau
  // { pasar, anda, selisih, umur, perluCek, lama }
  // - selisih: harga pasar dibanding harga beli Anda (%); positif berarti pasar lebih mahal
  // - perluCek: selisih ≥ BATAS, harga beli (dan HPP) mungkin sudah tidak sesuai
  // - lama: harga pasar terakhir dicek lebih dari LAMA hari lalu
  function bandingkan(bahan, hariIni) {
    const a = bahan && bahan.acuan;
    if (!a || !(a.harga > 0)) return null;
    const anda = bahan.harga || 0;
    const selisih = anda > 0 ? ((a.harga - anda) / anda) * 100 : 0;
    const umur = a.tanggal ? umurHari(a.tanggal, hariIni || new Date()) : null;
    return {
      pasar: a.harga,
      anda,
      selisih,
      umur,
      perluCek: anda > 0 && Math.abs(selisih) >= BATAS,
      lama: umur != null && umur > LAMA,
    };
  }

  // Tanggal hari ini sebagai YYYY-MM-DD (waktu setempat).
  function tanggalIni(d) {
    d = d || new Date();
    const dua = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())}`;
  }

  // Acuan baru setelah harga pasar diisi. Tanggal hanya berubah kalau harganya berubah,
  // atau kalau `dicek` (pengguna menyatakan baru saja mengecek).
  function perbarui(lama, harga, dicek, hariIni) {
    if (!(harga > 0)) return null;
    if (lama && lama.harga === harga && !dicek) return lama;
    return { harga, tanggal: tanggalIni(hariIni) };
  }

  const api = { BATAS, LAMA, bandingkan, perbarui, tanggalIni, umurHari };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaAcuan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
