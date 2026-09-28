/** Tiny observable store — enough state management for an app this size. */

const listeners = new Map();

export const state = {
  meta: null,
  from: null,           // {lat, lon, label}
  to: null,
  plan: null,           // full /api/route response
  activeRouteId: null,
  reports: [],
  filters: new Set(),   // active category filters, empty = all
  position: null,       // {lat, lon, accuracy}
  watchingPosition: false,
  trip: null,           // {code, token, ...} for the trip I am sharing
  watched: null,        // someone else's trip I am watching
  online: navigator.onLine,
  live: false,
  reportMode: false,
  pendingPoint: null,
};

export function setState(patch) {
  const changed = [];
  for (const [key, value] of Object.entries(patch)) {
    if (state[key] === value) continue;
    state[key] = value;
    changed.push(key);
  }
  for (const key of changed) {
    for (const fn of listeners.get(key) ?? []) fn(state[key], state);
  }
  if (changed.length) for (const fn of listeners.get('*') ?? []) fn(state, changed);
  return changed;
}

export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key)?.delete(fn);
}

/** Persisted slices — trip ownership must survive a page reload. */
const PERSIST_KEY = 'nr.session';

export function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}');
    if (saved.trip) state.trip = saved.trip;
    if (saved.traveller) state.traveller = saved.traveller;
    return saved;
  } catch {
    return {};
  }
}

export function saveSession(patch) {
  const current = (() => {
    try {
      return JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}');
    } catch {
      return {};
    }
  })();
  localStorage.setItem(PERSIST_KEY, JSON.stringify({ ...current, ...patch }));
}

export function activeRoute() {
  if (!state.plan) return null;
  return state.plan.routes.find((r) => r.id === state.activeRouteId) ?? state.plan.routes[0];
}
