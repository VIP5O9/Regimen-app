/* REGIMEN server — serves the PWA, keeps daily state, fires Web Push reminders.
   Push rides Apple's push relay, so reminders reach the phone (and mirror to
   Apple Watch) even when the phone is off the tailnet. */
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { requireToken, assertSafePushEndpoint } = require('./security');
const voice = require('./voice');

const { PORT, HOST, DATA } = config;
const MAX_SUBS = 20; // one person, a handful of devices — anything past this is abuse

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return fallback; }
};
// atomic: write a sibling .tmp then rename, so a crash mid-write can't shred the file
const writeJson = (file, obj) => {
  const dest = path.join(DATA, file);
  try {
    fs.writeFileSync(dest + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(dest + '.tmp', dest);
  } catch (e) {
    console.error('write failed', file, e.message);
  }
};

// ---------- state ----------
// First run on a fresh clone: seed the personal routine from the shipped
// example. data/regimen.json is yours and is never committed.
const REGIMEN_FILE = path.join(DATA, 'regimen.json');
if (!fs.existsSync(REGIMEN_FILE)) {
  const example = path.join(__dirname, 'data', 'regimen.example.json');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, REGIMEN_FILE);
    console.log('Seeded data/regimen.json from the example routine — edit it to make it yours.');
  }
}
const regimen = readJson('regimen.json', { blocks: [], maintenance: [], mantras: [], waterTarget: 8, waterNudges: [] });
let state = readJson('state.json', null) || {
  date: null, checks: {}, water: 0, streak: 0, best: 0,
  history: [], maintDone: {}, fired: {}
};
let subs = readJson('subs.json', []);

// ---------- VAPID keys (generated once, persisted) ----------
let vapid = readJson('vapid.json', null);
if (!vapid) {
  // Existing subscriptions were signed with a key we no longer have: they are
  // undeliverable. Regenerate (single-user app) and drop them so /api/test-push
  // reports an honest zero instead of pretending it sent.
  if (subs.length) {
    console.error(
      'VAPID keys missing or unreadable, but data/subs.json holds ' + subs.length +
      ' subscription(s). Those were created against a lost key and can never be delivered. ' +
      'Regenerating vapid.json and CLEARING subs.json — re-arm reminders from the installed app.'
    );
    subs = [];
    writeJson('subs.json', subs);
  }
  vapid = webpush.generateVAPIDKeys();
  writeJson('vapid.json', vapid);
}
// Apple's push service 403s on an invalid VAPID subject (e.g. mailto:x@local) —
// it must be a real mailto: or https: URL you control, so push stays off until
// REGIMEN_CONTACT is set rather than failing per-notification at 3am.
const PUSH_ENABLED = Boolean(config.CONTACT);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(config.CONTACT, vapid.publicKey, vapid.privateKey);
} else {
  console.warn(
    'REGIMEN_CONTACT is not set, so Web Push is disabled. Set it to a real ' +
    'mailto: or https: URL you control (see .env.example) to arm reminders.'
  );
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hhmm = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000);

const allTasks = () => regimen.blocks.flatMap(b => b.tasks);

const completionPct = (checks) => {
  let got = 0, max = 0;
  for (const t of allTasks()) {
    const w = t.core ? 2 : 1;
    max += w;
    if (checks[t.id]) got += w;
  }
  return max ? Math.round((got / max) * 100) : 0;
};

