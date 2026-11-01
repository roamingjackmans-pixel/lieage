// Rules checks for Lieage (public/js/engine.js), run before every deploy:  node tools/test.mjs
import * as E from '../public/js/engine.js';
import { PROMPTS } from '../public/js/prompts.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error('  FAIL: ' + msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`); }
function section(name, fn) { console.log(name); fn(); }

// a seeded random number generator so games play out the same way every run
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const ctxFor = (bank, seed = 1) => ({ bank, byId: new Map(bank.map(p => [p.id, p])), seen: new Set(), rand: seeded(seed) });

const BANK = [
  { id: 't1', c: 'animals', t: 'Otters', q: 'Sea otters keep a favourite _____ in a pouch under their arm.', a: 'rock', alt: ['stone'], d: ['snack', 'shell', 'coin'] },
  { id: 't2', c: 'history', t: 'Odd War', q: 'In 1932 Australia fought a "war" against _____.', a: 'emus', d: ['kangaroos', 'rabbits', 'koalas'] },
  { id: 't3', c: 'food', t: 'Fancy Fork', q: 'The first _____ were sold in tins.', a: 'tea bags', d: ['crisps', 'gummies', 'pretzels'] },
  { id: 't4', c: 'laws', t: 'Courtroom', q: 'A judge once fined a man in _____.', a: 'pennies', d: ['buttons', 'acorns', 'stamps'], x: 1 },
  { id: 't5', c: 'science', t: 'Space Snack', q: 'The first food eaten in space was _____.', a: 'applesauce', d: ['jelly', 'soup', 'toast'] },
  { id: 't6', c: 'sports', t: 'Olympic', q: 'An early Olympics held a _____ contest.', a: 'tug of war', d: ['pie eating', 'kite flying', 'chess'] },
  { id: 't7', c: 'places', t: 'Town Name', q: 'There is a town in Oregon called _____.', a: 'Boring', d: ['Sleepy', 'Dull', 'Napping'] },
  { id: 't8', c: 'popculture', t: 'Working Title', q: 'A famous film was first called _____.', a: 'Star Beast', d: ['Moon Dog', 'Sky Fish', 'Space Cow'] },
  { id: 't9', c: 'animals', t: 'Sleepy Snails', q: 'Some snails can sleep for _____.', a: '3 years', alt: ['three years'], d: ['a month', '9 weeks', '2 days'] },
  { id: 't10', c: 'food', t: 'Cereal', q: 'Corn flakes were invented as a _____ food.', a: 'health', d: ['party', 'army', 'space'] },
  { id: 't11', c: 'history', t: 'Royal Pets', q: 'A queen kept a pet _____.', a: 'wombat', d: ['sloth', 'lemur', 'goose'] },
  { id: 't12', c: 'places', t: 'Big Thing', q: 'A town has a giant _____ statue.', a: 'pineapple', d: ['shrimp', 'teapot', 'sock'] },
];

const SCREEN = 'screen-1';
function makeRoom(names = ['Ann', 'Ben', 'Cat'], settings = {}) {
  const s = E.newRoom('12345', SCREEN, 1000, settings);
  for (const [i, n] of names.entries()) ok(E.addPlayer(s, { pid: 'p' + i, name: n, av: '🦊' }, 1000).ok, `add ${n}`);
  return s;
}
/** Runs the clock forward until the phase changes (or a limit). */
function runTo(s, ctx, phase, now, limit = 200000) {
  let t = now;
  while (s.phase !== phase && t - now < limit) { t += 250; E.tick(s, t, ctx); }
  return t;
}

section('comparing answers', () => {
  ok(E.same('The Rock', 'rock'), 'leading "the" and case are ignored');
  ok(E.same('his last breath', 'last breath'), 'a leading "his" is ignored');
  ok(E.same('their very own', 'very own'), 'a leading "their" is ignored');
  ok(E.same('rocks', 'rock'), 'a plural s is ignored');
  ok(E.same('tug-of-war', 'Tug of War'), 'punctuation is ignored');
  ok(E.same('1,000', '1000'), 'thousands commas are ignored');
  ok(E.same('Café', 'cafe'), 'accents are ignored');
  ok(!E.same('bass', 'bas'), 'a double s is not a plural');
  ok(!E.same('', ''), 'empty answers are never the same');
  ok(E.isTruth(BANK[0], 'Stone'), 'alternate answers count as the truth');
  ok(!E.isTruth(BANK[0], 'pebble'), 'other words are not the truth');
});

