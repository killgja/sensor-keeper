#!/bin/bash
# Double-click to install Sensor Keeper on a Mac.
# If macOS says it can't be opened: right-click this file → Open → Open.
clear
echo "Sensor Keeper installer"
echo "======================="
echo
curl -fsSL "https://raw.githubusercontent.com/killgja/sensor-keeper/main/install.sh" | bash
echo
read -n 1 -s -r -p "Done. Press any key to close this window."
