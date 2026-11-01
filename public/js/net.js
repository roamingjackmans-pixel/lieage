// Online play, peer-to-peer with PeerJS (no game server, so the game runs on any static website).
// Adapted from Horse Race's and The Deck's lobby code.
//
// The browser that makes the game is the game screen (the host): it owns the room and runs the rules
// (engine.js), and isn't a player. Everyone else joins on their phone and connects straight to the screen's
// browser through the free PeerJS matchmaking service. The room code is the screen's PeerJS id, so joining
// is just "connect to jjlieage-v1-<code>".
//
// The screen sends each phone its own view of the room (engine.js view()), never the whole room, so the real
// answer and who wrote which lie stay on the screen until the reveal.
//
// If the screen disappears (reload, closed tab, laptop asleep), the phones keep trying to get back in for a
// few minutes. A screen that reloads grabs its code back and carries on from where it was. (Unlike Horse Race,
// no phone takes over hosting: the game lives on the screen.)
//
// Some phones and networks can't make the direct connection. If it hasn't worked within a few seconds, the
// player switches to the backup relay (relay.js), which carries the same messages through public message
// servers. The screen always listens on both, so to the rest of this file a relayed player looks the same.
import * as E from './engine.js';
import { RelayHost, RelayGuest } from './relay.js';

const PREFIX = 'jjlieage-v1-';
const roomPeerId = code => PREFIX + code;
const RTC_WAIT = 6000;    // how long the direct connection gets before we try the relay as well
// ?forcerelay in the page address skips the direct connection, for testing the relay
const FORCE_RELAY = typeof location !== 'undefined' && /[?&]forcerelay\b/.test(location.search);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function genCode() {
  const a = new Uint32Array(5);
  crypto.getRandomValues(a);
  let c = String(1 + (a[0] % 9)); // never starts with 0
  for (let i = 1; i < 5; i++) c += String(a[i] % 10);
  return c;
}
export const cleanCode = c => String(c || '').replace(/\D/g, '').slice(0, 5);

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return () => { this._h[ev] = this._h[ev].filter(f => f !== fn); }; }
  emit(ev, ...a) { for (const f of this._h[ev] || []) { try { f(...a); } catch (e) { console.error(e); } } }
}

const netErr = (code, msg) => Object.assign(new Error(msg), { code });

/** Opens a PeerJS peer (with a fixed id, or a random one). Rejects with the PeerJS error type. */
function openPeer(id, ms = 12000) {
  if (!window.Peer) return Promise.reject(netErr('net', 'The connection library did not load. Check your internet and reload.'));
  return new Promise((resolve, reject) => {
    const opts = { debug: 1 };
    const peer = id ? new window.Peer(id, opts) : new window.Peer(opts);
    let done = false;
    const finish = err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', onErr);
      if (err) { try { peer.destroy(); } catch { } reject(err); } else resolve(peer);
    };
    const onOpen = () => finish(null);
    const onErr = e => finish(netErr(e?.type || 'net', e?.type === 'unavailable-id' ? 'That game code is taken' : 'Could not reach the matchmaking service'));
    const timer = setTimeout(() => finish(netErr('timeout', 'Could not reach the matchmaking service')), ms);
    peer.on('open', onOpen);
    peer.on('error', onErr);
  });
}

/**
 * One game connection: the screen's end (create / resumeHost) or a phone's end (join / rejoin). Events:
 *  state(s)        the room changed (the whole room on the screen, a phone's own view on a phone)
 *  status(text)    connection status line (null when all is well)
 *  role(role)      became 'host' or 'guest' (or null while reconnecting)
 *  error(msg)      something went wrong (e.g. not connected right now)
 *  refused(r)      an action was refused: { err: message, code }
 *  joined(pid, back)  screen only: a player came in (back: they were here before)
 *  progress(msg)   joining is taking another route
 *  closed(msg)     the connection is gone for good
 */
export class Room extends Emitter {
  /** me: { pid, tab, name, av }. ctx: the screen's question bank for the rules (see engine.js apply). */
  constructor(me, ctx = null) {
    super();
    this.me = me;
    this.ctx = ctx;
    this.role = null;
    this.code = null;
    this.state = null;
    this.offset = 0;        // screen clock minus my clock (ms)
    this.closed = false;
    this.recovering = false;
    this._pings = [];
    this._timers = [];
  }

  now() { return Date.now() + (this.role === 'host' ? 0 : this.offset); }
  get isHost() { return this.role === 'host'; }

