const Stripe = require('stripe');
const SUPABASE_URL = 'https://dzhdwremvptmtacvmxlq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_o1_z3RyBQlz5KRpMPSF83A_ux7nAc2y';
const TEST_EMAIL = 'irhis-e2e-1787956955399@example.com';
const TEST_PASSWORD = 'IrhisTest!1787956955399Aa';

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: response.ok, status: response.status, data };
}

module.exports = async function handler(req, res) {
  if (String(req.query.gate || '') !== process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const login = await jsonFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD })
    });
    const token = login.data?.access_token;
    const userId = login.data?.user?.id;
    if (!login.ok || !token || !userId) return res.status(200).json({ pass: false, stage: 'login', loginStatus: login.status, loginData: login.data });

    const origin = `https://${req.headers.host}`;
    const checkout = await jsonFetch(`${origin}/api/create-checkout-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: origin,
        'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      },
      body: JSON.stringify({ amount: 950, email: 'spoofed@example.com', address: 'Spoofed Address' })
    });
    if (!checkout.ok || !checkout.data?.url) return res.status(200).json({ pass: false, stage: 'checkout', checkoutStatus: checkout.status, checkoutData: checkout.data, userId });

    const match = String(checkout.data.url).match(/(cs_[^/?#]+)/);
    if (!match) return res.status(200).json({ pass: false, stage: 'checkout_url', checkoutUrl: checkout.data.url });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(match[1]);
    return res.status(200).json({
      pass:
        session.metadata?.irhis_flow === 'tenant_portal' &&
        session.metadata?.user_id === userId &&
        session.metadata?.property_id === '26c4a779-9444-4fd8-b2da-1258358cf063' &&
        session.metadata?.monthly_rent === '950' &&
        session.customer_details?.email !== 'spoofed@example.com' &&
        session.amount_total === 95000,
      loginStatus: login.status,
      checkoutStatus: checkout.status,
      userId,
      session: {
        id: session.id,
        amount_total: session.amount_total,
        payment_status: session.payment_status,
        customer_email: session.customer_details?.email || session.customer_email,
        metadata: session.metadata,
        success_url: session.success_url,
        cancel_url: session.cancel_url
      }
    });
  } catch (error) {
    return res.status(500).json({ pass: false, error: error?.stack || error?.message || String(error) });
  }
};
