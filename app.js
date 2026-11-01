/* Goose — the phone page (card #464). One big lit key in a dark cab.

   WHAT IT IS FOR
   Bryan talks a situation through with Goose, by voice or by typing. A tap
   opens the mic; a second tap, or a breath of quiet, ends the take. Goose's
   answer streams back sentence by sentence: shown warm on the glass, and
   spoken one at a time while the next ones are still being written. A tap
   while Goose talks cuts it off and opens the mic, because the cab needs a
   panic tap. The 988 rail is one tap away on every screen.

   WHAT IT NEVER DOES
   - It never puts a string from the Mac in as markup. Every word reaches the
     glass through textContent. This origin's storage holds the device key,
     and one model sentence running as script would carry it off.
   - It never sends the sponsor's number anywhere. That number is read and
     written only in this phone's localStorage and used only as a tel: link
     (see THE SPONSOR'S NUMBER below: nothing in that section touches the
     network, and nothing outside it reads the number).
   - It never keeps what was said. The talk lives in page memory and on the
     Mac. Only the talk's id and where its door stands are stored here, so a
     reload can ask the Mac for the thread, and a door he closed is still
     closed after a reload, however long the talk sat quiet.
   - It never leaves the mic open behind a call or another app (ear.html's
     visibility guard): the page leaving the screen ends the take unsent and
     lets go of the mic.
   - It never honors a connect link that points anywhere but this Mac's Goose
     on port 8650, and it stores a key only after /api/health answers 200 to
     that key.

   The contract it speaks is docs/SPEC.md: the CORE server routes and the
   turn events (heard, conv, route, door, rail, lesson, sentence, done,
   error). */
(function () {
'use strict';

/* ── 0. THE SCRUB ──────────────────────────────────────────────────────────
   A connect link carries a one-time code in the fragment. It is read and
   wiped from the address bar and history FIRST, before this page makes any
   request, so the code never sits in history, a bookmark or a screenshot. */
const LINK = takeLink();

/* ── settings ──────────────────────────────────────────────────────────── */
const K_CFG = 'goose.cfg';          // {api, key}: set only by a connect link, after a 200
const K_SPONSOR = 'goose.sponsor';  // his sponsor's number: this phone only, never sent
const K_VOICE = 'goose.voice';      // '0' means Goose answers in text only
const K_CONV = 'goose.conv';        // {id, at, door}: the talk's number and its door, never its words

const PREVIEW = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
const IDLE_MIN = 30;                // config.IDLE_MINUTES on the Mac: a talk quiet this long is over,
                                    // so a reload no longer asks for its thread (its number and door stay)
const HEALTH_MS = 30000;            // the line dot, every 30 s while the page is on screen
const WARM_GAP_MS = 60000;          // /api/warm at most once a minute; the Mac skips a warm already running
const CALL_MS = 12000;              // a plain call answers in this, or it counts as no line
const TURN_START_MS = 20000;        // a turn's answer must start this soon...
const TURN_QUIET_MS = 60000;        // ...and never go quiet longer than this mid-answer (a cold 12B load fits)
const SAY_MS = 20000;               // mouth.py gives each sentence 20 s
const PREFETCH = 2;                 // sentences fetched ahead of the one playing
const SILENCE_MS = 1800;            // his breath of quiet ends a take (companion.html's #256 cadence)
const SILENCE_OPEN_MS = 3000;       // thinking out loud ("open field") gets a longer breath
const NOTHING_MS = 9000;            // a take with no voice in it closes unsent (companion.html's rule)
const TAKE_CAP_MS = 90000;          // no take runs past 90 s
const MIN_TAKE_MS = 700;            // a second tap sooner than this was a bump, not a take: nothing is sent
const TAP_GUARD_MS = 450;           // one tap per bump in the road
const EARCON_MS = 170;              // the mic-live chirp; the room is measured only after it
// ear.html's TALK floor (card #426): the first moments after the chirp measure
// the room, and his voice is what rises above it. Echo cancellation cannot
// remove a podcast on the other phone through the truck speakers, so a fixed
// level would never hear his pause.
const FLOOR_MS = 400, FLOOR_MIN = 0.028, FLOOR_RISE = 1.8;
// The SPEC opens the mic once and keeps the stream, so the next tap is live at
// once. If the rig test shows a kept mic holding truck Bluetooth in call mode,
// set this false: the mic then closes after every take (each tap costs about
// 150 to 300 ms more).
const KEEP_MIC = true;
// A Bluetooth page-turner on the wheel types one of these (the plan's KEY).
const TURNER_KEYS = new Set(['PageDown', 'PageUp', 'ArrowRight', 'ArrowLeft']);

const KEY_WORDS = {            // [small state word, the big action line, what a screen reader hears]
  idle: ['', 'TAP TO TALK', 'Tap to talk'],
  listening: ['LISTENING', 'TAP WHEN DONE', 'Listening. Tap when you are done.'],
  thinking: ['THINKING', 'TAP TO CUT IN', 'Goose is thinking. Tap to cut in and talk.'],
  speaking: ['GOOSE', 'TAP TO CUT IN', 'Goose is talking. Tap to cut in and talk.'],
};
const TAG_WORD = { proposed: 'keep it?', live: 'learned', dropped: 'dropped', retired: 'scratched' };
const STATUS_WORD = { proposed: 'waiting on you', live: 'live', dropped: 'dropped', retired: 'retired' };
const LANES = ['fact', 'rule', 'voice', 'ear'];

/* ── small helpers ─────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const store = {   // storage that never throws: a blocked store must not take the page down
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}
let toastT = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 3600);
}
function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }
const pad = n => String(n).padStart(2, '0');
function when(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t) : null; }
function mmdd(iso) { const d = when(iso); return d ? pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : ''; }
function clock(iso) {
  const d = when(iso);
  if (!d) return '';
  const h = d.getHours();
  return (h % 12 || 12) + ':' + pad(d.getMinutes()) + (h < 12 ? ' am' : ' pm');
}
const secs = ms => (Math.max(0, ms) / 1000).toFixed(1) + ' s';
function hostOf(api) { try { return new URL(api).host; } catch (e) { return ''; } }
const str = v => (typeof v === 'string' ? v : '');

/* ══ THE CONNECTION ══════════════════════════════════════════════════════
   The only Goose a link may name: this Mac on the tailnet (https, a .ts.net
   name, port 8650) or this Mac's loopback on 8650 for the preview. The port
   is part of the check: Tailscale Funnel serves only 443, 8443 and 10000, so
   a stranger's public ts.net host can never pass. Copied in shape from
   bik-dispatch's apiShape (~/Almanac/apps/bik-dispatch/app.js). */
function apiShape(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
  const loop = u.protocol === 'http:' && u.port === '8650'
    && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  const tail = u.protocol === 'https:' && u.port === '8650'
    && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(u.hostname);
  return loop || tail ? u.origin : null;
}

/* The link is #cfg= + base64url of JSON {"api", "code"} (bin/goose-connect). */
function takeLink() {
  const m = (location.hash || '').match(/^#(?:.*&)?cfg=([^&]*)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    let s = m[1];
    try { s = decodeURIComponent(s); } catch (e) {}
    s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const c = JSON.parse(new TextDecoder().decode(bytes));
    return c && typeof c === 'object' ? c : {};
  } catch (e) { return {}; }
}

// lineAt: when the request that last set the line state STARTED. A health
// check sent before a turn failed can land after it, and must not paint the
// dot green over the newer "no line".
const C = { api: '', key: '', line: 'unknown', lineAt: -Infinity, health: null, refused: false };

function loadCfg() {
  try {
    const c = JSON.parse(store.get(K_CFG) || 'null');
    const api = c ? apiShape(c.api) : null;
    if (api && typeof c.key === 'string' && c.key) { C.api = api; C.key = c.key; return true; }
  } catch (e) {}
  C.api = ''; C.key = '';
  return false;
}
function saveCfg(api, key) {
  store.set(K_CFG, JSON.stringify({ api, key }));
  C.api = api; C.key = key; C.refused = false;
}

/* Every call: the bearer (its own api's key only, never another's), no HTTP
   cache, no cookies, and a ceiling, so a dead zone answers in words instead
   of a spinner that never ends. A network failure comes back as status 0. */
async function call(method, path, o) {
  o = o || {};
  const api = o.api || C.api;
  if (!api) return { status: 0, data: null };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeout || CALL_MS);
  const stop = () => ac.abort();
  if (o.signal) {
    if (o.signal.aborted) ac.abort();
    else o.signal.addEventListener('abort', stop);
  }
  const headers = {};
  const key = o.key !== undefined ? o.key : C.key;
  if (key) headers.Authorization = 'Bearer ' + key;
  let body;
  if (o.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(o.json);
  }
  try {
    let r;
    try {
      r = await fetch(api + path, { method, headers, body, signal: ac.signal,
                                    cache: 'no-store', credentials: 'omit' });
    } catch (e) { return { status: 0, data: null }; }
    let data = null;
    if (o.as === 'blob') {
      if (r.ok) {
        try { data = await r.blob(); } catch (e) { return { status: 0, data: null }; }
      }
    } else {
      try { data = await r.json(); } catch (e) {}
    }
    return { status: r.status, data };
  } finally {
    clearTimeout(timer);
    if (o.signal) o.signal.removeEventListener('abort', stop);
  }
}

/* A connect link: POST /api/connect {code, device} on the address it names,
   then /api/health with the new key. Only a 200 from Goose itself stores the
   pair. The stored key is never sent to the new address: only the code is. */
async function adopt(c) {
  const api = apiShape(c && c.api);
  const code = str(c && c.code).trim();
  if (!api) return linkRefused("it doesn't point at this Mac's Goose");
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(code)) return linkRefused('it carried no code');
  if (!C.key || C.refused) showConnect('Checking the link with the Mac…');
  const r = await call('POST', '/api/connect',
                       { api, key: '', json: { code, device: PREVIEW ? 'preview' : 'phone' } });
  if (r.status !== 200 || !r.data || typeof r.data.key !== 'string' || !r.data.key) {
    return linkRefused(r.status === 0 ? "the Mac didn't answer"
      : r.status === 403 ? 'that code was used already or ran out'
      : 'the Mac answered ' + r.status);
  }
  const key = r.data.key;
  const checkedAt = performance.now();
  const h = await call('GET', '/api/health', { api, key });
  if (h.status !== 200 || !h.data || h.data.name !== 'goose') {
    return linkRefused(h.status === 0 ? "the Mac didn't answer the check" : "the new key didn't check out");
  }
  const moved = C.api && C.api !== api;
  saveCfg(api, key);
  if (moved) newTalk();             // a different Mac: the old talk's number means nothing there
  C.health = h.data;
  setLine('up', checkedAt);
  showTalk();
  toast('Connected.');
  warm(true);
}
function linkRefused(why) {
  const text = "That connect link didn't work: " + why + '. Nothing was stored.';
  if (C.key && !C.refused) toast(text);
  else showConnect(text);
}
function keyRefused() {
  if (C.refused) return;
  C.refused = true;
  C.line = 'refused';
  quiet();
  paintDot();
  showConnect("This phone's key was refused. Make a new connect link on the Mac.");
}

