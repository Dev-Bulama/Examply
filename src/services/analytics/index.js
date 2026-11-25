'use strict';

/**
 * Item and exam analysis. computeExam(examId) reads finished, non-study attempts and writes item_statistics
 * (one row per question per exam) and exam_statistics. Runs nightly (scheduler) and on demand.
 */
const { db } = require('../../config/db');
const { parseJson, toJson } = require('../../utils/json');
const P = require('./psychometrics');

const FINISHED = ['submitted', 'graded', 'pending_manual', 'expired'];
const CHOICE = ['single_choice', 'multiple_response', 'true_false', 'hotspot'];

async function computeExam(examId, knex = db()) {
  const all = await knex('attempts').where({ exam_id: examId }).whereNot('mode', 'study').select('id', 'status', 'started_at', 'submitted_at', 'percent', 'passed', 'submit_reason');
  const done = all.filter((a) => FINISHED.includes(a.status) && a.submitted_at);
  const ids = done.map((a) => a.id);
  const items = ids.length
    ? await knex('attempt_items as ai')
        .join('question_versions as v', 'v.id', 'ai.question_version_id')
        .whereIn('ai.attempt_id', ids)
        .whereNotIn('v.type', ['case_study'])
        .select('ai.attempt_id', 'ai.question_id', 'ai.question_version_id', 'ai.display_order', 'ai.marks_possible', 'ai.marks_awarded', 'ai.is_correct', 'ai.response', 'ai.time_spent_sec', 'ai.answered_at', 'v.type')
    : [];

  // Scores per attempt (0..1 per item; essays use awarded/possible once graded).
  const score01 = (it) => {
    if (it.marks_awarded === null || it.marks_awarded === undefined) return null;
    const possible = Number(it.marks_possible) || 0;
    return possible ? Math.max(0, Math.min(1, Number(it.marks_awarded) / possible)) : it.is_correct ? 1 : 0;
  };
  const byAttempt = new Map(ids.map((id) => [id, []]));
  for (const it of items) byAttempt.get(it.attempt_id).push(it);
  const totalOf = new Map();
  for (const [id, list] of byAttempt) totalOf.set(id, list.reduce((s, it) => s + (score01(it) || 0), 0));

  // Item statistics.
  const byQuestion = new Map();
  for (const it of items) {
    if (!byQuestion.has(it.question_id)) byQuestion.set(it.question_id, []);
    byQuestion.get(it.question_id).push(it);
  }
  const optionKeys = new Map();
  const versionIds = [...new Set(items.filter((i) => CHOICE.includes(i.type)).map((i) => i.question_version_id))];
  if (versionIds.length) {
    const opts = await knex('question_options as o').leftJoin('question_answers as qa', 'qa.question_version_id', 'o.question_version_id').whereIn('o.question_version_id', versionIds).select('o.question_version_id', 'o.option_key', 'qa.answer');
    for (const o of opts) {
      if (!optionKeys.has(o.question_version_id)) optionKeys.set(o.question_version_id, { keys: [], correct: (parseJson(o.answer, {}) || {}).correct || [] });
      optionKeys.get(o.question_version_id).keys.push(o.option_key);
    }
  }

  const now = new Date();
  let flagged = 0;
  const rows = [];
  for (const [questionId, list] of byQuestion) {
    const scored = list.filter((it) => score01(it) !== null);
    const s = scored.map(score01);
    const totals = scored.map((it) => totalOf.get(it.attempt_id));
    const p = P.difficulty(s);
    const rpb = P.pointBiserial(s, totals);
    const d27 = P.discrimination27(s, totals);
    let distractors = null;
    let unused = [];
    const latest = list[list.length - 1];
    const meta = optionKeys.get(latest.question_version_id);
    if (CHOICE.includes(latest.type) && meta) {
      const counts = Object.fromEntries(meta.keys.map((k) => [k, 0]));
      for (const it of list) {
        const r = parseJson(it.response, null);
        for (const k of [].concat((r && r.selected) || [])) if (k in counts) counts[k] += 1;
      }
      distractors = meta.keys.map((k) => ({ key: k, count: counts[k], correct: meta.correct.includes(k), share: list.length ? P.round(counts[k] / list.length, 3) : 0 }));
      if (list.length >= 20) unused = distractors.filter((x) => !x.correct && x.count === 0).map((x) => x.key);
    }
    const times = list.map((it) => Number(it.time_spent_sec)).filter((t) => t > 0);
    const flags = P.itemFlags({ n: s.length, p, rpb, unusedDistractors: unused });
    if (flags.some((f) => f.key !== 'low_sample')) flagged += 1;
    rows.push({ question_id: questionId, exam_id: examId, responses: list.length, p_value: p, point_biserial: rpb, discrimination_27: d27, distractors: distractors ? toJson(distractors) : null, avg_time_sec: times.length ? P.round(P.mean(times), 2) : null, flags: toJson(flags), computed_at: now });
  }
  await knex.transaction(async (trx) => {
    await trx('item_statistics').where({ exam_id: examId }).del();
    for (let i = 0; i < rows.length; i += 200) await trx('item_statistics').insert(rows.slice(i, i + 200));
  });

  // Reliability: the questions every finished attempt answered (fixed lists; blueprint exams share fewer).
  let alpha = null;
  if (done.length >= 3) {
    const sets = ids.map((id) => new Set(byAttempt.get(id).filter((it) => score01(it) !== null).map((it) => it.question_id)));
    const common = [...sets[0]].filter((q) => sets.every((set) => set.has(q)));
    if (common.length >= 2) {
      const matrix = ids.map((id) => {
        const m = new Map(byAttempt.get(id).map((it) => [it.question_id, score01(it)]));
        return common.map((q) => m.get(q));
      });
      alpha = P.cronbachAlpha(matrix);
    }
  }

  // Drop-off: where timed-out / expired attempts stopped answering.
  const dropoff = {};
  for (const a of done.filter((x) => x.status === 'expired' || x.submit_reason === 'timeout')) {
    const list = byAttempt.get(a.id).sort((x, y) => x.display_order - y.display_order);
    const firstUnanswered = list.findIndex((it) => !it.answered_at);
    if (firstUnanswered >= 0) dropoff[firstUnanswered + 1] = (dropoff[firstUnanswered + 1] || 0) + 1;
  }
  const percents = done.map((a) => Number(a.percent)).filter(Number.isFinite);
  const durations = done.map((a) => (new Date(a.submitted_at) - new Date(a.started_at)) / 1000).filter((x) => x > 0);
  const graded = done.filter((a) => a.passed !== null && a.passed !== undefined);
  const stats = {
    exam_id: examId,
    attempts: all.length,
    completed: done.length,
    completion_rate: all.length ? P.round(done.length / all.length) : null,
    pass_rate: graded.length ? P.round(graded.filter((a) => a.passed).length / graded.length) : null,
    avg_percent: percents.length ? P.round(P.mean(percents), 2) : null,
    avg_time_sec: durations.length ? P.round(P.mean(durations), 2) : null,
    kr20: alpha,
    cronbach_alpha: alpha,
    histogram: toJson(P.histogram(percents, 10, 0, 100)),
    dropoff: toJson(dropoff),
    computed_at: now,
  };
  await knex('exam_statistics').insert(stats).onConflict('exam_id').merge();
  return { ...stats, items: rows.length, flagged };
}

/** Nightly: every exam with finished attempts. */
async function computeAll({ knex = db() } = {}) {
  const examIds = await knex('attempts').whereIn('status', FINISHED).distinct('exam_id').pluck('exam_id');
  let n = 0;
  for (const id of examIds) {
    await computeExam(id, knex);
    n += 1;
  }
  return `${n} exam(s) analysed`;
}

module.exports = { computeExam, computeAll, FINISHED };
