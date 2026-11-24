'use strict';

const crypto = require('crypto');

const STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
// Mix ratios relative to the base colour (600): positive → towards white, negative → towards black.
const MIX = { 50: 0.93, 100: 0.86, 200: 0.72, 300: 0.52, 400: 0.3, 500: 0.13, 600: 0, 700: -0.15, 800: -0.3, 900: -0.45, 950: -0.62 };

function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const isHexColor = (v) => parseHex(v) !== null;

function mix([r, g, b], ratio) {
  const target = ratio >= 0 ? 255 : 0;
  const a = Math.abs(ratio);
  return [r, g, b].map((c) => Math.round(c + (target - c) * a));
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function palette(hex) {
  const base = parseHex(hex) || parseHex('#1f4fd1');
  return Object.fromEntries(STOPS.map((s) => [s, mix(base, MIX[s])]));
}

/** CSS for /theme.css: brand palette as RGB-triplet variables consumed by Tailwind. */
function themeCss({ primary, secondary }) {
  const p = palette(primary);
  const s = palette(secondary);
  const onPrimary = contrast(p[600], [255, 255, 255]) >= 4.5 ? '255 255 255' : '15 23 42';
  const lines = [];
  for (const stop of STOPS) {
    lines.push(`--c-primary-${stop}: ${p[stop].join(' ')};`);
    lines.push(`--c-secondary-${stop}: ${s[stop].join(' ')};`);
  }
  lines.push(`--c-on-primary: ${onPrimary};`);
  return `:root{${lines.join('')}}`;
}

function themeVersion({ primary, secondary }) {
  return crypto.createHash('sha1').update(`${primary}|${secondary}`).digest('hex').slice(0, 10);
}

module.exports = { themeCss, themeVersion, palette, isHexColor, contrast, parseHex };
