/**
 * theskyisnotreal.com, Cloudflare Worker
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

    // Visitor geo (IP-based, from Cloudflare, no permission prompt). Powers the
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

    // Scan beacon: POST /api/scan records a user-initiated sky scan with its
    // Cloudflare edge geo (no PII). Fire-and-forget from the client.
    if (url.pathname === "/api/scan") {
      return handleScan(request, env);
    }

    // Admin analytics snapshot. Both the HTML dashboard (/admin) and its JSON
    // (/api/admin/stats) are gated by Cloudflare Access: the edge requires login
    // before the request arrives, and we ALSO verify the Access JWT here so the
    // route fails closed if the Access application is ever misconfigured or the
    // Worker is reached directly (e.g. via workers.dev).
    if (url.pathname === "/admin" || url.pathname === "/api/admin/stats") {
      const gate = await requireAccess(request, env);
      if (!gate.ok) return gate.response;
      const stats = await getStats(env);
      const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
      if (url.pathname === "/api/admin/stats") {
        return Response.json(stats, { headers });
      }
      return new Response(renderAdmin(stats), {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Reserved namespace for future dynamic endpoints. Returns 404 for now so
    // nothing accidentally falls through to a static asset.
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // A2A (Agent2Agent) surface. This is the real endpoint the site advertises
    // for agent discovery (DNS-AID `_a2a._agents.theskyisnotreal.com` and the
    // well-known Agent Card). The Agent Card describes the agent; /a2a is its
    // JSON-RPC 2.0 endpoint. `agent-card.json` is the current well-known name;
    // `agent.json` is served too for older A2A clients.
    if (
      url.pathname === "/.well-known/agent-card.json" ||
      url.pathname === "/.well-known/agent.json"
    ) {
      return agentCard(url);
    }
    if (url.pathname === "/a2a") {
      return handleA2A(request, url);
    }

    // API catalog (RFC 9727): a machine-readable index of the site's APIs,
    // advertised from the homepage via a `Link: rel="api-catalog"` header.
    if (url.pathname === "/.well-known/api-catalog") {
      return apiCatalog(url);
    }

    // Markdown twins for agents/tools: /<page>.md returns the Markdown rendering
    // of /<page>, forced (no Accept negotiation needed). /index.md is the home
    // page. These are listed in /llms.txt so agents can discover them.
    if (url.pathname.endsWith(".md")) {
      const base = url.pathname === "/index.md" ? "/" : url.pathname.slice(0, -3);
      const ct = (r) => r.headers.get("Content-Type") || "";
      let htmlRes = await env.ASSETS.fetch(new Request(new URL(base, url)));
      if (htmlRes.status !== 200 || !ct(htmlRes).includes("text/html")) {
        htmlRes = await env.ASSETS.fetch(new Request(new URL(base + ".html", url)));
      }
      if (htmlRes.status !== 200 || !ct(htmlRes).includes("text/html")) {
        return new Response("Not found\n", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const html = await htmlRes.text();
      const md = await htmlToMarkdown(html, new URL(base, url));
      return new Response(md.markdown, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "public, max-age=0, must-revalidate",
          Link: AGENT_LINK_HEADER,
          "x-markdown-tokens": String(md.tokens),
          "x-original-tokens": String(md.originalTokens),
        },
      });
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

// ---------------------------------------------------------------- a2a agent

// A2A is a public, unauthenticated agent, so allow cross-origin calls (browser
// agents included) and answer CORS preflight.
const A2A_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * A2A Agent Card (served at the well-known paths). Describes the agent and,
 * crucially, points at the JSON-RPC endpoint via an absolute `url` derived from
 * the request origin (apex host, since www is 301'd away).
 */
