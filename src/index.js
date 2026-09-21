/**
 * theskyisnotreal.com, Cloudflare Worker
 *
 * The site is a static landing page served from ./public via the ASSETS
 * binding. This Worker runs in front of the assets (run_worker_first) and owns
 * the dynamic bits: the www->apex redirect, the /api/* endpoints, the
 * Access-gated admin, the agent surfaces, and the per-scan OG cards.
 */
import { ImageResponse } from "workers-og";
import { reproduce } from "../shared/scan-core.mjs";

// Fonts for the per-scan OG image. Served as static assets (public/fonts) and
// fetched through the ASSETS binding so rendering needs no outbound network
// (workers-og would otherwise fetch a default font from Google at render time).
// Memoized per isolate; the woff files are tiny (~22 KB each).
let CARD_FONTS = null;
async function loadCardFonts(env, url) {
  if (CARD_FONTS) return CARD_FONTS;
  const fetchFont = async (weight) => {
    const res = await env.ASSETS.fetch(
      new Request(new URL(`/fonts/inter-latin-${weight}.woff`, url))
    );
    return res.arrayBuffer();
  };
  const [regular, bold] = await Promise.all([fetchFont(400), fetchFont(700)]);
  CARD_FONTS = [
    { name: "Inter", data: regular, weight: 400, style: "normal" },
    { name: "Inter", data: bold, weight: 700, style: "normal" },
  ];
  return CARD_FONTS;
}

// The site favicon (cloud struck through by a cyan slash), fetched from ASSETS and
// inlined as a data URI so Satori can draw it on the card. Memoized per isolate.
let CARD_LOGO = null;
async function loadLogo(env, url) {
  if (CARD_LOGO) return CARD_LOGO;
  const res = await env.ASSETS.fetch(new Request(new URL("/favicon.svg", url)));
  const svg = await res.text(); // favicon.svg is ASCII, so btoa is safe
  CARD_LOGO = `data:image/svg+xml;base64,${btoa(svg)}`;
  return CARD_LOGO;
}

// Minimal HTML escape for reproduced scan strings interpolated into the card
// markup. The pools contain no HTML-special characters today; this keeps it safe
// if that ever changes. The seed is already validated to [a-z0-9]+.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The per-scan OG card, laid out for workers-og (Satori). Satori needs display:flex
// on every element with more than one child, so the markup is explicit about it.
// 1200x630, deep-space palette + cyan accent to match the site.
function cardHtml(id, scan, logo) {
  const diag = escapeHtml(scan.diag);
  const conf = escapeHtml(scan.conf);
  const permalink = "/s/" + escapeHtml(id);
  return `
  <div style="display:flex;flex-direction:column;width:1200px;height:630px;padding:84px;background:linear-gradient(150deg,#0b1026 0%,#05060a 58%);font-family:Inter;color:#e8ecf5;justify-content:space-between;">
    <div style="display:flex;align-items:center;">
      <img src="${logo}" width="46" height="46" style="margin-right:18px;" />
      <div style="display:flex;font-size:34px;font-weight:700;color:#cfd6e6;">the sky is not real</div>
      <div style="display:flex;align-items:center;border:2px solid rgba(77,214,255,0.4);border-radius:999px;padding:11px 24px;margin-left:auto;">
        <div style="display:flex;width:12px;height:12px;border-radius:999px;background:#4dd6ff;margin-right:12px;"></div>
        <div style="display:flex;font-size:22px;font-weight:700;letter-spacing:3px;color:#8fe6ff;">DECEPTION DETECTOR</div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;">
      <div style="display:flex;font-size:30px;font-weight:700;letter-spacing:16px;color:#8a93a8;margin-bottom:4px;">VERDICT</div>
      <div style="display:flex;font-size:236px;font-weight:700;line-height:0.9;color:#4dd6ff;">FAKE</div>
      <div style="display:flex;font-size:40px;font-weight:700;color:#e8ecf5;margin-top:20px;">${conf}% synthetic</div>
    </div>

    <div style="display:flex;align-items:center;">
      <div style="display:flex;font-size:30px;color:#aeb6c8;">Diagnosis: ${diag}</div>
      <div style="display:flex;font-size:28px;font-weight:700;color:#8fe6ff;margin-left:auto;">${permalink}</div>
    </div>
  </div>`;
}

