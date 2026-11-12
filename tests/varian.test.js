// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../js/varian.js');
const H = require('../js/hitung.js');
const P = require('../js/penjualan.js');
const { createStore } = require('../js/store.js');

let n = 0;
const id = () => 'x' + (++n);
const varian = () => [
  { id: 'uk', nama: 'Ukuran', banyak: false, pilihan: [{ id: 'reg', nama: 'Reguler', harga: 0 }, { id: 'bsr', nama: 'Besar', harga: 5000 }] },
  { id: 'tb', nama: 'Tambahan', banyak: true, pilihan: [{ id: 'shot', nama: 'Extra shot', harga: 4000 }, { id: 'boba', nama: 'Boba', harga: 3000 }] },
];

test('rapikan membuang yang kosong dan memberi id', () => {
  const r = V.rapikan([
    { nama: '  Ukuran ', pilihan: [{ nama: 'Reguler', harga: '0' }, { nama: ' ', harga: 5 }, { nama: 'Besar', harga: '5000' }] },
    { nama: '', pilihan: [{ nama: 'A' }] },
    { nama: 'Kosong', pilihan: [] },
    { id: 'tb', nama: 'Topping', banyak: 1, pilihan: [{ id: 'k', nama: 'Keju', harga: -3 }, { id: 'k', nama: 'Telur', harga: 2000 }] },
  ], id);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].pilihan.map((p) => [p.nama, p.harga]), [['Reguler', 0], ['Besar', 5000]]);
  assert.equal(r[0].banyak, false);
  assert.equal(r[1].id, 'tb');
  assert.equal(r[1].banyak, true);
  assert.equal(r[1].pilihan[0].harga, 0);
  const semua = r.flatMap((g) => [g.id].concat(g.pilihan.map((p) => p.id)));
  assert.equal(new Set(semua).size, semua.length, 'id tidak boleh kembar');
  assert.deepEqual(V.rapikan(null), []);
  assert.equal(V.ada({ varian: r }), true);
  assert.equal(V.ada({ varian: [] }), false);
  assert.equal(V.ada({}), false);
});

test('pilihan bawaan: yang paling atas untuk "pilih satu", kosong untuk "boleh banyak"', () => {
  const b = V.pilih(varian(), []);
  assert.deepEqual(b.ids, ['reg']);
  assert.equal(b.tambah, 0);
  assert.equal(b.label, 'Reguler');
});

test('harga tambahan dan label mengikuti pilihan', () => {
  const b = V.pilih(varian(), ['boba', 'bsr', 'shot', 'tidak-ada']);
  assert.deepEqual(b.ids, ['bsr', 'shot', 'boba']);
  assert.equal(b.tambah, 12000);
  assert.equal(b.label, 'Besar, Extra shot, Boba');
  // Dua pilihan di kelompok "pilih satu": hanya yang pertama dipakai.
  assert.deepEqual(V.pilih(varian(), ['reg', 'bsr']).ids, ['reg']);
  assert.deepEqual(V.pilih([], ['reg']), { ids: [], tambah: 0, label: '', daftar: [] });
});

test('kunci baris keranjang bisa diurai lagi dan dijumlah per produk', () => {
  assert.equal(V.kunci('p1', [], ''), 'p1');
  const k = V.kunci('p1', ['bsr', 'shot'], '  es | sedikit ');
  assert.deepEqual(V.urai(k), { produkId: 'p1', ids: ['bsr', 'shot'], catatan: 'es sedikit' });
  assert.deepEqual(V.urai(V.kunci('p1', [], 'pedas')), { produkId: 'p1', ids: [], catatan: 'pedas' });
  assert.deepEqual(V.urai('p2'), { produkId: 'p2', ids: [], catatan: '' });
  assert.deepEqual(V.perProduk({ p1: 1, [k]: 2, p2: 3 }), { p1: 3, p2: 3 });
  assert.equal(V.rapikanCatatan('x'.repeat(100)).length, V.MAKS_CATATAN);
});

test('salin memberi id baru', () => {
  const s = V.salin(varian(), id);
  assert.equal(s.length, 2);
  assert.notEqual(s[0].id, 'uk');
  assert.deepEqual(s[1].pilihan.map((p) => p.nama), ['Extra shot', 'Boba']);
});

test('nama barang dengan varian', () => {
  assert.equal(V.namaItem({ nama: 'Es Kopi', varian: 'Besar, Boba' }), 'Es Kopi (Besar, Boba)');
  assert.equal(V.namaItem({ nama: 'Air' }), 'Air');
  assert.equal(V.ringkas(varian()), 'Ukuran, Tambahan');
});

test('penjualan dengan varian: omzet memakai harga pilihan, stok dipotong per produk', () => {
  const store = createStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const p = store.put('produk', { nama: 'Es Kopi', harga: 18000, modal: 7000, stok: 10, varian: varian() });
  const trx = P.catatPenjualan(store, H, {
    waktu: '2026-11-12T10:00:00.000Z',
    items: [
      { produkId: p.id, nama: 'Es Kopi', qty: 2, harga: 27000, varian: 'Besar, Extra shot', catatan: 'es sedikit' },
      { produkId: p.id, nama: 'Es Kopi', qty: 1, harga: 18000, varian: 'Reguler' },
    ],
  });
  assert.equal(trx.data.total, 72000);
  assert.equal(trx.data.laba, 72000 - 3 * 7000);
  assert.equal(trx.data.items[0].varian, 'Besar, Extra shot');
  assert.equal(trx.data.items[0].catatan, 'es sedikit');
  assert.equal('catatan' in trx.data.items[1], false);
  assert.equal(store.get(p.id).data.stok, 7);
  P.batalPenjualan(store, trx.id);
  assert.equal(store.get(p.id).data.stok, 10);
});

test('penjualan staff membawa varian dan catatan', () => {
  const store = createStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const p = store.put('produk', { nama: 'Mie', harga: 15000, modal: 6000 });
  P.olahPenjualanStaff(store, H, [{ id: 's1', staff_id: 'a', created_at: '2026-11-12T10:00:00.000Z', data: {
    waktu: '2026-11-12T10:00:00.000Z', items: [{ produkId: p.id, nama: 'Mie', qty: 1, harga: 15000, varian: 'Pedas', catatan: 'tanpa sayur' }],
  } }], () => 'Budi');
  const i = store.get('s1').data.items[0];
  assert.equal(i.varian, 'Pedas');
  assert.equal(i.catatan, 'tanpa sayur');
  assert.equal(i.modal, 6000);
});
