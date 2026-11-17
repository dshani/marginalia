"use strict";
// test/desktop-dom.test.js — FEATURES E2.2 with the real boot (BUILD-NOTES "Desktop app (binding)", part 2): the 28 real
// modules in the fake window of tools/smoke.js (compiled without its final main() call, as in test/app.test.js), given a
// localStorage, crypto and a stand-in for tools/serve.py with the E2.1 routes in place of fetch.
// - Cover mode (a browser page whose server is the desktop app's: GET /api/app answers {ok: true, app: true}): the cover
//   shows and nothing else (no route, no daily backup, no request but the app check), keys and focus stay in it, every
//   Obsidian send is refused, "Back up this browser's library" with and without a backup of today (the confirm, both
//   POSTs with X-Marginalia-Client: browser-move, the progress, the result line, an error shown in the cover and not
//   tried again), a reader route following the marginalia:// link once.
// - Normal mode when GET /api/app answers 404, fails or never answers (3 s; shortened here), the check answering before
//   the daily backup asks anything, and the claude.ai artifact unchanged (no check, no cover).
// - The desktop app's welcome card: shown and hidden, "Import the newest backup (<date and time>)" with the real
//   M.exporter.importJSON, the real PDF restore (M.backup + M.library.attachPdf) and its toast, the API key reminder, an
//   error that keeps the card, "Import a backup file…", "Start with an empty library"; persistent storage asked once.
// Nothing reaches a network, a server, a vault or a folder; no obsidian:// or marginalia:// link opens (both openers are
// recorders). Run from the app folder: node --test
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const JS = path.join(__dirname, "..", "js");
const TODAY = "2026-11-11";
const T0 = new Date(2026, 10, 11, 14, 5, 0).getTime();          // 14:05 local time on TODAY
const AT_0912 = new Date(2026, 10, 11, 9, 12, 0).getTime();
const TOMORROW = "2026-11-12";
const AT_TOMORROW = new Date(2026, 10, 12, 8, 0, 0).getTime();   // a backup named while the Mac's clock was a day ahead
const MOVED_KEY = "marginalia.movedToApp";
const NAME = (day) => "marginalia-backup-" + day + ".json";
const COVERED = "Marginalia is now an app — open it to send to Obsidian.";
const KEY_REMINDER = "Paste your Anthropic API key again in Settings → LaTeX from snips (backups never contain it).";
const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOf = (b) => crypto.createHash("sha256").update(b).digest("hex");
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
async function until(pred, what) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (pred()) return; await wait(3); }
  throw new Error("timed out waiting for " + (what || pred.toString()));
}

const PDF = Buffer.from("%PDF-1.7\n% Griffiths\n" + "x".repeat(300) + "\n%%EOF\n");
const SHA = hashOf(PDF);
function bookRec(id, extra) {
  return Object.assign({ id, kind: "book", name: "Griffiths", title: "Introduction to Quantum Mechanics", fileName: "griffiths.pdf",
    sha256: SHA, hashAlgo: "sha-256", pageCount: 3, pageLabels: null, sections: [], lastPosition: { pageIndex: 0, fraction: 0, zoom: "fit" },
    addedAt: T0 - 86400000, lastOpenedAt: T0 - 86400000, updatedAt: T0 - 86400000, deletedAt: null, v: 1 }, extra || {});
}
const DECK = { id: "deck_1", kind: "deck", name: "Thermo", description: "", sections: [], addedAt: T0, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 };
function promptRec(id, collectionId, extra) {
  return Object.assign({ id, collectionId, kind: "qa", text: "Q. " + id + "?\nA. yes", tags: [], flagged: false, anchor: null,
    context: { docName: "Griffiths", sectionLabel: null, pageIndex: 0, pageLabel: "1" },
    cards: [{ i: 0, createdAt: T0, lastReviewedAt: null, intervalMs: 432000000, dueAt: T0 + 432000000, log: [] }],
    dueAt: T0 + 432000000, createdAt: T0, contentUpdatedAt: T0, updatedAt: T0, deletedAt: null, v: 1 }, extra || {});
}
// A JSON backup as Brave's cover writes it: one book (test PDF) in one folder, two prompts
const FOLDER = { id: "folder_physics", name: "Physics", parentId: null, createdAt: T0 - 5000, updatedAt: T0 - 5000, deletedAt: null };
function backupText(at) {
  return JSON.stringify({ format: "marginalia", version: 1, schedulerVersion: 1, exportedAt: at, scope: "all", settings: { obsidianFolder: "Notes/Physics" },
    folders: [FOLDER], collections: [bookRec("bk1", { hasBytes: true, byteLength: PDF.length, folderId: FOLDER.id, folderUpdatedAt: T0 - 4000 })],
    prompts: [promptRec("p_1", "bk1"), promptRec("p_2", "bk1")], attachments: [] }, null, 2);
}

function res(status, json, headers) {
  const h = headers || {};
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => { const key = Object.keys(h).find((x) => x.toLowerCase() === String(k).toLowerCase()); return key ? h[key] : null; } },
    json: () => Promise.resolve(typeof json === "string" ? JSON.parse(json) : json),
    text: () => Promise.resolve(typeof json === "string" ? json : JSON.stringify(json)),
    arrayBuffer: () => Promise.resolve(Uint8Array.from(Buffer.isBuffer(json) ? json : Buffer.from(String(json))).buffer)
  };
}

