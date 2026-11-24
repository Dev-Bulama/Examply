'use strict';

/**
 * Who may start an exam, and why not. Everything is enforced on the server; the UI only displays the reasons.
 *
 * checkEligibility(user, exam, { ip, invited, now }) → {
 *   ok, reasons: [{ code, message }], inProgress, attemptsUsed, attemptsAllowed, extraAttempts, cooldownEndsAt,
 *   needsPurchase, snapshotVersion
 * }
 */
const net = require('net');
const { db } = require('../../config/db');
const { formatDateTime } = require('../../utils/time');

/** Counted attempts: everything except personal study sets ("retake weak areas"). */
const COUNTED_MODES = ['exam', 'practice', 'mock', 'homework'];

function ipToInt(ip) {
  const v4 = String(ip || '').replace(/^::ffff:/, '');
  if (!net.isIPv4(v4)) return null;
  return v4.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

/** "102.89.0.0/16" or "41.58.1.7" contains ip? IPv4 only; an IPv6 client never matches an IPv4 rule. */
function ipInRange(ip, rule) {
  const [base, bitsRaw] = String(rule).split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  const block = 2 ** (32 - bits);
  return Math.floor(a / block) === Math.floor(b / block);
}

/** True when the user holds a live entitlement to the exam (directly, through a bundle, or through their organisation). */
async function hasExamEntitlement(userId, examId, knex = db(), now = new Date()) {
  const products = await knex('products').where({ exam_id: examId, type: 'exam' }).whereNull('deleted_at').pluck('id');
  if (!products.length) return false;
  const bundles = await knex('product_items').whereIn('product_id', products).pluck('bundle_product_id');
  const ids = [...products, ...bundles];
  const orgs = await knex('organisation_users').where({ user_id: userId }).pluck('organisation_id');
  const row = await knex('entitlements')
    .whereIn('product_id', ids)
    .where((w) => {
      w.where('user_id', userId);
      if (orgs.length) w.orWhereIn('organisation_id', orgs);
    })
    .whereNull('revoked_at')
    .where('starts_at', '<=', now)
    .where((w) => w.whereNull('expires_at').orWhere('expires_at', '>', now))
    .first('id');
  return !!row;
}

async function checkEligibility(user, exam, { ip = null, invited = false, now = new Date() } = {}, knex = db()) {
  const reasons = [];
  const add = (code, message) => reasons.push({ code, message });
  const fmt = (d) => formatDateTime(d, { timezone: user.timezone || 'Africa/Lagos' });

  const snapshot = await knex('exam_versions').where({ exam_id: exam.id }).orderBy('version_no', 'desc').first('version_no');
  if (exam.status !== 'published' || exam.deleted_at || !snapshot) add('unavailable', 'This exam is not available.');

  const inProgress = await knex('attempts').where({ exam_id: exam.id, user_id: user.id, status: 'in_progress' }).whereIn('mode', COUNTED_MODES).orderBy('id', 'desc').first();

  if (exam.available_from && new Date(exam.available_from) > now) add('not_open', `This exam opens on ${fmt(exam.available_from)}.`);
  if (exam.available_until && new Date(exam.available_until) <= now) add('closed', `This exam closed on ${fmt(exam.available_until)}.`);

  const orgIds = await knex('organisation_users').where({ user_id: user.id }).pluck('organisation_id');
  if (exam.visibility === 'invite_code' && !invited) add('invite', 'Enter the invite code you were given to take this exam.');
  if (exam.visibility === 'org_private' && !(exam.organisation_id && orgIds.includes(exam.organisation_id))) add('org_private', 'This exam is only available to members of its organisation.');
  if (exam.require_org && !orgIds.length) add('require_org', 'This exam is only available to members of an organisation.');
  if (exam.require_verified_email && !user.email_verified_at) add('verify_email', 'Verify your email address before taking this exam.');

  const rules = await knex('exam_access_rules').where({ exam_id: exam.id });
  const ipRules = rules.filter((r) => r.rule_type === 'ip_allow');
  if (ipRules.length && !ipRules.some((r) => ipInRange(ip, r.value))) add('ip', 'This exam can only be taken from an approved location or network.');
  const orgRules = rules.filter((r) => r.rule_type === 'organisation').map((r) => Number(r.value));
  if (orgRules.length && !orgRules.some((id) => orgIds.includes(id))) add('org_rule', 'This exam is limited to specific organisations.');

  if (exam.prerequisite_exam_id) {
    const passed = await knex('results').where({ user_id: user.id, exam_id: exam.prerequisite_exam_id, passed: true }).first('id');
    if (!passed) {
      const pre = await knex('exams').where({ id: exam.prerequisite_exam_id }).first('title');
      add('prerequisite', `Pass “${pre ? pre.title : 'the prerequisite exam'}” first.`);
    }
  }

  let needsPurchase = false;
  if (exam.is_paid && !(await hasExamEntitlement(user.id, exam.id, knex, now))) {
    needsPurchase = true;
    add('purchase', 'Buy this exam to take it.');
  }

  // Attempts and cooldown (server-side, including per-user overrides)
  const counted = await knex('attempts').where({ exam_id: exam.id, user_id: user.id }).whereIn('mode', COUNTED_MODES);
  const attemptsUsed = counted.length;
  const overrides = await knex('exam_attempt_overrides').where({ exam_id: exam.id, user_id: user.id }).orderBy('id');
  const extraAttempts = overrides.reduce((n, o) => n + Number(o.extra_attempts), 0);
  const attemptsAllowed = exam.max_attempts ? Number(exam.max_attempts) + extraAttempts : null;
  if (!inProgress && attemptsAllowed !== null && attemptsUsed >= attemptsAllowed) add('attempts', `You have used all ${attemptsAllowed} attempt${attemptsAllowed === 1 ? '' : 's'}.`);

  let cooldownEndsAt = null;
  const last = counted.filter((a) => a.submitted_at).sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))[0];
  if (!inProgress && last && exam.cooldown_minutes) {
    const ends = new Date(new Date(last.submitted_at).getTime() + exam.cooldown_minutes * 60000);
    const resetAfter = overrides.some((o) => o.reset_cooldown && new Date(o.created_at) >= new Date(last.submitted_at));
    if (ends > now && !resetAfter) {
      cooldownEndsAt = ends;
      add('cooldown', `You can try again from ${fmt(ends)}.`);
    }
  }

  // An attempt in progress can always be resumed (until it expires), whatever else has changed.
  const ok = inProgress ? true : reasons.length === 0;
  return { ok, reasons, inProgress: inProgress || null, attemptsUsed, attemptsAllowed, extraAttempts, cooldownEndsAt, needsPurchase, snapshotVersion: snapshot ? snapshot.version_no : null };
}

module.exports = { checkEligibility, hasExamEntitlement, ipInRange, COUNTED_MODES };
