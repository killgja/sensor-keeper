'use strict';
// My station: a private logbook and range record for each AirSquitter, kept on this computer.
// Reads the sensor's own aircraftlist.json (and gps.json for the bearing) once a minute.
// Nothing here is sent anywhere, except the optional hobby alerts to the user's own
// Discord webhook / ntfy topic. The sensor's position never leaves this computer.

const fs = require('fs');
const path = require('path');

const SAMPLE_EVERY = 60_000;
const SAVE_EVERY = 2 * 60_000;
const LOG_MAX = 20_000;                 // aircraft kept per sensor (oldest dropped first)
const MAX_KM = 800;                     // anything farther is a bad position
const WATCH_GAP = 6 * 3600_000;         // a watched aircraft must be away this long to alert again
const WATCH_MAX_PER_HOUR = 6;
const RECORD_MIN_AGE = 3 * 86400_000;   // no record alerts during the first 3 days (every catch is a record)
const RECORD_STEP_KM = 2;
const RECORD_GAP = 6 * 3600_000;
const MIL_PREFIX = /^(RCH|REACH|CNV|PAT|SPAR|SAM|VENUS|EXEC|ARMY|NAVY|TOPCAT|EVAC|DUKE|PACK|BOLT|HAWK|VIPER)\d/;

const clean = (s) => (s == null ? '' : String(s).trim());
const isMilitary = (hex, fli) => {
  const h = parseInt(hex, 16);
  return (h >= 0xAE0000 && h <= 0xAFFFFF) || MIL_PREFIX.test(clean(fli).toUpperCase());
};
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

