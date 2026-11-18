# Starter prompt: transit walking-access map + office portfolio analysis

Copy everything below the line into a new chat, then fill in or attach the items marked {{…}}.

---

You are a senior geospatial web engineer. Build a complete, working, tested project (not a description of one): an interactive map of how far you can walk from rapid-transit stations in **{{CITY}}**, with the office portfolios of several companies plotted on it, plus an Excel report. Inspect every attached file before writing code. If information is missing or ambiguous, ask me before guessing. Never fabricate data.

## Inputs I will provide
- **City / network scope:** {{CITY}}; lines or modes to include: {{e.g. metro lines A–F + regional rail line X; exclude buses/trams}}.
- **Station file:** {{file}}. Say what coordinate system it uses (WGS84 lon/lat or a national grid such as EPSG:27700) and which columns hold the name, the lines, and an id/ATCO/stop code.
- **Official line colours:** {{PDF/brand guide or RGB list}}. Use the digital/RGB values, defined once in a central config.
- **Portfolio file(s):** {{file}}: companies, standing assets vs developments, addresses (and coordinates or floor area, if available).
- **Companies:** {{list}}. Developments use a lighter shade of the company colour.
- **Walking-time thresholds:** {{e.g. 5 and 10 minutes}} at ~1.4 m/s.

## Non-negotiable data rules
1. **Topology comes from an authoritative source, never from coordinates.** Use the operator's API or GTFS (stop sequences per route/branch, both directions). Never connect stations by sorting, nearest neighbour or coordinates. Store the raw downloads together with a manifest (URL, retrieval date, licence).
2. **Station identity = one physical station.** Several operator stop records (different modes or platforms of the same complex) are grouped into one station. A record links to a stop only on an ID/ATCO code match, a documented alias, or an equal normalised name; it must also be within ~500 m. Similar names alone never merge records. Keep genuinely separate complexes separate. Document every special case.
3. **Corrections only through a reviewed overrides file,** each entry with a reason. The build fails if an override no longer applies. If I ask for a topology change, implement it this way and document it.
4. **Walking areas must be real pedestrian-network isochrones** from a routing engine (Valhalla default; openrouteservice as an alternative), behind a small provider adapter. No circles or buffers, not even as a fallback. Record provider, profile, parameters, origin and timestamp. Note that station coordinates are centroids, not entrances.
5. **Cache per station and per contour,** keyed by a hash of the parameters. Runs resume, failures are retried with backoff and listed, and rate limits are respected. Adding a threshold later fetches only the new contour, so existing polygons stay identical.
6. **Unions are true geometric unions** (polygon-clipping or equivalent), one per threshold, with interchange stations counted once. Precompute per-line and all-network unions; compute other selections in a Web Worker with cancellation.
7. **Geocoding** (when assets have no coordinates): use Nominatim or an equivalent within its usage policy (≤ 1 request/s, cache everything).
   - Prefer a structured search.
   - Reject results that are not on the source street or are implausibly far from the city centre.
   - Downgrade the precision to "street" when the house number isn't matched.
   - Fix ambiguous addresses with reviewed overrides (add the postal district).
   - Record the precision (building/street/area) for every asset and report the counts.
   - Hand-check a sample. Free-text geocoding often lands on similarly named streets in other districts.
8. **Joining extra attributes** (e.g. floor area) is done by asset ID plus a company/name check, and the import stops on any mismatch. Treat 0 or blank values as **unknown, not zero**: exclude them from shares and say so in the UI.
9. **Coordinate conversion** (if needed): implement it, then verify it against a known WGS84 copy or reference points.

