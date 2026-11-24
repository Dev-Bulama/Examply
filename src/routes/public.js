'use strict';

const express = require('express');
const { db } = require('../config/db');
const { parseJson } = require('../utils/json');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const k = db();
    const [qCount, certs, catCount, plans] = await Promise.all([
      k('questions').whereNull('deleted_at').where('status', 'published').whereNull('organisation_id').count('* as n').first(),
      k('certifications as c')
        .where('c.is_active', true)
        .orderBy('c.display_order')
        .limit(6)
        .select('c.id', 'c.name', 'c.exam_code', 'c.issuing_body', 'c.official_duration_minutes', 'c.official_question_count', k.raw("(SELECT COUNT(*) FROM questions q WHERE q.certification_id = c.id AND q.status = 'published' AND q.deleted_at IS NULL) as questions"), k.raw('(SELECT COUNT(*) FROM certification_domains d WHERE d.certification_id = c.id) as domains')),
      k('categories').where('is_active', true).whereNull('parent_id').count('* as n').first(),
      k('products').where({ type: 'plan', is_active: true, audience: 'organisation' }).whereNull('deleted_at').orderBy('display_order').select('name', 'slug', 'tagline', 'price_kobo', 'sale_price_kobo', 'currency', 'plan_interval', 'features', 'is_featured'),
    ]);
    for (const p of plans) p.features = parseJson(p.features, []);
    res.render('public/home', {
      title: res.locals.site.name,
      layout: 'layouts/public',
      landing: true,
      stats: { questions: Number(qCount.n), certifications: certs.length, categories: Number(catCount.n) },
      certs,
      plans,
    });
  }),
);

module.exports = router;
