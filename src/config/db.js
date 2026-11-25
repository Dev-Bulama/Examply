'use strict';

const knexFactory = require('knex');
const { getEnv } = require('./env');

function knexConfig(env = getEnv(), overrides = {}) {
  return {
    client: 'mysql2',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      charset: 'utf8mb4',
      // All timestamps are stored and read as UTC.
      timezone: 'Z',
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: true,
      ...(overrides.connection || {}),
    },
    pool: {
      min: 0,
      max: env.DB_POOL_MAX,
      afterCreate(conn, done) {
        conn.query("SET time_zone = '+00:00'", (err) => done(err, conn));
      },
    },
    migrations: { directory: require('path').join(env.rootDir, 'migrations'), tableName: 'knex_migrations' },
    seeds: { directory: require('path').join(env.rootDir, 'seeds') },
    acquireConnectionTimeout: 15000,
  };
}

let instance;
function db() {
  if (!instance) instance = knexFactory(knexConfig());
  return instance;
}

async function closeDb() {
  if (instance) {
    const i = instance;
    instance = undefined;
    await i.destroy();
  }
}

/** Returns null when the DB is reachable, otherwise a human-readable error message. */
async function checkConnection(knex) {
  if (!knex && !getEnv().dbConfigured) return 'NOT_CONFIGURED: no database settings yet';
  knex = knex || db();
  try {
    await knex.raw('select 1 as ok');
    return null;
  } catch (err) {
    return `${err.code || 'DB_ERROR'}: ${err.sqlMessage || err.message}`;
  }
}

module.exports = { db, closeDb, knexConfig, checkConnection };
