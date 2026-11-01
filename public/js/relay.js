// The backup path for game messages, for players whose phone or network can't connect straight to the host.
// (The same module as Horse Race's and The Deck's public/js/relay.js, with this game's own topics.)
//
// Normally every player's browser talks straight to the host's browser (WebRTC, see net.js). Some phones and
// networks block that: mobile data behind carrier NAT, VPNs, privacy and ad-blocking settings, some in-app
// browsers. PeerJS's own free relay server has shut down, so those players send their messages through free
// public MQTT message servers instead, over ordinary secure websockets, which work wherever a web page works.
//
// The host listens on <root>/<code>/h on every server. A relayed player gets their own topic
// <root>/<code>/g/<id>, says hello on every server it reached, and sticks with whichever server and host
// answer first. Messages are JSON: player to host {c: id, hs?: host session, m?: message, bye?: 1},
// host to player {hs, m?, bye?}.
//
// Just enough MQTT 3.1.1 is spoken here: connect, subscribe, publish at QoS 0, ping.

export const BROKERS = [
  { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
  { name: 'shiftr', url: 'wss://public.cloud.shiftr.io', user: 'public', pass: 'public' },   // port 443: gets through strict networks
  { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt' },
];
const ROOT = 'jjgames/lieage-v1/';
export const hostTopic = code => `${ROOT}${code}/h`;
export const guestTopic = (code, id) => `${ROOT}${code}/g/${id}`;

const IDLE_MS = 12000;    // a relayed player that sends nothing for this long has gone (they ping every 2 s)
const KEEPALIVE = 30;     // seconds, told to the server; we ping every 15 s

const te = new TextEncoder(), td = new TextDecoder();
const rid = (n = 12) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''); };
const mstr = s => { const b = te.encode(s); const out = new Uint8Array(b.length + 2); out[0] = b.length >> 8; out[1] = b.length & 255; out.set(b, 2); return out; };

function packet(type, parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const head = [type];
  let n = len;
  do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; head.push(d); } while (n);
  const out = new Uint8Array(head.length + len);
  out.set(head, 0);
  let o = head.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** One connection to one message server. */
export class Link {
  constructor(broker, onMessage, onClose) {
    this.broker = broker;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.ready = false;
    this.closed = false;
    this._buf = new Uint8Array(0);
    this._subs = new Map();
    this._nextId = 1;
  }

