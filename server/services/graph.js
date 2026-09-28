/**
 * Offline routing engine.
 *
 * Builds a weighted graph from the bundled highway file and runs A* over it.
 * Arbitrary start/end coordinates are handled by projecting them onto the
 * nearest road segments and inserting temporary "virtual" nodes, so you can
 * route from any pin on the map, not just from a known town.
 *
 * This is what keeps the app useful when OSRM is unreachable — which, on a
 * Nigerian road trip, is most of the time.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { haversine, pointToSegment, bearing, compass, polylineLength } from './geo.js';
import { placesById } from './gazetteer.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '..', '..', 'data', 'highways.json'), 'utf8'));

export const roadClasses = raw.classes;

const MAX_SPEED_KPH = Math.max(...Object.values(roadClasses).map((c) => c.speedKph));
/** Speed used for the "get to the main road" connector legs. */
const ACCESS_SPEED_KPH = 22;
const ACCESS_DETOUR = 1.35;
/** Time lost at a junction where the road name changes. */
const TURN_PENALTY_S = 35;

function buildGraph() {
  const nodes = new Map();
  const edges = [];
  const adjacency = new Map();

  const ensureNode = (id) => {
    if (nodes.has(id)) return nodes.get(id);
    const place = placesById.get(id);
    if (!place) throw new Error(`highways.json references unknown place "${id}"`);
    const node = { id, lat: place.lat, lon: place.lon, name: place.name, state: place.state, kind: place.kind };
    nodes.set(id, node);
    adjacency.set(id, []);
    return node;
  };

  for (const edge of raw.edges) {
    const a = ensureNode(edge.a);
    const b = ensureNode(edge.b);
    const cls = roadClasses[edge.class];
    if (!cls) throw new Error(`Unknown road class "${edge.class}"`);
    const straight = haversine([a.lat, a.lon], [b.lat, b.lon]);
    const lengthM = straight * cls.sinuosity;
    const durationS = (lengthM / 1000 / cls.speedKph) * 3600;
    const index = edges.length;
    edges.push({
      index,
      a: a.id,
      b: b.id,
      class: edge.class,
      name: edge.name ?? `${a.name} – ${b.name} Road`,
      ref: edge.ref ?? null,
      lengthM,
      durationS,
    });
    adjacency.get(a.id).push({ to: b.id, edge: index });
    adjacency.get(b.id).push({ to: a.id, edge: index });
  }

  return { nodes, edges, adjacency };
}

const graph = buildGraph();

export const graphMeta = {
  nodes: graph.nodes.size,
  edges: graph.edges.length,
  networkKm: Math.round(graph.edges.reduce((sum, e) => sum + e.lengthM, 0) / 1000),
  version: raw.meta?.version ?? 1,
};

/* ------------------------------------------------------------------ *
 * Binary heap priority queue
 * ------------------------------------------------------------------ */
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(value, priority) {
    this.items.push({ value, priority });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].priority <= this.items[i].priority) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.items[l].priority < this.items[smallest].priority) smallest = l;
        if (r < this.items.length && this.items[r].priority < this.items[smallest].priority) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top?.value;
  }
}

/* ------------------------------------------------------------------ *
 * Snapping arbitrary coordinates onto the network
 * ------------------------------------------------------------------ */

/**
 * Find the closest points on the road network to a coordinate.
 * @returns {Array<{edge:object, t:number, point:[number,number], distance:number}>}
 */
export function snap(point, { limit = 4, maxDistanceM = 120000 } = {}) {
  const hits = [];
  for (const edge of graph.edges) {
    const a = graph.nodes.get(edge.a);
    const b = graph.nodes.get(edge.b);
    const hit = pointToSegment(point, [a.lat, a.lon], [b.lat, b.lon]);
    if (hit.distance <= maxDistanceM) {
      hits.push({ edge, t: hit.t, point: hit.point, distance: hit.distance });
    }
  }
  hits.sort((x, y) => x.distance - y.distance);

  // Keep the best hit per road name so alternatives are genuinely different.
  const seen = new Set();
  const picked = [];
  for (const hit of hits) {
    const key = hit.edge.name;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(hit);
    if (picked.length >= limit) break;
  }
  return picked;
}

function accessSeconds(distanceM) {
  return ((distanceM * ACCESS_DETOUR) / 1000 / ACCESS_SPEED_KPH) * 3600;
}

/**
 * Build a throw-away overlay graph containing virtual nodes for the origin
 * and destination so A* can start and finish anywhere.
 */