module.exports = function createStation(k) {
  // k: { home, loadConfig, saveHobby, log, tryHttp, devBase, sendAlert }
  const mem = new Map();          // sensorId -> state
  const dirty = new Set();
  let timer = null, saveTimer = null, alertTimes = [], sampling = false;

  const file = (id) => path.join(k.home, `station-${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  function load(id) {
    if (sampling && mem.has(id)) return mem.get(id);   // the UI process re-reads what the service saved
    let s = null;
    try { s = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { /* new */ }
    if (!s || s.v !== 1) s = { v: 1, since: Date.now(), log: {}, bins: new Array(36).fill(0), rec: null, day: '', todayKm: 0, todayRec: null, lastRecAlert: 0 };
    mem.set(id, s);
    return s;
  }
  function save(id) {
    const s = mem.get(id); if (!s) return;
    const ids = Object.keys(s.log);
    if (ids.length > LOG_MAX) ids.sort((a, b) => s.log[a][1] - s.log[b][1]).slice(0, ids.length - LOG_MAX).forEach((h) => delete s.log[h]);
    try { const f = file(id); fs.writeFileSync(f + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); } catch (e) { k.log(`station: couldn't save ${id}: ${e.message}`); }
  }
  function flush() { for (const id of dirty) save(id); dirty.clear(); }

  async function receiver(sensor, s, now) {
    if (s.rx && now - s.rx.t < (s.rx.lat != null ? 3600_000 : 300_000)) return s.rx;
    const r = await k.tryHttp(`${k.devBase(sensor.statusUrl)}/gps.json`, {}, 8000);
    const j = r && r.json && (r.json.ReceiverStatus || r.json);   // AirSquitter nests it under ReceiverStatus
    const lat = j && Number(j.Latitude), lon = j && Number(j.Longitude);
    s.rx = (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) ? { lat, lon, t: now } : { t: now };
    return s.rx;
  }

  function wantAlert(now) {
    alertTimes = alertTimes.filter((t) => now - t < 3600_000);
    if (alertTimes.length >= WATCH_MAX_PER_HOUR) return false;
    alertTimes.push(now); return true;
  }

  function watchHit(rules, a) {
    if (!rules.length) return null;
    const reg = clean(a.reg).toUpperCase(), fli = clean(a.fli).toUpperCase(), hex = clean(a.hex).toUpperCase();
    for (const r0 of rules) {
      const r = clean(r0).toUpperCase().replace(/\s+/g, '');
      if (!r) continue;
      if (r === 'MILITARY' && isMilitary(hex, fli)) return r0;
      if (r === reg || r === fli || r === hex || (r.length === 3 && /^[A-Z]{3}$/.test(r) && fli.startsWith(r) && /\d/.test(fli.slice(3, 4)))) return r0;
      if (r === clean(a.typ).toUpperCase()) return r0;
    }
    return null;
  }

  async function sampleSensor(cfg, sensor, now) {
    if (!sensor.statusUrl) return;
    const r = await k.tryHttp(`${k.devBase(sensor.statusUrl)}/aircraftlist.json`, {}, 10000);
    if (!r.ok || !Array.isArray(r.json)) return;
    const s = load(sensor.id);
    const rx = await receiver(sensor, s, now);
    const today = dayKey(now);
    if (s.day !== today) { s.day = today; s.todayKm = 0; s.todayRec = null; }
    const hobby = cfg.hobby || {};
    const rules = Array.isArray(hobby.watch) ? hobby.watch : [];
    const alerts = [];
    let bestNew = null;
    for (const a of r.json) {
      const hex = clean(a.hex).toUpperCase();
      if (!/^[0-9A-F]{6}$/.test(hex)) continue;
      const prev = s.log[hex];
      const reg = clean(a.reg), typ = clean(a.typ), opr = clean(a.opr), fli = clean(a.fli);
      if (!prev) s.log[hex] = [now, now, 1, reg, typ, opr, fli, today];
      else {
        if (prev[7] !== today) { prev[2]++; prev[7] = today; }
        if (reg) prev[3] = reg; if (typ) prev[4] = typ; if (opr) prev[5] = opr; if (fli) prev[6] = fli;
      }
      const lastSeen = prev ? prev[1] : 0;
      if (prev) prev[1] = now;
      const hit = watchHit(rules, a);
      if (hit && now - lastSeen > WATCH_GAP) alerts.push({ a, hit });
      const d = Number(a.dis);
      if (!(d > 0 && d <= MAX_KM) || a.lat == null || a.lon == null) continue;
      if (rx.lat != null) {
        const b = Math.floor(bearing(rx.lat, rx.lon, Number(a.lat), Number(a.lon)) / 10) % 36;
        if (d > s.bins[b]) s.bins[b] = Math.round(d * 10) / 10;
      }
      const catchInfo = { km: Math.round(d * 10) / 10, hex, reg, typ, fli, alt: a.alt ?? null, t: now };
      if (d > s.todayKm) { s.todayKm = catchInfo.km; s.todayRec = catchInfo; }
      if (!s.rec || d > s.rec.km) { if (!bestNew || d > bestNew.km) bestNew = catchInfo; }
    }
    if (bestNew) {
      const old = s.rec;
      s.rec = bestNew;
      if (hobby.rangeRecord !== false && old && now - s.since > RECORD_MIN_AGE && bestNew.km - old.km >= RECORD_STEP_KM && now - (s.lastRecAlert || 0) > RECORD_GAP) {
        s.lastRecAlert = now;
        const who = bestNew.fli || bestNew.reg || bestNew.hex;
        await k.sendAlert(cfg, `New range record for ${sensor.name || sensor.id}: ${Math.round(bestNew.km)} km`,
          `${who}${bestNew.typ ? ` (${bestNew.typ})` : ''}${bestNew.alt != null ? ` at ${bestNew.alt} ft` : ''}, ${Math.round(bestNew.km)} km away. Your previous best was ${Math.round(old.km)} km.`).catch(() => {});
      }
    }
    for (const { a, hit } of alerts) {
      if (!wantAlert(now)) break;
      const who = clean(a.fli) || clean(a.reg) || clean(a.hex);
      const what = [clean(a.reg) && clean(a.reg) !== who ? clean(a.reg) : '', clean(a.typ), clean(a.opr)].filter(Boolean).join(' · ');
      const where = Number(a.dis) > 0 ? `${Math.round(Number(a.dis))} km away` : 'in range (no position yet)';
      await k.sendAlert(cfg, `${who} is in range of ${sensor.name || sensor.id}`,
        `${what ? what + '. ' : ''}${where}${a.alt != null ? `, ${a.alt} ft` : ''}. On your watch list (${hit}).`).catch(() => {});
    }
    dirty.add(sensor.id);
  }

  async function tick() {
    sampling = true;
    const cfg = k.loadConfig();
    if (!cfg || !Array.isArray(cfg.sensors) || (cfg.hobby && cfg.hobby.station === false)) return;
    const now = Date.now();
    for (const sensor of cfg.sensors) {
      try { await sampleSensor(cfg, sensor, now); } catch (e) { k.log(`station: ${sensor.id}: ${e.message}`); }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, SAMPLE_EVERY);
    saveTimer = setInterval(flush, SAVE_EVERY);
    setTimeout(() => { tick().catch(() => {}); }, 15_000);
    const bye = () => { try { flush(); } catch { /* ignore */ } };
    process.once('exit', bye);
  }

  function summary(id, now = Date.now()) {
    const s = load(id);
    const m = midnight(now), w = now - 7 * 86400_000;
    let today = 0, week = 0, newToday = 0, military = 0;
    const types = {};
    const rows = [];
    for (const [hex, e] of Object.entries(s.log)) {
      if (e[1] >= m) today++;
      if (e[1] >= w) week++;
      if (e[0] >= m) newToday++;
      if (isMilitary(hex, e[6])) military++;
      if (e[4]) types[e[4]] = (types[e[4]] || 0) + 1;
      rows.push([hex, e]);
    }
    const row = ([hex, e]) => ({ hex, first: e[0], last: e[1], days: e[2], reg: e[3], typ: e[4], opr: e[5], fli: e[6], mil: isMilitary(hex, e[6]) });
    return {
      since: s.since, total: rows.length, today, week, newToday, military,
      recent: rows.slice().sort((a, b) => b[1][1] - a[1][1]).slice(0, 25).map(row),
      regulars: rows.filter((x) => x[1][2] > 1).sort((a, b) => b[1][2] - a[1][2]).slice(0, 15).map(row),
      types: Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => ({ t, n })),
      range: { bins: s.bins, rec: s.rec, todayKm: s.day === dayKey(now) ? s.todayKm : 0, todayRec: s.day === dayKey(now) ? s.todayRec : null, hasBearing: !!(s.rx && s.rx.lat != null) },
    };
  }

  function search(id, q, limit = 100) {
    const s = load(id);
    const Q = clean(q).toUpperCase();
    const out = [];
    for (const [hex, e] of Object.entries(s.log)) {
      if (Q && ![hex, e[3], e[4], e[5], e[6]].some((v) => clean(v).toUpperCase().includes(Q))) continue;
      out.push({ hex, first: e[0], last: e[1], days: e[2], reg: e[3], typ: e[4], opr: e[5], fli: e[6], mil: isMilitary(hex, e[6]) });
    }
    return out.sort((a, b) => b.last - a.last).slice(0, limit);
  }

  return { start, tick, flush, summary, search, isMilitary, _watchHit: watchHit };
};
