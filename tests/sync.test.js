// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const KelolaStoreApi = require('../js/store.js');
const { createStore } = KelolaStoreApi;
const { createSync } = require('../js/sync.js');

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// Server palsu yang meniru tabel `records` + trigger di supabase/schema.sql.
function fakeServer() {
  const rows = new Map();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  return {
    rows,
    online: true,
    remote(pageSize) {
      const server = this;
      return {
        pageSize,
        async pull(since) {
          if (!server.online) throw new Error('offline');
          return [...rows.values()]
            .filter((r) => !since || Date.parse(r.server_updated_at) >= Date.parse(since))
            .sort((a, b) => Date.parse(a.server_updated_at) - Date.parse(b.server_updated_at))
            .slice(0, pageSize || Infinity)
            .map((r) => structuredClone(r));
        },
        async push(batch) {
          if (!server.online) throw new Error('offline');
          batch.forEach((r) => {
            const old = rows.get(r.id);
            if (old && Date.parse(r.updated_at) < Date.parse(old.updated_at)) return;
            clock += 10;
            rows.set(r.id, Object.assign(structuredClone(r), { server_updated_at: new Date(clock).toISOString() }));
          });
        },
      };
    },
  };
}

function device(server, clockStart, pageSize) {
  let t = clockStart;
  const store = createStore(memoryStorage(), { now: () => (t += 1000) });
  store.claim('user-1');
  const sync = createSync(store, server.remote(pageSize));
  return { store, sync, advance: (ms) => { t += ms; } };
}

test('data dari satu perangkat muncul di perangkat lain', async () => {
  const server = fakeServer();
  const hp = device(server, Date.parse('2026-01-01T08:00:00Z'));
  const laptop = device(server, Date.parse('2026-01-01T08:00:00Z'));
  const p = hp.store.put('produk', { nama: 'Keripik', modal: 5000, harga: 8000, stok: 10 });
  await hp.sync.run();
  assert.equal(hp.store.dirtyRecords().length, 0);
  await laptop.sync.run();
  assert.equal(laptop.store.get(p.id).data.nama, 'Keripik');
});

test('perubahan terbaru yang menang, termasuk saat perangkat lama baru online', async () => {
  const server = fakeServer();
  const hp = device(server, Date.parse('2026-01-01T08:00:00Z'));
  const laptop = device(server, Date.parse('2026-01-01T08:00:00Z'));
  const p = hp.store.put('produk', { nama: 'Kopi', modal: 3000, harga: 5000 });
  await hp.sync.run();
  await laptop.sync.run();

  // HP offline lalu mengubah harga; laptop mengubah harga belakangan.
  server.online = false;
  hp.store.put('produk', { nama: 'Kopi', modal: 3000, harga: 6000 }, p.id);
  await assert.rejects(hp.sync.run());
  server.online = true;
  laptop.advance(60000);
  laptop.store.put('produk', { nama: 'Kopi', modal: 3000, harga: 7000 }, p.id);
  await laptop.sync.run();

  // HP tersambung lagi: versi laptop lebih baru, jadi tidak tertimpa.
  await hp.sync.run();
  assert.equal(hp.store.get(p.id).data.harga, 7000);
  assert.equal(server.rows.get(p.id).data.harga, 7000);
});

test('hapus ikut tersinkron', async () => {
  const server = fakeServer();
  const a = device(server, Date.parse('2026-01-01T08:00:00Z'));
  const b = device(server, Date.parse('2026-01-01T08:00:00Z'));
  const p = a.store.put('produk', { nama: 'Teh', modal: 1000, harga: 3000 });
  await a.sync.run();
  await b.sync.run();
  b.store.remove(p.id);
  await b.sync.run();
  await a.sync.run();
  assert.equal(a.store.get(p.id), null);
  assert.equal(a.store.list('produk').length, 0);
});

test('menarik banyak data per halaman tanpa ada yang terlewat', async () => {
  const server = fakeServer();
  const a = device(server, Date.parse('2026-01-01T08:00:00Z'), 7);
  const b = device(server, Date.parse('2026-01-01T08:00:00Z'), 7);
  for (let i = 0; i < 30; i++) a.store.put('transaksi', { total: i });
  await a.sync.run();
  await b.sync.run();
  assert.equal(b.store.list('transaksi').length, 30);
});

test('perubahan saat sinkron berjalan tidak ditandai terkirim', async () => {
  const server = fakeServer();
  const a = device(server, Date.parse('2026-01-01T08:00:00Z'));
  const p = a.store.put('produk', { nama: 'Roti', modal: 2000, harga: 4000 });
  const sent = a.store.dirtyRecords();
  a.store.put('produk', { nama: 'Roti', modal: 2000, harga: 4500 }, p.id);
  a.store.markClean(sent);
  assert.equal(a.store.dirtyRecords().length, 1);
});

test('data sebelum login ikut ke akun; akun lain di perangkat yang sama mulai kosong', () => {
  const store = createStore(memoryStorage());
  const p = store.put('produk', { nama: 'Bakso' });
  store.claim('user-1');
  assert.equal(store.get(p.id).data.nama, 'Bakso');
  assert.equal(store.dirtyRecords().length, 1);
  store.claim('user-2');
  assert.equal(store.get(p.id), null);
});

test('ganti akun: data tiap akun disimpan terpisah, termasuk yang belum terkirim', () => {
  const mem = memoryStorage();
  const store = createStore(mem);
  store.claim('user-1');
  const p = store.put('produk', { nama: 'Bakso' });
  store.claim('user-2');
  const q = store.put('produk', { nama: 'Es teh' });
  assert.equal(store.get(p.id), null);
  assert.equal(KelolaStoreApi.arsipBelumTerkirim(mem, 'user-1'), 1);
  store.claim('user-1');
  assert.equal(store.get(p.id).data.nama, 'Bakso');
  assert.equal(store.get(q.id), null);
  assert.equal(store.dirtyRecords().length, 1, 'perubahan yang belum terkirim tetap ada');
  assert.equal(store.getMeta().owner, 'user-1');
  store.claim('user-2');
  assert.equal(store.get(q.id).data.nama, 'Es teh');
});

test('setelah keluar, masuk lagi ke akun lain memuat data akun itu dari HP', () => {
  const mem = memoryStorage();
  const store = createStore(mem);
  store.claim('user-1');
  const p = store.put('produk', { nama: 'Bakso' });
  store.claim('user-2');
  store.clear(); // user-2 keluar
  store.claim('user-1');
  assert.equal(store.get(p.id).data.nama, 'Bakso');
  assert.equal(store.dirtyRecords().length, 1);
});
