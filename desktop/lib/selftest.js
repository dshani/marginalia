"use strict";
// The packaged app's self-test (E1.5, E2.3 g): the scripts that run in the hidden window (pageScript, in two phases)
// and in a second hidden window that stands in for Brave (coverScript), the backup it prepares (preparedBackup), the
// probe of the window's close (closeProbe, which drives the window it is given), and the verdict (evaluate), which also
// weighs what the main process saw. Everything but the page scripts and closeProbe is pure; node --test covers all of it
// but the page scripts (closeProbe with stand-in windows and with main.js's own close handler).
//
// The run (main.js runSelfTest): phase "start" in the app's page; the main process notes the backup folder and the
// sandbox vault (the refused POSTs wrote nothing) and puts a prepared backup there (one book = test/sample.pdf in one
// folder, two prompts, as Brave's "Back up this browser's library" writes it, and the book's PDF as PDFs/<name>
// [<sha12>].pdf); phase "import" in the app's page; then the main process's own probes (right-clicks, a key press and
// window.open, the second launch's link, GET /api/app, the Brave stand-in, the window's close button).
//
// Checks, each {ok, detail}:
//   boot              window.Marginalia booted (M.app.boot() resolved true)
//   store-idb         M.store.mode() is "idb"
//   backup-on         M.backup.state() is "on" and names the --backup-dir folder
//   backup-write      M.backup.runNow() (after the import) wrote today's file there with the header the app's server
//                     demands (X-Marginalia-Client: app): not skipped, and the file is now a backup of the imported
//                     library (made after the prepared one, with its book and both prompts)
//   obsidian-server   M.obsidian.detect({force: true}) is server mode with exactly the sandbox vault
//   desktop-bridge    window.marginaliaDesktop is {app: true, version, platform, onOpenPdf (a function: D34)} and
//                     nothing else, frozen, read-only
//   no-node           the page sees no require, process, module or Buffer
//   pdfjs             pdfjsLib 3.11.174 with a blob: workerSrc (the integrity-checking bootstrap)
//   katex             katex 0.16.47 renders
//   fonts-local       every @font-face of the page loads (all 20 KaTeX fonts and Outfit: a damaged vendored font fails
//                     here; requests-local shows they came from the local copies)
//   app-api           GET /api/app (from the main process) answers 200 {ok: true, app: true, version: the app's version}:
//                     the app started its server with --app <version>
//   app-mode          M.desktop.mode() is "app" (the preload's bridge), and the cover (#cover) stays hidden and empty
//   persisted         navigator.storage.persisted() is true once boot asked for persistent storage (E2.2 e, E2.3 c);
//                     it follows the switch (lib/policy.js ALLOWED_PERMISSIONS, ctx.persistentStorage): with
//                     "persistent-storage" taken out it must be false, so a build with the switch off still installs
//   app-only          a POST without "X-Marginalia-Client: app" from the app's own page, to /api/backup (a valid backup)
//                     and to /api/obsidian/note (a valid note), gets 409 {error: "app_only", message}, and nothing was
//                     written: no backup file, no note in the sandbox vault
//   welcome-card      the empty library's home screen shows "Welcome to Marginalia" with "Import the newest
//                     backup" disabled and "No backup yet"; once the prepared backup is in the folder and M.backup has
//                     listed it again (as when the window comes back to the front), the button reads "Import the newest
//                     backup (today, HH:MM)" (the backup's own exportedAt) and is enabled
//   welcome-import    a click on it imports the backup: the import's toast, then "Restored 1 PDF from your backup folder",
//                     then the API key reminder, in that order; the card is gone; the library holds exactly the book (in
//                     its folder), the folder and the two prompts; the backup's settings were restored (obsidianFolder)
//   pdf-restore       the book's PDF came back from the backup folder (B9): hasBytes, its SHA-256 and size, and the bytes
//                     in the store hash to that SHA-256
//   sample-pdf        the restored book (test/sample.pdf, the web copy's file) opens in the reader through M.app.route,
//                     with all its pages, rendered, and PDF.js runs its real worker (no main-thread fake worker)
//   cmaps-blocked     a request for one of PDF.js's CJK character maps on cdnjs is cancelled by the app (it fails at once
//                     and never leaves the Mac; cdnjs refuses those files anyway)
//   download          a page download is saved without a dialog in self-test mode; the Save dialog options the app gives
//                     the download (the same call as for the user) start in Downloads with the file's name
//   external-links    window.open, a target=_blank link and a navigation to https://example.invalid/… without any user
//                     input are refused; after one key press one window.open reaches the shell.openExternal recorder
//                     (nothing opens) and a second one is refused; the page stays put, and a file: URL is not even tried
//   requests-local    every request the session made went to http://127.0.0.1:<port>/ (or was data:/blob:, or one the app
//                     cancelled)
//   hidden            no window was ever shown (the app's and the Brave stand-in's) and the app has no Dock icon
//   mock-keychain     Chromium runs with --use-mock-keychain
//   permissions       the page's Notification.requestPermission() was asked for and denied; persistent storage was never
//                     denied, persist() answers true; permission queries say clipboard read and write and
//                     persistent-storage "granted" and notifications, geolocation and camera "denied"; nothing but the
//                     clipboard and persistent storage was ever granted (with the persistent-storage switch off:
//                     persist() answers false, the query says "denied", and only the clipboard was ever granted)
//   menu              the built menu carries exactly the shortcuts of lib/menu.js
//   context-menu      a right-click on a canvas offers Copy Image and one in a text field offers Cut, Copy, Paste,
//                     Paste and Match Style and Select All (recorded by the app, never shown)
//   cover-mode        a second hidden window on the same address WITHOUT the preload (Brave's stand-in: no
//                     window.marginaliaDesktop) and with its own storage (another session partition, so the one-writing-tab
//                     rule leaves the app's window alone) shows the cover in real Chromium: "Marginalia is now an app",
//                     "Open the app" links to marginalia://open?hash=%23library (never followed), M.obsidian.send is
//                     refused with "Marginalia is now an app — open it to send to Obsidian." (and its toast), M.backup
//                     never started, and its session asked GET /api/app and nothing of /api/backup, sent no POST, and
//                     contacted no other host
//   tabs              (DECISIONS D30) the Window menu's tab commands, as main.js runs them in the page (lib/menu.js
//                     tabScript → the web app's M.tabs.run): New Tab adds a library tab after the tab on screen and
//                     the strip shows; Show Next Tab and Show Previous Tab go one tab on and one tab back; Close Tab
//                     closes the tab on screen, down to one tab, and then answers "last" (main.js then closes the
//                     window); Reopen Closed Tab brings the tab that was closed last back; no script for a name that
//                     is no tab command of the menu
//   windows           (DECISIONS D31) a second window of the app (never shown): its page takes the writer role as it
//                     starts and the first window's page becomes a reader, where a save is refused; a note saved in
//                     the second window is in the first window's copy only after the first has taken the role back
//                     (it reads the library again); a reader stores its own list of tabs; the second window closes
//                     for good, its list of tabs is forgotten, and the first window stays and can write again; a tab
//                     that moves out of the first window (the page's own M.tabs.moveToWindow, as a dragged tab) gets
//                     a third window with an id of its own, which closes for good too
//   close-hides       (lib/lifecycle.js CLOSE_HIDES) the main window's close (what its red button and Shift+Cmd+W do,
//                     and Cmd+W with one tab left) hid it:
//                     the close was prevented, the window's hide() ran during it (closeProbe: the self-test never shows
//                     the window, so isVisible() alone is false either way), and the window, its page and the server
//                     live on
//   link-handoff      (only when a second launch handed a link over: the runner's) marginalia://open?hash=%23library
//                     took the open reader to the library as a hash change (the same page, not a reload)
//   open-pdf          (D34) macOS hands the app a file that is no PDF and then test/sample.pdf, as `open -b` does: the
//                     first is refused in the main process, the second opens the imported book in the reader on the
//                     same page, with no book added and nothing left waiting
const SAMPLE_PDF = "test/sample.pdf";
const EXTERNAL_TEST_URL = "https://example.invalid/marginalia-self-test";   // .invalid never resolves (RFC 2606)
const NO_INPUT_VIAS = ["window.open", "anchor", "navigation"];
const AFTER_INPUT_VIAS = ["after-input", "second"];
const CMAP_TEST_FILE = "UniJIS-UCS2-H.bcmap";
const PROBE_ID = "marginalia-self-test-probe";
const DOWNLOAD_NAME = "marginalia-self-test.txt";
const DOWNLOAD_TEXT = "Marginalia self-test download\n";
const PHASES = ["start", "import"];
// The prepared backup (FEATURES E2.3 g): as Brave's cover writes it, one book (test/sample.pdf) in one folder, two prompts
const BOOK_NAME = "Self-test sample";
const FOLDER_NAME = "Self-test folder";
const OBSIDIAN_FOLDER = "Self-test notes";
const PROMPT_TEXTS = ["Q. What does the self-test import?\nA. One book in one folder, with two prompts.",
  "Q. Where does the book's PDF come from?\nA. The backup folder's PDFs folder."];
