'use strict';

/**
 * Demo catalogue + sample question bank. Idempotent: categories/certifications are matched by slug and questions by
 * content hash, so running `npm run seed` again does not create duplicates.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { storagePath, ensureStorage } = require('../src/config/paths');
const repo = require('../src/services/questions/repository');
const types = require('../src/services/questions/types');
const data = require('./data/catalogue');
const questions = require('./data/questions');

/** Minimal PNG encoder (RGB) for the generated hotspot diagram. */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Three-tier architecture diagram: VPC frame with web / app / data tiers and arrows. */
function architectureDiagram() {
  const W = 800;
  const H = 450;
  const tiers = [
    { x0: 32, x1: 256, color: [219, 234, 254], border: [59, 110, 246] },
    { x0: 288, x1: 512, color: [220, 252, 231], border: [22, 163, 74] },
    { x0: 544, x1: 768, color: [254, 243, 199], border: [217, 119, 6] },
  ];
  return png(W, H, (x, y) => {
    if (x < 8 || x > W - 9 || y < 8 || y > H - 9) return [100, 116, 139]; // VPC frame
    for (const t of tiers) {
      const inside = x >= t.x0 && x <= t.x1 && y >= 90 && y <= 360;
      if (inside) {
        const edge = x - t.x0 < 4 || t.x1 - x < 4 || y - 90 < 4 || 360 - y < 4;
        if (edge) return t.border;
        // "server" bars inside each tier
        if (x > t.x0 + 40 && x < t.x1 - 40 && [150, 210, 270].some((b) => y > b && y < b + 34)) return t.border.map((c) => Math.min(255, c + 60));
        return t.color;
      }
    }
    // arrows between tiers
    if (y > 220 && y < 230 && ((x > 256 && x < 288) || (x > 512 && x < 544))) return [71, 85, 105];
    return [248, 250, 252];
  });
}

async function ensureCategory(knex, c, parentId, order) {
  let row = await knex('categories').where({ slug: c.slug }).first();
  if (!row) {
    const [id] = await knex('categories').insert({ slug: c.slug, name: c.name, icon: c.icon, parent_id: parentId, display_order: order, is_active: true, description: c.description || null });
    row = { id };
  }
  return row.id;
}

exports.seed = async function seed(knex) {
  ensureStorage();
  const author = await knex('users as u').join('user_roles as ur', 'ur.user_id', 'u.id').join('roles as r', 'r.id', 'ur.role_id').where('r.slug', 'super_admin').whereNull('u.deleted_at').orderBy('u.id').first('u.id');
  const user = author ? { id: author.id, can: () => true } : null;

  // Categories
  const catIds = {};
  for (const [i, c] of data.categories.entries()) {
    catIds[c.slug] = await ensureCategory(knex, c, null, i);
    for (const [j, child] of (c.children || []).entries()) catIds[child.slug] = await ensureCategory(knex, child, catIds[c.slug], j);
  }

  // Certifications + domains
  const certs = {};
  for (const [i, c] of data.certifications.entries()) {
    const slug = `${c.exam_code}-${c.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let row = await knex('certifications').where({ slug }).first();
    if (!row) {
      const [id] = await knex('certifications').insert({
        slug,
        category_id: catIds[c.category],
        name: c.name,
        issuing_body: c.issuing_body,
        exam_code: c.exam_code,
        official_passing_score: c.official_passing_score,
        official_score_scale: c.official_score_scale,
        official_duration_minutes: c.official_duration_minutes,
        official_question_count: c.official_question_count,
        external_url: c.external_url || null,
        description: c.description,
        display_order: i,
        is_active: true,
      });
      for (const [k, [code, name, weight]] of c.domains.entries()) await knex('certification_domains').insert({ certification_id: id, code, name, weight_percent: weight, display_order: k });
      row = { id };
    }
    const domains = await knex('certification_domains').where({ certification_id: row.id });
    certs[c.key] = { id: row.id, domains: Object.fromEntries(domains.map((d) => [d.code, d.id])) };
  }

  // Training programme
  for (const p of data.programmes) {
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (await knex('training_programmes').where({ slug }).first()) continue;
    const [pid] = await knex('training_programmes').insert({ slug, name: p.name, description: p.description, category_id: catIds[p.category], levels: JSON.stringify(p.levels), is_active: true });
    let order = 0;
    for (const [band, [title, message]] of Object.entries(p.bands)) {
      await knex('programme_bands').insert({ programme_id: pid, band, course_title: title, course_url: `https://training.example.com/${slug}/${band.toLowerCase()}`, message, display_order: order });
      order += 1;
    }
  }

  // Hotspot image
  let diagramUuid = (await knex('question_media').where({ original_name: 'three-tier-architecture.png' }).first('uuid'))?.uuid;
  if (!diagramUuid) {
    diagramUuid = crypto.randomUUID();
    const dir = storagePath('uploads', 'private', 'questions');
    fs.mkdirSync(dir, { recursive: true });
    const buf = architectureDiagram();
    fs.writeFileSync(path.join(dir, `${diagramUuid}.png`), buf);
    await require('../src/services/fileStore').persist(path.join(dir, `${diagramUuid}.png`), knex);
    await knex('question_media').insert({ uuid: diagramUuid, uploaded_by: author ? author.id : null, path: `${diagramUuid}.png`, original_name: 'three-tier-architecture.png', mime: 'image/png', size_bytes: buf.length, width: 800, height: 450, alt: 'Three-tier architecture diagram' });
  }

  const save = async (item, extraMeta = {}) => {
    const q = { ...item.q, image: item.q.image === 'architecture' ? diagramUuid : item.q.image };
    const hash = types.contentHash(types.normalise(q));
    const existing = await repo.findByHash(hash, knex);
    if (existing) return existing.id;
    const cert = certs[item.cert];
    const meta = {
      category_id: catIds[item.category],
      certification_id: cert ? cert.id : null,
      domain_id: cert && item.domain ? cert.domains[item.domain] : null,
      topic: item.topic || null,
      difficulty: item.difficulty || 3,
      bloom_level: item.bloom || null,
      est_time_sec: q.type === 'essay' ? 900 : q.type === 'case_study' ? 180 : 60 + (item.difficulty || 3) * 15,
      parent_id: null,
      ...extraMeta,
    };
    const saved = await repo.saveQuestion({ meta, authoring: q, tags: item.tags || [], user, status: 'published', changeNote: 'Sample content' }, knex);
    return saved.id;
  };

  for (const item of [...questions, ...require('./data/moreQuestions')]) await save(item);
  for (const cs of questions.caseStudies) {
    const parentId = await save(cs);
    for (const child of cs.children) await save({ ...child, cert: cs.cert, category: cs.category, tags: cs.tags }, { parent_id: parentId });
  }
};
