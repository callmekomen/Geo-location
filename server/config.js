import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(here, '..');

/** Minimal .env loader — no dependency, no surprises. */
function loadDotEnv() {
  const file = join(rootDir, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
};
const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',

  databasePath: process.env.DATABASE_PATH
    ? resolve(rootDir, process.env.DATABASE_PATH)
    : join(rootDir, 'data', 'runtime', 'naija-routes.db'),
  seedOnBoot: bool(process.env.SEED_ON_BOOT, true),

  upstream: {
    enabled: bool(process.env.UPSTREAM_ENABLED, true),
    osrm: (process.env.OSRM_URL ?? 'https://router.project-osrm.org').replace(/\/$/, ''),
    nominatim: (process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    timeoutMs: int(process.env.UPSTREAM_TIMEOUT_MS, 4000),
    contact: process.env.CONTACT_EMAIL ?? '',
    userAgent: `NaijaRoutes/2.0 (${process.env.CONTACT_EMAIL || 'https://github.com/callmekomen/Geo-location'})`,
  },

  assistant: {
    provider: (process.env.ASSISTANT_PROVIDER ?? 'none').toLowerCase(),
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
    openaiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.ASSISTANT_MODEL ?? '',
  },

  limits: {
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: int(process.env.RATE_LIMIT_MAX, 240),
    reportMax: int(process.env.REPORT_RATE_LIMIT_MAX, 20),
  },
};

export const isProduction = config.env === 'production';
