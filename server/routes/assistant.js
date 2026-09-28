import { Router } from 'express';
import { asyncHandler, validate, rateLimit } from '../middleware/common.js';
import { ask, assistantMode } from '../services/assistant.js';
import { bump } from '../db/index.js';

export const assistantRouter = Router();

/**
 * POST /api/assistant
 * { message, context: {route, position}, history: [{role, content}] }
 */
assistantRouter.post(
  '/assistant',
  rateLimit({ key: 'assistant', max: 60 }),
  asyncHandler(async (req, res) => {
    const message = validate.string(req.body?.message, 'message', { max: 800, required: true });
    const history = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          .slice(-8)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }))
      : [];

    const answer = await ask({ message, context: req.body?.context ?? {}, history });
    bump('assistant_messages');
    res.json({ ...answer, mode: answer.mode ?? assistantMode(), at: new Date().toISOString() });
  }),
);
