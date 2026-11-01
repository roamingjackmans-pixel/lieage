// The game screen: the browser that hosts the game. It runs the rules (through net.js), shows everything on
// the big screen, and isn't a player. Everyone watches it; players act on their phones (phone.js).
import * as E from './engine.js';
import { $, esc, fmt, ordinal, blankify, toast, modal, confirmBox, secsLeft, keepAwake, store, tabStore } from './ui.js';
import { catOf } from './looks.js';
import { sfx, unlock, isMuted, setMuted } from './audio.js';

let room = null, ctx = null, exitFn = null;
let unsub = [], raf = 0, saveTimer = 0, beat = 0;
let stageKey = '', lastPhase = null, lastStepKey = '', lastTickSec = null, doneCount = 0;
let stepTimers = [], stepRafs = [];
let shownScores = null;   // scores as they were before the last question (for counting up)

const S = () => room && room.state;
const pl = (s, id) => s.players[id];
const avHtml = (p, cls = '') => `<span class="pav ${cls}" style="--pc:${p ? p.color : '#999'}">${esc(p ? p.av : '❔')}</span>`;
const who = (s, id) => { const p = pl(s, id); return p ? `${avHtml(p)}<b>${esc(p.name)}</b>` : '<b>Someone</b>'; };
const listJoin = arr => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);
const timed = { choose: 1, write: 1, vote: 1 };

export function mount(r, c, exit) {
  room = r; ctx = c; exitFn = exit;
  $('#home').hidden = true; $('#phone').hidden = true; $('#screen').hidden = false;
  document.body.classList.add('is-tv');
  stageKey = ''; lastPhase = null; lastStepKey = ''; doneCount = 0; shownScores = null;
  unsub = [
    room.on('state', onState),
    room.on('status', t => { const el = $('#tvStatus'); el.hidden = !t; el.textContent = t || ''; }),
    room.on('error', msg => toast(msg, 'err')),
    room.on('refused', r => toast(r.err, 'err')),
    room.on('joined', (pid, back) => { sfx.join(); const p = S() && S().players[pid]; if (p && !back && S().phase !== 'lobby') toast(`${p.name} joined the game`, 'good'); }),
    room.on('closed', msg => leave(msg)),
  ];
  keepAwake(true);
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('pagehide', onHide);
  raf = requestAnimationFrame(loop);
  // a heartbeat: other tabs only offer to resume this game once the heartbeat stops (main.js showResume)
  beat = setInterval(save, 4000);
  if (room.state) onState(room.state);
}

function unmount() {
  for (const u of unsub) u();
  unsub = [];
  clearInterval(beat);
  cancelAnimationFrame(raf);
  clearSteps();
  clearTimeout(saveTimer);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('pagehide', onHide);
  document.body.classList.remove('is-tv');
  keepAwake(false);
  room = null;
}

/** Leave the screen (the game is over or gone). */
function leave(msg) {
  tabStore.del('lg_host');
  store.del('lg_last_host');
  const r = room;
  unmount();
  if (r) r.drop();
  exitFn(msg);
}

function onHide() { if (room && room.isHost) { save(); room.drop(); } }

function save() {
  const s = S();
  if (!s || !room || !room.isHost) return;
  const saved = { state: s, at: Date.now() };
  tabStore.set('lg_host', saved);
  store.set('lg_last_host', saved);
}

// ---------------------------------------------------------------- buttons
$('#tvCode').onclick = async () => {
  if (!room) return;
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied!', 'good'); }
  catch { toast(`Go to ${location.host}${location.pathname} and enter ${room.code}`, 'good'); }
};
$('#tvPause').onclick = () => { unlock(); room && room.act({ k: 'pause' }); };
$('#tvSkip').onclick = () => { unlock(); room && room.act({ k: 'skip' }); };
const showMute = () => { $('#tvMute').textContent = isMuted() ? '🔇' : '🔊'; };
showMute();
$('#tvMute').onclick = () => { unlock(); setMuted(!isMuted()); showMute(); };
$('#tvFull').onclick = () => toggleFull();
$('#tvMenu').onclick = () => openMenu();

