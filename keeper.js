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

const VERSION = '1.4.0';
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
  autoUpdate: false,          // opt-in: keep Sensor Keeper itself up to date from GitHub releases
  deviceAutoUpdate: false,    // opt-in: install Air!Squitter software updates (sensors with a status page address)
  communityFixes: false,      // opt-in: install UNOFFICIAL community fixes for Air!Squitter problems (see COMMUNITY_FIXES)
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
    // Typical spacing between heartbeats, ignoring gaps from outages.
    const gaps = ts.slice(1).map((t, i) => (ts[i] - t) / 1000).filter((g) => g > 0 && g < 600).sort((a, b) => a - b);
    const avgFee = list.reduce((a, t) => a + hbar(t.charged_tx_fee || 0), 0) / list.length;
    if (gaps.length >= 3) burnPerDay = avgFee * (86400 / gaps[Math.floor(gaps.length / 2)]);
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

// ---------------------------------------------------------------- self-update
// Checks GitHub for a newer Sensor Keeper release, verifies the download against
// the release's SHA256SUMS.txt, swaps it in, and restarts. Only an installed copy
// (in ~/.sensor-keeper/bin) updates itself, never a copy run from a source folder.
const REPO = process.env.SENSOR_KEEPER_REPO || 'killgja/sensor-keeper';
const GITHUB_API = process.env.SENSOR_KEEPER_GITHUB_API || 'https://api.github.com';
const UPDATE_EVERY = 6 * 3600 * 1000;

