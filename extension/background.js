/* ═══════════════════════════════════════════════════════════════════════
   Close every popup the player opens.

   The player streams from third-party embeds, and those embeds open tabs:
   window.open() on the first click anywhere in the video, target="_blank"
   on an invisible overlay stretched across the whole frame, a blank tab
   written into after the fact. Chrome's own blocker misses nearly all of
   it, because every one of them is technically a click the user made.

   What separates those from a tab the user actually wanted is the frame
   that asked for it. The embed sits in an <iframe>, so everything it opens
   comes from a frame below the top one; a tab the page itself opens — a
   middle-clicked bottom-nav link today, a first-party window.open if one
   is ever added — comes from frame 0. So the frame is the test, and two of
   the three rules below are built around keeping it.

   The third cannot see frames, and leans instead on the narrower fact that
   neither player page currently opens a blank tab. That one is marked, and
   is the one to revisit if that changes.

   Scope is enforced by the permission, not just by the path list below:
   tabs.get() fills in a tab's URL only for hosts the extension can access,
   and the only host in the manifest is thebingchilling.pages.dev. A tab on
   any other site comes back with no URL at all and fails isPlayerUrl()
   before its path is ever considered. /tools/ fails on the path.
   ═══════════════════════════════════════════════════════════════════════ */

import { isPlayerUrl, PLAYER_HOST } from "./lib/scope.js";

const TOP_FRAME = 0;

/* ── How long the popup is on screen ───────────────────────────────────
   Everything between Chrome creating the popup and this closing it is
   time the popup is visible, so the close path is built to have nothing
   in front of it.

   It used to await chrome.tabs.get on every popup, purely to ask whether
   the opener was a player tab — a message to the browser process and back
   before the close could even be requested. And because a service worker
   is evicted after ~30s idle, the popup was frequently what *woke* it, so
   a cold start was on the clock too.

   So the answer is kept here instead, in memory, in a worker that a port
   from content/keepalive.js keeps resident while a player tab is open.
   The hot path is now a Map lookup and a remove, with no await before it.

   The slow path stays for the case the fast one cannot cover: a worker
   that started without the port (an update, a crash) and has not yet
   heard from the tab. It is the old behaviour, used as a fallback. */

const playerTabs = new Map(); // tabId -> the player URL it is on
const noteKey = (tabId) => `player:${tabId}`;

function remember(tabId, url) {
  const isNew = !playerTabs.has(tabId);
  playerTabs.set(tabId, url);
  chrome.storage.session.set({ [noteKey(tabId)]: url });
  if (isNew) syncSandbox();
}

function forget(tabId) {
  if (playerTabs.delete(tabId)) syncSandbox();
  chrome.storage.session.remove(noteKey(tabId));
}

/* A restarted worker has an empty Map but session storage survives, so
   refill from it. Racing a popup that arrives first is fine — that one
   takes the slow path and is closed a few milliseconds later. */
const tabsLoaded = chrome.storage.session.get(null).then((all) => {
  for (const [key, url] of Object.entries(all)) {
    if (!key.startsWith("player:")) continue;
    const tabId = Number(key.slice("player:".length));
    if (Number.isInteger(tabId) && !playerTabs.has(tabId)) playerTabs.set(tabId, url);
  }
}).catch(() => { /* nothing cached yet */ });

/* The content script on each player page. Its port is what keeps this
   worker resident; its sender is what identifies the tab. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "player-tab") return;
  const tab = port.sender?.tab;
  if (!tab || tab.id === undefined || !isPlayerUrl(tab.url)) return;
  remember(tab.id, tab.url);
  port.onMessage.addListener((msg) => {
    if (msg?.type === "sources" && Array.isArray(msg.origins)) setWantedOrigins(msg.origins);
  });
  port.onDisconnect.addListener(() => forget(tab.id));
});

/* Fire and forget: awaiting the removal only delays the next one. */
function close(tabId) {
  chrome.tabs.remove(tabId).catch(() => {
    /* It closed itself first. The job is done either way. */
  });
}

async function isPlayerTab(tabId) {
  if (tabId === undefined || tabId === chrome.tabs.TAB_ID_NONE) return false;
  if (playerTabs.has(tabId)) return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    return isPlayerUrl(tab.url || tab.pendingUrl);
  } catch {
    return false; // tab is already gone
  }
}

