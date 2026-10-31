// Masuk dengan Face ID / sidik jari (passkey WebAuthn) di perangkat ini.
// Ini pengganti mengetik kata sandi di layar awal dan saat pindah akun: sesi Supabase tetap
// tersimpan di HP seperti biasa, dan Face ID hanya membuktikan bahwa pemilik HP yang membuka.
// Data wajah atau sidik jari tidak pernah keluar dari HP; Kelola hanya menyimpan id kuncinya.
(function (root) {
  'use strict';

  // { [userId]: { id, email, dibuat, sesi? } }. `sesi` = sesi Supabase akun itu yang disimpan saat
  // pindah ke akun lain, supaya bisa kembali ke akun itu dengan Face ID tanpa kata sandi.
  const KEY = 'kelola:faceid';

  function keB64(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function dariB64(teks) {
    const s = atob(teks.replace(/-/g, '+').replace(/_/g, '/'));
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  function baca(storage) {
    try {
      const d = JSON.parse(storage.getItem(KEY) || '{}');
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch (e) {
      return {};
    }
  }

  function tulis(storage, d) {
    try {
      if (Object.keys(d).length) storage.setItem(KEY, JSON.stringify(d));
      else storage.removeItem(KEY);
    } catch (e) { /* penyimpanan penuh */ }
  }

  // Kunci Face ID akun ini di HP ini, atau null.
  function untuk(storage, userId) {
    const k = userId ? baca(storage)[userId] : null;
    return k && typeof k.id === 'string' ? k : null;
  }

  function catat(storage, userId, kunci) {
    const d = baca(storage);
    d[userId] = kunci;
    tulis(storage, d);
  }

  // Simpan (atau hapus, kalau sesi null) sesi Supabase akun yang sedang ditinggalkan.
  function simpanSesi(storage, userId, sesi) {
    const k = untuk(storage, userId);
    if (!k) return;
    const baru = Object.assign({}, k);
    if (sesi && sesi.refresh_token) baru.sesi = { access_token: sesi.access_token, refresh_token: sesi.refresh_token };
    else delete baru.sesi;
    catat(storage, userId, baru);
  }

  function hapus(storage, userId) {
    const d = baca(storage);
    delete d[userId];
    tulis(storage, d);
  }

  // Byte ke-33 authenticatorData berisi tanda: 0x01 = HP disentuh, 0x04 = wajah/sidik jari/PIN HP dicek.
  function terverifikasi(authData) {
    const b = new Uint8Array(authData);
    return b.length > 32 && (b[32] & 0x05) === 0x05;
  }

  const acak = () => crypto.getRandomValues(new Uint8Array(32));

  // HP dan browser ini punya Face ID, sidik jari, atau kunci layar yang bisa dipakai aplikasi web.
  async function bisa() {
    try {
      return !!(root.PublicKeyCredential && navigator.credentials && root.isSecureContext
        && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch (e) {
      return false;
    }
  }

  // Buat kunci baru di HP ini. HP akan meminta wajah/sidik jari.
  async function daftar(user, namaUsaha) {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: acak(),
        rp: { name: namaUsaha ? 'Kelola · ' + namaUsaha : 'Kelola' },
        user: { id: new TextEncoder().encode(user.id), name: user.email, displayName: user.email },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000,
        attestation: 'none',
      },
    });
    return { id: keB64(cred.rawId), email: user.email.toLowerCase(), dibuat: new Date().toISOString() };
  }

  // Minta wajah/sidik jari untuk kunci yang tersimpan. true kalau berhasil.
  async function cek(kunci) {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: acak(),
        allowCredentials: [{ type: 'public-key', id: dariB64(kunci.id) }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return !!cred && keB64(cred.rawId) === kunci.id && terverifikasi(cred.response.authenticatorData);
  }

  const api = { KEY, keB64, dariB64, untuk, catat, simpanSesi, hapus, terverifikasi, bisa, daftar, cek };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaFaceId = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
