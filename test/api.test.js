import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, startTestServer } from './helpers.js';

const temp = useTempDatabase();
let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server?.close();
  const { closeDb } = await import('../server/db/index.js');
  closeDb();
  temp.cleanup();
});

test('GET /api/health', async () => {
  const { status, body } = await server.call('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('GET /api/meta describes the whole vocabulary', async () => {
  const { body } = await server.call('/api/meta');
  assert.ok(body.reportTypes.pothole);
  assert.ok(body.vehicles.car);
  assert.equal(body.states.length, 37);
  assert.ok(body.network.edges > 200);
  assert.equal(body.upstream.osrm.enabled, false, 'tests must never hit the network');
  assert.equal(body.assistant.mode, 'builtin');
});

test('GET /api/places searches offline', async () => {
  const { body } = await server.call('/api/places?q=enugu');
  assert.equal(body.results[0].id, 'enugu');
  const bad = await server.call('/api/places');
  assert.equal(bad.status, 400);
});

test('GET /api/places/reverse names a coordinate', async () => {
  const { body } = await server.call('/api/places/reverse?lat=6.5244&lon=3.3792');
  assert.ok(body.label.length > 3);
  assert.equal(body.source, 'offline');
});

test('POST /api/reports validates its input', async () => {
  const missingType = await server.call('/api/reports', { method: 'POST', body: { lat: 6.5, lon: 3.3 } });
  assert.equal(missingType.status, 400);

  const badType = await server.call('/api/reports', {
    method: 'POST',
    body: { type: 'alien-landing', lat: 6.5, lon: 3.3 },
  });
  assert.equal(badType.status, 400);

  const badLat = await server.call('/api/reports', { method: 'POST', body: { type: 'pothole', lat: 999, lon: 3.3 } });
  assert.equal(badLat.status, 400);
});

let createdId;

test('POST /api/reports creates an enriched report', async () => {
  const { status, body } = await server.call('/api/reports', {
    method: 'POST',
    body: {
      type: 'flooding',
      lat: 6.6018,
      lon: 3.3515,
      note: 'Water across both lanes',
      label: 'Under the bridge',
      reporter: 'Tester',
    },
  });
  assert.equal(status, 201);
  createdId = body.report.id;
  assert.equal(body.report.type, 'flooding');
  assert.equal(body.report.category, 'road');
  assert.equal(body.report.state, 'Lagos');
  assert.ok(body.report.place.includes('Ikeja'));
  assert.ok(body.report.confidence > 0 && body.report.confidence <= 1);
  assert.ok(new Date(body.report.expiresAt) > new Date());
});

test('a near-duplicate from another device counts as a confirmation', async () => {
  const { body } = await server.call('/api/reports', {
    method: 'POST',
    deviceId: 'test_device_0002',
    body: { type: 'flooding', lat: 6.6019, lon: 3.3516, note: 'Still flooded' },
  });
  assert.equal(body.deduped, true);
  assert.equal(body.report.id, createdId);
  assert.ok(body.report.confirms >= 1);
});

test('GET /api/reports filters by bbox and category', async () => {
  const inBox = await server.call('/api/reports?bbox=6.4,3.2,6.8,3.5');
  assert.ok(inBox.body.reports.some((r) => r.id === createdId));

  const elsewhere = await server.call('/api/reports?bbox=11,12,12,13');
  assert.equal(elsewhere.body.reports.length, 0);

  const wrongCategory = await server.call('/api/reports?categories=fuel');
  assert.ok(!wrongCategory.body.reports.some((r) => r.id === createdId));
});

test('voting is one per device and can be changed', async () => {
  const first = await server.call(`/api/reports/${createdId}/vote`, {
    method: 'POST',
    deviceId: 'voter_device_01',
    body: { vote: 'confirm' },
  });
  assert.equal(first.status, 200);
  const confirms = first.body.report.confirms;

  const again = await server.call(`/api/reports/${createdId}/vote`, {
    method: 'POST',
    deviceId: 'voter_device_01',
    body: { vote: 'confirm' },
  });
  assert.equal(again.body.report.confirms, confirms, 'voting twice must not double-count');

  const flipped = await server.call(`/api/reports/${createdId}/vote`, {
    method: 'POST',
    deviceId: 'voter_device_01',
    body: { vote: 'dispute' },
  });
  assert.equal(flipped.body.report.confirms, confirms - 1);
  assert.equal(flipped.body.report.disputes, 1);

  const invalid = await server.call(`/api/reports/${createdId}/vote`, { method: 'POST', body: { vote: 'maybe' } });
  assert.equal(invalid.status, 400);

  const missing = await server.call('/api/reports/does-not-exist/vote', { method: 'POST', body: { vote: 'confirm' } });
  assert.equal(missing.status, 404);
});

test('POST /api/route returns a scored plan with hazards attached', async () => {
  const { status, body } = await server.call('/api/route', {
    method: 'POST',
    body: { from: 'Ikeja', to: 'Ibadan', vehicle: 'car', tankPct: 0.3 },
  });
  assert.equal(status, 200);
  assert.equal(body.engine, 'offline');
  const route = body.routes[0];
  assert.ok(route.distanceM > 80_000);
  assert.ok(route.geometry.length > 2);
  assert.ok(route.safety.score >= 0 && route.safety.score <= 100);
  assert.ok(Array.isArray(route.advisories));
  assert.ok(route.fuel.litresNeeded > 0);
  // The flooding report we created sits on the way out of Ikeja.
  assert.ok(route.hazards.some((h) => h.id === createdId), 'the nearby report should be matched to the corridor');
});

test('POST /api/route rejects nonsense', async () => {
  const noWhere = await server.call('/api/route', { method: 'POST', body: { from: 'Ikeja' } });
  assert.equal(noWhere.status, 400);

  const unknown = await server.call('/api/route', {
    method: 'POST',
    body: { from: 'Qqqqzzzz Town', to: 'Ibadan' },
  });
  assert.equal(unknown.status, 404);

  const sameSpot = await server.call('/api/route', {
    method: 'POST',
    body: { from: { lat: 6.5, lon: 3.3 }, to: { lat: 6.5, lon: 3.3 } },
  });
  assert.equal(sameSpot.status, 400);
});

test('trips: create, ping, watch, sos and arrive', async () => {
  const created = await server.call('/api/trips', {
    method: 'POST',
    body: {
      from: { lat: 6.5244, lon: 3.3792, label: 'Lagos' },
      to: { lat: 7.3775, lon: 3.947, label: 'Ibadan' },
      geometry: [
        [6.5244, 3.3792],
        [6.85, 3.65],
        [7.3775, 3.947],
      ],
      distanceM: 130_000,
      durationS: 7200,
      traveller: 'Ada',
    },
  });
  assert.equal(created.status, 201);
  const { trip, token } = created.body;
  assert.match(trip.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(trip.status, 'active');

  const unauthorised = await server.call(`/api/trips/${trip.code}/ping`, {
    method: 'POST',
    body: { lat: 6.7, lon: 3.5 },
  });
  assert.equal(unauthorised.status, 403, 'a ping without the token must be refused');

  const pinged = await server.call(`/api/trips/${trip.code}/ping`, {
    method: 'POST',
    body: { lat: 6.85, lon: 3.65, speedKph: 78, token },
  });
  assert.equal(pinged.status, 200);
  assert.ok(pinged.body.trip.progress > 0.2 && pinged.body.trip.progress < 0.8);

  const watched = await server.call(`/api/trips/${trip.code}`);
  assert.equal(watched.status, 200);
  assert.equal(watched.body.trip.traveller, 'Ada');
  assert.ok(watched.body.breadcrumbs.length >= 1);
  assert.ok(watched.body.events.some((e) => e.kind === 'started'));
  assert.ok(watched.body.safety);

  const sos = await server.call(`/api/trips/${trip.code}/sos`, { method: 'POST', body: { token, message: 'Help' } });
  assert.equal(sos.body.trip.sos, true);

  const cleared = await server.call(`/api/trips/${trip.code}/sos`, { method: 'POST', body: { token, clear: true } });
  assert.equal(cleared.body.trip.sos, false);

  const arrived = await server.call(`/api/trips/${trip.code}/status`, {
    method: 'POST',
    body: { token, status: 'arrived' },
  });
  assert.equal(arrived.body.trip.status, 'arrived');

  const missing = await server.call('/api/trips/ZZZZZZ');
  assert.equal(missing.status, 404);
});

test('GET /api/insights aggregates without falling over', async () => {
  const { status, body } = await server.call('/api/insights?days=30');
  assert.equal(status, 200);
  assert.ok(body.counts.total >= 1);
  assert.ok(Array.isArray(body.daily));
  assert.ok(Array.isArray(body.hotspots));
  assert.ok(body.fuel.market.price > 0);
});

test('the assistant answers from real data with no API key', async () => {
  const distance = await server.call('/api/assistant', {
    method: 'POST',
    body: { message: 'how far from Ikeja to Ibadan?' },
  });
  assert.equal(distance.status, 200);
  assert.equal(distance.body.intent, 'route');
  assert.match(distance.body.reply, /km/);
  assert.equal(distance.body.mode, 'builtin');

  const help = await server.call('/api/assistant', { method: 'POST', body: { message: 'help' } });
  assert.equal(help.body.intent, 'help');

  const nearby = await server.call('/api/assistant', {
    method: 'POST',
    body: { message: 'any flooding near me?', context: { position: { lat: 6.6018, lon: 3.3515 } } },
  });
  assert.ok(nearby.body.reply.length > 10);

  const empty = await server.call('/api/assistant', { method: 'POST', body: { message: '' } });
  assert.equal(empty.status, 400);
});

test('the assistant understands how people actually phrase things', async () => {
  const ask = async (message, context) =>
    (await server.call('/api/assistant', { method: 'POST', body: { message, context } })).body;

  // The journey separator is ambiguous: "safe to drive" is not a leg.
  for (const phrasing of [
    'how safe is Ikeja to Ibadan tonight?',
    'Ikeja to Ibadan',
    'is it safe to drive Ikeja to Ibadan today?',
    'how long does Ikeja to Ibadan take',
    'tell me about Ikeja to Ibadan',
    'from ikeja to ibadan',
    'driving ikeja to ibadan tomorrow morning, safe?',
  ]) {
    const answer = await ask(phrasing);
    assert.equal(answer.intent, 'route', `"${phrasing}" should be understood as a route`);
    assert.match(answer.reply, /Ibadan/, `"${phrasing}" should reach Ibadan`);
  }

  // Typos still land.
  const typo = await ask('how far from ibadam to oshogbo');
  assert.equal(typo.intent, 'route');
  assert.match(typo.reply, /Ibadan/);

  // A destination with no origin asks rather than guessing.
  const noOrigin = await ask('I need to go to Enugu');
  assert.match(noOrigin.reply, /Starting from where/i);

  // ...unless it knows where you are.
  const located = await ask('how far is it to Ibadan', { position: { lat: 6.6018, lon: 3.3515 } });
  assert.equal(located.intent, 'route');
  assert.match(located.reply, /km/);

  // Fuzzy nonsense must not become a town.
  const nonsense = await ask('I need to go');
  assert.notEqual(nonsense.intent, 'route');

  const greeting = await ask('hello');
  assert.equal(greeting.intent, 'greeting');
});

test('unknown endpoints 404 as JSON', async () => {
  const { status, body } = await server.call('/api/nope');
  assert.equal(status, 404);
  assert.ok(body.error);
});

test('the SPA is served for unknown non-API paths', async () => {
  const res = await fetch(`${server.base}/some/deep/link`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Naija Routes'));
});

test('security headers are present', async () => {
  const res = await fetch(`${server.base}/api/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy').includes("default-src 'self'"));
});