  // ---------- making and joining ----------
  async create(settings) {
    let last;
    for (let i = 0; i < 6; i++) {
      const code = genCode();
      try {
        const peer = await openPeer(roomPeerId(code));
        this._host(peer, E.newRoom(code, this.me.pid, Date.now(), settings));
        return code;
      } catch (e) {
        last = e;
        if (e.code !== 'unavailable-id') break;
      }
    }
    throw last || netErr('net', 'Could not create a game');
  }

  async join(code) {
    code = cleanCode(code);
    if (code.length !== 5) throw netErr('badcode', 'Game codes are 5 numbers');
    this.code = code;
    await this._tryJoin(code);
  }

  /** A phone that reloaded mid-game: get back in (keeps trying for a while if the screen is away too). */
  rejoin(code) {
    this.code = cleanCode(code);
    this._recover();
  }

  /** The screen reloaded: take the code back and carry on with the saved room. */
  async resumeHost(saved) {
    this.code = saved.code;
    this.state = saved;
    this.emit('state', this.state);
    this.emit('status', 'Getting your game back…');
    const deadline = Date.now() + 60000;
    while (!this.closed && Date.now() < deadline) {
      try {
        const peer = await openPeer(roomPeerId(saved.code));
        if (this.closed) { try { peer.destroy(); } catch { } return; }
        // everyone has to reconnect, so nobody counts as here until they do
        for (const id of saved.order) if (saved.players[id]) saved.players[id].on = false;
        this._host(peer, saved);
        this.emit('status', null);
        return;
      } catch (e) {
        // right after a reload the matchmaking service may still be holding our old connection for a moment
        await sleep(e.code === 'unavailable-id' ? 2000 : 1500);
      }
    }
    if (!this.closed) {
      this.closed = true;
      this.emit('closed', 'Could not get this game back. It may be open on another screen.');
    }
  }

  // ---------- actions ----------
  act(a) {
    if (this.role === 'host') {
      const r = this._apply(this.me.pid, a);
      if (!r.ok) this.emit('refused', r);
      return r.ok;
    }
    if (this.role === 'guest' && this.conn?.open) { this._send(this.conn, { t: 'act', a }); return true; }
    this.emit('error', 'Not connected right now, try again in a moment');
    return false;
  }

  /** Leave on purpose. */
  async leave() {
    if (this.closed) return;
    this.closed = true;
    if (this.role === 'host' && this.conns) {
      for (const c of this.conns.values()) this._send(c, { t: 'err', code: 'ended', msg: 'The game screen closed the game.' });
      await sleep(250);
    } else if (this.role === 'guest' && this.conn) {
      this._send(this.conn, { t: 'leave' });
      await sleep(150);
    }
    this._teardown();
  }

  /** Page is closing/reloading: drop connections fast so the others notice, without ending the game. */
  drop() { this.closed = true; this._teardown(); }

  // ---------- the screen's side ----------
  _host(peer, state) {
    this._teardown(true);
    this.role = 'host';
    this.peer = peer;
    this.state = state;
    this.code = state.code;
    this.conns = new Map();
    this.offset = 0;
    peer.on('connection', conn => this._onConn(conn));
    // players who can't connect directly come in through the relay
    const hub = new RelayHost(state.code, conn => {
      if (this.role === 'host' && this.hub === hub) this._onConn(conn); else conn.close();
    });
    this.hub = hub;
    hub.start();
    peer.on('error', e => {
      if (this.peer !== peer) return;
      if (e?.type === 'unavailable-id') this._bumped();   // another screen holds our code now
      else if (e?.type !== 'peer-unavailable') console.warn('host peer error', e?.type);
    });
    // time spent away (a reload) doesn't count against the current timer
    const gap = Math.max(0, Date.now() - (state.tickAt || Date.now()));
    if (gap && state.ends && !state.paused) { state.ends += gap; state.stepAt += gap; }
    state.tickAt = Date.now();
    this._every(250, () => { if (E.tick(this.state, Date.now(), this.ctx)) this._changed(); });
    this._every(3000, () => this._broadcast()); // heartbeat (lets phones notice a dead screen)
    this._every(4000, () => {                   // lost the matchmaking server? get our code back
      if (this.peer === peer && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch { } }
    });
    this.emit('role', 'host');
    this._changed();
  }

