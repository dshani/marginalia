"use strict";
// lib/selftest.js: the verdict (each check, and each fault failing only its own check), the prepared backup, and the
// page scripts as text (the packaged run itself is `npm run app`, step 7).
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const st = require("../lib/selftest");
const menu = require("../lib/menu");

const ORIGIN = "http://127.0.0.1:49152";
const ACCEL = menu.accelerators(menu.buildTemplate({}));

const CMAP = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/UniJIS-UCS2-H.bcmap";
const KATEX = ["AMS-Regular", "Caligraphic-Bold", "Caligraphic-Regular", "Fraktur-Bold", "Fraktur-Regular", "Main-Bold", "Main-BoldItalic",
  "Main-Italic", "Main-Regular", "Math-BoldItalic", "Math-Italic", "SansSerif-Bold", "SansSerif-Italic", "SansSerif-Regular", "Script-Regular",
  "Size1-Regular", "Size2-Regular", "Size3-Regular", "Size4-Regular", "Typewriter-Regular"];
const via = (v, opened) => ({ url: st.EXTERNAL_TEST_URL + "?via=" + v, opened });
const SHA = "a6758b1c96ede6efe0d3d0890541ae64efe0bf43e963ab257bbdf95b8bc9849a";
const NOW = new Date(2026, 10, 11, 9, 12, 30).getTime();
const PROMPTS = ["p_00000000-0000-4000-8000-000000000001", "p_00000000-0000-4000-8000-000000000002"];

function prepared() {
  const p = st.preparedBackup({ now: NOW, sha256: SHA, byteLength: 27109, fingerprint: "45cff13ffd7238db6ed3320bf258d631", numPages: 3,
    folderId: "folder_1", promptIds: PROMPTS });
  return { ok: true, name: p.name, pdfName: p.pdfName, expect: p.expect };
}

function goodRaw() {
  const ex = prepared().expect;
  return {
    errors: [], boot: true, storeMode: "idb", marker: "123",
    backup: { status: "on", dir: "/private/tmp/st/backups" },
    obsidian: { mode: "server", server: true, vaults: [{ name: "Sandbox Vault" }] },
    desktop: { app: true, version: "1.0.0", platform: "darwin", onOpenPdf: "function", keys: ["app", "onOpenPdf", "platform", "version"], frozen: true, writable: false, configurable: false, reassigned: false },
    nodeGlobals: { require: "undefined", process: "undefined", module: "undefined", Buffer: "undefined" },
    pdfjs: { version: "3.11.174", workerSrc: "blob:" },
    katex: { version: "0.16.47", renders: true },
    fonts: KATEX.map((k) => ({ family: "KaTeX_" + k.split("-")[0], weight: /Bold/.test(k) ? "700" : "400", style: /Italic/.test(k) ? "italic" : "normal", status: "loaded" }))
      .concat([{ family: "Outfit", weight: "300 700", style: "normal", status: "loaded" }, { family: "Outfit", weight: "300 700", style: "normal", status: "loaded" }]),
    appMode: { mode: "app", app: true, covered: false, coverHidden: true },
    persisted: true,
    welcomeBefore: { title: "Welcome to Marginalia", label: "Import the newest backup", disabled: true, none: "No backup yet", file: true, empty: true },
    appOnly: [{ route: "/api/backup", status: 409, error: "app_only", message: st.TEXT.appOnlyMessage },
      { route: "/api/obsidian/note", status: 409, error: "app_only", message: st.TEXT.appOnlyMessage }],
    permissionProbe: { notification: "denied", persist: true,
      query: { "clipboard-read": "granted", "clipboard-write": "granted", "persistent-storage": "granted", notifications: "denied", geolocation: "denied", camera: "denied" } },
    sample: { sha256: SHA, byteLength: 27109, fingerprint: ex.bookId, numPages: 3 },
    welcomeReady: { label: "Import the newest backup (today, 09:12)", disabled: false },
    clicked: true, importDone: true,
    toasts: ["Imported 2 prompts (2 new, 0 updated, 0 unchanged) · 1 new collection · 1 new folder", "Restored 1 PDF from your backup folder", st.TEXT.keyReminder],
    cardAfter: false,
    library: { books: [{ id: ex.bookId, name: ex.bookName, folderId: ex.folderId, hasBytes: true, sha256: SHA, hashAlgo: "sha-256", byteLength: 27109 }],
      decks: 0, folders: [{ id: ex.folderId, name: ex.folderName, parentId: null }], prompts: PROMPTS.map((id) => ({ id, collectionId: ex.bookId })),
      obsidianFolder: "Self-test notes" },
    undo: { steps: 1, undone: true, stored: true, redone: true, back: true, label: "Edit" },
    restored: { byteLength: 27109, sha256: SHA },
    pdf: { pages: 3, rendered: 2, screen: "reader", collectionId: ex.bookId }, fakeWorker: false,
    cmap: { url: CMAP, failed: true, ms: 4 },
    targets: { canvas: { x: 42, y: 32 }, field: { x: 160, y: 32 }, hits: { canvas: true, field: true } },
    backupRun: { ok: true, file: "marginalia-backup-2026-11-11.json", skipped: false },
    windowOpen: true, stillHere: ORIGIN
  };
}
// A page with tabs that behaves as js/tabs.js does (its answers as lib/menu.js tabScript reports them), and the tab
// probe's report on it. The page of the self-test has two tabs then: the book's, and the library tab that the
// handed-over link made.
function tabsPage(places, active) {
  const page = { places: places.slice(), active, closed: [] };
  page.run = (id) => {
    const n = page.places.length;
    if (id === "newTab") { page.places.splice(page.active + 1, 0, "library"); page.active++; return "done"; }
    if (id === "closeTab") { if (n < 2) return "last"; page.closed.push(page.places[page.active]); page.places.splice(page.active, 1); page.active = Math.min(page.active, page.places.length - 1); return "done"; }
    if (id === "reopenTab") { if (!page.closed.length) return n > 1 ? "blocked" : "last"; page.places.splice(page.active + 1, 0, page.closed.pop()); page.active++; return "done"; }
    if (id === "nextTab" || id === "prevTab") { if (n < 2) return "last"; page.active = (page.active + (id === "nextTab" ? 1 : n - 1)) % n; return "done"; }
    return "none";
  };
  page.look = () => ({ tabs: page.places.length, active: page.active, strip: page.places.length > 1, places: page.places.slice() });
  return page;
}
function tabsReport(places, active) {
  const page = tabsPage(places, active), out = { before: page.look(), steps: [], unknown: st.TABS_NOT_COMMANDS.map(() => null), error: null };
  const step = (id) => { const answer = page.run(id); out.steps.push({ id, answer, done: answer === "done", after: page.look() }); return answer === "done"; };
  st.TABS_STEPS.first.forEach(step);
  while (step("closeTab")) { /* down to one tab */ }
  st.TABS_STEPS.last.forEach(step);
  return out;
}
const goodTabs = () => tabsReport(["reader:45cff13ffd7238db6ed3320bf258d631", "library"], 1);
// The windows probe's report, as the pages of two (then three) windows answer it (DECISIONS D31): what a page says of
// itself (WINDOW_LOOK), and the whole story.
const look = (o) => Object.assign({ app: true, w: null, handover: true, writer: true, locked: null, tabs: 1, keys: ["marginalia.tabs"], title: "Marginalia" }, o);
const W3 = "k3x9q2m4p7";                  // the id the page made for the window of the tab that moved out
function goodWindows() {
  return {
    before: look(),
    opened: true,
    second: look({ w: st.WINDOW_ID }),
    firstAsReader: look({ writer: false, locked: "window" }),
    written: { ok: true, id: "p_note1" },
    staleInFirst: false,
    refused: { ok: false, code: "locked" },
    tookBack: true,
    seenInFirst: true,
    secondAsReader: look({ w: st.WINDOW_ID, writer: false, locked: "window" }),
    stored: { came: 1, stored: 2, writer: false },
    removed: true,
    closed: { destroyed: true, firstAlive: true, windows: 1 },
    tookAgain: true,
    after: look(),
    moved: { asked: { ok: true, before: 1, opened: 2, after: 1 }, opened: true, w: W3,
      look: look({ w: W3, keys: ["marginalia.tabs", "marginalia.tabs." + W3] }), windows: 2, destroyed: true, left: 1 },
    last: true,
    end: look(),
    error: null
  };
}
function goodCtx() {
  const p = prepared();
  return {
    origin: ORIGIN, version: "1.0.0", backupDir: "/private/tmp/st/backups", backupFiles: ["marginalia-backup-2026-11-11.json"],
    backupNow: { exportedAt: NOW + 60000, collections: [p.expect.bookId], prompts: PROMPTS.slice().reverse() },
    externalOpens: [via("window.open", false), via("anchor", false), via("navigation", false), via("after-input", true), via("second", false)],
    downloads: [{ name: st.DOWNLOAD_NAME, dialogDefaultPath: "/Users/x/Downloads/" + st.DOWNLOAD_NAME, state: "completed", content: st.DOWNLOAD_TEXT }],
    downloadsFolder: "/Users/x/Downloads",
    requests: [{ url: ORIGIN + "/" }, { url: ORIGIN + "/vendor/fonts/outfit.css" }, { url: "data:font/woff2;base64,AA" }, { url: "blob:" + ORIGIN + "/x" },
      { url: CMAP, blocked: true }],
    windowEverShown: false, dockVisible: false, mockKeychain: true,
    permissions: [{ permission: "notifications", granted: false }, { permission: "persistent-storage", granted: true }],
    menuAccelerators: ACCEL, expectedAccelerators: ACCEL,
    contextMenus: { canvas: { labels: ["Copy Image"] }, field: { labels: ["teh", "-", "Cut", "Copy", "Paste", "Paste and Match Style", "Select All"] } },
    handoff: { hashes: ["#library"], applied: true, before: { screen: "reader", marker: "123", timeOrigin: 1.5 },
      after: { screen: "library", hash: "#library", marker: "123", timeOrigin: 1.5 } },
    openPdf: { before: { screen: "library", collectionId: null, books: 1, marker: "123" },
      after: { screen: "reader", collectionId: p.expect.bookId, books: 1, marker: "123" }, refused: 1, waiting: 0, error: null },
    zotero: { page: { sent: true, books: [{ sha256: p.expect.sha256, prompts: 2, book: p.expect.bookId }] }, status: 200,
      body: { ok: true, books: { [p.expect.sha256]: 2 }, links: { [p.expect.sha256]: p.expect.bookId }, at: 5 }, error: null },
    appApi: { status: 200, body: { ok: true, app: true, version: "1.0.0" } },
    prepared: p,
    folders: { afterRefusals: { backupFiles: [], vaultNotes: 0 } },
    cover: {
      raw: { errors: [], bridge: "undefined", boot: true, mode: "cover",
        cover: { hidden: false, panel: true, title: "Marginalia is now an app", open: { tag: "A", text: "Open the app", href: "marginalia://open?hash=%23library" },
          backup: "Back up this browser's library", inert: ["main"] },
        send: { ok: false, error: st.TEXT.covered }, toast: st.TEXT.covered, backupStatus: "checking", hash: "" },
      requests: [{ url: ORIGIN + "/", method: "GET" }, { url: ORIGIN + "/js/app.js", method: "GET" }, { url: ORIGIN + "/api/app", method: "GET" }],
      navigations: [], consoleErrors: [], error: null
    },
    close: { closeHides: true, destroyed: false, visible: false, hid: true, hides: 1, pageAlive: true, serverRunning: true },
    tabs: goodTabs(),
    windows: goodWindows(),
    persistentStorage: true
  };
}