// Rewrite the homepage's Open Graph / Twitter meta for a specific /s/<id> so the
// shared link unfurls as THAT scan's verdict (image + title + description), all
// derived from the id and matching the card at /s/<id>/og.png. Streaming, via the
// same HTMLRewriter the Markdown twins use. setAttribute escapes the values, so
// the reproduced strings need no manual escaping. The <link rel=canonical> is left
// pointing at "/" on purpose (these variants stay noindex).
function rewriteScanMeta(res, id, origin, scan, geo) {
  const title = `Verdict: FAKE, ${scan.conf}% synthetic`;
  const description = `Diagnosis: ${scan.diag}. ${scan.rec} Scan your own sky on the Deception Detector.`;
  const image = `${origin}/s/${id}/og.png`;
  const pageUrl = `${origin}/s/${id}`;
  const setContent = (value) => ({
    element(el) {
      el.setAttribute("content", value);
    },
  });
  let rewriter = new HTMLRewriter()
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[name="twitter:description"]', setContent(description))
    .on('meta[property="og:image"]', setContent(image))
    .on('meta[name="twitter:image"]', setContent(image))
    .on('meta[property="og:image:type"]', setContent("image/png"))
    .on('meta[property="og:url"]', setContent(pageUrl));

  // If this scan has a recorded location, inject it so the client renders THAT
  // sky (map zoom + city line) instead of the viewer's. Escape "<" so the JSON
  // cannot break out of the <script> element.
  if (geo && (geo.city || geo.country || typeof geo.latitude === "number")) {
    const json = JSON.stringify(geo).replace(/</g, "\\u003c");
    rewriter = rewriter.on("head", {
      element(el) {
        el.append(`<script>window.__SCAN_GEO__=${json};</script>`, { html: true });
      },
    });
  }
  return rewriter.transform(res);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Canonicalize host: 301 www -> apex, preserving path + query, so search
    // engines see a single canonical URL (matches the <link rel=canonical>).
    if (url.hostname === "www.theskyisnotreal.com") {
      url.hostname = "theskyisnotreal.com";
      return Response.redirect(url.toString(), 301);
    }

    // Per-scan Open Graph image: /s/<id>/og.png renders THAT scan's verdict as a
    // 1200x630 card, reproduced deterministically from the id (the same seed the
    // client scanner replays). Immutable + long-cached because a given id always
    // yields the same card. Handled ABOVE the /s/ HTML branch below, which would
    // otherwise swallow it, and below the www->apex 301 so the image has one
    // canonical host. The id is length-capped to bound the cache-key surface.
    {
      const ogMatch = url.pathname.match(/^\/s\/([a-z0-9]{1,64})\/og\.png$/i);
      if (ogMatch) {
        // The card is deterministic per id, so cache the rendered bytes (Satori +
        // resvg is CPU-heavy) and serve subsequent hits from the edge cache.
        const cache = caches.default;
        const cacheKey = new Request(url.toString());
        const hit = await cache.match(cacheKey);
        if (hit) return hit;

        try {
          const scan = reproduce(ogMatch[1]);
          const [fonts, logo] = await Promise.all([
            loadCardFonts(env, url),
            loadLogo(env, url),
          ]);
          const image = new ImageResponse(cardHtml(ogMatch[1], scan, logo), {
            width: 1200,
            height: 630,
            fonts,
          });
          // Buffer once so the same bytes feed both the cache and the response.
          const body = await image.arrayBuffer();
          const res = new Response(body, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          });
          ctx.waitUntil(cache.put(cacheKey, res.clone()));
          return res;
        } catch (err) {
          // A render regression (Satori/resvg) should degrade to the static site
          // card, not surface an exception page on the image URL. Do not cache the
          // fallback, so a fix takes effect immediately.
          console.error("og-card render failed", err);
          const fallback = await env.ASSETS.fetch(
            new Request(new URL("/og-image.jpg", url))
          );
          return new Response(fallback.body, {
            status: 200,
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "no-store",
            },
          });
        }
      }
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

    // Public "skies scanned" counter (total scan count). No PII, cached briefly.
    if (url.pathname === "/api/stats") {
      return publicStats(env);
    }

    // Public "recently scanned" feed: the last 5 scans, coarse city + the verdict
    // reproduced from the seed. Cached briefly so it feels live but stays cheap.
    if (url.pathname === "/api/scans/recent") {
      return recentScans(env);
    }

    // Admin analytics snapshot. Both the HTML dashboard (/admin) and its JSON
    // (/api/admin/stats) are gated by Cloudflare Access: the edge requires login
    // before the request arrives, and we ALSO verify the Access JWT here so the
    // route fails closed if the Access application is ever misconfigured or the
    // Worker is reached directly (e.g. via workers.dev). Both take the same query
    // string, which picks the scans explorer view (see getScanView).
    if (url.pathname === "/admin" || url.pathname === "/api/admin/stats") {
      const gate = await requireAccess(request, env);
      if (!gate.ok) return gate.response;
      const stats = await getStats(env, url.searchParams);
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

      // For a well-formed /s/<id>, rewrite the social-card meta so the shared link
      // unfurls as that scan's verdict, reproduced from the id (image lives at
      // /s/<id>/og.png). Other /s/* shapes just serve the homepage unchanged.
      const idMatch = url.pathname.match(/^\/s\/([a-z0-9]{1,64})\/?$/i);
      if (idMatch && res.status === 200) {
        const id = idMatch[1];
        const geo = await scanGeoBySeed(env, id);
        res = rewriteScanMeta(res, id, url.origin, reproduce(id), geo);
      }
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
  // The beacon may carry the scan's seed so the public feed can reproduce its
  // verdict. Optional and untrusted: validate to the client id shape or drop it.
  let seed = null;
  try {
    const body = await request.json();
    if (body && typeof body.seed === "string" && /^[a-z0-9]{1,64}$/i.test(body.seed)) {
      seed = body.seed.toLowerCase();
    }
  } catch (e) {
    /* no/invalid JSON body: seed stays null */
  }
  const num = (v) => {
    const s = typeof v === "string" ? v.trim() : v;
    if (s == null || s === "") return null;
    const n = Number(s);
    // Round to ~1km. Cloudflare gives a city centroid, and the map only zooms to
    // region scale, so this stays coarse and matches the PII stance.
    return isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  try {
    await env.DB.prepare(
      "INSERT INTO scans (country, region, city, seed, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(
        cf.country || null,
        cf.region || null,
        cf.city || null,
        seed,
        num(cf.latitude),
        num(cf.longitude)
      )
      .run();
  } catch (e) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/**
 * Public "skies scanned" counter. Just the total count, no PII. Cached for a
 * minute so the homepage widget is effectively free.
 */
async function publicStats(env) {
  let scans = 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM scans").first();
    scans = (row && row.n) || 0;
  } catch (e) {
    /* best-effort: fall back to 0 rather than error the widget */
  }
  return Response.json({ scans }, { headers: { "Cache-Control": "public, max-age=60" } });
}

/**
 * Public "recently scanned" feed: the last 5 scans that carry a seed, with the
 * verdict reproduced from that seed. Exposes coarse edge geo (city/region/country)
 * by design (see the PII note in CLAUDE.md); never IPs. Cached briefly so it feels
 * live without hammering D1.
 */
async function recentScans(env) {
  let rows = [];
  try {
    const res = await env.DB.prepare(
      "SELECT city, region, country, seed, created_at FROM scans WHERE seed IS NOT NULL ORDER BY id DESC LIMIT 5"
    ).all();
    rows = res.results || [];
  } catch (e) {
    /* best-effort: empty feed rather than an error */
  }
  const scans = rows.map((r) => {
    const v = reproduce(r.seed);
    return {
      city: r.city || null,
      region: r.region || null,
      country: r.country || null,
      // The canonical settled verdict (always FAKE), so the feed agrees with the
      // /s/<id> card and page for the same id (the 2% "REAL?!" only flashes on-page).
      verdict: v.verdict,
      confidence: v.conf,
      seed: r.seed,
      at: r.created_at,
    };
  });
  return Response.json({ scans }, { headers: { "Cache-Control": "public, max-age=15" } });
}

/**
 * Look up the coarse location a scan was taken at, by its seed, so a shared
 * /s/<id> can show WHERE the scan happened (map zoom + "scanning the sky over
 * <city>") rather than the viewer's location. Returns null when the seed has no
 * recorded scan (a freshly reproduced or hand-crafted id), in which case the
 * client falls back to the viewer's /api/geo.
 */
async function scanGeoBySeed(env, seed) {
  try {
    // Earliest row for the seed, so a shared link stays pinned to the scan that
    // first minted it (the base-36 seed space is small enough to collide).
    const row = await env.DB.prepare(
      "SELECT city, region, country, latitude, longitude FROM scans WHERE seed = ? ORDER BY id ASC LIMIT 1"
    )
      .bind(seed)
      .first();
    if (!row) return null;
    return {
      city: row.city || null,
      region: row.region || null,
      country: row.country || null,
      latitude: typeof row.latitude === "number" ? row.latitude : null,
      longitude: typeof row.longitude === "number" ? row.longitude : null,
    };
  } catch (e) {
    return null;
  }
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
 * signups, and the scans explorer view picked by the query string. Human-visitor
 * counts live in Cloudflare Web Analytics (bots/prefetch make self-counting
 * unreliable), so they're intentionally not synthesized here, the dashboard links
 * out to them.
 */
async function getStats(env, params) {
  const one = async (sql) => (await env.DB.prepare(sql).first("n")) || 0;
  const many = async (sql) => (await env.DB.prepare(sql).all()).results || [];

  const [subscribers, scans, recent, explorer, generatedAt] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM subscribers"),
    one("SELECT COUNT(*) AS n FROM scans"),
    many("SELECT email, created_at FROM subscribers ORDER BY id DESC LIMIT 10"),
    getScanView(env, params),
    one("SELECT datetime('now') AS n"),
  ]);

  return { subscribers, scans, recentSubscribers: recent, explorer, generatedAt };
}

