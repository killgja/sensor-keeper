@echo off
title Sensor Keeper installer
echo Sensor Keeper installer
echo =======================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/killgja/sensor-keeper/main/install.ps1 | iex"
echo.
pause