/* ── the two screens; the top bar rides over both ─────────────────────── */
function showConnect(why) {
  $('connect').hidden = false;
  $('talk').hidden = true;
  $('connectWhy').textContent = why || '';
  paintDot();
}
function showTalk() {
  $('connect').hidden = true;
  $('talk').hidden = false;
  paintDot();
}

/* ── the line ──────────────────────────────────────────────────────────── */
function paintDot() {
  const d = $('dot');
  const on = C.key && !$('talk').hidden;
  const state = !on ? 'none' : C.line === 'up' ? 'up' : C.line === 'down' ? 'down' : 'wait';
  d.className = 'dot' + (state === 'wait' ? '' : ' ' + state);
  d.setAttribute('aria-label', state === 'up' ? 'On the line' : state === 'down' ? 'No line'
                 : state === 'none' ? 'Not connected' : 'Checking the line');
}
function setLine(state, at) {
  if (at < C.lineAt) return;         // an older answer arriving late never overrides a newer one
  C.lineAt = at;
  C.line = state;
  paintDot();
}
async function checkLine() {
  if (!C.key) return;
  const at = performance.now();
  const r = await call('GET', '/api/health', { timeout: 8000 });
  if (r.status === 200 && r.data && r.data.name === 'goose') {
    C.health = r.data;
    if (C.refused) { C.refused = false; showTalk(); }
    setLine('up', at);
  } else if (r.status === 401) keyRefused();
  else setLine('down', at);
}
let warmAt = 0;
function warm(force) {
  if (!C.key || C.refused) return;
  const now = Date.now();
  if (!force && now - warmAt < WARM_GAP_MS) return;
  warmAt = now;
  call('POST', '/api/warm', { json: {} }).then(r => { if (r.status === 401) keyRefused(); });
}

/* ══ THE THREAD ══════════════════════════════════════════════════════════
   Goose's sentences warm, his lines muted ("heard:" when the ear wrote them).
   It follows the newest line, unless he has scrolled up to read. */