  _onConn(conn) {
    let pid = null;
    const drop = m => { this._send(conn, m); setTimeout(() => { try { conn.close(); } catch { } }, 400); };
    const helloTimer = setTimeout(() => { if (!pid) { try { conn.close(); } catch { } } }, 15000);
    conn.on('data', m => {
      if (!m || typeof m !== 'object' || this.role !== 'host') return;
      if (m.t === 'upgrade') {
        clearTimeout(helloTimer);
        if (!pid) pid = this._upgrade(conn, m);
        return;
      }
      if (m.t === 'hello') {
        if (pid) return;          // already in (the relay repeats its hello until it hears back)
        clearTimeout(helloTimer);
        if (m.v !== E.PROTO) return drop({ t: 'err', code: 'version', msg: 'This game is running a different version of Lieage. Reload the page to update.' });
        const id = String(m.pid || '');
        if (!id) return drop({ t: 'err', code: 'bad', msg: 'Bad hello' });
        const prev = this.conns.get(id);
        if (prev && prev.open && prev._tab !== m.tab) return drop({ t: 'err', code: 'dup', msg: 'You are already in this game in another tab' });
        const r = E.addPlayer(this.state, { pid: id, name: m.name, av: m.av, relay: !!conn.relay }, Date.now());
        if (!r.ok) return drop({ t: 'err', code: r.code || 'full', msg: r.err });
        if (prev) {
          this.conns.delete(id);
          this._send(prev, { t: 'err', code: 'replaced', msg: 'This game was opened in another tab' });
          setTimeout(() => { try { prev.close(); } catch { } }, 300);
        }
        pid = id;
        conn._pid = id;
        conn._tab = m.tab;
        this.conns.set(id, conn);
        this._changed();
        this.emit('joined', id, r.back);
        return;
      }
      if (!pid || this.conns.get(pid) !== conn) return;
      if (E.tick(this.state, Date.now(), this.ctx)) this._changed();
      if (m.t === 'act') this._apply(pid, m.a, conn);
      else if (m.t === 'ping') {
        this._send(conn, { t: 'pong', c: m.c, h: Date.now() });
        if (Date.now() - (this._lastBcast || 0) > 3500) this._broadcast();
      } else if (m.t === 'leave') {
        this.conns.delete(pid);
        if (E.setOnline(this.state, pid, false, Date.now())) this._changed();
        try { conn.close(); } catch { }
      }
    });
    conn.on('close', () => {
      clearTimeout(helloTimer);
      if (pid && this.conns?.get(pid) === conn) {
        this.conns.delete(pid);
        if (this.role === 'host' && E.setOnline(this.state, pid, false, Date.now())) this._changed();
      }
    });
    conn.on('error', () => { });
  }

  /**
   * A player who came in through the relay has managed a direct connection after all: move them onto it.
   * Their relay connection is hung up a moment later, once they've switched.
   */
  _upgrade(conn, m) {
    const id = String(m.pid || '');
    const prev = this.conns.get(id);
    if (conn.relay || !prev || !prev.open || !prev.relay || prev._tab !== m.tab) {
      this._send(conn, { t: 'err', code: 'upgrade' });
      setTimeout(() => { try { conn.close(); } catch { } }, 400);
      return null;
    }
    conn._pid = id; conn._tab = m.tab;
    this.conns.set(id, conn);
    this._send(conn, { t: 'upgraded' });
    setTimeout(() => { try { prev.close(); } catch { } }, 1500);
    if (this.state.players[id]) this.state.players[id].relay = false;
    this._changed();
    return id;
  }

  _apply(pid, a, conn) {
    const r = E.apply(this.state, pid, a, Date.now(), this.ctx);
    if (!r.ok && conn) this._send(conn, { t: 'err', code: 'action', msg: r.err, why: r.code || '' });
    if (r.ok) this._changed();
    return r;
  }

  _changed() {
    this.state.rev = (this.state.rev || 0) + 1;
    if (!this._bcastQueued) {
      this._bcastQueued = true;
      setTimeout(() => { this._bcastQueued = false; this._broadcast(); }, 20);
    }
    this.emit('state', this.state);
  }

  _broadcast() {
    if (this.role !== 'host' || !this.conns) return;
    this._lastBcast = Date.now();
    for (const c of this.conns.values()) this._send(c, { t: 'state', s: E.view(this.state, c._pid) });
  }

  /** Another screen took our code while we were cut off (the game was opened again somewhere else). */
  _bumped() {
    if (this.role !== 'host') return;
    this.closed = true;
    this._teardown();
    this.emit('closed', 'This game was opened on another screen.');
  }

