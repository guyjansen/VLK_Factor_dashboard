# Tube walk map

An interactive map of the areas you can reach **on foot within 5 and 10 minutes** of London Underground and Elizabeth line stations. Line routes follow authoritative TfL route order, and the walking areas are pedestrian-network isochrones produced by a routing engine.

> **Unofficial accessibility visualisation. Not affiliated with or endorsed by Transport for London.**

![Status](https://img.shields.io/badge/tests-50%20passing-brightgreen)

- 301 physical stations from 302 station records (the duplicate Paddington record is merged): 272 Underground stations, 41 Elizabeth line stations, 12 of them shared. 11 Underground lines plus the Elizabeth line. 351 track links built from TfL Route Sequence data.
- The Elizabeth line is listed and treated like every other line (select it, combine it, compare buildings against it).
- **149 office buildings** of Landsec, Great Portland Estates, British Land and Derwent London (`data/London_office_data.xlsx`) are shown as points, one colour per company, with developments in a lighter shade of the same colour. The panel shows live per-company statistics for the current selection: the % of all buildings, standing assets and developments within each selected walking time. A toggle switches these statistics between **number of buildings** and **floor area (sqm)**.
- **Excel report** `reports/office-station-access.xlsx`: every asset with its walking band, stations and lines, one sheet per company, plus summary, distribution and per-line statistics as live formulas.
- 602 walking-time polygons (301 stations × 300/600 s, i.e. 5 and 10 minutes) generated with Valhalla (`pedestrian` costing, 5.04 km/h = 1.4 m/s).
- Combined coverage is a true polygon union for each time threshold, computed in a Web Worker in the browser and also precomputed for each line and for the whole network.
- Works from `npm start` (Express) or as a static site, including opening `index.html` straight from disk.

---

## 1. Architecture decisions

| Concern | Choice | Why |
|---|---|---|
| Map rendering | **MapLibre GL JS 5.23.0** | WebGL vector rendering. Data-driven `line-offset` lets shared track draw lines side by side. Built-in navigation, scale and attribution controls; keyboard pan and zoom. Leaflet would need plugins for line offsets and would struggle with ~800 polygons. |
| Basemap | **OpenFreeMap** `positron` and `dark` vector styles | Free, no API key, OSM-based, and public use is explicitly allowed. If it fails, the app switches to a plain background. |
| Polygon union | **polygon-clipping 0.15.7** (the engine behind Turf's `union`) | Robust sweep-line boolean union that handles holes and overlaps. Used directly so there is no need for the whole Turf bundle. |
| Topology | **TfL Unified API, Route Sequence** endpoint | Authoritative ordered stop sequences per branch, in both directions. See §2. |
| Isochrones | **Valhalla** (default) or **openrouteservice**, each behind an adapter | Both are true pedestrian-network isochrone engines and return all three contours in one request. Valhalla's public FOSSGIS instance needs no key, and the walking speed can be set to exactly 1.4 m/s. ORS needs a key and uses its own fixed ~5 km/h foot profile. A self-hosted Valhalla is the production recommendation. |
| Isochrone architecture | **Offline preprocessing + cache**, plus an optional server proxy | Isochrones are generated once (`npm run isochrones`), cached per station and shipped as static data. Keys live only in `.env` on the machine running the scripts or server, never in the browser. The Express server can optionally compute a missing station on demand, with rate limiting and retries. |
| Browser data loading | Generated `public/data/*.js` files that set `window.TUBE_*` globals | Unlike `fetch()`, these load under `file://`, so opening `index.html` directly works with no CORS dependency. The network loads first; isochrones and unions load afterwards. |
| Unions at runtime | Web Worker (`js/union-worker.js`), with cancellation and a cache | Each new selection terminates any in-flight job. Results are cached by selection. Exact line selections reuse the precomputed line unions. Under `file://` (no workers) the union runs on the main thread, which still takes under 100 ms for all 301 stations. |
| Shared code | UMD modules in `public/js/shared/` (`config.js`, `geometry.js`, `selection.js`) | The browser, the Node scripts and the tests all use the same colour config, geometry and selection logic. |
| Dependencies | Three runtime dependencies at pinned versions; tests use the built-in `node:test` | Minimal surface. |

## 2. Data sources and licensing

| Data | Source | Retrieved | Licence / attribution |
|---|---|---|---|
| Station coordinates & line lists | Supplied `data/Underground_and_Elizabeth_Stations.xlsx` (302 records; X/Y in British National Grid, EPSG:27700; ATCO codes). This is the default input. The original Underground-only `data/stations.csv` (273 records, WGS84) is kept and can be used with `npm run prepare-stations -- --input data/stations.csv` | — | As supplied |
| Route order, branches, adjacency | TfL Unified API: `https://api.tfl.gov.uk/Line/Mode/tube,elizabeth-line` and `https://api.tfl.gov.uk/Line/{id}/Route/Sequence/{outbound\|inbound}` (11 Underground lines + `elizabeth`) | 2026-11-17 (exact time in `data/raw/tfl/manifest.json`) | TfL transport data terms (https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service). Required attribution: *"Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016 and Geomni UK Map data © and database rights [2019]."* |
| Line colours | TfL *Colour standard*, Issue 11, August 2026: §5 "London Underground line colours", and §3 "Mode colours" for the Elizabeth line (RGB values) | — | Reference only. Colours are used to identify lines and do not imply endorsement |
| Walking isochrones | Valhalla, FOSSGIS e.V. public instance `https://valhalla1.openstreetmap.de` | 2026-11-17 | Valhalla is MIT-licensed. Routing data is © OpenStreetMap contributors (ODbL). The public instance is for light, non-commercial use, so this project sends no more than ~1 request per second |
| Basemap | OpenFreeMap (`https://openfreemap.org`), OpenMapTiles schema | live | © OpenMapTiles, © OpenStreetMap contributors |
| Office buildings | Supplied `data/London_office_data.xlsx`; positions geocoded with Nominatim (`https://nominatim.openstreetmap.org`) | 2026-11-17 | Geocoding data © OpenStreetMap contributors (ODbL); Nominatim usage policy respected (≤ 1 request/s, cached) |
| Software | MapLibre GL JS (BSD-3-Clause), polygon-clipping (MIT), Express (MIT) | | |

The app shows attribution in the map's attribution control, the panel footer and the "About & data" dialog.

**Colour values** (all defined only in `public/js/shared/config.js` and checked by a test against the PDF):

| Line | RGB | Hex |
|---|---|---|
| Bakerloo | 178, 99, 0 | `#B26300` |
| Central | 220, 36, 31 | `#DC241F` |
| Circle | 255, 200, 10 | `#FFC80A` |
| District | 0, 125, 50 | `#007D32` |
| Hammersmith & City | 245, 137, 166 | `#F589A6` |
| Jubilee | 131, 141, 147 | `#838D93` |
| Metropolitan | 155, 0, 88 | `#9B0058` |
| Northern | 0, 0, 0 | `#000000` |
| Piccadilly | 0, 25, 168 | `#0019A8` |
| Victoria | 3, 155, 229 | `#039BE5` |
| Waterloo & City | 118, 208, 189 | `#76D0BD` |
| Elizabeth line (§3 mode colour) | 96, 57, 158 | `#60399E` |

## 3. Assumptions and known limitations

- **Coordinates**: the workbook's X/Y are British National Grid. `scripts/lib/osgb.mjs` converts them to WGS84 with the inverse Transverse Mercator projection on the Airy 1830 ellipsoid and the Ordnance Survey 7-parameter Helmert transformation (accuracy about 2–5 m; not the centimetre-level OSTN15 grid). For all 273 records shared with the original CSV, this reproduces its WGS84 coordinates to within 0.5 m, so their cached isochrones were reused (8 whose coordinates differed in the 6th decimal place were regenerated).
- **Topology is never inferred from coordinates.** Track links are only consecutive stops in TfL `stopPointSequences`, from both directions. Branch sequences overlap at their junction station, so branches connect without inventing any links.
- **One documented correction** (`data/topology-overrides.json`): TfL's Metropolitan outbound data includes an alternative branch via Willesden Green, but Metropolitan trains do not call there. The inbound sequence and the CSV agree. Removing that stop collapses the branch into the existing Wembley Park–Finchley Road link. The validation report lists the correction, and the build fails if the TfL data changes so that it no longer applies.
- **Station identity**: one physical station can have several TfL stop records. Paddington, for example, has the Underground stop `940GZZLUPAC`, the Elizabeth line core stop `910GPADTLL` and the National Rail terminus stop `910GPADTON` used by some Elizabeth line trains; Liverpool Street likewise. A record links to a TfL stop when the record's ATCO code is that stop's id, when a documented alias says so, or when the names match after normalisation ("Stratford (London) Rail Station" → "Stratford" only if unambiguous). In every case the two points must also be within 500 m. Linked records and stops are grouped into one station. The station id is the Underground NaPTAN id where one exists; otherwise it is the Elizabeth line `910G…` id. Similar names alone never merge records, and the build fails if a group would join records with different names. Special cases (see `data/station-aliases.json`; the app shows these notes in the station popup):
  - **Paddington**: the data has two records (OBJECTID 125 and 171, 125 m apart). Both join one Paddington station (Bakerloo, Circle, District, Elizabeth line). OBJECTID 125 is closest to the TfL coordinate and is used; 171 is kept as a duplicate record. **Paddington (H&C Line)** is a separate station.
  - **Shared Underground / Elizabeth line stations** (one station each, with all their lines): Paddington, Bond Street, Tottenham Court Road, Farringdon, Liverpool Street, Whitechapel, Stratford, Canary Wharf, Ealing Broadway, and Heathrow Terminals 2 & 3, 4 and 5.
  - **Edgware Road (Circle Line)** and **Edgware Road (Bakerloo)** are separate stations about 170 m apart.
  - **Hammersmith (Dist&Picc Line)** and **Hammersmith (H&C Line)** are separate stations.
  - **Heathrow Terminals 2 & 3**: the workbook uses TfL's name. The old CSV name "Heathrow Terminals 1-2-3" remains an explicit alias.
  - **Shepherd's Bush** (Central) and **Shepherd's Bush Market** are different stations.
- **Line membership comes from the topology.** Four station-table line lists disagree with TfL: Paddington lists H&C; Paddington (H&C Line) and Hammersmith (H&C Line) omit Circle; Edgware Road (Circle Line) omits District and H&C. All four are reported, and the popup notes the difference.
- **Routes are straight segments between adjacent stations** at their real coordinates. They follow the correct station order but not the curved track alignment, because TfL Route Sequence has no track geometry.
- **Walking origin**: each isochrone starts at the supplied station coordinate, which is usually a centroid and not every entrance. At large stations, a real walk from a given entrance can differ by a minute or more.
- **Contours**: 5 and 10 minutes (the original 1- and 2-minute contours were removed on request). Each contour is cached and requested separately, so adding the 10-minute contour left the existing 5-minute polygons exactly as they were (same Valhalla output).
- **Walking assumptions**: foot travel only, no Tube time, 300 and 600 s (5 and 10 min), 1.4 m/s (Valhalla `walking_speed` 5.04 km/h). Valhalla settings: `denoise 0.1`, `generalize 3 m`. Closures, temporary restrictions and opening hours are not modelled.
- **Elizabeth line**: included as a normal line, from Reading and Heathrow in the west to Shenfield and Abbey Wood in the east. (Internally it keeps TfL's mode name `elizabeth-line`, which is needed for the TfL API and the longer validation limit described below.) Its outer sections run on National Rail tracks with long gaps between stations (Maidenhead–Twyford is ~10.9 km), so the validation limit for Elizabeth line links is 12 km instead of 8 km. East of the central tunnel, the line splits at **Whitechapel**: one branch goes to Stratford (towards Shenfield), the other to Canary Wharf (towards Abbey Wood). TfL's data also lists a few Shenfield trains running into the main-line platforms at Liverpool Street, which would draw an extra direct Liverpool Street–Stratford link. On request, that main-line platform stop is removed in `data/topology-overrides.json`, so only the Whitechapel branches are drawn. The Heathrow Terminals 2 & 3 → Terminal 4 and → Terminal 5 links are shared with the Piccadilly line and are drawn side by side.
- **Walking-area colours** are a teal-green ramp. The earlier violet ramp clashed with the Elizabeth line's purple. Teal is distinct from all line colours except, loosely, the much paler Waterloo & City (a two-station line drawn with a dark casing).
- London Overground, DLR, trams and National Rail are **out of scope** and not drawn.
- The screenshot mentioned in the original brief was not among the provided files, so the design does not depend on it.
- No circular-buffer mode exists, including for debugging. If isochrones are missing, the map shows stations and lines and says that walking areas are unavailable.

## 4. Folder tree

```
tube-walk-map/
├── README.md
├── package.json / package-lock.json
├── .env.example                  placeholder variables only
├── .gitignore
├── public/                       the web app (static)
│   ├── index.html
│   ├── styles.css
│   ├── config.example.js         copied to config.js (git-ignored) on install
│   ├── js/
│   │   ├── app.js                UI, map, selection, unions, errors
│   │   ├── union-worker.js       Web Worker for polygon unions
│   │   └── shared/
│   │       ├── config.js         line colours (TfL RGB), contours, bounds — single source of truth
│   │       ├── geometry.js       clean/union/area/simplify/point-in-polygon
│   │       └── selection.js      selection rules, summary text, search
│   ├── data/                     generated browser bundles
│   │   ├── network.js            stations, lines, edges          (~88 KB)
│   │   ├── isochrones.js         simplified station isochrones   (~430 KB)
│   │   └── coverage.js           precomputed per-line + all unions (~880 KB)
│   └── vendor/                   MapLibre + polygon-clipping (copied from node_modules, git-ignored)
├── server/
│   └── server.mjs                Express: static files, /api/health, /api/config, /api/isochrone
├── scripts/
│   ├── prepare-stations.mjs      xlsx/CSV (BNG → WGS84) → stations.clean.json (+ duplicate analysis)
│   ├── fetch-topology.mjs        TfL Unified API → data/raw/tfl/*.json + manifest
│   ├── build-network.mjs         join topology ↔ CSV → stations/edges/topology/network.js
│   ├── validate-network.mjs      → data/validation-report.json
│   ├── generate-isochrones.mjs   routing engine → per-station cache → isochrones.geojson/js
│   ├── generate-unions.mjs       per-line & network unions → coverage-unions.geojson / coverage.js
│   ├── build.mjs                 verify data + copy public/ → dist/
│   ├── vendor.mjs                postinstall copy of browser libraries
│   └── lib/
│       ├── common.mjs  csv.mjs  xlsx.mjs  osgb.mjs  names.mjs  http.mjs  isochrone-store.mjs
│       └── providers/  index.mjs  valhalla.mjs  openrouteservice.mjs
├── data/
│   ├── Underground_and_Elizabeth_Stations.xlsx   supplied input (default)
│   ├── stations.csv              original Underground-only input
│   ├── London_office_data.xlsx   office portfolio input
│   ├── London_office_sizes_sqm.xlsx / building-sizes.json   floor areas (sqm)
│   ├── geocode-cache.json / geocode-overrides.json
│   ├── buildings.json / buildings.geojson   geocoded buildings + walking-area membership
│   ├── station-aliases.json      reviewed join exceptions + special-case notes
│   ├── topology-overrides.json   reviewed topology corrections
│   ├── raw/tfl/                  raw TfL Route Sequence responses + manifest.json
│   ├── stations.clean.json       parsed CSV + parse issues
│   ├── stations.json             301 canonical physical stations
│   ├── network-edges.json        351 adjacent pairs with lines/directions/branches + per-line stats
│   ├── topology.geojson          one LineString per (edge, line) for GIS tools
│   ├── join-report.json          how every record was matched
│   ├── validation-report.json
│   ├── isochrones/<id>.json      per-station cache with provenance (+ _failures.json)
│   ├── isochrones.geojson        full-precision analysis copy (~630 KB)
│   └── coverage-unions.geojson   full-precision unions (~980 KB)
├── reports/
│   └── office-station-access.xlsx
└── tests/
    ├── data-validation.test.mjs
    ├── selection-logic.test.mjs
    └── geometry.test.mjs
```

## 5. Installation and running

Requirements: **Node.js ≥ 22.9** (for `--env-file-if-exists` and the built-in test runner).

```bash
cd tube-walk-map
```

```bash
npm install
```

`npm install` also copies MapLibre and polygon-clipping into `public/vendor/` and creates `public/config.js`.

Run the app (all generated data is committed, so no preprocessing is needed to try it):

```bash
npm start
```

Open http://localhost:8080. For development with automatic restart of the server:

```bash
npm run dev
```

You can also open `public/index.html` directly in a browser, with no server. Unions then run on the main thread and on-demand generation is off.

Production build (checks the data, then writes a self-contained static site to `dist/`):

```bash
npm run build
```

### Shareable single-file version

`npm run build` also writes **`dist/tube-walk-map.html`** (~2.7 MB). It is one self-contained file: styles, MapLibre, the app and all station, line and walking-area data are inlined. Email it or put it on any web host, and it opens in a browser with no install. Only the basemap tiles come from the internet (OpenFreeMap); offline, the map uses a plain background. Rebuild just this file with `npm run build:single`. The file is committed, so it is also in the repository at `tube-walk-map/dist/tube-walk-map.html`.

## Office buildings and the Excel report

```bash
npm run buildings      # parse workbook → geocode (cached) → import floor areas → assign to walking areas
```

```bash
npm run report         # write reports/office-station-access.xlsx (Python 3 + openpyxl)
```

- **Parsing** (`scripts/prepare-buildings.mjs`): the workbook has one block per company. A title row (e.g. "British land Development:") sets the company and whether the rows below are standing assets or developments. Trailing `+`/`*` footnote markers are removed from names and kept in `sourceMarker`.
- **Geocoding** (`scripts/geocode-buildings.mjs`): the workbook has addresses only, so positions come from OpenStreetMap Nominatim. Requests are rate-limited to ≤ 1 per second and every response is cached in `data/geocode-cache.json`, so re-runs make no requests.
  - A result is accepted only if it lies on the source street and within 9 km of central London.
  - A building-level hit without the house number is downgraded to street level.
  - 22 ambiguous or missing addresses use reviewed queries in `data/geocode-overrides.json`, each with a reason. For example, Langham Place W1 not Harringay, and Exchange Square EC2 not Croydon. The street check alone stops matches such as 70 *Victoria Street* landing on *Queen* Victoria Street.
  - Result: **89 building-level, 57 street-level and 3 area-level** positions. Street-level points sit on the right street but can be a few hundred metres from the building, so check those for buildings near the edge of a 5- or 10-minute area. **One Chapel Place** is listed as "1 Chapel Street" in the source; it is placed at Chapel Place W1G (Great Portland Estates' building), which should be confirmed.
- **Floor areas** (`scripts/import-sizes.mjs`): read from the "Property size" column (sqm) of the "All assets" sheet in `data/London_office_sizes_sqm.xlsx`, the annotated version of the report. Rows are joined on Asset ID and must also match on company and property name, otherwise the import stops. 148 of 149 buildings have a size (2,219,091 sqm in total). **Canada Water – Future Phases** (British Land) has 0 in the source; it is treated as unknown, not as zero, so it is left out of floor-area shares and the panel says so. In floor-area mode, each building counts with its sqm, so a share is "sqm within N minutes ÷ total sqm". Shares that would round to 100% or 0% without being exact are shown to one decimal place (for example, British Land ≤ 10 min: 99.6%). These shares match the SQM table in the annotated workbook's Distribution sheet, which a test checks.
- **Assignment** (`scripts/assign-buildings.mjs`): for every building and station, the smallest walking time (300/600 s) whose full-precision isochrone contains the building. In the app, a building is "within N min" of the current selection when any selected station's N-minute area contains it, which is the same as lying inside their union.
- **Map**: the points are circles with a dark outline. Buildings outside the largest selected walking time fade. Click a building for its company, status, address, walking time, stations and geocode precision.
- **Report** (`scripts/export-portfolio.py` → `reports/office-station-access.xlsx`):
  - **Summary**: per company, for all buildings, developments only and standing only: counts and cumulative % within ≤ 5 and ≤ 10 min and beyond. Plus key characteristics: development share of the portfolio, % of all buildings vs % of developments within 2 and 5 min, average distance to the nearest station, and % located at building level.
  - **Distribution**: the share of buildings in mutually exclusive bands (≤ 5, 5–10, > 10 min) per company and status.
  - **By line**: per company and line, the % of buildings within 5 and 10 min of a station on that line.
  - **All assets** and one sheet per company: every asset with its geocode, walking band, stations ≤ 5/10 min, lines, nearest station, and the best walking time to each line.
  - **Notes**: method, sources, caveats.
  - All statistics are live `COUNTIFS` formulas on "All assets" (721 formulas, verified with a LibreOffice recalculation: 0 errors).

## 6. Data preparation

```bash
npm run fetch-topology      # download TfL Route Sequence data (24 requests, ~35 s)
```

```bash
npm run data                # prepare-stations → build-network → validate
```

`npm run fetch-topology` keeps the previous files if the API is unreachable, and exits non-zero only when no usable copy exists. To get the topology by hand, save `https://api.tfl.gov.uk/Line/<line>/Route/Sequence/<outbound|inbound>` for each of the 12 line ids (`bakerloo central circle district hammersmith-city jubilee metropolitan northern piccadilly victoria waterloo-city elizabeth`) as `data/raw/tfl/<line>-<direction>.json`.

If your network uses an HTTPS proxy, run Node scripts with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) so `fetch()` respects `HTTPS_PROXY`.

## 7. Isochrone preprocessing

1. Configure the provider (optional for the default public Valhalla):

   ```bash
   cp .env.example .env
   ```

   - Valhalla (default): `ISOCHRONE_PROVIDER=valhalla`, `VALHALLA_URL=https://valhalla1.openstreetmap.de` (no key). For production, point `VALHALLA_URL` at a self-hosted instance.
   - openrouteservice: `ISOCHRONE_PROVIDER=openrouteservice` and `ORS_API_KEY=...` (free plan: 500 isochrone requests per day, 20 per minute; the script spaces requests ≥ 3.1 s apart).

2. Generate. Each station needs one request that returns all three contours. Completed stations are cached and skipped, so an interrupted run resumes where it stopped:

   ```bash
   npm run isochrones                              # all stations (~5 min on public Valhalla)
   ```

   ```bash
   npm run isochrones -- --line victoria           # one line
   ```

   ```bash
   npm run isochrones -- --station "Bank"          # one station (name or NaPTAN id)
   ```

   ```bash
   npm run isochrones -- --station 940GZZLUBNK --force   # regenerate even if cached
   ```

   ```bash
   npm run isochrones -- --provider openrouteservice --limit 100   # cap requests this run
   ```

   ```bash
   npm run isochrones -- --assemble-only           # rebuild combined files from cache only
   ```

   - Temporary failures (5xx, timeouts, network errors, 429 rate limits) are retried with exponential backoff and jitter, and `Retry-After` is honoured.
   - Authentication failures and exhausted daily quotas stop the run immediately with a clear message.
   - Failed stations are listed in `data/isochrones/_failures.json`. Re-running the command retries only those.
   - Each cache file records station id, provider, profile, parameters, a parameter hash (changing speed, provider or coordinates invalidates it), origin and timestamp.

3. Build the unions and re-validate:

   ```bash
   npm run unions
   ```

   ```bash
   npm run validate
   ```

Or run the whole pipeline: `npm run data:full`.

**On-demand generation (optional):** set `ENABLE_ON_DEMAND_ISOCHRONES=true` in `.env` and run `npm start`. Station popups for stations without a walking area then show a "Generate walking area" button. The server only accepts known station ids, rate-limits each client IP (`RATE_LIMIT_PER_MINUTE`), queues provider calls, merges duplicate requests and caches results to `data/isochrones/`.

## 8. Tests

```bash
npm test
```

Expected result: **50 tests, 50 pass, 0 fail**. The tests cover:

- **Data validation**: colours equal the PDF RGB values (including the Elizabeth line) and are defined only in the central config; the CSV parser handles quotes, CRLF, BOM and malformed rows; the xlsx reader and BNG conversion reproduce the original CSV coordinates; all 302 records and all 315 TfL stops join; the Elizabeth line has the correct termini, branches and shared stations; Paddington is deduplicated; Edgware Road, Hammersmith and Shepherd's Bush stay separate; interchanges have all their lines; every line forms one connected component; the termini of every line match reality (for example, the Northern line has Morden, Battersea Power Station, Edgware, High Barnet and Mill Hill East); branch junctions exist (Northern Euston–Camden Town and Euston–Mornington Crescent, Metropolitan Chesham/Watford/Uxbridge, District at Earl's Court with degree 5, the Central Hainault loop, the Piccadilly Heathrow loop); no Underground link is longer than 8 km and no Elizabeth line link longer than 12 km; the validation report has no errors.
- **Selection logic**: single and multiple lines, deduplication of interchanges (including Underground/Elizabeth line ones), manual add and remove, pruning of overrides, select all and clear all, summary text, search that ignores punctuation.
- **Geometry**: union of overlaps, holes and disjoint parts; skipping invalid geometry; simplification; radial-irregularity detection. For the generated data: every isochrone records a routing provider and profile; 5-minute ⊆ 10-minute by area; no area exceeds what 300 s / 600 s at 1.4 m/s allows; more than 90% are irregular (buffers would be circular); precomputed unions match fresh unions.

`npm run validate` writes `data/validation-report.json`. Its current status is `warnings` (four CSV line-list mismatches), with 0 errors, 0 unmatched stations or stops, 0 failed or missing isochrones (301/301), 0 invalid geometries, 0 nesting violations and 0 circular-looking polygons. The radial coefficient of variation of the 5-minute polygons has a median of 0.198.

## 9. Performance

| Scenario | Work | Observed |
|---|---|---|
| Page load | `network.js` ~100 KB first, then `isochrones.js` ~470 KB, then `coverage.js` ~970 KB, loaded progressively. All are gzip-friendly JSON, and gzip shrinks them by about 4× | Lines and stations render as soon as the style loads |
| One station | ≤ 3 polygons, no union needed beyond one call | Instant |
| One line (exact) | Precomputed line union reused | Instant |
| Several lines (exact) | Union of ≤ 11 precomputed line unions in the worker | Tens of ms |
| All lines | Precomputed network union | Instant |
| Arbitrary station sets | Union of up to 301 station polygons per threshold in the worker; cancellable, cached by selection | ~60–100 ms per threshold for all stations (measured in Node) |

The map never creates DOM elements per vertex. Polygons are WebGL layers updated with `setData`, station selection uses `feature-state`, and line visibility uses `setFilter`. Display copies are simplified (~1.5–2 m tolerance, 5 decimal places); full-precision copies stay in `data/` for analysis.

## 10. Production deployment

- **Static hosting** (simplest): `npm run build`, then upload `dist/` to any static host or CDN. Turn on gzip or brotli for `.js`. Remember that everything in `dist/` is public: never put keys in `config.js`.
- **With the API server**: `NODE_ENV=production npm start` behind a reverse proxy that terminates TLS. Set `TRUST_PROXY=true` so rate limiting sees client IPs. The server sends a strict CSP and `nosniff` headers. Health check: `GET /api/health`.
- **Routing provider**: for production or commercial use, self-host Valhalla with a Greater London OSM extract (for example the Geofabrik `greater-london-latest.osm.pbf` and the `ghcr.io/valhalla/valhalla-scripted` image). Then set `VALHALLA_URL=http://valhalla:8002` and `ISOCHRONE_MIN_INTERVAL_MS=50`. Do not run bulk jobs against the FOSSGIS public instance.
- **Basemap**: OpenFreeMap allows public use without a key. For high traffic, consider self-hosting tiles (OpenFreeMap or Protomaps PMTiles) and change `basemaps` in `public/config.js`. Do not point the app at `tile.openstreetmap.org`, whose usage policy forbids heavy app use.
- **Refreshing data**: run `npm run data:full` periodically, for example after TfL network changes. Review `data/validation-report.json`, then commit and deploy. Any unused override, disconnected line or over-long edge fails the build.
- **Secrets**: `.env` is git-ignored. `.env.example` contains placeholders only. Keys are read only by Node and are never sent to the browser.

## 11. Acceptance criteria checklist

| # | Criterion | Status | Where |
|---|---|---|---|
| A1 | Stations joined in authoritative route order | ✅ | `build-network.mjs` (TfL `stopPointSequences` only) |
| A2 | Branches and termini represented | ✅ | `network-edges.json` per-line termini and junctions; tests |
| A3 | No line cuts across London | ✅ | Longest Underground link 7.1 km (Finchley Road–Wembley Park, a real non-stop section); longest Elizabeth line link 10.9 km (Maidenhead–Twyford); tests |
| A4 | Interchanges show all lines | ✅ | `stations.json` `lines`; popup chips; tests |
| B1 | TfL digital RGB for every line | ✅ | `config.js`; test against PDF values |
| B2 | Colours defined centrally | ✅ | `config.js`; test that the app has no hard-coded line colours |
| C1 | 5- and 10-minute contours from a pedestrian routing engine (1 and 2 minutes removed on request) | ✅ | Valhalla `pedestrian`; provenance in each cache file |
| C2 | Shapes follow the network, not buffers | ✅ | Radial CV check in validation and tests |
| C3 | Line view combines all unique stations | ✅ | `selection.js`; `generate-unions.mjs` |
| C4 | Multi-line selection deduplicates interchanges | ✅ | NaPTAN-keyed selection; tests |
| C5 | True geometric unions | ✅ | polygon-clipping, one polygon set per threshold |
| D1 | Line changes update routes, stations and coverage immediately | ✅ | `onStateChange` (filters + feature-state + debounced union) |
| D2 | Independent contour toggles | ✅ | Three checkboxes; each layer toggled separately |
| D3 | Individual stations selectable | ✅ | Per-line station lists, search results, popup button |
| D4 | Mouse, touch and keyboard | ✅ | MapLibre handlers; all panel controls are native inputs and buttons; arrow keys in search |
| D5 | Usable at 320 px | ✅ | Bottom-sheet panel; checked at 320×640 with no horizontal scroll |
| E1 | Missing isochrones don't block lines and stations | ✅ | Progressive loading; checked by blocking `isochrones.js` |
| E2 | Readable API errors | ✅ | Server error mapping (auth, quota, rate limit, network, timeout); script messages |
| E3 | Cache prevents repeat API calls | ✅ | Per-station cache with parameter hash; browser union cache |
| F1 | README is enough to run the project | ✅ | This file |
| F2 | Commands for install, dev, preprocessing, tests and build | ✅ | §5–§8 |
| F3 | Sources and licences documented | ✅ | §2 and the in-app dialog |
| — | Basemap failure fallback | ✅ | Plain background plus a warning (checked by blocking tiles) |
| — | Light and dark mode | ✅ | Theme toggle (Auto, Light, Dark) with matching basemap and casings |
| — | DOM text sanitised | ✅ | Only `textContent` and DOM APIs; attribution strings are escaped |
