/**
 * Boots the real front-end inside jsdom against the real server.
 *
 * There is no build step and no browser in CI, so this is what stops a typo in
 * an element id from shipping. It exercises the whole boot path: tabs,
 * autocomplete, routing, the report dialog, insights and the assistant.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { useTempDatabase, startTestServer } from './helpers.js';
import { installFakeLeaflet } from './fake-leaflet.js';

const temp = useTempDatabase();
let server;
let dom;
let window;
let document;
let nodeFetch;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check()` is truthy, or fail with a readable message. */
async function until(check, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await check();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await sleep(25);
  }
}

before(async () => {
  server = await startTestServer();

  // Some data to look at.
  await server.call('/api/reports', {
    method: 'POST',
    body: { type: 'pothole', lat: 6.6018, lon: 3.3515, note: 'Crater by the bus stop', severity: 3 },
  });
  await server.call('/api/reports', {
    method: 'POST',
    deviceId: 'seed_device_0002',
    body: { type: 'fuel_available', lat: 6.62, lon: 3.36, label: 'NNPC Ikeja', meta: { price: 1080, queue: 'short' } },
  });

  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  dom = new JSDOM(html, { url: `${server.base}/`, pretendToBeVisual: true, runScripts: 'outside-only' });
  window = dom.window;
  document = window.document;

  installFakeLeaflet(window);

  // jsdom has no fetch; proxy relative URLs to the test server. Capture Node's
  // fetch first — the shim is about to become the global one.
  nodeFetch = globalThis.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? new URL(input, server.base).toString() : input;
    return nodeFetch(url, init);
  };
  window.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
    }
    addEventListener() {}
    close() {}
  };
  window.navigator.geolocation = {
    watchPosition(success) {
      setTimeout(() => success({ coords: { latitude: 6.6018, longitude: 3.3515, accuracy: 20, speed: 8 } }), 10);
      return 1;
    },
    getCurrentPosition(success) {
      success({ coords: { latitude: 6.6018, longitude: 3.3515, accuracy: 20, speed: 8 } });
    },
    clearWatch() {},
  };
  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: { register: async () => ({ scope: '/' }), addEventListener() {} },
    configurable: true,
  });
  window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  window.HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new window.Event('close'));
  };
  window.HTMLElement.prototype.scrollIntoView ??= () => {};

  // Expose the browser globals the modules expect.
  for (const key of ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'EventSource', 'fetch', 'matchMedia', 'AbortController']) {
    if (window[key] === undefined) continue;
    // Some of these (navigator) are getter-only on the Node global object.
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  }

  await import('../public/js/app.js');
  await until(() => document.querySelector('#vehicleSelect option'), 'the app to finish booting');
});

after(async () => {
  dom?.window?.close();
  await server?.close();
  const { closeDb } = await import('../server/db/index.js');
  closeDb();
  temp.cleanup();
});

test('the shell boots and fills itself in from /api/meta', async () => {
  assert.ok(document.querySelectorAll('#vehicleSelect option').length >= 4, 'vehicles should come from the server');
  assert.ok(document.querySelectorAll('#typeGrid button').length >= 10, 'report types should come from the server');
  assert.ok(document.querySelectorAll('#categoryPills button').length >= 4, 'category filters should be built');
  await until(() => /\d/.test(document.querySelector('#chipReportsCount')?.textContent ?? ''), 'the report counter');
  assert.match(document.querySelector('#chipEngineText').textContent, /offline|live/i);
  assert.ok(globalThis.L.__state.map, 'a map should have been created');
});

test('every tab button has a matching view', () => {
  const tabs = [...document.querySelectorAll('.tab[role="tab"]')];
  assert.equal(tabs.length, 4);
  for (const tab of tabs) {
    const view = document.getElementById(tab.getAttribute('aria-controls'));
    assert.ok(view, `missing view for ${tab.id}`);
  }
});

