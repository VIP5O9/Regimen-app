/* Vercel Cron — fires reminder checks every minute.
   Vercel sends Authorization: Bearer <CRON_SECRET> on each invocation. */
const { createApp } = require('../../app');

let ready = null;

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  if (!ready) ready = createApp();
  const { tick } = await ready;
  await tick();
  res.json({ ok: true, at: new Date().toISOString() });
};
