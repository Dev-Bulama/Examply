'use strict';

/**
 * Builds public/css/app.css with Tailwind when it is installed (development). On hosts that install production
 * dependencies only (e.g. Hostinger's "npm run build"), Tailwind is absent: the committed, pre-built CSS is used
 * and the build succeeds. Pass --watch to rebuild on changes.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'css', 'app.css');
let cli;
try {
  cli = require.resolve('tailwindcss/lib/cli.js', { paths: [root] });
} catch {
  cli = null;
}

if (!cli) {
  if (fs.existsSync(out)) {
    process.stdout.write('Tailwind is not installed (production install): using the pre-built public/css/app.css. Nothing to build.\n');
    process.exit(0);
  }
  process.stderr.write('public/css/app.css is missing and Tailwind is not installed. Run "npm install" (with dev dependencies) and try again.\n');
  process.exit(1);
}

const args = [cli, '-c', 'tailwind/tailwind.config.js', '-i', 'tailwind/input.css', '-o', 'public/css/app.css'];
args.push(process.argv.includes('--watch') ? '--watch' : '--minify');
const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
