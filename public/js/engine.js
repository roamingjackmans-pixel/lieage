// Lieage rules. The game screen (the host) runs these and owns the room. Each phone gets its own view of
// the room (view() below), so no phone ever holds the real answer, or who wrote which lie, before the reveal.
// Nothing here touches the page, so it can be tested (tools/test.mjs).
//
// How a game goes:
//   lobby → for every question: [round card] → choose (one player picks a topic) → write (everyone writes a
//   lie) → vote (everyone tries to find the truth among the lies) → reveal (the lies people fell for, then the
//   truth) → scores → … → end (winner and awards).
//   Round 1 is worth normal points, round 2 double, and the final question triple. Nobody picks the topic of
//   the final question.
//
// The game screen isn't a player: s.hostPid is the screen, and s.players only holds the people on phones.

export const PROTO = 1;                  // bump when the message format or the rules change
export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;
export const LIE_MAX = 45;               // characters
export const NAME_MAX = 16;
export const TRUTH_PTS = 500;            // finding the truth (times the round's multiplier)
export const FOOL_PTS = 250;             // each player who falls for your lie (times the multiplier)
export const LENGTHS = {
  quick: { per: 2, label: 'Quick' },     // questions in each of rounds 1 and 2; the final question comes on top
  classic: { per: 3, label: 'Classic' },
  long: { per: 4, label: 'Long' },
};
export const WRITE_TIMES = [45, 60, 90, 120];
export const TIMES = {
  round: 5000,       // the round card
  choose: 15000,     // picking a topic
  lieStep: 6500,     // revealing one lie
  truthStep: 9000,   // revealing the truth
  scores: 9000,      // the scoreboard between questions
};
export const COLORS = ['#ff5d8f', '#36c9a0', '#ffb627', '#5b8cff', '#b86bff', '#ff7a3d', '#2ec4e6', '#9ad14b', '#f25ce0', '#e8e3d9'];
const MIN_OPTIONS = 5;   // with only a few players, the house adds lies of its own so there's enough to pick from
const CHOICES = 4;       // topics offered to the chooser
const GRACE = 1500;      // once everyone is done, the phase ends this long after the last one

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const ok = extra => ({ ok: true, ...extra });
const no = (err, code) => ({ ok: false, err, code });
export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

/** Fisher-Yates on a copy. rand() returns [0, 1). */
export function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- comparing answers ----------

/** Lowercase, no accents or punctuation, no leading "the/a/his/their…": what's left is what we compare. */
export function norm(t) {
  return String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^((the|a|an|his|her|their|its|my|your|our|some) )+/, '');
}
const stem = s => s.split(' ').map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
/** Two answers count as the same if they only differ in case, punctuation, spaces, a leading "the" or a plural s. */
export function same(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || stem(x) === stem(y) || x.replace(/ /g, '') === y.replace(/ /g, '');
}
export const isTruth = (q, text) => [q.a, ...(q.alt || [])].some(t => same(t, text));

// ---------- the room ----------

export function newRoom(code, hostPid, now = Date.now(), settings = {}) {
  const s = {
    v: PROTO, code, hostPid, created: now,
    players: {}, order: [], joinSeq: 0,
    settings: { length: 'classic', writeSecs: 60, family: false },
    phase: 'lobby', ends: 0, stepAt: 0, paused: false, left: 0, pausedAt: 0, tickAt: now,
    game: null, gameNo: 0, rev: 0,
  };
  setSettings(s, settings);
  return s;
}

export const onlineIds = s => s.order.filter(id => s.players[id] && s.players[id].on);
/** The first player still here leads: they can start and move the game along from their phone. */
export const leadOf = s => onlineIds(s)[0] || null;
export const nameOf = (s, pid) => (s.players[pid] ? s.players[pid].name : 'Someone');

function uniqueName(s, name, pid) {
  const taken = n => s.order.some(id => id !== pid && s.players[id] && s.players[id].name.toLowerCase() === n.toLowerCase());
  if (!taken(name)) return name;
  for (let k = 2; ; k++) {
    const n = `${name.slice(0, NAME_MAX - 2)} ${k}`;
    if (!taken(n)) return n;
  }
}