function withEndpoints(origin, destination, penalties) {
  const extraAdjacency = new Map();
  const virtualNodes = new Map();
  const virtualEdges = [];

  const addVirtual = (id, point, hits) => {
    virtualNodes.set(id, { id, lat: point[0], lon: point[1], name: id, virtual: true });
    const links = [];
    for (const hit of hits) {
      const { edge, t, distance } = hit;
      const toA = { lengthM: edge.lengthM * t, durationS: edge.durationS * t };
      const toB = { lengthM: edge.lengthM * (1 - t), durationS: edge.durationS * (1 - t) };
      const access = accessSeconds(distance);
      const accessLen = distance * ACCESS_DETOUR;

      const mkEdge = (target, part) => {
        const index = -(virtualEdges.length + 1);
        virtualEdges.push({
          index,
          a: id,
          b: target,
          class: distance > 1500 ? 'urban' : edge.class,
          name: distance > 1500 ? 'Local access road' : edge.name,
          ref: edge.ref,
          lengthM: part.lengthM + accessLen,
          durationS: part.durationS + access,
          virtual: true,
        });
        links.push({ to: target, edge: index });
        if (!extraAdjacency.has(target)) extraAdjacency.set(target, []);
        extraAdjacency.get(target).push({ to: id, edge: index });
      };

      mkEdge(edge.a, toA);
      mkEdge(edge.b, toB);
    }
    extraAdjacency.set(id, (extraAdjacency.get(id) ?? []).concat(links));
  };

  const originHits = snap(origin);
  const destHits = snap(destination);
  if (!originHits.length || !destHits.length) return null;

  addVirtual('@origin', origin, originHits);
  addVirtual('@destination', destination, destHits);

  // If both ends snap to the same road segment, allow travelling directly
  // between them without detouring through a town.
  for (const oh of originHits) {
    for (const dh of destHits) {
      if (oh.edge.index !== dh.edge.index) continue;
      const frac = Math.abs(dh.t - oh.t);
      const index = -(virtualEdges.length + 1);
      virtualEdges.push({
        index,
        a: '@origin',
        b: '@destination',
        class: oh.edge.class,
        name: oh.edge.name,
        ref: oh.edge.ref,
        lengthM: oh.edge.lengthM * frac + (oh.distance + dh.distance) * ACCESS_DETOUR,
        durationS: oh.edge.durationS * frac + accessSeconds(oh.distance) + accessSeconds(dh.distance),
        virtual: true,
      });
      extraAdjacency.get('@origin').push({ to: '@destination', edge: index });
      extraAdjacency.get('@destination').push({ to: '@origin', edge: index });
    }
  }

  const getNode = (id) => virtualNodes.get(id) ?? graph.nodes.get(id);
  const getEdge = (index) => (index < 0 ? virtualEdges[-index - 1] : graph.edges[index]);
  const neighbours = (id) => {
    const base = graph.adjacency.get(id) ?? [];
    const extra = extraAdjacency.get(id) ?? [];
    return extra.length ? base.concat(extra) : base;
  };
  const cost = (edge) => edge.durationS * (penalties?.get(edge.index) ?? 1);

  return { getNode, getEdge, neighbours, cost, originHits, destHits };
}

/* ------------------------------------------------------------------ *
 * A*
 * ------------------------------------------------------------------ */
