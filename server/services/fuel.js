/**
 * Fuel intelligence.
 *
 * Nigerian fuel supply is the second thing every driver thinks about after
 * "is the road bad". This module clusters fuel reports into stations, tracks
 * the freshest price, and plans where to stop so you do not end up pushing a
 * car on the Lokoja–Abuja road at midnight.
 */

import { haversine, pointToPolyline } from './geo.js';
import { VEHICLES, DEFAULT_FUEL_PRICE } from './taxonomy.js';

const CLUSTER_RADIUS_M = 220;

/**
 * Collapse individual fuel reports into station records.
 * @param {Array<object>} reports
 */
export function clusterStations(reports) {
  const fuelReports = reports
    .filter((r) => r.category === 'fuel')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const stations = [];
  for (const report of fuelReports) {
    const existing = stations.find((s) => haversine([s.lat, s.lon], [report.lat, report.lon]) < CLUSTER_RADIUS_M);
    const price = Number(report.meta?.price) || null;
    if (existing) {
      existing.reports.push(report);
      if (price && !existing.price) {
        existing.price = price;
        existing.priceAt = report.createdAt;
      }
      if (!existing.brand && report.meta?.brand) existing.brand = report.meta.brand;
      continue;
    }
    stations.push({
      id: `s_${report.id}`,
      lat: report.lat,
      lon: report.lon,
      name: report.label || report.meta?.brand || 'Filling station',
      brand: report.meta?.brand ?? null,
      hasFuel: report.type === 'fuel_available',
      product: report.meta?.product ?? 'petrol',
      queue: report.meta?.queue ?? null,
      price,
      priceAt: price ? report.createdAt : null,
      place: report.place,
      state: report.state,
      updatedAt: report.createdAt,
      confidence: report.confidence,
      reports: [report],
    });
  }

  return stations.map((s) => ({
    ...s,
    reportCount: s.reports.length,
    reports: undefined,
    lastStatus: s.hasFuel ? 'selling' : 'dry',
  }));
}

/** Median of the freshest reported prices — resistant to one wild entry. */
export function marketPrice(stations) {
  const prices = stations.map((s) => s.price).filter((p) => Number.isFinite(p) && p > 100 && p < 5000);
  if (!prices.length) return { price: DEFAULT_FUEL_PRICE, source: 'default', samples: 0 };
  prices.sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const price = prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);
  return { price, source: 'community', samples: prices.length };
}

/**
 * Work out where to refuel along a route.
 *
 * @param {{geometry:Array<[number,number]>, distanceM:number, stations:Array<object>,
 *          vehicle?:string, tankPct?:number, corridorM?:number}} input
 */
export function planFuel(input) {
  const vehicle = VEHICLES[input.vehicle] ?? VEHICLES.car;
  const tankPct = Math.max(0.05, Math.min(1, input.tankPct ?? 0.5));
  const corridorM = input.corridorM ?? 4000;
  const tripKm = input.distanceM / 1000;

  const onRoute = [];
  for (const station of input.stations) {
    const hit = pointToPolyline([station.lat, station.lon], input.geometry);
    if (hit.distance > corridorM) continue;
    onRoute.push({ ...station, offRouteM: Math.round(hit.distance), alongKm: Math.round(hit.along / 1000) });
  }
  onRoute.sort((a, b) => a.alongKm - b.alongKm);

  const selling = onRoute.filter((s) => s.hasFuel);
  const market = marketPrice(onRoute.length ? onRoute : input.stations);

  const rangeKm = vehicle.tankLitres * vehicle.consumptionKmPerLitre * tankPct;
  const reserveKm = Math.max(25, vehicle.consumptionKmPerLitre * 4);
  const usableRange = Math.max(20, rangeKm - reserveKm);

  const stops = [];
  let cursorKm = 0;
  let remaining = usableRange;
  let guard = 0;
  while (cursorKm + remaining < tripKm && guard < 12) {
    guard += 1;
    const reachable = selling.filter((s) => s.alongKm > cursorKm + 5 && s.alongKm <= cursorKm + remaining);
    if (!reachable.length) {
      stops.push({
        kind: 'gap',
        fromKm: Math.round(cursorKm),
        toKm: Math.round(Math.min(tripKm, cursorKm + remaining)),
        message: 'No station with confirmed fuel reported in range — top up before this stretch.',
      });
      cursorKm += remaining;
      remaining = vehicle.tankLitres * vehicle.consumptionKmPerLitre - reserveKm;
      continue;
    }
    // Prefer the furthest reachable station, but take a cheaper one that is
    // within 40 km of it.
    reachable.sort((a, b) => b.alongKm - a.alongKm);
    const furthest = reachable[0];
    const candidates = reachable.filter((s) => s.alongKm >= furthest.alongKm - 40);
    const pick = candidates.sort((a, b) => (a.price ?? market.price) - (b.price ?? market.price))[0];
    stops.push({
      kind: 'stop',
      station: pick,
      atKm: pick.alongKm,
      price: pick.price ?? market.price,
      priceKnown: Boolean(pick.price),
    });
    cursorKm = pick.alongKm;
    remaining = vehicle.tankLitres * vehicle.consumptionKmPerLitre - reserveKm;
  }

  const litres = tripKm / vehicle.consumptionKmPerLitre;
  return {
    vehicle: { id: input.vehicle ?? 'car', ...vehicle },
    tankPct,
    rangeKm: Math.round(rangeKm),
    tripKm: Math.round(tripKm),
    litresNeeded: Math.round(litres * 10) / 10,
    estimatedCost: Math.round(litres * market.price),
    price: market,
    stationsOnRoute: onRoute.length,
    sellingOnRoute: selling.length,
    stops,
    needsRefuel: stops.length > 0,
    cheapest: selling.filter((s) => s.price).sort((a, b) => a.price - b.price)[0] ?? null,
  };
}