const DAY_MS = 86400000;
const INTERVAL_MS = 5 * DAY_MS;
// Texts of the web app and its server that the self-test expects (FEATURES E2.1 c, E2.2 c and d; B9's restore toast)
const TEXT = Object.freeze({
  welcomeTitle: "Welcome to Marginalia",
  importLabel: "Import the newest backup",
  noBackup: "No backup yet",
  restoredOne: "Restored 1 PDF from your backup folder",
  keyReminder: "Paste your Anthropic API key again in Settings → LaTeX from snips (backups never contain it).",
  coverTitle: "Marginalia is now an app",
  coverOpen: "Open the app",
  coverBackup: "Back up this browser's library",
  covered: "Marginalia is now an app — open it to send to Obsidian.",
  coverLink: "marginalia://open?hash=%23library",
  appOnly: "app_only",
  appOnlyMessage: "Marginalia is now an app. Open the Marginalia app to do this."
});
const APP_ONLY_ROUTES = ["/api/backup", "/api/obsidian/note"];
// The Brave stand-in's own storage: a session partition without "persist:" lives in memory and goes with the app
const COVER_PARTITION = "marginalia-self-test-brave";
const COVER_SETTLE_MS = 1500;   // how long the stand-in may go on after its checks: time for an automatic request to show

