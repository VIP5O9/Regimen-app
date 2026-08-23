/* REGIMEN local server — persistent process with an in-process scheduler.
   On Vercel, api/index.js and api/cron/tick.js take over instead. */
const { createApp } = require('./app');

const { PORT, HOST } = require('./config');

(async () => {
  const { app, tick } = await createApp();
  setInterval(() => tick().catch(console.error), 30000);
  process.on('unhandledRejection', (e) => console.error('unhandled', e));
  tick().catch(console.error);

  app.listen(PORT, HOST, () => {
    const config = require('./config');
    console.log(`REGIMEN up on http://localhost:${PORT} (bound ${HOST})`);
    console.log('');
    console.log('  Open this once per device — it saves the token, then drops it from the URL:');
    console.log(`  http://localhost:${PORT}/?token=${config.TOKEN}`);
    console.log('');
    console.log('  Over Tailscale, swap the host: https://<machine>:8443/?token=<same token>');
  });
})();
