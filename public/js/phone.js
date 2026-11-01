// A player's phone: shows what this player has to do right now and sends their taps to the game screen.
// The phone only ever gets its own view of the room (engine.js view()).
import * as E from './engine.js';
import { $, esc, fmt, ordinal, blankify, toast, modal, confirmBox, secsLeft, keepAwake, store, tabStore } from './ui.js';
import { AVATARS, catOf } from './looks.js';
import { sfx, unlock } from './audio.js';

let room = null, exitFn = null;
let unsub = [], raf = 0, saveTimer = 0;
let stageKey = '', lastPhase = null, lastQ = null;
let draft = '', editing = false, lieErr = '', pendingVote = null, focusNext = false;

const V = () => room && room.state;
const meOf = v => v.players.find(p => p.pid === v.me);
const nameOf = (v, pid) => { const p = v.players.find(x => x.pid === pid); return p ? p.name : 'Someone'; };
const avOf = p => `<span class="pav" style="--pc:${p ? p.color : '#999'}">${esc(p ? p.av : '❔')}</span>`;
const isLead = v => v.lead === v.me;

export function mount(r, exit) {
  room = r; exitFn = exit;
  $('#home').hidden = true; $('#screen').hidden = true; $('#phone').hidden = false;
  document.body.classList.add('is-phone');
  $('#phCode').textContent = room.code || '-----';
  stageKey = ''; lastPhase = null; lastQ = null; draft = ''; editing = false; lieErr = ''; pendingVote = null;
  $('#phStage').innerHTML = '<div class="ph-card center"><div class="spinner"></div><p>Connecting to the game…</p></div>';
  unsub = [
    room.on('state', onState),
    room.on('status', t => { const el = $('#phStatus'); el.hidden = !t; el.textContent = t || ''; }),
    room.on('error', msg => toast(msg, 'err')),
    room.on('refused', r => {
      if (r.code === 'truth') { lieErr = r.err; editing = true; stageKey = ''; render(); sfx.buzz(); }
      else { toast(r.err, 'err'); if (pendingVote) { pendingVote = null; stageKey = ''; render(); } }
    }),
    room.on('closed', msg => leave(msg)),
  ];
  keepAwake(true);
  window.addEventListener('pagehide', onHide);
  raf = requestAnimationFrame(loop);
  if (room.state) onState(room.state);
}

function unmount() {
  for (const u of unsub) u();
  unsub = [];
  cancelAnimationFrame(raf);
  clearTimeout(saveTimer);
  window.removeEventListener('pagehide', onHide);
  document.body.classList.remove('is-phone');
  keepAwake(false);
  room = null;
}

function leave(msg) {
  const code = room && room.code;
  tabStore.del('lg_play');
  const r = room;
  unmount();
  if (r) r.drop();
  exitFn(msg, code);
}

function onHide() {
  if (!room) return;
  tabStore.set('lg_play', { code: room.code, pid: room.me.pid, at: Date.now() });
  room.drop();
}

// ---------------------------------------------------------------- buttons
$('#phLeave').onclick = () => confirmBox('Leave the game?', 'Your score stays if you come back with the same code.', 'Leave', 'Stay', async () => {
  const r = room;
  tabStore.del('lg_play');
  unmount();
  if (r) await r.leave();
  exitFn();
});
$('#phMe').onclick = () => editMe();
$('#phPause').onclick = () => { sfx.click(); room && room.act({ k: 'pause' }); };
$('#phSkip').onclick = () => { sfx.click(); room && room.act({ k: 'skip' }); };

function editMe() {
  const v = V();
  if (!v) return;
  const me = meOf(v);
  if (!me) return;
  let av = me.av;
  modal((el, close) => {
    el.innerHTML = `<h2>You</h2>
      <input id="meName" maxlength="${E.NAME_MAX}" value="${esc(me.name)}" autocomplete="nickname" aria-label="Your name">
      <div class="avatars">${AVATARS.map(a => `<button class="${a === av ? 'on' : ''}" data-av="${a}">${a}</button>`).join('')}</div>
      <div class="row"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`;
    el.querySelectorAll('[data-av]').forEach(b => b.onclick = () => {
      av = b.dataset.av;
      el.querySelectorAll('[data-av]').forEach(x => x.classList.toggle('on', x === b));
      sfx.click();
    });
    el.querySelector('[data-x]').onclick = close;
    el.querySelector('[data-ok]').onclick = () => {
      const name = el.querySelector('#meName').value.trim().slice(0, E.NAME_MAX);
      if (name) store.set('lg_name', name);
      store.set('lg_av', av);
      room.me.name = name || room.me.name;
      room.me.av = av;
      room.act({ k: 'me', name, av });
      close();
    };
  });
}