const thread = $('thread');
const EMPTY = $('empty');
function stick(fn) {
  const pinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
  fn();
  if (pinned) thread.scrollTop = thread.scrollHeight;
}
// The hint leaves the DOM (not just the view) once the talk starts, so the
// first real line is the thread's first child and a short talk sits low, by the key.
function unEmpty() { if (EMPTY.parentNode) EMPTY.remove(); }
function turnView() {
  unEmpty();
  const t = el('div', 'turn');
  const you = el('p', 'you');
  const goose = el('p', 'goose');
  const tags = el('div', 'tags');
  you.hidden = true; goose.hidden = true; tags.hidden = true;
  t.append(you, goose, tags);
  stick(() => thread.appendChild(t));
  return { t, you, goose, tags, n: 0 };
}
function setYou(v, text, via) {
  const kids = via === 'voice' ? [el('span', 'heard', 'heard:'), el('span', 'yt', text)]
                               : [el('span', 'yt', text)];
  stick(() => { v.you.replaceChildren(...kids); v.you.hidden = false; });
}
function addSentence(v, text) {
  const s = el('span', 's', text);
  stick(() => { v.goose.appendChild(s); v.goose.hidden = false; });
  v.n++;
  return s;
}
function errLine(v, text) {
  const p = el('p', 'err', text);
  stick(() => v.t.appendChild(p));
  return p;
}
function lessonTag(v, ev) {
  const lane = LANES.includes(ev.lane) ? ev.lane : 'lesson';
  const word = TAG_WORD[ev.status] || str(ev.status);
  const tag = el('span', 'tag', word ? lane + ' — ' + word : lane);
  if (str(ev.statement)) tag.title = ev.statement;
  stick(() => { v.tags.appendChild(tag); v.tags.hidden = false; });
}
function divider(text, before) {
  const d = el('div', 'divider', text);
  d.setAttribute('role', 'separator');
  unEmpty();
  stick(() => {
    if (before && before.parentNode === thread) thread.insertBefore(d, before);
    else thread.appendChild(d);
  });
}
function clearThread() {
  thread.replaceChildren(EMPTY);
  EMPTY.hidden = false;
  T.view = null;
}
/* A reload (or Android killing the tab, or the worker's own idle reload)
   brings the talk back. The words were never stored on this phone: while the
   talk is warm they come back from the Mac. Past IDLE_MIN they stay there, but
   the talk's number and its door stay here, however long it sat quiet. The
   next turn still names it, so the Mac carries a door he closed into the new
   talk (the door is his to open, never the clock's), and the lock shows from
   the first moment, line or no line. Only NEW TALK or re-connect lets go. */
async function restoreThread() {
  let c = null;
  try { c = JSON.parse(store.get(K_CONV) || 'null'); } catch (e) {}
  if (!c || typeof c !== 'object' || !Number.isInteger(c.id) || c.id <= 0) {
    store.del(K_CONV);
    return;
  }
  T.conv = c.id;
  const at = Number(c.at);
  T.convAt = Number.isFinite(at) && at > 0 ? at : 0;   // an unknown stamp reads as cold, and is never renewed here
  if (c.door === 'closed') setDoor('closed', false);
  if (!(Date.now() - T.convAt < IDLE_MIN * 60000)) return;   // cold: the Mac starts a new talk on the next turn
  const r = await call('GET', '/api/thread?conv_id=' + c.id);
  if (r.status === 401) return keyRefused();
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.turns)) return;
  if (T.view || T.conv !== c.id) return;          // he has already started talking: leave the glass alone
  let v = null;
  for (const t of r.data.turns) {
    const text = str(t && t.text).trim();
    if (!text) continue;
    // the Mac says how each of his lines came in, so a voice line is "heard:" again
    if (t.speaker === 'bryan') { v = turnView(); setYou(v, text, t.via === 'voice' ? 'voice' : 'type'); }
    else if (t.speaker === 'goose') { if (!v) v = turnView(); addSentence(v, text); }
  }
  // The Mac's word on the door wins. If it differs from what this phone last
  // knew, the glass says so under the talk instead of the lock just changing.
  // An answer with no door in it never takes a lock down (as in setConv).
  const d = r.data.door;
  setDoor(d === 'closed' ? 'closed' : d === 'open' ? 'open' : T.door, true);
  thread.scrollTop = thread.scrollHeight;
}

/* ══ THE KEY ═════════════════════════════════════════════════════════════
   idle: TAP TO TALK · listening: TAP WHEN DONE · thinking: a turning ring ·
   speaking: TAP TO CUT IN. A tap while thinking or speaking is the cut-in:
   the voice stops, the answer is let go, and the mic opens. */
// lastTap starts at -Infinity: the page clock starts at load, so a 0 here
// would swallow a tap in the first half second as a bump
const K = { state: 'idle', lastTap: -Infinity };
function setKey(s) {
  K.state = s;
  const k = $('key');
  const w = KEY_WORDS[s];
  k.dataset.state = s;
  k.setAttribute('aria-label', w[2]);
  $('keyState').textContent = w[0];
  $('keyAct').textContent = w[1];
  if (s === 'idle') wakeOff(); else wakeOn();
}
function onKey() {
  const now = performance.now();
  if (now - K.lastTap < TAP_GUARD_MS) return;
  K.lastTap = now;
  if (!C.key || C.refused) return;
  buzz(12);
  if (K.state === 'idle') { listen(); return; }
  if (K.state === 'listening') { over('tap'); return; }
  cutIn();
}
function cutIn() {
  T.gen++;
  abortTurn();
  hush();
  if (T.view && T.view.n) T.view.t.classList.add('cut');
  K.state = 'idle';
  listen();
}

/* ══ THE EAR (the phone half) ════════════════════════════════════════════
   The proven recipe from ear.html: MediaRecorder, Opus in WebM (MP4 where
   that is all there is), 24 kbps, 250 ms chunks. The whole take goes to the
   Mac as one blob, and the Mac destroys the audio once it has the words. */
const M = { stream: null, ctx: null, src: null, an: null, buf: null, take: null, vuT: 0, gen: 0 };

