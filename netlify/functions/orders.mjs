// Orders from the site's order form, for the owner to confirm payments (used by reviews-admin.html).
//   GET  /api/orders                          recent orders, newest first, with whether each is marked paid
//   POST /api/orders  {orderId, paid: bool}   mark an order paid (or undo it)
// Both need the x-admin-key header. A bKash / Nagad buyer can only review once their order is marked paid
// (see netlify/functions/reviews.mjs).
//
// Netlify environment variables: NETLIFY_API_TOKEN and REVIEWS_ADMIN_KEY, the same ones reviews.mjs uses.

import { getStore } from '@netlify/blobs';

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function orders(siteId) {
  const token = process.env.NETLIFY_API_TOKEN;
  if (!token) throw new Error('NETLIFY_API_TOKEN is not set');
  const api = (path) =>
    fetch('https://api.netlify.com/api/v1' + path, { headers: { Authorization: 'Bearer ' + token } }).then((r) => {
      if (!r.ok) throw new Error('netlify api ' + r.status);
      return r.json();
    });
  const form = (await api('/sites/' + siteId + '/forms')).find((f) => f.name === 'order');
  if (!form) return [];
  // the 200 newest orders are plenty to confirm recent payments
  const pages = await Promise.all([1, 2].map((p) => api('/forms/' + form.id + '/submissions?per_page=100&page=' + p)));
  return pages.flat().map((s) => ({
    orderId: String(s.data.order_id || '').toUpperCase(),
    date: s.created_at,
    item: s.data.system,
    price: s.data.price,
    payment: s.data.payment,
    transactionId: s.data.transaction_id || '',
    ugc: s.data.ugc_details || '',
    email: s.data.email,
    username: s.data.roblox_username,
  })).filter((o) => o.orderId);
}

export default async (req, context) => {
  const key = process.env.REVIEWS_ADMIN_KEY;
  if (!key || req.headers.get('x-admin-key') !== key) return json({ error: 'Wrong admin key.' }, 401);
  const paid = getStore('paid-orders');

  try {
    if (req.method === 'GET') {
      const list = await orders(context.site?.id || process.env.SITE_ID);
      const marks = await Promise.all(list.map((o) => paid.get(o.orderId)));
      return json({ orders: list.map((o, i) => ({ ...o, paid: Boolean(marks[i]) })) });
    }
    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
      const orderId = String(body.orderId || '').trim().toUpperCase();
      if (!/^3I-[A-Z0-9]{4,10}$/.test(orderId)) return json({ error: 'Bad order ID.' }, 400);
      if (body.paid) await paid.set(orderId, new Date().toISOString());
      else await paid.delete(orderId);
      return json({ ok: true, orderId, paid: Boolean(body.paid) });
    }
    return json({ error: 'Method not allowed.' }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: "Couldn't load orders right now." }, 502);
  }
};

export const config = { path: '/api/orders' };
