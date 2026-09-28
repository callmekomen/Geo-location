import { Router } from 'express';
import { asyncHandler, validate, rateLimit } from '../middleware/common.js';
import { planRoute, aroundPoint } from '../services/planner.js';
import { VEHICLES } from '../services/taxonomy.js';

export const routingRouter = Router();

routingRouter.use(rateLimit({ key: 'routing', max: 120 }));

function endpointFrom(value, name) {
  if (!value) throw Object.assign(new Error(`${name} is required`), { status: 400 });
  if (typeof value === 'string') return { q: value };
  if (typeof value === 'object') {
    if (value.lat !== undefined && value.lon !== undefined) {
      const [lat, lon] = validate.latLon(value.lat, value.lon);
      return { lat, lon, label: validate.string(value.label, `${name}.label`, { max: 160 }) };
    }
    if (value.q) return { q: String(value.q).slice(0, 160) };
  }
  throw Object.assign(new Error(`${name} must be a place name or {lat, lon}`), { status: 400 });
}

/**
 * POST /api/route
 * {
 *   from: "Ikeja" | {lat, lon, label},
 *   to:   "Benin City" | {lat, lon},
 *   vehicle?: "car"|"suv"|"bus"|"truck"|"bike",
 *   departAt?: ISO string,
 *   tankPct?: 0..1,
 *   alternatives?: boolean
 * }
 */
routingRouter.post(
  '/route',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const plan = await planRoute({
      from: endpointFrom(body.from, 'from'),
      to: endpointFrom(body.to, 'to'),
      vehicle: validate.oneOf(body.vehicle, 'vehicle', Object.keys(VEHICLES), { required: false, fallback: 'car' }),
      departAt: body.departAt,
      tankPct: validate.number(body.tankPct, 'tankPct', { min: 0.05, max: 1, required: false, fallback: 0.5 }),
      alternatives: body.alternatives !== false,
      corridorM: validate.number(body.corridorM, 'corridorM', { min: 200, max: 20000, required: false, fallback: undefined }),
    });
    res.json(plan);
  }),
);

/** GET /api/around?lat=&lon=&radius= — everything worth knowing nearby. */
routingRouter.get(
  '/around',
  asyncHandler(async (req, res) => {
    const [lat, lon] = validate.latLon(req.query.lat, req.query.lon);
    const radius = validate.number(req.query.radius, 'radius', { min: 500, max: 200000, required: false, fallback: 25000 });
    res.json(aroundPoint(lat, lon, radius));
  }),
);
