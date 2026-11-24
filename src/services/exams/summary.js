'use strict';

/**
 * Builds the normalised exam summary used by the instruction generator, the pre-publish checklist, the catalogue and
 * the builder's live preview. Pure: takes the loaded exam structure (see repository.loadFull).
 *
 * full = { exam, settings, sections, items, rules, bands, access, ruleAvailability? }
 *   items: [{ question_id, section_id, type, marks, child_count, child_types }]
 *   rules: [{ section_id, question_count, question_types[], marks, available?, pool_types? }]
 */
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function sectionCounts(full) {
  const counts = new Map();
  const inc = (sid, n) => counts.set(sid || 0, (counts.get(sid || 0) || 0) + n);
  if (full.exam.content_mode === 'blueprint') for (const r of full.rules) inc(r.section_id, Number(r.question_count) || 0);
  else for (const it of full.items) inc(it.section_id, it.type === 'case_study' ? it.child_count || 0 : 1);
  return counts;
}

function buildSummary(full) {
  const e = full.exam;
  const s = full.settings;
  const blueprint = e.content_mode === 'blueprint';
  const counts = sectionCounts(full);

  let questionCount = 0;
  let totalMarks = 0;
  const types = new Set();
  let mixedTypes = false;
  if (blueprint) {
    for (const r of full.rules) {
      questionCount += Number(r.question_count) || 0;
      totalMarks += (Number(r.question_count) || 0) * (num(r.marks) || num(r.avg_marks) || 1);
      const rt = r.question_types && r.question_types.length ? r.question_types : r.pool_types || [];
      if (!(r.question_types && r.question_types.length) && !r.pool_types) mixedTypes = true;
      rt.forEach((t) => types.add(t));
    }
  } else {
    const deliverable = full.items.reduce((n, it) => n + (it.type === 'case_study' ? it.child_count || 0 : 1), 0);
    const dc = s.delivery.deliver_count;
    questionCount = dc && dc < deliverable ? dc : deliverable;
    let marks = 0;
    for (const it of full.items) {
      marks += Number(it.marks) || 0;
      if (it.type === 'case_study') (it.child_types || []).forEach((t) => types.add(t));
      else types.add(it.type);
    }
    totalMarks = dc && dc < deliverable && deliverable ? (marks / deliverable) * dc : marks;
  }

  const sections = full.sections.map((sec) => ({
    id: sec.id,
    title: sec.title,
    questionCount: counts.get(sec.id) || 0,
    timeLimitMinutes: num(sec.time_limit_minutes),
    minScorePercent: num(sec.min_score_percent),
  }));
  if (sections.length && counts.get(0)) sections.unshift({ id: null, title: 'General', questionCount: counts.get(0), timeLimitMinutes: null, minScorePercent: null });

  return {
    title: e.title,
    type: e.type,
    questionCount,
    totalMarks: Math.round(totalMarks * 100) / 100,
    questionTypes: [...types].sort(),
    mixedTypes,
    randomised: blueprint || (!!s.delivery.deliver_count && s.delivery.deliver_count < full.items.length),
    sections,
    durationMinutes: num(e.duration_minutes),
    graceSeconds: num(e.grace_seconds) || 0,
    perQuestionSeconds: num(e.per_question_seconds),
    timeOutAction: s.timing.time_out_action,
    availableFrom: e.available_from || null,
    availableUntil: e.available_until || null,
    passMark: num(e.pass_mark),
    passMarkType: e.pass_mark_type,
    negativeMarking: num(e.negative_marking) || 0,
    partialCredit: !!e.partial_credit,
    scaling: s.scaling,
    bands: (full.bands || []).map((b) => ({ name: b.name, min: num(b.min_percent), max: num(b.max_percent) })),
    maxAttempts: num(e.max_attempts),
    cooldownMinutes: num(e.cooldown_minutes) || 0,
    scorePolicy: e.score_policy,
    navigation: s.delivery.navigation,
    layout: s.delivery.layout,
    allowFlag: s.delivery.allow_flag,
    showPalette: s.delivery.show_palette,
    showTimer: s.delivery.show_timer,
    calculator: s.delivery.calculator,
    notepad: s.delivery.notepad,
    practiceCheck: s.delivery.practice_check_answer,
    integrity: {
      fullscreen: s.integrity.fullscreen,
      recordTabSwitches: s.integrity.record_tab_switches,
      tabSwitchLimit: s.integrity.tab_switch_limit,
      autoSubmitOnLimit: s.integrity.auto_submit_on_limit,
      disableCopy: s.integrity.disable_copy,
      singleSession: s.integrity.single_session,
      webcam: s.integrity.webcam,
      watermark: s.integrity.watermark,
      ipRestricted: (full.access || []).some((a) => a.rule_type === 'ip_allow'),
    },
    resultRelease: e.result_release,
    certificateEnabled: !!e.certificate_enabled,
    customBefore: s.instructions.custom_before,
    customAfter: s.instructions.custom_after,
  };
}

module.exports = { buildSummary, sectionCounts };
