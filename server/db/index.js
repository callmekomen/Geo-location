import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { open } from './driver.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));

let instance = null;

export function getDb() {
  if (instance) return instance;

  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = open(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

  instance = db;
  log.info('database ready', { path: config.databasePath, driver: db.driver });
  return db;
}

export function driverName() {
  return getDb().driver;
}

/** Bump a daily counter — cheap analytics with no third party involved. */
export function bump(name, amount = 1) {
  const day = new Date().toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO stats (day, name, value) VALUES (?, ?, ?)
       ON CONFLICT(day, name) DO UPDATE SET value = value + excluded.value`,
    )
    .run(day, name, amount);
}

export function cacheGet(key) {
  const row = getDb().prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    getDb().prepare('DELETE FROM cache WHERE key = ?').run(key);
    return null;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function cacheSet(key, value, ttlMs) {
  getDb()
    .prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)')
    .run(key, JSON.stringify(value), Date.now() + ttlMs);
}

export function closeDb() {
  if (instance) {
    instance.close();
    instance = null;
  }
}
