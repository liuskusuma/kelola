// Uji ujung-ke-ujung: dua "perangkat" (dua browser context) dengan Supabase tiruan.
// Butuh Playwright dan server lokal:
//   python3 -m http.server 8765   (dari folder repo)
//   node tests/e2e.js
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = process.env.KELOLA_URL || 'http://localhost:8765/';
const SB = 'https://demo.supabase.co';
const rows = new Map();
let clock = Date.now();
const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'lius@contoh.id', aud: 'authenticated', role: 'authenticated' };
const STAFF = { id: '22222222-2222-4222-8222-222222222222', email: 'budi@contoh.id', aud: 'authenticated', role: 'authenticated' };
const SARI = { id: '33333333-3333-4333-8333-333333333333', email: 'sari@contoh.id', aud: 'authenticated', role: 'authenticated' };
const USERS = [USER, STAFF, SARI];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtUntuk = (u) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: u.id, email: u.email, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', aud: 'authenticated' }) + '.sig';
// Tabel staff tiruan (lihat supabase/staff.sql).
const staff = [];
const undangan = new Map();
const penjualan = new Map();
const log = [];
// Edge Function `midtrans` tiruan (lihat supabase/functions/midtrans/index.ts).
const midKunci = new Map(); // owner -> { kunci, aktif }
const midBayar = new Map(); // order_id -> { owner, sumber, ref, jumlah, status, diproses }
let midNomor = 0;
const refresh = new Map(); // refresh token -> user id
let nomorRefresh = 0;
const norm = (s) => s.replace(/\u00a0/g, ' ');
// Bagian di halaman Akun bisa dibuka-tutup; buka semuanya supaya isiannya bisa diklik.
const bukaLipat = (page) => page.evaluate(() => {
  ['akunHp', 'profil', 'qris', 'pengaturan', 'cloud', 'faceid', 'staff', 'kunci', 'gabung'].forEach((k) => { Kelola.ui.lipat[k] = true; });
  document.querySelectorAll('details.lipat').forEach((d) => { d.open = true; });
});

async function mock(route) {
  const req = route.request();
  const url = new URL(req.url());
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  log.push(req.method() + ' ' + url.pathname + url.search);
  // Pengguna yang memanggil, dari token di header (seperti auth.uid() di Supabase).
  let uid = null;
  try { uid = JSON.parse(Buffer.from((req.headers().authorization || '').split('.')[1], 'base64url')).sub; } catch (e) { /* anon */ }
  const json = (status, data) => route.fulfill({ status, headers: cors, body: data === undefined ? '' : JSON.stringify(data) });
  const eq = (k) => { const v = url.searchParams.get(k); return v ? v.replace(/^eq\./, '') : null; };
  if (url.pathname === '/auth/v1/token') {
    const body = JSON.parse(req.postData());
    let user;
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      // Refresh token sekali pakai, seperti Supabase.
      user = USERS.find((u) => u.id === refresh.get(body.refresh_token));
      refresh.delete(body.refresh_token);
      if (!user) return route.fulfill({ status: 400, headers: cors, body: JSON.stringify({ error: 'invalid_grant', message: 'Invalid Refresh Token' }) });
    } else {
      user = USERS.find((u) => u.email === body.email);
      if (!user || body.password !== 'rahasia123') return route.fulfill({ status: 400, headers: cors, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials', message: 'Invalid login credentials' }) });
    }
    const rt = 'r' + (++nomorRefresh);
    refresh.set(rt, user.id);
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ access_token: jwtUntuk(user), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: rt, user }) });
  }
  if (url.pathname === '/auth/v1/user') {
    const user = USERS.find((u) => u.id === uid);
    return user ? json(200, user) : json(401, { message: 'invalid JWT' });
  }
  if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });
  if (url.pathname === '/rest/v1/records' && req.method() === 'GET') {
    const gte = url.searchParams.get('server_updated_at');
    const since = gte ? Date.parse(gte.replace('gte.', '')) : 0;
    const limit = +url.searchParams.get('limit') || 1000;
    const out = [...rows.values()].filter((r) => r.user_id === uid && Date.parse(r.server_updated_at) >= since)
      .sort((a, b) => Date.parse(a.server_updated_at) - Date.parse(b.server_updated_at)).slice(0, limit)
      .map(({ user_id, ...r }) => r);
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(out) });
  }
  if (url.pathname === '/rest/v1/records' && req.method() === 'POST') {
    assert.equal(url.searchParams.get('on_conflict'), 'user_id,id');
    const body = JSON.parse(req.postData());
    (Array.isArray(body) ? body : [body]).forEach((r) => {
      assert.equal(r.user_id, uid);
      const old = rows.get(r.id);
      if (old && Date.parse(r.updated_at) < Date.parse(old.updated_at)) return;
      clock += 10;
      rows.set(r.id, { ...r, server_updated_at: new Date(clock).toISOString() });
    });
    return route.fulfill({ status: 201, headers: cors, body: '' });
  }
  if (url.pathname === '/rest/v1/staff' && req.method() === 'GET') {
    const out = staff.filter((x) => (x.owner_id === uid || x.staff_id === uid)
      && (!eq('staff_id') || x.staff_id === eq('staff_id')) && (!eq('owner_id') || x.owner_id === eq('owner_id')));
    return json(200, out);
  }
  if (url.pathname === '/rest/v1/staff' && req.method() === 'DELETE') {
    const i = staff.findIndex((x) => x.staff_id === eq('staff_id') && x.owner_id === uid);
    if (i >= 0) staff.splice(i, 1);
    return json(204);
  }
  if (url.pathname === '/rest/v1/undangan_staff' && req.method() === 'POST') {
    assert.ok(!staff.some((x) => x.staff_id === uid), 'staff tidak boleh membuat undangan');
    const body = JSON.parse(req.postData());
    undangan.set(body.kode, { owner_id: uid, dipakai_oleh: null });
    return json(201);
  }
  if (url.pathname === '/rest/v1/rpc/gabung_staff') {
    const body = JSON.parse(req.postData());
    const u = undangan.get(String(body.kode_undangan).trim().toUpperCase());
    if (!u || u.dipakai_oleh) return json(400, { code: 'P0001', message: 'Kode undangan tidak berlaku' });
    if (u.owner_id === uid) return json(400, { code: 'P0001', message: 'Kode ini milik akun Anda sendiri' });
    u.dipakai_oleh = uid;
    staff.push({ staff_id: uid, owner_id: u.owner_id, nama: body.nama_staff, created_at: new Date().toISOString() });
    return json(200, u.owner_id);
  }
  if (url.pathname === '/rest/v1/rpc/produk_kasir') {
    const st = staff.find((x) => x.staff_id === uid);
    if (!st) return json(400, { code: 'P0001', message: 'Bukan akun staff' });
    const milik = [...rows.values()].filter((r) => r.user_id === st.owner_id && !r.deleted);
    const tertunda = {};
    [...penjualan.values()].filter((j) => j.owner_id === st.owner_id && !j.diproses)
      .forEach((j) => j.data.items.forEach((i) => { tertunda[i.produkId] = (tertunda[i.produkId] || 0) + i.qty; }));
    const prof = milik.find((r) => r.kind === 'profil');
    return json(200, {
      usaha: { namaUsaha: prof ? prof.data.namaUsaha : null, kontak: prof ? prof.data.kontak : null, qris: prof ? prof.data.qris || null : null, logo: prof ? prof.data.logo || null : null, warna: prof ? prof.data.warna || null : null, kategori: prof ? prof.data.kategori || null : null },
      produk: milik.filter((r) => r.kind === 'produk').map((r) => ({
        id: r.id, nama: r.data.nama, harga: r.data.harga, satuan: r.data.satuan, kategori: r.data.kategori || null, foto: r.data.foto, mode: r.data.mode, paket: r.data.paket, varian: r.data.varian || null,
        stok: typeof r.data.stok === 'number' ? r.data.stok - (tertunda[r.id] || 0) : null,
      })),
    });
  }
  if (url.pathname === '/rest/v1/penjualan_staff' && req.method() === 'POST') {
    const st = staff.find((x) => x.staff_id === uid);
    const body = JSON.parse(req.postData());
    for (const j of Array.isArray(body) ? body : [body]) {
      if (!st || st.owner_id !== j.owner_id) return json(403, { code: '42501', message: 'new row violates row-level security policy' });
      if (!penjualan.has(j.id)) penjualan.set(j.id, { ...j, staff_id: uid, diproses: false, created_at: new Date().toISOString() });
    }
    return json(201);
  }
  if (url.pathname === '/rest/v1/penjualan_staff' && req.method() === 'PATCH') {
    const out = [...penjualan.values()].filter((j) => j.owner_id === uid && j.owner_id === eq('owner_id') && !j.diproses);
    out.forEach((j) => { j.diproses = true; });
    return json(200, out.map(({ id, staff_id, data, created_at }) => ({ id, staff_id, data, created_at })));
  }
  if (url.pathname === '/functions/v1/midtrans') {
    if (!uid) return json(401, { error: 'masuk' });
    const body = JSON.parse(req.postData() || '{}');
    const st = staff.find((x) => x.staff_id === uid);
    const owner = st ? st.owner_id : uid;
    const k = midKunci.get(owner);
    const info = (x) => ({ terhubung: !!x, aktif: !!(x && x.aktif), uji: !!(x && /^SB-/.test(x.kunci)) });
    const baru = (isi) => { const id = 'KL-E2E-' + (++midNomor); midBayar.set(id, Object.assign({ owner, status: 'pending', diproses: false }, isi)); return id; };
    const milik = (id) => { const b = midBayar.get(id); return b && b.owner === owner ? b : null; };
    switch (body.aksi) {
      case 'cek': return json(200, info(k));
      case 'simpan':
        if (st) return json(403, { error: 'owner' });
        if (!/^\S{16,300}$/.test(String(body.serverKey || '').trim()) || /^(SB-)?Mid-client-/i.test(String(body.serverKey).trim())) return json(400, { error: 'format', pesan: 'Server Key tidak sesuai format' });
        if (/salah/.test(body.serverKey)) return json(400, { error: 'kunci-salah', pesan: 'Server Key ditolak Midtrans' });
        midKunci.set(owner, { kunci: body.serverKey.trim(), aktif: true });
        return json(200, info(midKunci.get(owner)));
      case 'aktif': k.aktif = !!body.aktif; return json(200, info(k));
      case 'hapus': midKunci.delete(owner); return json(200, info(null));
      case 'qris': {
        if (!k || !k.aktif) return json(409, { error: 'mati' });
        const id = baru({ sumber: 'kasir', jumlah: body.jumlah });
        return json(200, { order_id: id, qr: '00020101021226-MIDTRANS-' + id, kedaluwarsa: new Date(Date.now() + 900000).toISOString(), uji: true, gambar: 'https://api.sandbox.midtrans.com/v2/qris/' + id + '/qr-code' });
      }
      case 'status': { const b = milik(body.order_id); return b ? json(200, { status: b.status, metode: 'qris/gopay' }) : json(404, { error: 'tidak-ada' }); }
      case 'batal': { const b = milik(body.order_id); if (b && b.status === 'pending') b.status = 'batal'; return json(200, { status: b ? b.status : 'batal' }); }
      case 'link': {
        if (st) return json(403, { error: 'owner' });
        const ada = [...midBayar.entries()].find(([, b]) => b.owner === owner && b.ref === body.ref && b.jumlah === body.jumlah && b.status === 'pending');
        const id = ada ? ada[0] : baru({ sumber: 'tagihan', ref: body.ref, jumlah: body.jumlah, hari: body.hari });
        return json(200, { link: 'https://app.sandbox.midtrans.com/snap/v4/redirection/' + id, order_id: id });
      }
      case 'ambil': {
        const out = [...midBayar.entries()].filter(([, b]) => b.owner === owner && b.sumber === 'tagihan' && b.status === 'lunas' && !b.diproses);
        out.forEach(([, b]) => { b.diproses = true; });
        return json(200, { bayar: out.map(([id, b]) => ({ order_id: id, ref: b.ref, jumlah: b.jumlah, metode: 'qris/dana', dibayar: new Date().toISOString() })) });
      }
      default: return json(400, { error: 'aksi tidak dikenal' });
    }
  }
  return route.fulfill({ status: 404, headers: cors, body: '{}' });
}

