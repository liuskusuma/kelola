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
    trxTerakhir: null, // penjualan yang baru disimpan, untuk tombol struk
    produkTab: 'produk', // produk | bahan
    periode: 'hari',
    authMode: 'masuk',
    authMsg: null,
    authEmail: '',
    struk: null, // { blob, url, teks }
    foto: null, // foto produk di form yang sedang dibuka (data URL)
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

  // ---------- Pengaturan ----------

  function terapkanTema() {
    document.documentElement.dataset.tema = setel.tema;
    document.documentElement.lang = setel.bahasa;
    const gelap = setel.tema === 'gelap' || (setel.tema === 'otomatis' && matchMedia('(prefers-color-scheme: dark)').matches);
    $$('meta[name="theme-color"]').forEach((m) => { m.content = gelap ? '#14234f' : '#f2f5fa'; m.removeAttribute('media'); });
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
    document.querySelectorAll('nav.tabs button').forEach((b) => {
      if (b.dataset.go === ui.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
      $('.teks', b).textContent = t(JUDUL[b.dataset.go][0]);
    });
    $('nav.tabs').setAttribute('aria-label', t('Menu utama'));
    const [judul, sub] = JUDUL[ui.view];
    $('#judul').textContent = t(judul);
    $('#subjudul').textContent = profil().namaUsaha || t(sub);
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
      const pending = store.dirtyRecords().length;
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
      .map(([id, qty]) => ({ rec: store.get(id), qty }))
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
    return H.stokCukup(cart, cari);
  }

  const fotoKecil = (d) => (d.foto ? `<img class="thumb" src="${esc(d.foto)}" alt="">` : '');

  function viewKasir() {
    const produk = produkList();
    if (!produk.length) {
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
    const terakhir = !items.length && ui.trxTerakhir && store.get(ui.trxTerakhir);
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
        <div class="two" style="margin-top:14px">
          <label class="field"><span>${t('Uang diterima')}</span><input id="bayar" type="number" inputmode="numeric" min="0" value="${esc(ui.bayar)}" placeholder="${total}"></label>
          <div class="field"><span class="lbl">${t('Kembalian')}</span><div class="total" id="kembalian" style="padding:6px 4px">${bayar >= total ? rp(bayar - total) : '–'}</div></div>
        </div>
        <div class="row" style="margin-top:16px">
          <button class="btn" data-act="kosongkan">${t('Kosongkan')}</button>
          <button class="btn primary" data-act="simpan-penjualan">${t('Simpan penjualan')}</button>
        </div></div>`
      : '';
    const petunjuk = items.length ? '' : `<div class="foot" style="margin:0 8px 14px">${t('Ketuk produk untuk menambahkannya ke keranjang.')}</div>`;
    return `${info}${cart}<div class="group-title">${t('Produk')}</div>${petunjuk}<div class="grid">${tiles}</div>`;
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

  // Disimpan dalam Bahasa Indonesia; ditampilkan sesuai bahasa yang dipilih.
  const KATEGORI = ['Sewa tempat', 'Listrik & air', 'Gaji', 'Transportasi', 'Iklan & promosi', 'Peralatan', 'Lainnya'];

  function viewLaporan() {
    const from = rentang(ui.periode);
    const dalam = (r) => Date.parse(r.data.waktu) >= from;
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
    const seg = [['hari', t('Hari ini')], ['7hari', t('7 hari')], ['bulan', t('Bulan ini')], ['semua', t('Semua')]]
      .map(([k, l]) => `<button data-act="periode" data-p="${k}" aria-pressed="${ui.periode === k}">${l}</button>`).join('');
    const fmtWaktu = (iso) => new Date(iso).toLocaleString(lokal(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const fmtTanggal = (iso) => new Date(iso).toLocaleDateString(lokal(), { day: 'numeric', month: 'short' });
    return `<div class="group-title">${t('Periode')}</div><div class="seg">${seg}</div>
      <div class="stats">
        <div class="stat utama"><div class="lbl">${t('Omzet')}</div><div class="value">${rp(omzet)}</div></div>
        <div class="stat"><div class="lbl">${t('Laba kotor')}</div><div class="value">${rp(laba)}</div></div>
        <div class="stat" id="statPengeluaran"><div class="lbl">${t('Pengeluaran')}</div><div class="value">${rp(biaya)}</div></div>
        <div class="stat" id="labaBersih"><div class="lbl">${t('Laba bersih')}</div><div class="value ${bersih < 0 ? 'err' : ''}">${rp(bersih)}</div></div>
        <div class="stat"><div class="lbl">${t('Transaksi')}</div><div class="value">${trx.length}</div></div>
        <div class="stat"><div class="lbl">${t('Margin rata-rata')}</div><div class="value">${omzet ? angka.format((laba / omzet) * 100) + '%' : '–'}</div></div>
      </div>
      <div class="foot">${t('Laba kotor = omzet dikurangi modal barang yang terjual. Laba bersih = laba kotor dikurangi pengeluaran.')}</div>
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
            <div class="small muted">${fmtWaktu(r.data.waktu)} · ${esc(r.data.items.map((i) => `${i.nama} ×${i.qty}`).join(', '))}</div></div>
            <div class="aksi"><button class="btn kecil" data-act="struk" data-id="${r.id}">${t('Struk')}</button>
            <button class="btn kecil danger" data-act="batal-trx" data-id="${r.id}">${t('Batalkan')}</button></div></li>`).join('')}</ul>`
        : `<div class="empty">${t('Belum ada penjualan.')}</div>`}</div>`;
  }

  function viewAkun() {
    const p = profil();
    const pilih = (nama, nilai, opsi) => `<div class="seg kecil" role="group">${opsi.map(([k, l]) =>
      `<button data-act="setel" data-nama="${nama}" data-nilai="${k}" aria-pressed="${nilai === k}">${l}</button>`).join('')}</div>`;
    const usaha = `<div class="group-title">${t('Profil usaha')}</div><div class="card stack">
      <label class="field"><span>${t('Nama usaha')}</span><input id="namaUsahaInput" value="${esc(p.namaUsaha)}" placeholder="${t('Contoh: Warung Bu Sari')}"></label>
      <label class="field"><span>${t('Alamat atau nomor WhatsApp (tampil di struk)')}</span><input id="kontakUsahaInput" value="${esc(p.kontak || '')}" placeholder="${t('Contoh: Jl. Melati 5 · 0812 3456 7890')}"></label>
      <button class="btn" data-act="simpan-profil">${t('Simpan')}</button></div>`;
    const pengaturan = `<div class="group-title">${t('Pengaturan')}</div><div class="card stack" id="pengaturan">
      <div class="field"><span class="lbl">${t('Bahasa')}</span>${pilih('bahasa', setel.bahasa, [['id', 'Bahasa Indonesia'], ['en', 'English']])}</div>
      <div class="field"><span class="lbl">${t('Tampilan')}</span>${pilih('tema', setel.tema, [['terang', t('Terang')], ['gelap', t('Gelap')], ['otomatis', t('Ikuti HP')]])}</div>
      </div>`;
    return `${usaha}${pengaturan}${viewCloud()}`;
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
  function kecilkanFoto(file) {
    return new Promise((ok, gagal) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const MAKS = 480;
        const skala = Math.min(1, MAKS / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * skala);
        c.height = Math.round(img.naturalHeight * skala);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', 0.72));
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
    const p = profil();
    const w = new Date(trx.data.waktu).toLocaleString(lokal(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const bayar = trx.data.bayar || trx.data.total;
    return {
      judul: p.namaUsaha || t('Struk penjualan'),
      kontak: p.kontak || '',
      waktu: w,
      items: trx.data.items.map((i) => ({ nama: i.nama, rinci: `${angka.format(i.qty)} × ${rp(i.harga)}`, jumlah: rp(i.qty * i.harga) })),
      total: rp(trx.data.total),
      bayar: rp(bayar),
      kembali: rp(Math.max(0, bayar - trx.data.total)),
    };
  }

  function strukTeks(s) {
    return [
      `*${s.judul}*`, s.kontak, s.waktu, '',
      ...s.items.map((i) => `${i.nama}\n  ${i.rinci} = ${i.jumlah}`), '',
      `*${t('Total')}: ${s.total}*`, `${t('Bayar')}: ${s.bayar}`, `${t('Kembali')}: ${s.kembali}`, '', t('Terima kasih!'),
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
    ctx.fillStyle = '#fecb10';
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
    baris(t('Total'), s.total, true);
    baris(t('Bayar'), s.bayar);
    baris(t('Kembali'), s.kembali);
    y += 16;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0a2a6e';
    ctx.font = font(24, true);
    ctx.fillText(t('Terima kasih!'), W / 2, y);
    return c;
  }

  async function bukaStruk(id) {
    const trx = store.get(id);
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
    toast(t('Penjualan {total} tersimpan', { total: rp(total) }));
  }

  function batalTransaksi(id) {
    const trx = store.get(id);
    if (!trx || !confirm(t('Batalkan penjualan ini? Stok produk dan bahan akan dikembalikan.'))) return;
    change(() => {
      if (trx.data.potong) {
        ubahStok(trx.data.potong, 1);
      } else {
        // Penjualan dari versi lama: hanya stok produk yang dipotong.
        trx.data.items.forEach((i) => {
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
      case 'simpan-profil':
        change(() => store.put('profil', { namaUsaha: $('#namaUsahaInput').value.trim(), kontak: $('#kontakUsahaInput').value.trim() }, 'profil'));
        render();
        toast(t('Profil tersimpan'));
        break;
      case 'setel': ubahPengaturan({ [el.dataset.nama]: el.dataset.nilai }); break;
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

  // Pilihan di <select> dan file foto memicu `change`, bukan `input`, di sebagian browser.
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-foto]')) { pilihFoto(e.target); return; }
    if (e.target.form && e.target.form.id === 'formProduk') hitungForm();
  });

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
          ubahStok({ bahan: H.bahanProduksi(p.data, batch) }, -1);
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
    const pending = store.dirtyRecords().length;
    const tanya = pending
      ? t('Masih ada {n} perubahan yang belum terkirim ke cloud dan akan hilang jika Anda keluar sekarang. Tetap keluar?', { n: pending })
      : t('Keluar dari akun? Data di perangkat ini akan dihapus, tapi tetap aman di cloud.');
    if (!confirm(tanya)) return;
    await cloud.client.auth.signOut().catch(() => {});
    setUser(null);
    store.clear();
    ui.cart = {};
    ui.authMode = 'masuk';
    ui.authMsg = { type: 'ok', text: t('Anda sudah keluar.') };
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
      if (loud) toast(t('Tidak ada koneksi internet'));
      return Promise.resolve();
    }
    return cloud.sync.run().then(
      () => { if (loud) toast(t('Data sudah sinkron')); },
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
    if (e.key === KelolaStore.KEY || e.key === KelolaBahasa.KEY) location.reload();
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
