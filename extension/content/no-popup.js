/* ═══════════════════════════════════════════════════════════════════════
   Hand the embed a window that isn't one, and take away the two ways of
   opening one that never ask window.open at all.

   Declared for every frame on every site, and does nothing unless the
   frame is inside the player: location.ancestorOrigins names every page
   above a frame, synchronously and even across origins, so a frame can
   tell before any of the embed's scripts run. A source embedded anywhere
   else behaves exactly as it would without this extension. It runs in
   the MAIN world, because the things it replaces are the page's own.

   Why a decoy rather than a refusal: a source that will not play under a
   sandbox is detecting that window.open *failed*. Returning null, throwing,
   or being sandboxed all look identical to it. So this returns something
   truthy and well-behaved, and simply never opens anything. Nothing is
   created, so there is no tab to close and no flash to see.

   The same frames are also sandboxed, by a header the extension adds
   (see "The sandbox" in background.js), and that is what actually stops
   them. This is what keeps the sandbox from showing: without it the
   embed's window.open would return the sandbox's null.

   The shape below is what popup scripts actually touch. Most do:

       var w = window.open(url, "_blank");
       if (!w || w.closed) { ...fall back to redirecting your tab... }
       w.focus();

   so `closed` staying false matters as much as the object existing — a
   decoy that reports itself closed just pushes them to the tab-under.
   ═══════════════════════════════════════════════════════════════════════ */

