# Bingqilin Popup Blocker

A Chrome extension that stops the popups and tab-unders the player's video
embeds open. Every frame inside the player is sandboxed, whatever host it
is on, so Chrome refuses to create the tab at all — nothing to close, no
flash, and nothing to set up or click. Anywhere other than the player, it
does nothing.

## What it covers

Three things, all of them only when the tab is on the player:

| Trick | How it is caught |
| --- | --- |
| `window.open()` / `target="_blank"` from inside the embed | `webNavigation.onCreatedNavigationTarget` fires as the target tab is created, and it is closed |
| `window.open()` with no URL, filled in afterwards with `document.write()` | `tabs.onCreated`, matching blank targets on the opener |
| Tab-under — the embed sends *your* tab to the ad and leaves the video in a popup behind it | `webNavigation.onCommitted`, which sends the tab back to the page it was just on |

These three are the **fallback**, and they *close* rather than prevent — so
the tab is created, takes focus, paints and is then removed, which you see
as a flash. Nothing driven from the service worker can be earlier: by the
time Chrome reports a tab was created, it was created.

With the sandbox below in place they see nothing to do. They stay as a
net for anything that gets past it.

## The sandbox

Every frame the player loads is served with

    Content-Security-Policy: sandbox allow-scripts allow-same-origin allow-forms
      allow-modals allow-pointer-lock allow-orientation-lock allow-presentation

added to its response by `declarativeNetRequest`. No `allow-popups` and
no `allow-top-navigation`: Chrome itself refuses every new tab and every
navigation of the player's tab from that frame, and from every frame
nested inside it, whatever script asked. Nothing is created, so there is
nothing to flash.

The header is *appended*. Every CSP header is enforced on its own, so the
source's own policy is left exactly as it was.

Two rules, because a sandbox from a header belongs to the document, not
the frame:

| Rule | Covers |
| --- | --- |
| `rules/sandbox.json` (static): frames this site loads | The embed's first load. It is in place before the player exists, so it cannot lose a race to it |
| A session rule: any frame load inside a movie-player tab | An embed that redirects to a mirror or sends its own frame on to another host, which would otherwise get a fresh, unsandboxed document |

**Any host.** The extension has `<all_urls>`, granted at install, so it
can do this to whatever host an embed starts on or ends up on. Sources
get renewed and mirrors rotate; there is no list of them anywhere, and
nothing to click when they change. Chrome shows "read and change all your
data on all websites" at install because of it — it cannot know the
extension only acts inside the player, which is what the rest of this
file is about.

TVNZ is left out of both rules: Live TV frames TVNZ's own player, which
has to sign in.

The `<iframe sandbox>` attribute gives the same sandbox, and was tried and
dropped because sources refused to play: a sandboxed `window.open` returns
`null`, and they check. That is what the decoy is for.

## The decoy

Closing is always late. The way to have nothing to close is for
`window.open` never to open anything — but return something anyway.
`content/no-popup.js` replaces it, in every frame inside the player, with a
function handing back an object that behaves like a window and is not one:
truthy, `closed === false`, and `document.write` / `location =` / `focus()`
all accepted and discarded. Nothing is created, so there is no flash.

`closed` staying false is the load-bearing part. Popup scripts are written

    var w = window.open(url, "_blank");
    if (!w || w.closed) { /* fall back to redirecting your tab */ }

so a decoy that reports itself closed just pushes them to the tab-under.

Never *refusing* is what keeps the sandbox invisible to the source. A
source that will not play under a sandbox is detecting that `window.open`
failed — here it does not fail, because the decoy answers before the
sandbox is ever asked.

`window.open` returning `null` is not the only way to spot a sandbox, so
the decoy also covers the others a source can check from inside the
frame:

| Check | Sandboxed, unhidden | With the decoy |
| --- | --- | --- |
| `document.domain = document.domain` | Throws "Assignment is forbidden for sandboxed iframes" | Succeeds; an invalid value is still refused as usual |
| `Function.prototype.toString.call(window.open)` | The decoy's own source | `function open() { [native code] }` |
| `window.open.name`, `.length`, own `toString` | `""`, an own property | `"open"`, none — same as native |

Each was checked against the same page outside the player: every answer
matches.

### The targets, which never ask `window.open` at all

`window.open` is the smaller half. The overlay stretched across the video
is an `<a target="_blank">`, and a click on it is a *real* click: Chrome
opens the tab natively, there is no `open()` call to hand a decoy to, and
closing it afterwards is the flash. `target="_top"` and `_parent` are the
same trick pointed the other way — they send the tab the player is in to
the ad, and because a click drove it the navigation carries no
`client_redirect`, so the tab-under rule does not fire on it either.

