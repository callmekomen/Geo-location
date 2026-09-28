/** Application bootstrap: wiring, live data, geolocation, PWA plumbing. */

import { $, $$, el, fmt, toast, escapeHtml } from './util.js';
import { api, outbox, connectStream } from './api.js';
import { state, setState, subscribe, loadSession, saveSession } from './store.js';
import { mapview, setReportMode } from './mapview.js';
import { initPlan, populateVehicles, renderResults } from './plan.js';
import { initReports, refreshReports, ingestLiveReport, openReportDialog } from './reports.js';
import { initTrips, updateTripAvailability, renderActiveTrip } from './trips.js';
import { renderInsights } from './insights.js';
import { initAssistant } from './assistant.js';

/* -------------------------------------------------------------------- tabs */
function initTabs() {
  const tabs = $$('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((other) => {
        const selected = other === tab;
        other.setAttribute('aria-selected', String(selected));
        const view = document.getElementById(other.getAttribute('aria-controls'));
        if (view) view.hidden = !selected;
      });
      if (tab.id === 'tab-insights') renderInsights();
      if (tab.id === 'tab-reports') refreshReports();
      if (tab.id === 'tab-trip') updateTripAvailability();
      $('#panel').classList.remove('collapsed');
    });
  });

  $('#mobileHandle').addEventListener('click', () => $('#panel').classList.toggle('collapsed'));
}

/* ------------------------------------------------------------- geolocation */
let watchId = null;

function stopWatching() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  setState({ watchingPosition: false });
  $('#locateBtn').setAttribute('aria-pressed', 'false');
}

function startWatching({ centre = true } = {}) {
  if (!navigator.geolocation) {
    toast('This browser has no location support', { tone: 'bad' });
    return;
  }
  if (watchId !== null) {
    stopWatching();
    mapview.setMyPosition(null);
    return;
  }

  $('#locateBtn').setAttribute('aria-pressed', 'true');
  setState({ watchingPosition: true });

  // Embedded previews sometimes never answer the permission prompt at all.
  let answered = false;
  const nudge = setTimeout(() => {
    if (!answered) {
      toast('No response from location services', {
        tone: 'bad',
        detail: 'Embedded previews often block GPS — open the app in its own tab.',
        timeout: 9000,
      });
    }
  }, 9000);

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      answered = true;
      clearTimeout(nudge);
      const position = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        speedKph: pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) : null,
        at: new Date().toISOString(),
      };
      const first = !state.position;
      setState({ position });
      mapview.setMyPosition(position);
      if (first && centre) mapview.flyTo(position.lat, position.lon, 12);
    },
    (error) => {
      answered = true;
      clearTimeout(nudge);
      stopWatching();
      toast(`Location unavailable: ${error.message}`, { tone: 'bad' });
    },
    { enableHighAccuracy: true, maximumAge: 8000, timeout: 20000 },
  );
}

/**
 * Resolve the current position once, starting the watch if it is not running.
 * Used by "Use my location" so the button works before the user has tapped
 * the locate tool.
 */
function currentPosition() {
  if (state.position) {
    if (watchId === null) startWatching({ centre: false });
    return Promise.resolve(state.position);
  }
  if (!navigator.geolocation) return Promise.reject(new Error('This browser has no location support'));
  if (watchId === null) startWatching({ centre: false });
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const position = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speedKph: pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) : null,
          at: new Date().toISOString(),
        };
        setState({ position });
        mapview.setMyPosition(position);
        resolve(position);
      },
      (error) => reject(new Error(error.message || 'Location unavailable')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  });
}

