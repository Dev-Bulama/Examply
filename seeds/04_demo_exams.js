'use strict';

/**
 * Demo SQL lab questions and three exams that show the builder: a blueprint certification mock, a pre-training
 * diagnostic with sections and bands, and a practice test. Idempotent (questions by content hash, exams by slug).
 */
const repo = require('../src/services/questions/repository');
const types = require('../src/services/questions/types');
const exams = require('../src/services/exams/repository');
const sqlQuestions = require('./data/sqlQuestions');

exports.seed = async function seed(knex) {
  const admin = await knex('users as u').join('user_roles as ur', 'ur.user_id', 'u.id').join('roles as r', 'r.id', 'ur.role_id').where('r.slug', 'super_admin').whereNull('u.deleted_at').orderBy('u.id').first('u.id');
  const user = admin ? { id: admin.id, can: () => true } : null;
  const cert = await knex('certifications').where({ exam_code: '1Z0-082' }).first('id', 'category_id');
  if (!cert) return; // the demo catalogue seed has not run
  const domains = Object.fromEntries((await knex('certification_domains').where({ certification_id: cert.id }).select('id', 'code')).map((d) => [d.code, d.id]));
  const oracleCat = await knex('categories').where({ slug: 'oracle' }).first('id');

  const sqlIds = [];
  for (const item of sqlQuestions) {
    const hash = types.contentHash(types.normalise(item.q));
    const existing = await repo.findByHash(hash, knex);
    if (existing) {
      sqlIds.push(existing.id);
      continue;
    }
    const meta = { category_id: oracleCat.id, certification_id: cert.id, domain_id: domains[item.domain], topic: item.topic, difficulty: item.difficulty, bloom_level: 'apply', est_time_sec: 240, parent_id: null };
    const saved = await repo.saveQuestion({ meta, authoring: item.q, tags: item.tags, user, status: 'published', changeNote: 'Sample content' }, knex);
    sqlIds.push(saved.id);
  }

  const exists = (slug) => knex('exams').where({ slug }).first('id');

  // 1. Certification mock — blueprint weighted by domain
  if (!(await exists('oracle-1z0-082-certification-mock'))) {
    const id = await exams.createExam({ title: 'Oracle 1Z0-082 Certification Mock', type: 'mock', category_id: oracleCat.id, certification_id: cert.id, content_mode: 'blueprint', user }, knex);
    await knex('exams').where({ id }).update({ slug: 'oracle-1z0-082-certification-mock', short_description: 'A timed mock that follows the official domain weighting, with SQL lab tasks you solve in a live database.', difficulty_label: 'Professional', duration_minutes: 60, pass_mark: 60, is_paid: true, price_kobo: 750000 });
    for (const [code, n, typesOnly] of [['ARCH', 1], ['INST', 2], ['SEC', 1], ['STOR', 1], ['SQL', 2, ['single_choice', 'multiple_response', 'true_false', 'fill_blank']], ['SQL', 3, ['sql']]]) {
      await exams.saveRule(id, null, { question_count: n, certification_id: cert.id, domain_id: domains[code], question_types: typesOnly || [] }, knex);
    }
    await exams.publish(id, user, 'Initial version', knex);
  }

  // 1b. A free mock with a certificate — fixed list across every domain, so results show the domain radar.
  if (!(await exists('oracle-1z0-082-free-practice-mock'))) {
    const id = await exams.createExam({ title: 'Oracle 1Z0-082 Free Practice Mock', type: 'mock', category_id: oracleCat.id, certification_id: cert.id, user }, knex);
    await knex('exams').where({ id }).update({ slug: 'oracle-1z0-082-free-practice-mock', short_description: 'A free 30-minute mock across all five 1Z0-082 domains, including two SQL lab tasks. Pass to earn a verifiable certificate.', difficulty_label: 'Professional', duration_minutes: 30, pass_mark: 60, partial_credit: true });
    await exams.saveTab(id, 'certificate', { certificate_enabled: '1', certificate_template: 'classic', signatory_name: 'Ada Obi', signatory_title: 'Head of Assessment' }, user, {}, knex);
    await exams.saveTab(id, 'integrity', { record_tab_switches: '1', single_session: '1' }, user, {}, knex);
    const pick = await knex('questions').where({ certification_id: cert.id, status: 'published' }).whereNull('parent_id').whereNull('deleted_at').whereNot('type', 'essay').orderBy('id').select('id', 'type', 'domain_id');
    const nonSql = pick.filter((q) => q.type !== 'sql');
    await exams.addQuestions(id, [...nonSql.map((q) => q.id), ...sqlIds.slice(0, 2)], null, knex);
    await exams.publish(id, user, 'Initial version', knex);
  }

  // 2. Pre-training diagnostic — fixed list in two sections, default bands
  if (!(await exists('sql-skills-diagnostic'))) {
    const id = await exams.createExam({ title: 'SQL Skills Diagnostic', type: 'pre_training', category_id: oracleCat.id, certification_id: cert.id, user }, knex);
    await knex('exams').where({ id }).update({ slug: 'sql-skills-diagnostic', short_description: 'Find your SQL level before the bootcamp: concepts first, then hands-on queries in the SQL lab.' });
    const a = await exams.saveSection(id, null, { title: 'Part A — Concepts', time_limit_minutes: 15 }, knex);
    const b = await exams.saveSection(id, null, { title: 'Part B — SQL lab', time_limit_minutes: 30, instructions_html: '<p>Write and run SQL against the sample HR and shop databases.</p>' }, knex);
    const concepts = await knex('questions').where({ certification_id: cert.id, domain_id: domains.SQL, status: 'published' }).whereNot('type', 'sql').whereNull('parent_id').whereNull('deleted_at').pluck('id');
    await exams.addQuestions(id, concepts, a, knex);
    await exams.addQuestions(id, sqlIds.slice(0, 4), b, knex);
    await exams.publish(id, user, 'Initial version', knex);
  }

  // 3. Practice test — left as a draft to show the checklist
  if (!(await exists('practice-sql-joins-and-aggregation'))) {
    const id = await exams.createExam({ title: 'Practice: SQL Joins & Aggregation', type: 'practice', category_id: oracleCat.id, certification_id: cert.id, user }, knex);
    await knex('exams').where({ id }).update({ slug: 'practice-sql-joins-and-aggregation' });
    await exams.addQuestions(id, sqlIds.slice(1), null, knex);
  }
};
