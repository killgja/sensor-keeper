// Regression checks for skywarden BUG-002 (unknown command exited 0) and BUG-004 (set-reserve with no
// keyboard input exited 0 silently). Run from the repo root: node test/cli.test.js   (temp home; no network)
const { spawnSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-test-')); const cfg = path.join(home, 'config.json');
const env = { ...process.env, SENSOR_KEEPER_HOME: home }; delete env.SENSOR_KEEPER_RESERVE_KEY; delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
const run = (args, input = '') => { const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'keeper.js'), ...args], { env, input, encoding: 'utf8', timeout: 20000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
let fail = 0; const ok = (c, m, r) => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c || !r ? '' : `  [exit ${r.code}] ${r.out.slice(0, 200)}`)); if (!c) fail++; };
fs.writeFileSync(cfg, JSON.stringify({ version: 1, sensors: [{ id: '0.0.111' }] }));
let r = run(['not-a-command']); ok(r.code === 1 && /Unknown command: not-a-command/.test(r.out), 'unknown command → message + exit 1', r);
for (const h of ['help', '--help', '-h']) { r = run([h]); ok(r.code === 0 && /Usage:/.test(r.out), `${h} → help + exit 0`, r); }
r = run(['version']); ok(r.code === 0 && /^\d+\.\d+\.\d+/.test(r.out.trim()), 'version still works', r);
r = run(['-psn_0_12345', 'version']); ok(r.code === 0 && /^\d+\.\d+\.\d+/.test(r.out.trim()), 'macOS -psn_ argument is ignored', r);
const before = fs.readFileSync(cfg, 'utf8');
r = run(['set-reserve', '0.0.5'], ''); ok(r.code === 1 && /No key given/.test(r.out), 'set-reserve with no input → "No key given" + exit 1', r);
ok(fs.readFileSync(cfg, 'utf8') === before, 'config unchanged after set-reserve with no key');
r = run(['set-reserve', '0.0.5', 'abc']); ok(r.code === 1 && /Usage/.test(r.out), 'set-reserve with a non-number refill → usage + exit 1', r);
r = run(['set-reserve', 'nope']); ok(r.code === 1 && /Usage/.test(r.out), 'set-reserve with a bad account → usage + exit 1', r);
fs.rmSync(home, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
