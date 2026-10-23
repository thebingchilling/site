/* ═══════════════════════════════════════════════════════════════════════
   Tell live.html it can show TVNZ's player in a frame.

   TVNZ forbids being framed, so without this extension the frame shows
   only Chrome's "refused to connect". rules/tvnz-frame.json removes the
   two headers that forbid it, for frames this site opens; this marks the
   page so it knows to use the frame rather than offer TVNZ's site in a
   new tab.

   Isolated world, so the only thing shared with the page is the DOM: one
   attribute on <html>, set before any of the page's scripts run.
   ═══════════════════════════════════════════════════════════════════════ */

document.documentElement.dataset.bqTvnzFrame = "1";