section('the room', () => {
  const s = makeRoom([]);
  eq(E.addPlayer(s, { pid: SCREEN, name: 'Me' }).code, 'self', 'the screen cannot join as a player');
  for (let i = 0; i < E.MAX_PLAYERS; i++) E.addPlayer(s, { pid: 'x' + i, name: 'P' + i });
  eq(E.addPlayer(s, { pid: 'late', name: 'Late' }).code, 'full', `the game is full at ${E.MAX_PLAYERS} players`);
  E.setOnline(s, 'x0', false);
  ok(E.addPlayer(s, { pid: 'late', name: 'Late' }).ok, 'a player who left frees up a seat');
  ok(E.addPlayer(s, { pid: 'x0', name: 'P0' }).back, 'and someone coming back to their own seat always gets in');
  const t = makeRoom(['Sam', 'sam']);
  eq(t.players.p1.name, 'sam 2', 'two players with the same name are told apart');
  eq(E.leadOf(t), 'p0', 'the first player leads');
  E.setOnline(t, 'p0', false);
  eq(E.leadOf(t), 'p1', 'the next player leads when the first one leaves');
  ok(!E.apply(t, 'p0', { k: 'start' }, 2000, ctxFor(BANK)).ok, 'a player who left can’t act');
  E.setOnline(t, 'p0', true);
  eq(E.apply(t, 'p1', { k: 'start' }, 2000, ctxFor(BANK)).ok, false, 'only the lead (or the screen) can start');
});

section('settings and the plan', () => {
  const s = makeRoom();
  ok(E.apply(s, SCREEN, { k: 'settings', settings: { length: 'quick', writeSecs: 90, family: true } }, 1000).ok, 'the screen changes settings');
  eq(s.settings, { length: 'quick', writeSecs: 90, family: true }, 'settings are stored');
  E.apply(s, SCREEN, { k: 'settings', settings: { length: 'forever', writeSecs: 7 } }, 1000);
  eq(s.settings.length, 'quick', 'unknown lengths are ignored');
  eq(s.settings.writeSecs, 90, 'unknown writing times are ignored');
  ok(!E.apply(s, 'p1', { k: 'settings', settings: { family: false } }, 1000).ok, 'other players can’t change settings');
  ok(E.apply(s, 'p0', { k: 'settings', settings: { family: false } }, 1000).ok, 'the lead player can');
  eq(E.makePlan('quick').map(x => x.mult), [1, 1, 2, 2, 3], 'quick: 2 + 2 + the final question');
  eq(E.makePlan('classic').length, 7, 'classic has 7 questions');
  eq(E.makePlan('long').length, 9, 'long has 9 questions');
  const one = makeRoom(['Solo']);
  ok(!E.apply(one, SCREEN, { k: 'start' }, 1000, ctxFor(BANK)).ok, `you need ${E.MIN_PLAYERS} players to start`);
});

