#!/usr/bin/env node
/* smoke.js — boot app.js in a fake page and walk the paths that matter.

   Why it exists: this build has no browser check (agents never open his
   screen), so this proves in Node what a browser would show. The connect
   link is scrubbed before any request. A key is stored only after a 200. A
   turn streams onto the glass and into the voice queue in order, two
   sentences fetched ahead. A tap cuts Goose off. No line holds the take for
   a resend. A breath of quiet ends a take. A closed door outlives a reload,
   however long the talk sat quiet, and the glass shows the door the Mac
   names on every conv event. The sponsor's number never leaves
   localStorage. And nothing ever writes markup: the fake elements throw on
   innerHTML, outerHTML, insertAdjacentHTML and document.write.

   What it never does: no network, no browser, no files written. It reads
   index.html and app.js, and runs app.js in a vm context whose fetch is a
   script.

   Run: node tools/smoke.js   (prints SMOKE OK and exits 0, or names the
   failure and exits 1) */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const SHELL = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(SHELL, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(SHELL, 'app.js'), 'utf8');

const API = 'http://127.0.0.1:8650';
const KEY = 'devkey_' + 'A'.repeat(36);
const CFG = JSON.stringify({ api: API, key: KEY });
const HEALTH = { ok: true, name: 'goose', version: '0.1.0', model: 'gemma4:12b', ear: true, mouth: true };

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await tick(5);
  }
  throw new Error('timed out waiting for ' + what);
}
const link = obj => '#cfg=' + Buffer.from(JSON.stringify(obj)).toString('base64url');
const json = (status, obj) => new Response(JSON.stringify(obj),
  { status, headers: { 'Content-Type': 'application/json' } });

/* ── the fake page ─────────────────────────────────────────────────────── */
function makeEvent(type, extra) {
  return Object.assign({ type, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, extra || {});
}
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
}
class Style {
  constructor() { this.props = {}; }
  setProperty(k, v) { this.props[k] = String(v); }
}
class FakeEl {
  constructor(page, tag) {
    this.page = page;
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.children = [];
    this.parentNode = null;
    this.ownText = '';
    this.attrs = {};
    this.listeners = {};
    this.classList = new ClassList();
    this.style = new Style();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.title = '';
    this.placeholder = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this._src = '';
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) {
    this.classList = new ClassList();
    String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) {
    this.children.forEach(c => { c.parentNode = null; });
    this.children = [];
    this.ownText = String(v);
  }
  get innerHTML() { throw new Error('innerHTML was read'); }
  set innerHTML(v) { throw new Error('innerHTML was written: ' + String(v).slice(0, 60)); }
  set outerHTML(v) { throw new Error('outerHTML was written'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML was called'); }
  appendChild(c) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  insertBefore(c, ref) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  replaceChildren(...cs) {
    this.children.forEach(c => { c.parentNode = null; });
    this.children = [];
    this.ownText = '';
    this.append(...cs);
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.children = p.children.filter(x => x !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this._src = ''; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    for (const f of (this.listeners[ev.type] || []).slice()) f.call(this, ev);
    return !ev.defaultPrevented;
  }
  click() { return this.dispatchEvent(makeEvent('click')); }
  focus() { this.page.document.activeElement = this; }
  // the one <audio>
  get src() { return this._src; }
  set src(v) { this._src = String(v); }
  play() { this.page.played.push(this._src); return Promise.resolve(); }
  pause() { this.page.paused++; }
  load() {}
}
function walk(n, fn) { fn(n); for (const c of n.children) walk(c, fn); }

function makePage(opts) {
  opts = opts || {};
  const host = opts.host || '127.0.0.1';
  const page = {
    calls: [], routes: [], log: [], played: [], paused: 0, wake: 0, recorders: [], gum: [],
    level: 128, skew: 0, tones: 0, tracksStopped: 0, reloads: 0,
    storage: new Map(Object.entries(opts.storage || {})),
  };
  const byId = new Map();
  // every element with an id in index.html, with its tag, its attributes and its hidden flag
  for (const m of HTML.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const attrs = m[2];
    const id = /\bid="([^"]+)"/.exec(attrs);
    if (!id) continue;
    if (byId.has(id[1])) throw new Error('duplicate id in index.html: ' + id[1]);
    const e = new FakeEl(page, m[1]);
    e.id = id[1];
    for (const a of attrs.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) {
      if (a[1] === 'hidden') e.hidden = true;
      else e.attrs[a[1]] = a[2] === undefined ? '' : a[2];
    }
    if (e.attrs['data-state']) e.dataset.state = e.attrs['data-state'];
    byId.set(id[1], e);
  }
  const doc = {
    activeElement: null, visibilityState: 'visible', hidden: false, listeners: {},
    getElementById: id => byId.get(id) || null,
    createElement: tag => new FakeEl(page, tag),
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    removeEventListener() {},
    write() { throw new Error('document.write was called'); },
  };
  page.document = doc;
  const location = {
    hash: opts.hash || '', pathname: '/', search: '', hostname: host,
    origin: 'http://' + host + ':8917',
    get href() { return this.origin + this.pathname + this.search + this.hash; },
    reload() { page.reloads++; },
    replace(u) { page.log.push('replace ' + u); },
  };
  const history = {
    replaceState(s, t, url) {
      page.log.push('replaceState');
      const u = new URL(url, location.href);
      location.pathname = u.pathname;
      location.search = u.search;
      location.hash = u.hash;
    },
  };
  const localStorage = {
    getItem: k => (page.storage.has(k) ? page.storage.get(k) : null),
    setItem: (k, v) => { page.storage.set(k, String(v)); },
    removeItem: k => { page.storage.delete(k); },
  };
  async function fetch(url, o) {
    o = o || {};
    const req = { url: String(url), method: (o.method || 'GET').toUpperCase(),
                  headers: Object.assign({}, o.headers || {}), body: o.body, signal: o.signal };
    page.calls.push(req);
    page.log.push('fetch ' + req.method + ' ' + new URL(req.url).pathname);
    if (req.signal && req.signal.aborted) throw new DOMException('aborted', 'AbortError');
    for (const route of page.routes) {
      const out = await route(req);
      if (out !== undefined) {
        if (out instanceof Error) throw out;
        return out;
      }
    }
    return json(404, { error: 'no route in the smoke test' });
  }
  class MediaRecorder {
    static isTypeSupported(t) { return t === 'audio/webm;codecs=opus'; }
    constructor(stream, o) {
      this.opts = o || {};
      this.mimeType = this.opts.mimeType || '';
      this.state = 'inactive';
      this.l = {};
      page.recorders.push(this);
    }
    addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }
    emit(t, e) { for (const f of this.l[t] || []) f(e); }
    start(slice) {
      this.state = 'recording';
      this.slice = slice;
      this.emit('dataavailable', { data: new Blob(['OPUS-HEAD'], { type: this.mimeType }) });
    }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      setTimeout(() => {
        this.emit('dataavailable', { data: new Blob(['OPUS-TAIL'], { type: this.mimeType }) });
        this.emit('stop', {});
      }, 0);
    }
  }
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return { fftSize: 2048, frequencyBinCount: 256, connect() {},
               getByteTimeDomainData(a) { a.fill(page.level); } };
    }
    createOscillator() {
      page.tones++;
      return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }
  // a blob URL that says which blob it is, so the play order can be read back
  class PageURL extends URL {
    static createObjectURL(b) { return 'blob:size-' + b.size; }
    static revokeObjectURL() {}
  }
  const navigator = {
    vibrate: () => true,
    mediaDevices: {
      getUserMedia: async c => {
        page.gum.push(c);
        const track = { readyState: 'live', stop() { this.readyState = 'ended'; page.tracksStopped++; } };
        return { getAudioTracks: () => [track], getTracks: () => [track] };
      },
    },
    wakeLock: {
      request: async () => {
        page.wake++;
        return { released: false, addEventListener() {},
                 release() { if (!this.released) { this.released = true; page.wake--; } return Promise.resolve(); } };
      },
    },
    serviceWorker: {
      controller: null,
      register: () => Promise.resolve({ update: () => Promise.resolve(), scope: location.origin + '/' }),
      addEventListener() {},
      getRegistrations: () => Promise.resolve([]),
    },
  };
  const perf = { now: () => performance.now() + page.skew };
  const sandbox = {
    document: doc, location, history, localStorage, navigator, fetch, performance: perf,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: f => setTimeout(f, 0),
    console, URL: PageURL, Blob, Response, ReadableStream, TextEncoder, TextDecoder,
    AbortController, DOMException, atob, btoa, MediaRecorder, AudioContext,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    confirm: () => true,
    caches: { keys: async () => [], delete: async () => true },
    winListeners: {},
    addEventListener(t, f) { (this.winListeners[t] = this.winListeners[t] || []).push(f); },
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  Object.assign(page, {
    location,
    $: id => byId.get(id),
    key: () => byId.get('key').dataset.state,
    boot() { vm.runInContext(APP, sandbox, { filename: 'app.js' }); },
    on(method, prefix, fn) {
      page.routes.push(req => (req.method === method && new URL(req.url).pathname.startsWith(prefix)
                               ? fn(req) : undefined));
    },
    online() {
      page.on('GET', '/api/health', () => json(200, HEALTH));
      page.on('POST', '/api/warm', () => json(200, { ok: true }));
    },
    hide() {
      doc.visibilityState = 'hidden';
      doc.hidden = true;
      for (const f of doc.listeners.visibilitychange || []) f(makeEvent('visibilitychange'));
    },
    turns() {
      const out = [];
      walk(byId.get('thread'), n => { if (n.classList && n.classList.contains('turn')) out.push(n); });
      return out;
    },
    find(cls) {
      const out = [];
      walk(byId.get('thread'), n => { if (n.classList && n.classList.contains(cls)) out.push(n); });
      return out;
    },
    callsTo: p => page.calls.filter(c => new URL(c.url).pathname.startsWith(p)),
  });
  return page;
}

