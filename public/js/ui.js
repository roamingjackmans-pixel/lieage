// Small page helpers shared by the home screen, the game screen and the phone screen.

export const $ = sel => document.querySelector(sel);
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mkStore = area => ({
  get(k, d) { try { const v = area.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { area.setItem(k, JSON.stringify(v)); } catch { } },
  del(k) { try { area.removeItem(k); } catch { } },
});
const safe = name => { try { return window[name]; } catch { return null; } };
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
export const store = mkStore(safe('localStorage') || memory());
export const tabStore = mkStore(safe('sessionStorage') || memory());
export const rid = (n = 12) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''); };
export const pick = a => a[Math.floor(Math.random() * a.length)];
export const fmt = n => (n || 0).toLocaleString('en-US');
export const ordinal = n => n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

/** The question with its blank drawn in. The answer, if given, goes in the blank. */
export function blankify(q, fill) {
  const parts = String(q || '').split('_____');
  const blank = fill != null ? `<span class="blank filled">${esc(fill)}</span>` : '<span class="blank"></span>';
  return parts.map(esc).join(blank);
}

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, kind === 'err' ? 4200 : 3200);
}

const modalQueue = [];
let modalOpen = null;
/** Opens a modal. build(el, close) fills it in. Modals queue up one after another. */
export function modal(build, cls = '') {
  modalQueue.push({ build, cls });
  if (!modalOpen) nextModal();
}
function nextModal() {
  const root = $('#modal');
  const item = modalQueue.shift();
  if (!item) { modalOpen = null; root.classList.remove('open'); root.innerHTML = ''; return; }
  root.innerHTML = `<div class="card modal ${item.cls}" role="dialog" aria-modal="true"></div>`;
  root.classList.add('open');
  const el = root.firstElementChild;
  let closed = false;
  const close = () => { if (closed) return; closed = true; nextModal(); };
  modalOpen = { el, close };
  item.build(el, close);
  const f = el.querySelector('[autofocus]');
  if (f) setTimeout(() => f.focus(), 30);
}
export const closeModal = () => { if (modalOpen) modalOpen.close(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalOpen) modalOpen.close(); });
document.addEventListener('click', e => { if (modalOpen && e.target === $('#modal')) modalOpen.close(); });

export function confirmBox(title, text, yes, no, onYes) {
  modal((el, close) => {
    el.innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row"><button class="btn" data-no>${esc(no)}</button><button class="btn primary" data-yes>${esc(yes)}</button></div>`;
    el.querySelector('[data-no]').onclick = close;
    el.querySelector('[data-yes]').onclick = () => { close(); onYes(); };
  });
}

/** Seconds left on a timer that ends at `ends` (on the screen's clock), given the clock to read. */
export function secsLeft(s, now) {
  if (!s || !s.ends) return null;
  if (s.paused) return Math.ceil((s.left || 0) / 1000);
  return Math.max(0, Math.ceil((s.ends - now) / 1000));
}

// keep the screen on while in a game (phones and the TV laptop)
let wake = null;
export async function keepAwake(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) { await wake.release(); wake = null; }
  } catch { }
}
