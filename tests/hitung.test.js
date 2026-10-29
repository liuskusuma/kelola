// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../js/hitung.js');

const data = {
  gula: { nama: 'Gula', satuan: 'gram', isi: 1000, harga: 18000, stok: 5000 },
  kopi: { nama: 'Kopi bubuk', satuan: 'gram', isi: 250, harga: 25000, stok: null },
  susu: { nama: 'Susu', satuan: 'ml', isi: 1000, harga: 20000, stok: 2000 },
  esKopi: { nama: 'Es kopi susu', mode: 'resep', stok: null, harga: 15000,
    resep: { hasil: 1, biayaLain: 1500, items: [{ bahanId: 'kopi', jumlah: 15 }, { bahanId: 'susu', jumlah: 100 }, { bahanId: 'gula', jumlah: 20 }] } },
  kue: { nama: 'Kue', mode: 'resep', stok: 10, harga: 5000,
    resep: { hasil: 20, biayaLain: 0, items: [{ bahanId: 'gula', jumlah: 500 }] } },
  roti: { nama: 'Roti', modal: 3000, stok: 4, harga: 6000 },
  paket: { nama: 'Paket hemat', mode: 'paket', stok: null, harga: 20000,
    paket: [{ produkId: 'esKopi', qty: 1 }, { produkId: 'roti', qty: 2 }] },
};
const cari = (id) => data[id] || null;

test('harga per satuan bahan', () => {
  assert.equal(H.hargaSatuan(data.gula), 18);
  assert.equal(H.hargaSatuan({ isi: 0, harga: 100 }), 0);
});

test('HPP dari resep: bahan + biaya lain dibagi hasil', () => {
  // kopi 15 × 100 + susu 100 × 20 + gula 20 × 18 + 1500 = 5360
  assert.equal(H.modalProduk(data.esKopi, cari), 5360);
  // gula 500 × 18 / 20 porsi = 450
  assert.equal(H.modalProduk(data.kue, cari), 450);
});

test('HPP paket = jumlah modal isinya', () => {
  assert.equal(H.modalProduk(data.paket, cari), 5360 + 2 * 3000);
});

test('produk manual memakai modal yang diisi', () => {
  assert.equal(H.modalProduk(data.roti, cari), 3000);
  assert.equal(H.modalProduk({ modal: 7000 }, cari), 7000);
});

test('paket yang berisi dirinya sendiri tidak membuat aplikasi macet', () => {
  const lingkar = { a: { mode: 'paket', paket: [{ produkId: 'a', qty: 1 }] } };
  assert.equal(H.modalProduk(lingkar.a, (id) => lingkar[id]), 0);
  assert.deepEqual(H.potongan('a', 1, (id) => lingkar[id]), { produk: {}, bahan: {} });
});

test('tiga pilihan harga jual', () => {
  const p = H.pilihanHarga(6000, 40);
  assert.deepEqual(p.map((x) => x.kode), ['hemat', 'standar', 'premium']);
  assert.deepEqual(p.map((x) => x.target), [30, 40, 55]);
  assert.deepEqual(p.map((x) => x.harga), [9000, 10000, 13500]);
});

test('potongan stok: bahan untuk produk tanpa stok, produk untuk yang berstok, paket ke isinya', () => {
  const out = H.potonganKeranjang({ esKopi: 2, kue: 3, paket: 1 }, cari);
  // esKopi: 3 gelas (2 + 1 dari paket); kopi tidak dihitung stoknya
  assert.deepEqual(out.bahan, { susu: 300, gula: 60 });
  assert.deepEqual(out.produk, { kue: 3, roti: 2 });
});

test('stok cukup atau tidak', () => {
  assert.equal(H.stokCukup({ roti: 4 }, cari), true);
  assert.equal(H.stokCukup({ roti: 3, paket: 1 }, cari), false);
  assert.equal(H.stokCukup({ esKopi: 100 }, cari), true);
});

test('bahan terpakai saat produksi', () => {
  assert.deepEqual(H.bahanProduksi(data.kue, 2), { gula: 1000 });
  assert.deepEqual(H.bahanProduksi(data.roti, 2), {});
});
