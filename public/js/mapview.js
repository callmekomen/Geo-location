/**
 * Everything Leaflet.
 *
 * Basemaps degrade gracefully: if tile servers cannot be reached (offline, or
 * a locked-down network) the map falls back to a plain canvas and the vector
 * data — routes, reports, hotspots — still works perfectly.
 */

import { el, glyph, fmt, escapeHtml, toast } from './util.js';
import { state, setState } from './store.js';

const NIGERIA_CENTRE = [9.0, 8.1];

const BASEMAPS = [
  {
    id: 'streets',
    name: 'Streets',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' },
  },
  {
    id: 'dark',
    name: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 19, subdomains: 'abcd', attribution: '&copy; OpenStreetMap, &copy; CARTO' },
  },
  { id: 'plain', name: 'Plain (offline)', url: null, options: {} },
];

export const mapview = {
  map: null,
  layers: {},
  markers: new Map(),
  basemapIndex: 0,
  tileLayer: null,
  onReportPoint: null,
  onHazardFocus: null,

  init(containerId = 'map') {
    this.map = L.map(containerId, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: false,
    }).setView(NIGERIA_CENTRE, 6);

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);

    this.layers = {
      hotspots: L.layerGroup().addTo(this.map),
      routes: L.layerGroup().addTo(this.map),
      reports: L.layerGroup().addTo(this.map),
      endpoints: L.layerGroup().addTo(this.map),
      trip: L.layerGroup().addTo(this.map),
      me: L.layerGroup().addTo(this.map),
    };

    this.setBasemap(0);

    this.map.on('click', (event) => {
      if (!state.reportMode) return;
      this.onReportPoint?.({ lat: event.latlng.lat, lon: event.latlng.lng });
    });

    return this.map;
  },

  setBasemap(index) {
    this.basemapIndex = ((index % BASEMAPS.length) + BASEMAPS.length) % BASEMAPS.length;
    const spec = BASEMAPS[this.basemapIndex];
    if (this.tileLayer) {
      this.map.removeLayer(this.tileLayer);
      this.tileLayer = null;
    }
    if (!spec.url) {
      document.getElementById('map').style.background =
        'repeating-linear-gradient(45deg, #1a1c20 0 12px, #1d1f24 12px 24px)';
      return spec;
    }
    let errors = 0;
    this.tileLayer = L.tileLayer(spec.url, spec.options);
    this.tileLayer.on('tileerror', () => {
      errors += 1;
      if (errors === 6 && this.basemapIndex !== 2) {
        toast('Map tiles unavailable — switched to offline basemap', { tone: 'bad' });
        this.setBasemap(2);
      }
    });
    this.tileLayer.addTo(this.map);
    this.tileLayer.bringToBack();
    return spec;
  },

  cycleBasemap() {
    return this.setBasemap(this.basemapIndex + 1);
  },

  basemapName() {
    return BASEMAPS[this.basemapIndex].name;
  },

  /* ---------------------------------------------------------- reports --- */
  renderReports(reports, { onVote } = {}) {
    this.layers.reports.clearLayers();
    this.markers.clear();
    for (const report of reports) {
      const marker = L.marker([report.lat, report.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div class="marker-pin" style="background:${report.colour}"><span>${glyph(report.icon)}</span></div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 24],
          popupAnchor: [0, -22],
        }),
        riseOnHover: true,
        title: report.typeLabel,
      });
      marker.bindPopup(() => this.reportPopup(report, onVote), { maxWidth: 280 });
      marker.addTo(this.layers.reports);
      this.markers.set(report.id, marker);
    }
  },

  reportPopup(report, onVote) {
    const confidence = Math.round(report.confidence * 100);
    const wrap = el('div', {}, [
      el('div', { class: 'popup-title' }, [
        el('span', { text: glyph(report.icon) }),
        el('span', { text: report.label || report.typeLabel }),
      ]),
      el('div', {
        class: 'popup-meta',
        html: `${escapeHtml(report.typeLabel)} · ${escapeHtml(report.road ?? report.place ?? '')}<br>
               Reported ${fmt.ago(report.createdAt)} by ${escapeHtml(report.reporter ?? 'Anonymous')}<br>
               Confidence ${confidence}% · ${report.confirms} confirmed · ${report.disputes} disputed`,
      }),
      report.note ? el('div', { class: 'popup-note', text: report.note }) : null,
      report.meta?.price ? el('div', { class: 'popup-meta', text: `Price: ${fmt.naira(report.meta.price)}/litre` }) : null,
      report.meta?.queue ? el('div', { class: 'popup-meta', text: `Queue: ${report.meta.queue}` }) : null,
    ]);

    if (onVote && !String(report.id).startsWith('local_')) {
      const actions = el('div', { class: 'popup-actions' }, [
        el('button', {
          text: `Still there (${report.confirms})`,
          onclick: (e) => {
            e.target.disabled = true;
            onVote(report, 'confirm');
          },
        }),
        el('button', {
          text: 'Not any more',
          onclick: (e) => {
            e.target.disabled = true;
            onVote(report, 'dispute');
          },
        }),
      ]);
      wrap.append(actions);
    }
    return wrap;
  },

  focusReport(id) {
    const marker = this.markers.get(id);
    if (!marker) return;
    this.map.setView(marker.getLatLng(), Math.max(this.map.getZoom(), 12), { animate: true });
    marker.openPopup();
  },

  /* ----------------------------------------------------------- routes --- */
  renderPlan(plan, activeId) {
    this.layers.routes.clearLayers();
    this.layers.endpoints.clearLayers();
    if (!plan) return;

    const active = plan.routes.find((r) => r.id === activeId) ?? plan.routes[0];

    for (const route of plan.routes) {
      if (route.id === active.id) continue;
      L.polyline(route.geometry, {
        color: '#6b7280',
        weight: 5,
        opacity: 0.5,
        dashArray: '1 9',
        lineCap: 'round',
      })
        .addTo(this.layers.routes)
        .on('click', () => this.onRouteClick?.(route.id));
    }

    L.polyline(active.geometry, { color: '#000', weight: 11, opacity: 0.35, lineCap: 'round' }).addTo(this.layers.routes);
    L.polyline(active.geometry, {
      color: active.safety.score >= 78 ? '#3f9b6d' : active.safety.score >= 52 ? '#ffc328' : '#e2543c',
      weight: 6,
      opacity: 0.95,
      lineCap: 'round',
    }).addTo(this.layers.routes);

    const endpoint = (point, letter, label) =>
      L.marker(point, {
        icon: L.divIcon({ className: '', html: `<div class="marker-endpoint">${letter}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        zIndexOffset: 800,
      })
        .bindTooltip(label, { direction: 'top', offset: [0, -12] })
        .addTo(this.layers.endpoints);

    endpoint([plan.from.lat, plan.from.lon], 'A', plan.from.label);
    endpoint([plan.to.lat, plan.to.lon], 'B', plan.to.label);

    this.fit(active.geometry);
  },

  highlightHazard(hazard) {
    if (!hazard) return;
    this.map.setView([hazard.lat, hazard.lon], 12, { animate: true });
    const ring = L.circleMarker([hazard.lat, hazard.lon], {
      radius: 22,
      color: hazard.colour ?? '#ffc328',
      weight: 3,
      fill: false,
      opacity: 0.9,
    }).addTo(this.layers.routes);
    setTimeout(() => this.layers.routes.removeLayer(ring), 2600);
    this.markers.get(hazard.id)?.openPopup();
  },

  /* --------------------------------------------------------- hotspots --- */
  renderHotspots(hotspots) {
    this.layers.hotspots.clearLayers();
    if (!hotspots?.length) return;
    const max = Math.max(...hotspots.map((h) => h.score));
    for (const spot of hotspots) {
      const intensity = spot.score / max;
      L.circle([spot.lat, spot.lon], {
        radius: 9000 + intensity * 26000,
        color: '#e2543c',
        weight: 1,
        opacity: 0.35,
        fillColor: '#e2543c',
        fillOpacity: 0.07 + intensity * 0.2,
      })
        .bindTooltip(
          `<b>${escapeHtml(spot.road ?? spot.place ?? 'Hotspot')}</b><br>${spot.count} reports · score ${spot.score}`,
          { direction: 'top' },
        )
        .addTo(this.layers.hotspots);
    }
  },

  clearHotspots() {
    this.layers.hotspots.clearLayers();
  },

  /* ---------------------------------------------------------- my dot ---- */
  setMyPosition(position) {
    this.layers.me.clearLayers();
    if (!position) return;
    L.marker([position.lat, position.lon], {
      icon: L.divIcon({ className: '', html: '<div class="marker-me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(this.layers.me);
    if (position.accuracy && position.accuracy < 4000) {
      L.circle([position.lat, position.lon], {
        radius: position.accuracy,
        color: '#4f9dff',
        weight: 1,
        opacity: 0.35,
        fillOpacity: 0.07,
        interactive: false,
      }).addTo(this.layers.me);
    }
  },

  /* ----------------------------------------------------------- trips ---- */
  renderTrip(trip, breadcrumbs = []) {
    this.layers.trip.clearLayers();
    if (!trip) return;
    if (trip.geometry?.length > 1) {
      L.polyline(trip.geometry, { color: '#8b6fd4', weight: 5, opacity: 0.7, dashArray: '10 8' }).addTo(this.layers.trip);
    }
    if (breadcrumbs.length > 1) {
      L.polyline(breadcrumbs, { color: '#ffc328', weight: 4, opacity: 0.9 }).addTo(this.layers.trip);
    }
    if (trip.position) {
      L.marker([trip.position.lat, trip.position.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div class="marker-pin" style="background:${trip.sos ? '#e2543c' : '#8b6fd4'}"><span>🚘</span></div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 24],
        }),
        zIndexOffset: 900,
      })
        .bindTooltip(`${trip.traveller} · ${Math.round(trip.progress * 100)}%`, { direction: 'top', offset: [0, -20] })
        .addTo(this.layers.trip);
    }
  },

  /* ------------------------------------------------------------ utils --- */
  fit(points, padding = 48) {
    if (!points?.length) return;
    const bounds = L.latLngBounds(points);
    this.map.invalidateSize();
    requestAnimationFrame(() => {
      this.map.invalidateSize();
      this.map.fitBounds(bounds, { padding: [padding, padding], maxZoom: 14 });
    });
  },

  bboxString() {
    const b = this.map.getBounds();
    return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => n.toFixed(4)).join(',');
  },

  flyTo(lat, lon, zoom = 13) {
    this.map.flyTo([lat, lon], zoom, { duration: 0.8 });
  },
};

export function setReportMode(on) {
  setState({ reportMode: on });
  const hint = document.getElementById('mapHint');
  if (hint) hint.hidden = !on;
  document.getElementById('reportModeBtn')?.setAttribute('aria-pressed', String(on));
  const container = mapview.map?.getContainer();
  if (container) container.style.cursor = on ? 'crosshair' : '';
}
