import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { booleanPointInPolygon, point, bbox, featureCollection } from '@turf/turf';
import { geocode, isochrone, fetchListings } from './api.js';

const MODES = {
  drive:   { label: 'Drive',   color: '#d9480f', min: 20, on: true },
  walk:    { label: 'Walk',    color: '#2b8a3e', min: 15, on: false },
  bike:    { label: 'Bike',    color: '#1971c2', min: 20, on: false },
  transit: { label: 'Transit', color: '#7048e8', min: 30, on: false },
};
const $ = (id) => document.getElementById(id);
const status = (msg) => ($('status').textContent = msg);

let origin = null;
const isos = {};      // mode -> FeatureCollection
let listings = [];

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [-75.1652, 39.9526], zoom: 10,
});
const marker = new maplibregl.Marker({ color: '#1d2a2a' });

// --- sidebar controls
for (const [key, m] of Object.entries(MODES)) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label><input type="checkbox" ${m.on ? 'checked' : ''} data-on="${key}">
    <span class="swatch" style="background:${m.color}"></span>${m.label}</label>
    <input type="number" min="5" max="120" step="5" value="${m.min}" data-min="${key}" aria-label="${m.label} minutes">`;
  $('modes').append(row);
}
$('modes').addEventListener('change', (e) => {
  const { on, min } = e.target.dataset;
  if (on) MODES[on].on = e.target.checked;
  if (min) MODES[min].min = +e.target.value;
  refresh();
});
$('go').onclick = search;
$('addr').onkeydown = (e) => e.key === 'Enter' && search();
['listOn', 'kind'].forEach((id) => ($(id).onchange = refresh));
['maxPrice', 'minBeds'].forEach((id) => ($(id).oninput = renderListings));

async function search() {
  try {
    status('Finding address…');
    origin = await geocode($('addr').value);
    marker.setLngLat([origin.lng, origin.lat]).addTo(map);
    map.flyTo({ center: [origin.lng, origin.lat], zoom: 11 });
    await refresh();
  } catch (e) { status(e.message); }
}

// --- map layers
map.on('load', () => {
  for (const [key, m] of Object.entries(MODES)) {
    map.addSource(`iso-${key}`, { type: 'geojson', data: featureCollection([]) });
    map.addLayer({ id: `iso-fill-${key}`, type: 'fill', source: `iso-${key}`, paint: { 'fill-color': m.color, 'fill-opacity': 0.18 } });
    map.addLayer({ id: `iso-line-${key}`, type: 'line', source: `iso-${key}`, paint: { 'line-color': m.color, 'line-width': 2 } });
  }
  map.addSource('listings', { type: 'geojson', data: featureCollection([]) });
  map.addLayer({ id: 'listings', type: 'circle', source: 'listings',
    paint: { 'circle-radius': 6, 'circle-color': '#1d2a2a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.on('click', 'listings', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup().setLngLat(e.lngLat)
      .setHTML(`<strong>$${(+p.price).toLocaleString()}</strong> · ${p.beds} bd<br>${p.address}`).addTo(map);
  });
  map.on('mouseenter', 'listings', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'listings', () => (map.getCanvas().style.cursor = ''));
});

// --- data refresh
async function refresh() {
  if (!origin || !map.isStyleLoaded()) return;
  const active = Object.keys(MODES).filter((k) => MODES[k].on);
  const errors = [];
  status('Loading areas…');
  await Promise.all(Object.keys(MODES).map(async (k) => {
    if (!MODES[k].on) { isos[k] = null; map.getSource(`iso-${k}`).setData(featureCollection([])); return; }
    try {
      isos[k] = await isochrone(k, origin, MODES[k].min);
      map.getSource(`iso-${k}`).setData(isos[k]);
    } catch (e) { isos[k] = null; errors.push(`${MODES[k].label}: ${e.message}`); }
  }));

  const shapes = active.map((k) => isos[k]).filter(Boolean);
  if (shapes.length) {
    const b = bbox(featureCollection(shapes.flatMap((s) => s.features)));
    map.fitBounds(b, { padding: 60, maxZoom: 13 });
  }

  listings = [];
  if ($('listOn').checked && shapes.length) {
    try {
      const [w, s, e, n] = bbox(featureCollection(shapes.flatMap((sh) => sh.features)));
      const radius = Math.max(((n - s) * 69) / 2, ((e - w) * 53) / 2);   // rough miles
      listings = await fetchListings($('kind').value, { lng: (w + e) / 2, lat: (s + n) / 2 }, radius);
    } catch (e) { errors.push(`Listings: ${e.message}`); }
  }
  renderListings(errors);
}

// A listing shows only if it is inside EVERY active area (the overlap).
function renderListings(errors = []) {
  const shapes = Object.keys(MODES).filter((k) => MODES[k].on && isos[k]).map((k) => isos[k]);
  const maxP = +$('maxPrice').value || Infinity, minB = +$('minBeds').value || 0;
  const hits = shapes.length ? listings.filter((l) => {
    if (l.price > maxP || l.beds < minB) return false;
    const pt = point([l.lng, l.lat]);
    return shapes.every((s) => s.features.some((f) => booleanPointInPolygon(pt, f)));
  }) : [];
  map.getSource('listings')?.setData(featureCollection(hits.map((l) => point([l.lng, l.lat], l))));
  const msg = errors.length ? errors.join(' ') : '';
  status(`${$('listOn').checked ? `${hits.length} listings in the area. ` : ''}${msg}`);
}
