// Edge Function Supabase: pengingat tagihan jatuh tempo lewat notifikasi HP (Web Push).
// Pasang lewat dashboard Supabase: Edge Functions -> Deploy a new function -> Via Editor,
// nama `pengingat-tagihan`, tempel seluruh isi file ini, lalu Deploy.
// Tidak butuh pengaturan rahasia: SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY sudah
// tersedia otomatis, dan kunci VAPID dibuat sendiri saat pertama dipakai.
//
// Permintaan (POST, body JSON):
//   { aksi: 'kunci' } -> { publik } kunci publik VAPID untuk aplikasi
//   { aksi: 'uji' }   -> kirim notifikasi uji ke HP milik pengguna yang memanggil
//   { aksi: 'kirim' } -> pengingat harian untuk semua pengguna (dipanggil jadwal pg_cron)
//
// Ditulis tanpa tipe TypeScript supaya bisa diuji dengan Node (tests/notifikasi.test.js).

const ZONA = 'Asia/Jakarta';
const SUBJEK = 'https://liuskusuma.github.io/kelola/';
const enc = new TextEncoder();

// ---------- base64url ----------

export function keB64(bytes) {
  let s = '';
  new Uint8Array(bytes).forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function dariB64(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const gabung = (...bagian) => {
  const out = new Uint8Array(bagian.reduce((n, b) => n + b.length, 0));
  let i = 0;
  bagian.forEach((b) => { out.set(b, i); i += b.length; });
  return out;
};

// ---------- Kunci VAPID dan tanda tangan ----------

export async function buatKunciVapid() {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publik = keB64(await crypto.subtle.exportKey('raw', k.publicKey));
  const privat = await crypto.subtle.exportKey('jwk', k.privateKey);
  return { publik, privat };
}

export async function jwtVapid(endpoint, kunci, sekarang) {
  const aud = new URL(endpoint).origin;
  const kepala = keB64(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const isi = keB64(enc.encode(JSON.stringify({ aud, exp: Math.floor(sekarang / 1000) + 12 * 3600, sub: SUBJEK })));
  const privat = await crypto.subtle.importKey('jwk', kunci.privat, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const ttd = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privat, enc.encode(`${kepala}.${isi}`));
  return `${kepala}.${isi}.${keB64(ttd)}`;
}

// ---------- Enkripsi isi notifikasi (RFC 8291, aes128gcm) ----------

async function hkdf(salt, ikm, info, panjang) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, panjang * 8));
}

export async function enkripsi(isi, p256dh, authSecret) {
  const uaPublik = dariB64(p256dh);
  const auth = dariB64(authSecret);
  const sementara = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublik = new Uint8Array(await crypto.subtle.exportKey('raw', sementara.publicKey));
  const uaKunci = await crypto.subtle.importKey('raw', uaPublik, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const rahasia = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKunci }, sementara.privateKey, 256));
  const ikm = await hkdf(auth, rahasia, gabung(enc.encode('WebPush: info\0'), uaPublik, asPublik), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const kunciAes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sandi = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, kunciAes, gabung(enc.encode(isi), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // ukuran rekaman 4096
  return gabung(salt, rs, new Uint8Array([asPublik.length]), asPublik, sandi);
}

export async function kirimPush(fetchFn, lg, isi, kunci, sekarang) {
  const body = await enkripsi(JSON.stringify(isi), lg.p256dh, lg.auth);
  const jwt = await jwtVapid(lg.endpoint, kunci, sekarang);
  const res = await fetchFn(lg.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${kunci.publik}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });
  return res.status;
}

// ---------- Tagihan yang perlu diingatkan (sama dengan js/tagihan.js) ----------

export function tanggalDiZona(sekarang, zona) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona || ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sekarang));
}

const utc = (ymd) => Date.parse(ymd + 'T00:00:00Z');
const tanggalSah = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s));

export function sisaTagihan(d) {
  if (!d || d.metode !== 'nanti') return 0;
  const masuk = (d.dibayar || []).reduce((s, b) => s + (b.jumlah || 0), 0);
  return Math.max(0, (d.total || 0) - masuk);
}

export function pengaturan(profil) {
  const p = (profil && profil.tagihan) || {};
  return { ingatkan: p.ingatkan !== false, mulai: [0, 1, 3].includes(p.mulai) ? p.mulai : 1 };
}

export function ringkas(transaksi, hariIni, mulai) {
  const lewat = [];
  const segera = [];
  transaksi.forEach((d) => {
    const sisa = sisaTagihan(d);
    if (!tanggalSah(d.jatuhTempo) || !(sisa > 0)) return;
    const n = Math.round((utc(d.jatuhTempo) - utc(hariIni)) / 864e5);
    if (n < 0) lewat.push(d);
    else if (n <= mulai) segera.push(d);
  });
  const urut = (a) => a.sort((x, y) => (x.jatuhTempo < y.jatuhTempo ? -1 : x.jatuhTempo > y.jatuhTempo ? 1 : 0));
  const total = (a) => a.reduce((s, d) => s + sisaTagihan(d), 0);
  return { lewat: urut(lewat), segera: urut(segera), totalLewat: total(lewat), totalSegera: total(segera) };
}

const rupiah = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID').replace(/,/g, '.');

