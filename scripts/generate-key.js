'use strict';

/** Prints fresh secrets for .env (APP_KEY, SESSION_SECRET, CRON_TOKEN). Does not modify any file. */
const crypto = require('crypto');

process.stdout.write(
  [
    `APP_KEY=${crypto.randomBytes(32).toString('base64')}`,
    `SESSION_SECRET=${crypto.randomBytes(48).toString('hex')}`,
    `CRON_TOKEN=${crypto.randomBytes(24).toString('hex')}`,
    '',
    'Copy these into .env (or hPanel → Node.js → Environment variables).',
    'Keep APP_KEY forever: changing it makes encrypted settings unreadable.',
    '',
  ].join('\n'),
);
