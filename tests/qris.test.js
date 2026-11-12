// Jalankan: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../js/qris.js');

const tlv = (tag, nilai) => tag + String(nilai.length).padStart(2, '0') + nilai;
// QRIS statis tiruan dengan susunan seperti QRIS toko sungguhan.
function qrisStatis() {
  const badan = tlv('00', '01') + tlv('01', '11')
    + tlv('26', tlv('00', 'ID.CO.CONTOH.WWW') + tlv('01', '936000000000000001') + tlv('02', '000000000000001') + tlv('03', 'UMI'))
    + tlv('51', tlv('00', 'ID.CO.QRIS.WWW') + tlv('02', 'ID1020000000001') + tlv('03', 'UMI'))
    + tlv('52', '5812') + tlv('53', '360') + tlv('58', 'ID') + tlv('59', 'KOPI SENJA') + tlv('60', 'JAKARTA') + tlv('61', '10110')
    + tlv('62', tlv('07', 'A01')) + '6304';
  return badan + Q.crc16(badan);
}

test('CRC-16/CCITT-FALSE', () => {
  assert.equal(Q.crc16('123456789'), '29B1');
  assert.equal(Q.crc16(''), 'FFFF');
});

test('kode QRIS diurai dan diperiksa', () => {
  const k = qrisStatis();
  assert.equal(Q.sah(k), true);
  assert.equal(Q.sah(k.replace('KOPI SENJA', 'KOPI SENJI')), false, 'isi berubah, CRC tidak cocok');
  assert.equal(Q.sah('https://contoh.id/menu'), false);
  assert.equal(Q.sah(''), false);
  assert.equal(Q.namaMerchant(k), 'KOPI SENJA');
  assert.equal(Q.ambil(k, '53'), '360');
  assert.equal(Q.urai('0002'), null);
});

test('nominal disisipkan: jadi dinamis, tag berurutan, CRC baru cocok', () => {
  const k = qrisStatis();
  const d = Q.denganNominal(k, 46800);
  assert.equal(Q.sah(d), true);
  assert.equal(Q.ambil(d, '01'), '12');
  assert.equal(Q.ambil(d, '54'), '46800');
  assert.deepEqual(Q.urai(d).map((b) => b.tag), ['00', '01', '26', '51', '52', '53', '54', '58', '59', '60', '61', '62', '63']);
  // Bagian lain tidak berubah.
  ['26', '51', '52', '53', '58', '59', '60', '61', '62'].forEach((t) => assert.equal(Q.ambil(d, t), Q.ambil(k, t)));
  // Nominal dibulatkan ke rupiah; mengisi ulang mengganti nominal lama.
  assert.equal(Q.ambil(Q.denganNominal(k, 1500.4), '54'), '1500');
  const lagi = Q.denganNominal(d, 9000);
  assert.equal(Q.ambil(lagi, '54'), '9000');
  assert.equal(Q.urai(lagi).filter((b) => b.tag === '54').length, 1);
});

test('kode tidak sah atau nominal nol tidak menghasilkan apa-apa', () => {
  assert.equal(Q.denganNominal('bukan qris', 5000), '');
  assert.equal(Q.denganNominal(qrisStatis(), 0), '');
  assert.equal(Q.denganNominal(qrisStatis(), -5), '');
  assert.equal(Q.denganNominal(qrisStatis(), 'abc'), '');
});
