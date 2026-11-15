// Server side of 3iaw.com on Cloudflare Workers. Everything that isn't /api/* is a static file from the repo.
//
//   GET    /api/roblox-stats        live names, icons, thumbnails, visits and favorites of the games
//   GET    /api/reviews             all reviews, newest first
//   POST   /api/reviews             post a review; only works after a purchase is confirmed
//   DELETE /api/reviews?id=<id>     remove a review (admin)
//   POST   /api/order               place an order from the order form; emails the owner
//   POST   /api/contact             send a message from the contact form; emails the owner
//   GET    /api/orders              orders and messages (admin)
//   POST   /api/orders              {orderId, paid} mark an order paid or undo it (admin)
//   POST   /api/roblox/user         Audio Converter: username -> Roblox user ID
//   POST   /api/roblox/upload       Audio Converter: upload an MP3 with the visitor's own Open Cloud key
//   GET    /api/roblox/operation    Audio Converter: is the upload done, and its asset ID
//   GET    /api/roblox/asset        Audio Converter: moderation status of an uploaded asset
//   GET    /api/auth/discord        Audio Converter: log in with Discord (redirects to Discord)
//   GET    /api/auth/callback       Discord sends the visitor back here; starts a 30-day session
//   GET    /api/auth/me             who is logged in, and their free uploads left or plan end date
//   POST   /api/auth/logout         end the session
//   POST   /api/plan-order          buy an Audio Converter plan for the logged-in Discord account
//
// Audio Converter plans: uploading needs a Discord login, and each Discord account gets FREE_UPLOADS uploads.
// After that it needs a plan, bought in the converter (bKash / Nagad). Pressing "Confirm payment" in
// reviews-admin.html unlocks that Discord account for the plan's days; Undo takes the days back.
// How a purchase is confirmed for a review: the order ID and email must match an order placed here, and
// the owner must have pressed "Confirm payment" for it in reviews-admin.html. That covers Robux buyers too:
// Roblox blocks Cloudflare's shared servers, so the site can't ask Roblox who owns a game pass.
//
// The Roblox numbers come from .github/workflows/stats.yml, which publishes stats.json to the `data` branch.
//
// Bindings (wrangler.jsonc): DATA (KV), MAILER (send_email), ASSETS. Secret: REVIEWS_ADMIN_KEY.
// KV keys: review:<id>, order:<orderId>, paid:<orderId>, message:<time>-<rand>,
//          session:<sid> (Discord login), uses:discord:<id> (uploads made), sub:discord:<id> ({grants}),
//          grant:<orderId> (which account a plan order unlocked)
// Secret DISCORD_CLIENT_SECRET and var DISCORD_CLIENT_ID: the Discord app used for logging in.

import { EmailMessage } from 'cloudflare:email';

// Audio Converter plans (index.html #shopData "plans" has the same names and prices) -> days of unlimited uploads
const PLANS = { 'Audio Converter: 1 Month': 30, 'Audio Converter: 3 Months': 90, 'Audio Converter: 1 Year': 365 };
const PLAN_PRICES = { 'Audio Converter: 1 Month': 2000, 'Audio Converter: 3 Months': 5000, 'Audio Converter: 1 Year': 10000 }; // ৳
const FREE_UPLOADS = 2;
const DAY = 86400000;

// the items in the shop (index.html #shopData), plus agreed UGC and the Audio Converter plans
const ITEMS = [
  'Fly Race System', 'Game Essentials Pack', 'Rowboat System', 'Kite Fighting System', 'Donation System',
  'Halloween Tools Pack', 'Partner System', 'Profile System', 'Concert Stage System', 'Custom UGC',
  ...Object.keys(PLANS),
];

const STATS_URL = 'https://raw.githubusercontent.com/iftew/3iaw-website/data/stats.json';

// order emails go from the site to the owner; the owner's address must be verified in Cloudflare Email Routing
const OWNER_EMAIL = 'pleasejoinmyteam@gmail.com';
const FROM_EMAIL = 'orders@3iaw.com';

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

// a reason the visitor can act on; anything else is reported as a generic failure
class Refusal extends Error {}

const isAdmin = (req, env) => Boolean(env.REVIEWS_ADMIN_KEY) && req.headers.get('x-admin-key') === env.REVIEWS_ADMIN_KEY;

