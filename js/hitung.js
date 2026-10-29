// Rumus Kelola: HPP dari resep, harga jual, dan potongan stok.
// Tidak menyentuh tampilan atau penyimpanan, jadi bisa diuji dengan `node --test`.
//
// Bentuk data:
// - bahan:  { nama, satuan, isi, harga, stok }
//           `harga` adalah harga beli satu kemasan berisi `isi` satuan (mis. 1000 gram).
// - produk: { nama, satuan, mode, modal, harga, stok, resep, paket }
//           mode 'manual' (atau kosong): modal diisi sendiri.
//           mode 'resep': resep = { items: [{ bahanId, jumlah }], hasil, biayaLain }.
//           mode 'paket': paket = [{ produkId, qty }].
//           Untuk resep dan paket, `modal` adalah HPP saat produk terakhir disimpan,
//           dipakai untuk mendeteksi perubahan harga bahan.
(function (root) {
  'use strict';

  const BATAS = 4; // kedalaman paket di dalam paket

  function hargaSatuan(bahan) {
    return bahan && bahan.isi > 0 ? (bahan.harga || 0) / bahan.isi : 0;
  }

  function margin(modal, harga) {
    return harga > 0 ? ((harga - modal) / harga) * 100 : 0;
  }

  // Harga jual dari modal dan target margin, dibulatkan ke atas ke kelipatan 500.
  function hargaSaran(modal, targetMargin) {
    if (modal <= 0 || targetMargin <= 0 || targetMargin >= 100) return 0;
    return Math.ceil(modal / (1 - targetMargin / 100) / 500) * 500;
  }

  // Tiga pilihan harga di sekitar target margin.
  function pilihanHarga(modal, target) {
    const t = target > 0 ? target : 30;
    return [
      { kode: 'hemat', label: 'Hemat', target: Math.max(5, t - 10) },
      { kode: 'standar', label: 'Standar', target: t },
      { kode: 'premium', label: 'Premium', target: Math.min(90, t + 15) },
    ].map((p) => Object.assign(p, { harga: hargaSaran(modal, p.target) }));
  }

  // Modal per satuan produk dengan harga bahan saat ini.
  // `cari(id)` mengembalikan data bahan atau produk, atau null.
  function modalProduk(p, cari, depth) {
    if (!p) return 0;
    depth = depth || 0;
    if (p.mode === 'resep' && p.resep) {
      const r = p.resep;
      const hasil = r.hasil > 0 ? r.hasil : 1;
      const bahan = (r.items || []).reduce((s, i) => s + hargaSatuan(cari(i.bahanId)) * (i.jumlah || 0), 0);
      return (bahan + (r.biayaLain || 0)) / hasil;
    }
    if (p.mode === 'paket' && p.paket) {
      if (depth >= BATAS) return 0;
      return p.paket.reduce((s, i) => s + modalProduk(cari(i.produkId), cari, depth + 1) * (i.qty || 0), 0);
    }
    return p.modal || 0;
  }

  // Apa saja yang berkurang kalau `qty` produk terjual.
  // Produk yang stoknya dihitung: stok produk yang berkurang (bahannya sudah terpakai saat produksi).
  // Produk tanpa stok yang punya resep: stok bahannya yang berkurang.
  // Paket: diteruskan ke produk isinya.
  function potongan(id, qty, cari, out, depth) {
    out = out || { produk: {}, bahan: {} };
    depth = depth || 0;
    const p = cari(id);
    if (!p || depth >= BATAS) return out;
    if (p.mode === 'paket' && p.paket) {
      p.paket.forEach((i) => potongan(i.produkId, qty * (i.qty || 0), cari, out, depth + 1));
      return out;
    }
    if (p.stok != null) {
      out.produk[id] = (out.produk[id] || 0) + qty;
      return out;
    }
    if (p.mode === 'resep' && p.resep) {
      const hasil = p.resep.hasil > 0 ? p.resep.hasil : 1;
      (p.resep.items || []).forEach((i) => {
        const b = cari(i.bahanId);
        if (b && b.stok != null) out.bahan[i.bahanId] = (out.bahan[i.bahanId] || 0) + ((i.jumlah || 0) * qty) / hasil;
      });
    }
    return out;
  }

  // Potongan untuk seluruh keranjang { produkId: qty }.
  function potonganKeranjang(cart, cari) {
    const out = { produk: {}, bahan: {} };
    Object.entries(cart).forEach(([id, qty]) => potongan(id, qty, cari, out));
    return out;
  }

  // Apakah stok produk cukup untuk keranjang ini.
  function stokCukup(cart, cari) {
    const out = potonganKeranjang(cart, cari);
    return Object.entries(out.produk).every(([id, n]) => {
      const p = cari(id);
      return !p || p.stok == null || p.stok >= n - 1e-9;
    });
  }

  // Bahan yang terpakai untuk membuat `batch` kali resep.
  function bahanProduksi(p, batch) {
    const out = {};
    if (!p || p.mode !== 'resep' || !p.resep) return out;
    (p.resep.items || []).forEach((i) => {
      out[i.bahanId] = (out[i.bahanId] || 0) + (i.jumlah || 0) * batch;
    });
    return out;
  }

  const api = { hargaSatuan, margin, hargaSaran, pilihanHarga, modalProduk, potongan, potonganKeranjang, stokCukup, bahanProduksi };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaHitung = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
