/* Skillscore Assess — admin components (Alpine CSP build: registered here, referenced by name in templates). */
(function () {
  'use strict';

  var uid = 0;
  function nextUid() {
    uid += 1;
    return 'u' + uid;
  }
  function readJson(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  }
  function swap(arr, i, j) {
    if (j < 0 || j >= arr.length) return;
    var t = arr[i];
    arr.splice(i, 1);
    arr.splice(j, 0, t);
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function upload(url, file) {
    var fd = new FormData();
    fd.append('file', file);
    return window.App.api(url, { method: 'POST', body: fd });
  }
  function renderMath(el) {
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(el, { delimiters: [{ left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }, { left: '$$', right: '$$', display: true }], throwOnError: false });
      } catch (e) {
        /* leave the raw LaTeX visible */
      }
    }
  }

  document.addEventListener('alpine:init', function () {
    var Alpine = window.Alpine;

    /* ---------------- Certification domains repeater ---------------- */
    Alpine.data('domainEditor', function () {
      return {
        rows: [],
        init: function () {
          var data = [];
          try {
            data = JSON.parse(this.$el.dataset.domains || '[]');
          } catch (e) {
            data = [];
          }
          this.rows = data.map(function (d) {
            return Object.assign({ uid: nextUid() }, d);
          });
        },
        add: function () {
          this.rows.push({ uid: nextUid(), id: null, code: '', name: '', weight: 0, questions: 0 });
        },
        remove: function (i) {
          this.rows.splice(i, 1);
        },
        up: function (i) {
          swap(this.rows, i, i - 1);
        },
        down: function (i) {
          swap(this.rows, i, i + 1);
        },
        total: function () {
          var t = this.rows.reduce(function (s, r) {
            return s + (Number(r.weight) || 0);
          }, 0);
          return Math.round(t * 100) / 100;
        },
        totalClass: function () {
          var t = this.total();
          if (!this.rows.length) return 'muted';
          return t === 100 ? 'text-emerald-600 dark:text-emerald-400' : t > 100 ? 'text-red-600' : 'text-amber-600';
        },
      };
    });

    /* ---------------- AI generator: certification → domains ---------------- */
    Alpine.data('aiForm', function () {
      return {
        certs: [],
        certId: '',
        init: function () {
          try {
            this.certs = JSON.parse(this.$el.dataset.certs || '[]');
          } catch (e) {
            this.certs = [];
          }
          this.certId = this.$el.dataset.cert || '';
        },
        domains: function () {
          var id = String(this.certId);
          var c = this.certs.find(function (x) {
            return String(x.id) === id;
          });
          return c ? c.domains : [];
        },
      };
    });

    /* ---------------- Background progress (imports / AI generation) ---------------- */
    Alpine.data('importProgress', function () {
      return {
        pct: 3,
        label: 'Starting…',
        timer: null,
        init: function () {
          var self = this;
          var url = this.$el.dataset.url;
          var initial = this.$el.dataset.status;
          var tick = function () {
            fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
              .then(function (r) {
                return r.json();
              })
              .then(function (s) {
                if (s.status !== initial || s.status === 'completed' || s.status === 'failed') {
                  window.location.reload();
                  return;
                }
                if (s.status === 'importing') {
                  self.pct = Math.max(3, s.progress);
                  self.label = s.processed + ' of ' + s.total_rows + ' rows processed';
                } else {
                  self.pct = Math.max(self.pct, s.parse_progress || 5);
                  self.label = s.status === 'parsing' ? 'Checking every row…' : 'Queued — starting shortly…';
                }
                self.timer = setTimeout(tick, 1500);
              })
              .catch(function () {
                self.label = 'Connection lost — retrying…';
                self.timer = setTimeout(tick, 4000);
              });
          };
          tick();
        },
        destroy: function () {
          clearTimeout(this.timer);
        },
      };
    });

    /* ---------------- Bulk selection on list pages ---------------- */
    Alpine.data('bulkSelect', function () {
      return {
        selected: 0,
        action: '',
        boxes: function () {
          return Array.prototype.slice.call(this.$root.querySelectorAll('input[name="' + (this.$root.dataset.box || 'ids') + '"]'));
        },
        sync: function () {
          this.selected = this.boxes().filter(function (b) {
            return b.checked;
          }).length;
        },
        count: function () {
          return this.selected;
        },
        allChecked: function () {
          var b = this.boxes();
          return b.length > 0 && this.selected === b.length;
        },
        toggleAll: function (e) {
          var on = e.target.checked;
          this.boxes().forEach(function (b) {
            b.checked = on;
          });
          this.sync();
        },
        confirmIfDelete: function (e) {
          if (this.action === 'delete' && !window.confirm('Delete ' + this.selected + ' question(s)? They move to the recycle bin.')) e.preventDefault();
        },
      };
    });

    /* ---------------- Rich-text editor (contenteditable + sanitised server-side) ---------------- */
    Alpine.data('richEditor', function () {
      return {
        source: false,
        uploading: false,
        name: '',
        init: function () {
          this.name = this.$el.dataset.name;
          this.$refs.area.innerHTML = this.$refs.field.value;
          this.emit();
        },
        focus: function () {
          this.$refs.area.focus();
        },
        sync: function () {
          var html = this.$refs.area.innerHTML;
          if (html === '<br>' || html === '<div><br></div>' || html === '<p><br></p>') html = '';
          this.$refs.field.value = html;
          this.emit();
        },
        emit: function () {
          this.$dispatch('rich-changed', { name: this.name, html: this.$refs.field.value });
        },
        cmd: function (c, v) {
          this.$refs.area.focus();
          document.execCommand(c, false, v || null);
          this.sync();
        },
        insert: function (html) {
          this.$refs.area.focus();
          document.execCommand('insertHTML', false, html);
          this.sync();
        },
        selectedText: function () {
          var s = window.getSelection();
          return s && s.rangeCount ? s.toString() : '';
        },
        inlineCode: function () {
          var t = this.selectedText() || 'code';
          this.insert('<code>' + escapeHtml(t) + '</code>&nbsp;');
        },
        codeBlock: function () {
          var t = this.selectedText() || 'SELECT * FROM employees;';
          this.insert('<pre><code>' + escapeHtml(t) + '</code></pre><p><br></p>');
        },
        math: function () {
          var t = this.selectedText() || 'x^2 + y^2 = z^2';
          this.insert('\\(' + escapeHtml(t) + '\\)&nbsp;');
        },
        table: function () {
          this.insert('<table><thead><tr><th>Heading</th><th>Heading</th></tr></thead><tbody><tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr></tbody></table><p><br></p>');
        },
        link: function () {
          var url = window.prompt('Link address (https://…)');
          if (url && /^https?:\/\//i.test(url)) this.cmd('createLink', url);
        },
        blank: function () {
          var used = (this.$refs.field.value.match(/\[\[(\d{1,2})\]\]/g) || []).map(function (m) {
            return Number(m.replace(/\D/g, ''));
          });
          var n = used.length ? Math.max.apply(null, used) + 1 : 1;
          this.insert(' [[' + n + ']] ');
        },
        uploadFile: function (file) {
          var self = this;
          if (!file) return;
          self.uploading = true;
          upload(self.$el.dataset.upload, file)
            .then(function (r) {
              self.insert('<img src="' + r.url + '" alt="">');
            })
            .catch(function (err) {
              window.App.toast(err.message, 'danger');
            })
            .finally(function () {
              self.uploading = false;
            });
        },
        image: function (e) {
          this.uploadFile(e.target.files[0]);
          e.target.value = '';
        },
        paste: function (e) {
          var items = (e.clipboardData && e.clipboardData.files) || [];
          if (items.length && /^image\//.test(items[0].type)) {
            e.preventDefault();
            this.uploadFile(items[0]);
          }
        },
        toggleSource: function () {
          if (this.source) {
            this.$refs.area.innerHTML = this.$refs.src.value;
            this.sync();
          } else {
            this.$refs.src.value = this.$refs.field.value;
          }
          this.source = !this.source;
        },
        fromSource: function () {
          this.$refs.field.value = this.$refs.src.value;
          this.emit();
        },
      };
    });

    /* ---------------- Question editor (type-specific answer model) ---------------- */
    Alpine.data('questionEditor', function () {
      var data = readJson('question-editor-data') || { model: {}, certifications: [] };
      var m = JSON.parse(JSON.stringify(data.model));
      // Editor-only fields (uids for keyed loops, joined text for list inputs).
      (m.options || []).forEach(function (o) {
        o.uid = nextUid();
        o.showFeedback = false;
      });
      (m.pairs || []).forEach(function (p) {
        p.uid = nextUid();
      });
      m.distractors = (m.distractors || []).map(function (d) {
        return { uid: nextUid(), text: d };
      });
      m.items = (m.items || []).map(function (t) {
        return { uid: nextUid(), text: t };
      });
      (m.blanks || []).forEach(function (b) {
        b.text = (b.variants || []).join(' | ');
      });
      (m.keywords || []).forEach(function (k) {
        k.uid = nextUid();
        k.text = (k.terms || []).join(' | ');
      });
      (m.regions || []).forEach(function (r) {
        r.uid = nextUid();
      });

      return {
        m: m,
        certs: data.certifications,
        certId: data.certification_id ? String(data.certification_id) : '',
        domainId: data.domain_id ? String(data.domain_id) : '',
        uploading: false,
        draft: null,
        start: null,
        init: function () {
          var self = this;
          window.addEventListener('rich-changed', function (e) {
            if (e.detail.name === 'stem_html') self.onStem(e.detail.html);
          });
        },
        letter: function (i) {
          return 'ABCDEFGHIJKL'.charAt(i);
        },
        isCert: function (c) {
          return String(c.id) === String(this.certId);
        },
        isDomain: function (d) {
          return String(d.id) === String(this.domainId);
        },
        domains: function () {
          var id = String(this.certId);
          var c = this.certs.find(function (x) {
            return String(x.id) === id;
          });
          return c ? c.domains : [];
        },
        move: function (list, i, dir) {
          swap(this.m[list], i, i + dir);
        },
        remove: function (list, i) {
          this.m[list].splice(i, 1);
        },
        addOption: function () {
          this.m.options.push({ uid: nextUid(), text: '', correct: false, feedback: '', pin_last: false, showFeedback: false });
        },
        toggleCorrect: function (i) {
          var single = this.m.type === 'single_choice';
          this.m.options.forEach(function (o, j) {
            if (single) o.correct = j === i;
            else if (j === i) o.correct = !o.correct;
          });
        },
        pinOnly: function (i) {
          if (!this.m.options[i].pin_last) return;
          this.m.options.forEach(function (o, j) {
            if (j !== i) o.pin_last = false;
          });
        },
        addPair: function () {
          this.m.pairs.push({ uid: nextUid(), left: '', right: '' });
        },
        addDistractor: function () {
          this.m.distractors.push({ uid: nextUid(), text: '' });
        },
        addItem: function () {
          this.m.items.push({ uid: nextUid(), text: '' });
        },
        addKeyword: function () {
          this.m.keywords.push({ uid: nextUid(), text: '', weight: 1 });
        },
        keywordTotal: function () {
          return (this.m.keywords || []).reduce(function (s, k) {
            return s + (Number(k.weight) || 0);
          }, 0);
        },
        acceptRange: function () {
          var v = Number(this.m.value);
          var t = Number(this.m.tolerance) || 0;
          if (!isFinite(v)) return '';
          return t ? 'Accepts any answer from ' + (v - t) + ' to ' + (v + t) + '.' : 'Only exactly ' + v + ' is accepted.';
        },
        onStem: function (html) {
          if (this.m.type !== 'fill_blank') return;
          var nums = (html.match(/\[\[(\d{1,2})\]\]/g) || []).map(function (x) {
            return Number(x.replace(/\D/g, ''));
          });
          var count = nums.length ? Math.max.apply(null, nums) : 0;
          while (this.m.blanks.length < count) this.m.blanks.push({ text: '', variants: [] });
          while (this.m.blanks.length > count && !this.m.blanks[this.m.blanks.length - 1].text) this.m.blanks.pop();
        },
        /* Hotspot */
        uploadHotspot: function (e) {
          var self = this;
          var file = e.target.files[0];
          e.target.value = '';
          if (!file) return;
          self.uploading = true;
          upload('/admin/questions/media', file)
            .then(function (r) {
              self.m.image = r.uuid;
            })
            .catch(function (err) {
              window.App.toast(err.message, 'danger');
            })
            .finally(function () {
              self.uploading = false;
            });
        },
        point: function (e) {
          var rect = this.$refs.hsWrap.getBoundingClientRect();
          return { x: Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)), y: Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100)) };
        },
        hsStart: function (e) {
          this.start = this.point(e);
          this.draft = { x: this.start.x, y: this.start.y, w: 0, h: 0 };
        },
        hsMove: function (e) {
          if (!this.start) return;
          var p = this.point(e);
          this.draft = { x: Math.min(p.x, this.start.x), y: Math.min(p.y, this.start.y), w: Math.abs(p.x - this.start.x), h: Math.abs(p.y - this.start.y) };
        },
        hsEnd: function () {
          if (this.draft && this.draft.w > 2 && this.draft.h > 2) {
            var r = this.draft;
            var round = function (v) {
              return Math.round(v * 10) / 10;
            };
            this.m.regions.push({ uid: nextUid(), label: '', x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h), correct: this.m.regions.length === 0 });
          }
          this.start = null;
          this.draft = null;
        },
        box: function (r) {
          return 'left:' + r.x + '%;top:' + r.y + '%;width:' + r.w + '%;height:' + r.h + '%';
        },
        setRegionCorrect: function (i) {
          this.m.regions.forEach(function (r, j) {
            r.correct = j === i;
          });
        },
        /* ---- SQL lab ---- */
        sqlOut: null,
        sqlBusy: false,
        sqlScratch: '',
        sqlTables: [],
        sqlModel: function () {
          var m = this.m;
          return { mode: m.mode, schema_sql: m.schema_sql, seed_sql: m.seed_sql, starter_sql: m.starter_sql, solution_sql: m.solution_sql, check_sql: m.check_sql, order_matters: !!m.order_matters, column_names_matter: !!m.column_names_matter, numeric_tolerance: m.numeric_tolerance };
        },
        isModify: function () {
          return this.m.mode === 'modify';
        },
        sqlRun: function (target) {
          var self = this;
          var body = { question: this.sqlModel(), target: target, sql: target === 'scratch' ? this.sqlScratch : '' };
          this.sqlBusy = true;
          return window.App.api('/admin/sql/run', { method: 'POST', body: body })
            .then(function (r) {
              if (target === 'describe') {
                self.sqlTables = (r.schema && r.schema.tables) || [];
                self.sqlOut = r.schema && !r.schema.ok ? { ok: false, error: r.schema.error, label: 'Dataset' } : null;
                return;
              }
              if (target === 'verify') {
                self.sqlOut = { ok: !r.errors.length, error: r.errors.map(function (x) { return x.message; }).join(' '), label: 'Check', note: r.errors.length ? '' : 'The dataset builds and the model solution runs. Ready to save.' };
                return;
              }
              var run = r.run;
              self.sqlOut = { ok: run.ok, error: run.error, label: target === 'solution' ? 'Model solution' : target === 'check' ? 'Check query' : 'Your query', columns: run.result ? run.result.columns : [], rows: run.result ? run.result.rows : [], count: run.result ? run.result.rowCount : 0, truncated: run.result && run.result.truncated, changes: run.result ? run.result.changes : 0, ms: run.ms };
            })
            .catch(function (err) {
              self.sqlOut = { ok: false, error: err.message, label: 'Error' };
            })
            .finally(function () {
              self.sqlBusy = false;
            });
        },
        runSolution: function () {
          this.sqlRun('solution');
        },
        runScratch: function () {
          this.sqlRun('scratch');
        },
        runVerify: function () {
          this.sqlRun('verify');
        },
        loadSchema: function () {
          this.sqlRun('describe');
        },
        outRows: function () {
          return this.sqlOut && this.sqlOut.rows ? this.sqlOut.rows : [];
        },
        outCols: function () {
          return this.sqlOut && this.sqlOut.columns ? this.sqlOut.columns : [];
        },
        cell: function (v) {
          return v === null ? 'NULL' : String(v);
        },
        outSummary: function () {
          var o = this.sqlOut;
          if (!o) return '';
          if (!o.ok) return o.label + ' failed';
          if (o.note) return o.note;
          if (!o.columns || !o.columns.length) return o.label + ': ' + o.changes + ' row(s) changed · ' + o.ms + ' ms';
          return o.label + ': ' + o.count + ' row(s)' + (o.truncated ? ' (first 200 shown)' : '') + ' · ' + o.ms + ' ms';
        },
        outOk: function () {
          return this.sqlOut && this.sqlOut.ok;
        },
        outError: function () {
          return this.sqlOut && !this.sqlOut.ok;
        },
        /* Serialise the clean authoring model into the hidden "payload" field. */
        serialize: function () {
          var m = this.m;
          var split = function (s) {
            return String(s || '')
              .split('|')
              .map(function (x) {
                return x.trim();
              })
              .filter(Boolean);
          };
          var out = { type: m.type };
          if (m.options)
            out.options = m.options.map(function (o) {
              return { text: o.text, correct: !!o.correct, feedback: o.feedback || '', pin_last: !!o.pin_last };
            });
          if (m.type === 'multiple_response') out.select_exact = m.select_exact === '' || m.select_exact === null ? null : Number(m.select_exact);
          if (m.type === 'true_false') Object.assign(out, { correct: m.correct, feedback_true: m.feedback_true, feedback_false: m.feedback_false });
          if (m.type === 'fill_blank')
            Object.assign(out, {
              blanks: m.blanks.map(function (b) {
                return { variants: split(b.text) };
              }),
              case_sensitive: !!m.case_sensitive,
              trim_whitespace: !!m.trim_whitespace,
            });
          if (m.type === 'numeric') Object.assign(out, { value: m.value, tolerance: m.tolerance, units: m.units });
          if (m.type === 'matching')
            Object.assign(out, {
              pairs: m.pairs.map(function (p) {
                return { left: p.left, right: p.right };
              }),
              distractors: m.distractors.map(function (d) {
                return d.text;
              }),
            });
          if (m.type === 'ordering')
            out.items = m.items.map(function (i) {
              return i.text;
            });
          if (m.type === 'hotspot')
            Object.assign(out, {
              image: m.image,
              regions: m.regions.map(function (r) {
                return { label: r.label, x: r.x, y: r.y, w: r.w, h: r.h, correct: !!r.correct };
              }),
            });
          if (m.type === 'short_answer')
            Object.assign(out, {
              keywords: m.keywords.map(function (k) {
                return { terms: split(k.text), weight: Number(k.weight) };
              }),
              threshold: m.threshold,
              case_sensitive: !!m.case_sensitive,
            });
          if (m.type === 'essay') Object.assign(out, { min_words: m.min_words, max_words: m.max_words });
          if (m.type === 'sql') Object.assign(out, this.sqlModel());
          this.$refs.payload.value = JSON.stringify(out);
        },
      };
    });
  });

  // Render LaTeX inside rich editors' previews on load (read-only areas only).
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.q-render').forEach(renderMath);
  });
})();

