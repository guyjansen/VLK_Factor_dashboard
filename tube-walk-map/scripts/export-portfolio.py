#!/usr/bin/env python3
"""Export the office portfolio with walking-time access to stations.

Input : data/buildings.json, data/stations.json (from the Node pipeline)
Output: reports/office-station-access.xlsx

Sheets
  Summary        per-company statistics (live COUNTIFS formulas on 'All assets')
  Distribution   share of buildings per walking band (mutually exclusive bands)
  By line        per company and line: share of buildings within 1 / 2 / 5 min
  All assets     one row per property with its walking band, stations, lines
  <company>      the same rows, one sheet per company
  Notes          method, sources, assumptions
"""
import json
import os
import sys
from datetime import datetime, timezone

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'reports', 'office-station-access.xlsx')

LINES = [  # same order and names as public/js/shared/config.js
    ('bakerloo', 'Bakerloo'), ('central', 'Central'), ('circle', 'Circle'), ('district', 'District'),
    ('hammersmith-city', 'Hammersmith & City'), ('jubilee', 'Jubilee'), ('metropolitan', 'Metropolitan'),
    ('northern', 'Northern'), ('piccadilly', 'Piccadilly'), ('victoria', 'Victoria'),
    ('waterloo-city', 'Waterloo & City'), ('elizabeth', 'Elizabeth line')]
COMPANIES = [('Landsec', 'E8710A'), ('Great Portland Estates', 'C2185B'), ('British Land', '1565C0'), ('Derwent London', '8F6C00')]
BANDS = [(1, '≤ 1 min'), (2, '≤ 2 min'), (5, '≤ 5 min')]

FONT = 'Arial'
F = Font(name=FONT, size=10)
FB = Font(name=FONT, size=10, bold=True)
FH = Font(name=FONT, size=10, bold=True, color='FFFFFF')
FT = Font(name=FONT, size=14, bold=True)
FI = Font(name=FONT, size=9, italic=True, color='555555')
HEAD = PatternFill('solid', fgColor='0019A8')
SUB = PatternFill('solid', fgColor='E8EEFC')
TOTAL = PatternFill('solid', fgColor='F3F4F6')
THIN = Side(style='thin', color='D5D9DE')
BOX = Border(bottom=THIN)
PCT = '0%;-0%;"–"'
INT = '#,##0;-#,##0;"–"'