function toggleFull() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch { }
}

function onKey(e) {
  if (!room || e.target.closest('input, textarea, select') || $('#modal').classList.contains('open')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') toggleFull();
  else if (k === 'm') $('#tvMute').click();
  else if (k === 'p' && !$('#tvPause').hidden) $('#tvPause').click();
  else if ((k === 'n' || k === ' ') && !$('#tvSkip').hidden) { e.preventDefault(); $('#tvSkip').click(); }
}

function openMenu() {
  const s = S();
  if (!s) return;
  modal((el, close) => {
    const ids = s.order.filter(id => s.players[id]);
    el.innerHTML = `<h2>Game menu</h2>
      <p>Game <b>${esc(s.code)}</b> · ${ids.length ? E.plural(ids.length, 'player') : 'no players yet'}</p>
      <div class="menu-players">${ids.map(id => { const p = s.players[id]; return `<div class="mp">${avHtml(p)}<span class="mp-name">${esc(p.name)}${p.on ? '' : ' <i>(away)</i>'}</span><button class="btn small" data-rm="${esc(id)}">Remove</button></div>`; }).join('') || '<p class="muted">Nobody has joined yet.</p>'}</div>
      <div class="row col">
        ${s.phase !== 'lobby' ? '<button class="btn" data-lobby>Stop this game, back to the lobby</button>' : ''}
        <button class="btn" data-close>Close the game for everyone</button>
        <button class="btn primary" data-ok>Done</button>
      </div>`;
    el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const p = s.players[b.dataset.rm];
      close();
      confirmBox('Remove player?', `Remove ${p ? p.name : 'them'} from the game? Their score goes too.`, 'Remove', 'Keep', () => room && room.act({ k: 'remove', pid: b.dataset.rm }));
    });
    const lob = el.querySelector('[data-lobby]');
    if (lob) lob.onclick = () => { close(); confirmBox('Back to the lobby?', 'This stops the current game. Scores are reset when the next game starts.', 'Stop the game', 'Keep playing', () => room && room.act({ k: 'lobby' })); };
    el.querySelector('[data-close]').onclick = () => { close(); confirmBox('Close the game?', 'Everyone gets sent back to the start.', 'Close it', 'Keep it open', async () => { const r = room; tabStore.del('lg_host'); store.del('lg_last_host'); unmount(); if (r) await r.leave(); exitFn(); }); };
    el.querySelector('[data-ok]').onclick = close;
  }, 'menu-modal');
}

// ---------------------------------------------------------------- state
function onState(s) {
  if (!room) return;
  $('#tvCodeText').textContent = s.code;
  document.title = `Lieage · ${s.code}`;
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = 0; save(); }, 500);
  // remember which questions this screen has shown, so the next game gets new ones
  if (s.game && ctx && ctx.seen) {
    let added = false;
    for (const id of s.game.used) if (!ctx.seen.has(id)) { ctx.seen.add(id); added = true; }
    if (added) ctx.saveSeen();
  }
  if (s.phase !== lastPhase) {
    const was = lastPhase;
    lastPhase = s.phase;
    if (was !== null) phaseSound(s.phase);
    if (s.phase === 'vote' || s.phase === 'write') doneCount = 0;
  }
  if (timed[s.phase]) {
    const n = s.order.filter(id => doneOf(s, id)).length;
    if (n > doneCount) sfx.done();
    doneCount = n;
  }
  render(s);
}

function phaseSound(phase) {
  if (phase === 'round') sfx.round();
  else if (phase === 'choose' || phase === 'vote' || phase === 'scores') sfx.whoosh();
  else if (phase === 'write') sfx.card();
  else if (phase === 'end') sfx.fanfare();
}

const doneOf = (s, id) => {
  const g = s.game;
  if (!g) return false;
  if (s.phase === 'write') return !!g.lies[id];
  if (s.phase === 'vote') return !!g.votes[id];
  return false;
};