function astar(world, startId, goalId) {
  const goal = world.getNode(goalId);
  const heuristic = (id) => {
    const node = world.getNode(id);
    return (haversine([node.lat, node.lon], [goal.lat, goal.lon]) / 1000 / MAX_SPEED_KPH) * 3600;
  };

  const open = new MinHeap();
  const gScore = new Map([[startId, 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  open.push(startId, heuristic(startId));

  while (open.size) {
    const current = open.pop();
    if (current === goalId) break;
    if (closed.has(current)) continue;
    closed.add(current);

    for (const link of world.neighbours(current)) {
      if (closed.has(link.to)) continue;
      const edge = world.getEdge(link.edge);
      let tentative = gScore.get(current) + world.cost(edge);
      const prevEdgeIndex = cameFrom.get(current)?.edge;
      if (prevEdgeIndex !== undefined) {
        const prevEdge = world.getEdge(prevEdgeIndex);
        if (prevEdge.name !== edge.name) tentative += TURN_PENALTY_S;
      }
      if (tentative < (gScore.get(link.to) ?? Infinity)) {
        gScore.set(link.to, tentative);
        cameFrom.set(link.to, { from: current, edge: link.edge });
        open.push(link.to, tentative + heuristic(link.to));
      }
    }
  }

  if (!cameFrom.has(goalId) && startId !== goalId) return null;

  const path = [];
  let cursor = goalId;
  while (cursor !== startId) {
    const step = cameFrom.get(cursor);
    if (!step) return null;
    path.unshift({ from: step.from, to: cursor, edge: world.getEdge(step.edge) });
    cursor = step.from;
  }
  return path;
}

/* ------------------------------------------------------------------ *
 * Turning a path into a route object
 * ------------------------------------------------------------------ */
function turnWord(prevBearing, nextBearing) {
  let delta = ((nextBearing - prevBearing + 540) % 360) - 180;
  if (Math.abs(delta) < 25) return 'Continue';
  if (Math.abs(delta) > 150) return 'Make a U-turn';
  if (delta > 0) return Math.abs(delta) > 70 ? 'Turn right' : 'Bear right';
  return Math.abs(delta) > 70 ? 'Turn left' : 'Bear left';
}

function buildRoute(world, path, origin, destination, labels) {
  const coordinates = [origin];
  for (const step of path) {
    const node = world.getNode(step.to);
    coordinates.push([node.lat, node.lon]);
  }
  // The virtual destination node is the snapped point; finish at the real one.
  coordinates[coordinates.length - 1] = destination;

  const legs = [];
  for (const step of path) {
    const last = legs[legs.length - 1];
    const node = world.getNode(step.to);
    const towards = node.virtual ? labels.to : node.name;
    if (last && last.name === step.edge.name) {
      last.distanceM += step.edge.lengthM;
      last.durationS += step.edge.durationS;
      last.to = towards;
      last.end = [node.lat, node.lon];
    } else {
      const fromNode = world.getNode(step.from);
      legs.push({
        name: step.edge.name,
        ref: step.edge.ref,
        class: step.edge.class,
        distanceM: step.edge.lengthM,
        durationS: step.edge.durationS,
        from: fromNode.virtual ? labels.from : fromNode.name,
        to: towards,
        start: [fromNode.lat, fromNode.lon],
        end: [node.lat, node.lon],
      });
    }
  }

  const steps = legs.map((leg, i) => {
    const head = bearing(leg.start, leg.end);
    let verb;
    if (i === 0) verb = `Head ${compass(head)}`;
    else verb = turnWord(bearing(legs[i - 1].start, legs[i - 1].end), head);
    const road = leg.ref ? `${leg.name} (${leg.ref})` : leg.name;
    return {
      instruction:
        i === 0
          ? `${verb} on ${road} towards ${leg.to}`
          : `${verb} onto ${road} towards ${leg.to}`,
      name: leg.name,
      ref: leg.ref,
      class: leg.class,
      distanceM: Math.round(leg.distanceM),
      durationS: Math.round(leg.durationS),
      location: leg.start,
    };
  });
  if (steps.length) {
    steps.push({
      instruction: `Arrive at ${labels.to}`,
      name: null,
      ref: null,
      class: 'arrival',
      distanceM: 0,
      durationS: 0,
      location: destination,
    });
  }

  const distanceM = path.reduce((sum, s) => sum + s.edge.lengthM, 0);
  const durationS =
    path.reduce((sum, s) => sum + s.edge.durationS, 0) + Math.max(0, legs.length - 1) * TURN_PENALTY_S;

  const roadProfile = new Map();
  for (const step of path) {
    roadProfile.set(step.edge.name, (roadProfile.get(step.edge.name) ?? 0) + step.edge.lengthM);
  }

  return {
    distanceM: Math.round(distanceM),
    durationS: Math.round(durationS),
    geometry: coordinates,
    steps,
    roadProfile,
    edgeIndices: path.map((s) => s.edge.index),
    roads: [...new Set(legs.filter((l) => l.distanceM > 3000).map((l) => l.name))],
  };
}

/** Kilometres of shared named road between two routes, as a fraction. */
function overlapRatio(a, b, totalM) {
  let shared = 0;
  for (const [name, metres] of b) {
    if (a.has(name)) shared += Math.min(metres, a.get(name));
  }
  return shared / Math.max(1, totalM);
}

/**
 * Plan a route between two coordinates using the offline network.
 *
 * @param {[number,number]} origin
 * @param {[number,number]} destination
 * @param {{labels?:{from:string,to:string}, alternatives?:number}} [options]
 * @returns {{routes:Array<object>, source:'offline'}|null}
 */
export function route(origin, destination, options = {}) {
  const labels = options.labels ?? { from: 'start', to: 'destination' };
  const wantAlternatives = Math.max(0, Math.min(2, options.alternatives ?? 1));

  const world = withEndpoints(origin, destination, null);
  if (!world) return null;
  const best = astar(world, '@origin', '@destination');
  if (!best) return null;

  const routes = [buildRoute(world, best, origin, destination, labels)];

  // Penalise the roads we already used and look for a genuinely different way.
  let penalties = new Map();
  for (let attempt = 0; attempt < wantAlternatives; attempt += 1) {
    for (const idx of routes[routes.length - 1].edgeIndices) {
      penalties.set(idx, (penalties.get(idx) ?? 1) * 2.2);
    }
    const altWorld = withEndpoints(origin, destination, penalties);
    const altPath = astar(altWorld, '@origin', '@destination');
    if (!altPath) break;
    const alt = buildRoute(altWorld, altPath, origin, destination, labels);
    // Compare how many kilometres of the same *named roads* the two routes
    // share. Comparing edge ids alone is fooled by the virtual access edges.
    const sharedRatio = overlapRatio(routes[0].roadProfile, alt.roadProfile, alt.distanceM);
    const slower = alt.durationS / Math.max(1, routes[0].durationS);
    if (sharedRatio < 0.62 && slower < 1.45 && alt.distanceM > 0) {
      routes.push(alt);
    } else {
      break;
    }
  }

  return {
    source: 'offline',
    routes: routes.map((r, i) => ({
      ...r,
      roadProfile: undefined,
      label: i === 0 ? 'Recommended' : `Alternative ${i}`,
      straightLineM: Math.round(haversine(origin, destination)),
      geometryLengthM: Math.round(polylineLength(r.geometry)),
    })),
  };
}

/** Exposed for tests and the /api/meta endpoint. */
export const _internals = { graph, astar, withEndpoints, MinHeap };
