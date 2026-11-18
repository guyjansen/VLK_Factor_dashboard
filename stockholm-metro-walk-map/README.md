# Stockholm metro walk map

An unofficial, interactive map of how far you can walk in **5 and 10 minutes** (at ~1.4 m/s) from each **Stockholm metro (tunnelbana)** station, with **Fabege's property portfolio** plotted on it, live coverage statistics, and an **Excel report**.

> Unofficial accessibility visualisation. Not affiliated with or endorsed by SL (Storstockholms Lokaltrafik), Region Stockholm, Samtrafiken, Trafiklab or Fabege.

- Map: MapLibre GL JS on an OpenFreeMap basemap (plain background if tiles fail), geographic, with zoom, scale, attribution, fit-to-selection and a light/dark theme.
- Lines in SL's official colours with casings; red and green are drawn side by side where they share track (Slussen–Gamla stan–T-Centralen).
- Walking areas are real pedestrian-network isochrones (Valhalla), never circles or buffers.
- Deliverables: `dist/stockholm-metro-walk-map.html` (one self-contained file; only basemap tiles need the internet), `dist/` (static site), `reports/stockholm-metro-portfolio-access.xlsx`.

## Headline results (all 100 stations, all 3 lines)

GTFS feed version 2026-11-18 (retrieved 2026-11-18); isochrones Valhalla, 2026-11-18. Fabege properties in the analysis: 96 of 99 (2 Borås excluded, 1 unlocated). Shares are cumulative.

| Fabege | Properties | ≤ 5 min | ≤ 10 min | Floor area known | ≤ 5 min (sqm) | ≤ 10 min (sqm) |
| --- | --- | --- | --- | --- | --- | --- |
| All | 96 | 19 (19.8%) | 37 (38.5%) | 1,264,073 m² (77 props) | 21.2% | 41.2% |
| Standing | 64 | 14 (21.9%) | 28 (43.8%) | 1,079,923 m² (62) | 21.4% | 41.0% |
| Development | 32 | 5 (15.6%) | 9 (28.1%) | 184,150 m² (15) | 19.8% | 42.3% |

By line (properties within 5 / 10 min of a station on the line): blue 9 / 30, red 4 / 13, green 10 / 19. Much of the portfolio lies in areas served by tram or commuter rail rather than the metro (Hammarby Sjöstad, Flemingsberg, Solna Business Park, parts of Arenastaden), so it falls outside the metro walking areas. Combined walking area of the whole network: 27.8 km² (5 min), 88.0 km² (10 min). Geocode precision: 70 building, 22 street, 4 area, 1 unlocated, 2 excluded.


## Quick start

```bash
npm install
```

```bash
npm run build
```

Then open `dist/stockholm-metro-walk-map.html`, or serve the app with the optional API server:

```bash
npm start
```

(`http://localhost:8080`). The generated data is committed, so no keys are needed to view or rebuild the map. Requirements: Node ≥ 22.21, Python 3 with `openpyxl` (report), LibreOffice (report verification), and Playwright + Chromium only for the browser check.

## Full pipeline

Each step is idempotent and cached, and stops with a clear message when its input is missing.

| Step | Command | Output |
| --- | --- | --- |
| Operator topology | `npm run fetch-topology` | `data/raw/gtfs-sl/` (zip git-ignored, metro subset + manifest committed), `data/raw/osm/` |
| Station records | `npm run prepare-stations` | `data/stations.clean.json` |
| Network | `npm run build-network` | `data/stations.json`, `data/network-edges.json`, `data/topology.geojson`, `data/join-report.json`, `public/data/network.js` |
| Validation | `npm run validate` | `data/validation-report.json` (exit 1 on errors) |
| Isochrones | `npm run isochrones` | `data/isochrones/<station>.json` cache, `data/isochrones.geojson`, `public/data/isochrones.js` |
| Unions | `npm run unions` | `data/coverage-unions.geojson`, `public/data/coverage.js` |
| Properties | `npm run buildings` (prepare → geocode → sizes → assign) | `data/buildings*.json`, `data/geocode-*.json`, `public/data/buildings.js` |
| Excel report | `npm run report` | `reports/stockholm-metro-portfolio-access.xlsx`, `reports/report-verification.json` |
| Build | `npm run build` | `dist/`, `dist/stockholm-metro-walk-map.html` |
| Tests | `npm test` | `node:test` suite |
| Browser check | `npm run check:browser` | `reports/screenshots/*.png` |