/* ── Popups that navigate somewhere ────────────────────────────────────
   onCreatedNavigationTarget covers window.open() and target="_blank"
   alike, and covers popup *windows* too — a window opened with features is
   still a new tab to the tabs API. It fires as the target is created,
   before the popup has painted, so it closes without ever being drawn.

   It also reports which frame asked, which is what keeps the page's own
   tabs alive — today that is a middle-clicked bottom-nav link, and it
   would cover a first-party window.open too. Skipping frame 0 costs the
   blocking nothing, because no embed can ask from there. */
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  if (details.sourceFrameId === TOP_FRAME) return;

  // Deliberately not an async listener: an await here, even one that
  // resolves immediately, puts the close a task later than it needs to be.
  if (playerTabs.has(details.sourceTabId)) {
    close(details.tabId);
    return;
  }
  isPlayerTab(details.sourceTabId).then((yes) => { if (yes) close(details.tabId); });
});

/* ── Popups that do not ────────────────────────────────────────────────
   window.open() with no argument, or with "about:blank", never navigates
   anywhere, so the listener above never hears about it; the opener then
   fills the blank document in with document.write(). It is the standard
   way around a popup blocker, and the only trace it leaves is a new tab
   whose opener is the player.

   ⚠ tabs.onCreated does not report the frame, so this rule cannot use the
   test the other two rest on. It narrows itself to blank targets instead,
   which is safe only while neither player page opens one. If one ever
   does, this is the rule that needs the frame test back — most cheaply by
   having the page pass "noopener", which leaves Chrome recording no opener
   and so no match here at all. */
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return;

  /* Only blank targets. A tab with a real URL in it is the listener
     above's business, and that one can tell a middle-clicked nav link
     from an embed's handiwork; this one cannot, so it must not guess. */
  const target = tab.pendingUrl || tab.url || "";
  if (target !== "" && target !== "about:blank") return;

  if (playerTabs.has(tab.openerTabId)) {
    close(tab.id);
    return;
  }
  isPlayerTab(tab.openerTabId).then((yes) => { if (yes) close(tab.id); });
});

/* ── Tab-unders ────────────────────────────────────────────────────────
   The other half of the trick. Rather than open the ad in front of you,
   the embed sends the player's own tab to the ad and moves the video into
   a popup behind it, so that what you close is the player and what you are
   left looking at is the ad.

   Catching it means knowing where the tab just was, and by the time the
   navigation commits the tab's URL is the ad's. So every player page a tab
   lands on is recorded first, in session storage rather than a variable:
   this worker is torn down after ~30s idle, and an in-memory note of which
   tabs hold the player would be gone by the time a two-hour film ended.

   `client_redirect` is the qualifier Chrome attaches to a navigation a
   script started. A link the user actually clicked commits without it, as
   does the address bar — so neither can be undone by this. */

chrome.webNavigation.onCommitted.addListener(async (details) => {
  const { tabId, frameId, url, transitionQualifiers } = details;
  if (frameId !== TOP_FRAME) return;

  if (isPlayerUrl(url)) {
    remember(tabId, url);
    return;
  }

  const key = noteKey(tabId);
  const cameFrom = playerTabs.get(tabId) ?? (await chrome.storage.session.get(key))[key];
  forget(tabId);
  if (!cameFrom) return;
  if (!(transitionQualifiers || []).includes("client_redirect")) return;

  /* Sent back by URL rather than through history: a hijack done with
     location.replace() leaves no entry to go back to, and goBack() would
     land on whatever the tab held before the player — or nothing. */
  try {
    await chrome.tabs.update(tabId, { url: cameFrom });
  } catch {
    /* Tab closed mid-hijack. */
  }
});

chrome.tabs.onRemoved.addListener((tabId) => forget(tabId));

/* ═══════════════════════════════════════════════════════════════════════
   Taking the openers away inside the sources

   Closing a popup is always late: Chrome makes the tab, it takes focus and
   paints, and only then does it go away. The way to have nothing to close
   is for the embed's ways of opening a tab to stop opening one — window.open
   and target="_blank" alike — which means running inside the embed's frame,
   which means permission for the embed's origin.

   Those origins are not known here and must not be. They are read from the
   configured sources on the player page and arrive over the port, so a
   renewed source is picked up by reloading the player rather than by
   shipping a new extension. Nothing about them is written to the manifest.

   Chrome will not grant a host at runtime without a user gesture, so new
   origins wait behind one click on the toolbar icon. The badge says when
   there is something to click for. Origins that drop out of the list need
   no gesture to drop out of the grant, and are revoked on sight.
   ═══════════════════════════════════════════════════════════════════════ */

