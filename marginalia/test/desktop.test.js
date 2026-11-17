"use strict";
// test/desktop.test.js — M.desktop (js/desktop.js; FEATURES E2.2, BUILD-NOTES "Desktop app (binding)", part 2) and what
// it changes in M.backup and M.obsidian: which page this is (the desktop app; a browser page on 127.0.0.1 or localhost
// asking GET /api/app once, at most 3 s; everything else unchanged), "X-Marginalia-Client: app" on every POST route in the
// app and nothing more elsewhere, cover mode (no write but the cover's "browser-move" backup, every Obsidian send
// refused), a send waiting for the app check, the app's 409 "app_only" read as its message, GET /api/backup/latest,
// persistent storage asked once in the app, and the welcome card's data (welcome(), importLatest(), dismissWelcome()).
// Each test is a fresh page: a vm context running the real util, bus, settings, scheduler, prompts, context, markup,
// exporter, obsidian, backup and desktop modules, with M.store / M.cache / M.app stubs and a stand-in for tools/serve.py
// (the E2.1 routes) in place of fetch. Nothing here reaches a network, a server, a vault or a folder, and no obsidian://
// or marginalia:// link is opened: both openers are recorders. Run from the app folder: node --test
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const JS = path.join(__dirname, "..", "js");
const MODULES = ["util", "bus", "settings", "scheduler", "prompts", "context", "markup", "exporter", "obsidian", "backup", "desktop"];
const TODAY = "2026-11-11";
const T0 = new Date(2026, 10, 11, 14, 5, 0).getTime();          // 14:05 local time on TODAY
const DIR = "~/Documents/Marginalia Backups";
const NAME = (day) => "marginalia-backup-" + day + ".json";
const COVERED = "Marginalia is now an app — open it to send to Obsidian.";
const APP_ONLY = { ok: false, error: "app_only", message: "Marginalia is now an app. Open the Marginalia app to do this." };
const KEY_REMINDER = "Paste your Anthropic API key again in Settings → LaTeX from snips (backups never contain it).";
const BASE_JSON = { "Content-Type": "application/json", "X-Marginalia": "1" };

const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
async function settle(n) { for (let i = 0; i < (n || 15); i++) await new Promise((r) => setImmediate(r)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));     // a real timer: the test waits on it
const hashOf = (b) => crypto.createHash("sha256").update(b).digest("hex");

const PDF = Buffer.from("%PDF-1.7\n% the book\n" + "x".repeat(200) + "\n%%EOF\n");
const SHA = hashOf(PDF);
function book(id, extra) {
  return Object.assign({ id, kind: "book", name: "Griffiths", sha256: SHA, hashAlgo: "sha-256", byteLength: PDF.length, hasBytes: true,
    pageCount: 3, pageLabels: null, sections: [], addedAt: T0, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 }, extra || {});
}
const DECK = { id: "deck_1", kind: "deck", name: "Thermo", description: "", sections: [], addedAt: T0, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 };
function prompt(id, collectionId, extra) {
  return Object.assign({ id, collectionId, kind: "qa", text: "Q. " + id + "?\nA. yes", tags: [], flagged: false, anchor: null,
    context: { docName: "Griffiths", sectionLabel: null, pageIndex: 0, pageLabel: "1" },
    cards: [{ i: 0, createdAt: T0, lastReviewedAt: null, intervalMs: 432000000, dueAt: T0 + 432000000, log: [] }],
    dueAt: T0 + 432000000, createdAt: T0, contentUpdatedAt: T0, updatedAt: T0, deletedAt: null, v: 1 }, extra || {});
}

function res(status, json, headers) {
  const h = headers || {};
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => { const key = Object.keys(h).find((x) => x.toLowerCase() === String(k).toLowerCase()); return key ? h[key] : null; } },
    json: () => (json instanceof Error ? Promise.reject(json) : Promise.resolve(json)),
    text: () => Promise.resolve(typeof json === "string" ? json : JSON.stringify(json))
  };
}

