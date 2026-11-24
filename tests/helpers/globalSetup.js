'use strict';

const knexFactory = require('knex');
const path = require('path');
const { baseTestEnv } = require('./testEnv');

/** Rebuilds the test database schema from the migrations once per test run. */
module.exports = async () => {
  Object.assign(process.env, baseTestEnv());
  const { knexConfig } = require('../../src/config/db');
  const { loadEnv } = require('../../src/config/env');
  const env = loadEnv({ ...process.env, STORAGE_PATH: path.join(__dirname, '..', '..', 'storage') });
  const knex = knexFactory(knexConfig(env));
  try {
    await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = await knex.raw('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?', [env.DB_NAME]);
    for (const { t } of tables) await knex.raw('DROP TABLE IF EXISTS ??', [t]);
    await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
    await knex.migrate.latest();
  } finally {
    await knex.destroy();
  }
};