section('a whole question', () => {
  const s = makeRoom(['Ann', 'Ben', 'Cat']);
  const ctx = ctxFor(BANK, 7);
  let now = 2000;
  ok(E.apply(s, SCREEN, { k: 'start' }, now, ctx).ok, 'the screen starts the game');
  eq(s.phase, 'round', 'the game opens with the round card');
  now = runTo(s, ctx, 'choose', now);
  eq(s.game.chooser, 'p0', 'the first player picks the first topic');
  eq(s.game.choices.length, 4, 'four topics to pick from');
  eq(new Set(s.game.choices.map(c => c.c)).size, 4, 'from four different categories');
  ok(!E.apply(s, 'p1', { k: 'choose', id: s.game.choices[0].id }, now, ctx).ok, 'only the chooser picks');
  const pickId = s.game.choices.find(c => c.id === 't1') ? 't1' : s.game.choices[0].id;
  ok(E.apply(s, 'p0', { k: 'choose', id: pickId }, now, ctx).ok, 'the chooser picks a topic');
  eq(s.phase, 'write', 'then everyone writes');
  const q = s.game.q;

  // nobody's phone sees the answer
  const v = E.view(s, 'p1');
  ok(!JSON.stringify(v).includes(JSON.stringify(q.a)), 'the answer is not in a phone’s view while writing');
  eq(v.g.q, q.q, 'but the question is');

  const r = E.apply(s, 'p0', { k: 'lie', text: q.a.toUpperCase() + '.' }, now, ctx);
  eq([r.ok, r.code], [false, 'truth'], 'writing the real answer is refused');
  ok(E.apply(s, 'p0', { k: 'lie', text: 'a shiny button' }, now, ctx).ok, 'Ann writes a lie');
  ok(E.apply(s, 'p1', { k: 'lie', text: 'Shiny Button!' }, now, ctx).ok, 'Ben writes the same lie');
  ok(E.apply(s, 'p1', { k: 'idea' }, now, ctx).ok, 'asking for ideas works');
  ok(E.view(s, 'p1').g.ideas.length >= 1, 'and the ideas show up on that phone');
  ok(!E.view(s, 'p0').g.ideas, 'but not on anyone else’s');
  ok(s.ends > now + 5000, 'the timer keeps running until everyone is done');
  ok(E.apply(s, 'p2', { k: 'lie', text: 'a tiny hat' }, now, ctx).ok, 'Cat writes a lie');
  ok(s.ends <= now + 1500, 'everyone is done, so writing ends shortly');
  now = runTo(s, ctx, 'vote', now);

  const g = s.game;
  const lies = g.opts.filter(o => o.kind === 'lie');
  eq(lies.length, 2, 'the same lie from two players is one answer');
  eq(lies.find(o => o.by.length === 2).by, ['p0', 'p1'], 'and it belongs to both of them');
  eq(g.opts.filter(o => o.kind === 'truth').length, 1, 'the truth is in there once');
  eq(g.opts.length, 5, 'house lies fill up the answers to five');
  ok(!E.view(s, 'p0').g.opts.some(o => 'kind' in o || 'by' in o), 'phones can’t tell which answer is which');
  ok(E.view(s, 'p0').g.opts.some(o => o.mine), 'but they know which one is their own');

  const shiny = lies.find(o => o.by.length === 2), hat = lies.find(o => o.by[0] === 'p2');
  const truth = g.opts.find(o => o.kind === 'truth');
  ok(!E.apply(s, 'p0', { k: 'vote', opt: shiny.id }, now, ctx).ok, 'you can’t pick your own lie');
  ok(E.apply(s, 'p0', { k: 'vote', opt: hat.id }, now, ctx).ok, 'Ann falls for Cat’s lie');
  ok(!E.apply(s, 'p0', { k: 'vote', opt: truth.id }, now, ctx).ok, 'votes can’t be changed');
  ok(E.apply(s, 'p0', { k: 'laugh', opt: hat.id }, now, ctx).ok, 'Ann laughs at Cat’s lie');
  ok(E.apply(s, 'p1', { k: 'vote', opt: truth.id }, now, ctx).ok, 'Ben finds the truth');
  ok(E.apply(s, 'p2', { k: 'vote', opt: shiny.id }, now, ctx).ok, 'Cat falls for Ann and Ben’s lie');
  now = runTo(s, ctx, 'reveal', now);

  const items = s.game.rv.items;
  eq(items.length, 3, 'two lies people fell for, then the truth');
  ok(items[items.length - 1].truth, 'the truth comes last');
  ok(!E.view(s, 'p0').g.result, 'phones don’t get the result before the truth is shown');
  eq(Object.keys(s.game.deltas).sort().map(k => [k, s.game.deltas[k]]), [['p0', 250], ['p1', 750], ['p2', 250]], 'points: fooling one player 250 each, the truth 500');
  eq(s.players.p1.score, 0, 'scores don’t change until the reveal is over');
  now = runTo(s, ctx, 'scores', now);
  eq([s.players.p0.score, s.players.p1.score, s.players.p2.score], [250, 750, 250], 'scores after the first question');
  const res = E.view(s, 'p1').g.result;
  ok(res.found && res.fooled === 1 && res.pts === 750, 'Ben’s phone shows how it went for him');
  eq(E.view(s, 'p2').g.result.laughs, 1, 'Cat’s phone shows the laugh');
  eq(E.standings(s).map(x => [x.pid, x.place]), [['p1', 1], ['p0', 2], ['p2', 2]], 'standings share places on a tie');
  now = runTo(s, ctx, 'choose', now);
  eq(s.game.chooser, 'p1', 'the next player picks the next topic');
});

