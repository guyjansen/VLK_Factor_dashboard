# Morning real estate RNS report

`rns_report.py` collects the day's London Stock Exchange announcements (RNS) for real estate companies and puts the full text of all of them into one document. A scheduled task starts it just before 07:00 UK time. It polls from 07:00, fetches the announcement texts in parallel and writes the report. On a normal morning the file is ready by about 07:04 UK, well before 07:08.

It needs only Python 3.9 or later. There are no packages to install and no browser is needed, so it works without Chrome. It uses the Windows proxy settings and certificate store, as Edge does.

## Output

Each run writes two files to `rns_report\output\`:

| File | Use |
| --- | --- |
| `RNS_RealEstate_YYYY-MM-DD.html` | The report. It opens in Word or Edge and keeps the tables from the announcements. To send it, paste it into an Outlook message or save it from Word as .docx or PDF. |
| `RNS_RealEstate_YYYY-MM-DD.txt` | The same content as plain text. |

The report opens with an index of all announcements (time, company, headline) followed by each full announcement with a link to the original. If an announcement's text cannot be retrieved, the report says so and gives the link. The status line at the top names the source used and how many items failed. A log of each run is kept in `output\logs\`.

## Sources

1. **Investegate** advanced search: RNS, sector 18 (real estate), including NAV, Rule 8 and similar notices. The script calls the same endpoint the page uses to fill its results table (`/advanced-search/draw`).
2. **London Stock Exchange** news explorer: sectors 302030, 351010 and 351020, regulatory and non-regulatory headlines. It is used if Investegate fails, and also checked when Investegate has nothing yet.

The two sites classify companies slightly differently. On 15 October, for example, Investegate listed Mindflair and LSE listed IWG, RentGuarantor and Town Centre Securities. Use `--source lse` to make LSE the only source.

## Setup on the work laptop

1. Copy the `rns_report` folder anywhere, for example `Documents\rns_report`.
2. Check that Python is available: open a Command Prompt and run `py --version` or `python --version`. If neither works, install Python from the Company Portal or Software Center, or from python.org (the per-user installer needs no admin rights).
3. Check the sources from your network:
   ```
   cd %USERPROFILE%\Documents\rns_report
   py rns_report.py --diagnose
   ```
   This tries each source, reports how many announcements it found and prints the start of one announcement. It saves the raw pages in `output\debug\`. At least one source must show rows and body text.
4. Schedule it:
   ```
   py rns_report.py --install-task
   ```
   This creates the weekday task *RNS Real Estate Morning Report*. It starts at 06:58 UK time, which is 07:58 on a laptop set to Amsterdam time; the UK and EU change clocks on the same dates. The task wakes the laptop from sleep and runs without a console window. If the laptop was off at that time, the task runs as soon as it is back on and builds the report for the whole day. To pick a different start time, use `--install-task 06:55`. To remove the task, run `schtasks /Delete /TN "RNS Real Estate Morning Report" /F`.

The laptop must be switched on (asleep is fine), you must be logged in (a locked screen is fine) and it must be on a network at 07:00 UK.

## Running by hand

| Command | What it does |
| --- | --- |
| Double-click `run_report.bat` | Builds today's report now and opens it |
| `py rns_report.py` | The morning routine: waits for 07:00 UK, polls until 07:03:30, writes the report |
| `py rns_report.py --once` | One pass now, no waiting |
| `py rns_report.py --once --since 07:00` | Only announcements released at or after 07:00 |
| `py rns_report.py --exclude-navs` | Leaves out NAV, EMM/EPT, Rule 8 (Form 8.3/8.5) and FRN rate-fix notices |
| `py rns_report.py --once --date 2026-10-15` | Report for an earlier day |
| `py rns_report.py --source lse` | Use only the LSE site |

## Timing

| UK time | Step |
| --- | --- |
| 06:58 | Task starts, waits |
| 07:00:02 | First poll. New announcements are fetched in parallel (8 at a time) and the report is written straight away. |
| Every 15 s | Polls again for announcements that are indexed late. The report is rewritten when new items appear. |
| 07:03:30 | Final write. The status line no longer says "still checking". |
| 07:07 | Latest stop if both sources keep failing. A report is still written, stating the error. |

`--start`, `--settle`, `--give-up` and `--poll` change these times.

## If something breaks

- **Status line shows "SOURCES FAILED"**: run `--diagnose` and look at the files in `output\debug\`. A 403 error usually means the site is blocking scripted requests from your network.
- **Text missing for one announcement**: the report links to it. Failed texts are retried on every poll until 07:03:30. To try again later, double-click `run_report.bat`.
- **A site changes its layout**: the parsers are in `rns_report.py` (`parse_investegate_list`, `parse_lse_list`, `extract_body`). The offline tests in `tests/test_rns_report.py` run against copies of both list pages saved on 15 October 2026.
