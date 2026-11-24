'use strict';

/**
 * Server-side pagination for a Knex query builder.
 * Returns { rows, page, perPage, total, pages, from, to }.
 */
async function paginate(query, { page = 1, perPage = 25, countColumn = '*' } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(5, parseInt(perPage, 10) || 25));
  const countQuery = query.clone().clearSelect().clearOrder().count({ n: countColumn });
  const [{ n }] = await countQuery;
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(p, pages);
  const rows = await query.limit(size).offset((current - 1) * size);
  return { rows, page: current, perPage: size, total, pages, from: total ? (current - 1) * size + 1 : 0, to: Math.min(total, current * size) };
}

/** Builds a URL for page `n` keeping the other query parameters. */
function pageUrl(basePath, query, n) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (k === 'page' || v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else params.set(k, v);
  }
  if (n > 1) params.set('page', n);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

module.exports = { paginate, pageUrl };
