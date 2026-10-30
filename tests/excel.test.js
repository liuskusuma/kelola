// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const X = require('../js/excel.js');

// Baca isi zip (tanpa kompresi) supaya bisa dicek isinya.
function bacaZip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const isi = {};
  let i = 0;
  while (v.getUint32(i, true) === 0x04034b50) {
    const crc = v.getUint32(i + 14, true);
    const ukuran = v.getUint32(i + 18, true);
    const pNama = v.getUint16(i + 26, true);
    const nama = Buffer.from(buf.subarray(i + 30, i + 30 + pNama)).toString('utf8');
    const data = buf.subarray(i + 30 + pNama, i + 30 + pNama + ukuran);
    assert.equal(X.crc32(data), crc, 'CRC ' + nama);
    isi[nama] = Buffer.from(data).toString('utf8');
    i += 30 + pNama + ukuran;
  }
  return isi;
}

const TEKS = {
  ringkasan: 'Summary', penjualan: 'Sales', pengeluaran: 'Expenses', perHari: 'Per day', terlaris: 'Best sellers',
  tanggal: 'Date', jam: 'Time', barang: 'Items', caraBayar: 'Payment', status: 'Status', omzet: 'Revenue',
  labaKotor: 'Gross profit', sisa: 'Unpaid', lunas: 'Paid', belumLunas: 'Unpaid', kategori: 'Category',
  catatan: 'Note', jumlah: 'Amount', transaksi: 'Transactions', labaBersih: 'Net profit', margin: 'Margin',
  produk: 'Product', terjual: 'Sold', total: 'Total', catatanLaba: 'a', catatanBersih: 'b', catatanGrafik: 'Chart',
};

function contoh(grafik) {
  const t = (h, j) => new Date(2026, 9, h, j, 15).getTime();
  return X.laporan({
    namaUsaha: 'Warung <Bu Sri> & Co', judul: 'Report', dibuat: 'Made today',
    penjualan: [
      { waktu: t(24, 9), barang: 'Kopi ×2', metode: 'Cash', lunas: true, omzet: 10000, laba: 4000 },
      { waktu: t(24, 14), barang: 'Roti', metode: 'Pay later', lunas: false, omzet: 8000, laba: 3000, sisa: 8000 },
      { waktu: t(25, 10), barang: 'Teh', metode: 'QRIS', lunas: true, omzet: 5000, laba: 2000 },
    ],
    pengeluaran: [{ waktu: t(24, 8), kategori: 'Bahan', catatan: '', jumlah: 3000 }],
    terlaris: [{ nama: 'Kopi', qty: 2, omzet: 10000 }],
    grafik, teks: TEKS,
  });
}

test('kolom dan tanggal Excel', () => {
  assert.equal(X.kolom(0), 'A');
  assert.equal(X.kolom(25), 'Z');
  assert.equal(X.kolom(26), 'AA');
  assert.equal(X.serial(new Date(2026, 0, 1).getTime()), 46023);
  assert.equal(X.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('laporan Excel: lima lembar, rumus membawa hasil, teks aman', () => {
  const isi = bacaZip(contoh(null));
  assert.ok(isi['xl/workbook.xml'].includes('name="Per day"'));
  assert.equal(Object.keys(isi).filter((n) => n.startsWith('xl/worksheets/sheet')).length, 5);
  const r = isi['xl/worksheets/sheet1.xml'];
  assert.ok(r.includes('Warung &lt;Bu Sri&gt; &amp; Co'));
  assert.ok(r.includes("<f>SUM('Sales'!F2:F4)</f><v>23000</v>"));
  assert.ok(r.includes("<f>SUM('Sales'!H2:H4)</f><v>8000</v>"));
  assert.ok(r.includes('<f>B6-B7</f><v>6000</v>'));
  // Baris belum lunas diberi warna (gaya 12-15).
  assert.ok(isi['xl/worksheets/sheet2.xml'].includes('s="12" t="inlineStr"><is><t xml:space="preserve">Roti'));
  // Per hari: 2 hari + baris total.
  assert.ok(isi['xl/worksheets/sheet4.xml'].includes('<f>SUM(C2:C3)</f><v>23000</v>'));
  assert.ok(!isi['xl/media/image1.png']);
});

test('laporan Excel dengan gambar grafik', () => {
  const png = new Uint8Array(zlib.gzipSync('x')); // isi gambar tidak dicek di sini
  const buf = contoh({ png, lebar: 600, tinggi: 300 });
  const isi = bacaZip(buf);
  assert.ok(isi['xl/media/image1.png']);
  assert.ok(isi['xl/worksheets/sheet1.xml'].includes('<drawing r:id="rId1"/>'));
  assert.ok(isi['[Content_Types].xml'].includes('image/png'));
  if (process.env.KELOLA_XLSX) fs.writeFileSync(process.env.KELOLA_XLSX, buf);
});
