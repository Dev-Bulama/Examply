'use strict';

/**
 * "Generate a complete exam": turns a certification's official format into exam settings, and asks the AI for the
 * catalogue copy. The questions themselves come from the normal generator (and its preview); the exam is created when
 * the batch is confirmed.
 */
const providers = require('./providers');

const EXAM_KINDS = {
  mock: 'Certification mock exam',
  pre_training: 'Pre-training diagnostic',
  post_training: 'Post-training assessment',
  practice: 'Practice test',
};

/** Parses "100-1000" / "100–1000" style score scales. */
function parseScale(scale) {
  const m = /^\s*(\d+)\s*[-–]\s*(\d+)\s*$/.exec(String(scale || ''));
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

/**
 * Exam columns + settings patches from the certification's official format, scaled to the number of questions.
 * Returns { columns, scaling, notes } where notes explain each choice to the admin.
 */
function planFromCertification(cert, { type, count }) {
  const columns = {};
  const notes = [];
  let scaling = null;
  if (cert && cert.official_duration_minutes && cert.official_question_count) {
    const per = cert.official_duration_minutes / cert.official_question_count;
    columns.duration_minutes = Math.max(10, Math.round(per * count));
    notes.push(`Duration ${columns.duration_minutes} min — the official ${cert.official_duration_minutes} min for ${cert.official_question_count} questions, scaled to ${count}.`);
  } else if (['mock', 'pre_training', 'post_training'].includes(type)) {
    columns.duration_minutes = Math.max(10, Math.round(count * 1.5));
    notes.push(`Duration ${columns.duration_minutes} min — about 90 seconds per question.`);
  }
  if (type !== 'pre_training' && cert && cert.official_passing_score !== null && cert.official_passing_score !== undefined) {
    const scale = parseScale(cert.official_score_scale);
    if (scale && scale.max > scale.min) {
      columns.pass_mark = Math.round(((Number(cert.official_passing_score) - scale.min) / (scale.max - scale.min)) * 1000) / 10;
      scaling = { enabled: true, min: scale.min, max: scale.max };
      notes.push(`Pass mark ${columns.pass_mark}% — the official ${cert.official_passing_score} on a ${scale.min}–${scale.max} scale; results also show the scaled score.`);
    } else {
      columns.pass_mark = Number(cert.official_passing_score);
      notes.push(`Pass mark ${columns.pass_mark}% — the official passing score.`);
    }
  }
  if (type === 'mock' || type === 'post_training') {
    columns.certificate_enabled = true;
    notes.push('Certificates are issued to candidates who pass.');
  }
  return { columns, scaling, notes };
}

const META_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    short_description: { type: 'string' },
    description: { type: 'string' },
    instructions_note: { type: 'string' },
  },
  required: ['title', 'short_description', 'description', 'instructions_note'],
  additionalProperties: false,
};

/** Asks the AI for catalogue copy. Never throws: falls back to the admin's own title. */
async function generateMeta(provider, model, { brief, cert, type, count, title }) {
  const prompt = [
    `Write catalogue copy for an online ${EXAM_KINDS[type] || 'exam'} of ${count} original questions.`,
    cert ? `Certification: ${cert.name}${cert.exam_code ? ` (${cert.exam_code})` : ''}.` : '',
    title ? `The author's working title: ${title}` : '',
    `Author's brief: ${brief}`,
    'title: at most 90 characters. short_description: one or two sentences (max 280 characters). description: 2–3 short paragraphs of plain text on what it covers and who it is for. instructions_note: one or two sentences of exam-specific advice for candidates (no timing or scoring rules — those are generated separately).',
    'Do not claim affiliation with or endorsement by the certification body.',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const res = await providers.generateJson(provider, { system: 'You write clear, accurate, modest marketing copy for professional exam preparation. Plain text only.', prompt, schema: META_SCHEMA, model });
    const d = res.data || {};
    return {
      title: String(d.title || title || '').slice(0, 200),
      short_description: String(d.short_description || '').slice(0, 300),
      description: String(d.description || '').slice(0, 5000),
      instructions_note: String(d.instructions_note || '').slice(0, 1000),
      usage: res.usage,
    };
  } catch {
    return { title: title || '', short_description: '', description: '', instructions_note: '', usage: { input: 0, output: 0 } };
  }
}

module.exports = { EXAM_KINDS, planFromCertification, parseScale, generateMeta, META_SCHEMA };
