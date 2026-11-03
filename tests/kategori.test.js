// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../js/kategori.js');

const p = (id, nama, kategori) => ({ id, data: kategori === undefined ? { nama } : { nama, kategori } });

test('nama kategori dirapikan dan dicocokkan tanpa beda huruf besar/kecil', () => {
  assert.equal(K.rapikan('  Es   kopi '), 'Es kopi');
  assert.equal(K.rapikan('x'.repeat(40)).length, K.MAKS);
  assert.equal(K.cocokkan(['Minuman'], ' minuman '), 'Minuman');
  assert.equal(K.cocokkan(['Minuman'], 'Makanan'), 'Makanan');
  assert.equal(K.cocokkan(['Minuman'], '   '), '');
});

test('daftar mengikuti urutan tersimpan, lalu kategori lain A-Z', () => {
  const produk = [{ kategori: 'Snack' }, { kategori: 'camilan' }, { kategori: 'Minuman' }, {}];
  assert.deepEqual(K.daftar(['Minuman', 'Camilan'], produk), ['Minuman', 'Camilan', 'Snack']);
  assert.deepEqual(K.daftar(null, produk), ['camilan', 'Minuman', 'Snack']);
});

test('produk dikelompokkan per kategori, tanpa kategori di akhir', () => {
  const g = K.kelompok([p('a', 'Kopi', 'minuman'), p('b', 'Roti'), p('c', 'Teh', 'Minuman'), p('d', 'Nasi', 'Makanan')], ['Makanan', 'Minuman', 'Kosong']);
  assert.deepEqual(g.map((x) => [x.nama, x.items.map((i) => i.id)]), [['Makanan', ['d']], ['Minuman', ['a', 'c']], ['', ['b']]]);
  assert.deepEqual(K.kelompok([p('a', 'Kopi')], []).map((x) => x.nama), ['']);
});

test('atur kategori: ganti nama, gabung, hapus, dan urutan baru', () => {
  const lama = ['Minuman', 'Makanan', 'Camilan', 'Lain'];
  const r = K.atur(lama, [
    { lama: 'Makanan', baru: 'Makanan berat' },
    { lama: 'Minuman', baru: 'Minuman' },
    { lama: 'Camilan', baru: 'minuman' }, // digabung ke Minuman
    { lama: '', baru: 'Paket' },
    { lama: '', baru: '' },
  ]); // "Lain" dihapus karena barisnya hilang
  assert.deepEqual(r.urutan, ['Makanan berat', 'Minuman', 'Paket']);
  assert.deepEqual(r.peta, { makanan: 'Makanan berat', camilan: 'Minuman', lain: '' });
  assert.equal(K.kategoriBaru({ kategori: 'MAKANAN' }, r.peta), 'Makanan berat');
  assert.equal(K.kategoriBaru({ kategori: 'Lain' }, r.peta), '');
  assert.equal(K.kategoriBaru({ kategori: 'Minuman' }, r.peta), null);
  assert.equal(K.kategoriBaru({}, r.peta), null);
});

test('mengosongkan nama berarti menghapus kategori', () => {
  const r = K.atur(['Minuman'], [{ lama: 'Minuman', baru: '  ' }]);
  assert.deepEqual(r, { urutan: [], peta: { minuman: '' } });
});
