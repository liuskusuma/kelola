// Jalankan: node --test
// Menguji Edge Function supabase/functions/midtrans/index.ts dengan Node.
// Supabase (REST + auth) dan Midtrans diganti tiruan di dalam memori.
const test = require('node:test');
const assert = require('node:assert/strict');

const muat = () => import('../supabase/functions/midtrans/index.ts');

const URL_SB = 'https://sb.test';
const OWNER = 'owner-1';
const STAFF = 'staff-1';
const KUNCI_UJI = 'SB-Mid-server-abcdefghijkl';

// Server tiruan: tabel Supabase + transaksi Midtrans.
function dunia() {
  const t = { staff: [{ staff_id: STAFF, owner_id: OWNER }], midtrans_kunci: [], midtrans_bayar: [] };
  const mt = new Map(); // order_id -> transaksi Midtrans
  const panggilan = [];
  const cocok = (row, params) => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      const [op, ...sisa] = v.split('.');
      const nilai = sisa.join('.');
      const isi = row[k] === undefined || row[k] === null ? '' : String(row[k]);
      if (op === 'eq' && isi !== nilai) return false;
      if (op === 'gt' && !(isi > nilai)) return false;
      if (op === 'in' && !nilai.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/"/g, '')).includes(isi)) return false;
    }
    return true;
  };
  const balas = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => (data === undefined ? '' : JSON.stringify(data)) });

  async function fetchFn(alamat, opsi) {
    const o = opsi || {};
    const u = new URL(alamat);
    const body = o.body ? JSON.parse(o.body) : null;
    panggilan.push({ alamat, method: o.method || 'GET', body, auth: o.headers && o.headers.Authorization });
    if (u.origin === URL_SB && u.pathname === '/auth/v1/user') {
      const token = o.headers.Authorization.replace('Bearer ', '');
      return token.startsWith('tok-') ? balas(200, { id: token.slice(4) }) : balas(401, {});
    }
    if (u.origin === URL_SB && u.pathname.startsWith('/rest/v1/')) {
      const tabel = t[u.pathname.slice(9)];
      const params = [...u.searchParams];
      const m = o.method || 'GET';
      if (m === 'GET') return balas(200, tabel.filter((r) => cocok(r, params)));
      if (m === 'POST') {
        const kunci = u.searchParams.get('on_conflict');
        const lama = kunci && tabel.find((r) => r[kunci] === body[kunci]);
        if (lama) Object.assign(lama, body); else tabel.push(Object.assign({ status: 'pending', diproses: false, created_at: new Date().toISOString() }, body));
        return balas(201, undefined);
      }
      if (m === 'PATCH') { tabel.filter((r) => cocok(r, params)).forEach((r) => Object.assign(r, body)); return balas(204, undefined); }
      if (m === 'DELETE') { t[u.pathname.slice(9)] = tabel.filter((r) => !cocok(r, params)); return balas(204, undefined); }
    }
    if (/midtrans\.com$/.test(u.hostname)) {
      const kunci = Buffer.from(o.headers.Authorization.replace('Basic ', ''), 'base64').toString().replace(/:$/, '');
      if (kunci !== KUNCI_UJI) return balas(401, { status_code: '401', status_message: 'Unknown Merchant server_key/id' });
      if (u.pathname === '/v2/charge') {
        const id = body.transaction_details.order_id;
        mt.set(id, { transaction_status: 'pending', gross_amount: `${body.transaction_details.gross_amount}.00`, payment_type: 'qris' });
        return balas(201, { status_code: '201', transaction_status: 'pending', qr_string: `000201QR-${id}`, expiry_time: '2026-11-13 12:15:00' });
      }
      if (u.pathname === '/snap/v1/transactions') {
        return balas(201, { token: 'tk', redirect_url: `https://app.sandbox.midtrans.com/snap/v4/redirection/${body.transaction_details.order_id}` });
      }
      const s = u.pathname.match(/^\/v2\/([^/]+)\/(status|cancel)$/);
      if (s) {
        const tr = mt.get(decodeURIComponent(s[1]));
        if (!tr) return balas(404, { status_code: '404', status_message: 'Transaction does not exist.' });
        if (s[2] === 'cancel' && tr.transaction_status === 'pending') tr.transaction_status = 'cancel';
        return balas(200, Object.assign({ status_code: '200' }, tr));
      }
    }
    throw new Error('tidak dikenal: ' + alamat);
  }
  return { t, mt, panggilan, fetchFn };
}

