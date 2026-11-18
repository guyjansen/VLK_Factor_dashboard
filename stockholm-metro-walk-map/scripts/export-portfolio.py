#!/usr/bin/env python3
"""Export the portfolio with walking-time access to Stockholm metro stations.

Input : data/buildings.json, data/stations.json (Node pipeline),
        public/js/shared/config.js (lines, companies, colours, thresholds; read via node)
Output: reports/stockholm-metro-portfolio-access.xlsx
        reports/report-checks.json (expected values per checked cell, computed
        independently in Python from the pipeline data; used by verify-report.py)

Sheets
  Summary        cumulative shares (≤ 5, ≤ 10 min) by count and by floor area,
                 for all / standing / development, per company
  Distribution   exclusive bands (≤ 5, 5–10, > 10 min), by count and floor area
  By line        per company and line: share within each threshold
  All assets     one row per property (geocode, precision, walk band, stations
                 per band, lines, nearest station, best minutes per line, floor area)
  <company>      the same rows, one sheet per company
  Notes          method, sources, caveats

Every statistic is a live COUNTIFS / SUMIFS formula on the "All assets" sheet.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.styles.differential import DifferentialStyle
from openpyxl.styles.numbers import NumberFormat
from openpyxl.utils import get_column_letter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'reports', 'stockholm-metro-portfolio-access.xlsx')
CHECKS = os.path.join(ROOT, 'reports', 'report-checks.json')


def load_config():
    js = ("const C=require(process.argv[1]);process.stdout.write(JSON.stringify({lines:C.LINES,companies:C.COMPANIES,"
          "contours:C.CONTOURS,statuses:C.STATUSES,speed:C.WALKING_SPEED_MPS}))")
    out = subprocess.run(['node', '-e', js, os.path.join(ROOT, 'public', 'js', 'shared', 'config.js')],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def load(path):
    p = os.path.join(ROOT, path)
    if not os.path.exists(p):
        sys.exit(f'ERROR: missing {path}. Run the pipeline first (npm run buildings).')
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


CFG = load_config()
LINES = [(l['id'], l['name'], l['colour'].lstrip('#')) for l in CFG['lines']]
COMPANIES = [(c['name'], c['colour'].lstrip('#')) for c in CFG['companies']]
MINUTES = [c['minutes'] for c in CFG['contours']]  # e.g. [5, 10]
MAXM = MINUTES[-1]

FONT = 'Arial'
F = Font(name=FONT, size=10)
FB = Font(name=FONT, size=10, bold=True)
FH = Font(name=FONT, size=10, bold=True, color='FFFFFF')
FT = Font(name=FONT, size=14, bold=True)
FI = Font(name=FONT, size=9, italic=True, color='555555')
HEAD = PatternFill('solid', fgColor='2B3A4F')
TOTAL = PatternFill('solid', fgColor='F3F4F6')
THIN = Side(style='thin', color='D5D9DE')
BOX = Border(bottom=THIN)
PCT = '0.0%'
INT = '#,##0;-#,##0;"–"'
SQM = '#,##0" m²";-#,##0;"–"'


def lighten(hex6, t=0.75):
    rgb = [int(hex6[i:i + 2], 16) for i in (0, 2, 4)]
    return ''.join('%02X' % round(v + (255 - v) * t) for v in rgb)


def header(ws, row, labels, col=1, widths=None):
    for i, text in enumerate(labels):
        c = ws.cell(row=row, column=col + i, value=text)
        c.font, c.fill = FH, HEAD
        c.alignment = Alignment(wrap_text=True, vertical='center', horizontal='center' if i else 'left')
    ws.row_dimensions[row].height = 32
    if widths:
        for i, w in enumerate(widths):
            ws.column_dimensions[get_column_letter(col + i)].width = w


def style_row(ws, r, ncols, fmt_by_col, bold=False, fill=None):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=r, column=c)
        cell.font = FB if bold else F
        cell.border = BOX
        if c in fmt_by_col:
            cell.number_format = fmt_by_col[c]
            cell.alignment = Alignment(horizontal='center')
        if fill:
            cell.fill = fill


def guard_pct(ws, rng):
    """Never display a rounded 100% / 0% that is not exact (conditional number formats)."""
    hi = DifferentialStyle(numFmt=NumberFormat(numFmtId=170, formatCode='">99.9%"'))
    lo = DifferentialStyle(numFmt=NumberFormat(numFmtId=171, formatCode='"<0.1%"'))
    r1 = CellIsRule(operator='between', formula=['0.9995', '0.99999999'])
    r1.dxf = hi
    r2 = CellIsRule(operator='between', formula=['0.00000001', '0.0005'])
    r2.dxf = lo
    ws.conditional_formatting.add(rng, r1)
    ws.conditional_formatting.add(rng, r2)


def main():
    bdoc = load('data/buildings.json')
    sdoc = load('data/stations.json')
    st_by = {s['id']: s for s in sdoc['stations']}
    buildings = bdoc['buildings']
    line_name = {lid: n for lid, n, _ in LINES}
    company_order = {c: i for i, (c, _) in enumerate(COMPANIES)}
    buildings.sort(key=lambda b: (company_order.get(b['company'], 99), not b['inAnalysis'], b['id']))
    checks = []

    def best(b, line=None):
        vals = [sec for sid, sec in b['stations'].items() if line is None or line in st_by[sid]['lines']]
        return min(vals) // 60 if vals else None

    def names_within(b, minutes):
        return ', '.join(sorted({st_by[sid]['name'] for sid, sec in b['stations'].items() if sec <= minutes * 60}))

    wb = Workbook()
    summary = wb.active
    summary.title = 'Summary'
    dist = wb.create_sheet('Distribution')
    byline = wb.create_sheet('By line')
    assets = wb.create_sheet('All assets')

    # ------------------------------------------------------------ All assets
    cols = ['Asset ID', 'Company', 'Status', 'Source classification', 'Property name', 'Region', 'Area', 'Address (source)',
            'Municipality', 'In analysis', 'Not in analysis because', 'Latitude', 'Longitude', 'Geocode precision',
            'Geocoded as', 'Geocode query', 'Floor area (sqm)', 'Property type (from area mix)', 'Construction year (source)', 'Year built (latest; map colour)',
            'Best walk to any station (min)', 'Walk band'] + \
           [f'Stations ≤ {m} min' for m in MINUTES] + [f'Lines ≤ {MAXM} min', 'Nearest station (straight line)',
                                                      'Distance to nearest station (m)', 'Nearest station lines'] + \
           [f'{n} (min)' for _, n, _ in LINES]
    widths = [12, 10, 12, 14, 22, 18, 18, 36, 12, 9, 34, 10, 10, 11, 48, 30, 12, 30, 13, 12, 12, 15] + [34] * len(MINUTES) + \
             [26, 20, 12, 18] + [11] * len(LINES)
    CI = {name: i + 1 for i, name in enumerate(cols)}
    L = lambda name: get_column_letter(CI[name])  # noqa: E731
    first_line_col = CI[f'{LINES[0][1]} (min)']

    def write_assets(ws, rows):
        header(ws, 1, cols, widths=widths)
        for r, b in enumerate(rows, start=2):
            inA = b['inAnalysis']
            g = b['geocode']
            nearest = b.get('nearestStation') or {}
            lines_in = sorted({l for sid, sec in b['stations'].items() if sec <= MAXM * 60 for l in st_by[sid]['lines']},
                              key=[x for x, _, _ in LINES].index)
            vals = {
                'Asset ID': b['id'], 'Company': b['company'], 'Status': b['status'], 'Source classification': b['classification'],
                'Property name': b['name'], 'Region': b['region'], 'Area': b['area'], 'Address (source)': b['street'],
                'Municipality': b['municipality'], 'In analysis': 'Yes' if inA else 'No',
                'Not in analysis because': b['notInAnalysisReason'], 'Latitude': b['lat'], 'Longitude': b['lon'],
                'Geocode precision': g['precision'], 'Geocoded as': g.get('displayName'), 'Geocode query': g.get('query'),
                'Floor area (sqm)': b['sqm'] if b['sqm'] else None, 'Property type (from area mix)': b['propertyType'],
                'Construction year (source)': b.get('constructionYear'), 'Year built (latest; map colour)': b.get('yearBuilt'),
                'Best walk to any station (min)': best(b) if inA else None,
                'Walk band': (f'=IF({L("In analysis")}{r}="No","Not in analysis",IF({L("Best walk to any station (min)")}{r}="",'
                              f'"> {MAXM} min",IF({L("Best walk to any station (min)")}{r}<={MINUTES[0]},"≤ {MINUTES[0]} min",'
                              f'"{MINUTES[0]}–{MAXM} min")))'),
                f'Lines ≤ {MAXM} min': ', '.join(line_name[l] for l in lines_in) if inA else None,
                'Nearest station (straight line)': nearest.get('name'), 'Distance to nearest station (m)': nearest.get('distanceM'),
                'Nearest station lines': ', '.join(line_name[l] for l in nearest.get('lines', [])) or None,
            }
            for m in MINUTES:
                vals[f'Stations ≤ {m} min'] = names_within(b, m) if inA else None
            for lid, n, _ in LINES:
                vals[f'{n} (min)'] = best(b, lid) if inA else None
            for name, v in vals.items():
                cell = ws.cell(row=r, column=CI[name], value=v)
                cell.font = F
                cell.border = BOX
                if name in ('Latitude', 'Longitude'):
                    cell.number_format = '0.00000'
                elif name == 'Floor area (sqm)':
                    cell.number_format = '#,##0'
                elif name == 'Distance to nearest station (m)':
                    cell.number_format = '#,##0'
                elif name == 'Best walk to any station (min)' or name.endswith('(min)'):
                    cell.number_format = '0'
                    cell.alignment = Alignment(horizontal='center')
            fill = dict(COMPANIES).get(b['company'])
            if fill:
                ws.cell(row=r, column=CI['Company']).fill = PatternFill('solid', fgColor=lighten(fill, 0.55 if b['status'] == 'Standing' else 0.8))
            if g.get('note') and g.get('method') == 'override':
                ws.cell(row=r, column=CI['Geocoded as']).comment = Comment('Reviewed override: ' + g['note'], 'stockholm-metro-walk-map')
            if not b['sqm'] and inA:
                ws.cell(row=r, column=CI['Floor area (sqm)']).comment = Comment('0 or blank in the source: unknown, excluded from floor-area shares.', 'stockholm-metro-walk-map')
        ws.freeze_panes = 'F2'
        ws.auto_filter.ref = f'A1:{get_column_letter(len(cols))}{len(rows) + 1}'

    write_assets(assets, buildings)
    n = len(buildings)
    last = n + 1
    A = lambda name: f"'All assets'!${L(name)}$2:${L(name)}${last}"  # noqa: E731
    COMPANY, STATUS, INA, BEST, SQMR, PREC = (A('Company'), A('Status'), A('In analysis'),
                                              A('Best walk to any station (min)'), A('Floor area (sqm)'), A('Geocode precision'))
    for cname, colour in COMPANIES:
        ws = wb.create_sheet(cname[:31])
        write_assets(ws, [b for b in buildings if b['company'] == cname])
        ws.sheet_properties.tabColor = colour

    # Python-side truth for verification
    def truth(company, status, lo=None, hi=None, line=None, by_sqm=False):
        sel = [b for b in buildings if b['inAnalysis'] and b['company'] == company and (status in (None, 'All') or b['status'] == status)]
        if by_sqm:
            sel = [b for b in sel if b['sqm']]
        def ok(b):
            v = best(b, line)
            if lo is None and hi is None:
                return True
            if v is None:
                return False
            return (lo is None or v > lo) and (hi is None or v <= hi)
        pick = [b for b in sel if ok(b)]
        return sum(b['sqm'] for b in pick) if by_sqm else len(pick)

    # ---------------------------------------------------------------- Summary
    s = summary
    s['A1'] = 'Portfolio walking access to Stockholm metro stations'
    s['A1'].font = FT
    nst = len([x for x in sdoc['stations'] if x['lines']])
    s['A2'] = (f'Share of each company’s properties inside the {" and ".join(map(str, MINUTES))}-minute pedestrian walking areas of any of the '
               f'{nst} metro stations ({len(LINES)} lines). Shares are cumulative (≤ {MAXM} min includes ≤ {MINUTES[0]} min). Only properties '
               'in the analysis count (located, inside the Stockholm scope). Floor-area shares leave out properties with unknown floor area. '
               'All figures are live formulas on the "All assets" sheet.')
    s['A2'].font = FI
    s.merge_cells('A2:L2')
    s.row_dimensions[2].height = 44
    s['A2'].alignment = Alignment(wrap_text=True, vertical='top')

    def block(top, title, by_sqm):
        s.cell(row=top, column=1, value=title).font = FB
        unit = 'sqm' if by_sqm else 'n'
        labels = ['Company', 'Scope', f'Total ({unit})'] + [x for m in MINUTES for x in (f'≤ {m} min ({unit})', f'≤ {m} min (%)')] + \
                 ([f'Unknown floor area (n)'] if by_sqm else ['Not in analysis (n)'])
        header(s, top + 1, labels)
        r = top + 2
        for cname, colour in COMPANIES:
            for scope in ['All'] + CFG['statuses']:
                sc = '' if scope == 'All' else f',{STATUS},"{scope}"'
                base = f'{COMPANY},$A{r},{INA},"Yes"{sc}'
                s.cell(row=r, column=1, value=cname).fill = PatternFill('solid', fgColor=lighten(colour))
                s.cell(row=r, column=2, value=scope)
                total = f'=SUMIFS({SQMR},{base})' if by_sqm else f'=COUNTIFS({base})'
                s.cell(row=r, column=3, value=total)
                checks.append({'sheet': 'Summary', 'cell': f'C{r}', 'expected': truth(cname, scope, by_sqm=by_sqm)})
                col = 4
                for m in MINUTES:
                    f = f'=SUMIFS({SQMR},{base},{BEST},"<={m}")' if by_sqm else f'=COUNTIFS({base},{BEST},"<={m}")'
                    s.cell(row=r, column=col, value=f)
                    s.cell(row=r, column=col + 1, value=f'=IF($C{r}=0,0,{get_column_letter(col)}{r}/$C{r})')
                    checks.append({'sheet': 'Summary', 'cell': f'{get_column_letter(col)}{r}', 'expected': truth(cname, scope, hi=m, by_sqm=by_sqm)})
                    col += 2
                extra = (f'=COUNTIFS({base},{SQMR},"")' if by_sqm else
                         f'=COUNTIFS({COMPANY},$A{r},{INA},"No"{sc})')
                s.cell(row=r, column=col, value=extra)
                style_row(s, r, col, {c: (SQM if by_sqm else INT) if c in [3] + [4 + 2 * i for i in range(len(MINUTES))] else PCT
                                      for c in range(3, col)} | {col: INT}, bold=scope == 'All')
                r += 1
        guard_pct(s, f'D{top + 2}:{get_column_letter(3 + 2 * len(MINUTES))}{r - 1}')
        return r

    end = block(4, 'By number of properties (cumulative)', False)
    end = block(end + 2, 'By floor area, sqm (cumulative; total lettable area from the source)', True)

    top = end + 2
    s.cell(row=top, column=1, value='Geocode precision of the properties in the analysis').font = FB
    header(s, top + 1, ['Company', 'Building', 'Street', 'Area', 'Unlocated', 'Excluded (out of scope)'])
    r = top + 2
    for cname, colour in COMPANIES:
        s.cell(row=r, column=1, value=cname).fill = PatternFill('solid', fgColor=lighten(colour))
        for i, p in enumerate(['building', 'street', 'area', 'unlocated', 'excluded']):
            s.cell(row=r, column=2 + i, value=f'=COUNTIFS({COMPANY},$A{r},{PREC},"{p}")')
            checks.append({'sheet': 'Summary', 'cell': f'{get_column_letter(2 + i)}{r}',
                           'expected': len([b for b in buildings if b['company'] == cname and b['geocode']['precision'] == p])})
        style_row(s, r, 6, {c: INT for c in range(2, 7)})
        r += 1
    note_r = r + 1
    s.cell(row=note_r, column=1, value=('Walking areas: Valhalla pedestrian routing on OpenStreetMap data at 1.4 m/s from each station’s operator coordinate '
                                        '(centroid, not entrance). Property positions geocoded from street addresses (Nominatim); street- and area-level '
                                        'matches are approximate. Percentages between 99.95% and 100% show as ">99.9%", and between 0% and 0.05% as "<0.1%", '
                                        'so a rounded 100% or 0% is always exact. See Notes.')).font = FI
    s.merge_cells(start_row=note_r, start_column=1, end_row=note_r, end_column=12)
    s.cell(row=note_r, column=1).alignment = Alignment(wrap_text=True, vertical='top')
    s.row_dimensions[note_r].height = 44
    s.column_dimensions['A'].width = 16
    s.column_dimensions['B'].width = 13
    for c in range(3, 13):
        s.column_dimensions[get_column_letter(c)].width = 14
    s.freeze_panes = 'C4'

    # ----------------------------------------------------------- Distribution
    d = dist
    d['A1'] = 'Properties per walking band (mutually exclusive bands)'
    d['A1'].font = FT
    d['A2'] = ('Each property in the analysis is counted once, in the band of its shortest walk to any station. '
               'Floor-area columns leave out properties with unknown floor area. Formulas on the "All assets" sheet.')
    d['A2'].font = FI
    bands = [(f'≤ {MINUTES[0]} min', None, MINUTES[0])] + [(f'{MINUTES[i - 1]}–{MINUTES[i]} min', MINUTES[i - 1], MINUTES[i]) for i in range(1, len(MINUTES))]
    labels = ['Company', 'Status', 'Properties'] + [x for b in bands for x in (f'{b[0]} (n)', f'{b[0]} (%)')] + [f'> {MAXM} min (n)', f'> {MAXM} min (%)'] + \
             ['Floor area (sqm)'] + [x for b in bands for x in (f'{b[0]} (sqm)', f'{b[0]} (%)')] + [f'> {MAXM} min (sqm)', f'> {MAXM} min (%)']
    header(d, 4, labels, widths=[16, 13, 11] + [11] * (len(labels) - 3))
    r = 5
    for cname, colour in COMPANIES:
        for status in ['All'] + CFG['statuses']:
            d.cell(row=r, column=1, value=cname).fill = PatternFill('solid', fgColor=lighten(colour))
            d.cell(row=r, column=2, value=status)
            sc = '' if status == 'All' else f',{STATUS},$B{r}'
            base = f'{COMPANY},$A{r},{INA},"Yes"{sc}'
            fmts = {}
            for k, by_sqm in enumerate([False, True]):
                c0 = 3 + k * (2 + 2 * len(bands) + 1)
                tot = f'=SUMIFS({SQMR},{base})' if by_sqm else f'=COUNTIFS({base})'
                d.cell(row=r, column=c0, value=tot)
                fmts[c0] = SQM if by_sqm else INT
                col = c0 + 1
                for _, lo, hi in bands:
                    crit = (f',{BEST},">{lo}"' if lo is not None else '') + f',{BEST},"<={hi}"'
                    f = f'=SUMIFS({SQMR},{base}{crit})' if by_sqm else f'=COUNTIFS({base}{crit})'
                    d.cell(row=r, column=col, value=f)
                    d.cell(row=r, column=col + 1, value=f'=IF(${get_column_letter(c0)}{r}=0,0,{get_column_letter(col)}{r}/${get_column_letter(c0)}{r})')
                    checks.append({'sheet': 'Distribution', 'cell': f'{get_column_letter(col)}{r}', 'expected': truth(cname, status, lo=lo, hi=hi, by_sqm=by_sqm)})
                    fmts[col], fmts[col + 1] = (SQM if by_sqm else INT), PCT
                    col += 2
                band_cells = '-'.join(f'{get_column_letter(c0 + 1 + 2 * i)}{r}' for i in range(len(bands)))
                d.cell(row=r, column=col, value=f'={get_column_letter(c0)}{r}-{band_cells}')
                d.cell(row=r, column=col + 1, value=f'=IF(${get_column_letter(c0)}{r}=0,0,{get_column_letter(col)}{r}/${get_column_letter(c0)}{r})')
                tot_truth = truth(cname, status, by_sqm=by_sqm)
                checks.append({'sheet': 'Distribution', 'cell': f'{get_column_letter(col)}{r}',
                               'expected': tot_truth - truth(cname, status, hi=MAXM, by_sqm=by_sqm)})
                fmts[col], fmts[col + 1] = (SQM if by_sqm else INT), PCT
            style_row(d, r, max(fmts), fmts, bold=status == 'All')
            r += 1
    for k in range(2):
        c0 = 3 + k * (2 + 2 * len(bands) + 1)
        for i in range(len(bands) + 1):
            col = get_column_letter(c0 + 2 + 2 * i)
            guard_pct(d, f'{col}5:{col}{r - 1}')
    d.freeze_panes = 'C5'

    # ---------------------------------------------------------------- By line
    bl = byline
    bl['A1'] = 'Share of each company’s properties within walking distance of each line'
    bl['A1'].font = FT
    bl['A2'] = ('A property counts for a line when it lies inside the walking area of any station on that line. A property near an interchange '
                'counts for every line there, so rows do not add up to 100%. Shares of properties in the analysis (count) and of known floor area.')
    bl['A2'].font = FI
    bl.merge_cells('A2:J2')
    bl['A2'].alignment = Alignment(wrap_text=True, vertical='top')
    bl.row_dimensions[2].height = 32
    row = 4
    for by_sqm in (False, True):
        for m in MINUTES:
            bl.cell(row=row, column=1, value=f'{"Floor area" if by_sqm else "Properties"} ≤ {m} min of a station on the line').font = FB
            header(bl, row + 1, ['Company', 'Scope'] + [n for _, n, _ in LINES], widths=[16, 13] + [14] * len(LINES))
            for l, (_, _, lc) in enumerate(LINES):
                bl.cell(row=row + 1, column=3 + l).fill = PatternFill('solid', fgColor=lc)
            r = row + 2
            for cname, colour in COMPANIES:
                for scope in ['All'] + CFG['statuses']:
                    bl.cell(row=r, column=1, value=cname).fill = PatternFill('solid', fgColor=lighten(colour))
                    bl.cell(row=r, column=2, value=scope)
                    sc = '' if scope == 'All' else f',{STATUS},$B{r}'
                    base = f'{COMPANY},$A{r},{INA},"Yes"{sc}'
                    for j, (lid, _, _) in enumerate(LINES):
                        rng = A(f'{LINES[j][1]} (min)')
                        if by_sqm:
                            f = f'=IF(SUMIFS({SQMR},{base})=0,0,SUMIFS({SQMR},{base},{rng},"<={m}")/SUMIFS({SQMR},{base}))'
                            tot = truth(cname, scope, by_sqm=True)
                            exp = truth(cname, scope, hi=m, line=lid, by_sqm=True) / tot if tot else 0
                        else:
                            f = f'=IF(COUNTIFS({base})=0,0,COUNTIFS({base},{rng},"<={m}")/COUNTIFS({base}))'
                            tot = truth(cname, scope)
                            exp = truth(cname, scope, hi=m, line=lid) / tot if tot else 0
                        bl.cell(row=r, column=3 + j, value=f)
                        checks.append({'sheet': 'By line', 'cell': f'{get_column_letter(3 + j)}{r}', 'expected': exp})
                    style_row(bl, r, 2 + len(LINES), {c: PCT for c in range(3, 3 + len(LINES))}, bold=scope == 'All')
                    r += 1
            guard_pct(bl, f'C{row + 2}:{get_column_letter(2 + len(LINES))}{r - 1}')
            row = r + 2
    bl.freeze_panes = 'C4'
    _ = first_line_col

    # ------------------------------------------------------------------ Notes
    nt = wb.create_sheet('Notes')
    meta = bdoc['meta']
    gen = meta.get('isochrones', {}).get('generatedBetween') or []
    prec = meta.get('precisionCounts', {})
    notin = '; '.join(f"{x['id']} {x['name']}: {x['reason']}" for x in meta.get('notInAnalysis', []))
    lines = [
        ('Generated', datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')),
        ('Portfolio source', 'FABG_property_list_FY25.xlsx (supplied), sheet "Properties". Asset ID = FAB-<region code>-<listing no.>. '
                             'Status: Standing = source classification "Investment"; Development = "Development" or "Land & project" (decision confirmed by the user). '
                             'The source classification is kept in its own column.'),
        ('Scope', f'Not in the analysis (listed on "All assets", never counted): {notin or "none"}.'),
        ('Stations and lines', f'{nst} physical metro stations on {len(LINES)} lines (' + ', '.join(f"{n} {'/'.join(l['routes'])}" for (lid, n, _), l in zip(LINES, CFG['lines'])) +
                               '), from SL\'s static GTFS (Trafiklab / Samtrafiken, CC0): every distinct stop sequence of every metro trip. Interchanges count once.'),
        ('Walking areas', f'Pedestrian isochrones of {" and ".join(map(str, MINUTES))} minutes from each station coordinate, Valhalla (pedestrian costing, '
                          f'{CFG["speed"] * 3.6:.2f} km/h = {CFG["speed"]} m/s) on OpenStreetMap data, generated ' +
                          ' – '.join(x[:10] for x in gen if x) + '. They follow the street network; they are not circles.'),
        ('Method', f'A property is "within N min" when its point lies inside the N-minute walking area of at least one station (point-in-polygon on '
                   f'full-precision polygons). "Best walk" is the smallest such N; per-line columns use only that line\'s stations. Blank = more than {MAXM} min.'),
        ('Geocoding', 'The source has street addresses only (abbreviated street names such as "Döbelnsg" were expanded). Positions come from Nominatim (OpenStreetMap), '
                      'structured search first; a result had to lie on the source street and within 30 km of the city centre. Ambiguous or missing addresses '
                      'use reviewed overrides (see comments in "Geocoded as"). Precision counts: ' + ', '.join(f'{k} {v}' for k, v in prec.items()) +
                      '. building = house number matched; street = street matched without the house number (can be a few hundred metres off); '
                      'area = district or same-quarter neighbour only.'),
        ('Construction year', 'Source column "Construction year". Where two years are given (e.g. 1902/2002) the latest is used for the map colour (blue = old, red = new); blank = unknown (grey on the map).'),
        ('Floor area', 'Total lettable area (sqm) from the same workbook, joined by asset ID with a company and property-name check. '
                       '0 or blank = unknown: excluded from floor-area shares (not treated as zero).'),
        ('Caveats', 'Station coordinates are operator centroids, not entrances; a real walk can differ by a minute or more. Street- and area-level positions '
                    'can move a property between bands. Check those rows before relying on borderline cases.'),
        ('Attribution', 'Timetable data: SL via Trafiklab.se (CC0). Line colours: SL. Map, routing and geocoding data © OpenStreetMap contributors (ODbL). '
                        'Unofficial analysis; not affiliated with or endorsed by SL, Region Stockholm or Fabege.'),
    ]
    nt['A1'] = 'Notes, method and sources'
    nt['A1'].font = FT
    for i, (k, v) in enumerate(lines, start=3):
        nt.cell(row=i, column=1, value=k).font = FB
        c = nt.cell(row=i, column=2, value=v)
        c.font = F
        c.alignment = Alignment(wrap_text=True, vertical='top')
        nt.cell(row=i, column=1).alignment = Alignment(vertical='top')
        nt.row_dimensions[i].height = max(18, 14 * (len(v) // 100 + 1))
    nt.column_dimensions['A'].width = 18
    nt.column_dimensions['B'].width = 115

    for ws in wb.worksheets:
        ws.sheet_view.showGridLines = ws.title == 'All assets' or ws.title in dict(COMPANIES)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    wb.save(OUT)
    with open(CHECKS, 'w', encoding='utf-8') as fh:
        json.dump({'workbook': os.path.relpath(OUT, ROOT), 'generatedAt': datetime.now(timezone.utc).isoformat(), 'checks': checks}, fh, indent=1)
    print(f'Wrote {os.path.relpath(OUT, ROOT)} ({n} assets, {len(checks)} checked cells) and {os.path.relpath(CHECKS, ROOT)}')


if __name__ == '__main__':
    sys.exit(main())
