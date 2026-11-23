/* js/desktop.js — M.desktop: Marginalia as a Mac app, and a browser page that app replaced (FEATURES E2.2; BUILD-NOTES
 * "Desktop app (binding)", part 2).
 *
 * The desktop app (desktop/, Electron) shows this page from its own copy of tools/serve.py, which it starts with
 * "--app <version>", and its preload gives the page window.marginaliaDesktop = {app: true, version, platform}. Such a
 * server answers GET /api/app with {ok: true, app: true, version} and refuses every POST that does not carry the header
 * "X-Marginalia-Client: app" (409 {ok: false, error: "app_only", message}); POST /api/backup and /api/backup/pdf also take
 * "X-Marginalia-Client: browser-move". So a browser tab on the same address (Brave, where the library lived before) can
 * never back up or send to Obsidian next to the app's library, except the one backup that moves its library over.
 *
 * Modes (mode(); start() decides it once, at boot, before anything can write):
 * - "app": the desktop app (isApp()). Every POST the page sends to its own server carries X-Marginalia-Client: app
 *   (headers(), which js/backup.js and js/obsidian.js call for each POST). Persistent storage is asked once at boot
 *   (navigator.storage.persist() when persisted() is false: askPersist()), so Chromium never evicts the library. The home
 *   screen shows the welcome card while the library holds no live book, deck or prompt and the card was not dismissed
 *   (M.library renders it from welcome(); importLatest() imports the newest backup of the backup folder; dismissWelcome()
 *   stores localStorage "marginalia.welcomeDismissed" = "1"). The card asks the backup folder again when the window
 *   comes back to the front, so a backup made in Brave meanwhile shows up.
 * - "checking", then "cover" or "browser": a normal browser page served from 127.0.0.1 or localhost (not the app, not
 *   file://, not the claude.ai artifact) asks GET /api/app once: {ok: true, app: true} → the app's server serves it, cover
 *   mode; 404, an error or no answer within CHECK_MS (3 s) → "browser", Marginalia as before. M.app's boot waits for the
 *   answer before it routes, sweeps, reads ?pdf= or starts the daily backup, M.obsidian waits for it before a send, and
 *   M.backup writes nothing until it has answered (refusesWrite(): "Marginalia is still starting — try again in a moment").
 * - "browser": everything else (file://, the artifact, another host, no fetch): nothing changes, no request, no header.
 * - "cover": #cover over the whole page, "Marginalia is now an app" (showCover()). Nothing behind it can be reached: the
 *   other #app children are inert (not #confirm and #toasts), keys, pastes and drops are caught in the capture phase (Tab
 *   cycles inside, Escape does nothing; M.app's confirm dialog, which opens above the cover, keeps its keys) and focus
 *   that lands behind it comes back. "Open the app" is a link to marginalia://open?hash=<encodeURIComponent(location.hash
 *   || "#library")> (coverLink(), kept up to date on hashchange); a page opened on a reader route (#reader/…, the "Open in
 *   Marginalia" links of Obsidian notes) follows that link once by itself (once per page load, never again, through the
 *   opener) and says "Opening this page in the Marginalia app…", with "Open the app" as the fallback. "Back up this
 *   browser's library" (backUp()): GET /api/backup (M.backup.refresh); with a backup of today in the folder, M.app.confirm
 *   "Replace today's backup?" first; then the manual JSON backup and every PDF the folder lacks, both with
 *   X-Marginalia-Client: browser-move (M.backup.runNow / savePdfs with that client), with "Saving PDFs… k of n", then the
 *   result line in the cover; an error is shown there with the server's own words, and nothing is tried again by itself.
 *   Nothing else writes: M.app routes nothing and never starts the daily backup, M.backup refuses every other write
 *   (refusesWrite()) and M.obsidian refuses every send ("Marginalia is now an app — open it to send to Obsidian.").
 *   Repairs of 2026-11-11: "a backup of today" is any listed file (M.backup.hasToday()), not only the newest by name, which
 *   a file named after today (a Mac clock once ahead) would be; with such a file the result line says to import this
 *   backup with Import a backup file…, and the app's welcome card does not offer it (SEC-1). The browser remembers its
 *   move (localStorage "marginalia.movedToApp" = {at, file}, once the JSON backup succeeded): the cover's note says when,
 *   and a later click asks "Back up this browser's library again?" (in place of "Replace today's backup?"), naming what it
 *   would replace or take (F1). A store that could not be opened (memory mode) is said to be unreadable, not empty (F5).
 *
 * Event "desktop:state" (desktop → library): state(), whenever the mode, the cover's backup, the welcome card's import
 * or what the card shows changes.
 * Test hooks: _setFetch(fn), _setOpener(fn) (what follows a marginalia:// link; no test ever opens one through macOS),
 * _setCheckMs(ms), _setNow(fn), _reset().
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  // ---------------------------------------------------------------- constants
  var APP_API = "/api/app";                     // the app's serve.py (--app): {ok: true, app: true, version}
  var CLIENT_HEADER = "X-Marginalia-Client";
  var APP_CLIENT = "app";                       // every POST of the app's own page
  var MOVE_CLIENT = "browser-move";             // the cover's backup (POST /api/backup and /api/backup/pdf only)
  var CHECK_MS = 3000;                          // GET /api/app gets this long, then the page is a plain browser page
  var LINK_BASE = "marginalia://open?hash=";
  var WELCOME_KEY = "marginalia.welcomeDismissed";
  var MOVED_KEY = "marginalia.movedToApp";      // {at, file}: this browser's library was backed up for the move (repair F1)
  var FILE_RE = /^marginalia-backup-(\d{4}-\d{2}-\d{2})\.json$/;
  var MODES = ["unknown", "checking", "app", "browser", "cover"];
  var REFRESH_GAP_MS = 2000;                    // the welcome card asks the backup folder again at most this often
  var DAY_MS = 86400000;
  var EXPORTED_RE = /"exportedAt"\s*:\s*(\d{9,16})(?!\d)/;   // M.exporter.toJSON writes it near the top
  var HEAD_CHARS = 4096;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var TOAST_ID = "desktop";
  var KEY_TOAST_ID = "desktop-key";
  var ZOTERO_API = "/api/zotero/books";         // the app's serve.py: the books' prompts, for Marginalia for Zotero (D34)
  var ZOTERO_WAIT_MS = 2000;                    // after the last change, the page says the books again
  var ZOTERO_KINDS = ["qa", "cloze", "note"];   // what counts: what the library counts as prompts (js/cache.js COUNTED)
  var ZOTERO_EVENTS = ["prompt:saved", "prompt:deleted", "prompt:restored", "collection:changed", "collection:deleted",
    "import:finished", "store:writer"];
  var SHA256_RE = /^[0-9a-f]{64}$/i;
  var TEXT = {
    title: "Marginalia is now an app",
    body: "Your library in this browser stays here, unchanged. To move it into the app:",
    steps: ["1. Click Back up this browser's library.", "2. In the app, click Import the newest backup."],
    open: "Open the app",
    backup: "Back up this browser's library",
    forwarding: "Opening this page in the Marginalia app…",
    checking: "Checking the backup folder…",
    saving: "Saving this browser's library…",
    savingPdfs: "Saving PDFs…",
    replaceTitle: "Replace today's backup?",
    replaceOk: "Replace it",
    againTitle: "Back up this browser's library again?",
    againOk: "Back up again",
    empty: "This browser's library is empty: there is nothing to move into the app.",
    storage: "this page could not open the browser's storage, so it cannot read the library. Reload the page; if that does not help, quit the browser and open it again.",
    keyReminder: "Paste your Anthropic API key again in Settings → LaTeX from snips (backups never contain it)."
  };
  var MSG = {
    no_server: "Marginalia's server did not answer",
    no_backup: "this page cannot reach the backup folder",
    not_app: "the welcome card is only in the Marginalia app",
    importing: "an import is already running",
    cannot: "this page cannot import backups"
  };

  // ---------------------------------------------------------------- state
  var st, fetchFn = null, openerFn = null, checkMs = CHECK_MS, nowFn = null, zoteroWait = ZOTERO_WAIT_MS;
  function init() {
    st = {
      mode: "unknown", version: null, started: null,
      cover: null,             // the cover's nodes and guards while it shows
      forwarded: false,        // the reader route followed the app's link (once per page load)
      busy: false,             // the cover's backup runs
      moved: null,             // {at, file}: the move's backup, as this page remembers it when storage refuses (repair F1)
      persist: null,           // the persistent-storage ask (a promise), once
      appBound: false,         // the welcome card's focus / visibility listeners
      pdfs: Promise.resolve(), // the PDFs macOS handed the app (D34), added one after the other
      zoteroTimer: null,       // the books' prompts go to the server when it fires (D34, step 2)
      zoteroSent: null,        // the body of the last POST /api/zotero/books that the server took
      dismissed: false,        // the welcome card was dismissed in this page (storage may refuse the flag)
      importing: false,        // the welcome card's import runs
      latest: null,            // {name, at}: the newest backup's file name and time (GET /api/backup/latest)
      timeAsked: null,         // the listing's last backup ("name|bytes") the time was asked for
      timeRun: null,           // that GET while it runs
      timeAgain: false,        // ask once more when it ends
      refreshedAt: -Infinity   // the card's last re-check of the folder (the window back in front)
    };
  }
  init();

  // ---------------------------------------------------------------- small helpers
  function noop() {}
  function str(v) { return v == null ? "" : String(v); }
  function now() { var t = nowFn ? Number(nowFn()) : Date.now(); return isFinite(t) ? t : Date.now(); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function plural(n, one) { return n + " " + one + (n === 1 ? "" : "s"); }
  function report(where, e) { try { console.warn("[desktop] " + where + ": " + (e && e.message ? e.message : str(e))); } catch (e2) { /* no console */ } }
  function hasDom() { return typeof document !== "undefined" && !!document && typeof document.getElementById === "function"; }
  function byId(id) { return hasDom() ? document.getElementById(id) : null; }
  function loc() { try { return root.location || null; } catch (e) { return null; } }
  function currentHash() { var l = loc(); return l ? str(l.hash) : ""; }
  function storage() { try { var s = root.localStorage; return s && typeof s.getItem === "function" ? s : null; } catch (e) { return null; } }
  function backupState() {
    var B = M.backup;
    try { return B && typeof B.state === "function" ? B.state() : null; } catch (e) { return null; }
  }
  function toast(opts) {
    var app = M.app;
    if (!app || typeof app.toast !== "function") return null;
    try { return app.toast(Object.assign({ id: TOAST_ID }, opts)); } catch (e) { return null; }
  }
  function confirmBox(opts) {
    var app = M.app;
    if (!app || typeof app.confirm !== "function") return Promise.resolve(false);
    try { return Promise.resolve(app.confirm(opts)).then(function (v) { return v === true; }, function () { return false; }); }
    catch (e) { return Promise.resolve(false); }
  }
  function isArtifact() {
    var app = M.app;
    try { return !!(app && typeof app.isArtifact === "function" && app.isArtifact()); } catch (e) { return false; }
  }
  // the local time of `ms` as HH:MM (24 hours, as the cover and the welcome card write it)
  function hhmm(ms) { var d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  // "YYYY-MM-DD" (a local day) → "10 Nov" or, in another year than `t`'s, "10 Nov 2025"
  function dateText(day, t) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(day));
    if (!m) return str(day);
    var d = new Date(+m[1], +m[2] - 1, +m[3]), n = new Date(t);
    return d.getDate() + " " + MONTHS[d.getMonth()] + (d.getFullYear() === n.getFullYear() ? "" : " " + d.getFullYear());
  }
  // "YYYY-MM-DD" (a local day) → "today", "yesterday", "10 Nov" or, in another year, "10 Nov 2025"
  function dayLabel(day, t) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(day));
    if (!m) return str(day);
    var d = new Date(+m[1], +m[2] - 1, +m[3]), n = new Date(t);
    var diff = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - d.getTime()) / DAY_MS);
    if (diff === 0) return "today";
    if (diff === 1) return "yesterday";
    return dateText(day, t);
  }
  // when the move's backup was made, for the cover: "today at 14:05", "yesterday at 18:40", "on 10 Nov at 08:00"
  function atText(ms) {
    var day = dayLabel(dayKey(ms), now());
    return (day === "today" || day === "yesterday" ? day : "on " + day) + " at " + hhmm(ms);
  }
  // the day in a backup file's name ("marginalia-backup-2026-11-12.json" → "2026-11-12"), else null
  function fileDay(name) { var m = FILE_RE.exec(str(name)); return m ? m[1] : null; }
  // Repair SEC-1: the newest listed backup (GET /api/backup's last, the file GET /api/backup/latest sends) is named for a
  // day after the server's today, by a Mac clock that was once ahead or in a time zone further east → that day ("12 Nov"),
  // else null. Such a file sorts before today's, so it is never the backup Brave's cover just wrote.
  function aheadDay(s) {
    var last = s && s.last, today = s && typeof s.today === "string" ? s.today : "";
    var day = last && typeof last.date === "string" ? last.date : "";
    return today && day && day > today ? dateText(day, now()) : null;
  }
  // The newest backup's date and time for the welcome card: "today, 14:05" (the time when known), else the day alone.
  function whenText(day, at) {
    var t = now();
    if (typeof at === "number" && isFinite(at)) return dayLabel(dayKey(at), t) + ", " + hhmm(at);
    return dayLabel(day, t);
  }
  // When a JSON backup was made: its own "exportedAt" (ms), which M.exporter.toJSON writes near the top of the file and
  // the server keeps exactly (it writes the backup's own text). GET /api/backup lists a date per file, no time.
  function madeAt(text) {
    var m = EXPORTED_RE.exec(str(text).slice(0, HEAD_CHARS));
    var ms = m ? Number(m[1]) : NaN;
    return isFinite(ms) && ms > 0 ? ms : null;
  }

  // At least one live (not deleted) book, deck or prompt: the welcome card shows only while there is none.
  function libraryHasData() {
    var C = M.cache;
    function anyLive(fn) {
      var list;
      try { list = C && typeof C[fn] === "function" ? C[fn]() : []; } catch (e) { list = []; }
      if (!Array.isArray(list)) return false;
      for (var i = 0; i < list.length; i++) if (list[i] && !list[i].deletedAt) return true;
      return false;
    }
    return anyLive("collections") || anyLive("prompts");
  }
  // The live books, decks and prompts (the cover's result line).
  function libraryCounts() {
    var C = M.cache, out = { books: 0, decks: 0, prompts: 0 }, cols = [], ps = [];
    try { cols = C && typeof C.collections === "function" ? C.collections() : []; } catch (e) { cols = []; }
    try { ps = C && typeof C.prompts === "function" ? C.prompts() : []; } catch (e) { ps = []; }
    (Array.isArray(cols) ? cols : []).forEach(function (c) {
      if (!c || c.deletedAt) return;
      if (c.kind === "book") out.books++;
      else if (c.kind === "deck") out.decks++;
    });
    (Array.isArray(ps) ? ps : []).forEach(function (p) { if (p && !p.deletedAt) out.prompts++; });
    return out;
  }

  // DOM builder: attrs {class, text, id, role, aria-*, href, …}; children = node | string | array (text only, never HTML)
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "text") el.textContent = String(v);
        else if (k === "class") String(v).split(/\s+/).filter(Boolean).forEach(function (c) { el.classList.add(c); });
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
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try { return el.getClientRects().length > 0; } catch (e) { return false; }
  }
  function focusEl(el) {
    if (!el || typeof el.focus !== "function") return false;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { return false; } }
    return document.activeElement === el;
  }
  function prevent(ev) { try { ev.preventDefault(); } catch (e) { /* synthetic event */ } }
  function stop(ev) { try { ev.stopPropagation(); } catch (e) { /* synthetic event */ } }

  // ---------------------------------------------------------------- server
  function doFetch(url, init) {
    var f = fetchFn || root.fetch;
    return Promise.resolve().then(function () { return f.call(root, url, init); });
  }
  function readJson(r) {
    var p = null;
    try { p = r && typeof r.json === "function" ? r.json() : null; } catch (e) { p = null; }
    return Promise.resolve(p).then(null, function () { return null; });
  }

  // ---------------------------------------------------------------- the mode
  // window.marginaliaDesktop && window.marginaliaDesktop.app === true: the desktop app's preload put it there
  function isApp() {
    var d = null;
    try { d = root.marginaliaDesktop; } catch (e) { d = null; }
    return !!d && typeof d === "object" && d.app === true;
  }
  // A page the app may have replaced: a normal browser page that a Marginalia server on this Mac serves.
  function checkable() {
    if (isApp() || isArtifact()) return false;
    var l = loc(), proto = l ? str(l.protocol) : "", host = l ? str(l.hostname) : "";
    if (proto !== "http:" && proto !== "https:") return false;
    if (host !== "127.0.0.1" && host !== "localhost") return false;
    return typeof (fetchFn || root.fetch) === "function";
  }
  // GET /api/app once: "cover" when the app's server answers {ok: true, app: true}, else (404, an error, an answer that
  // says otherwise, no answer within checkMs) "browser". Never rejects.
  function check() {
    return new Promise(function (resolve) {
      var done = false, ctl = null, timer = null;
      function finish(mode, version) {
        if (done) return;
        done = true;
        if (timer != null) { try { root.clearTimeout(timer); } catch (e) { /* ignore */ } }
        if (mode === "cover") st.version = version || null;
        resolve(mode);
      }
      try { ctl = typeof root.AbortController === "function" ? new root.AbortController() : null; } catch (e) { ctl = null; }
      try {
        timer = root.setTimeout(function () {
          try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ }
          finish("browser");
        }, checkMs);
      } catch (e) { timer = null; }
      var init = { method: "GET", headers: { "X-Marginalia": "1" }, cache: "no-store", credentials: "same-origin" };
      if (ctl) init.signal = ctl.signal;
      doFetch(APP_API, init).then(function (r) {
        if (!r || !r.ok) { finish("browser"); return null; }
        return readJson(r).then(function (j) {
          if (j && j.ok === true && j.app === true) finish("cover", typeof j.version === "string" ? j.version : null);
          else finish("browser");
        });
      }).then(null, function () { finish("browser"); });
    });
  }
  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) mode = "browser";
    if (st.mode === mode) return;
    st.mode = mode;
    changed();
  }
  // start() → Promise<mode>, once per page: the app ("app"), the app check of a page the app may have replaced ("cover"
  // or "browser"), or nothing to ask ("browser"). Never rejects.
  function start() {
    if (st.started) return st.started;
    var mode = isApp() ? "app" : (checkable() ? null : "browser");
    if (mode) {
      setMode(mode);
      if (mode === "app") { askPersist(); bindApp(); }
      st.started = Promise.resolve(mode);
      return st.started;
    }
    setMode("checking");
    st.started = check().then(function (m) { setMode(m); return m; }, function () { setMode("browser"); return "browser"; });
    return st.started;
  }
  // The answer of start() (at once, "unknown", before start())
  function ready() { return st.started || Promise.resolve(st.mode); }
  function covered() { return st.mode === "cover"; }

  // The headers of a POST to the page's own server: `base` plus X-Marginalia-Client: the client given ("app" or
  // "browser-move"), else "app" in the desktop app, else none (the headers exactly as given).
  function headers(base, client) {
    var out = {};
    if (base && typeof base === "object") Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    var c = client === MOVE_CLIENT || client === APP_CLIENT ? client : (isApp() ? APP_CLIENT : null);
    if (c) out[CLIENT_HEADER] = c;
    return out;
  }
  // In cover mode the server gets no write but the cover's own backup (client "browser-move"), and none at all before the
  // page's app check has answered (mode "checking", at most 3 s at boot).
  function refusesWrite(client) { return (st.mode === "cover" || st.mode === "checking") && client !== MOVE_CLIENT; }

  function state() {
    return { mode: st.mode, version: st.version, app: isApp(), covered: st.mode === "cover", busy: st.busy,
      forwarded: st.forwarded, importing: st.importing };
  }
  function changed() {
    var bus = M.bus;
    if (bus && typeof bus.emit === "function") { try { bus.emit("desktop:state", state()); } catch (e) { report("desktop:state", e); } }
  }

  // ---------------------------------------------------------------- persistent storage (the app)
  // FEATURES E2.2e: once, at boot in the app: navigator.storage.persist() when navigator.storage.persisted() is false.
  // → Promise<true (persisted) | false (refused) | null (not asked)>, the same promise every time. Never rejects.
  function askPersist() {
    if (st.persist) return st.persist;
    var s = null;
    try { s = root.navigator ? root.navigator.storage : null; } catch (e) { s = null; }
    if (!isApp() || !s || typeof s.persisted !== "function" || typeof s.persist !== "function") { st.persist = Promise.resolve(null); return st.persist; }
    st.persist = Promise.resolve().then(function () { return s.persisted(); }).then(function (yes) {
      if (yes !== false) return yes === true ? true : null;
      return Promise.resolve().then(function () { return s.persist(); }).then(function (ok) { return ok === true; });
    }).then(null, function () { return null; });
    return st.persist;
  }

  // ---------------------------------------------------------------- the cover (a browser page the app replaced)
  // marginalia://open?hash=<encodeURIComponent(hash || "#library")>; hash defaults to location.hash
  function coverLink(hash) {
    var hs = hash === undefined ? currentHash() : str(hash);
    return LINK_BASE + encodeURIComponent(hs || "#library");
  }
  // What follows a marginalia:// link: a temporary <a href> click (the cover's own link is the user's click).
  function defaultOpener(uri) {
    if (!hasDom() || !document.body) return false;
    var a = document.createElement("a");
    a.setAttribute("href", uri);
    a.setAttribute("rel", "noopener noreferrer");
    a.style.display = "none";
    document.body.appendChild(a);
    try { a.click(); } finally { try { root.setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0); } catch (e) { /* ignore */ } }
    return true;
  }
  function openLink(uri) { try { return (openerFn || defaultOpener)(uri) !== false; } catch (e) { report("open", e); return false; } }
  function onReaderRoute() {
    var hash = currentHash(), app = M.app, r = null;
    try { r = app && typeof app.parseHash === "function" ? app.parseHash(hash) : null; } catch (e) { r = null; }
    if (r) return r.screen === "reader" && !!(r.params && r.params.collectionId);
    return /^#\/?reader\/[^/]/.test(hash);
  }
  function confirmEl() { return byId("confirm"); }
  function confirmOpen() { var c = confirmEl(); return !!c && !c.classList.contains("is-hidden"); }
  // M.app's "Marginalia is open in another tab" notice (#tabLock) is up: it sits above the cover and keeps its own guards
  function tabLockUp() {
    var app = M.app;
    try { return !!(app && typeof app.tabLock === "function" && app.tabLock()); } catch (e) { return false; }
  }
  function inConfirm(t) { var c = confirmEl(); try { return !!c && !!t && c.contains(t); } catch (e) { return false; } }
  function inCover(t) { var c = st.cover; try { return !!c && !!t && t !== document && c.host.contains(t); } catch (e) { return false; } }
  function focusCover() { var c = st.cover; return !!c && (focusEl(c.link) || focusEl(c.panel)); }
  // the controls Tab reaches inside `container`, in document order: links with an href, buttons, fields and [tabindex],
  // not disabled, not tabindex -1, shown
  function focusables(container) {
    var out = [];
    (function walk(n) {
      var kids = n && n.childNodes ? n.childNodes : [];
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (!el || el.nodeType !== 1) continue;
        var tag = str(el.tagName).toUpperCase(), ti = el.getAttribute("tabindex");
        var can = (tag === "A" && el.getAttribute("href") != null) || tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" ||
          tag === "TEXTAREA" || ti != null;
        if (can && !el.disabled && ti !== "-1" && isVisible(el)) out.push(el);
        walk(el);
      }
    })(container);
    return out;
  }
  function trapTab(ev, container) {
    var list = focusables(container);
    prevent(ev);
    if (!list.length) { focusEl(container); return; }
    var idx = list.indexOf(document.activeElement), next;
    if (ev.shiftKey) next = idx <= 0 ? list[list.length - 1] : list[idx - 1];
    else next = idx < 0 || idx >= list.length - 1 ? list[0] : list[idx + 1];
    focusEl(next);
  }
  // Keys while the cover shows (capture phase, on window): with M.app's confirm open they go to it; else Tab cycles
  // inside the cover, Escape and every plain key aimed elsewhere are swallowed (focus comes back), Enter / Space on the
  // cover's own link and button and browser shortcuts (Cmd / Ctrl) keep their native behaviour; none reaches M.app.
  function coverKey(ev) {
    var c = st.cover;
    if (!c || !ev || confirmOpen() || tabLockUp()) return;
    var inside = inCover(ev.target);
    if (ev.key === "Tab") { trapTab(ev, c.panel); stop(ev); return; }
    if (ev.key === "Escape" || (!inside && !ev.metaKey && !ev.ctrlKey)) prevent(ev);
    if (!inside) focusCover();
    stop(ev);
  }
  function lines(c, status, note, error) {
    c.status.textContent = str(status);
    c.note.textContent = str(note);
    c.error.textContent = str(error);
  }
  function paintCover() {
    var c = st.cover;
    if (!c) return;
    c.backupBtn.disabled = st.busy;
    c.link.setAttribute("href", coverLink());
  }
  // showCover() → boolean: builds the cover in #cover (cover mode only, once); see the header.
  function showCover() {
    if (st.cover) return true;
    if (st.mode !== "cover" || !hasDom()) return false;
    var appEl = byId("app") || document.body, host = byId("cover");
    if (!host) { host = h("div", { id: "cover" }); appEl.appendChild(host); }
    while (host.firstChild) host.removeChild(host.firstChild);
    host.classList.remove("is-hidden");
    host.classList.add("cover");
    var panel = h("div", { "class": "cover__panel", role: "alertdialog", "aria-modal": "true",
      "aria-labelledby": "coverTitle", "aria-describedby": "coverBody", tabindex: "-1" });
    var forward = h("p", { "class": "cover__forward is-hidden", text: TEXT.forwarding });
    var link = h("a", { "class": "btn btn--primary cover__open", href: coverLink(), text: TEXT.open });
    var backupBtn = h("button", { type: "button", "class": "btn cover__backup", text: TEXT.backup });
    var status = h("p", { "class": "cover__status", role: "status", "aria-live": "polite" });
    var note = h("p", { "class": "cover__note", text: idleNote() });   // when this browser's library was backed up for the move
    var error = h("p", { "class": "cover__error", role: "alert" });
    panel.appendChild(h("h1", { "class": "cover__title", id: "coverTitle", text: TEXT.title }));
    panel.appendChild(forward);
    panel.appendChild(h("div", { "class": "cover__body", id: "coverBody" }, [
      h("p", { "class": "cover__text", text: TEXT.body }),
      h("ol", { "class": "cover__steps" }, TEXT.steps.map(function (s) { return h("li", { text: s }); }))
    ]));
    panel.appendChild(h("div", { "class": "cover__actions" }, [link, backupBtn]));
    panel.appendChild(status);
    panel.appendChild(note);
    panel.appendChild(error);
    host.appendChild(panel);
    var c = { host: host, panel: panel, link: link, backupBtn: backupBtn, forward: forward, status: status, note: note, error: error };
    c.onKey = function (ev) { coverKey(ev); };
    c.onBlock = function (ev) {
      if (!ev || (confirmOpen() && inConfirm(ev.target))) return;
      prevent(ev);
      stop(ev);
    };
    c.onFocus = function (ev) {
      var t = ev && ev.target;
      if (!t || t === document || t === root || inCover(t) || (confirmOpen() && inConfirm(t)) || tabLockUp()) return;
      focusCover();
    };
    c.onHash = function () { paintCover(); };
    st.cover = c;
    backupBtn.addEventListener("click", function () { backUp(); });
    Array.prototype.slice.call(appEl.children || []).forEach(function (el) {
      if (!el || el === host || el.id === "confirm" || el.id === "toasts" || typeof el.setAttribute !== "function") return;
      try { el.setAttribute("inert", ""); } catch (e) { /* the cover and the guards still hold */ }
    });
    try {
      root.addEventListener("keydown", c.onKey, true);
      ["paste", "drop", "dragover"].forEach(function (t) { root.addEventListener(t, c.onBlock, true); });
      root.addEventListener("hashchange", c.onHash);
      document.addEventListener("focusin", c.onFocus, true);
    } catch (e) { report("cover guards", e); }
    // a reader route (an "Open in Marginalia" link from Obsidian) goes to the app by itself, once per page load
    if (!st.forwarded && onReaderRoute()) {
      st.forwarded = true;
      forward.classList.remove("is-hidden");
      openLink(coverLink());
    }
    focusCover();
    changed();
    return true;
  }

  // The listing holds a backup of the server's today: any listed file (M.backup.hasToday()), not only its newest by name,
  // which a file named after today would be (repair SEC-1); the newest alone only without hasToday (an older M.backup).
  function hasTodayBackup(s) {
    var B = M.backup;
    if (B && typeof B.hasToday === "function") { try { return B.hasToday() === true; } catch (e) { /* below */ } }
    return !!(s && typeof s.today === "string" && s.today && s.last && s.last.name === "marginalia-backup-" + s.today + ".json");
  }
  // Repair F5: the store could not open this browser's IndexedDB and runs in memory (js/store.js), so it holds none of
  // the library stored here: the cover cannot back it up, and must not call it empty.
  function storeUnreadable() {
    var S = M.store;
    try { return !!(S && typeof S.mode === "function" && S.mode() === "memory"); } catch (e) { return false; }
  }
  // Repair F1: this browser's library was backed up for the move. localStorage MOVED_KEY = {at, file}, written once the
  // cover's JSON backup succeeded (this page keeps its own copy when storage refuses). → {at, file} | null
  function movedRecord() {
    var s = storage(), raw = null;
    if (s) { try { raw = s.getItem(MOVED_KEY); } catch (e) { raw = null; } }
    if (raw == null) return st.moved;
    try {
      var m = JSON.parse(raw), at = m && typeof m.at === "number" && isFinite(m.at) && m.at > 0 ? m.at : null;
      return at ? { at: at, file: typeof m.file === "string" ? m.file : null } : st.moved;
    } catch (e) { return st.moved; }
  }
  function rememberMove(at, file) {
    st.moved = { at: at, file: typeof file === "string" ? file : null };
    var s = storage();
    if (s) { try { s.setItem(MOVED_KEY, JSON.stringify(st.moved)); } catch (e) { /* this page remembers it */ } }
  }
  // the cover's note while nothing else shows there: when this browser's library was backed up for the move, if it was
  function idleNote() {
    var m = movedRecord();
    return m ? "This browser's library was backed up for the move " + atText(m.at) + ". Once the app has imported it, the app keeps your library, so there is no need to back it up again." : "";
  }
  // The contract's question before today's backup is replaced (FEATURES E2.2c), and, once this browser's library was
  // backed up for the move, the one asked instead before it is backed up again (repair F1): after the move the app keeps
  // the library and backs it up, so a backup from here would put this browser's older library in the app's place.
  function replaceQuestion(at) {
    return { title: TEXT.replaceTitle, ok: TEXT.replaceOk,
      body: "Today's backup" + (at ? " (made at " + hhmm(at) + ")" : "") + " is replaced with this browser's library. The app's own library does not change." };
  }
  function againQuestion(moved, today, at) {
    return { title: TEXT.againTitle, ok: TEXT.againOk, danger: true, body: [
      "This browser's library was already backed up for the move " + atText(moved.at) + ". Once the app has imported it, the app keeps your library and backs it up itself.",
      today ? "Backing up again replaces today's backup" + (at ? " (made at " + hhmm(at) + ")" : "") + ", which may be the app's own, with this browser's " +
        "library, and saved PDFs that only that backup lists may be removed from the backup folder."
        : "Backing up again makes this browser's library today's backup, and the app then makes no backup of its own today.",
      "The app's own library does not change. Do this only if the move did not work."
    ].join("\n") };
  }
  // the time today's backup was made, from the newest backup's own text (null: not known)
  function todayTime(s) {
    var B = M.backup;
    if (!B || typeof B.latest !== "function") return Promise.resolve(null);
    var name = "marginalia-backup-" + s.today + ".json";
    return Promise.resolve().then(function () { return B.latest(); }).then(function (l) {
      return l && l.ok && l.name === name ? madeAt(l.text) : null;
    }, function () { return null; });
  }
  // backUp() → Promise<{ok, file, at, books, decks, prompts, pdfs, failed, cancelled, error}>: the cover's "Back up this
  // browser's library" (see the header). One at a time; never rejects.
  function backUp() {
    var c = st.cover, B = M.backup;
    var out = { ok: false, file: null, at: null, books: 0, decks: 0, prompts: 0, pdfs: 0, failed: [], cancelled: false, error: null };
    if (st.mode !== "cover" || !c) { out.error = "only in a browser page that the Marginalia app replaced"; return Promise.resolve(out); }
    if (st.busy) { out.error = "the backup is already running"; return Promise.resolve(out); }
    if (!B || typeof B.runNow !== "function" || typeof B.refresh !== "function" || typeof B.savePdfs !== "function") {
      out.error = MSG.no_backup;
      lines(c, "", idleNote(), "Could not back up this browser's library — " + out.error);
      return Promise.resolve(out);
    }
    // repair F5: a store in memory mode holds nothing of this browser's library, which is not "empty" (nothing asked)
    if (storeUnreadable()) { out.error = "storage"; lines(c, "", idleNote(), "Could not back up this browser's library — " + TEXT.storage); return Promise.resolve(out); }
    if (!libraryHasData()) { lines(c, "", idleNote(), TEXT.empty); out.error = "empty"; return Promise.resolve(out); }   // nothing asked
    var moved = movedRecord();                                // repair F1: backed up for the move already
    st.busy = true;
    paintCover();
    lines(c, TEXT.checking, "", "");
    changed();
    function fail(why) {
      out.error = str(why) || "unexpected error";
      lines(c, "", idleNote(), "Could not back up this browser's library — " + out.error);
      return out;
    }
    function go() {
      lines(c, TEXT.saving, "", "");
      return Promise.resolve().then(function () { return B.runNow({ client: MOVE_CLIENT, pdfs: false }); }).then(function (r) {
        if (!r || !r.ok) return fail(r && r.error);
        out.file = r.file || null;
        out.at = now();
        rememberMove(out.at, out.file);
        lines(c, TEXT.savingPdfs, "", "");
        return Promise.resolve().then(function () {
          return B.savePdfs({ client: MOVE_CLIENT, quiet: true, onProgress: function (k, n) { lines(c, TEXT.savingPdfs + " " + k + " of " + n, "", ""); } });
        }).then(function (p) {
          var n = libraryCounts(), held = typeof B.libraryPdfs === "function" ? B.libraryPdfs() : null;
          out.books = n.books; out.decks = n.decks; out.prompts = n.prompts;
          out.pdfs = held && typeof held.saved === "number" ? held.saved : (p && p.sent) || 0;
          out.failed = p && Array.isArray(p.failed) ? p.failed : [];
          out.ok = true;
          var missing = Math.max(0, n.books - out.pdfs);
          // repair SEC-1: the app's Import the newest backup takes GET /api/backup's newest file by name; when one is named
          // after today, that is not this backup, so the line says how to import this one
          var after = backupState(), ahead = out.file ? aheadDay(after) : null, dir = after && after.dir ? after.dir : "the backup folder";
          lines(c,
            "Saved this browser's library: " + plural(n.books, "book") + ", " + plural(n.decks, "deck") + ", " + plural(n.prompts, "prompt") +
              ", " + plural(out.pdfs, "PDF") + " (" + hhmm(out.at) + ")." + (ahead ? " Now open the app, click Import a backup file… and choose " + out.file + " in " + dir + "."
                : " Now open the app and click Import the newest backup."),
            [ahead ? "The backup folder also holds a backup dated after today (" + ahead + "), so the app's Import the newest backup would import that one instead. " +
              "Check the Mac's date and time." : "",
            missing ? plural(missing, "book") + (missing === 1 ? " has" : " have") + " no PDF in the backup folder: in the app, Choose file again adds " +
              (missing === 1 ? "it" : "them") + "." : ""].filter(Boolean).join(" "),
            p && !p.ok && p.error ? p.error : "");
          return out;
        });
      });
    }
    return Promise.resolve().then(function () { return B.refresh(); }).then(function (s) {
      if (!s || (s.status !== "on" && s.status !== "off")) return fail((s && s.error) || MSG.no_server);
      var today = hasTodayBackup(s);
      if (!today && !moved) return go();
      // one question: "Back up this browser's library again?" once it was backed up for the move, else "Replace today's backup?"
      return (today ? todayTime(s) : Promise.resolve(null)).then(function (at) {
        return confirmBox(moved ? againQuestion(moved, today, at) : replaceQuestion(at));
      }).then(function (yes) {
        if (yes) return go();
        out.cancelled = true;
        lines(c, "", idleNote(), "");
        return out;
      });
    }).then(null, function (e) {
      report("backUp", e);
      return fail("unexpected error (" + str(e && e.message ? e.message : e) + ")");
    }).then(function (r) {
      st.busy = false;
      paintCover();
      changed();
      // the button was disabled while it ran, which drops its focus: focus goes back to it
      if (st.cover && !confirmOpen() && !tabLockUp()) {
        var a = document.activeElement;
        if (!a || a === document.body || !inCover(a)) { if (!focusEl(st.cover.backupBtn)) focusCover(); }
      }
      return r;
    });
  }

  // ---------------------------------------------------------------- the welcome card (the app)
  function dismissed() {
    if (st.dismissed) return true;
    var s = storage(), v = null;
    if (s) { try { v = s.getItem(WELCOME_KEY); } catch (e) { v = null; } }
    return v === "1";
  }
  function welcomeShowing() { return isApp() && !dismissed() && !libraryHasData(); }
  // welcome() → null (no card: not the app, dismissed, or the library holds a live book, deck or prompt) | {last:
  // {name, date, bytes}|null (GET /api/backup's last), at: ms|null (when it was made), when: "today, 14:05"|null (the
  // file name's day alone, "12 Nov", when ahead: its exportedAt may say "today" after a time-zone change), status
  // (M.backup's), error (why the folder cannot be read, when there is no last), importing, ahead (only when last is named
  // for a day after the server's today: that day, "12 Nov"; the card then offers no import of it, repair SEC-1)}
  function welcome() {
    if (!welcomeShowing()) return null;
    var s = backupState(), last = s && s.last && typeof s.last.name === "string" ? s.last : null;
    var status = s ? str(s.status) || "checking" : "checking";
    var at = last && st.latest && st.latest.name === last.name ? st.latest.at : null;
    var ahead = last ? aheadDay(s) : null;
    var out = {
      last: last ? { name: last.name, date: last.date, bytes: last.bytes } : null,
      at: at,
      when: last ? (ahead || whenText(last.date, at)) : null,
      status: status,
      error: !last && (status === "unavailable" || status === "outdated") ? (str(s && s.error) || null) : null,
      importing: st.importing
    };
    if (ahead) out.ahead = ahead;
    return out;
  }
  // The time of the newest backup (GET /api/backup/latest, read once per listed file; `force`: again, as when the window
  // comes back to the front, since a backup made meanwhile in Brave may have replaced today's file at the same size).
  function wantTime(force) {
    if (!welcomeShowing()) return;
    var s = backupState(), last = s && s.last;
    var B = M.backup;
    if (!last || typeof last.name !== "string" || !B || typeof B.latest !== "function") return;
    var key = last.name + "|" + last.bytes;
    if (!force && key === st.timeAsked) return;
    if (st.timeRun) { st.timeAgain = true; return; }
    st.timeAsked = key;
    st.timeRun = Promise.resolve().then(function () { return B.latest(); }).then(function (l) {
      if (l && l.ok && l.name) st.latest = { name: l.name, at: madeAt(l.text) };
    }, noop).then(function () {
      st.timeRun = null;
      changed();
      if (st.timeAgain) { st.timeAgain = false; wantTime(true); }
    });
  }
  // the window back in front, or the page shown again: the card asks the backup folder again (at most every 2 s)
  function refreshWelcome() {
    if (!welcomeShowing()) return;
    var t = now(), B = M.backup;
    if (t - st.refreshedAt < REFRESH_GAP_MS || !B || typeof B.refresh !== "function") return;
    st.refreshedAt = t;
    Promise.resolve().then(function () { return B.refresh(); }).then(function () { changed(); wantTime(true); }, noop);
  }
  function bindApp() {
    if (st.appBound) return;
    st.appBound = true;
    bindOpenPdf();
    bindZotero();
    try { if (typeof root.addEventListener === "function") root.addEventListener("focus", refreshWelcome); } catch (e) { /* ignore */ }
    try {
      var d = root.document;
      if (d && typeof d.addEventListener === "function") {
        d.addEventListener("visibilitychange", function () { if (d.visibilityState === "visible") refreshWelcome(); });
      }
    } catch (e) { /* ignore */ }
  }
  // ---------------------------------------------------------------- PDFs from macOS (DECISIONS D34)
  // window.marginaliaDesktop.onOpenPdf (the app's preload; its one ipc channel, from the app to the page only): a PDF
  // that macOS handed the app (Finder's Open With, Zotero's "Open in Marginalia") comes as (name, bytes). Once the
  // library has booted it is added as a dropped PDF, one after the other: M.library.addPdf opens the book in the
  // reader, and a PDF already in the library opens its book (nothing is added twice). addPdf shows its own errors.
  function bindOpenPdf() {
    var d = null;
    try { d = root.marginaliaDesktop; } catch (e) { d = null; }
    if (!d || typeof d.onOpenPdf !== "function") return;
    try { d.onOpenPdf(openPdf); } catch (e) { report("onOpenPdf", e); }
  }
  // openPdf(name, bytes) → Promise<the book | null>; never rejects.
  function openPdf(name, bytes) {
    var p = st.pdfs.then(function () {
      var A = M.app;
      return Promise.resolve(A && typeof A.boot === "function" ? A.boot() : null);
    }).then(function () {
      var L = M.library, F = root.File;
      if (!L || typeof L.addPdf !== "function" || typeof F !== "function") return null;
      if (!bytes || typeof ArrayBuffer === "undefined" || !ArrayBuffer.isView(bytes)) return null;
      return L.addPdf(new F([bytes], str(name) || "document.pdf", { type: "application/pdf" }));
    }).then(null, function (e) { if (!(e && e.code)) report("openPdf", e); return null; });
    st.pdfs = p;
    return p;
  }
  // ---------------------------------------------------------------- the books for Zotero (DECISIONS D34, step 2)
  // In the app, the page that writes (M.store.writer()) tells the app's server how many prompts each book's PDF has:
  // POST /api/zotero/books {books: [{sha256, prompts}]}, every live book with a SHA-256 (two books of one PDF add up
  // there), counting its live prompts of ZOTERO_KINDS. Marginalia for Zotero reads that list and tags the Zotero items
  // whose PDF it opened in the app. Once the library has booted, and ZOTERO_WAIT_MS after the last of ZOTERO_EVENTS;
  // nothing goes when the list is the one the server took last. A failure is only logged: the next change tries again.
  function bindZotero() {
    var B = M.bus;
    if (B && typeof B.on === "function") ZOTERO_EVENTS.forEach(function (ev) { B.on(ev, scheduleZotero); });
    var A = M.app;
    Promise.resolve(A && typeof A.boot === "function" ? A.boot() : null).then(scheduleZotero, noop);
  }
  function scheduleZotero() {
    if (st.mode !== "app") return;
    try { if (st.zoteroTimer != null) root.clearTimeout(st.zoteroTimer); } catch (e) { /* ignore */ }
    try { st.zoteroTimer = root.setTimeout(function () { st.zoteroTimer = null; sendZotero(); }, zoteroWait); } catch (e) { st.zoteroTimer = null; }
  }
  // zoteroBooks() → [{sha256, prompts, book}] by SHA-256 (lower case), or null without the cache. `book` is the id of
  // the book a link from Zotero opens (D34 (12)): of the books of that PDF, the one with the most prompts; on a tie
  // the shorter id (the first book, not a separate copy: js/library.js gives those "<fingerprint>:<8 hex>"), then the
  // first by id.
  function zoteroBooks() {
    var C = M.cache;
    if (!C || typeof C.collections !== "function" || typeof C.prompts !== "function") return null;
    var shaOf = {}, perBook = {}, counts = {}, best = {};
    (C.collections() || []).forEach(function (c) {
      if (!c || c.kind !== "book" || c.deletedAt != null || !SHA256_RE.test(str(c.sha256)) || !str(c.id)) return;
      var sha = str(c.sha256).toLowerCase();
      shaOf[c.id] = sha;
      perBook[c.id] = 0;
      if (!counts.hasOwnProperty(sha)) counts[sha] = 0;
    });
    (C.prompts() || []).forEach(function (p) {
      if (!p || p.deletedAt != null || ZOTERO_KINDS.indexOf(p.kind) < 0) return;
      var sha = shaOf.hasOwnProperty(p.collectionId) ? shaOf[p.collectionId] : null;
      if (!sha) return;
      counts[sha]++;
      perBook[p.collectionId]++;
    });
    Object.keys(shaOf).forEach(function (id) {
      var sha = shaOf[id], b = best[sha];
      if (b === undefined || perBook[id] > perBook[b] || (perBook[id] === perBook[b] && (id.length < b.length ||
        (id.length === b.length && id < b)))) best[sha] = id;
    });
    return Object.keys(counts).sort().map(function (sha) { return { sha256: sha, prompts: counts[sha], book: best[sha] }; });
  }
  // sendZotero() → Promise<true (sent) | false (nothing to send, or not now) | null (failed)>; never rejects
  function sendZotero() {
    if (st.mode !== "app") return Promise.resolve(false);
    var S = M.store;
    try { if (S && typeof S.writer === "function" && S.writer() !== true) return Promise.resolve(false); } catch (e) { return Promise.resolve(false); }
    var books = zoteroBooks();
    if (!books) return Promise.resolve(false);
    var body = JSON.stringify({ books: books });
    if (body === st.zoteroSent) return Promise.resolve(false);
    var init = { method: "POST", headers: headers({ "Content-Type": "application/json", "X-Marginalia": "1" }), body: body,
      cache: "no-store", credentials: "same-origin" };
    return doFetch(ZOTERO_API, init).then(function (r) {
      if (!r || !r.ok) { report("zotero", new Error("HTTP " + (r ? r.status : "error"))); return null; }
      st.zoteroSent = body;
      return true;
    }, function (e) { report("zotero", e); return null; });
  }
  function importReason(e) {
    var code = e && e.code;
    if (code === "invalid_json") return "it is not valid JSON";
    if (code === "bad_format") return "it is not a Marginalia backup";
    return str(e && e.message) || "unexpected error";
  }
  // importLatest() → Promise<{ok, report, error}>: GET /api/backup/latest → M.exporter.importJSON(text, {restoreSettings:
  // true}) (its own toast) → the PDFs M.backup takes from the backup folder after it ("import:finished") → the toast
  // "Paste your Anthropic API key again in Settings → LaTeX from snips (backups never contain it)." An error toasts its
  // reason ("Could not import the newest backup — …") and the card stays. Never rejects.
  function importLatest() {
    var B = M.backup, X = M.exporter;
    if (!isApp()) return Promise.resolve({ ok: false, report: null, error: MSG.not_app });
    if (st.importing) return Promise.resolve({ ok: false, report: null, error: MSG.importing });
    function fail(why) {
      toast({ text: "Could not import the newest backup — " + why, ttl: 10000 });
      return { ok: false, report: null, error: why };
    }
    if (!B || typeof B.latest !== "function" || !X || typeof X.importJSON !== "function") return Promise.resolve(fail(MSG.cannot));
    st.importing = true;
    changed();
    return Promise.resolve().then(function () { return B.latest(); }).then(function (l) {
      if (!l || !l.ok) throw new Error((l && l.error) || "unexpected error");
      // repair SEC-1: a file named for a day after the server's today is not the backup Brave's cover just wrote
      var s = backupState(), day = fileDay(l.name), today = s && typeof s.today === "string" ? s.today : "";
      if (day && today && day > today) throw new Error("it is dated after today (" + dateText(day, now()) + "): check the Mac's date and time, or use Import a backup file…");
      return X.importJSON(l.text, { restoreSettings: true });
    }).then(function (rep) {
      // importJSON toasted its summary; its "import:finished" queued M.backup's restore of the PDFs, which runs first
      return Promise.resolve().then(function () { return typeof B.idle === "function" ? B.idle() : null; }).then(null, noop).then(function () {
        toast({ id: KEY_TOAST_ID, text: TEXT.keyReminder, ttl: 12000 });
        return { ok: true, report: rep, error: null };
      });
    }, function (e) { return fail(importReason(e)); }).then(function (r) {
      st.importing = false;
      changed();
      return r;
    });
  }
  // "Start with an empty library": the card goes for good (localStorage "marginalia.welcomeDismissed" = "1"; this page
  // remembers it too when storage refuses).
  function dismissWelcome() {
    st.dismissed = true;
    var s = storage();
    if (s) { try { s.setItem(WELCOME_KEY, "1"); } catch (e) { /* this page remembers it */ } }
    changed();
    return true;
  }

  var bus = tryDep("bus");
  if (bus && typeof bus.on === "function") {
    // M.backup (js/backup.js) listed the backup folder: the welcome card shows the newest backup, then its time
    bus.on("backup:state", function () {
      if (st.mode !== "app" || !welcomeShowing()) return;
      changed();
      wantTime(false);
    });
  }

  // ---------------------------------------------------------------- api
  var api = {
    isApp: isApp,
    start: start,
    ready: ready,
    mode: function () { return st.mode; },
    covered: covered,
    state: state,
    headers: headers,
    refusesWrite: refusesWrite,
    askPersist: askPersist,
    coverLink: coverLink,
    showCover: showCover,
    backUp: backUp,
    welcome: welcome,
    importLatest: importLatest,
    dismissWelcome: dismissWelcome,
    openPdf: openPdf,
    sendZotero: sendZotero,
    zoteroBooks: zoteroBooks,
    // pure helpers
    _pure: { whenText: whenText, dayLabel: dayLabel, hhmm: hhmm, madeAt: madeAt },
    CLIENT_HEADER: CLIENT_HEADER,
    APP_CLIENT: APP_CLIENT,
    MOVE_CLIENT: MOVE_CLIENT,
    CHECK_MS: CHECK_MS,
    WELCOME_KEY: WELCOME_KEY,
    MOVED_KEY: MOVED_KEY,
    MODES: MODES.slice(),
    TEXT: TEXT,
    // test hooks
    _setFetch: function (fn) { fetchFn = typeof fn === "function" ? fn : null; },
    _setOpener: function (fn) { openerFn = typeof fn === "function" ? fn : null; },
    _setCheckMs: function (ms) { checkMs = typeof ms === "number" && ms > 0 ? ms : CHECK_MS; },
    _setNow: function (fn) { nowFn = typeof fn === "function" ? fn : null; },
    _setZoteroWait: function (ms) { zoteroWait = typeof ms === "number" && ms >= 0 ? ms : ZOTERO_WAIT_MS; },
    _reset: function () {
      var c = st.cover;
      if (c) {
        try {
          root.removeEventListener("keydown", c.onKey, true);
          ["paste", "drop", "dragover"].forEach(function (t) { root.removeEventListener(t, c.onBlock, true); });
          root.removeEventListener("hashchange", c.onHash);
          document.removeEventListener("focusin", c.onFocus, true);
        } catch (e) { /* ignore */ }
      }
      if (st && st.zoteroTimer != null) { try { root.clearTimeout(st.zoteroTimer); } catch (e) { /* ignore */ } }
      fetchFn = null; openerFn = null; checkMs = CHECK_MS; nowFn = null; zoteroWait = ZOTERO_WAIT_MS;
      init();
    }
  };
  M.desktop = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (FEATURES E2.2; BUILD-NOTES "Desktop app (binding)", part 2; a module beside SPEC §17.2, loaded after
 * js/library.js and before js/app.js): isApp() → boolean (window.marginaliaDesktop.app === true); start() → Promise<mode>
 * once ("app": askPersist(); "checking" → GET /api/app with X-Marginalia: 1, ≤ CHECK_MS 3 s → "cover" on {ok: true, app:
 * true}, else "browser"; "browser" off 127.0.0.1 / localhost, off http(s), in the artifact, without fetch); ready() →
 * Promise<mode>; mode() → "unknown"|"checking"|"app"|"browser"|"cover"; covered() → boolean; state() → {mode, version,
 * app, covered, busy, forwarded, importing}; headers(base, client) → base + X-Marginalia-Client (client "app" |
 * "browser-move", else "app" in the app, else none); refusesWrite(client) → true in cover mode and while checking, unless
 * client is "browser-move"; askPersist() → Promise<true|false|null> (persist() once when persisted() is false, app only);
 * coverLink(hash) → "marginalia://open?hash=" + encodeURIComponent(hash || location.hash || "#library"); showCover() →
 * boolean (#cover: role alertdialog, "Marginalia is now an app", the two steps, a.cover__open "Open the app",
 * button.cover__backup "Back up this browser's library", .cover__status / .cover__note / .cover__error; inert siblings
 * but #confirm and #toasts; capture-phase keydown / paste / drop / dragover guards on window and a focusin guard; a reader
 * route follows the link once through the opener, ".cover__forward" "Opening this page in the Marginalia app…");
 * backUp() → Promise<{ok, file, at, books, decks, prompts, pdfs, failed, cancelled, error}> (a store in memory mode →
 * error "storage", nothing asked; M.backup.refresh; today's file among any listed (M.backup.hasToday) → M.app.confirm
 * "Replace today's backup?" / "Today's backup (made at HH:MM) is replaced with this browser's library. The app's own
 * library does not change." / "Replace it"; once backed up for the move (localStorage MOVED_KEY) "Back up this
 * browser's library again?" / "Back up again" in its place, also without a backup of today; M.backup.runNow({client:
 * "browser-move", pdfs: false}) and M.backup.savePdfs({client: "browser-move", quiet: true, onProgress}) → "Saving PDFs…
 * k of n"; "Saved this browser's library: <B> books, <D> decks, <P> prompts, <N> PDFs (HH:MM). Now open the app and click
 * Import the newest backup.", or, with a backup dated after today in the folder, "… Now open the app, click Import a backup
 * file… and choose <file> in <dir>."); welcome() → null | {last, at, when, status, error, importing, ahead?};
 * importLatest() → Promise<{ok, report, error}> (M.backup.latest → M.exporter.importJSON(text, {restoreSettings: true}) →
 * M.backup.idle() → toast "Paste your Anthropic API key again in Settings → LaTeX from snips (backups never contain it).";
 * a file named after the server's today is refused; errors toast "Could not import the newest backup — <reason>");
 * dismissWelcome() → true (localStorage "marginalia.welcomeDismissed" = "1"); openPdf(name, bytes) → Promise<book|null> (D34:
 * a PDF macOS handed the app, through window.marginaliaDesktop.onOpenPdf, which start() binds in app mode: after
 * M.app.boot(), M.library.addPdf(new File([bytes], name)), one after the other; never rejects); zoteroBooks() →
 * [{sha256, prompts, book}]|null (D34 step 2: by SHA-256, the live "qa", "cloze" and "note" prompts of its live books,
 * and `book` the id of the one with the most, the shorter id on a tie, for Zotero's link to it);
 * sendZotero() → Promise<true|false|null> (app mode, the writing page only: POST /api/zotero/books {books} with
 * headers(), unless the server took that very list last; app mode binds it after boot and 2 s after the last
 * prompt / collection / import / store:writer event; never rejects); event "desktop:state" (state()); constants
 * CLIENT_HEADER, APP_CLIENT, MOVE_CLIENT, CHECK_MS, WELCOME_KEY, MOVED_KEY, MODES, TEXT; _pure {whenText, dayLabel, hhmm,
 * madeAt}; test hooks _setFetch, _setOpener, _setCheckMs, _setNow, _setZoteroWait, _reset. */
