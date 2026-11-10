// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../js/warna.js');

// Gambar RGBA w×h; isi(x, y) mengembalikan [r, g, b, a].
function gambar(w, h, isi) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(isi(x, y), (y * w + x) * 4);
  return d;
}
const alfa = (d, w, x, y) => d[(y * w + x) * 4 + 3];
const NAVY = [10, 42, 110, 255];
const PUTIH = [255, 255, 255, 255];

test('logo tanpa pinggiran putih: warna latar = warna tepi, gambar tidak berubah', () => {
  const d = gambar(20, 20, () => NAVY);
  assert.equal(W.bersihkanTepi(d, 20, 20), '#0a2a6e');
  assert.equal(alfa(d, 20, 0, 0), 255);
});

test('garis putih tipis di tepi logo dibuang, latar ikut warna logo', () => {
  const d = gambar(20, 20, (x, y) => (x === 0 || y === 0 || x === 19 || y === 19 ? PUTIH : NAVY));
  assert.equal(W.bersihkanTepi(d, 20, 20), '#0a2a6e');
  assert.equal(alfa(d, 20, 0, 0), 0);
  assert.equal(alfa(d, 20, 0, 10), 0);
  assert.equal(alfa(d, 20, 10, 10), 255);
});

test('sudut transparan (ikon bersudut bulat) diganti warna logo', () => {
  const d = gambar(20, 20, (x, y) => ((x < 2 || x > 17) && (y < 2 || y > 17) ? [0, 0, 0, 0] : NAVY));
  assert.equal(W.bersihkanTepi(d, 20, 20), '#0a2a6e');
});

test('logo yang memang berlatar putih tidak diubah, latar tetap putih', () => {
  const d = gambar(20, 20, (x, y) => (x > 7 && x < 12 && y > 7 && y < 12 ? NAVY : PUTIH));
  assert.equal(W.bersihkanTepi(d, 20, 20), null);
  assert.equal(alfa(d, 20, 0, 0), 255);
});
