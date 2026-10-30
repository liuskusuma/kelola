(function () {
  'use strict';

  const store = KelolaStore.createStore(window.localStorage);
  const H = KelolaHitung;
  const P = KelolaPenjualan;
  const W = KelolaWarna;
  const G = KelolaGrafik;
  const S = KelolaStaff;
  const config = window.KELOLA_CONFIG || {};
  const cloudReady = !!(config.supabaseUrl && config.supabaseAnonKey && window.supabase);

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const viewEl = $('#view');
  const dialog = $('#dialog');

  // Pengaturan tampilan dan bahasa disimpan per perangkat, bukan di cloud.
  const setel = KelolaBahasa.bacaPengaturan(window.localStorage);
  let t = KelolaBahasa.buat(setel.bahasa);
  const lokal = () => (setel.bahasa === 'en' ? 'en-GB' : 'id-ID');

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
    metode: 'tunai', // tunai | qris | nanti
    pelanggan: { nama: '', wa: '' }, // untuk "bayar nanti"
    trxTerakhir: null, // penjualan yang baru disimpan, untuk tombol struk
    produkTab: 'produk', // produk | bahan
    periode: 'hari',
    dari: '', // periode pilihan sendiri (YYYY-MM-DD)
    sampai: '',
    lipat: {}, // bagian Akun yang sedang dibuka
    grafik: null, // data grafik laporan yang sedang tampil, untuk keterangan saat disentuh
    authMode: 'masuk',
    authMsg: null,
    authEmail: '',
    struk: null, // { blob, url, teks }
    foto: null, // foto produk di form yang sedang dibuka (data URL)
    kunciMsg: null,
    gabungMsg: null,
    staff: { list: null, kode: null, msg: null, belumSiap: false, memuat: false }, // daftar staff untuk owner
  };

  const cloud = {
    client: null,
    user: null,
    sync: null,
    status: 'idle', // idle | syncing | synced | error
    lastSynced: null,
    lastError: null,
    recovering: false,
    peran: null, // 'owner' | 'staff' setelah masuk
    staffApi: null,
  };

  // Data kasir untuk akun staff (lihat js/staff.js). Kosong untuk owner.
  let kasirStaff = null;

  const modeStaff = () => cloud.peran === 'staff' && !!kasirStaff;
  // Mode kasir dengan PIN di HP bersama.
  const modeKunci = () => !!setel.kunci;
  const hanyaKasir = () => modeStaff() || modeKunci();

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

  // Profil usaha: milik sendiri, atau milik owner kalau masuk sebagai staff.
  const usaha = () => (modeStaff() ? kasirStaff.usaha || {} : profil());

  // Produk dan penjualan yang dipakai layar kasir. Staff memakai salinan dari owner tanpa modal.
  function produkKasir() {
    if (!modeStaff()) return produkList();
    return kasirStaff.produk.map((d) => ({ id: d.id, data: d })).sort(urutNama);
  }

  function ambilKasir(id) {
    if (!modeStaff()) return store.get(id);
    const d = kasirStaff.produk.find((x) => x.id === id);
    return d ? { id, data: d } : null;
  }

  const cariKasir = (id) => { const r = ambilKasir(id); return r ? r.data : null; };

  function ambilTransaksi(id) {
    if (!modeStaff()) return store.get(id);
    const d = kasirStaff.jualan.find((x) => x.id === id);
    return d ? { id, data: d } : null;
  }

  function simpanKasirStaff() {
    S.simpanKasir(window.localStorage, kasirStaff);
  }

  function change(fn) {
    fn();
    scheduleSync();
  }

  const satuanBahan = (b) => esc((b && b.satuan) || '');

  // ---------- Pengaturan ----------

  function terapkanTema() {
    document.documentElement.dataset.tema = setel.tema;
    document.documentElement.lang = setel.bahasa;
    const gelap = setel.tema === 'gelap' || (setel.tema === 'otomatis' && matchMedia('(prefers-color-scheme: dark)').matches);
    const tm = temaUsaha();
    $$('meta[name="theme-color"]').forEach((m) => {
      m.content = tm ? tm[gelap ? 'gelap' : 'terang']['--bg'] : gelap ? '#14234f' : '#f2f5fa';
      m.removeAttribute('media');
    });
  }

  // Warna dan logo usaha (dipilih owner di Akun). Berlaku juga di HP staff.
  const temaUsaha = () => { const w = usaha().warna; return w && w.utama ? W.tema(w) : null; };
  let temaTerpasang = null;

  function terapkanWarnaUsaha() {
    const tm = temaUsaha();
    const kunci = tm ? JSON.stringify(tm) : '';
    if (kunci !== temaTerpasang) {
      temaTerpasang = kunci;
      let el = $('#temaUsaha');
      if (!el) { el = document.createElement('style'); el.id = 'temaUsaha'; document.head.appendChild(el); }
      const vars = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v};`).join(' ');
      el.textContent = tm ? `:root { ${vars(tm.terang)} }
        :root[data-tema="gelap"] { ${vars(tm.gelap)} }
        @media (prefers-color-scheme: dark) { :root[data-tema="otomatis"] { ${vars(tm.gelap)} } }` : '';
      terapkanTema();
    }
    const logo = $('header.nav .logo');
    const src = usaha().logo || 'icons/logo.svg';
    if (logo.getAttribute('src') !== src) logo.setAttribute('src', src);
  }

  function ubahPengaturan(patch) {
    Object.assign(setel, patch);
    KelolaBahasa.simpanPengaturan(window.localStorage, setel);
    t = KelolaBahasa.buat(setel.bahasa);
    terapkanTema();
    render();
  }

  // ---------- Tampilan ----------

  const JUDUL = {
    kasir: ['Kasir', 'Catat penjualan'],
    produk: ['Produk', 'Harga jual, resep & stok'],
    laporan: ['Laporan', 'Omzet, pengeluaran & laba'],
    akun: ['Akun', 'Profil, pengaturan & cloud'],
  };

  function render() {
    if (hanyaKasir() && (ui.view === 'produk' || ui.view === 'laporan')) ui.view = 'kasir';
    document.querySelectorAll('nav.tabs button').forEach((b) => {
      b.hidden = hanyaKasir() && (b.dataset.go === 'produk' || b.dataset.go === 'laporan');
      if (b.dataset.go === ui.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
      $('.teks', b).textContent = t(JUDUL[b.dataset.go][0]);
    });
    $('nav.tabs').setAttribute('aria-label', t('Menu utama'));
    const [judul, sub] = JUDUL[ui.view];
    $('#judul').textContent = t(judul);
    $('#subjudul').textContent = usaha().namaUsaha || t(sub);
    document.body.classList.toggle('hanya-kasir', hanyaKasir());
    terapkanWarnaUsaha();
    renderBadge();
    renderSummary();
    const views = { kasir: viewKasir, produk: viewProduk, laporan: viewLaporan, akun: viewAkun };
    viewEl.innerHTML = views[ui.view]();
  }

  function renderBadge() {
    const badge = $('#syncBadge');
    let text = t('Lokal');
    let title = t('Data hanya tersimpan di perangkat ini. Masuk untuk menyimpan ke cloud.');
    let cls = '';
    if (cloud.user) {
      const pending = modeStaff() ? kasirStaff.antrian.length : store.dirtyRecords().length;
      const belum = t('{n} perubahan belum terkirim', { n: pending });
      if (!navigator.onLine) { text = t('Offline'); title = pending ? belum : t('Tidak ada koneksi'); cls = 'warn'; }
      else if (cloud.status === 'syncing') { text = t('Sinkron…'); title = t('Menyinkronkan'); cls = 'busy'; }
      else if (cloud.status === 'error') { text = t('Gagal'); title = t('Gagal sinkron'); cls = 'err'; }
      else if (pending) { text = t('{n} tertunda', { n: pending }); title = belum; cls = 'warn'; }
      else { text = t('Tersimpan'); title = t('Semua data tersimpan di cloud'); cls = 'ok'; }
    }
    badge.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
    badge.title = title;
    badge.setAttribute('aria-label', title);
    badge.className = 'sync ' + cls;
  }

  function isiKeranjang() {
    return Object.entries(ui.cart)
      .map(([id, qty]) => ({ rec: ambilKasir(id), qty }))
      .filter((x) => x.rec);
  }

  // Bar navy di atas tab bar, seperti bar total di Bagi Rata.
  function renderSummary() {
    const items = ui.view === 'kasir' ? isiKeranjang() : [];
    const qty = items.reduce((s, x) => s + x.qty, 0);
    const total = items.reduce((s, x) => s + x.rec.data.harga * x.qty, 0);
    document.body.classList.toggle('ada-ringkasan', qty > 0);
    $('#summary').innerHTML = `<span>${t('Keranjang · {n} item', { n: angka.format(qty) })}</span><b>${rp(total)} ›</b>`;
  }

  // Bisa ditambah satu lagi ke keranjang tanpa melebihi stok?
  function bisaTambah(id) {
    const cart = Object.assign({}, ui.cart);
    cart[id] = (cart[id] || 0) + 1;
    return H.stokCukup(cart, cariKasir);
  }

  const fotoKecil = (d) => (d.foto ? `<img class="thumb" src="${esc(d.foto)}" alt="">` : '');

  function viewKasir() {
    const produk = produkKasir();
    if (!produk.length) {
      if (hanyaKasir()) {
        return `<div class="group-title">${t('Mulai berjualan')}</div><div class="card empty">${t('Belum ada produk. Minta owner menambahkan produk dulu.')}</div>`;
      }
      return `<div class="group-title">${t('Mulai berjualan')}</div><div class="card empty stack">
        <div>${t('Belum ada produk. Tambahkan produk dulu, lalu ketuk produk di sini setiap kali ada pembeli.')}</div>
        <button class="btn primary" data-act="produk-baru">${t('Tambah produk pertama')}</button></div>`;
    }
    const items = isiKeranjang();
    const total = items.reduce((s, x) => s + x.rec.data.harga * x.qty, 0);
    const bayar = num(ui.bayar);
    const tiles = produk.map((p) => {
      const d = p.data;
      const habis = !bisaTambah(p.id);
      const stok = d.stok != null && d.mode !== 'paket' ? `<div class="small muted">${t('Stok')} ${angka.format(d.stok)} ${esc(d.satuan || '')}</div>` : '';
      const jumlah = ui.cart[p.id] ? `<span class="jumlah">${ui.cart[p.id]}</span>` : '';
      const foto = d.foto ? `<img class="foto" src="${esc(d.foto)}" alt="">` : '';
      return `<button class="tile ${d.foto ? 'ada-foto' : ''}" data-act="tambah-keranjang" data-id="${p.id}" ${habis ? 'disabled' : ''}>
        ${jumlah}${foto}<div class="isi"><div class="nama">${esc(d.nama)}</div><div class="harga">${rp(d.harga)}</div>${stok}</div></button>`;
    }).join('');
    const terakhir = !items.length && ui.trxTerakhir && ambilTransaksi(ui.trxTerakhir);
    const info = terakhir
      ? `<div class="card row" id="trxTerakhir"><div><div class="nama label">${t('Penjualan {total} tersimpan', { total: rp(terakhir.data.total) })}</div>
          <div class="small muted">${t('Kirim struk ke pembeli lewat WhatsApp.')}</div></div>
          <button class="btn kecil primary" data-act="struk" data-id="${terakhir.id}">${t('Struk')}</button></div>`
      : '';
    const cart = items.length
      ? `<div class="group-title" id="keranjang">${t('Keranjang')}</div><div class="card">
        <ul class="list">${items.map((x) => `<li class="row">
          <div class="dengan-foto">${fotoKecil(x.rec.data)}<div><div class="nama">${esc(x.rec.data.nama)}</div><div class="small muted">${rp(x.rec.data.harga)} × ${x.qty} = ${rp(x.rec.data.harga * x.qty)}</div></div></div>
          <div class="qty"><button data-act="kurang" data-id="${x.rec.id}" aria-label="${t('Kurangi')}">−</button><span>${x.qty}</span>
          <button data-act="tambah-keranjang" data-id="${x.rec.id}" aria-label="${t('Tambah')}" ${bisaTambah(x.rec.id) ? '' : 'disabled'}>+</button></div></li>`).join('')}</ul>
        <div class="row" style="margin-top:8px"><span class="label">${t('Total')}</span><span class="total">${rp(total)}</span></div>
        <div class="seg kecil" id="metodeBayar" role="group" aria-label="${t('Cara bayar')}" style="margin:14px 0 0">${[['tunai', t('Tunai')], ['qris', t('QRIS')], ['nanti', t('Bayar nanti')]]
          .map(([k, l]) => `<button data-act="metode" data-m="${k}" aria-pressed="${ui.metode === k}">${l}</button>`).join('')}</div>
        ${isianBayar(total, bayar)}
        <div class="row" style="margin-top:16px">
          <button class="btn" data-act="kosongkan">${t('Kosongkan')}</button>
          <button class="btn primary" data-act="simpan-penjualan">${t(ui.metode === 'qris' ? 'Sudah dibayar, simpan' : ui.metode === 'nanti' ? 'Simpan sebagai tagihan' : 'Simpan penjualan')}</button>
        </div></div>`
      : '';
    const petunjuk = items.length ? '' : `<div class="foot" style="margin:0 8px 14px">${t('Ketuk produk untuk menambahkannya ke keranjang.')}</div>`;
    return `${info}${cart}<div class="group-title">${t('Produk')}</div>${petunjuk}<div class="grid">${tiles}</div>`;
  }

  // Isian di keranjang sesuai cara bayar.
  function isianBayar(total, bayar) {
    if (ui.metode === 'qris') {
      return usaha().qris
        ? `<button class="btn block" style="margin-top:14px" data-act="qris">${t('Tampilkan QRIS')}</button>
           <div class="small muted" style="margin-top:8px">${t('Simpan setelah pembayaran masuk ke rekening atau e-wallet Anda.')}</div>`
        : `<div class="small muted" style="margin-top:14px">${t('Owner belum menyimpan gambar QRIS di Akun. Simpan setelah pembayaran masuk.')}</div>`;
    }
    if (ui.metode === 'nanti') {
      const kenal = modeStaff() ? [] : daftarPelanggan();
      return `<div class="two" style="margin-top:14px">
          <label class="field"><span>${t('Nama pembeli')}</span><input id="pelangganNama" list="daftarPelanggan" autocomplete="off" value="${esc(ui.pelanggan.nama)}" placeholder="${t('Contoh: Bu Ani')}"></label>
          <label class="field"><span>${t('No. WhatsApp (boleh kosong)')}</span><input id="pelangganWa" type="tel" inputmode="tel" value="${esc(ui.pelanggan.wa)}" placeholder="0812…"></label>
        </div>
        <datalist id="daftarPelanggan">${kenal.map((p) => `<option value="${esc(p.nama)}">`).join('')}</datalist>
        <div class="small muted" style="margin-top:8px">${t('Penjualan dicatat sebagai tagihan. Tagih lewat WhatsApp dan tandai lunas di Laporan.')}</div>`;
    }
    return `<div class="two" style="margin-top:14px">
          <label class="field"><span>${t('Uang diterima')}</span><input id="bayar" type="number" inputmode="numeric" min="0" value="${esc(ui.bayar)}" placeholder="${total}"></label>
          <div class="field"><span class="lbl">${t('Kembalian')}</span><div class="total" id="kembalian" style="padding:6px 4px">${bayar >= total ? rp(bayar - total) : '–'}</div></div>
        </div>`;
  }

  // Pelanggan yang pernah "bayar nanti", terbaru dulu, untuk isian otomatis.
  function daftarPelanggan() {
    const map = new Map();
    store.list('transaksi').filter((r) => r.data.pelanggan)
      .sort((a, b) => b.data.waktu.localeCompare(a.data.waktu))
      .forEach((r) => { const k = r.data.pelanggan.nama.toLowerCase(); if (!map.has(k)) map.set(k, r.data.pelanggan); });
    return [...map.values()];
  }

  function viewProduk() {
    const seg = [['produk', t('Produk')], ['bahan', t('Bahan baku')]]
      .map(([k, l]) => `<button data-act="produk-tab" data-t="${k}" aria-pressed="${ui.produkTab === k}">${l}</button>`).join('');
    return `<div class="seg" style="margin-top:10px">${seg}</div>${ui.produkTab === 'bahan' ? viewBahan() : viewDaftarProduk()}`;
  }

  function viewDaftarProduk() {
    const produk = produkList();
    const berubah = produkBerubah();
    const peringatan = berubah.length
      ? `<div class="card stack peringatan"><div><span class="label">${t('Harga bahan berubah')}</span>
          <div class="small muted">${t('Modal {n} produk ikut berubah. Cek apakah harga jualnya masih menguntungkan.', { n: berubah.length })}</div></div>
          <button class="btn primary block" data-act="dampak">${t('Cek harga jual')}</button></div>`
      : '';
    const list = produk.length
      ? `<ul class="list">${produk.map((p) => {
          const d = p.data;
          const modal = modalOf(p);
          const m = H.margin(modal, d.harga);
          const stok = d.stok != null && d.mode !== 'paket' ? ` · ${t('stok')} ${angka.format(d.stok)} ${esc(d.satuan || '')}` : '';
          const jenis = d.mode === 'resep' ? `<span class="tag">${t('Resep')}</span>` : d.mode === 'paket' ? `<span class="tag">${t('Paket')}</span>` : '';
          const naik = pakaiResep(d) && Math.abs(modal - (d.modal || 0)) >= 1
            ? `<div class="small warn">${t(modal > d.modal ? 'Modal naik dari {x}' : 'Modal turun dari {x}', { x: rp(d.modal) })}</div>` : '';
          const rugi = d.harga < modal ? `<div class="small err">${t('Harga jual di bawah modal!')}</div>` : '';
          const produksi = d.mode === 'resep' && d.stok != null
            ? `<button class="btn kecil" data-act="produksi" data-id="${p.id}">${t('Produksi')}</button>` : '';
          return `<li class="row"><div class="dengan-foto">${fotoKecil(d)}<div><div class="nama">${esc(d.nama)} ${jenis}</div>
            <div class="small muted">${t('Modal {modal} · jual {harga} · laba {laba} ({m}%)', { modal: rp(modal), harga: rp(d.harga), laba: rp(d.harga - modal), m: angka.format(m) })}${stok}</div>${naik}${rugi}</div></div>
            <div class="aksi">${produksi}<button class="btn kecil" data-act="produk-ubah" data-id="${p.id}">${t('Ubah')}</button></div></li>`;
        }).join('')}</ul>`
      : `<div class="empty">${t('Belum ada produk. Tambahkan produk untuk menghitung harga jual dan mulai berjualan.')}</div>`;
    return `${peringatan}<div class="group-title"><span>${t('Daftar produk')}</span><button class="link tambah" data-act="produk-baru">${t('+ Tambah produk')}</button></div>
      <div class="card">${list}</div>
      <div class="foot">${t('Modal bisa diisi sendiri, dihitung dari resep bahan baku, atau dari isi paket. Harga jual disarankan dari target margin.')}</div>`;
  }

  function viewBahan() {
    const bahan = bahanList();
    const list = bahan.length
      ? `<ul class="list">${bahan.map((b) => {
          const d = b.data;
          const stok = d.stok != null ? ` · ${t('stok')} ${angka.format(d.stok)} ${satuanBahan(d)}` : '';
          const tipis = d.stok != null && d.stok <= 0 ? `<div class="small err">${t('Stok habis')}</div>` : '';
          return `<li class="row"><div><div class="nama">${esc(d.nama)}</div>
            <div class="small muted">${rp(d.harga)} / ${angka.format(d.isi)} ${satuanBahan(d)} · ${rp(H.hargaSatuan(d))} ${t('per')} ${satuanBahan(d)}${stok}</div>${tipis}</div>
            <button class="btn kecil" data-act="bahan-ubah" data-id="${b.id}">${t('Ubah')}</button></li>`;
        }).join('')}</ul>`
      : `<div class="empty">${t('Belum ada bahan baku. Catat bahan dan harga belinya supaya modal produk dihitung otomatis dari resep.')}</div>`;
    return `<div class="group-title"><span>${t('Bahan baku')}</span><button class="link tambah" data-act="bahan-baru">${t('+ Tambah bahan')}</button></div>
      <div class="card">${list}</div>
      <div class="foot">${t('Kalau harga bahan naik, ubah harganya di sini. Kelola akan menunjukkan produk mana yang modalnya ikut naik.')}</div>`;
  }

  function rentang(periode) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (periode === '7hari') start.setDate(start.getDate() - 6);
    if (periode === 'bulan') start.setDate(1);
    if (periode === 'semua') return 0;
    return start.getTime();
  }

  const tanggalIni = (d) => {
    const dua = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())}`;
  };

  // Awal dan akhir (tidak termasuk) periode laporan, dalam milidetik.
  function rentangLaporan() {
    if (ui.periode !== 'pilih') return [rentang(ui.periode), Infinity];
    const now = new Date();
    if (!ui.dari) ui.dari = tanggalIni(new Date(now.getFullYear(), now.getMonth(), 1));
    if (!ui.sampai) ui.sampai = tanggalIni(now);
    if (ui.dari > ui.sampai) [ui.dari, ui.sampai] = [ui.sampai, ui.dari];
    const [y1, m1, d1] = ui.dari.split('-').map(Number);
    const [y2, m2, d2] = ui.sampai.split('-').map(Number);
    return [new Date(y1, m1 - 1, d1).getTime(), new Date(y2, m2 - 1, d2 + 1).getTime()];
  }

  // Disimpan dalam Bahasa Indonesia; ditampilkan sesuai bahasa yang dipilih.
  const KATEGORI = ['Sewa tempat', 'Listrik & air', 'Gaji', 'Transportasi', 'Iklan & promosi', 'Peralatan', 'Lainnya'];

  function viewLaporan() {
    const [from, to] = rentangLaporan();
    const dalam = (r) => { const w = Date.parse(r.data.waktu); return w >= from && w < to; };
    const urut = (a, b) => b.data.waktu.localeCompare(a.data.waktu);
    const trx = store.list('transaksi').filter(dalam).sort(urut);
    const keluar = store.list('pengeluaran').filter(dalam).sort(urut);
    const omzet = trx.reduce((s, r) => s + r.data.total, 0);
    const laba = trx.reduce((s, r) => s + r.data.laba, 0);
    const biaya = keluar.reduce((s, r) => s + r.data.jumlah, 0);
    const bersih = laba - biaya;
    const terjual = {};
    trx.forEach((r) => r.data.items.forEach((i) => {
      terjual[i.nama] = terjual[i.nama] || { qty: 0, omzet: 0 };
      terjual[i.nama].qty += i.qty;
      terjual[i.nama].omzet += i.qty * i.harga;
    }));
    const top = Object.entries(terjual).sort((a, b) => b[1].omzet - a[1].omzet).slice(0, 5);
    const seg = [['hari', t('Hari ini')], ['7hari', t('7 hari')], ['bulan', t('Bulan ini')], ['semua', t('Semua')], ['pilih', t('Tanggal')]]
      .map(([k, l]) => `<button data-act="periode" data-p="${k}" aria-pressed="${ui.periode === k}">${l}</button>`).join('');
    const pilihTanggal = ui.periode === 'pilih'
      ? `<div class="card two" id="pilihTanggal" style="margin-bottom:18px">
          <label class="field"><span>${t('Dari tanggal')}</span><input type="date" data-tanggal="dari" value="${esc(ui.dari)}" max="${esc(ui.sampai)}"></label>
          <label class="field"><span>${t('Sampai tanggal')}</span><input type="date" data-tanggal="sampai" value="${esc(ui.sampai)}" min="${esc(ui.dari)}"></label></div>`
      : '';
    const fmtWaktu = (iso) => new Date(iso).toLocaleString(lokal(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const fmtTanggal = (iso) => new Date(iso).toLocaleDateString(lokal(), { day: 'numeric', month: 'short' });
    // Naik/turun dibanding periode sebelumnya yang sama panjang.
    const lalu = G.periodeLalu(ui.periode, from, to, Date.now());
    const trxLalu = lalu ? store.list('transaksi').filter((r) => { const w = Date.parse(r.data.waktu); return w >= lalu[0] && w < lalu[1]; }) : [];
    const banding = t({ hari: 'vs kemarin', '7hari': 'vs minggu lalu', bulan: 'vs bulan lalu', pilih: 'vs periode sebelumnya' }[ui.periode] || '');
    const tren = (kini, dulu) => {
      const p = lalu && G.perubahan(kini, dulu);
      if (!p) return '';
      const teks = p.arah === 'sama' ? `= ${t('sama')}` : `${p.arah === 'naik' ? '▲' : '▼'} ${p.persen === null ? t(p.arah) : p.persen + '%'}`;
      return `<div class="tren ${p.arah}">${teks} <span>${banding}</span></div>`;
    };
    const jumlah = (daftar, f) => daftar.reduce((s, r) => s + f(r.data), 0);
    const grafik = viewGrafik(trx, from, to);
    return `<div class="group-title">${t('Periode')}</div><div class="seg periode">${seg}</div>${pilihTanggal}
      <div class="stats">
        <div class="stat utama"><div class="lbl">${t('Omzet')}</div><div class="value">${rp(omzet)}</div>${tren(omzet, jumlah(trxLalu, (d) => d.total))}</div>
        <div class="stat"><div class="lbl">${t('Laba kotor')}</div><div class="value">${rp(laba)}</div>${tren(laba, jumlah(trxLalu, (d) => d.laba))}</div>
        <div class="stat" id="statPengeluaran"><div class="lbl">${t('Pengeluaran')}</div><div class="value">${rp(biaya)}</div></div>
        <div class="stat" id="labaBersih"><div class="lbl">${t('Laba bersih')}</div><div class="value ${bersih < 0 ? 'err' : ''}">${rp(bersih)}</div></div>
        <div class="stat"><div class="lbl">${t('Transaksi')}</div><div class="value">${trx.length}</div>${tren(trx.length, trxLalu.length)}</div>
        <div class="stat"><div class="lbl">${t('Margin rata-rata')}</div><div class="value">${omzet ? angka.format((laba / omzet) * 100) + '%' : '–'}</div></div>
      </div>
      <div class="foot">${t('Laba kotor = omzet dikurangi modal barang yang terjual. Laba bersih = laba kotor dikurangi pengeluaran.')}</div>
      ${viewSorotan(trx, top)}
      ${grafik}
      ${viewTagihan()}
      <div class="group-title">${t('Produk terlaris')}</div>
      <div class="card">${top.length
        ? `<ul class="list">${top.map(([n, v]) => `<li class="row"><span class="nama">${esc(n)}</span><span class="small muted">${t('{n} terjual', { n: angka.format(v.qty) })} · ${rp(v.omzet)}</span></li>`).join('')}</ul>`
        : `<div class="empty">${t('Belum ada penjualan di periode ini.')}</div>`}</div>
      <div class="group-title"><span>${t('Pengeluaran')}</span><button class="link tambah" data-act="pengeluaran-baru">${t('+ Catat pengeluaran')}</button></div>
      <div class="card">${keluar.length
        ? `<ul class="list">${keluar.map((r) => `<li class="row"><div><div class="nama">${rp(r.data.jumlah)} <span class="small muted">· ${esc(t(r.data.kategori))}</span></div>
            <div class="small muted">${fmtTanggal(r.data.waktu)}${r.data.catatan ? ' · ' + esc(r.data.catatan) : ''}</div></div>
            <button class="btn kecil" data-act="pengeluaran-ubah" data-id="${r.id}">${t('Ubah')}</button></li>`).join('')}</ul>`
        : `<div class="empty">${t('Belum ada pengeluaran di periode ini. Catat biaya seperti sewa, listrik, atau gaji supaya laba bersih terlihat.')}</div>`}</div>
      <div class="group-title">${t('Riwayat penjualan')}</div>
      <div class="card">${trx.length
        ? `<ul class="list">${trx.map((r) => `<li class="row"><div><div><span class="nama">${rp(r.data.total)}</span> <span class="small muted">· ${t('laba')} ${rp(r.data.laba)}</span></div>
            <div class="small muted">${fmtWaktu(r.data.waktu)}${r.data.staff ? ' · ' + t('oleh {nama}', { nama: esc(r.data.staff) }) : ''} · ${esc(r.data.items.map((i) => `${i.nama} ×${i.qty}`).join(', '))}</div>${tagBayar(r.data)}</div>
            <div class="aksi"><button class="btn kecil" data-act="struk" data-id="${r.id}">${t('Struk')}</button>
            <button class="btn kecil danger" data-act="batal-trx" data-id="${r.id}">${t('Batalkan')}</button></div></li>`).join('')}</ul>`
        : `<div class="empty">${t('Belum ada penjualan.')}</div>`}</div>`;
  }

  // Sorotan: waktu dengan omzet tertinggi, produk terlaris, dan jam paling ramai. Dipanggil setelah viewGrafik (memakai ui.grafik).
  function viewSorotan(trx, top) {
    if (!trx.length) return '';
    const isi = [];
    const ramai = ui.grafik.filter((k) => k.n).sort((a, b) => b.omzet - a.omzet)[0];
    if (ramai && ui.grafik.length > 1) {
      const judul = t({ jam: 'Jam terlaris', hari: 'Hari terlaris', bulan: 'Bulan terlaris' }[ui.grafikSatuan]);
      isi.push([judul, esc(ramai.label), rp(ramai.omzet)]);
    }
    if (top.length) isi.push([t('Produk terlaris'), esc(top[0][0]), t('{n} terjual', { n: angka.format(top[0][1].qty) })]);
    const jam = G.jamRamai(trx.map((r) => r.data));
    if (jam && ui.grafikSatuan !== 'jam') {
      const dua = (n) => String(n).padStart(2, '0');
      isi.push([t('Jam paling ramai'), `${dua(jam.jam)}.00–${dua(jam.jam + 1)}.00`, t('{n} transaksi', { n: angka.format(jam.n) })]);
    }
    if (!isi.length) return '';
    return `<div class="group-title">${t('Sorotan')}</div>
      <div class="card sorotan" id="sorotan">${isi.map(([lbl, nilai, ket]) => `<div class="sorot"><div class="lbl">${lbl}</div>
        <div class="nilai">${nilai}</div><div class="ket">${ket}</div></div>`).join('')}</div>`;
  }

  // Grafik batang omzet dan laba kotor per jam/hari/bulan, digambar sebagai SVG.
  function viewGrafik(trx, from, to) {
    const { satuan, kelompok } = G.kelompokkan(trx.map((r) => r.data), from, to, Date.now());
    const label = (w, panjang) => {
      const d = new Date(w);
      if (satuan === 'jam') return panjang ? `${String(d.getHours()).padStart(2, '0')}.00–${String(d.getHours() + 1).padStart(2, '0')}.00` : String(d.getHours());
      if (satuan === 'hari') return d.toLocaleDateString(lokal(), panjang ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });
      return d.toLocaleDateString(lokal(), { month: panjang ? 'long' : 'short', year: panjang || d.getMonth() === 0 ? 'numeric' : undefined });
    };
    ui.grafik = kelompok.map((k) => Object.assign({ label: label(k.mulai, true) }, k));
    ui.grafikSatuan = satuan;
    const judul = t({ jam: 'Omzet & laba per jam', hari: 'Omzet & laba per hari', bulan: 'Omzet & laba per bulan' }[satuan]);
    if (!kelompok.some((k) => k.n)) {
      return `<div class="group-title">${judul}</div><div class="card"><div class="empty">${t('Belum ada penjualan di periode ini.')}</div></div>`;
    }
    const L = 40;
    const R = 6;
    const T = 10;
    const B = 22;
    const Wd = 340;
    const Ht = 190;
    const w = Wd - L - R;
    const h = Ht - T - B;
    const { atas, langkah } = G.skala(Math.max(...kelompok.map((k) => Math.max(k.omzet, k.laba))));
    const y = (v) => T + h - (Math.max(0, v) / atas) * h;
    const slot = w / kelompok.length;
    const bw = Math.max(1.5, Math.min(14, (slot * 0.72 - 2) / 2));
    const batang = (x, v, kelas) => {
      const tinggi = y(0) - y(v);
      if (tinggi <= 0) return '';
      const r = Math.min(4, bw / 2, tinggi);
      const top = y(v);
      return `<path class="${kelas}" d="M${x},${y(0)}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${y(0)}Z"/>`;
    };
    const garis = [];
    for (let v = 0; v <= atas + 1e-9; v += langkah) {
      garis.push(`<line x1="${L}" x2="${Wd - R}" y1="${y(v)}" y2="${y(v)}" class="${v ? 'grid' : 'dasar'}"/>
        <text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${G.ringkas(v)}</text>`);
    }
    const tiap = Math.ceil(kelompok.length / 6);
    // Omzet tertinggi diberi angka di atas batangnya supaya langsung terlihat.
    const puncak = kelompok.length > 1 ? kelompok.reduce((a, k, i) => (k.omzet > kelompok[a].omzet ? i : a), 0) : -1;
    const isi = kelompok.map((k, i) => {
      const x0 = L + i * slot + (slot - (bw * 2 + 2)) / 2;
      const teks = i % tiap === 0 ? `<text x="${L + i * slot + slot / 2}" y="${Ht - 6}" text-anchor="middle">${esc(label(k.mulai))}</text>` : '';
      const xp = Math.min(Math.max(x0 + bw / 2, L + 14), Wd - R - 14);
      const atasnya = i === puncak ? `<text class="puncak" x="${xp}" y="${y(k.omzet) - 5}" text-anchor="middle">${G.ringkas(k.omzet)}</text>` : '';
      return `${batang(x0, k.omzet, 'omzet')}${batang(x0 + bw + 2, k.laba, 'laba')}${teks}${atasnya}
        <rect class="sentuh" data-gi="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${h}"/>`;
    }).join('');
    const baris = ui.grafik.filter((k) => k.n).map((k) => `<tr><td>${esc(k.label)}</td><td>${rp(k.omzet)}</td><td>${rp(k.laba)}</td></tr>`).join('');
    return `<div class="group-title">${judul}</div>
      <div class="card grafik" id="grafik">
        <div class="legenda small"><span><i class="omzet"></i>${t('Omzet')}</span><span><i class="laba"></i>${t('Laba kotor')}</span></div>
        <div class="kanvas"><svg viewBox="0 0 ${Wd} ${Ht}" role="img" aria-label="${judul}">${garis.join('')}${isi}</svg>
          <div class="tip" id="grafikTip" hidden></div></div>
        <details class="tabel-grafik"><summary class="small">${t('Lihat sebagai tabel')}</summary>
          <table><thead><tr><th>${t('Waktu')}</th><th>${t('Omzet')}</th><th>${t('Laba kotor')}</th></tr></thead><tbody>${baris}</tbody></table></details>
      </div>`;
  }

  // Keterangan angka saat batang grafik disentuh atau disorot.
  function tunjukGrafik(el) {
    const k = ui.grafik && ui.grafik[+el.dataset.gi];
    const tip = $('#grafikTip');
    if (!k || !tip) return;
    $$('#grafik .sentuh.aktif').forEach((x) => x.classList.remove('aktif'));
    el.classList.add('aktif');
    tip.innerHTML = `<b>${esc(k.label)}</b><div><i class="omzet"></i>${t('Omzet')} <b>${rp(k.omzet)}</b></div>
      <div><i class="laba"></i>${t('Laba kotor')} <b>${rp(k.laba)}</b></div><div class="muted">${t('{n} transaksi', { n: k.n })}</div>`;
    tip.hidden = false;
    const kotak = $('#grafik .kanvas').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const tengah = r.left + r.width / 2 - kotak.left;
    tip.style.left = Math.max(0, Math.min(kotak.width - tip.offsetWidth, tengah - tip.offsetWidth / 2)) + 'px';
  }

  // Tanda cara bayar di riwayat penjualan.
  function tagBayar(d) {
    if (d.metode === 'nanti') {
      return P.sisaTagihan(d) > 0
        ? `<div class="small warn">${t('Belum lunas: {pelanggan}, sisa {sisa}', { pelanggan: esc(d.pelanggan.nama), sisa: rp(P.sisaTagihan(d)) })}</div>`
        : `<div class="small ok">${t('Lunas · {pelanggan}', { pelanggan: esc(d.pelanggan.nama) })}</div>`;
    }
    return d.metode === 'qris' ? `<span class="tag">QRIS</span>` : '';
  }

  // Semua penjualan "bayar nanti" yang belum lunas, tanpa melihat periode.
  function tagihanTerbuka() {
    return store.list('transaksi').filter((r) => P.sisaTagihan(r.data) > 0).sort((a, b) => a.data.waktu.localeCompare(b.data.waktu));
  }

  function viewTagihan() {
    const list = tagihanTerbuka();
    if (!list.length) return '';
    const total = list.reduce((s, r) => s + P.sisaTagihan(r.data), 0);
    const hari = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 864e5);
    return `<div class="group-title"><span>${t('Belum lunas')}</span><span>${rp(total)}</span></div>
      <div class="card" id="tagihan"><ul class="list">${list.map((r) => {
        const d = r.data;
        const umur = hari(d.waktu);
        return `<li class="stack"><div class="row"><div><div class="nama">${esc(d.pelanggan.nama)}</div>
            <div class="small muted">${t('Sisa {sisa} dari {total}', { sisa: rp(P.sisaTagihan(d)), total: rp(d.total) })} · ${umur ? t('{n} hari lalu', { n: umur }) : t('hari ini')}</div></div></div>
          <div class="row" style="justify-content:flex-end;gap:8px">
            <button class="btn kecil" data-act="tagih" data-id="${r.id}">${t('Tagih via WA')}</button>
            <button class="btn kecil primary" data-act="catat-bayar" data-id="${r.id}">${t('Catat bayar')}</button></div></li>`;
      }).join('')}</ul></div>`;
  }

  function teksTagihan(d) {
    const p = usaha();
    const masuk = d.total - P.sisaTagihan(d);
    const tgl = new Date(d.waktu).toLocaleDateString(lokal(), { day: 'numeric', month: 'long', year: 'numeric' });
    return [
      t('Halo {nama}, berikut tagihan dari {usaha}:', { nama: d.pelanggan.nama, usaha: p.namaUsaha || 'Kelola' }),
      t('Tanggal: {tanggal}', { tanggal: tgl }), '',
      ...d.items.map((i) => `- ${i.nama} ×${angka.format(i.qty)} = ${rp(i.qty * i.harga)}`), '',
      `${t('Total')}: ${rp(d.total)}`,
      masuk > 0 ? `${t('Sudah dibayar')}: ${rp(masuk)}` : null,
      `*${t('Sisa tagihan')}: ${rp(P.sisaTagihan(d))}*`, '',
      p.qris ? t('Bisa dibayar tunai atau lewat QRIS. Terima kasih.') : t('Terima kasih.'),
    ].filter((x) => x !== null).join('\n');
  }

  function bukaTagih(id) {
    const r = store.get(id);
    if (!r || !r.data.pelanggan) return;
    const d = r.data;
    const teks = teksTagihan(d);
    const no = P.nomorWa(d.pelanggan.wa);
    const bisaBagiQris = !!(usaha().qris && navigator.canShare && window.File);
    dialog.innerHTML = `<div class="stack" id="dialogTagih">
      <div class="row"><h3>${t('Tagih {nama}', { nama: esc(d.pelanggan.nama) })}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <pre class="pesan-wa">${esc(teks)}</pre>
      <a class="btn primary block" href="https://wa.me/${no}?text=${encodeURIComponent(teks)}" target="_blank" rel="noopener">${t('Kirim lewat WhatsApp')}</a>
      ${no ? '' : `<div class="small muted">${t('Nomor WhatsApp belum dicatat, jadi pilih kontaknya sendiri di WhatsApp.')}</div>`}
      ${bisaBagiQris ? `<button class="btn block" data-act="tagih-qris">${t('Kirim gambar QRIS')}</button>` : ''}
    </div>`;
    if (!dialog.open) dialog.showModal();
  }

  async function bagikanQris() {
    try {
      const blob = await (await fetch(usaha().qris)).blob();
      const file = new File([blob], 'qris.jpg', { type: blob.type || 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
    } catch (e) { /* dibatalkan atau tidak didukung */ }
  }

  function bukaCatatBayar(id) {
    const r = store.get(id);
    if (!r) return;
    const sisa = P.sisaTagihan(r.data);
    dialog.innerHTML = `<form id="formLunas" class="stack" method="dialog">
      <div class="row"><h3>${t('Catat bayar')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <div class="small muted">${t('{nama} · sisa {sisa}', { nama: esc(r.data.pelanggan.nama), sisa: rp(sisa) })}</div>
      <label class="field"><span>${t('Jumlah dibayar (Rp)')}</span><input name="jumlah" type="number" inputmode="numeric" min="1" max="${sisa}" required value="${sisa}"></label>
      <div class="seg kecil" role="group">${[['tunai', t('Tunai')], ['qris', t('QRIS')]].map(([k, l]) => `<button type="button" data-act="metode-lunas" data-m="${k}" aria-pressed="${k === 'tunai'}">${l}</button>`).join('')}</div>
      <input type="hidden" name="metode" value="tunai"><input type="hidden" name="trxId" value="${id}">
      <button class="btn primary">${t('Simpan')}</button>
    </form>`;
    if (!dialog.open) dialog.showModal();
  }

  const pilihSetel = (nama, nilai, opsi) => `<div class="seg kecil" role="group">${opsi.map(([k, l]) =>
    `<button data-act="setel" data-nama="${nama}" data-nilai="${k}" aria-pressed="${nilai === k}">${l}</button>`).join('')}</div>`;

  function viewPengaturan() {
    return `<div class="group-title">${t('Pengaturan')}</div><div class="card stack" id="pengaturan">
      <div class="field"><span class="lbl">${t('Bahasa')}</span>${pilihSetel('bahasa', setel.bahasa, [['id', 'Bahasa Indonesia'], ['en', 'English']])}</div>
      <div class="field"><span class="lbl">${t('Tampilan')}</span>${pilihSetel('tema', setel.tema, [['terang', t('Terang')], ['gelap', t('Gelap')], ['otomatis', t('Ikuti HP')]])}</div>
      </div>`;
  }

  const pesan = (m) => (m ? `<div class="msg ${m.type}">${esc(m.text)}</div>` : '');

  // Satu bagian di halaman Akun yang bisa dibuka-tutup.
  function lipat(kunci, judul, isi, bawaanBuka) {
    const buka = kunci in ui.lipat ? ui.lipat[kunci] : !!bawaanBuka;
    return `<details class="lipat" data-lipat="${kunci}" ${buka ? 'open' : ''}><summary class="group-title">${judul}</summary>${isi}</details>`;
  }

  // Ubah "<div class="group-title">Judul</div>isi" menjadi bagian yang bisa dibuka-tutup.
  function jadiLipat(kunci, html, bawaanBuka) {
    const m = html.match(/^\s*<div class="group-title">([\s\S]*?)<\/div>([\s\S]*)$/);
    return m ? lipat(kunci, m[1], m[2], bawaanBuka) : html;
  }

  // HP bersama yang dikunci ke kasir: hanya pengaturan bahasa dan buka kunci.
  function viewKunci() {
    return `<div class="group-title">${t('Mode kasir')}</div><div class="card stack">
      <div>${t('HP ini sedang dikunci ke kasir. Modal, laba, produk, dan laporan disembunyikan.')}</div>
      ${pesan(ui.kunciMsg)}
      <form id="formBukaKunci" class="stack">
        <label class="field"><span>${t('PIN owner')}</span><input name="pin" type="password" inputmode="numeric" autocomplete="off" required></label>
        <button class="btn primary block">${t('Buka kunci')}</button>
      </form></div>${viewPengaturan()}`;
  }

  // Akun staff: info, penjualan hari ini, sinkron, keluar.
  function viewAkunStaff() {
    const awal = rentang('hari');
    const hariIni = kasirStaff.jualan.filter((j) => Date.parse(j.waktu) >= awal);
    const total = hariIni.reduce((s, j) => s + j.total, 0);
    const pending = kasirStaff.antrian.length;
    const err = cloud.status === 'error' && cloud.lastError
      ? `<div class="msg err">${esc(pesanStaff(cloud.lastError))}</div>` : '';
    return `<div class="group-title">${t('Akun staff')}</div><div class="card stack">
        <div>${t('Masuk sebagai')} <strong>${esc(cloud.user.email)}</strong></div>
        <div class="small muted">${t('Staff di {usaha}. Akun ini hanya bisa memakai kasir.', { usaha: esc(usaha().namaUsaha || 'Kelola') })}</div>
        <div class="row"><span>${t('Penjualan Anda hari ini')}</span><b>${hariIni.length} · ${rp(total)}</b></div>
        <div class="small muted">${pending ? t('{n} penjualan belum terkirim', { n: pending }) : t('semua data sudah terkirim')}</div>
        ${err}
        <div class="row"><button class="btn" data-act="sinkron">${t('Sinkronkan sekarang')}</button>
        <button class="btn danger" data-act="keluar">${t('Keluar')}</button></div></div>${viewPengaturan()}`;
  }

  // Owner: kunci HP ke kasir dengan PIN.
  function viewModeKasir() {
    return `<div class="group-title">${t('Mode kasir untuk HP bersama')}</div><div class="card stack">
      <div class="small muted">${t('Kunci HP atau tablet ini supaya hanya kasir yang bisa dibuka. Modal, laba, produk, dan laporan disembunyikan sampai PIN owner dimasukkan.')}</div>
      ${pesan(ui.kunciMsg)}
      <form id="formKunci" class="stack">
        <label class="field"><span>${t('Buat PIN (4–8 angka)')}</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" autocomplete="new-password" required></label>
        <button class="btn block">${t('Kunci ke kasir')}</button>
      </form></div>`;
  }

  // Owner yang sudah masuk: undang dan atur staff.
  function viewStaff() {
    if (!cloud.user || cloud.peran !== 'owner') return '';
    const st = ui.staff;
    let isi;
    if (st.belumSiap) {
      isi = `<div class="small muted">${t('Fitur staff belum disiapkan di Supabase. Jalankan supabase/staff.sql sekali (lihat README).')}</div>`;
    } else {
      const daftar = st.list && st.list.length
        ? `<ul class="list">${st.list.map((x) => `<li class="row"><div><div class="nama">${esc(x.nama)}</div>
            <div class="small muted">${t('Bergabung {tanggal}', { tanggal: new Date(x.created_at).toLocaleDateString(lokal(), { day: 'numeric', month: 'short', year: 'numeric' }) })}</div></div>
            <button class="btn kecil danger" data-act="hapus-staff" data-id="${esc(x.staff_id)}">${t('Hapus')}</button></li>`).join('')}</ul>`
        : `<div class="small muted">${st.list ? t('Belum ada staff.') : t('Memuat…')}</div>`;
      const kode = st.kode
        ? `<div class="hint stack" id="kodeUndangan"><div class="small">${t('Kode undangan (berlaku 7 hari, sekali pakai):')}</div>
            <div class="kode">${esc(st.kode)}</div>
            <div class="small muted">${t('Minta staff membuka Kelola, daftar dengan email sendiri, lalu masukkan kode ini di Akun.')}</div></div>`
        : '';
      isi = `<div class="small muted">${t('Staff memakai HP sendiri dan hanya bisa membuka kasir. Modal, laba, laporan, dan bahan baku tidak dikirim ke HP staff.')}</div>
        ${daftar}${kode}${pesan(st.msg)}
        <button class="btn block" data-act="undang-staff">${t('Buat kode undangan')}</button>`;
    }
    return `<div class="group-title">${t('Staff')}</div><div class="card stack" id="staff">${isi}</div>`;
  }

  // Akun yang baru dibuat staff: masukkan kode dari owner.
  function viewGabung() {
    if (!cloud.user || cloud.peran !== 'owner' || ui.staff.belumSiap || (ui.staff.list && ui.staff.list.length)) return '';
    return `<div class="group-title">${t('Bergabung sebagai staff')}</div><div class="card stack">
      <div class="small muted">${t('Kalau Anda staff, masukkan kode undangan dari owner. Setelah itu akun ini hanya bisa memakai kasir.')}</div>
      ${pesan(ui.gabungMsg)}
      <form id="formGabung" class="stack">
        <div class="two">
          <label class="field"><span>${t('Kode undangan')}</span><input name="kode" autocapitalize="characters" autocomplete="off" required></label>
          <label class="field"><span>${t('Nama Anda')}</span><input name="nama" autocomplete="name" required></label>
        </div>
        <button class="btn block">${t('Gabung')}</button>
      </form></div>`;
  }

  function viewAkun() {
    if (modeKunci()) return viewKunci();
    if (modeStaff()) return viewAkunStaff();
    const p = profil();
    const profilUsaha = `<div class="group-title">${t('Profil usaha')}</div><div class="card stack">
      <label class="field"><span>${t('Nama usaha')}</span><input id="namaUsahaInput" value="${esc(p.namaUsaha)}" placeholder="${t('Contoh: Warung Bu Sari')}"></label>
      <label class="field"><span>${t('Alamat atau nomor WhatsApp (tampil di struk)')}</span><input id="kontakUsahaInput" value="${esc(p.kontak || '')}" placeholder="${t('Contoh: Jl. Melati 5 · 0812 3456 7890')}"></label>
      <button class="btn" data-act="simpan-profil">${t('Simpan')}</button></div>`;
    if (cloud.user && cloud.peran === 'owner' && !ui.staff.list && !ui.staff.memuat && !ui.staff.belumSiap) muatStaff();
    return [
      jadiLipat('profil', profilUsaha),
      jadiLipat('qris', viewQris()),
      jadiLipat('merek', viewMerek()),
      jadiLipat('pengaturan', viewPengaturan()),
      jadiLipat('cloud', viewCloud(), !cloud.user),
      viewStaff() && jadiLipat('staff', viewStaff(), !!ui.staff.kode),
      jadiLipat('kunci', viewModeKasir(), !!ui.kunciMsg),
      viewGabung() && jadiLipat('gabung', viewGabung(), !!ui.gabungMsg),
    ].filter(Boolean).join('');
  }

  // Owner: logo di pojok kiri atas dan warna aplikasi dari logo.
  function viewMerek() {
    const p = profil();
    const palet = p.palet || [];
    const w = p.warna && p.warna.utama;
    const pilihan = palet.filter((h) => W.luminans(h) < 0.45);
    const swatch = (pilihan.length ? pilihan : palet).map((h) => `<button type="button" class="swatch" data-act="warna" data-w="${h}" aria-pressed="${w === h}" style="background:${h}" aria-label="${h}"></button>`).join('');
    return `<div class="group-title">${t('Logo & warna usaha')}</div><div class="card stack" id="merek">
      <div class="dengan-foto"><img class="logo-pratinjau" src="${esc(p.logo || 'icons/logo.svg')}" alt="">
        <div class="small muted">${t('Logo ini tampil di pojok kiri atas, juga di HP staff.')}</div></div>
      <div class="foto-aksi">
        <label class="btn kecil"><input type="file" accept="image/*" data-logo hidden>${p.logo ? t('Ganti logo') : t('Pilih logo')}</label>
        ${p.logo ? `<button type="button" class="link small danger" data-act="hapus-logo">${t('Pakai logo Kelola')}</button>` : ''}
      </div>
      <div class="field"><span class="lbl">${t('Warna aplikasi')}</span>
        <div class="swatches"><button type="button" class="swatch bawaan" data-act="warna" data-w="" aria-pressed="${!w}" aria-label="${t('Warna Kelola')}"></button>${swatch}</div>
        <div class="small muted" style="margin-top:6px">${palet.length ? t('Pilih salah satu warna dari logo Anda, atau warna Kelola di paling kiri.') : t('Pilih logo dulu, nanti warna-warnanya muncul di sini.')}</div></div>
    </div>`;
  }

  // Owner: gambar QRIS untuk ditunjukkan ke pembeli di kasir.
  function viewQris() {
    const q = profil().qris;
    return `<div class="group-title">${t('Pembayaran QRIS')}</div><div class="card stack" id="qrisSetel">
      <div class="small muted">${t('Simpan gambar QRIS usaha Anda. Di kasir akan muncul tombol QRIS untuk ditunjukkan ke pembeli. Hanya owner yang bisa mengganti gambar ini.')}</div>
      ${q ? `<img class="qris-gambar" src="${esc(q)}" alt="QRIS">` : ''}
      <div class="foto-aksi">
        <label class="btn kecil"><input type="file" accept="image/*" data-qris hidden>${q ? t('Ganti gambar QRIS') : t('Pilih gambar QRIS')}</label>
        ${q ? `<button type="button" class="link small danger" data-act="hapus-qris">${t('Hapus QRIS')}</button>` : ''}
      </div></div>`;
  }

  function viewCloud() {
    if (!cloudReady) {
      return `<div class="group-title">${t('Simpan ke cloud')}</div><div class="card stack">
        <div class="muted">${t('Sinkronisasi cloud belum diaktifkan di aplikasi ini, jadi data hanya tersimpan di perangkat ini.')}
        ${t('Pemilik aplikasi perlu mengisi js/config.js (lihat README).')}</div></div>`;
    }
    const msg = ui.authMsg ? `<div class="msg ${ui.authMsg.type}">${esc(ui.authMsg.text)}</div>` : '';
    if (cloud.recovering) {
      return `<div class="group-title">${t('Buat kata sandi baru')}</div><div class="card stack">${msg}
        <form id="formSandiBaru" class="stack">
          <label class="field"><span>${t('Kata sandi baru')}</span><input name="password" type="password" minlength="6" autocomplete="new-password" required></label>
          <button class="btn primary block">${t('Simpan kata sandi')}</button></form></div>`;
    }
    if (cloud.user) {
      const pending = store.dirtyRecords().length;
      const last = cloud.lastSynced ? cloud.lastSynced.toLocaleString(lokal()) : t('belum');
      const err = cloud.status === 'error' && cloud.lastError
        ? `<div class="msg err">${t('Gagal sinkron: {pesan}. Data tetap aman di perangkat ini dan akan dikirim ulang.', { pesan: esc(cloud.lastError.message || cloud.lastError) })}</div>` : '';
      return `<div class="group-title">${t('Simpan ke cloud')}</div><div class="card stack">
        <div>${t('Masuk sebagai')} <strong>${esc(cloud.user.email)}</strong></div>
        <div class="small muted">${t('Sinkron terakhir: {waktu}', { waktu: esc(last) })} · ${pending ? t('{n} perubahan belum terkirim', { n: pending }) : t('semua data sudah terkirim')}</div>
        ${err}${msg}
        <div class="row"><button class="btn" data-act="sinkron">${t('Sinkronkan sekarang')}</button>
        <button class="btn danger" data-act="keluar">${t('Keluar')}</button></div></div>
        <div class="foot">${t('Masuk dengan akun yang sama di HP, tablet, atau laptop lain untuk melihat data yang sama.')}</div>`;
    }
    const daftar = ui.authMode === 'daftar';
    const lupa = ui.authMode === 'lupa';
    const judul = daftar ? t('Buat akun') : lupa ? t('Lupa kata sandi') : t('Masuk');
    const pw = lupa ? '' : `<label class="field"><span>${t('Kata sandi')}</span><input name="password" type="password" ${daftar ? 'minlength="6"' : ''} autocomplete="${daftar ? 'new-password' : 'current-password'}" required></label>`;
    const tombol = daftar ? t('Daftar') : lupa ? t('Kirim tautan reset') : t('Masuk');
    const adaData = store.list('produk').length + store.list('transaksi').length;
    const info = adaData ? `<div class="hint">${t('Data yang sudah ada di perangkat ini akan ikut tersimpan ke akun Anda setelah masuk.')}</div>` : '';
    return `<div class="group-title">${judul}</div><div class="card stack">
      <div class="muted small">${t('Masuk supaya data tidak hilang saat HP rusak atau ganti perangkat, dan bisa dibuka di beberapa perangkat sekaligus.')}</div>
      ${info}${msg}
      <form id="formAuth" class="stack">
        <label class="field"><span>${t('Email')}</span><input name="email" type="email" autocomplete="email" required value="${esc(ui.authEmail)}"></label>
        ${pw}
        <button class="btn primary block">${tombol}</button>
      </form>
      <div class="row small">
        ${daftar || lupa ? `<button class="link" data-act="mode" data-m="masuk">${t('Sudah punya akun? Masuk')}</button>` : `<button class="link" data-act="mode" data-m="daftar">${t('Belum punya akun? Daftar')}</button>`}
        ${lupa ? '' : `<button class="link" data-act="mode" data-m="lupa">${t('Lupa kata sandi?')}</button>`}
      </div></div>`;
  }

  // ---------- Form produk ----------

  function opsi(list, pilih, teks) {
    return list.map((r) => `<option value="${r.id}" ${r.id === pilih ? 'selected' : ''}>${esc(teks(r))}</option>`).join('');
  }

  function barisResep(item) {
    const bahan = bahanList();
    const b = item && cari(item.bahanId);
    const hilang = item && item.bahanId && !b ? `<option value="" selected>${t('(bahan sudah dihapus)')}</option>` : '';
    return `<div class="baris" data-baris="resep">
      <select name="rb" aria-label="${t('Bahan')}">${hilang}${opsi(bahan, item && item.bahanId, (r) => r.data.nama)}</select>
      <input name="rj" type="number" inputmode="decimal" min="0" step="any" placeholder="${t('Jumlah')}" aria-label="${t('Jumlah dipakai')}" value="${item ? esc(item.jumlah) : ''}">
      <span class="unit small muted"></span>
      <button type="button" class="hapus" data-act="hapus-baris" aria-label="${t('Hapus baris')}">×</button></div>`;
  }

  function barisPaket(item, diriId) {
    const produk = produkList().filter((p) => p.id !== diriId);
    return `<div class="baris" data-baris="paket">
      <select name="pp" aria-label="${t('Produk')}">${opsi(produk, item && item.produkId, (r) => r.data.nama)}</select>
      <input name="pq" type="number" inputmode="decimal" min="0" step="any" placeholder="${t('Jumlah')}" aria-label="${t('Jumlah')}" value="${item ? esc(item.qty) : '1'}">
      <span class="unit small muted">×</span>
      <button type="button" class="hapus" data-act="hapus-baris" aria-label="${t('Hapus baris')}">×</button></div>`;
  }

  const labelStok = (mode) => t(mode === 'resep' ? 'Stok produk jadi (kosongkan kalau dibuat saat dipesan)' : 'Stok (kosongkan jika tidak dihitung)');

  function bukaFormProduk(id) {
    const rec = id ? store.get(id) : null;
    const d = rec ? rec.data : { nama: '', satuan: 'pcs', mode: 'manual', modal: '', harga: '', stok: null };
    const mode = d.mode || 'manual';
    const resep = d.resep || { items: [], hasil: 1, biayaLain: 0 };
    const paket = d.paket || [];
    const adaBahan = bahanList().length > 0;
    ui.foto = d.foto || null;
    const seg = [['manual', t('Isi sendiri')], ['resep', t('Dari resep')], ['paket', t('Paket')]]
      .map(([k, l]) => `<button type="button" data-act="mode-modal" data-m="${k}" aria-pressed="${mode === k}">${l}</button>`).join('');
    dialog.innerHTML = `<form id="formProduk" class="stack" method="dialog">
      <div class="row"><h3>${rec ? t('Ubah produk') : t('Produk baru')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <div class="field"><span class="lbl">${t('Foto produk (boleh kosong)')}</span><div id="fotoProduk" class="foto-form"></div></div>
      <label class="field"><span>${t('Nama produk')}</span><input name="nama" required value="${esc(d.nama)}" placeholder="${t('Contoh: Keripik pedas 100 g')}"></label>
      <label class="field"><span>${t('Satuan jual')}</span><input name="satuan" value="${esc(d.satuan || '')}" placeholder="${t('pcs, porsi, gelas')}"></label>
      <div class="field"><span class="lbl">${t('Modal per satuan')}</span><div class="seg kecil">${seg}</div></div>
      <input type="hidden" name="mode" value="${mode}">
      <div data-bagian="manual" ${mode === 'manual' ? '' : 'hidden'}>
        <label class="field"><span>${t('Modal per satuan (Rp)')}</span><input name="modal" type="number" inputmode="decimal" min="0" step="any" value="${mode === 'manual' ? esc(d.modal) : ''}"></label>
      </div>
      <div data-bagian="resep" class="hint stack" ${mode === 'resep' ? '' : 'hidden'}>
        <div class="label">${t('Resep satu adonan')}</div>
        ${adaBahan ? '' : `<div class="small">${t('Belum ada bahan baku.')} <button type="button" class="link" data-act="ke-bahan">${t('Tambah bahan dulu')}</button></div>`}
        <div class="small muted">${t('Pilih bahan dan jumlah yang dipakai, dalam satuan bahan (mis. gram).')}</div>
        <div id="barisResep" class="stack">${resep.items.length ? resep.items.map(barisResep).join('') : (adaBahan ? barisResep() : '')}</div>
        ${adaBahan ? `<button type="button" class="link" data-act="tambah-bahan-resep">${t('+ Tambah bahan')}</button>` : ''}
        <div class="two">
          <label class="field"><span>${t('Hasil jadi')}</span><input name="hasil" type="number" inputmode="decimal" min="1" step="any" value="${esc(resep.hasil || 1)}"></label>
          <label class="field"><span>${t('Biaya lain (Rp)')}</span><input name="biayaLain" type="number" inputmode="decimal" min="0" step="any" value="${esc(resep.biayaLain || '')}" placeholder="${t('Gas, kemasan')}"></label>
        </div>
      </div>
      <div data-bagian="paket" class="hint stack" ${mode === 'paket' ? '' : 'hidden'}>
        <div class="label">${t('Isi paket')}</div>
        <div class="small muted">${t('Gabungkan beberapa produk jadi satu harga. Modal paket = jumlah modal isinya.')}</div>
        <div id="barisPaket" class="stack">${paket.length ? paket.map((i) => barisPaket(i, id)).join('') : barisPaket(null, id)}</div>
        <button type="button" class="link" data-act="tambah-isi-paket">${t('+ Tambah produk')}</button>
      </div>
      <div class="row" id="baris-hpp" ${mode === 'manual' ? 'hidden' : ''}><span class="label">${t('Modal per satuan')}</span><span class="total" id="hpp">–</span></div>
      <div class="hint stack">
        <div class="row"><span class="label">${t('Saran harga jual')}</span>
          <label class="field sempit"><span class="small">${t('Margin (%)')}</span><input name="target" type="number" inputmode="decimal" min="1" max="95" value="30"></label></div>
        <div class="pilihan" id="pilihan"></div>
      </div>
      <label class="field"><span>${t('Harga jual (Rp)')}</span><input name="harga" type="number" inputmode="decimal" min="0" step="any" required value="${esc(d.harga)}"></label>
      <div class="small muted" id="ringkasLaba"></div>
      <label class="field" data-bagian-stok ${mode === 'paket' ? 'hidden' : ''}><span>${labelStok(mode)}</span><input name="stok" type="number" inputmode="decimal" step="any" value="${d.stok == null ? '' : esc(d.stok)}"></label>
      <div class="row">
        ${rec ? `<button type="button" class="btn danger" data-act="produk-hapus" data-id="${rec.id}">${t('Hapus')}</button>` : '<span></span>'}
        <button class="btn primary">${t('Simpan')}</button>
      </div>
      <input type="hidden" name="produkId" value="${rec ? rec.id : ''}">
    </form>`;
    ui.pilihanHtml = null;
    renderFotoForm();
    hitungForm();
    if (!dialog.open) dialog.showModal();
  }

  // Kotak foto di form produk: pratinjau, ambil dari kamera, pilih dari galeri, hapus.
  function renderFotoForm() {
    const el = $('#fotoProduk');
    if (!el) return;
    const pratinjau = ui.foto
      ? `<img class="pratinjau" id="fotoPratinjau" src="${esc(ui.foto)}" alt="">`
      : `<div class="pratinjau kosong" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg></div>`;
    el.innerHTML = `${pratinjau}<div class="foto-aksi">
      <label class="btn kecil"><input type="file" accept="image/*" capture="environment" data-foto hidden>${t('Ambil foto')}</label>
      <label class="btn kecil"><input type="file" accept="image/*" data-foto id="fotoGaleri" hidden>${t('Pilih dari galeri')}</label>
      ${ui.foto ? `<button type="button" class="link small danger" data-act="hapus-foto">${t('Hapus foto')}</button>` : ''}</div>`;
  }

  // Perkecil foto supaya ringan disimpan di perangkat dan dikirim ke cloud.
  function kecilkanFoto(file, maks, mutu) {
    return new Promise((ok, gagal) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const MAKS = maks || 480;
        const skala = Math.min(1, MAKS / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * skala);
        c.height = Math.round(img.naturalHeight * skala);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', mutu || 0.72));
      };
      img.onerror = () => { URL.revokeObjectURL(url); gagal(new Error('foto')); };
      img.src = url;
    });
  }

  async function pilihFoto(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      ui.foto = await kecilkanFoto(file);
      renderFotoForm();
    } catch (e) {
      toast(t('Foto tidak bisa dibuka. Coba foto lain.'));
    }
  }

  // QRIS harus tetap tajam supaya bisa dipindai, jadi ukurannya lebih besar dari foto produk.
  async function pilihQris(input) {
    const file = input.files && input.files[0];
    if (!file || modeStaff() || modeKunci()) return;
    try {
      const qris = await kecilkanFoto(file, 900, 0.9);
      change(() => store.put('profil', Object.assign({}, profil(), { qris }), 'profil'));
      toast(t('Gambar QRIS tersimpan'));
      render();
    } catch (e) {
      toast(t('Foto tidak bisa dibuka. Coba foto lain.'));
    }
  }

  // Logo diperkecil ke 256 px; warnanya dibaca dari versi 64 px.
  function bacaLogo(file) {
    return new Promise((ok, gagal) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const skala = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * skala);
        c.height = Math.round(img.naturalHeight * skala);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const transparan = /png|webp|gif|svg/.test(file.type);
        const logo = transparan ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
        const k = document.createElement('canvas');
        k.width = k.height = 64;
        k.getContext('2d').drawImage(img, 0, 0, 64, 64);
        URL.revokeObjectURL(url);
        ok({ logo, palet: W.paletLogo(k.getContext('2d').getImageData(0, 0, 64, 64).data) });
      };
      img.onerror = () => { URL.revokeObjectURL(url); gagal(new Error('logo')); };
      img.src = url;
    });
  }

  async function pilihLogo(input) {
    const file = input.files && input.files[0];
    if (!file || modeStaff() || modeKunci()) return;
    try {
      const { logo, palet } = await bacaLogo(file);
      change(() => store.put('profil', Object.assign({}, profil(), { logo, palet }), 'profil'));
      toast(t('Logo tersimpan. Pilih warna aplikasi di bawahnya.'));
      render();
    } catch (e) {
      toast(t('Foto tidak bisa dibuka. Coba foto lain.'));
    }
  }

  function pilihWarnaUsaha(utama) {
    const p = profil();
    let warna = null;
    if (utama) {
      const lain = (p.palet || []).filter((h) => h !== utama);
      const cocok = W.pilihWarna([utama].concat(lain));
      warna = { utama, aksen: cocok && cocok.utama === utama ? cocok.aksen : null };
    }
    change(() => store.put('profil', Object.assign({}, p, { warna }), 'profil'));
    render();
  }

  function bukaQris() {
    const q = usaha().qris;
    if (!q) return;
    const total = isiKeranjang().reduce((s, x) => s + x.rec.data.harga * x.qty, 0);
    dialog.innerHTML = `<div class="stack" id="qrisKasir">
      <div class="row"><h3>${t('Bayar dengan QRIS')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      ${total ? `<div class="row"><span class="label">${t('Total')}</span><span class="total">${rp(total)}</span></div>` : ''}
      <img class="qris-gambar besar" src="${esc(q)}" alt="QRIS">
      <div class="small muted">${t('Minta pembeli memindai kode ini, lalu cek notifikasi pembayaran masuk sebelum menyimpan penjualan.')}</div></div>`;
    if (!dialog.open) dialog.showModal();
  }

  // Data produk dari isian form (belum disimpan).
  function bacaFormProduk(f) {
    const mode = f.mode.value;
    const d = { nama: f.nama.value.trim(), satuan: f.satuan.value.trim(), mode, harga: num(f.harga.value) };
    if (ui.foto) d.foto = ui.foto;
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
          <span class="small">${t(p.label)}</span><span class="small muted">${p.target}%</span><b>${rp(p.harga)}</b></button>`).join('')
      : `<div class="small muted">${t('Isi modal dulu untuk melihat saran harga.')}</div>`;
    // Jangan ganti tombol yang sama: kalau diganti di antara sentuhan, ketukannya hilang.
    if (ui.pilihanHtml !== html) { $('#pilihan').innerHTML = html; ui.pilihanHtml = html; }
    $('#ringkasLaba').textContent = d.harga > 0
      ? t('Laba per satuan {laba} · margin {m}%', { laba: rp(d.harga - d.modal), m: angka.format(H.margin(d.modal, d.harga)) }) + (d.harga < d.modal ? ' · ' + t('harga di bawah modal!') : '')
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
    stok.querySelector('span').textContent = labelStok(mode);
    hitungForm();
  }

  // ---------- Form bahan ----------

  function bukaFormBahan(id) {
    const rec = id ? store.get(id) : null;
    const d = rec ? rec.data : { nama: '', satuan: 'gram', isi: 1000, harga: '', stok: null };
    dialog.innerHTML = `<form id="formBahan" class="stack" method="dialog">
      <div class="row"><h3>${rec ? t('Ubah bahan') : t('Bahan baru')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <label class="field"><span>${t('Nama bahan')}</span><input name="nama" required value="${esc(d.nama)}" placeholder="${t('Contoh: Gula pasir')}"></label>
      <div class="two">
        <label class="field"><span>${t('Satuan pakai')}</span><input name="satuan" required value="${esc(d.satuan)}" placeholder="${t('gram, ml, butir')}"></label>
        <label class="field"><span>${t('Isi per kemasan')}</span><input name="isi" type="number" inputmode="decimal" min="0" step="any" required value="${esc(d.isi)}"></label>
      </div>
      <label class="field"><span>${t('Harga beli per kemasan (Rp)')}</span><input name="harga" type="number" inputmode="decimal" min="0" step="any" required value="${esc(d.harga)}"></label>
      <div class="small muted" id="hargaSatuan"></div>
      <label class="field"><span>${t('Stok (kosongkan jika tidak dihitung)')}</span><input name="stok" type="number" inputmode="decimal" step="any" value="${d.stok == null ? '' : esc(d.stok)}"></label>
      <div class="row">
        ${rec ? `<button type="button" class="btn danger" data-act="bahan-hapus" data-id="${rec.id}">${t('Hapus')}</button>` : '<span></span>'}
        <button class="btn primary">${t('Simpan')}</button>
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
    $('#hargaSatuan').textContent = per
      ? t('Harga per {satuan}: {harga}', { satuan: f.satuan.value || t('satuan'), harga: rupiah.format(per) }) + (per < 1 ? ` (${angka.format(per)})` : '')
      : '';
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
      <div class="row"><h3>${t('Cek harga jual')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <div class="small muted">${t('Harga bahan berubah, jadi modal produk ini ikut berubah. Saran harga menjaga margin seperti sebelumnya.')}</div>
      <ul class="list">${list.map((p) => {
        const d = p.data;
        const baru = modalOf(p);
        const targetLama = H.margin(d.modal, d.harga);
        const saran = H.hargaSaran(baru, targetLama > 0 ? targetLama : 30);
        return `<li class="stack dampak"><div><div class="nama">${esc(d.nama)}</div>
          <div class="small">${t('Modal')} ${rp(d.modal)} → <b class="${baru > d.modal ? 'warn' : 'ok'}">${rp(baru)}</b></div>
          <div class="small muted">${t('Harga jual {harga} · margin {lama}% → {baru}%', { harga: rp(d.harga), lama: angka.format(targetLama), baru: angka.format(H.margin(baru, d.harga)) })}</div></div>
          <div class="row"><button class="btn kecil" data-act="dampak-biarkan" data-id="${p.id}">${t('Harga tetap')}</button>
          ${saran && saran !== d.harga ? `<button class="btn kecil primary" data-act="dampak-pakai" data-id="${p.id}" data-h="${saran}">${t('Jual {harga}', { harga: rp(saran) })}</button>` : ''}</div></li>`;
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
      <div class="row"><h3>${t('Produksi')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <div><span class="nama label">${esc(p.data.nama)}</span> <span class="small muted">· ${t('stok sekarang')} ${angka.format(p.data.stok)} ${esc(p.data.satuan || '')}</span></div>
      <label class="field"><span>${t('Berapa kali resep dibuat?')}</span><input name="batch" type="number" inputmode="decimal" min="0" step="any" value="1" required></label>
      <div class="small muted" id="ringkasProduksi"></div>
      <button class="btn primary block">${t('Tambah ke stok')}</button>
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
    $('#ringkasProduksi').textContent = t('Menambah {n} {satuan} ke stok.', { n: angka.format((p.resep.hasil || 1) * batch), satuan: p.satuan || '' }) +
      (pakai.length ? ' ' + t('Memakai {daftar}.', { daftar: pakai.join(', ') }) : '');
  }

  // ---------- Pengeluaran ----------

  const tanggalIsian = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function bukaFormPengeluaran(id) {
    const rec = id ? store.get(id) : null;
    const d = rec ? rec.data : { waktu: null, kategori: KATEGORI[0], catatan: '', jumlah: '' };
    const tgl = tanggalIsian(d.waktu ? new Date(d.waktu) : new Date());
    dialog.innerHTML = `<form id="formPengeluaran" class="stack" method="dialog">
      <div class="row"><h3>${rec ? t('Ubah pengeluaran') : t('Catat pengeluaran')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <label class="field"><span>${t('Jumlah (Rp)')}</span><input name="jumlah" type="number" inputmode="numeric" min="0" step="any" required value="${esc(d.jumlah)}"></label>
      <div class="two">
        <label class="field"><span>${t('Jenis')}</span><select name="kategori">${KATEGORI.map((k) => `<option value="${k}" ${k === d.kategori ? 'selected' : ''}>${t(k)}</option>`).join('')}</select></label>
        <label class="field"><span>${t('Tanggal')}</span><input name="tanggal" type="date" required value="${tgl}"></label>
      </div>
      <label class="field"><span>${t('Catatan (boleh kosong)')}</span><input name="catatan" value="${esc(d.catatan)}" placeholder="${t('Contoh: listrik bulan Oktober')}"></label>
      <div class="small muted">${t('Belanja bahan baku tidak perlu dicatat di sini, karena sudah dihitung sebagai modal produk yang terjual.')}</div>
      <div class="row">
        ${rec ? `<button type="button" class="btn danger" data-act="pengeluaran-hapus" data-id="${rec.id}">${t('Hapus')}</button>` : '<span></span>'}
        <button class="btn primary">${t('Simpan')}</button>
      </div>
      <input type="hidden" name="pengeluaranId" value="${rec ? rec.id : ''}">
    </form>`;
    if (!dialog.open) dialog.showModal();
  }

  // ---------- Struk ----------

  function strukBaris(trx) {
    const p = usaha();
    const w = new Date(trx.data.waktu).toLocaleString(lokal(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const bayar = trx.data.bayar || trx.data.total;
    return {
      judul: p.namaUsaha || t('Struk penjualan'),
      kontak: p.kontak || '',
      waktu: w,
      items: trx.data.items.map((i) => ({ nama: i.nama, rinci: `${angka.format(i.qty)} × ${rp(i.harga)}`, jumlah: rp(i.qty * i.harga) })),
      total: rp(trx.data.total),
      rincian: rincianBayar(trx.data, bayar),
    };
  }

  // Baris di bawah total struk, sesuai cara bayar.
  function rincianBayar(d, bayar) {
    if (d.metode === 'nanti') {
      const sisa = P.sisaTagihan(d);
      return [[t('Dibayar'), rp(d.total - sisa)], [sisa > 0 ? t('Sisa tagihan') : t('Status'), sisa > 0 ? rp(sisa) : t('Lunas')]];
    }
    if (d.metode === 'qris') return [[t('Bayar (QRIS)'), rp(d.total)]];
    return [[t('Bayar'), rp(bayar)], [t('Kembali'), rp(Math.max(0, bayar - d.total))]];
  }

  function strukTeks(s) {
    return [
      `*${s.judul}*`, s.kontak, s.waktu, '',
      ...s.items.map((i) => `${i.nama}\n  ${i.rinci} = ${i.jumlah}`), '',
      `*${t('Total')}: ${s.total}*`, ...s.rincian.map(([l, v]) => `${l}: ${v}`), '', t('Terima kasih!'),
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
    const tm = temaUsaha();
    const navy = tm ? tm.terang['--navy'] : '#0a2a6e';
    ctx.fillStyle = tm ? navy : '#fecb10';
    ctx.fillRect(0, 0, W, 12);
    let y = 80;
    ctx.textAlign = 'center';
    ctx.fillStyle = navy;
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
      ctx.fillStyle = besar ? navy : '#5d6a88';
      ctx.font = font(besar ? 30 : 22, besar);
      ctx.fillText(label, pad, y);
      ctx.textAlign = 'right';
      ctx.fillText(nilai, W - pad, y);
      y += besar ? 44 : 34;
    };
    baris(t('Total'), s.total, true);
    s.rincian.forEach(([l, v]) => baris(l, v));
    y += 16;
    ctx.textAlign = 'center';
    ctx.fillStyle = navy;
    ctx.font = font(24, true);
    ctx.fillText(t('Terima kasih!'), W / 2, y);
    return c;
  }

  async function bukaStruk(id) {
    const trx = ambilTransaksi(id);
    if (!trx) return;
    if (document.fonts && document.fonts.load) await document.fonts.load('italic 800 40px "Exo 2"').catch(() => {});
    const s = strukBaris(trx);
    const canvas = strukGambar(s);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
    if (ui.struk && ui.struk.url) URL.revokeObjectURL(ui.struk.url);
    const nama = `struk-${trx.data.waktu.slice(0, 16).replace(/[-:T]/g, '')}.png`;
    ui.struk = { blob, url: URL.createObjectURL(blob), teks: strukTeks(s), nama };
    const file = blob && window.File ? new File([blob], nama, { type: 'image/png' }) : null;
    const bisaBagi = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    dialog.innerHTML = `<div class="stack">
      <div class="row"><h3>${t('Struk')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <img class="struk" id="strukGambar" src="${ui.struk.url}" alt="${t('Struk penjualan')} ${esc(s.total)}">
      ${bisaBagi ? `<button class="btn primary block" data-act="struk-bagikan">${t('Kirim gambar lewat WhatsApp')}</button>` : ''}
      <a class="btn ${bisaBagi ? '' : 'primary'} block" href="${ui.struk.url}" download="${nama}">${t('Simpan gambar')}</a>
      <a class="btn block" href="https://wa.me/?text=${encodeURIComponent(ui.struk.teks)}" target="_blank" rel="noopener">${t('Kirim sebagai teks')}</a>
      ${bisaBagi ? '' : `<div class="small muted">${t('Simpan gambarnya, lalu kirim dari WhatsApp seperti mengirim foto.')}</div>`}
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
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function simpanPenjualan() {
    const items = isiKeranjang().filter((x) => x.qty > 0);
    if (!items.length) return;
    const jual = {
      waktu: new Date().toISOString(),
      items: items.map((x) => ({ produkId: x.rec.id, nama: x.rec.data.nama, qty: x.qty, harga: x.rec.data.harga })),
    };
    const total = jual.items.reduce((s, i) => s + i.harga * i.qty, 0);
    jual.metode = ui.metode;
    jual.bayar = ui.metode === 'tunai' ? num(ui.bayar) || total : ui.metode === 'qris' ? total : 0;
    if (ui.metode === 'nanti') {
      const nama = ui.pelanggan.nama.trim();
      if (!nama) { toast(t('Isi nama pembeli dulu')); $('#pelangganNama') && $('#pelangganNama').focus(); return; }
      jual.pelanggan = { nama, wa: ui.pelanggan.wa.trim() };
    }
    if (modeStaff()) {
      // Staff tidak tahu modal; laba dihitung di HP owner saat penjualan ini diambil.
      Object.assign(jual, { id: KelolaStore.uuid(), total });
      S.catatJualanStaff(kasirStaff, H, jual);
      simpanKasirStaff();
      ui.trxTerakhir = jual.id;
      scheduleSync();
    } else {
      let rec;
      change(() => { rec = P.catatPenjualan(store, H, jual); });
      ui.trxTerakhir = rec.id;
    }
    ui.cart = {};
    ui.bayar = '';
    ui.metode = 'tunai';
    ui.pelanggan = { nama: '', wa: '' };
    render();
    toast(t(jual.metode === 'nanti' ? 'Tagihan {total} tersimpan' : 'Penjualan {total} tersimpan', { total: rp(total) }));
  }

  function batalTransaksi(id) {
    if (!store.get(id) || !confirm(t('Batalkan penjualan ini? Stok produk dan bahan akan dikembalikan.'))) return;
    change(() => P.batalPenjualan(store, id));
    if (ui.trxTerakhir === id) ui.trxTerakhir = null;
    render();
  }

  document.addEventListener('pointerover', (e) => {
    const g = e.target.closest && e.target.closest('#grafik [data-gi]');
    if (g) tunjukGrafik(g);
  });
  document.addEventListener('pointerleave', (e) => {
    if (e.target.id === 'grafik' && $('#grafikTip')) { $('#grafikTip').hidden = true; $$('#grafik .sentuh.aktif').forEach((x) => x.classList.remove('aktif')); }
  }, true);

  document.addEventListener('click', (e) => {
    const g = e.target.closest('#grafik [data-gi]');
    if (g) { tunjukGrafik(g); return; }
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
      case 'hapus-foto': ui.foto = null; renderFotoForm(); break;
      case 'ke-bahan': dialog.close(); ui.view = 'produk'; ui.produkTab = 'bahan'; render(); bukaFormBahan(); break;
      case 'pilih-harga': {
        const f = $('#formProduk');
        f.harga.value = el.dataset.h;
        hitungForm();
        break;
      }
      case 'produk-hapus':
        if (confirm(t('Hapus produk ini? Riwayat penjualan tetap tersimpan.'))) {
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
          ? t('Bahan ini dipakai di resep {daftar}. Kalau dihapus, modal produk itu tidak lagi menghitung bahan ini. Tetap hapus?', { daftar: dipakai.map((p) => p.data.nama).join(', ') })
          : t('Hapus bahan ini?');
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
        if (confirm(t('Hapus pengeluaran ini?'))) {
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
      case 'qris': bukaQris(); break;
      case 'warna': if (!modeStaff() && !modeKunci()) pilihWarnaUsaha(el.dataset.w); break;
      case 'hapus-logo': {
        if (modeStaff() || modeKunci()) break;
        const p = Object.assign({}, profil());
        delete p.logo; delete p.palet; p.warna = null;
        change(() => store.put('profil', p, 'profil'));
        render();
        break;
      }
      case 'metode': ui.metode = el.dataset.m; render(); break;
      case 'tagih': bukaTagih(id); break;
      case 'tagih-qris': bagikanQris(); break;
      case 'catat-bayar': bukaCatatBayar(id); break;
      case 'metode-lunas': $$('#formLunas [data-act=metode-lunas]').forEach((b) => b.setAttribute('aria-pressed', b === el)); $('#formLunas').metode.value = el.dataset.m; break;
      case 'hapus-qris': {
        if (modeStaff() || modeKunci() || !confirm(t('Hapus gambar QRIS?'))) break;
        const p = Object.assign({}, profil());
        delete p.qris;
        change(() => store.put('profil', p, 'profil'));
        render();
        break;
      }
      case 'simpan-profil':
        change(() => store.put('profil', Object.assign({}, profil(), { namaUsaha: $('#namaUsahaInput').value.trim(), kontak: $('#kontakUsahaInput').value.trim() }), 'profil'));
        render();
        toast(t('Profil tersimpan'));
        break;
      case 'setel': ubahPengaturan({ [el.dataset.nama]: el.dataset.nilai }); break;
      case 'undang-staff': undangStaff(); break;
      case 'hapus-staff': hapusStaff(id); break;
      case 'mode': ui.authMode = el.dataset.m; ui.authMsg = null; render(); break;
      case 'sinkron': syncNow(true); break;
      case 'keluar': keluar(); break;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'pelangganNama' || e.target.id === 'pelangganWa') {
      ui.pelanggan[e.target.id === 'pelangganNama' ? 'nama' : 'wa'] = e.target.value;
      // Isi nomor WA otomatis kalau nama pelanggan sudah dikenal.
      if (e.target.id === 'pelangganNama' && !modeStaff()) {
        const p = daftarPelanggan().find((x) => x.nama.toLowerCase() === e.target.value.trim().toLowerCase());
        if (p && p.wa && !ui.pelanggan.wa) { ui.pelanggan.wa = p.wa; $('#pelangganWa').value = p.wa; }
      }
    }
    if (e.target.id === 'bayar') {
      ui.bayar = e.target.value;
      const total = isiKeranjang().reduce((s, x) => s + x.rec.data.harga * x.qty, 0);
      const b = num(ui.bayar);
      $('#kembalian').textContent = b >= total ? rp(b - total) : '–';
    }
    const form = e.target.form && e.target.form.id;
    if (form === 'formProduk') hitungForm();
    if (form === 'formBahan') hitungBahan();
    if (form === 'formProduksi') hitungProduksi();
  });

  // Pilihan di <select> dan file foto memicu `change`, bukan `input`, di sebagian browser.
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-foto]')) { pilihFoto(e.target); return; }
    if (e.target.form && e.target.form.id === 'formProduk') hitungForm();
    if (e.target.dataset.tanggal && e.target.value) { ui[e.target.dataset.tanggal] = e.target.value; render(); }
    if (e.target.matches('[data-qris]')) pilihQris(e.target);
    if (e.target.matches('[data-logo]')) pilihLogo(e.target);
  });

  // Bagian Akun yang dilipat: ingat mana yang terbuka supaya tidak tertutup lagi saat tampilan diperbarui.
  document.addEventListener('toggle', (e) => {
    if (e.target.matches && e.target.matches('details[data-lipat]')) ui.lipat[e.target.dataset.lipat] = e.target.open;
  }, true);

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id === 'formProduk') {
      e.preventDefault();
      const d = bacaFormProduk(f);
      if (d.mode === 'resep' && !d.resep.items.length) { toast(t('Tambahkan minimal satu bahan ke resep')); return; }
      if (d.mode === 'paket' && !d.paket.length) { toast(t('Tambahkan minimal satu produk ke paket')); return; }
      change(() => store.put('produk', d, f.produkId.value || undefined));
      dialog.close();
      render();
      toast(t('Produk tersimpan'));
    }
    if (f.id === 'formLunas') {
      e.preventDefault();
      const id = f.trxId.value;
      const jumlah = Math.min(num(f.jumlah.value), P.sisaTagihan((store.get(id) || {}).data));
      if (!(jumlah > 0)) return;
      let rec;
      change(() => { rec = P.catatBayar(store, id, { waktu: new Date().toISOString(), jumlah, metode: f.metode.value }); });
      dialog.close();
      render();
      toast(rec && rec.data.lunas ? t('Tagihan lunas') : t('Pembayaran {jumlah} dicatat', { jumlah: rp(jumlah) }));
      return;
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
      toast(t('Bahan tersimpan'));
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
          P.ubahStok(store, { bahan: H.bahanProduksi(p.data, batch) }, -1);
        });
        toast(t('Stok bertambah'));
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
      toast(t('Pengeluaran tersimpan'));
    }
    if (f.id === 'formAuth') {
      e.preventDefault();
      await kirimAuth(f);
    }
    if (f.id === 'formKunci') {
      e.preventDefault();
      const pin = f.pin.value.trim();
      if (!/^[0-9]{4,8}$/.test(pin)) { ui.kunciMsg = { type: 'err', text: t('PIN harus 4–8 angka.') }; render(); return; }
      const garam = S.kodeAcak(12);
      ubahPengaturan({ kunci: { garam, hash: await S.hashPin(pin, garam) } });
      ui.kunciMsg = null;
      ui.cart = {};
      ui.view = 'kasir';
      render();
      toast(t('HP ini dikunci ke kasir'));
    }
    if (f.id === 'formBukaKunci') {
      e.preventDefault();
      const k = setel.kunci;
      if (k && (await S.hashPin(f.pin.value.trim(), k.garam)) === k.hash) {
        ui.kunciMsg = null;
        ubahPengaturan({ kunci: null });
        toast(t('Kunci kasir dibuka'));
      } else {
        ui.kunciMsg = { type: 'err', text: t('PIN salah.') };
        render();
      }
    }
    if (f.id === 'formGabung') {
      e.preventDefault();
      await gabungStaff(f);
    }
    if (f.id === 'formSandiBaru') {
      e.preventDefault();
      const { error } = await cloud.client.auth.updateUser({ password: f.password.value });
      if (error) { ui.authMsg = { type: 'err', text: pesanAuth(error) }; render(); return; }
      cloud.recovering = false;
      ui.authMsg = { type: 'ok', text: t('Kata sandi baru tersimpan.') };
      render();
    }
  });

  // ---------- Cloud ----------

  function pesanAuth(error) {
    const m = (error && error.message) || String(error);
    if (/Invalid login credentials/i.test(m)) return t('Email atau kata sandi salah.');
    if (/Email not confirmed/i.test(m)) return t('Email belum dikonfirmasi. Buka email dari Kelola dan klik tautan konfirmasi.');
    if (/already registered/i.test(m)) return t('Email ini sudah terdaftar. Silakan masuk.');
    if (/Password should be/i.test(m)) return t('Kata sandi minimal 6 karakter.');
    if (/fetch|network/i.test(m)) return t('Tidak ada koneksi internet. Coba lagi nanti.');
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
        if (!data.session) ui.authMsg = { type: 'ok', text: t('Hampir selesai. Kami mengirim email konfirmasi ke {email}. Klik tautannya, lalu masuk di sini.', { email }) };
      } else if (ui.authMode === 'lupa') {
        const { error } = await auth.resetPasswordForEmail(email, { redirectTo: redirect });
        if (error) throw error;
        ui.authMsg = { type: 'ok', text: t('Tautan untuk membuat kata sandi baru sudah dikirim ke {email}.', { email }) };
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
    const pending = modeStaff() ? kasirStaff.antrian.length : store.dirtyRecords().length;
    const tanya = pending
      ? t('Masih ada {n} perubahan yang belum terkirim ke cloud dan akan hilang jika Anda keluar sekarang. Tetap keluar?', { n: pending })
      : t('Keluar dari akun? Data di perangkat ini akan dihapus, tapi tetap aman di cloud.');
    if (!confirm(tanya)) return;
    await cloud.client.auth.signOut().catch(() => {});
    const wasStaff = modeStaff();
    setUser(null);
    if (wasStaff) S.hapusKasir(window.localStorage);
    else store.clear();
    ui.cart = {};
    ui.trxTerakhir = null;
    ui.authMode = 'masuk';
    ui.authMsg = { type: 'ok', text: t('Anda sudah keluar.') };
    render();
  }

  // Peran akun: staff (punya baris di tabel staff) atau owner. Disimpan supaya tetap
  // tahu walau sedang offline.
  const KEY_PERAN = 'kelola:peran';
  async function cekPeran(user) {
    try {
      const peran = await cloud.staffApi.peran(user.id);
      localStorage.setItem(KEY_PERAN, JSON.stringify({ userId: user.id, peran }));
      return peran;
    } catch (err) {
      if (S.belumDisiapkan(err)) { ui.staff.belumSiap = true; return null; }
      try {
        const c = JSON.parse(localStorage.getItem(KEY_PERAN) || 'null');
        if (c && c.userId === user.id) return c.peran;
      } catch (e) { /* abaikan */ }
      return null;
    }
  }

  function mulaiOwner(user) {
    cloud.peran = 'owner';
    kasirStaff = null;
    store.claim(user.id);
    const remote = KelolaSync.supabaseRemote(cloud.client, user.id);
    cloud.sync = KelolaSync.createSync(store, remote, (status, detail) => {
      cloud.status = status;
      if (status === 'synced') { cloud.lastSynced = detail; cloud.lastError = null; }
      if (status === 'error') cloud.lastError = detail;
      renderAman();
    });
  }

  function mulaiStaff(user, peran) {
    cloud.peran = 'staff';
    cloud.sync = null;
    kasirStaff = S.bacaKasir(window.localStorage, user.id);
    kasirStaff.ownerId = peran.owner_id;
    kasirStaff.nama = peran.nama;
    simpanKasirStaff();
    ui.cart = {};
    ui.trxTerakhir = null;
    if (ui.view !== 'akun') ui.view = 'kasir';
  }

  // Render ulang kecuali pengguna sedang mengetik atau membuka dialog.
  function renderAman() {
    if (!dialog.open && !document.activeElement.matches('input')) render();
    else renderBadge();
  }

  async function setUser(user) {
    const prev = cloud.user && cloud.user.id;
    cloud.user = user;
    if (!user) {
      cloud.sync = null;
      cloud.peran = null;
      cloud.status = 'idle';
      kasirStaff = null;
      ui.staff = { list: null, kode: null, msg: null, belumSiap: false, memuat: false };
      return;
    }
    if (prev === user.id && cloud.peran) return;
    cloud.staffApi = S.supabaseStaff(cloud.client);
    const peran = await cekPeran(user);
    if (!cloud.user || cloud.user.id !== user.id) return;
    if (peran) mulaiStaff(user, peran);
    else mulaiOwner(user);
    render();
    syncNow(false);
  }

  let syncTimer = null;
  function scheduleSync() {
    renderBadge();
    if (!cloud.sync && !modeStaff()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(false), 1500);
  }

  function syncNow(loud) {
    if ((!cloud.sync && !modeStaff()) || !navigator.onLine) {
      renderBadge();
      if (loud) toast(t('Tidak ada koneksi internet'));
      return Promise.resolve();
    }
    const jalan = modeStaff() ? syncStaff() : cloud.sync.run().then(prosesPenjualanStaff);
    return jalan.then(
      () => { if (loud) toast(t('Data sudah sinkron')); },
      (err) => { console.warn('Sinkronisasi gagal', err); },
    );
  }

  // ---------- Staff ----------

  function pesanStaff(err) {
    const m = (err && err.message) || String(err);
    if (/Bukan akun staff/i.test(m)) return t('Akun ini sudah tidak terdaftar sebagai staff. Hubungi owner.');
    if (/Kode undangan tidak berlaku/i.test(m)) return t('Kode undangan salah, sudah dipakai, atau sudah kedaluwarsa.');
    if (/milik akun Anda sendiri/i.test(m)) return t('Kode ini dibuat oleh akun Anda sendiri. Masuk dengan akun staff untuk memakainya.');
    if (/fetch|network/i.test(m)) return t('Tidak ada koneksi internet. Coba lagi nanti.');
    return m;
  }

  // HP staff: kirim penjualan yang tertunda, lalu ambil produk terbaru dari owner.
  let staffJalan = null;
  function syncStaff() {
    if (staffJalan) return staffJalan;
    staffJalan = (async () => {
      cloud.status = 'syncing';
      renderBadge();
      try {
        const s = kasirStaff;
        if (s.antrian.length) {
          const kirim = s.antrian.slice();
          await cloud.staffApi.kirim(s.ownerId, kirim);
          const terkirim = new Set(kirim.map((j) => j.id));
          s.antrian = s.antrian.filter((j) => !terkirim.has(j.id));
          simpanKasirStaff();
        }
        if (!s.antrian.length) {
          const d = await cloud.staffApi.produkKasir();
          s.produk = d.produk || [];
          s.usaha = d.usaha || {};
          simpanKasirStaff();
        }
        cloud.status = 'synced';
        cloud.lastSynced = new Date();
        cloud.lastError = null;
      } catch (err) {
        cloud.status = 'error';
        cloud.lastError = err;
        throw err;
      } finally {
        staffJalan = null;
        renderAman();
      }
    })();
    return staffJalan;
  }

  // HP owner: ambil penjualan dari akun staff, hitung modal dan laba, potong stok.
  let ambilJalan = false;
  async function prosesPenjualanStaff() {
    if (cloud.peran !== 'owner' || ui.staff.belumSiap || ambilJalan || !cloud.user) return;
    ambilJalan = true;
    try {
      const rows = await cloud.staffApi.ambilPenjualan(cloud.user.id);
      if (!rows.length) return;
      // Muat ulang daftar staff kalau ada staff baru yang belum dikenal.
      const kenal = (id) => (ui.staff.list || []).some((st) => st.staff_id === id);
      if (rows.some((r) => !kenal(r.staff_id))) {
        ui.staff.list = await cloud.staffApi.daftarStaff(cloud.user.id).catch(() => ui.staff.list);
      }
      const nama = (id) => { const x = (ui.staff.list || []).find((st) => st.staff_id === id); return x && x.nama; };
      let n = 0;
      change(() => { n = P.olahPenjualanStaff(store, H, rows, nama); });
      if (n) renderAman();
    } catch (err) {
      if (S.belumDisiapkan(err)) ui.staff.belumSiap = true;
      else console.warn('Gagal mengambil penjualan staff', err);
    } finally {
      ambilJalan = false;
    }
  }

  async function muatStaff() {
    ui.staff.memuat = true;
    try {
      ui.staff.list = await cloud.staffApi.daftarStaff(cloud.user.id);
    } catch (err) {
      if (S.belumDisiapkan(err)) ui.staff.belumSiap = true;
      else ui.staff.msg = { type: 'err', text: pesanStaff(err) };
      // Jangan coba terus-menerus; dimuat lagi saat sinkron berikutnya.
      ui.staff.list = [];
    }
    ui.staff.memuat = false;
    if (ui.view === 'akun') renderAman();
  }

  async function undangStaff() {
    ui.staff.msg = null;
    try {
      ui.staff.kode = await cloud.staffApi.buatUndangan();
    } catch (err) {
      if (S.belumDisiapkan(err)) ui.staff.belumSiap = true;
      else ui.staff.msg = { type: 'err', text: pesanStaff(err) };
    }
    render();
  }

  async function hapusStaff(id) {
    const x = (ui.staff.list || []).find((st) => st.staff_id === id);
    if (!confirm(t('Hapus {nama} dari staff? Akun itu tidak bisa memakai kasir Anda lagi.', { nama: x ? x.nama : 'staff' }))) return;
    try {
      await cloud.staffApi.hapusStaff(id);
      ui.staff.list = (ui.staff.list || []).filter((st) => st.staff_id !== id);
    } catch (err) {
      ui.staff.msg = { type: 'err', text: pesanStaff(err) };
    }
    render();
  }

  async function gabungStaff(f) {
    const ada = store.list('produk').length + store.list('transaksi').length;
    if (ada && !confirm(t('Akun ini sudah punya data usaha sendiri. Setelah bergabung sebagai staff, akun ini hanya bisa memakai kasir owner. Lanjutkan?'))) return;
    const btn = f.querySelector('button');
    btn.disabled = true;
    ui.gabungMsg = null;
    try {
      await syncNow(false);
      const ownerId = await cloud.staffApi.gabung(f.kode.value, f.nama.value.trim());
      const peran = { owner_id: ownerId, nama: f.nama.value.trim() };
      localStorage.setItem(KEY_PERAN, JSON.stringify({ userId: cloud.user.id, peran }));
      store.clear();
      mulaiStaff(cloud.user, peran);
      ui.view = 'kasir';
      await syncStaff().catch(() => {});
      toast(t('Anda sekarang staff'));
    } catch (err) {
      ui.gabungMsg = { type: 'err', text: pesanStaff(err) };
    }
    btn.disabled = false;
    render();
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
    if (e.key === KelolaStore.KEY || e.key === KelolaBahasa.KEY || e.key === KelolaStaff.KEY) location.reload();
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', terapkanTema);

  terapkanTema();
  initCloud();
  render();

  // Untuk pengujian.
  window.Kelola = { store, cloud, ui, H, setel };
})();