const STUB_SCRIPT_ID = "source-popup-stub";
const GATE_SCRIPT_ID = "source-popup-gate";
const WANTED_KEY = "wantedOrigins";

/* Origins the configured sources point at, as chrome match patterns. */
let wantedOrigins = [];

const asPattern = (origin) => `${origin}/*`;

const wantedLoaded = chrome.storage.local.get(WANTED_KEY).then((got) => {
  if (Array.isArray(got[WANTED_KEY]) && !wantedOrigins.length) {
    wantedOrigins = got[WANTED_KEY];
    refreshBadge();
  }
}).catch(() => { /* nothing stored yet */ });

async function grantedOrigins() {
  const { origins = [] } = await chrome.permissions.getAll();
  return origins;
}

/* Patterns Chrome reports back are not always spelled the way they were
   asked for, so compare on the origin rather than the string. */
function originOf(pattern) {
  try { return new URL(pattern.replace(/\*$/, "")).origin; } catch { return pattern; }
}

async function splitOrigins() {
  const granted = new Set((await grantedOrigins()).map(originOf));
  return {
    missing: wantedOrigins.filter((o) => !granted.has(o)),
    stale: [...granted].filter(
      (o) => o !== `https://${PLAYER_HOST}` && !wantedOrigins.includes(o),
    ),
  };
}

async function refreshBadge() {
  try {
    const { missing } = await splitOrigins();
    await chrome.action.setBadgeText({ text: missing.length ? String(missing.length) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#7e4b22" });
    await chrome.action.setTitle({
      title: missing.length
        ? `Bingqilin Popup Blocker — click to allow ${missing.length} new source${missing.length > 1 ? "s" : ""}`
        : "Bingqilin Popup Blocker",
    });
  } catch { /* action unavailable */ }
}

/* Re-register against exactly what is granted right now. Called after a
   grant, after a revoke, and at startup, so the registered set never
   outlives the permission behind it. */
async function syncStub() {
  const granted = (await grantedOrigins())
    .map(originOf)
    .filter((o) => o !== `https://${PLAYER_HOST}` && wantedOrigins.includes(o));

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [STUB_SCRIPT_ID, GATE_SCRIPT_ID] });
  } catch { /* was not registered */ }

  await syncSandbox();
  if (!granted.length) return;

  const matches = granted.map(asPattern);
  const common = {
    matches,
    allFrames: true,
    matchOriginAsFallback: true,   // about:blank frames the embed makes
    runAt: "document_start",
    persistAcrossSessions: true,
  };

  try {
    await chrome.scripting.registerContentScripts([
      { ...common, id: STUB_SCRIPT_ID, js: ["content/no-popup.js"], world: "MAIN" },
      { ...common, id: GATE_SCRIPT_ID, js: ["content/no-popup-gate.js"], world: "ISOLATED" },
    ]);
  } catch (e) {
    console.warn("could not register the popup stub:", e?.message);
  }
}

/* ── The sandbox ───────────────────────────────────────────────────────
   The decoy and the target cancelling are scripts, and a script can be
   outrun: an opener the stub does not know about, a nested frame on an
   origin nobody granted, an about:blank frame that ran before it. The
   sandbox is not a script. A frame whose response carries
   `Content-Security-Policy: sandbox` without allow-popups cannot open a
   tab, and without allow-top-navigation cannot navigate the one it is in
   — Chrome refuses both, and every frame nested inside inherits it.

   Why a header rather than the <iframe sandbox> attribute: the attribute
   was tried and sources refused to play, because a sandboxed window.open
   returns null and they check. Here the decoy is still in place in the
   same frame, so the check gets its window and the sandbox does the
   refusing behind it. The page itself is untouched.

   Appended, not replacing: every CSP header is enforced on its own, so
   the source's own policy stays exactly as it was.

   Two rules, because neither covers the other's case:
     • frames the player loads (initiator is this site), which is in place
       before the player exists and so cannot lose a race to its first
       embed;
     • any frame navigation inside a player tab, because a sandbox set by
       a header belongs to the document, not the frame — an embed that
       sends its own frame to a new URL would otherwise get a fresh,
       unsandboxed document.
   Both only for granted source hosts: changing a response's headers
   needs host permission for it, the same grant the decoy runs under. A
   frame that navigates itself to a host nobody granted is out of reach. */

const SANDBOX_CSP = [
  "sandbox",
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-modals",
  "allow-pointer-lock",
  "allow-orientation-lock",
  "allow-presentation",
].join(" ");