test("everything as it should be: the self-test passes", () => {
  const v = st.evaluate(goodRaw(), goodCtx());
  assert.deepEqual(Object.entries(v.checks).filter(([, c]) => !c.ok).map(([k]) => k), []);
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.checks).sort(), ["app-api", "app-mode", "app-only", "backup-on", "backup-write", "boot", "close-hides", "cmaps-blocked",
    "context-menu", "cover-mode", "desktop-bridge", "download", "external-links", "fonts-local", "hidden", "katex", "link-handoff", "menu",
    "mock-keychain", "no-node", "obsidian-server", "open-pdf", "pdf-restore", "pdfjs", "permissions", "persisted", "requests-local", "sample-pdf",
    "store-idb", "tabs", "undo-redo", "welcome-card", "welcome-import", "windows", "zotero-books"]);
  const alone = goodCtx();
  alone.handoff = null;                               // the app run by hand: no second launch, no link-handoff check
  const w = st.evaluate(goodRaw(), alone);
  assert.equal(w.ok, true);
  assert.equal(w.checks["link-handoff"], undefined);
  const off = goodCtx();
  off.close = { closeHides: false, skipped: true };   // the switch off: the close is not tried in the self-test
  assert.equal(st.evaluate(goodRaw(), off).checks["close-hides"].ok, true);
});

