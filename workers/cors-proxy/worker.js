/* ═══════════════════════════════════════════════════════════════════════
   Bingqilin CORS proxy — a small, generic Cloudflare Worker.

   Cloudflare Pages can't run a server, so a handful of tools in this toolbox
   (SauceNAO + Reddit lookups in the reverse-image-search tool, arbitrary
   indexer APIs in the torrent search tool) need somewhere else to make
   the actual request when the target doesn't send CORS headers of its
   own. This Worker is that somewhere else: it fetches whatever URL it's
   given, server-side, and hands the response back with CORS headers that
   let the browser read it.

   Usage from the browser:
     GET  <this worker's URL>/?url=<encoded target URL>
     POST <this worker's URL>/?url=<encoded target URL>   (body forwarded as-is)

   Deliberately generic — no per-site special-casing beyond the User-Agent
   nudge below, which a couple of targets (Reddit, notably) require. See
   README.md in this directory for how to deploy this and wire it into
   the tools.

   CHANGE: now also forwards a client-supplied Authorization header
   upstream. Needed for Reddit's OAuth token exchange (Basic auth) and
   Bearer-token API calls — previously stripped, breaking both.
   ═══════════════════════════════════════════════════════════════════════ */

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

// Reddit (and some other APIs) reject or heavily rate-limit requests that
// carry a blank User-Agent, and some WAFs (possibly including whatever
// fronts saucenao.com) specifically block anything self-identifying as a
// bot/proxy/library — so this looks like an ordinary desktop browser
// rather than announcing itself, for every proxied request.
const PROXY_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    // The CORS spec carves Authorization out of the "*" wildcard on
    // purpose — it must always be named explicitly, wildcard or not, or
    // the browser's preflight refuses to let the real request send it at
    // all. Reddit's OAuth calls (Basic for the token exchange, Bearer for
    // the gallery fetch) both depend on this header reaching the Worker,
    // so without this the forwarded-Authorization fix downstream never
    // gets a chance to run.
    //
    // Spelled out as a plain list rather than mixed with "*" — some
    // WebKit/Safari versions (notably iOS, where this broke while working
    // fine in desktop Chrome) parse a combined "*, Authorization" value
    // more strictly and don't treat it as covering Authorization at all.
    // An explicit list has no such ambiguity in any browser.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    // Response headers are invisible to cross-origin JS unless listed
    // here explicitly — X-Final-Url carries the post-redirect URL (see
    // its use below) and would otherwise silently read back empty.
    "Access-Control-Expose-Headers": "X-Final-Url",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function textResponse(body, status, origin) {
  return new Response(body, { status, headers: { ...corsHeaders(origin), "Content-Type": "text/plain; charset=utf-8" } });
}

// Basic SSRF guard — this is an open relay by design (any source URL a
// visitor configures in the torrent search tool needs to work), so this
// only blocks the obviously-not-a-public-API cases: loopback, link-local,
// and private network ranges.
function isBlockedHost(hostname) {
  // URL.hostname wraps an IPv6 literal in brackets ("[::1]"), so strip
  // those before matching — the bare "::1" comparison below never fired
  // against a real parsed URL without this.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "localhost." || h.endsWith(".local") || h.endsWith(".localhost")) return true;
  if (/^127\.|^0\.|^10\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // IPv6 loopback (::1), unique-local (fc00::/7) and link-local (fe80::/10).
  // These have to be anchored to actual IPv6 literals: matching a bare
  // "starts with fc/fd" prefix, as this did, blocks ordinary domain names
  // too — fc2.com is a real image host the reverse-image-search tool wants
  // to reach, and it was being rejected as a private address.
  if (h === "::1" || h === "::") return true;
  if (h.includes(":") && /^(f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?):/.test(h)) return true;
  return false;
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!ALLOWED_METHODS.has(request.method)) {
      return textResponse("Method not allowed.", 405, origin);
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get("url");
    if (!target) {
      return textResponse("Missing ?url= parameter.", 400, origin);
    }

    let targetUrl;
    try { targetUrl = new URL(target); } catch (e) {
      return textResponse("That's not a valid URL.", 400, origin);
    }
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      return textResponse("Only http/https targets are allowed.", 400, origin);
    }
    if (isBlockedHost(targetUrl.hostname)) {
      return textResponse("That host isn't allowed.", 403, origin);
    }

    const fwdHeaders = new Headers();
    const contentType = request.headers.get("Content-Type");
    if (contentType) fwdHeaders.set("Content-Type", contentType);
    fwdHeaders.set("Accept", request.headers.get("Accept") || "*/*");
    fwdHeaders.set("Accept-Language", "en-US,en;q=0.9");
    fwdHeaders.set("User-Agent", PROXY_USER_AGENT);
    // Forwarded as-is (Basic for Reddit's token exchange, Bearer for its
    // API calls) — the caller decides what goes in it, this just passes
    // it through instead of silently dropping it.
    const auth = request.headers.get("Authorization");
    if (auth) fwdHeaders.set("Authorization", auth);

    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: fwdHeaders,
        body: hasBody ? await request.arrayBuffer() : undefined,
        redirect: "follow",
      });
    } catch (err) {
      return textResponse("Upstream fetch failed: " + (err && err.message), 502, origin);
    }

    const outHeaders = new Headers(corsHeaders(origin));
    const upstreamContentType = upstream.headers.get("Content-Type");
    if (upstreamContentType) outHeaders.set("Content-Type", upstreamContentType);
    // upstream.url is the final URL after following any redirects (e.g.
    // Reddit's mobile-app share links, …/s/<token>, redirect to the real
    // post) — exposed so callers that need to resolve a redirect rather
    // than just read its body (see saucenao's resolveShareLink) can do so
    // without a second request.
    outHeaders.set("X-Final-Url", upstream.url);

    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
};
