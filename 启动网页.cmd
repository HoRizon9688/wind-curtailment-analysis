@echo off
setlocal
cd /d "%~dp0"
set "WIND_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%WIND_PY%" (
  "%WIND_PY%" serve_app.py --open
) else (
  python serve_app.py --open
)
if errorlevel 1 pause