function agentCard(url) {
  const card = {
    protocolVersion: "0.2.5",
    name: "Deception Detector",
    description:
      "A satirical A2A agent for theskyisnotreal.com. Give it a location or a " +
      "claim and it returns a (tongue-in-cheek) verdict on whether the sky is real.",
    url: `${url.origin}/a2a`,
    preferredTransport: "JSONRPC",
    version: "1.0.0",
    provider: {
      organization: "theskyisnotreal.com",
      url: url.origin,
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "deception-scan",
        name: "Deception Detector scan",
        description:
          "Analyzes a location or claim and returns a satirical verdict on the " +
          "sky's authenticity. Entertainment only; the sky is, in fact, probably real.",
        tags: ["satire", "sky", "scan"],
        examples: ["Scan the sky over Denver", "Is the sky real?"],
      },
    ],
  };
  return Response.json(card, {
    headers: { ...A2A_CORS, "Cache-Control": "public, max-age=3600" },
  });
}

// ---------------------------------------------------------------- discovery links

/**
 * API catalog (RFC 9727) as a linkset (RFC 9264). Indexes the site's agent-
 * facing API, the A2A endpoint, and links its machine-readable description
 * (the Agent Card). Served as application/linkset+json.
 */
function apiCatalog(url) {
  const o = url.origin;
  const catalog = {
    linkset: [
      {
        anchor: `${o}/a2a`,
        "service-desc": [
          {
            href: `${o}/.well-known/agent-card.json`,
            type: "application/json",
            title: "A2A Agent Card",
          },
        ],
        "service-doc": [
          { href: `${o}/`, type: "text/html", title: "the sky is not real" },
        ],
      },
    ],
  };
  return Response.json(catalog, {
    headers: {
      "Content-Type": "application/linkset+json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * RFC 8288 Link header advertised on HTML pages, pointing agents at the API
 * catalog and the machine-readable Agent Card. Paths are origin-relative so the
 * header is host-agnostic.
 */
const AGENT_LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</.well-known/agent-card.json>; rel="service-desc"; type="application/json"',
].join(", ");

/** JSON-RPC 2.0 error response (HTTP 200, the transport succeeded). */
function rpcError(id, code, message) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { headers: A2A_CORS }
  );
}

/** JSON-RPC 2.0 success response. */
function rpcResult(id, result) {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: A2A_CORS });
}

/**
 * A2A JSON-RPC 2.0 endpoint. Stateless: `message/send` returns an agent Message
 * directly (no Task lifecycle). Streaming and task storage aren't supported, so
 * those methods return the appropriate JSON-RPC errors.
 */
