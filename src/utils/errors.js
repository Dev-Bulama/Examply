'use strict';

class HttpError extends Error {
  constructor(status, message, { code, details, expose = true } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

const notFound = (msg = 'The page you are looking for does not exist.') => new HttpError(404, msg, { code: 'NOT_FOUND' });
const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg, { code: 'FORBIDDEN' });
const badRequest = (msg = 'The request was invalid.', details) => new HttpError(400, msg, { code: 'BAD_REQUEST', details });

/** Wraps an async route handler so rejected promises reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, notFound, forbidden, badRequest, asyncHandler };
