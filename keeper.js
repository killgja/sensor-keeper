#!/usr/bin/env node
/*
 * Sensor Keeper — keeps 4DSKY / Neuron sensors funded with Hedera testnet HBAR.
 *
 * Unofficial community tool. Not affiliated with 4DSKY, Neuron or Hedera.
 * Requires Node.js 18+ (or use a standalone build). No third-party packages.
 *
 * How it works
 *   - Reads each sensor's balance and recent heartbeats from Hedera's public
 *     mirror node (read-only, no login).
 *   - When a sensor's balance drops below your threshold, it asks Hedera's
 *     official Faucet API (portal.hedera.com/api/disbursement/cli) to send test
 *     HBAR straight to the sensor, using YOUR Hedera Portal access token.
 *     No private keys are needed or stored.
 *   - Sends an alert (Discord and/or ntfy push/email) only when something needs
 *     attention.
 *
 * Commands:  setup | run | check | status | topup <0.0.x> | test-alert |
 *            install-service | uninstall-service | logs | version | help
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');

const VERSION = '1.1.1';
const APP = 'sensor-keeper';
const HOME = process.env.SENSOR_KEEPER_HOME || path.join(os.homedir(), '.sensor-keeper');
const CONFIG = path.join(HOME, 'config.json');
const STATE = path.join(HOME, 'state.json');
const LOG = path.join(HOME, 'keeper.log');
const LOCK = path.join(HOME, 'keeper.pid');

const MIRROR = process.env.SENSOR_KEEPER_MIRROR || 'https://testnet.mirrornode.hedera.com/api/v1';
const FAUCET = process.env.SENSOR_KEEPER_FAUCET || 'https://portal.hedera.com/api/disbursement/cli';
const FAUCET_DAILY_LIMIT = 100;          // HBAR per user per rolling 24 h (Hedera rule)
const FAUCET_MAX_REQUEST = 100;          // HBAR per request (Hedera rule)
const DAY = 24 * 3600 * 1000;
const DRY_RUN = process.argv.includes('--dry-run');
let UI_MODE = false;

const DEFAULTS = {
  version: 1,
  sensors: [],                // [{ id: '0.0.123', name: 'Backyard', statusUrl: 'http://192.168.1.50' }]
  portalToken: '',
  lowWater: 40,               // top up when balance falls below this (HBAR)
  topupAmount: 60,            // HBAR per top-up (max 100, shared daily limit 100)
  checkEveryMinutes: 30,
  heartbeatAlertMinutes: 15,
  alerts: { discordWebhook: '', ntfyTopic: '', ntfyServer: 'https://ntfy.sh', ntfyEmail: '' },
  weeklySummary: true,
  dryRun: false,
};

// ---------------------------------------------------------------- utilities
const hbar = (tinybar) => Number(tinybar) / 1e8;
const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? '?' : Number(n).toFixed(d));
const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAccountId = (s) => /^0\.0\.\d+$/.test(String(s).trim());

function ensureHome() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writePrivate(file, data) {
  ensureHome();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
}
function loadConfig() {
  const c = readJson(CONFIG, null);
  if (!c) return null;
  const cfg = { ...DEFAULTS, ...c, alerts: { ...DEFAULTS.alerts, ...(c.alerts || {}) } };
  if (DRY_RUN) cfg.dryRun = true;
  return cfg;
}
function loadState() {
  return readJson(STATE, { sensors: {}, faucetLedger: [], lastSummary: 0 });
}
function saveState(s) { writePrivate(STATE, s); }

function log(msg) {
  const line = `${iso()} ${msg}`;
  console.log(line);
  try {
    ensureHome();
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) {
      fs.renameSync(LOG, LOG + '.1');
    }
    fs.appendFileSync(LOG, line + '\n', { mode: 0o600 });
  } catch { /* ignore */ }
}

async function http(url, opts = {}, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': `${APP}/${VERSION}`, ...(opts.headers || {}) } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- hedera reads
async function getBalance(id) {
  const r = await http(`${MIRROR}/accounts/${id}?transactions=false`);
  if (r.status === 404) return { missing: true };
  if (!r.ok || !r.json) throw new Error(`mirror node HTTP ${r.status}`);
  return { balance: hbar(r.json.balance.balance), deleted: !!r.json.deleted };
}

// Heartbeats are consensus-submit-message transactions paid by the sensor account.
async function getHeartbeats(id, limit = 25) {
  const r = await http(`${MIRROR}/transactions?account.id=${id}&transactiontype=CONSENSUSSUBMITMESSAGE&result=success&order=desc&limit=${limit}`);
  if (!r.ok || !r.json) throw new Error(`mirror node HTTP ${r.status}`);
  const tx = (r.json.transactions || []).filter((t) => t.payer_account_id === id || (t.transaction_id || '').startsWith(id + '-'));
  const list = tx.length ? tx : r.json.transactions || [];
  if (!list.length) return { lastAgeMin: null, burnPerDay: null };
  const ts = list.map((t) => parseFloat(t.consensus_timestamp) * 1000);
  const lastAgeMin = (now() - ts[0]) / 60000;
  let burnPerDay = null;
  if (ts.length >= 5) {
    const spanSec = (ts[0] - ts[ts.length - 1]) / 1000;
    const avgFee = list.reduce((a, t) => a + hbar(t.charged_tx_fee || 0), 0) / list.length;
    if (spanSec > 0) burnPerDay = avgFee * (86400 / (spanSec / (ts.length - 1)));
  }
  return { lastAgeMin, burnPerDay };
}

// Optional: Jetvision Air!Squitter status page on the local network.
async function getDeviceStatus(statusUrl) {
  const url = statusUrl.replace(/\/+$/, '') + '/status.json';
  const r = await http(url, {}, 8000);
  if (!r.ok || !r.json) throw new Error(`HTTP ${r.status}`);
  const bad = Object.entries(r.json)
    .filter(([, v]) => v && typeof v === 'object' && v.status && !['green', 'unknown'].includes(v.status))
    .map(([k, v]) => `${k}: ${v.desc || v.status}`);
  return { bad };
}

// ---------------------------------------------------------------- faucet
function faucetUsed24h(state) {
  const cutoff = now() - DAY;
  state.faucetLedger = (state.faucetLedger || []).filter((e) => e.t > cutoff);
  return state.faucetLedger.reduce((a, e) => a + e.amount, 0);
}

async function requestFaucet(cfg, state, id, amount) {
  if (!cfg.portalToken) throw new Error('no Hedera Portal access token configured (run setup)');
  if (cfg.dryRun) { log(`[dry-run] would request ${amount} HBAR from the Hedera faucet for ${id}`); return { dryRun: true }; }
  const r = await http(FAUCET, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.portalToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: id, amount, network: 'testnet' }),
  }, 30000);
  if (r.ok) {
    state.faucetLedger.push({ t: now(), id, amount });
    const tx = r.json && (r.json.transactionId || r.json.transaction_id || r.json.txId || '');
    return { ok: true, tx, remaining: r.json && (r.json.remainingAllowance ?? r.json.remaining ?? null) };
  }
  const detail = (r.json && (r.json.message || r.json.error)) || r.text.slice(0, 200);
  const err = new Error(`faucet HTTP ${r.status}: ${detail}`);
  err.status = r.status;
  throw err;
}

// ---------------------------------------------------------------- alerts
async function sendAlert(cfg, title, body, priority = 'default') {
  const sent = [];
  const a = cfg.alerts || {};
  if (a.discordWebhook) {
    try {
      const r = await http(a.discordWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }) });
      if (r.ok) sent.push('discord'); else log(`alert: Discord returned HTTP ${r.status}`);
    } catch (e) { log(`alert: Discord failed: ${e.message}`); }
  }
  if (a.ntfyTopic) {
    try {
      const headers = { Title: title.replace(/[^\x20-\x7E]/g, ''), Priority: priority, Tags: 'satellite' };
      const r = await http(`${(a.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(a.ntfyTopic)}`, { method: 'POST', headers, body });
      if (r.ok) sent.push('ntfy'); else log(`alert: ntfy returned HTTP ${r.status}`);
    } catch (e) { log(`alert: ntfy failed: ${e.message}`); }
  }
  if (!sent.length) log(`ALERT not delivered (no working alert channel): ${title} — ${body.split('\n')[0]}`);
  else log(`alert sent via ${sent.join(' and ')}: ${title}`);
  return sent;
}

// Raise an alert once per problem, remind every 12 h, and send a "resolved" note.
async function problem(cfg, sstate, key, active, title, body) {
  sstate.problems = sstate.problems || {};
  const p = sstate.problems[key];
  if (active) {
    if (!p || now() - p.lastSent > 12 * 3600 * 1000) {
      await sendAlert(cfg, title, body, 'high');
      sstate.problems[key] = { since: p ? p.since : now(), lastSent: now() };
    }
  } else if (p) {
    delete sstate.problems[key];
    await sendAlert(cfg, `Resolved: ${title.replace(/^[^:]*:\s*/, '')}`, `Back to normal as of ${iso()}.`, 'low');
  }
}

