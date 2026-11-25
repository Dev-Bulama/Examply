/* EXAMPLY — calm background music for the exam player.
 *
 * Original, generated in the browser with the Web Audio API (no audio files, nothing to license or download):
 * a slow pad of soft chords through a low-pass filter and a generated reverb, with an occasional quiet
 * "music box" note from a pentatonic scale. Off by default; the candidate switches it on. The choice and the
 * volume are remembered on this device. Markup:
 *
 *   <div data-ambient>
 *     <button type="button" data-ambient-toggle aria-pressed="false">…</button>
 *     <input type="range" data-ambient-volume min="0" max="100">
 *   </div>
 */
(function () {
  'use strict';

  var KEY = 'examply.music';
  var AC = window.AudioContext || window.webkitAudioContext;
  var roots = document.querySelectorAll('[data-ambient]');
  if (!roots.length) return;
  if (!AC) {
    Array.prototype.forEach.call(roots, function (r) {
      r.hidden = true;
    });
    return;
  }

  var prefs = { on: false, volume: 35 };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) prefs = { on: !!saved.on, volume: Math.max(0, Math.min(100, Number(saved.volume) || 35)) };
  } catch (e) {
    /* private mode */
  }
  var save = function () {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch (e) {
      /* ignore */
    }
  };

  var ctx = null;
  var master = null;
  var bus = null;
  var timers = [];
  var playing = false;

  var midi = function (n) {
    return 440 * Math.pow(2, (n - 69) / 12);
  };
  var level = function () {
    // Perceptual curve; full slider is still quiet background level.
    var v = prefs.volume / 100;
    return 0.22 * v * v;
  };

  function impulse(seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch += 1) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i += 1) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function build() {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.Q.value = 0.3;
    var verb = ctx.createConvolver();
    verb.buffer = impulse(4.5, 2.6);
    var wet = ctx.createGain();
    wet.gain.value = 0.55;
    var dry = ctx.createGain();
    dry.gain.value = 0.6;
    bus = ctx.createGain();
    bus.connect(lp);
    lp.connect(dry);
    lp.connect(verb);
    verb.connect(wet);
    dry.connect(master);
    wet.connect(master);
  }

  // Cmaj9 → Am9 → Fmaj7(#11) → G6sus — slow, unresolved, unobtrusive.
  var CHORDS = [
    [48, 55, 59, 62, 64],
    [45, 52, 55, 59, 60],
    [41, 48, 52, 55, 59],
    [43, 50, 52, 57, 62],
  ];
  var BAR = 9; // seconds per chord
  var PENTA = [72, 74, 76, 79, 81, 84];

  function pad(notes, at) {
    notes.forEach(function (n, i) {
      ['sine', 'triangle'].forEach(function (type, k) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = type;
        o.frequency.value = midi(n);
        o.detune.value = (k ? 6 : -6) + (Math.random() * 4 - 2);
        var peak = (k ? 0.018 : 0.03) * (i === 0 ? 1.2 : 1);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(peak, at + 3.2);
        g.gain.setValueAtTime(peak, at + BAR - 1);
        g.gain.linearRampToValueAtTime(0, at + BAR + 3);
        o.connect(g);
        g.connect(bus);
        o.start(at);
        o.stop(at + BAR + 3.2);
      });
    });
  }

  function bell(at) {
    var n = PENTA[Math.floor(Math.random() * PENTA.length)];
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = midi(n);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.03, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 3.5);
    o.connect(g);
    g.connect(bus);
    o.start(at);
    o.stop(at + 3.6);
  }

  var bar = 0;
  function schedule() {
    if (!playing) return;
    var at = ctx.currentTime + 0.1;
    pad(CHORDS[bar % CHORDS.length], at);
    var bells = Math.random() < 0.7 ? 1 + Math.floor(Math.random() * 2) : 0;
    for (var b = 0; b < bells; b += 1) bell(at + 1.5 + Math.random() * (BAR - 3));
    bar += 1;
    timers.push(setTimeout(schedule, BAR * 1000));
  }

  function fadeTo(value, seconds) {
    var now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(value, now + seconds);
  }

  function start() {
    if (playing) return;
    if (!ctx) build();
    if (ctx.state === 'suspended') ctx.resume();
    playing = true;
    schedule();
    fadeTo(level(), 4);
    render();
  }

  function stop() {
    if (!playing) return;
    playing = false;
    timers.forEach(clearTimeout);
    timers = [];
    fadeTo(0, 1.5);
    setTimeout(function () {
      if (!playing && ctx) ctx.suspend();
    }, 1700);
    render();
  }

  function render() {
    Array.prototype.forEach.call(roots, function (r) {
      var btn = r.querySelector('[data-ambient-toggle]');
      var vol = r.querySelector('[data-ambient-volume]');
      if (btn) {
        btn.setAttribute('aria-pressed', playing ? 'true' : 'false');
        btn.setAttribute('title', playing ? 'Turn calm music off' : 'Play calm background music');
        btn.classList.toggle('text-secondary-600', playing);
      }
      if (vol) {
        vol.value = String(prefs.volume);
        vol.hidden = !playing;
      }
    });
  }

  Array.prototype.forEach.call(roots, function (r) {
    var btn = r.querySelector('[data-ambient-toggle]');
    var vol = r.querySelector('[data-ambient-volume]');
    if (btn)
      btn.addEventListener('click', function () {
        prefs.on = !playing;
        save();
        if (prefs.on) start();
        else stop();
      });
    if (vol)
      vol.addEventListener('input', function () {
        prefs.volume = Number(vol.value);
        save();
        if (playing) fadeTo(level(), 0.3);
      });
  });

  // Browsers only allow audio after a user gesture: resume the candidate's choice on their first interaction.
  if (prefs.on) {
    var resume = function () {
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      if (prefs.on) start();
    };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
  }

  // Quiet while the tab is hidden; back when it returns.
  document.addEventListener('visibilitychange', function () {
    if (!ctx || !playing) return;
    if (document.hidden) fadeTo(0, 0.4);
    else fadeTo(level(), 1.2);
  });

  // Stop when the exam is submitted (the form posts away) and when the page unloads.
  window.addEventListener('pagehide', function () {
    if (ctx) ctx.close();
  });
  window.examplyMusic = { start: start, stop: stop };
  render();
})();
