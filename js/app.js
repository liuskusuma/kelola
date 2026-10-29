(function () {
  'use strict';

  const store = KelolaStore.createStore(window.localStorage);
  const H = KelolaHitung;
  const config = window.KELOLA_CONFIG || {};
  const cloudReady = !!(config.supabaseUrl && config.supabaseAnonKey && window.supabase);

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
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
    trxTerakhir: null, // penjualan yang baru disimpan, untuk tombol struk
    produkTab: 'produk', // produk | bahan
    periode: 'hari',
    authMode: 'masuk',
    authMsg: null,
    authEmail: '',
    struk: null, // { blob, url, teks }
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

  const urutNama = (a, b) => a.data.nama.localeCompare(b.data.nama, 'id');

  function produkList() {
    return store.list('produk').sort(urutNama);
  }

  function bahanList() {
    return store.list('bahan').sort(urutNama);
  }

  // Data bahan atau produk berdasarkan id, untuk rumus di hitung.js.
  function cari(id) {
    const rec = store.get(id);
    return rec ? rec.data : null;
  }

  // Modal per satuan dengan harga bahan saat ini.
  const modalOf = (p) => H.modalProduk(p.data, cari);

  const pakaiResep = (d) => d.mode === 'resep' || d.mode === 'paket';

  // Produk yang modalnya berubah karena harga bahan berubah sejak produk terakhir disimpan.
  function produkBerubah() {
    return produkList().filter((p) => pakaiResep(p.data) && Math.abs(modalOf(p) - (p.data.modal || 0)) >= 1);
  }

  function profil() {
    const rec = store.get('profil');
    return rec ? rec.data : { namaUsaha: '' };
  }

  function change(fn) {
    fn();
    scheduleSync();
  }

  const satuanBahan = (b) => esc((b && b.satuan) || '');

  // ---------- Tampilan ----------

  const JUDUL = {
    kasir: ['Kasir', 'Catat penjualan'],
    produk: ['Produk', 'Harga jual, resep & stok'],
    laporan: ['Laporan', 'Omzet, pengeluaran & laba'],
    akun: ['Akun', 'Profil & simpan ke cloud'],
  };

  function render() {
    document.querySelectorAll('nav.tabs button').forEach((b) => {
      if (b.dataset.go === ui.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const [judul, sub] = JUDUL[ui.view];
    $('#judul').textContent = judul;
    $('#subjudul').textContent = profil().namaUsaha || sub;
    renderBadge();
    renderSummary();
    const views = { kasir: viewKasir, produk: viewProduk, laporan: viewLaporan, akun: viewAkun };
    viewEl.innerHTML = views[ui.view]();
  }

  function renderBadge() {
    const badge = $('#syncBadge');
    let text = 'Lokal';
    let title = 'Data hanya tersimpan di perangkat ini. Masuk untuk menyimpan ke cloud.';
    let cls = '';
    if (cloud.user) {
      const pending = store.dirtyRecords().length;
      if (!navigator.onLine) { text = 'Offline'; title = pending ? `${pending} perubahan belum terkirim` : 'Tidak ada koneksi'; cls = 'warn'; }
      else if (cloud.status === 'syncing') { text = 'Sinkron…'; title = 'Menyinkronkan'; cls = 'busy'; }
      else if (cloud.status === 'error') { text = 'Gagal'; title = 'Gagal sinkron'; cls = 'err'; }
      else if (pending) { text = `${pending} tertunda`; title = `${pending} perubahan belum terkirim`; cls = 'warn'; }
      else { text = 'Tersimpan'; title = 'Semua data tersimpan di cloud'; cls = 'ok'; }
    }
    badge.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
    badge.title = title;
    badge.setAttribute('aria-label', title);
    badge.className = 'sync ' + cls;
  }

  function isiKeranjang() {
    return Object.entries(ui.cart)
      .map(([id, qty]) => ({ rec: store.get(id), qty }))
      .filter((x) => x.rec);
  }

  // Bar navy di atas tab bar, seperti bar total di Bagi Rata.
  function renderSummary() {
    const items = ui.view === 'kasir' ? isiKeranjang() : [];
    const qty = items.reduce((s, x) => s + x.qty, 0);
    const total = items.reduce((s, x) => s + x.rec.data.harga * x.qty, 0);
    document.body.classList.toggle('ada-ringkasan', qty > 0);
    $('#summary').innerHTML = `<span>Keranjang · ${angka.format(qty)} item</span><b>${rp(total)} ›</b>`;
  }

  // Bisa ditambah satu lagi ke keranjang tanpa melebihi stok?
  function bisaTambah(id) {
    const cart = Object.assign({}, ui.cart);
    cart[id] = (cart[id] || 0) + 1;
    return H.stokCukup(cart, cari);
  }

  function viewKasir() {
    const produk = produkList();
    if (!produk.length) {
      return `<div class="group-title">Mulai berjualan</div><div class="card empty stack">
        <div>Belum ada produk. Tambahkan produk dulu, lalu ketuk produk di sini setiap kali ada pembeli.</div>
        <button class="btn primary" data-act="produk-baru">Tambah produk pertama</button></div>`;
    }
    const items = isiKeranjang();
    const total = items.reduce((s, x) => s + x.rec.data.harga * x.qty, 0);
    const bayar = num(ui.bayar);
    const tiles = produk.map((p) => {
      const d = p.data;
      const habis = !bisaTambah(p.id);
      const stok = d.stok != null && d.mode !== 'paket' ? `<div class="small muted">Stok ${angka.format(d.stok)} ${esc(d.satuan || '')}</div>` : '';
      const jumlah = ui.cart[p.id] ? `<span class="jumlah">${ui.cart[p.id]}</span>` : '';
      return `<button class="tile" data-act="tambah-keranjang" data-id="${p.id}" ${habis ? 'disabled' : ''}>
        ${jumlah}<div class="nama">${esc(d.nama)}</div><div class="harga">${rp(d.harga)}</div>${stok}</button>`;
    }).join('');
    const terakhir = !items.length && ui.trxTerakhir && store.get(ui.trxTerakhir);
    const info = terakhir
      ? `<div class="card row" id="trxTerakhir"><div><div class="nama label">Penjualan ${rp(terakhir.data.total)} tersimpan</div>
          <div class="small muted">Kirim struk ke pembeli lewat WhatsApp.</div></div>
          <button class="btn kecil primary" data-act="struk" data-id="${terakhir.id}">Struk</button></div>`
      : '';
    const cart = items.length
      ? `<div class="group-title" id="keranjang">Keranjang</div><div class="card">
        <ul class="list">${items.map((x) => `<li class="row">
          <div><div class="nama">${esc(x.rec.data.nama)}</div><div class="small muted">${rp(x.rec.data.harga)} × ${x.qty} = ${rp(x.rec.data.harga * x.qty)}</div></div>
          <div class="qty"><button data-act="kurang" data-id="${x.rec.id}" aria-label="Kurangi">−</button><span>${x.qty}</span>
          <button data-act="tambah-keranjang" data-id="${x.rec.id}" aria-label="Tambah" ${bisaTambah(x.rec.id) ? '' : 'disabled'}>+</button></div></li>`).join('')}</ul>
        <div class="row" style="margin-top:8px"><span class="label">Total</span><span class="total">${rp(total)}</span></div>
        <div class="two" style="margin-top:14px">
          <label class="field"><span>Uang diterima</span><input id="bayar" type="number" inputmode="numeric" min="0" value="${esc(ui.bayar)}" placeholder="${total}"></label>
          <div class="field"><span class="lbl">Kembalian</span><div class="total" id="kembalian" style="padding:6px 4px">${bayar >= total ? rp(bayar - total) : '–'}</div></div>
        </div>
        <div class="row" style="margin-top:16px">
          <button class="btn" data-act="kosongkan">Kosongkan</button>
          <button class="btn primary" data-act="simpan-penjualan">Simpan penjualan</button>
        </div></div>`
      : '';
    const petunjuk = items.length ? '' : '<div class="foot" style="margin:0 8px 14px">Ketuk produk untuk menambahkannya ke keranjang.</div>';
    return `${info}${cart}<div class="group-title">Produk</div>${petunjuk}<div class="grid">${tiles}</div>`;
  }

  function viewProduk() {
    const seg = [['produk', 'Produk'], ['bahan', 'Bahan baku']]
      .map(([k, l]) => `<button data-act="produk-tab" data-t="${k}" aria-pressed="${ui.produkTab === k}">${l}</button>`).join('');
    return `<div class="seg" style="margin-top:10px">${seg}</div>${ui.produkTab === 'bahan' ? viewBahan() : viewDaftarProduk()}`;
  }

  function viewDaftarProduk() {
    const produk = produkList();
    const berubah = produkBerubah();
    const peringatan = berubah.length
      ? `<div class="card stack peringatan"><div><span class="label">Harga bahan berubah</span>
          <div class="small muted">Modal ${berubah.length} produk ikut berubah. Cek apakah harga jualnya masih menguntungkan.</div></div>
          <button class="btn primary block" data-act="dampak">Cek harga jual</button></div>`
      : '';
    const list = produk.length
      ? `<ul class="list">${produk.map((p) => {
          const d = p.data;
          const modal = modalOf(p);
          const m = H.margin(modal, d.harga);
          const stok = d.stok != null && d.mode !== 'paket' ? ` · stok ${angka.format(d.stok)} ${esc(d.satuan || '')}` : '';
          const jenis = d.mode === 'resep' ? '<span class="tag">Resep</span>' : d.mode === 'paket' ? '<span class="tag">Paket</span>' : '';
          const naik = pakaiResep(d) && Math.abs(modal - (d.modal || 0)) >= 1
            ? `<div class="small warn">Modal ${modal > d.modal ? 'naik' : 'turun'} dari ${rp(d.modal)}</div>` : '';
          const rugi = d.harga < modal ? '<div class="small err">Harga jual di bawah modal!</div>' : '';
          const produksi = d.mode === 'resep' && d.stok != null
            ? `<button class="btn kecil" data-act="produksi" data-id="${p.id}">Produksi</button>` : '';
          return `<li class="row"><div><div class="nama">${esc(d.nama)} ${jenis}</div>
            <div class="small muted">Modal ${rp(modal)} · jual ${rp(d.harga)} · laba ${rp(d.harga - modal)} (${angka.format(m)}%)${stok}</div>${naik}${rugi}</div>
            <div class="aksi">${produksi}<button class="btn kecil" data-act="produk-ubah" data-id="${p.id}">Ubah</button></div></li>`;
        }).join('')}</ul>`
      : '<div class="empty">Belum ada produk. Tambahkan produk untuk menghitung harga jual dan mulai berjualan.</div>';
    return `${peringatan}<div class="group-title"><span>Daftar produk</span><button class="link tambah" data-act="produk-baru">+ Tambah produk</button></div>
      <div class="card">${list}</div>
      <div class="foot">Modal bisa diisi sendiri, dihitung dari resep bahan baku, atau dari isi paket. Harga jual disarankan dari target margin.</div>`;
  }

  function viewBahan() {
    const bahan = bahanList();
    const list = bahan.length
      ? `<ul class="list">${bahan.map((b) => {
          const d = b.data;
          const stok = d.stok != null ? ` · stok ${angka.format(d.stok)} ${satuanBahan(d)}` : '';
          const tipis = d.stok != null && d.stok <= 0 ? '<div class="small err">Stok habis</div>' : '';
          return `<li class="row"><div><div class="nama">${esc(d.nama)}</div>
            <div class="small muted">${rp(d.harga)} / ${angka.format(d.isi)} ${satuanBahan(d)} · ${rp(H.hargaSatuan(d))} per ${satuanBahan(d)}${stok}</div>${tipis}</div>
            <button class="btn kecil" data-act="bahan-ubah" data-id="${b.id}">Ubah</button></li>`;
        }).join('')}</ul>`
      : '<div class="empty">Belum ada bahan baku. Catat bahan dan harga belinya supaya modal produk dihitung otomatis dari resep.</div>';
    return `<div class="group-title"><span>Bahan baku</span><button class="link tambah" data-act="bahan-baru">+ Tambah bahan</button></div>
      <div class="card">${list}</div>
      <div class="foot">Kalau harga bahan naik, ubah harganya di sini. Kelola akan menunjukkan produk mana yang modalnya ikut naik.</div>`;
  }

  function rentang(periode) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (periode === '7hari') start.setDate(start.getDate() - 6);
    if (periode === 'bulan') start.setDate(1);
    if (periode === 'semua') return 0;
    return start.getTime();
  }

  const KATEGORI = ['Sewa tempat', 'Listrik & air', 'Gaji', 'Transportasi', 'Iklan & promosi', 'Peralatan', 'Lainnya'];

  function viewLaporan() {
    const from = rentang(ui.periode);
    const dalam = (t) => Date.parse(t.data.waktu) >= from;
    const urut = (a, b) => b.data.waktu.localeCompare(a.data.waktu);
    const trx = store.list('transaksi').filter(dalam).sort(urut);
    const keluar = store.list('pengeluaran').filter(dalam).sort(urut);
    const omzet = trx.reduce((s, t) => s + t.data.total, 0);
    const laba = trx.reduce((s, t) => s + t.data.laba, 0);
    const biaya = keluar.reduce((s, t) => s + t.data.jumlah, 0);
    const bersih = laba - biaya;
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
    const fmtTanggal = (iso) => new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
    return `<div class="group-title">Periode</div><div class="seg">${seg}</div>
      <div class="stats">
        <div class="stat utama"><div class="lbl">Omzet</div><div class="value">${rp(omzet)}</div></div>
        <div class="stat"><div class="lbl">Laba kotor</div><div class="value">${rp(laba)}</div></div>
        <div class="stat"><div class="lbl">Pengeluaran</div><div class="value">${rp(biaya)}</div></div>
        <div class="stat" id="labaBersih"><div class="lbl">Laba bersih</div><div class="value ${bersih < 0 ? 'err' : ''}">${rp(bersih)}</div></div>
        <div class="stat"><div class="lbl">Transaksi</div><div class="value">${trx.length}</div></div>
        <div class="stat"><div class="lbl">Margin rata-rata</div><div class="value">${omzet ? angka.format((laba / omzet) * 100) + '%' : '–'}</div></div>
      </div>
      <div class="foot">Laba kotor = omzet dikurangi modal barang yang terjual. Laba bersih = laba kotor dikurangi pengeluaran.</div>
      <div class="group-title">Produk terlaris</div>
      <div class="card">${top.length
        ? `<ul class="list">${top.map(([n, v]) => `<li class="row"><span class="nama">${esc(n)}</span><span class="small muted">${angka.format(v.qty)} terjual · ${rp(v.omzet)}</span></li>`).join('')}</ul>`
        : '<div class="empty">Belum ada penjualan di periode ini.</div>'}</div>
      <div class="group-title"><span>Pengeluaran</span><button class="link tambah" data-act="pengeluaran-baru">+ Catat pengeluaran</button></div>
      <div class="card">${keluar.length
        ? `<ul class="list">${keluar.map((t) => `<li class="row"><div><div class="nama">${rp(t.data.jumlah)} <span class="small muted">· ${esc(t.data.kategori)}</span></div>
            <div class="small muted">${fmtTanggal(t.data.waktu)}${t.data.catatan ? ' · ' + esc(t.data.catatan) : ''}</div></div>
            <button class="btn kecil" data-act="pengeluaran-ubah" data-id="${t.id}">Ubah</button></li>`).join('')}</ul>`
        : '<div class="empty">Belum ada pengeluaran di periode ini. Catat biaya seperti sewa, listrik, atau gaji supaya laba bersih terlihat.</div>'}</div>
      <div class="group-title">Riwayat penjualan</div>
      <div class="card">${trx.length
        ? `<ul class="list">${trx.map((t) => `<li class="row"><div><div><span class="nama">${rp(t.data.total)}</span> <span class="small muted">· laba ${rp(t.data.laba)}</span></div>
            <div class="small muted">${fmtWaktu(t.data.waktu)} · ${esc(t.data.items.map((i) => `${i.nama} ×${i.qty}`).join(', '))}</div></div>
            <div class="aksi"><button class="btn kecil" data-act="struk" data-id="${t.id}">Struk</button>
            <button class="btn kecil danger" data-act="batal-trx" data-id="${t.id}">Batalkan</button></div></li>`).join('')}</ul>`
        : '<div class="empty">Belum ada penjualan.</div>'}</div>`;
  }

  function viewAkun() {
    const p = profil();
    const usaha = `<div class="group-title">Profil usaha</div><div class="card stack">
      <label class="field"><span>Nama usaha</span><input id="namaUsahaInput" value="${esc(p.namaUsaha)}" placeholder="Contoh: Warung Bu Sari"></label>
      <label class="field"><span>Alamat atau nomor WhatsApp (tampil di struk)</span><input id="kontakUsahaInput" value="${esc(p.kontak || '')}" placeholder="Contoh: Jl. Melati 5 · 0812 3456 7890"></label>
      <button class="btn" data-act="simpan-profil">Simpan</button></div>`;
    return `${usaha}${viewCloud()}`;
  }

  function viewCloud() {
    if (!cloudReady) {
      return `<div class="group-title">Simpan ke cloud</div><div class="card stack">
        <div class="muted">Sinkronisasi cloud belum diaktifkan di aplikasi ini, jadi data hanya tersimpan di perangkat ini.
        Pemilik aplikasi perlu mengisi <code>js/config.js</code> (lihat README).</div></div>`;
    }
    const msg = ui.authMsg ? `<div class="msg ${ui.authMsg.type}">${esc(ui.authMsg.text)}</div>` : '';
    if (cloud.recovering) {
      return `<div class="group-title">Buat kata sandi baru</div><div class="card stack">${msg}
        <form id="formSandiBaru" class="stack">
          <label class="field"><span>Kata sandi baru</span><input name="password" type="password" minlength="6" autocomplete="new-password" required></label>
          <button class="btn primary block">Simpan kata sandi</button></form></div>`;
    }
    if (cloud.user) {
      const pending = store.dirtyRecords().length;
      const last = cloud.lastSynced ? cloud.lastSynced.toLocaleString('id-ID') : 'belum';
      const err = cloud.status === 'error' && cloud.lastError
        ? `<div class="msg err">Gagal sinkron: ${esc(cloud.lastError.message || cloud.lastError)}. Data tetap aman di perangkat ini dan akan dikirim ulang.</div>` : '';
      return `<div class="group-title">Simpan ke cloud</div><div class="card stack">
        <div>Masuk sebagai <strong>${esc(cloud.user.email)}</strong></div>
        <div class="small muted">Sinkron terakhir: ${esc(last)} · ${pending ? pending + ' perubahan belum terkirim' : 'semua data sudah terkirim'}</div>
        ${err}${msg}
        <div class="row"><button class="btn" data-act="sinkron">Sinkronkan sekarang</button>
        <button class="btn danger" data-act="keluar">Keluar</button></div></div>
        <div class="foot">Masuk dengan akun yang sama di HP, tablet, atau laptop lain untuk melihat data yang sama.</div>`;
    }
    const daftar = ui.authMode === 'daftar';
    const lupa = ui.authMode === 'lupa';
    const judul = daftar ? 'Buat akun' : lupa ? 'Lupa kata sandi' : 'Masuk';
    const pw = lupa ? '' : `<label class="field"><span>Kata sandi</span><input name="password" type="password" ${daftar ? 'minlength="6"' : ''} autocomplete="${daftar ? 'new-password' : 'current-password'}" required></label>`;
    const tombol = daftar ? 'Daftar' : lupa ? 'Kirim tautan reset' : 'Masuk';
    const lokal = store.list('produk').length + store.list('transaksi').length;
    const info = lokal ? `<div class="hint">Data yang sudah ada di perangkat ini akan ikut tersimpan ke akun Anda setelah masuk.</div>` : '';
    return `<div class="group-title">${judul}</div><div class="card stack">
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

  function opsi(list, pilih, teks) {
    return list.map((r) => `<option value="${r.id}" ${r.id === pilih ? 'selected' : ''}>${esc(teks(r))}</option>`).join('');
  }

  function barisResep(item) {
    const bahan = bahanList();
    const b = item && cari(item.bahanId);
    const hilang = item && item.bahanId && !b ? '<option value="" selected>(bahan sudah dihapus)</option>' : '';
    return `<div class="baris" data-baris="resep">
      <select name="rb" aria-label="Bahan">${hilang}${opsi(bahan, item && item.bahanId, (r) => r.data.nama)}</select>
      <input name="rj" type="number" inputmode="decimal" min="0" step="any" placeholder="Jumlah" aria-label="Jumlah dipakai" value="${item ? esc(item.jumlah) : ''}">
      <span class="unit small muted"></span>
      <button type="button" class="hapus" data-act="hapus-baris" aria-label="Hapus baris">×</button></div>`;
  }

  function barisPaket(item, diriId) {
    const produk = produkList().filter((p) => p.id !== diriId);
    return `<div class="baris" data-baris="paket">
      <select name="pp" aria-label="Produk">${opsi(produk, item && item.produkId, (r) => r.data.nama)}</select>
      <input name="pq" type="number" inputmode="decimal" min="0" step="any" placeholder="Jumlah" aria-label="Jumlah" value="${item ? esc(item.qty) : '1'}">
      <span class="unit small muted">×</span>
      <button type="button" class="hapus" data-act="hapus-baris" aria-label="Hapus baris">×</button></div>`;
  }

  function bukaFormProduk(id) {
    const rec = id ? store.get(id) : null;
    const d = rec ? rec.data : { nama: '', satuan: 'pcs', mode: 'manual', modal: '', harga: '', stok: null };
    const mode = d.mode || 'manual';
    const resep = d.resep || { items: [], hasil: 1, biayaLain: 0 };
    const paket = d.paket || [];
    const adaBahan = bahanList().length > 0;
    const seg = [['manual', 'Isi sendiri'], ['resep', 'Dari resep'], ['paket', 'Paket']]
      .map(([k, l]) => `<button type="button" data-act="mode-modal" data-m="${k}" aria-pressed="${mode === k}">${l}</button>`).join('');
    dialog.innerHTML = `<form id="formProduk" class="stack" method="dialog">
      <div class="row"><h3>${rec ? 'Ubah produk' : 'Produk baru'}</h3><button type="button" class="link" data-act="tutup">Tutup</button></div>
      <label class="field"><span>Nama produk</span><input name="nama" required value="${esc(d.nama)}" placeholder="Contoh: Keripik pedas 100 g"></label>
      <label class="field"><span>Satuan jual</span><input name="satuan" value="${esc(d.satuan || '')}" placeholder="pcs, porsi, gelas"></label>
      <div class="field"><span class="lbl">Modal per satuan</span><div class="seg kecil">${seg}</div></div>
      <input type="hidden" name="mode" value="${mode}">
      <div data-bagian="manual" ${mode === 'manual' ? '' : 'hidden'}>
        <label class="field"><span>Modal per satuan (Rp)</span><input name="modal" type="number" inputmode="decimal" min="0" step="any" value="${mode === 'manual' ? esc(d.modal) : ''}"></label>
      </div>
      <div data-bagian="resep" class="hint stack" ${mode === 'resep' ? '' : 'hidden'}>
        <div class="label">Resep satu adonan</div>
        ${adaBahan ? '' : '<div class="small">Belum ada bahan baku. <button type="button" class="link" data-act="ke-bahan">Tambah bahan dulu</button></div>'}
        <div class="small muted">Pilih bahan dan jumlah yang dipakai, dalam satuan bahan (mis. gram).</div>
        <div id="barisResep" class="stack">${resep.items.length ? resep.items.map(barisResep).join('') : (adaBahan ? barisResep() : '')}</div>
        ${adaBahan ? '<button type="button" class="link" data-act="tambah-bahan-resep">+ Tambah bahan</button>' : ''}
        <div class="two">
          <label class="field"><span>Hasil jadi</span><input name="hasil" type="number" inputmode="decimal" min="1" step="any" value="${esc(resep.hasil || 1)}"></label>
          <label class="field"><span>Biaya lain (Rp)</span><input name="biayaLain" type="number" inputmode="decimal" min="0" step="any" value="${esc(resep.biayaLain || '')}" placeholder="Gas, kemasan"></label>
        </div>
      </div>
      <div data-bagian="paket" class="hint stack" ${mode === 'paket' ? '' : 'hidden'}>
        <div class="label">Isi paket</div>
        <div class="small muted">Gabungkan beberapa produk jadi satu harga. Modal paket = jumlah modal isinya.</div>
        <div id="barisPaket" class="stack">${paket.length ? paket.map((i) => barisPaket(i, id)).join('') : barisPaket(null, id)}</div>
        <button type="button" class="link" data-act="tambah-isi-paket">+ Tambah produk</button>
      </div>
      <div class="row" id="baris-hpp" ${mode === 'manual' ? 'hidden' : ''}><span class="label">Modal per satuan</span><span class="total" id="hpp">–</span></div>
      <div class="hint stack">
        <div class="row"><span class="label">Saran harga jual</span>
          <label class="field sempit"><span class="small">Margin (%)</span><input name="target" type="number" inputmode="decimal" min="1" max="95" value="30"></label></div>
        <div class="pilihan" id="pilihan"></div>
      </div>
      <label class="field"><span>Harga jual (Rp)</span><input name="harga" type="number" inputmode="decimal" min="0" step="any" required value="${esc(d.harga)}"></label>
      <div class="small muted" id="ringkasLaba"></div>
      <label class="field" data-bagian-stok ${mode === 'paket' ? 'hidden' : ''}><span>${mode === 'resep' ? 'Stok produk jadi (kosongkan kalau dibuat saat dipesan)' : 'Stok (kosongkan jika tidak dihitung)'}</span><input name="stok" type="number" inputmode="decimal" step="any" value="${d.stok == null ? '' : esc(d.stok)}"></label>
      <div class="row">
        ${rec ? `<button type="button" class="btn danger" data-act="produk-hapus" data-id="${rec.id}">Hapus</button>` : '<span></span>'}
        <button class="btn primary">Simpan</button>
      </div>
      <input type="hidden" name="produkId" value="${rec ? rec.id : ''}">
    </form>`;
    ui.pilihanHtml = null;
    hitungForm();
    if (!dialog.open) dialog.showModal();
  }

  // Data produk dari isian form (belum disimpan).
  function bacaFormProduk(f) {
    const mode = f.mode.value;
    const d = { nama: f.nama.value.trim(), satuan: f.satuan.value.trim(), mode, harga: num(f.harga.value) };
    if (mode === 'resep') {
      d.resep = {
        items: $$('[data-baris="resep"]', f)
          .map((el) => ({ bahanId: $('[name=rb]', el).value, jumlah: num($('[name=rj]', el).value) }))
          .filter((i) => i.bahanId && i.jumlah > 0),
        hasil: num(f.hasil.value) || 1,
        biayaLain: num(f.biayaLain.value),
      };
    }
    if (mode === 'paket') {
      d.paket = $$('[data-baris="paket"]', f)
        .map((el) => ({ produkId: $('[name=pp]', el).value, qty: num($('[name=pq]', el).value) }))
        .filter((i) => i.produkId && i.qty > 0);
    }
    d.modal = mode === 'manual' ? num(f.modal.value) : H.modalProduk(d, cari);
    const stok = f.stok.value.trim();
    d.stok = mode === 'paket' || stok === '' ? null : num(stok);
    return d;
  }

  function hitungForm() {
    const f = $('#formProduk');
    if (!f) return;
    const d = bacaFormProduk(f);
    $$('[data-baris="resep"]', f).forEach((el) => { $('.unit', el).textContent = satuanBahan(cari($('[name=rb]', el).value)); });
    $('#hpp').textContent = rp(d.modal);
    const pilihan = H.pilihanHarga(d.modal, num(f.target.value));
    const html = d.modal > 0
      ? pilihan.map((p) => `<button type="button" class="pilih" data-act="pilih-harga" data-h="${p.harga}" aria-pressed="${p.harga === d.harga}">
          <span class="small">${p.label}</span><span class="small muted">${p.target}%</span><b>${rp(p.harga)}</b></button>`).join('')
      : '<div class="small muted">Isi modal dulu untuk melihat saran harga.</div>';
    // Jangan ganti tombol yang sama: kalau diganti di antara sentuhan, ketukannya hilang.
    if (ui.pilihanHtml !== html) { $('#pilihan').innerHTML = html; ui.pilihanHtml = html; }
    $('#ringkasLaba').textContent = d.harga > 0
      ? `Laba per satuan ${rp(d.harga - d.modal)} · margin ${angka.format(H.margin(d.modal, d.harga))}%` + (d.harga < d.modal ? ' · harga di bawah modal!' : '')
      : '';
  }

  function gantiModeModal(mode) {
    const f = $('#formProduk');
    f.mode.value = mode;
    $$('[data-act="mode-modal"]', f).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mode)));
    $$('[data-bagian]', f).forEach((el) => { el.hidden = el.dataset.bagian !== mode; });
    $('#baris-hpp').hidden = mode === 'manual';
    const stok = $('[data-bagian-stok]', f);
    stok.hidden = mode === 'paket';
    stok.querySelector('span').textContent = mode === 'resep' ? 'Stok produk jadi (kosongkan kalau dibuat saat dipesan)' : 'Stok (kosongkan jika tidak dihitung)';
    hitungForm();
  }

  // ---------- Form bahan ----------

  function bukaFormBahan(id) {
    const rec = id ? store.get(id) : null;
    const d = rec ? rec.data : { nama: '', satuan: 'gram', isi: 1000, harga: '', stok: null };
    dialog.innerHTML = `<form id="formBahan" class="stack" method="dialog">
      <div class="row"><h3>${rec ? 'Ubah bahan' : 'Bahan baru'}</h3><button type="button" class="link" data-act="tutup">Tutup</button></div>
      <label class="field"><span>Nama bahan</span><input name="nama" required value="${esc(d.nama)}" placeholder="Contoh: Gula pasir"></label>
      <div class="two">
        <label class="field"><span>Satuan pakai</span><input name="satuan" required value="${esc(d.satuan)}" placeholder="gram, ml, butir"></label>
        <label class="field"><span>Isi per kemasan</span><input name="isi" type="number" inputmode="decimal" min="0" step="any" required value="${esc(d.isi)}"></label>
      </div>
      <label class="field"><span>Harga beli per kemasan (Rp)</span><input name="harga" type="number" inputmode="decimal" min="0" step="any" required value="${esc(d.harga)}"></label>
      <div class="small muted" id="hargaSatuan"></div>
      <label class="field"><span>Stok (kosongkan jika tidak dihitung)</span><input name="stok" type="number" inputmode="decimal" step="any" value="${d.stok == null ? '' : esc(d.stok)}"></label>
      <div class="row">
        ${rec ? `<button type="button" class="btn danger" data-act="bahan-hapus" data-id="${rec.id}">Hapus</button>` : '<span></span>'}
        <button class="btn primary">Simpan</button>
      </div>
      <input type="hidden" name="bahanId" value="${rec ? rec.id : ''}">
    </form>`;
    hitungBahan();
    if (!dialog.open) dialog.showModal();
  }

  function hitungBahan() {
    const f = $('#formBahan');
    if (!f) return;
    const per = H.hargaSatuan({ isi: num(f.isi.value), harga: num(f.harga.value) });
    $('#hargaSatuan').textContent = per ? `Harga per ${f.satuan.value || 'satuan'}: ${rupiah.format(per).replace(/,00$/, '')}${per < 1 ? ` (${angka.format(per)})` : ''}` : '';
  }

  // ---------- Dampak perubahan harga bahan ----------

  function bukaDampak() {
    const list = produkBerubah();
    if (!list.length) {
      if (dialog.open) dialog.close();
      render();
      return;
    }
    dialog.innerHTML = `<div class="stack">
      <div class="row"><h3>Cek harga jual</h3><button type="button" class="link" data-act="tutup">Tutup</button></div>
      <div class="small muted">Harga bahan berubah, jadi modal produk ini ikut berubah. Saran harga menjaga margin seperti sebelumnya.</div>
      <ul class="list">${list.map((p) => {
        const d = p.data;
        const baru = modalOf(p);
        const targetLama = H.margin(d.modal, d.harga);
        const saran = H.hargaSaran(baru, targetLama > 0 ? targetLama : 30);
        return `<li class="stack dampak"><div><div class="nama">${esc(d.nama)}</div>
          <div class="small">Modal ${rp(d.modal)} → <b class="${baru > d.modal ? 'warn' : 'ok'}">${rp(baru)}</b></div>
          <div class="small muted">Harga jual ${rp(d.harga)} · margin ${angka.format(targetLama)}% → ${angka.format(H.margin(baru, d.harga))}%</div></div>
          <div class="row"><button class="btn kecil" data-act="dampak-biarkan" data-id="${p.id}">Harga tetap</button>
          ${saran && saran !== d.harga ? `<button class="btn kecil primary" data-act="dampak-pakai" data-id="${p.id}" data-h="${saran}">Jual ${rp(saran)}</button>` : ''}</div></li>`;
      }).join('')}</ul></div>`;
    if (!dialog.open) dialog.showModal();
  }

  function terapkanDampak(id, harga) {
    const p = store.get(id);
    if (!p) return;
    const patch = { modal: modalOf(p) };
    if (harga) patch.harga = harga;
    change(() => store.put('produk', Object.assign({}, p.data, patch), id));
    render();
    bukaDampak();
  }

  // ---------- Produksi ----------

  function bukaProduksi(id) {
    const p = store.get(id);
    if (!p) return;
    dialog.innerHTML = `<form id="formProduksi" class="stack" method="dialog">
      <div class="row"><h3>Produksi</h3><button type="button" class="link" data-act="tutup">Tutup</button></div>
      <div><span class="nama label">${esc(p.data.nama)}</span> <span class="small muted">· stok sekarang ${angka.format(p.data.stok)} ${esc(p.data.satuan || '')}</span></div>
      <label class="field"><span>Berapa kali resep dibuat?</span><input name="batch" type="number" inputmode="decimal" min="0" step="any" value="1" required></label>
      <div class="small muted" id="ringkasProduksi"></div>
      <button class="btn primary block">Tambah ke stok</button>
      <input type="hidden" name="produkId" value="${id}">
    </form>`;
    hitungProduksi();
    if (!dialog.open) dialog.showModal();
  }

  function hitungProduksi() {
    const f = $('#formProduksi');
    if (!f) return;
    const p = cari(f.produkId.value);
    const batch = num(f.batch.value);
    const pakai = Object.entries(H.bahanProduksi(p, batch))
      .map(([bid, n]) => { const b = cari(bid); return b ? `${b.nama} ${angka.format(n)} ${b.satuan}` : null; })
      .filter(Boolean);
    $('#ringkasProduksi').textContent = `Menambah ${angka.format((p.resep.hasil || 1) * batch)} ${p.satuan || ''} ke stok.` +
      (pakai.length ? ` Memakai ${pakai.join(', ')}.` : '');
  }

  // ---------- Pengeluaran ----------

  const hariIni = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function bukaFormPengeluaran(id) {
    const rec = id ? store.get(id) : null;
    const d = rec ? rec.data : { waktu: null, kategori: KATEGORI[0], catatan: '', jumlah: '' };
    const tgl = d.waktu ? (() => { const w = new Date(d.waktu); return `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, '0')}-${String(w.getDate()).padStart(2, '0')}`; })() : hariIni();
    dialog.innerHTML = `<form id="formPengeluaran" class="stack" method="dialog">
      <div class="row"><h3>${rec ? 'Ubah pengeluaran' : 'Catat pengeluaran'}</h3><button type="button" class="link" data-act="tutup">Tutup</button></div>
      <label class="field"><span>Jumlah (Rp)</span><input name="jumlah" type="number" inputmode="numeric" min="0" step="any" required value="${esc(d.jumlah)}"></label>
      <div class="two">
        <label class="field"><span>Jenis</span><select name="kategori">${KATEGORI.map((k) => `<option ${k === d.kategori ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="field"><span>Tanggal</span><input name="tanggal" type="date" required value="${tgl}"></label>
      </div>
      <label class="field"><span>Catatan (boleh kosong)</span><input name="catatan" value="${esc(d.catatan)}" placeholder="Contoh: listrik bulan Oktober"></label>
      <div class="small muted">Belanja bahan baku tidak perlu dicatat di sini, karena sudah dihitung sebagai modal produk yang terjual.</div>
      <div class="row">
        ${rec ? `<button type="button" class="btn danger" data-act="pengeluaran-hapus" data-id="${rec.id}">Hapus</button>` : '<span></span>'}
        <button class="btn primary">Simpan</button>
      </div>
      <input type="hidden" name="pengeluaranId" value="${rec ? rec.id : ''}">
    </form>`;
    if (!dialog.open) dialog.showModal();
  }

  // ---------- Struk ----------

  function strukBaris(t) {
    const p = profil();
    const w = new Date(t.data.waktu).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const bayar = t.data.bayar || t.data.total;
    return {
      judul: p.namaUsaha || 'Struk penjualan',
      kontak: p.kontak || '',
      waktu: w,
      items: t.data.items.map((i) => ({ nama: i.nama, rinci: `${angka.format(i.qty)} × ${rp(i.harga)}`, jumlah: rp(i.qty * i.harga) })),
      total: rp(t.data.total),
      bayar: rp(bayar),
      kembali: rp(Math.max(0, bayar - t.data.total)),
    };
  }

  function strukTeks(s) {
    return [
      `*${s.judul}*`, s.kontak, s.waktu, '',
      ...s.items.map((i) => `${i.nama}\n  ${i.rinci} = ${i.jumlah}`), '',
      `*Total: ${s.total}*`, `Bayar: ${s.bayar}`, `Kembali: ${s.kembali}`, '', 'Terima kasih!',
    ].filter((x, i) => x !== '' || i > 2).join('\n');
  }

  // Gambar struk di canvas, lebar 600 px supaya tajam di WhatsApp.
  function strukGambar(s) {
    const W = 600;
    const pad = 40;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = (ukuran, tebal) => `${tebal ? '700 ' : ''}${ukuran}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    const judulFont = `italic 800 40px "Exo 2", "Segoe UI", sans-serif`;
    const tinggi = 260 + (s.kontak ? 34 : 0) + s.items.length * 70 + 190;
    c.width = W;
    c.height = tinggi;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, tinggi);
    ctx.fillStyle = '#0a2a6e';
    ctx.fillRect(0, 0, W, 12);
    let y = 80;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0a2a6e';
    ctx.font = judulFont;
    ctx.fillText(s.judul, W / 2, y, W - pad * 2);
    ctx.fillStyle = '#5d6a88';
    ctx.font = font(22);
    if (s.kontak) { y += 38; ctx.fillText(s.kontak, W / 2, y, W - pad * 2); }
    y += 36;
    ctx.fillText(s.waktu, W / 2, y);
    y += 36;
    const garis = () => {
      ctx.strokeStyle = '#d2d9e6';
      ctx.setLineDash([8, 8]);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
      ctx.setLineDash([]);
    };
    garis();
    y += 48;
    s.items.forEach((i) => {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#13203f';
      ctx.font = font(26, true);
      ctx.fillText(i.nama, pad, y, W - pad * 2);
      y += 32;
      ctx.font = font(22);
      ctx.fillStyle = '#5d6a88';
      ctx.fillText(i.rinci, pad, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#13203f';
      ctx.fillText(i.jumlah, W - pad, y);
      y += 38;
    });
    y -= 10;
    garis();
    y += 52;
    const baris = (label, nilai, besar) => {
      ctx.textAlign = 'left';
      ctx.fillStyle = besar ? '#0a2a6e' : '#5d6a88';
      ctx.font = font(besar ? 30 : 22, besar);
      ctx.fillText(label, pad, y);
      ctx.textAlign = 'right';
      ctx.fillText(nilai, W - pad, y);
      y += besar ? 44 : 34;
    };
    baris('Total', s.total, true);
    baris('Bayar', s.bayar);
    baris('Kembali', s.kembali);
    y += 16;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0a2a6e';
    ctx.font = font(24, true);
    ctx.fillText('Terima kasih!', W / 2, y);
    return c;
  }

  async function bukaStruk(id) {
    const t = store.get(id);
    if (!t) return;
    if (document.fonts && document.fonts.load) await document.fonts.load('italic 800 40px "Exo 2"').catch(() => {});
    const s = strukBaris(t);
    const canvas = strukGambar(s);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
    if (ui.struk && ui.struk.url) URL.revokeObjectURL(ui.struk.url);
    const nama = `struk-${t.data.waktu.slice(0, 16).replace(/[-:T]/g, '')}.png`;
    ui.struk = { blob, url: URL.createObjectURL(blob), teks: strukTeks(s), nama };
    const file = blob && window.File ? new File([blob], nama, { type: 'image/png' }) : null;
    const bisaBagi = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    dialog.innerHTML = `<div class="stack">
      <div class="row"><h3>Struk</h3><button type="button" class="link" data-act="tutup">Tutup</button></div>
      <img class="struk" id="strukGambar" src="${ui.struk.url}" alt="Struk penjualan ${esc(s.total)}">
      ${bisaBagi ? '<button class="btn primary block" data-act="struk-bagikan">Kirim gambar lewat WhatsApp</button>' : ''}
      <a class="btn ${bisaBagi ? '' : 'primary'} block" href="${ui.struk.url}" download="${nama}">Simpan gambar</a>
      <a class="btn block" href="https://wa.me/?text=${encodeURIComponent(ui.struk.teks)}" target="_blank" rel="noopener">Kirim sebagai teks</a>
      ${bisaBagi ? '' : '<div class="small muted">Simpan gambarnya, lalu kirim dari WhatsApp seperti mengirim foto.</div>'}
    </div>`;
    if (!dialog.open) dialog.showModal();
  }

  async function bagikanStruk() {
    if (!ui.struk) return;
    const file = new File([ui.struk.blob], ui.struk.nama, { type: 'image/png' });
    try {
      await navigator.share({ files: [file], text: ui.struk.teks.split('\n')[0].replace(/\*/g, '') });
    } catch (e) { /* pengguna membatalkan */ }
  }

  // ---------- Aksi ----------

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // Tambah atau kurangi stok produk dan bahan sesuai `potong` (tanda -1 = kurangi).
  function ubahStok(potong, tanda) {
    Object.entries(potong.produk || {}).forEach(([id, n]) => {
      const p = store.get(id);
      if (p && p.data.stok != null) store.put('produk', Object.assign({}, p.data, { stok: p.data.stok + tanda * n }), id);
    });
    Object.entries(potong.bahan || {}).forEach(([id, n]) => {
      const b = store.get(id);
      if (b && b.data.stok != null) store.put('bahan', Object.assign({}, b.data, { stok: b.data.stok + tanda * n }), id);
    });
  }

  function simpanPenjualan() {
    const items = isiKeranjang().filter((x) => x.qty > 0);
    if (!items.length) return;
    const total = items.reduce((s, x) => s + x.rec.data.harga * x.qty, 0);
    const baris = items.map((x) => ({ produkId: x.rec.id, nama: x.rec.data.nama, qty: x.qty, harga: x.rec.data.harga, modal: modalOf(x.rec) }));
    const laba = baris.reduce((s, i) => s + (i.harga - i.modal) * i.qty, 0);
    const potong = H.potonganKeranjang(ui.cart, cari);
    let rec;
    change(() => {
      rec = store.put('transaksi', {
        waktu: new Date().toISOString(),
        items: baris,
        total,
        laba,
        bayar: num(ui.bayar) || total,
        potong,
      });
      ubahStok(potong, -1);
    });
    ui.cart = {};
    ui.bayar = '';
    ui.trxTerakhir = rec.id;
    render();
    toast(`Penjualan ${rp(total)} tersimpan`);
  }

  function batalTransaksi(id) {
    const t = store.get(id);
    if (!t || !confirm('Batalkan penjualan ini? Stok produk dan bahan akan dikembalikan.')) return;
    change(() => {
      if (t.data.potong) {
        ubahStok(t.data.potong, 1);
      } else {
        // Penjualan dari versi lama: hanya stok produk yang dipotong.
        t.data.items.forEach((i) => {
          const p = store.get(i.produkId);
          if (p && p.data.stok != null) store.put('produk', Object.assign({}, p.data, { stok: p.data.stok + i.qty }), p.id);
        });
      }
      store.remove(id);
    });
    if (ui.trxTerakhir === id) ui.trxTerakhir = null;
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
      case 'produk-tab': ui.produkTab = el.dataset.t; render(); break;
      case 'tutup': dialog.close(); break;
      case 'mode-modal': gantiModeModal(el.dataset.m); break;
      case 'tambah-bahan-resep': $('#barisResep').insertAdjacentHTML('beforeend', barisResep()); hitungForm(); break;
      case 'tambah-isi-paket': $('#barisPaket').insertAdjacentHTML('beforeend', barisPaket(null, $('#formProduk').produkId.value)); hitungForm(); break;
      case 'hapus-baris': el.closest('.baris').remove(); hitungForm(); break;
      case 'ke-bahan': dialog.close(); ui.view = 'produk'; ui.produkTab = 'bahan'; render(); bukaFormBahan(); break;
      case 'pilih-harga': {
        const f = $('#formProduk');
        f.harga.value = el.dataset.h;
        hitungForm();
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
      case 'bahan-baru': bukaFormBahan(); break;
      case 'bahan-ubah': bukaFormBahan(id); break;
      case 'bahan-hapus': {
        const dipakai = produkList().filter((p) => p.data.resep && (p.data.resep.items || []).some((i) => i.bahanId === id));
        const tanya = dipakai.length
          ? `Bahan ini dipakai di resep ${dipakai.map((p) => p.data.nama).join(', ')}. Kalau dihapus, modal produk itu tidak lagi menghitung bahan ini. Tetap hapus?`
          : 'Hapus bahan ini?';
        if (confirm(tanya)) {
          change(() => store.remove(id));
          dialog.close();
          render();
        }
        break;
      }
      case 'dampak': bukaDampak(); break;
      case 'dampak-pakai': terapkanDampak(id, num(el.dataset.h)); break;
      case 'dampak-biarkan': terapkanDampak(id, 0); break;
      case 'produksi': bukaProduksi(id); break;
      case 'pengeluaran-baru': bukaFormPengeluaran(); break;
      case 'pengeluaran-ubah': bukaFormPengeluaran(id); break;
      case 'pengeluaran-hapus':
        if (confirm('Hapus pengeluaran ini?')) {
          change(() => store.remove(id));
          dialog.close();
          render();
        }
        break;
      case 'struk': bukaStruk(id); break;
      case 'struk-bagikan': bagikanStruk(); break;
      case 'tambah-keranjang':
        if (!bisaTambah(id)) break;
        ui.cart[id] = (ui.cart[id] || 0) + 1;
        ui.trxTerakhir = null;
        render();
        break;
      case 'kurang':
        ui.cart[id] = (ui.cart[id] || 0) - 1;
        if (ui.cart[id] <= 0) delete ui.cart[id];
        render();
        break;
      case 'ke-keranjang': {
        const k = $('#keranjang');
        if (k) k.scrollIntoView({ behavior: 'smooth' });
        break;
      }
      case 'kosongkan': ui.cart = {}; ui.bayar = ''; render(); break;
      case 'simpan-penjualan': simpanPenjualan(); break;
      case 'batal-trx': batalTransaksi(id); break;
      case 'periode': ui.periode = el.dataset.p; render(); break;
      case 'simpan-profil':
        change(() => store.put('profil', { namaUsaha: $('#namaUsahaInput').value.trim(), kontak: $('#kontakUsahaInput').value.trim() }, 'profil'));
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
    const form = e.target.form && e.target.form.id;
    if (form === 'formProduk') hitungForm();
    if (form === 'formBahan') hitungBahan();
    if (form === 'formProduksi') hitungProduksi();
  });

  // Pilihan di <select> memicu `change`, bukan `input`, di sebagian browser.
  document.addEventListener('change', (e) => {
    if (e.target.form && e.target.form.id === 'formProduk') hitungForm();
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id === 'formProduk') {
      e.preventDefault();
      const d = bacaFormProduk(f);
      if (d.mode === 'resep' && !d.resep.items.length) { toast('Tambahkan minimal satu bahan ke resep'); return; }
      if (d.mode === 'paket' && !d.paket.length) { toast('Tambahkan minimal satu produk ke paket'); return; }
      change(() => store.put('produk', d, f.produkId.value || undefined));
      dialog.close();
      render();
      toast('Produk tersimpan');
    }
    if (f.id === 'formBahan') {
      e.preventDefault();
      const id = f.bahanId.value;
      const stok = f.stok.value.trim();
      const d = {
        nama: f.nama.value.trim(),
        satuan: f.satuan.value.trim(),
        isi: num(f.isi.value),
        harga: num(f.harga.value),
        stok: stok === '' ? null : num(stok),
      };
      change(() => store.put('bahan', d, id || undefined));
      toast('Bahan tersimpan');
      if (produkBerubah().length) {
        render();
        bukaDampak();
      } else {
        dialog.close();
        render();
      }
    }
    if (f.id === 'formProduksi') {
      e.preventDefault();
      const id = f.produkId.value;
      const p = store.get(id);
      const batch = num(f.batch.value);
      if (p && batch > 0) {
        change(() => {
          store.put('produk', Object.assign({}, p.data, { stok: p.data.stok + (p.data.resep.hasil || 1) * batch }), id);
          ubahStok({ bahan: H.bahanProduksi(p.data, batch) }, -1);
        });
        toast('Stok bertambah');
      }
      dialog.close();
      render();
    }
    if (f.id === 'formPengeluaran') {
      e.preventDefault();
      const [th, bl, tg] = f.tanggal.value.split('-').map(Number);
      // Jam 12 siang supaya tanggalnya tidak bergeser karena zona waktu.
      const waktu = new Date(th, bl - 1, tg, 12).toISOString();
      change(() => store.put('pengeluaran', {
        waktu,
        kategori: f.kategori.value,
        catatan: f.catatan.value.trim(),
        jumlah: num(f.jumlah.value),
      }, f.pengeluaranId.value || undefined));
      dialog.close();
      render();
      toast('Pengeluaran tersimpan');
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
  window.Kelola = { store, cloud, ui, H };
})();
