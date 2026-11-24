'use strict';

/**
 * AI question generation. A generation run is stored as an `imports` row (source = 'ai') so the generated
 * questions go through exactly the same validation, duplicate detection, dry-run preview, confirm, error report
 * and 24-hour undo as a file import.
 *
 *   startGeneration → job ai.generate → batches of ≤ 20 questions per API call, spread across certification
 *   domains by weight → records → pipeline.storeRecords → status "parsed" (preview)
 */
const crypto = require('crypto');
const { db } = require('../../config/db');
const { getLogger } = require('../../config/logger');
const queue = require('../jobs/queue');
const settings = require('../settings');
const providers = require('./providers');
const pipeline = require('../import/pipeline');
const { textToHtml } = require('../import/rowMapper');
const { toJson, parseJson } = require('../../utils/json');
const { toPlainText } = require('../../utils/html');

const BATCH_SIZE = 20;
const GENERATABLE = ['single_choice', 'multiple_response', 'true_false', 'fill_blank', 'numeric', 'matching', 'ordering', 'short_answer', 'essay'];
const BLOOM = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

/** JSON schema for one batch (all properties required + additionalProperties:false — valid for Claude and OpenAI strict mode). */
function batchSchema() {
  const str = { type: 'string' };
  const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  return obj({
    questions: {
      type: 'array',
      items: obj({
        type: { type: 'string', enum: GENERATABLE },
        stem: str,
        options: { type: 'array', items: obj({ text: str, correct: { type: 'boolean' } }) },
        blanks: { type: 'array', items: obj({ variants: { type: 'array', items: str } }) },
        numeric_value: nullable({ type: 'number' }),
        tolerance: nullable({ type: 'number' }),
        units: nullable(str),
        pairs: { type: 'array', items: obj({ left: str, right: str }) },
        distractors: { type: 'array', items: str },
        keywords: { type: 'array', items: obj({ terms: { type: 'array', items: str }, weight: { type: 'number' } }) },
        threshold: nullable({ type: 'number' }),
        rubric: nullable(str),
        explanation: str,
        reference: nullable(str),
        difficulty: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        bloom: { type: 'string', enum: BLOOM },
        domain: nullable(str),
        topic: str,
      }),
    },
  });
}

const SYSTEM_PROMPT = `You are a senior certification exam item writer and psychometrician. You write ORIGINAL exam questions for professional certification preparation and pre-training assessment.

Quality rules — follow every one:
- Original content only. Never reproduce real exam questions, "brain dumps" or copyrighted question banks.
- Technically accurate and current. If something is version-specific, name the version in the stem.
- Exactly what the certification level demands: scenario-based, applied questions for "apply"/"analyze" levels; avoid trivia unless the blueprint asks for recall.
- One unambiguous best answer for single choice. Distractors must be plausible to a partly-prepared candidate, similar in length and style to the key, and clearly wrong to an expert.
- No "all of the above"/"none of the above", no trick wording, avoid negatively worded stems; if unavoidable, write NOT in capitals.
- Explanations teach: say why the key is correct AND why each distractor is wrong.
- Calibrate difficulty 1 (very easy) to 5 (very hard) honestly, and set the Bloom level that matches the thinking required.
- Vary the position of correct options.

Format rules per type (fields not used by a type must be empty arrays or null):
- single_choice: 4 options, exactly one correct=true. multiple_response: 4–6 options, 2–3 correct=true; say "(Choose two.)" or "(Choose three.)" at the end of the stem.
- true_false: options = [{"text":"True","correct":…},{"text":"False","correct":…}].
- fill_blank: put [[1]], [[2]] … in the stem where answers go; blanks[i].variants lists every acceptable spelling for blank i+1.
- numeric: numeric_value is the answer, tolerance the accepted ± range (0 for exact), units shown to the candidate (or null).
- matching: 3–6 pairs {left,right} plus 0–2 distractors (extra right-hand items).
- ordering: options listed in the CORRECT order (correct=true for all).
- short_answer: keywords with weights; threshold = score needed for full marks.
- essay: rubric = marking guide with marks per criterion.
- domain: copy the exact domain code you were asked to cover (or null if none were given).
- stem and explanation are plain text; wrap code, commands and identifiers in backticks; use \\( … \\) for maths.
Return only the JSON object.`;

/** Spreads `count` questions over domains by weight (largest remainder). */
function allocate(count, domains) {
  if (!domains.length) return [{ domain: null, count }];
  const total = domains.reduce((s, d) => s + (Number(d.weight_percent) || 0), 0) || domains.length;
  const raw = domains.map((d) => ({ domain: d, exact: (count * (Number(d.weight_percent) || total / domains.length)) / total }));
  const out = raw.map((r) => ({ domain: r.domain, count: Math.floor(r.exact), rem: r.exact - Math.floor(r.exact) }));
  let left = count - out.reduce((s, o) => s + o.count, 0);
  out.sort((a, b) => b.rem - a.rem);
  for (let i = 0; left > 0; i = (i + 1) % out.length, left -= 1) out[i].count += 1;
  return out.filter((o) => o.count > 0).map(({ domain, count: c }) => ({ domain, count: c }));
}

