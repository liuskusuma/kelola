// Akun staff dan mode kasir. Tabel dan fungsinya ada di supabase/staff.sql.
// - Adaptor Supabase untuk owner (undangan, daftar staff, ambil penjualan staff)
//   dan untuk staff (gabung, ambil produk tanpa modal, kirim penjualan).
// - Data kasir staff disimpan di perangkat supaya tetap bisa berjualan tanpa internet.
(function (root) {
  'use strict';

  const KEY = 'kelola:staff';

  // Huruf dan angka yang tidak mudah tertukar (tanpa O/0, I/1).
  const HURUF = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function kodeAcak(panjang) {
    const acak = new Uint32Array(panjang || 6);
    root.crypto.getRandomValues(acak);
    return Array.from(acak, (n) => HURUF[n % HURUF.length]).join('');
  }

  // Tabel staff belum dibuat (supabase/staff.sql belum dijalankan).
  function belumDisiapkan(error) {
    const m = String((error && (error.message || error.code)) || '');
    return /PGRST20[25]|42P01|42883|does not exist|Could not find/i.test(m);
  }

  function supabaseStaff(client) {
    const cek = ({ data, error }) => {
      if (error) throw error;
      return data;
    };
    return {
      async peran(userId) {
        const rows = cek(await client.from('staff').select('owner_id, nama').eq('staff_id', userId).limit(1));
        return rows[0] || null;
      },
      async gabung(kode, nama) {
        return cek(await client.rpc('gabung_staff', { kode_undangan: kode, nama_staff: nama }));
      },
      async produkKasir() {
        return cek(await client.rpc('produk_kasir'));
      },
      async kirim(ownerId, jualan) {
        const rows = jualan.map((j) => ({ id: j.id, owner_id: ownerId, data: j }));
        cek(await client.from('penjualan_staff').upsert(rows, { onConflict: 'id', ignoreDuplicates: true }));
      },
      async daftarStaff(ownerId) {
        return cek(await client.from('staff').select('staff_id, nama, created_at').eq('owner_id', ownerId).order('created_at'));
      },
      async hapusStaff(staffId) {
        cek(await client.from('staff').delete().eq('staff_id', staffId));
      },
      async buatUndangan() {
        const kode = kodeAcak(6);
        cek(await client.from('undangan_staff').insert({ kode }));
        return kode;
      },
      // Tandai diproses dan ambil sekaligus, supaya dua HP owner tidak memotong stok dua kali.
      async ambilPenjualan(ownerId) {
        return cek(await client.from('penjualan_staff').update({ diproses: true })
          .eq('owner_id', ownerId).eq('diproses', false).select('id, staff_id, data, created_at'));
      },
    };
  }

  // Data kasir staff di perangkat: produk dari owner, antrian penjualan yang
  // belum terkirim, dan penjualan hari ini (untuk struk dan ringkasan).
  function bacaKasir(storage, userId) {
    try {
      const s = JSON.parse(storage.getItem(KEY) || 'null');
      if (s && s.userId === userId) return s;
    } catch (e) { /* data rusak */ }
    return { userId, ownerId: null, nama: '', usaha: {}, produk: [], antrian: [], jualan: [] };
  }

  function simpanKasir(storage, s) {
    storage.setItem(KEY, JSON.stringify(s));
  }

  function hapusKasir(storage) {
    storage.removeItem(KEY);
  }

  // Simpan penjualan staff di perangkat dan kurangi stok yang tampil.
  function catatJualanStaff(s, H, jual) {
    const cari = (id) => s.produk.find((p) => p.id === id) || null;
    const cart = {};
    jual.items.forEach((i) => { cart[i.produkId] = (cart[i.produkId] || 0) + i.qty; });
    const potong = H.potonganKeranjang(cart, cari);
    Object.entries(potong.produk).forEach(([id, n]) => {
      const p = cari(id);
      if (p && p.stok != null) p.stok -= n;
    });
    s.antrian.push(jual);
    s.jualan.push(jual);
    // Simpan riwayat 3 hari terakhir saja.
    const batas = Date.now() - 3 * 864e5;
    s.jualan = s.jualan.filter((j) => Date.parse(j.waktu) >= batas);
  }

  // PIN mode kasir disimpan sebagai hash, bukan angka aslinya.
  async function hashPin(pin, garam) {
    const data = new TextEncoder().encode(`kelola:${garam}:${pin}`);
    const hasil = await root.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hasil), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const api = { KEY, kodeAcak, belumDisiapkan, supabaseStaff, bacaKasir, simpanKasir, hapusKasir, catatJualanStaff, hashPin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaStaff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