/** Someone said hello. Adds them, or gives them their old seat (and score) back if they were here before. */
export function addPlayer(s, p, now = Date.now()) {
  const pid = clean(p.pid, 24);
  if (!pid) return no('Bad player id', 'bad');
  if (pid === s.hostPid) return no('This tab is the game screen. Join from your phone, or from another browser.', 'self');
  const old = s.players[pid];
  const name = uniqueName(s, clean(p.name, NAME_MAX) || (old && old.name) || `Player ${s.joinSeq + 1}`, pid);
  const av = clean(p.av, 8) || (old && old.av) || '🙂';
  if (old) {
    // coming back to their seat: they keep the name and picture they had (they can change them in the game)
    const back = !old.on;
    Object.assign(old, { on: true, offAt: 0, relay: !!p.relay });
    return ok({ back });
  }
  if (onlineIds(s).length >= MAX_PLAYERS) return no(`This game is full (${MAX_PLAYERS} players)`, 'full');
  s.joinSeq++;
  s.players[pid] = { pid, name, av, n: s.joinSeq, color: COLORS[(s.joinSeq - 1) % COLORS.length], on: true, offAt: 0, relay: !!p.relay, score: 0 };
  s.order.push(pid);
  if (s.game && !s.game.stats[pid]) s.game.stats[pid] = newStats();
  return ok({ back: false });
}

export function setOnline(s, pid, on, now = Date.now()) {
  const p = s.players[pid];
  if (!p || p.on === on) return false;
  p.on = on;
  p.offAt = on ? 0 : now;
  if (!on) maybeEarly(s, now);
  return true;
}

function setSettings(s, r) {
  if (!r || typeof r !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(LENGTHS, r.length)) s.settings.length = r.length;
  if (WRITE_TIMES.includes(+r.writeSecs)) s.settings.writeSecs = +r.writeSecs;
  if (typeof r.family === 'boolean') s.settings.family = r.family;
}

/** The questions of one game: rounds 1 and 2, then the final question. */
export function makePlan(length) {
  const per = (LENGTHS[length] || LENGTHS.classic).per;
  const plan = [];
  for (let round = 1; round <= 2; round++) for (let i = 0; i < per; i++) plan.push({ round, mult: round, final: false });
  plan.push({ round: 3, mult: 3, final: true });
  return plan;
}

const newStats = () => ({ fooled: 0, truths: 0, fell: 0, laughs: 0, house: 0 });

// ---------- the game ----------

function enter(s, phase, now, ms = 0) {
  s.phase = phase;
  s.ends = ms ? now + ms : 0;
  s.paused = false;
  s.left = 0;
}

function startGame(s, now, ctx) {
  if (onlineIds(s).length < MIN_PLAYERS) return no(`You need at least ${MIN_PLAYERS} players to start`);
  if (!ctx || !ctx.bank || !ctx.bank.length) return no('The questions are still loading, try again in a moment');
  for (const id of s.order) s.players[id].score = 0;
  // players who left before this game started don't come along
  for (const id of s.order.slice()) if (!s.players[id].on) removePlayer(s, id);
  s.gameNo++;
  const stats = {};
  for (const id of s.order) stats[id] = newStats();
  s.game = {
    plan: makePlan(s.settings.length), qi: 0, used: [],
    lastChooser: null, chooser: null, choices: [], q: null,
    lies: {}, ideas: {}, opts: [], votes: {}, laughs: {}, rv: null, deltas: {},
    stats, awards: null,
  };
  enter(s, 'round', now, TIMES.round);
  return ok();
}

/** Prompts this game can still use. A screen that has shown most questions before starts repeating them. */
function pool(s, ctx) {
  const used = new Set(s.game.used);
  const all = ctx.bank.filter(p => !used.has(p.id) && (!s.settings.family || !p.x));
  const fresh = ctx.seen ? all.filter(p => !ctx.seen.has(p.id)) : all;
  return fresh.length >= CHOICES * 2 ? fresh : all;
}

function pickChoices(s, ctx) {
  const list = shuffle(pool(s, ctx), ctx.rand);
  const out = [], cats = new Set();
  for (const p of list) {                               // one topic from each of several categories
    if (out.length >= CHOICES) break;
    if (!cats.has(p.c)) { cats.add(p.c); out.push(p); }
  }
  for (const p of list) {
    if (out.length >= CHOICES) break;
    if (!out.includes(p)) out.push(p);
  }
  return out.map(p => ({ id: p.id, t: p.t, c: p.c }));
}