  /** Resolves once the server has accepted us. */
  connect(ms = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = err => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (err) { this._kill(); reject(err); } else resolve(this);
      };
      const timer = setTimeout(() => done(new Error(`${this.broker.name}: timed out`)), ms);
      let ws;
      try { ws = new WebSocket(this.broker.url, 'mqtt'); }
      catch (e) { done(e); return; }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const b = this.broker;
        const parts = [mstr('MQTT'), Uint8Array.of(4, b.user ? 0xc2 : 0x02, 0, KEEPALIVE), mstr('jjlg-' + rid(10))];
        if (b.user) parts.push(mstr(b.user), mstr(b.pass || ''));
        this._raw(packet(0x10, parts));
      };
      ws.onmessage = e => this._onData(new Uint8Array(e.data), done);
      ws.onerror = () => done(new Error(`${this.broker.name}: could not connect`));
      ws.onclose = () => {
        done(new Error(`${this.broker.name}: closed`));
        const was = this.ready;
        this.ready = false;
        clearInterval(this._ping);
        if (was && !this.closed) { this.closed = true; this.onClose && this.onClose(this); }
      };
    });
  }

  subscribe(topic, ms = 6000) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++ & 0xffff || 1;
      const timer = setTimeout(() => { this._subs.delete(id); reject(new Error(`${this.broker.name}: subscribe timed out`)); }, ms);
      this._subs.set(id, ok => { clearTimeout(timer); ok ? resolve() : reject(new Error(`${this.broker.name}: subscribe refused`)); });
      this._raw(packet(0x82, [Uint8Array.of(id >> 8, id & 255), mstr(topic), Uint8Array.of(0)]));
    });
  }

  publish(topic, text) {
    if (!this.ready) return false;
    this._raw(packet(0x30, [mstr(topic), te.encode(text)]));
    return true;
  }

  /** Close on purpose (no onClose callback). */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ready) this._raw(Uint8Array.of(0xe0, 0));
    this._kill();
  }

  _kill() {
    this.ready = false;
    clearInterval(this._ping);
    try { this.ws && this.ws.close(); } catch { }
  }

  _raw(bytes) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(bytes); } catch { } }

  _onData(chunk, connected) {
    const buf = new Uint8Array(this._buf.length + chunk.length);
    buf.set(this._buf, 0); buf.set(chunk, this._buf.length);
    let at = 0;
    for (;;) {
      if (buf.length - at < 2) break;
      let len = 0, mul = 1, i = at + 1, ok = false;
      for (let k = 0; k < 4 && i < buf.length; k++, i++) {
        len += (buf[i] & 127) * mul; mul *= 128;
        if (!(buf[i] & 128)) { ok = true; i++; break; }
      }
      if (!ok || buf.length - i < len) break;
      this._handle(buf[at], buf.subarray(i, i + len), connected);
      at = i + len;
    }
    this._buf = buf.slice(at);
  }

  _handle(b0, body, connected) {
    switch (b0 >> 4) {
      case 2:   // CONNACK
        if (body[1] === 0) {
          this.ready = true;
          this._ping = setInterval(() => this._raw(Uint8Array.of(0xc0, 0)), 15000);
          connected(null);
        } else connected(new Error(`${this.broker.name}: refused (${body[1]})`));
        break;
      case 3: {  // PUBLISH
        const qos = (b0 >> 1) & 3;
        const tlen = (body[0] << 8) | body[1];
        const topic = td.decode(body.subarray(2, 2 + tlen));
        const payload = td.decode(body.subarray(2 + tlen + (qos ? 2 : 0)));
        try { this.onMessage(this, topic, payload); } catch (e) { console.error(e); }
        break;
      }
      case 9: {  // SUBACK
        const id = (body[0] << 8) | body[1];
        const f = this._subs.get(id);
        if (f) { this._subs.delete(id); f(body[2] !== 0x80); }
        break;
      }
    }
  }
}

/** The bits of a PeerJS DataConnection that net.js uses: open, send, close, on('data' | 'close' | 'error'). */
class Conn {
  constructor() { this.open = false; this.relay = true; this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); }
  _emit(ev, a) { for (const f of this._h[ev] || []) { try { f(a); } catch (e) { console.error(e); } } }
  _data(m) { if (this.open) this._emit('data', m); }
  _gone() { if (!this.open) return; this.open = false; clearInterval(this._watch); this._emit('close'); }
}

/** The host's end of one relayed player. */
class HostConn extends Conn {
  constructor(hub, link, id) { super(); this.hub = hub; this.link = link; this.id = id; this.open = true; this.seen = Date.now(); }
  send(m) { if (this.open) this.hub._down(this, { m }); }
  close() { if (!this.open) return; this.hub._down(this, { bye: 1 }); this._gone(); }
}

/**
 * The host listens on every message server for relayed players. accept(conn) is called with each new one,
 * right before their hello is delivered on it.
 */
export class RelayHost {
  constructor(code, accept) {
    this.code = code;
    this.accept = accept;
    this.hs = rid(8);
    this.links = new Set();
    this.conns = new Map();
    this.stopped = false;
  }

