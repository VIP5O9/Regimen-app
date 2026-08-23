# REGIMEN

A self-hosted daily-routine app. Hygiene, water, meds, grooming upkeep, streaks.
Runs on your own machine, installs to your phone's home screen, and pushes
reminders to your wrist.

No account. No cloud. No telemetry. Your routine and your history are files on
your disk, and the only thing that ever leaves the box is a push notification.

Design: **Midnight Editorial** — ink black, serif headlines, amber momentum arc.

---

## Deploy on Vercel

REGIMEN runs on Vercel with HTTPS out of the box — ideal for installing the PWA
on your phone and arming push reminders without Tailscale or a tunnel.

### One-time setup

1. **Fork or import** this repo into [Vercel](https://vercel.com/new).
2. **Add Upstash Redis** from the [Vercel Marketplace](https://vercel.com/marketplace?category=storage&search=redis) and connect it to your project. This injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. **Set environment variables** in Project Settings → Environment Variables:

| Variable | Required | What it does |
|----------|----------|--------------|
| `REGIMEN_TOKEN` | **Yes** | API access token (16+ characters). Open `https://<your-app>.vercel.app/?token=<value>` once per device. |
| `REGIMEN_CONTACT` | For push | VAPID subject — `mailto:you@example.com` or `https://yoursite.com`. |
| `CRON_SECRET` | Auto | Vercel sets this when cron jobs are enabled. |

4. **Deploy.** Vercel runs a cron job every minute to fire reminders (replaces the local `setInterval` scheduler).

### Vercel vs self-hosted

| Feature | Self-hosted | Vercel |
|---------|-------------|--------|
| HTTPS | You provide (Tailscale, tunnel, etc.) | Built-in |
| Storage | `data/*.json` on disk | Upstash Redis |
| Reminders | In-process scheduler | Vercel Cron (every minute) |
| Voice memos | Full whisper transcription | Disabled (model too large for serverless) |
| Data location | Your machine | Upstash region you choose |

Voice memos and local whisper transcription remain available when you run `npm start` on your own machine.

---

## Quick start (self-hosted)

Needs [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/VIP5O9/Regimen-app.git
cd Regimen-app
npm install
npm start
```

The server prints a sign-in URL with an access token in it:

```
http://localhost:3117/?token=xxxxxxxxxxxxxxxxxxxxxxxx
```

Open that once. The token is saved in the browser and dropped from the address
bar; every visit after that is just `http://localhost:3117`.

On first run it copies `data/regimen.example.json` to `data/regimen.json` — that
copy is yours, it's gitignored, and it never gets committed.

---

## Make it yours

Edit `data/regimen.json` and restart.

| Key | What it controls |
|-----|------------------|
| `blocks[].tasks[]` | The checklist. `time` is `HH:MM` (24h) and fires the reminder. `core: true` counts double toward daily momentum. |
| `maintenance[]` | Recurring upkeep. `intervalDays` + `anchor` (`YYYY-MM-DD`) set the due date; `time` fires on due/overdue days. |
| `waterNudges` | Times that nag you if you're under `waterTarget`. |
| `mantras` | One rotates in per day, by date index. |

Task ids must be unique — they key the daily state and the fired-once guard.

---

## Configuration

Everything is optional. Copy `.env.example` to `.env` and uncomment what you need.

| Variable | Default | What it does |
|----------|---------|--------------|
| `REGIMEN_CONTACT` | *unset* | VAPID subject for Web Push. **Push is off until you set this.** Must be a real `mailto:` or `https:` URL you control — Apple 403s on anything else. |
| `REGIMEN_TOKEN` | auto | API access token. Unset means a random one is generated into `data/token.json` and printed at startup. |
| `PORT` | `3117` | HTTP port. |
| `REGIMEN_HOST` | `0.0.0.0` | Bind address. Set `127.0.0.1` for loopback only. |
| `REGIMEN_VOICE_DIR` | `data/voice-inbox` | Where voice memos are written. Point at an Obsidian vault to file them there. |
| `REGIMEN_VOICE` | on | `off` disables voice memos entirely. |
| `REGIMEN_DATA_DIR` | `./data` | Where state, tokens and keys live. |

---

## Phone install + push reminders

Two things are non-negotiable here:

1. **HTTPS.** Service workers and Web Push refuse to run over plain `http`
   (`localhost` is the one exception, and only on the machine itself).
2. **`REGIMEN_CONTACT` must be set**, or push stays disabled and the app says so
   instead of silently swallowing your 7am reminder.

Getting HTTPS to your phone is your choice — [Tailscale](https://tailscale.com)
(§ below), Cloudflare Tunnel, ngrok, or a reverse proxy with a real certificate.
Once you have an HTTPS URL:

1. Open `https://<your-host>/?token=<your token>` in **Safari** (iOS) or Chrome.
2. **Share → Add to Home Screen.**
3. Close the browser. Open REGIMEN **from the home screen icon** — push only
   works from the installed app.
4. Tap **Arm** in the bottom dock and allow notifications.
5. A test push lands within seconds. It mirrors to Apple Watch automatically.

Push rides the platform's push relay, so reminders still arrive when the phone
is off your network. You only need the tunnel to open the app itself.

---

## Security

This app checks off tasks, writes files to disk and sends push notifications, so
the API is **never open**:

- **Every `/api/*` route requires a bearer token.** Reads included — the state
  response is a log of your day. Only the static shell is public, since you have
  to load the page before you can present a token.
- **Push endpoints are validated** before being stored. `/api/subscribe` hands
  its URL to a library that then POSTs to it, so endpoints pointing at
  `localhost`, private ranges, or cloud metadata addresses (`169.254.169.254`)
  are rejected — otherwise the server is an SSRF relay.
- **Token comparison is constant-time** and length-blind.
- **Voice memos default to a directory inside the app**, not somewhere on your
  filesystem you didn't ask for. Filenames are always server-generated.

The default bind is `0.0.0.0` because WSL's localhost relay mirrors address
family and a `::`-bound listener is unreachable from Windows at `127.0.0.1`. The
token is what makes that safe. Set `REGIMEN_HOST=127.0.0.1` if you don't need it.

Run the security tests with `npm test`.

**Found a hole?** Open an issue — or email privately if it's serious.

---

## What stays private

Never committed, all gitignored:

| File | Contents |
|------|----------|
| `data/regimen.json` | Your routine — meds, grooming, times |
| `data/state.json` | Today plus 90 days of history |
| `data/subs.json` | Push subscriptions |
| `data/vapid.json` | Push keypair |
| `data/token.json` | API access token |
| `data/voice-inbox/` | Recordings and transcripts |
| `.env` | Your configuration |

Keep push payload text non-sensitive — it passes through Apple's or Google's
relay to reach the phone.

---

## Voice memos

Tap **Voice** in the dock, record, tap again. The audio and a markdown note land
in `REGIMEN_VOICE_DIR` as `YYYY-MM-DD HHmm idea.wav` + `.md`. The note comes back
instantly with `status: transcribing`, then rewrites itself with the transcript
and `status: done` once whisper finishes (~1s per 4s of audio).

**How it works.** The browser records with MediaRecorder, decodes the blob,
downmixes to mono, resamples to 16 kHz and encodes 16-bit PCM WAV in JS, then
POSTs it. The server parses that WAV by hand — no audio codec, no ffmpeg — and
runs `Xenova/whisper-base.en` through `@xenova/transformers` on CPU.
Transcriptions run one at a time.

If the browser can't decode its own recording, the original blob is uploaded
as-is and stored with `status: audio-only`. The idea survives either way.

**The mic needs a secure origin** — https or localhost. Safari will not hand out
`getUserMedia` over plain http.

**First run downloads ~76MB** of quantized whisper weights to `data/models/`
(gitignored, persistent). After that it's local and offline.

Set `REGIMEN_VOICE=off` if you don't want any of this.

---

## Running it always-on (optional)

This is one way to run it permanently — Windows host, server in WSL, exposed
over Tailscale. Adapt or ignore.

**Tailscale HTTPS:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-tailscale.ps1
```

Serves `https://<machine>:8443` → `localhost:3117`. Both ports are overridable:
`-LocalPort 3117 -HttpsPort 443`. Find your machine name with `tailscale status`.

If `tailscale serve` complains that a port is in use, a zombie `tailscaled` may
be holding it — `Restart-Service Tailscale` from an elevated prompt, then retry.

**Autostart in WSL:**

```
Startup\regimen.vbs  →  scripts\start-regimen-wsl.cmd  →  scripts\start-wsl.sh
```

`start-wsl.sh` detaches with `setsid` (plain `nohup` gets reaped when the
`wsl.exe` session exits) and polls the listener before reporting. Both scripts
derive their paths from their own location, so the repo can live anywhere. Set
`REGIMEN_WSL_DISTRO` if your distro isn't the WSL default. To disable autostart,
delete `regimen.vbs` from the Startup folder.

**Rebuilding `node_modules` for WSL.** `sharp` (a transformers.js dependency)
needs Linux binaries when the server runs in WSL but `npm install` ran on
Windows. From WSL:

```bash
cd <repo>/node_modules/sharp
node ../prebuild-install/bin.js --runtime=napi --target=7
node install/libvips
```

---

## Roadmap

- **Workout module:** plans, set/rep logging, rest timers with push.
- **Backup:** encrypted export of `regimen.json` + history.

---

## License

MIT — see [LICENSE](LICENSE).