function audioCtx() {
  if (!M.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { M.ctx = new AC(); } catch (e) { return null; }
  }
  if (M.ctx.state === 'suspended') { try { M.ctx.resume().catch(() => {}); } catch (e) {} }
  return M.ctx;
}
async function micStream() {
  if (M.stream && M.stream.getAudioTracks().some(t => t.readyState === 'live')) return M.stream;
  const s = await navigator.mediaDevices.getUserMedia(
    { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  M.stream = s;
  try { if (M.src) M.src.disconnect(); } catch (e) {}
  M.src = null;
  const ctx = audioCtx();
  if (ctx) {
    try {
      if (!M.an) {
        M.an = ctx.createAnalyser();
        M.an.fftSize = 512;
        M.buf = new Uint8Array(M.an.frequencyBinCount);
      }
      M.src = ctx.createMediaStreamSource(s);
      M.src.connect(M.an);
    } catch (e) { M.src = null; M.an = null; }
  }
  return s;
}
function micRelease() {
  // every path stops the tracks: a mic left open reads as surveillance
  try { if (M.src) M.src.disconnect(); } catch (e) {}
  M.src = null;
  try { if (M.stream) M.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  M.stream = null;
}
function pickMime() {
  const MR = window.MediaRecorder;
  if (!MR || !MR.isTypeSupported) return '';
  if (MR.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MR.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return '';
}
async function listen() {
  if (!C.key || C.refused || K.state === 'listening') return;
  if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("This browser can't record here. Type it instead.");
    return;
  }
  hush();
  hideNotch();
  const gen = ++M.gen;
  setKey('listening');
  audioCtx();                        // inside his tap, so the browser lets it run
  let stream;
  try { stream = await micStream(); } catch (e) {
    if (gen === M.gen) {
      setKey('idle');
      earcon('miss');
      toast("The mic is blocked for this page. Allow it in Chrome's site settings, or type.");
    }
    return;
  }
  if (gen !== M.gen || K.state !== 'listening' || document.visibilityState !== 'visible') {
    if (document.visibilityState !== 'visible') micRelease();
    return;                          // he tapped again, or the page left the screen meanwhile
  }
  const mime = pickMime();
  let mr;
  try {
    mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 }
                                        : { audioBitsPerSecond: 24000 });
  } catch (e) {
    setKey('idle');
    toast("The recorder wouldn't start. Type it instead.");
    return;
  }
  const now = performance.now();
  const take = { mr, chunks: [], type: mr.mimeType || mime || 'audio/webm', t0: now,
                 live: now + EARCON_MS, gate: 0, floor: [], peak: 0, peakAt: 0,
                 spoke: false, lastVoice: 0, why: '', send: false, done: false, tgen: 0 };
  M.take = take;
  mr.addEventListener('dataavailable', e => { if (e.data && e.data.size) take.chunks.push(e.data); });
  mr.addEventListener('stop', () => taken(take));
  mr.start(250);
  earcon('live');                    // frames are flowing: now the chirp, never into a dead mic
  $('key').classList.add('live');
  // a TIMER, not an animation frame: rAF only fires while the page paints,
  // and the end of his take must never wait on a paint (ear.html, card #426)
  M.vuT = setInterval(() => vu(take), 50);
}
function vu(take) {
  if (M.take !== take) return;
  const t = performance.now();
  if (t - take.t0 > TAKE_CAP_MS) { over('cap'); return; }
  if (!M.an) return;                 // no level to read: his tap or the cap ends the take
  M.an.getByteTimeDomainData(M.buf);
  let sum = 0;
  for (let i = 0; i < M.buf.length; i++) { const d = M.buf[i] - 128; sum += d * d; }
  const rms = Math.sqrt(sum / M.buf.length) / 128;
  $('key').style.setProperty('--lvl', Math.min(1, rms * 6).toFixed(3));   // his own voice moves the key
  if (t < take.live) return;         // the chirp is still in the air
  if (!take.gate) {
    /* MEASURING THE ROOM, once. The second-quietest sample sets the floor, so
       a word he starts saying inside this window cannot raise it; and a short
       word said wholly inside the window ("yeah") still counts as speech. */
    take.floor.push(rms);
    if (rms > take.peak) { take.peak = rms; take.peakAt = t; }
    if (t - take.live < FLOOR_MS || take.floor.length < 3) return;
    const sorted = take.floor.slice().sort((a, b) => a - b);
    take.gate = Math.max(FLOOR_MIN, sorted[1] * FLOOR_RISE);
    if (take.peak > take.gate) { take.spoke = true; take.lastVoice = take.peakAt; }
    return;
  }
  if (rms > take.gate) { take.spoke = true; take.lastVoice = t; }
  const quietMs = T.stance === 'open_field' ? SILENCE_OPEN_MS : SILENCE_MS;
  if (take.spoke && t - take.lastVoice > quietMs) { over('silence'); return; }
  if (!take.spoke && t - take.live > NOTHING_MS) over('nothing');
}
/* The take is over: his tap, his quiet, the cap, nothing said, or the page
   leaving the screen. Only a real take is sent. */
function over(why) {
  const take = M.take;
  if (!take) {                       // the mic was still opening: call it off
    if (K.state === 'listening') { M.gen++; setKey('idle'); }
    return;
  }
  M.take = null;
  clearInterval(M.vuT);
  M.vuT = 0;
  const k = $('key');
  k.classList.remove('live');
  k.style.setProperty('--lvl', '0');
  const now = performance.now();
  take.why = why;
  take.endAt = why === 'silence' && take.lastVoice ? take.lastVoice : now;
  take.send = why === 'silence' || why === 'cap' || (why === 'tap' && now - take.t0 >= MIN_TAKE_MS);
  take.tgen = T.gen;
  setKey(take.send ? 'thinking' : 'idle');
  if (take.send || why === 'nothing') earcon('over');
  try {
    if (take.mr.state !== 'inactive') take.mr.stop();
    else taken(take);
  } catch (e) { taken(take); }
  if (!KEEP_MIC || why === 'hidden') micRelease();
  if (why === 'nothing') toast("Didn't hear anything. Tap the key when you're ready.");
}
function taken(take) {                // the recorder has handed over its last chunk
  if (take.done) return;
  take.done = true;
  if (!take.send || take.tgen !== T.gen || M.take) return;   // called off, or he already moved on
  if (!take.chunks.length) {
    setKey('idle');
    earcon('miss');                  // in the cab a toast alone is silence
    toast('The recording came back empty. Try again.');
    return;
  }
  const blob = new Blob(take.chunks, { type: take.type });
  sendTurn({ via: 'voice', blob, type: take.type, overAt: take.endAt });
}

/* ══ ONE TURN ════════════════════════════════════════════════════════════
   POST /api/turn, then read the NDJSON stream line by line with getReader().
   Typed: JSON {text, conv_id}. Voice: the raw blob with X-Goose-Via and
   X-Goose-Conv. Every event lands on the glass as it arrives. */
const T = {
  conv: null,         // this talk's id on the Mac
  convAt: 0,          // when a turn last touched it (Date.now()): a reload past IDLE_MIN leaves its thread on the Mac
  gen: 0,             // bumps on every new turn, cut-in or new talk: a stale stream dies at its next read
  ctrl: null,         // the open turn's AbortController
  open: false,        // an answer is still streaming
  done: false,        // the open turn has sent its done
  got: false,         // the open turn has sent at least one event
  via: 'type',
  view: null,         // the open turn's place on the glass
  last: null,         // the last take sent, held in memory for "No line — tap to resend"
  stance: 'decide',   // 'open_field' after "let me think out loud": a longer breath ends a take
  door: 'open',
  hushed: false,      // the page left the screen mid-answer: the rest lands as text
  startAt: 0,         // when this turn was sent: what it learns about the line is stamped with it
  overAt: 0, firstSound: 0, heardMs: null, ms: null,
};
const LAST = { heard: null, first: null, total: null };   // the last finished turn, measured

function abortTurn() {
  if (T.ctrl) { try { T.ctrl.abort(); } catch (e) {} }
  T.ctrl = null;
  T.open = false;
}
async function sendTurn(take) {
  if (!C.key || C.refused) return;
  hush();
  abortTurn();
  const gen = ++T.gen;
  const ac = new AbortController();
  T.ctrl = ac;
  T.open = true; T.done = false; T.got = false; T.hushed = false;
  T.via = take.via; T.last = take; T.startAt = performance.now();
  T.overAt = take.overAt || performance.now(); T.firstSound = 0; T.heardMs = null; T.ms = null;
  hideNotch();
  setKey('thinking');
  if (!take.view || take.view.n) {   // a resend after Goose had begun answering gets a fresh place
    take.view = turnView();
    if (take.via === 'type') setYou(take.view, take.text, 'type');
  }
  T.view = take.view;
  const headers = { Authorization: 'Bearer ' + C.key };
  let body;
  if (take.via === 'voice') {
    headers['Content-Type'] = take.type || 'audio/webm';
    headers['X-Goose-Via'] = 'voice';
    if (T.conv) headers['X-Goose-Conv'] = String(T.conv);
    body = take.blob;
  } else {
    headers['Content-Type'] = 'application/json';
    const b = { text: take.text };
    if (T.conv) b.conv_id = T.conv;
    body = JSON.stringify(b);
  }
  const startT = setTimeout(() => ac.abort(), TURN_START_MS);
  let r;
  try {
    r = await fetch(C.api + '/api/turn', { method: 'POST', headers, body, signal: ac.signal,
                                           cache: 'no-store', credentials: 'omit' });
  } catch (e) {
    clearTimeout(startT);
    if (gen === T.gen) noLine();
    return;
  }
  clearTimeout(startT);
  if (gen !== T.gen) return;
  if (r.status === 401) { T.open = false; T.ctrl = null; setKey('idle'); keyRefused(); return; }
  // tailscale serve answers 502 to 504 when the Mac's Goose is not up: that is no line
  if (r.status === 502 || r.status === 503 || r.status === 504) { noLine(); return; }
  if (r.status !== 200 || !r.body) {
    let msg = '';
    try { const d = await r.json(); msg = str(d && d.error); } catch (e) {}
    if (gen !== T.gen) return;
    T.open = false; T.ctrl = null; T.last = null;
    errLine(T.view, msg || 'Goose answered ' + r.status + '.');
    setKey('idle');
    return;
  }
  setLine('up', T.startAt);
  await readTurn(r, gen, ac);
}
async function readTurn(r, gen, ac) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let quietT = 0;
  const kick = () => {
    clearTimeout(quietT);
    quietT = setTimeout(() => { try { ac.abort(); } catch (e) {} }, TURN_QUIET_MS);
  };
  kick();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (gen !== T.gen) return;
      if (done) break;
      kick();
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
        if (gen !== T.gen) return;
      }
    }
    buf += dec.decode();
    if (buf.trim()) onLine(buf);
  } catch (e) {
    if (gen !== T.gen) return;       // he cut in, or started a new talk
  } finally {
    clearTimeout(quietT);
  }
  if (gen !== T.gen) return;
  T.open = false;
  T.ctrl = null;
  if (T.done) finishTurn();
  else noLine();                     // the line dropped before Goose was done
}
function onLine(line) {
  const s = line.trim();
  if (!s) return;
  let ev;
  try { ev = JSON.parse(s); } catch (e) { return; }
  if (ev && typeof ev === 'object' && typeof ev.type === 'string') onEvent(ev);
}
function onEvent(ev) {
  T.got = true;
  const v = T.view;
  switch (ev.type) {
    case 'heard': {
      if (typeof ev.ms === 'number') T.heardMs = ev.ms;
      const text = str(ev.text).trim();
      if (T.via === 'voice' && text) setYou(v, text, 'voice');
      break;
    }
    case 'conv': setConv(ev.conv_id, v, ev.door); break;
    case 'route':
      if (ev.route === 'open_field') T.stance = 'open_field';
      else if (ev.route === 'judge_it') T.stance = 'decide';
      break;
    case 'door': setDoor(ev.state === 'closed' ? 'closed' : 'open', true); break;
    case 'rail': openSheet('rail'); break;
    case 'lesson': lessonTag(v, ev); break;
    case 'sentence': {
      const text = str(ev.text).trim();
      if (text) enqueue(text, addSentence(v, text));
      break;
    }
    case 'error': {
      const text = str(ev.message).trim();
      if (text) enqueue(text, errLine(v, text));   // a plain message: the cab hears it too
      break;
    }
    case 'done':
      T.done = true;
      T.ms = ev.ms && typeof ev.ms === 'object' ? ev.ms : null;
      break;
    default: break;                  // an event this page does not know yet is let pass
  }
}
function setConv(id, v, door) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return;
  // The door is the Mac's word on EVERY conv event, never reset here, and a
  // change is said on the glass: the lock can be wrong after a reload with no
  // line, or after a closed door the Mac never got to keep.
  const state = door === 'closed' ? 'closed' : door === 'open' ? 'open' : T.door;
  if (T.conv && T.conv !== n) {
    // the old talk went quiet past IDLE_MIN, so the Mac opened a new one, with
    // the stance back on deciding. A talk that went quiet behind a closed door
    // starts the next one closed too, and the glass says where the door stands
    // either way.
    divider('a new talk', v && v.t);
    T.stance = 'decide';
    if (state === 'closed' && T.door === 'closed') {
      divider('door still closed · this stays on the Mac', v && v.t);
    }
  }
  T.conv = n;
  T.convAt = Date.now();
  setDoor(state, true, v && v.t);
  saveConv();
}
/* The talk's number and where its door stands, on this phone: never a word of
   it. The stamp moves only when a turn touches the talk (as last_at does on
   the Mac), so a door change or a reload never makes a cold talk look warm. */