async function siap() {
  const m = await muat();
  const d = dunia();
  let n = 0;
  const penangan = m.buatPenangan({ url: URL_SB, kunciServer: 'service', fetchFn: d.fetchFn, sekarang: () => 1794550000000 + (n += 1000), acak: () => 0.5 });
  const kirim = async (siapa, body) => {
    const req = new Request('https://fn.test/midtrans', { method: 'POST', headers: { authorization: `Bearer tok-${siapa}` }, body: JSON.stringify(body) });
    const res = await penangan(req);
    return { status: res.status, data: await res.json() };
  };
  return { m, d, kirim };
}

test('pembantu: format kunci, mode uji, status, waktu', async () => {
  const m = await muat();
  assert.ok(m.kunciSah(KUNCI_UJI));
  assert.ok(m.kunciSah('Mid-server-ABCdef123456'));
  assert.ok(!m.kunciSah('Mid-client-ABCdef123456'), 'Client Key bukan Server Key');
  assert.ok(m.kunciSah('SB-Mid-server-eV9.l8qsTDo_FKQjW63pXyZ'), 'kunci dashboard baru memuat titik');
  assert.ok(!m.kunciSah('SB-Mid-client-ABCdef123456'));
  assert.ok(!m.kunciSah('asal'));
  assert.ok(!m.kunciSah('Mid-server- ada spasi di tengah'));
  assert.ok(m.modeUji(KUNCI_UJI) && !m.modeUji('Mid-server-ABCdef123456'));
  assert.equal(m.statusDari('settlement'), 'lunas');
  assert.equal(m.statusDari('capture'), 'lunas');
  assert.equal(m.statusDari('expire'), 'kedaluwarsa');
  assert.equal(m.statusDari('pending'), 'pending');
  assert.equal(m.waktuMidtrans('2026-11-13 12:15:00'), '2026-11-13T05:15:00.000Z');
  assert.match(m.buatOrderId(1794550000000, () => 0.1), /^KL-[0-9A-Z]+-[A-Z2-9]{6}$/);
  assert.equal(m.metodeDari({ payment_type: 'qris', issuer: 'dana' }), 'qris/dana');
});

test('owner menghubungkan Midtrans; kunci salah ditolak; staff tidak boleh', async () => {
  const { d, kirim } = await siap();
  assert.equal((await kirim(OWNER, { aksi: 'simpan', serverKey: 'asal' })).data.error, 'format');
  assert.equal((await kirim(OWNER, { aksi: 'simpan', serverKey: 'SB-Mid-server-salahsalah' })).data.error, 'kunci-salah');
  assert.equal((await kirim(STAFF, { aksi: 'simpan', serverKey: KUNCI_UJI })).status, 403);
  const r = await kirim(OWNER, { aksi: 'simpan', serverKey: ` ${KUNCI_UJI} ` });
  assert.deepEqual(r.data, { terhubung: true, aktif: true, uji: true });
  assert.equal(d.t.midtrans_kunci[0].server_key, KUNCI_UJI);
  // Kunci tidak pernah dikirim balik.
  const cek = await kirim(STAFF, { aksi: 'cek' });
  assert.deepEqual(cek.data, { terhubung: true, aktif: true, uji: true });
  assert.ok(!JSON.stringify(cek.data).includes('Mid-server'));
  assert.equal((await kirim('orang-lain', { aksi: 'cek' })).data.terhubung, false);
  assert.equal((await kirim(OWNER, { aksi: 'aktif', aktif: false })).data.aktif, false);
  assert.equal((await kirim(STAFF, { aksi: 'qris', jumlah: 1000 })).data.error, 'mati');
  assert.equal((await kirim(OWNER, { aksi: 'hapus' })).data.terhubung, false);
  assert.equal(d.t.midtrans_kunci.length, 0);
  assert.equal((await kirim(OWNER, { aksi: 'apa' })).status, 400);
});

