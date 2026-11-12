// Run with: npm test
// Builds a tiny fake GTFS feed, runs the real build script on it, then checks the router
// against arrival times worked out by hand.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { booleanPointInPolygon, point } from '@turf/turf';
import { buildNetwork, runRaptor, distMeters, walkSeconds } from '../src/transit/raptor.js';
import { computeTransitIsochrone } from '../src/transit/local.js';

const dir = mkdtempSync(join(tmpdir(), 'transit-test-'));
const hms = (h, m, s = 0) => h * 3600 + m * 60 + s;
const t = (h, m) => `${h}:${String(m).padStart(2, '0')}:00`;

// ---- fake feed ----------------------------------------------------------------
//  A --- B --- C --- D        commuter rail "R", trains every 30 min, 6 min between stops
//              |   F (200 m from D, different line)
//              E (north of C)  subway "S" from C
//  F --- G                    bus "T" from F
const stopsTxt = [
  'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station',
  'A,A,42.3000,-71.2000,0,',
  'B,B,42.3000,-71.1500,0,',
  'C,C,42.3000,-71.1000,1,',
  'C_1,C rail platform,42.3000,-71.1000,0,C',
  'C_2,C subway platform,42.3001,-71.1000,0,C',
  'D,D,42.3000,-71.0500,0,',
  'E,E,42.3200,-71.1000,0,',
  'F,F,42.3018,-71.0500,0,',
  'G,G,42.3300,-71.0500,0,',
].join('\n');
const routesTxt = [
  'route_id,route_short_name,route_long_name,route_type',
  'R,R,Commuter,2', 'S,S,Subway,1', 'T,T,Bus,3', 'Z,Z,Funicular (unsupported),7',
].join('\n');
const calendarTxt = [
  'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
  'WK,1,1,1,1,1,0,0,20260101,20261231',
  'WE,0,0,0,0,0,1,1,20260101,20261231',
].join('\n');
const calendarDatesTxt = ['service_id,date,exception_type', 'WK,20261126,2'].join('\n'); // Thanksgiving: no service
const tripsRows = [
  ['R1', 'R', 'WK'], ['R2', 'R', 'WK'], ['R3', 'R', 'WK'], ['R4', 'R', 'WK'],
  ['RW', 'R', 'WE'], ['Z1', 'Z', 'WK'],
  ['S1', 'S', 'WK'], ['S2', 'S', 'WK'], ['T1', 'T', 'WK'], ['T2', 'T', 'WK'],
];
const tripsTxt = ['trip_id,route_id,service_id', ...tripsRows.map((r) => r.join(','))].join('\n');

const rows = [];
const add = (trip, stop, arr, dep) => rows.push(`${trip},${arr},${dep},${stop},${rows.filter((r) => r.startsWith(trip + ',')).length + 1}`);
const railTrip = (id, h, m) => {
  add(id, 'A', t(h, m), t(h, m));
  add(id, 'B', t(h, m + 6), t(h, m + 7));
  add(id, 'C_1', t(h, m + 13), t(h, m + 14));
  add(id, 'D', t(h, m + 20), t(h, m + 20));
};
railTrip('R1', 8, 0); railTrip('R2', 8, 30); railTrip('R3', 9, 0);
// R4 has no times at B: the build script must interpolate (A 9:30 -> C 9:44 puts B at 9:37).
add('R4', 'A', t(9, 30), t(9, 30)); add('R4', 'B', '', ''); add('R4', 'C_1', t(9, 44), t(9, 45)); add('R4', 'D', t(9, 50), t(9, 50));
// Must be filtered out: weekend-only service, and an unsupported route type. Both would be faster.
add('RW', 'A', t(8, 15), t(8, 15)); add('RW', 'B', t(8, 18), t(8, 18)); add('RW', 'C_1', t(8, 21), t(8, 21)); add('RW', 'D', t(8, 24), t(8, 24));
add('Z1', 'A', t(8, 25), t(8, 25)); add('Z1', 'B', t(8, 28), t(8, 28));
add('S1', 'C_2', t(8, 44), t(8, 44)); add('S1', 'E', t(8, 50), t(8, 50));
add('S2', 'C_2', t(9, 14), t(9, 14)); add('S2', 'E', t(9, 20), t(9, 20));
add('T1', 'F', t(8, 55), t(8, 55)); add('T1', 'G', t(9, 0), t(9, 0));
add('T2', 'F', t(9, 25), t(9, 25)); add('T2', 'G', t(9, 30), t(9, 30));
const stopTimesTxt = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence', ...rows].join('\n');

