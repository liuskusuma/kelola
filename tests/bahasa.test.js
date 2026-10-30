// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../js/bahasa.js');
const H = require('../js/hitung.js');

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('teks diterjemahkan dan nilai disisipkan', () => {
  const en = B.buat('en');
  const id = B.buat('id');
  assert.equal(en('Simpan penjualan'), 'Save sale');
  assert.equal(id('Simpan penjualan'), 'Simpan penjualan');
  assert.equal(en('Penjualan {total} tersimpan', { total: 'Rp 5.000' }), 'Sale of Rp 5.000 saved');
  assert.equal(id('{n} terjual', { n: 3 }), '3 terjual');
  assert.equal(en('teks tanpa terjemahan'), 'teks tanpa terjemahan');
});

test('setiap teks di app.js punya terjemahan Inggris', () => {
  const src = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const kunci = [...src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  // Teks yang dikirim ke t() lewat variabel.
  const dinamis = [
    'Kasir', 'Produk', 'Laporan', 'Akun',
    'Catat penjualan', 'Harga jual, resep & stok', 'Omzet, pengeluaran & laba', 'Profil, pengaturan & cloud',
    'Modal naik dari {x}', 'Modal turun dari {x}',
    'Omzet & laba per jam', 'Omzet & laba per hari', 'Omzet & laba per bulan',
    'Sudah dibayar, simpan', 'Simpan sebagai tagihan', 'Tagihan {total} tersimpan',
    'Stok produk jadi (kosongkan kalau dibuat saat dipesan)', 'Stok (kosongkan jika tidak dihitung)',
    'Sewa tempat', 'Listrik & air', 'Gaji', 'Transportasi', 'Iklan & promosi', 'Peralatan', 'Lainnya',
    ...H.pilihanHarga(1000, 30).map((p) => p.label),
  ];
  const hilang = [...new Set(kunci.concat(dinamis))].filter((k) => !(k in B.EN));
  assert.deepEqual(hilang, []);
});

test('pengaturan bawaan: Bahasa Indonesia dan tampilan terang', () => {
  const s = memoryStorage();
  assert.deepEqual(B.bacaPengaturan(s), { bahasa: 'id', tema: 'terang', kunci: null });
  B.simpanPengaturan(s, { bahasa: 'en', tema: 'gelap', kunci: { hash: 'abc', garam: 'x' } });
  assert.deepEqual(B.bacaPengaturan(s), { bahasa: 'en', tema: 'gelap', kunci: { hash: 'abc', garam: 'x' } });
  s.setItem(B.KEY, '{"bahasa":"xx","tema":"ungu"}');
  assert.deepEqual(B.bacaPengaturan(s), { bahasa: 'id', tema: 'terang', kunci: null });
  s.setItem(B.KEY, 'rusak');
  assert.deepEqual(B.bacaPengaturan(s), { bahasa: 'id', tema: 'terang', kunci: null });
});
