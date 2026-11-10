// Jatuh tempo dan pengingat tagihan "bayar nanti" (tanpa DOM).
// Tanggal jatuh tempo disimpan sebagai teks 'YYYY-MM-DD' (tanggal lokal) di
// transaksi.data.jatuhTempo. Pengaturan ada di profil.data.tagihan.
(function (root) {
  'use strict';

  const PILIHAN_TEMPO = [0, 3, 7, 14, 30]; // hari; 0 = tanpa jatuh tempo
  const PILIHAN_MULAI = [0, 1, 3]; // mulai diingatkan H-0, H-1, atau H-3
  const BAWAAN = { jatuhTempo: 7, ingatkan: true, mulai: 1 };

  const dua = (n) => String(n).padStart(2, '0');

  // Tanggal lokal perangkat sebagai 'YYYY-MM-DD'.
  function tanggalLokal(d) {
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${dua(x.getMonth() + 1)}-${dua(x.getDate())}`;
  }

  const utc = (ymd) => Date.parse(ymd + 'T00:00:00Z');

  function tambahHari(ymd, n) {
    return new Date(utc(ymd) + n * 864e5).toISOString().slice(0, 10);
  }

  // Jumlah hari dari `dari` ke `ke` (negatif kalau `ke` sudah lewat).
  function selisihHari(dari, ke) {
    return Math.round((utc(ke) - utc(dari)) / 864e5);
  }

  const tanggalSah = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s));

  // Pengaturan tagihan dari profil, dengan nilai bawaan untuk data lama.
  function pengaturan(profil) {
    const p = (profil && profil.tagihan) || {};
    return {
      jatuhTempo: PILIHAN_TEMPO.includes(p.jatuhTempo) ? p.jatuhTempo : BAWAAN.jatuhTempo,
      ingatkan: p.ingatkan !== false,
      mulai: PILIHAN_MULAI.includes(p.mulai) ? p.mulai : BAWAAN.mulai,
    };
  }

  // Jatuh tempo untuk penjualan baru: tanggal beli + `hari`. 0 hari = tanpa jatuh tempo.
  function jatuhTempoBaru(waktu, hari) {
    return hari > 0 ? tambahHari(tanggalLokal(waktu), hari) : null;
  }

  // Urutan daftar tagihan: yang punya jatuh tempo paling dekat di atas,
  // lalu tagihan tanpa jatuh tempo (data lama) dari yang paling lama.
  function urutkan(list) {
    return list.slice().sort((a, b) => {
      const ja = tanggalSah(a.data.jatuhTempo) ? a.data.jatuhTempo : null;
      const jb = tanggalSah(b.data.jatuhTempo) ? b.data.jatuhTempo : null;
      if (ja && jb && ja !== jb) return ja < jb ? -1 : 1;
      if (ja && !jb) return -1;
      if (!ja && jb) return 1;
      return String(a.data.waktu).localeCompare(String(b.data.waktu));
    });
  }

  // Tagihan yang perlu diingatkan hari ini.
  // list: tagihan yang belum lunas [{ id, data }], sisa(data) = sisa tagihan.
  // Hasil: { lewat, segera } — lewat = sudah lewat jatuh tempo,
  // segera = jatuh tempo hari ini sampai `mulai` hari lagi.
  function pengingat(list, hariIni, mulai, sisa) {
    const lewat = [];
    const segera = [];
    list.forEach((r) => {
      const jt = r.data.jatuhTempo;
      if (!tanggalSah(jt) || !(sisa(r.data) > 0)) return;
      const n = selisihHari(hariIni, jt);
      if (n < 0) lewat.push(r);
      else if (n <= mulai) segera.push(r);
    });
    const total = (a) => a.reduce((s, r) => s + sisa(r.data), 0);
    return { lewat: urutkan(lewat), segera: urutkan(segera), totalLewat: total(lewat), totalSegera: total(segera) };
  }

  // Nomor rekening tanpa spasi, titik, atau strip, supaya bisa langsung ditempel di m-banking.
  const nomorPolos = (s) => String(s || '').replace(/\D/g, '');

  // Daftar rekening dari profil yang isinya lengkap.
  function daftarRekening(profil) {
    return ((profil && profil.rekening) || []).filter((r) => r && nomorPolos(r.nomor));
  }

  const api = { PILIHAN_TEMPO, PILIHAN_MULAI, tanggalLokal, tambahHari, selisihHari, tanggalSah, pengaturan, jatuhTempoBaru, urutkan, pengingat, nomorPolos, daftarRekening };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaTagihan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