function startQuestion(s, now, ctx) {
  const g = s.game;
  const step = g.plan[g.qi];
  Object.assign(g, { q: null, lies: {}, ideas: {}, opts: [], votes: {}, laughs: {}, rv: null, deltas: {}, choices: [], chooser: null });
  if (step.final) {
    const p = shuffle(pool(s, ctx), ctx.rand)[0];
    return setPrompt(s, p, now);
  }
  // the next chooser: take turns in join order, skipping anyone who isn't here
  const here = onlineIds(s);
  let next = here[0] || null;
  if (g.lastChooser && here.length) {
    const n = s.players[g.lastChooser] ? s.players[g.lastChooser].n : 0;
    next = here.find(id => s.players[id].n > n) || here[0];
  }
  g.chooser = next;
  g.lastChooser = next;
  g.choices = pickChoices(s, ctx);
  if (!next) return setPrompt(s, g.choices[0] && ctx.byId.get(g.choices[0].id), now);
  enter(s, 'choose', now, TIMES.choose);
}

function setPrompt(s, p, now) {
  const g = s.game;
  if (!p) { finish(s, now); return; }   // out of questions (only with a tiny question list)
  g.q = { id: p.id, c: p.c, t: p.t, q: p.q, a: p.a, alt: p.alt || [], d: p.d || [] };
  g.used.push(p.id);
  g.choices = [];
  enter(s, 'write', now, s.settings.writeSecs * 1000);
}

/** Everyone who's here is done: end the phase shortly (so the last tick mark shows on the screen first). */
function maybeEarly(s, now) {
  const g = s.game;
  if (!g || s.paused || (s.phase !== 'write' && s.phase !== 'vote')) return;
  const here = onlineIds(s);
  if (!here.length) return;
  const done = s.phase === 'write' ? id => !!g.lies[id] : id => !!g.votes[id];
  if (here.every(done)) s.ends = Math.min(s.ends || Infinity, now + GRACE);
}

function buildOptions(s, now, ctx) {
  const g = s.game;
  const groups = [];
  for (const pid of s.order) {
    const t = g.lies[pid];
    if (!t) continue;
    const m = groups.find(o => same(o.text, t));   // the same lie from two players is one answer for both
    if (m) m.by.push(pid); else groups.push({ text: t, kind: 'lie', by: [pid] });
  }
  const opts = [...groups, { text: g.q.a, kind: 'truth', by: [] }];
  for (const d of shuffle(g.q.d, ctx.rand)) {
    if (opts.length >= MIN_OPTIONS) break;
    if (isTruth(g.q, d) || opts.some(o => same(o.text, d))) continue;
    opts.push({ text: d, kind: 'house', by: [] });
  }
  g.opts = shuffle(opts, ctx.rand).map((o, i) => ({ id: 'o' + i, ...o }));
  enter(s, 'vote', now, voteMs(g.opts.length));
}
export const voteMs = n => Math.min(45000, 15000 + 3000 * n);

function buildReveal(s, now) {
  const g = s.game;
  const { mult } = g.plan[g.qi];
  const pickers = id => s.order.filter(p => g.votes[p] === id);
  const items = [];
  for (const o of g.opts) {
    if (o.kind === 'truth') continue;
    const pk = pickers(o.id);
    if (pk.length) items.push({ opt: o.id, pickers: pk });
  }
  items.sort((a, b) => a.pickers.length - b.pickers.length);   // the lie that fooled the most people goes last
  const truth = g.opts.find(o => o.kind === 'truth');
  items.push({ opt: truth.id, pickers: pickers(truth.id), truth: true });

  const deltas = {};
  const add = (pid, n) => { if (n) deltas[pid] = (deltas[pid] || 0) + n; };
  const st = pid => (g.stats[pid] ||= newStats());
  for (const it of items) {
    const o = g.opts.find(x => x.id === it.opt);
    if (it.truth) {
      it.pts = TRUTH_PTS * mult;
      for (const p of it.pickers) { add(p, it.pts); st(p).truths++; }
    } else {
      it.pts = o.kind === 'lie' ? FOOL_PTS * mult * it.pickers.length : 0;
      for (const a of o.by) { add(a, it.pts); st(a).fooled += it.pickers.length; }
      for (const p of it.pickers) { st(p).fell++; if (o.kind === 'house') st(p).house++; }
    }
  }
  for (const pid in g.laughs) {
    for (const id of g.laughs[pid]) {
      const o = g.opts.find(x => x.id === id);
      if (o && o.kind === 'lie') for (const a of o.by) st(a).laughs++;
    }
  }
  g.rv = { items, step: 0 };
  g.deltas = deltas;
  s.stepAt = now;
  enter(s, 'reveal', now, stepMs(items[0]));
}
const stepMs = it => (it.truth ? TIMES.truthStep : TIMES.lieStep);