// A stand-in for tools/serve.py with FEATURES E2.1: GET /api/app (srv.app: "app" → {ok, app: true, version}; "error" →
// no answer; "hang" → never answers; a number → that status; null → 404 as a server without --app), the backup routes
// (GET/POST /api/backup, GET /api/backup/latest, GET /api/backup/pdfs, POST /api/backup/pdf) and the Obsidian routes
// (GET /vaults, POST /note, POST /notes; srv.oldNotes: a serve.py from before /notes). srv.refuse(method, url, headers)
// → {status, body} | null lets a test answer a request with a refusal (the app's 409 "app_only", a 500…).
function makeServer(over) {
  const srv = Object.assign({ app: null, version: "0.2.0", appDelay: 0, today: TODAY, dir: DIR, files: [], latest: null, pdfs: [],
    oldNotes: false, refuse: null, requests: [] }, over || {});
  srv.fetch = function (url, init) {
    init = init || {};
    const method = String(init.method || "GET").toUpperCase(), u = String(url);
    const headers = Object.assign({}, init.headers);
    srv.requests.push({ method, url: u, headers, init });
    const refused = srv.refuse ? srv.refuse(method, u, headers) : null;
    if (refused) return Promise.resolve(res(refused.status, refused.body));
    if (u === "/api/app") {
      if (srv.app === "error") return Promise.reject(new TypeError("Failed to fetch"));
      if (srv.app === "hang") return new Promise(() => {});
      const answer = srv.app === "app" ? res(200, { ok: true, app: true, version: srv.version })
        : typeof srv.app === "number" ? res(srv.app, { ok: false, error: "not found" })
          : srv.app && typeof srv.app === "object" ? res(srv.app.status, srv.app.body) : res(404, { ok: false, error: "not found" });
      return srv.appDelay ? wait(srv.appDelay).then(() => answer) : Promise.resolve(answer);
    }
    if (u === "/api/backup" && method === "GET") return Promise.resolve(res(200, { ok: true, dir: srv.dir, today: srv.today, files: srv.files }));
    if (u === "/api/backup" && method === "POST") {
      const body = JSON.parse(init.body), name = NAME(srv.today), bytes = Buffer.byteLength(init.body);
      srv.files = srv.files.filter((f) => f.name !== name).concat([{ name, date: srv.today, bytes }]);
      srv.latest = { name, text: JSON.stringify(body.backup) };
      return Promise.resolve(res(200, { ok: true, file: name, bytes, skipped: false, pruned: [] }));
    }
    if (u === "/api/backup/latest") {
      if (!srv.latest) return Promise.resolve(res(404, { ok: false, error: "no_backup" }));
      return Promise.resolve(res(200, srv.latest.text, { "Content-Type": "application/json", "X-Marginalia-Backup-Name": srv.latest.name }));
    }
    if (u === "/api/backup/pdfs") return Promise.resolve(res(200, { ok: true, dir: srv.dir, files: srv.pdfs.map((p) => ({ sha12: p.sha12, name: p.name, bytes: p.bytes })) }));
    if (u === "/api/backup/pdf" && method === "POST") {
      const sha = String(headers["X-Marginalia-Sha256"]), name = decodeURIComponent(String(headers["X-Marginalia-Name"])) + " [" + sha.slice(0, 12) + "].pdf";
      srv.pdfs.push({ sha12: sha.slice(0, 12), name, bytes: init.body.byteLength });
      return Promise.resolve(res(200, { ok: true, file: name, bytes: init.body.byteLength, skipped: false }));
    }
    if (u === "/api/obsidian/vaults") return Promise.resolve(res(200, { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }], replaceOnly: true }));
    if (u === "/api/obsidian/note") {
      const b = JSON.parse(init.body);
      return Promise.resolve(res(200, { ok: true, file: b.file, created: true, replaced: false }));
    }
    if (u === "/api/obsidian/notes") {
      if (srv.oldNotes) return Promise.resolve(res(404, { ok: false, error: "not found" }));
      const b = JSON.parse(init.body);
      return Promise.resolve(res(200, { ok: true, file: b.file, created: true, results: b.blocks.map((x) => ({ blockId: x.blockId, ok: true, replaced: false })) }));
    }
    return Promise.resolve(res(404, { ok: false, error: "not found" }));
  };
  srv.posts = () => srv.requests.filter((r) => r.method === "POST");
  srv.list = () => srv.requests.map((r) => r.method + " " + r.url);
  return srv;
}

function makeStorage(refuse) {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (refuse) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); } };
}

