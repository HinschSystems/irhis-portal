const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const requestOrigin = req.headers.origin || '';
  const isVercelPreview = /^https:\/\/irhis-portal-[a-z0-9-]+\.vercel\.app$/i.test(requestOrigin);
  const allowedOrigin = requestOrigin === appUrl || isVercelPreview ? requestOrigin : appUrl;

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Payment service is not configured' });

  const redirectBase = isVercelPreview ? requestOrigin : appUrl;
  if (!redirectBase) return res.status(500).json({ error: 'APP_URL is not configured' });

  const amount = Number(req.body?.amount);
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  if (!Number.isFinite(amount) || amount < 1 || amount > 50000) return res.status(400).json({ error: 'Invalid payment amount' });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: address ? `Rent payment — ${address}` : 'Rent payment' },
          unit_amount: Math.round(amount * 100)
        },
        quantity: 1
      }],
      success_url: `${redirectBase}/dashboard?paid=success`,
      cancel_url: `${redirectBase}/pay-rent?paid=cancelled`
    });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout session error:', error?.message || error);
    return res.status(500).json({ error: 'Unable to start checkout' });
  }
};