function nextStep(s, now) {
  const g = s.game;
  g.rv.step++;
  if (g.rv.step < g.rv.items.length) {
    s.stepAt = now;
    enter(s, 'reveal', now, stepMs(g.rv.items[g.rv.step]));
    return;
  }
  for (const pid in g.deltas) if (s.players[pid]) s.players[pid].score += g.deltas[pid];
  enter(s, 'scores', now, TIMES.scores);
}

function afterScores(s, now, ctx) {
  const g = s.game;
  g.qi++;
  if (g.qi >= g.plan.length) return finish(s, now);
  if (g.plan[g.qi].round !== g.plan[g.qi - 1].round) enter(s, 'round', now, TIMES.round);
  else startQuestion(s, now, ctx);
}

/** The standings: best score first; players level on points share a place. */
export function standings(s) {
  const list = s.order.filter(id => s.players[id]).map(id => ({ pid: id, score: s.players[id].score }))
    .sort((a, b) => b.score - a.score || s.players[a.pid].n - s.players[b.pid].n);
  let place = 0, last = null;
  list.forEach((x, i) => { if (x.score !== last) { place = i + 1; last = x.score; } x.place = place; });
  return list;
}

function finish(s, now) {
  const g = s.game;
  const ids = s.order.filter(id => s.players[id]);
  const best = (key, min = 1) => {
    let top = min, who = [];
    for (const id of ids) {
      const v = (g.stats[id] || newStats())[key];
      if (v > top) { top = v; who = [id]; } else if (v === top && v >= min) who.push(id);
    }
    return who.length ? { pids: who, n: top } : null;
  };
  const board = standings(s);
  const top = board.length && board[0].score > 0 ? board.filter(x => x.place === 1).map(x => x.pid) : [];
  g.awards = {
    winners: top,
    liar: best('fooled'),      // fooled the most people
    detective: best('truths'), // found the truth the most
    comedian: best('laughs'),  // got the most laughs
    sucker: best('fell'),      // fell for the most lies
  };
  enter(s, 'end', now, 0);
}

/** Move the game on to its next step (a timer ran out, or the host skipped ahead). */
function advance(s, now, ctx) {
  const g = s.game;
  switch (s.phase) {
    case 'round': startQuestion(s, now, ctx); break;
    case 'choose': {
      const c = g.choices[Math.floor(ctx.rand() * g.choices.length)];
      setPrompt(s, c && ctx.byId.get(c.id), now);
      break;
    }
    case 'write': buildOptions(s, now, ctx); break;
    case 'vote': buildReveal(s, now); break;
    case 'reveal': nextStep(s, now); break;
    case 'scores': afterScores(s, now, ctx); break;
  }
}

/** The clock. Returns true if the room changed. */
export function tick(s, now, ctx) {
  const dt = Math.max(0, now - (s.tickAt || now));
  s.tickAt = now;
  if (!s.game || s.phase === 'lobby' || s.phase === 'end' || s.paused) return false;
  if (!onlineIds(s).length) {                      // nobody's here: hold the clock until someone comes back
    if (s.ends) { s.ends += dt; s.stepAt += dt; }
    return false;
  }
  const g = s.game;
  if (s.phase === 'choose' && !(s.players[g.chooser] && s.players[g.chooser].on)) {   // the chooser left
    advance(s, now, ctx);
    return true;
  }
  if (s.ends && now >= s.ends) { advance(s, now, ctx); return true; }
  return false;
}

