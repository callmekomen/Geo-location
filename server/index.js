import { createApp } from './app.js';
import { config } from './config.js';
import { log } from './logger.js';
import { getDb, closeDb } from './db/index.js';
import { sweepExpired } from './services/reports.js';
import { sweepOverdue } from './services/trips.js';
import { heartbeat, publish } from './services/events.js';
import { ensureSeed } from './db/seed.js';
import { gazetteerMeta } from './services/gazetteer.js';
import { graphMeta } from './services/graph.js';

getDb();
if (config.seedOnBoot) {
  const added = ensureSeed();
  if (added) log.info(`seeded ${added} demo reports`);
}

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  log.info(`Naija Routes listening on http://${config.host}:${config.port}`);
  log.info(`offline engine ready`, {
    places: gazetteerMeta.placeCount,
    roads: graphMeta.edges,
    networkKm: graphMeta.networkKm,
  });
});

/* Background housekeeping ------------------------------------------------ */
const timers = [
  setInterval(() => {
    const expired = sweepExpired();
    if (expired) {
      log.debug(`expired ${expired} reports`);
      publish('report:expired', { count: expired });
    }
  }, 60_000),

  setInterval(() => {
    const overdue = sweepOverdue();
    if (overdue) log.warn(`${overdue} trip(s) marked overdue`);
  }, 60_000),

  setInterval(heartbeat, 25_000),
];
timers.forEach((t) => t.unref?.());

/* Graceful shutdown ------------------------------------------------------ */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  timers.forEach(clearInterval);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }));

export { app, server };