async function handleA2A(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: A2A_CORS });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...A2A_CORS, Allow: "POST, OPTIONS" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return rpcError(null, -32700, "Parse error");
  }

  const { jsonrpc, id, method, params } = body || {};
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return rpcError(id ?? null, -32600, "Invalid Request");
  }

  switch (method) {
    case "message/send": {
      const parts = params && params.message && params.message.parts;
      const userText = Array.isArray(parts)
        ? parts
            .filter((p) => p && (p.kind === "text" || typeof p.text === "string"))
            .map((p) => p.text)
            .join(" ")
            .trim()
        : "";
      return rpcResult(id, {
        kind: "message",
        role: "agent",
        messageId: crypto.randomUUID(),
        parts: [{ kind: "text", text: skyVerdict(userText) }],
      });
    }
    case "message/stream":
      return rpcError(id, -32601, "Streaming is not supported by this agent");
    case "tasks/get":
      // Stateless agent, no tasks are ever persisted.
      return rpcError(id, -32001, "Task not found");
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

/** The (satirical) core "skill": turn a prompt into a sky-authenticity verdict. */
function skyVerdict(userText) {
  const subject = userText ? `"${userText.slice(0, 140)}"` : "the sky above you";
  return (
    `Scan complete. Analysis of ${subject} returns a 99.9% synthetic reading: ` +
    `suspiciously consistent hue, render-distance clouds, a sun that follows the ` +
    `observer. Recommendation: keep looking up, keep doubting. ` +
    `(Note: this is a satirical agent. The sky is, in fact, probably real.)`
  );
}

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
    // RFC 8288 discovery links on HTML pages (points agents at the API catalog
    // and Agent Card).
    if (isHtml && res.status === 200) headers.set("Link", AGENT_LINK_HEADER);
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
  headers.set("Link", AGENT_LINK_HEADER);

  // HEAD carries no body to convert, advertise the type and stop there.
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
 * zero-dependency). Non-content chrome (scripts, styles, ads, the status pill,
 * section kickers, the interactive detector UI, the starfield canvas) is dropped;
 * headings, paragraphs, emphasis, lists,
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
    " .ad-slot, aside[aria-label='Advertisement'], .watcher, .vignette," +
    // Decorative / interactive chrome: eyebrow + section kickers, the hero anchor
    // buttons, the whole interactive detector UI, card index numbers, and the
    // field-brief header stamp. Their text is not content and only adds noise.
    " .eyebrow, .section-kicker, .hero__actions, .scanner__panel," +
    " .scanner__controls, .card__index, .brief__head";

  const transformed = new HTMLRewriter()
    // Frontmatter sources, read before the generic `meta`/`title` drop rules run.
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
    .on(".brief__label", wrap(BR + "**", "**" + BR)) // brief label → bold line
    .on(".stats", wrap(BR, BR)) // evidence grid → its own block
    .on(".stat", { element(el) { el.before(NL + "- "); el.removeAndKeepContent(); } }) // stat → list item
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
  // entities, this also turns the markdown punctuation HTMLRewriter escaped on
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
    // A <br> inside a heading (e.g. the hero <h1>the sky<br>is not real</h1>)
    // otherwise splits the heading across two lines and demotes the second half
    // to body text. Headings are single-line in Markdown, so re-join a heading
    // line that is followed by a single newline and more text.
    .replace(/^(#{1,6} .*)\n(?!\n)(\S.*)/gm, "$1 $2")
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

// Basic-but-sane email shape check. Deliberately liberal, the goal is to reject
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

// ---------------------------------------------------------------- scan beacon

/**
 * POST /api/scan, records a single user-initiated scan with the visitor's
 * Cloudflare edge geo (coarse city/region/country, no IP, no other PII). The
 * client fires this fire-and-forget (navigator.sendBeacon) only for scans the
 * user actually runs, reproducing a shared /s/<id> permalink does NOT beacon.
 * Returns 204 (beacons ignore the body); failures never surface to the user.
 */
async function handleScan(request, env) {
  if (request.method !== "POST") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "POST" } }
    );
  }
  const cf = request.cf || {};
  try {
    await env.DB.prepare(
      "INSERT INTO scans (country, region, city) VALUES (?, ?, ?)"
    )
      .bind(cf.country || null, cf.region || null, cf.city || null)
      .run();
  } catch (e) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// ---------------------------------------------------------------- admin: access gate

/**
 * Cloudflare Access gate. In production the Access edge already requires login
 * before the request reaches the Worker; this is defense-in-depth so the route
 * fails CLOSED if Access is misconfigured or the Worker is hit directly. Reads
 * the Access JWT (header or CF_Authorization cookie) and verifies it against the
 * team's public keys. Returns { ok } or { ok:false, response }.
 */
async function requireAccess(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    // Not configured yet, never expose PII by default.
    return {
      ok: false,
      response: Response.json({ error: "admin_not_configured" }, { status: 503 }),
    };
  }
  const token = getAccessToken(request);
  if (!token) {
    return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  }
  const result = await verifyAccessJwt(token, env);
  if (!result.ok) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  return { ok: true, identity: result.payload };
}