// ---- small pure helpers ------------------------------------------------------------------------------------------------
function pad2(n) { return (n < 10 ? "0" : "") + n; }
// the local day of `ms` as YYYY-MM-DD (serve.py names a backup after its local day)
function localDay(ms) { const d = new Date(ms); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
// the local time of `ms` as HH:MM (24 hours, as the welcome card writes it)
function hhmm(ms) { const d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }

// ---- the page scripts (stringified: they must not use anything from this file's scope) -----------------------------

// Phase "start", in the app's page: boot, the part 1 checks that need no PDF, app mode, persistent storage, the welcome
// card of the empty library, the refused POSTs, the permission probe, and test/sample.pdf as PDF.js reads it.
async function startChecks(opts) {
  const out = { errors: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(100);
    }
  };
  const step = async (name, fn) => {
    try { return await fn(); } catch (e) { out.errors.push(name + ": " + (e && e.message ? e.message : String(e))); return null; }
  };
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const M = await waitFor(() => (window.Marginalia && window.Marginalia.app && typeof window.Marginalia.app.boot === "function" ? window.Marginalia : null), 20000);
  if (!M) { out.errors.push("window.Marginalia did not load"); return out; }
  window.__marginaliaSelfTestMarker = out.marker = String(Math.random()).slice(2);   // a reload would lose it
  out.boot = await step("boot", () => Promise.race([M.app.boot(), sleep(30000).then(() => "timeout")]));
  out.storeMode = await step("store", () => M.store.mode());
  out.backup = await step("backup", () => waitFor(() => { const s = M.backup.state(); return s && s.status !== "checking" ? s : null; }, 15000));
  out.obsidian = await step("obsidian", () => M.obsidian.detect({ force: true }));
  out.desktop = await step("desktop", () => {
    const d = window.marginaliaDesktop;
    const desc = Object.getOwnPropertyDescriptor(window, "marginaliaDesktop") || {};
    let reassigned = false;
    try { window.marginaliaDesktop = { app: false }; reassigned = window.marginaliaDesktop !== d; } catch (e) { reassigned = false; }
    return d ? { app: d.app, version: d.version, platform: d.platform, onOpenPdf: typeof d.onOpenPdf, keys: Object.keys(d).sort(), frozen: Object.isFrozen(d),
      writable: desc.writable === true, configurable: desc.configurable === true, reassigned } : null;
  });
  out.nodeGlobals = { require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer };
  out.pdfjs = await step("pdfjs", () => ({ version: window.pdfjsLib && window.pdfjsLib.version,
    workerSrc: String(window.pdfjsLib.GlobalWorkerOptions.workerSrc || "").slice(0, 5) }));
  out.katex = await step("katex", () => ({ version: window.katex && window.katex.version,
    renders: window.katex.renderToString("\\frac{a}{b}").indexOf("katex") >= 0 }));
  out.fonts = await step("fonts", async () => {
    const faces = Array.from(document.fonts);
    const states = await Promise.all(faces.map((f) => f.load().then(() => "loaded", () => "error")));
    return faces.map((f, i) => ({ family: String(f.family).replace(/^["']|["']$/g, ""), weight: String(f.weight), style: String(f.style), status: states[i] }));
  });
  // FEATURES E2.2: the app's own page is in app mode, so no cover; boot asked for persistent storage (E2.2 e)
  out.appMode = await step("appMode", () => {
    const D = M.desktop, host = document.getElementById("cover"), s = D.state();
    return { mode: D.mode(), app: s.app, covered: s.covered,
      coverHidden: !!host && host.classList.contains("is-hidden") && !host.querySelector(".cover__panel") };
  });
  out.persisted = await step("persisted", async () => { await M.desktop.askPersist(); return navigator.storage.persisted(); });
  // the welcome card of the empty library, before any backup is in the folder
  out.welcomeBefore = await step("welcomeBefore", () => waitFor(() => {
    const c = document.querySelector("#library .lib-welcome");
    if (!c) return null;
    const imp = c.querySelector(".lib-welcome__import"), none = c.querySelector(".lib-welcome__none"), title = c.querySelector(".lib-welcome__title");
    const v = { title: title ? title.textContent : null, label: imp ? imp.textContent : null, disabled: imp ? imp.disabled : null,
      none: none ? none.textContent : null, file: !!c.querySelector(".lib-welcome__file"), empty: !!c.querySelector(".lib-welcome__empty") };
    return v.none === opts.text.noBackup ? v : null;
  }, 10000));
  // FEATURES E2.1 c: from the app's own page, a POST without "X-Marginalia-Client: app" is refused before its body is
  // read. Both bodies are ones the server would take, so a missing guard would write a backup or a note.
  out.appOnly = await step("appOnly", async () => {
    const d = new Date();
    const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const bodies = {
      "/api/backup": { mode: "manual", backup: { format: "marginalia", version: 1, exportedAt: Date.now(), scope: "all", folders: [], collections: [], prompts: [], attachments: [] } },
      "/api/obsidian/note": { vault: "Sandbox Vault", file: "Marginalia self-test.md", title: "Marginalia self-test", blockId: "selftest", images: [],
        markdown: "<!-- marginalia:selftest -->\nThis note must never be written: the server takes notes only from the app's own page.\n" + day + "\n<!-- /marginalia -->" }
    };
    const answers = [];
    for (const route of opts.appOnlyRoutes) {
      let status = null, json = null;
      try {
        const res = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json", "X-Marginalia": "1" },
          body: JSON.stringify(bodies[route]), cache: "no-store", credentials: "same-origin" });
        status = res.status;
        try { json = await res.json(); } catch (e) { json = null; }
      } catch (e) { status = "no answer: " + (e && e.message); }
      answers.push({ route, status, error: json ? json.error : null, message: json ? json.message : null });
    }
    return answers;
  });
  out.permissionProbe = await step("permissions", async () => {
    const query = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (e) { return "error " + (e && e.name); } };
    const q = {};
    for (const name of ["clipboard-read", "clipboard-write", "persistent-storage", "notifications", "geolocation", "camera"]) q[name] = await query(name);
    return {
      notification: typeof Notification === "function" ? await Notification.requestPermission() : "no Notification",
      persist: navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : "no persist",
      query: q
    };
  });
  // test/sample.pdf as the app's own PDF.js reads it: the prepared backup's book is that file (its id is the PDF's
  // fingerprint, as when Add PDF adds it)
  out.sample = await step("sample", async () => {
    const res = await fetch(opts.samplePdf, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    const task = window.pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
    try {
      const doc = await task.promise;
      return { sha256, byteLength: bytes.byteLength, fingerprint: doc.fingerprints && doc.fingerprints[0], numPages: doc.numPages };
    } finally { try { await task.destroy(); } catch (e) { /* gone */ } }
  });
  return out;
}

// Phase "import", in the app's page, once the prepared backup is in the folder: the welcome card's import and the PDF
// restore, the restored book in the reader, then the rest of part 1 (cMaps, Back up now, a download, right-click
// targets, and the links last: if a navigation were not stopped, the page would be gone).
async function importChecks(opts) {
  const out = { errors: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(100);
    }
  };
  const step = async (name, fn) => {
    try { return await fn(); } catch (e) { out.errors.push(name + ": " + (e && e.message ? e.message : String(e))); return null; }
  };
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const M = window.Marginalia;
  const e = opts.expect || {};
  // every toast, in the order it appears (a toast goes after its time: a MutationObserver sees each one come)
  const toasts = [];
  const seen = new WeakSet();
  const host = document.getElementById("toasts");
  const grab = () => {
    if (!host) return;
    for (const el of host.querySelectorAll(".toast")) {
      if (seen.has(el)) continue;
      seen.add(el);
      const t = el.querySelector(".toast__text");
      toasts.push(String(t ? t.textContent : el.textContent));
    }
  };
  const watcher = host ? new MutationObserver(grab) : null;
  if (watcher) watcher.observe(host, { childList: true, subtree: true });
  const card = () => document.querySelector("#library .lib-welcome");
  const button = () => { const c = card(); return c ? c.querySelector(".lib-welcome__import") : null; };
  // the folder is listed again, as when the window comes back to the front (the card asks then)
  await step("refresh", () => M.backup.refresh());
  out.welcomeReady = await step("welcomeReady", () => waitFor(() => {
    const b = button();
    return b && !b.disabled && b.textContent === e.label ? { label: b.textContent, disabled: b.disabled } : null;
  }, 10000));
  if (!out.welcomeReady) { const b = button(); out.welcomeSeen = b ? { label: b.textContent, disabled: b.disabled } : null; }
  // the user's click
  out.clicked = await step("click", () => { const b = button(); if (!b || b.disabled) return false; b.click(); return true; });
  out.importDone = await step("importDone", () => waitFor(() => (!M.desktop.state().importing && toasts.indexOf(opts.text.keyReminder) >= 0 ? true : null), 30000));
  await step("idle", () => M.backup.idle());
  grab();
  out.toasts = toasts.slice();
  out.cardAfter = !!card();
  out.library = await step("library", () => {
    const live = (x) => x && !x.deletedAt;
    return {
      books: M.cache.collections().filter((c) => live(c) && c.kind === "book").map((c) => ({ id: c.id, name: c.name, folderId: c.folderId || null,
        hasBytes: c.hasBytes, sha256: c.sha256, hashAlgo: c.hashAlgo, byteLength: c.byteLength })),
      decks: M.cache.collections().filter((c) => live(c) && c.kind === "deck").length,
      folders: M.cache.folders().filter(live).map((f) => ({ id: f.id, name: f.name, parentId: f.parentId || null })),
      prompts: M.cache.prompts().filter(live).map((p) => ({ id: p.id, collectionId: p.collectionId })),
      obsidianFolder: M.settings.get("obsidianFolder")
    };
  });
  // DECISIONS D33: a step on a card, its undo, its redo and its undo again, on the packaged page's own library
  // (IndexedDB) and through its own modules. The card is one that the import brought; it ends with the text it had.
  out.undo = await step("undo", async () => {
    const C = M.cache, U = M.undo;
    const p = C.prompts().filter((x) => x && !x.deletedAt)[0];
    const before = p.text, edited = before + " (self-test)";
    const parsed = M.prompts.parse(edited);
    U.clear();
    await C.savePrompt(Object.assign({}, p, { text: edited, kind: parsed.kind, tags: parsed.tags.slice(),
      cards: M.prompts.reconcileCards(p, parsed, Date.now()).cards }), { content: true, step: true });
    const steps = U.size().undo;
    const un = await U.undo();
    const undone = un.ok === true && C.prompt(p.id).text === before;
    const stored = ((await M.store.prompts.all()).find((x) => x.id === p.id) || {}).text === before;
    const re = await U.redo();
    const redone = re.ok === true && C.prompt(p.id).text === edited;
    const back = (await U.undo()).ok === true && C.prompt(p.id).text === before;
    U.clear();
    return { steps, undone, stored, redone, back, label: un.label || null };
  });
  out.restored = await step("restored", async () => {
    const bytes = await M.store.docs.loadBytes(e.bookId);
    if (!bytes) return { byteLength: 0, sha256: null };
    return { byteLength: bytes.byteLength, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)) };
  });
  // the reader opens the restored book
  await step("route", () => M.app.route("reader", { collectionId: e.bookId }));
  out.pdf = await step("pdf", () => waitFor(() => {
    const pv = M.pdfview;
    if (!pv.isOpen() || pv.numPages() < 1 || pv.renderedPages().length < 1) return null;
    const cur = M.app.current();
    return { pages: pv.numPages(), rendered: pv.renderedPages().length, screen: cur.screen, collectionId: cur.collectionId };
  }, 30000));
  out.fakeWorker = !!window.pdfjsWorker;
  out.cmap = await step("cmap", async () => {
    const url = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + window.pdfjsLib.version + "/cmaps/" + opts.cmapFile;
    const t0 = Date.now();
    try { const res = await fetch(url, { cache: "no-store" }); return { url, failed: false, status: res.status, ms: Date.now() - t0 }; }
    catch (err) { return { url, failed: true, ms: Date.now() - t0 }; }
  });
  out.backupRun = await step("backupRun", () => M.backup.runNow());
  await step("download", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([opts.downloadText], { type: "text/plain" }));
    a.download = opts.downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  // Right-click targets for the main process (lib/contextmenu.js): a small canvas and a text field, on top of the page.
  out.targets = await step("targets", () => {
    const box = document.createElement("div");
    box.id = opts.probeId;
    box.style.cssText = "position:fixed;left:8px;top:8px;z-index:2147483647;display:flex;gap:8px;background:#fff;padding:4px";
    const canvas = document.createElement("canvas");
    canvas.width = 60; canvas.height = 40;
    canvas.style.cssText = "width:60px;height:40px;display:block";
    const g = canvas.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0, 0, 60, 40);
    const field = document.createElement("textarea");
    field.spellcheck = true;
    field.value = "teh brwon foxx";
    field.style.cssText = "width:160px;height:40px;display:block";
    box.appendChild(canvas); box.appendChild(field);
    document.body.appendChild(box);
    const center = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
    const c = center(canvas), f = center(field);
    return { canvas: c, field: f, hits: { canvas: document.elementFromPoint(c.x, c.y) === canvas, field: document.elementFromPoint(f.x, f.y) === field } };
  });
  if (watcher) watcher.disconnect();
  // Links last. No user input has reached the page yet, so the app refuses all three (the main process then tries again
  // after a key press).
  out.windowOpen = await step("window.open", () => window.open(opts.externalUrl + "?via=window.open", "_blank") === null);
  await step("anchor", () => {
    const a = document.createElement("a");
    a.href = opts.externalUrl + "?via=anchor";
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  await step("navigate", () => { window.location.href = opts.externalUrl + "?via=navigation"; });
  await sleep(800);
  await step("file", () => { window.location.href = "file:///etc/hosts"; });
  await sleep(500);
  out.stillHere = window.location.origin;
  return out;
}

// In the Brave stand-in (no preload, its own storage): the page the app replaced shows the cover and refuses to send.
async function coverChecks(opts) {
  const out = { errors: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(100);
    }
  };
  const step = async (name, fn) => {
    try { return await fn(); } catch (e) { out.errors.push(name + ": " + (e && e.message ? e.message : String(e))); return null; }
  };
  const M = await waitFor(() => (window.Marginalia && window.Marginalia.app && window.Marginalia.desktop ? window.Marginalia : null), 20000);
  if (!M) { out.errors.push("window.Marginalia did not load"); return out; }
  out.bridge = typeof window.marginaliaDesktop;
  out.boot = await step("boot", () => Promise.race([M.app.boot(), sleep(30000).then(() => "timeout")]));
  out.mode = await step("mode", () => waitFor(() => (M.desktop.mode() === "cover" ? "cover" : null), 10000)) || M.desktop.mode();
  out.cover = await step("cover", () => {
    const host = document.getElementById("cover");
    const panel = host && host.querySelector(".cover__panel");
    const open = host && host.querySelector(".cover__open"), backup = host && host.querySelector(".cover__backup");
    const title = document.getElementById("coverTitle");
    const app = document.getElementById("app");
    const inert = app ? Array.from(app.children).filter((el) => el.hasAttribute("inert")).map((el) => el.id || el.tagName) : [];
    return { hidden: !host || host.classList.contains("is-hidden"), panel: !!panel, title: title ? title.textContent : null,
      open: open ? { tag: open.tagName, text: open.textContent, href: open.getAttribute("href") } : null,
      backup: backup ? backup.textContent : null, inert };
  });
  out.send = await step("send", async () => {
    const r = await M.obsidian.send("p_selftest", { fromGesture: true });
    return r ? { ok: r.ok, error: r.error } : null;
  });
  out.toast = await step("toast", () => waitFor(() => Array.from(document.querySelectorAll("#toasts .toast__text")).map((t) => t.textContent)
    .find((t) => t === opts.text.covered) || null, 5000));
  await sleep(opts.settleMs);                          // time for any automatic request (there must be none) to show
  out.backupStatus = await step("backupStatus", () => M.backup.state().status);
  out.hash = location.hash;
  return out;
}

