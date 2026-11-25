'use strict';

/**
 * Reference documents for AI generation: extracts plain text from uploaded files so questions can be grounded
 * in a syllabus, course notes, a policy or slides. Pure JavaScript (pdf.js, mammoth, adm-zip) — no native code.
 *
 *   extract(file) → { name, kind, pages, chars, text }      file = multer memory file
 *   combine(docs, pasted, limit) → one reference string with a header per source
 *
 * File types are detected from magic bytes, never from the name or the client's MIME type.
 */
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');
const { sniff } = require('../uploads');

const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 300;
const MAX_CHARS = 60000;

class DocumentError extends Error {}

const clean = (t) =>
  String(t || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Runs pdf.js in a worker thread with a time and memory cap, so a huge or hostile PDF cannot stall the server. */
function pdfText(buffer) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(require('path').join(__dirname, 'pdfWorker.js'), {
      workerData: { buffer, maxPages: MAX_PAGES, maxChars: MAX_CHARS * 2 },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new DocumentError('took too long to read. Try a smaller file or paste the key sections.'));
    }, 30000);
    worker.once('message', (m) => {
      clearTimeout(timer);
      worker.terminate();
      if (m.error === 'password') reject(new DocumentError('is password-protected. Remove the password and upload it again.'));
      else if (m.error) reject(new DocumentError('could not be read as a PDF.'));
      else resolve(m);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(new DocumentError('could not be read as a PDF.'));
    });
  });
}

/** Slide text from a .pptx (DrawingML <a:t> runs), in slide order. */
function pptxText(zip) {
  const slides = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => Number(a.entryName.match(/(\d+)\.xml$/)[1]) - Number(b.entryName.match(/(\d+)\.xml$/)[1]));
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const text = slides.map((e, i) => {
    const xml = e.getData().toString('utf8');
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decode(m[1])).join(''));
    return `Slide ${i + 1}\n${paras.filter((p) => p.trim()).join('\n')}`;
  });
  return { text: text.join('\n\n'), pages: slides.length };
}

function looksLikeText(buf) {
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0)) return false;
  const s = sample.toString('utf8');
  const bad = (s.match(/�/g) || []).length;
  return bad < 4;
}

/** Extracts text from one uploaded file. Throws DocumentError with a candidate-friendly message. */
async function extract(file) {
  const name = String(file.originalname || 'document').slice(0, 120);
  const fail = (msg) => {
    throw new DocumentError(`“${name}” ${msg}`);
  };
  if (!file.buffer || !file.size) fail('is empty.');
  if (file.size > MAX_BYTES) fail('is larger than 20 MB.');
  const kind = sniff(file.buffer);
  let out;
  try {
    if (kind && kind.ext === 'pdf') out = { kind: 'PDF', ...(await pdfText(file.buffer)) };
    else if (kind && kind.ext === 'zip') {
      let zip;
      try {
        zip = new AdmZip(file.buffer);
      } catch {
        fail('is not a valid Office file.');
      }
      const names = zip.getEntries().map((e) => e.entryName);
      if (names.includes('word/document.xml')) out = { kind: 'Word', text: (await mammoth.extractRawText({ buffer: file.buffer })).value, pages: null };
      else if (names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) out = { kind: 'PowerPoint', ...pptxText(zip) };
      else fail('is a ZIP file but not a Word (.docx) or PowerPoint (.pptx) document.');
    } else if (!kind && looksLikeText(file.buffer)) {
      let text = file.buffer.toString('utf8');
      if (/\.html?$/i.test(name) || /^\s*<(!doctype|html)/i.test(text)) text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
      out = { kind: 'Text', text, pages: null };
    } else fail('is not a supported type. Use PDF, Word (.docx), PowerPoint (.pptx), or a text/Markdown/CSV file.');
  } catch (err) {
    if (err instanceof DocumentError) throw err.message.startsWith('“') ? err : new DocumentError(`“${name}” ${err.message}`);
    fail('could not be read.');
  }
  const text = clean(out.text);
  if (text.length < 40) fail(out.kind === 'PDF' ? 'has no selectable text (it may be a scan). Upload a text-based PDF or paste the content.' : 'has almost no text.');
  return { name, kind: out.kind, pages: out.pages, chars: text.length, text };
}

/** Joins pasted material and documents into one reference, trimmed fairly so every source is represented. */
function combine(docs, pasted = '', limit = MAX_CHARS) {
  const sources = [];
  if (String(pasted || '').trim()) sources.push({ name: 'Pasted notes', text: clean(pasted) });
  for (const d of docs) sources.push({ name: d.name, text: d.text });
  if (!sources.length) return { reference: '', truncated: false };
  const header = (s) => `### Source: ${s.name}\n`;
  const overhead = sources.reduce((n, s) => n + header(s).length + 2, 0);
  let budget = Math.max(0, limit - overhead);
  // Smallest first, so short sources stay whole and long ones share what is left.
  const order = [...sources].sort((a, b) => a.text.length - b.text.length);
  const take = new Map();
  order.forEach((s, i) => {
    const share = Math.floor(budget / (order.length - i));
    const n = Math.min(s.text.length, share);
    take.set(s, n);
    budget -= n;
  });
  let truncated = false;
  const reference = sources
    .map((s) => {
      const n = take.get(s);
      if (n < s.text.length) truncated = true;
      return header(s) + s.text.slice(0, n);
    })
    .join('\n\n');
  return { reference, truncated };
}

module.exports = { extract, combine, DocumentError, MAX_FILES, MAX_BYTES, MAX_CHARS };