test('switching tabs shows exactly one view', () => {
  document.querySelector('#tab-insights').click();
  const visible = [...document.querySelectorAll('.tab-body')].filter((p) => !p.hidden);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 'view-insights');
  assert.equal(document.querySelector('#tab-insights').getAttribute('aria-selected'), 'true');
  document.querySelector('#tab-plan').click();
  assert.equal(document.querySelector('#view-plan').hidden, false);
});

test('endpoint autocomplete queries the gazetteer and fills the field', async () => {
  const input = document.querySelector('#fromInput');
  input.value = 'ikeja';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const panel = await until(
    () => (document.querySelector('#fromSuggest button') ? document.querySelector('#fromSuggest') : null),
    'suggestions for "ikeja"',
  );
  assert.match(panel.textContent, /Ikeja/);
  assert.equal(panel.hidden, false);
  panel.querySelector('button').click();
  assert.match(input.value, /Ikeja/);
  assert.equal(panel.hidden, true);
});

test('planning a route renders cards, a safety score, hazards and fuel', async () => {
  const to = document.querySelector('#toInput');
  to.value = 'Ibadan';
  to.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => document.querySelector('#toSuggest button'), 'suggestions for "Ibadan"');
  document.querySelector('#toSuggest button').click();

  document.querySelector('#planBtn').click();

  const results = await until(
    () => (document.querySelector('#planResults .route-card') ? document.querySelector('#planResults') : null),
    'route cards to render',
    10000,
  );

  const card = results.querySelector('.route-card');
  assert.ok(card.classList.contains('selected'), 'the first route should start selected');
  assert.match(card.querySelector('.score-ring').textContent, /^\d+SAFETY$/);
  assert.match(card.querySelector('.big').textContent, /km/);
  assert.match(results.textContent, /fuel needed/);
  assert.match(results.textContent, /Pump price/);

  // The flooding/pothole reports we seeded sit on the way out of Ikeja.
  assert.ok(results.querySelector('.hazard-item'), 'hazards along the corridor should be listed');
  assert.ok(results.querySelector('.timeline-pip'), 'the hazard timeline should have pips');

  const drawn = globalThis.L.__state.attached();
  assert.ok(drawn.some((l) => l.kind === 'polyline'), 'a route polyline should be on the map');
  assert.ok(drawn.some((l) => l.kind === 'marker'), 'endpoint markers should be on the map');
});

test('the planned route unlocks the trip tab', () => {
  document.querySelector('#tab-trip').click();
  assert.equal(document.querySelector('#startTripBtn').disabled, false, 'a planned route should enable trip sharing');
});

test('report mode: the button arms the map and a tap opens the dialog', async () => {
  document.querySelector('#tab-reports').click();
  document.querySelector('#addReportBtn').click();

  // With no GPS fix yet the app asks you to tap the spot instead of guessing.
  assert.equal(document.querySelector('#reportModeBtn').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('#mapHint').hidden, false);

  const onMapClick = globalThis.L.__state.handlers.get('map:click');
  assert.ok(onMapClick, 'the map should listen for clicks');
  onMapClick({ latlng: { lat: 6.6018, lng: 3.3515 } });

  const dialog = document.querySelector('#reportDialog');
  assert.ok(dialog.hasAttribute('open'), 'tapping the map should open the report form');
  assert.equal(document.querySelector('#mapHint').hidden, true, 'the hint should clear once placed');
});

test('the report dialog switches its fields by type and posts', async () => {
  const dialog = document.querySelector('#reportDialog');

  dialog.querySelector('[data-type="fuel_available"]').click();
  assert.equal(document.querySelector('#fuelFields').hidden, false, 'fuel reports should reveal price and queue');

  const flooding = dialog.querySelector('[data-type="flooding"]');
  flooding.click();
  assert.equal(flooding.getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('#fuelFields').hidden, true);

  // Severity buttons are single-select.
  dialog.querySelector('[data-severity="3"]').click();
  const pressed = [...dialog.querySelectorAll('#severityRow button')].filter((b) => b.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1);
  assert.equal(pressed[0].dataset.severity, '3');

  document.querySelector('#reportNoteInput').value = 'Knee deep at the junction';
  const before = (await server.call('/api/reports?limit=200')).body.reports.length;
  document.querySelector('#reportForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await until(
    async () => (await server.call('/api/reports?limit=200')).body.reports.length > before,
    'the report to reach the server',
    6000,
  );
  const { body } = await server.call('/api/reports?limit=200');
  const posted = body.reports.find((r) => r.note === 'Knee deep at the junction');
  assert.ok(posted, 'the note should have been saved');
  assert.equal(posted.type, 'flooding');
  assert.equal(posted.severity, 3);
  assert.equal(dialog.hasAttribute('open'), false, 'the dialog should close on success');
});