None of these is a navigation the embed is entitled to make: it is a video
player in an iframe, and it has no business opening tabs or replacing the
one it is in. So `content/no-popup.js` cancels them, in the **capture phase
and without stopping propagation** — the embed's own handlers still run, a
click on the overlay still reaches the player underneath it, and only the
navigation is lost.

Three paths, because two of them never reach a listener:

| Path | Why it needs its own catch |
| --- | --- |
| A click on an `<a>`/`<area>` in the document | The capture listener cancels the default |
| An `<a>` built in script and clicked without ever being inserted | It dispatches to nobody, so no listener sees it — its `click()` is the only place to catch it |
| `form.submit()` | Fires no `submit` event at all |

`<base target="_blank">`, which turns every plain link in the frame into a
popup, is resolved too. Links with no target, or `target="_self"`, are left
exactly as they were.

### Only inside the player

The decoy is declared for every frame on every site, and the first thing
it does is check `location.ancestorOrigins`: the origins of every page
above the frame, readable synchronously and across origins, before any of
the embed's scripts run. Unless the outermost one is this site, it
returns without touching anything. TVNZ's frame, and anything inside it,
is skipped too.

So one of your source domains embedded on somebody else's site, or opened
in a tab of its own, behaves exactly as it would with this extension
uninstalled. The sandbox rules are scoped the same way: one to frames this
site loads, the other to tabs on the movie player.

### Keeping the flash short

Two things used to sit between the popup appearing and it being closed,
and both are gone:

- **A round trip.** The close waited on `chrome.tabs.get` just to ask
  whether the opener was a player tab. That answer is now held in memory,
  so the hot path is a `Map` lookup and a `remove` with no `await` in
  front of it.
- **A cold start.** A service worker is evicted after ~30s idle, so the
  popup was often what woke it — and Chrome had to start the worker before
  anything could close anything. `content/keepalive.js` holds a port open
  while a player tab is open, which keeps the worker resident.

That content script runs in the isolated world, adds no DOM and defines no
globals. It opens a port and goes quiet, so neither the page nor the embed
inside it can see that it is there.

## Where it runs

`https://thebingchilling.pages.dev/`, `/index`, `/index.html`, `/live` and
`/live.html` — the site serves the bare and the `.html` spelling of each,
and its own service worker precaches both.

Nothing else. Not `/tools/*` — the tools pages open tabs on purpose
(torrent links, SauceNAO results, a rendered PDF), and with no UI to
explain a blocked one, a tools page that silently fails to open a link is
worse than an ad. Not any other site either: every rule checks the tab is
the player (`lib/scope.js`) before acting, and the decoy checks its own
ancestors. The tools pages load no frames, so the static sandbox rule —
which can only match on this site's domain — has nothing to act on there.

## What tells a wanted tab from an unwanted one

**The frame that asked for it.** The embed sits in an `<iframe>`, so
everything it opens comes from a frame below the top one. A tab the page
itself opens comes from frame 0 — today that means a middle-clicked
bottom-nav link, and it would equally cover a first-party `window.open` if
one were ever added. `onCreatedNavigationTarget` reports the source frame,
so it skips frame 0 and those keep working.

The tab-under rule works the same idea from the other side: a navigation a
script started is tagged `client_redirect`, and a link you clicked is not.

⚠ **The blank-target rule is the exception** — `tabs.onCreated` does not
report the frame, so it cannot use that test. It narrows itself to blank
targets instead, which is safe only while neither player page opens one.
Neither does today. If one ever does, that is the rule to revisit; the
cheapest fix is to have the page pass `"noopener"`, which leaves Chrome
recording no opener and so no match at all.

## Installing

