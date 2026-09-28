/**
 * Route planning orchestration.
 *
 * Resolves what the user typed into coordinates, gets a line on the map from
 * whichever engine is available, then layers the community intelligence —
 * hazards, fuel, advisories — on top of it.
 */

import { bounds, padBounds, haversine, polylineLength, simplify } from './geo.js';
import { search as searchOffline, nearest, describe } from './gazetteer.js';
import { route as offlineRoute } from './graph.js';
import { geocode as geocodeUpstream, osrmRoute, upstreamStatus } from './upstream.js';
import { listReports } from './reports.js';
import { analyseRoute } from './hazards.js';
import { clusterStations, planFuel } from './fuel.js';
import { VEHICLES } from './taxonomy.js';
import { bump } from '../db/index.js';

/**
 * Turn `{q}` or `{lat, lon}` into a resolved endpoint.
 * Tries the offline gazetteer first (instant, always available) and only asks
 * Nominatim when the local index has nothing convincing.
 */
export async function resolveEndpoint(input, { near } = {}) {
  if (input == null) throw Object.assign(new Error('Missing location'), { status: 400 });

  if (Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lon))) {
    const lat = Number(input.lat);
    const lon = Number(input.lon);
    return {
      lat,
      lon,
      label: input.label || describe(lat, lon),
      source: 'coordinates',
    };
  }

  const q = String(input.q ?? input.query ?? '').trim();
  if (!q) throw Object.assign(new Error('Enter a place name or drop a pin'), { status: 400 });

  const local = searchOffline(q, { limit: 3, near });
  if (local.length && local[0].score >= 60) {
    return { lat: local[0].lat, lon: local[0].lon, label: local[0].label, source: 'gazetteer', placeId: local[0].id };
  }

  const remote = await geocodeUpstream(q, { limit: 3 });
  if (remote?.length) {
    return { lat: remote[0].lat, lon: remote[0].lon, label: remote[0].label, source: 'osm' };
  }

  if (local.length) {
    return { lat: local[0].lat, lon: local[0].lon, label: local[0].label, source: 'gazetteer', placeId: local[0].id };
  }

  throw Object.assign(new Error(`Could not find "${q}" in Nigeria. Try a nearby town, or drop a pin on the map.`), {
    status: 404,
  });
}

/**
 * @param {{from:object, to:object, vehicle?:string, departAt?:string|Date,
 *          tankPct?:number, alternatives?:boolean, corridorM?:number}} input
 */
