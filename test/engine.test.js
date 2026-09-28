import test from 'node:test';
import assert from 'node:assert/strict';
import { search, nearest, describe as describePlace, editDistance, places, states } from '../server/services/gazetteer.js';
import { route, snap, graphMeta } from '../server/services/graph.js';
import { analyseRoute, gradeFor } from '../server/services/hazards.js';
import { clusterStations, marketPrice, planFuel } from '../server/services/fuel.js';
import { haversine, polylineLength } from '../server/services/geo.js';

/* ------------------------------------------------------------ gazetteer */

test('the gazetteer covers every state and the FCT', () => {
  assert.equal(states.length, 37);
  assert.ok(places.length > 150);
  for (const place of places) {
    assert.ok(place.lat > 3.9 && place.lat < 14.3, `${place.id} latitude out of Nigeria`);
    assert.ok(place.lon > 2.5 && place.lon < 15, `${place.id} longitude out of Nigeria`);
  }
});

test('place ids are unique', () => {
  const ids = new Set();
  for (const place of places) {
    assert.ok(!ids.has(place.id), `duplicate id ${place.id}`);
    ids.add(place.id);
  }
});

test('search handles exact names, abbreviations and typos', () => {
  assert.equal(search('Port Harcourt')[0].id, 'port-harcourt');
  assert.equal(search('ph')[0].id, 'port-harcourt');
  assert.equal(search('ibadam')[0].id, 'ibadan', 'should survive a typo');
  assert.equal(search('ikeja, lagos')[0].id, 'ikeja');
  assert.equal(search('wuse')[0].state, 'FCT');
  assert.deepEqual(search(''), []);
});

test('search bias moves nearby places up the list', () => {
  const far = search('ikeja', { near: [11.0, 12.0] })[0];
  const near = search('ikeja', { near: [6.6, 3.35] })[0];
  assert.equal(far.id, near.id);
  assert.ok(near.score >= far.score);
});

test('editDistance bails out early for hopeless comparisons', () => {
  assert.equal(editDistance('kano', 'kano'), 0);
  assert.equal(editDistance('kano', 'kanu'), 1);
  assert.ok(editDistance('kano', 'maiduguri', 3) > 3);
});

test('nearest and describe locate a coordinate', () => {
  const [hit] = nearest(6.5244, 3.3792);
  assert.equal(hit.state, 'Lagos');
  assert.match(describePlace(9.0579, 7.4951), /FCT|Abuja/);
  assert.match(describePlace(7.0, 6.0), /km from/);
});

/* ---------------------------------------------------------------- graph */

test('the highway graph is connected enough to be useful', () => {
  assert.ok(graphMeta.edges > 200);
  assert.ok(graphMeta.networkKm > 10_000);
});

test('snapping finds the nearest road', () => {
  const [hit] = snap([6.6018, 3.3515]);
  assert.ok(hit);
  assert.ok(hit.distance < 5000);
});

test('routing Lagos to Abuja produces a sane journey', () => {
  const result = route([6.5244, 3.3792], [9.0579, 7.4951], { labels: { from: 'Lagos', to: 'Abuja' } });
  assert.ok(result);
  const best = result.routes[0];
  const straight = haversine([6.5244, 3.3792], [9.0579, 7.4951]);
  assert.ok(best.distanceM > straight, 'road distance must exceed the crow-flies distance');
  assert.ok(best.distanceM < straight * 1.9, 'and must not be a wild detour');
  assert.ok(best.durationS > 6 * 3600 && best.durationS < 16 * 3600, `got ${best.durationS}s`);
  assert.ok(best.geometry.length > 3);
  assert.ok(best.steps.length >= 2);
  assert.equal(best.steps.at(-1).class, 'arrival');
  // The geometry must actually start and end where we asked.
  assert.ok(haversine(best.geometry[0], [6.5244, 3.3792]) < 1);
  assert.ok(haversine(best.geometry.at(-1), [9.0579, 7.4951]) < 1);
});

test('alternatives are genuinely different roads, or absent', () => {
  const result = route([6.4402, 7.4943], [4.8156, 7.0498], { alternatives: 1 });
  if (result.routes.length > 1) {
    const [a, b] = result.routes;
    const sharedNames = a.roads.filter((r) => b.roads.includes(r)).length;
    assert.ok(sharedNames < a.roads.length, 'an alternative that uses every same road is not an alternative');
  }
});

test('short hops inside one city still route', () => {
  const result = route([6.4541, 3.3947], [6.4281, 3.4219], { alternatives: 0 });
  assert.ok(result);
  assert.ok(result.routes[0].distanceM > 1000 && result.routes[0].distanceM < 20_000);
});

test('the reported geometry length matches the reported distance', () => {
  const result = route([7.3775, 3.947], [8.4966, 4.5421], { alternatives: 0 });
  const best = result.routes[0];
  const drawn = polylineLength(best.geometry);
  // Geometry is the straight-line skeleton; distance adds the sinuosity factor.
  assert.ok(best.distanceM >= drawn * 0.95, `${best.distanceM} vs ${drawn}`);
  assert.ok(best.distanceM <= drawn * 1.35);
});

