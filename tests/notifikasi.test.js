// Jalankan: node --test
// Menguji Edge Function supabase/functions/pengingat-tagihan/index.ts dengan Node
// (Web Crypto di Node sama dengan di Deno). Supabase dan server push diganti tiruan.
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

const muat = () => import('../supabase/functions/pengingat-tagihan/index.ts');

// HP tiruan: pasangan kunci ECDH dan rahasia auth, seperti PushSubscription di browser.
function hpTiruan() {
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return {
    ecdh, auth,
    p256dh: ecdh.getPublicKey().toString('base64url'),
    authB64: auth.toString('base64url'),
  };
}

const hkdf = (salt, ikm, info, n) => Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, info, n));

// Buka isi notifikasi seperti yang dilakukan browser (RFC 8291).
function bukaSandi(hp, body) {
  const b = Buffer.from(body);
  const salt = b.subarray(0, 16);
  const idlen = b[20];
  const asPublik = b.subarray(21, 21 + idlen);
  const sandi = b.subarray(21 + idlen);
  const rahasia = hp.ecdh.computeSecret(asPublik);
  const ikm = hkdf(hp.auth, rahasia, Buffer.concat([Buffer.from('WebPush: info\0'), hp.ecdh.getPublicKey(), asPublik]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(sandi.subarray(sandi.length - 16));
  const polos = Buffer.concat([d.update(sandi.subarray(0, sandi.length - 16)), d.final()]);
  assert.equal(polos[polos.length - 1], 2, 'penanda rekaman terakhir');
  return JSON.parse(polos.subarray(0, polos.length - 1).toString());
}

function cekVapid(header, endpoint, publikB64) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[2], publikB64);
  const [kepala, isi, ttd] = m[1].split('.');
  const klaim = JSON.parse(Buffer.from(isi, 'base64url').toString());
  assert.equal(klaim.aud, new URL(endpoint).origin);
  assert.ok(klaim.sub.startsWith('https://'));
  const kunci = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(publikB64, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(publikB64, 'base64url').subarray(33).toString('base64url') }, format: 'jwk' });
  const sah = nodeCrypto.verify('sha256', Buffer.from(`${kepala}.${isi}`), { key: kunci, dsaEncoding: 'ieee-p1363' }, Buffer.from(ttd, 'base64url'));
  assert.ok(sah, 'tanda tangan VAPID sah');
}

test('isi notifikasi terenkripsi bisa dibuka HP, tanda tangan VAPID sah', async () => {
  const F = await muat();
  const hp = hpTiruan();
  const kunci = await F.buatKunciVapid();
  let kiriman;
  const fetchFn = async (url, o) => { kiriman = { url, o }; return { status: 201 }; };
  const lg = { endpoint: 'https://push.contoh.com/kirim/abc', p256dh: hp.p256dh, auth: hp.authB64 };
  const status = await F.kirimPush(fetchFn, lg, { judul: 'Halo', isi: 'Rp 85.000' }, kunci, Date.now());
  assert.equal(status, 201);
  assert.equal(kiriman.o.headers['Content-Encoding'], 'aes128gcm');
  cekVapid(kiriman.o.headers.Authorization, lg.endpoint, kunci.publik);
  assert.deepEqual(bukaSandi(hp, kiriman.o.body), { judul: 'Halo', isi: 'Rp 85.000' });
});

test('ringkasan tagihan dan isi notifikasi', async () => {
  const F = await muat();
  const t = (nama, jatuhTempo, total, dibayar) => ({ metode: 'nanti', pelanggan: { nama }, jatuhTempo, total, dibayar: dibayar || [] });
  const trx = [t('Pak Budi', '2026-11-05', 150000), t('Bu Rina', '2026-11-09', 100000, [{ jumlah: 15000 }]), t('Bu Ani', '2026-11-11', 85000), t('Kantor', '2026-11-20', 177000), t('Lama', undefined, 5000)];
  const r = F.ringkas(trx, '2026-11-10', 1);
  assert.deepEqual(r.lewat.map((d) => d.pelanggan.nama), ['Pak Budi', 'Bu Rina']);
  assert.equal(r.totalLewat, 235000);
  assert.deepEqual(r.segera.map((d) => d.pelanggan.nama), ['Bu Ani']);
  assert.deepEqual(F.pesanNotifikasi(r, 'id'), { judul: '2 tagihan lewat jatuh tempo', isi: 'Pak Budi, Bu Rina · Rp 235.000 · +1 segera jatuh tempo', tag: 'kelola-tagihan', url: './?buka=tagihan' });
  assert.equal(F.pesanNotifikasi(F.ringkas(trx, '2026-11-03', 3), 'en').judul, 'Bills due soon: 1');
  assert.equal(F.tanggalDiZona(Date.parse('2026-11-09T18:30:00Z'), 'Asia/Jakarta'), '2026-11-10');
  assert.deepEqual(F.pengaturan({}), { ingatkan: true, mulai: 1 });
});

