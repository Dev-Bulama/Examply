'use strict';

const { stringify } = require('csv-stringify/sync');
const { db } = require('../config/db');
const audit = require('../services/audit');
const ws = require('../services/workspaces');
const { notFound, forbidden } = require('../utils/errors');

const crumbs = (req, ...rest) => [{ label: req.workspace.name, href: '/org' }, ...rest];

function needWorkspace(req) {
  if (!req.workspace) throw forbidden('This page is for company workspace managers and authors.');
  return req.workspace;
}
function needManager(req) {
  const w = needWorkspace(req);
  if (w.role !== 'manager') throw forbidden('Only workspace managers can do that.');
  if (!w.active) throw forbidden('Your company plan is not active. Renew it to manage your workspace.');
  return w;
}
function fail(req, res, err, back) {
  if (!(err instanceof ws.WorkspaceError)) throw err;
  if (err.status === 404) throw notFound(err.message);
  req.flash('danger', err.message);
  return res.redirect(back);
}

// ---------------------------------------------------------------- Overview

async function overview(req, res) {
  const w = needWorkspace(req);
  const org = await db()('organisations').where({ id: w.id }).first();
  const u = await ws.usage(w.id);
  const plans = await db()('products').where({ type: 'plan', is_active: true }).whereNull('deleted_at').orderBy('price_kobo').select('id', 'name', 'slug', 'price_kobo', 'plan_interval', 'limits');
  const [exams, recent] = await Promise.all([
    db()('exams').where({ organisation_id: w.id }).whereNull('deleted_at').orderBy('updated_at', 'desc').limit(5).select('id', 'title', 'status', 'updated_at'),
    db()('attempts as a').join('exams as e', 'e.id', 'a.exam_id').join('users as u', 'u.id', 'a.user_id').where('e.organisation_id', w.id).whereNot('a.status', 'in_progress').orderBy('a.submitted_at', 'desc').limit(6).select('a.id', 'a.percent', 'a.passed', 'a.band', 'a.submitted_at', 'u.full_name', 'e.title'),
  ]);
  res.render('org/overview', { title: w.name, layout: 'layouts/app', org, w, u, plans, exams, recent, breadcrumbs: [{ label: w.name }] });
}

async function switchWorkspace(req, res) {
  const id = Number(req.body.workspace_id);
  if (req.workspace && req.workspace.all.some((x) => x.id === id)) req.session.workspaceId = id;
  res.redirect('/org');
}

// ---------------------------------------------------------------- People

async function members(req, res) {
  const w = needManager(req);
  const [rows, invites, cohorts, org, u] = await Promise.all([
    db()('organisation_users as ou').join('users as u', 'u.id', 'ou.user_id').where('ou.organisation_id', w.id).orderByRaw("FIELD(ou.role, 'manager', 'author', 'member')").orderBy('u.full_name').select('u.id', 'u.full_name', 'u.email', 'u.last_login_at', 'ou.role', 'ou.joined_at', db().raw('(SELECT COUNT(*) FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE a.user_id = u.id AND e.organisation_id = ?) as attempts', [w.id])),
    db()('organisation_invitations').where({ organisation_id: w.id }).whereNull('accepted_at').where('expires_at', '>', new Date()).orderBy('id', 'desc'),
    db()('cohorts').where({ organisation_id: w.id }).whereNull('deleted_at').orderBy('name').select('id', 'name'),
    db()('organisations').where({ id: w.id }).first(),
    ws.usage(w.id),
  ]);
  res.render('org/members', { title: 'People', layout: 'layouts/app', rows, invites, cohorts, org, u, w, breadcrumbs: crumbs(req, { label: 'People' }) });
}

