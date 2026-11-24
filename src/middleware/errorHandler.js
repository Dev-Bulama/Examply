'use strict';

const { getLogger } = require('../config/logger');
const { getEnv } = require('../config/env');
const { wantsJson } = require('./auth');

function notFoundHandler(req, res) {
  if (wantsJson(req)) return res.status(404).json({ error: 'Not found' });
  return res.status(404).render('errors/404', { title: 'Page not found', layout: 'layouts/public' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const env = getEnv();
  let status = err.status || err.statusCode || 500;
  let message = err.expose !== false && status < 500 ? err.message : 'Something went wrong on our side. The error has been logged.';

  if (err.code === 'EBADCSRFTOKEN') {
    status = 403;
    message = 'Your session expired or the form was out of date. Please go back, reload the page and try again.';
  } else if (err.name === 'MulterError') {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : `Upload error: ${err.message}`;
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'The request is too large.';
  }

  if (status >= 500) {
    (req.log || getLogger()).error({ err, url: req.originalUrl, userId: req.user && req.user.id }, 'request failed');
  }

  if (res.headersSent) return next(err);
  if (wantsJson(req)) return res.status(status).json({ error: message, code: err.code, details: err.details });

  const view = [403, 404, 429].includes(status) ? `errors/${status}` : status >= 500 ? 'errors/500' : 'errors/generic';
  try {
    return res.status(status).render(view, {
      title: status >= 500 ? 'Server error' : 'Something went wrong',
      layout: 'layouts/public',
      status,
      message,
      stack: env.isProduction ? null : err.stack,
    });
  } catch (renderErr) {
    return res.status(status).type('text').send(message);
  }
}

module.exports = { notFoundHandler, errorHandler };