// ---------------------------------------------------------------- one check
async function checkSensor(cfg, state, sensor, { forceTopup = false } = {}) {
  const id = sensor.id;
  const label = sensor.name ? `${sensor.name} (${id})` : id;
  const st = (state.sensors[id] = state.sensors[id] || {});
  const out = { id, label };

  // 1. balance
  let bal;
  try { bal = await getBalance(id); st.mirrorFails = 0; }
  catch (e) {
    st.mirrorFails = (st.mirrorFails || 0) + 1;
    log(`${label}: mirror node error: ${e.message}`);
    await problem(cfg, st, 'mirror', st.mirrorFails >= 3, `Sensor Keeper: can't read ${label}`,
      `The Hedera mirror node has failed ${st.mirrorFails} times in a row (${e.message}). Top-ups are paused until it answers.`);
    return { ...out, error: e.message };
  }
  await problem(cfg, st, 'mirror', false, `Sensor Keeper: can't read ${label}`, '');

  await problem(cfg, st, 'missing', !!bal.missing || bal.deleted, `Sensor Keeper: ${label} not found on Hedera testnet`,
    `Account ${id} doesn't exist on testnet any more. Hedera resets the testnet every few months, which wipes all accounts.\n` +
    `Fix: in the 4DSKY app create/claim a new device account, re-run your sensor's Neuron setup with it, then run "${APP} setup" to update the ID.`);
  if (bal.missing || bal.deleted) return { ...out, missing: true };

  out.balance = bal.balance;
  st.lastBalance = bal.balance;
  st.lastCheck = now();

  // 2. heartbeats + burn rate
  try {
    const hb = await getHeartbeats(id);
    out.heartbeatAgeMin = hb.lastAgeMin;
    if (hb.burnPerDay) st.burnPerDay = hb.burnPerDay;
    out.burnPerDay = st.burnPerDay;
    const stale = hb.lastAgeMin == null || hb.lastAgeMin > cfg.heartbeatAlertMinutes;
    await problem(cfg, st, 'heartbeat', stale, `Sensor Keeper: ${label} is not sending heartbeats`,
      hb.lastAgeMin == null
        ? 'No heartbeats found for this account. The sensor may be offline, not set up yet, or out of HBAR.'
        : `Last heartbeat was ${Math.round(hb.lastAgeMin)} min ago (balance ${fmt(bal.balance)} HBAR). Check the sensor's power and internet.`);
  } catch (e) { log(`${label}: heartbeat check failed: ${e.message}`); }

  // 3. optional device status page
  if (sensor.statusUrl) {
    try {
      const ds = await getDeviceStatus(sensor.statusUrl);
      st.statusFails = 0;
      out.deviceIssues = ds.bad;
      await problem(cfg, st, 'device-down', false, `Sensor Keeper: ${label} status page unreachable`, '');
      await problem(cfg, st, 'device-status', ds.bad.length > 0, `Sensor Keeper: ${label} reports a problem`, ds.bad.join('\n'));
    } catch (e) {
      st.statusFails = (st.statusFails || 0) + 1;
      out.deviceIssues = [`status page: ${e.message}`];
      await problem(cfg, st, 'device-down', st.statusFails >= 2, `Sensor Keeper: ${label} status page unreachable`,
        `${sensor.statusUrl} did not answer ${st.statusFails} checks in a row. The sensor may be powered off or off the network.`);
    }
  }

  // 4. top-up
  const needs = forceTopup || bal.balance < cfg.lowWater;
  if (needs) {
    const used = faucetUsed24h(state);
    const lastForThis = st.lastTopup || 0;
    const cooldownLeft = DAY - (now() - lastForThis);
    let amount = Math.min(cfg.topupAmount, FAUCET_MAX_REQUEST, FAUCET_DAILY_LIMIT - used);
    if (!forceTopup && state.tokenBadUntil && now() < state.tokenBadUntil) {
      out.topup = 'paused — your Hedera Portal token was rejected (run setup with a new token)';
    } else if (cooldownLeft > 0 && !forceTopup) {
      out.topup = `waiting (faucet allows one top-up per sensor per 24 h; ${Math.ceil(cooldownLeft / 3600000)} h left)`;
    } else if (amount < 1) {
      out.topup = `waiting (your 100 HBAR daily faucet allowance is used up)`;
    } else {
      amount = Math.floor(amount);
      try {
        const r = await requestFaucet(cfg, state, id, amount);
        if (!r.dryRun) {
          st.lastTopup = now();
          st.topupFails = 0;
          out.topup = `requested ${amount} HBAR${r.tx ? ` (tx ${r.tx})` : ''}`;
          log(`${label}: top-up of ${amount} HBAR requested from Hedera faucet${r.tx ? `, tx ${r.tx}` : ''}`);
        } else out.topup = `[dry-run] would request ${amount} HBAR`;
        await problem(cfg, st, 'topup', false, `Sensor Keeper: top-up failing for ${label}`, '');
        state.tokenBadUntil = 0;
        await problem(cfg, state, 'token', false, 'Sensor Keeper: Hedera Portal token rejected', '');
      } catch (e) {
        st.topupFails = (st.topupFails || 0) + 1;
        out.topup = `FAILED: ${e.message}`;
        log(`${label}: top-up failed: ${e.message}`);
        if (e.status === 401 || e.status === 403) {
          state.tokenBadUntil = now() + 6 * 3600 * 1000;   // don't hammer the faucet with a bad token
          await problem(cfg, state, 'token', true, 'Sensor Keeper: Hedera Portal token rejected',
            `The faucet refused your access token (${e.status}: ${e.message.replace(/^faucet HTTP \d+: /, '')}). Create a Personal Access Token in your portal.hedera.com account settings and run "${APP} setup".`);
        } else if (e.status === 429) {
          st.lastTopup = now() - DAY + 3 * 3600 * 1000;  // retry in ~3 h
          out.topup = 'faucet daily limit reached — will retry later';
        } else {
          await problem(cfg, st, 'topup', st.topupFails >= 2, `Sensor Keeper: top-up failing for ${label}`,
            `${e.message}\nBalance is ${fmt(bal.balance)} HBAR (~${st.burnPerDay ? fmt(bal.balance / st.burnPerDay, 1) : '?'} days left).`);
        }
      }
    }
  }
  const critical = st.burnPerDay ? bal.balance / st.burnPerDay < 1 : bal.balance < 7;
  await problem(cfg, st, 'low', critical, `Sensor Keeper: ${label} almost out of HBAR`,
    `Balance ${fmt(bal.balance)} HBAR — less than a day of heartbeats left and automatic top-up hasn't fixed it.`);
  return out;
}

async function checkAll(cfg, opts = {}) {
  const state = loadState();
  const results = [];
  for (const s of cfg.sensors) {
    try { results.push(await checkSensor(cfg, state, s, opts)); }
    catch (e) { log(`${s.id}: unexpected error: ${e.stack || e.message}`); results.push({ id: s.id, label: s.id, error: e.message }); }
  }
  state.lastRun = now();
  saveState(state);
  return { results, state };
}

function describe(r) {
  if (r.error) return `${r.label}: ERROR ${r.error}`;
  if (r.missing) return `${r.label}: NOT FOUND on testnet`;
  const days = r.burnPerDay ? ` (~${fmt(r.balance / r.burnPerDay, 0)} days)` : '';
  const hb = r.heartbeatAgeMin == null ? 'no heartbeats' : `last heartbeat ${fmt(r.heartbeatAgeMin, 1)} min ago`;
  const dev = r.deviceIssues ? (r.deviceIssues.length ? `, device: ${r.deviceIssues.join('; ')}` : ', device ok') : '';
  return `${r.label}: ${fmt(r.balance)} HBAR${days}, ${hb}${dev}${r.topup ? `, top-up: ${r.topup}` : ''}`;
}

// ---------------------------------------------------------------- run loop
function acquireLock() {
  ensureHome();
  const pid = parseInt(readJson(LOCK, null), 10);
  if (pid && pid !== process.pid) {
    try { process.kill(pid, 0); return false; } catch { /* stale */ }
  }
  writePrivate(LOCK, String(process.pid));
  const release = () => { try { if (readJson(LOCK, null) == process.pid) fs.unlinkSync(LOCK); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(0); });
  return true;
}

async function runLoop() {
  let cfg = loadConfig();
  if (!cfg || !cfg.sensors.length) { console.error(`Not set up yet. Run: ${APP} setup`); process.exit(1); }
  if (!acquireLock()) { log('another Sensor Keeper is already running — exiting'); process.exit(0); }
  log(`Sensor Keeper ${VERSION} started, watching ${cfg.sensors.map((s) => s.id).join(', ')}${cfg.dryRun ? ' [dry-run]' : ''}`);
  let lastCheck = 0;
  // Wake every minute and decide by wall-clock time, so a sleeping or throttled
  // computer simply catches up when it wakes.
  for (;;) {
    cfg = loadConfig() || cfg;   // pick up edits without a restart
    if (now() - lastCheck >= cfg.checkEveryMinutes * 60000) {
      lastCheck = now();
      try {
        const { results, state } = await checkAll(cfg);
        results.forEach((r) => log(describe(r)));
        if (!state.lastSummary) { state.lastSummary = now(); saveState(state); }   // first summary a week from now
        if (cfg.weeklySummary && now() - state.lastSummary > 7 * DAY) {
          await sendAlert(cfg, 'Sensor Keeper weekly summary', results.map(describe).join('\n'), 'low');
          state.lastSummary = now();
          saveState(state);
        }
      } catch (e) { log(`check failed: ${e.stack || e.message}`); }
    }
    await sleep(60000);
  }
}

