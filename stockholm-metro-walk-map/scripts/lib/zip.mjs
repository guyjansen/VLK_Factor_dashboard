// Minimal, dependency-free ZIP reader with streaming entry access.
// GTFS feeds are ZIP archives; SL's stop_times.txt is far larger than a
// single JavaScript string may be, so entries are read line by line through
// a streaming inflater. Supports stored/deflated entries and ZIP64 sizes.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';

function zip64Extra(buf, start, len, need) {
  // need: which of [usize, csize, localOffset] were 0xFFFFFFFF, in order.
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const id = buf.readUInt16LE(p), size = buf.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const out = {};
      for (const k of need) { out[k] = Number(buf.readBigUInt64LE(q)); q += 8; }
      return out;
    }
    p += 4 + size;
  }
  return {};
}

/** Open a ZIP file. Returns { names, has(name), readText(name), lines(name) }. */
export function openZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file} is not a ZIP archive (no end-of-central-directory record)`);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20; // ZIP64 end of central directory locator
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const need = [];
    if (usize === 0xffffffff) need.push('usize');
    if (csize === 0xffffffff) need.push('csize');
    if (local === 0xffffffff) need.push('local');
    if (need.length) {
      const z = zip64Extra(buf, p + 46 + nameLen, extraLen, need);
      usize = z.usize ?? usize; csize = z.csize ?? csize; local = z.local ?? local;
    }
    entries.set(name.replace(/^.*\//, ''), { name, method, csize, usize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  function data(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`ZIP entry ${name} not found`);
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    return { e, raw: buf.subarray(start, start + e.csize) };
  }
  function stream(name) {
    const { e, raw } = data(name);
    const src = Readable.from([raw]);
    if (e.method === 0) return src;
    if (e.method === 8) return src.pipe(zlib.createInflateRaw());
    throw new Error(`unsupported ZIP compression method ${e.method} for ${name}`);
  }
  return {
    names: [...entries.keys()],
    size: (name) => entries.get(name)?.usize ?? null,
    has: (name) => entries.has(name),
    /** Whole entry as text (only for small entries). */
    readText(name) {
      const { e, raw } = data(name);
      const out = e.method === 0 ? raw : zlib.inflateRawSync(raw);
      return out.toString('utf8');
    },
    /** Async iterator over the lines of an entry. */
    lines(name) {
      return readline.createInterface({ input: stream(name), crlfDelay: Infinity });
    }
  };
}
