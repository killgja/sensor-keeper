// Regression check for skywarden BUG-001: a damaged config.json must not look like "not set up",
// must be logged, and must never be overwritten from {} (which wiped sensors + token).
// Run from the repo root: node test/config-damaged.test.js   (uses a temp SENSOR_KEEPER_HOME; no network)
const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-test-')); const cfg = path.join(home, 'config.json');
const run = (args) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, '..', 'keeper.js'), ...args], { env: { ...process.env, SENSOR_KEEPER_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
fs.writeFileSync(cfg, '{"version":1,"sensors":[{"id":"0.0.111"}],"portalToken":"x",'); // truncated JSON
const r = run(['check']);
ok(r.code === 1, 'check exits 1 on damaged config');
ok(/damaged/.test(r.out) && !/Not set up yet/.test(r.out), 'message says damaged, not "not set up"');
ok(fs.existsSync(path.join(home, 'keeper.log')) && /damaged/.test(fs.readFileSync(path.join(home, 'keeper.log'), 'utf8')), 'written to keeper.log');
const before = fs.readFileSync(cfg, 'utf8'); run(['remote-status']); run(['network-status']);
ok(fs.readFileSync(cfg, 'utf8') === before, 'damaged config left untouched (not rewritten from {})');
fs.rmSync(home, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
