'use strict';

/**
 * SQL runner — a small pool of worker threads executing SQL in sandboxed, in-memory SQLite databases.
 *
 *  - Every run gets a fresh database built from the question's dataset (schema + seed), so candidates cannot affect
 *    each other or the platform database (which is MySQL and is never reachable from here).
 *  - A hard wall-clock limit per run: a worker that overruns (e.g. an endless recursive CTE) is terminated and
 *    replaced, and the caller gets a clear "time limit" error.
 *  - Output is capped (rows, statement size) to protect memory and the browser.
 */
const path = require('path');
const { Worker } = require('worker_threads');

const LIMITS = {
  timeoutMs: 3000,
  maxRows: 200,
  maxSqlLength: 20000,
  poolSize: 2,
  queueLimit: 50,
};

const BLOCKED = /\b(ATTACH|DETACH|load_extension|VACUUM\s+INTO)\b/i;

class SqlRunError extends Error {}

let seq = 0;
const workers = [];
const queue = [];

function spawn() {
  const w = new Worker(path.join(__dirname, 'worker.js'));
  const slot = { worker: w, busy: null, timer: null };
  w.on('message', (reply) => {
    const job = slot.busy;
    if (!job || reply.id !== job.id) return;
    clearTimeout(slot.timer);
    slot.busy = null;
    job.resolve(reply);
    pump();
  });
  w.on('error', (err) => fail(slot, err.message));
  w.on('exit', () => {
    if (slot.busy) fail(slot, 'The SQL engine stopped unexpectedly.');
    const i = workers.indexOf(slot);
    if (i >= 0) workers.splice(i, 1);
  });
  w.unref();
  workers.push(slot);
  return slot;
}

function fail(slot, message) {
  const job = slot.busy;
  slot.busy = null;
  clearTimeout(slot.timer);
  if (job) job.resolve({ id: job.id, ok: false, results: [], error: message, failedIndex: null, ms: LIMITS.timeoutMs, timedOut: /time limit/.test(message) });
}

function pump() {
  while (queue.length) {
    let slot = workers.find((s) => !s.busy);
    if (!slot && workers.length < LIMITS.poolSize) slot = spawn();
    if (!slot) return;
    const job = queue.shift();
    slot.busy = job;
    slot.timer = setTimeout(() => {
      // Kill the runaway thread; a fresh one is spawned for the next job.
      fail(slot, `Your SQL took longer than the ${LIMITS.timeoutMs / 1000}-second time limit and was stopped.`);
      const i = workers.indexOf(slot);
      if (i >= 0) workers.splice(i, 1);
      slot.worker.terminate();
      pump();
    }, LIMITS.timeoutMs);
    slot.worker.postMessage({ id: job.id, setup: job.setup, statements: job.statements, maxRows: job.maxRows });
  }
}

/**
 * Runs `statements` (array of SQL texts; each may contain several statements — the last result set is returned)
 * after building the dataset from `setup`.
 */
function run({ setup = '', statements = [], maxRows = LIMITS.maxRows } = {}) {
  for (const s of statements) {
    if (String(s).length > LIMITS.maxSqlLength) return Promise.reject(new SqlRunError(`SQL is limited to ${LIMITS.maxSqlLength.toLocaleString('en')} characters.`));
    if (BLOCKED.test(s)) return Promise.reject(new SqlRunError('ATTACH, DETACH, VACUUM INTO and extensions are not available in the SQL lab.'));
  }
  if (queue.length >= LIMITS.queueLimit) return Promise.reject(new SqlRunError('The SQL lab is busy. Please try again in a few seconds.'));
  return new Promise((resolve) => {
    seq += 1;
    queue.push({ id: seq, setup: String(setup || ''), statements: statements.map(String), maxRows, resolve });
    pump();
  });
}

async function shutdown() {
  await Promise.all(workers.splice(0).map((s) => s.worker.terminate()));
}

module.exports = { run, shutdown, LIMITS, SqlRunError };