function qLabel(s) {
  const g = s.game, st = g.plan[g.qi];
  if (st.final) return 'Final question · triple points';
  const inRound = g.plan.filter(x => x.round === st.round);
  const k = g.plan.slice(0, g.qi + 1).filter(x => x.round === st.round).length;
  return `Round ${st.round}${st.mult > 1 ? ' · double points' : ''} · Question ${k} of ${inRound.length}`;
}

function render(s) {
  const g = s.game;
  const inGame = !!g && s.phase !== 'lobby';
  $('#tvPause').hidden = !inGame || !s.ends;
  $('#tvPause').textContent = s.paused ? '▶' : '⏸';
  $('#tvPause').title = s.paused ? 'Resume (P)' : 'Pause (P)';
  $('#tvSkip').hidden = !inGame || s.phase === 'end';
  $('#screen').classList.toggle('in-lobby', s.phase === 'lobby');
  renderPlayers(s);

  let key;
  switch (s.phase) {
    case 'lobby': key = JSON.stringify(['lobby', s.order.map(id => { const p = s.players[id]; return [id, p.name, p.av, p.on, p.relay]; }), s.settings, E.leadOf(s)]); break;
    case 'round': key = `round:${s.gameNo}:${g.qi}`; break;
    case 'choose': key = `choose:${s.gameNo}:${g.qi}:${g.chooser}`; break;
    case 'write': key = `write:${s.gameNo}:${g.qi}`; break;
    case 'vote': key = `vote:${s.gameNo}:${g.qi}`; break;
    case 'reveal': key = `reveal:${s.gameNo}:${g.qi}:${g.rv.step}`; break;
    case 'scores': key = `scores:${s.gameNo}:${g.qi}`; break;
    case 'end': key = JSON.stringify(['end', s.gameNo, s.order.map(id => s.players[id] && [s.players[id].name, s.players[id].av])]); break;
    default: key = s.phase;
  }
  const stage = $('#tvStage');
  stage.classList.toggle('paused', !!s.paused);
  if (key === stageKey) return;
  stageKey = key;
  clearSteps();
  stage.className = `tv-stage stage-${s.phase}${s.paused ? ' paused' : ''}`;
  switch (s.phase) {
    case 'lobby': stage.innerHTML = lobbyHtml(s); bindLobby(s); break;
    case 'round': stage.innerHTML = roundHtml(s); break;
    case 'choose': stage.innerHTML = chooseHtml(s); break;
    case 'write': stage.innerHTML = writeHtml(s); break;
    case 'vote': stage.innerHTML = voteHtml(s); break;
    case 'reveal': stage.innerHTML = revealHtml(s); playReveal(s); break;
    case 'scores': stage.innerHTML = scoresHtml(s); playScores(s); break;
    case 'end': stage.innerHTML = endHtml(s); bindEnd(); break;
  }
  if (s.phase !== 'scores' && s.phase !== 'reveal') shownScores = Object.fromEntries(s.order.map(id => [id, s.players[id].score]));
  stage.insertAdjacentHTML('beforeend', '<div class="paused-veil"><div>⏸ Paused</div></div>');
}

