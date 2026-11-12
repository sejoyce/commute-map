// Bakes a transit agency's GTFS feed into one compact JSON file the browser can load.
//
//   npm run build:gtfs                          (MBTA, next weekday, all modes)
//   npm run build:gtfs -- --date 2026-11-18     (a specific service date)
//   npm run build:gtfs -- --no-bus              (rail/subway/ferry only: much smaller file)
//   npm run build:gtfs -- --zip ./MBTA_GTFS.zip (use a zip you already downloaded)
//
// Output: public/gtfs/mbta.json. Re-run it whenever the agency publishes a new schedule
// (MBTA updates its feed several times a year), or the data will go stale.

import { unzipSync } from 'fflate';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const FEED_URL = opt('url', 'https://cdn.mbta.com/MBTA_GTFS.zip');
const OUT = opt('out', 'public/gtfs/mbta.json');
// GTFS route_type: 0 tram/light rail, 1 subway, 2 rail (commuter rail), 3 bus, 4 ferry
const MODES = new Set(flag('no-bus') ? [0, 1, 2, 4] : [0, 1, 2, 3, 4]);

function nextWeekday() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  return d;
}
const serviceDate = opt('date') ? new Date(`${opt('date')}T12:00:00`) : nextWeekday();
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const DATE = ymd(serviceDate);
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][serviceDate.getDay()];

// ---------- tiny CSV reader (handles quoted fields) ----------
function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Calls fn(row) for each data row; row is an object keyed by header name.
function eachRow(text, fn) {
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let header = null;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    let line = text.slice(pos, end);
    pos = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) continue;
    const cells = splitCsvLine(line);
    if (!header) { header = cells.map((h) => h.trim()); continue; }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] ?? '';
    fn(row);
  }
}

const toSeconds = (t) => {
  if (!t) return null;
  const [h, m, s] = t.trim().split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

// ---------- load the feed ----------
let zipBytes;
if (opt('zip')) {
  console.log(`Reading ${opt('zip')}`);
  zipBytes = new Uint8Array(readFileSync(opt('zip')));
} else {
  console.log(`Downloading ${FEED_URL}`);
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  zipBytes = new Uint8Array(await res.arrayBuffer());
}
const WANT = ['routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt'];
const files = unzipSync(zipBytes, { filter: (f) => WANT.includes(f.name) });
const text = (name) => (files[name] ? new TextDecoder().decode(files[name]) : '');

// ---------- which services run on the chosen date ----------
const active = new Set();
let feedWindow = null;
eachRow(text('calendar.txt'), (r) => {
  if (r.start_date <= DATE && DATE <= r.end_date && r[DOW] === '1') active.add(r.service_id);
});
eachRow(text('calendar_dates.txt'), (r) => {
  if (r.date !== DATE) return;
  if (r.exception_type === '1') active.add(r.service_id);
  if (r.exception_type === '2') active.delete(r.service_id);
});
eachRow(text('feed_info.txt'), (r) => { feedWindow = [r.feed_start_date, r.feed_end_date]; });
if (!active.size) {
  throw new Error(`No service runs on ${DATE}. The feed covers ${feedWindow?.join(' to ') ?? 'unknown dates'}. Try --date YYYY-MM-DD.`);
}

// ---------- routes and trips ----------
const routeInfo = new Map();
eachRow(text('routes.txt'), (r) => {
  const type = Number(r.route_type);
  if (MODES.has(type)) routeInfo.set(r.route_id, { type, name: r.route_short_name || r.route_long_name });
});
const tripRoute = new Map();
eachRow(text('trips.txt'), (r) => {
  if (routeInfo.has(r.route_id) && active.has(r.service_id)) tripRoute.set(r.trip_id, r.route_id);
});

// ---------- stops: merge platforms into their parent station ----------
const stopRec = new Map();
eachRow(text('stops.txt'), (r) => stopRec.set(r.stop_id, r));
const stationOf = (stopId) => {
  const s = stopRec.get(stopId);
  return s && s.parent_station && stopRec.has(s.parent_station) ? s.parent_station : stopId;
};

// ---------- stop_times for the trips we kept ----------
const tripTimes = new Map(); // trip_id -> [{seq, station, arr, dep}]
eachRow(text('stop_times.txt'), (r) => {
  if (!tripRoute.has(r.trip_id)) return;
  const arr = toSeconds(r.arrival_time), dep = toSeconds(r.departure_time);
  let list = tripTimes.get(r.trip_id);
  if (!list) tripTimes.set(r.trip_id, (list = []));
  list.push({ seq: Number(r.stop_sequence), station: stationOf(r.stop_id), arr: arr ?? dep, dep: dep ?? arr });
});

// Fill any stops with no time by interpolating between neighbours.
function fillGaps(list) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].arr != null) continue;
    let a = i - 1, b = i + 1;
    while (b < list.length && list[b].arr == null) b++;
    if (a < 0 || b >= list.length) return false;
    const t0 = list[a].dep, t1 = list[b].arr;
    for (let j = i; j < b; j++) list[j].arr = list[j].dep = Math.round(t0 + ((t1 - t0) * (j - a)) / (b - a));
  }
  return true;
}

// ---------- group trips into patterns (same stops in the same order) ----------
const stationIndex = new Map();
const stations = [];
const idxOf = (id) => {
  if (!stationIndex.has(id)) {
    const s = stopRec.get(id);
    stationIndex.set(id, stations.length);
    stations.push([Number((+s.stop_lat).toFixed(5)), Number((+s.stop_lon).toFixed(5)), s.stop_name]);
  }
  return stationIndex.get(id);
};

const patterns = new Map();
let droppedTrips = 0;
for (const [tripId, list] of tripTimes) {
  list.sort((a, b) => a.seq - b.seq);
  if (list.length < 2 || !fillGaps(list)) { droppedTrips++; continue; }
  const route = routeInfo.get(tripRoute.get(tripId));
  const seq = list.map((x) => idxOf(x.station));
  const key = `${tripRoute.get(tripId)}|${seq.join(',')}`;
  let p = patterns.get(key);
  if (!p) patterns.set(key, (p = { t: route.type, n: route.name, s: seq, trips: [] }));
  p.trips.push(list.flatMap((x) => [x.arr, x.dep]));
}
const routes = [...patterns.values()];
for (const r of routes) r.trips.sort((a, b) => a[1] - b[1]); // by first departure

// ---------- write ----------
const lats = stations.map((s) => s[0]), lons = stations.map((s) => s[1]);
const out = {
  meta: {
    agency: 'MBTA',
    serviceDate: `${DATE.slice(0, 4)}-${DATE.slice(4, 6)}-${DATE.slice(6)}`,
    feedWindow,
    modes: [...MODES],
    bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    builtAt: new Date().toISOString(),
  },
  stops: stations,
  routes,
};
mkdirSync(OUT.split('/').slice(0, -1).join('/') || '.', { recursive: true });
const json = JSON.stringify(out);
writeFileSync(OUT, json);

const tripCount = routes.reduce((n, r) => n + r.trips.length, 0);
console.log(`Service date ${out.meta.serviceDate}: ${stations.length} stations, ${routes.length} patterns, ${tripCount} trips (${droppedTrips} dropped)`);
console.log(`Wrote ${OUT} (${(json.length / 1e6).toFixed(1)} MB)`);