async function listJson(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.DATA.list({ prefix, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const values = await Promise.all(keys.map((k) => env.DATA.get(k, 'json')));
  return values.filter(Boolean);
}

// ---------- email ----------

// non-ASCII headers (the ৳ sign, Bangla names) have to be encoded for email
function header(text) {
  const clean = String(text).replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const bytes = new TextEncoder().encode(clean);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return '=?UTF-8?B?' + btoa(bin) + '?=';
}

async function notifyOwner(env, subject, lines, replyTo) {
  if (!env.MAILER) return;
  const body = lines.join('\r\n');
  const bytes = new TextEncoder().encode(body);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  const raw = [
    'From: ' + header('3iaw.com') + ' <' + FROM_EMAIL + '>',
    'To: <' + OWNER_EMAIL + '>',
    ...(replyTo && EMAIL_RE.test(replyTo) ? ['Reply-To: <' + replyTo + '>'] : []),
    'Subject: ' + header(subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomUUID() + '@3iaw.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(bin).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  await env.MAILER.send(new EmailMessage(FROM_EMAIL, OWNER_EMAIL, raw));
}

// ---------- live Roblox game info ----------

// names and pictures come from stats.json (the GitHub job; Cloudflare keeps a copy for 5 minutes).
// The numbers (visits, favorites, players online right now) are then swapped for live ones.
// Roblox blocks Cloudflare's servers, so they come through the public RoProxy mirror, cached 15 seconds.
const LIVE_URL = 'https://games.roproxy.com/v1/games?universeIds=';

async function robloxStats() {
  try {
    const r = await fetch(STATS_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) throw new Error('stats.json ' + r.status);
    const d = await r.json();
    try {
      const lr = await fetch(LIVE_URL + Object.keys(d.games).join(','), { cf: { cacheTtl: 15, cacheEverything: true } });
      if (!lr.ok) throw new Error('live ' + lr.status);
      const live = (await lr.json()).data || [];
      let visits = 0, playing = 0, favorites = 0;
      for (const g of live) {
        const s = d.games[g.id];
        if (!s) continue;
        s.visits = g.visits; s.favorites = g.favoritedCount; s.playing = g.playing || 0;
      }
      for (const id in d.games) {
        visits += d.games[id].visits || 0; favorites += d.games[id].favorites || 0; playing += d.games[id].playing || 0;
      }
      if (live.length) Object.assign(d, { totalVisits: visits, totalFavorites: favorites, totalPlaying: playing, live: true, updated: new Date().toISOString() });
    } catch (e) {
      console.error(e);                              // live numbers down: send stats.json as it is
    }
    return Response.json(d, { headers: { 'Cache-Control': 'public, max-age=15' } });
  } catch (e) {
    console.error(e);
    // the page keeps its built-in numbers when this fails
    return json({ error: 'unavailable' }, 502);
  }
}

// ---------- reviews ----------

async function confirmOrder(env, item, orderId, email) {
  const order = await env.DATA.get('order:' + orderId, 'json');
  if (!order || order.email.toLowerCase() !== email) throw new Refusal("That order ID and email don't match any order.");
  if (order.item !== item) throw new Refusal('Order ' + orderId + ' was for the ' + order.item + ', not the ' + item + '.');
  // a placed order isn't enough: the payment has to be confirmed first
  if (!(await env.DATA.get('paid:' + orderId))) {
    throw new Refusal('Your payment for order ' + orderId + " hasn't been confirmed yet. You can review it once I confirm your payment.");
  }
  return { key: 'order-' + orderId, name: String(order.username || 'Buyer').slice(0, 40), payment: order.payment };
}

async function reviews(req, env) {
  if (req.method === 'GET') {
    const all = await listJson(env, 'review:');
    return json({ reviews: all.sort((a, b) => b.date.localeCompare(a.date)) });
  }

  if (req.method === 'DELETE') {
    if (!isAdmin(req, env)) return json({ error: 'Wrong admin key.' }, 401);
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ error: 'Missing id.' }, 400);
    await env.DATA.delete('review:' + id);
    return json({ ok: true });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const item = String(body.item || '');
  const rating = Number(body.rating);
  const text = String(body.text || '').trim().slice(0, 1000);
  if (!ITEMS.includes(item)) return json({ error: 'Pick the item you bought.' }, 400);
  if (!(rating >= 1 && rating <= 5 && Number.isInteger(rating))) return json({ error: 'Pick a rating from 1 to 5 stars.' }, 400);
  if (text.length < 3) return json({ error: 'Write a few words about your purchase.' }, 400);

  try {
    const orderId = String(body.orderId || '').trim().toUpperCase();
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^3I-[A-Z0-9]{4,10}$/.test(orderId)) return json({ error: 'Enter your order ID, like 3I-ABC123.' }, 400);
    if (!email.includes('@')) return json({ error: 'Enter the email you ordered with.' }, 400);
    const buyer = await confirmOrder(env, item, orderId, email);

    // one review per purchase; posting again replaces the earlier one
    const review = { id: buyer.key, item, rating, text, name: buyer.name, method: buyer.payment, date: new Date().toISOString() };
    await env.DATA.put('review:' + buyer.key, JSON.stringify(review));
    return json({ review });
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.message }, 403);
    console.error(e);
    return json({ error: "Couldn't check your purchase right now. Please try again in a few minutes." }, 502);
  }
}

