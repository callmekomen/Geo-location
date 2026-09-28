import { Router } from 'express';
import { addClient, removeClient, recentEvents } from '../services/events.js';

export const streamRouter = Router();

/**
 * GET /api/stream?topics=report,trip
 * Server-sent events: new reports, votes, trip pings, SOS.
 */
streamRouter.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 4000\n\n');

  const topics = req.query.topics ? String(req.query.topics).split(',') : ['*'];
  const id = addClient(res, { topics });

  res.write(`event: hello\ndata: ${JSON.stringify({ id, recent: recentEvents(10) })}\n\n`);

  req.on('close', () => {
    removeClient(id);
    res.end();
  });
});
