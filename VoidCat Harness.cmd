@REM The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
@REM you may not use this file except in compliance with the License. You may obtain a copy at
@REM https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
@REM iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
@REM without warranty. See LICENSE and NOTICE for details and attribution requirements.
@echo off
set "VOIDCAT_PACKAGED=%~dp0release\VoidCat Harness-win32-x64\VoidCat Harness.exe"
if exist "%VOIDCAT_PACKAGED%" (
  start "VoidCat Harness" /d "%~dp0release\VoidCat Harness-win32-x64" "%VOIDCAT_PACKAGED%"
  exit /b 0
)
start "VoidCat Harness" /d "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
