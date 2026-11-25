/* EXAMPLY — live quiz: host screen (#live-host) and player screen (#live-play).
 * The server is authoritative; this file only renders state and sends intents over Socket.IO (/live). */
(function () {
  'use strict';

  var TILE = ['tile-0', 'tile-1', 'tile-2', 'tile-3', 'tile-4', 'tile-5'];
  var host = document.getElementById('live-host');
  var play = document.getElementById('live-play');
  var root = host || play;
  if (!root || typeof window.io !== 'function') return;

  var $ = function (sel, el) {
    return (el || root).querySelector(sel);
  };
  var $$ = function (sel, el) {
    return Array.prototype.slice.call((el || root).querySelectorAll(sel));
  };
  var show = function (name) {
    $$('[data-view]').forEach(function (v) {
      v.hidden = v.getAttribute('data-view') !== name;
    });
  };
  var text = function (sel, value) {
    $$(sel).forEach(function (el) {
      el.textContent = value;
    });
  };
  var el = function (tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  };
  var errorBox = $('[data-error]');
  var setError = function (msg) {
    if (errorBox) errorBox.textContent = msg || '';
  };

  var offset = 0; // server clock − local clock
  var endsAt = null;
  var nextAt = null; // host-paced auto-advance: when the reveal / leaderboard moves on
  var paused = null;
  var lastTick = null;
  var sfx = window.LiveSfx || { play: function () {}, music: function () {}, bindToggle: function () {} };
  $$('[data-sound]').forEach(function (b) {
    sfx.bindToggle(b);
  });
  setInterval(function () {
    var n = $('[data-next-in]');
    if (n) {
      var nl = nextAt ? Math.max(0, Math.ceil((nextAt - (Date.now() + offset)) / 1000)) : null;
      n.hidden = nl === null;
      if (nl !== null) n.textContent = 'Next in ' + nl + 's';
    }
    var c = $('[data-countdown]');
    if (!c) return;
    if (paused !== null) {
      c.hidden = false;
      c.textContent = '⏸ ' + Math.ceil(paused / 1000);
      return;
    }
    if (!endsAt) {
      c.hidden = true;
      return;
    }
    c.hidden = false;
    var left = Math.max(0, Math.ceil((endsAt - (Date.now() + offset)) / 1000));
    c.textContent = left + 's';
    c.classList.toggle('text-red-500', left <= 5);
    if (left > 0 && left <= 5 && left !== lastTick) sfx.play(left <= 3 ? 'tickLast' : 'tick');
    lastTick = left;
  }, 200);

  function syncClock(s) {
    if (s.serverNow) offset = s.serverNow - Date.now();
    endsAt = s.endsAt ? new Date(s.endsAt).getTime() : null;
    nextAt = s.phase !== 'question' && s.phaseEndsAt ? new Date(s.phaseEndsAt).getTime() : null;
    paused = s.status === 'paused' ? Number(s.pausedRemainingMs) || 0 : null;
    var bar = $('[data-bar]');
    if (bar && s.total) {
      var done = s.mode === 'host_paced' ? Math.max(0, s.index + (s.phase === 'question' ? 0 : 1)) : s.me ? s.me.question ? s.me.question.index : s.total : 0;
      bar.style.width = Math.round((done / s.total) * 100) + '%';
    }
  }

  function setStem(node, html) {
    node.innerHTML = html || ''; // stored question HTML, sanitised when it was saved
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(node, { throwOnError: false });
      } catch (e) {
        /* ignore */
      }
    }
  }

  function leaderboardList(list, rows, highlightId, dark) {
    list.textContent = '';
    rows.forEach(function (r) {
      var li = el('li', 'flex items-center gap-3 rounded-xl px-4 py-3 ' + (dark ? (r.id === highlightId ? 'bg-secondary-500 text-primary-950' : 'bg-white/10') : r.id === highlightId ? 'bg-secondary-100' : 'bg-white shadow-card dark:bg-slate-900'));
      li.appendChild(el('span', 'w-8 text-lg font-black tabular-nums', String(r.rank)));
      li.appendChild(el('span', 'min-w-0 flex-1 truncate font-semibold', r.nickname));
      if (r.streak > 1) li.appendChild(el('span', 'text-xs font-semibold', '🔥 ' + r.streak));
      li.appendChild(el('span', 'font-mono font-bold tabular-nums', Number(r.score).toLocaleString('en')));
      list.appendChild(li);
    });
  }

  // ================================================================ Host
  if (host) {
    var socket = window.io('/live', { auth: { session: Number(host.getAttribute('data-session')), host: host.getAttribute('data-token') }, withCredentials: true });
    var send = function (evt, payload) {
      setError('');
      socket.emit(evt, payload || {}, function (res) {
        if (res && !res.ok) setError(res.error);
      });
    };
    $$('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        if (act === 'end' && !window.confirm('End the game for everyone now?')) return;
        if (act === 'auto') return send('auto', { on: b.getAttribute('aria-pressed') !== 'true' });
        send(act);
      });
    });
    socket.on('connect_error', function () {
      setError('Reconnecting…');
    });
    socket.on('connect', function () {
      setError('');
    });

    var hostKey = null;
    var hostPlayers = 0;
    // ---- Anti-cheat alerts (live, from players' devices)
    var alertsPanel = $('[data-alerts-panel]');
    var alertsHidden = false;
    var toggle = $('[data-alerts-toggle]');
    if (toggle)
      toggle.addEventListener('click', function () {
        alertsHidden = !alertsHidden;
        $('[data-alerts-list]').hidden = alertsHidden;
        toggle.textContent = alertsHidden ? 'Show' : 'Hide';
      });
    socket.on('alert', function (a) {
      sfx.play('alert');
      var box = $('[data-alert-toasts]');
      if (!box) return;
      var t = el('div', 'pointer-events-auto rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-pop', '⚠ ' + a.nickname + ' ' + a.label + (a.away ? ' (' + a.away + 's)' : '') + (a.autoSubmitted ? ' — answers submitted automatically' : a.type === 'tab_return' || a.type === 'offline' ? '' : ' · warning ' + a.flags));
      box.appendChild(t);
      setTimeout(function () {
        t.remove();
      }, 6000);
    });
    function renderAlerts(s) {
      if (!alertsPanel) return;
      var list = s.alerts || [];
      alertsPanel.hidden = !list.length || s.status === 'lobby';
      var ol = $('[data-alerts-list]');
      ol.textContent = '';
      list.forEach(function (a) {
        var li = el('li', 'rounded-md bg-red-50 px-2.5 py-1.5 dark:bg-red-950/40');
        li.appendChild(el('span', 'font-semibold', a.nickname + ' '));
        li.appendChild(document.createTextNode(a.label + (a.away ? ' (' + a.away + 's)' : '')));
        ol.appendChild(li);
      });
    }
    socket.on('host', function (s) {
      syncClock(s);
      // Game sounds follow the phase.
      var key = s.status + ':' + s.phase + ':' + s.index;
      if (key !== hostKey) {
        if (s.status === 'lobby') sfx.music('lobby');
        else if (s.status === 'finished' || s.phase === 'podium') {
          sfx.music(null);
          sfx.play('fanfare');
        } else if (s.mode === 'player_paced') sfx.music('question');
        else if (s.phase === 'question') {
          sfx.play('start');
          sfx.music('question');
        } else if (s.phase === 'reveal') {
          sfx.music(null);
          sfx.play('reveal');
        } else if (s.phase === 'leaderboard') sfx.play('leaderboard');
        hostKey = key;
      }
      renderAlerts(s);
      if (s.status === 'lobby' && s.players > hostPlayers) sfx.play('join');
      hostPlayers = s.players;
      text('[data-players]', String(s.players));
      text('[data-progress]', s.status === 'lobby' ? 'Lobby' : s.status === 'finished' ? 'Finished' : s.mode === 'host_paced' ? 'Question ' + (s.index + 1) + ' of ' + s.total : 'Self-paced');
      var btn = function (name, on) {
        var b = $('[data-act="' + name + '"]');
        if (b) b.hidden = !on;
      };
      var running = s.status === 'running' || s.status === 'paused';
      btn('start', s.status === 'lobby');
      btn('next', s.mode === 'host_paced' && s.status === 'running');
      btn('pause', s.mode === 'host_paced' && s.status === 'running' && s.phase === 'question');
      btn('resume', s.status === 'paused');
      btn('end', running || s.status === 'lobby');
      var hostPaced = s.mode === 'host_paced' && running;
      btn('prev', hostPaced && (s.index > 0 || s.phase !== 'question'));
      btn('auto', hostPaced);
      var autoBtn = $('[data-act="auto"]');
      if (autoBtn) {
        autoBtn.setAttribute('aria-pressed', s.autoAdvance ? 'true' : 'false');
        autoBtn.textContent = s.autoAdvance ? 'Auto: on' : 'Auto: off';
        autoBtn.title = s.autoAdvance ? 'Moving on automatically — click to stop and control it yourself' : 'Click to move on automatically again';
      }
      $('[data-report]').hidden = s.status !== 'finished';
      var nextBtn = $('[data-act="next"]');
      if (nextBtn) nextBtn.textContent = s.phase === 'question' ? 'Show answer' : s.phase === 'reveal' ? 'Leaderboard' : s.index + 1 >= s.total ? 'Final results' : 'Next question';

      if (s.status === 'lobby') {
        show('lobby');
        var ul = $('[data-lobby]');
        ul.textContent = '';
        (s.allPlayers || []).forEach(function (p) {
          var li = el('li', 'group flex items-center gap-2 rounded-full bg-primary-50 py-1.5 pl-4 pr-1.5 text-sm font-semibold text-primary-900 dark:bg-primary-900/40 dark:text-primary-100', p.nickname);
          var k = el('button', 'grid h-6 w-6 place-items-center rounded-full text-primary-700 hover:bg-primary-100 dark:text-primary-200', '×');
          k.type = 'button';
          k.setAttribute('aria-label', 'Remove ' + p.nickname);
          k.addEventListener('click', function () {
            if (window.confirm('Remove ' + p.nickname + ' from the game?')) send('kick', { playerId: p.id });
          });
          li.appendChild(k);
          ul.appendChild(li);
        });
        $('[data-lobby-empty]').hidden = (s.allPlayers || []).length > 0;
        return;
      }

      if (s.mode === 'player_paced') {
        show(s.status === 'finished' ? 'leaderboard' : 'selfpaced');
        var pl = $('[data-progress-list]');
        pl.textContent = '';
        (s.allPlayers || []).forEach(function (p) {
          var li = el('li', 'flex items-center gap-3 px-6 py-2.5 text-sm');
          li.appendChild(el('span', 'h-2 w-2 rounded-full ' + (p.connected ? 'bg-emerald-500' : 'bg-slate-300')));
          li.appendChild(el('span', 'min-w-0 flex-1 truncate font-medium', p.nickname));
          if (p.flags) li.appendChild(el('span', 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700 dark:bg-red-950 dark:text-red-300', '⚠ ' + p.flags + (p.awaySec ? ' · ' + p.awaySec + 's away' : '')));
          li.appendChild(el('span', 'tabular-nums muted', p.finished ? 'Submitted ✓' : p.answered + ' of ' + s.total + ' answered'));
          pl.appendChild(li);
        });
        leaderboardList($('[data-lb2]'), s.leaderboard || []);
        var lbNote = $('[data-lb2-note]');
        if (lbNote) lbNote.textContent = (s.submitted || 0) + ' of ' + s.players + ' submitted. Scores and answers are revealed when the game ends — click End game when you are ready, or it ends by itself once everyone has submitted.';
        if (s.status === 'finished') renderBoard(s, true);
        return;
      }

      if (s.phase === 'question' || s.phase === 'reveal') {
        show('question');
        var q = s.question;
        text('[data-qnum]', 'Question ' + (s.index + 1) + ' of ' + s.total);
        setStem($('[data-stem]'), q ? q.stem_html : '');
        var box = $('[data-options]');
        box.textContent = '';
        var counts = (s.reveal && s.reveal.counts) || (s.live && s.live.counts) || {};
        var answered = (s.reveal ? s.reveal.answered : s.live && s.live.answered) || 0;
        var correct = s.reveal ? s.reveal.correct : [];
        if (q && q.options) {
          q.options.forEach(function (o, i) {
            var n = counts[o.key] || 0;
            var tile = el('div', 'relative overflow-hidden rounded-2xl p-4 text-lg font-semibold text-white shadow-card ' + TILE[i % TILE.length] + (s.reveal && correct.indexOf(o.key) < 0 ? ' opacity-35' : ''));
            var fill = el('div', 'absolute inset-y-0 left-0 bg-white/15');
            fill.style.width = (answered ? Math.round((n / answered) * 100) : 0) + '%';
            tile.appendChild(fill);
            var row = el('div', 'relative flex items-center gap-3');
            var body = el('div', 'min-w-0 flex-1');
            setStem(body, o.html);
            row.appendChild(body);
            row.appendChild(el('span', 'rounded-full bg-black/20 px-2.5 py-0.5 text-sm tabular-nums', (s.reveal && correct.indexOf(o.key) >= 0 ? '✓ ' : '') + n));
            tile.appendChild(row);
            box.appendChild(tile);
          });
        } else if (s.reveal && s.reveal.correctText) {
          box.appendChild(el('div', 'rounded-2xl bg-emerald-600 p-5 text-center text-2xl font-bold text-white sm:col-span-2', 'Answer: ' + s.reveal.correctText));
        }
        text('[data-answered]', answered + ' of ' + s.players + ' answered' + (s.reveal ? ' · ' + s.reveal.right + ' correct' : ''));
        var ex = $('[data-explain]');
        if (s.reveal && s.reveal.explanation_html) {
          ex.hidden = false;
          setStem(ex, s.reveal.explanation_html);
        } else ex.hidden = true;
        return;
      }
      renderBoard(s, s.phase === 'podium' || s.status === 'finished');
    });

    function renderBoard(s, final) {
      show('leaderboard');
      text('[data-lb-title]', final ? 'Final results' : 'Leaderboard');
      var podium = $('[data-podium]');
      podium.textContent = '';
      podium.hidden = !final;
      if (final) {
        var top = (s.leaderboard || []).slice(0, 3);
        [1, 0, 2].forEach(function (i) {
          var p = top[i];
          if (!p) return podium.appendChild(el('div'));
          var col = el('div', 'flex flex-col items-center');
          col.appendChild(el('span', 'text-4xl', ['🥇', '🥈', '🥉'][i]));
          col.appendChild(el('span', 'mt-1 max-w-full truncate font-bold', p.nickname));
          col.appendChild(el('span', 'font-mono text-sm tabular-nums muted', Number(p.score).toLocaleString('en')));
          var block = el('div', 'mt-2 w-full rounded-t-xl ' + ['bg-secondary-500', 'bg-primary-400', 'bg-primary-200'][i]);
          block.style.height = ['9rem', '6.5rem', '4.5rem'][i];
          col.appendChild(block);
          podium.appendChild(col);
        });
      }
      leaderboardList($('[data-lb]'), final ? (s.leaderboard || []).slice(3) : s.leaderboard || []);
    }
  }

  // ================================================================ Player
  if (play) {
    var psocket = window.io('/live', { auth: { session: Number(play.getAttribute('data-session')) }, withCredentials: true });
    var lastKey = null; // which question is on screen (keeps half-typed answers while state updates arrive)
    var playerKey = null; // last rendered phase, for sounds
    var sending = false;
    var mode = null;
    var current = 0;
    var total = 0;

    psocket.on('connect_error', function (err) {
      setError(err && err.message === 'join_first' ? 'Your place in this game has expired. Join again.' : 'Reconnecting…');
      if (err && err.message === 'join_first') window.location.href = '/play';
    });
    psocket.on('connect', function () {
      setError('');
    });
    psocket.on('kicked', function () {
      setError('The host removed you from this game.');
      show('wait');
      text('[data-wait-text]', 'The host removed you from this game.');
    });

    function emit(evt, payload, cb) {
      setError('');
      psocket.emit(evt, payload || {}, function (res) {
        if (!res || !res.ok) return setError((res && res.error) || 'Something went wrong. Try again.');
        if (cb) cb(res);
      });
    }

    function submit(response, index) {
      if (sending) return;
      sending = true;
      setError('');
      psocket.emit('answer', { index: index, response: response }, function (res) {
        sending = false;
        if (!res || !res.ok) return setError((res && res.error) || 'Could not send your answer.');
        if (navigator.vibrate) navigator.vibrate(25);
        sfx.play('locked'); // no right / wrong until the game ends
        lastKey = null; // the server moves us on; the next state renders the next question
      });
    }

    function rankText(me) {
      return me.rank ? 'You are #' + me.rank + ' of ' + me.of : '';
    }

    function renderQuestion(q, ownPace) {
      var key = q.index + ':' + q.type;
      show('question');
      text('[data-qnum]', 'Question ' + (q.index + 1) + ' of ' + q.total);
      var nav = $('[data-own-nav]');
      if (nav) nav.hidden = !ownPace;
      if (ownPace) {
        $('[data-nav-prev]').disabled = q.index <= 0;
        text('[data-nav-hint]', q.response ? 'Answer saved — you can change it until you submit.' : 'Answers are revealed when the game ends.');
      }
      if (key === lastKey) return;
      lastKey = key;
      sfx.play('start');
      setStem($('[data-stem]'), q.stem_html);
      var form = $('[data-answer-form]');
      form.textContent = '';
      form.onsubmit = function (e) {
        e.preventDefault();
      };
      var prev = q.response || {};
      if (q.options) {
        var multi = q.type === 'multiple_response';
        var picked = [].concat(prev.selected || []);
        var chosen = {};
        picked.forEach(function (k) {
          chosen[k] = true;
        });
        q.options.forEach(function (o, i) {
          var on = !!chosen[o.key];
          var b = el('button', 'tile min-h-[4.5rem] rounded-2xl p-4 text-left text-lg font-semibold text-white shadow-pop transition active:scale-[.98] ' + TILE[i % TILE.length] + (on ? ' ring-4 ring-white' : ''));
          b.type = 'button';
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          var inner = el('span', 'block');
          setStem(inner, o.html);
          b.appendChild(inner);
          b.addEventListener('click', function () {
            if (!multi) return submit({ selected: o.key }, q.index);
            chosen[o.key] = !chosen[o.key];
            b.classList.toggle('ring-4', !!chosen[o.key]);
            b.classList.toggle('ring-white', !!chosen[o.key]);
            b.setAttribute('aria-pressed', chosen[o.key] ? 'true' : 'false');
          });
          form.appendChild(b);
        });
        if (multi) {
          var go = el('button', 'rounded-2xl bg-white py-3 text-lg font-bold text-primary-900 sm:col-span-2', ownPace ? 'Save & next ▶' : 'Submit answer');
          go.type = 'button';
          go.addEventListener('click', function () {
            var sel = Object.keys(chosen).filter(function (k) {
              return chosen[k];
            });
            if (!sel.length) return setError('Choose at least one answer.');
            submit({ selected: sel }, q.index);
          });
          form.appendChild(go);
        }
      } else {
        var blanks = q.type === 'fill_blank' ? Math.max(1, (q.settings && q.settings.blanks) || 1) : 1;
        var inputs = [];
        for (var i = 0; i < blanks; i += 1) {
          var inp = el('input', 'w-full rounded-xl border-0 px-4 py-3 text-lg text-slate-900 sm:col-span-2');
          inp.setAttribute('aria-label', blanks > 1 ? 'Blank ' + (i + 1) : 'Your answer');
          inp.inputMode = q.type === 'numeric' ? 'decimal' : 'text';
          inp.autocomplete = 'off';
          inp.value = q.type === 'numeric' ? prev.value || '' : (prev.blanks || [])[i] || '';
          inputs.push(inp);
          form.appendChild(inp);
        }
        var send2 = el('button', 'rounded-2xl bg-secondary-500 py-3 text-lg font-bold text-primary-950 sm:col-span-2', ownPace ? 'Save & next ▶' : 'Submit answer');
        send2.type = 'submit';
        form.appendChild(send2);
        form.onsubmit = function (e) {
          e.preventDefault();
          var vals = inputs.map(function (x) {
            return x.value.trim();
          });
          if (!vals.join('')) return setError('Type your answer first.');
          submit(q.type === 'numeric' ? { value: vals[0] } : { blanks: vals }, q.index);
        };
        inputs[0].focus();
      }
    }

    // ---- Own pace: navigation, review & submit, results
    var navPrev = $('[data-nav-prev]');
    if (navPrev)
      navPrev.addEventListener('click', function () {
        if (current > 0) emit('goto', { index: current - 1 });
      });
    var navSkip = $('[data-nav-skip]');
    if (navSkip)
      navSkip.addEventListener('click', function () {
        emit('goto', { index: current + 1 });
      });
    var submitBtn = $('[data-submit-btn]');
    if (submitBtn)
      submitBtn.addEventListener('click', function () {
        var missing = submitBtn.getAttribute('data-missing');
        if (missing !== '0' && !window.confirm(missing + ' question(s) are not answered. Submit anyway?')) return;
        emit('submit', {}, function () {
          sfx.play('locked');
        });
      });

    function renderSubmit(me) {
      show('submit');
      var done = {};
      (me.answered || []).forEach(function (i) {
        done[i] = true;
      });
      var missing = me.total - (me.answered || []).length;
      text('[data-submit-summary]', (me.answered || []).length + ' of ' + me.total + ' answered' + (missing ? ' · ' + missing + ' left' : ' · all done!'));
      submitBtn.setAttribute('data-missing', String(missing));
      var grid = $('[data-submit-grid]');
      grid.textContent = '';
      for (var i = 0; i < me.total; i += 1) {
        (function (idx) {
          var b = el('button', 'grid h-11 w-11 place-items-center rounded-lg text-sm font-bold ' + (done[idx] ? 'bg-secondary-500 text-primary-950' : 'border-2 border-white/40 text-white'), String(idx + 1));
          b.type = 'button';
          b.setAttribute('aria-label', 'Question ' + (idx + 1) + (done[idx] ? ', answered' : ', not answered'));
          b.addEventListener('click', function () {
            emit('goto', { index: idx });
          });
          grid.appendChild(b);
        })(i);
      }
    }

    function renderResults(me, leaderboard) {
      show('final');
      text('[data-final-title]', me.rank === 1 ? 'You won!' : 'Game over');
      text('[data-final-emoji]', me.rank === 1 ? '🏆' : me.rank && me.rank <= 3 ? '🎉' : '🏁');
      var right = (me.results || []).filter(function (r) {
        return r.correct;
      }).length;
      text('[data-final-score]', Number(me.score || 0).toLocaleString('en') + ' points · ' + right + ' of ' + me.total + ' correct · ' + rankText(me));
      leaderboardList($('[data-final-lb]'), leaderboard || [], me.id, true);
      var wrap = $('[data-final-results-wrap]');
      var list = $('[data-final-results]');
      if (!wrap || !me.results) return;
      wrap.hidden = false;
      list.textContent = '';
      me.results.forEach(function (r) {
        var li = el('li', 'rounded-2xl bg-white/10 p-4');
        var head = el('div', 'flex items-center justify-between gap-3 text-sm');
        head.appendChild(el('span', 'font-semibold text-primary-100', 'Question ' + (r.index + 1)));
        head.appendChild(el('span', 'rounded-full px-3 py-0.5 font-bold ' + (r.correct ? 'bg-emerald-500/25 text-emerald-100' : r.response ? 'bg-red-500/25 text-red-100' : 'bg-white/15 text-white'), r.correct ? '✓ Correct +' + r.points : r.response ? '✗ Wrong' : '— Not answered'));
        li.appendChild(head);
        var stem = el('div', 'mt-2 font-semibold');
        setStem(stem, r.stem_html);
        li.appendChild(stem);
        var mine = [].concat((r.response && r.response.selected) || []);
        var keys = (r.answerKey && r.answerKey.correct) || [];
        if (r.options) {
          var ul = el('ul', 'mt-3 space-y-1.5');
          r.options.forEach(function (o) {
            var isMine = mine.indexOf(o.key) >= 0;
            var isRight = keys.indexOf(o.key) >= 0;
            var row = el('li', 'flex items-center gap-2 rounded-lg px-3 py-2 text-sm ' + (isRight ? 'bg-emerald-500/25' : isMine ? 'bg-red-500/25' : 'bg-white/5 text-primary-100'));
            var body = el('span', 'min-w-0 flex-1');
            setStem(body, o.html);
            row.appendChild(body);
            if (isMine) row.appendChild(el('span', 'text-xs font-semibold', 'Your answer'));
            if (isRight) row.appendChild(el('span', 'text-xs font-bold', '✓ Correct'));
            ul.appendChild(row);
          });
          li.appendChild(ul);
        } else {
          var given = r.response ? r.response.value || (r.response.blanks || []).join(' / ') : '';
          li.appendChild(el('p', 'mt-2 text-sm', 'Your answer: ' + (given || '—')));
          if (r.answerKey && r.answerKey.correctText) li.appendChild(el('p', 'text-sm font-semibold text-emerald-200', 'Correct answer: ' + r.answerKey.correctText));
        }
        if (r.answerKey && r.answerKey.explanation_html) {
          var ex = el('div', 'mt-3 rounded-lg bg-black/20 p-3 text-sm text-primary-100');
          setStem(ex, r.answerKey.explanation_html);
          li.appendChild(ex);
        }
        list.appendChild(li);
      });
    }

    // ---- Anti-cheat: report leaving, window switches, split screen, screenshots, devtools, copy/paste
    var guarding = false;
    var watching = false;
    function guard(s) {
      var me = s.me || {};
      guarding = (s.status === 'running' || s.status === 'paused') && !me.finished && !me.gameOver;
      if (!guarding || watching || !window.ExamplyIntegrity) return;
      watching = true;
      window.ExamplyIntegrity.watch({
        blockCopy: true,
        message: 'Leaving the game is reported to the host.',
        report: function (type, details) {
          if (!guarding) return;
          psocket.emit('integrity', { type: type, details: details }, function (res) {
            if (res && res.ok && res.autoSubmitted) setError('Your answers were submitted automatically because you left the game too many times.');
          });
        },
      });
    }

    psocket.on('state', function (s) {
      guard(s);
      mode = s.mode;
      syncClock(s);
      var me = s.me || {};
      var key = s.status + ':' + s.phase + ':' + s.index + ':' + (me.finished ? 'done' : '') + ':' + (me.gameOver ? 'over' : '');
      var changed = key !== playerKey;
      playerKey = key;
      var ownPace = s.mode === 'player_paced';
      var scorePill = $('[data-me-score]');
      if (scorePill) scorePill.hidden = ownPace && !me.gameOver;
      if (!ownPace || me.gameOver) text('[data-me-score]', Number(me.score || 0).toLocaleString('en'));

      // -------- Own pace
      if (ownPace) {
        total = me.total || 0;
        if (me.gameOver) {
          if (changed) {
            sfx.music(null);
            sfx.play(me.rank && me.rank <= 3 ? 'fanfare' : 'end');
          }
          return renderResults(me, s.leaderboard);
        }
        if (s.status === 'lobby') {
          sfx.music('lobby');
          show('wait');
          text('[data-wait-text]', s.players + ' player' + (s.players === 1 ? '' : 's') + ' in the lobby. Waiting for the host to start…');
          return;
        }
        sfx.music(null);
        if (me.finished) {
          show('waiting');
          text('[data-waiting-count]', me.submittedCount + ' of ' + s.players + ' players have submitted.');
          return;
        }
        if (me.atReview) {
          current = total;
          lastKey = null;
          return renderSubmit(me);
        }
        if (me.question) {
          current = me.question.index;
          renderQuestion(me.question, true);
        }
        return;
      }

      // -------- Presenter-paced (everyone together)
      if (s.status === 'finished' || s.phase === 'podium') {
        if (changed) {
          sfx.music(null);
          sfx.play(me.rank && me.rank <= 3 ? 'fanfare' : 'end');
        }
        show('final');
        text('[data-final-title]', me.rank === 1 ? 'You won!' : 'Game over');
        text('[data-final-emoji]', me.rank === 1 ? '🏆' : me.rank && me.rank <= 3 ? '🎉' : '🏁');
        text('[data-final-score]', Number(me.score || 0).toLocaleString('en') + ' points · ' + rankText(me));
        leaderboardList($('[data-final-lb]'), s.leaderboard || [], me.id, true);
        return;
      }
      if (s.status === 'lobby') {
        sfx.music('lobby');
        show('wait');
        text('[data-wait-text]', s.players + ' player' + (s.players === 1 ? '' : 's') + ' in the lobby. Waiting for the host to start…');
        return;
      }
      sfx.music(null);
      if (s.status === 'paused') {
        show('wait');
        text('[data-wait-text]', 'The host paused the game.');
        return;
      }
      if (s.phase === 'question') {
        if (me.answeredCurrent) {
          show('locked');
          lastKey = null;
        } else if (s.question) renderQuestion(s.question, false);
        return;
      }
      lastKey = null;
      var last = me.last && s.index >= 0 ? me.last : null;
      var right = last && last.correct;
      var timedOut = !me.answeredCurrent && s.phase === 'reveal';
      if (changed && s.phase === 'reveal') sfx.play(right ? 'correct' : 'wrong');
      if (changed && s.phase === 'leaderboard') sfx.play('leaderboard');
      show('result');
      text('[data-result-emoji]', timedOut ? '⌛' : right ? '✅' : '❌');
      text('[data-result-title]', timedOut ? "Time's up" : right ? 'Correct!' : 'Not this time');
      text('[data-result-points]', right ? '+' + last.points + ' points' + (me.streak > 1 ? ' · 🔥 streak ' + me.streak : '') : 'Keep going — the next one is yours.');
      text('[data-result-rank]', rankText(me));
    });
  }
})();