/* an NDJSON turn stream: events now, more by push(), closed by end() */
function ndjson(events, signal, hold) {
  let ctl;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      ctl = c;
      for (const e of events) c.enqueue(enc.encode(JSON.stringify(e) + '\n'));
      if (!hold) c.close();
    },
  });
  if (signal) signal.addEventListener('abort', () => {
    try { ctl.error(new DOMException('aborted', 'AbortError')); } catch (e) {}
  });
  return {
    res: new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
    push: e => ctl.enqueue(enc.encode(JSON.stringify(e) + '\n')),
    end: () => ctl.close(),
  };
}

/* ── the scenarios ─────────────────────────────────────────────────────── */
const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['FAIL', name, e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : String(e)]);
  }
}

async function main() {
  await scenario('a connect link is scrubbed before any request, and the key is stored only after a 200', async () => {
    const code = 'c'.repeat(32);
    const p = makePage({ hash: link({ api: API, code }) });
    let cfgAtHealth = 'never asked';
    p.on('POST', '/api/connect', () => json(200, { key: KEY, device: 'preview' }));
    p.on('GET', '/api/health', () => {
      if (cfgAtHealth === 'never asked') cfgAtHealth = p.storage.get('goose.cfg') || null;
      return json(200, HEALTH);
    });
    p.on('POST', '/api/warm', () => json(200, { ok: true }));
    p.boot();
    await until(() => p.storage.has('goose.cfg'), 'goose.cfg');
    const firstFetch = p.log.findIndex(x => x.startsWith('fetch'));
    const scrub = p.log.indexOf('replaceState');
    assert.ok(scrub >= 0 && scrub < firstFetch, 'the scrub must come before the first request: ' + p.log.join(', '));
    assert.equal(p.location.hash, '');
    const [c0, c1] = p.calls;
    assert.equal(c0.method, 'POST');
    assert.equal(c0.url, API + '/api/connect');
    assert.deepEqual(JSON.parse(c0.body), { code, device: 'preview' });
    assert.equal(c0.headers.Authorization, undefined, 'the connect call carries no key');
    assert.equal(c1.method, 'GET');
    assert.equal(c1.url, API + '/api/health');
    assert.equal(c1.headers.Authorization, 'Bearer ' + KEY);
    assert.equal(cfgAtHealth, null, 'nothing may be stored before the health check answers');
    assert.deepEqual(JSON.parse(p.storage.get('goose.cfg')), { api: API, key: KEY });
    assert.equal(p.$('talk').hidden, false);
    assert.equal(p.$('connect').hidden, true);
  });

  await scenario('a phone names itself "phone"; the preview names itself "preview"', async () => {
    const p = makePage({ host: 'bik-goose.github.io', hash: link({ api: 'https://mac.tail1234.ts.net:8650', code: 'd'.repeat(32) }) });
    p.on('POST', '/api/connect', () => json(200, { key: KEY, device: 'phone' }));
    p.on('GET', '/api/health', () => json(200, HEALTH));
    p.on('POST', '/api/warm', () => json(200, { ok: true }));
    p.boot();
    await until(() => p.storage.has('goose.cfg'), 'goose.cfg');
    assert.equal(JSON.parse(p.calls[0].body).device, 'phone');
    assert.equal(JSON.parse(p.storage.get('goose.cfg')).api, 'https://mac.tail1234.ts.net:8650');
  });

  await scenario('a link to any other address, port or shape is refused with no request', async () => {
    const bad = [
      { api: 'https://evil.example.com:8650', code: 'e'.repeat(32) },
      { api: 'https://mac.tail1234.ts.net', code: 'e'.repeat(32) },
      { api: 'https://mac.tail1234.ts.net:8600', code: 'e'.repeat(32) },
      { api: 'http://mac.tail1234.ts.net:8650', code: 'e'.repeat(32) },
      { api: 'http://127.0.0.1:8650/api', code: 'e'.repeat(32) },
      { api: 'http://127.0.0.1:8650', code: 'short' },
      { api: 'http://127.0.0.1:8650' },
    ];
    for (const c of bad) {
      const p = makePage({ hash: link(c) });
      p.boot();
      await tick(20);
      assert.equal(p.calls.length, 0, 'no request for ' + JSON.stringify(c));
      assert.equal(p.storage.has('goose.cfg'), false);
      assert.equal(p.$('connect').hidden, false);
      assert.match(p.$('connectWhy').textContent, /didn't work/);
      assert.equal(p.location.hash, '');
    }
    const junk = makePage({ hash: '#cfg=%%%not-base64' });
    junk.boot();
    await tick(20);
    assert.equal(junk.calls.length, 0);
    assert.equal(junk.location.hash, '');
  });

  await scenario('a key that fails the health check, or a used code, is never stored', async () => {
    const p = makePage({ hash: link({ api: API, code: 'f'.repeat(32) }) });
    p.on('POST', '/api/connect', () => json(200, { key: KEY, device: 'preview' }));
    p.on('GET', '/api/health', () => json(500, { error: 'boom' }));
    p.boot();
    await until(() => /didn't work/.test(p.$('connectWhy').textContent), 'the refusal');
    assert.equal(p.storage.has('goose.cfg'), false);
    const q = makePage({ hash: link({ api: API, code: 'g'.repeat(32) }) });
    q.on('POST', '/api/connect', () => json(403, { error: 'no' }));
    q.boot();
    await until(() => /used already or ran out/.test(q.$('connectWhy').textContent), 'the 403 words');
    assert.equal(q.storage.has('goose.cfg'), false);
    assert.equal(q.callsTo('/api/health').length, 0);
  });

  await scenario('not connected: the calm screen, no request, and the 988 rail still opens', async () => {
    const p = makePage();
    p.boot();
    await tick(20);
    assert.equal(p.$('connect').hidden, false);
    assert.equal(p.$('talk').hidden, true);
    assert.equal(p.calls.length, 0);
    assert.equal(p.$('b988').getAttribute('href'), 'tel:988');
    const ev = makeEvent('click');
    p.$('b988').dispatchEvent(ev);
    assert.ok(ev.defaultPrevented, 'with the script, 988 opens the sheet instead of dialing at once');
    assert.equal(p.$('sheetRail').hidden, false);
    assert.equal(p.$('b988').getAttribute('aria-expanded'), 'true');
    assert.equal(p.$('call988').getAttribute('href'), 'tel:988');
    assert.equal(p.$('text988').getAttribute('href'), 'sms:988');
    assert.equal(p.calls.length, 0);
  });

  await scenario('a typed turn streams onto the glass; voice off means no /api/say; the talk id carries on', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    const turns = [];
    p.on('POST', '/api/turn', req => {
      turns.push(req);
      return ndjson([
        { type: 'heard', text: 'what do I do this week', ms: 0 },
        { type: 'conv', conv_id: 7 },
        { type: 'route', route: 'ask' },
        { type: 'sentence', i: 0, text: 'Take the labor job.' },
        { type: 'lesson', id: 3, lane: 'rule', statement: "Don't answer with a question.", status: 'proposed' },
        { type: 'sentence', i: 1, text: "New rule — don't answer with a question. Keep it?" },
        { type: 'done', episode_id: 12, ms: { total: 2100 } },
      ], req.signal).res;
    });
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'what do I do this week';
    p.$('send').click();
    await until(() => p.storage.has('goose.conv') && p.key() === 'idle', 'the turn to land');
    const t = turns[0];
    assert.equal(t.url, API + '/api/turn');
    assert.equal(t.headers['Content-Type'], 'application/json');
    assert.equal(t.headers.Authorization, 'Bearer ' + KEY);
    assert.equal(t.headers['X-Goose-Via'], undefined);
    assert.deepEqual(JSON.parse(t.body), { text: 'what do I do this week' });
    const glass = p.turns().map(x => x.textContent).join(' | ');
    assert.match(glass, /what do I do this week/);
    assert.match(glass, /Take the labor job\./);
    assert.match(glass, /rule — keep it\?/);
    assert.equal(p.find('heard').length, 0, 'a typed line is plain, not "heard:"');
    assert.equal(p.callsTo('/api/say').length, 0);
    assert.equal(JSON.parse(p.storage.get('goose.conv')).id, 7);
    assert.equal(p.$('text').value, '');
    p.skew += 1000;
    p.$('text').value = 'and after that?';
    p.$('send').click();
    await until(() => turns.length === 2, 'the second turn');
    assert.deepEqual(JSON.parse(turns[1].body), { text: 'and after that?', conv_id: 7 });
  });

  await scenario('a voice take: the SPEC mic, Opus at 24 kbps in 250 ms chunks, the blob posted with its headers', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG } });
    p.online();
    let turn = null;
    p.on('POST', '/api/turn', req => { turn = ndjson([], req.signal, true); turn.req = req; return turn.res; });
    const said = [];
    const lines = ['The trailer is down for about a month.', 'Take the labor job.',
                   'Book loads again when the axle lands.', 'My read: that covers November.'];
    p.on('POST', '/api/say', req => {
      const text = JSON.parse(req.body).text;
      said.push(text);
      return new Response(new Blob(['x'.repeat(100 + lines.indexOf(text))]),
                          { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    });
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('key').click();
    await until(() => p.recorders.length === 1, 'the recorder');
    // compared as JSON: the object was made inside the vm's own realm, and the
    // text form also pins the SPEC's exact constraints, in its order
    assert.equal(JSON.stringify(p.gum[0]),
                 JSON.stringify({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }));
    const mr = p.recorders[0];
    assert.equal(mr.opts.mimeType, 'audio/webm;codecs=opus');
    assert.equal(mr.opts.audioBitsPerSecond, 24000);
    assert.equal(mr.slice, 250);
    assert.equal(p.key(), 'listening');
    assert.ok(p.$('key').classList.contains('live'));
    assert.ok(p.tones >= 2, 'the mic-live chirp plays once frames flow');
    await until(() => p.wake === 1, 'the wake lock while listening');
    p.skew += 1000;
    p.$('key').click();                                  // tap when done
    await until(() => turn && turn.req, 'the voice turn');
    const h = turn.req.headers;
    assert.equal(h['Content-Type'], 'audio/webm;codecs=opus');
    assert.equal(h['X-Goose-Via'], 'voice');
    assert.equal(h['X-Goose-Conv'], undefined, 'no talk id yet, so none is sent');
    assert.equal(h.Authorization, 'Bearer ' + KEY);
    assert.equal(typeof turn.req.body.size, 'number');
    assert.equal(p.key(), 'thinking');
    turn.push({ type: 'heard', text: 'the trailer is down what do I do', ms: 410 });
    turn.push({ type: 'conv', conv_id: 9 });
    turn.push({ type: 'route', route: 'ask' });
    for (let i = 0; i < 4; i++) turn.push({ type: 'sentence', i, text: lines[i] });
    await until(() => said.length === 3 && p.played.length === 1, 'three fetched, one playing');
    await tick(30);
    assert.equal(said.length, 3, 'the one playing plus two ahead, no more');
    assert.deepEqual(said, lines.slice(0, 3));
    assert.equal(p.played[0], 'blob:size-100');
    assert.equal(p.key(), 'speaking');
    assert.equal(p.find('heard').length, 1);
    assert.equal(p.find('lit').length, 1, 'the sentence being spoken is lit');
    p.$('voice').dispatchEvent(makeEvent('ended'));
    await until(() => said.length === 4 && p.played.length === 2, 'the fourth fetched as the second plays');
    assert.equal(p.played[1], 'blob:size-101');
    turn.push({ type: 'done', episode_id: 20, ms: { total: 3000 } });
    turn.end();
    p.$('voice').dispatchEvent(makeEvent('ended'));
    await until(() => p.played.length === 3, 'the third');
    p.$('voice').dispatchEvent(makeEvent('ended'));
    await until(() => p.played.length === 4, 'the fourth');
    assert.deepEqual(p.played, ['blob:size-100', 'blob:size-101', 'blob:size-102', 'blob:size-103']);
    p.$('voice').dispatchEvent(makeEvent('ended'));
    await until(() => p.key() === 'idle', 'idle after the last sentence');
    assert.equal(p.find('lit').length, 0);
    await until(() => p.wake === 0, 'the wake lock let go');
    assert.equal(JSON.parse(p.storage.get('goose.conv')).id, 9);
  });

  await scenario('a tap while Goose talks stops the voice, drops the answer stream and opens the mic', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG } });
    p.online();
    let turn = null;
    p.on('POST', '/api/turn', req => { turn = ndjson([], req.signal, true); turn.req = req; return turn.res; });
    p.on('POST', '/api/say', () => new Response(new Blob(['y'.repeat(200)]), { status: 200 }));
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'talk to me';
    p.$('send').click();
    await until(() => turn, 'the turn');
    turn.push({ type: 'conv', conv_id: 4 });
    turn.push({ type: 'sentence', i: 0, text: 'Here is the long version.' });
    turn.push({ type: 'sentence', i: 1, text: 'And another thing.' });
    await until(() => p.key() === 'speaking', 'speaking');
    const pausedBefore = p.paused;
    p.skew += 1000;
    p.$('key').click();                                  // cut in
    await until(() => p.key() === 'listening' && p.recorders.length === 1, 'the mic open after the cut-in');
    assert.ok(p.paused > pausedBefore, 'the voice stopped');
    assert.equal(turn.req.signal.aborted, true, 'the answer stream was let go');
    assert.equal(p.$('voice').src, '');
    const playedBefore = p.played.length;
    p.$('voice').dispatchEvent(makeEvent('ended'));
    await tick(20);
    assert.equal(p.played.length, playedBefore, 'nothing queued plays after a cut-in');
    assert.ok(p.turns()[0].classList.contains('cut'));
  });

  await scenario('no line: the red notch, the take held in memory, and one tap resends the same words', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    let fail = true;
    const bodies = [];
    p.on('POST', '/api/turn', req => {
      bodies.push(req.body);
      if (fail) return new TypeError('Failed to fetch');
      return ndjson([{ type: 'conv', conv_id: 5 }, { type: 'sentence', i: 0, text: 'Got it now.' },
                     { type: 'done', episode_id: 1, ms: {} }], req.signal).res;
    });
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'are you there';
    p.$('send').click();
    await until(() => !p.$('resend').hidden, 'the notch');
    assert.equal(p.key(), 'idle');
    assert.ok(p.$('dot').classList.contains('down'), 'the line dot goes red');
    fail = false;
    p.$('resend').click();
    await until(() => p.storage.has('goose.conv'), 'the resend to land');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1], bodies[0], 'the same words, sent again');
    assert.equal(p.$('resend').hidden, true);
    assert.equal(p.turns().length, 1, 'a resend before any answer reuses the same place on the glass');
    assert.ok(p.$('dot').classList.contains('up'));
  });

  await scenario('a 502 from tailscale serve is no line, not an error line', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    p.on('POST', '/api/turn', () => json(502, { error: 'bad gateway' }));
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'hello';
    p.$('send').click();
    await until(() => !p.$('resend').hidden, 'the notch');
    assert.equal(p.find('err').length, 0);
  });

  await scenario('a rail event opens the 988 sheet; the door shows a lock; a new talk clears it', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    p.on('POST', '/api/turn', req => ndjson([
      { type: 'conv', conv_id: 11 }, { type: 'route', route: 'crisis' }, { type: 'rail' },
      { type: 'sentence', i: 0, text: "I hear you, Bryan, and I'm right here." },
      { type: 'door', state: 'closed' },
      { type: 'done', episode_id: null, ms: {} },
    ], req.signal).res);
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'a hard night';
    p.$('send').click();
    await until(() => !p.$('sheetRail').hidden, 'the rail');
    await until(() => !p.$('lock').hidden, 'the lock');
    assert.equal(p.$('b988').getAttribute('aria-expanded'), 'true');
    assert.ok(p.find('divider').some(d => /door closed/.test(d.textContent)));
    p.$('newtalk').click();
    assert.equal(p.$('lock').hidden, true);
    assert.equal(p.storage.has('goose.conv'), false);
    assert.equal(p.turns().length, 0);
  });

  await scenario('a new talk id from the Mac (the old one went idle) keeps the door the Mac says, and says so', async () => {
    // Review 11-01: a closed door used to vanish when an idle talk ended. The
    // Mac now carries it into the new talk, and the glass says where it stands.
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    let n = 0;
    p.on('POST', '/api/turn', req => {
      n++;
      const evs = n === 1
        ? [{ type: 'conv', conv_id: 30, door: 'open' }, { type: 'door', state: 'closed' },
           { type: 'done', episode_id: 1, ms: {} }]
        : n === 2
          ? [{ type: 'conv', conv_id: 31, door: 'closed' }, { type: 'route', route: 'ask' },
             { type: 'door', state: 'closed' }, { type: 'done', episode_id: null, ms: {} }]
          : [{ type: 'conv', conv_id: 32, door: 'open' }, { type: 'done', episode_id: 2, ms: {} }];
      return ndjson(evs, req.signal).res;
    });
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'close the door';
    p.$('send').click();
    await until(() => !p.$('lock').hidden, 'the lock');
    p.skew += 1000;
    p.$('text').value = 'she still will not talk to me';
    p.$('send').click();
    await until(() => JSON.parse(p.storage.get('goose.conv')).id === 31, 'the new talk id');
    assert.equal(p.$('lock').hidden, false, 'the door stays closed into the new talk');
    assert.ok(p.find('divider').some(d => /a new talk/.test(d.textContent)));
    assert.ok(p.find('divider').some(d => /door still closed/.test(d.textContent)));
    p.skew += 1000;
    p.$('text').value = 'later on';
    p.$('send').click();
    await until(() => JSON.parse(p.storage.get('goose.conv')).id === 32, 'the next talk id');
    assert.equal(p.$('lock').hidden, true, 'an open talk from the Mac shows the door open');
    assert.ok(p.find('divider').some(d => /^door open$/.test(d.textContent)), 'and says so');
  });

  await scenario('a sentence the Mac cannot voice gets a tone, not silence', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG } });
    p.online();
    p.on('POST', '/api/turn', req => ndjson([
      { type: 'conv', conv_id: 4 }, { type: 'sentence', i: 0, text: 'Take the labor job.' },
      { type: 'done', episode_id: 1, ms: {} },
    ], req.signal).res);
    p.on('POST', '/api/say', () => json(503, { error: 'My voice failed on that sentence.' }));
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('key').click();                       // his tap starts the audio context, as on the phone
    await until(() => p.recorders.length === 1, 'the recorder');
    p.skew += 1000;
    p.$('key').click();                       // tap when done: the take goes as the turn
    const before = p.tones;                   // the take's own "over" tone is already counted
    await until(() => p.callsTo('/api/say').length === 1 && p.key() === 'idle', 'the say to fail');
    await until(() => p.tones >= before + 2, 'the miss tone');
    assert.match(p.turns().map(x => x.textContent).join(' '), /Take the labor job\./, 'its words stay on the glass');
  });

  await scenario("the sponsor's number lives in localStorage and a tel: link, and is in no request", async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG } });
    p.online();
    p.on('POST', '/api/turn', req => ndjson([
      { type: 'conv', conv_id: 2 }, { type: 'sentence', i: 0, text: 'Copy.' }, { type: 'done', episode_id: 1, ms: {} },
    ], req.signal).res);
    p.on('POST', '/api/say', () => new Response(new Blob(['z'.repeat(80)]), { status: 200 }));
    p.on('GET', '/api/lessons', () => json(200, { lessons: [] }));
    p.on('GET', '/api/card', () => json(200, { text: '', lines: [], numbers: [], sha: '', built_at: '' }));
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('b988').click();
    assert.equal(p.$('sponsorAdd').hidden, false);
    assert.equal(p.$('sponsorCall').hidden, true);
    p.$('sponsorIn').value = 'abc';
    p.$('sponsorSave').click();
    assert.equal(p.storage.has('goose.sponsor'), false, 'junk is refused');
    p.$('sponsorIn').value = '(555) 555-0142';
    p.$('sponsorSave').click();
    assert.equal(p.storage.get('goose.sponsor'), '5555550142');
    assert.equal(p.$('sponsorLink').getAttribute('href'), 'tel:5555550142');
    assert.equal(p.$('sponsorCall').hidden, false);
    assert.equal(p.$('sponsorAdd').hidden, true);
    p.$('gear').click();
    assert.equal(p.$('setSponsor').value, '5555550142');
    p.$('setSponsor').value = '+1 555 555 0142';
    p.$('setSponsorSave').click();
    assert.equal(p.storage.get('goose.sponsor'), '+15555550142');
    p.$('lessonsBtn').click();
    await tick(20);
    p.$('knowBtn').click();
    await tick(20);
    p.$('settingsClose').click();
    p.$('text').value = 'call him later';
    p.$('send').click();
    await until(() => p.storage.has('goose.conv'), 'the turn');
    p.skew += 1000;
    p.$('key').click();
    await until(() => p.recorders.length === 1, 'a voice take');
    p.skew += 1000;
    p.$('key').click();
    await until(() => p.callsTo('/api/turn').length === 2, 'the voice turn');
    await tick(30);
    for (const c of p.calls) {
      let body = c.body;
      if (body && typeof body === 'object' && typeof body.text === 'function') body = await body.text();
      const all = c.url + ' ' + JSON.stringify(c.headers) + ' ' + String(body || '');
      for (const needle of ['5555550142', '555-0142', '5550142', '0142']) {
        assert.ok(!all.includes(needle), 'the number reached a request: ' + c.method + ' ' + c.url);
      }
    }
    assert.ok(p.calls.length >= 6, 'the scan covered real traffic');
    p.$('gear').click();
    p.$('setSponsorDel').click();
    assert.equal(p.storage.has('goose.sponsor'), false);
    assert.equal(p.$('sponsorLink').getAttribute('href'), null);
  });

  await scenario('a breath of quiet ends a take; open field waits longer; nothing said sends nothing', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    let stanceRoute = 'open_field';
    p.on('POST', '/api/turn', req => ndjson([
      { type: 'conv', conv_id: 3 }, { type: 'route', route: stanceRoute }, { type: 'done', episode_id: 1, ms: {} },
    ], req.signal).res);
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    const vuWait = () => tick(70);                      // a little more than one 50 ms read of the level
    async function speakThenQuiet(quietMs) {
      p.$('key').click();
      await until(() => p.key() === 'listening' && p.$('key').classList.contains('live'), 'listening');
      p.level = 128;
      p.skew += 200;  await vuWait();                   // past the chirp
      await vuWait(); await vuWait();
      p.skew += 450;  await vuWait();                   // the room is measured
      p.level = 160;  await vuWait(); await vuWait();   // he talks
      p.level = 128;
      p.skew += quietMs; await vuWait(); await vuWait();
    }
    // 1. the default breath: 1.8 s of quiet sends the take
    await speakThenQuiet(1900);
    await until(() => p.callsTo('/api/turn').length === 1, 'the quiet to send it');
    await until(() => p.key() === 'idle', 'idle');
    // that turn's route was open_field: now 2 s of quiet is not enough...
    p.skew += 1000;
    await speakThenQuiet(2000);
    await tick(50);
    assert.equal(p.callsTo('/api/turn').length, 1, 'open field waits past 2 s');
    assert.equal(p.key(), 'listening');
    // ...and 3 s is
    p.skew += 1100; await vuWait(); await vuWait();
    await until(() => p.callsTo('/api/turn').length === 2, 'the longer breath');
    await until(() => p.key() === 'idle', 'idle again');
    // 2. nothing said for 9 s: the take closes and nothing is sent
    p.skew += 1000;
    p.$('key').click();
    await until(() => p.key() === 'listening', 'listening');
    p.level = 128;
    p.skew += 9500; await vuWait(); await vuWait();
    await until(() => p.key() === 'idle', 'the empty take to close');
    await tick(30);
    assert.equal(p.callsTo('/api/turn').length, 2);
  });

  await scenario('a second tap that is only a bump sends nothing; leaving the screen ends a take unsent and frees the mic', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG } });
    p.online();
    p.on('POST', '/api/turn', req => ndjson([{ type: 'done', episode_id: 1, ms: {} }], req.signal).res);
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('key').click();
    await until(() => p.recorders.length === 1, 'the recorder');
    p.skew += 500;                                       // past the tap guard, short of a real take
    p.$('key').click();
    await until(() => p.key() === 'idle', 'the bump to call it off');
    await tick(30);
    assert.equal(p.callsTo('/api/turn').length, 0);
    p.skew += 1000;
    p.$('key').click();
    await until(() => p.recorders.length === 2 && p.key() === 'listening', 'listening again');
    p.hide();
    await tick(30);
    assert.equal(p.key(), 'idle');
    assert.ok(p.tracksStopped >= 1, 'the mic was let go');
    assert.equal(p.callsTo('/api/turn').length, 0, 'nothing heard behind a call is sent');
  });

  await scenario('a refused key goes back to the connect screen, saying why', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG } });
    p.on('GET', '/api/health', () => json(401, { error: 'no key' }));
    p.on('POST', '/api/warm', () => json(401, { error: 'no key' }));
    p.on('GET', '/api/thread', () => json(401, { error: 'no key' }));
    p.boot();
    await until(() => !p.$('connect').hidden, 'the connect screen');
    assert.match(p.$('connectWhy').textContent, /refused/);
    assert.ok(p.storage.has('goose.cfg'), 'the key is kept: it comes back if the Mac takes it again');
  });

  await scenario('LESSONS: KEEP and DROP on a proposed rule, RETIRE on a live one, retired struck through', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG } });
    p.online();
    const lessons = [
      { id: 3, at: '2026-11-01T10:20:00-05:00', lane: 'rule', statement: "Don't answer with a question.",
        his_words: "don't answer me with a question", status: 'proposed' },
      { id: 2, at: '2026-11-01T10:10:00-05:00', lane: 'fact', statement: 'The axle ships Thursday.',
        his_words: 'no, the axle ships Thursday', status: 'live' },
      { id: 1, at: '2026-10-31T09:00:00-05:00', lane: 'voice', statement: 'Say it plainer.',
        his_words: 'too wordy', status: 'retired' },
    ];
    const posts = [];
    p.on('GET', '/api/lessons', () => json(200, { lessons }));
    p.on('POST', '/api/lessons/', req => { posts.push(new URL(req.url).pathname); return json(200, { ok: true }); });
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('lessonsBtn').click();
    await until(() => p.$('lessonList').children.length === 3, 'three lessons');
    const rows = p.$('lessonList').children;
    const buttons = r => { const b = []; walk(r, n => { if (n.tagName === 'BUTTON') b.push(n); }); return b; };
    assert.deepEqual(buttons(rows[0]).map(b => b.textContent), ['KEEP', 'DROP']);
    assert.deepEqual(buttons(rows[1]).map(b => b.textContent), ['RETIRE']);
    assert.deepEqual(buttons(rows[2]).map(b => b.textContent), []);
    assert.ok(rows[2].classList.contains('gone'));
    assert.match(rows[0].textContent, /11-01/);
    assert.match(rows[0].textContent, /you said: “don't answer me with a question”/);
    buttons(rows[0])[0].click();
    await until(() => posts.length === 1, 'the keep');
    assert.equal(posts[0], '/api/lessons/3/keep');
    buttons(p.$('lessonList').children[1])[0].click();
    await until(() => posts.length === 2, 'the retire');
    assert.equal(posts[1], '/api/lessons/2/retire');
  });

  await scenario('WHAT I KNOW: the card by section, each line with its source and age', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG } });
    p.online();
    p.on('GET', '/api/card', () => json(200, {
      text: 'x', numbers: [], sha: 'abc', built_at: '2026-11-01T10:05:00-05:00',
      lines: [
        { section: 'NOW', text: 'Today is Sunday, November 1, 2026, 10:05 am.', source: '', age: '' },
        { section: 'THE RIG', text: 'The trailer lost a wheel on 10-30.', source: 'book 10-31, unconfirmed', age: 'yesterday' },
        { section: 'THE RIG', text: 'You added a lug-nut torque check.', source: 'book 10-31, unconfirmed', age: 'yesterday' },
      ],
    }));
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('knowBtn').click();
    await until(() => p.$('knowList').children.length >= 2, 'the card');
    const secs = p.$('knowList').children.filter(n => n.classList.contains('know-sec'));
    assert.equal(secs.length, 2);
    assert.match(secs[1].textContent, /THE RIG/);
    assert.match(secs[1].textContent, /book 10-31, unconfirmed · yesterday/);
    assert.match(p.$('knowList').textContent, /Read fresh at 10:05 am\./);
  });

  await scenario('a reload brings a warm talk back from the Mac; a cold one keeps its number but is not fetched; junk is let go', async () => {
    const warmAt = Date.now() - 5 * 60000;
    const warmConv = JSON.stringify({ id: 21, at: warmAt });
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.conv': warmConv } });
    p.online();
    p.on('GET', '/api/thread', () => json(200, { conv_id: 21, door: 'closed', turns: [
      { speaker: 'bryan', text: 'the trailer is down', at: '2026-11-01T10:00:00-05:00', via: 'voice' },
      { speaker: 'goose', text: 'Take the labor job.', at: '2026-11-01T10:00:05-05:00', via: 'type' },
      { speaker: 'bryan', text: 'and the move', at: '2026-11-01T10:01:00-05:00', via: 'type' },
    ] }));
    p.boot();
    await until(() => p.turns().length === 2, 'the thread');
    assert.match(p.turns()[0].textContent, /the trailer is down/);
    assert.equal(p.find('heard').length, 1, 'his voice line comes back marked heard:, his typed one plain');
    assert.equal(p.$('lock').hidden, false);
    assert.equal(p.callsTo('/api/thread')[0].url, API + '/api/thread?conv_id=21');
    const after = JSON.parse(p.storage.get('goose.conv'));
    assert.equal(after.door, 'closed', "the Mac's door is kept with the talk number");
    assert.equal(after.at, warmAt, 'a reload never renews the stamp: only a turn does');
    // Review 11-01 (public 1): a cold talk used to be dropped here, so the next
    // turn named no talk and a door he had closed came back open.
    const coldConv = JSON.stringify({ id: 22, at: Date.now() - 45 * 60000 });
    const q = makePage({ storage: { 'goose.cfg': CFG, 'goose.conv': coldConv } });
    q.online();
    q.boot();
    await tick(30);
    assert.equal(q.callsTo('/api/thread').length, 0, 'a cold talk is not fetched back');
    assert.equal(q.storage.get('goose.conv'), coldConv, 'its number is kept as it was');
    for (const junk of ['not json', 'null', '[]', '{"id":0,"at":1}', '{"id":"7","at":1}', '{"id":2.5}']) {
      const j = makePage({ storage: { 'goose.cfg': CFG, 'goose.conv': junk } });
      j.online();
      j.boot();
      await tick(20);
      assert.equal(j.callsTo('/api/thread').length, 0, 'no thread for ' + junk);
      assert.equal(j.storage.has('goose.conv'), false, 'junk is let go: ' + junk);
    }
  });

  await scenario('a reload shows a closed door at once, before the Mac answers; the Mac\'s word wins and a change is said', async () => {
    // Review 11-01 (public 3): with no line at boot, a talk behind the door
    // came back with no lock, because only the thread fetch could set it.
    const at = Date.now() - 5 * 60000;
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.conv': JSON.stringify({ id: 23, at, door: 'closed' }) } });
    p.online();
    let release;
    const answered = new Promise(r => { release = r; });
    p.on('GET', '/api/thread', async () => {
      await answered;
      return json(200, { conv_id: 23, door: 'open', turns: [
        { speaker: 'bryan', text: 'open the door', at: '2026-11-01T10:00:00-05:00', via: 'type' },
        { speaker: 'goose', text: "Door's open.", at: '2026-11-01T10:00:02-05:00', via: 'type' },
      ] });
    });
    p.boot();
    await until(() => p.callsTo('/api/thread').length === 1, 'the thread asked for');
    assert.equal(p.$('lock').hidden, false, 'the stored door shows before the Mac answers, line or no line');
    release();
    await until(() => p.turns().length === 1, 'the thread');
    assert.equal(p.$('lock').hidden, true, "the Mac's door wins");
    const kids = p.$('thread').children;
    assert.equal(kids[kids.length - 1].textContent, 'door open', 'the change is said under the talk');
    assert.equal(JSON.parse(p.storage.get('goose.conv')).door, 'open');
    // fail closed: a thread answer with no door in it never takes the lock down
    const q = makePage({ storage: { 'goose.cfg': CFG, 'goose.conv': JSON.stringify({ id: 24, at, door: 'closed' }) } });
    q.online();
    q.on('GET', '/api/thread', () => json(200, { conv_id: 24, turns: [
      { speaker: 'goose', text: 'Right here.', at: '2026-11-01T10:00:02-05:00', via: 'type' },
    ] }));
    q.boot();
    await until(() => q.turns().length === 1, 'the thread');
    assert.equal(q.$('lock').hidden, false, 'no door in the answer: the lock stays');
    assert.equal(q.find('divider').length, 0);
  });

  await scenario('a reload 31 minutes after the rail closed the door keeps the talk and its door: the lock at once, no thread fetch, the next turn names the talk', async () => {
    // Review 11-01 (safety 11): a reload past IDLE_MIN dropped the talk's
    // number, so the Mac opened the next talk with the door open, and the glass
    // said nothing. The page now keeps the number and the door, and the Mac
    // carries a closed door into the new talk when the turn names the old one.
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    p.on('POST', '/api/turn', req => ndjson([
      { type: 'rail' }, { type: 'sentence', i: 0, text: "I'm right here." },
      { type: 'conv', conv_id: 41, door: 'open' }, { type: 'route', route: 'crisis' },
      { type: 'door', state: 'closed' }, { type: 'done', episode_id: null, ms: {} },
    ], req.signal).res);
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'a hard night';
    p.$('send').click();
    await until(() => !p.$('lock').hidden && p.key() === 'idle', 'the rail turn');
    const kept = JSON.parse(p.storage.get('goose.conv'));
    assert.equal(kept.id, 41);
    assert.equal(kept.door, 'closed', 'the door is kept with the talk number');
    // the reload, 31 minutes on: the same phone storage, the talk now cold on the Mac
    kept.at = Date.now() - 31 * 60000;
    const stored = JSON.stringify(kept);
    const q = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0', 'goose.conv': stored } });
    q.online();
    q.on('GET', '/api/thread', () => json(200, { conv_id: 41, door: 'closed', turns: [] }));
    const turns = [];
    q.on('POST', '/api/turn', req => {
      turns.push(req);
      // what the Mac answers when the turn names the idle talk it closed: a new talk, behind the door
      return ndjson([
        { type: 'heard', text: 'I keep thinking I let my kids down', ms: 0 },
        { type: 'conv', conv_id: 42, door: 'closed' }, { type: 'route', route: 'ask' },
        { type: 'door', state: 'closed' },
        { type: 'sentence', i: 0, text: 'Tell me more.' }, { type: 'done', episode_id: null, ms: {} },
      ], req.signal).res;
    });
    q.boot();
    await until(() => !q.$('talk').hidden, 'the talk screen');
    await tick(30);
    assert.equal(q.callsTo('/api/thread').length, 0, 'a cold talk is not fetched back');
    assert.equal(q.storage.get('goose.conv'), stored, 'its number, stamp and door are kept as they were');
    assert.equal(q.$('lock').hidden, false, 'the lock shows from the first moment');
    q.$('text').value = 'I keep thinking I let my kids down';
    q.$('send').click();
    await until(() => turns.length === 1 && q.key() === 'idle', 'the turn');
    assert.deepEqual(JSON.parse(turns[0].body), { text: 'I keep thinking I let my kids down', conv_id: 41 });
    assert.equal(q.$('lock').hidden, false, 'the door stays closed into the new talk');
    assert.deepEqual(q.find('divider').map(d => d.textContent),
                     ['a new talk', 'door still closed · this stays on the Mac']);
    const now = JSON.parse(q.storage.get('goose.conv'));
    assert.equal(now.id, 42);
    assert.equal(now.door, 'closed');
  });

  await scenario('a reload 45 minutes on, from the {id, at} a phone holds today: the next take still names the talk, and the door the Mac carries is said', async () => {
    // Review 11-01 (public 1): the record the page wrote before this fix has
    // no door in it. The take must still name the talk, so the Mac can carry it.
    const cold = JSON.stringify({ id: 30, at: Date.now() - 45 * 60000 });
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.conv': cold, 'goose.voice': '0' } });
    p.online();
    p.on('GET', '/api/thread', () => json(200, { conv_id: 30, door: 'closed', turns: [] }));
    let turn = null;
    p.on('POST', '/api/turn', req => {
      turn = req;
      return ndjson([
        { type: 'heard', text: 'still on what we were talking about', ms: 300 },
        { type: 'conv', conv_id: 31, door: 'closed' }, { type: 'route', route: 'ask' },
        { type: 'door', state: 'closed' },
        { type: 'sentence', i: 0, text: 'Go on.' }, { type: 'done', episode_id: null, ms: {} },
      ], req.signal).res;
    });
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    await tick(30);
    assert.equal(p.callsTo('/api/thread').length, 0, 'a cold talk is not fetched back');
    assert.equal(p.storage.get('goose.conv'), cold, 'its number is kept as it was');
    assert.equal(p.$('lock').hidden, true, 'no door was stored, so none is claimed');
    p.$('key').click();
    await until(() => p.recorders.length === 1, 'the recorder');
    p.skew += 1000;
    p.$('key').click();                                  // tap when done
    await until(() => turn, 'the voice turn');
    assert.equal(turn.headers['X-Goose-Conv'], '30', 'the take names the cold talk');
    await until(() => p.key() === 'idle' && p.find('heard').length === 1, 'the answer');
    assert.equal(p.$('lock').hidden, false, 'the Mac carried the closed door: the lock shows');
    assert.deepEqual(p.find('divider').map(d => d.textContent),
                     ['a new talk', 'door closed · this stays on the Mac']);
    assert.equal(JSON.parse(p.storage.get('goose.conv')).door, 'closed');
  });

  await scenario('the door rides on every conv event: a talk restored with no line shows the lock once the Mac says closed', async () => {
    // Review 11-01 (public 3): setConv read the conv event's door only when the
    // talk id changed. A talk already behind the door gets no door event.
    const warm = JSON.stringify({ id: 21, at: Date.now() - 5 * 60000 });
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.conv': warm, 'goose.voice': '0' } });
    let line = false;
    p.on('GET', '/api/health', () => (line ? json(200, HEALTH) : new TypeError('Failed to fetch')));
    p.on('POST', '/api/warm', () => (line ? json(200, { ok: true }) : new TypeError('Failed to fetch')));
    p.on('GET', '/api/thread', () => (line ? json(200, { conv_id: 21, door: 'closed', turns: [] })
                                           : new TypeError('Failed to fetch')));
    const turns = [];
    p.on('POST', '/api/turn', req => {
      turns.push(req);
      return ndjson([
        { type: 'heard', text: 'ok, where were we', ms: 0 },
        { type: 'conv', conv_id: 21, door: 'closed' }, { type: 'route', route: 'ask' },
        { type: 'sentence', i: 0, text: 'Right here.' }, { type: 'done', episode_id: null, ms: {} },
      ], req.signal).res;
    });
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    await until(() => p.callsTo('/api/thread').length === 1, 'the thread asked for');
    await tick(30);
    assert.equal(p.$('lock').hidden, true, 'no line and no door stored: nothing to claim yet');
    line = true;                                         // the line comes back
    p.$('text').value = 'ok, where were we';
    p.$('send').click();
    await until(() => turns.length === 1 && p.key() === 'idle', 'the turn');
    assert.deepEqual(JSON.parse(turns[0].body), { text: 'ok, where were we', conv_id: 21 });
    assert.equal(p.$('lock').hidden, false, 'the Mac said closed: the lock shows');
    assert.deepEqual(p.find('divider').map(d => d.textContent), ['door closed · this stays on the Mac']);
    assert.equal(JSON.parse(p.storage.get('goose.conv')).door, 'closed');
  });

  await scenario('a conv event that says the door is open takes the lock down in the same talk, and says so', async () => {
    // Review 11-01 (public 3; the page half of safety 14): the glass kept a lock
    // the Mac was not holding, so his next words looked walled and were not.
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    const streams = [
      [{ type: 'rail' }, { type: 'sentence', i: 0, text: "I'm right here." },
       { type: 'conv', conv_id: 1, door: 'open' }, { type: 'route', route: 'crisis' },
       { type: 'door', state: 'closed' }, { type: 'done', episode_id: null, ms: {} }],
      [{ type: 'heard', text: "I'm still not okay.", ms: 0 }, { type: 'conv', conv_id: 1, door: 'open' },
       { type: 'route', route: 'ask' }, { type: 'sentence', i: 0, text: 'Take the labor job.' },
       { type: 'done', episode_id: 4, ms: {} }],
    ];
    let n = 0;
    p.on('POST', '/api/turn', req => ndjson(streams[n++], req.signal).res);
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'a hard night';
    p.$('send').click();
    await until(() => n === 1 && p.key() === 'idle', 'turn 1');
    assert.equal(p.$('lock').hidden, false);
    p.skew += 1000;
    p.$('text').value = "I'm still not okay.";
    p.$('send').click();
    await until(() => n === 2 && p.key() === 'idle', 'turn 2');
    assert.equal(p.$('lock').hidden, true, 'the Mac holds the door open: the glass must not claim it closed');
    assert.deepEqual(p.find('divider').map(d => d.textContent),
                     ['door closed · this stays on the Mac', 'door open']);
    assert.equal(JSON.parse(p.storage.get('goose.conv')).door, 'open');
  });

  await scenario('a line that drops after the door closed still keeps the closed door for the next reload', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    p.on('POST', '/api/turn', req => {
      const s = ndjson([{ type: 'conv', conv_id: 8, door: 'open' }, { type: 'route', route: 'door_close' },
                        { type: 'door', state: 'closed' }], req.signal, true);
      setTimeout(() => { try { s.end(); } catch (e) {} }, 30);   // the line drops: no done
      return s.res;
    });
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'close the door';
    p.$('send').click();
    await until(() => !p.$('resend').hidden, 'the notch');
    const kept = JSON.parse(p.storage.get('goose.conv'));
    assert.equal(kept.id, 8);
    assert.equal(kept.door, 'closed', 'the door was kept the moment it closed, not only at done');
  });

  await scenario('re-connect lets go of the talk and takes the lock down: the next talk will not be behind it', async () => {
    const p = makePage({ storage: { 'goose.cfg': CFG, 'goose.voice': '0' } });
    p.online();
    p.on('POST', '/api/turn', req => ndjson([
      { type: 'conv', conv_id: 12, door: 'open' }, { type: 'route', route: 'door_close' },
      { type: 'door', state: 'closed' }, { type: 'done', episode_id: null, ms: {} },
    ], req.signal).res);
    p.boot();
    await until(() => !p.$('talk').hidden, 'the talk screen');
    p.$('text').value = 'close the door';
    p.$('send').click();
    await until(() => !p.$('lock').hidden && p.key() === 'idle', 'the lock');
    p.$('gear').click();
    p.$('reconnect').click();
    assert.equal(p.$('connect').hidden, false);
    assert.equal(p.storage.has('goose.conv'), false);
    assert.equal(p.$('lock').hidden, true, 'no lock left on the bar for a talk this phone let go');
  });

  let failed = 0;
  for (const [state, name, why] of results) {
    console.log((state === 'ok' ? 'ok    ' : 'FAIL  ') + name);
    if (why) { failed++; console.log('      ' + why.replace(/\n/g, '\n      ')); }
  }
  console.log(failed ? `SMOKE FAILED: ${failed} of ${results.length}` : `SMOKE OK: ${results.length} scenarios`);
  process.exit(failed ? 1 : 0);
}

// A throw inside app.js's own timers or promises (an innerHTML in a restore,
// say) escapes every scenario: it still fails the run, by name, never quietly.
const crashed = e => { console.log('SMOKE CRASHED: ' + (e && e.stack || e)); process.exit(1); };
process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);
main().catch(crashed);