  start() {
    for (const b of BROKERS) this._keep(b, 0);
    this._sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, c] of this.conns) {
        if (!c.open) this.conns.delete(id);
        else if (now - c.seen > IDLE_MS) { c._gone(); this.conns.delete(id); }
      }
    }, 3000);
    return this;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this._sweep);
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    for (const l of this.links) l.close();
    this.links.clear();
  }

  /** Stay connected to one message server, reconnecting with a growing pause if it drops. */
  async _keep(broker, tries) {
    if (this.stopped) return;
    let again = false;
    const retry = (ms, n) => { if (again || this.stopped) return; again = true; setTimeout(() => this._keep(broker, n), ms); };
    const link = new Link(broker, (l, t, p) => this._up(l, p), l => {
      this.links.delete(l);
      for (const [id, c] of this.conns) if (c.link === l) { c._gone(); this.conns.delete(id); }
      retry(2000, 0);
    });
    try {
      await link.connect();
      await link.subscribe(hostTopic(this.code));
      if (this.stopped) { link.close(); return; }
      this.links.add(link);
    } catch {
      link.close();
      retry(Math.min(60000, 3000 * 2 ** tries), tries + 1);
    }
  }

  _up(link, text) {
    if (this.stopped) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.c !== 'string' || msg.c.length > 40) return;
    if (msg.hs && msg.hs !== this.hs) return;              // meant for another host of this code
    let c = this.conns.get(msg.c);
    if (!c) {
      const m = msg.m;
      if (msg.bye || !m || (m.t !== 'hello' && m.t !== 'probe')) return;
      c = new HostConn(this, link, msg.c);
      this.conns.set(msg.c, c);
      this.accept(c);
    } else if (c.link !== link) return;                    // the same hello sent through another server
    c.seen = Date.now();
    if (msg.bye) { c._gone(); this.conns.delete(msg.c); }
    else c._data(msg.m);
  }

  _down(c, body) {
    body.hs = this.hs;
    if (!c.link.publish(guestTopic(this.code, c.id), JSON.stringify(body))) c._gone();
  }
}

/**
 * A player's end of the relay. prepare() starts connecting straight away (so switching over is quick),
 * hello(m) asks the host in, and the first host to answer is the one we talk to from then on.
 */
export class RelayGuest extends Conn {
  constructor(code) {
    super();
    this.code = code;
    this.id = rid(12);
    this.links = [];
    this.link = null;      // the server we settled on
    this.hs = null;        // the host we settled on
    this.dead = false;     // couldn't reach any message server
    this._hello = null;
    this._closed = false;
    this._lastIn = 0;
  }

  prepare() {
    let left = BROKERS.length;
    const lost = () => { if (--left === 0 && !this.links.some(l => l.ready)) { this.dead = true; this._emit('dead'); } };
    for (const b of BROKERS) {
      const link = new Link(b, (l, t, p) => this._downMsg(l, p), l => { if (l === this.link) this._gone(); });
      link.connect().then(() => link.subscribe(guestTopic(this.code, this.id))).then(() => {
        if (this._closed || (this.link && this.link !== link)) { link.close(); return; }
        this.links.push(link);
        if (this._hello) this._say(link, this._hello);
      }).catch(() => { link.close(); lost(); });
    }
    return this;
  }

  /** Ask the host in, and keep asking every 2 s until one answers (a new host may still be starting up). */
  hello(m) {
    this._hello = m;
    for (const l of this.links) this._say(l, m);
    clearInterval(this._again);
    this._again = setInterval(() => {
      if (this.hs || this._closed) { clearInterval(this._again); return; }
      for (const l of this.links) this._say(l, m);
    }, 2000);
  }

  send(m) { if (this.open && this.link) this.link.publish(hostTopic(this.code), JSON.stringify({ c: this.id, hs: this.hs, m })); }

  close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._again);
    clearInterval(this._watch);
    if (this.open && this.link) this.link.publish(hostTopic(this.code), JSON.stringify({ c: this.id, hs: this.hs, bye: 1 }));
    // give the goodbye a moment to go out before hanging up
    const links = this.links; this.links = [];
    setTimeout(() => { for (const l of links) l.close(); }, 200);
    this._gone();
  }

  get via() { return this.link ? this.link.broker.name : null; }

  _say(link, m) { link.publish(hostTopic(this.code), JSON.stringify({ c: this.id, m })); }

  _downMsg(link, text) {
    if (this._closed) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.hs !== 'string') return;
    if (!this.hs) {
      // the first host to answer is ours; hang up on the other servers
      this.hs = msg.hs; this.link = link; this.open = true;
      for (const l of this.links) if (l !== link) l.close();
      this.links = [link];
      // the host talks at least every few seconds; a long silence means it's gone
      this._watch = setInterval(() => { if (Date.now() - this._lastIn > IDLE_MS) this._gone(); }, 3000);
    }
    if (msg.hs !== this.hs || link !== this.link) return;
    this._lastIn = Date.now();
    if (msg.bye) this._gone();
    else this._data(msg.m);
  }
}
