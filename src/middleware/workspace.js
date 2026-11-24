'use strict';

/**
 * Company workspace isolation inside /admin. When req.workspace is set (a company's manager or author):
 *  - only the content screens are reachable (questions, imports, AI, exams, attempts, grading, SQL lab);
 *  - every :id in those routes must belong to the workspace (checked here, centrally, before any controller);
 *  - list pages and creation are scoped by the controllers via `scopeOrg(req)`.
 * Platform staff are never in workspace mode.
 */
const { db } = require('../config/db');
const { forbidden, notFound } = require('../utils/errors');

const ALLOWED = [/^\/$/, /^\/questions(\/|$)/, /^\/imports(\/|$)/, /^\/ai(\/|$)/, /^\/exams(\/|$)/, /^\/attempts(\/|$)/, /^\/grading(\/|$)/, /^\/sql\/run$/, /^\/certificates\/\d+\/revoke$/, /^\/catalogue\/certifications\/\d+\/domains\.json$/];
const BLOCKED = [/^\/questions\/reports/, /^\/users\/\d+\/author-categories/];

/** organisation_id to stamp on new content and to filter lists by: the workspace, or NULL for platform content. */
const scopeOrg = (req) => (req.workspace ? req.workspace.id : null);

function guard(req, res, next) {
  if (!req.workspace) return next();
  if (!req.workspace.active) return next(forbidden('Your company plan is not active. Renew it from your workspace page to keep building exams.'));
  if (BLOCKED.some((r) => r.test(req.path)) || !ALLOWED.some((r) => r.test(req.path))) return next(forbidden());
  return next();
}

/** Which table an :id belongs to, by the first path segment. */
const OWNERS = {
  questions: (id) => db()('questions').where({ id }).first('organisation_id'),
  exams: (id) => db()('exams').where({ id }).first('organisation_id'),
  imports: (id) => db()('imports').where({ id }).first('organisation_id'),
  attempts: (id) => db()('attempts as a').join('exams as e', 'e.id', 'a.exam_id').where('a.id', id).first('e.organisation_id'),
  certificates: (id) => db()('certificates as c').join('exams as e', 'e.id', 'c.exam_id').where('c.id', id).first('e.organisation_id'),
};

/** router.param handler: 404 for any record outside the workspace (and, for platform staff, nothing changes). */
async function ownsParam(req, res, next, value) {
  if (!req.workspace) return next();
  try {
    const segment = req.path.split('/')[1];
    const lookup = OWNERS[segment];
    if (!lookup) return next();
    const row = await lookup(Number(value));
    if (!row || row.organisation_id !== req.workspace.id) return next(notFound());
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { guard, ownsParam, scopeOrg };
