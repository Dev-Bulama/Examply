/* EXAMPLY — anti-cheat signals shared by the exam player and the live quiz.
 *
 *   ExamplyIntegrity.watch({
 *     report: function (type, details) {},  // send the event to the server
 *     skipTab: false,      // the caller already reports tab_hidden itself (exam player)
 *     blockCopy: true,     // stop copy / cut / paste / right-click / text dragging (and report it)
 *     blockDevtools: true, // stop F12 / Ctrl+Shift+I and report developer tools
 *     message: 'Leaving the game is reported to the host.'
 *   })
 *
 * Signals (all best-effort: browsers do not expose everything, and nothing here can be fully tamper-proof):
 *   tab_hidden / tab_return {away_ms}   switched tab or app, locked the phone, swiped home
 *   window_blur {away_ms}               another window or app took focus while the page stayed visible
 *   split_screen {width, screen}        the window was made much smaller than the screen (split view, side apps)
 *   screenshot_key                      PrintScreen or the macOS screenshot shortcuts
 *   devtools                            developer tools shortcuts, or the tools opened beside the page
 *   print                               the print dialog
 *   copy / paste / context_menu         when blockCopy is on
 *   offline                             the device went offline
 * Each signal also shows the taker a short warning, so they know it was recorded.
 */
(function () {
  'use strict';

  var started = false;

  function banner(message) {
    var el = document.getElementById('integrity-warning');
    if (!el) {
      el = document.createElement('div');
      el.id = 'integrity-warning';
      el.setAttribute('role', 'alert');
      el.className = 'fixed inset-x-0 top-0 z-[70] bg-red-600 px-4 py-3 text-center text-sm font-semibold text-white shadow-pop';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.hidden = true;
    }, 6000);
  }

  function watch(opts) {
    if (started) return;
    started = true;
    var o = opts || {};
    var count = 0;
    var last = {};
    var report = function (type, details, warnText) {
      // At most one report of the same kind every 2 seconds (blur + hidden often fire together).
      var now = Date.now();
      if (last[type] && now - last[type] < 2000) return;
      last[type] = now;
      count += 1;
      try {
        o.report(type, details || null);
      } catch (e) {
        /* never break the page */
      }
      if (warnText !== false) banner('⚠ ' + (warnText || 'This was recorded.') + ' ' + (o.message || 'It is reported to the examiner.') + ' (' + count + ')');
    };

    // ---- Leaving: tab / app switch, locking the phone, swiping home
    var hiddenAt = null;
    var unloading = false;
    window.addEventListener('pagehide', function () {
      unloading = true;
    });
    window.addEventListener('beforeunload', function () {
      unloading = true;
      setTimeout(function () {
        unloading = false;
      }, 1000);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        if (unloading) return;
        hiddenAt = Date.now();
        if (!o.skipTab) report('tab_hidden', null, false);
      } else if (hiddenAt) {
        var away = Date.now() - hiddenAt;
        hiddenAt = null;
        report('tab_return', { away_ms: away }, 'You left this page for ' + Math.max(1, Math.round(away / 1000)) + 's.');
      }
    });

    // ---- Focus lost while still visible: another window, a floating app, split view, notification shade
    var blurAt = null;
    window.addEventListener('blur', function () {
      if (document.visibilityState === 'visible') blurAt = Date.now();
    });
    window.addEventListener('focus', function () {
      if (!blurAt) return;
      var away = Date.now() - blurAt;
      blurAt = null;
      if (away >= 1500 && document.visibilityState === 'visible') report('window_blur', { away_ms: away }, 'You switched to another window for ' + Math.round(away / 1000) + 's.');
    });

    // ---- Split screen / shrunken window (desktop and tablets)
    var splitReported = false;
    var checkSplit = function () {
      var sw = (window.screen && window.screen.availWidth) || 0;
      if (!sw || sw < 700) return; // phones rotate and resize constantly
      var small = window.innerWidth < sw * 0.6;
      if (small && !splitReported) {
        splitReported = true;
        report('split_screen', { width: window.innerWidth, screen: sw }, 'The window was made smaller than the screen (split screen).');
      } else if (!small) splitReported = false;
    };
    window.addEventListener('resize', function () {
      clearTimeout(checkSplit._t);
      checkSplit._t = setTimeout(checkSplit, 800);
    });
    setTimeout(checkSplit, 1500);

    // ---- Keys: screenshots and developer tools
    document.addEventListener('keydown', function (e) {
      var k = (e.key || '').toLowerCase();
      if (k === 'printscreen' || (e.metaKey && e.shiftKey && ['3', '4', '5', 's'].indexOf(k) >= 0)) {
        report('screenshot_key', null, 'Screenshots are not allowed.');
        return;
      }
      if (o.blockDevtools !== false && (k === 'f12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].indexOf(k) >= 0) || (e.metaKey && e.altKey && ['i', 'j', 'c'].indexOf(k) >= 0) || ((e.ctrlKey || e.metaKey) && k === 'u'))) {
        e.preventDefault();
        report('devtools', { key: k }, 'Developer tools are not allowed.');
      }
    });
    document.addEventListener('keyup', function (e) {
      if ((e.key || '').toLowerCase() === 'printscreen') report('screenshot_key', null, 'Screenshots are not allowed.');
    });
    if (o.blockDevtools !== false) {
      var devOpen = false;
      setInterval(function () {
        var open = window.outerWidth - window.innerWidth > 200 || window.outerHeight - window.innerHeight > 260;
        if (open && !devOpen && window.screen && window.screen.availWidth >= 700) report('devtools', { docked: true }, 'Developer tools appear to be open.');
        devOpen = open;
      }, 2000);
    }
    window.addEventListener('beforeprint', function () {
      report('print', null, 'Printing is not allowed.');
    });

    // ---- Copy, paste, right-click, dragging text out
    if (o.blockCopy) {
      ['copy', 'cut', 'paste', 'contextmenu', 'dragstart'].forEach(function (t) {
        document.addEventListener(t, function (e) {
          if (t === 'paste' && e.target && e.target.matches && e.target.matches('input, textarea') && !o.blockPasteInInputs) return;
          e.preventDefault();
          report(t === 'contextmenu' ? 'context_menu' : t === 'cut' || t === 'dragstart' ? 'copy' : t, null, t === 'contextmenu' ? 'Right-click is disabled.' : 'Copying and pasting are disabled.');
        });
      });
      document.documentElement.style.webkitUserSelect = 'none';
      document.documentElement.style.userSelect = 'none';
    }

    window.addEventListener('offline', function () {
      report('offline', null, 'Your device went offline.');
    });
  }

  window.ExamplyIntegrity = { watch: watch };
})();
