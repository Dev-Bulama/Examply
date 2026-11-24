'use strict';

/** Environment for the test run. Uses a separate database: DB_NAME_TEST (default skillscore_test). */
const crypto = require('crypto');

function baseTestEnv() {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
  return {
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:3999',
    APP_KEY: 'Z3Rlc3RrZXktdGVzdGtleS10ZXN0a2V5LXRlc3RrZXk=',
    SESSION_SECRET: 'test-session-secret-test-session-secret-0123',
    CRON_TOKEN: 'test-cron-token-0123456789abcdef',
    DB_HOST: process.env.DB_HOST || '127.0.0.1',
    DB_PORT: process.env.DB_PORT || '3306',
    DB_USER: process.env.DB_USER || 'skillscore',
    DB_PASSWORD: process.env.DB_PASSWORD || '',
    DB_NAME: process.env.DB_NAME_TEST || 'skillscore_test',
    LOG_LEVEL: 'silent',
    RUN_SCHEDULER: 'false',
    DEFAULT_TIMEZONE: 'Africa/Lagos',
    _RUN_ID: crypto.randomBytes(4).toString('hex'),
  };
}

module.exports = { baseTestEnv };