def load(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as fh:
        return json.load(fh)


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


def main():
    bdoc = load('data/buildings.json')
    sdoc = load('data/stations.json')
    st_by = {s['id']: s for s in sdoc['stations']}
    buildings = bdoc['buildings']
    line_name = dict(LINES)
    company_order = {c: i for i, (c, _) in enumerate(COMPANIES)}
    buildings.sort(key=lambda b: (company_order.get(b['company'], 99), b['status'] != 'Standing', b['name'].lower()))

    def best_for(b, line=None):
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
    cols = ['Asset ID', 'Company', 'Status', 'Property name', 'Property key', 'Property type', 'Address (source)',
            'Latitude', 'Longitude', 'Geocode precision', 'Geocoded as', 'Best walk time to a station (min)',
            'Walk band', 'Stations ≤ 1 min', 'Stations ≤ 2 min', 'Stations ≤ 5 min', 'Lines ≤ 5 min',
            'Nearest station (straight line)', 'Distance to nearest station (m)'] + [f'{n} (min)' for _, n in LINES]
    widths = [8, 20, 12, 34, 11, 11, 32, 10, 10, 11, 48, 12, 10, 26, 30, 40, 34, 24, 12] + [10] * len(LINES)

    def write_assets(ws, rows, first_data_row=2):
        header(ws, 1, cols, widths=widths)
        for r, b in enumerate(rows, start=first_data_row):
            best = best_for(b)
            lines5 = sorted({l for sid in b['stations'] for l in st_by[sid]['lines']}, key=[x for x, _ in LINES].index)
            vals = [b['id'], b['company'], b['status'], b['name'], b['propertyKey'], b['propertyType'], b['street'],
                    b['lat'], b['lon'], b['geocode']['precision'], b['geocode']['displayName'], best,
                    f'=IF(L{r}="","> 5 min",IF(L{r}<=1,"≤ 1 min",IF(L{r}<=2,"1–2 min","2–5 min")))',
                    names_within(b, 1), names_within(b, 2), names_within(b, 5),
                    ', '.join(line_name[l] for l in lines5),
                    (b.get('nearestStation') or {}).get('name'), (b.get('nearestStation') or {}).get('distanceM')]
            vals += [best_for(b, lid) for lid, _ in LINES]
            for c, v in enumerate(vals, start=1):
                cell = ws.cell(row=r, column=c, value=v)
                cell.font = F
                cell.border = BOX
                if c in (8, 9):
                    cell.number_format = '0.00000'
                elif c in (12, 19) or c >= 20:
                    cell.number_format = '0' if c != 19 else INT
                    cell.alignment = Alignment(horizontal='center')
            fill = dict(COMPANIES).get(b['company'])
            if fill:
                ws.cell(row=r, column=2).fill = PatternFill('solid', fgColor=lighten(fill, 0.8 if b['status'] == 'Standing' else 0.9))
            if b['geocode'].get('note'):
                ws.cell(row=r, column=11).comment = Comment('Reviewed geocoding query: ' + b['geocode']['query'] + '\n' + b['geocode']['note'], 'tube-walk-map')
        ws.freeze_panes = 'E2'
        ws.auto_filter.ref = f'A1:{get_column_letter(len(cols))}{first_data_row + len(rows) - 1}'

    write_assets(assets, buildings)
    n = len(buildings)
    last = n + 1
    A = lambda col: f"'All assets'!${col}$2:${col}${last}"  # noqa: E731
    COMPANY, STATUS, BEST, PREC, DIST = A('B'), A('C'), A('L'), A('J'), A('S')

    for cname, colour in COMPANIES:
        ws = wb.create_sheet(cname[:31])
        write_assets(ws, [b for b in buildings if b['company'] == cname])
        ws.sheet_properties.tabColor = colour

    # ---------------------------------------------------------------- Summary
    s = summary
    s['A1'] = 'Office portfolios: walking access to London Underground and Elizabeth line stations'
    s['A1'].font = FT
    s['A2'] = ('Share of each company’s buildings inside the 1-, 2- and 5-minute pedestrian walking areas of any of the 301 stations '
               '(12 lines). Percentages are cumulative (≤ 5 min includes ≤ 1 min). All figures are formulas on the "All assets" sheet.')
    s['A2'].font = FI
    s.merge_cells('A2:N2')
    s.row_dimensions[2].height = 30
    s['A2'].alignment = Alignment(wrap_text=True, vertical='top')

    def company_table(top, title, status):
        s.cell(row=top, column=1, value=title).font = FB
        labels = ['Company', 'Buildings'] + [x for m, lab in BANDS for x in (f'{lab} (n)', f'{lab} (%)')] + ['> 5 min (n)', '> 5 min (%)']
        header(s, top + 1, labels)
        crit_status = f',{STATUS},"{status}"' if status else ''
        rows = []
        for i, (cname, colour) in enumerate(COMPANIES):
            r = top + 2 + i
            rows.append(r)
            s.cell(row=r, column=1, value=cname).fill = PatternFill('solid', fgColor=lighten(colour))
            s.cell(row=r, column=2, value=f'=COUNTIFS({COMPANY},$A{r}{crit_status})')
            col = 3
            for m, _ in BANDS:
                s.cell(row=r, column=col, value=f'=COUNTIFS({COMPANY},$A{r}{crit_status},{BEST},"<={m}")')
                s.cell(row=r, column=col + 1, value=f'=IF($B{r}=0,0,{get_column_letter(col)}{r}/$B{r})')
                col += 2
            s.cell(row=r, column=col, value=f'=$B{r}-{get_column_letter(col - 2)}{r}')
            s.cell(row=r, column=col + 1, value=f'=IF($B{r}=0,0,{get_column_letter(col)}{r}/$B{r})')
        tr = rows[-1] + 1
        s.cell(row=tr, column=1, value='All companies')
        for c in range(2, 3 + 2 * len(BANDS) + 2):
            L = get_column_letter(c)
            if c % 2 == 0 and c > 2:  # % columns
                prev = get_column_letter(c - 1)
                s.cell(row=tr, column=c, value=f'=IF($B{tr}=0,0,{prev}{tr}/$B{tr})')
            else:
                s.cell(row=tr, column=c, value=f'=SUM({L}{rows[0]}:{L}{rows[-1]})')
        for r in rows + [tr]:
            for c in range(1, 3 + 2 * len(BANDS) + 2):
                cell = s.cell(row=r, column=c)
                cell.font = FB if r == tr else F
                cell.border = BOX
                if c >= 2:
                    cell.number_format = PCT if (c % 2 == 0 and c > 2) else INT
                    cell.alignment = Alignment(horizontal='center')
                if r == tr:
                    cell.fill = TOTAL
        return tr

    end = company_table(4, 'All buildings (standing assets + developments)', None)
    end = company_table(end + 3, 'Developments only (% of each company’s developments)', 'Development')
    end = company_table(end + 3, 'Standing assets only', 'Standing')

    # Key characteristics
    top = end + 3
    s.cell(row=top, column=1, value='Key characteristics per company').font = FB
    labels = ['Company', 'Buildings', 'Developments', 'Developments as % of portfolio', '% of all buildings ≤ 5 min',
              '% of developments ≤ 5 min', '% of all buildings ≤ 2 min', '% of developments ≤ 2 min',
              'Average distance to nearest station (m)', 'Located at building level (%)']
    header(s, top + 1, labels)
    rows = []
    for i, (cname, colour) in enumerate(COMPANIES):
        r = top + 2 + i
        rows.append(r)
        s.cell(row=r, column=1, value=cname).fill = PatternFill('solid', fgColor=lighten(colour))
        f = [
            f'=COUNTIFS({COMPANY},$A{r})',
            f'=COUNTIFS({COMPANY},$A{r},{STATUS},"Development")',
            f'=IF(B{r}=0,0,C{r}/B{r})',
            f'=IF(B{r}=0,0,COUNTIFS({COMPANY},$A{r},{BEST},"<=5")/B{r})',
            f'=IF(C{r}=0,0,COUNTIFS({COMPANY},$A{r},{STATUS},"Development",{BEST},"<=5")/C{r})',
            f'=IF(B{r}=0,0,COUNTIFS({COMPANY},$A{r},{BEST},"<=2")/B{r})',
            f'=IF(C{r}=0,0,COUNTIFS({COMPANY},$A{r},{STATUS},"Development",{BEST},"<=2")/C{r})',
            f'=IFERROR(AVERAGEIFS({DIST},{COMPANY},$A{r}),0)',
            f'=IF(B{r}=0,0,COUNTIFS({COMPANY},$A{r},{PREC},"building")/B{r})'
        ]
        for c, v in enumerate(f, start=2):
            cell = s.cell(row=r, column=c, value=v)
            cell.number_format = INT if c in (2, 3, 9) else PCT
            cell.alignment = Alignment(horizontal='center')
        for c in range(1, 11):
            s.cell(row=r, column=c).font = F
            s.cell(row=r, column=c).border = BOX
    note_r = rows[-1] + 2
    s.cell(row=note_r, column=1, value=('Walking areas: Valhalla pedestrian routing on OpenStreetMap data at 1.4 m/s from each station coordinate. '
                                        'Building positions were geocoded from street addresses (Nominatim/OpenStreetMap); street- and area-level matches are approximate. '
                                        'See the Notes sheet.')).font = FI
    s.merge_cells(start_row=note_r, start_column=1, end_row=note_r, end_column=14)
    s.cell(row=note_r, column=1).alignment = Alignment(wrap_text=True, vertical='top')
    s.row_dimensions[note_r].height = 42
    s.column_dimensions['A'].width = 26
    for c in range(2, 15):
        s.column_dimensions[get_column_letter(c)].width = 13
    s.freeze_panes = 'B4'

    # ----------------------------------------------------------- Distribution
    d = dist
    d['A1'] = 'Share of buildings per walking-time area (mutually exclusive bands)'
    d['A1'].font = FT
    d['A2'] = 'Each building is counted once, in the band of its shortest walk to any station. Formulas on the "All assets" sheet.'
    d['A2'].font = FI
    bands = [('≤ 1 min', '"<=1"', None), ('1–2 min', '">1"', '"<=2"'), ('2–5 min', '">2"', '"<=5"')]
    labels = ['Company', 'Status', 'Buildings'] + [x for b in bands for x in (f'{b[0]} (n)', f'{b[0]} (%)')] + ['> 5 min (n)', '> 5 min (%)']
    header(d, 4, labels, widths=[26, 14, 11] + [11] * 8)
    r = 5
    for cname, colour in COMPANIES:
        for status in ['All', 'Standing', 'Development']:
            d.cell(row=r, column=1, value=cname).fill = PatternFill('solid', fgColor=lighten(colour))
            d.cell(row=r, column=2, value=status)
            sc = '' if status == 'All' else f',{STATUS},$B{r}'
            d.cell(row=r, column=3, value=f'=COUNTIFS({COMPANY},$A{r}{sc})')
            col = 4
            for _, lo, hi in bands:
                crit = f',{BEST},{lo}' + (f',{BEST},{hi}' if hi else '')
                d.cell(row=r, column=col, value=f'=COUNTIFS({COMPANY},$A{r}{sc}{crit})')
                d.cell(row=r, column=col + 1, value=f'=IF($C{r}=0,0,{get_column_letter(col)}{r}/$C{r})')
                col += 2
            d.cell(row=r, column=col, value=f'=$C{r}-D{r}-F{r}-H{r}')
            d.cell(row=r, column=col + 1, value=f'=IF($C{r}=0,0,{get_column_letter(col)}{r}/$C{r})')
            for c in range(1, col + 2):
                cell = d.cell(row=r, column=c)
                cell.font = FB if status == 'All' else F
                cell.border = BOX
                if c >= 3:
                    cell.number_format = PCT if c >= 5 and c % 2 == 1 else INT
                    cell.alignment = Alignment(horizontal='center')
            r += 1
    d.freeze_panes = 'C5'

    # ---------------------------------------------------------------- By line
    bl = byline
    bl['A1'] = 'Share of each company’s buildings within walking distance of each line'
    bl['A1'].font = FT
    bl['A2'] = ('A building counts for a line when it is inside the walking area of any station on that line. A building near an interchange counts for every line there, so rows do not add up to 100%.')
    bl['A2'].font = FI
    bl.merge_cells('A2:M2')
    bl['A2'].alignment = Alignment(wrap_text=True, vertical='top')
    bl.row_dimensions[2].height = 30
    row = 4
    first_line_col = 20  # column T in All assets
    for m, lab in BANDS:
        bl.cell(row=row, column=1, value=f'Buildings {lab} of a station on the line').font = FB
        header(bl, row + 1, ['Company'] + [n for _, n in LINES], widths=[26] + [12] * len(LINES))
        for i, (cname, colour) in enumerate(COMPANIES):
            r = row + 2 + i
            bl.cell(row=r, column=1, value=cname).fill = PatternFill('solid', fgColor=lighten(colour))
            bl.cell(row=r, column=1).font = F
            for j in range(len(LINES)):
                rng = A(get_column_letter(first_line_col + j))
                cell = bl.cell(row=r, column=2 + j, value=f'=IF(COUNTIFS({COMPANY},$A{r})=0,0,COUNTIFS({COMPANY},$A{r},{rng},"<={m}")/COUNTIFS({COMPANY},$A{r}))')
                cell.number_format = PCT
                cell.font = F
                cell.alignment = Alignment(horizontal='center')
                cell.border = BOX
        row += len(COMPANIES) + 4
    bl.freeze_panes = 'B4'

    # ------------------------------------------------------------------ Notes
    nt = wb.create_sheet('Notes')
    meta = bdoc['meta']
    lines = [
        ('Generated', datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')),
        ('Portfolio source', 'London_office_data.xlsx (supplied). Section titles define company and status: rows under "… developments" are Development; all other rows are Standing. Trailing "+" and "*" markers on property names are footnote markers in the source and were removed from names.'),
        ('Stations', '301 physical stations on the 11 London Underground lines and the Elizabeth line (Underground_and_Elizabeth_Stations.xlsx, joined to TfL Unified API route data).'),
        ('Walking areas', 'Pedestrian isochrones of 1, 2 and 5 minutes from each station coordinate, computed with Valhalla (pedestrian costing, 5.04 km/h ≈ 1.4 m/s) on OpenStreetMap data. Isochrones generated ' + ' – '.join(x[:10] for x in (meta.get('isochrones', {}).get('generatedBetween') or []) if x) + '. They follow the street network, so they are not circles.'),
        ('Method', 'A building is "within N min" when its point lies inside the N-minute walking area of at least one station (point-in-polygon on full-precision polygons). "Best walk time" is the smallest such N. Blank means more than 5 minutes from every station.'),
        ('Geocoding', 'The source has street addresses only. Positions come from Nominatim (OpenStreetMap). Each result had to lie on the source street. Ambiguous addresses used reviewed queries with the postal district (see comments in the "Geocoded as" column). Precision: building = house or building matched; street = street matched without house number (point is on the street, possibly hundreds of metres from the building); area = locality only.'),
        ('Caveats', 'Station coordinates are centroids, not entrances. 1-minute results are very sensitive to this. Street- and area-level geocodes can move a building between bands. Check those rows before relying on 1- and 2-minute figures.'),
        ('Attribution', 'Station and route data: Powered by TfL Open Data. Map and routing data © OpenStreetMap contributors (ODbL). Unofficial analysis; not affiliated with or endorsed by Transport for London or the listed companies.'),
    ]
    nt['A1'] = 'Notes, method and sources'
    nt['A1'].font = FT
    for i, (k, v) in enumerate(lines, start=3):
        nt.cell(row=i, column=1, value=k).font = FB
        c = nt.cell(row=i, column=2, value=v)
        c.font = F
        c.alignment = Alignment(wrap_text=True, vertical='top')
        nt.cell(row=i, column=1).alignment = Alignment(vertical='top')
        nt.row_dimensions[i].height = max(18, 15 * (len(v) // 95 + 1))
    nt.column_dimensions['A'].width = 18
    nt.column_dimensions['B'].width = 110

    for ws in wb.worksheets:
        ws.sheet_view.showGridLines = ws.title in ('All assets',) or ws.title in dict(COMPANIES)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    wb.save(OUT)
    print(f'Wrote {os.path.relpath(OUT, ROOT)} ({n} assets)')


if __name__ == '__main__':
    sys.exit(main())