  // ---------- a phone's side ----------
  /**
   * Connect to the screen: straight to its browser if we can, otherwise through the relay. The relay starts
   * connecting at once, so switching over is quick, and gets used if the direct connection fails or hasn't
   * opened within RTC_WAIT. Without the matchmaking service at all, the relay is the only way in.
   */
  _tryJoin(code, ms = 20000) {
    return openPeer(null).catch(() => null).then(peer => new Promise((resolve, reject) => {
      if (this.closed) { if (peer) { try { peer.destroy(); } catch { } } return reject(netErr('closed', 'Closed')); }
      const hello = { t: 'hello', v: E.PROTO, pid: this.me.pid, tab: this.me.tab, name: this.me.name, av: this.me.av };
      const relay = new RelayGuest(code).prepare();
      let rtc = null, path = null, joined = false, failed = false, slow = 0, relayWhy = '';
      this._t(`join ${code}${peer ? '' : ' (no matchmaking service)'}`);
      const fail = (c, msg) => {
        if (joined || failed) return;
        this._t(`join failed: ${c}`);
        failed = true; clearTimeout(timer); clearTimeout(slow);
        if (peer) { try { peer.destroy(); } catch { } }
        relay.close();
        reject(netErr(c, msg));
      };
      const timer = setTimeout(() => fail('timeout', "Couldn't connect to that game. Check the code and try again."), ms);
      const onData = conn => m => {
        if (!m || typeof m !== 'object' || failed) return;
        if (!joined) {
          if (m.t === 'state') {
            joined = true; clearTimeout(timer); clearTimeout(slow);
            if (conn === rtc) relay.close(); else if (rtc) { try { rtc.close(); } catch { } }
            this.via = conn === rtc ? 'direct' : 'relay';
            this._t(`joined ${this.via === 'relay' ? 'through the relay (' + relay.via + ')' : 'directly'}`);
            this._guest(peer, conn); this._onGuestMsg(conn, m); resolve();
            // the direct connection may only have been unlucky (e.g. tried while the screen was starting up)
            if (conn === relay && peer && relayWhy !== 'forced') { this._later(8000, () => this._tryUpgrade()); this._later(45000, () => this._tryUpgrade()); }
          } else if (m.t === 'err') fail(m.code, m.msg);
          return;
        }
        this._onGuestMsg(conn, m);
      };
      const deadMsg = () => (peer
        ? "Couldn't connect to that game. Your network may be blocking it."
        : 'Could not reach the game servers. Check your internet connection.');
      const useRelay = why => {
        if (path || joined || failed) return;
        this._t(`trying the relay: ${why}`);
        relayWhy = why;
        if (relay.dead) return fail(peer ? 'timeout' : 'net', deadMsg());
        path = 'relay';
        clearTimeout(slow);
        if (rtc) { try { rtc.close(); } catch { } }
        this.emit('progress', 'Connecting another way…');
        relay.hello(hello);
      };
      relay.on('data', onData(relay));
      relay.on('close', () => {
        if (joined) { if (this.conn === relay) this._lost(); }
        else if (path === 'relay') fail('timeout', 'Lost the connection to the game');
      });
      relay.on('dead', () => { if (path === 'relay' && !joined) fail(peer ? 'timeout' : 'net', deadMsg()); });
      if (!peer || FORCE_RELAY) { useRelay(peer ? 'forced' : 'no matchmaking service'); return; }

      rtc = peer.connect(roomPeerId(code), { reliable: true, serialization: 'json', metadata: { pid: this.me.pid } });
      slow = setTimeout(() => useRelay('direct connection is slow'), RTC_WAIT);
      peer.on('error', e => {
        if (joined || failed) return;
        if (e?.type === 'peer-unavailable') fail('notfound', 'No game with that code is open');
        else useRelay(`error ${e?.type}`);     // the direct connection (or the matchmaking service) gave up on us
      });
      rtc.on('open', () => {
        if (path || failed) { try { rtc.close(); } catch { } return; }
        path = 'direct';
        this._t('direct connection open');
        clearTimeout(slow);
        relay.close();
        this._send(rtc, hello);
      });
      rtc.on('data', onData(rtc));
      rtc.on('close', () => {
        if (joined) { if (this.conn === rtc) this._lost(); return; }
        if (path === 'direct') fail('timeout', 'The game closed the connection');
        else if (!path) useRelay('direct connection failed');
      });
      rtc.on('error', () => { });
    }));
  }