// ---------------------------------------------------------------- setup wizard
// A small prompt helper that queues input lines, so pasted or piped answers
// are never lost while the wizard is busy checking something online.
function makeRl() {
  const tty = !!process.stdin.isTTY;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  const queue = []; const waiters = []; let closed = false;
  rl.muted = false;
  const orig = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
  if (orig) rl._writeToOutput = (str) => { if (!rl.muted) return orig(str); if (/[\r\n]/.test(str)) return orig(str.replace(/[^\r\n]/g, '')); return orig('*'.repeat(str.length)); };
  rl.on('line', (l) => { if (waiters.length) waiters.shift()(l); else queue.push(l); });
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  rl.next = (prompt) => new Promise((res) => {
    process.stdout.write(prompt);
    if (queue.length) { const l = queue.shift(); if (!tty) process.stdout.write('\n'); return res(l); }
    if (closed) { process.stdout.write('\n'); return res(null); }
    waiters.push((l) => { if (!tty && l !== null) process.stdout.write('\n'); res(l); });
  });
  return rl;
}
async function ask(rl, q, def = '') {
  const a = await rl.next(def !== '' ? `${q} [${def}]: ` : `${q}: `);
  if (a === null) throw new Error('input ended — setup cancelled');
  return a.trim() === '' ? String(def) : a.trim();
}
async function askSecret(rl, q, hasExisting) {
  rl.muted = true;
  try {
    const a = await rl.next(hasExisting ? `${q} [press Enter to keep the saved one]: ` : `${q}: `);
    if (a === null) throw new Error('input ended — setup cancelled');
    return a.trim();
  } finally { rl.muted = false; }
}
async function askYesNo(rl, q, def = true) {
  const a = (await ask(rl, `${q} (y/n)`, def ? 'y' : 'n')).toLowerCase();
  return a.startsWith('y');
}

async function setup() {
  const old = loadConfig() || { ...DEFAULTS };
  const cfg = JSON.parse(JSON.stringify(old));
  const rl = makeRl();
  console.log(`
Sensor Keeper ${VERSION} — setup
─────────────────────────────────
This keeps your 4DSKY / Neuron sensor's Hedera testnet account topped up so its
heartbeats never stop. Everything you enter is saved only on this computer, in
${CONFIG} (readable only by your user account).
Nothing here uses real money: testnet HBAR is free and has no value.
`);

  // Sensors
  console.log('Step 1 — your sensor(s)');
  console.log('  Enter the Hedera account ID of each sensor (looks like 0.0.1234567).');
  console.log('  Find it in the 4DSKY app, or in your sensor\'s Neuron setup page.\n');
  const sensors = [];
  let i = 0;
  for (;;) {
    const prev = old.sensors[i];
    const id = await ask(rl, `  Sensor ${i + 1} account ID${i > 0 ? ' (Enter to finish)' : ''}`, prev ? prev.id : '');
    if (!id) { if (i === 0) { console.log('  At least one sensor is required.'); continue; } break; }
    if (!isAccountId(id)) { console.log('  That doesn\'t look like a Hedera account ID (0.0.12345). Try again.'); continue; }
    process.stdout.write('  Checking Hedera testnet… ');
    try {
      const b = await getBalance(id);
      if (b.missing) { console.log('not found. Double-check the ID (it must be a TESTNET account).'); continue; }
      const hb = await getHeartbeats(id).catch(() => ({}));
      console.log(`found — balance ${fmt(b.balance)} HBAR${hb.lastAgeMin != null ? `, last heartbeat ${fmt(hb.lastAgeMin, 1)} min ago` : ', no heartbeats yet'}.`);
      if (hb.lastAgeMin == null || hb.lastAgeMin > 60) {
        console.log('  ⚠ This account isn\'t sending heartbeats. Make sure it is the SENSOR\'s own device account');
        console.log('    (the one that pays for its heartbeats), not your wallet or rewards account.');
        if (!(await askYesNo(rl, '  Use it anyway?', false))) continue;
      }
    } catch (e) { console.log(`couldn't reach the mirror node (${e.message}); saving anyway.`); }
    const name = await ask(rl, '  A nickname for it (optional)', prev ? prev.name || '' : '');
    let statusUrl = '';
    if (await askYesNo(rl, '  Is it a Jetvision Air!Squitter I can reach on this network (to check its status page)?', !!(prev && prev.statusUrl))) {
      statusUrl = await ask(rl, '  Its address, e.g. http://192.168.1.50', prev ? prev.statusUrl || '' : '');
      if (statusUrl && !/^https?:\/\//.test(statusUrl)) statusUrl = 'http://' + statusUrl;
      if (statusUrl) {
        process.stdout.write('  Testing… ');
        try { const d = await getDeviceStatus(statusUrl); console.log(d.bad.length ? `reachable, reports: ${d.bad.join('; ')}` : 'reachable, all green.'); }
        catch (e) { console.log(`not reachable right now (${e.message}); saving anyway.`); }
      }
    }
    sensors.push({ id, ...(name ? { name } : {}), ...(statusUrl ? { statusUrl } : {}) });
    i++;
    console.log('');
  }
  cfg.sensors = sensors;

  // Token
  console.log(`
Step 2 — Hedera Portal access token (this is what pays for top-ups, for free)
  1. Go to https://portal.hedera.com and sign in (create a free account if needed).
  2. Open your account settings and create a "Personal Access Token".
  3. Paste it below. It is stored only in ${CONFIG}.
  Hedera allows up to 100 test HBAR per day per person through this token, and
  one top-up per sensor per day — plenty, since a sensor uses about 7 HBAR a day.
`);
  for (;;) {
    const t = await askSecret(rl, '  Access token', !!old.portalToken);
    if (!t && old.portalToken) { cfg.portalToken = old.portalToken; break; }
    if (/^0x[0-9a-fA-F]{40}$/.test(t) || isAccountId(t)) { console.log('  That is an account address, not an access token. Create a Personal Access Token in your portal.hedera.com account settings and paste that.'); continue; }
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(t) || /^30[0-9a-fA-F]{60,}$/.test(t)) { console.log('  That looks like a PRIVATE KEY — never share it. Sensor Keeper only needs a Portal Personal Access Token.'); continue; }
    if (t.length < 16) { console.log('  That looks too short for a token. Try again.'); continue; }
    cfg.portalToken = t;
    const st0 = loadState(); st0.tokenBadUntil = 0; saveState(st0);
    break;
  }

  // Thresholds
  console.log('\nStep 3 — when to top up (Enter accepts the recommended values)');
  const lw = parseFloat(await ask(rl, '  Top up when a sensor drops below (HBAR)', old.lowWater));
  cfg.lowWater = lw > 0 ? lw : DEFAULTS.lowWater;
  const ta = parseInt(await ask(rl, `  Amount per top-up (HBAR, max ${FAUCET_MAX_REQUEST})`, old.topupAmount), 10);
  cfg.topupAmount = Math.min(FAUCET_MAX_REQUEST, ta > 0 ? ta : DEFAULTS.topupAmount);
  if (cfg.sensors.length * cfg.topupAmount > FAUCET_DAILY_LIMIT) {
    console.log(`  Note: ${cfg.sensors.length} sensors × ${cfg.topupAmount} HBAR is more than the 100/day faucet limit; top-ups will be spread over several days, which is fine.`);
  }

  // Alerts
  console.log(`
Step 4 — alerts (optional, but recommended)
  You'll only hear from it when something needs attention (plus an optional
  weekly all-good summary). Choose any combination, or none.
  • Discord: paste a channel webhook URL (Channel settings → Integrations → Webhooks).
  • Phone push: install the free "ntfy" app by Philipp Heckel (white bell on teal;
    NOT "Ntfy me" / "Ntfy me - Next Gen", which won't receive these alerts).
    Tap +, subscribe to a hard-to-guess topic name on the default ntfy.sh server
    (anyone who knows it can read your alerts), and enter the same name here.
`);
  cfg.alerts.discordWebhook = await ask(rl, '  Discord webhook URL (Enter to skip)', old.alerts.discordWebhook || '');
  const suggested = old.alerts.ntfyTopic || `sensor-keeper-${Math.random().toString(36).slice(2, 10)}`;
  const useNtfy = await askYesNo(rl, '  Use ntfy for phone push alerts?', !!old.alerts.ntfyTopic);
  if (useNtfy) {
    for (;;) {
      cfg.alerts.ntfyTopic = await ask(rl, '  ntfy topic name (letters, numbers, - or _)', suggested);
      if (/^[A-Za-z0-9_-]{1,64}$/.test(cfg.alerts.ntfyTopic)) break;
      console.log('  Only letters, numbers, - and _ are allowed.');
    }
    if (cfg.alerts.ntfyTopic.length < 12) console.log('  Tip: short topic names are easy to guess; anyone subscribed to it sees your alerts.');
  } else cfg.alerts.ntfyTopic = '';
  cfg.alerts.ntfyEmail = '';
  cfg.weeklySummary = await askYesNo(rl, '  Send a weekly all-good summary?', old.weeklySummary !== false);

  writePrivate(CONFIG, cfg);
  console.log(`\nSaved to ${CONFIG}\n`);

  if (cfg.alerts.discordWebhook || cfg.alerts.ntfyTopic) {
    if (await askYesNo(rl, 'Send a test alert now?', true)) {
      const sent = await sendAlert(cfg, 'Sensor Keeper test', 'Alerts are working. You will hear from me only when a sensor needs attention.', 'low');
      console.log(sent.length ? `  Sent via ${sent.join(' and ')}.` : '  Sending failed — check the webhook/topic and run setup again.');
    }
  }

  console.log('\nChecking your sensor(s) now (no top-up unless one is below your threshold):');
  const { results } = await checkAll(cfg);
  results.forEach((r) => console.log('  ' + describe(r)));

  const autostart = await askYesNo(rl, '\nStart Sensor Keeper automatically in the background, now and at every login?', true);
  let always = false;
  if (autostart && process.platform === 'darwin') {
    console.log('  Tip: if this Mac logs you out when idle, or you want it to keep watch while no one is');
    console.log('  logged in, choose "y" below (needs your Mac password once).');
    always = await askYesNo(rl, '  Keep running even when no one is logged in?', autoLogoutOn());
  }
  rl.close();
  if (autostart) installService(always);
  else console.log(`\nOK. Run "${APP} run" whenever you want it to keep watch, or "${APP} install-service" later.`);
}

