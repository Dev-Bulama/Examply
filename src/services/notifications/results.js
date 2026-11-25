'use strict';

/** Result-related emails (queued; never block or fail the request that triggers them). */
const { db } = require('../../config/db');
const { getEnv } = require('../../config/env');
const { getLogger } = require('../../config/logger');
const mail = require('../mail');
const { notify } = require('../engagement');

const base = () => String(getEnv().APP_URL).replace(/\/$/, '');

async function context(attemptId) {
  return db()('attempts as a').join('users as u', 'u.id', 'a.user_id').join('exams as e', 'e.id', 'a.exam_id').leftJoin('results as r', 'r.attempt_id', 'a.id').where('a.id', attemptId).first('a.uuid', 'a.mode', 'a.user_id', 'u.email', 'u.full_name', 'e.title', 'r.percent', 'r.release_status');
}

async function safely(fn) {
  try {
    await fn();
  } catch (err) {
    getLogger().warn({ err: err.message }, 'result notification not queued');
  }
}

const certificateIssued = (attemptId, code) =>
  safely(async () => {
    const c = await context(attemptId);
    if (!c) return;
    await notify(c.user_id, { type: 'certificate', title: `Certificate issued: ${c.title}`, body: `Certificate ID ${code}`, url: '/my/certificates' });
    await mail.queue({ to: c.email, template: 'certificate_issued', vars: { name: c.full_name.split(' ')[0], exam_title: c.title, certificate_url: `${base()}/certificates/${code}.pdf`, verify_url: `${base()}/verify/${code}`, certificate_id: code } });
  });

const essayGraded = (attemptId) =>
  safely(async () => {
    const c = await context(attemptId);
    if (!c || c.release_status !== 'released') return;
    await notify(c.user_id, { type: 'result', title: `Your essay was graded: ${c.title}`, body: `Score ${Number(c.percent)}%`, url: `/results/${c.uuid}` });
    await mail.queue({ to: c.email, template: 'essay_graded', vars: { name: c.full_name.split(' ')[0], exam_title: c.title, score: `${Number(c.percent)}%`, result_url: `${base()}/results/${c.uuid}` } });
  });

const resultReleased = (attemptId) =>
  safely(async () => {
    const c = await context(attemptId);
    if (!c) return;
    await notify(c.user_id, { type: 'result', title: `Result available: ${c.title}`, body: `Score ${Number(c.percent)}%`, url: `/results/${c.uuid}` });
    await mail.queue({ to: c.email, template: 'result_available', vars: { name: c.full_name.split(' ')[0], exam_title: c.title, score: `${Number(c.percent)}%`, result_url: `${base()}/results/${c.uuid}` } });
  });

module.exports = { certificateIssued, essayGraded, resultReleased };