test('the reports list renders what is in view', async () => {
  const list = await until(
    () => (document.querySelector('#reportsList .report-row, #reportsList .card') ? document.querySelector('#reportsList') : null),
    'the report list to populate',
    6000,
  );
  assert.match(list.textContent, /ago|now|min|hour/i);
});

test('insights renders real aggregates', async () => {
  document.querySelector('#tab-insights').click();
  const body = await until(() => {
    const node = document.querySelector('#insightsBody');
    return node && node.querySelector('.stat-grid') ? node : null;
  }, 'insights to load', 8000);
  assert.match(body.textContent, /active reports/i);
  assert.ok(body.querySelector('.bar-row'), 'the breakdown bars should render');
});

test('the assistant answers in the panel', async () => {
  document.querySelector('#assistantFab').click();
  assert.equal(document.querySelector('#assistant').hidden, false);
  const input = document.querySelector('#assistantInput');
  const before = document.querySelectorAll('#assistantLog .msg.bot').length;
  input.value = 'how far from Ikeja to Ibadan?';
  document.querySelector('#assistantForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const reply = await until(() => {
    const bubbles = [...document.querySelectorAll('#assistantLog .msg.bot')].filter((b) => !b.classList.contains('thinking'));
    return bubbles.length > before ? bubbles[bubbles.length - 1] : null;
  }, 'an assistant reply', 8000);
  assert.match(reply.textContent, /km|Ibadan/i);
  assert.ok(document.querySelectorAll('#assistantSuggest button').length >= 3, 'suggestion chips should be offered');
});

test('the locate button starts a watch and draws the user', async () => {
  document.querySelector('#locateBtn').click();
  assert.equal(document.querySelector('#locateBtn').getAttribute('aria-pressed'), 'true');
  const drawn = await until(
    () => {
      const layers = globalThis.L.__state.attached();
      return layers.some((l) => l.kind === 'circle') ? layers : null;
    },
    'the accuracy circle to be drawn',
  );
  assert.ok(drawn.some((l) => l.kind === 'circle'));
  // Clicking again turns it off.
  document.querySelector('#locateBtn').click();
  assert.equal(document.querySelector('#locateBtn').getAttribute('aria-pressed'), 'false');
});

test('starting a shared trip produces a code and a guardian link', async () => {
  document.querySelector('#tab-trip').click();
  document.querySelector('#travellerInput').value = 'Ada';
  document.querySelector('#tripNote').value = 'Blue Corolla';
  document.querySelector('#startTripBtn').click();

  const active = await until(
    () => (document.querySelector('#tripActive .code-display') ? document.querySelector('#tripActive') : null),
    'the trip card to render',
    8000,
  );
  const code = active.querySelector('.code-display').textContent.trim();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(document.querySelector('#tripStart').hidden, true, 'the start form should give way to the live card');

  const { status, body } = await server.call(`/api/trips/${code}`);
  assert.equal(status, 200);
  assert.equal(body.trip.traveller, 'Ada');
  assert.equal(body.trip.note, 'Blue Corolla');
  assert.equal(body.trip.status, 'active');
});

