/* REGIMEN app — Express routes, state, push, and scheduler tick.
   Exported for local server.js and Vercel serverless. */
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const storage = require('./storage');
const { requireToken, assertSafePushEndpoint } = require('./security');
const voice = require('./voice');

const MAX_SUBS = 20;

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hhmm = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000);

async function createApp() {
  const { DATA } = config;

  const REGIMEN_FILE = path.join(DATA, 'regimen.json');
  if (!storage.IS_VERCEL && !fs.existsSync(REGIMEN_FILE)) {
    const example = path.join(__dirname, 'data', 'regimen.example.json');
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, REGIMEN_FILE);
      console.log('Seeded data/regimen.json from the example routine — edit it to make it yours.');
    }
  }
  if (storage.IS_VERCEL && !(await storage.exists('regimen.json', DATA))) {
    const example = path.join(__dirname, 'data', 'regimen.example.json');
    if (fs.existsSync(example)) {
      await storage.copyFile(example, 'regimen.json', DATA);
      console.log('Seeded regimen from the example routine in Vercel KV.');
    }
  }

  let regimen = await storage.readJson('regimen.json', { blocks: [], maintenance: [], mantras: [], waterTarget: 8, waterNudges: [] }, DATA);
  let state = await storage.readJson('state.json', null, DATA) || {
    date: null, checks: {}, water: 0, streak: 0, best: 0,
    history: [], maintDone: {}, fired: {}
  };
  let subs = await storage.readJson('subs.json', [], DATA);

  let vapid = await storage.readJson('vapid.json', null, DATA);
  if (!vapid) {
    if (subs.length) {
      console.error(
        'VAPID keys missing or unreadable, but subs holds ' + subs.length +
        ' subscription(s). Regenerating and clearing — re-arm reminders from the installed app.'
      );
      subs = [];
      await storage.writeJson('subs.json', subs, DATA);
    }
    vapid = webpush.generateVAPIDKeys();
    await storage.writeJson('vapid.json', vapid, DATA);
  }

  const PUSH_ENABLED = Boolean(config.CONTACT);
  if (PUSH_ENABLED) {
    webpush.setVapidDetails(config.CONTACT, vapid.publicKey, vapid.privateKey);
  } else if (!storage.IS_VERCEL) {
    console.warn(
      'REGIMEN_CONTACT is not set, so Web Push is disabled. Set it to a real ' +
      'mailto: or https: URL you control (see .env.example) to arm reminders.'
    );
  }

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

  async function rolloverIfNeeded() {
    const today = todayStr();
    if (state.date === today) return;
    if (state.date) {
      const gap = daysBetween(state.date, today);
      if (gap <= 0) {
        state.date = today;
        await storage.writeJson('state.json', state, DATA);
        return;
      }
      const pct = completionPct(state.checks);
      state.history.push({ date: state.date, pct, water: state.water });
      for (let i = 1; i < gap; i++) {
        const d = new Date(state.date + 'T00:00');
        d.setDate(d.getDate() + i);
        state.history.push({ date: fmtDate(d), pct: 0, water: 0 });
      }
      if (state.history.length > 90) state.history = state.history.slice(-90);
      state.streak = gap === 1 && pct >= 80 ? state.streak + 1 : 0;
      if (state.streak > state.best) state.best = state.streak;
    }
    state.date = today;
    state.checks = {};
    state.water = 0;
    state.fired = {};
    await storage.writeJson('state.json', state, DATA);
  }

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
      const diff = daysBetween(today, due);
      return { ...m, lastDone: last, due, daysLeft: Math.max(0, diff), overdue: diff < 0 };
    });
  }

  async function push(title, body, tag) {
    if (!PUSH_ENABLED) return;
    const payload = JSON.stringify({ title, body, tag });
    const dead = [];
    await Promise.all(subs.map(async (s) => {
      try { await webpush.sendNotification(s, payload); }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
        else console.error('push failed', e.statusCode);
      }
    }));
    if (dead.length) {
      subs = subs.filter(s => !dead.includes(s.endpoint));
      await storage.writeJson('subs.json', subs, DATA);
    }
  }

  const CATCHUP_MIN = 90;
  const toMinutes = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  };
  const minutesLate = (time, now) => toMinutes(now) - toMinutes(time);
  const isDue = (time, now) => {
    const late = minutesLate(time, now);
    return late >= 0 && late <= CATCHUP_MIN;
  };

  async function tick() {
    await rolloverIfNeeded();
    const now = hhmm();
    let dirty = false;
    for (const t of allTasks()) {
      if (isDue(t.time, now) && !state.fired[t.id] && !state.checks[t.id]) {
        state.fired[t.id] = true;
        dirty = true;
        push(t.title, t.detail || 'On the regimen. Handle it.', t.id).catch(console.error);
      }
    }
    for (const n of regimen.waterNudges || []) {
      const key = 'water_' + n;
      if (isDue(n, now) && !state.fired[key] && state.water < regimen.waterTarget) {
        state.fired[key] = true;
        dirty = true;
        push('Water check', `${state.water}/${regimen.waterTarget} glasses. Drink one now.`, key).catch(console.error);
      }
    }
    for (const m of maintView()) {
      const key = 'maint_' + m.id;
      if ((m.due === todayStr() || m.overdue) && isDue(m.time, now) && !state.fired[key]) {
        state.fired[key] = true;
        dirty = true;
        push(m.title, m.detail || 'Maintenance due today.', key).catch(console.error);
      }
    }
    if (dirty) await storage.writeJson('state.json', state, DATA);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', requireToken(config.TOKEN));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/state', async (req, res) => {
    await rolloverIfNeeded();
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
      history: state.history.slice(-14),
      voiceEnabled: config.VOICE_ENABLED,
      pushEnabled: PUSH_ENABLED,
    });
  });

  app.post('/api/check', async (req, res) => {
    await rolloverIfNeeded();
    const { id, done } = req.body || {};
    if (allTasks().some(t => t.id === id)) {
      state.checks[id] = !!done;
      await storage.writeJson('state.json', state, DATA);
    }
    res.json({ ok: true, momentum: completionPct(state.checks) });
  });

  app.post('/api/maint', async (req, res) => {
    await rolloverIfNeeded();
    const { id, done } = req.body || {};
    if (regimen.maintenance.some(m => m.id === id)) {
      if (done) state.maintDone[id] = todayStr();
      else delete state.maintDone[id];
      await storage.writeJson('state.json', state, DATA);
    }
    res.json({ ok: true });
  });

  app.post('/api/water', async (req, res) => {
    await rolloverIfNeeded();
    const delta = Number((req.body || {}).delta) || 0;
    state.water = Math.max(0, Math.min(regimen.waterTarget, state.water + delta));
    await storage.writeJson('state.json', state, DATA);
    res.json({ ok: true, water: state.water });
  });

  app.get('/api/vapid', (req, res) =>
    res.json({ key: vapid.publicKey, pushEnabled: PUSH_ENABLED }));

  app.post('/api/subscribe', async (req, res) => {
    const sub = req.body;
    try {
      assertSafePushEndpoint(sub && sub.endpoint);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    if (!subs.some(s => s.endpoint === sub.endpoint)) {
      if (subs.length >= MAX_SUBS) subs.shift();
      subs.push({ endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: sub.keys });
      await storage.writeJson('subs.json', subs, DATA);
    }
    res.json({ ok: true, count: subs.length });
  });

  app.post('/api/voice',
    express.raw({
      limit: '30mb',
      type: (req) => {
        const t = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        return t.startsWith('audio/') || t === 'application/octet-stream';
      },
    }),
    async (req, res) => {
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

  return { app, tick, config };
}

module.exports = { createApp };