// ---------------------------------------------------------------- background service
function autoLogoutOn() {
  if (process.platform !== 'darwin') return false;
  try {
    const v = execFileSync('defaults', ['read', '/Library/Preferences/.GlobalPreferences', 'com.apple.autologout.AutoLogOutDelay'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseInt(v, 10) > 0;
  } catch { return false; }
}
function stableInstall() {
  // Copy ourselves to ~/.sensor-keeper/bin so the service keeps working even if
  // the download folder is cleaned up. Returns the command to launch "run".
  const bin = path.join(HOME, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const exe = process.execPath;
  const runningUnderNode = /^node(\.exe)?$/i.test(path.basename(exe));
  if (runningUnderNode) {
    const target = path.join(bin, 'keeper.js');
    if (path.resolve(__filename) !== target) fs.copyFileSync(__filename, target);
    return { cmd: exe, args: [target, 'run'] };
  }
  const target = path.join(bin, process.platform === 'win32' ? `${APP}.exe` : APP);
  if (path.resolve(exe) !== target) {
    fs.copyFileSync(exe, target);
    try { fs.chmodSync(target, 0o755); } catch {}
  }
  return { cmd: target, args: ['run'] };
}

// Run a shell command as administrator: sudo in a terminal, or the standard
// macOS password dialog when started from the app (no terminal attached).
function runAdmin(shellCmd) {
  if (process.platform === 'darwin' && (UI_MODE || !process.stdin.isTTY)) {
    const q = '"' + shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    execFileSync('osascript', ['-e', `do shell script ${q} with administrator privileges with prompt "Sensor Keeper needs your password to run in the background even when no one is logged in."`]);
  } else {
    execFileSync('sudo', ['sh', '-c', shellCmd], { stdio: 'inherit' });
  }
}
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// macOS: a LaunchDaemon keeps running even when nobody is logged in (for example
// when "Log out automatically after inactivity" is on). Needs the admin password once.
function installMacDaemon(cmd, args) {
  const label = 'com.sensorkeeper.daemon';
  const target = `/Library/LaunchDaemons/${label}.plist`;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const tmp = path.join(HOME, `${label}.plist`);
  fs.writeFileSync(tmp, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>UserName</key><string>${esc(os.userInfo().username)}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${esc(os.homedir())}</string></dict>
  <key>ProgramArguments</key><array>${[cmd, ...args].map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(HOME, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(HOME, 'service.log'))}</string>
</dict></plist>
`);
  console.log('\nmacOS will ask for your Mac password (it is not stored or seen by Sensor Keeper).');
  runAdmin(`launchctl bootout system/${label} 2>/dev/null; install -m 644 -o root -g wheel ${shq(tmp)} ${shq(target)} && launchctl bootstrap system ${shq(target)}`);
  fs.rmSync(tmp, { force: true });
  // remove the per-login agent so only one copy is managed
  try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/com.sensorkeeper.agent`], { stdio: 'ignore' }); } catch {}
  fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.sensorkeeper.agent.plist'), { force: true });
  console.log(`\nInstalled and started as a system service (${label}) — runs even when you're logged out.`);
}

function installService(always = false) {
  ensureHome();
  const { cmd, args } = stableInstall();
  const platform = process.platform;
  if (platform === 'darwin' && always) {
    installMacDaemon(cmd, args);
  } else if (platform === 'darwin') {
    if (fs.existsSync('/Library/LaunchDaemons/com.sensorkeeper.daemon.plist')) {
      runAdmin('launchctl bootout system/com.sensorkeeper.daemon 2>/dev/null; rm -f /Library/LaunchDaemons/com.sensorkeeper.daemon.plist');
    }
    const label = 'com.sensorkeeper.agent';
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${[cmd, ...args].map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(HOME, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(HOME, 'service.log'))}</string>
</dict></plist>
`);
    const uid = process.getuid();
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    console.log(`\nInstalled and started (macOS LaunchAgent ${label}).`);
  } else if (platform === 'linux') {
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
    let ok = false;
    try {
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(path.join(unitDir, `${APP}.service`), `[Unit]
Description=Sensor Keeper (4DSKY / Neuron HBAR top-up)
After=network-online.target

[Service]
ExecStart=${[cmd, ...args].map(q).join(' ')}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`);
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', '--now', `${APP}.service`]);
      ok = true;
      try { execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' }); }
      catch { console.log(`Tip: run "sudo loginctl enable-linger ${os.userInfo().username}" so it also runs when you're not logged in.`); }
      console.log(`\nInstalled and started (systemd user service ${APP}).`);
    } catch (e) {
      console.log(`systemd not available (${e.message.split('\n')[0]}); falling back to cron.`);
    }
    if (!ok) {
      const line = `@reboot ${[cmd, ...args].map(q).join(' ')} >> ${q(path.join(HOME, 'service.log'))} 2>&1`;
      let tab = '';
      try { tab = execFileSync('crontab', ['-l'], { encoding: 'utf8' }); } catch {}
      tab = tab.split('\n').filter((l) => !l.includes('.sensor-keeper')).join('\n').trim();
      let cronOk = true;
      try { execFileSync('crontab', ['-'], { input: `${tab}\n${line}\n` }); } catch { cronOk = false; }
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      console.log(cronOk ? '\nInstalled (@reboot cron entry) and started.'
        : `\nStarted in the background, but couldn't set up auto-start (no systemd or cron found).\nAdd this to your startup scripts: ${[cmd, ...args].map(q).join(' ')}`);
    }
  } else if (platform === 'win32') {
    const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const vbs = path.join(startup, 'SensorKeeper.vbs');
    const quoted = [cmd, ...args].map((a) => `""${a}""`).join(' ');
    fs.writeFileSync(vbs, `' Starts Sensor Keeper hidden at login\r\nCreateObject("WScript.Shell").Run "${quoted}", 0, False\r\n`);
    spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
    console.log(`\nInstalled and started (runs hidden at every login via ${vbs}).`);
  } else {
    console.log(`Automatic start isn't supported on ${platform}. Run "${APP} run" yourself.`);
    return;
  }
  console.log(`Logs: ${LOG}\nCheck any time with: ${APP} status`);
}

function uninstallService() {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      const label = 'com.sensorkeeper.agent';
      try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); } catch {}
      fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`), { force: true });
      if (fs.existsSync('/Library/LaunchDaemons/com.sensorkeeper.daemon.plist')) {
        console.log('Removing the system service (macOS will ask for your password)…');
        runAdmin('launchctl bootout system/com.sensorkeeper.daemon 2>/dev/null; rm -f /Library/LaunchDaemons/com.sensorkeeper.daemon.plist');
      }
    } else if (platform === 'linux') {
      try { execFileSync('systemctl', ['--user', 'disable', '--now', `${APP}.service`], { stdio: 'ignore' }); } catch {}
      fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', `${APP}.service`), { force: true });
      try {
        const tab = execFileSync('crontab', ['-l'], { encoding: 'utf8' });
        execFileSync('crontab', ['-'], { input: tab.split('\n').filter((l) => !l.includes('.sensor-keeper')).join('\n') + '\n' });
      } catch {}
    } else if (platform === 'win32') {
      fs.rmSync(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SensorKeeper.vbs'), { force: true });
    }
    const pid = parseInt(readJson(LOCK, null), 10);
    if (pid) { try { process.kill(pid); } catch {} }
    console.log(`Background service removed. Your settings are still in ${HOME} (delete that folder to remove everything).`);
  } catch (e) { console.error(`Couldn't fully remove the service: ${e.message}`); }
}

// ---------------------------------------------------------------- status
function showStatus() {
  const cfg = loadConfig();
  if (!cfg) { console.log(`Not set up yet. Run: ${APP} setup`); return; }
  const st = loadState();
  const pid = parseInt(readJson(LOCK, null), 10);
  let running = false;
  if (pid) { try { process.kill(pid, 0); running = true; } catch {} }
  console.log(`Sensor Keeper ${VERSION} — background service ${running ? `running (pid ${pid})` : 'NOT running'}${cfg.dryRun ? ' [dry-run]' : ''}`);
  console.log(`Last check: ${st.lastRun ? iso(st.lastRun) : 'never'}   Faucet used in last 24 h: ${faucetUsed24h(st)} / ${FAUCET_DAILY_LIMIT} HBAR`);
  for (const s of cfg.sensors) {
    const x = st.sensors[s.id] || {};
    const days = x.burnPerDay && x.lastBalance != null ? ` (~${fmt(x.lastBalance / x.burnPerDay, 0)} days at ${fmt(x.burnPerDay, 1)} HBAR/day)` : '';
    const probs = Object.keys(x.problems || {});
    console.log(`  ${s.name ? `${s.name} ` : ''}${s.id}: ${x.lastBalance != null ? fmt(x.lastBalance) + ' HBAR' : 'no data yet'}${days}` +
      `${x.lastTopup ? `, last top-up ${iso(x.lastTopup)}` : ''}${probs.length ? `, PROBLEMS: ${probs.join(', ')}` : ''}`);
  }
  console.log(`Top up below ${cfg.lowWater} HBAR, ${cfg.topupAmount} HBAR at a time. Settings: ${CONFIG}`);
}

// ---------------------------------------------------------------- app window (local web UI)
// "sensor-keeper ui" starts a small web server on 127.0.0.1 only, protected by a
// random session key, and opens it in the default browser. It stops by itself a
// minute or two after the window is closed.

