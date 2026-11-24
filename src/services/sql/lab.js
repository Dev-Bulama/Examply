'use strict';

/**
 * SQL lab questions: run a candidate's query against the question dataset and compare it with the model solution.
 *
 * Modes
 *  - query  : the candidate's final SELECT result is compared with the solution's result.
 *  - modify : the candidate's statements (INSERT/UPDATE/DELETE/DDL) run first, then the author's check query runs on
 *             the resulting database; that output is compared with what the solution produces.
 *
 * Comparison options: order_matters (rows in order), column_names_matter, numeric_tolerance.
 * Marking is all-or-nothing; feedback explains what differed without revealing the expected values.
 */
const runner = require('./runner');

const MODES = ['query', 'modify'];

function datasetSql(spec) {
  return [spec.schema_sql || '', spec.seed_sql || ''].filter(Boolean).join('\n');
}

const isNum = (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));

function sameValue(a, b, tol) {
  if (a === null || b === null) return a === b;
  if (isNum(a) && isNum(b)) return Math.abs(Number(a) - Number(b)) <= (tol || 0) + 1e-9;
  return String(a) === String(b);
}

function canonical(row) {
  return JSON.stringify(row.map((v) => (v === null ? null : isNum(v) ? Number(Number(v).toPrecision(12)) : String(v))));
}

/** Compares two result sets. Returns { equal, reason }. */
function compareResults(actual, expected, opts = {}) {
  if (!actual || !actual.hasResult) return { equal: false, reason: 'Your SQL did not return a result set. End with a SELECT query.' };
  if (actual.columns.length !== expected.columns.length) {
    return { equal: false, reason: `Your query returns ${actual.columns.length} column${actual.columns.length === 1 ? '' : 's'}; the task needs ${expected.columns.length}.` };
  }
  if (opts.column_names_matter) {
    const a = actual.columns.map((c) => c.toLowerCase());
    const e = expected.columns.map((c) => c.toLowerCase());
    const wrong = e.filter((c, i) => a[i] !== c);
    if (wrong.length) return { equal: false, reason: `Column names do not match the task. Check the names or aliases of column${wrong.length === 1 ? '' : 's'} ${wrong.map((c) => e.indexOf(c) + 1).join(', ')}.` };
  }
  if (actual.rowCount !== expected.rowCount) {
    return { equal: false, reason: `Your query returns ${actual.rowCount} row${actual.rowCount === 1 ? '' : 's'}, which is not the expected number of rows.` };
  }
  const tol = Number(opts.numeric_tolerance) || 0;
  let a = actual.rows;
  let e = expected.rows;
  if (!opts.order_matters) {
    a = [...a].sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1));
    e = [...e].sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1));
  }
  for (let i = 0; i < e.length; i += 1) {
    for (let j = 0; j < e[i].length; j += 1) {
      if (!sameValue(a[i][j], e[i][j], tol)) {
        return { equal: false, reason: opts.order_matters ? `Row ${i + 1} differs from the expected result (check values and the ORDER BY).` : 'The rows returned are not the expected rows. Check your filters, joins and calculations.' };
      }
    }
  }
  return { equal: true, reason: null };
}

/** Builds runner jobs for a candidate answer and for the model solution. */
function jobs(spec, candidateSql) {
  const setup = datasetSql(spec);
  if (spec.mode === 'modify') {
    return {
      candidate: { setup, statements: [candidateSql, spec.check_sql] },
      solution: { setup, statements: [spec.solution_sql, spec.check_sql] },
    };
  }
  return { candidate: { setup, statements: [candidateSql] }, solution: { setup, statements: [spec.solution_sql] } };
}

/** Big enough to compare complete results (the display cap is applied separately). */
const COMPARE_ROWS = 5000;

/**
 * Marks a candidate's SQL. spec = { schema_sql, seed_sql, solution_sql, check_sql, mode, order_matters,
 * column_names_matter, numeric_tolerance }. Returns { correct, reason, error }.
 */
async function check(spec, candidateSql) {
  const sql = String(candidateSql || '').trim();
  if (!sql) return { correct: false, reason: 'No SQL was submitted.', error: null };
  const j = jobs(spec, sql);
  let mine;
  let model;
  try {
    [mine, model] = await Promise.all([runner.run({ ...j.candidate, maxRows: COMPARE_ROWS }), runner.run({ ...j.solution, maxRows: COMPARE_ROWS })]);
  } catch (e) {
    return { correct: false, reason: e.message, error: e.message };
  }
  if (!model.ok) return { correct: false, reason: 'This question’s model solution could not be run; it has been reported for review.', error: `solution: ${model.error}` };
  if (!mine.ok) {
    const where = spec.mode === 'modify' && mine.failedIndex === 1 ? 'After your statements ran, the check query failed: ' : '';
    return { correct: false, reason: `${where}${mine.error}`, error: mine.error };
  }
  const a = mine.results[mine.results.length - 1];
  const e = model.results[model.results.length - 1];
  const cmp = compareResults(a, e, spec);
  return { correct: cmp.equal, reason: cmp.reason, error: null };
}

/** Runs SQL for display (the "Run" button). Always on a fresh copy of the dataset. */
async function preview(spec, sql) {
  const res = await runner.run({ setup: datasetSql(spec), statements: [String(sql || '')], maxRows: runner.LIMITS.maxRows });
  const r = res.results[0] || null;
  return { ok: res.ok, error: res.error, timedOut: !!res.timedOut, ms: res.ms, result: r };
}

/** The tables and columns of a dataset (for the candidate's schema browser). */
async function describe(spec) {
  const res = await runner.run({
    setup: datasetSql(spec),
    statements: ["SELECT m.name, p.name, p.type, p.pk FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid"],
    maxRows: 2000,
  });
  if (!res.ok) return { ok: false, error: res.error, tables: [] };
  const tables = [];
  for (const [table, column, type, pk] of res.results[0].rows) {
    let t = tables.find((x) => x.name === table);
    if (!t) tables.push((t = { name: table, columns: [] }));
    t.columns.push({ name: column, type: type || '', pk: !!pk });
  }
  return { ok: true, error: null, tables };
}

/**
 * Author-time verification: the dataset builds, the solution runs and returns rows (and the check query for modify
 * mode). Returns [{ field, message }].
 */
async function verify(spec) {
  const errs = [];
  const j = jobs(spec, spec.solution_sql);
  let res;
  try {
    res = await runner.run({ ...j.solution, maxRows: COMPARE_ROWS });
  } catch (e) {
    return [{ field: 'solution_sql', message: e.message }];
  }
  if (!res.ok) {
    if (res.failedIndex === -1) errs.push({ field: 'schema_sql', message: res.error });
    else if (res.failedIndex === 1) errs.push({ field: 'check_sql', message: `The check query failed: ${res.error}` });
    else errs.push({ field: 'solution_sql', message: `The model solution failed: ${res.error}` });
    return errs;
  }
  const last = res.results[res.results.length - 1];
  if (!last.hasResult) errs.push({ field: spec.mode === 'modify' ? 'check_sql' : 'solution_sql', message: spec.mode === 'modify' ? 'The check query must be a SELECT that returns rows.' : 'The model solution must end with a SELECT that returns a result.' });
  if (spec.mode === 'query' && res.results.some((r) => r.changes > 0)) errs.push({ field: 'solution_sql', message: 'In “query” mode the solution should only read data. Use “modify” mode for tasks that change data.' });
  return errs;
}

module.exports = { MODES, check, preview, describe, verify, compareResults, datasetSql };