/* --------------------------------------------------------------- live feed */
function initStream() {
  const dot = $('#liveDot');
  const text = $('#chipLiveText');

  connectStream({
    onOpen() {
      setState({ live: true });
      dot.className = 'dot live';
      text.textContent = 'Live';
    },
    onError() {
      setState({ live: false });
      dot.className = 'dot offline';
      text.textContent = 'Reconnecting';
    },
    onEvent(topic, event) {
      const payload = event.payload ?? {};
      if (topic === 'report:new' || topic === 'report:confirmed') {
        ingestLiveReport(payload);
        if (topic === 'report:new') {
          toast(`New report: ${payload.typeLabel}`, { detail: payload.road ?? payload.place ?? '', tone: '' });
        }
      } else if (topic === 'report:updated') {
        ingestLiveReport(payload);
      } else if (topic === 'trip:sos') {
        toast(`SOS from ${payload.traveller ?? 'a traveller'}`, { tone: 'bad', detail: payload.place ?? '', timeout: 15000 });
      } else if (topic === 'trip:overdue' && state.watched?.trip?.code === payload.code) {
        toast(`${payload.traveller ?? 'Traveller'} is overdue`, { tone: 'bad' });
      }
    },
  });
}

/* ------------------------------------------------------------ connectivity */
function initConnectivity() {
  const sync = async () => {
    const online = navigator.onLine;
    setState({ online });
    if (online && outbox.size()) {
      const { sent } = await outbox.flush();
      if (sent) {
        toast(`Published ${sent} queued report${sent > 1 ? 's' : ''}`, { tone: 'good' });
        refreshReports();
      }
    }
    if (!online) toast('You are offline — reports will be queued', { tone: 'bad' });
  };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  if (outbox.size()) sync();
}

/* ------------------------------------------------------------------- about */
function initAbout(meta) {
  const body = $('#aboutBody');
  body.innerHTML = `
    <p class="hint">Naija Routes turns what drivers actually see on Nigerian roads into something the next driver can use: live hazard and fuel reports, route-level risk scoring, and safe-arrival trip sharing.</p>
    <div class="kv"><span>Routing engine</span><b>${meta.upstream.osrm.available ? 'OSRM (live roads)' : 'Built-in offline graph'}</b></div>
    <div class="kv"><span>Offline network</span><b>${meta.network.edges} roads · ${meta.network.networkKm.toLocaleString()} km</b></div>
    <div class="kv"><span>Gazetteer</span><b>${meta.gazetteer.placeCount} places · ${meta.gazetteer.stateCount} states</b></div>
    <div class="kv"><span>Geocoder</span><b>${meta.upstream.nominatim.available ? 'Nominatim + offline' : 'Offline gazetteer'}</b></div>
    <div class="kv"><span>Assistant</span><b>${meta.assistant.mode === 'builtin' ? 'Built-in reasoning (no API key)' : meta.assistant.mode}</b></div>
    <div class="kv"><span>Reports stored</span><b>${meta.reports.total}</b></div>
    <p class="hint" style="margin-top:14px">Map data © OpenStreetMap contributors. Community reports are public and anonymous — please do not post anything you would not shout across a motor park.</p>
    <p class="hint">Keyboard: <b>/</b> opens the assistant, <b>Esc</b> closes panels.</p>
  `;
  $('#aboutBtn').addEventListener('click', () => $('#aboutDialog').showModal());
  $('#aboutClose').addEventListener('click', () => $('#aboutDialog').close());
}

