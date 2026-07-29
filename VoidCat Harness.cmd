@echo off
set "VOIDCAT_PACKAGED=%~dp0release\VoidCat Harness-win32-x64\VoidCat Harness.exe"
if exist "%VOIDCAT_PACKAGED%" (
  start "VoidCat Harness" /d "%~dp0release\VoidCat Harness-win32-x64" "%VOIDCAT_PACKAGED%"
  exit /b 0
)
start "VoidCat Harness" /d "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
