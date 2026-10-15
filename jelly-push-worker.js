// Jelly Critters push sender: a tiny Cloudflare Worker (free plan is plenty).
// It sends notifications to players whose game is closed: new messages, 1v1 challenges,
// friend requests and the developer's update posts.
//
// Settings (Cloudflare dashboard → your worker → Settings → Variables and Secrets):
//   VAPID_PRIVATE   (Secret)  the private key JSON you were given. Never share it.
//   FIREBASE_PROJECT (Text)   your Firebase project id, e.g. jelly-critters
//   ADMIN_EMAIL      (Text)   test@gmail.com
//   ALLOW_ORIGIN     (Text)   https://catatwar.github.io
//   VAPID_SUBJECT    (Text)   mailto:you@example.com   (any address you own)
//
// Made By Cat At War.

const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const enc = new TextEncoder();
const b64u = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

// ---------- VAPID (who is sending)
let vapid = null;
async function vapidKeys(env) {
  if (vapid) return vapid;
  const jwk = JSON.parse(env.VAPID_PRIVATE);
  const priv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const pub = b64u(cat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
  return (vapid = { priv, pub });
}
async function vapidAuth(endpoint, env) {
  const { priv, pub } = await vapidKeys(env);
  const aud = new URL(endpoint).origin, exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp, sub: env.VAPID_SUBJECT || 'mailto:jelly@example.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pub}`;
}

// ---------- message encryption (RFC 8291, aes128gcm)
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function encryptPayload(text, p256dh, auth) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const as = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(secret, shared, cat(enc.encode('WebPush: info\0'), ua, as), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return cat(salt, rs, new Uint8Array([as.length]), as, ct);
}
async function sendOne(sub, payload, env) {
  let u; try { u = new URL(sub.endpoint); } catch (e) { return { ok: false, gone: true }; }
  const testHost = env.TEST_ALLOW_HOST && u.host === env.TEST_ALLOW_HOST;
  if ((u.protocol !== 'https:' && !testHost) || (!testHost && !PUSH_HOSTS.some(r => r.test(u.hostname)))) return { ok: false, gone: true };
  if (!sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { ok: false, gone: true };
  const body = await encryptPayload(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  const r = await fetch(sub.endpoint, { method: 'POST', body, headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: await vapidAuth(sub.endpoint, env) } });
  return { ok: r.status >= 200 && r.status < 300, gone: r.status === 404 || r.status === 410, status: r.status };
}

// ---------- who is asking (Firebase sign-in token)
let jwks = null, jwksAt = 0;
async function googleKeys(env) {
  if (env.TEST_JWKS) return JSON.parse(env.TEST_JWKS).keys;
  if (jwks && Date.now() - jwksAt < 3600e3) return jwks;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  jwks = (await r.json()).keys; jwksAt = Date.now(); return jwks;
}
async function verifyToken(tok, env) {
  const parts = String(tok || '').split('.'); if (parts.length !== 3) return null;
  let head, claims; try { head = JSON.parse(new TextDecoder().decode(unb64u(parts[0]))); claims = JSON.parse(new TextDecoder().decode(unb64u(parts[1]))); } catch (e) { return null; }
  if (head.alg !== 'RS256') return null;
  const jwk = (await googleKeys(env)).find(k => k.kid === head.kid); if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  const now = Math.floor(Date.now() / 1000), proj = env.FIREBASE_PROJECT;
  if (!ok || claims.aud !== proj || claims.iss !== 'https://securetoken.google.com/' + proj || !(claims.exp > now) || !(claims.iat <= now + 300) || !claims.sub) return null;
  return { uid: claims.sub, email: String(claims.email || '').toLowerCase() };
}

// ---------- a little spam protection (per worker instance)
const recent = new Map();
function limited(uid, n) { const now = Date.now(), a = (recent.get(uid) || []).filter(t => now - t < 60e3); if (a.length + n > 40) return true; for (let i = 0; i < n; i++) a.push(now); recent.set(uid, a); return false; }

function message(kind, b, admin) {
  const name = clip(b.name, 16) || 'Someone';
  if (kind === 'dm') return { title: name, body: clip(b.text, 90) || 'sent you a message', tag: 'dm-' + clip(b.from, 40) };
  if (kind === 'duel') return { title: 'New 1v1 challenge!', body: `${name} challenged you to ${clip(b.text, 40) || 'a 1v1'}. Open the game to accept.`, tag: 'duel' };
  if (kind === 'fr') return { title: 'Friend request', body: `${name} wants to be friends`, tag: 'fr-' + clip(b.from, 40) };
  if (kind === 'update' && admin) return { title: clip(b.title, 60) || 'New update', body: clip(b.text, 140) || 'Something new just landed in Jelly Critters.', tag: 'update' };
  if (kind === 'test') return { title: 'Notifications are on!', body: 'This is what a Jelly Critters notification looks like.', tag: 'test' };
  return null;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allow = (env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = { 'Access-Control-Allow-Origin': allow.includes(origin) ? origin : (allow[0] || '*'), 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
    const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'GET' && (path === '/key' || path === '')) return out({ key: (await vapidKeys(env)).pub, ok: true });
      if (req.method !== 'POST' || path !== '/send') return out({ error: 'not found' }, 404);
      if (allow.length && origin && !allow.includes(origin)) return out({ error: 'origin' }, 403);
      const me = await verifyToken((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), env);
      if (!me) return out({ error: 'sign in' }, 401);
      const b = await req.json().catch(() => ({}));
      const admin = !!env.ADMIN_EMAIL && me.email === env.ADMIN_EMAIL.toLowerCase();
      const subs = (Array.isArray(b.subs) ? b.subs : []).filter(s => s && typeof s.endpoint === 'string').slice(0, admin ? 500 : 3);
      const kind = String(b.kind || '');
      if (!subs.length) return out({ error: 'no subscriptions' }, 400);
      if ((kind === 'update' || subs.length > 3) && !admin) return out({ error: 'not allowed' }, 403);
      if (!admin && limited(me.uid, subs.length)) return out({ error: 'slow down' }, 429);
      const msg = message(kind, Object.assign({}, b, { from: me.uid }), admin);
      if (!msg) return out({ error: 'unknown kind' }, 400);
      msg.url = './'; msg.kind = kind; msg.t = Date.now();
      const res = await Promise.all(subs.map(s => sendOne(s, msg, env).catch(() => ({ ok: false }))));
      return out({ ok: true, sent: res.filter(r => r.ok).length, gone: subs.filter((s, i) => res[i].gone).map(s => s.endpoint) });
    } catch (e) { return out({ error: 'server', detail: String(e && e.message || e).slice(0, 120) }, 500); }
  }
};