// tools/serve.py with FEATURES E2.1, in memory: srv.app ("app" | "error" | "hang" | null → 404), the backup folder
// (files, latest, pdfs with their bytes) and the Obsidian routes; srv.refuse(method, url) → {status, body} | null.
// srv.texts (name → the file's text), when given, makes GET /api/backup/latest send the first listed file, the newest by
// name, as tools/serve.py does (else srv.latest, the file last written or set).
function makeServer(over) {
  const srv = Object.assign({ app: null, appDelay: 0, appAnswered: false, today: TODAY, dir: "~/Documents/Marginalia Backups", files: [],
    latest: null, texts: null, pdfs: [], refuse: null, requests: [] }, over || {});
  srv.fetch = function (url, init) {
    init = init || {};
    const method = String(init.method || "GET").toUpperCase(), u = String(url), headers = Object.assign({}, init.headers);
    srv.requests.push({ method, url: u, headers, init, afterApp: srv.appAnswered });
    const refused = srv.refuse ? srv.refuse(method, u) : null;
    if (refused) return Promise.resolve(res(refused.status, refused.body));
    if (u === "/api/app") {
      if (srv.app === "error") { srv.appAnswered = true; return Promise.reject(new TypeError("Failed to fetch")); }
      if (srv.app === "hang") return new Promise(() => {});
      const answer = () => { srv.appAnswered = true; return srv.app === "app" ? res(200, { ok: true, app: true, version: "0.2.0" }) : res(404, { ok: false, error: "not found" }); };
      return srv.appDelay ? wait(srv.appDelay).then(answer) : Promise.resolve().then(answer);
    }
    if (u === "/api/backup" && method === "GET") return Promise.resolve(res(200, { ok: true, dir: srv.dir, today: srv.today, files: srv.files.slice() }));
    if (u === "/api/backup" && method === "POST") {
      const body = JSON.parse(init.body), name = NAME(srv.today), bytes = Buffer.byteLength(init.body);
      srv.files = srv.files.filter((f) => f.name !== name).concat([{ name, date: srv.today, bytes }]).sort((a, b) => (a.name < b.name ? 1 : -1));
      srv.latest = { name, text: JSON.stringify(body.backup) };
      if (srv.texts) srv.texts[name] = JSON.stringify(body.backup);
      return Promise.resolve(res(200, { ok: true, file: name, bytes, skipped: false, pruned: [] }));
    }
    if (u === "/api/backup/latest" && srv.texts) {
      const first = srv.files[0];
      if (!first) return Promise.resolve(res(404, { ok: false, error: "no_backup" }));
      return Promise.resolve(res(200, srv.texts[first.name], { "X-Marginalia-Backup-Name": first.name }));
    }
    if (u === "/api/backup/latest") {
      if (!srv.latest) return Promise.resolve(res(404, { ok: false, error: "no_backup" }));
      return Promise.resolve(res(200, srv.latest.text, { "X-Marginalia-Backup-Name": srv.latest.name }));
    }
    if (u === "/api/backup/pdfs") return Promise.resolve(res(200, { ok: true, dir: srv.dir, files: srv.pdfs.map((p) => ({ sha12: p.sha256.slice(0, 12), name: p.name, bytes: p.body.length })) }));
    if (u === "/api/backup/pdf" && method === "POST") {
      const sha = String(headers["X-Marginalia-Sha256"]), body = Buffer.from(init.body);
      const name = decodeURIComponent(String(headers["X-Marginalia-Name"])) + " [" + sha.slice(0, 12) + "].pdf";
      srv.pdfs.push({ sha256: sha, name, body });
      return Promise.resolve(res(200, { ok: true, file: name, bytes: body.length, skipped: false }));
    }
    const m = /^\/api\/backup\/pdf\/([0-9a-f]{64})$/.exec(u);
    if (m) {
      const p = srv.pdfs.find((x) => x.sha256 === m[1]);
      return Promise.resolve(p ? res(200, p.body, { "Content-Length": String(p.body.length) }) : res(404, { ok: false, error: "no saved PDF has that SHA-256" }));
    }
    if (u === "/api/obsidian/vaults") return Promise.resolve(res(200, { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }], replaceOnly: true }));
    return Promise.resolve(res(404, { ok: false, error: "not found" }));
  };
  srv.list = () => srv.requests.map((r) => r.method + " " + r.url);
  return srv;
}

function loadSmokeHarness() {
  const file = path.join(__dirname, "..", "tools", "smoke.js");
  const src = fs.readFileSync(file, "utf8").replace(/^#!.*\n/, "");
  assert.match(src, /\nmain\(\);\s*$/, "tools/smoke.js no longer ends with main(); update loadSmokeHarness()");
  const body = src.replace(/\nmain\(\);\s*$/, "\nreturn { makeWindow: makeWindow, ORDER: ORDER };\n");
  const factory = vm.runInThisContext("(function (require, process, __dirname, __filename) {" + body + "\n})", { filename: file });
  return factory(require, process, path.dirname(file), file);
}

function makeStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null, get length() { return map.size; } };
}

