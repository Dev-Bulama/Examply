/* Admin live monitor: polls in-progress attempts and anti-cheat alerts; new alerts pop up with a sound. */
(function () {
  'use strict';
  var rows = document.querySelector('[data-mon-rows]');
  if (!rows) return;
  var list = document.querySelector('[data-mon-events]');
  var toasts = document.querySelector('[data-mon-toasts]');
  var updated = document.querySelector('[data-mon-updated]');
  var count = document.querySelector('[data-mon-count]');
  var soundBtn = document.querySelector('[data-mon-sound]');
  var lastId = null;
  var sound = true;
  try {
    sound = localStorage.getItem('examply.monitorSound') !== 'off';
  } catch (e) {
    /* ignore */
  }
  var ctx = null;
  function beep() {
    if (!sound) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = ctx || new AC();
      if (ctx.state === 'suspended') ctx.resume();
      [988, 740].forEach(function (f, i) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = f;
        var t = ctx.currentTime + i * 0.15;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.16);
      });
    } catch (e) {
      /* no audio */
    }
  }
  function renderSound() {
    soundBtn.textContent = sound ? '🔊 Alert sound on' : '🔇 Alert sound off';
    soundBtn.setAttribute('aria-pressed', sound ? 'true' : 'false');
  }
  soundBtn.addEventListener('click', function () {
    sound = !sound;
    try {
      localStorage.setItem('examply.monitorSound', sound ? 'on' : 'off');
    } catch (e) {
      /* ignore */
    }
    renderSound();
    if (sound) beep();
  });
  renderSound();

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function timeLeft(iso, offset) {
    if (!iso) return '—';
    var s = Math.max(0, Math.round((new Date(iso).getTime() - (Date.now() + offset)) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function tone(score) {
    return score >= 85 ? 'badge-green' : score >= 70 ? 'badge-amber' : 'badge-red';
  }

  function render(data) {
    var offset = new Date(data.serverTime).getTime() - Date.now();
    count.textContent = String(data.attempts.length);
    rows.textContent = '';
    if (!data.attempts.length) {
      var tr0 = el('tr');
      tr0.appendChild(el('td', 'muted', 'Nobody is taking an exam right now.'));
      tr0.firstChild.colSpan = 6;
      rows.appendChild(tr0);
    }
    data.attempts.forEach(function (a) {
      var tr = el('tr');
      var who = el('td', 'font-medium');
      var link = el('a', 'link', a.name);
      link.href = '/admin/attempts/' + a.id;
      who.appendChild(link);
      tr.appendChild(who);
      tr.appendChild(el('td', 'text-sm', a.exam));
      tr.appendChild(el('td', 'text-right tabular-nums', a.answered + ' / ' + a.items));
      tr.appendChild(el('td', 'text-right tabular-nums', timeLeft(a.expiresAt, offset)));
      tr.appendChild(el('td', 'text-right tabular-nums ' + (a.tabSwitches ? 'font-semibold text-red-600' : ''), String(a.tabSwitches)));
      var sc = el('td', 'text-right');
      sc.appendChild(el('span', tone(a.score), a.score + '/100'));
      tr.appendChild(sc);
      rows.appendChild(tr);
    });
    list.textContent = '';
    if (!data.events.length) list.appendChild(el('li', 'muted', 'No alerts yet.'));
    data.events.forEach(function (e) {
      var li = el('li', 'rounded-md bg-red-50 px-3 py-2 dark:bg-red-950/40');
      var a = el('a', 'block hover:underline');
      a.href = '/admin/attempts/' + e.attemptId;
      a.appendChild(el('span', 'font-semibold', e.name + ' '));
      a.appendChild(document.createTextNode(e.label + (e.away ? ' (' + e.away + 's)' : '')));
      li.appendChild(a);
      li.appendChild(el('span', 'block text-xs muted', e.exam + ' · ' + new Date(e.at).toLocaleTimeString()));
      list.appendChild(li);
    });
    // Pop-ups for alerts that arrived since the last poll (not on the first load).
    if (lastId !== null) {
      var fresh = data.events.filter(function (e) {
        return e.id > lastId;
      });
      if (fresh.length) beep();
      fresh.slice(0, 3).forEach(function (e) {
        var t = el('div', 'pointer-events-auto rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-pop', '⚠ ' + e.name + ' ' + e.label + (e.away ? ' (' + e.away + 's)' : '') + ' — ' + e.exam);
        toasts.appendChild(t);
        setTimeout(function () {
          t.remove();
        }, 7000);
      });
    }
    lastId = data.events.length ? Math.max(lastId || 0, data.events[0].id) : lastId === null ? 0 : lastId;
    updated.textContent = 'Updated ' + new Date().toLocaleTimeString();
  }

  function poll() {
    fetch('/admin/attempts/monitor.json', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error(String(r.status)));
      })
      .then(render)
      .catch(function () {
        updated.textContent = 'Reconnecting…';
      })
      .then(function () {
        setTimeout(poll, 5000);
      });
  }
  poll();
})();
