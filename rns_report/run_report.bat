@echo off
rem Double-click to build today's real estate RNS report now and open it.
rem Extra options are passed through, e.g.  run_report.bat --diagnose
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 rns_report.py --once --open %*
) else (
    python rns_report.py --once --open %*
)
pause
