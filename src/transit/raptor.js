// Schedule-based transit routing using RAPTOR (Round-bAsed Public Transit Optimized Router).
//
// Given a departure time and the stations you can walk to, it finds the earliest time you
// can arrive at every other station using the real timetable. Round k = trips using at most
// k vehicles, so round 1 is "no transfers", round 2 is "one transfer", and so on.
//
// Pure functions only (no DOM, no map), so it runs the same in the browser and in Node tests.

export const WALK_SPEED = 1.34; // metres/second (about 3 mph)
export const CIRCUITY = 1.3; // real walking routes are longer than straight lines

export function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Straight-line metres -> estimated walking seconds (applies the circuity factor).
export const walkSeconds = (straightMeters) => (straightMeters * CIRCUITY) / WALK_SPEED;
// Walking seconds -> straight-line metres you can cover.
export const walkReach = (seconds) => (seconds * WALK_SPEED) / CIRCUITY;

// Prepares the baked data for fast lookups: which routes serve each stop, and which
// stops are close enough to walk between.
export function buildNetwork(data, { transferRadius = 300 } = {}) {
  const { stops, routes } = data;
  const stopRoutes = stops.map(() => []);
  routes.forEach((route, r) => route.s.forEach((p, i) => stopRoutes[p].push([r, i])));

  const cell = 0.005; // degrees; wider than transferRadius even at US latitudes
  const grid = new Map();
  stops.forEach((s, p) => {
    const key = `${Math.floor(s[0] / cell)},${Math.floor(s[1] / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  });
  const transfers = stops.map(() => []);
  stops.forEach((s, p) => {
    const cy = Math.floor(s[0] / cell), cx = Math.floor(s[1] / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const q of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          if (q === p) continue;
          const d = distMeters(s[0], s[1], stops[q][0], stops[q][1]);
          if (d <= transferRadius) transfers[p].push([q, walkSeconds(d)]);
        }
      }
    }
  });
  return { stops, routes, stopRoutes, transfers, stopGrid: { grid, cell } };
}

// Index of the first trip on `route` that departs stop position `i` at or after time `t`
// (-1 if none). Trips are sorted by departure, and this assumes trips on a pattern don't overtake.
function earliestTrip(route, i, t) {
  const trips = route.trips;
  let lo = 0, hi = trips.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trips[mid][2 * i + 1] >= t) hi = mid;
    else lo = mid + 1;
  }
  return lo < trips.length ? lo : -1;
}

// sources: [{ stop, time }] = stations you can walk to from the origin and when you'd get there.
// Returns a Float64Array of the earliest arrival time (seconds) at each stop; Infinity = unreachable.
export function runRaptor(net, sources, maxTime, { maxRounds = 5, transferBuffer = 60 } = {}) {
  const n = net.stops.length;
  const best = new Float64Array(n).fill(Infinity);
  let prev = new Float64Array(n).fill(Infinity);
  let marked = new Set();

  for (const { stop, time } of sources) {
    if (time <= maxTime && time < best[stop]) {
      best[stop] = prev[stop] = time;
      marked.add(stop);
    }
  }

  for (let k = 1; k <= maxRounds && marked.size; k++) {
    const cur = prev.slice();

    // For each route, only scan from the earliest stop where we have a new arrival.
    const queue = new Map();
    for (const p of marked) {
      for (const [r, i] of net.stopRoutes[p]) {
        const existing = queue.get(r);
        if (existing === undefined || i < existing) queue.set(r, i);
      }
    }
    const improved = new Set();

    for (const [r, start] of queue) {
      const route = net.routes[r];
      let trip = null;
      for (let i = start; i < route.s.length; i++) {
        const p = route.s[i];
        if (trip) {
          const arrival = trip[2 * i];
          if (arrival < best[p] && arrival <= maxTime) {
            cur[p] = best[p] = arrival;
            improved.add(p);
          }
        }
        if (prev[p] < Infinity) {
          // Changing vehicles takes a minute; boarding straight after the walk from the origin doesn't.
          const ready = prev[p] + (k >= 2 ? transferBuffer : 0);
          if (!trip || ready <= trip[2 * i + 1]) {
            const ti = earliestTrip(route, i, ready);
            if (ti >= 0) trip = route.trips[ti];
          }
        }
      }
    }

    // Walking transfers between nearby stations (one walk, not chained).
    for (const p of [...improved]) {
      for (const [q, secs] of net.transfers[p]) {
        const t = cur[p] + secs;
        if (t < best[q] && t <= maxTime) {
          cur[q] = best[q] = t;
          improved.add(q);
        }
      }
    }

    prev = cur;
    marked = improved;
  }
  return best;
}