// The scans explorer: one admin section with three views, chosen by query string
// so every view is a plain link (bookmarkable, back-button friendly, no client JS).
// /api/admin/stats takes the same parameters and returns the same data as JSON.
//
//   /admin                     the last ADMIN_RECENT scans, newest first
//   /admin?view=countries      scan counts per country, each linking to its scans
//   /admin?view=cities         scan counts per city, each linking to its scans
//   /admin?country=US          drill-down: every matching scan, newest first
//   /admin?country=US&region=Colorado&city=Denver
//
// Any of country / region / city makes it a drill-down (`view` is then ignored).
// An absent filter matches anything; a present but empty one matches NULL (unknown
// geo), which is lossless because the beacon never stores an empty string. The
// country and city tables and the drill-downs page with ?page=.
const ADMIN_RECENT = 20;
const ADMIN_PAGE_SIZE = 100;
// The filterable columns. Fixed names, never read from the request, so they are
// safe to splice into SQL; the filter values themselves are always bound.
const ADMIN_FILTERS = ["country", "region", "city"];

/** Read the explorer state ({ view, filter, page }) from the query string. */
function parseScanQuery(params) {
  const filter = {};
  for (const col of ADMIN_FILTERS) {
    if (params.has(col)) filter[col] = params.get(col).trim() || null;
  }
  const requested = params.get("view");
  const view = Object.keys(filter).length
    ? "scans"
    : requested === "countries" || requested === "cities"
      ? requested
      : "recent";
  const page = Math.max(1, parseInt(params.get("page"), 10) || 1);
  return { view, filter, page };
}

