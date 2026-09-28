/**
 * The same front end, but driven against the REAL Leaflet build.
 *
 * ui.test.js uses a stubbed Leaflet so it can assert on what the app *asked*
 * the map to draw. That cannot catch a call the real library would reject, so
 * this file loads public/vendor/leaflet/leaflet.js into the jsdom window and
 * checks that actual panes, paths and markers end up in the DOM.
 *
 * It also exercises the <dialog> fallback: jsdom has no showModal(), which is
 * exactly the situation on iOS Safari before 15.4 and on old Android WebViews.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { useTempDatabase, startTestServer } from './helpers.js';

const temp = useTempDatabase();
let server;
let window;
let document;
let dom;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, message, timeout = 8000) {
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
  await server.call('/api/reports', {
    method: 'POST',
    body: { type: 'pothole', lat: 6.6018, lon: 3.3515, note: 'Crater by the bus stop', severity: 3 },
  });

  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  dom = new JSDOM(html, { url: `${server.base}/`, pretendToBeVisual: true, runScripts: 'dangerously' });
  window = dom.window;
  document = window.document;

  // The real library, evaluated inside the page.
  window.eval(readFileSync(new URL('../public/vendor/leaflet/leaflet.js', import.meta.url), 'utf8'));

  const nodeFetch = globalThis.fetch;
  window.fetch = (input, init) => nodeFetch(new URL(input, server.base).toString(), init);
  window.EventSource = class {
    constructor(url) {
      this.url = url;
    }
    addEventListener() {}
    close() {}
  };
  window.navigator.geolocation = {
    watchPosition(success) {
      setTimeout(() => success({ coords: { latitude: 6.6018, longitude: 3.3515, accuracy: 25, speed: 8 } }), 10);
      return 1;
    },
    getCurrentPosition(success) {
      success({ coords: { latitude: 6.6018, longitude: 3.3515, accuracy: 25 } });
    },
    clearWatch() {},
  };
  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: { register: async () => ({ scope: '/' }), addEventListener() {} },
    configurable: true,
  });
  window.HTMLElement.prototype.scrollIntoView ??= () => {};

  for (const key of ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'EventSource', 'fetch', 'matchMedia', 'AbortController', 'L', 'SVGElement', 'Image', 'MouseEvent', 'KeyboardEvent', 'XMLHttpRequest']) {
    if (window[key] !== undefined) Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  }

  await import(`../public/js/app.js?real-leaflet=${Date.now()}`);
  await until(() => document.querySelector('#vehicleSelect option'), 'the app to boot');
});

after(async () => {
  dom?.window?.close();
  await server?.close();
  const { closeDb } = await import('../server/db/index.js');
  closeDb();
  temp.cleanup();
});

test('the vendored Leaflet is the version we expect and builds a real map', () => {
  assert.equal(window.L.version, '1.9.4');
  assert.ok(document.querySelectorAll('.leaflet-pane').length >= 6, 'Leaflet should have created its panes');
  assert.ok(document.querySelector('#map').classList.contains('leaflet-container'));
});

test('planning a route puts real SVG paths and markers on the map', async () => {
  const type = (selector, value) => {
    const node = document.querySelector(selector);
    node.value = value;
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  type('#fromInput', 'Ikeja');
  type('#toInput', 'Ibadan');
  await until(() => document.querySelector('#fromSuggest button') && document.querySelector('#toSuggest button'), 'suggestions');
  document.querySelector('#fromSuggest button').click();
  document.querySelector('#toSuggest button').click();
  document.querySelector('#planBtn').click();

  await until(() => document.querySelector('#planResults .route-card'), 'the route to render', 10000);

  const paths = document.querySelectorAll('#map path');
  assert.ok(paths.length >= 2, `expected the route casing and line, got ${paths.length} paths`);
  assert.ok(document.querySelectorAll('#map .leaflet-marker-icon').length >= 2, 'A and B markers should exist');

  // Hazards found along the corridor must also be drawn.
  assert.ok(document.querySelector('#planResults .hazard-item'), 'the pothole should be listed');
});

test('the map tools all survive contact with the real library', async () => {
  const before = document.querySelectorAll('#map path').length;

  document.querySelector('#locateBtn').click();
  await until(() => document.querySelectorAll('#map path').length > before, 'the accuracy circle');

  document.querySelector('#heatBtn').click();
  await sleep(600);
  assert.equal(document.querySelector('#heatBtn').getAttribute('aria-pressed'), 'true');

  // Cycling basemaps must not throw or wipe the overlays.
  const paths = document.querySelectorAll('#map path').length;
  document.querySelector('#basemapBtn').click();
  document.querySelector('#basemapBtn').click();
  document.querySelector('#basemapBtn').click();
  assert.equal(document.querySelectorAll('#map path').length, paths, 'overlays should survive a basemap switch');
  assert.ok(document.querySelectorAll('.leaflet-tile-pane').length >= 1);
});

test('the report dialog still opens where <dialog> is unsupported', async () => {
  // jsdom has no showModal(), same as iOS Safari before 15.4.
  assert.equal(typeof window.HTMLDialogElement?.prototype?.showModal, 'undefined', 'this test is pointless if jsdom gains dialog support');

  document.querySelector('#tab-reports').click();
  document.querySelector('#addReportBtn').click();
  const onMapClick = { lat: 6.6018, lng: 3.3515 };
  window.__nrMap?.fire?.('click', { latlng: onMapClick });

  // Report mode is armed by the button; the map click is what opens the form.
  const dialog = document.querySelector('#reportDialog');
  if (!dialog.hasAttribute('open')) {
    // Fire a genuine Leaflet click event through the map instance.
    const mapview = await import('../public/js/mapview.js');
    mapview.mapview.map.fire('click', { latlng: onMapClick });
  }
  await until(() => document.querySelector('#reportDialog').hasAttribute('open'), 'the dialog to open via the fallback');
  assert.ok(dialog.classList.contains('dialog-fallback'), 'the fallback overlay class should be applied');

  document.querySelector('#reportCancel').click();
  await until(() => !document.querySelector('#reportDialog').hasAttribute('open'), 'the dialog to close');
  assert.equal(dialog.classList.contains('dialog-fallback'), false);
});
