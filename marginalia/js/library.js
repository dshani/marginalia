/* js/library.js — M.library: the home screen, the deck page, the settings panel and "Add PDF"
 * (SPEC §2, §3 "Open PDF", §11 duplicates, §14, §15 settings, §17.2; BUILD-NOTES extras).
 *
 * Home (#library): header with "Review all · N due", Add PDF, New deck, ⚙; the "N written today ·
 * Review today's" banner; BOOKS and DECKS rows (✎ rename, Continue reading / Open, Review, ⋯ menu: Rename,
 * Export…, Send all to Obsidian, Replace file, one "Remove mark …" per manual chapter mark, Delete; a deck's: Rename,
 * Export…, Send all to Obsidian, Delete), the inline "New deck" field,
 * the storage footer. Counts re-render on prompt:*, review:graded, review:ended, collection:*,
 * prompts:recontexted and every 60 s while visible; a rebuild keeps focus on the same control (data-focus).
 * Review buttons are never disabled (with nothing due the review overlay says so). A delete shows
 * "Deleted · Undo (Z)"; Z on #library / #deck (or M.library.undoDelete()) restores while it shows.
 * Deck page (#deck): rename, description, counts, Review this deck, Export…, ⋯ (Rename, Export…, Send all to Obsidian,
 * Delete), the prompt list (M.list) and the batch "Add prompts" editor (one M.editor in batch mode).
 * "Send all to Obsidian" (BUILD-NOTES "Obsidian"): M.obsidian.planAll, then a confirm naming the card count, the target
 * note, the new cards added and the edited ones updated in place, and the cards already there that are skipped (FEATURES
 * A8: never a card twice), then M.obsidian.sendAll(id, {fromGesture: true}) (the confirming click is the gesture). With
 * nothing new or edited there is no confirm and no request: a toast says everything is already in Obsidian. FEATURES A9:
 * a card whose server send did not finish is updated in place by the server ("R whose last send did not finish are
 * updated in place") and held back by a link: the confirm, or the toast when nothing else would go, says "<N> card(s)
 * may already be in Obsidian: a send to Marginalia's server did not finish. Start Marginalia with the marginalia command
 * and send again: it checks the note and never adds a second copy." (heldText; that toast stays 12 s, as the held line
 * does everywhere, repair A9-R7 of 2026-11-10).
 * Settings (#settings): Appearance · Review shortcuts · LaTeX from snips · Obsidian (BUILD-NOTES "Obsidian": the switch
 * "Connect Marginalia to Obsidian" of DECISIONS D32 and, while it is on, vault, folder,
 * the method in use, "restart Marginalia" when an older serve.py serves the page; the vault name kept exactly as
 * Obsidian lists it; M.obsidian.detect runs again on every open while the connection is on) · Data (export / import, the "Automatic backup" block
 * of M.backup when it is loaded, with its PDFs line (FEATURES B9.6), storage). The panel keeps keys from
 * the app's listener, so it runs the settings owner's routed keys itself ("," "?" Mod+O Shift+R T).
 * Add PDF: bytes → sha256 (fnv1a fallback) → M.pdfview.open on a copy with NO container (metadata only; a
 * password-protected file gets M.pdfview's in-page password panel) → fingerprint, numPages, info, page labels,
 * outline → sections → duplicate check (§11: replace / separate book / nothing) → M.store.docs.saveDocument →
 * M.cache.saveCollection → M.app.route("reader"). attachPdf(id, bytes) (FEATURES B9.5): the PDF M.backup takes from the
 * backup folder joins a book without its bytes as "Choose file again" would join that file, after the same SHA-256
 * check, without opening it and without routing anywhere. Both write the record M.cache holds once the PDF is stored
 * (repair B9-R1 / LIB-1): a rename, move or import made meanwhile stays, and a book deleted meanwhile stays deleted.
 *
 * Folders (FEATURES L1, BUILD-NOTES "Library folders"): "New folder" beside "New deck"; a FOLDERS section above BOOKS and
 * DECKS holds the top-level folders (chevron, name, counts of its whole subtree, "Review · N due", ⋯ Rename / New folder
 * inside / Move to folder… / Delete); an open folder shows its sub-folders, books and decks indented ("Empty — drag
 * books here or use Move to folder…" when there is nothing). Open folders are remembered in localStorage
 * "marginalia.openFolders". "Move to folder…" (book, deck, deck page and folder menus) opens a picker on document.body:
 * every folder as an indented tree plus "No folder (top level)", the current place marked, a folder's own subtree
 * disabled. Rows drag onto a folder row or the top-level sections (HTML5 drag and drop, listeners bound once on
 * #library; Esc cancels); every move toasts "Moved … · Undo". The data lives in M.cache (folders, moveCollection, …).
 * Repairs of 2026-11-11: an inline New folder / New deck field stays up through a re-render, with its text and focus,
 * so nothing else waits for it (UI-1); the picker gives focus back to its ⋯ even when a re-render replaced it (UI-3)
 * and, opened from the deck page, sets no landing for the home screen (UI-2); a delete in a folder lands focus in that
 * folder (UI-4); a refused move or Undo names what was deleted, never a record id (UI-5).
 *
 * The desktop app (FEATURES E2.2d, M.desktop): while its library holds no live book, deck or prompt, the home screen
 * starts with the welcome card "Welcome to Marginalia" (welcomeCard(), from M.desktop.welcome()): "Import the
 * newest backup (<date and time>)", "Import a backup file…" and "Start with an empty library".
 *
 * Buttons only call M.app.route / M.app.startReview; nothing here calls M.reader or M.review.
 * Loads in node without a DOM: every DOM entry point returns early there; api._pure is testable.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  var NICK_MAX = 24, TITLE_MIN = 3, TITLE_MAX = 80;
  var MAX_DOC_BYTES = 300 * 1024 * 1024;
  var REFRESH_MS = 60000;
  var UNDO_TTL_MS = 8000;
  var DATA_EVENTS = ["prompt:saved", "prompt:deleted", "prompt:restored", "review:graded", "review:ended",
    "collection:changed", "collection:deleted", "prompts:recontexted", "folders:changed"];
  var TABS = [
    { id: "appearance", label: "Appearance" },
    { id: "shortcuts", label: "Review shortcuts" },
    { id: "latex", label: "LaTeX from snips" },
    { id: "obsidian", label: "Obsidian" },
    { id: "data", label: "Data" }
  ];
  var TAB_ALIASES = { appearance: "appearance", theme: "appearance", shortcuts: "shortcuts", keys: "shortcuts", review: "shortcuts",
    "review shortcuts": "shortcuts", latex: "latex", vision: "latex", "latex from snips": "latex", snips: "latex", data: "data",
    "export": "data", "import": "data", storage: "data", obsidian: "obsidian", vault: "obsidian" };
  var ACTION_LABELS = { showAnswer: "Show answer", forgot: "Forgot", remembered: "Remembered", undo: "Undo last grade",
    skip: "Skip (ask later this session)", goToSource: "Go to source", flag: "Flag for revision", "delete": "Delete prompt",
    exit: "Exit review" };
  var MODIFIER_NAMES = { Ctrl: 1, Alt: 1, Shift: 1, Meta: 1 };

  var st = {
    inited: false, timer: null, dirty: false, refreshQueued: false,
    renaming: false, newDeck: null, menu: null, prep: null, busy: false, pendingReplaceId: null,   // newDeck: see inlineFields
    parsing: false,    // the Add-PDF metadata open is pending in M.pdfview.open (doc:password relabels the prep bar)
    undo: null,        // the collection delete "Deleted · Undo (Z)" offers: {id, name, isBook, until, handle}
    focusKey: null,    // data-focus key the next home render() focuses (where focus lands after a delete)
    deck: null,        // {id, el, nameEl, descEl, countsEl, editor, listHost, opening}
    settings: null,    // {host, panel, tab, invoker, prevOwner, keysMap, conflicts, recording, body, paintBackup, paintObsidian}
    sendAllAsking: Object.create(null), // collectionId → true from a "Send all to Obsidian" click until its confirm is answered
    // folders (FEATURES L1)
    openFolders: null, // Set of the open folders' ids (localStorage "marginalia.openFolders"), read on first use
    newFolder: null,   // the inline "New folder" field while it is up ({kind, row, input, parentId, …}, see inlineFields)
    drag: null,        // {kind: "folder"|"collection", id, row} while a row is dragged
    dropOver: null,    // the element highlighted as the drop target
    picker: null       // {el, invoker} while the "Move to folder…" picker is up
  };

  // ------------------------------------------------------------------ small helpers

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function noop() {}
  function tryCall(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  // Promise.resolve(fn()), or a rejection with `code` when fn throws (built lazily: never a dangling rejected promise)
  function tryPromise(fn, code, message) {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(err(code, message || (e && e.message) || code)); }
  }
  function now() { return Date.now(); }
  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function live(r) { return !!r && (r.deletedAt === null || r.deletedAt === undefined); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function collapse(s) { return str(s).replace(/\s+/g, " ").trim(); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function hasDom() { return typeof document !== "undefined" && !!document.getElementById; }
  function byId(id) { return hasDom() ? document.getElementById(id) : null; }
  function isVisible(el) { return !!el && !el.classList.contains("is-hidden"); }

  function escapeHtml(s) {
    var u = tryDep("util");
    if (u && typeof u.escapeHtml === "function") return u.escapeHtml(s);
    return str(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; });
  }
  function fmtBytes(n) {
    var u = tryDep("util");
    if (u && typeof u.fmtBytes === "function") return u.fmtBytes(n);
    return Math.round(n / 1048576) + " MB";
  }
  function cache() { return M.cache || tryDep("cache"); }
  function settings() { return M.settings || tryDep("settings"); }
  function keys() { return M.keys || tryDep("keys"); }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "class") el.className = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

  // detail: an optional second line (M.app.toast's detail)
  function toast(text, actions, ttl, id, onClose, detail) {
    var app = M.app;
    if (!app || typeof app.toast !== "function") return null;
    var opts = { text: text, actions: actions || [], ttl: ttl || 5000, id: id, onClose: onClose };
    if (detail) opts.detail = detail;
    return tryCall(function () { return app.toast(opts); }, null);
  }
  function confirm(opts) {
    var app = M.app;
    if (!app || typeof app.confirm !== "function") return Promise.resolve(false);
    return tryCall(function () { return Promise.resolve(app.confirm(opts)); }, Promise.resolve(false));
  }
  function route(screen, params) {
    var app = M.app;
    if (app && typeof app.route === "function") tryCall(function () { app.route(screen, params || {}); });
  }
  function startReview(scope, collectionId) {
    var app = M.app;
    if (app && typeof app.startReview === "function") tryCall(function () { app.startReview(scope, collectionId === undefined ? null : collectionId); });
  }
  function setOwner(owner) {
    var app = M.app;
    if (app && typeof app.setFocusOwner === "function") tryCall(function () { app.setFocusOwner(owner); });
  }
  function currentOwner(fallback) {
    var app = M.app;
    if (app && typeof app.focusOwner === "function") return tryCall(function () { return app.focusOwner(); }, fallback) || fallback;
    return fallback;
  }
  function isSafari() {
    if (typeof navigator === "undefined") return false;
    var ua = str(navigator.userAgent);
    return /safari/i.test(ua) && !/chrome|chromium|crios|android|edg/i.test(ua);
  }
  function isLocalhost() {
    if (typeof location === "undefined") return false;
    var hn = str(location.hostname);
    return hn === "localhost" || hn === "127.0.0.1";
  }

  // ------------------------------------------------------------------ pure helpers

  function cutChars(s, max) {
    var a = Array.from(str(s));
    if (a.length <= max) return str(s);
    return a.slice(0, max).join("").replace(/\s+$/, "");
  }

  // §14 nickname rule: info.Title when 3–80 printable characters and not a file name or "untitled".
  function saneTitle(t) {
    var s = collapse(t);
    if (!s) return false;
    var len = Array.from(s).length;
    if (len < TITLE_MIN || len > TITLE_MAX) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;          // eslint-disable-line no-control-regex
    if (/^untitled/i.test(s)) return false;
    if (/\.(pdf|docx?|tex|dvi|ps|indd|qxd|odt|rtf|txt)\b/i.test(s)) return false;   // "chapter1.pdf", "Microsoft Word - foo.doc"
    if (/^\S+\.[a-z0-9]{1,5}$/i.test(s)) return false;         // no spaces + extension = a file name
    return true;
  }
  function nicknameFor(info, fileName) {
    var title = info && typeof info.Title === "string" ? collapse(info.Title) : "";
    if (saneTitle(title)) return title;
    var base = str(fileName).replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
    base = collapse(base.replace(/[_]+/g, " ")) || "Untitled";
    return cutChars(base, NICK_MAX);
  }

  // Outline sections of the (new) file + the manual marks the record already has, stably sorted by page.
  function mergeSections(outlineSections, existingSections) {
    var out = (outlineSections || []).filter(function (s) { return s && isNum(s.pageIndex); }).map(function (s) { return Object.assign({}, s, { source: "outline" }); });
    (existingSections || []).forEach(function (s) { if (s && s.source === "manual" && isNum(s.pageIndex)) out.push(Object.assign({}, s)); });
    return out.map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) { return (a.s.pageIndex - b.s.pageIndex) || (a.i - b.i); })
      .map(function (e) { return e.s; });
  }

  // §14 "the book ⋯ menu lists marks with Remove": the record's manual chapter marks, in stored (page) order.
  function manualMarks(sections) {
    return (Array.isArray(sections) ? sections : []).filter(function (s) { return s && s.source === "manual" && isNum(s.pageIndex); });
  }
  function sameMark(a, b) {
    return !!a && !!b && a.source === "manual" && b.source === "manual" && a.pageIndex === b.pageIndex && str(a.label) === str(b.label);
  }
  function withoutMark(sections, mark) {
    return (Array.isArray(sections) ? sections : []).filter(function (s) { return !sameMark(s, mark); });
  }
  // Undo of a removal: the mark goes back in page order, replacing a manual mark on its page (as reader.commitChapter does).
  function withMark(sections, mark) {
    var out = (Array.isArray(sections) ? sections : []).filter(function (s) { return !(s && s.source === "manual" && s.pageIndex === mark.pageIndex); });
    out.push(Object.assign({}, mark));
    return out.map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) { return (a.s.pageIndex - b.s.pageIndex) || (a.i - b.i); })
      .map(function (e) { return e.s; });
  }
  function markName(mark) { return collapse(mark && (mark.label || mark.title)) || "Untitled mark"; }
  function markMenuLabel(mark, pageLabels) {
    var name = markName(mark), cut = cutChars(name, 40);
    var page = Array.isArray(pageLabels) && pageLabels[mark.pageIndex] ? str(pageLabels[mark.pageIndex]) : String(mark.pageIndex + 1);
    return "Remove mark “" + cut + (cut !== name ? "…" : "") + "” · p. " + page;
  }

  // "Replace file, keep prompts" (§5, §11): a passage with a quote is re-found lazily in the new file (M.reader on
  // page:textready), so it is lost until then. An anchor without a quote — a free note (pages [], quote "") — has
  // nothing to re-find and sits at its y alone: it is lost exactly when its page is gone (pageIndex ≥ pageCount).
  function lostAfterReplace(anchor, pageCount) {
    if (!anchor || typeof anchor !== "object") return false;
    if (isNum(anchor.pageIndex) && isNum(pageCount) && pageCount > 0 && anchor.pageIndex >= pageCount) return true;
    if (str(anchor.quote).trim()) return true;
    return isNum(anchor.pageIndex) ? false : anchor.lost === true;
  }

  function sortCollections(cols) {
    return (cols || []).filter(live).slice().sort(function (a, b) {
      return ((isNum(b.lastOpenedAt) ? b.lastOpenedAt : 0) - (isNum(a.lastOpenedAt) ? a.lastOpenedAt : 0)) ||
        ((isNum(b.addedAt) ? b.addedAt : 0) - (isNum(a.addedAt) ? a.addedAt : 0)) ||
        str(a.name).localeCompare(str(b.name));
    });
  }

  function bookMeta(c, counts) {
    var parts = [];
    if (isNum(c.pageCount)) parts.push(c.pageCount + " pp");
    parts.push(plural(counts.prompts, "prompt"));
    parts.push(counts.due + " due");
    if (c.lastPosition && isNum(c.lastPosition.pageIndex)) {
      var label = Array.isArray(c.pageLabels) && c.pageLabels[c.lastPosition.pageIndex] ? str(c.pageLabels[c.lastPosition.pageIndex]) : String(c.lastPosition.pageIndex + 1);
      parts.push("p. " + label);
    }
    if (c.hasBytes === false) parts.push("PDF not in library");
    return parts.join(" · ");
  }
  function deckMeta(counts) { return plural(counts.prompts, "prompt") + " · " + counts.due + " due"; }

  function fileNameFromUrl(url) {
    var s = str(url).split(/[?#]/)[0].replace(/\/+$/, "");
    var name = s.slice(s.lastIndexOf("/") + 1);
    try { name = decodeURIComponent(name); } catch (e) { /* keep as is */ }
    if (!name) name = "document.pdf";
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    return name;
  }
  function isPdfFile(file) {
    if (!file) return false;
    if (str(file.type).toLowerCase() === "application/pdf") return true;
    return /\.pdf$/i.test(str(file.name));
  }
  // "%PDF-" within the first 1 KB (PDFs may carry a short preamble)
  function looksLikePdf(u8) {
    if (!u8 || !u8.length) return false;
    var n = Math.min(u8.length, 1024);
    for (var i = 0; i + 4 < n; i++) {
      if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 && u8[i + 3] === 0x46 && u8[i + 4] === 0x2d) return true;
    }
    return false;
  }
  function fingerprintOf(doc) {
    if (!doc) return "";
    if (typeof doc.fingerprint === "string" && doc.fingerprint) return doc.fingerprint;
    if (Array.isArray(doc.fingerprints) && typeof doc.fingerprints[0] === "string") return doc.fingerprints[0];
    if (Array.isArray(doc.fingerprint) && typeof doc.fingerprint[0] === "string") return doc.fingerprint[0];
    return "";
  }

  // The collection record of §8 for a new (or replaced) book. `existing` keeps id, nickname, manual marks, position.
  function bookRecord(ctx, id, existing, t) {
    var base = existing ? Object.assign({}, existing) : {};
    var title = ctx.info && typeof ctx.info.Title === "string" ? collapse(ctx.info.Title) : "";
    var rec = Object.assign(base, {
      id: id, kind: "book",
      name: existing && existing.name ? existing.name : nicknameFor(ctx.info, ctx.fileName),
      title: title, fileName: str(ctx.fileName),
      sha256: ctx.sha256, hashAlgo: ctx.hashAlgo, byteLength: ctx.bytes ? ctx.bytes.byteLength : 0,
      pageCount: ctx.numPages, pageLabels: Array.isArray(ctx.pageLabels) ? ctx.pageLabels : null,
      sections: mergeSections(ctx.sections, existing ? existing.sections : []),
      lastPosition: existing && existing.lastPosition && isNum(existing.lastPosition.pageIndex) && existing.lastPosition.pageIndex < ctx.numPages
        ? existing.lastPosition : { pageIndex: 0, fraction: 0, zoom: "fit" },
      addedAt: existing && isNum(existing.addedAt) ? existing.addedAt : t,
      lastOpenedAt: t, updatedAt: t, deletedAt: null, v: 1
    });
    if (!existing) { rec.hasBytes = false; rec.chunkCount = 0; rec.chunkSize = 0; }
    return rec;
  }

  // §11 decision: reopen (same bytes), restoreBytes (hasBytes false), ask (same fingerprint, other sha), new.
  function decideDuplicate(ctx, cols, replaceId) {
    var books = (cols || []).filter(function (c) { return c && c.kind === "book"; });
    var find = function (pred) { for (var i = 0; i < books.length; i++) if (pred(books[i])) return books[i]; return null; };
    if (replaceId) {
      var target = find(function (c) { return c.id === replaceId && live(c); });
      if (target) return { action: "replace", existing: target };
    }
    var byIdRec = find(function (c) { return c.id === ctx.fingerprint && live(c); });
    if (byIdRec) {
      if (!byIdRec.sha256 || byIdRec.sha256 === ctx.sha256) return { action: byIdRec.hasBytes === false ? "restoreBytes" : "reopen", existing: byIdRec };
      return { action: "ask", existing: byIdRec, separateId: ctx.fingerprint + ":" + str(ctx.sha256).slice(0, 8) };
    }
    var bySha = find(function (c) { return live(c) && c.sha256 === ctx.sha256; });
    if (bySha) return { action: bySha.hasBytes === false ? "restoreBytes" : "reopen", existing: bySha };
    return { action: "new", id: ctx.fingerprint || ctx.sha256 };
  }

  // Review-shortcut helpers (§7 "Configurable shortcuts")
  function bindingOf(v) { return v && typeof v === "object" && !Array.isArray(v) ? v.binding : v; }
  function sameBinding(a, b) {
    a = bindingOf(a); b = bindingOf(b);
    if (!a || !b) return false;
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
    var k = keys();
    if (!k || typeof k.parse !== "function") return a === b;
    var da = k.parse(a), db = k.parse(b);
    return !!da.key && da.key === db.key && da.ctrl === db.ctrl && da.alt === db.alt && da.shift === db.shift && da.meta === db.meta;
  }
  function actionList() {
    var k = keys();
    return k && Array.isArray(k.REVIEW_ACTIONS) ? k.REVIEW_ACTIONS.slice() : Object.keys(ACTION_LABELS);
  }
  // The edited action keeps the key; every other action bound to it becomes null ("unbound").
  function applyBinding(map, action, binding) {
    var out = {}, conflicted = [];
    actionList().forEach(function (a) { out[a] = map && map[a] !== undefined ? bindingOf(map[a]) : null; });
    out[action] = binding;
    actionList().forEach(function (a) {
      if (a !== action && sameBinding(out[a], binding)) { out[a] = null; conflicted.push(a); }
    });
    return { map: out, conflicted: conflicted };
  }
  function presetName(map) {
    var k = keys();
    if (!k || !k.PRESETS) return null;
    var names = Object.keys(k.PRESETS), acts = actionList();
    for (var i = 0; i < names.length; i++) {
      var p = k.PRESETS[names[i]], same = true;
      for (var j = 0; j < acts.length; j++) {
        var mine = map ? bindingOf(map[acts[j]]) : null;
        if (!sameBinding(mine, p[acts[j]])) { same = false; break; }
      }
      if (same) return names[i];
    }
    return null;
  }
  function normalizeTab(tab) {
    var t = str(tab).trim().toLowerCase();
    return TAB_ALIASES[t] || "appearance";
  }

  // ------------------------------------------------------------------ init: events, timer, file input

  function init() {
    if (st.inited || !hasDom()) return;
    st.inited = true;
    var bus = M.bus || tryDep("bus");
    if (bus && typeof bus.on === "function") {
      DATA_EVENTS.forEach(function (t) { bus.on(t, function (p) { onDataChange(t, p); }); });
      bus.on("doc:opened", function () { teardownDeck(); });
      // M.pdfview's password panel is up for the file being added: the bar waits on the user, not on the parse
      bus.on("doc:password", function () { if (st.parsing && st.busy) showPrep("Enter the PDF’s password to add it"); });
      // M.backup (js/backup.js) changed: Settings › Data repaints its "Automatic backup" block while it shows
      bus.on("backup:state", function () {
        var s = st.settings;
        if (s && typeof s.paintBackup === "function") tryCall(function () { s.paintBackup(); });
      });
      // DECISIONS D32: the Obsidian switch changed outside the pane (another window of the Mac app, through
      // M.settings.reload(); an import that restores settings): Settings › Obsidian shows the new state while it shows
      bus.on("settings:changed", function (e) {
        var s = st.settings;
        if (e && e.key === "obsidian" && s && typeof s.paintObsidian === "function") tryCall(function () { s.paintObsidian(); });
      });
      // M.desktop (js/desktop.js, FEATURES E2.2): the app's welcome card follows the backup folder and its import
      bus.on("desktop:state", function () { onDataChange("desktop:state"); });
    }
    st.timer = setInterval(function () {
      if (isVisible(byId("library"))) render();
      else if (isVisible(byId("deck"))) updateDeckHeader();
    }, REFRESH_MS);
    var input = byId("fileInput");
    if (input && !input.__marginaliaLibrary) {
      input.__marginaliaLibrary = true;
      input.addEventListener("change", function () {
        var f = input.files && input.files[0];
        var replaceId = st.pendingReplaceId;
        st.pendingReplaceId = null;
        if (f) addPdfWith(f, replaceId).catch(noop);
        else if (replaceId) toast("No file chosen");
        try { input.value = ""; } catch (e) { /* ignore */ }
      });
      // a dismissed picker fires "cancel", not "change": a pending "Replace file" must not stick to the next add
      input.addEventListener("cancel", function () { st.pendingReplaceId = null; });
    }
    // Z while "Deleted · Undo (Z)" shows (§14). M.app routes no undoDelete for the library owner, so the screen
    // hosts take it on its way up to the app's document listener (as list.js does for its own undo).
    ["library", "deck"].forEach(function (hostId) {
      var el = byId(hostId);
      if (el && !el.__marginaliaUndoKey) { el.__marginaliaUndoKey = true; el.addEventListener("keydown", onUndoKey); }
    });
    var lib = byId("library");
    if (lib && !lib.__marginaliaDrop) {
      lib.__marginaliaDrop = true;
      lib.addEventListener("dragover", function (ev) {
        if (st.drag && isFileDrag(ev)) endDrag();            // a row drag that never ended: this one brings files
        if (st.drag) { onItemDragOver(ev); return; }
        if (!ev.dataTransfer || isTabDrag(ev)) return;       // a tab (D31) goes to a tab strip, never to the library
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        lib.classList.add("lib--dragover");
      });
      lib.addEventListener("dragleave", function (ev) {
        if (!lib.contains(ev.relatedTarget)) { lib.classList.remove("lib--dragover"); setDropOver(null); }
      });
      lib.addEventListener("drop", function (ev) {
        lib.classList.remove("lib--dragover");
        if (st.drag && !isFileDrag(ev)) { onItemDrop(ev); return; }
        if (st.drag) endDrag();
        if (!ev.dataTransfer || isTabDrag(ev)) return;
        ev.preventDefault();
        var files = ev.dataTransfer.files;
        var pdf = null;
        for (var i = 0; files && i < files.length; i++) if (isPdfFile(files[i])) { pdf = files[i]; break; }
        if (pdf) addPdf(pdf).catch(noop);
        else toast("Drop a PDF file to add it");
      });
      // dragging rows onto folders (FEATURES L1.3): bound once here, never per render
      lib.addEventListener("dragstart", onItemDragStart);
      lib.addEventListener("dragend", function () { endDrag(); });
      lib.addEventListener("keydown", onDragKey);
      // no mouse event reaches a page during a drag: one that does means any drag is over, dragend or not
      lib.addEventListener("mousedown", function () { if (st.drag) endDrag(); }, true);
    }
    if (typeof MutationObserver === "function") {
      if (lib) new MutationObserver(function () { if (isVisible(lib) && st.dirty) render(); }).observe(lib, { attributes: true, attributeFilter: ["class"] });
      var deckEl = byId("deck");
      if (deckEl) new MutationObserver(function () { if (!isVisible(deckEl)) teardownDeck(); }).observe(deckEl, { attributes: true, attributeFilter: ["class"] });
    }
  }

  function onDataChange(type, payload) {
    if (type === "collection:deleted" && st.deck && payload && payload.collectionId === st.deck.id) {
      if (isVisible(byId("deck"))) route("library");
      teardownDeck();
    }
    if (st.refreshQueued) return;
    st.refreshQueued = true;
    setTimeout(function () {
      st.refreshQueued = false;
      if (isVisible(byId("library"))) render(); else st.dirty = true;
      if (st.deck) updateDeckHeader();
    }, 0);
  }

  // ------------------------------------------------------------------ home screen

  function render() {
    if (!hasDom()) return false;
    init();
    var host = byId("library");
    if (!host) return false;
    if (st.renaming || st.drag || fieldComposing()) { st.dirty = true; return false; }
    var fields = inlineFields(), held = fieldFocus(fields);              // the inline New deck / New folder fields stay
    var landing = st.focusKey, focusKey = landing || focusKeyIn(host);   // a rebuild keeps focus on the same control
    st.focusKey = null;
    closeMenu();
    st.dirty = false;
    var c = cache(), t = now();
    var cols = c && typeof c.collections === "function" ? sortCollections(c.collections()) : [];
    // the books and decks at the top level; those in folders show inside their (open) folder (FEATURES L1.2)
    var tree = folderTree(c, cols), countsOf = countsFor(c, t), foldered = hasFolders(c);
    var books = tree.top.books, decks = tree.top.decks;
    var anyBook = cols.some(function (x) { return x.kind === "book"; }), anyDeck = cols.some(function (x) { return x.kind === "deck"; });
    var total = c && typeof c.counts === "function" ? c.counts(null, t) : { prompts: 0, cards: 0, due: 0, nextDueAt: null, writtenToday: 0 };

    var reviewAll = h("button", { type: "button", "data-focus": "review-all", text: "▶ Review all · " + total.due + " due" });
    reviewLook(reviewAll, total.due, "btn btn--primary lib__review-all", "btn lib__review-all");
    reviewAll.addEventListener("click", function () { startReview("all", null); });
    var addBtn = h("button", { type: "button", class: "btn lib__add", "data-focus": "add", text: "Add PDF" });
    addBtn.addEventListener("click", function () { openFilePicker(null); });
    var newDeckBtn = h("button", { type: "button", class: "btn lib__newdeck-btn", "data-focus": "new-deck", text: "New deck" });
    newDeckBtn.addEventListener("click", function () { showNewDeckField(); });
    var newFolderBtn = null;
    if (foldered) {
      newFolderBtn = h("button", { type: "button", class: "btn lib__newfolder-btn", "data-focus": "new-folder", text: "New folder" });
      newFolderBtn.addEventListener("click", function () { showNewFolderField(null); });
    }
    // D27: the statistics page (js/stats.js) — when each prompt was last asked and when it is due next
    var statsBtn = h("button", { type: "button", class: "btn btn--ghost lib__stats", "data-focus": "stats", title: "When each prompt was last asked and when it is due next", text: "Statistics" });
    statsBtn.addEventListener("click", function (ev) { go(ev, "stats", {}); });
    var gear = h("button", { type: "button", class: "btn btn--ghost lib__gear", "data-focus": "gear", "aria-label": "Settings", title: "Settings (,)", text: "⚙" });
    gear.addEventListener("click", function () { openSettings("appearance"); });

    var header = h("header", { class: "lib__header" }, [
      h("h1", { class: "lib__title", text: "Marginalia" }),
      h("div", { class: "lib__header-actions" }, [reviewAll, addBtn, newDeckBtn, newFolderBtn, statsBtn, gear])
    ]);

    var banner = null;
    if (total.writtenToday > 0) {
      var todayBtn = h("button", { type: "button", class: "btn btn--ghost lib__banner-btn", "data-focus": "today", text: "Review today’s" });
      todayBtn.addEventListener("click", function () { startReview("today", null); });
      banner = h("div", { class: "lib__banner" }, [h("span", { text: plural(total.writtenToday, "prompt") + " written today" }), todayBtn]);
    }

    // FOLDERS (FEATURES L1.2): the top-level folders, above the books and decks of the top level; the slot of the
    // inline "New folder" field ends it (or stands alone while there is no folder yet)
    var foldersSec = null, folderSlot = null;
    if (foldered) {
      folderSlot = h("div", { class: "lib__newfolder-slot" });
      if (tree.top.folders.length) {
        var totals = folderTotals(tree, countsOf);
        foldersSec = h("section", { class: "lib__section lib__section--folders", "data-drop": "" }, [h("h2", { class: "lib__label", text: "Folders" })]);
        tree.top.folders.forEach(function (f) { foldersSec.appendChild(folderGroup(f, tree, totals, countsOf)); });
        foldersSec.appendChild(folderSlot);
      }
    }

    var booksSec = h("section", { class: "lib__section lib__section--books", "data-drop": foldered ? "" : null }, [h("h2", { class: "lib__label", text: "Books" })]);
    if (!books.length && anyBook) {
      booksSec.appendChild(h("div", { class: "lib__empty lib__empty--foldered", text: "No books outside folders — drag one here to take it out of its folder." }));
      if (isLocalhost()) {
        var sample3 = h("button", { type: "button", class: "btn btn--ghost lib__sample", "data-focus": "sample", text: "Open sample PDF" });
        sample3.addEventListener("click", function () { addPdfFromUrl("test/sample.pdf").catch(noop); });
        booksSec.appendChild(h("div", { class: "lib__sample-row" }, [sample3]));
      }
    } else if (!books.length) {
      var empty = h("div", { class: "lib__empty" }, [h("span", { text: "No books yet — add a PDF or drop one here." })]);
      if (isLocalhost()) {
        var sample = h("button", { type: "button", class: "btn btn--ghost lib__sample", "data-focus": "sample", text: "Open sample PDF" });
        sample.addEventListener("click", function () { addPdfFromUrl("test/sample.pdf").catch(noop); });
        empty.appendChild(sample);
      }
      booksSec.appendChild(empty);
    } else {
      books.forEach(function (b) { booksSec.appendChild(bookRow(b, countsOf(b.id))); });
      if (isLocalhost()) {
        var sample2 = h("button", { type: "button", class: "btn btn--ghost lib__sample", "data-focus": "sample", text: "Open sample PDF" });
        sample2.addEventListener("click", function () { addPdfFromUrl("test/sample.pdf").catch(noop); });
        booksSec.appendChild(h("div", { class: "lib__sample-row" }, [sample2]));
      }
    }

    var decksSec = h("section", { class: "lib__section lib__section--decks", "data-drop": foldered ? "" : null }, [h("h2", { class: "lib__label", text: "Decks" })]);
    if (!decks.length && anyDeck) decksSec.appendChild(h("div", { class: "lib__empty lib__empty--foldered", text: "No decks outside folders — drag one here to take it out of its folder." }));
    else if (!decks.length) decksSec.appendChild(h("div", { class: "lib__empty", text: "No decks yet — “New deck” makes a hand-written collection of prompts." }));
    decks.forEach(function (d) { decksSec.appendChild(deckRow(d, countsOf(d.id))); });
    decksSec.appendChild(h("div", { class: "lib__newdeck-slot" }));

    var storage = h("span", { class: "lib__storage", text: "Measuring storage…" });
    var exportLink = h("button", { type: "button", class: "lib__link", "data-focus": "export", text: "Export all" });
    exportLink.addEventListener("click", function () { openExport({ scope: "all" }); });
    var importLink = h("button", { type: "button", class: "lib__link", "data-focus": "import", text: "Import" });
    importLink.addEventListener("click", function () { openExport({ scope: "all", tab: "import" }); });
    var footer = h("footer", { class: "lib__footer" }, [storage, h("span", { class: "lib__links" }, [exportLink, " · ", importLink])]);

    var wrap = h("div", { class: "lib" }, [header, banner, welcomeCard(), foldersSec || folderSlot, booksSec, decksSec, footer]);
    clear(host);
    host.appendChild(wrap);
    fields.forEach(function (f) { placeField(host, f); });
    if (held && host.contains(held.el)) giveFieldFocus(held);
    else if (focusKey && isVisible(host)) focusFirst(host, focusKey, !!landing);
    renderStorage(storage);
    return true;
  }

  // The welcome card (FEATURES E2.2d; M.desktop.welcome()): only in the desktop app, while the library holds no live book,
  // deck or prompt and the card was not dismissed, at the top of the home screen: "Welcome to Marginalia", a line for a
  // new reader ("New here? Click Start with an empty library, then add a PDF."), the question "Did you use Marginalia in
  // a browser before? Bring that library here:" with its
  // two steps, "Import the newest backup (<date and time of the newest backup>)" (M.desktop.importLatest; disabled, with
  // "No backup yet", while the backup folder holds none, and with why when the newest backup is dated after today, repair
  // SEC-1), "Import a backup file…" (the Import dialog) and "Start with an empty library" (M.desktop.dismissWelcome: it goes
  // for good). → the section, or null.
  function welcomeCard() {
    var D = M.desktop;
    if (!D || typeof D.welcome !== "function") return null;
    var w = tryCall(function () { return D.welcome(); }, null);
    if (!w || typeof w !== "object") return null;
    var importBtn = h("button", { type: "button", class: "btn btn--primary lib-welcome__import", "data-focus": "welcome:import",
      text: w.importing ? "Importing the newest backup…" : "Import the newest backup" + (w.last && w.when ? " (" + w.when + ")" : "") });
    var none = null;
    // w.ahead (repair SEC-1): the newest backup is named for a day after today, so it is not the one the browser just wrote
    if (w.importing || !w.last || w.ahead) importBtn.disabled = true;
    if ((!w.last || w.ahead) && !w.importing) {
      var why = w.last ? "The newest backup is dated after today (" + w.ahead + ") — check the Mac's date and time, or use Import a backup file…"
        : w.status === "checking" ? "Looking for a backup…" : (w.error ? "The backup folder cannot be read — " + w.error : "No backup yet");
      importBtn.title = why;
      none = h("span", { class: "lib-welcome__none", text: why });
    }
    importBtn.addEventListener("click", function () {
      if (typeof D.importLatest === "function") tryCall(function () { Promise.resolve(D.importLatest()).catch(noop); });
    });
    var fileBtn = h("button", { type: "button", class: "btn lib-welcome__file", "data-focus": "welcome:file", text: "Import a backup file…" });
    fileBtn.addEventListener("click", function () { openExport({ scope: "all", tab: "import" }); });
    var emptyBtn = h("button", { type: "button", class: "btn btn--ghost lib-welcome__empty", "data-focus": "welcome:empty", text: "Start with an empty library" });
    emptyBtn.addEventListener("click", function () {
      if (typeof D.dismissWelcome === "function") tryCall(function () { D.dismissWelcome(); });
      st.focusKey = "add";                                   // the card goes: focus lands on Add PDF
      render();
    });
    return h("section", { class: "lib-welcome", "aria-labelledby": "libWelcomeTitle" }, [
      h("h2", { class: "lib-welcome__title", id: "libWelcomeTitle", text: "Welcome to Marginalia" }),
      h("p", { class: "lib-welcome__lead", text: "New here? Click Start with an empty library, then add a PDF." }),
      h("p", { class: "lib-welcome__lead", text: "Did you use Marginalia in a browser before? Bring that library here:" }),
      h("ol", { class: "lib-welcome__steps" }, [
        h("li", { text: "1. In that browser, open Marginalia and click Back up this browser's library." }),
        h("li", { text: "2. Here, click Import the newest backup." })
      ]),
      h("div", { class: "lib-welcome__actions" }, [importBtn, none, fileBtn, emptyBtn])
    ]);
  }

  // Review buttons are never disabled: with nothing due, M.review's overlay explains the empty session ("All caught up",
  // "No prompts written today", "No reviewable prompts yet"); a 0-due button only looks quieter.
  function reviewLook(btn, due, loud, quiet) {
    btn.disabled = false;
    btn.className = due > 0 ? loud : quiet;
    if (due > 0) btn.removeAttribute("title"); else btn.title = "Nothing is due";
  }

  // Home controls carry data-focus keys ("add", "row:<id>:more", …) so a rebuild can put focus back on the same control.
  function focusKeyIn(host) {
    var a = hasDom() ? document.activeElement : null;
    if (a && st.menu && st.menu.el.contains(a)) a = st.menu.anchor;      // render() closes the ⋯ menu: back to its button
    if (!a || a === host || typeof a.getAttribute !== "function" || !host.contains(a)) return null;
    return a.getAttribute("data-focus") || null;
  }
  // A landing may name several keys (a moved row, else the folder it went into): the first one on screen wins.
  function focusFirst(host, keys, scroll) {
    var list = Array.isArray(keys) ? keys : [keys];
    for (var i = 0; i < list.length; i++) if (list[i] && focusByKey(host, list[i], scroll)) return true;
    return false;
  }
  function focusByKey(host, key, scroll) {
    var list = host.querySelectorAll("[data-focus]");
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute("data-focus") !== key) continue;
      var el = list[i];
      tryCall(function () { el.focus({ preventScroll: !scroll }); });     // a plain refresh never scrolls the page
      return true;
    }
    return false;
  }

  // A row drags onto a folder (FEATURES L1.3) when this cache keeps folders: draggable + data-kind.
  function dragAttrs(attrs, kind) {
    if (hasFolders(cache())) { attrs["data-kind"] = kind; attrs.draggable = "true"; }
    return attrs;
  }

  function bookRow(c, counts) {
    var row = h("div", dragAttrs({ class: "lib-row lib-row--book", "data-id": c.id }, "book"));
    var nick = h("span", { class: "lib-row__nick", text: c.name || "Untitled" });
    var pen = h("button", { type: "button", class: "lib-row__pen", "data-focus": "row:" + c.id + ":pen", "aria-label": "Rename", title: "Rename", text: "✎" });
    pen.addEventListener("click", function () { startRename(row, c); });
    var main = h("div", { class: "lib-row__main" }, [
      h("div", { class: "lib-row__name" }, [nick, pen]),
      h("div", { class: "lib-row__meta", text: bookMeta(c, counts) })
    ]);
    var primary;
    if (c.hasBytes === false) {
      primary = h("button", { type: "button", class: "btn btn--primary", "data-focus": "row:" + c.id + ":primary", text: "Choose file again", title: "The PDF bytes are not in this browser" });
      primary.addEventListener("click", function () { chooseFileFor(c.id); });
    } else {
      primary = h("button", { type: "button", class: "btn btn--primary", "data-focus": "row:" + c.id + ":primary", text: "Continue reading" });
      primary.addEventListener("click", function (ev) { openBook(c.id, ev); });
    }
    var review = h("button", { type: "button", "data-focus": "row:" + c.id + ":review", text: "Review" });
    reviewLook(review, counts.due, "btn", "btn btn--ghost");
    review.addEventListener("click", function () { startReview("book", c.id); });
    var more = h("button", { type: "button", class: "btn btn--ghost lib-row__more", "data-focus": "row:" + c.id + ":more", "aria-haspopup": "menu", "aria-label": "More actions", text: "⋯" });
    more.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var items = [
        { label: "Rename", run: function () { startRename(row, c); } },
        { label: "Export…", run: function () { openExport({ scope: "collection", collectionId: c.id }); } },
        sendAllItem(c.id),
        moveItem("collection", c.id),
        { label: c.hasBytes === false ? "Choose file again" : "Replace file", run: function () { chooseFileFor(c.id); } }
      ];
      var cc = cache(), cur = (cc && typeof cc.collection === "function" && cc.collection(c.id)) || c;
      manualMarks(cur.sections).forEach(function (mark) {      // §14: "the book ⋯ menu lists marks with Remove"
        items.push({ label: markMenuLabel(mark, cur.pageLabels), run: function () { removeChapterMark(c.id, mark).catch(noop); } });
      });
      items.push({ label: "Delete", danger: true, run: function () { deleteCollection(c.id); } });
      openMenu(more, items, byId("library"));
    });
    row.appendChild(main);
    row.appendChild(h("div", { class: "lib-row__actions" }, [primary, review, more]));
    return row;
  }

  function deckRow(c, counts) {
    var row = h("div", dragAttrs({ class: "lib-row lib-row--deck", "data-id": c.id }, "deck"));
    var nick = h("span", { class: "lib-row__nick", text: c.name || "Untitled deck" });
    var pen = h("button", { type: "button", class: "lib-row__pen", "data-focus": "row:" + c.id + ":pen", "aria-label": "Rename", title: "Rename", text: "✎" });
    pen.addEventListener("click", function () { startRename(row, c); });
    var main = h("div", { class: "lib-row__main" }, [
      h("div", { class: "lib-row__name" }, [nick, pen]),
      h("div", { class: "lib-row__meta", text: deckMeta(counts) })
    ]);
    var open = h("button", { type: "button", class: "btn btn--primary", "data-focus": "row:" + c.id + ":primary", text: "Open" });
    open.addEventListener("click", function (ev) { go(ev, "deck", { collectionId: c.id }); });
    var review = h("button", { type: "button", "data-focus": "row:" + c.id + ":review", text: "Review" });
    reviewLook(review, counts.due, "btn", "btn btn--ghost");
    review.addEventListener("click", function () { startReview("deck", c.id); });
    var more = h("button", { type: "button", class: "btn btn--ghost lib-row__more", "data-focus": "row:" + c.id + ":more", "aria-haspopup": "menu", "aria-label": "More actions", text: "⋯" });
    more.addEventListener("click", function (ev) {
      ev.stopPropagation();
      openMenu(more, [
        { label: "Rename", run: function () { startRename(row, c); } },
        { label: "Export…", run: function () { openExport({ scope: "collection", collectionId: c.id }); } },
        sendAllItem(c.id),
        moveItem("collection", c.id),
        { label: "Delete", danger: true, run: function () { deleteCollection(c.id); } }
      ], byId("library"));
    });
    row.appendChild(main);
    row.appendChild(h("div", { class: "lib-row__actions" }, [open, review, more]));
    return row;
  }

  // D30: is this click a "new tab" click (Cmd held, Ctrl off the Mac) that M.tabs will take?
  function opensTab(ev) {
    return !!ev && !!M.tabs && typeof M.tabs.wantsTab === "function" && tryCall(function () { return M.tabs.wantsTab(ev); }) === true;
  }
  // A click that opens a place: a "new tab" click opens it in a new tab (→ true), any other click goes there as before.
  function go(ev, screen, params) {
    if (opensTab(ev)) { tryCall(function () { M.tabs.go(ev, screen, params); }); return true; }
    route(screen, params);
    return false;
  }

  function openBook(id, ev) {
    if (opensTab(ev)) { go(ev, "reader", { collectionId: id }); return; }   // only a tab is added: nothing is opened yet
    var c = cache(), col = c && typeof c.collection === "function" ? c.collection(id) : null;
    if (col && typeof c.saveCollection === "function") {
      col.lastOpenedAt = now();
      tryCall(function () { Promise.resolve(c.saveCollection(col)).catch(noop); });
    }
    route("reader", { collectionId: id });
  }

  function chooseFileFor(id) { openFilePicker(id); }

  // The hidden #fileInput. A replacement remembers its book until the picker reports a file ("change") or a dismissal
  // ("cancel"); a plain add clears it, so a stale "Replace file" never turns the next Add PDF into a replacement.
  function openFilePicker(replaceId) {
    st.pendingReplaceId = replaceId || null;
    if (M.store && typeof M.store.persist === "function") tryCall(function () { Promise.resolve(M.store.persist()).catch(noop); });
    var input = byId("fileInput");
    if (input) tryCall(function () { input.click(); });
  }

  function openExport(opts) {
    var ex = M.exporter;
    if (!ex || typeof ex.openDialog !== "function") { toast("Export is not available"); return; }
    tryCall(function () { ex.openDialog(opts || {}); });
  }

  // ------------------------------------------------------------------ Send all to Obsidian (BUILD-NOTES "Obsidian")

  // ⋯ › "Send all to Obsidian", after Export… in the book row, deck row and deck page menus: every live prompt of the
  // book or deck, each kind (highlights and notes too). Left out when M.obsidian has no sendAll, and while the Obsidian
  // connection is off (DECISIONS D32); disabled while the
  // collection has no live prompt, and while its send-all still runs ("Sending to Obsidian…").
  // DECISIONS D32: Settings › Obsidian › "Connect Marginalia to Obsidian" (M.obsidian.enabled()). While it is off,
  // the ⋯ menus have no "Send all to Obsidian" and Settings does not ask the server for vaults. An M.obsidian without that switch counts as on.
  function obsidianOn() {
    var O = M.obsidian;
    if (!O) return false;
    if (typeof O.enabled !== "function") return true;
    try { return O.enabled() === true; } catch (e) { return false; }
  }
  function sendAllItem(id) {
    var O = M.obsidian;
    if (!O || typeof O.sendAll !== "function" || typeof O.planAll !== "function" || !obsidianOn()) return null;
    var busy = typeof O.isSendingAll === "function" && tryCall(function () { return O.isSendingAll(id); }, false) === true;
    var n = livePromptCount(id);
    return { label: busy ? "Sending to Obsidian…" : "Send all to Obsidian", disabled: busy || !n,
      title: !busy && !n ? "Nothing in it to send yet" : null, run: function () { sendAllToObsidian(id).catch(noop); } };
  }
  function livePromptCount(id) {
    var c = cache();
    var list = c && typeof c.promptsOf === "function" ? tryCall(function () { return c.promptsOf(id); }, []) : [];
    return (Array.isArray(list) ? list : []).filter(live).length;
  }
  // FEATURES A9.1, as js/obsidian.js words it (heldLine): the cards an obsidian:// link holds back because a send of them
  // to Marginalia's server did not finish (their note may hold them already). outdated: an older serve.py answered.
  function heldText(n, outdated) {
    return plural(n, "card") + " may already be in Obsidian: a send to Marginalia's server did not finish. " +
      (outdated ? "Restart Marginalia (marginalia restart in Terminal)" : "Start Marginalia with the marginalia command") +
      " and send again: it checks the note and never adds a second copy.";
  }
  // The confirm of a send-all, from M.obsidian.planAll's answer: how many cards go, to which note, and what happens to
  // each (FEATURES A8). Server: "A new ones are added, U edited ones are updated in place and R whose last send did not
  // finish are updated in place, in <file>. K already there are skipped." (a part with no card is left out, the last
  // two parts joined by "and"; "one is" for one; R: planAll's rechecked, FEATURES A9.3). obsidian:// links: "They go to
  // <file>. K sent before are skipped: links can only add." (a link can only add, so an edited card is skipped too),
  // then, for planAll's held cards, the A9.1 line (heldText).
  function sendAllConfirm(plan) {
    var n = plan.count || 0, k = plan.sentBefore || 0;
    var files = Array.isArray(plan.files) && plan.files.length ? plan.files : [str(plan.file)];
    var where = files.length === 1 ? files[0] : files[0] + " and " + (files.length === 2 ? files[1] : plural(files.length - 1, "other note"));
    var body;
    if (plan.mode === "link") {
      body = (n === 1 ? "It goes to " : "They go to ") + where + ".";
      if (k) body += " " + k + " sent before " + (k === 1 ? "is" : "are") + " skipped: links can only add.";
      if (plan.tooLong) body += " Too long for an obsidian:// link: " + (n === 1 ? "it is" : "they are") + " copied for you to paste into the note.";
      if (plan.held) body += " " + heldText(plan.held, plan.outdated);
    } else {
      var u = plan.changed || 0, r = plan.rechecked || 0, a = isNum(plan.fresh) ? plan.fresh : Math.max(0, n - u - r);
      var same = plan.unchanged || 0, parts = [];
      if (a) parts.push(a + " new " + (a === 1 ? "one is" : "ones are") + " added");
      if (u) parts.push(u + " edited " + (u === 1 ? "one is" : "ones are") + " updated in place");
      if (r) parts.push(r + " whose last send did not finish " + (r === 1 ? "is" : "are") + " updated in place");
      var said = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts.join("");
      body = (said ? said + ", in " : (n === 1 ? "It goes to " : "They go to ")) + where + ".";
      if (same) body += " " + same + " already there " + (same === 1 ? "is" : "are") + " skipped.";
    }
    return { title: "Send " + plural(n, "card") + " to Obsidian?", body: body, ok: "Send", cancel: "Cancel", danger: false };
  }
  // The toast instead of a confirm when a send-all has nothing to send (planAll's count is 0): {text, detail}. Through a
  // link with held cards (A9.1), the held line is the text and the edited cards a link cannot update the detail.
  function sendAllNothing(plan, name) {
    var u = plan.changed || 0;
    if (!plan.total) return { text: "Nothing in “" + name + "” to send to Obsidian", detail: null };
    if (plan.mode === "link" && plan.held) {
      return { text: heldText(plan.held, plan.outdated),
        detail: u ? plural(u, "edited card") + " " + (u === 1 ? "was" : "were") + " not updated: links can only add." : null };
    }
    if (plan.mode === "link" && u) {
      return { text: "Nothing new to send — every card of “" + name + "” was sent before, and an obsidian:// link can only add",
        detail: plural(u, "edited card") + " " + (u === 1 ? "was" : "were") + " not updated. " +
          (plan.outdated ? "Restart Marginalia (marginalia restart in Terminal)" : "Start Marginalia with the marginalia command") +
          " to write silently and update in place." };
    }
    return { text: "Everything in “" + name + "” is already in Obsidian", detail: "Every card was sent before and none was edited since." };
  }
  // The menu item's action: M.obsidian.planAll, then the confirm, then M.obsidian.sendAll(id, {fromGesture: true})
  // (the click that confirms is the user gesture an obsidian:// link needs; M.obsidian toasts the result).
  // → Promise<sendAll's result | null> (null: nothing was sent — refused, nothing to send, or cancelled).
  function sendAllToObsidian(id) {
    var O = M.obsidian;
    if (!O || typeof O.sendAll !== "function" || typeof O.planAll !== "function") { toast("Obsidian is not available here"); return Promise.resolve(null); }
    if (st.sendAllAsking[id]) return Promise.resolve(null);        // the first click's confirm is on its way
    st.sendAllAsking[id] = true;
    var c = cache(), col = c && typeof c.collection === "function" ? c.collection(id) : null;
    var name = collapse(col && col.name) || (col && col.kind === "deck" ? "this deck" : "this book");
    function settle() { delete st.sendAllAsking[id]; }
    return tryPromise(function () { return O.planAll(id); }, "plan").then(function (plan) {
      if (!plan || !plan.ok) {
        settle();
        // an import is saving (FEATURES A10.1): no confirm, nothing sent; the words are M.obsidian's own
        if (plan && plan.importing) { toast(str(O.WAIT_IMPORT) || "Wait until the import finishes, then send again.", [], 8000, "obsidian"); return null; }
        // a browser page the desktop app replaced (FEATURES E2.2c): the app sends, never this page; M.obsidian's words
        if (plan && plan.covered) { toast(str(O.COVERED) || "Marginalia is now an app — open it to send to Obsidian.", [], 8000, "obsidian"); return null; }
        // the connection was switched off meanwhile (DECISIONS D32): M.obsidian's words
        if (plan && plan.off) { toast(str(O.OFF) || "The Obsidian connection is off — turn it on in Settings › Obsidian.", [], 8000, "obsidian"); return null; }
        toast(plan && plan.busy ? "Already sending “" + name + "” to Obsidian"
          : "Could not send to Obsidian — " + ((plan && plan.error) || "unexpected error"), [], 8000, "obsidian");
        return null;
      }
      if (!plan.count) {
        // nothing never sent and nothing edited since its send (or, through a link, nothing never sent): no confirm, no request
        settle();
        var none = sendAllNothing(plan, name);
        // the held line (FEATURES A9.1) stays 12 s, as everywhere else it is shown (repair A9-R7)
        toast(none.text, [], plan.mode === "link" && plan.held ? 12000 : 8000, "obsidian", null, none.detail);
        return null;
      }
      return confirm(sendAllConfirm(plan)).then(function (yes) {
        settle();
        return yes ? O.sendAll(id, { fromGesture: true }) : null;
      });
    }).then(null, function (e) {
      settle();
      toast("Could not send to Obsidian — " + ((e && e.message) || "unexpected error"), [], 8000, "obsidian");
      return null;
    });
  }

  // ------------------------------------------------------------------ popup menu (library + deck page)

  function closeMenu() {
    if (!st.menu) return;
    var m = st.menu;
    st.menu = null;
    try { document.removeEventListener("mousedown", m.onDown, true); } catch (e) { /* ignore */ }
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    if (m.anchor) m.anchor.setAttribute("aria-expanded", "false");
  }

  // items: [{label, run, danger?, disabled?, title?} | null] (null: an item this build leaves out)
  function openMenu(anchorBtn, items, container) {
    closeMenu();
    if (!container) return;
    var menu = h("div", { class: "lib-menu", role: "menu" });
    items.filter(Boolean).forEach(function (it) {
      var b = h("button", { type: "button", role: "menuitem", class: "lib-menu__item" + (it.danger ? " lib-menu__item--danger" : ""), text: it.label, title: it.title || null });
      b.disabled = !!it.disabled;
      b.addEventListener("click", function (ev) { ev.stopPropagation(); closeMenu(); it.run(anchorBtn); });
      menu.appendChild(b);
    });
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    var cr = container.getBoundingClientRect(), br = anchorBtn.getBoundingClientRect();
    menu.style.top = Math.max(0, br.bottom - cr.top + container.scrollTop + 4) + "px";
    menu.style.right = Math.max(8, cr.right - br.right) + "px";
    container.appendChild(menu);
    anchorBtn.setAttribute("aria-expanded", "true");
    menu.addEventListener("keydown", function (ev) {
      var btns = Array.prototype.slice.call(menu.querySelectorAll("button:not([disabled])"));
      var i = btns.indexOf(document.activeElement);
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenu(); tryCall(function () { anchorBtn.focus(); }); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); ev.stopPropagation(); if (btns.length) btns[(i + 1) % btns.length].focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); ev.stopPropagation(); if (btns.length) btns[(i - 1 + btns.length) % btns.length].focus(); }
      else if (ev.key === "Tab") closeMenu();
      else ev.stopPropagation();
    });
    var onDown = function (ev) { if (!menu.contains(ev.target) && ev.target !== anchorBtn) closeMenu(); };
    document.addEventListener("mousedown", onDown, true);
    st.menu = { el: menu, anchor: anchorBtn, onDown: onDown };
    var first = menu.querySelector("button:not([disabled])");
    if (first) tryCall(function () { first.focus(); });
  }

  // ------------------------------------------------------------------ inline rename + new deck

  function startRename(rowEl, c) {
    var nameEl = rowEl.querySelector(".lib-row__name");
    if (!nameEl || st.renaming) return;
    var input = h("input", { type: "text", class: "lib-rename", value: c.name || "", "aria-label": "Rename", maxlength: "80" });
    nameEl.classList.add("is-hidden");
    nameEl.parentNode.insertBefore(input, nameEl);
    var draggable = rowEl.getAttribute("draggable");
    if (draggable) rowEl.removeAttribute("draggable");       // a mouse selecting text in the field never drags the row
    st.renaming = true;
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var v = collapse(input.value);
      if (input.parentNode) input.parentNode.removeChild(input);
      nameEl.classList.remove("is-hidden");
      if (draggable) rowEl.setAttribute("draggable", draggable);
      st.renaming = false;
      if (commit && v && v !== c.name) renameCollection(c.id, v);
      else if (st.dirty) render();
    }
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(false); }
      else ev.stopPropagation();
    });
    input.addEventListener("blur", function () { finish(true); });
    tryCall(function () { input.focus(); input.select(); });
  }

  // The inline "New deck" and "New folder" fields (repair UI-1, 2026-11-11) are records {kind "deck"|"folder", row,
  // input, parentId (a "New folder inside"), composing, drop()} in st.newDeck / st.newFolder. A re-render keeps them:
  // render() puts the same row back into its slot (its text, caret and listeners stay) and gives focus back to the part
  // of it that had focus, so a chevron, a move, a rename or a refresh made while a field is up shows at once. A "New
  // folder inside" field whose folder is no longer open on screen (closed, moved into a closed folder, deleted) goes, as
  // Cancel would. Only an IME composition in a field holds a re-render back (until compositionend).
  function inlineFields() { return [st.newFolder, st.newDeck].filter(Boolean); }
  function fieldComposing() { return inlineFields().some(function (f) { return f.composing; }); }
  function fieldFocus(fields) {
    var a = hasDom() ? document.activeElement : null;
    for (var i = 0; a && i < fields.length; i++) {
      if (fields[i].row.contains(a)) return { el: a, start: tryCall(function () { return a.selectionStart; }, null), end: tryCall(function () { return a.selectionEnd; }, null) };
    }
    return null;
  }
  function giveFieldFocus(held) {
    var el = held.el;
    tryCall(function () { el.focus({ preventScroll: true }); });
    if (isNum(held.start) && isNum(held.end) && typeof el.setSelectionRange === "function") tryCall(function () { el.setSelectionRange(held.start, held.end); });
  }
  function fieldSlot(host, f) {
    if (f.kind === "deck") return host.querySelector(".lib__newdeck-slot");
    return f.parentId ? childWithClass(folderGroupEl(host, f.parentId), "lib-folder__body") : host.querySelector(".lib__newfolder-slot");
  }
  // → false when its place is not on screen (the field is gone then)
  function placeField(host, f) {
    var slot = fieldSlot(host, f);
    if (!slot) { f.drop(); return false; }
    if (f.kind === "folder" && f.parentId) slot.insertBefore(f.row, slot.firstChild); else slot.appendChild(f.row);
    return true;
  }
  function dropIfBlank(f) { if (f && !collapse(f.input.value)) f.drop(); }
  // keys (Enter makes, Esc drops; none reaches M.app), the IME composition, Create and Cancel
  function wireField(f, finish, create, cancel) {
    f.input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(false); }
      else ev.stopPropagation();
    });
    f.input.addEventListener("compositionstart", function () { f.composing = true; });
    f.input.addEventListener("compositionend", function () { f.composing = false; if (st.dirty && isVisible(byId("library"))) render(); });
    create.addEventListener("click", function () { finish(true); });
    cancel.addEventListener("click", function () { finish(false); });
  }

  function showNewDeckField() {
    var host = byId("library");
    var slot = host ? host.querySelector(".lib__newdeck-slot") : null;
    if (!slot) return;
    var up = st.newDeck;
    if (up) { tryCall(function () { up.input.focus(); }); return; }          // already up: back to it
    dropIfBlank(st.newFolder);                                               // a blank New folder field gives way
    var input = h("input", { type: "text", class: "lib-rename lib__newdeck-input", placeholder: "Deck name", "aria-label": "New deck name", maxlength: "80" });
    var create = h("button", { type: "button", class: "btn btn--primary", text: "Create" });
    var cancel = h("button", { type: "button", class: "btn btn--ghost", text: "Cancel" });
    var row = h("div", { class: "lib__newdeck" }, [input, create, cancel]);
    var field = { kind: "deck", row: row, input: input, parentId: null, composing: false, drop: function () { finish(false, true); } };
    var done = false;
    function finish(commit, quiet) {
      if (done) return;
      done = true;
      var v = collapse(input.value);
      if (row.parentNode) row.parentNode.removeChild(row);
      if (st.newDeck === field) st.newDeck = null;
      if (quiet) return;
      if (commit && v) {
        createDeck(v).then(function (c) { route("deck", { collectionId: c.id }); }, function () { toast("Could not create the deck"); });
      } else if (commit) {
        toast("Give the deck a name first");
        if (st.dirty) render();
      } else if (st.dirty) render();
    }
    wireField(field, finish, create, cancel);
    st.newDeck = field;
    slot.appendChild(row);
    tryCall(function () { input.focus(); });
  }

  // ------------------------------------------------------------------ folders (FEATURES L1; BUILD-NOTES "Library folders")

  var OPEN_KEY = "marginalia.openFolders";        // localStorage: the ids of the folders open on the home screen
  var DRAG_TYPE = "application/x-marginalia-item";
  var EMPTY_FOLDER = "Empty — drag books here or use Move to folder…";
  var collator = null;

  // A cache that keeps folders (M.cache's FEATURES L1 extension); without one the home screen is as it was.
  function hasFolders(c) {
    return !!c && typeof c.folders === "function" && typeof c.folderOf === "function" && typeof c.folderParent === "function";
  }

  // Folders by name: case-insensitive, numbers in natural order ("Ch 2" before "Ch 10"), then by id.
  function folderCompare(a, b) {
    if (!collator) {
      collator = tryCall(function () { return new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }); }, null) ||
        { compare: function (x, y) { x = x.toLowerCase(); y = y.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; } };
    }
    var ia = str(a && a.id), ib = str(b && b.id);
    return collator.compare(str(a && a.name), str(b && b.name)) || (ia < ib ? -1 : ia > ib ? 1 : 0);
  }

  // The home tree from `cols` (live, sorted as the rows are): {top: {folders, books, decks}, inside: Map(folderId →
  // {folders, books, decks})}, folders sorted by name. M.cache resolves where each folder and collection sits.
  function folderTree(c, cols) {
    var top = { folders: [], books: [], decks: [] }, inside = new Map(), foldered = hasFolders(c);
    function bucket(id) {
      if (id === null || id === undefined) return top;
      var b = inside.get(id);
      if (!b) { b = { folders: [], books: [], decks: [] }; inside.set(id, b); }
      return b;
    }
    if (foldered) {
      (tryCall(function () { return c.folders({ live: true }); }, []) || []).forEach(function (f) {
        if (f && live(f)) bucket(tryCall(function () { return c.folderParent(f.id); }, null)).folders.push(f);
      });
    }
    (cols || []).forEach(function (col) {
      if (col.kind !== "book" && col.kind !== "deck") return;
      var b = bucket(foldered ? tryCall(function () { return c.folderOf(col); }, null) : null);
      (col.kind === "deck" ? b.decks : b.books).push(col);
    });
    top.folders.sort(folderCompare);
    inside.forEach(function (b) { b.folders.sort(folderCompare); });
    return { top: top, inside: inside };
  }

  // A folder's counts with everything below it: {folders, books, decks, due} (due: cards due, as the rows count them).
  function folderTotals(tree, countsOf) {
    var memo = new Map();
    function total(id) {
      if (memo.has(id)) return memo.get(id);
      var b = tree.inside.get(id) || { folders: [], books: [], decks: [] };
      var t = { folders: b.folders.length, books: b.books.length, decks: b.decks.length, due: 0 };
      memo.set(id, t);
      b.books.concat(b.decks).forEach(function (col) { t.due += countsOf(col.id).due; });
      b.folders.forEach(function (f) {
        var s = total(f.id);
        t.folders += s.folders; t.books += s.books; t.decks += s.decks; t.due += s.due;
      });
      return t;
    }
    return total;
  }
  function folderMeta(t) {
    var parts = [];
    if (t.folders) parts.push(plural(t.folders, "folder"));
    parts.push(plural(t.books, "book"), plural(t.decks, "deck"), t.due + " due");
    return parts.join(" · ");
  }

  // Counts for this render: M.cache.countsBy (one pass over the prompts), else counts(id) once per row.
  function countsFor(c, t) {
    var zero = { prompts: 0, cards: 0, due: 0, nextDueAt: null, writtenToday: 0 };
    var by = c && typeof c.countsBy === "function" ? tryCall(function () { return c.countsBy(t); }, null) : null;
    var memo = new Map();
    return function (id) {
      if (by && typeof by.get === "function") return by.get(id) || zero;
      if (!memo.has(id)) memo.set(id, c && typeof c.counts === "function" ? c.counts(id, t) : zero);
      return memo.get(id);
    };
  }

  // A tab that is dragged (js/tabs.js, D31): the library is no place to drop it.
  function isTabDrag(ev) {
    var type = M.tabs && typeof M.tabs.TAB_TYPE === "string" ? M.tabs.TAB_TYPE : null;
    return tryCall(function () { return !!type && Array.prototype.indexOf.call(ev.dataTransfer.types || [], type) >= 0; }, false);
  }
  function isLocked() {
    var s = M.store;
    return !!(s && typeof s.locked === "function" && tryCall(function () { return s.locked(); }, null));
  }
  // D31 (the windows of the Mac app): a PDF that is added is work of several writes. keepRole(work): this window keeps
  // the writer role until the work has ended (M.store.during). ownRole() → Promise<boolean>: this window takes the role
  // (and reads the library as it is now) before the work compares the file with the library. Outside the Mac app
  // both do nothing.
  function keepRole(work) {
    var s = M.store;
    return s && typeof s.during === "function" ? s.during(work) : Promise.resolve(typeof work === "function" ? work() : work);
  }
  function ownRole() {
    var a = M.app;
    return a && typeof a.takeRole === "function" ? Promise.resolve(tryCall(function () { return a.takeRole(); }, true)) : Promise.resolve(true);
  }
  function otherWindow() {
    var s = M.store, l = s && typeof s.locked === "function" ? tryCall(function () { return s.locked(); }, null) : null;
    return !!l && l.reason === "window";
  }

  // Open folders: remembered in this browser (localStorage, every access in try/catch; only live folders are kept).
  function openSet() {
    if (st.openFolders) return st.openFolders;
    var ids = [];
    try {
      var raw = root.localStorage ? root.localStorage.getItem(OPEN_KEY) : null, v = raw ? JSON.parse(raw) : [];
      if (Array.isArray(v)) ids = v.filter(function (x) { return typeof x === "string" && x; });
    } catch (e) { ids = []; }
    st.openFolders = new Set(ids);
    return st.openFolders;
  }
  function isOpen(id) { return openSet().has(id); }
  function setOpen(id, open) {
    var set = openSet(), c = cache();
    if (open) set.add(id); else set.delete(id);
    if (isLocked()) return;                                      // a tab that stepped aside writes nothing
    var keep = [];
    set.forEach(function (fid) {
      var f = hasFolders(c) ? tryCall(function () { return c.folder(fid); }, null) : null;
      if (f && live(f)) keep.push(fid);
    });
    try { if (root.localStorage) root.localStorage.setItem(OPEN_KEY, JSON.stringify(keep)); } catch (e) { /* full or blocked: open for this page only */ }
  }
  // The chevron keeps focus through the rebuild (Safari does not focus a clicked button by itself).
  function toggleFolder(id) {
    setOpen(id, !isOpen(id));
    if (!st.focusKey) st.focusKey = "folder:" + id + ":toggle";
    render();
  }

  function childWithClass(el, cls) {
    var kids = el ? el.childNodes : [];
    for (var i = 0; i < kids.length; i++) if (kids[i].nodeType === 1 && kids[i].classList.contains(cls)) return kids[i];
    return null;
  }
  function folderGroupEl(host, id) {
    var list = host ? host.querySelectorAll(".lib-folder") : [];
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute("data-folder") === id) return list[i];
    return null;
  }

  // One folder: its row, then (open) its sub-folders, books and decks, indented. The group is the drop target.
  function folderGroup(f, tree, totals, countsOf) {
    var open = isOpen(f.id), t = totals(f.id);
    var group = h("div", { class: "lib-folder" + (open ? " lib-folder--open" : ""), "data-folder": f.id, "data-drop": f.id });
    group.appendChild(folderRow(f, t, open));
    if (open) {
      var b = tree.inside.get(f.id) || { folders: [], books: [], decks: [] };
      var body = h("div", { class: "lib-folder__body", role: "group", "aria-label": f.name || "Untitled folder" });
      b.folders.forEach(function (sub) { body.appendChild(folderGroup(sub, tree, totals, countsOf)); });
      b.books.forEach(function (col) { body.appendChild(bookRow(col, countsOf(col.id))); });
      b.decks.forEach(function (col) { body.appendChild(deckRow(col, countsOf(col.id))); });
      if (!b.folders.length && !b.books.length && !b.decks.length) body.appendChild(h("div", { class: "lib-folder__empty", text: EMPTY_FOLDER }));
      group.appendChild(body);
    }
    return group;
  }

  var FOLDER_ICON = '<svg class="lib-folder__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z"/></svg>';

  function folderRow(f, t, open) {
    var row = h("div", { class: "lib-row lib-row--folder", "data-id": f.id, "data-kind": "folder", draggable: "true" });
    var name = f.name || "Untitled folder";
    var toggle = h("button", { type: "button", class: "lib-folder__toggle", "data-focus": "folder:" + f.id + ":toggle",
      "aria-expanded": open ? "true" : "false", title: open ? "Close folder" : "Open folder" }, [
      h("span", { class: "lib-folder__chevron", "aria-hidden": "true", text: open ? "▾" : "▸" }),
      h("span", { class: "lib-folder__glyph", "aria-hidden": "true", html: FOLDER_ICON }),
      h("span", { class: "lib-row__nick", text: name })
    ]);
    toggle.addEventListener("click", function () { toggleFolder(f.id); });
    var main = h("div", { class: "lib-row__main" }, [
      h("div", { class: "lib-row__name" }, [toggle]),
      h("div", { class: "lib-row__meta", text: folderMeta(t) })
    ]);
    // L1.5: the due count of everything in it; never disabled (with nothing due the review overlay says so)
    var review = h("button", { type: "button", "data-focus": "folder:" + f.id + ":review", text: "Review · " + t.due + " due" });
    reviewLook(review, t.due, "btn", "btn btn--ghost");
    review.addEventListener("click", function () { startReview("folder", f.id); });
    var more = h("button", { type: "button", class: "btn btn--ghost lib-row__more", "data-focus": "folder:" + f.id + ":more", "aria-haspopup": "menu",
      "aria-label": "More actions for the folder", text: "⋯" });
    more.addEventListener("click", function (ev) {
      ev.stopPropagation();
      openMenu(more, [
        { label: "Rename", run: function () { startFolderRename(row, f); } },
        { label: "New folder inside", run: function () { showNewFolderField(f.id); } },
        moveItem("folder", f.id),
        { label: "Delete", danger: true, run: function () { deleteFolder(f.id).catch(noop); } }
      ], byId("library"));
    });
    row.appendChild(main);
    row.appendChild(h("div", { class: "lib-row__actions" }, [review, more]));
    return row;
  }

  // "New folder" (header) and "New folder inside" (a folder's ⋯): the inline field at the end of FOLDERS, or at the top
  // of the (opened) folder. Enter or Create makes it; Esc or Cancel drops it. With the field already up it moves to the
  // place asked for, with what was typed in it (repair UI-1); a blank "New deck" field gives way.
  function showNewFolderField(parentId) {
    var host = byId("library"), c = cache();
    if (!host || st.renaming) return false;
    if (!hasFolders(c) || typeof c.createFolder !== "function") { toast("Folders are not available here"); return false; }
    parentId = parentId || null;
    dropIfBlank(st.newDeck);
    var field = st.newFolder;
    if (field) field.parentId = parentId;
    else {
      var input = h("input", { type: "text", class: "lib-rename lib__newfolder-input", placeholder: "Folder name", maxlength: "80" });
      var create = h("button", { type: "button", class: "btn btn--primary", text: "Create" });
      var cancel = h("button", { type: "button", class: "btn btn--ghost", text: "Cancel" });
      var row = h("div", { class: "lib__newfolder" }, [input, create, cancel]);
      var done = false;
      var finish = function (commit, quiet) {
        if (done) return;
        done = true;
        var v = collapse(input.value), into = field.parentId;
        if (row.parentNode) row.parentNode.removeChild(row);
        if (st.newFolder === field) st.newFolder = null;
        if (quiet) return;
        if (commit && v) {
          createFolder(v, into).catch(function (e) {
            if (!e || e.code !== "locked") toast("Could not create the folder");
            if (st.dirty) render();
          });
        } else if (commit) {
          toast("Give the folder a name first");
          if (st.dirty) render();
        } else if (st.dirty) render();
      };
      field = { kind: "folder", row: row, input: input, parentId: parentId, composing: false, drop: function () { finish(false, true); } };
      wireField(field, finish, create, cancel);
      st.newFolder = field;
    }
    field.input.setAttribute("aria-label", parentId ? "Name of the new folder inside" : "New folder name");
    var rendered = false;
    if (parentId && !isOpen(parentId)) { setOpen(parentId, true); rendered = render(); }   // render() puts the field in it
    if (!rendered && st.newFolder === field) placeField(host, field);
    if (st.newFolder !== field) return false;          // its place is not on screen (a folder inside a closed one)
    tryCall(function () { field.input.focus(); });
    return true;
  }

  // → Promise<Folder>. A new folder opens, so its "Empty — …" line shows how to fill it; focus lands on it.
  function createFolder(name, parentId) {
    var c = cache();
    if (!hasFolders(c) || typeof c.createFolder !== "function") return Promise.reject(err("no_cache", "Folders are not available"));
    return tryPromise(function () { return c.createFolder(name, parentId || null); }, "no_cache").then(function (f) {
      setOpen(f.id, true);
      st.focusKey = "folder:" + f.id + ":toggle";
      if (isVisible(byId("library"))) render(); else st.dirty = true;
      return f;
    });
  }

  function renameFolder(id, name) {
    var c = cache();
    if (!hasFolders(c) || typeof c.renameFolder !== "function") return Promise.reject(err("no_cache", "Folders are not available"));
    return tryPromise(function () { return c.renameFolder(id, name); }, "no_cache");
  }

  function startFolderRename(rowEl, f) {
    var nameEl = rowEl.querySelector(".lib-row__name");
    if (!nameEl || st.renaming) return;
    var input = h("input", { type: "text", class: "lib-rename", value: f.name || "", "aria-label": "Rename folder", maxlength: "80" });
    nameEl.classList.add("is-hidden");
    nameEl.parentNode.insertBefore(input, nameEl);
    rowEl.removeAttribute("draggable");
    st.renaming = true;
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var v = collapse(input.value);
      if (input.parentNode) input.parentNode.removeChild(input);
      nameEl.classList.remove("is-hidden");
      rowEl.setAttribute("draggable", "true");
      st.renaming = false;
      if (commit && v && v !== f.name) {
        renameFolder(f.id, v).then(null, function (e) {
          if (!e || e.code !== "locked") toast("Could not rename the folder");
          if (st.dirty) render();
        });
      } else if (st.dirty) render();
    }
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(false); }
      else ev.stopPropagation();
    });
    input.addEventListener("blur", function () { finish(true); });
    tryCall(function () { input.focus(); input.select(); });
  }

  // L1.4: confirm, then the folder goes and what was in it moves up one level; nothing else is deleted. The toast
  // offers Undo (and Z, as a book's delete does): the folder comes back with what is still where the delete put it.
  function deleteFolder(id) {
    var c = cache();
    if (!hasFolders(c) || typeof c.removeFolder !== "function") return Promise.resolve(false);
    var f = c.folder(id);
    if (!f || !live(f)) return Promise.resolve(false);
    var name = f.name || "Untitled folder", parent = c.folderParent(id), pf = parent ? c.folder(parent) : null;
    var where = pf ? "“" + (pf.name || "Untitled folder") + "”" : "the top level";
    return confirm({
      title: "Delete folder “" + name + "”?",
      body: "Its books, decks and folders move to " + where + ". Nothing else is deleted.",
      ok: "Delete folder", cancel: "Cancel", danger: true
    }).then(function (ok) {
      if (!ok) return false;
      st.focusKey = [parent ? "folder:" + parent + ":toggle" : "new-folder"];
      return tryPromise(function () { return c.removeFolder(id); }, "no_cache").then(function (r) {
        var u = { id: id, name: name, isBook: false, until: now() + UNDO_TTL_MS, handle: null, restore: null };
        u.restore = function () {
          tryPromise(function () { return c.restoreFolder(id, r); }, "no_cache").then(function () {
            toast("Restored the folder “" + name + "”");
          }, function (e) { if (!e || e.code !== "locked") toast("Could not restore the folder"); });
        };
        st.undo = u;
        u.handle = toast("Deleted the folder “" + name + "” · Undo (Z)", [{ label: "Undo", run: function () { runUndo(u); } }], UNDO_TTL_MS,
          "folder-deleted", function () { if (st.undo === u) st.undo = null; });
        return true;
      }, function (e) {
        st.focusKey = null;
        if (!e || e.code !== "locked") toast("Could not delete the folder");
        return false;
      });
    });
  }

  function itemName(kind, id) {
    var c = cache();
    if (kind === "folder") {
      var f = hasFolders(c) ? tryCall(function () { return c.folder(id); }, null) : null;
      return (f && f.name) || "Untitled folder";
    }
    var col = c && typeof c.collection === "function" ? tryCall(function () { return c.collection(id); }, null) : null;
    return (col && col.name) || (col && col.kind === "deck" ? "Untitled deck" : "Untitled");
  }
  function placeName(folderId) {
    if (folderId === null || folderId === undefined) return "the top level";
    var c = cache(), f = hasFolders(c) ? tryCall(function () { return c.folder(folderId); }, null) : null;
    return "“" + ((f && f.name) || "Untitled folder") + "”";
  }
  function currentPlace(kind, id) {
    var c = cache();
    if (!hasFolders(c)) return null;
    return tryCall(function () { return kind === "folder" ? c.folderParent(id) : c.folderOf(id); }, null);
  }

  // The picker's entries (L1.3): "No folder (top level)", then every live folder as an indented tree (by name);
  // current: where the item is now; disabled: a folder's own subtree (it can never go inside itself).
  function pickerEntries(kind, id) {
    var c = cache(), tree = folderTree(c, []), here = currentPlace(kind, id), banned = new Set();
    if (kind === "folder") {
      banned.add(id);
      var m = typeof c.folderMembers === "function" ? tryCall(function () { return c.folderMembers(id); }, null) : null;
      ((m && m.folders) || []).forEach(function (fid) { banned.add(fid); });
    }
    var out = [{ target: null, label: "No folder (top level)", depth: 0, current: here === null, disabled: false }];
    (function walk(list, depth) {
      list.forEach(function (f) {
        out.push({ target: f.id, label: f.name || "Untitled folder", depth: depth, current: here === f.id, disabled: banned.has(f.id) });
        var b = tree.inside.get(f.id);
        if (b && b.folders.length) walk(b.folders, depth + 1);
      });
    })(tree.top.folders, 0);
    return out;
  }

  // "Move to folder…" in a ⋯ menu; null without folders in the cache. Disabled when there is nowhere else to go.
  function moveItem(kind, id) {
    var c = cache();
    if (!hasFolders(c) || typeof c.moveCollection !== "function" || typeof c.moveFolder !== "function") return null;
    var somewhere = pickerEntries(kind, id).some(function (e) { return !e.disabled && !e.current; });
    return { label: "Move to folder…", disabled: !somewhere,
      title: somewhere ? null : (kind === "folder" ? "There is no other folder to move it into" : "No folders yet — make one with New folder"),
      run: function (anchor) { openPicker(kind, id, anchor); } };
  }

  // The picker: a dialog on document.body (the .dialog frame), so a home re-render never takes it away. Arrow keys,
  // Home / End and Tab stay inside it, Esc or a click outside closes it, and no key reaches M.app's routing meanwhile.
  // Focus goes back to the ⋯ that opened it, found again by its data-focus key when a re-render replaced that button
  // (repair UI-3). Opened from the home screen, a move lands focus on the moved row (moveTo {focus}); opened elsewhere
  // (the deck page), focus goes back to its ⋯ and the move sets no landing for a later home render (repair UI-2).
  function openPicker(kind, id, invoker) {
    if (!hasDom() || !hasFolders(cache())) return false;
    closePicker(true);
    var entries = pickerEntries(kind, id), name = itemName(kind, id);
    var back = invoker && typeof invoker.focus === "function" ? invoker : document.activeElement;
    var screen = back && typeof back.closest === "function" ? back.closest("#library, #deck") : null;
    var home = !!screen && screen.id === "library";
    var title = h("h2", { class: "dialog__title", id: "libPickerTitle", text: "Move “" + name + "” to…" });
    var close = h("button", { type: "button", class: "btn btn--ghost dialog__close", "aria-label": "Close", text: "✕" });
    var list = h("div", { class: "lib-picker__list", role: "menu", "aria-labelledby": "libPickerTitle" });
    entries.forEach(function (e) {
      var b = h("button", { type: "button", role: "menuitemradio", class: "lib-picker__item" + (e.target === null ? " lib-picker__item--top" : ""),
        "aria-checked": e.current ? "true" : "false", "data-target": e.target === null ? "" : e.target,
        title: e.disabled ? "A folder cannot go inside itself" : null }, [
        h("span", { class: "lib-picker__name", text: e.label }),
        e.current ? h("span", { class: "lib-picker__here", text: "current" }) : null
      ]);
      b.disabled = !!e.disabled;
      b.style.paddingLeft = (12 + 20 * e.depth) + "px";
      b.addEventListener("click", function () {
        closePicker(home && !e.current);
        if (!e.current) moveTo(kind, id, e.target, home ? { focus: true } : null);
      });
      list.appendChild(b);
    });
    var panel = h("div", { class: "dialog__panel lib-picker__panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "libPickerTitle" }, [
      h("div", { class: "dialog__head" }, [title, close]), list
    ]);
    var el = h("div", { class: "dialog lib-picker" }, [panel]);
    close.addEventListener("click", function () { closePicker(); });
    el.addEventListener("click", function (ev) { if (ev.target === el) closePicker(); });
    el.addEventListener("keydown", function (ev) { pickerKey(ev, el); });
    document.body.appendChild(el);
    var key = back && typeof back.getAttribute === "function" ? back.getAttribute("data-focus") : null;
    st.picker = { el: el, invoker: back, key: key, screen: screen, kind: kind, id: id };
    var first = list.querySelector("[aria-checked=\"true\"]:not([disabled])") || list.querySelector("button:not([disabled])");
    if (first) tryCall(function () { first.focus(); });
    return true;
  }
  function closePicker(keepFocus) {
    var p = st.picker;
    if (!p) return false;
    st.picker = null;
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    if (keepFocus || !hasDom()) return true;
    if (p.invoker && document.contains(p.invoker)) tryCall(function () { p.invoker.focus(); });
    else if (p.key && p.screen && isVisible(p.screen)) focusByKey(p.screen, p.key, false);   // the same ⋯ after a re-render
    return true;
  }
  function pickerKey(ev, el) {
    var all = Array.prototype.slice.call(el.querySelectorAll("button:not([disabled])"));
    var items = all.filter(function (b) { return b.classList.contains("lib-picker__item"); });
    var a = document.activeElement, i = items.indexOf(a), key = ev.key;
    var go = function (b) { ev.preventDefault(); if (b) tryCall(function () { b.focus(); }); };
    if (key === "Escape") { ev.preventDefault(); closePicker(); }
    else if (key === "ArrowDown") go(items[(i + 1) % items.length]);
    else if (key === "ArrowUp") go(items[i <= 0 ? items.length - 1 : i - 1]);
    else if (key === "Home") go(items[0]);
    else if (key === "End") go(items[items.length - 1]);
    else if (key === "Tab") {
      var j = all.indexOf(a), n = all.length;
      go(all[ev.shiftKey ? (j <= 0 ? n - 1 : j - 1) : (j < 0 || j >= n - 1 ? 0 : j + 1)]);
    }
    ev.stopPropagation();                  // nothing reaches M.app's document listener while the picker is up
  }

  // Moves a book, deck ("collection") or folder into `target` (a folder id, or null: the top level); the toast offers
  // Undo. opts.focus (the picker's keyboard path): focus lands on the moved row, else on the folder it went into, else
  // on the nearest folder above that one that is on screen.
  function moveTo(kind, id, target, opts) {
    var c = cache();
    if (!hasFolders(c)) return Promise.resolve(null);
    var name = itemName(kind, id), keysToTry = null;
    if (opts && opts.focus) {
      keysToTry = [(kind === "folder" ? "folder:" : "row:") + id + ":more"];
      var up = target && typeof c.folderPath === "function" ? (tryCall(function () { return c.folderPath(target); }, []) || []).slice().reverse() : [];
      up.forEach(function (fid) { keysToTry.push("folder:" + fid + ":toggle"); });
      st.focusKey = keysToTry;
    }
    return tryPromise(function () { return kind === "folder" ? c.moveFolder(id, target) : c.moveCollection(id, target); }, "move").then(function (r) {
      if (!r || r.moved === false) { if (st.focusKey === keysToTry) st.focusKey = null; return r || null; }
      toast("Moved “" + name + "” to " + placeName(target), [{ label: "Undo", run: function () { undoMove(kind, id, name, r.from); } }],
        UNDO_TTL_MS, "folder-move");
      return r;
    }, function (e) {
      if (st.focusKey === keysToTry) st.focusKey = null;
      if (e && e.code === "locked") return null;
      var why = moveRefusal(e, kind, id, target, name);
      toast(e && e.code === "cycle" ? "A folder cannot go inside itself" : "Could not move “" + name + "”" + (why ? " — " + why : ""),
        [], 6000, "folder-move");
      return null;
    });
  }
  function undoMove(kind, id, name, from) {
    var c = cache();
    return tryPromise(function () { return kind === "folder" ? c.moveFolder(id, from) : c.moveCollection(id, from); }, "move").then(function (r) {
      if (r && r.moved) toast("Moved “" + name + "” back to " + placeName(from), [], 4000, "folder-move");
      return r;
    }, function (e) {
      var why = moveRefusal(e, kind, id, from, name, true);
      if (!e || e.code !== "locked") toast("Could not undo the move" + (why ? " — " + why : ""), [], 6000, "folder-move");
      return null;
    });
  }
  // Why M.cache refused a move or its Undo, in words (repair UI-5): "not_found" means the item or the folder it was to
  // go to was deleted meanwhile (a toast never shows a record id); other refusals keep their own message.
  function moveRefusal(e, kind, id, to, name, back) {
    if (!e || e.code !== "not_found") return e && e.message ? e.message : "";
    var c = cache();
    var rec = kind === "folder" ? (hasFolders(c) ? tryCall(function () { return c.folder(id); }, null) : null)
      : (c && typeof c.collection === "function" ? tryCall(function () { return c.collection(id); }, null) : null);
    if (!rec || !live(rec)) return "“" + name + "” was deleted";
    var f = to && hasFolders(c) ? tryCall(function () { return c.folder(to); }, null) : null;
    var place = f && f.name ? "the folder “" + f.name + "”" : (back ? "the folder it came from" : "that folder");
    return place + " was deleted";
  }

  // ---- drag and drop (L1.3): a book, deck or folder row onto a folder (its group: the row or its open contents) or
  // onto the top-level sections. Same rules as the picker; Esc (or a drop anywhere else) cancels; a folder dragged over
  // itself or its own sub-folders finds no drop target.
  function isFileDrag(ev) {
    var t = ev && ev.dataTransfer && ev.dataTransfer.types;
    if (!t) return false;
    for (var i = 0; i < t.length; i++) if (t[i] === "Files") return true;
    return false;
  }
  // The element an event is about (a text node, as some browsers report for drags over text, means its parent).
  function elementOf(t) { return t && t.nodeType === 3 ? t.parentNode : t; }
  function onItemDragStart(ev) {
    var t = elementOf(ev && ev.target), row = t && typeof t.closest === "function" ? t.closest("[data-kind][draggable]") : null;
    var kind = row ? row.getAttribute("data-kind") : null, id = row ? row.getAttribute("data-id") : null;
    if (!row || !id || (kind !== "folder" && kind !== "book" && kind !== "deck") || !hasFolders(cache())) return;
    closeMenu();
    st.drag = { kind: kind === "folder" ? "folder" : "collection", id: id, row: row };
    try {
      var dt = ev.dataTransfer;
      if (dt) {
        dt.effectAllowed = "move";
        dt.setData(DRAG_TYPE, st.drag.kind + ":" + id);
        dt.setData("text/plain", itemName(st.drag.kind, id));
      }
    } catch (e) { /* the drag goes on without data */ }
    row.classList.add("lib-row--dragging");
  }
  function dropTargetOf(ev) {
    var t = elementOf(ev && ev.target), el = t && typeof t.closest === "function" ? t.closest("[data-drop]") : null, host = byId("library");
    if (!el || !host || !host.contains(el)) return null;
    var v = el.getAttribute("data-drop");
    return { el: el, folderId: v ? v : null };
  }
  function canDrop(drag, folderId) {
    var c = cache();
    if (!drag || !hasFolders(c)) return false;
    if (folderId !== null) {
      var f = tryCall(function () { return c.folder(folderId); }, null);
      if (!f || !live(f)) return false;
    }
    if (drag.kind === "folder") {
      if (folderId === drag.id) return false;
      if (folderId !== null && typeof c.folderPath === "function" && c.folderPath(folderId).indexOf(drag.id) >= 0) return false;
    }
    return currentPlace(drag.kind, drag.id) !== folderId;
  }
  function setDropOver(el) {
    if (st.dropOver === el) return;
    if (st.dropOver) st.dropOver.classList.remove("lib-drop--over");
    st.dropOver = el || null;
    if (el) el.classList.add("lib-drop--over");
  }
  function onItemDragOver(ev) {
    var t = dropTargetOf(ev), dt = ev.dataTransfer;
    if (!t || !canDrop(st.drag, t.folderId)) {
      setDropOver(null);
      try { if (dt) dt.dropEffect = "none"; } catch (e) { /* read-only in some browsers */ }
      return;
    }
    ev.preventDefault();
    try { if (dt) dt.dropEffect = "move"; } catch (e) { /* read-only in some browsers */ }
    setDropOver(t.el);
  }
  function onItemDrop(ev) {
    ev.preventDefault();
    var d = st.drag, t = dropTargetOf(ev);
    var ok = !!t && canDrop(d, t.folderId);
    endDrag();
    if (ok) moveTo(d.kind, d.id, t.folderId);
  }
  function endDrag() {
    var d = st.drag;
    setDropOver(null);
    if (!d) return;
    st.drag = null;
    if (d.row) d.row.classList.remove("lib-row--dragging");
    if (st.dirty && isVisible(byId("library"))) render();
  }
  function onDragKey(ev) {
    if (!st.drag || !ev || ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    endDrag();
  }

  // ------------------------------------------------------------------ storage footer

  function storageLine(e) {
    if (!e || !isNum(e.usage)) return "Storage usage unknown";
    var s = fmtBytes(e.usage) + " used";
    if (isNum(e.quota) && e.quota > 0) s += " of " + fmtBytes(e.quota);
    if (e.persisted === true) s += " · persistent";
    else if (e.persisted === false) s += " · not persistent";
    return s;
  }
  function renderStorage(el) {
    var store = M.store;
    if (!store || typeof store.estimate !== "function") { el.textContent = "Storage usage unknown"; return; }
    var mode = typeof store.mode === "function" ? tryCall(function () { return store.mode(); }, null) : null;
    Promise.resolve(tryCall(function () { return store.estimate(); }, null)).then(function (e) {
      if (!document.contains(el)) return;
      var text = storageLine(e);
      if (mode === "memory") text = "Storage unavailable in this view — export often";
      el.textContent = text;
      if (isSafari() && mode !== "memory") el.appendChild(h("span", { class: "lib__storage-note", text: " · Safari may evict data after 7 days without a visit — export regularly" }));
    }, function () { if (document.contains(el)) el.textContent = "Storage usage unknown"; });
  }

  // ------------------------------------------------------------------ "Preparing document…" bar

  function showPrep(text) {
    if (!hasDom()) return;
    if (!st.prep) {
      var label = h("span", { class: "lib-prep__text" });
      st.prep = { el: h("div", { class: "lib-prep", role: "status", "aria-live": "polite" }, [label, h("div", { class: "lib-prep__bar" })]), label: label };
      document.body.appendChild(st.prep.el);
    }
    st.prep.label.textContent = text || "Preparing document…";
  }
  function hidePrep() {
    if (!st.prep) return;
    if (st.prep.el.parentNode) st.prep.el.parentNode.removeChild(st.prep.el);
    st.prep = null;
  }

  // ------------------------------------------------------------------ Add PDF (§3, §11)

  function hashBytes(u8) {
    var u = dep("util");
    return tryPromise(function () { return u.sha256(u8); }, "no_subtle")
      .then(function (hex) { return { hex: hex, algo: "sha-256" }; }, function () { return { hex: u.fnv1a(u8), algo: "fnv1a" }; });
  }

  function parseDoc(ctx) {
    var pv = M.pdfview;
    if (!pv || typeof pv.open !== "function") return Promise.reject(err("no_pdfjs", "PDF engine not loaded — reload when online"));
    // M.pdfview holds one document: the metadata open below replaces whatever the reader has open. Leave the
    // reader first (M.app.route → M.reader.close) so it never keeps a dead document after a cancelled or failed add.
    var leaveReader = Promise.resolve();
    if (isVisible(byId("reader")) && M.app && typeof M.app.route === "function") {
      leaveReader = Promise.resolve(tryCall(function () { return M.app.route("library", {}); }, null)).catch(noop);
    }
    var readerWasShown = false;
    function closeDoc() {
      // A book opened in the reader meanwhile has replaced this document in M.pdfview (its open closed ours): keep it.
      if (!readerWasShown && isVisible(byId("reader"))) return Promise.resolve();
      return Promise.resolve(tryCall(function () { return pv.close(); }, null)).catch(noop);
    }
    return leaveReader.then(function () {
      readerWasShown = isVisible(byId("reader"));
      st.parsing = true;
      // Metadata only, so NO container: M.pdfview mounts no pages, and a password-protected file gets its in-page
      // password panel on document.body (in a detached container nobody could see it and the add would wait
      // forever). The panel's Cancel rejects (code "password", see openError), which reportAddError explains.
      return pv.open(ctx.bytes.slice(), {});
    }).then(function (doc) {
      st.parsing = false;
      if (st.prep) showPrep("Preparing document…");          // back from "Enter the PDF’s password…"
      ctx.numPages = isNum(doc && doc.numPages) ? doc.numPages : 0;
      ctx.fingerprint = fingerprintOf(doc);
      ctx.info = doc && doc.info && typeof doc.info === "object" ? doc.info : {};
      ctx.pageLabels = doc && Array.isArray(doc.pageLabels) ? doc.pageLabels.slice() : null;
      var outlineP = doc && typeof doc.outline === "function" ? tryCall(function () { return doc.outline(); }, null)
        : (typeof pv.outline === "function" ? tryCall(function () { return pv.outline(); }, null) : null);
      var resolve = doc && typeof doc.resolvePageIndex === "function" ? function (d) { return doc.resolvePageIndex(d); }
        : (typeof pv.resolvePageIndex === "function" ? function (d) { return pv.resolvePageIndex(d); } : function () { return Promise.resolve(null); });
      return Promise.resolve(outlineP).catch(function () { return null; }).then(function (outline) {
        if (!Array.isArray(outline) || !outline.length) return [];
        var cx = dep("context");
        return Promise.resolve(cx.sectionsFromOutline(outline, resolve)).catch(function () { return []; });
      }).then(function (sections) {
        ctx.sections = sections || [];
        return closeDoc();
      }, function (e) {
        return closeDoc().then(function () { throw e; });
      });
    }, function (e) {
      st.parsing = false;
      throw openError(e);
    });
  }

  // M.pdfview.open rejects with its codes ("password", "invalid", …), but a PDF.js PasswordException reaches us
  // unmapped (it carries PDF.js's own numeric code: 1 when the password panel is cancelled): name it like M.pdfview does.
  function openError(e) {
    if (e && typeof e.code === "string" && e.code) return e;
    var out = err(e && e.name === "PasswordException" ? "password" : "invalid", (e && e.message) || "The PDF could not be opened");
    out.cause = e;
    return out;
  }

  // After "Replace file, keep prompts": quoted passages wait to be re-found; free notes keep their place (lostAfterReplace).
  function markAnchorsLost(collectionId, pageCount) {
    var c = cache();
    if (!c || typeof c.promptsOf !== "function") return Promise.resolve();
    var chain = Promise.resolve();
    c.promptsOf(collectionId).forEach(function (p) {
      if (!live(p) || !p.anchor || typeof p.anchor !== "object") return;
      var lost = lostAfterReplace(p.anchor, pageCount);
      if ((p.anchor.lost === true) === lost) return;
      p.anchor.lost = lost;
      chain = chain.then(function () { return Promise.resolve(c.savePrompt(p, { content: true })).catch(noop); });
    });
    return chain;
  }

  function warnIfTight(bytes) {
    var store = M.store;
    if (!store || typeof store.estimate !== "function") return Promise.resolve();
    return Promise.resolve(tryCall(function () { return store.estimate(); }, null)).then(function (e) {
      if (e && isNum(e.quota) && isNum(e.usage) && e.quota - e.usage < 1.2 * bytes) {
        toast("Storage is nearly full — this PDF may not fit (" + fmtBytes(e.quota - e.usage) + " free)", [
          { label: "Export", run: function () { openExport({ scope: "all" }); } }
        ], 8000, "storage-tight");
      }
    }, noop);
  }

  // Repair B9-R1 / LIB-1 (2026-11-11). M.store.docs.saveDocument writes a book's record and chunks in ONE transaction,
  // and whatever happens to that book meanwhile (Rename, Move to folder… or a drag, Delete and its Undo, an Import that
  // merges it) changes M.cache's record at once and queues its own store write behind that transaction. So the record
  // written once the PDF is stored is the book as M.cache holds it THEN, never the copy handed to the store (that copy
  // would undo the move or the rename, or bring a deleted book back as a live row whose chunks its delete removed). A
  // delete seen while the PDF is stored (bus "collection:deleted"; its transaction removes the chunks this one wrote,
  // and its Undo brings the book back without them) leaves the book as the delete and the Undo made it: nothing more is
  // written, and the caller hears code "changed".
  function watchDelete(id) {
    var seen = { deleted: false, stop: noop }, bus = M.bus || tryDep("bus");
    if (bus && typeof bus.on === "function") {
      var off = tryCall(function () { return bus.on("collection:deleted", function (e) { if (e && e.collectionId === id) seen.deleted = true; }); }, null);
      if (typeof off === "function") seen.stop = off;
    }
    return seen;
  }
  // What saveDocument adds to a record: its size, its chunks and hasBytes (nothing else of the copy it was given).
  function storageFields(saved, size) {
    var out = { byteLength: saved && isNum(saved.byteLength) ? saved.byteLength : size, hasBytes: true };
    ["chunkCount", "chunkSize"].forEach(function (k) { if (saved && isNum(saved[k])) out[k] = saved[k]; });
    return out;
  }
  // p, with the watch stopped once p settles (resolved or rejected).
  function watched(watch, p) {
    return p.then(function (v) { watch.stop(); return v; }, function (e) { watch.stop(); throw e; });
  }

  // Writes record + bytes (one tx), mirrors the record into the cache, marks anchors lost when the file changed.
  // Replace file / Choose file again (the book is in the library already): the record saved at the end is the book as
  // it is once the PDF is stored, with the new file's fields (bookRecord again), so a rename, move or chapter-mark
  // change made meanwhile stays; a book deleted before or while the PDF is stored is not brought back (code "changed").
  function storeBook(ctx, rec, opts) {
    var store = M.store, c = cache();
    if (!store || !store.docs || typeof store.docs.saveDocument !== "function") return Promise.reject(err("no_store", "Storage is not ready"));
    var existed = live(c && typeof c.collection === "function" ? c.collection(rec.id) : null);
    var watch = { deleted: false, stop: noop };
    var gone = function () { return existed && (watch.deleted || !live(c.collection(rec.id))); };
    var asNow = function () { return existed ? bookRecord(ctx, rec.id, c.collection(rec.id), rec.lastOpenedAt) : rec; };
    showPrep("Storing " + fmtBytes(ctx.bytes.byteLength) + "…");
    return warnIfTight(ctx.bytes.byteLength).then(function () {
      if (gone()) throw err("changed", "The book was deleted while its PDF was being stored");
      watch = watchDelete(rec.id);
      return watched(watch, store.docs.saveDocument(rec, ctx.bytes).then(function (saved) {
        if (gone()) throw err("changed", "The book was deleted while its PDF was being stored");
        var final = Object.assign(asNow(), storageFields(saved, ctx.bytes.byteLength));
        return Promise.resolve(c.saveCollection(final)).then(function () { return final; });
      }, function (e) {
        if (e && e.code === "store") {
          // the store kept a hasBytes:false stub of `rec`; mirror the book as it is now so the row offers "Choose file
          // again" (a book deleted meanwhile: its tombstone goes back over that stub)
          var stub = gone() ? c.collection(rec.id) : Object.assign({}, asNow(), { hasBytes: false, chunkCount: 0 });
          tryCall(function () { Promise.resolve(c.saveCollection(stub)).catch(noop); });
        }
        throw e;
      }));
    }).then(function (final) {
      var p = Promise.resolve();
      if (opts && opts.fileChanged) p = p.then(function () { return markAnchorsLost(final.id, final.pageCount); });
      if (opts && opts.recontext && typeof c.recontext === "function") p = p.then(function () { return Promise.resolve(c.recontext(final.id)).catch(noop); });
      return p.then(function () { return final; });
    });
  }

  // §11 "Duplicate opens": same fingerprint, other bytes → "Replace file, keep prompts" (default) or "Add as a separate
  // book". Esc / a backdrop click resolve dismissValue null and add nothing; the "Add as a separate book…" button
  // asks once more, and a "no" or dismissal there adds nothing either (code "cancelled", which reportAddError
  // leaves silent).
  function askDuplicate(ctx, d) {
    var name = d.existing.name || "Untitled";
    return confirm({
      title: "This PDF is already in your library",
      body: "“" + name + "” was added from a different file. Replace its file with this one and keep its prompts? Highlights are re-found in the new file.",
      ok: "Replace file, keep prompts", cancel: "Add as a separate book…", danger: false, dismissValue: null
    }).then(function (replace) {
      if (replace === null) throw err("cancelled", "Nothing was added");
      if (replace) return { action: "replace", existing: d.existing };
      var c2 = cache(), sep = c2 && typeof c2.collection === "function" ? c2.collection(d.separateId) : null;
      var again = sep && live(sep) && sep.sha256 === ctx.sha256 ? sep : null;     // added as a separate book before
      return confirm({
        title: again ? "Open the separate copy?" : "Add it as a separate book?",
        body: again ? "This file is already in your library as “" + (again.name || "Untitled") + "”." :
          "“" + (ctx.fileName || "This PDF") + "” becomes a new book with no prompts; “" + name + "” keeps its file and its prompts.",
        ok: again ? "Open the separate copy" : "Add as a separate book", cancel: "Cancel", danger: false
      }).then(function (yes) {
        if (!yes) throw err("cancelled", "Nothing was added");
        if (again) return { action: again.hasBytes === false ? "restoreBytes" : "reopen", existing: again };
        return { action: "new", id: d.separateId };
      });
    });
  }

  function reportAddError(e) {
    var code = e && e.code;
    if (code === "cancelled" || code === "busy") return;
    if (code === "quota") {
      toast("Not enough storage space for this PDF", [
        { label: "Delete a book", run: function () { route("library"); } },
        { label: "Export", run: function () { openExport({ scope: "all" }); } }
      ], 10000, "add-pdf-quota");
    } else if (code === "no_pdfjs") toast("PDF engine not loaded — reload when online", [], 8000);
    else if (code === "invalid" || code === "not_pdf") toast("This file could not be read as a PDF");
    else if (code === "password") toast("This PDF is password-protected and could not be opened");
    else if (code === "too_large") toast("This PDF is larger than 300 MB — files that big are refused");
    else if (code === "store") toast("The PDF could not be stored — choose the file again from the library", [], 8000);
    else if (code === "changed") toast("The book was deleted while its PDF was being stored, so the PDF was not added");
    else if (code === "network") toast("Could not download the PDF");
    else if (code === "locked" && otherWindow()) toast("Not added: another Marginalia window was in use. Add the PDF again.", [], 10000, "add-pdf-role");
    else toast("Could not add the PDF" + (e && e.message ? ": " + e.message : ""));
  }

  // A drop, ?pdf= or the sample link is a plain add: only the picker that "Replace file" opened replaces a book (the
  // #fileInput change handler passes that id), so a replacement left pending by a dismissed picker is dropped here.
  function addPdf(file) {
    st.pendingReplaceId = null;
    return addPdfWith(file, null);
  }

  function addPdfWith(file, replaceId) {
    if (!hasDom()) return Promise.reject(err("no_dom", "addPdf needs a browser"));
    init();
    if (!file || typeof file.arrayBuffer !== "function") return Promise.reject(err("bad_file", "Expected a File"));
    if (st.busy) { toast("Another PDF is still being added"); return Promise.reject(err("busy", "Another PDF is being added")); }
    if (isNum(file.size) && file.size > MAX_DOC_BYTES) { reportAddError(err("too_large")); return Promise.reject(err("too_large", "This PDF is larger than 300 MB")); }
    st.busy = true;
    closeMenu();
    var ctx = { file: file, fileName: str(file.name) || "document.pdf", bytes: null, sha256: "", hashAlgo: "", numPages: 0, fingerprint: "", info: {}, pageLabels: null, sections: [] };
    var t = now();
    showPrep("Preparing document…");
    return keepRole(Promise.resolve(file.arrayBuffer()).then(function (buf) {
      ctx.bytes = new Uint8Array(buf);
      if (!isPdfFile(file) && !looksLikePdf(ctx.bytes)) throw err("not_pdf", "Not a PDF");
      if (ctx.bytes.byteLength > MAX_DOC_BYTES) throw err("too_large", "This PDF is larger than 300 MB");
      return hashBytes(ctx.bytes);
    }).then(function (hs) {
      ctx.sha256 = hs.hex; ctx.hashAlgo = hs.algo;
      return parseDoc(ctx);
    }).then(function () {
      return ownRole();                                     // D31: the library as it is now, before the file is compared with it
    }).then(function (ok) {
      if (ok !== true) throw err("locked", "Another Marginalia window is writing");
      var c = cache();
      var cols = c && typeof c.collections === "function" ? c.collections() : [];
      var d = decideDuplicate(ctx, cols, replaceId);
      if (d.action !== "ask") return d;
      hidePrep();
      return askDuplicate(ctx, d).then(function (choice) { showPrep("Preparing document…"); return choice; });
    }).then(function (d) {
      var c = cache();
      if (d.action === "reopen") {
        d.existing.lastOpenedAt = t;
        return Promise.resolve(c.saveCollection(d.existing)).then(function () { return d.existing; });
      }
      if (d.action === "new") return storeBook(ctx, bookRecord(ctx, d.id, null, t), { fileChanged: false, recontext: false });
      // replace / restoreBytes: keep id, nickname, manual marks and prompts
      var changed = !!d.existing.sha256 && d.existing.sha256 !== ctx.sha256;
      var rec = bookRecord(ctx, d.existing.id, d.existing, t);
      return storeBook(ctx, rec, { fileChanged: changed, recontext: true });
    }).then(function (col) {
      hidePrep();
      st.busy = false;
      if (col) route("reader", { collectionId: col.id });
      return col;
    }, function (e) {
      hidePrep();
      st.busy = false;
      reportAddError(e);
      throw e;
    }));
  }

  function addPdfFromUrl(url) {
    if (!hasDom()) return Promise.reject(err("no_dom", "addPdfFromUrl needs a browser"));
    if (typeof fetch !== "function") return Promise.reject(err("network", "fetch is unavailable"));
    var name = fileNameFromUrl(url);
    showPrep("Downloading " + name + "…");
    return tryPromise(function () { return fetch(url); }, "network", "Bad URL").then(function (r) {
      if (!r || !r.ok) throw err("network", "HTTP " + (r ? r.status : "error"));
      return r.blob();
    }).then(function (blob) {
      hidePrep();
      var file;
      if (typeof File === "function") file = new File([blob], name, { type: "application/pdf" });
      else { file = blob; try { Object.defineProperty(file, "name", { value: name }); } catch (e) { /* ignore */ } }
      return addPdf(file);
    }, function (e) {
      hidePrep();
      if (!e || e.code !== "busy") toast("Could not load " + name);
      throw e && e.code ? e : err("network", e && e.message);
    });
  }

  // ------------------------------------------------------------------ a PDF from the backup folder (FEATURES B9.5)

  // M.backup (js/backup.js) found the PDF of a book whose bytes are not in this browser in the backup folder, where
  // Marginalia's server keeps each PDF once by its SHA-256: the bytes join the book as "Choose file again" joins the
  // same file, and the book opens as before. Checks: a live book without its bytes (hasBytes false); this tab writes (not
  // M.store.locked()); no PDF is being added (Add PDF and Choose file again hold st.busy, and so does this while it
  // hashes and stores, so the two never write one book at once); the bytes look like a PDF ("%PDF-" in the first 1 KB),
  // are at most 300 MB and hash (SHA-256) to the book's own sha256. The PDF is not opened: M.pdfview holds ONE document,
  // so opening it would close the book being read (and a protected PDF would ask for its password), and the same SHA-256
  // means the very same bytes, so the same PDF.js fingerprint and the page count, labels and outline the book recorded
  // when its file was added. The record therefore keeps everything (id, name, sections, position, lastOpenedAt; no
  // recontext, since nothing it derives from changed) and gets byteLength, chunkCount, chunkSize and hasBytes from
  // M.store.docs.saveDocument (record and chunks in ONE transaction), then M.cache.saveCollection; a store failure that
  // leaves a stub is mirrored as Add PDF does. The record is read again after the hash AND once the PDF is stored
  // (repair B9-R1 / LIB-1, see watchDelete): only the storage fields join the record M.cache holds then, in place, so a
  // rename, a move or an import made meanwhile stays; a delete seen meanwhile (undone or not) writes nothing more. Needs
  // no DOM. → Promise<record> (M.cache's own record); rejects with code "not_found", "has_bytes", "locked", "busy",
  // "no_store", "not_pdf", "too_large", "mismatch", "changed" (the record changed while the bytes were hashed or stored:
  // deleted, given its bytes, another file) or the store's "quota", "too_large", "store", "locked".
  function attachPdf(collectionId, bytes) {
    var c = cache(), store = M.store;
    var cur = c && typeof c.collection === "function" ? c.collection(collectionId) : null;
    if (!cur || !live(cur) || cur.kind !== "book") return Promise.reject(err("not_found", "That book is not in the library"));
    if (cur.hasBytes !== false) return Promise.reject(err("has_bytes", "The book's PDF is in this browser already"));
    if (isLocked()) return Promise.reject(err("locked", "Marginalia is open in another tab"));
    if (st.busy) return Promise.reject(err("busy", "Another PDF is being added"));
    if (!store || !store.docs || typeof store.docs.saveDocument !== "function" || typeof c.saveCollection !== "function") {
      return Promise.reject(err("no_store", "Storage is not ready"));
    }
    var u8 = bytes instanceof Uint8Array ? bytes : (bytes && typeof bytes.byteLength === "number" ? tryCall(function () { return new Uint8Array(bytes); }, null) : null);
    if (!u8 || !looksLikePdf(u8)) return Promise.reject(err("not_pdf", "Not a PDF"));
    if (u8.byteLength > MAX_DOC_BYTES) return Promise.reject(err("too_large", "This PDF is larger than 300 MB"));
    var sha = str(cur.sha256).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha) || (cur.hashAlgo && cur.hashAlgo !== "sha-256")) {
      return Promise.reject(err("mismatch", "The book has no SHA-256 to check the PDF against"));
    }
    // still the book that waits for this very PDF
    var waiting = function (r) { return !!r && live(r) && r.kind === "book" && r.hasBytes === false && str(r.sha256).toLowerCase() === sha; };
    st.busy = true;
    return keepRole(hashBytes(u8).then(function (hs) {
      if (hs.algo !== "sha-256" || hs.hex !== sha) throw err("mismatch", "The PDF is not this book's file (its SHA-256 differs)");
      var now2 = c.collection(collectionId);
      if (!waiting(now2)) throw err("changed", "The book changed meanwhile");
      if (isLocked()) throw err("locked", "Marginalia is open in another tab");
      var watch = watchDelete(collectionId);
      return watched(watch, store.docs.saveDocument(Object.assign({}, now2), u8).then(function (saved) {
        var cur2 = c.collection(collectionId);
        if (watch.deleted || !waiting(cur2)) {
          // deleted meanwhile (that delete's transaction, queued behind this one, removes the chunks; its Undo brings the
          // book back without them) or changed otherwise: the book stays as it is now, and no chunks stay without it
          if (!(cur2 && cur2.hasBytes === true) && typeof store.docs.deleteBytes === "function") {
            tryCall(function () { Promise.resolve(store.docs.deleteBytes(collectionId)).catch(noop); });
          }
          throw err("changed", "The book changed while its PDF was stored");
        }
        if (isLocked()) throw err("locked", "Marginalia is open in another tab");
        Object.assign(cur2, storageFields(saved, u8.byteLength));
        return Promise.resolve(c.saveCollection(cur2)).then(function () { return cur2; });
      }, function (e) {
        if (e && e.code === "store" && !isLocked()) {
          // the store kept a hasBytes:false stub of the copy it was given (storeBook does the same): the book as it is
          // now goes over it, so the row still offers "Choose file again" and a move, a rename or a delete stays
          var cur3 = c.collection(collectionId);
          if (cur3) {
            if (live(cur3)) { cur3.hasBytes = false; cur3.chunkCount = 0; }
            tryCall(function () { Promise.resolve(c.saveCollection(cur3)).catch(noop); });
          }
        }
        throw e;
      }));
    }).then(function (final) { st.busy = false; return final; }, function (e) { st.busy = false; throw e; }));
  }

  // ------------------------------------------------------------------ collections

  function createDeck(name) {
    var c = cache(), u = dep("util");
    var v = collapse(name);
    if (!v) return Promise.reject(err("bad_name", "A deck needs a name"));
    if (!c || typeof c.saveCollection !== "function") return Promise.reject(err("no_cache", "Storage is not ready"));
    var t = now();
    var rec = { id: u.uuid("deck_"), kind: "deck", name: v, description: "", sections: [], addedAt: t, lastOpenedAt: t, updatedAt: t, deletedAt: null, v: 1 };
    return Promise.resolve(c.saveCollection(rec)).then(function () { return rec; });
  }

  function renameCollection(id, name) {
    var c = cache();
    var v = collapse(name);
    if (!c || typeof c.collection !== "function") return Promise.reject(err("no_cache", "Storage is not ready"));
    var col = c.collection(id);
    if (!col) return Promise.reject(err("not_found", "No collection " + id));
    if (!v || v === col.name) return Promise.resolve(col);
    col.name = v;
    return Promise.resolve(c.saveCollection(col)).then(function () {
      if (typeof c.recontext === "function") return Promise.resolve(c.recontext(id)).catch(noop);
    }).then(function () {
      if (st.deck && st.deck.id === id) updateDeckHeader();
      return col;
    });
  }

  function restoreCollection(id) {
    var c = cache();
    if (!c) return Promise.reject(err("no_cache"));
    if (typeof c.restoreCollection === "function") return Promise.resolve(c.restoreCollection(id));
    var col = c.collection(id);
    if (!col) return Promise.reject(err("not_found"));
    var mark = col.deletedAt;
    col.deletedAt = null;
    return Promise.resolve(c.saveCollection(col)).then(function () {
      var chain = Promise.resolve();
      c.promptsOf(id).forEach(function (p) { if (p.deletedAt === mark) chain = chain.then(function () { return Promise.resolve(c.restorePrompt(p.id)).catch(noop); }); });
      return chain;
    });
  }

  function deleteCollection(id) {
    var c = cache();
    if (!c || typeof c.collection !== "function") return Promise.resolve(false);
    var col = c.collection(id);
    if (!col || !live(col)) return Promise.resolve(false);
    var counts = c.counts(id, now());
    var isBook = col.kind === "book";
    var name = col.name || (isBook ? "this book" : "this deck");
    return confirm({
      title: "Delete “" + name + "”?",
      body: (counts.prompts ? "Its " + plural(counts.prompts, "prompt") + " and their review history are deleted too." : "It has no prompts.") +
        (isBook ? " The PDF is removed from this browser." : ""),
      ok: "Delete", cancel: "Cancel", danger: true
    }).then(function (ok) {
      if (!ok) return false;
      var landing = landingAfterDelete(col);
      return Promise.resolve(c.removeCollection(id)).then(function () {
        if (st.deck && st.deck.id === id) { teardownDeck(); route("library"); }
        offerUndo(id, name, isBook);
        if (isVisible(byId("library"))) { st.focusKey = landing; render(); }
        return true;
      }, function () { toast("Could not delete"); return false; });
    });
  }

  // Focus after a delete lands on the next row of that kind (else the previous one, else "New deck" / "Add PDF"),
  // inside #library, where Z reaches onUndoKey. In a folder (FEATURES L1; repair UI-4) with no row of that kind left, it
  // stays in the folder: its other rows (the decks below a deleted book, the books above a deleted deck), else the
  // folder's own chevron (or the nearest one above it on screen); only then the header. → a data-focus key or a list.
  function landingAfterDelete(col) {
    var c = cache(), foldered = hasFolders(c);
    var where = function (x) { return foldered ? tryCall(function () { return c.folderOf(x); }, null) : null; }, here = where(col);
    var beside = (c && typeof c.collections === "function" ? sortCollections(c.collections()) : []).filter(function (x) {
      return where(x) === here && (x.kind === "book" || x.kind === "deck");   // the rows beside it (the same folder)
    });
    var same = beside.filter(function (x) { return x.kind === col.kind; });
    var at = -1;
    for (var i = 0; i < same.length; i++) if (same[i].id === col.id) { at = i; break; }
    var rest = same.filter(function (x) { return x.id !== col.id; });
    if (rest.length) return "row:" + rest[Math.min(Math.max(at, 0), rest.length - 1)].id + ":more";
    var header = col.kind === "deck" ? "new-deck" : "add";
    if (!here) return header;
    var keys = [], other = beside.filter(function (x) { return x.kind !== col.kind; });
    if (other.length) keys.push("row:" + (col.kind === "book" ? other[0] : other[other.length - 1]).id + ":more");
    (tryCall(function () { return c.folderPath(here); }, []) || []).slice().reverse().forEach(function (fid) { keys.push("folder:" + fid + ":toggle"); });
    keys.push(header);
    return keys;
  }

  // "Deleted · Undo (Z)" for 8 s (§14): the toast's Undo button or Z (onUndoKey / M.library.undoDelete()).
  function offerUndo(id, name, isBook) {
    var u = { id: id, name: name, isBook: isBook, until: now() + UNDO_TTL_MS, handle: null };
    st.undo = u;
    u.handle = toast("Deleted · Undo (Z)", [{ label: "Undo", run: function () { runUndo(u); } }], UNDO_TTL_MS, "collection-deleted",
      function () { if (st.undo === u) st.undo = null; });
  }
  function runUndo(u) {
    if (st.undo === u) st.undo = null;
    if (typeof u.restore === "function") { u.restore(); return; }      // a folder's delete (FEATURES L1.4)
    restoreCollection(u.id).then(function () {
      toast("Restored “" + u.name + "”" + (u.isBook ? " — choose the PDF file again to read it" : ""));
    }, function () { toast("Could not restore"); });
  }
  // The undo still on offer: while its toast shows (a hovered toast waits), else for UNDO_TTL_MS.
  function pendingUndo() {
    var u = st.undo;
    if (!u) return null;
    var el = u.handle && u.handle.el;
    if ((el && hasDom() && document.contains(el)) || now() <= u.until) return u;
    st.undo = null;
    return null;
  }
  function undoDelete() {
    var u = pendingUndo();
    if (!u) return false;
    st.undo = null;
    if (u.handle && typeof u.handle.close === "function") tryCall(function () { u.handle.close(); });
    runUndo(u);
    return true;
  }
  // keydown on #library / #deck: READER_MAP's undoDelete ("z", never inside a text field) while an undo is on offer
  function onUndoKey(ev) {
    if (!st.undo || !ev || ev.defaultPrevented) return;
    var k = keys(), R = k && k.READER_MAP;
    if (!R || !R.undoDelete || typeof k.dispatch !== "function") return;
    if (tryCall(function () { return k.dispatch(ev, [{ undoDelete: R.undoDelete }]); }, null) !== "undoDelete") return;
    if (!ev.repeat && undoDelete()) { ev.preventDefault(); ev.stopPropagation(); }
  }

  // ⋯ › "Remove mark …" (§14): drops one manual chapter mark and recontexts the book's prompts; the toast offers Undo.
  function removeChapterMark(collectionId, mark) {
    var c = cache();
    var col = c && typeof c.collection === "function" ? c.collection(collectionId) : null;
    if (!col || !live(col) || typeof c.saveCollection !== "function") return Promise.resolve(false);
    var before = Array.isArray(col.sections) ? col.sections : [];
    var keep = withoutMark(before, mark);
    if (keep.length === before.length) return Promise.resolve(false);
    var name = markName(mark);
    return saveSections(col, keep).then(function () {
      toast("Removed the chapter mark “" + name + "”", [{ label: "Undo", run: function () {
        var cur = c.collection(collectionId);
        if (cur && live(cur)) saveSections(cur, withMark(cur.sections, mark)).catch(function () { toast("Could not restore the chapter mark"); });
      } }], UNDO_TTL_MS, "mark-removed");
      return true;
    }, function () { toast("Could not remove the chapter mark"); return false; });
  }
  function saveSections(col, sections) {
    var c = cache();
    col.sections = sections;
    return Promise.resolve(c.saveCollection(col)).then(function () {
      if (typeof c.recontext === "function") return Promise.resolve(c.recontext(col.id)).catch(noop);
    });
  }

  // ------------------------------------------------------------------ deck page (§14)

  function teardownDeck() {
    if (!st.deck) return;
    var d = st.deck;
    st.deck = null;
    closeMenu();
    if (M.list && typeof M.list.isOpen === "function" && M.list.isOpen() && M.list.collectionId && M.list.collectionId() === d.id) tryCall(function () { M.list.close(); });
    if (d.editor && typeof d.editor.destroy === "function") tryCall(function () { d.editor.destroy(); });
    var host = byId("deck");
    if (host) clear(host);
  }

  function deckCountsText(c, counts) {
    var s = plural(counts.prompts, "prompt") + " · " + counts.due + " due";
    if (counts.due === 0 && isNum(counts.nextDueAt)) {
      var u = tryDep("util");
      if (u && typeof u.nextDayLabel === "function") s += " · next due " + u.nextDayLabel(counts.nextDueAt, now());
    }
    return s;
  }

  function updateDeckHeader() {
    if (!st.deck) return;
    var c = cache(), col = c && typeof c.collection === "function" ? c.collection(st.deck.id) : null;
    if (!col) return;
    var counts = c.counts(col.id, now());
    st.deck.nameEl.textContent = col.name || "Untitled deck";
    st.deck.descEl.textContent = col.description ? col.description : "Add a description";
    st.deck.descEl.classList.toggle("deck__desc--empty", !col.description);
    st.deck.countsEl.textContent = deckCountsText(col, counts);
    reviewLook(st.deck.reviewBtn, counts.due, "btn btn--primary", "btn");
  }

  function editDeckField(field) {
    var d = st.deck;
    if (!d) return;
    var c = cache(), col = c.collection(d.id);
    if (!col) return;
    var target = field === "name" ? d.nameEl : d.descEl;
    if (target.classList.contains("is-hidden")) return;
    var input = field === "name"
      ? h("input", { type: "text", class: "lib-rename deck__name-input", value: col.name || "", "aria-label": "Deck name", maxlength: "80" })
      : h("textarea", { class: "deck__desc-input", rows: "2", "aria-label": "Description", placeholder: "Description" });
    if (field !== "name") input.value = col.description || "";
    target.classList.add("is-hidden");
    target.parentNode.insertBefore(input, target);
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var v = field === "name" ? collapse(input.value) : str(input.value).trim();
      if (input.parentNode) input.parentNode.removeChild(input);
      target.classList.remove("is-hidden");
      if (!commit) return;
      if (field === "name") { if (v && v !== col.name) renameCollection(col.id, v).catch(noop); }
      else if (v !== (col.description || "")) {
        col.description = v;
        Promise.resolve(c.saveCollection(col)).then(updateDeckHeader, noop);
      }
      updateDeckHeader();
    }
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && (field === "name" || ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ev.stopPropagation(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(false); }
      else ev.stopPropagation();
    });
    input.addEventListener("blur", function () { finish(true); });
    tryCall(function () { input.focus(); if (field === "name") input.select(); });
  }

  function saveBatch(text) {
    var d = st.deck;
    if (!d) return Promise.resolve(0);
    var pr = dep("prompts"), c = cache();
    var col = c.collection(d.id);
    if (!col) return Promise.resolve(0);
    var blocks = pr.parseBatch(str(text)).filter(function (b) { return b && b.parsed && b.parsed.kind !== "highlight"; });
    if (!blocks.length) { toast("Nothing to add — type a prompt first"); return Promise.resolve(0); }
    var base = now(), saved = 0, chain = Promise.resolve();
    blocks.forEach(function (b, i) {
      var p = {
        collectionId: col.id, kind: b.parsed.kind, text: b.text, tags: b.parsed.tags.slice(), flagged: false, anchor: null,
        context: { docName: col.name || "", sectionLabel: b.section || null, pageIndex: null, pageLabel: null },
        cards: pr.reconcileCards(null, b.parsed, base + i).cards, createdAt: base + i, deletedAt: null, v: 1
      };
      chain = chain.then(function () { return c.savePrompt(p, { content: true }); }).then(function () { saved++; });
    });
    return chain.then(function () {
      toast("Added " + plural(saved, "prompt"));
      if (d.editor && typeof d.editor.setText === "function") tryCall(function () { d.editor.setText(""); });
      updateDeckHeader();
      return saved;
    }, function () {
      toast(saved ? "Added " + plural(saved, "prompt") + " — the rest could not be saved" : "Could not save the prompts");
      return saved;
    });
  }

  function openDeck(id) {
    if (!hasDom()) return false;
    init();
    var c = cache(), col = c && typeof c.collection === "function" ? c.collection(id) : null;
    var host = byId("deck");
    if (!host) return false;
    if (!col || !live(col) || col.kind !== "deck") { toast("That deck no longer exists"); route("library"); return false; }
    if (st.deck && st.deck.id === id && host.contains(st.deck.el)) { updateDeckHeader(); ensureDeckVisible(id); return true; }
    teardownDeck();
    col.lastOpenedAt = now();
    tryCall(function () { Promise.resolve(c.saveCollection(col)).catch(noop); });

    var back = h("button", { type: "button", class: "btn btn--ghost deck__back", text: "‹ Library" });
    back.addEventListener("click", function () { route("library"); });
    var nameEl = h("h1", { class: "deck__name", title: "Click to rename", tabindex: "0", role: "button" });
    nameEl.addEventListener("click", function () { editDeckField("name"); });
    nameEl.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); editDeckField("name"); } });
    var pen = h("button", { type: "button", class: "lib-row__pen", "aria-label": "Rename", title: "Rename", text: "✎" });
    pen.addEventListener("click", function () { editDeckField("name"); });
    var descEl = h("p", { class: "deck__desc", title: "Click to edit", tabindex: "0", role: "button" });
    descEl.addEventListener("click", function () { editDeckField("description"); });
    descEl.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); editDeckField("description"); } });
    var countsEl = h("div", { class: "deck__counts" });
    var reviewBtn = h("button", { type: "button", class: "btn btn--primary", text: "Review this deck" });
    reviewBtn.addEventListener("click", function () { startReview("deck", id); });
    var exportBtn = h("button", { type: "button", class: "btn", text: "Export…" });
    exportBtn.addEventListener("click", function () { openExport({ scope: "collection", collectionId: id }); });
    var more = h("button", { type: "button", class: "btn btn--ghost deck__more", "data-focus": "deck:more", "aria-haspopup": "menu", "aria-label": "More actions", text: "⋯" });
    more.addEventListener("click", function (ev) {
      ev.stopPropagation();
      openMenu(more, [
        { label: "Rename", run: function () { editDeckField("name"); } },
        { label: "Export…", run: function () { openExport({ scope: "collection", collectionId: id }); } },
        sendAllItem(id),
        moveItem("collection", id),
        { label: "Delete", danger: true, run: function () { deleteCollection(id); } }
      ], host);
    });
    var head = h("header", { class: "deck__head" }, [
      back,
      h("div", { class: "deck__title-row" }, [nameEl, pen]),
      descEl,
      countsEl,
      h("div", { class: "deck__actions" }, [reviewBtn, exportBtn, more])
    ]);
    var addHost = h("div", { class: "deck__add-host" });
    var addSec = h("section", { class: "deck__add" }, [
      h("h2", { class: "lib__label", text: "Add prompts" }),
      h("p", { class: "deck__hint", text: "Q. / A. lines or a sentence with {hidden text}. Blank lines separate prompts; a line “# Section” labels the prompts after it. Cmd/Ctrl+Enter adds them." }),
      addHost
    ]);
    var listHost = h("div", { class: "deck__list" });
    var listSec = h("section", { class: "deck__prompts" }, [h("h2", { class: "lib__label", text: "Prompts" }), listHost]);
    var el = h("div", { class: "deck" }, [head, addSec, listSec]);
    clear(host);
    host.appendChild(el);
    st.deck = { id: id, el: el, nameEl: nameEl, descEl: descEl, countsEl: countsEl, reviewBtn: reviewBtn, editor: null, listHost: listHost, opening: false };
    updateDeckHeader();

    if (M.list && typeof M.list.open === "function") tryCall(function () { M.list.open(id, { host: listHost }); });
    if (M.editor && typeof M.editor.create === "function") {
      try {
        st.deck.editor = M.editor.create({
          host: addHost, prompt: null, initialText: "", anchor: null, batch: true,
          onSave: function (text) { return saveBatch(text); },
          onCancel: function () { if (st.deck && st.deck.editor && typeof st.deck.editor.setText === "function") tryCall(function () { st.deck.editor.setText(""); }); }
        });
      } catch (e) { addHost.appendChild(h("div", { class: "deck__hint", text: "The editor could not be opened." })); }
      addHost.addEventListener("focusin", function () { setOwner("editor"); });
      addHost.addEventListener("focusout", function (ev) { var to = ev.relatedTarget; if (!to || !addHost.contains(to)) setOwner("library"); });
    } else {
      addHost.appendChild(h("div", { class: "deck__hint", text: "The editor is not available." }));
    }
    ensureDeckVisible(id);
    return true;
  }

  function ensureDeckVisible(id) {
    var host = byId("deck");
    if (!host || isVisible(host) || !st.deck || st.deck.opening) return;
    st.deck.opening = true;
    route("deck", { collectionId: id });
    if (st.deck) st.deck.opening = false;
  }

  function activeEditor() {
    if (M.list && typeof M.list.activeEditor === "function") {
      var inList = tryCall(function () { return M.list.activeEditor(); }, null);
      if (inList) return inList;
    }
    if (st.deck && st.deck.editor && isVisible(byId("deck"))) return st.deck.editor;
    return null;
  }

  // ------------------------------------------------------------------ settings panel (§7, §13, §15, BUILD-NOTES tabs)

  function openSettings(tab) {
    if (!hasDom()) return false;
    init();
    var host = byId("settings");
    if (!host) return false;
    if (!st.settings) {
      var s = { host: host, invoker: document.activeElement, prevOwner: currentOwner("library"), tab: null, keysMap: null, conflicts: {}, recording: null };
      st.settings = s;
      var closeBtn = h("button", { type: "button", class: "btn btn--ghost settings__close", "aria-label": "Close settings", text: "✕" });
      closeBtn.addEventListener("click", function () { closeSettings(); });
      var tabs = h("div", { class: "settings__tabs", role: "tablist" });
      TABS.forEach(function (tb) {
        var b = h("button", { type: "button", role: "tab", class: "settings__tab", "data-tab": tb.id, text: tb.label });
        b.addEventListener("click", function () { showSettingsTab(tb.id); });
        tabs.appendChild(b);
      });
      s.body = h("div", { class: "settings__body" });
      s.panel = h("div", { class: "settings__panel", role: "dialog", "aria-modal": "true", "aria-label": "Settings" }, [
        h("header", { class: "settings__head" }, [h("h2", { class: "settings__title", text: "Settings" }), closeBtn]),
        tabs, s.body
      ]);
      var backdrop = h("div", { class: "settings__backdrop" });
      backdrop.addEventListener("mousedown", function () { closeSettings(); });
      s.panel.addEventListener("keydown", function (ev) {
        if (s.recording) return;                      // the capture-phase recorder owns every key
        if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeSettings(); return; }
        if (ev.key === "Tab") { trapTab(ev, s.panel); ev.stopPropagation(); return; }
        // Every other key stops here, short of the app's document listener, so the panel runs the settings owner's
        // routed keys itself (BUILD-NOTES "Key routing"): "," toggles Settings shut, "?", Mod+O, Shift+R, T.
        var id = settingsKeyAction(ev);
        ev.stopPropagation();
        if (!id) return;
        ev.preventDefault();                          // Mod+O: never the browser's own Open File dialog
        if (!ev.repeat) runSettingsKey(id);
      });
      clear(host);
      host.appendChild(backdrop);
      host.appendChild(s.panel);
      host.classList.remove("is-hidden");
      setOwner("settings");
      // BUILD-NOTES "Obsidian": the server / link check runs again whenever Settings opens (the Obsidian tab reads it),
      // but only while the Obsidian connection is on (DECISIONS D32): off, Marginalia asks nothing about Obsidian
      var O = M.obsidian;
      if (O && typeof O.detect === "function" && obsidianOn()) tryCall(function () { Promise.resolve(O.detect({ force: true })).catch(noop); });
    }
    showSettingsTab(normalizeTab(tab));
    return true;
  }

  function closeSettings() {
    var s = st.settings;
    if (!s) return false;
    stopRecording();
    st.settings = null;
    s.host.classList.add("is-hidden");
    clear(s.host);
    setOwner(s.prevOwner === "settings" ? "library" : s.prevOwner);
    if (s.invoker && document.contains(s.invoker) && typeof s.invoker.focus === "function") tryCall(function () { s.invoker.focus(); });
    return true;
  }

  function isSettingsOpen() { return !!st.settings; }

  // The settings owner's app keys (BUILD-NOTES "Key routing"; Escape is the panel's own). Text fields keep theirs.
  var SETTINGS_KEY_IDS = ["settings", "shortcuts", "openPdf", "reviewAll", "reviewToday"];
  function settingsKeyAction(ev) {
    var k = keys(), R = k && k.READER_MAP;
    if (!R || typeof k.dispatch !== "function") return null;
    var map = {};
    SETTINGS_KEY_IDS.forEach(function (id) { if (R[id]) map[id] = R[id]; });
    return tryCall(function () { return k.dispatch(ev, [map]); }, null);
  }
  function runSettingsKey(id) {
    var app = M.app;
    if (id === "settings") { closeSettings(); return; }
    if (id === "shortcuts") {                         // the sheet opens above the panel and gives focus back to it
      if (app && typeof app.openShortcuts === "function") tryCall(function () { app.openShortcuts(); });
      return;
    }
    // A picker, or a review overlay that would sit under the panel: leave Settings first, as the app's runApp would.
    var cur = app && typeof app.current === "function" ? tryCall(function () { return app.current(); }, null) : null;
    var here = cur && (cur.screen === "reader" || cur.screen === "deck") && cur.collectionId ? cur.collectionId : null;
    closeSettings();
    if (id === "openPdf") openFilePicker(null);
    else if (id === "reviewAll") startReview("all", null);
    else if (id === "reviewToday") startReview("today", here);
  }

  function trapTab(ev, panel) {
    var nodes = panel.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
    var list = [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].offsetParent !== null || nodes[i] === document.activeElement) list.push(nodes[i]);
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (ev.shiftKey && (active === first || !panel.contains(active))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (active === last || !panel.contains(active))) { ev.preventDefault(); first.focus(); }
  }

  function showSettingsTab(id) {
    var s = st.settings;
    if (!s) return;
    stopRecording();
    s.tab = id;
    var btns = s.panel.querySelectorAll(".settings__tab");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute("data-tab") === id;
      btns[i].classList.toggle("settings__tab--active", on);
      btns[i].setAttribute("aria-selected", on ? "true" : "false");
      btns[i].setAttribute("tabindex", on ? "0" : "-1");
    }
    clear(s.body);
    s.paintBackup = null;                             // buildDataPane sets it again while the Data tab shows
    s.paintObsidian = null;                           // buildObsidianPane sets it again while the Obsidian tab shows
    var pane = id === "shortcuts" ? buildShortcutsPane() : id === "latex" ? buildLatexPane() : id === "obsidian" ? buildObsidianPane()
      : id === "data" ? buildDataPane() : buildAppearancePane();
    s.body.appendChild(pane);
    var focusTarget = s.panel.querySelector(".settings__tab--active");
    if (focusTarget) tryCall(function () { focusTarget.focus(); });
  }

  function buildAppearancePane() {
    var sg = settings();
    var theme = sg ? sg.get("theme") : "system";
    var radios = h("div", { class: "settings__radios", role: "radiogroup", "aria-label": "Theme" });
    [["system", "System"], ["light", "Light"], ["dark", "Dark"]].forEach(function (opt) {
      var input = h("input", { type: "radio", name: "marginalia-theme", value: opt[0] });
      input.checked = theme === opt[0];
      input.addEventListener("change", function () {
        if (!input.checked) return;
        if (M.app && typeof M.app.setTheme === "function") tryCall(function () { M.app.setTheme(opt[0]); });
        else if (sg) tryCall(function () { sg.set("theme", opt[0]); });
      });
      radios.appendChild(h("label", { class: "settings__radio" }, [input, " " + opt[1]]));
    });
    var dim = h("input", { type: "checkbox" });
    dim.checked = !!(sg && sg.get("dimPages"));
    dim.addEventListener("change", function () { if (sg) tryCall(function () { sg.set("dimPages", dim.checked); }); });
    var answers = h("input", { type: "checkbox" });
    answers.checked = !(sg && sg.get("marginAnswers") === false);
    answers.addEventListener("change", function () { if (sg) tryCall(function () { sg.set("marginAnswers", answers.checked); }); });
    return h("div", { class: "settings__pane settings__pane--appearance" }, [
      h("div", { class: "settings__row" }, [h("div", { class: "settings__label", text: "Theme" }), radios]),
      h("div", { class: "settings__row" }, [h("label", { class: "settings__check" }, [dim, " Dim pages (D)"]), h("div", { class: "settings__hint", text: "A translucent overlay on the pages; highlights stay visible." })]),
      h("div", { class: "settings__row" }, [h("label", { class: "settings__check" }, [answers, " Show answers in the margin (A toggles)"])])
    ]);
  }

  // ---- review shortcuts

  function currentKeysMap() {
    var s = st.settings, sg = settings();
    if (s && s.keysMap) return s.keysMap;
    var stored = sg ? sg.get("reviewKeys") : null, k = keys();
    var map = {}, full = k && typeof k.reviewMap === "function" ? k.reviewMap(stored) : null;   // M.keys' fill rule
    actionList().forEach(function (a) {
      var b = full && full[a] ? bindingOf(full[a]) :
        (stored && Object.prototype.hasOwnProperty.call(stored, a) ? bindingOf(stored[a]) : (k && k.PRESETS ? k.PRESETS.Default[a] : null));
      map[a] = b ? b : null;
    });
    if (s) s.keysMap = map;
    return map;
  }

  function persistKeys(map) {
    var sg = settings();
    if (st.settings) st.settings.keysMap = map;
    if (sg) tryCall(function () { sg.set("reviewKeys", map); });
  }

  function buildShortcutsPane() {
    var s = st.settings, k = keys();
    var map = currentKeysMap();
    var presetSel = h("select", { class: "settings__select", "aria-label": "Preset" });
    var names = k && k.PRESETS ? Object.keys(k.PRESETS) : [];
    names.forEach(function (n) { presetSel.appendChild(h("option", { value: n, text: n })); });
    var custom = h("option", { value: "__custom", text: "Custom" });
    custom.disabled = true;
    presetSel.appendChild(custom);
    var pn = presetName(map);
    presetSel.value = pn || "__custom";
    presetSel.addEventListener("change", function () {
      var name = presetSel.value;
      if (!k || !k.PRESETS || !k.PRESETS[name]) return;
      var next = {};
      actionList().forEach(function (a) { next[a] = k.PRESETS[name][a] || null; });
      s.conflicts = {};
      persistKeys(next);
      renderShortcutRows();
    });
    var reset = h("button", { type: "button", class: "btn", text: "Reset to default" });
    reset.addEventListener("click", function () {
      var next = {};
      actionList().forEach(function (a) { next[a] = k && k.PRESETS ? k.PRESETS.Default[a] : null; });
      s.conflicts = {};
      persistKeys(next);
      presetSel.value = "Default";
      renderShortcutRows();
    });
    var table = h("table", { class: "shortcuts-table" }, [
      h("thead", null, [h("tr", null, [h("th", { text: "Action" }), h("th", { text: "Key" }), h("th", { text: "" })])]),
      h("tbody")
    ]);
    var tbody = table.querySelector("tbody");
    var status = h("div", { class: "settings__hint", "aria-live": "polite", text: "Click a key cap, then press the new key. Nothing fires inside text fields." });

    function renderShortcutRows() {
      clear(tbody);
      var m = currentKeysMap();
      var conflictPairs = k && typeof k.conflicts === "function" ? tryCall(function () { return k.conflicts(m); }, []) : [];
      var inConflict = {};
      conflictPairs.forEach(function (pair) { inConflict[pair[0]] = true; inConflict[pair[1]] = true; });
      actionList().forEach(function (a) {
        var b = m[a];
        var tr = h("tr", { "data-action": a });
        var red = !!inConflict[a] || !!(s.conflicts && s.conflicts[a]);
        tr.classList.toggle("is-conflict", red);
        var cap = h("button", { type: "button", class: "shortcuts__cap" + (b ? "" : " shortcuts__cap--unbound"), "aria-label": "Rebind " + (ACTION_LABELS[a] || a) });
        if (b) cap.appendChild(h("kbd", { class: "kbd", text: k && typeof k.label === "function" ? k.label(b) : str(b) }));
        else cap.appendChild(h("span", { class: "shortcuts__unbound", text: "unbound" }));
        var rebind = h("button", { type: "button", class: "btn btn--ghost shortcuts__rebind", text: "Rebind" });
        var start = function () { startRecording(a, cap, tr); };
        cap.addEventListener("click", start);
        rebind.addEventListener("click", start);
        tr.appendChild(h("td", { class: "shortcuts__action", text: ACTION_LABELS[a] || a }));
        tr.appendChild(h("td", { class: "shortcuts__key" }, [cap]));
        tr.appendChild(h("td", { class: "shortcuts__rebind-cell" }, [rebind]));
        tbody.appendChild(tr);
      });
      var name = presetName(m);
      presetSel.value = name || "__custom";
      var unbound = actionList().filter(function (a) { return !m[a]; });
      status.textContent = unbound.length
        ? unbound.map(function (a) { return ACTION_LABELS[a] || a; }).join(", ") + " " + (unbound.length === 1 ? "is" : "are") + " unbound — the button still works by click."
        : "Click a key cap, then press the new key. Nothing fires inside text fields.";
    }
    s.renderShortcutRows = renderShortcutRows;
    renderShortcutRows();
    return h("div", { class: "settings__pane settings__pane--shortcuts" }, [
      h("div", { class: "settings__row settings__row--inline" }, [h("label", { class: "settings__label" }, ["Preset ", presetSel]), reset]),
      table,
      status
    ]);
  }

  function stopRecording() {
    var s = st.settings;
    if (!s || !s.recording) return;
    var r = s.recording;
    s.recording = null;
    try { document.removeEventListener("keydown", r.onKey, true); } catch (e) { /* ignore */ }
    if (typeof s.renderShortcutRows === "function" && s.tab === "shortcuts") {
      s.renderShortcutRows();
      // the rebuild removed the focused "Use Esc" button: put focus back on the action's cap (commitBinding does the
      // same), or later keys would start on the body element, outside the panel's handler and its Tab trap
      var a = document.activeElement;
      if (!a || a === document.body || !s.panel.contains(a)) focusCap(s, r.action);
    }
  }
  function rowOf(s, action) {
    var rows = s.panel.querySelectorAll("tr[data-action]");
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute("data-action") === action) return rows[i];
    return null;
  }
  function focusCap(s, action) {
    var tr = rowOf(s, action), cap = tr ? tr.querySelector(".shortcuts__cap") : null;
    if (cap) tryCall(function () { cap.focus(); });
  }

  function startRecording(action, capEl, rowEl) {
    var s = st.settings, k = keys();
    if (!s) return;
    if (s.recording) {
      stopRecording();                                // rebuilds the rows: record into this action's fresh cap and row
      rowEl = rowOf(s, action);
      capEl = rowEl ? rowEl.querySelector(".shortcuts__cap") : null;
      if (!capEl) return;
    }
    clear(capEl);
    capEl.classList.add("is-recording");
    rowEl.classList.add("is-recording");
    var useEsc = h("button", { type: "button", class: "btn btn--ghost shortcuts__use-esc", text: "Use Esc" });
    useEsc.addEventListener("click", function (ev) { ev.stopPropagation(); commitBinding(action, "Escape"); });
    capEl.appendChild(h("span", { class: "shortcuts__recording", text: "Press a key… (Esc cancels · " }));
    capEl.appendChild(useEsc);
    capEl.appendChild(h("span", { text: ")" }));
    var rec = { action: action, onKey: null };
    rec.onKey = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
      var binding = k && typeof k.normalize === "function" ? k.normalize(ev) : str(ev.key);
      var d = k && typeof k.parse === "function" ? k.parse(binding) : { key: binding, ctrl: false, alt: false, shift: false, meta: false };
      if (!d.key || MODIFIER_NAMES[d.key]) return;               // a bare modifier: keep waiting
      if (d.key === "Escape" && !d.ctrl && !d.alt && !d.shift && !d.meta) { stopRecording(); return; }
      commitBinding(action, binding);
    };
    document.addEventListener("keydown", rec.onKey, true);
    s.recording = rec;
    tryCall(function () { useEsc.focus(); });
  }

  function commitBinding(action, binding) {
    var s = st.settings;
    if (!s) return;
    var r = applyBinding(currentKeysMap(), action, binding);
    s.conflicts = {};
    r.conflicted.forEach(function (a) { s.conflicts[a] = true; s.conflicts[action] = true; });
    stopRecordingSilently();
    persistKeys(r.map);
    if (typeof s.renderShortcutRows === "function") s.renderShortcutRows();
    focusCap(s, action);
  }

  function stopRecordingSilently() {
    var s = st.settings;
    if (!s || !s.recording) return;
    var r = s.recording;
    s.recording = null;
    try { document.removeEventListener("keydown", r.onKey, true); } catch (e) { /* ignore */ }
  }

  // ---- LaTeX from snips

  function buildLatexPane() {
    var sg = settings();
    var pane = h("div", { class: "settings__pane settings__pane--latex" });
    var status = h("div", { class: "settings__status", "aria-live": "polite" });
    var isArtifact = !!(M.app && typeof M.app.isArtifact === "function" && tryCall(function () { return M.app.isArtifact(); }, false));

    function keyForm() {
      var hasKey = !!(sg && sg.apiKey && sg.apiKey.get());
      var keyInput = h("input", { type: "password", class: "settings__input", placeholder: "sk-ant-…", autocomplete: "off", spellcheck: "false", "aria-label": "Anthropic API key" });
      if (hasKey) keyInput.value = sg.apiKey.get();
      var saveKey = h("button", { type: "button", class: "btn btn--primary", text: "Save key" });
      var forget = h("button", { type: "button", class: "btn", text: "Forget key" });
      forget.disabled = !hasKey;
      var model = h("input", { type: "text", class: "settings__input", "aria-label": "Model", spellcheck: "false" });
      model.value = sg ? str(sg.get("visionModel")) : "";
      var test = h("button", { type: "button", class: "btn", text: "Test" });
      test.disabled = !hasKey;
      function commitKey() {
        if (!sg || !sg.apiKey) return;
        var v = str(keyInput.value).trim();
        if (v) { sg.apiKey.set(v); status.textContent = "Key saved in this browser"; forget.disabled = false; test.disabled = false; }
        else { sg.apiKey.forget(); status.textContent = "No key stored"; forget.disabled = true; test.disabled = true; }
      }
      saveKey.addEventListener("click", commitKey);
      keyInput.addEventListener("change", commitKey);
      keyInput.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); commitKey(); } });
      forget.addEventListener("click", function () {
        if (sg && sg.apiKey) sg.apiKey.forget();
        keyInput.value = "";
        forget.disabled = true; test.disabled = true;
        status.textContent = "Key forgotten";
      });
      model.addEventListener("change", function () {
        if (!sg) return;
        var v = str(model.value).trim();
        if (!v) { v = sg.DEFAULTS && sg.DEFAULTS.visionModel ? sg.DEFAULTS.visionModel : "claude-opus-5-5"; model.value = v; }
        sg.set("visionModel", v);
        status.textContent = "Model set to " + v;
      });
      test.addEventListener("click", function () {
        if (!M.vision || typeof M.vision.test !== "function") { status.textContent = "The vision module is not loaded"; return; }
        test.disabled = true;
        status.className = "settings__status";
        status.textContent = "Testing — transcribing a small x² image…";
        tryPromise(function () { return M.vision.test(); }, "test_failed", "test failed").then(function (r) {
          test.disabled = false;
          status.classList.toggle("settings__status--ok", !!(r && r.ok));
          status.classList.toggle("settings__status--bad", !(r && r.ok));
          status.textContent = r && r.message ? r.message : (r && r.ok ? "Connected" : "Test failed");
        }, function (e) {
          test.disabled = false;
          status.classList.add("settings__status--bad");
          status.textContent = "Test failed" + (e && e.message ? ": " + e.message : "");
        });
      });
      return [
        h("div", { class: "settings__row" }, [h("label", { class: "settings__label" }, ["Anthropic API key ", keyInput]), h("div", { class: "settings__actions" }, [saveKey, forget])]),
        h("div", { class: "settings__hint", text: "Stored in this browser only, never exported. Snips in LaTeX mode send the image to the Claude API with this key." }),
        h("div", { class: "settings__row" }, [h("label", { class: "settings__label" }, ["Model ", model])]),
        h("div", { class: "settings__row" }, [test]),
        status
      ];
    }

    if (isArtifact) {
      pane.appendChild(h("div", { class: "settings__notice", text: "Using Claude via the artifact runtime — no API key needed." }));
      pane.appendChild(status);
      status.textContent = "Checking the artifact runtime…";
      if (M.vision && typeof M.vision.detect === "function") {
        Promise.resolve(tryCall(function () { return M.vision.detect(); }, Promise.resolve(null))).then(function (kind) {
          if (kind === "artifact") status.textContent = "Image transcription is available.";
          else if (kind === "apikey") { status.textContent = "The artifact runtime is unavailable here; an API key is used instead."; keyForm().forEach(function (n) { pane.appendChild(n); }); }
          else { status.textContent = "Claude is not available in this view — snips copy images only."; keyForm().forEach(function (n) { pane.appendChild(n); }); }
        }, function () { status.textContent = "Could not check the artifact runtime."; });
      }
    } else {
      keyForm().forEach(function (n) { pane.appendChild(n); });
      var hasKey = !!(sg && sg.apiKey && sg.apiKey.get());
      status.textContent = hasKey ? "A key is stored in this browser." : "No key stored — LaTeX snips are disabled until you add one.";
    }
    return pane;
  }

  // ---- Obsidian (BUILD-NOTES "Obsidian")

  // The switch "Connect Marginalia to Obsidian" (DECISIONS D32; settings.obsidian, read through M.obsidian.enabled()),
  // and, only while it is on: the vault (a select of the vaults Marginalia's server finds, else a "Vault name" field for
  // obsidian:// links), the folder inside it, and one line naming the method in use. Settings: obsidianVault ("" = the
  // only vault found), obsidianFolder. The check itself (M.obsidian.detect) ran again when Settings opened with the
  // connection on, and runs when the switch goes on; while the switch is off nothing is asked.
  function buildObsidianPane() {
    var sg = settings(), O = M.obsidian;
    var pane = h("div", { class: "settings__pane settings__pane--obsidian" });
    if (!O || typeof O.detect !== "function") {
      pane.appendChild(h("div", { class: "settings__notice", text: "Obsidian is not available in this build." }));
      return pane;
    }
    var sw = h("input", { type: "checkbox", role: "switch", class: "settings__obsidian-switch" });
    var offHint = h("div", { class: "settings__hint settings__obsidian-off", text: "Marginalia can copy your notes and prompts into an Obsidian vault, " +
      "one Obsidian note per book or deck. While this is off, Marginalia shows no Obsidian command and asks nothing about Obsidian." });
    var body = h("div", { class: "settings__obsidian-body" });   // the vault, the folder and the method: only while it is on
    var method = h("div", { class: "settings__status settings__method", "aria-live": "polite", text: "Checking for Marginalia’s server…" });
    var vaultSlot = h("div", { class: "settings__row" });
    var vaultHint = h("div", { class: "settings__hint" });
    var folder = h("input", { type: "text", class: "settings__input", "aria-label": "Folder inside the vault", spellcheck: "false", autocomplete: "off",
      placeholder: O.DEFAULT_FOLDER || "Notes/Marginalia" });
    folder.value = sg ? str(sg.get("obsidianFolder")) : "";
    var where = h("div", { class: "settings__hint" });
    function showWhere() {
      where.textContent = "One note per book or deck, for example " + O.notePath(folder.value, "Book nickname") +
        (str(folder.value).trim() ? "" : " (the vault’s top folder)") + ". Sending a note again updates its copy in the note that holds it, also after a rename or a folder change.";
    }
    folder.addEventListener("change", function () {
      if (!sg) return;
      if (sg.set("obsidianFolder", folder.value) === false) toast("That folder name is too long");
      folder.value = str(sg.get("obsidianFolder"));
      showWhere();
    });
    folder.addEventListener("input", showWhere);
    folder.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); folder.blur(); } });
    showWhere();
    var again = h("button", { type: "button", class: "btn", text: "Check again" });

    function setVault(v) { if (sg) tryCall(function () { sg.set("obsidianVault", v); }); }
    function fill(d) {
      if (!document.contains(pane)) return;
      clear(vaultSlot);
      // the vault's name exactly as stored (as Obsidian lists it: doubled, leading or trailing spaces stay); blank = none
      var wanted = sg ? str(sg.get("obsidianVault")) : "";
      if (!wanted.trim()) wanted = "";
      if (d && d.mode === "server") {
        method.textContent = O.METHOD_SERVER;
        method.className = "settings__status settings__method settings__status--ok";
        var sel = h("select", { class: "settings__select", "aria-label": "Vault" });
        var names = d.vaults.map(function (v) { return v.name; });
        if (wanted && names.indexOf(wanted) < 0) sel.appendChild(h("option", { value: wanted, text: wanted + " — not found" }));
        else if (!wanted && names.length > 1) sel.appendChild(h("option", { value: "", text: "Choose a vault…" }));
        d.vaults.forEach(function (v) { sel.appendChild(h("option", { value: v.name, text: v.name + (v.open ? " (open)" : "") })); });
        sel.value = wanted || (names.length === 1 ? names[0] : "");
        sel.addEventListener("change", function () { setVault(sel.value); });
        vaultSlot.appendChild(h("label", { class: "settings__label" }, ["Vault ", sel]));
        vaultHint.textContent = names.length === 1 && !wanted ? "The only vault on this Mac." : "Vaults found in Obsidian’s list on this Mac.";
      } else {
        // an older serve.py serves this page: plain "marginalia" would only reopen it, so the line says to restart it
        method.textContent = d && d.outdated && O.METHOD_RESTART ? O.METHOD_RESTART : O.METHOD_LINK;
        method.className = "settings__status settings__method";
        var input = h("input", { type: "text", class: "settings__input", "aria-label": "Vault name", spellcheck: "false", autocomplete: "off", placeholder: "Obsidian Vault" });
        input.value = wanted;
        input.addEventListener("change", function () { setVault(input.value); input.value = sg ? str(sg.get("obsidianVault")) : input.value; });
        input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); input.blur(); } });
        vaultSlot.appendChild(h("label", { class: "settings__label" }, ["Vault name ", input]));
        vaultHint.textContent = (d && d.server ? "Marginalia’s server found no Obsidian vault on this Mac. " : "") +
          "The vault’s name as Obsidian shows it; left empty, Obsidian uses the vault it has open. Images are sent as “[image]”, and sending again adds a second copy.";
      }
    }
    // Shows the switch as the connection is and, only while it is on, asks for the vaults (force: a fresh check).
    function check(force) {
      if (!paintSwitch()) return;                 // D32: off (also a pane that still shows its rows): nothing is asked
      method.textContent = "Checking for Marginalia’s server…";
      method.className = "settings__status settings__method";
      again.disabled = true;
      Promise.resolve(tryCall(function () { return O.detect(force ? { force: true } : undefined); }, null)).then(function (d) {
        again.disabled = false;
        fill(d || { mode: "link", vaults: [] });
      }, function () { again.disabled = false; fill({ mode: "link", vaults: [] }); });
    }
    again.addEventListener("click", function () { check(true); });
    function paintSwitch() {
      var on = obsidianOn();
      sw.checked = on;
      body.classList.toggle("is-hidden", !on);
      offHint.classList.toggle("is-hidden", on);
      return on;
    }
    var own = false;                              // this pane's own change is under way: its handler repaints
    sw.addEventListener("change", function () {
      own = true;
      if (sg) tryCall(function () { sg.set("obsidian", !!sw.checked); });   // a tab that stepped aside stores nothing: the switch goes back
      own = false;
      check(true);
    });
    // the switch changed somewhere else (settings:changed "obsidian"): show it, and check for vaults when it is on
    if (st.settings) st.settings.paintObsidian = function () { if (!own) check(true); };
    pane.appendChild(h("div", { class: "settings__row" }, [h("label", { class: "settings__check" }, [sw, " Connect Marginalia to Obsidian"]), offHint]));
    body.appendChild(method);
    body.appendChild(vaultSlot);
    body.appendChild(vaultHint);
    body.appendChild(h("div", { class: "settings__row" }, [h("label", { class: "settings__label" }, ["Folder inside the vault ", folder]), where]));
    body.appendChild(h("div", { class: "settings__row settings__row--inline" }, [h("span", { class: "settings__hint", text: "O in the reader writes a note for Obsidian; every card menu has “Send to Obsidian”." }), again]));
    pane.appendChild(body);
    check(false);                                 // the check openSettings started (or its cached result) fills the pane
    return pane;
  }

  // ---- Data

  function buildDataPane() {
    var exportBtn = h("button", { type: "button", class: "btn btn--primary", text: "Export…" });
    exportBtn.addEventListener("click", function () { openExport({ scope: "all" }); });
    var importBtn = h("button", { type: "button", class: "btn", text: "Import…" });
    importBtn.addEventListener("click", function () { openExport({ scope: "all", tab: "import" }); });
    var usage = h("div", { class: "settings__status", "aria-live": "polite", text: "Measuring storage…" });
    var persistBtn = h("button", { type: "button", class: "btn settings__persist", text: "Request persistent storage" });
    persistBtn.classList.add("is-hidden");
    function refreshUsage() {
      var store = M.store;
      if (!store || typeof store.estimate !== "function") { usage.textContent = "Storage usage unknown"; return; }
      Promise.resolve(tryCall(function () { return store.estimate(); }, null)).then(function (e) {
        usage.textContent = storageLine(e);
        persistBtn.classList.toggle("is-hidden", !e || e.persisted === true || typeof store.persist !== "function");
      }, function () { usage.textContent = "Storage usage unknown"; });
    }
    persistBtn.addEventListener("click", function () {
      persistBtn.disabled = true;
      Promise.resolve(tryCall(function () { return M.store.persist(); }, false)).then(function (ok) {
        persistBtn.disabled = false;
        usage.textContent = ok ? "Persistent storage granted" : "The browser did not grant persistent storage";
        setTimeout(refreshUsage, 1500);
      }, function () { persistBtn.disabled = false; });
    });
    refreshUsage();
    var auto = buildBackupBlock();
    if (auto && st.settings) st.settings.paintBackup = auto.paint;
    if (auto) auto.recheck();
    var pane = h("div", { class: "settings__pane settings__pane--data" }, [
      h("div", { class: "settings__row" }, [h("div", { class: "settings__label", text: "Backup" }), h("div", { class: "settings__actions" }, [exportBtn, importBtn])]),
      h("div", { class: "settings__hint", text: "JSON backups hold prompts, review history, images, folders and settings — never the PDF bytes or the API key. Anki TSV and Markdown are one-way exports." }),
      auto ? auto.el : null,
      h("div", { class: "settings__row" }, [h("div", { class: "settings__label", text: "Storage" }), usage, persistBtn])
    ]);
    if (isSafari()) pane.appendChild(h("div", { class: "settings__hint", text: "Safari may evict IndexedDB data after 7 days without a visit — export regularly." }));
    return pane;
  }

  // ---- Automatic backup (M.backup, js/backup.js): Marginalia's server saves the JSON backup into a folder once a day

  // The block's status line for M.backup.state() ({status: "checking"|"on"|"off"|"outdated"|"unavailable", dir, today,
  // last: {name, date, bytes}|null, error}).
  function backupLine(s) {
    var status = str(s && s.status);
    if (status === "on") {
      var lastFile = s.last && typeof s.last === "object" ? s.last : null;
      return "Every day to " + (str(s.dir) || "the backup folder") + " · " +
        (lastFile ? "last: " + str(lastFile.date || lastFile.name) + " (" + fmtBytes(lastFile.bytes) + ")" : "no backup yet");
    }
    if (status === "off") return "Off";
    if (status === "outdated") return "Restart Marginalia (marginalia restart in Terminal) to turn on automatic backups";
    if (status === "unavailable") return "Needs the marginalia command — not available in the claude.ai copy or a saved file";
    return "Checking for Marginalia’s server…";
  }
  // A second line under the status: why today's automatic backup failed (on / off), or why the server cannot back up
  // when the status line does not already say it (unavailable for another reason than the claude.ai copy or a file).
  function backupProblem(s) {
    var status = str(s && s.status), why = collapse(s && s.error);
    if (!why) return "";
    if (status === "on" || status === "off") return "Today’s automatic backup failed — " + why;
    if (status === "unavailable" && s.reason !== "artifact" && s.reason !== "file") return why.charAt(0).toUpperCase() + why.slice(1);
    return "";
  }
  // FEATURES B9.6: the PDFs line, from state().pdfs ({saved, bytes, dir, running, left, error, outdated} | null): while
  // the server answers (on or off) and has listed them, "PDFs: <N> saved in <dir>/PDFs (<total size>)", with
  // " · saving <k> more…" while an upload run has books left; the restart advice for a serve.py from before PDF backups;
  // otherwise nothing (the line hides).
  function pdfLine(s) {
    var status = str(s && s.status), p = s && s.pdfs;
    if ((status !== "on" && status !== "off") || !p || typeof p !== "object") return "";
    if (p.outdated) return "PDFs: restart Marginalia (marginalia restart in Terminal) to back them up too";
    if (!isNum(p.saved)) return "";
    var dir = str(p.dir || s.dir).replace(/\/+$/, "");
    var line = "PDFs: " + p.saved + " saved in " + (dir || "the backup folder") + "/PDFs (" + fmtBytes(isNum(p.bytes) ? p.bytes : 0) + ")";
    if (p.running === true && isNum(p.left) && p.left > 0) line += " · saving " + p.left + " more…";
    return line;
  }
  // why the last run could not save every PDF (on / off), else ""
  function pdfProblem(s) {
    var status = str(s && s.status), why = collapse(s && s.pdfs && s.pdfs.error);
    if ((status !== "on" && status !== "off") || !why) return "";
    return why.charAt(0).toUpperCase() + why.slice(1);
  }
  // Settings › Data › "Automatic backup": the status line, a switch "Back up automatically every day"
  // (M.backup.setEnabled), "Back up now" (M.backup.runNow, toasting the result) and how to restore. → {el, paint} |
  // null without M.backup (an older bundle, a test): then the pane has no such block. The "backup:state" event repaints
  // it, and opening it asks the server again (M.backup.refresh, when there is one), as the Obsidian tab does.
  function buildBackupBlock() {
    var B = M.backup;
    if (!B || typeof B.state !== "function") return null;
    var line = h("div", { class: "settings__status settings__backup-status", "aria-live": "polite" });
    var problem = h("div", { class: "settings__status settings__status--bad settings__backup-error is-hidden" });
    // FEATURES B9.6: the PDFs the backup folder keeps (state().pdfs), and why the last run could not save them all
    var pdfs = h("div", { class: "settings__status settings__backup-pdfs is-hidden", "aria-live": "polite" });
    var pdfError = h("div", { class: "settings__status settings__status--bad settings__backup-pdf-error is-hidden" });
    var sw = h("input", { type: "checkbox", role: "switch", class: "settings__backup-switch" });
    var nowBtn = h("button", { type: "button", class: "btn settings__backup-now", text: "Back up now" });
    var running = false;
    var el = h("div", { class: "settings__row settings__backup" }, [
      h("div", { class: "settings__label", text: "Automatic backup" }),
      line,
      problem,
      pdfs,
      pdfError,
      h("div", { class: "settings__row settings__row--inline settings__backup-controls" }, [
        h("label", { class: "settings__check" }, [sw, " Back up automatically every day"]), nowBtn]),
      h("div", { class: "settings__hint", text: "Each backup also saves the PDFs that are not in the folder yet. To restore: Import a file from that folder; " +
        "Marginalia then takes each book’s PDF from its PDFs folder by itself (a book whose PDF is not there says Choose file again)." })
    ]);
    function state() { return tryCall(function () { return B.state(); }, null) || {}; }
    function paint() {
      var s = state(), status = str(s.status) || "checking", busy = running || s.running === true;
      line.textContent = backupLine(s);
      line.classList.toggle("settings__status--ok", status === "on");
      var why = backupProblem(s);
      problem.textContent = why;
      problem.classList.toggle("is-hidden", !why);
      var pl = pdfLine(s), pe = pdfProblem(s);
      pdfs.textContent = pl;
      pdfs.classList.toggle("is-hidden", !pl);
      pdfError.textContent = pe;
      pdfError.classList.toggle("is-hidden", !pe);
      var sg = settings();
      sw.checked = typeof s.enabled === "boolean" ? s.enabled
        : status === "on" || (status !== "off" && !(sg && tryCall(function () { return sg.get("autoBackup"); }, true) === false));
      sw.disabled = status === "unavailable" || typeof B.setEnabled !== "function";
      nowBtn.disabled = busy || typeof B.runNow !== "function" || !(status === "on" || status === "off");
      nowBtn.textContent = busy ? "Backing up…" : "Back up now";
    }
    function where(file) {
      var dir = str(state().dir).replace(/\/+$/, ""), f = str(file);
      return dir && f && f.indexOf("/") < 0 ? dir + "/" + f : (f || dir || "the backup folder");
    }
    sw.addEventListener("change", function () {
      var on = !!sw.checked;
      tryCall(function () { B.setEnabled(on); });
      paint();
    });
    nowBtn.addEventListener("click", function () {
      if (running || typeof B.runNow !== "function") return;
      running = true;
      paint();
      tryPromise(function () { return B.runNow(); }, "backup").then(function (r) {
        running = false;
        paint();
        if (r && r.ok) toast("Backed up · " + where(r.file) + (isNum(r.bytes) ? " (" + fmtBytes(r.bytes) + ")" : ""), [], 6000, "backup");
        else toast("Backup failed — " + ((r && r.error) || "unexpected error"), [], 10000, "backup");
      }, function (e) {
        running = false;
        paint();
        toast("Backup failed — " + ((e && e.message) || "unexpected error"), [], 10000, "backup");
      });
    });
    paint();
    // called once the pane listens for "backup:state" (buildDataPane): the fresh answer repaints the block
    function recheck() { if (typeof B.refresh === "function") tryCall(function () { Promise.resolve(B.refresh()).catch(noop); }); }
    return { el: el, paint: paint, recheck: recheck };
  }

  // ------------------------------------------------------------------ api

  var api = {
    render: render,
    openDeck: openDeck,
    createDeck: createDeck,
    renameCollection: renameCollection,
    deleteCollection: deleteCollection,
    addPdf: addPdf,
    openSettings: openSettings,
    // BUILD-NOTES extras
    addPdfFromUrl: addPdfFromUrl,
    closeSettings: closeSettings,
    activeEditor: activeEditor,
    // extensions (documented in the engineer's report)
    isSettingsOpen: isSettingsOpen,
    undoDelete: undoDelete,
    sendAllToObsidian: sendAllToObsidian,
    attachPdf: attachPdf,              // FEATURES B9.5: a book's PDF from the backup folder (M.backup)
    // FEATURES L1 (BUILD-NOTES "Library folders")
    createFolder: createFolder,
    renameFolder: renameFolder,
    deleteFolder: deleteFolder,
    moveTo: moveTo,
    openPicker: openPicker,
    closePicker: closePicker,
    toggleFolder: toggleFolder,
    showNewFolderField: showNewFolderField,
    OPEN_KEY: OPEN_KEY,
    _pure: {
      folderCompare: folderCompare, folderTree: folderTree, folderTotals: folderTotals, folderMeta: folderMeta,
      sendAllConfirm: sendAllConfirm, sendAllNothing: sendAllNothing, backupLine: backupLine, backupProblem: backupProblem,
      pdfLine: pdfLine, pdfProblem: pdfProblem,
      nicknameFor: nicknameFor, saneTitle: saneTitle, mergeSections: mergeSections, sortCollections: sortCollections,
      bookMeta: bookMeta, deckMeta: deckMeta, bookRecord: bookRecord, decideDuplicate: decideDuplicate,
      applyBinding: applyBinding, sameBinding: sameBinding, presetName: presetName, normalizeTab: normalizeTab,
      fileNameFromUrl: fileNameFromUrl, isPdfFile: isPdfFile, looksLikePdf: looksLikePdf, fingerprintOf: fingerprintOf,
      storageLine: storageLine, deckCountsText: deckCountsText, lostAfterReplace: lostAfterReplace,
      manualMarks: manualMarks, withoutMark: withoutMark, withMark: withMark, markMenuLabel: markMenuLabel
    }
  };
  M.library = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.library + BUILD-NOTES extras): render(); openDeck(id); createDeck(name) → Promise<Collection>;
 * renameCollection(id, name) → Promise; deleteCollection(id) → Promise<boolean> (in-page confirm naming the prompt
 * count, "Deleted · Undo (Z)" toast; Z on #library/#deck undoes); addPdf(file) → Promise<Collection|null>; openSettings(tab);
 * addPdfFromUrl(url) → Promise; closeSettings(); activeEditor() → Editor|null.
 * Extensions: isSettingsOpen(), undoDelete() → boolean (restores the collection whose "Deleted · Undo (Z)" still
 * shows; M.app can route the library owner's Z to it), _pure helpers for tests. openSettings("obsidian") shows the
 * Obsidian tab (BUILD-NOTES "Obsidian"; its method line is M.obsidian.METHOD_RESTART when detect() says outdated).
 * sendAllToObsidian(collectionId) → Promise<result|null>: the "Send all to Obsidian" item of the book row, deck row and
 * deck page ⋯ menus (after Export…; absent without M.obsidian.sendAll, disabled with no live prompt or while that
 * send-all runs): M.obsidian.planAll → M.app.confirm "Send N cards to Obsidian?" (OK "Send"; server: "A new ones are
 * added and U edited ones are updated in place, in <file>. K already there are skipped.") → M.obsidian.sendAll(id,
 * {fromGesture: true}); with nothing new or edited no confirm and no request, only a toast ("Everything in “<name>” is
 * already in Obsidian"; _pure.sendAllNothing). FEATURES A9: planAll's rechecked cards (server) are a part of the confirm,
 * its held cards (link) the A9.1 line of the confirm, or the toast's text (12 s) when no card would go. FEATURES A10.1:
 * planAll's {importing: true} (an import is saving) toasts M.obsidian.WAIT_IMPORT "Wait until the import finishes, then
 * send again." instead of a confirm. Settings › Data shows
 * an "Automatic backup" block when M.backup is loaded (state() status line, a switch → setEnabled(bool), "Back up now" →
 * runNow() with a toast; repainted on "backup:state"; FEATURES B9.6: the PDFs line "PDFs: <N> saved in <dir>/PDFs
 * (<total size>)" from state().pdfs, " · saving <k> more…" while an upload runs, and a red line when the last run could
 * not save them all; _pure.pdfLine, _pure.pdfProblem).
 * Extension (FEATURES B9.5, BUILD-NOTES "Automatic backup"): attachPdf(collectionId, bytes) → Promise<record> attaches a
 * PDF from the backup folder to a live book without its bytes, as "Choose file again" attaches the same file: refused
 * (codes not_found, has_bytes, locked, busy, no_store, not_pdf, too_large, mismatch, changed) unless the bytes look like a
 * PDF, are at most 300 MB and hash (SHA-256) to the book's sha256; the PDF is not opened (same SHA-256, same file: the
 * record keeps its metadata); M.store.docs.saveDocument then M.cache.saveCollection; st.busy held meanwhile. Repair
 * B9-R1 / LIB-1: once the PDF is stored, only byteLength, chunkCount, chunkSize and hasBytes join the record M.cache
 * holds THEN (in place; the promise answers that record), so a rename, move or import made during the store write
 * stays; a delete seen meanwhile (bus "collection:deleted", undone or not) writes nothing more and rejects "changed";
 * after a store failure the book as it is now goes over the store's stub. storeBook (Choose file again, Replace file)
 * saves bookRecord(the new file, the record as it is once stored) the same way, and a book deleted before or while its
 * PDF is stored is not brought back (code "changed", toast "The book was deleted while its PDF was being stored, so
 * the PDF was not added").
 * Extension (FEATURES L1, BUILD-NOTES "Library folders"), with a cache that keeps folders (M.cache.folders …):
 * createFolder(name, parentId|null) → Promise<Folder> (opens it); renameFolder(id, name) → Promise; deleteFolder(id) →
 * Promise<boolean> (M.app.confirm "Delete folder “<name>”?" / "Its books, decks and folders move to <parent or the top
 * level>. Nothing else is deleted.", then M.cache.removeFolder; toast "Deleted the folder “<name>” · Undo (Z)");
 * moveTo(kind "collection"|"folder", id, folderId|null, {focus}) → Promise<{from, to, moved}|null> (toast "Moved “X” to
 * “Y”" / "… to the top level" with Undo); openPicker(kind, id, invoker) / closePicker() (the "Move to folder…" picker);
 * toggleFolder(id) (open state in localStorage OPEN_KEY "marginalia.openFolders"); showNewFolderField(parentId|null).
 * Repair UI-1: st.newFolder / st.newDeck are the inline fields' records ({kind, row, input, parentId, composing,
 * drop}); render() puts each back in its slot and focus back into it (only an IME composition holds a render), a "New
 * folder inside" field whose folder is no longer open goes; showNewFolderField(parentId) with the field up moves it
 * there with its text; a blank New deck / New folder field gives way to the other one. Repair UI-2/UI-3: the picker
 * keeps its ⋯'s data-focus key and screen (#library or #deck; the deck page's ⋯ is "deck:more") and finds that ⋯
 * again after a re-render; from the deck page a move closes it back to ⋯ and passes no {focus}. Repair UI-4: the
 * landing after a delete in a folder is [the folder's other rows, the folder chevrons up its path, the header button].
 * Repair UI-5: a "not_found" refusal of a move or its Undo reads "“<name>” was deleted" or "the folder “<name>” was
 * deleted". The home screen listens to folders:changed; a folder row's Review calls M.app.startReview("folder", folderId); the
 * book, deck, deck page and folder ⋯ menus have "Move to folder…" (after Send all to Obsidian; disabled with nowhere
 * else to go); rows drag (HTML5, delegated on #library) onto folder groups ([data-drop=<id>]) and the top-level
 * sections ([data-drop=""]); _pure: folderCompare, folderTree, folderTotals, folderMeta.
 * FEATURES E2.2d (the desktop app, M.desktop): the welcome card section.lib-welcome at the top of the home screen while
 * M.desktop.welcome() answers (the app, no live book / deck / prompt, not dismissed): h2 "Welcome to Marginalia", two
 * p.lib-welcome__lead (a new reader: Start with an empty library; a reader who used a browser before: the two steps),
 * the two steps, button.lib-welcome__import "Import the newest backup (<when>)" (data-focus "welcome:import"; disabled
 * with span.lib-welcome__none "No backup yet" / "Looking for a backup…" / "The backup folder cannot be read — …" / "The
 * newest backup is dated after today (<day>) — check the Mac's date and time, or use Import a backup file…";
 * "Importing the newest backup…" while it runs) → M.desktop.importLatest(), button.lib-welcome__file "Import a backup
 * file…" → the Import dialog, button.lib-welcome__empty "Start with an empty library" → M.desktop.dismissWelcome();
 * re-rendered on "desktop:state". A send-all that planAll answers {covered: true} toasts M.obsidian.COVERED.
 * BUILD-NOTES "Prompt craft" (FEATURES P1.3): Settings › Review shortcuts lists "Flag for revision" (flag) and "Delete
 * prompt" (delete) like the other review actions; the map it shows is M.keys.reviewMap(settings.reviewKeys). */
