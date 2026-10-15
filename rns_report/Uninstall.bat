@echo off
title RNS Report - Uninstall
cd /d "%~dp0"
call :findpython || goto :nopython
"%PY%" rns_report.py --uninstall

echo.
pause
exit /b

:findpython
set "PY=%~dp0python\python.exe"
if exist "%PY%" exit /b 0
set "PY="
for %%P in (py.exe python.exe) do if not defined PY for /f "delims=" %%W in ('where %%P 2^>nul') do if not defined PY set "PY=%%W"
if defined PY exit /b 0
exit /b 1

:nopython
echo Python was not found. Use the complete kit, which has a "python" folder next to this file.
echo.
pause
exit /b 1
