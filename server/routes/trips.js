import { Router } from 'express';
import { asyncHandler, validate, rateLimit } from '../middleware/common.js';
import {
  createTrip,
  getTrip,
  authoriseTrip,
  addPing,
  listEvents,
  listPings,
  raiseSos,
  clearSos,
  setStatus,
  checkIn,
  activeTripSummary,
} from '../services/trips.js';
import { listReports } from '../services/reports.js';
import { analyseRoute } from '../services/hazards.js';

export const tripsRouter = Router();

const tokenFrom = (req) => req.get('x-trip-token') ?? req.body?.token ?? req.query.token ?? null;

function requireTripAuth(req, res, next) {
  if (!authoriseTrip(req.params.code, tokenFrom(req))) {
    return res.status(403).json({ error: 'Invalid trip token. Only the traveller can update this trip.' });
  }
  return next();
}

/** POST /api/trips — start sharing a journey. */
tripsRouter.post(
  '/trips',
  rateLimit({ key: 'trip-create', max: 30 }),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    if (!body.from || !body.to) throw Object.assign(new Error('from and to are required'), { status: 400 });
    const [fromLat, fromLon] = validate.latLon(body.from.lat, body.from.lon);
    const [toLat, toLon] = validate.latLon(body.to.lat, body.to.lon);

    const { trip, token } = createTrip({
      from: { lat: fromLat, lon: fromLon, label: validate.string(body.from.label, 'from.label', { max: 160 }) },
      to: { lat: toLat, lon: toLon, label: validate.string(body.to.label, 'to.label', { max: 160 }) },
      geometry: Array.isArray(body.geometry) ? body.geometry.filter((p) => Array.isArray(p) && p.length === 2) : [],
      distanceM: body.distanceM,
      durationS: body.durationS,
      eta: body.eta,
      traveller: body.traveller,
      note: body.note,
      deviceId: req.deviceId,
    });

    res.status(201).json({ trip, token, shareUrl: `/t/${trip.code}` });
  }),
);

/** GET /api/trips/:code — public view for whoever is watching. */
tripsRouter.get(
  '/trips/:code',
  asyncHandler(async (req, res) => {
    const trip = getTrip(req.params.code);
    if (!trip) return res.status(404).json({ error: 'No trip with that code' });

    let safety = null;
    if (trip.geometry?.length > 1) {
      const reports = listReports({ limit: 1500 });
      const analysis = analyseRoute(trip.geometry, reports, { source: 'offline', durationS: trip.durationS });
      safety = {
        score: analysis.score,
        grade: analysis.grade,
        gradeLabel: analysis.gradeLabel,
        hazardCount: analysis.hazardCount,
        ahead: analysis.hazards.filter((h) => h.alongM >= trip.progress * trip.distanceM).slice(0, 8),
      };
    }

    return res.json({
      trip,
      safety,
      events: listEvents(trip.code, 25),
      breadcrumbs: listPings(trip.code, 150).map((p) => [p.lat, p.lon]),
    });
  }),
);

/** POST /api/trips/:code/ping — traveller position update. */
tripsRouter.post(
  '/trips/:code/ping',
  rateLimit({ key: 'trip-ping', max: 400 }),
  requireTripAuth,
  asyncHandler(async (req, res) => {
    const [lat, lon] = validate.latLon(req.body?.lat, req.body?.lon);
    const trip = addPing(req.params.code, {
      lat,
      lon,
      speedKph: validate.number(req.body?.speedKph, 'speedKph', { min: 0, max: 300, required: false, fallback: null }),
      heading: validate.number(req.body?.heading, 'heading', { min: 0, max: 360, required: false, fallback: null }),
    });
    if (!trip) return res.status(404).json({ error: 'No trip with that code' });
    return res.json({ trip });
  }),
);

/** POST /api/trips/:code/status  {status: "arrived"|"cancelled"|"active"} */
tripsRouter.post(
  '/trips/:code/status',
  requireTripAuth,
  asyncHandler(async (req, res) => {
    const status = validate.oneOf(req.body?.status, 'status', ['active', 'arrived', 'cancelled']);
    const trip = setStatus(req.params.code, status, req.body?.message);
    if (!trip) return res.status(404).json({ error: 'No trip with that code' });
    return res.json({ trip });
  }),
);

/** POST /api/trips/:code/sos */
tripsRouter.post(
  '/trips/:code/sos',
  requireTripAuth,
  asyncHandler(async (req, res) => {
    const clear = req.body?.clear === true;
    const trip = clear
      ? clearSos(req.params.code)
      : raiseSos(req.params.code, {
          lat: req.body?.lat,
          lon: req.body?.lon,
          message: validate.string(req.body?.message, 'message', { max: 200 }),
        });
    if (!trip) return res.status(404).json({ error: 'No trip with that code' });
    return res.json({ trip });
  }),
);

/** POST /api/trips/:code/checkin */
tripsRouter.post(
  '/trips/:code/checkin',
  requireTripAuth,
  asyncHandler(async (req, res) => {
    const events = checkIn(req.params.code, {
      lat: req.body?.lat,
      lon: req.body?.lon,
      message: validate.string(req.body?.message, 'message', { max: 200 }),
    });
    res.json({ events });
  }),
);

tripsRouter.get(
  '/trips-summary',
  asyncHandler(async (req, res) => {
    res.json(activeTripSummary());
  }),
);
