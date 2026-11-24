'use strict';

const { generateInstructions, renderText } = require('../../src/services/instructions');
const { buildSummary } = require('../../src/services/exams/summary');
const { prePublishChecklist, canPublish } = require('../../src/services/exams/checklist');
const { withDefaults, DEFAULT_BANDS } = require('../../src/services/exams/settings');

function full(examPatch = {}, settingsPatch = {}, extra = {}) {
  const settings = withDefaults({});
  for (const [g, v] of Object.entries(settingsPatch)) Object.assign(settings[g], v);
  return {
    exam: {
      title: 'Oracle 1Z0-082 Mock',
      type: 'mock',
      content_mode: 'fixed',
      duration_minutes: 90,
      grace_seconds: 0,
      per_question_seconds: null,
      pass_mark: 70,
      pass_mark_type: 'percent',
      negative_marking: 0,
      partial_credit: 0,
      max_attempts: 3,
      cooldown_minutes: 0,
      score_policy: 'best',
      result_release: 'full_review',
      certificate_enabled: 1,
      category_id: 1,
      short_description: 'x',
      visibility: 'public',
      ...examPatch,
    },
    settings,
    sections: [],
    items: [
      { question_id: 1, section_id: null, type: 'single_choice', marks: 1, status: 'published' },
      { question_id: 2, section_id: null, type: 'multiple_response', marks: 2, status: 'published' },
      { question_id: 3, section_id: null, type: 'sql', marks: 2, status: 'published' },
    ],
    rules: [],
    bands: [],
    access: [],
    ...extra,
  };
}

const text = (f, user, ctx) => renderText(generateInstructions(buildSummary(f), user, ctx));

describe('instruction generator', () => {
  test('reflects the actual configuration', () => {
    const t = text(full());
    expect(t).toMatch(/You will answer 3 questions\./);
    expect(t).toMatch(/1 hour 30 minutes in total/);
    expect(t).toMatch(/pass mark is 70%/);
    expect(t).toMatch(/no penalty for wrong answers/);
    expect(t).toMatch(/You may take this exam 3 times/);
    expect(t).toMatch(/Your best score counts/);
    expect(t).toMatch(/SQL lab questions give you a sample database/);
    expect(t).toMatch(/certificate with a unique ID/);
    expect(t).toMatch(/submitted automatically/);
  });

  test('negative marking explains that blanks never lose marks', () => {
    expect(text(full({ negative_marking: 0.25 }))).toMatch(/Wrong answers lose 0\.25 marks\. Unanswered questions score zero/);
  });

  test('partial credit, linear navigation, calculator and integrity rules', () => {
    const t = text(full({ partial_credit: 1 }, { delivery: { navigation: 'linear', calculator: 'scientific', notepad: true }, integrity: { fullscreen: true, tab_switch_limit: 3, auto_submit_on_limit: true, webcam: true, disable_copy: true } }));
    expect(t).toMatch(/earn partial credit/);
    expect(t).toMatch(/cannot go back/);
    expect(t).not.toMatch(/Flag any question/);
    expect(t).toMatch(/a scientific calculator and a notepad/);
    expect(t).toMatch(/full-screen mode/);
    expect(t).toMatch(/After 3 switches, your exam will be submitted automatically/);
    expect(t).toMatch(/webcam/);
    expect(t).toMatch(/Copying, pasting/);
  });

  test('accommodations scale every time limit and are stated', () => {
    const f = full({}, {}, { sections: [{ id: 7, title: 'SQL', time_limit_minutes: 40 }] });
    f.items.forEach((it) => (it.section_id = 7));
    const t = text(f, { full_name: 'Ada Obi', accommodations: { extra_time_percent: 25 } });
    expect(t).toMatch(/Hello Ada/);
    expect(t).toMatch(/1 hour 53 minutes in total \(this includes your 25% extra time\)/);
    expect(t).toMatch(/You have been granted 25% extra time/);
  });

  test('remaining attempts and cooldown for a signed-in candidate', () => {
    const t = text(full({ cooldown_minutes: 1440 }), { full_name: 'Ada' }, { attemptsUsed: 2, extraAttempts: 1, cooldownEndsAt: '2026-11-25T10:00:00Z', now: '2026-11-24T10:00:00Z' });
    expect(t).toMatch(/You may take this exam 4 times \(including 1 extra attempt granted to you\)\. You have used 2 and have 2 left/);
    expect(t).toMatch(/wait 1 day|wait 24 hours/);
    expect(t).toMatch(/Your next attempt is available from 2026-11-25 10:00 UTC/);
  });

  test('pre-training: purpose and bands, no pass mark', () => {
    const f = full({ type: 'pre_training', pass_mark: null, certificate_enabled: 0, max_attempts: 1 }, {}, { bands: DEFAULT_BANDS });
    const t = text(f);
    expect(t).toMatch(/pre-training diagnostic/);
    expect(t).toMatch(/Beginner \(0–39\.99%\)/);
    expect(t).not.toMatch(/pass mark/);
    expect(t).toMatch(/You may take this exam 1 time\./);
    expect(t).not.toMatch(/score counts/);
  });

  test('untimed practice with check-answer', () => {
    const t = text(full({ type: 'practice', duration_minutes: null, max_attempts: null }, { delivery: { practice_check_answer: true } }));
    expect(t).toMatch(/no overall time limit/);
    expect(t).toMatch(/Check answer/);
    expect(t).toMatch(/as many times as you like/);
  });

  test('blueprint exams say questions are drawn at random', () => {
    const f = full({ content_mode: 'blueprint' }, {}, { items: [], rules: [{ question_count: 40, question_types: ['single_choice'], marks: null }, { question_count: 10, question_types: [], pool_types: ['sql'] }] });
    const t = text(f);
    expect(t).toMatch(/50 questions, drawn at random/);
    expect(t).toMatch(/single-choice and SQL lab/);
  });

  test('result release after the window names the date', () => {
    expect(text(full({ result_release: 'after_window', available_until: '2026-12-01T17:00:00Z' }))).toMatch(/released after the exam window closes on 2026-12-01 17:00 UTC/);
  });

  test('custom notes appear before and after', () => {
    const doc = generateInstructions(buildSummary(full({}, { instructions: { custom_before: 'Bring ID.', custom_after: 'Good luck!' } })));
    expect(doc.customBefore).toBe('Bring ID.');
    expect(renderText(doc).trim().endsWith('Good luck!')).toBe(true);
  });
});

