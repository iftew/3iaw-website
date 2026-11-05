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
//
// How a purchase is confirmed for a review:
//   Robux        the Roblox user must own the item's game pass (Roblox's public is-owned check)
//   bKash/Nagad  the order ID and email must match an order placed here, and the owner must have
//                pressed "Confirm payment" for it in reviews-admin.html
//
// Bindings (wrangler.jsonc): DATA (KV), MAILER (send_email), ASSETS. Secret: REVIEWS_ADMIN_KEY.
// KV keys: review:<id>, order:<orderId>, paid:<orderId>, message:<time>-<rand>

import { EmailMessage } from 'cloudflare:email';

// universe IDs (not place IDs), looked up from apis.roblox.com/universes/v1/places/<placeId>/universe
const UNIVERSES = [
  10479483082, // Bangali Era
  10080882090, // Ondhokar
  10764929985, // CTG CITY
  9195047050,  // Bangali Hood (place 134757873036097)
  9892395751,  // Bangla Town
  10771061328, // Lumina Hangout
  10770998037, // Bengali Society
  10294847053, // Mystic Hangout
];

// game pass IDs, copied from the gamepass links in index.html (#shopData)
const GAMEPASSES = {
  'Fly Race System': 2060123281,
  'Game Essentials Pack': 2060261327,
  'Rowboat System': 2057567344,
  'Kite Fighting System': 2057423342,
  'Donation System': 2058023335,
  'Halloween Tools Pack': 2057447363,
  'Partner System': 2060656564,
  'Profile System': 2057621402,
  'Concert Stage System': 2058263389,
};
// Custom UGC has no game pass: it's paid with bKash / Nagad, so only the order check applies
const ITEMS = [...Object.keys(GAMEPASSES), 'Custom UGC'];

// order emails go from the site to the owner; the owner's address must be verified in Cloudflare Email Routing
const OWNER_EMAIL = 'pleasejoinmyteam@gmail.com';
const FROM_EMAIL = 'orders@3iaw.com';

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

// a reason the visitor can act on; anything else is reported as a generic failure
class Refusal extends Error {}

