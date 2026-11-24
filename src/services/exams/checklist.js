'use strict';

/**
 * Pre-publish checklist. Returns [{ key, ok, level: 'error'|'warning', message }]. An exam can be published only
 * when no item with level 'error' fails.
 */
const { sectionCounts } = require('./summary');

const TIMED_TYPES = ['mock', 'pre_training', 'post_training'];

function prePublishChecklist(full) {
  const e = full.exam;
  const out = [];
  const add = (key, ok, message, level = 'error') => out.push({ key, ok: !!ok, level, message });
  const blueprint = e.content_mode === 'blueprint';

  // Content
  if (blueprint) {
    add('content', full.rules.length > 0, full.rules.length ? `Blueprint has ${full.rules.length} rule${full.rules.length === 1 ? '' : 's'}.` : 'Add at least one blueprint rule.');
    const short = full.rules.filter((r) => (r.available || 0) < r.question_count);
    add('blueprint_satisfiable', full.rules.length && !short.length, short.length ? `${short.length} rule${short.length === 1 ? ' asks' : 's ask'} for more questions than the bank has (${short.map((r) => `${r.available}/${r.question_count}`).join(', ')}).` : 'Every blueprint rule can be filled from published questions.');
  } else {
    add('content', full.items.length > 0, full.items.length ? `${full.items.length} question${full.items.length === 1 ? '' : 's'} selected.` : 'Add questions to the exam.');
    const unpublished = full.items.filter((it) => it.status !== 'published');
    add('published_only', !unpublished.length, unpublished.length ? `${unpublished.length} selected question${unpublished.length === 1 ? ' is' : 's are'} not published (${unpublished.slice(0, 5).map((it) => `#${it.question_id}`).join(', ')}). Publish or remove ${unpublished.length === 1 ? 'it' : 'them'}.` : 'All selected questions are published.');
    const dc = full.settings.delivery.deliver_count;
    if (dc) add('deliver_count', dc <= full.items.length, dc <= full.items.length ? `Each candidate gets ${dc} of ${full.items.length} questions at random.` : `“Deliver ${dc} questions” is more than the ${full.items.length} selected.`);
  }

  // Sections
  if (full.sections.length) {
    const counts = sectionCounts(full);
    const empty = full.sections.filter((s) => !counts.get(s.id));
    add('sections', !empty.length, empty.length ? `Section${empty.length === 1 ? '' : 's'} ${empty.map((s) => `“${s.title}”`).join(', ')} ${empty.length === 1 ? 'has' : 'have'} no questions.` : 'Every section has questions.');
    const sum = full.sections.reduce((n, s) => n + (Number(s.time_limit_minutes) || 0), 0);
    if (sum && e.duration_minutes) add('section_timers', sum <= e.duration_minutes, sum <= e.duration_minutes ? 'Section time limits fit within the exam duration.' : `Section time limits add up to ${sum} minutes, more than the ${e.duration_minutes}-minute exam.`);
  }

  // Scoring
  if (e.type === 'pre_training') {
    const bands = [...(full.bands || [])].sort((a, b) => a.min_percent - b.min_percent);
    let ok = bands.length > 0 && Number(bands[0].min_percent) === 0 && Number(bands[bands.length - 1].max_percent) === 100;
    for (let i = 1; ok && i < bands.length; i += 1) {
      const gap = Number(bands[i].min_percent) - Number(bands[i - 1].max_percent);
      if (gap > 0.01 + 1e-9 || gap <= 0) ok = false;
    }
    add('bands', ok, ok ? `${bands.length} proficiency bands cover 0–100%.` : 'Proficiency bands must cover 0–100% without gaps or overlaps (e.g. 0–39.99, 40–64.99, 65–100).');
  } else {
    add('pass_mark', e.pass_mark !== null && e.pass_mark !== undefined, e.pass_mark !== null && e.pass_mark !== undefined ? `Pass mark: ${Number(e.pass_mark)}${e.pass_mark_type === 'raw' ? ' marks' : '%'}.` : 'Set a pass mark.', ['practice', 'past_questions', 'live_quiz'].includes(e.type) ? 'warning' : 'error');
  }
  if (e.pass_mark_type === 'percent' && e.pass_mark !== null && (Number(e.pass_mark) < 0 || Number(e.pass_mark) > 100)) add('pass_mark_range', false, 'A percentage pass mark must be between 0 and 100.');
  if (full.settings.scaling.enabled) add('scaling', full.settings.scaling.max > full.settings.scaling.min, full.settings.scaling.max > full.settings.scaling.min ? `Scaled score ${full.settings.scaling.min}–${full.settings.scaling.max}.` : 'Scaled score maximum must be greater than the minimum.');

  // Timing
  if (TIMED_TYPES.includes(e.type)) add('duration', !!e.duration_minutes, e.duration_minutes ? `Duration: ${e.duration_minutes} minutes.` : 'Set a duration — this exam type is timed.');
  if (e.available_from && e.available_until) add('window', new Date(e.available_from) < new Date(e.available_until), new Date(e.available_from) < new Date(e.available_until) ? 'The availability window is valid.' : 'The window closes before it opens.');

  // Access & commerce
  if (e.is_paid) add('price', Number(e.price_kobo) > 0, Number(e.price_kobo) > 0 ? 'Price is set.' : 'A paid exam needs a price.');
  if (e.visibility === 'invite_code') add('invite_code', !!e.invite_code, e.invite_code ? 'Invite code is set.' : 'Set an invite code, or change the visibility.');
  if (e.visibility === 'org_private') add('organisation', !!e.organisation_id || (full.access || []).some((a) => a.rule_type === 'organisation'), 'Organisation-private exams need an organisation.');

  // Catalogue
  add('category', !!e.category_id, e.category_id ? 'Category is set.' : 'Choose a category so candidates can find the exam.', 'warning');
  add('description', !!e.short_description, e.short_description ? 'Short description is set.' : 'Add a short description for the catalogue.', 'warning');
  if (e.certificate_enabled) add('certificate_pass_mark', e.pass_mark !== null && e.pass_mark !== undefined, 'Certificates are issued on passing, so a pass mark is required.');
  return out;
}

const canPublish = (list) => list.every((c) => c.ok || c.level !== 'error');

module.exports = { prePublishChecklist, canPublish };