// ---------- order and contact forms ----------

async function readForm(req) {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) return req.json();
  return Object.fromEntries(await req.formData());
}
const field = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

async function placeOrder(req, env) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  let f;
  try { f = await readForm(req); } catch { return json({ error: 'Bad request.' }, 400); }
  // bots fill the hidden field; pretend it worked so they don't retry
  if (field(f['bot-field'], 200)) return json({ ok: true, orderId: '3I-000000' });

  const order = {
    item: field(f.system, 60),
    payment: field(f.payment, 20),
    price: field(f.price, 40),
    email: field(f.email, 120).toLowerCase(),
    username: field(f.roblox_username, 40),
    transactionId: field(f.transaction_id, 40),
    ugcPrice: field(f.ugc_price, 12),
    ugc: field(f.ugc_details, 120),
    notes: field(f.notes, 2000),
  };
  if (!ITEMS.includes(order.item)) return json({ error: 'Pick an item.' }, 400);
  if (!['Robux', 'bKash', 'Nagad'].includes(order.payment)) return json({ error: 'Pick a payment method.' }, 400);
  if (order.item === 'Custom UGC' && order.payment === 'Robux') return json({ error: 'UGC is paid with bKash or Nagad.' }, 400);
  // plans belong to a Discord account, so they're bought inside the Audio Converter while logged in
  if (PLANS[order.item]) return json({ error: 'Buy Audio Converter plans on 3iaw.com/audio, logged in with Discord.' }, 400);
  if (!EMAIL_RE.test(order.email)) return json({ error: 'Enter a correct email address.' }, 400);
  if (!order.username) return json({ error: 'Enter your Roblox username.' }, 400);
  if (order.payment !== 'Robux' && !order.transactionId) return json({ error: 'Enter the transaction ID from your receipt.' }, 400);

  // the server picks the order ID, so nobody can overwrite someone else's order
  let orderId;
  for (let i = 0; i < 5; i++) {
    const rand = crypto.getRandomValues(new Uint8Array(6));
    orderId = '3I-' + Array.from(rand, (b) => '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 34]).join('');
    if (!(await env.DATA.get('order:' + orderId))) break;
  }
  order.orderId = orderId;
  order.date = new Date().toISOString();
  await env.DATA.put('order:' + orderId, JSON.stringify(order));

  // waiting for the email (instead of sending it in the background) makes sure it goes out
  await notifyOwner(env, 'New order ' + orderId + ': ' + order.item + ' (' + order.price + ')', [
    'New order on 3iaw.com',
    '',
    'Order ID:        ' + orderId,
    'Item:            ' + order.item,
    'Price:           ' + order.price,
    'Payment:         ' + order.payment,
    'Transaction ID:  ' + (order.transactionId || '(Robux: check the game pass)'),
    ...(order.item === 'Custom UGC' ? ['Agreed price:    ' + order.ugcPrice, 'Which UGC:       ' + order.ugc] : []),
    'Email:           ' + order.email,
    'Roblox username: ' + order.username,
    'Notes:           ' + (order.notes || '-'),
    '',
    (order.payment === 'Robux'
      ? 'Check that ' + order.username + ' bought the game pass on Roblox'
      : 'Check the ' + order.payment + ' payment') + ', then press "Confirm payment" at https://3iaw.com/reviews-admin.html so they can review it.',
    'Reply to this email to answer the buyer directly.',
  ], order.email).catch((e) => console.error('order email', e));

  return json({ ok: true, orderId });
}

