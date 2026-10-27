# cors-proxy-vercel

A second, independent CORS proxy — a Vercel Edge Function with the exact
same logic as `workers/cors-proxy/worker.js` (see that file's header
comment for why it's identical). It exists because apibay.org rate-limits
by source IP, and Cloudflare Workers all share one massive egress IP
pool, so the Cloudflare Worker can get throttled by traffic from
completely unrelated Workers hitting apibay from that same shared range —
nothing to do with this site's own usage. Vercel Edge Functions run on a
genuinely different network, so this gives tools a real second path to
fall back to when that happens.

This directory exists purely for version control — Cloudflare Pages can't run
this function itself, so it's not part of the site's deploy.

## Deploy

1. [Import this repo into a new Vercel project](https://vercel.com/new) (or
   `vercel --prod` from this directory with the Vercel CLI), pointing the
   project root at `workers/cors-proxy-vercel/`. Vercel auto-detects
   `api/proxy.js` as an Edge Function — no `vercel.json` needed.
2. Note the resulting deployment URL (e.g.
   `https://<project>.vercel.app`). The proxy is then reachable at
   `https://<project>.vercel.app/api/proxy?url=<encoded target URL>` —
   same `?url=` contract as the Cloudflare Worker.
3. Add that URL to the relevant tool's proxy fallback list (see
   `tools/torrents/index.html`'s `CORS_PROXY`/`corsProxyList()`) so it's
   tried after the Cloudflare Worker.

To update: edit `api/proxy.js` here and redeploy (Vercel redeploys
automatically on a push if the project is connected to this repo via Git,
otherwise re-run `vercel --prod`).

## Notes

Same behavior as the Cloudflare Worker — see `workers/cors-proxy/README.md`
for the details (Authorization forwarding, fixed desktop-Chrome
User-Agent, open-relay SSRF guard). Keep the two files in sync if you
change one; they're meant to behave identically.
