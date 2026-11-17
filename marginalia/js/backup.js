/* js/backup.js — M.backup: the automatic daily backup (BUILD-NOTES "Automatic backup").
 *
 * Marginalia's own server (tools/serve.py, which the marginalia command starts) keeps one JSON backup a day in a folder
 * in Documents (by default ~/Documents/Marginalia Backups) and the 30 newest of them. This module is the page's half:
 *   GET  /api/backup → {ok: true, dir, today, files: [{name, date, bytes}]}   (today: the server's local date)
 *   POST /api/backup {mode: "auto"|"manual", backup: <the JSON backup>} → {ok: true, file, bytes, skipped, pruned}
 * The server names the file (marginalia-backup-<today>.json): "auto" never replaces today's file, "manual" does.
 * The backup is exactly what Settings › Data › Export… saves as a JSON backup: M.exporter.prepare("json", {scope: "all",
 * collectionId: null, includeImages: true}) — prompts, review history, images and settings, never the PDF bytes and
 * never the API key (a body that holds the key all the same, because a prompt's text holds it, is not sent).
 *
 * When: start() (M.app's boot, once the store is open and the library loaded), then every hour and whenever the tab is
 * shown again (at most once a minute): a GET. Then an automatic backup only when the server answered (status "on"),
 * settings.autoBackup is not false, this is the tab that writes (not M.store.locked(), BUILD-NOTES "One writing tab per
 * origin"), the library holds at least one live collection or prompt, the server lists no file for its today, and no
 * automatic attempt failed today. A failed automatic attempt is not repeated that day: localStorage "marginalia.backup"
 * = {day, error} records it (a reload does not repeat it either), and it toasts once, with "Try again" (runNow()).
 * When storage refuses the record, the page keeps it in memory, and that copy wins over anything storage still holds
 * (an older day's record, a value that is no record), so that page does not try again that day either (a reload,
 * whose memory starts empty, may then try once more).
 * Nothing at all (no request, no timer, no visibility listener) in the store's memory mode, on a page that is not
 * served over http(s) (file://) or in the claude.ai artifact build: state() says "unavailable" and why (reason).
 * A tab that steps aside (store:mode {reason: "othertab"}) stops its timer and listener for good.
 *
 * PDFs (FEATURES B9): the server keeps each PDF once in <backup folder>/PDFs ("<book name> [<sha12>].pdf", deleted only
 * once none of the 30 kept backups lists its sha256 for a live book, or for one deleted less than 30 days ago: D23),
 * with GET /api/backup/pdfs → {ok, dir, files: [{sha12, name, bytes}]}, POST /api/backup/pdf (the bytes;
 * X-Marginalia-Sha256, X-Marginalia-Name) → {ok, file, bytes, skipped} and
 * GET /api/backup/pdf/<sha256> → the bytes. After each backup written (automatic, or "Back up now"; not an automatic one
 * the server skipped) savePdfs() sends, one book at a time and in the background, the PDF of every live book whose
 * bytes are in this browser (M.store.docs.loadBytes) and whose SHA-256 the folder does not hold (no listed file with its
 * sha12 and, when the record knows it, its byteLength: a saved PDF changed after it was saved in another app keeps its
 * name, seldom its size, and the server sets such a file aside when the PDF comes again: "setAside" in its answer,
 * repair B9-R2); a refusal is noted and the next book goes, no answer ends the run, and a run that could not save them
 * all says so once (state().pdfs.error and one toast, id "backup-pdfs"); nothing is tried again before the next backup
 * written. restorePdfs() runs at start (once the server first answers) and after an Import (bus "import:finished",
 * M.exporter): every live book without its bytes (hasBytes false) whose SHA-256 the folder lists gets them back through
 * M.library.attachPdf (the "Choose file again" path, same SHA-256 check), then one toast "Restored N PDF(s) from your
 * backup folder" (id "backup-restore"); a listed PDF the server no longer has (404: its saved copy was changed, which
 * the 404's "changed" names, or it went meanwhile) is a failure the toast names.
 * Uploads and restores share one queue (one PDF in memory at a time). With no book to send or restore no request is
 * made. Neither runs in a tab that stepped aside (and a run stops when the tab steps aside), in the claude.ai copy, off
 * http(s) or in memory mode. A serve.py from before PDF backups (404/405/501 on 127.0.0.1 or localhost) is "outdated".
 *
 * state() → {status: "checking"|"on"|"off"|"outdated"|"unavailable", dir, today, last: {name, date, bytes}|null, error,
 * running, reason, enabled, pdfs: {saved, bytes, dir, running, left, error, outdated}|null}; every change emits
 * "backup:state" with it on M.bus. "outdated": the page's own server on
 * 127.0.0.1 or localhost answers 404, 405 or 501, an older serve.py ("marginalia restart" replaces it). error: why the
 * server cannot back up, or why today's automatic backup failed (null otherwise). runNow() → Promise<{ok, file, bytes,
 * skipped, error}> backs up now (mode "manual", so today's file is replaced) and never toasts (its caller does); an
 * empty library and a tab that stepped aside are refused. setEnabled(on) stores settings.autoBackup through
 * M.settings.set (so nothing while locked) and, turned on, checks at once. refresh() → Promise<state> asks the server
 * again without backing up (for Settings; also its PDF listing). savePdfs() → Promise<{ok, sent, failed, error}> and
 * restorePdfs() → Promise<{ok, restored, failed, error}> run one PDF run now (queued). Every promise resolves, never
 * rejects.
 * Test hooks: _setFetch(fn), _setNow(fn), _setTimers({setInterval, clearInterval}), _idle() (no PDF run queued or
 * running), _reset().
 *
 * The desktop app (FEATURES E2.2, js/desktop.js; BUILD-NOTES "Desktop app (binding)"): every POST here (the JSON backup,
 * a PDF) carries the headers M.desktop.headers() gives: "X-Marginalia-Client: app" in the app, nothing more elsewhere.
 * The app's server refuses a POST without it (409 "app_only", whose "message" is the error shown). In a browser page the
 * app replaced (M.desktop cover mode) nothing is written but the cover's own backup: runNow({client: "browser-move",
 * pdfs: false}) and savePdfs({client: "browser-move", onProgress, quiet}); start() does nothing there and every other
 * write is refused (M.desktop.refusesWrite: "Marginalia is now an app — open it to back up"); while the page's app check
 * still runs (at boot, at most 3 s) nothing is written either ("Marginalia is still starting — try again in a moment"),
 * and neither refusal counts as a failed automatic backup. latest() → GET /api/backup/latest, the newest kept backup as text (the
 * app's welcome card imports it); idle() → a promise for the moment no PDF run is queued or running; libraryPdfs() →
 * {books, sha, saved}: this library's live books, those with a SHA-256, and those whose PDF the folder's listing holds;
 * hasToday() → whether the last listing holds marginalia-backup-<the server's today>.json, among all its files (repair
 * SEC-1: state().last is only the newest by name, and a file named after today sorts before today's).
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  var API = "/api/backup";
  var LATEST_API = "/api/backup/latest";      // GET → the newest kept backup, X-Marginalia-Backup-Name (FEATURES E2.1d)
  var PDFS_API = "/api/backup/pdfs";          // GET → {ok, dir, files: [{sha12, name, bytes}]}: the saved PDFs (FEATURES B9)
  var PDF_API = "/api/backup/pdf";            // POST: one PDF's bytes; GET /<sha256>: a saved PDF's bytes
  var MAX_PDF = 300 * 1024 * 1024;            // the app's MAX_DOC_BYTES, which tools/serve.py also refuses above
  var SHA256_RE = /^[0-9a-f]{64}$/;
  var SHA12_RE = /^[0-9a-f]{12}$/;
  var SURROGATE_RE = /[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g;
  var PDF_TOAST_ID = "backup-pdfs";           // an upload run that could not save every PDF
  var RESTORE_TOAST_ID = "backup-restore";    // "Restored N PDFs from your backup folder"
  var HOUR_MS = 60 * 60 * 1000;               // the regular re-check
  var VISIBLE_GAP_MS = 60 * 1000;             // a tab shown again checks at most once a minute
  var MAX_BODY = 512 * 1024 * 1024;           // tools/serve.py refuses larger requests
  var KEY_MIN = 16;                           // a stored "key" shorter than this is no API key (and would match anything)
  var ERROR_MAX = 300;
  var FILE_RE = /^marginalia-backup-(\d{4}-\d{2}-\d{2})\.json$/;
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var OLD_SERVER_STATUS = { 404: true, 405: true, 501: true };   // a serve.py from before /api/backup
  var MEMO_KEY = "marginalia.backup";         // {day, error}: today's automatic attempt failed
  var TOAST_ID = "backup";
  var TOAST_TTL = 12000;
  var STATUSES = ["checking", "on", "off", "outdated", "unavailable"];
  var RESTART = "restart Marginalia (marginalia restart in Terminal)";
  var MSG = {
    artifact: "not available in the claude.ai copy",
    file: "not available in a saved file",
    memory: "storage is unavailable in this view",
    no_fetch: "this browser cannot reach Marginalia's server",
    no_server: "Marginalia's server did not answer",
    not_here: "this page does not come from Marginalia's server",
    outdated: "Marginalia's server has no backup support — " + RESTART,
    locked: "Marginalia is open in another tab",
    empty: "the library is empty — there is nothing to back up",
    key: "a prompt holds your Anthropic API key — remove it from the prompt, then back up again",
    too_large: "the backup is larger than 512 MB",
    no_exporter: "the exporter is not loaded",
    pdf_outdated: "Marginalia's server cannot save PDFs yet — " + RESTART,
    app: "Marginalia is now an app — open it to back up",
    starting: "Marginalia is still starting — try again in a moment",
    no_backup: "there is no backup in the backup folder yet",
    latest_outdated: "Marginalia's server cannot give the newest backup yet — " + RESTART,
    cut: "the backup did not arrive whole"
  };

  // ---------------------------------------------------------------- state
  var st, started, timer, inflight, lastCheckAt, queue, memoFallback, lastEmitted, visDoc = null;
  var fetchFn = null, nowFn = null, timerFns = null;
  // The PDF side (FEATURES B9): what GET /api/backup/pdfs listed (known; files: file name → {sha12, bytes}, one entry
  // per saved PDF; dir: the backup folder, whose PDFs folder holds them), outdated (an older serve.py: no PDF API),
  // running / left (a run under way, and the books its uploads still have to send), error (why the last upload run
  // could not save every PDF), stopped (the tab stepped aside). pdfQueue: uploads and restores, one at a time, so one
  // PDF at most is in memory; pdfWaiting: the run of each kind that is queued and has not started yet.
  var pdf, pdfQueue, pdfWaiting, restoreDue;
  function init() {
    st = { status: "checking", dir: null, today: null, files: [], error: null, reason: null, running: false };
    started = false; timer = null; inflight = null; lastCheckAt = -Infinity; queue = Promise.resolve();
    memoFallback = null; lastEmitted = "";
    pdf = { known: false, outdated: false, dir: null, files: new Map(), running: false, left: 0, error: null, stopped: false };
    pdfQueue = Promise.resolve(); pdfWaiting = { save: null, restore: null }; restoreDue = false;
  }
  init();

  // ---------------------------------------------------------------- small helpers
  function noop() {}
  function str(v) { return v == null ? "" : String(v); }
  function cut(s) { s = str(s); return s.length > ERROR_MAX ? s.slice(0, ERROR_MAX - 1) + "…" : s; }
  function report(where, e) { try { console.warn("[backup] " + where + ": " + (e && e.message ? e.message : str(e))); } catch (e2) { /* no console */ } }
  function now() { var t = nowFn ? Number(nowFn()) : Date.now(); return isFinite(t) ? t : Date.now(); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function dayOf(ms) {
    var U = M.util;
    if (U && typeof U.dayKey === "function") { try { return U.dayKey(ms); } catch (e) { /* below */ } }
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function loc() { try { return root.location || null; } catch (e) { return null; } }
  function isArtifact() {
    var app = M.app;
    try { return !!(app && typeof app.isArtifact === "function" && app.isArtifact()); } catch (e) { return false; }
  }
  function storeMode() { var s = M.store; try { return s && typeof s.mode === "function" ? s.mode() : null; } catch (e) { return null; } }
  function locked() { var s = M.store; try { return !!(s && typeof s.locked === "function" && s.locked()); } catch (e) { return false; } }
  // This tab stepped aside for good (the legacy rule). A window of the Mac app that is a reader for now (D31,
  // {reason: "window"}) is locked() too, but it keeps its timer: it may be the writer at the next check.
  function aside() {
    var s = M.store;
    try { var l = s && typeof s.locked === "function" ? s.locked() : null; return !!l && l.reason !== "window"; } catch (e) { return false; }
  }
  function enabled() {
    var S = M.settings, v;
    try { v = S && typeof S.get === "function" ? S.get("autoBackup") : undefined; } catch (e) { v = undefined; }
    return v !== false;
  }
  // The page comes from a server on this Mac (127.0.0.1 or localhost, as the marginalia command serves it).
  function localPage() { var l = loc(), h = l ? str(l.hostname) : ""; return h === "127.0.0.1" || h === "localhost"; }
  function toast(opts) {
    var app = M.app;
    if (!app || typeof app.toast !== "function") return null;
    try { return app.toast(Object.assign({ id: TOAST_ID, ttl: TOAST_TTL }, opts)); } catch (e) { return null; }
  }

  // FEATURES E2.2 (js/desktop.js): the headers of a POST — in the desktop app "X-Marginalia-Client: app" joins them, and
  // the cover's backup in a browser page the app replaced passes client "browser-move"; elsewhere they stay as given.
  function postHeaders(base, client) {
    var D = M.desktop;
    if (D && typeof D.headers === "function") { try { return D.headers(base, client); } catch (e) { report("headers", e); } }
    return base;
  }
  // In a browser page the app replaced (M.desktop cover mode) only the cover's own backup writes, and nothing writes while
  // the page's app check still runs (at boot, at most 3 s) (null: a write may go).
  function coverRefusal(client) {
    var D = M.desktop;
    try {
      if (!D || typeof D.refusesWrite !== "function" || !D.refusesWrite(client)) return null;
      return typeof D.mode === "function" && D.mode() === "checking" ? MSG.starting : MSG.app;
    } catch (e) { return null; }
  }

  function desktopCovered() {
    var D = M.desktop;
    try { return !!(D && typeof D.covered === "function" && D.covered()); } catch (e) { return false; }
  }

  // Why this page can never reach Marginalia's server (null: it may).
  function unavailableReason() {
    if (isArtifact()) return "artifact";
    var l = loc(), proto = l ? str(l.protocol) : "";
    if (proto !== "http:" && proto !== "https:") return "file";
    if (storeMode() === "memory") return "memory";
    if (typeof (fetchFn || root.fetch) !== "function") return "no_fetch";
    return null;
  }

  // At least one collection or prompt that is not a tombstone: an empty library (another address, wiped storage) is
  // never backed up, so it cannot crowd good backups out of the 30 the server keeps.
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

  function apiKey() {
    var S = M.settings, k = null;
    try { k = S && S.apiKey && typeof S.apiKey.get === "function" ? S.apiKey.get() : null; } catch (e) { k = null; }
    return typeof k === "string" ? k : "";
  }
  function holdsApiKey(text) {
    var k = apiKey();
    if (k.length < KEY_MIN) return false;
    if (text.indexOf(k) >= 0) return true;
    var esc = JSON.stringify(k).slice(1, -1);                 // the key as JSON writes it
    return esc !== k && text.indexOf(esc) >= 0;
  }

  function newestFirst(a, b) { return a.name < b.name ? 1 : a.name > b.name ? -1 : 0; }
  function cleanFiles(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function (f) {
      var m = f && typeof f.name === "string" ? FILE_RE.exec(f.name) : null;
      if (!m || seen[f.name]) return;
      seen[f.name] = true;
      out.push({ name: f.name, date: m[1], bytes: typeof f.bytes === "number" && isFinite(f.bytes) && f.bytes >= 0 ? f.bytes : null });
    });
    return out.sort(newestFirst);
  }
  function todayName() { return st.today ? "marginalia-backup-" + st.today + ".json" : null; }
  // The last listing holds a file of the server's today: any listed file, not only state().last, the newest by name (a
  // file named after today, by a Mac clock that was once ahead, sorts first; repair SEC-1).
  function hasToday() {
    var name = todayName();
    return !!name && st.files.some(function (f) { return f.name === name; });
  }

  // ---------------------------------------------------------------- state() and backup:state
  function snapshot() {
    var f = st.files[0] || null;
    return {
      status: st.status, dir: st.dir, today: st.today, last: f ? { name: f.name, date: f.date, bytes: f.bytes } : null,
      error: st.error, running: st.running, reason: st.reason, enabled: enabled(), pdfs: pdfSnapshot()
    };
  }
  // state().pdfs (FEATURES B9.6): null until the server has listed its PDFs (or said it cannot) and no run has begun;
  // else {saved: files listed, bytes: their total size, dir: the backup folder (the PDFs are in <dir>/PDFs), running,
  // left: books an upload run still has to send, error: why the last upload run could not save them all, outdated: a
  // serve.py from before PDF backups (saved and bytes null then)}
  function pdfSnapshot() {
    if (!pdf.known && !pdf.outdated && !pdf.running && !pdf.error) return null;
    var total = 0;
    pdf.files.forEach(function (f) { total += f.bytes; });
    return { saved: pdf.known ? pdf.files.size : null, bytes: pdf.known ? total : null, dir: pdf.dir || st.dir || null,
      running: pdf.running, left: pdf.running ? pdf.left : 0, error: pdf.error, outdated: pdf.outdated };
  }
  function changed() {
    var s = snapshot(), key;
    try { key = JSON.stringify(s); } catch (e) { key = ""; }
    if (key && key === lastEmitted) return;
    lastEmitted = key;
    var bus = M.bus;
    if (bus && typeof bus.emit === "function") { try { bus.emit("backup:state", s); } catch (e) { report("backup:state", e); } }
  }
  function update(patch) {
    Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
    changed();
  }
  // The server cannot back up (reason "outdated" → status "outdated"; anything else → "unavailable").
  function gone(reason, error) {
    update({ status: reason === "outdated" ? "outdated" : "unavailable", reason: reason, error: error || null,
      dir: null, today: null, files: [] });
  }

  // ---------------------------------------------------------------- today's failed automatic attempt
  function storage() { try { var s = root.localStorage; return s && typeof s.getItem === "function" ? s : null; } catch (e) { return null; } }
  // This page's own record of today's failure comes first: storage that refuses today's record (full, blocked) may
  // still hold an older day's record or a value that is no record at all, and neither may hide today's failure
  // (else every check would build, POST and toast again).
  function readMemo() {
    if (memoFallback && st.today && memoFallback.day === st.today) return memoFallback;
    var s = storage(), raw = null;
    if (s) { try { raw = s.getItem(MEMO_KEY); } catch (e) { raw = null; } }
    if (raw == null) return memoFallback;
    try {
      var m = JSON.parse(raw);
      return m && typeof m === "object" && typeof m.day === "string" ? { day: m.day, error: typeof m.error === "string" ? m.error : "" } : null;
    } catch (e) { return null; }
  }
  function writeMemo(m) {
    memoFallback = m;                                          // what this page remembers when storage refuses
    var s = storage();
    if (!s) return;
    try { if (m) s.setItem(MEMO_KEY, JSON.stringify(m)); else s.removeItem(MEMO_KEY); } catch (e) { /* blocked or full */ }
  }
  function memoError() {
    var m = readMemo();
    return m && st.today && m.day === st.today ? (m.error || null) : null;
  }

  // ---------------------------------------------------------------- the server
  function doFetch(url, init) {
    var f = fetchFn || root.fetch;
    return Promise.resolve().then(function () { return f.call(root, url, init); });
  }
  function readJson(r) {
    var p = null;
    try { p = r && typeof r.json === "function" ? r.json() : null; } catch (e) { p = null; }
    return Promise.resolve(p).then(null, function () { return null; });
  }
  // The server's own words: its "error", or, for the app's server refusing a page that is not the app (409 "app_only",
  // FEATURES E2.1c), its "message" ("Marginalia is now an app. Open the Marginalia app to do this.").
  function serverWords(j) {
    if (j && j.error === "app_only" && typeof j.message === "string" && j.message.trim()) return j.message.trim();
    return j && typeof j.error === "string" ? j.error.trim() : "";
  }
  function serverError(status, j) {
    if (status === 413) return MSG.too_large;
    return cut(serverWords(j) || ("the server answered " + status));
  }

  // GET /api/backup → true when the server can back up (status on/off), else false with the status saying why.
  function ask() {
    return doFetch(API, { method: "GET", headers: { "X-Marginalia": "1" }, cache: "no-store", credentials: "same-origin" })
      .then(function (r) {
        return readJson(r).then(function (j) {
          var status = r ? r.status : 0;
          if (r && r.ok && j && j.ok === true && typeof j.today === "string" && DAY_RE.test(j.today)) {
            st.dir = typeof j.dir === "string" && j.dir ? j.dir : null;
            st.today = j.today;
            st.files = cleanFiles(j.files);
            update({ status: enabled() ? "on" : "off", reason: null, error: memoError() });
            return true;
          }
          if (OLD_SERVER_STATUS[status] === true) { gone(localPage() ? "outdated" : "no_server", localPage() ? null : MSG.not_here); return false; }
          gone("server", serverError(status, j));
          return false;
        });
      }, function () { gone("no_server", MSG.no_server); return false; })
      .then(null, function (e) { report("check", e); gone("server", "unexpected error (" + cut(e && e.message ? e.message : e) + ")"); return false; });
  }

  // POST one body → the result runNow() resolves with. client: the cover's "browser-move" (M.desktop), else none.
  function post(body, client) {
    return doFetch(API, {
      method: "POST", body: body, cache: "no-store", credentials: "same-origin",
      headers: postHeaders({ "Content-Type": "application/json", "X-Marginalia": "1" }, client)
    }).then(function (r) {
      return readJson(r).then(function (j) {
        var status = r ? r.status : 0;
        if (r && r.ok && j && j.ok === true && FILE_RE.test(baseName(j.file))) return accepted(j);
        if (OLD_SERVER_STATUS[status] === true && localPage()) { gone("outdated", null); return result(false, null, MSG.outdated); }
        return result(false, null, serverError(status, j));
      });
    }, function () {
      gone("no_server", MSG.no_server);
      return result(false, null, MSG.no_server);
    });
  }
  function result(ok, file, error, extra) {
    return Object.assign({ ok: ok, file: file, bytes: null, skipped: false, error: ok ? null : (error || "unexpected error") }, extra || {});
  }
  // The file's own name (the server answers the bare name; a path is cut to its last part).
  function baseName(file) { return typeof file === "string" ? file.split(/[\\/]/).pop() : ""; }
  // The server wrote (or, mode "auto", kept) j.file: the listing follows without asking again.
  function accepted(j) {
    var name = baseName(j.file), day = FILE_RE.exec(name)[1];
    var prev = st.files.filter(function (f) { return f.name === name; })[0] || null;
    var bytes = typeof j.bytes === "number" && isFinite(j.bytes) && j.bytes >= 0 ? j.bytes : (prev ? prev.bytes : null);
    var pruned = Array.isArray(j.pruned) ? j.pruned.filter(function (n) { return typeof n === "string"; }).map(baseName) : [];
    var files = st.files.filter(function (f) { return f.name !== name && pruned.indexOf(f.name) < 0; });
    files.push({ name: name, date: day, bytes: bytes });
    st.files = files.sort(newestFirst);
    st.today = day;
    if (readMemo()) writeMemo(null);
    update({ status: enabled() ? "on" : "off", reason: null, error: null });
    return result(true, name, null, { bytes: bytes, skipped: j.skipped === true });
  }

  // Build the backup (the manual JSON backup's exporter call) and POST it. Never rejects.
  function backup(mode, client) {
    if (locked()) return Promise.resolve(result(false, null, MSG.locked));
    var cov = coverRefusal(client);
    if (cov) return Promise.resolve(result(false, null, cov));
    if (!libraryHasData()) return Promise.resolve(result(false, null, MSG.empty));
    var X = M.exporter;
    if (!X || typeof X.prepare !== "function") return Promise.resolve(result(false, null, MSG.no_exporter));
    update({ running: true });
    return Promise.resolve().then(function () {
      return X.prepare("json", { scope: "all", collectionId: null, includeImages: true });
    }).then(function (out) {
      var text = out && typeof out.text === "string" ? out.text : "";
      if (text.charAt(0) !== "{") throw new Error("the exporter made no backup");
      if (locked()) return result(false, null, MSG.locked);   // a newer tab took over while it was being built
      var bytes = typeof out.bytes === "number" && isFinite(out.bytes) ? out.bytes : text.length;
      if (bytes + 40 > MAX_BODY) return result(false, null, MSG.too_large);
      var body = "{\"mode\":\"" + (mode === "auto" ? "auto" : "manual") + "\",\"backup\":" + text + "}";
      if (holdsApiKey(body)) return result(false, null, MSG.key);
      return post(body, client);
    }).then(null, function (e) {
      report("backup", e);
      return result(false, null, "unexpected error (" + cut(e && e.message ? e.message : e) + ")");
    }).then(function (r) {
      update({ running: false });
      return r;
    });
  }

  // One backup at a time, automatic or not, in the order asked.
  function enqueue(mode, client) {
    var job = queue.then(function () { return mode === "auto" && autoBlocked() ? null : backup(mode, client); });
    queue = job.then(noop, noop);
    return job;
  }

  // ---------------------------------------------------------------- PDFs (FEATURES B9; BUILD-NOTES "Automatic backup")
  // The JSON backup holds no PDF bytes. tools/serve.py keeps each PDF once in <backup folder>/PDFs as a normal file,
  // "<book name> [<first 12 hex digits of its SHA-256>].pdf", and keeps it while any of the 30 kept backups lists that
  // sha256 for a live book, or for a book deleted less than 30 days ago (D23). The page's half: after each backup
  // written (automatic or "Back up now") it sends the PDFs the folder does not hold yet (savePdfs), and at start and
  // after an Import it takes back the PDFs of the books whose bytes are not in this browser (restorePdfs, through
  // M.library.attachPdf, the "Choose file again" path). The
  // listing goes by file name: a saved PDF changed after it was saved (opened and saved in another app) is told by its
  // size (savedCopy) and sent again, and the server then renames it aside (repair B9-R2).
  // Uploads and restores run in the background, one PDF at a time; a tab that stepped aside, the claude.ai copy, a page
  // off http(s) and the store's memory mode do neither.

  // the book's SHA-256 in lower case, or "" (no hash, an fnv1a one, or not 64 hex digits: such a PDF cannot be saved)
  function shaOf(c) {
    var s = c && typeof c.sha256 === "string" ? c.sha256.toLowerCase() : "";
    if (!SHA256_RE.test(s)) return "";
    return c.hashAlgo == null || c.hashAlgo === "" || c.hashAlgo === "sha-256" ? s : "";
  }
  // the book's name as the library shows it (the server cleans the one it is sent, as an Obsidian note name)
  function rawName(c) { return str(c && (c.name || c.title || c.fileName)); }
  function bookName(c) { return rawName(c).replace(/\s+/g, " ").trim() || "Untitled"; }
  // every live book with a SHA-256 that `pred` takes, in the library's order
  function booksWhere(pred) {
    var C = M.cache, list;
    try { list = C && typeof C.collections === "function" ? C.collections() : []; } catch (e) { list = []; }
    return (Array.isArray(list) ? list : []).filter(function (c) { return !!c && c.kind === "book" && !c.deletedAt && !!shaOf(c) && pred(c); });
  }
  function bookNow(id) {
    var C = M.cache;
    try { return C && typeof C.collection === "function" ? C.collection(id) : null; } catch (e) { return null; }
  }
  // the sizes of the saved PDFs the folder lists with this sha12 (the first 12 hex digits of a SHA-256)
  function listedSizes(sha12) {
    var out = [];
    pdf.files.forEach(function (f) { if (f.sha12 === sha12) out.push(f.bytes); });
    return out;
  }
  // The folder holds this book's PDF: a listed file with its sha12 and, when the record knows the PDF's size
  // (byteLength), that size. The listing goes by name, and a saved PDF changed after it was saved (opened and saved in
  // another app) keeps its name, seldom its size: such a book is sent again, and the server then sets the changed file
  // aside and saves the book's own PDF (repair B9-R2).
  function savedCopy(c) {
    var sizes = listedSizes(shaOf(c).slice(0, 12)), n = c && c.byteLength;
    if (!sizes.length) return false;
    return !(typeof n === "number" && isFinite(n) && n > 0) || sizes.indexOf(n) >= 0;
  }
  // the saved PDFs a POST /api/backup/pdf answer set aside ("setAside": [{name, as}], file names): no longer listed
  function setAsideNames(j) {
    return (j && Array.isArray(j.setAside) ? j.setAside : []).map(function (a) { return a && typeof a.name === "string" ? baseName(a.name) : ""; })
      .filter(Boolean);
  }
  // why a restore's GET /api/backup/pdf/<sha256> found no saved copy (404): the server's "changed" names the saved
  // PDFs with that sha12 whose content is not this PDF any more
  function notThere(j) {
    var changed = j && Array.isArray(j.changed) ? j.changed.filter(function (n) { return typeof n === "string" && n; }) : [];
    return changed.length ? "its saved copy “" + cut(baseName(changed[0])) + "” was changed after it was saved, so it is not this book's file any more"
      : "its saved copy is no longer in the backup folder";
  }
  function storeDocs() { var S = M.store; return S && S.docs && typeof S.docs.loadBytes === "function" ? S.docs : null; }
  function attacher() { var L = M.library; return L && typeof L.attachPdf === "function" ? L : null; }
  function keepRole(work) {
    var s = M.store;
    return s && typeof s.during === "function" ? s.during(work) : Promise.resolve().then(work);
  }
  // why no PDF may go or come now (null: they may)
  // client: the cover's "browser-move" run (FEATURES E2.2c), the only PDF run a browser page the app replaced may make
  function pdfBlocked(client) {
    var why = unavailableReason();
    if (why) return MSG[why];
    if (locked() || pdf.stopped) return MSG.locked;
    return coverRefusal(client);
  }
  function plural(n, one) { return n + " " + one + (n === 1 ? "" : "s"); }
  // a header value fetch accepts: the name well-formed (a lone surrogate becomes U+FFFD), then percent-encoded
  function headerName(s) {
    s = str(s);
    s = typeof s.toWellFormed === "function" ? s.toWellFormed() : s.replace(SURROGATE_RE, function (m) { return m.length === 2 ? m : "\ufffd"; });
    return encodeURIComponent(s);
  }
  function pdfServerError(status, j) {
    return cut(serverWords(j) || ("the server answered " + status));
  }
  function setPdf(patch) { Object.keys(patch).forEach(function (k) { pdf[k] = patch[k]; }); changed(); }

  // GET /api/backup/pdfs → {ok: true} (the listing kept in `pdf`), or {ok: false, error, outdated?, down?}
  function listPdfs() {
    return doFetch(PDFS_API, { method: "GET", headers: { "X-Marginalia": "1" }, cache: "no-store", credentials: "same-origin" })
      .then(function (r) {
        return readJson(r).then(function (j) {
          var status = r ? r.status : 0;
          if (r && r.ok && j && j.ok === true && Array.isArray(j.files)) {
            var files = new Map();
            j.files.forEach(function (f) {
              if (!f || typeof f.name !== "string" || !f.name || typeof f.sha12 !== "string" || !SHA12_RE.test(f.sha12)) return;
              files.set(f.name, { sha12: f.sha12, bytes: typeof f.bytes === "number" && isFinite(f.bytes) && f.bytes >= 0 ? f.bytes : 0 });
            });
            setPdf({ known: true, outdated: false, files: files, dir: typeof j.dir === "string" && j.dir ? j.dir : st.dir });
            return { ok: true };
          }
          if (OLD_SERVER_STATUS[status] === true && localPage()) {   // a serve.py from before PDF backups: restart it
            setPdf({ known: false, outdated: true, files: new Map() });
            return { ok: false, outdated: true, error: MSG.pdf_outdated };
          }
          return { ok: false, error: pdfServerError(status, j) };
        });
      }, function () { return { ok: false, down: true, error: MSG.no_server }; })
      .then(null, function (e) { report("pdfs", e); return { ok: false, error: "unexpected error (" + cut(e && e.message ? e.message : e) + ")" }; });
  }

  // One run of a kind at a time, in the order asked, uploads and restores in one line; a run asked while one of its
  // kind waits to start is that run (it will see everything the later ask would). → Promise<the run's result>.
  // opts (uploads only, FEATURES E2.2): {client, onProgress(k, n), quiet}; a run with its own client is another kind of
  // run, and one with a progress callback is never shared.
  function enqueuePdf(kind, opts) {
    opts = opts || {};
    var key = kind + (opts.client ? ":" + opts.client : ""), shared = typeof opts.onProgress !== "function";
    if (shared && pdfWaiting[key]) return pdfWaiting[key];
    var job = pdfQueue.then(function () {
      if (pdfWaiting[key] === job) pdfWaiting[key] = null;
      // D31: the PDFs that come back are stored one after the other: this window keeps the writer role until the last
      return kind === "save" ? runSave(opts) : keepRole(runRestore);
    }).then(null, function (e) {
      report(kind === "save" ? "savePdfs" : "restorePdfs", e);
      setPdf({ running: false, left: 0 });
      return { ok: false, error: "unexpected error (" + cut(e && e.message ? e.message : e) + ")" };
    });
    if (shared) pdfWaiting[key] = job;
    pdfQueue = job.then(noop, noop);
    return job;
  }

  // POST one book's PDF, its bytes read from the store (M.store.docs.loadBytes joins its chunks), headers as
  // tools/serve.py asks: Content-Type application/pdf, X-Marginalia 1, X-Marginalia-Sha256 (the book's SHA-256, which
  // the server checks the body against), X-Marginalia-Name (the book's name, percent-encoded; the server cleans it as an
  // Obsidian note name), and X-Marginalia-Client from M.desktop (FEATURES E2.2: "app" in the app, the cover's client).
  // → {ok} | {ok: false, error?, skip?: nothing to send after all, stop?: no more this run, quiet?}
  function uploadOne(c, D, client) {
    var sha = shaOf(c);
    return Promise.resolve().then(function () { return D.loadBytes(c.id); }).then(function (u8) {
      if (!u8 || typeof u8.byteLength !== "number" || !u8.byteLength) return { ok: false, skip: true };   // not (all) in this browser
      if (u8.byteLength > MAX_PDF) return { ok: false, error: "the PDF is larger than 300 MB" };
      if (pdfBlocked(client)) return { ok: false, stop: true, quiet: true };   // stepped aside while the bytes were read: nothing goes
      var cur = bookNow(c.id);
      if (!cur || cur.deletedAt || cur.hasBytes === false || shaOf(cur) !== sha) return { ok: false, skip: true };   // deleted or replaced meanwhile
      return doFetch(PDF_API, {
        method: "POST", body: u8, cache: "no-store", credentials: "same-origin",
        headers: postHeaders({ "Content-Type": "application/pdf", "X-Marginalia": "1", "X-Marginalia-Sha256": sha, "X-Marginalia-Name": headerName(rawName(cur)) }, client)
      }).then(function (r) {
        return readJson(r).then(function (j) {
          var status = r ? r.status : 0;
          if (r && r.ok && j && j.ok === true) {                 // saved now, or (skipped) saved already under some name
            var name = baseName(j.file), files = new Map(pdf.files);
            setAsideNames(j).forEach(function (n) { files.delete(n); });   // changed after they were saved: no longer listed
            if (name) files.set(name, { sha12: sha.slice(0, 12), bytes: typeof j.bytes === "number" && isFinite(j.bytes) && j.bytes >= 0 ? j.bytes : u8.byteLength });
            setPdf({ files: files });
            return { ok: true };
          }
          if (OLD_SERVER_STATUS[status] === true && localPage()) {
            setPdf({ known: false, outdated: true, files: new Map() });
            return { ok: false, stop: true, quiet: true };
          }
          return { ok: false, error: pdfServerError(status, j) };
        });
      }, function () { return { ok: false, stop: true, error: MSG.no_server }; });
    });
  }

  // FEATURES B9.4: send the PDF of every live book whose bytes are in this browser and whose SHA-256 the folder does not
  // hold (by its first 12 hex digits, as the server names the files, and the book's size: savedCopy), one book at a
  // time. A book refused by the server is noted and the next one goes; no answer ends the run. A run that could not save
  // every PDF says so once: its first reason in state().pdfs.error and one toast (id "backup-pdfs"). Nothing is tried
  // again before the next run (the next backup written, or "Back up now"). A tab that steps aside stops at once and says
  // nothing.
  // → {ok, sent, failed: [{collectionId, name, error}], error}
  // opts (FEATURES E2.2, the cover's backup): client ("browser-move", on every POST), onProgress(k, n) (called before the
  // k-th of the n PDFs the folder lacks goes), quiet (no toast: the cover shows the error itself).
  function runSave(opts) {
    opts = opts || {};
    var client = opts.client || null;
    var out = { ok: false, sent: 0, failed: [], error: null };
    var why = pdfBlocked(client), D = storeDocs();
    if (why) { out.error = why; return Promise.resolve(out); }
    var mine = D ? booksWhere(function (c) { return c.hasBytes !== false; }) : [];
    if (!mine.length) { out.ok = true; return Promise.resolve(out); }   // nothing to send: no request at all
    var listError = null, quiet = false;
    setPdf({ running: true, left: 0 });
    return listPdfs().then(function (l) {
      if (!l.ok) { if (!l.outdated) listError = l.error; return null; }
      var todo = mine.filter(function (c) { return !savedCopy(c); }), i = 0;
      setPdf({ left: todo.length });
      function next() {
        if (i >= todo.length) return null;
        if (pdfBlocked(client)) { quiet = true; return null; }
        var c = todo[i++];
        if (typeof opts.onProgress === "function") { try { opts.onProgress(i, todo.length); } catch (e) { report("onProgress", e); } }
        return uploadOne(c, D, client).then(function (r) {
          setPdf({ left: todo.length - i });
          if (r.ok) out.sent++;
          else if (!r.skip && !r.quiet) out.failed.push({ collectionId: c.id, name: bookName(c), error: r.error || "unexpected error" });
          if (r.stop) { quiet = quiet || !!r.quiet; return null; }
          return next();
        });
      }
      return next();
    }).then(function () {
      var n = out.failed.length, text = null;
      if (listError) text = "Could not save the PDFs to the backup folder — " + listError;
      else if (n) text = "Could not save " + (n === 1 ? "the PDF of “" + out.failed[0].name + "”" : plural(n, "PDF")) + " to the backup folder — " + out.failed[0].error;
      var reason = text || (pdf.outdated ? MSG.pdf_outdated : (quiet ? MSG.locked : null));
      out.ok = !reason;
      out.error = reason ? cut(reason) : null;
      if (text) {
        setPdf({ running: false, left: 0, error: cut(text) });
        if (!opts.quiet) toast({ id: PDF_TOAST_ID, text: text });
      } else setPdf(quiet ? { running: false, left: 0 } : { running: false, left: 0, error: null });
      return out;
    });
  }

  // GET one saved PDF's bytes and give them to M.library.attachPdf → {ok} | {ok: false, error?, skip?, stop?, quiet?}
  function restoreOne(c, L) {
    var sha = shaOf(c);
    return doFetch(PDF_API + "/" + sha, { method: "GET", headers: { "X-Marginalia": "1" }, cache: "no-store", credentials: "same-origin" })
      .then(function (r) {
        var status = r ? r.status : 0;
        // the folder listed it, yet no saved copy holds this PDF now: its saved copy was changed after it was saved (the
        // server names it in "changed"), or it went meanwhile. A failure, named in the toast (repair B9-R2).
        if (status === 404) return readJson(r).then(function (j) { return { ok: false, error: notThere(j) }; });
        if (!r || !r.ok) return readJson(r).then(function (j) { return { ok: false, error: pdfServerError(status, j) }; });
        var len = null;
        try { len = r.headers && typeof r.headers.get === "function" ? Number(r.headers.get("Content-Length")) : null; } catch (e) { len = null; }
        if (len != null && isFinite(len) && len > MAX_PDF) return { ok: false, error: "the saved PDF is larger than 300 MB" };
        return Promise.resolve().then(function () { return r.arrayBuffer(); }).then(function (buf) {
          if (pdfBlocked()) return { ok: false, stop: true, quiet: true };
          var u8 = new Uint8Array(buf);
          if (u8.byteLength > MAX_PDF) return { ok: false, error: "the saved PDF is larger than 300 MB" };
          return Promise.resolve().then(function () { return L.attachPdf(c.id, u8); }).then(function () { return { ok: true }; }, function (e) {
            var code = e && e.code;
            // the library moved on meanwhile (a PDF being added, the book given its bytes, changed or deleted): nothing to say
            if (code === "busy" || code === "has_bytes" || code === "changed" || code === "not_found") return { ok: false, skip: true };
            if (code === "locked") return { ok: false, stop: true, quiet: true };
            var why = { mismatch: "it is not this book's file (its SHA-256 differs)", not_pdf: "it is not a PDF", too_large: "it is larger than 300 MB",
              quota: "there is not enough storage space for it", store: "it could not be stored" }[code];
            return { ok: false, error: why || cut((e && e.message) || "unexpected error") };
          });
        }, function () { return { ok: false, error: "the PDF did not arrive whole (it changed while it was read, or the server stopped)" }; });
      }, function () { return { ok: false, stop: true, error: MSG.no_server }; });
  }

  // FEATURES B9.5: the books whose bytes are not in this browser (hasBytes false: an Import made them, or the bytes were
  // lost) take their PDF back from the backup folder when it holds their SHA-256: GET /api/backup/pdf/<sha256>, then
  // M.library.attachPdf, which joins the bytes to the book as "Choose file again" would (same SHA-256 check). One at a
  // time; then one toast (id "backup-restore"): "Restored N PDF(s) from your backup folder", with the ones that could
  // not be restored in its detail ("Choose file again" stays for them). With no such book, or without
  // M.library.attachPdf, there is no request at all; a server without PDF backups restores nothing and says nothing.
  // → {ok, restored, failed: [{collectionId, name, error}], error}
  function runRestore() {
    var out = { ok: false, restored: 0, failed: [], error: null };
    var why = pdfBlocked(), L = attacher();
    if (why) { out.error = why; return Promise.resolve(out); }
    var want = L ? booksWhere(function (c) { return c.hasBytes === false; }) : [];
    if (!want.length) { out.ok = true; return Promise.resolve(out); }
    var quiet = false;
    setPdf({ running: true, left: 0 });
    return listPdfs().then(function (l) {
      if (!l.ok) { out.error = l.error; quiet = true; return null; }
      var todo = want.filter(function (c) { return listedSizes(shaOf(c).slice(0, 12)).length > 0; }), i = 0;
      function next() {
        if (i >= todo.length) return null;
        if (pdfBlocked()) { quiet = true; return null; }
        var c = todo[i++], cur = bookNow(c.id);
        if (!cur || cur.deletedAt || cur.hasBytes !== false || shaOf(cur) !== shaOf(c)) return next();   // given its bytes or gone
        return restoreOne(cur, L).then(function (r) {
          if (r.ok) out.restored++;
          else if (!r.skip && !r.quiet) out.failed.push({ collectionId: c.id, name: bookName(cur), error: r.error || "unexpected error" });
          if (r.stop) { quiet = quiet || !!r.quiet; return null; }
          return next();
        });
      }
      return next();
    }).then(function () {
      setPdf({ running: false, left: 0 });
      var n = out.restored, f = out.failed, first = f[0];
      var lost = first ? (f.length === 1 ? "“" + first.name + "”" : plural(f.length, "PDF")) + " could not be restored — " + first.error + ". Choose file again in the library adds " +
        (f.length === 1 ? "it" : "them") + " by hand." : null;
      if (n) toast({ id: RESTORE_TOAST_ID, text: "Restored " + plural(n, "PDF") + " from your backup folder", detail: lost });
      else if (first) toast({ id: RESTORE_TOAST_ID, text: "Could not restore " + (f.length === 1 ? "the PDF of “" + first.name + "”" : plural(f.length, "PDF")) +
        " from your backup folder — " + first.error, detail: "Choose file again in the library adds " + (f.length === 1 ? "it" : "them") + " by hand." });
      out.ok = !f.length && !quiet;
      if (!out.error && f.length) out.error = cut(first.error);
      return out;
    });
  }

  // opts: {client, onProgress, quiet} (FEATURES E2.2, the cover's backup; see runSave)
  function savePdfs(opts) { return enqueuePdf("save", opts); }
  function restorePdfs() { return enqueuePdf("restore"); }
  // a promise for the moment no PDF upload or restore is queued or running (the welcome card waits for the restore an
  // import started before it reminds of the API key)
  function idle() { var q = pdfQueue; return q.then(function () { return pdfQueue === q ? undefined : idle(); }); }
  // This library's PDFs in the backup folder, by the last listing (FEATURES E2.2, the cover's result line): {books: the
  // live books, sha: those with a SHA-256 (only such a PDF can be saved), saved: those whose PDF the listing holds (null
  // before any listing)}
  function libraryPdfs() {
    var C = M.cache, list;
    try { list = C && typeof C.collections === "function" ? C.collections() : []; } catch (e) { list = []; }
    var books = (Array.isArray(list) ? list : []).filter(function (c) { return !!c && c.kind === "book" && !c.deletedAt; });
    var withSha = books.filter(function (c) { return !!shaOf(c); });
    return { books: books.length, sha: withSha.length, saved: pdf.known ? withSha.filter(savedCopy).length : null };
  }

  // GET /api/backup/latest (FEATURES E2.1d): the newest kept backup (the one GET /api/backup lists first) as text, its
  // file name from X-Marginalia-Backup-Name. → {ok: true, name, text} | {ok: false, error, none?: no backup yet,
  // outdated?: a serve.py from before the route}. Never rejects; nothing in the artifact, off http(s) or in memory mode.
  function latest() {
    var why = unavailableReason();
    if (why) return Promise.resolve({ ok: false, name: null, text: null, error: MSG[why] });
    return doFetch(LATEST_API, { method: "GET", headers: { "X-Marginalia": "1" }, cache: "no-store", credentials: "same-origin" })
      .then(function (r) {
        var status = r ? r.status : 0;
        if (r && r.ok) {
          var name = null;
          try { name = r.headers && typeof r.headers.get === "function" ? r.headers.get("X-Marginalia-Backup-Name") : null; } catch (e) { name = null; }
          return Promise.resolve().then(function () { return r.text(); }).then(function (text) {
            return { ok: true, name: name ? baseName(name) : null, text: str(text) };
          }, function () { return { ok: false, name: null, text: null, error: MSG.cut }; });
        }
        return readJson(r).then(function (j) {
          if (status === 404 && j && j.error === "no_backup") return { ok: false, name: null, text: null, none: true, error: MSG.no_backup };
          if (OLD_SERVER_STATUS[status] === true && localPage()) return { ok: false, name: null, text: null, outdated: true, error: MSG.latest_outdated };
          return { ok: false, name: null, text: null, error: serverError(status, j) };
        });
      }, function () { return { ok: false, name: null, text: null, error: MSG.no_server }; })
      .then(null, function (e) { report("latest", e); return { ok: false, name: null, text: null, error: "unexpected error (" + cut(e && e.message ? e.message : e) + ")" }; });
  }

  // ---------------------------------------------------------------- the automatic rule
  function autoBlocked() {
    if (st.status !== "on" || !enabled()) return "off";
    if (locked()) return "locked";
    if (hasToday()) return "done";
    var m = readMemo();
    if (m && m.day === st.today) return "failed";
    if (!libraryHasData()) return "empty";
    return null;
  }

  function maybeAuto() {
    if (autoBlocked()) return Promise.resolve(false);
    var day = st.today;
    return enqueue("auto").then(function (r) {
      if (!r) return false;                                    // nothing to do after all (a backup just before it)
      if (r.ok) { if (!r.skipped) savePdfs(); return true; }  // a backup written: the PDFs it lists follow (B9.4)
      if (r.error === MSG.locked) return false;                // this tab stepped aside: not a failure
      if (r.error === MSG.app || r.error === MSG.starting) return false;   // FEATURES E2.2: the app's page writes, not this one
      failed(day, r.error);
      return false;
    });
  }

  // Today's automatic attempt failed: not again today, and one toast.
  function failed(day, error) {
    var e = cut(error);
    writeMemo({ day: day || dayOf(now()), error: e });
    if (st.status === "on" || st.status === "off") update({ error: e });
    toast({ text: "Automatic backup failed — " + e, actions: [{ label: "Try again", run: tryAgain }] });
  }
  function tryAgain() {
    toast({ text: "Backing up…", ttl: 0 });                 // the result below replaces it (same toast id)
    runNow().then(function (r) {
      var U = M.util, size = typeof r.bytes === "number" && U && typeof U.fmtBytes === "function" ? " (" + U.fmtBytes(r.bytes) + ")" : "";
      if (r.ok) toast({ text: "Backed up · " + (st.dir ? st.dir + "/" : "") + r.file + size });
      else toast({ text: "Backup failed — " + r.error });
    });
  }

  // GET, then the automatic rule. One check at a time; never rejects.
  function check() {
    if (!started) return Promise.resolve(false);
    if (inflight) return inflight;
    if (locked()) { if (aside()) stop(); return Promise.resolve(false); }
    lastCheckAt = now();
    var p = ask().then(function (ok) {
      // at start, once the server first answers: the books without their bytes take them from the folder (B9.5)
      if (ok && restoreDue) { restoreDue = false; restorePdfs(); }
      return ok ? maybeAuto() : false;
    })
      .then(null, function (e) { report("check", e); return false; })
      .then(function (r) { if (inflight === p) inflight = null; return r; });
    inflight = p;
    return p;
  }

  function onVisibility() {
    var d = visDoc;
    if (!started || !d) return;
    var vis = d.visibilityState;
    if (vis ? vis !== "visible" : d.hidden === true) return;
    if (now() - lastCheckAt < VISIBLE_GAP_MS) return;
    check();
  }
  function bindVisibility() {
    if (visDoc) return;
    var d = root.document;
    if (!d || typeof d.addEventListener !== "function") return;
    try { d.addEventListener("visibilitychange", onVisibility); visDoc = d; } catch (e) { visDoc = null; }
  }
  function timerApi() {
    if (timerFns) return timerFns;
    return {
      setInterval: function (fn, ms) { return root.setInterval(fn, ms); },
      clearInterval: function (t) { return root.clearInterval(t); }
    };
  }
  function startTimer() {
    if (timer != null) return;
    try { timer = timerApi().setInterval(function () { check(); }, HOUR_MS); } catch (e) { timer = null; }
    if (timer && typeof timer.unref === "function") { try { timer.unref(); } catch (e) { /* Node only */ } }
  }
  // No more checks in this page (a newer tab took over, or _reset); a PDF run under way stops before its next PDF.
  function stop() {
    if (timer != null) { try { timerApi().clearInterval(timer); } catch (e) { /* ignore */ } timer = null; }
    if (visDoc) { try { visDoc.removeEventListener("visibilitychange", onVisibility); } catch (e) { /* ignore */ } visDoc = null; }
    started = false;
    restoreDue = false;
    pdf.stopped = true;
  }

  // ---------------------------------------------------------------- api
  // start() → Promise<state> once the first check (and the backup it may start) is done.
  function start() {
    var why = unavailableReason();
    if (why) {
      update({ status: "unavailable", reason: why, error: MSG[why], dir: null, today: null, files: [] });
      return Promise.resolve(snapshot());
    }
    if (aside()) return Promise.resolve(snapshot());
    // FEATURES E2.2c: a browser page the desktop app replaced (M.desktop cover mode) never backs up by itself, asks no
    // server and restores nothing (M.app's boot does not start it there either)
    if (desktopCovered()) return Promise.resolve(snapshot());
    if (!started) {
      started = true;
      restoreDue = true;
      pdf.stopped = false;
      if (st.status === "unavailable") st.status = "checking";
      changed();
      bindVisibility();
      startTimer();
    }
    return check().then(function () { return snapshot(); });
  }

  // runNow(opts) — opts (FEATURES E2.2, the cover's backup): client (X-Marginalia-Client of the POST, "browser-move"),
  // pdfs: false (the PDFs are not sent in the background: the caller sends them, savePdfs, and waits).
  function runNow(opts) {
    opts = opts || {};
    var client = typeof opts.client === "string" && opts.client ? opts.client : null;
    var why = unavailableReason();
    if (why) return Promise.resolve(result(false, null, MSG[why]));
    if (locked()) return Promise.resolve(result(false, null, MSG.locked));
    var cov = coverRefusal(client);
    if (cov) return Promise.resolve(result(false, null, cov));
    return enqueue("manual", client).then(function (r) {
      if (r && r.ok && !st.dir) ask().then(null, noop);       // the folder's name for Settings
      if (r && r.ok && opts.pdfs !== false) savePdfs(client ? { client: client } : undefined);   // B9.6: "Back up now" also saves the missing PDFs
      return r || result(false, null, null);
    });
  }

  function setEnabled(on) {
    var S = M.settings;
    if (!S || typeof S.set !== "function") return false;
    try { return S.set("autoBackup", !!on) === true; } catch (e) { report("setEnabled", e); return false; }
  }

  // Settings › Data asks again on every open: the backups and, while the server answers, the PDFs it keeps (B9.6).
  function refresh() {
    if (unavailableReason() || locked()) return Promise.resolve(snapshot());
    return ask().then(function (ok) { return ok ? listPdfs() : null; }).then(function () { return snapshot(); });
  }

  var bus = tryDep("bus");
  if (bus && typeof bus.on === "function") {
    // settings.autoBackup from anywhere (setEnabled, Settings, reset()): on ↔ off, and a check when turned on
    bus.on("settings:changed", function (e) {
      if (!e || e.key !== "autoBackup") return;
      if (st.status !== "on" && st.status !== "off") { changed(); return; }
      update({ status: enabled() ? "on" : "off" });
      if (st.status === "on" && started) Promise.resolve(inflight).then(function () { return check(); }).then(null, noop);
    });
    bus.on("store:mode", function (e) { if (e && e.reason === "othertab") stop(); });
    // D31: this window of the Mac app became the writer: the check it skipped as a reader
    bus.on("store:writer", function (e) { if (e && e.writer === true && started) Promise.resolve(inflight).then(function () { return check(); }).then(null, noop); });
    // FEATURES B9.5: an Import (M.exporter.importJSON) may have added books whose PDFs the backup folder holds
    bus.on("import:finished", function () {
      if (started && (st.status === "on" || st.status === "off")) restorePdfs();
    });
  }

  var api = {
    start: start,
    state: snapshot,
    runNow: runNow,
    setEnabled: setEnabled,
    // extensions
    refresh: refresh,
    savePdfs: savePdfs,
    restorePdfs: restorePdfs,
    // FEATURES E2.2 (the desktop app's welcome card and the cover of a browser page it replaced)
    latest: latest,
    idle: idle,
    libraryPdfs: libraryPdfs,
    hasToday: hasToday,
    STATUSES: STATUSES.slice(),
    HOUR_MS: HOUR_MS,
    VISIBLE_GAP_MS: VISIBLE_GAP_MS,
    MEMO_KEY: MEMO_KEY,
    // test hooks
    _setFetch: function (fn) { fetchFn = typeof fn === "function" ? fn : null; },
    _setNow: function (fn) { nowFn = typeof fn === "function" ? fn : null; },
    _setTimers: function (t) { timerFns = t && typeof t.setInterval === "function" && typeof t.clearInterval === "function" ? t : null; },
    // a promise for the moment no PDF upload or restore is queued or running (as idle())
    _idle: idle,
    _reset: function () { stop(); fetchFn = null; nowFn = null; timerFns = null; init(); }
  };
  M.backup = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (BUILD-NOTES "Automatic backup"; a module beside SPEC §17.2, loaded after js/obsidian.js and before
 * js/cache.js): start() → Promise<state> (M.app's boot after the store opened; GET /api/backup now, every HOUR_MS and on
 * visibilitychange to visible at most once per VISIBLE_GAP_MS; nothing in memory mode, off http(s) or in the artifact);
 * state() → {status: "checking"|"on"|"off"|"outdated"|"unavailable", dir, today, last: {name, date, bytes}|null, error,
 * running, reason, enabled}; runNow() → Promise<{ok, file, bytes, skipped, error}> (mode "manual", no toast, refused
 * while M.store.locked() or with an empty library); setEnabled(bool) → boolean (settings.autoBackup via M.settings.set);
 * bus event "backup:state" (the state) on every change. Automatic rule: status on, autoBackup not false, not locked,
 * at least one live collection or prompt, no file for the server's today, no failed automatic attempt today
 * (localStorage MEMO_KEY "marginalia.backup" {day, error}; kept in memory when storage refuses it, and today's copy in
 * memory wins over an older or unreadable stored value); the body is the manual JSON backup
 * (M.exporter.prepare("json", {scope: "all", collectionId: null, includeImages: true})) and never holds the API key;
 * one failure toast a day ("Try again" → runNow()), no retry loop. Extensions: refresh() → Promise<state>, STATUSES,
 * HOUR_MS, VISIBLE_GAP_MS, MEMO_KEY; test hooks _setFetch(fn), _setNow(fn), _setTimers({setInterval, clearInterval}),
 * _idle(), _reset().
 * FEATURES B9 (PDFs): state().pdfs = {saved, bytes, dir, running, left, error, outdated} | null; savePdfs() →
 * Promise<{ok, sent, failed: [{collectionId, name, error}], error}> after each backup written (auto not skipped, manual):
 * GET /api/backup/pdfs, then POST /api/backup/pdf (Content-Type application/pdf, X-Marginalia: 1, X-Marginalia-Sha256,
 * X-Marginalia-Name = encodeURIComponent(name)) for each live book with its bytes here (M.store.docs.loadBytes) and a
 * SHA-256 whose first 12 hex digits the folder lacks, or lists only with another size than the record's byteLength
 * (repair B9-R2: a saved PDF changed after it was saved; the answer's "setAside" names leave the listing), one at a
 * time; failures noted once (pdfs.error + toast id "backup-pdfs"), no retry before the next backup written;
 * restorePdfs() → Promise<{ok, restored, failed, error}> at the first answered check after start() and on
 * "import:finished": GET /api/backup/pdf/<sha256> → M.library.attachPdf(id, bytes) for each live book with hasBytes
 * false whose sha12 is listed (a 404 is a failure: "its saved copy “<file>” was changed after it was saved, so it is
 * not this book's file any more" from the 404's "changed", else "its saved copy is no longer in the backup folder"),
 * toast "Restored N PDF(s) from your backup folder" (id "backup-restore"); one queue for both; nothing while
 * M.store.locked(), in the artifact, off http(s) or in memory mode; no request when no book needs one.
 * FEATURES E2.2 (the desktop app, js/desktop.js): every POST's headers go through M.desktop.headers(base, client)
 * ("X-Marginalia-Client: app" in the app; unchanged elsewhere); runNow({client, pdfs}) and savePdfs({client, onProgress,
 * quiet}) for the cover's "browser-move" backup; in cover mode start() does nothing and every write without that client is
 * refused ("Marginalia is now an app — open it to back up"; while the app check runs: "Marginalia is still starting — try
 * again in a moment"); a 409 "app_only" shows the server's "message"; latest() →
 * Promise<{ok, name, text} | {ok: false, error, none?, outdated?}> (GET /api/backup/latest, X-Marginalia-Backup-Name);
 * idle() → Promise (no PDF run queued or running); libraryPdfs() → {books, sha, saved}; hasToday() → boolean (any file
 * of the last listing named for the server's today; repair SEC-1). */