async function contact(req, env) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  let f;
  try { f = await readForm(req); } catch { return json({ error: 'Bad request.' }, 400); }
  if (field(f['bot-field'], 200)) return json({ ok: true });

  const msg = {
    name: field(f.name, 80),
    replyTo: field(f.reply_to, 120),
    topic: field(f.topic, 40),
    message: field(f.message, 2000),
    date: new Date().toISOString(),
  };
  if (!msg.name || !msg.replyTo || !msg.message) return json({ error: 'Fill in your name, how to reach you and your message.' }, 400);
  await env.DATA.put('message:' + Date.now() + '-' + crypto.randomUUID().slice(0, 8), JSON.stringify(msg));

  await notifyOwner(env, 'Message from ' + msg.name + ': ' + msg.topic, [
    'New message on 3iaw.com',
    '',
    'Name:     ' + msg.name,
    'Reply to: ' + msg.replyTo + (EMAIL_RE.test(msg.replyTo) ? '' : '  (Discord, not an email)'),
    'Topic:    ' + msg.topic,
    '',
    msg.message,
  ], msg.replyTo).catch((e) => console.error('contact email', e));

  return json({ ok: true });
}

// ---------- admin: orders and messages ----------

async function orders(req, env) {
  if (!isAdmin(req, env)) return json({ error: 'Wrong admin key.' }, 401);

  if (req.method === 'GET') {
    const [list, messages] = await Promise.all([listJson(env, 'order:'), listJson(env, 'message:')]);
    const marks = await Promise.all(list.map((o) => env.DATA.get('paid:' + o.orderId)));
    // for confirmed plan orders: which Roblox account it unlocked, and until when
    const unlocks = await Promise.all(list.map(async (o, i) => {
      if (!PLANS[o.item] || !marks[i]) return null;
      const grant = await env.DATA.get('grant:' + o.orderId, 'json');
      if (!grant) return null;
      return { creator: grant.creator, until: planUntil(await env.DATA.get('sub:' + grant.creator, 'json')) };
    }));
    return json({
      orders: list.map((o, i) => ({ ...o, paid: Boolean(marks[i]), unlock: unlocks[i] })).sort((a, b) => b.date.localeCompare(a.date)),
      messages: messages.sort((a, b) => b.date.localeCompare(a.date)),
    });
  }
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
    const orderId = String(body.orderId || '').trim().toUpperCase();
    if (!/^3I-[A-Z0-9]{4,10}$/.test(orderId)) return json({ error: 'Bad order ID.' }, 400);
    if (body.paid) await env.DATA.put('paid:' + orderId, new Date().toISOString());
    else await env.DATA.delete('paid:' + orderId);
    // an Audio Converter plan: unlock (or lock again) the Roblox account named in the order
    const order = await env.DATA.get('order:' + orderId, 'json');
    let unlock = null, warning = null;
    if (order && PLANS[order.item]) {
      try { unlock = await setGrant(env, order, Boolean(body.paid)); }
      catch (e) { warning = 'Payment saved, but the Audio Converter was not unlocked: ' + e.message; }
    }
    return json({ ok: true, orderId, paid: Boolean(body.paid), unlock, warning });
  }
  return json({ error: 'Method not allowed.' }, 405);
}

// ---------- Audio Converter (/audio): Roblox Open Cloud calls for the visitor ----------
// Browsers can't call apis.roblox.com directly (no CORS), so the page sends its calls here and they are
// passed on unchanged. The visitor's own API key comes in the X-Roblox-Key header; it is never stored or logged.
// Only these fixed Roblox endpoints can be reached, and only from pages on this site.

const ROBLOX_ASSETS = 'https://apis.roblox.com/assets/v1';
const MAX_UPLOAD = 21 * 1024 * 1024; // Roblox's audio limit is 20 MB, plus room for the form