test('the guardian page renders that trip on its own', async () => {
  const code = document.querySelector('#tripActive .code-display').textContent.trim();
  const html = readFileSync(new URL('../public/track.html', import.meta.url), 'utf8');
  const watcher = new JSDOM(html, { url: `${server.base}/t/${code}`, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = watcher.window;
  installFakeLeaflet(w);
  w.fetch = (input, init) => nodeFetch(new URL(input, server.base).toString(), init);
  for (const key of ['window', 'document', 'location', 'fetch', 'Event', 'CustomEvent', 'HTMLElement', 'Node']) {
    Object.defineProperty(globalThis, key, { value: w[key], configurable: true, writable: true });
  }
  await import(`../public/js/track.js?watch=${code}`);
  const side = await until(() => {
    const node = w.document.querySelector('#side');
    return node && node.querySelector('.countdown, .hero') ? node : null;
  }, 'the watch page to render', 8000);
  assert.match(side.textContent, /Ada/);
  assert.match(side.textContent, /On the way|Arrived|Overdue/);
  assert.match(side.textContent, new RegExp(code));
  watcher.window.close();

  // Put the main window's globals back for the remaining tests.
  for (const key of ['window', 'document', 'location', 'fetch', 'Event', 'CustomEvent', 'HTMLElement', 'Node']) {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  }
});

test('"use my location" fills the From field from GPS', async () => {
  document.querySelector('#tab-plan').click();
  const from = document.querySelector('#fromInput');
  from.value = '';
  document.querySelector('#useMyLocationBtn').click();
  await until(() => from.value.length > 3, 'the From field to be filled from GPS', 6000);
  assert.match(from.value, /Ikeja|Lagos|6\.60/);
  assert.ok(document.querySelector('#useMyLocationBtn').querySelector('svg'), 'the button icon should survive');
});

test('the reports list explains what it is showing', async () => {
  document.querySelector('#tab-reports').click();
  await until(() => document.querySelector('#reportsScope').textContent.trim().length > 3, 'the scope label');
  assert.match(document.querySelector('#reportsScope').textContent, /street|neighbourhood|area|region|country/);
  assert.match(document.querySelector('#reportsCountMeta').textContent, /\d+ shown/);
});

test('every element the modules reach for exists in the page', () => {
  const ids = [
    'map', 'fromInput', 'toInput', 'fromSuggest', 'toSuggest', 'vehicleSelect', 'departInput', 'tankRange',
    'tankValue', 'planBtn', 'planStatus', 'planResults', 'swapBtn', 'useMyLocationBtn', 'clearRouteBtn',
    'addReportBtn', 'categoryPills', 'reportsList', 'reportsCountMeta', 'reportsScope',
    'reportDialog', 'reportForm', 'typeGrid', 'severityRow', 'fuelFields', 'fuelPrice', 'fuelQueue',
    'reportNoteInput', 'reportLabelInput', 'reporterInput', 'reportLocation', 'reportCancel', 'reportSubmit',
    'tripActive', 'tripStart', 'travellerInput', 'tripNote', 'startTripBtn', 'tripStartHint',
    'watchCode', 'watchBtn', 'watchPanel', 'insightsBody',
    'assistant', 'assistantFab', 'assistantClose', 'assistantLog', 'assistantInput', 'assistantForm',
    'assistantSuggest', 'assistantMode', 'toasts', 'chipEngine', 'chipEngineText', 'chipReports',
    'chipReportsCount', 'chipLive', 'chipLiveText', 'liveDot', 'aboutDialog', 'aboutBtn', 'aboutBody',
    'aboutClose', 'installBtn', 'mapLegend', 'mapHint', 'mapHintText', 'mapHintCancel',
    'locateBtn', 'reportModeBtn', 'heatBtn', 'basemapBtn', 'mobileHandle',
  ];
  const missing = ids.filter((id) => !document.getElementById(id));
  assert.deepEqual(missing, [], `missing elements: ${missing.join(', ')}`);
});

test('the service worker precache list only names files that exist', async () => {
  const { readFileSync: read, existsSync } = await import('node:fs');
  const sw = read(new URL('../public/sw.js', import.meta.url), 'utf8');
  const list = sw.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  const paths = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p !== '/');
  for (const path of paths) {
    assert.ok(existsSync(new URL(`../public${path}`, import.meta.url)), `sw.js precaches ${path} which does not exist`);
  }
});
