// Station-name normalisation for joining the CSV to TfL topology.
// Normalisation is only used to FIND candidates; a join additionally requires
// the two coordinates to be close (see build-network.mjs). Names alone never
// merge records.

/**
 * Strip TfL suffixes such as " Underground Station", "-Underground" and
 * " Rail Station". National Rail terminus stops are named "London X Rail
 * Station" (e.g. "London Paddington"); for those, the "London " prefix is
 * dropped too. Names that genuinely start with "London" (London Bridge) are
 * not rail-suffixed Elizabeth line stops, so they are left alone.
 */
export function stripTflSuffix(name) {
  let s = String(name || '').trim();
  const rail = /\s+Rail Station$/i.test(s);
  s = s.replace(/\s*Underground Station$/i, '').replace(/-Underground$/i, '').replace(/\s+Rail Station$/i, '');
  if (rail && !/^London Bridge$/i.test(s)) s = s.replace(/^London\s+/i, '');
  return s.trim();
}

/** Canonical comparison key: case, punctuation and "&"/"and" insensitive. */
export function nameKey(name) {
  return stripTflSuffix(name)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'.]/g, '')
    .replace(/[^a-z0-9()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Key without any parenthetical qualifier: "edgware road (circle line)" -> "edgware road". */
export function baseNameKey(name) {
  return nameKey(name).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}
