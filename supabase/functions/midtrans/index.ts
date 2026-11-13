// Edge Function Supabase: QRIS Midtrans dengan tanda lunas otomatis.
// Pasang lewat dashboard Supabase: Edge Functions -> Deploy a new function -> Via Editor,
// nama `midtrans`, tempel seluruh isi file ini, lalu Deploy.
// Tidak butuh pengaturan rahasia: SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY sudah
// tersedia otomatis. Server Key Midtrans milik tiap owner disimpan di tabel
// `midtrans_kunci` (lihat supabase/midtrans.sql) dan tidak pernah dikirim balik ke HP.
//
// Permintaan (POST, body JSON, selalu dengan sesi pengguna Kelola):
//   { aksi: 'cek' }                       -> { terhubung, aktif, uji }
//   { aksi: 'simpan', serverKey }         -> owner: cek kunci ke Midtrans lalu simpan
//   { aksi: 'aktif', aktif }              -> owner: nyalakan / matikan
//   { aksi: 'hapus' }                     -> owner: putuskan Midtrans
//   { aksi: 'qris', jumlah }              -> owner/staff: buat QRIS -> { order_id, qr, kedaluwarsa }
//   { aksi: 'status', order_id }          -> { status: pending|lunas|kedaluwarsa|gagal|batal, metode }
//   { aksi: 'batal', order_id }           -> batalkan QRIS yang belum dibayar
//   { aksi: 'link', ref, jumlah, nama, hari } -> owner: link bayar tagihan -> { link }
//   { aksi: 'ambil' }                     -> owner: pembayaran tagihan yang baru lunas
//
// Ditulis tanpa tipe TypeScript supaya bisa diuji dengan Node (tests/midtrans.test.js).

const API = { uji: 'https://api.sandbox.midtrans.com', asli: 'https://api.midtrans.com' };
const SNAP = { uji: 'https://app.sandbox.midtrans.com/snap/v1/transactions', asli: 'https://app.midtrans.com/snap/v1/transactions' };
const MAKS_JUMLAH = 1000000000;

// Server Key sandbox diawali "SB-Mid-server-", yang asli "Mid-server-".
// Isi setelah awalan bisa memuat titik dan tanda lain (kunci dari dashboard baru), jadi
// yang ditolak di sini hanya teks yang jelas bukan Server Key; sisanya dicek Midtrans.
export const modeUji = (kunci) => /^SB-/i.test(String(kunci || '').trim());
export const kunciSah = (kunci) => {
  const k = String(kunci || '').trim();
  return /^\S{16,300}$/.test(k) && !/^(SB-)?Mid-client-/i.test(k);
};

// Status transaksi Midtrans -> status Kelola.
export function statusDari(t) {
  if (t === 'settlement' || t === 'capture') return 'lunas';
  if (t === 'expire') return 'kedaluwarsa';
  if (t === 'cancel') return 'batal';
  if (t === 'deny' || t === 'failure' || t === 'refund' || t === 'partial_refund' || t === 'chargeback') return 'gagal';
  return 'pending';
}

// Nomor pesanan unik, maks 50 karakter (aturan Midtrans).
export function buatOrderId(jam, acak) {
  const huruf = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ekor = '';
  for (let i = 0; i < 6; i += 1) ekor += huruf[Math.floor(acak() * huruf.length) % huruf.length];
  return `KL-${jam.toString(36).toUpperCase()}-${ekor}`;
}

