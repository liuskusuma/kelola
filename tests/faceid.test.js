// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../js/faceid.js');

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('id kunci bolak-balik base64url', () => {
  const b = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255, 62, 63]);
  const s = F.keB64(b);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual([...F.dariB64(s)], [...b]);
});

test('kunci Face ID disimpan per akun dan bisa dihapus', () => {
  const s = memoryStorage();
  assert.equal(F.untuk(s, 'a'), null);
  F.catat(s, 'a', { id: 'xyz', email: 'a@contoh.id' });
  F.catat(s, 'b', { id: 'qrs', email: 'b@contoh.id' });
  assert.equal(F.untuk(s, 'a').id, 'xyz');
  assert.equal(F.untuk(s, null), null);
  F.hapus(s, 'a');
  assert.equal(F.untuk(s, 'a'), null);
  assert.equal(F.untuk(s, 'b').id, 'qrs');
  F.hapus(s, 'b');
  assert.equal(s.getItem(F.KEY), null);
  s.setItem(F.KEY, 'rusak');
  assert.equal(F.untuk(s, 'a'), null);
});

test('masuk hanya diterima kalau wajah/sidik jari benar-benar dicek', () => {
  const data = (flags) => { const b = new Uint8Array(37); b[32] = flags; return b.buffer; };
  assert.equal(F.terverifikasi(data(0x05)), true);
  assert.equal(F.terverifikasi(data(0x45)), true);
  assert.equal(F.terverifikasi(data(0x01)), false, 'hanya disentuh, tanpa verifikasi');
  assert.equal(F.terverifikasi(data(0x04)), false);
  assert.equal(F.terverifikasi(new ArrayBuffer(10)), false);
});
