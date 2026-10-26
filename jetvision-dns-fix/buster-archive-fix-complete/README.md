# jv-buster-archive-fix-complete (unofficial)

Jetvision's official patch `patch-rcd-asq-0004.ddeb` (`buster-archive-fix` 4.0) stops with
"dpkg database lock is locked by another process" because its install script runs `dpkg` and `apt`
from inside its own installation. Its first steps (new DNS root key, archive.debian.org sources) still
apply; the rest does not.

This package applies the **same changes** without that problem:
- KSK-2024 DNSSEC trust anchor (if not already present; 1.0.1 adds it next to the existing key and keeps a backup, `root.positive.jv-backup`)
- `deb.debian.org` → `archive.debian.org` for buster in `/etc/apt/sources.list`
- `/etc/systemd/resolved.conf`: `FallbackDNS=1.1.1.1 1.0.0.1 8.8.8.8`, `DNSSEC=allow-downgrade`, `DNSOverTLS=opportunistic`
- `/etc/fixtime.conf` paths
- then schedules `dpkg --configure -a`, `apt-get -f install`, `apt-get update` and `apt-get upgrade`
  to run **90 seconds after** the install finishes (log: `/var/log/jv-buster-archive-fix-complete.log`)

Debian 10 only (refuses elsewhere, changing nothing). Install via Settings → Software Maintenance →
Manual File Upload → Upload and Install. Leave the sensor on ~10 minutes, then reboot.
If Jetvision releases a corrected patch, use theirs instead.

**Confirmed on a real Air!Squitter (260411.0800.02) on 13 Oct 2026:** installed cleanly after Jetvision's
4.0 patch had failed; the follow-up ran ~2 minutes later and finished with exit 0 (no dpkg lock error);
`dpkg --audit` clean; DNS, GPS/NTP and MLAT came back normally after two reboots (4DSKY too, once the settings issue below was fixed).

## Checking the result: `jv-status-check_1.0.1_all.deb`

Read-only; changes nothing. Install it the same way and its output shows the follow-up log,
package states, `dpkg --audit`, pending upgrades, the resolved.conf DNS settings, the trust anchor
and whether neuron-sdk is running. (It shows itself as half-configured in its own report; that's
expected, because it runs while it is being installed.)

## 4DSKY doesn't come back after the reboot?

Not caused by this package, but you may only notice it now because of the reboot. If MLAT works but
4DSKY heartbeats never resume, the 4DSKY program (`neuron-sdk`) may be quitting silently right after
`Local sensor ID: …` in its log. On one unit the cause was its settings file `/etc/neuron-sdk/.env`
missing `hedera_id` and `hedera_evm_id` (the device's own Hedera account id and EVM address), which can
happen after the 4DSKY setup wizard is re-run. The running program keeps those values in memory, so the
problem only shows up at the next reboot. Ask in the 4DSKY Discord for help; Sensor Keeper will detect
and repair this in its next release.

**Don't remove `jv-ksk2024-fix`** on a sensor that has Jetvision's patch: its removal script can
delete `/etc/dnssec-trust-anchors.d/root.positive`, which Jetvision's patch relies on. A fix is coming.
