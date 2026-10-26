// Regression check for skywarden BUG-005: set-plug / set-reserve on a damaged or wrong-shape config.json
// must say "damaged", exit 1, and leave the file byte-for-byte untouched. Run: node test/set-cmds-damaged.test.js
const { spawnSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
let fail = 0; const ok = (c, m, r) => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c || !r ? '' : `  [exit ${r.code}] ${r.out.slice(0, 200)}`)); if (!c) fail++; };
const bads = ['{"sensors":"x"}', '{"sensors":[null]}', '{"sensors":{"a":1}}', '"hello"', '[]', '{not json'];
const cmds = [['set-plug', '0.0.1', 'shelly', '1.2.3.4'], ['set-plug', '0.0.1', 'off'], ['set-reserve', 'off'], ['set-reserve', '0.0.5']];
for (const body of bads) for (const args of cmds) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-test-')); const cfg = path.join(home, 'config.json'); fs.writeFileSync(cfg, body);
  const env = { ...process.env, SENSOR_KEEPER_HOME: home, SENSOR_KEEPER_RESERVE_KEY: 'test-not-a-key' }; delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  const x = spawnSync(process.execPath, [path.join(__dirname, '..', 'keeper.js'), ...args], { env, input: '', encoding: 'utf8', timeout: 20000 });
  const r = { code: x.status, out: (x.stdout || '') + (x.stderr || '') };
  ok(r.code === 1 && /damaged/.test(r.out) && !/\n\s+at /.test(r.out), `${args.join(' ')} on ${body} → "damaged" + exit 1, no stack trace`, r);
  ok(fs.readFileSync(cfg, 'utf8') === body, `${args.join(' ')} on ${body} → file untouched`);
  fs.rmSync(home, { recursive: true, force: true });
}
// a good config still works
{ const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-test-')); const cfg = path.join(home, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ version: 1, sensors: [{ id: '0.0.1', plug: { type: 'shelly', host: '10.0.0.9' } }], reserve: { account: '0.0.5' } }));
  const env = { ...process.env, SENSOR_KEEPER_HOME: home };
  let x = spawnSync(process.execPath, [path.join(__dirname, '..', 'keeper.js'), 'set-plug', '0.0.1', 'off'], { env, encoding: 'utf8', timeout: 20000 });
  ok(x.status === 0 && /Plug removed/.test(x.stdout) && !JSON.parse(fs.readFileSync(cfg, 'utf8')).sensors[0].plug, 'good config: set-plug off still works');
  x = spawnSync(process.execPath, [path.join(__dirname, '..', 'keeper.js'), 'set-reserve', 'off'], { env, encoding: 'utf8', timeout: 20000 });
  ok(x.status === 0 && /Reserve removed/.test(x.stdout) && !JSON.parse(fs.readFileSync(cfg, 'utf8')).reserve, 'good config: set-reserve off still works');
  fs.rmSync(home, { recursive: true, force: true }); }
process.exit(fail ? 1 : 0);
