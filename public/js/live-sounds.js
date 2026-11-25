/* EXAMPLY — live quiz game sounds.
 *
 * Original sounds synthesised in the browser with the Web Audio API (no audio files, nothing to license):
 * lobby music, a join "pop", a question-start whoosh, countdown ticks, correct / wrong cues, a reveal sting,
 * a leaderboard roll and a podium fanfare. On by default; one mute button; the choice is remembered.
 *
 *   LiveSfx.play('correct')        one-shot cue
 *   LiveSfx.music('lobby' | 'question' | null)
 *   LiveSfx.bindToggle(button)     mute / unmute button (aria-pressed = sound on)
 */
(function () {
  'use strict';

  var AC = window.AudioContext || window.webkitAudioContext;
  var KEY = 'examply.liveSound';
  var LOUD = 1.6; // master level (was 0.6)
  var BOOST = 1.7; // every cue
  var muted = false;
  try {
    muted = localStorage.getItem(KEY) === 'off';
  } catch (e) {
    /* private mode */
  }
  var ctx = null;
  var master = null;
  var musicGain = null;
  var current = null; // { name, timer }
  var wanted = null; // music requested before audio was unlocked
  var buttons = [];

  function ensure() {
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      // Loud and punchy, with a compressor/limiter so it never distorts on phone speakers.
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 8;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      comp.connect(ctx.destination);
      master = ctx.createGain();
      master.gain.value = muted ? 0 : LOUD;
      master.connect(comp);
      musicGain = ctx.createGain();
      musicGain.gain.value = 0.5;
      musicGain.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Browsers allow audio only after a user gesture: unlock on the first tap or key press.
  function unlock() {
    if (!ensure()) return;
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
    if (wanted) music(wanted);
  }
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);

  var hz = function (m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  };

  function tone(opts) {
    if (!ctx || muted) return;
    var t = ctx.currentTime + (opts.at || 0);
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.f, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + (opts.d || 0.2));
    var v = Math.min(0.95, (opts.v === undefined ? 0.3 : opts.v) * BOOST);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + (opts.a || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (opts.d || 0.2));
    o.connect(g);
    g.connect(opts.out || master);
    o.start(t);
    o.stop(t + (opts.d || 0.2) + 0.05);
  }

  function noise(opts) {
    if (!ctx || muted) return;
    var t = ctx.currentTime + (opts.at || 0);
    var len = Math.floor(ctx.sampleRate * (opts.d || 0.3));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = opts.filter || 'bandpass';
    f.frequency.setValueAtTime(opts.f || 1200, t);
    if (opts.to) f.frequency.exponentialRampToValueAtTime(opts.to, t + (opts.d || 0.3));
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.min(0.95, (opts.v || 0.2) * BOOST), t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (opts.d || 0.3));
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t);
  }

  var SOUNDS = {
    join: function () {
      tone({ f: 520, to: 980, d: 0.12, type: 'sine', v: 0.25 });
    },
    start: function () {
      noise({ f: 400, to: 3000, d: 0.35, v: 0.12 });
      [72, 76, 79, 84].forEach(function (m, i) {
        tone({ f: hz(m), at: 0.05 + i * 0.07, d: 0.22, type: 'triangle', v: 0.22 });
      });
    },
    alert: function () {
      tone({ f: 988, d: 0.12, type: 'square', v: 0.16 });
      tone({ f: 740, at: 0.14, d: 0.18, type: 'square', v: 0.16 });
    },
    pop: function () {
      tone({ f: 880, to: 1320, d: 0.07, type: 'sine', v: 0.1 });
    },
    badge: function () {
      [79, 83, 86, 91].forEach(function (m, i) {
        tone({ f: hz(m), at: i * 0.06, d: 0.25, type: 'triangle', v: 0.16 });
      });
      noise({ f: 8000, filter: 'highpass', at: 0.18, d: 0.3, v: 0.05 });
    },
    rankup: function () {
      tone({ f: hz(72), d: 0.12, type: 'square', v: 0.1 });
      tone({ f: hz(79), at: 0.1, d: 0.22, type: 'square', v: 0.12 });
    },
    tick: function () {
      tone({ f: 1250, d: 0.05, type: 'square', v: 0.08 });
    },
    tickLast: function () {
      tone({ f: 1650, d: 0.08, type: 'square', v: 0.1 });
    },
    locked: function () {
      tone({ f: hz(76), d: 0.12, type: 'sine', v: 0.18 });
      tone({ f: hz(81), at: 0.08, d: 0.16, type: 'sine', v: 0.18 });
    },
    correct: function () {
      [76, 80, 83, 88].forEach(function (m, i) {
        tone({ f: hz(m), at: i * 0.08, d: 0.35, type: 'triangle', v: 0.25 });
      });
    },
    wrong: function () {
      tone({ f: 240, to: 120, d: 0.45, type: 'sawtooth', v: 0.12 });
      tone({ f: 180, to: 90, at: 0.05, d: 0.45, type: 'square', v: 0.06 });
    },
    reveal: function () {
      [60, 64, 67, 72].forEach(function (m) {
        tone({ f: hz(m), d: 0.9, a: 0.04, type: 'triangle', v: 0.12 });
      });
      noise({ f: 6000, filter: 'highpass', d: 0.4, v: 0.06 });
    },
    leaderboard: function () {
      for (var i = 0; i < 10; i += 1) noise({ f: 180, filter: 'lowpass', at: i * 0.06, d: 0.08, v: 0.18 });
      [67, 71, 74].forEach(function (m) {
        tone({ f: hz(m), at: 0.62, d: 0.5, type: 'triangle', v: 0.15 });
      });
    },
    fanfare: function () {
      var notes = [
        [67, 0, 0.18],
        [72, 0.18, 0.18],
        [76, 0.36, 0.18],
        [79, 0.54, 0.4],
        [76, 0.96, 0.14],
        [79, 1.1, 0.9],
      ];
      notes.forEach(function (n) {
        tone({ f: hz(n[0]), at: n[1], d: n[2] + 0.1, type: 'sawtooth', v: 0.1 });
        tone({ f: hz(n[0] - 12), at: n[1], d: n[2] + 0.1, type: 'triangle', v: 0.12 });
      });
      [60, 64, 67, 72].forEach(function (m) {
        tone({ f: hz(m), at: 1.1, d: 1.6, a: 0.05, type: 'triangle', v: 0.08 });
      });
      noise({ f: 7000, filter: 'highpass', at: 1.1, d: 1.2, v: 0.05 });
    },
    end: function () {
      [72, 67, 64, 60].forEach(function (m, i) {
        tone({ f: hz(m), at: i * 0.12, d: 0.3, type: 'triangle', v: 0.18 });
      });
    },
  };

  // Simple, original loops: an upbeat pentatonic lobby groove and a pulsing "thinking" bed for questions.
  var LOOPS = {
    lobby: { bpm: 112, bass: [48, 48, 55, 55, 53, 53, 50, 52], lead: [72, 0, 76, 79, 0, 76, 74, 0, 72, 74, 76, 0, 79, 81, 79, 76] },
    question: { bpm: 128, bass: [45, 45, 45, 45, 48, 48, 47, 47], lead: [0, 81, 0, 0, 0, 81, 0, 84, 0, 81, 0, 0, 0, 79, 0, 76] },
  };

  function music(name) {
    wanted = name;
    if (current && current.name === name) return;
    if (current) {
      clearInterval(current.timer);
      current = null;
    }
    if (!name || !ctx || muted) return;
    var L = LOOPS[name];
    var step = 60 / L.bpm / 2; // eighth notes
    var i = 0;
    var tick = function () {
      if (!ctx || muted) return;
      var b = L.bass[Math.floor(i / 2) % L.bass.length];
      if (i % 2 === 0) tone({ f: hz(b), d: step * 1.8, type: 'triangle', v: 0.35, out: musicGain });
      var n = L.lead[i % L.lead.length];
      if (n) tone({ f: hz(n), d: step * 0.9, type: 'sine', v: 0.18, out: musicGain });
      if (name === 'question' && i % 4 === 0) noise({ f: 90, filter: 'lowpass', d: 0.08, v: 0.08 });
      i += 1;
    };
    tick();
    current = { name: name, timer: setInterval(tick, step * 1000) };
  }

  function render() {
    buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', muted ? 'false' : 'true');
      b.setAttribute('aria-label', muted ? 'Turn game sounds on' : 'Mute game sounds');
      b.textContent = muted ? '🔇' : '🔊';
    });
  }

  function setMuted(m) {
    muted = !!m;
    try {
      localStorage.setItem(KEY, muted ? 'off' : 'on');
    } catch (e) {
      /* ignore */
    }
    if (master) master.gain.value = muted ? 0 : LOUD;
    if (muted && current) {
      clearInterval(current.timer);
      current = null;
    } else if (!muted && wanted) {
      ensure();
      music(wanted);
    }
    render();
  }

  window.LiveSfx = {
    play: function (name) {
      if (muted || !SOUNDS[name]) return;
      if (!ensure() || ctx.state !== 'running') return;
      try {
        SOUNDS[name]();
      } catch (e) {
        /* never break the game for a sound */
      }
    },
    music: music,
    setMuted: setMuted,
    isMuted: function () {
      return muted;
    },
    bindToggle: function (btn) {
      if (!btn) return;
      if (!AC) {
        btn.hidden = true;
        return;
      }
      buttons.push(btn);
      btn.addEventListener('click', function () {
        setMuted(!muted);
      });
      render();
    },
  };
  // Pause sounds while the tab is hidden.
  document.addEventListener('visibilitychange', function () {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else if (!muted) ctx.resume();
  });
})();
