/* REGIMEN storage — local files on disk, Upstash Redis on Vercel.
   Every JSON blob the server owns (state, subs, keys) goes through here
   so the same app code runs self-hosted and on Vercel. */
const fs = require('fs');
const path = require('path');

const IS_VERCEL = Boolean(process.env.VERCEL);
let redis = null;

function getRedis() {
  if (!redis) {
    const { Redis } = require('@upstash/redis');
    redis = Redis.fromEnv();
  }
  return redis;
}

const keyFor = (file) => `regimen:${file.replace(/\.json$/, '')}`;

async function readJson(file, fallback, dataDir) {
  if (IS_VERCEL) {
    const val = await getRedis().get(keyFor(file));
    return val ?? fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, obj, dataDir) {
  if (IS_VERCEL) {
    await getRedis().set(keyFor(file), obj);
    return;
  }
  const dest = path.join(dataDir, file);
  try {
    fs.writeFileSync(dest + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(dest + '.tmp', dest);
  } catch (e) {
    console.error('write failed', file, e.message);
  }
}

async function exists(file, dataDir) {
  if (IS_VERCEL) {
    const val = await getRedis().get(keyFor(file));
    return val != null;
  }
  return fs.existsSync(path.join(dataDir, file));
}

async function copyFile(src, destFile, dataDir) {
  if (IS_VERCEL) {
    const val = JSON.parse(fs.readFileSync(src, 'utf8'));
    await writeJson(destFile, val, dataDir);
    return;
  }
  fs.copyFileSync(src, path.join(dataDir, destFile));
}

module.exports = { readJson, writeJson, exists, copyFile, IS_VERCEL };
