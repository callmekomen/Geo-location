/**
 * A stand-in for Leaflet, good enough to boot the real front-end inside jsdom.
 *
 * It records what the app draws so tests can assert on the map without a
 * rendering engine: `L.__state.layers`, `L.__state.views`, `L.__state.handlers`.
 */

export function installFakeLeaflet(window) {
  const state = {
    layers: [],
    created: [],
    views: [],
    handlers: new Map(),
    popups: [],
    /** Every layer currently attached to the map, at any depth. */
    attached() {
      const out = [];
      const walk = (nodes) => {
        for (const node of nodes) {
          out.push(node);
          if (node.children?.length) walk(node.children);
        }
      };
      walk(state.map ? [...state.map.children, ...state.layers] : state.layers);
      return out;
    },
  };

  const chainable = (kind, args) => {
    const self = {
      kind,
      args,
      children: [],
      popup: null,
      tooltip: null,
      addTo(parent) {
        (parent?.children ?? state.layers).push(self);
        self.parent = parent;
        return self;
      },
      bindPopup(content) {
        self.popup = content;
        return self;
      },
      bindTooltip(content) {
        self.tooltip = content;
        return self;
      },
      openPopup() {
        state.popups.push(self.popup);
        return self;
      },
      setContent(content) {
        self.popup = content;
        return self;
      },
      setLatLng(latlng) {
        self.latlng = latlng;
        return self;
      },
      setStyle() {
        return self;
      },
      setZIndexOffset() {
        return self;
      },
      clearLayers() {
        self.children.length = 0;
        return self;
      },
      addLayer(child) {
        self.children.push(child);
        return self;
      },
      removeLayer(child) {
        const i = self.children.indexOf(child);
        if (i >= 0) self.children.splice(i, 1);
        return self;
      },
      getBounds: () => bounds([[6.4, 3.3], [6.6, 3.5]]),
      getLatLng: () => self.latlng ?? { lat: 6.5, lng: 3.4 },
      on(event, handler) {
        state.handlers.set(`${kind}:${event}`, handler);
        return self;
      },
      off() {
        return self;
      },
      remove() {
        return self;
      },
      redraw() {
        return self;
      },
      addLayers(children) {
        self.children.push(...children);
        return self;
      },
      bringToBack() {
        return self;
      },
      bringToFront() {
        return self;
      },
      setOpacity() {
        return self;
      },
      setUrl() {
        return self;
      },
      setLatLngs(latlngs) {
        self.latlngs = latlngs;
        return self;
      },
      getElement: () => window.document.createElement('div'),
      closePopup() {
        return self;
      },
      unbindPopup() {
        self.popup = null;
        return self;
      },
      hasLayer: (child) => self.children.includes(child),
      eachLayer(fn) {
        self.children.forEach(fn);
        return self;
      },
      getLayers: () => self.children,
    };
    state.created.push(self);
    return self;
  };

  const bounds = (points) => {
    const lats = points.map((p) => (Array.isArray(p) ? p[0] : p.lat));
    const lons = points.map((p) => (Array.isArray(p) ? p[1] : p.lng ?? p.lon));
    return {
      isValid: () => lats.length > 0,
      getSouth: () => Math.min(...lats),
      getNorth: () => Math.max(...lats),
      getWest: () => Math.min(...lons),
      getEast: () => Math.max(...lons),
      getSouthWest: () => ({ lat: Math.min(...lats), lng: Math.min(...lons) }),
      getNorthEast: () => ({ lat: Math.max(...lats), lng: Math.max(...lons) }),
      getCenter: () => ({ lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lons) + Math.max(...lons)) / 2 }),
      extend() {
        return this;
      },
      pad() {
        return this;
      },
    };
  };

  const L = {
    __state: state,
    map(id, options) {
      const m = chainable('map', [id, options]);
      Object.assign(m, {
        setView(centre, zoom) {
          state.views.push({ kind: 'setView', centre, zoom });
          return m;
        },
        flyTo(centre, zoom) {
          state.views.push({ kind: 'flyTo', centre, zoom });
          return m;
        },
        fitBounds(b, opts) {
          state.views.push({ kind: 'fitBounds', bounds: b, opts });
          return m;
        },
        getBounds: () => bounds([[6.3, 3.1], [6.8, 3.7]]),
        getCenter: () => ({ lat: 6.55, lng: 3.4 }),
        getZoom: () => 11,
        invalidateSize: () => m,
        closePopup: () => m,
        openPopup: (p) => {
          state.popups.push(p?.popup ?? p);
          return m;
        },
        getContainer: () => window.document.getElementById(id) ?? window.document.createElement('div'),
      });
      state.map = m;
      return m;
    },
    tileLayer: (...args) => chainable('tileLayer', args),
    layerGroup: (...args) => chainable('layerGroup', args),
    marker: (...args) => chainable('marker', args),
    circle: (...args) => chainable('circle', args),
    circleMarker: (...args) => chainable('circleMarker', args),
    polyline: (...args) => chainable('polyline', args),
    popup: (...args) => chainable('popup', args),
    divIcon: (options) => ({ kind: 'divIcon', options }),
    latLngBounds: (points) => bounds(points ?? []),
    latLng: (lat, lng) => ({ lat, lng }),
    control: {
      zoom: (...args) => chainable('zoomControl', args),
      scale: (...args) => chainable('scaleControl', args),
    },
    DomEvent: { stopPropagation() {}, preventDefault() {}, disableClickPropagation() {} },
    Browser: { mobile: false },
  };

  window.L = L;
  globalThis.L = L;
  return L;
}
