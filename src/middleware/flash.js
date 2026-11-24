'use strict';

/**
 * Session flash messages + "form state" (previous input and field errors) so forms can re-render with
 * the user's input preserved after a validation redirect.
 *
 * Messages added with req.flash() survive a redirect; rendering a page consumes them.
 */
function flash(req, res, next) {
  const pending = (req.session && req.session.flash) || [];
  res.locals.flash = [...pending];

  req.flash = (type, message) => {
    res.locals.flash.push({ type, message });
    if (req.session) {
      req.session.flash = req.session.flash || [];
      req.session.flash.push({ type, message });
    }
  };
  req.setFormState = (values, errors) => {
    if (!req.session) return;
    const safe = { ...values };
    for (const k of Object.keys(safe)) if (/password|secret|code|token|_csrf/i.test(k)) delete safe[k];
    req.session.formState = { values: safe, errors };
  };

  const state = (req.session && req.session.formState) || {};
  res.locals.old = state.values || {};
  res.locals.errors = state.errors || {};

  const render = res.render.bind(res);
  res.render = (...args) => {
    if (req.session) {
      delete req.session.flash;
      delete req.session.formState;
    }
    return render(...args);
  };
  next();
}

module.exports = { flash };
