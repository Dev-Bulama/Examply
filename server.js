'use strict';

/**
 * Entry point (hPanel "Application startup file"). Boots Express, Socket.IO, the in-process scheduler and
 * the background job poller in ONE Node.js process.
 */
const http = require('http');
const { getEnv } = require('./src/config/env');

let env;
try {
  env = getEnv();
} catch (err) {
  process.stderr.write(`\n${err.message}\n\nSee .env.example for every variable.\n\n`);
  process.exit(1);
}

const { getLogger } = require('./src/config/logger');
const { db, closeDb } = require('./src/config/db');
const { createApp } = require('./src/app');
const system = require('./src/services/system');
const jobs = require('./src/services/jobs');
const realtime = require('./src/services/live/socket');

const logger = getLogger();

async function boot() {
  const app = createApp();
  const server = http.createServer(app);
  realtime.attach(server, app);

  if (system.isInstalled()) {
    try {
      // Pick up new permissions / templates shipped with an update; run pending migrations.
      await db().migrate.latest();
      await system.syncSystemData();
    } catch (err) {
      logger.error({ err: err.message }, 'Boot-time database sync failed — check DB credentials in the environment');
    }
  }

  jobs.registerAll();
  if (env.RUN_SCHEDULER && !env.isTest) {
    jobs.scheduler.startScheduler();
    jobs.queue.startPoller();
  }

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV, installed: system.isInstalled() }, `Skillscore Assess listening on port ${env.PORT}`);
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    jobs.scheduler.stopScheduler();
    jobs.queue.stopPoller();
    server.close(async () => {
      try {
        if (app.locals.closeSessionStore) await app.locals.closeSessionStore();
        await closeDb();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
}

boot().catch((err) => {
  logger.fatal({ err }, 'failed to boot');
  process.exit(1);
});
