// Local (free, schedule-based) transit isochrones built from a baked GTFS file.
//
// How the shape is made:
//   1. Walk from the address to every station within MAX_ACCESS_MIN minutes.
//   2. Run RAPTOR from your departure time to find the earliest arrival at every station.
//   3. At each station you reach with time to spare, draw a circle of however far you could
//      still walk, then merge all the circles (plus the walk-only area around the address).
//
// Walking is estimated from straight-line distance x 1.3 at 3 mph, not from the street network,
// so the edges are approximate. The transit part uses the real timetable.

import { circle, union, featureCollection } from '@turf/turf';
import { buildNetwork, runRaptor, distMeters, walkSeconds, walkReach } from './raptor.js';

const MAX_ACCESS_MIN = 15; // longest walk from the address to a station
const MAX_EGRESS_MIN = 20; // longest walk from the last station to the destination
const MIN_LEFTOVER_SEC = 120; // ignore stations reached with under 2 minutes to spare
const CELL_METERS = 150; // keep one circle per ~150 m cell so thousands of bus stops stay fast

const fmtClock = (sec) => {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

const MODE_NAMES = { 0: 'light rail', 1: 'subway', 2: 'commuter rail', 3: 'bus', 4: 'ferry' };

// Merges polygons in small groups, then merges the results, repeating until one is left.
// Merging hundreds of circles in one call took 4+ seconds in testing; this takes about half a second.
function mergeShapes(list, groupSize = 4) {
  let layer = list;
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += groupSize) {
      const group = layer.slice(i, i + groupSize);
      next.push(group.length === 1 ? group[0] : union(featureCollection(group)));
    }
    layer = next;
  }
  return layer[0];
}

// Pure: data + network in, GeoJSON out. Kept separate from loading so tests can call it directly.
export function computeTransitIsochrone(data, net, { lng, lat }, minutes, departSeconds) {
  const maxTime = departSeconds + minutes * 60;

  const accessMeters = walkReach(MAX_ACCESS_MIN * 60);
  const sources = [];
  data.stops.forEach((s, stop) => {
    const d = distMeters(lat, lng, s[0], s[1]);
    if (d <= accessMeters) sources.push({ stop, time: departSeconds + walkSeconds(d) });
  });

  const arrival = runRaptor(net, sources, maxTime);

  const circles = [circle([lng, lat], walkReach(minutes * 60), { steps: 32, units: 'meters' })];
  const kept = new Map(); // grid cell -> best station in that cell
  const latStep = CELL_METERS / 111320;
  arrival.forEach((t, stop) => {
    if (!Number.isFinite(t)) return;
    const leftover = Math.min(maxTime - t, MAX_EGRESS_MIN * 60);
    if (leftover < MIN_LEFTOVER_SEC) return;
    const [slat, slon] = data.stops[stop];
    const lonStep = latStep / Math.cos((slat * Math.PI) / 180);
    const key = `${Math.floor(slat / latStep)},${Math.floor(slon / lonStep)}`;
    const old = kept.get(key);
    if (!old || leftover > old.leftover) kept.set(key, { slat, slon, leftover });
  });
  // Order circles west->east inside ~2 km north-south strips (alternating direction) so that
  // neighbours in the list are neighbours on the map; merging those together is much cheaper.
  const BAND = 0.02;
  const ordered = [...kept.values()].sort((a, b) => {
    const ba = Math.floor(a.slat / BAND), bb = Math.floor(b.slat / BAND);
    if (ba !== bb) return ba - bb;
    return ba % 2 ? b.slon - a.slon : a.slon - b.slon;
  });
  for (const { slat, slon, leftover } of ordered) {
    circles.push(circle([slon, slat], walkReach(leftover), { steps: 16, units: 'meters' }));
  }

  const shape = mergeShapes(circles);
  const stationsReached = arrival.reduce((n, t) => n + (Number.isFinite(t) ? 1 : 0), 0);
  const modes = (data.meta.modes ?? []).map((m) => MODE_NAMES[m]).filter(Boolean).join(', ');
  shape.properties = {
    mode: 'transit',
    source: `${data.meta.agency} schedule`,
    stationsReached,
    note: `Transit: ${data.meta.agency} timetable for ${data.meta.serviceDate}, leaving ${fmtClock(departSeconds)} (${modes}). Walking legs are estimated.`,
  };
  return featureCollection([shape]);
}

// ---- browser side: load the baked file once, then answer queries ----
const DATA_URL = 'gtfs/mbta.json';
let loading = null;

function load() {
  if (!loading) {
    const base = import.meta.env?.BASE_URL ?? './';
    loading = fetch(`${base}${DATA_URL}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data?.stops && data?.routes ? { data, net: buildNetwork(data) } : null))
      .catch(() => null); // file missing or not JSON (Vite serves index.html for unknown paths)
  }
  return loading;
}

function covers(data, lng, lat) {
  const [w, s, e, n] = data.meta.bbox;
  const pad = 0.03; // about 3 km, so an address just outside the last station still counts
  return lng >= w - pad && lng <= e + pad && lat >= s - pad && lat <= n + pad;
}

// Returns a FeatureCollection, or null if no baked data exists or the address is outside it.
export async function localTransitIsochrone({ lng, lat }, minutes, departSeconds) {
  const loaded = await load();
  if (!loaded || !covers(loaded.data, lng, lat)) return null;
  return computeTransitIsochrone(loaded.data, loaded.net, { lng, lat }, minutes, departSeconds);
}
