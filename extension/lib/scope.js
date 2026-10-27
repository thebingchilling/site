/* ═══════════════════════════════════════════════════════════════════════
   What counts as "the player", and nothing else.

   The site is one origin with two very different halves. The player — the
   root page, which builds <iframe> embeds out of user-configured streaming
   sources, and live.html, which plays HLS — is where popups come from.
   /tools/ is first-party code that opens nothing and needs nothing blocked;
   blocking there would mean a tools page that legitimately wants to open a
   tab silently fails, with no UI anywhere to explain why.

   So the scope is a path allow-list rather than a host one. If a player
   page is ever added, it goes here.
   ═══════════════════════════════════════════════════════════════════════ */

export const PLAYER_HOST = "thebingchilling.pages.dev";

/* Both spellings of each page. GitHub Pages serves an extensionless path
   by falling back to the .html file, and the site takes it up: its own
   service worker precaches "/live" alongside "/live.html", and the bottom
   navigation links to the bare "/live". A tab sitting on that URL is the
   player just as much as one on "/live.html". */
export const PLAYER_PATHS = new Set([
  "/",
  "/index",
  "/index.html",
  "/live",
  "/live.html",
]);

export function isPlayerUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === PLAYER_HOST &&
    PLAYER_PATHS.has(parsed.pathname)
  );
}