/** Access presents its JWT as a request header and/or the CF_Authorization cookie. */
function getAccessToken(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

// Cache the team's signing keys in module scope (short TTL). Access rotates keys,
// so we re-fetch hourly rather than pinning.
let accessKeysCache = { keys: null, exp: 0 };

async function getAccessKeys(teamDomain) {
  const now = Date.now();
  if (accessKeysCache.keys && now < accessKeysCache.exp) return accessKeysCache.keys;
  const resp = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!resp.ok) throw new Error(`access certs fetch failed: ${resp.status}`);
  const { keys } = await resp.json();
  accessKeysCache = { keys: keys || [], exp: now + 3600_000 };
  return accessKeysCache.keys;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const bin = atob(s + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Verify a Cloudflare Access RS256 JWT: signature (against the team JWKS), then
 * the standard claims, expiry/not-before, issuer (the team domain), and that
 * the token's audience includes this application's AUD tag.
 */
async function verifyAccessJwt(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false };
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch (e) {
    return { ok: false };
  }
  if (header.alg !== "RS256" || !header.kid) return { ok: false };

  let keys;
  try {
    keys = await getAccessKeys(env.ACCESS_TEAM_DOMAIN);
  } catch (e) {
    return { ok: false };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
  } catch (e) {
    return { ok: false };
  }
  if (!valid) return { ok: false };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now >= payload.exp) return { ok: false };
  if (typeof payload.nbf === "number" && now < payload.nbf) return { ok: false };
  if (payload.iss !== env.ACCESS_TEAM_DOMAIN) return { ok: false };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) return { ok: false };

  return { ok: true, payload };
}

// ---------------------------------------------------------------- admin: stats + view

/**
 * The analytics snapshot: total signups, total scans, the 10 most recent
 * signups, and scan counts grouped by country and by city. Human-visitor counts
 * live in Cloudflare Web Analytics (bots/prefetch make self-counting unreliable),
 * so they're intentionally not synthesized here, the dashboard links out to them.
 */
async function getStats(env) {
  const one = async (sql) => (await env.DB.prepare(sql).first("n")) || 0;
  const many = async (sql) => (await env.DB.prepare(sql).all()).results || [];

  const [subscribers, scans, recent, byCountry, byCity, generatedAt] =
    await Promise.all([
      one("SELECT COUNT(*) AS n FROM subscribers"),
      one("SELECT COUNT(*) AS n FROM scans"),
      many("SELECT email, created_at FROM subscribers ORDER BY id DESC LIMIT 10"),
      many(
        "SELECT COALESCE(country, '??') AS country, COUNT(*) AS n " +
          "FROM scans GROUP BY country ORDER BY n DESC LIMIT 25"
      ),
      many(
        "SELECT COALESCE(city, 'Unknown') AS city, COALESCE(region, '') AS region, " +
          "COALESCE(country, '??') AS country, COUNT(*) AS n " +
          "FROM scans GROUP BY city, region, country ORDER BY n DESC LIMIT 25"
      ),
      one("SELECT datetime('now') AS n"),
    ]);

  return {
    subscribers,
    scans,
    recentSubscribers: recent,
    scansByCountry: byCountry,
    scansByCity: byCity,
    generatedAt,
  };
}

