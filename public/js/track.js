/**
 * The public trip-watch page.
 *
 * Deliberately simple: someone worried about a traveller should learn what
 * they need within two seconds of the page loading.
 */

import { $, el, fmt, glyph, toast } from './util.js';

const code = location.pathname.split('/').filter(Boolean).pop()?.toUpperCase();

const map = L.map('trackMap', { zoomControl: false }).setView([9, 8.1], 6);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
let tileErrors = 0;
tiles.on('tileerror', () => {
  tileErrors += 1;
  if (tileErrors === 6) {
    map.removeLayer(tiles);
    document.getElementById('trackMap').style.background =
      'repeating-linear-gradient(45deg, #1a1c20 0 12px, #1d1f24 12px 24px)';
  }
});

const layers = {
  route: L.layerGroup().addTo(map),
  crumbs: L.layerGroup().addTo(map),
  marks: L.layerGroup().addTo(map),
};

let fitted = false;

function countdown(trip) {
  if (trip.status === 'arrived') {
    return el('div', { class: 'countdown' }, [el('span', { text: 'Arrived' }), el('small', { text: `at ${fmt.dayTime(trip.endedAt ?? trip.updatedAt)}` })]);
  }
  if (!trip.eta) return null;
  const diffMin = Math.round((new Date(trip.eta).getTime() - Date.now()) / 60000);
  const late = diffMin < 0;
  return el('div', { class: `countdown ${late ? 'late' : ''}` }, [
    el('span', { text: late ? `${fmt.minutes(Math.abs(diffMin))} late` : fmt.minutes(Math.max(0, diffMin)) }),
    el('small', { text: late ? `expected ${fmt.dayTime(trip.eta)}` : `until arrival · eta ${fmt.dayTime(trip.eta)}` }),
  ]);
}

function statusBadge(trip) {
  if (trip.sos) return el('span', { class: 'badge bad', text: 'Emergency signal' });
  if (trip.status === 'arrived') return el('span', { class: 'badge ok', text: 'Arrived safely' });
  if (trip.status === 'cancelled') return el('span', { class: 'badge mute', text: 'Sharing stopped' });
  if (trip.overdue || trip.status === 'overdue') return el('span', { class: 'badge bad', text: 'Overdue' });
  return el('span', { class: 'badge ok', text: 'On the way' });
}

