(function () {
  'use strict';

  const store = KelolaStore.createStore(window.localStorage);
  const config = window.KELOLA_CONFIG || {};
  const cloudReady = !!(config.supabaseUrl && config.supabaseAnonKey && window.supabase);

  const $ = (sel, el) => (el || document).querySelector(sel);
  const viewEl = $('#view');
  const dialog = $('#dialog');

  const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
  const angka = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
  const rp = (n) => rupiah.format(Math.round(n || 0));
  const num = (v) => {
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ui = {
    view: 'kasir',
    cart: {}, // produkId -> qty
    bayar: '',
    periode: 'hari',
    authMode: 'masuk',
    authMsg: null,
    authEmail: '',
  };

  const cloud = {
    client: null,
    user: null,
    sync: null,
    status: 'idle', // idle | syncing | synced | error
    lastSynced: null,
    lastError: null,
    recovering: false,
  };

  // ---------- Data ----------

  function produkList() {
    return store.list('produk').sort((a, b) => a.data.nama.localeCompare(b.data.nama, 'id'));
  }

  function profil() {
    const rec = store.get('profil');
    return rec ? rec.data : { namaUsaha: '' };
  }

  function margin(modal, harga) {
    return harga > 0 ? ((harga - modal) / harga) * 100 : 0;
  }

  // Harga jual dari modal dan target margin, dibulatkan ke atas ke kelipatan 500.
  function hargaSaran(modal, targetMargin) {
    if (modal <= 0 || targetMargin <= 0 || targetMargin >= 100) return 0;
    return Math.ceil(modal / (1 - targetMargin / 100) / 500) * 500;
  }

  function change(fn) {
    fn();
    scheduleSync();
  }

  // ---------- Tampilan ----------

  function render() {
    document.querySelectorAll('nav button').forEach((b) => {
      if (b.dataset.go === ui.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $('#namaUsaha').textContent = profil().namaUsaha || '';
    renderBadge();
    const views = { kasir: viewKasir, produk: viewProduk, laporan: viewLaporan, akun: viewAkun };
    viewEl.innerHTML = views[ui.view]();
  }

  function renderBadge() {
    const badge = $('#syncBadge');
    let text = 'Hanya di perangkat ini';
    let cls = 'warn';
    if (cloud.user) {
      const pending = store.dirtyRecords().length;
      if (!navigator.onLine) { text = pending ? `Offline · ${pending} belum terkirim` : 'Offline'; cls = 'warn'; }
      else if (cloud.status === 'syncing') { text = 'Menyinkronkan…'; cls = ''; }
      else if (cloud.status === 'error') { text = 'Gagal sinkron'; cls = 'err'; }
      else if (pending) { text = `${pending} belum terkirim`; cls = 'warn'; }
      else { text = 'Tersimpan di cloud'; cls = 'ok'; }
    } else if (!cloudReady) {
      cls = '';
    }
    badge.textContent = text;
    badge.className = 'badge ' + cls;
  }

  function viewKasir() {
    const produk = produkList();
    if (!produk.length) {
      return `<h2>Kasir</h2><div class="card empty">Belum ada produk.<br><br>
        <button class="btn primary" data-act="produk-baru">Tambah produk pertama</button></div>`;
    }
    const items = Object.entries(ui.cart)
      .map(([id, qty]) => ({ rec: store.get(id), qty }))
      .filter((x) => x.rec);
    const total = items.reduce((s, x) => s + x.rec.data.harga * x.qty, 0);
    const bayar = num(ui.bayar);
    const tiles = produk.map((p) => {
      const d = p.data;
      const habis = d.stok != null && (d.stok - (ui.cart[p.id] || 0)) <= 0;
      const stok = d.stok != null ? `<div class="small muted">Stok ${angka.format(d.stok)} ${esc(d.satuan || '')}</div>` : '';
      return `<button class="tile" data-act="tambah-keranjang" data-id="${p.id}" ${habis ? 'disabled' : ''}>
        <div class="nama">${esc(d.nama)}</div><div>${rp(d.harga)}</div>${stok}</button>`;
    }).join('');
    const cart = items.length
      ? `<ul class="list">${items.map((x) => `<li class="row">
          <div><div>${esc(x.rec.data.nama)}</div><div class="small muted">${rp(x.rec.data.harga)} × ${x.qty} = ${rp(x.rec.data.harga * x.qty)}</div></div>
          <div class="qty"><button data-act="kurang" data-id="${x.rec.id}" aria-label="Kurangi">−</button><span>${x.qty}</span>
          <button data-act="tambah-keranjang" data-id="${x.rec.id}" aria-label="Tambah">+</button></div></li>`).join('')}</ul>
        <div class="row" style="margin-top:10px"><span>Total</span><span class="total">${rp(total)}</span></div>
        <div class="two" style="margin-top:10px">
          <label class="field"><span>Uang diterima</span><input id="bayar" type="number" inputmode="numeric" min="0" value="${esc(ui.bayar)}" placeholder="${total}"></label>
          <div class="field"><span class="small muted">Kembalian</span><div class="total" id="kembalian">${bayar >= total ? rp(bayar - total) : '–'}</div></div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn" data-act="kosongkan">Kosongkan</button>
          <button class="btn primary" data-act="simpan-penjualan">Simpan penjualan</button>
        </div>`
      : '<div class="muted">Ketuk produk di bawah untuk mulai mencatat penjualan.</div>';
    return `<h2>Kasir</h2><div class="card">${cart}</div><div class="grid">${tiles}</div>`;
  }

  function viewProduk() {
    const produk = produkList();
    const list = produk.length
      ? `<ul class="list">${produk.map((p) => {
          const d = p.data;
          const m = margin(d.modal, d.harga);
          const stok = d.stok != null ? ` · stok ${angka.format(d.stok)} ${esc(d.satuan || '')}` : '';
          return `<li class="row"><div><div><strong>${esc(d.nama)}</strong></div>
            <div class="small muted">Modal ${rp(d.modal)} · jual ${rp(d.harga)} · laba ${rp(d.harga - d.modal)} (${angka.format(m)}%)${stok}</div></div>
            <button class="btn" data-act="produk-ubah" data-id="${p.id}">Ubah</button></li>`;
        }).join('')}</ul>`
      : '<div class="empty">Belum ada produk. Tambahkan produk untuk menghitung harga jual dan mulai berjualan.</div>';
    return `<div class="row"><h2>Produk</h2><button class="btn primary" data-act="produk-baru">+ Produk</button></div>
      <div class="card">${list}</div>`;
  }

  function rentang(periode) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (periode === '7hari') start.setDate(start.getDate() - 6);
    if (periode === 'bulan') start.setDate(1);
    if (periode === 'semua') return 0;
    return start.getTime();
  }

  function viewLaporan() {
    const from = rentang(ui.periode);
    const trx = store.list('transaksi')
      .filter((t) => Date.parse(t.data.waktu) >= from)
      .sort((a, b) => b.data.waktu.localeCompare(a.data.waktu));
    const omzet = trx.reduce((s, t) => s + t.data.total, 0);
    const laba = trx.reduce((s, t) => s + t.data.laba, 0);
    const terjual = {};
    trx.forEach((t) => t.data.items.forEach((i) => {
      terjual[i.nama] = terjual[i.nama] || { qty: 0, omzet: 0 };
      terjual[i.nama].qty += i.qty;
      terjual[i.nama].omzet += i.qty * i.harga;
    }));
    const top = Object.entries(terjual).sort((a, b) => b[1].omzet - a[1].omzet).slice(0, 5);
    const seg = [['hari', 'Hari ini'], ['7hari', '7 hari'], ['bulan', 'Bulan ini'], ['semua', 'Semua']]
      .map(([k, l]) => `<button data-act="periode" data-p="${k}" aria-pressed="${ui.periode === k}">${l}</button>`).join('');
    const fmtWaktu = (iso) => new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<h2>Laporan</h2><div class="seg">${seg}</div>
      <div class="stats">
        <div class="stat"><div class="label">Omzet</div><div class="value">${rp(omzet)}</div></div>
        <div class="stat"><div class="label">Laba kotor</div><div class="value">${rp(laba)}</div></div>
        <div class="stat"><div class="label">Transaksi</div><div class="value">${trx.length}</div></div>
        <div class="stat"><div class="label">Margin rata-rata</div><div class="value">${omzet ? angka.format((laba / omzet) * 100) + '%' : '–'}</div></div>
      </div>
      <div class="card"><strong>Produk terlaris</strong>${top.length
        ? `<ul class="list">${top.map(([n, v]) => `<li class="row"><span>${esc(n)}</span><span class="small muted">${angka.format(v.qty)} terjual · ${rp(v.omzet)}</span></li>`).join('')}</ul>`
        : '<div class="empty">Belum ada penjualan di periode ini.</div>'}</div>
      <div class="card"><strong>Riwayat penjualan</strong>${trx.length
        ? `<ul class="list">${trx.map((t) => `<li class="row"><div><div>${rp(t.data.total)} <span class="small muted">· laba ${rp(t.data.laba)}</span></div>
            <div class="small muted">${fmtWaktu(t.data.waktu)} · ${esc(t.data.items.map((i) => `${i.nama} ×${i.qty}`).join(', '))}</div></div>
            <button class="btn danger" data-act="batal-trx" data-id="${t.id}">Batalkan</button></li>`).join('')}</ul>`
        : '<div class="empty">Belum ada penjualan.</div>'}</div>`;
  }

  function viewAkun() {
    const p = profil();
    const usaha = `<div class="card stack"><strong>Profil usaha</strong>
      <label class="field"><span>Nama usaha</span><input id="namaUsahaInput" value="${esc(p.namaUsaha)}" placeholder="Contoh: Warung Bu Sari"></label>
      <button class="btn" data-act="simpan-profil">Simpan</button></div>`;
    return `<h2>Akun</h2>${usaha}${viewCloud()}`;
  }

  function viewCloud() {
    if (!cloudReady) {
      return `<div class="card stack"><strong>Simpan ke cloud</strong>
        <div class="muted">Sinkronisasi cloud belum diaktifkan di aplikasi ini, jadi data hanya tersimpan di perangkat ini.
        Pemilik aplikasi perlu mengisi <code>js/config.js</code> (lihat README).</div></div>`;
    }
    const msg = ui.authMsg ? `<div class="msg ${ui.authMsg.type}">${esc(ui.authMsg.text)}</div>` : '';
    if (cloud.recovering) {
      return `<div class="card stack"><strong>Buat kata sandi baru</strong>${msg}
        <form id="formSandiBaru" class="stack">
          <label class="field"><span>Kata sandi baru</span><input name="password" type="password" minlength="6" autocomplete="new-password" required></label>
          <button class="btn primary block">Simpan kata sandi</button></form></div>`;
    }
    if (cloud.user) {
      const pending = store.dirtyRecords().length;
      const last = cloud.lastSynced ? cloud.lastSynced.toLocaleString('id-ID') : 'belum';
      const err = cloud.status === 'error' && cloud.lastError
        ? `<div class="msg err">Gagal sinkron: ${esc(cloud.lastError.message || cloud.lastError)}. Data tetap aman di perangkat ini dan akan dikirim ulang.</div>` : '';
      return `<div class="card stack"><strong>Simpan ke cloud</strong>
        <div>Masuk sebagai <strong>${esc(cloud.user.email)}</strong></div>
        <div class="small muted">Sinkron terakhir: ${esc(last)} · ${pending ? pending + ' perubahan belum terkirim' : 'semua data sudah terkirim'}</div>
        ${err}${msg}
        <div class="row"><button class="btn" data-act="sinkron">Sinkronkan sekarang</button>
        <button class="btn danger" data-act="keluar">Keluar</button></div>
        <div class="small muted">Masuk dengan akun yang sama di HP, tablet, atau laptop lain untuk melihat data yang sama.</div></div>`;
    }
    const daftar = ui.authMode === 'daftar';
    const lupa = ui.authMode === 'lupa';
    const judul = daftar ? 'Buat akun' : lupa ? 'Lupa kata sandi' : 'Masuk';
    const pw = lupa ? '' : `<label class="field"><span>Kata sandi</span><input name="password" type="password" ${daftar ? 'minlength="6"' : ''} autocomplete="${daftar ? 'new-password' : 'current-password'}" required></label>`;
    const tombol = daftar ? 'Daftar' : lupa ? 'Kirim tautan reset' : 'Masuk';
    const lokal = store.list('produk').length + store.list('transaksi').length;
    const info = lokal ? `<div class="hint">Data yang sudah ada di perangkat ini akan ikut tersimpan ke akun Anda setelah masuk.</div>` : '';
    return `<div class="card stack"><strong>${judul}</strong>
      <div class="muted small">Masuk supaya data tidak hilang saat HP rusak atau ganti perangkat, dan bisa dibuka di beberapa perangkat sekaligus.</div>
      ${info}${msg}
      <form id="formAuth" class="stack">
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required value="${esc(ui.authEmail)}"></label>
        ${pw}
        <button class="btn primary block">${tombol}</button>
      </form>
      <div class="row small">
        ${daftar || lupa ? '<button class="link" data-act="mode" data-m="masuk">Sudah punya akun? Masuk</button>' : '<button class="link" data-act="mode" data-m="daftar">Belum punya akun? Daftar</button>'}
        ${lupa ? '' : '<button class="link" data-act="mode" data-m="lupa">Lupa kata sandi?</button>'}
      </div></div>`;
  }

  // ---------- Form produk ----------

  function bukaFormProduk(id) {
    const rec = id ? store.get(id) : null;
    const d = rec ? rec.data : { nama: '', satuan: 'pcs', modal: '', harga: '', stok: null };
    dialog.innerHTML = `<form id="formProduk" class="stack" method="dialog">
      <div class="row"><strong>${rec ? 'Ubah produk' : 'Produk baru'}</strong><button type="button" class="link" data-act="tutup">Tutup</button></div>
      <label class="field"><span>Nama produk</span><input name="nama" required value="${esc(d.nama)}" placeholder="Contoh: Keripik pedas 100 g"></label>
      <div class="two">
        <label class="field"><span>Modal per satuan (Rp)</span><input name="modal" type="number" inputmode="decimal" min="0" step="any" required value="${esc(d.modal)}"></label>
        <label class="field"><span>Satuan</span><input name="satuan" value="${esc(d.satuan || '')}" placeholder="pcs, porsi, kg"></label>
      </div>
      <div class="hint stack">
        <div><strong>Kalkulator harga jual</strong></div>
        <div class="two">
          <label class="field"><span>Target margin (%)</span><input name="target" type="number" inputmode="decimal" min="1" max="95" value="30"></label>
          <div class="field"><span class="small muted">Harga saran</span><div><strong id="saran">–</strong></div>
            <button type="button" class="link small" data-act="pakai-saran">Pakai harga ini</button></div>
        </div>
      </div>
      <label class="field"><span>Harga jual (Rp)</span><input name="harga" type="number" inputmode="decimal" min="0" step="any" required value="${esc(d.harga)}"></label>
      <div class="small muted" id="ringkasLaba"></div>
      <label class="field"><span>Stok (kosongkan jika tidak dihitung)</span><input name="stok" type="number" inputmode="decimal" step="any" value="${d.stok == null ? '' : esc(d.stok)}"></label>
      <div class="row">
        ${rec ? `<button type="button" class="btn danger" data-act="produk-hapus" data-id="${rec.id}">Hapus</button>` : '<span></span>'}
        <button class="btn primary">Simpan</button>
      </div>
      <input type="hidden" name="produkId" value="${rec ? rec.id : ''}">
    </form>`;
    hitungForm();
    dialog.showModal();
  }

  function hitungForm() {
    const f = $('#formProduk');
    if (!f) return;
    const modal = num(f.modal.value);
    const harga = num(f.harga.value);
    const saran = hargaSaran(modal, num(f.target.value));
    $('#saran').textContent = saran ? rp(saran) : '–';
    $('#ringkasLaba').textContent = harga > 0
      ? `Laba per satuan ${rp(harga - modal)} · margin ${angka.format(margin(modal, harga))}%` + (harga < modal ? ' · harga di bawah modal!' : '')
      : '';
  }

  // ---------- Aksi ----------

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function simpanPenjualan() {
    const items = Object.entries(ui.cart)
      .map(([id, qty]) => ({ rec: store.get(id), qty }))
      .filter((x) => x.rec && x.qty > 0);
    if (!items.length) return;
    const total = items.reduce((s, x) => s + x.rec.data.harga * x.qty, 0);
    const laba = items.reduce((s, x) => s + (x.rec.data.harga - x.rec.data.modal) * x.qty, 0);
    change(() => {
      store.put('transaksi', {
        waktu: new Date().toISOString(),
        items: items.map((x) => ({ produkId: x.rec.id, nama: x.rec.data.nama, qty: x.qty, harga: x.rec.data.harga, modal: x.rec.data.modal })),
        total,
        laba,
        bayar: num(ui.bayar) || total,
      });
      items.forEach((x) => {
        if (x.rec.data.stok != null) store.put('produk', Object.assign({}, x.rec.data, { stok: x.rec.data.stok - x.qty }), x.rec.id);
      });
    });
    ui.cart = {};
    ui.bayar = '';
    render();
    toast(`Penjualan ${rp(total)} tersimpan`);
  }

  function batalTransaksi(id) {
    const t = store.get(id);
    if (!t || !confirm('Batalkan penjualan ini? Stok produk akan dikembalikan.')) return;
    change(() => {
      t.data.items.forEach((i) => {
        const p = store.get(i.produkId);
        if (p && p.data.stok != null) store.put('produk', Object.assign({}, p.data, { stok: p.data.stok + i.qty }), p.id);
      });
      store.remove(id);
    });
    render();
  }

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      ui.view = go.dataset.go;
      ui.authMsg = null;
      render();
      window.scrollTo(0, 0);
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.act) {
      case 'produk-baru': bukaFormProduk(); break;
      case 'produk-ubah': bukaFormProduk(id); break;
      case 'tutup': dialog.close(); break;
      case 'pakai-saran': {
        const f = $('#formProduk');
        const s = hargaSaran(num(f.modal.value), num(f.target.value));
        if (s) { f.harga.value = s; hitungForm(); }
        break;
      }
      case 'produk-hapus':
        if (confirm('Hapus produk ini? Riwayat penjualan tetap tersimpan.')) {
          change(() => store.remove(id));
          delete ui.cart[id];
          dialog.close();
          render();
        }
        break;
      case 'tambah-keranjang': ui.cart[id] = (ui.cart[id] || 0) + 1; render(); break;
      case 'kurang':
        ui.cart[id] = (ui.cart[id] || 0) - 1;
        if (ui.cart[id] <= 0) delete ui.cart[id];
        render();
        break;
      case 'kosongkan': ui.cart = {}; ui.bayar = ''; render(); break;
      case 'simpan-penjualan': simpanPenjualan(); break;
      case 'batal-trx': batalTransaksi(id); break;
      case 'periode': ui.periode = el.dataset.p; render(); break;
      case 'simpan-profil':
        change(() => store.put('profil', { namaUsaha: $('#namaUsahaInput').value.trim() }, 'profil'));
        render();
        toast('Profil tersimpan');
        break;
      case 'mode': ui.authMode = el.dataset.m; ui.authMsg = null; render(); break;
      case 'sinkron': syncNow(true); break;
      case 'keluar': keluar(); break;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'bayar') {
      ui.bayar = e.target.value;
      const total = Object.entries(ui.cart).reduce((s, [id, q]) => { const r = store.get(id); return s + (r ? r.data.harga * q : 0); }, 0);
      const b = num(ui.bayar);
      $('#kembalian').textContent = b >= total ? rp(b - total) : '–';
    }
    if (e.target.form && e.target.form.id === 'formProduk') hitungForm();
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id === 'formProduk') {
      e.preventDefault();
      const stok = f.stok.value.trim();
      change(() => store.put('produk', {
        nama: f.nama.value.trim(),
        satuan: f.satuan.value.trim(),
        modal: num(f.modal.value),
        harga: num(f.harga.value),
        stok: stok === '' ? null : num(stok),
      }, f.produkId.value || undefined));
      dialog.close();
      render();
      toast('Produk tersimpan');
    }
    if (f.id === 'formAuth') {
      e.preventDefault();
      await kirimAuth(f);
    }
    if (f.id === 'formSandiBaru') {
      e.preventDefault();
      const { error } = await cloud.client.auth.updateUser({ password: f.password.value });
      if (error) { ui.authMsg = { type: 'err', text: pesanAuth(error) }; render(); return; }
      cloud.recovering = false;
      ui.authMsg = { type: 'ok', text: 'Kata sandi baru tersimpan.' };
      render();
    }
  });

  // ---------- Cloud ----------

  function pesanAuth(error) {
    const m = (error && error.message) || String(error);
    if (/Invalid login credentials/i.test(m)) return 'Email atau kata sandi salah.';
    if (/Email not confirmed/i.test(m)) return 'Email belum dikonfirmasi. Buka email dari Kelola dan klik tautan konfirmasi.';
    if (/already registered/i.test(m)) return 'Email ini sudah terdaftar. Silakan masuk.';
    if (/Password should be/i.test(m)) return 'Kata sandi minimal 6 karakter.';
    if (/fetch|network/i.test(m)) return 'Tidak ada koneksi internet. Coba lagi nanti.';
    return m;
  }

  async function kirimAuth(f) {
    const email = f.email.value.trim();
    ui.authEmail = email;
    const btn = f.querySelector('button');
    btn.disabled = true;
    ui.authMsg = null;
    try {
      const auth = cloud.client.auth;
      const redirect = location.origin + location.pathname;
      if (ui.authMode === 'daftar') {
        const { data, error } = await auth.signUp({ email, password: f.password.value, options: { emailRedirectTo: redirect } });
        if (error) throw error;
        if (!data.session) ui.authMsg = { type: 'ok', text: `Hampir selesai. Kami mengirim email konfirmasi ke ${email}. Klik tautannya, lalu masuk di sini.` };
      } else if (ui.authMode === 'lupa') {
        const { error } = await auth.resetPasswordForEmail(email, { redirectTo: redirect });
        if (error) throw error;
        ui.authMsg = { type: 'ok', text: `Tautan untuk membuat kata sandi baru sudah dikirim ke ${email}.` };
      } else {
        const { error } = await auth.signInWithPassword({ email, password: f.password.value });
        if (error) throw error;
      }
    } catch (err) {
      ui.authMsg = { type: 'err', text: pesanAuth(err) };
    }
    btn.disabled = false;
    render();
  }

  async function keluar() {
    if (navigator.onLine) await syncNow(false).catch(() => {});
    const pending = store.dirtyRecords().length;
    const tanya = pending
      ? `Masih ada ${pending} perubahan yang belum terkirim ke cloud dan akan hilang jika Anda keluar sekarang. Tetap keluar?`
      : 'Keluar dari akun? Data di perangkat ini akan dihapus, tapi tetap aman di cloud.';
    if (!confirm(tanya)) return;
    await cloud.client.auth.signOut().catch(() => {});
    setUser(null);
    store.clear();
    ui.cart = {};
    ui.authMode = 'masuk';
    ui.authMsg = { type: 'ok', text: 'Anda sudah keluar.' };
    render();
  }

  function setUser(user) {
    const prev = cloud.user && cloud.user.id;
    cloud.user = user;
    if (!user) {
      cloud.sync = null;
      cloud.status = 'idle';
      return;
    }
    if (prev === user.id && cloud.sync) return;
    store.claim(user.id);
    const remote = KelolaSync.supabaseRemote(cloud.client, user.id);
    cloud.sync = KelolaSync.createSync(store, remote, (status, detail) => {
      cloud.status = status;
      if (status === 'synced') { cloud.lastSynced = detail; cloud.lastError = null; }
      if (status === 'error') cloud.lastError = detail;
      if (!dialog.open && !document.activeElement.matches('input')) render();
      else renderBadge();
    });
    syncNow(false);
  }

  let syncTimer = null;
  function scheduleSync() {
    renderBadge();
    if (!cloud.sync) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(false), 1500);
  }

  function syncNow(loud) {
    if (!cloud.sync || !navigator.onLine) {
      renderBadge();
      if (loud) toast('Tidak ada koneksi internet');
      return Promise.resolve();
    }
    return cloud.sync.run().then(
      () => { if (loud) toast('Data sudah sinkron'); },
      (err) => { console.warn('Sinkronisasi gagal', err); },
    );
  }

  function initCloud() {
    if (!cloudReady) return;
    cloud.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    cloud.client.auth.onAuthStateChange((event, session) => {
      // Jalankan di luar callback; supabase-js tidak boleh dipanggil ulang di dalamnya.
      setTimeout(() => {
        if (event === 'PASSWORD_RECOVERY') {
          cloud.recovering = true;
          ui.view = 'akun';
        }
        setUser(session ? session.user : null);
        render();
      }, 0);
    });
    window.addEventListener('online', () => syncNow(false));
    window.addEventListener('offline', renderBadge);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow(false);
    });
    setInterval(() => { if (document.visibilityState === 'visible') syncNow(false); }, 60000);
  }

  // Kalau data diubah di tab lain pada perangkat yang sama, muat ulang supaya tidak saling menimpa.
  window.addEventListener('storage', (e) => {
    if (e.key === KelolaStore.KEY) location.reload();
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  initCloud();
  render();

  // Untuk pengujian.
  window.Kelola = { store, cloud, ui, hargaSaran };
})();
