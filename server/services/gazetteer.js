/**
 * Offline place search over the bundled Nigerian gazetteer.
 *
 * Handles the messy way people actually type place names: partial words,
 * missing hyphens, "ph" for Port Harcourt, "lag" for Lagos, and typos
 * (via a bounded Levenshtein distance).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { haversine } from './geo.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'data');

const raw = JSON.parse(readFileSync(join(dataDir, 'places.json'), 'utf8'));

/** @type {Array<{id:string,name:string,state:string,kind:string,lat:number,lon:number,aliases:string[]}>} */
export const places = raw.places.map((p) => ({ ...p, aliases: p.aliases ?? [] }));

export const placesById = new Map(places.map((p) => [p.id, p]));

export const states = [...new Set(places.map((p) => p.state))].sort();

const KIND_BOOST = {
  capital: 30,
  city: 22,
  airport: 18,
  district: 12,
  junction: 10,
  town: 8,
  border: 6,
};

const normalise = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Levenshtein distance with early exit once we exceed `max`. */
export function editDistance(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

const searchIndex = places.map((place) => ({
  place,
  terms: [normalise(place.name), ...place.aliases.map(normalise), normalise(`${place.name} ${place.state}`)],
  head: normalise(place.name),
  state: normalise(place.state),
}));

function scoreEntry(entry, query) {
  let best = 0;
  for (const term of entry.terms) {
    if (!term) continue;
    let score = 0;
    if (term === query) score = 100;
    else if (term.startsWith(query)) score = 84 - Math.min(20, term.length - query.length);
    else if (term.includes(query)) score = 62 - Math.min(20, term.length - query.length);
    else if (query.length >= 4) {
      const d = editDistance(query, term, 2);
      if (d <= 2) score = 52 - d * 12;
      else {
        // typo tolerance on the first word only ("ibadam" -> "ibadan")
        const firstWord = term.split(' ')[0];
        const dd = editDistance(query, firstWord, 2);
        if (dd <= 2) score = 46 - dd * 12;
      }
    }
    if (score > best) best = score;
  }
  if (!best && entry.state.startsWith(query) && query.length >= 3) best = 34;
  if (!best) return 0;
  return best + (KIND_BOOST[entry.place.kind] ?? 0) / 4;
}

/**
 * Search the gazetteer.
 * @param {string} query
 * @param {{limit?:number, near?:[number,number]}} [options]
 */
export function search(query, options = {}) {
  const { limit = 8, near } = options;
  const q = normalise(query);
  if (!q) return [];

  // "ikeja, lagos" — use the trailing part as a state/area filter.
  const parts = q.split(/\s*,\s*|\s+in\s+/).filter(Boolean);
  const head = parts[0];
  const qualifier = parts.length > 1 ? parts[parts.length - 1] : null;

  const results = [];
  for (const entry of searchIndex) {
    let score = scoreEntry(entry, head);
    if (!score) continue;
    if (qualifier) {
      if (entry.state.includes(qualifier) || entry.terms.some((t) => t.includes(qualifier))) score += 25;
      else score -= 12;
    }
    if (near) {
      const km = haversine(near, [entry.place.lat, entry.place.lon]) / 1000;
      score += Math.max(0, 14 - km / 25);
    }
    results.push({ score, place: entry.place });
  }

  results.sort((a, b) => b.score - a.score || a.place.name.localeCompare(b.place.name));
  return results.slice(0, limit).map(({ place, score }) => ({
    id: place.id,
    name: place.name,
    state: place.state,
    kind: place.kind,
    lat: place.lat,
    lon: place.lon,
    label: `${place.name}, ${place.state}${place.state === 'FCT' ? '' : ' State'}`,
    score: Math.round(score),
    source: 'offline',
  }));
}

/** Nearest known place to a coordinate — used for reverse geocoding. */
export function nearest(lat, lon, { limit = 1 } = {}) {
  const scored = places
    .map((place) => ({ place, distance: haversine([lat, lon], [place.lat, place.lon]) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
  return scored.map(({ place, distance }) => ({
    id: place.id,
    name: place.name,
    state: place.state,
    kind: place.kind,
    lat: place.lat,
    lon: place.lon,
    label: `${place.name}, ${place.state}${place.state === 'FCT' ? '' : ' State'}`,
    distanceM: Math.round(distance),
    source: 'offline',
  }));
}

/** Free-text describing where a coordinate is, e.g. "12 km NW of Lokoja". */
export function describe(lat, lon) {
  const [hit] = nearest(lat, lon, { limit: 1 });
  if (!hit) return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  if (hit.distanceM < 2500) return `${hit.name}, ${hit.state}`;
  return `${Math.round(hit.distanceM / 1000)} km from ${hit.name}, ${hit.state}`;
}

export const gazetteerMeta = {
  version: raw.meta?.version ?? 1,
  placeCount: places.length,
  stateCount: states.length,
};
