/* REGIMEN security — the two checks that stand between the API and the network.

   1. requireToken: the API checks off tasks, writes audio files to disk and
      sends push. It is never open. Static shell files stay public because you
      have to load the page before you can present a token.
   2. assertSafePushEndpoint: /api/subscribe hands its endpoint URL straight to
      web-push, which then POSTs to it. Without this check anyone who can reach
      the server can aim those requests at localhost or a cloud metadata
      service — a plain SSRF relay. */
const crypto = require('crypto');
const net = require('net');

/** Constant-time compare that tolerates length mismatch. */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Hash first: timingSafeEqual throws on unequal lengths, and the length
  // itself would otherwise leak through the early return.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Bearer header first, `?token=` second — the service worker can only do the latter. */
function presentedToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (typeof req.query.token === 'string') return req.query.token;
  return '';
}

const requireToken = (expected) => (req, res, next) => {
  if (tokenMatches(presentedToken(req), expected)) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
};

/* ---------- push endpoint validation ---------- */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

/** Private, loopback, link-local and unique-local ranges — the SSRF targets. */
function isPrivateAddress(host) {
  // URL.hostname hands back IPv6 literals bracketed ("[::1]"), and net.isIP
  // scores those a 0 — which read as "not an IP" and waved loopback straight
  // through. Strip them before anything else looks at the value.
  host = String(host || '').replace(/^\[|\]$/g, '');
  const v = net.isIP(host);
  if (v === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||        // AWS/GCP/Azure metadata lives here
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  if (v === 6) {
    const h = host.toLowerCase();
    return h === '::' || h === '::1' ||
      h.startsWith('fc') || h.startsWith('fd') ||   // unique-local
      h.startsWith('fe80') ||                        // link-local
      h.startsWith('::ffff:');                       // IPv4-mapped, re-check as v4
  }
  return false;
}

/**
 * Throws unless `endpoint` is a plausible push-service URL. Hostname-level
 * only: a DNS name that resolves to a private IP still gets through, which is
 * why the token gate above is the primary control, not this.
 */
function assertSafePushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) {
    throw new Error('endpoint must be a URL string under 2048 characters');
  }
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('endpoint is not a valid URL'); }
  if (url.protocol !== 'https:') throw new Error('endpoint must be https');
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    throw new Error('endpoint may not point at this machine');
  }
  if (isPrivateAddress(host)) throw new Error('endpoint may not point at a private address');
  return url;
}

module.exports = { requireToken, tokenMatches, assertSafePushEndpoint, isPrivateAddress };
