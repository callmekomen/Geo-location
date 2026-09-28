/**
 * API client.
 *
 * Two things matter here beyond "call fetch": every request carries an
 * anonymous device id, and writes made while offline go into an outbox in
 * localStorage that is replayed the moment the connection comes back.
 */

const DEVICE_KEY = 'nr.device';
const OUTBOX_KEY = 'nr.outbox';

export const deviceId = (() => {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev_${(crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 16)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
})();

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, signal, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  signal?.addEventListener('abort', () => controller.abort());
  try {
    const res = await fetch(`/api${path}`, {
      method,
      signal: controller.signal,
      headers: {
        'x-device-id': deviceId,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(body?.tripToken ? { 'x-trip-token': body.tripToken } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(json?.error ?? `Request failed (${res.status})`, res.status, json);
    return json;
  } catch (error) {
    if (error.name === 'AbortError') throw new ApiError('The request timed out.', 0, null);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ the outbox */
const readOutbox = () => {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]');
  } catch {
    return [];
  }
};
const writeOutbox = (items) => localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-50)));

export const outbox = {
  size: () => readOutbox().length,
  add(entry) {
    const items = readOutbox();
    items.push({ ...entry, queuedAt: new Date().toISOString() });
    writeOutbox(items);
    return items.length;
  },
  async flush() {
    const items = readOutbox();
    if (!items.length) return { sent: 0, failed: 0 };
    const remaining = [];
    let sent = 0;
    for (const item of items) {
      try {
        await request(item.path, { method: item.method ?? 'POST', body: item.body });
        sent += 1;
      } catch (error) {
        if (error.status >= 400 && error.status < 500) continue; // permanently rejected, drop it
        remaining.push(item);
      }
    }
    writeOutbox(remaining);
    return { sent, failed: remaining.length };
  },
};

/* ------------------------------------------------------------- endpoints */
export const api = {
  meta: () => request('/meta'),
  health: () => request('/health'),

  places: (q, near) => request(`/places?q=${encodeURIComponent(q)}${near ? `&near=${near.join(',')}` : ''}`),
  reverse: (lat, lon) => request(`/places/reverse?lat=${lat}&lon=${lon}`),

  route: (payload) => request('/route', { method: 'POST', body: payload, timeout: 30000 }),
  around: (lat, lon, radius = 25000) => request(`/around?lat=${lat}&lon=${lon}&radius=${radius}`),

  reports: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''));
    return request(`/reports?${qs}`);
  },
  stations: (bbox) => request(`/reports/stations${bbox ? `?bbox=${bbox}` : ''}`),
  hotspots: (days = 30) => request(`/reports/hotspots?days=${days}`),

  async createReport(payload) {
    if (!navigator.onLine) {
      outbox.add({ path: '/reports', body: payload });
      return { queued: true, report: { ...payload, id: `local_${Date.now()}`, createdAt: new Date().toISOString() } };
    }
    try {
      return await request('/reports', { method: 'POST', body: payload });
    } catch (error) {
      if (!error.status) {
        outbox.add({ path: '/reports', body: payload });
        return { queued: true, report: { ...payload, id: `local_${Date.now()}`, createdAt: new Date().toISOString() } };
      }
      throw error;
    }
  },
  vote: (id, vote) => request(`/reports/${id}/vote`, { method: 'POST', body: { vote } }),

  createTrip: (payload) => request('/trips', { method: 'POST', body: payload }),
  trip: (code) => request(`/trips/${code}`),
  ping: (code, token, payload) => request(`/trips/${code}/ping`, { method: 'POST', body: { ...payload, token } }),
  tripStatus: (code, token, status, message) =>
    request(`/trips/${code}/status`, { method: 'POST', body: { status, message, token } }),
  sos: (code, token, payload) => request(`/trips/${code}/sos`, { method: 'POST', body: { ...payload, token } }),
  checkin: (code, token, payload) => request(`/trips/${code}/checkin`, { method: 'POST', body: { ...payload, token } }),

  insights: (days = 14) => request(`/insights?days=${days}`),
  assistant: (payload) => request('/assistant', { method: 'POST', body: payload, timeout: 40000 }),
};

/* ------------------------------------------------------- live event stream */
export function connectStream({ onEvent, onOpen, onError } = {}) {
  let source = null;
  let retry = 0;
  let closed = false;

  const open = () => {
    if (closed) return;
    source = new EventSource('/api/stream');
    source.addEventListener('open', () => {
      retry = 0;
      onOpen?.();
    });
    for (const topic of [
      'report:new',
      'report:confirmed',
      'report:updated',
      'trip:started',
      'trip:ping',
      'trip:sos',
      'trip:overdue',
      'trip:arrived',
      'hello',
    ]) {
      source.addEventListener(topic, (event) => {
        try {
          onEvent?.(topic, JSON.parse(event.data));
        } catch {
          /* ignore malformed frame */
        }
      });
    }
    source.addEventListener('error', () => {
      onError?.();
      source?.close();
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(open, 1000 * 2 ** retry);
    });
  };

  open();
  return {
    close() {
      closed = true;
      source?.close();
    },
  };
}
