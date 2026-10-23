/* ═══════════════════════════════════════════════════════════════════════
   Let TVNZ's player play on a phone or tablet when live.html frames it.

   TVNZ's web player refuses to start on anything it takes for a phone or
   tablet and shows "Open or Download the TVNZ+ App" instead. It decides
   from navigator.userAgent (Android, iPhone, "Mobile" …), plus
   maxTouchPoints on a Mac user agent. This presents the frame as the
   same browser on desktop — what the browser's own "Desktop site" option
   does — so the web player starts.

   Runs in the page's own world at document_start, before TVNZ's scripts
   read any of it, and only in a TVNZ frame inside this site: a TVNZ tab,
   or TVNZ framed anywhere else, is left exactly as it is. A desktop
   browser is left alone too; there is nothing to change.
   ═══════════════════════════════════════════════════════════════════════ */

(() => {
  const SITE = "https://thebingchilling.github.io";
  if (window.top === window) return;
  const ancestors = location.ancestorOrigins;
  if (ancestors && ancestors.length && ancestors[ancestors.length - 1] !== SITE) return;

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
