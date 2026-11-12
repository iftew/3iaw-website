// Sci-fi click sound on links, buttons and tabs, made with the Web Audio API (no sound files).
(function(){
  let ctx = null;

  function audio(){
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // a short two-step digital chirp with a fast warble, like a ship console button
  function blip(pitch){
    const a = audio();
    if (!a) return;
    const t = a.currentTime;

    const out = a.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.09, t + 0.005);
    out.gain.setValueAtTime(0.09, t + 0.045);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

    const filter = a.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(4200, t);
    filter.Q.value = 6;
    filter.connect(out).connect(a.destination);

    // main voice: jumps up a fifth halfway, then glides higher
    const voice = a.createOscillator();
    voice.type = 'square';
    voice.frequency.setValueAtTime(880 * pitch, t);
    voice.frequency.setValueAtTime(1320 * pitch, t + 0.035);
    voice.frequency.exponentialRampToValueAtTime(1980 * pitch, t + 0.13);
    const voiceGain = a.createGain();
    voiceGain.gain.value = 0.35;
    voice.connect(voiceGain).connect(filter);

    // warble: a fast vibrato for the "computer" feel
    const lfo = a.createOscillator();
    const depth = a.createGain();
    lfo.frequency.value = 55;
    depth.gain.value = 60 * pitch;
    lfo.connect(depth).connect(voice.frequency);

    // shimmer: a quiet high sine an octave up
    const shimmer = a.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.setValueAtTime(2640 * pitch, t);
    shimmer.frequency.exponentialRampToValueAtTime(3960 * pitch, t + 0.1);
    const shimmerGain = a.createGain();
    shimmerGain.gain.value = 0.5;
    shimmer.connect(shimmerGain).connect(filter);

    [voice, lfo, shimmer].forEach(function(o){ o.start(t); o.stop(t + 0.15); });
  }

  document.addEventListener('pointerdown', function(e){
    if (e.button > 0) return;
    const el = e.target.closest('a, button, [role="tab"], summary, label, select, .btn');
    if (!el || el.disabled) return;
    // main buttons get a slightly deeper chirp than links
    blip(el.matches('.btn, button, [role="tab"]') ? 0.8 : 1);
  }, { passive: true });
})();