function scriptOptions(opts) {
  return Object.assign({ samplePdf: SAMPLE_PDF, externalUrl: EXTERNAL_TEST_URL, downloadName: DOWNLOAD_NAME, downloadText: DOWNLOAD_TEXT,
    cmapFile: CMAP_TEST_FILE, probeId: PROBE_ID, text: TEXT, appOnlyRoutes: APP_ONLY_ROUTES, settleMs: COVER_SETTLE_MS }, opts || {});
}

// pageScript(phase, opts) → the expression the main process runs in the app's page ("start" or "import")
function pageScript(phase, opts) {
  const fn = phase === "import" ? importChecks : phase === "start" ? startChecks : null;
  if (!fn) throw new Error("no self-test phase " + JSON.stringify(phase));
  return "(" + fn.toString() + ")(" + JSON.stringify(scriptOptions(opts)) + ")";
}

// coverScript(opts) → the expression the main process runs in the Brave stand-in
function coverScript(opts) {
  return "(" + coverChecks.toString() + ")(" + JSON.stringify(scriptOptions(opts)) + ")";
}

// The two phases' answers as one report (errors of both).
function mergeRaw(start, imported) {
  const a = start || {}, b = imported || {};
  return Object.assign({}, a, b, { errors: (a.errors || []).concat(b.errors || []) });
}

// ---- the prepared backup -----------------------------------------------------------------------------------------------
// preparedBackup({now, sha256, byteLength, fingerprint, numPages, folderId, promptIds: [2 ids]}) → {name, text, pdfName,
// expect}: the JSON backup Brave's cover would write for a library of one book (test/sample.pdf, id its PDF.js
// fingerprint) in one folder with two prompts, made at `now` (exportedAt), named after its local day; pdfName = the name
// serve.py gives that book's PDF in PDFs/ ("<book name> [<sha12>].pdf"); expect = what the import must give.
function preparedBackup(o) {
  const x = o || {};
  if (typeof x.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(x.sha256)) throw new Error("preparedBackup needs the PDF's SHA-256");
  if (typeof x.fingerprint !== "string" || !x.fingerprint) throw new Error("preparedBackup needs the PDF's fingerprint");
  if (!(x.numPages >= 1) || !(x.byteLength >= 1) || !Array.isArray(x.promptIds) || x.promptIds.length !== 2 || !x.folderId) {
    throw new Error("preparedBackup needs the page count, the size, a folder id and two prompt ids");
  }
  const now = x.now;
  const t = now - DAY_MS;                    // the library was made a day before it was backed up
  const folder = { id: x.folderId, name: FOLDER_NAME, parentId: null, createdAt: t, updatedAt: t, deletedAt: null };
  const book = { id: x.fingerprint, kind: "book", name: BOOK_NAME, title: "", fileName: "sample.pdf", sha256: x.sha256, hashAlgo: "sha-256",
    byteLength: x.byteLength, hasBytes: true, pageCount: x.numPages, pageLabels: null, sections: [],
    lastPosition: { pageIndex: 0, fraction: 0, zoom: "fit" }, folderId: folder.id, folderUpdatedAt: t,
    addedAt: t, lastOpenedAt: t, updatedAt: t, contentUpdatedAt: t, deletedAt: null, v: 1 };
  const prompts = x.promptIds.map((id, i) => ({ id, collectionId: book.id, kind: "qa", text: PROMPT_TEXTS[i], tags: [], flagged: false, anchor: null,
    context: { docName: BOOK_NAME, sectionLabel: null, pageIndex: 0, pageLabel: "1" },
    cards: [{ i: 0, createdAt: t + i, lastReviewedAt: null, intervalMs: INTERVAL_MS, dueAt: t + i + INTERVAL_MS, log: [] }],
    dueAt: t + i + INTERVAL_MS, createdAt: t + i, contentUpdatedAt: t + i, updatedAt: t + i, deletedAt: null, v: 1 }));
  const backup = { format: "marginalia", version: 1, schedulerVersion: 1, exportedAt: now, scope: "all",
    settings: { obsidianFolder: OBSIDIAN_FOLDER }, folders: [folder], collections: [book], prompts, attachments: [] };
  const day = localDay(now);
  return {
    name: "marginalia-backup-" + day + ".json",
    text: JSON.stringify(backup, null, 2),
    pdfName: BOOK_NAME + " [" + x.sha256.slice(0, 12) + "].pdf",
    expect: { day, exportedAt: now, label: TEXT.importLabel + " (today, " + hhmm(now) + ")", bookId: book.id, bookName: BOOK_NAME,
      folderId: folder.id, folderName: FOLDER_NAME, promptIds: x.promptIds.slice(), sha256: x.sha256, byteLength: x.byteLength,
      numPages: x.numPages, obsidianFolder: OBSIDIAN_FOLDER }
  };
}

// What a backup file in the folder holds now: {exportedAt, collections: [ids], prompts: [ids]} (null: not a backup).
function backupSummary(text) {
  let b = null;
  try { b = JSON.parse(String(text)); } catch (e) { return null; }
  if (!b || b.format !== "marginalia") return null;
  const live = (r) => r && typeof r.id === "string" && !r.deletedAt;
  return { exportedAt: b.exportedAt, collections: (b.collections || []).filter(live).map((c) => c.id),
    prompts: (b.prompts || []).filter(live).map((p) => p.id) };
}

// ---- the verdict ----------------------------------------------------------------------------------------------------------

// Is every recorded request local? requests: [{url, blocked?}] from session.webRequest (blocked: the app cancelled it,
// so it never left the Mac).
function requestsLocal(requests, origin) {
  const bad = [];
  let local = 0, blocked = 0;
  for (const r of requests || []) {
    if (r && r.blocked === true) { blocked++; continue; }
    let u = null;
    try { u = new URL(r.url); } catch (e) { bad.push(String(r.url).slice(0, 200)); continue; }
    if (u.protocol === "data:" || u.protocol === "blob:") continue;
    if ((u.protocol === "http:" || u.protocol === "ws:") && u.origin.replace(/^ws:/, "http:") === origin) { local++; continue; }
    bad.push(u.protocol === "http:" || u.protocol === "https:" ? u.origin + u.pathname : u.protocol + "…");
  }
  return { ok: bad.length === 0 && local > 0, local, blocked, bad };
}

// The page's @font-face list → {faces, katex, outfit, failed}; ok when every face loaded, with all KaTeX fonts and Outfit.
const KATEX_FONTS = 20;   // the woff2 fonts katex.min.css 0.16.47 names (lib/vendor.js keeps exactly those)
function fontSummary(list) {
  const faces = Array.isArray(list) ? list : [];
  const failed = faces.filter((f) => f.status !== "loaded").map((f) => f.family + " " + f.weight + " " + f.style);
  const katex = faces.filter((f) => /^KaTeX_/.test(f.family)).length;
  const outfit = faces.filter((f) => f.family === "Outfit").length;
  return { ok: faces.length > 0 && failed.length === 0 && katex >= KATEX_FONTS && outfit >= 1, faces: faces.length, katex, outfit, failed };
}

// The Brave stand-in's requests, by kind: the /api/ ones (method and path) and whether any was a POST or a backup route.
function coverRequests(requests, origin) {
  const api = [];
  let posts = 0, backup = 0;
  for (const r of requests || []) {
    let u = null;
    try { u = new URL(r.url); } catch (e) { continue; }
    if (String(r.method || "GET").toUpperCase() === "POST") posts++;
    if (u.origin !== origin || !u.pathname.startsWith("/api/")) continue;
    api.push(String(r.method || "GET").toUpperCase() + " " + u.pathname);
    if (u.pathname === "/api/backup" || u.pathname.startsWith("/api/backup/")) backup++;
  }
  return { api, posts, backup };
}

const sameSet = (a, b) => JSON.stringify((a || []).slice().sort()) === JSON.stringify((b || []).slice().sort());