1. `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → pick this `extension/` folder

## Live TV: the TVNZ channels

Not popups at all, but it needs an extension too. TVNZ 1, TVNZ 2 and DUKE
are Widevine-protected, and TVNZ's licence server only lets a browser
play them with a ticket issued to a signed-in TVNZ+ account, which only
TVNZ's own player asks for. So live.html shows that player,
`www.tvnz.co.nz/player/channel/<id>`, in a frame.

TVNZ forbids being framed: its pages send `X-Frame-Options: SAMEORIGIN`
and `Content-Security-Policy: frame-ancestors 'self'`.
`rules/tvnz-frame.json` is a declarativeNetRequest rule that removes both
from TVNZ responses loaded as frames by this site, or by TVNZ's own pages
inside such a frame (sign-in, redirects). TVNZ's page CSP is only that
`frame-ancestors` line, so removing the header drops nothing else. Pages
opened as tabs are untouched.

`content/tvnz-in-frame.js` runs in the frame's own world before TVNZ's
scripts, only in a TVNZ frame inside this site (never a TVNZ tab, or TVNZ
framed by another site), and does two things there:

- **Turns TVNZ's service worker off.** It is Angular's ngsw, which answers
  every page load from a copy it saved itself, still carrying the headers
  the rule above strips from network responses. A rule can't reach a
  response a service worker makes, so the first visit framed fine and
  every later one was "refused to connect". Registering is refused, and
  one already registered in the frame's storage is removed. live.html
  also loads the frame with `?ngsw-bypass`, which ngsw sends straight to
  the network, so a leftover worker can't serve that load either.
- **Presents a phone or tablet as desktop.** TVNZ's web player won't start
  on one, and shows "Open or Download the TVNZ+ App" instead, deciding
  from `navigator.userAgent` (and `maxTouchPoints` on a Mac user agent).
  This presents the frame as the same browser on desktop, as the
  browser's "Desktop site" option would. Desktop browsers are left alone.

Running in the main world from the manifest needs Chrome 111.

`content/tvnz-frame.js` marks live.html with `data-bq-tvnz-frame`. Without
it, live.html offers TVNZ's site in a new tab instead of a frame that
would only show "refused to connect".

## Building a .crx

`.github/workflows/package-extension.yml` zips this folder and signs it
into a CRX3 on every push to `main`, and attaches the build to a release
when you push a tag like `ext-v1.0.0` (the tag has to match the version in
`manifest.json`, or the run fails rather than shipping a mislabelled
build). The artifact lands on the run either way.

Every CRX is signed, and the key decides the extension's ID — it is the
first 16 bytes of the SHA-256 of the matching public key. The run
generates a key, signs with it, and destroys it, so **each build gets a
different ID.** That only costs you something if you wanted an installed
copy to accept a later build as an update to itself; it will not, so
remove the old copy before installing a new one. The ID of each build is
in its run summary.

To make it stable instead, put a PEM in the `CRX_PRIVATE_KEY` secret and
the workflow uses that with no other change:

```sh
openssl genrsa 4096 | gh secret set CRX_PRIVATE_KEY
```

Keep a copy somewhere outside the repo if you do — losing it puts you back
to a new ID per build.

The packer is `.github/scripts/pack-crx.mjs` — about sixty lines against
`node:crypto` and nothing else. The repo has no `package.json`, and the
one file an npm dependency would have been trusted to produce here is the
signed one, so it writes the container directly.

To build locally:

```sh
cd extension && zip -qrX ../ext.zip . -x '.*' && cd ..
node .github/scripts/pack-crx.mjs ext.zip key.pem ext.crx
```

## downloads/

`/downloads/bingqilin-popup-blocker.{zip,crx}` is what the player's
Settings sheet links to. It is committed, because the site serves it and a
GitHub release asset would be a login-walled detour for anyone just
wanting the thing.

Committed builds rot, so CI diffs both files against `extension/` on every
run and fails if they differ. **After changing anything in `extension/`,
rebuild them:**

```sh
cd extension && zip -qrX ../downloads/bingqilin-popup-blocker.zip . \
  -x '.*' -x 'README.md' && cd ..
node .github/scripts/pack-crx.mjs downloads/bingqilin-popup-blocker.zip \
  key.pem downloads/bingqilin-popup-blocker.crx
```

This file is not in the package — it describes the repo's layout and
build, which a shipped extension has no use for, and including it meant
every docs edit invalidated every built artifact.

Note that Chrome on Windows and macOS refuses `.crx` files dragged in by
hand — off-store installs there need enterprise policy (`ExtensionInstall`
`Forcelist`/`Allowlist`). On Linux it installs, and **Load unpacked**
works everywhere, which is why that is still listed first above.

## Files

- `manifest.json` — MV3; `webNavigation` + `storage` + `scripting` + `declarativeNetRequest`, and `<all_urls>`
- `background.js` — the three rules, and the sandbox rule for player tabs
- `rules/sandbox.json` — the sandbox rule for frames this site loads
- `content/keepalive.js` — keeps the worker resident, tells it which tabs are the player
- `content/no-popup.js` — the decoy window and the target cancelling, in
  every frame inside the player
- `content/tvnz-frame.js` — tells live.html it can frame TVNZ's player
- `rules/tvnz-frame.json` — the header rule that lets it be framed
- `content/tvnz-in-frame.js` — turns TVNZ's service worker off in the frame, and keeps its player from sending phones to its app
- `lib/scope.js` — the path allow-list that defines "the player"
- `../.github/workflows/package-extension.yml` — build and release
- `../.github/scripts/pack-crx.mjs` — the CRX3 writer
