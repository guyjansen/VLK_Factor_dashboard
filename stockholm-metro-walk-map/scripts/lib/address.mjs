// Address helpers for the Swedish portfolio workbook (shared by
// prepare-buildings.mjs and the tests).

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

/** "Döbelnsg" -> "Döbelnsgatan", "Svetsarv" -> "Svetsarvägen"; full names unchanged. */
export function expandStreet(name) {
  const words = name.split(' ');
  const last = words[words.length - 1];
  const full = /(gatan|gata|vägen|väg|torget|torg|leden|allé|kaj|slingan|gränd|boulevard|stigen|plan|backe|gången|stråket|platsen)$/i;
  let expanded = last;
  if (!full.test(last)) {
    if (/[a-zåäö]g$/i.test(last)) expanded = `${last}atan`;
    else if (/[a-zåäö]v$/i.test(last)) expanded = `${last}ägen`;
  }
  words[words.length - 1] = expanded;
  return { street: words.join(' '), abbreviated: expanded !== last };
}

/**
 * Split "Döbelnsg 20, 24, Kungstensg 21–23, Rådmansg 40" into
 * [{street:'Döbelnsgatan', number:'20', numbers:['20','24']}, {street:'Kungstensgatan', number:'21', ...}, ...].
 * Bare numbers after a street belong to that street; of a range only the
 * first number is used ("21–23" -> 21).
 */
export function parseAddress(raw) {
  const out = [];
  const text = clean(raw).replace(/,?\s*(etc\.?|and others)$/i, '');
  if (!text) return out;
  // House number: digits plus an optional letter ("12A", "15C"; "21–23" -> 21; "25 A–C" -> 25A).
  const houseNumber = (tokens, i) => {
    const m = /^(\d+)([A-Za-z])?/.exec(tokens[i]);
    let n = m[1] + (m[2] ? m[2].toUpperCase() : '');
    if (!m[2] && /^[A-Z](?:[–-][A-Z])?$/.test(tokens[i + 1] || '')) n += tokens[i + 1][0];
    return n;
  };
  for (const part of text.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
    // Street = the words before the first token that starts with a digit.
    const tokens = part.split(' ');
    const firstNum = tokens.findIndex((t) => /^\d/.test(t));
    const nameTokens = firstNum < 0 ? tokens : tokens.slice(0, firstNum);
    if (!nameTokens.length || !/[A-Za-zÅÄÖåäö]{3}/.test(nameTokens.join(' '))) {
      // A bare house number ("…, 24") belongs to the previous street.
      if (out.length && firstNum === 0) out[out.length - 1].numbers.push(houseNumber(tokens, 0));
      continue;
    }
    const { street, abbreviated } = expandStreet(nameTokens.join(' '));
    const number = firstNum >= 0 ? houseNumber(tokens, firstNum) : null;
    const existing = out.find((a) => a.street === street);
    if (existing) { if (number) existing.numbers.push(number); continue; }
    out.push({ street, number, numbers: number ? [number] : [], sourceText: part, abbreviated });
  }
  out.forEach((a) => { a.numbers = [...new Set(a.numbers)]; });
  return out;
}
