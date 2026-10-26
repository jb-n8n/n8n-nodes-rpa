// A dependency-free XLSX writer: a ZIP of stored (uncompressed) entries plus CRC-32. Shipped to a browser page as source
// (the way fiori.js ships erp.js functions), so these functions use no imports and no Node globals: only TextEncoder,
// Uint8Array and DataView. Dependencies between them are by name only (xlsxBytes -> zipStored -> crc32); ship all three
// under those names.

export function crc32(bytes) {
  var table = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function zipStored(files) {
  var enc = new TextEncoder();
  var entries = files.map(function (f) {
    var name = enc.encode(f.name);
    return { name: name, data: f.data, crc: crc32(f.data), offset: 0 };
  });
  var size = 22;
  entries.forEach(function (e) { size += 30 + e.name.length + e.data.length + 46 + e.name.length; });
  var out = new Uint8Array(size);
  var dv = new DataView(out.buffer);
  var o = 0;
  entries.forEach(function (e) {
    e.offset = o;
    dv.setUint32(o, 0x04034b50, true);
    dv.setUint16(o + 4, 20, true); // version needed
    dv.setUint16(o + 6, 0x0800, true); // UTF-8 names
    dv.setUint16(o + 8, 0, true); // method: stored
    dv.setUint16(o + 10, 0, true); // time
    dv.setUint16(o + 12, 0x21, true); // date: 1980-01-01
    dv.setUint32(o + 14, e.crc, true);
    dv.setUint32(o + 18, e.data.length, true);
    dv.setUint32(o + 22, e.data.length, true);
    dv.setUint16(o + 26, e.name.length, true);
    dv.setUint16(o + 28, 0, true);
    out.set(e.name, o + 30);
    out.set(e.data, o + 30 + e.name.length);
    o += 30 + e.name.length + e.data.length;
  });
  var dirStart = o;
  entries.forEach(function (e) {
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true); // version made by
    dv.setUint16(o + 6, 20, true);
    dv.setUint16(o + 8, 0x0800, true);
    dv.setUint16(o + 10, 0, true);
    dv.setUint16(o + 12, 0, true);
    dv.setUint16(o + 14, 0x21, true);
    dv.setUint32(o + 16, e.crc, true);
    dv.setUint32(o + 20, e.data.length, true);
    dv.setUint32(o + 24, e.data.length, true);
    dv.setUint16(o + 28, e.name.length, true);
    // extra, comment, disk, internal and external attributes stay 0
    dv.setUint32(o + 42, e.offset, true);
    out.set(e.name, o + 46);
    o += 46 + e.name.length;
  });
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, entries.length, true);
  dv.setUint16(o + 10, entries.length, true);
  dv.setUint32(o + 12, o - dirStart, true);
  dv.setUint32(o + 16, dirStart, true);
  return out;
}

export function xlsxBytes(rows, sheetName) {
  var name = sheetName || 'Sheet1';
  var enc = new TextEncoder();
  var esc = function (s) {
    return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var col = function (i) {
    var s = '';
    for (var n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  var strings = [];
  var index = {};
  var sheetRows = rows.map(function (row, r) {
    var cells = row.map(function (v, c) {
      var ref = col(c) + (r + 1);
      if (typeof v === 'number') return '<c r="' + ref + '"><v>' + v + '</v></c>';
      var s = String(v);
      if (!Object.prototype.hasOwnProperty.call(index, s)) { index[s] = strings.length; strings.push(s); }
      return '<c r="' + ref + '" t="s"><v>' + index[s] + '</v></c>';
    });
    return '<row r="' + (r + 1) + '">' + cells.join('') + '</row>';
  });
  var head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  var main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
  var part = function (n, text) { return { name: n, data: enc.encode(text) }; };
  return zipStored([
    part('[Content_Types].xml', head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'),
    part('_rels/.rels', head + '<Relationships xmlns="' + pkg + '"><Relationship Id="rId1" Type="' + rel + '/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    part('xl/workbook.xml', head + '<workbook xmlns="' + main + '" xmlns:r="' + rel + '"><sheets><sheet name="' + esc(name) + '" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    part('xl/_rels/workbook.xml.rels', head + '<Relationships xmlns="' + pkg + '">'
      + '<Relationship Id="rId1" Type="' + rel + '/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="' + rel + '/sharedStrings" Target="sharedStrings.xml"/></Relationships>'),
    part('xl/sharedStrings.xml', head + '<sst xmlns="' + main + '" count="' + strings.length + '" uniqueCount="' + strings.length + '">'
      + strings.map(function (s) { return '<si><t xml:space="preserve">' + esc(s) + '</t></si>'; }).join('') + '</sst>'),
    part('xl/worksheets/sheet1.xml', head + '<worksheet xmlns="' + main + '"><sheetData>' + sheetRows.join('') + '</sheetData></worksheet>'),
  ]);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
