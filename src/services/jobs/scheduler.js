'use strict';

const cron = require('node-cron');
const { db } = require('../../config/db');
const { getLogger } = require('../../config/logger');
const queue = require('./queue');

/**
 * Scheduled tasks. Each runs at most once per `everyMinutes`; last-run times are stored in the DB so the
 * in-process node-cron tick and the hPanel Cron Job (/cron/run) never double-run a task.
 */
const tasks = new Map();

function defineTask(name, everyMinutes, fn) {
  tasks.set(name, { name, everyMinutes, fn });
}

async function lastRuns(knex) {
  const rows = await knex('settings').where('key', 'like', 'cron.last_run.%').select('key', 'value');
  return new Map(rows.map((r) => [r.key.replace('cron.last_run.', ''), new Date(r.value)]));
}

async function markRun(knex, name, at) {
  await knex.raw('INSERT INTO settings (`key`, `value`, is_encrypted) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', [
    `cron.last_run.${name}`,
    at.toISOString(),
  ]);
}

/** Runs every due scheduled task, then drains the job queue. Safe to call concurrently from cron + HTTP. */
async function runScheduled({ knex = db(), force = false, timeBudgetMs = 25000 } = {}) {
  const log = getLogger();
  const now = new Date();
  const runs = await lastRuns(knex);
  const report = { tasks: {}, jobs: null };
  for (const task of tasks.values()) {
    const last = runs.get(task.name);
    const due = force || !last || now - last >= task.everyMinutes * 60000 - 5000;
    if (!due) continue;
    // Claim the slot first so a concurrent caller skips it.
    await markRun(knex, task.name, now);
    try {
      report.tasks[task.name] = (await task.fn({ knex })) ?? 'ok';
    } catch (err) {
      report.tasks[task.name] = `error: ${err.message}`;
      log.error({ task: task.name, err: err.message }, 'scheduled task failed');
    }
  }
  report.jobs = await queue.runDueJobs({ knex, timeBudgetMs });
  return report;
}

let cronTask = null;
let running = false;

function startScheduler() {
  if (cronTask) return;
  cronTask = cron.schedule('* * * * *', async () => {
    if (running) return;
    if (!require('../system').isInstalled()) return; // no tables before install
    if (!(await require('../dbHealth').check()).ok) return; // database down: wait for it, do not spam the log
    running = true;
    try {
      await runScheduled({ timeBudgetMs: 40000 });
    } catch (err) {
      getLogger().error({ err: err.message }, 'scheduler tick failed');
    } finally {
      running = false;
    }
  });
}

function stopScheduler() {
  if (cronTask) cronTask.stop();
  cronTask = null;
}

module.exports = { defineTask, runScheduled, startScheduler, stopScheduler, tasks };