function rolloverIfNeeded() {
  const today = todayStr();
  if (state.date === today) return;
  if (state.date) {
    const gap = daysBetween(state.date, today);
    if (gap <= 0) {
      // clock stepped backwards — adopt today's date, don't re-archive the day
      state.date = today;
      writeJson('state.json', state);
      return;
    }
    const pct = completionPct(state.checks);
    state.history.push({ date: state.date, pct, water: state.water });
    // every fully missed day in the gap lands as an honest zero
    for (let i = 1; i < gap; i++) {
      const d = new Date(state.date + 'T00:00');
      d.setDate(d.getDate() + i);
      state.history.push({ date: fmtDate(d), pct: 0, water: 0 });
    }
    if (state.history.length > 90) state.history = state.history.slice(-90);
    // a streak only survives a contiguous day; any missed day resets it
    state.streak = gap === 1 && pct >= 80 ? state.streak + 1 : 0;
    if (state.streak > state.best) state.best = state.streak;
  }
  state.date = today;
  state.checks = {};
  state.water = 0;
  state.fired = {};
  writeJson('state.json', state);
}

const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function maintView() {
  const today = todayStr();
  return regimen.maintenance.map(m => {
    const last = state.maintDone[m.id] || null;
    let due = m.anchor;
    if (last) {
      const d = new Date(last + 'T00:00');
      d.setDate(d.getDate() + m.intervalDays);
      due = fmtDate(d);
    }
    const diff = daysBetween(today, due); // >0 future, 0 today, <0 overdue
    return { ...m, lastDone: last, due, daysLeft: Math.max(0, diff), overdue: diff < 0 };
  });
}

// ---------- push ----------
async function push(title, body, tag) {
  if (!PUSH_ENABLED) return;
  const payload = JSON.stringify({ title, body, tag });
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, payload); }
    catch (e) {
      // prune by endpoint — index-based pruning breaks once subs shifts
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
      else console.error('push failed', e.statusCode);
    }
  }));
  if (dead.length) {
    subs = subs.filter(s => !dead.includes(s.endpoint));
    writeJson('subs.json', subs);
  }
}

// ---------- scheduler (30s tick) ----------
const CATCHUP_MIN = 90; // fire a missed reminder up to 90 min late, then let it go
const toMinutes = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};
const minutesLate = (time, now) => toMinutes(now) - toMinutes(time);
// due and still worth firing: past its time but not stale
const isDue = (time, now) => {
  const late = minutesLate(time, now);
  return late >= 0 && late <= CATCHUP_MIN;
};

function tick() {
  rolloverIfNeeded();
  const now = hhmm();
  for (const t of allTasks()) {
    if (isDue(t.time, now) && !state.fired[t.id] && !state.checks[t.id]) {
      state.fired[t.id] = true;
      push(t.title, t.detail || 'On the regimen. Handle it.', t.id).catch(console.error);
    }
  }
  for (const n of regimen.waterNudges || []) {
    const key = 'water_' + n;
    if (isDue(n, now) && !state.fired[key] && state.water < regimen.waterTarget) {
      state.fired[key] = true;
      push('Water check', `${state.water}/${regimen.waterTarget} glasses. Drink one now.`, key).catch(console.error);
    }
  }
  for (const m of maintView()) {
    const key = 'maint_' + m.id;
    if ((m.due === todayStr() || m.overdue) && isDue(m.time, now) && !state.fired[key]) {
      state.fired[key] = true;
      push(m.title, m.detail || 'Maintenance due today.', key).catch(console.error);
    }
  }
  writeJson('state.json', state);
}
setInterval(tick, 30000);
process.on('unhandledRejection', (e) => console.error('unhandled', e));
tick(); // catch up on anything due before this process started

// ---------- API ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '64kb' }));

// The shell is public — you have to load the page before you can present a
// token. Everything under /api is gated, including the ones that only read:
// the state response is a log of your day.
app.use('/api', requireToken(config.TOKEN));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  rolloverIfNeeded();
  const dayIndex = Math.floor(new Date(todayStr() + 'T00:00') / 86400000);
  res.json({
    date: state.date,
    blocks: regimen.blocks.map(b => ({
      ...b,
      tasks: b.tasks.map(t => ({ ...t, done: !!state.checks[t.id] }))
    })),
    water: state.water,
    waterTarget: regimen.waterTarget,
    streak: state.streak,
    best: state.best,
    momentum: completionPct(state.checks),
    mantra: regimen.mantras[dayIndex % regimen.mantras.length] || '',
    maintenance: maintView().map(m => ({
      ...m, doneToday: state.maintDone[m.id] === todayStr()
    })),
    history: state.history.slice(-14)
  });
});

