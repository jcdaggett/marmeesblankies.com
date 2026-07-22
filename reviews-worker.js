/**
 * Marmee's Blankets — Review Worker
 *
 * POST /                        → customer submits a review (from leave-a-review.html).
 *                                 multipart/form-data with fields: name, review, rating,
 *                                 and up to 3 "photo" files. Stored in KV as pending
 *                                 (approved:false); photos (if any) stored in R2.
 * GET  /?list=approved          → PUBLIC. Returns approved reviews for the site.
 * GET  /?list=all&key=ADMIN_KEY → ADMIN. Returns all reviews (pending + approved).
 * POST /?action=approve&key=... → ADMIN. Body {id}. Marks a review approved (publishes it).
 * POST /?action=delete&key=...  → ADMIN. Body {id}. Deletes a review (and its photos in R2).
 *
 * REVIEWS = KV namespace binding (marmees-reviews).
 * REVIEW_PHOTOS = R2 bucket binding (marmees-review-photos).
 * REVIEW_PHOTOS_PUBLIC_URL = env var, the bucket's public base URL
 *   (e.g. https://pub-XXXX.r2.dev) — no trailing slash.
 * ADMIN_KEY = encrypted Worker secret (the moderation password).
 * See REVIEWS-SETUP.txt.
 */

const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB each
const MAX_PHOTOS = 3;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

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
        const raw = await env.REVIEWS.get(id);
        if (raw) {
          const e = JSON.parse(raw);
          const urls = e.imgs || (e.img ? [e.img] : []);
          for (const url of urls) {
            const objectKey = url.split("/").pop();
            await env.REVIEW_PHOTOS.delete(objectKey).catch(() => {});
          }
        }
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

    // ---------- POST: new review submission (multipart/form-data) ----------
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ error: "Expected multipart/form-data" }, 400, cors);
    }

    let form;
    try { form = await request.formData(); }
    catch { return json({ error: "Bad request" }, 400, cors); }

    const name = (form.get("name") || "").toString().trim().slice(0, 60);
    const review = (form.get("review") || "").toString().trim().slice(0, 600);
    const rating = parseInt(form.get("rating"), 10);

    if (!name || !review || !rating || rating < 1 || rating > 5) {
      return json({ error: "Missing or invalid fields" }, 400, cors);
    }

    const key = `review:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const imgs = [];

    const photos = form.getAll("photo").filter(p => p && typeof p === "object" && p.size > 0);
    if (photos.length > MAX_PHOTOS) {
      return json({ error: `Please choose up to ${MAX_PHOTOS} photos` }, 400, cors);
    }

    let i = 0;
    for (const photo of photos) {
      if (!ALLOWED_TYPES.includes(photo.type)) {
        return json({ error: "Photos must be JPEG, PNG, or WEBP" }, 400, cors);
      }
      if (photo.size > MAX_PHOTO_BYTES) {
        return json({ error: "Each photo must be under 5MB" }, 400, cors);
      }
      const ext = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
      const objectKey = `${key.replace("review:", "")}-${i}.${ext}`;
      await env.REVIEW_PHOTOS.put(objectKey, await photo.arrayBuffer(), {
        httpMetadata: { contentType: photo.type },
      });
      imgs.push(`${env.REVIEW_PHOTOS_PUBLIC_URL}/${objectKey}`);
      i++;
    }

    const entry = {
      name,
      review,
      rating,
      imgs,
      submittedAt: new Date().toISOString(),
      approved: false,
    };

    await env.REVIEWS.put(key, JSON.stringify(entry));

    return json({ ok: true }, 200, cors);
  },
};

function authed(url, env) {
  const key = (url.searchParams.get("key") || "").trim();
  if (!key || !env.ADMIN_KEY) return false;
  const validKeys = env.ADMIN_KEY.split(",").map(k => k.trim()).filter(Boolean);
  return validKeys.includes(key);
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
        imgs: e.imgs || (e.img ? [e.img] : []),
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
