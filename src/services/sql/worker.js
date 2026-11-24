'use strict';

/**
 * SQL lab worker: runs SQL against a throw-away in-memory SQLite database (sql.js / WebAssembly — no native module,
 * no file system access). One job at a time; the pool kills and replaces this thread if a job exceeds its time limit.
 *
 * job = { id, setup: string, statements: [string], maxRows }
 * reply = { id, ok, results: [{ sql, columns, rows, truncated, changes }], error, failedIndex, ms }
 */
const { parentPort } = require('worker_threads');
const initSqlJs = require('sql.js');

let SQL = null;
const ready = initSqlJs().then((s) => {
  SQL = s;
});

function toPlain(v) {
  if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
  return v;
}

function totalChanges(db) {
  return db.exec('SELECT total_changes()')[0].values[0][0];
}

function runJob(job) {
  const started = Date.now();
  const db = new SQL.Database();
  const out = { id: job.id, ok: true, results: [], error: null, failedIndex: null, ms: 0 };
  try {
    // ~16 MB database ceiling (4096 pages × 4 KB) so a runaway INSERT … SELECT cannot exhaust memory.
    db.run('PRAGMA page_size = 4096; PRAGMA max_page_count = 4096; PRAGMA foreign_keys = ON;');
    if (job.setup) {
      try {
        db.exec(job.setup);
      } catch (e) {
        out.ok = false;
        out.error = `Dataset setup failed: ${e.message}`;
        out.failedIndex = -1;
        return out;
      }
    }
    for (let i = 0; i < job.statements.length; i += 1) {
      const sql = job.statements[i];
      try {
        const before = totalChanges(db);
        const res = db.exec(sql);
        const changes = totalChanges(db) - before;
        const last = res.length ? res[res.length - 1] : null;
        const rows = last ? last.values : [];
        out.results.push({
          columns: last ? last.columns : [],
          rows: rows.slice(0, job.maxRows).map((r) => r.map(toPlain)),
          rowCount: rows.length,
          truncated: rows.length > job.maxRows,
          changes: Math.max(0, changes),
          hasResult: !!last,
        });
      } catch (e) {
        out.ok = false;
        out.error = e.message;
        out.failedIndex = i;
        break;
      }
    }
    return out;
  } finally {
    db.close();
    out.ms = Date.now() - started;
  }
}

parentPort.on('message', async (job) => {
  await ready;
  let reply;
  try {
    reply = runJob(job);
  } catch (e) {
    reply = { id: job.id, ok: false, results: [], error: e.message, failedIndex: null, ms: 0 };
  }
  parentPort.postMessage(reply);
});
