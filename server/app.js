import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import {
  securityHeaders,
  deviceId,
  requestLogger,
  rateLimit,
  notFound,
  errorHandler,
} from './middleware/common.js';
import { metaRouter } from './routes/meta.js';
import { placesRouter } from './routes/places.js';
import { routingRouter } from './routes/routing.js';
import { reportsRouter } from './routes/reports.js';
import { tripsRouter } from './routes/trips.js';
import { insightsRouter } from './routes/insights.js';
import { assistantRouter } from './routes/assistant.js';
import { streamRouter } from './routes/stream.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

export function createApp() {
  const app = express();

  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(compression());
  app.use(express.json({ limit: '256kb' }));
  app.use(securityHeaders);
  app.use(deviceId);
  app.use(requestLogger);

  // The event stream is long-lived; keep it outside the global limiter.
  app.use('/api', streamRouter);
  app.use('/api', rateLimit({ key: 'api' }));
  app.use('/api', metaRouter);
  app.use('/api', placesRouter);
  app.use('/api', routingRouter);
  app.use('/api', reportsRouter);
  app.use('/api', tripsRouter);
  app.use('/api', insightsRouter);
  app.use('/api', assistantRouter);
  app.use('/api', notFound);

  // Trip watch pages: /t/ABC234
  app.get('/t/:code', (req, res) => res.sendFile(join(publicDir, 'track.html')));

  app.use(
    express.static(publicDir, {
      etag: true,
      lastModified: true,
      maxAge: config.env === 'production' ? '1h' : 0,
      setHeaders(res, path) {
        if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
        if (path.includes('/vendor/')) res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      },
    }),
  );

  app.use((req, res) => {
    if (req.method === 'GET' && req.accepts('html')) return res.sendFile(join(publicDir, 'index.html'));
    return res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}