function removePlayer(s, pid) {
  if (!s.players[pid]) return;
  delete s.players[pid];
  s.order = s.order.filter(id => id !== pid);
  const g = s.game;
  if (!g) return;
  delete g.lies[pid];
  delete g.votes[pid];
  delete g.ideas[pid];
  delete g.laughs[pid];
  delete g.deltas[pid];
  for (const o of g.opts) o.by = o.by.filter(id => id !== pid);
  if (g.rv) for (const it of g.rv.items) it.pickers = it.pickers.filter(id => id !== pid);
}

// ---------- actions ----------

/**
 * Applies an action from the screen (pid === s.hostPid) or a player.
 * ctx: { bank: prompts, byId: Map, seen: Set of prompt ids this screen showed before, rand() }.
 */
export function apply(s, pid, a, now = Date.now(), ctx) {
  if (!a || typeof a !== 'object') return no('Bad action');
  const isScreen = pid === s.hostPid;
  const p = s.players[pid];
  if (!isScreen && !p) return no('You are not in this game');
  const boss = isScreen || pid === leadOf(s);   // the screen, or the lead player
  const g = s.game;

  switch (a.k) {
    case 'me': {                                     // change my name or picture
      if (!p) return no('Only players have a name');
      const name = clean(a.name, NAME_MAX);
      if (name) p.name = uniqueName(s, name, pid);
      if (a.av) p.av = clean(a.av, 8) || p.av;
      return ok();
    }
    case 'settings':
      if (!boss) return no('Only the game screen can change the settings');
      if (s.phase !== 'lobby' && s.phase !== 'end') return no('Change the settings between games');
      setSettings(s, a.settings);
      return ok();
    case 'start':
      if (!boss) return no('Only the game screen can start the game');
      if (s.phase !== 'lobby' && s.phase !== 'end') return no('The game has already started');
      return startGame(s, now, ctx);
    case 'lobby':                                    // stop the game and go back to the lobby
      if (!boss) return no('Only the game screen can do that');
      s.game = null;
      enter(s, 'lobby', now);
      return ok();
    case 'skip':
      if (!boss) return no('Only the game screen can skip ahead');
      if (!g || s.phase === 'lobby' || s.phase === 'end') return no('Nothing to skip');
      advance(s, now, ctx);
      return ok();
    case 'pause':
      if (!boss) return no('Only the game screen can pause');
      if (!g || !s.ends) return no('Nothing to pause right now');
      if (s.paused) {
        s.paused = false;
        s.ends = now + s.left;
        s.stepAt += now - s.pausedAt;
      } else {
        s.paused = true;
        s.left = Math.max(1000, s.ends - now);
        s.pausedAt = now;
      }
      return ok();
    case 'remove':
      if (!isScreen) return no('Only the game screen can remove players');
      if (!s.players[a.pid]) return no('No such player');
      removePlayer(s, a.pid);
      if (g && s.phase === 'choose' && g.chooser === a.pid) advance(s, now, ctx);
      maybeEarly(s, now);
      return ok();

    case 'choose': {
      if (s.phase !== 'choose') return no('Too late, a topic was already picked');
      if (g.chooser !== pid) return no("It's not your turn to pick");
      const c = g.choices.find(x => x.id === a.id);
      if (!c) return no('Pick one of the topics');
      setPrompt(s, ctx.byId.get(c.id), now);
      return ok();
    }
    case 'lie': {
      if (!p) return no('Only players write lies');
      if (s.phase !== 'write') return no("Too late, time's up for writing");
      const text = clean(a.text, LIE_MAX).replace(/[.!]+$/, '');
      if (!text) return no('Type a lie first');
      if (isTruth(g.q, text)) return no("That's actually the real answer! Shh. Write a lie instead.", 'truth');
      g.lies[pid] = text;
      maybeEarly(s, now);
      return ok();
    }
    case 'idea': {                                   // stuck? the house suggests a couple of lies
      if (!p || s.phase !== 'write') return no('No ideas right now');
      const d = g.q.d.filter(x => !isTruth(g.q, x));
      if (!d.length) return no('No ideas for this one, sorry');
      const k = p.n % d.length;
      g.ideas[pid] = [d[k], d[(k + 1) % d.length]].filter((x, i, arr) => arr.indexOf(x) === i);
      return ok();
    }
    case 'vote': {
      if (!p) return no('Only players vote');
      if (s.phase !== 'vote') return no('Voting is closed');
      if (g.votes[pid]) return no('You already picked an answer');
      const o = g.opts.find(x => x.id === a.opt);
      if (!o) return no('Pick one of the answers');
      if (o.by.includes(pid)) return no("You can't pick your own lie");
      g.votes[pid] = o.id;
      maybeEarly(s, now);
      return ok();
    }
    case 'laugh': {                                  // 😂 on an answer that made you laugh
      if (!p) return no('Only players can laugh');
      if (s.phase !== 'vote' && s.phase !== 'reveal') return no('Too late to laugh');
      const o = g.opts.find(x => x.id === a.opt);
      if (!o || o.by.includes(pid)) return no("You can't laugh at that one");
      const mine = g.laughs[pid] ||= [];
      const i = mine.indexOf(o.id);
      if (i >= 0) mine.splice(i, 1); else mine.push(o.id);
      return ok();
    }
  }
  return no('Unknown action');
}

