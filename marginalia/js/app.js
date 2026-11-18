/* js/app.js — M.app: boot, routing, the focus owner and the ONE document keydown listener, toasts,
 * the in-page confirm dialog, theme, the shortcut sheet, store banners and global error handling.
 *
 * SPEC §3 (focus owner, key routing, Escape chain, no alert/confirm/prompt), §10 (M.app owns the three
 * review triggers), §13 (theme via data-theme on the root element), §17.2 M.app, §17.3 events; BUILD-NOTES "Key routing",
 * "Routing and review triggers", "Decisions" (?pdf=<url>, isArtifact()).
 *
 * DOM module: window/document are touched only inside functions that run after boot(), so `node --check`
 * and `require()` are safe. It builds no reader, margin, review or library DOM: it fills only its own hosts
 * #toasts, #confirm, #banner and #shortcuts, and toggles .is-hidden on the three screens.
 *
 * Routing table (BUILD-NOTES "Key routing"), by focus owner:
 *   reader / card  : M.keys.dispatch(ev, [READER_MAP]) → M.snip.run(id) → M.reader.run(id) → M.margin.run(id)
 *                    → app (reviewBook, reviewAll, reviewToday, openPdf, shortcuts, settings, escape)
 *   editor         : M.keys.dispatch(ev, [EDITOR_MAP]) → (M.margin.activeEditor() || M.library.activeEditor()).run(id)
 *   review         : M.keys.reviewMap(settings.reviewKeys) → M.review.reveal/grade/undo/skip/goToSource/flag/remove/stop;
 *                    "?" → sheet
 *   library / settings / list / other : openPdf, shortcuts, settings, escape, reviewAll, reviewToday
 * Undo and redo (DECISIONS D33, BUILD-NOTES "Undo and redo"): after M.tabs.handleKey and before the owner's map,
 * M.keys.UNDO_MAP (Cmd+Z, Shift+Cmd+Z; never inside a text field) → M.undo.run("undo" | "redo"); in a review Cmd+Z is
 * M.review.undo(); while the settings or a dialog is open the keys are left alone.
 * Escape chain: shortcut sheet → confirm → settings (M.library.closeSettings) → the reader's prompt-list drawer
 * (M.list.close, only while #list is shown: never the deck page's inline list, SPEC §14) → then,
 * for reader/card, M.snip.run("escape") → M.reader.run("escape") → M.margin.run("escape").
 * ev.isComposing and ev.defaultPrevented are always ignored; ev.repeat is ignored for single-shot actions
 * (only next/prev/zoomIn/zoomOut repeat); preventDefault() is called only when an action was handled.
 *
 * One writing tab per origin (js/store.js): when a newer Marginalia tab of this origin opens the library, the store
 * stops writing here and emits store:mode {reason: "othertab"}. This tab then steps aside: a blocking notice
 * (#tabLock, appended to #app) covers the whole app, "Marginalia is open in another tab", with one button, "Use this
 * tab", which reloads the page (the reloaded tab announces itself, so the other tab steps aside in turn). Text still
 * unsaved in an open editor (the margin's, the deck add-box, a deck prompt being edited) or in a save the lock refused
 * (prompt:refused from M.cache) is shown in the notice, through M.util.escapeHtml, with "Copy text". Nothing behind
 * the notice can be reached: the other #app children get `inert`, keydown / paste / drops are caught in the capture
 * phase (Tab cycles inside the notice, Escape does nothing, a key aimed elsewhere brings focus back), focus stays in
 * it, and route(), confirm(), toast() and the rest of boot do nothing more.
 *
 * The desktop app (js/desktop.js, FEATURES E2.2): boot calls M.desktop.start() first, so a browser page served from
 * 127.0.0.1 or localhost asks GET /api/app (at most 3 s) while the library loads, and waits for that answer before it
 * routes, sweeps, reads ?pdf= or starts the daily backup. In cover mode (the app's server answered: the desktop app
 * replaced this browser page) boot shows M.desktop's cover instead and does none of them, and route() does nothing.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  // ---- constants ------------------------------------------------------------

  var OWNERS = ["reader", "card", "editor", "list", "review", "library", "settings"];
  var SCREENS = ["library", "deck", "reader", "stats"];   // "stats": the statistics page (D27), no collection
  var TOAST_TTL = 6000;        // §17: ttl default 6 s
  var TOAST_MAX = 5;           // older toasts are dropped beyond this
  var TOAST_OUT_MS = 160;      // matches the .toast--out transition in css/app.css
  var ERROR_TEXT = "Something went wrong — see the console";
  var ERROR_GAP_MS = 2000;     // one error toast per burst
  var REPEATABLE = { next: 1, prev: 1, zoomIn: 1, zoomOut: 1 };
  var LIBRARY_IDS = ["openPdf", "shortcuts", "settings", "escape", "reviewAll", "reviewToday", "undoDelete"];
  var REVIEW_CALLS = {
    showAnswer: ["reveal"], forgot: ["grade", "forgot"], remembered: ["grade", "remembered"],
    undo: ["undo"], skip: ["skip"], goToSource: ["goToSource"], flag: ["flag"], "delete": ["remove"], exit: ["stop"]
  };
  var MSG_UNAVAILABLE = "Storage unavailable in this view — export often";
  var MSG_VERSIONCHANGE = "Marginalia was updated in another tab — reload";
  var MSG_BLOCKED = "Close other Marginalia tabs so storage can finish updating";
  var MSG_OTHER_TAB = "Marginalia is open in another tab";
  var TAB_LOCK_BODY = "Only the newest Marginalia tab saves, so this one has stopped saving. “Use this tab” reloads it " +
    "with the latest library, and the other tab steps aside.";
  var TAB_LOCK_TEXT = "This text was not saved. Copy it before you use this tab:";

  // Shortcut sheet: display order and human labels per action id.
  var READER_ORDER = ["prompt", "cloze", "highlight", "obsidianNote", "next", "prev", "edit", "toggleAnswer", "goToPassage", "flag",
    "delete", "undoDelete", "hideAnswers", "markers", "dim", "list", "find", "pageBox", "snip", "snipMode",
    "reviewBook", "reviewAll", "reviewToday", "markChapter", "zoomIn", "zoomOut", "zoomFit", "openPdf",
    "shortcuts", "settings", "escape"];
  var EDITOR_ORDER = ["save", "saveAnother", "cancel", "wrapCloze"];
  var LIBRARY_ORDER = ["openPdf", "reviewAll", "reviewToday", "settings", "shortcuts", "escape"];
  var LABELS = {
    prompt: "Prompt for the selection (free note without one)", cloze: "Cloze from the selection", highlight: "Highlight only",
    obsidianNote: "Note → Obsidian for the selection (free note without one)",
    next: "Next card", prev: "Previous card", edit: "Edit card", toggleAnswer: "Show / hide the answer",
    goToPassage: "Go to the passage", flag: "Flag card", "delete": "Delete card", undoDelete: "Undo delete (while the toast shows)",
    hideAnswers: "Hide answers in the margin", markers: "Markers mode", dim: "Dim pages", list: "Prompt list",
    find: "Find in document", pageBox: "Go to page", snip: "Snip a region to the clipboard", snipMode: "Snip copies Image / LaTeX",
    reviewBook: "Review this book", reviewAll: "Review all due prompts", reviewToday: "Review today's prompts",
    markChapter: "Mark chapter start here", zoomIn: "Zoom in", zoomOut: "Zoom out", zoomFit: "Fit width",
    openPdf: "Open a PDF", shortcuts: "Keyboard shortcuts", settings: "Settings", escape: "Close / cancel",
    save: "Save", saveAnother: "Save and start another card here", cancel: "Cancel (discard a new card, revert an edit)",
    wrapCloze: "Wrap the selection in {braces}",
    showAnswer: "Show answer", forgot: "Forgot", remembered: "Remembered", undo: "Undo last grade",
    skip: "Skip (ask later this session)", goToSource: "Go to source", exit: "Exit review"
  };
  // The review section of the sheet: review actions that share an id with a reader action keep their own names.
  var REVIEW_LABELS = { flag: "Flag for revision", "delete": "Delete prompt" };
  var LIBRARY_LABELS = { escape: "Close the list drawer, settings or this sheet", reviewToday: "Review today's prompts (everywhere)" };

  // ---- state ----------------------------------------------------------------

  var state = {
    owner: "library",
    screen: null,          // "library" | "deck" | "reader" | "stats" (null before the first route)
    params: {},            // {collectionId, promptId, pageIndex}
    openDoc: null,         // collectionId of the open book (doc:opened / doc:closed)
    booted: null,          // the boot promise
    bound: false,          // DOM listeners installed
    busBound: false,       // bus listeners installed
    routing: null,         // {screen, cid, promise} while a route is in flight (re-entrancy guard)
    ignoreHash: null,      // a hash we wrote ourselves through location.hash (fallback path)
    hashFallback: false,   // the last history call failed (no history API here): an address change cannot be told from Back (see ownEntry)
    taking: null,          // D31: this window is taking the writer role (the promise of takeRole)
    roleNotice: false,     // D31: boot is past its own wait for the role
    roleBroken: false,     // D31: the last try to take the role failed (the library could not be read again)
    cacheLoad: null,       // D31: the promise of boot's M.cache.load()
    reviewHeld: false,     // D31: this window holds "review" (its session runs, or "Go to source" set it aside)
    reviewReplacing: false,// D31: this window's next review is starting, and replaces the session that holds "review"
    reviewDone: null,      // D31: ends that hold
    takingAt: 0,           // D31: when takeRole began to wait
    libraryMap: null,      // cached dispatch map for library / settings / list owners
    toasts: [],            // [{id, el, timer, close}]
    confirmQueue: [],      // confirm() calls waiting for the open dialog to close
    confirmOpen: null,     // {host, dlg, okBtn, cancelBtn, invoker, done}
    sheet: null,           // {host, panel, invoker, onBackdrop}
    banners: [],           // [{id, el, close}]
    lastErrorAt: 0,
    lock: null,            // the "open in another tab" notice once this tab stepped aside (see the header)
    reload: null           // test hook (_setReload): what "Use this tab" calls instead of location.reload()
  };

  // ---- small helpers --------------------------------------------------------

  function noop() {}
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function warn(msg) { try { console.warn("[app] " + msg); } catch (e) { /* no console */ } }
  function report(where, e) { try { console.error("[app] " + where + ":", e); } catch (e2) { /* no console */ } }
  function emit(type, payload) {
    var bus = tryDep("bus");
    if (!bus || typeof bus.emit !== "function") return;
    try { bus.emit(type, payload); } catch (e) { report("bus.emit(" + type + ")", e); }
  }
  function hasDom() { return typeof document !== "undefined" && !!document && typeof document.getElementById === "function"; }
  function $(id) { return hasDom() ? document.getElementById(id) : null; }
  function keys() { return tryDep("keys"); }
  function mod(name) { var m = M[name]; return m && typeof m === "object" ? m : null; }
  function has(name, fn) { var m = mod(name); return !!m && typeof m[fn] === "function"; }

  // DOM builder: attrs {class, text, id, role, aria-*, …}; children = node | string | array.
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "text") el.textContent = String(v);
        else if (k === "class") el.className = String(v);
        else el.setAttribute(k, v === true ? "" : String(v));
      });
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return el;
  }

  // A button whose label is always text (never HTML). noFocus: mousedown is prevented so the click
  // never moves focus (a toast "never steals focus"; a stray click must not blur the editor).
  function button(label, className, onClick, opts) {
    opts = opts || {};
    var b = h("button", { type: "button", "class": className, "aria-label": opts.ariaLabel, title: opts.title }, String(label));
    if (opts.noFocus) b.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
    b.addEventListener("click", onClick);
    return b;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try { return el.getClientRects().length > 0; } catch (e) { return false; }
  }

  function focusEl(el) {
    if (!el || typeof el.focus !== "function") return false;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { return false; } }
    return document.activeElement === el;
  }

  // The owner a screen defaults to when a layer above it closes.
  function screenOwner() { return state.screen === "reader" ? "reader" : "library"; }

  // Put focus back where the current owner expects it (after a toast, sheet or dialog closes).
  function refocusScreen() {
    if (!hasDom()) return;
    if (state.lock) { focusLock(state.lock); return; }
    if (state.sheet || state.confirmOpen) return;
    var owner = state.owner;
    if (owner === "editor") {
      var ed = activeEditor();
      if (ed && typeof ed.focus === "function") { try { ed.focus(); return; } catch (e) { /* fall through */ } }
    }
    if (owner === "review" && focusEl($("review"))) return;
    if ((owner === "reader" || owner === "card") && state.screen === "reader" && focusEl($("reader"))) return;
    blurHidden();
  }

  function blurHidden() {
    if (!hasDom()) return;
    var a = document.activeElement;
    if (a && a !== document.body && !isVisible(a)) { try { a.blur(); } catch (e) { /* ignore */ } }
  }

  function restoreFocus(invoker) {
    if (invoker && invoker !== document.body && isVisible(invoker) && focusEl(invoker)) return;
    refocusScreen();
  }

  // Keyboard trap for the sheet and the dialog: Tab cycles inside `container`.
  function trapTab(ev, container) {
    var all = container.querySelectorAll("button, [href], input, select, textarea, [tabindex]");
    var list = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.disabled || el.getAttribute("tabindex") === "-1" || !isVisible(el)) continue;
      list.push(el);
    }
    ev.preventDefault();
    if (!list.length) { focusEl(container); return; }
    var idx = list.indexOf(document.activeElement);
    var next;
    if (ev.shiftKey) next = idx <= 0 ? list[list.length - 1] : list[idx - 1];
    else next = idx < 0 || idx >= list.length - 1 ? list[0] : list[idx + 1];
    focusEl(next);
  }

  // ---- focus owner (SPEC §3) --------------------------------------------------

  function setFocusOwner(owner) {
    var o = owner == null ? "" : String(owner);
    if (!o) return state.owner;
    if (OWNERS.indexOf(o) < 0) warn("unknown focus owner \"" + o + "\" (routing it like the library)");
    state.owner = o;
    return o;
  }

  function focusOwner() { return state.owner; }

  function activeEditor() {
    var ed = null;
    if (has("margin", "activeEditor")) { try { ed = M.margin.activeEditor(); } catch (e) { report("margin.activeEditor", e); } }
    if (!ed && has("library", "activeEditor")) { try { ed = M.library.activeEditor(); } catch (e) { report("library.activeEditor", e); } }
    return ed || null;
  }

  // A key typed inside an editor (its textarea, preview or buttons) always belongs to that editor,
  // even when nobody set the owner (the deck page's batch box, for instance).
  function effectiveOwner(ev) {
    var owner = state.owner || "library";
    if (owner !== "editor") {
      var t = ev.target;
      if (t && typeof t.closest === "function") {
        try { if (t.closest(".editor")) owner = "editor"; } catch (e) { /* not an element */ }
      }
    }
    return owner;
  }

  // ---- maps -------------------------------------------------------------------

  function reviewMap() {
    var k = keys(), settings = tryDep("settings"), rk = null;
    try { rk = settings && typeof settings.get === "function" ? settings.get("reviewKeys") : null; } catch (e) { rk = null; }
    if (k && typeof k.reviewMap === "function") return k.reviewMap(rk);
    // Fallback when keys.js predates reviewMap: Default preset + overrides, "?" fixed.
    var map = {}, actions = (k && k.REVIEW_ACTIONS) || Object.keys(REVIEW_CALLS);
    var preset = (k && k.PRESETS && k.PRESETS.Default) || {};
    actions.forEach(function (id) {
      var b = rk && Object.prototype.hasOwnProperty.call(rk, id) ? rk[id] : preset[id];
      if (b && typeof b === "object" && !Array.isArray(b)) b = b.binding;
      map[id] = { binding: b ? b : null, inField: false };
    });
    map.shortcuts = { binding: "?", inField: false };
    return map;
  }

  function libraryMap() {
    if (state.libraryMap) return state.libraryMap;
    var k = keys(), R = (k && k.READER_MAP) || {}, map = {};
    LIBRARY_IDS.forEach(function (id) { if (R[id]) map[id] = R[id]; });
    if (!map.escape) map.escape = { binding: "Escape", inField: false };
    state.libraryMap = map;
    return map;
  }

  // ---- the ONE keydown listener ----------------------------------------------

  function runModule(name, id) {
    var m = mod(name);
    if (!m || typeof m.run !== "function") return false;
    try { return m.run(id) === true; } catch (e) { report(name + ".run(" + id + ")", e); return false; }
  }

  function settingsOpen() {
    var el = $("settings");
    if (el) return !el.classList.contains("is-hidden");
    return state.owner === "settings";
  }

  // A dialog of another module that is up: Export / Import (js/exporter.js) and the "Move to folder…" picker
  // (js/library.js). Each is a `.dialog` element that is in the page only while it is open.
  function dialogOpen() {
    try { return !!(hasDom() && typeof document.querySelector === "function" && document.querySelector(".dialog")); }
    catch (e) { return false; }
  }

  function closeSettings() {
    if (!has("library", "closeSettings")) return false;
    try { M.library.closeSettings(); } catch (e) { report("library.closeSettings", e); return false; }
    if (state.owner === "settings") { setFocusOwner(screenOwner()); refocusScreen(); }
    return true;
  }

  // Only the reader's prompt-list DRAWER takes part in the Escape chain. The deck page mounts the same module
  // inline (M.library.openDeck → M.list.open(id, {host})) as a permanent section with no close control and no
  // way to re-open it (SPEC §14), so M.list.isOpen() alone is not enough: any Escape that reached the document
  // there (focus on body, '‹ Library', the h1, 'Review this deck') emptied it. The inline list handles its own
  // Escape while focused (list.js). The drawer is open exactly while #list is shown (list.js removes .is-hidden
  // on a drawer open and adds it back on close); with a document but no #list host only an inline list can be
  // open; without a document (node, stubbed M.list) an open list is taken to be the drawer.
  function listOpen() {
    if (!has("list", "isOpen")) return false;
    try { if (M.list.isOpen() !== true) return false; } catch (e) { return false; }
    if (!hasDom()) return true;
    var drawer = $("list");
    if (!drawer) return false;
    try { return !drawer.classList.contains("is-hidden"); } catch (e2) { return false; }
  }

  function closeList() {
    if (!has("list", "close")) return false;
    try { M.list.close(); } catch (e) { report("list.close", e); return false; }
    if (state.owner === "list") { setFocusOwner(screenOwner()); refocusScreen(); }
    return true;
  }

  function escapeChain(owner) {
    if (closeShortcuts()) return true;
    if (cancelConfirm()) return true;
    if (settingsOpen() && closeSettings()) return true;
    if (listOpen() && closeList()) return true;
    if (owner === "reader" || owner === "card") {
      if (runModule("snip", "escape")) return true;
      if (runModule("reader", "escape")) return true;
      if (runModule("margin", "escape")) return true;
    }
    if (state.screen === "stats") { api.route("library"); return true; }   // Esc on the statistics page: back to the library
    return false;
  }

  function openCollectionId() {
    if (state.openDoc) return state.openDoc;
    return state.screen === "reader" && state.params.collectionId ? state.params.collectionId : null;
  }

  // The collection "today" reviews from the current screen (reader: the book; deck page: the deck; library: everywhere).
  function currentCollectionId() {
    if ((state.screen === "reader" || state.screen === "deck") && state.params.collectionId) return state.params.collectionId;
    return state.openDoc || null;
  }

  function openPdfPicker() {
    var input = $("fileInput");
    if (!input) return false;
    if (has("store", "persist")) { try { Promise.resolve(M.store.persist()).catch(noop); } catch (e) { /* ignore */ } }
    try { input.click(); } catch (e) { report("fileInput.click", e); return false; }
    return true;
  }

  function toggleSettings() {
    if (settingsOpen()) return closeSettings();
    if (!has("library", "openSettings")) return false;
    try { M.library.openSettings(); } catch (e) { report("library.openSettings", e); return false; }
    return true;
  }

  function runApp(id, owner) {
    switch (id) {
      case "reviewBook": {
        var cid = openCollectionId();
        if (!cid) return false;
        startReview("book", cid);
        return true;
      }
      case "reviewAll": startReview("all", null); return true;
      case "reviewToday": startReview("today", currentCollectionId()); return true;
      case "openPdf": return openPdfPicker();
      case "shortcuts": return openShortcuts();
      case "settings": return toggleSettings();
      case "escape": return escapeChain(owner);
      case "undoDelete":
        // Z while a "Deleted · Undo (Z)" toast shows: the list drawer's undo first, then the library's
        if (has("list", "undoLast") && M.list.undoLast() === true) return true;
        return has("library", "undoDelete") && M.library.undoDelete() === true;
      default: return false;
    }
  }

  function routeReader(ev, k, owner) {
    var id = k.dispatch(ev, [k.READER_MAP]);
    if (!id) return false;
    if (ev.repeat && !REPEATABLE[id]) return true;      // single-shot: swallow the repeat
    if (id === "escape") return escapeChain(owner);
    if (runModule("snip", id)) return true;
    if (runModule("reader", id)) return true;
    if (runModule("margin", id)) return true;
    return runApp(id, owner);
  }

  function routeEditor(ev, k) {
    var id = k.dispatch(ev, [k.EDITOR_MAP]);
    if (!id) return false;
    if (ev.repeat) return true;
    var ed = activeEditor();
    if (!ed || typeof ed.run !== "function") return false;
    try { return ed.run(id) === true; } catch (e) { report("editor.run(" + id + ")", e); return false; }
  }

  function routeReview(ev, k) {
    var id = k.dispatch(ev, [reviewMap()]);
    if (!id) return false;
    if (ev.repeat) return true;
    if (id === "shortcuts") return openShortcuts();
    var call = REVIEW_CALLS[id];
    if (!call || !has("review", call[0])) return false;
    try { M.review[call[0]].apply(M.review, call.slice(1)); } catch (e) { report("review." + call[0], e); }
    return true;                                          // the key was meant for review: keep its default (Space scrolls) away
  }

  function routeLibrary(ev, k, owner) {
    var id = k.dispatch(ev, [libraryMap()]);
    if (!id) return false;
    if (ev.repeat) return true;
    return runApp(id, owner);
  }

  // DECISIONS D33: Cmd+Z / Shift+Cmd+Z outside a text field (M.keys.UNDO_MAP) → the last change to a card
  // (M.undo). In a review Cmd+Z is the review's own undo (U) and redo does nothing. While the settings or a dialog
  // is open the keys are left alone (false: no preventDefault). A held key acts once. An open editor does not stop
  // them (its text field keeps the keys for its own text; M.undo itself leaves a card alone that an editor holds).
  function routeUndo(ev, id) {
    var owner = effectiveOwner(ev);
    if (settingsOpen() || dialogOpen()) return false;
    try { ev.preventDefault(); } catch (e) { /* synthetic event */ }
    if (ev.repeat) return true;
    if (owner === "review") {
      if (id === "undo" && has("review", "undo")) { try { M.review.undo(); } catch (e2) { report("review.undo", e2); } }
      return true;
    }
    if (has("undo", "run")) { try { M.undo.run(id); } catch (e3) { report("undo.run(" + id + ")", e3); } }
    return true;
  }

  function handleSheetKey(ev, k) {
    if (k.match(ev, "Escape") || k.match(ev, "?")) { ev.preventDefault(); closeShortcuts(); return true; }
    if (k.match(ev, "Tab") || k.match(ev, "Shift+Tab")) { trapTab(ev, state.sheet.panel); return true; }
    return false;                                         // nothing else routes while the sheet is up
  }

  function handleConfirmKey(ev, k) {
    var c = state.confirmOpen;
    if (k.match(ev, "Escape")) { ev.preventDefault(); c.done(false, true); return true; }
    if (k.match(ev, "Enter")) {
      if (ev.target === c.cancelBtn) return false;        // a focused Cancel keeps its native Enter
      ev.preventDefault(); c.done(true); return true;
    }
    if (k.match(ev, "Tab") || k.match(ev, "Shift+Tab")) { trapTab(ev, c.dlg); return true; }
    return false;
  }

  function handleKeydown(ev) {
    if (!ev || ev.isComposing || ev.keyCode === 229 || ev.defaultPrevented) return false;
    if (state.lock) return lockKey(ev);                   // this tab stepped aside: nothing routes any more
    var k = keys();
    if (!k || typeof k.dispatch !== "function") return false;
    if (state.sheet) return handleSheetKey(ev, k);
    if (state.confirmOpen) return handleConfirmKey(ev, k);
    if (has("tabs", "handleKey")) {                       // D30: Cmd+T, Cmd+W, Ctrl+Tab, Cmd+1 … (M.keys.TABS_MAP)
      var tabbed = false;
      try { tabbed = M.tabs.handleKey(ev) === true; } catch (e) { report("tabs.handleKey", e); }
      if (tabbed) { try { ev.preventDefault(); } catch (e2) { /* synthetic event */ } return true; }
    }
    var undoId = k.UNDO_MAP ? k.dispatch(ev, [k.UNDO_MAP]) : null;   // D33: never inside a text field
    if (undoId) return routeUndo(ev, undoId);
    var owner = effectiveOwner(ev), handled;
    if (owner === "editor") handled = routeEditor(ev, k);
    else if (owner === "review") handled = routeReview(ev, k);
    else if (owner === "reader" || owner === "card") handled = routeReader(ev, k, owner);
    else handled = routeLibrary(ev, k, owner);
    if (handled) { try { ev.preventDefault(); } catch (e) { /* synthetic event */ } }
    return !!handled;
  }

  // ---- review triggers (SPEC §10) ---------------------------------------------

  function startReview(scope, collectionId) {
    var cid = collectionId == null || collectionId === "" ? null : String(collectionId);
    // "folder" (FEATURES L1.5): collectionId is the folder's id; M.review reviews everything in it
    var s = (scope === "book" || scope === "deck" || scope === "today" || scope === "all" || scope === "folder") ? scope : "all";
    if ((s === "book" || s === "deck" || s === "folder") && !cid) return Promise.reject(err("no_collection", "A " + s + " review needs a collectionId"));
    if ((s === "book" || s === "deck") && has("cache", "collection")) {
      var c = null;
      try { c = M.cache.collection(cid); } catch (e) { c = null; }
      if (c && c.kind === "deck") s = "deck";
      else if (c && c.kind === "book") s = "book";
    }
    if (!has("review", "start")) return Promise.reject(err("no_review", "M.review is not loaded"));
    closeShortcuts();
    var begin = function () {
      var p;
      try { p = Promise.resolve(M.review.start({ scope: s, collectionId: cid, now: Date.now() })); }
      catch (e) { p = Promise.reject(e); }
      return p.then(function (res) {
        var active = false;
        if (has("review", "isActive")) { try { active = M.review.isActive() === true; } catch (e) { active = false; } }
        if (active) setFocusOwner("review");
        return res;
      }, function (e) {
        report("review.start", e);
        api.toast({ text: e && e.message ? String(e.message) : "Could not start the review", id: "review-start" });
        return null;
      });
    };
    if (!handoverOn() || !has("store", "exclusive")) return begin();
    // D31: one review at a time among the windows of the app. This window holds "review" from the start of its
    // session to its end (a session that "Go to source" set aside too); another window is told why it cannot start.
    // A window that holds it already starts its next review as always: M.review replaces its own session. The end
    // of the replaced session (its review:ended comes during this start) does not end the hold; when no session
    // took its place (nothing was due), the hold ends here.
    if (state.reviewHeld) {
      state.reviewReplacing = true;
      var replaced = function () {
        state.reviewReplacing = false;
        if (!reviewOn() && typeof state.reviewDone === "function") state.reviewDone();
      };
      return begin().then(function (res) { replaced(); return res; }, function (e) { replaced(); throw e; });
    }
    return new Promise(function (started) {
      var mine = false;
      var held = M.store.exclusive("review", function (free) {
        if (!free) {
          api.toast({ text: "A review is open in another window", id: "review-start" });
          started(null);
          return null;
        }
        mine = true;
        state.reviewHeld = true;
        return begin().then(function (res) {
          started(res);
          return reviewOn() ? untilReviewEnds() : null;
        });
      });
      var over = function () { if (mine) state.reviewHeld = false; };
      Promise.resolve(held).then(over, function (e) { over(); report("review.exclusive", e); started(null); });
    });
  }

  function reviewOn() {
    try {
      if (has("review", "isActive") && M.review.isActive() === true) return true;
      return has("review", "isSuspended") && M.review.isSuspended() === true;
    } catch (e) { return false; }
  }
  function untilReviewEnds() {
    return new Promise(function (resolve) {
      var bus = tryDep("bus"), off = null;
      if (!bus || typeof bus.on !== "function") { resolve(); return; }
      // The hold ends with the session: at its review:ended. js/review.js sends that once, when the last card is done
      // (the end screen is then still up, and closing it sends nothing more) or when the review is left. Only the
      // end of a session that this window's next review replaces is not the end of the hold (startReview).
      var done = function () {
        if (typeof off === "function") off();
        if (state.reviewDone === done) state.reviewDone = null;
        resolve();
      };
      state.reviewDone = done;
      off = bus.on("review:ended", function () { if (!state.reviewReplacing) done(); });
    });
  }

  // ---- routing (BUILD-NOTES "Routing and review triggers") ---------------------

  function hashFor(screen, params) {
    params = params || {};
    var cid = params.collectionId == null ? "" : String(params.collectionId);
    if (screen === "deck" && cid) return "#deck/" + encodeURIComponent(cid);
    if (screen === "reader" && cid) return "#reader/" + encodeURIComponent(cid);
    if (screen === "stats") return "#stats";
    return "#library";
  }

  // "#reader/<collectionId>" | "#reader/<collectionId>/<promptId>" (the "Open in Marginalia" links of BUILD-NOTES
  // "Obsidian": the reader scrolls to the passage and focuses the card) | "#deck/<collectionId>" | "#stats" (the
  // statistics page, D27) | anything else: library
  function parseHash(hash) {
    var s = hash == null ? "" : String(hash);
    if (s.charAt(0) === "#") s = s.slice(1);
    if (s.charAt(0) === "/") s = s.slice(1);
    var parts = s.split("/").map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
    var screen = parts[0] || "library";
    if ((screen === "deck" || screen === "reader") && parts[1]) {
      var params = { collectionId: parts[1] };
      if (screen === "reader" && parts[2]) params.promptId = parts[2];
      return { screen: screen, params: params };
    }
    if (screen === "stats") return { screen: "stats", params: {} };
    return { screen: "library", params: {} };
  }

  function showScreen(name) {
    SCREENS.forEach(function (s) {
      var el = $(s);
      if (!el) return;
      if (s === name) el.classList.remove("is-hidden"); else el.classList.add("is-hidden");
    });
  }

  // Every history entry the app writes carries HISTORY_MARK. So a hashchange can tell Back and Forward (an entry of
  // the app's own) from a new address (a link from outside, an address the user typed): D30, onHashChange.
  var HISTORY_MARK = { marginalia: 1 };

  function writeHash(hash, replace) {
    if (typeof location === "undefined") return;
    var current = location.hash || "";
    var url = location.pathname + location.search + hash;
    try {
      if (typeof history !== "undefined" && history && typeof history.pushState === "function") {
        if (current === hash) { if (!marked()) history.replaceState(HISTORY_MARK, "", url); }   // the same address: only the mark
        else if (replace) history.replaceState(HISTORY_MARK, "", url);
        else history.pushState(HISTORY_MARK, "", url);
        state.hashFallback = false;
        return;
      }
    } catch (e) { /* sandboxed, or the browser's limit on history calls: fall back to the fragment setter */ }
    state.hashFallback = true;                            // until a history call works again
    if (current === hash) return;
    try { state.ignoreHash = hash; location.hash = hash; } catch (e2) { /* ignore */ }
  }

  // Is the history entry the page is on one of the app's own? Then a hashchange came from Back or Forward. Without
  // the history API the app cannot tell: every address change then moves the tab on screen, as before the tabs.
  function marked() {
    try { var s = typeof history !== "undefined" && history ? history.state : null; return !!s && s.marginalia === 1; }
    catch (e) { return false; }
  }
  function ownEntry() { return state.hashFallback ? true : marked(); }

  // An entry a new address made becomes the app's own, so Back and Forward to it later count as such.
  function markEntry() {
    if (typeof location === "undefined" || state.hashFallback) return;
    try {
      if (typeof history !== "undefined" && history && typeof history.replaceState === "function" && !ownEntry()) {
        history.replaceState(HISTORY_MARK, "", location.pathname + location.search + (location.hash || ""));
      }
    } catch (e) { /* sandboxed */ }
  }

  function onHashChange() {
    var hash = location.hash || "";
    if (state.ignoreHash && state.ignoreHash === hash) { state.ignoreHash = null; return; }
    state.ignoreHash = null;
    var own = ownEntry();                                 // Back or Forward, not a new address
    markEntry();
    var r = parseHash(hash);
    // a link to one prompt (#reader/<cid>/<pid>) navigates even when its book is open already
    if (!r.params.promptId && r.screen === state.screen && (r.params.collectionId || null) === (state.params.collectionId || null)) return;
    var link = { screen: r.screen, collectionId: r.params.collectionId, promptId: r.params.promptId, fromHistory: true };
    // D30: a new address (a link from outside) goes to a tab that shows that book already, else to a library tab,
    // else to a new tab. Back and Forward move the tab that is on screen, as before the tabs.
    if (!own && has("tabs", "link")) { try { if (M.tabs.link(link) === true) return; } catch (e) { report("tabs.link", e); } }
    api.route(link.screen, link);
  }

  function route(screen, params) {
    params = params || {};
    var s = SCREENS.indexOf(screen) >= 0 ? screen : "library";
    var cid = params.collectionId == null || params.collectionId === "" ? null : String(params.collectionId);
    if (s === "stats") {                                  // the statistics page has no collection and no prompt
      cid = null;
      params = { replace: params.replace, fromHistory: params.fromHistory };
    }
    else if (s !== "library" && !cid) s = "library";
    if (!hasDom() || state.lock || covered()) return Promise.resolve(false);   // covered: a page the desktop app replaced
    // The same screen is on its way already: one route answers for both. Not for a route that names a place inside
    // the book (one prompt, a page, a tab's own place: D30): the reader takes that place also while the book loads.
    var inside = s === "reader" && ((params.promptId != null && params.promptId !== "") || typeof params.pageIndex === "number" ||
      (!!params.position && typeof params.position === "object"));
    if (!inside && state.routing && state.routing.screen === s && state.routing.cid === cid) return state.routing.promise;

    // A missing collection goes home; a deck asked as "reader" opens its deck page (and a book vice versa).
    if (s !== "library" && s !== "stats" && has("cache", "collection")) {
      var c = null;
      try { c = M.cache.collection(cid); } catch (e) { c = null; }
      if (!c || c.deletedAt) {
        api.toast({ text: "That book or deck is no longer in the library", id: "route-missing" });
        s = "library"; cid = null;
      } else if (s === "reader" && c.kind === "deck") s = "deck";
      else if (s === "deck" && c.kind === "book") s = "reader";
    }

    closeShortcuts();
    var prevScreen = state.screen, prevCid = state.params.collectionId || null;
    var leavingReader = prevScreen === "reader" && (s !== "reader" || prevCid !== cid);
    state.screen = s;
    state.params = {
      collectionId: cid,
      promptId: params.promptId == null || params.promptId === "" ? null : String(params.promptId),
      pageIndex: typeof params.pageIndex === "number" ? params.pageIndex : null
    };
    var routing = { screen: s, cid: cid, promise: null };
    state.routing = routing;
    // D30: the active tab follows every navigation (M.tabs listens)
    emit("app:routed", { screen: s, collectionId: cid, promptId: state.params.promptId });
    var p;
    try {
      if (leavingReader && has("reader", "close")) {
        try { Promise.resolve(M.reader.close()).catch(noop); } catch (e) { report("reader.close", e); }
      }
      if (prevScreen === "stats" && s !== "stats" && has("stats", "close")) {
        try { M.stats.close(); } catch (e) { report("stats.close", e); }
      }
      showScreen(s);
      writeHash(hashFor(s, state.params), !!(params.replace || params.fromHistory || prevScreen === null));
      if (s === "library") {
        setFocusOwner("library");
        if (has("library", "render")) { try { M.library.render(); } catch (e) { report("library.render", e); } }
        blurHidden();
        p = Promise.resolve(true);
      } else if (s === "deck") {
        setFocusOwner("library");
        if (has("library", "openDeck")) { try { M.library.openDeck(cid); } catch (e) { report("library.openDeck", e); } }
        blurHidden();
        p = Promise.resolve(true);
      } else if (s === "stats") {
        setFocusOwner("library");
        if (has("stats", "open")) { try { M.stats.open(); } catch (e) { report("stats.open", e); } }
        blurHidden();
        p = Promise.resolve(true);
      } else {
        setFocusOwner("reader");
        var opts = {};
        if (state.params.promptId) opts.promptId = state.params.promptId;
        if (state.params.pageIndex != null) opts.pageIndex = state.params.pageIndex;
        if (params.position && typeof params.position === "object") opts.position = params.position;   // a tab's own place (D30)
        if (!has("reader", "open")) p = Promise.reject(err("no_reader", "M.reader is not loaded"));
        else { try { p = Promise.resolve(M.reader.open(cid, opts)); } catch (e) { p = Promise.reject(e); } }
        p = p.then(function () { return true; }, function (e) {
          report("reader.open", e);
          if (state.screen === "reader" && state.params.collectionId === cid) {
            // reader.js toasts engine errors itself; the codes below are thrown before it can
            if (!e || e.code === "not_found" || e.code === "not_book" || e.code === "no_reader" || e.code === "no_dom") {
              api.toast({ text: "Could not open that book", id: "route-open" });
            }
            api.route("library", { replace: true });
          }
          return false;
        });
      }
    } catch (e) {
      report("route", e);
      p = Promise.resolve(false);
    }
    routing.promise = p;
    var clear = function () { if (state.routing === routing) state.routing = null; };
    p.then(clear, clear);
    return p;
  }

  function current() { return { screen: state.screen, collectionId: state.params.collectionId || null, promptId: state.params.promptId || null }; }

  // ---- theme (SPEC §13) -------------------------------------------------------

  function applyTheme(v) {
    if (!hasDom() || !document.documentElement) return;
    var el = document.documentElement;
    try {
      if (v === "light" || v === "dark") el.setAttribute("data-theme", v);
      else el.removeAttribute("data-theme");
    } catch (e) { /* ignore */ }
  }

  function setTheme(v) {
    var t = (v === "light" || v === "dark") ? v : "system";
    applyTheme(t);
    var settings = tryDep("settings");
    try { if (settings && typeof settings.get === "function" && settings.get("theme") !== t) settings.set("theme", t); }
    catch (e) { report("settings.set(theme)", e); }
    return t;
  }

  function isArtifact() {
    if (!hasDom() || typeof document.querySelector !== "function") return false;
    try {
      var m = document.querySelector('meta[name="marginalia-build"]');
      return !!m && String(m.getAttribute("content") || "").trim().toLowerCase() === "artifact";
    } catch (e) { return false; }
  }

  // ---- toasts -----------------------------------------------------------------

  function findToast(id) {
    for (var i = 0; i < state.toasts.length; i++) if (state.toasts[i].id === id) return state.toasts[i];
    return null;
  }

  // toast({text, actions: [{label, run, keep?, primary?, title?}], ttl, id, detail?, node?, className?, onClose?}) → {close, el, id}
  function toast(opts) {
    if (typeof opts === "string") opts = { text: opts };
    opts = opts || {};
    var id = opts.id == null ? null : String(opts.id);
    var handle = { id: id, el: null, close: noop };
    var host = $("toasts");
    if (!host || state.lock) return handle;               // behind the "open in another tab" notice nothing is news
    var old = id ? findToast(id) : null;
    if (old) old.close(true);

    var rec = { id: id, el: null, timer: 0, ttl: 0, closed: false, close: null };
    var el = h("div", { "class": "toast" + (opts.className ? " " + String(opts.className) : ""), role: "status" });
    var body = h("div", { "class": "toast__body" });
    body.appendChild(h("div", { "class": "toast__text", text: opts.text == null ? "" : String(opts.text) }));
    if (opts.detail != null && opts.detail !== "") body.appendChild(h("div", { "class": "toast__detail", text: String(opts.detail) }));
    var nodes = opts.node ? (Array.isArray(opts.node) ? opts.node : [opts.node]) : [];
    nodes.forEach(function (n) { if (n && typeof n.nodeType === "number") body.appendChild(n); });
    el.appendChild(body);

    function remove() { if (el.parentNode) el.parentNode.removeChild(el); }
    function close(silent) {
      if (rec.closed) return;
      rec.closed = true;
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
      var i = state.toasts.indexOf(rec);
      if (i >= 0) state.toasts.splice(i, 1);
      if (silent) remove();
      else { el.classList.add("toast--out"); setTimeout(remove, TOAST_OUT_MS); }
      if (typeof opts.onClose === "function") { try { opts.onClose(); } catch (e) { report("toast onClose", e); } }
    }
    function arm() {
      if (!rec.ttl || rec.closed) return;
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = setTimeout(function () { close(false); }, rec.ttl);
    }

    var actions = Array.isArray(opts.actions) ? opts.actions : [];
    if (actions.length) {
      var wrap = h("div", { "class": "toast__actions" });
      actions.forEach(function (a) {
        if (!a || a.label == null) return;
        wrap.appendChild(button(a.label, "btn btn--ghost toast__action" + (a.primary ? " btn--primary" : ""), function () {
          var hadFocus = el.contains(document.activeElement);
          if (typeof a.run === "function") { try { a.run(handle); } catch (e) { report("toast action \"" + a.label + "\"", e); } }
          if (a.keep === true) return;
          close(false);
          if (hadFocus) refocusScreen();
        }, { noFocus: true, title: a.title }));
      });
      el.appendChild(wrap);
    }
    el.appendChild(button("×", "toast__close", function () {
      var hadFocus = el.contains(document.activeElement);
      close(false);
      if (hadFocus) refocusScreen();
    }, { noFocus: true, ariaLabel: "Dismiss" }));

    var ttl = opts.ttl == null ? TOAST_TTL : Number(opts.ttl);
    rec.ttl = ttl > 0 && isFinite(ttl) ? ttl : 0;        // 0 / Infinity: stays until closed
    el.addEventListener("mouseenter", function () { if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; } });
    el.addEventListener("mouseleave", arm);
    rec.el = el;
    rec.close = close;
    state.toasts.push(rec);
    host.appendChild(el);
    while (state.toasts.length > TOAST_MAX) state.toasts[0].close(true);
    arm();
    handle.el = el;
    handle.close = function () { close(false); };
    return handle;
  }

  // ---- confirm (SPEC §3: no window.confirm) -----------------------------------

  function confirm(opts) {
    opts = opts || {};
    if (state.lock) return Promise.resolve(opts.dismissValue !== undefined ? opts.dismissValue : false);   // nobody can answer it
    if (!$("confirm")) return Promise.resolve(false);
    return new Promise(function (resolve) {
      state.confirmQueue.push({ opts: opts, resolve: resolve });
      pumpConfirm();
    });
  }

  function pumpConfirm() {
    if (state.confirmOpen || !state.confirmQueue.length) return;
    var job = state.confirmQueue.shift();
    openConfirm(job.opts, job.resolve);
  }

  function openConfirm(opts, resolve) {
    var host = $("confirm");
    if (!host) { resolve(false); return; }
    var invoker = document.activeElement, closed = false;
    host.textContent = "";
    var dlg = h("div", {
      "class": "confirm" + (opts.danger ? " confirm--danger" : ""), role: "dialog", "aria-modal": "true",
      "aria-labelledby": "confirmTitle", tabindex: "-1"
    });
    dlg.appendChild(h("h2", { "class": "confirm__title", id: "confirmTitle", text: opts.title == null || opts.title === "" ? "Are you sure?" : String(opts.title) }));
    if (opts.body != null && opts.body !== "") {
      var body = h("div", { "class": "confirm__body", id: "confirmBody" });
      String(opts.body).split("\n").forEach(function (line, i) {
        if (i) body.appendChild(h("br"));
        body.appendChild(document.createTextNode(line));
      });
      dlg.setAttribute("aria-describedby", "confirmBody");
      dlg.appendChild(body);
    }
    var cancelBtn = button(opts.cancel == null || opts.cancel === "" ? "Cancel" : opts.cancel, "btn confirm__cancel", function () { done(false); });
    var okBtn = button(opts.ok == null || opts.ok === "" ? "OK" : opts.ok, "btn confirm__ok " + (opts.danger ? "btn--danger" : "btn--primary"), function () { done(true); });
    dlg.appendChild(h("div", { "class": "confirm__actions" }, [cancelBtn, okBtn]));
    host.appendChild(dlg);
    host.classList.remove("is-hidden");
    var onBackdrop = function (ev) { if (ev.target === host) done(false, true); };
    host.addEventListener("click", onBackdrop);

    // dismissed (Esc, backdrop, a programmatic cancel) resolves opts.dismissValue when the caller gave one, so a
    // caller whose Cancel button is itself an action can tell "closed without choosing" apart from it
    function done(v, dismissed) {
      if (closed) return;
      closed = true;
      state.confirmOpen = null;
      host.removeEventListener("click", onBackdrop);
      host.classList.add("is-hidden");
      host.textContent = "";
      restoreFocus(invoker);
      var out = dismissed && opts.dismissValue !== undefined ? opts.dismissValue : !!v;
      try { resolve(out); } catch (e) { report("confirm resolve", e); }
      pumpConfirm();
    }
    state.confirmOpen = { host: host, dlg: dlg, okBtn: okBtn, cancelBtn: cancelBtn, invoker: invoker, done: done };
    if (!focusEl(okBtn)) focusEl(dlg);
  }

  function cancelConfirm() {
    if (!state.confirmOpen) return false;
    state.confirmOpen.done(false, true);
    return true;
  }

  // ---- shortcut sheet (the ? sheet) -------------------------------------------

  function bindingOf(map, id) {
    var e = map ? map[id] : null;
    if (e == null) return null;
    if (typeof e === "string" || Array.isArray(e)) return e;
    return e.binding == null ? null : e.binding;
  }

  function caps(k, binding) {
    var wrap = h("span", { "class": "sc-keys" }), any = false;
    (Array.isArray(binding) ? binding : [binding]).forEach(function (b) {
      if (typeof b !== "string" || !b) return;
      var text = "";
      try { text = k.label(b); } catch (e) { text = b; }
      if (!text) return;
      any = true;
      wrap.appendChild(h("kbd", { "class": "kbd", text: text }));
    });
    if (!any) wrap.appendChild(h("span", { "class": "sc-unbound", text: "unbound" }));
    return wrap;
  }

  function row(k, label, binding) {
    return h("div", { "class": "sc-row" }, [h("span", { "class": "sc-label", text: label }), caps(k, binding)]);
  }

  function section(title, rows) {
    return h("section", { "class": "sheet__section" }, [h("h3", { "class": "sheet__h", text: title }), h("div", { "class": "sheet__grid" }, rows)]);
  }

  // DECISIONS D32: Settings › Obsidian › "Connect Marginalia to Obsidian" (M.obsidian.enabled()). While it is off,
  // the shortcut sheet has no row for O. An M.obsidian without that switch counts as on.
  function obsidianOn() {
    var O = M.obsidian;
    if (!O) return false;
    if (typeof O.enabled !== "function") return true;
    try { return O.enabled() === true; } catch (e) { return false; }
  }
  function readerRows(k) {
    var R = k.READER_MAP || {}, rows = [];
    READER_ORDER.forEach(function (id) {
      if (id === "obsidianNote" && !obsidianOn()) return;      // D32: no row for a key that does nothing
      if (R[id]) rows.push(row(k, LABELS[id] || id, bindingOf(R, id)));
    });
    Object.keys(R).forEach(function (id) { if (READER_ORDER.indexOf(id) < 0) rows.push(row(k, LABELS[id] || id, bindingOf(R, id))); });
    rows.push(row(k, "Paste: an image becomes an attachment, text a free note", "Mod+v"));
    return rows;
  }

  function editorRows(k) {
    var E = k.EDITOR_MAP || {}, rows = [];
    EDITOR_ORDER.forEach(function (id) { if (E[id]) rows.push(row(k, LABELS[id] || id, bindingOf(E, id))); });
    Object.keys(E).forEach(function (id) { if (EDITOR_ORDER.indexOf(id) < 0) rows.push(row(k, LABELS[id] || id, bindingOf(E, id))); });
    rows.push(row(k, "Insert the A. line, or jump to it", "Tab"));
    rows.push(row(k, "Back to the Q. line", "Shift+Tab"));
    return rows;
  }

  function reviewRows(k) {
    var map = reviewMap(), rows = [];
    var order = (k.REVIEW_ACTIONS || Object.keys(REVIEW_CALLS)).slice();
    order.push("shortcuts");
    order.forEach(function (id) { if (map[id]) rows.push(row(k, REVIEW_LABELS[id] || LABELS[id] || id, bindingOf(map, id))); });
    return rows;
  }

  // D30: the tab commands (M.keys.TABS_MAP). Cmd+1 … Cmd+8 are one row; "Mod+}" and "Mod+{" are shown as the keys
  // that the user presses (Shift with ] or [); the last row is a click, not a key.
  function tabCaps(k, texts) {
    return h("span", { "class": "sc-keys" }, texts.map(function (text) { return h("kbd", { "class": "kbd", text: text }); }));
  }
  function tabRows(k) {
    var T = k.TABS_MAP || {}, rows = [], mac = false;
    try { mac = typeof k.isMac === "function" && k.isMac() === true; } catch (e) { mac = false; }
    var label = function (b) { try { return k.label(b); } catch (e) { return b; } };
    var shown = function (b) {
      if (b === "Mod+}") return mac ? "⇧⌘]" : "Ctrl+Shift+]";
      if (b === "Mod+{") return mac ? "⇧⌘[" : "Ctrl+Shift+[";
      return label(b);
    };
    [["newTab", "New tab"], ["closeTab", "Close tab"], ["reopenTab", "Reopen the last closed tab"], ["nextTab", "Next tab"], ["prevTab", "Previous tab"]].forEach(function (x) {
      var b = bindingOf(T, x[0]);
      if (b == null) return;
      rows.push(h("div", { "class": "sc-row" }, [h("span", { "class": "sc-label", text: x[1] }), tabCaps(k, (Array.isArray(b) ? b : [b]).map(shown))]));
    });
    if (T.tab1 && T.tab8) rows.push(h("div", { "class": "sc-row" }, [h("span", { "class": "sc-label", text: "Tab 1 to 8" }), tabCaps(k, [label(bindingOf(T, "tab1")) + " … " + label(bindingOf(T, "tab8"))])]));
    if (T.lastTab) rows.push(row(k, "Last tab", bindingOf(T, "lastTab")));
    rows.push(h("div", { "class": "sc-row" }, [
      h("span", { "class": "sc-label", text: "Open a book, a deck, Statistics or a prompt in a new tab" }),
      tabCaps(k, [(mac ? "⌘" : "Ctrl") + " click"])
    ]));
    return rows;
  }

  // D33: the two keys of M.keys.UNDO_MAP.
  function undoRows(k) {
    var U = k.UNDO_MAP || {}, rows = [];
    if (U.undo) rows.push(row(k, "Undo the last change to a card", bindingOf(U, "undo")));
    if (U.redo) rows.push(row(k, "Redo", bindingOf(U, "redo")));
    return rows;
  }

  function libraryRows(k) {
    var R = k.READER_MAP || {}, rows = [];
    LIBRARY_ORDER.forEach(function (id) { if (R[id]) rows.push(row(k, LIBRARY_LABELS[id] || LABELS[id] || id, bindingOf(R, id))); });
    return rows;
  }

  function openShortcuts() {
    var host = $("shortcuts");
    if (!host) return false;
    if (state.sheet) { focusEl(state.sheet.panel); return true; }
    var k = keys();
    if (!k || typeof k.label !== "function") return false;
    var invoker = document.activeElement;
    host.textContent = "";
    var panel = h("div", { "class": "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "shortcutsTitle", tabindex: "-1" });
    var closeBtn = button("×", "btn btn--ghost sheet__close", function () { closeShortcuts(); }, { ariaLabel: "Close" });
    panel.appendChild(h("div", { "class": "sheet__head" }, [
      h("div", null, [
        h("h2", { "class": "sheet__title", id: "shortcutsTitle", text: "Keyboard shortcuts" }),
        h("div", { "class": "sheet__hint", text: "Esc closes · review keys can be changed in Settings › Review shortcuts" })
      ]),
      closeBtn
    ]));
    try {
      panel.appendChild(section("Reader", readerRows(k)));
      panel.appendChild(section("Editor", editorRows(k)));
      panel.appendChild(section("Review", reviewRows(k)));
      panel.appendChild(section("Library", libraryRows(k)));
      if (k.TABS_MAP) panel.appendChild(section("Tabs", tabRows(k)));
      if (k.UNDO_MAP) panel.appendChild(section("Undo and redo", undoRows(k)));
    } catch (e) { report("shortcut sheet", e); }
    host.appendChild(panel);
    host.classList.remove("is-hidden");
    var onBackdrop = function (ev) { if (ev.target === host) closeShortcuts(); };
    host.addEventListener("click", onBackdrop);
    state.sheet = { host: host, panel: panel, invoker: invoker, onBackdrop: onBackdrop };
    focusEl(panel);
    return true;
  }

  function closeShortcuts() {
    var s = state.sheet;
    if (!s) return false;
    state.sheet = null;
    s.host.removeEventListener("click", s.onBackdrop);
    s.host.classList.add("is-hidden");
    s.host.textContent = "";
    restoreFocus(s.invoker);
    return true;
  }

  // ---- banners (#banner) ------------------------------------------------------

  function findBanner(id) {
    for (var i = 0; i < state.banners.length; i++) if (state.banners[i].id === id) return state.banners[i];
    return null;
  }

  // showBanner({id, text, actions: [{label, run, primary?}], dismissible?, className?}) → {close, id}
  function showBanner(opts) {
    opts = opts || {};
    var id = opts.id == null ? null : String(opts.id);
    var handle = { id: id, close: noop };
    var host = $("banner");
    if (!host) return handle;
    if (id) hideBanner(id);
    var item = h("div", { "class": "banner__item" + (opts.className ? " " + String(opts.className) : ""), role: "status", "data-id": id });
    item.appendChild(h("div", { "class": "banner__text", text: opts.text == null ? "" : String(opts.text) }));
    var wrap = h("div", { "class": "banner__actions" });
    (Array.isArray(opts.actions) ? opts.actions : []).forEach(function (a) {
      if (!a || a.label == null) return;
      wrap.appendChild(button(a.label, "btn banner__action" + (a.primary ? " btn--primary" : ""), function () {
        if (typeof a.run === "function") { try { a.run(handle); } catch (e) { report("banner action \"" + a.label + "\"", e); } }
      }));
    });
    var rec = { id: id, el: item, close: close };
    function close() {
      var i = state.banners.indexOf(rec);
      if (i >= 0) state.banners.splice(i, 1);
      if (item.parentNode) item.parentNode.removeChild(item);
      if (!state.banners.length) host.classList.add("is-hidden");
    }
    if (opts.dismissible) wrap.appendChild(button("×", "btn btn--ghost banner__close", close, { ariaLabel: "Dismiss" }));
    if (wrap.childNodes.length) item.appendChild(wrap);
    state.banners.push(rec);
    host.appendChild(item);
    host.classList.remove("is-hidden");
    handle.close = close;
    return handle;
  }

  function hideBanner(id) {
    var found = false;
    state.banners.slice().forEach(function (b) { if (b.id === id) { b.close(); found = true; } });
    return found;
  }

  function onStoreMode(e) {
    e = e || {};
    if (e.reason === "othertab") { showTabLock(e); return; }
    if (e.mode === "memory") {
      if (findBanner("store-memory")) return;
      var actions = [];
      if (has("exporter", "openDialog")) {
        actions.push({ label: "Export…", run: function () { try { M.exporter.openDialog({ scope: "all" }); } catch (e2) { report("exporter.openDialog", e2); } } });
      }
      showBanner({ id: "store-memory", text: e.message || MSG_UNAVAILABLE, actions: actions, className: "banner__item--warn" });
      return;
    }
    if (e.reason === "versionchange") {
      showBanner({
        id: "store-version", text: e.message || MSG_VERSIONCHANGE, className: "banner__item--warn",
        actions: [{ label: "Reload", primary: true, run: function () { try { location.reload(); } catch (e2) { report("reload", e2); } } }]
      });
      return;
    }
    if (e.reason === "blocked") { showBanner({ id: "store-blocked", text: e.message || MSG_BLOCKED, dismissible: true }); return; }
    if (e.mode === "idb") hideBanner("store-blocked");
  }

  // ---- one writing tab per origin: the "open in another tab" notice (#tabLock) ---------------------------

  // A newer tab took over for good (the legacy rule). A window of the Mac app that is only a reader for now
  // ({reason: "window"}, D31) is not that: it shows its page and takes the role when it is used.
  function storeLocked() {
    if (!has("store", "locked")) return false;
    try { var l = M.store.locked(); return !!l && l.reason !== "window"; } catch (e) { return false; }
  }

  // ---- D31: the windows of the Mac app and the writer role (BUILD-NOTES "Windows") ------------------------

  var ROLE_WAIT_MS = 1500;       // boot waits this long for the role, then goes on as a reader (the role comes later)
  var ROLE_SLOW_MS = 600;        // the role did not come in this time (another window is at work that keeps it): a notice
  var ROLE_EVENTS = ["keydown", "keypress", "pointerdown", "mousedown", "click", "dblclick", "contextmenu", "paste", "cut", "drop"];

  function handoverOn() {
    if (!has("store", "handover")) return false;
    try { return M.store.handover() === true; } catch (e) { return false; }
  }
  function isWriter() {
    if (!has("store", "writer")) return true;
    try { return M.store.writer() === true; } catch (e) { return true; }
  }

  // Another window wrote since this one last read: the library and the settings as they are stored now. The views
  // follow through the bus events of M.cache.reload and M.settings.reload.
  function readAgain() {
    var jobs = [];
    if (has("settings", "reload")) { try { M.settings.reload(); } catch (e) { report("settings.reload", e); } }
    if (!has("cache", "reload")) return Promise.all(jobs);
    var loaded = false;
    try { loaded = has("cache", "loaded") && M.cache.loaded() === true; } catch (e2) { loaded = false; }
    if (loaded) jobs.push(M.cache.reload());
    // The first read is still under way (this window started while another window kept the role, and went on as a
    // reader): what it reads may be older than that window's last write. It ends first, then the library is read
    // once more. Before the first read has begun there is nothing to read again: boot reads as the writer.
    else if (state.cacheLoad) jobs.push(state.cacheLoad.then(function () { return M.cache.reload(); }));
    return Promise.all(jobs);
  }

  // The library could not be read again (M.store.acquire rejected: the store did not answer): this window stays a
  // reader, and says so. From then on its keys and clicks go through (the user can read and copy; a save is
  // refused), and each of them tries again.
  function roleFailed() {
    state.roleBroken = true;
    api.toast({ text: "This window could not read the library again. Close the window, or choose View › Reload.", id: "role-failed", ttl: 0 });
  }
  function roleWorks() {
    if (!state.roleBroken) return;
    state.roleBroken = false;
    var notice = findToast("role-failed");
    if (notice) notice.close(true);
  }

  // Makes this window the writer (it reads the library again first when another window held the role).
  // → Promise<boolean>. Outside handover mode there is nothing to take: true.
  // The role has not come for a while: the other window keeps it while it adds a PDF or imports a backup. This window
  // says that it waits (what the user does here is not acted on until then). Never during boot's own wait.
  function roleNotice() {
    if (!state.taking || !state.roleNotice || Date.now() - state.takingAt < ROLE_SLOW_MS || findToast("role-wait")) return;
    api.toast({ text: "Waiting for another Marginalia window to finish its work…", id: "role-wait", ttl: 0 });
  }
  function takeRole() {
    if (!handoverOn() || !has("store", "acquire")) return Promise.resolve(true);
    if (isWriter()) return Promise.resolve(true);
    if (state.taking) { roleNotice(); return state.taking; }
    var p;
    try { p = Promise.resolve(M.store.acquire(function (changed) { return changed ? readAgain() : null; })); }
    catch (e) { p = Promise.reject(e); }
    p = p.then(function (ok) {
      roleWorks();                                          // the store answered (also when a later ask ended this one)
      return ok === true;
    }, function (e) { report("store.acquire", e); roleFailed(); return false; });
    state.taking = p;
    state.takingAt = Date.now();
    var slow = setTimeout(function () { if (state.taking === p) roleNotice(); }, ROLE_SLOW_MS + 20);
    var clear = function () {
      clearTimeout(slow);
      if (state.taking === p) state.taking = null;
      var waiting = findToast("role-wait");
      if (waiting) waiting.close(true);
    };
    p.then(clear, clear);
    return p;
  }

  // The window is used (it got the focus, or a key or a click came): it takes the role. Until the role is here, what
  // the user does in a reader is not acted on: this page's copy of the library may be old.
  function onWindowUsed() { if (handoverOn() && !isWriter()) takeRole(); }
  // Two drops come from outside the window, which then is often not the writer (a drag gives no focus), and the page
  // handles both as a reader: a tab of another window (the list of tabs is this window's own, js/tabs.js), and a PDF
  // file on the library (M.library.addPdf takes the role itself before it compares and stores).
  function dropForReader(ev) {
    if (!ev || ev.type !== "drop" || !ev.dataTransfer) return false;
    var types = [];
    try { types = Array.prototype.slice.call(ev.dataTransfer.types || []); } catch (e) { types = []; }
    var tab = M.tabs && typeof M.tabs.TAB_TYPE === "string" ? M.tabs.TAB_TYPE : null;
    if (tab && types.indexOf(tab) >= 0) return true;
    if (types.indexOf("Files") < 0) return false;
    var lib = $("library");
    try { return !!(lib && ev.target && typeof lib.contains === "function" && lib.contains(ev.target)); } catch (e2) { return false; }
  }
  function guardReader(ev) {
    if (!handoverOn() || isWriter() || state.lock) return;
    takeRole();
    if (state.roleBroken || dropForReader(ev)) return;
    try { ev.preventDefault(); } catch (e) { /* synthetic event */ }
    try { ev.stopImmediatePropagation(); } catch (e2) { try { ev.stopPropagation(); } catch (e3) { /* synthetic event */ } }
  }
  function bindRole() {
    if (state.roleBound || typeof window === "undefined" || !window || typeof window.addEventListener !== "function") return;
    state.roleBound = true;
    window.addEventListener("focus", onWindowUsed);
    ROLE_EVENTS.forEach(function (type) { window.addEventListener(type, guardReader, true); });
  }

  // Is another window of the Mac app there (each one holds the Web Lock "marginalia.window.<id>" for its life, see
  // boot)? → Promise<boolean>. false outside handover mode (a browser page: one writing tab per origin). In handover
  // mode an answer that does not come (the locks cannot be asked) counts as true: the window does not know that it
  // is alone.
  function otherWindows() {
    if (!handoverOn()) return Promise.resolve(false);
    if (!has("store", "held")) return Promise.resolve(true);
    var mine = "window." + ((has("tabs", "windowId") ? M.tabs.windowId() : null) || "");
    try {
      return Promise.resolve(M.store.held()).then(function (names) {
        return !Array.isArray(names) || names.some(function (n) { return String(n).indexOf("window.") === 0 && String(n) !== mine; });
      }, function () { return true; });
    } catch (e) { return Promise.resolve(true); }
  }

  // This window closes for good (the Mac app asks, then closes it): its list of tabs goes at once, so its tabs do
  // not come back at the next start. A place in its book that it could not store (it was not the writer when the
  // book was scrolled: M.reader.unsaved()) is stored first: the window takes the role for that.
  // → Promise<boolean> (the list is gone).
  function leave() {
    var forgot = false, held = false;
    try { forgot = has("tabs", "forget") && M.tabs.forget() === true; } catch (e) { report("tabs.forget", e); }
    try { held = has("reader", "unsaved") && M.reader.unsaved() === true; } catch (e2) { held = false; }
    if (!held || !handoverOn()) return Promise.resolve(forgot);
    return takeRole().then(function () {                    // store:writer → the reader stores its place
      return has("store", "idle") ? M.store.idle() : null;
    }).then(function () { return forgot; }, function (e) { report("leave", e); return forgot; });
  }

  function escapeText(s) {
    var u = tryDep("util");
    if (u && typeof u.escapeHtml === "function") return u.escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
    });
  }

  // The text an open editor holds that is not stored: a new card's text (not the bare "Q. " of Save and another),
  // the deck add-box's, or an edit that differs from the prompt as this tab last saved it.
  function editorText(ed) {
    if (!ed || typeof ed.getText !== "function") return "";
    try { if (typeof ed.isDestroyed === "function" && ed.isDestroyed()) return ""; } catch (e) { return ""; }
    var text = "";
    try { text = String(ed.getText() || ""); } catch (e) { return ""; }
    var t = text.trim();
    if (!t || t === "Q.") return "";
    var p = !ed.batch && ed.prompt && typeof ed.prompt === "object" ? ed.prompt : null;
    if (p) {
      var saved = typeof p.text === "string" ? p.text : "";
      if (p.id && has("cache", "prompt")) {
        try { var cur = M.cache.prompt(p.id); if (cur && typeof cur.text === "string") saved = cur.text; } catch (e) { /* keep p.text */ }
      }
      if (text === saved) return "";
    }
    return text;
  }

  function unsavedTexts() {
    var eds = [], out = [];
    if (has("margin", "activeEditor")) { try { eds.push(M.margin.activeEditor()); } catch (e) { report("margin.activeEditor", e); } }
    if (has("library", "activeEditor")) { try { eds.push(M.library.activeEditor()); } catch (e) { report("library.activeEditor", e); } }
    eds.forEach(function (ed, i) {
      if (!ed || eds.indexOf(ed) !== i) return;
      var t = editorText(ed);
      if (t && out.indexOf(t) < 0) out.push(t);
    });
    return out;
  }

  function focusLock(lock) {
    if (!lock) return false;
    return focusEl(lock.texts.length ? lock.copyBtn : lock.useBtn) || focusEl(lock.panel);
  }

  function lockStatus(lock, msg) { if (lock && lock.status) lock.status.textContent = msg == null ? "" : String(msg); }

  // The not-saved block: the texts in one read-only textarea, user text only through escapeHtml (the newline after
  // the start tag is the one the HTML parser drops, so a text that starts with a newline keeps it).
  function renderLockTexts(lock) {
    var any = lock.texts.length > 0;
    var hadFocus = false;
    try { hadFocus = lock.textWrap.contains(document.activeElement); } catch (e) { hadFocus = false; }
    lock.textWrap.innerHTML = any
      ? '<textarea class="tablock__text" readonly rows="6" spellcheck="false" aria-labelledby="tabLockTextLabel">\n' +
        escapeText(lock.texts.join("\n\n")) + "</textarea>"
      : "";
    if (any) { lock.unsaved.classList.remove("is-hidden"); lock.copyBtn.classList.remove("is-hidden"); }
    else { lock.unsaved.classList.add("is-hidden"); lock.copyBtn.classList.add("is-hidden"); }
    if (hadFocus) {
      var ta = null;
      try { ta = lock.textWrap.querySelector("textarea"); } catch (e) { ta = null; }
      if (!focusEl(ta)) focusEl(lock.copyBtn);
    }
  }

  function addLockTexts(list) {
    var lock = state.lock;
    if (!lock) return false;
    var added = false;
    (Array.isArray(list) ? list : [list]).forEach(function (t) {
      var s = t == null ? "" : String(t);
      if (!s.trim() || lock.texts.indexOf(s) >= 0) return;
      lock.texts.push(s);
      added = true;
    });
    if (added) renderLockTexts(lock);
    return added;
  }

  function copyHint() {
    var k = keys(), cap = "Cmd+C";
    try { if (k && typeof k.label === "function") cap = k.label("Mod+c") || cap; } catch (e) { /* keep the default */ }
    return "Could not copy here — select the text and press " + cap;
  }

  // select + execCommand("copy"): the fallback when the async clipboard is missing or refuses (inside the click)
  function selectCopy(lock) {
    var ta = null;
    try { ta = lock.textWrap.querySelector("textarea"); } catch (e) { ta = null; }
    if (!ta) return false;
    try { ta.focus(); ta.select(); } catch (e) { return false; }
    try { return document.execCommand("copy") === true; } catch (e) { return false; }
  }

  function copyLockText() {
    var lock = state.lock;
    if (!lock || !lock.texts.length) return;
    var text = lock.texts.join("\n\n");
    var done = function (ok) { lockStatus(lock, ok ? "Copied" : copyHint()); };
    var clip = null;
    try { clip = typeof navigator !== "undefined" && navigator ? navigator.clipboard : null; } catch (e) { clip = null; }
    if (clip && typeof clip.writeText === "function") {
      var p = null;
      try { p = clip.writeText(text); } catch (e) { p = null; }
      if (p && typeof p.then === "function") { p.then(function () { done(true); }, function () { done(selectCopy(lock)); }); return; }
    }
    done(selectCopy(lock));
  }

  function useThisTab() {
    try {
      if (typeof state.reload === "function") state.reload();
      else if (typeof location !== "undefined" && location && typeof location.reload === "function") location.reload();
    } catch (e) { report("reload", e); }
  }

  // Keys while this tab stands aside: Tab cycles inside the notice; Escape, and every plain key aimed elsewhere,
  // is swallowed (a key aimed elsewhere also brings focus back); Enter / Space on its buttons and copying from its
  // read-only text keep their native behaviour, and so do browser shortcuts (Cmd / Ctrl). Returns true when it
  // prevented the default.
  function lockKey(ev) {
    var lock = state.lock;
    if (!lock || !ev) return false;
    var inside = false;
    try { inside = !!ev.target && ev.target !== document && lock.host.contains(ev.target); } catch (e) { inside = false; }
    if (ev.key === "Tab") { trapTab(ev, lock.panel); return true; }
    var swallow = ev.key === "Escape" || (!inside && !ev.metaKey && !ev.ctrlKey);
    if (swallow) { try { ev.preventDefault(); } catch (e) { /* synthetic event */ } }
    if (!inside) focusLock(lock);
    return swallow;
  }

  function showTabLock(info) {
    if (state.lock) return true;
    if (!hasDom()) return false;
    var texts = unsavedTexts();                           // before anything closes an editor
    closeShortcuts();
    while (state.confirmQueue.length) {                   // nobody can answer them any more: dismissed
      var job = state.confirmQueue.shift();
      try { job.resolve(job.opts && job.opts.dismissValue !== undefined ? job.opts.dismissValue : false); } catch (e) { report("confirm resolve", e); }
    }
    cancelConfirm();
    var appEl = $("app") || document.body;
    var host = h("div", { id: "tabLock", "class": "tablock" });
    var panel = h("div", {
      "class": "tablock__panel", role: "alertdialog", "aria-modal": "true",
      "aria-labelledby": "tabLockTitle", "aria-describedby": "tabLockBody", tabindex: "-1"
    });
    panel.appendChild(h("h2", { "class": "tablock__title", id: "tabLockTitle", text: MSG_OTHER_TAB }));
    panel.appendChild(h("p", { "class": "tablock__body", id: "tabLockBody", text: TAB_LOCK_BODY }));
    var textWrap = h("div", { "class": "tablock__textwrap" });
    var unsaved = h("div", { "class": "tablock__unsaved is-hidden" }, [
      h("p", { "class": "tablock__label", id: "tabLockTextLabel", text: TAB_LOCK_TEXT }), textWrap
    ]);
    panel.appendChild(unsaved);
    var copyBtn = button("Copy text", "btn tablock__copy is-hidden", function () { copyLockText(); });
    var useBtn = button("Use this tab", "btn btn--primary tablock__use", function () { useThisTab(); });
    panel.appendChild(h("div", { "class": "tablock__actions" }, [copyBtn, useBtn]));
    var status = h("div", { "class": "tablock__status", role: "status", "aria-live": "polite" });
    panel.appendChild(status);
    host.appendChild(panel);
    var lock = {
      host: host, panel: panel, unsaved: unsaved, textWrap: textWrap, copyBtn: copyBtn, useBtn: useBtn, status: status,
      texts: [], by: info && info.by != null ? String(info.by) : null
    };
    var stop = function (ev) {
      try { ev.preventDefault(); } catch (e) { /* synthetic event */ }
      try { ev.stopPropagation(); } catch (e2) { /* synthetic event */ }
    };
    lock.onKey = function (ev) { lockKey(ev); try { ev.stopPropagation(); } catch (e) { /* synthetic event */ } };
    lock.onBlock = stop;
    lock.onFocus = function (ev) {
      var t = ev && ev.target;
      if (!t || t === document || (typeof window !== "undefined" && t === window)) return;
      if (!host.contains(t)) focusLock(lock);
    };
    state.lock = lock;
    appEl.appendChild(host);
    Array.prototype.slice.call(appEl.children || []).forEach(function (el) {
      if (el === host || !el || typeof el.setAttribute !== "function") return;
      try { el.setAttribute("inert", ""); } catch (e) { /* the overlay and the key guard still hold */ }
    });
    try {
      if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") {
        window.addEventListener("keydown", lock.onKey, true);
        ["paste", "drop", "dragover"].forEach(function (t) { window.addEventListener(t, lock.onBlock, true); });
      }
      document.addEventListener("focusin", lock.onFocus, true);
    } catch (e) { report("tab lock guards", e); }
    if (texts.length) addLockTexts(texts);
    focusLock(lock);
    return true;
  }

  // ---- global errors ----------------------------------------------------------

  // One toast per burst of uncaught errors / unhandled rejections (the console keeps the details).
  function handleError(message) {
    var msg = message == null ? "" : String(message);
    if (/ResizeObserver loop/i.test(msg)) return false;
    var now = Date.now();
    if (now - state.lastErrorAt < ERROR_GAP_MS) return false;
    state.lastErrorAt = now;
    api.toast({ text: ERROR_TEXT, id: "app-error", ttl: 8000 });
    return true;
  }

  function onWindowError(ev) {
    try {
      var reason = ev ? (ev.error != null ? ev.error : ev.reason) : null;
      if (ev && ev.type === "error" && !ev.message && reason == null) return;             // resource errors: nothing to show
      if (reason && (reason.name === "AbortError" || reason.code === "superseded")) return; // deliberate cancellations
      var msg = ev && ev.message ? ev.message : (reason && reason.message ? reason.message : (reason == null ? "" : String(reason)));
      handleError(msg);
    } catch (e) { /* never throw from the error handler */ }
  }

  // ---- events (SPEC §17.3) ----------------------------------------------------

  function onGotoSource(e) {
    var pid = e && e.promptId != null ? String(e.promptId) : "";
    if (!pid) return;
    var p = null, c = null;
    if (has("cache", "prompt")) { try { p = M.cache.prompt(pid); } catch (e2) { p = null; } }
    if (!p) { api.toast({ text: "That prompt is no longer here", id: "goto-source" }); return; }
    if (has("cache", "collection")) { try { c = M.cache.collection(p.collectionId); } catch (e3) { c = null; } }
    if (!c || c.deletedAt) { api.toast({ text: "Its book is no longer in the library", id: "goto-source" }); return; }
    if (c.kind !== "book") { api.toast({ text: "Deck prompts have no source passage", id: "goto-source" }); return; }
    if (c.hasBytes === false) { api.toast({ text: "PDF not in library — add the file again to open it", id: "goto-source" }); return; }
    api.route("reader", { collectionId: c.id, promptId: pid });
  }

  function bindBus() {
    if (state.busBound) return;
    var bus = tryDep("bus");
    if (!bus || typeof bus.on !== "function") return;
    state.busBound = true;
    bus.on("settings:changed", function (e) { if (e && e.key === "theme") applyTheme(e.value); });
    bus.on("store:mode", onStoreMode);
    bus.on("prompt:refused", function (e) {              // a save the lock refused: its text goes into the notice
      var text = e && e.prompt && typeof e.prompt.text === "string" ? e.prompt.text : "";
      if (!text.trim()) return;
      if (handoverOn()) {
        // D31: a save that came while another window had the role. The editor keeps the text (js/margin.js opens it
        // again), and the notice stays until the user is back at this window: a click or a key here takes the role,
        // and the user saves once more. This window does not take the role by itself: the other window is the one
        // in use, and its next key would be lost.
        api.toast({ text: "Not saved: another Marginalia window was in use. Save again.", id: "role-refused", ttl: 0 });
        return;
      }
      if (!state.lock && storeLocked()) showTabLock(null);
      addLockTexts([text]);
    });
    bus.on("review:gotoSource", onGotoSource);
    bus.on("review:resumed", function () { setFocusOwner("review"); });
    bus.on("review:ended", function () {
      if (state.owner !== "review") return;
      setFocusOwner(screenOwner());
      refocusScreen();
    });
    bus.on("editor:opened", function () { setFocusOwner("editor"); });
    bus.on("editor:closed", function () {
      if (state.owner !== "editor") return;
      setTimeout(function () {                            // margin / reader move focus first; this is the fallback
        if (state.owner === "editor" && !activeEditor()) { setFocusOwner(screenOwner()); refocusScreen(); }
      }, 0);
    });
    bus.on("doc:opened", function (e) { state.openDoc = e && e.collectionId != null ? String(e.collectionId) : null; });
    bus.on("doc:closed", function (e) {
      if (!e || e.collectionId == null || state.openDoc === String(e.collectionId)) state.openDoc = null;
    });
    bus.on("collection:deleted", function (e) {
      var id = e && e.collectionId != null ? String(e.collectionId) : null;
      if (id && state.screen !== "library" && state.params.collectionId === id) api.route("library", {});
    });
  }

  function bindDom() {
    if (state.bound || !hasDom()) return;
    state.bound = true;
    document.addEventListener("keydown", handleKeydown);
    if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") {
      window.addEventListener("hashchange", onHashChange);
      window.addEventListener("error", onWindowError);
      window.addEventListener("unhandledrejection", onWindowError);
    }
    var toasts = $("toasts");
    if (toasts) { toasts.setAttribute("aria-live", "polite"); toasts.setAttribute("aria-relevant", "additions"); }
  }

  // ?pdf=<url> (BUILD-NOTES): same-origin or relative only, handled once, then stripped from the URL.
  function handlePdfParam() {
    if (typeof location === "undefined" || typeof URLSearchParams !== "function") return;
    var url = null;
    try { url = new URLSearchParams(location.search).get("pdf"); } catch (e) { url = null; }
    if (!url) return;
    try {
      var u = new URL(location.href);
      u.searchParams.delete("pdf");
      if (typeof history !== "undefined" && history && typeof history.replaceState === "function") history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (e) { /* the param stays; addPdf de-duplicates by fingerprint */ }
    var abs = null;
    try { abs = new URL(url, location.href); } catch (e) { abs = null; }
    if (!abs || abs.origin !== location.origin || abs.protocol !== location.protocol) {
      api.toast({ text: "?pdf= must be a same-origin URL", id: "pdf-param" });
      return;
    }
    if (!has("library", "addPdfFromUrl")) { warn("?pdf= ignored: M.library.addPdfFromUrl is missing"); return; }
    try {
      Promise.resolve(M.library.addPdfFromUrl(abs.href)).catch(function (e) {
        report("library.addPdfFromUrl", e);
        api.toast({ text: "Could not load the PDF from ?pdf=", id: "pdf-param" });
      });
    } catch (e) { report("library.addPdfFromUrl", e); }
  }

  // The daily backup through Marginalia's own server (js/backup.js, BUILD-NOTES "Automatic backup"): started once the
  // store is open, the library loaded and the first screen routed, in the tab that writes (boot stops earlier in a tab
  // that stepped aside). M.backup.start() itself does nothing in memory mode, on file:// or in the artifact build, and
  // boot never waits for it.
  function startBackup() {
    if (!has("backup", "start")) return;
    try { Promise.resolve(M.backup.start()).then(null, function (e) { report("backup.start", e); }); }
    catch (e) { report("backup.start", e); }
  }

  // The desktop app (js/desktop.js, FEATURES E2.2): M.desktop.start() decides once, at the very start of boot, whether
  // this is the app, a browser page the app replaced (cover mode, after GET /api/app: at most 3 s, while the library
  // loads) or a browser page as before. Boot waits for that answer before it routes, sweeps, reads ?pdf= or starts the
  // daily backup, so nothing writes or sends before it is known; in cover mode it shows the cover and does none of them.
  function startDesktop() {
    if (!has("desktop", "start")) return Promise.resolve(null);
    try { return Promise.resolve(M.desktop.start()).then(null, function (e) { report("desktop.start", e); return null; }); }
    catch (e) { report("desktop.start", e); return Promise.resolve(null); }
  }
  function covered() {
    if (!has("desktop", "covered")) return false;
    try { return !!M.desktop.covered(); } catch (e) { return false; }
  }
  function showCover() {
    if (!has("desktop", "showCover")) return false;
    try { return !!M.desktop.showCover(); } catch (e) { report("desktop.showCover", e); return false; }
  }

  // ---- boot -------------------------------------------------------------------

  function boot() {
    if (!hasDom()) return Promise.resolve(false);
    if (state.booted) return state.booted;
    var desktop = null;
    state.booted = Promise.resolve().then(function () {
      var settings = tryDep("settings"), theme = "system";
      try { theme = settings && typeof settings.get === "function" ? settings.get("theme") : "system"; } catch (e) { theme = "system"; }
      applyTheme(theme);
      bindBus();
      bindDom();                                           // before store.open so store:mode banners are caught
      desktop = startDesktop();                            // the app check runs while the library loads (FEATURES E2.2)
      if (!has("store", "open")) throw err("no_store", "M.store is not loaded");
      // D31: the windows of the Mac app hand the writer role to each other (no "other tab" notice there)
      if (has("desktop", "isApp") && has("store", "handover")) {
        try { if (M.desktop.isApp() === true) M.store.handover(true); } catch (e2) { report("store.handover", e2); }
      }
      return M.store.open();
    }).then(function (res) {
      if (res && res.mode === "memory") onStoreMode({ mode: "memory", reason: null, message: null });
      if (!handoverOn()) return null;
      // The role first, then the library: so the library is read once, and after the last writer's writes. A writer
      // that does not answer in time does not hold this window up: it starts as a reader and reads again when the
      // role comes.
      // First of all this window says that it is there (the Web Lock "marginalia.window.<id>", for its life): a
      // window that gave it a tab waits for that (js/tabs.js moveToWindow), and the first window of the next start
      // must not take this window's list of tabs.
      try {
        if (has("store", "hold")) M.store.hold("window." + ((has("tabs", "windowId") ? M.tabs.windowId() : null) || ""));
      } catch (e3) { report("store.hold", e3); }
      bindRole();
      return new Promise(function (resolve) {
        var timer = setTimeout(resolve, ROLE_WAIT_MS);
        takeRole().then(function () { clearTimeout(timer); resolve(); });
      });
    }).then(function () {
      state.roleNotice = true;                             // from here on a role that does not come is said (takeRole)
      roleNotice();
      if (!has("cache", "load")) throw err("no_cache", "M.cache is not loaded");
      state.cacheLoad = Promise.resolve(M.cache.load());
      return state.cacheLoad;
    }).then(function () {
      return desktop;                                      // nothing routes, writes or sends before its answer
    }).then(function () {
      if (covered()) { showCover(); return "cover"; }    // a browser page the desktop app replaced: the cover, nothing else
      if (state.lock || storeLocked()) return false;     // a newer tab took over while this one started: it shows nothing more
      if (has("attachments", "sweep")) {
        // DECISIONS D33: a step of ANOTHER window of the Mac app may name a picture that no live prompt names any
        // more (M.undo's steps are each page's own), so only a window that starts alone sweeps.
        try {
          otherWindows().then(function (others) { return others ? null : M.attachments.sweep(Date.now()); })
            .catch(function (e) { report("attachments.sweep", e); });
        } catch (e) { report("attachments.sweep", e); }
      }
      var r = parseHash(typeof location !== "undefined" ? location.hash : "");
      var first = { screen: r.screen, collectionId: r.params.collectionId, promptId: r.params.promptId };
      // D30: the tabs of the last time come back; an address that names a place (a link) goes before the stored tab
      if (has("tabs", "start")) {
        try { first = M.tabs.start(first, r.screen !== "library") || first; } catch (e) { report("tabs.start", e); }
      }
      return api.route(first.screen, { collectionId: first.collectionId, promptId: first.promptId, position: first.position, replace: true });
    }).then(function (routed) {
      if (routed === "cover" || state.lock || storeLocked()) return true;
      handlePdfParam();
      if (state.screen !== "library" && has("library", "render")) { try { M.library.render(); } catch (e) { report("library.render", e); } }
      startBackup();
      return true;
    }).catch(function (e) {
      report("boot", e);
      // a page the desktop app replaced shows its cover even when its library could not be opened
      return Promise.resolve(desktop).then(function () {
        if (covered() && showCover()) return false;
        api.toast({ text: "Marginalia could not start — see the console", id: "boot-error", ttl: 0 });
        return false;
      });
    });
    return state.booted;
  }

  // ---- api --------------------------------------------------------------------

  var api = {
    boot: boot,
    route: route,
    setFocusOwner: setFocusOwner,
    focusOwner: focusOwner,
    toast: toast,
    confirm: confirm,
    setTheme: setTheme,
    isArtifact: isArtifact,
    startReview: startReview,
    openShortcuts: openShortcuts,
    // extensions (documented in the engineer's report)
    closeShortcuts: closeShortcuts,
    handleKeydown: handleKeydown,
    showBanner: showBanner,
    hideBanner: hideBanner,
    handleError: handleError,
    parseHash: parseHash,
    hashFor: hashFor,
    current: current,
    // D30: something that takes every key is up (the ? sheet, a confirm question, Settings, the "other tab" notice, the cover)
    modal: function () { return !!(state.sheet || state.confirmOpen || state.lock || covered() || settingsOpen() || dialogOpen()); },
    OWNERS: OWNERS.slice(),
    // one writing tab per origin: the notice's state (null while this tab may write), and a test hook
    tabLock: function () { return state.lock ? { texts: state.lock.texts.slice(), by: state.lock.by } : null; },
    // D31: this window takes the writer role (→ Promise<boolean>; true at once outside handover mode)
    takeRole: takeRole,
    // D31: this window closes for good: its list of tabs goes, and a place it held back is stored (→ Promise<boolean>)
    leave: leave,
    _setReload: function (fn) { state.reload = typeof fn === "function" ? fn : null; }
  };
  M.app = api;
  bindBus();                                               // bus listeners are safe without a DOM
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.app + BUILD-NOTES "Key routing" / "Routing and review triggers"):
 * boot() → Promise (settings → theme → store.open → cache.load → attachments.sweep → bind events → route from
 * location.hash or "library" → ?pdf=<url> once via M.library.addPdfFromUrl → M.library.render() → M.backup.start(),
 * not awaited, BUILD-NOTES "Automatic backup");
 * route(screen, params) ("library" | "deck" {collectionId} | "reader" {collectionId, promptId?, pageIndex?} |
 * "stats" (D27: the statistics page, hash "#stats", M.stats.open / close; Esc there routes to the library); shows
 * one of #library/#deck/#reader/#stats, calls M.reader.open/close and M.library.openDeck, updates location.hash without
 * reloading, routes review:gotoSource to the reader with promptId); setFocusOwner(owner); focusOwner();
 * toast({text, actions: [{label, run}], ttl, id}) → {close} (#toasts, text only, id replaces, ttl default 6 s, never
 * steals focus); confirm({title, body, ok, cancel, danger}) → Promise<boolean> (#confirm, focus trap, Esc = cancel,
 * Enter = ok, focus returns to the invoker); setTheme("system"|"light"|"dark") (data-theme on the root element, follows
 * settings:changed theme); isArtifact() (<meta name="marginalia-build" content="artifact">);
 * startReview(scope, collectionId|null) → M.review.start({scope, collectionId, now}) (scope "folder" with the folder's id
 * too, FEATURES L1.5; unknown scopes review "all"); openShortcuts() (the ? sheet
 * from M.keys.READER_MAP / EDITOR_MAP / settings.reviewKeys with M.keys.label, Esc closes); the ONE document keydown
 * listener with the BUILD-NOTES routing table and the Escape chain; store:mode / versionchange / blocked banners in
 * #banner; window error + unhandledrejection → one deduplicated toast.
 * Extensions: closeShortcuts(), handleKeydown(ev) → boolean, showBanner(opts) → {close}, hideBanner(id),
 * handleError(message), parseHash(hash), hashFor(screen, params), current(), OWNERS.
 * BUILD-NOTES "Obsidian": #reader/<collectionId>/<promptId> (boot and hashchange) routes to the reader with that promptId
 * (M.reader.open scrolls to the passage and focuses the card); the ? sheet lists O (obsidianNote) while the Obsidian
 * connection is on (M.obsidian.enabled(), DECISIONS D32).
 * One writing tab per origin (js/store.js): store:mode {reason: "othertab"} → the blocking #tabLock notice in #app
 * (role alertdialog, aria-modal, "Marginalia is open in another tab", "Use this tab" → location.reload(); unsaved
 * editor text (M.margin.activeEditor, M.library.activeEditor) and prompt:refused texts in a read-only textarea through
 * M.util.escapeHtml with "Copy text" (clipboard.writeText, else select + execCommand("copy"))); the other #app children
 * get inert; capture-phase keydown / paste / drop guards and a focusin guard; route(), confirm() and toast() do nothing
 * and boot stops before routing once locked. Extensions: tabLock() → {texts, by}|null, _setReload(fn) (test hook).
 * FEATURES E2.2 (js/desktop.js): boot → M.desktop.start() before store.open (the app check, or persist() in the app),
 * waited for after cache.load; covered → M.desktop.showCover() and nothing more (no sweep, route, ?pdf= or backup; boot
 * resolves true); route() → false while covered.
 * BUILD-NOTES "Prompt craft" (FEATURES P1.3): the review owner dispatches flag → M.review.flag() and delete →
 * M.review.remove(); the ? sheet's Review section names them "Flag for revision" and "Delete prompt".
 * BUILD-NOTES "Tabs" (D30): route() emits app:routed {screen, collectionId, promptId} and passes params.position to
 * M.reader.open; boot asks M.tabs.start(route, explicit) for the first route; a hashchange to a new address asks
 * M.tabs.link(route) first (Back and Forward, told by HISTORY_MARK in history.state, route the tab on screen);
 * handleKeydown asks M.tabs.handleKey(ev) before the owner's map; the ? sheet has a Tabs section; modal() → boolean
 * (the ? sheet, a confirm question, the "other tab" notice, the cover, Settings, or a `.dialog` of another module:
 * Export / Import, the "Move to folder…" picker). */
