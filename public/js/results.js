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

/* A short, quiet celebration when the candidate passes (once per result, never for reduced-motion users). */
(function () {
  'use strict';
  var el = document.querySelector('[data-celebrate]');
  if (!el || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  var key = 'examply.celebrated.' + location.pathname;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch (e) {
    /* ignore */
  }
  var colors = ['#1f3a5f', '#a8822e', '#c2a86d', '#3c5474', '#10b981', '#e2e8f0'];
  var layer = document.createElement('div');
  layer.className = 'confetti-layer';
  layer.setAttribute('aria-hidden', 'true');
  for (var i = 0; i < 90; i += 1) {
    var p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.6 + 's';
    p.style.animationDuration = 2.4 + Math.random() * 1.8 + 's';
    p.style.setProperty('--drift', Math.round(Math.random() * 160 - 80) + 'px');
    p.style.setProperty('--spin', Math.round(Math.random() * 720 - 360) + 'deg');
    layer.appendChild(p);
  }
  document.body.appendChild(layer);
  setTimeout(function () {
    layer.remove();
  }, 5200);
})();
