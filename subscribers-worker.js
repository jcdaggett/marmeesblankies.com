/**
 * Marmee's Blankets — Subscribers Worker
 *
 * POST /  → captures an email address from the exit-intent popup (or any
 *           future signup form) and stores it in KV. Returns the active
 *           welcome discount code so the popup can reveal it immediately,
 *           without needing an ESP (MailerLite/Klaviyo) wired up yet.
 *
 * SUBSCRIBERS = KV namespace binding (marmees-subscribers).
 * WELCOME_CODE = plain text env var, the promo code to show on signup
 *   (create the matching coupon + promotion code in the Stripe Dashboard).
 */

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Bad request" }, 400, cors); }

    const email = (body.email || "").toString().trim().toLowerCase();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      return json({ error: "Please enter a valid email address" }, 400, cors);
    }

    const key = `sub:${email}`;
    const existing = await env.SUBSCRIBERS.get(key);
    if (!existing) {
      await env.SUBSCRIBERS.put(key, JSON.stringify({
        email,
        source: (body.source || "exit_intent").toString().slice(0, 40),
        subscribedAt: new Date().toISOString(),
      }));
    }

    return json({ ok: true, code: env.WELCOME_CODE || "" }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