test("each fault fails its own check", () => {
  const cases = [
    ["boot", (r) => { r.boot = "timeout"; }],
    ["store-idb", (r) => { r.storeMode = "memory"; }],
    ["backup-on", (r) => { r.backup.dir = "~/Documents/Marginalia Backups"; }],
    ["backup-write", (r, c) => { c.backupFiles = []; }],
    ["backup-write", (r) => { r.backupRun.skipped = true; }],
    ["backup-write", (r) => { r.backupRun.ok = false; r.backupRun.error = "Marginalia is now an app. Open the Marginalia app to do this."; }],
    ["backup-write", (r, c) => { c.backupNow.exportedAt = NOW; }],                 // still the prepared file: nothing was written
    ["backup-write", (r, c) => { c.backupNow.prompts = c.backupNow.prompts.slice(1); }],
    ["obsidian-server", (r) => { r.obsidian.vaults.push({ name: "Obsidian Vault" }); }],
    ["obsidian-server", (r) => { r.obsidian.mode = "link"; }],
    ["desktop-bridge", (r) => { r.desktop.keys.push("ipc"); }],
    ["desktop-bridge", (r) => { r.desktop.frozen = false; }],
    ["desktop-bridge", (r) => { r.desktop.onOpenPdf = "undefined"; r.desktop.keys = ["app", "platform", "version"]; }],
    ["open-pdf", (r, c) => { c.openPdf.after.screen = "library"; }],                // the PDF did not open its book
    ["open-pdf", (r, c) => { c.openPdf.after.books = 2; }],                         // the same PDF was added again
    ["open-pdf", (r, c) => { c.openPdf.after.marker = "456"; }],                    // the page reloaded
    ["open-pdf", (r, c) => { c.openPdf.refused = 0; }],                             // the file that is no PDF got through
    ["open-pdf", (r, c) => { c.openPdf.waiting = 1; }],                             // a PDF never reached the page
    ["open-pdf", (r, c) => { c.openPdf.error = "boom"; }],
    ["zotero-books", (r, c) => { c.zotero.status = 404; }],                           // the server has no such route
    ["zotero-books", (r, c) => { c.zotero.body.books = {}; }],                        // the page's list never got there
    ["zotero-books", (r, c) => { c.zotero.page.books[0].prompts = 0; c.zotero.body.books[c.prepared.expect.sha256] = 0; }],
    ["zotero-books", (r, c) => { c.zotero.body.at = null; }],
    ["zotero-books", (r, c) => { c.zotero.body.links = {}; }],                        // no link to the book
    ["zotero-books", (r, c) => { c.zotero.body.links[c.prepared.expect.sha256] = "another"; c.zotero.page.books[0].book = "another"; }],
    ["desktop-bridge", (r) => { r.desktop.reassigned = true; }],
    ["no-node", (r) => { r.nodeGlobals.require = "function"; }],
    ["pdfjs", (r) => { r.pdfjs.workerSrc = "https"; }],
    ["katex", (r) => { r.katex.renders = false; }],
    ["fonts-local", (r) => { r.fonts[0].status = "error"; }],                   // a damaged vendored KaTeX font (OFF-3)
    ["fonts-local", (r) => { r.fonts = r.fonts.filter((f) => f.family !== "Outfit"); }],
    ["fonts-local", (r) => { r.fonts.splice(3, 1); }],
    ["app-api", (r, c) => { c.appApi = { status: 404, body: { ok: false, error: "not found" } }; }],   // started without --app
    ["app-api", (r, c) => { c.appApi.body.version = "0.9.0"; }],
    ["app-api", (r, c) => { c.appApi = { status: null, body: null, error: "ECONNREFUSED" }; }],
    ["app-mode", (r) => { r.appMode.mode = "cover"; r.appMode.covered = true; }],
    ["app-mode", (r) => { r.appMode.coverHidden = false; }],
    ["persisted", (r) => { r.persisted = false; }],
    ["app-only", (r) => { r.appOnly[0].status = 200; r.appOnly[0].error = undefined; }],   // the guard is missing
    ["app-only", (r) => { r.appOnly[1].message = "something else"; }],
    ["app-only", (r) => { r.appOnly.pop(); }],
    ["app-only", (r, c) => { c.folders.afterRefusals.backupFiles = ["marginalia-backup-2026-11-11.json"]; }],
    ["app-only", (r, c) => { c.folders.afterRefusals.vaultNotes = 1; }],
    ["welcome-card", (r) => { r.welcomeBefore.disabled = false; }],
    ["welcome-card", (r) => { r.welcomeBefore.none = "Looking for a backup…"; }],
    ["welcome-card", (r) => { r.welcomeReady.label = "Import the newest backup"; }],          // the time never came
    ["welcome-card", (r) => { r.welcomeBefore.title = "Welcome"; }],
    ["welcome-import", (r) => { r.toasts = [r.toasts[0], r.toasts[2], r.toasts[1]]; }],         // the reminder before the restore
    ["welcome-import", (r) => { r.toasts = r.toasts.slice(1); }],
    ["welcome-import", (r) => { r.cardAfter = true; }],
    ["welcome-import", (r) => { r.library.folders = []; }],
    ["welcome-import", (r) => { r.library.books[0].folderId = null; }],
    ["welcome-import", (r) => { r.library.prompts.pop(); }],
    ["welcome-import", (r) => { r.library.obsidianFolder = ""; }],                            // the settings were not restored
    ["welcome-import", (r) => { r.clicked = false; }],
    ["undo-redo", (r) => { delete r.undo; }],                                                 // the packaged page has no M.undo (the step threw)
    ["undo-redo", (r) => { r.undo.steps = 0; }],
    ["undo-redo", (r) => { r.undo.undone = false; }],
    ["undo-redo", (r) => { r.undo.stored = false; }],                                         // the cache went back, the store did not
    ["undo-redo", (r) => { r.undo.redone = false; }],
    ["undo-redo", (r) => { r.undo.back = false; }],
    ["undo-redo", (r) => { r.undo.label = "New prompt"; }],
    ["pdf-restore", (r) => { r.library.books[0].hasBytes = false; }],
    ["pdf-restore", (r) => { r.restored.sha256 = "0".repeat(64); }],
    ["pdf-restore", (r) => { r.restored = { byteLength: 0, sha256: null }; }],
    ["sample-pdf", (r) => { r.fakeWorker = true; }],
    ["sample-pdf", (r) => { r.pdf = null; }],
    ["sample-pdf", (r) => { r.pdf.pages = 2; }],
    ["sample-pdf", (r) => { r.pdf.collectionId = "other"; }],
    ["cmaps-blocked", (r) => { r.cmap.failed = false; }],
    ["cmaps-blocked", (r, c) => { c.requests = c.requests.filter((q) => !q.blocked); }],
    ["download", (r, c) => { c.downloads[0].dialogDefaultPath = "/tmp/x.txt"; }],
    ["download", (r, c) => { c.downloads.push(c.downloads[0]); }],
    ["external-links", (r, c) => { c.externalOpens.pop(); }],
    ["external-links", (r, c) => { c.externalOpens.push({ url: "file:///etc/hosts", opened: false }); }],
    ["external-links", (r, c) => { c.externalOpens[0].opened = true; }],         // page script alone opened a tab (SEC-3)
    ["external-links", (r, c) => { c.externalOpens[4].opened = true; }],         // one key press opened two
    ["external-links", (r, c) => { c.externalOpens[3].opened = false; }],        // a real key press opened nothing
    ["external-links", (r) => { r.stillHere = "https://example.invalid"; }],
    ["requests-local", (r, c) => { c.requests.push({ url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/x.bcmap" }); }],
    ["requests-local", (r, c) => { c.requests.push({ url: "http://127.0.0.1:8765/" }); }],
    ["requests-local", (r, c) => { c.requests = c.requests.filter((q) => q.blocked); }],   // no local request at all
    ["hidden", (r, c) => { c.windowEverShown = true; }],
    ["hidden", (r, c) => { c.dockVisible = true; }],
    ["mock-keychain", (r, c) => { c.mockKeychain = false; }],
    ["permissions", (r, c) => { c.permissions.push({ permission: "media", granted: true }); }],
    ["permissions", (r, c) => { c.permissions = [{ permission: "persistent-storage", granted: true }]; }],   // nothing denied: nothing tested (SEC-5)
    ["permissions", (r, c) => { c.permissions.push({ permission: "persistent-storage", granted: false }); }],
    ["permissions", (r) => { r.permissionProbe.persist = false; }],
    ["permissions", (r) => { r.permissionProbe.query["persistent-storage"] = "denied"; }],
    ["permissions", (r) => { r.permissionProbe.query.camera = "granted"; }],
    ["permissions", (r) => { r.permissionProbe.query["clipboard-read"] = "denied"; }],
    ["permissions", (r) => { r.permissionProbe = null; }],
    ["context-menu", (r, c) => { c.contextMenus.canvas = null; }],                  // no menu for a right-click (F1)
    ["context-menu", (r, c) => { c.contextMenus.field.labels = ["Copy"]; }],
    ["cover-mode", (r, c) => { c.cover.raw.bridge = "object"; }],                      // the stand-in got the preload
    ["cover-mode", (r, c) => { c.cover.raw.mode = "browser"; }],
    ["cover-mode", (r, c) => { c.cover.raw.cover.hidden = true; }],
    ["cover-mode", (r, c) => { c.cover.raw.cover.open.href = "marginalia://open?hash=%23reader%2Fx"; }],
    ["cover-mode", (r, c) => { c.cover.raw.send = { ok: true, error: null }; }],         // an Obsidian send went through
    ["cover-mode", (r, c) => { c.cover.raw.toast = null; }],
    ["cover-mode", (r, c) => { c.cover.raw.backupStatus = "on"; }],                    // M.backup started under the cover
    ["cover-mode", (r, c) => { c.cover.requests.push({ url: ORIGIN + "/api/backup", method: "GET" }); }],   // the automatic backup asked
    ["cover-mode", (r, c) => { c.cover.requests.push({ url: ORIGIN + "/api/obsidian/note", method: "POST" }); }],
    ["cover-mode", (r, c) => { c.cover.requests = c.cover.requests.filter((q) => !q.url.endsWith("/api/app")); }],
    ["cover-mode", (r, c) => { c.cover.requests.push({ url: "https://fonts.googleapis.com/css2", method: "GET" }); }],
    ["cover-mode", (r, c) => { c.cover.navigations.push("marginalia:…"); }],           // the link was followed
    ["cover-mode", (r, c) => { c.cover.error = "the page did not load"; }],
    ["close-hides", (r, c) => { c.close.destroyed = true; c.close.pageAlive = false; }],
    ["close-hides", (r, c) => { c.close.serverRunning = false; }],
    ["close-hides", (r, c) => { c.close.visible = true; }],
    ["close-hides", (r, c) => { c.close.hid = false; c.close.hides = 0; }],   // prevented, never hidden: visible is false anyway (F2)
    ["close-hides", (r, c) => { c.close = null; }],
    ["tabs", (r, c) => { c.tabs = null; }],                                          // the probe did not run
    ["tabs", (r, c) => { c.tabs.error = "window.Marginalia.tabs is undefined"; }],
    ["tabs", (r, c) => { c.tabs.steps[0].answer = "blocked"; c.tabs.steps[0].done = false; c.tabs.steps[0].after = c.tabs.before; }],   // New Tab did nothing
    ["tabs", (r, c) => { c.tabs.steps[0].after.strip = false; }],                    // three tabs, no strip
    ["tabs", (r, c) => { c.tabs.steps[0].after.places[2] = "stats"; }],              // the new tab is not a library tab
    ["tabs", (r, c) => { const a = c.tabs.steps[0].after; a.places = ["reader:x", "library", "library"]; }],   // another tab changed its place
    ["tabs", (r, c) => { c.tabs.steps[2].after.active = 2; }],                       // Show Next Tab went back
    ["tabs", (r, c) => { c.tabs.steps[3].after.active = 1; }],                       // Show Previous Tab went on
    ["tabs", (r, c) => { const a = c.tabs.steps[4].after; a.places = a.places.slice().reverse(); }],   // Close Tab closed another tab
    ["tabs", (r, c) => { c.tabs.steps[4].after.active = 0; }],                       // … or showed the wrong neighbour
    ["tabs", (r, c) => { c.tabs.steps[7].answer = "done"; c.tabs.steps[7].done = true; }],   // the page says it closed its last tab
    ["tabs", (r, c) => { c.tabs.steps[7].answer = "blocked"; }],                     // one tab, and the page says "blocked": the window would stay
    ["tabs", (r, c) => { c.tabs.steps[11].after.places[1] = "library"; }],           // Reopen Closed Tab brought a new library tab, not the book's
    ["tabs", (r, c) => { c.tabs.steps[11].answer = "last"; c.tabs.steps[11].done = false; c.tabs.steps[11].after = c.tabs.steps[10].after; }],   // nothing came back
    ["tabs", (r, c) => { c.tabs.steps[12].after = c.tabs.steps[11].after; }],        // the last Close Tab closed nothing
    ["tabs", (r, c) => { c.tabs.unknown[0] = "(function () { return true; })()"; }],   // a script for a name that is no tab command of the menu
    ["tabs", (r, c) => { c.tabs.unknown = null; }],                                  // the probe did not ask
    ["link-handoff", (r, c) => { c.handoff.after.marker = "456"; }],                // the link reloaded the page (R5)
    ["link-handoff", (r, c) => { c.handoff.after.screen = "reader"; }],
    ["link-handoff", (r, c) => { c.handoff.hashes = ["#library", "#library"]; }],
    ["link-handoff", (r, c) => { c.handoff.applied = false; }],
    ["menu", (r, c) => { c.menuAccelerators = ACCEL.concat(["Command+F"]); }],
    ["page-errors", (r) => { r.errors.push("addPdfFromUrl: HTTP 404"); }]
  ];
  for (const [name, spoil] of cases) {
    const raw = goodRaw(), ctx = goodCtx();
    spoil(raw, ctx);
    const v = st.evaluate(raw, ctx);
    assert.equal(v.ok, false, name);
    assert.equal(v.checks[name].ok, false, name);
    const others = Object.entries(v.checks).filter(([k, c]) => k !== name && !c.ok).map(([k]) => k);
    assert.deepEqual(others, [], name + " also failed " + others.join(","));
  }
});

test("no report at all fails", () => {
  assert.equal(st.evaluate(null, goodCtx()).ok, false);
  assert.equal(st.evaluate({}, {}).ok, false);
});

const failing = (v) => Object.entries(v.checks).filter(([, c]) => !c.ok).map(([k]) => k);

// What a packaged run reports when "persistent-storage" is taken out of lib/policy.js ALLOWED_PERMISSIONS (the switch off,
// as the packaged self-test of such a build saw it: every persist() and permission query denied).
function switchedOff() {
  const raw = goodRaw(), ctx = goodCtx();
  ctx.persistentStorage = false;
  raw.persisted = false;
  raw.permissionProbe.persist = false;
  raw.permissionProbe.query["persistent-storage"] = "denied";
  ctx.permissions = [{ permission: "persistent-storage", granted: false }, { permission: "notifications", granted: false },
    { permission: "persistent-storage", granted: false }];
  return { raw, ctx };
}

test("the persistent-storage switch: the self-test expects the grant only while lib/policy.js allows it (repair REQ-D)", () => {
  // the switch off: no grant is right, and nothing fails (before the repair: persisted and permissions failed, so
  // `marginalia app` could not install a build with the switch off)
  const off = switchedOff();
  const v = st.evaluate(off.raw, off.ctx);
  assert.deepEqual(failing(v), []);
  assert.equal(v.ok, true);
  assert.deepEqual(v.checks.persisted.detail, { persisted: false, expected: false });
  // with the switch off, a grant is a fault of its own check
  for (const [name, spoil] of [
    ["persisted", (r) => { r.persisted = true; }],
    ["permissions", (r, c) => { c.permissions.push({ permission: "persistent-storage", granted: true }); }],
    ["permissions", (r) => { r.permissionProbe.persist = true; }],
    ["permissions", (r) => { r.permissionProbe.query["persistent-storage"] = "granted"; }],
    ["permissions", (r, c) => { c.permissions = c.permissions.filter((p) => p.permission !== "notifications"); }]
  ]) {
    const x = switchedOff();
    spoil(x.raw, x.ctx);
    assert.deepEqual(failing(st.evaluate(x.raw, x.ctx)), [name], name);
  }
  // the switch on (the app as shipped) still demands the grant, and so does a report that does not say (fail closed)
  const on = switchedOff();
  on.ctx.persistentStorage = true;
  assert.deepEqual(failing(st.evaluate(on.raw, on.ctx)), ["persisted", "permissions"]);
  const unsaid = switchedOff();
  delete unsaid.ctx.persistentStorage;
  assert.deepEqual(failing(st.evaluate(unsaid.raw, unsaid.ctx)), ["persisted", "permissions"]);
  const good = goodCtx();
  delete good.persistentStorage;
  assert.equal(st.evaluate(goodRaw(), good).ok, true);
});

// A window as the self-test has it: never shown, so isVisible() is false whether or not a close hid it.
function hiddenWindow(onClose) {
  const w = {
    destroyed: false, hides: 0,
    hide() { this.hides++; },
    isVisible() { return false; },
    isDestroyed() { return this.destroyed; },
    close() { onClose(this); },
    webContents: { executeJavaScript: async (src) => (src === "1 + 1" ? 2 : null) }
  };
  return w;
}

test("closeProbe tells a close that hid the window from one that was only prevented (repair F2)", async () => {
  const running = { serverRunning: () => true };
  const close = (ctx) => st.evaluate({}, { close: ctx }).checks["close-hides"];
  // main.js's close handler: the close prevented, the window hidden (hideWindow calls win.hide())
  const good = hiddenWindow((w) => w.hide());
  const r = await st.closeProbe(good, running);
  assert.deepEqual(r, { closeHides: true, destroyed: false, visible: false, hid: true, hides: 1, pageAlive: true, serverRunning: true });
  assert.equal(close(r).ok, true);
  assert.equal(good.hides, 1, "the real hide() ran");
  assert.equal(typeof Object.getOwnPropertyDescriptor(good, "hide").value, "function");
  assert.equal(good.hide.toString(), "hide() { this.hides++; }", "the window's own hide() is back");
  // the close prevented, but the window never hidden (a hideWindow that returns at once): isVisible() alone cannot tell
  const prevented = await st.closeProbe(hiddenWindow(() => { /* prevented, not hidden */ }), running);
  assert.equal(prevented.visible, false);
  assert.equal(prevented.hid, false);
  assert.equal(close(prevented).ok, false);
  // the close went through: the window is gone (the switch would have quit the app)
  const gone = await st.closeProbe(hiddenWindow((w) => { w.destroyed = true; }), running);
  assert.deepEqual([gone.destroyed, gone.pageAlive, close(gone).ok], [true, false, false]);
  // the server stopped meanwhile
  assert.equal(close(await st.closeProbe(hiddenWindow((w) => w.hide()), { serverRunning: () => false })).ok, false);
  // a hide() inherited from the window's class: the probe's own wrapper goes again, also when close() throws
  class Win { constructor() { this.hides = 0; this.webContents = { executeJavaScript: async () => 2 }; }
    hide() { this.hides++; } isVisible() { return false; } isDestroyed() { return false; } close() { throw new Error("no close"); } }
  const w = new Win();
  await assert.rejects(st.closeProbe(w, running), /no close/);
  assert.equal(Object.prototype.hasOwnProperty.call(w, "hide"), false);
  // settle runs between the close and the look (main.js waits 300 ms there)
  const order = [];
  const later = hiddenWindow((x) => { order.push("close"); setTimeout(() => { order.push("hide"); x.hide(); }, 5); });
  const r2 = await st.closeProbe(later, { serverRunning: () => true, settle: () => new Promise((res) => setTimeout(() => { order.push("settled"); res(); }, 20)) });
  assert.deepEqual(order, ["close", "hide", "settled"]);
  assert.equal(r2.hid, true);
});

test("tabsVerdict: each step of the tab probe must do exactly what its command says (DECISIONS D30)", () => {
  assert.deepEqual(st.tabsVerdict(goodTabs()), { ok: true, why: null });
  assert.deepEqual(goodTabs().steps.map((s) => s.id + ":" + s.answer), ["newTab:done", "newTab:done", "nextTab:done", "prevTab:done",
    "closeTab:done", "closeTab:done", "closeTab:done", "closeTab:last", "newTab:done", "prevTab:done", "closeTab:done", "reopenTab:done", "closeTab:done"]);
  // a page that had one tab before (the app run by hand, without the handed-over link), or more tabs
  for (const [places, active] of [[["reader:b"], 0], [["library", "reader:b", "stats"], 1], [["reader:b", "deck:d", "library", "stats"], 0]]) {
    assert.deepEqual(st.tabsVerdict(tabsReport(places, active)), { ok: true, why: null }, places.join(" "));
  }
  const bad = (spoil) => { const t = goodTabs(); spoil(t); const v = st.tabsVerdict(t); assert.equal(v.ok, false); assert.equal(typeof v.why, "string"); return v.why; };
  assert.match(bad((t) => { t.before = null; }), /before/);
  assert.match(bad((t) => { t.before.strip = false; }), /before/);
  assert.match(bad((t) => { t.before.places = ["library"]; }), /before/);
  assert.match(bad((t) => { t.steps.pop(); }), /the steps/);
  assert.match(bad((t) => { t.steps = []; }), /the steps/);
  assert.match(bad((t) => { t.steps[11].id = "newTab"; }), /the steps/);
  assert.match(bad((t) => { t.steps[1].after.active = 2; }), /step 2, newTab/);
  assert.match(bad((t) => { t.steps[2].after.active = 2; }), /step 3, nextTab/);
  assert.match(bad((t) => { t.steps[3].after.active = 1; }), /step 4, prevTab/);
  assert.match(bad((t) => { t.steps[5].after.strip = false; }), /step 6, closeTab: the page's answer/);
  assert.match(bad((t) => { t.steps[6].after = { tabs: 0, active: -1, strip: false, places: [] }; }), /step 7, closeTab: the page's answer/);
  assert.match(bad((t) => { t.steps[7].answer = "blocked"; }), /step 8, closeTab/);
  assert.match(bad((t) => { t.steps[9].answer = "none"; t.steps[9].done = false; }), /step 10, prevTab: the page answered "none"/);
  assert.match(bad((t) => { t.steps[11].after.places = ["library", "library"]; }), /step 12, reopenTab/);
  assert.match(bad((t) => { t.error = "boom"; }), /error: boom/);
  assert.match(bad((t) => { t.unknown = ["x", null, null]; }), /no tab command/);
  assert.match(bad((t) => { t.unknown = [null, null]; }), /no tab command/);
  assert.equal(st.tabsVerdict(null).ok, false);
  assert.equal(st.tabsVerdict(undefined).why, "no probe");
  // Show Next Tab and Show Previous Tab are told apart: a page that swaps them fails (with three tabs they differ)
  const swapped = tabsPage(["reader:b", "library"], 1), real = swapped.run;
  swapped.run = (id) => real(id === "nextTab" ? "prevTab" : id === "prevTab" ? "nextTab" : id);
  const report = { before: swapped.look(), steps: [], unknown: [null, null, null], error: null };
  const step = (id) => { const answer = swapped.run(id); report.steps.push({ id, answer, done: answer === "done", after: swapped.look() }); return answer === "done"; };
  st.TABS_STEPS.first.forEach(step);
  while (step("closeTab")) { /* down to one */ }
  st.TABS_STEPS.last.forEach(step);
  assert.match(st.tabsVerdict(report).why, /step 3, nextTab/);
});

test("tabsProbe: the commands in order, a settle after each, and an error is reported, not thrown", async () => {
  const page = tabsPage(["reader:b"], 0), order = [];
  const probe = await st.tabsProbe({ run: async (id) => { order.push(id); return page.run(id); }, look: async () => page.look(),
    settle: async () => { order.push("settle"); }, script: (name) => { order.push("script " + name); return null; } });
  assert.deepEqual(order.filter((x) => x !== "settle"), ["script tab1", "script lastTab", "script not-a-tab-command",
    "newTab", "newTab", "nextTab", "prevTab", "closeTab", "closeTab", "closeTab", "newTab", "prevTab", "closeTab", "reopenTab", "closeTab"]);
  assert.equal(order.filter((x) => x === "settle").length, 12);
  assert.deepEqual(probe.unknown, [null, null, null]);
  assert.deepEqual(st.tabsVerdict(probe), { ok: true, why: null });
  assert.deepEqual(page.places, ["library"], "the page is left with one tab, the library");
  // what the probe was given for a name that is no tab command goes into the report as it is
  const leaky = await st.tabsProbe({ run: async (id) => tabsPage(["reader:b"], 0).run(id), look: async () => tabsPage(["reader:b"], 0).look(), script: () => "alert(1)" });
  assert.deepEqual(leaky.unknown, ["alert(1)", "alert(1)", "alert(1)"]);
  assert.equal(st.tabsVerdict(leaky).ok, false);
  // a probe that cannot ask for the scripts fails the verdict
  const mute = tabsPage(["reader:b"], 0);
  assert.equal(st.tabsVerdict(await st.tabsProbe({ run: async (id) => mute.run(id), look: async () => mute.look() })).ok, false);
  // a page that never says "one tab left" does not hang the self-test: the closes stop, and the verdict fails
  const stuck = await st.tabsProbe({ run: async () => "done", look: async () => ({ tabs: 2, active: 0, strip: true, places: ["library", "library"] }), script: () => null });
  assert.equal(stuck.steps.filter((s) => s.id === "closeTab").length, st.TABS_CLOSE_MAX + 2);
  assert.equal(st.tabsVerdict(stuck).ok, false);
  // an answer that is no string (an older main.js gave true or false) is not "done"
  const old = tabsPage(["reader:b"], 0);
  const legacy = await st.tabsProbe({ run: async (id) => old.run(id) === "done", look: async () => old.look(), script: () => null });
  assert.equal(legacy.steps[0].done, false);
  assert.equal(st.tabsVerdict(legacy).ok, false);
  // a page without the web app
  const broken = await st.tabsProbe({ run: async () => "none", look: async () => { throw new Error("Cannot read properties of undefined (reading 'tabs')"); }, script: () => null });
  assert.match(broken.error, /reading 'tabs'/);
  assert.equal(st.tabsVerdict(broken).ok, false);
  // the look script reads the tabs, their places and the strip from the page
  const hidden = { classList: { contains: (c) => c === "is-hidden" } }, shown = { classList: { contains: () => false } };
  const sandbox = { window: { Marginalia: { tabs: { list: () => [{ screen: "library", collectionId: null, active: false }, { screen: "reader", collectionId: "b1", active: true }, { screen: "stats", active: false }] },
    app: { modal: () => false, current: () => ({ screen: "reader" }) }, review: { isActive: () => false } } },
    document: { getElementById: (id) => (id === "tabs" ? shown : id === "tabLock" ? null : hidden), querySelector: () => null } };
  const seen = JSON.parse(JSON.stringify(vm.runInNewContext(st.TABS_LOOK, sandbox)));
  assert.deepEqual([seen.tabs, seen.active, seen.strip, seen.places], [3, 1, true, ["library", "reader:b1", "stats"]]);
  assert.deepEqual(seen.blocked, { modal: false, review: false, settings: false, shortcuts: false, confirm: false, cover: false, lock: false, dialog: null, screen: "reader" });
  // what blocks the commands shows in the report
  sandbox.window.Marginalia.app.modal = () => true;
  sandbox.document.getElementById = (id) => (id === "tabs" ? hidden : id === "settings" ? shown : id === "tabLock" ? {} : hidden);
  sandbox.document.querySelector = () => ({ className: "dialog export-dialog" });
  const held = JSON.parse(JSON.stringify(vm.runInNewContext(st.TABS_LOOK, sandbox)));
  assert.equal(held.strip, false);
  assert.deepEqual(held.blocked, { modal: true, review: false, settings: true, shortcuts: false, confirm: false, cover: false, lock: true, dialog: "dialog export-dialog", screen: "reader" });
  const v = st.evaluate({}, { tabs: { before: held, steps: [], unknown: [null, null, null], error: null } }).checks.tabs;
  assert.equal(v.ok, false);
  assert.equal(v.detail.blocked.dialog, "dialog export-dialog", "the report says what blocked the commands");
});

test("windowsVerdict: each step of the story of two windows, and of the tab that moves out, must be as DECISIONS D31 says", () => {
  assert.deepEqual(st.windowsVerdict(goodWindows()), { ok: true, why: null });
  const bad = (spoil) => { const p = goodWindows(); spoil(p); const v = st.windowsVerdict(p); assert.equal(v.ok, false); assert.equal(typeof v.why, "string"); return v.why; };
  assert.match(bad((p) => { p.before.writer = false; p.before.locked = "window"; }), /the first window is not the writer at the start/);
  assert.match(bad((p) => { p.before.handover = false; }), /not the writer at the start/);            // the browser's rule, in the app
  assert.match(bad((p) => { p.before.app = false; }), /not the writer at the start/);
  assert.match(bad((p) => { p.before.w = "abc123"; }), /not the writer at the start/);
  assert.match(bad((p) => { p.before.locked = "othertab"; }), /not the writer at the start/);
  assert.match(bad((p) => { p.before.tabs = 0; }), /not the writer at the start/);
  assert.match(bad((p) => { p.opened = false; }), /the second window did not open/);
  assert.match(bad((p) => { p.second.writer = false; p.second.locked = "window"; }), /did not take the role as it started/);
  assert.match(bad((p) => { p.second.w = null; }), /did not take the role as it started/);
  assert.match(bad((p) => { p.firstAsReader = look(); }), /the first window did not give the role/);       // two writers at once
  assert.match(bad((p) => { p.firstAsReader.locked = "othertab"; }), /did not give the role/);            // the notice of the browser
  assert.match(bad((p) => { p.written = { ok: false, code: "locked" }; }), /the writer could not save/);
  assert.match(bad((p) => { p.written = { ok: true, id: "" }; }), /the writer could not save/);
  assert.match(bad((p) => { p.staleInFirst = true; }), /had the note before it read again/);
  assert.match(bad((p) => { p.staleInFirst = null; }), /had the note before it read again/);
  assert.match(bad((p) => { p.refused = { ok: true, id: "p_2" }; }), /a save in the reader was not refused/);
  assert.match(bad((p) => { p.refused = { ok: false, code: "store" }; }), /was not refused/);
  assert.match(bad((p) => { p.tookBack = false; }), /could not take the role back/);
  assert.match(bad((p) => { p.seenInFirst = false; }), /did not read the library again/);
  assert.match(bad((p) => { p.secondAsReader = look({ w: st.WINDOW_ID }); }), /the second window did not become a reader/);
  assert.match(bad((p) => { p.stored.stored = 1; }), /a reader did not store its own list of tabs/);
  assert.match(bad((p) => { p.stored.came = 0; }), /did not store its own list/);
  assert.match(bad((p) => { p.stored.writer = true; }), /did not store its own list/);
  assert.match(bad((p) => { p.stored = null; }), /did not store its own list/);
  assert.match(bad((p) => { p.removed = false; }), /could not be taken out again/);
  assert.match(bad((p) => { p.closed.destroyed = false; }), /did not close for good/);                    // it was only hidden
  assert.match(bad((p) => { p.closed.windows = 2; }), /did not close for good/);
  assert.match(bad((p) => { p.closed.firstAlive = false; }), /did not close for good/);
  assert.match(bad((p) => { p.closed = null; }), /did not close for good/);
  assert.match(bad((p) => { p.tookAgain = false; }), /could not write after the second closed/);
  assert.match(bad((p) => { p.after.keys.push("marginalia.tabs." + st.WINDOW_ID); }), /list of tabs was not forgotten/);
  assert.match(bad((p) => { p.after.keys = []; }), /was not forgotten/);
  assert.match(bad((p) => { p.after.writer = false; p.after.locked = "window"; }), /was not forgotten/);
  // the tab that moves out
  assert.match(bad((p) => { p.moved = null; }), /no tab was moved/);
  assert.match(bad((p) => { p.moved.asked.ok = false; }), /did not leave the first window/);
  assert.match(bad((p) => { p.moved.asked.opened = 1; }), /did not leave the first window/);
  assert.match(bad((p) => { p.moved.asked.after = 2; }), /did not leave the first window/);
  assert.match(bad((p) => { p.moved.asked = null; }), /did not leave the first window/);
  assert.match(bad((p) => { p.moved.opened = false; }), /asked for a window, and none opened/);
  assert.match(bad((p) => { p.moved.w = st.WINDOW_ID; }), /no id of its own/);
  assert.match(bad((p) => { p.moved.w = null; }), /no id of its own/);
  assert.match(bad((p) => { p.moved.w = "ABC"; }), /no id of its own/);
  assert.match(bad((p) => { p.moved.look.tabs = 2; }), /does not hold the tab/);
  assert.match(bad((p) => { p.moved.look.w = "other12345"; }), /does not hold the tab/);
  assert.match(bad((p) => { p.moved.look.keys = ["marginalia.tabs"]; }), /does not hold the tab/);
  assert.match(bad((p) => { p.moved.look.writer = false; p.moved.look.locked = "window"; }), /does not hold the tab/);
  assert.match(bad((p) => { p.moved.windows = 1; }), /new window did not close for good/);
  assert.match(bad((p) => { p.moved.destroyed = false; }), /new window did not close for good/);
  assert.match(bad((p) => { p.moved.left = 2; }), /new window did not close for good/);
  assert.match(bad((p) => { p.last = false; }), /after the tab's window closed/);
  assert.match(bad((p) => { p.end.tabs = 2; }), /is not as it was/);
  assert.match(bad((p) => { p.end.keys.push("marginalia.tabs." + W3); }), /is not as it was/);
  assert.match(bad((p) => { p.end.writer = false; p.end.locked = "window"; }), /is not as it was/);
  assert.match(bad((p) => { p.error = "boom"; }), /^error: boom/);
  assert.equal(st.windowsVerdict(null).why, "no probe");
  assert.equal(st.windowsVerdict(undefined).ok, false);
  // the answer shows what the page said, and the check carries the whole report
  assert.match(bad((p) => { p.written = { ok: false, code: "locked" }; }), /"code":"locked"/);
  const c = goodCtx();
  c.windows.tookBack = false;
  const v = st.evaluate(goodRaw(), c);
  assert.deepEqual(Object.entries(v.checks).filter(([, x]) => !x.ok).map(([k]) => k), ["windows"]);
  assert.match(v.checks.windows.detail.why, /could not take the role back/);
  assert.equal(v.checks.windows.detail.probe.tookBack, false);
  assert.equal(st.evaluate(goodRaw(), Object.assign(goodCtx(), { windows: null })).checks.windows.ok, false);
});

test("windowsProbe: the steps in order, each in its window; a window that does not open, a save that fails and an error end it early", async () => {
  const name = (s) => (s === st.WINDOW_LOOK ? "look" : s === st.WINDOW_TAKE ? "take" : s === st.WINDOW_WRITE ? "write" : s === st.WINDOW_STORE ? "store"
    : s === st.windowHas("p_note1") ? "has" : s === st.windowRemove("p_note1") ? "remove" : "other");
  const run = async (change) => {
    const g = goodWindows(), order = [];
    if (change) change(g);
    const firstAnswers = { look: [g.before, g.firstAsReader, g.after, g.end], take: [g.tookBack, g.tookAgain, g.last], write: [g.refused], has: [g.staleInFirst, g.seenInFirst], remove: [g.removed] };
    const secondAnswers = { look: [g.second, g.secondAsReader], write: [g.written], store: [g.stored] };
    const page = (who, answers) => async (script) => { const n = name(script); order.push(who + ":" + n); return answers[n].shift(); };
    const probe = await st.windowsProbe({ first: page("first", firstAnswers), second: page("second", secondAnswers),
      open: async () => { order.push("open"); return g.opened; }, close: async () => { order.push("close"); return g.closed; },
      move: async () => { order.push("move"); return g.moved; } });
    return { g, order, probe };
  };
  const all = await run();
  assert.deepEqual(all.order, ["first:look", "open", "second:look", "first:look", "second:write", "first:has", "first:write", "first:take", "first:has",
    "second:look", "second:store", "first:remove", "close", "first:take", "first:look", "move", "first:take", "first:look"]);
  assert.deepEqual(all.probe, all.g);
  assert.deepEqual(st.windowsVerdict(all.probe), { ok: true, why: null });
  // the second window does not open: nothing more is tried (there is no window to close)
  const shut = await run((g) => { g.opened = false; });
  assert.deepEqual(shut.order, ["first:look", "open"]);
  assert.equal(shut.probe.opened, false);
  assert.match(st.windowsVerdict(shut.probe).why, /did not open/);
  // the writer could not save: the steps that need the note are left out, and the window still closes
  const unsaved = await run((g) => { g.written = { ok: false, code: "locked" }; });
  assert.deepEqual(unsaved.order.slice(0, 5).concat(unsaved.order.slice(5, 7)), ["first:look", "open", "second:look", "first:look", "second:write", "close", "first:take"]);
  assert.equal(unsaved.probe.refused, null);
  assert.match(st.windowsVerdict(unsaved.probe).why, /the writer could not save/);
  // an error in a page is reported, not thrown
  const broken = await st.windowsProbe({ first: async () => { throw new Error("Cannot read properties of undefined (reading 'app')"); },
    second: async () => null, open: async () => true, close: async () => null });
  assert.match(broken.error, /reading 'app'/);
  assert.equal(st.windowsVerdict(broken).ok, false);
  // without move() (an older main.js) the story ends before the tab moves, and the verdict says so
  const g = goodWindows();
  const short = await st.windowsProbe({ first: async (s) => (name(s) === "look" ? g.before : name(s) === "has" ? false : name(s) === "write" ? g.refused : true),
    second: async (s) => (name(s) === "look" ? g.second : name(s) === "write" ? g.written : g.stored), open: async () => true, close: async () => g.closed });
  assert.equal(short.moved, null);
  assert.equal(st.windowsVerdict(short).ok, false);
});

test("the window scripts are valid expressions; a note's id goes in only when it is a plain id", () => {
  for (const src of [st.WINDOW_LOOK, st.WINDOW_TAKE, st.WINDOW_WRITE, st.WINDOW_STORE, st.WINDOW_MOVE, st.windowHas("p_note1"), st.windowRemove("p_note1")]) {
    assert.doesNotThrow(() => new vm.Script(src));
    assert.equal(/[\n\r]/.test(src), false);
    assert.ok(!/obsidian:\/\//.test(src));
  }
  assert.match(st.windowHas("p_00000000-0000-4000-8000-000000000001"), /cache\.prompt\("p_00000000-0000-4000-8000-000000000001"\)/);
  for (const evil of ["x\"); window.hacked = 1; (\"", "a b", "", null, undefined, 7, "x".repeat(81), "p_1\n"]) {
    assert.match(st.windowHas(evil), /cache\.prompt\(""\)/, String(evil));
    assert.match(st.windowRemove(evil), /removePrompt\(""\)/, String(evil));
    assert.ok(!/hacked/.test(st.windowHas(evil) + st.windowRemove(evil)));
  }
  assert.equal(st.WINDOW_ID, "selftest2");
  assert.match(st.WINDOW_ID, /^[a-z0-9]{6,16}$/, "an id lib/policy.js takes for a window");
  // the look reads what the page says of itself
  const store = { "marginalia.tabs": "{}", "marginalia.tabs.selftest2": "{}", "marginalia.settings": "{}" };
  const sandbox = { window: { Marginalia: { app: { boot: async () => true }, desktop: { isApp: () => true }, tabs: { windowId: () => "selftest2", list: () => [{}, {}] },
    store: { locked: () => ({ reason: "window" }), handover: () => true, writer: () => false } } },
    localStorage: { get length() { return Object.keys(store).length; }, key: (i) => Object.keys(store)[i] }, document: { title: "Griffiths — Marginalia" } };
  return vm.runInNewContext(st.WINDOW_LOOK, sandbox).then((seen) => {
    assert.deepEqual(JSON.parse(JSON.stringify(seen)), { app: true, w: "selftest2", handover: true, writer: false, locked: "window", tabs: 2,
      keys: ["marginalia.tabs", "marginalia.tabs.selftest2"], title: "Griffiths — Marginalia" });
  });
});

test("requestsLocal: only the app's own origin (and data:/blob:, and what the app cancelled) counts", () => {
  assert.deepEqual(st.requestsLocal([{ url: ORIGIN + "/a" }, { url: "data:x" }], ORIGIN), { ok: true, local: 1, blocked: 0, bad: [] });
  assert.deepEqual(st.requestsLocal([{ url: ORIGIN + "/a" }, { url: CMAP, blocked: true }], ORIGIN), { ok: true, local: 1, blocked: 1, bad: [] });
  const r = st.requestsLocal([{ url: ORIGIN + "/a" }, { url: "https://fonts.gstatic.com/s/x.woff2?q=1" }, { url: "file:///etc/hosts" }], ORIGIN);
  assert.equal(r.ok, false);
  assert.deepEqual(r.bad, ["https://fonts.gstatic.com/s/x.woff2", "file:…"]);
});

test("coverRequests sorts the stand-in's requests: its /api/ calls, POSTs and backup routes", () => {
  assert.deepEqual(st.coverRequests([{ url: ORIGIN + "/", method: "GET" }, { url: ORIGIN + "/api/app?x=1", method: "GET" },
    { url: ORIGIN + "/api/backup/pdfs", method: "GET" }, { url: ORIGIN + "/api/backup", method: "POST" }, { url: "not a url" }], ORIGIN),
  { api: ["GET /api/app", "GET /api/backup/pdfs", "POST /api/backup"], posts: 1, backup: 2 });
  assert.deepEqual(st.coverRequests([], ORIGIN), { api: [], posts: 0, backup: 0 });
});

test("the page scripts are valid expressions that carry their options; there is no other phase", () => {
  for (const src of [st.pageScript("start"), st.pageScript("import", { expect: { bookId: "x" } }), st.coverScript()]) {
    assert.doesNotThrow(() => new vm.Script(src));
    assert.match(src, /"samplePdf":"test\/sample\.pdf"/);
    assert.match(src, /"externalUrl":"https:\/\/example\.invalid\/marginalia-self-test"/);
    assert.ok(!/obsidian:\/\//.test(src), "the self-test never opens an obsidian:// link, not even a recorded one");
    assert.ok(!/\.cover__open[^;]*\.click\(\)/.test(src), "the cover's link is read, never clicked");
  }
  assert.match(st.pageScript("import", { expect: { bookId: "x" } }), /"expect":\{"bookId":"x"\}/);
  assert.match(st.pageScript("start"), /"appOnlyRoutes":\["\/api\/backup","\/api\/obsidian\/note"\]/);
  assert.throws(() => st.pageScript("other"), /no self-test phase/);
  assert.deepEqual(st.PHASES, ["start", "import"]);
});

test("the prepared backup: one book (the sample PDF, id its fingerprint) in one folder, two prompts, as Brave's cover writes it", () => {
  const p = st.preparedBackup({ now: NOW, sha256: SHA, byteLength: 27109, fingerprint: "45cff13ffd7238db6ed3320bf258d631", numPages: 3,
    folderId: "folder_1", promptIds: PROMPTS });
  assert.equal(p.name, "marginalia-backup-2026-11-11.json");
  assert.equal(p.pdfName, "Self-test sample [a6758b1c96ed].pdf");
  assert.match(p.pdfName, /^(?!\.).* \[([0-9a-f]{12})\]\.pdf$/, "serve.py's PDF_FILE_RE");
  const b = JSON.parse(p.text);
  assert.equal(p.text, JSON.stringify(b, null, 2), "written as M.exporter.toJSON writes it");
  assert.deepEqual(Object.keys(b), ["format", "version", "schedulerVersion", "exportedAt", "scope", "settings", "folders", "collections", "prompts", "attachments"]);
  assert.equal(b.format, "marginalia");
  assert.equal(b.version, 1);
  assert.equal(b.exportedAt, NOW);
  assert.equal(b.scope, "all");
  assert.deepEqual(b.settings, { obsidianFolder: "Self-test notes" });
  assert.deepEqual(b.folders.map((f) => [f.id, f.name, f.parentId, f.deletedAt]), [["folder_1", "Self-test folder", null, null]]);
  assert.equal(b.collections.length, 1);
  const book = b.collections[0];
  assert.deepEqual([book.id, book.kind, book.sha256, book.hashAlgo, book.byteLength, book.pageCount, book.folderId, book.deletedAt],
    ["45cff13ffd7238db6ed3320bf258d631", "book", SHA, "sha-256", 27109, 3, "folder_1", null]);
  assert.equal(book.chunkCount, undefined, "toJSON never writes the chunk fields");
  assert.deepEqual(b.prompts.map((q) => [q.id, q.collectionId, q.kind, q.deletedAt, q.cards.length]), PROMPTS.map((id) => [id, book.id, "qa", null, 1]));
  assert.ok(b.prompts.every((q) => /^Q\. .+\nA\. .+/.test(q.text)));
  assert.deepEqual(b.attachments, []);
  assert.deepEqual(p.expect, { day: "2026-11-11", exportedAt: NOW, label: "Import the newest backup (today, 09:12)", bookId: book.id,
    bookName: "Self-test sample", folderId: "folder_1", folderName: "Self-test folder", promptIds: PROMPTS, sha256: SHA, byteLength: 27109,
    numPages: 3, obsidianFolder: "Self-test notes" });
  assert.deepEqual(st.backupSummary(p.text), { exportedAt: NOW, collections: [book.id], prompts: PROMPTS });
  assert.equal(st.backupSummary("{}"), null);
  assert.equal(st.backupSummary("not json"), null);
  for (const bad of [{ sha256: "x" }, { fingerprint: "" }, { numPages: 0 }, { promptIds: ["p_1"] }, { folderId: "" }]) {
    assert.throws(() => st.preparedBackup(Object.assign({ now: NOW, sha256: SHA, byteLength: 1, fingerprint: "f", numPages: 1, folderId: "f1", promptIds: PROMPTS }, bad)), /preparedBackup needs/);
  }
});

test("localDay and hhmm read the local clock, as serve.py names a backup and the welcome card writes its time", () => {
  assert.equal(st.localDay(new Date(2026, 0, 2, 23, 59).getTime()), "2026-01-02");
  assert.equal(st.hhmm(new Date(2026, 0, 2, 7, 5).getTime()), "07:05");
  assert.equal(st.hhmm(new Date(2026, 0, 2, 19, 45).getTime()), "19:45");
});

test("fontSummary: every face loaded, all 20 KaTeX fonts and Outfit", () => {
  const ok = st.fontSummary(goodRaw().fonts);
  assert.deepEqual({ ok: ok.ok, faces: ok.faces, katex: ok.katex, outfit: ok.outfit, failed: ok.failed }, { ok: true, faces: 22, katex: 20, outfit: 2, failed: [] });
  assert.equal(st.fontSummary([]).ok, false);
  assert.equal(st.fontSummary(null).ok, false);
});
