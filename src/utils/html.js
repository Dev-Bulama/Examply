'use strict';

const sanitizeHtml = require('sanitize-html');

// Allow-list for rich text (question stems, explanations, CMS pages).
const RICH = {
  allowedTags: [
    'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark', 'small',
    'h2', 'h3', 'h4', 'h5', 'blockquote', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'pre', 'code', 'span', 'div', 'a', 'img', 'figure', 'figcaption',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    code: ['class'],
    pre: ['class'],
    span: ['class', 'data-math'],
    div: ['class', 'data-math'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    ol: ['start', 'type'],
  },
  allowedClasses: {
    code: [/^language-[a-z0-9+#-]+$/],
    pre: [/^language-[a-z0-9+#-]+$/],
    span: ['math-inline', 'math-display'],
    div: ['math-display'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer nofollow', ...(attribs.target ? { target: '_blank' } : {}) },
    }),
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
  },
};

function sanitizeRich(html) {
  if (html === null || html === undefined) return '';
  return sanitizeHtml(String(html), RICH).trim();
}

/** Strips all tags; collapses whitespace. Used for search indexes, hashes, plain previews. */
function toPlainText(html) {
  if (!html) return '';
  // Keep block boundaries as spaces so "…employees.</p><pre>SELECT" does not become "employees.SELECT".
  const spaced = String(html).replace(/<\/(p|div|li|h[1-6]|pre|tr|td|th|blockquote|table|ul|ol)>|<br\s*\/?>/gi, '$& ');
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Email bodies: rich text plus a safe subset of inline CSS (email clients ignore stylesheets). */
const CSS_VALUE = [/^[#a-z0-9 .,%()\-{}_]+$/i];
const EMAIL_STYLES = Object.fromEntries(['color', 'background', 'background-color', 'padding', 'margin', 'border', 'border-left', 'border-radius', 'text-decoration', 'font-weight', 'font-size', 'font-style', 'display', 'word-break', 'line-height', 'text-align', 'width'].map((k) => [k, CSS_VALUE]));
const EMAIL = {
  ...RICH,
  allowedAttributes: Object.fromEntries([...new Set([...Object.keys(RICH.allowedAttributes), 'p', 'span', 'div', 'h2', 'h3', 'blockquote', 'table', 'td', 'th', 'strong'])].map((t) => [t, [...(RICH.allowedAttributes[t] || []), 'style']])),
  allowedStyles: { '*': EMAIL_STYLES },
};
function sanitizeEmail(html) {
  if (!html) return '';
  // {{variables}} would break the CSS parser inside style="", so swap them for plain tokens and back.
  const vars = [];
  const masked = String(html).replace(/\{\{\s*([a-z0-9_]{1,40})\s*\}\}/gi, (m, name) => `xvarx${vars.push(name) - 1}xvarx`);
  const clean = sanitizeHtml(masked, { ...EMAIL, transformTags: { ...EMAIL.transformTags, a: (tagName, attribs) => ({ tagName, attribs }) } }).trim();
  return clean.replace(/xvarx(\d+)xvarx/g, (m, i) => `{{${vars[Number(i)]}}}`);
}

module.exports = { sanitizeEmail, sanitizeRich, toPlainText, escapeHtml, RICH_OPTIONS: RICH };
