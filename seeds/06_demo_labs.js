'use strict';

/**
 * Demo cyber security terminal labs: a "Cyber Security" category, two lab questions and a free practice exam that
 * uses them. Idempotent (category by slug, questions by content hash, exam by slug).
 */
const repo = require('../src/services/questions/repository');
const types = require('../src/services/questions/types');
const exams = require('../src/services/exams/repository');
const labs = require('./data/labQuestions');

exports.seed = async function seed(knex) {
  const admin = await knex('users as u').join('user_roles as ur', 'ur.user_id', 'u.id').join('roles as r', 'r.id', 'ur.role_id').where('r.slug', 'super_admin').whereNull('u.deleted_at').orderBy('u.id').first('u.id');
  if (!admin) return;
  const user = { id: admin.id, can: () => true };

  let cat = await knex('categories').where({ slug: 'cyber-security' }).first('id');
  if (!cat) {
    const order = Number((await knex('categories').whereNull('parent_id').max({ m: 'display_order' }).first()).m || 0) + 1;
    const [id] = await knex('categories').insert({ slug: 'cyber-security', name: 'Cyber Security', icon: 'shield', parent_id: null, display_order: order, is_active: true, description: 'Hands-on security skills tested in simulated Linux terminals.' });
    cat = { id };
  }

  const ids = [];
  for (const item of labs) {
    const hash = types.contentHash(types.normalise(item.q));
    const existing = await repo.findByHash(hash, knex);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const meta = { category_id: cat.id, certification_id: null, domain_id: null, topic: item.topic, difficulty: item.difficulty, bloom_level: 'apply', est_time_sec: 900, parent_id: null };
    const saved = await repo.saveQuestion({ meta, authoring: item.q, tags: item.tags, user, status: 'published', changeNote: 'Sample content' }, knex);
    ids.push(saved.id);
  }

  if (!(await knex('exams').where({ slug: 'linux-incident-response-lab' }).first('id'))) {
    const id = await exams.createExam({ title: 'Linux Incident Response Lab', type: 'practice', category_id: cat.id, user }, knex);
    await knex('exams').where({ id }).update({ slug: 'linux-incident-response-lab', short_description: 'Two hands-on terminal labs: contain a breached web server and fix dangerous file permissions. Checked automatically.', difficulty_label: 'Intermediate', duration_minutes: 40, pass_mark: 70, partial_credit: true });
    await exams.addQuestions(id, [ids[1], ids[0]], null, knex);
    await exams.publish(id, user, 'Initial version', knex);
  }
};
