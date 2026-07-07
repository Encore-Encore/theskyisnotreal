/**
 * theskyisnotreal.com — Cloudflare Worker
 *
 * The site is a static landing page served from ./public via the ASSETS
 * binding. This Worker sits in front of the assets so we have a place to add
 * dynamic behaviour later (a live "watchers online" counter, server-side ad
 * config, house-ad rotation, etc.) without re-architecting.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Canonicalize host: 301 www -> apex, preserving path + query, so search
    // engines see a single canonical URL (matches the <link rel=canonical>).
    if (url.hostname === "www.theskyisnotreal.com") {
      url.hostname = "theskyisnotreal.com";
      return Response.redirect(url.toString(), 301);
    }

    // Email signup: POST /api/subscribe { email } -> stored in D1 (deduped).
    if (url.pathname === "/api/subscribe") {
      return handleSubscribe(request, env);
    }

    // Visitor geo (IP-based, from Cloudflare — no permission prompt). Powers the
    // scanner's "we see you in <city>" surveillance gag. Per-visitor, never cached.
    if (url.pathname === "/api/geo") {
      const cf = request.cf || {};
      return Response.json(
        {
          city: cf.city || null,
          region: cf.region || null,
          country: cf.country || null,
          colo: cf.colo || null,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Reserved namespace for future dynamic endpoints. Returns 404 for now so
    // nothing accidentally falls through to a static asset.
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // Shareable scan permalinks: /s/<id> serves the homepage (no redirect); the
    // client reads the id and reproduces that scan. noindex so search engines
    // don't index infinite variants (canonical already points to "/").
    if (url.pathname.startsWith("/s/")) {
      const res = await env.ASSETS.fetch(new Request(new URL("/", url), request));
      const headers = new Headers(res.headers);
      headers.set("X-Robots-Tag", "noindex");
      return new Response(res.body, { status: res.status, headers });
    }

    // Serve the static site (HTML/CSS/JS/images) from ./public.
    return env.ASSETS.fetch(request);
  },
};

// Basic-but-sane email shape check. Deliberately liberal — the goal is to reject
// obvious junk (empty, no @, no dot), not to fully parse RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/subscribe  { "email": "you@earth.dev" }
 * Validates + normalizes the email, then inserts into D1. Duplicates are a
 * no-op success (idempotent; we don't reveal whether an address already exists).
 * Every failure returns a JSON error the client can surface to the user.
 */
async function handleSubscribe(request, env) {
  if (request.method !== "POST") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "POST" } }
    );
  }

  let email;
  try {
    const body = await request.json();
    email = body && body.email;
  } catch (e) {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof email !== "string") {
    return Response.json({ error: "invalid_email" }, { status: 400 });
  }
  email = email.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_RE.test(email)) {
    return Response.json({ error: "invalid_email" }, { status: 400 });
  }

  try {
    await env.DB.prepare(
      "INSERT INTO subscribers (email) VALUES (?) ON CONFLICT(email) DO NOTHING"
    )
      .bind(email)
      .run();
  } catch (e) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
