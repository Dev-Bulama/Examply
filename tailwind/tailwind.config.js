'use strict';

const path = require('path');

const root = path.join(__dirname, '..');
const shade = (name) =>
  Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((s) => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`]));

/** Brand colours come from Settings via /theme.css (CSS variables), so admins can rebrand without a rebuild. */
module.exports = {
  content: [path.join(root, 'views/**/*.ejs'), path.join(root, 'public/js/**/*.js'), path.join(root, 'src/**/*.js')],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        primary: { DEFAULT: 'rgb(var(--c-primary-600) / <alpha-value>)', ...shade('primary') },
        secondary: { DEFAULT: 'rgb(var(--c-secondary-600) / <alpha-value>)', ...shade('secondary') },
        'on-primary': 'rgb(var(--c-on-primary) / <alpha-value>)',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        pop: '0 10px 30px -10px rgb(15 23 42 / 0.25)',
      },
      maxWidth: { prose: '68ch' },
      screens: { xs: '360px' },
    },
  },
  plugins: [require('@tailwindcss/forms')],
};
