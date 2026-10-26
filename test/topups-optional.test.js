// HBAR top-ups are optional (1.8): off for new setups (the Sky Warden app does them), still on for
// setups from before 1.8 that already have a Portal token. Run: node test/topups-optional.test.js
'use strict';
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { execFile } = require('child_process');
const execP = (f, a, o) => new Promise((res, rej) => execFile(f, a, o, (e, out) => (e ? rej(e) : res(out))));

const calls = { faucet: 0, alerts: [] };
const now = () => Date.now() / 1000;
const srv = http.createServer((q, r) => {
  let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => {
    const u = new URL(q.url, 'http://x');
    const send = (c, o) => { r.writeHead(c, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
    if (/^\/api\/v1\/accounts\/0\.0\.\d+$/.test(u.pathname)) return send(200, { balance: { balance: 15e8 }, deleted: false });
    if (u.pathname === '/api/v1/transactions') return send(200, { transactions: Array.from({ length: 25 }, (_, i) => ({ transaction_id: `t-${i}`, consensus_timestamp: String(now() - 30 - 41 * i), charged_tx_fee: 310000, result: 'SUCCESS' })) });
    if (u.pathname === '/api/v1/contracts/call') return send(400, {});
    if (u.pathname === '/faucet') { calls.faucet++; return send(200, { amount: 50, transactionId: '0.0.2@1.2' }); }
    if (u.pathname.startsWith('/ntfy/')) { calls.alerts.push(q.headers.title || ''); return send(200, {}); }
    send(404, {});
  });
});

srv.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  const run = async (cfg) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-topups-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sensors: [{ id: '0.0.111', name: 'Roof' }], lowWater: 40, topupAmount: 50,
      alerts: { ntfyTopic: 'sk-test-topic', ntfyServer: `${base}/ntfy` }, ...cfg }));
    const out = await execP(process.execPath, [path.join(__dirname, '..', 'keeper.js'), 'check'], {
      env: { ...process.env, SENSOR_KEEPER_HOME: home, SENSOR_KEEPER_MIRROR: `${base}/api/v1`, SENSOR_KEEPER_FAUCET: `${base}/faucet`, SENSOR_KEEPER_SHARED_RESERVE: `${base}/reserve` },
      encoding: 'utf8', timeout: 60000,
    });
    fs.rmSync(home, { recursive: true, force: true });
    return out;
  };
  const go = async () => {
    // 1. New setup, no token: no top-up, and the 15 HBAR (~2 days) heads-up points to the app.
    calls.faucet = 0; calls.alerts = [];
    let out = await run({});
    assert.strictEqual(calls.faucet, 0, 'no faucet call when top-ups are off');
    assert(!/top-up/.test(out.split('\n').find((l) => l.includes('0.0.111')) || ''), out);
    assert(calls.alerts.some((t) => /running low on HBAR/.test(t)), 'low-soon heads-up sent: ' + calls.alerts.join(' | '));
    // 2. Setup from before 1.8 with a token (no "topups" key): keeps topping up.
    calls.faucet = 0; calls.alerts = [];
    out = await run({ portalToken: 'v4.public.test-token-1234567890' });
    assert.strictEqual(calls.faucet, 1, 'legacy setup still tops up');
    assert(!calls.alerts.some((t) => /running low/.test(t)), 'no app heads-up when this computer tops up');
    // 3. Token saved but top-ups turned off: no faucet call.
    calls.faucet = 0; calls.alerts = [];
    await run({ portalToken: 'v4.public.test-token-1234567890', topups: false });
    assert.strictEqual(calls.faucet, 0, 'turned off means off');
    // 4. Turned on explicitly.
    calls.faucet = 0;
    await run({ portalToken: 'v4.public.test-token-1234567890', topups: true });
    assert.strictEqual(calls.faucet, 1, 'turned on tops up');
    console.log('topups-optional.test.js: all checks passed');
    srv.close();
  };
  go().catch((e) => { console.error(e); srv.close(); process.exit(1); });
});