const zipPath = join(dir, 'fake.zip');
writeFileSync(zipPath, zipSync({
  'stops.txt': strToU8(stopsTxt), 'routes.txt': strToU8(routesTxt), 'trips.txt': strToU8(tripsTxt),
  'stop_times.txt': strToU8(stopTimesTxt), 'calendar.txt': strToU8(calendarTxt),
  'calendar_dates.txt': strToU8(calendarDatesTxt),
}));

function build(extra, out) {
  return spawnSync(process.execPath, ['scripts/build-gtfs.mjs', '--zip', zipPath, '--out', out, ...extra], { encoding: 'utf8' });
}

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// ---- build script ----------------------------------------------------------------
const outFull = join(dir, 'full.json');
const r1 = build(['--date', '2026-11-18'], outFull);
assert.equal(r1.status, 0, r1.stderr);
const data = JSON.parse(readFileSync(outFull, 'utf8'));
const idx = (name) => data.stops.findIndex((s) => s[2] === name);

console.log('build script');
check('merges the two platforms at C into one station (7 stations)', () => assert.equal(data.stops.length, 7));
check('drops weekend-only and unsupported-mode trips (3 patterns, 8 trips)', () => {
  assert.equal(data.routes.length, 3);
  assert.equal(data.routes.reduce((n, r) => n + r.trips.length, 0), 8);
});
check('interpolates the missing stop times (B at 9:37)', () => {
  const rail = data.routes.find((r) => r.n === 'R');
  const r4 = rail.trips.find((tr) => tr[1] === hms(9, 30));
  assert.equal(r4[2], hms(9, 37));
  assert.equal(r4[3], hms(9, 37));
});
check('sorts trips by first departure', () => {
  const rail = data.routes.find((r) => r.n === 'R');
  const deps = rail.trips.map((tr) => tr[1]);
  assert.deepEqual(deps, [...deps].sort((a, b) => a - b));
});
check('refuses a date with no service (Thanksgiving)', () => {
  const r = build(['--date', '2026-11-26'], join(dir, 'none.json'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No service runs on/);
});
check('--no-bus removes the bus route and its stations', () => {
  const out = join(dir, 'nobus.json');
  assert.equal(build(['--date', '2026-11-18', '--no-bus'], out).status, 0);
  const d = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(d.routes.length, 2);
  assert.equal(d.stops.length, 5);
});

// ---- routing -----------------------------------------------------------------------
const net = buildNetwork(data);
const origin = { lat: 42.3, lng: -71.20608 }; // about 500 m west of A
const A = idx('A'), B = idx('B'), C = idx('C'), D = idx('D'), E = idx('E'), F = idx('F'), G = idx('G');
const walkToA = walkSeconds(distMeters(origin.lat, origin.lng, data.stops[A][0], data.stops[A][1]));
const sourcesAt = (depart) => data.stops
  .map((s, stop) => ({ stop, d: distMeters(origin.lat, origin.lng, s[0], s[1]) }))
  .filter((x) => x.d <= 928)
  .map((x) => ({ stop: x.stop, time: depart + walkSeconds(x.d) }));

console.log('routing');
check('walk to A takes about 8 minutes', () => assert.ok(walkToA > 450 && walkToA < 520, String(walkToA)));

check('leave 8:20: catch the 8:30 train, reach B 8:36, C 8:43, D 8:50', () => {
  const a = runRaptor(net, sourcesAt(hms(8, 20)), hms(9, 20));
  assert.equal(a[B], hms(8, 36));
  assert.equal(a[C], hms(8, 43));
  assert.equal(a[D], hms(8, 50));
});
check('transfer at C: 8:43 arrival + 1 min buffer catches the 8:44 subway, E at 8:50', () => {
  const a = runRaptor(net, sourcesAt(hms(8, 20)), hms(9, 20));
  assert.equal(a[E], hms(8, 50));
});
check('walking transfer D -> F (200 m), then the bus: G at 9:00', () => {
  const a = runRaptor(net, sourcesAt(hms(8, 20)), hms(9, 20));
  const walkDF = walkSeconds(distMeters(...data.stops[D].slice(0, 2), ...data.stops[F].slice(0, 2)));
  assert.ok(Math.abs(a[F] - (hms(8, 50) + walkDF)) < 1e-6);
  assert.equal(a[G], hms(9, 0));
});
check('leave 8:31: just miss the 8:30 train and wait for 9:00 (B 9:06, D 9:20)', () => {
  const a = runRaptor(net, sourcesAt(hms(8, 31)), hms(10, 0));
  assert.equal(a[B], hms(9, 6));
  assert.equal(a[D], hms(9, 20));
  assert.equal(a[E], hms(9, 20)); // 9:13 + 1 min buffer catches the 9:14 subway
  assert.equal(a[G], hms(9, 30)); // second bus
});
check('one round only (no transfers): C reachable, E not', () => {
  const a = runRaptor(net, sourcesAt(hms(8, 20)), hms(9, 20), { maxRounds: 1 });
  assert.equal(a[C], hms(8, 43));
  assert.equal(a[E], Infinity);
});
check('30-minute budget from 8:20 ends at 8:50: D and E just make it, G does not', () => {
  const a = runRaptor(net, sourcesAt(hms(8, 20)), hms(8, 50));
  assert.equal(a[D], hms(8, 50));
  assert.equal(a[E], hms(8, 50));
  assert.equal(a[G], Infinity);
});
check('transfer buffer matters: with 61 s the 8:43 arrival misses the 8:44 subway (E at 9:20)', () => {
  const a = runRaptor(net, sourcesAt(hms(8, 20)), hms(9, 30), { transferBuffer: 61 });
  assert.equal(a[E], hms(9, 20));
});
check('transfer buffer matters: with 0 s it still catches the 8:44 subway (E at 8:50)', () => {
  const a = runRaptor(net, sourcesAt(hms(8, 20)), hms(9, 30), { transferBuffer: 0 });
  assert.equal(a[E], hms(8, 50));
});

// ---- shape ---------------------------------------------------------------------------
console.log('shape');
const fc = computeTransitIsochrone(data, net, { lng: origin.lng, lat: origin.lat }, 40, hms(8, 20));
const shape = fc.features[0];
const offset = (lng, lat, dxMeters, dyMeters) => [
  lng + dxMeters / (111320 * Math.cos((lat * Math.PI) / 180)),
  lat + dyMeters / 111195,
];
const inside = (p) => booleanPointInPolygon(point(p), shape);
check('returns a polygon with a description of the method', () => {
  assert.match(shape.geometry.type, /Polygon/);
  assert.match(shape.properties.note, /timetable for 2026-11-18, leaving 8:20 AM/);
});
check('covers the area near the origin (walk-only)', () => assert.ok(inside(offset(origin.lng, origin.lat, 0, -400))));
check('covers 1 km beyond B (reached with 24 min to spare)', () => assert.ok(inside(offset(-71.15, 42.3, 1000, 0))));
check('covers F, 200 m from D (D reached with 10 min to spare)', () => assert.ok(inside([-71.05, 42.3018])));
check('excludes 1 km east of D (only ~618 m of walking left there)', () => assert.ok(!inside(offset(-71.05, 42.3, 1000, 0))));
check('excludes a point 3 km north of B (no station nearby)', () => assert.ok(!inside(offset(-71.15, 42.3, 0, 3000))));

// ---- loader / fallback decisions -------------------------------------------------------
console.log('loader');
const freshLoader = (n) => import(`../src/transit/local.js?instance=${n}`);
const realFetch = globalThis.fetch;
const json = readFileSync(outFull, 'utf8');
try {
  globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(json) });
  const { localTransitIsochrone } = await freshLoader(1);
  const near = await localTransitIsochrone(origin, 40, hms(8, 20));
  check('returns a shape for an address inside the covered area', () => assert.ok(near?.features?.length === 1));
  const philly = await localTransitIsochrone({ lng: -75.1652, lat: 39.9526 }, 30, hms(8, 30));
  check('returns null (so the app falls back) for an address far outside the data', () => assert.equal(philly, null));

  // Vite serves index.html (HTTP 200, not JSON) for files that do not exist.
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const missing = await (await freshLoader(2)).localTransitIsochrone(origin, 40, hms(8, 20));
  check('returns null when the data file is missing or not JSON', () => assert.equal(missing, null));

  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const notFound = await (await freshLoader(3)).localTransitIsochrone(origin, 40, hms(8, 20));
  check('returns null on HTTP 404', () => assert.equal(notFound, null));
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${passed} checks passed`);
