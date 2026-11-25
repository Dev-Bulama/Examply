'use strict';

const lab = require('../../services/sql/lab');
const { SqlRunError } = require('../../services/sql/runner');
const repo = require('../../services/questions/repository');
const types = require('../../services/questions/types');
const { notFound } = require('../../utils/errors');

async function respond(res, spec, sql, { check = false } = {}) {
  try {
    const out = { ok: true };
    out.run = await lab.preview(spec, sql);
    if (check) out.check = await lab.check(spec, sql);
    return res.json(out);
  } catch (err) {
    if (err instanceof SqlRunError) return res.status(422).json({ ok: false, error: err.message });
    throw err;
  }
}

/** Editor: run SQL against the dataset currently in the form (not yet saved). */
async function runDraft(req, res) {
  const q = types.normalise({ type: 'sql', ...req.body.question });
  const target = req.body.target === 'solution' ? q.solution_sql : req.body.target === 'check' ? q.check_sql : String(req.body.sql || '');
  if (req.body.target === 'describe') return res.json({ ok: true, schema: await lab.describe(q) });
  if (req.body.target === 'verify') return res.json({ ok: true, errors: await lab.verify(q) });
  if (q.mode === 'modify' && req.body.target === 'solution') {
    // Show the effect of the solution: run it, then the check query, on one copy of the dataset.
    const runner = require('../../services/sql/runner');
    const r = await runner.run({ setup: lab.datasetSql(q), statements: [q.solution_sql, q.check_sql || 'SELECT 1'] });
    return res.json({ ok: true, run: { ok: r.ok, error: r.error, timedOut: !!r.timedOut, ms: r.ms, result: r.results[r.results.length - 1] || null } });
  }
  return respond(res, q, target);
}

/** Question preview: run SQL against a saved question's dataset; "check" also marks it against the solution. */
async function runQuestion(req, res) {
  const loaded = await repo.loadQuestion(Number(req.params.id));
  if (!loaded || loaded.type !== 'sql' || !loaded.current) throw notFound('SQL question not found.');
  const spec = types.normalise(loaded.current.authoring);
  if (req.body.describe) return res.json({ ok: true, schema: await lab.describe(spec) });
  return respond(res, spec, req.body.sql, { check: !!req.body.check });
}

/** Staff preview of a lab question: a personal machine per question version; "reset" starts over. */
async function labPreview(req, res) {
  const labs = require('../../services/labs');
  const loaded = await repo.loadQuestion(Number(req.params.id));
  if (!loaded || loaded.type !== 'lab' || !loaded.current) throw notFound('Lab not found.');
  const versionId = loaded.current.version.id;
  const ownerKey = `preview:${req.user.id}:${versionId}`;
  try {
    if (req.body.reset) await labs.reset(ownerKey);
    const sess = await labs.session({ ownerKey, versionId, userId: req.user.id });
    if (req.body.init || req.body.reset) return res.json({ ok: true, ...labs.greeting(sess, loaded.current.settings.brief || {}) });
    const out = await labs.exec(sess, String(req.body.command || ''));
    // Staff see task progress live (candidates do not).
    const g = labs.scenarioLib.grade(loaded.current.answer.scenario || {}, sess.state);
    return res.json({ ok: true, ...out, tasks: g.tasks });
  } catch (err) {
    if (!(err instanceof labs.LabError)) throw err;
    return res.status(err.status).json({ ok: false, error: err.message });
  }
}

module.exports = { runDraft, runQuestion, labPreview };
