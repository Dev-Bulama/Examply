'use strict';

/**
 * Instruction Generator — composes candidate-facing instructions from an exam's ACTUAL settings, so they can never
 * contradict the configuration. Pure function: no database, no clock (the caller passes `ctx.now`).
 *
 *   generateInstructions(exam, user, ctx) → { title, intro, sections: [{ id, heading, items: [string] }], customBefore, customAfter }
 *
 * `exam` is the normalised summary built by services/exams/summary.js. `user` may be null (generic instructions for the
 * catalogue page). `ctx` = { now, attemptsUsed, extraAttempts, cooldownEndsAt, lastAttemptAt, formatDateTime }.
 */

const TYPE_NAMES = {
  single_choice: 'single-choice',
  multiple_response: 'multiple-response (select all that apply)',
  true_false: 'true/false',
  fill_blank: 'fill-in-the-blank',
  numeric: 'numeric-answer',
  matching: 'matching',
  ordering: 'ordering',
  hotspot: 'image hotspot',
  short_answer: 'short-answer',
  essay: 'essay',
  case_study: 'case-study (scenario)',
  sql: 'SQL lab',
};

const EXAM_PURPOSE = {
  pre_training: 'This is a pre-training diagnostic. It measures your current level so your training can start in the right place — there is no need to revise for it, and an honest attempt gives the most useful result.',
  post_training: 'This is a post-training assessment. Your score is compared with your pre-training diagnostic to measure how much you have learned.',
  practice: 'This is a practice test to help you prepare. Use it to find the topics you need to revise.',
  mock: 'This is a mock certification exam that simulates the real exam’s format, timing and difficulty.',
  past_questions: 'This is a past-questions practice set.',
  live_quiz: 'This is a live quiz run by a host.',
  assignment: 'This is a self-paced assignment.',
};

const RELEASE = {
  full_review: 'As soon as you submit, you will see your score, a breakdown by topic, and every question with your answer, the correct answer and an explanation.',
  score_breakdown: 'As soon as you submit, you will see your score and a breakdown by topic. Individual questions and answers are not shown, to protect the exam.',
  score_only: 'As soon as you submit, you will see your overall score. Answers and topic breakdowns are not shown.',
  after_window: 'Your result will be released after the exam window closes',
  manual: 'Your result will be released by the exam administrator after review. You will be notified by email.',
};

const plural = (n, word, pluralWord) => `${n} ${n === 1 ? word : pluralWord || `${word}s`}`;
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function minutesText(min) {
  if (min < 60) return plural(min, 'minute');
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
}

