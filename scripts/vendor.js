'use strict';

/**
 * Copies browser libraries from node_modules into public/vendor (committed, so hPanel needs no build).
 * Run after upgrading any of them: npm run vendor
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = (...p) => path.join(root, 'public', ...p);

const files = [
  [nm('@alpinejs', 'csp', 'dist', 'cdn.min.js'), out('vendor', 'alpine', 'alpine-csp.min.js')],
  [nm('chart.js', 'dist', 'chart.umd.min.js'), out('vendor', 'chartjs', 'chart.umd.min.js')],
  [nm('katex', 'dist', 'katex.min.js'), out('vendor', 'katex', 'katex.min.js')],
  [nm('katex', 'dist', 'katex.min.css'), out('vendor', 'katex', 'katex.min.css')],
  [nm('katex', 'dist', 'contrib', 'auto-render.min.js'), out('vendor', 'katex', 'auto-render.min.js')],
  [nm('@highlightjs', 'cdn-assets', 'highlight.min.js'), out('vendor', 'highlight', 'highlight.min.js')],
  [nm('@highlightjs', 'cdn-assets', 'styles', 'github.min.css'), out('vendor', 'highlight', 'github.min.css')],
  [nm('@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css'), out('vendor', 'highlight', 'github-dark.min.css')],
  [nm('@xterm', 'xterm', 'lib', 'xterm.js'), out('vendor', 'xterm', 'xterm.js')],
  [nm('@xterm', 'xterm', 'css', 'xterm.css'), out('vendor', 'xterm', 'xterm.css')],
  [nm('@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2'), out('fonts', 'inter-latin-wght-normal.woff2')],
  [nm('@fontsource-variable', 'inter', 'files', 'inter-latin-ext-wght-normal.woff2'), out('fonts', 'inter-latin-ext-wght-normal.woff2')],
];

for (const [from, to] of files) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// KaTeX fonts (woff2 only — every supported browser handles it)
const katexFonts = nm('katex', 'dist', 'fonts');
fs.mkdirSync(out('vendor', 'katex', 'fonts'), { recursive: true });
for (const f of fs.readdirSync(katexFonts).filter((f) => f.endsWith('.woff2'))) {
  fs.copyFileSync(path.join(katexFonts, f), out('vendor', 'katex', 'fonts', f));
}
// Strip woff/ttf fallbacks from katex.min.css so it does not request files we did not copy.
const cssPath = out('vendor', 'katex', 'katex.min.css');
const css = fs.readFileSync(cssPath, 'utf8').replace(/,url\(fonts\/[^)]+\.(woff|ttf)\) format\("(woff|truetype)"\)/g, '');
fs.writeFileSync(cssPath, css);

process.stdout.write(`Vendored ${files.length} files + KaTeX fonts into public/\n`);
