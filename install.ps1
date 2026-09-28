# Sensor Keeper installer for Windows 10/11.
#   irm https://raw.githubusercontent.com/killgja/sensor-keeper/main/install.ps1 | iex
# Downloads the standalone program (no Node.js needed) to %USERPROFILE%\.sensor-keeper\bin,
# adds it to your PATH, and starts setup. No administrator rights needed.
$ErrorActionPreference = 'Stop'
$Repo = if ($env:SENSOR_KEEPER_REPO) { $env:SENSOR_KEEPER_REPO } else { 'killgja/sensor-keeper' }
$Dir  = Join-Path $env:USERPROFILE '.sensor-keeper\bin'
$Exe  = Join-Path $Dir 'sensor-keeper.exe'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

Write-Host 'Installing Sensor Keeper...' -ForegroundColor Cyan
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/releases/latest/download/sensor-keeper-windows-x64.exe" -OutFile "$Exe.tmp"
Move-Item -Force "$Exe.tmp" $Exe
Unblock-File $Exe

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $Dir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $Dir).TrimStart(';'), 'User')
  $env:Path += ";$Dir"
}
Write-Host "Installed: $Exe" -ForegroundColor Green
Write-Host ''
& $Exe setup
Write-Host ''
Write-Host 'You can close this window. Run "sensor-keeper status" in a new terminal any time.'
