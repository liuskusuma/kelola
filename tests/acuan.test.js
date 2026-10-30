// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../js/acuan.js');

const hariIni = new Date(2026, 9, 30); // 30 Oktober 2026

test('tanpa harga pasar tidak ada perbandingan', () => {
  assert.equal(A.bandingkan({ harga: 18000 }, hariIni), null);
  assert.equal(A.bandingkan({ harga: 18000, acuan: { harga: 0 } }, hariIni), null);
});

test('peringatan kalau harga pasar beda 10% atau lebih dari harga beli', () => {
  const naik = A.bandingkan({ harga: 16000, acuan: { harga: 18000, tanggal: '2026-10-28' } }, hariIni);
  assert.equal(Math.round(naik.selisih), 13);
  assert.equal(naik.perluCek, true);
  assert.equal(naik.umur, 2);
  assert.equal(naik.lama, false);

  const mirip = A.bandingkan({ harga: 17000, acuan: { harga: 18000, tanggal: '2026-10-30' } }, hariIni);
  assert.equal(mirip.perluCek, false);
  assert.equal(mirip.umur, 0);

  const turun = A.bandingkan({ harga: 20000, acuan: { harga: 17000, tanggal: '2026-09-01' } }, hariIni);
  assert.equal(Math.round(turun.selisih), -15);
  assert.equal(turun.perluCek, true);
  assert.equal(turun.lama, true);

  const tanpaHargaBeli = A.bandingkan({ harga: 0, acuan: { harga: 17000 } }, hariIni);
  assert.equal(tanpaHargaBeli.perluCek, false);
  assert.equal(tanpaHargaBeli.umur, null);
});

test('tanggal acuan hanya berubah kalau harga berubah atau dicek ulang', () => {
  const lama = { harga: 18000, tanggal: '2026-10-01' };
  assert.equal(A.perbarui(lama, 18000, false, hariIni), lama);
  assert.deepEqual(A.perbarui(lama, 18000, true, hariIni), { harga: 18000, tanggal: '2026-10-30' });
  assert.deepEqual(A.perbarui(lama, 19000, false, hariIni), { harga: 19000, tanggal: '2026-10-30' });
  assert.equal(A.perbarui(lama, 0, false, hariIni), null);
  assert.deepEqual(A.perbarui(null, 5000, false, hariIni), { harga: 5000, tanggal: '2026-10-30' });
});
