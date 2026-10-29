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
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: USER.id, email: USER.email, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', aud: 'authenticated' }) + '.sig';
const log = [];
const norm = (s) => s.replace(/\u00a0/g, ' ');

async function mock(route) {
  const req = route.request();
  const url = new URL(req.url());
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  log.push(req.method() + ' ' + url.pathname + url.search);
  if (url.pathname === '/auth/v1/token') {
    const body = JSON.parse(req.postData());
    if (body.password !== 'rahasia123') return route.fulfill({ status: 400, headers: cors, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials', message: 'Invalid login credentials' }) });
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: USER }) });
  }
  if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });
  if (url.pathname === '/rest/v1/records' && req.method() === 'GET') {
    const gte = url.searchParams.get('server_updated_at');
    const since = gte ? Date.parse(gte.replace('gte.', '')) : 0;
    const limit = +url.searchParams.get('limit') || 1000;
    const out = [...rows.values()].filter((r) => Date.parse(r.server_updated_at) >= since)
      .sort((a, b) => Date.parse(a.server_updated_at) - Date.parse(b.server_updated_at)).slice(0, limit)
      .map(({ user_id, ...r }) => r);
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(out) });
  }
  if (url.pathname === '/rest/v1/records' && req.method() === 'POST') {
    assert.equal(url.searchParams.get('on_conflict'), 'user_id,id');
    const body = JSON.parse(req.postData());
    (Array.isArray(body) ? body : [body]).forEach((r) => {
      assert.equal(r.user_id, USER.id);
      const old = rows.get(r.id);
      if (old && Date.parse(r.updated_at) < Date.parse(old.updated_at)) return;
      clock += 10;
      rows.set(r.id, { ...r, server_updated_at: new Date(clock).toISOString() });
    });
    return route.fulfill({ status: 201, headers: cors, body: '' });
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
  assert.equal(norm(await p.textContent('#saran')), 'Rp 10.000');
  await p.click('text=Pakai harga ini');
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
  assert.equal(norm(await p.textContent('#syncBadge')), 'Hanya di perangkat ini');

  // 3. Login: kata sandi salah, lalu benar. Data lokal terkirim ke cloud.
  await p.click('nav >> text=Akun');
  await p.fill('input[name=email]', USER.email);
  await p.fill('input[name=password]', 'salah1');
  await p.click('#formAuth button');
  await p.waitForSelector('.msg.err', { timeout: 5000 });
  assert.equal(norm(await p.textContent('.msg.err')), 'Email atau kata sandi salah.');
  assert.equal(await p.inputValue('input[name=email]'), USER.email);
  await p.fill('input[name=password]', 'rahasia123');
  await p.click('#formAuth button');
  await p.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan di cloud', null, { timeout: 5000 });
  assert.equal(rows.size, 2, 'produk + transaksi ada di cloud');

  // 4. Perangkat kedua login dan melihat data yang sama.
  const laptop = await device(browser);
  const l = laptop.page;
  await l.click('nav >> text=Akun');
  await l.fill('input[name=email]', USER.email);
  await l.fill('input[name=password]', 'rahasia123');
  await l.click('#formAuth button');
  await l.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan di cloud');
  await l.click('nav >> text=Produk');
  const teks = norm(await l.textContent('main'));
  assert.ok(teks.includes('Keripik pedas') && teks.includes('stok 17'), teks);

  // 5. Laptop mengubah harga; HP menerima perubahan saat sinkron.
  await l.click('text=Ubah');
  await l.fill('input[name=harga]', '11000');
  await l.click('#formProduk button.primary');
  await l.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan di cloud');
  await p.click('nav >> text=Akun');
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
  await p.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan di cloud', null, { timeout: 10000 });
  assert.equal([...rows.values()].filter((r) => r.kind === 'transaksi').length, 2);

  // 7. Data tetap ada setelah aplikasi dibuka ulang.
  await l.reload();
  await l.waitForFunction(() => document.querySelector('#syncBadge').textContent === 'Tersimpan di cloud');
  await l.click('nav >> text=Laporan');
  await l.click('text=Semua');
  assert.ok((norm(await l.textContent('.stats'))).includes('Rp 41.000'), norm(await l.textContent('.stats')));

  // 8. Keluar menghapus data lokal.
  await l.click('nav >> text=Akun');
  await l.click('text=Keluar');
  await l.waitForSelector('#formAuth');
  await l.click('nav >> text=Produk');
  assert.ok((norm(await l.textContent('main'))).includes('Belum ada produk'));

  assert.deepEqual(hp.errors.concat(laptop.errors), []);
  await browser.close();
  console.log('E2E OK');
})().catch((e) => { console.error(e); console.error(log.slice(-15).join('\n')); process.exit(1); });
