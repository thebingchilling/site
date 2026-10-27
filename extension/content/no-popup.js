/* ═══════════════════════════════════════════════════════════════════════
   Hand the embed a window that isn't one, and take away the two ways of
   opening one that never ask window.open at all.

   Registered at runtime against the origins of whatever sources are
   configured — never a hardcoded list, and never a site the user has not
   granted. It runs in the MAIN world of those frames, because the things
   it replaces are the page's own.

   Why a decoy rather than a refusal: a source that will not play under a
   sandbox is detecting that window.open *failed*. Returning null, throwing,
   or being sandboxed all look identical to it. So this returns something
   truthy and well-behaved, and simply never opens anything. Nothing is
   created, so there is no tab to close and no flash to see.

   The same frames are also sandboxed now, by a header the worker adds
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

  /* Only inside a frame. A top-level visit to one of these domains is the
     user going there deliberately, and their popups are their business. */
  if (window === window.top) return;

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

  /* Everything this frame changed, and how to change it back. The decoy
     goes in immediately — waiting to find out whether this frame is inside
     a player tab would be a race the embed could win — and is taken out
     again a moment later if it turns out not to be.
     content/no-popup-gate.js asks; the worker answers by running
     window.__bqRestore in this frame.

     Undoing is done from the extension rather than by listening for an
     event, because an event the page can see is an event the page can
     fire. */
  const undo = [];

  /* Keep the replacements looking native: a script that prints one should
     not see a giveaway body. */
  const mask = (replacement, original) => {
    try { replacement.toString = () => original.toString(); } catch { /* non-fatal */ }
    return replacement;
  };

  /* ── The decoy ───────────────────────────────────────────────────── */
  try {
    const open = window.open;

    Object.defineProperty(window, "open", {
      configurable: true,
      writable: true,
      value: mask(function () { return makeWindow(); }, open),
    });

    undo.push(() => {
      Object.defineProperty(window, "open", {
        configurable: true, writable: true, value: open,
      });
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
    undo.push(() => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    });

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
    undo.push(() => { HTMLAnchorElement.prototype.click = anchorClick; });

    /* form.submit() fires no submit event at all, so the listener cannot
       see that one either. Nothing else is listening for it by definition,
       which makes returning early safe here. */
    const formSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = mask(function () {
      if (hijacks(this)) return;
      return formSubmit.apply(this, arguments);
    }, formSubmit);
    undo.push(() => { HTMLFormElement.prototype.submit = formSubmit; });
  } catch { /* locked down; leave the page as it is */ }

  try {
    Object.defineProperty(window, "__bqRestore", {
      configurable: true,
      enumerable: false,
      value: function () {
        while (undo.length) {
          try { undo.pop()(); } catch { /* already gone */ }
        }
      },
    });
  } catch { /* nothing can undo it now; it stays in */ }
})();
