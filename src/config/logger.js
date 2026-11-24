'use strict';

const pino = require('pino');
const { getEnv } = require('./env');
const { storagePath } = require('./paths');

let logger;

function buildLogger() {
  const env = getEnv();
  if (env.isTest) return pino({ level: 'silent' });
  const streams = [{ level: env.LOG_LEVEL, stream: process.stdout }];
  try {
    const rfs = require('rotating-file-stream');
    const fileStream = rfs.createStream('app.log', {
      path: storagePath('logs'),
      interval: '1d',
      maxFiles: 14,
      compress: 'gzip',
    });
    streams.push({ level: env.LOG_LEVEL, stream: fileStream });
  } catch (err) {
    process.stderr.write(`File logging disabled: ${err.message}\n`);
  }
  return pino(
    {
      level: env.LOG_LEVEL,
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-paystack-signature"]', '*.password', '*.secret'],
        censor: '[redacted]',
      },
    },
    pino.multistream(streams),
  );
}

function getLogger() {
  if (!logger) logger = buildLogger();
  return logger;
}

module.exports = { getLogger };
