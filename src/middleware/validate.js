'use strict';

const { wantsJson } = require('./auth');

/** Flattens a ZodError into { field: 'message. message.' } (all distinct messages for a field). */
function fieldErrors(zodError) {
  const out = {};
  for (const issue of zodError.issues) {
    const key = issue.path.join('.') || '_form';
    if (!out[key]) out[key] = issue.message;
    else if (!out[key].includes(issue.message)) out[key] = `${out[key]} ${issue.message}`;
  }
  return out;
}

/**
 * Validates req.body (or req.query) with a zod schema. On failure: JSON 422 for API calls; otherwise
 * preserves input + errors in the session and redirects back to the form.
 */
function validate(schema, { source = 'body', redirect } = {}) {
  return (req, res, next) => {
    const result = schema.safeParse(req[source] || {});
    if (result.success) {
      req.validated = result.data;
      return next();
    }
    const errors = fieldErrors(result.error);
    if (wantsJson(req)) return res.status(422).json({ error: 'Validation failed', errors });
    req.setFormState(req[source], errors);
    req.flash('danger', 'Please correct the highlighted fields.');
    const to = typeof redirect === 'function' ? redirect(req) : redirect || req.originalUrl;
    return res.redirect(to);
  };
}

module.exports = { validate, fieldErrors };
