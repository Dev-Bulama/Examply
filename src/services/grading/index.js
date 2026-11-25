'use strict';

/**
 * gradeAttempt(attemptId) — marks every item with the QUESTION VERSION stored on the attempt, then stores a result
 * snapshot (per-item marks, section/domain/difficulty totals, band, percentile) so later question edits never change
 * a result, except through an explicit re-grade. Manual grades already given are kept on re-grade.
 */
const { db } = require('../../config/db');
const { parseJson, toJson } = require('../../utils/json');
const { markItem, round2 } = require('./strategies');
const { scoreAttempt, percentileRank } = require('./score');

async function loadSnapshot(knex, attempt) {
  const v = await knex('exam_versions').where({ exam_id: attempt.exam_id, version_no: attempt.exam_version }).first('snapshot');
  return parseJson(v && v.snapshot, null);
}

/** Loads attempt items with everything the strategies need (never sent to the browser). */
async function loadItemsForMarking(knex, attemptId) {
  const items = await knex('attempt_items as ai')
    .join('question_versions as v', 'v.id', 'ai.question_version_id')
    .join('questions as q', 'q.id', 'ai.question_id')
    .leftJoin('certification_domains as d', 'd.id', 'q.domain_id')
    .leftJoin('question_answers as qa', 'qa.question_version_id', 'v.id')
    .where('ai.attempt_id', attemptId)
    .orderBy('ai.display_order')
    .select('ai.*', 'v.type', 'v.settings as v_settings', 'qa.answer as v_answer', 'q.difficulty', 'q.domain_id', 'd.code as domain_code', 'd.name as domain_name');
  const out = items.map((it) => ({ ...it, settings: parseJson(it.v_settings, {}), answer: parseJson(it.v_answer, {}), response: parseJson(it.response, null) }));
  // Labs are answered on the server: the candidate's final machine is the response.
  const labs = require('../labs');
  for (const it of out) if (it.type === 'lab') it.response = { lab: await labs.stateForItem(it.id, knex) };
  return out;
}

function releaseStatus(exam, now = new Date()) {
  if (exam.result_release === 'manual') return 'withheld';
  if (exam.result_release === 'after_window') return exam.available_until && new Date(exam.available_until) <= now ? 'released' : 'withheld';
  return 'released';
}

