/**
 * Community reports: the data that makes this app worth opening.
 *
 * Every report carries a decaying confidence score. Fresh reports from a
 * single phone are treated as rumours; reports other travellers confirm hold
 * their weight for longer, and disputed ones fade fast.
 */

import { randomUUID } from 'node:crypto';
import { getDb, bump } from '../db/index.js';
import { REPORT_TYPES, typeMeta, isValidType } from './taxonomy.js';
import { haversine, padBounds } from './geo.js';
import { nearest, describe } from './gazetteer.js';
import { snap } from './graph.js';

const HOUR = 3600_000;

/** Nearest road name for a coordinate, when it is plausibly on the network. */
export function roadAt(lat, lon) {
  const [hit] = snap([lat, lon], { limit: 1, maxDistanceM: 4000 });
  return hit ? hit.edge.name : null;
}

export function confidenceOf(report, now = Date.now()) {
  const meta = typeMeta(report.type);
  const ttlMs = (meta?.ttlHours ?? 24) * HOUR;
  const age = Math.max(0, now - new Date(report.created_at ?? report.createdAt).getTime());
  const freshness = Math.max(0, 1 - age / ttlMs);
  const confirms = report.confirms ?? 0;
  const disputes = report.disputes ?? 0;
  const social = 0.5 + confirms * 0.13 - disputes * 0.2;
  const value = Math.max(0.03, Math.min(1, social)) * (0.35 + 0.65 * freshness);
  return Math.round(value * 100) / 100;
}

function rowToReport(row, now = Date.now()) {
  const meta = typeMeta(row.type) ?? {};
  let extra = null;
  try {
    extra = row.meta ? JSON.parse(row.meta) : null;
  } catch {
    extra = null;
  }
  const ageMs = now - new Date(row.created_at).getTime();
  return {
    id: row.id,
    type: row.type,
    typeLabel: meta.label ?? row.type,
    category: row.category,
    colour: meta.colour ?? '#666',
    icon: meta.icon ?? 'pin',
    severity: row.severity,
    lat: row.lat,
    lon: row.lon,
    label: row.label || null,
    note: row.note || null,
    road: row.road || null,
    place: row.place || null,
    state: row.state || null,
    reporter: row.reporter || 'Anonymous',
    confirms: row.confirms,
    disputes: row.disputes,
    meta: extra,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    ageMinutes: Math.round(ageMs / 60000),
    confidence: confidenceOf(row, now),
  };
}

/** Flip anything past its expiry to `expired`. Cheap, runs on a timer. */
export function sweepExpired() {
  const info = getDb()
    .prepare("UPDATE reports SET status = 'expired' WHERE status = 'active' AND expires_at < ?")
    .run(new Date().toISOString());
  return info.changes;
}

