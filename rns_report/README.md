# Morning real estate RNS report

Every weekday at 07:01 UK time (08:01 Amsterdam), this collects that morning's London Stock Exchange announcements (RNS) from real estate companies. It writes their full text into one Markdown file, ready to drag into an LLM: `Documents\RNS Reports\RNS_RealEstate_<date>.md`. It runs on its own on any Windows computer. Python comes inside the kit, so nothing needs to be installed and no browser is needed.

This page is for the person setting it up. Users get `HOW TO USE.txt`, a one-page guide inside the kit.

## Get the kit

GitHub builds the kit each time anything in `rns_report/` changes:

1. On GitHub, open **Actions** > **Build RNS report kit** and click the latest green run.
2. Under **Artifacts**, download **RNS-Report-kit**. Artifacts are kept for 90 days. To build a new one, click **Run workflow** on the same page.
3. Before unzipping, right-click the zip > **Properties** > tick **Unblock** > **OK**. This stops Windows warning about every file.
4. Unzip. Put the folder on a shared drive such as `K:\Property\...\RNS Report`, or copy it to each computer.

The kit contains:

| File | For |
| --- | --- |
| `Install.bat` | One-time setup on a computer (see below). Run it again after changing `run_time_uk` or `days` in the settings. |
| `Run now.bat` | Make today's file straight away and open the reports folder |
| `Test connection.bat` | Check the sources and open `probe_summary.txt`, the file to send when something is wrong |
| `Uninstall.bat` | Remove the daily task (reports are kept) |
| `settings.ini` | Time, output folder, days, formats, whether to leave out Form 8 disclosures |
| `llm_instructions.txt` | The prompt added to the end of each file |
| `HOW TO USE.txt` | One-page guide for the user |
| `python\` | Private copy of Python (the embeddable package from python.org) |
| `rns_report.py` | The program |

## Set up a computer

Log in as the user, or have them do it, and double-click `Install.bat` in the kit. It:

1. Copies the kit to `%LOCALAPPDATA%\RNS Report`, so the task keeps working when the shared drive is not connected.
2. Creates the output folder, `Documents\RNS Reports` by default (OneDrive-redirected Documents folders are handled).
3. Creates the scheduled task *RNS Real Estate Morning Report*. It runs on weekdays, starts 2 minutes before `run_time_uk` and wakes the computer from sleep. If the computer was off, it runs as soon as it is back on and builds the file for the whole day.
4. Adds a desktop shortcut **RNS Reports**, plus a **Make today's report now** shortcut inside that folder.
5. Checks that Investegate can be reached.

Each line it prints should start with `[ok]`. No admin rights are needed. If the scheduled task is refused, the computer's policy blocks Task Scheduler for users and IT has to allow it.

**What the computer needs:** it must be switched on or asleep (not shut down) at 07:01 UK, the user must be logged in (a locked screen is fine), and it must be on the network.

**Time zones:** the task's start time is converted to the computer's clock at install, and the UK and the Netherlands change their clocks on the same days. On a computer in a time zone that changes clocks on other dates, run `Install.bat` again after each change.

## The daily file

`RNS_RealEstate_<date>.md` is plain text in Markdown, which every LLM reads well:

```
# Real estate RNS announcements: Thursday 15 October 2026
Status: 6 announcement(s); source: Investegate; generated 07:02:41 UK

## Index
| # | Time (UK) | Company | Ticker | Headline |
| 1 | 07:00 | Big Yellow Group | BYG | Response to media coverage |
...
## 1. Big Yellow Group (BYG): Response to media coverage
Released: 15 October 2026, 07:00 UK
Link: https://www.investegate.co.uk/announcement/...

15 October 2026
Big Yellow Group PLC
...the announcement as issued, tables as Markdown tables, through to the notes to editors...

