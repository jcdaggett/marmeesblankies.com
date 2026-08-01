/**
 * Marmee's Blankets — Stripe Checkout Worker
 *
 * POST /                       → creates a Stripe Checkout session for a
 *                                ready-made or custom-configured blanket.
 * GET  /?session_id=cs_...     → returns an order summary (item, amount,
 *                                discount, order ref) for the confirmation page.
 *
 * Deploy as a SEPARATE Cloudflare Worker (not the site itself).
 * STRIPE_SECRET_KEY is stored as an encrypted Worker secret — it NEVER
 * appears in the website code.
 *
 * See STRIPE-SETUP.txt for step-by-step deployment.
 */

/**
 * Server-side Meta Conversions API — sends the Purchase event directly from
 * Cloudflare to Meta, using event_id = the Stripe session id so Meta can
 * dedupe against the browser-side pixel event (see index.html, which passes
 * the same session id as fbq's eventID). This is more reliable than the
 * browser pixel alone since ad blockers / Safari tracking prevention can't
 * stop a server-to-server call. Never throws — a CAPI failure must not break
 * the order confirmation page.
 */
async function sendMetaPurchaseEvent(env, s, ref) {
  try {
    const token = env.META_CAPI_TOKEN;
    if (!token) return;
    const pixelId = env.META_PIXEL_ID || "849016838145150";

    const email = ((s.customer_details && s.customer_details.email) || "").trim().toLowerCase();
    const user_data = {};
    if (email) {
      const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
      user_data.em = [Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("")];
    }

    const body = {
      data: [{
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: s.id, // matches client-side fbq eventID for deduplication
        action_source: "website",
        event_source_url: "https://marmeesblankets.com/?paid=1",
        user_data,
        custom_data: {
          currency: (s.currency || "usd").toUpperCase(),
          value: (s.amount_total || 0) / 100,
          content_name: (s.line_items && s.line_items.data && s.line_items.data[0] && s.line_items.data[0].description) || "",
          order_id: ref,
        },
      }],
    };

    await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // swallow — CAPI is best-effort, never blocks the confirmation response
  }
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // ---- GET: order summary for the confirmation page ----
    if (request.method === "GET") {
      const sessionId = new URL(request.url).searchParams.get("session_id");
      if (!sessionId || !sessionId.startsWith("cs_"))
        return json({ error: "Missing session_id" }, 400, cors);

      const resp = await fetch(
        "https://api.stripe.com/v1/checkout/sessions/" +
          encodeURIComponent(sessionId) + "?expand[]=line_items",
        { headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY } }
      );
      const s = await resp.json();
      if (!resp.ok) return json({ error: s.error?.message || "Lookup failed" }, 404, cors);

      const li = (s.line_items && s.line_items.data && s.line_items.data[0]) || {};
      const md = s.metadata || {};
      const spec = [md.front, md.back, md.size, md.edge]
        .filter(v => v && v !== "\u2014").join(" \u00b7 ");
      const ref = (s.payment_intent || s.id || "").toString().slice(-8).toUpperCase();

      if (s.payment_status === "paid") {
        await sendMetaPurchaseEvent(env, s, ref);
      }

      return json({
        paid: s.payment_status === "paid",
        order: ref,
        item: li.description || "Your blanket",
        img: md.img || "",
        spec,
        subtotal: s.amount_subtotal,
        discount: (s.total_details && s.total_details.amount_discount) || 0,
        total: s.amount_total,
        currency: (s.currency || "usd").toUpperCase(),
        email: (s.customer_details && s.customer_details.email) || "",
      }, 200, cors);
    }

    if (request.method !== "POST")
      return json({ error: "POST only" }, 405, cors);

    // ---- POST: create a Checkout session ----
    let order;
    try { order = await request.json(); }
    catch { return json({ error: "Bad request" }, 400, cors); }

    const amount = parseInt(order.amount, 10);
    if (!amount || amount < 100 || amount > 100000)
      return json({ error: "Invalid amount" }, 400, cors);

    const descLines = [
      `Front: ${order.front}`,
      `Back: ${order.back}`,
      `Size: ${order.size}`,
      `Edge: ${order.edge}`,
    ].filter(Boolean).join(" \u00b7 ");

    // Carry the session id into the success URL so the confirmation page
    // can look up exactly what was purchased. Stripe swaps in the real id.
    const base = env.SUCCESS_URL || "https://marmeesblankets.com/?paid=1";
    const sep = base.includes("?") ? "&" : "?";

    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("ui_mode", "embedded_page");
    params.append("return_url", base + sep + "session_id={CHECKOUT_SESSION_ID}");
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", String(amount));
    params.append("line_items[0][price_data][tax_behavior]", "exclusive"); // US: tax added on top
    params.append("line_items[0][price_data][product_data][name]", order.label || "Marmee's Blanket");
    params.append("line_items[0][price_data][product_data][description]", descLines);
    params.append("line_items[0][price_data][product_data][tax_code]", "txcd_99999999"); // General - Tangible Goods
    // Carry the full spec into the order so Marmee sees what to make/ship
    params.append("metadata[front]", order.front || "");
    params.append("metadata[back]", order.back || "");
    params.append("metadata[size]", order.size || "");
    params.append("metadata[edge]", order.edge || "");
    params.append("metadata[img]", order.img || "");
    // Attribution — which channel drove this sale (see index.html getAttribution())
    params.append("metadata[utm_source]", order.utm_source || "");
    params.append("metadata[utm_medium]", order.utm_medium || "");
    params.append("metadata[utm_campaign]", order.utm_campaign || "");
    params.append("metadata[utm_term]", order.utm_term || "");
    params.append("metadata[utm_content]", order.utm_content || "");
    params.append("shipping_address_collection[allowed_countries][0]", "US");
    // Let customers enter a discount/promo code (e.g. THANKYOU20) at checkout.
    // Create the actual coupon + promotion code in the Stripe Dashboard —
    // no code change needed here when you add new codes.
    params.append("allow_promotion_codes", "true");
    params.append("automatic_tax[enabled]", "true"); // Stripe Tax calculates from shipping address

    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    const data = await resp.json();
    if (!resp.ok) return json({ error: data.error?.message || "Stripe error" }, 500, cors);
    return json({ clientSecret: data.client_secret }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