// Satu "perangkat". Uji ini memakai Bahasa Indonesia (bawaan aplikasi English) dan langsung
// melewati layar awal sebagai owner tanpa akun, kecuali `polos` (layar awal dibiarkan tampil).
async function device(browser, polos) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route(SB + '/**', mock);
  await ctx.route(BASE + 'js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.KELOLA_CONFIG={supabaseUrl:'${SB}',supabaseAnonKey:'anon'};` }));
  if (!polos) await ctx.addInitScript(() => { if (!localStorage.getItem('kelola:pengaturan')) localStorage.setItem('kelola:pengaturan', '{"bahasa":"id"}'); });
  const errors = [];
  const page = await tab(ctx, errors);
  if (!polos) {
    await page.click('#gerbang [data-g=owner]');
    await page.click('[data-act=tanpa-akun]');
    await page.waitForSelector('nav.tabs');
  }
  return { ctx, page, errors };
}

// Tab baru di perangkat yang sama, seperti membuka aplikasi lagi setelah ditutup.
async function tab(ctx, errors) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE);
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const hp = await device(browser);
  const p = hp.page;

  // 1. Pakai tanpa login: tambah produk lewat kalkulator harga.
  await p.click('text=Tambah produk pertama');
  await p.fill('input[name=nama]', 'Keripik pedas');
  await p.fill('input[name=modal]', '6000');
  await p.fill('input[name=target]', '40');
  assert.equal(norm(await p.innerText('#pilihan')).replace(/\s+/g, ' ').trim(),
    'Hemat 30% Rp 9.000 Standar 40% Rp 10.000 Premium 55% Rp 13.500');
  await p.click('.pilih >> nth=1');
  assert.equal(await p.inputValue('input[name=harga]'), '10000');
  await p.fill('input[name=stok]', '20');
  await p.click('#formProduk button.primary');

  // 2. Jual 3 buah.
  await p.click('nav >> text=Kasir');
  for (let i = 0; i < 3; i++) await p.click('.tile');
  await p.fill('#bayar', '50000');
  assert.equal(norm(await p.textContent('#kembalian')), 'Rp 20.000');
  await p.click('text=Simpan penjualan');
  await p.click('nav >> text=Laporan');
  assert.ok((norm(await p.textContent('.stats'))).includes('Rp 30.000'));
  assert.ok((norm(await p.textContent('.stats'))).includes('Rp 12.000'));
  assert.equal(norm(await p.textContent('#syncBadge')), 'Lokal');

  // 3. Login: kata sandi salah, lalu benar. Data lokal terkirim ke cloud.
  await p.click('nav >> text=Akun');
  await bukaLipat(p);
  await p.fill('input[name=email]', USER.email);
  await p.fill('input[name=password]', 'salah1');
  await p.click('#formAuth button');
  await p.waitForSelector('.msg.err', { timeout: 5000 });
  assert.equal(norm(await p.textContent('.msg.err')), 'Email atau kata sandi salah.');
  assert.equal(await p.inputValue('input[name=email]'), USER.email);
  await p.fill('input[name=password]', 'rahasia123');
  await p.click('#formAuth button');
  await p.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan', null, { timeout: 5000 });
  assert.equal(rows.size, 2, 'produk + transaksi ada di cloud');

  // 4. Perangkat kedua login dan melihat data yang sama.
  const laptop = await device(browser);
  const l = laptop.page;
  await l.click('nav >> text=Akun');
  await bukaLipat(l);
  await l.fill('input[name=email]', USER.email);
  await l.fill('input[name=password]', 'rahasia123');
  await l.click('#formAuth button');
  await l.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan');
  await l.click('nav >> text=Produk');
  const teks = norm(await l.textContent('main'));
  assert.ok(teks.includes('Keripik pedas') && teks.includes('stok 17'), teks);

  // 5. Laptop mengubah harga; HP menerima perubahan saat sinkron.
  await l.click('text=Ubah');
  await l.fill('input[name=harga]', '11000');
  await l.click('#formProduk button.primary');
  await l.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan');
  await p.click('nav >> text=Akun');
  await bukaLipat(p);
  await p.click('text=Sinkronkan sekarang');
  await p.waitForTimeout(500);
  await p.click('nav >> text=Produk');
  assert.ok((norm(await p.textContent('main'))).includes('Rp 11.000'));

  // 6. Offline: perubahan disimpan lokal, lalu terkirim saat online.
  await hp.ctx.setOffline(true);
  await p.click('nav >> text=Kasir');
  await p.click('.tile');
  await p.click('text=Simpan penjualan');
  assert.ok((norm(await p.textContent('#syncBadge'))).startsWith('Offline'));
  await hp.ctx.setOffline(false);
  await p.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan', null, { timeout: 10000 });
  assert.equal([...rows.values()].filter((r) => r.kind === 'transaksi').length, 2);

  // 7. Data tetap ada setelah aplikasi dibuka ulang.
  await l.reload();
  await l.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan');
  await l.click('nav >> text=Laporan');
  await l.click('text=Semua');
  assert.ok((norm(await l.textContent('.stats'))).includes('Rp 41.000'), norm(await l.textContent('.stats')));

  // 8. Keluar menghapus data lokal.
  await l.click('nav >> text=Akun');
  await bukaLipat(l);
  await l.click('text=Keluar');
  await l.waitForSelector('#gerbang');
  assert.ok(norm(await l.textContent('#gerbang')).includes('Anda sudah keluar.'));
  await l.click('#gerbang [data-g=owner]');
  await l.click('[data-act=tanpa-akun]');
  await l.click('nav >> text=Produk');
  assert.ok((norm(await l.textContent('main'))).includes('Belum ada produk'));

  // 9. Bahan baku dan resep: modal dihitung dari bahan.
  const tambahBahan = async (nama, isi, harga, stok) => {
    await p.click('main >> text=+ Tambah bahan');
    await p.fill('#formBahan input[name=nama]', nama);
    await p.fill('#formBahan input[name=isi]', String(isi));
    await p.fill('#formBahan input[name=harga]', String(harga));
    if (stok != null) await p.fill('#formBahan input[name=stok]', String(stok));
    await p.click('#formBahan button.primary');
  };
  await p.click('nav >> text=Produk');
  await p.click('.seg >> text=Bahan baku');
  await tambahBahan('Gula', 1000, 18000, 5000);
  await tambahBahan('Kopi bubuk', 250, 25000);
  assert.ok(norm(await p.textContent('main')).includes('Rp 18 per gram'));
  await p.click('.seg >> text=Produk');
  await p.click('text=+ Tambah produk');
  await p.fill('input[name=nama]', 'Es kopi');
  await p.click('dialog >> text=Dari resep');
  await p.selectOption('[data-baris=resep] >> nth=0 >> select', { label: 'Kopi bubuk' });
  await p.fill('[data-baris=resep] >> nth=0 >> input', '15');
  await p.click('dialog >> text=+ Tambah bahan');
  await p.selectOption('[data-baris=resep] >> nth=1 >> select', { label: 'Gula' });
  await p.fill('[data-baris=resep] >> nth=1 >> input', '20');
  await p.fill('input[name=biayaLain]', '1500');
  assert.equal(norm(await p.textContent('#hpp')), 'Rp 3.360');
  await p.click('.pilih >> nth=1'); // standar 30% → Rp 5.000
  await p.click('#formProduk button.primary');
  assert.ok(norm(await p.textContent('main')).includes('Modal Rp 3.360 · jual Rp 5.000'));

  // 10. Paket: modal = jumlah modal isinya.
  await p.click('text=+ Tambah produk');
  await p.fill('input[name=nama]', 'Paket ngopi');
  await p.click('dialog [data-m=paket]');
  await p.selectOption('[data-baris=paket] >> nth=0 >> select', { label: 'Keripik pedas' });
  await p.fill('[data-baris=paket] >> nth=0 >> input', '2');
  await p.click('dialog >> text=+ Tambah produk');
  await p.selectOption('[data-baris=paket] >> nth=1 >> select', { label: 'Es kopi' });
  assert.equal(norm(await p.textContent('#hpp')), 'Rp 15.360');
  await p.fill('input[name=harga]', '25000');
  await p.click('#formProduk button.primary');

  // 10b. Kategori: buat dari form produk, saring di kasir, lalu ganti nama dan urutan.
  const judulKategori = () => p.locator('li.kat-judul').allTextContents();
  assert.equal(await p.locator('li.kat-judul').count(), 0, 'tanpa kategori, daftar tidak dikelompokkan');
  await p.click('li.row:has-text("Es kopi") [data-act=produk-ubah]');
  await p.click('[data-act=kategori-baru]');
  await p.fill('input[name=kategoriBaru]', ' minuman ');
  await p.click('#formProduk button.primary');
  await p.click('li.row:has-text("Keripik pedas") [data-act=produk-ubah]');
  await p.click('[data-act=kategori-baru]');
  await p.fill('input[name=kategoriBaru]', 'Camilan');
  await p.click('#formProduk button.primary');
  assert.deepEqual(await judulKategori(), ['minuman · 1', 'Camilan · 1', 'Lainnya · 1']);
  await p.click('li.row:has-text("Paket ngopi") [data-act=produk-ubah]');
  assert.deepEqual(await p.locator('[data-act=pilih-kategori]').allTextContents(), ['minuman', 'Camilan']);
  await p.click('dialog >> text=Tutup');
  await p.click('nav >> text=Kasir');
  assert.deepEqual(await p.locator('.kat-chips button').allTextContents(), ['Semua3', 'minuman1', 'Camilan1', 'Lainnya1']);
  await p.click('.kat-chips >> text=Camilan');
  assert.deepEqual(await p.locator('.grid .tile .nama').allTextContents(), ['Keripik pedas']);
  await p.click('.kat-chips >> text=Semua');
  assert.equal(await p.locator('.grid .tile').count(), 3);
  await p.click('nav >> text=Produk');
  await p.click('[data-act=atur-kategori]');
  await p.fill('.kat-baris >> nth=0 >> input', 'Minuman');
  await p.click('.kat-baris >> nth=0 >> [data-act=kategori-turun]');
  await p.click('#formKategori button.primary');
  assert.deepEqual(await judulKategori(), ['Camilan · 1', 'Minuman · 1', 'Lainnya · 1']);
  assert.equal(await p.evaluate(() => Kelola.store.list('produk').find((r) => r.data.nama === 'Es kopi').data.kategori), 'Minuman');

  // 11. Jual es kopi ×2 dan paket ×1: stok gula & keripik berkurang, struk bisa dibuat.
  await p.click('nav >> text=Kasir');
  await p.click('.tile:has-text("Es kopi")');
  await p.click('.tile:has-text("Es kopi")');
  await p.click('.tile:has-text("Paket ngopi")');
  await p.click('text=Simpan penjualan');
  await p.click('#trxTerakhir button');
  await p.waitForSelector('#strukGambar');
  assert.ok(await p.evaluate(() => document.querySelector('#strukGambar').naturalWidth === 600 || new Promise((ok) => document.querySelector('#strukGambar').onload = () => ok(true))));
  const strukTanpaLogo = await p.evaluate(() => ({ id: Kelola.ui.trxTerakhir, tinggi: document.querySelector('#strukGambar').naturalHeight }));
  await p.click('dialog >> text=Tutup');
  await p.click('nav >> text=Produk');
  assert.ok(norm(await p.textContent('main')).includes('stok 14'), 'keripik 16 - 2');
  await p.click('.seg >> text=Bahan baku');
  assert.ok(norm(await p.textContent('main')).includes('stok 4.940 gram'), norm(await p.textContent('main')));

  // 12. Harga gula naik: Kelola menunjukkan produk terdampak dan saran harga baru.
  await p.click('li:has-text("Gula") >> text=Ubah');
  await p.fill('#formBahan input[name=harga]', '36000');
  await p.click('#formBahan button.primary');
  await p.waitForSelector('text=Cek harga jual');
  const dampak = norm(await p.textContent('dialog'));
  assert.ok(dampak.includes('Es kopi') && dampak.includes('Rp 3.360 → Rp 3.720'), dampak);
  await p.click('dialog li:has-text("Es kopi") >> text=Jual Rp 6.000');
  await p.click('dialog li:has-text("Paket ngopi") >> text=Harga tetap');
  assert.equal(await p.evaluate(() => document.querySelector('#dialog').open), false);
  await p.click('.seg >> text=Produk');
  assert.ok(norm(await p.textContent('main')).includes('Modal Rp 3.720 · jual Rp 6.000'));
  assert.ok(!norm(await p.textContent('main')).includes('Harga bahan berubah'));

  // 13. Pengeluaran mengurangi laba bersih.
  await p.click('nav >> text=Laporan');
  const angkaDi = async (sel) => Number(norm(await p.textContent(sel + ' .value')).replace(/[^0-9-]/g, ''));
  await p.click('text=+ Catat pengeluaran');
  await p.fill('#formPengeluaran input[name=jumlah]', '10000');
  await p.selectOption('#formPengeluaran select', 'Listrik & air');
  await p.click('#formPengeluaran button.primary');
  const kotor = await angkaDi('.stat:has-text("Laba kotor")');
  assert.equal(await angkaDi('.stat:has-text("Pengeluaran")'), 10000);
  assert.equal(await angkaDi('#labaBersih'), kotor - 10000);
  await p.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan', null, { timeout: 10000 });
  assert.ok([...rows.values()].some((r) => r.kind === 'bahan') && [...rows.values()].some((r) => r.kind === 'pengeluaran'));

  // 13a. Grafik omzet dan laba per jam, dengan tabel.
  assert.ok(norm(await p.textContent('main')).includes('Omzet & laba per jam'));
  assert.ok(await p.locator('#grafik path.omzet').count() > 0);
  await p.click('#grafik rect.sentuh >> nth=-1', { force: true }).catch(() => {});
  await p.click('#grafik summary');
  assert.ok(norm(await p.textContent('#grafik table')).includes('Rp'));

  // 13b. Laporan dengan tanggal pilihan sendiri.
  const omzetHariIni = await angkaDi('.stat:has-text("Omzet")');
  await p.click('.seg >> text=Tanggal');
  const tgl = (geser) => p.evaluate((g) => { const d = new Date(); d.setDate(d.getDate() + g); return d.toLocaleDateString('sv'); }, geser);
  await p.fill('[data-tanggal=dari]', await tgl(-3));
  await p.fill('[data-tanggal=sampai]', await tgl(-1));
  await p.waitForFunction(() => document.querySelector('.stat.utama .value').textContent.replace(/\D/g, '') === '0');
  await p.fill('[data-tanggal=sampai]', await tgl(0));
  await p.waitForFunction((n) => +document.querySelector('.stat.utama .value').textContent.replace(/\D/g, '') === n, omzetHariIni);
  await p.click('.seg >> text=Hari ini');

  // 13c. Laporan sebagai file Excel.
  await p.click('#kirimLaporan');
  await p.waitForSelector('#kirimLaporanDialog');
  assert.match(await p.textContent('#namaFileLaporan'), /^Kelola-laporan-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const [unduhan] = await Promise.all([p.waitForEvent('download'), p.click('#simpanLaporan')]);
  const xlsx = require('fs').readFileSync(await unduhan.path());
  assert.equal(xlsx.subarray(0, 2).toString(), 'PK');
  assert.ok(xlsx.includes('xl/media/image1.png'), 'grafik ikut di file');
  assert.ok(xlsx.includes('Ringkasan') && xlsx.includes('Laba bersih'));
  await p.click('#kirimLaporanDialog >> text=Tutup');

  // 13d. Geser jari ke kiri/kanan untuk pindah halaman.
  const geser = (dari, ke) => p.evaluate(([x1, x2]) => {
    const el = document.querySelector('.stats');
    const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(x1)], changedTouches: [t(x1)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(x2)], bubbles: true }));
  }, [dari, ke]);
  await geser(300, 100);
  await p.waitForSelector('nav button[data-go=akun][aria-current=page]');
  await p.click('nav >> text=Laporan');
  await geser(100, 300);
  await p.waitForSelector('nav button[data-go=produk][aria-current=page]');
  await p.click('nav >> text=Laporan');
  await geser(300, 280); // terlalu pendek: tetap di Laporan
  assert.equal(await p.getAttribute('nav button[data-go=laporan]', 'aria-current'), 'page');

  // 14. Foto produk dari galeri: diperkecil, tampil di kasir, ikut ke cloud.
  const gambar = await p.screenshot({ clip: { x: 0, y: 0, width: 800 / 2, height: 300 } });
  await p.click('nav >> text=Produk');
  await p.click('li:has-text("Es kopi") >> text=Ubah');
  await p.setInputFiles('#fotoGaleri', { name: 'kopi.png', mimeType: 'image/png', buffer: gambar });
  await p.waitForSelector('#fotoPratinjau');
  await p.click('#formProduk button.primary');
  const foto = await p.evaluate(() => Kelola.store.list('produk').find((r) => r.data.nama === 'Es kopi').data.foto);
  assert.ok(foto.startsWith('data:image/jpeg') && foto.length < 60000, String(foto.length));
  await p.click('nav >> text=Kasir');
  assert.equal(await p.locator('.tile:has-text("Es kopi") img.foto').count(), 1);
  await p.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan', null, { timeout: 10000 });
  assert.ok([...rows.values()].some((r) => r.data.foto === foto));

  // 15. Tampilan bawaan tetap terang walau HP memakai mode gelap; bisa diganti di Akun.
  await p.emulateMedia({ colorScheme: 'dark' });
  const latar = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(await latar(), 'rgb(242, 245, 250)');
  await p.click('nav >> text=Akun');
  await bukaLipat(p);
  await p.click('#pengaturan >> text=Gelap');
  assert.equal(await latar(), 'rgb(20, 35, 79)');
  await p.click('#pengaturan >> text=Ikuti HP');
  assert.equal(await latar(), 'rgb(20, 35, 79)');
  await p.click('#pengaturan >> text=Terang');
  assert.equal(await latar(), 'rgb(242, 245, 250)');

  // 16. Bahasa Inggris, tetap terpilih setelah dibuka ulang.
  await p.click('#pengaturan >> text=English');
  assert.equal(await p.textContent('#judul'), 'Account');
  await p.reload();
  await p.click('nav >> text=Reports');
  assert.ok(norm(await p.textContent('main')).includes('Net profit'));
  await p.click('nav >> text=Account');
  await bukaLipat(p);
  await p.click('#pengaturan >> text=Bahasa Indonesia');
  assert.equal(await p.textContent('#judul'), 'Akun');

  // 16b. Owner menyimpan gambar QRIS di Akun.
  await p.setInputFiles('[data-qris]', { name: 'qris.png', mimeType: 'image/png', buffer: gambar });
  await p.waitForSelector('#qrisSetel img.qris-gambar');
  // Gambar ini bukan QR sungguhan: nominal otomatis tidak ditawarkan, QRIS biasa tetap dipakai.
  await p.waitForSelector('#qrisNominal[data-terbaca="0"]');
  assert.ok((await p.evaluate(() => Kelola.store.get('profil').data.qris)).startsWith('data:image/jpeg'));

  // 16c. Owner memasang logo sendiri dan memakai warnanya untuk aplikasi.
  await p.setInputFiles('[data-logo]', { name: 'logo.png', mimeType: 'image/png', buffer: gambar });
  await p.waitForFunction(() => document.querySelector('header.nav .logo').src.startsWith('data:image/png'));
  const swatch = p.locator('#merek .swatch:not(.bawaan)').first();
  await swatch.click();
  const warnaLogo = await swatch.getAttribute('data-w');
  assert.ok(await p.evaluate(() => document.querySelector('#temaUsaha').textContent.includes('--navy')));
  assert.equal((await p.evaluate(() => Kelola.store.get('profil').data.warna.utama)), warnaLogo);
  await p.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan', null, { timeout: 10000 });
  assert.ok([...rows.values()].some((r) => r.id === 'profil' && r.data.qris));
  // Struk penjualan memakai logo usaha: gambarnya lebih tinggi karena ada logo di atas.
  await p.click('nav >> text=Laporan');
  await p.evaluate((id) => document.querySelector(`[data-act=struk][data-id="${id}"]`).click(), strukTanpaLogo.id);
  await p.waitForSelector('#strukGambar');
  await p.waitForFunction(() => document.querySelector('#strukGambar').complete);
  assert.equal(await p.evaluate(() => document.querySelector('#strukGambar').naturalHeight), strukTanpaLogo.tinggi + 110);
  await p.click('dialog >> text=Tutup');
  await p.click('nav >> text=Akun');
  await bukaLipat(p);

  // 17. Owner membuat kode undangan staff.
  await p.click('#staff >> text=Buat kode undangan');
  const kode = (await p.textContent('#kodeUndangan .kode')).trim();
  assert.match(kode, /^[A-Z2-9]{6}$/);

  // 18. Staff masuk di HP sendiri dan bergabung dengan kode itu.
  const hpStaff = await device(browser);
  const s = hpStaff.page;
  await s.click('nav >> text=Akun');
  await bukaLipat(s);
  await s.fill('input[name=email]', STAFF.email);
  await s.fill('input[name=password]', 'rahasia123');
  await s.click('#formAuth button');
  await s.waitForSelector('#formGabung');
  await s.fill('#formGabung input[name=kode]', 'SALAH1');
  await s.fill('#formGabung input[name=nama]', 'Budi');
  await s.click('#formGabung button');
  await s.waitForSelector('.msg.err');
  assert.equal(norm(await s.textContent('.msg.err')), 'Kode undangan salah, sudah dipakai, atau sudah kedaluwarsa.');
  await s.fill('#formGabung input[name=kode]', kode.toLowerCase());
  await s.fill('#formGabung input[name=nama]', 'Budi');
  await s.click('#formGabung button');
  await s.waitForSelector('.tile:has-text("Keripik pedas")');
  assert.deepEqual(await s.locator('nav.tabs button:visible').allInnerTexts(), ['Kasir', 'Akun']);
  assert.ok(norm(await s.textContent('.tile:has-text("Keripik pedas")')).includes('Stok 14'));
  const chipStaff = await s.locator('.kat-chips button').allTextContents();
  assert.ok(chipStaff.indexOf('Camilan1') > 0 && chipStaff.indexOf('Camilan1') < chipStaff.indexOf('Minuman1'), 'kategori owner ikut di kasir staff: ' + chipStaff);
  assert.ok(await s.evaluate(() => document.querySelector('header.nav .logo').src.startsWith('data:image/png')), 'logo owner tampil di HP staff');
  assert.ok(await s.evaluate(() => document.querySelector('#temaUsaha').textContent.includes('--navy')), 'warna owner dipakai di HP staff');
  const simpananStaff = await s.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join(''));
  assert.ok(!/"(modal|resep|biayaLain|laba)":/.test(simpananStaff), 'modal tidak sampai ke HP staff');

  // 19. Staff menjual 2 keripik; penjualan terkirim ke owner. QRIS owner bisa ditunjukkan ke pembeli.
  await s.click('.tile:has-text("Keripik pedas")');
  await s.click('#metodeBayar >> text=QRIS');
  await s.click('[data-act=qris]');
  await s.waitForSelector('#qrisKasir img.qris-gambar');
  await s.click('dialog >> text=Tutup');
  assert.equal(await s.locator('#qrisSetel').count(), 0);
  await s.click('.tile:has-text("Keripik pedas")');
  // Pembeli bayar nanti: dicatat sebagai tagihan atas nama Bu Ani.
  await s.click('#metodeBayar >> text=Bayar nanti');
  await s.click('text=Simpan sebagai tagihan');
  assert.equal(penjualan.size, 0, 'tanpa nama pembeli tidak tersimpan');
  await s.fill('#pelangganNama', 'Bu Ani');
  await s.fill('#pelangganWa', '0812 3456 7890');
  await s.click('text=Simpan sebagai tagihan');
  await s.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan', null, { timeout: 10000 });
  assert.equal(penjualan.size, 1);
  assert.ok(norm(await s.textContent('.tile:has-text("Keripik pedas")')).includes('Stok 12'));
  await s.click('#trxTerakhir button');
  await s.waitForSelector('#strukGambar');
  await s.click('dialog >> text=Tutup');
  await s.click('nav >> text=Akun');
  await bukaLipat(s);
  assert.ok(norm(await s.textContent('main')).includes('1 · Rp 22.000'));

  // 20. Owner sinkron: penjualan staff masuk laporan dengan laba, stok terpotong, tidak dobel.
  const jmlTrx = () => p.evaluate(() => Kelola.store.list('transaksi').length);
  const sebelum = await jmlTrx();
  await p.click('text=Sinkronkan sekarang');
  await p.waitForFunction((n) => Kelola.store.list('transaksi').length === n + 1, sebelum, { timeout: 10000 });
  await p.click('text=Sinkronkan sekarang');
  await p.waitForTimeout(500);
  assert.equal(await jmlTrx(), sebelum + 1);
  const trxStaff = await p.evaluate(() => Kelola.store.list('transaksi').find((r) => r.data.staff).data);
  assert.equal(trxStaff.staff, 'Budi');
  assert.equal(trxStaff.total, 22000);
  assert.equal(trxStaff.laba, 22000 - 2 * 6000);
  assert.equal(trxStaff.metode, 'nanti');
  assert.deepEqual(trxStaff.pelanggan, { nama: 'Bu Ani', wa: '0812 3456 7890' });
  await p.click('nav >> text=Laporan');
  await p.click('text=Hari ini');
  assert.ok(norm(await p.textContent('main')).includes('oleh Budi'));
  assert.ok(norm(await p.textContent('li.belum .tanda-belum')).includes('Bu Ani'));

  // 20b. Tagihan belum lunas: kirim lewat WhatsApp, dicicil, lalu lunas.
  assert.ok(norm(await p.textContent('#tagihan')).includes('Bu Ani'));
  await p.click('#tagihan >> text=Tagih via WA');
  await p.waitForSelector('#gambarTagihan');
  const wa = await p.getAttribute('#tagihWa', 'href');
  assert.ok(wa.startsWith('https://wa.me/6281234567890?text='), wa);
  assert.ok(norm(decodeURIComponent(wa)).includes('Nominal:\n22000'), decodeURIComponent(wa));
  await p.click('dialog >> text=Tutup');
  await p.click('#tagihan >> text=Catat bayar');
  await p.fill('#formLunas input[name=jumlah]', '10000');
  await p.click('#formLunas button.primary');
  assert.ok(norm(await p.textContent('#tagihan')).includes('Sisa Rp 12.000'));
  await p.click('#tagihan >> text=Catat bayar');
  await p.click('#formLunas >> text=QRIS');
  await p.click('#formLunas button.primary');
  assert.equal(await p.locator('#tagihan').count(), 0);
  assert.equal(await p.locator('li.belum').count(), 0);
  const lunas = await p.evaluate(() => Kelola.store.list('transaksi').find((r) => r.data.staff).data);
  assert.equal(lunas.lunas, true);
  assert.deepEqual(lunas.dibayar.map((b) => [b.jumlah, b.metode]), [[10000, 'tunai'], [12000, 'qris']]);
  await p.click('nav >> text=Produk');
  assert.ok(norm(await p.textContent('li:has-text("Keripik pedas")')).includes('stok 12'));

  // 20c. Penagihan: rekening di Akun, jatuh tempo di kasir, layar Tagih langsung terbuka,
  // pengingat jatuh tempo dan tanda merah di menu Laporan.
  await p.click('nav >> text=Akun');
  await bukaLipat(p);
  await p.click('#caraBayar >> text=+ Tambah rekening / e-wallet');
  await p.fill('#formRekening input[name=bank]', 'BCA');
  await p.fill('#formRekening input[name=nomor]', '1234 567-890');
  await p.fill('#formRekening input[name=nama]', 'Lius');
  await p.click('#formRekening button.primary');
  assert.deepEqual(await p.evaluate(() => Kelola.store.get('profil').data.rekening.map(({ bank, nomor, nama }) => [bank, nomor, nama])), [['BCA', '1234567890', 'Lius']]);
  assert.ok(norm(await p.textContent('#daftarRekening')).includes('1234567890'));
  await p.click('#caraBayar >> text=H-3');
  assert.deepEqual(await p.evaluate(() => Kelola.store.get('profil').data.tagihan), { jatuhTempo: 7, ingatkan: true, mulai: 3 });
  assert.equal(await p.locator('#pengingat').count(), 0);

  await p.click('nav >> text=Kasir');
  await p.click('.tile:has-text("Keripik pedas")');
  await p.click('#metodeBayar >> text=Bayar nanti');
  assert.ok(norm(await p.textContent('#jatuhTempoKasir')).includes('(7 hari)'));
  assert.equal(await p.textContent('#keranjang + .card [data-act=kosongkan]'), 'Batal');
  await p.click('#jatuhTempoKasir >> text=Ubah');
  await p.click('#formTempo >> text=3 hari');
  await p.click('#formTempo button.primary');
  assert.ok(norm(await p.textContent('#jatuhTempoKasir')).includes('(3 hari)'));
  await p.fill('#pelangganNama', 'Pak Budi');
  await p.fill('#pelangganWa', '0813 1111 2222');
  await p.click('text=Simpan & tagih');
  await p.waitForSelector('#dialogTagih #gambarTagihan');
  assert.ok(norm(await p.textContent('#dialogTagih h3')).includes('Kirim tagihan ke Pak Budi?'));
  const waBaru = decodeURIComponent(await p.getAttribute('#tagihWa', 'href'));
  assert.ok(waBaru.startsWith('https://wa.me/6281311112222?text='), waBaru);
  assert.ok(norm(waBaru).includes('Nomor rekening BCA a.n. Lius:\n1234567890\n\nNominal:\n11000'), waBaru);
  assert.equal(await p.evaluate(() => document.querySelector('#gambarTagihan').naturalWidth), 720);
  await p.click('#dialogTagih >> text=Nanti saja');
  const tglLokal = (n) => p.evaluate((n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, n);
  const tagihBudi = () => p.evaluate(() => Kelola.store.list('transaksi').find((r) => r.data.pelanggan && r.data.pelanggan.nama === 'Pak Budi'));
  assert.equal((await tagihBudi()).data.jatuhTempo, await tglLokal(3));
  // Jatuh tempo 3 hari lagi, diingatkan mulai H-3.
  await p.waitForSelector('#pengingat');
  assert.ok(norm(await p.textContent('#pengingat')).includes('1 tagihan segera jatuh tempo'));
  assert.equal(await p.locator('nav.tabs .tanda-merah').count(), 0);
  // Jatuh tempo diubah ke kemarin: jadi lewat tempo.
  await p.click('#pengingat >> text=Lihat tagihan');
  assert.equal(await p.textContent('#judul'), 'Laporan');
  await p.click('#tagihan li:has-text("Pak Budi") [data-act=ubah-tempo-trx]');
  await p.fill('#formTempo input[name=tanggal]', await tglLokal(-1));
  await p.click('#formTempo button.primary');
  assert.ok(norm(await p.textContent('#tagihan li:has-text("Pak Budi")')).includes('Lewat 1 hari'));
  assert.ok(norm(await p.textContent('#pengingat')).includes('1 tagihan lewat jatuh tempo'));
  assert.equal(await p.textContent('nav.tabs .tanda-merah'), '1');
  await p.click('#pengingat >> text=Nanti');
  assert.equal(await p.locator('#pengingat').count(), 0, '"Nanti" menyembunyikan kartu sampai besok');
  assert.equal(await p.textContent('nav.tabs .tanda-merah'), '1');
  // Batalkan lagi supaya langkah berikutnya tidak berubah (stok kembali).
  const idBudi = (await tagihBudi()).id;
  await p.click(`[data-act=batal-trx][data-id="${idBudi}"]`);
  await p.waitForFunction(() => !Kelola.store.list('transaksi').some((r) => r.data.pelanggan && r.data.pelanggan.nama === 'Pak Budi'));
  assert.equal(await p.locator('nav.tabs .tanda-merah').count(), 0);

  // 21. Owner menghapus staff: akun itu tidak bisa memakai kasir lagi.
  await p.click('nav >> text=Akun');
  await bukaLipat(p);
  await p.waitForSelector('#staff li:has-text("Budi")');
  await p.click('#staff li:has-text("Budi") >> text=Hapus');
  await p.waitForSelector('#staff >> text=Belum ada staff.');
  await s.click('text=Sinkronkan sekarang');
  await s.waitForSelector('.msg.err');
  assert.equal(norm(await s.textContent('.msg.err')), 'Akun ini sudah tidak terdaftar sebagai staff. Hubungi owner.');

  // 22. Mode kasir dengan PIN di HP bersama.
  await p.fill('#formKunci input[name=pin]', '1234');
  await p.click('#formKunci button');
  await p.waitForSelector('.tile');
  assert.deepEqual(await p.locator('nav.tabs button:visible').allInnerTexts(), ['Kasir', 'Akun']);
  await p.reload();
  await p.waitForSelector('.tile');
  assert.deepEqual(await p.locator('nav.tabs button:visible').allInnerTexts(), ['Kasir', 'Akun']);
  await p.click('nav >> text=Akun');
  await bukaLipat(p);
  await p.fill('#formBukaKunci input[name=pin]', '9999');
  await p.click('#formBukaKunci button');
  await p.waitForSelector('.msg.err');
  assert.equal(norm(await p.textContent('.msg.err')), 'PIN salah.');
  await p.fill('#formBukaKunci input[name=pin]', '1234');
  await p.click('#formBukaKunci button');
  await p.waitForSelector('#formKunci');
  assert.equal(await p.locator('nav.tabs button:visible').count(), 4);

  // 23. Layar awal saat aplikasi dibuka lagi: owner wajib kata sandi, kasir langsung terbuka.
  const p2 = await tab(hp.ctx, hp.errors);
  await p2.waitForSelector('#gerbang');
  assert.ok(norm(await p2.textContent('#versiGerbang')).startsWith('Kelola · Ver 1.'));
  await p2.click('#gerbang [data-g=owner]');
  assert.equal(await p2.inputValue('#formGerbang input[name=email]'), USER.email);
  assert.equal(await p2.locator('[data-act=tanpa-akun]').count(), 0, 'HP dengan akun tidak bisa dibuka tanpa kata sandi');
  await p2.fill('#formGerbang input[name=password]', 'salah1');
  await p2.click('#formGerbang button');
  await p2.waitForSelector('#gerbang .msg.err');
  assert.equal(norm(await p2.textContent('#gerbang .msg.err')), 'Email atau kata sandi salah.');
  await p2.fill('#formGerbang input[name=password]', 'rahasia123');
  await p2.click('#formGerbang button');
  await p2.waitForSelector('nav.tabs');
  assert.equal(await p2.textContent('#subjudul .peran'), 'OWNER');
  assert.equal(await p2.locator('nav.tabs button:visible').count(), 4);
  await p2.click('nav >> text=Akun');
  await p2.click('#modeSaatIni >> text=Ganti mode');
  await p2.click('#gerbang [data-act=pilih-kasir]');
  await p2.waitForSelector('.tile');
  assert.equal(await p2.textContent('#subjudul .peran'), 'KASIR');
  assert.deepEqual(await p2.locator('nav.tabs button:visible').allInnerTexts(), ['Kasir', 'Akun']);
  await p2.reload();
  await p2.waitForSelector('.tile');
  assert.equal(await p2.textContent('#subjudul .peran'), 'KASIR', 'mode tetap setelah muat ulang');
  await p2.click('nav >> text=Akun');
  await p2.click('#modeSaatIni >> text=Ganti mode');
  // Offline: kata sandi dicek dengan catatan di HP ini.
  await hp.ctx.setOffline(true);
  await p2.click('#gerbang [data-g=owner]');
  await p2.fill('#formGerbang input[name=password]', 'rahasia123');
  await p2.click('#formGerbang button');
  await p2.waitForSelector('nav.tabs');
  assert.equal(await p2.textContent('#subjudul .peran'), 'OWNER');
  await hp.ctx.setOffline(false);

  // 23b. Face ID / sidik jari sebagai pengganti kata sandi owner (authenticator tiruan Chromium).
  const cdp = await hp.ctx.newCDPSession(p2);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await p2.reload();
  await p2.waitForSelector('nav.tabs');
  await p2.click('nav >> text=Akun');
  await bukaLipat(p2);
  await p2.click('#faceId [data-act=faceid-aktifkan]');
  await p2.waitForSelector('#faceId .msg.ok');
  assert.ok(norm(await p2.textContent('#faceId')).includes('Aktif di HP ini'));
  await p2.click('#modeSaatIni >> text=Ganti mode');
  assert.ok(norm(await p2.textContent('#gerbang')).includes('Masuk dengan Face ID / sidik jari'));
  await p2.click('#gerbang [data-act=owner-faceid]');
  await p2.waitForSelector('nav.tabs');
  assert.equal(await p2.textContent('#subjudul .peran'), 'OWNER');
  // Wajah tidak cocok: kembali ke isian kata sandi.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await p2.click('nav >> text=Akun');
  await p2.click('#modeSaatIni >> text=Ganti mode');
  await p2.click('#gerbang [data-act=owner-faceid]');
  await p2.waitForSelector('#formGerbang');
  assert.ok(norm(await p2.textContent('#gerbang .msg.err')).includes('Face ID / sidik jari tidak berhasil'));
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
  await p2.click('#gerbang .btn-faceid');
  await p2.waitForSelector('nav.tabs');
  // Matikan: owner kembali memakai kata sandi.
  await p2.click('nav >> text=Akun');
  await bukaLipat(p2);
  await p2.click('#faceId [data-act=faceid-matikan]');
  await p2.waitForSelector('#faceId [data-act=faceid-aktifkan]');
  await p2.click('#modeSaatIni >> text=Ganti mode');
  assert.equal(await p2.locator('#gerbang [data-act=owner-faceid]').count(), 0);
  await p2.click('#gerbang [data-g=owner]');
  await p2.fill('#formGerbang input[name=password]', 'rahasia123');
  await p2.click('#formGerbang button');
  await p2.waitForSelector('nav.tabs');

  // 25. Ganti akun di HP yang sama: data tiap akun terpisah.
  // Tab lain di HP yang sama dimuat ulang setiap data berubah; tutup supaya tidak mengganggu.
  await p.close();
  await p2.click('nav >> text=Akun');
  await bukaLipat(p2);
  // Face ID aktif untuk akun pertama: nanti bisa kembali ke akun ini tanpa kata sandi.
  await p2.click('#faceId [data-act=faceid-aktifkan]');
  await p2.waitForSelector('#faceId .msg.ok');
  assert.ok(norm(await p2.textContent('#akunHp')).includes(USER.email));
  await p2.click('#akunHp >> text=+ Tambah akun lain');
  await p2.waitForSelector('#formGantiAkun');
  await p2.fill('#formGantiAkun input[name=email]', SARI.email);
  await p2.fill('#formGantiAkun input[name=password]', 'salah1');
  await p2.click('#formGantiAkun button');
  await p2.waitForSelector('#gerbang .msg.err');
  await p2.fill('#formGantiAkun input[name=password]', 'rahasia123');
  await p2.click('#formGantiAkun button');
  await p2.waitForSelector('nav.tabs');
  // Baru masuk dengan kata sandi: Face ID ditawarkan untuk akun ini.
  await p2.waitForSelector('#tawarFaceId');
  await p2.click('#tawarFaceId [data-act=faceid-nanti]');
  assert.equal(await p2.locator('#tawarFaceId').count(), 0);
  await p2.click('nav >> text=Produk');
  await p2.waitForSelector('text=Belum ada produk');
  await p2.click('nav >> text=Akun');
  await bukaLipat(p2);
  await p2.fill('#namaUsahaInput', 'Kedai Sari');
  await p2.click('[data-act=simpan-profil]');
  await p2.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan', null, { timeout: 10000 });
  const profilSari = [...rows.values()].find((r) => r.kind === 'profil' && r.user_id === SARI.id);
  assert.equal(profilSari && profilSari.data.namaUsaha, 'Kedai Sari');
  assert.ok(![...rows.values()].some((r) => r.user_id === SARI.id && r.kind === 'produk'), 'produk akun lain tidak ikut');
  // Kembali ke akun pertama: produknya muncul lagi.
  assert.ok(norm(await p2.textContent('#akunHp')).includes('Kedai Sari'));
  assert.ok(norm(await p2.textContent(`#akunHp li:has-text("${USER.email}")`)).includes('Face ID'));
  // Wajah tidak cocok: isian kata sandi akun itu yang tampil, akun Sari tetap aktif.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await p2.click(`#akunHp li:has-text("${USER.email}") >> text=Pindah`);
  await p2.waitForSelector('#formGantiAkun');
  assert.equal(await p2.inputValue('#formGantiAkun input[name=email]'), USER.email);
  assert.ok(norm(await p2.textContent('#gerbang .msg.err')).includes('Face ID / sidik jari tidak berhasil'));
  assert.equal(await p2.evaluate(() => Kelola.cloud.user.email), SARI.email);
  // Coba lagi dari daftar akun, kali ini wajah cocok.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
  await p2.click('#gerbang >> text=Kembali ke daftar akun');
  await p2.click(`.akun-pilih button:has-text("${USER.email}")`);
  await p2.waitForFunction((e) => Kelola.cloud.user && Kelola.cloud.user.email === e, USER.email);
  await p2.waitForSelector('nav.tabs');
  assert.equal(await p2.textContent('#subjudul .peran'), 'OWNER');
  await p2.click('nav >> text=Produk');
  await p2.waitForSelector('text=Keripik pedas');
  // Sesi yang sudah dipakai tidak disimpan lagi.
  assert.ok(!(await p2.evaluate((id) => (JSON.parse(localStorage.getItem('kelola:faceid'))[id] || {}).sesi, USER.id)));
  assert.ok(log.some((l) => l.startsWith('POST /auth/v1/token?grant_type=refresh_token')), 'pindah akun memakai sesi tersimpan, bukan kata sandi');
  // Layar awal menampilkan akun aktif dan daftar akun.
  await p2.close();
  const p3 = await tab(hp.ctx, hp.errors);
  await p3.waitForSelector('#akunChip');
  assert.ok(norm(await p3.textContent('#akunChip')).includes(USER.email));
  await p3.click('#akunChip >> text=Ganti akun');
  const daftar = norm(await p3.textContent('.akun-pilih'));
  assert.ok(daftar.includes('Kedai Sari') && daftar.includes(USER.email), daftar);

  // 24. HP baru: bahasa bawaan English; Kasir di HP kosong meminta akun staff.
  const baru = await device(browser, true);
  const n = baru.page;
  await n.waitForSelector('#gerbang');
  const teksAwal = norm(await n.textContent('#gerbang'));
  assert.ok(teksAwal.includes('Open as') && teksAwal.includes('Cashier / Staff'), teksAwal);
  await n.click('#gerbang [data-act=pilih-kasir]');
  await n.waitForSelector('#formGerbang[data-tujuan=kasir]');
  await n.click('text=Back to choose mode');
  await n.click('#gerbang >> text=Sign up');
  await n.fill('#formDaftar input[name=email]', 'baru@contoh.id');
  await n.fill('#formDaftar input[name=password]', 'rahasia123');
  await n.fill('#formDaftar input[name=ulang]', 'rahasia124');
  await n.click('#formDaftar button');
  assert.equal(norm(await n.textContent('#gerbang .msg.err')), 'The passwords do not match.');

  // 25. Varian dan tambahan: diatur di form produk, dipilih di kasir, tercatat di penjualan dan struk.
  const hpVarian = await device(browser);
  const v = hpVarian.page;
  await v.click('text=Tambah produk pertama');
  await v.fill('input[name=nama]', 'Es kopi susu');
  await v.fill('input[name=modal]', '7000');
  await v.fill('input[name=harga]', '18000');
  await v.fill('input[name=stok]', '5');
  await v.click('[data-act=varian-saklar][data-v="1"]');
  await v.click('[data-act=varian-contoh][data-k=ukuran]');
  assert.deepEqual(await v.locator('.varian-grup >> nth=0 >> input[name=vpn]').evaluateAll((els) => els.map((e) => e.value)), ['Reguler', 'Besar']);
  await v.fill('.varian-grup >> nth=0 >> input[name=vph] >> nth=1', '5000');
  await v.click('[data-act=varian-grup-baru]');
  await v.fill('.varian-grup >> nth=1 >> input[name=vn]', 'Tambahan');
  await v.click('.varian-grup >> nth=1 >> [data-act=varian-jenis][data-b="1"]');
  await v.fill('.varian-grup >> nth=1 >> input[name=vpn] >> nth=0', 'Extra shot');
  await v.fill('.varian-grup >> nth=1 >> input[name=vph] >> nth=0', '4000');
  await v.fill('.varian-grup >> nth=1 >> input[name=vpn] >> nth=1', 'Boba');
  await v.fill('.varian-grup >> nth=1 >> input[name=vph] >> nth=1', '3000');
  assert.ok(norm(await v.textContent('#hargaVarian')).includes('Besar Rp 23.000'), await v.textContent('#hargaVarian'));
  await v.click('#formProduk button.primary');
  await v.click('nav >> text=Produk');
  assert.ok(norm(await v.textContent('main .list')).includes('2 varian'));
  // Produk kedua tanpa varian menyalin varian dari produk pertama, lalu dimatikan lagi.
  await v.click('text=+ Tambah produk');
  await v.fill('input[name=nama]', 'Air mineral');
  await v.fill('input[name=modal]', '2000');
  await v.fill('input[name=harga]', '5000');
  await v.click('[data-act=varian-saklar][data-v="1"]');
  await v.selectOption('select[name=salinVarian]', { index: 1 });
  assert.equal(await v.locator('.varian-grup').count(), 2);
  await v.click('[data-act=varian-saklar][data-v=""]');
  await v.click('#formProduk button.primary');
  const produkVarian = await v.evaluate(() => Kelola.store.list('produk').map((r) => ({ nama: r.data.nama, varian: r.data.varian })));
  assert.equal(produkVarian.find((x) => x.nama === 'Air mineral').varian, undefined);
  assert.deepEqual(produkVarian.find((x) => x.nama === 'Es kopi susu').varian.map((g) => [g.nama, g.banyak, g.pilihan.map((o) => o.harga)]),
    [['Ukuran', false, [0, 5000]], ['Tambahan', true, [4000, 3000]]]);
  // Kasir: produk tanpa varian langsung masuk keranjang, produk bervarian membuka pilihan.
  await v.click('nav >> text=Kasir');
  await v.click('.tile:has-text("Air mineral")');
  assert.equal(await v.locator('#formVarian').count(), 0);
  await v.click('.tile:has-text("Es kopi susu")');
  await v.waitForSelector('#formVarian');
  assert.equal(norm(await v.textContent('#varianTambah')), 'Tambah · Rp 18.000');
  await v.click('#formVarian .opsi:has-text("Besar")');
  await v.click('#formVarian .opsi:has-text("Extra shot")');
  await v.fill('#formVarian input[name=catatan]', 'Es sedikit');
  await v.click('[data-act=varian-qty][data-n="1"]');
  assert.equal(norm(await v.textContent('#varianTambah')), 'Tambah · Rp 54.000');
  await v.click('#varianTambah');
  // Pesanan biasa: dua ketukan (produk, lalu Tambah) memakai pilihan paling atas.
  await v.click('.tile:has-text("Es kopi susu")');
  await v.click('#varianTambah');
  const keranjang = norm(await v.textContent('#keranjang + .card'));
  assert.ok(keranjang.includes('Besar, Extra shot') && keranjang.includes('Es sedikit') && keranjang.includes('Reguler'), keranjang);
  assert.ok(keranjang.includes('Rp 77.000'), keranjang);
  assert.equal(norm(await v.textContent('.tile:has-text("Es kopi susu") .jumlah')), '3');
  // Stok 5: sudah 3 di keranjang, minta 3 lagi ditolak.
  await v.click('.tile:has-text("Es kopi susu")');
  await v.click('[data-act=varian-qty][data-n="1"]');
  await v.click('[data-act=varian-qty][data-n="1"]');
  await v.click('#varianTambah');
  await v.waitForSelector('#toast.show');
  assert.equal(norm(await v.textContent('#toast')), 'Stok tidak cukup');
  await v.click('#formVarian >> text=Tutup');
  await v.click('text=Simpan penjualan');
  const trxVarian = await v.evaluate(() => Kelola.store.list('transaksi')[0].data);
  assert.equal(trxVarian.total, 77000);
  assert.equal(trxVarian.laba, 77000 - 3 * 7000 - 2000);
  const besar = trxVarian.items.find((i) => i.varian === 'Besar, Extra shot');
  assert.deepEqual([besar.qty, besar.harga, besar.catatan], [2, 27000, 'Es sedikit']);
  assert.equal(await v.evaluate(() => Kelola.store.list('produk').find((r) => r.data.nama === 'Es kopi susu').data.stok), 2);
  await v.click('#trxTerakhir button');
  await v.waitForSelector('img.struk');
  const teksStruk = await v.evaluate(() => Kelola.ui.struk.teks);
  assert.ok(teksStruk.includes('Es kopi susu (Besar, Extra shot)') && teksStruk.includes('(Es sedikit)'), teksStruk);

  // 26. QRIS dengan nominal: kode QRIS toko dibaca dari gambar, QR di kasir dan tagihan membawa nominal.
  const qrisToko = await v.evaluate(() => {
    const tlv = (tag, nilai) => tag + String(nilai.length).padStart(2, '0') + nilai;
    const badan = tlv('00', '01') + tlv('01', '11') + tlv('26', tlv('00', 'ID.CO.CONTOH.WWW') + tlv('01', '936000000000000001') + tlv('03', 'UMI'))
      + tlv('52', '5812') + tlv('53', '360') + tlv('58', 'ID') + tlv('59', 'KOPI SENJA') + tlv('60', 'JAKARTA') + '6304';
    const kode = badan + KelolaQris.crc16(badan);
    const qr = qrcode(0, 'M'); qr.addData(kode); qr.make();
    const n = qr.getModuleCount();
    // Seperti gambar QRIS dari bank: QR di tengah bingkai dengan tulisan, disimpan sebagai JPEG.
    const c = document.createElement('canvas'); c.width = 700; c.height = 900;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 700, 900);
    ctx.fillStyle = '#c8102e'; ctx.fillRect(0, 0, 700, 110); ctx.fillStyle = '#000'; ctx.font = '700 40px sans-serif'; ctx.fillText('KOPI SENJA', 60, 190);
    const px = Math.floor(560 / n);
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) ctx.fillRect(70 + k * px, 250 + r * px, px, px);
    Kelola.store.put('profil', Object.assign({}, Kelola.store.get('profil') ? Kelola.store.get('profil').data : {}, { qris: c.toDataURL('image/jpeg', 0.9) }), 'profil');
    return kode;
  });
  await v.click('dialog >> text=Tutup');
  await v.click('nav >> text=Akun');
  await bukaLipat(v);
  await v.waitForSelector('#qrisNominal[data-terbaca="1"]');
  assert.ok(norm(await v.textContent('#qrisNominal')).includes('QRIS KOPI SENJA terbaca'));
  const bacaGambarQr = (sel) => v.evaluate(async (sel) => {
    const img = document.querySelector(sel);
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const h = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    return h ? h.data : '';
  }, sel);
  await v.click('nav >> text=Kasir');
  await v.click('.tile:has-text("Air mineral")');
  await v.click('.tile:has-text("Air mineral")');
  await v.click('#metodeBayar >> text=QRIS');
  await v.click('[data-act=qris]');
  await v.waitForSelector('#qrisGambar[data-terisi="10000"]');
  assert.ok(norm(await v.textContent('#qrisTerisi')).includes('Nominal Rp 10.000 sudah terisi'));
  const kodeKasir = await bacaGambarQr('#qrisGambar');
  assert.ok(await v.evaluate((k) => KelolaQris.sah(k), kodeKasir), 'QR bernominal sah: ' + kodeKasir);
  assert.deepEqual(await v.evaluate((k) => ['01', '54', '59'].map((t) => KelolaQris.ambil(k, t)), kodeKasir), ['12', '10000', 'KOPI SENJA']);
  assert.equal(await v.evaluate(([k, asal]) => KelolaQris.ambil(k, '26') === KelolaQris.ambil(asal, '26'), [kodeKasir, qrisToko]), true, 'tujuan bayar tidak berubah');
  // Aplikasi pembeli menolak: kembali ke gambar QRIS biasa.
  await v.click('[data-act=qris-polos]');
  await v.waitForSelector('#qrisGambar[data-terisi=""]');
  assert.ok((await v.getAttribute('#qrisGambar', 'src')).startsWith('data:image/jpeg'));
  await v.click('#qrisKasir >> text=Tutup');
  // Tagihan: QR di gambar tagihan membawa sisa tagihan.
  await v.click('#metodeBayar >> text=Bayar nanti');
  await v.fill('#pelangganNama', 'Bu Rina');
  await v.click('text=Simpan & tagih');
  await v.waitForSelector('#dialogTagih #gambarTagihan');
  const kodeTagihan = await bacaGambarQr('#gambarTagihan');
  assert.equal(await v.evaluate((k) => (KelolaQris.sah(k) ? KelolaQris.ambil(k, '54') : 'tidak sah'), kodeTagihan), '10000');
  await v.click('#dialogTagih >> text=Nanti saja');
  // Dimatikan di Akun: kasir memakai gambar QRIS biasa.
  await v.click('nav >> text=Akun');
  await bukaLipat(v);
  await v.click('[data-act=setel-qris-nominal][data-v=""]');
  assert.equal(await v.evaluate(() => Kelola.store.get('profil').data.qrisNominal), false);
  await v.click('nav >> text=Kasir');
  await v.click('.tile:has-text("Air mineral")');
  await v.click('#metodeBayar >> text=QRIS');
  await v.click('[data-act=qris]');
  await v.waitForSelector('#qrisGambar[data-terisi=""]');
  assert.equal(await v.locator('#qrisTerisi').count(), 0);

  // 27. QRIS Midtrans: owner menghubungkan Midtrans; kasir owner dan staff lunas otomatis; tagihan membawa link bayar.
  const hpOwner = await device(browser);
  const o = hpOwner.page;
  await o.click('nav >> text=Akun');
  await bukaLipat(o);
  await o.fill('input[name=email]', USER.email);
  await o.fill('input[name=password]', 'rahasia123');
  await o.click('#formAuth button');
  await o.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan');
  await bukaLipat(o);
  await o.waitForSelector('#midtransSetel [data-act=midtrans-hubungkan]');
  await o.click('#midtransSetel [data-act=midtrans-hubungkan]');
  await o.fill('#midtransKunci', 'Mid-client-abcdefghijk');
  await o.click('#formMidtrans button[type=submit]');
  await o.waitForSelector('#midtransMsg .msg.err');
  assert.ok(norm(await o.textContent('#midtransMsg')).includes('bukan Client Key'));
  await o.fill('#midtransKunci', 'SB-Mid-server-eV9.abcdefghijk');
  await o.click('#formMidtrans button[type=submit]');
  await o.waitForSelector('#midtransTerhubung');
  assert.ok(norm(await o.textContent('#midtransTerhubung')).includes('Sandbox'));
  assert.equal(midKunci.get(USER.id).kunci, 'SB-Mid-server-eV9.abcdefghijk');
  // Kunci tidak disimpan di HP.
  assert.ok(!(await o.evaluate(() => JSON.stringify(localStorage))).includes('Mid-server'));
  const tileBiasa = '.tile:not(:has-text("Ada pilihan")) >> nth=0';
  const jumlahTrx = (pg) => pg.evaluate(() => Kelola.store.list('transaksi').length);
  // Kasir owner: QR Midtrans, lalu pembeli membayar.
  await o.click('nav >> text=Kasir');
  await o.click(tileBiasa);
  await o.click('#metodeBayar >> text=QRIS');
  await o.click('[data-act=qris]');
  await o.waitForSelector('#qrisKasir[data-midtrans] #qrisStatus');
  const order1 = await o.getAttribute('#qrisKasir', 'data-midtrans');
  assert.equal(midBayar.get(order1).owner, USER.id);
  assert.equal(await o.inputValue('#qrisLinkUji'), 'https://api.sandbox.midtrans.com/v2/qris/' + order1 + '/qr-code');
  const trxAwal = await jumlahTrx(o);
  midBayar.get(order1).status = 'lunas';
  await o.waitForSelector('#bayarDiterima', { timeout: 10000 });
  assert.ok(norm(await o.textContent('#bayarDiterima')).includes('QRIS · GoPay'));
  assert.equal(await jumlahTrx(o), trxAwal + 1);
  const trxMid = await o.evaluate((o) => Kelola.store.list('transaksi').find((r) => r.data.midtrans === o), order1);
  assert.ok(trxMid && trxMid.data.metode === 'qris', 'penjualan tersimpan sebagai QRIS');
  await o.click('#bayarDiterima >> text=Penjualan baru');
  // Kasir menutup QR sebelum dibayar: QR dibatalkan, tidak ada penjualan.
  await o.click(tileBiasa);
  await o.click('#metodeBayar >> text=QRIS');
  await o.click('[data-act=qris]');
  await o.waitForSelector('#qrisKasir[data-midtrans] #qrisStatus');
  const order2 = await o.getAttribute('#qrisKasir', 'data-midtrans');
  await o.click('#qrisKasir >> text=Batalkan');
  for (let i = 0; i < 50 && midBayar.get(order2).status !== 'batal'; i++) await o.waitForTimeout(100);
  assert.equal(midBayar.get(order2).status, 'batal');
  assert.equal(await jumlahTrx(o), trxAwal + 1);
  // Kasir staff memakai Midtrans milik owner.
  await s.bringToFront();
  await s.click('nav >> text=Kasir');
  // Uji sebelumnya mengeluarkan Budi dari staff; daftarkan lagi sebagai staff owner ini.
  if (!staff.some((x) => x.staff_id === STAFF.id)) staff.push({ staff_id: STAFF.id, owner_id: USER.id, nama: 'Budi', created_at: new Date().toISOString() });
  // Status Midtrans di HP staff diperiksa lagi setelah beberapa saat.
  await s.evaluate(() => { if (Kelola.ui.midtrans) Kelola.ui.midtrans.waktu = 0; });
  await s.click(tileBiasa);
  await s.click('#metodeBayar >> text=QRIS');
  await s.waitForSelector('text=QRIS Midtrans: penjualan tersimpan otomatis');
  await s.click('[data-act=qris]');
  await s.waitForSelector('#qrisKasir[data-midtrans] #qrisStatus');
  const order3 = await s.getAttribute('#qrisKasir', 'data-midtrans');
  assert.equal(midBayar.get(order3).owner, USER.id, 'QR dibuat dengan Midtrans owner');
  midBayar.get(order3).status = 'lunas';
  await s.waitForSelector('#bayarDiterima', { timeout: 10000 });
  await s.click('#bayarDiterima >> text=Penjualan baru');
  // Tagihan: pesan WA membawa link bayar Midtrans; pembayaran lewat link melunasi tagihan.
  await o.bringToFront();
  await o.click(tileBiasa);
  await o.click('#metodeBayar >> text=Bayar nanti');
  await o.fill('#pelangganNama', 'Pak Joko');
  await o.click('text=Simpan & tagih');
  await o.waitForSelector('#dialogTagih .pesan-wa');
  const pesanWa = await o.textContent('#dialogTagih .pesan-wa');
  const linkBayar = pesanWa.match(/https:\/\/app\.sandbox\.midtrans\.com\/\S+/);
  assert.ok(linkBayar && pesanWa.includes('Bayar online'), pesanWa);
  await o.click('#dialogTagih >> text=Nanti saja');
  const order4 = linkBayar[0].split('/').pop();
  const joko = await o.evaluate(() => Kelola.store.list('transaksi').find((r) => r.data.pelanggan && r.data.pelanggan.nama === 'Pak Joko'));
  assert.equal(midBayar.get(order4).ref, joko.id);
  assert.equal(midBayar.get(order4).jumlah, joko.data.total);
  midBayar.get(order4).status = 'lunas';
  await o.click('nav >> text=Akun');
  await bukaLipat(o);
  await o.click('[data-act=sinkron]');
  await o.waitForFunction((id) => { const r = Kelola.store.get(id); return r && r.data.lunas; }, joko.id, { timeout: 10000 });
  const bayarJoko = await o.evaluate((id) => Kelola.store.get(id).data.dibayar, joko.id);
  assert.deepEqual(bayarJoko.map((b) => [b.metode, b.midtrans]), [['qris', order4]]);
  // Dimatikan: kasir kembali ke QRIS biasa.
  await o.click('#midtransSetel [data-act=midtrans-aktif][data-v=""]');
  await o.waitForFunction(() => Kelola.ui.midtrans && Kelola.ui.midtrans.aktif === false);
  assert.equal(midKunci.get(USER.id).aktif, false);
  // Versi aplikasi tampil di Akun -> Pengaturan dan di layar awal.
  const versi = await o.evaluate(() => window.KELOLA_VERSI);
  assert.match(versi, /^1\.\d{3}$/);
  assert.equal(norm(await o.textContent('#tentang')), 'Tentang KelolaVersi ' + versi);

  assert.deepEqual(hp.errors.concat(laptop.errors, hpStaff.errors, baru.errors, hpVarian.errors, hpOwner.errors), []);
  await browser.close();
  console.log('E2E OK');
})().catch((e) => { console.error(e); console.error(log.slice(-15).join('\n')); process.exit(1); });
