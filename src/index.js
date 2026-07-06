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

    // Reserved namespace for future dynamic endpoints. Returns 404 for now so
    // nothing accidentally falls through to a static asset.
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // Serve the static site (HTML/CSS/JS/images) from ./public.
    return env.ASSETS.fetch(request);
  },
};