export function createReport(input) {
  const db = getDb();
  if (!isValidType(input.type)) throw Object.assign(new Error(`Unknown report type "${input.type}"`), { status: 400 });

  const meta = REPORT_TYPES[input.type];
  const now = new Date();
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  const severity = Number.isFinite(Number(input.severity))
    ? Math.max(0, Math.min(3, Number(input.severity)))
    : meta.severity;
  const ttlHours = meta.ttlHours;
  const [place] = nearest(lat, lon, { limit: 1 });

  const report = {
    id: `r_${randomUUID().slice(0, 12)}`,
    type: input.type,
    category: meta.category,
    severity,
    lat,
    lon,
    label: (input.label ?? '').toString().slice(0, 120).trim() || null,
    note: (input.note ?? '').toString().slice(0, 600).trim() || null,
    road: roadAt(lat, lon),
    place: describe(lat, lon),
    state: place?.state ?? null,
    device_id: input.deviceId ?? null,
    reporter: (input.reporter ?? '').toString().slice(0, 40).trim() || null,
    meta: input.meta ? JSON.stringify(input.meta) : null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlHours * HOUR).toISOString(),
  };

  // Near-duplicate suppression: the same type within 250 m in the last hour
  // counts as a confirmation rather than a second pin.
  const duplicate = db
    .prepare(
      `SELECT * FROM reports
        WHERE type = ? AND status = 'active' AND created_at > ?
          AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
    )
    .all(
      report.type,
      new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      lat - 0.004,
      lat + 0.004,
      lon - 0.004,
      lon + 0.004,
    )
    .find((row) => haversine([lat, lon], [row.lat, row.lon]) < 250 && row.device_id !== report.device_id);

  if (duplicate) {
    db.prepare('UPDATE reports SET confirms = confirms + 1, updated_at = ?, expires_at = ? WHERE id = ?').run(
      now.toISOString(),
      new Date(now.getTime() + ttlHours * HOUR).toISOString(),
      duplicate.id,
    );
    bump('report_confirmed_via_duplicate');
    const fresh = db.prepare('SELECT * FROM reports WHERE id = ?').get(duplicate.id);
    return { report: rowToReport(fresh), deduped: true };
  }

  db.prepare(
    `INSERT INTO reports
      (id, type, category, severity, lat, lon, label, note, road, place, state, device_id, reporter, meta, created_at, updated_at, expires_at)
     VALUES
      (@id, @type, @category, @severity, @lat, @lon, @label, @note, @road, @place, @state, @device_id, @reporter, @meta, @created_at, @updated_at, @expires_at)`,
  ).run(report);

  bump('reports_created');
  bump(`report_type_${report.type}`);
  return { report: rowToReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id)), deduped: false };
}

/**
 * List reports with optional spatial / type / freshness filters.
 * @param {{bbox?:object, near?:[number,number], radiusM?:number, types?:string[],
 *          categories?:string[], sinceHours?:number, limit?:number, includeExpired?:boolean,
 *          minConfidence?:number, state?:string}} [filters]
 */
export function listReports(filters = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];

  if (!filters.includeExpired) clauses.push("status = 'active'");
  if (filters.bbox) {
    clauses.push('lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?');
    params.push(filters.bbox.minLat, filters.bbox.maxLat, filters.bbox.minLon, filters.bbox.maxLon);
  }
  if (filters.near && filters.radiusM) {
    const box = padBounds(
      { minLat: filters.near[0], maxLat: filters.near[0], minLon: filters.near[1], maxLon: filters.near[1] },
      filters.radiusM,
    );
    clauses.push('lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?');
    params.push(box.minLat, box.maxLat, box.minLon, box.maxLon);
  }
  if (filters.types?.length) {
    clauses.push(`type IN (${filters.types.map(() => '?').join(',')})`);
    params.push(...filters.types);
  }
  if (filters.categories?.length) {
    clauses.push(`category IN (${filters.categories.map(() => '?').join(',')})`);
    params.push(...filters.categories);
  }
  if (filters.state) {
    clauses.push('state = ?');
    params.push(filters.state);
  }
  if (filters.sinceHours) {
    clauses.push('created_at > ?');
    params.push(new Date(Date.now() - filters.sinceHours * HOUR).toISOString());
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(2000, filters.limit ?? 500));
  const rows = db.prepare(`SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);

  const now = Date.now();
  let out = rows.map((row) => rowToReport(row, now));

  if (filters.near && filters.radiusM) {
    out = out
      .map((r) => ({ ...r, distanceM: Math.round(haversine(filters.near, [r.lat, r.lon])) }))
      .filter((r) => r.distanceM <= filters.radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
  }
  if (filters.minConfidence) out = out.filter((r) => r.confidence >= filters.minConfidence);
  return out;
}

export function getReport(id) {
  const row = getDb().prepare('SELECT * FROM reports WHERE id = ?').get(id);
  return row ? rowToReport(row) : null;
}

/**
 * Confirm or dispute a report. One vote per device; changing your mind is
 * allowed and simply moves the tally.
 */