// closeProbe(win, {settle, serverRunning}) → {closeHides: true, destroyed, visible, hid, hides, pageAlive, serverRunning}
// The main window's close, as its red button, Shift+Cmd+W, and Cmd+W with one tab left send it (main.js runSelfTest,
// only with CLOSE_HIDES): the close
// must be prevented and the window hidden (main.js hideWindow calls win.hide()). The self-test never shows the window,
// so isVisible() is false whether or not the close hid it; the probe therefore watches this window's own hide() from the
// close until `settle()` has resolved (a wrapper on this one window, removed again afterwards, also when close() throws):
// `hid` says hide() ran (repair F2 of 2026-11-11: before, a close that was prevented but never hid the window passed).
async function closeProbe(win, o) {
  const opt = o || {};
  const own = Object.getOwnPropertyDescriptor(win, "hide");
  const hide = win.hide;
  let hides = 0;
  Object.defineProperty(win, "hide", { configurable: true, writable: true,
    value: function () { hides++; return hide.apply(win, arguments); } });
  try {
    win.close();
    if (opt.settle) await opt.settle();
  } finally {
    if (own) Object.defineProperty(win, "hide", own); else delete win.hide;
  }
  const destroyed = win.isDestroyed();
  let pageAlive = false;
  if (!destroyed) { try { pageAlive = (await win.webContents.executeJavaScript("1 + 1")) === 2; } catch (e) { pageAlive = false; } }
  return { closeHides: true, destroyed, visible: !destroyed && win.isVisible(), hid: hides > 0, hides, pageAlive,
    serverRunning: !!(opt.serverRunning && opt.serverRunning()) };
}

// ---- the tab commands (DECISIONS D30) ---------------------------------------------------------------------------------
// What the page shows of its tabs: how many, each tab's place in order, which one is on screen, and whether the strip
// is shown. `blocked` is for the report only: what stops the tab commands in the page when they do nothing
// (js/tabs.js blocked()).
const TABS_LOOK = "(function () { var M = window.Marginalia, d = document, l = M.tabs.list(), h = d.getElementById(\"tabs\"), a = -1; " +
  "for (var i = 0; i < l.length; i++) if (l[i].active) a = i; " +
  "var shown = function (id) { var e = d.getElementById(id); return !!e && !e.classList.contains(\"is-hidden\"); }, g = d.querySelector(\".dialog\"); " +
  "return { tabs: l.length, active: a, strip: !!h && !h.classList.contains(\"is-hidden\"), " +
  "places: l.map(function (t) { return String(t.screen) + (t.collectionId ? \":\" + t.collectionId : \"\"); }), " +
  "blocked: { modal: M.app.modal(), review: M.review.isActive(), settings: shown(\"settings\"), shortcuts: shown(\"shortcuts\"), " +
  "confirm: shown(\"confirm\"), cover: shown(\"cover\"), lock: !!d.getElementById(\"tabLock\"), dialog: g ? String(g.className) : null, " +
  "screen: M.app.current().screen } }; })()";
const TABS_CLOSE_MAX = 25;   // more closes than the web app allows tabs (20)
// Names that are no tab command of the menu (two of them are commands of the page): lib/menu.js tabScript must give
// no script for them.
const TABS_NOT_COMMANDS = ["tab1", "lastTab", "not-a-tab-command"];
// The probe's commands: `first`, then Close Tab until one tab is left (and once more), then `last`.
const TABS_STEPS = Object.freeze({ first: Object.freeze(["newTab", "newTab", "nextTab", "prevTab"]),
  last: Object.freeze(["newTab", "prevTab", "closeTab", "reopenTab", "closeTab"]) });

// tabsProbe({run, look, settle, script}) → {before, steps: [{id, answer, done, after}], unknown, error}
// The Window menu's tab commands as main.js sends them to the page (run(id) → a promise of the page's answer, one of
// lib/menu.js TAB_ANSWERS; look() → TABS_LOOK's answer), TABS_STEPS: New Tab twice (so there are three tabs or more,
// and next and previous differ); Show Next Tab; Show Previous Tab; Close Tab until the page does not answer "done"
// (one tab left: main.js then closes the window); then New Tab, Show Previous Tab and Close Tab, which closes the tab
// the page started with (in the self-test: the book's), so that Reopen Closed Tab must bring THAT tab back; Close
// Tab. `unknown` is what script(name) (lib/menu.js tabScript) gives for each of TABS_NOT_COMMANDS (null each:
// nothing but the five names reaches the page).
async function tabsProbe(o) {
  const opt = o || {};
  const out = { before: null, steps: [], unknown: null, error: null };
  const step = async (id) => {
    const answer = await opt.run(id);
    if (opt.settle) await opt.settle();
    out.steps.push({ id, answer: typeof answer === "string" ? answer : null, done: answer === "done", after: await opt.look() });
    return answer === "done";
  };
  try {
    out.unknown = typeof opt.script === "function" ? TABS_NOT_COMMANDS.map((name) => opt.script(name)) : null;
    out.before = await opt.look();
    for (const id of TABS_STEPS.first) await step(id);
    for (let i = 0; i < TABS_CLOSE_MAX && (await step("closeTab")); i++) { /* down to one tab */ }
    for (const id of TABS_STEPS.last) await step(id);
  } catch (e) { out.error = String(e && e.message ? e.message : e); }
  return out;
}

// tabsVerdict(probe) → {ok, why}: every step did exactly what its command says (which tab came, which tab went, which
// tab is on screen), the strip shows with two or more tabs only, and no name but the five has a script.
function tabsVerdict(t) {
  const fail = (why) => ({ ok: false, why });
  if (!t) return fail("no probe");
  if (t.error) return fail("error: " + t.error);
  if (!Array.isArray(t.unknown) || t.unknown.length !== TABS_NOT_COMMANDS.length || !t.unknown.every((v) => v === null)) {
    return fail("a script for a name that is no tab command");
  }
  const good = (s) => !!s && Number.isInteger(s.tabs) && s.tabs >= 1 && Number.isInteger(s.active) && s.active >= 0 && s.active < s.tabs &&
    s.strip === (s.tabs > 1) && Array.isArray(s.places) && s.places.length === s.tabs && s.places.every((x) => typeof x === "string" && !!x);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const withAt = (list, i, x) => list.slice(0, i).concat([x], list.slice(i));
  const without = (list, i) => list.slice(0, i).concat(list.slice(i + 1));
  if (!good(t.before)) return fail("before the first command");
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const ids = steps.map((s) => (s ? s.id : null));
  const closes = ids.length - TABS_STEPS.first.length - TABS_STEPS.last.length;     // the closes down to one tab, and one more
  const want = TABS_STEPS.first.concat(new Array(Math.max(0, closes)).fill("closeTab"), TABS_STEPS.last);
  if (closes < 3 || !same(ids, want)) return fail("the steps: " + ids.join(", "));
  const lastClose = TABS_STEPS.first.length + closes - 1;    // the close that found one tab left
  let prev = t.before, removed = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], a = s.after, at = "step " + (i + 1) + ", " + s.id;
    if (!good(a)) return fail(at + ": the page's answer");
    if (i === lastClose) {
      // one tab left: the page keeps it and says so ("last": main.js then closes the window)
      if (!(s.answer === "last" && s.done === false && prev.tabs === 1 && same(a.places, prev.places) && a.active === 0)) return fail(at);
    }
    else if (!(s.answer === "done" && s.done === true)) return fail(at + ": the page answered " + JSON.stringify(s.answer));
    else if (s.id === "newTab") {
      // a library tab right after the tab that was on screen, and it is on screen
      if (!(same(a.places, withAt(prev.places, prev.active + 1, "library")) && a.active === prev.active + 1)) return fail(at);
    }
    else if (s.id === "nextTab" || s.id === "prevTab") {
      // one tab on, or one tab back, round the ends (the first two are tried with three tabs or more: there they differ)
      const to = (prev.active + (s.id === "nextTab" ? 1 : prev.tabs - 1)) % prev.tabs;
      if (!((i >= TABS_STEPS.first.length || prev.tabs >= 3) && prev.tabs >= 2 && same(a.places, prev.places) && a.active === to)) return fail(at);
    }
    else if (s.id === "closeTab") {
      // the tab that was on screen goes; its right neighbour comes, else its left one
      if (!(same(a.places, without(prev.places, prev.active)) && a.active === Math.min(prev.active, a.tabs - 1))) return fail(at);
      removed = prev.places[prev.active];
    }
    else if (s.id === "reopenTab") {
      // the tab that was closed last comes back, right after the tab that was on screen, and it is on screen
      if (!(removed !== null && same(a.places, withAt(prev.places, prev.active + 1, removed)) && a.active === prev.active + 1)) return fail(at);
    }
    prev = a;
  }
  return prev.tabs === 1 ? { ok: true, why: null } : fail("tabs left: " + prev.tabs);
}

