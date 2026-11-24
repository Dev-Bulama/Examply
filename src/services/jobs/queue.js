'use strict';

const os = require('os');
const { db } = require('../../config/db');
const { getLogger } = require('../../config/logger');
const { toJson, parseJson } = require('../../utils/json');

const WORKER_ID = `${os.hostname()}:${process.pid}`.slice(0, 64);
const STALE_LOCK_MINUTES = 15;
const handlers = new Map();

/** Registers the function that processes jobs of `type`. handler(payload, job) → result (JSON-serialisable). */
function register(type, handler) {
  handlers.set(type, handler);
}

async function enqueue(type, payload = {}, { runAt = new Date(), maxAttempts = 3, knex = db() } = {}) {
  const [id] = await knex('jobs').insert({ type, payload: toJson(payload), status: 'pending', run_at: runAt, max_attempts: maxAttempts });
  return id;
}

async function releaseStaleLocks(knex = db()) {
  const cutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60000);
  return knex('jobs').where('status', 'running').where('locked_at', '<', cutoff).update({ status: 'pending', locked_at: null, locked_by: null });
}

async function claim(knex, limit) {
  const candidates = await knex('jobs').where('status', 'pending').where('run_at', '<=', new Date()).orderBy('run_at').orderBy('id').limit(limit).select('id');
  const claimed = [];
  for (const { id } of candidates) {
    const n = await knex('jobs').where({ id, status: 'pending' }).update({ status: 'running', locked_at: new Date(), locked_by: WORKER_ID, attempts: knex.raw('attempts + 1') });
    if (n === 1) claimed.push(await knex('jobs').where({ id }).first());
  }
  return claimed;
}

async function processJob(job, knex) {
  const log = getLogger();
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
    const result = await handler(parseJson(job.payload, {}), job);
    await knex('jobs').where({ id: job.id }).update({ status: 'completed', completed_at: new Date(), result: toJson(result ?? null), last_error: null, locked_at: null });
    return true;
  } catch (err) {
    const finalFailure = job.attempts >= job.max_attempts || err.permanent === true;
    const backoffMinutes = Math.min(60, 2 ** job.attempts);
    await knex('jobs')
      .where({ id: job.id })
      .update({
        status: finalFailure ? 'failed' : 'pending',
        run_at: finalFailure ? job.run_at : new Date(Date.now() + backoffMinutes * 60000),
        last_error: String(err.stack || err.message).slice(0, 4000),
        locked_at: null,
        locked_by: null,
      });
    log.warn({ jobId: job.id, type: job.type, attempt: job.attempts, finalFailure, err: err.message }, 'job failed');
    return false;
  }
}

/** Processes due jobs until none remain, `limit` is reached, or `timeBudgetMs` elapses. */
async function runDueJobs({ limit = 50, timeBudgetMs = 20000, knex = db() } = {}) {
  const started = Date.now();
  let processed = 0;
  let failed = 0;
  await releaseStaleLocks(knex);
  while (processed < limit && Date.now() - started < timeBudgetMs) {
    const batch = await claim(knex, Math.min(5, limit - processed));
    if (!batch.length) break;
    for (const job of batch) {
      const ok = await processJob(job, knex);
      processed += 1;
      if (!ok) failed += 1;
    }
  }
  return { processed, failed };
}

let pollTimer = null;
let polling = false;

function startPoller({ intervalMs = 3000 } = {}) {
  if (pollTimer) return;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      await runDueJobs({ limit: 25, timeBudgetMs: 10000 });
    } catch (err) {
      getLogger().error({ err: err.message }, 'job poller error');
    } finally {
      polling = false;
    }
  };
  pollTimer = setInterval(tick, intervalMs);
  pollTimer.unref();
}

function stopPoller() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = { register, enqueue, runDueJobs, startPoller, stopPoller, releaseStaleLocks, WORKER_ID };
