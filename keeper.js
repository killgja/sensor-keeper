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

const VERSION = '1.0.0';
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
      if (a.ntfyEmail) headers.Email = a.ntfyEmail;
      const r = await http(`${(a.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(a.ntfyTopic)}`, { method: 'POST', headers, body });
      if (r.ok) sent.push('ntfy'); else log(`alert: ntfy returned HTTP ${r.status}`);
    } catch (e) { log(`alert: ntfy failed: ${e.message}`); }
  }
  if (!sent.length) log(`ALERT (no alert channel configured): ${title} — ${body}`);
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
            `The faucet refused your access token (${e.status}). Create a new Personal Access Token at portal.hedera.com and run "${APP} setup".`);
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
        if (cfg.weeklySummary && now() - (state.lastSummary || 0) > 7 * DAY) {
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
  • Phone push: install the free "ntfy" app, subscribe to a hard-to-guess topic
    name, and enter the same topic name here.
  • Email: ntfy can also email you — enter your address.
`);
  cfg.alerts.discordWebhook = await ask(rl, '  Discord webhook URL (Enter to skip)', old.alerts.discordWebhook || '');
  const suggested = old.alerts.ntfyTopic || `sensor-keeper-${Math.random().toString(36).slice(2, 10)}`;
  const useNtfy = await askYesNo(rl, '  Use ntfy for phone push / email?', !!old.alerts.ntfyTopic);
  if (useNtfy) {
    cfg.alerts.ntfyTopic = await ask(rl, '  ntfy topic name', suggested);
    cfg.alerts.ntfyEmail = await ask(rl, '  Also email alerts to (Enter to skip)', old.alerts.ntfyEmail || '');
  } else { cfg.alerts.ntfyTopic = ''; cfg.alerts.ntfyEmail = ''; }
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
  const sudo = (a) => execFileSync('sudo', a, { stdio: 'inherit' });
  try { execFileSync('sudo', ['launchctl', 'bootout', `system/${label}`], { stdio: 'ignore' }); } catch {}
  sudo(['install', '-m', '644', '-o', 'root', '-g', 'wheel', tmp, target]);
  sudo(['launchctl', 'bootstrap', 'system', target]);
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
        try { execFileSync('sudo', ['launchctl', 'bootout', 'system/com.sensorkeeper.daemon'], { stdio: 'inherit' }); } catch {}
        execFileSync('sudo', ['rm', '-f', '/Library/LaunchDaemons/com.sensorkeeper.daemon.plist'], { stdio: 'inherit' });
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
  const cmd = argv[0] || (process.stdin.isTTY && !loadConfig() ? 'setup' : 'help');
  const needCfg = () => {
    const c = loadConfig();
    if (!c || !c.sensors.length) { console.error(`Not set up yet. Run: ${APP} setup`); process.exit(1); }
    return c;
  };
  switch (cmd) {
    case 'setup': return setup();
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
