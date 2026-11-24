/* Question rendering helpers shared by the admin preview and the exam player:
   KaTeX maths, highlight.js code, ordering and essay word-count components. */
(function () {
  'use strict';

  function enhance(root) {
    if (window.renderMathInElement) {
      root.querySelectorAll('.q-content').forEach(function (el) {
        try {
          window.renderMathInElement(el, {
            delimiters: [
              { left: '\\[', right: '\\]', display: true },
              { left: '$$', right: '$$', display: true },
              { left: '\\(', right: '\\)', display: false },
            ],
            throwOnError: false,
          });
        } catch (e) {
          /* keep raw LaTeX */
        }
      });
    }
    if (window.hljs) {
      root.querySelectorAll('.q-content pre code').forEach(function (el) {
        if (!el.dataset.highlighted) window.hljs.highlightElement(el);
      });
    }
  }
  window.QuestionRender = { enhance: enhance };

  document.addEventListener('alpine:init', function () {
    var Alpine = window.Alpine;

    /* Ordering: server renders the items; this moves the real <li> nodes (no x-html in the CSP build). */
    Alpine.data('orderInput', function () {
      return {
        dragged: null,
        lis: function () {
          return Array.prototype.slice.call(this.$root.querySelectorAll('[data-order-item]'));
        },
        renumber: function (silent) {
          var list = this.lis();
          list.forEach(function (li, i) {
            li.querySelector('[data-order-pos]').textContent = String(i + 1);
            var up = li.querySelector('[data-dir="up"]');
            var down = li.querySelector('[data-dir="down"]');
            if (up && !up.hasAttribute('data-locked')) up.disabled = i === 0;
            if (down && !down.hasAttribute('data-locked')) down.disabled = i === list.length - 1;
          });
          if (!silent) this.$dispatch('answer-changed');
        },
        init: function () {
          var self = this;
          if (this.$root.querySelector('button[disabled]') && this.$root.querySelectorAll('button[disabled]').length === this.$root.querySelectorAll('button').length) {
            this.$root.querySelectorAll('button').forEach(function (b) {
              b.setAttribute('data-locked', '1');
            });
          }
          this.$nextTick(function () {
            self.renumber(true);
          });
        },
        up: function (e) {
          var li = e.currentTarget.closest('[data-order-item]');
          if (li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
          this.renumber();
          e.currentTarget.focus();
        },
        down: function (e) {
          var li = e.currentTarget.closest('[data-order-item]');
          if (li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
          this.renumber();
          e.currentTarget.focus();
        },
        drag: function (e) {
          this.dragged = e.currentTarget;
        },
        drop: function (e) {
          var target = e.currentTarget;
          if (!this.dragged || this.dragged === target) return;
          var list = this.lis();
          if (list.indexOf(this.dragged) < list.indexOf(target)) target.parentNode.insertBefore(this.dragged, target.nextSibling);
          else target.parentNode.insertBefore(this.dragged, target);
          this.dragged = null;
          this.renumber();
        },
      };
    });

    Alpine.data('wordCount', function () {
      return {
        words: 0,
        init: function () {
          this.count();
        },
        count: function () {
          var t = (this.$refs.area && this.$refs.area.value) || '';
          this.words = t.trim() ? t.trim().split(/\s+/).length : 0;
        },
      };
    });
  });

  document.addEventListener('DOMContentLoaded', function () {
    enhance(document);
  });
})();

/* SQL lab (candidate view): run SQL on the server's sandboxed copy of the dataset and show the result. */
(function () {
  'use strict';
  document.addEventListener('alpine:init', function () {
    window.Alpine.data('sqlLab', function () {
      return {
        tables: [],
        cols: [],
        rows: [],
        error: '',
        verdict: '',
        good: false,
        busy: false,
        info: '',
        loaded: false,
        url: function () {
          return this.$root.dataset.run;
        },
        init: function () {
          var self = this;
          if (!this.url()) {
            this.loaded = true;
            return;
          }
          window.App.api(this.url(), { method: 'POST', body: { describe: true } })
            .then(function (r) {
              self.tables = (r.schema && r.schema.tables) || [];
            })
            .catch(function () {
              /* the schema SQL below is still available */
            })
            .finally(function () {
              self.loaded = true;
            });
        },
        schemaNote: function () {
          if (!this.url()) return 'Run is available during the exam.';
          return this.loaded ? 'See the schema below.' : 'Loading…';
        },
        canCheck: function () {
          return this.$root.dataset.check === '1';
        },
        cell: function (v) {
          return v === null ? 'NULL' : String(v);
        },
        status: function () {
          if (this.busy) return 'Running…';
          return this.info;
        },
        verdictClass: function () {
          return this.good ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300';
        },
        keys: function (e) {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            this.run();
          } else if (e.key === 'Tab' && !e.shiftKey) {
            // Indent instead of leaving the editor; Shift+Tab or Esc then Tab still moves focus.
            var ta = e.target;
            if (ta.dataset.escaped === '1') {
              ta.dataset.escaped = '';
              return;
            }
            e.preventDefault();
            var s = ta.selectionStart;
            ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
            ta.selectionStart = ta.selectionEnd = s + 2;
          } else if (e.key === 'Escape') {
            e.target.dataset.escaped = '1';
          }
        },
        insertColumn: function (e) {
          var ta = this.$refs.editor;
          var name = e.currentTarget.dataset.col;
          var s = ta.selectionStart;
          ta.value = ta.value.slice(0, s) + name + ta.value.slice(ta.selectionEnd);
          ta.focus();
          ta.selectionStart = ta.selectionEnd = s + name.length;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        },
        send: function (check) {
          var self = this;
          if (!this.url()) {
            this.info = 'Running SQL is available during the exam.';
            return;
          }
          this.busy = true;
          this.error = '';
          if (!check) this.verdict = '';
          window.App.api(this.url(), { method: 'POST', body: { sql: this.$refs.editor.value, check: !!check } })
            .then(function (r) {
              var run = r.run;
              self.cols = run.ok && run.result ? run.result.columns : [];
              self.rows = run.ok && run.result ? run.result.rows : [];
              self.error = run.ok ? '' : run.error;
              if (run.ok && run.result) {
                self.info = run.result.columns.length ? run.result.rowCount + ' row(s)' + (run.result.truncated ? ', first 200 shown' : '') + ' · ' + run.ms + ' ms' : run.result.changes + ' row(s) changed · ' + run.ms + ' ms (changes are discarded after each run)';
              } else self.info = '';
              if (r.check) {
                self.good = r.check.correct;
                self.verdict = r.check.correct ? 'Correct — your query returns the expected result.' : 'Not yet: ' + (r.check.reason || 'the result differs from the expected result.');
              }
            })
            .catch(function (err) {
              self.error = navigator.onLine ? err.message : 'You are offline. Your SQL is kept and will be saved when you reconnect; run it again then.';
            })
            .finally(function () {
              self.busy = false;
            });
        },
        run: function () {
          this.send(false);
        },
        check: function () {
          this.send(true);
        },
      };
    });
  });
})();
