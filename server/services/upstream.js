/**
 * Optional upstream services (OSRM + Nominatim).
 *
 * These are treated as a bonus, never a dependency. Every call is time-boxed
 * and guarded by a circuit breaker, so a slow or blocked upstream costs one
 * timeout and then gets skipped entirely until it recovers.
 */

import { config } from '../config.js';
import { log } from '../logger.js';
import { cacheGet, cacheSet } from '../db/index.js';
import { inNigeria } from './geo.js';

const BREAKER_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 120_000;

const breakers = new Map();

function breaker(name) {
  if (!breakers.has(name)) breakers.set(name, { failures: 0, openUntil: 0, lastError: null, lastOk: null });
  return breakers.get(name);
}

function isOpen(name) {
  const b = breaker(name);
  if (b.openUntil > Date.now()) return true;
  if (b.openUntil && b.openUntil <= Date.now()) {
    b.openUntil = 0;
    b.failures = 0;
  }
  return false;
}

function recordFailure(name, error) {
  const b = breaker(name);
  b.failures += 1;
  b.lastError = error?.message ?? String(error);
  if (b.failures >= BREAKER_THRESHOLD) {
    b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    log.warn(`upstream ${name} disabled for ${BREAKER_COOLDOWN_MS / 1000}s`, { reason: b.lastError });
  }
}

function recordSuccess(name) {
  const b = breaker(name);
  b.failures = 0;
  b.openUntil = 0;
  b.lastOk = new Date().toISOString();
}

async function request(name, url) {
  if (!config.upstream.enabled) return null;
  if (isOpen(name)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstream.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': config.upstream.userAgent, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    recordSuccess(name);
    return json;
  } catch (error) {
    recordFailure(name, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Worldwide geocoding, biased to Nigeria. Returns `null` when unavailable. */
export async function geocode(query, { limit = 6 } = {}) {
  const key = `nominatim:search:${query.toLowerCase()}:${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${config.upstream.nominatim}/search?format=jsonv2&limit=${limit}&countrycodes=ng&addressdetails=1&q=${encodeURIComponent(
    query,
  )}`;
  const data = await request('nominatim', url);
  if (!Array.isArray(data)) return null;

  const results = data
    .map((item) => ({
      id: `osm_${item.osm_type ?? 'n'}${item.osm_id}`,
      name: item.name || item.display_name.split(',')[0],
      label: item.display_name,
      state: item.address?.state?.replace(/ State$/, '') ?? null,
      kind: item.type ?? 'place',
      lat: Number.parseFloat(item.lat),
      lon: Number.parseFloat(item.lon),
      source: 'osm',
    }))
    .filter((r) => Number.isFinite(r.lat) && inNigeria(r.lat, r.lon));

  cacheSet(key, results, 7 * 24 * 3600_000);
  return results;
}

export async function reverse(lat, lon) {
  const key = `nominatim:reverse:${lat.toFixed(4)}:${lon.toFixed(4)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${config.upstream.nominatim}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16`;
  const data = await request('nominatim', url);
  if (!data?.display_name) return null;

  const result = {
    label: data.display_name,
    name: data.name || data.address?.road || data.display_name.split(',')[0],
    road: data.address?.road ?? null,
    state: data.address?.state?.replace(/ State$/, '') ?? null,
    source: 'osm',
  };
  cacheSet(key, result, 30 * 24 * 3600_000);
  return result;
}

/**
 * Real road routing via OSRM.
 * @returns {{source:'osrm', routes:Array}|null}
 */
export async function osrmRoute(origin, destination, { alternatives = true } = {}) {
  const coords = `${origin[1]},${origin[0]};${destination[1]},${destination[0]}`;
  const key = `osrm:${coords}:${alternatives ? 1 : 0}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${config.upstream.osrm}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=${
    alternatives ? 'true' : 'false'
  }`;
  const data = await request('osrm', url);
  if (!data || data.code !== 'Ok' || !data.routes?.length) return null;

  const routes = data.routes.slice(0, 3).map((r, index) => ({
    label: index === 0 ? 'Recommended' : `Alternative ${index}`,
    distanceM: Math.round(r.distance),
    durationS: Math.round(r.duration),
    geometry: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    steps: (r.legs?.[0]?.steps ?? [])
      .filter((s) => s.distance > 150 || s.maneuver?.type === 'arrive')
      .map((s) => ({
        instruction: describeOsrmStep(s),
        name: s.name || null,
        ref: s.ref || null,
        class: s.mode ?? 'driving',
        distanceM: Math.round(s.distance),
        durationS: Math.round(s.duration),
        location: [s.maneuver.location[1], s.maneuver.location[0]],
      })),
    roads: [...new Set((r.legs?.[0]?.steps ?? []).filter((s) => s.distance > 3000 && s.name).map((s) => s.name))],
  }));

  const payload = { source: 'osrm', routes };
  cacheSet(key, payload, 6 * 3600_000);
  return payload;
}

function describeOsrmStep(step) {
  const road = step.name || step.ref || 'the road';
  const m = step.maneuver ?? {};
  const mod = m.modifier ? ` ${m.modifier}` : '';
  switch (m.type) {
    case 'depart':
      return `Head out on ${road}`;
    case 'arrive':
      return 'Arrive at your destination';
    case 'roundabout':
    case 'rotary':
      return `At the roundabout take exit ${m.exit ?? ''} onto ${road}`.replace('  ', ' ');
    case 'merge':
      return `Merge${mod} onto ${road}`;
    case 'fork':
      return `Keep${mod} at the fork onto ${road}`;
    case 'new name':
    case 'continue':
      return `Continue on ${road}`;
    default:
      return `Turn${mod} onto ${road}`;
  }
}

export function upstreamStatus() {
  const snapshot = (name, url) => {
    const b = breaker(name);
    return {
      url,
      enabled: config.upstream.enabled,
      available: config.upstream.enabled && !isOpen(name),
      failures: b.failures,
      lastError: b.lastError,
      lastSuccess: b.lastOk,
      retryAt: b.openUntil ? new Date(b.openUntil).toISOString() : null,
    };
  };
  return {
    osrm: snapshot('osrm', config.upstream.osrm),
    nominatim: snapshot('nominatim', config.upstream.nominatim),
  };
}

/** Test seam. */
export function _resetBreakers() {
  breakers.clear();
}
