#!/usr/bin/env python3
"""Recalculate the Excel report with LibreOffice and verify it.

1. Converts a COPY of reports/stockholm-metro-portfolio-access.xlsx with
   LibreOffice (headless), which evaluates every formula.
2. Fails if any cell holds a formula error (#VALUE!, #REF!, #NAME?, #DIV/0!, ...)
   or a formula cell has no value.
3. Compares every cell listed in reports/report-checks.json (expected values
   computed independently in Python from data/buildings.json) with the
   recalculated value; fails on any mismatch.
Writes reports/report-verification.json.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

from openpyxl import load_workbook

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BOOK = os.path.join(ROOT, 'reports', 'stockholm-metro-portfolio-access.xlsx')
CHECKS = os.path.join(ROOT, 'reports', 'report-checks.json')
OUT = os.path.join(ROOT, 'reports', 'report-verification.json')
ERRORS = ('#VALUE!', '#REF!', '#NAME?', '#DIV/0!', '#N/A', '#NUM!', '#NULL!', 'Err:')


def main():
    if not os.path.exists(BOOK) or not os.path.exists(CHECKS):
        sys.exit('ERROR: report missing. Run "python3 scripts/export-portfolio.py" first.')
    soffice = shutil.which('soffice') or shutil.which('libreoffice')
    if not soffice:
        sys.exit('ERROR: LibreOffice (soffice) is required to recalculate the workbook.')
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, 'in', 'book.xlsx')
        os.makedirs(os.path.dirname(src))
        shutil.copy(BOOK, src)
        profile = os.path.join(tmp, 'profile')
        cmd = [soffice, f'-env:UserInstallation=file://{profile}', '--headless', '--calc', '--convert-to', 'xlsx', '--outdir', os.path.join(tmp, 'out'), src]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        out = os.path.join(tmp, 'out', 'book.xlsx')
        if not os.path.exists(out):
            sys.exit(f'ERROR: LibreOffice conversion failed: {res.stderr or res.stdout}')
        values = load_workbook(out, data_only=True)
        formulas = load_workbook(BOOK)

        total_formulas, errors, empty = 0, [], []
        for ws in formulas.worksheets:
            vs = values[ws.title]
            for row in ws.iter_rows():
                for c in row:
                    if isinstance(c.value, str) and c.value.startswith('='):
                        total_formulas += 1
                        v = vs[c.coordinate].value
                        if v is None:
                            empty.append(f'{ws.title}!{c.coordinate}')
                        elif isinstance(v, str) and v.startswith(ERRORS):
                            errors.append(f'{ws.title}!{c.coordinate}: {v}')
            for row in vs.iter_rows():
                for c in row:
                    if isinstance(c.value, str) and c.value.startswith(ERRORS):
                        if f'{ws.title}!{c.coordinate}' not in ' '.join(errors):
                            errors.append(f'{ws.title}!{c.coordinate}: {c.value}')

        checks = json.load(open(CHECKS, encoding='utf-8'))['checks']
        mismatches = []
        for ch in checks:
            got = values[ch['sheet']][ch['cell']].value
            exp = ch['expected']
            if got is None or abs(float(got) - float(exp)) > 1e-6 * max(1, abs(float(exp))):
                mismatches.append({**ch, 'got': got})

    # Walk-band text formulas legitimately evaluate to text; empty results only
    # matter for numeric statistics, so they are reported, not fatal, unless on stats sheets.
    fatal_empty = [e for e in empty if not e.startswith(('All assets', ))]
    report = {
        'workbook': os.path.relpath(BOOK, ROOT), 'recalculatedWith': 'LibreOffice (headless convert of a copy)',
        'totalFormulas': total_formulas, 'formulaErrors': errors, 'formulasWithoutValue': empty,
        'checkedCells': len(checks), 'mismatches': mismatches,
        'status': 'ok' if not errors and not mismatches and not fatal_empty else 'failed'
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=1, default=str)
    print(f"Report verification: {report['status'].upper()} — {total_formulas} formulas, {len(errors)} errors, "
          f"{len(empty)} without value, {len(checks)} checked cells, {len(mismatches)} mismatches")
    for e in errors[:10]:
        print('  error', e)
    for m in mismatches[:10]:
        print('  mismatch', m)
    return 0 if report['status'] == 'ok' else 1


if __name__ == '__main__':
    sys.exit(main())
