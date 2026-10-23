# Vendored: the live-TV playback engine

Vendored (not fetched from a CDN at runtime) so `/live` works without
depending on a third-party script host.

- `hls.min.js` — plays HLS (`.m3u8`) channels in browsers with no native
  support. Source: [`video-dev/hls.js`](https://github.com/video-dev/hls.js)
  `1.5.17`, npm `dist/hls.min.js`, Apache-2.0.

To update: `npm pack hls.js@<version>`, extract the file named above
from `package/dist/`, and bump the version here. Nothing else references
the version.

It sits in `/shared/vendor/` rather than beside `live.html` because
a `live/` directory would collide with the extensionless `/live` URL that
GitHub Pages serves `live.html` from — which the bottom navigation, the
service worker's precache list and the popup blocker's scope check all
rely on.

It is deliberately **not** in the service worker's `SHELL_URLS`: most
visitors never open `/live`. The `/shared/` rule in `sw.js` caches it
stale-while-revalidate on first use instead, which is the same
treatment the tools' own vendored engines get.

## Why not a CDN with an integrity hash

The engines were loaded from cdnjs, with no `integrity` attribute, in the
`<head>` of `live.html`. That put a third party in a position to run
script on this origin — the same origin whose `localStorage` the
authenticator keeps its TOTP secrets in, unencrypted, by design.

Adding Subresource Integrity would have closed that, but vendoring closes
it and three other things at once: the page no longer blocks on a
third-party connection before first paint, it keeps working when cdnjs is
blocked (which it is, on plenty of networks), and it matches what every
other tool in this repo already does with its engine. Every dependency
here is now a file in the repo.
