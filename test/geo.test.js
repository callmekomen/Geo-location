import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine,
  bearing,
  compass,
  destination,
  pointToSegment,
  pointToPolyline,
  polylineLength,
  pointAlong,
  bounds,
  padBounds,
  simplify,
  decodePolyline,
  inNigeria,
  format,
} from '../server/services/geo.js';

const LAGOS = [6.5244, 3.3792];
const ABUJA = [9.0579, 7.4951];

test('haversine matches the known Lagos–Abuja great-circle distance', () => {
  const metres = haversine(LAGOS, ABUJA);
  // ~525 km as the crow flies
  assert.ok(metres > 520_000 && metres < 535_000, `got ${metres}`);
  assert.equal(haversine(LAGOS, LAGOS), 0);
});

test('haversine is symmetric', () => {
  assert.equal(Math.round(haversine(LAGOS, ABUJA)), Math.round(haversine(ABUJA, LAGOS)));
});

test('bearing and compass point the right way', () => {
  const deg = bearing(LAGOS, ABUJA);
  assert.ok(deg > 30 && deg < 70, `expected north-east, got ${deg}`);
  assert.equal(compass(deg), 'north-east');
  assert.equal(compass(0), 'north');
  assert.equal(compass(180), 'south');
  assert.equal(compass(271), 'west');
});

test('destination round-trips with haversine', () => {
  const target = destination(LAGOS, 90, 10_000);
  assert.ok(Math.abs(haversine(LAGOS, target) - 10_000) < 5);
});

test('pointToSegment clamps to the segment ends', () => {
  const a = [6.0, 3.0];
  const b = [6.0, 4.0];
  const before = pointToSegment([6.0, 2.0], a, b);
  assert.equal(before.t, 0);
  const after = pointToSegment([6.0, 5.0], a, b);
  assert.equal(after.t, 1);
  const middle = pointToSegment([6.05, 3.5], a, b);
  assert.ok(middle.t > 0.45 && middle.t < 0.55);
  assert.ok(middle.distance > 5000 && middle.distance < 6000);
});

test('pointToPolyline reports distance along the line', () => {
  const line = [
    [6.0, 3.0],
    [6.0, 3.5],
    [6.0, 4.0],
  ];
  const hit = pointToPolyline([6.001, 3.5], line);
  assert.equal(hit.index, 0);
  assert.ok(hit.distance < 200);
  const total = polylineLength(line);
  assert.ok(Math.abs(hit.along - total / 2) < 500);
});

test('pointAlong walks the polyline', () => {
  const line = [
    [6.0, 3.0],
    [6.0, 4.0],
  ];
  const total = polylineLength(line);
  const mid = pointAlong(line, total / 2);
  assert.ok(Math.abs(mid[1] - 3.5) < 0.01);
  assert.deepEqual(pointAlong(line, -10), line[0]);
  assert.deepEqual(pointAlong(line, total * 2), line[1]);
});

test('bounds and padBounds grow the right way', () => {
  const box = bounds([LAGOS, ABUJA]);
  assert.equal(box.minLat, 6.5244);
  assert.equal(box.maxLat, 9.0579);
  const padded = padBounds(box, 10_000);
  assert.ok(padded.minLat < box.minLat);
  assert.ok(padded.maxLon > box.maxLon);
});

test('simplify keeps the ends and drops redundant points', () => {
  const line = [
    [6.0, 3.0],
    [6.0, 3.1],
    [6.0, 3.2],
    [6.0, 3.3],
    [6.5, 3.4],
  ];
  const out = simplify(line, 50);
  assert.deepEqual(out[0], line[0]);
  assert.deepEqual(out[out.length - 1], line[line.length - 1]);
  assert.ok(out.length < line.length);
});

test('decodePolyline understands the Google/OSRM format', () => {
  // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" is the canonical example from the spec.
  const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(points.length, 3);
  assert.ok(Math.abs(points[0][0] - 38.5) < 0.001);
  assert.ok(Math.abs(points[0][1] + 120.2) < 0.001);
});

test('inNigeria fences the country roughly', () => {
  assert.ok(inNigeria(...LAGOS));
  assert.ok(inNigeria(...ABUJA));
  assert.ok(!inNigeria(51.5, -0.12)); // London
  assert.ok(!inNigeria(5.6, 0.2)); // Accra
});

test('formatters read like a human wrote them', () => {
  assert.equal(format.km(450), '450 m');
  assert.equal(format.km(4500), '4.5 km');
  assert.equal(format.km(45_000), '45 km');
  assert.equal(format.duration(90), '2 min');
  assert.equal(format.duration(3600), '1h');
  assert.equal(format.duration(5400), '1h 30m');
});
