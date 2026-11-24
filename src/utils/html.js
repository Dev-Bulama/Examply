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
  return sanitizeHtml(String(html), { allowedTags: [], allowedAttributes: {} })
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

module.exports = { sanitizeRich, toPlainText, escapeHtml, RICH_OPTIONS: RICH };
