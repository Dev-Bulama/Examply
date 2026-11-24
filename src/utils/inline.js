'use strict';

const { escapeHtml } = require('./html');

/**
 * "Inline markup" for short texts (options, matching items, ordering items, blank answers in import files):
 * plain text where `code` becomes <code>code</code> and \( maths \) is left for KaTeX. Everything else is escaped.
 */
function inlineToHtml(text) {
  const s = String(text ?? '').trim();
  return escapeHtml(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function htmlToInline(html) {
  return String(html ?? '')
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

module.exports = { inlineToHtml, htmlToInline };
