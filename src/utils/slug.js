'use strict';

function slugify(input, maxLength = 120) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/** Returns a slug unique in `table.column`, appending -2, -3… when taken. */
async function uniqueSlug(knex, table, base, { column = 'slug', ignoreId } = {}) {
  const root = slugify(base) || 'item';
  let candidate = root;
  for (let i = 2; i < 1000; i += 1) {
    const q = knex(table).where(column, candidate).first('id');
    if (ignoreId) q.whereNot('id', ignoreId);
    if (!(await q)) return candidate;
    candidate = `${root}-${i}`;
  }
  return `${root}-${Date.now()}`;
}

module.exports = { slugify, uniqueSlug };
