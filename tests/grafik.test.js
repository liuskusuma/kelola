// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/grafik.js');

const lokal = (y, m, d, h) => new Date(y, m - 1, d, h || 0).getTime();
const iso = (y, m, d, h) => new Date(lokal(y, m, d, h)).toISOString();

test('satuan waktu mengikuti panjang periode', () => {
  assert.equal(G.pilihSatuan(lokal(2026, 10, 30), lokal(2026, 10, 31)), 'jam');
  assert.equal(G.pilihSatuan(lokal(2026, 10, 1), lokal(2026, 10, 31)), 'hari');
  assert.equal(G.pilihSatuan(lokal(2026, 1, 1), lokal(2026, 10, 31)), 'bulan');
});

test('hari ini dikelompokkan per jam, jam kosong tetap tampil', () => {
  const trx = [
    { waktu: iso(2026, 10, 30, 9), total: 10000, laba: 4000 },
    { waktu: iso(2026, 10, 30, 9), total: 5000, laba: 2000 },
    { waktu: iso(2026, 10, 30, 13), total: 8000, laba: 3000 },
  ];
  const { satuan, kelompok } = G.kelompokkan(trx, lokal(2026, 10, 30), Infinity, lokal(2026, 10, 30, 14));
  assert.equal(satuan, 'jam');
  assert.equal(new Date(kelompok[0].mulai).getHours(), 6);
  assert.equal(new Date(kelompok[kelompok.length - 1].mulai).getHours(), 18);
  const jam9 = kelompok.find((k) => new Date(k.mulai).getHours() === 9);
  assert.deepEqual([jam9.omzet, jam9.laba, jam9.n], [15000, 6000, 2]);
  assert.equal(kelompok.reduce((s, k) => s + k.omzet, 0), 23000);
});

test('periode pilihan dikelompokkan per hari sampai tanggal akhir', () => {
  const trx = [{ waktu: iso(2026, 10, 3, 10), total: 7000, laba: 2000 }];
  const { satuan, kelompok } = G.kelompokkan(trx, lokal(2026, 10, 1), lokal(2026, 10, 8), lokal(2026, 10, 30));
  assert.equal(satuan, 'hari');
  assert.equal(kelompok.length, 7);
  assert.equal(kelompok[2].omzet, 7000);
});

test('semua data dikelompokkan per bulan sejak penjualan pertama', () => {
  const trx = [
    { waktu: iso(2026, 1, 15), total: 1000, laba: 500 },
    { waktu: iso(2026, 10, 2), total: 2000, laba: 800 },
  ];
  const { satuan, kelompok } = G.kelompokkan(trx, 0, Infinity, lokal(2026, 10, 30));
  assert.equal(satuan, 'bulan');
  assert.equal(kelompok.length, 10);
  assert.equal(kelompok[0].omzet, 1000);
  assert.equal(kelompok[9].omzet, 2000);
});

test('skala sumbu dan angka ringkas', () => {
  assert.deepEqual(G.skala(23000), { atas: 30000, langkah: 10000 });
  assert.deepEqual(G.skala(18000), { atas: 20000, langkah: 5000 });
  assert.deepEqual(G.skala(0), { atas: 1000, langkah: 500 });
  assert.equal(G.ringkas(1500), '1,5rb');
  assert.equal(G.ringkas(2000000), '2jt');
  assert.equal(G.ringkas(800), '800');
});

test('periode pembanding sampai jam yang sama', () => {
  const kini = lokal(2026, 10, 30, 14);
  assert.deepEqual(G.periodeLalu('hari', lokal(2026, 10, 30), Infinity, kini), [lokal(2026, 10, 29), lokal(2026, 10, 29, 14)]);
  assert.deepEqual(G.periodeLalu('7hari', lokal(2026, 10, 24), Infinity, kini), [lokal(2026, 10, 17), lokal(2026, 10, 23, 14)]);
  assert.deepEqual(G.periodeLalu('bulan', lokal(2026, 10, 1), Infinity, kini), [lokal(2026, 9, 1), lokal(2026, 9, 30, 14)]);
  assert.deepEqual(G.periodeLalu('pilih', lokal(2026, 10, 8), lokal(2026, 10, 15), kini), [lokal(2026, 10, 1), lokal(2026, 10, 8)]);
  assert.equal(G.periodeLalu('semua', 0, Infinity, kini), null);
});

test('perubahan naik, turun, dan tanpa pembanding', () => {
  assert.deepEqual(G.perubahan(120, 100), { arah: 'naik', persen: 20 });
  assert.deepEqual(G.perubahan(75, 100), { arah: 'turun', persen: 25 });
  assert.deepEqual(G.perubahan(100, 100), { arah: 'sama', persen: 0 });
  assert.deepEqual(G.perubahan(50, 0), { arah: 'naik', persen: null });
  assert.equal(G.perubahan(0, 0), null);
});

test('jam paling ramai', () => {
  const trx = [
    { waktu: iso(2026, 10, 30, 9), total: 1000 },
    { waktu: iso(2026, 10, 29, 9), total: 1000 },
    { waktu: iso(2026, 10, 30, 13), total: 9000 },
  ];
  assert.deepEqual(G.jamRamai(trx), { jam: 9, n: 2, omzet: 2000 });
  assert.equal(G.jamRamai([]), null);
});
