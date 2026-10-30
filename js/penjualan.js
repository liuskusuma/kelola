// Mencatat penjualan ke penyimpanan lokal: hitung modal dan laba, lalu potong stok.
// Dipakai kasir owner dan saat HP owner mengambil penjualan dari akun staff.
(function (root) {
  'use strict';

  // Tambah atau kurangi stok produk dan bahan sesuai `potong` (tanda -1 = kurangi).
  function ubahStok(store, potong, tanda) {
    Object.entries(potong.produk || {}).forEach(([id, n]) => {
      const p = store.get(id);
      if (p && p.data.stok != null) store.put('produk', Object.assign({}, p.data, { stok: p.data.stok + tanda * n }), id);
    });
    Object.entries(potong.bahan || {}).forEach(([id, n]) => {
      const b = store.get(id);
      if (b && b.data.stok != null) store.put('bahan', Object.assign({}, b.data, { stok: b.data.stok + tanda * n }), id);
    });
  }

  // jual = { id?, waktu, items: [{ produkId, nama, qty, harga }], bayar, staff?, metode?, pelanggan? }
  // metode: 'tunai' (bawaan), 'qris', atau 'nanti' (belum dibayar, jadi tagihan).
  // Modal diambil dari data produk saat ini, jadi staff tidak perlu tahu modal.
  function catatPenjualan(store, H, jual) {
    const cari = (id) => { const r = store.get(id); return r ? r.data : null; };
    const cart = {};
    const items = jual.items.map((i) => {
      cart[i.produkId] = (cart[i.produkId] || 0) + i.qty;
      return { produkId: i.produkId, nama: i.nama, qty: i.qty, harga: i.harga, modal: H.modalProduk(cari(i.produkId), cari) };
    });
    const total = items.reduce((s, i) => s + i.harga * i.qty, 0);
    const laba = items.reduce((s, i) => s + (i.harga - i.modal) * i.qty, 0);
    const potong = H.potonganKeranjang(cart, cari);
    const metode = METODE.includes(jual.metode) ? jual.metode : 'tunai';
    const data = { waktu: jual.waktu, items, total, laba, bayar: metode === 'nanti' ? 0 : jual.bayar || total, potong, metode };
    if (jual.staff) data.staff = jual.staff;
    if (metode === 'nanti') {
      const pl = jual.pelanggan || {};
      data.pelanggan = { nama: String(pl.nama || '').trim() || 'Pelanggan', wa: String(pl.wa || '').trim() };
      data.dibayar = [];
      data.lunas = false;
    }
    const rec = store.put('transaksi', data, jual.id);
    ubahStok(store, potong, -1);
    return rec;
  }

  const METODE = ['tunai', 'qris', 'nanti'];

  // Sisa tagihan penjualan "bayar nanti"; 0 untuk penjualan yang langsung dibayar.
  function sisaTagihan(d) {
    if (!d || d.metode !== 'nanti') return 0;
    const masuk = (d.dibayar || []).reduce((s, b) => s + (b.jumlah || 0), 0);
    return Math.max(0, d.total - masuk);
  }

  // Catat pembayaran (boleh dicicil) untuk penjualan "bayar nanti".
  function catatBayar(store, id, bayar) {
    const trx = store.get(id);
    if (!trx || trx.data.metode !== 'nanti' || !(bayar.jumlah > 0)) return null;
    const dibayar = (trx.data.dibayar || []).concat([{
      waktu: bayar.waktu, jumlah: bayar.jumlah, metode: bayar.metode === 'qris' ? 'qris' : 'tunai',
    }]);
    const d = Object.assign({}, trx.data, { dibayar });
    d.lunas = sisaTagihan(d) <= 0;
    return store.put('transaksi', d, id);
  }

  // Nomor WhatsApp untuk tautan wa.me: hanya angka, diawali kode negara 62.
  function nomorWa(nomor) {
    let n = String(nomor || '').replace(/\D/g, '');
    if (n.startsWith('0')) n = '62' + n.slice(1);
    else if (n.startsWith('8')) n = '62' + n;
    return n.length >= 9 ? n : '';
  }

  function batalPenjualan(store, id) {
    const trx = store.get(id);
    if (!trx) return;
    if (trx.data.potong) {
      ubahStok(store, trx.data.potong, 1);
    } else {
      // Penjualan dari versi lama: hanya stok produk yang dipotong.
      trx.data.items.forEach((i) => {
        const p = store.get(i.produkId);
        if (p && p.data.stok != null) store.put('produk', Object.assign({}, p.data, { stok: p.data.stok + i.qty }), p.id);
      });
    }
    store.remove(id);
  }

  // Penjualan dari akun staff yang diambil dari cloud. Yang sudah pernah dicatat
  // (termasuk yang sudah dibatalkan) dilewati, jadi aman kalau terambil dua kali.
  function olahPenjualanStaff(store, H, rows, namaStaff) {
    let n = 0;
    rows.forEach((row) => {
      if (store.has(row.id)) return;
      const d = row.data || {};
      catatPenjualan(store, H, {
        id: row.id,
        waktu: d.waktu || row.created_at,
        items: (d.items || []).map((i) => ({ produkId: i.produkId, nama: i.nama, qty: Number(i.qty) || 0, harga: Number(i.harga) || 0 })),
        bayar: d.bayar,
        metode: d.metode,
        pelanggan: d.pelanggan,
        staff: namaStaff(row.staff_id) || 'Staff',
      });
      n += 1;
    });
    return n;
  }

  const api = { ubahStok, catatPenjualan, batalPenjualan, olahPenjualanStaff, sisaTagihan, catatBayar, nomorWa };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaPenjualan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