function serviceInfo() {
  const pid = parseInt(readJson(LOCK, null), 10);
  let running = false;
  if (pid) { try { process.kill(pid, 0); running = true; } catch {} }
  let mode = 'none';
  const p = process.platform;
  if (p === 'darwin') {
    if (fs.existsSync('/Library/LaunchDaemons/com.sensorkeeper.daemon.plist')) mode = 'always';
    else if (fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.sensorkeeper.agent.plist'))) mode = 'login';
  } else if (p === 'linux') {
    if (fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', `${APP}.service`))) mode = 'login';
  } else if (p === 'win32') {
    if (process.env.APPDATA && fs.existsSync(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SensorKeeper.vbs'))) mode = 'login';
  }
  return { running, pid: running ? pid : null, mode };
}

// Turn log lines into a friendly activity feed.
function readActivity(limit = 300) {
  let lines = [];
  for (const f of [LOG + '.1', LOG]) {
    try { lines = lines.concat(fs.readFileSync(f, 'utf8').split('\n')); } catch {}
  }
  const out = [];
  for (const line of lines) {
    const m = line.match(/^(\d{4}-\d\d-\d\dT[\d:]+Z) (.*)$/);
    if (!m) continue;
    const [, t, msg] = m;
    let kind = 'check';
    if (/top-up of [\d.]+ HBAR requested/.test(msg)) kind = 'topup';
    else if (/^alert sent via /.test(msg)) kind = 'alert';
    else if (/\[dry-run\]/.test(msg)) kind = 'info';
    else if (/top-up failed|ERROR|error|failed|NOT FOUND|ALERT/.test(msg)) kind = 'problem';
    else if (/started, watching/.test(msg)) kind = 'info';
    else if (/^alert:/.test(msg)) kind = 'problem';
    out.push({ t, kind, msg });
  }
  return out.slice(-limit).reverse();
}

function topupSummary() {
  let count = 0, total = 0, last = null;
  for (const e of readActivity(100000)) {
    const m = e.kind === 'topup' && e.msg.match(/top-up of ([\d.]+) HBAR/);
    if (m) { count++; total += parseFloat(m[1]); if (!last) last = e.t; }
  }
  return { count, total, last };
}

function publicConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || DEFAULTS));
  const t = c.portalToken || '';
  delete c.portalToken;
  c.tokenSet = !!t;
  c.tokenHint = t ? '…' + t.slice(-4) : '';
  return c;
}

function validateToken(t) {
  if (/^0x[0-9a-fA-F]{40}$/.test(t) || isAccountId(t)) return 'That is an account address, not an access token. Create a Personal Access Token in your portal.hedera.com account settings.';
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t) || /^30[0-9a-fA-F]{60,}$/.test(t)) return 'That looks like a PRIVATE KEY — never share it. Sensor Keeper only needs a Portal Personal Access Token.';
  if (t.length < 16) return 'That looks too short for an access token.';
  return null;
}

