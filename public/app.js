/* REGIMEN — client */
const $ = (s) => document.querySelector(s);
const CIRC = 2 * Math.PI * 86; // dial circumference

let STATE = null;
const pending = new Set(); // task ids with an in-flight check request

/* ---------- access token ----------
   Arrives once as ?token=… , gets saved, and is stripped from the address bar
   so it stays out of screenshots and history. Mirrored into the Cache API
   because the service worker can't read localStorage and still needs to
   re-register a rotated push subscription on its own. */
const TOKEN_URL = '/__regimen_token';

function captureToken() {
  const url = new URL(location.href);
  const fresh = url.searchParams.get('token');
  if (fresh) {
    try { localStorage.setItem('regimen-token', fresh); } catch {}
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  let token = fresh;
  if (!token) { try { token = localStorage.getItem('regimen-token'); } catch {} }
  if (token && 'caches' in window) {
    caches.open('regimen-auth')
      .then((c) => c.put(TOKEN_URL, new Response(token)))
      .catch(() => {}); // push re-registration degrades, the app still works
  }
  return token || '';
}
const TOKEN = captureToken();

const authHeaders = (extra = {}) =>
  TOKEN ? { ...extra, Authorization: 'Bearer ' + TOKEN } : extra;

const api = async (path, body) => {
  const res = await fetch('/api/' + path, body
    ? { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) }
    : { headers: authHeaders() });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(path + ' failed: ' + res.status);
  return res.json();
};

/* ---------- render ---------- */
function renderHeader() {
  const d = new Date();
  const day = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const mon = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  $('#date-line').textContent = `${day} · ${mon} ${String(d.getDate()).padStart(2, '0')}`;
  const chip = $('#streak-chip');
  chip.hidden = STATE.streak < 1;
  $('#streak-n').textContent = STATE.streak;
}

function renderDial(animate = true) {
  const fill = $('#dial-fill');
  if (!animate) fill.style.transition = 'none';
  fill.style.strokeDashoffset = CIRC * (1 - STATE.momentum / 100);
  if (!animate) requestAnimationFrame(() => (fill.style.transition = ''));
  $('#momentum').textContent = STATE.momentum;
  $('#mantra').textContent = '“' + STATE.mantra + '”';
}

function renderWater(justFilled = -1) {
  $('#water-n').textContent = STATE.water;
  $('#water-t').textContent = STATE.waterTarget;
  const bar = $('#water-bar');
  bar.innerHTML = '';
  for (let i = 0; i < STATE.waterTarget; i++) {
    const seg = document.createElement('div');
    seg.className = 'water-seg' + (i < STATE.water ? ' full' : '') + (i === justFilled ? ' just-filled' : '');
    bar.appendChild(seg);
    if (i === justFilled) setTimeout(() => seg.classList.remove('just-filled'), 220);
  }
}

