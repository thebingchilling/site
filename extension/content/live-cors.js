/* ═══════════════════════════════════════════════════════════════════════
   Tell live.html the TVNZ channels can be read.

   Their manifest, segments and licence come from servers that only let
   TVNZ's own pages read them, so a browser on this site is refused.
   rules/live-cors.json adds the header that lets live.html read them;
   this marks the page so it can tell "install the extension" apart from
   any other reason a DRM channel failed to load.

   Isolated world, so the only thing shared with the page is the DOM: one
   attribute on <html>, set before any of the page's scripts run.
   ═══════════════════════════════════════════════════════════════════════ */

document.documentElement.dataset.bqLiveCors = "1";
