import { localTransitIsochrone } from './transit/local.js';

const env = import.meta.env;

// Address -> [lng, lat]. Nominatim is fine for light personal use (1 req/sec policy).
export async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  const [hit] = await res.json();
  if (!hit) throw new Error('Address not found. Try adding city and state.');
  return { lng: +hit.lon, lat: +hit.lat, label: hit.display_name };
}

const ORS_PROFILE = { drive: 'driving-car', walk: 'foot-walking', bike: 'cycling-regular' };

// Returns a GeoJSON FeatureCollection of polygons reachable within `minutes`.
// `departSeconds` (seconds after midnight) only matters for transit, which depends on the timetable.
export async function isochrone(mode, { lng, lat }, minutes, departSeconds = 8.5 * 3600) {
  if (mode === 'transit') {
    // Prefer the baked local timetable (real schedules, free). Fall back to Geoapify's
    // estimate for addresses outside any region we have data for, or if the data isn't built.
    const local = await localTransitIsochrone({ lng, lat }, minutes, departSeconds);
    if (local) return local;
    const fallback = await geoapifyTransitIsoline({ lng, lat }, minutes);
    if (fallback.features[0]) {
      fallback.features[0].properties = {
        ...fallback.features[0].properties,
        note: 'Transit: Geoapify estimate (no local timetable for this area), so rail frequency may be undercounted.',
      };
    }
    return fallback;
  }
  if (!env.VITE_ORS_KEY) throw new Error('Add VITE_ORS_KEY for driving, walking and cycling.');
  const res = await fetch(`https://api.openrouteservice.org/v2/isochrones/${ORS_PROFILE[mode]}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: env.VITE_ORS_KEY },
    body: JSON.stringify({ locations: [[lng, lat]], range: [minutes * 60] }),
  });
  if (!res.ok) throw new Error(`openrouteservice error ${res.status}`);
  return res.json();
}

// Geoapify's isoline API covers transit, which openrouteservice doesn't. It tries real
// schedule-based `transit` first, falling back to `approximated_transit` if that mode
// isn't available for this location (Geoapify doesn't document exactly where each applies).
// Slow requests come back as HTTP 202 with an id to poll until the result is ready.
async function geoapifyTransitIsoline({ lng, lat }, minutes) {
  if (!env.VITE_GEOAPIFY_KEY) throw new Error('Add VITE_GEOAPIFY_KEY for transit.');
  try {
    return await requestGeoapifyIsoline('transit', { lng, lat }, minutes);
  } catch (e) {
    return await requestGeoapifyIsoline('approximated_transit', { lng, lat }, minutes);
  }
}

async function requestGeoapifyIsoline(geoapifyMode, { lng, lat }, minutes) {
  const base = 'https://api.geoapify.com/v1/isoline';
  const params = `lat=${lat}&lon=${lng}&type=time&mode=${geoapifyMode}&range=${minutes * 60}&apiKey=${env.VITE_GEOAPIFY_KEY}`;
  let res = await fetch(`${base}?${params}`);
  if (!res.ok) throw new Error(`Geoapify error ${res.status}`);
  let data = await res.json();

  // 202 means the calculation is still running; poll by id until it's ready.
  for (let attempt = 0; res.status === 202 && attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await fetch(`${base}?id=${data.properties?.id}&apiKey=${env.VITE_GEOAPIFY_KEY}`);
    if (!res.ok) throw new Error(`Geoapify error ${res.status}`);
    data = await res.json();
  }
  if (res.status === 202) throw new Error('Geoapify transit isoline timed out');
  if (!data.features?.length) throw new Error(`No transit data from Geoapify (${geoapifyMode})`);
  return data;
}

// Listings normalized to { id, address, price, beds, lng, lat }.
export async function fetchListings(kind, { lng, lat }, radiusMiles) {
  if (!env.VITE_RENTCAST_KEY) return mockListings(kind, { lng, lat }, radiusMiles);
  const path = kind === 'rent' ? 'rental/long-term' : 'sale';
  const url = `https://api.rentcast.io/v1/listings/${path}?latitude=${lat}&longitude=${lng}&radius=${Math.min(radiusMiles, 100)}&status=Active&limit=500`;
  const res = await fetch(url, { headers: { 'X-Api-Key': env.VITE_RENTCAST_KEY } });
  if (!res.ok) throw new Error(`RentCast error ${res.status}`);
  return (await res.json()).map((l) => ({
    id: l.id, address: l.formattedAddress, price: l.price, beds: l.bedrooms ?? 0, lng: l.longitude, lat: l.latitude,
  }));
}

// Placeholder data so the whole flow works before you have a listings API key.
function mockListings(kind, { lng, lat }, radiusMiles) {
  const spread = radiusMiles / 69;
  return Array.from({ length: 150 }, (_, i) => ({
    id: `mock-${i}`,
    address: `Sample listing ${i + 1}`,
    price: kind === 'rent' ? 900 + Math.round(Math.random() * 2600) : 150000 + Math.round(Math.random() * 650000),
    beds: Math.floor(Math.random() * 5),
    lng: lng + (Math.random() - 0.5) * 2 * spread,
    lat: lat + (Math.random() - 0.5) * 2 * spread,
  }));
}
