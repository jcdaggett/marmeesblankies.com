/**
 * Marmee's Blankets — Review Submission Worker
 * Receives a review from leave-a-review.html and stores it in a
 * Cloudflare KV namespace for Jesse to review manually before
 * adding approved ones to the live site.
 *
 * Deploy this as a SEPARATE Cloudflare Worker (not the checkout Worker,
 * not the site itself). See REVIEWS-SETUP.txt for step-by-step deployment.
 */

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST")
      return json({ error: "POST only" }, 405, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Bad request" }, 400, cors); }

    const name = (body.name || "").toString().trim().slice(0, 60);
    const review = (body.review || "").toString().trim().slice(0, 600);
    const rating = parseInt(body.rating, 10);

    if (!name || !review || !rating || rating < 1 || rating > 5) {
      return json({ error: "Missing or invalid fields" }, 400, cors);
    }

    const entry = {
      name,
      review,
      rating,
      submittedAt: new Date().toISOString(),
    };

    // Key = timestamp + random suffix, so entries sort chronologically
    // and never collide.
    const key = `review:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    await env.REVIEWS.put(key, JSON.stringify(entry));

    return json({ ok: true }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