async function robloxPassOn(url, init) {
  let res;
  try { res = await fetch(url, init); } catch { return json({ error: "Couldn't reach Roblox. Try again." }, 502); }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 300) }; }
  if (res.ok) return json(body);
  // turn Roblox's error shapes into one readable message
  const msg = body.message || (Array.isArray(body.errors) && body.errors.map((e) => e.message).join(' ')) ||
    (Array.isArray(body) && body.map((e) => e.message).join(' ')) || 'Request failed.';
  const hint = res.status === 401 ? ' Check the API key in Connect Roblox.'
    : res.status === 403 ? ' Make sure the key has Assets Read and Write, and 0.0.0.0/0 under Accepted IP Addresses.'
    : res.status === 429 ? ' Roblox is limiting uploads right now (or your monthly audio quota is used up).' : '';
  const detail = String(msg).trim().replace(/([^.!?])$/, '$1.');
  return json({ error: `Roblox ${res.status}: ${detail}${hint}` }, res.status >= 500 ? 502 : res.status);
}

// ---------- Audio Converter plans ----------

class LookupRefusal extends Error {}

// username -> {id, name}; public lookup, no key involved. Roblox often answers Cloudflare with 429,
// so roproxy (as for the live stats) is the fallback
async function lookupUser(username) {
  if (!/^\w{3,20}$/.test(username)) throw new LookupRefusal("That doesn't look like a Roblox username.");
  for (const host of ['users.roblox.com', 'users.roproxy.com']) {
    try {
      const res = await fetch(`https://${host}/v1/usernames/users`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
      });
      if (!res.ok) continue;
      const data = (await res.json()).data || [];
      if (!data.length) throw new LookupRefusal(`No Roblox user named "${username}".`);
      return { id: data[0].id, name: data[0].name };
    } catch (e) { if (e instanceof LookupRefusal) throw e; /* try the next host */ }
  }
  throw new Error("Couldn't look up that username right now.");
}

// grants stack: each one starts when the previous one ends (or when it was confirmed, if later)
function planUntil(sub) {
  let until = 0;
  for (const g of (sub && sub.grants) || []) until = Math.max(until, Date.parse(g.paidAt)) + g.days * DAY;
  return until ? new Date(until).toISOString() : null;
}

// the plan order was placed while logged in, so it carries the Discord account it unlocks
async function setGrant(env, order, paid) {
  if (!/^\d{5,25}$/.test(String(order.discordId || ''))) throw new Error('this order has no Discord account.');
  const creator = 'discord:' + order.discordId;
  const sub = (await env.DATA.get('sub:' + creator, 'json')) || { grants: [] };
  sub.grants = sub.grants.filter((g) => g.orderId !== order.orderId);
  if (paid) {
    sub.grants.push({ orderId: order.orderId, days: PLANS[order.item], paidAt: new Date().toISOString() });
    sub.grants.sort((a, b) => a.paidAt.localeCompare(b.paidAt));
    await env.DATA.put('grant:' + order.orderId, JSON.stringify({ creator }));
  } else {
    await env.DATA.delete('grant:' + order.orderId);
  }
  await env.DATA.put('sub:' + creator, JSON.stringify(sub));
  return { creator, until: planUntil(sub) };
}

async function planStatus(env, creator) {
  const until = planUntil(await env.DATA.get('sub:' + creator, 'json'));
  const used = Number(await env.DATA.get('uses:' + creator)) || 0;
  const active = Boolean(until && Date.parse(until) > Date.now());
  return { creator, active, until: active ? until : null, used, free: FREE_UPLOADS, left: active ? null : Math.max(0, FREE_UPLOADS - used) };
}

// ---------- Discord login (for the Audio Converter) ----------
// Settings (wrangler.jsonc vars + a Cloudflare secret): DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET.
// The Discord app's redirect must be https://3iaw.com/api/auth/callback. Only the "identify" scope is used:
// the site learns the Discord user ID, username and avatar, nothing else.
const SESSION_DAYS = 30;
const REDIRECT_URI = 'https://3iaw.com/api/auth/callback';

function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const randomId = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

async function sessionOf(req, env) {
  const sid = cookie(req, 'sid');
  if (!/^[0-9a-f]{64}$/.test(sid)) return null;
  return env.DATA.get('session:' + sid, 'json');
}

