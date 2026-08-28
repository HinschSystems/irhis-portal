const Stripe = require('stripe');

const SUPABASE_URL = 'https://dzhdwremvptmtacvmxlq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_o1_z3RyBQlz5KRpMPSF83A_ux7nAc2y';
const TEST_PROPERTY_ID = '26c4a779-9444-4fd8-b2da-1258358cf063';
const TEST_INVITE = 'testfield9999';

async function sb(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

module.exports = async function handler(req, res) {
  const gate = String(req.query.gate || '');
  if (!process.env.VERCEL_AUTOMATION_BYPASS_SECRET || gate !== process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const runId = Date.now();
  const email = `irhis-e2e-${runId}@example.com`;
  const password = `IrhisTest!${runId}Aa`;
  const out = { runId, previewHost: req.headers.host, tests: {} };

  try {
    // 1) signup preconditions via same public REST/RPC access as browser client
    const prop = await sb(`/rest/v1/properties?invite_code=eq.${encodeURIComponent(TEST_INVITE)}&select=id,address,monthly_rent,invite_code`);
    const property = Array.isArray(prop.data) ? prop.data[0] : null;
    const claimedBefore = await sb('/rest/v1/rpc/property_has_tenant', { method: 'POST', body: { target_property_id: TEST_PROPERTY_ID } });
    out.tests.signupPrecheck = {
      propertyLookupStatus: prop.status,
      property,
      claimedBefore: claimedBefore.data,
      claimedCheckStatus: claimedBefore.status,
      pass: prop.ok && property?.id === TEST_PROPERTY_ID && claimedBefore.ok && claimedBefore.data === false,
    };

    const signup = await sb('/auth/v1/signup', { method: 'POST', body: { email, password } });
    const accessToken = signup.data?.access_token || null;
    const userId = signup.data?.user?.id || null;
    out.tests.signupAuth = {
      status: signup.status,
      userCreated: Boolean(userId),
      sessionReturned: Boolean(accessToken),
      emailConfirmationRequired: Boolean(userId && !accessToken),
    };

    if (!userId) {
      out.tests.signup = { pass: false, reason: 'Auth user was not created', authStatus: signup.status, authResponse: signup.data };
      return res.status(200).json(out);
    }

    // The deployed signup page inserts the tenant row immediately after signUp, using the client state.
    // Test the exact REST insert under the new user's session when one is returned.
    if (!accessToken) {
      out.tests.signup = { pass: false, reason: 'Email confirmation is required, so no authenticated session was returned for the tenant insert/login gate.' };
      return res.status(200).json(out);
    }

    const insertTenant = await sb('/rest/v1/tenants', {
      method: 'POST', token: accessToken,
      headers: { Prefer: 'return=representation' },
      body: { user_id: userId, property_id: TEST_PROPERTY_ID, balance: 0, email },
    });
    const claimedAfter = await sb('/rest/v1/rpc/property_has_tenant', { method: 'POST', body: { target_property_id: TEST_PROPERTY_ID } });
    out.tests.signup = {
      insertStatus: insertTenant.status,
      inserted: insertTenant.data,
      claimedAfter: claimedAfter.data,
      pass: insertTenant.ok && claimedAfter.ok && claimedAfter.data === true,
    };

    // 2) login using password grant, then read own tenant/property exactly as dashboard does
    const login = await sb('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    const loginToken = login.data?.access_token || null;
    const loginUserId = login.data?.user?.id || null;
    let tenantRead = null, propertyRead = null;
    if (loginToken && loginUserId) {
      tenantRead = await sb(`/rest/v1/tenants?user_id=eq.${loginUserId}&select=user_id,property_id,balance,email,is_active,last_charged_month`, { token: loginToken });
      propertyRead = await sb(`/rest/v1/properties?id=eq.${TEST_PROPERTY_ID}&select=id,address,monthly_rent`, { token: loginToken });
    }
    const tenantRow = Array.isArray(tenantRead?.data) ? tenantRead.data[0] : null;
    const propertyRow = Array.isArray(propertyRead?.data) ? propertyRead.data[0] : null;
    out.tests.login = {
      authStatus: login.status,
      sessionReturned: Boolean(loginToken),
      tenantReadStatus: tenantRead?.status,
      tenant: tenantRow,
      propertyReadStatus: propertyRead?.status,
      property: propertyRow,
      pass: Boolean(loginToken && tenantRow?.user_id === loginUserId && tenantRow?.property_id === TEST_PROPERTY_ID && propertyRow?.monthly_rent != null),
    };

    // 3) payment: invoke the actual preview checkout API, then retrieve the created Stripe session.
    const origin = `https://${req.headers.host}`;
    const checkoutRes = await fetch(`${origin}/api/create-checkout-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      },
      body: JSON.stringify({ amount: Number(propertyRow?.monthly_rent || 950), email, address: propertyRow?.address || '9999 Testfield Ln' }),
    });
    const checkoutData = await checkoutRes.json().catch(() => ({}));
    let stripeSession = null;
    if (checkoutRes.ok && checkoutData.url && process.env.STRIPE_SECRET_KEY) {
      const match = String(checkoutData.url).match(/(cs_[^/?#]+)/);
      if (match) {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const s = await stripe.checkout.sessions.retrieve(match[1]);
        stripeSession = {
          id: s.id,
          amount_total: s.amount_total,
          currency: s.currency,
          payment_status: s.payment_status,
          success_url: s.success_url,
          cancel_url: s.cancel_url,
        };
      }
    }
    out.tests.payment = {
      checkoutStatus: checkoutRes.status,
      checkoutUrlReturned: Boolean(checkoutData.url),
      stripeSession,
      pass: checkoutRes.ok && Boolean(checkoutData.url) && stripeSession?.amount_total === Number(propertyRow?.monthly_rent || 950) * 100 && stripeSession?.success_url === `${origin}/dashboard?paid=success` && stripeSession?.cancel_url === `${origin}/pay-rent?paid=cancelled`,
    };

    // 4) security: anonymous tenant read should not expose rows; authenticated test user should only see own tenant row.
    const anonTenantRead = await sb('/rest/v1/tenants?select=user_id,property_id,email');
    const ownTenantRead = await sb('/rest/v1/tenants?select=user_id,property_id,email', { token: loginToken });
    const ownRows = Array.isArray(ownTenantRead.data) ? ownTenantRead.data : [];
    const anonRows = Array.isArray(anonTenantRead.data) ? anonTenantRead.data : [];
    out.tests.security = {
      anonymousStatus: anonTenantRead.status,
      anonymousRowsVisible: anonRows.length,
      authenticatedStatus: ownTenantRead.status,
      authenticatedRowsVisible: ownRows.length,
      authenticatedAllOwn: ownRows.every(r => r.user_id === loginUserId),
      pass: anonRows.length === 0 && ownTenantRead.ok && ownRows.length === 1 && ownRows[0].user_id === loginUserId,
    };

    out.pass = Object.values(out.tests).filter(t => t && typeof t.pass === 'boolean').every(t => t.pass);
    return res.status(200).json(out);
  } catch (error) {
    out.error = error?.stack || error?.message || String(error);
    return res.status(500).json(out);
  }
};
