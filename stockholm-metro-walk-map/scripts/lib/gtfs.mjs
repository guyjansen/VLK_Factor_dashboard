// GTFS helpers: CSV line parsing and table loading.
import fs from 'node:fs';
import { parseCsv } from './csv.mjs';

/** Parse one CSV line (RFC 4180 quoting; GTFS lines never contain newlines). */
export function parseCsvLine(line) {
  const out = [];
  let field = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === ',') { out.push(field); field = ''; } else field += ch;
  }
  out.push(field);
  return out;
}

/** Text of a CSV table -> array of objects keyed by header. */
export function tableFromText(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].cells.map((h) => h.trim().replace(/^﻿/, ''));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r.cells[i] ?? '').trim()])));
}

export function readTable(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing GTFS table ${file}`);
  return tableFromText(fs.readFileSync(file, 'utf8'));
}

/** Objects -> CSV text with the given column order (quotes only when needed). */
export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}