function renderPlayers(s) {
  const box = $('#tvPlayers');
  if (s.phase === 'lobby') { box.innerHTML = ''; return; }
  const g = s.game, lead = E.leadOf(s);
  box.innerHTML = s.order.filter(id => s.players[id]).map(id => {
    const p = s.players[id];
    const done = doneOf(s, id);
    const busy = timed[s.phase] && !done && p.on && !(s.phase === 'choose' && g.chooser !== id);
    const choosing = s.phase === 'choose' && g.chooser === id;
    return `<div class="tvp ${p.on ? '' : 'off'} ${done ? 'done' : ''} ${choosing ? 'choosing' : ''}">
      ${avHtml(p)}
      <div class="tvp-txt"><b>${esc(p.name)}${id === lead ? ' 👑' : ''}</b><span>${fmt(p.score)}</span></div>
      ${done ? '<i class="tick">✓</i>' : busy ? '<i class="dots"><u></u><u></u><u></u></i>' : ''}
      ${p.on ? '' : '<i class="away">away</i>'}
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------- lobby
function lobbyHtml(s) {
  const ids = s.order.filter(id => s.players[id]);
  const here = E.onlineIds(s);
  const lead = E.leadOf(s);
  const host = `${location.host}${location.pathname.replace(/index\.html$/, '')}`.replace(/\/$/, '');
  const tiles = ids.map(id => {
    const p = s.players[id];
    return `<div class="ptile ${p.on ? '' : 'off'}">
      ${avHtml(p, 'big')}
      <b>${esc(p.name)}</b>
      <span class="ptags">${id === lead ? '<span class="tag lead">👑 LEAD</span>' : ''}${p.relay ? '<span class="tag relay" title="Connected through the backup relay">📡 RELAY</span>' : ''}${p.on ? '' : '<span class="tag away">AWAY</span>'}</span>
      <button class="ptile-x" data-rm="${esc(id)}" title="Remove ${esc(p.name)}">✕</button>
    </div>`;
  }).join('');
  const empties = Math.max(0, Math.min(E.MAX_PLAYERS, Math.max(4, ids.length + 1)) - ids.length);
  const seg = (name, val, opts) => `<div class="seg" data-set="${name}">${opts.map(([v, label, sub]) => `<button class="${String(val) === String(v) ? 'on' : ''}" data-v="${esc(v)}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`).join('')}</div>`;
  const per = k => E.makePlan(k).length;
  const ready = here.length >= E.MIN_PLAYERS;
  return `<div class="tv-lobby">
    <div class="card join-panel">
      <div class="jp-logo"><span aria-hidden="true">🤥</span> Lieage</div>
      <p class="jp-tag">Tell believable lies. Spot the truth.</p>
      <ol class="jp-steps">
        <li>Grab your phone and go to<br><b class="jp-url">${esc(host)}</b></li>
        <li>Enter this code</li>
      </ol>
      <div class="big-code">${esc(s.code).split('').map(d => `<span>${d}</span>`).join('')}</div>
      <p class="jp-note">${E.MIN_PLAYERS} to ${E.MAX_PLAYERS} players. This screen is the game: it doesn't play.</p>
    </div>
    <div class="lobby-side">
      <div class="card side-card">
        <h3>Players <span class="count">${here.length} / ${E.MAX_PLAYERS}</span></h3>
        <div class="ptiles">${tiles}${'<div class="ptile empty"><span class="pav big">?</span><b>Waiting…</b></div>'.repeat(empties)}</div>
      </div>
      <div class="card side-card settings">
        <h3>Settings</h3>
        <div class="set-row"><span class="label">Game length</span>${seg('length', s.settings.length, Object.entries(E.LENGTHS).map(([k, v]) => [k, v.label, `${per(k)} questions`]))}</div>
        <div class="set-row"><span class="label">Time to write</span>${seg('writeSecs', s.settings.writeSecs, E.WRITE_TIMES.map(t => [t, `${t}s`]))}</div>
        <div class="set-row"><span class="label">Family friendly</span>${seg('family', s.settings.family, [[false, 'Off'], [true, 'On', 'no grown-up stuff']])}</div>
      </div>
      <button class="btn primary big start-btn" data-start ${ready ? '' : 'disabled'}>${ready ? 'Everybody’s in, start the game ▶' : `Waiting for at least ${E.MIN_PLAYERS} players…`}</button>
      <p class="lead-note">${lead ? `👑 ${esc(s.players[lead].name)} can also start the game from their phone.` : 'The first player to join can also start the game from their phone.'}</p>
    </div>
  </div>`;
}

function bindLobby(s) {
  const stage = $('#tvStage');
  stage.querySelectorAll('[data-set] button').forEach(b => b.onclick = () => {
    unlock(); sfx.click();
    const name = b.parentElement.dataset.set;
    let v = b.dataset.v;
    if (name === 'family') v = v === 'true';
    if (name === 'writeSecs') v = +v;
    const settings = { [name]: v };
    store.set('lg_settings', { ...S().settings, ...settings });
    room.act({ k: 'settings', settings });
  });
  stage.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    const p = S().players[b.dataset.rm];
    confirmBox('Remove player?', `Remove ${p ? p.name : 'them'} from the game?`, 'Remove', 'Keep', () => room && room.act({ k: 'remove', pid: b.dataset.rm }));
  });
  const st = stage.querySelector('[data-start]');
  if (st) st.onclick = () => { unlock(); room.act({ k: 'start' }); };
}

// ---------------------------------------------------------------- round card, topics, writing, voting
function roundHtml(s) {
  const st = s.game.plan[s.game.qi];
  const t = E.TRUTH_PTS * st.mult, f = E.FOOL_PTS * st.mult;
  const title = st.final ? 'Final question' : `Round ${st.round}`;
  const sub = st.final ? 'Triple points!' : st.round === 2 ? 'Double points!' : 'Write a lie. Find the truth.';
  return `<div class="tv-round">
    <div class="round-card">
      <div class="round-k">${title}</div>
      <div class="round-sub">${sub}</div>
      <div class="round-pts"><span class="truth">Find the truth <b>+${fmt(t)}</b></span><span class="lie">Each player you fool <b>+${fmt(f)}</b></span></div>
    </div>
  </div>`;
}

function chooseHtml(s) {
  const g = s.game;
  return `<div class="tv-choose">
    <div class="q-head">${esc(qLabel(s))}</div>
    <h2 class="chooser">${who(s, g.chooser)} is picking a topic…</h2>
    <div class="topics">${g.choices.map((c, i) => { const cat = catOf(c.c); return `<div class="topic" style="animation-delay:${i * 0.12}s"><span class="t-ic">${cat.icon}</span><b>${esc(c.t)}</b><small>${esc(cat.name)}</small></div>`; }).join('')}</div>
    <div class="tv-timer" id="tvTimer"></div>
  </div>`;
}

function topicChip(g) {
  const cat = catOf(g.q.c);
  return `<span class="topic-chip">${cat.icon} ${esc(g.q.t)}</span>`;
}

function writeHtml(s) {
  const g = s.game;
  return `<div class="tv-q">
    <div class="q-head">${esc(qLabel(s))} ${topicChip(g)}</div>
    <div class="q-text">${blankify(g.q.q)}</div>
    <div class="q-cta">✍️ Write a believable lie on your phone!</div>
    <div class="tv-timer" id="tvTimer"></div>
  </div>`;
}

function voteHtml(s) {
  const g = s.game;
  return `<div class="tv-q tv-vote">
    <div class="q-head">${esc(qLabel(s))} ${topicChip(g)}</div>
    <div class="q-text small">${blankify(g.q.q)}</div>
    <div class="answers n${Math.min(g.opts.length, 12)}">${g.opts.map((o, i) => `<div class="ans" style="animation-delay:${i * 0.08}s">${esc(o.text)}</div>`).join('')}</div>
    <div class="q-cta">🔍 Find the truth on your phone!</div>
    <div class="tv-timer" id="tvTimer"></div>
  </div>`;
}

// ---------------------------------------------------------------- the reveal
function revealHtml(s) {
  const g = s.game;
  const it = g.rv.items[g.rv.step];
  const o = g.opts.find(x => x.id === it.opt);
  const kind = it.truth ? 'truth' : o.kind;
  const pk = it.pickers.map((id, i) => `<span class="chip pop" style="animation-delay:${0.9 + i * 0.3}s">${who(s, id)}</span>`).join('');
  const pickLabel = it.pickers.length ? (it.truth ? 'Found by' : 'Fell for it') : (it.truth ? 'Nobody found the truth!' : '');
  const stampAt = 1.3 + it.pickers.length * 0.3;
  let byline = '';
  if (kind === 'lie') {
    const authors = o.by.map(id => who(s, id));
    byline = `<span>Written by ${listJoin(authors)}</span>${it.pts ? `<span class="pts">+${fmt(it.pts)}${o.by.length > 1 ? ' each' : ''}</span>` : ''}`;
  } else if (kind === 'house') {
    byline = '<span>🤥 One of <b>Lieage’s</b> own lies</span>';
  } else if (it.pickers.length) {
    byline = `<span class="pts">+${fmt(it.pts)}${it.pickers.length > 1 ? ' each' : ''}</span>`;
  }
  let rest = '';
  if (it.truth) {
    const unpicked = g.opts.filter(x => x.kind === 'lie' && !g.rv.items.some(r => r.opt === x.id));
    rest = `<div class="q-text small filled-q" style="animation-delay:${stampAt + 0.6}s">${blankify(g.q.q, o.text)}</div>`;
    if (unpicked.length) rest += `<div class="rv-rest" style="animation-delay:${stampAt + 1.6}s"><span class="label">Nobody fell for</span>${unpicked.map(x => `<span class="rest-item"><b>${esc(x.text)}</b> <small>${listJoin(x.by.map(id => esc(s.players[id] ? s.players[id].name : 'Someone')))}</small></span>`).join('')}</div>`;
  }
  return `<div class="tv-reveal">
    ${it.truth ? '' : `<div class="q-text small">${blankify(g.q.q)}</div>`}
    <div class="rv-card ${kind}">
      <div class="rv-ans">${esc(o.text)}</div>
      <div class="rv-pick ${it.pickers.length ? '' : 'none'}" style="--d:${it.pickers.length ? 0.6 : stampAt + 0.4}s">${pickLabel ? `<span class="label">${pickLabel}</span>` : ''}${pk}</div>
      <div class="rv-stamp" style="animation-delay:${stampAt}s">${kind === 'truth' ? 'TRUTH' : 'LIE'}</div>
      <div class="rv-by" style="animation-delay:${stampAt + 0.4}s">${byline}</div>
    </div>
    ${rest}
    <div class="rv-count">${g.rv.step + 1} / ${g.rv.items.length}</div>
  </div>`;
}

function clearSteps() {
  for (const t of stepTimers) clearTimeout(t);
  for (const r of stepRafs) cancelAnimationFrame(r);
  stepTimers = []; stepRafs = [];
}
function playReveal(s) {
  const g = s.game, it = g.rv.items[g.rv.step];
  const stampAt = 1.3 + it.pickers.length * 0.3;
  sfx.card();
  it.pickers.forEach((_, i) => stepTimers.push(setTimeout(() => sfx.pop(), (0.9 + i * 0.3) * 1000)));
  if (it.truth) stepTimers.push(setTimeout(() => sfx.drum(), 200));
  stepTimers.push(setTimeout(() => {
    if (it.truth) (it.pickers.length ? sfx.truth : sfx.nobody)();
    else sfx.lie();
  }, stampAt * 1000));
}

// ---------------------------------------------------------------- scores
function scoresHtml(s) {
  const g = s.game;
  const board = E.standings(s);
  const max = Math.max(1, ...board.map(x => x.score));
  const last = g.qi >= g.plan.length - 1;
  const next = last ? 'And the winner is…' : g.plan[g.qi + 1].round !== g.plan[g.qi].round ? (g.plan[g.qi + 1].final ? 'Next: the final question (triple points)' : 'Next: round 2 (double points)') : 'Next question coming up';
  return `<div class="tv-scores">
    <h2>Scores</h2>
    <div class="board">${board.map((x, i) => {
      const p = s.players[x.pid];
      const d = g.deltas[x.pid] || 0;
      const before = shownScores && shownScores[x.pid] != null ? shownScores[x.pid] : x.score - d;
      return `<div class="brow" style="animation-delay:${i * 0.07}s">
        <span class="place">${ordinal(x.place)}</span>${avHtml(p)}<b class="bname">${esc(p.name)}</b>
        <div class="bar"><i style="--w:${Math.max(2, (x.score / max) * 100)}%;--c:${p.color}"></i></div>
        <span class="bscore" data-from="${before}" data-to="${x.score}">${fmt(before)}</span>
        <span class="delta ${d ? '' : 'zero'}">${d ? '+' + fmt(d) : '+0'}</span>
      </div>`;
    }).join('')}</div>
    <p class="q-next">${next}</p>
  </div>`;
}

function playScores() {
  const els = [...document.querySelectorAll('#tvStage .bscore')];
  const t0 = performance.now() + 500, dur = 1200;
  const step = now => {
    const k = Math.min(1, Math.max(0, (now - t0) / dur));
    const e = 1 - (1 - k) ** 3;
    for (const el of els) el.textContent = fmt(Math.round(+el.dataset.from + (+el.dataset.to - +el.dataset.from) * e));
    if (k < 1 && room) stepRafs.push(requestAnimationFrame(step));
  };
  stepRafs.push(requestAnimationFrame(step));
}

// ---------------------------------------------------------------- the end
function endHtml(s) {
  const g = s.game, a = g.awards;
  const board = E.standings(s);
  const w = a.winners;
  const crown = w.length
    ? `<div class="winner-avs">${w.map(id => avHtml(s.players[id], 'huge')).join('')}</div><h2>${w.length > 1 ? `It’s a tie! ${listJoin(w.map(id => esc(s.players[id].name)))} win!` : `${esc(s.players[w[0]].name)} wins!`}</h2>`
    : '<h2>Nobody scored a single point. Impressive, in a way.</h2>';
  const award = (icon, title, x, unit) => (x ? `<div class="award"><span class="aw-ic">${icon}</span><div><b>${title}</b><span>${listJoin(x.pids.map(id => esc(s.players[id] ? s.players[id].name : '?')))}</span><small>${unit(x.n)}</small></div></div>` : '');
  return `<div class="tv-end">
    <div class="winner">${crown}</div>
    <div class="end-grid">
      <div class="card side-card"><h3>Final scores</h3><div class="board small">${board.map(x => { const p = s.players[x.pid]; return `<div class="brow"><span class="place">${ordinal(x.place)}</span>${avHtml(p)}<b class="bname">${esc(p.name)}</b><span class="bscore">${fmt(x.score)}</span></div>`; }).join('')}</div></div>
      <div class="awards">
        ${award('🎭', 'Master Liar', a.liar, n => `fooled ${E.plural(n, 'player')}`)}
        ${award('🔍', 'Truth Detector', a.detective, n => `found the truth ${E.plural(n, 'time')}`)}
        ${award('😂', 'Crowd Favourite', a.comedian, n => E.plural(n, 'laugh'))}
        ${award('🐟', 'Hook, Line & Sinker', a.sucker, n => `fell for ${E.plural(n, 'lie')}`)}
      </div>
    </div>
    <div class="end-actions">
      <button class="btn primary big" data-again>Play again ▶</button>
      <button class="btn big" data-lobby>Back to the lobby</button>
    </div>
  </div>`;
}

function bindEnd() {
  const st = $('#tvStage');
  st.querySelector('[data-again]').onclick = () => { unlock(); room.act({ k: 'start' }); };
  st.querySelector('[data-lobby]').onclick = () => { unlock(); room.act({ k: 'lobby' }); };
}

// ---------------------------------------------------------------- the clock
function loop() {
  raf = requestAnimationFrame(loop);
  const s = S();
  if (!s) return;
  const el = document.getElementById('tvTimer');
  if (!el) return;
  const left = secsLeft(s, Date.now());
  if (left == null) { el.textContent = ''; return; }
  const total = s.phase === 'choose' ? E.TIMES.choose / 1000 : s.phase === 'write' ? s.settings.writeSecs : E.voteMs(s.game.opts.length) / 1000;
  const frac = Math.max(0, Math.min(1, left / total));
  if (el.dataset.left !== String(left)) {
    el.dataset.left = String(left);
    el.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="bg"/><circle cx="50" cy="50" r="44" class="fg" style="stroke-dashoffset:${(1 - frac) * 276.5}"/></svg><span>${left}</span>`;
    el.classList.toggle('low', left <= 5);
    if (left <= 5 && left > 0 && !s.paused && lastTickSec !== left) sfx.tick(left <= 3);
    lastTickSec = left;
  }
}
