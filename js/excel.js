// Membuat file Excel (.xlsx) laporan langsung di HP, tanpa server dan tanpa pustaka luar
// (bisa diuji dengan `node --test`). File .xlsx adalah arsip zip berisi beberapa file XML.
(function (root) {
  'use strict';

  const enc = new TextEncoder();

  // ---------- Zip (tanpa kompresi) ----------

  const TABEL_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = TABEL_CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // files: [{ nama, isi: Uint8Array }] -> Uint8Array
  function zip(files) {
    const bagian = [];
    const pusat = [];
    let posisi = 0;
    files.forEach((f) => {
      const nama = enc.encode(f.nama);
      const crc = crc32(f.isi);
      const lokal = new DataView(new ArrayBuffer(30));
      lokal.setUint32(0, 0x04034b50, true);
      lokal.setUint16(4, 20, true);
      lokal.setUint16(6, 0x0800, true); // nama file UTF-8
      lokal.setUint16(8, 0, true); // tanpa kompresi
      lokal.setUint32(14, crc, true);
      lokal.setUint32(18, f.isi.length, true);
      lokal.setUint32(22, f.isi.length, true);
      lokal.setUint16(26, nama.length, true);
      bagian.push(new Uint8Array(lokal.buffer), nama, f.isi);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, f.isi.length, true);
      c.setUint32(24, f.isi.length, true);
      c.setUint16(28, nama.length, true);
      c.setUint32(42, posisi, true);
      pusat.push(new Uint8Array(c.buffer), nama);
      posisi += 30 + nama.length + f.isi.length;
    });
    const ukuranPusat = pusat.reduce((s, b) => s + b.length, 0);
    const akhir = new DataView(new ArrayBuffer(22));
    akhir.setUint32(0, 0x06054b50, true);
    akhir.setUint16(8, files.length, true);
    akhir.setUint16(10, files.length, true);
    akhir.setUint32(12, ukuranPusat, true);
    akhir.setUint32(16, posisi, true);
    const semua = bagian.concat(pusat, [new Uint8Array(akhir.buffer)]);
    const out = new Uint8Array(semua.reduce((s, b) => s + b.length, 0));
    let i = 0;
    semua.forEach((b) => { out.set(b, i); i += b.length; });
    return out;
  }

  // ---------- Lembar kerja ----------

  const x = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    // Karakter kontrol tidak boleh ada di XML.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

  function kolom(i) {
    let s = '';
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  // Tanggal/jam lokal -> angka tanggal Excel.
  function serial(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) / 864e5 + 25569;
  }

  // Nomor gaya (urutan <xf> di styles.xml).
  const S = {
    biasa: 0, kepala: 1, teks: 2, rp: 3, tanggal: 4, jam: 5, judul: 6, abu: 7, label: 8, nilaiRp: 9, nilaiAngka: 10,
    nilaiPersen: 11, teksBelum: 12, rpBelum: 13, tanggalBelum: 14, jamBelum: 15, labelSorot: 16, nilaiSorot: 17,
    hari: 18, angka: 19, totalRp: 20, totalAngka: 21,
  };

  const GAYA = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5"><numFmt numFmtId="164" formatCode="&quot;Rp&quot; #,##0;-&quot;Rp&quot; #,##0;&quot;-&quot;"/><numFmt numFmtId="165" formatCode="dd mmm yyyy"/><numFmt numFmtId="166" formatCode="hh:mm"/><numFmt numFmtId="167" formatCode="0.0%"/><numFmt numFmtId="168" formatCode="ddd dd mmm yyyy"/></numFmts>
<fonts count="6"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="16"/><color rgb="FF0A2A6E"/><name val="Arial"/></font><font><i/><sz val="10"/><color rgb="FF5B6785"/><name val="Arial"/></font><font><b/><sz val="12"/><color rgb="FF0A2A6E"/><name val="Arial"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0A2A6E"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFECB10"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFBEBD3"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD0D7E6"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="22">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="3" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="167" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="166" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="5" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  // Sel: angka, teks, null, atau { v, f (rumus, tanpa "="), s (gaya) }. Rumus selalu membawa
  // hasilnya (v), supaya penampil yang tidak menghitung rumus (preview di HP) tetap menampilkan angka.
  function sel(ref, c, gayaBaris) {
    if (c == null || c === '') return '';
    const o = typeof c === 'object' ? c : { v: c };
    const s = o.s != null ? o.s : gayaBaris;
    const sa = s ? ` s="${s}"` : '';
    if (o.f) return `<c r="${ref}"${sa}><f>${x(o.f)}</f><v>${Number(o.v) || 0}</v></c>`;
    if (typeof o.v === 'number') return `<c r="${ref}"${sa}><v>${o.v}</v></c>`;
    return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${x(o.v)}</t></is></c>`;
  }

  // lembar: { nama, lebar: [..], baris: [[sel]], beku: true, tanpaGaris: true, gambar: { rId } }
  function lembarXml(l) {
    const cols = l.lebar.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const rows = l.baris.map((r, i) => {
      if (!r) return '';
      const isi = r.map((c, j) => sel(kolom(j) + (i + 1), c)).join('');
      return isi ? `<row r="${i + 1}">${isi}</row>` : '';
    }).join('');
    const pane = l.beku ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"${l.tanpaGaris ? ' showGridLines="0"' : ''}${l.aktif ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${rows}</sheetData>
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>${l.gambar ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
  }

  function gambarXml(g) {
    const emu = (px) => Math.round(px * 9525);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<xdr:oneCellAnchor><xdr:from><xdr:col>${g.kolom}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${g.baris}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:ext cx="${emu(g.lebar)}" cy="${emu(g.tinggi)}"/>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="${x(g.nama)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(g.lebar)}" cy="${emu(g.tinggi)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>
<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;
  }

  // Nama lembar Excel: maks 31 karakter, tanpa []:*?/\
  const namaLembar = (s) => String(s).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);

  // lembar: [{ nama, lebar, baris, beku?, tanpaGaris?, gambar?: { png, lebar, tinggi, kolom, baris } }] -> Uint8Array
  function buatXlsx(lembar) {
    const f = [];
    const tulis = (nama, s) => f.push({ nama, isi: typeof s === 'string' ? enc.encode(s) : s });
    const adaGambar = lembar.some((l) => l.gambar);
    tulis('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${adaGambar ? '<Default Extension="png" ContentType="image/png"/>' : ''}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${lembar.map((l, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${l.gambar ? `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : ''}`).join('')}</Types>`);
    tulis('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    tulis('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${lembar.map((l, i) => `<sheet name="${x(namaLembar(l.nama))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
    tulis('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${lembar.map((l, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${lembar.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    tulis('xl/styles.xml', GAYA);
    lembar.forEach((l, i) => {
      tulis(`xl/worksheets/sheet${i + 1}.xml`, lembarXml(Object.assign({ aktif: i === 0 }, l)));
      if (!l.gambar) return;
      tulis(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${i + 1}.xml"/></Relationships>`);
      tulis(`xl/drawings/drawing${i + 1}.xml`, gambarXml(Object.assign({ nama: 'Chart' }, l.gambar)));
      tulis(`xl/drawings/_rels/drawing${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.png"/></Relationships>`);
      tulis(`xl/media/image${i + 1}.png`, l.gambar.png);
    });
    return zip(f);
  }

  // ---------- Laporan Kelola ----------

  // d: {
  //   namaUsaha, judul (mis. "Laporan penjualan, 24 Okt – 30 Okt 2026"), dibuat (teks),
  //   penjualan: [{ waktu (ms), barang, metode (teks), lunas (bool), omzet, laba, sisa }],
  //   pengeluaran: [{ waktu, kategori, catatan, jumlah }],
  //   terlaris: [{ nama, qty, omzet }],
  //   grafik: { png: Uint8Array, lebar, tinggi } | null,
  //   teks: { ringkasan, penjualan, pengeluaran, perHari, terlaris, tanggal, jam, barang, caraBayar, status, omzet,
  //           labaKotor, sisa, lunas, belumLunas, kategori, catatan, jumlah, transaksi, labaBersih, margin, produk,
  //           terjual, total, catatanLaba, catatanBersih, catatanGrafik }
  // }
  function laporan(d) {
    const T = d.teks;
    const q = (nama) => `'${namaLembar(nama).replace(/'/g, "''")}'`;
    const pj = d.penjualan.slice().sort((a, b) => a.waktu - b.waktu);
    const n = pj.length + 1;
    const hari = (ms) => { const t = new Date(ms); return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime(); };

    const penjualan = {
      nama: T.penjualan, lebar: [14, 8, 44, 12, 12, 15, 15, 15], beku: true,
      baris: [[T.tanggal, T.jam, T.barang, T.caraBayar, T.status, T.omzet, T.labaKotor, T.sisa].map((v) => ({ v, s: S.kepala }))]
        .concat(pj.map((p) => {
          const b = p.lunas === false;
          return [
            { v: Math.floor(serial(hari(p.waktu))), s: b ? S.tanggalBelum : S.tanggal },
            { v: serial(p.waktu) % 1, s: b ? S.jamBelum : S.jam },
            { v: p.barang, s: b ? S.teksBelum : S.teks },
            { v: p.metode, s: b ? S.teksBelum : S.teks },
            { v: p.lunas === false ? T.belumLunas : T.lunas, s: b ? S.teksBelum : S.teks },
            { v: p.omzet, s: b ? S.rpBelum : S.rp },
            { v: p.laba, s: b ? S.rpBelum : S.rp },
            { v: p.sisa || 0, s: b ? S.rpBelum : S.rp },
          ];
        })),
    };

    const kl = d.pengeluaran.slice().sort((a, b) => a.waktu - b.waktu);
    const m = kl.length + 1;
    const pengeluaran = {
      nama: T.pengeluaran, lebar: [14, 22, 32, 15], beku: true,
      baris: [[T.tanggal, T.kategori, T.catatan, T.jumlah].map((v) => ({ v, s: S.kepala }))]
        .concat(kl.map((k) => [{ v: Math.floor(serial(hari(k.waktu))), s: S.tanggal }, { v: k.kategori, s: S.teks }, { v: k.catatan || '', s: S.teks }, { v: k.jumlah, s: S.rp }])),
    };

    // Per hari: hanya hari yang ada penjualannya, dihitung dengan rumus dari lembar Penjualan.
    const perHari = new Map();
    pj.forEach((p) => {
      const h = hari(p.waktu);
      const r = perHari.get(h) || { n: 0, omzet: 0, laba: 0 };
      r.n += 1; r.omzet += p.omzet; r.laba += p.laba;
      perHari.set(h, r);
    });
    const hariList = [...perHari.entries()].sort((a, b) => a[0] - b[0]);
    const P = q(T.penjualan);
    const harian = {
      nama: T.perHari, lebar: [20, 13, 16, 16], beku: true,
      baris: [[T.tanggal, T.transaksi, T.omzet, T.labaKotor].map((v) => ({ v, s: S.kepala }))]
        .concat(hariList.map(([h, r], i) => {
          const b = i + 2;
          return [
            { v: Math.floor(serial(h)), s: S.hari },
            { v: r.n, f: `COUNTIFS(${P}!$A$2:$A$${n},A${b})`, s: S.angka },
            { v: r.omzet, f: `SUMIFS(${P}!$F$2:$F$${n},${P}!$A$2:$A$${n},A${b})`, s: S.rp },
            { v: r.laba, f: `SUMIFS(${P}!$G$2:$G$${n},${P}!$A$2:$A$${n},A${b})`, s: S.rp },
          ];
        })),
    };
    const akhirHari = hariList.length + 1;
    const total = (fn) => pj.reduce((s, p) => s + fn(p), 0);
    harian.baris.push([
      { v: T.total, s: S.label },
      { v: pj.length, f: `SUM(B2:B${akhirHari})`, s: S.totalAngka },
      { v: total((p) => p.omzet), f: `SUM(C2:C${akhirHari})`, s: S.totalRp },
      { v: total((p) => p.laba), f: `SUM(D2:D${akhirHari})`, s: S.totalRp },
    ]);

    const terlaris = {
      nama: T.terlaris, lebar: [28, 10, 16], beku: true,
      baris: [[T.produk, T.terjual, T.omzet].map((v) => ({ v, s: S.kepala }))]
        .concat(d.terlaris.map((p) => [{ v: p.nama, s: S.teks }, { v: p.qty, s: S.angka }, { v: p.omzet, s: S.rp }])),
    };

    // Ringkasan dengan rumus ke lembar lain, plus gambar grafik.
    const omzet = total((p) => p.omzet);
    const laba = total((p) => p.laba);
    const biaya = kl.reduce((s, k) => s + k.jumlah, 0);
    const K = q(T.pengeluaran);
    const ringkasan = {
      nama: T.ringkasan, lebar: [26, 20, 10, 10, 10, 10, 10], tanpaGaris: true,
      baris: [
        [{ v: d.namaUsaha, s: S.judul }],
        [{ v: d.judul, s: S.abu }],
        [{ v: d.dibuat, s: S.abu }],
        null,
        [{ v: T.omzet, s: S.labelSorot }, { v: omzet, f: `SUM(${P}!F2:F${n})`, s: S.nilaiSorot }],
        [{ v: T.labaKotor, s: S.teks }, { v: laba, f: `SUM(${P}!G2:G${n})`, s: S.nilaiRp }],
        [{ v: T.pengeluaran, s: S.teks }, { v: biaya, f: `SUM(${K}!D2:D${m})`, s: S.nilaiRp }],
        [{ v: T.labaBersih, s: S.label }, { v: laba - biaya, f: 'B6-B7', s: S.nilaiRp }],
        [{ v: T.transaksi, s: S.teks }, { v: pj.length, f: `COUNT(${P}!A2:A${n})`, s: S.nilaiAngka }],
        [{ v: T.margin, s: S.teks }, { v: omzet ? laba / omzet : 0, f: 'IF(B5=0,0,B6/B5)', s: S.nilaiPersen }],
        [{ v: T.tagihan || T.belumLunas, s: S.teks }, { v: total((p) => p.sisa || 0), f: `SUM(${P}!H2:H${n})`, s: S.nilaiRp }],
        null,
        [{ v: T.catatanLaba, s: S.abu }],
        [{ v: T.catatanBersih, s: S.abu }],
      ],
    };
    if (d.grafik) {
      ringkasan.gambar = Object.assign({ kolom: 0, baris: 15, nama: T.catatanGrafik }, d.grafik);
    }
    return buatXlsx([ringkasan, penjualan, pengeluaran, harian, terlaris]);
  }

  const api = { crc32, zip, buatXlsx, laporan, serial, kolom };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KelolaExcel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