function saveConv() {
  if (T.conv) store.set(K_CONV, JSON.stringify({ id: T.conv, at: T.convAt, door: T.door }));
}
function setDoor(state, announce, before) {
  const was = T.door;
  T.door = state;
  $('lock').hidden = state !== 'closed';
  if (announce && was !== state) {
    divider(state === 'closed' ? 'door closed · this stays on the Mac' : 'door open', before || null);
  }
  saveConv();                        // kept the moment it moves: a line that drops before done must not lose it
}
function finishTurn() {
  T.last = null;                     // it landed: nothing to resend
  setLine('up', T.startAt);
  if (T.conv) { T.convAt = Date.now(); saveConv(); }
  LAST.heard = T.via === 'voice' ? T.heardMs : null;
  LAST.first = T.firstSound ? T.firstSound - T.overAt : null;
  LAST.total = T.ms && typeof T.ms.total === 'number' ? T.ms.total : null;
  settle();
}
/* NO LINE: a red notch, the dot red, and the take held in memory. A tap on
   the notch sends the same take again. */
function noLine() {
  T.open = false;
  T.ctrl = null;
  setLine('down', T.startAt);
  $('resend').hidden = !T.last;
  earcon('noline');
  settle();
  if (K.state === 'thinking') setKey('idle');
}
function hideNotch() { $('resend').hidden = true; }
function resend() {
  if (!T.last || K.state !== 'idle' || C.refused) return;
  buzz(12);
  T.last.overAt = performance.now();   // "first sound" is timed from this send, not the one that failed
  sendTurn(T.last);
}

/* ══ GOOSE'S VOICE ═══════════════════════════════════════════════════════
   Each sentence goes to POST /api/say as it arrives; the WAVs play in order
   through one <audio>, two fetched ahead of the one playing, so the first
   sentence speaks while the model is still writing the rest. */
