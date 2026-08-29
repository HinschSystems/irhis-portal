const Stripe = require('stripe');

const SUPABASE_URL = 'https://dzhdwremvptmtacvmxlq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_o1_z3RyBQlz5KRpMPSF83A_ux7nAc2y';

async function supabaseRequest(path, token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: response.ok, status: response.status, data };
}

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Payment service is not configured' });

  const redirectBase = isVercelPreview ? requestOrigin : appUrl;
  if (!redirectBase) return res.status(500).json({ error: 'APP_URL is not configured' });

  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Authentication required' });
  const accessToken = match[1];

  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount < 1 || amount > 50000) {
    return res.status(400).json({ error: 'Invalid payment amount' });
  }

  try {
    const userResult = await supabaseRequest('/auth/v1/user', accessToken);
    const userId = userResult.data?.id;
    if (!userResult.ok || !userId) return res.status(401).json({ error: 'Invalid or expired session' });

    const tenantResult = await supabaseRequest(
      `/rest/v1/tenants?user_id=eq.${encodeURIComponent(userId)}&select=property_id,email,is_active`,
      accessToken
    );
    const tenantRows = Array.isArray(tenantResult.data) ? tenantResult.data : [];
    if (!tenantResult.ok || tenantRows.length !== 1) {
      return res.status(403).json({ error: 'Tenant account not found' });
    }
    const tenant = tenantRows[0];
    if (!tenant.is_active) return res.status(403).json({ error: 'Tenant account is inactive' });

    const propertyResult = await supabaseRequest(
      `/rest/v1/properties?id=eq.${encodeURIComponent(tenant.property_id)}&select=id,address,monthly_rent`,
      accessToken
    );
    const propertyRows = Array.isArray(propertyResult.data) ? propertyResult.data : [];
    if (!propertyResult.ok || propertyRows.length !== 1) {
      return res.status(403).json({ error: 'Property not found' });
    }
    const property = propertyRows[0];
    const email = tenant.email || userResult.data?.email || undefined;

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Rent payment — ${property.address}` },
          unit_amount: Math.round(amount * 100)
        },
        quantity: 1
      }],
      metadata: {
        irhis_flow: 'tenant_portal',
        user_id: userId,
        property_id: property.id,
        monthly_rent: String(property.monthly_rent)
      },
      success_url: `${redirectBase}/dashboard?paid=success`,
      cancel_url: `${redirectBase}/pay-rent?paid=cancelled`
    });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout session error:', error?.message || error);
    return res.status(500).json({ error: 'Unable to start checkout' });
  }
};
