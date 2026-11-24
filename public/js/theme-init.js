/* Runs synchronously in <head> to set light/dark before first paint (no flash).
   Signed-in users: the preference stored on their account wins (follows them across devices). */
(function () {
  var root = document.documentElement;
  var pref = root.getAttribute('data-theme-pref') || 'system';
  if (root.getAttribute('data-theme-source') !== 'user') {
    try {
      pref = localStorage.getItem('theme') || pref;
    } catch (e) {
      /* storage unavailable */
    }
  } else {
    try {
      localStorage.setItem('theme', pref);
    } catch (e) {
      /* storage unavailable */
    }
  }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) root.classList.add('dark');
})();