describe('pre-publish checklist', () => {
  const errors = (f) => prePublishChecklist(f).filter((c) => !c.ok && c.level === 'error').map((c) => c.key);

  test('a complete exam can be published', () => {
    expect(canPublish(prePublishChecklist(full()))).toBe(true);
  });

  test('catches empty content, missing duration, unpublished questions and price', () => {
    expect(errors(full({ duration_minutes: null }, {}, { items: [] }))).toEqual(expect.arrayContaining(['content', 'duration']));
    const f = full({ is_paid: 1, price_kobo: 0 });
    f.items[0].status = 'draft';
    expect(errors(f)).toEqual(expect.arrayContaining(['published_only', 'price']));
  });

  test('blueprint must be satisfiable', () => {
    expect(errors(full({ content_mode: 'blueprint' }, {}, { items: [], rules: [{ question_count: 10, available: 4 }] }))).toContain('blueprint_satisfiable');
  });

  test('bands must cover 0–100 for pre-training', () => {
    const base = { type: 'pre_training', pass_mark: null, certificate_enabled: 0 };
    expect(errors(full(base, {}, { bands: DEFAULT_BANDS }))).toEqual([]);
    expect(errors(full(base, {}, { bands: DEFAULT_BANDS.slice(0, 3) }))).toContain('bands');
    expect(errors(full(base, {}, { bands: [{ min_percent: 0, max_percent: 50 }, { min_percent: 60, max_percent: 100 }] }))).toContain('bands');
  });

  test('section timers must fit the duration', () => {
    const f = full({ duration_minutes: 60 }, {}, { sections: [{ id: 1, title: 'A', time_limit_minutes: 40 }, { id: 2, title: 'B', time_limit_minutes: 30 }] });
    f.items[0].section_id = 1;
    f.items[1].section_id = 2;
    f.items[2].section_id = 2;
    expect(errors(f)).toContain('section_timers');
  });
});