/** One scan as the explorer shows it: coarse geo, time, and its reproduced verdict. */
function adminScanRow(r) {
  const v = r.seed ? reproduce(r.seed) : null;
  return {
    at: r.created_at,
    city: r.city,
    region: r.region,
    country: r.country,
    seed: r.seed,
    verdict: v ? v.verdict : null,
    confidence: v ? v.conf : null,
  };
}

/**
 * The explorer's data for the requested view. The recent view is one capped
 * query; the paginated views count first, so an out-of-range ?page= clamps to the
 * last page instead of rendering an empty table.
 */
async function getScanView(env, params) {
  const { view, filter, page } = parseScanQuery(params);

  if (view === "recent") {
    const { results } = await env.DB.prepare(
      "SELECT created_at, country, region, city, seed FROM scans ORDER BY id DESC LIMIT ?"
    )
      .bind(ADMIN_RECENT)
      .all();
    return { view, rows: (results || []).map(adminScanRow) };
  }

  const cols = Object.keys(filter);
  const binds = cols.map((c) => filter[c]);
  // `IS` rather than `=` so a NULL filter value matches the NULL rows.
  const where = cols.length ? ` WHERE ${cols.map((c) => `${c} IS ?`).join(" AND ")}` : "";
  // Per view: the columns, the row source, and a total order (ties broken down to
  // unique keys, so the OFFSET pages of one snapshot never overlap or skip a row;
  // scans arriving between clicks can still shift rows across a page boundary).
  const { select, from, order } = {
    countries: {
      select: "country, COUNT(*) AS n, MAX(created_at) AS last",
      from: "scans GROUP BY country",
      order: "n DESC, last DESC, country",
    },
    cities: {
      select: "city, region, country, COUNT(*) AS n, MAX(created_at) AS last",
      from: "scans GROUP BY city, region, country",
      order: "n DESC, last DESC, country, region, city",
    },
    scans: {
      select: "created_at, country, region, city, seed",
      from: `scans${where}`,
      order: "id DESC",
    },
  }[view];

  const total =
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${from})`)
      .bind(...binds)
      .first("n")) || 0;
  const pages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const current = Math.min(page, pages);
  const { results } = await env.DB.prepare(
    `SELECT ${select} FROM ${from} ORDER BY ${order} LIMIT ? OFFSET ?`
  )
    .bind(...binds, ADMIN_PAGE_SIZE, (current - 1) * ADMIN_PAGE_SIZE)
    .all();

  const rows = (results || []).map((r) =>
    view === "scans"
      ? adminScanRow(r)
      : view === "countries"
        ? { country: r.country, scans: r.n, last: r.last }
        : { city: r.city, region: r.region, country: r.country, scans: r.n, last: r.last }
  );
  return { view, filter, page: current, pages, pageSize: ADMIN_PAGE_SIZE, total, rows };
}

/** HTML-escape for the admin page (text and double-quoted attribute values). */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/** An /admin link to an explorer state that lands on the explorer section. */
function adminHref(params) {
  const qs = new URLSearchParams(params).toString();
  return `/admin${qs ? `?${qs}` : ""}#scans`;
}

