/* ═══════════════════════════════════════════════════════════════════════
   Keep TVNZ's player working inside live.html's frame.

   Runs in the page's own world at document_start, before TVNZ's scripts,
   and only in a TVNZ frame inside this site: a TVNZ tab, or TVNZ framed
   anywhere else, is left exactly as it is. Two jobs.

   1. No service worker. TVNZ's (Angular's ngsw) answers every page load
      from a copy it saved itself, and that copy still carries the
      X-Frame-Options / frame-ancestors headers rules/tvnz-frame.json
      strips from the network response — a rule can't reach a response a
      service worker makes. So the first visit framed fine and every one
      after it was "refused to connect". Registering is refused here, and
      one already registered in this frame's storage (Chrome keeps a
      framed site's apart from its tabs') is removed. live.html also
      loads the frame with ?ngsw-bypass, which ngsw passes straight to
      the network, so a worker left over from before this still can't
      serve it.

   2. Desktop, on a phone or tablet. TVNZ's web player won't start on
      anything it takes for one, and shows "Open or Download the TVNZ+
      App" instead, deciding from navigator.userAgent (plus maxTouchPoints
      on a Mac user agent). This presents the frame as the same browser
      on desktop — what the browser's own "Desktop site" option does. A
      desktop browser is left alone.
   ═══════════════════════════════════════════════════════════════════════ */

(() => {
  const SITE = "https://thebingchilling.github.io";
  if (window.top === window) return;
  const ancestors = location.ancestorOrigins;
  if (ancestors && ancestors.length && ancestors[ancestors.length - 1] !== SITE) return;

  if (window.ServiceWorkerContainer) {
    ServiceWorkerContainer.prototype.register = function () {
      return Promise.reject(new DOMException("Service workers are off in this frame.", "SecurityError"));
    };
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
  }

  const ua = navigator.userAgent;
  const looksMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|CriOS/i.test(ua)
    || (navigator.maxTouchPoints > 0 && /Macintosh/i.test(ua));
  if (!looksMobile) return;

  const chrome = /(?:Chrome|CriOS)\/([\d.]+)/.exec(ua);
  const edge = /(?:EdgA|EdgiOS|Edg)\/([\d.]+)/.exec(ua);
  const desktopUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    + `Chrome/${chrome ? chrome[1] : "131.0.0.0"} Safari/537.36` + (edge ? ` Edg/${edge[1]}` : "");

  const override = (name, value) => {
    try { Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true }); } catch { /* leave it */ }
  };
  override("userAgent", desktopUa);
  override("appVersion", desktopUa.replace(/^Mozilla\//, ""));
  override("platform", "Win32");
  override("maxTouchPoints", 0);
  if (navigator.userAgentData) {
    const real = navigator.userAgentData;
    override("userAgentData", {
      brands: real.brands,
      mobile: false,
      platform: "Windows",
      getHighEntropyValues: (hints) => real.getHighEntropyValues(hints).then(v => ({ ...v, mobile: false, platform: "Windows" })),
      toJSON: () => ({ brands: real.brands, mobile: false, platform: "Windows" }),
    });
  }
})();
