# Sensor Keeper installer for Windows 10/11.
#   irm https://raw.githubusercontent.com/killgja/sensor-keeper/main/install.ps1 | iex
# Downloads the standalone program (no Node.js needed) to %USERPROFILE%\.sensor-keeper\bin,
# adds it to your PATH, adds Start menu / desktop icons, and opens the app. No administrator rights needed.
$ErrorActionPreference = 'Stop'
$Repo = if ($env:SENSOR_KEEPER_REPO) { $env:SENSOR_KEEPER_REPO } else { 'killgja/sensor-keeper' }
$Dir  = Join-Path $env:USERPROFILE '.sensor-keeper\bin'
$Exe  = Join-Path $Dir 'sensor-keeper.exe'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

Write-Host 'Installing Sensor Keeper...' -ForegroundColor Cyan
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/releases/latest/download/sensor-keeper-windows-x64.exe" -OutFile "$Exe.tmp"
# 1.8.1: check the download against the release's SHA256SUMS.txt before installing it.
$sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/releases/latest/download/SHA256SUMS.txt").Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
$want = ($sums -split "`n" | Where-Object { $_ -match '\s\*?sensor-keeper-windows-x64\.exe\s*$' } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
$got = (Get-FileHash -Algorithm SHA256 "$Exe.tmp").Hash.ToLower()
if (-not $want -or $want.ToLower() -ne $got) { Remove-Item -Force "$Exe.tmp"; throw 'Checksum mismatch - Sensor Keeper was not installed.' }
Move-Item -Force "$Exe.tmp" $Exe
Unblock-File $Exe

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $Dir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $Dir).TrimStart(';'), 'User')
  $env:Path += ";$Dir"
}
Write-Host "Installed: $Exe" -ForegroundColor Green
& $Exe install-launcher
Start-Process -FilePath $Exe -ArgumentList 'ui' -WindowStyle Hidden
Write-Host ''
Write-Host 'Sensor Keeper is opening in your web browser - enter your details there and press Save.' -ForegroundColor Cyan
Write-Host 'Next time, open it from the Start menu or the "Sensor Keeper" icon on your desktop.'
Write-Host 'Prefer the terminal? Run: sensor-keeper setup'
