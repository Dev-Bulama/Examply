'use strict';

const { db } = require('../../config/db');
const { parseJson } = require('../../utils/json');
const { notFound } = require('../../utils/errors');
const audit = require('../../services/audit');
const analytics = require('../../services/analytics');
const P = require('../../services/analytics/psychometrics');

const crumbs = (...extra) => [{ label: 'Admin', href: '/admin' }, { label: 'Analytics', href: '/admin/analytics' }, ...extra];

async function index(req, res) {
  const since = new Date(Date.now() - 30 * 86400e3);
  const [users, newUsers, attempts30, passed30, graded30, exams] = await Promise.all([
    db()('users').whereNull('deleted_at').count('* as n').first(),
    db()('users').whereNull('deleted_at').where('created_at', '>=', since).count('* as n').first(),
    db()('attempts').where('started_at', '>=', since).whereNot('mode', 'study').count('* as n').first(),
    db()('attempts').where('submitted_at', '>=', since).where('passed', true).count('* as n').first(),
    db()('attempts').where('submitted_at', '>=', since).whereNotNull('passed').count('* as n').first(),
    db()('exams as e')
      .leftJoin('exam_statistics as s', 's.exam_id', 'e.id')
      .whereNull('e.deleted_at')
      .whereNull('e.organisation_id')
      .whereExists(function () {
        this.select(1).from('attempts as a').whereRaw('a.exam_id = e.id');
      })
      .orderBy('s.attempts', 'desc')
      .select('e.id', 'e.title', 'e.type', 's.attempts', 's.completed', 's.pass_rate', 's.avg_percent', 's.kr20', 's.computed_at', db().raw("(select count(*) from item_statistics i where i.exam_id = e.id and json_search(i.flags, 'one', 'negative_discrimination') is not null) as bad_items")),
  ]);
  const daily = await db()('attempts').where('started_at', '>=', since).whereNot('mode', 'study').select(db().raw('date(started_at) as d'), db().raw('count(*) as n')).groupByRaw('date(started_at)').orderBy('d');
  res.render('admin/analytics/index', {
    title: 'Analytics',
    layout: 'layouts/app',
    kpi: { users: Number(users.n), newUsers: Number(newUsers.n), attempts30: Number(attempts30.n), passRate30: Number(graded30.n) ? Math.round((Number(passed30.n) / Number(graded30.n)) * 100) : null },
    exams: exams.map((e) => ({ ...e, reliability: P.reliabilityLabel(e.kr20 === null ? null : Number(e.kr20), Number(e.completed) || 0) })),
    chart: JSON.stringify({ daily: daily.map((r) => ({ d: new Date(r.d).toISOString().slice(0, 10), n: Number(r.n) })) }),
    breadcrumbs: crumbs(),
  });
}

async function exam(req, res) {
  const examRow = await db()('exams').where({ id: Number(req.params.id) }).whereNull('deleted_at').first('id', 'title', 'type', 'organisation_id');
  if (!examRow || examRow.organisation_id) throw notFound();
  let stats = await db()('exam_statistics').where({ exam_id: examRow.id }).first();
  if (!stats) {
    await analytics.computeExam(examRow.id);
    stats = await db()('exam_statistics').where({ exam_id: examRow.id }).first();
  }
  const items = await db()('item_statistics as i')
    .join('questions as q', 'q.id', 'i.question_id')
    .leftJoin('question_versions as v', 'v.id', 'q.current_version_id')
    .where('i.exam_id', examRow.id)
    .orderByRaw('i.point_biserial is null, i.point_biserial asc')
    .select('i.*', 'v.stem_html', 'v.type');
  res.render('admin/analytics/exam', {
    title: `Analytics · ${examRow.title}`,
    layout: 'layouts/app',
    exam: examRow,
    stats: { ...stats, histogram: parseJson(stats.histogram, []), dropoff: parseJson(stats.dropoff, {}), reliability: P.reliabilityLabel(stats.kr20 === null ? null : Number(stats.kr20), stats.completed) },
    items: items.map((i) => ({ ...i, flags: parseJson(i.flags, []), distractors: parseJson(i.distractors, null), stem: String(i.stem_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) })),
    chart: JSON.stringify({ histogram: parseJson(stats.histogram, []) }),
    breadcrumbs: crumbs({ label: examRow.title }),
  });
}

async function recompute(req, res) {
  const id = Number(req.params.id) || null;
  const out = id ? await analytics.computeExam(id) : await analytics.computeAll();
  await audit.record(req, 'analytics.recompute', { entityType: 'exam', entityId: id });
  req.flash('success', id ? `Recomputed: ${out.items} questions analysed, ${out.flagged} flagged.` : `Recomputed: ${out}.`);
  res.redirect(id ? `/admin/analytics/exams/${id}` : '/admin/analytics');
}

module.exports = { index, exam, recompute };
