// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../js/store.js');
const H = require('../js/hitung.js');
const P = require('../js/penjualan.js');

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function siapkan() {
  const store = createStore(memoryStorage());
  const kue = store.put('produk', { nama: 'Kue', modal: 2000, harga: 5000, stok: 10 });
  return { store, kue };
}

test('penjualan tunai dan QRIS langsung lunas', () => {
  const { store, kue } = siapkan();
  const a = P.catatPenjualan(store, H, { waktu: '2026-10-30T01:00:00Z', items: [{ produkId: kue.id, nama: 'Kue', qty: 2, harga: 5000 }], bayar: 20000 });
  assert.equal(a.data.metode, 'tunai');
  assert.equal(a.data.bayar, 20000);
  assert.equal(P.sisaTagihan(a.data), 0);
  const b = P.catatPenjualan(store, H, { waktu: '2026-10-30T01:00:00Z', items: [{ produkId: kue.id, nama: 'Kue', qty: 1, harga: 5000 }], metode: 'qris' });
  assert.equal(b.data.metode, 'qris');
  assert.equal(b.data.bayar, 5000);
});

test('bayar nanti jadi tagihan, bisa dicicil sampai lunas', () => {
  const { store, kue } = siapkan();
  const trx = P.catatPenjualan(store, H, {
    waktu: '2026-10-30T01:00:00Z', items: [{ produkId: kue.id, nama: 'Kue', qty: 3, harga: 5000 }],
    metode: 'nanti', pelanggan: { nama: ' Bu Ani ', wa: '0812-3456-7890' },
  });
  assert.deepEqual(trx.data.pelanggan, { nama: 'Bu Ani', wa: '0812-3456-7890' });
  assert.equal(trx.data.lunas, false);
  assert.equal(trx.data.bayar, 0);
  assert.equal(P.sisaTagihan(trx.data), 15000);
  assert.equal(store.get(kue.id).data.stok, 7, 'stok tetap dipotong');

  P.catatBayar(store, trx.id, { waktu: '2026-10-31T01:00:00Z', jumlah: 5000, metode: 'tunai' });
  assert.equal(P.sisaTagihan(store.get(trx.id).data), 10000);
  assert.equal(store.get(trx.id).data.lunas, false);
  P.catatBayar(store, trx.id, { waktu: '2026-11-01T01:00:00Z', jumlah: 10000, metode: 'qris' });
  const d = store.get(trx.id).data;
  assert.equal(P.sisaTagihan(d), 0);
  assert.equal(d.lunas, true);
  assert.deepEqual(d.dibayar.map((b) => b.metode), ['tunai', 'qris']);
  assert.equal(P.catatBayar(store, trx.id, { jumlah: 0 }), null);
});

test('penjualan bayar nanti dari staff ikut membawa nama pelanggan', () => {
  const { store, kue } = siapkan();
  P.olahPenjualanStaff(store, H, [{ id: 'j1', created_at: '2026-10-30T01:00:00Z', staff_id: 's', data: {
    waktu: '2026-10-30T01:00:00Z', items: [{ produkId: kue.id, nama: 'Kue', qty: 1, harga: 5000 }], metode: 'nanti', pelanggan: { nama: 'Pak Budi', wa: '' },
  } }], () => 'Budi');
  const d = store.get('j1').data;
  assert.equal(d.metode, 'nanti');
  assert.equal(d.pelanggan.nama, 'Pak Budi');
  assert.equal(P.sisaTagihan(d), 5000);
});

test('nomor WhatsApp dirapikan untuk wa.me', () => {
  assert.equal(P.nomorWa('0812-3456-7890'), '6281234567890');
  assert.equal(P.nomorWa('+62 812 3456 7890'), '6281234567890');
  assert.equal(P.nomorWa('81234567890'), '6281234567890');
  assert.equal(P.nomorWa('12'), '');
  assert.equal(P.nomorWa(''), '');
});