// ---------- what each phone sees ----------

function doneFlag(s, id) {
  const g = s.game;
  if (!g) return false;
  if (s.phase === 'write') return !!g.lies[id];
  if (s.phase === 'vote') return !!g.votes[id];
  return false;
}

/** How the last question went for one player (only after the truth is out). */
export function resultFor(s, pid) {
  const g = s.game;
  if (!g || !g.rv) return null;
  const truth = g.opts.find(o => o.kind === 'truth');
  const vote = g.votes[pid] ? g.opts.find(o => o.id === g.votes[pid]) : null;
  const mine = g.opts.find(o => o.kind === 'lie' && o.by.includes(pid));
  const fooled = mine ? s.order.filter(id => g.votes[id] === mine.id).length : 0;
  return {
    truth: truth.text,
    found: !!vote && vote.kind === 'truth',
    picked: vote ? { text: vote.text, kind: vote.kind, by: vote.by.map(id => nameOf(s, id)) } : null,
    lie: mine ? mine.text : null,
    fooled,
    laughs: mine ? Object.values(g.laughs).filter(l => l.includes(mine.id)).length : 0,
    pts: g.deltas[pid] || 0,
  };
}

/** The room as one phone sees it. */
export function view(s, pid) {
  const g = s.game;
  const v = {
    v: s.v, code: s.code, rev: s.rev, phase: s.phase, ends: s.ends, paused: s.paused, left: s.left,
    me: pid, lead: leadOf(s), settings: s.settings, gameNo: s.gameNo,
    players: s.order.map(id => {
      const p = s.players[id];
      return { pid: id, name: p.name, av: p.av, color: p.color, score: p.score, on: p.on, relay: p.relay, done: doneFlag(s, id) };
    }),
  };
  if (!g) return v;
  const step = g.plan[Math.min(g.qi, g.plan.length - 1)];
  const G = v.g = { qi: g.qi, total: g.plan.length, round: step.round, mult: step.mult, final: step.final, chooser: g.chooser };
  if (s.phase === 'choose') G.choices = g.choices;
  if (g.q && ['write', 'vote', 'reveal', 'scores'].includes(s.phase)) { G.topic = g.q.t; G.c = g.q.c; G.q = g.q.q; }
  if (s.phase === 'write') { G.myLie = g.lies[pid] || ''; G.ideas = g.ideas[pid] || null; }
  if (s.phase === 'vote' || s.phase === 'reveal') {
    G.opts = g.opts.map(o => ({ id: o.id, text: o.text, mine: o.by.includes(pid) }));
    G.myVote = g.votes[pid] || null;
    G.myLaughs = g.laughs[pid] || [];
  }
  if (s.phase === 'reveal') { G.rvStep = g.rv.step; G.rvN = g.rv.items.length; }
  if ((s.phase === 'reveal' && g.rv.step >= g.rv.items.length - 1) || s.phase === 'scores') G.result = resultFor(s, pid);
  if (s.phase === 'scores') G.deltas = g.deltas;
  if (s.phase === 'end') G.awards = g.awards;
  return v;
}
