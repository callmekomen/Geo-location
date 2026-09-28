/**
 * SQLite driver adapter.
 *
 * Prefers `better-sqlite3` when it is installed and compiled, and otherwise
 * falls back to Node's built-in `node:sqlite`. Both are synchronous, so the
 * rest of the codebase does not care which one it got — and deployment does
 * not fall over because a machine has no C++ toolchain.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function tryBetterSqlite() {
  try {
    const Database = require('better-sqlite3');
    return (path) => {
      const db = new Database(path);
      return {
        driver: 'better-sqlite3',
        exec: (sql) => db.exec(sql),
        prepare: (sql) => db.prepare(sql),
        pragma: (statement) => db.pragma(statement),
        transaction: (fn) => db.transaction(fn),
        close: () => db.close(),
        raw: db,
      };
    };
  } catch {
    return null;
  }
}

function nodeSqlite() {
  // Node 22.5+ ships SQLite in core. It is flagged experimental, which only
  // means the API surface may grow — the storage engine is plain SQLite. We
  // silence that one warning so real warnings stay visible.
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes('SQLite is an experimental feature')) return;
    emitWarning(warning, ...rest);
  };
  const { DatabaseSync } = require('node:sqlite');
  return (path) => {
    const db = new DatabaseSync(path);
    let depth = 0;
    return {
      driver: 'node:sqlite',
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          run: (...args) => stmt.run(...args),
          get: (...args) => {
            const row = stmt.get(...args);
            return row === undefined ? undefined : { ...row };
          },
          all: (...args) => stmt.all(...args).map((row) => ({ ...row })),
          iterate: (...args) => stmt.iterate(...args),
        };
      },
      pragma: (statement) => db.exec(`PRAGMA ${statement}`),
      /** Mirrors better-sqlite3's transaction wrapper, including nesting. */
      transaction:
        (fn) =>
        (...args) => {
          if (depth > 0) return fn(...args);
          depth += 1;
          db.exec('BEGIN');
          try {
            const result = fn(...args);
            db.exec('COMMIT');
            return result;
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          } finally {
            depth -= 1;
          }
        },
      close: () => db.close(),
      raw: db,
    };
  };
}

const factory = tryBetterSqlite() ?? nodeSqlite();

export function open(path) {
  return factory(path);
}
