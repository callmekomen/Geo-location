-- Naija Routes schema ------------------------------------------------------
-- SQLite keeps the whole deployment to a single file, which matters when the
-- thing has to run on a cheap VPS with intermittent power.

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  category     TEXT NOT NULL,
  severity     INTEGER NOT NULL DEFAULT 2,
  lat          REAL NOT NULL,
  lon          REAL NOT NULL,
  label        TEXT,
  note         TEXT,
  road         TEXT,
  place        TEXT,
  state        TEXT,
  device_id    TEXT,
  reporter     TEXT,
  confirms     INTEGER NOT NULL DEFAULT 0,
  disputes     INTEGER NOT NULL DEFAULT 0,
  meta         TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_position ON reports (lat, lon);
CREATE INDEX IF NOT EXISTS idx_reports_status   ON reports (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_reports_created  ON reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_type     ON reports (type);
CREATE INDEX IF NOT EXISTS idx_reports_state    ON reports (state);

CREATE TABLE IF NOT EXISTS report_votes (
  report_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  vote       TEXT NOT NULL CHECK (vote IN ('confirm', 'dispute')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (report_id, device_id)
);

CREATE TABLE IF NOT EXISTS trips (
  code        TEXT PRIMARY KEY,
  token       TEXT NOT NULL,
  device_id   TEXT,
  traveller   TEXT,
  from_label  TEXT NOT NULL,
  to_label    TEXT NOT NULL,
  from_lat    REAL NOT NULL,
  from_lon    REAL NOT NULL,
  to_lat      REAL NOT NULL,
  to_lon      REAL NOT NULL,
  geometry    TEXT,
  distance_m  INTEGER NOT NULL DEFAULT 0,
  duration_s  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active',
  eta         TEXT,
  note        TEXT,
  last_lat    REAL,
  last_lon    REAL,
  last_speed  REAL,
  progress    REAL NOT NULL DEFAULT 0,
  sos         INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_trips_status ON trips (status, eta);

CREATE TABLE IF NOT EXISTS trip_pings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  speed      REAL,
  heading    REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pings_code ON trip_pings (code, id DESC);

CREATE TABLE IF NOT EXISTS trip_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  message    TEXT,
  lat        REAL,
  lon        REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_code ON trip_events (code, id DESC);

CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stats (
  day   TEXT NOT NULL,
  name  TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);