function render(data) {
  const { trip, safety, events, breadcrumbs } = data;
  const side = $('#side');

  const nodes = [];

  if (trip.sos) {
    nodes.push(
      el('div', { class: 'sos-banner' }, [
        el('div', { text: `${trip.traveller} raised an emergency signal.` }),
        el('div', {
          style: { fontWeight: '400', marginTop: '4px', fontSize: '12.5px' },
          text: trip.position ? `Last known position: ${trip.position.lat.toFixed(4)}, ${trip.position.lon.toFixed(4)}` : 'No position recorded yet.',
        }),
      ]),
    );
  }

  nodes.push(
    el('div', { class: 'hero' }, [
      statusBadge(trip),
      el('div', { class: 'who', text: trip.traveller }),
      el('div', { class: 'leg', text: `${trip.from.label} → ${trip.to.label}` }),
      countdown(trip),
    ]),
    el('div', { class: 'progress-track' }, [el('i', { style: { width: `${Math.round(trip.progress * 100)}%` } })]),
    el('div', { class: 'card' }, [
      el('div', { class: 'kv' }, [el('span', { text: 'Progress' }), el('b', { text: `${Math.round(trip.progress * 100)}%` })]),
      el('div', { class: 'kv' }, [el('span', { text: 'Distance left' }), el('b', { text: fmt.km(trip.remainingM) })]),
      el('div', { class: 'kv' }, [el('span', { text: 'Total journey' }), el('b', { text: fmt.km(trip.distanceM) })]),
      el('div', { class: 'kv' }, [el('span', { text: 'Started' }), el('b', { text: fmt.dayTime(trip.startedAt) })]),
      el('div', { class: 'kv' }, [
        el('span', { text: 'Last position' }),
        el('b', { text: trip.position ? fmt.ago(trip.position.at) : 'not yet reported' }),
      ]),
      trip.position?.speedKph != null
        ? el('div', { class: 'kv' }, [el('span', { text: 'Speed' }), el('b', { text: `${trip.position.speedKph} km/h` })])
        : null,
    ]),
  );

  if (trip.note) {
    nodes.push(el('div', { class: 'advisory info' }, [el('div', {}, [el('strong', { text: 'Note from the traveller' }), el('p', { text: trip.note })])]));
  }

  if (safety?.ahead?.length) {
    nodes.push(
      el('div', { class: 'section-head' }, [
        el('h2', { text: 'Road ahead' }),
        el('span', { class: 'meta', text: `safety ${safety.score}/100` }),
      ]),
      el(
        'div',
        { class: 'card' },
        safety.ahead.map((hazard) =>
          el('div', { class: 'hazard-item', onclick: () => map.setView([hazard.lat, hazard.lon], 12) }, [
            el('div', { class: 'hz-mark', style: { background: `${hazard.colour}22`, color: hazard.colour }, text: glyph(hazard.icon) }),
            el('div', { class: 'hz-body' }, [
              el('div', { class: 'hz-title', text: hazard.label || hazard.typeLabel }),
              el('div', { class: 'hz-meta', text: `${hazard.road ?? hazard.place ?? ''} · ${fmt.ago(hazard.createdAt)}` }),
            ]),
            el('div', { class: 'hz-dist', text: `${Math.round(hazard.alongM / 1000)} km` }),
          ]),
        ),
      ),
    );
  }

  if (events?.length) {
    nodes.push(
      el('div', { class: 'section-head' }, [el('h2', { text: 'Timeline' })]),
      el(
        'div',
        { class: 'card' },
        events.map((event) =>
          el('div', { class: 'event-item' }, [
            el('span', { class: 't', text: fmt.clock(event.createdAt) }),
            el('span', { text: event.message ?? event.kind }),
          ]),
        ),
      ),
    );
  }

  nodes.push(
    el('p', { class: 'hint', style: { marginTop: '16px' }, text: `Trip code ${trip.code}. This page refreshes itself every 15 seconds.` }),
  );

  side.replaceChildren(...nodes);

  /* ------------------------------------------------------------- map ---- */
  layers.route.clearLayers();
  layers.crumbs.clearLayers();
  layers.marks.clearLayers();

  if (trip.geometry?.length > 1) {
    L.polyline(trip.geometry, { color: '#8b6fd4', weight: 5, opacity: 0.55, dashArray: '10 8' }).addTo(layers.route);
  }
  if (breadcrumbs?.length > 1) {
    L.polyline(breadcrumbs, { color: '#ffc328', weight: 5, opacity: 0.95 }).addTo(layers.crumbs);
  }

  const endpoint = (point, letter) =>
    L.marker(point, {
      icon: L.divIcon({ className: '', html: `<div class="marker-endpoint">${letter}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(layers.marks);
  endpoint([trip.from.lat, trip.from.lon], 'A');
  endpoint([trip.to.lat, trip.to.lon], 'B');

  if (trip.position) {
    L.marker([trip.position.lat, trip.position.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div class="marker-pin" style="background:${trip.sos ? '#e2543c' : '#ffc328'}"><span>🚘</span></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 24],
      }),
      zIndexOffset: 900,
    })
      .bindTooltip(`${trip.traveller} · ${fmt.ago(trip.position.at)}`, { direction: 'top', offset: [0, -22] })
      .addTo(layers.marks);
  }

  if (!fitted) {
    const points = [
      [trip.from.lat, trip.from.lon],
      [trip.to.lat, trip.to.lon],
      ...(trip.geometry ?? []),
    ];
    map.invalidateSize();
    map.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 13 });
    fitted = true;
  }

  $('#refreshedAt').textContent = `updated ${fmt.clock(new Date().toISOString())}`;
}

let lastSos = false;

async function poll() {
  try {
    const res = await fetch(`/api/trips/${code}`);
    if (!res.ok) throw new Error((await res.json()).error ?? 'Trip not found');
    const data = await res.json();
    render(data);
    if (data.trip.sos && !lastSos) {
      lastSos = true;
      toast('Emergency signal raised on this trip', { tone: 'bad', timeout: 20000 });
    }
    if (!data.trip.sos) lastSos = false;
  } catch (error) {
    $('#side').replaceChildren(
      el('div', { class: 'empty', html: `${error.message}<br><br>Check the six-character code and try again.` }),
    );
  }
}

if (!code || code.length !== 6) {
  $('#side').replaceChildren(el('div', { class: 'empty', text: 'That does not look like a trip code.' }));
} else {
  poll();
  setInterval(poll, 15000);
}