/** Splits the allocation into API batches of ≤ BATCH_SIZE. */
function planBatches(allocation) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const a of allocation) {
    let remaining = a.count;
    while (remaining > 0) {
      const take = Math.min(remaining, BATCH_SIZE - size);
      cur.push({ domain: a.domain, count: take });
      size += take;
      remaining -= take;
      if (size === BATCH_SIZE) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function batchPrompt({ spec, batch, cert, avoid }) {
  const lines = [];
  lines.push(`Write ${batch.reduce((s, b) => s + b.count, 0)} exam questions.`);
  lines.push('', `Brief from the exam author:\n${spec.prompt}`);
  if (cert) lines.push('', `Certification: ${cert.name}${cert.exam_code ? ` (${cert.exam_code})` : ''}${cert.issuing_body ? `, ${cert.issuing_body}` : ''}.`);
  lines.push('', 'Coverage for this batch:');
  for (const b of batch) lines.push(`- ${b.count} question(s)${b.domain ? ` for domain ${b.domain.code || b.domain.name} — “${b.domain.name}” (use "${b.domain.code || b.domain.name}" as the domain value)` : ''}`);
  lines.push('', `Allowed question types: ${spec.types.join(', ')}. Mix them sensibly; prefer ${spec.types[0]} when unsure.`);
  lines.push(`Target difficulty: ${spec.difficulty === 'mixed' ? 'a realistic mix (roughly 20% easy, 50% medium, 30% hard)' : `${spec.difficulty} (on the 1–5 scale)`}.`);
  lines.push(`Level: ${spec.level}.`);
  if (spec.language && spec.language !== 'English') lines.push(`Write everything in ${spec.language}.`);
  if (spec.reference) lines.push('', 'Reference material to base the questions on (do not quote it verbatim):', '<reference>', spec.reference.slice(0, 60000), '</reference>');
  if (avoid.length) lines.push('', 'Do NOT repeat or paraphrase these questions that were already written:', ...avoid.slice(-60).map((s) => `- ${s}`));
  return lines.join('\n');
}

/** Converts one AI question into an import record (the pipeline validates it with the type registry). */
function toRecord(q, n, domainsByCode) {
  const opts = (q.options || []).map((o) => ({ text: String(o.text || '').trim(), correct: !!o.correct }));
  const base = { type: q.type, stem_html: textToHtml(String(q.stem || '').replace(/`([^`]+)`/g, '<code>$1</code>')), explanation_html: textToHtml(String(q.explanation || '').replace(/`([^`]+)`/g, '<code>$1</code>')), reference: q.reference || '' };
  let question;
  switch (q.type) {
    case 'single_choice':
    case 'multiple_response':
      question = { ...base, options: opts };
      break;
    case 'true_false': {
      const t = opts.find((o) => /^true$/i.test(o.text));
      question = { ...base, correct: t ? t.correct : opts.length ? !opts[0].correct : null };
      break;
    }
    case 'fill_blank':
      question = { ...base, blanks: (q.blanks || []).map((b) => ({ variants: (b.variants || []).map(String) })), case_sensitive: false, trim_whitespace: true };
      break;
    case 'numeric':
      question = { ...base, value: q.numeric_value, tolerance: q.tolerance || 0, units: q.units || '' };
      break;
    case 'matching':
      question = { ...base, pairs: q.pairs || [], distractors: q.distractors || [] };
      break;
    case 'ordering':
      question = { ...base, items: opts.map((o) => o.text) };
      break;
    case 'short_answer':
      question = { ...base, keywords: q.keywords || [], threshold: q.threshold, case_sensitive: false };
      break;
    case 'essay':
      question = { ...base, marks: 10, rubric_html: textToHtml(q.rubric || ''), min_words: null, max_words: null };
      break;
    default:
      question = { ...base };
  }
  const dom = q.domain && domainsByCode.get(String(q.domain).toLowerCase());
  return {
    rowNumber: n,
    rowRef: `Question ${n}`,
    source: { ai: JSON.stringify(q).slice(0, 4000) },
    question,
    meta: { domain: dom ? dom.code || dom.name : '', topic: q.topic || '', tags: 'ai-generated', difficulty: [1, 2, 3, 4, 5].includes(q.difficulty) ? q.difficulty : null, bloom: BLOOM.includes(q.bloom) ? q.bloom : null },
    errors: [],
    warnings: q.domain && !dom ? [`AI used an unknown domain “${q.domain}”.`] : [],
  };
}

async function startGeneration({ user, spec, organisationId = null }) {
  const max = Number(await settings.get('ai.max_questions_per_run')) || 100;
  if (spec.count > max) throw new providers.AiError(`At most ${max} questions per run (Settings → AI).`);
  const [importId] = await db()('imports').insert({
    uuid: crypto.randomUUID(),
    user_id: user.id,
    organisation_id: organisationId,
    original_name: String(spec.title || spec.prompt).replace(/\s+/g, ' ').slice(0, 120),
    stored_path: '',
    format: 'ai',
    source: 'ai',
    status: 'uploaded',
    options: toJson({ category_id: spec.category_id, certification_id: spec.certification_id, difficulty: 3, status: spec.status, duplicate_default: 'skip', exam_mode: spec.exam_mode, exam_id: spec.exam_id, exam_title: spec.exam_title }),
    target_exam_id: spec.exam_mode === 'attach' ? spec.exam_id : null,
  });
  const [genId] = await db()('ai_generations').insert({
    import_id: importId,
    organisation_id: organisationId,
    user_id: user.id,
    provider: spec.provider,
    model: spec.model || (spec.provider === 'anthropic' ? await settings.get('ai.anthropic_model') : await settings.get('ai.openai_model')) || 'default',
    prompt: spec.prompt,
    blueprint: toJson(spec),
    requested_count: spec.count,
  });
  await queue.enqueue('ai.generate', { generationId: genId }, { maxAttempts: 1 });
  pipeline.kick();
  return { importId, generationId: genId };
}

async function runGeneration(generationId) {
  const k = db();
  const gen = await k('ai_generations').where({ id: generationId }).first();
  if (!gen || gen.status !== 'queued') return { skipped: true };
  const spec = parseJson(gen.blueprint, {});
  const imp = await k('imports').where({ id: gen.import_id }).first();
  await k('ai_generations').where({ id: gen.id }).update({ status: 'running' });
  await k('imports').where({ id: imp.id }).update({ status: 'parsing', parse_progress: 2 });
  const cert = spec.certification_id ? await k('certifications').where({ id: spec.certification_id }).first() : null;
  const allDomains = cert ? await k('certification_domains').where({ certification_id: cert.id }).orderBy('display_order') : [];
  const chosen = spec.domain_ids && spec.domain_ids.length ? allDomains.filter((d) => spec.domain_ids.includes(d.id)) : allDomains;
  const domainsByCode = new Map();
  for (const d of allDomains) {
    domainsByCode.set(String(d.code || d.name).toLowerCase(), d);
    domainsByCode.set(d.name.toLowerCase(), d);
  }
  const batches = planBatches(allocate(spec.count, chosen));
  const records = [];
  const avoid = [];
  let input = 0;
  let output = 0;
  let lastError = null;
  for (const [i, batch] of batches.entries()) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const res = await providers.generateJson(gen.provider, { system: SYSTEM_PROMPT, prompt: batchPrompt({ spec, batch, cert, avoid }), schema: batchSchema(), model: gen.model === 'default' ? null : gen.model });
        input += res.usage.input;
        output += res.usage.output;
        for (const q of (res.data && res.data.questions) || []) {
          records.push(toRecord(q, records.length + 1, domainsByCode));
          avoid.push(toPlainText(q.stem || '').slice(0, 160));
        }
        break;
      } catch (err) {
        if (err.retryable && attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        lastError = err.message;
        getLogger().warn({ generationId, batch: i, err: err.message }, 'AI batch failed');
        break;
      }
    }
    await k('ai_generations').where({ id: gen.id }).update({ generated_count: records.length, input_tokens: input, output_tokens: output, last_error: lastError });
    await k('imports').where({ id: imp.id }).update({ parse_progress: Math.max(2, Math.floor(((i + 1) / batches.length) * 90)) });
    if (lastError && !records.length) break;
  }
  if (!records.length) {
    await k('ai_generations').where({ id: gen.id }).update({ status: 'failed', completed_at: new Date(), last_error: lastError });
    await k('imports').where({ id: imp.id }).update({ status: 'failed', last_error: lastError || 'The AI returned no questions.' });
    return { failed: true };
  }
  await pipeline.storeRecords({ ...imp, options: imp.options }, records, { fileErrors: lastError ? [`Some batches failed: ${lastError}`] : [] });
  await k('ai_generations').where({ id: gen.id }).update({ status: 'completed', completed_at: new Date() });
  return { generated: records.length, input, output };
}

function registerJobs() {
  queue.register('ai.generate', ({ generationId }) => runGeneration(generationId));
}

module.exports = { startGeneration, runGeneration, registerJobs, allocate, planBatches, batchSchema, batchPrompt, toRecord, SYSTEM_PROMPT, GENERATABLE };