export function voteReport(id, deviceId, vote) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!row) return null;
  if (!['confirm', 'dispute'].includes(vote)) {
    throw Object.assign(new Error('vote must be "confirm" or "dispute"'), { status: 400 });
  }

  const existing = db.prepare('SELECT vote FROM report_votes WHERE report_id = ? AND device_id = ?').get(id, deviceId);
  if (existing?.vote === vote) return rowToReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(id));

  const now = new Date();
  const tx = db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE report_votes SET vote = ?, created_at = ? WHERE report_id = ? AND device_id = ?').run(
        vote,
        now.toISOString(),
        id,
        deviceId,
      );
      const undo = existing.vote === 'confirm' ? 'confirms = confirms - 1' : 'disputes = disputes - 1';
      db.prepare(`UPDATE reports SET ${undo} WHERE id = ?`).run(id);
    } else {
      db.prepare('INSERT INTO report_votes (report_id, device_id, vote, created_at) VALUES (?, ?, ?, ?)').run(
        id,
        deviceId,
        vote,
        now.toISOString(),
      );
    }

    const apply = vote === 'confirm' ? 'confirms = confirms + 1' : 'disputes = disputes + 1';
    db.prepare(`UPDATE reports SET ${apply}, updated_at = ? WHERE id = ?`).run(now.toISOString(), id);

    const after = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    const meta = typeMeta(after.type);
    if (vote === 'confirm') {
      // A confirmation buys the report more life, up to 3x its base TTL.
      const maxExpiry = new Date(new Date(after.created_at).getTime() + meta.ttlHours * 3 * HOUR);
      const extended = new Date(Math.min(maxExpiry.getTime(), now.getTime() + meta.ttlHours * HOUR));
      db.prepare('UPDATE reports SET expires_at = ? WHERE id = ?').run(extended.toISOString(), id);
    } else if (after.disputes >= 3 && after.disputes > after.confirms) {
      db.prepare("UPDATE reports SET status = 'disputed' WHERE id = ?").run(id);
    }
  });
  tx();

  bump(`report_${vote}`);
  return rowToReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(id));
}

/** Grid-clustered hotspots — where the same trouble keeps being reported. */
export function hotspots({ days = 30, limit = 12, precision = 0.05 } = {}) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM reports
        WHERE created_at > ? AND severity >= 2 AND status != 'disputed'`,
    )
    .all(new Date(Date.now() - days * 24 * HOUR).toISOString());

  const cells = new Map();
  for (const row of rows) {
    const key = `${Math.round(row.lat / precision)}:${Math.round(row.lon / precision)}`;
    if (!cells.has(key)) {
      cells.set(key, { lat: 0, lon: 0, count: 0, weight: 0, types: {}, road: row.road, state: row.state, place: row.place });
    }
    const cell = cells.get(key);
    const weight = (REPORT_TYPES[row.type]?.weight ?? 1) * row.severity * (1 + row.confirms * 0.25);
    cell.lat += row.lat;
    cell.lon += row.lon;
    cell.count += 1;
    cell.weight += weight;
    cell.types[row.type] = (cell.types[row.type] ?? 0) + 1;
    if (row.road && !cell.road) cell.road = row.road;
  }

  return [...cells.values()]
    .map((cell) => ({
      lat: cell.lat / cell.count,
      lon: cell.lon / cell.count,
      count: cell.count,
      score: Math.round(cell.weight * 10) / 10,
      road: cell.road,
      state: cell.state,
      place: cell.place,
      dominantType: Object.entries(cell.types).sort((a, b) => b[1] - a[1])[0][0],
    }))
    .filter((cell) => cell.count >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function reportCounts() {
  const db = getDb();
  const byType = db
    .prepare("SELECT type, COUNT(*) AS n FROM reports WHERE status = 'active' GROUP BY type ORDER BY n DESC")
    .all();
  const byState = db
    .prepare(
      "SELECT state, COUNT(*) AS n FROM reports WHERE status = 'active' AND state IS NOT NULL GROUP BY state ORDER BY n DESC LIMIT 12",
    )
    .all();
  const total = db.prepare('SELECT COUNT(*) AS n FROM reports').get().n;
  const active = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'active'").get().n;
  const last24h = db
    .prepare('SELECT COUNT(*) AS n FROM reports WHERE created_at > ?')
    .get(new Date(Date.now() - 24 * HOUR).toISOString()).n;
  return { total, active, last24h, byType, byState };
}
