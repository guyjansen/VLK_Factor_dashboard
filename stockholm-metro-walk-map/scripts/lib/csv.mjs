// RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM) No dependency.

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
