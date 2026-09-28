import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Point the app at a throwaway database before anything imports config. */
export function useTempDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'naija-routes-test-'));
  process.env.DATABASE_PATH = join(dir, 'test.db');
  process.env.SEED_ON_BOOT = '0';
  process.env.UPSTREAM_ENABLED = '0';
  process.env.LOG_LEVEL = 'error';
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** Boot the HTTP app on an ephemeral port and return a fetch bound to it. */
export async function startTestServer() {
  const { createApp } = await import('../server/app.js');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = async (path, options = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        'x-device-id': options.deviceId ?? 'test_device_0001',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    base,
    call,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