// Supabase tiruan: tabel push_kunci, push_langganan, records.
function supabaseTiruan(hp) {
  const db = {
    push_kunci: [],
    push_langganan: [
      { endpoint: 'https://push.contoh.com/a', user_id: 'u1', p256dh: hp.p256dh, auth: hp.authB64, bahasa: 'id', terakhir_kirim: null },
      { endpoint: 'https://push.contoh.com/hilang', user_id: 'u1', p256dh: hp.p256dh, auth: hp.authB64, bahasa: 'id', terakhir_kirim: null },
      { endpoint: 'https://push.contoh.com/b', user_id: 'u2', p256dh: hp.p256dh, auth: hp.authB64, bahasa: 'en', terakhir_kirim: null },
    ],
    records: [
      { user_id: 'u1', id: 'profil', kind: 'profil', deleted: false, data: { namaUsaha: 'Kedai' } },
      { user_id: 'u1', id: 't1', kind: 'transaksi', deleted: false, data: { metode: 'nanti', lunas: false, total: 50000, pelanggan: { nama: 'Bu Ani' }, jatuhTempo: '2026-11-08', dibayar: [] } },
      { user_id: 'u2', id: 'profil', kind: 'profil', deleted: false, data: { tagihan: { ingatkan: false } } },
      { user_id: 'u2', id: 't2', kind: 'transaksi', deleted: false, data: { metode: 'nanti', lunas: false, total: 9000, pelanggan: { nama: 'X' }, jatuhTempo: '2026-11-01', dibayar: [] } },
    ],
  };
  const masuk = [];
  const res = (status, data) => ({ ok: status < 300, status, text: async () => (data === undefined ? '' : JSON.stringify(data)), json: async () => data });
  const fetchFn = async (url, o) => {
    const u = new URL(url);
    if (u.hostname === 'push.contoh.com') {
      if (u.pathname === '/hilang') return { status: 410 };
      masuk.push({ endpoint: url, isi: bukaSandi(hp, o.body) });
      return { status: 201 };
    }
    if (u.pathname === '/auth/v1/user') return o.headers.Authorization === 'Bearer token-u1' ? res(200, { id: 'u1' }) : res(401, {});
    const tabel = u.pathname.replace('/rest/v1/', '');
    const q = u.searchParams;
    const cocok = (r) => [...q.entries()].every(([k, v]) => {
      if (['select', 'on_conflict', 'or'].includes(k)) return true;
      const nilai = k.startsWith('data->>') ? String(r.data[k.slice(7)]) : String(r[k]);
      return nilai === v.replace(/^eq\./, '');
    });
    const m = o.method || 'GET';
    if (m === 'GET') return res(200, db[tabel].filter(cocok));
    if (m === 'POST') { const b = JSON.parse(o.body); if (!db[tabel].some((r) => r.id === b.id)) db[tabel].push(b); return res(201); }
    if (m === 'DELETE') { db[tabel] = db[tabel].filter((r) => !cocok(r)); return res(204); }
    if (m === 'PATCH') { db[tabel].filter(cocok).forEach((r) => Object.assign(r, JSON.parse(o.body))); return res(204); }
    return res(400, {});
  };
  return { db, masuk, fetchFn };
}

test('Edge Function: kunci dibuat sekali, pengingat harian, uji, alamat kedaluwarsa dihapus', async () => {
  const F = await muat();
  const hp = hpTiruan();
  const sb = supabaseTiruan(hp);
  const penangan = F.buatPenangan({ url: 'https://demo.supabase.co', kunciServer: 'service', fetchFn: sb.fetchFn, sekarang: () => Date.parse('2026-11-10T01:00:00Z') });
  const panggil = async (body, token) => {
    const req = new Request('https://demo.supabase.co/functions/v1/pengingat-tagihan', { method: 'POST', body: JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
    const r = await penangan(req);
    return { status: r.status, data: await r.json() };
  };

  const k1 = await panggil({ aksi: 'kunci' });
  const k2 = await panggil({ aksi: 'kunci' });
  assert.equal(k1.status, 200);
  assert.equal(k1.data.publik, k2.data.publik);
  assert.equal(sb.db.push_kunci.length, 1);

  const kirim = await panggil({ aksi: 'kirim' });
  assert.deepEqual(kirim.data, { tanggal: '2026-11-10', pengguna: 2, terkirim: 1 });
  assert.deepEqual(sb.masuk.map((m) => m.endpoint), ['https://push.contoh.com/a'], 'u2 mematikan pengingat');
  assert.equal(sb.masuk[0].isi.judul, '1 tagihan lewat jatuh tempo');
  assert.equal(sb.masuk[0].isi.isi, 'Bu Ani · Rp 50.000');
  assert.equal(sb.db.push_langganan.find((l) => l.endpoint.endsWith('/a')).terakhir_kirim, '2026-11-10');
  assert.ok(!sb.db.push_langganan.some((l) => l.endpoint.endsWith('/hilang')), 'alamat 410 dihapus');

  assert.equal((await panggil({ aksi: 'uji' })).status, 401);
  const uji = await panggil({ aksi: 'uji' }, 'token-u1');
  assert.deepEqual(uji.data, { terkirim: 1 });
  assert.equal(sb.masuk[1].isi.isi, 'Pengingat tagihan sudah aktif di HP ini 👍');
  assert.equal((await panggil({ aksi: 'lain' })).status, 400);
});