  /**
   * We came in through the relay, maybe only because the direct connection was unlucky. Try a direct one now,
   * and if the screen takes it, switch over to it and hang up the relay.
   */
  _tryUpgrade() {
    const peer = this.peer, relay = this.conn;
    if (this.role !== 'guest' || this.closed || !relay || !relay.relay || !peer || peer.destroyed || peer.disconnected || this._upgrading) return;
    this._upgrading = true;
    this._t('trying for a direct connection');
    const rtc = peer.connect(roomPeerId(this.code), { reliable: true, serialization: 'json', metadata: { pid: this.me.pid } });
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true; clearTimeout(timer); this._upgrading = false;
      if (!ok) { this._t('no direct connection, staying on the relay'); try { rtc.close(); } catch { } }
    };
    const timer = setTimeout(() => finish(false), 10000);
    rtc.on('open', () => this._send(rtc, { t: 'upgrade', pid: this.me.pid, tab: this.me.tab }));
    rtc.on('data', m => {
      if (done) { if (this.conn === rtc) this._onGuestMsg(rtc, m); return; }
      if (!m || m.t !== 'upgraded' || this.role !== 'guest' || this.conn !== relay) return finish(false);
      finish(true);
      this.conn = rtc; this.via = 'direct'; this._lastMsg = Date.now();
      this._t('switched to a direct connection');
      relay.close();
    });
    rtc.on('close', () => { if (!done) finish(false); else if (this.conn === rtc) this._lost(); });
    rtc.on('error', () => { });
  }

  _guest(peer, conn) {
    this._teardown(true);
    this.role = 'guest';
    this.peer = peer;
    this.conn = conn;
    this._lastMsg = Date.now();
    this._pings = [];
    const ping = () => this._send(this.conn, { t: 'ping', c: Date.now() });
    ping();
    this._every(2000, () => {
      if (this.role !== 'guest' || !this.conn) return;
      ping();
      if (Date.now() - this._lastMsg > 10000) this._lost(); // the screen went quiet
    });
    this._every(5000, () => { if (peer && this.peer === peer && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch { } } });
    this.emit('role', 'guest');
  }

  _onGuestMsg(conn, m) {
    if (this.conn !== conn) return;
    this._lastMsg = Date.now();
    switch (m.t) {
      case 'state':
        if (!m.s || typeof m.s !== 'object') return;
        this.state = m.s;
        this.code = m.s.code;
        this.emit('state', this.state);
        break;
      case 'pong': {
        const now = Date.now();
        const rtt = now - m.c;
        this._pings.push({ rtt, off: m.h + rtt / 2 - now });
        if (this._pings.length > 8) this._pings.shift();
        this.offset = this._pings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
        this.ping = rtt;
        break;
      }
      case 'err':
        if (m.code === 'action') this.emit('refused', { err: m.msg, code: m.why });
        else { this.closed = true; this._teardown(); this.emit('closed', m.msg || 'Disconnected'); }
        break;
    }
  }

  /** Lost the screen. Keep trying to get back in. */
  _lost() {
    if (this.role !== 'guest' || this.closed) return;
    this._teardown();
    this._recover();
  }

  async _recover() {
    if (this.recovering || this.closed) return;
    this.recovering = true;
    this.role = null;
    this.emit('role', null);
    this.emit('status', 'Lost the game screen. Reconnecting…');
    this._t('lost the screen');
    const deadline = Date.now() + 180000;
    let round = 0;
    while (!this.closed && Date.now() < deadline) {
      try {
        await this._tryJoin(this.code, 12000);
        this.recovering = false;
        this.emit('status', null);
        return;
      } catch (e) {
        if (this.closed) break;
        if (['dup', 'version', 'full', 'replaced', 'self', 'bad', 'ended'].includes(e.code)) {
          this.recovering = false;
          this.closed = true;
          this.emit('closed', e.message);
          return;
        }
        await sleep(e.code === 'notfound' ? 2500 : 1200);
      }
      round++;
      this.emit('status', `Waiting for the game screen to come back… (try ${round + 1})`);
    }
    this.recovering = false;
    if (!this.closed) { this.closed = true; this.emit('closed', 'The game screen has gone away.'); }
  }

  // ---------- plumbing ----------
  _send(conn, m) { if (conn?.open) { try { conn.send(m); } catch (e) { console.warn('send failed', e); } } }
  _every(ms, fn) { this._timers.push(setInterval(fn, ms)); }
  _later(ms, fn) { this._timers.push(setTimeout(fn, ms)); }     // cleared by _teardown too (same id list)
  /** A short log of how connecting went, for the console and for figuring out problems. */
  _t(msg) {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
    (this.trace ||= []).push(line);
    if (this.trace.length > 80) this.trace.shift();
    console.debug('[net]', msg);
  }
  _teardown(keepFlags) {
    for (const t of this._timers) { clearInterval(t); clearTimeout(t); }
    this._timers = [];
    if (this.conns) { for (const c of this.conns.values()) { try { c.close(); } catch { } } this.conns = null; }
    if (this.hub) { const h = this.hub; this.hub = null; h.stop(); }
    if (this.conn) { const c = this.conn; this.conn = null; try { c.close(); } catch { } }
    if (this.peer) { const p = this.peer; this.peer = null; try { p.destroy(); } catch { } }
    if (!keepFlags) this.role = null;
  }
}