section('timers, leaving and the house', () => {
  const s = makeRoom(['Ann', 'Ben']);
  const ctx = ctxFor(BANK, 3);
  let now = 5000;
  E.apply(s, 'p0', { k: 'start' }, now, ctx);
  now = runTo(s, ctx, 'choose', now);
  const chooser = s.game.chooser;
  E.setOnline(s, chooser, false, now);
  E.tick(s, now + 250, ctx);
  eq(s.phase, 'write', 'a topic is picked for a chooser who left');
  E.setOnline(s, chooser, true, now);
  now += 250;
  const left = s.ends - now;
  ok(E.apply(s, 'p0', { k: 'pause' }, now, ctx).ok, 'the lead can pause');
  E.tick(s, now + 60000, ctx);
  eq(s.phase, 'write', 'nothing moves while paused');
  ok(E.apply(s, SCREEN, { k: 'pause' }, now + 60000, ctx).ok, 'the screen resumes');
  eq(s.ends - (now + 60000), left, 'the timer picks up where it left off');
  now += 60000;
  E.setOnline(s, 'p0', false, now); E.setOnline(s, 'p1', false, now);
  const before = s.ends;
  for (let i = 0; i < 40; i++) { now += 1000; E.tick(s, now, ctx); }
  ok(s.phase === 'write' && s.ends === before + 40000, 'the clock holds while nobody is here');
  E.setOnline(s, 'p0', true, now); E.setOnline(s, 'p1', true, now);
  now = runTo(s, ctx, 'vote', now);
  eq(s.game.opts.filter(o => o.kind === 'house').length, 3, 'nobody wrote a lie: the house fills in its three');
  now = runTo(s, ctx, 'reveal', now);
  eq(s.game.rv.items.length, 1, 'nobody voted: only the truth is revealed');
  ok(E.apply(s, SCREEN, { k: 'skip' }, now, ctx).ok && s.phase === 'scores', 'the screen can skip ahead');
});

