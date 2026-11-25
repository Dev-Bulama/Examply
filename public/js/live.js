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
      if (host) c.hidden = true;
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
          li.appendChild(el('span', 'tabular-nums muted', p.finished ? 'Finished' : 'Q' + Math.min(p.progress + 1, s.total) + ' of ' + s.total));
          pl.appendChild(li);
        });
        leaderboardList($('[data-lb2]'), s.leaderboard || []);
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
    var lastKey = null;
    var sending = false;
    var mode = null;
    var lastState = null;
    var feedbackUntil = 0;
    var reviewing = null; // index being reviewed (self-paced)
    var current = 0; // the player's current question index (self-paced)
    var playerKey = null;

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

    function submit(response, index) {
      if (sending) return;
      sending = true;
      setError('');
      psocket.emit('answer', { index: index, response: response }, function (res) {
        sending = false;
        if (!res || !res.ok) return setError((res && res.error) || 'Could not send your answer.');
        if (navigator.vibrate) navigator.vibrate(res.correct ? 40 : [30, 60, 30]);
        if (mode === 'player_paced') {
          // Quick feedback, then the next question appears by itself.
          sfx.play(res.correct ? 'correct' : 'wrong');
          showResult(res.correct, res.points, res.streak, null);
          feedbackUntil = Date.now() + 1600;
          setTimeout(function () {
            if (lastState && reviewing === null) renderState(lastState);
          }, 1650);
        } else sfx.play('locked');
      });
    }

    function showResult(right, points, streak, me, timedOut) {
      show('result');
      text('[data-result-emoji]', timedOut ? '⌛' : right ? '✅' : '❌');
      text('[data-result-title]', timedOut ? "Time's up" : right ? 'Correct!' : 'Not this time');
      text('[data-result-points]', right ? '+' + points + ' points' + (streak > 1 ? ' · 🔥 streak ' + streak : '') : 'Keep going — the next one is yours.');
      text('[data-result-rank]', me ? rankText(me) : '');
    }

    // ---- Self-paced: look back at answered questions (read-only)
    function openReview(index) {
      reviewing = index;
      psocket.emit('review', { index: index }, function (res) {
        if (!res || !res.ok) {
          reviewing = null;
          return setError((res && res.error) || 'Could not open that question.');
        }
        var r = res.review;
        show('review');
        text('[data-review-num]', 'Question ' + (index + 1) + ' of ' + r.question.total + ' (already answered)');
        var badge = $('[data-review-result]');
        badge.textContent = r.correct ? '✅ +' + r.points : '❌ 0';
        badge.className = 'rounded-full px-3 py-1 font-semibold ' + (r.correct ? 'bg-emerald-500/20 text-emerald-100' : 'bg-red-500/20 text-red-100');
        setStem($('[data-review-stem]'), r.question.stem_html);
        var ul = $('[data-review-options]');
        ul.textContent = '';
        var mine = [].concat((r.response && r.response.selected) || []);
        var keys = (r.answerKey && r.answerKey.correct) || [];
        (r.question.options || []).forEach(function (o, i) {
          var isMine = mine.indexOf(o.key) >= 0;
          var isRight = keys.indexOf(o.key) >= 0;
          var li = el('li', 'flex items-center gap-3 rounded-xl p-3 text-white ' + TILE[i % TILE.length] + (isMine || isRight ? '' : ' opacity-50'));
          var body = el('span', 'min-w-0 flex-1');
          setStem(body, o.html);
          li.appendChild(body);
          if (isMine) li.appendChild(el('span', 'rounded-full bg-black/25 px-2 py-0.5 text-xs font-semibold', 'Your answer'));
          if (isRight) li.appendChild(el('span', 'rounded-full bg-white/25 px-2 py-0.5 text-xs font-semibold', '✓ Correct'));
          ul.appendChild(li);
        });
        var t = '';
        if (!r.question.options && r.response) t = 'Your answer: ' + (r.response.value || (r.response.blanks || []).join(' / '));
        if (r.answerKey && r.answerKey.correctText) t += (t ? ' · ' : '') + 'Correct answer: ' + r.answerKey.correctText;
        text('[data-review-text]', t);
        var ex = $('[data-review-explain]');
        if (r.answerKey && r.answerKey.explanation_html) {
          ex.hidden = false;
          setStem(ex, r.answerKey.explanation_html);
        } else ex.hidden = true;
        $('[data-review-prev]').disabled = index <= 0;
        $('[data-review-prev]').classList.toggle('opacity-40', index <= 0);
        $('[data-review-next]').hidden = index + 1 >= current;
      });
    }
    var prevBtn = $('[data-prev]');
    if (prevBtn)
      prevBtn.addEventListener('click', function () {
        if (current > 0) openReview(current - 1);
      });
    $('[data-review-prev]').addEventListener('click', function () {
      if (reviewing > 0) openReview(reviewing - 1);
    });
    $('[data-review-next]').addEventListener('click', function () {
      if (reviewing + 1 < current) openReview(reviewing + 1);
    });
    $('[data-review-back]').addEventListener('click', function () {
      reviewing = null;
      lastKey = null;
      if (lastState) renderState(lastState);
    });

    function renderQuestion(q) {
      var key = q.index + ':' + q.type;
      show('question');
      text('[data-qnum]', 'Question ' + (q.index + 1) + ' of ' + q.total);
      if (prevBtn) prevBtn.hidden = !(mode === 'player_paced' && q.index > 0);
      if (key === lastKey) return; // keep any half-typed answer
      lastKey = key;
      sfx.play('start');
      setStem($('[data-stem]'), q.stem_html);
      var form = $('[data-answer-form]');
      form.textContent = '';
      form.onsubmit = function (e) {
        e.preventDefault();
      };
      if (q.options) {
        var multi = q.type === 'multiple_response';
        var chosen = {};
        q.options.forEach(function (o, i) {
          var b = el('button', 'tile min-h-[4.5rem] rounded-2xl p-4 text-left text-lg font-semibold text-white shadow-pop transition active:scale-[.98] ' + TILE[i % TILE.length]);
          b.type = 'button';
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
          var go = el('button', 'rounded-2xl bg-white py-3 text-lg font-bold text-primary-900 sm:col-span-2', 'Submit answer');
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
          inputs.push(inp);
          form.appendChild(inp);
        }
        var send2 = el('button', 'rounded-2xl bg-secondary-500 py-3 text-lg font-bold text-primary-950 sm:col-span-2', 'Submit answer');
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

    function rankText(me) {
      return me.rank ? 'You are #' + me.rank + ' of ' + me.of : '';
    }

    psocket.on('state', function (s) {
      lastState = s;
      mode = s.mode;
      syncClock(s);
      if (s.me && s.me.question) current = s.me.question.index;
      else if (s.me && s.me.finished) current = s.total;
      if (reviewing !== null && s.status !== 'finished') return; // let the player finish looking back
      if (Date.now() < feedbackUntil && s.mode === 'player_paced' && !(s.me && s.me.finished)) return; // feedback first
      renderState(s);
    });

    function renderState(s) {
      var me = s.me || {};
      var key = s.status + ':' + s.phase + ':' + s.index + ':' + (me.finished ? 'done' : '');
      var changed = key !== playerKey;
      playerKey = key;
      text('[data-me-score]', Number(me.score || 0).toLocaleString('en'));
      if (s.status === 'finished' || s.phase === 'podium' || me.finished) {
        if (changed) {
          sfx.music(null);
          sfx.play(me.rank && me.rank <= 3 ? 'fanfare' : 'end');
        }
        show('final');
        var finished = s.status === 'finished' || s.phase === 'podium';
        text('[data-final-title]', finished ? (me.rank === 1 ? 'You won!' : 'Game over') : 'All done!');
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
      if (s.mode === 'player_paced') {
        if (me.question) renderQuestion(me.question);
        return;
      }
      if (s.status === 'paused') {
        show('wait');
        text('[data-wait-text]', 'The host paused the game.');
        return;
      }
      if (s.phase === 'question') {
        if (me.answeredCurrent) {
          show('locked');
          lastKey = null;
        } else if (s.question) renderQuestion(s.question);
        return;
      }
      lastKey = null;
      // reveal / leaderboard
      var last = me.last && s.index >= 0 ? me.last : null;
      var right = last && last.correct;
      var timedOut = !me.answeredCurrent && s.phase === 'reveal';
      if (changed && s.phase === 'reveal') sfx.play(right ? 'correct' : 'wrong');
      if (changed && s.phase === 'leaderboard') sfx.play('leaderboard');
      showResult(right, last ? last.points : 0, me.streak, me, timedOut);
    }
  }
})();