app.post('/api/check', (req, res) => {
  rolloverIfNeeded();
  const { id, done } = req.body || {};
  if (allTasks().some(t => t.id === id)) {
    state.checks[id] = !!done;
    writeJson('state.json', state);
  }
  res.json({ ok: true, momentum: completionPct(state.checks) });
});

app.post('/api/maint', (req, res) => {
  rolloverIfNeeded();
  const { id, done } = req.body || {};
  if (regimen.maintenance.some(m => m.id === id)) {
    if (done) state.maintDone[id] = todayStr();
    else delete state.maintDone[id];
    writeJson('state.json', state);
  }
  res.json({ ok: true });
});

app.post('/api/water', (req, res) => {
  rolloverIfNeeded();
  const delta = Number((req.body || {}).delta) || 0;
  state.water = Math.max(0, Math.min(regimen.waterTarget, state.water + delta));
  writeJson('state.json', state);
  res.json({ ok: true, water: state.water });
});

app.get('/api/vapid', (req, res) =>
  res.json({ key: vapid.publicKey, pushEnabled: PUSH_ENABLED }));

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  try {
    assertSafePushEndpoint(sub && sub.endpoint);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  if (!subs.some(s => s.endpoint === sub.endpoint)) {
    if (subs.length >= MAX_SUBS) subs.shift(); // oldest device falls off, file stays bounded
    // Store only the fields web-push needs — never echo back whatever was posted.
    subs.push({ endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: sub.keys });
    writeJson('subs.json', subs);
  }
  res.json({ ok: true, count: subs.length });
});

// Voice memo → vault. Answer the phone the moment the file is on disk; the
// transcript lands in the same note a minute later.
app.post('/api/voice',
  express.raw({
    limit: '30mb',
    type: (req) => {
      const t = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      return t.startsWith('audio/') || t === 'application/octet-stream';
    },
  }),
  (req, res) => {
    if (!config.VOICE_ENABLED) {
      return res.status(404).json({ ok: false, error: 'voice memos are disabled' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ ok: false, error: 'no audio in request' });
    }
    let saved;
    try {
      saved = voice.saveRecording(req.body, req.headers['content-type']);
    } catch (e) {
      console.error('voice save failed', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
    res.json({ ok: true, note: saved.noteName });
    voice.transcribeLater(saved).catch((e) => console.error('voice queue', e.message));
  });

app.post('/api/test-push', async (req, res) => {
  await push('REGIMEN online', 'Reminders are armed. This is how they will arrive.', 'test');
  res.json({ ok: true, sent: PUSH_ENABLED ? subs.length : 0, pushEnabled: PUSH_ENABLED });
});

// Bind IPv4 explicitly. Node's default bind is :: (dual-stack), and WSL2's
// localhost relay mirrors the address family: a ::-bound listener is reachable
// from Windows only at [::1], NOT at 127.0.0.1. Clients that resolve localhost
// to IPv4 first (.NET/HttpClient, and anything without happy-eyeballs
// fallback) then get ECONNREFUSED. Binding 0.0.0.0 exposes 127.0.0.1 on the
// Windows side, which is what `tailscale serve ... http://localhost:3117` needs.
app.listen(PORT, HOST, () => {
  console.log(`REGIMEN up on http://localhost:${PORT} (bound ${HOST})`);
  console.log('');
  console.log('  Open this once per device — it saves the token, then drops it from the URL:');
  console.log(`  http://localhost:${PORT}/?token=${config.TOKEN}`);
  console.log('');
  console.log('  Over Tailscale, swap the host: https://<machine>:8443/?token=<same token>');
});
