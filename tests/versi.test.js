// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('versi berformat 1.<nomor PR> dan ikut di-cache', () => {
  const sumber = fs.readFileSync(path.join(__dirname, '../js/versi.js'), 'utf8');
  const m = sumber.match(/KELOLA_VERSI\s*=\s*'([^']+)'/);
  assert.ok(m, 'KELOLA_VERSI ada');
  assert.match(m[1], /^1\.\d{3}$/);
  assert.ok(fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8').includes('js/versi.js'), 'js/versi.js ada di daftar FILES sw.js');
});
