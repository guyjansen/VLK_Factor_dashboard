// RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM) plus the
// station-specific row validation. No dependency.
import { TubeConfig } from './common.mjs';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let lineNo = 1;
  let rowStartLine = 1;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (ch === '\n') lineNo++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.length === 0) inQuotes = true;
      else field += ch; // stray quote inside an unquoted field: keep literally
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push({ line: rowStartLine, cells: row });
      row = [];
      lineNo++;
      rowStartLine = lineNo;
    } else field += ch;
  }
  if (inQuotes) throw new Error(`Unterminated quoted field starting on line ${rowStartLine}`);
  if (field.length || row.length) { row.push(field); rows.push({ line: rowStartLine, cells: row }); }
  return rows.filter((r) => !(r.cells.length === 1 && r.cells[0].trim() === ''));
}

export const REQUIRED_COLUMNS = ['NAME', 'Longitude', 'Latitude', 'LINES', 'OBJECTID'];

/** Split "District, Hammersmith & City, Central" into canonical line ids. */
export function parseLines(value) {
  const ids = [];
  const unknown = [];
  String(value || '')
    .split(',')
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .forEach((name) => {
      const key = name.toLowerCase().replace(/ line$/, '');
      const id = TubeConfig.LINE_ID_BY_NAME[key];
      if (id) { if (!ids.includes(id)) ids.push(id); } else unknown.push(name);
    });
  return { ids, unknown };
}

/**
 * Parse and validate the supplied station CSV.
 * @returns {{records: Array, issues: Array}}
 */
export function parseStationsCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('Station CSV is empty');
  const header = rows[0].cells.map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`Station CSV is missing required column(s): ${missing.join(', ')}`);
  const idx = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, header.indexOf(c)]));

  const records = [];
  const issues = [];
  for (const { line, cells } of rows.slice(1)) {
    const get = (c) => (cells[idx[c]] ?? '').trim();
    const problems = [];
    if (cells.length !== header.length) problems.push(`expected ${header.length} fields, found ${cells.length}`);
    const name = get('NAME').replace(/\s+/g, ' ');
    const lon = Number(get('Longitude'));
    const lat = Number(get('Latitude'));
    const objectId = get('OBJECTID');
    if (!name) problems.push('empty NAME');
    if (!Number.isFinite(lon) || lon < -1.2 || lon > 0.8) problems.push(`Longitude out of London range: "${get('Longitude')}"`);
    if (!Number.isFinite(lat) || lat < 51.2 || lat > 51.9) problems.push(`Latitude out of London range: "${get('Latitude')}"`);
    if (!/^\d+$/.test(objectId)) problems.push(`OBJECTID is not an integer: "${objectId}"`);
    const { ids, unknown } = parseLines(get('LINES'));
    if (!ids.length) problems.push('no recognised London Underground line in LINES');
    if (unknown.length) issues.push({ type: 'unknown-line-name', line, objectId, name, values: unknown });
    if (problems.length) {
      issues.push({ type: 'malformed-row', line, objectId, name, problems });
      if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) continue; // unusable
    }
    records.push({ objectId: Number(objectId), name, lon, lat, lines: ids, rawLines: get('LINES'), csvLine: line });
  }
  return { records, issues };
}