// Drill-down params for a row's country, or its exact city. NULL geo is sent as
// an empty value, which the explorer reads back as NULL.
const countryParams = (r) => ({ country: r.country ?? "" });
const cityParams = (r) => ({ country: r.country ?? "", region: r.region ?? "", city: r.city ?? "" });

// Country names ("United States (US)") via the platform's Intl data, built lazily,
// plus the two non-ISO codes Cloudflare's edge geo uses.
const CF_COUNTRIES = { T1: "Tor network", XX: "Unknown" };
let REGION_NAMES = null;
function countryLabel(code) {
  if (!code) return "Unknown";
  let name = CF_COUNTRIES[code];
  try {
    REGION_NAMES = REGION_NAMES || new Intl.DisplayNames(["en"], { type: "region" });
    name = name || REGION_NAMES.of(code);
  } catch (e) {
    /* not a well-formed region code: show it bare */
  }
  return name && name !== code ? `${name} (${code})` : code;
}

/** "Denver, Colorado": the city plus its region, unless the region repeats it. */
function placeLabel(city, region) {
  if (!city && !region) return "Unknown city";
  return region && region !== city ? `${city || "Unknown city"}, ${region}` : city;
}

/** "5m ago" for a D1 UTC timestamp ("YYYY-MM-DD HH:MM:SS"), like the public feed. */
function ago(ts, now) {
  const t = Date.parse(String(ts || "").replace(" ", "T") + "Z");
  if (isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const fmt = (n) => Number(n).toLocaleString("en-US");
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

/** The scans explorer section: view tabs, a trail for drill-downs, the table, a pager. */
function renderScanExplorer(x, totalScans) {
  const now = Date.now();
  const f = x.filter || {};
  const pinsPlace = "city" in f || "region" in f;
  const link = (params, text) => `<a href="${esc(adminHref(params))}">${esc(text)}</a>`;
  // Date and time each stay whole, so a narrow screen only breaks between them.
  const when = (ts) => {
    const rel = ago(ts, now);
    const stamp = String(ts || "")
      .split(" ")
      .map((part) => `<span class="ts">${esc(part)}</span>`)
      .join(" ");
    return stamp + (rel ? ` <span class="ago muted">${esc(rel)}</span>` : "");
  };
  const table = (head, rows, empty) =>
    `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.length ? rows.join("") : `<tr><td colspan="${head.length}" class="muted">${esc(empty)}</td></tr>`}</tbody></table></div>`;
  // Individual scans. A drill-down hides the columns its filter pins to one value.
  const scanTable = (rows, empty, { showPlace = true, showCountry = true } = {}) =>
    table(
      ["When (UTC)", showPlace && "City", showCountry && "Country", "Verdict"].filter(Boolean),
      rows.map((r) => {
        const verdict = r.seed
          ? `<a href="/s/${esc(r.seed)}" target="_blank" rel="noopener">${esc(r.verdict)} · ${esc(r.confidence)}%</a>`
          : `<span class="muted">no seed</span>`;
        return (
          `<tr><td class="nowrap">${when(r.at)}</td>` +
          (showPlace ? `<td>${link(cityParams(r), placeLabel(r.city, r.region))}</td>` : "") +
          (showCountry ? `<td>${link(countryParams(r), countryLabel(r.country))}</td>` : "") +
          `<td>${verdict}</td></tr>`
        );
      }),
      empty
    );

  // A drill-down keeps its parent tab lit: a place under "By city", a country
  // under "By country".
  const active = x.view === "scans" ? (pinsPlace ? "cities" : "countries") : x.view;
  const tabs = [
    ["recent", `Last ${ADMIN_RECENT} scans`, {}],
    ["countries", "By country", { view: "countries" }],
    ["cities", "By city", { view: "cities" }],
  ]
    .map(
      ([key, label, params]) =>
        `<a class="tab" href="${esc(adminHref(params))}"${key === active ? ' aria-current="page"' : ""}>${esc(label)}</a>`
    )
    .join("");

  let trail = "";
  let summary;
  let body;
  if (x.view === "recent") {
    summary =
      x.rows.length < totalScans
        ? `Latest ${x.rows.length} of ${plural(totalScans, "scan", "scans")}`
        : plural(x.rows.length, "scan", "scans");
    body = scanTable(x.rows, "No scans yet.");
  } else if (x.view === "countries") {
    summary = plural(x.total, "country", "countries");
    body = table(
      ["Country", "Scans", "Last scan (UTC)"],
      x.rows.map(
        (r) =>
          `<tr><td>${link(countryParams(r), countryLabel(r.country))}</td><td>${fmt(r.scans)}</td>` +
          `<td class="muted nowrap">${when(r.last)}</td></tr>`
      ),
      "No scans yet."
    );
  } else if (x.view === "cities") {
    summary = plural(x.total, "city", "cities");
    body = table(
      ["City", "Country", "Scans", "Last scan (UTC)"],
      x.rows.map(
        (r) =>
          `<tr><td>${link(cityParams(r), placeLabel(r.city, r.region))}</td>` +
          `<td>${link(countryParams(r), countryLabel(r.country))}</td><td>${fmt(r.scans)}</td>` +
          `<td class="muted nowrap">${when(r.last)}</td></tr>`
      ),
      "No scans yet."
    );
  } else {
    // Drill-down trail: back to the parent table, then the country (a link when a
    // place sits under it), then the place.
    const steps = [pinsPlace ? link({ view: "cities" }, "By city") : link({ view: "countries" }, "By country")];
    if ("country" in f) {
      const label = countryLabel(f.country);
      steps.push(pinsPlace ? link(countryParams(f), label) : esc(label));
    }
    if (pinsPlace) {
      steps.push(esc("city" in f ? placeLabel(f.city, f.region) : f.region || "Unknown region"));
    }
    trail = `<p class="trail">${steps.join(' <span class="muted">›</span> ')}</p>`;
    summary = plural(x.total, "scan", "scans");
    body = scanTable(x.rows, "No scans match this filter.", {
      showPlace: !("city" in f && "region" in f),
      showCountry: !("country" in f),
    });
  }

  let pager = "";
  if (x.pages > 1) {
    summary += ` · page ${x.page} of ${x.pages}`;
    const base =
      x.view === "scans"
        ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v ?? ""]))
        : { view: x.view };
    const at = (page) => (page > 1 ? { ...base, page } : base);
    const [prev, next] = x.view === "scans" ? ["← Newer", "Older →"] : ["← Previous", "Next →"];
    pager =
      `<nav class="pager" aria-label="Pages">` +
      (x.page > 1 ? link(at(x.page - 1), prev) : "<span></span>") +
      (x.page < x.pages ? link(at(x.page + 1), next) : "<span></span>") +
      `</nav>`;
  }

  return `<section id="scans">
  <h2>Scans</h2>
  <nav class="tabs" aria-label="Scan views">${tabs}</nav>
  ${trail}<p class="count">${esc(summary)}</p>
  ${body}
  ${pager}
</section>`;
}

