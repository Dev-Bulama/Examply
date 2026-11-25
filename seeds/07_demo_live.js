'use strict';

/** Demo live quiz: 10 original quick-fire questions and a "Cyber Quick-Fire" live quiz exam. Idempotent. */
const repo = require('../src/services/questions/repository');
const types = require('../src/services/questions/types');
const exams = require('../src/services/exams/repository');
const items = require('./data/liveQuestions');

exports.seed = async function seed(knex) {
  const admin = await knex('users as u').join('user_roles as ur', 'ur.user_id', 'u.id').join('roles as r', 'r.id', 'ur.role_id').where('r.slug', 'super_admin').whereNull('u.deleted_at').orderBy('u.id').first('u.id');
  if (!admin) return;
  const user = { id: admin.id, can: () => true };
  const cat = (await knex('categories').where({ slug: 'cyber-security' }).first('id')) || (await knex('categories').orderBy('id').first('id'));
  if (!cat) return;
  const ids = [];
  for (const item of items) {
    const hash = types.contentHash(types.normalise(item.q));
    const existing = await repo.findByHash(hash, knex);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const saved = await repo.saveQuestion({ meta: { category_id: cat.id, difficulty: item.difficulty, bloom_level: 'remember', est_time_sec: 20, topic: 'Quick-fire' }, authoring: item.q, tags: ['live', 'quick-fire'], user, status: 'published', changeNote: 'Sample content' }, knex);
    ids.push(saved.id);
  }
  let exam = await knex('exams').where({ slug: 'cyber-quick-fire-live-quiz' }).first('id');
  if (!exam) {
    const id = await exams.createExam({ title: 'Cyber Quick-Fire (Live Quiz)', type: 'live_quiz', category_id: cat.id, user }, knex);
    await knex('exams').where({ id }).update({ slug: 'cyber-quick-fire-live-quiz', short_description: 'Ten fast questions on security and IT basics — made for the projector and phones.' });
    exam = { id };
  }
  const has = Number((await knex('exam_questions').where({ exam_id: exam.id }).count('* as n').first()).n);
  if (!has) await exams.addQuestions(exam.id, ids, null, knex);
};
