// Kategori produk (tanpa DOM). Nama kategori disimpan di `produk.data.kategori`;
// urutannya di `profil.data.kategori` (daftar nama). Produk tanpa kategori masuk "Lainnya".
(function (root) {
  'use strict';

  const MAKS = 30;

  // Rapikan nama kategori: tanpa spasi berlebih, maksimal 30 huruf.
  function rapikan(nama) {
    return String(nama == null ? '' : nama).replace(/\s+/g, ' ').trim().slice(0, MAKS);
  }

  const kunci = (nama) => rapikan(nama).toLocaleLowerCase('id');

  // Pakai nama yang sudah ada kalau sama (tanpa membedakan huruf besar/kecil),
  // supaya "minuman" dan "Minuman" tidak jadi dua kategori.
  function cocokkan(daftar, nama) {
    const n = rapikan(nama);
    if (!n) return '';
    return daftar.find((k) => kunci(k) === kunci(n)) || n;
  }

  // Semua kategori sesuai urutan yang disimpan, lalu kategori produk yang belum ada di urutan (A-Z).
  function daftar(urutan, produk) {
    const hasil = [];
    const tambah = (k) => {
      const n = rapikan(k);
      if (n && !hasil.some((x) => kunci(x) === kunci(n))) hasil.push(n);
    };
    (Array.isArray(urutan) ? urutan : []).forEach(tambah);
    const sisa = [];
    (produk || []).forEach((d) => {
      const n = rapikan(d && d.kategori);
      if (n && !hasil.some((x) => kunci(x) === kunci(n)) && !sisa.some((x) => kunci(x) === kunci(n))) sisa.push(n);
    });
    sisa.sort((a, b) => a.localeCompare(b, 'id'));
    return hasil.concat(sisa);
  }

  // Kategori produk ini (nama dari daftar), atau '' kalau tanpa kategori.
  function milik(d, list) {
    return cocokkan(list, d && d.kategori);
  }

  // Kelompokkan produk ({ id, data }) per kategori sesuai urutan. Kategori kosong dilewati;
  // produk tanpa kategori di akhir dengan nama ''.
  function kelompok(produk, urutan) {
    const list = daftar(urutan, produk.map((p) => p.data));
    const grup = list.map((nama) => ({ nama, items: [] }));
    const lain = { nama: '', items: [] };
    produk.forEach((p) => {
      const k = milik(p.data, list);
      (k ? grup.find((g) => g.nama === k) : lain).items.push(p);
    });
    return grup.concat([lain]).filter((g) => g.items.length);
  }

  // Hasil halaman "Atur kategori". baris = [{ lama, baru }] sesuai urutan di layar;
  // lama kosong = kategori baru, baru kosong = dihapus.
  // Mengembalikan urutan baru dan peta { lamaKey: namaBaru | '' } untuk kategori yang berubah.
  function atur(lamaList, baris) {
    const urutan = [];
    const peta = {};
    baris.forEach((b) => {
      const baru = rapikan(b.baru);
      const sama = baru && urutan.find((x) => kunci(x) === kunci(baru));
      if (baru && !sama) urutan.push(baru);
      const tujuan = baru ? (sama || baru) : '';
      if (b.lama && tujuan !== rapikan(b.lama)) peta[kunci(b.lama)] = tujuan;
    });
    // Kategori lama yang barisnya hilang juga dianggap dihapus.
    lamaList.forEach((k) => {
      if (!baris.some((b) => kunci(b.lama) === kunci(k))) peta[kunci(k)] = '';
    });
    return { urutan, peta };
  }

  // Kategori baru untuk produk setelah diatur, atau null kalau tidak berubah.
  function kategoriBaru(d, peta) {
    const k = kunci(d && d.kategori);
    return k && Object.prototype.hasOwnProperty.call(peta, k) ? peta[k] : null;
  }

  const api = { MAKS, rapikan, cocokkan, daftar, milik, kelompok, atur, kategoriBaru };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaKategori = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
