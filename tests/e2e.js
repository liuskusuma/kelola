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
const USERS = [USER, STAFF];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtUntuk = (u) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: u.id, email: u.email, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', aud: 'authenticated' }) + '.sig';
// Tabel staff tiruan (lihat supabase/staff.sql).
const staff = [];
const undangan = new Map();
const penjualan = new Map();
const log = [];
const norm = (s) => s.replace(/\u00a0/g, ' ');
// Bagian di halaman Akun bisa dibuka-tutup; buka semuanya supaya isiannya bisa diklik.
const bukaLipat = (page) => page.evaluate(() => {
  ['profil', 'qris', 'pengaturan', 'cloud', 'staff', 'kunci', 'gabung'].forEach((k) => { Kelola.ui.lipat[k] = true; });
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
    const user = USERS.find((u) => u.email === body.email);
    if (!user || body.password !== 'rahasia123') return route.fulfill({ status: 400, headers: cors, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials', message: 'Invalid login credentials' }) });
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ access_token: jwtUntuk(user), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user }) });
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
      usaha: { namaUsaha: prof ? prof.data.namaUsaha : null, kontak: prof ? prof.data.kontak : null, qris: prof ? prof.data.qris || null : null },
      produk: milik.filter((r) => r.kind === 'produk').map((r) => ({
        id: r.id, nama: r.data.nama, harga: r.data.harga, satuan: r.data.satuan, foto: r.data.foto, mode: r.data.mode, paket: r.data.paket,
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
  return route.fulfill({ status: 404, headers: cors, body: '{}' });
}

async function device(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.route(SB + '/**', mock);
  await ctx.route(BASE + 'js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.KELOLA_CONFIG={supabaseUrl:'${SB}',supabaseAnonKey:'anon'};` }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE);
  return { ctx, page, errors };
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
  await l.waitForSelector('#formAuth');
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

  // 11. Jual es kopi ×2 dan paket ×1: stok gula & keripik berkurang, struk bisa dibuat.
  await p.click('nav >> text=Kasir');
  await p.click('.tile:has-text("Es kopi")');
  await p.click('.tile:has-text("Es kopi")');
  await p.click('.tile:has-text("Paket ngopi")');
  await p.click('text=Simpan penjualan');
  await p.click('#trxTerakhir button');
  await p.waitForSelector('#strukGambar');
  assert.ok(await p.evaluate(() => document.querySelector('#strukGambar').naturalWidth === 600 || new Promise((ok) => document.querySelector('#strukGambar').onload = () => ok(true))));
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
  assert.ok((await p.evaluate(() => Kelola.store.get('profil').data.qris)).startsWith('data:image/jpeg'));
  await p.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan', null, { timeout: 10000 });
  assert.ok([...rows.values()].some((r) => r.id === 'profil' && r.data.qris));

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
  const simpananStaff = await s.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join(''));
  assert.ok(!/"(modal|resep|biayaLain|laba)":/.test(simpananStaff), 'modal tidak sampai ke HP staff');

  // 19. Staff menjual 2 keripik; penjualan terkirim ke owner. QRIS owner bisa ditunjukkan ke pembeli.
  await s.click('.tile:has-text("Keripik pedas")');
  await s.click('[data-act=qris]');
  await s.waitForSelector('#qrisKasir img.qris-gambar');
  await s.click('dialog >> text=Tutup');
  assert.equal(await s.locator('#qrisSetel').count(), 0);
  await s.click('.tile:has-text("Keripik pedas")');
  await s.click('text=Simpan penjualan');
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
  await p.click('nav >> text=Laporan');
  await p.click('text=Hari ini');
  assert.ok(norm(await p.textContent('main')).includes('oleh Budi'));
  await p.click('nav >> text=Produk');
  assert.ok(norm(await p.textContent('li:has-text("Keripik pedas")')).includes('stok 12'));

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

  assert.deepEqual(hp.errors.concat(laptop.errors, hpStaff.errors), []);
  await browser.close();
  console.log('E2E OK');
})().catch((e) => { console.error(e); console.error(log.slice(-15).join('\n')); process.exit(1); });