function openBrowser(url) {
  const p = process.platform;
  try {
    if (p === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (p === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* print URL instead */ }
}

async function runUi() {
  const http = require('http');
  const crypto = require('crypto');
  ensureHome();
  const key = crypto.randomBytes(18).toString('hex');
  // Standalone builds store the page's special characters (→ — …) as \uXXXX
  // escapes; turn them back into real characters before serving.
  const PAGE = UI_HTML.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  let lastPing = now();

  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const body = (req) => new Promise((resolve) => {
    let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    // Only answer requests addressed to this local server (blocks DNS-rebinding tricks).
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); return res.end(); }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.get('k') !== key) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Open Sensor Keeper from its app icon or with "sensor-keeper ui".'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:" });
      return res.end(PAGE.replace('__KEY__', key).replace('__VERSION__', VERSION));
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    if (req.headers['x-sk-key'] !== key) return send(res, 403, { error: 'forbidden' });
    lastPing = now();
    try {
      const cfg = loadConfig();
      const api = url.pathname.slice(5);
      if (api === 'ping') return send(res, 200, { ok: true });
      if (api === 'state') {
        const st = loadState();
        const sensors = (cfg ? cfg.sensors : []).map((s) => {
          const x = st.sensors[s.id] || {};
          return { ...s, balance: x.lastBalance ?? null, burnPerDay: x.burnPerDay ?? null, lastCheck: x.lastCheck || null,
            lastTopup: x.lastTopup || null, problems: Object.keys(x.problems || {}) };
        });
        return send(res, 200, {
          version: VERSION, platform: process.platform, configured: !!(cfg && cfg.sensors.length),
          config: publicConfig(cfg), sensors, service: serviceInfo(), autoLogout: autoLogoutOn(),
          lastRun: st.lastRun || null, faucetUsed: faucetUsed24h(st), faucetLimit: FAUCET_DAILY_LIMIT,
          topups: topupSummary(), home: HOME,
        });
      }
      if (api === 'activity') return send(res, 200, { items: readActivity(parseInt(url.searchParams.get('n') || '300', 10)) });
      if (api === 'check-sensor') {
        const b = await body(req);
        if (!isAccountId(b.id || '')) return send(res, 200, { ok: false, message: "That doesn't look like a Hedera account ID (0.0.12345)." });
        const bal = await getBalance(b.id);
        if (bal.missing) return send(res, 200, { ok: false, message: 'Not found on Hedera testnet. Double-check the ID.' });
        const hb = await getHeartbeats(b.id).catch(() => ({}));
        const out = { ok: true, balance: bal.balance, heartbeatAgeMin: hb.lastAgeMin ?? null };
        if (hb.lastAgeMin == null || hb.lastAgeMin > 60) out.warning = "This account isn't sending heartbeats. Make sure it's the sensor's own device account (the one that pays for its heartbeats), not your wallet or rewards account.";
        if (b.statusUrl) {
          try { const d = await getDeviceStatus(b.statusUrl); out.device = d.bad.length ? d.bad.join('; ') : 'all green'; }
          catch (e) { out.device = `not reachable (${e.message})`; }
        }
        return send(res, 200, out);
      }
      if (api === 'save') {
        const b = await body(req);
        const next = JSON.parse(JSON.stringify(cfg || DEFAULTS));
        const sensors = [];
        for (const s of b.sensors || []) {
          const id = String(s.id || '').trim();
          if (!id) continue;
          if (!isAccountId(id)) return send(res, 400, { error: `"${id}" isn't a Hedera account ID (0.0.12345).` });
          let statusUrl = String(s.statusUrl || '').trim();
          if (statusUrl && !/^https?:\/\//.test(statusUrl)) statusUrl = 'http://' + statusUrl;
          sensors.push({ id, ...(s.name ? { name: String(s.name).trim().slice(0, 60) } : {}), ...(statusUrl ? { statusUrl } : {}) });
        }
        if (!sensors.length) return send(res, 400, { error: 'Add at least one sensor account ID.' });
        next.sensors = sensors;
        const tok = String(b.portalToken || '').trim();
        if (tok) {
          const err = validateToken(tok);
          if (err) return send(res, 400, { error: err });
          next.portalToken = tok;
          const st = loadState(); st.tokenBadUntil = 0; saveState(st);
        }
        if (!next.portalToken) return send(res, 400, { error: 'Paste your Hedera Portal access token (see step 2).' });
        const lw = parseFloat(b.lowWater), ta = parseInt(b.topupAmount, 10), ce = parseInt(b.checkEveryMinutes, 10);
        next.lowWater = lw > 0 ? lw : DEFAULTS.lowWater;
        next.topupAmount = Math.min(FAUCET_MAX_REQUEST, ta > 0 ? ta : DEFAULTS.topupAmount);
        next.checkEveryMinutes = Math.min(720, Math.max(10, ce > 0 ? ce : DEFAULTS.checkEveryMinutes));
        const topic = String(b.ntfyTopic || '').trim();
        if (topic && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return send(res, 400, { error: 'ntfy topic: only letters, numbers, - and _ are allowed.' });
        const hook = String(b.discordWebhook || '').trim();
        if (hook && !/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(hook)) return send(res, 400, { error: "That doesn't look like a Discord webhook URL." });
        next.alerts = { ...next.alerts, discordWebhook: hook, ntfyTopic: topic, ntfyEmail: '' };
        next.weeklySummary = !!b.weeklySummary;
        writePrivate(CONFIG, next);
        log('settings saved from the app');
        return send(res, 200, { ok: true, config: publicConfig(next) });
      }
      if (!cfg || !cfg.sensors.length) return send(res, 400, { error: 'Save your settings first.' });
      if (api === 'check-now') { const { results } = await checkAll(cfg); results.forEach((r) => log(describe(r))); return send(res, 200, { results: results.map(describe) }); }
      if (api === 'test-alert') { const sent = await sendAlert(cfg, 'Sensor Keeper test', 'Alerts are working. You will hear from me only when a sensor needs attention.', 'low'); return send(res, 200, { sent }); }
      if (api === 'topup') {
        const b = await body(req);
        const s = cfg.sensors.find((x) => x.id === b.id);
        if (!s) return send(res, 400, { error: 'Unknown sensor.' });
        const state = loadState();
        const r = await checkSensor(cfg, state, s, { forceTopup: true });
        saveState(state);
        return send(res, 200, { result: describe(r) });
      }
      if (api === 'service') {
        const b = await body(req);
        if (b.action === 'install') { installService(!!b.always); await sleep(1500); }
        else if (b.action === 'uninstall') { uninstallService(); await sleep(500); }
        return send(res, 200, { service: serviceInfo() });
      }
      return send(res, 404, { error: 'unknown' });
    } catch (e) {
      const msg = /User canceled|-128/.test(e.message) ? 'Cancelled — no changes made.' : e.message.split('\n')[0];
      return send(res, 500, { error: msg });
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/?k=${key}`;
  console.log(`Sensor Keeper is open in your browser. If it didn't open, visit:\n  ${url}\n(Leave this running while you use it; it closes itself after the window is closed.)`);
  if (!process.argv.includes('--no-open')) openBrowser(url);
  setInterval(() => { if (now() - lastPing > 120000) { server.close(); process.exit(0); } }, 15000).unref();
}

// App launchers so people can open Sensor Keeper like any other app.
function installLaunchers() {
  ensureHome();
  const { cmd, args } = stableInstall();
  const uiArgs = [...args.slice(0, -1), 'ui'];
  const p = process.platform;
  const made = [];
  if (p === 'darwin') {
    const appDir = path.join(os.homedir(), 'Applications', 'Sensor Keeper.app');
    const macos = path.join(appDir, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Sensor Keeper</string>
  <key>CFBundleDisplayName</key><string>Sensor Keeper</string>
  <key>CFBundleIdentifier</key><string>io.github.killgja.sensorkeeper</string>
  <key>CFBundleExecutable</key><string>Sensor Keeper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);
    const launcher = path.join(macos, 'Sensor Keeper');
    fs.writeFileSync(launcher, `#!/bin/sh\nexec ${[cmd, ...uiArgs].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} >> '${path.join(HOME, 'ui.log')}' 2>&1\n`);
    fs.chmodSync(launcher, 0o755);
    made.push(appDir);
  } else if (p === 'win32') {
    const vbs = path.join(HOME, 'Open Sensor Keeper.vbs');
    const quoted = [cmd, ...uiArgs].map((a) => `""${a}""`).join(' ');
    fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${quoted}", 0, False\r\n`);
    const ps = (lnk) => `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');` +
      `$s.TargetPath='wscript.exe';$s.Arguments='"${vbs.replace(/'/g, "''")}"';$s.IconLocation='${cmd.replace(/'/g, "''")},0';$s.Description='Sensor Keeper';$s.Save()`;
    const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Sensor Keeper.lnk');
    const desktop = path.join(os.homedir(), 'Desktop', 'Sensor Keeper.lnk');
    for (const lnk of [startMenu, desktop]) {
      try { execFileSync('powershell', ['-NoProfile', '-Command', ps(lnk)], { stdio: 'ignore', windowsHide: true }); made.push(lnk); } catch {}
    }
  } else if (p === 'linux') {
    const dir = path.join(os.homedir(), '.local', 'share', 'applications');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'sensor-keeper.desktop');
    fs.writeFileSync(f, `[Desktop Entry]\nType=Application\nName=Sensor Keeper\nComment=Keep 4DSKY sensors funded\nExec=${[cmd, ...uiArgs].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\nTerminal=false\nCategories=Utility;\n`);
    made.push(f);
  }
  made.forEach((m) => console.log(`App shortcut: ${m}`));
  return made;
}

const UI_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sensor Keeper</title>
<style>
:root{--bg:#f5f7fa;--card:#fff;--ink:#1d2430;--muted:#5f6b7a;--line:#e1e6ed;--accent:#0f7b8a;--accent-ink:#fff;--ok:#1a7f4b;--warn:#b26a00;--bad:#c0392b;--chip:#eef2f6;--topup:#e6f5ee}
@media (prefers-color-scheme:dark){:root{--bg:#0f141a;--card:#171e26;--ink:#e6ebf1;--muted:#98a4b3;--line:#27313c;--accent:#27a9b8;--accent-ink:#06181b;--ok:#3ccf85;--warn:#f0a53a;--bad:#ff6b5e;--chip:#202a35;--topup:#12291f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:18px 24px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:5}
header h1{font-size:19px;margin:0}header .ver{color:var(--muted);font-size:13px}.grow{flex:1}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:13px;background:var(--chip)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
main{max-width:980px;margin:0 auto;padding:20px 16px 80px;display:grid;gap:16px}
nav.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line)}nav.tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:10px 14px;color:var(--muted);font:inherit;cursor:pointer}
nav.tabs button.on{color:var(--ink);border-color:var(--accent);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.card h2{font-size:16px;margin:0 0 4px}.card p.help{color:var(--muted);margin:2px 0 12px;font-size:14px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input[type=text],input[type=password],input[type=number],input[type=url]{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:0}
.row{display:grid;grid-template-columns:1.1fr 1fr 1.2fr auto;gap:10px;align-items:end}
.row3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
@media (max-width:720px){.row,.row3{grid-template-columns:1fr}}
button.btn{border:1px solid var(--line);background:var(--card);color:var(--ink);padding:8px 14px;border-radius:8px;font:inherit;cursor:pointer;white-space:nowrap}
button.btn:hover{border-color:var(--accent)}button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
button.small{padding:5px 10px;font-size:13px}button:disabled{opacity:.55;cursor:default}
.sensor{border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0}
.note{font-size:13px;margin-top:6px;color:var(--muted)}.note.ok{color:var(--ok)}.note.warn{color:var(--warn)}.note.bad{color:var(--bad)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}@media (max-width:720px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{background:var(--chip);border-radius:10px;padding:12px}.stat .k{font-size:12px;color:var(--muted)}.stat .v{font-size:22px;font-weight:600}
.feed{list-style:none;margin:0;padding:0}.feed li{display:grid;grid-template-columns:150px 1fr;gap:10px;padding:8px 6px;border-bottom:1px solid var(--line);font-size:14px}
.feed li.topup{background:var(--topup)}.feed li .t{color:var(--muted);font-variant-numeric:tabular-nums}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;margin-right:6px;background:var(--chip);color:var(--muted)}
.tag.topup{background:var(--ok);color:#fff}.tag.alert{background:var(--accent);color:var(--accent-ink)}#tab-settings .card{margin-bottom:16px}.tag.problem{background:var(--bad);color:#fff}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.savebar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px;display:flex;justify-content:center;gap:10px}
#toast{position:fixed;right:16px;bottom:72px;max-width:420px;background:var(--ink);color:var(--bg);padding:10px 14px;border-radius:10px;display:none;z-index:9;font-size:14px}
a{color:var(--accent)}ol.steps{margin:6px 0 0;padding-left:20px;color:var(--muted);font-size:14px}
.warnbox{border-left:3px solid var(--warn);padding:6px 10px;background:var(--chip);border-radius:6px;font-size:13px;margin-top:8px}
.hidden{display:none}.seg{display:flex;gap:6px}.seg button.on{border-color:var(--accent);font-weight:600}
</style></head><body>
<header><h1>Sensor Keeper</h1><span class="ver">v__VERSION__</span><span class="grow"></span>
<span class="pill"><span id="svcDot" class="dot"></span><span id="svcText">…</span></span></header>
<main>
<nav class="tabs"><button data-tab="status" class="on">Status &amp; activity</button><button data-tab="settings">Settings</button></nav>

<section id="tab-status">
  <div class="card"><h2>Your sensors</h2><p class="help" id="lastRun">Loading…</p><div id="sensorStatus"></div>
    <div class="actions" style="margin-top:10px"><button class="btn" id="checkNow">Check now</button><button class="btn" id="testAlert">Send test alert</button></div></div>
  <div class="card" style="margin-top:16px"><h2>What Sensor Keeper has done for you</h2>
    <div class="stats" style="margin:10px 0 14px">
      <div class="stat"><div class="k">Top-ups made</div><div class="v" id="stCount">0</div></div>
      <div class="stat"><div class="k">Test HBAR added</div><div class="v" id="stTotal">0</div></div>
      <div class="stat"><div class="k">Last top-up</div><div class="v" id="stLast" style="font-size:15px">never</div></div>
      <div class="stat"><div class="k">Faucet used (24 h)</div><div class="v" id="stFaucet">0 / 100</div></div>
    </div>
    <div class="actions" style="justify-content:space-between"><div class="seg"><button class="btn small on" data-f="important">Top-ups, alerts &amp; problems</button><button class="btn small" data-f="all">Everything</button></div>
      <span class="note">Updates automatically</span></div>
    <ul class="feed" id="feed" style="margin-top:8px"></ul>
  </div>
</section>

<section id="tab-settings" class="hidden">
  <div class="card"><h2>1. Your sensor(s)</h2>
    <p class="help">Enter each sensor's own Hedera <b>device account ID</b> (looks like 0.0.1234567) — the account that pays for its heartbeats, not your wallet or rewards account. It's in the 4DSKY app and your sensor's Neuron setup.</p>
    <div id="sensorList"></div><button class="btn" id="addSensor">+ Add another sensor</button></div>

  <div class="card"><h2>2. Hedera Portal access token</h2>
    <p class="help">Top-ups come from Hedera's free, official faucet, which needs your own token. It's stored only on this computer.</p>
    <ol class="steps"><li>Go to <a href="https://portal.hedera.com" target="_blank" rel="noopener">portal.hedera.com</a> and sign in. If you don't have an account, create one for free.</li><li>Open your account settings and create a new <b>Personal Access Token</b>.</li><li>Copy the token. It is a long code that starts with <code>v4.public.</code></li><li>Paste it in the box below and press Save settings.</li></ol>
    <label for="token">Access token</label><input type="password" id="token" autocomplete="off" spellcheck="false">
    <div class="note" id="tokenNote"></div></div>

  <div class="card"><h2>3. When to top up</h2>
    <p class="help">Hedera allows 100 test HBAR per person per day and one top-up per sensor per day. A sensor uses about 7 HBAR a day.</p>
    <div class="row3"><div><label for="lowWater">Top up when below (HBAR)</label><input type="number" id="lowWater" min="1"></div>
      <div><label for="topupAmount">Amount per top-up (max 100)</label><input type="number" id="topupAmount" min="1" max="100"></div>
      <div><label for="checkEvery">Check every (minutes)</label><input type="number" id="checkEvery" min="10" max="720"></div></div></div>

  <div class="card"><h2>4. Alerts</h2>
    <p class="help">You'll only hear from Sensor Keeper when something needs attention, plus a short "resolved" note and an optional weekly summary.</p>
    <label for="discord">Discord webhook URL (optional)</label><input type="url" id="discord" placeholder="https://discord.com/api/webhooks/…" spellcheck="false">
    <div class="note">Discord: Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.</div>
    <label for="ntfy">Phone push — ntfy topic name (optional)</label>
    <div class="actions"><input type="text" id="ntfy" placeholder="e.g. sk-yourname-7q4m2x" spellcheck="false" style="flex:1"><button class="btn small" id="genTopic">Make one up for me</button></div>
    <ol class="steps"><li>Install <b>ntfy</b> by Philipp Heckel — white bell on teal (<a href="https://apps.apple.com/us/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a> · <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>). <b>Not</b> "Ntfy me" or "Ntfy me - Next Gen".</li>
      <li>In the app tap <b>+</b>, type the exact topic name above (capitals matter), keep the default ntfy.sh server, Subscribe, and allow notifications.</li>
      <li>Save, then press "Send test alert" on the Status tab.</li></ol>
    <div class="warnbox">The topic name works like a password — anyone who knows it can read your alerts. Use something unique.</div>
    <label style="display:flex;gap:8px;align-items:center;color:var(--ink);margin-top:14px"><input type="checkbox" id="weekly"> Send a weekly "all good" summary</label></div>

  <div class="card"><h2>5. Run in the background</h2>
    <p class="help" id="svcHelp">Sensor Keeper keeps watch in the background and starts automatically.</p>
    <label id="alwaysWrap" class="hidden" style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" id="always"> Keep running even when no one is logged in (asks for your Mac password once)</label>
    <div class="actions" style="margin-top:10px"><button class="btn" id="svcStart">Start / restart background service</button><button class="btn" id="svcStop">Stop background service</button></div>
    <div class="note" id="svcNote"></div></div>
</section>
</main>
<div class="savebar hidden" id="savebar"><button class="btn primary" id="save">Save settings</button><span class="note" id="saveNote" style="align-self:center"></span></div>
<div id="toast"></div>
<script>
var KEY='__KEY__', S=null, filter='important', dirty=false;
function api(p,b){return fetch('/api/'+p,{method:b?'POST':'GET',headers:{'x-sk-key':KEY,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j;});});}
function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function toast(m,ms){var t=$('toast');t.textContent=m;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(function(){t.style.display='none';},ms||4500);}
function ago(ts){if(!ts)return 'never';var s=(Date.now()-new Date(ts).getTime())/1000;if(s<90)return 'just now';if(s<5400)return Math.round(s/60)+' min ago';if(s<172800)return Math.round(s/3600)+' h ago';return Math.round(s/86400)+' days ago';}
function local(ts){try{return new Date(ts).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch(e){return ts;}}
var PROB={heartbeat:'not sending heartbeats',low:'almost out of HBAR',topup:'top-up failing',missing:'account not found (testnet reset?)',mirror:"can't reach Hedera",'device-status':'sensor reports a problem','device-down':'status page unreachable'};
document.querySelectorAll('nav.tabs button').forEach(function(b){b.onclick=function(){document.querySelectorAll('nav.tabs button').forEach(function(x){x.classList.toggle('on',x===b);});$('tab-status').classList.toggle('hidden',b.dataset.tab!=='status');$('tab-settings').classList.toggle('hidden',b.dataset.tab!=='settings');$('savebar').classList.toggle('hidden',b.dataset.tab!=='settings');};});
function showTab(t){document.querySelector('nav.tabs button[data-tab="'+t+'"]').click();}
function renderService(){var v=S.service,d=$('svcDot'),t=$('svcText');
  if(v.running){d.className='dot ok';t.textContent='Running in background'+(v.mode==='always'?' (even when logged out)':'');}
  else if(v.mode!=='none'){d.className='dot warn';t.textContent='Installed, not running';}
  else{d.className='dot bad';t.textContent='Not running';}
  var mac=S.platform==='darwin';$('alwaysWrap').classList.toggle('hidden',!mac);$('alwaysWrap').style.display=mac?'flex':'none';
  if(mac&&$('always')._init!==true){$('always').checked=v.mode==='always'||S.autoLogout;$('always')._init=true;}
  $('svcHelp').textContent=S.platform==='win32'?'Starts hidden every time you sign in to Windows.':S.platform==='linux'?'Runs as a background service for your user.':'Starts automatically. If this Mac logs you out when idle, tick the box below.';
  $('svcNote').textContent=v.running?'Background service is running (process '+v.pid+').':'Background service is not running — press Start after saving your settings.';
  if(S.autoLogout&&v.mode!=='always'&&mac)$('svcNote').textContent+=' This Mac logs out automatically when idle, so choose "keep running even when no one is logged in".';}
function renderStatus(){
  $('lastRun').textContent=S.lastRun?('Last checked '+ago(S.lastRun)+'. Checks run every '+S.config.checkEveryMinutes+' minutes.'):'No checks yet.';
  var h='';S.sensors.forEach(function(s){var days=(s.balance!=null&&s.burnPerDay)?Math.round(s.balance/s.burnPerDay):null;
    var ok=!s.problems.length;h+='<div class="sensor"><div class="actions" style="justify-content:space-between"><div><b>'+esc(s.name||s.id)+'</b> <span class="note">'+esc(s.id)+'</span></div><div class="actions"><span class="pill"><span class="dot '+(ok?'ok':'bad')+'"></span>'+(ok?'Healthy':esc(s.problems.map(function(p){return PROB[p]||p;}).join(', ')))+'</span><button class="btn small" data-topup="'+esc(s.id)+'">Top up now</button></div></div>'+
    '<div class="stats" style="margin-top:10px"><div class="stat"><div class="k">Balance</div><div class="v">'+(s.balance!=null?s.balance.toFixed(1):'–')+' <span style="font-size:13px">HBAR</span></div></div><div class="stat"><div class="k">Days left</div><div class="v">'+(days!=null?days:'–')+'</div></div><div class="stat"><div class="k">Uses per day</div><div class="v">'+(s.burnPerDay?s.burnPerDay.toFixed(1):'–')+'</div></div><div class="stat"><div class="k">Last top-up</div><div class="v" style="font-size:15px">'+(s.lastTopup?ago(s.lastTopup):'never')+'</div></div></div></div>';});
  $('sensorStatus').innerHTML=h||'<p class="help">No sensors yet — open <a href="#" id="goSet">Settings</a> to add yours.</p>';
  if($('goSet'))$('goSet').onclick=function(e){e.preventDefault();showTab('settings');};
  document.querySelectorAll('[data-topup]').forEach(function(b){b.onclick=function(){if(!confirm('Request a top-up for '+b.dataset.topup+' now? It uses part of your daily 100 HBAR faucet allowance.'))return;b.disabled=true;api('topup',{id:b.dataset.topup}).then(function(r){toast(r.result,8000);refresh();}).catch(function(e){toast(e.message,8000);}).then(function(){b.disabled=false;});};});
  var t=S.topups;$('stCount').textContent=t.count;$('stTotal').textContent=t.total.toLocaleString();$('stLast').textContent=t.last?local(t.last):'never';$('stFaucet').textContent=S.faucetUsed+' / '+S.faucetLimit;}
function sensorRow(s){var d=document.createElement('div');d.className='sensor';
  d.innerHTML='<div class="row"><div><label>Account ID</label><input type="text" class="sid" placeholder="0.0.1234567" value="'+esc(s.id)+'"></div><div><label>Nickname (optional)</label><input type="text" class="sname" value="'+esc(s.name)+'"></div><div><label>Jetvision status page on your network (optional)</label><input type="text" class="surl" placeholder="http://192.168.1.50" value="'+esc(s.statusUrl)+'"></div><div class="actions"><button class="btn small chk">Check</button><button class="btn small rm" title="Remove">Remove</button></div></div><div class="note res"></div>';
  d.querySelector('.rm').onclick=function(){d.remove();markDirty();};
  d.querySelector('.chk').onclick=function(){var r=d.querySelector('.res');r.className='note';r.textContent='Checking Hedera…';api('check-sensor',{id:d.querySelector('.sid').value.trim(),statusUrl:d.querySelector('.surl').value.trim()}).then(function(j){if(!j.ok){r.className='note bad';r.textContent=j.message;return;}
    r.className='note '+(j.warning?'warn':'ok');r.textContent='Found — '+j.balance.toFixed(2)+' HBAR'+(j.heartbeatAgeMin!=null?', last heartbeat '+j.heartbeatAgeMin.toFixed(1)+' min ago':'')+(j.device?'; status page: '+j.device:'')+(j.warning?'. '+j.warning:'.');}).catch(function(e){r.className='note bad';r.textContent=e.message;});};
  d.querySelectorAll('input').forEach(function(i){i.oninput=markDirty;});return d;}
function renderSettings(){var c=S.config;var L=$('sensorList');L.innerHTML='';(S.sensors.length?S.sensors:[{id:'',name:'',statusUrl:''}]).forEach(function(s){L.appendChild(sensorRow(s));});
  $('token').value='';$('token').placeholder=c.tokenSet?'Saved ('+c.tokenHint+') — paste a new one only to replace it':'Paste your Personal Access Token';
  $('tokenNote').className='note '+(c.tokenSet?'ok':'warn');$('tokenNote').textContent=c.tokenSet?'A token is saved.':'No token saved yet — top-ups can\'t run without it.';
  $('lowWater').value=c.lowWater;$('topupAmount').value=c.topupAmount;$('checkEvery').value=c.checkEveryMinutes;
  $('discord').value=c.alerts.discordWebhook||'';$('ntfy').value=c.alerts.ntfyTopic||'';$('weekly').checked=c.weeklySummary!==false;dirty=false;$('saveNote').textContent='';}
function markDirty(){dirty=true;$('saveNote').textContent='Unsaved changes';}
['token','lowWater','topupAmount','checkEvery','discord','ntfy','weekly'].forEach(function(id){$(id).addEventListener('input',markDirty);$(id).addEventListener('change',markDirty);});
$('addSensor').onclick=function(){$('sensorList').appendChild(sensorRow({id:'',name:'',statusUrl:''}));markDirty();};
$('genTopic').onclick=function(){var a='abcdefghjkmnpqrstuvwxyz23456789',r='sk-';for(var i=0;i<10;i++)r+=a[Math.floor(Math.random()*a.length)];$('ntfy').value=r;markDirty();};
$('save').onclick=function(){var b=$('save');b.disabled=true;var sensors=[];document.querySelectorAll('#sensorList .sensor').forEach(function(d){sensors.push({id:d.querySelector('.sid').value.trim(),name:d.querySelector('.sname').value.trim(),statusUrl:d.querySelector('.surl').value.trim()});});
  api('save',{sensors:sensors,portalToken:$('token').value.trim(),lowWater:$('lowWater').value,topupAmount:$('topupAmount').value,checkEveryMinutes:$('checkEvery').value,discordWebhook:$('discord').value.trim(),ntfyTopic:$('ntfy').value.trim(),weeklySummary:$('weekly').checked})
  .then(function(){toast(S.service.running?'Saved. The background service picks up the changes within a minute.':'Saved. Now start the background service (step 5).');return refresh(true);}).catch(function(e){toast(e.message,9000);$('saveNote').textContent=e.message;}).then(function(){b.disabled=false;});};
function svc(action){var btns=[$('svcStart'),$('svcStop')];btns.forEach(function(x){x.disabled=true;});$('svcNote').textContent=action==='install'?'Starting…'+(S.platform==='darwin'&&$('always').checked?' (enter your Mac password in the dialog)':''):'Stopping…';
  api('service',{action:action,always:$('always').checked}).then(function(){toast(action==='install'?'Background service started.':'Background service stopped.');return refresh();}).catch(function(e){toast(e.message,9000);$('svcNote').textContent=e.message;}).then(function(){btns.forEach(function(x){x.disabled=false;});});}
$('svcStart').onclick=function(){if(dirty){toast('Save your settings first.');return;}svc('install');};
$('svcStop').onclick=function(){if(confirm('Stop the background service? Your sensor will not be topped up or watched until you start it again.'))svc('uninstall');};
$('checkNow').onclick=function(){var b=$('checkNow');b.disabled=true;b.textContent='Checking…';api('check-now',{}).then(function(r){toast(r.results.join('\n'),9000);return refresh();}).catch(function(e){toast(e.message,8000);}).then(function(){b.disabled=false;b.textContent='Check now';});};
$('testAlert').onclick=function(){api('test-alert',{}).then(function(r){toast(r.sent.length?'Test alert sent via '+r.sent.join(' and ')+'.':'No alert channel set up yet — add Discord or ntfy in Settings.',7000);loadFeed();}).catch(function(e){toast(e.message);});};
document.querySelectorAll('.seg button').forEach(function(b){b.onclick=function(){filter=b.dataset.f;document.querySelectorAll('.seg button').forEach(function(x){x.classList.toggle('on',x===b);});loadFeed();};});
function friendly(e){var m=e.msg;var r=m.match(/^(.*?): top-up of ([\d.]+) HBAR requested from Hedera faucet(?:, tx (.*))?$/);if(r)return '<span class="tag topup">Top-up</span>Added <b>'+esc(r[2])+' test HBAR</b> to '+esc(r[1])+(r[3]?' <span class="note">(tx '+esc(r[3])+')</span>':'');
  var a=m.match(/^alert sent via (.*?): (.*)$/);if(a)return '<span class="tag alert">Alert sent</span>'+esc(a[2].replace(/^Sensor Keeper: /,''))+' <span class="note">('+esc(a[1])+')</span>';
  var f=[[/^alert: (Discord|ntfy) returned HTTP (\d+)/,function(x){return "Couldn't send the "+(x[1]==='ntfy'?'phone':'Discord')+' alert (HTTP '+x[2]+'). Check the '+(x[1]==='ntfy'?'ntfy topic':'webhook')+' in Settings.';}],
    [/^alert: (Discord|ntfy) failed: (.*)/,function(x){return "Couldn't send the "+(x[1]==='ntfy'?'phone':'Discord')+' alert ('+x[2]+').';}],
    [/^(.*?): mirror node error: (.*)/,function(x){return "Couldn't reach Hedera to check "+x[1]+' ('+x[2]+') — will retry.';}],
    [/^ALERT \(no alert channel configured\): (.*)/,function(x){return 'Alert not delivered (no working alert channel): '+x[1];}],
    [/^ALERT not delivered \(no working alert channel\): (.*)/,function(x){return 'Alert not delivered (no working alert channel): '+x[1];}]];
  for(var i=0;i<f.length;i++){var mm=m.match(f[i][0]);if(mm)return '<span class="tag problem">Problem</span>'+esc(f[i][1](mm));}
  if(e.kind==='problem')return '<span class="tag problem">Problem</span>'+esc(m);if(/started, watching/.test(m))return '<span class="tag">Service</span>'+esc(m);if(/settings saved/.test(m))return '<span class="tag">Settings</span>Settings saved';return '<span class="tag">Check</span>'+esc(m);}
function loadFeed(){return api('activity?n=400').then(function(j){var items=j.items.filter(function(e){return filter==='all'||e.kind==='topup'||e.kind==='problem'||e.kind==='alert';}).slice(0,200);
  $('feed').innerHTML=items.length?items.map(function(e){return '<li class="'+e.kind+'"><span class="t">'+esc(local(e.t))+'</span><span>'+friendly(e)+'</span></li>';}).join(''):'<li><span></span><span class="note">'+(filter==='all'?'No activity yet.':'No top-ups or problems yet — that\'s good news. Choose "Everything" to see every check.')+'</span></li>';});}
function refresh(resetSettings){return api('state').then(function(j){var first=!S;S=j;renderService();renderStatus();if(first||resetSettings||!dirty)renderSettings();if(first&&!j.configured)showTab('settings');return loadFeed();}).catch(function(e){toast('Lost connection to Sensor Keeper: '+e.message+'. Reopen the app.',10000);});}
refresh();setInterval(function(){if(!document.hidden)refresh();},20000);setInterval(function(){api('ping').catch(function(){});},15000);
window.addEventListener('beforeunload',function(e){if(dirty){e.preventDefault();e.returnValue='';}});
</script></body></html>`;


// ---------------------------------------------------------------- main
function help() {
  console.log(`Sensor Keeper ${VERSION} — keeps 4DSKY / Neuron sensors funded with Hedera testnet HBAR

Usage: ${APP} <command>

  setup               Answer a few questions and (optionally) start in the background
  status              Show balances, last top-ups and any problems
  check               Run one check right now and print the result
  run                 Keep watch in the foreground (what the background service runs)
  topup <0.0.x>       Request a top-up for a sensor right now
  test-alert          Send a test alert to your configured channels
  ui                  Open the Sensor Keeper app window (settings, status, activity log)
  install-launcher    Add a "Sensor Keeper" app icon (Applications / Start Menu / app menu)
  install-service     Start automatically in the background at login
                      (macOS: add --always to keep running while logged out)
  uninstall-service   Stop and remove the background service
  logs                Show the last 40 log lines
  version             Print the version

Add --dry-run to check/run/topup to see what would happen without requesting HBAR.
Settings live in ${HOME}`);
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const desktop = process.platform === 'win32' || process.platform === 'darwin' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const cmd = argv[0] || (desktop ? 'ui' : (process.stdin.isTTY && !loadConfig() ? 'setup' : 'help'));
  const needCfg = () => {
    const c = loadConfig();
    if (!c || !c.sensors.length) { console.error(`Not set up yet. Run: ${APP} setup`); process.exit(1); }
    return c;
  };
  switch (cmd) {
    case 'setup': return setup();
    case 'ui': case 'app': UI_MODE = true; return runUi();
    case 'install-launcher': installLaunchers(); return;
    case 'run': return runLoop();
    case 'check': { const { results } = await checkAll(needCfg()); results.forEach((r) => console.log(describe(r))); return; }
    case 'topup': {
      const c = needCfg();
      const s = c.sensors.find((x) => x.id === argv[1]) || (isAccountId(argv[1]) ? { id: argv[1] } : null);
      if (!s) { console.error(`Usage: ${APP} topup 0.0.12345`); process.exit(1); }
      const state = loadState();
      const r = await checkSensor(c, state, s, { forceTopup: true });
      saveState(state);
      console.log(describe(r));
      return;
    }
    case 'status': return showStatus();
    case 'test-alert': { const sent = await sendAlert(needCfg(), 'Sensor Keeper test', 'Alerts are working.', 'low'); console.log(sent.length ? `Sent via ${sent.join(' and ')}` : 'No alert channel configured or sending failed (see log).'); return; }
    case 'install-service': return installService(argv.includes('--always') || process.argv.includes('--always'));
    case 'uninstall-service': return uninstallService();
    case 'logs': { try { console.log(fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-40).join('\n')); } catch { console.log('No log yet.'); } return; }
    case 'version': case '--version': case '-v': console.log(VERSION); return;
    default: help();
  }
}

if (typeof fetch !== 'function') {
  console.error('Sensor Keeper needs Node.js 18 or newer (or use the standalone download).');
  process.exit(1);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
