// Varian dan tambahan produk (ukuran, topping, level pedas, ...).
// Tanpa DOM, jadi bisa diuji dengan `node --test`.
//
// produk.data.varian = [{ id, nama, banyak, pilihan: [{ id, nama, harga }] }]
// - banyak = false: pembeli memilih satu (pilihan paling atas terpilih otomatis).
// - banyak = true:  boleh memilih beberapa, boleh juga tidak sama sekali.
// - harga: tambahan di atas harga jual produk (0 kalau harganya sama).
// Di keranjang, satu baris = produk + pilihan + catatan. Kunci barisnya dibuat `kunci()`.
// Di penjualan, pilihan disimpan sebagai teks di `items[].varian` dan `items[].catatan`.
(function (root) {
  'use strict';

  const MAKS = 30; // panjang nama kelompok dan pilihan
  const MAKS_CATATAN = 60;
  const PISAH = '|';

  // Contoh siap pakai di form produk. Nama diterjemahkan oleh tampilan.
  const CONTOH = [
    { kode: 'ukuran', nama: 'Ukuran', banyak: false, pilihan: ['Reguler', 'Besar'] },
    { kode: 'suhu', nama: 'Panas / Dingin', banyak: false, pilihan: ['Dingin', 'Panas'] },
    { kode: 'pedas', nama: 'Level pedas', banyak: false, pilihan: ['Tidak pedas', 'Sedang', 'Pedas'] },
    { kode: 'gula', nama: 'Level gula', banyak: false, pilihan: ['Normal', 'Sedikit gula', 'Tanpa gula'] },
    { kode: 'tambahan', nama: 'Tambahan', banyak: true, pilihan: [] },
  ];

  const teks = (s, maks) => String(s == null ? '' : s).replace(/[|\s]+/g, ' ').trim().slice(0, maks);
  const idAcak = () => Math.random().toString(36).slice(2, 8);

  // Buang kelompok/pilihan kosong, rapikan nama dan harga, beri id yang belum punya.
  function rapikan(list, buatId) {
    const id = buatId || idAcak;
    const pakai = new Set();
    const unik = (x) => {
      let v = /^[A-Za-z0-9_-]{1,24}$/.test(x || '') ? x : id();
      while (pakai.has(v)) v = id();
      pakai.add(v);
      return v;
    };
    return (Array.isArray(list) ? list : []).map((g) => {
      const pilihan = (Array.isArray(g && g.pilihan) ? g.pilihan : [])
        .map((p) => ({ nama: teks(p && p.nama, MAKS), harga: Math.max(0, Number(p && p.harga) || 0), id: p && p.id }))
        .filter((p) => p.nama)
        .map((p) => ({ id: unik(p.id), nama: p.nama, harga: p.harga }));
      return { id: g && g.id, nama: teks(g && g.nama, MAKS), banyak: !!(g && g.banyak), pilihan };
    }).filter((g) => g.nama && g.pilihan.length)
      .map((g) => ({ id: unik(g.id), nama: g.nama, banyak: g.banyak, pilihan: g.pilihan }));
  }

  const ada = (d) => !!(d && Array.isArray(d.varian) && d.varian.length);

  // Salinan kelompok dengan id baru (untuk "salin dari produk lain").
  function salin(list, buatId) {
    return rapikan((list || []).map((g) => ({
      nama: g.nama, banyak: g.banyak, pilihan: (g.pilihan || []).map((p) => ({ nama: p.nama, harga: p.harga })),
    })), buatId);
  }

  // Cocokkan pilihan pembeli dengan varian produk saat ini.
  // Kelompok "pilih satu" selalu punya tepat satu pilihan (yang paling atas kalau belum dipilih).
  // Hasil: { ids, tambah, label, daftar: [{ nama, harga }] }
  function pilih(varian, ids) {
    const mau = new Set(ids || []);
    const daftar = [];
    const hasil = [];
    (varian || []).forEach((g) => {
      const kena = g.pilihan.filter((p) => mau.has(p.id));
      const ambil = g.banyak ? kena : [kena[0] || g.pilihan[0]];
      ambil.forEach((p) => { if (p) { hasil.push(p.id); daftar.push({ nama: p.nama, harga: p.harga || 0 }); } });
    });
    return {
      ids: hasil,
      tambah: daftar.reduce((s, p) => s + p.harga, 0),
      label: daftar.map((p) => p.nama).join(', '),
      daftar,
    };
  }

  const rapikanCatatan = (s) => teks(s, MAKS_CATATAN);

  // Kunci baris keranjang. Produk tanpa pilihan dan tanpa catatan memakai id produknya saja.
  function kunci(produkId, ids, catatan) {
    const c = rapikanCatatan(catatan);
    const i = (ids || []).join(',');
    return i || c ? [produkId, i, c].join(PISAH) : produkId;
  }

  function urai(k) {
    const b = String(k).split(PISAH);
    return { produkId: b[0], ids: b[1] ? b[1].split(',') : [], catatan: b.slice(2).join(' ') };
  }

  // Keranjang { kunci: qty } -> { produkId: qty }, untuk hitung stok.
  function perProduk(cart) {
    const out = {};
    Object.entries(cart || {}).forEach(([k, qty]) => {
      const id = urai(k).produkId;
      out[id] = (out[id] || 0) + qty;
    });
    return out;
  }

  // Nama barang di struk dan laporan: "Es Kopi Susu (Besar, Extra shot)".
  const namaItem = (i) => (i && i.varian ? `${i.nama} (${i.varian})` : (i && i.nama) || '');

  // "Ukuran, Tambahan" untuk daftar produk.
  const ringkas = (varian) => (varian || []).map((g) => g.nama).join(', ');

  const api = { MAKS, MAKS_CATATAN, CONTOH, rapikan, ada, salin, pilih, rapikanCatatan, kunci, urai, perProduk, namaItem, ringkas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaVarian = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
