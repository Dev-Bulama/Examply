'use strict';

/** Demo company plans (prices in kobo). Idempotent by slug. Admins edit plans under Commerce (Phase 6). */
const PLANS = [
  {
    slug: 'plan-starter',
    name: 'Starter',
    tagline: 'For training firms getting started',
    price_kobo: 2500000,
    plan_interval: 'monthly',
    display_order: 1,
    features: ['Up to 100 candidates', '300 AI-generated questions / month', 'Unlimited exams and imports', 'Instant results and certificates', 'Email support'],
    limits: { candidates: 100, ai_questions_per_month: 300, exams: null, labs: false, custom_branding: false, staff_seats: 3 },
  },
  {
    slug: 'plan-team',
    name: 'Team',
    tagline: 'For IT companies certifying their staff and clients',
    price_kobo: 7500000,
    plan_interval: 'monthly',
    display_order: 2,
    is_featured: true,
    features: ['Up to 1,000 candidates', '2,000 AI-generated questions / month', 'Cyber security terminal labs', 'Your logo and colours', 'Cohort reports and learning gain', 'Priority support'],
    limits: { candidates: 1000, ai_questions_per_month: 2000, exams: null, labs: true, custom_branding: true, staff_seats: 15 },
  },
  {
    slug: 'plan-enterprise',
    name: 'Enterprise',
    tagline: 'For academies and large organisations',
    price_kobo: 20000000,
    plan_interval: 'monthly',
    display_order: 3,
    features: ['Unlimited candidates', '10,000 AI-generated questions / month', 'Cyber labs with custom scenarios', 'Live proctored sessions', 'Dedicated success manager', 'SSO on request'],
    limits: { candidates: null, ai_questions_per_month: 10000, exams: null, labs: true, custom_branding: true, staff_seats: null },
  },
];

exports.seed = async function seed(knex) {
  for (const p of PLANS) {
    if (await knex('products').where({ slug: p.slug }).first()) continue;
    await knex('products').insert({
      type: 'plan',
      audience: 'organisation',
      name: p.name,
      slug: p.slug,
      tagline: p.tagline,
      description: p.tagline,
      price_kobo: p.price_kobo,
      currency: 'NGN',
      plan_interval: p.plan_interval,
      features: JSON.stringify(p.features),
      limits: JSON.stringify(p.limits),
      is_featured: !!p.is_featured,
      display_order: p.display_order,
      is_active: true,
    });
  }
};
