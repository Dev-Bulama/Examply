'use strict';

/**
 * CLI alternative to GET /cron/run — runs due scheduled tasks and drains the job queue, then exits.
 * hPanel Cron Job example (every 5 minutes):  cd ~/domains/example.com/app && node scripts/cron.js
 */
const { getEnv } = require('../src/config/env');
const { closeDb } = require('../src/config/db');
const system = require('../src/services/system');
const jobs = require('../src/services/jobs');

(async () => {
  getEnv();
  if (!system.isInstalled()) {
    process.stderr.write('Not installed yet — open /install first.\n');
    process.exit(1);
  }
  jobs.registerAll();
  const report = await jobs.scheduler.runScheduled({ timeBudgetMs: 50000, force: process.argv.includes('--force') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await closeDb();
})().catch(async (err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  await closeDb();
  process.exit(1);
});
