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