function generateInstructions(exam, user = null, ctx = {}) {
  const sections = [];
  const add = (id, heading, items) => {
    const clean = items.filter(Boolean);
    if (clean.length) sections.push({ id, heading, items: clean });
  };
  const fmtDT = ctx.formatDateTime || ((d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
  const extraPct = (user && user.accommodations && Number(user.accommodations.extra_time_percent)) || 0;
  const adjusted = (min) => Math.ceil(min * (1 + extraPct / 100));

  // ---- About this exam
  const typeNames = (exam.questionTypes || []).map((t) => TYPE_NAMES[t] || t);
  add('about', 'About this exam', [
    EXAM_PURPOSE[exam.type] || null,
    exam.questionCount
      ? `You will answer ${plural(exam.questionCount, 'question')}${exam.sections.length > 1 ? ` in ${plural(exam.sections.length, 'section')}` : ''}${exam.randomised ? ', drawn at random from a larger question bank, so your questions may differ from other candidates’' : ''}.`
      : null,
    typeNames.length ? `Question types: ${listJoin(typeNames)}.` : exam.mixedTypes ? 'The exam uses a mix of question types.' : null,
    exam.questionTypes && exam.questionTypes.includes('sql') ? 'SQL lab questions give you a sample database: write a query, run it to see the result, then submit your final query. Your answer is marked by comparing what your query returns with the expected result.' : null,
    exam.questionTypes && exam.questionTypes.includes('essay') ? 'Essay answers are marked by an examiner; your result for those questions will show as “pending” until they are graded.' : null,
    exam.sections.length > 1 ? `Sections: ${exam.sections.map((s, i) => `${i + 1}. ${s.title} (${plural(s.questionCount, 'question')}${s.timeLimitMinutes ? `, ${minutesText(adjusted(s.timeLimitMinutes))}` : ''})`).join('; ')}.` : null,
  ]);

  // ---- Timing
  const timing = [];
  if (exam.durationMinutes) {
    const total = adjusted(exam.durationMinutes);
    timing.push(`You have ${minutesText(total)} in total${extraPct ? ` (this includes your ${extraPct}% extra time)` : ''}. The timer starts when you begin and keeps running even if you close the browser or lose your connection.`);
  } else {
    timing.push('There is no overall time limit. Take the time you need.');
  }
  if (exam.sections.some((s) => s.timeLimitMinutes)) timing.push('Some sections have their own time limit. When a section’s time runs out, that section is closed and you move to the next one.');
  if (exam.perQuestionSeconds) timing.push(`Each question has a limit of ${plural(Math.round(exam.perQuestionSeconds * (1 + extraPct / 100)), 'second')}; when it expires the exam moves on to the next question automatically.`);
  if (exam.durationMinutes) timing.push(exam.timeOutAction === 'auto_submit' ? 'When time runs out, your exam is submitted automatically with the answers you have saved so far.' : 'When time runs out, you can no longer change your answers.');
  if (exam.graceSeconds) timing.push(`A short grace period of ${plural(exam.graceSeconds, 'second')} covers network delays when time runs out.`);
  if (exam.availableUntil) timing.push(`The exam closes on ${fmtDT(exam.availableUntil)}. An attempt in progress must be submitted before then.`);
  add('timing', 'Time', timing);

  // ---- Scoring
  const scoring = [];
  if (exam.passMark !== null && exam.passMark !== undefined) {
    scoring.push(exam.passMarkType === 'raw' ? `The pass mark is ${fmtNum(exam.passMark)} out of ${fmtNum(exam.totalMarks)} marks.` : `The pass mark is ${fmtNum(exam.passMark)}%.`);
  }
  if (exam.sections.some((s) => s.minScorePercent)) scoring.push(`You must also reach the minimum score in ${listJoin(exam.sections.filter((s) => s.minScorePercent).map((s) => `“${s.title}” (${fmtNum(s.minScorePercent)}%)`))}.`);
  if (exam.scaling && exam.scaling.enabled) scoring.push(`Your result is also reported as a scaled score from ${exam.scaling.min} to ${exam.scaling.max}, like the real certification exam.`);
  if (exam.bands && exam.bands.length) scoring.push(`Your score places you in a proficiency band: ${listJoin(exam.bands.map((b) => `${b.name} (${fmtNum(b.min)}–${fmtNum(b.max)}%)`))}. Each band comes with a recommended next step.`);
  if (exam.negativeMarking > 0) scoring.push(`Wrong answers lose ${fmtNum(exam.negativeMarking)} mark${exam.negativeMarking === 1 ? '' : 's'}. Unanswered questions score zero and never lose marks — if you are unsure, you may prefer to leave a question blank. Your total can never go below zero.`);
  else scoring.push('There is no penalty for wrong answers, so answer every question.');
  if (exam.partialCredit) scoring.push('Multiple-response, matching and ordering questions earn partial credit for partly correct answers.');
  else if ((exam.questionTypes || []).some((t) => ['multiple_response', 'matching', 'ordering'].includes(t))) scoring.push('Multiple-response, matching and ordering questions only score when the whole answer is correct.');
  add('scoring', 'Scoring', scoring);

  // ---- Attempts
  const attempts = [];
  if (exam.maxAttempts) {
    const allowed = exam.maxAttempts + (ctx.extraAttempts || 0);
    if (user && ctx.attemptsUsed !== undefined) {
      const left = Math.max(0, allowed - ctx.attemptsUsed);
      attempts.push(`You may take this exam ${plural(allowed, 'time')}${ctx.extraAttempts ? ` (including ${plural(ctx.extraAttempts, 'extra attempt')} granted to you)` : ''}. You have used ${ctx.attemptsUsed} and have ${left} left${left === 1 ? ' — this is your last attempt' : ''}.`);
    } else attempts.push(`You may take this exam ${plural(allowed, 'time')}.`);
  } else attempts.push('You may take this exam as many times as you like.');
  if (exam.cooldownMinutes) {
    attempts.push(`You must wait ${minutesText(exam.cooldownMinutes)} between attempts.`);
    if (ctx.cooldownEndsAt && ctx.now && new Date(ctx.cooldownEndsAt) > new Date(ctx.now)) attempts.push(`Your next attempt is available from ${fmtDT(ctx.cooldownEndsAt)}.`);
  }
  if ((!exam.maxAttempts || exam.maxAttempts > 1) && exam.scorePolicy) attempts.push({ best: 'Your best score counts.', latest: 'Your most recent score counts.', average: 'The average of your attempts counts.', first: 'Only your first attempt counts; later attempts are for practice.' }[exam.scorePolicy]);
  add('attempts', 'Attempts', attempts);

  // ---- Navigation & tools
  const nav = [];
  nav.push(exam.navigation === 'linear' ? 'Questions are shown one after another and you cannot go back to a previous question, so check each answer before moving on.' : 'You can move freely between questions and change your answers until you submit.');
  if (exam.navigation !== 'linear' && exam.allowFlag) nav.push('Flag any question to review it later; a review screen lists unanswered and flagged questions before you submit.');
  if (exam.showPalette && exam.navigation !== 'linear') nav.push('The question palette shows which questions are answered, unanswered or flagged.');
  if (exam.layout === 'all') nav.push('All questions are shown on one page.');
  if (exam.practiceCheck) nav.push('Use “Check answer” to see whether you are right and read the explanation straight away.');
  const tools = [];
  if (exam.calculator === 'basic') tools.push('a basic calculator');
  if (exam.calculator === 'scientific') tools.push('a scientific calculator');
  if (exam.notepad) tools.push('a notepad for rough work');
  if (tools.length) nav.push(`Built-in tools: ${listJoin(tools)}. Do not use other tools unless your invigilator allows them.`);
  else nav.push('No calculator or notepad is provided in this exam.');
  if (!exam.showTimer && exam.durationMinutes) nav.push('The countdown timer is hidden, but the time limit still applies.');
  nav.push('Keyboard: A–E or 1–9 choose an option, N / P move to the next / previous question, F flags a question.');
  add('navigation', 'Moving through the exam', nav);

  // ---- Integrity
  const integrity = [];
  const ig = exam.integrity || {};
  if (ig.fullscreen) integrity.push('The exam runs in full-screen mode. Leaving full screen is recorded and you will be asked to return.');
  if (ig.tabSwitchLimit) integrity.push(`Switching to another tab or window is recorded.${ig.autoSubmitOnLimit ? ` After ${plural(ig.tabSwitchLimit, 'switch', 'switches')}, your exam will be submitted automatically.` : ` You will be warned each time; more than ${plural(ig.tabSwitchLimit, 'switch', 'switches')} may lead to your attempt being reviewed.`}`);
  else if (ig.recordTabSwitches) integrity.push('Switching to another tab or window is recorded.');
  if (ig.disableCopy) integrity.push('Copying, pasting, right-clicking and selecting text are disabled during the exam.');
  if (ig.singleSession) integrity.push('You can only have the exam open in one browser tab on one device at a time.');
  if (ig.webcam) integrity.push('With your consent, your webcam takes occasional snapshots during the exam. Snapshots are stored privately and only examiners can see them.');
  if (ig.ipRestricted) integrity.push('This exam can only be taken from approved locations or networks.');
  if (ig.watermark) integrity.push('Your name and email are shown faintly on the exam screen.');
  add('integrity', 'Exam rules', integrity);

  // ---- Results
  const results = [];
  results.push(exam.resultRelease === 'after_window' ? `${RELEASE.after_window}${exam.availableUntil ? ` on ${fmtDT(exam.availableUntil)}` : ''}.` : RELEASE[exam.resultRelease] || RELEASE.full_review);
  if (exam.certificateEnabled) results.push('If you pass, you receive a certificate with a unique ID and QR code that anyone can verify online.');
  add('results', 'Your result', results);

  // ---- Accommodations
  if (user && user.accommodations) {
    const a = user.accommodations;
    add('accommodations', 'Your accommodations', [
      extraPct ? `You have been granted ${extraPct}% extra time. It is already included in every time limit above.` : null,
      a.large_font ? 'Larger text is switched on for you.' : null,
      a.high_contrast ? 'High-contrast display is switched on for you.' : null,
    ]);
  }

  // ---- Technical tips
  add('technical', 'Before you start', [
    'Use an up-to-date browser (Chrome, Edge, Firefox or Safari) and a stable internet connection.',
    'Every answer is saved automatically as soon as you choose it. If your connection drops, answers are kept on your device and sent when you are back online.',
    exam.durationMinutes ? 'If your browser closes, sign in again and open the exam to resume where you left off — the timer will have kept running.' : 'If your browser closes, sign in again and open the exam to resume where you left off.',
    ig.webcam ? 'Allow camera access when your browser asks.' : null,
  ]);

  return {
    title: exam.title,
    intro: user ? `Hello ${String(user.full_name || '').split(' ')[0] || 'there'}, please read these instructions carefully before you start.` : 'Please read these instructions carefully before you start.',
    customBefore: exam.customBefore || '',
    customAfter: exam.customAfter || '',
    sections,
  };
}

/** Plain-text rendering (emails, PDFs, tests). */
function renderText(doc) {
  const lines = [doc.title, '', doc.intro];
  if (doc.customBefore) lines.push('', doc.customBefore);
  for (const s of doc.sections) {
    lines.push('', s.heading.toUpperCase());
    for (const i of s.items) lines.push(`• ${i}`);
  }
  if (doc.customAfter) lines.push('', doc.customAfter);
  return lines.join('\n');
}

module.exports = { generateInstructions, renderText, TYPE_NAMES };