(() => {
  "use strict";

  /* Only inside the player. The last ancestor is the tab's own page; any
     other site, or a top-level visit, is left alone. Live TV frames
     TVNZ's player, which is not an embed and is never touched. */
  const PLAYER_ORIGIN = "https://thebingchilling.pages.dev";
  const ancestors = [...(location.ancestorOrigins || [])];
  if (ancestors[ancestors.length - 1] !== PLAYER_ORIGIN) return;
  if (ancestors.some((o) => /^https:\/\/([^/]+\.)?tvnz\.co\.nz$/.test(o))) return;

  const noop = function () {};

  const makeWindow = () => {
    let closed = false;

    /* document.write() is how a blank popup gets its ad. Accepting and
       discarding it is the whole point. */
    const doc = {
      write: noop, writeln: noop, open: noop, close: noop,
      body: null, documentElement: null, cookie: "",
      createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
      getElementById: () => null, querySelector: () => null,
      addEventListener: noop, removeEventListener: noop,
    };

    const location = {
      href: "about:blank", protocol: "about:", host: "", hostname: "",
      pathname: "blank", search: "", hash: "",
      replace: noop, assign: noop, reload: noop,
      toString: () => "about:blank",
    };

    const win = {
      closed: false, opener: null, name: "", document: doc, location,
      focus: noop, blur: noop, print: noop, stop: noop,
      postMessage: noop, addEventListener: noop, removeEventListener: noop,
      close: () => { closed = true; },
      /* Some scripts test w.self === w or w.window === w to decide it is a
         real window before using it. Cheap to satisfy. */
      get self() { return proxy; },
      get window() { return proxy; },
      get top() { return proxy; },
      get parent() { return proxy; },
    };

    /* A plain object throws on anything unanticipated, and a throw inside
       the opener's code can take the player down with it. The proxy makes
       every unknown property a no-op function instead, and swallows every
       assignment (w.location = "...", w.opener = null, w.onload = fn). */
    const proxy = new Proxy(win, {
      get(target, key) {
        if (key === "closed") return closed;
        if (key in target) return target[key];
        return noop;
      },
      set() { return true; },
      has() { return true; },
    });

    return proxy;
  };

  /* ── Looking native ───────────────────────────────────────────────────
     The frame is sandboxed, and sources that refuse to play under a
     sandbox go looking for it. Each way they look has to come back the
     way it would in a frame that is not, or the decoy has hidden nothing.

     A replacement must not give itself away when inspected: the same
     name and length as the original, no own toString, and
     Function.prototype.toString — which is how a careful script reads
     a function, since it cannot be overridden per function — printing
     the original's "[native code]". */
  const nativeToString = Function.prototype.toString;
  const shownAs = new WeakMap();   // replacement -> the original it stands in for

  try {
    const toString = {
      toString() {
        return nativeToString.call(shownAs.has(this) ? shownAs.get(this) : this);
      },
    }.toString;
    shownAs.set(toString, nativeToString);
    Object.defineProperty(Function.prototype, "toString", {
      configurable: true, writable: true, enumerable: false, value: toString,
    });
  } catch { /* non-fatal: only the disguise is lost */ }

  const mask = (replacement, original) => {
    shownAs.set(replacement, original);
    try {
      Object.defineProperty(replacement, "name", { configurable: true, value: original.name });
      Object.defineProperty(replacement, "length", { configurable: true, value: original.length });
    } catch { /* non-fatal */ }
    return replacement;
  };

  /* document.domain: setting it throws in any sandboxed document, whatever
     the sandbox allows ("Assignment is forbidden for sandboxed iframes"),
     which makes `document.domain = document.domain` the standard one-line
     sandbox test. Outside a sandbox the same assignment succeeds (or is
     silently ignored), so this throw, and only this one, is swallowed.
     Any other error from the setter is real and still thrown. */
  try {
    const domain = Object.getOwnPropertyDescriptor(Document.prototype, "domain");
    if (domain?.set) {
      const set = mask(function (value) {
        try {
          return domain.set.call(this, value);
        } catch (e) {
          if (!(e?.name === "SecurityError" && /sandbox/i.test(e.message))) throw e;
          /* The sandbox check runs first and hides the one that would
             have followed, so a value that is not this host or a suffix
             of it must still be refused, as it is outside a sandbox. */
          const host = location.hostname;
          const v = String(value).toLowerCase();
          if (v === host || (v.includes(".") && host.endsWith("." + v))) return;
          throw new DOMException(
            `Failed to set the 'domain' property on 'Document': '${value}' is not a suffix of '${host}'.`,
            "SecurityError",
          );
        }
      }, domain.set);
      Object.defineProperty(Document.prototype, "domain", { ...domain, set });
    }
  } catch { /* non-fatal */ }

  /* ── The decoy ───────────────────────────────────────────────────── */
  try {
    const open = window.open;

    Object.defineProperty(window, "open", {
      configurable: true,
      writable: true,
      value: mask(function () { return makeWindow(); }, open),
    });

  } catch { /* locked down; leave the page as it is */ }

  /* ── Targets that open a tab without asking ──────────────────────────
     window.open is only half of it, and on these embeds it is the smaller
     half. The overlay stretched across the video is an <a target="_blank">,
     and a real click on it is a real click: Chrome opens the tab natively,
     there is no open() call to hand a decoy to, and the only thing left is
     to close the tab afterwards — which is the flash.

     _top and _parent are the same trick pointed the other way. They send
     the tab the player is in to the ad, and because a click drove it the
     navigation carries no `client_redirect`, so the worker's tab-under
     rule does not fire on it either.

     None of these is a navigation this frame is ever entitled to make: it
     is a video embed, and a video embed has no business opening tabs or
     replacing the one it is in. So the default is cancelled. It is
     cancelled in the capture phase and without stopping propagation, so
     the embed's own click handlers still run — a click on the overlay
     still reaches the player underneath it, and only the navigation is
     lost. ═════════════════════════════════════════════════════════════ */
  try {
    const HIJACK = new Set(["_blank", "_top", "_parent"]);

    /* An element with no target of its own inherits <base target>, which
       is its own way of turning every plain link into a popup. */
    const targetOf = (el) => {
      const own = el.getAttribute("target");
      const value = own || document.querySelector("base[target]")?.getAttribute("target");
      return value ? value.trim().toLowerCase() : "";
    };

    const hijacks = (el) => HIJACK.has(targetOf(el));

    const onClick = (event) => {
      for (const node of event.composedPath()) {
        const tag = node.tagName;
        if (tag !== "A" && tag !== "AREA") continue;
        if (hijacks(node)) event.preventDefault();
        return;
      }
    };

    const onSubmit = (event) => {
      const form = event.target;
      if (form?.tagName === "FORM" && hijacks(form)) event.preventDefault();
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);

    /* An anchor that was never put in the document dispatches its click to
       nobody, so the listener above never sees it — and Chrome opens the
       tab all the same. Building one and clicking it is the usual way to
       do this from script, so the element's own click() is the only place
       it can be caught. A connected anchor is left to the listener, which
       cancels the navigation without swallowing the event. */
    const anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = mask(function () {
      if (!this.isConnected && hijacks(this)) return;
      return anchorClick.apply(this, arguments);
    }, anchorClick);

    /* form.submit() fires no submit event at all, so the listener cannot
       see that one either. Nothing else is listening for it by definition,
       which makes returning early safe here. */
    const formSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = mask(function () {
      if (hijacks(this)) return;
      return formSubmit.apply(this, arguments);
    }, formSubmit);
  } catch { /* locked down; leave the page as it is */ }
})();