test('kasir staff: buat QRIS, tunggu, lunas otomatis', async () => {
  const { d, kirim } = await siap();
  await kirim(OWNER, { aksi: 'simpan', serverKey: KUNCI_UJI });
  const q = await kirim(STAFF, { aksi: 'qris', jumlah: 45000 });
  assert.equal(q.status, 200);
  assert.ok(q.data.qr.startsWith('000201'));
  const charge = d.panggilan.find((p) => p.alamat.endsWith('/v2/charge'));
  assert.equal(charge.alamat, 'https://api.sandbox.midtrans.com/v2/charge');
  assert.equal(charge.body.transaction_details.gross_amount, 45000);
  assert.equal(charge.auth, 'Basic ' + Buffer.from(KUNCI_UJI + ':').toString('base64'));
  assert.equal(d.t.midtrans_bayar[0].owner_id, OWNER);
  assert.equal(d.t.midtrans_bayar[0].dibuat_oleh, STAFF);
  assert.equal((await kirim(STAFF, { aksi: 'status', order_id: q.data.order_id })).data.status, 'pending');
  Object.assign(d.mt.get(q.data.order_id), { transaction_status: 'settlement', issuer: 'gopay', settlement_time: '2026-11-13 12:01:00' });
  const s = await kirim(STAFF, { aksi: 'status', order_id: q.data.order_id });
  assert.deepEqual(s.data, { status: 'lunas', metode: 'qris/gopay' });
  assert.equal(d.t.midtrans_bayar[0].dibayar, '2026-11-13T05:01:00.000Z');
  // Akun lain tidak bisa melihat pembayaran ini.
  assert.equal((await kirim('orang-lain', { aksi: 'status', order_id: q.data.order_id })).status, 404);
  assert.equal((await kirim(OWNER, { aksi: 'qris', jumlah: 0 })).status, 400);
});

test('kasir menutup QR: pesanan dibatalkan di Midtrans', async () => {
  const { d, kirim } = await siap();
  await kirim(OWNER, { aksi: 'simpan', serverKey: KUNCI_UJI });
  const q = await kirim(OWNER, { aksi: 'qris', jumlah: 10000 });
  const b = await kirim(OWNER, { aksi: 'batal', order_id: q.data.order_id });
  assert.equal(b.data.status, 'batal');
  assert.ok(d.panggilan.some((p) => p.alamat.endsWith('/cancel')));
});

test('tagihan: link dipakai ulang, pembayaran diambil sekali', async () => {
  const { d, kirim } = await siap();
  await kirim(OWNER, { aksi: 'simpan', serverKey: KUNCI_UJI });
  assert.equal((await kirim(STAFF, { aksi: 'link', ref: 't1', jumlah: 120000 })).status, 403);
  const l1 = await kirim(OWNER, { aksi: 'link', ref: 't1', jumlah: 120000, nama: 'Budi', hari: 7 });
  assert.match(l1.data.link, /^https:\/\/app\.sandbox\.midtrans\.com\//);
  const snap = d.panggilan.find((p) => p.alamat.includes('/snap/v1/'));
  assert.deepEqual(snap.body.expiry, { unit: 'day', duration: 7 });
  assert.equal(snap.body.customer_details.first_name, 'Budi');
  const l2 = await kirim(OWNER, { aksi: 'link', ref: 't1', jumlah: 120000, nama: 'Budi' });
  assert.equal(l2.data.link, l1.data.link, 'link sama untuk tagihan yang sama');
  assert.equal(d.panggilan.filter((p) => p.alamat.includes('/snap/v1/')).length, 1);
  // Belum dibayar: Midtrans belum mengenal pesanan (404) -> tetap menunggu.
  assert.deepEqual((await kirim(OWNER, { aksi: 'ambil' })).data.bayar, []);
  // Pembeli membayar lewat link.
  d.mt.set(l1.data.order_id, { transaction_status: 'settlement', gross_amount: '120000.00', payment_type: 'bank_transfer' });
  const a = await kirim(OWNER, { aksi: 'ambil' });
  assert.equal(a.data.bayar.length, 1);
  assert.equal(a.data.bayar[0].ref, 't1');
  assert.equal(a.data.bayar[0].jumlah, 120000);
  assert.equal(a.data.bayar[0].metode, 'bank_transfer');
  assert.deepEqual((await kirim(OWNER, { aksi: 'ambil' })).data.bayar, [], 'tidak diambil dua kali');
});

test('tanpa sesi ditolak', async () => {
  const m = await muat();
  const d = dunia();
  const penangan = m.buatPenangan({ url: URL_SB, kunciServer: 'service', fetchFn: d.fetchFn });
  const res = await penangan(new Request('https://fn.test', { method: 'POST', body: JSON.stringify({ aksi: 'cek' }) }));
  assert.equal(res.status, 401);
});
