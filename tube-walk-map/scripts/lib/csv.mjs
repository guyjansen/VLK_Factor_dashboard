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

// Two accepted layouts:
//  - WGS84:  NAME, Longitude, Latitude, LINES, OBJECTID            (original CSV)
//  - OSGB:   X, Y, OBJECTID, NAME, LINES [, ATCOCODE, NETWORK, ...] (TfL station
//            export / Underground_and_Elizabeth_Stations.xlsx; X/Y = British
//            National Grid easting/northing, EPSG:27700)
export const REQUIRED_COLUMNS = ['NAME', 'Longitude', 'Latitude', 'LINES', 'OBJECTID'];
export const REQUIRED_COLUMNS_OSGB = ['X', 'Y', 'NAME', 'LINES', 'OBJECTID'];

/** Split "District, Hammersmith & City, Elizabeth line" into canonical line ids. */
export function parseLines(value) {
  const ids = [];
  const unknown = [];
  String(value || '')
    .split(',')
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .forEach((name) => {
      const key = name.toLowerCase().replace(/ line$/, '');
      const id = TubeConfig.LINE_ID_BY_NAME[key] || TubeConfig.LINE_ID_BY_NAME[name.toLowerCase()];
      if (id) { if (!ids.includes(id)) ids.push(id); } else unknown.push(name);
    });
  return { ids, unknown };
}

/**
 * Validate a station table (header + rows of cells) from CSV or XLSX.
 * @param {string[]} header
 * @param {Array<{line:number, cells:any[]}>} rows
 * @param {{toWgs84?: (x:number, y:number) => [number, number]}} opts  needed for OSGB tables
 * @returns {{records: Array, issues: Array, coordinateSystem: string}}
 */
export function parseStationTable(header, rows, opts = {}) {
  header = header.map((h) => String(h ?? '').trim());
  const osgb = REQUIRED_COLUMNS_OSGB.every((c) => header.includes(c)) && !header.includes('Longitude');
  const required = osgb ? REQUIRED_COLUMNS_OSGB : REQUIRED_COLUMNS;
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new Error(`Station table is missing required column(s): ${missing.join(', ')} (expected ${REQUIRED_COLUMNS.join(', ')} or ${REQUIRED_COLUMNS_OSGB.join(', ')})`);
  }
  if (osgb && !opts.toWgs84) throw new Error('OSGB (X/Y) station table needs a coordinate converter');
  const idx = Object.fromEntries(header.map((c, i) => [c, i]));

  const records = [];
  const issues = [];
  for (const { line, cells } of rows) {
    const get = (c) => (idx[c] === undefined ? '' : String(cells[idx[c]] ?? '').trim());
    if (cells.every((c) => c === null || String(c).trim() === '')) continue;
    const problems = [];
    if (!osgb && cells.length !== header.length) problems.push(`expected ${header.length} fields, found ${cells.length}`);
    const name = get('NAME').replace(/\s+/g, ' ');
    let lon, lat;
    if (osgb) {
      const x = Number(get('X')), y = Number(get('Y'));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 700000 || y < 0 || y > 1300000) problems.push(`X/Y is not a valid British National Grid coordinate: "${get('X')}", "${get('Y')}"`);
      [lon, lat] = opts.toWgs84(x, y);
    } else {
      lon = Number(get('Longitude'));
      lat = Number(get('Latitude'));
    }
    const objectId = get('OBJECTID').replace(/\.0+$/, '');
    if (!name) problems.push('empty NAME');
    if (!Number.isFinite(lon) || lon < -1.2 || lon > 0.8) problems.push(`longitude out of range for the London region: "${osgb ? get('X') : get('Longitude')}"`);
    if (!Number.isFinite(lat) || lat < 51.2 || lat > 51.9) problems.push(`latitude out of range for the London region: "${osgb ? get('Y') : get('Latitude')}"`);
    if (!/^\d+$/.test(objectId)) problems.push(`OBJECTID is not an integer: "${objectId}"`);
    const { ids, unknown } = parseLines(get('LINES'));
    if (!ids.length) problems.push('no recognised London Underground or Elizabeth line in LINES');
    if (unknown.length) issues.push({ type: 'unknown-line-name', line, objectId, name, values: unknown });
    if (problems.length) {
      issues.push({ type: 'malformed-row', line, objectId, name, problems });
      if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) continue; // unusable
    }
    records.push({
      objectId: Number(objectId), name, lon, lat, lines: ids, rawLines: get('LINES'),
      atcoCode: get('ATCOCODE') || null, network: get('NETWORK') || null, csvLine: line
    });
  }
  return { records, issues, coordinateSystem: osgb ? 'EPSG:27700 (converted to WGS84)' : 'WGS84' };
}

/** Parse and validate a station CSV (either layout). */
export function parseStationsCsv(text, opts) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('Station CSV is empty');
  return parseStationTable(rows[0].cells, rows.slice(1), opts);
}