`npm run data:full` runs everything up to the report.

### Keys and `.env`

Copy `.env.example` to `.env` (git-ignored; placeholders only in the example).

- `TRAFIKLAB_API_KEY`: a **GTFS Regional (static)** key from [Trafiklab](https://www.trafiklab.se/). A *Realtime APIs* key is rejected ("Key does not have access to file"). It is sent only as `?key=` to `opendata.samtrafiken.se`, never logged or written to disk; the manifest stores `key=REDACTED`. Bronze keys allow 50 downloads a month, so the zip is reused until you pass `--refresh` (conditional GET).
- `ISOCHRONE_PROVIDER` (`valhalla` default, or `openrouteservice` with `ORS_API_KEY`), `VALHALLA_URL`, `NOMINATIM_URL`, `OVERPASS_URL`.
- Server: `PORT`, `ENABLE_ON_DEMAND_ISOCHRONES`, `RATE_LIMIT_PER_MINUTE`.

Network scripts run with `node --use-env-proxy`, so they work behind an HTTPS proxy; this does nothing when no proxy is set.

## Data sources and licences

| Data | Source | Licence |
| --- | --- | --- |
| Stations, lines, station order | SL static GTFS ("GTFS Regional", operator `sl`) from Samtrafiken via Trafiklab, `https://opendata.samtrafiken.se/gtfs/sl/sl.zip` ([docs](https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/), [overview](https://www.trafiklab.se/api/netex-datasets/overview/)) | CC0 1.0 |
| Line colours | SL's design-system stylesheet on sl.se (`--color-metro-blue/-red/-green`), archived in `data/raw/sl-colours/` with a manifest | factual values; stylesheet kept as evidence only |
| Station cross-check | OpenStreetMap via Overpass (the data behind railsmaps.com's station map) | ODbL |
| Walking areas | Valhalla (FOSSGIS public instance) on OpenStreetMap data | ODbL (data), MIT (Valhalla) |
| Geocoding | Nominatim (OpenStreetMap) | ODbL |
| Basemap | OpenFreeMap, OpenMapTiles schema | ODbL / OpenFreeMap terms |
| Portfolio | `data/FABG_property_list_FY25.xlsx` (supplied) | — |
| Software | MapLibre GL JS (BSD-3-Clause), polygon-clipping (MIT), Express (MIT) | |

Every raw download is stored with a manifest (URL, retrieval date, licence, SHA-256): `data/raw/gtfs-sl/manifest.json`, `data/raw/sl-colours/manifest.json`, `data/raw/osm/manifest.json` (when Overpass was reachable).

**railsmaps.com.** The page you named renders its stations from vector tiles; it publishes no station list to read. Its stations are OpenStreetMap data, so the pipeline cross-checks against OpenStreetMap directly (Overpass). Overpass reset every connection from this build environment, so the cross-check is currently reported as *not available* in `validation-report.json`. It is optional and runs automatically on the next `npm run fetch-topology -- --refresh` (or delete `data/raw/osm/`) from a network where Overpass answers.

## Method

### Topology (rule 1)
- Every distinct stop sequence of every metro trip (routes 10, 11, 13, 14, 17, 18, 19; GTFS `route_type` 401) in both directions is collected from `stop_times.txt` (streamed: 2.5 million rows). `data/raw/gtfs-sl/metro/patterns.json` lists all 94 patterns with trip and service-day counts.
- Two stations are connected only when a train calls at them consecutively. Coordinates are never used to order or connect stations; they are only used to confirm record joins and to flag implausibly long edges.
- Corrections go only through `data/topology-overrides.json` (each entry needs a reason; the build fails when one no longer applies). **No override is needed today.**

### Station identity (rule 2)
- A physical station is a GTFS parent station plus its platforms, linked by the operator's `parent_station` ID. Parent records are also merged on an equal normalised name (Swedish letters kept), or a documented alias in `data/station-aliases.json`, and always only within 500 m. Similar names never merge.
- Result: 223 metro platforms in 100 parent stations become **100 physical stations**, all linked by ID. There are no conflicts, no rejected links and no aliases. Interchanges: T-Centralen (blue, red, green), Fridhemsplan (blue, green), Slussen and Gamla stan (red, green).
- Tests keep look-alike stations separate, e.g. Rådhuset/Rådmansgatan, Hallonbergen/Hallunda, Alby/Alvik, Solna centrum/Solna strand, Stadshagen/Stadion, Skarpnäck/Skärmarbrink.

### Special cases
- **Kymlinge** (never-opened station between Hallonbergen and Kista). The feed has two direction-specific records ("Kymlinge norrut", "Kymlinge söderut") that every trip passes with `pickup_type = drop_off_type = 1`. The pipeline applies that GTFS rule itself: a stop counts as a station only if some trip allows boarding or alighting there. Kymlinge is therefore listed in `nonPassengerStops`, and Hallonbergen–Kista is one edge. Without this rule the blue line graph had a cycle, and validation failed as intended.
- **Longest edge.** Hallonbergen–Kista is about 3.5 km straight line, the longest real gap (the next longest is Tekniska högskolan–Universitetet, 2.26 km). The plausibility limit for metro edges is therefore 4 km.
- **Route termini.** Each route's most frequent pattern runs between the termini in the brief: 10 Hjulsta–Kungsträdgården, 11 Akalla–Kungsträdgården, 13 Norsborg–Ropsten, 14 Fruängen–Mörby centrum, 17 Åkeshov–Skarpnäck, 18 Alvik–Farsta strand, 19 Hässelby strand–Hagsätra. The feed also has real extensions and short turns: 17 and 18 run daily trips to Hässelby strand (about 16% of route 17's trips); there are turns at Odenplan, Liljeholmen, Gullmarsplan, Vällingby and Högdalen; and route 13 has a 7-day Mörby centrum–Sätra pattern, probably during engineering works. They all run on existing track, so they add no edges.
- **Coordinates** are the operator's parent-station coordinates (centroids), WGS84 in every source. No coordinate conversion is needed (rule 9 does not apply). The feed also contains 227 entrance records, which are not used.

### Walking areas (rules 4–6)
- Valhalla `pedestrian` costing, `walking_speed` 5.04 km/h (1.4 m/s), contours 300 and 600 s, `polygons: true`, `denoise 0.1`, `generalize 3 m`, from each station centroid. The provider adapter (`scripts/lib/providers/`) also supports openrouteservice (`foot-walking`, fixed ~5 km/h profile). Provider, profile, parameters, origin and timestamp are stored with every polygon.
- Cache: one file per station; **each contour carries a hash of its parameters** (provider, profile, speed, origin, options; not the contour list). So adding a threshold later requests only the new contour and leaves existing polygons byte-for-byte identical. Runs resume; failures are retried with exponential backoff and Retry-After, then listed in `data/isochrones/_failures.json`; requests are spaced ≥ 1.1 s.
- Unions: true geometric unions (polygon-clipping), one per threshold, per line and for the whole network, each station counted once. Other selections are computed in a Web Worker with cancellation (main thread when opened from `file://`).
- Validation: valid geometry; 5 min ⊆ 10 min by true geometric difference; maximum reach ≤ seconds × 1.4 m/s + 150 m snapping tolerance; not circle-like (radial coefficient of variation); precomputed unions equal fresh ones (symmetric difference < 0.1%).

### Properties (rules 7–8)
- **Parsing.** Asset ID `FAB-<region>-<listing no.>`. **Standing** = classification "Investment"; **Development** = "Development" or "Land & project" (your decision; the source classification is kept). The classification is recomputed from the two Yes/No columns with the workbook's own formula and must agree with it.
- **Scope.** The 2 Borås properties are excluded (outside the network scope). They are listed, never mapped or counted.
- **Addresses.** Abbreviations are expanded (`Döbelnsg` → Döbelnsgatan, `Svetsarv` → Svetsarvägen, …). Every street and listed house number is a candidate. Property type is derived from the area mix (e.g. "Office (89% of lettable area)").
- **Geocoding** (Nominatim, ≤ 1 request/1.1 s, identifying User-Agent, everything cached in `data/geocode-cache.json`):
  - Search order: structured search, then the number without its letter, then a free-text query, then street level.
  - A result is rejected when its road is not the source street, when it is more than 30 km from Sergels torg, or (at area level) when it is a municipality rather than a district.
  - A missing house-number match downgrades the result to *street* precision.
  - Ambiguous cases use reviewed overrides in `data/geocode-overrides.json`, which add the district or anchor to a neighbour in the same quarter. Each override has a reason; the step fails on an unknown or unused override.
- **Floor area.** "Total lettable area (sqm)" from the same workbook, joined by asset ID with a company and property-name check; the import stops on any mismatch. **0 or blank = unknown**: excluded from floor-area shares and stated in the UI and the report.
- **Assignment.** A fresh point-in-polygon test of every property against every station's full-precision 300/600 s polygon. Re-run independently in the tests.

### Geocoding review (hand-check)
Every non-building result and every override was checked by hand (`data/geocode-review.json`): district against the workbook's *Area*, and position against building-level neighbours in the same block. Fixed traps:

- Sveavägen 149 and Malmskillnadsgatan 47 were about 500 m off at street level.
- Kolonnvägen and Frösundaleden are long streets: plain matches landed in Norra Ritorp, Skytteholm or Ulriksdal instead of Arenastaden or Haga Norra.
- "Hammarby Kaj 12" is not in OpenStreetMap, but No. 14 is.
- "Enlundavägen" is a typo for Englundavägen.
- "Haga Norra" alone matches only a bus stop; Sollentuna is a whole municipality (left unlocated).

**Please confirm** the entries marked "Please confirm" in `data/geocode-overrides.json`.

## The app

- Controls:
  - Select all / clear all; per-line checkboxes (with route numbers) and an expandable station list for adding or removing single stations.
  - Station search (ignores diacritics: "ostermalmstorg" finds Östermalmstorg).
  - A toggle per threshold; union or individual polygons; opacity; show/hide routes, unselected lines, stations and properties; fit to selection; reset.
  - A live ARIA summary such as "3 lines selected · 100 unique stations · 5- and 10-minute coverage enabled".
- Properties: amber points (developments a lighter amber) with a dark outline. They fade when outside the selected walking times. Filters by company and standing/development.
- Property popups: company, status (with source classification), type, address, floor area, walking time, stations within reach, nearest station, geocode precision.
- Statistics table: per company, the share of all / standing / development properties within each threshold of the current selection, by count or floor area; hover for absolute values. A rounded 100% or 0% is only shown when exact (otherwise e.g. 99.9% / 0.1%). Properties not in the analysis, and unknown floor areas, are listed under the table.
- Robustness: network data loads first. Isochrones, unions and properties load progressively, and lines and stations keep working if any of them fail; errors appear as readable banners. All data text goes through `textContent` (no `innerHTML`).
- Accessibility: keyboard operable, labelled controls, visible focus, ARIA live summary. Thresholds are told apart by outline pattern (solid / dashed), not only colour. Below 760 px the panel becomes a bottom sheet; it works at 320 px.
- Colours: blue `#007DB8`, red `#D71D24`, green `#148541` (SL); walking areas violet (5 min) and lavender (10 min); Fabege amber. All are defined only in `public/js/shared/config.js`; a test enforces this and checks that no fill or company colour is close to a line colour.

### Architecture
- `public/js/shared/{config,geometry,selection}.js`: UMD modules shared by browser, Node pipeline and tests.
- Browser code is classic scripts, so the page works from `file://`. Data is shipped as generated `window.METRO_* = {...}` scripts, not fetched JSON.
- `server/server.mjs` (optional Express): static files with security headers (CSP), `/api/health`, `/api/config` and `POST /api/isochrone` for on-demand isochrones. That endpoint accepts known station IDs only, is rate limited per IP, takes keys from `.env` only and is disabled by default.
- Pinned dependencies: `express 4.21.2`, `maplibre-gl 5.23.0`, `polygon-clipping 0.15.7`.

## Excel report

`reports/stockholm-metro-portfolio-access.xlsx` (Arial):

| Sheet | Contents |
| --- | --- |
| Summary | Cumulative shares (≤ 5, ≤ 10 min) by count and by floor area, for all / standing / development; geocode precision counts |
| Distribution | Exclusive bands (≤ 5, 5–10, > 10 min) by count and floor area |
| By line | Per company and line (and status), share within each threshold, by count and floor area |
| All assets / Fabege | Asset rows: geocode (lat/lon, query, result), precision, best walk band, stations per band, lines, nearest station and distance, best minutes per line, floor area, scope |
| Notes | Method, sources, caveats |

All statistics are live `COUNTIFS`/`SUMIFS` formulas. `npm run report` then runs `scripts/verify-report.py`, which:
- recalculates a copy with LibreOffice;
- fails on any formula error;
- compares every statistic (`reports/report-checks.json`, computed independently in Python) with the recalculated value.

Percentages between 99.95% and 100% display as ">99.9%", and those between 0% and 0.05% as "<0.1%".

## Assumptions and limitations

- Walks start at one centroid per station, not at the entrances, so real walks can be a minute or more shorter or longer at large stations. Results depend on OpenStreetMap completeness and the routing profile; closures and diversions are not modelled.
- Line routes are straight segments between adjacent stations, not track geometry.
- Street-level positions can be a few hundred metres from the building, and area-level positions are approximate. Popups and the report show the precision of every property.
- GTFS is a timetable snapshot (feed version and retrieval date in the manifest and in the About dialog). New stations or closures appear after `npm run fetch-topology -- --refresh`.
- Public services (Valhalla FOSSGIS, Nominatim, Overpass) are for light use. For production, self-host Valhalla and Nominatim (or use a commercial host) and set `VALHALLA_URL` / `NOMINATIM_URL`.

## Performance

- 100 stations × 2 contours, about 2 MB of display data. Precomputed per-line and all-network unions make the common selections instant.
- Other selections run in a Web Worker; a new selection terminates the running job.
- A full isochrone run makes 100 requests (about 5 minutes at the public rate limit); a rerun makes none.

## Deployment

- **Single file:** send `dist/stockholm-metro-walk-map.html`. It works offline except for basemap tiles.
- **Static hosting:** upload `dist/` to any static host.
- **With API:** `npm start` behind a reverse proxy. Set `TRUST_PROXY=true` behind one, and `ENABLE_ON_DEMAND_ISOCHRONES=true` to allow on-demand isochrones.

## Acceptance checklist

Verified on 2026-11-18 (`npm test`: 46 passed, 0 failed, 0 skipped; `npm run validate`: no errors, 1 warning).

- [x] Colours equal SL's RGB values (archived sl.se stylesheet) and are defined only in `config.js` (test greps every source file)
- [x] Topology only from operator GTFS stop sequences; raw download + manifest (URL, date, licence, SHA-256); every edge is a consecutive passenger-call pair (test)
- [x] Every operator record joins a station; no conflicting-name merges; look-alike stations stay separate; interchanges merged once (100 stations)
- [x] Each line one connected tree; termini and junctions asserted per line; main-service termini asserted per route; shared track Slussen–Gamla stan–T-Centralen; no implausible edges
- [x] Overrides: reviewed files with reasons; build fails on unused overrides/aliases (none needed for topology)
- [x] Isochrones from Valhalla, provenance recorded, valid, nested (geometric), within physical maximum, irregular; cache per station and contour by parameter hash; precomputed unions equal fresh ones
- [x] Selection dedupes interchanges; manual add/remove; summary text
- [x] Properties: parsing counts per company/status; geocode sanity and known traps; size join by ID + name; fresh point-in-polygon; browser-script syntax check
- [x] Excel: live formulas, LibreOffice recalculation with 0 errors, 77/77 statistics equal the pipeline
- [x] Browser: desktop and 320 px, from the server and from the single file, no console errors; screenshots reviewed (`reports/screenshots/`)
- [ ] OpenStreetMap station cross-check: implemented, but Overpass was unreachable from the build environment (reported as a warning)
- [ ] Shares cross-checked against a reference table: none was supplied

