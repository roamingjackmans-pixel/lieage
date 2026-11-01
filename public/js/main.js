// Lieage: the home screen, and getting into a game, either as the game screen (screen.js) or as a player on
// a phone (phone.js). Also gets a reloaded tab straight back into its game.
import { Room, cleanCode } from './net.js';
import { $, esc, store, tabStore, rid, pick, modal } from './ui.js';
import { AVATARS, PLAYER_NAMES } from './looks.js';
import { sfx, unlock } from './audio.js';
import * as Screen from './screen.js';
import * as Phone from './phone.js';

const RECENT = 3 * 3600 * 1000;   // a saved game older than this is forgotten
const TAB = tabStore.get('lg_tab') || (() => { const t = rid(8); tabStore.set('lg_tab', t); return t; })();
const profile = { name: store.get('lg_name', ''), av: store.get('lg_av', '') || pick(AVATARS) };
store.set('lg_av', profile.av);
let current = null;   // the Room we're in
// in the browser console: lgTrace() shows how this tab's connection went
window.lgTrace = () => (current && current.trace ? current.trace.join(' | ') : '');

/** The player id to use in a game: this tab's id, or the seat this browser had there before. */
const seatFor = code => tabStore.get('lg_pid') || store.get('lg_seat_' + code, '') || rid();
function saveSeat(code, pid) {
  tabStore.set('lg_pid', pid);
  store.set('lg_seat_' + code, pid);
}

// ---------------------------------------------------------------- the question bank (game screen only)
let bankP = null;
function loadBank() {
  bankP ||= import('./prompts.js').then(m => {
    const bank = m.PROMPTS;
    const byId = new Map(bank.map(p => [p.id, p]));
    let seen = new Set(store.get('lg_seen', []).filter(id => byId.has(id)));
    if (bank.length - seen.size < 40) seen = new Set();   // shown nearly everything: start over
    return { bank, byId, seen, rand: Math.random, saveSeen() { store.set('lg_seen', [...this.seen].slice(-5000)); } };
  }).catch(e => { bankP = null; throw e; });
  return bankP;
}

// ---------------------------------------------------------------- home screen
const nameInput = $('#nameInput'), codeInput = $('#codeInput');
nameInput.value = profile.name;
$('#avatarBtn').textContent = profile.av;
nameInput.addEventListener('input', () => { profile.name = nameInput.value.trim().slice(0, 16); store.set('lg_name', profile.name); });
$('#avatarBtn').onclick = () => {
  unlock();
  modal((el, close) => {
    el.innerHTML = `<h2>Pick your look</h2><div class="avatars">${AVATARS.map(a => `<button class="${a === profile.av ? 'on' : ''}" data-av="${a}">${a}</button>`).join('')}</div>`;
    el.querySelectorAll('[data-av]').forEach(b => b.onclick = () => {
      profile.av = b.dataset.av;
      store.set('lg_av', profile.av);
      $('#avatarBtn').textContent = profile.av;
      sfx.click();
      close();
    });
  });
};
codeInput.addEventListener('input', () => { codeInput.value = cleanCode(codeInput.value); });
$('#joinForm').onsubmit = e => { e.preventDefault(); join(codeInput.value); };
$('#hostBtn').onclick = () => host();
const ver = window.LG_VERSION;
if (ver) $('#buildTag').textContent = `v${ver.version}${ver.commit && ver.commit !== 'dev' ? ' · ' + ver.commit : ''}`;

function homeMsg(text, ok) {
  const m = $('#homeMsg');
  m.textContent = text || '';
  m.classList.toggle('ok', !!ok);
}
function setBusy(b) { $('#hostBtn').disabled = b; $('#joinBtn').disabled = b; $('#resumeBtn').disabled = b; }

function showHome(msg, code) {
  current = null;
  $('#screen').hidden = true;
  $('#phone').hidden = true;
  $('#home').hidden = false;
  $('#tvStatus').hidden = true;
  $('#phStatus').hidden = true;
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  document.title = 'Lieage | josephjackman.com';
  homeMsg('');
  if (code) codeInput.value = code;
  showResume();
  if (msg) {
    modal((el, close) => {
      el.innerHTML = `<h2>Game over</h2><p>${esc(msg)}</p><div class="row"><button class="btn" data-ok>OK</button>${code ? '<button class="btn primary" data-retry>Try to rejoin</button>' : ''}</div>`;
      el.querySelector('[data-ok]').onclick = close;
      const r = el.querySelector('[data-retry]');
      if (r) r.onclick = () => { close(); join(code); };
    });
  }
}