// ---- the windows (DECISIONS D31) ------------------------------------------------------------------------------------------
const WINDOW_ID = "selftest2";            // the second window's page: "?w=selftest2"
// What a window's page says of itself, once it has started.
const WINDOW_LOOK = "(async function () { var M = window.Marginalia; await M.app.boot(); var l = M.store.locked(), keys = []; " +
  "for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(\"marginalia.tabs\") === 0) keys.push(k); } " +
  "return { app: M.desktop.isApp(), w: M.tabs.windowId(), handover: M.store.handover(), writer: M.store.writer(), locked: l ? l.reason : null, " +
  "tabs: M.tabs.list().length, keys: keys.sort(), title: String(document.title) }; })()";
// The page takes the writer role, as it does when its window is used. → true | false
const WINDOW_TAKE = "(async function () { var M = window.Marginalia; await M.app.boot(); return (await M.app.takeRole()) === true; })()";
// A note saved through M.cache into the library's first book. → {ok: true, id} | {ok: false, code}
const WINDOW_WRITE = "(async function () { var M = window.Marginalia; await M.app.boot(); " +
  "var book = M.cache.collections({ live: true }).filter(function (c) { return c.kind === \"book\"; })[0]; " +
  "if (!book) return { ok: false, code: \"no_book\" }; " +
  "try { var p = await M.cache.savePrompt({ collectionId: book.id, kind: \"note\", text: \"Self-test: a note from another window\" }, { content: true }); " +
  "return { ok: true, id: String(p.id) }; } catch (e) { return { ok: false, code: e && e.code ? String(e.code) : String(e) }; } })()";
// A window that is not the writer keeps its own list of tabs: a tab comes in (as a tab dropped on its strip does),
// and the list is stored under the window's own key. → {came, stored, writer}
const WINDOW_STORE = "(async function () { var M = window.Marginalia, key = \"marginalia.tabs.\" + M.tabs.windowId(), t0 = Date.now(); " +
  "var came = M.tabs.adopt([{ screen: \"library\", collectionId: null, position: null, editing: null }]); " +
  "for (;;) { var n = 0; try { n = JSON.parse(localStorage.getItem(key)).tabs.length; } catch (e) { n = 0; } " +
  "if (n === M.tabs.list().length || Date.now() - t0 > 5000) return { came: came, stored: n, writer: M.store.writer() }; " +
  "await new Promise(function (r) { setTimeout(r, 50); }); } })()";
// A tab goes to a window of its own (as a tab that is dragged out of the strip): a second tab opens, then the page's
// own M.tabs.moveToWindow() moves it out. → {ok, before, opened, after} (how many tabs: at first, with the new tab,
// when it has gone)
const WINDOW_MOVE = "(async function () { var M = window.Marginalia; await M.app.boot(); var n0 = M.tabs.list().length; M.tabs.open(); " +
  "var n1 = M.tabs.list().length; var ok = false; try { ok = (await M.tabs.moveToWindow()) === true; } catch (e) { ok = false; } " +
  "return { ok: ok, before: n0, opened: n1, after: M.tabs.list().length }; })()";
const safeId = (id) => (typeof id === "string" && /^[A-Za-z0-9_:.-]{1,80}$/.test(id) ? id : "");
// Does this page's copy of the library have that note? / The note goes again (the page must be the writer).
function windowHas(id) { return "(function () { var p = window.Marginalia.cache.prompt(" + JSON.stringify(safeId(id)) + "); return !!p && !p.deletedAt; })()"; }
function windowRemove(id) {
  return "(async function () { try { await window.Marginalia.cache.removePrompt(" + JSON.stringify(safeId(id)) + "); " +
    "var p = window.Marginalia.cache.prompt(" + JSON.stringify(safeId(id)) + "); return !!p && !!p.deletedAt; } catch (e) { return false; } })()";
}

// windowsProbe({first, second, open, close}) → the report windowsVerdict reads.
// first(script), second(script) → a promise of the script's value in that window's page; open() → a promise of true
// when main.js made the second window ("?w=selftest2", never shown) and its page loaded; close() → a promise of
// {destroyed, firstAlive, windows} after the second window was closed; move() → a promise of {asked, opened, w, look,
// windows, destroyed, left, ms} (asked: WINDOW_MOVE's answer; look: WINDOW_LOOK in the new window; windows, left: how
// many windows with it and after its close; ms: how long the window took, for the record only).
// The story: the first window is the writer. A second window opens: its page takes the role as it starts, so the first
// is a reader. A note saved in the second window is not in the first window's copy. A save in the first window is
// refused. The first window takes the role back (as it does when it is used), which makes it read the library again:
// now it has the note, and the second is the reader. A reader keeps its own list of tabs: a tab that comes into the
// second window is stored under that window's key. The second window closes: it is gone (not hidden), its list of
// tabs is forgotten, and the first window stays and writes again when it is used.
// Then a tab moves out of the first window (move(): main.js runs WINDOW_MOVE in the first page and looks at the
// window that the page asked for): a third window, with that one tab under an id the page made; it closes for good
// too, and the first window has its tabs as before.
async function windowsProbe(o) {
  const out = { before: null, opened: false, second: null, firstAsReader: null, written: null, staleInFirst: null, refused: null,
    tookBack: null, seenInFirst: null, secondAsReader: null, stored: null, removed: null, closed: null, tookAgain: null, after: null,
    moved: null, last: null, end: null, error: null };
  try {
    out.before = await o.first(WINDOW_LOOK);
    out.opened = (await o.open()) === true;
    if (!out.opened) return out;
    out.second = await o.second(WINDOW_LOOK);
    out.firstAsReader = await o.first(WINDOW_LOOK);
    out.written = await o.second(WINDOW_WRITE);
    const id = out.written && out.written.ok === true ? out.written.id : null;
    if (id) {
      out.staleInFirst = await o.first(windowHas(id));
      out.refused = await o.first(WINDOW_WRITE);
      out.tookBack = await o.first(WINDOW_TAKE);
      out.seenInFirst = await o.first(windowHas(id));
      out.secondAsReader = await o.second(WINDOW_LOOK);
      out.stored = await o.second(WINDOW_STORE);
      out.removed = await o.first(windowRemove(id));
    }
    out.closed = await o.close();
    out.tookAgain = await o.first(WINDOW_TAKE);
    out.after = await o.first(WINDOW_LOOK);
    if (typeof o.move === "function") {
      out.moved = await o.move();
      out.last = await o.first(WINDOW_TAKE);
      out.end = await o.first(WINDOW_LOOK);
    }
  } catch (e) { out.error = String(e && e.message ? e.message : e); }
  return out;
}