section('a whole game', () => {
  const s = makeRoom(['Ann', 'Ben', 'Cat', 'Dan']);
  const ctx = ctxFor(PROMPTS, 11);
  E.apply(s, SCREEN, { k: 'settings', settings: { length: 'quick', family: true } }, 0);
  let now = 10000;
  ok(E.apply(s, SCREEN, { k: 'start' }, now, ctx).ok, 'start a quick game with the real questions');
  const rand = seeded(5);
  let guard = 0;
  const rounds = [];
  let was = null;
  while (s.phase !== 'end' && guard++ < 5000) {
    const g = s.game;
    if (s.phase === 'round' && was !== 'round') rounds.push(g.plan[g.qi].round);
    was = s.phase;
    if (s.phase === 'choose') E.apply(s, g.chooser, { k: 'choose', id: g.choices[0].id }, now, ctx);
    else if (s.phase === 'write') { for (const id of s.order) E.apply(s, id, { k: 'lie', text: `fib ${id} ${g.qi} ${Math.floor(rand() * 3)}` }, now, ctx); }
    else if (s.phase === 'vote') {
      for (const id of s.order) {
        const opts = g.opts.filter(o => !o.by.includes(id));
        E.apply(s, id, { k: 'vote', opt: opts[Math.floor(rand() * opts.length)].id }, now, ctx);
        E.apply(s, id, { k: 'laugh', opt: opts[0].id }, now, ctx);
      }
    }
    now += 500;
    E.tick(s, now, ctx);
  }
  eq(s.phase, 'end', 'the game reaches the end');
  eq(rounds, [1, 2, 3], 'round 1, round 2 and the final question each get a round card');
  eq(new Set(s.game.used).size, 5, 'five different questions');
  ok(s.game.used.every(id => !ctx.byId.get(id).x), 'family-friendly games skip grown-up questions');
  const total = s.order.reduce((n, id) => n + s.players[id].score, 0);
  ok(total > 0, 'somebody scored');
  ok(s.game.awards.winners.length >= 1, 'there’s a winner');
  const best = Math.max(...s.order.map(id => s.players[id].score));
  ok(s.game.awards.winners.every(id => s.players[id].score === best), 'the winner has the most points');
  ok(E.view(s, 'p0').g.awards, 'phones see the awards');
  ok(E.apply(s, 'p0', { k: 'start' }, now, ctx).ok, 'the lead starts another game');
  ok(s.order.every(id => s.players[id].score === 0), 'scores start again from zero');
  ok(E.apply(s, SCREEN, { k: 'lobby' }, now, ctx).ok && s.phase === 'lobby' && !s.game, 'back to the lobby');
});

section('joining, leaving and removing', () => {
  const s = makeRoom(['Ann', 'Ben', 'Cat']);
  const ctx = ctxFor(BANK, 9);
  let now = 1000;
  E.apply(s, SCREEN, { k: 'start' }, now, ctx);
  now = runTo(s, ctx, 'choose', now);
  E.apply(s, s.game.chooser, { k: 'choose', id: s.game.choices[0].id }, now, ctx);
  E.apply(s, 'p0', { k: 'lie', text: 'one' }, now, ctx);
  E.apply(s, 'p1', { k: 'lie', text: 'two' }, now, ctx);
  ok(s.ends > now + 5000, 'still waiting for Cat');
  E.setOnline(s, 'p2', false, now);
  ok(s.ends <= now + 1500, 'Cat leaves: everyone who’s here is done, so writing ends');
  ok(E.addPlayer(s, { pid: 'p2', name: 'Cat' }, now).back, 'Cat comes back to her old seat');
  ok(E.addPlayer(s, { pid: 'p9', name: 'Zed' }, now).ok, 'someone new can join mid-game');
  ok(s.game.stats.p9, 'and gets a fresh tally');
  ok(!E.apply(s, 'p0', { k: 'remove', pid: 'p9' }, now, ctx).ok, 'only the screen removes players');
  ok(E.apply(s, SCREEN, { k: 'remove', pid: 'p9' }, now, ctx).ok && !s.players.p9, 'the screen removes a player');
  ok(E.apply(s, 'p0', { k: 'me', name: 'Annie', av: '🐸' }, now, ctx).ok && s.players.p0.name === 'Annie', 'players can rename themselves');
});

section('the question bank', () => {
  ok(PROMPTS.length >= 400, `lots of questions (${PROMPTS.length})`);
  const cats = new Set(PROMPTS.map(p => p.c));
  ok(cats.size >= 8, 'questions from all eight categories');
  ok(PROMPTS.filter(p => !p.x).length >= 400, 'plenty of family-friendly questions');
  ok(PROMPTS.every(p => p.q.split('_____').length === 2), 'every question has one blank');
  ok(PROMPTS.every(p => p.d.every(d => !E.isTruth(p, d))), 'no house lie is accidentally the truth');
  // a busy screen never runs out: play 60 quick games' worth of questions without repeats inside a game
  const s = makeRoom(['Ann', 'Ben']);
  const ctx = ctxFor(PROMPTS, 2);
  E.apply(s, SCREEN, { k: 'settings', settings: { length: 'long' } }, 0);
  E.apply(s, SCREEN, { k: 'start' }, 0, ctx);
  ok(s.game.plan.length === 9, 'a long game');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