// One page. opts: {app (the desktop app's preload), hash, hostname, artifact, server, storage (localStorage: share one to
// load the same browser again), storeMode ("idb" unless given), navStorage, checkMs, seed(R) (before boot)}
function load(opts) {
  opts = opts || {};
  const H = loadSmokeHarness(), W = H.makeWindow(), logs = [], links = [], opened = [], toasts = [], reads = [];
  const server = opts.server || makeServer();
  W.setTimeout = (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a));
  W.setInterval = (fn, ms, ...a) => unref(setInterval(fn, ms, ...a));
  W.requestAnimationFrame = (fn) => W.setTimeout(() => fn(Date.now()), 0);
  W.requestIdleCallback = (fn) => W.setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: false }), 0);
  W.console = { log() {}, info() {}, debug() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  const host = opts.hostname || "127.0.0.1";
  Object.assign(W.location, { hostname: host, host: host + ":8765", origin: "http://" + host + ":8765", href: "http://" + host + ":8765/" + (opts.hash || ""), hash: opts.hash || "" });
  W.localStorage = opts.storage || makeStorage();
  W.crypto = crypto.webcrypto;
  W.fetch = (url, init) => server.fetch(url, init);
  if (opts.navStorage) W.navigator.storage = opts.navStorage;
  if (opts.app) W.marginaliaDesktop = Object.freeze({ app: true, version: "0.2.0", platform: "darwin" });
  if (opts.artifact) W.document.head.childNodes[0].setAttribute("content", "artifact");
  const ctx = vm.createContext(W);
  for (const name of H.ORDER) vm.runInContext(fs.readFileSync(path.join(JS, name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const R = W.Marginalia;
  R.store.mode = () => opts.storeMode || "idb";           // the smoke window has no IndexedDB; M.backup refuses the memory store
  R.backup._setTimers({ setInterval: () => 1, clearInterval: () => {} });
  R.desktop._setNow(() => T0);
  R.desktop._setOpener((uri) => { links.push(uri); return true; });
  R.obsidian._setOpener((uri) => { opened.push(uri); return true; });
  if (opts.checkMs) R.desktop._setCheckMs(opts.checkMs);
  const realToast = R.app.toast;
  R.app.toast = function (o) { toasts.push(typeof o === "string" ? { text: o } : o); return realToast.apply(this, arguments); };
  const realOpen = R.reader.open;
  R.reader.open = function (cid, o) { reads.push(cid); return realOpen ? Promise.resolve() : Promise.resolve(); };
  const page = { W, R, doc: W.document, logs, links, opened, toasts, reads, server, texts: () => toasts.map((t) => t.text) };
  page.boot = async function () {
    if (opts.seed) { await R.store.open(); await opts.seed(R); }
    const keep = setInterval(() => {}, 20);               // the page's own timers are unref'd: keep the test alive
    try { return await R.app.boot(); } finally { clearInterval(keep); }
  };
  return page;
}

// the fake DOM: className may be set directly (library.js, app.js) or through classList (desktop.js)
function classes(el) { return String((el && el.className) || "").split(/\s+/).filter(Boolean); }
function walk(rootEl, pred, out) {
  out = out || [];
  (rootEl && rootEl.childNodes || []).forEach((c) => { if (c.nodeType === 1) { if (pred(c)) out.push(c); walk(c, pred, out); } });
  return out;
}
const byClass = (rootEl, cls) => walk(rootEl, (el) => classes(el).indexOf(cls) >= 0)[0] || null;
const hidden = (el) => classes(el).indexOf("is-hidden") >= 0;
function textOf(el) {
  if (!el) return "";
  if (el.nodeType === 3) return String(el.textContent);
  const kids = (el.childNodes || []).map(textOf).join("");
  return String(el.textContent || "") + kids;
}
function keydown(key, target, mods) {
  const e = Object.assign({ type: "keydown", key, code: "", keyCode: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    repeat: false, isComposing: false, defaultPrevented: false, target, stopped: false }, mods || {});
  e.preventDefault = () => { e.defaultPrevented = true; };
  e.stopPropagation = () => { e.stopped = true; };
  return e;
}
async function seedLibrary(R) {
  await R.store.docs.saveDocument(bookRec("bk1"), new Uint8Array(PDF));
  await R.store.collections.put(DECK);
  await R.store.prompts.put(promptRec("p_1", "bk1"));
  await R.store.prompts.put(promptRec("p_2", "deck_1"));
}
// M.app's confirm in #confirm, while it is open (null parts otherwise); the fake DOM's textContent = "" leaves the old
// dialog's nodes in place, so the newest one is the last
function confirmButtons(doc) {
  const host = doc.getElementById("confirm"), open = !hidden(host);
  const last = (cls) => { const all = walk(host, (el) => classes(el).indexOf(cls) >= 0); return open && all.length ? all[all.length - 1] : null; };
  return { host, ok: last("confirm__ok"), cancel: last("confirm__cancel"), title: last("confirm__title"), body: last("confirm__body") };
}

/* ------------------------------------------------------------------ cover mode */

describe("cover mode: a browser page the desktop app replaced (FEATURES E2.2c)", () => {
  test("the cover shows and nothing else: no route, no daily backup, no request but the app check", async () => {
    const P = load({ server: makeServer({ app: "app" }), seed: seedLibrary });
    assert.equal(await P.boot(), true, P.logs.join("\n"));
    const { R, doc } = P;
    assert.deepEqual([R.desktop.mode(), R.desktop.covered()], ["cover", true]);
    const cover = doc.getElementById("cover");
    assert.equal(hidden(cover), false, "#cover shows");
    const panel = byClass(cover, "cover__panel");
    assert.deepEqual([panel.getAttribute("role"), panel.getAttribute("aria-modal"), panel.getAttribute("aria-labelledby")], ["alertdialog", "true", "coverTitle"]);
    assert.equal(doc.getElementById("coverTitle").textContent, "Marginalia is now an app");
    assert.equal(textOf(doc.getElementById("coverBody")), "Your library in this browser stays here, unchanged. To move it into the app:" +
      "1. Click Back up this browser's library.2. In the app, click Import the newest backup.");
    const link = byClass(cover, "cover__open"), backup = byClass(cover, "cover__backup");
    assert.deepEqual([link.tagName, link.textContent, link.getAttribute("href")], ["A", "Open the app", "marginalia://open?hash=%23library"]);
    assert.deepEqual([backup.tagName, backup.textContent], ["BUTTON", "Back up this browser's library"]);
    assert.equal(hidden(byClass(cover, "cover__forward")), true, "not a reader route: nothing forwards");
    assert.deepEqual(P.links, []);
    assert.ok(doc.activeElement === link, "focus starts on Open the app");
    assert.deepEqual(P.server.list(), ["GET /api/app"], "no GET /api/backup: the daily backup never runs here");
    assert.equal(R.backup.state().status, "checking", "M.backup was never started");
    assert.equal(doc.getElementById("library").childNodes.length, 0, "the library was not rendered");
    assert.equal(R.app.current().screen, null, "nothing routed");
    assert.equal(await R.app.route("library", {}), false, "route() does nothing under the cover");
    for (const id of ["banner", "library", "deck", "reader", "review", "settings", "shortcuts", "fileInput"]) {
      assert.equal(doc.getElementById(id).hasAttribute("inert"), true, "#" + id + " is inert");
    }
    for (const id of ["cover", "confirm", "toasts"]) assert.equal(doc.getElementById(id).hasAttribute("inert"), false, "#" + id + " is not inert");
    await R.backup.start();                                 // even when asked
    assert.deepEqual(P.server.list(), ["GET /api/app"]);
  });

  test("keys reach nothing underneath, Escape does nothing, Tab cycles inside, focus that lands behind comes back", async () => {
    const P = load({ server: makeServer({ app: "app" }), seed: seedLibrary });
    await P.boot();
    const { W, doc } = P, cover = doc.getElementById("cover"), lib = doc.getElementById("library");
    const link = byClass(cover, "cover__open"), backup = byClass(cover, "cover__backup");
    const n = keydown("n", lib);
    W.dispatchEvent(n);
    assert.deepEqual([n.stopped, n.defaultPrevented], [true, true], "a key aimed at the page is swallowed");
    assert.ok(doc.activeElement === link, "and focus comes back");
    const comma = keydown(",", link);                       // the settings key, typed with focus in the cover
    W.dispatchEvent(comma);
    assert.deepEqual([comma.stopped, comma.defaultPrevented], [true, false], "never routed to M.app, nothing prevented");
    const esc = keydown("Escape", link);
    W.dispatchEvent(esc);
    assert.equal(esc.defaultPrevented, true);
    assert.equal(hidden(cover), false, "Escape does not close it");
    const enter = keydown("Enter", backup);
    W.dispatchEvent(enter);
    assert.deepEqual([enter.stopped, enter.defaultPrevented], [true, false], "Enter on the button keeps its native click");
    const reload = keydown("r", lib, { metaKey: true });
    W.dispatchEvent(reload);
    assert.equal(reload.defaultPrevented, false, "browser shortcuts (Cmd+R) still work");
    const open = keydown("o", lib, { metaKey: true });      // Mod+O would add a PDF: it never reaches M.app
    W.dispatchEvent(open);
    assert.equal(open.stopped, true);
    link.getClientRects = () => [{}];                       // the fake DOM lays nothing out: these two are "visible"
    backup.getClientRects = () => [{}];
    doc.activeElement = link;
    const tab = keydown("Tab", link);
    W.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.ok(doc.activeElement === backup, "Tab goes to the next control");
    W.dispatchEvent(keydown("Tab", backup));
    assert.ok(doc.activeElement === link, "Tab cycles inside the cover");
    W.dispatchEvent(keydown("Tab", link, { shiftKey: true }));
    assert.ok(doc.activeElement === backup, "Shift+Tab too");
    const paste = { type: "paste", target: lib, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    W.dispatchEvent(paste);
    assert.deepEqual([paste.stopped, paste.defaultPrevented], [true, true], "a paste never reaches the page");
    const drop = { type: "drop", target: lib, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    W.dispatchEvent(drop);
    assert.equal(drop.stopped, true, "a dropped PDF is never added");
    doc.dispatchEvent({ type: "focusin", target: lib });
    assert.ok(doc.activeElement === link, "focus that lands behind the cover comes back");
  });

  test("the \"open in another tab\" notice over the cover keeps its own keys and focus; after a backup focus is on its button", async () => {
    const P = load({ server: makeServer({ app: "app" }), seed: seedLibrary });
    await P.boot();
    const { W, R, doc } = P, cover = doc.getElementById("cover"), button = byClass(cover, "cover__backup");
    const lockTab = doc.createElement("div");
    lockTab.id = "tabLockStandIn";
    doc.getElementById("app").appendChild(lockTab);
    const realLock = R.app.tabLock;
    R.app.tabLock = () => ({ texts: [], by: "tab_b" });       // M.app's notice is up (js/app.js showTabLock)
    const enter = keydown("Enter", lockTab);
    W.dispatchEvent(enter);
    assert.deepEqual([enter.stopped, enter.defaultPrevented], [false, false], "the cover leaves the notice's keys alone");
    doc.activeElement = lockTab;
    doc.dispatchEvent({ type: "focusin", target: lockTab });
    assert.ok(doc.activeElement === lockTab, "and its focus");
    R.app.tabLock = realLock;
    // Chromium drops the focus of a button that becomes disabled: once the backup ends, focus is on the button again
    button.click();
    doc.activeElement = doc.body;
    await until(() => !button.disabled, "the run ends");
    assert.ok(doc.activeElement === button, "focus back on Back up this browser's library");
  });

  test("every Obsidian send is refused with the toast: no request, no link", async () => {
    const P = load({ server: makeServer({ app: "app" }), seed: seedLibrary });
    await P.boot();
    const { R } = P;
    const one = plain(await R.obsidian.send("p_1", { fromGesture: true }));
    assert.deepEqual([one.ok, one.error], [false, COVERED]);
    const all = plain(await R.obsidian.sendAll("deck_1", { fromGesture: true }));
    assert.deepEqual([all.ok, all.error], [false, COVERED]);
    assert.equal(plain(await R.obsidian.planAll("deck_1")).covered, true);
    const shown = walk(P.doc.getElementById("toasts"), (el) => classes(el).indexOf("toast__text") >= 0).map((el) => el.textContent);
    assert.ok(shown.includes(COVERED), "the toast shows above the cover: " + shown.join(" | "));
    assert.deepEqual(P.server.list(), ["GET /api/app"], "no request to Obsidian's routes");
    assert.deepEqual(P.opened, [], "no obsidian:// link");
    assert.equal(R.cache.prompt("p_1").obsidianPendingFile, undefined);
  });

  test("Back up this browser's library, no backup of today: the JSON backup and the PDFs with browser-move, then the result", async () => {
    const P = load({ server: makeServer({ app: "app", files: [{ name: NAME("2026-11-10"), date: "2026-11-10", bytes: 99 }] }), seed: seedLibrary });
    await P.boot();
    const { doc, server } = P, cover = doc.getElementById("cover");
    const status = byClass(cover, "cover__status"), statuses = [];
    let shown = status.textContent;
    Object.defineProperty(status, "textContent", { get: () => shown, set: (v) => { shown = String(v); statuses.push(shown); } });
    byClass(cover, "cover__backup").click();
    assert.equal(byClass(cover, "cover__backup").disabled, true, "one backup at a time");
    await until(() => /^Saved this browser's library/.test(status.textContent), "the result line");
    assert.ok(confirmButtons(doc).ok === null, "no backup of today: no confirm");
    assert.equal(status.textContent, "Saved this browser's library: 1 book, 1 deck, 2 prompts, 1 PDF (14:05). Now open the app and click Import the newest backup.");
    assert.equal(byClass(cover, "cover__error").textContent, "");
    assert.equal(byClass(cover, "cover__note").textContent, "");
    assert.deepEqual(server.list(), ["GET /api/app", "GET /api/backup", "GET /api/backup/pdfs", "POST /api/backup", "GET /api/backup/pdfs", "POST /api/backup/pdf"]);
    const posts = server.requests.filter((r) => r.method === "POST");
    assert.deepEqual(posts[0].headers, { "Content-Type": "application/json", "X-Marginalia": "1", "X-Marginalia-Client": "browser-move" });
    assert.equal(posts[1].headers["X-Marginalia-Client"], "browser-move");
    assert.equal(posts[1].headers["X-Marginalia-Sha256"], SHA);
    const sent = JSON.parse(posts[0].init.body);
    assert.equal(sent.mode, "manual");
    assert.deepEqual(sent.backup.collections.map((c) => c.id).sort(), ["bk1", "deck_1"]);
    assert.deepEqual(statuses.filter(Boolean), ["Checking the backup folder…", "Saving this browser's library…", "Saving PDFs…", "Saving PDFs… 1 of 1",
      status.textContent], "the progress");
    assert.equal(byClass(cover, "cover__backup").disabled, false);
    assert.equal(server.pdfs.length, 1);
  });

  test("with a backup of today: \"Replace today's backup?\" first (made at HH:MM); Cancel writes nothing, Replace it backs up", async () => {
    const srv = makeServer({ app: "app", files: [{ name: NAME(TODAY), date: TODAY, bytes: 1234 }], latest: { name: NAME(TODAY), text: backupText(AT_0912) } });
    const P = load({ server: srv, seed: seedLibrary });
    await P.boot();
    const { doc } = P, cover = doc.getElementById("cover"), button = byClass(cover, "cover__backup");
    button.click();
    await until(() => confirmButtons(doc).ok, "the confirm");
    let c = confirmButtons(doc);
    assert.equal(hidden(c.host), false);
    assert.equal(c.title.textContent, "Replace today's backup?");
    assert.equal(textOf(c.body), "Today's backup (made at 09:12) is replaced with this browser's library. The app's own library does not change.");
    assert.equal(textOf(c.ok), "Replace it");
    // the confirm keeps its keys while the cover shows
    const tabInConfirm = keydown("Tab", c.ok);
    P.W.dispatchEvent(tabInConfirm);
    assert.equal(tabInConfirm.stopped, false, "the cover leaves the confirm's keys to M.app");
    c.cancel.click();
    await until(() => !button.disabled, "the run ends");
    assert.equal(srv.requests.filter((r) => r.method === "POST").length, 0, "Cancel writes nothing");
    assert.equal(byClass(cover, "cover__status").textContent, "");
    button.click();
    await until(() => confirmButtons(doc).ok, "the confirm again");
    c = confirmButtons(doc);
    c.ok.click();
    await until(() => /^Saved this browser's library/.test(byClass(cover, "cover__status").textContent), "the result line");
    const posts = srv.requests.filter((r) => r.method === "POST");
    assert.deepEqual(posts.map((r) => r.url + " " + r.headers["X-Marginalia-Client"]), ["/api/backup browser-move", "/api/backup/pdf browser-move"]);
    assert.equal(JSON.parse(posts[0].init.body).mode, "manual", "manual: today's file is replaced");
  });

  test("an error is shown in the cover with the server's words, and nothing is tried again by itself", async () => {
    const srv = makeServer({ app: "app", refuse: (m, u) => (m === "POST" && u === "/api/backup" ? { status: 500, body: { ok: false, error: "[Errno 28] No space left on device" } } : null) });
    const P = load({ server: srv, seed: seedLibrary });
    await P.boot();
    const cover = P.doc.getElementById("cover"), button = byClass(cover, "cover__backup");
    button.click();
    await until(() => byClass(cover, "cover__error").textContent, "the error");
    assert.equal(byClass(cover, "cover__error").textContent, "Could not back up this browser's library — [Errno 28] No space left on device");
    assert.equal(byClass(cover, "cover__status").textContent, "");
    await wait(30);
    assert.equal(srv.requests.filter((r) => r.method === "POST").length, 1, "one try, no loop");
    assert.equal(button.disabled, false, "the person may try again");
    // a PDF the server refuses: the result line, then the error under it
    const srv2 = makeServer({ app: "app", refuse: (m, u) => (u === "/api/backup/pdf" ? { status: 409, body: { ok: false, error: "a folder holds that name" } } : null) });
    const P2 = load({ server: srv2, seed: seedLibrary });
    await P2.boot();
    const cover2 = P2.doc.getElementById("cover");
    byClass(cover2, "cover__backup").click();
    await until(() => byClass(cover2, "cover__error").textContent, "the PDF error");
    assert.equal(byClass(cover2, "cover__status").textContent, "Saved this browser's library: 1 book, 1 deck, 2 prompts, 0 PDFs (14:05). Now open the app and click Import the newest backup.");
    assert.equal(byClass(cover2, "cover__note").textContent, "1 book has no PDF in the backup folder: in the app, Choose file again adds it.");
    assert.equal(byClass(cover2, "cover__error").textContent, "Could not save the PDF of “Griffiths” to the backup folder — a folder holds that name");
    assert.deepEqual(P2.texts(), [], "no toast: the cover says it");
  });

  test("an empty browser library has nothing to move", async () => {
    const P = load({ server: makeServer({ app: "app" }) });
    await P.boot();
    const cover = P.doc.getElementById("cover");
    byClass(cover, "cover__backup").click();
    await until(() => byClass(cover, "cover__error").textContent, "the message");
    assert.equal(byClass(cover, "cover__error").textContent, "This browser's library is empty: there is nothing to move into the app.");
    assert.deepEqual(P.server.list(), ["GET /api/app"], "nothing asked, nothing written");
  });

  test("a reader route (an \"Open in Marginalia\" link) follows the app's link once, by itself", async () => {
    const P = load({ server: makeServer({ app: "app" }), seed: seedLibrary, hash: "#reader/bk1/p_1" });
    await P.boot();
    const { W, R, doc } = P, cover = doc.getElementById("cover");
    assert.deepEqual(P.links, ["marginalia://open?hash=%23reader%2Fbk1%2Fp_1"], "once, at load");
    assert.equal(hidden(byClass(cover, "cover__forward")), false);
    assert.equal(byClass(cover, "cover__forward").textContent, "Opening this page in the Marginalia app…");
    assert.equal(byClass(cover, "cover__open").getAttribute("href"), "marginalia://open?hash=%23reader%2Fbk1%2Fp_1", "Open the app is the fallback");
    assert.deepEqual(P.reads, [], "the reader never opened under the cover");
    W.location.hash = "#reader/bk1/p_2";
    W.dispatchEvent({ type: "hashchange" });
    assert.deepEqual(P.links.length, 1, "never again in this page");
    assert.equal(byClass(cover, "cover__open").getAttribute("href"), "marginalia://open?hash=%23reader%2Fbk1%2Fp_2", "the link follows the hash");
    assert.deepEqual(P.reads, []);
    assert.equal(R.desktop.showCover(), true);
    assert.equal(P.links.length, 1);
    assert.equal(R.desktop.state().forwarded, true);
  });

  // repair SEC-1 (2026-11-11): GET /api/backup's newest file is not the only one that can be today's; a file named
  // after today (a Mac clock that was once ahead) sorts first, and GET /api/backup/latest sends that one
  test("SEC-1: a backup dated after today does not hide today's: \"Replace today's backup?\" still asks first, and Cancel writes nothing", async () => {
    const srv = makeServer({ app: "app", files: [{ name: NAME(TOMORROW), date: TOMORROW, bytes: 50 }, { name: NAME(TODAY), date: TODAY, bytes: 1234 }],
      texts: { [NAME(TOMORROW)]: backupText(AT_TOMORROW), [NAME(TODAY)]: backupText(AT_0912) } });
    const P = load({ server: srv, seed: seedLibrary });
    await P.boot();
    const { doc } = P, cover = doc.getElementById("cover"), button = byClass(cover, "cover__backup");
    button.click();
    await until(() => confirmButtons(doc).ok || !button.disabled, "the confirm, or the end of the run");
    const c = confirmButtons(doc);
    assert.ok(c.ok, "the confirm shows; requests: " + srv.list().join(", "));
    assert.equal(c.title.textContent, "Replace today's backup?");
    // the newest backup by name is tomorrow's, so today's time is not known
    assert.equal(textOf(c.body), "Today's backup is replaced with this browser's library. The app's own library does not change.");
    c.cancel.click();
    await until(() => !button.disabled, "the run ends");
    assert.equal(srv.requests.filter((r) => r.method === "POST").length, 0, "Cancel writes nothing");
    assert.equal(srv.texts[NAME(TODAY)], backupText(AT_0912), "today's backup is as it was");
    // Replace it: the backup, and the result says how to import it, since Import the newest backup would take tomorrow's
    button.click();
    await until(() => confirmButtons(doc).ok, "the confirm again");
    confirmButtons(doc).ok.click();
    await until(() => /^Saved this browser's library/.test(byClass(cover, "cover__status").textContent), "the result line");
    assert.equal(byClass(cover, "cover__status").textContent, "Saved this browser's library: 1 book, 1 deck, 2 prompts, 1 PDF (14:05). Now open the app, " +
      "click Import a backup file… and choose " + NAME(TODAY) + " in ~/Documents/Marginalia Backups.");
    assert.equal(byClass(cover, "cover__note").textContent, "The backup folder also holds a backup dated after today (12 Nov), so the app's Import the newest " +
      "backup would import that one instead. Check the Mac's date and time.");
  });

  test("SEC-1: with a backup dated after today and none of today, nothing is replaced (no question), and the result says how to import this one", async () => {
    const srv = makeServer({ app: "app", files: [{ name: NAME(TOMORROW), date: TOMORROW, bytes: 50 }], texts: { [NAME(TOMORROW)]: backupText(AT_TOMORROW) },
      refuse: (m, u) => (u === "/api/backup/pdf" ? { status: 409, body: { ok: false, error: "a folder holds that name" } } : null) });
    const P = load({ server: srv, seed: seedLibrary });
    await P.boot();
    const cover = P.doc.getElementById("cover"), status = byClass(cover, "cover__status");
    byClass(cover, "cover__backup").click();
    await until(() => /^Saved this browser's library/.test(status.textContent), "the result line");
    assert.ok(confirmButtons(P.doc).ok === null, "nothing of today to replace: no confirm");
    assert.equal(status.textContent, "Saved this browser's library: 1 book, 1 deck, 2 prompts, 0 PDFs (14:05). Now open the app, click Import a backup file… and choose " +
      NAME(TODAY) + " in ~/Documents/Marginalia Backups.");
    assert.equal(byClass(cover, "cover__note").textContent, "The backup folder also holds a backup dated after today (12 Nov), so the app's Import the newest " +
      "backup would import that one instead. Check the Mac's date and time. 1 book has no PDF in the backup folder: in the app, Choose file again adds it.");
    assert.equal(byClass(cover, "cover__error").textContent, "Could not save the PDF of “Griffiths” to the backup folder — a folder holds that name");
    assert.deepEqual(srv.files.map((f) => f.name), [NAME(TOMORROW), NAME(TODAY)]);
  });

  // repair F1 (2026-11-11): after the move, Brave's cover still offers its backup; the browser now remembers its move
  test("F1: the move's backup is remembered in this browser, and the cover says so at the next load", async () => {
    const storage = makeStorage();
    // a backup that fails is no move
    const failing = makeServer({ app: "app", refuse: (m, u) => (m === "POST" && u === "/api/backup" ? { status: 500, body: { ok: false, error: "disk full" } } : null) });
    const P0 = load({ server: failing, seed: seedLibrary, storage });
    await P0.boot();
    byClass(P0.doc.getElementById("cover"), "cover__backup").click();
    await until(() => byClass(P0.doc.getElementById("cover"), "cover__error").textContent, "the error");
    assert.equal(storage.getItem(MOVED_KEY), null, "nothing remembered");
    // the move: no backup of today, so no question, as before; then the browser remembers when and which file
    const srv = makeServer({ app: "app", texts: {} });
    const P1 = load({ server: srv, seed: seedLibrary, storage });
    await P1.boot();
    const c1 = P1.doc.getElementById("cover");
    assert.equal(byClass(c1, "cover__note").textContent, "", "nothing backed up from this browser yet");
    byClass(c1, "cover__backup").click();
    await until(() => /^Saved this browser's library/.test(byClass(c1, "cover__status").textContent), "the move's backup");
    assert.ok(confirmButtons(P1.doc).ok === null, "the move itself asks nothing, as before");
    assert.equal(byClass(c1, "cover__status").textContent, "Saved this browser's library: 1 book, 1 deck, 2 prompts, 1 PDF (14:05). Now open the app and click Import the newest backup.");
    assert.deepEqual(JSON.parse(storage.getItem(MOVED_KEY)), { at: T0, file: NAME(TODAY) });
    // the same browser later (an "Open in Marginalia" link, a reload): the cover says when its library was backed up
    const asked = srv.requests.length;
    const P2 = load({ server: srv, seed: seedLibrary, storage });
    await P2.boot();
    assert.equal(byClass(P2.doc.getElementById("cover"), "cover__note").textContent,
      "This browser's library was backed up for the move today at 14:05. Once the app has imported it, the app keeps your library, so there is no need to back it up again.");
    assert.deepEqual(srv.list().slice(asked), ["GET /api/app"], "the page asks nothing more by itself");
  });

  test("F1: backing up again after the move asks first and names what it replaces; Cancel writes nothing and keeps today's backup", async () => {
    const storage = makeStorage();
    storage.setItem(MOVED_KEY, JSON.stringify({ at: T0 - 86400000, file: NAME("2026-11-10") }));   // the move, yesterday at 14:05
    // today's file is the app's own backup (09:12); yesterday's is the move's
    const appText = backupText(AT_0912);
    const srv = makeServer({ app: "app", files: [{ name: NAME(TODAY), date: TODAY, bytes: 2222 }, { name: NAME("2026-11-10"), date: "2026-11-10", bytes: 1111 }],
      texts: { [NAME(TODAY)]: appText, [NAME("2026-11-10")]: backupText(T0 - 86400000) } });
    const P = load({ server: srv, seed: seedLibrary, storage });
    await P.boot();
    const { doc } = P, cover = doc.getElementById("cover"), button = byClass(cover, "cover__backup"), note = byClass(cover, "cover__note");
    const moved = "This browser's library was backed up for the move yesterday at 14:05. Once the app has imported it, the app keeps your library, so there is no need to back it up again.";
    assert.equal(note.textContent, moved);
    button.click();
    await until(() => confirmButtons(doc).ok || !button.disabled, "the confirm, or the end of the run");
    const c = confirmButtons(doc);
    assert.ok(c.ok, "the confirm shows; requests: " + srv.list().join(", "));
    assert.equal(c.title.textContent, "Back up this browser's library again?");
    assert.equal(textOf(c.body), "This browser's library was already backed up for the move yesterday at 14:05. Once the app has imported it, the app keeps your library and backs it up itself." +
      "Backing up again replaces today's backup (made at 09:12), which may be the app's own, with this browser's library, and saved PDFs that only that backup lists " +
      "may be removed from the backup folder." + "The app's own library does not change. Do this only if the move did not work.");
    assert.equal(textOf(c.ok), "Back up again");
    assert.ok(classes(c.ok).includes("btn--danger"), "a careful choice");
    c.cancel.click();
    await until(() => !button.disabled, "the run ends");
    await wait(10);
    assert.ok(confirmButtons(doc).ok === null, "one question, not two");
    assert.equal(srv.requests.filter((r) => r.method === "POST").length, 0, "Cancel writes nothing");
    assert.equal(srv.texts[NAME(TODAY)], appText, "the app's backup of today is as it was");
    assert.equal(note.textContent, moved, "the note stays");
    assert.equal(byClass(cover, "cover__status").textContent, "");
  });

  test("F1: before the app's backup of today, backing up again says it would take the app's daily backup; Back up again backs up", async () => {
    const storage = makeStorage();
    storage.setItem(MOVED_KEY, JSON.stringify({ at: new Date(2026, 10, 2, 8, 30).getTime(), file: NAME("2026-11-02") }));
    const srv = makeServer({ app: "app", files: [{ name: NAME("2026-11-10"), date: "2026-11-10", bytes: 1111 }], texts: { [NAME("2026-11-10")]: backupText(T0 - 86400000) } });
    const P = load({ server: srv, seed: seedLibrary, storage });
    await P.boot();
    const { doc } = P, cover = doc.getElementById("cover"), button = byClass(cover, "cover__backup");
    assert.equal(byClass(cover, "cover__note").textContent, "This browser's library was backed up for the move on 2 Nov at 08:30. Once the app has imported it, the app keeps your library, so there is no need to back it up again.");
    button.click();
    await until(() => confirmButtons(doc).ok || !button.disabled, "the confirm, or the end of the run");
    const c = confirmButtons(doc);
    assert.ok(c.ok, "the confirm shows; requests: " + srv.list().join(", "));
    assert.equal(c.title.textContent, "Back up this browser's library again?");
    assert.equal(textOf(c.body), "This browser's library was already backed up for the move on 2 Nov at 08:30. Once the app has imported it, the app keeps your library and backs it up itself." +
      "Backing up again makes this browser's library today's backup, and the app then makes no backup of its own today." +
      "The app's own library does not change. Do this only if the move did not work.");
    c.ok.click();
    await until(() => /^Saved this browser's library/.test(byClass(cover, "cover__status").textContent), "the result line");
    const posts = srv.requests.filter((r) => r.method === "POST");
    assert.deepEqual(posts.map((r) => r.url + " " + r.headers["X-Marginalia-Client"]), ["/api/backup browser-move", "/api/backup/pdf browser-move"]);
    assert.equal(byClass(cover, "cover__status").textContent, "Saved this browser's library: 1 book, 1 deck, 2 prompts, 1 PDF (14:05). Now open the app and click Import the newest backup.");
    assert.equal(byClass(cover, "cover__note").textContent, "");
    assert.deepEqual(JSON.parse(storage.getItem(MOVED_KEY)), { at: T0, file: NAME(TODAY) }, "the newer backup is remembered");
  });

  test("F1: a storage that refuses the record still lets this page remember its move; a broken record counts as none", async () => {
    const refusing = makeStorage();
    refusing.setItem = () => { throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); };
    const srv = makeServer({ app: "app", texts: {} });
    const P = load({ server: srv, seed: seedLibrary, storage: refusing });
    await P.boot();
    const { doc } = P, cover = doc.getElementById("cover"), button = byClass(cover, "cover__backup");
    button.click();
    await until(() => /^Saved this browser's library/.test(byClass(cover, "cover__status").textContent), "the move's backup");
    assert.equal(refusing.getItem(MOVED_KEY), null, "storage refused it");
    button.click();
    await until(() => confirmButtons(doc).ok || !button.disabled, "the confirm, or the end of the run");
    assert.equal(confirmButtons(doc).title && confirmButtons(doc).title.textContent, "Back up this browser's library again?", "this page remembers it");
    confirmButtons(doc).cancel.click();
    await until(() => !button.disabled, "the run ends");
    assert.equal(byClass(cover, "cover__note").textContent, "This browser's library was backed up for the move today at 14:05. Once the app has imported it, the app keeps your library, so there is no need to back it up again.");
    // a value that is not a record: nothing was moved as far as this browser knows
    const broken = makeStorage();
    broken.setItem(MOVED_KEY, "{not json");
    const Q = load({ server: makeServer({ app: "app", texts: {} }), seed: seedLibrary, storage: broken });
    await Q.boot();
    const qc = Q.doc.getElementById("cover");
    assert.equal(byClass(qc, "cover__note").textContent, "");
    byClass(qc, "cover__backup").click();
    await until(() => /^Saved this browser's library/.test(byClass(qc, "cover__status").textContent), "a backup with no question");
    assert.ok(confirmButtons(Q.doc).ok === null);
    assert.deepEqual(JSON.parse(broken.getItem(MOVED_KEY)), { at: T0, file: NAME(TODAY) }, "the backup wrote a record over it");
  });

  // repair F5 (2026-11-11): Brave's IndexedDB could not be opened, so the store runs in memory and holds nothing
  test("F5: a library whose storage could not be opened is not called empty: the cover says why it cannot back up, and asks nothing", async () => {
    const P = load({ server: makeServer({ app: "app" }), storeMode: "memory" });
    assert.equal(await P.boot(), true, P.logs.join("\n"));
    assert.equal(P.R.desktop.mode(), "cover");
    const cover = P.doc.getElementById("cover");
    byClass(cover, "cover__backup").click();
    await until(() => byClass(cover, "cover__error").textContent, "the message");
    assert.equal(byClass(cover, "cover__error").textContent, "Could not back up this browser's library — this page could not open the browser's storage, so it " +
      "cannot read the library. Reload the page; if that does not help, quit the browser and open it again.");
    assert.equal(byClass(cover, "cover__status").textContent, "");
    assert.deepEqual(P.server.list(), ["GET /api/app"], "nothing asked, nothing written");
    assert.equal(byClass(cover, "cover__backup").disabled, false);
  });
});

/* ------------------------------------------------------------------ normal mode, the artifact */

describe("normal mode when GET /api/app answers 404, fails or never answers; the artifact unchanged (FEATURES E2.2b)", () => {
  for (const [what, app] of [["404 (a serve.py without --app)", null], ["a network error", "error"]]) {
    test(what + ": the page boots as before", async () => {
      const P = load({ server: makeServer({ app }), seed: seedLibrary });
      assert.equal(await P.boot(), true, P.logs.join("\n"));
      await until(() => P.R.backup.state().status !== "checking", "the daily backup's first check");
      assert.equal(P.R.desktop.mode(), "browser");
      assert.equal(hidden(P.doc.getElementById("cover")), true, "no cover");
      assert.ok(P.doc.getElementById("library").childNodes.length > 0, "the library rendered");
      assert.equal(P.R.app.current().screen, "library");
      const list = P.server.list();
      assert.equal(list[0], "GET /api/app");
      assert.ok(list.includes("GET /api/backup"), list.join(", "));
      assert.ok(P.server.requests.filter((r) => r.url === "/api/backup").every((r) => r.afterApp), "the app check answered first");
      for (const r of P.server.requests.filter((x) => x.method === "POST")) assert.equal("X-Marginalia-Client" in r.headers, false, r.url);
      assert.equal(P.doc.getElementById("library").hasAttribute("inert"), false);
    });
  }

  test("no answer within the time limit (3 s, shortened here): normal mode, and the daily backup only after it", async () => {
    const P = load({ server: makeServer({ app: "hang" }), seed: seedLibrary, checkMs: 60 });
    const t = Date.now();
    assert.equal(await P.boot(), true);
    assert.ok(Date.now() - t >= 50, "boot waited for the check");
    await until(() => P.server.list().includes("GET /api/backup"), "the daily backup's check");
    assert.equal(P.R.desktop.mode(), "browser");
    assert.equal(hidden(P.doc.getElementById("cover")), true);
    assert.equal(P.server.list()[0], "GET /api/app");
  });

  test("a slow answer: nothing routes and no backup request leaves before it", async () => {
    const P = load({ server: makeServer({ app: null, appDelay: 60 }), seed: seedLibrary });
    let routedEarly = false;
    const route = P.R.app.route;
    P.R.app.route = function () { if (!P.server.appAnswered) routedEarly = true; return route.apply(this, arguments); };
    await P.boot();
    await until(() => P.server.list().includes("GET /api/backup"), "the daily backup's check");
    assert.equal(routedEarly, false);
    assert.ok(P.server.requests.filter((r) => r.url !== "/api/app").every((r) => r.afterApp));
  });

  test("the claude.ai artifact: no app check, no cover, the daily backup unavailable as before", async () => {
    const P = load({ server: makeServer({ app: "app" }), artifact: true });
    assert.equal(await P.boot(), true);
    assert.equal(P.R.app.isArtifact(), true);
    assert.deepEqual(P.server.requests, [], "no request at all");
    assert.equal(P.R.desktop.mode(), "browser");
    assert.equal(hidden(P.doc.getElementById("cover")), true);
    assert.deepEqual([P.R.backup.state().status, P.R.backup.state().reason], ["unavailable", "artifact"]);
    assert.ok(byClass(P.doc.getElementById("library"), "lib-welcome") === null, "no welcome card");
  });
});

/* ------------------------------------------------------------------ the desktop app: the welcome card */

describe("the desktop app's welcome card (FEATURES E2.2d) and persistent storage (E2.2e)", () => {
  const card = (P) => byClass(P.doc.getElementById("library"), "lib-welcome");

  test("shown for an empty library: the title, the steps, \"No backup yet\" while the folder holds none", async () => {
    const calls = [];
    const navStorage = { persisted: () => { calls.push("persisted"); return Promise.resolve(false); }, persist: () => { calls.push("persist"); return Promise.resolve(true); } };
    const P = load({ app: true, navStorage });
    assert.equal(await P.boot(), true, P.logs.join("\n"));
    await until(() => P.R.backup.state().status === "on", "the backup folder listed");
    await until(() => card(P) && byClass(card(P), "lib-welcome__none") && byClass(card(P), "lib-welcome__none").textContent === "No backup yet", "No backup yet");
    const c = card(P);
    assert.equal(byClass(c, "lib-welcome__title").textContent, "Welcome to Marginalia");
    assert.deepEqual(walk(c, (el) => classes(el).indexOf("lib-welcome__lead") >= 0).map((el) => el.textContent),
      ["New here? Click Start with an empty library, then add a PDF.", "Did you use Marginalia in a browser before? Bring that library here:"]);
    assert.equal(textOf(byClass(c, "lib-welcome__steps")), "1. In that browser, open Marginalia and click Back up this browser's library.2. Here, click Import the newest backup.");
    assert.ok(!/Brave/.test(textOf(c)), "the card names no browser");
    const imp = byClass(c, "lib-welcome__import");
    assert.deepEqual([imp.textContent, imp.disabled], ["Import the newest backup", true]);
    assert.equal(byClass(c, "lib-welcome__file").textContent, "Import a backup file…");
    assert.equal(byClass(c, "lib-welcome__empty").textContent, "Start with an empty library");
    assert.equal(P.R.desktop.mode(), "app");
    assert.equal(hidden(P.doc.getElementById("cover")), true, "no cover in the app");
    assert.equal(P.server.list().includes("GET /api/app"), false, "the app asks no GET /api/app");
    assert.deepEqual(calls, ["persisted", "persist"], "persist() once at boot");
  });

  test("not shown in a browser page, nor with a live book, deck or prompt, nor once dismissed", async () => {
    const browser = load({});
    await browser.boot();
    assert.ok(card(browser) === null, "a browser page");
    const withBook = load({ app: true, seed: seedLibrary });
    await withBook.boot();
    assert.ok(card(withBook) === null, "a library with a book");
    const st = makeStorage();
    st.map.set("marginalia.welcomeDismissed", "1");
    const dismissed = load({ app: true, storage: st });
    await dismissed.boot();
    assert.ok(card(dismissed) === null, "dismissed");
  });

  test("Import the newest backup (today, 09:12): the real import, its toast, the PDF restored, the key reminder; the card goes", async () => {
    const srv = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 4321 }], latest: { name: NAME(TODAY), text: backupText(AT_0912) },
      pdfs: [{ sha256: SHA, name: "Griffiths [" + SHA.slice(0, 12) + "].pdf", body: PDF }] });
    const P = load({ app: true, server: srv });
    await P.boot();
    await until(() => card(P) && byClass(card(P), "lib-welcome__import").textContent === "Import the newest backup (today, 09:12)", "the label with the time");
    const imp = byClass(card(P), "lib-welcome__import");
    assert.equal(imp.disabled, false);
    imp.click();
    await until(() => P.texts().includes(KEY_REMINDER), "the API key reminder");
    const texts = P.texts();
    const iImport = texts.findIndex((t) => /^Imported 2 prompts/.test(t)), iRestore = texts.indexOf("Restored 1 PDF from your backup folder"), iKey = texts.indexOf(KEY_REMINDER);
    assert.ok(iImport >= 0 && iRestore > iImport && iKey > iRestore, "the import's toast, then the restore's, then the reminder: " + texts.join(" | "));
    const { R } = P;
    const b = R.cache.collection("bk1");
    assert.deepEqual([b.name, b.hasBytes, b.sha256], ["Griffiths", true, SHA]);
    assert.equal(R.cache.folderOf(b), FOLDER.id);
    assert.equal(R.cache.folder(FOLDER.id).name, "Physics");
    assert.deepEqual(plain(R.cache.promptsOf("bk1").map((p) => p.id).sort()), ["p_1", "p_2"]);
    const bytes = await R.store.docs.loadBytes("bk1");
    assert.equal(hashOf(Buffer.from(bytes)), SHA, "the restored PDF is the book's");
    assert.equal(R.settings.get("obsidianFolder"), "Notes/Physics", "the backup's settings came along (restoreSettings)");
    await until(() => card(P) === null, "the card goes once the library holds the book");
    assert.ok(P.server.list().includes("GET /api/backup/pdf/" + SHA));
  });

  test("an import that fails toasts why and the card stays; Import a backup file… opens the Import dialog", async () => {
    const srv = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 10 }], latest: { name: NAME(TODAY), text: backupText(AT_0912) },
      refuse: (m, u) => (u === "/api/backup/latest" ? { status: 500, body: { ok: false, error: "the backup could not be read" } } : null) });
    const P = load({ app: true, server: srv });
    const dialogs = [];
    await P.boot();
    P.R.exporter.openDialog = (o) => { dialogs.push(plain(o)); };
    await until(() => card(P) && !byClass(card(P), "lib-welcome__import").disabled, "a backup to import");
    byClass(card(P), "lib-welcome__import").click();
    await until(() => P.texts().some((t) => /^Could not import/.test(t)), "the error toast");
    assert.ok(P.texts().includes("Could not import the newest backup — the backup could not be read"), P.texts().join(" | "));
    await wait(5);
    assert.ok(card(P), "the card stays");
    assert.equal(P.texts().includes(KEY_REMINDER), false);
    byClass(card(P), "lib-welcome__file").click();
    assert.deepEqual(dialogs, [{ scope: "all", tab: "import" }]);
  });

  // repair SEC-1 (2026-11-11): GET /api/backup/latest sends the newest file by name; one named after today (a Mac clock
  // that was once ahead) is not the backup Brave's cover just wrote
  test("SEC-1: a newest backup dated after today is not imported: the button says why and stays disabled; importLatest() refuses it", async () => {
    const srv = makeServer({ files: [{ name: NAME(TOMORROW), date: TOMORROW, bytes: 50 }, { name: NAME(TODAY), date: TODAY, bytes: 4321 }],
      texts: { [NAME(TOMORROW)]: backupText(AT_TOMORROW), [NAME(TODAY)]: backupText(AT_0912) } });
    const P = load({ app: true, server: srv });
    await P.boot();
    const why = "The newest backup is dated after today (12 Nov) — check the Mac's date and time, or use Import a backup file…";
    // the label names the file's day, as the reason does (not the time the backup holds)
    await until(() => {
      const c = card(P), none = c && byClass(c, "lib-welcome__none");
      return none && none.textContent === why && byClass(c, "lib-welcome__import").textContent === "Import the newest backup (12 Nov)";
    }, "the reason, and the newest backup's day");
    const imp = byClass(card(P), "lib-welcome__import");
    assert.deepEqual([imp.disabled, imp.title], [true, why]);
    assert.equal(P.R.desktop.welcome().ahead, "12 Nov");
    const r = plain(await P.R.desktop.importLatest());
    assert.equal(r.ok, false);
    assert.ok(P.texts().includes("Could not import the newest backup — it is dated after today (12 Nov): check the Mac's date and time, or use Import a backup file…"),
      P.texts().join(" | "));
    assert.deepEqual(plain(P.R.cache.collections().filter((c) => !c.deletedAt)), [], "nothing imported");
    assert.equal(P.server.list().includes("GET /api/backup/latest"), true, "it asked, then refused what came");
    assert.equal(P.texts().includes(KEY_REMINDER), false);
    assert.ok(card(P), "the card stays");
    // a file named for tomorrow that was made today (a time-zone change): the label still names the file's day, never "today"
    const tz = makeServer({ files: [{ name: NAME(TOMORROW), date: TOMORROW, bytes: 50 }],
      texts: { [NAME(TOMORROW)]: backupText(AT_0912) } });
    const Z = load({ app: true, server: tz });
    await Z.boot();
    await until(() => card(Z) && byClass(card(Z), "lib-welcome__none") && Z.R.desktop.welcome().at === AT_0912, "the time it holds");
    assert.equal(byClass(card(Z), "lib-welcome__import").textContent, "Import the newest backup (12 Nov)");
    assert.equal(byClass(card(Z), "lib-welcome__import").disabled, true);
    // the backup of today alone: offered as before (no "ahead")
    const ok = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 4321 }], texts: { [NAME(TODAY)]: backupText(AT_0912) } });
    const Q = load({ app: true, server: ok });
    await Q.boot();
    await until(() => card(Q) && byClass(card(Q), "lib-welcome__import").textContent === "Import the newest backup (today, 09:12)", "today's backup");
    assert.equal(byClass(card(Q), "lib-welcome__import").disabled, false);
    assert.ok(byClass(card(Q), "lib-welcome__none") === null);
    assert.equal("ahead" in Q.R.desktop.welcome(), false);
  });

  test("Start with an empty library: the card goes for good (localStorage) and focus lands on Add PDF", async () => {
    const P = load({ app: true });
    await P.boot();
    await until(() => card(P), "the card");
    byClass(card(P), "lib-welcome__empty").click();
    assert.equal(P.W.localStorage.getItem("marginalia.welcomeDismissed"), "1");
    assert.ok(card(P) === null, "the card went");
    assert.equal(P.doc.activeElement.getAttribute("data-focus"), "add");
    await wait(5);
    P.R.library.render();
    assert.ok(card(P) === null, "not after a re-render either");
  });
});
