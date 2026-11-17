// Minimal, dependency-free .xlsx reader: enough to read the first worksheet
// of a plain data workbook (shared strings, inline strings, numbers).
// An .xlsx file is a ZIP archive of XML parts. We read the ZIP central
// directory and inflate the needed parts with node:zlib.
import fs from 'node:fs';
import zlib from 'node:zlib';

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP/xlsx file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
    const data = buf.subarray(start, start + f.csize);
    if (f.method === 0) return data.toString('utf8');
    if (f.method === 8) return zlib.inflateRawSync(data).toString('utf8');
    throw new Error(`unsupported ZIP compression method ${f.method} for ${name}`);
  };
}

const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (m, e, d, h) =>
  d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()]);

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Read the first worksheet as an array of row arrays (strings / numbers / null). */
export function readFirstSheet(file) {
  const get = readZip(fs.readFileSync(file));
  const shared = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(decode((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const wb = get('xl/workbook.xml') || '';
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const firstRid = (/<sheet [^>]*r:id="([^"]+)"/.exec(wb) || [])[1];
  const target = firstRid && (new RegExp(`Id="${firstRid}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`Target="([^"]+)"[^>]*Id="${firstRid}"`).exec(rels) || [])[1];
  const sheetPath = target ? 'xl/' + target.replace(/^\/?xl\//, '') : 'xl/worksheets/sheet1.xml';
  const xml = get(sheetPath);
  if (!xml) throw new Error(`worksheet ${sheetPath} not found in workbook`);
  const rows = [];
  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) || []) {
    const row = [];
    for (const c of rowXml.match(/<c [^>]*\/>|<c [^>]*>[\s\S]*?<\/c>/g) || []) {
      const ref = (/ r="([A-Z]+\d+)"/.exec(c) || [])[1];
      const type = (/ t="([^"]+)"/.exec(c) || [])[1];
      const v = (/<v>([\s\S]*?)<\/v>/.exec(c) || [])[1];
      let value = null;
      if (type === 's') value = shared[Number(v)] ?? null;
      else if (type === 'inlineStr') value = decode(((/<t[^>]*>([\s\S]*?)<\/t>/.exec(c) || [])[1]) || '');
      else if (type === 'str' || type === 'b' || type === 'e') value = v == null ? null : decode(v);
      else if (v != null) value = Number(v);
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => (x === undefined ? null : x)));
  }
  return rows;
}
