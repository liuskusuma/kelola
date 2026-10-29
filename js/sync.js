// Sinkronisasi antara penyimpanan lokal dan cloud.
// `remote` adalah adaptor dengan dua fungsi:
//   pull(since) -> Promise<baris[]> yang berubah di server setelah `since`
//                  (setiap baris punya server_updated_at)
//   push(baris[]) -> Promise<void>
// Dengan begitu logika ini bisa diuji tanpa Supabase.
(function (root) {
  'use strict';

  // Ambil ulang sedikit ke belakang supaya perubahan yang commit agak telat
  // di server tidak terlewat. Menerapkan baris yang sama dua kali aman.
  const PULL_OVERLAP_MS = 5000;
  const PUSH_BATCH = 200;

  function createSync(store, remote, onStatus) {
    let running = null;
    let again = false;

    function report(status, detail) {
      if (onStatus) onStatus(status, detail);
    }

    async function pullAll() {
      const meta = store.getMeta();
      let since = meta.lastPull
        ? new Date(Date.parse(meta.lastPull) - PULL_OVERLAP_MS).toISOString()
        : null;
      let newest = meta.lastPull;
      for (;;) {
        const rows = await remote.pull(since);
        if (!rows.length) break;
        store.applyRemote(rows);
        rows.forEach((r) => {
          if (!newest || Date.parse(r.server_updated_at) > Date.parse(newest)) newest = r.server_updated_at;
        });
        const last = rows[rows.length - 1].server_updated_at;
        if (!remote.pageSize || rows.length < remote.pageSize || last === since) break;
        since = last;
      }
      if (newest !== meta.lastPull) store.setMeta({ lastPull: newest });
    }

    async function pushAll() {
      const dirty = store.dirtyRecords();
      for (let i = 0; i < dirty.length; i += PUSH_BATCH) {
        const batch = dirty.slice(i, i + PUSH_BATCH);
        await remote.push(batch);
        store.markClean(batch);
      }
    }

    async function once() {
      report('syncing');
      try {
        await pullAll();
        await pushAll();
        report('synced', new Date());
      } catch (err) {
        report('error', err);
        throw err;
      }
    }

    // Satu sinkronisasi pada satu waktu; permintaan yang datang di tengah jalan
    // dijalankan sekali lagi setelah yang sekarang selesai.
    function run() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await once();
          } while (again);
        } finally {
          running = null;
        }
      })();
      return running;
    }

    return { run };
  }

  // Adaptor Supabase untuk tabel `records` (lihat supabase/schema.sql).
  function supabaseRemote(client, userId, pageSize) {
    pageSize = pageSize || 500;
    return {
      pageSize,
      async pull(since) {
        let q = client
          .from('records')
          .select('id, kind, data, updated_at, deleted, server_updated_at')
          .order('server_updated_at', { ascending: true })
          .limit(pageSize);
        if (since) q = q.gte('server_updated_at', since);
        const { data, error } = await q;
        if (error) throw error;
        return data;
      },
      async push(rows) {
        const payload = rows.map((r) => ({
          user_id: userId,
          id: r.id,
          kind: r.kind,
          data: r.data,
          updated_at: r.updated_at,
          deleted: r.deleted,
        }));
        const { error } = await client.from('records').upsert(payload, { onConflict: 'user_id,id' });
        if (error) throw error;
      },
    };
  }

  const api = { createSync, supabaseRemote };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
