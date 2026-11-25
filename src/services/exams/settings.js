'use strict';

/**
 * Exam settings that live in exams.settings (JSON). Everything with its own column (timing, attempts, scoring,
 * release, certificate on/off) stays in columns; this holds delivery, integrity, scaling, instruction notes and the
 * certificate's signatory details.
 */
const DEFAULTS = Object.freeze({
  delivery: {
    shuffle_questions: true,
    shuffle_options: true,
    navigation: 'free', // free | linear
    layout: 'one', // one question per page | all on one page
    show_palette: true,
    show_timer: true,
    allow_flag: true,
    calculator: 'none', // none | basic | scientific
    notepad: false,
    background_music: true, // candidates may switch on calm generated music
    practice_check_answer: false,
    deliver_count: null, // fixed lists: deliver a random N of the listed questions
  },
  timing: { time_out_action: 'auto_submit' }, // auto_submit | lock
  scaling: { enabled: false, min: 100, max: 1000 },
  integrity: {
    fullscreen: false,
    record_tab_switches: true,
    tab_switch_limit: null,
    auto_submit_on_limit: false,
    disable_copy: false,
    single_session: true,
    webcam: false,
    watermark: false,
  },
  instructions: { custom_before: '', custom_after: '' },
  certificate: { signatory_name: '', signatory_title: '', validity_months: null },
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const intOrNull = (v, min = 0, max = 1e9) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

/** Deep-merges stored settings over the defaults (unknown keys are dropped). */
function withDefaults(stored) {
  const out = clone(DEFAULTS);
  const s = stored && typeof stored === 'object' ? stored : {};
  for (const group of Object.keys(out)) {
    if (s[group] && typeof s[group] === 'object') {
      for (const k of Object.keys(out[group])) if (s[group][k] !== undefined) out[group][k] = s[group][k];
    }
  }
  return out;
}

/** Normalises one settings group posted from the builder. */
function normaliseGroup(group, input, current) {
  const i = input || {};
  const c = withDefaults(current)[group];
  switch (group) {
    case 'delivery':
      return {
        shuffle_questions: bool(i.shuffle_questions),
        shuffle_options: bool(i.shuffle_options),
        navigation: pick(i.navigation, ['free', 'linear'], c.navigation),
        layout: pick(i.layout, ['one', 'all'], c.layout),
        show_palette: bool(i.show_palette),
        show_timer: bool(i.show_timer),
        allow_flag: bool(i.allow_flag),
        calculator: pick(i.calculator, ['none', 'basic', 'scientific'], c.calculator),
        notepad: bool(i.notepad),
        background_music: bool(i.background_music),
        practice_check_answer: bool(i.practice_check_answer),
        deliver_count: intOrNull(i.deliver_count, 1, 1000),
      };
    case 'timing':
      return { time_out_action: pick(i.time_out_action, ['auto_submit', 'lock'], c.time_out_action) };
    case 'scaling': {
      const min = intOrNull(i.min, 0, 100000);
      const max = intOrNull(i.max, 1, 100000);
      return { enabled: bool(i.enabled), min: min === null ? c.min : min, max: max === null ? c.max : max };
    }
    case 'integrity':
      return {
        fullscreen: bool(i.fullscreen),
        record_tab_switches: bool(i.record_tab_switches),
        tab_switch_limit: intOrNull(i.tab_switch_limit, 1, 100),
        auto_submit_on_limit: bool(i.auto_submit_on_limit),
        disable_copy: bool(i.disable_copy),
        single_session: bool(i.single_session),
        webcam: bool(i.webcam),
        watermark: bool(i.watermark),
      };
    case 'instructions':
      return { custom_before: String(i.custom_before || '').slice(0, 5000), custom_after: String(i.custom_after || '').slice(0, 5000) };
    case 'certificate':
      return { signatory_name: String(i.signatory_name || '').slice(0, 120), signatory_title: String(i.signatory_title || '').slice(0, 120), validity_months: intOrNull(i.validity_months, 1, 240) };
    default:
      return c;
  }
}

/** Sensible defaults per exam type when an exam is created. */
function typeDefaults(type) {
  const s = clone(DEFAULTS);
  const cols = { pass_mark: 70, result_release: 'full_review', max_attempts: null, certificate_enabled: false, duration_minutes: null };
  switch (type) {
    case 'pre_training':
      Object.assign(cols, { pass_mark: null, result_release: 'score_breakdown', max_attempts: 1, duration_minutes: 45 });
      break;
    case 'post_training':
      Object.assign(cols, { pass_mark: 70, result_release: 'score_breakdown', max_attempts: 2, duration_minutes: 45, certificate_enabled: true });
      break;
    case 'practice':
      s.delivery.practice_check_answer = true;
      break;
    case 'mock':
      Object.assign(cols, { pass_mark: 70, duration_minutes: 90, max_attempts: 3, certificate_enabled: true });
      s.delivery.calculator = 'basic';
      s.integrity.fullscreen = true;
      s.integrity.tab_switch_limit = 5;
      break;
    case 'assignment':
      Object.assign(cols, { pass_mark: 50, result_release: 'manual' });
      break;
    default:
      break;
  }
  return { settings: s, columns: cols };
}

const DEFAULT_BANDS = [
  { name: 'Beginner', min_percent: 0, max_percent: 39.99, message: 'Start with the foundation course.' },
  { name: 'Intermediate', min_percent: 40, max_percent: 64.99, message: 'You know the basics — the core course will close the gaps.' },
  { name: 'Advanced', min_percent: 65, max_percent: 84.99, message: 'Strong result. Focus on the advanced modules and practice exams.' },
  { name: 'Expert', min_percent: 85, max_percent: 100, message: 'Excellent. You are ready for the certification mock exam.' },
];

module.exports = { DEFAULTS, withDefaults, normaliseGroup, typeDefaults, DEFAULT_BANDS };
