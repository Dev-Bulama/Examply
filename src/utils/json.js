'use strict';

/**
 * MySQL 8 returns JSON columns as objects; MariaDB stores JSON as LONGTEXT and returns strings.
 * Always read JSON columns through parseJson().
 */
function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value);
  } catch {
    return fallback;
  }
}

/** Serialises a value for a JSON column (works for both MySQL and MariaDB). */
function toJson(value) {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

module.exports = { parseJson, toJson };
