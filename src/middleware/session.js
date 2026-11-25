'use strict';

const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const { getEnv } = require('../config/env');
const system = require('../services/system');

const MySQLStore = MySQLStoreFactory(session);

/**
 * Before install the database may not have tables yet, so the installer uses an in-memory store.
 * After install every session lives in MySQL (`sessions` table).
 */
function createSessionMiddleware() {
  const env = getEnv();
  const cookie = { httpOnly: true, sameSite: 'lax', secure: env.isProduction ? 'auto' : false, maxAge: null };
  const base = { name: 'ssa.sid', secret: env.SESSION_SECRET, resave: false, saveUninitialized: false, rolling: true, proxy: true, cookie };

  const memory = session({ ...base, store: new session.MemoryStore() });
  let mysqlMiddleware = null;
  let store = null;

  const getMysql = () => {
    if (!mysqlMiddleware) {
      const env = getEnv(); // re-read: the installer may have saved database settings since boot
      store = new MySQLStore({
        host: env.DB_HOST,
        port: env.DB_PORT,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_NAME,
        createDatabaseTable: false,
        clearExpired: true,
        checkExpirationInterval: 15 * 60 * 1000,
        expiration: 31 * 24 * 3600 * 1000,
        connectionLimit: 3,
        schema: { tableName: 'sessions', columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' } },
      });
      mysqlMiddleware = session({ ...base, store });
    }
    return mysqlMiddleware;
  };

  const middleware = (req, res, next) => (system.isInstalled() ? getMysql()(req, res, next) : memory(req, res, next));
  middleware.close = async () => {
    if (store) await store.close();
  };
  return middleware;
}

module.exports = { createSessionMiddleware };
