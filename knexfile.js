'use strict';

// Used by the knex CLI: `npx knex migrate:latest`, `npx knex seed:run`.
const { knexConfig } = require('./src/config/db');

module.exports = knexConfig();
