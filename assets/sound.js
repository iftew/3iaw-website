// Soft click sound on links, buttons and tabs, made with the Web Audio API (no sound files).
// The speaker button in the header turns it off and on; the choice is remembered on this device.
(function(){
  const KEY = '3iaw-sound';
  const btn = document.getElementById('soundToggle');
  let on = true;
  try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) {}
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

  // a short glassy "tick": a quick pitch drop plus a tiny bright overtone
  function click(pitch){
    const a = audio();
    if (!a) return;
    const t = a.currentTime;
    const out = a.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.11, t + 0.004);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    out.connect(a.destination);

    const body = a.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(1150 * pitch, t);
    body.frequency.exponentialRampToValueAtTime(420 * pitch, t + 0.07);
    body.connect(out);

    const shine = a.createOscillator();
    const shineGain = a.createGain();
    shine.type = 'sine';
    shine.frequency.setValueAtTime(3200 * pitch, t);
    shineGain.gain.setValueAtTime(0.25, t);
    shineGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    shine.connect(shineGain).connect(out);

    body.start(t); shine.start(t);
    body.stop(t + 0.1); shine.stop(t + 0.04);
  }

  function paint(){
    if (!btn) return;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Turn click sounds off' : 'Turn click sounds on');
    btn.classList.toggle('muted', !on);
  }
  paint();

  if (btn) btn.addEventListener('click', function(){
    on = !on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {}
    paint();
    if (on) click(1.25);
  });

  document.addEventListener('pointerdown', function(e){
    if (!on || e.button > 0) return;
    const el = e.target.closest('a, button, [role="tab"], summary, label, select, .btn');
    if (!el || el === btn || el.disabled) return;
    // main buttons get a slightly deeper click than links
    click(el.matches('.btn, button, [role="tab"]') ? 0.85 : 1);
  }, { passive: true });
})();