async function auth(req, env, path) {
  const url = new URL(req.url);
  if (path === '/api/auth/discord') {
    if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return json({ error: 'Discord login is not set up yet.' }, 503);
    const state = randomId(16);
    const to = new URL('https://discord.com/oauth2/authorize');
    to.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI, scope: 'identify', state, prompt: 'none' });
    return new Response(null, { status: 302, headers: { Location: to.toString(), 'Set-Cookie': setCookie('oauth_state', state, 600) } });
  }
  if (path === '/api/auth/callback') {
    const back = (q) => new Response(null, { status: 302, headers: { Location: '/audio' + q, 'Set-Cookie': setCookie('oauth_state', '', 0) } });
    const code = url.searchParams.get('code');
    if (!code || !url.searchParams.get('state') || url.searchParams.get('state') !== cookie(req, 'oauth_state')) return back('?login=failed');
    try {
      const tok = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      });
      if (!tok.ok) throw new Error('token ' + tok.status);
      const { access_token } = await tok.json();
      const me = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + access_token } });
      if (!me.ok) throw new Error('user ' + me.status);
      const u = await me.json();
      const sid = randomId(32);
      const user = { id: String(u.id), name: u.global_name || u.username, username: u.username, avatar: u.avatar || null };
      await env.DATA.put('session:' + sid, JSON.stringify(user), { expirationTtl: SESSION_DAYS * 86400 });
      const res = back('?login=ok');
      res.headers.append('Set-Cookie', setCookie('sid', sid, SESSION_DAYS * 86400));
      return res;
    } catch (e) {
      console.error('discord login', e);
      return back('?login=failed');
    }
  }
  if (path === '/api/auth/me') {
    const user = await sessionOf(req, env);
    if (!user) return json({ user: null, ready: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) });
    return json({ user, plan: await planStatus(env, 'discord:' + user.id), ready: true });
  }
  if (path === '/api/auth/logout') {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const sid = cookie(req, 'sid');
    if (/^[0-9a-f]{64}$/.test(sid)) await env.DATA.delete('session:' + sid);
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie('sid', '', 0) });
  }
  return json({ error: 'Not found.' }, 404);
}

// a plan order from the Audio Converter: like the order form, but tied to the logged-in Discord account
async function planOrder(req, env) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (req.headers.get('sec-fetch-site') !== 'same-origin') return json({ error: 'Not allowed.' }, 403);
  const user = await sessionOf(req, env);
  if (!user) return json({ error: 'Log in with Discord first.', needLogin: true }, 401);
  let b;
  try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const order = {
    item: field(b.plan, 60),
    payment: field(b.payment, 20),
    email: field(b.email, 120).toLowerCase(),
    transactionId: field(b.transactionId, 40),
    username: '@' + user.username,
    discordId: user.id,
    discordName: user.name,
    notes: field(b.notes, 500),
  };
  if (!PLANS[order.item]) return json({ error: 'Pick a plan.' }, 400);
  if (!['bKash', 'Nagad'].includes(order.payment)) return json({ error: 'Pick bKash or Nagad.' }, 400);
  if (!EMAIL_RE.test(order.email)) return json({ error: 'Enter a correct email address.' }, 400);
  if (!order.transactionId) return json({ error: 'Enter the transaction ID from your receipt.' }, 400);
  order.price = '৳' + PLAN_PRICES[order.item].toLocaleString('en-US') + ' (' + order.payment + ')';

  let orderId;
  for (let i = 0; i < 5; i++) {
    const rand = crypto.getRandomValues(new Uint8Array(6));
    orderId = '3I-' + Array.from(rand, (x) => '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[x % 34]).join('');
    if (!(await env.DATA.get('order:' + orderId))) break;
  }
  order.orderId = orderId;
  order.date = new Date().toISOString();
  await env.DATA.put('order:' + orderId, JSON.stringify(order));
  await notifyOwner(env, 'New plan order ' + orderId + ': ' + order.item + ' (' + order.price + ')', [
    'New Audio Converter plan on 3iaw.com',
    '',
    'Order ID:        ' + orderId,
    'Plan:            ' + order.item + ' (' + PLANS[order.item] + ' days)',
    'Price:           ' + order.price,
    'Transaction ID:  ' + order.transactionId,
    'Discord:         ' + order.discordName + ' (@' + user.username + ', ID ' + user.id + ')',
    'Email:           ' + order.email,
    'Notes:           ' + (order.notes || '-'),
    '',
    'Check the ' + order.payment + ' payment, then press "Confirm payment" at https://3iaw.com/reviews-admin.html.',
    "That unlocks unlimited uploads for this Discord account; the days start when you confirm.",
  ], order.email).catch((e) => console.error('plan email', e));
  return json({ ok: true, orderId });
}

