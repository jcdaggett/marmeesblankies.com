/**
 * Marmee's Blankets — Review Worker
 *
 * POST /                        → customer submits a review (from leave-a-review.html).
 *                                 Stored in KV as pending (approved:false).
 * GET  /?list=approved          → PUBLIC. Returns approved reviews for the site.
 * GET  /?list=all&key=ADMIN_KEY → ADMIN. Returns all reviews (pending + approved).
 * POST /?action=approve&key=... → ADMIN. Body {id}. Marks a review approved (publishes it).
 * POST /?action=delete&key=...  → ADMIN. Body {id}. Deletes a review.
 *
 * REVIEWS = KV namespace binding (marmees-reviews).
 * ADMIN_KEY = encrypted Worker secret (the moderation password).
 * See REVIEWS-SETUP.txt.
 */

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // ---------- GET: list reviews ----------
    if (request.method === "GET") {
      const list = url.searchParams.get("list");
      if (list === "approved") {
        return json({ reviews: await collect(env, true) }, 200, cors);
      }
      if (list === "all") {
        if (!authed(url, env)) return json({ error: "Unauthorized" }, 401, cors);
        return json({ reviews: await collect(env, false) }, 200, cors);
      }
      return json({ error: "Unknown request" }, 400, cors);
    }

    if (request.method !== "POST")
      return json({ error: "POST only" }, 405, cors);

    // ---------- POST: admin actions ----------
    const action = url.searchParams.get("action");
    if (action === "approve" || action === "delete") {
      if (!authed(url, env)) return json({ error: "Unauthorized" }, 401, cors);
      let b; try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400, cors); }
      const id = (b.id || "").toString();
      if (!id.startsWith("review:")) return json({ error: "Bad id" }, 400, cors);
      if (action === "delete") {
        await env.REVIEWS.delete(id);
        return json({ ok: true }, 200, cors);
      }
      const raw = await env.REVIEWS.get(id);
      if (!raw) return json({ error: "Not found" }, 404, cors);
      const entry = JSON.parse(raw);
      entry.approved = true;
      await env.REVIEWS.put(id, JSON.stringify(entry));
      return json({ ok: true }, 200, cors);
    }

    // ---------- POST: new review submission ----------
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
      approved: false,
    };

    const key = `review:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await env.REVIEWS.put(key, JSON.stringify(entry));

    return json({ ok: true }, 200, cors);
  },
};

function authed(url, env) {
  const key = url.searchParams.get("key");
  return !!(key && env.ADMIN_KEY && key === env.ADMIN_KEY);
}

async function collect(env, approvedOnly) {
  const out = [];
  let cursor;
  do {
    const page = await env.REVIEWS.list({ prefix: "review:", cursor });
    for (const k of page.keys) {
      const raw = await env.REVIEWS.get(k.name);
      if (!raw) continue;
      let e; try { e = JSON.parse(raw); } catch { continue; }
      if (approvedOnly && !e.approved) continue;
      out.push({
        id: k.name,
        name: e.name,
        review: e.review,
        rating: e.rating,
        submittedAt: e.submittedAt,
        approved: !!e.approved,
      });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1)); // newest first
  return out;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
