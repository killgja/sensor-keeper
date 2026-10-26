// Regression check for skywarden BUG-003: config.json that is valid JSON but the wrong shape
// must be reported as damaged (exit 1, logged) instead of crashing or checking "undefined" accounts.
// Run from the repo root: node test/config-shape.test.js   (uses a temp SENSOR_KEEPER_HOME; no network)
const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-test-')); const cfg = path.join(home, 'config.json');
const run = (args) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, '..', 'keeper.js'), ...args], { env: { ...process.env, SENSOR_KEEPER_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
const cases = ['{"sensors":"abc"}', '{"sensors":{"id":"0.0.1"}}', '{"sensors":[null]}', '{"sensors":[{"name":"x"}]}', '[]', 'null', '{"sensors":[{"id":"0.0.111"}],"alerts":null}'];
for (const c of cases) {
  fs.writeFileSync(cfg, c);
  for (const cmd of ['check', 'status']) {
    const r = run([cmd]);
    ok(!/TypeError|undefined:/.test(r.out), `${cmd} on ${c}: no crash / no "undefined" account`);
    if (cmd === 'check') ok(r.code === 1 && /damaged/.test(r.out), `check on ${c}: exits 1 and says damaged`);
  }
  ok(fs.readFileSync(cfg, 'utf8') === c, `config ${c} left untouched`);
}
fs.writeFileSync(cfg, '{"sensors":[{"id":"0.0.111"}]}'); fs.rmSync(path.join(home, 'keeper.log'), { force: true });
const r = run(['status']); ok(!/damaged/.test(r.out) && !/TypeError/.test(r.out), 'a good config is not reported as damaged');
fs.rmSync(home, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