/** Minimal, self-contained HTML for the admin snapshot. No external assets, no JS. */
function renderAdmin(stats) {
  const emailRows = stats.recentSubscribers.length
    ? stats.recentSubscribers
        .map(
          (r) =>
            `<tr><td>${esc(r.email)}</td><td class="muted">${esc(r.created_at)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="muted">No signups yet.</td></tr>`;

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
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
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
  section { scroll-margin-top: 12px; }
  .links { display: flex; flex-wrap: wrap; gap: 10px; }
  .link { display: inline-block; padding: 9px 14px; border-radius: 10px; text-decoration: none;
          background: #0d1018; border: 1px solid #1c2130; color: #cdd6ea; font-size: 13px; }
  .link:hover { border-color: #2b3550; color: #eaf0ff; }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; width: fit-content; max-width: 100%;
          box-sizing: border-box; padding: 4px; margin: 0 0 14px; background: #0d1018;
          border: 1px solid #1c2130; border-radius: 10px; }
  .tab { padding: 7px 14px; border-radius: 7px; color: #9aa3ba; font-size: 13px; text-decoration: none; }
  .tab:hover { color: #eaf0ff; }
  .tab[aria-current] { background: #1c2438; color: #eaf0ff; }
  .trail { margin: 0 0 4px; }
  .trail a { text-decoration: none; }
  .count { margin: 0 0 10px; color: #8b93a7; font-size: 13px; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; background: #0d1018;
          border: 1px solid #1c2130; border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid #161b28; }
  th { color: #8b93a7; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  tr:last-child td { border-bottom: 0; }
  td:last-child, th:last-child { text-align: right; }
  td a { color: #cdd6ea; text-decoration: none; }
  td a:hover { color: #6ea8fe; text-decoration: underline; }
  .nowrap, .ts { white-space: nowrap; }
  .pager { display: flex; justify-content: space-between; margin-top: 10px; font-size: 13px; }
  .muted { color: #6a7285; }
  .note { margin-top: 28px; color: #6a7285; font-size: 13px; }
  a { color: #6ea8fe; }
  @media (max-width: 640px) {
    body { padding: 24px 14px; }
    th, td { padding: 8px 10px; }
    .nowrap { white-space: normal; }
    .ago { display: block; }
  }
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

  ${renderScanExplorer(stats.explorer, stats.scans)}

  <h2>Last 10 signups</h2>
  <table><thead><tr><th>Email</th><th>Signed up (UTC)</th></tr></thead>
  <tbody>${emailRows}</tbody></table>

  <p class="note">Snapshot generated ${esc(stats.generatedAt)} UTC.</p>
</main></body></html>`;
}
