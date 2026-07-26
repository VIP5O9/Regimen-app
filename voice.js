/* REGIMEN voice memos — audio in, Obsidian note out.
   The PWA posts a recording; we drop the audio plus a sibling markdown note
   into the vault's Voice Inbox, answer immediately, then transcribe in the
   background and rewrite the note body. Nothing outside Voice Inbox is ever
   touched, and every file we write is one we just named ourselves. */
const fs = require('fs');
const path = require('path');

// Defaults to data/voice-inbox inside the app. Set REGIMEN_VOICE_DIR to write
// straight into an Obsidian vault (or anywhere else) instead — see .env.example.
const config = require('./config');
const VOICE_DIR = config.VOICE_DIR;

// ~150MB of whisper weights land here on first use — gitignored, persistent.
const MODEL_DIR = path.join(config.DATA, 'models');
const MODEL = 'Xenova/whisper-base.en';
const TARGET_RATE = 16000; // whisper's only input rate

const EXT_BY_MIME = {
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/mpeg': '.mp3',
};

const pad = (n) => String(n).padStart(2, '0');

/** `2026-07-25 0630` — the human-sortable stem every pair of files shares. */
function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Local ISO with offset, so the note reads in the timezone it was spoken in. */
function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function noteBody(audioName, status, text) {
  return `---\ncreated: ${status.created}\nsource: REGIMEN\nstatus: ${status.status}\n---\n\n` +
    `![[${audioName}]]\n\n${text}\n`;
}

/* ---------- WAV → mono Float32 @ 16 kHz ---------- */
/* Hand-parsed: the client sends a WAV we encoded ourselves, and SAPI/other
   recorders still only need plain PCM. Avoids a dependency for ~40 lines. */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt = null, data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
      if (size === 0 || body + size > buf.length) data = buf.subarray(body); // streamed/truncated header
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');

  const ch = Math.max(1, fmt.channels);
  let frames, read;
  if (fmt.bits === 16 && (fmt.format === 1 || fmt.format === 0xFFFE)) {
    frames = Math.floor(data.length / (2 * ch));
    read = (i) => data.readInt16LE(i * 2) / 32768;
  } else if (fmt.bits === 32 && fmt.format === 3) {
    frames = Math.floor(data.length / (4 * ch));
    read = (i) => data.readFloatLE(i * 4);
  } else {
    throw new Error(`unsupported WAV encoding: format ${fmt.format}, ${fmt.bits}-bit`);
  }

  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) sum += read(f * ch + c);
    mono[f] = sum / ch;
  }
  return { samples: mono, rate: fmt.rate };
}

/** Linear resample. Good enough for speech at these ratios, and dependency-free. */
function resample(samples, from, to) {
  if (from === to || samples.length === 0) return samples;
  const out = new Float32Array(Math.max(1, Math.round(samples.length * to / from)));
  const step = (samples.length - 1) / (out.length - 1 || 1);
  for (let i = 0; i < out.length; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = samples[j];
    const b = j + 1 < samples.length ? samples[j + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/* ---------- transcription ---------- */
let transcriberPromise = null;
async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      fs.mkdirSync(MODEL_DIR, { recursive: true });
      env.cacheDir = MODEL_DIR;
      env.allowLocalModels = false; // weights come from the cache dir above, not ./models
      return pipeline('automatic-speech-recognition', MODEL);
    })().catch((e) => { transcriberPromise = null; throw e; }); // let a later memo retry
  }
  return transcriberPromise;
}

// One memo at a time: whisper is CPU-bound and two at once just thrash.
let queue = Promise.resolve();
const enqueue = (job) => { queue = queue.then(job, job); return queue; };

async function transcribeWav(buf) {
  const { samples, rate } = parseWav(buf);
  const audio = resample(samples, rate, TARGET_RATE);
  if (audio.length < TARGET_RATE / 10) throw new Error('recording too short');
  const transcriber = await getTranscriber();
  const out = await transcriber(audio, { chunk_length_s: 30, stride_length_s: 5 });
  const text = String(out.text || '').trim();
  if (!text) throw new Error('no speech detected');
  return text;
}

/* ---------- vault I/O ---------- */
/** Reserve a free `<stem> idea` pair, appending -2, -3… on collision. */
function reserve(dir, base, ext) {
  for (let n = 1; n < 500; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!fs.existsSync(path.join(dir, name + ext)) && !fs.existsSync(path.join(dir, name + '.md'))) {
      return name;
    }
  }
  throw new Error('too many recordings this minute');
}

/**
 * Write the audio + a placeholder note. Returns the paths the caller needs to
 * finish the job, plus whether we can transcribe this format at all.
 */
function saveRecording(buf, contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[mime] || '.bin';
  const now = new Date();
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const name = reserve(VOICE_DIR, `${stamp(now)} idea`, ext);
  const audioName = name + ext;
  const noteName = name + '.md';
  const created = isoLocal(now);

  fs.writeFileSync(path.join(VOICE_DIR, audioName), buf);
  const isWav = ext === '.wav';
  fs.writeFileSync(
    path.join(VOICE_DIR, noteName),
    noteBody(audioName, { created, status: isWav ? 'transcribing' : 'audio-only' },
      isWav ? 'Transcribing…' : 'Audio saved. This format is not transcribed.')
  );
  return { audioName, noteName, created, isWav, buf };
}

/** Transcribe in the background and rewrite the note. Never rejects. */
function transcribeLater(saved) {
  if (!saved.isWav) return Promise.resolve();
  return enqueue(async () => {
    let status = 'done', body;
    try {
      body = await transcribeWav(saved.buf);
    } catch (e) {
      status = 'audio-only';
      body = `Transcription failed: ${e.message}. The audio above is intact.`;
      console.error('voice transcription failed', saved.noteName, e.message);
    }
    try {
      fs.writeFileSync(
        path.join(VOICE_DIR, saved.noteName),
        noteBody(saved.audioName, { created: saved.created, status }, body)
      );
    } catch (e) {
      console.error('voice note rewrite failed', saved.noteName, e.message);
    }
  });
}

module.exports = { saveRecording, transcribeLater, VOICE_DIR, parseWav, resample };
