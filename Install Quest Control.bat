@echo off
title Install Quest Control
rem Everything below the ::PS line is PowerShell, run from this same file.
set "SELF=%~f0"
powershell -NoProfile -Command "iex ((Get-Content -Raw -LiteralPath $env:SELF) -split '(?m)^::PS\r?\n', 2)[1]"
echo.
pause
exit /b
::PS
# Downloads Quest Control into a permanent folder and puts a shortcut on the Desktop.
# Running it again updates an existing install.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $dest = Join-Path $env:LOCALAPPDATA 'QuestControl'
  $zip = Join-Path $env:TEMP 'quest-control.zip'
  $unpacked = Join-Path $env:TEMP 'quest-control-unpacked'

  Write-Host 'Downloading Quest Control...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing 'https://github.com/lm4311/quest-control/archive/refs/heads/main.zip' -OutFile $zip
  if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
  Expand-Archive $zip $unpacked
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item (Join-Path $unpacked 'quest-control-main\*') $dest -Recurse -Force
  Remove-Item $zip, $unpacked -Recurse -Force

  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Quest Control.lnk'))
  # cmd.exe as the target (rather than the .bat) is what lets Windows pin the shortcut to the taskbar.
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $shortcut.Arguments = '/c "Start Quest Control.bat"'
  $shortcut.WorkingDirectory = $dest
  $shortcut.IconLocation = (Join-Path $dest 'quest-control.ico') + ',0'
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Open the Quest Control panel'
  $shortcut.Save()

  Write-Host "Installed to $dest"
  Write-Host 'A "Quest Control" shortcut is now on your Desktop.' -ForegroundColor Green

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js is missing. Install it from https://nodejs.org before starting Quest Control.' -ForegroundColor Yellow
  }
  $hasAdb = $env:ADB_PATH -or (Get-Command adb -ErrorAction SilentlyContinue) -or
    (Test-Path (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'))
  if (-not $hasAdb) {
    Write-Host 'adb was not found. Install the Android platform-tools from https://developer.android.com/tools/releases/platform-tools' -ForegroundColor Yellow
  }
} catch {
  Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
}
