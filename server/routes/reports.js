import { Router } from 'express';
import { asyncHandler, validate, rateLimit } from '../middleware/common.js';
import { config } from '../config.js';
import {
  createReport,
  listReports,
  getReport,
  voteReport,
  hotspots,
  reportCounts,
} from '../services/reports.js';
import { clusterStations, marketPrice } from '../services/fuel.js';
import { REPORT_TYPE_IDS, CATEGORIES } from '../services/taxonomy.js';
import { publish } from '../services/events.js';

export const reportsRouter = Router();

const writeLimit = rateLimit({ key: 'report-write', max: config.limits.reportMax });

/** GET /api/reports?bbox=&types=&categories=&since=&near=&radius= */
reportsRouter.get(
  '/reports',
  asyncHandler(async (req, res) => {
    const bbox = validate.bbox(req.query.bbox);
    let near = null;
    let radiusM = null;
    if (req.query.near) {
      const [lat, lon] = String(req.query.near).split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        near = [lat, lon];
        radiusM = validate.number(req.query.radius, 'radius', { min: 100, max: 300000, required: false, fallback: 20000 });
      }
    }
    const types = req.query.types ? String(req.query.types).split(',').filter((t) => REPORT_TYPE_IDS.includes(t)) : null;
    const categories = req.query.categories
      ? String(req.query.categories).split(',').filter((c) => Object.hasOwn(CATEGORIES, c))
      : null;

    const reports = listReports({
      bbox,
      near,
      radiusM,
      types,
      categories,
      state: validate.string(req.query.state, 'state', { max: 40 }),
      sinceHours: validate.number(req.query.since, 'since', { min: 1, max: 24 * 365, required: false, fallback: null }),
      limit: validate.number(req.query.limit, 'limit', { min: 1, max: 2000, required: false, fallback: 600 }),
      includeExpired: req.query.includeExpired === '1',
      minConfidence: validate.number(req.query.minConfidence, 'minConfidence', {
        min: 0,
        max: 1,
        required: false,
        fallback: null,
      }),
    });

    res.json({ count: reports.length, reports });
  }),
);

/** GET /api/reports/stations — fuel reports collapsed into stations. */
reportsRouter.get(
  '/reports/stations',
  asyncHandler(async (req, res) => {
    const bbox = validate.bbox(req.query.bbox);
    const reports = listReports({ bbox, categories: ['fuel'], limit: 1500 });
    const stations = clusterStations(reports);
    res.json({ count: stations.length, stations, market: marketPrice(stations) });
  }),
);

/** GET /api/reports/hotspots */
reportsRouter.get(
  '/reports/hotspots',
  asyncHandler(async (req, res) => {
    res.json({
      hotspots: hotspots({
        days: validate.number(req.query.days, 'days', { min: 1, max: 365, required: false, fallback: 30 }),
        limit: validate.number(req.query.limit, 'limit', { min: 1, max: 50, required: false, fallback: 12 }),
      }),
      counts: reportCounts(),
    });
  }),
);

reportsRouter.get(
  '/reports/:id',
  asyncHandler(async (req, res) => {
    const report = getReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    return res.json({ report });
  }),
);

/** POST /api/reports */
reportsRouter.post(
  '/reports',
  writeLimit,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const [lat, lon] = validate.latLon(body.lat, body.lon);
    const type = validate.oneOf(body.type, 'type', REPORT_TYPE_IDS);

    const meta = {};
    if (body.meta && typeof body.meta === 'object') {
      if (body.meta.price !== undefined && body.meta.price !== '') {
        meta.price = validate.number(body.meta.price, 'meta.price', { min: 50, max: 10000, required: false });
      }
      if (body.meta.queue) meta.queue = validate.string(body.meta.queue, 'meta.queue', { max: 40 });
      if (body.meta.brand) meta.brand = validate.string(body.meta.brand, 'meta.brand', { max: 40 });
      if (body.meta.product) meta.product = validate.string(body.meta.product, 'meta.product', { max: 20 });
    }

    const { report, deduped } = createReport({
      type,
      lat,
      lon,
      severity: body.severity,
      label: body.label,
      note: body.note,
      reporter: body.reporter,
      deviceId: req.deviceId,
      meta: Object.keys(meta).length ? meta : null,
    });

    publish(deduped ? 'report:confirmed' : 'report:new', report);
    res.status(201).json({ report, deduped });
  }),
);

/** POST /api/reports/:id/vote  {vote: "confirm"|"dispute"} */
reportsRouter.post(
  '/reports/:id/vote',
  writeLimit,
  asyncHandler(async (req, res) => {
    const vote = validate.oneOf(req.body?.vote, 'vote', ['confirm', 'dispute']);
    const report = voteReport(req.params.id, req.deviceId, vote);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    publish('report:updated', report);
    return res.json({ report });
  }),
);
