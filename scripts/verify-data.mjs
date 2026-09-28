#!/usr/bin/env node
/**
 * Checks the bundled map data before it ships.
 *
 *   npm run verify
 *
 * The road graph and the gazetteer are hand-maintained JSON. This catches the
 * mistakes that are easy to make by hand: an edge pointing at a place that does
 * not exist, a duplicate id, a coordinate that fell outside Nigeria, an
 * unreachable town, a road class that was never defined.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gazetteer = JSON.parse(readFileSync(join(root, 'data/places.json'), 'utf8'));
const places = gazetteer.places ?? gazetteer;
const highways = JSON.parse(readFileSync(join(root, 'data/highways.json'), 'utf8'));

const problems = [];
const warnings = [];
const fail = (message) => problems.push(message);
const warn = (message) => warnings.push(message);

/* ----------------------------------------------------------------- places */

const byId = new Map();
for (const place of places) {
  if (!place.id) fail(`place without an id: ${JSON.stringify(place).slice(0, 80)}`);
  if (byId.has(place.id)) fail(`duplicate place id: ${place.id}`);
  byId.set(place.id, place);

  if (!place.name) fail(`${place.id}: missing name`);
  if (!place.state) fail(`${place.id}: missing state`);
  if (typeof place.lat !== 'number' || typeof place.lon !== 'number') {
    fail(`${place.id}: coordinates must be numbers`);
    continue;
  }
  if (place.lat < 4.0 || place.lat > 14.0) fail(`${place.id}: latitude ${place.lat} is outside Nigeria`);
  if (place.lon < 2.6 || place.lon > 14.8) fail(`${place.id}: longitude ${place.lon} is outside Nigeria`);
}

const states = new Set(places.map((p) => p.state));
if (states.size !== 37) fail(`expected 36 states + FCT, found ${states.size}`);

/* ---------------------------------------------------------------- classes */

const classes = highways.classes ?? {};
for (const [name, spec] of Object.entries(classes)) {
  if (!(spec.speedKph > 0)) fail(`road class ${name}: speedKph must be positive`);
  if (!(spec.sinuosity >= 1)) fail(`road class ${name}: sinuosity must be >= 1`);
}

/* ------------------------------------------------------------------ edges */

const adjacency = new Map();
const seenPairs = new Set();

for (const [index, raw] of highways.edges.entries()) {
  const edge = { from: raw.a, to: raw.b, class: raw.class, name: raw.name };
  const where = `edge ${index} (${edge.from} → ${edge.to})`;
  if (!byId.has(edge.from)) fail(`${where}: unknown place "${edge.from}"`);
  if (!byId.has(edge.to)) fail(`${where}: unknown place "${edge.to}"`);
  if (edge.from === edge.to) fail(`${where}: a road cannot loop back to the same place`);
  if (!classes[edge.class]) fail(`${where}: unknown road class "${edge.class}"`);
  if (!edge.name) warn(`${where}: no road name — turn-by-turn directions will be vague`);

  const key = [edge.from, edge.to].sort().join('|');
  if (seenPairs.has(key)) warn(`${where}: duplicate link, the graph already connects these two`);
  seenPairs.add(key);

  if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
  if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
  adjacency.get(edge.from).push(edge.to);
  adjacency.get(edge.to).push(edge.from);
}

/* ------------------------------------------------------- connectivity ---- */

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const start = adjacency.keys().next().value;
const seen = new Set([start]);
const queue = [start];
while (queue.length) {
  for (const next of adjacency.get(queue.shift()) ?? []) {
    if (!seen.has(next)) {
      seen.add(next);
      queue.push(next);
    }
  }
}

const onGraph = [...adjacency.keys()];
const unreachable = onGraph.filter((id) => !seen.has(id));
if (unreachable.length) fail(`${unreachable.length} place(s) are cut off from the network: ${unreachable.join(', ')}`);

const offGraph = places.filter((p) => !adjacency.has(p.id));
if (offGraph.length) {
  warn(`${offGraph.length} place(s) have no road of their own (they snap to the nearest one): ${offGraph.map((p) => p.id).join(', ')}`);
}

/* ------------------------------------------------- implausible distances */

let networkKm = 0;
for (const edge of highways.edges) {
  const from = byId.get(edge.a);
  const to = byId.get(edge.b);
  if (!from || !to) continue;
  const straight = haversine(from, to);
  const spec = classes[edge.class];
  networkKm += (straight * (spec?.sinuosity ?? 1.15)) / 1000;
  if (straight > 400_000) {
    fail(`edge ${edge.a} → ${edge.b} spans ${Math.round(straight / 1000)} km — that is almost certainly wrong`);
  }
  if (straight < 400) {
    warn(`edge ${edge.a} → ${edge.b} is only ${Math.round(straight)} m long`);
  }
}

/* ----------------------------------------------------------------- report */

const degree = [...adjacency.entries()].map(([id, links]) => [id, new Set(links).size]);
const orphans = degree.filter(([, n]) => n === 1);

console.log('Naija Routes — data check\n');
console.log(`  places           ${places.length}`);
console.log(`  states covered   ${states.size}`);
console.log(`  road links       ${highways.edges.length}`);
console.log(`  road classes     ${Object.keys(classes).length}`);
console.log(`  network length   ${Math.round(networkKm).toLocaleString()} km`);
console.log(`  on the graph     ${adjacency.size} places`);
console.log(`  dead ends        ${orphans.length}${orphans.length ? ` (${orphans.slice(0, 8).map(([id]) => id).join(', ')}${orphans.length > 8 ? '…' : ''})` : ''}`);

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const message of warnings.slice(0, 25)) console.log(`  · ${message}`);
  if (warnings.length > 25) console.log(`  · …and ${warnings.length - 25} more`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const message of problems) console.error(`  ✗ ${message}`);
  process.exit(1);
}

console.log('\nAll good.');
