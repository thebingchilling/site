/* ═══════════════════════════════════════════════════════════════════════
   Bingqilin shared chrome — the behaviour half of the app shell: ripple
   feedback, the theme toggle, and the dialog / snackbar primitives every
   page shares.

   Pairs with /shared/chrome.css (the shell's visuals), /shared/ui.css
   (component visuals) and /shared/theme-init.js (the pre-paint
   flash-avoidance snippet in <head>).

   Deliberately small and dependency-free — a single global, BQChrome —
   since these pages ship no build step. Every page does:
     <script src="/shared/chrome.js"></script>
   then calls what it needs.
   ═══════════════════════════════════════════════════════════════════════ */
window.BQChrome = (function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const FOCUSABLE = [
    "a[href]", "button:not([disabled])", "input:not([disabled])",
    "select:not([disabled])", "textarea:not([disabled])",
    "summary", '[tabindex]:not([tabindex="-1"])'
  ].join(",");

  function focusablesIn(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  /* ── Ripple: Material touch feedback — see chrome.css for the full
     rationale. `selector` is page-specific (different pages ripple
     different elements); the spawn mechanism is not. ── */
  function initRipple(selector) {
    // A .ripple is absolutely positioned, so its host has to establish a
    // containing block and clip it. When a page adds a selector whose CSS
    // forgets that, the span escapes to the nearest positioned ancestor
    // and the ripple appears somewhere unrelated on the screen — which is
    // what was happening on the PDF tool's option cards and the WARP
    // tool's Advanced options toggle. Rather than rely on every current
    // and future ripple target getting its CSS right, guarantee it here,
    // once per element.
    const prepared = new WeakSet();
    function ensureContains(el) {
      if (prepared.has(el)) return;
      prepared.add(el);
      const cs = getComputedStyle(el);
      if (cs.position === "static") el.style.position = "relative";
      if (cs.overflow === "visible") el.style.overflow = "hidden";
    }
    function spawnRipple(el, x, y) {
      ensureContains(el);
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 1.8;
      const span = document.createElement("span");
      span.className = "ripple";
      span.style.width = span.style.height = size + "px";
      span.style.left = (x - rect.left - size / 2) + "px";
      span.style.top  = (y - rect.top  - size / 2) + "px";
      el.appendChild(span);
      span.addEventListener("animationend", () => span.remove(), { once: true });
    }
    document.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const el = e.target.closest(selector);
      if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return;
      spawnRipple(el, e.clientX, e.clientY);
    }, { passive: true });
  }

  /* ── Theme: System → Light → Dark → System, one button. "System" (no
     saved choice) does nothing beyond removing the attribute — the
     @media (prefers-color-scheme) rules in tokens.css handle that case
     with zero JS. ── */
  const THEME_KEY    = "bq_theme";
  const THEME_ORDER  = ["system", "light", "dark"];
  const THEME_ICONS  = { system: "brightness_auto", light: "light_mode", dark: "dark_mode" };
  const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };
  // Both the top bar and the bottom nav are themed to
  // --md-surface-container (see chrome.css), so this single theme-color
  // reads as a continuation of both: the OS status bar matches the top
  // bar above it, and — via edge-to-edge safe-area-inset layout, since
  // there is no separate web API to tint the OS gesture bar — the system
  // nav bar reads as a continuation of the app's bottom nav below.
  const SURFACE_LIGHT = "#f7ebdd", SURFACE_DARK = "#241e18";
  const systemDarkMQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function syncThemeColorMeta() {
    const meta = $("themeColorMeta");
    if (!meta) return;
    const attr = document.documentElement.getAttribute("data-theme");
    const isDark = attr === "dark" || (attr !== "light" && !!(systemDarkMQ && systemDarkMQ.matches));
    meta.setAttribute("content", isDark ? SURFACE_DARK : SURFACE_LIGHT);
  }
  if (systemDarkMQ && systemDarkMQ.addEventListener) {
    systemDarkMQ.addEventListener("change", () => {
      if (!document.documentElement.hasAttribute("data-theme")) syncThemeColorMeta();
    });
  }
  function applyTheme(pref) {
    if (pref === "light" || pref === "dark") document.documentElement.setAttribute("data-theme", pref);
    else document.documentElement.removeAttribute("data-theme");
    syncThemeColorMeta();
  }
  function updateThemeToggleUI(pref) {
    const icon = $("themeToggleIcon");
    if (icon) icon.textContent = THEME_ICONS[pref] || THEME_ICONS.system;
    const btn = $("themeToggleBtn");
    if (btn) btn.setAttribute("aria-label", "Theme: " + (THEME_LABELS[pref] || "System") + " (tap to change)");
  }

  /* initTheme(options)
     - options.resolvePref(): optional, sync or async, returns the initial
       preference. Defaults to a plain localStorage read.
     - options.onChange(pref): optional, called after every change (the
       initial load included) once the icon and meta are already in sync,
       for extra page-specific UI such as a Settings segmented control. */
  function initTheme(options) {
    const opts = options || {};
    function setThemePref(pref) {
      applyTheme(pref);
      updateThemeToggleUI(pref);
      try { localStorage.setItem(THEME_KEY, pref); } catch (e) {}
      if (opts.onChange) opts.onChange(pref);
    }
    const defaultResolvePref = () => {
      try { return localStorage.getItem(THEME_KEY) || "system"; } catch (e) { return "system"; }
    };
    Promise.resolve((opts.resolvePref || defaultResolvePref)()).then((pref) => {
      pref = pref || "system";
      applyTheme(pref);
      updateThemeToggleUI(pref);
      if (opts.onChange) opts.onChange(pref);
    });
    const btn = $("themeToggleBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") || "system";
        const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
        setThemePref(next);
      });
    }
    return { setThemePref };
  }

  /* ── Dialogs ───────────────────────────────────────────────────────────
     Every modal surface on the site — the settings sheets, the EPG guide,
     the authenticator's edit sheet — used to hand-roll this, and each one
     implemented a different subset: some trapped focus, some closed on
     Escape, one locked background scroll, and the authenticator's had
     none of the four and no role="dialog" either. One implementation now.

     dialog(scrimEl, options) -> { open, close, isOpen }
       options.initialFocus  element (or () => element) to focus on open
       options.onOpen        called after the dialog is shown
       options.onClose       called after it is hidden
       options.dismissible   false to disable Escape and scrim-click
     ── */
  // A stack, not a counter: when a confirm opens over a sheet, Escape has
  // to reach the confirm and nothing else. Both listen on document in the
  // capture phase, so without this the one registered first wins and both
  // may act on the same keypress.
  const dialogStack = [];

  function dialog(scrim, options) {
    const opts = options || {};
    const panel = scrim.querySelector(".sheet, .dialog") || scrim.firstElementChild;
    let lastFocused = null;

    const isOpen = () => !scrim.classList.contains("hidden");

    function onKeydown(e) {
      if (!isOpen()) return;
      // Only the topmost dialog reacts; anything under it is inert.
      if (dialogStack[dialogStack.length - 1] !== api) return;
      if (e.key === "Escape" && opts.dismissible !== false) { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      const f = focusablesIn(panel);
      if (!f.length) { e.preventDefault(); return; }
      if (!panel.contains(document.activeElement)) { e.preventDefault(); f[0].focus(); return; }
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }

    function onPointerDown(e) {
      if (opts.dismissible === false) return;
      if (!panel.contains(e.target)) close();
    }

    function open() {
      if (isOpen()) return;
      lastFocused = document.activeElement;
      scrim.classList.remove("hidden");
      scrim.setAttribute("aria-hidden", "false");
      dialogStack.push(api);
      // Background scroll lock, released only when the last one closes.
      if (dialogStack.length === 1) document.body.style.overflow = "hidden";
      document.addEventListener("keydown", onKeydown, true);
      scrim.addEventListener("pointerdown", onPointerDown);
      const target = typeof opts.initialFocus === "function" ? opts.initialFocus() : opts.initialFocus;
      // Deferred a frame: focusing an element inside a container that is
      // still mid-animation scrolls it into view from the wrong place.
      requestAnimationFrame(() => {
        const el = target || focusablesIn(panel)[0];
        if (el) el.focus();
      });
      if (opts.onOpen) opts.onOpen();
    }

    function close() {
      if (!isOpen()) return;
      scrim.classList.add("hidden");
      scrim.setAttribute("aria-hidden", "true");
      const at = dialogStack.indexOf(api);
      if (at !== -1) dialogStack.splice(at, 1);
      if (!dialogStack.length) document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeydown, true);
      scrim.removeEventListener("pointerdown", onPointerDown);
      if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
      if (opts.onClose) opts.onClose();
    }

    const api = { open, close, isOpen };
    return api;
  }

  /* confirm(options) -> Promise<boolean>
     Replaces window.confirm(), which drops browser chrome into the middle
     of an installed PWA and cannot be styled or themed. Builds an M3
     dialog, resolves true on confirm and false on cancel or dismiss. */
  function confirmDialog(options) {
    const opts = typeof options === "string" ? { body: options } : (options || {});
    return new Promise((resolve) => {
      const scrim = document.createElement("div");
      // Built hidden, then opened: dialog().open() early-returns on an
      // already-visible scrim, so without this the dialog would render but
      // never get its Escape handler, focus trap or scroll lock.
      scrim.className = "scrim scrim--center hidden";
      scrim.setAttribute("role", "dialog");
      scrim.setAttribute("aria-modal", "true");

      const titleId = "bq-confirm-title-" + Date.now();
      scrim.innerHTML =
        '<div class="dialog">' +
          '<div class="dialog__header"><h2 class="dialog__title" id="' + titleId + '"></h2></div>' +
          '<div class="dialog__body"><p class="dialog__text"></p></div>' +
          '<div class="dialog__actions">' +
            '<button type="button" class="btn btn--text" data-act="cancel"></button>' +
            '<button type="button" class="btn" data-act="ok"></button>' +
          "</div>" +
        "</div>";

      scrim.setAttribute("aria-labelledby", titleId);
      scrim.querySelector(".dialog__title").textContent = opts.title || "Are you sure?";
      const text = scrim.querySelector(".dialog__text");
      text.textContent = opts.body || "";
      text.style.cssText = "margin:0;line-height:var(--leading-prose);color:var(--text-muted)";
      if (!opts.body) text.remove();

      const cancelBtn = scrim.querySelector('[data-act="cancel"]');
      const okBtn = scrim.querySelector('[data-act="ok"]');
      cancelBtn.textContent = opts.cancelLabel || "Cancel";
      okBtn.textContent = opts.confirmLabel || "Confirm";
      okBtn.classList.add(opts.danger ? "btn--danger" : "btn--primary");

      document.body.appendChild(scrim);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        ctl.close();
        scrim.remove();
        resolve(value);
      };
      const ctl = dialog(scrim, { initialFocus: cancelBtn, onClose: () => finish(false) });
      cancelBtn.addEventListener("click", () => finish(false));
      okBtn.addEventListener("click", () => finish(true));
      ctl.open();
    });
  }

  /* ── Snackbar (M3) ─────────────────────────────────────────────────────
     The app had no transient-feedback component, which is why three pages
     reached for window.alert(). One at a time, as M3 specifies.

     snackbar(message, options)
       options.duration    ms before auto-dismiss (default 4000; 0 = stay)
       options.actionLabel / options.onAction   optional trailing action
     ── */
  let currentSnackbar = null;

  function snackbar(message, options) {
    const opts = options || {};
    dismissSnackbar();

    const el = document.createElement("div");
    el.className = "snackbar";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");

    const text = document.createElement("span");
    text.className = "snackbar__text";
    text.textContent = message;
    el.appendChild(text);

    if (opts.actionLabel) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "snackbar__action";
      action.textContent = opts.actionLabel;
      action.addEventListener("click", () => {
        dismissSnackbar();
        if (opts.onAction) opts.onAction();
      });
      el.appendChild(action);
    }

    document.body.appendChild(el);
    const duration = opts.duration === undefined ? 4000 : opts.duration;
    const timer = duration > 0 ? setTimeout(dismissSnackbar, duration) : null;
    currentSnackbar = { el, timer };
    return { dismiss: dismissSnackbar };
  }

  function dismissSnackbar() {
    if (!currentSnackbar) return;
    const { el, timer } = currentSnackbar;
    currentSnackbar = null;
    if (timer) clearTimeout(timer);
    el.classList.add("snackbar--leaving");
    // Fires immediately under prefers-reduced-motion, where the leaving
    // animation is suppressed and no animationend event is coming.
    const remove = () => el.remove();
    el.addEventListener("animationend", remove, { once: true });
    setTimeout(remove, 400);
  }

  /* ── Tabs / segmented buttons ──────────────────────────────────────────
     Keyboard support for the roles the markup already declares. A
     role="tablist" is expected to move selection with the arrow keys and
     expose exactly one tab stop; the four hand-rolled tab strips left
     every tab in the tab order with no arrow handling at all.

     initTabs(container, onSelect) — reads role="tab" children, wires
     Left/Right/Home/End and click, and keeps aria-selected, tabindex and
     .segmented__item--active in sync. ── */
  function initTabs(container, onSelect) {
    if (!container) return { select: () => {} };
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return { select: () => {} };

    // Re-entrancy guard. The natural way to write a page's onSelect is to
    // funnel every tab change through one setTab()-style function that
    // both updates page state and calls select() to sync the strip — which
    // re-enters here and calls onSelect again, forever. (live.html did
    // exactly that: every tab tap blew the stack before it ever rendered.)
    // Callers still always get their onSelect when they call select()
    // themselves; it's only suppressed while one is already running.
    let notifying = false;
    function select(tab, moveFocus) {
      tabs.forEach((t) => {
        const active = t === tab;
        t.setAttribute("aria-selected", String(active));
        t.tabIndex = active ? 0 : -1;
        t.classList.toggle("segmented__item--active", active);
      });
      if (moveFocus) tab.focus();
      if (onSelect && !notifying) {
        notifying = true;
        try { onSelect(tab); } finally { notifying = false; }
      }
    }

    tabs.forEach((tab, i) => {
      tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (e) => {
        let next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (!next) return;
        e.preventDefault();
        select(next, true);
      });
    });

    return { select: (tab) => select(tab, false) };
  }



  /* ═══════════════ Error text ═══════════════
     Several tools show an error message that came from somewhere else —
     SauceNAO, Cloudflare's edge, Adobe Fonts, an exchange-rate API. Those
     are not reliably the one clean sentence the UI assumes they are:
     SauceNAO's "You need an Image!" reply is a fragment of its own HTML
     error page (tags, entities, a "GO BACK TO START" link and a couple of
     "Detected Type N:" debug lines, all of it dumped straight into the
     error banner), Cloudflare answers with markup, and several run long
     enough to shove the rest of the page off screen.

     cleanMessage() is the one place that gets fixed: strip the markup,
     unescape what that leaves behind, drop the debris, collapse the
     whitespace and cap the length. Every caller passes a fallback for the
     case where nothing readable survives — an empty error banner is worse
     than a vague one. ── */
  const MESSAGE_MAX = 200;
  const ENTITIES = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
    "&#39;": "'", "&nbsp;": " ", "&hellip;": "…", "&mdash;": "—", "&ndash;": "–"
  };

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (m, hex) => codePoint(parseInt(hex, 16), m))
      .replace(/&#(\d+);/g, (m, dec) => codePoint(parseInt(dec, 10), m))
      .replace(/&[a-z]+;/gi, (m) => (ENTITIES[m.toLowerCase()] != null ? ENTITIES[m.toLowerCase()] : m));
  }
  function codePoint(n, original) {
    if (!Number.isFinite(n) || n < 32 || n > 0x10ffff) return original;
    try { return String.fromCodePoint(n); } catch (e) { return original; }
  }

  /* opts.punctuate: false leaves the terminal full stop off, for the
     callers that drop the result into the middle of their own sentence
     ("Couldn't refresh rates (…)"), where one reads as a typo. */
  function cleanMessage(raw, fallback, opts) {
    const fb = fallback || "Something went wrong.";
    let s = raw;
    if (s && typeof s === "object") s = s.message != null ? s.message : String(s);
    s = s == null ? "" : String(s);
    // Only the tags that actually carry a line break become a space, so
    // "line one<br>line two" doesn't run together as "line oneline two".
    s = s.replace(/<\s*(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, " ");
    s = s.replace(/<[^>]*>/g, "");
    // Decoding can hand back angle brackets that were escaped in the
    // source ("&lt;b&gt;"), so strip once more rather than trusting the
    // first pass to have seen every tag.
    s = decodeEntities(s).replace(/<[^>]*>/g, "");
    s = s.replace(/\.{2,}\s*GO BACK TO START\s*\.{2,}/gi, " ");
    s = s.replace(/\bDetected Type \d+:\s*(?:[\w.+-]+\/[\w.+-]+)?/gi, " ");
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/^[\s|·—–\-:]+/, "").replace(/[\s|·—–\-:]+$/, "");
    if (!s) return fb;
    if (s.length > MESSAGE_MAX) s = s.slice(0, MESSAGE_MAX).replace(/\s+\S*$/, "").trim() + "…";
    if (opts && opts.punctuate === false) return s.replace(/\.$/, "");
    if (!/[.!?…:]$/.test(s)) s += ".";
    return s;
  }

  // Convenience for the overwhelmingly common shape: a caught value that
  // might be an Error, a string, or something with no message at all.
  function errorText(err, fallback, opts) {
    return cleanMessage(err && err.message != null ? err.message : err, fallback, opts);
  }


  /* ═══════════════ Untrusted values in markup ═══════════════
     Six pages had each grown their own copy of this, character-for-
     character identical apart from what they did with null: four rendered
     the literal string "null" into the page. One copy, and null is empty.

     The escape set covers both quoting styles plus the three characters
     that can open a tag, so the result is safe in an attribute (quoted
     either way) and as text. ── */
  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  /* Result links, thumbnails and profile URLs arrive from somewhere else
     — SauceNAO's indexes, a torrent indexer's JSON — and go straight into
     an href or a src. escapeHtml() stops them breaking out of the
     attribute, which is the half everyone remembers, but it leaves
     "javascript:…" perfectly intact: still one value, still quoted, and
     still script the moment the link is followed. The reverse-image
     search routes its clicks through window.open()/location.assign(),
     where such a URL runs in this page's origin, against the same
     localStorage the authenticator keeps its TOTP secrets in.

     So check the scheme, not just the quoting. Anything that isn't a real
     navigable link — a relative path, a data: or javascript: URL, a bare
     string that never parsed — comes back as "", and callers render plain
     text rather than a dead or dangerous anchor.

     Absolute only, deliberately: resolving against document.baseURI would
     turn an API's garbage into a confident same-origin link. ── */
  const SAFE_URL_SCHEMES = new Set(["http:", "https:", "magnet:", "mailto:"]);
  function safeUrl(raw) {
    if (raw == null) return "";
    const s = String(raw).trim();
    if (!s) return "";
    let parsed;
    try { parsed = new URL(s); } catch (e) { return ""; }
    return SAFE_URL_SCHEMES.has(parsed.protocol) ? parsed.href : "";
  }

  return {
    initRipple, initTheme, syncThemeColorMeta,
    dialog, confirm: confirmDialog, snackbar, dismissSnackbar, initTabs,
    cleanMessage, errorText, escapeHtml, safeUrl
  };
})();
