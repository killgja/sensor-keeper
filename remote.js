'use strict';
/*
 * Sky Warden remote control over Hedera Consensus Service (testnet).
 * Protocol: docs/remote-protocol.md. Loaded only when the remote feature is used.
 *
 * Keys: the CONTROL account key (a separate, free Hedera Portal testnet account the user
 * creates) is stored in Sensor Keeper's config (file mode 600). The sensor's own key is
 * never used. The phone's key is generated here, shown once as a QR code on this screen,
 * and not stored on this computer.
 */
const crypto = require('crypto');

const PROTO = 'skywarden-remote-v1';
const ALLOWED = ['check', 'restart4dsky', 'applyFix', 'traffic', 'powerCycle'];
const MAX_SKEW_S = 300;
const MAX_PER_HOUR = 20;   // remote commands per hour, relay and Hedera together (1.8.1: shared and saved)
const MAX_PLAINTEXT = 640;   // keeps every message in a single 1 KB HCS chunk

function sdk() { return require('@hashgraph/sdk'); }

function parseKey(str) {
  const { PrivateKey } = sdk();
  const s = String(str).trim().replace(/^0x/, '');
  try { return PrivateKey.fromStringDer(s); } catch { /* not DER */ }
  try { return PrivateKey.fromStringED25519(s); } catch { /* not raw ed25519 */ }
  return PrivateKey.fromStringECDSA(s);
}

function aad(topic) { return Buffer.from(`${PROTO}|${topic}`); }
const RELAY_PROTO = 'skywarden-relay-v1';
function roomId(secretB64) { return crypto.createHash('sha256').update(`skywarden-room|${secretB64}`).digest('hex'); }
function sealRaw(secretB64, aadStr, json) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(secretB64, 'base64'), nonce);
  c.setAAD(Buffer.from(aadStr));
  const ct = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64');
}
function openRaw(secretB64, aadStr, b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(secretB64, 'base64'), buf.subarray(0, 12));
  d.setAAD(Buffer.from(aadStr));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
}
function encrypt(secretB64, topic, obj) {
  let json = JSON.stringify(obj);
  if (Buffer.byteLength(json) > MAX_PLAINTEXT && obj.detail) {
    const over = Buffer.byteLength(json) - MAX_PLAINTEXT;
    obj = { ...obj, detail: obj.detail.slice(0, Math.max(0, obj.detail.length - over - 2)) + '…' };
    json = JSON.stringify(obj);
  }
  const key = Buffer.from(secretB64, 'base64');
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad(topic));
  const ct = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64');
}
function decrypt(secretB64, topic, b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 12 + 16 + 2) throw new Error('too short');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(secretB64, 'base64'), buf.subarray(0, 12));
  d.setAAD(aad(topic));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
}

// Sensors this computer watches, as the phone needs them (no passwords).
function sensorList(cfg) {
  return (cfg.sensors || []).map((x) => ({ id: x.id, name: x.name || x.id,
    local: x.statusUrl ? x.statusUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : null, plug: !!(x.plug && x.plug.host) }));
}

