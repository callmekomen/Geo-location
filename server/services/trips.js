/**
 * Safe-arrival trips.
 *
 * You share a six-character code with someone who cares whether you get
 * there. They watch a live page: where you are, how far is left, whether you
 * are overdue, and a panic signal if you send one. No account needed on
 * either side — the code is the credential for watching, a secret token is
 * the credential for updating.
 */

import { randomBytes } from 'node:crypto';
import { getDb, bump } from '../db/index.js';
import { haversine, pointToPolyline, polylineLength, simplify } from './geo.js';
import { describe } from './gazetteer.js';
import { publish } from './events.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const OVERDUE_GRACE_MS = 20 * 60 * 1000;

function makeCode() {
  const bytes = randomBytes(6);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function rowToTrip(row, { geometry = true } = {}) {
  if (!row) return null;
  let line = [];
  try {
    line = row.geometry ? JSON.parse(row.geometry) : [];
  } catch {
    line = [];
  }
  const eta = row.eta ? new Date(row.eta) : null;
  const now = Date.now();
  const overdueBy = eta && row.status === 'active' ? now - eta.getTime() : 0;
  const remainingM = Math.max(0, Math.round(row.distance_m * (1 - row.progress)));

  return {
    code: row.code,
    traveller: row.traveller || 'Traveller',
    from: { label: row.from_label, lat: row.from_lat, lon: row.from_lon },
    to: { label: row.to_label, lat: row.to_lat, lon: row.to_lon },
    distanceM: row.distance_m,
    durationS: row.duration_s,
    status: row.status,
    sos: Boolean(row.sos),
    note: row.note || null,
    eta: row.eta,
    etaLocal: eta ? eta.toISOString() : null,
    overdue: overdueBy > OVERDUE_GRACE_MS,
    overdueMinutes: overdueBy > 0 ? Math.round(overdueBy / 60000) : 0,
    progress: Math.round(row.progress * 1000) / 1000,
    remainingM,
    position:
      row.last_lat != null
        ? { lat: row.last_lat, lon: row.last_lon, speedKph: row.last_speed ?? null, at: row.updated_at }
        : null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    geometry: geometry ? line : undefined,
  };
}

export function createTrip(input) {
  const db = getDb();
  const now = new Date();
  let code = makeCode();
  for (let i = 0; i < 5 && db.prepare('SELECT 1 FROM trips WHERE code = ?').get(code); i += 1) code = makeCode();

  const geometry = Array.isArray(input.geometry) && input.geometry.length > 1 ? simplify(input.geometry, 60) : [];
  const distanceM = Math.round(input.distanceM ?? (geometry.length ? polylineLength(geometry) : 0));
  const durationS = Math.round(input.durationS ?? (distanceM / 15000) * 3600);
  const eta = input.eta ? new Date(input.eta) : new Date(now.getTime() + durationS * 1000);
  const token = randomBytes(16).toString('hex');

  const trip = {
    code,
    token,
    device_id: input.deviceId ?? null,
    traveller: (input.traveller ?? '').toString().slice(0, 40).trim() || null,
    from_label: input.from?.label ?? describe(input.from.lat, input.from.lon),
    to_label: input.to?.label ?? describe(input.to.lat, input.to.lon),
    from_lat: input.from.lat,
    from_lon: input.from.lon,
    to_lat: input.to.lat,
    to_lon: input.to.lon,
    geometry: JSON.stringify(geometry),
    distance_m: distanceM,
    duration_s: durationS,
    eta: eta.toISOString(),
    note: (input.note ?? '').toString().slice(0, 300).trim() || null,
    last_lat: input.from.lat,
    last_lon: input.from.lon,
    started_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  db.prepare(
    `INSERT INTO trips
      (code, token, device_id, traveller, from_label, to_label, from_lat, from_lon, to_lat, to_lon,
       geometry, distance_m, duration_s, eta, note, last_lat, last_lon, started_at, updated_at)
     VALUES
      (@code, @token, @device_id, @traveller, @from_label, @to_label, @from_lat, @from_lon, @to_lat, @to_lon,
       @geometry, @distance_m, @duration_s, @eta, @note, @last_lat, @last_lon, @started_at, @updated_at)`,
  ).run(trip);

  addEvent(code, 'started', `${trip.traveller ?? 'Traveller'} set off from ${trip.from_label}`, {
    lat: trip.from_lat,
    lon: trip.from_lon,
  });
  bump('trips_created');
  publish('trip:started', { code, to: trip.to_label });

  return { trip: getTrip(code), token };
}

export function getTrip(code, options) {
  const row = getDb()
    .prepare('SELECT * FROM trips WHERE code = ?')
    .get(String(code ?? '').toUpperCase());
  return rowToTrip(row, options);
}

export function authoriseTrip(code, token) {
  const row = getDb()
    .prepare('SELECT token FROM trips WHERE code = ?')
    .get(String(code ?? '').toUpperCase());
  if (!row) return false;
  return Boolean(token) && row.token === token;
}

/** Record a position update and recompute progress + a live ETA. */
export function addPing(code, { lat, lon, speedKph, heading }) {
  const db = getDb();
  const upper = String(code).toUpperCase();
  const row = db.prepare('SELECT * FROM trips WHERE code = ?').get(upper);
  if (!row) return null;

  const now = new Date();
  let geometry = [];
  try {
    geometry = row.geometry ? JSON.parse(row.geometry) : [];
  } catch {
    geometry = [];
  }

  let progress = row.progress;
  if (geometry.length > 1) {
    const hit = pointToPolyline([lat, lon], geometry);
    const total = polylineLength(geometry);
    progress = total > 0 ? Math.max(row.progress, Math.min(1, hit.along / total)) : row.progress;
  } else if (row.distance_m > 0) {
    const done = haversine([row.from_lat, row.from_lon], [lat, lon]);
    progress = Math.max(row.progress, Math.min(1, done / row.distance_m));
  }

  // Re-forecast arrival from progress made so far, blended with the plan.
  const elapsedS = (now.getTime() - new Date(row.started_at).getTime()) / 1000;
  let eta = row.eta;
  if (progress > 0.04 && elapsedS > 300) {
    const projectedTotal = elapsedS / progress;
    const blended = projectedTotal * 0.6 + row.duration_s * 0.4;
    eta = new Date(new Date(row.started_at).getTime() + blended * 1000).toISOString();
  }

  const arrived = progress >= 0.985 || haversine([lat, lon], [row.to_lat, row.to_lon]) < 700;
  const status = arrived ? 'arrived' : row.status === 'overdue' ? 'overdue' : row.status;

  db.prepare(
    `UPDATE trips SET last_lat = ?, last_lon = ?, last_speed = ?, progress = ?, eta = ?, status = ?,
       updated_at = ?, ended_at = CASE WHEN ? = 'arrived' THEN ? ELSE ended_at END
     WHERE code = ?`,
  ).run(lat, lon, speedKph ?? null, progress, eta, status, now.toISOString(), status, now.toISOString(), upper);

  db.prepare('INSERT INTO trip_pings (code, lat, lon, speed, heading, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    upper,
    lat,
    lon,
    speedKph ?? null,
    heading ?? null,
    now.toISOString(),
  );

  if (arrived && row.status !== 'arrived') {
    addEvent(upper, 'arrived', `Arrived at ${row.to_label}`, { lat, lon });
    publish('trip:arrived', { code: upper });
  }

  const trip = getTrip(upper, { geometry: false });
  publish('trip:ping', { code: upper, position: trip.position, progress: trip.progress, status: trip.status });
  return trip;
}

export function addEvent(code, kind, message, { lat, lon } = {}) {
  const upper = String(code).toUpperCase();
  getDb()
    .prepare('INSERT INTO trip_events (code, kind, message, lat, lon, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(upper, kind, message ?? null, lat ?? null, lon ?? null, new Date().toISOString());
  return { kind, message, lat, lon };
}

export function listEvents(code, limit = 40) {
  return getDb()
    .prepare('SELECT kind, message, lat, lon, created_at AS createdAt FROM trip_events WHERE code = ? ORDER BY id DESC LIMIT ?')
    .all(String(code).toUpperCase(), limit);
}

export function listPings(code, limit = 200) {
  return getDb()
    .prepare('SELECT lat, lon, speed, created_at AS createdAt FROM trip_pings WHERE code = ? ORDER BY id DESC LIMIT ?')
    .all(String(code).toUpperCase(), limit)
    .reverse();
}

export function raiseSos(code, { lat, lon, message } = {}) {
  const db = getDb();
  const upper = String(code).toUpperCase();
  const row = db.prepare('SELECT * FROM trips WHERE code = ?').get(upper);
  if (!row) return null;
  db.prepare('UPDATE trips SET sos = 1, updated_at = ? WHERE code = ?').run(new Date().toISOString(), upper);
  addEvent(upper, 'sos', message || 'Emergency signal raised', { lat: lat ?? row.last_lat, lon: lon ?? row.last_lon });
  bump('trips_sos');
  publish('trip:sos', {
    code: upper,
    traveller: row.traveller,
    at: { lat: lat ?? row.last_lat, lon: lon ?? row.last_lon },
    place: describe(lat ?? row.last_lat, lon ?? row.last_lon),
  });
  return getTrip(upper, { geometry: false });
}

export function clearSos(code) {
  getDb().prepare('UPDATE trips SET sos = 0, updated_at = ? WHERE code = ?').run(new Date().toISOString(), String(code).toUpperCase());
  addEvent(code, 'sos_cleared', 'Emergency signal cleared');
  return getTrip(code, { geometry: false });
}

export function setStatus(code, status, message) {
  const upper = String(code).toUpperCase();
  const allowed = ['active', 'arrived', 'cancelled'];
  if (!allowed.includes(status)) throw Object.assign(new Error(`status must be one of ${allowed.join(', ')}`), { status: 400 });
  const now = new Date().toISOString();
  getDb()
    .prepare('UPDATE trips SET status = ?, updated_at = ?, ended_at = CASE WHEN ? IN (\'arrived\',\'cancelled\') THEN ? ELSE NULL END WHERE code = ?')
    .run(status, now, status, now, upper);
  addEvent(upper, status, message ?? null);
  publish(`trip:${status}`, { code: upper });
  return getTrip(upper, { geometry: false });
}

export function checkIn(code, { lat, lon, message }) {
  const upper = String(code).toUpperCase();
  addEvent(upper, 'checkin', message || 'Checked in', { lat, lon });
  publish('trip:checkin', { code: upper, message: message || 'Checked in' });
  return listEvents(upper, 10);
}

/** Flag trips that have blown past their ETA. Runs on a timer. */
export function sweepOverdue() {
  const db = getDb();
  const cutoff = new Date(Date.now() - OVERDUE_GRACE_MS).toISOString();
  const due = db.prepare("SELECT code, traveller, to_label FROM trips WHERE status = 'active' AND eta < ?").all(cutoff);
  for (const trip of due) {
    db.prepare("UPDATE trips SET status = 'overdue', updated_at = ? WHERE code = ?").run(new Date().toISOString(), trip.code);
    addEvent(trip.code, 'overdue', `Did not arrive at ${trip.to_label} by the expected time`);
    publish('trip:overdue', { code: trip.code, traveller: trip.traveller, to: trip.to_label });
  }
  return due.length;
}

export function activeTripSummary() {
  const db = getDb();
  const active = db.prepare("SELECT COUNT(*) AS n FROM trips WHERE status = 'active'").get().n;
  const overdue = db.prepare("SELECT COUNT(*) AS n FROM trips WHERE status = 'overdue'").get().n;
  const sos = db.prepare('SELECT COUNT(*) AS n FROM trips WHERE sos = 1').get().n;
  const today = db
    .prepare('SELECT COUNT(*) AS n FROM trips WHERE started_at > ?')
    .get(new Date(Date.now() - 24 * 3600_000).toISOString()).n;
  return { active, overdue, sos, startedToday: today };
}