const audio = $('voice');
const Q = { items: [], head: 0, playing: null, gen: 0, ctrl: new AbortController() };
function voiceOn() { return store.get(K_VOICE) !== '0'; }
function enqueue(text, span) {
  if (!voiceOn() || T.hushed || document.visibilityState !== 'visible') return;
  Q.items.push({ text, span, url: '', p: null });
  pump();
}
function fetchSay(it, gen) {
  it.p = call('POST', '/api/say', { json: { text: it.text }, as: 'blob', timeout: SAY_MS,
                                    signal: Q.ctrl.signal })
    .then(r => {
      if (gen !== Q.gen) return;
      if (r.status === 200 && r.data && r.data.size > 44) it.url = URL.createObjectURL(r.data);
      else if (r.status === 401) keyRefused();
      else it.failed = true;         // the Mac could not voice it: it gets a tone, not silence
    });
}
function pump() {
  const gen = Q.gen;
  for (let i = Q.head; i < Q.items.length && i <= Q.head + PREFETCH; i++) {
    if (!Q.items[i].p) fetchSay(Q.items[i], gen);
  }
  if (Q.playing) return;
  if (Q.head >= Q.items.length) { settle(); return; }
  const it = Q.items[Q.head];
  Q.playing = it;
  it.p.then(() => {
    if (gen !== Q.gen || Q.playing !== it) return;
    if (!it.url) {                       // no voice for this one: its words are on the glass,
      if (it.failed) earcon('miss');     // and the cab hears that one was missed
      next(it);
      return;
    }
    audio.src = it.url;
    let p;
    try { p = audio.play(); } catch (e) { next(it); return; }
    if (p && typeof p.then === 'function') {
      p.then(() => started(it, gen), () => { if (gen === Q.gen && Q.playing === it) next(it); });
    } else started(it, gen);
  });
}
function started(it, gen) {
  if (gen !== Q.gen || Q.playing !== it) return;
  if (it.span) it.span.classList.add('lit');
  if (!T.firstSound) T.firstSound = performance.now();
  if (K.state !== 'listening') setKey('speaking');
}
function next(it) {
  if (it.span) it.span.classList.remove('lit');
  if (it.url) { try { URL.revokeObjectURL(it.url); } catch (e) {} it.url = ''; }
  if (Q.playing === it) { Q.playing = null; Q.head++; }
  pump();
}
audio.addEventListener('ended', () => { if (Q.playing) next(Q.playing); });
audio.addEventListener('error', () => { if (Q.playing && Q.playing.url) next(Q.playing); });
/* Silence, now: a cut-in, a new turn, a new talk, the page leaving the
   screen, or voice switched off. */
function hush() {
  Q.gen++;
  try { Q.ctrl.abort(); } catch (e) {}
  Q.ctrl = new AbortController();
  try { audio.pause(); } catch (e) {}
  audio.removeAttribute('src');
  try { audio.load(); } catch (e) {}
  for (const it of Q.items) {
    if (it.span) it.span.classList.remove('lit');
    if (it.url) { try { URL.revokeObjectURL(it.url); } catch (e) {} }
  }
  Q.items = [];
  Q.head = 0;
  Q.playing = null;
}
/* Nothing is playing and nothing is waiting to play: the key says what is next. */
function settle() {
  if (Q.playing || Q.head < Q.items.length) return;
  if (K.state === 'speaking' || K.state === 'thinking') {
    if (T.open) setKey('thinking');
    else { setKey('idle'); maybeReload(); }
  }
}
/* Stop everything that is moving, and keep the glass as it is. */
function quiet() {
  if (M.take || K.state === 'listening') over('cancel');
  T.gen++;
  abortTurn();
  hush();
  setKey('idle');
}

/* ── earcons: the cab hears the mic open, the take close and a dropped line,
   so nothing has to be read. Off with the voice. ─────────────────────────── */
function earcon(kind) {
  if (!voiceOn()) return;
  const ctx = M.ctx;
  if (!ctx || ctx.state !== 'running') return;
  // live: rising chirp · over: one tone · miss: a short fall (a sentence or a
  // take that did not make it) · noline: the low double
  const tones = kind === 'live' ? [[880, 0, 0.06], [1320, 0.07, 0.08]]
              : kind === 'over' ? [[660, 0, 0.09]]
              : kind === 'miss' ? [[392, 0, 0.08], [294, 0.1, 0.1]]
              : [[150, 0, 0.13], [110, 0.17, 0.16]];
  const peak = kind === 'noline' ? 0.12 : 0.06;
  try {
    const t0 = ctx.currentTime;
    for (const [freq, at, dur] of tones) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t0 + at);
      o.stop(t0 + at + dur + 0.02);
    }
  } catch (e) {}
}

