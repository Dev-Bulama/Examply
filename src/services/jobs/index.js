'use strict';

/** Registers every job handler and scheduled task. Imported once at boot (server.js, scripts/cron.js, tests). */
const queue = require('./queue');
const scheduler = require('./scheduler');
const mail = require('../mail');
const maintenance = require('./maintenanceTasks');

let registered = false;

function registerAll() {
  if (registered) return;
  registered = true;

  queue.register('email.send', async (payload) => mail.sendNow(payload));
  require('../import/pipeline').registerJobs();
  require('../ai/generator').registerJobs();

  scheduler.defineTask('cleanup', 60, maintenance.cleanup);
  const attempts = require('../attempts');
  scheduler.defineTask('attempts.sweep', 1, ({ knex }) => attempts.sweepExpired({ knex }));
  scheduler.defineTask('assignments.remind', 60, ({ knex }) => require('../workspaces').sendDeadlineReminders({ knex }));
  scheduler.defineTask('orders.expire', 60, ({ knex }) => require('../commerce').expireStaleOrders({ knex }));
  scheduler.defineTask('analytics.items', 1440, ({ knex }) => require('../analytics').computeAll({ knex }));
  scheduler.defineTask('results.release', 15, ({ knex }) => attempts.releaseClosedWindows({ knex }));
}

module.exports = { registerAll, queue, scheduler };
