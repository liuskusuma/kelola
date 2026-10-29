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

  // jual = { id?, waktu, items: [{ produkId, nama, qty, harga }], bayar, staff? }
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
    const data = { waktu: jual.waktu, items, total, laba, bayar: jual.bayar || total, potong };
    if (jual.staff) data.staff = jual.staff;
    const rec = store.put('transaksi', data, jual.id);
    ubahStok(store, potong, -1);
    return rec;
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
        staff: namaStaff(row.staff_id) || 'Staff',
      });
      n += 1;
    });
    return n;
  }

  const api = { ubahStok, catatPenjualan, batalPenjualan, olahPenjualanStaff };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaPenjualan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