/* --------------------------------------------------------------- map tools */
function initMapTools() {
  $('#locateBtn').addEventListener('click', () => startWatching());
  $('#reportModeBtn').addEventListener('click', () => setReportMode(!state.reportMode));
  $('#mapHintCancel').addEventListener('click', () => setReportMode(false));

  let hotspotsOn = false;
  $('#heatBtn').addEventListener('click', async (event) => {
    hotspotsOn = !hotspotsOn;
    event.currentTarget.setAttribute('aria-pressed', String(hotspotsOn));
    if (!hotspotsOn) return mapview.clearHotspots();
    try {
      const { hotspots } = await api.hotspots(30);
      mapview.renderHotspots(hotspots);
      toast(`${hotspots.length} hotspots over the last 30 days`);
    } catch {
      toast('Could not load hotspots', { tone: 'bad' });
    }
  });

  $('#basemapBtn').addEventListener('click', () => {
    const spec = mapview.cycleBasemap();
    toast(`Basemap: ${spec.name}`);
  });

  // Right-click / long-press the map to set route endpoints quickly.
  mapview.map.on('contextmenu', async (event) => {
    const point = { lat: event.latlng.lat, lon: event.latlng.lng };
    const label = await api
      .reverse(point.lat, point.lon)
      .then((r) => r.label)
      .catch(() => `${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}`);
    const menu = L.popup({ closeButton: false })
      .setLatLng(event.latlng)
      .setContent(
        (() => {
          const wrap = el('div', {}, [
            el('div', { class: 'popup-title', text: 'Use this point' }),
            el('div', { class: 'popup-meta', text: label }),
            el('div', { class: 'popup-actions' }, [
              el('button', {
                text: 'Start here',
                onclick: () => {
                  setState({ from: { ...point, label } });
                  $('#fromInput').value = label;
                  mapview.map.closePopup();
                },
              }),
              el('button', {
                text: 'End here',
                onclick: () => {
                  setState({ to: { ...point, label } });
                  $('#toInput').value = label;
                  mapview.map.closePopup();
                },
              }),
              el('button', {
                text: 'Report',
                onclick: () => {
                  mapview.map.closePopup();
                  openReportDialog(point);
                },
              }),
            ]),
          ]);
          return wrap;
        })(),
      );
    menu.openOn(mapview.map);
  });
}

/**
 * <dialog> is not everywhere yet: iOS Safari only got showModal() in 15.4 and
 * old Android WebViews never will. A lot of this app's users are on exactly
 * those devices, so fall back to a plain overlay rather than silently doing
 * nothing when someone taps "Add a report".
 */
function ensureDialogSupport() {
  if (typeof window.HTMLDialogElement === 'function' && typeof window.HTMLDialogElement.prototype.showModal === 'function') {
    return;
  }
  for (const dialog of $$('dialog')) {
    dialog.showModal = function showModal() {
      this.setAttribute('open', '');
      this.classList.add('dialog-fallback');
    };
    dialog.close = function close(value) {
      this.removeAttribute('open');
      this.classList.remove('dialog-fallback');
      if (value !== undefined) this.returnValue = value;
      this.dispatchEvent(new Event('close'));
    };
  }
}

/* -------------------------------------------------------------------- PWA */
function initPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('#installBtn').hidden = true;
  });
}

/* ------------------------------------------------------------------- boot */
async function boot() {
  loadSession();
  mapview.init('map');
  ensureDialogSupport();
  initTabs();
  initMapTools();
  initPwa();
  initConnectivity();

  let meta;
  try {
    meta = await api.meta();
  } catch (error) {
    toast('Could not reach the server', { tone: 'bad', detail: error.message });
    return;
  }

  setState({ meta });
  populateVehicles(meta);
  initPlan({
    onRoutePlanned: () => {
      updateTripAvailability();
    },
    onRequestPosition: currentPosition,
  });
  initReports(meta);
  initTrips();
  initAssistant(meta);
  initAbout(meta);
  initStream();

  const engineChip = $('#chipEngineText');
  engineChip.textContent = meta.upstream.osrm.available ? 'Live roads' : 'Offline engine';
  $('#chipEngine').title = meta.upstream.osrm.available
    ? 'Routing via OSRM with community data layered on top'
    : `Routing with the built-in Nigerian road graph (${meta.network.edges} roads, ${meta.network.networkKm.toLocaleString()} km)`;
  $('#chipReportsCount').textContent = meta.reports.active;

  await refreshReports();

  subscribe('plan', () => updateTripAvailability());
  subscribe('trip', (trip) => renderActiveTrip(trip));

  // Deep link: /?from=Ikeja&to=Benin%20City
  const params = new URLSearchParams(location.search);
  if (params.get('from') && params.get('to')) {
    $('#fromInput').value = params.get('from');
    $('#toInput').value = params.get('to');
    $('#planBtn').click();
  }

  if (meta.live.sos) {
    toast(`${meta.live.sos} active SOS signal${meta.live.sos > 1 ? 's' : ''}`, { tone: 'bad', timeout: 12000 });
  }
}

boot();
