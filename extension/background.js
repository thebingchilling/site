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

   Scope is the path list in lib/scope.js. The extension can see every
   site — it needs to, to sandbox whatever host an embed is on — so every
   rule here checks that the tab is the player before acting. /tools/ and
   every other site fail that check.
   ═══════════════════════════════════════════════════════════════════════ */

import { isPlayerUrl } from "./lib/scope.js";

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
   The sandbox

   Closing a popup is always late: Chrome makes the tab, it takes focus and
   paints, and only then does it go away. The way to have nothing to close
   is for the frame to be unable to ask. A frame whose response carries
   `Content-Security-Policy: sandbox` without allow-popups cannot open a
   tab, and without allow-top-navigation cannot navigate the one it is in
   — Chrome refuses both, and every frame nested inside inherits it.

   Why a header rather than the <iframe sandbox> attribute: a sandboxed
   window.open returns null, sources check for that and refuse to play,
   and the attribute leaves nothing in the frame to hide it.
   content/no-popup.js runs in every frame inside the player and hands
   the check a window, so the sandbox does the refusing behind it. The
   page itself is untouched.

   Appended, not replacing: every CSP header is enforced on its own, so
   the source's own policy stays exactly as it was.

   Two rules, because neither covers the other's case:
     • rules/sandbox.json, static: every frame this site loads. It is in
       place before the player exists, so it cannot lose a race to its
       first embed.
     • the session rule below: every frame load inside a movie-player tab,
       whatever started it. A sandbox from a header belongs to the
       document, not the frame, so an embed that sends its own frame to a
       new URL — a mirror, a redirect — would otherwise get a fresh,
       unsandboxed document.
   Any host: "<all_urls>" is granted at install, so there is no list of
   sources to keep and nothing to click. TVNZ is left out of both — Live
   TV frames TVNZ's own player, which needs to sign in. */

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

const SANDBOX_IN_PLAYER_TABS = 1;

/* Only the movie player. Live TV's frame is TVNZ, and that is all it is. */
function isMoviePlayer(url) {
  try { return !new URL(url).pathname.startsWith("/live"); } catch { return false; }
}

let sandboxSync = Promise.resolve();

/* Serialised: tabs come and go in bursts, and two overlapping updates
   could each remove the other's rule before adding their own. */
function syncSandbox() {
  sandboxSync = sandboxSync.then(writeSandboxRule, writeSandboxRule);
  return sandboxSync;
}

async function writeSandboxRule() {
  /* A restarted worker starts with no tabs. Writing before they are read
     back would drop the rule for no reason. */
  await tabsLoaded;
  const tabIds = [...playerTabs].filter(([, url]) => isMoviePlayer(url)).map(([id]) => id);

  const addRules = tabIds.length ? [{
    id: SANDBOX_IN_PLAYER_TABS,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [{ header: "Content-Security-Policy", operation: "append", value: SANDBOX_CSP }],
    },
    condition: { tabIds, excludedRequestDomains: ["tvnz.co.nz"], resourceTypes: ["sub_frame"] },
  }] : [];

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SANDBOX_IN_PLAYER_TABS],
      addRules,
    });
  } catch (e) {
    console.warn("could not update the sandbox rule:", e?.message);
  }
}

/* Left behind by 1.9 and earlier, which registered the decoy at runtime
   against hosts granted one click at a time. The manifest does both now. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(["wantedOrigins", "landedOrigins"]).catch(() => {});
  chrome.scripting.unregisterContentScripts().catch(() => {});
});

syncSandbox();
