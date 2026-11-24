'use strict';

const { db } = require('../config/db');

/** Returns categories as a flat list in tree order with `depth` and `path` (e.g. "Database › Oracle"). */
async function categoryTree({ activeOnly = false } = {}, knex = db()) {
  const q = knex('categories').orderBy('display_order').orderBy('name');
  if (activeOnly) q.where('is_active', true);
  const rows = await q;
  const byParent = new Map();
  for (const r of rows) {
    const k = r.parent_id || 0;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(r);
  }
  const out = [];
  const ids = new Set(rows.map((r) => r.id));
  const walk = (parentId, depth, prefix) => {
    for (const r of byParent.get(parentId) || []) {
      const path = prefix ? `${prefix} › ${r.name}` : r.name;
      out.push({ ...r, depth, path });
      walk(r.id, depth + 1, path);
    }
  };
  walk(0, 0, '');
  // Orphans (parent filtered out as inactive) are shown at the root.
  for (const r of rows) if (r.parent_id && !ids.has(r.parent_id) && !out.find((o) => o.id === r.id)) out.push({ ...r, depth: 0, path: r.name });
  return out;
}

/** Ids of `id` and all its descendants. */
async function descendantIds(id, knex = db()) {
  const all = await knex('categories').select('id', 'parent_id');
  const out = new Set([Number(id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return [...out];
}

async function certificationsWithDomains(knex = db()) {
  const certs = await knex('certifications as c').leftJoin('categories as cat', 'cat.id', 'c.category_id').orderBy('c.name').select('c.id', 'c.name', 'c.exam_code', 'c.category_id', 'cat.name as category_name', 'c.is_active', 'c.official_duration_minutes', 'c.official_question_count', 'c.official_passing_score', 'c.official_score_scale');
  const domains = await knex('certification_domains').orderBy('display_order').select('id', 'certification_id', 'code', 'name', 'weight_percent');
  for (const c of certs) c.domains = domains.filter((d) => d.certification_id === c.id);
  return certs;
}

module.exports = { categoryTree, descendantIds, certificationsWithDomains };
