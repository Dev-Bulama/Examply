/* Exam player (Alpine CSP build). Server-authoritative timer, debounced autosave with an offline queue in
   localStorage, palette, flags, review, sections, integrity events, keyboard shortcuts, calculator and notepad. */
(function () {
  'use strict';

  function readConfig() {
    try {
      return JSON.parse(document.getElementById('player-config').textContent);
    } catch (e) {
      return null;
    }
  }
  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }
  function fmtClock(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s % 60);
  }
  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(window.localStorage.getItem(key) || 'null');
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      return null;
    }
    return null;
  }

  /** Reads the candidate's response for one item container from its form controls. */
  function collect(container) {
    var type = container.getAttribute('data-type');
    var q = function (sel) {
      return Array.prototype.slice.call(container.querySelectorAll(sel));
    };
    var val = function (sel) {
      var el = container.querySelector(sel);
      return el ? el.value : '';
    };
    switch (type) {
      case 'single_choice':
      case 'true_false':
      case 'hotspot': {
        var c = container.querySelector('input[type=radio]:checked');
        return c ? { selected: c.value } : null;
      }
      case 'multiple_response': {
        var sel = q('input[type=checkbox]:checked').map(function (x) {
          return x.value;
        });
        return sel.length ? { selected: sel } : null;
      }
      case 'fill_blank': {
        var blanks = [];
        q('input[name*="[blanks]"]').forEach(function (inp) {
          var m = /\[blanks\]\[(\d+)\]/.exec(inp.name);
          if (m) blanks[Number(m[1])] = inp.value;
        });
        for (var i = 0; i < blanks.length; i += 1) if (blanks[i] === undefined) blanks[i] = '';
        return blanks.some(function (b) {
          return b.trim() !== '';
        })
          ? { blanks: blanks }
          : null;
      }
      case 'numeric': {
        var v = val('input[name$="[value]"]').trim();
        return v ? { value: v } : null;
      }
      case 'matching': {
        var pairs = {};
        var any = false;
        q('select[name*="[pairs]"]').forEach(function (s) {
          var m = /\[pairs\]\[([^\]]+)\]/.exec(s.name);
          if (m && s.value) {
            pairs[m[1]] = s.value;
            any = true;
          }
        });
        return any ? { pairs: pairs } : null;
      }
      case 'ordering':
        return {
          order: q('input[name$="[order][]"]').map(function (x) {
            return x.value;
          }),
        };
      case 'short_answer':
      case 'essay': {
        var t = val('textarea[name$="[text]"]');
        return t.trim() ? { text: t } : null;
      }
      case 'sql': {
        var sql = val('textarea[name$="[sql]"]');
        return sql.trim() ? { sql: sql } : null;
      }
      default:
        return null;
    }
  }

  document.addEventListener('alpine:init', function () {
    window.Alpine.data('examPlayer', function () {
      return {
        cfg: null,
        cur: 0,
        reviewing: false,
        paletteOpen: false,
        answered: {},
        flagged: {},
        dirty: {},
        pendingFlags: {},
        queueKey: '',
        status: 'saved',
        offset: 0,
        now: Date.now(),
        banner: '',
        busy: false,
        confirming: '',
        submitted: false,
        state: null,
        contrast: false,
        fontStep: 0,
        calcOpen: false,
        calcExpr: '',
        calcOut: '',
        notesOpen: false,
        notes: '',
        needFullscreen: false,
        posStartedAt: Date.now(),
        timers: [],
        lastSync: 0,
        viewStart: Date.now(),

        init: function () {
          var self = this;
          var cfg = readConfig();
          if (!cfg) return;
          this.cfg = cfg;
          this.cur = Math.min(cfg.pos || 0, cfg.count - 1);
          this.offset = new Date(cfg.serverTime).getTime() - Date.now();
          this.state = { sectionOrder: cfg.sectionOrder, sectionIndex: cfg.sectionIndex, sectionEndsAt: cfg.sectionEndsAt, timedSections: cfg.timedSections };
          this.queueKey = 'attempt:' + cfg.uuid + ':queue';
          cfg.items.forEach(function (m) {
            m.items.forEach(function (id) {
              if (m.answered.indexOf(id) >= 0) self.answered[id] = true;
            });
            if (m.flagged) self.flagged[m.idx] = true;
          });
          this.notes = store('attempt:' + cfg.uuid + ':notes') || '';
          this.contrast = !!store('exam:contrast');
          this.fontStep = store('exam:font') || 0;
          // Replay answers that were saved offline before this page loaded.
          var queued = store(this.queueKey);
          if (queued && queued.answers && queued.answers.length) {
            queued.answers.forEach(function (a) {
              self.dirty[a.itemId] = a.response;
            });
            this.status = 'pending';
          }
          this.timers.push(
            setInterval(function () {
              self.tick();
            }, 500),
          );
          this.timers.push(
            setInterval(function () {
              self.flush(true);
            }, 30000),
          );
          window.addEventListener('online', function () {
            self.event('online');
            self.flush(true);
          });
          window.addEventListener('offline', function () {
            self.status = 'offline';
            self.event('offline');
          });
          window.addEventListener('beforeunload', function (e) {
            if (Object.keys(self.dirty).length && !self.submitted) {
              self.persistQueue();
              e.preventDefault();
              e.returnValue = '';
            }
          });
          this.setupIntegrity();
          this.$nextTick(function () {
            if (window.QuestionRender) window.QuestionRender.enhance(document);
            self.flush(false);
          });
        },

        // ---------------- Clock
        serverNow: function () {
          return this.now + this.offset;
        },
        tick: function () {
          this.now = Date.now();
          if (this.submitted) return;
          var cfg = this.cfg;
          if (cfg.expiresAt && this.serverNow() >= new Date(cfg.expiresAt).getTime()) {
            this.autoSubmit('Time is up. Submitting your exam…');
            return;
          }
          var st = this.state;
          if (st.timedSections && st.sectionEndsAt && this.serverNow() >= new Date(st.sectionEndsAt).getTime()) {
            if (st.sectionIndex < st.sectionOrder.length - 1) this.flush(true);
            else this.autoSubmit('Time is up. Submitting your exam…');
          }
          if (cfg.perQuestionSeconds && !this.reviewing && this.serverNow() - this.posStartedAt >= cfg.perQuestionSeconds * 1000) {
            this.posStartedAt = this.serverNow();
            if (this.hasNext()) this.next();
            else this.openReview();
          }
        },
        remainingMs: function () {
          if (!this.cfg || !this.cfg.expiresAt) return null;
          return new Date(this.cfg.expiresAt).getTime() - this.serverNow();
        },
        timerText: function () {
          var r = this.remainingMs();
          return r === null ? '' : fmtClock(r);
        },
        timerClass: function () {
          var r = this.remainingMs();
          if (r === null) return '';
          if (r < 60000) return 'bg-red-600 text-white animate-pulse';
          if (r < 300000) return 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100';
          return 'bg-slate-100 dark:bg-slate-800';
        },
        questionTimerText: function () {
          if (!this.cfg || !this.cfg.perQuestionSeconds) return '';
          return 'Time for this question: ' + fmtClock(this.cfg.perQuestionSeconds * 1000 - (this.serverNow() - this.posStartedAt));
        },

        // ---------------- Navigation
        item: function (i) {
          return this.cfg.items[i];
        },
        inCurrentSection: function (i) {
          var st = this.state;
          if (!st.timedSections) return true;
          var sid = this.item(i).section;
          return sid === st.sectionOrder[st.sectionIndex];
        },
        shows: function (i) {
          if (this.cfg.layout === 'all') return this.inCurrentSection(i);
          return i === this.cur;
        },
        isCurrent: function (i) {
          return i === this.cur && !this.reviewing ? 'step' : 'false';
        },
        canGo: function (i) {
          if (!this.inCurrentSection(i)) return false;
          if (this.cfg.navigation === 'linear') return i === this.cur;
          return true;
        },
        go: function (i) {
          if (!this.canGo(i)) return;
          this.setPos(i);
          this.paletteOpen = false;
          window.scrollTo(0, 0);
        },
        goFromReview: function (i) {
          this.reviewing = false;
          this.go(i);
        },
        setPos: function (i) {
          if (i === this.cur) return;
          this.recordTime();
          this.cur = i;
          this.posStartedAt = this.serverNow();
          this.flush(false, true);
          var self = this;
          this.$nextTick(function () {
            if (window.QuestionRender) window.QuestionRender.enhance(document);
            var h = document.getElementById('qh-' + self.item(i).id);
            if (h) h.focus({ preventScroll: true });
          });
        },
        nextIndex: function (dir) {
          for (var i = this.cur + dir; i >= 0 && i < this.cfg.count; i += dir) if (this.inCurrentSection(i)) return i;
          return -1;
        },
        hasPrev: function () {
          return this.cfg.navigation !== 'linear' && this.nextIndex(-1) >= 0;
        },
        hasNext: function () {
          if (this.cfg.layout === 'all') return false;
          return this.nextIndex(1) >= 0;
        },
        prev: function () {
          var i = this.nextIndex(-1);
          if (i >= 0 && this.cfg.navigation !== 'linear') this.go(i);
        },
        next: function () {
          var i = this.nextIndex(1);
          if (i >= 0) {
            this.setPos(i);
            window.scrollTo(0, 0);
          }
        },
        togglePalette: function () {
          this.paletteOpen = !this.paletteOpen;
        },
        recordTime: function () {
          var spent = Math.round((Date.now() - this.viewStart) / 1000);
          this.viewStart = Date.now();
          var m = this.item(this.cur);
          if (spent > 0 && m) this.timeSpent = { itemId: m.items[0], seconds: spent };
        },

        // ---------------- Answers & flags
        changed: function (e) {
          var box = e.target && e.target.closest ? e.target.closest('[data-item]') : null;
          if (!box) return;
          if (e.target.closest('[data-notes]')) return;
          var id = Number(box.getAttribute('data-item'));
          if (box.getAttribute('data-type') === 'lab') {
            // Labs are answered on the server, command by command; just show progress.
            if (e.type === 'answer-changed') this.answered[id] = true;
            this.cheer();
            return;
          }
          var resp = collect(box);
          this.dirty[id] = resp;
          if (resp) this.answered[id] = true;
          else delete this.answered[id];
          this.cheer();
          this.status = 'pending';
          var self = this;
          clearTimeout(this.saveTimer);
          this.saveTimer = setTimeout(function () {
            self.flush(false);
          }, e.type === 'input' ? 900 : 300);
        },
        /** Gentle encouragement at 25 / 50 / 75 / 100% answered (once each; not for very short exams). */
        cheer: function () {
          if (this.cfg.count < 8 || !window.App || !window.App.toast) return;
          var pct = (this.progressCount() / this.cfg.count) * 100;
          if (!this.cheered) {
            // First answer of this page load: skip milestones already passed before a resume.
            this.cheered = {};
            var before = ((this.progressCount() - 1) / this.cfg.count) * 100;
            [25, 50, 75, 100].forEach(function (m) {
              if (before >= m) this.cheered[m] = true;
            }, this);
          }
          var notes = {
            25: 'Good start — a quarter done. Keep a steady pace.',
            50: 'Halfway there. You are doing well.',
            75: 'Three quarters done — the finish line is close.',
            100: 'Every question answered. Check any flagged ones, then submit when you are ready.',
          };
          var hit = null;
          [25, 50, 75, 100].forEach(function (m) {
            if (pct >= m && !this.cheered[m]) {
              this.cheered[m] = true;
              hit = m;
            }
          }, this);
          if (hit) window.App.toast(notes[hit], 'info');
        },
        isAnswered: function (i) {
          var self = this;
          var m = this.item(i);
          return m.items.every(function (id) {
            return self.answered[id];
          });
        },
        isPartly: function (i) {
          var self = this;
          return this.item(i).items.some(function (id) {
            return self.answered[id];
          });
        },
        isFlagged: function (i) {
          return !!this.flagged[i];
        },
        toggleFlag: function (i) {
          if (!this.cfg.allowFlag) return;
          if (this.flagged[i]) delete this.flagged[i];
          else this.flagged[i] = true;
          this.pendingFlags[this.item(i).items[0]] = !!this.flagged[i];
          this.flush(false);
        },
        palClass: function (i) {
          var c = '';
          if (this.isFlagged(i)) c = 'border-amber-400 bg-amber-400 text-slate-900';
          else if (this.isAnswered(i)) c = 'border-primary-600 bg-primary-600 text-on-primary';
          else if (this.isPartly(i)) c = 'border-primary-300 bg-primary-100 text-primary-900 dark:bg-primary-900/40 dark:text-primary-100';
          else c = 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900';
          if (i === this.cur && !this.reviewing) c += ' ring-2 ring-offset-1 ring-primary-500 dark:ring-offset-slate-900';
          if (!this.canGo(i)) c += ' opacity-40 cursor-not-allowed';
          return c;
        },
        palLabel: function (i) {
          return 'Question ' + (i + 1) + (this.isAnswered(i) ? ', answered' : ', not answered') + (this.isFlagged(i) ? ', flagged' : '');
        },
        progressCount: function () {
          var n = 0;
          for (var i = 0; i < this.cfg.count; i += 1) if (this.isAnswered(i)) n += 1;
          return n;
        },
        progressText: function () {
          return this.progressCount() + ' of ' + this.cfg.count + ' answered';
        },
        progressStyle: function () {
          return 'width:' + Math.round((this.progressCount() / Math.max(1, this.cfg.count)) * 100) + '%';
        },

        // ---------------- Saving (debounced, offline-safe)
        persistQueue: function () {
          var self = this;
          var answers = Object.keys(this.dirty).map(function (id) {
            return { itemId: Number(id), response: self.dirty[id] };
          });
          store(this.queueKey, answers.length ? { answers: answers, at: Date.now() } : null);
        },
        flush: function (sync, navOnly) {
          var self = this;
          if (this.submitted || this.inFlight) return;
          var answers = Object.keys(this.dirty).map(function (id) {
            return { itemId: Number(id), response: self.dirty[id] };
          });
          Object.keys(this.pendingFlags).forEach(function (id) {
            var existing = answers.find(function (a) {
              return a.itemId === Number(id);
            });
            if (existing) existing.flagged = self.pendingFlags[id];
            else answers.push({ itemId: Number(id), flagged: self.pendingFlags[id] });
          });
          if (this.timeSpent) {
            var t = this.timeSpent;
            var a0 = answers.find(function (a) {
              return a.itemId === t.itemId;
            });
            if (a0) a0.timeSpent = t.seconds;
            else answers.push({ itemId: t.itemId, timeSpent: t.seconds });
          }
          if (!answers.length && !sync && !navOnly) {
            if (this.status === 'pending') this.status = 'saved';
            return;
          }
          this.persistQueue();
          if (!navigator.onLine) {
            this.status = 'offline';
            return;
          }
          var sent = {};
          Object.keys(this.dirty).forEach(function (k) {
            sent[k] = self.dirty[k];
          });
          var sentFlags = this.pendingFlags;
          var sentTime = this.timeSpent;
          this.dirty = {};
          this.pendingFlags = {};
          this.timeSpent = null;
          this.inFlight = true;
          if (answers.length) this.status = 'saving';
          window.App.api('/attempts/' + this.cfg.uuid + '/answers', { method: 'PATCH', body: { answers: answers, pos: this.cur }, headers: { 'X-Attempt-Token': this.cfg.token } })
            .then(function (r) {
              self.offset = new Date(r.serverTime).getTime() - Date.now();
              if (r.state) {
                var before = self.state.sectionIndex;
                self.state = r.state;
                if (r.state.sectionIndex !== before) self.enterSection();
              }
              if (r.submitted || r.status !== 'in_progress') return self.goToResult();
              (r.rejected || []).forEach(function (x) {
                if (x.reason === 'section_closed') self.banner = 'That section has closed, so a late change was not saved.';
                if (x.reason === 'question_time') self.banner = 'Time for that question had run out, so a late change was not saved.';
              });
              self.status = Object.keys(self.dirty).length ? 'pending' : 'saved';
              store(self.queueKey, null);
              if (Object.keys(self.dirty).length) self.persistQueue();
              return null;
            })
            .catch(function (err) {
              // Keep what failed so nothing is lost; newer edits win.
              Object.keys(sent).forEach(function (k) {
                if (!(k in self.dirty)) self.dirty[k] = sent[k];
              });
              Object.keys(sentFlags).forEach(function (k) {
                if (!(k in self.pendingFlags)) self.pendingFlags[k] = sentFlags[k];
              });
              if (sentTime && !self.timeSpent) self.timeSpent = sentTime;
              self.persistQueue();
              if (err.status === 409 && err.data && err.data.code === 'other_session') {
                self.banner = err.message;
                self.submitted = true;
                setTimeout(function () {
                  window.location.reload();
                }, 2500);
              } else if (err.status === 409) self.goToResult();
              else self.status = navigator.onLine ? 'error' : 'offline';
            })
            .finally(function () {
              self.inFlight = false;
            });
        },
        saveText: function () {
          return { saved: 'All answers saved ✓', pending: 'Saving…', saving: 'Saving…', offline: 'Offline — answers stored on this device', error: 'Not saved yet — retrying' }[this.status];
        },
        saveClass: function () {
          return this.status === 'offline' || this.status === 'error' ? 'font-semibold text-amber-600 dark:text-amber-400' : '';
        },

        // ---------------- Sections
        enterSection: function () {
          var self = this;
          for (var i = 0; i < this.cfg.count; i += 1) {
            if (this.inCurrentSection(i)) {
              this.cur = i;
              break;
            }
          }
          this.reviewing = false;
          this.$nextTick(function () {
            if (window.QuestionRender) window.QuestionRender.enhance(document);
            window.scrollTo(0, 0);
            self.banner = '';
          });
        },
        sectionName: function () {
          var sid = this.state.sectionOrder[this.state.sectionIndex];
          return sid ? this.cfg.sectionTitles[sid] || 'Section' : 'General';
        },
        sectionTimeText: function () {
          if (!this.state.sectionEndsAt) return '';
          return '· ' + fmtClock(new Date(this.state.sectionEndsAt).getTime() - this.serverNow()) + ' left in this section';
        },
        hasNextSection: function () {
          return this.state.timedSections && this.state.sectionIndex < this.state.sectionOrder.length - 1;
        },

        // ---------------- Review & submit
        openReview: function () {
          this.recordTime();
          this.flush(false);
          if (this.hasNextSection()) {
            this.askFinishSection();
            return;
          }
          this.reviewing = true;
          window.scrollTo(0, 0);
        },
        closeReview: function () {
          this.reviewing = false;
        },
        reviewSummary: function () {
          var un = 0;
          var fl = 0;
          for (var i = 0; i < this.cfg.count; i += 1) {
            if (!this.isAnswered(i)) un += 1;
            if (this.isFlagged(i)) fl += 1;
          }
          return un + ' unanswered · ' + fl + ' flagged. Select a number to go back to that question.';
        },
        askSubmit: function () {
          this.confirming = 'submit';
        },
        askFinishSection: function () {
          this.confirming = 'section';
        },
        cancelConfirm: function () {
          this.confirming = '';
        },
        confirmTitle: function () {
          return this.confirming === 'section' ? 'Finish this section?' : 'Submit your exam?';
        },
        confirmText: function () {
          if (this.confirming === 'section') return 'You cannot come back to this section once you move on.';
          var un = this.cfg.count - this.progressCount();
          return (un ? 'You have ' + un + ' unanswered question' + (un === 1 ? '' : 's') + '. ' : '') + 'After you submit you cannot change your answers.';
        },
        confirmLabel: function () {
          return this.confirming === 'section' ? 'Finish section' : 'Submit exam';
        },
        doConfirm: function () {
          var self = this;
          if (this.confirming === 'section') {
            this.confirming = '';
            this.flush(true);
            window.App.api('/attempts/' + this.cfg.uuid + '/section/finish', { method: 'POST', body: {} })
              .then(function (r) {
                self.state = r.state;
                self.enterSection();
              })
              .catch(function (err) {
                window.App.toast(err.message, 'error');
              });
            return;
          }
          this.submitNow('candidate');
        },
        submitNow: function (reason) {
          var self = this;
          if (this.busy) return;
          this.busy = true;
          var finish = function () {
            self.submitted = true;
            store(self.queueKey, null);
            self.$refs.submitReason.value = reason;
            self.$refs.submitForm.submit();
          };
          // Send any last answers first; submit even if that fails (the server keeps what it has).
          if (Object.keys(this.dirty).length && navigator.onLine) {
            var answers = Object.keys(this.dirty).map(function (id) {
              return { itemId: Number(id), response: self.dirty[id] };
            });
            window.App.api('/attempts/' + this.cfg.uuid + '/answers', { method: 'PATCH', body: { answers: answers, pos: this.cur }, headers: { 'X-Attempt-Token': this.cfg.token } }).then(finish, finish);
          } else finish();
        },
        autoSubmit: function (message) {
          if (this.submitted || this.busy) return;
          this.banner = message;
          this.submitNow('timeout');
        },
        goToResult: function () {
          this.submitted = true;
          store(this.queueKey, null);
          window.location.href = '/results/' + this.cfg.uuid;
        },

        // ---------------- Integrity
        event: function (type, details) {
          var self = this;
          if (this.submitted) return;
          window.App.api('/attempts/' + this.cfg.uuid + '/events', { method: 'POST', body: { type: type, details: details || null } })
            .then(function (r) {
              if (r.submitted) self.goToResult();
              else if (type === 'tab_hidden' && r.limit) self.banner = 'Leaving the exam was recorded (' + r.tabSwitches + ' of ' + r.limit + ' allowed).';
            })
            .catch(function () {
              /* integrity events are best-effort when offline */
            });
        },
        setupIntegrity: function () {
          var self = this;
          var ig = this.cfg.integrity || {};
          if (ig.record_tab_switches || ig.tab_switch_limit) {
            window.addEventListener('pagehide', function () {
              self.unloading = true;
            });
            window.addEventListener('beforeunload', function () {
              self.unloading = true;
              setTimeout(function () {
                self.unloading = false; // the candidate stayed on the page
              }, 1000);
            });
            document.addEventListener('visibilitychange', function () {
              if (document.visibilityState === 'hidden' && !self.unloading) {
                self.flush(true);
                self.event('tab_hidden');
              }
            });
          }
          if (ig.disable_copy) {
            ['copy', 'cut', 'paste', 'contextmenu'].forEach(function (t) {
              document.addEventListener(t, function (e) {
                var inSql = e.target && e.target.closest && e.target.closest('textarea[name$="[sql]"]');
                if (inSql && t !== 'contextmenu') return; // allow editing SQL in the lab editor
                e.preventDefault();
                self.event(t === 'contextmenu' ? 'context_menu' : t === 'cut' ? 'copy' : t);
              });
            });
          }
          if (ig.fullscreen) {
            this.needFullscreen = !document.fullscreenElement;
            document.addEventListener('fullscreenchange', function () {
              if (!document.fullscreenElement && !self.submitted) {
                self.needFullscreen = true;
                self.event('fullscreen_exit');
              } else self.needFullscreen = false;
            });
          }
        },
        enterFullscreen: function () {
          var self = this;
          var el = document.documentElement;
          if (el.requestFullscreen)
            el.requestFullscreen().then(
              function () {
                self.needFullscreen = false;
                self.event('fullscreen_enter');
              },
              function () {
                self.needFullscreen = false;
              },
            );
          else this.needFullscreen = false;
        },

        // ---------------- Accessibility & keyboard
        rootClass: function () {
          return (this.contrast ? 'exam-contrast ' : '') + ['', 'text-[1.08rem]', 'text-[1.18rem]', 'text-[1.3rem]'][Math.max(0, Math.min(3, this.fontStep))];
        },
        fontBigger: function () {
          this.fontStep = Math.min(3, this.fontStep + 1);
          store('exam:font', this.fontStep);
        },
        fontSmaller: function () {
          this.fontStep = Math.max(0, this.fontStep - 1);
          store('exam:font', this.fontStep);
        },
        toggleContrast: function () {
          this.contrast = !this.contrast;
          store('exam:contrast', this.contrast);
        },
        keys: function (e) {
          var tag = (e.target.tagName || '').toLowerCase();
          if (tag === 'textarea' || (tag === 'input' && ['text', 'number', 'search'].indexOf(e.target.type) >= 0) || tag === 'select' || e.ctrlKey || e.metaKey || e.altKey) return;
          if (this.reviewing || this.confirming) return;
          var k = e.key.toLowerCase();
          if (k === 'n') {
            if (this.hasNext()) this.next();
            e.preventDefault();
          } else if (k === 'p') {
            this.prev();
            e.preventDefault();
          } else if (k === 'f') {
            this.toggleFlag(this.cur);
            e.preventDefault();
          } else {
            var idx = 'abcdefghi'.indexOf(k);
            if (idx < 0 && /^[1-9]$/.test(k)) idx = Number(k) - 1;
            if (idx < 0) return;
            var section = document.querySelector('[data-pos="' + this.cur + '"]');
            var inputs = section ? section.querySelectorAll('input[type=radio], input[type=checkbox]') : [];
            if (inputs[idx]) {
              inputs[idx].click();
              e.preventDefault();
            }
          }
        },

        // ---------------- Tools
        toggleCalc: function () {
          this.calcOpen = !this.calcOpen;
        },
        toggleNotes: function () {
          this.notesOpen = !this.notesOpen;
        },
        saveNotes: function () {
          store('attempt:' + this.cfg.uuid + ':notes', this.notes);
        },
        calcPress: function (e) {
          var k = e.currentTarget.getAttribute('data-key');
          this.calcExpr += k;
        },
        calcClear: function () {
          this.calcExpr = '';
          this.calcOut = '';
        },
        calcEval: function () {
          try {
            var v = window.SafeCalc.evaluate(this.calcExpr);
            this.calcOut = Number.isFinite(v) ? String(Math.round(v * 1e10) / 1e10) : 'Error';
          } catch (err) {
            this.calcOut = 'Error';
          }
        },
      };
    });
  });

  /* A small expression evaluator for the calculator (no eval: the CSP forbids it, and so should we). */
  window.SafeCalc = {
    evaluate: function (src) {
      var s = String(src || '').replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/');
      var i = 0;
      var FUN = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, abs: Math.abs };
      function peek() {
        return s[i];
      }
      function expr() {
        var v = term();
        while (peek() === '+' || peek() === '-') v = s[i++] === '+' ? v + term() : v - term();
        return v;
      }
      function term() {
        var v = power();
        while (peek() === '*' || peek() === '/' || peek() === '%') {
          var op = s[i++];
          var r = power();
          v = op === '*' ? v * r : op === '/' ? v / r : v % r;
        }
        return v;
      }
      function power() {
        var b = unary();
        if (peek() === '^') {
          i += 1;
          return Math.pow(b, power());
        }
        return b;
      }
      function unary() {
        if (peek() === '-') {
          i += 1;
          return -unary();
        }
        if (peek() === '+') {
          i += 1;
          return unary();
        }
        return atom();
      }
      function atom() {
        if (peek() === '(') {
          i += 1;
          var v = expr();
          if (s[i++] !== ')') throw new Error('Missing )');
          return v;
        }
        var m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
        if (m) {
          i += m[0].length;
          return parseFloat(m[0]);
        }
        var w = /^[a-z]+/i.exec(s.slice(i));
        if (w) {
          var name = w[0].toLowerCase();
          i += w[0].length;
          if (name === 'pi') return Math.PI;
          if (name === 'e') return Math.E;
          if (FUN[name] && peek() === '(') {
            i += 1;
            var arg = expr();
            if (s[i++] !== ')') throw new Error('Missing )');
            return FUN[name](arg);
          }
        }
        throw new Error('Unexpected input');
      }
      var out = expr();
      if (i !== s.length) throw new Error('Unexpected input');
      return out;
    },
  };
})();
