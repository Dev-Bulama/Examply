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
}

module.exports = { registerAll, queue, scheduler };
