// Little synthesized sound effects (the same idea as Horse Race's). Nothing loads; everything is made with
// WebAudio on the fly. Mostly the game screen makes noise; phones just click and buzz.
let ac = null, master = null;
let muted = false;
try { muted = localStorage.getItem('lg_muted') === '1'; } catch { }

export function isMuted() { return muted; }
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem('lg_muted', muted ? '1' : '0'); } catch { }
  if (master) master.gain.value = muted ? 0 : 0.5;
}

/** Call from a click/tap: browsers only allow sound after someone has touched the page. */
export function unlock() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
}

function tone(freq, dur, { type = 'sine', vol = 0.3, at = 0, slide = 0, attack = 0.005 } = {}) {
  if (!ac || muted) return;
  const t0 = ac.currentTime + at;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

function noise(dur, { vol = 0.2, at = 0, freq = 1200, q = 1, type = 'bandpass', attack = 0.01 } = {}) {
  if (!ac || muted) return;
  const t0 = ac.currentTime + at;
  const len = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource(); src.buffer = buf;
  const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur + 0.05);
}

export const sfx = {
  click() { tone(660, 0.06, { type: 'triangle', vol: 0.12 }); },
  pick() { tone(523, 0.08, { type: 'triangle', vol: 0.18 }); tone(784, 0.12, { type: 'triangle', vol: 0.18, at: 0.06 }); },
  join() { tone(392, 0.09, { type: 'sine', vol: 0.18 }); tone(587, 0.1, { type: 'sine', vol: 0.18, at: 0.07 }); tone(784, 0.16, { type: 'sine', vol: 0.16, at: 0.14 }); },
  done() { tone(880, 0.07, { type: 'triangle', vol: 0.12 }); tone(1175, 0.1, { type: 'triangle', vol: 0.1, at: 0.05 }); },
  tick(last) { tone(last ? 990 : 740, 0.07, { type: 'square', vol: 0.06 }); },
  whoosh() { noise(0.45, { vol: 0.18, freq: 700, q: 0.6, attack: 0.2 }); },
  card() { noise(0.08, { vol: 0.12, freq: 2400, q: 1.5 }); tone(330, 0.08, { type: 'triangle', vol: 0.06 }); },
  pop() { tone(500, 0.07, { type: 'sine', vol: 0.14, slide: 1.8 }); },
  lie() {
    // a rude buzzer
    tone(155, 0.55, { type: 'sawtooth', vol: 0.16, attack: 0.01 });
    tone(160, 0.55, { type: 'square', vol: 0.08, attack: 0.01 });
    noise(0.15, { vol: 0.2, freq: 300, q: 0.8, type: 'lowpass' });
  },
  truth() {
    // a bright chime, then a little sparkle
    [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.5, { type: 'triangle', vol: 0.15, at: i * 0.08 }));
    [2093, 2637].forEach((f, i) => tone(f, 0.3, { type: 'sine', vol: 0.05, at: 0.35 + i * 0.07 }));
  },
  nobody() { [392, 370, 349, 311].forEach((f, i) => tone(f, i === 3 ? 0.55 : 0.2, { type: 'sawtooth', vol: 0.08, at: i * 0.18, slide: i === 3 ? 0.9 : 1, attack: 0.03 })); },
  drum() { for (let i = 0; i < 14; i++) noise(0.06, { vol: 0.05 + i * 0.006, freq: 180, q: 1.2, at: i * 0.07 }); },
  round() {
    const n = [523, 659, 784, 1047];
    n.forEach((f, i) => { tone(f, 0.22, { type: 'sawtooth', vol: 0.07, at: i * 0.11, attack: 0.02 }); tone(f / 2, 0.22, { type: 'triangle', vol: 0.08, at: i * 0.11 }); });
  },
  fanfare() {
    const n = [392, 523, 659, 784, 659, 784, 1047];
    const d = [0.12, 0.12, 0.12, 0.3, 0.12, 0.2, 0.6];
    let at = 0;
    n.forEach((f, i) => { tone(f, d[i] + 0.05, { type: 'sawtooth', vol: 0.08, at, attack: 0.02 }); tone(f * 2, d[i], { type: 'square', vol: 0.02, at }); at += d[i]; });
    noise(2.2, { vol: 0.16, freq: 1500, q: 0.4, attack: 0.3, at: 0.4 });
  },
  buzz() { try { navigator.vibrate && navigator.vibrate(60); } catch { } },
};