// ---------------------------------------------------------------- state
function onState(v) {
  if (!room) return;
  $('#phCode').textContent = v.code;
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = 0; if (room) tabStore.set('lg_play', { code: room.code, pid: room.me.pid, at: Date.now() }); }, 1000);
  const g = v.g;
  const qKey = g ? `${v.gameNo}:${g.qi}` : null;
  if (qKey !== lastQ) { lastQ = qKey; draft = ''; editing = false; lieErr = ''; pendingVote = null; }
  if (v.phase !== lastPhase) {
    lastPhase = v.phase;
    if (v.phase === 'write') { focusNext = true; sfx.buzz(); }
    if (v.phase === 'vote') sfx.buzz();
    if (v.phase === 'choose' && g && g.chooser === v.me) sfx.buzz();
  }
  if (g && g.myVote) pendingVote = null;
  render();
}

function render() {
  const v = V();
  if (!v) return;
  const me = meOf(v);
  const g = v.g;
  if (me) {
    $('#phAv').textContent = me.av;
    $('#phName').textContent = me.name;
    $('#phScore').textContent = v.phase === 'lobby' ? '' : `${fmt(me.score)} pts`;
  }
  const inGame = g && v.phase !== 'lobby' && v.phase !== 'end';
  $('#phLead').hidden = !(inGame && isLead(v));
  $('#phPause').textContent = v.paused ? '▶ Resume' : '⏸ Pause';
  $('#phPause').disabled = !v.ends;

  let key;
  switch (v.phase) {
    case 'lobby': key = JSON.stringify(['lobby', isLead(v), v.settings, v.players.map(p => [p.pid, p.name, p.av, p.on])]); break;
    case 'round': key = `round:${v.gameNo}:${g.qi}`; break;
    case 'choose': key = `choose:${v.gameNo}:${g.qi}:${g.chooser}`; break;
    case 'write': key = JSON.stringify(['write', v.gameNo, g.qi, g.myLie, g.ideas, editing, lieErr]); break;
    case 'vote': key = JSON.stringify(['vote', v.gameNo, g.qi, g.myVote || pendingVote, g.myLaughs]); break;
    case 'reveal': key = `reveal:${v.gameNo}:${g.qi}:${g.result ? 1 : 0}`; break;
    case 'scores': key = `scores:${v.gameNo}:${g.qi}:${me ? me.score : 0}`; break;
    case 'end': key = `end:${v.gameNo}:${isLead(v)}`; break;
    default: key = v.phase;
  }
  if (key !== stageKey) {
    stageKey = key;
    const st = $('#phStage');
    st.className = `ph-stage ph-${v.phase}`;
    switch (v.phase) {
      case 'lobby': st.innerHTML = lobbyHtml(v); break;
      case 'round': st.innerHTML = roundHtml(v); break;
      case 'choose': st.innerHTML = chooseHtml(v); break;
      case 'write': st.innerHTML = writeHtml(v); break;
      case 'vote': st.innerHTML = voteHtml(v); break;
      case 'reveal': st.innerHTML = revealHtml(v); break;
      case 'scores': st.innerHTML = scoresHtml(v); break;
      case 'end': st.innerHTML = endHtml(v); break;
    }
    bind(v);
  }
  live(v);
}

/** Bits that change without rebuilding the screen (so typing isn't interrupted). */
function live(v) {
  const w = document.getElementById('phWait');
  if (w && (v.phase === 'write' || v.phase === 'vote')) {
    const waiting = v.players.filter(p => p.on && !p.done);
    w.innerHTML = waiting.length ? `Waiting for ${waiting.map(p => `${avOf(p)} ${esc(p.name)}`).join(', ')}` : 'Everyone’s done!';
  }
}

