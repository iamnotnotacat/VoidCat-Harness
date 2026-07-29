# The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
# you may not use this file except in compliance with the License. You may obtain a copy at
# https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
# iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
# without warranty. See LICENSE and NOTICE for details and attribution requirements.
$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $workspace "release\VoidCat Harness-win32-x64\VoidCat Harness.exe"
$launcher = Join-Path $workspace "VoidCat Harness.cmd"
$shortcutPath = Join-Path $workspace "VoidCat Harness.lnk"
$iconPath = Join-Path $workspace "assets\voidcat.ico"

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Packaged VoidCat executable is missing: $executable"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot "System32\cmd.exe"
$shortcut.Arguments = "/d /c `"`"$launcher`"`""
$shortcut.WorkingDirectory = $workspace
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = "Open VoidCat Harness"
$shortcut.Save()

Write-Host "VoidCat launcher updated: $shortcutPath"
