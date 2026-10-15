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
export async function isochrone(mode, { lng, lat }, minutes) {
  if (mode === 'transit') {
    if (!env.VITE_TT_APP_ID) throw new Error('Add VITE_TT_APP_ID and VITE_TT_API_KEY for transit.');
    const res = await fetch('https://api.traveltimeapp.com/v4/time-map', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/geo+json',
        'X-Application-Id': env.VITE_TT_APP_ID,
        'X-Api-Key': env.VITE_TT_API_KEY,
      },
      body: JSON.stringify({
        departure_searches: [{
          id: 'origin',
          coords: { lat, lng },
          departure_time: nextWeekdayMorning(),
          travel_time: minutes * 60,
          transportation: { type: 'public_transport' },
        }],
      }),
    });
    if (!res.ok) throw new Error(`TravelTime error ${res.status}`);
    return res.json();
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

// Transit depends on schedules, so use a realistic commute time: next weekday, 8:30 AM local.
function nextWeekdayMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  d.setHours(8, 30, 0, 0);
  return d.toISOString();
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