// Roblox turns away requests that don't say who they are, so every call to it carries a User-Agent
function roblox(url, opts = {}) {
  return fetch(url, { ...opts, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 3iaw.com)', Accept: 'application/json', ...(opts.headers || {}) } });
}

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

async function robloxStats(req, ctx) {
  // the Cloudflare cache keeps the answer for 10 minutes, so Roblox is called a few times an hour at most
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/roblox-stats', req.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const ids = UNIVERSES.join(',');
  const get = (url) => roblox(url).then((r) => { if (!r.ok) throw new Error('roblox ' + r.status + ' ' + new URL(url).host); return r.json(); });
  // images are optional: if a thumbnail call fails the page keeps its own pictures
  const images = (url) => get(url).then((d) => d.data).catch(() => []);
  try {
    const [{ data }, thumbs, icons] = await Promise.all([
      get('https://games.roblox.com/v1/games?universeIds=' + ids),
      images('https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=' + ids + '&countPerUniverse=1&size=768x432&format=Webp'),
      images('https://thumbnails.roblox.com/v1/games/icons?universeIds=' + ids + '&size=256x256&format=Webp'),
    ]);
    const thumbOf = {};
    for (const t of thumbs) {
      const first = (t.thumbnails || [])[0];
      if (first && first.state === 'Completed') thumbOf[t.universeId] = first.imageUrl;
    }
    const iconOf = {};
    for (const i of icons) if (i.state === 'Completed') iconOf[i.targetId] = i.imageUrl;

    const games = {};
    let totalVisits = 0;
    for (const g of data) {
      games[g.id] = { name: g.name, visits: g.visits, favorites: g.favoritedCount, thumbnail: thumbOf[g.id] || null, icon: iconOf[g.id] || null };
      totalVisits += g.visits;
    }
    const res = Response.json({ games, totalVisits, updated: new Date().toISOString() }, {
      headers: { 'Cache-Control': 'public, max-age=600' },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    console.error(e);
    // the page keeps its built-in numbers when this fails
    return json({ error: 'unavailable', detail: String(e.message) }, 502);
  }
}

// ---------- reviews ----------

async function robloxUser(username) {
  const r = await roblox('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  if (!r.ok) throw new Error('roblox users ' + r.status);
  const user = (await r.json()).data[0];
  if (!user) throw new Refusal('No Roblox user is called "' + username + '".');
  return user;
}

async function confirmRobux(item, username) {
  const user = await robloxUser(username);
  // item type 1 = game pass
  const r = await roblox('https://inventory.roblox.com/v1/users/' + user.id + '/items/1/' + GAMEPASSES[item] + '/is-owned');
  if (!r.ok) throw new Error('roblox inventory ' + r.status);
  if ((await r.text()).trim() !== 'true') {
    throw new Refusal(user.name + " doesn't own the " + item + ' game pass. If you bought it, check that you typed the same Roblox account.');
  }
  return { key: 'robux-' + user.id + '-' + item, name: user.name };
}

async function confirmOrder(env, item, orderId, email) {
  const order = await env.DATA.get('order:' + orderId, 'json');
  if (!order || order.email.toLowerCase() !== email) throw new Refusal("That order ID and email don't match any order.");
  if (order.item !== item) throw new Refusal('Order ' + orderId + ' was for the ' + order.item + ', not the ' + item + '.');
  // a placed order isn't enough: the payment has to be confirmed first
  if (!(await env.DATA.get('paid:' + orderId))) {
    throw new Refusal('Your payment for order ' + orderId + " hasn't been confirmed yet. You can review it once I confirm your payment.");
  }
  return { key: 'order-' + orderId, name: String(order.username || 'Buyer').slice(0, 40) };
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
  const method = String(body.method || '');
  const rating = Number(body.rating);
  const text = String(body.text || '').trim().slice(0, 1000);
  if (!ITEMS.includes(item)) return json({ error: 'Pick the item you bought.' }, 400);
  if (!(rating >= 1 && rating <= 5 && Number.isInteger(rating))) return json({ error: 'Pick a rating from 1 to 5 stars.' }, 400);
  if (text.length < 3) return json({ error: 'Write a few words about your purchase.' }, 400);

  try {
    let buyer;
    if (method === 'Robux') {
      if (!GAMEPASSES[item]) return json({ error: 'UGC is paid with bKash or Nagad, so review it with your order ID.' }, 400);
      const username = String(body.username || '').trim();
      if (!/^\w{3,20}$/.test(username)) return json({ error: 'Enter the Roblox username you bought with.' }, 400);
      buyer = await confirmRobux(item, username);
    } else if (method === 'bKash/Nagad') {
      const orderId = String(body.orderId || '').trim().toUpperCase();
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^3I-[A-Z0-9]{4,10}$/.test(orderId)) return json({ error: 'Enter your order ID, like 3I-ABC123.' }, 400);
      if (!email.includes('@')) return json({ error: 'Enter the email you ordered with.' }, 400);
      buyer = await confirmOrder(env, item, orderId, email);
    } else {
      return json({ error: 'Pick how you paid.' }, 400);
    }

    // one review per purchase; posting again replaces the earlier one
    const review = { id: buyer.key, item, rating, text, name: buyer.name, method, date: new Date().toISOString() };
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

async function placeOrder(req, env, ctx) {
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

  ctx.waitUntil(notifyOwner(env, 'New order ' + orderId + ': ' + order.item + ' (' + order.price + ')', [
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
    order.payment === 'Robux'
      ? 'Robux order: they can review once they own the game pass.'
      : 'Check the payment, then press "Confirm payment" at https://3iaw.com/reviews-admin.html so they can review it.',
    'Reply to this email to answer the buyer directly.',
  ], order.email).catch((e) => console.error('order email', e)));

  return json({ ok: true, orderId });
}

async function contact(req, env, ctx) {
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

  ctx.waitUntil(notifyOwner(env, 'Message from ' + msg.name + ': ' + msg.topic, [
    'New message on 3iaw.com',
    '',
    'Name:     ' + msg.name,
    'Reply to: ' + msg.replyTo + (EMAIL_RE.test(msg.replyTo) ? '' : '  (Discord, not an email)'),
    'Topic:    ' + msg.topic,
    '',
    msg.message,
  ], msg.replyTo).catch((e) => console.error('contact email', e)));

  return json({ ok: true });
}

// ---------- admin: orders and messages ----------

async function orders(req, env) {
  if (!isAdmin(req, env)) return json({ error: 'Wrong admin key.' }, 401);

  if (req.method === 'GET') {
    const [list, messages] = await Promise.all([listJson(env, 'order:'), listJson(env, 'message:')]);
    const marks = await Promise.all(list.map((o) => env.DATA.get('paid:' + o.orderId)));
    return json({
      orders: list.map((o, i) => ({ ...o, paid: Boolean(marks[i]) })).sort((a, b) => b.date.localeCompare(a.date)),
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
    return json({ ok: true, orderId, paid: Boolean(body.paid) });
  }
  return json({ error: 'Method not allowed.' }, 405);
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path === '/api/roblox-stats') return robloxStats(req, ctx);
    if (path === '/api/reviews') return reviews(req, env);
    if (path === '/api/order') return placeOrder(req, env, ctx);
    if (path === '/api/contact') return contact(req, env, ctx);
    if (path === '/api/orders') return orders(req, env);
    if (path.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
    return env.ASSETS.fetch(req);
  },
};
