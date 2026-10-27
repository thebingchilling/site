/* ═══════════════════════════════════════════════════════════════════════
   The player page's line to the worker.

   Holds a port open. A service worker is evicted after ~30s idle, so left
   alone a popup is what wakes it — Chrome has to start the worker before
   anything can close anything, and the popup is on screen for all of it.
   An open port keeps it resident while a player tab is. It is also how
   the worker learns which tabs hold the movie player, which is where the
   sandbox rule applies.

   Nothing here touches the page. Isolated world, no DOM, no globals — it
   opens a port and goes quiet.
   ═══════════════════════════════════════════════════════════════════════ */

(() => {
  const PLAYER_PATHS = new Set(["/", "/index", "/index.html", "/live", "/live.html"]);
  if (!PLAYER_PATHS.has(location.pathname)) return;

  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: "player-tab" });
      /* The worker is replaced on every extension update or reload, which
         drops the port. Reconnect rather than leaving the tab unprotected
         for as long as it stays open. */
      port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(connect, 1000);
      });
    } catch {
      /* Extension unloading. Nothing to keep alive for. */
    }
  }

  connect();

  /* Traffic on the port resets the idle timer. 20s against a 30s timeout
     leaves room for a slow wake without ever letting it lapse. */
  setInterval(() => {
    try { port?.postMessage({ type: "ping" }); } catch { /* reconnecting */ }
  }, 20000);
})();