function semverGt(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

function selfTarget() {
  const runningUnderNode = /^node(\.exe)?$/i.test(path.basename(process.execPath));
  const file = path.resolve(runningUnderNode ? __filename : process.execPath);
  const asset = runningUnderNode ? 'keeper.js'
    : ({ 'darwin-arm64': 'sensor-keeper-darwin-arm64', 'darwin-x64': 'sensor-keeper-darwin-x64',
      'linux-x64': 'sensor-keeper-linux-x64', 'linux-arm64': 'sensor-keeper-linux-arm64',
      'win32-x64': 'sensor-keeper-windows-x64.exe' })[`${process.platform}-${process.arch}`];
  const installed = file.startsWith(path.resolve(HOME, 'bin') + path.sep);
  return { file, asset, installed, runningUnderNode };
}

async function download(url, timeoutMs = 120000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': `${APP}/${VERSION}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(t); }
}

// Returns { updated, version, reason }. Never throws.
async function selfUpdate(cfg, { force = false } = {}) {
  const tgt = selfTarget();
  try {
    const r = await http(`${GITHUB_API}/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok || !r.json || !r.json.tag_name) return { updated: false, reason: `GitHub HTTP ${r.status}` };
    const latest = r.json.tag_name.replace(/^v/, '');
    if (!semverGt(latest, VERSION)) return { updated: false, version: latest, reason: 'up to date' };
    if (!tgt.installed && !force) return { updated: false, version: latest, reason: `v${latest} is available, but this copy isn't the installed one (${tgt.file}); run the installer or "${APP} update --force"` };
    if (!tgt.asset) return { updated: false, version: latest, reason: `no download for ${process.platform}-${process.arch}` };
    const assets = r.json.assets || [];
    const a = assets.find((x) => x.name === tgt.asset);
    const sums = assets.find((x) => x.name === 'SHA256SUMS.txt');
    if (!a || !sums) return { updated: false, version: latest, reason: `release v${latest} is missing ${!a ? tgt.asset : 'SHA256SUMS.txt'}` };
    const [bin, sumText] = [await download(a.browser_download_url), (await download(sums.browser_download_url)).toString('utf8')];
    const want = (sumText.split('\n').map((l) => l.trim().split(/\s+\*?/)).find((p) => p[1] === tgt.asset) || [])[0];
    const got = require('crypto').createHash('sha256').update(bin).digest('hex');
    if (!want || want.toLowerCase() !== got) return { updated: false, version: latest, reason: `checksum mismatch for ${tgt.asset} — not installed` };
    if (tgt.runningUnderNode) {
      // quick sanity check: must at least parse
      const tmpCheck = tgt.file + '.check.js';
      fs.writeFileSync(tmpCheck, bin);
      try { execFileSync(process.execPath, ['--check', tmpCheck], { stdio: 'ignore' }); } finally { fs.rmSync(tmpCheck, { force: true }); }
    }
    const tmp = tgt.file + '.new';
    fs.writeFileSync(tmp, bin, { mode: 0o755 });
    if (process.platform === 'darwin') { try { execFileSync('xattr', ['-d', 'com.apple.quarantine', tmp], { stdio: 'ignore' }); } catch {} }
    if (process.platform === 'win32') {
      // Windows can't overwrite a running .exe, but it can rename it.
      const old = tgt.file + '.old';
      fs.rmSync(old, { force: true });
      fs.renameSync(tgt.file, old);
    }
    fs.renameSync(tmp, tgt.file);
    const s = loadState(); s.lastUpdate = { t: now(), from: VERSION, to: latest }; saveState(s);
    log(`self-update: installed Sensor Keeper v${latest} (was v${VERSION})`);
    if (cfg) await sendAlert(cfg, `Sensor Keeper updated to v${latest}`, `Installed automatically (was v${VERSION}).${r.json.html_url ? `\nWhat's new: ${r.json.html_url}` : ''}`, 'low');
    return { updated: true, version: latest };
  } catch (e) {
    return { updated: false, reason: e.message };
  }
}

// Restart into the new version. launchd (KeepAlive) and systemd (Restart=always)
// restart us themselves; otherwise start a fresh copy before exiting.
function restartSelf() {
  let managed = process.env.SENSOR_KEEPER_SERVICE === '1' || /com\.sensorkeeper/.test(process.env.XPC_SERVICE_NAME || '');
  if (!managed && process.platform === 'linux') {
    try { managed = fs.readFileSync('/proc/self/cgroup', 'utf8').includes(`${APP}.service`); } catch {}
  }
  try { if (readJson(LOCK, null) == process.pid) fs.unlinkSync(LOCK); } catch {}
  if (!managed) {
    const tgt = selfTarget();
    const [cmd, args] = tgt.runningUnderNode ? [process.execPath, [tgt.file, 'run']] : [tgt.file, ['run']];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  log('restarting into the new version');
  setTimeout(() => process.exit(0), 500);
}

// ---------------------------------------------------------------- Air!Squitter software updates
// Uses the sensor's own "Software Maintenance → Software Update" page, exactly as
// you would by hand: log in, see which version jetvision offers, press Update.
// It installs (a) what the sensor itself offers, or (b) a hotfix pinned in this
// project's device-updates.json (for releases jetvision doesn't offer automatically).
// jetvision's public version history is checked for information only.
// Logs in with the factory-default admin password unless you saved your own
// (saved only in config.json).
const JV_HISTORY = process.env.SENSOR_KEEPER_JV_HISTORY || 'https://wiki.jetvision.de/wiki/Radarcape:Version_History';
const DEVICE_MANIFEST = process.env.SENSOR_KEEPER_DEVICE_MANIFEST || `https://raw.githubusercontent.com/${REPO}/main/device-updates.json`;
const DEVICE_UPDATE_EVERY = 6 * 3600 * 1000;
const DEVICE_UPDATE_TIMEOUT = 60 * 60 * 1000;
const JV_VER = /\b(\d{6}\.\d{4}\.\d{2})\b/g;
// jetvision's published factory-default admin password. Used unless you save your own.
const JETVISION_DEFAULT_PASSWORD = 'radarcape';
const devicePw = (sensor) => sensor.devicePassword || JETVISION_DEFAULT_PASSWORD;

const jvCmp = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const devBase = (u) => u.replace(/\/+$/, '');

async function deviceVersion(statusUrl) {
  const r = await http(`${devBase(statusUrl)}/param.json?param=versioninfo,productname`, {}, 8000);
  if (!r.ok || !r.json) throw new Error(`HTTP ${r.status}`);
  const m = String(r.json.versioninfo || '').match(/\d{6}\.\d{4}\.\d{2}/);
  return { version: m ? m[0] : null, product: r.json.productname || '' };
}

async function deviceLogin(statusUrl, password) {
  const r = await fetch(`${devBase(statusUrl)}/login_post.html`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `${APP}/${VERSION}` },
    body: new URLSearchParams({ usr: 'Administrator', pwd: password, plf: 'maintenance.html' }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  const sid = cookies.map((c) => (c.match(/(?:^|,\s*)SID=([^;,\s]+)/) || [])[1]).find(Boolean);
  if (!sid) throw Object.assign(new Error('the sensor rejected the admin password'), { badPassword: true });
  return `SID=${sid}`;
}

async function deviceMaintenance(statusUrl, cookie) {
  const r = await http(`${devBase(statusUrl)}/maintenance.html`, { headers: { Cookie: cookie } }, 15000);
  const html = r.text || '';
  if (!/radarcapedform/.test(html)) throw new Error('could not open the Software Maintenance page');
  const cur = (html.match(/Current software version is\s*(\d{6}\.\d{4}\.\d{2})/) || [])[1] || null;
  const input = (html.match(/<input[^>]*id="radarcapedlink"[^>]*>/) || [''])[0];
  const offered = ((input.match(/value="([^"]*)"/) || [])[1] || '').trim();
  return { current: cur, offered: /^\d{6}\.\d{4}\.\d{2}$/.test(offered) ? offered : null };
}

async function latestPublished() {
  const out = { history: null, pinned: null, minimum: null };
  try {
    const r = await http(JV_HISTORY, {}, 20000);
    if (r.ok) {
      // Skip versions the history marks as withdrawn.
      const text = r.text.replace(/<[^>]+>/g, ' ');
      const found = [...text.matchAll(JV_VER)].map((m) => ({ v: m[1], after: text.slice(m.index + m[0].length, m.index + m[0].length + 40) }))
        .filter((x) => !/^\s*\(?\s*withdrawn/i.test(x.after)).map((x) => x.v);
      if (found.length) out.history = found.sort(jvCmp).pop();
    }
  } catch { /* offline: fine */ }
  try {
    const r = await http(DEVICE_MANIFEST, {}, 15000);
    const a = r.ok && r.json && r.json.airsquitter;
    if (a && /^\d{6}\.\d{4}\.\d{2}$/.test(a.version || '')) out.pinned = { version: a.version, note: a.note || '' };
  } catch { /* fine */ }
  return out;
}

// Called from the run loop for each Air!Squitter with a saved admin password.
async function deviceAutoUpdate(cfg, state, sensor, { force = false } = {}) {
  const id = sensor.id;
  const label = sensor.name ? `${sensor.name} (${id})` : id;
  const st = (state.sensors[id] = state.sensors[id] || {});
  const du = (st.deviceUpdate = st.deviceUpdate || {});

  // 1. An update is in progress: wait for the sensor to come back on the new version.
  if (du.pending) {
    let v = null;
    try { v = (await deviceVersion(sensor.statusUrl)).version; } catch { /* rebooting */ }
    if (v && jvCmp(v, du.pending.to) >= 0) {
      log(`${label}: software updated ${du.pending.from} → ${v}`);
      await sendAlert(cfg, `Sensor Keeper: ${label} software updated`, `Air!Squitter software ${du.pending.from} → ${v}. It's back online.`, 'low');
      du.last = { t: now(), version: v, ok: true }; du.current = v; du.lastResult = `updated to ${v}`; delete du.pending;
    } else if (now() - du.pending.t > DEVICE_UPDATE_TIMEOUT) {
      const why = v ? `it is still on ${v} — it probably couldn't download the update (check its internet/DNS)` : "it hasn't come back online";
      log(`${label}: software update to ${du.pending.to} did not finish: ${why}`);
      await sendAlert(cfg, `Sensor Keeper: ${label} software update didn't finish`, `Tried to install ${du.pending.to}, but ${why}. I'll try again in a day.`, 'high');
      du.last = { t: now(), version: v, ok: false, target: du.pending.to }; du.retryAfter = now() + DAY; delete du.pending;
    }
    return;
  }
  if (!force && du.retryAfter && now() < du.retryAfter) return;
  if (!force && du.lastCheck && now() - du.lastCheck < DEVICE_UPDATE_EVERY) return;
  du.lastCheck = now();

  // 2. Find the newest version and compare.
  let cookie, info;
  try {
    cookie = await deviceLogin(sensor.statusUrl, devicePw(sensor));
    info = await deviceMaintenance(sensor.statusUrl, cookie);
    await problem(cfg, st, 'device-login', false, `Sensor Keeper: can't log in to ${label}`, '');
  } catch (e) {
    log(`${label}: software update check failed: ${e.message}`);
    if (e.badPassword) await problem(cfg, st, 'device-login', true, `Sensor Keeper: can't log in to ${label}`,
      `Automatic software updates are paused: ${e.message}${sensor.devicePassword ? ' (your saved password)' : ' (the factory-default password)'}. ` +
      `If you changed the sensor's admin password, enter it in Sensor Keeper's Settings.`);
    return;
  }
  const pub = await latestPublished();
  // Install only what the sensor itself offers, or a hotfix pinned in device-updates.json.
  // jetvision's public version history is only reported, never installed on its own.
  const candidates = [info.offered, pub.pinned && pub.pinned.version].filter(Boolean);
  du.current = info.current;
  du.published = pub.history;
  if (!info.current || !candidates.length) {
    du.lastResult = `on ${info.current || '?'}; the sensor isn't offering an update` +
      (pub.history && info.current && jvCmp(pub.history, info.current) > 0 ? ` (jetvision lists ${pub.history} — the sensor may not be able to reach jetvision)` : '');
    return;
  }
  const target = candidates.sort(jvCmp).pop();
  du.latest = target;
  if (jvCmp(target, info.current) <= 0) { du.lastResult = `up to date (${info.current})`; return; }
  if (du.last && !du.last.ok && du.last.target === target && !force && now() < (du.retryAfter || 0)) return;
  if (cfg.dryRun) { log(`[dry-run] ${label}: would update Air!Squitter software ${info.current} → ${target}`); return; }

  // 3. Install: same as pressing "Update Software" on the Software Maintenance page.
  const r = await http(`${devBase(sensor.statusUrl)}/maintenance_radarcape_post.html`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ link: target }).toString(),
  }, 60000).catch((e) => ({ ok: false, status: e.message }));
  if (!r.ok) {
    log(`${label}: software update request failed (${r.status})`);
    du.retryAfter = now() + DAY;
    await sendAlert(cfg, `Sensor Keeper: ${label} software update failed`, `The sensor refused the update to ${target} (${r.status}). I'll try again in a day.`, 'high');
    return;
  }
  du.pending = { t: now(), from: info.current, to: target };
  const why = pub.pinned && pub.pinned.version === target && pub.pinned.note ? `\n${pub.pinned.note}` : '';
  log(`${label}: installing Air!Squitter software ${info.current} → ${target}`);
  await sendAlert(cfg, `Sensor Keeper: updating ${label}`, `Installing Air!Squitter software ${target} (was ${info.current}). The sensor restarts and is offline for a few minutes.${why}`, 'default');
}

async function deviceUpdatesAll(cfg, opts = {}) {
  if (cfg.deviceAutoUpdate !== true && !opts.force) return;
  const targets = cfg.sensors.filter((s) => s.statusUrl);
  if (!targets.length) return;
  const state = loadState();
  for (const s of targets) {
    try { await deviceAutoUpdate(cfg, state, s, opts); }
    catch (e) { log(`${s.id}: software update error: ${e.message}`); }
  }
  saveState(state);
}

// ---------------------------------------------------------------- sensor diagnosis
// Works out, in plain language, why an Air!Squitter isn't sending heartbeats.
// Read-only: it never changes anything on the sensor. Used by "diagnose", by
// alerts (so they say what's wrong and what to do), and by the community fixes.
const NEURON_PORT = 1337;
async function tryHttp(url, opts = {}, ms = 8000) {
  try { return await http(url, opts, ms); } catch (e) { return { ok: false, status: 0, json: null, text: '', error: e.message }; }
}
const neuronBase = (statusUrl) => devBase(statusUrl).replace(/:\d+$/, '') + `:${NEURON_PORT}`;
const ipNum = (ip) => String(ip).split('.').reduce((a, o) => (a * 256) + (parseInt(o, 10) || 0), 0) >>> 0;
const sameSubnet = (a, b, mask) => ((ipNum(a) & ipNum(mask)) >>> 0) === ((ipNum(b) & ipNum(mask)) >>> 0);

// Static network settings as shown on the sensor's Network page (needs login).
async function deviceNetwork(statusUrl, cookie) {
  const r = await http(`${devBase(statusUrl)}/network.html`, { headers: { Cookie: cookie } }, 15000);
  const forms = (r.text || '').split(/<form\b/i).slice(1).map((f) => f.split(/<\/form>/i)[0]);
  const out = [];
  for (const f of forms) {
    const val = (name) => ((f.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`, 'i')) || [''])[0].match(/value="([^"]*)"/) || [])[1] || '';
    const dhcpChecked = (f.match(/<input[^>]*name="dhcp"[^>]*>/gi) || []).find((x) => /checked/i.test(x));
    const dhcp = dhcpChecked ? (dhcpChecked.match(/value="([^"]*)"/) || [])[1] : null;
    const ip = val('ipaddress');
    if (dhcp === null && !ip) continue;
    out.push({ wifi: /wifimode|ssid/i.test(f), dhcp: dhcp === '1', ip, netmask: val('ipnetmask'), gateway: val('ipgateway'), dns: val('ipdns') });
  }
  return out;
}

// Does a validating public resolver (Cloudflare) accept stun.voipgate.com again?
async function voipgateDnssecHealthy() {
  const r = await tryHttp((process.env.SENSOR_KEEPER_DOH || 'https://cloudflare-dns.com/dns-query') + '?name=stun.voipgate.com&type=A', { headers: { Accept: 'application/dns-json' } }, 10000);
  return !!(r.json && r.json.Status === 0 && Array.isArray(r.json.Answer) && r.json.Answer.length);
}

async function diagnoseSensor(cfg, sensor, { heartbeatAgeMin = null } = {}) {
  const f = [];   // { key, level: ok|warn|bad, text, fix }
  const add = (key, level, text, fix = '') => f.push({ key, level, text, fix });
  const st = await tryHttp(`${devBase(sensor.statusUrl)}/status.json`);
  if (!st.json) {
    add('lan', 'bad', `The sensor doesn't answer on your network (${sensor.statusUrl}).`,
      'Check that it has power (lights on), and its network cable or Wi-Fi. If it was just restarted, give it 5 minutes.');
    return f;
  }
  add('lan', 'ok', 'The sensor answers on your network.');
  const mlat = st.json.mlat || {};
  const ml = await tryHttp(`${devBase(sensor.statusUrl)}/mlatstatus.json`);
  const connlog = (ml.json && ml.json.mlat && ml.json.mlat.connlog) || '';
  const dnsBroken = /resolve: Host not found/i.test(connlog);
  if (mlat.status === 'green') add('internet', 'ok', 'It reaches the internet and can look up names (MLAT connected).');
  else if (dnsBroken) add('dns', 'bad', "It can't look up internet names (DNS), so MLAT and 4DSKY heartbeats stop.",
    'Turn on "Install unofficial community fixes" in Sensor Keeper (DNS fix), or install jv-ksk2024-fix from the Sensor Keeper GitHub through the sensor\'s Software Maintenance → Upload and Install page.');
  else add('internet', 'bad', `MLAT isn't connected (${mlat.desc || mlat.status || 'unknown'}). The sensor probably can't reach the internet.`,
    "Check the sensor's network settings (gateway and DNS) and your router.");

  // Network settings sanity (needs the admin password; skipped if login fails).
  try {
    const cookie = await deviceLogin(sensor.statusUrl, devicePw(sensor));
    for (const n of await deviceNetwork(sensor.statusUrl, cookie)) {
      if (n.dhcp || !n.ip || !n.gateway) continue;
      const kind = n.wifi ? 'Wi-Fi' : 'wired';
      if (n.netmask && !sameSubnet(n.ip, n.gateway, n.netmask)) {
        add('gateway', 'bad', `Its ${kind} default gateway is ${n.gateway}, which isn't on its own network (${n.ip}/${n.netmask}). It can talk to your house but not the internet.`,
          `On the sensor's Settings → Network page, set the ${kind} Default Gateway to your router's address (usually the network's .1 address, e.g. ${n.ip.split('.').slice(0, 3).join('.')}.1), or switch to Automatic (DHCP). Save and reboot.`);
      } else add('gateway', 'ok', `${kind} settings look sane (gateway ${n.gateway}).`);
    }
  } catch (e) { add('settings', 'warn', `Couldn't read its network settings (${e.message}).`); }

  // The 4DSKY (Neuron) program that sends heartbeats. Its page on port 1337 is only open
  // while it waits for setup; once running it closes, so heartbeats are the real signal.
  const nr = await tryHttp(`${neuronBase(sensor.statusUrl)}/`, {}, 6000);
  const stale = heartbeatAgeMin == null || heartbeatAgeMin > (cfg.heartbeatAlertMinutes || 15);
  if (nr.ok && /start with entering your device address|Setup Jetvision for Neuron/i.test(nr.text)) add('neuron-setup', 'warn', 'The 4DSKY program is running but waiting for setup.',
    `Open ${neuronBase(sensor.statusUrl)} and complete the setup wizard (device account ID and the device's private key).`);
  else if (!stale) add('neuron', 'ok', 'The 4DSKY program is sending heartbeats.');
  else if (mlat.status === 'green') add('neuron', 'bad', "The sensor's internet works, but the 4DSKY program isn't sending heartbeats — it has probably crashed or is missing.",
    'Turn on "Install unofficial community fixes" in Sensor Keeper (it checks the program, restarts it, or reinstalls the official package), or reboot the sensor. Do NOT use the :1336/reinstall-package link — it uninstalls first and can fail halfway.');

  if (heartbeatAgeMin != null) {
    if (heartbeatAgeMin <= (cfg.heartbeatAlertMinutes || 15)) add('heartbeat', 'ok', `Heartbeats are arriving (last ${Math.round(heartbeatAgeMin)} min ago).`);
    else add('heartbeat', 'bad', `No heartbeat for ${heartbeatAgeMin > 2880 ? Math.round(heartbeatAgeMin / 1440) + ' days' : Math.round(heartbeatAgeMin) + ' min'}.`);
  }
  return f;
}
// After each check: for sensors in trouble, find out why and alert once per cause, with what to do.
const DIAG_KEYS = { dns: 'DNS is broken', internet: "can't reach the internet", gateway: 'wrong gateway setting', neuron: '4DSKY program not running', 'neuron-setup': '4DSKY program needs setup' };
async function diagnoseAll(cfg, results) {
  const state = loadState();
  for (const r of results) {
    const sensor = cfg.sensors.find((x) => x.id === r.id);
    if (!sensor || !sensor.statusUrl || r.error || r.missing) continue;
    const st = (state.sensors[r.id] = state.sensors[r.id] || {});
    const trouble = r.heartbeatAgeMin == null || r.heartbeatAgeMin > cfg.heartbeatAlertMinutes || (r.deviceIssues && r.deviceIssues.length);
    let found = [];
    if (trouble) {
      found = await diagnoseSensor(cfg, sensor, { heartbeatAgeMin: r.heartbeatAgeMin }).catch((e) => { log(`${r.label}: diagnosis failed: ${e.message}`); return null; });
      if (!found) continue;
      st.diagnosis = { t: now(), findings: found };
      const bad = found.filter((x) => x.level !== 'ok' && DIAG_KEYS[x.key]);
      if (bad.length) log(`${r.label}: diagnosis: ${bad.map((x) => x.text).join(' | ')}`);
    } else delete st.diagnosis;
    for (const [key, short] of Object.entries(DIAG_KEYS)) {
      const hit = found.find((x) => x.key === key && x.level !== 'ok');
      await problem(cfg, st, `diag-${key}`, !!hit, `Sensor Keeper: ${r.label}: ${short}`, hit ? `${hit.text}${hit.fix ? `\nWhat to do: ${hit.fix}` : ''}` : '');
    }
  }
  saveState(state);
}

const diagText = (f) => f.filter((x) => x.level !== 'ok').map((x) => `• ${x.text}${x.fix ? `\n  → ${x.fix}` : ''}`).join('\n');

// Build a tiny Debian package in memory (control + scripts only, no files).
// Used for the read-only/restart probe, whose version changes every time so
// the sensor's installer always runs it.
function tarFile(name, body, mode) {
  const h = Buffer.alloc(512);
  const w = (s, off, len) => h.write(String(s), off, len, 'ascii');
  w(name, 0, 100); w(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
  w('0000000\0', 108, 8); w('0000000\0', 116, 8);
  w(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  w(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  w('        ', 148, 8); w('0', 156, 1); w('ustar\0', 257, 6); w('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  w(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
function tarGz(files) {
  const zlib = require('zlib');
  return zlib.gzipSync(Buffer.concat([...files.map((f) => tarFile(f.name, Buffer.from(f.body), f.mode || 0o644)), Buffer.alloc(1024)]));
}
function arArchive(members) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const m of members) {
    const hdr = `${(m.name + '/').padEnd(16)}${String(Math.floor(Date.now() / 1000)).padEnd(12)}0     0     100644  ${String(m.body.length).padEnd(10)}\`\n`;
    parts.push(Buffer.from(hdr), m.body);
    if (m.body.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}
function buildDeb({ name, version, description, postinst }) {
  const control = `Package: ${name}\nVersion: ${version}\nArchitecture: all\nMaintainer: Sensor Keeper community <killgja@users.noreply.github.com>\nPriority: optional\nSection: admin\nDescription: ${description}\n`;
  return arArchive([
    { name: 'debian-binary', body: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', body: tarGz([{ name: './control', body: control }, { name: './postinst', body: postinst, mode: 0o755 }]) },
    { name: 'data.tar.gz', body: tarGz([]) },
  ]);
}

// Probe for the 4DSKY (Neuron) program: reports whether it is installed and running,
// and restarts it if it has stopped (systemd gives up after repeated crashes). Reads
// nothing from /etc/neuron-sdk. Output lines start with "SK_".
const NEURON_PROBE = `#!/bin/sh
v=$(dpkg-query -W -f='\${Version}' neuron-sdk-package 2>/dev/null); s=$(dpkg-query -W -f='\${Status}' neuron-sdk-package 2>/dev/null)
case "$s" in *" installed") echo "SK_NEURON_PKG=$v";; *) echo "SK_NEURON_PKG=missing";; esac
echo "SK_NEURON_SVC=$(systemctl is-active neuron-sdk 2>/dev/null || true)"
if [ "$(systemctl is-active neuron-sdk 2>/dev/null)" != active ] && systemctl list-unit-files 2>/dev/null | grep -q '^neuron-sdk.service'; then
  systemctl reset-failed neuron-sdk 2>/dev/null; systemctl restart neuron-sdk 2>/dev/null; sleep 8
  echo "SK_NEURON_RESTARTED=yes"; echo "SK_NEURON_SVC_AFTER=$(systemctl is-active neuron-sdk 2>/dev/null || true)"
fi
exit 0
`;

// ---------------------------------------------------------------- unofficial community fixes (opt-in)
// Small fixes written by the Sensor Keeper community — NOT from jetvision or 4DSKY.
// Off unless you tick "Install unofficial community fixes". Each fix is bundled
// here (so it works even when the sensor itself can't reach the internet), is
// checked against its SHA-256 before use, is only installed on a sensor that shows
// the exact problem it fixes, and is installed once. A fix can be retired remotely
// (device-updates.json "retiredFixes") once an official fix ships.
const COMMUNITY_FIXES = [
  {
    id: 'jv-ksk2024-fix',
    title: 'DNS fix for the October 2026 internet root-key change',
    summary: 'Adds the new DNS root key (KSK-2024) so the sensor can look up names again (MLAT, 4DSKY heartbeats).',
    description:
      'On 11 Oct 2026 the internet\'s DNS root key changed from KSK-2017 to KSK-2024. Air!Squitter software only ' +
      'trusts the old key, so every name lookup fails ("Host not found"): MLAT stops and 4DSKY heartbeats stop. ' +
      'This fix installs a tiny package (jv-ksk2024-fix) through the sensor\'s own "Upload and Install" page. It adds ' +
      'the new key next to the old one in the sensor\'s DNS software (keys checked against IANA\'s official list), ' +
      'restarts that DNS software, and writes a report to /var/log/jv-ksk2024-fix.log. It also tells the sensor not to ' +
      'security-check one domain, voipgate.com, whose owner\'s DNS security setup is broken: the 4DSKY software looks up ' +
      'stun.voipgate.com at startup and crashes if it can\'t. DNS security stays on for everything else. Finally it ' +
      'restarts the 4DSKY program, which stops retrying after crashing many times. Removing the package restores the original files.',
    file: 'jv-ksk2024-fix_1.1.1_all.deb',
    sha256: '1b1c22efba2c7e1e69ff6deda1e0a96b0bf64e47c3e93498d677b9e0b5c204e6',
    data: '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',
    // The sensor shows the problem: its MLAT client can't resolve names.
    async detect(sensor) {
      const r = await tryHttp(`${devBase(sensor.statusUrl)}/mlatstatus.json`, {}, 8000);
      const log = (r.json && r.json.mlat && r.json.mlat.connlog) || '';
      return /resolve: Host not found/i.test(log);
    },
    // Fixed when MLAT connects again.
    async verify(sensor) {
      const r = await http(`${devBase(sensor.statusUrl)}/status.json`, {}, 8000);
      return !!(r.json && r.json.mlat && r.json.mlat.status === 'green');
    },
  },
  {
    id: 'neuron-sdk-repair',
    title: 'Restart or reinstall the 4DSKY program when heartbeats stop',
    summary: "Checks the 4DSKY program on the sensor; restarts it if it has stopped, or reinstalls 4DSKY's official package if it's missing.",
    description:
      'The 4DSKY program (Neuron SDK) is what sends heartbeats. If heartbeats have stopped for 30 minutes while the sensor\'s ' +
      'internet and DNS work, Sensor Keeper installs a tiny read-only probe through the sensor\'s "Upload and Install" page. ' +
      'It reports whether the program is installed and running, and restarts it if it has stopped (systemd gives up after ' +
      "repeated crashes). Only if the program is missing does Sensor Keeper download 4DSKY's official package from Neuron's " +
      'public GitHub (NeuronInnovations/neuron-packages), check it against the checksum pinned in device-updates.json, and ' +
      "install it. Existing 4DSKY settings are kept; if it asks for setup you'll be told to finish its wizard (it needs the " +
      "device's private key, which Sensor Keeper never stores). Tried at most twice, a day apart.",
    retryable: true,
    async detect(sensor, ctx) {
      const hb = ctx.st.problems && ctx.st.problems.heartbeat;
      if (!hb || now() - hb.since < 30 * 60000) return false;
      const st = await tryHttp(`${devBase(sensor.statusUrl)}/status.json`);
      if (!(st.json && st.json.mlat && st.json.mlat.status === 'green')) return false;   // fix internet/DNS first
      const nr = await tryHttp(`${neuronBase(sensor.statusUrl)}/`, {}, 6000);
      return !(nr.ok && /start with entering your device address|Setup Jetvision for Neuron/i.test(nr.text));   // waiting for setup: the owner must finish it
    },
    async run(cfg, sensor, label, fx) {
      const probe = buildDeb({ name: 'sk-neuron-probe', version: `1.0.${Math.floor(Date.now() / 1000)}`,
        description: 'Sensor Keeper probe: is the 4DSKY program installed and running', postinst: NEURON_PROBE });
      const out = await installDeb(sensor, probe, 'sk-neuron-probe_all.deb', 'sk-neuron-probe');
      const val = (k) => ((out.match(new RegExp(`SK_${k}=([^\\s<]*)`)) || [])[1] || '');
      const pkg = val('NEURON_PKG');
      fx.probe = { t: now(), pkg, svc: val('NEURON_SVC'), restarted: val('NEURON_RESTARTED') === 'yes', after: val('NEURON_SVC_AFTER') };
      log(`${label}: 4DSKY probe: package ${pkg || '?'}, service ${fx.probe.svc || '?'}${fx.probe.restarted ? `, restarted -> ${fx.probe.after || '?'}` : ''}`);
      if (pkg !== 'missing') return fx.probe.restarted ? 'restarted the 4DSKY program' : 'the 4DSKY program is installed and running';
      const r = await http(DEVICE_MANIFEST, {}, 15000);
      const n = r.ok && r.json && r.json.neuronSdk;
      if (!n || !n.url || !/^[0-9a-f]{64}$/.test(n.sha256 || '')) throw new Error('the 4DSKY program is missing, but no official package is pinned in device-updates.json');
      const buf = await download(n.url, 300000);
      if (require('crypto').createHash('sha256').update(buf).digest('hex') !== n.sha256) throw new Error("the downloaded 4DSKY package doesn't match the pinned checksum — not installed");
      await installDeb(sensor, buf, `neuron-sdk-package_${n.version || 'latest'}_armhf.deb`, 'neuron-sdk-package');
      return `reinstalled the official 4DSKY package ${n.version || ''}`.trim();
    },
    // Worked if heartbeats are back, or the program is up and waiting for setup.
    async verify(sensor) {
      const hb = await getHeartbeats(sensor.id).catch(() => ({}));
      if (hb.lastAgeMin != null && hb.lastAgeMin < 15) return true;
      const nr = await tryHttp(`${neuronBase(sensor.statusUrl)}/`, {}, 8000);
      return !!(nr.ok && /start with entering your device address|Setup Jetvision for Neuron/i.test(nr.text));
    },
    async after(cfg, sensor, label) {
      const nr = await tryHttp(`${neuronBase(sensor.statusUrl)}/`, {}, 8000);
      if (/start with entering your device address|Setup Jetvision for Neuron/i.test(nr.text || '')) {
        await sendAlert(cfg, `Sensor Keeper: ${label} needs its 4DSKY setup`, `The 4DSKY program is back but is asking to be set up. Open ${neuronBase(sensor.statusUrl)} and complete the wizard with the device account ID and the device's private key (Sensor Keeper never stores private keys).`, 'high');
      }
    },
  },
  {
    id: 'jv-voipgate-cleanup',
    title: 'Remove the voipgate.com DNS exception once it is no longer needed',
    summary: "voipgate.com's DNS security works again, so the exception added by the DNS fix is removed.",
    description:
      'The DNS fix tells the sensor not to security-check voipgate.com, because that domain\'s DNS security was broken. ' +
      'Sensor Keeper checks every few hours with Cloudflare\'s validating DNS; once voipgate.com passes again, this ' +
      'installs jv-ksk2024-fix 1.2.0, which removes the exception (keeping the new root key) so every lookup is checked again. ' +
      'Only runs on sensors where Sensor Keeper installed the DNS fix.',
    file: 'jv-ksk2024-fix_1.2.0_all.deb',
    sha256: '186750ed51b0413de37c04a6ee598beea056e4fbab3fc8e713e51e382bcfea77',
    data: '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',
    async detect(sensor, ctx) {
      const dns = ctx.st.fixes && ctx.st.fixes['jv-ksk2024-fix'];
      if (!dns || !dns.applied) return false;
      if (ctx.fx.lastHealthCheck && now() - ctx.fx.lastHealthCheck < 6 * 3600 * 1000) return false;
      ctx.fx.lastHealthCheck = now();
      return voipgateDnssecHealthy();
    },
    async verify(sensor) {
      const r = await tryHttp(`${devBase(sensor.statusUrl)}/status.json`, {}, 8000);
      return !!(r.json && r.json.mlat && r.json.mlat.status === 'green');
    },
  },
];
const FIX_VERIFY_AFTER = 5 * 60 * 1000;

async function retiredFixes() {
  try {
    const r = await http(DEVICE_MANIFEST, {}, 15000);
    return (r.ok && r.json && Array.isArray(r.json.retiredFixes)) ? r.json.retiredFixes : [];
  } catch { return []; }
}

async function fixPackage(fix) {
  if (fix.getPackage) return fix.getPackage();
  const buf = Buffer.from(fix.data, 'base64');
  const got = require('crypto').createHash('sha256').update(buf).digest('hex');
  if (got !== fix.sha256) throw new Error('bundled package failed its checksum — not installed');
  return { buf, file: fix.file, pkg: fix.file.split('_')[0] };
}

async function installFixPackage(sensor, fix) {
  const { buf, file, pkg } = await fixPackage(fix);
  return installDeb(sensor, buf, file, pkg);
}

// Upload + install a .deb through the sensor's Software Maintenance page; returns its output.
async function installDeb(sensor, buf, file, pkg) {
  const cookie = await deviceLogin(sensor.statusUrl, devicePw(sensor));
  const form = new FormData();
  form.append('uploadinstallconf', new Blob([buf], { type: 'application/vnd.debian.binary-package' }), file);
  const res = await fetch(`${devBase(sensor.statusUrl)}/maintenance_file_install_post.html`, {
    method: 'POST', body: form, headers: { Cookie: cookie, 'User-Agent': `${APP}/${VERSION}` }, signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`sensor answered HTTP ${res.status}`);
  if (!new RegExp(`Setting up ${pkg}`).test(text)) {
    const tail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(-300);
    throw new Error(`the sensor didn't confirm the install (${tail})`);
  }
  return text;
}

// One fix on one sensor. Called from the run loop and by "apply-fix".
async function applyFix(cfg, state, sensor, fix, { force = false } = {}) {
  const label = sensor.name ? `${sensor.name} (${sensor.id})` : sensor.id;
  const st = (state.sensors[sensor.id] = state.sensors[sensor.id] || {});
  const fx = ((st.fixes = st.fixes || {})[fix.id] = st.fixes[fix.id] || {});
  if (fx.pending) {
    if (now() - fx.pending < FIX_VERIFY_AFTER) return 'waiting to verify';
    const ok = await fix.verify(sensor).catch(() => false);
    delete fx.pending;
    if (ok) {
      fx.applied = now(); fx.result = 'installed and working'; delete fx.failed;
      log(`${label}: community fix ${fix.id} installed and working`);
      await sendAlert(cfg, `Sensor Keeper: ${label} fixed`, `The unofficial "${fix.title}" fix was installed and worked.`, 'default');
      if (fix.after) await fix.after(cfg, sensor, label).catch(() => {});
    } else {
      fx.failed = now(); fx.result = 'installed, but the problem is still there';
      log(`${label}: community fix ${fix.id} installed but the problem remains`);
      await sendAlert(cfg, `Sensor Keeper: ${label} fix didn't help`, `The unofficial "${fix.title}" fix was installed, but the sensor still shows the problem. It won't be tried again automatically.`, 'high');
    }
    return fx.result;
  }
  const canRetry = fix.retryable && fx.failed && !fx.applied && (fx.tries || 0) < 2 && now() - fx.failed > DAY;
  if (!force && (fx.applied || (fx.failed && !canRetry))) return fx.result || 'already handled';
  if (!(await fix.detect(sensor, { st, fx }).catch(() => false))) { fx.result = "not needed (the sensor doesn't show this problem)"; return fx.result; }
  if (cfg.dryRun) { log(`[dry-run] ${label}: would install community fix ${fix.id}`); return 'dry-run'; }
  log(`${label}: installing unofficial community fix ${fix.id}`);
  await sendAlert(cfg, `Sensor Keeper: installing a fix on ${label}`, `Unofficial community fix (not from jetvision or 4DSKY): ${fix.title}.\n${fix.summary}`, 'default');
  try {
    fx.tries = (fx.tries || 0) + 1;
    const did = fix.run ? await fix.run(cfg, sensor, label, fx) : (await installFixPackage(sensor, fix), 'installed');
    fx.pending = now(); fx.result = `${did} — checking it worked in a few minutes`;
  } catch (e) {
    fx.failed = now(); fx.result = `install failed: ${e.message}`;
    log(`${label}: community fix ${fix.id} failed: ${e.message}`);
    await sendAlert(cfg, `Sensor Keeper: fix failed on ${label}`, `Couldn't install "${fix.title}": ${e.message}.${fix.retryable && (fx.tries || 0) < 2 ? ' I\'ll try once more in a day.' : " It won't be tried again automatically."}`, 'high');
  }
  return fx.result;
}

async function communityFixesAll(cfg, opts = {}) {
  if (cfg.communityFixes !== true && !opts.force) return [];
  const sensors = cfg.sensors.filter((s) => s.statusUrl);
  if (!sensors.length) return [];
  const retired = await retiredFixes();
  const state = loadState();
  const out = [];
  for (const s of sensors) {
    for (const fix of COMMUNITY_FIXES) {
      if (retired.includes(fix.id) || (opts.only && opts.only !== fix.id)) continue;
      try { out.push({ sensor: s, fix, result: await applyFix(cfg, state, s, fix, opts) }); }
      catch (e) { log(`${s.id}: community fix ${fix.id} error: ${e.message}`); }
    }
  }
  saveState(state);
  return out;
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
  let lastUpdateTry = 0;
  const selfFile = selfTarget().file;
  const mtime = () => { try { return fs.statSync(selfFile).mtimeMs; } catch { return 0; } };
  const startMtime = mtime();
  // Wake every minute and decide by wall-clock time, so a sleeping or throttled
  // computer simply catches up when it wakes.
  for (;;) {
    cfg = loadConfig() || cfg;   // pick up edits without a restart
    // A newer copy was installed (by "update", the installer, or the app): restart into it.
    if (startMtime && mtime() && mtime() !== startMtime) { log('a new Sensor Keeper version was installed'); restartSelf(); return; }
    if (cfg.autoUpdate === true && now() - lastUpdateTry >= UPDATE_EVERY && now() - (loadState().lastUpdateCheck || 0) >= UPDATE_EVERY) {
      lastUpdateTry = now();
      const u = await selfUpdate(cfg);
      const s = loadState(); s.lastUpdateCheck = now(); saveState(s);
      if (u.updated) { restartSelf(); return; }
      if (u.reason && u.reason !== 'up to date') log(`self-update: ${u.reason}`);
    }
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
        await deviceUpdatesAll(cfg);
        await communityFixesAll(cfg);
        await diagnoseAll(cfg, results).catch((e) => log(`diagnosis failed: ${e.message}`));
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
    let devicePassword = '';
    if (statusUrl) {
      console.log('  Sensor Keeper also installs Air!Squitter software updates for you (it does what');
      console.log('  you would do on the sensor\'s Software Maintenance page), logging in with the');
      console.log('  sensor\'s admin password. Most sensors still use the factory default; if you changed');
      console.log('  yours, enter it here. It\'s saved only on this computer.');
      for (;;) {
        const keep = prev && prev.devicePassword;
        const typed = await askSecret(rl, keep ? '  Air!Squitter admin password' : '  Air!Squitter admin password [press Enter for the factory default]', !!keep);
        devicePassword = typed || (keep ? prev.devicePassword : '');
        process.stdout.write('  Checking… ');
        try { await deviceLogin(statusUrl, devicePassword || JETVISION_DEFAULT_PASSWORD); console.log('password works.'); break; }
        catch (e) {
          if (e.badPassword) { console.log(`the sensor rejected ${devicePassword ? 'that password' : 'the factory default'}. Enter the password you use for its web page.`); continue; }
          console.log(`couldn't reach the sensor (${e.message}); saving anyway.`); break;
        }
      }
    }
    sensors.push({ id, ...(name ? { name } : {}), ...(statusUrl ? { statusUrl } : {}), ...(devicePassword ? { devicePassword } : {}) });
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
  console.log('\nAutomatic updates (both off unless you turn them on; you can change this any time in Settings)');
  cfg.autoUpdate = await askYesNo(rl, '  Keep Sensor Keeper itself up to date automatically?', old.autoUpdate === true);
  cfg.deviceAutoUpdate = cfg.sensors.some((x) => x.statusUrl)
    ? await askYesNo(rl, '  Install Air!Squitter software updates automatically?', old.deviceAutoUpdate === true)
    : old.deviceAutoUpdate === true;
  if (cfg.sensors.some((x) => x.statusUrl)) {
    console.log('\nUnofficial community fixes (off unless you turn them on)');
    console.log('  These are small fixes written by the Sensor Keeper community, NOT by jetvision or 4DSKY.');
    console.log('  Each is installed only on a sensor that shows the exact problem it fixes, and only once.');
    console.log('  Available now:');
    for (const f of COMMUNITY_FIXES) console.log(`   - ${f.title}\n     ${f.description.replace(/(.{1,90})(\s|$)/g, '$1\n     ').trimEnd()}`);
    cfg.communityFixes = await askYesNo(rl, '  Install unofficial community fixes automatically when needed?', old.communityFixes === true);
  }

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
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${esc(os.homedir())}</string><key>SENSOR_KEEPER_SERVICE</key><string>1</string></dict>
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
  <key>EnvironmentVariables</key><dict><key>SENSOR_KEEPER_SERVICE</key><string>1</string></dict>
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
Environment=SENSOR_KEEPER_SERVICE=1
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
  c.sensors = (c.sensors || []).map(({ devicePassword, ...s }) => ({ ...s, devicePasswordSet: !!devicePassword }));
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
          const { devicePassword, ...pub } = s;
          const du = x.deviceUpdate || {};
          return { ...pub, devicePasswordSet: !!devicePassword, software: du.current || null, softwareLatest: du.latest || null,
            softwareUpdating: du.pending ? du.pending.to : null, balance: x.lastBalance ?? null, burnPerDay: x.burnPerDay ?? null, lastCheck: x.lastCheck || null,
            lastTopup: x.lastTopup || null, problems: Object.keys(x.problems || {}) };
        });
        return send(res, 200, {
          version: VERSION, platform: process.platform, configured: !!(cfg && cfg.sensors.length),
          config: publicConfig(cfg), sensors, service: serviceInfo(), autoLogout: autoLogoutOn(),
          lastRun: st.lastRun || null, faucetUsed: faucetUsed24h(st), faucetLimit: FAUCET_DAILY_LIMIT,
          topups: topupSummary(), home: HOME,
          fixes: COMMUNITY_FIXES.map((f) => ({ id: f.id, title: f.title, description: f.description })),
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
          const prevS = ((cfg && cfg.sensors) || []).find((x) => x.id === id) || {};
          const pw = s.clearPassword ? '' : (String(s.devicePassword || '') || prevS.devicePassword || '');
          sensors.push({ id, ...(s.name ? { name: String(s.name).trim().slice(0, 60) } : {}), ...(statusUrl ? { statusUrl } : {}), ...(statusUrl && pw ? { devicePassword: pw } : {}) });
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
        if (typeof b.autoUpdate === 'boolean') next.autoUpdate = b.autoUpdate;
        if (typeof b.deviceAutoUpdate === 'boolean') next.deviceAutoUpdate = b.deviceAutoUpdate;
        if (typeof b.communityFixes === 'boolean') next.communityFixes = b.communityFixes;
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
.row{display:grid;grid-template-columns:1.1fr 1fr 1.2fr 1fr auto;gap:10px;align-items:end}
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
    <label style="display:flex;gap:8px;align-items:center;color:var(--ink);margin-top:14px"><input type="checkbox" id="weekly"> Send a weekly "all good" summary</label>
    <label style="display:flex;gap:8px;align-items:center;color:var(--ink);margin-top:10px"><input type="checkbox" id="autoupd"> Keep Sensor Keeper up to date automatically</label>
    <label style="display:flex;gap:8px;align-items:center;color:var(--ink);margin-top:10px"><input type="checkbox" id="devupd"> Install Air!Squitter software updates automatically</label>
    <label style="display:flex;gap:8px;align-items:center;color:var(--ink);margin-top:10px"><input type="checkbox" id="cfix"> Install <b>unofficial</b> community fixes when a sensor needs one</label>
    <p class="help" style="margin-top:4px">Written by the Sensor Keeper community, not by jetvision or 4DSKY. Each fix is installed only on a sensor that shows the exact problem it fixes, and only once. You're told before and after.</p>
    <div id="fixList" class="help"></div></div>

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
  d.innerHTML='<div class="row"><div><label>Account ID</label><input type="text" class="sid" placeholder="0.0.1234567" value="'+esc(s.id)+'"></div><div><label>Nickname (optional)</label><input type="text" class="sname" value="'+esc(s.name)+'"></div><div><label>Jetvision status page on your network (optional)</label><input type="text" class="surl" placeholder="http://192.168.1.50" value="'+esc(s.statusUrl)+'"></div><div><label>Air!Squitter admin password</label><input type="password" class="spw" autocomplete="new-password" placeholder="'+(s.devicePasswordSet?'your saved password — type to change':'factory default — type to change')+'">'+(s.devicePasswordSet?'<label class="note" style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" class="spwreset"> use factory default</label>':'')+'</div><div class="actions"><button class="btn small chk">Check</button><button class="btn small rm" title="Remove">Remove</button></div></div><div class="note res"></div>';
  d.querySelector('.rm').onclick=function(){d.remove();markDirty();};
  d.querySelector('.chk').onclick=function(){var r=d.querySelector('.res');r.className='note';r.textContent='Checking Hedera…';api('check-sensor',{id:d.querySelector('.sid').value.trim(),statusUrl:d.querySelector('.surl').value.trim()}).then(function(j){if(!j.ok){r.className='note bad';r.textContent=j.message;return;}
    r.className='note '+(j.warning?'warn':'ok');r.textContent='Found — '+j.balance.toFixed(2)+' HBAR'+(j.heartbeatAgeMin!=null?', last heartbeat '+j.heartbeatAgeMin.toFixed(1)+' min ago':'')+(j.device?'; status page: '+j.device:'')+(j.warning?'. '+j.warning:'.');}).catch(function(e){r.className='note bad';r.textContent=e.message;});};
  d.querySelectorAll('input').forEach(function(i){i.oninput=markDirty;});return d;}
function renderSettings(){var c=S.config;var L=$('sensorList');L.innerHTML='';(S.sensors.length?S.sensors:[{id:'',name:'',statusUrl:''}]).forEach(function(s){L.appendChild(sensorRow(s));});
  $('token').value='';$('token').placeholder=c.tokenSet?'Saved ('+c.tokenHint+') — paste a new one only to replace it':'Paste your Personal Access Token';
  $('tokenNote').className='note '+(c.tokenSet?'ok':'warn');$('tokenNote').textContent=c.tokenSet?'A token is saved.':'No token saved yet — top-ups can\'t run without it.';
  $('lowWater').value=c.lowWater;$('topupAmount').value=c.topupAmount;$('checkEvery').value=c.checkEveryMinutes;
  $('discord').value=c.alerts.discordWebhook||'';$('ntfy').value=c.alerts.ntfyTopic||'';$('weekly').checked=c.weeklySummary!==false;$('autoupd').checked=c.autoUpdate===true;$('devupd').checked=c.deviceAutoUpdate===true;$('cfix').checked=c.communityFixes===true;$('fixList').innerHTML=(S.fixes||[]).map(function(f){return '<details style="margin:6px 0"><summary><b>'+esc(f.title)+'</b></summary><div style="margin-top:4px">'+esc(f.description)+'</div></details>';}).join('');dirty=false;$('saveNote').textContent='';}
function markDirty(){dirty=true;$('saveNote').textContent='Unsaved changes';}
['token','lowWater','topupAmount','checkEvery','discord','ntfy','weekly','autoupd','devupd','cfix'].forEach(function(id){$(id).addEventListener('input',markDirty);$(id).addEventListener('change',markDirty);});
$('addSensor').onclick=function(){$('sensorList').appendChild(sensorRow({id:'',name:'',statusUrl:''}));markDirty();};
$('genTopic').onclick=function(){var a='abcdefghjkmnpqrstuvwxyz23456789',r='sk-';for(var i=0;i<10;i++)r+=a[Math.floor(Math.random()*a.length)];$('ntfy').value=r;markDirty();};
$('save').onclick=function(){var b=$('save');b.disabled=true;var sensors=[];document.querySelectorAll('#sensorList .sensor').forEach(function(d){sensors.push({id:d.querySelector('.sid').value.trim(),name:d.querySelector('.sname').value.trim(),statusUrl:d.querySelector('.surl').value.trim(),devicePassword:d.querySelector('.spw').value,clearPassword:!!(d.querySelector('.spwreset')&&d.querySelector('.spwreset').checked)});});
  api('save',{sensors:sensors,portalToken:$('token').value.trim(),lowWater:$('lowWater').value,topupAmount:$('topupAmount').value,checkEveryMinutes:$('checkEvery').value,discordWebhook:$('discord').value.trim(),ntfyTopic:$('ntfy').value.trim(),weeklySummary:$('weekly').checked,autoUpdate:$('autoupd').checked,deviceAutoUpdate:$('devupd').checked,communityFixes:$('cfix').checked})
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
  update              Install the latest Sensor Keeper now (it also does this by itself)
  update-sensors      Check for and install Air!Squitter software updates now
  diagnose            Explain in plain language what's wrong with a sensor and what to do
  fixes               List unofficial community fixes and whether your sensors need them
  apply-fix <id>      Install a community fix now (only if the sensor shows the problem)
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
    case 'diagnose': {
      const c = needCfg();
      const { results } = await checkAll(c);
      for (const r of results) {
        console.log(describe(r));
        const sensor = c.sensors.find((x) => x.id === r.id);
        if (!sensor || !sensor.statusUrl) { console.log('  (no Air!Squitter status page set up, so no deeper checks)\n'); continue; }
        const f = await diagnoseSensor(c, sensor, { heartbeatAgeMin: r.heartbeatAgeMin });
        for (const x of f) console.log(`  ${x.level === 'ok' ? '✓' : x.level === 'warn' ? '!' : '✗'} ${x.text}${x.fix ? `\n      → ${x.fix}` : ''}`);
        console.log('');
      }
      return;
    }
    case 'fixes': {
      console.log('Unofficial community fixes (not from jetvision or 4DSKY). Turn on automatic install in Settings,');
      console.log(`or install one by hand with: ${APP} apply-fix <id>\n`);
      const c = loadConfig(); const st = loadState();
      for (const f of COMMUNITY_FIXES) {
        console.log(`${f.id}: ${f.title}\n  ${f.description}`);
        for (const s2 of ((c && c.sensors) || []).filter((x) => x.statusUrl)) {
          const fx = ((st.sensors[s2.id] || {}).fixes || {})[f.id];
          console.log(`  ${s2.name || s2.id}: ${fx ? fx.result : 'not checked yet'}`);
        }
        console.log('');
      }
      return;
    }
    case 'apply-fix': {
      const c = needCfg();
      const fix = COMMUNITY_FIXES.find((f) => f.id === argv[1]);
      if (!fix) { console.error(`Usage: ${APP} apply-fix <id>   (see "${APP} fixes")`); process.exit(1); }
      const res = await communityFixesAll(c, { force: true, only: fix.id });
      res.forEach((r) => console.log(`${r.sensor.name || r.sensor.id}: ${r.result}`));
      return;
    }
    case 'update-sensors': {
      const c = needCfg();
      if (!c.sensors.some((x) => x.statusUrl)) { console.log(`No Air!Squitter status page is set up. Run "${APP} setup" to add one.`); return; }
      await deviceUpdatesAll(c, { force: true });
      const st = loadState();
      for (const x of c.sensors.filter((y) => y.statusUrl)) {
        const du = (st.sensors[x.id] || {}).deviceUpdate || {};
        console.log(`${x.name || x.id}: ${du.pending ? `installing ${du.pending.to} (was ${du.pending.from}) — the sensor restarts; watch the log` : du.lastResult || 'see log'}`);
      }
      return;
    }
    case 'update': {
      const u = await selfUpdate(loadConfig(), { force: process.argv.includes('--force') });
      console.log(u.updated ? `Updated to v${u.version}. The background service restarts into it within a minute.` : `No update installed: ${u.reason}`);
      return;
    }
    default: help();
  }
}

if (typeof fetch !== 'function') {
  console.error('Sensor Keeper needs Node.js 18 or newer (or use the standalone download).');
  process.exit(1);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