// Isi notifikasi, dalam bahasa yang dipakai di HP itu.
export function pesanNotifikasi(r, bahasa) {
  const en = bahasa === 'en';
  const lewat = r.lewat.length > 0;
  const daftar = lewat ? r.lewat : r.segera;
  const nama = daftar.slice(0, 3).map((d) => (d.pelanggan && d.pelanggan.nama) || '?').join(', ') + (daftar.length > 3 ? ', …' : '');
  const judul = lewat
    ? (en ? `Overdue bills: ${r.lewat.length}` : `${r.lewat.length} tagihan lewat jatuh tempo`)
    : (en ? `Bills due soon: ${r.segera.length}` : `${r.segera.length} tagihan segera jatuh tempo`);
  let isi = `${nama} · ${rupiah(lewat ? r.totalLewat : r.totalSegera)}`;
  if (lewat && r.segera.length) isi += en ? ` · +${r.segera.length} due soon` : ` · +${r.segera.length} segera jatuh tempo`;
  return { judul, isi, tag: 'kelola-tagihan', url: './?buka=tagihan' };
}

// ---------- Penangan permintaan ----------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function buatPenangan({ url, kunciServer, fetchFn, sekarang }) {
  const jam = sekarang || (() => Date.now());
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

  async function ambilKunci() {
    const ada = await db('push_kunci?id=eq.1&select=publik,privat');
    if (ada && ada.length) return ada[0];
    const baru = await buatKunciVapid();
    await db('push_kunci?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: { id: 1, publik: baru.publik, privat: baru.privat } });
    const lagi = await db('push_kunci?id=eq.1&select=publik,privat');
    return lagi[0];
  }

  // Kirim ke satu HP. Alamat yang sudah tidak berlaku (HP mencabut izin) dihapus.
  async function kirimKe(lg, isi, kunci) {
    let status;
    try { status = await kirimPush(fetchFn, lg, isi, kunci, jam()); } catch (e) { return false; }
    if (status === 404 || status === 410) {
      await db(`push_langganan?endpoint=eq.${encodeURIComponent(lg.endpoint)}`, { method: 'DELETE' });
      return false;
    }
    return status >= 200 && status < 300;
  }

  async function penggunaDari(req) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const res = await fetchFn(`${url}/auth/v1/user`, { headers: { apikey: kunciServer, Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const u = await res.json();
    return u && u.id ? u : null;
  }

  async function uji(req) {
    const u = await penggunaDari(req);
    if (!u) return { status: 401, data: { error: 'Masuk dulu' } };
    const kunci = await ambilKunci();
    const daftar = await db(`push_langganan?user_id=eq.${u.id}&select=endpoint,p256dh,auth,bahasa`);
    let terkirim = 0;
    for (const lg of daftar) {
      const en = lg.bahasa === 'en';
      if (await kirimKe(lg, { judul: 'Kelola', isi: en ? 'Bill reminders are on for this phone 👍' : 'Pengingat tagihan sudah aktif di HP ini 👍', tag: 'kelola-uji', url: './' }, kunci)) terkirim += 1;
    }
    return { status: 200, data: { terkirim } };
  }

  async function kirimSemua() {
    const hariIni = tanggalDiZona(jam(), ZONA);
    const daftar = await db(`push_langganan?select=endpoint,user_id,p256dh,auth,bahasa&or=(terakhir_kirim.is.null,terakhir_kirim.lt.${hariIni})`);
    const perPengguna = new Map();
    daftar.forEach((lg) => { perPengguna.set(lg.user_id, (perPengguna.get(lg.user_id) || []).concat([lg])); });
    const kunci = perPengguna.size ? await ambilKunci() : null;
    let terkirim = 0;
    for (const [uid, hp] of perPengguna) {
      const prof = await db(`records?user_id=eq.${uid}&id=eq.profil&deleted=eq.false&select=data`);
      const set = pengaturan(prof && prof[0] && prof[0].data);
      if (!set.ingatkan) continue;
      const trx = await db(`records?user_id=eq.${uid}&kind=eq.transaksi&deleted=eq.false&data->>metode=eq.nanti&data->>lunas=eq.false&select=data`);
      const r = ringkas(trx.map((x) => x.data), hariIni, set.mulai);
      if (!r.lewat.length && !r.segera.length) continue;
      for (const lg of hp) {
        if (await kirimKe(lg, pesanNotifikasi(r, lg.bahasa), kunci)) {
          terkirim += 1;
          await db(`push_langganan?endpoint=eq.${encodeURIComponent(lg.endpoint)}`, { method: 'PATCH', body: { terakhir_kirim: hariIni } });
        }
      }
    }
    return { status: 200, data: { tanggal: hariIni, pengguna: perPengguna.size, terkirim } };
  }

  return async function penangan(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
    try {
      const body = await req.json().catch(() => ({}));
      if (body.aksi === 'kunci') return json(200, { publik: (await ambilKunci()).publik });
      if (body.aksi === 'uji') { const r = await uji(req); return json(r.status, r.data); }
      if (body.aksi === 'kirim') { const r = await kirimSemua(); return json(r.status, r.data); }
      return json(400, { error: 'aksi tidak dikenal' });
    } catch (e) {
      return json(500, { error: String((e && e.message) || e) });
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
