// Warna aplikasi dari logo usaha (tanpa DOM, bisa diuji dengan `node --test`).
// - paletLogo(): ambil warna-warna utama dari piksel logo
// - tema(): ubah satu warna utama (+ warna aksen) jadi variabel CSS untuk tampilan terang dan gelap
(function (root) {
  'use strict';

  const hexKeRgb = (hex) => {
    const h = String(hex).replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const rgbKeHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

  function rgbKeHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }

  function hslKeRgb([h, s, l]) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }

  const hsl = (h, s, l) => rgbKeHex(hslKeRgb([h, s, l]));

  // Luminans relatif (WCAG), 0 = hitam, 1 = putih.
  function luminans(hex) {
    const c = hexKeRgb(hex).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function kontras(a, b) {
    const [x, y] = [luminans(a), luminans(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }

  // Gelapkan warna sampai teks putih di atasnya mudah dibaca.
  function cukupGelap(hex) {
    let [h, s, l] = rgbKeHsl(hexKeRgb(hex));
    let out = hex;
    while (kontras(out, '#ffffff') < 4.5 && l > 0.05) { l -= 0.03; out = hsl(h, s, l); }
    return out;
  }

  // Warna-warna di logo, dari yang paling banyak. `piksel` = data RGBA (mis. dari canvas).
  // Putih, abu-abu (termasuk kotak-kotak latar transparan), dan piksel transparan diabaikan.
  function paletLogo(piksel) {
    const ember = new Map();
    for (let i = 0; i < piksel.length; i += 4) {
      if (piksel[i + 3] < 128) continue;
      const rgb = [piksel[i], piksel[i + 1], piksel[i + 2]];
      const [, s, l] = rgbKeHsl(rgb);
      if (l > 0.97 || (s < 0.12 && l > 0.15)) continue;
      const k = rgb.map((v) => v >> 4).join(',');
      const e = ember.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n += 1; e.r += rgb[0]; e.g += rgb[1]; e.b += rgb[2];
      ember.set(k, e);
    }
    const urut = [...ember.values()].sort((a, b) => b.n - a.n)
      .map((e) => ({ hex: rgbKeHex([e.r / e.n, e.g / e.n, e.b / e.n]), n: e.n }));
    // Gabungkan warna yang mirip supaya pilihannya tidak kembar.
    const hasil = [];
    urut.forEach((c) => {
      const mirip = hasil.find((h) => {
        const [a, b] = [hexKeRgb(h.hex), hexKeRgb(c.hex)];
        return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 60;
      });
      if (mirip) mirip.n += c.n;
      else hasil.push(c);
    });
    const total = hasil.reduce((s, c) => s + c.n, 0) || 1;
    return hasil.filter((c) => c.n / total >= 0.01).sort((a, b) => b.n - a.n).slice(0, 5).map((c) => c.hex);
  }

  // Warna utama: yang paling banyak dan cukup gelap/berwarna. Aksen: warna terang yang kontras dengannya.
  function pilihWarna(palet) {
    const gelap = palet.filter((h) => luminans(h) < 0.45);
    const utama = gelap[0] || palet[0] || null;
    if (!utama) return null;
    const aksen = palet.find((h) => h !== utama && luminans(h) > 0.45 && kontras(h, cukupGelap(utama)) >= 3) || null;
    return { utama, aksen };
  }

  // Variabel CSS untuk tampilan terang dan gelap dari warna usaha.
  function tema(warna) {
    const utama = cukupGelap(warna.utama);
    const [h, s] = rgbKeHsl(hexKeRgb(utama));
    const st = Math.min(s, 0.3);
    const aksen = warna.aksen && kontras(warna.aksen, utama) >= 3 ? warna.aksen : hsl(h, Math.max(s, 0.5), 0.86);
    const [r, g, b] = hexKeRgb(utama);
    return {
      terang: {
        '--navy': utama, '--yellow': aksen,
        '--bg': hsl(h, st, 0.96), '--cell': hsl(h, st, 0.96), '--well': hsl(h, st, 0.925),
        '--raise-l': '#ffffff', '--raise-d': hsl(h, st, 0.83),
        '--fg': hsl(h, 0.4, 0.13), '--muted': hsl(h, 0.15, 0.4), '--faint': hsl(h, 0.12, 0.6),
        '--sep': `rgba(${r}, ${g}, ${b}, .1)`,
        '--primary': utama, '--on-primary': '#ffffff', '--accent-text': utama,
        '--tanda': utama,
        '--grafik-1': hsl(h, Math.max(s, 0.45), 0.4), '--grafik-2': hsl(h, Math.max(s, 0.45), 0.68),
      },
      gelap: {
        '--navy': utama, '--yellow': aksen,
        '--bg': hsl(h, Math.min(s, 0.45), 0.15), '--cell': hsl(h, Math.min(s, 0.45), 0.15), '--well': hsl(h, Math.min(s, 0.45), 0.11),
        '--raise-l': hsl(h, Math.min(s, 0.4), 0.21), '--raise-d': hsl(h, Math.min(s, 0.5), 0.08),
        '--fg': '#f7f5f2', '--muted': hsl(h, 0.2, 0.75), '--faint': hsl(h, 0.15, 0.6),
        '--sep': 'rgba(255, 255, 255, .08)',
        '--primary': aksen, '--on-primary': utama, '--accent-text': aksen,
        '--tanda': aksen,
        '--grafik-1': hsl(h, Math.max(s, 0.45), 0.66), '--grafik-2': hsl(h, Math.max(s, 0.35), 0.42),
      },
    };
  }

  // Membersihkan pinggiran putih/transparan logo (data RGBA, diubah langsung).
  // Piksel putih atau transparan yang tersambung ke tepi gambar dibuat transparan,
  // lalu warna latar diambil dari piksel logo yang berbatasan dengannya.
  // Kalau bagian itu besar (logo memang berlatar putih), logo tidak diubah.
  // Hasil: warna latar '#rrggbb', atau null kalau sebaiknya putih.
  function bersihkanTepi(data, w, h) {
    const n = w * h;
    const latar = (i) => {
      const o = i * 4;
      if (data[o + 3] < 128) return true;
      const mn = Math.min(data[o], data[o + 1], data[o + 2]);
      const mx = Math.max(data[o], data[o + 1], data[o + 2]);
      return mn >= 225 && mx - mn < 30;
    };
    const buang = new Uint8Array(n);
    const antre = [];
    const coba = (x, y) => {
      const i = y * w + x;
      if (!buang[i] && latar(i)) { buang[i] = 1; antre.push(i); }
    };
    for (let x = 0; x < w; x++) { coba(x, 0); coba(x, h - 1); }
    for (let y = 0; y < h; y++) { coba(0, y); coba(w - 1, y); }
    for (let k = 0; k < antre.length; k++) {
      const i = antre[k];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) coba(x - 1, y);
      if (x < w - 1) coba(x + 1, y);
      if (y > 0) coba(x, y - 1);
      if (y < h - 1) coba(x, y + 1);
    }
    const tetangga = (i, f) => {
      const x = i % w;
      if (x > 0) f(i - 1);
      if (x < w - 1) f(i + 1);
      if (i >= w) f(i - w);
      if (i < n - w) f(i + w);
    };
    if (!antre.length) {
      // Tidak ada pinggiran putih: warna latar = rata-rata piksel tepi.
      let r = 0, g = 0, b = 0, k = 0;
      for (let i = 0; i < n; i++) {
        const x = i % w;
        if (x !== 0 && x !== w - 1 && i >= w && i < n - w) continue;
        r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2]; k++;
      }
      return rgbKeHex([r / k, g / k, b / k]);
    }
    if (antre.length > n * 0.35) return null;
    // Piksel peralihan yang masih terang di batasnya ikut dibuang (satu lapis).
    const peralihan = [];
    antre.forEach((i) => tetangga(i, (j) => {
      if (buang[j]) return;
      const o = j * 4;
      if (data[o + 3] < 200 || Math.min(data[o], data[o + 1], data[o + 2]) >= 160) peralihan.push(j);
    }));
    peralihan.forEach((j) => { buang[j] = 1; });
    let r = 0, g = 0, b = 0, k = 0;
    const dihitung = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (buang[i]) data[i * 4 + 3] = 0;
    for (let i = 0; i < n; i++) {
      if (!buang[i]) continue;
      tetangga(i, (j) => {
        if (buang[j] || dihitung[j]) return;
        dihitung[j] = 1;
        r += data[j * 4]; g += data[j * 4 + 1]; b += data[j * 4 + 2]; k++;
      });
    }
    return k ? rgbKeHex([r / k, g / k, b / k]) : null;
  }

  const api = { paletLogo, pilihWarna, tema, kontras, luminans, cukupGelap, bersihkanTepi };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaWarna = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