## Instructions
...the text of llm_instructions.txt...
```

- **What goes in:** only announcements dated today (UK). At 07:01 that means the 07:00 batch. A run later in the day also includes anything released since. Each filing appears once.
- **What each entry holds:** the announcement exactly as issued. Left out are Investegate's own header, AI summary and adverts, and the standard RNS footer ("This information is provided by RNS ... END").
- **Instructions:** `llm_instructions.txt` is appended at the end, because LLMs follow instructions best after the material. With that, dragging the file in and pressing Enter is enough. Edit the text to change what the LLM picks out, or delete it to give the prompt yourself.
- **Status line:** it shows how many announcements there are and the source used. If something went wrong, it says `WARNING` or `SOURCES FAILED`.
- **Timing:** the file first appears at about 07:01:15 UK. It is updated if late announcements arrive, and is final at 07:03 (`final_time_uk`).
- **Word copy:** a `.docx` copy is written alongside for people who want to read it themselves. Set `formats = md` in `settings.ini` to write only the Markdown.

## Settings

`settings.ini` (in `%LOCALAPPDATA%\RNS Report` after install):

| Setting | Default | Meaning |
| --- | --- | --- |
| `output_folder` | empty = `Documents\RNS Reports` | Where the daily files go |
| `run_time_uk` | `07:01` | When the file is made. Run `Install.bat` again after changing it. |
| `final_time_uk` | `07:03` | Keep checking for late announcements until then |
| `exclude_form8_and_nav` | `no` | `yes` leaves out Form 8.3/8.5 takeover disclosures, NAV and similar routine notices |
| `formats` | `md, docx` | Any of `md`, `docx`, `html`, `txt` |
| `days` | `weekdays` | `weekdays` or `daily`. Run `Install.bat` again after changing it. |

## Sources

1. **Investegate** advanced search: RNS, sector 18 (Real Estate). The script opens the search page as a browser would, then makes the request the page uses to fill its results table. It rejects answers that contain other newswires, since that would mean the filter was ignored. This source was checked from the office network on 15 October 2026: 33 announcements listed, text extracted correctly.
2. **London Stock Exchange** news explorer (sectors 302030, 351010, 351020). This is used if Investegate fails. It does not list announcements yet: its News explorer block returns an empty answer to the script.

If both list nothing on a weekday, the file says so in a warning instead of looking like a quiet day.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No file this morning | Was the computer on and logged in at 08:01? Double-click **Make today's report now**. Logs are in `%LOCALAPPDATA%\RNS Report\logs`. |
| File says `SOURCES FAILED` or `WARNING` | Run `Test connection.bat` and look at `probe_summary.txt`. A 403 error means the site is blocking requests from that network. |
| "Windows protected your PC" | Click **More info** > **Run anyway**, or unblock the zip before unzipping (see above). |
| One announcement says "could not be retrieved" | The file links to it. Failed texts are retried until 07:03. |
| Check the task | Task Scheduler > Task Scheduler Library > *RNS Real Estate Morning Report*. The *Last Run Result* should be `0x0`. |

## For developers

The program is `rns_report.py`: one file, standard library only, Python 3.9+. Command-line options override `settings.ini`. Run `py rns_report.py --help` for the list.

| Command | What it does |
| --- | --- |
| `py rns_report.py` | Morning routine: waits for `run_time_uk`, polls every 15 s until `final_time_uk` |
| `py rns_report.py --once --open` | One pass now |
| `py rns_report.py --once --date 2026-10-15 --since 07:00` | An earlier day, from 07:00 on |
| `py rns_report.py --diagnose` | Probe every source variant and write `debug\probe_summary.txt` |
| `py rns_report.py --setup` / `--uninstall` | What `Install.bat` / `Uninstall.bat` run |

Tests: `pytest tests/test_rns_report.py`. They are offline and use pages saved on 15 October 2026 (the Investegate and LSE lists and a Big Yellow announcement). The kit workflow (`.github/workflows/rns-kit.yml`) does four things: bundles the latest embeddable Python 3.12 to 3.14, tests the installer on a Windows runner, does a live run against the sites, and uploads that run as the **live-test** artifact.