async function robloxAudio(req, env, path) {
  // fetch() from this site's pages sends Sec-Fetch-Site: same-origin; this keeps other sites from using the relay
  if (req.headers.get('sec-fetch-site') !== 'same-origin') return json({ error: 'Not allowed.' }, 403);
  const url = new URL(req.url);

  if (path === '/api/roblox/user') {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
    try { return json(await lookupUser(String(body.username || '').trim())); }
    catch (e) { return json({ error: e instanceof LookupRefusal ? e.message : "Couldn't look up that username. Enter your user ID instead." }, e instanceof LookupRefusal ? 404 : 502); }
  }

  const key = (req.headers.get('x-roblox-key') || '').trim();
  if (!key || key.length > 4000) return json({ error: 'Connect your Roblox account first.' }, 401);
  const auth = { 'x-api-key': key };

  if (path === '/api/roblox/upload') {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const type = req.headers.get('content-type') || '';
    if (!type.startsWith('multipart/form-data')) return json({ error: 'Bad request.' }, 400);
    if (Number(req.headers.get('content-length') || 0) > MAX_UPLOAD) return json({ error: 'The file is over 20 MB.' }, 413);
    // only an Audio asset with an MP3 file goes through
    let form;
    try { form = await req.formData(); } catch { return json({ error: 'Bad request.' }, 400); }
    const file = form.get('fileContent');
    let meta;
    try { meta = JSON.parse(String(form.get('request') || '')); } catch { return json({ error: 'Bad request.' }, 400); }
    if (!(file instanceof File) || file.size > MAX_UPLOAD || meta.assetType !== 'Audio') return json({ error: 'Bad request.' }, 400);
    // uploads need a Discord login; the free uploads and plans are counted per Discord account.
    // Until the Discord app is set up (no DISCORD_CLIENT_ID / SECRET), uploads work without a limit.
    const limited = Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
    const user = limited ? await sessionOf(req, env) : null;
    if (limited && !user) return json({ error: 'Log in with Discord to upload.', needLogin: true }, 401);
    const creator = user ? 'discord:' + user.id : null;
    const plan = creator ? await planStatus(env, creator) : { active: true, used: 0 };
    if (!plan.active && plan.left <= 0) {
      return json({ error: `You've used your ${FREE_UPLOADS} free uploads. Get a plan for unlimited uploads.`, needPlan: true, plan }, 402);
    }
    const out = new FormData();
    // a plain text field: sent as a Blob it becomes a file part, and Roblox answers "Request body cannot be empty"
    out.append('request', JSON.stringify(meta));
    out.append('fileContent', new File([file], 'audio.mp3', { type: 'audio/mpeg' }));
    const res = await robloxPassOn(ROBLOX_ASSETS + '/assets', { method: 'POST', headers: auth, body: out });
    // only an upload Roblox accepted counts
    if (res.ok && creator) await env.DATA.put('uses:' + creator, String(plan.used + 1));
    return res;
  }
  if (path === '/api/roblox/operation') {
    const id = url.searchParams.get('id') || '';
    if (!/^[\w-]{1,100}$/.test(id)) return json({ error: 'Bad operation ID.' }, 400);
    return robloxPassOn(ROBLOX_ASSETS + '/operations/' + id, { headers: auth });
  }
  if (path === '/api/roblox/asset') {
    const id = url.searchParams.get('id') || '';
    if (!/^\d{1,20}$/.test(id)) return json({ error: 'Bad asset ID.' }, 400);
    const res = await robloxPassOn(`${ROBLOX_ASSETS}/assets/${id}?readMask=moderationResult`, { headers: auth });
    if (!res.ok) return res;
    const body = await res.json();
    return json({ assetId: id, moderationState: (body.moderationResult || {}).moderationState || 'Reviewing' });
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/api/roblox/')) return robloxAudio(req, env, path);
    if (path.startsWith('/api/auth/')) return auth(req, env, path);
    if (path === '/api/plan-order') return planOrder(req, env);
    if (path === '/api/roblox-stats') return robloxStats();
    if (path === '/api/reviews') return reviews(req, env);
    if (path === '/api/order') return placeOrder(req, env);
    if (path === '/api/contact') return contact(req, env);
    if (path === '/api/orders') return orders(req, env);
    if (path.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
    return env.ASSETS.fetch(req);
  },
};
