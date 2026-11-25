'use strict';

/**
 * Cached database health (refreshed at most every 10 s, each probe capped at 4 s) so a broken or missing
 * database connection shows a clear "reconnect" page instead of a 500 on every request.
 */
const { getEnv } = require('../config/env');

let state = { ok: true, code: null, at: 0 };
let inflight = null;

async function probe() {
  if (!getEnv().dbConfigured) return { ok: false, code: 'NOT_CONFIGURED' };
  const { db } = require('../config/db');
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 4000);
      timer.unref();
    });
    await Promise.race([db().raw('select 1'), timeout]);
    return { ok: true, code: null };
  } catch (err) {
    return { ok: false, code: String(err.code || err.errno || 'DB_ERROR').slice(0, 40) };
  } finally {
    clearTimeout(timer);
  }
}

/** Current health; refreshes in the background when older than 10 s (callers may await it). */
async function check({ force = false } = {}) {
  if (!force && Date.now() - state.at < 10000) return state;
  if (!inflight)
    inflight = probe().then((r) => {
      state = { ...r, at: Date.now() };
      inflight = null;
      return state;
    });
  return inflight;
}

const current = () => state;
const reset = () => {
  state = { ok: true, code: null, at: 0 };
};

/** Plain-language explanation of a driver error code (no secrets). */
function explain(code) {
  return (
    {
      NOT_CONFIGURED: 'No database details are saved on this server.',
      ER_ACCESS_DENIED_ERROR: 'The database user name or password was rejected.',
      ER_BAD_DB_ERROR: 'The database name does not exist.',
      ER_DBACCESS_DENIED_ERROR: 'The database user has no access to that database.',
      ECONNREFUSED: 'Nothing is listening at the database host and port.',
      ENOTFOUND: 'The database host name could not be found.',
      ETIMEDOUT: 'The database server did not answer in time.',
      TIMEOUT: 'The database server did not answer in time.',
    }[code] || 'The database connection failed.'
  );
}

module.exports = { check, current, reset, explain };
