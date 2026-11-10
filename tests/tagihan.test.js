// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/tagihan.js');

const sisa = (d) => d.total - (d.bayar || 0);
const tag = (id, jatuhTempo, total, waktu) => ({ id, data: { jatuhTempo, total, waktu: waktu || '2026-11-01T03:00:00.000Z' } });

test('tanggal: tambah hari dan selisih hari, termasuk ganti bulan', () => {
  assert.equal(T.tambahHari('2026-11-28', 7), '2026-12-05');
  assert.equal(T.tambahHari('2026-12-30', 3), '2027-01-02');
  assert.equal(T.selisihHari('2026-11-10', '2026-11-16'), 6);
  assert.equal(T.selisihHari('2026-11-10', '2026-11-05'), -5);
  assert.equal(T.tanggalLokal(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('pengaturan bawaan untuk data lama: 7 hari, ingatkan H-1', () => {
  assert.deepEqual(T.pengaturan({ namaUsaha: 'Kedai' }), { jatuhTempo: 7, ingatkan: true, mulai: 1 });
  assert.deepEqual(T.pengaturan({ tagihan: { jatuhTempo: 0, ingatkan: false, mulai: 3 } }), { jatuhTempo: 0, ingatkan: false, mulai: 3 });
  assert.deepEqual(T.pengaturan({ tagihan: { jatuhTempo: 5, mulai: 9 } }), { jatuhTempo: 7, ingatkan: true, mulai: 1 });
});

test('jatuh tempo penjualan baru', () => {
  const w = new Date(2026, 10, 9, 18, 0).toISOString();
  assert.equal(T.jatuhTempoBaru(w, 7), '2026-11-16');
  assert.equal(T.jatuhTempoBaru(w, 0), null);
});

test('urutan: jatuh tempo terdekat dulu, tagihan lama tanpa jatuh tempo di bawah', () => {
  const list = [
    tag('lama2', undefined, 1, '2026-10-05T00:00:00Z'),
    tag('b', '2026-11-16', 1),
    tag('lama1', undefined, 1, '2026-10-01T00:00:00Z'),
    tag('a', '2026-11-04', 1),
  ];
  assert.deepEqual(T.urutkan(list).map((r) => r.id), ['a', 'b', 'lama1', 'lama2']);
});

test('pengingat: lewat tempo dan yang segera jatuh tempo', () => {
  const list = [
    tag('lewat5', '2026-11-05', 150000),
    tag('lewat1', '2026-11-09', 85000),
    tag('hariIni', '2026-11-10', 10000),
    tag('besok', '2026-11-11', 85000),
    tag('nanti', '2026-11-15', 177000),
    tag('lunas', '2026-11-01', 0),
    tag('lama', undefined, 50000),
  ];
  const h = T.pengingat(list, '2026-11-10', 1, sisa);
  assert.deepEqual(h.lewat.map((r) => r.id), ['lewat5', 'lewat1']);
  assert.deepEqual(h.segera.map((r) => r.id), ['hariIni', 'besok']);
  assert.equal(h.totalLewat, 235000);
  assert.equal(T.pengingat(list, '2026-11-10', 0, sisa).segera.length, 1);
  assert.equal(T.pengingat(list, '2026-11-10', 3, sisa).segera.length, 2);
});

test('nomor rekening polos dan daftar rekening lengkap', () => {
  assert.equal(T.nomorPolos('1234 567-890'), '1234567890');
  assert.deepEqual(T.daftarRekening({ rekening: [{ bank: 'BCA', nomor: '123' }, { bank: 'X', nomor: '' }] }), [{ bank: 'BCA', nomor: '123' }]);
  assert.deepEqual(T.daftarRekening({}), []);
});
