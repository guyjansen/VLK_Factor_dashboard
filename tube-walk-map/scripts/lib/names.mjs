// Station-name normalisation for joining the CSV to TfL topology.
// Normalisation is only used to FIND candidates; a join additionally requires
// the two coordinates to be close (see build-network.mjs). Names alone never
// merge records.

/** Strip TfL suffixes such as " Underground Station" and "-Underground". */
export function stripTflSuffix(name) {
  return String(name || '')
    .replace(/\s*Underground Station$/i, '')
    .replace(/-Underground$/i, '')
    .trim();
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
