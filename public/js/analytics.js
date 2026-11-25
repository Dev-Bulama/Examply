/* Admin analytics charts (data from #analytics-data). */
(function () {
  'use strict';
  function draw() {
    var el = document.getElementById('analytics-data');
    if (!el || !window.Chart) return;
    var data = JSON.parse(el.textContent);
    var css = getComputedStyle(document.documentElement);
    var rgb = function (v, a) {
      var parts = (css.getPropertyValue(v).trim() || '31 58 95').split(' ');
      return 'rgba(' + parts.join(',') + ',' + (a === undefined ? 1 : a) + ')';
    };
    var dark = document.documentElement.classList.contains('dark');
    var grid = dark ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.15)';
    var text = dark ? '#cbd5e1' : '#334155';
    var axes = { y: { beginAtZero: true, ticks: { precision: 0, color: text }, grid: { color: grid } }, x: { grid: { display: false }, ticks: { color: text } } };
    var daily = document.getElementById('daily-chart');
    if (daily && data.daily) {
      new window.Chart(daily, {
        type: 'bar',
        data: { labels: data.daily.map(function (d) { return d.d.slice(5); }), datasets: [{ label: 'Attempts', data: data.daily.map(function (d) { return d.n; }), backgroundColor: rgb('--c-primary-600', 0.85), borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes },
      });
    }
    var hist = document.getElementById('hist-chart');
    if (hist && data.histogram) {
      new window.Chart(hist, {
        type: 'bar',
        data: { labels: data.histogram.map(function (b) { return b.from + '–' + b.to + '%'; }), datasets: [{ label: 'Candidates', data: data.histogram.map(function (b) { return b.count; }), backgroundColor: data.histogram.map(function (b) { return b.from >= 70 ? rgb('--c-secondary-500', 0.9) : rgb('--c-primary-600', 0.85); }), borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes },
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
  else draw();
})();
