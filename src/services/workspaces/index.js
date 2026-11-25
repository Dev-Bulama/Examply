'use strict';

/**
 * Company workspaces. An organisation with an active company plan is a workspace:
 *  - managers and authors (staff) build questions and exams — with AI — inside the normal admin screens, which are
 *    then scoped to the workspace (see middleware/workspace.js);
 *  - members are the company's candidates; they take the workspace's private exams;
 *  - managers invite people, organise cohorts, assign exams with due dates and read reports.
 *
 * Plan limits (products.limits): candidates, staff_seats, exams (published), ai_questions_per_month, labs,
 * custom_branding. A missing/empty limit means unlimited.
 */
const crypto = require('crypto');
const { db } = require('../../config/db');
const { getEnv } = require('../../config/env');
const { getLogger } = require('../../config/logger');
const { startOfMonth } = require('../../utils/time');
const { uniqueSlug } = require('../../utils/slug');
const settings = require('../settings');
const mail = require('../mail');
const commerce = require('../commerce');

class WorkspaceError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const STAFF_ROLES = ['manager', 'author'];

/** Permissions a workspace's staff hold inside their workspace (and nowhere else). */
const AUTHOR_PERMISSIONS = ['admin.access', 'questions.view', 'questions.create', 'questions.edit_any', 'questions.publish', 'questions.review', 'questions.delete', 'questions.import', 'questions.export', 'exams.view', 'exams.manage', 'exams.publish', 'attempts.view', 'results.manage', 'results.export'];
const MANAGER_PERMISSIONS = [...AUTHOR_PERMISSIONS, 'exams.grant_attempts', 'certificates.manage', 'org.manage_own'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const base = () => String(getEnv().APP_URL).replace(/\/$/, '');

/** Workspaces where the user is staff, with their active plan (or null when the plan lapsed). */
async function staffWorkspaces(userId, knex = db()) {
  const rows = await knex('organisation_users as ou').join('organisations as o', 'o.id', 'ou.organisation_id').where('ou.user_id', userId).whereIn('ou.role', STAFF_ROLES).where('o.status', 'active').whereNull('o.deleted_at').select('o.id', 'o.name', 'o.slug', 'o.logo_path', 'o.primary_color', 'ou.role');
  for (const r of rows) r.plan = await commerce.activePlanFor(r.id, knex);
  return rows;
}

/** Builds the per-request workspace context and its permission set. */
function contextFor(ws) {
  const limits = (ws.plan && ws.plan.limits) || {};
  const perms = new Set(ws.role === 'manager' ? MANAGER_PERMISSIONS : AUTHOR_PERMISSIONS);
  if (Number(limits.ai_questions_per_month) > 0) perms.add('ai.generate');
  return { id: ws.id, name: ws.name, slug: ws.slug, role: ws.role, plan: ws.plan, limits, permissions: perms, active: !!ws.plan, primaryColor: ws.primary_color, logoPath: ws.logo_path };
}

// ---------------------------------------------------------------- Usage & limits

async function usage(orgId, knex = db()) {
  const tz = settings.getSync('general.timezone') || 'Africa/Lagos';
  const [members, staff, exams, ai, questions] = await Promise.all([
    knex('organisation_users').where({ organisation_id: orgId, role: 'member' }).count({ n: '*' }).first(),
    knex('organisation_users').where({ organisation_id: orgId }).whereIn('role', STAFF_ROLES).count({ n: '*' }).first(),
    knex('exams').where({ organisation_id: orgId, status: 'published' }).whereNull('deleted_at').count({ n: '*' }).first(),
    knex('ai_generations').where({ organisation_id: orgId }).whereNot('status', 'failed').where('created_at', '>=', startOfMonth(tz)).sum({ n: 'generated_count' }).first(),
    knex('questions').where({ organisation_id: orgId }).whereNull('deleted_at').whereNull('parent_id').count({ n: '*' }).first(),
  ]);
  const pending = await knex('organisation_invitations').where({ organisation_id: orgId }).whereNull('accepted_at').where('expires_at', '>', new Date()).select('role');
  return {
    candidates: Number(members.n),
    staff: Number(staff.n),
    publishedExams: Number(exams.n),
    aiThisMonth: Number(ai.n || 0),
    questions: Number(questions.n),
    pendingMembers: pending.filter((p) => p.role === 'member').length,
    pendingStaff: pending.filter((p) => p.role !== 'member').length,
  };
}

const unlimited = (v) => v === null || v === undefined || v === '' || Number(v) <= 0;

/** Throws when an action would exceed the plan. kind: candidates | staff | exams | ai */
async function assertWithinLimit(orgId, kind, adding = 1, knex = db()) {
  const plan = await commerce.activePlanFor(orgId, knex);
  if (!plan) throw new WorkspaceError('Your company plan is not active. Renew it to continue.', 402);
  const L = plan.limits || {};
  const u = await usage(orgId, knex);
  const check = (limit, used, label) => {
    if (!unlimited(limit) && used + adding > Number(limit)) throw new WorkspaceError(`Your ${plan.name} plan allows ${Number(limit)} ${label}; you have ${used}. Upgrade the plan to add more.`, 402);
  };
  if (kind === 'candidates') check(L.candidates, u.candidates + u.pendingMembers, 'candidates');
  if (kind === 'staff') check(L.staff_seats, u.staff + u.pendingStaff, 'staff seats');
  if (kind === 'exams') check(L.exams, u.publishedExams, 'published exams');
  if (kind === 'ai') {
    const limit = Number(L.ai_questions_per_month) || 0;
    if (u.aiThisMonth + adding > limit) throw new WorkspaceError(`Your plan includes ${limit} AI-generated questions a month; ${Math.max(0, limit - u.aiThisMonth)} remain this month.`, 402);
  }
  return { plan, usage: u };
}

// ---------------------------------------------------------------- Members & invitations

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Parses pasted emails or CSV ("email" or "name,email" per line). */
function parseInviteList(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/[\r\n;]+/)) {
    for (const cell of line.split(/[,\t]/)) {
      const e = cell.trim().toLowerCase().replace(/^<|>$/g, '');
      if (EMAIL.test(e) && !seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
  }
  return out.slice(0, 500);
}

/**
 * Invites people (existing users or not). Existing users are not added silently: everyone accepts by link.
 * Returns { invited, skipped: [{ email, reason }] }.
 */
async function invite(orgId, emails, { role = 'member', cohortId = null, invitedBy }, knex = db()) {
  if (!['manager', 'author', 'member'].includes(role)) throw new WorkspaceError('Choose a role.');
  const org = await knex('organisations').where({ id: orgId }).first();
  const skipped = [];
  const todo = [];
  for (const email of emails) {
    const existing = await knex('organisation_users as ou').join('users as u', 'u.id', 'ou.user_id').where({ 'ou.organisation_id': orgId }).where('u.email', email).first('ou.id');
    if (existing) skipped.push({ email, reason: 'already a member' });
    else todo.push(email);
  }
  if (todo.length) await assertWithinLimit(orgId, role === 'member' ? 'candidates' : 'staff', todo.length, knex);
  const inviter = await knex('users').where({ id: invitedBy }).first('full_name');
  let invited = 0;
  for (const email of todo) {
    const token = crypto.randomBytes(24).toString('hex');
    await knex('organisation_invitations').where({ organisation_id: orgId, email }).whereNull('accepted_at').del();
    await knex('organisation_invitations').insert({ organisation_id: orgId, email, token_hash: sha256(token), cohort_id: cohortId, invited_by: invitedBy, role, expires_at: new Date(Date.now() + 14 * 86400000) });
    try {
      await mail.queue({ to: email, template: 'org_invitation', vars: { name: email.split('@')[0], organisation: org.name, invite_url: `${base()}/join/${token}`, invited_by: inviter ? inviter.full_name : org.name, expires_days: 14 } });
    } catch (err) {
      getLogger().warn({ err: err.message }, 'invitation email not queued');
    }
    invited += 1;
  }
  return { invited, skipped };
}

async function invitationByToken(token, knex = db()) {
  if (!/^[0-9a-f]{48}$/.test(String(token))) return null;
  return knex('organisation_invitations as i').join('organisations as o', 'o.id', 'i.organisation_id').where('i.token_hash', sha256(token)).first('i.*', 'o.name as organisation_name');
}

/** Accepts an invitation for the signed-in user (the email must match). */
async function acceptInvitation(token, user, knex = db()) {
  const inv = await invitationByToken(token, knex);
  if (!inv) throw new WorkspaceError('This invitation link is not valid.', 404);
  if (inv.accepted_at) throw new WorkspaceError('This invitation has already been used.', 409);
  if (new Date(inv.expires_at) < new Date()) throw new WorkspaceError('This invitation has expired. Ask for a new one.', 410);
  if (inv.email.toLowerCase() !== String(user.email).toLowerCase()) throw new WorkspaceError(`This invitation was sent to ${inv.email}. Sign in with that address to accept it.`, 403);
  return knex.transaction(async (trx) => {
    await trx('organisation_users').insert({ organisation_id: inv.organisation_id, user_id: user.id, role: inv.role, invited_by: inv.invited_by, joined_at: new Date() }).onConflict(['organisation_id', 'user_id']).merge({ role: inv.role });
    if (inv.cohort_id) await trx('cohort_members').insert({ cohort_id: inv.cohort_id, user_id: user.id }).onConflict(['cohort_id', 'user_id']).ignore();
    await trx('organisation_invitations').where({ id: inv.id }).update({ accepted_at: new Date() });
    return inv;
  });
}

/** Self-service join with the organisation's join code (members only). */
async function joinWithCode(code, user, knex = db()) {
  const org = await knex('organisations').where({ join_code: String(code || '').trim().toUpperCase(), join_enabled: true, status: 'active' }).whereNull('deleted_at').first();
  if (!org) throw new WorkspaceError('That join code is not valid.', 404);
  const existing = await knex('organisation_users').where({ organisation_id: org.id, user_id: user.id }).first('id');
  if (existing) return org;
  await assertWithinLimit(org.id, 'candidates', 1, knex);
  await knex('organisation_users').insert({ organisation_id: org.id, user_id: user.id, role: 'member', joined_at: new Date() });
  return org;
}

async function setJoinCode(orgId, enabled, knex = db()) {
  const code = `${crypto.randomBytes(3).toString('hex').toUpperCase()}${crypto.randomBytes(1).toString('hex').toUpperCase()}`.slice(0, 8);
  await knex('organisations').where({ id: orgId }).update({ join_enabled: !!enabled, ...(enabled ? { join_code: code } : {}) });
}

async function removeMember(orgId, userId, actorId, knex = db()) {
  if (userId === actorId) throw new WorkspaceError('You cannot remove yourself.');
  const m = await knex('organisation_users').where({ organisation_id: orgId, user_id: userId }).first();
  if (!m) throw new WorkspaceError('Not a member.', 404);
  if (m.role === 'manager') {
    const [{ n }] = await knex('organisation_users').where({ organisation_id: orgId, role: 'manager' }).count({ n: '*' });
    if (Number(n) <= 1) throw new WorkspaceError('A workspace needs at least one manager.');
  }
  await knex('cohort_members').whereIn('cohort_id', knex('cohorts').where({ organisation_id: orgId }).select('id')).where({ user_id: userId }).del();
  await knex('organisation_users').where({ id: m.id }).del();
}

// ---------------------------------------------------------------- Cohorts & assignments

async function createCohort(orgId, { name, description, starts_on, ends_on }, knex = db()) {
  const n = String(name || '').trim().slice(0, 150);
  if (!n) throw new WorkspaceError('Give the cohort a name.');
  const [id] = await knex('cohorts').insert({ organisation_id: orgId, name: n, description: String(description || '').slice(0, 2000) || null, starts_on: starts_on || null, ends_on: ends_on || null });
  return id;
}

async function cohortOr404(orgId, cohortId, knex = db()) {
  const c = await knex('cohorts').where({ id: cohortId, organisation_id: orgId }).whereNull('deleted_at').first();
  if (!c) throw new WorkspaceError('Cohort not found.', 404);
  return c;
}

async function setCohortMembers(orgId, cohortId, userIds, knex = db()) {
  await cohortOr404(orgId, cohortId, knex);
  const valid = await knex('organisation_users').where({ organisation_id: orgId }).whereIn('user_id', userIds.map(Number)).pluck('user_id');
  await knex('cohort_members').where({ cohort_id: cohortId }).del();
  if (valid.length) await knex('cohort_members').insert(valid.map((u) => ({ cohort_id: cohortId, user_id: u })));
  return valid.length;
}

/** Assigns an exam to a cohort. Workspace exams, or platform exams the organisation is entitled to. */
async function assignExam(orgId, cohortId, { examId, kind = 'general', dueAt = null, createdBy }, knex = db()) {
  await cohortOr404(orgId, cohortId, knex);
  const exam = await knex('exams').where({ id: examId, status: 'published' }).whereNull('deleted_at').first();
  if (!exam) throw new WorkspaceError('Choose a published exam.');
  if (exam.organisation_id && exam.organisation_id !== orgId) throw new WorkspaceError('That exam belongs to another organisation.', 403);
  if (!exam.organisation_id && exam.visibility !== 'public') throw new WorkspaceError('That exam is not available to assign.', 403);
  await knex('cohort_assignments').insert({ cohort_id: cohortId, exam_id: examId, kind: ['pre', 'post', 'general'].includes(kind) ? kind : 'general', due_at: dueAt, created_by: createdBy }).onConflict(['cohort_id', 'exam_id', 'kind']).merge({ due_at: dueAt });
}

/** Progress grid: each member × each assignment → best released result. */
async function cohortProgress(orgId, cohortId, knex = db()) {
  const cohort = await cohortOr404(orgId, cohortId, knex);
  const members = await knex('cohort_members as cm').join('users as u', 'u.id', 'cm.user_id').where('cm.cohort_id', cohortId).orderBy('u.full_name').select('u.id', 'u.full_name', 'u.email');
  const assignments = await knex('cohort_assignments as ca').join('exams as e', 'e.id', 'ca.exam_id').where('ca.cohort_id', cohortId).orderBy('ca.id').select('ca.*', 'e.title', 'e.slug', 'e.pass_mark');
  const results = members.length && assignments.length
    ? await knex('results as r').join('attempts as a', 'a.id', 'r.attempt_id').whereIn('r.user_id', members.map((m) => m.id)).whereIn('r.exam_id', assignments.map((x) => x.exam_id)).whereNot('a.mode', 'study').select('r.user_id', 'r.exam_id', 'r.percent', 'r.passed', 'r.band', 'r.release_status', 'r.created_at')
    : [];
  const inProgress = members.length && assignments.length ? await knex('attempts').whereIn('user_id', members.map((m) => m.id)).whereIn('exam_id', assignments.map((x) => x.exam_id)).where('status', 'in_progress').select('user_id', 'exam_id') : [];
  const cell = (u, e) => {
    const rs = results.filter((r) => r.user_id === u && r.exam_id === e);
    if (!rs.length) return inProgress.some((p) => p.user_id === u && p.exam_id === e) ? { status: 'in_progress' } : { status: 'not_started' };
    const best = rs.reduce((a, b) => (Number(b.percent) > Number(a.percent) ? b : a));
    return { status: 'done', percent: Number(best.percent), passed: best.passed, band: best.band, attempts: rs.length };
  };
  const grid = members.map((m) => ({ ...m, cells: assignments.map((x) => cell(m.id, x.exam_id)) }));
  // Learning gain: post − pre for every member with both.
  const pre = assignments.find((x) => x.kind === 'pre');
  const post = assignments.find((x) => x.kind === 'post');
  let gain = null;
  if (pre && post) {
    const pi = assignments.indexOf(pre);
    const qi = assignments.indexOf(post);
    const pairs = grid.filter((g) => g.cells[pi].status === 'done' && g.cells[qi].status === 'done').map((g) => ({ name: g.full_name, pre: g.cells[pi].percent, post: g.cells[qi].percent, gain: Math.round((g.cells[qi].percent - g.cells[pi].percent) * 100) / 100 }));
    const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 100) / 100 : null);
    gain = { pre: pre.title, post: post.title, pairs, avgPre: avg(pairs.map((p) => p.pre)), avgPost: avg(pairs.map((p) => p.post)), avgGain: avg(pairs.map((p) => p.gain)) };
  }
  const completion = assignments.map((x, i) => ({ title: x.title, done: grid.filter((g) => g.cells[i].status === 'done').length, of: grid.length, passed: grid.filter((g) => g.cells[i].passed).length, avg: (() => { const d = grid.map((g) => g.cells[i]).filter((c) => c.status === 'done'); return d.length ? Math.round((d.reduce((s, c) => s + c.percent, 0) / d.length) * 10) / 10 : null; })() }));
  return { cohort, members, assignments, grid, gain, completion };
}

