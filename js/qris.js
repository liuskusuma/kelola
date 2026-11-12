// QRIS dengan nominal: menyisipkan jumlah bayar ke kode QRIS toko.
// Tanpa DOM, jadi bisa diuji dengan `node --test`.
//
// Isi QR QRIS adalah teks berformat EMV: deretan "tag (2 angka) + panjang (2 angka) + nilai".
// - tag 01: cara pakai, "11" = statis (bisa dipakai berulang, nominal diketik pembeli),
//           "12" = dinamis (nominal sudah ada di dalam kode).
// - tag 54: nominal. tag 59: nama merchant. tag 63: CRC, selalu paling akhir.
// Kode hasil di sini tetap membayar ke QRIS toko yang sama; hanya nominalnya yang terisi.
// Ini bukan QRIS dinamis resmi dari bank: tidak ada masa berlaku dan tidak ada tanda lunas otomatis.
(function (root) {
  'use strict';

  // CRC-16/CCITT-FALSE, dipakai tag 63.
  function crc16(teks) {
    let crc = 0xffff;
    for (let i = 0; i < teks.length; i++) {
      crc ^= teks.charCodeAt(i) << 8;
      for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  // Teks QR -> [{ tag, nilai }], atau null kalau bentuknya bukan EMV.
  function urai(kode) {
    const s = String(kode || '').trim();
    const out = [];
    let i = 0;
    while (i < s.length) {
      const tag = s.slice(i, i + 2);
      const panjang = Number(s.slice(i + 2, i + 4));
      if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(s.slice(i + 2, i + 4))) return null;
      const nilai = s.slice(i + 4, i + 4 + panjang);
      if (nilai.length !== panjang) return null;
      out.push({ tag, nilai });
      i += 4 + panjang;
    }
    return out.length ? out : null;
  }

  const susun = (bagian) => bagian.map((b) => b.tag + String(b.nilai.length).padStart(2, '0') + b.nilai).join('');

  // Kode QRIS yang utuh: format EMV, diawali tag 00, CRC di akhir cocok.
  function sah(kode) {
    const s = String(kode || '').trim();
    const b = urai(s);
    if (!b || b[0].tag !== '00' || b[b.length - 1].tag !== '63' || b[b.length - 1].nilai.length !== 4) return false;
    return crc16(s.slice(0, -4)) === s.slice(-4).toUpperCase();
  }

  function ambil(kode, tag) {
    const b = urai(kode);
    const x = b && b.find((y) => y.tag === tag);
    return x ? x.nilai : '';
  }

  const namaMerchant = (kode) => ambil(kode, '59');

  // Kode QRIS toko + nominal (rupiah bulat) -> kode baru dengan nominal terisi.
  // Hasil '' kalau kodenya tidak sah atau nominalnya tidak masuk akal.
  function denganNominal(kode, nominal) {
    const n = Math.round(Number(nominal) || 0);
    if (!sah(kode) || n <= 0 || n > 9999999999) return '';
    const isi = urai(String(kode).trim()).filter((b) => b.tag !== '54' && b.tag !== '63');
    const cara = isi.find((b) => b.tag === '01');
    if (cara) cara.nilai = '12';
    else isi.splice(1, 0, { tag: '01', nilai: '12' });
    // Tag harus berurutan: nominal (54) setelah mata uang (53), sebelum kode negara (58).
    let di = isi.findIndex((b) => Number(b.tag) > 54);
    if (di < 0) di = isi.length;
    isi.splice(di, 0, { tag: '54', nilai: String(n) });
    const badan = susun(isi) + '6304';
    return badan + crc16(badan);
  }

  const api = { crc16, urai, sah, ambil, namaMerchant, denganNominal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaQris = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
