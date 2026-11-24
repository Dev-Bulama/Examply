/* Skillscore Assess — site-wide behaviour (Alpine CSP build: components are registered here, not inline). */
(function () {
  'use strict';

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var CSRF = csrfMeta ? csrfMeta.getAttribute('content') : '';

  /* ---------- Theme (light / dark / system) ---------- */
  function systemDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function applyTheme(pref) {
    var dark = pref === 'dark' || (pref === 'system' && systemDark());
    document.documentElement.classList.toggle('dark', dark);
  }
  function currentPref() {
    try {
      return localStorage.getItem('theme') || document.documentElement.getAttribute('data-theme-pref') || 'system';
    } catch (e) {
      return document.documentElement.getAttribute('data-theme-pref') || 'system';
    }
  }

  /* ---------- Toasts ---------- */
  function toast(message, type) {
    var region = document.getElementById('toast-region');
    if (!region) return;
    var el = document.createElement('div');
    var tone = {
      success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
      danger: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100',
      warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
      info: 'border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
    }[type || 'info'];
    el.className = 'pointer-events-auto w-full max-w-sm rounded-lg border px-4 py-3 text-sm shadow-pop transition-opacity duration-300 ' + tone;
    el.setAttribute('role', type === 'danger' ? 'alert' : 'status');
    el.textContent = message;
    region.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () {
        el.remove();
      }, 300);
    }, 5000);
  }

  /* ---------- fetch() wrapper that sends the CSRF token and parses JSON errors ---------- */
  function api(url, options) {
    options = options || {};
    var headers = Object.assign({ Accept: 'application/json', 'X-CSRF-Token': CSRF }, options.headers || {});
    var body = options.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(url, Object.assign({}, options, { headers: headers, body: body, credentials: 'same-origin' })).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || 'Request failed (' + res.status + ')');
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
    });
  }

  window.App = { toast: toast, api: api, csrf: CSRF, applyTheme: applyTheme };

  /* ---------- Confirm dialogs for destructive actions: <form data-confirm="Delete this user?"> ---------- */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    var msg = form.getAttribute('data-confirm');
    if (msg && !form.dataset.confirmed) {
      e.preventDefault();
      openConfirm(msg, form.getAttribute('data-confirm-label') || 'Confirm', function () {
        form.dataset.confirmed = '1';
        if (form.requestSubmit) form.requestSubmit();
        else form.submit();
      });
      return;
    }
    // Disable submit buttons while processing (prevents double submits).
    if (!form.hasAttribute('data-no-disable')) {
      var buttons = form.querySelectorAll('button[type="submit"], button:not([type])');
      setTimeout(function () {
        buttons.forEach(function (b) {
          b.disabled = true;
          if (b.dataset.loadingText) b.textContent = b.dataset.loadingText;
        });
      }, 0);
    }
  });

  function openConfirm(message, label, onConfirm) {
    var dlg = document.getElementById('confirm-dialog');
    if (!dlg || !dlg.showModal) {
      if (window.confirm(message)) onConfirm();
      return;
    }
    dlg.querySelector('[data-confirm-message]').textContent = message;
    var ok = dlg.querySelector('[data-confirm-ok]');
    ok.textContent = label;
    var cancel = dlg.querySelector('[data-confirm-cancel]');
    function close() {
      dlg.close();
      ok.removeEventListener('click', yes);
      cancel.removeEventListener('click', close);
    }
    function yes() {
      close();
      onConfirm();
    }
    ok.addEventListener('click', yes);
    cancel.addEventListener('click', close);
    dlg.showModal();
  }

  /* ---------- Copy to clipboard: <button data-copy="text"> ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var text = btn.getAttribute('data-copy');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () {
        toast('Copied to clipboard', 'success');
      });
    }
  });

  /* ---------- Auto-submit selects: <select data-autosubmit> ---------- */
  document.addEventListener('change', function (e) {
    if (e.target.matches('[data-autosubmit]')) e.target.form.submit();
  });

  /* ---------- Alpine components ---------- */
  document.addEventListener('alpine:init', function () {
    var Alpine = window.Alpine;

    Alpine.data('themeToggle', function () {
      return {
        pref: currentPref(),
        set: function (p) {
          this.pref = p;
          try {
            localStorage.setItem('theme', p);
          } catch (e) {
            /* storage unavailable */
          }
          applyTheme(p);
          if (document.body.dataset.authenticated === '1') {
            api('/account/preferences', { method: 'POST', body: { theme: p } }).catch(function () {});
          }
        },
        isPref: function (p) {
          return this.pref === p;
        },
      };
    });

    Alpine.data('drawer', function () {
      return {
        open: false,
        toggle: function () {
          this.open = !this.open;
        },
        close: function () {
          this.open = false;
        },
      };
    });

    Alpine.data('dropdown', function () {
      return {
        open: false,
        toggle: function () {
          this.open = !this.open;
        },
        close: function () {
          this.open = false;
        },
      };
    });

    Alpine.data('passwordField', function () {
      return {
        show: false,
        toggle: function () {
          this.show = !this.show;
        },
        type: function () {
          return this.show ? 'text' : 'password';
        },
        label: function () {
          return this.show ? 'Hide' : 'Show';
        },
      };
    });

    Alpine.data('tabs', function (initial) {
      return {
        active: initial || '',
        select: function (t) {
          this.active = t;
        },
        is: function (t) {
          return this.active === t;
        },
      };
    });

    Alpine.data('dismissible', function () {
      return {
        shown: true,
        dismiss: function () {
          this.shown = false;
        },
      };
    });

    Alpine.data('colorField', function (initial) {
      return {
        value: initial || '#1f4fd1',
        sync: function (e) {
          this.value = e.target.value;
        },
      };
    });
  });

  /* Follow OS theme changes when preference is "system". */
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (currentPref() === 'system') applyTheme('system');
    });
  }
})();
