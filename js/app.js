(function () {
  'use strict';

  const store = KelolaStore.createStore(window.localStorage);
  const H = KelolaHitung;
  const P = KelolaPenjualan;
  const W = KelolaWarna;
  const G = KelolaGrafik;
  const S = KelolaStaff;
  const F = KelolaFaceId;
  const K = KelolaKategori;
  const V = KelolaVarian;
  const Q = KelolaQris;
  const T = KelolaTagihan;
  const config = window.KELOLA_CONFIG || {};
  const cloudReady = !!(config.supabaseUrl && config.supabaseAnonKey && window.supabase);

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const viewEl = $('#view');
  const dialog = $('#dialog');

  // Pengaturan tampilan dan bahasa disimpan per perangkat, bukan di cloud.
  const setel = KelolaBahasa.bacaPengaturan(window.localStorage);
  const VERSI = window.KELOLA_VERSI || '';
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
    cart: {}, // kunci baris -> qty; kunci = id produk, atau produk + pilihan varian + catatan (js/varian.js)
    bayar: '',
    metode: 'tunai', // tunai | qris | nanti
    pelanggan: { nama: '', wa: '' }, // untuk "bayar nanti"
    jatuhTempo: undefined, // jatuh tempo pilihan di kasir: undefined = bawaan, null = tanpa, 'YYYY-MM-DD'
    notifMsg: null,
    trxTerakhir: null, // penjualan yang baru disimpan, untuk tombol struk
    produkTab: 'produk', // produk | bahan
    kategori: null, // filter kategori di kasir: null = semua, '' = Lainnya
    periode: 'hari',
    dari: '', // periode pilihan sendiri (YYYY-MM-DD)
    sampai: '',
    lipat: {}, // bagian Akun yang sedang dibuka
    grafik: null, // data grafik laporan yang sedang tampil, untuk keterangan saat disentuh
    gerbang: 'pilih', // layar awal: pilih | owner | daftar | lupa | staff
    gerbangMsg: null,
    authMode: 'masuk',
    authMsg: null,
    authEmail: '',
    struk: null, // { blob, url, teks }
    foto: null, // foto produk di form yang sedang dibuka (data URL)
    kunciMsg: null,
    gabungMsg: null,
    staff: { list: null, kode: null, msg: null, belumSiap: false, memuat: false }, // daftar staff untuk owner
    faceIdBisa: null, // HP ini punya Face ID / sidik jari untuk web (null = belum dicek)
    faceIdMsg: null,
    tawarFaceId: null, // id akun yang baru masuk dengan kata sandi: tawarkan Face ID
    midtrans: null, // status QRIS Midtrans akun ini: { terhubung, aktif, uji } | { belumSiap } | { gagal } | { memuat }
    midtransMsg: null,
    bayarOnline: null, // QRIS Midtrans yang sedang ditunggu di kasir: { order, total }
    midtransOrder: null, // pesanan Midtrans untuk penjualan yang akan disimpan
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

  // Mode yang dipilih di layar awal: 'owner' atau 'kasir'. Disimpan di sessionStorage, jadi
  // ditanya lagi setiap aplikasi ditutup lalu dibuka (muat ulang halaman tidak menghapusnya).
  const KEY_SESI = 'kelola:mode';
  const bacaSesi = () => { try { return sessionStorage.getItem(KEY_SESI); } catch (e) { return null; } };
  let modeSesi = bacaSesi();
  function setModeSesi(m) {
    modeSesi = m;
    try { if (m) sessionStorage.setItem(KEY_SESI, m); else sessionStorage.removeItem(KEY_SESI); } catch (e) { /* abaikan */ }
  }
  // Kasir dipilih di HP owner: tampilan sama seperti mode PIN, tanpa PIN.
  const modeKasirSesi = () => modeSesi === 'kasir' && !modeStaff();
  const hanyaKasir = () => modeStaff() || modeKunci() || modeKasirSesi();
  // Layar awal tampil sampai mode dipilih. Tidak untuk HP yang dikunci PIN, akun staff, atau saat reset kata sandi.
  const perluGerbang = () => ui.gantiAkun || (!modeSesi && !modeKunci() && cloud.peran !== 'staff' && !cloud.recovering);

  // Akun yang pernah masuk di HP ini (untuk Ganti akun). Data tiap akun disimpan terpisah oleh store.claim().
  const KEY_AKUN = 'kelola:akun';
  function daftarAkun() {
    try { return JSON.parse(localStorage.getItem(KEY_AKUN) || '[]'); } catch (e) { return []; }
  }
  function simpanDaftarAkun(list) {
    try { localStorage.setItem(KEY_AKUN, JSON.stringify(list)); } catch (e) { /* abaikan */ }
  }
  function catatAkunIni() {
    if (!cloud.user || !cloud.peran) return;
    const a = {
      id: cloud.user.id,
      email: cloud.user.email,
      nama: (modeStaff() ? (kasirStaff.usaha || {}).namaUsaha : profil().namaUsaha) || '',
      staff: modeStaff(),
    };
    const list = daftarAkun();
    const i = list.findIndex((x) => x.id === a.id);
    if (i >= 0 && JSON.stringify(list[i]) === JSON.stringify(a)) return;
    if (i >= 0) list[i] = a;
    else list.push(a);
    simpanDaftarAkun(list);
  }
  // Hapus akun dari HP ini: data yang tersimpan untuk akun itu ikut dihapus (data di cloud tetap aman).
  function lupakanAkun(id) {
    simpanDaftarAkun(daftarAkun().filter((a) => a.id !== id));
    F.hapus(window.localStorage, id);
    try {
      localStorage.removeItem(KelolaStore.arsipKey(id));
      if (S.bacaKasir(window.localStorage, id).ownerId) S.hapusKasir(window.localStorage);
    } catch (e) { /* abaikan */ }
  }

  // Hash kata sandi owner terakhir yang berhasil masuk, supaya owner tetap bisa masuk saat offline.
  const KEY_SANDI = 'kelola:sandi';
  function bacaSandi() {
    try { return JSON.parse(localStorage.getItem(KEY_SANDI) || 'null'); } catch (e) { return null; }
  }
  async function simpanSandi(email, password) {
    const garam = S.kodeAcak(12);
    try { localStorage.setItem(KEY_SANDI, JSON.stringify({ email: email.toLowerCase(), garam, hash: await S.hashPin(password, garam) })); } catch (e) { /* abaikan */ }
  }
  const hapusSandi = () => { try { localStorage.removeItem(KEY_SANDI); } catch (e) { /* abaikan */ } };

  // Face ID / sidik jari sebagai pengganti kata sandi owner di layar awal (lihat js/faceid.js).
  // Disimpan per akun dan per perangkat. ui.faceIdBisa: null = belum dicek.
  const kunciFaceId = () => (cloud.user ? F.untuk(window.localStorage, cloud.user.id) : null);
  const faceIdAktif = () => !!kunciFaceId() && ui.faceIdBisa !== false;
  // Sebelum pindah akun: simpan sesi akun ini kalau Face ID-nya aktif, supaya nanti bisa kembali tanpa kata sandi.
  async function simpanSesiFaceId() {
    if (!cloud.user || !kunciFaceId()) return;
    try {
      const { data } = await cloud.client.auth.getSession();
      if (data.session && data.session.user.id === cloud.user.id) F.simpanSesi(window.localStorage, cloud.user.id, data.session);
    } catch (e) { /* abaikan: pindah akun tetap jalan, kembali nanti pakai kata sandi */ }
  }
  // Akun di daftar HP ini yang bisa dibuka dengan Face ID (punya kunci dan sesi tersimpan).
  function faceIdAkun(email) {
    const a = daftarAkun().find((x) => x.email.toLowerCase() === String(email || '').toLowerCase());
    const k = a && F.untuk(window.localStorage, a.id);
    return k && k.sesi && ui.faceIdBisa !== false ? { akun: a, kunci: k } : null;
  }
  async function cekFaceIdBisa() {
    const bisa = await F.bisa();
    if (bisa !== ui.faceIdBisa) { ui.faceIdBisa = bisa; renderAman(); }
  }

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

  // Urutan kategori produk (lihat js/kategori.js), dari profil owner.
  const urutanKategori = () => usaha().kategori || [];
  const daftarKategori = () => K.daftar(urutanKategori(), produkKasir().map((p) => p.data));

  // Simpan urutan kategori di profil kalau ada kategori baru dari form produk.
  function catatKategori() {
    const p = profil();
    const baru = K.daftar(p.kategori, produkList().map((r) => r.data));
    if (JSON.stringify(baru) !== JSON.stringify(p.kategori || [])) store.put('profil', Object.assign({}, p, { kategori: baru }), 'profil');
  }

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
    const src = logoTampil();
    if (logo.getAttribute('src') !== src) logo.setAttribute('src', src);
    pasangLatarLogo(usaha().logo || 'icons/logo.png');
  }

  // Logo di layar (kepala halaman, layar awal, Akun) memakai versi yang pinggiran
  // putihnya sudah dibersihkan, dengan latar warna tepi logo (variabel CSS --logo-latar).
  // var/function (bukan let/const) supaya aman dipanggil sebelum baris ini dijalankan.
  var latarLogoUntuk = null;
  var logoBersih = null; // { untuk, src }
  function logoTampil() {
    const asli = usaha().logo || 'icons/logo.png';
    return logoBersih && logoBersih.untuk === asli ? logoBersih.src : asli;
  }
  function pasangLatarLogo(src) {
    if (src === latarLogoUntuk) return;
    latarLogoUntuk = src;
    muatGambar(src).then((img) => {
      if (latarLogoUntuk !== src || !img) return;
      const l = siapkanLogo(img);
      document.documentElement.style.setProperty('--logo-latar', l.warna);
      try { logoBersih = { untuk: src, src: l.gambar.toDataURL ? l.gambar.toDataURL('image/png') : src }; } catch (e) { logoBersih = null; }
      document.querySelectorAll('img[data-logo-usaha], header.nav .logo').forEach((el) => el.setAttribute('src', logoTampil()));
    });
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
    catatAkunIni();
    const gerbang = perluGerbang();
    document.body.classList.toggle('gerbang', gerbang);
    if (gerbang) {
      document.body.classList.remove('hanya-kasir', 'ada-ringkasan');
      terapkanWarnaUsaha();
      viewEl.innerHTML = viewGerbang();
      return;
    }
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
    $('#subjudul').innerHTML = labelPeran() + esc(usaha().namaUsaha || t(sub));
    document.body.classList.toggle('hanya-kasir', hanyaKasir());
    terapkanWarnaUsaha();
    renderBadge();
    renderTandaLaporan();
    renderSummary();
    const views = { kasir: viewKasir, produk: viewProduk, laporan: viewLaporan, akun: viewAkun };
    viewEl.innerHTML = viewTawarFaceId() + (ui.view === 'kasir' || ui.view === 'laporan' ? viewPengingat() : '') + views[ui.view]();
  }

  // Label kecil di bawah judul: siapa yang sedang memakai aplikasi.
  function labelPeran() {
    if (modeStaff()) return `<span class="peran terbatas">${t('STAFF')}${kasirStaff.nama ? ' · ' + esc(kasirStaff.nama) : ''}</span>`;
    if (hanyaKasir()) return `<span class="peran terbatas">${t('KASIR')}</span>`;
    return `<span class="peran">${t('OWNER')}</span>`;
  }

  // ---------- Layar awal: pilih Owner atau Kasir / Staff ----------

  const IKON_OWNER = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
  const IKON_FACEID = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M9 9v1M15 9v1M12 9v4h-1M9 16c1.8 1.3 4.2 1.3 6 0"/></svg>';
  const IKON_KASIR = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h4M7 17h2M14 15h3"/></svg>';

  // Belum pernah ada akun di HP ini: boleh dipakai tanpa akun (data hanya di HP ini).
  // Sesi Supabase yang tersimpan (dibaca langsung, karena cloud.user baru terisi beberapa saat setelah aplikasi dibuka).
  const adaSesiTersimpan = () => { try { return Object.keys(localStorage).some((k) => /^sb-.*-auth-token$/.test(k)); } catch (e) { return false; } };
  const tanpaAkunBoleh = () => !cloud.user && !bacaSandi() && !adaSesiTersimpan() && !daftarAkun().length;

  function viewGerbang() {
    const u = usaha();
    const merek = (sub) => `<div class="merek"><img data-logo-usaha src="${esc(logoTampil())}" alt="">
      <h1>${esc(u.namaUsaha || 'Kelola')}</h1><p>${sub}</p></div>`;
    const kembali = (ke, teks) => `<button type="button" class="kembali" data-act="gerbang" data-g="${ke}">← ${teks}</button>`;
    const msg = pesan(ui.gerbangMsg);
    const g = ui.gerbang;
    const akun = daftarAkun();
    const aktif = (a) => cloud.user && a.id === cloud.user.id;
    const ketAkun = (a) => `${esc(a.email)}${a.staff ? ' · ' + t('Staff') : ''}${!aktif(a) && faceIdAkun(a.email) ? ' · Face ID' : ''}`;
    const kembaliAkun = ui.gantiAkun
      ? `<button type="button" class="kembali" data-act="batal-ganti-akun">← ${t('Kembali ke aplikasi')}</button>`
      : kembali('pilih', t('Kembali pilih mode'));
    let isi;
    if (g === 'akun') {
      isi = `${merek(t('Ganti akun'))}
        <div class="card stack">
          <ul class="list akun-pilih">${akun.map((a) => `<li><button type="button" class="pilih-akun" data-act="pilih-akun" data-email="${esc(a.email)}">
            <span class="t"><b>${esc(a.nama || a.email)}</b><span class="small muted">${ketAkun(a)}</span></span>
            ${aktif(a) ? `<span class="aktif small">● ${t('Aktif')}</span>` : '<span class="muted" aria-hidden="true">›</span>'}</button></li>`).join('')}</ul>
          <button type="button" class="btn block" data-act="gerbang" data-g="masuk-akun" data-email="">${t('+ Tambah akun lain')}</button>
        </div>
        <div class="hint">${t('Data tiap akun (produk, penjualan, laporan) disimpan terpisah di HP ini. Pindah akun meminta kata sandi akun itu, atau Face ID / sidik jari kalau sudah diaktifkan di akun itu.')}</div>
        ${kembaliAkun}`;
    } else if (g === 'masuk-akun') {
      isi = `${merek(t('Masuk ke akun lain'))}
        <div class="card stack">
          ${msg}
          <form id="formGantiAkun" class="stack">
            <label class="field"><span>${t('Email')}</span><input name="email" type="email" autocomplete="email" required value="${esc(ui.authEmail)}"></label>
            <label class="field"><span>${t('Kata sandi')}</span><input name="password" type="password" autocomplete="current-password" required></label>
            <button class="btn primary block">${t('Masuk')}</button>
          </form>
          <button type="button" class="link" data-act="gerbang" data-g="lupa">${t('Lupa kata sandi?')}</button>
        </div>
        <button type="button" class="btn block" data-act="gerbang" data-g="daftar">${t('Belum punya akun? Daftar')}</button>
        ${akun.length ? kembali('akun', t('Kembali ke daftar akun')) : kembaliAkun}`;
    } else if (g === 'owner' || g === 'staff') {
      const owner = g === 'owner';
      const kunciEmail = owner && cloud.user;
      const faceId = owner && faceIdAktif();
      const ajakFaceId = owner && cloud.user && !faceId && ui.faceIdBisa;
      isi = `${merek(owner ? t('Masuk sebagai Owner') : t('Masuk dengan akun staff'))}
        <div class="card stack">
          ${owner ? '' : `<div class="small muted">${t('Minta kode undangan ke owner. Daftar dengan email Anda sendiri, lalu masukkan kodenya di menu Akun.')}</div>`}
          ${msg}
          ${faceId ? `<button type="button" class="btn primary block btn-faceid" data-act="owner-faceid">${IKON_FACEID}${t('Masuk dengan Face ID / sidik jari')}</button>
            <div class="atau small muted">${t('atau pakai kata sandi')}</div>` : ''}
          <form id="formGerbang" class="stack" data-tujuan="${owner ? 'owner' : 'kasir'}">
            <label class="field"><span>${t('Email')}</span><input name="email" type="email" autocomplete="email" required value="${esc(kunciEmail ? cloud.user.email : ui.authEmail)}" ${kunciEmail ? 'readonly' : ''}></label>
            <label class="field"><span>${t('Kata sandi')}</span><input name="password" type="password" autocomplete="current-password" required></label>
            <button class="btn ${faceId ? '' : 'primary'} block">${t('Masuk')}</button>
          </form>
          <button type="button" class="link" data-act="gerbang" data-g="lupa">${t('Lupa kata sandi?')}</button>
        </div>
        ${cloud.user ? '' : `<button type="button" class="btn block" data-act="gerbang" data-g="daftar">${t('Belum punya akun? Daftar')}</button>`}
        ${owner && tanpaAkunBoleh() ? `<button type="button" class="link tengah" data-act="tanpa-akun">${t('Pakai tanpa akun (data hanya di HP ini)')}</button>` : ''}
        ${owner ? `<div class="hint">${faceId ? t('Untuk keamanan, Face ID / sidik jari atau kata sandi diminta lagi setiap kali aplikasi ditutup lalu dibuka.')
          : t('Untuk keamanan, kata sandi diminta lagi setiap kali aplikasi ditutup lalu dibuka.')}
          ${ajakFaceId ? `<br>${t('Tidak mau mengetik kata sandi? Setelah masuk, aktifkan Face ID / sidik jari di menu Akun.')}` : ''}</div>` : ''}
        ${kembali('pilih', t('Kembali pilih mode'))}`;
    } else if (g === 'daftar') {
      isi = `${merek(t('Daftar akun baru'))}
        <div class="card stack">
          ${msg}
          <form id="formDaftar" class="stack">
            <label class="field"><span>${t('Nama usaha (untuk owner)')}</span><input name="usaha" autocomplete="organization" value="${esc(cloud.user ? '' : profil().namaUsaha || '')}" placeholder="${t('Contoh: Warung Bu Sari')}"></label>
            <label class="field"><span>${t('Email')}</span><input name="email" type="email" autocomplete="email" required value="${esc(ui.authEmail)}"></label>
            <label class="field"><span>${t('Kata sandi (min. 6 karakter)')}</span><input name="password" type="password" minlength="6" autocomplete="new-password" required></label>
            <label class="field"><span>${t('Ulangi kata sandi')}</span><input name="ulang" type="password" minlength="6" autocomplete="new-password" required></label>
            <button class="btn primary block">${t('Daftar')}</button>
          </form>
        </div>
        <div class="hint">${t('Akun baru menjadi akun Owner. Staff bisa ditambahkan nanti dari menu Akun.')}</div>
        ${kembali(ui.gerbangAsal === 'masuk-akun' ? 'masuk-akun' : 'owner', t('Sudah punya akun? Masuk'))}`;
    } else if (g === 'lupa') {
      isi = `${merek(t('Lupa kata sandi'))}
        <div class="card stack">
          <div class="small muted">${t('Masukkan email akun Anda. Kami kirim tautan untuk membuat kata sandi baru.')}</div>
          ${msg}
          <form id="formLupa" class="stack">
            <label class="field"><span>${t('Email')}</span><input name="email" type="email" autocomplete="email" required value="${esc(cloud.user && ui.gerbangAsal !== 'masuk-akun' ? cloud.user.email : ui.authEmail)}"></label>
            <button class="btn primary block">${t('Kirim tautan reset')}</button>
          </form>
        </div>
        ${kembali(ui.gerbangAsal === 'masuk-akun' ? 'masuk-akun' : 'owner', t('Kembali ke Masuk'))}`;
    } else {
      const ini = cloud.user && akun.find(aktif);
      const chip = cloud.user
        ? `<div class="akun-chip" id="akunChip"><div class="t"><b>${esc((ini && ini.nama) || cloud.user.email)}</b><span class="small muted">${esc(cloud.user.email)}</span></div>
            <button type="button" class="btn kecil" data-act="gerbang" data-g="akun">${t('Ganti akun')}</button></div>`
        : akun.length ? `<button type="button" class="link tengah" data-act="gerbang" data-g="akun">${t('Pilih akun yang pernah masuk di HP ini')}</button>` : '';
      isi = `${merek(t('Buka sebagai'))}${chip}
        ${faceIdAktif()
          ? `<button type="button" class="pilih-mode" data-act="owner-faceid"><span class="ik">${IKON_OWNER}</span>
          <span><b>${t('Owner')}</b><span>${t('Semua fitur: produk, laporan, staff, dan pengaturan. Masuk dengan Face ID / sidik jari.')}</span></span></button>`
          : `<button type="button" class="pilih-mode" data-act="gerbang" data-g="owner"><span class="ik">${IKON_OWNER}</span>
          <span><b>${t('Owner')}</b><span>${t('Semua fitur: produk, laporan, staff, dan pengaturan. Perlu kata sandi.')}</span></span></button>`}
        <button type="button" class="pilih-mode kasir" data-act="pilih-kasir"><span class="ik">${IKON_KASIR}</span>
          <span><b>${t('Kasir / Staff')}</b><span>${t('Langsung buka kasir untuk mencatat penjualan. Modal dan laba tidak tampil.')}</span></span></button>
        ${msg}
        <p class="small muted tengah">${t('Pilihan ini muncul setiap kali aplikasi dibuka.')}</p>
        ${cloud.user ? '' : `<p class="tengah">${t('Baru pakai Kelola?')} <button type="button" class="link" data-act="gerbang" data-g="daftar">${t('Daftar')}</button></p>`}
        <div class="tengah">${pilihSetel('bahasa', setel.bahasa, [['en', 'English'], ['id', 'Bahasa Indonesia']])}</div>`;
    }
    return `<div class="gerbang-isi" id="gerbang">${isi}<div class="versi" id="versiGerbang">Kelola · Ver ${esc(VERSI)}</div></div>`;
  }

  // Pilih Kasir: HP owner (atau yang sudah punya produk) langsung ke kasir; HP kosong masuk dengan akun staff.
  function pilihKasir() {
    ui.gerbangMsg = null;
    if (cloud.user || adaSesiTersimpan() || !cloudReady || store.list('produk').length) {
      setModeSesi('kasir');
      ui.view = 'kasir';
      ui.cart = {};
      render();
      return;
    }
    ui.gerbang = 'staff';
    render();
  }

  function masukMode(m) {
    setModeSesi(m);
    ui.gantiAkun = false;
    ui.gerbang = 'pilih';
    ui.gerbangMsg = null;
    ui.view = m === 'owner' && ui.bukaTagihan ? 'laporan' : 'kasir';
    ui.bukaTagihan = false;
    ui.cart = {};
    render();
    window.scrollTo(0, 0);
  }

  // Owner dengan Face ID / sidik jari. Kalau batal atau gagal, tampilkan isian kata sandi.
  let faceIdJalan = false;
  async function masukFaceId() {
    const kunci = kunciFaceId();
    if (!kunci || faceIdJalan) return;
    faceIdJalan = true;
    let ok = false;
    try { ok = await F.cek(kunci); } catch (e) { ok = false; }
    faceIdJalan = false;
    if (ok) { masukMode('owner'); return; }
    ui.gerbang = ui.gerbangAsal = 'owner';
    ui.gerbangMsg = { type: 'err', text: t('Face ID / sidik jari tidak berhasil. Coba lagi, atau masuk dengan kata sandi.') };
    render();
    window.scrollTo(0, 0);
  }

  // Ke layar awal lagi (tombol Ganti mode).
  function gantiMode() {
    setModeSesi(null);
    ui.gerbang = 'pilih';
    ui.gerbangMsg = null;
    ui.cart = {};
    ui.trxTerakhir = null;
    render();
    window.scrollTo(0, 0);
  }

  // Masuk dari layar awal. Owner yang sudah masuk di HP ini tetap harus memasukkan kata sandi.
  async function kirimGerbang(f) {
    const email = f.email.value.trim();
    const password = f.password.value;
    const tujuan = f.dataset.tujuan;
    ui.authEmail = email;
    ui.gerbangMsg = null;
    const btn = f.querySelector('button');
    btn.disabled = true;
    const salah = () => { ui.gerbangMsg = { type: 'err', text: t('Email atau kata sandi salah.') }; };
    // Tanpa Supabase (belum diatur), tidak ada akun untuk dicek.
    if (!cloudReady) { masukMode(tujuan); return; }
    if (cloud.user && cloud.user.email.toLowerCase() !== email.toLowerCase()) {
      ui.gerbangMsg = { type: 'err', text: t('HP ini sedang masuk dengan {email}. Pakai email itu, atau keluar dulu dari menu Akun.', { email: cloud.user.email }) };
      btn.disabled = false;
      render();
      return;
    }
    const cocokLokal = async () => {
      const k = bacaSandi();
      return !!(cloud.user && k && k.email === email.toLowerCase() && (await S.hashPin(password, k.garam)) === k.hash);
    };
    try {
      if (!navigator.onLine && cloud.user) {
        if (await cocokLokal()) { masukMode(tujuan); return; }
        salah();
      } else {
        const { error } = await cloud.client.auth.signInWithPassword({ email, password });
        if (!error) {
          await simpanSandi(email, password);
          if (tujuan === 'owner') tawarkanFaceId();
          masukMode(tujuan);
          return;
        }
        if (/fetch|network/i.test(error.message) && (await cocokLokal())) { masukMode(tujuan); return; }
        ui.gerbangMsg = { type: 'err', text: pesanAuth(error) };
      }
    } catch (err) {
      if (await cocokLokal()) { masukMode(tujuan); return; }
      ui.gerbangMsg = { type: 'err', text: pesanAuth(err) };
    }
    btn.disabled = false;
    render();
  }

  async function kirimDaftar(f) {
    const email = f.email.value.trim();
    ui.authEmail = email;
    if (f.password.value !== f.ulang.value) {
      ui.gerbangMsg = { type: 'err', text: t('Kata sandi dan ulangannya tidak sama.') };
      render();
      return;
    }
    const namaUsaha = f.usaha.value.trim();
    const btn = f.querySelector('button');
    btn.disabled = true;
    // Sudah masuk dengan akun lain: akun baru ini ditambahkan (Ganti akun), data akun lama tidak tercampur.
    const tambah = !!cloud.user;
    try {
      if (tambah && navigator.onLine) await syncNow(false);
      if (tambah) await simpanSesiFaceId();
      const { data, error } = await cloud.client.auth.signUp({ email, password: f.password.value, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (namaUsaha && tambah) ui.usahaBaru = { id: data.user && data.user.id, nama: namaUsaha };
      else if (namaUsaha) change(() => store.put('profil', Object.assign({}, profil(), { namaUsaha }), 'profil'));
      if (data.session) {
        await simpanSandi(email, f.password.value);
        if (tambah) await setUser(data.user);
        tawarkanFaceId();
        masukMode('owner');
        return;
      }
      ui.gerbang = tambah ? 'masuk-akun' : 'owner';
      ui.gerbangMsg = { type: 'ok', text: t('Hampir selesai. Kami mengirim email konfirmasi ke {email}. Klik tautannya, lalu masuk di sini.', { email }) };
    } catch (err) {
      ui.gerbangMsg = { type: 'err', text: pesanAuth(err) };
    }
    btn.disabled = false;
    render();
  }

  async function kirimLupa(f) {
    const email = f.email.value.trim();
    ui.authEmail = email;
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      const { error } = await cloud.client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) throw error;
      ui.gerbangMsg = { type: 'ok', text: t('Tautan untuk membuat kata sandi baru sudah dikirim ke {email}. Cek juga folder spam.', { email }) };
    } catch (err) {
      ui.gerbangMsg = { type: 'err', text: pesanAuth(err) };
    }
    btn.disabled = false;
    render();
  }

  // Ganti akun: kirim dulu perubahan akun yang sedang aktif, lalu masuk ke akun lain.
  // Data akun sebelumnya tetap tersimpan di HP (store.claim) dan muncul lagi saat akun itu dipilih.
  async function kirimGantiAkun(f) {
    const email = f.email.value.trim();
    const password = f.password.value;
    ui.authEmail = email;
    ui.gerbangMsg = null;
    const btn = f.querySelector('button');
    btn.disabled = true;
    const gagal = (text) => {
      ui.gerbangMsg = { type: 'err', text };
      btn.disabled = false;
      render();
    };
    if (!cloudReady) { gagal(t('Sinkronisasi cloud belum diaktifkan di aplikasi ini, jadi data hanya tersimpan di perangkat ini.')); return; }
    if (cloud.user && cloud.user.email.toLowerCase() !== email.toLowerCase()) {
      if (navigator.onLine) await syncNow(false);
      if (modeStaff() && kasirStaff.antrian.length) {
        gagal(t('Masih ada {n} penjualan yang belum terkirim. Sambungkan internet sampai terkirim, lalu coba lagi.', { n: kasirStaff.antrian.length }));
        return;
      }
      await simpanSesiFaceId();
    }
    try {
      const { data, error } = await cloud.client.auth.signInWithPassword({ email, password });
      if (error) { gagal(pesanAuth(error)); return; }
      F.simpanSesi(window.localStorage, data.user.id, null);
      await simpanSandi(email, password);
      await setUser(data.user);
      tawarkanFaceId();
      masukMode('owner');
    } catch (err) {
      gagal(pesanAuth(err));
    }
  }

  // Pindah ke akun lain dengan Face ID, memakai sesi akun itu yang tersimpan di HP ini.
  // Kalau gagal, isian kata sandi akun itu yang tampil. Mengembalikan false kalau akun itu belum memakai Face ID.
  async function pindahFaceId(email) {
    const f = faceIdAkun(email);
    if (!f) return false;
    if (faceIdJalan) return true;
    const gagal = (text) => {
      ui.authEmail = f.akun.email;
      ui.gerbang = ui.gerbangAsal = 'masuk-akun';
      ui.gerbangMsg = { type: 'err', text };
      render();
      window.scrollTo(0, 0);
    };
    faceIdJalan = true;
    let ok = false;
    try { ok = await F.cek(f.kunci); } catch (e) { ok = false; }
    faceIdJalan = false;
    if (!ok) { gagal(t('Face ID / sidik jari tidak berhasil. Coba lagi, atau masuk dengan kata sandi.')); return true; }
    if (!navigator.onLine) { gagal(t('Pindah akun butuh internet. Sambungkan internet, lalu coba lagi.')); return true; }
    if (cloud.user) {
      await syncNow(false);
      if (modeStaff() && kasirStaff.antrian.length) {
        gagal(t('Masih ada {n} penjualan yang belum terkirim. Sambungkan internet sampai terkirim, lalu coba lagi.', { n: kasirStaff.antrian.length }));
        return true;
      }
    }
    // Perbarui sesi tersimpan langsung ke Supabase (bukan lewat supabase-js), supaya kalau sesi itu
    // sudah tidak berlaku, akun yang sedang aktif tidak ikut keluar.
    let baru;
    try {
      const res = await fetch(config.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: config.supabaseAnonKey, Authorization: 'Bearer ' + config.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: f.kunci.sesi.refresh_token }),
      });
      if (!res.ok) {
        F.simpanSesi(window.localStorage, f.akun.id, null);
        gagal(t('Akun ini perlu kata sandi sekali lagi. Setelah itu, pindah ke akun ini bisa memakai Face ID / sidik jari lagi.'));
        return true;
      }
      baru = await res.json();
    } catch (e) {
      gagal(t('Pindah akun butuh internet. Sambungkan internet, lalu coba lagi.'));
      return true;
    }
    await simpanSesiFaceId();
    try {
      const { data, error } = await cloud.client.auth.setSession({ access_token: baru.access_token, refresh_token: baru.refresh_token });
      if (error || !data.user) throw error || new Error('sesi');
      F.simpanSesi(window.localStorage, f.akun.id, null);
      await setUser(data.user);
      masukMode('owner');
    } catch (e) {
      F.simpanSesi(window.localStorage, f.akun.id, baru);
      gagal(pesanAuth(e));
    }
    return true;
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
    return Object.entries(ui.cart).map(([kunci, qty]) => {
      const u = V.urai(kunci);
      const rec = ambilKasir(u.produkId);
      if (!rec) return null;
      // Harga satu baris = harga produk + tambahan dari varian yang dipilih.
      const pil = V.pilih(rec.data.varian, u.ids);
      return { kunci, rec, qty, harga: (rec.data.harga || 0) + pil.tambah, varian: pil.label, catatan: u.catatan };
    }).filter(Boolean);
  }

  // Bar navy di atas tab bar, seperti bar total di Bagi Rata.
  function renderSummary() {
    const items = ui.view === 'kasir' ? isiKeranjang() : [];
    const qty = items.reduce((s, x) => s + x.qty, 0);
    const total = items.reduce((s, x) => s + x.harga * x.qty, 0);
    document.body.classList.toggle('ada-ringkasan', qty > 0);
    $('#summary').innerHTML = `<span>${t('Keranjang · {n} item', { n: angka.format(qty) })}</span><b>${rp(total)} ›</b>`;
  }

  // Bisa ditambah satu lagi ke keranjang tanpa melebihi stok?
  function bisaTambah(kunci, n) {
    const cart = V.perProduk(ui.cart);
    const id = V.urai(kunci).produkId;
    cart[id] = (cart[id] || 0) + (n || 1);
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
    const total = items.reduce((s, x) => s + x.harga * x.qty, 0);
    const bayar = num(ui.bayar);
    const grup = K.kelompok(produk, urutanKategori());
    const adaKategori = grup.some((g) => g.nama);
    if (ui.kategori !== null && !grup.some((g) => g.nama === ui.kategori)) ui.kategori = null;
    const tampil = !adaKategori || ui.kategori === null ? produk : grup.find((g) => g.nama === ui.kategori).items;
    const chip = (k, label, n) => `<button data-act="filter-kategori" data-k="${k === null ? '*' : esc(k)}" aria-pressed="${ui.kategori === k}">${esc(label)}<span class="n">${n}</span></button>`;
    const chips = adaKategori
      ? `<div class="kat-chips" role="group" aria-label="${t('Kategori')}">${chip(null, t('Semua'), produk.length)}${grup.map((g) => chip(g.nama, g.nama || t('Lainnya'), g.items.length)).join('')}</div>`
      : '';
    const diKeranjang = V.perProduk(ui.cart);
    const tiles = tampil.map((p) => {
      const d = p.data;
      const habis = !bisaTambah(p.id);
      const stok = d.stok != null && d.mode !== 'paket' ? `<div class="small muted">${t('Stok')} ${angka.format(d.stok)} ${esc(d.satuan || '')}</div>` : '';
      const jumlah = diKeranjang[p.id] ? `<span class="jumlah">${diKeranjang[p.id]}</span>` : '';
      const pilihan = V.ada(d) ? `<div class="small muted">${t('Ada pilihan')}</div>` : '';
      const foto = d.foto ? `<img class="foto" src="${esc(d.foto)}" alt="">` : '';
      return `<button class="tile ${d.foto ? 'ada-foto' : ''}" data-act="${V.ada(d) ? 'pilih-varian' : 'tambah-keranjang'}" data-id="${p.id}" ${habis ? 'disabled' : ''}>
        ${jumlah}${foto}<div class="isi"><div class="nama">${esc(d.nama)}</div><div class="harga">${rp(d.harga)}</div>${pilihan}${stok}</div></button>`;
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
          <div class="dengan-foto">${fotoKecil(x.rec.data)}<div><div class="nama">${esc(x.rec.data.nama)}</div>
            ${x.varian ? `<div class="small pilihan-baris">${esc(x.varian)}</div>` : ''}${x.catatan ? `<div class="small muted catatan-baris">“${esc(x.catatan)}”</div>` : ''}
            <div class="small muted">${rp(x.harga)} × ${x.qty} = ${rp(x.harga * x.qty)}</div></div></div>
          <div class="qty"><button data-act="kurang" data-id="${esc(x.kunci)}" aria-label="${t('Kurangi')}">−</button><span>${x.qty}</span>
          <button data-act="tambah-keranjang" data-id="${esc(x.kunci)}" aria-label="${t('Tambah')}" ${bisaTambah(x.kunci) ? '' : 'disabled'}>+</button></div></li>`).join('')}</ul>
        <div class="row" style="margin-top:8px"><span class="label">${t('Total')}</span><span class="total">${rp(total)}</span></div>
        <div class="seg kecil" id="metodeBayar" role="group" aria-label="${t('Cara bayar')}" style="margin:14px 0 0">${[['tunai', t('Tunai')], ['qris', t('QRIS')], ['nanti', t('Bayar nanti')]]
          .map(([k, l]) => `<button data-act="metode" data-m="${k}" aria-pressed="${ui.metode === k}">${l}</button>`).join('')}</div>
        ${isianBayar(total, bayar)}
        <div class="row" style="margin-top:16px">
          <button class="btn" data-act="kosongkan">${t('Batal')}</button>
          <button class="btn primary" data-act="simpan-penjualan">${t(ui.metode === 'qris' ? 'Sudah dibayar, simpan' : ui.metode !== 'nanti' ? 'Simpan penjualan' : modeStaff() ? 'Simpan sebagai tagihan' : 'Simpan & tagih')}</button>
        </div></div>`
      : '';
    const petunjuk = items.length ? '' : `<div class="foot" style="margin:0 8px 14px">${t('Ketuk produk untuk menambahkannya ke keranjang.')}</div>`;
    return `${info}${cart}<div class="group-title">${t('Produk')}</div>${petunjuk}${chips}<div class="grid">${tiles}</div>`;
  }

  // Isian di keranjang sesuai cara bayar.
  function isianBayar(total, bayar) {
    if (ui.metode === 'qris') {
      // Status Midtrans bisa diubah owner kapan saja: periksa lagi kalau sudah lebih dari 30 detik.
      if (cloud.user && cloud.client && (!ui.midtrans || (!ui.midtrans.memuat && Date.now() - (ui.midtrans.waktu || 0) > 30000))) muatMidtrans().then(renderAman);
      if (midtransSiap()) {
        return `<button class="btn block" style="margin-top:14px" data-act="qris">${t('Tampilkan QRIS')}</button>
           <div class="small muted" style="margin-top:8px">${t('QRIS Midtrans: penjualan tersimpan otomatis setelah pembeli membayar.')}</div>`;
      }
      return usaha().qris
        ? `<button class="btn block" style="margin-top:14px" data-act="qris">${t('Tampilkan QRIS')}</button>
           <div class="small muted" style="margin-top:8px">${t('Simpan setelah pembayaran masuk ke rekening atau e-wallet Anda.')}</div>`
        : `<div class="small muted" style="margin-top:14px">${t('Owner belum menyimpan gambar QRIS di Akun. Simpan setelah pembayaran masuk.')}</div>`;
    }
    if (ui.metode === 'nanti') {
      const kenal = modeStaff() ? [] : daftarPelanggan();
      return `<div class="stack" style="margin-top:14px">
          <label class="field"><span>${t('Nama pembeli')}</span><input id="pelangganNama" list="daftarPelanggan" autocomplete="off" value="${esc(ui.pelanggan.nama)}" placeholder="${t('Contoh: Bu Ani')}"></label>
          <label class="field"><span>${t('No. WhatsApp (boleh kosong)')}</span><input id="pelangganWa" type="tel" inputmode="tel" value="${esc(ui.pelanggan.wa)}" placeholder="0812…"></label>
          ${modeStaff() ? '' : barisJatuhTempo()}
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
  // Jatuh tempo tagihan yang sedang dicatat di kasir.
  function jatuhTempoKasir() {
    if (ui.jatuhTempo !== undefined) return ui.jatuhTempo;
    return T.jatuhTempoBaru(new Date(), T.pengaturan(profil()).jatuhTempo);
  }

  const tanggalPanjang = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString(lokal(), { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
  const tanggalPendek = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString(lokal(), { day: 'numeric', month: 'short' });

  function barisJatuhTempo() {
    const jt = jatuhTempoKasir();
    const hari = jt ? T.selisihHari(T.tanggalLokal(new Date()), jt) : 0;
    return `<div class="tempo" id="jatuhTempoKasir"><div><div class="small muted">${t('Jatuh tempo')}</div>
      <b>${jt ? esc(tanggalPanjang(jt)) : t('Tanpa jatuh tempo')}</b>${jt ? ` <span class="small muted">(${t('{n} hari', { n: hari })})</span>` : ''}</div>
      <button type="button" class="link" data-act="ubah-tempo">${t('Ubah')}</button></div>`;
  }

  // Pilih jatuh tempo: untuk tagihan di kasir, atau tagihan yang sudah tersimpan (trxId).
  function bukaUbahTempo(trxId) {
    const trx = trxId ? store.get(trxId) : null;
    const jt = trx ? trx.data.jatuhTempo || '' : jatuhTempoKasir() || '';
    const dasar = trx ? T.tanggalLokal(trx.data.waktu) : T.tanggalLokal(new Date());
    dialog.innerHTML = `<form id="formTempo" class="stack" method="dialog">
      <div class="row"><h3>${t('Jatuh tempo')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      ${trx ? `<div class="small muted">${t('{nama} · sisa {sisa}', { nama: esc(trx.data.pelanggan.nama), sisa: rp(P.sisaTagihan(trx.data)) })}</div>` : ''}
      <div class="seg kecil" role="group">${T.PILIHAN_TEMPO.map((n) => {
        const tgl = n ? T.tambahHari(dasar, n) : '';
        return `<button type="button" data-act="tempo-hari" data-tgl="${tgl}" aria-pressed="${tgl === jt}">${n ? t('{n} hari', { n }) : t('Tanpa')}</button>`;
      }).join('')}</div>
      <label class="field"><span>${t('Atau pilih tanggal')}</span><input type="date" name="tanggal" value="${esc(jt)}"></label>
      <input type="hidden" name="trxId" value="${esc(trxId || '')}">
      <button class="btn primary">${t('Pakai tanggal ini')}</button>
    </form>`;
    if (!dialog.open) dialog.showModal();
  }

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
    const baris = (p) => {
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
          const varian = V.ada(d) ? `<span class="tag varian" title="${esc(V.ringkas(d.varian))}">${t('{n} varian', { n: d.varian.length })}</span>` : '';
          return `<li class="row"><div class="dengan-foto">${fotoKecil(d)}<div><div class="nama">${esc(d.nama)} ${jenis}${varian}</div>
            <div class="small muted">${t('Modal {modal} · jual {harga} · laba {laba} ({m}%)', { modal: rp(modal), harga: rp(d.harga), laba: rp(d.harga - modal), m: angka.format(m) })}${stok}</div>${naik}${rugi}</div></div>
            <div class="aksi">${produksi}<button class="btn kecil" data-act="produk-ubah" data-id="${p.id}">${t('Ubah')}</button></div></li>`;
    };
    // Kelompokkan per kategori kalau sudah ada kategori.
    const grup = K.kelompok(produk, profil().kategori);
    const isi = grup.some((g) => g.nama)
      ? grup.map((g) => `<li class="kat-judul">${esc(g.nama || t('Lainnya'))} · ${g.items.length}</li>${g.items.map(baris).join('')}`).join('')
      : produk.map(baris).join('');
    const list = produk.length
      ? `<ul class="list">${isi}</ul>`
      : `<div class="empty">${t('Belum ada produk. Tambahkan produk untuk menghitung harga jual dan mulai berjualan.')}</div>`;
    // Tombol atur kategori di baris sendiri, supaya tidak disangka "tambah kategori".
    const atur = produk.length
      ? `<div class="atur-kategori"><button class="btn kecil" data-act="atur-kategori"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>${t('Atur kategori')}</button></div>`
      : '';
    return `${peringatan}<div class="group-title"><span>${t('Daftar produk')}</span><button class="link tambah" data-act="produk-baru">${t('+ Tambah produk')}</button></div>${atur}
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

  // Data laporan untuk periode yang dipilih (dipakai halaman Laporan dan file Excel).
  function dataLaporan() {
    const [from, to] = rentangLaporan();
    const dalam = (r) => { const w = Date.parse(r.data.waktu); return w >= from && w < to; };
    const urut = (a, b) => b.data.waktu.localeCompare(a.data.waktu);
    const trx = store.list('transaksi').filter(dalam).sort(urut);
    const keluar = store.list('pengeluaran').filter(dalam).sort(urut);
    const terjual = {};
    trx.forEach((r) => r.data.items.forEach((i) => {
      terjual[i.nama] = terjual[i.nama] || { qty: 0, omzet: 0 };
      terjual[i.nama].qty += i.qty;
      terjual[i.nama].omzet += i.qty * i.harga;
    }));
    return {
      from, to, trx, keluar,
      omzet: trx.reduce((s, r) => s + r.data.total, 0),
      laba: trx.reduce((s, r) => s + r.data.laba, 0),
      biaya: keluar.reduce((s, r) => s + r.data.jumlah, 0),
      terlaris: Object.entries(terjual).sort((a, b) => b[1].omzet - a[1].omzet),
    };
  }

  function viewLaporan() {
    const { from, to, trx, keluar, omzet, laba, biaya, terlaris } = dataLaporan();
    const bersih = laba - biaya;
    const top = terlaris.slice(0, 5);
    const seg = [['hari', t('Hari ini')], ['7hari', t('7 hari')], ['bulan', t('Bulan ini')], ['semua', t('Semua')], ['pilih', t('Tanggal')]]
      .map(([k, l]) => `<button data-act="periode" data-p="${k}" aria-pressed="${ui.periode === k}">${l}</button>`).join('');
    const pilihTanggal = ui.periode === 'pilih'
      ? `<div class="card two" id="pilihTanggal" style="margin-bottom:18px">
          <label class="field"><span>${t('Dari tanggal')}</span><input type="date" data-tanggal="dari" value="${esc(ui.dari)}" max="${esc(ui.sampai)}"></label>
          <label class="field"><span>${t('Sampai tanggal')}</span><input type="date" data-tanggal="sampai" value="${esc(ui.sampai)}" min="${esc(ui.dari)}"></label></div>`
      : '';
    const fmtWaktu = (iso) => new Date(iso).toLocaleString(lokal(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const fmtTanggal = (iso) => new Date(iso).toLocaleDateString(lokal(), { day: 'numeric', month: 'short' });
    return `<div class="group-title">${t('Periode')}</div><div class="seg periode">${seg}</div>${pilihTanggal}
      <div class="row kirim-laporan"><span class="small muted">${esc(teksPeriode(from, to, trx))}</span>
        <button class="btn kecil primary" data-act="kirim-laporan" id="kirimLaporan">${t('Kirim laporan (Excel)')}</button></div>
      <div class="stats">
        <div class="stat utama"><div class="lbl">${t('Omzet')}</div><div class="value">${rp(omzet)}</div></div>
        <div class="stat"><div class="lbl">${t('Laba kotor')}</div><div class="value">${rp(laba)}</div></div>
        <div class="stat" id="statPengeluaran"><div class="lbl">${t('Pengeluaran')}</div><div class="value">${rp(biaya)}</div></div>
        <div class="stat" id="labaBersih"><div class="lbl">${t('Laba bersih')}</div><div class="value ${bersih < 0 ? 'err' : ''}">${rp(bersih)}</div></div>
        <div class="stat"><div class="lbl">${t('Transaksi')}</div><div class="value">${trx.length}</div></div>
        <div class="stat"><div class="lbl">${t('Margin rata-rata')}</div><div class="value">${omzet ? angka.format((laba / omzet) * 100) + '%' : '–'}</div></div>
      </div>
      <div class="foot">${t('Laba kotor = omzet dikurangi modal barang yang terjual. Laba bersih = laba kotor dikurangi pengeluaran.')}</div>
      ${viewGrafik(trx, from, to)}
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
        ? `<ul class="list">${trx.map((r) => `<li class="row${P.sisaTagihan(r.data) > 0 ? ' belum' : ''}"><div><div><span class="nama">${rp(r.data.total)}</span> <span class="small muted">· ${t('laba')} ${rp(r.data.laba)}</span></div>
            <div class="small muted">${fmtWaktu(r.data.waktu)}${r.data.staff ? ' · ' + t('oleh {nama}', { nama: esc(r.data.staff) }) : ''} · ${esc(r.data.items.map((i) => `${V.namaItem(i)} ×${i.qty}`).join(', '))}</div>${tagBayar(r.data)}</div>
            <div class="aksi"><button class="btn kecil" data-act="struk" data-id="${r.id}">${t('Struk')}</button>
            <button class="btn kecil danger" data-act="batal-trx" data-id="${r.id}">${t('Batalkan')}</button></div></li>`).join('')}</ul>`
        : `<div class="empty">${t('Belum ada penjualan.')}</div>`}</div>`;
  }

  function labelGrafik(satuan, w, panjang) {
    const d = new Date(w);
    if (satuan === 'jam') return panjang ? `${String(d.getHours()).padStart(2, '0')}.00–${String(d.getHours() + 1).padStart(2, '0')}.00` : String(d.getHours());
    if (satuan === 'hari') return d.toLocaleDateString(lokal(), panjang ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });
    return d.toLocaleDateString(lokal(), { month: panjang ? 'long' : 'short', year: panjang || d.getMonth() === 0 ? 'numeric' : undefined });
  }

  // Tanggal awal dan akhir periode laporan (untuk "Semua": dari penjualan pertama).
  function batasPeriode(from, to, trx) {
    const awal = from > 0 ? from : trx.length ? Math.min(...trx.map((r) => Date.parse(r.data.waktu))) : Date.now();
    const akhir = Math.min(to, Date.now() + 1) - 1;
    return [new Date(awal), new Date(Math.max(awal, akhir))];
  }

  function teksPeriode(from, to, trx) {
    const [a, z] = batasPeriode(from, to, trx);
    const tgl = (d, tahun) => d.toLocaleDateString(lokal(), { day: 'numeric', month: 'short', year: tahun ? 'numeric' : undefined });
    return tanggalIni(a) === tanggalIni(z) ? tgl(a, true) : `${tgl(a, a.getFullYear() !== z.getFullYear())} – ${tgl(z, true)}`;
  }

  // Grafik batang omzet dan laba kotor per jam/hari/bulan, digambar sebagai SVG.
  function viewGrafik(trx, from, to) {
    const { satuan, kelompok } = G.kelompokkan(trx.map((r) => r.data), from, to, Date.now());
    const label = (w, panjang) => labelGrafik(satuan, w, panjang);
    ui.grafik = kelompok.map((k) => Object.assign({ label: label(k.mulai, true) }, k));
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
        <text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${G.ringkas(v, setel.bahasa)}</text>`);
    }
    const tiap = Math.ceil(kelompok.length / 6);
    const isi = kelompok.map((k, i) => {
      const x0 = L + i * slot + (slot - (bw * 2 + 2)) / 2;
      const teks = i % tiap === 0 ? `<text x="${L + i * slot + slot / 2}" y="${Ht - 6}" text-anchor="middle">${esc(label(k.mulai))}</text>` : '';
      return `${batang(x0, k.omzet, 'omzet')}${batang(x0 + bw + 2, k.laba, 'laba')}${teks}
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
        ? `<div class="tanda-belum"><span class="label-belum">${t('Belum lunas')}</span>
            <b>${esc(d.pelanggan.nama)}</b><div class="small">${t('Sisa {sisa} dari {total}', { sisa: rp(P.sisaTagihan(d)), total: rp(d.total) })}</div></div>`
        : `<div class="small ok">${t('Lunas · {pelanggan}', { pelanggan: esc(d.pelanggan.nama) })}</div>`;
    }
    return d.metode === 'qris' ? `<span class="tag">QRIS</span>` : '';
  }

  // Semua penjualan "bayar nanti" yang belum lunas, tanpa melihat periode.
  function tagihanTerbuka() {
    return store.list('transaksi').filter((r) => P.sisaTagihan(r.data) > 0).sort((a, b) => a.data.waktu.localeCompare(b.data.waktu));
  }

  // Label jatuh tempo: "Lewat 5 hari", "Hari ini", "Besok", "6 hari lagi".
  function labelTempo(jt) {
    const n = T.selisihHari(T.tanggalLokal(new Date()), jt);
    if (n < 0) return `<span class="tag telat">${t('Lewat {n} hari', { n: -n })}</span>`;
    if (n === 0) return `<span class="tag segera">${t('Hari ini')}</span>`;
    if (n === 1) return `<span class="tag segera">${t('Besok')}</span>`;
    return `<span class="tag aman">${t('{n} hari lagi', { n })}</span>`;
  }

  function viewTagihan() {
    const list = T.urutkan(tagihanTerbuka());
    if (!list.length) return '';
    const total = list.reduce((s, r) => s + P.sisaTagihan(r.data), 0);
    const hari = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 864e5);
    return `<div class="group-title"><span>${t('Belum lunas')}</span><span>${rp(total)}</span></div>
      <div class="card" id="tagihan"><ul class="list">${list.map((r) => {
        const d = r.data;
        const umur = hari(d.waktu);
        const jt = T.tanggalSah(d.jatuhTempo) ? d.jatuhTempo : null;
        const kapan = jt
          ? `<button class="link small" data-act="ubah-tempo-trx" data-id="${r.id}">${t('jatuh tempo {tanggal}', { tanggal: esc(tanggalPendek(jt)) })}</button>`
          : `${umur ? t('{n} hari lalu', { n: umur }) : t('hari ini')} · <button class="link small" data-act="ubah-tempo-trx" data-id="${r.id}">${t('atur jatuh tempo')}</button>`;
        return `<li class="stack"><div class="row"><div><div class="nama">${esc(d.pelanggan.nama)}</div>
            <div class="small muted">${t('Sisa {sisa} dari {total}', { sisa: rp(P.sisaTagihan(d)), total: rp(d.total) })} · ${kapan}</div></div>${jt ? labelTempo(jt) : ''}</div>
          <div class="row" style="justify-content:flex-end;gap:8px">
            <button class="btn kecil" data-act="tagih" data-id="${r.id}">${t('Tagih via WA')}</button>
            <button class="btn kecil primary" data-act="catat-bayar" data-id="${r.id}">${t('Catat bayar')}</button></div></li>`;
      }).join('')}</ul></div>`;
  }

  // Pesan WhatsApp yang pendek. Nomor rekening dan nominal ditulis di baris sendiri,
  // hanya angka, supaya pembeli bisa langsung menyalinnya ke m-banking.
  function teksTagihan(d, link) {
    const p = profil();
    const sisa = Math.round(P.sisaTagihan(d));
    const baris = [t('Halo {nama}, tagihan dari {usaha} {jumlah}.', { nama: d.pelanggan.nama, usaha: p.namaUsaha || 'Kelola', jumlah: rp(sisa) })];
    T.daftarRekening(p).forEach((r) => {
      baris.push('', r.nama ? t('Nomor rekening {bank} a.n. {nama}:', { bank: r.bank, nama: r.nama }) : t('Nomor rekening {bank}:', { bank: r.bank }), T.nomorPolos(r.nomor));
    });
    baris.push('', t('Nominal:'), String(sisa));
    if (link) baris.push('', t('Bayar online (QRIS, e-wallet, transfer bank):'), link);
    if (p.qris) baris.push('', t('Bisa juga bayar lewat QRIS di gambar.'));
    baris.push('', t('Terima kasih 🙏'));
    return baris.join('\n');
  }

  // Logo tanpa pinggiran putih/transparan (W.bersihkanTepi) plus warna latarnya.
  // Hasil disimpan per gambar supaya tidak dihitung ulang.
  var cacheLogo = new Map();
  function siapkanLogo(logo) {
    if (!logo) return { gambar: null, warna: '#ffffff' };
    const kunci = logo.src || logo;
    if (cacheLogo.has(kunci)) return cacheLogo.get(kunci);
    let hasil = { gambar: logo, warna: '#ffffff' };
    try {
      const c = document.createElement('canvas');
      c.width = logo.naturalWidth || logo.width;
      c.height = logo.naturalHeight || logo.height;
      const x = c.getContext('2d');
      x.drawImage(logo, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height);
      const warna = W.bersihkanTepi(d.data, c.width, c.height);
      x.putImageData(d, 0, 0);
      hasil = { gambar: c, warna: warna || '#ffffff' };
    } catch (e) { /* gambar tidak bisa dibaca: pakai apa adanya */ }
    cacheLogo.set(kunci, hasil);
    return hasil;
  }

  // Logo di dalam kotak bersudut bulat yang memakai warna tepi logo itu sendiri,
  // supaya tidak ada pinggiran putih. Dipakai di gambar tagihan dan struk.
  function kotakLogo(ctx, logo, x, y, ukuran, sudut, bayangan) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, ukuran, ukuran, sudut);
    const l = siapkanLogo(logo);
    ctx.fillStyle = l.warna;
    ctx.shadowColor = `rgba(0, 0, 0, ${bayangan})`;
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.clip();
    const g = l.gambar;
    if (g) {
      const s = Math.min(ukuran / g.width, ukuran / g.height);
      ctx.drawImage(g, x + ukuran / 2 - (g.width * s) / 2, y + ukuran / 2 - (g.height * s) / 2, g.width * s, g.height * s);
    }
    ctx.restore();
  }

  function muatGambar(src) {
    if (!src) return Promise.resolve(null);
    return new Promise((ok) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => ok(null);
      img.src = src;
    });
  }

  // ---------- QRIS dengan nominal ----------
  // Kode QR dibaca dari gambar QRIS toko di perangkat ini (pustaka jsQR), nominalnya disisipkan
  // oleh js/qris.js, lalu QR baru digambar dengan pustaka qrcode-generator. Kalau gambarnya
  // tidak terbaca, semua tempat kembali memakai gambar QRIS biasa.
  const qrisBaca = { src: null, kode: undefined, janji: null };

  function bacaQr(img, sisi) {
    const skala = Math.min(1, sisi / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * skala));
    c.height = Math.max(1, Math.round(img.naturalHeight * skala));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const hasil = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    return hasil && hasil.data ? hasil.data.trim() : '';
  }

  // Kode QRIS toko dari gambar yang disimpan, atau '' kalau tidak terbaca. Hasilnya diingat per gambar.
  function kodeQris() {
    const src = usaha().qris;
    if (!src) return Promise.resolve('');
    if (qrisBaca.src === src && qrisBaca.janji) return qrisBaca.janji;
    qrisBaca.src = src;
    qrisBaca.kode = undefined;
    // Pustaka pembaca QR tidak termuat: anggap tidak terbaca, pakai gambar QRIS biasa.
    if (typeof window.jsQR !== 'function') { qrisBaca.kode = ''; qrisBaca.janji = Promise.resolve(''); return qrisBaca.janji; }
    qrisBaca.janji = muatGambar(src).then((img) => {
      let kode = '';
      try {
        // Coba ukuran asli dulu, lalu diperkecil (kadang lebih mudah terbaca).
        if (img) [900, 600, 400].some((sisi) => { const k = bacaQr(img, sisi); if (Q.sah(k)) kode = k; return !!kode; });
      } catch (e) { /* gambar tidak bisa dibaca */ }
      if (qrisBaca.src === src) qrisBaca.kode = kode;
      return kode;
    });
    return qrisBaca.janji;
  }

  // Nominal otomatis menyala kecuali owner mematikannya di Akun.
  const nominalQrisAktif = () => usaha().qrisNominal !== false;

  async function kodeQrisNominal(jumlah) {
    if (!nominalQrisAktif() || typeof window.qrcode !== 'function') return '';
    return Q.denganNominal(await kodeQris(), jumlah);
  }

  // Gambar QR hitam-putih dengan tepi putih, kira-kira `sisi` px.
  function kanvasQr(kode, sisi) {
    const qr = window.qrcode(0, 'M');
    qr.addData(kode);
    qr.make();
    const n = qr.getModuleCount();
    const tepi = 4;
    const px = Math.max(2, Math.floor(sisi / (n + tepi * 2)));
    const c = document.createElement('canvas');
    c.width = c.height = (n + tepi * 2) * px;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) ctx.fillRect((k + tepi) * px, (r + tepi) * px, px, px);
    return c;
  }

  // Gambar tagihan untuk dikirim ke pembeli: logo dan warna usaha, rincian belanja,
  // sisa bayar, rekening, dan QRIS (kalau sudah disimpan). Lebar 720 px.
  async function gambarTagihan(d) {
    const p = profil();
    if (document.fonts && document.fonts.load) await document.fonts.load('italic 800 40px "Exo 2"').catch(() => {});
    const [logo, qrisToko] = await Promise.all([muatGambar(p.logo || 'icons/logo.png'), muatGambar(p.qris)]);
    // QRIS dengan nominal sisa tagihan kalau kode QRIS toko terbaca; kalau tidak, gambar QRIS biasa.
    let qris = qrisToko;
    let qrisTerisi = false;
    try {
      const kode = await kodeQrisNominal(P.sisaTagihan(d));
      if (kode) { qris = kanvasQr(kode, 420); qrisTerisi = true; }
    } catch (e) { qris = qrisToko; }
    const tm = temaUsaha();
    const utama = tm ? tm.terang['--navy'] : '#0a2a6e';
    const aksen = tm ? tm.terang['--yellow'] : '#fecb10';
    const W = 720;
    const pad = 44;
    const huruf = (ukuran, tebal) => `${tebal ? '700 ' : ''}${ukuran}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    const angkaFont = (ukuran) => `700 ${ukuran}px ui-monospace, Menlo, Consolas, monospace`;
    const sisa = P.sisaTagihan(d);
    const masuk = d.total - sisa;
    const rekening = T.daftarRekening(p);
    const jt = T.tanggalSah(d.jatuhTempo) ? d.jatuhTempo : null;
    const tglBeli = new Date(d.waktu).toLocaleDateString(lokal(), { day: 'numeric', month: 'long', year: 'numeric' });
    const kotak = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

    // Digambar dua kali: pertama untuk mengukur tinggi, lalu di kanvas ukuran pas.
    const gambar = (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, 5000);
      // Kepala: warna usaha, logo, nama usaha.
      ctx.fillStyle = utama;
      ctx.fillRect(0, 0, W, 170);
      kotakLogo(ctx, logo, pad, 37, 96, 22, 0.35);
      const xt = pad + 120;
      ctx.textAlign = 'left';
      ctx.fillStyle = aksen;
      ctx.font = `800 20px "Exo 2", "Segoe UI", sans-serif`;
      ctx.fillText(t('TAGIHAN'), xt, 64);
      ctx.fillStyle = '#ffffff';
      ctx.font = `italic 800 38px "Exo 2", "Segoe UI", sans-serif`;
      ctx.fillText(p.namaUsaha || 'Kelola', xt, 106, W - xt - pad);
      ctx.font = huruf(21);
      ctx.globalAlpha = 0.85;
      ctx.fillText(tglBeli, xt, 138, W - xt - pad);
      ctx.globalAlpha = 1;
      let y = 220;
      const kiriKanan = (kiri, kanan, warnaKiri, warnaKanan, font, fontKanan) => {
        ctx.font = font; ctx.textAlign = 'left'; ctx.fillStyle = warnaKiri; ctx.fillText(kiri, pad, y, W / 2);
        ctx.font = fontKanan || font; ctx.textAlign = 'right'; ctx.fillStyle = warnaKanan; ctx.fillText(kanan, W - pad, y, W / 2 - pad);
      };
      kiriKanan(t('Untuk'), d.pelanggan.nama, '#5d6a88', '#13203f', huruf(23), huruf(23, true));
      if (jt) {
        y += 38;
        const lewat = T.selisihHari(T.tanggalLokal(new Date()), jt) < 0;
        kiriKanan(t('Jatuh tempo'), tanggalPanjang(jt), '#5d6a88', lewat ? '#c8372d' : '#13203f', huruf(23), huruf(23, true));
      }
      const garis = () => {
        ctx.strokeStyle = '#cfd6e4'; ctx.lineWidth = 2; ctx.setLineDash([9, 8]);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke(); ctx.setLineDash([]);
      };
      y += 30; garis(); y += 46;
      d.items.forEach((i) => {
        kiriKanan(`${V.namaItem(i)} ×${angka.format(i.qty)}`, rp(i.qty * i.harga), '#13203f', '#13203f', huruf(25));
        y += 40;
      });
      y -= 12; garis(); y += 46;
      kiriKanan(t('Total'), rp(d.total), '#13203f', '#13203f', huruf(25));
      if (masuk > 0) { y += 40; kiriKanan(t('Sudah dibayar'), '− ' + rp(masuk), '#12805c', '#12805c', huruf(25)); }
      // Sisa bayar, besar.
      y += 28;
      ctx.fillStyle = '#fff6d1';
      kotak(ctx, pad, y, W - pad * 2, 96, 22); ctx.fill();
      ctx.textAlign = 'left'; ctx.fillStyle = '#13203f'; ctx.font = huruf(25, true);
      ctx.fillText(t('Sisa bayar'), pad + 26, y + 58);
      ctx.textAlign = 'right'; ctx.fillStyle = utama; ctx.font = `800 44px "Exo 2", "Segoe UI", sans-serif`;
      ctx.fillText(rp(sisa), W - pad - 26, y + 63, W / 2);
      y += 96;
      const judulKecil = (teks) => {
        y += 52;
        ctx.textAlign = 'left'; ctx.fillStyle = '#5d6a88'; ctx.font = `700 19px "Exo 2", "Segoe UI", sans-serif`;
        ctx.fillText(teks, pad, y);
        y += 16;
      };
      if (rekening.length) {
        judulKecil(t('TRANSFER KE'));
        rekening.forEach((r) => {
          ctx.strokeStyle = '#e1e6f0'; ctx.lineWidth = 2;
          kotak(ctx, pad, y, W - pad * 2, 116, 20); ctx.stroke();
          ctx.textAlign = 'left';
          ctx.fillStyle = utama; ctx.font = huruf(21, true);
          ctx.fillText(r.bank, pad + 24, y + 36, W - pad * 2 - 48);
          ctx.fillStyle = '#13203f'; ctx.font = angkaFont(32);
          ctx.fillText(T.nomorPolos(r.nomor), pad + 24, y + 76, W - pad * 2 - 48);
          if (r.nama) { ctx.fillStyle = '#5d6a88'; ctx.font = huruf(20); ctx.fillText(t('a.n. {nama}', { nama: r.nama }), pad + 24, y + 104, W - pad * 2 - 48); }
          y += 128;
        });
        y -= 12;
      }
      if (qris) {
        judulKecil(rekening.length ? t('ATAU SCAN QRIS') : t('SCAN QRIS'));
        const lebar = Math.min(420, qris.width);
        const tinggi = qris.height * (lebar / qris.width);
        ctx.strokeStyle = '#e1e6f0'; ctx.lineWidth = 2;
        kotak(ctx, pad, y, W - pad * 2, tinggi + 84, 20); ctx.stroke();
        ctx.drawImage(qris, (W - lebar) / 2, y + 20, lebar, tinggi);
        ctx.textAlign = 'center'; ctx.fillStyle = '#5d6a88'; ctx.font = huruf(21);
        ctx.fillText(t(qrisTerisi ? 'Nominal {jumlah} sudah terisi' : 'Masukkan nominal {jumlah}', { jumlah: rp(sisa) }), W / 2, y + tinggi + 60, W - pad * 2 - 32);
        y += tinggi + 84;
      }
      y += 40;
      ctx.fillStyle = '#f2f5fa';
      ctx.fillRect(0, y, W, 80);
      ctx.textAlign = 'center'; ctx.fillStyle = '#5d6a88'; ctx.font = huruf(22);
      ctx.fillText(t('Terima kasih 🙏'), W / 2, y + 48);
      return y + 80;
    };
    const ukur = document.createElement('canvas');
    ukur.width = W; ukur.height = 5000;
    const tinggi = Math.ceil(gambar(ukur.getContext('2d')));
    const c = document.createElement('canvas');
    c.width = W; c.height = tinggi;
    gambar(c.getContext('2d'));
    return c;
  }

  // baru = tagihan yang baru saja disimpan di kasir.
  async function bukaTagih(id, baru) {
    const r = store.get(id);
    if (!r || !r.data.pelanggan) return;
    const d = r.data;
    const teks = teksTagihan(d, await linkBayarMidtrans(id, d));
    const no = P.nomorWa(d.pelanggan.wa);
    const waUrl = `https://wa.me/${no}?text=${encodeURIComponent(teks)}`;
    const canvas = await gambarTagihan(d);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
    if (ui.struk && ui.struk.url) URL.revokeObjectURL(ui.struk.url);
    const nama = `tagihan-${d.pelanggan.nama.replace(/[^\w]+/g, '-').toLowerCase()}.png`;
    ui.struk = { blob, url: blob ? URL.createObjectURL(blob) : '', teks, nama };
    const file = blob && window.File ? new File([blob], nama, { type: 'image/png' }) : null;
    const bisaBagi = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    dialog.innerHTML = `<div class="stack" id="dialogTagih">
      <div class="row"><h3>${baru ? t('Kirim tagihan ke {nama}?', { nama: esc(d.pelanggan.nama) }) : t('Tagih {nama}', { nama: esc(d.pelanggan.nama) })}</h3>
        ${baru ? '' : `<button type="button" class="link" data-act="tutup">${t('Tutup')}</button>`}</div>
      <div class="tagihan-pratinjau"><img id="gambarTagihan" src="${ui.struk.url}" alt="${t('Gambar tagihan')}"></div>
      <div class="field"><span class="lbl">${t('Pesan WA')}</span><pre class="pesan-wa">${esc(teks)}</pre></div>
      ${bisaBagi
        ? `<button class="btn primary block" data-act="tagih-bagikan">${t('Kirim ke WhatsApp')}</button>
           <a class="btn block" id="tagihWa" href="${waUrl}" target="_blank" rel="noopener">${t('Kirim pesan saja')}</a>`
        : `<a class="btn primary block" id="tagihWa" href="${waUrl}" target="_blank" rel="noopener">${t('Kirim ke WhatsApp')}</a>
           <a class="btn block" href="${ui.struk.url}" download="${esc(nama)}">${t('Simpan gambar tagihan')}</a>`}
      ${no ? '' : `<div class="small muted">${t('Nomor WhatsApp belum dicatat, jadi pilih kontaknya sendiri di WhatsApp.')}</div>`}
      ${T.daftarRekening(profil()).length || profil().qris ? '' : `<div class="small muted">${t('Tambahkan nomor rekening atau QRIS di Akun → Cara bayar & tagihan supaya ikut terkirim.')}</div>`}
      ${baru ? `<button class="btn block" data-act="tutup">${t('Nanti saja')}</button>` : ''}
    </div>`;
    if (!dialog.open) dialog.showModal();
  }

  // Kirim gambar tagihan + pesannya lewat menu bagikan HP (pilih WhatsApp, lalu kontaknya).
  async function bagikanTagihan() {
    if (!ui.struk || !ui.struk.blob) return;
    const file = new File([ui.struk.blob], ui.struk.nama, { type: 'image/png' });
    try {
      await navigator.share({ files: [file], text: ui.struk.teks });
    } catch (e) { /* pengguna membatalkan */ }
  }

  // ---------- Pengingat jatuh tempo (di dalam aplikasi) ----------

  const KEY_TUNDA = 'kelola:pengingat';
  const bacaTunda = () => { try { return localStorage.getItem(KEY_TUNDA); } catch (e) { return null; } };

  function infoPengingat() {
    if (hanyaKasir() || modeStaff()) return null;
    const set = T.pengaturan(profil());
    if (!set.ingatkan) return null;
    const h = T.pengingat(tagihanTerbuka(), T.tanggalLokal(new Date()), set.mulai, P.sisaTagihan);
    return h.lewat.length || h.segera.length ? h : null;
  }

  function viewPengingat() {
    const h = infoPengingat();
    if (!h || bacaTunda() === T.tanggalLokal(new Date())) return '';
    const nama = (list) => esc(list.slice(0, 3).map((r) => r.data.pelanggan.nama).join(', ') + (list.length > 3 ? ', …' : ''));
    const lewat = h.lewat.length > 0;
    const daftar = lewat ? h.lewat : h.segera;
    const judul = lewat ? t('{n} tagihan lewat jatuh tempo', { n: h.lewat.length }) : t('{n} tagihan segera jatuh tempo', { n: h.segera.length });
    return `<div class="card pengingat${lewat ? ' telat' : ''}" id="pengingat">
      <div class="atas"><div class="ik" aria-hidden="true">!</div>
        <div class="isi"><b>${judul}</b><div class="small muted">${nama(daftar)} · ${rp(lewat ? h.totalLewat : h.totalSegera)}</div>
          ${lewat && h.segera.length ? `<div class="small ekstra">${t('+{n} segera jatuh tempo', { n: h.segera.length })}</div>` : ''}</div></div>
      <div class="tombol"><button class="btn kecil" data-act="tunda-pengingat">${t('Nanti')}</button>
        <button class="btn kecil primary" data-act="lihat-tagihan">${t('Lihat tagihan')}</button></div></div>`;
  }

  function lihatTagihan() {
    ui.view = 'laporan';
    render();
    const el = $('#tagihan');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // "Nanti": sembunyikan kartu pengingat sampai besok (per perangkat).
  function tundaPengingat() {
    try { localStorage.setItem(KEY_TUNDA, T.tanggalLokal(new Date())); } catch (e) { /* abaikan */ }
    render();
  }

  // Tanda merah di menu Laporan: jumlah tagihan yang lewat jatuh tempo.
  function renderTandaLaporan() {
    const tombol = $('nav.tabs button[data-go="laporan"]');
    const h = infoPengingat();
    const n = h ? h.lewat.length : 0;
    let tanda = $('.tanda-merah', tombol);
    if (!n) { if (tanda) tanda.remove(); return; }
    if (!tanda) { tanda = document.createElement('span'); tanda.className = 'tanda-merah'; $('.ikon', tombol).appendChild(tanda); }
    tanda.textContent = n > 9 ? '9+' : String(n);
    tanda.setAttribute('aria-label', t('{n} tagihan lewat jatuh tempo', { n }));
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
      <hr class="pemisah">
      <div class="row" id="tentang"><span class="lbl">${t('Tentang Kelola')}</span><span class="small muted">${t('Versi {versi}', { versi: esc(VERSI) })}</span></div>
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
        <button class="btn danger" data-act="keluar">${t('Keluar')}</button></div></div>${viewAkunHp()}${viewPengaturan()}`;
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

  // Kasir yang dipilih di layar awal: hanya pengaturan dan tombol ganti mode.
  function viewAkunKasir() {
    return `<div class="group-title">${t('Mode kasir')}</div><div class="card stack" id="modeSaatIni">
      <div>${t('Aplikasi sedang dipakai sebagai kasir. Modal, laba, produk, dan laporan disembunyikan.')}</div>
      <button class="btn primary block" data-act="ganti-mode">${t('Ganti mode')}</button></div>${viewPengaturan()}`;
  }

  function viewAkun() {
    if (modeKunci()) return viewKunci();
    if (modeStaff()) return viewAkunStaff();
    if (modeKasirSesi()) return viewAkunKasir();
    const p = profil();
    const profilUsaha = `<div class="group-title">${t('Profil usaha')}</div><div class="card stack">
      <label class="field"><span>${t('Nama usaha')}</span><input id="namaUsahaInput" value="${esc(p.namaUsaha)}" placeholder="${t('Contoh: Warung Bu Sari')}"></label>
      <label class="field"><span>${t('Alamat atau nomor WhatsApp (tampil di struk)')}</span><input id="kontakUsahaInput" value="${esc(p.kontak || '')}" placeholder="${t('Contoh: Jl. Melati 5 · 0812 3456 7890')}"></label>
      <button class="btn" data-act="simpan-profil">${t('Simpan')}</button></div>`;
    if (cloud.user && cloud.peran === 'owner' && !ui.staff.list && !ui.staff.memuat && !ui.staff.belumSiap) muatStaff();
    const modeOwner = `<div class="card row mode-owner" id="modeSaatIni"><div><span class="peran">${t('OWNER')}</span>
      <div class="small muted">${t('Semua fitur terbuka')}</div></div>
      <button class="btn kecil" data-act="ganti-mode">${t('Ganti mode')}</button></div>`;
    return [
      modeOwner,
      viewAkunHp() && jadiLipat('akunHp', viewAkunHp()),
      jadiLipat('profil', profilUsaha),
      jadiLipat('qris', viewCaraBayar()),
      jadiLipat('merek', viewMerek()),
      jadiLipat('pengaturan', viewPengaturan()),
      jadiLipat('cloud', viewCloud(), !cloud.user),
      viewFaceId() && jadiLipat('faceid', viewFaceId(), !!ui.faceIdMsg),
      viewStaff() && jadiLipat('staff', viewStaff(), !!ui.staff.kode),
      jadiLipat('kunci', viewModeKasir(), !!ui.kunciMsg),
      viewGabung() && jadiLipat('gabung', viewGabung(), !!ui.gabungMsg),
    ].filter(Boolean).join('');
  }

  // Owner: masuk dengan Face ID / sidik jari di HP ini, sebagai pengganti mengetik kata sandi.
  function viewFaceId() {
    if (!cloudReady || !cloud.user || cloud.peran !== 'owner') return '';
    const kunci = kunciFaceId();
    let isi;
    if (ui.faceIdBisa === false) {
      isi = `<div class="small muted">${t('HP atau browser ini belum mendukung Face ID / sidik jari untuk aplikasi web. Pastikan kunci layar HP (Face ID, sidik jari, atau PIN) sudah aktif.')}</div>`;
    } else if (kunci) {
      isi = `<div class="row"><b>${t('Aktif di HP ini')}</b><span class="aktif small">● ${t('Aktif')}</span></div>
        <div class="small muted">${t('Saat membuka Kelola sebagai Owner, atau pindah kembali ke akun ini dari akun lain di HP ini, cukup pindai wajah atau sidik jari. Kata sandi tetap bisa dipakai kapan saja.')}</div>
        <button class="btn block" data-act="faceid-matikan">${t('Matikan Face ID / sidik jari')}</button>`;
    } else {
      isi = `<div class="small muted">${t('Masuk sebagai Owner tanpa mengetik kata sandi. Data wajah atau sidik jari tetap di HP ini dan tidak dikirim ke mana pun.')}</div>
        <button class="btn primary block btn-faceid" data-act="faceid-aktifkan" ${ui.faceIdBisa ? '' : 'disabled'}>${IKON_FACEID}${t('Aktifkan Face ID / sidik jari')}</button>
        <div class="small muted">${t('Siapa pun yang wajah atau sidik jarinya terdaftar di HP ini bisa membuka mode Owner. Jangan aktifkan di HP yang dipakai bersama staff.')}</div>`;
    }
    return `<div class="group-title">${t('Face ID / sidik jari')}</div><div class="card stack" id="faceId">${pesan(ui.faceIdMsg)}${isi}</div>`;
  }

  async function aktifkanFaceId() {
    if (!cloud.user) return;
    const user = cloud.user;
    ui.faceIdMsg = null;
    try {
      const kunci = await F.daftar(user, profil().namaUsaha);
      F.catat(window.localStorage, user.id, kunci);
      ui.faceIdMsg = { type: 'ok', text: t('Face ID / sidik jari aktif. Lain kali pilih Owner, lalu pindai wajah atau sidik jari.') };
      if (ui.tawarFaceId) { ui.tawarFaceId = null; toast(t('Face ID / sidik jari aktif')); }
    } catch (e) {
      ui.faceIdMsg = { type: 'err', text: e && e.name === 'NotAllowedError'
        ? t('Dibatalkan. Coba lagi kalau mau mengaktifkan Face ID / sidik jari.')
        : t('Face ID / sidik jari tidak bisa diaktifkan di HP ini.') };
    }
    ui.lipat.faceid = true;
    render();
  }

  // Baru masuk dengan kata sandi dan Face ID belum aktif untuk akun ini: tawarkan sekali di atas halaman.
  // Tidak langsung meminta wajah, karena iPhone hanya mengizinkannya tepat setelah tombol disentuh.
  function tawarkanFaceId() {
    ui.tawarFaceId = cloud.user ? cloud.user.id : null;
  }
  function viewTawarFaceId() {
    if (!cloud.user || ui.tawarFaceId !== cloud.user.id || !ui.faceIdBisa || kunciFaceId() || cloud.peran !== 'owner' || hanyaKasir()) return '';
    return `<div class="card stack tawar-faceid" id="tawarFaceId">
      <div class="dengan-ikon">${IKON_FACEID}<div><b>${t('Pakai Face ID / sidik jari untuk akun ini?')}</b>
        <div class="small muted">${t('Lain kali masuk atau pindah ke akun ini cukup dengan wajah atau sidik jari, tanpa kata sandi.')}</div></div></div>
      ${ui.faceIdMsg && ui.faceIdMsg.type === 'err' ? pesan(ui.faceIdMsg) : ''}
      <div class="row"><button class="btn kecil" data-act="faceid-nanti">${t('Nanti saja')}</button>
        <button class="btn kecil primary" data-act="faceid-aktifkan">${t('Aktifkan')}</button></div></div>`;
  }

  // Akun yang pernah masuk di HP ini, untuk pindah akun.
  function viewAkunHp() {
    if (!cloudReady || !cloud.user) return '';
    const baris = daftarAkun().map((a) => {
      const aktif = a.id === cloud.user.id;
      return `<li class="row akun-hp"><div class="t"><b>${esc(a.nama || a.email)}</b><div class="small muted">${esc(a.email)}${a.staff ? ' · ' + t('Staff') : ''}${!aktif && faceIdAkun(a.email) ? ' · Face ID' : ''}</div></div>
        ${aktif ? `<span class="aktif small">● ${t('Aktif')}</span>`
          : `<div class="aksi"><button class="btn kecil" data-act="ke-ganti-akun" data-email="${esc(a.email)}">${t('Pindah')}</button>
            <button class="link small danger" data-act="lupakan-akun" data-id="${esc(a.id)}">${t('Hapus dari HP')}</button></div>`}</li>`;
    }).join('');
    return `<div class="group-title">${t('Akun di HP ini')}</div><div class="card stack" id="akunHp">
      <ul class="list">${baris}</ul>
      <button class="btn block" data-act="ke-ganti-akun" data-email="">${t('+ Tambah akun lain')}</button>
      <div class="small muted">${t('Data tiap akun (produk, penjualan, laporan) disimpan terpisah di HP ini. Pindah akun meminta kata sandi akun itu, atau Face ID / sidik jari kalau sudah diaktifkan di akun itu.')}</div></div>`;
  }

  // Owner: logo di pojok kiri atas dan warna aplikasi dari logo.
  function viewMerek() {
    const p = profil();
    const palet = p.palet || [];
    const w = p.warna && p.warna.utama;
    const pilihan = palet.filter((h) => W.luminans(h) < 0.45);
    const swatch = (pilihan.length ? pilihan : palet).map((h) => `<button type="button" class="swatch" data-act="warna" data-w="${h}" aria-pressed="${w === h}" style="background:${h}" aria-label="${h}"></button>`).join('');
    return `<div class="group-title">${t('Logo & warna usaha')}</div><div class="card stack" id="merek">
      <div class="dengan-foto"><img class="logo-pratinjau" data-logo-usaha src="${esc(logoTampil())}" alt="">
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

  function ubahProfil(patch) {
    change(() => store.put('profil', Object.assign({}, profil(), patch), 'profil'));
  }

  // Keterangan "nominal otomatis" di bawah gambar QRIS. Membaca kode QR butuh waktu sebentar,
  // jadi halaman digambar ulang sekali setelah selesai.
  function statusQrisNominal(p) {
    if (qrisBaca.src !== p.qris || qrisBaca.kode === undefined) {
      kodeQris().then(() => { if (ui.view === 'akun' && !dialog.open) render(); });
      return `<div class="small muted" id="qrisNominal">${t('Memeriksa gambar QRIS…')}</div>`;
    }
    if (!qrisBaca.kode) {
      return `<div class="small warn" id="qrisNominal" data-terbaca="0">${t('Kode QR di gambar ini tidak terbaca, jadi pembeli tetap mengetik nominal sendiri. Coba pakai gambar QRIS yang lebih jelas, misalnya file asli dari bank.')}</div>`;
    }
    const aktif = p.qrisNominal !== false;
    return `<div id="qrisNominal" data-terbaca="1" class="stack">
      <div class="row"><div><div class="label">${t('Nominal otomatis')}</div>
        <div class="small muted">${t('QRIS {nama} terbaca. Pembeli tinggal memindai, nominal sudah terisi.', { nama: esc(Q.namaMerchant(qrisBaca.kode) || '') })}</div></div>
        <div class="seg kecil saklar" role="group"><button data-act="setel-qris-nominal" data-v="1" aria-pressed="${aktif}">${t('Aktif')}</button>
          <button data-act="setel-qris-nominal" data-v="" aria-pressed="${!aktif}">${t('Mati')}</button></div></div>
      <div class="small muted">${t('Coba dulu dengan nominal kecil di aplikasi yang sering dipakai pembeli. Kalau ada yang menolak, matikan di sini.')}</div></div>`;
  }

  // Owner: cara pembeli membayar (QRIS, rekening) dan pengaturan tagihan "bayar nanti".
  function viewCaraBayar() {
    const p = profil();
    const q = p.qris;
    const rek = p.rekening || [];
    const set = T.pengaturan(p);
    const pilih = (nama, nilai, opsi) => `<div class="seg kecil" role="group">${opsi.map(([k, l]) =>
      `<button data-act="setel-tagihan" data-nama="${nama}" data-nilai="${k}" aria-pressed="${nilai === k}">${l}</button>`).join('')}</div>`;
    return `<div class="group-title">${t('Cara bayar & tagihan')}</div><div class="card stack" id="caraBayar">
      <div id="qrisSetel" class="stack">
        <div><div class="label">QRIS</div><div class="small muted">${t('Tampil di kasir dan di gambar tagihan. Hanya owner yang bisa mengganti gambar ini.')}</div></div>
        ${q ? `<img class="qris-gambar" src="${esc(q)}" alt="QRIS">` : ''}
        <div class="foto-aksi">
          <label class="btn kecil"><input type="file" accept="image/*" data-qris hidden>${q ? t('Ganti gambar QRIS') : t('Pilih gambar QRIS')}</label>
          ${q ? `<button type="button" class="link small danger" data-act="hapus-qris">${t('Hapus QRIS')}</button>` : ''}
        </div>
        ${q ? statusQrisNominal(p) : ''}
        ${viewMidtrans()}
      </div>
      <hr class="pemisah">
      <div><div class="label">${t('Rekening & e-wallet')}</div><div class="small muted">${t('Tampil di gambar tagihan dan pesan WhatsApp.')}</div></div>
      ${rek.length ? `<ul class="list" id="daftarRekening">${rek.map((r) => `<li class="row"><div><div class="nama">${esc(r.bank)}</div>
          <div class="nomor-rek">${esc(r.nomor)}</div>${r.nama ? `<div class="small muted">${t('a.n. {nama}', { nama: esc(r.nama) })}</div>` : ''}</div>
          <button class="btn kecil" data-act="rekening-ubah" data-id="${esc(r.id)}">${t('Ubah')}</button></li>`).join('')}</ul>` : ''}
      <button class="btn block" data-act="rekening-baru">${t('+ Tambah rekening / e-wallet')}</button>
      <hr class="pemisah">
      <div class="field"><span class="lbl">${t('Jatuh tempo tagihan baru')}</span>
        ${pilih('jatuhTempo', set.jatuhTempo, T.PILIHAN_TEMPO.map((n) => [n, n ? t('{n} hari', { n }) : t('Tanpa')]))}
        <div class="small muted" style="margin-top:6px">${t('Dihitung dari tanggal beli. Bisa diubah setiap kali mencatat tagihan.')}</div></div>
      <div class="field"><span class="lbl">${t('Ingatkan saya saat aplikasi dibuka')}</span>
        ${pilih('ingatkan', set.ingatkan, [[true, t('Ya')], [false, t('Tidak')]])}</div>
      ${set.ingatkan ? `<div class="field"><span class="lbl">${t('Mulai ingatkan')}</span>
        ${pilih('mulai', set.mulai, [[0, t('Hari H')], [1, t('H-1')], [3, t('H-3')]])}</div>` : ''}
      <hr class="pemisah">
      ${viewNotif()}
    </div>`;
  }

  const DAFTAR_BANK = ['BCA', 'BRI', 'Mandiri', 'BNI', 'BSI', 'CIMB Niaga', 'Permata', 'BTN', 'Danamon', 'SeaBank', 'Bank Jago', 'blu by BCA Digital', 'DANA', 'GoPay', 'OVO', 'ShopeePay', 'LinkAja'];

  function bukaFormRekening(id) {
    const r = (profil().rekening || []).find((x) => x.id === id) || { bank: '', nomor: '', nama: '' };
    dialog.innerHTML = `<form id="formRekening" class="stack" method="dialog">
      <div class="row"><h3>${id ? t('Ubah rekening') : t('Tambah rekening')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <label class="field"><span>${t('Bank atau e-wallet')}</span><input name="bank" list="daftarBank" required autocomplete="off" value="${esc(r.bank)}" placeholder="${t('Contoh: BCA atau DANA')}"></label>
      <datalist id="daftarBank">${DAFTAR_BANK.map((b) => `<option value="${b}">`).join('')}</datalist>
      <label class="field"><span>${t('Nomor rekening / nomor HP')}</span><input name="nomor" required inputmode="numeric" autocomplete="off" value="${esc(r.nomor)}" placeholder="1234567890"></label>
      <label class="field"><span>${t('Atas nama (boleh kosong)')}</span><input name="nama" autocomplete="off" value="${esc(r.nama)}" placeholder="${t('Contoh: Sari Wulandari')}"></label>
      <input type="hidden" name="rekId" value="${esc(id || '')}">
      <button class="btn primary">${t('Simpan')}</button>
      ${id ? `<button type="button" class="btn danger" data-act="rekening-hapus" data-id="${esc(id)}">${t('Hapus rekening')}</button>` : ''}
    </form>`;
    if (!dialog.open) dialog.showModal();
  }

  // ---------- Notifikasi HP (Web Push) ----------
  // Server (supabase/notifikasi.sql + Edge Function pengingat-tagihan) mengirim
  // pengingat jatuh tempo setiap pagi ke HP yang menyalakan notifikasi.

  const KEY_NOTIF = 'kelola:notif';
  const FUNGSI_NOTIF = 'pengingat-tagihan';
  const notifDidukung = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iPhoneBelumDipasang = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;

  function notifTersimpan() {
    try {
      const n = JSON.parse(localStorage.getItem(KEY_NOTIF) || 'null');
      return n && cloud.user && n.userId === cloud.user.id ? n : null;
    } catch (e) { return null; }
  }

  function viewNotif() {
    const judul = `<div><div class="label">${t('Notifikasi di HP')}</div><div class="small muted">${t('Pengingat tagihan jatuh tempo setiap pagi jam 08.00, walau aplikasi tertutup.')}</div></div>`;
    let isi;
    if (!cloudReady || !cloud.user) isi = `<div class="small muted">${t('Masuk ke akun dulu (Simpan ke cloud) supaya notifikasi bisa dikirim.')}</div>`;
    else if (iPhoneBelumDipasang()) isi = `<div class="small muted">${t('Di iPhone: buka Kelola di Safari, ketuk Bagikan → Tambahkan ke Layar Utama, lalu buka Kelola dari ikon itu dan nyalakan notifikasi di sini.')}</div>`;
    else if (!notifDidukung()) isi = `<div class="small muted">${t('Browser ini belum mendukung notifikasi.')}</div>`;
    else if (Notification.permission === 'denied') isi = `<div class="small muted">${t('Notifikasi untuk Kelola diblokir. Izinkan lewat pengaturan HP atau browser, lalu coba lagi.')}</div>`;
    else if (notifTersimpan() && Notification.permission === 'granted') {
      isi = `<div class="row"><span class="aktif">${t('Aktif di HP ini')}</span>
        <div class="aksi"><button class="btn kecil" data-act="notif-uji">${t('Kirim uji')}</button><button class="btn kecil" data-act="notif-matikan">${t('Matikan')}</button></div></div>`;
    } else isi = `<button class="btn block" data-act="notif-nyalakan">${t('Nyalakan notifikasi')}</button>`;
    return `<div id="notifSetel" class="stack">${judul}${isi}${pesan(ui.notifMsg)}</div>`;
  }

  const base64Url = (s) => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  };

  // ---------- QRIS Midtrans (Edge Function `midtrans`, supabase/midtrans.sql) ----------
  // Server Key Midtrans milik owner hanya ada di server. HP (owner maupun staff) hanya
  // meminta QR, menanyakan status, dan mengambil pembayaran tagihan lewat fungsi ini.

  const FUNGSI_MIDTRANS = 'midtrans';
  const midtransSiap = () => !!(ui.midtrans && ui.midtrans.terhubung && ui.midtrans.aktif);
  const tunggu = (ms) => new Promise((ok) => setTimeout(ok, ms));

  async function panggilMidtrans(body, batas) {
    if (!cloud.client || !cloud.user || !navigator.onLine) throw new Error('offline');
    const kerja = cloud.client.functions.invoke(FUNGSI_MIDTRANS, { body }).then(async ({ data, error }) => {
      if (!error) return data || {};
      let isi = null;
      try { isi = error.context && typeof error.context.json === 'function' ? await error.context.json() : null; } catch (e) { isi = null; }
      const err = new Error((isi && (isi.pesan || isi.error)) || error.message || 'gagal');
      err.kode = isi && isi.error;
      err.status = error.context && error.context.status;
      throw err;
    });
    if (!batas) return kerja;
    return Promise.race([kerja, tunggu(batas).then(() => { throw new Error('waktu habis'); })]);
  }

  // Fungsi atau tabel Midtrans belum dipasang di Supabase.
  const midtransBelumSiap = (e) => !!e && ((e.status === 404 && !e.kode) || /midtrans_(kunci|bayar)|PGRST205|does not exist|Function not found/i.test(e.message || ''));

  let midtransJalan = null;
  function muatMidtrans() {
    if (!cloud.client || !cloud.user) return Promise.resolve(null);
    if (midtransJalan) return midtransJalan;
    ui.midtrans = Object.assign({}, ui.midtrans, { memuat: true });
    midtransJalan = panggilMidtrans({ aksi: 'cek' }, 10000).then(
      (d) => { ui.midtrans = { terhubung: !!d.terhubung, aktif: !!d.aktif, uji: !!d.uji, waktu: Date.now() }; },
      (e) => { ui.midtrans = Object.assign(midtransBelumSiap(e) ? { belumSiap: true } : { gagal: true }, { waktu: Date.now() }); },
    ).then(() => { midtransJalan = null; return ui.midtrans; });
    return midtransJalan;
  }

  function viewMidtrans() {
    if (modeStaff()) return '';
    const m = ui.midtrans;
    const ket = `<div class="small muted">${t('Lunas tercatat otomatis, tidak perlu cek mutasi. Biaya sekitar 0,7% per transaksi, dipotong Midtrans dari dana yang masuk.')}</div>`;
    const judul = `<div><div class="label">${t('QRIS Midtrans')}</div>${ket}</div>`;
    let isi;
    if (!cloudReady || !cloud.user) isi = `${judul}<div class="small muted">${t('Masuk ke akun dulu (Simpan ke cloud) supaya bisa memakai Midtrans.')}</div>`;
    else if (!m || m.memuat) {
      if (!m) muatMidtrans().then(() => { if (ui.view === 'akun' && !dialog.open) render(); });
      isi = `${judul}<div class="small muted">${t('Memeriksa Midtrans…')}</div>`;
    } else if (m.belumSiap) isi = `${judul}<div class="small muted" data-midtrans="belum-siap">${t('Fitur Midtrans belum disiapkan di server. Ikuti panduan pemasangan Midtrans, lalu buka lagi halaman ini.')}</div>`;
    else if (m.gagal) isi = `${judul}<div class="small warn">${t('Tidak bisa memeriksa Midtrans. Periksa internet, lalu coba lagi.')}</div><button type="button" class="btn kecil" data-act="midtrans-muat">${t('Coba lagi')}</button>`;
    else if (!m.terhubung) isi = `${judul}<button type="button" class="btn kecil" data-act="midtrans-hubungkan">${t('Hubungkan Midtrans')}</button>`;
    else {
      isi = `<div class="row">${judul}
          <div class="seg kecil saklar" role="group"><button data-act="midtrans-aktif" data-v="1" aria-pressed="${m.aktif}">${t('Aktif')}</button>
            <button data-act="midtrans-aktif" data-v="" aria-pressed="${!m.aktif}">${t('Mati')}</button></div></div>
        <div class="msg ok" id="midtransTerhubung">${m.uji ? t('Terhubung ke Midtrans (mode uji coba / Sandbox)') : t('Terhubung ke Midtrans')}</div>
        ${m.aktif ? `<div class="small muted">${t('Kasir dan link bayar tagihan memakai Midtrans. Kalau Midtrans tidak bisa dihubungi, kasir kembali ke QRIS biasa.')}</div>` : ''}
        <div class="foto-aksi"><button type="button" class="btn kecil" data-act="midtrans-hubungkan">${t('Ganti Server Key')}</button>
          <button type="button" class="link small danger" data-act="midtrans-putus">${t('Putuskan Midtrans')}</button></div>`;
    }
    return `<hr class="pemisah"><div id="midtransSetel" class="stack">${isi}${pesan(ui.midtransMsg)}</div>`;
  }

  function bukaHubungkanMidtrans() {
    ui.midtransMsg = null;
    dialog.innerHTML = `<form id="formMidtrans" class="stack" method="dialog">
      <div class="row"><h3>${t('Hubungkan Midtrans')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <ol class="langkah-midtrans small">
        <li>${t('Daftar akun di midtrans.com, lalu lengkapi data usaha sampai disetujui Midtrans.')}</li>
        <li>${t('Buka Dashboard Midtrans → Settings → Access Keys.')}</li>
        <li>${t('Salin Server Key, lalu tempel di bawah. Untuk mencoba tanpa uang sungguhan, pakai Server Key Sandbox (diawali SB-).')}</li>
      </ol>
      <a class="link small" href="https://dashboard.midtrans.com/register" target="_blank" rel="noopener">${t('Buka midtrans.com')}</a>
      <label class="field"><span>${t('Server Key')}</span><input name="serverKey" id="midtransKunci" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="Mid-server-…"></label>
      <div id="midtransMsg"></div>
      <button class="btn primary block" type="submit">${t('Cek & simpan')}</button>
      <div class="small muted">${t('Kunci disimpan di server Kelola, tidak tampil lagi di HP, dan tidak dikirim ke HP staff.')}</div>
    </form>`;
    if (!dialog.open) dialog.showModal();
  }

  function pesanMidtrans(e) {
    if (e && e.kode === 'format') return t('Server Key tidak sesuai. Pastikan yang disalin Server Key (diawali Mid-server- atau SB-Mid-server-), bukan Client Key.');
    if (e && e.kode === 'kunci-salah') return t('Server Key ditolak Midtrans. Salin ulang dari Dashboard Midtrans → Settings → Access Keys.');
    if (midtransBelumSiap(e)) return t('Fitur Midtrans belum disiapkan di server. Ikuti panduan pemasangan Midtrans, lalu buka lagi halaman ini.');
    return t('Gagal menghubungi Midtrans. Periksa internet, lalu coba lagi.');
  }

  async function simpanKunciMidtrans(f) {
    const tombol = $('button[type=submit]', f);
    tombol.disabled = true;
    $('#midtransMsg').innerHTML = `<div class="small muted">${t('Memeriksa Server Key…')}</div>`;
    try {
      const d = await panggilMidtrans({ aksi: 'simpan', serverKey: f.serverKey.value }, 20000);
      ui.midtrans = { terhubung: !!d.terhubung, aktif: !!d.aktif, uji: !!d.uji, waktu: Date.now() };
      dialog.close();
      render();
      toast(t('Midtrans terhubung'));
    } catch (e) {
      $('#midtransMsg').innerHTML = pesan({ type: 'err', text: pesanMidtrans(e) });
      tombol.disabled = false;
    }
  }

  async function setelMidtrans(body) {
    ui.midtransMsg = null;
    try {
      const d = await panggilMidtrans(body, 15000);
      ui.midtrans = { terhubung: !!d.terhubung, aktif: !!d.aktif, uji: !!d.uji, waktu: Date.now() };
    } catch (e) {
      ui.midtransMsg = { type: 'err', text: pesanMidtrans(e) };
    }
    render();
  }

  // Kasir: buat QRIS Midtrans untuk total keranjang, lalu tunggu sampai dibayar.
  // false = Midtrans tidak bisa dipakai (kasir kembali ke QRIS biasa).
  async function bukaQrisMidtrans(total) {
    dialog.innerHTML = `<div class="stack" id="qrisKasir"><div class="row"><h3>${t('Bayar dengan QRIS')}</h3></div>
      <div class="tunggu-bayar"><span class="putar" aria-hidden="true"></span>${t('Membuat QRIS…')}</div></div>`;
    if (!dialog.open) dialog.showModal();
    let d;
    try { d = await panggilMidtrans({ aksi: 'qris', jumlah: total }, 15000); } catch (e) { return false; }
    if (!d || !d.qr || !d.order_id) return false;
    const gambar = kanvasQr(d.qr, 720).toDataURL('image/png');
    const sampai = d.kedaluwarsa ? new Date(d.kedaluwarsa).toLocaleTimeString(setel.bahasa === 'en' ? 'en-GB' : 'id-ID', { hour: '2-digit', minute: '2-digit' }) : '';
    const bayar = { order: d.order_id, total };
    ui.bayarOnline = bayar;
    dialog.innerHTML = `<div class="stack" id="qrisKasir" data-midtrans="${esc(d.order_id)}">
      <div class="row"><h3>${t('Bayar dengan QRIS')}</h3><button type="button" class="link" data-act="tutup">${t('Batalkan')}</button></div>
      <div class="row"><span class="label">${t('Total')}</span><span class="total">${rp(total)}</span></div>
      <img class="qris-gambar besar" id="qrisGambar" data-terisi="${total}" src="${gambar}" alt="QRIS">
      ${sampai ? `<div class="small muted tengah">${t('QRIS Midtrans · berlaku sampai {jam}', { jam: sampai })}</div>` : ''}
      ${d.uji ? `<div class="stack" id="qrisSimulator"><div class="small warn">${t('Mode uji coba (Sandbox): bayar memakai simulator Midtrans, bukan aplikasi bayar sungguhan.')}</div>
        ${d.gambar ? `<div class="small muted">${t('Salin link di bawah, buka simulator QRIS, tempel di "QR Code Image Url", lalu tekan Scan QR.')}</div>
        <input class="link-uji" id="qrisLinkUji" readonly value="${esc(d.gambar)}">
        <div class="foto-aksi"><button type="button" class="btn kecil" data-act="salin-link-qr">${t('Salin link QR')}</button>
          <a class="link small" href="https://simulator.sandbox.midtrans.com/v2/qris/index" target="_blank" rel="noopener">${t('Buka simulator QRIS')}</a></div>` : ''}</div>` : ''}
      <div class="tunggu-bayar" id="qrisStatus"><span class="putar" aria-hidden="true"></span>${t('Menunggu pembayaran…')}</div>
      <div class="small muted">${t('Bisa dibayar dari GoPay, OVO, DANA, ShopeePay, atau m-banking. Penjualan tersimpan otomatis setelah dibayar.')}</div>
      <button type="button" class="link small" data-act="qris-manual">${t('Sudah bayar tapi belum masuk? Tandai lunas manual')}</button>
    </div>`;
    // Dialog ditutup sebelum lunas: batalkan QRIS di Midtrans supaya tidak bisa dibayar lagi.
    dialog.addEventListener('close', async () => {
      if (ui.bayarOnline !== bayar) return;
      ui.bayarOnline = null;
      try {
        const r = await panggilMidtrans({ aksi: 'batal', order_id: bayar.order }, 15000);
        if (r.status === 'lunas') selesaiMidtrans(bayar, r.metode);
      } catch (e) { /* QRIS akan kedaluwarsa sendiri */ }
    }, { once: true });
    tungguMidtrans(bayar);
    return true;
  }

  async function tungguMidtrans(bayar) {
    while (ui.bayarOnline === bayar) {
      await tunggu(3000);
      if (ui.bayarOnline !== bayar) return;
      let r;
      try { r = await panggilMidtrans({ aksi: 'status', order_id: bayar.order }, 10000); } catch (e) { continue; }
      if (ui.bayarOnline !== bayar) return;
      if (r.status === 'lunas') { ui.bayarOnline = null; selesaiMidtrans(bayar, r.metode); return; }
      if (r.status !== 'pending') {
        ui.bayarOnline = null;
        const el = $('#qrisStatus');
        if (el) el.outerHTML = `<div class="msg err" id="qrisStatus">${r.status === 'kedaluwarsa' ? t('QRIS sudah kedaluwarsa. Tutup lalu tampilkan QRIS lagi.') : t('Pembayaran dibatalkan atau gagal. Tutup lalu coba lagi.')}</div>`;
        return;
      }
    }
  }

  const namaMetode = (m) => {
    const [jenis, penerbit] = String(m || '').split('/');
    const nama = { qris: 'QRIS', gopay: 'GoPay', shopeepay: 'ShopeePay', bank_transfer: t('Transfer bank'), dana: 'DANA', ovo: 'OVO' };
    return [jenis, penerbit].filter(Boolean).map((x) => nama[x] || x.toUpperCase()).join(' · ');
  };

  // Pembeli sudah membayar: simpan penjualan, lalu tampilkan tanda lunas.
  function selesaiMidtrans(bayar, metode) {
    ui.metode = 'qris';
    ui.midtransOrder = bayar.order;
    simpanPenjualan();
    const jam = new Date().toLocaleTimeString(setel.bahasa === 'en' ? 'en-GB' : 'id-ID', { hour: '2-digit', minute: '2-digit' });
    dialog.innerHTML = `<div class="stack tengah" id="bayarDiterima">
      <div class="centang" aria-hidden="true">✓</div>
      <h3>${t('Pembayaran diterima')}</h3>
      <div class="total">${rp(bayar.total)}</div>
      <div class="small muted">${esc([namaMetode(metode) || 'QRIS', jam].join(' · '))}</div>
      <div class="small muted">${t('Dana masuk ke saldo Midtrans, dipotong biaya sekitar 0,7%, lalu dicairkan ke rekening usaha.')}</div>
      ${ui.trxTerakhir ? `<button class="btn block" data-act="struk" data-id="${ui.trxTerakhir}">${t('Struk')}</button>` : ''}
      <button class="btn primary block" data-act="tutup">${t('Penjualan baru')}</button>
    </div>`;
    if (!dialog.open) dialog.showModal();
  }

  // Mode uji: salin link gambar QR untuk simulator Midtrans.
  async function salinLinkQr() {
    const el = $('#qrisLinkUji');
    if (!el) return;
    try { await navigator.clipboard.writeText(el.value); toast(t('Link QR disalin')); } catch (e) { el.focus(); el.select(); }
  }

  // Kasir sudah melihat uang masuk walau Midtrans belum melapor.
  function lunasManualMidtrans() {
    ui.bayarOnline = null;
    dialog.close();
    ui.metode = 'qris';
    simpanPenjualan();
  }

  // Link bayar Midtrans untuk pesan tagihan. Kosong kalau Midtrans tidak aktif atau gagal.
  async function linkBayarMidtrans(id, d) {
    if (modeStaff() || !midtransSiap()) return '';
    const sisa = Math.round(P.sisaTagihan(d));
    if (!(sisa > 0)) return '';
    let hari = 7;
    if (d.jatuhTempo) hari = Math.ceil((new Date(d.jatuhTempo + 'T23:59:59+07:00') - Date.now()) / 86400000);
    try {
      const r = await panggilMidtrans({ aksi: 'link', ref: id, jumlah: sisa, nama: d.pelanggan.nama, hari: Math.min(30, Math.max(3, hari)) }, 8000);
      return r.link || '';
    } catch (e) { return ''; }
  }

  // HP owner: catat pembayaran tagihan yang masuk lewat link Midtrans.
  let bayarMidtransJalan = false;
  async function prosesBayarMidtrans() {
    if (cloud.peran !== 'owner' || !cloud.user || bayarMidtransJalan) return;
    if (!ui.midtrans || ui.midtrans.gagal) await muatMidtrans();
    if (!ui.midtrans || !ui.midtrans.terhubung) return;
    bayarMidtransJalan = true;
    try {
      const d = await panggilMidtrans({ aksi: 'ambil' }, 20000);
      const rows = d.bayar || [];
      if (!rows.length) return;
      let hasil = [];
      change(() => { hasil = P.olahBayarMidtrans(store, rows); });
      if (!hasil.length) return;
      renderAman();
      const r = hasil[0];
      const jumlah = (rows.find((b) => b.ref === r.id) || {}).jumlah || 0;
      toast(hasil.length === 1
        ? t('{nama} membayar tagihan {jumlah} lewat Midtrans', { nama: r.data.pelanggan.nama, jumlah: rp(jumlah) })
        : t('{n} tagihan dibayar lewat Midtrans', { n: hasil.length }));
    } catch (e) {
      console.warn('Gagal mengambil pembayaran Midtrans', e);
    } finally {
      bayarMidtransJalan = false;
    }
  }

  async function panggilFungsiNotif(body) {
    const { data, error } = await cloud.client.functions.invoke(FUNGSI_NOTIF, { body });
    if (error) throw error;
    return data || {};
  }

  async function nyalakanNotif() {
    if (!cloud.user || !notifDidukung()) return;
    ui.notifMsg = null;
    try {
      const izin = await Notification.requestPermission();
      if (izin !== 'granted') { ui.notifMsg = { type: 'err', text: t('Izin notifikasi tidak diberikan.') }; render(); return; }
      let kunci;
      try { kunci = (await panggilFungsiNotif({ aksi: 'kunci' })).publik; } catch (e) { kunci = null; }
      if (!kunci) { ui.notifMsg = { type: 'err', text: t('Server notifikasi belum disiapkan. Ikuti panduan pemasangan notifikasi, lalu coba lagi.') }; render(); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Url(kunci) });
      const j = sub.toJSON();
      const { error } = await cloud.client.from('push_langganan').upsert({
        endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_id: cloud.user.id, bahasa: setel.bahasa,
      }, { onConflict: 'endpoint' });
      if (error) throw error;
      localStorage.setItem(KEY_NOTIF, JSON.stringify({ userId: cloud.user.id, endpoint: j.endpoint }));
      ui.notifMsg = { type: 'ok', text: t('Notifikasi aktif. Ketuk "Kirim uji" untuk mencoba.') };
    } catch (e) {
      ui.notifMsg = { type: 'err', text: t('Gagal menyalakan notifikasi: {pesan}', { pesan: (e && e.message) || String(e) }) };
    }
    render();
  }

  async function ujiNotif() {
    try {
      const r = await panggilFungsiNotif({ aksi: 'uji' });
      ui.notifMsg = r.terkirim ? { type: 'ok', text: t('Notifikasi uji terkirim. Tunggu sebentar.') } : { type: 'err', text: t('Notifikasi uji belum terkirim. Coba matikan lalu nyalakan lagi.') };
    } catch (e) {
      ui.notifMsg = { type: 'err', text: t('Gagal mengirim: {pesan}', { pesan: (e && e.message) || String(e) }) };
    }
    render();
  }

  // Hapus langganan notifikasi HP ini (dipanggil juga saat keluar dari akun).
  async function hapusLanggananNotif() {
    const n = notifTersimpan();
    if (!n) return;
    try { localStorage.removeItem(KEY_NOTIF); } catch (e) { /* abaikan */ }
    try {
      await cloud.client.from('push_langganan').delete().eq('endpoint', n.endpoint);
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) { /* abaikan */ }
  }

  async function matikanNotif() {
    await hapusLanggananNotif();
    ui.notifMsg = { type: 'ok', text: t('Notifikasi dimatikan di HP ini.') };
    render();
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

  // Pilihan kategori di form produk: tombol kategori yang ada, atau ketik kategori baru.
  function isianKategori(d) {
    const list = K.daftar(profil().kategori, produkList().map((p) => p.data));
    const pilih = K.milik(d, list);
    const chips = list.map((k) => `<button type="button" data-act="pilih-kategori" data-k="${esc(k)}" aria-pressed="${k === pilih}">${esc(k)}</button>`).join('');
    return `<div class="field"><span class="lbl">${t('Kategori (boleh kosong)')}</span>
      <input type="hidden" name="kategori" value="${esc(pilih)}">
      <div class="kat-pilih">${chips}<button type="button" class="baru" data-act="kategori-baru">${t('+ Kategori baru')}</button></div>
      <input name="kategoriBaru" maxlength="${K.MAKS}" hidden placeholder="${t('Nama kategori, mis. Minuman')}" aria-label="${t('Nama kategori baru')}" style="margin-top:10px"></div>`;
  }

  function pilihKategori(el) {
    const f = $('#formProduk');
    const aktif = el.getAttribute('aria-pressed') === 'true';
    $$('[data-act=pilih-kategori]', f).forEach((b) => b.setAttribute('aria-pressed', b === el && !aktif));
    f.kategori.value = aktif ? '' : el.dataset.k;
    f.kategoriBaru.value = '';
    f.kategoriBaru.hidden = true;
  }

  function kategoriBaruForm() {
    const f = $('#formProduk');
    $$('[data-act=pilih-kategori]', f).forEach((b) => b.setAttribute('aria-pressed', false));
    f.kategori.value = '';
    f.kategoriBaru.hidden = false;
    f.kategoriBaru.focus();
  }

  // Atur kategori: ganti nama, urutan, tambah, atau hapus.
  function barisKategori(k, n) {
    return `<div class="kat-baris" data-lama="${esc(k)}">
      <input name="kn" maxlength="${K.MAKS}" value="${esc(k)}" placeholder="${t('Nama kategori, mis. Minuman')}" aria-label="${t('Nama kategori')}">
      <span class="small muted">${k ? t('{n} produk', { n }) : ''}</span>
      <button type="button" data-act="kategori-naik" aria-label="${t('Naikkan')}">↑</button>
      <button type="button" data-act="kategori-turun" aria-label="${t('Turunkan')}">↓</button>
      <button type="button" class="hapus" data-act="kategori-hapus" aria-label="${t('Hapus kategori')}">×</button></div>`;
  }

  function bukaAturKategori() {
    const produk = produkList();
    const list = K.daftar(profil().kategori, produk.map((p) => p.data));
    const jumlah = (k) => produk.filter((p) => K.milik(p.data, list) === k).length;
    dialog.innerHTML = `<form id="formKategori" class="stack" method="dialog">
      <div class="row"><h3>${t('Atur kategori')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <div class="small muted">${t('Ganti nama, ubah urutan, atau hapus kategori. Urutan ini dipakai di Kasir. Produk dari kategori yang dihapus pindah ke Lainnya.')}</div>
      <div id="barisKategori">${list.length ? list.map((k) => barisKategori(k, jumlah(k))).join('') : barisKategori('', 0)}</div>
      <button type="button" class="link" data-act="kategori-tambah">${t('+ Tambah kategori')}</button>
      <button class="btn primary block">${t('Simpan')}</button>
    </form>`;
    if (!dialog.open) dialog.showModal();
  }

  function simpanAturKategori(f) {
    const produk = produkList();
    const lama = K.daftar(profil().kategori, produk.map((p) => p.data));
    const baris = $$('.kat-baris', f).map((el) => ({ lama: el.dataset.lama, baru: $('[name=kn]', el).value }));
    const hasil = K.atur(lama, baris);
    const pindah = produk.filter((p) => K.kategoriBaru(p.data, hasil.peta) !== null);
    const keLainnya = pindah.filter((p) => K.kategoriBaru(p.data, hasil.peta) === '').length;
    if (keLainnya && !confirm(t('{n} produk akan pindah ke Lainnya. Lanjutkan?', { n: keLainnya }))) return;
    change(() => {
      pindah.forEach((p) => {
        const d = Object.assign({}, p.data);
        const k = K.kategoriBaru(d, hasil.peta);
        if (k) d.kategori = k; else delete d.kategori;
        store.put('produk', d, p.id);
      });
      store.put('profil', Object.assign({}, profil(), { kategori: hasil.urutan }), 'profil');
    });
    dialog.close();
    render();
    toast(t('Kategori tersimpan'));
  }

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
      ${isianKategori(d)}
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
      ${isianVarian(d, id)}
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

  // ---------- Varian dan tambahan ----------

  // Satu pilihan di dalam kelompok varian (form produk).
  function barisPilihan(p) {
    return `<div class="baris pilihan" data-baris="pilihan" data-pid="${esc((p && p.id) || '')}">
      <input name="vpn" maxlength="${V.MAKS}" value="${esc((p && p.nama) || '')}" placeholder="${t('Nama pilihan')}" aria-label="${t('Nama pilihan')}">
      <input name="vph" type="number" inputmode="decimal" min="0" step="any" value="${p && p.harga ? esc(p.harga) : ''}" placeholder="+0" aria-label="${t('Tambah harga (Rp)')}">
      <button type="button" class="hapus" data-act="hapus-baris" aria-label="${t('Hapus baris')}">×</button></div>`;
  }

  // Satu kelompok varian, mis. "Ukuran" dengan pilihan Reguler dan Besar.
  function kelompokVarian(g) {
    const banyak = !!(g && g.banyak);
    const pilihan = g && g.pilihan && g.pilihan.length ? g.pilihan : [null, null];
    return `<div class="hint stack varian-grup" data-gid="${esc((g && g.id) || '')}">
      <div class="row"><input name="vn" maxlength="${V.MAKS}" value="${esc((g && g.nama) || '')}" placeholder="${t('Nama kelompok, mis. Ukuran')}" aria-label="${t('Nama kelompok')}">
        <button type="button" class="link small danger" data-act="varian-grup-hapus">${t('Hapus')}</button></div>
      <div class="seg kecil" role="group"><button type="button" data-act="varian-jenis" data-b="" aria-pressed="${!banyak}">${t('Pilih satu')}</button>
        <button type="button" data-act="varian-jenis" data-b="1" aria-pressed="${banyak}">${t('Boleh banyak')}</button></div>
      <div class="row small muted kepala-pilihan"><span>${t('Nama pilihan')}</span><span>${t('Tambah harga (Rp)')}</span></div>
      <div class="daftar-pilihan">${pilihan.map(barisPilihan).join('')}</div>
      <button type="button" class="link small" data-act="varian-pilihan-baru">${t('+ Tambah pilihan')}</button>
      <div class="small muted" data-ket-satu ${banyak ? 'hidden' : ''}>${t('Pilihan paling atas otomatis terpilih di kasir.')}</div>
    </div>`;
  }

  // Bagian "Punya varian / tambahan?" di form produk.
  function isianVarian(d, id) {
    const adaV = V.ada(d);
    const lain = produkList().filter((p) => p.id !== id && V.ada(p.data));
    const contoh = V.CONTOH.map((c) => `<button type="button" data-act="varian-contoh" data-k="${c.kode}">${esc(t(c.nama))}</button>`).join('');
    const salin = lain.length
      ? `<select name="salinVarian" aria-label="${t('Salin varian dari produk lain…')}"><option value="">${t('Salin varian dari produk lain…')}</option>${lain.map((p) => `<option value="${p.id}">${esc(p.data.nama)} (${esc(V.ringkas(p.data.varian))})</option>`).join('')}</select>`
      : '';
    return `<div class="field" id="bagianVarian">
      <div class="row"><span class="lbl" style="margin-bottom:0">${t('Punya varian / tambahan?')}</span>
        <div class="seg kecil saklar" role="group"><button type="button" data-act="varian-saklar" data-v="1" aria-pressed="${adaV}">${t('Ya')}</button>
          <button type="button" data-act="varian-saklar" data-v="" aria-pressed="${!adaV}">${t('Tidak')}</button></div></div>
      <div class="small muted" style="margin:6px 4px 0">${t('Misalnya ukuran, topping, atau level pedas. Kasir memilihnya saat produk diketuk.')}</div>
      <div id="isiVarian" class="stack" style="margin-top:12px" ${adaV ? '' : 'hidden'}>
        <div id="kelompokVarian" class="stack">${adaV ? d.varian.map(kelompokVarian).join('') : ''}</div>
        <div class="small muted">${t('Tambah dari contoh, atau buat sendiri:')}</div>
        <div class="kat-pilih">${contoh}<button type="button" class="baru" data-act="varian-grup-baru">${t('+ Buat sendiri')}</button></div>
        ${salin}
        <div class="small muted" id="hargaVarian"></div>
      </div></div>`;
  }

  // Varian dari isian form produk. Kalau saklarnya "Tidak", hasilnya kosong.
  function bacaVarianForm(f) {
    const isi = $('#isiVarian', f);
    if (!isi || isi.hidden) return [];
    return V.rapikan($$('.varian-grup', f).map((g) => ({
      id: g.dataset.gid,
      nama: $('[name=vn]', g).value,
      banyak: $('[data-act=varian-jenis][data-b="1"]', g).getAttribute('aria-pressed') === 'true',
      pilihan: $$('[data-baris=pilihan]', g).map((b) => ({ id: b.dataset.pid, nama: $('[name=vpn]', b).value, harga: num($('[name=vph]', b).value) })),
    })));
  }

  function tambahKelompokVarian(g) {
    $('#kelompokVarian').insertAdjacentHTML('beforeend', kelompokVarian(g));
    const baru = $('#kelompokVarian').lastElementChild;
    baru.scrollIntoView({ block: 'nearest' });
    if (!g) $('[name=vn]', baru).focus();
    hitungForm();
  }

  // Layar pilihan di kasir untuk produk yang punya varian.
  function bukaPilihVarian(id) {
    const rec = ambilKasir(id);
    if (!rec || !V.ada(rec.data)) return;
    const d = rec.data;
    const bawaan = new Set(V.pilih(d.varian, []).ids);
    const kelompok = d.varian.map((g, gi) => `<fieldset class="varian-pilih"><legend><span>${esc(g.nama)}</span><span class="small muted">${t(g.banyak ? 'boleh lebih dari satu' : 'pilih satu')}</span></legend>
      ${g.pilihan.map((o) => `<label class="opsi"><input type="${g.banyak ? 'checkbox' : 'radio'}" name="g${gi}" value="${esc(o.id)}" ${bawaan.has(o.id) ? 'checked' : ''}>
        <span class="nm">${esc(o.nama)}</span><span class="hg">${o.harga ? '+ ' + rp(o.harga) : g.banyak ? t('Gratis') : rp(d.harga)}</span></label>`).join('')}</fieldset>`).join('');
    dialog.innerHTML = `<form id="formVarian" class="stack" method="dialog">
      <div class="row"><h3>${esc(d.nama)}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      ${kelompok}
      <label class="field"><span>${t('Catatan (boleh kosong)')}</span><input name="catatan" maxlength="${V.MAKS_CATATAN}" autocomplete="off" placeholder="${t('Contoh: es sedikit')}"></label>
      <input type="hidden" name="produkId" value="${esc(id)}"><input type="hidden" name="qty" value="1">
      <div class="row"><div class="qty"><button type="button" data-act="varian-qty" data-n="-1" aria-label="${t('Kurangi')}">−</button><span id="varianQty">1</span>
        <button type="button" data-act="varian-qty" data-n="1" aria-label="${t('Tambah')}">+</button></div>
        <button class="btn primary" id="varianTambah" style="flex:1"></button></div>
    </form>`;
    hitungVarian();
    if (!dialog.open) dialog.showModal();
  }

  const idsVarianForm = (f) => $$('fieldset input:checked', f).map((el) => el.value);

  function hitungVarian() {
    const f = $('#formVarian');
    if (!f) return;
    const rec = ambilKasir(f.produkId.value);
    if (!rec) return;
    const qty = Math.max(1, num(f.qty.value));
    const pil = V.pilih(rec.data.varian, idsVarianForm(f));
    $('#varianQty').textContent = qty;
    $('#varianTambah').textContent = t('Tambah · {total}', { total: rp((rec.data.harga + pil.tambah) * qty) });
  }

  function simpanPilihVarian(f) {
    const rec = ambilKasir(f.produkId.value);
    if (!rec) { dialog.close(); return; }
    const qty = Math.max(1, num(f.qty.value));
    const pil = V.pilih(rec.data.varian, idsVarianForm(f));
    const kunci = V.kunci(rec.id, pil.ids, f.catatan.value);
    if (!bisaTambah(kunci, qty)) { toast(t('Stok tidak cukup')); return; }
    ui.cart[kunci] = (ui.cart[kunci] || 0) + qty;
    ui.trxTerakhir = null;
    dialog.close();
    render();
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

  // QRIS di kasir. Kalau kode QRIS toko terbaca, QR-nya sudah berisi total keranjang;
  // `polos` = tampilkan gambar QRIS biasa (untuk aplikasi pembeli yang menolak QR bernominal).
  async function bukaQris(polos) {
    const q = usaha().qris;
    const total = isiKeranjang().reduce((s, x) => s + x.harga * x.qty, 0);
    let catatan = '';
    if (!polos && total > 0 && midtransSiap()) {
      if (await bukaQrisMidtrans(total)) return;
      catatan = t('Midtrans tidak bisa dihubungi, jadi memakai QRIS biasa. Cek pembayaran masuk sendiri.');
      if (!q) {
        dialog.innerHTML = `<div class="stack" id="qrisKasir"><div class="row"><h3>${t('Bayar dengan QRIS')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
          <div class="msg err">${t('Midtrans tidak bisa dihubungi. Periksa internet lalu coba lagi, atau pilih cara bayar lain.')}</div></div>`;
        if (!dialog.open) dialog.showModal();
        return;
      }
    }
    if (!q) return;
    let gambar = q;
    let terisi = false;
    if (!polos && total > 0) {
      try {
        const kode = await kodeQrisNominal(total);
        if (kode) { gambar = kanvasQr(kode, 720).toDataURL('image/png'); terisi = true; }
      } catch (e) { gambar = q; }
    }
    dialog.innerHTML = `<div class="stack" id="qrisKasir">
      <div class="row"><h3>${t('Bayar dengan QRIS')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      ${total ? `<div class="row"><span class="label">${t('Total')}</span><span class="total">${rp(total)}</span></div>` : ''}
      ${catatan ? `<div class="small warn" id="qrisCatatan">${esc(catatan)}</div>` : ''}
      <img class="qris-gambar besar" id="qrisGambar" data-terisi="${terisi ? total : ''}" src="${esc(gambar)}" alt="QRIS">
      ${terisi ? `<div class="msg ok" id="qrisTerisi">${t('Nominal {jumlah} sudah terisi. Pembeli tinggal memindai dan membayar.', { jumlah: rp(total) })}</div>` : ''}
      <div class="small muted">${t('Minta pembeli memindai kode ini, lalu cek notifikasi pembayaran masuk sebelum menyimpan penjualan.')}</div>
      ${terisi ? `<button type="button" class="link small" data-act="qris-polos">${t('Aplikasi pembeli menolak? Pakai QRIS tanpa nominal')}</button>` : ''}</div>`;
    if (!dialog.open) dialog.showModal();
  }

  // Data produk dari isian form (belum disimpan).
  function bacaFormProduk(f) {
    const mode = f.mode.value;
    const d = { nama: f.nama.value.trim(), satuan: f.satuan.value.trim(), mode, harga: num(f.harga.value) };
    const kategori = K.cocokkan(K.daftar(profil().kategori, produkList().map((p) => p.data)), f.kategoriBaru.value) || K.rapikan(f.kategori.value);
    if (kategori) d.kategori = kategori;
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
    const varian = bacaVarianForm(f);
    if (varian.length) d.varian = varian;
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
    const hv = $('#hargaVarian');
    if (hv) {
      // Contoh harga di kasir untuk kelompok "pilih satu" pertama.
      const g = (d.varian || []).find((x) => !x.banyak);
      hv.textContent = g && d.harga > 0 ? t('Harga di kasir: {daftar}', { daftar: g.pilihan.map((o) => `${o.nama} ${rp(d.harga + o.harga)}`).join(' · ') }) : '';
    }
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
      items: trx.data.items.map((i) => ({ nama: V.namaItem(i), catatan: i.catatan || '', rinci: `${angka.format(i.qty)} × ${rp(i.harga)}`, jumlah: rp(i.qty * i.harga) })),
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
      ...s.items.map((i) => `${i.nama}${i.catatan ? `\n  (${i.catatan})` : ''}\n  ${i.rinci} = ${i.jumlah}`), '',
      `*${t('Total')}: ${s.total}*`, ...s.rincian.map(([l, v]) => `${l}: ${v}`), '', t('Terima kasih!'),
    ].filter((x, i) => x !== '' || i > 2).join('\n');
  }

  // Gambar struk di canvas, lebar 600 px supaya tajam di WhatsApp.
  function strukGambar(s, logo) {
    const W = 600;
    const pad = 40;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = (ukuran, tebal) => `${tebal ? '700 ' : ''}${ukuran}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    const judulFont = `italic 800 40px "Exo 2", "Segoe UI", sans-serif`;
    const L = logo ? 110 : 0; // tinggi tempat logo di atas nama usaha
    const tinggi = 260 + L + (s.kontak ? 34 : 0) + s.items.length * 70 + s.items.filter((i) => i.catatan).length * 28 + 190;
    c.width = W;
    c.height = tinggi;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, tinggi);
    const tm = temaUsaha();
    const navy = tm ? tm.terang['--navy'] : '#0a2a6e';
    ctx.fillStyle = tm ? navy : '#fecb10';
    ctx.fillRect(0, 0, W, 12);
    if (logo) kotakLogo(ctx, logo, W / 2 - 48, 40, 96, 22, 0.18);
    let y = 80 + L;
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
      if (i.catatan) { ctx.fillText(`“${i.catatan}”`, pad, y, W - pad * 2); y += 28; }
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
    const canvas = strukGambar(s, await muatGambar(usaha().logo));
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

  // ---------- Laporan Excel ----------

  // Grafik omzet & laba sebagai gambar PNG untuk file Excel (selalu latar putih).
  async function grafikPng(trx, from, to) {
    const { satuan, kelompok } = G.kelompokkan(trx.map((r) => r.data), from, to, Date.now());
    if (!kelompok.some((k) => k.n)) return null;
    const tm = temaUsaha();
    const warna1 = tm ? tm.terang['--grafik-1'] : '#3159c8';
    const warna2 = tm ? tm.terang['--grafik-2'] : '#d99a00';
    const Wd = 1200;
    const Ht = 600;
    const L = 110;
    const R = 24;
    const T = 96;
    const B = 56;
    const c = document.createElement('canvas');
    c.width = Wd;
    c.height = Ht;
    const ctx = c.getContext('2d');
    const font = (ukuran, tebal) => `${tebal ? '700 ' : ''}${ukuran}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, Wd, Ht);
    ctx.fillStyle = '#10204a';
    ctx.font = font(30, true);
    ctx.fillText(t({ jam: 'Omzet & laba per jam', hari: 'Omzet & laba per hari', bulan: 'Omzet & laba per bulan' }[satuan]), 24, 44);
    // Legenda
    ctx.font = font(22);
    let lx = 24;
    [[warna1, t('Omzet')], [warna2, t('Laba kotor')]].forEach(([w, teks]) => {
      ctx.fillStyle = w;
      ctx.fillRect(lx, 64, 18, 18);
      ctx.fillStyle = '#3d4866';
      ctx.fillText(teks, lx + 26, 81);
      lx += 40 + ctx.measureText(teks).width + 24;
    });
    const w = Wd - L - R;
    const h = Ht - T - B;
    const { atas, langkah } = G.skala(Math.max(...kelompok.map((k) => Math.max(k.omzet, k.laba))));
    const y = (v) => T + h - (Math.max(0, v) / atas) * h;
    ctx.textAlign = 'right';
    ctx.font = font(20);
    for (let v = 0; v <= atas + 1e-9; v += langkah) {
      ctx.strokeStyle = v ? '#e3e8f1' : '#9aa5bd';
      ctx.lineWidth = v ? 1 : 2;
      ctx.beginPath();
      ctx.moveTo(L, Math.round(y(v)) + 0.5);
      ctx.lineTo(Wd - R, Math.round(y(v)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#5b6785';
      ctx.fillText(G.ringkas(v, setel.bahasa), L - 12, y(v) + 7);
    }
    const slot = w / kelompok.length;
    const bw = Math.max(3, Math.min(40, (slot * 0.72 - 4) / 2));
    const batang = (x, v, warna) => {
      const tinggi = y(0) - y(v);
      if (tinggi <= 0) return;
      const r = Math.min(8, bw / 2, tinggi);
      const top = y(v);
      ctx.fillStyle = warna;
      ctx.beginPath();
      ctx.moveTo(x, y(0));
      ctx.lineTo(x, top + r);
      ctx.quadraticCurveTo(x, top, x + r, top);
      ctx.lineTo(x + bw - r, top);
      ctx.quadraticCurveTo(x + bw, top, x + bw, top + r);
      ctx.lineTo(x + bw, y(0));
      ctx.closePath();
      ctx.fill();
    };
    const tiap = Math.ceil(kelompok.length / 8);
    ctx.textAlign = 'center';
    kelompok.forEach((k, i) => {
      const x0 = L + i * slot + (slot - (bw * 2 + 4)) / 2;
      batang(x0, k.omzet, warna1);
      batang(x0 + bw + 4, k.laba, warna2);
      if (i % tiap === 0) {
        ctx.fillStyle = '#5b6785';
        ctx.fillText(labelGrafik(satuan, k.mulai), L + i * slot + slot / 2, Ht - 20);
      }
    });
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    return blob ? { png: new Uint8Array(await blob.arrayBuffer()), lebar: Wd / 2, tinggi: Ht / 2 } : null;
  }

  async function buatLaporanExcel() {
    const d = dataLaporan();
    const [a, z] = batasPeriode(d.from, d.to, d.trx);
    const metode = { tunai: t('Tunai'), qris: 'QRIS', nanti: t('Bayar nanti') };
    const isi = KelolaExcel.laporan({
      namaUsaha: usaha().namaUsaha || 'Kelola',
      judul: t('Laporan penjualan, {periode}', { periode: teksPeriode(d.from, d.to, d.trx) }),
      dibuat: t('Dibuat dengan Kelola, {waktu}', { waktu: new Date().toLocaleString(lokal(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }),
      penjualan: d.trx.map((r) => {
        const sisa = P.sisaTagihan(r.data);
        return {
          waktu: Date.parse(r.data.waktu),
          barang: r.data.items.map((i) => `${V.namaItem(i)} ×${i.qty}`).join(', ') + (r.data.pelanggan ? ` (${r.data.pelanggan.nama})` : ''),
          metode: metode[r.data.metode] || metode.tunai,
          lunas: !(sisa > 0),
          omzet: r.data.total,
          laba: r.data.laba,
          sisa,
        };
      }),
      pengeluaran: d.keluar.map((r) => ({ waktu: Date.parse(r.data.waktu), kategori: t(r.data.kategori), catatan: r.data.catatan || '', jumlah: r.data.jumlah })),
      terlaris: d.terlaris.map(([nama, v]) => ({ nama, qty: v.qty, omzet: v.omzet })),
      grafik: await grafikPng(d.trx, d.from, d.to),
      teks: {
        ringkasan: t('Ringkasan'), penjualan: t('Penjualan'), pengeluaran: t('Pengeluaran'), perHari: t('Per hari'),
        terlaris: t('Terlaris'), tanggal: t('Tanggal'), jam: t('Jam'), barang: t('Barang'), caraBayar: t('Cara bayar'),
        status: t('Status'), omzet: t('Omzet'), labaKotor: t('Laba kotor'), sisa: t('Sisa tagihan'), lunas: t('Lunas'),
        belumLunas: t('Belum lunas'), tagihan: t('Tagihan belum lunas'), kategori: t('Kategori'), catatan: t('Catatan'), jumlah: t('Jumlah'),
        transaksi: t('Transaksi'), labaBersih: t('Laba bersih'), margin: t('Margin rata-rata'), produk: t('Produk'),
        terjual: t('Terjual'), total: t('Total'),
        catatanLaba: t('Laba kotor = omzet dikurangi modal barang yang terjual.'),
        catatanBersih: t('Laba bersih = laba kotor dikurangi pengeluaran.'),
        catatanGrafik: t('Grafik omzet dan laba'),
      },
    });
    const nama = `Kelola-${t('laporan')}-${tanggalIni(a)}_${tanggalIni(z)}.xlsx`;
    return { nama, blob: new Blob([isi], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), periode: teksPeriode(d.from, d.to, d.trx), n: d.trx.length };
  }

  async function bukaKirimLaporan() {
    const f = await buatLaporanExcel();
    if (ui.laporanFile && ui.laporanFile.url) URL.revokeObjectURL(ui.laporanFile.url);
    ui.laporanFile = Object.assign(f, { url: URL.createObjectURL(f.blob) });
    const file = window.File ? new File([f.blob], f.nama, { type: f.blob.type }) : null;
    const bisaBagi = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    dialog.innerHTML = `<div class="stack" id="kirimLaporanDialog">
      <div class="row"><h3>${t('Kirim laporan')}</h3><button type="button" class="link" data-act="tutup">${t('Tutup')}</button></div>
      <div class="hint"><b>${t('Periode')}:</b> ${esc(f.periode)} · ${t('{n} transaksi', { n: f.n })}<br><b>${t('File')}:</b> <span id="namaFileLaporan">${esc(f.nama)}</span></div>
      <div class="small muted">${t('Isi file Excel:')}</div>
      <ul class="isi-file small muted"><li>${t('Ringkasan + grafik omzet & laba')}</li><li>${t('Semua penjualan (yang belum lunas diberi warna)')}</li>
        <li>${t('Pengeluaran')}</li><li>${t('Penjualan per hari')}</li><li>${t('Produk terlaris')}</li></ul>
      ${bisaBagi ? `<button class="btn primary block" data-act="laporan-bagikan">${t('Bagikan file (WhatsApp, Gmail…)')}</button>` : ''}
      <a class="btn ${bisaBagi ? '' : 'primary'} block" href="${ui.laporanFile.url}" download="${esc(f.nama)}" id="simpanLaporan">${t('Simpan ke HP')}</a>
      <div class="small muted">${bisaBagi
        ? t('Untuk mengirim ke email, pilih Gmail (atau aplikasi email lain) di menu bagikan. File sudah terlampir.')
        : t('Simpan filenya, lalu lampirkan di email atau WhatsApp.')}</div>
    </div>`;
    if (!dialog.open) dialog.showModal();
  }

  async function bagikanLaporan() {
    const f = ui.laporanFile;
    if (!f) return;
    try {
      await navigator.share({ files: [new File([f.blob], f.nama, { type: f.blob.type })], title: f.nama });
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
      items: items.map((x) => {
        const i = { produkId: x.rec.id, nama: x.rec.data.nama, qty: x.qty, harga: x.harga };
        if (x.varian) i.varian = x.varian;
        if (x.catatan) i.catatan = x.catatan;
        return i;
      }),
    };
    const total = jual.items.reduce((s, i) => s + i.harga * i.qty, 0);
    jual.metode = ui.metode;
    if (ui.metode === 'qris' && ui.midtransOrder) jual.midtrans = ui.midtransOrder;
    ui.midtransOrder = null;
    jual.bayar = ui.metode === 'tunai' ? num(ui.bayar) || total : ui.metode === 'qris' ? total : 0;
    if (ui.metode === 'nanti') {
      const nama = ui.pelanggan.nama.trim();
      if (!nama) { toast(t('Isi nama pembeli dulu')); $('#pelangganNama') && $('#pelangganNama').focus(); return; }
      jual.pelanggan = { nama, wa: ui.pelanggan.wa.trim() };
      if (!modeStaff()) jual.jatuhTempo = jatuhTempoKasir();
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
    ui.jatuhTempo = undefined;
    render();
    toast(t(jual.metode === 'nanti' ? 'Tagihan {total} tersimpan' : 'Penjualan {total} tersimpan', { total: rp(total) }));
    // Tagihan baru dari HP owner: langsung tawarkan kirim tagihan ke pembeli.
    if (jual.metode === 'nanti' && !modeStaff()) bukaTagih(ui.trxTerakhir, true);
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
      bukaHalaman(go.dataset.go);
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.act) {
      case 'produk-baru': bukaFormProduk(); break;
      case 'produk-ubah': bukaFormProduk(id); break;
      case 'produk-tab': ui.produkTab = el.dataset.t; render(); break;
      case 'filter-kategori': {
        ui.kategori = el.dataset.k === '*' ? null : el.dataset.k;
        render();
        const aktif = $('.kat-chips [aria-pressed="true"]');
        if (aktif) aktif.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        break;
      }
      case 'pilih-kategori': pilihKategori(el); break;
      case 'kategori-baru': kategoriBaruForm(); break;
      case 'atur-kategori': bukaAturKategori(); break;
      case 'kategori-tambah': {
        $('#barisKategori').insertAdjacentHTML('beforeend', barisKategori('', 0));
        $('#barisKategori .kat-baris:last-child [name=kn]').focus();
        break;
      }
      case 'kategori-hapus': el.closest('.kat-baris').remove(); break;
      case 'kategori-naik': {
        const b = el.closest('.kat-baris');
        if (b.previousElementSibling) b.previousElementSibling.before(b);
        break;
      }
      case 'kategori-turun': {
        const b = el.closest('.kat-baris');
        if (b.nextElementSibling) b.nextElementSibling.after(b);
        break;
      }
      case 'tutup': dialog.close(); break;
      case 'mode-modal': gantiModeModal(el.dataset.m); break;
      case 'tambah-bahan-resep': $('#barisResep').insertAdjacentHTML('beforeend', barisResep()); hitungForm(); break;
      case 'tambah-isi-paket': $('#barisPaket').insertAdjacentHTML('beforeend', barisPaket(null, $('#formProduk').produkId.value)); hitungForm(); break;
      case 'hapus-baris': el.closest('.baris').remove(); hitungForm(); break;
      case 'hapus-foto': ui.foto = null; renderFotoForm(); break;
      case 'pilih-varian': bukaPilihVarian(id); break;
      case 'varian-qty': {
        const f = $('#formVarian');
        f.qty.value = Math.max(1, num(f.qty.value) + num(el.dataset.n));
        hitungVarian();
        break;
      }
      case 'varian-saklar': {
        const nyala = !!el.dataset.v;
        $$('[data-act=varian-saklar]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
        $('#isiVarian').hidden = !nyala;
        if (nyala) $('#bagianVarian').scrollIntoView({ block: 'nearest' });
        hitungForm();
        break;
      }
      case 'varian-contoh': {
        const c = V.CONTOH.find((x) => x.kode === el.dataset.k);
        tambahKelompokVarian({ nama: t(c.nama), banyak: c.banyak, pilihan: c.pilihan.map((n) => ({ nama: t(n), harga: 0 })) });
        break;
      }
      case 'varian-grup-baru': tambahKelompokVarian(); break;
      case 'varian-grup-hapus': el.closest('.varian-grup').remove(); hitungForm(); break;
      case 'varian-pilihan-baru': {
        const daftar = $('.daftar-pilihan', el.closest('.varian-grup'));
        daftar.insertAdjacentHTML('beforeend', barisPilihan());
        $('[name=vpn]', daftar.lastElementChild).focus();
        break;
      }
      case 'varian-jenis': {
        const g = el.closest('.varian-grup');
        $$('[data-act=varian-jenis]', g).forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
        $('[data-ket-satu]', g).hidden = !!el.dataset.b;
        hitungForm();
        break;
      }
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
          Object.keys(ui.cart).forEach((k) => { if (V.urai(k).produkId === id) delete ui.cart[k]; });
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
      case 'kosongkan': ui.cart = {}; ui.bayar = ''; ui.jatuhTempo = undefined; render(); break;
      case 'ubah-tempo': bukaUbahTempo(); break;
      case 'ubah-tempo-trx': bukaUbahTempo(id); break;
      case 'tempo-hari':
        $$('#formTempo [data-act=tempo-hari]').forEach((b) => b.setAttribute('aria-pressed', b === el));
        $('#formTempo').tanggal.value = el.dataset.tgl;
        break;
      case 'tagih-bagikan': bagikanTagihan(); break;
      case 'lihat-tagihan': lihatTagihan(); break;
      case 'tunda-pengingat': tundaPengingat(); break;
      case 'rekening-baru': bukaFormRekening(); break;
      case 'rekening-ubah': bukaFormRekening(id); break;
      case 'rekening-hapus':
        if (confirm(t('Hapus rekening ini?'))) {
          ubahProfil({ rekening: (profil().rekening || []).filter((r) => r.id !== id) });
          dialog.close();
          render();
        }
        break;
      case 'setel-tagihan': {
        const v = el.dataset.nilai;
        ubahProfil({ tagihan: Object.assign({}, T.pengaturan(profil()), { [el.dataset.nama]: v === 'true' ? true : v === 'false' ? false : Number(v) }) });
        render();
        break;
      }
      case 'notif-nyalakan': nyalakanNotif(); break;
      case 'notif-matikan': matikanNotif(); break;
      case 'notif-uji': ujiNotif(); break;
      case 'simpan-penjualan': simpanPenjualan(); break;
      case 'batal-trx': batalTransaksi(id); break;
      case 'periode': ui.periode = el.dataset.p; render(); break;
      case 'qris': bukaQris(); break;
      case 'midtrans-hubungkan': bukaHubungkanMidtrans(); break;
      case 'midtrans-aktif': setelMidtrans({ aksi: 'aktif', aktif: !!el.dataset.v }); break;
      case 'midtrans-putus': if (confirm(t('Putuskan Midtrans? Kasir kembali memakai QRIS biasa.'))) setelMidtrans({ aksi: 'hapus' }); break;
      case 'midtrans-muat': ui.midtrans = null; render(); break;
      case 'qris-manual': lunasManualMidtrans(); break;
      case 'salin-link-qr': salinLinkQr(); break;
      case 'qris-polos': bukaQris(true); break;
      case 'setel-qris-nominal':
        if (modeStaff() || modeKunci()) break;
        ubahProfil({ qrisNominal: !!el.dataset.v });
        render();
        break;
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
      case 'kirim-laporan': bukaKirimLaporan(); break;
      case 'laporan-bagikan': bagikanLaporan(); break;
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
      case 'gerbang':
        if (el.dataset.g !== 'lupa' && el.dataset.g !== 'daftar') ui.gerbangAsal = el.dataset.g;
        if (el.dataset.email != null) ui.authEmail = el.dataset.email;
        ui.gerbang = el.dataset.g;
        ui.gerbangMsg = null;
        render();
        window.scrollTo(0, 0);
        break;
      case 'pilih-akun':
        if (!(cloud.user && el.dataset.email === cloud.user.email) && faceIdAkun(el.dataset.email)) { pindahFaceId(el.dataset.email); break; }
        if (cloud.user && el.dataset.email === cloud.user.email) {
          if (ui.gantiAkun) { ui.gantiAkun = false; ui.gerbang = 'pilih'; } else ui.gerbang = 'owner';
        } else {
          ui.authEmail = el.dataset.email;
          ui.gerbang = ui.gerbangAsal = 'masuk-akun';
        }
        ui.gerbangMsg = null;
        render();
        window.scrollTo(0, 0);
        break;
      case 'ke-ganti-akun':
        ui.gantiAkun = true;
        if (faceIdAkun(el.dataset.email)) { pindahFaceId(el.dataset.email); break; }
        ui.authEmail = el.dataset.email || '';
        ui.gerbang = ui.gerbangAsal = 'masuk-akun';
        ui.gerbangMsg = null;
        render();
        window.scrollTo(0, 0);
        break;
      case 'batal-ganti-akun':
        ui.gantiAkun = false;
        ui.gerbang = 'pilih';
        ui.gerbangMsg = null;
        render();
        break;
      case 'lupakan-akun': {
        const a = daftarAkun().find((x) => x.id === el.dataset.id);
        const n = KelolaStore.arsipBelumTerkirim(window.localStorage, el.dataset.id);
        const tanya = n
          ? t('Akun {email} masih punya {n} perubahan yang belum terkirim ke cloud dan akan hilang. Tetap hapus dari HP ini?', { email: a ? a.email : '', n })
          : t('Hapus {email} dari HP ini? Datanya tetap aman di cloud dan muncul lagi kalau akun ini masuk lagi.', { email: a ? a.email : '' });
        if (confirm(tanya)) { lupakanAkun(el.dataset.id); render(); }
        break;
      }
      case 'pilih-kasir': pilihKasir(); break;
      case 'tanpa-akun': if (tanpaAkunBoleh()) masukMode('owner'); break;
      case 'owner-faceid': masukFaceId(); break;
      case 'faceid-aktifkan': aktifkanFaceId(); break;
      case 'faceid-nanti': ui.tawarFaceId = null; ui.faceIdMsg = null; render(); break;
      case 'faceid-matikan':
        if (cloud.user && confirm(t('Matikan Face ID / sidik jari untuk akun ini di HP ini? Masuk sebagai Owner akan memakai kata sandi lagi.'))) {
          F.hapus(window.localStorage, cloud.user.id);
          ui.faceIdMsg = { type: 'ok', text: t('Face ID / sidik jari dimatikan.') };
          render();
        }
        break;
      case 'ganti-mode': gantiMode(); break;
    }
  });

  function bukaHalaman(view, arah) {
    ui.view = view;
    ui.authMsg = null;
    render();
    window.scrollTo(0, 0);
    if (arah) {
      viewEl.classList.remove('geser-kiri', 'geser-kanan');
      void viewEl.offsetWidth; // mulai ulang animasi
      viewEl.classList.add(arah > 0 ? 'geser-kiri' : 'geser-kanan');
    }
  }

  // Geser jari ke kiri/kanan untuk pindah ke halaman sebelah (urutan sama dengan menu bawah).
  let sentuhAwal = null;
  const bisaGeserSendiri = (el) => {
    for (; el && el !== document.body; el = el.parentElement) {
      if (el.matches('input, textarea, select, [contenteditable], .kanvas')) return true;
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth) return true;
    }
    return false;
  };
  document.addEventListener('touchstart', (e) => {
    const s = e.touches[0];
    sentuhAwal = null;
    if (e.touches.length !== 1 || perluGerbang() || dialog.open) return;
    // Pinggir layar dipakai HP untuk tombol kembali.
    if (s.clientX < 24 || s.clientX > window.innerWidth - 24) return;
    if (bisaGeserSendiri(e.target)) return;
    sentuhAwal = { x: s.clientX, y: s.clientY, t: Date.now() };
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    const a = sentuhAwal;
    sentuhAwal = null;
    if (!a || perluGerbang() || dialog.open) return;
    const s = e.changedTouches[0];
    const dx = s.clientX - a.x;
    const dy = s.clientY - a.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8 || Date.now() - a.t > 700) return;
    const urutan = [...document.querySelectorAll('nav.tabs button[data-go]')].filter((b) => !b.hidden).map((b) => b.dataset.go);
    const i = urutan.indexOf(ui.view);
    const ke = urutan[i + (dx < 0 ? 1 : -1)];
    if (i >= 0 && ke) bukaHalaman(ke, dx < 0 ? 1 : -1);
  }, { passive: true });
  document.addEventListener('touchcancel', () => { sentuhAwal = null; }, { passive: true });

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
      const total = isiKeranjang().reduce((s, x) => s + x.harga * x.qty, 0);
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
    if (e.target.form && e.target.form.id === 'formVarian') { hitungVarian(); return; }
    if (e.target.name === 'salinVarian' && e.target.value) {
      const asal = store.get(e.target.value);
      if (asal) V.salin(asal.data.varian).forEach(tambahKelompokVarian);
      e.target.value = '';
      return;
    }
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
      change(() => { store.put('produk', d, f.produkId.value || undefined); catatKategori(); });
      dialog.close();
      render();
      toast(t('Produk tersimpan'));
    }
    if (f.id === 'formVarian') {
      e.preventDefault();
      simpanPilihVarian(f);
      return;
    }
    if (f.id === 'formTempo') {
      e.preventDefault();
      const tgl = T.tanggalSah(f.tanggal.value) ? f.tanggal.value : null;
      const id = f.trxId.value;
      const trx = id && store.get(id);
      if (trx) {
        const d = Object.assign({}, trx.data, { jatuhTempo: tgl });
        if (!tgl) d.jatuhTempo = undefined;
        change(() => store.put('transaksi', JSON.parse(JSON.stringify(d)), id));
      } else if (!id) {
        ui.jatuhTempo = tgl;
      }
      dialog.close();
      render();
      return;
    }
    if (f.id === 'formRekening') {
      e.preventDefault();
      const r = { id: f.rekId.value || KelolaStore.uuid(), bank: f.bank.value.trim(), nomor: T.nomorPolos(f.nomor.value), nama: f.nama.value.trim() };
      if (!r.bank || !r.nomor) { toast(t('Isi nama bank dan nomor rekening')); return; }
      const list = (profil().rekening || []).slice();
      const i = list.findIndex((x) => x.id === r.id);
      if (i >= 0) list[i] = r; else list.push(r);
      ubahProfil({ rekening: list });
      dialog.close();
      render();
      toast(t('Rekening tersimpan'));
      return;
    }
    if (f.id === 'formKategori') {
      e.preventDefault();
      simpanAturKategori(f);
      return;
    }
    if (f.id === 'formMidtrans') {
      e.preventDefault();
      simpanKunciMidtrans(f);
      return;
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
    if (f.id === 'formGerbang') {
      e.preventDefault();
      await kirimGerbang(f);
    }
    if (f.id === 'formGantiAkun') {
      e.preventDefault();
      await kirimGantiAkun(f);
    }
    if (f.id === 'formDaftar') {
      e.preventDefault();
      await kirimDaftar(f);
    }
    if (f.id === 'formLupa') {
      e.preventDefault();
      await kirimLupa(f);
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
      if (cloud.user) await simpanSandi(cloud.user.email, f.password.value);
      setModeSesi('owner');
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
        else await simpanSandi(email, f.password.value);
      } else if (ui.authMode === 'lupa') {
        const { error } = await auth.resetPasswordForEmail(email, { redirectTo: redirect });
        if (error) throw error;
        ui.authMsg = { type: 'ok', text: t('Tautan untuk membuat kata sandi baru sudah dikirim ke {email}.', { email }) };
      } else {
        const { error } = await auth.signInWithPassword({ email, password: f.password.value });
        if (error) throw error;
        await simpanSandi(email, f.password.value);
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
    await hapusLanggananNotif();
    await cloud.client.auth.signOut().catch(() => {});
    if (cloud.user) lupakanAkun(cloud.user.id);
    const wasStaff = modeStaff();
    setUser(null);
    if (wasStaff) S.hapusKasir(window.localStorage);
    else store.clear();
    ui.cart = {};
    ui.trxTerakhir = null;
    ui.authMode = 'masuk';
    ui.authMsg = null;
    hapusSandi();
    setModeSesi(null);
    ui.gerbang = 'pilih';
    ui.gerbangMsg = { type: 'ok', text: t('Anda sudah keluar.') };
    ui.view = 'kasir';
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
    if (ui.usahaBaru && ui.usahaBaru.id === user.id) {
      if (!profil().namaUsaha) store.put('profil', Object.assign({}, profil(), { namaUsaha: ui.usahaBaru.nama }), 'profil');
      ui.usahaBaru = null;
    }
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

  // Panggilan untuk akun yang sama selagi masih dimuat memakai proses yang sama.
  let userJalan = null;
  function setUser(user) {
    if (user && userJalan && userJalan.id === user.id) return userJalan.p;
    const p = pasangUser(user);
    userJalan = user ? { id: user.id, p } : null;
    p.finally(() => { if (userJalan && userJalan.p === p) userJalan = null; });
    return p;
  }

  async function pasangUser(user) {
    const prev = cloud.user && cloud.user.id;
    cloud.user = user;
    if (!user) {
      cloud.sync = null;
      cloud.peran = null;
      cloud.status = 'idle';
      kasirStaff = null;
      ui.staff = { list: null, kode: null, msg: null, belumSiap: false, memuat: false };
      ui.midtrans = null;
      return;
    }
    if (prev === user.id && cloud.peran) return;
    if (prev && prev !== user.id) {
      // Ganti akun: lupakan semua yang terkait akun sebelumnya.
      cloud.sync = null;
      cloud.peran = null;
      cloud.status = 'idle';
      kasirStaff = null;
      ui.staff = { list: null, kode: null, msg: null, belumSiap: false, memuat: false };
      ui.cart = {};
      ui.trxTerakhir = null;
      ui.laporanFile = null;
      ui.midtrans = null;
    }
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
    const jalan = modeStaff() ? syncStaff() : cloud.sync.run().then(prosesPenjualanStaff).then(prosesBayarMidtrans);
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
      change(() => { n = P.olahPenjualanStaff(store, H, rows, nama, (w) => T.jatuhTempoBaru(w, T.pengaturan(profil()).jatuhTempo)); });
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
    // Notifikasi pengingat disentuh saat aplikasi sudah terbuka.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.buka === 'tagihan' && !perluGerbang()) lihatTagihan();
    });
  }

  // Aplikasi dibuka dari notifikasi pengingat: langsung ke daftar Belum lunas.
  if (new URLSearchParams(location.search).get('buka') === 'tagihan') {
    ui.view = 'laporan';
    ui.bukaTagihan = true;
    history.replaceState(null, '', location.pathname);
  }

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', terapkanTema);

  terapkanTema();
  initCloud();
  render();
  cekFaceIdBisa();

  // Untuk pengujian.
  window.Kelola = { store, cloud, ui, H, setel };
})();
