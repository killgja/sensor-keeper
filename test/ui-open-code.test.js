// 1.8.1: the local app opens with a one-time code, not the session key. Run: node test/ui-open-code.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ui-'));
const p = spawn(process.execPath, [path.join(__dirname, '..', 'keeper.js'), 'ui', '--no-open'], { env: { ...process.env, SENSOR_KEEPER_HOME: home } });
let out = '';
p.stdout.on('data', async (d) => {
  out += d;
  const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?c=([0-9a-f]+)/);
  if (!m || p.done) return;
  p.done = true;
  const base = `http://127.0.0.1:${m[1]}`;
  try {
    assert(!/[?&]k=/.test(out), 'printed URL must not carry the session key');
    const r1 = await fetch(`${base}/?c=${m[2]}`);
    assert.strictEqual(r1.status, 200, 'first use of the code opens the app');
    const cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
    assert(/^sk=[0-9a-f]{36}$/.test(cookie), 'sets the session cookie');
    assert(/HttpOnly/i.test(r1.headers.get('set-cookie')), 'cookie is HttpOnly');
    const html = await r1.text();
    const key = (html.match(/var KEY='([0-9a-f]{36})'/) || [])[1];
    assert(key, 'page carries the key for its own API calls');
    assert.strictEqual((await fetch(`${base}/?c=${m[2]}`)).status, 403, 'the code works only once');
    assert.strictEqual((await fetch(`${base}/`, { headers: { cookie } })).status, 200, 'reload works with the cookie');
    assert.strictEqual((await fetch(`${base}/?k=${key}`)).status, 403, 'the old ?k= link no longer opens the app');
    assert.strictEqual((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 403, 'API needs the x-sk-key header, not just the cookie');
    const evil = await new Promise((res) => require('http').get({ host: '127.0.0.1', port: m[1], path: '/', headers: { cookie, host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode); }));
    assert.strictEqual(evil, 403, 'other Host headers are refused (DNS rebinding)');
    console.log('PASS ui-open-code');
    p.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e.message); p.kill(); process.exit(1); }
});
setTimeout(() => { console.error('FAIL timeout', out); p.kill(); process.exit(1); }, 20000);
