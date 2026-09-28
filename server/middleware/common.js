import { randomUUID } from 'node:crypto';
import { config, isProduction } from '../config.js';
import { log } from '../logger.js';

/** Wrap async handlers so rejected promises reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  // No X-Frame-Options: the CSP frame-ancestors directive below supersedes it
  // and, unlike XFO, can name the hosts that are allowed to embed a preview.
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://tile.openstreetmap.org",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "script-src 'self'",
      "connect-src 'self' https://*.tile.openstreetmap.org",
      "worker-src 'self'",
      "frame-ancestors 'self' https://*.e2b.app https://*.arena.ai",
      "base-uri 'self'",
    ].join('; '),
  );
  next();
}

/**
 * Anonymous identity. No accounts, no email, no password — just a random id
 * the browser keeps so votes and trip ownership can be attributed.
 */
export function deviceId(req, res, next) {
  const header = req.get('x-device-id');
  req.deviceId = header && /^[\w-]{8,64}$/.test(header) ? header : `anon_${randomUUID().slice(0, 8)}`;
  next();
}

export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (req.path.startsWith('/api')) {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      log[level](`${req.method} ${req.originalUrl} ${res.statusCode}`, `${ms.toFixed(1)}ms`);
    }
  });
  next();
}

/** Fixed-window rate limiter, per IP+route bucket. Memory only, zero deps. */
export function rateLimit({ windowMs = config.limits.windowMs, max = config.limits.max, key = 'global' } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref?.();

  return (req, res, next) => {
    const id = `${key}:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
    const now = Date.now();
    const entry = hits.get(id);
    if (!entry || entry.reset < now) {
      hits.set(id, { count: 1, reset: now + windowMs });
      res.setHeader('X-RateLimit-Remaining', max - 1);
      return next();
    }
    entry.count += 1;
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many requests — slow down a little.' });
    }
    return next();
  };
}

export function notFound(req, res) {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) log.error(`${req.method} ${req.path} failed`, { message: err.message, stack: err.stack?.split('\n')[1] });
  res.status(status).json({
    error: err.expose === false && isProduction ? 'Something went wrong on our side.' : err.message,
    ...(isProduction ? {} : { stack: status >= 500 ? err.stack?.split('\n').slice(0, 4) : undefined }),
  });
}

/* ------------------------------------------------------------------ *
 * Tiny validation helpers — enough structure without a schema library
 * ------------------------------------------------------------------ */
export const validate = {
  number(value, name, { min = -Infinity, max = Infinity, required = true, fallback } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) throw Object.assign(new Error(`${name} is required`), { status: 400 });
      return fallback;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw Object.assign(new Error(`${name} must be a number`), { status: 400 });
    if (n < min || n > max) throw Object.assign(new Error(`${name} must be between ${min} and ${max}`), { status: 400 });
    return n;
  },
  latLon(lat, lon) {
    return [
      validate.number(lat, 'lat', { min: -90, max: 90 }),
      validate.number(lon, 'lon', { min: -180, max: 180 }),
    ];
  },
  string(value, name, { max = 500, required = false, fallback = null } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) throw Object.assign(new Error(`${name} is required`), { status: 400 });
      return fallback;
    }
    return String(value).slice(0, max);
  },
  oneOf(value, name, allowed, { required = true, fallback = null } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) throw Object.assign(new Error(`${name} is required`), { status: 400 });
      return fallback;
    }
    if (!allowed.includes(value)) {
      throw Object.assign(new Error(`${name} must be one of: ${allowed.join(', ')}`), { status: 400 });
    }
    return value;
  },
  bbox(raw) {
    if (!raw) return null;
    const parts = String(raw).split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw Object.assign(new Error('bbox must be "minLat,minLon,maxLat,maxLon"'), { status: 400 });
    }
    const [minLat, minLon, maxLat, maxLon] = parts;
    return { minLat: Math.min(minLat, maxLat), minLon: Math.min(minLon, maxLon), maxLat: Math.max(minLat, maxLat), maxLon: Math.max(minLon, maxLon) };
  },
};