/* ── the wake lock: the screen stays on while he talks and Goose answers ── */
const W = { lock: null, want: false, asking: false };
async function wakeOn() {
  W.want = true;
  if (W.lock || W.asking || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  W.asking = true;
  try {
    const l = await navigator.wakeLock.request('screen');
    if (!W.want) { try { l.release().catch(() => {}); } catch (e) {} return; }
    W.lock = l;
    l.addEventListener('release', () => { if (W.lock === l) W.lock = null; });
  } catch (e) {
  } finally { W.asking = false; }
}
function wakeOff() {
  W.want = false;
  const l = W.lock;
  W.lock = null;
  if (l) { try { l.release().catch(() => {}); } catch (e) {} }
}

/* ══ TYPING, NEW TALK, VOICE ═════════════════════════════════════════════ */
function sendTyped() {
  const box = $('text');
  const text = box.value.trim();
  if (!text || !C.key || C.refused) return;
  if (M.take || K.state === 'listening') over('cancel');
  box.value = '';
  sendTurn({ via: 'type', text });
}
function newTalk() {
  quiet();
  const wasClosed = T.door === 'closed';
  T.conv = null;
  T.convAt = 0;
  T.last = null;
  T.stance = 'decide';
  store.del(K_CONV);
  hideNotch();
  clearThread();
  // a fresh talk on the Mac starts with the door open; if it was closed, the
  // glass says so instead of the lock just vanishing
  setDoor('open', wasClosed);
}
function paintVoice() {
  const on = voiceOn();
  const b = $('voiceBtn');
  b.textContent = on ? 'VOICE ON' : 'VOICE OFF';
  b.setAttribute('aria-pressed', String(on));
}
function toggleVoice() {
  store.set(K_VOICE, voiceOn() ? '0' : '1');
  paintVoice();
  if (!voiceOn()) { hush(); settle(); }
}

/* ══ THE SHEETS ══════════════════════════════════════════════════════════ */
const SHEETS = {
  rail: { sheet: 'sheetRail', opener: 'b988', title: 'railTitle', load: () => railOpen() },
  lessons: { sheet: 'sheetLessons', opener: 'lessonsBtn', title: 'lessonsTitle', load: () => loadLessons() },
  know: { sheet: 'sheetKnow', opener: 'knowBtn', title: 'knowTitle', load: () => loadKnow() },
  settings: { sheet: 'sheetSettings', opener: 'gear', title: 'settingsTitle', load: () => loadSettings() },
};
let OPEN = '';
function openSheet(name) {
  if (OPEN === name) return;
  if (OPEN) closeSheets(true);
  const s = SHEETS[name];
  const sheet = $(s.sheet), scrim = $('scrim');
  sheet.hidden = false;
  scrim.hidden = false;
  OPEN = name;
  requestAnimationFrame(() => {
    if (OPEN !== name) return;
    sheet.classList.add('on');
    scrim.classList.add('on');
  });
  $(s.opener).setAttribute('aria-expanded', 'true');
  s.load();
  try { $(s.title).focus(); } catch (e) {}
}
function closeSheets(now) {
  if (!OPEN) return;
  const s = SHEETS[OPEN];
  const sheet = $(s.sheet), scrim = $('scrim');
  OPEN = '';
  sheet.classList.remove('on');
  scrim.classList.remove('on');
  $(s.opener).setAttribute('aria-expanded', 'false');
  const hide = () => {
    if (!sheet.classList.contains('on')) sheet.hidden = true;
    if (!OPEN) scrim.hidden = true;
  };
  if (now) hide(); else setTimeout(hide, 260);
  if (!now) { try { $(s.opener).focus(); } catch (e) {} }
  maybeReload();
}
function toggleSheet(name) { if (OPEN === name) closeSheets(); else openSheet(name); }

/* LESSONS: a proposed rule has KEEP and DROP, a live lesson has RETIRE, and a
   retired or dropped one is struck through. */
async function loadLessons() {
  const box = $('lessonList');
  box.replaceChildren(el('p', 'quiet', 'Reading…'));
  const r = await call('GET', '/api/lessons');
  if (r.status === 401) { keyRefused(); return; }
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.lessons)) {
    box.replaceChildren(el('p', 'quiet', r.status === 0 ? 'No line. The lessons are on the Mac.'
                                                        : "The lessons didn't load."));
    return;
  }
  const list = r.data.lessons.filter(L => L && typeof L === 'object');
  if (!list.length) {
    box.replaceChildren(el('p', 'quiet', 'Nothing learned yet. Correct Goose in plain words and it lands here.'));
    return;
  }
  box.replaceChildren(...list.map(lessonRow));
}
function lessonRow(L) {
  const status = str(L.status);
  const row = el('div', 'lesson' + (status === 'retired' || status === 'dropped' ? ' gone' : ''));
  const head = el('div', 'lesson-head');
  head.append(el('span', 'lane', str(L.lane) || 'lesson'),
              el('span', 'lstat', STATUS_WORD[status] || status),
              el('span', 'ldate', mmdd(L.at)));
  row.append(head, el('p', 'lesson-st', str(L.statement)));
  if (str(L.his_words)) row.appendChild(el('p', 'lesson-his', 'you said: “' + L.his_words + '”'));
  const acts = el('div', 'lesson-acts');
  if (status === 'proposed') acts.append(actBtn(L, 'keep', 'KEEP'), actBtn(L, 'drop', 'DROP'));
  else if (status === 'live') acts.appendChild(actBtn(L, 'retire', 'RETIRE'));
  if (acts.children.length) row.appendChild(acts);
  return row;
}
function actBtn(L, act, label) {
  const b = el('button', 'act ' + act, label);
  b.type = 'button';
  b.setAttribute('aria-label', label.toLowerCase() + ': ' + (str(L.statement) || 'this lesson'));
  b.addEventListener('click', async () => {
    const id = Number(L.id);
    if (!Number.isInteger(id) || id <= 0) return;
    b.disabled = true;
    const r = await call('POST', '/api/lessons/' + id + '/' + act, { json: {} });
    if (r.status === 401) { keyRefused(); return; }
    if (r.status !== 200) {
      b.disabled = false;
      toast(r.status === 0 ? 'No line. Nothing changed.' : "That didn't take. Nothing changed.");
      return;
    }
    loadLessons();
  });
  return b;
}

/* WHAT I KNOW: THE CARD, each line with its source and its age. */
async function loadKnow() {
  const box = $('knowList');
  box.replaceChildren(el('p', 'quiet', 'Reading…'));
  const r = await call('GET', '/api/card');
  if (r.status === 401) { keyRefused(); return; }
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.lines)) {
    box.replaceChildren(el('p', 'quiet', r.status === 0 ? 'No line. The card is on the Mac.'
                                                        : "The card didn't load."));
    return;
  }
  const out = [];
  let sec = null, secEl = null;
  for (const ln of r.data.lines) {
    if (!ln || typeof ln !== 'object') continue;
    const name = str(ln.section);
    if (secEl === null || name !== sec) {
      sec = name;
      secEl = el('section', 'know-sec');
      if (name) secEl.appendChild(el('h3', 'know-h', name));
      out.push(secEl);
    }
    const line = el('div', 'know-line');
    line.appendChild(el('p', 'know-t', str(ln.text)));
    const meta = [str(ln.source), str(ln.age)].filter(Boolean).join(' · ');
    if (meta) line.appendChild(el('p', 'know-m', meta));
    secEl.appendChild(line);
  }
  if (!out.length) out.push(el('p', 'quiet', 'The card is empty.'));
  const at = clock(r.data.built_at);
  if (at) out.push(el('p', 'fine', 'Read fresh at ' + at + '.'));
  box.replaceChildren(...out);
}

/* SETTINGS: the sponsor's number, the connection's host, and re-connect. */
function loadSettings() {
  sponsorFill();
  $('setHost').textContent = C.api ? hostOf(C.api) : 'Not connected';
  $('setLine').textContent = !C.key ? 'Not connected' : C.refused ? 'Key refused'
    : C.line === 'up' ? 'On the line' : C.line === 'down' ? 'No line' : 'Checking';
  const h = C.health;
  $('setGoose').textContent = h ? [str(h.version), str(h.model)].filter(Boolean).join(' · ') || 'answering' : 'not heard from yet';
  $('setEars').textContent = h ? 'ears ' + (h.ear ? 'ready' : 'not ready') + ' · voice ' + (h.mouth ? 'ready' : 'not ready')
                               : 'not heard from yet';
  const bits = [];
  if (typeof LAST.heard === 'number') bits.push('heard in ' + secs(LAST.heard));
  if (typeof LAST.first === 'number') bits.push('first sound ' + secs(LAST.first) + ' after you finished');
  if (typeof LAST.total === 'number') bits.push('the Mac took ' + secs(LAST.total));
  $('setLast').textContent = bits.length ? bits.join(' · ') : 'no turn yet';
  askVersion();
}
function askVersion() {
  const out = $('setShell');
  const sw = navigator.serviceWorker;
  if (!sw || !sw.controller) { out.textContent = 'no offline copy yet'; return; }
  try { sw.controller.postMessage({ type: 'VERSION' }); } catch (e) {}
}
function forget() {
  if (!window.confirm("Forget this connection? You'll need a new connect link from the Mac.")) return;
  quiet();
  const wasClosed = T.door === 'closed';
  store.del(K_CFG);
  store.del(K_CONV);
  C.api = ''; C.key = ''; C.line = 'unknown'; C.lineAt = -Infinity; C.health = null; C.refused = false;
  T.conv = null; T.convAt = 0; T.last = null;
  clearThread();
  // the talk's number is gone, so the next talk starts open on the Mac: the
  // lock must not stay up claiming a door that no longer holds (as NEW TALK)
  setDoor('open', wasClosed);
  closeSheets(true);
  showConnect('');
}