export async function planRoute(input) {
  const [from, to] = await Promise.all([resolveEndpoint(input.from), resolveEndpoint(input.to)]);

  if (haversine([from.lat, from.lon], [to.lat, to.lon]) < 150) {
    throw Object.assign(new Error('Start and destination are basically the same place.'), { status: 400 });
  }

  const wantAlternatives = input.alternatives !== false;
  let engine = await osrmRoute([from.lat, from.lon], [to.lat, to.lon], { alternatives: wantAlternatives });
  if (!engine) {
    engine = offlineRoute([from.lat, from.lon], [to.lat, to.lon], {
      labels: { from: from.label, to: to.label },
      alternatives: wantAlternatives ? 1 : 0,
    });
  }
  if (!engine || !engine.routes?.length) {
    throw Object.assign(new Error('No drivable route found between those two points.'), { status: 422 });
  }

  const departAt = input.departAt ? new Date(input.departAt) : new Date();
  const vehicleId = VEHICLES[input.vehicle] ? input.vehicle : 'car';
  const vehicle = VEHICLES[vehicleId];

  // Pull every report anywhere near the widest route once, then let each
  // alternative filter it down.
  const allPoints = engine.routes.flatMap((r) => r.geometry);
  const box = padBounds(bounds(allPoints), 8000);
  const nearbyReports = listReports({ bbox: box, limit: 2000 });
  const stations = clusterStations(nearbyReports);

  const routes = engine.routes.map((r, index) => {
    const geometry = r.geometry;
    const distanceM = r.distanceM ?? Math.round(polylineLength(geometry));
    const durationS = Math.round((r.durationS ?? distanceM / 16) / (vehicle.speedFactor ?? 1));
    const analysis = analyseRoute(geometry, nearbyReports, {
      source: engine.source,
      durationS,
      departAt,
      corridorM: input.corridorM,
    });
    const fuel = planFuel({
      geometry,
      distanceM,
      stations,
      vehicle: vehicleId,
      tankPct: input.tankPct,
      corridorM: engine.source === 'offline' ? 6000 : 3000,
    });
    return {
      id: `route_${index}`,
      label: r.label ?? (index === 0 ? 'Recommended' : `Alternative ${index}`),
      distanceM,
      durationS,
      arrivalAt: new Date(departAt.getTime() + durationS * 1000).toISOString(),
      geometry: simplify(geometry, engine.source === 'offline' ? 25 : 45),
      steps: r.steps ?? [],
      roads: r.roads ?? [],
      safety: {
        score: analysis.score,
        grade: analysis.grade,
        gradeLabel: analysis.gradeLabel,
        tone: analysis.tone,
        hazardCount: analysis.hazardCount,
        byCategory: analysis.byCategory,
        corridorM: analysis.corridorM,
        worstStretch: analysis.worstStretch,
      },
      advisories: analysis.advisories,
      hazards: analysis.hazards.map((h) => ({
        id: h.id,
        type: h.type,
        typeLabel: h.typeLabel,
        category: h.category,
        severity: h.severity,
        confidence: h.confidence,
        lat: h.lat,
        lon: h.lon,
        label: h.label,
        note: h.note,
        road: h.road,
        place: h.place,
        colour: h.colour,
        icon: h.icon,
        offRouteM: h.offRouteM,
        alongM: h.alongM,
        alongPct: h.alongPct,
        etaFromStartS: h.etaFromStartS,
        ageMinutes: h.ageMinutes,
        confirms: h.confirms,
        disputes: h.disputes,
        createdAt: h.createdAt,
      })),
      fuel,
    };
  });

  routes.sort((a, b) => a.durationS - b.durationS);
  // Give the safest option a nod even when it is not the fastest.
  const safest = [...routes].sort((a, b) => b.safety.score - a.safety.score)[0];
  if (routes.length > 1 && safest.id !== routes[0].id && safest.safety.score - routes[0].safety.score >= 12) {
    safest.label = 'Safer option';
    safest.recommendedFor = 'safety';
  }

  bump('routes_planned');
  bump(`route_engine_${engine.source}`);

  return {
    from,
    to,
    departAt: departAt.toISOString(),
    vehicle: { id: vehicleId, ...vehicle },
    engine: engine.source,
    engineNote:
      engine.source === 'offline'
        ? 'Planned with the built-in Nigerian road graph — distances are close estimates, not surveyed road lengths.'
        : 'Planned with live OpenStreetMap road data.',
    routes,
    upstream: upstreamStatus(),
    generatedAt: new Date().toISOString(),
  };
}

/** Everything interesting within `radiusM` of a point — used by "around me". */
export function aroundPoint(lat, lon, radiusM = 25000) {
  const reports = listReports({ near: [lat, lon], radiusM, limit: 400 });
  const stations = clusterStations(reports);
  return {
    centre: { lat, lon, label: describe(lat, lon) },
    nearestPlaces: nearest(lat, lon, { limit: 5 }),
    reports,
    stations,
    fuel: marketSnapshot(stations),
  };
}

function marketSnapshot(stations) {
  const selling = stations.filter((s) => s.hasFuel);
  const priced = selling.filter((s) => s.price);
  return {
    stations: stations.length,
    selling: selling.length,
    dry: stations.length - selling.length,
    cheapest: priced.sort((a, b) => a.price - b.price)[0] ?? null,
  };
}
