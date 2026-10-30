// Penyimpanan lokal Kelola.
// Semua data disimpan dulu di perangkat (localStorage), jadi aplikasi tetap
// jalan tanpa internet. Setiap catatan membawa `updated_at` dan tanda `dirty`
// supaya modul sinkronisasi tahu apa yang belum terkirim ke cloud.
(function (root) {
  'use strict';

  const KEY = 'kelola:v1';

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function emptyState() {
    return { records: {}, meta: { owner: null, lastPull: null } };
  }

  // Waktu yang selalu naik, walau jam perangkat sama di dua perubahan beruntun.
  let lastStamp = 0;
  function stamp(now) {
    let t = now();
    if (t <= lastStamp) t = lastStamp + 1;
    lastStamp = t;
    return new Date(t).toISOString();
  }

  function createStore(storage, opts) {
    const now = (opts && opts.now) || Date.now;
    const listeners = new Set();
    let state = load();

    function load() {
      try {
        const raw = storage.getItem(KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.records && parsed.meta) return parsed;
        }
      } catch (e) { /* data rusak: mulai kosong */ }
      return emptyState();
    }

    function save() {
      storage.setItem(KEY, JSON.stringify(state));
      listeners.forEach((fn) => fn());
    }

    function put(kind, data, id) {
      const rec = {
        id: id || uuid(),
        kind,
        data,
        updated_at: stamp(now),
        deleted: false,
        dirty: true,
      };
      state.records[rec.id] = rec;
      save();
      return rec;
    }

    function remove(id) {
      const rec = state.records[id];
      if (!rec) return;
      rec.deleted = true;
      rec.updated_at = stamp(now);
      rec.dirty = true;
      save();
    }

    function get(id) {
      const rec = state.records[id];
      return rec && !rec.deleted ? rec : null;
    }

    // Pernah ada di perangkat ini, termasuk yang sudah dihapus.
    function has(id) {
      return !!state.records[id];
    }

    function list(kind) {
      return Object.values(state.records).filter((r) => r.kind === kind && !r.deleted);
    }

    function dirtyRecords() {
      return Object.values(state.records)
        .filter((r) => r.dirty)
        .map((r) => ({ id: r.id, kind: r.kind, data: r.data, updated_at: r.updated_at, deleted: r.deleted }));
    }

    // Tandai terkirim, kecuali catatan diubah lagi selama pengiriman berlangsung.
    function markClean(sent) {
      let changed = false;
      sent.forEach((s) => {
        const rec = state.records[s.id];
        if (rec && rec.dirty && rec.updated_at === s.updated_at) {
          rec.dirty = false;
          changed = true;
        }
      });
      if (changed) save();
    }

    // Gabungkan data dari cloud. Aturannya: perubahan paling baru yang menang.
    function applyRemote(rows) {
      let changed = false;
      rows.forEach((row) => {
        const local = state.records[row.id];
        const remoteTime = Date.parse(row.updated_at);
        if (local) {
          const localTime = Date.parse(local.updated_at);
          if (localTime > remoteTime) return;
          if (localTime === remoteTime && local.dirty) return;
        }
        state.records[row.id] = {
          id: row.id,
          kind: row.kind,
          data: row.data,
          updated_at: new Date(remoteTime).toISOString(),
          deleted: !!row.deleted,
          dirty: false,
        };
        if (remoteTime > lastStamp) lastStamp = remoteTime;
        changed = true;
      });
      if (changed) save();
    }

    function getMeta() {
      return Object.assign({}, state.meta);
    }

    function setMeta(patch) {
      Object.assign(state.meta, patch);
      save();
    }

    // Data dibuat sebelum login (tanpa pemilik) ikut ke akun pertama yang login.
    // Kalau akun lain login di perangkat ini (Ganti akun), data akun sebelumnya
    // disimpan terpisah (termasuk yang belum terkirim), lalu data akun ini dimuat.
    function claim(userId) {
      if (state.meta.owner === userId) return;
      if (state.meta.owner) {
        storage.setItem(arsipKey(state.meta.owner), JSON.stringify(state));
        let arsip = null;
        try { arsip = JSON.parse(storage.getItem(arsipKey(userId)) || 'null'); } catch (e) { /* rusak */ }
        storage.removeItem(arsipKey(userId));
        state = arsip && arsip.records && arsip.meta ? arsip : emptyState();
      } else {
        // Belum ada pemilik: catatan tanpa akun ikut ke akun ini, digabung dengan data akun ini
        // yang tersimpan di HP (kalau akun ini pernah masuk lalu akun lain keluar).
        let arsip = null;
        try { arsip = JSON.parse(storage.getItem(arsipKey(userId)) || 'null'); } catch (e) { /* rusak */ }
        storage.removeItem(arsipKey(userId));
        const lokal = Object.values(state.records);
        if (arsip && arsip.records && arsip.meta) state = arsip;
        else state.meta.lastPull = null;
        lokal.forEach((r) => { state.records[r.id] = Object.assign(r, { dirty: true }); });
      }
      state.meta.owner = userId;
      save();
    }

    function clear() {
      state = emptyState();
      save();
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    return { put, remove, get, has, list, dirtyRecords, markClean, applyRemote, getMeta, setMeta, claim, clear, subscribe };
  }

  // Tempat data akun lain di perangkat yang sama, saat akun itu tidak sedang aktif.
  function arsipKey(userId) {
    return KEY + ':akun:' + userId;
  }

  // Jumlah perubahan yang belum terkirim di data akun yang tidak aktif.
  function arsipBelumTerkirim(storage, userId) {
    try {
      const s = JSON.parse(storage.getItem(arsipKey(userId)) || 'null');
      return s ? Object.values(s.records).filter((r) => r.dirty).length : 0;
    } catch (e) { return 0; }
  }

  const api = { createStore, uuid, KEY, arsipKey, arsipBelumTerkirim };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
