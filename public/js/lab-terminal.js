/* Lab terminal: xterm.js front end for the server-side lab machine. One command per request; the server keeps
   the machine, so a refresh or another device resumes where the candidate left off. */
(function () {
  'use strict';

  function TerminalClass() {
    var T = window.Terminal;
    return T && T.Terminal ? T.Terminal : T;
  }

  function setup(el) {
    var url = el.getAttribute('data-lab-url');
    var wrap = el.closest('.grid') || el.parentNode;
    var statusEl = wrap.querySelector('[data-lab-status]');
    var tasksEl = wrap.querySelector('[data-lab-tasks]');
    var resetBtn = wrap.querySelector('[data-lab-reset]');
    var Term = TerminalClass();
    if (!url || !Term) {
      if (statusEl) statusEl.textContent = url ? 'Terminal unavailable' : 'Preview';
      return;
    }
    var dark = { background: '#0b1020', foreground: '#e2e8f0', cursor: '#38bdf8', selectionBackground: '#334155', green: '#4ade80', red: '#f87171', yellow: '#facc15', blue: '#60a5fa' };
    var term = new Term({ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: window.innerWidth < 640 ? 12 : 14, cursorBlink: true, convertEol: true, scrollback: 2000, theme: dark });
    term.open(el);
    fitTo(term, el);
    // Questions start hidden in the player, so refit whenever the box is shown or resized.
    if (window.ResizeObserver) {
      new window.ResizeObserver(function () {
        fitTo(term, el);
      }).observe(el);
    } else {
      window.addEventListener('resize', function () {
        fitTo(term, el);
      });
    }

    var line = '';
    var cursor = 0;
    var prompt = '';
    var busy = false;
    var history = [];
    var hIndex = 0;
    var status = function (t) {
      if (statusEl) statusEl.textContent = t;
    };
    var write = function (t) {
      term.write(String(t || ''));
    };
    var redraw = function () {
      term.write('\r\x1b[K' + prompt + line);
      var back = line.length - cursor;
      if (back > 0) term.write('\x1b[' + back + 'D');
    };
    var markTasks = function (tasks) {
      if (!tasks || !tasksEl) return;
      tasks.forEach(function (t) {
        var li = tasksEl.querySelector('[data-task="' + t.id + '"] [data-task-mark]');
        if (!li) return;
        li.textContent = t.passed ? '✓' : li.getAttribute('data-n') || li.textContent;
        li.className = 'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ' + (t.passed ? 'bg-emerald-500 text-white' : 'border border-slate-300 dark:border-slate-600');
      });
    };
    var send = function (body) {
      busy = true;
      return window.App.api(url, { method: 'POST', body: body })
        .then(function (r) {
          status('Connected');
          if (r.replay !== undefined) {
            term.reset();
            write(r.replay);
          }
          if (r.output) write(r.output);
          if (r.output === '\u001b[2J\u001b[H') term.clear();
          prompt = r.prompt || prompt;
          markTasks(r.tasks);
          write(prompt);
          if (body.command) el.dispatchEvent(new CustomEvent('answer-changed', { bubbles: true }));
        })
        .catch(function (err) {
          status(navigator.onLine ? 'Error' : 'Offline');
          write('\x1b[31m' + (navigator.onLine ? err.message : 'You are offline. Reconnect and press Enter to continue.') + '\x1b[0m\r\n' + prompt);
        })
        .finally(function () {
          busy = false;
        });
    };

    term.onData(function (data) {
      if (busy) return;
      for (var i = 0; i < data.length; i += 1) {
        var ch = data[i];
        var code = ch.charCodeAt(0);
        if (ch === '\x1b') {
          var seq = data.slice(i, i + 3);
          if (seq === '\x1b[A' || seq === '\x1b[B') {
            if (history.length) {
              hIndex = Math.max(0, Math.min(history.length, hIndex + (seq === '\x1b[A' ? -1 : 1)));
              line = history[hIndex] || '';
              cursor = line.length;
              redraw();
            }
          } else if (seq === '\x1b[D' && cursor > 0) {
            cursor -= 1;
            write(seq);
          } else if (seq === '\x1b[C' && cursor < line.length) {
            cursor += 1;
            write(seq);
          }
          i += 2;
        } else if (ch === '\r') {
          var cmd = line;
          write('\r\n');
          line = '';
          cursor = 0;
          if (cmd.trim()) {
            history.push(cmd);
            if (history.length > 200) history.shift();
          }
          hIndex = history.length;
          if (!cmd.trim()) {
            write(prompt);
            return;
          }
          if (cmd.trim() === 'clear') {
            term.clear();
          }
          send({ command: cmd });
          return;
        } else if (code === 127 || code === 8) {
          if (cursor > 0) {
            line = line.slice(0, cursor - 1) + line.slice(cursor);
            cursor -= 1;
            redraw();
          }
        } else if (code === 3) {
          write('^C\r\n' + prompt);
          line = '';
          cursor = 0;
        } else if (code === 12) {
          term.clear();
        } else if (code === 21) {
          line = '';
          cursor = 0;
          redraw();
        } else if (code >= 32) {
          line = line.slice(0, cursor) + ch + line.slice(cursor);
          cursor += 1;
          if (cursor === line.length) write(ch);
          else redraw();
        }
      }
    });
    // Keep typing inside the terminal from triggering exam keyboard shortcuts or autosave.
    el.addEventListener('keydown', function (e) {
      e.stopPropagation();
    });
    ['input', 'change'].forEach(function (t) {
      el.addEventListener(t, function (e) {
        e.stopPropagation();
      });
    });
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        if (window.confirm('Reset the machine to its starting state?')) send({ reset: true });
      });
    }
    status('Connecting…');
    send({ init: true });
    el.addEventListener('click', function () {
      term.focus();
    });
  }

  /** Sizes the terminal to its box (no fit addon needed). */
  function fitTo(term, el) {
    if (!el.clientWidth || !el.clientHeight) return; // hidden: wait until shown
    var cellW = term._core && term._core._renderService && term._core._renderService.dimensions ? term._core._renderService.dimensions.css.cell.width : 8.4;
    var cellH = term._core && term._core._renderService && term._core._renderService.dimensions ? term._core._renderService.dimensions.css.cell.height : 17;
    var cols = Math.max(20, Math.floor((el.clientWidth - 8) / (cellW || 8.4)));
    var rows = Math.max(10, Math.floor((el.clientHeight - 8) / (cellH || 17)));
    try {
      term.resize(cols, rows);
    } catch (e) {
      /* ignore */
    }
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('.lab-terminal'), setup);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
