# cors-proxy

The Cloudflare Worker deployed at `bingqilin-cors-proxy.thebingchilling.workers.dev`,
used as a fallback whenever a tool in this site needs to call an API that
doesn't send CORS headers of its own (SauceNAO, Reddit's OAuth endpoints,
some torrent-indexer APIs).

This directory exists purely for version control — GitHub Pages can't run
this Worker itself, so it's not part of the site's deploy. Deploy changes
to it manually (Cloudflare dashboard, or `wrangler deploy` if you set up a
`wrangler.toml` locally) after editing `worker.js` here.

## Notes

- Forwards a client-supplied `Authorization` header upstream. This is
  required for Reddit's OAuth token exchange (`Basic` auth) and its
  Bearer-token API calls in `tools/saucenao/index.html` — dropping it
  breaks both silently (Reddit just rejects the request).
- Sets a fixed desktop-Chrome `User-Agent` on every proxied request,
  since some upstreams (including whichever WAF fronts saucenao.com)
  reject requests that self-identify as a bot/library/proxy.
- Is an intentionally open relay (any URL a visitor points the torrent
  search tool at needs to work) with only a basic SSRF guard blocking
  loopback/link-local/private-network hosts.