/* ---------------- Exam builder ---------------- */
(function () {
  'use strict';

  function formBody(form) {
    var params = new URLSearchParams();
    new FormData(form).forEach(function (v, k) {
      if (typeof v === 'string') params.append(k, v);
    });
    return params.toString();
  }
  function post(url, body) {
    return window.App.api(url, { method: 'POST', body: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  }
  function clock() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  document.addEventListener('alpine:init', function () {
    var Alpine = window.Alpine;

    /* Autosaves a builder tab 800 ms after the last change; the Save button still works without JavaScript. */
    Alpine.data('autosave', function () {
      return {
        state: 'idle',
        savedAt: '',
        messages: [],
        timer: null,
        enabled: false,
        init: function () {
          var self = this;
          this.enabled = !!this.$el.dataset.autosave;
          if (!this.enabled) return;
          var schedule = function () {
            clearTimeout(self.timer);
            self.state = 'pending';
            self.timer = setTimeout(function () {
              self.save();
            }, 800);
          };
          this.$el.addEventListener('input', schedule);
          this.$el.addEventListener('change', schedule);
          this.$el.addEventListener('submit', function (e) {
            e.preventDefault();
            clearTimeout(self.timer);
            self.save();
          });
        },
        save: function () {
          var self = this;
          var form = this.$root;
          this.state = 'saving';
          post(form.getAttribute('action'), formBody(form))
            .then(function () {
              self.state = 'saved';
              self.savedAt = clock();
              self.messages = [];
              self.mark([]);
            })
            .catch(function (err) {
              self.state = 'error';
              var errs = (err.data && err.data.errors) || [];
              self.messages = errs.length
                ? errs.map(function (x) {
                    return x.message;
                  })
                : [err.message];
              self.mark(errs);
            });
        },
        mark: function (errs) {
          var form = this.$root;
          Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid="true"]'), function (el) {
            el.removeAttribute('aria-invalid');
            el.classList.remove('input-error');
          });
          errs.forEach(function (x) {
            var name = String(x.field || '').replace(/\.(\w+)/g, '[$1]');
            var el = form.querySelector('[name="' + name + '"]');
            if (el) {
              el.setAttribute('aria-invalid', 'true');
              el.classList.add('input-error');
            }
          });
        },
        hasErrors: function () {
          return this.messages.length > 0;
        },
        statusText: function () {
          if (this.state === 'pending') return 'Unsaved changes…';
          if (this.state === 'saving') return 'Saving…';
          if (this.state === 'saved') return 'All changes saved at ' + this.savedAt;
          if (this.state === 'error') return 'Not saved — please fix the errors';
          return this.enabled ? 'Changes save automatically' : 'Read only';
        },
      };
    });

    /* Fixed question list: selection, per-item marks/section, up/down ordering. */
    Alpine.data('examItems', function () {
      return {
        selected: 0,
        saved: '',
        base: function () {
          return '/admin/exams/' + this.$root.dataset.exam + '/items';
        },
        boxes: function () {
          return Array.prototype.slice.call(this.$root.querySelectorAll('input[name="item_ids"]'));
        },
        sync: function () {
          this.selected = this.boxes().filter(function (b) {
            return b.checked;
          }).length;
        },
        count: function () {
          return this.selected;
        },
        savedText: function () {
          return this.saved;
        },
        position: function (el) {
          var tr = el.closest('tr');
          return Array.prototype.indexOf.call(tr.parentNode.children, tr) + 1;
        },
        report: function (p) {
          var self = this;
          p.then(function () {
            self.saved = 'Saved at ' + clock() + '.';
          }).catch(function (err) {
            self.saved = '';
            window.App.toast(err.message, 'error');
          });
        },
        saveMarks: function (e) {
          var b = new URLSearchParams({ item_id: e.target.dataset.item, marks: e.target.value });
          this.report(post(this.base(), b.toString()));
        },
        saveSection: function (e) {
          var b = new URLSearchParams({ item_id: e.target.dataset.item, section_id: e.target.value });
          this.report(post(this.base(), b.toString()));
        },
        move: function (e, dir) {
          var tr = e.target.closest('tr');
          var sib = dir < 0 ? tr.previousElementSibling : tr.nextElementSibling;
          if (!sib) return;
          if (dir < 0) tr.parentNode.insertBefore(tr, sib);
          else tr.parentNode.insertBefore(sib, tr);
          Array.prototype.forEach.call(tr.parentNode.children, function (row, i) {
            var cell = row.querySelector('[data-label="Position"]');
            if (cell) cell.textContent = String(i + 1);
          });
          e.target.closest('button').focus();
          var b = new URLSearchParams({ action: 'reorder' });
          Array.prototype.forEach.call(tr.parentNode.children, function (row) {
            b.append('order', row.dataset.id);
          });
          this.report(post(this.base(), b.toString()));
        },
        up: function (e) {
          this.move(e, -1);
        },
        down: function (e) {
          this.move(e, 1);
        },
      };
    });

    /* Blueprint rule form: live "N questions available" from the bank. */
    Alpine.data('ruleForm', function () {
      return {
        available: null,
        wanted: 0,
        error: '',
        timer: null,
        init: function () {
          var self = this;
          this.check();
          this.$el.addEventListener('input', function () {
            clearTimeout(self.timer);
            self.timer = setTimeout(function () {
              self.check();
            }, 400);
          });
        },
        check: function () {
          var self = this;
          var params = new URLSearchParams(formBody(this.$root));
          params.delete('_csrf');
          this.wanted = Number(params.get('question_count')) || 0;
          window.App.api(this.$root.dataset.preview + '?' + params.toString())
            .then(function (r) {
              self.error = '';
              self.available = r.available;
            })
            .catch(function (err) {
              self.available = null;
              self.error = (err.data && err.data.errors && err.data.errors[0] && err.data.errors[0].message) || err.message;
            });
        },
        availableText: function () {
          if (this.error) return this.error;
          if (this.available === null) return 'Checking the bank…';
          if (this.available >= this.wanted) return this.available + ' published questions match — enough for this rule.';
          return 'Only ' + this.available + ' published questions match; this rule asks for ' + this.wanted + '.';
        },
        availableClass: function () {
          if (this.error || (this.available !== null && this.available < this.wanted)) return 'text-red-600 dark:text-red-400';
          return this.available === null ? 'muted' : 'text-emerald-700 dark:text-emerald-400';
        },
      };
    });
  });
})();