async function gradeAttempt(attemptId, { knex = db(), regrade = false } = {}) {
  const attempt = await knex('attempts').where({ id: attemptId }).first();
  if (!attempt) throw new Error(`Attempt ${attemptId} not found`);
  const snap = await loadSnapshot(knex, attempt);
  const exam = snap ? snap.exam : await knex('exams').where({ id: attempt.exam_id }).first();
  const policy = { partialCredit: !!Number(exam.partial_credit), negative: Number(exam.negative_marking) || 0 };
  const sections = snap ? snap.sections : [];
  const sectionTitle = new Map(sections.map((s) => [s.id, s.title]));

  const items = await loadItemsForMarking(knex, attemptId);
  const marked = [];
  const now = new Date();
  for (const it of items) {
    if (it.type === 'case_study') continue; // the scenario itself carries no marks; its children are items
    let out;
    if (it.grading_status === 'manual') out = { awarded: Number(it.marks_awarded), correct: !!it.is_correct, status: 'manual' };
    else {
      out = await markItem({ type: it.type, marks: Number(it.marks_possible), answer: it.answer, settings: it.settings }, it.response, policy);
      await knex('attempt_items')
        .where({ id: it.id })
        .update({ marks_awarded: out.awarded, is_correct: out.correct, grading_status: out.status === 'pending_manual' ? 'pending_manual' : 'auto', graded_at: out.status === 'pending_manual' ? null : now });
    }
    marked.push({
      itemId: it.id,
      questionId: it.question_id,
      type: it.type,
      marksPossible: Number(it.marks_possible),
      awarded: out.awarded,
      correct: out.correct,
      status: out.status,
      unanswered: !!(out.detail && out.detail.unanswered),
      flagged: !!it.flagged,
      sectionId: it.section_id,
      sectionTitle: sectionTitle.get(it.section_id) || 'General',
      domainKey: it.domain_id ? String(it.domain_id) : null,
      domainLabel: it.domain_id ? `${it.domain_code ? `${it.domain_code} · ` : ''}${it.domain_name}` : null,
      difficulty: it.difficulty,
      timeSpent: it.time_spent_sec,
      detail: out.detail || null,
    });
  }

  const study = attempt.mode === 'study';
  const totals = scoreAttempt(marked, {
    passMark: study ? null : exam.pass_mark,
    passMarkType: exam.pass_mark_type,
    sections,
    bands: snap && !study ? snap.bands : [],
    scaling: snap && snap.settings ? snap.settings.scaling : null,
  });

  const others = await knex('results as r').join('attempts as a', 'a.id', 'r.attempt_id').where('r.exam_id', attempt.exam_id).whereNot('r.attempt_id', attemptId).where('r.has_pending_manual', false).whereNot('a.mode', 'study').pluck('r.percent');
  const percentile = percentileRank(totals.percent, others.map(Number));
  const breakdown = {
    sections: totals.sections,
    sectionMins: totals.sectionMins,
    domains: totals.domains,
    difficulty: totals.difficulty,
    types: totals.types,
    answered: totals.answered,
    correct: totals.correct,
    items: marked.map((m) => ({ id: m.itemId, q: m.questionId, a: m.awarded, m: m.marksPossible, c: m.correct, s: m.status, u: m.unanswered, f: m.flagged, d: m.domainKey })),
    passMark: exam.pass_mark === null ? null : Number(exam.pass_mark),
    passMarkType: exam.pass_mark_type,
  };

  const existing = await knex('results').where({ attempt_id: attemptId }).first('id', 'release_status', 'released_at', 'regrade_count');
  const status = existing && existing.release_status === 'released' ? 'released' : releaseStatus(exam, now);
  const row = {
    raw_score: totals.raw,
    max_score: totals.max,
    percent: totals.percent,
    scaled_score: totals.scaled,
    passed: totals.passed,
    band: totals.band,
    percentile,
    has_pending_manual: totals.pending > 0,
    breakdown: toJson(breakdown),
    release_status: status,
    released_at: status === 'released' ? (existing && existing.released_at) || now : null,
  };
  if (existing) await knex('results').where({ id: existing.id }).update({ ...row, regrade_count: existing.regrade_count + (regrade ? 1 : 0), updated_at: now });
  else await knex('results').insert({ ...row, attempt_id: attemptId, user_id: attempt.user_id, exam_id: attempt.exam_id });

  await knex('attempts')
    .where({ id: attemptId })
    .update({ status: totals.pending ? 'pending_manual' : 'graded', graded_at: totals.pending ? null : now, raw_score: totals.raw, max_score: totals.max, percent: totals.percent, scaled_score: totals.scaled, passed: totals.passed, band: totals.band });
  return { ...totals, percentile, releaseStatus: status };
}

/** Records a person's grade for one item (essays, or overriding an automatic mark), then re-totals the attempt. */
async function gradeItemManually(itemId, { marks, feedback, graderId }, knex = db()) {
  const it = await knex('attempt_items').where({ id: itemId }).first();
  if (!it) throw new Error('Item not found');
  const m = round2(Number(marks));
  if (!(m >= 0 && m <= Number(it.marks_possible))) {
    const err = new Error(`Marks must be between 0 and ${Number(it.marks_possible)}.`);
    err.status = 422;
    throw err;
  }
  await knex('attempt_items')
    .where({ id: itemId })
    .update({ marks_awarded: m, is_correct: m >= Number(it.marks_possible), grading_status: 'manual', grader_id: graderId, grader_feedback: String(feedback || '').slice(0, 5000) || null, graded_at: new Date() });
  return gradeAttempt(it.attempt_id, { knex });
}

module.exports = { gradeAttempt, gradeItemManually, loadItemsForMarking, loadSnapshot, releaseStatus };