// ---------------------------------------------------------------- screens
function lobbyHtml(v) {
  const me = meOf(v);
  const lead = v.players.find(p => p.pid === v.lead);
  const here = v.players.filter(p => p.on);
  const seg = (name, val, opts) => `<div class="seg" data-set="${name}">${opts.map(([x, label, sub]) => `<button class="${String(val) === String(x) ? 'on' : ''}" data-v="${esc(x)}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`).join('')}</div>`;
  return `<div class="ph-card center you-card">
      <button class="big-av" data-me title="Change your picture">${esc(me ? me.av : '🙂')}</button>
      <h2>You’re in${me ? ', ' + esc(me.name) : ''}!</h2>
      <p>Keep an eye on the game screen.</p>
      <button class="btn small" data-me>Change name or picture</button>
    </div>
    <div class="ph-card">
      <h3>Players <span class="count">${here.length}</span></h3>
      <div class="ph-players">${v.players.map(p => `<span class="pchip ${p.on ? '' : 'off'} ${p.pid === v.me ? 'me' : ''}">${avOf(p)} ${esc(p.name)}${p.pid === v.lead ? ' 👑' : ''}</span>`).join('')}</div>
    </div>
    ${isLead(v) ? `<div class="ph-card lead-card">
      <h3>👑 You’re the lead player</h3>
      <p class="muted">You can start the game from here, or from the game screen.</p>
      <div class="set-row"><span class="label">Game length</span>${seg('length', v.settings.length, Object.entries(E.LENGTHS).map(([k, x]) => [k, x.label, `${E.makePlan(k).length} Qs`]))}</div>
      <div class="set-row"><span class="label">Time to write</span>${seg('writeSecs', v.settings.writeSecs, E.WRITE_TIMES.map(t => [t, `${t}s`]))}</div>
      <div class="set-row"><span class="label">Family friendly</span>${seg('family', v.settings.family, [[false, 'Off'], [true, 'On']])}</div>
      <button class="btn primary big" data-start ${here.length >= E.MIN_PLAYERS ? '' : 'disabled'}>${here.length >= E.MIN_PLAYERS ? 'Start the game ▶' : `Need ${E.MIN_PLAYERS}+ players`}</button>
    </div>` : `<p class="ph-hint">Waiting for ${lead ? `👑 ${esc(lead.name)}` : 'the lead player'} or the game screen to start the game.</p>`}`;
}

function roundHtml(v) {
  const g = v.g;
  const title = g.final ? 'Final question' : `Round ${g.round}`;
  const sub = g.final ? 'Triple points!' : g.round === 2 ? 'Double points!' : 'Write a lie. Find the truth.';
  return `<div class="ph-card center big-msg">
    <div class="ph-round">${title}</div>
    <p class="ph-sub">${sub}</p>
    <p class="muted">Truth: +${fmt(E.TRUTH_PTS * g.mult)} · Each player you fool: +${fmt(E.FOOL_PTS * g.mult)}</p>
    <p class="eyes">👀 Look at the game screen</p>
  </div>`;
}

function chooseHtml(v) {
  const g = v.g;
  const mine = g.chooser === v.me;
  return `<div class="ph-card center">
      <h2>${mine ? '🎯 Your turn! Pick a topic' : `${esc(nameOf(v, g.chooser))} is picking a topic…`}</h2>
    </div>
    <div class="ph-topics">${g.choices.map(c => { const cat = catOf(c.c); return `<button class="ph-topic" data-topic="${esc(c.id)}" ${mine ? '' : 'disabled'}><span class="t-ic">${cat.icon}</span><b>${esc(c.t)}</b><small>${esc(cat.name)}</small></button>`; }).join('')}</div>`;
}

function qCard(g, small) {
  const cat = catOf(g.c);
  return `<div class="ph-card q-card"><div class="ph-qhead"><span class="topic-chip">${cat.icon} ${esc(g.topic)}</span>${g.mult > 1 ? `<span class="mult">×${g.mult}</span>` : ''}</div><div class="ph-q ${small ? 'small' : ''}">${blankify(g.q)}</div></div>`;
}

function writeHtml(v) {
  const g = v.g;
  const locked = g.myLie && !editing;
  if (locked) {
    return `${qCard(g, true)}
      <div class="ph-card center locked">
        <div class="lock-ic">🔒</div>
        <p>Your lie is in:</p>
        <div class="my-lie">${esc(g.myLie)}</div>
        <button class="btn small" data-edit>Change it</button>
      </div>
      <p class="ph-wait" id="phWait"></p>`;
  }
  return `${qCard(g)}
    <form class="ph-card lie-form" data-lie autocomplete="off">
      <label for="lieIn" class="field-label">Your lie</label>
      <input id="lieIn" maxlength="${E.LIE_MAX}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="Something believable…" value="${esc(draft)}">
      ${lieErr ? `<p class="lie-err">🤫 ${esc(lieErr)}</p>` : ''}
      <button class="btn primary big" type="submit">Lock in my lie</button>
      ${g.ideas ? `<div class="ideas"><span class="muted">Tap an idea to use it:</span>${g.ideas.map(i => `<button type="button" class="idea" data-idea="${esc(i)}">${esc(i)}</button>`).join('')}</div>` : '<button type="button" class="btn ghost" data-ideas>💡 Stuck? Get an idea</button>'}
    </form>
    <p class="ph-wait" id="phWait"></p>`;
}

