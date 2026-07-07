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
    // scanner's "scanning the sky over <city>" line and the map zoom-to-location.
    // Per-visitor, never cached.
    if (url.pathname === "/api/geo") {
      const cf = request.cf || {};
      const num = (v) => (v == null || v === "" ? null : Number(v));
      return Response.json(
        {
          city: cf.city || null,
          region: cf.region || null,
          country: cf.country || null,
          colo: cf.colo || null,
          latitude: num(cf.latitude),
          longitude: num(cf.longitude),
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
    let res;
    if (url.pathname.startsWith("/s/")) {
      const base = await env.ASSETS.fetch(new Request(new URL("/", url), request));
      const headers = new Headers(base.headers);
      headers.set("X-Robots-Tag", "noindex");
      res = new Response(base.body, { status: base.status, headers });
    } else {
      // Serve the static site (HTML/CSS/JS/images) from ./public.
      res = await env.ASSETS.fetch(request);
    }

    // Markdown for Agents: when the client negotiates for Markdown
    // (Accept: text/markdown), hand back a Markdown rendering of the HTML page.
    // Browsers never send that type, so they keep the HTML by default.
    return negotiateMarkdown(request, res, url);
  },
};

// ---------------------------------------------------------------- markdown negotiation

/**
 * Content negotiation: does the client prefer `text/markdown` over `text/html`?
 * Parses the Accept header per RFC 7231 q-values so a browser (which lists
 * text/html and never text/markdown) always resolves to HTML, while an agent
 * sending `Accept: text/markdown` resolves to Markdown.
 */
function prefersMarkdown(request) {
  const accept = request.headers.get("Accept");
  if (!accept) return false;
  let mdQ = -1;
  let htmlQ = 0;
  for (const part of accept.split(",")) {
    const [typeRaw, ...params] = part.trim().split(";");
    const type = typeRaw.trim().toLowerCase();
    let q = 1;
    for (const p of params) {
      const m = p.trim().match(/^q=([0-9.]+)$/i);
      if (m) q = parseFloat(m[1]);
    }
    if (type === "text/markdown") mdQ = Math.max(mdQ, q);
    else if (type === "text/html") htmlQ = Math.max(htmlQ, q);
  }
  return mdQ > 0 && mdQ >= htmlQ;
}

/**
 * Cache-Control for a static asset path, or null to leave the asset server's
 * default (HTML: `max-age=0, must-revalidate`). Content-hashed bundles under
 * /assets/ never change under a given name, so they cache forever; stable-named
 * media/data caches a week and revalidates after.
 */
function assetCacheControl(pathname) {
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  if (/\.(png|jpe?g|svg|ico|webp|gif|json|webmanifest|woff2?)$/i.test(pathname)) {
    return "public, max-age=604800, stale-while-revalidate=86400";
  }
  return null;
}

/** Add a field to a Vary header without clobbering any existing entries. */
function appendVary(headers, field) {
  const existing = (headers.get("Vary") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!existing.some((v) => v.toLowerCase() === field.toLowerCase())) {
    existing.push(field);
  }
  headers.set("Vary", existing.join(", "));
}

/**
 * If the client wants Markdown and `res` is an HTML page, return the Markdown
 * rendering; otherwise return `res` unchanged (but always `Vary: Accept`, so a
 * cache never serves an HTML body to an agent or vice versa).
 */
async function negotiateMarkdown(request, res, url) {
  const isHtml = (res.headers.get("Content-Type") || "").includes("text/html");

  if (!isHtml || res.status !== 200 || !prefersMarkdown(request)) {
    const headers = new Headers(res.headers);
    appendVary(headers, "Accept");
    // Long-lived caching for static assets (run_worker_first routes every asset
    // request through here, so the Worker is the authoritative place to set it).
    const cc = assetCacheControl(url.pathname);
    if (cc && res.status === 200) headers.set("Cache-Control", cc);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  const headers = new Headers();
  const cacheControl = res.headers.get("Cache-Control");
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  const robots = res.headers.get("X-Robots-Tag");
  if (robots) headers.set("X-Robots-Tag", robots);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  headers.set("Vary", "Accept");

  // HEAD carries no body to convert — advertise the type and stop there.
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const html = await res.text();
  const { markdown, tokens, originalTokens } = await htmlToMarkdown(html, url);
  headers.set("x-markdown-tokens", String(tokens));
  headers.set("x-original-tokens", String(originalTokens));
  return new Response(markdown, { status: 200, headers });
}

/** Decode the HTML entities that survive into text (and the ones HTMLRewriter
 *  produces when it escapes our inserted markdown punctuation). `&amp;` is done
 *  last so an entity like `&amp;gt;` doesn't get decoded twice. */
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch (_) {
    return "";
  }
}

/**
 * Convert an HTML page to Markdown at the edge using HTMLRewriter (streaming,
 * zero-dependency). Non-content chrome (scripts, styles, ads, the surveillance
 * pill, the starfield canvas) is dropped; headings, paragraphs, emphasis, lists,
 * blockquotes and links are mapped to their Markdown equivalents. The document
 * <title> and meta description become YAML frontmatter.
 *
 * We insert NUL sentinels for intentional line breaks so that, afterwards, every
 * run of real HTML whitespace can be collapsed to a single space without
 * touching the structure we deliberately added.
 */
async function htmlToMarkdown(html, pageUrl) {
  const meta = { title: "", description: "", image: "" };
  const NL = "\uE000"; // one line break
  const BR = "\uE000\uE000"; // blank line (block separator)

  const wrap = (open, close) => ({
    element(el) {
      el.before(open);
      el.after(close);
      el.removeAndKeepContent();
    },
  });
  const heading = (level) => wrap(BR + "#".repeat(level) + " ", BR);

  const drop =
    "script, style, noscript, template, link, meta, canvas, svg, iframe, ins," +
    " .ad-slot, aside[aria-label='Advertisement'], .watcher, .vignette";

  const transformed = new HTMLRewriter()
    // Frontmatter sources — read before the generic `meta`/`title` drop rules run.
    .on("title", { text(t) { meta.title += t.text; } })
    .on('meta[name="description"]', {
      element(el) { meta.description = el.getAttribute("content") || meta.description; },
    })
    .on('meta[property="og:image"]', {
      element(el) { meta.image = el.getAttribute("content") || meta.image; },
    })
    // Structural chrome we never want in the Markdown body.
    .on("title", { element(el) { el.remove(); } })
    .on(drop, { element(el) { el.remove(); } })
    // Block elements.
    .on("h1", heading(1))
    .on("h2", heading(2))
    .on("h3", heading(3))
    .on("h4", heading(4))
    .on("h5", heading(5))
    .on("h6", heading(6))
    .on("p", wrap(BR, BR))
    .on("blockquote", wrap(BR + "> ", BR))
    .on("summary", wrap(BR + "**", "**" + BR)) // <details> question → bold line
    .on("ul", wrap(BR, BR))
    .on("ol", wrap(BR, BR))
    .on("li", { element(el) { el.before(NL + "- "); el.removeAndKeepContent(); } })
    .on("hr", { element(el) { el.replace(BR + "---" + BR); } })
    .on("br", { element(el) { el.replace(NL); } })
    // Inline elements.
    .on("strong", wrap("**", "**"))
    .on("b", wrap("**", "**"))
    .on("em", wrap("*", "*"))
    .on("i", wrap("*", "*"))
    .on("code", wrap("`", "`"))
    .on("a", {
      element(el) {
        const href = el.getAttribute("href");
        if (!href) return; // anchors without a target: keep the text, drop nothing
        let resolved = href;
        try {
          resolved = new URL(href, pageUrl).toString();
        } catch (_) {
          /* leave non-absolute/odd hrefs as-authored */
        }
        el.before("[");
        el.after("](" + resolved + ")");
        el.removeAndKeepContent();
      },
    })
    .transform(new Response(html));

  const raw = await transformed.text();

  // HTMLRewriter passes through any tag we didn't explicitly rewrite (wrapper
  // <div>/<section>/<span>s, comments, the doctype). Strip those, then decode
  // entities — this also turns the markdown punctuation HTMLRewriter escaped on
  // insertion (e.g. the blockquote ">" became "&gt;") back into real syntax.
  const body = decodeEntities(
    raw
      .replace(/<!--[\s\S]*?-->/g, "") // HTML comments
      .replace(/<!doctype[^>]*>/gi, "") // doctype
      .replace(/<\/?[a-z][^>]*>/gi, "") // any leftover tag (its text is kept)
  )
    .replace(/[ \t\r\n\f\v]+/g, " ") // collapse all real whitespace to one space
    .split(NL)
    .join("\n") // sentinels become the line breaks we intended
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const yaml = (s) => JSON.stringify(s.replace(/\s+/g, " ").trim());
  const frontmatter = [
    "---",
    `title: ${yaml(meta.title)}`,
    meta.description ? `description: ${yaml(meta.description)}` : null,
    meta.image ? `image: ${yaml(meta.image)}` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const markdown = `${frontmatter}\n\n${body}\n`;
  // ~4 chars/token is the usual rough estimate; enough for agents to budget.
  const tokens = Math.ceil(markdown.length / 4);
  const originalTokens = Math.ceil(html.length / 4);
  return { markdown, tokens, originalTokens };
}

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
