/* Result page charts: domain radar and attempt history (data from #result-chart-data). */
(function () {
  'use strict';
  function draw() {
    var el = document.getElementById('result-chart-data');
    if (!el || !window.Chart) return;
    var data;
    try {
      data = JSON.parse(el.textContent);
    } catch (e) {
      return;
    }
    var css = getComputedStyle(document.documentElement);
    var primary = 'rgb(' + (css.getPropertyValue('--c-primary-600').trim() || '31 79 209').split(' ').join(',') + ')';
    var fill = primary.replace('rgb(', 'rgba(').replace(')', ',0.18)');
    var dark = document.documentElement.classList.contains('dark');
    var grid = dark ? 'rgba(148,163,184,0.25)' : 'rgba(100,116,139,0.2)';
    var text = dark ? '#cbd5e1' : '#334155';
    var radar = document.getElementById('domain-radar');
    if (radar && data.domains.length >= 3) {
      new window.Chart(radar, {
        type: 'radar',
        data: {
          labels: data.domains.map(function (d) {
            return d.label.length > 28 ? d.label.slice(0, 27) + '…' : d.label;
          }),
          datasets: [{ label: 'Your score (%)', data: data.domains.map(function (d) { return d.percent; }), borderColor: primary, backgroundColor: fill, pointBackgroundColor: primary, borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } }, scales: { r: { min: 0, max: 100, ticks: { stepSize: 25, backdropColor: 'transparent', color: text }, grid: { color: grid }, angleLines: { color: grid }, pointLabels: { color: text, font: { size: 11 } } } } },
      });
    }
    var hist = document.getElementById('history-chart');
    if (hist && data.history.length > 1) {
      new window.Chart(hist, {
        type: 'line',
        data: { labels: data.history.map(function (h) { return h.label; }), datasets: [{ label: 'Score (%)', data: data.history.map(function (h) { return h.percent; }), borderColor: primary, backgroundColor: fill, fill: true, tension: 0.3 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, grid: { color: grid }, ticks: { color: text } }, x: { grid: { display: false }, ticks: { color: text } } } },
      });
    }
  }
  if (document.readyState === 'complete') draw();
  else window.addEventListener('load', draw);
})();
