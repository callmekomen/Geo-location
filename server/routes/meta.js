import { Router } from 'express';
import { asyncHandler } from '../middleware/common.js';
import { REPORT_TYPES, CATEGORIES, VEHICLES, DEFAULT_FUEL_PRICE } from '../services/taxonomy.js';
import { gazetteerMeta, states } from '../services/gazetteer.js';
import { graphMeta, roadClasses } from '../services/graph.js';
import { upstreamStatus } from '../services/upstream.js';
import { assistantMode } from '../services/assistant.js';
import { reportCounts } from '../services/reports.js';
import { activeTripSummary } from '../services/trips.js';
import { clientCount } from '../services/events.js';

export const metaRouter = Router();

let bootTime = Date.now();

metaRouter.get(
  '/health',
  asyncHandler(async (req, res) => {
    res.json({
      ok: true,
      uptimeS: Math.round((Date.now() - bootTime) / 1000),
      version: '2.0.0',
      time: new Date().toISOString(),
    });
  }),
);

metaRouter.get(
  '/meta',
  asyncHandler(async (req, res) => {
    res.json({
      app: {
        name: 'Naija Routes',
        version: '2.0.0',
        tagline: 'Community road intelligence for Nigeria',
      },
      reportTypes: REPORT_TYPES,
      categories: CATEGORIES,
      vehicles: VEHICLES,
      defaultFuelPrice: DEFAULT_FUEL_PRICE,
      states,
      gazetteer: gazetteerMeta,
      network: { ...graphMeta, classes: roadClasses },
      upstream: upstreamStatus(),
      assistant: { mode: assistantMode() },
      live: { listeners: clientCount(), ...activeTripSummary() },
      reports: reportCounts(),
    });
  }),
);
