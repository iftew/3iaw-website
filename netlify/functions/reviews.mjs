// Buyer reviews for the systems on the site.
//   GET    /api/reviews             list all reviews, newest first
//   POST   /api/reviews             post a review; only works after a purchase is confirmed
//   DELETE /api/reviews?id=<id>     remove a review (needs the x-admin-key header)
//
// How a purchase is confirmed:
//   Robux        the Roblox user must own the item's game pass (Roblox's public is-owned check)
//   bKash/Nagad  the order ID and email must match an order submitted through the site's order form
//
// Netlify environment variables:
//   NETLIFY_API_TOKEN   personal access token, used to read the order form submissions
//   REVIEWS_ADMIN_KEY   any long secret; typed into reviews-admin.html to delete reviews

import { getStore } from '@netlify/blobs';

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

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// a reason the buyer can act on; anything else is reported as a generic failure
class Refusal extends Error {}

async function robloxUser(username) {
  const r = await fetch('https://users.roblox.com/v1/usernames/users', {
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
  const r = await fetch('https://inventory.roblox.com/v1/users/' + user.id + '/items/1/' + GAMEPASSES[item] + '/is-owned');
  if (!r.ok) throw new Error('roblox inventory ' + r.status);
  if ((await r.text()).trim() !== 'true') {
    throw new Refusal(user.name + " doesn't own the " + item + ' game pass. If you bought it, check that you typed the same Roblox account.');
  }
  return { key: 'robux-' + user.id + '-' + item, name: user.name };
}

async function confirmOrder(item, orderId, email, siteId) {
  const token = process.env.NETLIFY_API_TOKEN;
  if (!token) throw new Error('NETLIFY_API_TOKEN is not set');
  const api = (path) =>
    fetch('https://api.netlify.com/api/v1' + path, { headers: { Authorization: 'Bearer ' + token } }).then((r) => {
      if (!r.ok) throw new Error('netlify api ' + r.status);
      return r.json();
    });

  const form = (await api('/sites/' + siteId + '/forms')).find((f) => f.name === 'order');
  if (!form) throw new Refusal("That order ID and email don't match any order.");
  for (let page = 1; page <= 20; page++) {
    const subs = await api('/forms/' + form.id + '/submissions?per_page=100&page=' + page);
    const order = subs.find((s) => String(s.data.order_id).toUpperCase() === orderId);
    if (order) {
      if (String(order.data.email).trim().toLowerCase() !== email) break;
      if (order.data.system !== item) throw new Refusal('Order ' + orderId + ' was for the ' + order.data.system + ', not the ' + item + '.');
      return { key: 'order-' + orderId, name: String(order.data.roblox_username || 'Buyer').slice(0, 40) };
    }
    if (subs.length < 100) break;
  }
  throw new Refusal("That order ID and email don't match any order.");
}

async function list(store) {
  const { blobs } = await store.list();
  const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
  return all.filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
}

export default async (req, context) => {
  const store = getStore('reviews');

  if (req.method === 'GET') return json({ reviews: await list(store) });

  if (req.method === 'DELETE') {
    const key = process.env.REVIEWS_ADMIN_KEY;
    if (!key || req.headers.get('x-admin-key') !== key) return json({ error: 'Wrong admin key.' }, 401);
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ error: 'Missing id.' }, 400);
    await store.delete(id);
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
      buyer = await confirmOrder(item, orderId, email, context.site?.id || process.env.SITE_ID);
    } else {
      return json({ error: 'Pick how you paid.' }, 400);
    }

    // one review per purchase; posting again replaces the earlier one
    const review = { id: buyer.key, item, rating, text, name: buyer.name, method, date: new Date().toISOString() };
    await store.setJSON(buyer.key, review);
    return json({ review });
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.message }, 403);
    console.error(e);
    return json({ error: "Couldn't check your purchase right now. Please try again in a few minutes." }, 502);
  }
};

export const config = { path: '/api/reviews' };
