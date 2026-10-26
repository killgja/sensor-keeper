// Station logbook / range / hobby alerts against a fake AirSquitter. Run: node test/station.test.js
'use strict';
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const createStation = require('../station');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-station-'));
let list = [];
const srv = http.createServer((q, r) => {
  r.setHeader('Content-Type', 'application/json');
  if (q.url === '/gps.json') return r.end(JSON.stringify({ ReceiverStatus: { Latitude: 40, Longitude: -75 } }));
  if (q.url === '/aircraftlist.json') return r.end(JSON.stringify(list));
  r.statusCode = 404; r.end('{}');
});
srv.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  const sent = [];
  const cfg = { sensors: [{ id: 'sensA', name: 'Roof', statusUrl: base + '/' }], hobby: { watch: ['N123AB', 'military', 'UAL'] } };
  const tryHttp = async (u) => { try { const r = await fetch(u); return { ok: r.ok, json: await r.json() }; } catch (e) { return { ok: false }; } };
  const st = createStation({ home, loadConfig: () => cfg, log: () => {}, tryHttp, devBase: (u) => u.replace(/\/+$/, ''), sendAlert: async (c, t, b) => { sent.push(t + ' | ' + b); } });
  // north of the receiver ~111 km, east ~85 km
  list = [
    { hex: 'a1b2c3', reg: 'N123AB', typ: 'C172', fli: null, lat: 41, lon: -75, alt: 3500, dis: 111.2 },
    { hex: 'AE1234', reg: '', typ: 'C17', fli: 'RCH123', lat: 40, lon: -74, alt: 28000, dis: 85.1 },
    { hex: 'A00001', reg: 'N1', typ: 'B738', fli: 'UAL55', lat: null, lon: null, dis: null },
    { hex: 'zz', reg: 'bad' },
  ];
  await st.tick();
  assert.strictEqual(sent.length, 3, 'three watch alerts on first sight: ' + sent.join('\n'));
  assert(sent[0].includes('N123AB') && sent[0].includes('111 km'));
  await st.tick();
  assert.strictEqual(sent.length, 3, 'no repeat alerts while still in range');
  let sum = st.summary('sensA');
  assert.strictEqual(sum.total, 3); assert.strictEqual(sum.today, 3); assert.strictEqual(sum.military, 1);
  assert.strictEqual(sum.range.rec.km, 111.2); assert.strictEqual(sum.range.bins[0], 111.2);
  assert(sum.range.bins[8] > 80 || sum.range.bins[9] > 80, 'east bin filled');
  // record alert: needs a station older than 3 days
  st.flush();
  const f = path.join(home, 'station-sensA.json');
  const j = JSON.parse(fs.readFileSync(f)); j.since -= 4 * 86400e3; fs.writeFileSync(f, JSON.stringify(j));
  const st2 = createStation({ home, loadConfig: () => cfg, log: () => {}, tryHttp, devBase: (u) => u.replace(/\/+$/, ''), sendAlert: async (c, t, b) => { sent.push(t + ' | ' + b); } });
  list = [{ hex: 'B00002', reg: 'N9', typ: 'E75L', fli: 'DAL9', lat: 43, lon: -75, alt: 36000, dis: 333.6 }];
  await st2.tick();
  assert(sent.some((x) => x.startsWith('New range record for Roof: 334 km')), sent.join('\n'));
  assert.strictEqual(st2.search('sensA', 'rch').length, 1);
  assert.strictEqual(st2.search('sensA', '').length, 4);
  console.log('station.test.js: all checks passed');
  srv.close(); fs.rmSync(home, { recursive: true, force: true });
});