/** Minimal, self-contained HTML for the admin snapshot. No external assets. */
function renderAdmin(stats) {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);

  const emailRows = stats.recentSubscribers.length
    ? stats.recentSubscribers
        .map(
          (r) =>
            `<tr><td>${esc(r.email)}</td><td class="muted">${esc(r.created_at)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="muted">No signups yet.</td></tr>`;

  const countryRows = stats.scansByCountry.length
    ? stats.scansByCountry
        .map((r) => `<tr><td>${esc(r.country)}</td><td>${esc(r.n)}</td></tr>`)
        .join("")
    : `<tr><td colspan="2" class="muted">No scans yet.</td></tr>`;

  const cityRows = stats.scansByCity.length
    ? stats.scansByCity
        .map((r) => {
          const place = [r.city, r.region].filter(Boolean).join(", ") || r.city;
          return `<tr><td>${esc(place)}</td><td>${esc(r.country)}</td><td>${esc(r.n)}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="3" class="muted">No scans yet.</td></tr>`;

  // One-click links to the external consoles this site depends on. These open the
  // provider dashboards directly (the admin page itself is already behind Access).
  const CF_ACCOUNT = "fe2b858cf26189abb6c1205983b1d012";
  const CF_D1 = "14e337e8-88d8-40a5-bd7a-d0248511ace2";
  const consoles = [
    ["Google Search Console", "https://search.google.com/search-console?resource_id=sc-domain:theskyisnotreal.com"],
    ["Bing Webmaster Tools", "https://www.bing.com/webmasters/home?siteUrl=https%3A%2F%2Ftheskyisnotreal.com"],
    ["Google AdSense", "https://adsense.google.com/adsense/home"],
    ["Cloudflare dashboard", "https://dash.cloudflare.com/" + CF_ACCOUNT],
    ["Cloudflare · Worker", `https://dash.cloudflare.com/${CF_ACCOUNT}/workers/services/view/theskyisnotreal/production`],
    ["Cloudflare · D1", `https://dash.cloudflare.com/${CF_ACCOUNT}/workers/d1/databases/${CF_D1}`],
    ["Cloudflare · Web Analytics", "https://dash.cloudflare.com/?to=/:account/web-analytics"],
    ["GitHub repo", "https://github.com/Encore-Encore/theskyisnotreal"],
  ];
  const consoleLinks = consoles
    .map(
      ([label, href]) =>
        `<a class="link" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Admin snapshot · the sky is not real</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px 20px; background: #05060a; color: #e8ecf5;
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #8b93a7; margin: 0 0 28px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
           gap: 14px; margin-bottom: 32px; }
  .card { background: #0d1018; border: 1px solid #1c2130; border-radius: 12px; padding: 18px 20px; }
  .card .n { font-size: 30px; font-weight: 700; }
  .card .l { color: #8b93a7; font-size: 13px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: #9aa3ba;
       margin: 28px 0 10px; }
  .links { display: flex; flex-wrap: wrap; gap: 10px; }
  .link { display: inline-block; padding: 9px 14px; border-radius: 10px; text-decoration: none;
          background: #0d1018; border: 1px solid #1c2130; color: #cdd6ea; font-size: 13px; }
  .link:hover { border-color: #2b3550; color: #eaf0ff; }
  table { width: 100%; border-collapse: collapse; background: #0d1018;
          border: 1px solid #1c2130; border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid #161b28; }
  th { color: #8b93a7; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  tr:last-child td { border-bottom: 0; }
  td:last-child, th:last-child { text-align: right; }
  .muted { color: #6a7285; }
  .note { margin-top: 28px; color: #6a7285; font-size: 13px; }
  a { color: #6ea8fe; }
</style></head>
<body><main>
  <h1>Analytics snapshot</h1>
  <p class="sub">the sky is not real · admin</p>

  <div class="cards">
    <div class="card"><div class="n">${esc(stats.subscribers)}</div><div class="l">email signups</div></div>
    <div class="card"><div class="n">${esc(stats.scans)}</div><div class="l">scans run</div></div>
  </div>

  <h2>Consoles</h2>
  <div class="links">${consoleLinks}</div>

  <h2>Last 10 signups</h2>
  <table><thead><tr><th>Email</th><th>Signed up (UTC)</th></tr></thead>
  <tbody>${emailRows}</tbody></table>

  <h2>Scans by country</h2>
  <table><thead><tr><th>Country</th><th>Scans</th></tr></thead>
  <tbody>${countryRows}</tbody></table>

  <h2>Scans by city</h2>
  <table><thead><tr><th>City</th><th>Country</th><th>Scans</th></tr></thead>
  <tbody>${cityRows}</tbody></table>

  <p class="note">Snapshot generated ${esc(stats.generatedAt)} UTC.</p>
</main></body></html>`;
}