/* -------------------------------------------------------------- hazards */

const line = [
  [6.5, 3.4],
  [7.0, 4.0],
  [7.4, 4.6],
];

const makeReport = (over) => ({
  id: Math.random().toString(36).slice(2),
  type: 'pothole',
  typeLabel: 'Bad road / pothole',
  category: 'road',
  severity: 2,
  confidence: 0.8,
  confirms: 1,
  disputes: 0,
  lat: 7.0,
  lon: 4.0,
  road: 'Test Road',
  place: 'Somewhere',
  createdAt: new Date().toISOString(),
  ageMinutes: 30,
  ...over,
});

test('analyseRoute only counts reports inside the corridor', () => {
  const onRoute = makeReport({ lat: 7.001, lon: 4.001 });
  const wayOff = makeReport({ lat: 9.5, lon: 8.5 });
  const analysis = analyseRoute(line, [onRoute, wayOff], { corridorM: 2000 });
  assert.equal(analysis.hazards.length, 1);
  assert.equal(analysis.hazards[0].id, onRoute.id);
  assert.ok(analysis.hazards[0].alongM > 0);
  assert.ok(analysis.score < 100);
});

test('a clean route scores 100 and says so', () => {
  const analysis = analyseRoute(line, [], {});
  assert.equal(analysis.score, 100);
  assert.equal(analysis.hazardCount, 0);
  assert.equal(analysis.grade, 'clear');
  assert.ok(analysis.advisories.some((a) => a.title.includes('Nothing reported')));
});

test('security reports hurt the score far more than checkpoints', () => {
  const withSecurity = analyseRoute(line, [makeReport({ type: 'security', category: 'security', severity: 3 })], {});
  const withCheckpoint = analyseRoute(line, [makeReport({ type: 'checkpoint', category: 'security', severity: 1 })], {});
  assert.ok(withSecurity.score < withCheckpoint.score - 10, `${withSecurity.score} vs ${withCheckpoint.score}`);
  assert.ok(withSecurity.advisories.some((a) => a.level === 'high'));
});

test('"road is clear" reports give a little back', () => {
  const hazards = [makeReport({ type: 'pothole' })];
  const worse = analyseRoute(line, hazards, {});
  const better = analyseRoute(line, [...hazards, makeReport({ type: 'clear', category: 'clear', severity: 0, lat: 6.6, lon: 3.5 })], {});
  assert.ok(better.score >= worse.score);
});

test('grades map to the right tone', () => {
  assert.equal(gradeFor(95).grade, 'clear');
  assert.equal(gradeFor(70).tone, 'good');
  assert.equal(gradeFor(50).tone, 'warn');
  assert.equal(gradeFor(10).tone, 'bad');
});

test('an overnight arrival raises an advisory', () => {
  const depart = new Date('2026-03-02T16:00:00Z');
  const analysis = analyseRoute(line, [], { durationS: 6 * 3600, departAt: depart });
  assert.ok(analysis.advisories.some((a) => a.title.includes('after dark')));
});

/* ----------------------------------------------------------------- fuel */

test('fuel reports collapse into stations and a median price', () => {
  const reports = [
    makeReport({ type: 'fuel_available', category: 'fuel', label: 'NNPC', meta: { price: 1000 }, lat: 7.0, lon: 4.0 }),
    makeReport({ type: 'fuel_available', category: 'fuel', label: 'NNPC', meta: { price: 1000 }, lat: 7.0001, lon: 4.0001 }),
    makeReport({ type: 'fuel_available', category: 'fuel', label: 'Total', meta: { price: 1200 }, lat: 7.2, lon: 4.3 }),
  ];
  const stations = clusterStations(reports);
  assert.equal(stations.length, 2, 'two reports 15 m apart are one station');
  const market = marketPrice(stations);
  assert.equal(market.source, 'community');
  assert.equal(market.samples, 2);
  assert.ok(market.price >= 1000 && market.price <= 1200);
});

test('planFuel schedules a stop when the tank cannot make it', () => {
  const stations = clusterStations([
    makeReport({ type: 'fuel_available', category: 'fuel', label: 'Halfway', meta: { price: 1100 }, lat: 7.0, lon: 4.0 }),
  ]);
  const plan = planFuel({
    geometry: line,
    distanceM: 600_000,
    stations,
    vehicle: 'car',
    tankPct: 0.2,
    corridorM: 5000,
  });
  assert.ok(plan.needsRefuel);
  assert.ok(plan.litresNeeded > 40);
  assert.ok(plan.estimatedCost > 0);
  assert.ok(plan.stops.length >= 1);
});

test('planFuel leaves a short hop alone', () => {
  const plan = planFuel({ geometry: line, distanceM: 30_000, stations: [], vehicle: 'car', tankPct: 1 });
  assert.equal(plan.needsRefuel, false);
  assert.equal(plan.stops.length, 0);
});