// One page. opts: {app: true|object (window.marginaliaDesktop), hostname, protocol, artifact, fetch: false, server,
// storage, navStorage, hash, collections, prompts, docs, checkMs}
function page(opts) {
  opts = opts || {};
  const env = { server: opts.server || makeServer(), toasts: [], confirms: [], opened: [], links: [], events: [], logs: [],
    collections: (opts.collections || []).map((c) => Object.assign({}, c)), prompts: (opts.prompts || []).map((p) => Object.assign({}, p)),
    docs: new Map(Object.entries(opts.docs || {})), storage: opts.storage || makeStorage(), lock: null, imports: [] };
  const hostname = opts.hostname || "127.0.0.1", protocol = opts.protocol || "http:";
  const doc = { _l: {}, visibilityState: "visible", hidden: false,
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener(t, fn) { const l = this._l[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
    dispatchEvent(ev) { (this._l[ev.type] || []).slice().forEach((fn) => fn(ev)); return true; } };
  const win = {
    console: { log() {}, info() {}, debug() {}, warn: (...a) => env.logs.push(a.join(" ")), error: (...a) => env.logs.push(a.join(" ")) },
    // real timers: the page's only ones are the app check's (cleared when it answers) and test waits
    setTimeout: (fn, ms, ...a) => setTimeout(fn, ms, ...a), clearTimeout, queueMicrotask, structuredClone,
    setInterval: () => 0, clearInterval: () => {}, crypto: crypto.webcrypto, TextEncoder, TextDecoder, Intl, AbortController,
    localStorage: env.storage, document: doc, _l: {},
    navigator: { userAgent: "test", storage: opts.navStorage },
    location: protocol === "file:" ? { protocol, hostname: "", host: "", origin: "null", href: "file:///Users/me/marginalia.html", hash: opts.hash || "" }
      : { protocol, hostname, host: hostname + ":8765", origin: protocol + "//" + hostname + ":8765", href: protocol + "//" + hostname + ":8765/", hash: opts.hash || "" }
  };
  win.addEventListener = (t, fn) => { (win._l[t] = win._l[t] || []).push(fn); };
  win.removeEventListener = (t, fn) => { const l = win._l[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  win.dispatchEvent = (ev) => { (win._l[ev.type] || []).slice().forEach((fn) => fn(ev)); return true; };
  if (opts.app) win.marginaliaDesktop = opts.app === true ? Object.freeze({ app: true, version: "0.2.0", platform: "darwin" }) : opts.app;
  if (opts.fetch !== false) win.fetch = (url, init) => env.server.fetch(url, init);
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  for (const name of MODULES) vm.runInContext(fs.readFileSync(path.join(JS, name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const M = win.Marginalia;
  // DECISIONS D32: the Obsidian connection is switched on in these pages (in memory: nothing goes to the page's storage)
  const settingOf = M.settings.get;
  M.settings.get = (k) => (k === "obsidian" ? opts.obsidian !== false : settingOf(k));
  const put = (list, r) => { const i = list.findIndex((x) => x.id === r.id); if (i >= 0) list[i] = r; else list.push(r); return Promise.resolve(r); };
  M.store = { mode: () => opts.storeMode || "idb", locked: () => env.lock, attachments: { get: () => Promise.resolve(null) },
    docs: { loadBytes: (id) => Promise.resolve(env.docs.has(id) ? env.docs.get(id) : null) } };
  M.cache = {
    collections: () => env.collections, prompts: () => env.prompts,
    collection: (id) => env.collections.find((c) => c.id === id) || null,
    prompt: (id) => env.prompts.find((p) => p.id === id) || null,
    promptsOf: (cid) => env.prompts.filter((p) => p.collectionId === cid),
    saveCollection: (c) => put(env.collections, c), savePrompt: (p) => put(env.prompts, p),
    patchPrompts: (changes) => {
      changes.forEach((c) => {
        const p = env.prompts.find((x) => x.id === c.id);
        if (p) Object.keys(c.fields).forEach((k) => { if (c.fields[k] === undefined) delete p[k]; else p[k] = c.fields[k]; });
      });
      return Promise.resolve(changes.length);
    }
  };
  M.library = { attachPdf: (id) => { const c = M.cache.collection(id); c.hasBytes = true; return Promise.resolve(c); } };
  M.app = {
    isArtifact: () => !!opts.artifact,
    toast: (o) => { env.toasts.push(o); return { close() {} }; },
    confirm: (o) => { env.confirms.push(o); return Promise.resolve(env.confirmAnswer !== false); }
  };
  M.bus.on("desktop:state", (s) => env.events.push(plain(s)));
  M.backup._setTimers({ setInterval: () => 1, clearInterval: () => {} });
  M.backup._setNow(() => T0);
  M.desktop._setNow(() => T0);
  M.desktop._setOpener((uri) => { env.links.push(uri); return true; });
  M.obsidian._setOpener((uri) => { env.opened.push(uri); return true; });
  if (opts.checkMs) M.desktop._setCheckMs(opts.checkMs);
  return Object.assign(env, { win, doc, M, D: M.desktop, B: M.backup, O: M.obsidian, texts: () => env.toasts.map((t) => t.text) });
}

/* ------------------------------------------------------------------ which page is this */

describe("M.desktop: which page this is (FEATURES E2.2a, b, e)", () => {
  test("isApp() only for window.marginaliaDesktop.app === true (the app's preload)", () => {
    assert.equal(page({ app: true }).D.isApp(), true);
    for (const flag of [{ app: "true" }, { app: 1 }, { version: "0.2.0" }, null]) {
      const p = page({ app: flag === null ? undefined : flag });
      assert.equal(p.D.isApp(), false, JSON.stringify(flag));
    }
  });

  test("headers(): exactly the given headers off the app; X-Marginalia-Client: app in the app; an explicit client wins", () => {
    const off = page(), base = Object.assign({}, BASE_JSON);
    const h = off.D.headers(base);
    assert.deepEqual(plain(h), BASE_JSON, "no extra key off the app");
    assert.notEqual(h, base, "a copy");
    assert.deepEqual(plain(off.D.headers(base, "browser-move")), Object.assign({}, BASE_JSON, { "X-Marginalia-Client": "browser-move" }));
    assert.deepEqual(plain(off.D.headers(base, "anything else")), BASE_JSON, "only the two clients the server knows");
    const app = page({ app: true });
    assert.deepEqual(plain(app.D.headers(base)), Object.assign({}, BASE_JSON, { "X-Marginalia-Client": "app" }));
    assert.deepEqual(plain(base), BASE_JSON, "the base is not changed");
    assert.deepEqual([app.D.CLIENT_HEADER, app.D.APP_CLIENT, app.D.MOVE_CLIENT, app.D.CHECK_MS], ["X-Marginalia-Client", "app", "browser-move", 3000]);
  });

  test("the app: mode \"app\" at once, no request; persistent storage asked once when persisted() is false", async () => {
    const calls = [];
    const navStorage = { persisted: () => { calls.push("persisted"); return Promise.resolve(false); }, persist: () => { calls.push("persist"); return Promise.resolve(true); } };
    const p = page({ app: true, navStorage });
    assert.equal(p.D.mode(), "unknown");
    assert.equal(await p.D.start(), "app");
    assert.equal(await p.D.start(), "app", "once per page");
    assert.equal(await p.D.askPersist(), true);
    assert.deepEqual(calls, ["persisted", "persist"], "persist() once");
    assert.deepEqual(p.server.requests, [], "the app asks no GET /api/app");
    assert.deepEqual([p.D.mode(), p.D.covered(), p.D.state().app], ["app", false, true]);
    // already persisted: nothing more; persisted() refusing: nothing; no navigator.storage: nothing
    const yes = [], p2 = page({ app: true, navStorage: { persisted: () => { yes.push("persisted"); return Promise.resolve(true); }, persist: () => { yes.push("persist"); return Promise.resolve(true); } } });
    await p2.D.start();
    assert.equal(await p2.D.askPersist(), true);
    assert.deepEqual(yes, ["persisted"]);
    const no = [], p3 = page({ app: true, navStorage: { persisted: () => { no.push("persisted"); return Promise.reject(new Error("denied")); }, persist: () => { no.push("persist"); return Promise.resolve(true); } } });
    await p3.D.start();
    assert.equal(await p3.D.askPersist(), null);
    assert.deepEqual(no, ["persisted"]);
    const p4 = page({ app: true });
    await p4.D.start();
    assert.equal(await p4.D.askPersist(), null);
    // a browser page never asks
    const b = [], p5 = page({ app: false, navStorage: { persisted: () => { b.push("persisted"); return Promise.resolve(false); }, persist: () => { b.push("persist"); return Promise.resolve(true); } } });
    await p5.D.start();
    assert.equal(await p5.D.askPersist(), null);
    assert.deepEqual(b, []);
  });

  test("a browser page on 127.0.0.1: one GET /api/app; {ok: true, app: true} → cover mode, with the version", async () => {
    const p = page({ server: makeServer({ app: "app", version: "0.2.0" }) });
    const first = p.D.start();
    assert.equal(p.D.mode(), "checking");
    assert.equal(p.D.start(), first, "the same check");
    assert.equal(await first, "cover");
    const r = p.server.requests;
    assert.deepEqual(p.server.list(), ["GET /api/app"]);
    assert.deepEqual([r[0].headers, r[0].init.cache, r[0].init.credentials], [{ "X-Marginalia": "1" }, "no-store", "same-origin"]);
    assert.deepEqual(plain(p.D.state()), { mode: "cover", version: "0.2.0", app: false, covered: true, busy: false, forwarded: false, importing: false });
    assert.equal(await p.D.ready(), "cover");
    assert.deepEqual(p.events.map((e) => e.mode), ["checking", "cover"], "desktop:state on each change");
    const local = page({ hostname: "localhost", server: makeServer({ app: "app" }) });
    assert.equal(await local.D.start(), "cover", "localhost too");
  });

  test("404, an error, an answer that is not {ok: true, app: true}, or no answer within 3 s → \"browser\", Marginalia as before", async () => {
    for (const app of [null, 405, 500, "error", { status: 200, body: { ok: true, app: false } }, { status: 200, body: { ok: true } },
      { status: 200, body: new SyntaxError("not JSON") }, { status: 200, body: { app: true } }]) {
      const p = page({ server: makeServer({ app }) });
      assert.equal(await p.D.start(), "browser", JSON.stringify(app));
      assert.equal(p.D.covered(), false);
    }
    const slow = page({ server: makeServer({ app: "hang" }), checkMs: 40 });
    const t = Date.now();
    assert.equal(await slow.D.start(), "browser");
    assert.ok(Date.now() - t >= 35, "it waited for the check");
    const late = page({ server: makeServer({ app: "app", appDelay: 120 }), checkMs: 30 });
    assert.equal(await late.D.start(), "browser", "an answer after the time limit");
    await wait(150);
    assert.equal(late.D.mode(), "browser", "a late answer changes nothing");
  });

  test("no check at all in the app, on file://, in the claude.ai artifact, on another host or without fetch", async () => {
    for (const o of [{ protocol: "file:" }, { artifact: true }, { hostname: "example.test" }, { hostname: "192.168.1.5" }, { fetch: false }]) {
      const p = page(Object.assign({ server: makeServer({ app: "app" }) }, o));
      assert.equal(await p.D.start(), "browser", JSON.stringify(o));
      assert.deepEqual(p.server.requests, [], "no request: " + JSON.stringify(o));
    }
    const https = page({ protocol: "https:", hostname: "localhost", server: makeServer({ app: "app" }) });
    assert.equal(await https.D.start(), "cover", "https on localhost is asked too");
  });

  test("coverLink(): marginalia://open?hash=<encodeURIComponent(location.hash || \"#library\")>", () => {
    const p = page();
    assert.equal(p.D.coverLink(), "marginalia://open?hash=%23library");
    p.win.location.hash = "#reader/92b1cb87/p_3f9a";
    assert.equal(p.D.coverLink(), "marginalia://open?hash=%23reader%2F92b1cb87%2Fp_3f9a");
    assert.equal(p.D.coverLink("#deck/deck 1"), "marginalia://open?hash=%23deck%2Fdeck%201");
    assert.equal(p.D.coverLink(""), "marginalia://open?hash=%23library");
  });
});

/* ------------------------------------------------------------------ the app: every POST carries the header */

describe("app mode: \"X-Marginalia-Client: app\" on every POST to the page's own server (FEATURES E2.2a)", () => {
  async function appPage(over) {
    const p = page(Object.assign({ app: true, collections: [book("bk1"), DECK], prompts: [prompt("p_1", "bk1"), prompt("p_2", "deck_1")],
      docs: { bk1: new Uint8Array(PDF) } }, over || {}));
    await p.D.start();
    return p;
  }
  test("the daily backup, Back up now and the PDF upload", async () => {
    const p = await appPage();
    await p.B.start();                                  // the automatic backup (no file today)
    await p.B._idle();
    await p.B.runNow();                                 // Back up now
    await p.B._idle();
    const posts = p.server.posts();
    assert.deepEqual(posts.map((r) => r.url), ["/api/backup", "/api/backup/pdf", "/api/backup"]);
    assert.deepEqual(posts[0].headers, Object.assign({}, BASE_JSON, { "X-Marginalia-Client": "app" }));
    assert.deepEqual(posts[2].headers, posts[0].headers);
    assert.deepEqual(JSON.parse(posts[0].init.body).mode, "auto");
    assert.deepEqual(JSON.parse(posts[2].init.body).mode, "manual");
    assert.deepEqual(posts[1].headers, { "Content-Type": "application/pdf", "X-Marginalia": "1", "X-Marginalia-Sha256": SHA,
      "X-Marginalia-Name": "Griffiths", "X-Marginalia-Client": "app" });
  });
  test("Obsidian: POST /note (a single send), /notes (Send all) and the per-card /note of a serve.py from before /notes", async () => {
    const p = await appPage();
    const one = await p.O.send("p_1", { fromGesture: true });
    assert.equal(one.ok, true, JSON.stringify(one));
    const all = await p.O.sendAll("deck_1", { fromGesture: true });
    assert.equal(all.ok, true, JSON.stringify(all));
    const old = await appPage({ server: makeServer({ oldNotes: true }) });
    const res2 = await old.O.sendAll("deck_1", { fromGesture: true });
    assert.equal(res2.sent, 1, JSON.stringify(res2));
    const posts = p.server.posts().concat(old.server.posts());
    assert.deepEqual(posts.map((r) => r.url), ["/api/obsidian/note", "/api/obsidian/notes", "/api/obsidian/notes", "/api/obsidian/note"]);
    for (const r of posts) assert.deepEqual(r.headers, Object.assign({}, BASE_JSON, { "X-Marginalia-Client": "app" }), r.url);
    assert.deepEqual(p.opened, [], "no link");
  });
  test("elsewhere (a browser page as before) no POST carries it", async () => {
    const p = page({ collections: [book("bk1"), DECK], prompts: [prompt("p_1", "bk1"), prompt("p_2", "deck_1")], docs: { bk1: new Uint8Array(PDF) } });
    assert.equal(await p.D.start(), "browser");
    await p.B.start();
    await p.B._idle();
    await p.O.send("p_1", { fromGesture: true });
    await p.O.sendAll("deck_1", { fromGesture: true });
    const posts = p.server.posts();
    assert.deepEqual(posts.map((r) => r.url), ["/api/backup", "/api/backup/pdf", "/api/obsidian/note", "/api/obsidian/notes"]);
    for (const r of posts) assert.equal("X-Marginalia-Client" in r.headers, false, r.url);
    assert.deepEqual(posts[0].headers, BASE_JSON);
  });
});

/* ------------------------------------------------------------------ cover mode */

describe("cover mode: nothing writes but the cover's own backup (FEATURES E2.2c)", () => {
  async function coverPage(over) {
    const p = page(Object.assign({ server: makeServer({ app: "app" }), collections: [book("bk1"), DECK],
      prompts: [prompt("p_1", "bk1"), prompt("p_2", "deck_1")], docs: { bk1: new Uint8Array(PDF) } }, over || {}));
    assert.equal(await p.D.start(), "cover");
    p.server.requests.length = 0;
    return p;
  }
  test("M.backup: no daily backup, no PDF run, no restore and no write without the cover's client", async () => {
    const p = await coverPage();
    assert.equal(p.D.refusesWrite(), true);
    assert.equal(p.D.refusesWrite("app"), true);
    assert.equal(p.D.refusesWrite("browser-move"), false);
    const s = plain(await p.B.start());
    assert.equal(s.status, "checking", "start() does nothing here");
    const r = plain(await p.B.runNow());
    assert.deepEqual([r.ok, r.error], [false, "Marginalia is now an app — open it to back up"]);
    const sv = plain(await p.B.savePdfs());
    assert.deepEqual([sv.ok, sv.error], [false, "Marginalia is now an app — open it to back up"]);
    p.collections[0].hasBytes = false;
    const rs = plain(await p.B.restorePdfs());
    assert.deepEqual([rs.ok, rs.restored], [false, 0]);
    p.M.bus.emit("import:finished", { report: {}, error: null });
    await settle();
    assert.deepEqual(p.server.requests, [], "no request at all");
    assert.deepEqual(p.toasts, []);
  });
  test("the cover's backup: the JSON backup and every PDF the folder lacks, both with X-Marginalia-Client: browser-move", async () => {
    const p = await coverPage({ collections: [book("bk1"), book("bk2", { name: "Second", sha256: hashOf(Buffer.from("%PDF-2")), byteLength: 6 }), DECK],
      docs: { bk1: new Uint8Array(PDF), bk2: new Uint8Array(Buffer.from("%PDF-2")) } });
    const r = plain(await p.B.runNow({ client: "browser-move", pdfs: false }));
    assert.equal(r.ok, true, JSON.stringify(r));
    await p.B._idle();
    assert.deepEqual(p.server.posts().map((x) => x.url), ["/api/backup"], "pdfs: false sends no PDF by itself");
    const progress = [];
    const sv = plain(await p.B.savePdfs({ client: "browser-move", quiet: true, onProgress: (k, n) => progress.push([k, n]) }));
    assert.equal(sv.ok, true, JSON.stringify(sv));
    assert.deepEqual(progress, [[1, 2], [2, 2]]);
    const posts = p.server.posts();
    assert.deepEqual(posts.map((x) => x.url), ["/api/backup", "/api/backup/pdf", "/api/backup/pdf"]);
    assert.deepEqual(posts[0].headers, Object.assign({}, BASE_JSON, { "X-Marginalia-Client": "browser-move" }));
    for (const x of posts.slice(1)) assert.equal(x.headers["X-Marginalia-Client"], "browser-move");
    assert.equal(JSON.parse(posts[0].init.body).mode, "manual");
    assert.deepEqual(plain(p.B.libraryPdfs()), { books: 2, sha: 2, saved: 2 });
  });
  test("a quiet PDF run says nothing itself: the cover shows the error", async () => {
    const p = await coverPage({ server: makeServer({ app: "app", refuse: (m, u) => (u === "/api/backup/pdf" ? { status: 500, body: { ok: false, error: "disk full" } } : null) }) });
    const sv = plain(await p.B.savePdfs({ client: "browser-move", quiet: true }));
    assert.equal(sv.ok, false);
    assert.equal(sv.error, "Could not save the PDF of “Griffiths” to the backup folder — disk full");
    assert.deepEqual(p.toasts, [], "no toast");
  });
  test("M.obsidian: every send is refused with the toast, no request, no link; planAll answers covered", async () => {
    const p = await coverPage();
    const one = plain(await p.O.send("p_1", { fromGesture: true }));
    assert.deepEqual([one.ok, one.error], [false, COVERED]);
    const all = plain(await p.O.sendAll("deck_1", { fromGesture: true }));
    assert.deepEqual([all.ok, all.error, all.sent], [false, COVERED, 0]);
    const plan = plain(await p.O.planAll("deck_1"));
    assert.deepEqual([plan.ok, plan.covered, plan.error, plan.count], [false, true, COVERED, 0]);
    assert.deepEqual(p.texts(), [COVERED, COVERED], "one toast per send, planAll none");
    assert.deepEqual(p.server.requests, []);
    assert.deepEqual(p.opened, []);
    assert.equal(p.O.COVERED, COVERED);
    assert.equal(p.prompts[0].obsidianPendingFile, undefined, "nothing written ahead");
  });
  test("a send while the app check still runs waits for it: refused in cover mode, sent as before otherwise", async () => {
    const cover = page({ server: makeServer({ app: "app", appDelay: 40 }), collections: [book("bk1")], prompts: [prompt("p_1", "bk1")] });
    cover.D.start();
    assert.equal(cover.D.mode(), "checking");
    // nothing writes before the check has answered (M.backup), and a send waits for it (M.obsidian)
    assert.equal(cover.D.refusesWrite(), true);
    assert.equal(cover.D.refusesWrite("browser-move"), false);
    const early = plain(await cover.B.runNow());
    assert.deepEqual([early.ok, early.error], [false, "Marginalia is still starting — try again in a moment"]);
    const r = plain(await cover.O.send("p_1", { fromGesture: true }));
    assert.deepEqual([r.ok, r.error], [false, COVERED]);
    assert.deepEqual(cover.server.list(), ["GET /api/app"], "nothing went to Obsidian, no backup was written");
    const normal = page({ server: makeServer({ app: null, appDelay: 40 }), collections: [book("bk1")], prompts: [prompt("p_1", "bk1")] });
    normal.D.start();
    const r2 = plain(await normal.O.send("p_1", { fromGesture: true }));
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.deepEqual(normal.server.list(), ["GET /api/app", "GET /api/obsidian/vaults", "POST /api/obsidian/note"], "the check answered first");
  });
});

/* ------------------------------------------------------------------ the app's 409 "app_only" */

describe("a POST the app's server refuses (409 \"app_only\", FEATURES E2.1c) shows its message", () => {
  const refuse = (m) => (m === "POST" ? { status: 409, body: APP_ONLY } : null);
  test("Back up now, the PDF upload and the Obsidian sends", async () => {
    const p = page({ server: makeServer({ refuse }), collections: [book("bk1"), DECK], prompts: [prompt("p_1", "bk1"), prompt("p_2", "deck_1")],
      docs: { bk1: new Uint8Array(PDF) } });
    await p.D.start();
    const r = plain(await p.B.runNow());
    assert.deepEqual([r.ok, r.error], [false, APP_ONLY.message]);
    const sv = plain(await p.B.savePdfs());
    assert.equal(sv.error, "Could not save the PDF of “Griffiths” to the backup folder — " + APP_ONLY.message);
    const one = plain(await p.O.send("p_1", { fromGesture: true }));
    assert.deepEqual([one.ok, one.error], [false, APP_ONLY.message]);
    assert.ok(p.texts().includes("Could not add to Obsidian — " + APP_ONLY.message), p.texts().join(" | "));
    const all = plain(await p.O.sendAll("deck_1", { fromGesture: true }));
    assert.deepEqual(all.failed.map((f) => f.error), [APP_ONLY.message]);
  });
});

/* ------------------------------------------------------------------ GET /api/backup/latest */

describe("M.backup.latest(): GET /api/backup/latest (FEATURES E2.1d)", () => {
  test("the newest backup's text and its file name; no backup; an older server; no answer; nothing off the server", async () => {
    const srv = makeServer({ latest: { name: "sub/" + NAME(TODAY), text: "{\"format\":\"marginalia\"}" } });
    const p = page({ server: srv });
    const l = plain(await p.B.latest());
    assert.deepEqual(l, { ok: true, name: NAME(TODAY), text: "{\"format\":\"marginalia\"}" });
    assert.deepEqual([srv.requests[0].method, srv.requests[0].url, srv.requests[0].headers, srv.requests[0].init.cache], ["GET", "/api/backup/latest", { "X-Marginalia": "1" }, "no-store"]);
    const none = plain(await page().B.latest());
    assert.deepEqual([none.ok, none.none, none.error], [false, true, "there is no backup in the backup folder yet"]);
    const older = page({ server: makeServer({ refuse: (m, u) => (u === "/api/backup/latest" ? { status: 404, body: { ok: false, error: "not found" } } : null) }) });
    const o = plain(await older.B.latest());
    assert.deepEqual([o.ok, o.outdated], [false, true]);
    const down = page({ server: makeServer({ refuse: () => null }) });
    down.server.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    assert.equal(plain(await down.B.latest()).error, "Marginalia's server did not answer");
    for (const o2 of [{ artifact: true }, { protocol: "file:" }, { storeMode: "memory" }]) {
      const q = page(o2);
      assert.equal(plain(await q.B.latest()).ok, false);
      assert.deepEqual(q.server.requests, [], JSON.stringify(o2));
    }
  });
});

describe("M.backup.hasToday(): a backup of the server's today in the last listing (repair SEC-1)", () => {
  test("any listed file of today counts, not only the newest by name (a file named after today sorts first)", async () => {
    const files = (...days) => days.map((d) => ({ name: NAME(d), date: d, bytes: 10 }));
    const p = page({ server: makeServer({ files: files("2026-11-12", TODAY, "2026-11-10") }) });
    assert.equal(p.B.hasToday(), false, "nothing listed yet");
    await p.B.refresh();
    assert.equal(p.B.state().last.name, NAME("2026-11-12"), "the newest by name");
    assert.equal(p.B.hasToday(), true);
    const q = page({ server: makeServer({ files: files("2026-11-12", "2026-11-10") }) });
    await q.B.refresh();
    assert.equal(q.B.hasToday(), false);
    const r = page({ server: makeServer({ files: files(TODAY) }) });
    await r.B.refresh();
    assert.equal(r.B.hasToday(), true);
    assert.equal(page({ storeMode: "memory" }).B.hasToday(), false);
  });
});

/* ------------------------------------------------------------------ pure helpers */

describe("M.desktop._pure: the time of a backup", () => {
  test("madeAt reads exportedAt near the top of the backup; whenText and dayLabel write it as the card shows it", () => {
    const { madeAt, whenText, dayLabel, hhmm } = page().D._pure;
    assert.equal(madeAt("{\n  \"format\": \"marginalia\",\n  \"version\": 1,\n  \"exportedAt\": " + T0 + ",\n"), T0);
    assert.equal(madeAt("{\"format\":\"marginalia\"}"), null);
    assert.equal(madeAt("{" + " ".repeat(5000) + "\"exportedAt\": " + T0 + "}"), null, "only the head is read");
    assert.equal(madeAt(null), null);
    assert.equal(hhmm(new Date(2026, 10, 11, 9, 7).getTime()), "09:07");
    assert.equal(dayLabel(TODAY, T0), "today");
    assert.equal(dayLabel("2026-11-10", T0), "yesterday");
    assert.equal(dayLabel("2026-10-02", T0), "2 Oct");
    assert.equal(dayLabel("2025-12-31", T0), "31 Dec 2025");
    assert.equal(dayLabel("junk", T0), "junk");
    assert.equal(whenText(TODAY, new Date(2026, 10, 11, 9, 12).getTime()), "today, 09:12");
    assert.equal(whenText("2026-11-10", null), "yesterday");
  });
});

/* ------------------------------------------------------------------ the welcome card's data */

describe("the welcome card (FEATURES E2.2d): welcome(), importLatest(), dismissWelcome()", () => {
  const BACKUP = (at) => JSON.stringify({ format: "marginalia", version: 1, schedulerVersion: 1, exportedAt: at, scope: "all", settings: {},
    folders: [], collections: [book("bk1", { hasBytes: false })], prompts: [prompt("p_1", "bk1")], attachments: [] }, null, 2);

  test("only in the app, with no live book, deck or prompt, not dismissed", async () => {
    assert.equal(page().D.welcome(), null, "not the app");
    assert.ok(page({ app: true }).D.welcome(), "an empty library in the app");
    assert.equal(page({ app: true, collections: [book("bk1")] }).D.welcome(), null, "a book");
    assert.equal(page({ app: true, collections: [DECK] }).D.welcome(), null, "a deck");
    assert.equal(page({ app: true, prompts: [prompt("p_1", "gone")] }).D.welcome(), null, "a prompt");
    assert.ok(page({ app: true, collections: [book("bk1", { deletedAt: T0 })], prompts: [prompt("p_1", "bk1", { deletedAt: T0 })] }).D.welcome(), "tombstones only");
    const st = makeStorage();
    st.map.set("marginalia.welcomeDismissed", "1");
    assert.equal(page({ app: true, storage: st }).D.welcome(), null, "dismissed");
  });

  test("the newest backup: its date at once, then its time from the backup itself; \"checking\" before the listing", async () => {
    const at = new Date(2026, 10, 11, 9, 12).getTime();
    const srv = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 1234 }], latest: { name: NAME(TODAY), text: BACKUP(at) } });
    const p = page({ app: true, server: srv });
    await p.D.start();
    assert.deepEqual(plain(p.D.welcome()), { last: null, at: null, when: null, status: "checking", error: null, importing: false });
    await p.B.start();
    await settle();
    assert.deepEqual(plain(p.D.welcome()), { last: { name: NAME(TODAY), date: TODAY, bytes: 1234 }, at, when: "today, 09:12", status: "on", error: null, importing: false });
    assert.deepEqual(srv.list(), ["GET /api/backup", "GET /api/backup/latest"], "one GET of the newest backup for its time");
    // the window back in front: the folder asked again, and the time too (a same-size backup made meanwhile in Brave)
    const later = new Date(2026, 10, 11, 14, 1).getTime();
    srv.latest = { name: NAME(TODAY), text: BACKUP(later) };
    p.win.dispatchEvent({ type: "focus" });
    await settle();
    assert.equal(p.D.welcome().when, "today, 14:01");
    const n = srv.requests.length;
    p.win.dispatchEvent({ type: "focus" });                // at most every 2 s
    await settle();
    assert.equal(srv.requests.length, n);
    const none = page({ app: true });
    await none.D.start();
    await none.B.start();
    assert.deepEqual(plain(none.D.welcome()).last, null);
    assert.equal(none.D.welcome().status, "on", "no backup yet");
    assert.deepEqual(none.server.list(), ["GET /api/backup"], "no GET of the newest backup when there is none");
  });

  test("importLatest(): the newest backup through M.exporter.importJSON with restoreSettings, then the API key reminder", async () => {
    const srv = makeServer({ latest: { name: NAME(TODAY), text: BACKUP(T0) } });
    const p = page({ app: true, server: srv });
    await p.D.start();
    const calls = [];
    p.M.exporter.importJSON = (text, o) => { calls.push({ text, o: plain(o) }); p.collections.push(book("bk1", { hasBytes: false })); return Promise.resolve({ added: 1 }); };
    const r = plain(await p.D.importLatest());
    assert.deepEqual(r, { ok: true, report: { added: 1 }, error: null });
    assert.deepEqual(calls, [{ text: BACKUP(T0), o: { restoreSettings: true } }]);
    assert.deepEqual(p.texts(), [KEY_REMINDER]);
    assert.equal(p.toasts[0].id, "desktop-key");
    assert.equal(p.D.welcome(), null, "the library holds a book now: no card");
    assert.deepEqual(p.events.slice(-2).map((e) => e.importing), [true, false]);
  });

  test("an import that cannot go toasts why, and the card stays", async () => {
    const p = page({ app: true });
    await p.D.start();
    const r = plain(await p.D.importLatest());
    assert.deepEqual([r.ok, r.error], [false, "there is no backup in the backup folder yet"]);
    assert.deepEqual(p.texts(), ["Could not import the newest backup — there is no backup in the backup folder yet"]);
    assert.ok(p.D.welcome(), "the card stays");
    const bad = page({ app: true, server: makeServer({ latest: { name: NAME(TODAY), text: "{\"format\":\"other\"}" } }) });
    await bad.D.start();
    const r2 = plain(await bad.D.importLatest());
    assert.equal(r2.error, "it is not a Marginalia backup");
    assert.deepEqual(bad.texts(), ["Could not import the newest backup — it is not a Marginalia backup"]);
    assert.equal(plain(await page().D.importLatest()).error, "the welcome card is only in the Marginalia app");
  });

  test("dismissWelcome(): localStorage \"marginalia.welcomeDismissed\" = \"1\"; a storage that refuses still hides it in this page", () => {
    const p = page({ app: true });
    assert.equal(p.D.dismissWelcome(), true);
    assert.equal(p.storage.getItem("marginalia.welcomeDismissed"), "1");
    assert.equal(p.D.welcome(), null);
    assert.equal(p.D.WELCOME_KEY, "marginalia.welcomeDismissed");
    const full = page({ app: true, storage: makeStorage(true) });
    full.D.dismissWelcome();
    assert.equal(full.D.welcome(), null);
  });
});

/* ------------------------------------------------------------------ index.html and the stylesheets */

describe("index.html and css/desktop.css (FEATURES E2.2; BUILD-NOTES \"CSS ownership\")", () => {
  const ROOT = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const css = strip(fs.readFileSync(path.join(ROOT, "css", "desktop.css"), "utf8"));
  const appCss = strip(fs.readFileSync(path.join(ROOT, "css", "app.css"), "utf8"));
  const libCss = strip(fs.readFileSync(path.join(ROOT, "css", "library.css"), "utf8"));
  const rule = (src, sel) => {
    const m = new RegExp("(^|\\})\\s*" + sel.replace(/[.#]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(src);
    return m ? m[2] : null;
  };
  const z = (body) => Number((/z-index:\s*(\d+)/.exec(body || "") || [])[1]);

  test("the page links css/desktop.css last, holds the #cover host (hidden) and loads js/desktop.js right before js/app.js", () => {
    const links = Array.from(html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g), (m) => m[1]).filter((h) => !/^https:/.test(h));
    assert.deepEqual(links, ["styles.css", "css/app.css", "css/library.css", "css/reader.css", "css/margin.css", "css/editor.css",
      "css/list.css", "css/review.css", "css/snip.css", "css/stats.css", "css/tabs.css", "css/desktop.css"]);
    assert.match(html, /<div id="cover" class="is-hidden"><\/div>/);
    assert.ok(html.indexOf('id="cover"') > html.indexOf('id="confirm"') && html.indexOf('id="cover"') < html.indexOf('id="fileInput"'));
    const scripts = Array.from(html.matchAll(/<script src="js\/([a-z]+)\.js"><\/script>/g), (m) => m[1]);
    assert.deepEqual(scripts.slice(-4), ["library", "tabs", "desktop", "app"]);   // js/tabs.js (D30) after the library, before the desktop module
  });

  test("#cover covers the whole page, opaque, above the ? sheet and below the confirm dialog, the toasts and #tabLock", () => {
    const host = rule(css, "#cover");
    assert.ok(host, "#cover rule");
    assert.match(host, /position:\s*fixed/);
    assert.match(host, /inset:\s*0/);
    assert.match(host, /background:\s*var\(--bg\)/, "opaque: nothing of the page shows through");
    assert.ok(z(host) > z(rule(appCss, "#shortcuts")), "above the ? sheet");
    for (const sel of ["#confirm", "#toasts", "#tabLock"]) assert.ok(z(host) < z(rule(appCss, sel)), "below " + sel);
    assert.match(rule(css, "#cover.is-hidden") || "", /display:\s*none/);
  });

  test("the cover and the welcome card take their colours from the tokens, so both themes restyle them", () => {
    for (const sel of [".cover__panel", ".cover__title", ".cover__text", ".cover__steps", ".cover__status", ".cover__note", ".cover__error"]) {
      const body = rule(css, sel);
      assert.ok(body, sel);
      assert.doesNotMatch(body, /#[0-9a-f]{3,6}\b/i, sel + " has no fixed colour");
    }
    assert.match(rule(css, ".cover__panel"), /background:\s*var\(--surface\)/);
    assert.match(rule(css, ".cover__error"), /color:\s*var\(--danger\)/);
    for (const sel of [".lib-welcome", ".lib-welcome__title", ".lib-welcome__steps", ".lib-welcome__actions", ".lib-welcome__none"]) {
      const body = rule(libCss, sel);
      assert.ok(body, sel);
      assert.doesNotMatch(body, /#[0-9a-f]{3,6}\b/i, sel + " has no fixed colour");
    }
    assert.match(rule(libCss, ".lib-welcome"), /background:\s*var\(--surface\)/);
  });
});