const SANDBOX_FROM_PLAYER = 1;
const SANDBOX_IN_PLAYER_TABS = 2;

let sandboxSync = Promise.resolve();

/* Serialised: tabs come and go in bursts, and two overlapping updates
   could each remove the other's rules before adding their own. */
function syncSandbox() {
  sandboxSync = sandboxSync.then(writeSandboxRules, writeSandboxRules);
  return sandboxSync;
}

async function writeSandboxRules() {
  /* A restarted worker starts with both of these empty. Writing before
     they are read back would drop the rules for no reason. */
  await Promise.all([tabsLoaded, wantedLoaded]);
  const granted = (await grantedOrigins())
    .map(originOf)
    .filter((o) => o !== `https://${PLAYER_HOST}` && wantedOrigins.includes(o));
  const hosts = [...new Set(granted.map((o) => new URL(o).hostname))];
  const tabIds = [...playerTabs.keys()];

  const action = {
    type: "modifyHeaders",
    responseHeaders: [{ header: "Content-Security-Policy", operation: "append", value: SANDBOX_CSP }],
  };
  const addRules = [];
  if (hosts.length) {
    addRules.push({
      id: SANDBOX_FROM_PLAYER, priority: 1, action,
      condition: { initiatorDomains: [PLAYER_HOST], requestDomains: hosts, resourceTypes: ["sub_frame"] },
    });
    if (tabIds.length) {
      addRules.push({
        id: SANDBOX_IN_PLAYER_TABS, priority: 1, action,
        condition: { tabIds, requestDomains: hosts, resourceTypes: ["sub_frame"] },
      });
    }
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SANDBOX_FROM_PLAYER, SANDBOX_IN_PLAYER_TABS],
      addRules,
    });
  } catch (e) {
    console.warn("could not update the sandbox rules:", e?.message);
  }
}

/* ── Is this frame inside the player? ──────────────────────────────────
   Asked by every frame the decoy went into. Only the worker can tell:
   the frame is cross-origin to the tab above it, and sender.tab.url is
   readable here because the player's own host is a granted permission.

   A frame in any other tab gets the decoy taken straight back out, so one
   of these source domains embedded somewhere else behaves as though this
   extension were not installed. */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "gate") return false;
  const { tab, frameId } = sender;
  if (!tab || tab.id === undefined || frameId === undefined) return false;
  if (isPlayerUrl(tab.url)) return false;   // the player: leave the decoy in

  chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    world: "MAIN",
    func: () => { try { window.__bqRestore?.(); } catch { /* gone */ } },
  }).catch(() => { /* frame already gone */ });
  return false;
});

/* Sources reported by a player tab. */
async function setWantedOrigins(origins) {
  const next = [...new Set(origins)].sort();
  if (next.join(" ") === wantedOrigins.join(" ")) return;
  wantedOrigins = next;
  await chrome.storage.local.set({ [WANTED_KEY]: wantedOrigins });

  /* A source that is gone needs no permission. Dropping it does not need
     a gesture, so it happens without asking. */
  const { stale } = await splitOrigins();
  if (stale.length) {
    try { await chrome.permissions.remove({ origins: stale.map(asPattern) }); } catch { /* keep going */ }
  }

  await syncStub();
  await refreshBadge();
}

/* One click, in the gesture Chrome requires. wantedOrigins is already in
   memory, so nothing is awaited before the request and the gesture holds. */
chrome.action.onClicked.addListener(() => {
  /* Requested against the full wanted set: Chrome only prompts for what is
     not already granted, and asking inside the click is what keeps the
     gesture valid. Nothing is awaited first, because an await here would
     spend the gesture and the request would be refused. */
  if (!wantedOrigins.length) {
    chrome.action.setTitle({ title: "Open the Bingqilin player once so it can read your sources" });
    return;
  }
  chrome.permissions.request({ origins: wantedOrigins.map(asPattern) })
    .then(async (granted) => {
      if (granted) await syncStub();
      await refreshBadge();
    })
    .catch(() => { /* dismissed */ });
});

chrome.permissions.onAdded.addListener(() => { syncStub(); refreshBadge(); });
chrome.permissions.onRemoved.addListener(() => { syncStub(); refreshBadge(); });
chrome.runtime.onStartup.addListener(() => { syncStub(); refreshBadge(); });
chrome.runtime.onInstalled.addListener(() => { syncStub(); refreshBadge(); });
syncSandbox();