function voteHtml(v) {
  const g = v.g;
  const vote = g.myVote || pendingVote;
  return `${qCard(g, true)}
    <p class="ph-hint">${vote ? 'Locked in! Tap 😂 on any answer that made you laugh.' : 'Which one is the <b>truth</b>?'}</p>
    <div class="ph-opts">${g.opts.map(o => `<div class="ph-opt ${o.mine ? 'mine' : ''} ${o.id === vote ? 'picked' : ''}">
      <button class="opt-main" data-opt="${esc(o.id)}" aria-label="${esc(o.text)}${o.mine ? ' (your lie)' : ''}" ${o.mine || vote ? 'disabled' : ''}><span>${esc(o.text)}</span>${o.mine ? '<small>Your lie</small>' : o.id === vote ? '<small>Your pick</small>' : ''}</button>
      ${vote && !o.mine ? `<button class="laugh ${g.myLaughs.includes(o.id) ? 'on' : ''}" data-laugh="${esc(o.id)}" title="This made me laugh" aria-label="Laugh at ${esc(o.text)}">😂</button>` : ''}
    </div>`).join('')}</div>
    <p class="ph-wait" id="phWait"></p>`;
}

function resultHtml(v, r) {
  if (!r) return '';
  const lines = [];
  if (r.found) lines.push(['good', '✅', 'You found the truth!']);
  else if (r.picked) lines.push(['bad', '🤦', r.picked.kind === 'house' ? 'You fell for one of Lieage’s own lies' : `You fell for ${esc(r.picked.by.join(' & '))}’s lie`]);
  else lines.push(['meh', '😴', 'You didn’t pick an answer']);
  if (r.lie) lines.push(r.fooled ? ['good', '🎭', `Your lie fooled ${E.plural(r.fooled, 'player')}!`] : ['meh', '🫥', 'Nobody fell for your lie']);
  if (r.laughs) lines.push(['good', '😂', `Your lie got ${E.plural(r.laughs, 'laugh')}`]);
  return `<div class="ph-card result">
    ${lines.map(([cls, ic, t]) => `<div class="rline ${cls}"><span>${ic}</span><span>${t}</span></div>`).join('')}
    <p class="truth-was">The truth: <b>${esc(r.truth)}</b></p>
    <div class="rpts ${r.pts ? '' : 'zero'}">+${fmt(r.pts)}</div>
  </div>`;
}

function revealHtml(v) {
  const g = v.g;
  if (!g.result) return `<div class="ph-card center big-msg"><div class="eyes-big">👀</div><h2>Eyes on the screen!</h2><p class="muted">The answers are being revealed.</p></div>`;
  return resultHtml(v, g.result);
}

function placeOf(v, pid) {
  const list = v.players.slice().sort((a, b) => b.score - a.score);
  const me = list.find(p => p.pid === pid);
  return me ? 1 + list.filter(p => p.score > me.score).length : 0;
}

function scoresHtml(v) {
  const me = meOf(v);
  if (!me) return '<div class="ph-card center"><p>Scores are on the screen.</p></div>';
  const d = (v.g.deltas || {})[v.me] || 0;
  return `<div class="ph-card center">
      <div class="ph-place">${ordinal(placeOf(v, v.me))}</div>
      <p class="muted">of ${E.plural(v.players.length, 'player')}</p>
      <div class="ph-bigscore">${fmt(me.score)}</div>
      ${d ? `<div class="delta">+${fmt(d)} this question</div>` : '<div class="delta zero">no points this time</div>'}
    </div>
    ${resultHtml(v, v.g.result)}`;
}

function endHtml(v) {
  const me = meOf(v);
  const a = v.g.awards || {};
  const mine = [];
  const has = x => x && x.pids.includes(v.me);
  if (has(a.liar)) mine.push(['🎭', 'Master Liar', `fooled ${E.plural(a.liar.n, 'player')}`]);
  if (has(a.detective)) mine.push(['🔍', 'Truth Detector', `found the truth ${E.plural(a.detective.n, 'time')}`]);
  if (has(a.comedian)) mine.push(['😂', 'Crowd Favourite', E.plural(a.comedian.n, 'laugh')]);
  if (has(a.sucker)) mine.push(['🐟', 'Hook, Line & Sinker', `fell for ${E.plural(a.sucker.n, 'lie')}`]);
  const won = (a.winners || []).includes(v.me);
  const place = me ? placeOf(v, v.me) : 0;
  return `<div class="ph-card center big-msg">
      <div class="eyes-big">${won ? '🏆' : place === 2 ? '🥈' : place === 3 ? '🥉' : '🎉'}</div>
      <h2>${won ? ((a.winners || []).length > 1 ? 'You tied for the win!' : 'You win!') : `You came ${ordinal(place)}`}</h2>
      <div class="ph-bigscore">${fmt(me ? me.score : 0)}</div>
    </div>
    ${mine.length ? `<div class="ph-card"><h3>Your awards</h3>${mine.map(([ic, t, sub]) => `<div class="award small"><span class="aw-ic">${ic}</span><div><b>${t}</b><small>${sub}</small></div></div>`).join('')}</div>` : ''}
    ${isLead(v) ? `<div class="ph-card lead-card"><h3>👑 What next?</h3><button class="btn primary big" data-again>Play again ▶</button><button class="btn big" data-lobby>Back to the lobby</button></div>` : '<p class="ph-hint">Waiting for the game screen to start another game.</p>'}`;
}

