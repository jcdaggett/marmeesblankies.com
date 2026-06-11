/**
 * Marmee's Blankies — Stripe Checkout Worker
 * Creates a secure Stripe Checkout session for a configured blanket.
 *
 * Deploy this as a SEPARATE Cloudflare Worker (not the site itself).
 * Your Stripe SECRET key is stored as an encrypted environment variable
 * here in the Worker — it NEVER appears in the website code.
 *
 * See STRIPE-SETUP.txt for step-by-step deployment.
 */

export default {
  async fetch(request, env) {
    // CORS so the website can call this Worker
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST")
      return json({ error: "POST only" }, 405, cors);

    let order;
    try { order = await request.json(); }
    catch { return json({ error: "Bad request" }, 400, cors); }

    // Basic validation
    const amount = parseInt(order.amount, 10);
    if (!amount || amount < 100 || amount > 100000)
      return json({ error: "Invalid amount" }, 400, cors);

    // Build a readable description of the blanket
    const descLines = [
      `Front: ${order.front}`,
      `Back: ${order.back}`,
      `Edge: ${order.edge}`,
      order.name ? `Name: ${order.name}` : null,
    ].filter(Boolean).join(" · ");

    // Create Stripe Checkout session
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", env.SUCCESS_URL || "https://marmeesblankies.com/?paid=1");
    params.append("cancel_url", env.CANCEL_URL || "https://marmeesblankies.com/#order");
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", String(amount));
    params.append("line_items[0][price_data][product_data][name]", order.label || "Custom Blanket");
    params.append("line_items[0][price_data][product_data][description]", descLines);
    // Carry the full spec into the order so Marmee sees what to make
    params.append("metadata[front]", order.front || "");
    params.append("metadata[back]", order.back || "");
    params.append("metadata[size]", order.size || "");
    params.append("metadata[edge]", order.edge || "");
    params.append("metadata[name]", order.name || "");
    params.append("shipping_address_collection[allowed_countries][0]", "US");

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
    return json({ url: data.url }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