module.exports = function createRemote(k) {
  // k: { loadConfig, saveRemote, loadState, saveState, log, http, MIRROR, handlers: { check, restart4dsky, applyFix } }
  function client(rc) {
    const { Client, AccountId } = sdk();
    const c = Client.forTestnet();
    c.setOperator(AccountId.fromString(rc.control.account), parseKey(rc.control.key));
    return c;
  }

  async function verifyControl(account, keyStr) {
    const key = parseKey(keyStr);
    const r = await k.http(`${k.MIRROR}/accounts/${account}?transactions=false`);
    if (!r.ok || !r.json) throw new Error(`account ${account} not found on testnet (HTTP ${r.status})`);
    const onChain = (r.json.key && r.json.key.key || '').toLowerCase();
    if (onChain !== key.publicKey.toStringRaw().toLowerCase()) throw new Error("that private key doesn't belong to this account");
    return { key, balance: Number(r.json.balance.balance) / 1e8 };
  }

  async function setControl(account, keyStr) {
    const { key, balance } = await verifyControl(account, keyStr);
    const cfg = k.loadConfig();
    cfg.remote = { ...(cfg.remote || {}), control: { account, key: key.toStringDer() } };
    k.saveRemote(cfg.remote);
    return { balance };
  }

  async function pair(computerName) {
    const { PrivateKey, AccountCreateTransaction, TopicCreateTransaction, TopicDeleteTransaction, KeyList, Hbar, TopicId } = sdk();
    const cfg = k.loadConfig();
    const rc = cfg.remote;
    if (!rc || !rc.control) throw new Error('run "remote-setup" first to add your control account');
    const c = client(rc);
    try {
      const controlPub = parseKey(rc.control.key).publicKey;
      const phoneKey = PrivateKey.generateED25519();
      const acct = await (await new AccountCreateTransaction().setKey(phoneKey.publicKey)
        .setInitialBalance(new Hbar(50)).setAccountMemo('Sky Warden phone').execute(c)).getReceipt(c);
      const topicRx = await (await new TopicCreateTransaction()
        .setAdminKey(controlPub)
        .setSubmitKey(new KeyList([controlPub, phoneKey.publicKey], 1))
        .setTopicMemo(PROTO).execute(c)).getReceipt(c);
      const old = rc.topic;
      const next = {
        ...rc, topic: topicRx.topicId.toString(), phoneAccount: acct.accountId.toString(),
        phonePub: phoneKey.publicKey.toStringRaw(), secret: crypto.randomBytes(32).toString('base64'), pairedAt: Date.now(),
      };
      cfg.remote = next;
      k.saveRemote(cfg.remote);
      const st = k.loadState(); st.remote = { last: String(Date.now() / 1000), seen: [], hits: [] }; k.saveState(st);
      if (old) {   // revoke the previous pairing
        try { await (await new TopicDeleteTransaction().setTopicId(TopicId.fromString(old)).execute(c)).getReceipt(c); } catch (e) { k.log(`remote: could not delete old topic ${old}: ${e.message}`); }
      }
      const payload = { v: 1, net: 'testnet', topic: next.topic, phoneAccount: next.phoneAccount,
        phoneKey: phoneKey.toStringDer(), secret: next.secret, computer: computerName, relay: next.relay || null,
        sensors: sensorList(cfg) };
      k.log(`remote: paired a phone (account ${next.phoneAccount}, topic ${next.topic})`);
      return { payload, topic: next.topic, phoneAccount: next.phoneAccount };
    } finally { c.close(); }
  }

  async function send(rc, obj) {
    const { TopicMessageSubmitTransaction, TopicId } = sdk();
    const c = client(rc);
    try {
      await (await new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(rc.topic))
        .setMessage(encrypt(rc.secret, rc.topic, obj)).execute(c)).getReceipt(c);
    } finally { c.close(); }
  }

  // One hourly limit for remote commands from both paths, kept on disk.
  function takeHit() {
    const rp = k.loadReplay();
    rp.hits = rp.hits.filter((t) => Date.now() - t < 3600e3);
    if (rp.hits.length >= MAX_PER_HOUR) { k.saveReplay(rp); return false; }
    rp.hits.push(Date.now()); k.saveReplay(rp); return true;
  }

  let busy = false;
  async function poll() {
    if (busy) return;
    const cfg = k.loadConfig();
    const rc = cfg && cfg.remote;
    if (!rc || !rc.topic || !rc.secret || !rc.phoneAccount) return;
    busy = true;
    try {
      const st = k.loadState();
      const rs = (st.remote = st.remote || { last: String(Date.now() / 1000), seen: [], hits: [] });
      const r = await k.http(`${k.MIRROR}/topics/${rc.topic}/messages?order=asc&limit=25&timestamp=gt:${rs.last}`, {}, 15000);
      if (r.status === 404) { k.log(`remote: topic ${rc.topic} no longer exists (testnet reset?) — pair the phone again`); return; }
      const msgs = (r.ok && r.json && r.json.messages) || [];
      for (const m of msgs) {
        rs.last = m.consensus_timestamp;
        k.saveState(st);
        if (m.payer_account_id !== rc.phoneAccount) continue;          // our own replies, or anyone else
        let req;
        try { req = decrypt(rc.secret, rc.topic, Buffer.from(m.message, 'base64').toString('utf8')); }
        catch { k.log('remote: ignored a message that did not decrypt'); continue; }
        const cts = parseFloat(m.consensus_timestamp);
        if (req.t !== 'req' || typeof req.id !== 'string' || Math.abs((req.ts || 0) - cts) > MAX_SKEW_S) { k.log('remote: ignored a stale or malformed request'); continue; }
        if (rs.seen.includes(req.id)) continue;
        rs.seen = [...rs.seen, req.id].slice(-200);
        const reply = (o) => send(rc, { t: 'rep', id: req.id, ts: Math.floor(Date.now() / 1000), ...o });
        if (!takeHit()) { k.saveState(st); await reply({ ok: false, summary: 'Too many requests this hour — try again later.' }); continue; }
        k.saveState(st);
        const sensor = (cfg.sensors || []).find((s) => s.id === req.sensor);
        if (!ALLOWED.includes(req.cmd) || !sensor) { await reply({ ok: false, summary: 'Not allowed: unknown command or sensor.' }); continue; }
        k.log(`remote: ${req.cmd} for ${sensor.name || sensor.id} requested from Sky Warden`);
        let out;
        try { out = await k.handlers[req.cmd](cfg, sensor, req.args || {}); }
        catch (e) { out = { ok: false, summary: `Failed: ${e.message}` }; }
        await reply(out);
        k.log(`remote: ${req.cmd} for ${sensor.name || sensor.id}: ${out.summary}`);
      }
      k.saveState(st);
    } catch (e) {
      k.log(`remote: poll failed: ${e.message}`);
    } finally { busy = false; }
  }

  // ---------------------------------------------------------- relay (live traffic)
  // Outgoing WebSocket to the Sky Warden relay (Cloudflare Worker). The relay only forwards
  // end-to-end encrypted frames. While a paired phone subscribes, stream the sensor's live
  // aircraft list every 5 s.
  let ws = null, wsKey = '', backoff = 2000, subs = new Map(), streamTimer = null, pingTimer = null;
  const recv = { gps: {} };

  function relayInfo() {
    const cfg = k.loadConfig();
    const rc = cfg && cfg.remote;
    if (!rc || !rc.secret || !rc.relay) return null;
    return { cfg, rc, url: `${rc.relay.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws/${roomId(rc.secret)}?role=computer` };
  }

  function sendRelay(rc, obj) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(sealRaw(rc.secret, `${RELAY_PROTO}|${roomId(rc.secret)}`, JSON.stringify(obj)));
  }

  async function streamOnce() {
    const info = relayInfo();
    if (!info || !subs.size) return;
    for (const sensorId of new Set(subs.values())) {
      const sensor = (info.cfg.sensors || []).find((s) => s.id === sensorId);
      if (!sensor || !sensor.statusUrl) { sendRelay(info.rc, { t: 'traffic', sensor: sensorId, error: 'No AirSquitter address for this sensor in Sensor Keeper.' }); continue; }
      const base = sensor.statusUrl.replace(/\/+$/, '');
      try {
        if (!recv.gps[sensorId]) {
          const g = await k.http(`${base}/gps.json`, {}, 6000);
          const rs = g.json && g.json.ReceiverStatus;
          if (rs && rs.Latitude != null) recv.gps[sensorId] = { lat: rs.Latitude, lon: rs.Longitude };
        }
        const r = await k.http(`${base}/aircraftlist.json`, {}, 8000);
        if (!Array.isArray(r.json)) throw new Error('no aircraft list');
        const aircraft = r.json.map((a) => ({ hex: a.hex, src: a.src, ava: a.ava, fli: a.fli, reg: a.reg, typ: a.typ, lat: a.lat, lon: a.lon, alt: a.alt,
          spd: a.spd, trk: a.trk, vrt: a.vrt, dis: a.dis, dbm: a.dbm, squ: a.squ, cou: a.cou, opr: a.opr, org: a.org, dst: a.dst, uti: a.uti, cat: a.cat }));
        sendRelay(info.rc, { t: 'traffic', sensor: sensorId, ts: Math.floor(Date.now() / 1000), receiver: recv.gps[sensorId] || null, aircraft });
      } catch (e) {
        sendRelay(info.rc, { t: 'traffic', sensor: sensorId, error: `Couldn't read the sensor: ${e.message}` });
      }
    }
  }

  async function runRelayCmd(cur, m) {
    const reply = (o) => sendRelay(cur.rc, { t: 'res', id: m.id, client: m.client, ts: Math.floor(Date.now() / 1000), ...o });
    if (typeof m.id !== 'string' || Math.abs((m.ts || 0) - Date.now() / 1000) > MAX_SKEW_S) return;
    // 1.8.1: seen command ids and the hourly limit are saved, so a restart can't be used to replay a command.
    const rp = k.loadReplay();
    if (rp.seen.includes(m.id)) return;
    rp.seen = [...rp.seen, m.id].slice(-500); k.saveReplay(rp);
    if (!takeHit()) { reply({ ok: false, summary: 'Too many requests this hour — try again later.' }); return; }
    const sensor = (cur.cfg.sensors || []).find((s) => s.id === m.sensor);
    if (!ALLOWED.includes(m.cmd) || !sensor) { reply({ ok: false, summary: 'Not allowed: unknown command or sensor.' }); return; }
    k.log(`remote: ${m.cmd} for ${sensor.name || sensor.id} requested from Sky Warden (relay)`);
    reply({ ok: true, working: true, summary: 'Sensor Keeper is on it…' });
    let out;
    try { out = await k.handlers[m.cmd](cur.cfg, sensor, m.args || {}); }
    catch (e) { out = { ok: false, summary: `Failed: ${e.message}` }; }
    reply(out);
    k.log(`remote: ${m.cmd} for ${sensor.name || sensor.id}: ${out.summary}`);
  }

  function setStreaming() {
    if (subs.size && !streamTimer) { streamOnce(); streamTimer = setInterval(streamOnce, 5000); }
    if (!subs.size && streamTimer) { clearInterval(streamTimer); streamTimer = null; }
  }

  // One live socket at a time. Every handler checks it still owns `ws`, so a socket that was
  // replaced or closed late can't null out (or re-dial over) the current one. Before 1.6.1 a
  // late close plus the watchdog could start two dial loops that kept bumping each other off.
  let reconnectTimer = null, openedAt = 0;

  function scheduleReconnect(delay) {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; relayConnect(); }, delay);
  }

  function relayConnect() {
    const info = relayInfo();
    if (!info) return;
    if (typeof WebSocket !== 'function') { k.log('remote: this Node.js has no WebSocket support (needs Node 22+) — live traffic is off'); return; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;   // already connecting / connected
    wsKey = info.url;
    const sock = new WebSocket(info.url);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      openedAt = Date.now();
      k.log('remote: connected to the Sky Warden relay');
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      const text = String(ev.data);
      if (text === 'pong') return;
      if (text.startsWith('{')) {   // relay control message (plaintext, no secrets)
        try { const m = JSON.parse(text); if (m.relay === 'peers' && !m.phones) { subs.clear(); setStreaming(); } } catch {}
        return;
      }
      const cur = relayInfo();
      if (!cur) return;
      let m;
      try { m = openRaw(cur.rc.secret, `${RELAY_PROTO}|${roomId(cur.rc.secret)}`, text); } catch { return; }
      if (m.t === 'listSensors' && typeof m.client === 'string') { sendRelay(cur.rc, { t: 'sensors', client: m.client, sensors: sensorList(cur.cfg), network: (k.networkAccess && k.networkAccess()) || null }); return; }
      // Commands over the relay (same commands and limits as the Hedera topic, answered in seconds).
      if (m.t === 'cmd' && typeof m.id === 'string' && typeof m.client === 'string') { runRelayCmd(cur, m); return; }
      if (m.t === 'sub' && typeof m.sensor === 'string' && typeof m.client === 'string') subs.set(m.client, m.sensor);
      if (m.t === 'unsub' && typeof m.client === 'string') subs.delete(m.client);
      setStreaming();
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;   // an old socket closing late — ignore
      ws = null; subs.clear(); setStreaming();
      const lived = openedAt ? Date.now() - openedAt : 0;
      openedAt = 0;
      if (lived > 60000) backoff = 2000;   // only a connection that stayed up resets the backoff
      if (ev && ev.code === 4000) { k.log('remote: relay says another Sensor Keeper took over this pairing — is it running on two computers?'); backoff = Math.max(backoff, 60000); }
      scheduleReconnect(backoff);
      backoff = Math.min(backoff * 2, 5 * 60 * 1000);
    };
    sock.onerror = () => {};
    if (!pingTimer) pingTimer = setInterval(() => {
      const cur = relayInfo();
      if (ws && cur && cur.url !== wsKey) { try { ws.close(); } catch {} return; }   // re-paired: reconnect to the new room
      if (!ws && cur && !reconnectTimer) { relayConnect(); return; }
      if (ws && ws.readyState === 1) ws.send('ping');
    }, 30000);
  }

  function setRelay(url) {
    const cfg = k.loadConfig();
    cfg.remote = { ...(cfg.remote || {}), relay: url ? url.replace(/\/+$/, '') : undefined };
    k.saveRemote(cfg.remote);
  }

  function status() {
    const cfg = k.loadConfig() || {};
    const rc = cfg.remote || {};
    return { control: rc.control ? rc.control.account : null, topic: rc.topic || null, phoneAccount: rc.phoneAccount || null, pairedAt: rc.pairedAt || null, relay: rc.relay || null, relayConnected: !!(ws && ws.readyState === 1) };
  }

  async function unpair() {
    const { TopicDeleteTransaction, TopicId } = sdk();
    const cfg = k.loadConfig();
    const rc = cfg.remote;
    if (!rc || !rc.topic) return false;
    const c = client(rc);
    try { await (await new TopicDeleteTransaction().setTopicId(TopicId.fromString(rc.topic)).execute(c)).getReceipt(c); }
    catch (e) { k.log(`remote: could not delete topic: ${e.message}`); }
    finally { c.close(); }
    cfg.remote = { control: rc.control };
    k.saveRemote(cfg.remote);
    return true;
  }

  return { setControl, pair, poll, status, unpair, relayConnect, setRelay };
};
module.exports.encrypt = encrypt;
module.exports.decrypt = decrypt;
module.exports.roomId = roomId;
module.exports.sealRaw = sealRaw;
module.exports.openRaw = openRaw;