// "2026-11-13 12:15:00" (WIB, dari Midtrans) -> ISO.
export function waktuMidtrans(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + '+07:00');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Cara bayar yang dipakai pembeli, misalnya "qris/gopay" atau "bank_transfer".
export function metodeDari(data) {
  const jenis = (data && data.payment_type) || '';
  const penerbit = data && (data.issuer || data.acquirer);
  return jenis === 'qris' && penerbit ? `qris/${penerbit}` : jenis;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

class Gagal extends Error {
  constructor(status, kode, pesan) { super(pesan || kode); this.status = status; this.kode = kode; }
}

export function buatPenangan({ url, kunciServer, fetchFn, sekarang, acak }) {
  const jam = sekarang || (() => Date.now());
  const rnd = acak || Math.random;
  const db = async (path, opsi) => {
    const o = opsi || {};
    const res = await fetchFn(`${url}/rest/v1/${path}`, {
      method: o.method || 'GET',
      headers: Object.assign({ apikey: kunciServer, Authorization: `Bearer ${kunciServer}`, 'Content-Type': 'application/json' }, o.headers || {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    const teks = await res.text();
    return teks ? JSON.parse(teks) : null;
  };

  // Panggil Midtrans dengan Server Key owner.
  async function midtrans(kunci, alamat, opsi) {
    const o = opsi || {};
    const res = await fetchFn(alamat, {
      method: o.method || 'GET',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(kunci + ':') },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    return { http: res.status, data: data || {} };
  }
  const api = (kunci, path) => (modeUji(kunci) ? API.uji : API.asli) + path;

  async function penggunaDari(req) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const res = await fetchFn(`${url}/auth/v1/user`, { headers: { apikey: kunciServer, Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const u = await res.json();
    return u && u.id ? u : null;
  }

  // Staff memakai Midtrans milik owner-nya.
  async function pemilikDari(u) {
    const st = await db(`staff?staff_id=eq.${u.id}&select=owner_id`);
    return st && st.length ? { owner: st[0].owner_id, staff: true } : { owner: u.id, staff: false };
  }

  async function kunciDari(owner) {
    const k = await db(`midtrans_kunci?owner_id=eq.${owner}&select=server_key,aktif`);
    return k && k.length ? k[0] : null;
  }

  const hanyaOwner = (p) => { if (p.staff) throw new Gagal(403, 'owner', 'Hanya owner yang bisa mengatur Midtrans'); };
  const infoKunci = (k) => ({ terhubung: !!k, aktif: !!(k && k.aktif), uji: !!(k && modeUji(k.server_key)) });

  async function barisBayar(owner, orderId) {
    const r = await db(`midtrans_bayar?order_id=eq.${encodeURIComponent(orderId)}&owner_id=eq.${owner}&select=*`);
    if (!r || !r.length) throw new Gagal(404, 'tidak-ada', 'Pembayaran tidak ditemukan');
    return r[0];
  }

  // Tanya status terbaru ke Midtrans dan simpan kalau berubah.
  async function perbarui(row, k) {
    if (!k || row.status !== 'pending') return row;
    const { http, data } = await midtrans(k.server_key, api(k.server_key, `/v2/${encodeURIComponent(row.order_id)}/status`));
    let status = 'pending';
    if (http === 404 || data.status_code === '404') {
      // Link bayar yang belum dipilih cara bayarnya belum tercatat di Midtrans.
      if (row.kedaluwarsa && new Date(row.kedaluwarsa).getTime() < jam()) status = 'kedaluwarsa';
    } else if (http < 300 && data.transaction_status) {
      status = statusDari(data.transaction_status);
      if (status === 'lunas' && Math.round(Number(data.gross_amount)) < row.jumlah) status = 'gagal';
    } else {
      return row;
    }
    if (status === row.status) return row;
    const ubah = { status, metode: metodeDari(data) || row.metode || null };
    if (status === 'lunas') ubah.dibayar = waktuMidtrans(data.settlement_time) || new Date(jam()).toISOString();
    await db(`midtrans_bayar?order_id=eq.${encodeURIComponent(row.order_id)}`, { method: 'PATCH', body: ubah });
    return Object.assign({}, row, ubah);
  }

  const aksi = {
    async cek(p) {
      return infoKunci(await kunciDari(p.owner));
    },

    async simpan(p, body) {
      hanyaOwner(p);
      const kunci = String(body.serverKey || '').trim();
      if (!kunciSah(kunci)) throw new Gagal(400, 'format', 'Server Key tidak sesuai format');
      // Kunci yang benar menjawab "pesanan tidak ditemukan" (404), kunci salah menjawab 401.
      const { http, data } = await midtrans(kunci, api(kunci, `/v2/kelola-cek-${jam()}/status`));
      if (http === 401 || data.status_code === '401') throw new Gagal(400, 'kunci-salah', 'Server Key ditolak Midtrans');
      if (http >= 500) throw new Gagal(502, 'midtrans', 'Midtrans tidak bisa dihubungi');
      await db('midtrans_kunci?on_conflict=owner_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: { owner_id: p.owner, server_key: kunci, aktif: true, updated_at: new Date(jam()).toISOString() },
      });
      return infoKunci({ server_key: kunci, aktif: true });
    },

    async aktif(p, body) {
      hanyaOwner(p);
      const k = await kunciDari(p.owner);
      if (!k) throw new Gagal(409, 'belum', 'Midtrans belum dihubungkan');
      await db(`midtrans_kunci?owner_id=eq.${p.owner}`, { method: 'PATCH', body: { aktif: !!body.aktif, updated_at: new Date(jam()).toISOString() } });
      return infoKunci(Object.assign({}, k, { aktif: !!body.aktif }));
    },

    async hapus(p) {
      hanyaOwner(p);
      await db(`midtrans_kunci?owner_id=eq.${p.owner}`, { method: 'DELETE' });
      return infoKunci(null);
    },

    async qris(p, body, u) {
      const jumlah = Math.round(Number(body.jumlah));
      if (!(jumlah >= 1 && jumlah <= MAKS_JUMLAH)) throw new Gagal(400, 'jumlah', 'Jumlah tidak sah');
      const k = await kunciDari(p.owner);
      if (!k || !k.aktif) throw new Gagal(409, 'mati', 'Midtrans tidak aktif');
      const orderId = buatOrderId(jam(), rnd);
      const { data } = await midtrans(k.server_key, api(k.server_key, '/v2/charge'), {
        method: 'POST',
        body: { payment_type: 'qris', transaction_details: { order_id: orderId, gross_amount: jumlah }, qris: { acquirer: 'gopay' } },
      });
      if (data.status_code !== '201' || !data.qr_string) throw new Gagal(502, 'midtrans', data.status_message || 'QRIS gagal dibuat');
      const kedaluwarsa = waktuMidtrans(data.expiry_time);
      await db('midtrans_bayar', {
        method: 'POST',
        body: { order_id: orderId, owner_id: p.owner, dibuat_oleh: u.id, sumber: 'kasir', jumlah, kedaluwarsa },
      });
      return { order_id: orderId, qr: data.qr_string, kedaluwarsa, uji: modeUji(k.server_key) };
    },

    async status(p, body) {
      const row = await perbarui(await barisBayar(p.owner, body.order_id), await kunciDari(p.owner));
      return { status: row.status, metode: row.metode || null };
    },

    async batal(p, body) {
      let row = await barisBayar(p.owner, body.order_id);
      const k = await kunciDari(p.owner);
      if (row.status === 'pending' && k) {
        await midtrans(k.server_key, api(k.server_key, `/v2/${encodeURIComponent(row.order_id)}/cancel`), { method: 'POST' });
        row = await perbarui(row, k);
        if (row.status === 'pending') {
          await db(`midtrans_bayar?order_id=eq.${encodeURIComponent(row.order_id)}`, { method: 'PATCH', body: { status: 'batal' } });
          row = Object.assign({}, row, { status: 'batal' });
        }
      }
      return { status: row.status, metode: row.metode || null };
    },

    async link(p, body, u) {
      hanyaOwner(p);
      const jumlah = Math.round(Number(body.jumlah));
      const ref = String(body.ref || '').slice(0, 80);
      if (!ref || !(jumlah >= 1 && jumlah <= MAKS_JUMLAH)) throw new Gagal(400, 'jumlah', 'Data tagihan tidak sah');
      const k = await kunciDari(p.owner);
      if (!k || !k.aktif) throw new Gagal(409, 'mati', 'Midtrans tidak aktif');
      const kini = new Date(jam()).toISOString();
      // Tagihan yang sama dengan sisa yang sama memakai link yang sudah ada.
      const ada = await db(`midtrans_bayar?owner_id=eq.${p.owner}&sumber=eq.tagihan&ref=eq.${encodeURIComponent(ref)}&jumlah=eq.${jumlah}&status=eq.pending&kedaluwarsa=gt.${encodeURIComponent(kini)}&select=order_id,link&order=created_at.desc&limit=1`);
      if (ada && ada.length && ada[0].link) return { link: ada[0].link, order_id: ada[0].order_id };
      const hari = Math.min(30, Math.max(1, Math.round(Number(body.hari)) || 7));
      const orderId = buatOrderId(jam(), rnd);
      const nama = String(body.nama || '').trim().slice(0, 50);
      const { data } = await midtrans(k.server_key, modeUji(k.server_key) ? SNAP.uji : SNAP.asli, {
        method: 'POST',
        body: Object.assign(
          { transaction_details: { order_id: orderId, gross_amount: jumlah }, expiry: { unit: 'day', duration: hari } },
          nama ? { customer_details: { first_name: nama } } : {},
        ),
      });
      if (!data.redirect_url) throw new Gagal(502, 'midtrans', (data.error_messages && data.error_messages[0]) || 'Link bayar gagal dibuat');
      await db('midtrans_bayar', {
        method: 'POST',
        body: {
          order_id: orderId, owner_id: p.owner, dibuat_oleh: u.id, sumber: 'tagihan', ref, jumlah, link: data.redirect_url,
          kedaluwarsa: new Date(jam() + hari * 86400000).toISOString(),
        },
      });
      return { link: data.redirect_url, order_id: orderId };
    },

    async ambil(p) {
      hanyaOwner(p);
      const k = await kunciDari(p.owner);
      if (k) {
        const tunggu = await db(`midtrans_bayar?owner_id=eq.${p.owner}&sumber=eq.tagihan&status=eq.pending&select=*&order=created_at.desc&limit=20`);
        for (const row of tunggu || []) {
          try { await perbarui(row, k); } catch (e) { /* coba lagi lain kali */ }
        }
      }
      const lunas = await db(`midtrans_bayar?owner_id=eq.${p.owner}&sumber=eq.tagihan&status=eq.lunas&diproses=eq.false&select=order_id,ref,jumlah,metode,dibayar`);
      if (lunas && lunas.length) {
        const daftar = lunas.map((r) => `"${String(r.order_id).replace(/"/g, '')}"`).join(',');
        await db(`midtrans_bayar?owner_id=eq.${p.owner}&order_id=in.(${encodeURIComponent(daftar)})`, { method: 'PATCH', body: { diproses: true } });
      }
      return { bayar: lunas || [] };
    },
  };

  return async function penangan(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
    try {
      const body = await req.json().catch(() => ({}));
      const kerja = Object.prototype.hasOwnProperty.call(aksi, body.aksi) ? aksi[body.aksi] : null;
      if (!kerja) return json(400, { error: 'aksi tidak dikenal' });
      const u = await penggunaDari(req);
      if (!u) return json(401, { error: 'masuk', pesan: 'Masuk dulu' });
      return json(200, await kerja(await pemilikDari(u), body, u));
    } catch (e) {
      if (e instanceof Gagal) return json(e.status, { error: e.kode, pesan: e.message });
      return json(500, { error: 'server', pesan: String((e && e.message) || e) });
    }
  };
}

if (globalThis.Deno) {
  const env = globalThis.Deno.env;
  globalThis.Deno.serve(buatPenangan({
    url: env.get('SUPABASE_URL'),
    kunciServer: env.get('SUPABASE_SERVICE_ROLE_KEY'),
    fetchFn: fetch,
  }));
}
