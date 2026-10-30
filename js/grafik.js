// Data grafik laporan: omzet dan laba per jam, hari, atau bulan (tanpa DOM, bisa diuji dengan `node --test`).
(function (root) {
  'use strict';

  // Satuan waktu yang cocok untuk rentang [dari, sampai) dalam milidetik.
  function pilihSatuan(dari, sampai) {
    const hari = (sampai - dari) / 864e5;
    if (hari <= 1.01) return 'jam';
    if (hari <= 62) return 'hari';
    return 'bulan';
  }

  function awal(waktu, satuan) {
    const d = new Date(waktu);
    if (satuan === 'jam') return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    if (satuan === 'hari') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }

  function berikut(waktu, satuan) {
    const d = new Date(waktu);
    if (satuan === 'jam') return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    if (satuan === 'hari') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  }

  // trx: [{ waktu, total, laba }] yang sudah tersaring ke periode.
  // dari/sampai: batas periode (sampai boleh Infinity, dari boleh 0); sekarang: waktu saat ini.
  // Hasil: { satuan, kelompok: [{ mulai, omzet, laba, n }] } berurutan tanpa celah.
  function kelompokkan(trx, dari, sampai, sekarang) {
    const waktu = trx.map((t) => Date.parse(t.waktu));
    const mulai = dari > 0 ? dari : waktu.length ? Math.min(...waktu) : sekarang;
    const akhir = Math.min(sampai, sekarang + 1);
    const satuan = pilihSatuan(mulai, akhir);
    let a = awal(mulai, satuan);
    let z = awal(Math.max(mulai, akhir - 1), satuan);
    if (satuan === 'jam') {
      // Hari ini: tampilkan jam buka yang wajar, diperluas kalau ada penjualan di luar itu.
      const jam = waktu.map((w) => new Date(w).getHours());
      const hari = new Date(mulai);
      const pada = (h) => new Date(hari.getFullYear(), hari.getMonth(), hari.getDate(), h).getTime();
      a = pada(Math.min(6, ...jam));
      z = pada(Math.max(new Date(akhir - 1).getHours(), 18, ...jam));
      z = Math.min(z, pada(23));
    }
    const kelompok = [];
    const indeks = new Map();
    for (let w = a; w <= z && kelompok.length < 400; w = berikut(w, satuan)) {
      indeks.set(w, kelompok.length);
      kelompok.push({ mulai: w, omzet: 0, laba: 0, n: 0 });
    }
    trx.forEach((t, i) => {
      const k = kelompok[indeks.get(awal(waktu[i], satuan))];
      if (!k) return;
      k.omzet += t.total || 0;
      k.laba += t.laba || 0;
      k.n += 1;
    });
    return { satuan, kelompok };
  }

  // Batas atas sumbu yang bulat (1, 2, 2,5, 5 × 10^n) dan jarak garis bantunya.
  function skala(maks) {
    if (!(maks > 0)) return { atas: 1000, langkah: 500 };
    const p = Math.pow(10, Math.floor(Math.log10(maks)));
    const langkah = [0.2, 0.25, 0.5, 1, 2, 2.5, 5].map((m) => m * p).find((l) => l * 4 >= maks) || 10 * p;
    return { atas: Math.ceil(maks / langkah) * langkah, langkah };
  }

  // Angka pendek untuk sumbu: 1.500 -> "1,5rb", 2.000.000 -> "2jt".
  function ringkas(n) {
    const f = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
    if (Math.abs(n) >= 1e9) return f(n / 1e9) + 'M';
    if (Math.abs(n) >= 1e6) return f(n / 1e6) + 'jt';
    if (Math.abs(n) >= 1e3) return f(n / 1e3) + 'rb';
    return String(Math.round(n));
  }

  // Periode pembanding dengan panjang yang sama, sampai jam yang sama (supaya adil saat hari/bulan belum selesai).
  // periode: 'hari' | '7hari' | 'bulan' | 'pilih' | 'semua'. Hasil [dari, sampai) atau null.
  function periodeLalu(periode, dari, sampai, sekarang) {
    if (periode === 'semua' || !(dari > 0)) return null;
    const geser = (w, hari) => { const d = new Date(w); d.setDate(d.getDate() - hari); return d.getTime(); };
    const akhir = Math.min(sampai, sekarang);
    if (periode === 'hari') return [geser(dari, 1), geser(akhir, 1)];
    if (periode === '7hari') return [geser(dari, 7), geser(akhir, 7)];
    if (periode === 'bulan') {
      const d = new Date(dari);
      const a = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
      return [a, Math.min(a + (akhir - dari), dari)];
    }
    return [dari - (sampai - dari), dari];
  }

  // Naik/turun dibanding periode lalu. persen null kalau periode lalu kosong.
  function perubahan(kini, lalu) {
    if (!kini && !lalu) return null;
    if (!lalu) return { arah: 'naik', persen: null };
    const persen = Math.round(((kini - lalu) / Math.abs(lalu)) * 100);
    return { arah: persen > 0 ? 'naik' : persen < 0 ? 'turun' : 'sama', persen: Math.abs(persen) };
  }

  // Jam paling ramai (jumlah transaksi terbanyak; seri dimenangkan omzet). Hasil jam 0–23 atau null.
  function jamRamai(trx) {
    const jam = new Map();
    trx.forEach((t) => {
      const h = new Date(t.waktu).getHours();
      const j = jam.get(h) || { n: 0, omzet: 0 };
      j.n += 1; j.omzet += t.total || 0;
      jam.set(h, j);
    });
    let terbaik = null;
    jam.forEach((j, h) => { if (!terbaik || j.n > terbaik.n || (j.n === terbaik.n && j.omzet > terbaik.omzet)) terbaik = { jam: h, n: j.n, omzet: j.omzet }; });
    return terbaik;
  }

  const api = { pilihSatuan, kelompokkan, skala, ringkas, periodeLalu, perubahan, jamRamai };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaGrafik = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
