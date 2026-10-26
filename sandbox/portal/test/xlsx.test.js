import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, xlsxBytes, XLSX_MIME } from '../xlsx.js';

// Local file headers, read by hand: signature, method, CRC, sizes, name, then the data.
function parts(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  let o = 0;
  while (dv.getUint32(o, true) === 0x04034b50) {
    const method = dv.getUint16(o + 8, true);
    const crc = dv.getUint32(o + 14, true);
    const csize = dv.getUint32(o + 18, true);
    const usize = dv.getUint32(o + 22, true);
    const nlen = dv.getUint16(o + 26, true);
    const xlen = dv.getUint16(o + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + nlen));
    const data = bytes.subarray(o + 30 + nlen + xlen, o + 30 + nlen + xlen + csize);
    assert.equal(method, 0, name);
    assert.equal(csize, usize, name);
    assert.equal(crc, crc32(data), name);
    out[name] = new TextDecoder().decode(data);
    o += 30 + nlen + xlen + csize;
  }
  return { out, endOffset: o };
}

test('crc32 matches known vectors', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('the workbook is a valid zip with the expected parts', () => {
  const bytes = xlsxBytes([['Doc & Co', 'Amount <EUR>'], ['1900000201', 1234.56], ['x', -5]], 'Line items');
  const { out, endOffset } = parts(bytes);
  assert.deepEqual(Object.keys(out).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  assert.match(out['xl/sharedStrings.xml'], /Doc &amp; Co/);
  assert.match(out['xl/sharedStrings.xml'], /Amount &lt;EUR&gt;/);
  assert.match(out['xl/workbook.xml'], /name="Line items"/);
  const sheet = out['xl/worksheets/sheet1.xml'];
  assert.equal((sheet.match(/<row[ >]/g) || []).length, 3);
  assert.match(sheet, /<v>1234\.56<\/v>/);
  assert.doesNotMatch(sheet, /<c [^>]*t="[^s"]*"[^>]*><v>1234/);
  assert.doesNotMatch(sheet.match(/<c [^>]*><v>1234\.56/)[0], /t=/);
  // central directory (one entry per part) then the end record
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(endOffset, true), 0x02014b50);
  const end = bytes.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50);
  assert.equal(dv.getUint16(end + 10, true), 6);
  assert.equal(dv.getUint32(end + 16, true), endOffset);
  assert.equal(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('an empty result is a header-only sheet', () => {
  const { out } = parts(xlsxBytes([['Document', 'Amount']]));
  assert.equal((out['xl/worksheets/sheet1.xml'].match(/<row[ >]/g) || []).length, 1);
  assert.match(out['xl/sharedStrings.xml'], /Document/);
});
