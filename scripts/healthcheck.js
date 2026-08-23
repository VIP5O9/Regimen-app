#!/usr/bin/env node
/* REGIMEN readiness check.
   Waits for the server to accept connections, then prints a single clear
   banner stating whether Web Push is armed. Meant to run alongside the server
   (see .cursor/environment.json) so a fresh agent shows at a glance whether
   reminders will actually fire. No dependencies; reuses the app's own config
   so PORT/HOST/token/contact never drift from what the server uses. */
const net = require('net');
const config = require('./../config');

const { PORT, HOST, CONTACT, TOKEN } = config;
// 0.0.0.0 / :: are bind-only addresses; dial loopback to probe them.
const DIAL_HOST = HOST === '0.0.0.0' || HOST === '::' || !HOST ? '127.0.0.1' : HOST;

const TIMEOUT_MS = Number(process.env.REGIMEN_HEALTHCHECK_TIMEOUT_MS) || 30000;
const INTERVAL_MS = 500;

function probeOnce() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: DIAL_HOST, port: PORT });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(INTERVAL_MS, () => done(false));
  });
}

async function waitForListening(deadline) {
  while (Date.now() < deadline) {
    if (await probeOnce()) return true;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  return false;
}

(async () => {
  const deadline = Date.now() + TIMEOUT_MS;
  const up = await waitForListening(deadline);

  const line = '─'.repeat(64);
  console.log('\n' + line);
  if (!up) {
    console.error(`REGIMEN readiness: FAILED — nothing listening on ${DIAL_HOST}:${PORT} after ${Math.round(TIMEOUT_MS / 1000)}s.`);
    console.error('The server terminal (regimen-server) may still be starting or has crashed — check its log.');
    console.log(line + '\n');
    process.exit(1);
  }

  const pushArmed = Boolean(CONTACT);
  console.log(`REGIMEN READY  →  http://localhost:${PORT}  (listening on ${HOST}:${PORT})`);
  if (pushArmed) {
    console.log(`Web Push: ARMED  (REGIMEN_CONTACT=${CONTACT})`);
    console.log('Reminders will fire. Install the PWA over HTTPS and tap Arm to subscribe a device.');
  } else {
    console.log('Web Push: DISABLED  (REGIMEN_CONTACT is not set)');
    console.log('Reminders will NOT fire. Set REGIMEN_CONTACT (a real mailto: or https: URL) as a');
    console.log('secret to arm push — add it in the Secrets panel; it is injected as an env var.');
  }
  console.log(`Sign-in URL (saves the token, then drops it):`);
  console.log(`  http://localhost:${PORT}/?token=${TOKEN}`);
  console.log(line + '\n');
  process.exit(0);
})();