/** Exams assigned to a user through their cohorts (for the candidate dashboard). */
async function assignmentsFor(userId, knex = db()) {
  return knex('cohort_assignments as ca')
    .join('cohort_members as cm', 'cm.cohort_id', 'ca.cohort_id')
    .join('cohorts as c', 'c.id', 'ca.cohort_id')
    .join('organisations as o', 'o.id', 'c.organisation_id')
    .join('exams as e', 'e.id', 'ca.exam_id')
    .where('cm.user_id', userId)
    .whereNull('c.deleted_at')
    .where('e.status', 'published')
    .orderByRaw('ca.due_at IS NULL, ca.due_at')
    .select('ca.id', 'ca.kind', 'ca.due_at', 'e.title', 'e.slug', 'e.id as exam_id', 'o.name as organisation_name', 'c.name as cohort_name', knex.raw('(SELECT MAX(r.percent) FROM results r WHERE r.user_id = cm.user_id AND r.exam_id = e.id AND r.release_status = ?) as best', ['released']));
}

/** Scheduled: emails members whose assignment is due within 48 hours and who have not completed it (once). */
async function sendDeadlineReminders({ knex = db(), now = new Date() } = {}) {
  const due = await knex('cohort_assignments as ca').join('exams as e', 'e.id', 'ca.exam_id').whereNull('ca.reminder_sent_at').whereNotNull('ca.due_at').where('ca.due_at', '>', now).where('ca.due_at', '<=', new Date(now.getTime() + 48 * 3600000)).select('ca.*', 'e.title', 'e.slug');
  let sent = 0;
  const tz = settings.getSync('general.timezone') || 'Africa/Lagos';
  const { formatDateTime } = require('../../utils/time');
  for (const a of due) {
    const members = await knex('cohort_members as cm').join('users as u', 'u.id', 'cm.user_id').where('cm.cohort_id', a.cohort_id).whereNotExists((q) => q.select(1).from('results as r').whereRaw('r.user_id = cm.user_id').where('r.exam_id', a.exam_id)).select('u.email', 'u.full_name');
    for (const m of members) {
      await mail.queue({ to: m.email, template: 'deadline_reminder', vars: { name: m.full_name.split(' ')[0], exam_title: a.title, due_date: formatDateTime(a.due_at, { timezone: tz }), exam_url: `${base()}/exams/${a.slug}` } });
      sent += 1;
    }
    await knex('cohort_assignments').where({ id: a.id }).update({ reminder_sent_at: now });
  }
  return { sent };
}

async function updateSettings(orgId, { name, primary_color, contact_email }, knex = db()) {
  const patch = {};
  if (name !== undefined) {
    const n = String(name).trim().slice(0, 150);
    if (!n) throw new WorkspaceError('Enter the company name.');
    patch.name = n;
  }
  if (primary_color !== undefined) {
    if (primary_color && !/^#[0-9a-fA-F]{6}$/.test(primary_color)) throw new WorkspaceError('Colours look like #1f3a5f.');
    patch.primary_color = primary_color || null;
  }
  if (contact_email !== undefined) patch.contact_email = String(contact_email).trim().slice(0, 191) || null;
  if (Object.keys(patch).length) await knex('organisations').where({ id: orgId }).update(patch);
}

module.exports = { WorkspaceError, STAFF_ROLES, AUTHOR_PERMISSIONS, MANAGER_PERMISSIONS, staffWorkspaces, contextFor, usage, assertWithinLimit, parseInviteList, invite, invitationByToken, acceptInvitation, joinWithCode, setJoinCode, removeMember, createCohort, cohortOr404, setCohortMembers, assignExam, cohortProgress, assignmentsFor, sendDeadlineReminders, updateSettings, uniqueSlug };
