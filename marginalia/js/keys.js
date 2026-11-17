/* Marginalia — M.keys (SPEC §3, §7 "Configurable shortcuts", §17.2; BUILD-NOTES "Key routing"):
   bindings, presets, matching and dispatch. Pure module: loads in node with no DOM.

   Binding format (canonical): "[Ctrl+][Alt+][Shift+][Meta+]Key"
   - Key = event.key with " " → "Space"; single letters lower-cased (Shift+ kept for them);
     other single characters ("?", ",", "=", "-", "+", digits) as-is and WITHOUT Shift+;
     named keys ("Enter", "Escape", "ArrowLeft", …) as-is, Shift+ kept.
   - When ev.altKey and ev.code is KeyA…KeyZ the letter comes from ev.code (macOS Option symbols).
   - "Mod+" expands to Meta+ on macOS and Ctrl+ elsewhere (navigator sniff; Meta when unknown,
     including node, where navigator.userAgent is "Node.js/…", so tests are deterministic).
   - A map entry's binding may be a string, an array of strings (several keys for one action),
     or null/"" (unbound: never matches).
   - dispatch(ev, maps) ignores only ev.isComposing (keyCode 229); repeat is the caller's call;
     it never calls preventDefault. Inside a text field (input other than
     checkbox/radio/button/submit/reset/file/range/color/image, textarea, select, contenteditable)
     only entries with inField === true are consulted.
*/
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  void dep; // keys has no module dependencies; the helper is kept for the §17.1 skeleton

  // ---- tables -------------------------------------------------------------

  var MOD_ALIASES = {
    ctrl: "ctrl", control: "ctrl",
    alt: "alt", option: "alt", opt: "alt",
    shift: "shift",
    meta: "meta", cmd: "meta", command: "meta", "super": "meta", win: "meta", windows: "meta"
  };
  // event.key values of bare modifier presses → canonical modifier name
  var EVENT_MOD_KEYS = { Control: "Ctrl", Alt: "Alt", AltGraph: "Alt", Shift: "Shift", Meta: "Meta", OS: "Meta" };
  var NAMED = {
    space: "Space", spacebar: "Space",
    esc: "Escape", escape: "Escape",
    enter: "Enter", "return": "Enter",
    backspace: "Backspace", "delete": "Delete", del: "Delete",
    tab: "Tab", insert: "Insert", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
    arrowleft: "ArrowLeft", left: "ArrowLeft", arrowright: "ArrowRight", right: "ArrowRight",
    arrowup: "ArrowUp", up: "ArrowUp", arrowdown: "ArrowDown", down: "ArrowDown",
    capslock: "CapsLock", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta"
  };
  var KEY_SYMBOLS = {
    Space: "␣", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
    Escape: "esc", Enter: "↩", Backspace: "⌫", Delete: "⌦", Tab: "⇥",
    Shift: "⇧", Meta: "⌘"
  };
  var NON_TEXT_INPUTS = { checkbox: 1, radio: 1, button: 1, submit: 1, reset: 1, file: 1, range: 1, color: 1, image: 1 };

  // ---- platform -----------------------------------------------------------

  var platformOverride = null, macCache = null;

  function detectMac() {
    try {
      var nav = root.navigator;
      if (!nav) return true; // unknown → Meta
      var ua = String(nav.userAgent || "");
      if (/^Node\.js\//.test(ua)) return true; // node: not a browser platform → Meta
      var p = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || ua;
      p = String(p || "");
      if (!p) return true;
      return /mac|iphone|ipad|ipod/i.test(p);
    } catch (e) { return true; }
  }

  function isMac() {
    if (platformOverride) return platformOverride === "mac";
    if (macCache === null) macCache = detectMac();
    return macCache;
  }

  function setPlatform(p) {
    platformOverride = (p === "mac" || p === "other") ? p : null;
    macCache = null;
  }

  // ---- normalisation ------------------------------------------------------

  function isLetter(ch) {
    return ch.length === 1 && ch.toLowerCase() !== ch.toUpperCase();
  }

  function canonicalKey(k) {
    if (k == null) return "";
    k = String(k);
    if (k === " ") return "Space";
    if (k.length === 1) return isLetter(k) ? k.toLowerCase() : k;
    var low = k.toLowerCase();
    if (NAMED[low]) return NAMED[low];
    if (/^f\d{1,2}$/.test(low)) return low.toUpperCase();
    if (EVENT_MOD_KEYS[k]) return EVENT_MOD_KEYS[k];
    return k;
  }

  function emptyDesc() {
    return { key: "", ctrl: false, alt: false, shift: false, meta: false };
  }

  // The event as a parsed binding.
  function descriptor(ev) {
    var d = { key: "", ctrl: !!ev.ctrlKey, alt: !!ev.altKey, shift: !!ev.shiftKey, meta: !!ev.metaKey };
    var key = ev.key == null ? "" : String(ev.key);
    var code = ev.code == null ? "" : String(ev.code);
    if (EVENT_MOD_KEYS[key]) { // a bare modifier press: the modifier itself, without its own flag
      var name = EVENT_MOD_KEYS[key];
      d.key = name;
      if (name === "Ctrl") d.ctrl = false;
      else if (name === "Alt") d.alt = false;
      else if (name === "Shift") d.shift = false;
      else d.meta = false;
      return d;
    }
    if (d.alt && /^Key[A-Z]$/.test(code)) { d.key = code.charAt(3).toLowerCase(); return d; }
    if (!key && /^Key[A-Z]$/.test(code)) key = code.charAt(3).toLowerCase();
    if (!key && /^Digit\d$/.test(code)) key = code.charAt(5);
    d.key = canonicalKey(key);
    if (d.key.length === 1 && !isLetter(d.key)) d.shift = false;
    return d;
  }

  function format(d) {
    return (d.ctrl ? "Ctrl+" : "") + (d.alt ? "Alt+" : "") + (d.shift ? "Shift+" : "") + (d.meta ? "Meta+" : "") + d.key;
  }

  function normalize(ev) {
    return format(descriptor(ev || {}));
  }

  function parse(binding) {
    var d = emptyDesc();
    if (typeof binding !== "string") return d;
    var s = binding === " " ? "Space" : binding.trim();
    if (!s) return d;
    var key, rest;
    if (s.charAt(s.length - 1) === "+") { // the key is "+" itself ("Mod++", "+")
      key = "+";
      rest = s.slice(0, -1);
      if (rest.charAt(rest.length - 1) === "+") rest = rest.slice(0, -1);
    } else {
      var i = s.lastIndexOf("+");
      if (i < 0) { key = s; rest = ""; } else { key = s.slice(i + 1); rest = s.slice(0, i); }
    }
    if (rest) {
      rest.split("+").forEach(function (m) {
        var n = m.trim().toLowerCase();
        if (!n) return;
        if (n === "mod") { if (isMac()) d.meta = true; else d.ctrl = true; }
        else if (MOD_ALIASES[n]) d[MOD_ALIASES[n]] = true;
      });
    }
    d.key = canonicalKey(key);
    if (d.key.length === 1 && !isLetter(d.key)) d.shift = false; // mirrors normalize()
    return d;
  }

  function canonical(binding) {
    if (Array.isArray(binding)) return binding.map(canonical).filter(Boolean);
    var d = parse(binding);
    return d.key ? format(d) : "";
  }

  // ---- matching -----------------------------------------------------------

  function sameDesc(a, b) {
    return a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;
  }

  function matchDesc(d, binding) {
    if (Array.isArray(binding)) {
      for (var i = 0; i < binding.length; i++) if (matchDesc(d, binding[i])) return true;
      return false;
    }
    if (typeof binding !== "string") return false; // null / undefined: unbound
    var want = parse(binding);
    if (!want.key) return false;
    return sameDesc(d, want);
  }

  function match(ev, binding) {
    if (!ev) return false;
    var d = typeof ev === "string" ? parse(ev) : descriptor(ev);
    if (!d.key) return false;
    return matchDesc(d, binding);
  }

  // ---- text fields --------------------------------------------------------

  function editableAttr(el) {
    try {
      if (typeof el.getAttribute === "function") {
        var ce = el.getAttribute("contenteditable");
        if (ce != null && String(ce).toLowerCase() !== "false") return true;
      }
    } catch (e) { /* not an element */ }
    return false;
  }

  function isTextTarget(t) {
    if (!t || typeof t !== "object") return false;
    var tag = String(t.tagName || t.nodeName || "").toUpperCase();
    if (tag === "INPUT") {
      var type = String(t.type || "text").toLowerCase();
      return !NON_TEXT_INPUTS[type];
    }
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable === true || editableAttr(t)) return true;
    var p = t.parentNode, depth = 0;
    while (p && depth++ < 64) {
      if (p.isContentEditable === true || editableAttr(p)) return true;
      p = p.parentNode;
    }
    return false;
  }

  // ---- dispatch -----------------------------------------------------------

  function normEntry(entry) {
    if (entry == null) return null;
    if (typeof entry === "string" || Array.isArray(entry)) return { binding: entry, inField: false };
    if (typeof entry === "object") return entry;
    return null;
  }

  function dispatch(ev, maps) {
    if (!ev || ev.isComposing || ev.keyCode === 229) return null;
    if (!Array.isArray(maps)) maps = maps ? [maps] : [];
    var d = descriptor(ev);
    if (!d.key) return null;
    var inField = isTextTarget(ev.target);
    for (var m = 0; m < maps.length; m++) {
      var map = maps[m];
      if (!map || typeof map !== "object") continue;
      var ids = Object.keys(map);
      for (var i = 0; i < ids.length; i++) {
        var entry = normEntry(map[ids[i]]);
        if (!entry) continue;
        if (inField && entry.inField !== true) continue;
        if (matchDesc(d, entry.binding)) {
          if (typeof entry.run === "function") entry.run(ev);
          return ids[i];
        }
      }
    }
    return null;
  }

  // ---- conflicts ----------------------------------------------------------

  function bindingsOf(entry) {
    if (entry == null) return [];
    if (typeof entry === "string") return [entry];
    if (Array.isArray(entry)) return entry;
    if (typeof entry === "object") return bindingsOf(entry.binding);
    return [];
  }

  function conflicts(map) {
    if (!map || typeof map !== "object") return [];
    var byBinding = Object.create(null), order = [];
    Object.keys(map).forEach(function (id) {
      bindingsOf(map[id]).forEach(function (b) {
        var c = canonical(b);
        if (!c) return;
        var list = byBinding[c];
        if (!list) { list = byBinding[c] = []; order.push(c); }
        if (list.indexOf(id) < 0) list.push(id);
      });
    });
    var out = [], seen = Object.create(null);
    order.forEach(function (c) {
      var list = byBinding[c];
      for (var i = 0; i < list.length; i++) {
        for (var j = i + 1; j < list.length; j++) {
          var k = list[i] + "\u0000" + list[j];
          if (seen[k]) continue;
          seen[k] = true;
          out.push([list[i], list[j]]);
        }
      }
    });
    return out;
  }

  // ---- labels -------------------------------------------------------------

  function label(binding) {
    if (Array.isArray(binding)) return binding.map(label).filter(Boolean).join(" / ");
    var d = parse(binding);
    if (!d.key) return "";
    var mac = isMac(), parts = [];
    if (d.ctrl) parts.push(mac ? "⌃" : "Ctrl");
    if (d.alt) parts.push(mac ? "⌥" : "Alt");
    if (d.shift) parts.push("⇧");
    if (d.meta) parts.push("⌘");
    var k = d.key, sym;
    if (k === "Ctrl") sym = mac ? "⌃" : "Ctrl";
    else if (k === "Alt") sym = mac ? "⌥" : "Alt";
    else if (KEY_SYMBOLS[k]) sym = KEY_SYMBOLS[k];
    else if (k.length === 1) sym = k.toUpperCase();
    else sym = k;
    parts.push(sym);
    return parts.join(mac ? "" : "+");
  }

  // ---- maps & presets -----------------------------------------------------

  function deepFreeze(o) {
    Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === "object") deepFreeze(o[k]); });
    return Object.freeze(o);
  }

  function mapOf(bindings, inField) {
    var map = {};
    Object.keys(bindings).forEach(function (id) { map[id] = { binding: bindings[id], inField: inField }; });
    return map;
  }

  // flag and delete (FEATURES P1.3, 2026-11-11) came after the first seven: a stored settings.reviewKeys from before
  // lacks them (LATE_REVIEW_ACTIONS, see reviewMap and presetOf).
  var REVIEW_ACTIONS = Object.freeze(["showAnswer", "forgot", "remembered", "undo", "skip", "goToSource", "flag", "delete", "exit"]);
  var LATE_REVIEW_ACTIONS = Object.freeze(["flag", "delete"]);

  var PRESETS = deepFreeze({
    "Default": { showAnswer: "Space", forgot: "1", remembered: "2", undo: "u", skip: "s", goToSource: "g", flag: "f", "delete": "Backspace", exit: "Escape" },
    "Arrows": { showAnswer: "Space", forgot: "ArrowLeft", remembered: "ArrowRight", undo: "u", skip: "s", goToSource: "g", flag: "f", "delete": "Backspace", exit: "Escape" },
    "Vim": { showAnswer: "Space", forgot: "j", remembered: "k", undo: "u", skip: "s", goToSource: "g", flag: "f", "delete": "Backspace", exit: "q" },
    "Anki-like": { showAnswer: "Space", forgot: "1", remembered: "3", undo: "z", skip: "s", goToSource: "g", flag: "f", "delete": "Backspace", exit: "Escape" }
  });

  var READER_MAP = deepFreeze(mapOf({
    prompt: "n", cloze: "c", highlight: "h", obsidianNote: "o",
    next: "j", prev: "k", edit: "e", toggleAnswer: "Enter", goToPassage: "g", flag: "f",
    "delete": ["Backspace", "Delete"], undoDelete: "z",
    hideAnswers: "a", markers: "m", dim: "d",
    list: "l", find: "Mod+f", pageBox: "p",
    snip: "s", snipMode: "Shift+s", escape: "Escape",
    reviewBook: "r", reviewAll: "Shift+r", reviewToday: "t",
    markChapter: "Shift+c",
    zoomIn: ["Mod+=", "Mod++"], zoomOut: "Mod+-", zoomFit: "Mod+0",
    openPdf: "Mod+o", shortcuts: "?", settings: ","
  }, false));

  var EDITOR_MAP = deepFreeze(mapOf({
    save: "Mod+Enter", saveAnother: "Mod+Shift+Enter", cancel: "Escape", wrapCloze: "Alt+Shift+c"
  }, true));

  // Tabs (D30, BUILD-NOTES "Tabs"): the commands work while a text field has the focus (inField). Cmd+Shift+] and
  // Cmd+Shift+[ arrive as "}" and "{" (normalize() keeps a shifted symbol as it is and adds no Shift+).
  var TABS_MAP = deepFreeze(mapOf({
    newTab: "Mod+t", closeTab: "Mod+w", reopenTab: "Mod+Shift+t",
    nextTab: ["Ctrl+Tab", "Mod+}"], prevTab: ["Ctrl+Shift+Tab", "Mod+{"],
    tab1: "Mod+1", tab2: "Mod+2", tab3: "Mod+3", tab4: "Mod+4", tab5: "Mod+5", tab6: "Mod+6", tab7: "Mod+7", tab8: "Mod+8",
    lastTab: "Mod+9"
  }, true));

  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function plainBinding(b) { return b && typeof b === "object" && !Array.isArray(b) ? b.binding : b; }

  // Does another review action of `src` (a stored map) already use `binding`? Canonical comparison, every key of an
  // array binding; unknown ids in `src` are ignored. js/settings.js applies the same rule (fillLate).
  function usedByOther(src, action, binding) {
    var want = canonical(binding);
    if (!want) return false;
    for (var i = 0; i < REVIEW_ACTIONS.length; i++) {
      var a = REVIEW_ACTIONS[i];
      if (a === action || !own(src, a)) continue;
      var got = bindingsOf(plainBinding(src[a]));
      for (var j = 0; j < got.length; j++) if (canonical(got[j]) === want) return true;
    }
    return false;
  }

  // settings.reviewKeys ({actionId: binding}) → a map in the dispatch shape. Missing actions take the
  // Default preset's binding; an explicit null/"" stays unbound. A missing late action (flag, delete: a map stored
  // before they existed) takes its Default binding only when no other action of the map uses that key, else it stays
  // unbound: never two review actions on one key. "?" (shortcut sheet) is fixed.
  function reviewMap(reviewKeys) {
    var src = reviewKeys && typeof reviewKeys === "object" ? reviewKeys : {};
    var map = {};
    REVIEW_ACTIONS.forEach(function (id) {
      var b;
      if (own(src, id)) b = src[id];
      else if (LATE_REVIEW_ACTIONS.indexOf(id) >= 0 && usedByOther(src, id, PRESETS.Default[id])) b = null;
      else b = PRESETS.Default[id];
      b = plainBinding(b); // already dispatch-shaped
      map[id] = { binding: b ? b : null, inField: false };
    });
    map.shortcuts = { binding: "?", inField: false };
    return map;
  }

  // Name of the preset whose bindings equal reviewKeys (canonical comparison), else null ("Custom"). A late action
  // the map lacks (a map stored before flag and delete existed) does not count against a preset.
  function presetOf(reviewKeys) {
    if (!reviewKeys || typeof reviewKeys !== "object") return null;
    var names = Object.keys(PRESETS);
    for (var i = 0; i < names.length; i++) {
      var p = PRESETS[names[i]], same = true;
      for (var j = 0; j < REVIEW_ACTIONS.length; j++) {
        var a = REVIEW_ACTIONS[j];
        if (!own(reviewKeys, a) && LATE_REVIEW_ACTIONS.indexOf(a) >= 0) continue;
        var got = plainBinding(reviewKeys[a]);
        if (String(canonical(got)) !== String(canonical(p[a]))) { same = false; break; }
      }
      if (same) return names[i];
    }
    return null;
  }

  var api = {
    normalize: normalize,
    parse: parse,
    match: match,
    label: label,
    dispatch: dispatch,
    conflicts: conflicts,
    reviewMap: reviewMap,
    PRESETS: PRESETS,
    READER_MAP: READER_MAP,
    EDITOR_MAP: EDITOR_MAP,
    TABS_MAP: TABS_MAP,
    REVIEW_ACTIONS: REVIEW_ACTIONS,
    LATE_REVIEW_ACTIONS: LATE_REVIEW_ACTIONS,
    // extensions (documented in the engineer's report)
    canonical: canonical,
    isTextTarget: isTextTarget,
    isMac: isMac,
    setPlatform: setPlatform,
    presetOf: presetOf
  };
  M.keys = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.keys + BUILD-NOTES "Key routing"): normalize(ev) → binding;
   parse(binding) → {key, ctrl, alt, shift, meta} (expands Mod+); match(ev, binding|array) → boolean;
   label(binding) → display string; dispatch(ev, maps) → actionId|null; conflicts(map) → [[a, b]];
   reviewMap(reviewKeys) → dispatch-shaped map; PRESETS {Default, Arrows, Vim, "Anki-like"}; READER_MAP (with
   obsidianNote "o", BUILD-NOTES "Obsidian"); EDITOR_MAP; REVIEW_ACTIONS. Extensions: canonical(binding),
   isTextTarget(el), isMac(), setPlatform(p), presetOf(reviewKeys).
   BUILD-NOTES "Prompt craft" (FEATURES P1.3): REVIEW_ACTIONS gains flag and delete (before exit; LATE_REVIEW_ACTIONS),
   every preset binds flag "f" and delete "Backspace"; reviewMap leaves a missing late action unbound when another
   action of the map already uses its Default key; presetOf ignores a missing late action.
   BUILD-NOTES "Tabs" (D30): TABS_MAP (inField: true): newTab "Mod+t", closeTab "Mod+w", reopenTab "Mod+Shift+t",
   nextTab ["Ctrl+Tab", "Mod+}"], prevTab ["Ctrl+Shift+Tab", "Mod+{"], tab1 … tab8 "Mod+1" … "Mod+8", lastTab "Mod+9". */
