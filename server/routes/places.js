import { Router } from 'express';
import { asyncHandler, validate, rateLimit } from '../middleware/common.js';
import { search as searchOffline, nearest, describe } from '../services/gazetteer.js';
import { geocode as geocodeUpstream, reverse as reverseUpstream } from '../services/upstream.js';
import { roadAt } from '../services/reports.js';

export const placesRouter = Router();

placesRouter.use(rateLimit({ key: 'places', max: 300 }));

/**
 * GET /api/places?q=ike&near=6.5,3.3
 * Offline gazetteer first (instant), topped up with OSM results when online.
 */
placesRouter.get(
  '/places',
  asyncHandler(async (req, res) => {
    const q = validate.string(req.query.q, 'q', { max: 120, required: true });
    const limit = validate.number(req.query.limit, 'limit', { min: 1, max: 20, required: false, fallback: 8 });
    let near = null;
    if (req.query.near) {
      const [lat, lon] = String(req.query.near).split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) near = [lat, lon];
    }

    const local = searchOffline(q, { limit, near });
    let results = local;

    // Only bother the geocoder when the local index is unconvincing.
    if (local.length < 3 || local[0].score < 70) {
      const remote = await geocodeUpstream(q, { limit });
      if (remote?.length) {
        const seen = new Set(local.map((r) => `${r.lat.toFixed(2)}:${r.lon.toFixed(2)}`));
        results = [...local, ...remote.filter((r) => !seen.has(`${r.lat.toFixed(2)}:${r.lon.toFixed(2)}`))].slice(0, limit);
      }
    }

    res.json({ query: q, count: results.length, results });
  }),
);

/** GET /api/places/reverse?lat=&lon= */
placesRouter.get(
  '/places/reverse',
  asyncHandler(async (req, res) => {
    const [lat, lon] = validate.latLon(req.query.lat, req.query.lon);
    const offline = nearest(lat, lon, { limit: 3 });
    const road = roadAt(lat, lon);
    const remote = await reverseUpstream(lat, lon);
    res.json({
      lat,
      lon,
      label: remote?.label ?? describe(lat, lon),
      road: remote?.road ?? road,
      state: remote?.state ?? offline[0]?.state ?? null,
      nearest: offline,
      source: remote ? 'osm' : 'offline',
    });
  }),
);