// windowsVerdict(probe) → {ok, why}; `why` names the step and shows what the page answered.
function windowsVerdict(p) {
  const show = (v) => { try { return JSON.stringify(v === undefined ? null : v).slice(0, 220); } catch (e) { return String(v); } };
  const fail = (why, got) => ({ ok: false, why: got === undefined ? why : why + ": " + show(got) });
  if (!p) return fail("no probe");
  if (p.error) return fail("error: " + p.error);
  const key = "marginalia.tabs." + WINDOW_ID;
  const page = (s) => !!s && s.app === true && s.handover === true && Array.isArray(s.keys) && Number.isInteger(s.tabs) && s.tabs >= 1;
  const writer = (s) => page(s) && s.writer === true && s.locked === null;
  const reader = (s) => page(s) && s.writer === false && s.locked === "window";
  if (!(writer(p.before) && p.before.w === null)) return fail("the first window is not the writer at the start", p.before);
  if (p.opened !== true) return fail("the second window did not open");
  if (!(writer(p.second) && p.second.w === WINDOW_ID)) return fail("the second window's page did not take the role as it started", p.second);
  if (!reader(p.firstAsReader)) return fail("the first window did not give the role", p.firstAsReader);
  if (!(p.written && p.written.ok === true && typeof p.written.id === "string" && p.written.id)) return fail("the writer could not save", p.written);
  if (p.staleInFirst !== false) return fail("the reader had the note before it read again", p.staleInFirst);
  if (!(p.refused && p.refused.ok === false && p.refused.code === "locked")) return fail("a save in the reader was not refused", p.refused);
  if (p.tookBack !== true) return fail("the first window could not take the role back", p.tookBack);
  if (p.seenInFirst !== true) return fail("the first window did not read the library again", p.seenInFirst);
  if (!reader(p.secondAsReader)) return fail("the second window did not become a reader", p.secondAsReader);
  if (!(p.stored && p.stored.came === 1 && p.stored.stored === 2 && p.stored.writer === false)) return fail("a reader did not store its own list of tabs", p.stored);
  if (p.removed !== true) return fail("the note could not be taken out again", p.removed);
  const c = p.closed || {};
  if (!(c.destroyed === true && c.firstAlive === true && c.windows === 1)) return fail("the second window did not close for good", p.closed);
  if (p.tookAgain !== true) return fail("the first window could not write after the second closed", p.tookAgain);
  if (!(writer(p.after) && p.after.keys.indexOf(key) < 0 && p.after.keys.indexOf("marginalia.tabs") >= 0)) return fail("the closed window's list of tabs was not forgotten", p.after);
  // a tab that moves out
  const m = p.moved;
  if (!m) return fail("no tab was moved to a window of its own");
  const a = m.asked || {};
  if (!(a.ok === true && a.opened === a.before + 1 && a.after === a.before)) return fail("the tab did not leave the first window", m.asked);
  if (m.opened !== true) return fail("the page asked for a window, and none opened", m);
  if (!(typeof m.w === "string" && /^[a-z0-9]{6,16}$/.test(m.w) && m.w !== WINDOW_ID)) return fail("the new window has no id of its own", m.w);
  if (!(writer(m.look) && m.look.w === m.w && m.look.tabs === 1 && m.look.keys.indexOf("marginalia.tabs." + m.w) >= 0)) return fail("the new window does not hold the tab", m.look);
  if (!(m.windows === 2 && m.destroyed === true && m.left === 1)) return fail("the new window did not close for good", { windows: m.windows, destroyed: m.destroyed, left: m.left });
  if (p.last !== true) return fail("the first window could not write after the tab's window closed", p.last);
  if (!(writer(p.end) && p.end.tabs === a.before && p.end.keys.length === 1 && p.end.keys[0] === "marginalia.tabs")) return fail("the first window is not as it was", p.end);
  return { ok: true, why: null };
}