/** A game this browser was hosting not long ago can be picked back up (e.g. after closing the tab). */
function showResume() {
  const saved = store.get('lg_last_host', null);
  const btn = $('#resumeBtn');
  // a game screen that's still open saves every few seconds: only offer games whose screen has gone quiet
  const age = saved ? Date.now() - saved.at : 0;
  if (!saved || !saved.state || age > RECENT || age < 12000) { btn.hidden = true; return; }
  const mins = Math.max(1, Math.round((Date.now() - saved.at) / 60000));
  btn.hidden = false;
  btn.textContent = `↩ Resume game ${saved.state.code} on this screen (${mins < 60 ? mins + ' min' : Math.round(mins / 60) + ' h'} ago)`;
  btn.onclick = () => { unlock(); resumeHost(saved.state); };
}

function exit(msg, code) { showHome(msg, code); }

function readProfile() {
  let name = nameInput.value.trim().slice(0, 16);
  if (!name) { name = pick(PLAYER_NAMES); nameInput.value = name; }
  profile.name = name;
  store.set('lg_name', name);
}

// ---------------------------------------------------------------- hosting
async function host() {
  unlock(); sfx.click();
  setBusy(true);
  homeMsg('Setting up the game screen…', true);
  try {
    const ctx = await loadBank();
    const room = new Room({ pid: 'screen-' + rid(10), tab: TAB, name: 'Game screen' }, ctx);
    const code = await room.create(store.get('lg_settings', {}));
    current = room;
    Screen.mount(room, ctx, exit);
    setUrl(code);
  } catch (e) {
    console.warn(e);
    homeMsg(e.message || 'Could not set up a game. Check your internet and try again.');
  } finally { setBusy(false); }
}

async function resumeHost(state) {
  setBusy(true);
  try {
    const ctx = await loadBank();
    const room = new Room({ pid: state.hostPid, tab: TAB, name: 'Game screen' }, ctx);
    current = room;
    Screen.mount(room, ctx, exit);
    setUrl(state.code);
    room.resumeHost(state);
  } catch (e) {
    console.warn(e);
    homeMsg('Could not load the questions. Check your internet and reload.');
  } finally { setBusy(false); }
}

function setUrl(code) {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  void code;
}

// ---------------------------------------------------------------- joining
async function join(raw) {
  unlock(); sfx.click();
  const code = cleanCode(raw);
  if (code.length !== 5) { homeMsg('Game codes are 5 numbers'); codeInput.focus(); return; }
  readProfile();
  setBusy(true);
  homeMsg(`Looking for game ${code}…`, true);
  let pid = seatFor(code);
  for (let attempt = 0; attempt < 2; attempt++) {
    const room = new Room({ pid, tab: TAB, name: profile.name, av: profile.av });
    current = room;
    const off = room.on('progress', msg => homeMsg(msg, true));
    try {
      await room.join(code);
      off();
      saveSeat(code, pid);
      tabStore.set('lg_play', { code, pid, at: Date.now() });
      Phone.mount(room, exit);
      const url = new URL(location.href);
      url.searchParams.set('room', code);
      history.replaceState(null, '', url);
      document.title = `Lieage · ${code}`;
      sfx.join();
      setBusy(false);
      return;
    } catch (e) {
      off();
      try { room.drop(); } catch { }
      current = null;
      if (e.code === 'dup' && attempt === 0) { pid = rid(); tabStore.set('lg_pid', pid); continue; }
      homeMsg(e.message || 'Could not join that game');
      break;
    }
  }
  setBusy(false);
}

/** A phone that reloaded mid-game goes straight back in. */
function rejoin(saved) {
  const room = new Room({ pid: saved.pid, tab: TAB, name: profile.name || pick(PLAYER_NAMES), av: profile.av });
  current = room;
  Phone.mount(room, exit);
  document.title = `Lieage · ${saved.code}`;
  room.rejoin(saved.code);
}

// ---------------------------------------------------------------- start up
window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
(function boot() {
  const hosted = tabStore.get('lg_host', null);
  if (hosted && hosted.state && Date.now() - hosted.at < RECENT) { resumeHost(hosted.state); return; }
  const played = tabStore.get('lg_play', null);
  const roomParam = cleanCode(new URL(location.href).searchParams.get('room'));
  if (played && played.code && Date.now() - played.at < RECENT && (!roomParam || roomParam === played.code)) { rejoin(played); return; }
  showHome();
  if (roomParam.length === 5) {
    codeInput.value = roomParam;
    if (!profile.name) nameInput.focus();
    homeMsg('Enter your name and tap Join', true);
  }
})();