async function inviteMembers(req, res) {
  const w = needManager(req);
  const emails = ws.parseInviteList(req.body.emails);
  if (!emails.length) {
    req.flash('danger', 'Paste at least one email address (one per line, or a CSV with an email column).');
    return res.redirect('/org/members');
  }
  try {
    const cohortId = Number(req.body.cohort_id) || null;
    if (cohortId) await ws.cohortOr404(w.id, cohortId);
    const out = await ws.invite(w.id, emails, { role: req.body.role, cohortId, invitedBy: req.user.id });
    await audit.record(req, 'org.invite', { entityType: 'organisation', entityId: w.id, after: { invited: out.invited, role: req.body.role } });
    req.flash('success', `${out.invited} invitation${out.invited === 1 ? '' : 's'} sent.${out.skipped.length ? ` Skipped ${out.skipped.length} (${out.skipped.slice(0, 3).map((s) => `${s.email}: ${s.reason}`).join('; ')}).` : ''}`);
  } catch (err) {
    return fail(req, res, err, '/org/members');
  }
  return res.redirect('/org/members');
}

async function cancelInvite(req, res) {
  const w = needManager(req);
  await db()('organisation_invitations').where({ id: Number(req.params.id), organisation_id: w.id }).whereNull('accepted_at').del();
  req.flash('success', 'Invitation cancelled.');
  res.redirect('/org/members');
}

async function changeRole(req, res) {
  const w = needManager(req);
  const userId = Number(req.params.userId);
  const role = ['manager', 'author', 'member'].includes(req.body.role) ? req.body.role : null;
  const m = await db()('organisation_users').where({ organisation_id: w.id, user_id: userId }).first();
  if (!m || !role) throw notFound();
  try {
    if (m.role === 'member' && role !== 'member') await ws.assertWithinLimit(w.id, 'staff', 1);
    if (m.role !== 'member' && role === 'member') await ws.assertWithinLimit(w.id, 'candidates', 1);
    if (m.role === 'manager' && role !== 'manager') {
      const [{ n }] = await db()('organisation_users').where({ organisation_id: w.id, role: 'manager' }).count({ n: '*' });
      if (Number(n) <= 1) throw new ws.WorkspaceError('A workspace needs at least one manager.');
    }
  } catch (err) {
    return fail(req, res, err, '/org/members');
  }
  await db()('organisation_users').where({ id: m.id }).update({ role });
  await audit.record(req, 'org.role', { entityType: 'organisation', entityId: w.id, before: { user: userId, role: m.role }, after: { user: userId, role } });
  req.flash('success', 'Role updated.');
  return res.redirect('/org/members');
}

async function removeMember(req, res) {
  const w = needManager(req);
  try {
    await ws.removeMember(w.id, Number(req.params.userId), req.user.id);
    await audit.record(req, 'org.remove', { entityType: 'organisation', entityId: w.id, before: { user: Number(req.params.userId) } });
    req.flash('success', 'Removed from the workspace. Their past results stay in your reports.');
  } catch (err) {
    return fail(req, res, err, '/org/members');
  }
  return res.redirect('/org/members');
}

async function joinCode(req, res) {
  const w = needManager(req);
  await ws.setJoinCode(w.id, req.body.enabled === '1');
  req.flash('success', req.body.enabled === '1' ? 'New join code created.' : 'Join code turned off.');
  res.redirect('/org/members');
}

// ---------------------------------------------------------------- Cohorts

async function cohorts(req, res) {
  const w = needManager(req);
  const rows = await db()('cohorts as c').where('c.organisation_id', w.id).whereNull('c.deleted_at').orderBy('c.id', 'desc').select('c.*', db().raw('(SELECT COUNT(*) FROM cohort_members m WHERE m.cohort_id = c.id) as members'), db().raw('(SELECT COUNT(*) FROM cohort_assignments a WHERE a.cohort_id = c.id) as assignments'));
  res.render('org/cohorts', { title: 'Cohorts', layout: 'layouts/app', rows, w, breadcrumbs: crumbs(req, { label: 'Cohorts' }) });
}

async function createCohort(req, res) {
  const w = needManager(req);
  try {
    const id = await ws.createCohort(w.id, req.body);
    await audit.record(req, 'org.cohort.create', { entityType: 'cohort', entityId: id, after: { name: req.body.name } });
    return res.redirect(`/org/cohorts/${id}`);
  } catch (err) {
    return fail(req, res, err, '/org/cohorts');
  }
}