// evaluate(raw, ctx) → {ok, checks: {name: {ok, detail}}}
// ctx: {origin, version, backupDir, backupFiles, backupNow: backupSummary of today's file | null, externalOpens: [{url,
//       opened}], downloads, requests, windowEverShown, dockVisible, mockKeychain, permissions: [{permission, granted}],
//       menuAccelerators, expectedAccelerators, contextMenus: {canvas: {labels}, field: {labels}}, handoff: null | {hashes,
//       applied, before, after}, appApi: {status, body} | {error}, prepared: {ok, error, name, pdfName, expect},
//       folders: {afterRefusals: {backupFiles, vaultNotes}}, cover: {raw, requests, navigations, error},
//       close: closeProbe's answer | {closeHides: false, skipped: true}, tabs: tabsProbe's answer,
//       windows: windowsProbe's answer,
//       persistentStorage: whether lib/policy.js ALLOWED_PERMISSIONS has "persistent-storage" (the switch; anything but
//       false counts as on, so a report that does not say still demands the grant)}
function evaluate(raw, ctx) {
  const r = raw || {};
  const c = ctx || {};
  const checks = {};
  const put = (name, ok, detail) => { checks[name] = { ok: !!ok, detail: detail === undefined ? null : detail }; };
  const vaults = (r.obsidian && r.obsidian.vaults) || [];
  const d = r.desktop || {};
  const prepared = c.prepared || {};
  const ex = prepared.expect || {};
  put("boot", r.boot === true, r.boot);
  put("store-idb", r.storeMode === "idb", r.storeMode);
  put("backup-on", !!r.backup && r.backup.status === "on" && r.backup.dir === c.backupDir,
    r.backup ? { status: r.backup.status, dir: r.backup.dir, expected: c.backupDir } : null);
  const run = r.backupRun || null, now = c.backupNow || null;
  put("backup-write", !!run && run.ok === true && run.skipped === false && run.file === prepared.name && (c.backupFiles || []).indexOf(run.file) >= 0 &&
    !!now && typeof now.exportedAt === "number" && now.exportedAt > ex.exportedAt && sameSet(now.collections, [ex.bookId]) && sameSet(now.prompts, ex.promptIds),
    { run: run ? { ok: run.ok, file: run.file, skipped: run.skipped, error: run.error } : null, files: c.backupFiles || [], now });
  put("obsidian-server", !!r.obsidian && r.obsidian.mode === "server" && r.obsidian.server === true &&
    vaults.length === 1 && vaults[0].name === "Sandbox Vault", r.obsidian ? { mode: r.obsidian.mode, vaults: vaults.map((v) => v.name) } : null);
  put("desktop-bridge", d.app === true && d.version === c.version && d.platform === "darwin" &&
    d.onOpenPdf === "function" && JSON.stringify(d.keys) === JSON.stringify(["app", "onOpenPdf", "platform", "version"]) && d.frozen === true && d.writable === false &&
    d.configurable === false && d.reassigned === false, r.desktop || null);
  const ng = r.nodeGlobals || {};
  put("no-node", ["require", "process", "module", "Buffer"].every((k) => ng[k] === "undefined"), ng);
  put("pdfjs", !!r.pdfjs && r.pdfjs.version === "3.11.174" && r.pdfjs.workerSrc === "blob:", r.pdfjs || null);
  put("katex", !!r.katex && r.katex.version === "0.16.47" && r.katex.renders === true, r.katex || null);
  const fonts = fontSummary(r.fonts);
  put("fonts-local", fonts.ok, fonts);
  // ---- FEATURES E2.3 g
  const api = c.appApi || {}, body = api.body || {};
  put("app-api", api.status === 200 && body.ok === true && body.app === true && body.version === c.version, api);
  const am = r.appMode || {};
  put("app-mode", am.mode === "app" && am.app === true && am.covered === false && am.coverHidden === true, r.appMode || null);
  // the persistent-storage switch (repair REQ-D of 2026-11-11): the grant is expected only while lib/policy.js allows it
  const persist = c.persistentStorage !== false;
  put("persisted", r.persisted === persist, { persisted: r.persisted === undefined ? null : r.persisted, expected: persist });
  const answers = Array.isArray(r.appOnly) ? r.appOnly : [];
  const after = (c.folders && c.folders.afterRefusals) || null;
  put("app-only", APP_ONLY_ROUTES.every((route) => answers.some((a) => a && a.route === route && a.status === 409 && a.error === TEXT.appOnly &&
      a.message === TEXT.appOnlyMessage)) && !!after && Array.isArray(after.backupFiles) && after.backupFiles.length === 0 && after.vaultNotes === 0,
    { answers, afterRefusals: after });
  const wb = r.welcomeBefore || {}, wr = r.welcomeReady || {};
  put("welcome-card", prepared.ok === true && wb.title === TEXT.welcomeTitle && wb.label === TEXT.importLabel && wb.disabled === true &&
    wb.none === TEXT.noBackup && wb.file === true && wb.empty === true && wr.disabled === false && wr.label === ex.label,
    { before: r.welcomeBefore || null, ready: r.welcomeReady || null, seen: r.welcomeSeen || null, expected: ex.label || null,
      prepared: prepared.ok === true ? { name: prepared.name, pdfName: prepared.pdfName } : { error: prepared.error || "not prepared" } });
  const toasts = Array.isArray(r.toasts) ? r.toasts : [];
  const at = (pred) => toasts.findIndex(pred);
  const iImport = at((t) => /^Imported 2 prompts \(2 new, 0 updated, 0 unchanged\)/.test(t) && t.indexOf("1 new collection") >= 0 && t.indexOf("1 new folder") >= 0);
  const iRestore = at((t) => t === TEXT.restoredOne), iKey = at((t) => t === TEXT.keyReminder);
  const lib = r.library || {}, books = lib.books || [], folders = lib.folders || [], prompts = lib.prompts || [];
  const book = books[0] || {};
  put("welcome-import", r.clicked === true && r.importDone === true && iImport >= 0 && iImport < iRestore && iRestore < iKey && r.cardAfter === false &&
    books.length === 1 && book.id === ex.bookId && book.name === ex.bookName && book.folderId === ex.folderId && lib.decks === 0 &&
    folders.some((f) => f.id === ex.folderId && f.name === ex.folderName && f.parentId === null) && folders.length === 1 &&
    sameSet(prompts.map((p) => p.id), ex.promptIds) && prompts.every((p) => p.collectionId === ex.bookId) && lib.obsidianFolder === ex.obsidianFolder,
    { toasts, order: { imported: iImport, restored: iRestore, keyReminder: iKey }, cardAfter: r.cardAfter === undefined ? null : r.cardAfter,
      library: r.library || null, expected: { bookId: ex.bookId || null, folderId: ex.folderId || null, promptIds: ex.promptIds || null } });
  // ---- DECISIONS D33: undo and redo of a step on a card, in the packaged page
  const un = r.undo || {};
  put("undo-redo", un.steps === 1 && un.undone === true && un.stored === true && un.redone === true && un.back === true && un.label === "Edit", r.undo || null);
  const rs = r.restored || {};
  put("pdf-restore", book.hasBytes === true && book.sha256 === ex.sha256 && book.hashAlgo === "sha-256" && book.byteLength === ex.byteLength &&
    rs.sha256 === ex.sha256 && rs.byteLength === ex.byteLength,
    { book: books[0] || null, stored: r.restored || null, expected: { sha256: ex.sha256 || null, byteLength: ex.byteLength || null } });
  put("sample-pdf", !!r.pdf && r.pdf.pages === ex.numPages && r.pdf.rendered >= 1 && r.pdf.screen === "reader" && r.pdf.collectionId === ex.bookId &&
    r.fakeWorker === false, { pdf: r.pdf || null, fakeWorker: r.fakeWorker, expectedPages: ex.numPages || null });
  // ---- part 1
  const cm = r.cmap || {};
  const cmapBlocked = (c.requests || []).some((q) => q && q.blocked === true && q.url === cm.url);
  put("cmaps-blocked", cm.failed === true && cm.ms < 3000 && cmapBlocked, { url: cm.url || null, failed: cm.failed, ms: cm.ms, cancelledByApp: cmapBlocked });
  const dl = (c.downloads || [])[0] || null;
  put("download", (c.downloads || []).length === 1 && !!dl && dl.state === "completed" && dl.content === DOWNLOAD_TEXT &&
    typeof dl.dialogDefaultPath === "string" && typeof c.downloadsFolder === "string" &&
    dl.dialogDefaultPath === c.downloadsFolder + "/" + DOWNLOAD_NAME, dl);
  const opens = (c.externalOpens || []).map((e) => ({ via: String(e.url).startsWith(EXTERNAL_TEST_URL + "?via=") ? String(e.url).slice(EXTERNAL_TEST_URL.length + 5) : String(e.url), opened: e.opened === true }));
  const want = NO_INPUT_VIAS.map((v) => ({ via: v, opened: false })).concat([{ via: AFTER_INPUT_VIAS[0], opened: true }, { via: AFTER_INPUT_VIAS[1], opened: false }]);
  put("external-links", JSON.stringify(opens.slice().sort(byVia)) === JSON.stringify(want.slice().sort(byVia)) &&
    r.windowOpen === true && r.stillHere === c.origin, { recorded: opens, windowOpenReturnedNull: r.windowOpen, stillHere: r.stillHere });
  const req = requestsLocal(c.requests, c.origin);
  put("requests-local", req.ok, req);
  put("hidden", c.windowEverShown === false && c.dockVisible === false, { windowEverShown: c.windowEverShown, dockVisible: c.dockVisible });
  put("mock-keychain", c.mockKeychain === true, c.mockKeychain);
  const perms = c.permissions || [];
  const granted = perms.filter((p) => p.granted).map((p) => p.permission);
  const deniedRequest = (name) => perms.some((p) => p.permission === name && !p.granted);
  const pp = r.permissionProbe || {};
  const q = pp.query || {};
  const grantable = ["clipboard-read", "clipboard-sanitized-write"].concat(persist ? ["persistent-storage"] : []);
  put("permissions", granted.every((p) => grantable.indexOf(p) >= 0) && deniedRequest("notifications") && pp.notification === "denied" &&
    (persist ? !deniedRequest("persistent-storage") && pp.persist === true && q["persistent-storage"] === "granted"
      : pp.persist === false && q["persistent-storage"] === "denied") &&
    q["clipboard-read"] === "granted" && q["clipboard-write"] === "granted" &&
    q.notifications === "denied" && q.geolocation === "denied" && q.camera === "denied",
    { requested: perms.map((p) => p.permission + (p.granted ? ":granted" : ":denied")), page: r.permissionProbe || null, persistentStorage: persist });
  put("menu", JSON.stringify(c.menuAccelerators || []) === JSON.stringify(c.expectedAccelerators || null), c.menuAccelerators || null);
  const menus = c.contextMenus || {};
  const has = (m, labels) => !!m && Array.isArray(m.labels) && labels.every((l) => m.labels.indexOf(l) >= 0);
  put("context-menu", has(menus.canvas, ["Copy Image"]) && has(menus.field, ["Cut", "Copy", "Paste", "Paste and Match Style", "Select All"]) &&
    !has(menus.field, ["Copy Image"]), { canvas: menus.canvas || null, field: menus.field || null, targets: r.targets || null });
  // ---- FEATURES E2.3 g: the Brave stand-in, and the window's close
  const cv = c.cover || {}, cr = cv.raw || {}, cc = cr.cover || {};
  const kinds = coverRequests(cv.requests, c.origin);
  const coverLocal = requestsLocal(cv.requests, c.origin);
  put("cover-mode", !cv.error && cr.bridge === "undefined" && cr.boot === true && cr.mode === "cover" && cc.hidden === false && cc.panel === true &&
    cc.title === TEXT.coverTitle && !!cc.open && cc.open.tag === "A" && cc.open.text === TEXT.coverOpen && cc.open.href === TEXT.coverLink &&
    cc.backup === TEXT.coverBackup && !!cr.send && cr.send.ok === false && cr.send.error === TEXT.covered && cr.toast === TEXT.covered &&
    cr.backupStatus === "checking" && (cr.errors || []).length === 0 && kinds.api.indexOf("GET /api/app") >= 0 && kinds.backup === 0 &&
    kinds.posts === 0 && coverLocal.ok && (cv.navigations || []).length === 0,
    { page: cv.raw || null, requests: kinds, local: coverLocal, navigations: cv.navigations || [], error: cv.error || null });
  const cl = c.close || {};
  put("close-hides", cl.closeHides === false ? cl.skipped === true :
    cl.closeHides === true && cl.destroyed === false && cl.hid === true && cl.visible === false && cl.pageAlive === true && cl.serverRunning === true,
    c.close || null);
  const tv = tabsVerdict(c.tabs);
  put("tabs", tv.ok, { why: tv.why, blocked: c.tabs && c.tabs.before ? c.tabs.before.blocked || null : null, probe: c.tabs || null });
  const wv = windowsVerdict(c.windows);
  put("windows", wv.ok, { why: wv.why, probe: c.windows || null });
  if (c.handoff) {
    const h = c.handoff, b = h.before || {}, a = h.after || {};
    put("link-handoff", JSON.stringify(h.hashes) === JSON.stringify(["#library"]) && h.applied === true && b.screen === "reader" &&
      a.screen === "library" && a.hash === "#library" && !!a.marker && a.marker === b.marker && a.timeOrigin === b.timeOrigin, h);
  }
  const op = c.openPdf || {}, ob = op.before || {}, oa = op.after || {};
  put("open-pdf", !op.error && !!ex.bookId && ob.screen === "library" && oa.screen === "reader" && oa.collectionId === ex.bookId &&
    oa.books === ob.books && ob.books >= 1 && !!oa.marker && oa.marker === ob.marker && op.refused === 1 && op.waiting === 0, c.openPdf || null);
  if (r.errors && r.errors.length) put("page-errors", false, r.errors);
  const ok = Object.keys(checks).every((k) => checks[k].ok);
  return { ok, checks };
}

function byVia(a, b) { return a.via < b.via ? -1 : a.via > b.via ? 1 : 0; }

module.exports = { startChecks, importChecks, coverChecks, pageScript, coverScript, mergeRaw, preparedBackup, backupSummary, evaluate,
  closeProbe, tabsProbe, tabsVerdict, TABS_LOOK, TABS_CLOSE_MAX, TABS_NOT_COMMANDS, TABS_STEPS, windowsProbe, windowsVerdict,
  WINDOW_ID, WINDOW_LOOK, WINDOW_TAKE, WINDOW_WRITE, WINDOW_STORE, WINDOW_MOVE, windowHas, windowRemove, requestsLocal, fontSummary, coverRequests, localDay, hhmm, SAMPLE_PDF, EXTERNAL_TEST_URL, DOWNLOAD_NAME, DOWNLOAD_TEXT, NO_INPUT_VIAS,
  AFTER_INPUT_VIAS, PROBE_ID, KATEX_FONTS, PHASES, TEXT, APP_ONLY_ROUTES, COVER_PARTITION, COVER_SETTLE_MS, BOOK_NAME, FOLDER_NAME,
  OBSIDIAN_FOLDER };
