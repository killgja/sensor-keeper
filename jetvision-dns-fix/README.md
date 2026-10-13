# jv-ksk2024-fix — DNS fix for Jetvision Air!Squitter / Radarcape (unofficial)

> **Update 13 Oct 2026:** Jetvision has released an official patch (`patch-rcd-asq-0004.ddeb`,
> buster-archive-fix 4.0). Use it. If its install ends with "dpkg database lock is locked", the DNS
> key part still applied; install [`buster-archive-fix-complete/`](buster-archive-fix-complete/) to finish the rest.

On 11 Oct 2026 the DNS root key changed from KSK-2017 (tag 20326) to KSK-2024 (tag 38696).
Sensors whose local validating resolver only trusts the old key fail every name lookup
(MLAT "Host not found", no 4DSKY heartbeats).

`jv-ksk2024-fix_1.1.1_all.deb` adds KSK-2024 (keeping KSK-2017) to whichever local resolver
the sensor uses (dns-root-data, unbound, dnsmasq, systemd-resolved), restarts it, and writes a
report to `/var/log/jv-ksk2024-fix.log`, and prints whether lookups work at the end of the install output.
It also adds a negative trust anchor for `voipgate.com`, whose DNSSEC is broken upstream (a DS record
but an unsigned zone): the 4DSKY/Neuron SDK hard-codes `stun.voipgate.com` and crashes at startup
(`panic: lookup stun.voipgate.com ... server misbehaving`) when it can't resolve it. DNSSEC stays on
for everything else. It then restarts the 4DSKY program (`neuron-sdk`), which stops retrying after
many crashes. Removing the package restores the original files.

`jv-ksk2024-fix_1.2.0_all.deb` (source in `pkg-cleanup/`) is the same but removes the voipgate.com
exception; Sensor Keeper installs it once voipgate.com's DNS security works again.

Confirmed on a real Air!Squitter on 12 Oct 2026: MLAT reconnected and 4DSKY heartbeats resumed.

Keys were checked against IANA's root-anchors.xml (digests in `pkg/usr/share/jv-ksk2024-fix/root.ds`).

Install: sensor web page → Settings → Software Maintenance → Manual File Upload →
"Upload and Install" → choose the .deb → Submit. No reboot needed.