async function cohortShow(req, res) {
  const w = needManager(req);
  let progress;
  try {
    progress = await ws.cohortProgress(w.id, Number(req.params.id));
  } catch (err) {
    return fail(req, res, err, '/org/cohorts');
  }
  const [people, exams] = await Promise.all([
    db()('organisation_users as ou').join('users as u', 'u.id', 'ou.user_id').where('ou.organisation_id', w.id).orderBy('u.full_name').select('u.id', 'u.full_name', 'u.email', 'ou.role'),
    db()('exams').where('status', 'published').whereNull('deleted_at').where((q) => q.where('organisation_id', w.id).orWhere((x) => x.whereNull('organisation_id').where('visibility', 'public'))).orderByRaw('organisation_id IS NULL').orderBy('title').select('id', 'title', 'organisation_id', 'type'),
  ]);
  res.render('org/cohort', { title: progress.cohort.name, layout: 'layouts/app', p: progress, people, exams, w, toLocal: (d) => require('../utils/time').utcToLocalInput(d, res.locals.fmt.tz), breadcrumbs: crumbs(req, { label: 'Cohorts', href: '/org/cohorts' }, { label: progress.cohort.name }) });
}

async function cohortMembers(req, res) {
  const w = needManager(req);
  try {
    const n = await ws.setCohortMembers(w.id, Number(req.params.id), [].concat(req.body.user_ids || []));
    req.flash('success', `${n} people in this cohort.`);
  } catch (err) {
    return fail(req, res, err, `/org/cohorts/${req.params.id}`);
  }
  return res.redirect(`/org/cohorts/${req.params.id}`);
}

async function cohortAssign(req, res) {
  const w = needManager(req);
  const { localInputToUtc } = require('../utils/time');
  try {
    await ws.assignExam(w.id, Number(req.params.id), { examId: Number(req.body.exam_id), kind: req.body.kind, dueAt: localInputToUtc(req.body.due_at, res.locals.fmt.tz), createdBy: req.user.id });
    await audit.record(req, 'org.assign', { entityType: 'cohort', entityId: Number(req.params.id), after: { exam: Number(req.body.exam_id), kind: req.body.kind } });
    req.flash('success', 'Exam assigned. Members see it on their dashboard, and get a reminder 48 hours before the due date.');
  } catch (err) {
    return fail(req, res, err, `/org/cohorts/${req.params.id}`);
  }
  return res.redirect(`/org/cohorts/${req.params.id}`);
}

async function unassign(req, res) {
  const w = needManager(req);
  await ws.cohortOr404(w.id, Number(req.params.id)).catch(() => {
    throw notFound();
  });
  await db()('cohort_assignments').where({ id: Number(req.params.aid), cohort_id: Number(req.params.id) }).del();
  req.flash('success', 'Assignment removed. Results already taken are kept.');
  res.redirect(`/org/cohorts/${req.params.id}`);
}

async function cohortCsv(req, res) {
  const w = needManager(req);
  const p = await ws.cohortProgress(w.id, Number(req.params.id)).catch(() => {
    throw notFound();
  });
  const header = ['Name', 'Email', ...p.assignments.map((a) => `${a.title}${a.kind !== 'general' ? ` (${a.kind})` : ''}`)];
  const rows = p.grid.map((g) => [g.full_name, g.email, ...g.cells.map((c) => (c.status === 'done' ? `${c.percent}%${c.passed === null ? (c.band ? ` ${c.band}` : '') : c.passed ? ' pass' : ' fail'}` : c.status === 'in_progress' ? 'in progress' : 'not started'))]);
  res.type('text/csv').set('Content-Disposition', `attachment; filename="cohort-${p.cohort.id}.csv"`).send(stringify([header, ...rows]));
}

// ---------------------------------------------------------------- Reports & settings