/* ══ THE SPONSOR'S NUMBER ════════════════════════════════════════════════
   Read and written ONLY in this phone's localStorage, and used ONLY as the
   href of a tel: link. No function in this section calls the network, and
   nothing outside this section reads K_SPONSOR. The number is never in a
   fetch, a header, a body, or a URL this page requests. */
function sponsorGet() {
  const v = store.get(K_SPONSOR) || '';
  return /^\+?[0-9]{7,15}$/.test(v) ? v : '';
}
function sponsorClean(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return (s.charAt(0) === '+' ? '+' : '') + digits;
}
function sponsorSave(input, note) {
  const n = sponsorClean(input.value);
  if (!n) { note.textContent = "That doesn't look like a phone number."; return; }
  if (!store.set(K_SPONSOR, n)) { note.textContent = "This phone wouldn't keep it."; return; }
  note.textContent = 'Saved on this phone.';
  renderSponsor();
  if (input.id === 'sponsorIn') input.value = '';
}
function sponsorDel() {
  store.del(K_SPONSOR);
  $('setSponsor').value = '';
  $('setSponsorNote').textContent = 'Removed from this phone.';
  renderSponsor();
}
function renderSponsor() {
  const n = sponsorGet();
  const link = $('sponsorLink');
  $('sponsorCall').hidden = !n;
  $('sponsorAdd').hidden = !!n;
  if (n) link.setAttribute('href', 'tel:' + n);
  else link.removeAttribute('href');
}
function railOpen() {                 // the rail sheet, each time it opens: a clean note
  $('sponsorNote').textContent = '';
  renderSponsor();
}
function sponsorFill() {              // the settings field shows the saved number, to change it
  $('setSponsor').value = sponsorGet();
  $('setSponsorNote').textContent = '';
}

/* ══ THE SHELL ITSELF: offline copy, auto-update, #reset ════════════════
   The worker serves the shell from its cache; a new version takes over in
   the background, and the page reloads into it only when he is idle with
   nothing typed and no sheet open: never mid-take, never mid-answer. */
const SW = { reg: null, reload: false };
function startSW() {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  let had = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (had) { SW.reload = true; maybeReload(); }
    had = true;
  });
  sw.addEventListener('message', e => {
    const d = e.data;
    if (d && d.type === 'VERSION' && typeof d.version === 'string') $('setShell').textContent = d.version;
  });
  sw.register('sw.js', { scope: './', updateViaCache: 'none' })
    .then(r => { SW.reg = r; })
    .catch(() => {});
  setInterval(updateSW, 3600000);
}
function updateSW() { try { if (SW.reg) SW.reg.update().catch(() => {}); } catch (e) {} }
function maybeReload() {
  // T.last is a take still waiting on "tap to resend": a reload would lose it
  if (!SW.reload || K.state !== 'idle' || T.open || T.last || OPEN || M.take
      || $('text').value.trim()) return;
  SW.reload = false;
  location.reload();
}
/* #reset: drop this app's worker and caches and reload clean. Settings,
   the key and the sponsor's number stay. */
async function reset() {
  try {
    const root = new URL('./', location.href).href;
    const sw = navigator.serviceWorker;
    const regs = sw && sw.getRegistrations ? await sw.getRegistrations() : [];
    await Promise.all(regs.filter(r => r.scope === root).map(r => r.unregister()));
    const keys = window.caches ? await caches.keys() : [];
    await Promise.all(keys.filter(k => k.indexOf('goose-shell-') === 0).map(k => caches.delete(k)));
  } catch (e) {}
  location.replace(location.pathname + location.search);
}

/* ══ THE PAGE LEAVING THE SCREEN ═════════════════════════════════════════
   A call, another app or a dark screen ends a take unsent, lets go of the
   mic, and silences Goose; the rest of the answer still lands as text. */
function onVisibility() {
  if (document.visibilityState !== 'visible') {
    if (M.take || K.state === 'listening') over('hidden');
    micRelease();
    hush();
    T.hushed = true;
    if (M.ctx && M.ctx.state === 'running') { try { M.ctx.suspend().catch(() => {}); } catch (e) {} }
    if (K.state !== 'idle') setKey(T.open ? 'thinking' : 'idle');
    wakeOff();
    return;
  }
  if (K.state !== 'idle') wakeOn();
  checkLine();
  warm(false);
  updateSW();
}
function onHash() {
  if (location.hash === '#reset') { reset(); return; }
  const c = takeLink();
  if (c) adopt(c);
}

/* ══ WIRING ══════════════════════════════════════════════════════════════ */
function wire() {
  $('key').addEventListener('click', onKey);
  $('resend').addEventListener('click', resend);
  $('send').addEventListener('click', sendTyped);
  $('text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendTyped(); }
  });
  $('newtalk').addEventListener('click', newTalk);
  $('lessonsBtn').addEventListener('click', () => toggleSheet('lessons'));
  $('knowBtn').addEventListener('click', () => toggleSheet('know'));
  $('voiceBtn').addEventListener('click', toggleVoice);
  $('gear').addEventListener('click', () => toggleSheet('settings'));
  $('b988').addEventListener('click', e => { e.preventDefault(); toggleSheet('rail'); });
  $('scrim').addEventListener('click', () => closeSheets());
  for (const id of ['railClose', 'lessonsClose', 'knowClose', 'settingsClose']) {
    $(id).addEventListener('click', () => closeSheets());
  }
  $('sponsorSave').addEventListener('click', () => sponsorSave($('sponsorIn'), $('sponsorNote')));
  $('sponsorIn').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sponsorSave($('sponsorIn'), $('sponsorNote')); }
  });
  $('setSponsorSave').addEventListener('click', () => sponsorSave($('setSponsor'), $('setSponsorNote')));
  $('setSponsor').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sponsorSave($('setSponsor'), $('setSponsorNote')); }
  });
  $('setSponsorDel').addEventListener('click', sponsorDel);
  $('reconnect').addEventListener('click', forget);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (OPEN) { e.preventDefault(); closeSheets(); } return; }
    if (!TURNER_KEYS.has(e.key) || e.repeat || OPEN || $('talk').hidden) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    onKey();
  });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => {
    if (M.take || K.state === 'listening') over('hidden');
    micRelease();
    hush();
    wakeOff();
  });
  window.addEventListener('hashchange', onHash);
  window.addEventListener('online', () => checkLine());
}

/* ══ BOOT ════════════════════════════════════════════════════════════════ */
function boot() {
  wire();
  paintVoice();
  renderSponsor();
  setKey('idle');
  if (location.hash === '#reset') { reset(); return; }
  startSW();
  const have = loadCfg();
  if (have) {
    showTalk();
    restoreThread();
    checkLine();
    warm(true);
  } else if (!LINK) {
    showConnect('');
  }
  if (LINK) adopt(LINK);
  setInterval(() => { if (document.visibilityState === 'visible') checkLine(); }, HEALTH_MS);
}
boot();
})();
