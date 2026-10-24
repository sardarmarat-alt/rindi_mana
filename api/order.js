// Vercel serverless function: POST /api/order
// 1) validates input  2) limits one request per IP per 10 min (atomic, in Supabase)
// 3) stores the order in Supabase  4) emails it to the company via Resend
const crypto = require('crypto');

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAGIC = { // allowed logo files, checked by their first bytes (not just the claimed type)
  'image/png': '89504e47',
  'image/jpeg': 'ffd8ff',
  'application/pdf': '25504446',
};
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY, RESEND_API_KEY, ORDER_TO_EMAIL, ORDER_FROM_EMAIL, IP_SALT } = process.env;
  if (!SUPABASE_URL || !KEY || !RESEND_API_KEY || !ORDER_TO_EMAIL) {
    console.error('Missing env vars:', ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'ORDER_TO_EMAIL'].filter((k) => !process.env[k]).join(', '));
    return res.status(500).json({ error: 'config' });
  }

  const b = req.body && typeof req.body === 'object' ? req.body : {};

  // Bots: filled hidden field or form submitted in under 3 seconds -> pretend success, do nothing.
  if (b.hp || !(Number(b.elapsed) >= 3000)) return res.status(200).json({ ok: true });

  // Validation
  const o = {
    company: clip(b.company, 150),
    contact_name: clip(b.name, 100),
    email: clip(b.email, 200),
    phone: clip(b.phone, 40),
    request_type: clip(b.type, 100),
    quantity: parseInt(b.qty, 10),
    event_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : null,
    packaging: clip(b.packaging, 100),
    label_style: clip(b.style, 100),
    tasting: b.tasting === true,
    message: clip(b.message, 3000),
    page_lang: ['hy', 'en', 'ru'].includes(b.lang) ? b.lang : 'en',
  };
  if (!o.company || !o.contact_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) return res.status(400).json({ error: 'invalid' });
  if (!Number.isInteger(o.quantity) || o.quantity < 1 || o.quantity > 1000000) return res.status(400).json({ error: 'invalid' });

  let attachment = null;
  if (b.logo) {
    const l = b.logo;
    const data = typeof l.data === 'string' ? l.data : '';
    const magic = MAGIC[l.type];
    if (!magic || !/^[A-Za-z0-9+/=]+$/.test(data) || data.length > MAX_LOGO_BYTES * 1.4) return res.status(400).json({ error: 'file' });
    if (Buffer.from(data.slice(0, 16), 'base64').toString('hex').indexOf(magic) !== 0) return res.status(400).json({ error: 'file' });
    attachment = { filename: clip(l.name, 80).replace(/[^\w.\- ]/g, '_') || 'logo', content: data };
  }

  // Hashed client IP (IPv6: first 4 groups ~ the /64 network)
  let ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':');
  const ipHash = crypto.createHash('sha256').update(ip + (IP_SALT || '')).digest('hex');

  const sb = (path, init = {}) =>
    fetch(SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path, {
      ...init,
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });

  // If something fails after the slot was taken, give the slot back so the visitor can retry at once.
  const release = () => sb('rate_limits?ip_hash=eq.' + ipHash, { method: 'DELETE' }).catch(() => {});

  try {
    // Rate limit: one order per IP per 10 minutes (atomic in the database)
    const slot = await sb('rpc/claim_slot', { method: 'POST', body: JSON.stringify({ p_ip: ipHash }) });
    if (!slot.ok) {
      console.error('claim_slot failed', slot.status, await slot.text());
      return res.status(500).json({ error: 'db' });
    }
    if ((await slot.json()) !== true) return res.status(429).json({ error: 'rate' });

    // Save the order
    const saved = await sb('orders', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ...o, has_logo: !!attachment, ip_hash: ipHash }),
    });
    if (!saved.ok) {
      console.error('orders insert failed', saved.status, await saved.text());
      await release();
      return res.status(500).json({ error: 'db' });
    }

    // Email it
    const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v || '-')}</b></td></tr>`;
    const html = `<h2>New order request</h2><table>${row('Company', o.company)}${row('Contact', o.contact_name)}${row('Email', o.email)}${row('Phone', o.phone)}${row('Request', o.request_type)}${row('Bottles', o.quantity)}${row('Date', o.event_date)}${row('Packaging', o.packaging)}${row('Label style', o.label_style)}${row('Tasting', o.tasting ? 'yes' : 'no')}${row('Page language', o.page_lang)}${row('Logo', attachment ? 'attached' : 'none')}</table><p style="white-space:pre-wrap">${esc(o.message)}</p>`;
    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: ORDER_FROM_EMAIL || 'Rindi Mana <onboarding@resend.dev>',
        to: [ORDER_TO_EMAIL],
        reply_to: o.email,
        subject: 'New order request – ' + o.company.replace(/[\r\n]/g, ' '),
        html,
        attachments: attachment ? [attachment] : undefined,
      }),
    });
    if (!mail.ok) {
      console.error('Resend failed', mail.status, await mail.text());
      await release();
      return res.status(502).json({ error: 'email' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('order handler error', e);
    return res.status(500).json({ error: 'server' });
  }
};