// ---------------------------------------------------------------- taps
function bind(v) {
  const st = $('#phStage');
  st.querySelectorAll('[data-me]').forEach(b => b.onclick = () => editMe());
  st.querySelectorAll('[data-set] button').forEach(b => b.onclick = () => {
    sfx.click();
    const name = b.parentElement.dataset.set;
    let val = b.dataset.v;
    if (name === 'family') val = val === 'true';
    if (name === 'writeSecs') val = +val;
    room.act({ k: 'settings', settings: { [name]: val } });
  });
  const start = st.querySelector('[data-start]');
  if (start) start.onclick = () => { unlock(); sfx.click(); room.act({ k: 'start' }); };
  const again = st.querySelector('[data-again]');
  if (again) again.onclick = () => { sfx.click(); room.act({ k: 'start' }); };
  const lob = st.querySelector('[data-lobby]');
  if (lob) lob.onclick = () => { sfx.click(); room.act({ k: 'lobby' }); };

  st.querySelectorAll('[data-topic]').forEach(b => b.onclick = () => {
    sfx.pick();
    st.querySelectorAll('[data-topic]').forEach(x => { x.disabled = true; x.classList.toggle('chosen', x === b); });
    room.act({ k: 'choose', id: b.dataset.topic });
  });

  const form = st.querySelector('[data-lie]');
  if (form) {
    const input = form.querySelector('#lieIn');
    input.addEventListener('input', () => { draft = input.value; if (lieErr) { lieErr = ''; const e = form.querySelector('.lie-err'); if (e) e.remove(); } });
    form.onsubmit = e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      draft = text;
      editing = false;
      lieErr = '';
      sfx.pick();
      input.blur();
      room.act({ k: 'lie', text });
    };
    const ideas = form.querySelector('[data-ideas]');
    if (ideas) ideas.onclick = () => { sfx.click(); room.act({ k: 'idea' }); };
    form.querySelectorAll('[data-idea]').forEach(b => b.onclick = () => { input.value = b.dataset.idea; draft = input.value; input.focus(); });
    if (focusNext) { focusNext = false; setTimeout(() => input.focus(), 50); }
  }
  const edit = st.querySelector('[data-edit]');
  if (edit) edit.onclick = () => { draft = v.g.myLie; editing = true; focusNext = true; stageKey = ''; render(); };

  st.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => {
    if (pendingVote || (v.g && v.g.myVote)) return;
    sfx.pick();
    pendingVote = b.dataset.opt;
    room.act({ k: 'vote', opt: b.dataset.opt });
    stageKey = ''; render();
  });
  st.querySelectorAll('[data-laugh]').forEach(b => b.onclick = () => {
    sfx.click();
    b.classList.toggle('on');
    room.act({ k: 'laugh', opt: b.dataset.laugh });
  });
}

// ---------------------------------------------------------------- the clock
function loop() {
  raf = requestAnimationFrame(loop);
  const v = V();
  const bar = $('#phTimer');
  if (!v || !v.g || !['choose', 'write', 'vote'].includes(v.phase) || !v.ends) { if (!bar.hidden) bar.hidden = true; return; }
  const left = secsLeft(v, room.now());
  const total = v.phase === 'choose' ? E.TIMES.choose / 1000 : v.phase === 'write' ? v.settings.writeSecs : E.voteMs((v.g.opts || []).length) / 1000;
  bar.hidden = false;
  const leftMs = v.paused ? v.left : Math.max(0, v.ends - room.now());
  bar.firstElementChild.style.width = `${Math.max(0, Math.min(100, (leftMs / (total * 1000)) * 100))}%`;
  bar.classList.toggle('low', left <= 5);
  const t = v.paused ? '⏸' : String(left);
  if (bar.lastElementChild.textContent !== t) bar.lastElementChild.textContent = t;
}