async function reports(req, res) {
  const w = needManager(req);
  const exams = await db()('exams as e')
    .where('e.organisation_id', w.id)
    .whereNull('e.deleted_at')
    .orderBy('e.title')
    .select('e.id', 'e.title', 'e.status', 'e.pass_mark')
    .select(db().raw("(SELECT COUNT(*) FROM results r JOIN attempts a ON a.id = r.attempt_id WHERE r.exam_id = e.id AND a.mode <> 'study') as taken"))
    .select(db().raw("(SELECT ROUND(AVG(r.percent), 1) FROM results r JOIN attempts a ON a.id = r.attempt_id WHERE r.exam_id = e.id AND a.mode <> 'study') as avg"))
    .select(db().raw('(SELECT SUM(r.passed = 1) FROM results r WHERE r.exam_id = e.id) as passed'))
    .select(db().raw('(SELECT SUM(r.passed IS NOT NULL) FROM results r WHERE r.exam_id = e.id) as decided'));
  const cohortRows = await db()('cohorts').where({ organisation_id: w.id }).whereNull('deleted_at').orderBy('name').select('id', 'name');
  const gains = [];
  for (const c of cohortRows) {
    const p = await ws.cohortProgress(w.id, c.id);
    if (p.gain && p.gain.pairs.length) gains.push({ cohort: c, gain: p.gain });
  }
  res.render('org/reports', { title: 'Reports', layout: 'layouts/app', exams, gains, w, breadcrumbs: crumbs(req, { label: 'Reports' }) });
}

async function settingsForm(req, res) {
  const w = needManager(req);
  const org = await db()('organisations').where({ id: w.id }).first();
  res.render('org/settings', { title: 'Workspace settings', layout: 'layouts/app', org, w, breadcrumbs: crumbs(req, { label: 'Settings' }) });
}

async function settingsSave(req, res) {
  const w = needManager(req);
  try {
    await ws.updateSettings(w.id, { name: req.body.name, contact_email: req.body.contact_email, ...(w.limits.custom_branding ? { primary_color: req.body.primary_color } : {}) });
    await audit.record(req, 'org.settings', { entityType: 'organisation', entityId: w.id, after: { name: req.body.name } });
    req.flash('success', 'Saved.');
  } catch (err) {
    return fail(req, res, err, '/org/settings');
  }
  return res.redirect('/org/settings');
}

// ---------------------------------------------------------------- Joining (any signed-in user)

async function invitationPage(req, res) {
  const inv = await ws.invitationByToken(req.params.token);
  if (!inv) throw notFound('This invitation link is not valid.');
  res.render('org/join', { title: `Join ${inv.organisation_name}`, layout: 'layouts/public', inv, token: req.params.token, code: null });
}

async function acceptInvitation(req, res) {
  try {
    const inv = await ws.acceptInvitation(req.params.token, req.user);
    await audit.record(req, 'org.join', { entityType: 'organisation', entityId: inv.organisation_id, after: { role: inv.role, via: 'invitation' } });
    req.flash('success', `Welcome to ${inv.organisation_name}.`);
    return res.redirect(inv.role === 'member' ? '/dashboard' : '/org');
  } catch (err) {
    if (!(err instanceof ws.WorkspaceError)) throw err;
    req.flash('danger', err.message);
    return res.redirect(`/join/${req.params.token}`);
  }
}

async function joinForm(req, res) {
  res.render('org/join', { title: 'Join an organisation', layout: 'layouts/public', inv: null, token: null, code: String(req.query.code || '') });
}

async function joinWithCode(req, res) {
  // A 6-digit number is a live quiz PIN, not a workspace code.
  if (/^\s*\d{6}\s*$/.test(String(req.body.code || ''))) return res.redirect(`/play?pin=${String(req.body.code).trim()}`);
  try {
    const org = await ws.joinWithCode(req.body.code, req.user);
    await audit.record(req, 'org.join', { entityType: 'organisation', entityId: org.id, after: { via: 'code' } });
    req.flash('success', `You joined ${org.name}. Exams they assign to you appear on your dashboard.`);
    return res.redirect('/dashboard');
  } catch (err) {
    if (!(err instanceof ws.WorkspaceError)) throw err;
    req.flash('danger', err.message);
    return res.redirect('/join');
  }
}

module.exports = { overview, switchWorkspace, members, inviteMembers, cancelInvite, changeRole, removeMember, joinCode, cohorts, createCohort, cohortShow, cohortMembers, cohortAssign, unassign, cohortCsv, reports, settingsForm, settingsSave, invitationPage, acceptInvitation, joinForm, joinWithCode };
