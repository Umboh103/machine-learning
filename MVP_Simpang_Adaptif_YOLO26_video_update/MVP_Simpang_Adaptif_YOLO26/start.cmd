@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "SIMPANG_PYTHON=%~dp0..\..\.venv\Scripts\python.exe"
if not exist "%SIMPANG_PYTHON%" set "SIMPANG_PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%SIMPANG_PYTHON%" (
    echo Virtual environment belum ditemukan. Ikuti petunjuk pada README.md.
    exit /b 1
)
"%SIMPANG_PYTHON%" -X utf8 scripts\start_local.py %*
