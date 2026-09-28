import { Router } from 'express';
import { asyncHandler, validate } from '../middleware/common.js';
import { getDb } from '../db/index.js';
import { hotspots, reportCounts, listReports } from '../services/reports.js';
import { clusterStations, marketPrice } from '../services/fuel.js';
import { activeTripSummary } from '../services/trips.js';
import { REPORT_TYPES } from '../services/taxonomy.js';

export const insightsRouter = Router();

/**
 * GET /api/insights
 * The "state of the roads" dashboard: what is being reported, where, and how
 * fuel prices are moving.
 */
insightsRouter.get(
  '/insights',
  asyncHandler(async (req, res) => {
    const days = validate.number(req.query.days, 'days', { min: 1, max: 180, required: false, fallback: 14 });
    const db = getDb();
    const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();

    const daily = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
           FROM reports WHERE created_at > ? GROUP BY day ORDER BY day`,
      )
      .all(since);

    const byCategory = db
      .prepare(
        `SELECT category, COUNT(*) AS n FROM reports
          WHERE created_at > ? GROUP BY category ORDER BY n DESC`,
      )
      .all(since);

    const byRoad = db
      .prepare(
        `SELECT road, state, COUNT(*) AS n, AVG(severity) AS severity FROM reports
          WHERE created_at > ? AND road IS NOT NULL AND severity >= 2
          GROUP BY road ORDER BY n DESC LIMIT 10`,
      )
      .all(since);

    const fuelReports = listReports({ categories: ['fuel'], limit: 1000 });
    const stations = clusterStations(fuelReports);
    const priced = stations.filter((s) => s.price);
    const byState = {};
    for (const s of priced) {
      if (!s.state) continue;
      byState[s.state] ??= [];
      byState[s.state].push(s.price);
    }

    res.json({
      generatedAt: new Date().toISOString(),
      windowDays: days,
      counts: reportCounts(),
      trips: activeTripSummary(),
      daily,
      byCategory: byCategory.map((row) => ({ ...row, label: row.category })),
      topRoads: byRoad.map((row) => ({ ...row, severity: Math.round(row.severity * 10) / 10 })),
      hotspots: hotspots({ days, limit: 10 }),
      fuel: {
        market: marketPrice(stations),
        stations: stations.length,
        selling: stations.filter((s) => s.hasFuel).length,
        byState: Object.entries(byState)
          .map(([state, prices]) => ({
            state,
            samples: prices.length,
            average: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
            min: Math.min(...prices),
            max: Math.max(...prices),
          }))
          .sort((a, b) => b.samples - a.samples)
          .slice(0, 10),
      },
      typeLegend: Object.fromEntries(Object.entries(REPORT_TYPES).map(([k, v]) => [k, { label: v.label, colour: v.colour }])),
    });
  }),
);
