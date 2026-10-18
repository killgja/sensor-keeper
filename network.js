'use strict';
// Sky Warden network: opt-in sharing of this computer's sensors' live aircraft with the
// shared network map (network.businessrx.ai). Sends aircraft only — never the sensor's own
// position, distance or signal strength. Feeding is what makes the network map free.
const DEFAULT_URL = 'https://network.businessrx.ai';
const FEED_EVERY = 10_000;
const DROP = ['dis', 'dbm', 'uti', 'ava'];   // per-sensor fields that hint at where the sensor is

module.exports = function createNetwork(k) {
  // k: { loadConfig, saveNetwork, log, http }
  let timer = null, failing = false, lastOk = 0, lastCount = 0;

  async function join(invite, name, url) {
    const base = (url || DEFAULT_URL).replace(/\/+$/, '');
    const r = await k.http(`${base}/v1/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite, name }) }, 15000);
    if (!r.ok || !r.json || !r.json.token) throw new Error((r.json && r.json.error) || `HTTP ${r.status}`);
    k.saveNetwork({ url: base, feederId: r.json.feederId, token: r.json.token, share: true, joinedAt: Date.now() });
    return r.json.feederId;
  }

  function setShare(on) {
    const n = (k.loadConfig() || {}).network;
    if (!n || !n.token) return false;
    k.saveNetwork({ ...n, share: !!on });
    return true;
  }

  async function feedOnce() {
    const cfg = k.loadConfig();
    const n = cfg && cfg.network;
    if (!n || !n.share || !n.token) return;
    const aircraft = [];
    for (const s of (cfg.sensors || []).filter((x) => x.statusUrl)) {
      try {
        const r = await k.http(`${s.statusUrl.replace(/\/+$/, '')}/aircraftlist.json`, {}, 8000);
        if (Array.isArray(r.json)) for (const a of r.json) { const c = { ...a }; for (const f of DROP) delete c[f]; aircraft.push(c); }
      } catch { /* sensor busy or rebooting — try next round */ }
    }
    if (!aircraft.length) return;
    try {
      const r = await k.http(`${n.url}/v1/feed`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${n.token}` }, body: JSON.stringify({ aircraft }) }, 15000);
      if (!r.ok) throw new Error((r.json && r.json.error) || `HTTP ${r.status}`);
      if (failing) k.log('network: sharing again');
      failing = false; lastOk = Date.now(); lastCount = aircraft.length;
    } catch (e) {
      if (!failing) k.log(`network: couldn't share with the Sky Warden network (${e.message}) — will keep trying`);
      failing = true;
    }
  }

  function start() {
    if (timer) return;
    const n = (k.loadConfig() || {}).network;
    if (n && n.share) k.log('network: sharing live aircraft with the Sky Warden network');
    timer = setInterval(() => { feedOnce().catch(() => {}); }, FEED_EVERY);
  }

  function status() {
    const n = (k.loadConfig() || {}).network;
    if (!n) return { joined: false };
    return { joined: true, url: n.url, feederId: n.feederId, share: !!n.share, sensorFeeds: !!n.deviceFeeder, lastShared: lastOk ? new Date(lastOk).toISOString() : null, lastCount };
  }

  // What a paired phone needs to view the network map (sent over the encrypted relay).
  function phoneAccess() {
    const n = (k.loadConfig() || {}).network;
    // The map stays free while *something* feeds for this account: this computer, or the
    // sensor itself (see useDeviceFeeder). The server enforces that, so always hand it over.
    return n && n.token ? { url: n.url, token: n.token } : null;
  }

  // The sensor uploads by itself (skywarden-feeder on the Air!Squitter): stop uploading from
  // this computer and give the phone the sensor's feeder access instead.
  function useDeviceFeeder(token, url) {
    if (!/^[0-9a-f]{64}$/.test(token || '')) throw new Error('that is not a feeder token');
    const n = (k.loadConfig() || {}).network || {};
    k.saveNetwork({ ...n, url: (url || n.url || DEFAULT_URL).replace(/\/+$/, ''), token, share: false, deviceFeeder: true, computerToken: n.computerToken || n.token });
  }

  return { join, setShare, feedOnce, start, status, phoneAccess, useDeviceFeeder };
};