## Application requirements
- **Map:** MapLibre GL JS with a free, policy-compliant basemap (e.g. OpenFreeMap). Fall back to a plain background if tiles fail. Plot geographically, not schematically. Include zoom, scale, attribution, fit-to-selection, and a light/dark theme.
- **Lines:** official colours with casings. Shared track is drawn side by side using consistent per-edge offsets.
- **Controls:** select all / clear all; per-line checkboxes with an expandable station list (manual add/remove); station search; a toggle per threshold; union vs individual polygon view; opacity; show/hide routes, stations and buildings; reset. A live summary such as "3 lines · 58 unique stations · 5- and 10-minute coverage".
- **Buildings:** points coloured per company (developments lighter) with a dark outline; faded when outside the selected walking times. Filters by company and standing/development. Popups show company, status, type, address, floor area, walking time, stations within reach, nearest station and geocode precision.
- **Live statistics table:** per company, the % of all / standing / development within each selected threshold for the current station selection, with a **count ↔ floor-area toggle**. Hovering shows absolute values. Never show a rounded 100% or 0% that isn't exact.
- **Robustness:** isochrones, unions and buildings load progressively, and lines and stations still work if any of them fail. Show readable error banners. Sanitise all DOM text (textContent only).
- **Accessibility:** keyboard operable, labelled controls, ARIA live summary, focus states, not colour-only (outline dash patterns per threshold), usable at 320 px (the panel becomes a bottom sheet).
- **Disclaimer** (unofficial, not endorsed by the operator), plus an "About & data" dialog with method, limitations, sources, licences, provider and generation dates.

## Architecture
- Node.js scripts (ESM) for the pipeline. Browser code is classic scripts with shared UMD modules (config, geometry, selection) so the page works from `file://`. Data is shipped as generated `window.X = {...}` JS files, not fetched JSON.
- An optional Express server with an on-demand isochrone proxy: keys come from `.env` only, with rate limiting and only known station IDs accepted.
- Minimal pinned dependencies. Tests with `node:test`. `.env.example` contains placeholders only.
- A **single self-contained shareable HTML** build (everything inlined; only basemap tiles need the internet) plus a static `dist/`.
- **Excel report** (openpyxl, Arial):
  - **All assets** sheet, plus one sheet per company: geocode, precision, best walk band, stations per band, lines, nearest station, best minutes per line, floor area.
  - **Summary:** cumulative shares by count and by floor area, for all, standing and development.
  - **Distribution:** exclusive bands.
  - **By line:** per company and line.
  - **Notes:** method and caveats.
  - All statistics are live COUNTIFS/SUMIFS formulas. Recalculate and verify zero formula errors, and that the values match the pipeline.

## Pipeline (npm scripts)
`fetch-topology` → `prepare-stations` → `build-network` → `validate` → `isochrones` → `unions` → `buildings` (prepare, geocode, sizes, assign) → `report` → `build`. Each step is idempotent and cached, and gives a clear error when its input is missing.

## Validation and tests (must pass)
- **Colours:** equal the official RGB values and are defined only in the config.
- **Stations:** every record and every stop joins (or each exception is explained); no merges of conflicting names; known separate complexes stay separate.
- **Network:** each line is one connected component; the termini and branch junctions of every line match reality (write explicit assertions per line); no implausibly long edges (limit set per mode).
- **Isochrones:** valid, nested by threshold, within the physical maximum radius, irregular (not circles); precomputed unions equal fresh ones.
- **Selection:** deduplicates interchanges; manual add/remove works.
- **Buildings:** parsing counts per company and status; geocode sanity (inside the city, known traps); fresh point-in-polygon checks; the size join; shares cross-checked against any reference table I supply; a syntax check of all browser scripts.
- `validation-report.json`: unmatched records, duplicates, line-name mismatches, overrides applied, disconnected segments, isochrone checks.
- **Browser check:** headless browser at desktop and 320 px, from the server and from the single file, with no console errors; screenshots reviewed.

## Process expectations
- Check network access early. If hosts are blocked, request access for the specific hosts (operator API, routing engine, geocoder, tiles) instead of working around it.
- Keep public services within their usage policies (≤ 1 request/s, identifying user agent, cache everything). Recommend self-hosting for production.
- After each change, regenerate the dependent data, run the tests, rebuild the single HTML file, commit with a clear message, push to the designated branch, and send me the HTML/Excel files.
- Report honestly: what was verified and how, what is approximate (geocode precision, centroid origins), every assumption or override I should confirm, and the headline results.
- Document everything in the README: setup and run commands, data sources and licences, assumptions and limitations, special cases, performance, deployment, and an acceptance checklist.
- Choose a new colour scheme for the walking-time fills and the company colours that doesn't clash with the city's line colours.
