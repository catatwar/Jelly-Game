// Jelly Critters Discord bot (Made By Cat At War). Runs on GitHub Actions: free, nothing to host.
//
// The game, signed in as the dev account, drops each post into the database at botq/ (only test@gmail.com
// can write there) and starts this workflow. This script posts everything waiting there as the bot, deletes it,
// writes how it went to botstat/ (the game shows that), and exits. Posts older than 3 days are skipped.
// Channel and role settings come from devcfg/discord, which you fill in from the game's Discord box.
//
// No packages needed: just Node 22.

import crypto from 'node:crypto';

const DB = (process.env.FIREBASE_DB_URL || 'https://jellygame-6408f-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const API = process.env.DISCORD_API || 'https://discord.com/api/v10';
const GATEWAY = process.env.DISCORD_GATEWAY || 'wss://gateway.discord.gg/?v=10&encoding=json';
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const SITE = 'https://catatwar.github.io/Jelly-Game/';
const ICON = SITE + 'icon-192.png';
const MAX_AGE = 3 * 24 * 60 * 60 * 1000;
const BY_HAND = process.env.GITHUB_EVENT_NAME !== 'schedule'; // started from the game (not the 15-minute backup)
const wait = ms => new Promise(r => setTimeout(r, ms));

const TYPES = {
  upd:  { name: 'Game updates',  back: null,  button: 'Play the update' },
  gw:   { name: 'Giveaways',     back: 'upd', button: 'Enter in the game' },
  ann:  { name: 'Announcements', back: 'upd', button: 'Play Jelly Critters' },
  tour: { name: 'Tournaments',   back: 'ann', button: 'Play Jelly Critters' },
};

function stop(msg) { console.log('::error::' + msg); process.exit(BY_HAND ? 1 : 0); }

// ------------------------------------------------------------------ Firebase (REST, signed in with the service account key)
function loadKey() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) stop('Add the FIREBASE_SERVICE_ACCOUNT secret (repo Settings → Secrets and variables → Actions).');
  let k;
  try { k = JSON.parse(raw); } catch (e) { stop('FIREBASE_SERVICE_ACCOUNT isn’t valid. Paste the whole key file, from { to }.'); }
  if (!k.client_email || !k.private_key) stop('FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key. Paste the whole key file.');
  k.private_key = k.private_key.replace(/\\n/g, '\n');
  return k;
}
async function googleToken(k) {
  const now = Math.floor(Date.now() / 1000), aud = k.token_uri || 'https://oauth2.googleapis.com/token';
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: k.client_email, aud, iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
  });
  const jwt = unsigned + '.' + crypto.sign('RSA-SHA256', Buffer.from(unsigned), k.private_key).toString('base64url');
  const r = await fetch(aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) stop('Google refused the Firebase key (' + (j.error_description || j.error || r.status) + '). Make a new key and paste it into the secret again.');
  return j.access_token;
}
let GT = '';
async function fb(method, path, value) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(GT)}`, {
    method, headers: value === undefined ? {} : { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Database ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const TS = { '.sv': 'timestamp' };

// ------------------------------------------------------------------ Discord
async function dc(method, route, body, files) {
  for (let i = 0; i < 6; i++) {
    const init = { method, headers: { Authorization: 'Bot ' + TOKEN, 'User-Agent': 'DiscordBot (' + SITE + ', 1.0)' } };
    if (files && files.length) {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify(body));
      files.forEach((f, n) => fd.append(`files[${n}]`, new Blob([f.data], { type: f.type }), f.name));
      init.body = fd;
    } else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(API + route, init); } catch (e) { await wait(2000 * (i + 1)); continue; } // internet blip
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await wait(Math.ceil((+j.retry_after || 1) * 1000) + 250); continue; }
    if (r.status >= 500) { await wait(2000 * (i + 1)); continue; }
    const j = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error((j && j.message) || 'HTTP ' + r.status), { code: j && j.code, status: r.status });
    return j;
  }
  throw Object.assign(new Error('Discord stayed busy. It’ll try again on the next run.'), { busy: true });
}

// Discord only lets a bot send messages after it has logged in "live" once. This does that one time.
function gatewayLogin() {
  return new Promise((res, rej) => {
    if (typeof WebSocket !== 'function') return rej(new Error('This Node has no WebSocket (needs Node 22).'));
    const ws = new WebSocket(GATEWAY);
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} rej(new Error('Discord didn’t answer the login.')); }, 20000);
    let beat;
    ws.onmessage = ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (m.op === 10) {
        beat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: null })), m.d.heartbeat_interval);
        ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: 1, properties: { os: 'linux', browser: 'jelly-critters', device: 'jelly-critters' },
          presence: { status: 'online', afk: false, since: null, activities: [{ name: 'Jelly Critters', type: 0 }] } } }));
      } else if (m.op === 0 && m.t === 'READY') { clearTimeout(t); clearInterval(beat); ws.close(1000); res(true); }
      else if (m.op === 9) { clearTimeout(t); clearInterval(beat); ws.close(); rej(new Error('Discord refused the bot token.')); }
    };
    ws.onclose = ev => { clearInterval(beat); if (ev.code === 4004) { clearTimeout(t); rej(new Error('Discord refused the bot token.')); } };
    ws.onerror = () => {};
  });
}

const cleanText = (s, n) => String(s == null ? '' : s).replace(/^#{1,3}\s+(.*)$/gm, '**$1**').slice(0, n);

function buildMessage(j, role) {
  const t = TYPES[j.k] || TYPES.ann;
  const embed = {
    title: cleanText(j.t || 'Jelly Critters', 256) || 'Jelly Critters', url: SITE,
    color: Number.isInteger(+j.c) ? +j.c : 0xff6fa8,
    footer: { text: 'Jelly Critters · Made By Cat At War', icon_url: ICON },
    timestamp: new Date(+j.at || Date.now()).toISOString(),
  };
  const desc = cleanText(j.b, 4000);
  if (desc) embed.description = desc;
  const fields = (Array.isArray(j.f) ? j.f : Object.values(j.f || {})).filter(f => f && f.name && f.value).slice(0, 10)
    .map(f => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline }));
  if (fields.length) embed.fields = fields;
  const files = [];
  const img = typeof j.img === 'string' ? j.img : '';
  if (/^https:\/\//.test(img)) embed.image = { url: img };
  else {
    const m = img.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
    if (m) {
      const data = Buffer.from(m[2], 'base64');
      if (data.length < 9.5 * 1024 * 1024) {
        const name = 'picture.' + m[1].replace('jpeg', 'jpg');
        files.push({ name, type: 'image/' + m[1], data });
        embed.image = { url: 'attachment://' + name };
      }
    }
  }
  const body = {
    content: role ? `<@&${role}>` : '',
    embeds: [embed],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: t.button, url: SITE, emoji: { name: '🎮' } }] }],
    allowed_mentions: { parse: [], roles: role ? [role] : [] }, // only ever pings the role you picked
  };
  if (files.length) body.attachments = files.map((f, id) => ({ id, filename: f.name }));
  return { body, files };
}

function whyFailed(e, type) {
  const where = `the ${TYPES[type] ? TYPES[type].name.toLowerCase() : ''} channel`;
  if (e.code === 50001) return `The bot can’t see ${where}. Give it View Channel there (or check the bot is in the server).`;
  if (e.code === 50013) return `The bot is missing permissions in ${where} (Send Messages, Embed Links, Attach Files).`;
  if (e.code === 10003) return `The channel ID for ${TYPES[type] ? TYPES[type].name.toLowerCase() : 'that post'} is wrong, or the channel was deleted.`;
  if (e.status === 401) return 'Discord refused the bot token. Reset it in the Developer Portal and update the DISCORD_TOKEN secret.';
  return `Couldn’t post in ${where}: ${e.message}`;
}

// ------------------------------------------------------------------ main
if (!TOKEN) stop('Add the DISCORD_TOKEN secret (repo Settings → Secrets and variables → Actions).');
GT = await googleToken(loadKey());

const before = (await fb('GET', 'botstat')) || {};
const queue = (await fb('GET', 'botq')) || {};
const ids = Object.keys(queue).sort((a, b) => (queue[a].at || 0) - (queue[b].at || 0));
let sent = 0, err = null, tag = before.tag || null, live = !!before.live;

if (ids.length) {
  const cfg = (await fb('GET', 'devcfg/discord')) || {};
  const route = k => { const seen = new Set(); for (let t = k; t && !seen.has(t); t = TYPES[t] && TYPES[t].back) { seen.add(t); const c = cfg[t]; if (c && /^\d{5,25}$/.test(String(c.ch || ''))) return { ch: String(c.ch), role: /^\d{5,25}$/.test(String(c.r || '')) ? String(c.r) : null, via: t }; } return null; };
  try { const me = await dc('GET', '/users/@me'); tag = me.username + (me.discriminator && me.discriminator !== '0' ? '#' + me.discriminator : ''); }
  catch (e) { await fb('PUT', 'botstat', { at: TS, tag, live, sent: 0, err: { msg: whyFailed(e, ''), at: TS } }); stop(whyFailed(e, '')); }
  if (!live) { try { await gatewayLogin(); live = true; console.log('✓ Logged the bot in once (Discord needs that before it can post)'); } catch (e) { console.log('! ' + e.message); } }

  const chType = {};
  async function post(type, ch, msg) {
    let r;
    try { r = await dc('POST', `/channels/${ch}/messages`, msg.body, msg.files); }
    catch (e) {
      if (e.code !== 40001) throw e;
      await gatewayLogin(); live = true; // Discord wants the one-time live login first
      r = await dc('POST', `/channels/${ch}/messages`, msg.body, msg.files);
    }
    // In an Announcement channel, publish it so servers that follow the channel get it too
    try { if (chType[ch] === undefined) chType[ch] = (await dc('GET', `/channels/${ch}`)).type; if (chType[ch] === 5) await dc('POST', `/channels/${ch}/messages/${r.id}/crosspost`); } catch (e) {}
    return r;
  }

  for (const id of ids) {
    const j = queue[id] || {}, done = j.done || {};
    let keep = false; // Discord was down: leave it for the next run
    if (!j.at || Date.now() - j.at > MAX_AGE) { await fb('DELETE', 'botq/' + id); console.log('· Skipped an old post: ' + (j.t || '')); continue; }
    if (j.k === 'test') {
      let any = false;
      for (const k of Object.keys(TYPES)) {
        const c = cfg[k]; if (!c || !/^\d{5,25}$/.test(String(c.ch || '')) || done[k]) continue;
        any = true;
        try { await post(k, String(c.ch), buildMessage({ k, t: '👋 Test from Jelly Critters', b: `This is where **${TYPES[k].name.toLowerCase()}** will show up.`, c: 0x7cc8ff, at: Date.now() }, null)); await fb('PUT', `botq/${id}/done/${k}`, true); sent++; }
        catch (e) { err = whyFailed(e, k); console.log('! ' + err); if (e.busy) keep = true; }
      }
      if (!any) err = 'Test: no channels are set yet. Add channel IDs in the game’s Discord box.';
    } else if (TYPES[j.k]) {
      const r = route(j.k);
      if (!r) err = `Got a ${TYPES[j.k].name.toLowerCase()} post but no channel is set for it. Add a channel ID in the game’s Discord box.`;
      else if (!done.ok) {
        try { await post(r.via, r.ch, buildMessage(j, r.role)); await fb('PUT', `botq/${id}/done/ok`, true); sent++; console.log(`✓ Posted (${TYPES[r.via].name}): ${String(j.t || '').slice(0, 80)}`); }
        catch (e) { err = whyFailed(e, r.via); console.log('! ' + err); if (e.busy) keep = true; }
      }
    }
    if (!keep) await fb('DELETE', 'botq/' + id);
  }
}

const keepErr = before.err && before.err.at && Date.now() - before.err.at < 864e5 ? before.err : null;
await fb('PUT', 'botstat', { at: TS, tag, live, sent, err: err ? { msg: err.slice(0, 300), at: TS } : (ids.length ? null : keepErr) });
console.log(ids.length ? `Done: ${sent} post${sent === 1 ? '' : 's'} sent.` : 'Nothing waiting.');
if (err && BY_HAND) process.exit(1);