function taskCard(t) {
  const el = document.createElement('div');
  el.className = 'task' + (t.done ? ' done' : '');
  el.dataset.id = t.id;
  el.setAttribute('role', 'checkbox');
  el.setAttribute('aria-checked', t.done);
  el.tabIndex = 0;
  el.innerHTML = `
    <svg class="ic task-ic"><use href="#i-${t.icon}"/></svg>
    <div class="task-body">
      <div class="task-title">${t.title}</div>
      <div class="task-detail">${t.detail || ''}</div>
    </div>
    <span class="task-time">${t.time}</span>
    <div class="task-check"><svg class="ic" viewBox="0 0 24 24"><path class="check-path" d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  const toggle = () => toggleTask(t.id, el);
  el.addEventListener('click', toggle);
  el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
  return el;
}

function renderBlocks() {
  const wrap = $('#blocks');
  wrap.innerHTML = '';
  for (const b of STATE.blocks) {
    const done = b.tasks.every((t) => t.done);
    const sec = document.createElement('section');
    sec.className = 'block' + (done ? ' block-done' : '');
    sec.id = 'block-' + b.id;
    sec.innerHTML = `
      <div class="block-head">
        <span class="block-node"></span>
        <div>
          <div class="block-eyebrow">${b.eyebrow}</div>
          <h2 class="block-title">${b.label.charAt(0) + b.label.slice(1).toLowerCase()}</h2>
        </div>
      </div>`;
    for (const t of b.tasks) sec.appendChild(taskCard(t));
    wrap.appendChild(sec);
  }
}

function renderMaint() {
  const row = $('#maint-row');
  row.innerHTML = '';
  for (const m of STATE.maintenance) {
    const el = document.createElement('div');
    const dueNow = m.daysLeft === 0 && !m.doneToday;
    el.className = 'maint' + (dueNow ? ' due-now' : '') + (m.doneToday ? ' done-today' : '');
    el.innerHTML = `
      <svg class="ic maint-ic"><use href="#i-${m.icon}"/></svg>
      <div class="maint-title">${m.title}</div>
      <div class="maint-due">${m.doneToday ? 'DONE ✓' : dueNow ? (m.overdue ? 'OVERDUE' : 'DUE TODAY') : 'IN ' + m.daysLeft + 'D'}</div>`;
    el.addEventListener('click', async () => {
      try {
        await api('maint', { id: m.id, done: !m.doneToday });
        await refresh(false);
      } catch { /* offline — card stays as-is until reconnect */ }
    });
    row.appendChild(el);
  }
}

function renderSpark() {
  $('#best-n').textContent = STATE.best;
  const spark = $('#spark');
  spark.innerHTML = '';
  const days = [...STATE.history];
  while (days.length < 14) days.unshift(null);
  for (const d of days.slice(-14)) {
    const bar = document.createElement('div');
    bar.className = 'spark-bar' + (d && d.pct >= 80 ? ' hit' : '');
    bar.style.height = d ? Math.max(6, d.pct * 0.56) + 'px' : '3px';
    spark.appendChild(bar);
  }
}

/* ---------- interactions ---------- */
async function toggleTask(id, el) {
  if (pending.has(id)) return; // one in-flight request per task
  const t = STATE.blocks.flatMap((b) => b.tasks).find((x) => x.id === id);
  const next = !t.done;
  const paint = (done) => {
    el.classList.toggle('done', done);
    el.setAttribute('aria-checked', done);
  };
  paint(next); // optimistic
  if (next) {
    el.classList.add('just-done');
    setTimeout(() => el.classList.remove('just-done'), 260);
  }
  pending.add(id);
  try {
    const r = await api('check', { id, done: next });
    // only a confirmed write changes local truth
    t.done = next;
    paint(next);
    STATE.momentum = r.momentum;
    renderDial();
    // block node lights up when its block completes
    const block = STATE.blocks.find((b) => b.tasks.some((x) => x.id === id));
    const sec = $('#block-' + block.id);
    sec.classList.toggle('block-done', block.tasks.every((x) => x.done));
  } catch {
    el.classList.remove('just-done');
    paint(t.done); // server never took it — put the card back
  } finally {
    pending.delete(id);
  }
}

let waterBusy = false;
async function changeWater(delta) {
  if (waterBusy) return;
  waterBusy = true;
  $('#water-plus').disabled = true;
  $('#water-minus').disabled = true;
  try {
    const r = await api('water', { delta });
    const justFilled = delta > 0 ? r.water - 1 : -1;
    STATE.water = r.water; // always render the server's count
    renderWater(justFilled);
  } catch {
    renderWater();
  } finally {
    waterBusy = false;
    $('#water-plus').disabled = false;
    $('#water-minus').disabled = false;
  }
}

$('#water-plus').addEventListener('click', () => {
  if (STATE.water >= STATE.waterTarget) return;
  changeWater(1);
});
$('#water-minus').addEventListener('click', () => changeWater(-1));

/* dock */
document.querySelectorAll('.dock-btn[data-target]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dock-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.target).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* ---------- theme (Auto → Light → Dark) ---------- */
/* 'auto' removes data-theme entirely so prefers-color-scheme governs again. */
const THEMES = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: '#i-auto', light: '#i-sun', dark: '#i-moon' };
let themeMode = 'auto';

function applyTheme(mode) {
  themeMode = mode;
  if (mode === 'auto') {
    delete document.documentElement.dataset.theme;
    // hand the status-bar tint back to prefers-color-scheme
    $('#theme-color-dark').media = '(prefers-color-scheme: dark)';
    $('#theme-color-light').media = '(prefers-color-scheme: light)';
  } else {
    document.documentElement.dataset.theme = mode;
    $('#theme-color-dark').media = mode === 'dark' ? 'all' : 'not all';
    $('#theme-color-light').media = mode === 'light' ? 'all' : 'not all';
  }
  $('#theme-btn').setAttribute('aria-label', 'Theme: ' + mode[0].toUpperCase() + mode.slice(1));
  $('#theme-use').setAttribute('href', THEME_ICON[mode]);
  heroFxRecolor(); // the canvas paints in --amber, which just changed
}

/* called from boot, after the `let fx` below is initialised (applyTheme reaches
   into the hero canvas) */
function initTheme() {
  let saved = 'auto';
  try { saved = localStorage.getItem('regimen-theme') || 'auto'; } catch {}
  applyTheme(THEMES.includes(saved) ? saved : 'auto');
  $('#theme-btn').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length];
    try { localStorage.setItem('regimen-theme', next); } catch {}
    applyTheme(next);
  });
}

/* ---------- hero ambient field ---------- */
/* ~18 particles drifting inside the hero box, hairline links under 70px.
   No pointer interaction (phone PWA), paused when the tab is hidden, and a
   single static frame when the user asked for reduced motion. */
const HERO_FX = { count: 18, connect: 70, speed: 0.05, dot: 1.4, dotAlpha: 0.35, lineAlpha: 0.12 };
let fx = null;

function heroFxRecolor() {
  if (!fx) return;
  const c = getComputedStyle(document.documentElement).getPropertyValue('--amber').trim();
  fx.color = c || '#FFAB2E';
  if (!fx.raf) heroFxDraw(); // static/paused: repaint now, no loop will do it
}

function heroFxDraw() {
  if (!fx) return;
  const { ctx, ps } = fx;
  ctx.clearRect(0, 0, fx.w, fx.h);
  ctx.strokeStyle = fx.color;
  ctx.fillStyle = fx.color;
  ctx.lineWidth = 0.6;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y);
      if (d > HERO_FX.connect) continue;
      ctx.globalAlpha = (1 - d / HERO_FX.connect) * HERO_FX.lineAlpha;
      ctx.beginPath(); ctx.moveTo(ps[i].x, ps[i].y); ctx.lineTo(ps[j].x, ps[j].y); ctx.stroke();
    }
  }
  ctx.globalAlpha = HERO_FX.dotAlpha;
  for (const p of ps) { ctx.beginPath(); ctx.arc(p.x, p.y, HERO_FX.dot, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
}

function heroFxStart() {
  if (!fx || fx.raf) return;
  const loop = () => {
    for (const p of fx.ps) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < -8) p.x = fx.w + 8; else if (p.x > fx.w + 8) p.x = -8;
      if (p.y < -8) p.y = fx.h + 8; else if (p.y > fx.h + 8) p.y = -8;
    }
    heroFxDraw();
    fx.raf = requestAnimationFrame(loop);
  };
  fx.raf = requestAnimationFrame(loop);
}

function heroFxStop() { if (fx && fx.raf) { cancelAnimationFrame(fx.raf); fx.raf = 0; } }

function initHeroFx() {
  const cv = $('#hero-fx'), hero = $('#hero');
  if (!cv || !hero || !cv.getContext) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  fx = { ctx: cv.getContext('2d'), w: 0, h: 0, ps: [], raf: 0, color: '#FFAB2E' };
  const size = () => {
    const r = hero.getBoundingClientRect();
    fx.w = Math.max(1, Math.round(r.width));
    fx.h = Math.max(1, Math.round(r.height));
    cv.width = fx.w * dpr; cv.height = fx.h * dpr;
    fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  for (let i = 0; i < HERO_FX.count; i++) {
    fx.ps.push({
      x: Math.random() * fx.w, y: Math.random() * fx.h,
      vx: (Math.random() - 0.5) * HERO_FX.speed, vy: (Math.random() - 0.5) * HERO_FX.speed,
    });
  }
  heroFxRecolor();
  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { size(); heroFxDraw(); }, 200);
  });
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { heroFxDraw(); return; }
  document.addEventListener('visibilitychange', () => (document.hidden ? heroFxStop() : heroFxStart()));
  if (!document.hidden) heroFxStart();
}
window.__debugDrawHeroFx = () => { if (!fx) initHeroFx(); heroFxDraw(); return fx ? fx.ps.length : 0; };

/* ---------- push ---------- */
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function armReminders() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Push not supported here. Install the app to your home screen first.');
    return;
  }
  if (!isStandalone()) {
    alert('Add REGIMEN to your Home Screen first — iOS only allows reminders from the installed app.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('vapid');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(key),
    });
    await api('subscribe', sub.toJSON());
    setBell(true);
    await api('test-push', {});
  } catch (e) {
    alert('Could not arm reminders: ' + e.message);
    setBell(false);
  }
}

function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function setBell(armed) {
  $('#bell-btn').classList.toggle('armed', armed);
  $('#bell-label').textContent = armed ? 'Armed' : 'Arm';
}

$('#bell-btn').addEventListener('click', armReminders);

async function checkExistingSub() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      // re-sync: the server may have lost subs.json while the phone kept the sub
      await api('subscribe', sub.toJSON());
      setBell(true);
    }
  } catch {} // offline boot must not break on this
}

/* ---------- voice memo ---------- */
/* Record → downmix to 16 kHz mono WAV in the browser → POST. Encoding here
   keeps the server free of any audio codec: it only ever parses our own WAV. */
const voice = { rec: null, chunks: [], stream: null, tick: null, t0: 0 };

const fmtElapsed = (ms) => {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

function recStatus(text, kind) {
  const el = $('#rec-status');
  el.textContent = text;
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('err', kind === 'err');
}

function openSheet(open) {
  const sheet = $('#voice-sheet'), scrim = $('#voice-scrim');
  if (open) {
    sheet.hidden = false;
    scrim.hidden = false;
    $('#rec-timer').textContent = '0:00';
    recStatus('Tap to record. Tap again to save it to the vault.');
    requestAnimationFrame(() => { sheet.classList.add('open'); scrim.classList.add('open'); });
  } else {
    if (voice.rec && voice.rec.state === 'recording') stopRec(); // never leave the mic hot
    sheet.classList.remove('open');
    scrim.classList.remove('open');
    setTimeout(() => { sheet.hidden = true; scrim.hidden = true; }, 320);
  }
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);           // PCM, mono
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);          // block align, 16-bit
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function toWav16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC || !OAC) throw new Error('no audio context');
  const ctx = new AC();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); }
  finally { ctx.close(); }
  // a 1-channel destination downmixes whatever the recorder gave us
  const off = new OAC(1, Math.max(1, Math.round(decoded.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return encodeWav(rendered.getChannelData(0), 16000);
}

async function startRec() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    recStatus('Recording needs the https tailnet address. Open REGIMEN there.', 'err');
    return;
  }
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    recStatus('Microphone denied. Allow the mic for REGIMEN in Settings, then try again.', 'err');
    return;
  }
  voice.chunks = [];
  voice.rec = new MediaRecorder(voice.stream);
  voice.rec.ondataavailable = (e) => { if (e.data && e.data.size) voice.chunks.push(e.data); };
  voice.rec.onstop = () => { uploadRec().catch(() => {}); };
  voice.rec.start();
  voice.t0 = Date.now();
  $('#rec-btn').classList.add('recording');
  $('#rec-btn').setAttribute('aria-label', 'Stop recording');
  $('#rec-timer').textContent = '0:00';
  recStatus('Recording. Tap again when you are done.');
  voice.tick = setInterval(() => {
    $('#rec-timer').textContent = fmtElapsed(Date.now() - voice.t0);
  }, 250);
}

function stopRec() {
  clearInterval(voice.tick);
  $('#rec-btn').classList.remove('recording');
  $('#rec-btn').setAttribute('aria-label', 'Start recording');
  if (voice.rec && voice.rec.state === 'recording') voice.rec.stop(); // fires uploadRec
  if (voice.stream) voice.stream.getTracks().forEach((t) => t.stop());
  voice.stream = null;
}

async function uploadRec() {
  const type = (voice.chunks[0] && voice.chunks[0].type) || (voice.rec && voice.rec.mimeType) || 'audio/webm';
  const blob = new Blob(voice.chunks, { type });
  voice.chunks = [];
  if (!blob.size) { recStatus('Nothing was recorded. Try again.', 'err'); return; }
  recStatus('Saving…');
  $('#rec-btn').disabled = true;
  let body = blob, mime = type;
  try {
    body = await toWav16k(blob);
    mime = 'audio/wav';
  } catch {
    // decode failed — send the original so the idea still reaches the vault,
    // just without a transcript
  }
  try {
    const res = await fetch('/api/voice', { method: 'POST', headers: authHeaders({ 'Content-Type': mime }), body });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const out = await res.json();
    recStatus('In the vault ✓ ' + out.note, 'ok');
  } catch (e) {
    recStatus('Upload failed: ' + e.message + '. Get back on the tailnet and try again.', 'err');
  } finally {
    $('#rec-btn').disabled = false;
  }
}

$('#voice-btn').addEventListener('click', () => openSheet(true));
$('#voice-close').addEventListener('click', () => openSheet(false));
$('#voice-scrim').addEventListener('click', () => openSheet(false));
$('#rec-btn').addEventListener('click', () => {
  if (voice.rec && voice.rec.state === 'recording') stopRec();
  else startRec();
});

/* ---------- boot ---------- */
async function refresh(animateDial = true) {
  STATE = await api('state');
  renderHeader();
  renderDial(animateDial);
  renderWater();
  renderBlocks();
  renderMaint();
  renderSpark();
}

function staggerIn() {
  const items = document.querySelectorAll('.hero, .panel, .block, .foot-quote');
  items.forEach((el, i) => {
    el.classList.add('reveal');
    setTimeout(() => el.classList.add('in'), 60 + i * 55);
  });
}

function entrance() {
  // park the dial empty, then sweep it to the real value once cards have landed
  const fill = $('#dial-fill');
  fill.style.transition = 'none';
  fill.style.strokeDashoffset = CIRC;
  requestAnimationFrame(() => {
    fill.style.transition = '';
    staggerIn();
    setTimeout(() => renderDial(true), 350);
  });
}

function showOffline(err) {
  // "Offline" is the wrong story when the server answered and said no.
  $('#mantra').textContent = err && err.message === 'unauthorized'
    ? 'Locked. Reopen this page with the ?token=… link the server printed on startup.'
    : 'Offline — will reconnect when you’re back on the network.';
}

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  initTheme();
  // let the entrance stagger land before the field starts drifting
  setTimeout(initHeroFx, 1100);
  // listener first: a refresh must be able to land even if the boot fetch failed
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh(false).catch((e) => showOffline(e));
  });
  try {
    await refresh(false);
    entrance();
  } catch (e) {
    showOffline(e);
    // A bad token will never fix itself by waiting — don't spin on it.
    if (e && e.message === 'unauthorized') return;
    const retry = setInterval(async () => {
      try {
        await refresh(false);
        clearInterval(retry);
        entrance();
      } catch {} // still offline — keep waiting
    }, 20000);
  }
  checkExistingSub();
  if (!isStandalone() && /iPhone|iPad/.test(navigator.userAgent)) {
    $('#install-tip').hidden = false;
    setTimeout(() => ($('#install-tip').hidden = true), 12000);
  }
})();
