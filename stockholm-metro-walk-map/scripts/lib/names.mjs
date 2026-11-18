// Station-name normalisation for joining operator stop records with each
// other and with the OpenStreetMap reference. Normalisation only FINDS
// candidates; a join additionally requires the two coordinates to be within
// the configured distance (see build-network.mjs). Similar names never merge:
// keys must be EQUAL. Swedish letters (å, ä, ö) are kept, so "Mälarhöjden"
// and a hypothetical "Malarhojden" do not collide silently.

/** Strip mode/platform suffixes that some sources append ("T-bana", "tunnelbanestation"). */
export function stripSuffix(name) {
  return String(name || '')
    .replace(/\s*\((t-bana|tunnelbana|metro)\)\s*$/i, '')
    .replace(/\s+(t-banestation|tunnelbanestation|tunnelbana|t-bana|metro station)$/i, '')
    .trim();
}

/** Canonical comparison key: case-, whitespace- and punctuation-insensitive. */
export function nameKey(name) {
  return stripSuffix(name)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’'.]/g, '')
    .replace(/[\s\-–]+/g, ' ')
    .trim();
}
