"use strict";
// test/backup.test.js — M.backup (js/backup.js; BUILD-NOTES "Automatic backup"): the page's half of the daily backup
// that Marginalia's own server writes into a folder in Documents. Run from the app folder: node --test
//
// Each test is a fresh page: a vm context running the real util, bus, settings, scheduler, prompts, context, exporter
// and backup modules, with M.store / M.cache / M.app stubs, a fake localStorage (shared between "reloads"), a fake
// document for visibilitychange, and a fake server in place of fetch (M.backup._setFetch), so nothing here reaches a
// network, a server or a folder. The clock (_setNow) and the hourly timer (_setTimers) are injected too.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const JS = path.join(__dirname, "..", "js");
const MODULES = ["util", "bus", "settings", "scheduler", "prompts", "context", "exporter", "backup"];
const HOUR = 60 * 60 * 1000;
const TODAY = "2026-11-09";
const T0 = new Date(2026, 10, 9, 10, 0, 0).getTime();          // 10:00 local time on TODAY
const DIR = "~/Documents/Marginalia Backups";
const NAME = (day) => "marginalia-backup-" + day + ".json";
const OTHER_TAB = "Marginalia is open in another tab";

const BOOK = { id: "book_1", kind: "book", name: "Griffiths", title: "Introduction to Quantum Mechanics", fileName: "griffiths.pdf",
  sha256: "9f2a", hashAlgo: "sha-256", byteLength: 52428800, chunkCount: 7, chunkSize: 8388608, hasBytes: true, pageCount: 322,
  pageLabels: null, sections: [], addedAt: T0, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 };
const DECK = { id: "deck_1", kind: "deck", name: "Thermo", description: "", sections: [], addedAt: T0, lastOpenedAt: T0,
  updatedAt: T0, deletedAt: null, v: 1 };
const PROMPT = { id: "p_1", collectionId: "book_1", kind: "qa", text: "Q. What is $\\hbar$?\nA. $h / 2\\pi$", tags: [], flagged: false,
  anchor: null, context: { docName: "Griffiths", sectionLabel: null, pageIndex: 11, pageLabel: "12" },
  cards: [{ i: 0, createdAt: T0, lastReviewedAt: null, intervalMs: 432000000, dueAt: T0 + 432000000, log: [] }],
  dueAt: T0 + 432000000, createdAt: T0, contentUpdatedAt: T0, updatedAt: T0, deletedAt: null, v: 1 };

const clone = (x) => JSON.parse(JSON.stringify(x));
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));   // vm-realm objects → plain ones
const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
async function settle(n) { for (let i = 0; i < (n || 12); i++) await new Promise((r) => setImmediate(r)); }

function eventTarget(obj) {
  obj._listeners = {};
  obj.addEventListener = (t, fn) => { (obj._listeners[t] = obj._listeners[t] || []).push(fn); };
  obj.removeEventListener = (t, fn) => { const l = obj._listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  obj.dispatchEvent = (ev) => { (obj._listeners[ev && ev.type] || []).slice().forEach((fn) => fn.call(obj, ev)); return true; };
  return obj;
}

function makeStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}
// A full localStorage (the origin is at its quota): reads and removeItem work, every setItem throws QuotaExceededError.
// memoRaw: what "marginalia.backup" already holds (null: nothing).
function fullStorage(memoRaw) {
  const s = makeStorage();
  if (memoRaw != null) s.map.set("marginalia.backup", memoRaw);
  s.refused = [];
  s.setItem = (k) => {
    s.refused.push(k);
    const e = new Error("Failed to execute 'setItem' on 'Storage': Setting the value of '" + k + "' exceeded the quota.");
    e.name = "QuotaExceededError";
    throw e;
  };
  return s;
}

function res(status, json) { return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(json) }; }
const newestFirst = (a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);

// A stand-in for tools/serve.py's /api/backup (FEATURES B2/B3): the folder is a list in memory.
function makeServer(over) {
  const srv = Object.assign({
    today: TODAY, dir: DIR, files: [], requests: [], writes: [],
    getStatus: 200, getBody: null, postStatus: 200, postBody: null,
    down: false, postDown: false, hold: null, inflight: 0, maxInflight: 0
  }, over || {});
  srv.fetch = function (url, init) {
    init = init || {};
    const method = String(init.method || "GET").toUpperCase();
    srv.requests.push({ url: String(url), method, init });
    if (srv.down) return Promise.reject(new TypeError("Failed to fetch"));
    if (/^\/api\/backup\/pdfs?(\/|$)/.test(String(url))) return pdfRoute(srv, String(url), method, init);
    if (method === "GET") {
      if (srv.getStatus !== 200) return Promise.resolve(res(srv.getStatus, srv.getBody || { ok: false, error: "not found" }));
      const files = srv.files.filter((f) => !(srv.hideToday && f.name === NAME(srv.today))).sort(newestFirst);
      return Promise.resolve(res(200, { ok: true, dir: srv.dir, today: srv.today, files }));
    }
    if (srv.postDown) return Promise.reject(new TypeError("Failed to fetch"));
    srv.inflight++;
    srv.maxInflight = Math.max(srv.maxInflight, srv.inflight);
    const answer = () => {
      srv.inflight--;
      if (srv.postStatus !== 200) return res(srv.postStatus, srv.postBody || { ok: false, error: "refused" });
      const body = JSON.parse(init.body);
      const name = NAME(srv.today);
      const old = srv.files.filter((f) => f.name === name)[0];
      if (body.mode === "auto" && old) return res(200, { ok: true, skipped: true, file: name, bytes: old.bytes, pruned: [] });
      const bytes = Buffer.byteLength(init.body);
      srv.writes.push({ name, mode: body.mode, backup: body.backup, bytes });
      const all = srv.files.filter((f) => f.name !== name).concat([{ name, date: srv.today, bytes }]).sort(newestFirst);
      srv.files = all.slice(0, 30);
      return res(200, { ok: true, file: (srv.filePrefix || "") + name, bytes, skipped: false, pruned: all.slice(30).map((f) => f.name) });
    };
    return srv.hold ? srv.hold.then(answer) : Promise.resolve().then(answer);
  };
  srv.posts = () => srv.requests.filter((r) => r.method === "POST" && r.url === "/api/backup");
  srv.gets = () => srv.requests.filter((r) => r.method === "GET");
  srv.pdfRequests = () => srv.requests.filter((r) => /^\/api\/backup\/pdf/.test(r.url)).map((r) => r.method + " " + r.url);
  return srv;
}

// FEATURES B9 (tools/serve.py, build-server SERVER-NOTES): GET /api/backup/pdfs, POST /api/backup/pdf (the body's SHA-256
// must be the header's and it must hold "%PDF-" in its first 1 KB; one content is saved once, "<name> [<sha12>].pdf"),
// GET /api/backup/pdf/<sha256>. srv.pdfs is the PDFs folder: {sha12, name, bytes, body}, the sha12 from the name, so an
// entry whose body hashes otherwise is a saved PDF changed after it was saved (repair B9-R2): the listing still lists it
// (by name), a GET never sends it and names it in the 404's "changed", and a POST of that PDF sets it aside (srv.aside,
// "<name minus .pdf> (changed).pdf", the answer's "setAside") before it saves the PDF. Knobs: pdfsStatus/pdfsBody (the
// listing), pdfRefuse(name, sha256) → {status, body} | null, pdfPostDown (no answer to a POST), pdfHold (a promise each
// POST answer waits for), onPdfGet(sha256) (called as a GET of a PDF's bytes arrives).
const hashOf = (b) => crypto.createHash("sha256").update(b).digest("hex");
function pdfRoute(srv, url, method, init) {
  srv.pdfs = srv.pdfs || [];
  if (url === "/api/backup/pdfs" && method === "GET") {
    if (srv.pdfsStatus && srv.pdfsStatus !== 200) return Promise.resolve(res(srv.pdfsStatus, srv.pdfsBody || { ok: false, error: "not found" }));
    const files = srv.pdfs.map((f) => ({ sha12: f.sha12, name: f.name, bytes: f.bytes })).sort((a, b) => (a.name < b.name ? -1 : 1));
    return Promise.resolve(res(200, { ok: true, dir: srv.dir, files }));
  }
  if (url === "/api/backup/pdf" && method === "POST") {
    if (srv.pdfPostDown) return Promise.reject(new TypeError("Failed to fetch"));
    srv.pdfInflight = (srv.pdfInflight || 0) + 1;
    srv.pdfMaxInflight = Math.max(srv.pdfMaxInflight || 0, srv.pdfInflight);
    const answer = () => {
      srv.pdfInflight--;
      const h = init.headers || {}, sha = String(h["X-Marginalia-Sha256"] || ""), name = decodeURIComponent(String(h["X-Marginalia-Name"] || ""));
      const body = Buffer.from(init.body);
      const refused = srv.pdfRefuse ? srv.pdfRefuse(name, sha) : null;
      if (refused) return res(refused.status, refused.body);
      if (hashOf(body) !== sha) return res(400, { ok: false, error: "the body's SHA-256 is not the one X-Marginalia-Sha256 names" });
      if (!body.subarray(0, 1024).includes("%PDF-")) return res(400, { ok: false, error: "the body is not a PDF (no %PDF- within its first 1 KB)" });
      // verified_pdf: only a saved PDF that holds this very PDF counts; one changed after it was saved is set aside
      const setAside = [];
      let old = null;
      for (const f of srv.pdfs.filter((x) => x.sha12 === sha.slice(0, 12))) {
        const held = hashOf(f.body);
        if (held === sha) old = old || f;
        else if (held.slice(0, 12) !== f.sha12) {
          const as = f.name.slice(0, -".pdf".length) + " (changed).pdf";
          srv.pdfs.splice(srv.pdfs.indexOf(f), 1);
          (srv.aside = srv.aside || []).push(Object.assign({}, f, { name: as }));
          setAside.push({ name: f.name, as });
        }
      }
      const more = setAside.length ? { setAside } : {};
      if (old) return res(200, Object.assign({ ok: true, file: old.name, bytes: old.bytes, skipped: true }, more));
      const file = name + " [" + sha.slice(0, 12) + "].pdf";
      srv.pdfs.push({ sha12: sha.slice(0, 12), sha256: sha, name: file, bytes: body.length, body });
      return res(200, Object.assign({ ok: true, file, bytes: body.length, skipped: false }, more));
    };
    return srv.pdfHold ? srv.pdfHold.then(answer) : Promise.resolve().then(answer);
  }
  const m = /^\/api\/backup\/pdf\/([0-9a-fA-F]{64})$/.exec(url);
  if (m && method === "GET") {
    const want = m[1].toLowerCase(), changed = [];
    if (srv.onPdfGet) srv.onPdfGet(want);
    for (const f of srv.pdfs.filter((x) => x.sha12 === want.slice(0, 12))) {
      if (hashOf(f.body) !== want) { changed.push(f.name); continue; }
      const bytes = srv.pdfBody ? srv.pdfBody(f) : f.body;
      return Promise.resolve({ ok: true, status: 200, headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? String(bytes.length) : null) },
        json: () => Promise.reject(new SyntaxError("not JSON")), arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes).buffer) });
    }
    return Promise.resolve(res(404, Object.assign({ ok: false, error: "no saved PDF has that SHA-256" }, changed.length ? { changed } : {})));
  }
  return Promise.resolve(res(404, { ok: false, error: "not found" }));
}

// One page. opts: {server, storage, collections, prompts, protocol, hostname, artifact, storeMode, fetch: false}
function makeEnv(opts) {
  opts = opts || {};
  const env = {
    server: opts.server || makeServer(), storage: opts.storage || makeStorage(), clock: T0, lock: null, onPrepare: null,
    collections: clone(opts.collections || [BOOK]), prompts: clone(opts.prompts || [PROMPT]),
    toasts: [], events: [], intervals: [], cleared: [], prepared: [], logs: []
  };
  const doc = eventTarget({ visibilityState: "visible", hidden: false });
  const hostname = opts.hostname || "127.0.0.1", protocol = opts.protocol || "http:";
  const win = {
    console: { log() {}, info() {}, debug() {}, warn: (...a) => env.logs.push(a.join(" ")), error: (...a) => env.logs.push(a.join(" ")) },
    setTimeout: (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a)), clearTimeout, queueMicrotask,
    setInterval: () => { throw new Error("M.backup must use the injected timers"); }, clearInterval: () => {},
    document: doc, localStorage: env.storage,
    location: protocol === "file:" ? { protocol, hostname: "", host: "", origin: "null", href: "file:///Users/me/marginalia.html" }
      : { protocol, hostname, host: hostname + ":8765", origin: protocol + "//" + hostname + ":8765", href: protocol + "//" + hostname + ":8765/" }
  };
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  for (const name of MODULES) vm.runInContext(fs.readFileSync(path.join(JS, name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const M = win.Marginalia;
  // the store's documents: env.docs (id → bytes) for M.store.docs.loadBytes, or the real js/store.js (memory backend,
  // its 8 MiB chunks) with opts.realStore; the cache's records are env.collections / env.prompts (an import writes there)
  env.docs = new Map(Object.entries(opts.docs || {}));
  env.loads = [];
  let docs = { loadBytes: (id) => { env.loads.push(id); return Promise.resolve(env.docs.has(id) ? env.docs.get(id) : null); } };
  if (opts.realStore) {
    vm.runInContext(fs.readFileSync(path.join(JS, "store.js"), "utf8"), ctx, { filename: "js/store.js" });
    env.realStore = M.store;
    docs = { loadBytes: (id) => { env.loads.push(id); return env.realStore.docs.loadBytes(id); } };
  }
  M.store = { mode: () => opts.storeMode || "idb", locked: () => env.lock, attachments: { get: () => Promise.resolve(null) }, docs };
  const put = (list, r) => { const i = list.findIndex((x) => x.id === r.id); if (i >= 0) list[i] = r; else list.push(r); return Promise.resolve(r); };
  M.cache = {
    collections: () => env.collections, prompts: () => env.prompts,
    collection: (id) => env.collections.find((c) => c.id === id) || null,
    prompt: (id) => env.prompts.find((p) => p.id === id) || null,
    saveCollection: (c) => put(env.collections, c), savePrompt: (p) => put(env.prompts, p)
  };
  // M.library.attachPdf (FEATURES B9.5) as js/library.js answers it: env.attach(id, u8) → a record, or throws {code}
  env.attached = [];
  if (opts.library !== false) {
    M.library = { attachPdf: (id, u8) => {
      env.attached.push({ id, bytes: Buffer.from(u8) });
      try { return Promise.resolve(env.attach ? env.attach(id, u8) : Object.assign(M.cache.collection(id), { hasBytes: true })); }
      catch (e) { return Promise.reject(e); }
    } };
  }
  M.app = { isArtifact: () => !!opts.artifact, toast: (o) => { env.toasts.push(o); return { close() {} }; } };
  const prepare = M.exporter.prepare;                         // the manual JSON backup's call, recorded
  M.exporter.prepare = function (format, o) {
    const p = prepare.apply(this, arguments);
    env.prepared.push({ format, opts: plain(o), result: p });
    return Promise.resolve(p).then((out) => { if (env.onPrepare) env.onPrepare(out); return out; });
  };
  M.bus.on("backup:state", (s) => env.events.push(plain(s)));
  if (opts.fetch !== false) M.backup._setFetch(env.server.fetch);
  M.backup._setNow(() => env.clock);
  M.backup._setTimers({
    setInterval: (fn, ms) => { env.intervals.push({ fn, ms }); return env.intervals.length; },
    clearInterval: (id) => { env.cleared.push(id); }
  });
  return Object.assign(env, {
    win, doc, M, B: M.backup,
    state: () => plain(M.backup.state()),
    // the hourly timer fires
    async tick(ms) { env.clock += ms == null ? HOUR : ms; env.intervals[env.intervals.length - 1].fn(); await settle(); },
    // the tab is hidden or shown again
    async show(vis, ms) {
      env.clock += ms || 0;
      doc.visibilityState = vis; doc.hidden = vis !== "visible";
      doc.dispatchEvent({ type: "visibilitychange" });
      await settle();
    },
    memo: () => { const raw = env.storage.getItem("marginalia.backup"); return raw == null ? null : JSON.parse(raw); }
  });
}

describe("M.backup", () => {
  test("start() on Marginalia's server: one GET, then one automatic backup built by the manual JSON backup's exporter call", async () => {
    const env = makeEnv();
    const s = plain(await env.B.start());
    const reqs = env.server.requests;
    assert.deepEqual(reqs.map((r) => r.method + " " + r.url), ["GET /api/backup", "POST /api/backup"]);
    assert.deepEqual([reqs[0].init.headers["X-Marginalia"], reqs[0].init.cache, reqs[0].init.credentials], ["1", "no-store", "same-origin"]);
    const post = reqs[1].init;
    assert.deepEqual(plain(post.headers), { "Content-Type": "application/json", "X-Marginalia": "1" });
    assert.deepEqual([post.cache, post.credentials], ["no-store", "same-origin"]);
    const body = JSON.parse(post.body);
    assert.deepEqual(Object.keys(body), ["mode", "backup"]);
    assert.equal(body.mode, "auto");
    // the same call as Settings › Data › Export… with the JSON backup (scope everything, images included)
    assert.equal(env.prepared.length, 1);
    assert.deepEqual([env.prepared[0].format, env.prepared[0].opts], ["json", { scope: "all", collectionId: null, includeImages: true }]);
    const out = await env.prepared[0].result;
    assert.deepEqual(body.backup, JSON.parse(out.text), "the POSTed backup is exactly the manual JSON backup");
    assert.equal(body.backup.format, "marginalia");
    assert.deepEqual(body.backup.collections.map((c) => c.id), ["book_1"]);
    assert.deepEqual(body.backup.prompts.map((p) => p.id), ["p_1"]);
    assert.equal(body.backup.collections[0].chunkCount, undefined, "no PDF bytes or chunk fields");
    assert.deepEqual(env.server.writes.map((w) => [w.name, w.mode]), [[NAME(TODAY), "auto"]]);
    assert.deepEqual(s, {
      status: "on", dir: DIR, today: TODAY, last: { name: NAME(TODAY), date: TODAY, bytes: env.server.writes[0].bytes },
      error: null, running: false, reason: null, enabled: true, pdfs: null
    });
    assert.deepEqual(env.state(), s);
    assert.deepEqual(env.toasts, [], "a backup that worked says nothing");
    assert.deepEqual(env.intervals.map((t) => t.ms), [HOUR], "one hourly re-check");
    assert.equal(env.B.HOUR_MS, HOUR);
    assert.equal(env.doc._listeners.visibilitychange.length, 1);
  });

  test("skips when the server already lists today's file; a file of another day does not count", async () => {
    const env = makeEnv({ server: makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 1234 }] }) });
    const s = plain(await env.B.start());
    assert.deepEqual(env.server.requests.map((r) => r.method), ["GET"]);
    assert.equal(env.prepared.length, 0, "nothing built");
    assert.deepEqual([s.status, s.last], ["on", { name: NAME(TODAY), date: TODAY, bytes: 1234 }]);

    const other = makeEnv({ server: makeServer({ files: [{ name: NAME("2026-11-08"), date: "2026-11-08", bytes: 99 },
      { name: "notes.txt", date: TODAY, bytes: 1 }, { name: "marginalia-backup-2026-11-09.json.bak", date: TODAY, bytes: 2 }] }) });
    const s2 = plain(await other.B.start());
    assert.deepEqual(other.server.requests.map((r) => r.method), ["GET", "POST"]);
    assert.equal(s2.last.name, NAME(TODAY));
  });

  test("an empty library is never backed up, nor one holding only tombstones; a deck alone is", async () => {
    const tombBook = Object.assign({}, BOOK, { deletedAt: T0 }), tombPrompt = Object.assign({}, PROMPT, { deletedAt: T0 });
    for (const lib of [{ collections: [], prompts: [] }, { collections: [tombBook], prompts: [tombPrompt] }]) {
      const env = makeEnv(lib);
      const s = plain(await env.B.start());
      assert.deepEqual(env.server.requests.map((r) => r.method), ["GET"], JSON.stringify(lib));
      assert.equal(s.status, "on");
      assert.equal(env.prepared.length, 0);
      const r = plain(await env.B.runNow());
      assert.equal(r.ok, false);
      assert.match(r.error, /library is empty/);
      assert.equal(env.server.posts().length, 0, "Back up now refuses too: it would replace today's file with nothing");
      assert.deepEqual(env.toasts, []);
      assert.equal(env.memo(), null, "not a failure");
    }
    const deck = makeEnv({ collections: [DECK], prompts: [] });
    await deck.B.start();
    assert.deepEqual(deck.server.requests.map((r) => r.method), ["GET", "POST"]);
  });

  test("a tab that stepped aside for a newer tab (M.store.locked()) asks and sends nothing", async () => {
    const env = makeEnv();
    env.lock = { reason: "othertab", by: "tab_b", at: 1 };
    await env.B.start();
    assert.deepEqual(env.server.requests, []);
    assert.deepEqual(env.intervals, [], "no timer");
    const r = plain(await env.B.runNow());
    assert.deepEqual([r.ok, r.error], [false, OTHER_TAB]);
    assert.deepEqual(env.server.requests, []);
    assert.equal(env.B.setEnabled(false), false, "settings are not written in a locked tab");
    assert.equal(env.M.settings.get("autoBackup"), true);

    // locked after start: store:mode "othertab" stops the hourly timer and the visibility check
    const later = makeEnv({ server: makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }] }) });
    await later.B.start();
    assert.equal(later.server.requests.length, 1);
    later.lock = { reason: "othertab", by: "tab_b", at: 2 };
    later.M.bus.emit("store:mode", { mode: "idb", reason: "othertab", message: OTHER_TAB, by: "tab_b" });
    assert.deepEqual(later.cleared, [1]);
    assert.equal((later.doc._listeners.visibilitychange || []).length, 0);
    await later.tick();
    await later.show("visible", 2 * 60 * 1000);
    assert.equal(later.server.requests.length, 1);

    // locked while the backup was being built: it is not sent, and that is no failure
    const during = makeEnv();
    during.onPrepare = () => { during.lock = { reason: "othertab", by: "tab_c", at: 3 }; };
    await during.B.start();
    assert.deepEqual(during.server.requests.map((r) => r.method), ["GET"]);
    assert.deepEqual(during.toasts, []);
    assert.equal(during.memo(), null);
  });

  test("an older server (404, 405 or 501 on 127.0.0.1 or localhost) is 'outdated'; on any other host it is 'unavailable'", async () => {
    for (const status of [404, 405, 501]) {
      for (const hostname of ["127.0.0.1", "localhost"]) {
        const env = makeEnv({ hostname, server: makeServer({ getStatus: status, postStatus: status }) });
        const s = plain(await env.B.start());
        assert.deepEqual([s.status, s.reason, s.dir, s.today, s.last], ["outdated", "outdated", null, null, null], status + " " + hostname);
        assert.deepEqual(env.server.requests.map((r) => r.method), ["GET"]);
        const r = plain(await env.B.runNow());
        assert.equal(r.ok, false);
        assert.match(r.error, /restart Marginalia \(marginalia restart in Terminal\)/);
        assert.equal(env.state().status, "outdated");
      }
    }
    const elsewhere = makeEnv({ hostname: "marginalia.example", server: makeServer({ getStatus: 404 }) });
    const s = plain(await elsewhere.B.start());
    assert.deepEqual([s.status, s.reason], ["unavailable", "no_server"]);

    // after "marginalia restart" the hourly check finds the new server and backs up
    const env = makeEnv({ server: makeServer({ getStatus: 404 }) });
    await env.B.start();
    assert.equal(env.state().status, "outdated");
    env.server.getStatus = 200;
    await env.tick();
    assert.equal(env.state().status, "on");
    assert.deepEqual(env.server.writes.map((w) => w.mode), ["auto"]);
  });

  test("no server: a network error re-checks every hour; file://, the artifact, memory mode and no fetch never ask", async () => {
    const env = makeEnv({ server: makeServer({ down: true }) });
    const s = plain(await env.B.start());
    assert.deepEqual([s.status, s.reason, s.error], ["unavailable", "no_server", "Marginalia's server did not answer"]);
    assert.deepEqual(env.server.requests.map((r) => r.method), ["GET"]);
    assert.deepEqual(env.toasts, [], "no server is no failure");
    assert.equal(env.intervals.length, 1, "it asks again every hour");
    env.server.down = false;
    await env.tick();
    assert.equal(env.state().status, "on");
    assert.deepEqual(env.server.requests.map((r) => r.method), ["GET", "GET", "POST"]);

    for (const [opts, reason] of [[{ protocol: "file:" }, "file"], [{ artifact: true }, "artifact"], [{ storeMode: "memory" }, "memory"], [{ fetch: false }, "no_fetch"]]) {
      const page = makeEnv(opts);
      const st = plain(await page.B.start());
      assert.deepEqual([st.status, st.reason], ["unavailable", reason], reason);
      assert.equal(typeof st.error, "string");
      assert.deepEqual(page.server.requests, [], reason + ": no request");
      assert.deepEqual(page.intervals, [], reason + ": no timer");
      assert.equal((page.doc._listeners.visibilitychange || []).length, 0, reason + ": no listener");
      const r = plain(await page.B.runNow());
      assert.equal(r.ok, false);
      assert.deepEqual(page.server.requests, [], reason + ": Back up now asks nothing either");
      assert.deepEqual(plain(await page.B.refresh()).status, "unavailable");
      assert.deepEqual(page.server.requests, []);
    }
    const artifact = makeEnv({ artifact: true });
    assert.equal(plain(await artifact.B.runNow()).error, "not available in the claude.ai copy");
  });

  test("re-checks every hour: the same day only asks, the next day backs up again", async () => {
    const env = makeEnv();
    await env.B.start();
    assert.deepEqual(env.server.requests.map((r) => r.method), ["GET", "POST"]);
    await env.tick();
    assert.deepEqual(env.server.requests.map((r) => r.method), ["GET", "POST", "GET"], "today's file exists");
    env.server.today = "2026-11-10";
    await env.tick(14 * HOUR);
    assert.deepEqual(env.server.requests.map((r) => r.method), ["GET", "POST", "GET", "GET", "POST"]);
    assert.deepEqual(env.server.writes.map((w) => [w.name, w.mode]), [[NAME(TODAY), "auto"], [NAME("2026-11-10"), "auto"]]);
    const s = env.state();
    assert.deepEqual([s.today, s.last.name], ["2026-11-10", NAME("2026-11-10")]);
  });

  test("re-checks when the tab is shown again, at most once a minute", async () => {
    const env = makeEnv({ server: makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }] }) });
    await env.B.start();
    assert.equal(env.server.gets().length, 1);
    await env.show("hidden", 5 * 60 * 1000);
    assert.equal(env.server.gets().length, 1, "hidden: nothing");
    await env.show("visible", 30 * 1000);
    assert.equal(env.server.gets().length, 2, "shown again");
    await env.show("visible", 30 * 1000);
    assert.equal(env.server.gets().length, 2, "not twice within a minute");
    env.server.today = "2026-11-10";
    await env.show("visible", 61 * 1000);
    assert.deepEqual(env.server.requests.map((r) => r.method), ["GET", "GET", "GET", "POST"]);
    assert.deepEqual(env.server.writes.map((w) => w.name), [NAME("2026-11-10")]);
  });

  test("a failed automatic backup toasts once and is not tried again that day, not even after a reload", async () => {
    const storage = makeStorage();
    const server = makeServer({ postStatus: 500, postBody: { ok: false, error: "the backup folder is not writable" } });
    const env = makeEnv({ storage, server });
    await env.B.start();
    assert.equal(server.posts().length, 1);
    assert.equal(env.toasts.length, 1);
    const t = env.toasts[0];
    assert.equal(t.text, "Automatic backup failed — the backup folder is not writable");
    assert.equal(t.id, "backup");
    assert.deepEqual(Array.from(t.actions, (a) => a.label), ["Try again"]);
    assert.deepEqual([env.state().status, env.state().error], ["on", "the backup folder is not writable"]);
    assert.deepEqual(env.memo(), { day: TODAY, error: "the backup folder is not writable" });
    // the hourly and the visibility re-checks of that day ask, but neither build nor send nor toast again
    await env.tick();
    await env.show("visible", 2 * 60 * 1000);
    await env.tick();
    assert.equal(server.gets().length, 4);
    assert.equal(server.posts().length, 1, "no retry loop");
    assert.equal(env.prepared.length, 1);
    assert.equal(env.toasts.length, 1, "one failure toast a day");

    // a reload (the same localStorage): it asks, says why, and tries nothing
    const again = makeEnv({ storage, server });
    const s = plain(await again.B.start());
    assert.deepEqual([s.status, s.error], ["on", "the backup folder is not writable"]);
    assert.equal(server.posts().length, 1);
    assert.deepEqual(again.toasts, []);

    // the next day it tries once more (and toasts once more)
    server.today = "2026-11-10";
    await again.tick(14 * HOUR);
    assert.equal(server.posts().length, 2);
    assert.equal(again.toasts.length, 1);
    assert.deepEqual(again.memo(), { day: "2026-11-10", error: "the backup folder is not writable" });
    await again.tick();
    assert.equal(server.posts().length, 2);

    // "Try again" is Back up now: once the folder is writable it writes today's file and forgets the failure
    server.postStatus = 200;
    again.toasts[0].actions[0].run();
    await settle();
    assert.deepEqual(server.writes.map((w) => [w.name, w.mode]), [[NAME("2026-11-10"), "manual"]]);
    assert.deepEqual(again.toasts.slice(1).map((t) => t.text),
      ["Backing up…", "Backed up · " + DIR + "/" + NAME("2026-11-10") + " (" + again.M.util.fmtBytes(server.writes[0].bytes) + ")"]);
    assert.ok(again.toasts.every((t) => t.id === "backup"), "one toast slot: each replaces the one before");
    assert.equal(again.memo(), null);
    assert.deepEqual([again.state().status, again.state().error, again.state().last.name], ["on", null, NAME("2026-11-10")]);
  });

  test("a POST that gets no answer is that day's failure too: no retry loop once the server answers again", async () => {
    const server = makeServer({ postDown: true });
    const env = makeEnv({ server });
    await env.B.start();
    assert.equal(env.toasts.length, 1);
    assert.equal(env.toasts[0].text, "Automatic backup failed — Marginalia's server did not answer");
    assert.deepEqual([env.state().status, env.state().reason], ["unavailable", "no_server"]);
    server.postDown = false;
    await env.tick();
    assert.deepEqual([env.state().status, env.state().error], ["on", "Marginalia's server did not answer"]);
    assert.equal(server.requests.filter((r) => r.method === "POST").length, 1, "the POST that failed is the only one");
    assert.equal(env.toasts.length, 1);
    // a failure toast's "Try again" that fails again says so (a user action, not the daily toast)
    server.postStatus = 507;
    server.postBody = { ok: false, error: "no space left on the disk" };
    env.toasts[0].actions[0].run();
    await settle();
    assert.deepEqual(env.toasts.slice(1).map((t) => t.text), ["Backing up…", "Backup failed — no space left on the disk"]);
  });

  test("storage that refuses today's record: one attempt and one toast that day, also when it still holds an older day's record or a value that is no record", async () => {
    const ERR = "could not write the backup: No space left on device";
    for (const [label, stored] of [
      ["nothing stored", null],
      ["an older day's record", JSON.stringify({ day: "2026-11-05", error: "the server answered 500" })],
      ["a value that is no record", "{oops"]
    ]) {
      const storage = fullStorage(stored);
      const server = makeServer({ postStatus: 500, postBody: { ok: false, error: ERR } });
      const env = makeEnv({ storage, server });
      await env.B.start();
      for (let i = 0; i < 3; i++) await env.tick();                          // the hourly re-checks
      for (let i = 0; i < 3; i++) await env.show("visible", 2 * 60 * 1000);  // the tab shown again
      assert.equal(server.gets().length, 7, label + ": every check asks");
      assert.equal(server.posts().length, 1, label + ": no retry loop");
      assert.equal(env.prepared.length, 1, label + ": the backup is built once");
      assert.deepEqual(env.toasts.map((t) => t.text), ["Automatic backup failed — " + ERR], label + ": one failure toast a day");
      assert.deepEqual([env.state().status, env.state().error], ["on", ERR], label + ": the state says why");
      assert.ok(storage.refused.includes("marginalia.backup"), label + ": storage refused today's record");
      assert.equal(storage.getItem("marginalia.backup"), stored, label + ": storage still holds what it held");

      // the next day it tries once more, and once only
      server.today = "2026-11-10";
      await env.tick(14 * HOUR);
      await env.tick();
      await env.show("visible", 2 * 60 * 1000);
      assert.equal(server.posts().length, 2, label + ": one attempt the next day");
      assert.equal(env.toasts.length, 2, label + ": one toast the next day");

      // "Try again" that works forgets the failure, in memory and in storage
      server.postStatus = 200;
      env.toasts[1].actions[0].run();
      await settle();
      assert.deepEqual(server.writes.map((w) => [w.name, w.mode]), [[NAME("2026-11-10"), "manual"]], label);
      assert.equal(storage.getItem("marginalia.backup"), null, label + ": the stored value is removed");
      assert.deepEqual([env.state().status, env.state().error], ["on", null], label);
      await env.tick();
      assert.equal(server.posts().length, 3, label + ": today's file exists, so nothing more");
    }
  });

  test("setEnabled(false) turns the daily backup off; setEnabled(true) turns it on and backs up at once", async () => {
    const env = makeEnv();
    assert.equal(env.B.setEnabled(false), true);
    assert.equal(env.M.settings.get("autoBackup"), false);
    const s = plain(await env.B.start());
    assert.deepEqual([s.status, s.enabled], ["off", false]);
    await env.tick();
    assert.deepEqual(env.server.requests.map((r) => r.method), ["GET", "GET"], "off: it asks, it never sends");
    assert.equal(env.B.setEnabled(true), true);
    assert.equal(env.state().status, "on");
    await settle();
    assert.deepEqual(env.server.requests.map((r) => r.method), ["GET", "GET", "GET", "POST"]);
    assert.deepEqual(env.server.writes.map((w) => w.mode), ["auto"]);
    // M.settings.set from anywhere (Settings › Data's switch) works the same way
    assert.equal(env.M.settings.set("autoBackup", false), true);
    assert.deepEqual([env.state().status, env.state().enabled], ["off", false]);
    const off = env.events[env.events.length - 1];
    assert.deepEqual([off.status, off.enabled], ["off", false], "backup:state says so");
    assert.equal(JSON.parse(env.storage.getItem("marginalia.settings")).autoBackup, false, "remembered");
  });

  test("runNow() backs up now in manual mode (today's file replaced, also while off), returns errors and never toasts", async () => {
    const server = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }] });
    const env = makeEnv({ server });
    env.B.setEnabled(false);
    await env.B.start();
    const r = plain(await env.B.runNow());
    assert.deepEqual(r, { ok: true, file: NAME(TODAY), bytes: server.writes[0].bytes, skipped: false, error: null });
    assert.deepEqual(server.writes.map((w) => w.mode), ["manual"]);
    assert.equal(JSON.parse(server.posts()[0].init.body).mode, "manual");
    assert.deepEqual(server.files.map((f) => f.name), [NAME(TODAY)], "replaced, not added");
    assert.equal(env.state().last.bytes, server.writes[0].bytes);
    assert.equal(env.state().status, "off");

    for (const [status, body, want] of [
      [400, { ok: false, error: "that is not a Marginalia backup" }, "that is not a Marginalia backup"],
      [413, { ok: false, error: "too large" }, "the backup is larger than 512 MB"],
      [500, null, "refused"],
      [500, { ok: false }, "the server answered 500"]
    ]) {
      server.postStatus = status;
      server.postBody = body;                                  // null: the stand-in's own refusal, "refused"
      const e = plain(await env.B.runNow());
      assert.deepEqual([e.ok, e.error], [false, want], String(status));
    }
    server.postStatus = 200;
    server.postDown = true;
    assert.equal(plain(await env.B.runNow()).error, "Marginalia's server did not answer");
    assert.deepEqual(env.toasts, [], "the caller (Settings › Data) toasts the result");
    assert.equal(env.memo(), null, "Back up now never marks the day as failed");

    // without any earlier answer (the page started while the server was down) it still works, and learns the folder
    const late = makeEnv({ server: makeServer({ down: true }) });
    await late.B.start();
    late.server.down = false;
    const ok = plain(await late.B.runNow());
    assert.equal(ok.ok, true);
    await settle();
    assert.deepEqual([late.state().status, late.state().dir, late.state().today], ["on", DIR, TODAY]);
  });

  test("the POST's answer: a skipped automatic backup is done, not failed; a path is cut to the file's name; 30 are kept", async () => {
    // another page of this server wrote today's file between this page's GET and its POST
    const server = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 777 }], hideToday: true });
    const env = makeEnv({ server });
    await env.B.start();
    assert.deepEqual(server.requests.map((r) => r.method), ["GET", "POST"]);
    assert.deepEqual(server.writes, [], "mode auto never replaces today's file");
    assert.deepEqual([env.state().status, env.state().error, env.state().last], ["on", null, { name: NAME(TODAY), date: TODAY, bytes: 777 }]);
    assert.deepEqual(env.toasts, []);
    assert.equal(env.memo(), null);

    const days = [];
    for (let d = 1; d <= 30; d++) days.push("2026-10-" + String(d).padStart(2, "0"));
    const full = makeServer({ files: days.map((d) => ({ name: NAME(d), date: d, bytes: 1 })), filePrefix: DIR + "/" });
    const page = makeEnv({ server: full });
    await page.B.start();
    assert.deepEqual(full.writes.map((w) => w.name), [NAME(TODAY)]);
    assert.equal(full.files.length, 30, "the stand-in pruned the oldest");
    assert.equal(page.state().last.name, NAME(TODAY), "a path in the answer is cut to the file's name");
    const r = plain(await page.B.runNow());
    assert.equal(r.file, NAME(TODAY));
  });

  test("one backup at a time: Back up now during the automatic backup waits for it", async () => {
    let release;
    const server = makeServer({ hold: new Promise((r) => { release = r; }) });
    const env = makeEnv({ server });
    const first = env.B.start();
    await settle();
    assert.equal(server.posts().length, 1);
    assert.equal(env.state().running, true);
    const manual = env.B.runNow();
    await settle();
    assert.equal(server.posts().length, 1, "the manual backup waits");
    release();
    await first;
    const r = plain(await manual);
    assert.equal(r.ok, true);
    assert.deepEqual(server.writes.map((w) => w.mode), ["auto", "manual"]);
    assert.equal(server.maxInflight, 1);
    assert.equal(env.state().running, false);
  });

  test("backup:state carries state() on every change, and nothing when nothing changed", async () => {
    const env = makeEnv({ server: makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }] }) });
    await env.B.start();
    assert.equal(env.events[0].status, "checking");
    for (const e of env.events) assert.deepEqual(Object.keys(e).sort(), ["dir", "enabled", "error", "last", "pdfs", "reason", "running", "status", "today"]);
    assert.deepEqual(env.events[env.events.length - 1], env.state());
    const n = env.events.length;
    await env.tick();
    assert.equal(env.events.length, n, "the same answer: no event");
    env.B.setEnabled(false);
    assert.equal(env.events.length, n + 1);
    assert.deepEqual([env.events[n].status, env.events[n].enabled], ["off", false]);
    const runs = makeEnv();
    await runs.B.start();
    assert.deepEqual(runs.events.map((e) => e.running).filter((v, i, a) => i === 0 || v !== a[i - 1]), [false, true, false], "running while it backs up");
  });

  test("the request never holds the API key; a backup that would hold it (typed into a prompt) is not sent", async () => {
    const KEY = "sk-ant-api03-" + "Zq9_x-".repeat(15);
    const env = makeEnv();
    env.M.settings.apiKey.set(KEY);
    await env.B.start();
    assert.equal(env.server.posts().length, 1);
    for (const r of env.server.requests) {
      const seen = JSON.stringify({ url: r.url, init: r.init });
      assert.equal(seen.includes(KEY) || seen.includes("Zq9_x-Zq9_x-"), false, "no API key in " + r.method);
    }
    assert.equal(JSON.stringify(JSON.parse(env.server.posts()[0].init.body).backup.settings).includes("apiKey"), false);

    const leaky = makeEnv({ prompts: [Object.assign({}, PROMPT, { text: "Q. Which key did I make?\nA. " + KEY })] });
    leaky.M.settings.apiKey.set(KEY);
    await leaky.B.start();
    assert.equal(leaky.server.posts().length, 0, "not sent");
    assert.equal(leaky.toasts.length, 1);
    assert.match(leaky.toasts[0].text, /a prompt holds your Anthropic API key/);
    const said = JSON.stringify([leaky.toasts.map((t) => t.text), leaky.state(), leaky.memo(), leaky.events, leaky.logs]);
    assert.equal(said.includes(KEY), false, "the key is in no toast, state, event, memo or log");
    assert.equal(plain(await leaky.B.runNow()).ok, false);
    assert.equal(leaky.server.posts().length, 0);
    leaky.M.settings.apiKey.forget();
    assert.equal(plain(await leaky.B.runNow()).ok, true, "a forgotten key no longer blocks it");
  });

  test("a backup above the server's 512 MB limit is not sent", async () => {
    const env = makeEnv({ server: makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }] }) });
    await env.B.start();
    env.M.exporter.prepare = () => Promise.resolve({ text: "{}", bytes: 513 * 1024 * 1024, filename: "x.json", mime: "application/json" });
    const r = plain(await env.B.runNow());
    assert.deepEqual([r.ok, r.error], [false, "the backup is larger than 512 MB"]);
    assert.equal(env.server.posts().length, 0);
    env.M.exporter.prepare = () => Promise.reject(new Error("IndexedDB read failed"));
    assert.equal(plain(await env.B.runNow()).error, "unexpected error (IndexedDB read failed)");
  });

  test("a server that answers the GET with an error is 'unavailable' in its own words until it answers again", async () => {
    const server = makeServer({ getStatus: 500, getBody: { ok: false, error: "cannot list the backup folder" } });
    const env = makeEnv({ server });
    const s = plain(await env.B.start());
    assert.deepEqual([s.status, s.reason, s.error], ["unavailable", "server", "cannot list the backup folder"]);
    assert.equal(server.posts().length, 0);
    server.getStatus = 200;
    await env.tick();
    assert.deepEqual([env.state().status, env.state().error], ["on", null]);
    assert.equal(server.posts().length, 1);
  });

  test("start() twice keeps one timer; refresh() asks without backing up; _reset() stops everything", async () => {
    const env = makeEnv({ server: makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }] }) });
    await env.B.start();
    await env.B.start();
    assert.equal(env.intervals.length, 1);
    env.server.files = [];
    const s = plain(await env.B.refresh());
    assert.deepEqual([s.status, s.last], ["on", null]);
    assert.equal(env.server.posts().length, 0, "refresh() never backs up");
    env.B._reset();
    assert.deepEqual(env.cleared, [1]);
    assert.equal((env.doc._listeners.visibilitychange || []).length, 0);
    assert.deepEqual(env.state(), { status: "checking", dir: null, today: null, last: null, error: null, running: false, reason: null, enabled: true, pdfs: null });
    const n = env.server.requests.length;
    await env.show("visible", 10 * 60 * 1000);
    assert.equal(env.server.requests.length, n);
  });
});

// ------------------------------------------------------------------ FEATURES B9: the PDFs, the page's half

// A small PDF (or `size` bytes of one) whose content `tag` makes unique, and its SHA-256.
function pdfBytes(tag, size) {
  const head = Buffer.from("%PDF-1.7\n% " + tag + "\n");
  const buf = Buffer.alloc(Math.max(size || 0, head.length + 16), 0x20);
  head.copy(buf, 0);
  buf.write("\n%%EOF\n", buf.length - 7);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}
const shaHex = (u8) => crypto.createHash("sha256").update(Buffer.from(u8)).digest("hex");
const bookOf = (id, name, u8, extra) => Object.assign({}, BOOK, { id, name, sha256: shaHex(u8), hashAlgo: "sha-256", byteLength: u8.length, hasBytes: true }, extra || {});
const savedAs = (name, u8) => ({ sha12: shaHex(u8).slice(0, 12), sha256: shaHex(u8), name: name + " [" + shaHex(u8).slice(0, 12) + "].pdf", bytes: u8.length, body: Buffer.from(u8) });
const PDF_POST = "POST /api/backup/pdf", PDF_LIST = "GET /api/backup/pdfs";

describe("M.backup: the PDFs (FEATURES B9.4–B9.7)", () => {
  test("after the daily backup only the PDFs the folder does not hold go, read from the store's chunks, one at a time", async () => {
    const A = pdfBytes("A"), B = pdfBytes("B", 9 * 1024 * 1024 + 123), C = pdfBytes("C: Quantum/Mechanics..  2e");
    const books = [bookOf("bA", "Alpha", A), bookOf("bB", "Big book", B), bookOf("bC", "Griffiths: Quantum/Mechanics..  2e", C),
      bookOf("bD", "No bytes here", pdfBytes("D"), { hasBytes: false }), bookOf("bE", "Old hash", pdfBytes("E"), { sha256: "a1b2c3d4e5f60718", hashAlgo: "fnv1a" }),
      bookOf("bF", "Deleted", pdfBytes("F"), { deletedAt: T0 }), DECK];
    // A is in the folder already, under the name it had then (a renamed book makes no second copy)
    const server = makeServer({ pdfs: [savedAs("Alpha, first edition", A)] });
    const env = makeEnv({ server, realStore: true, collections: books });
    await env.realStore.open();
    for (const [c, u8] of [[books[0], A], [books[1], B], [books[2], C], [books[5], pdfBytes("F")]]) await env.realStore.docs.saveDocument(c, u8);
    assert.equal(Math.ceil(B.length / env.realStore.CHUNK_SIZE), 2, "B is stored in two chunks");
    await env.B.start();
    await env.B._idle();
    assert.deepEqual(server.requests.filter((r) => !/pdf/.test(r.url)).map((r) => r.method + " " + r.url), ["GET /api/backup", "POST /api/backup"]);
    // the restore at start lists the folder (bD has no bytes here, and its PDF is not saved), then the uploads
    assert.deepEqual(server.pdfRequests(), [PDF_LIST, PDF_LIST, PDF_POST, PDF_POST]);
    const posts = server.requests.filter((r) => r.method + " " + r.url === PDF_POST);
    assert.deepEqual(posts.map((r) => r.init.headers["X-Marginalia-Sha256"]), [shaHex(B), shaHex(C)], "only B and C, in the library's order");
    assert.ok(Buffer.from(posts[0].init.body).equals(Buffer.from(B)), "B's two chunks, joined, are the body");
    assert.ok(Buffer.from(posts[1].init.body).equals(Buffer.from(C)));
    assert.deepEqual(plain(posts[1].init.headers), { "Content-Type": "application/pdf", "X-Marginalia": "1", "X-Marginalia-Sha256": shaHex(C),
      "X-Marginalia-Name": encodeURIComponent("Griffiths: Quantum/Mechanics..  2e") });
    assert.deepEqual([posts[1].init.cache, posts[1].init.credentials], ["no-store", "same-origin"]);
    assert.deepEqual(env.loads, ["bB", "bC"], "the bytes of the books that go, read one at a time");
    assert.equal(server.pdfMaxInflight, 1, "one PDF at a time");
    assert.deepEqual(server.pdfs.map((f) => f.name), ["Alpha, first edition [" + shaHex(A).slice(0, 12) + "].pdf",
      "Big book [" + shaHex(B).slice(0, 12) + "].pdf", "Griffiths: Quantum/Mechanics..  2e [" + shaHex(C).slice(0, 12) + "].pdf"]);
    assert.deepEqual(env.state().pdfs, { saved: 3, bytes: A.length + B.length + C.length, dir: DIR, running: false, left: 0, error: null, outdated: false });
    assert.deepEqual(env.toasts, [], "nothing to say");
    const pdfEvents = env.events.map((e) => e.pdfs).filter(Boolean);
    assert.deepEqual(pdfEvents.filter((p) => p.running).map((p) => p.left).filter((v, i, a) => i === 0 || v !== a[i - 1]), [0, 2, 1, 0], "running, with the books left");
    // B9.7: the daily backup lists every book's sha256, so the server keeps these PDFs while a kept backup lists them
    const backup = server.writes[0].backup;
    for (const c of books.filter((x) => x.kind === "book")) assert.equal(backup.collections.find((x) => x.id === c.id).sha256, c.sha256, c.id);
    // the same day again: no backup written, so no PDF request; Back up now sends only what is missing (nothing)
    await env.tick();
    assert.equal(server.pdfRequests().length, 4);
    assert.equal(plain(await env.B.runNow()).ok, true);
    await env.B._idle();
    assert.deepEqual(server.pdfRequests().slice(4), [PDF_LIST], "Back up now looks, and finds nothing missing");
  });

  test("an automatic backup the server skipped sends no PDF; Back up now does, also while the switch is off", async () => {
    const X = pdfBytes("X");
    const server = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }] });
    const env = makeEnv({ server, collections: [bookOf("bX", "X", X)], docs: { bX: X } });
    await env.B.start();
    await env.B._idle();
    assert.deepEqual(server.pdfRequests(), []);
    env.B.setEnabled(false);
    await env.B.runNow();
    await env.B._idle();
    assert.deepEqual(server.pdfRequests(), [PDF_LIST, PDF_POST]);
    assert.equal(env.state().pdfs.saved, 1);
  });

  test("a tab that stepped aside sends no PDF, also when it steps aside between two; the claude.ai copy, file:// and memory mode never ask", async () => {
    const X = pdfBytes("X"), Y = pdfBytes("Y");
    const env = makeEnv({ collections: [bookOf("bX", "X", X), bookOf("bY", "Y", Y)], docs: { bX: X, bY: Y } });
    // the tab steps aside while the first PDF's request is answered
    env.server.pdfRefuse = () => { env.lock = { reason: "othertab", by: "tab_b", at: 1 }; return null; };
    await env.B.start();
    await env.B._idle();
    assert.deepEqual(env.server.pdfRequests(), [PDF_LIST, PDF_POST], "the second PDF stays home");
    assert.deepEqual([env.toasts.length, env.state().pdfs.error], [0, null], "stepping aside is no failure");
    const s = plain(await env.B.savePdfs());
    assert.deepEqual([s.ok, s.error], [false, OTHER_TAB]);
    assert.equal(plain(await env.B.restorePdfs()).error, OTHER_TAB);
    assert.equal(env.server.pdfRequests().length, 2);

    for (const opts of [{ artifact: true }, { protocol: "file:" }, { storeMode: "memory" }]) {
      const page = makeEnv(Object.assign({ collections: [bookOf("bX", "X", X), bookOf("bZ", "Z", pdfBytes("Z"), { hasBytes: false })], docs: { bX: X } }, opts));
      await page.B.start();
      assert.equal(plain(await page.B.savePdfs()).ok, false, JSON.stringify(opts));
      assert.equal(plain(await page.B.restorePdfs()).ok, false);
      await page.B.runNow();
      await page.B._idle();
      assert.deepEqual([page.server.requests, page.attached], [[], []], JSON.stringify(opts));
      assert.equal(page.state().pdfs, null);
    }
  });

  test("a PDF the server refuses is noted once and the next one still goes; no answer ends the run; nothing is tried again before the next backup", async () => {
    const X = pdfBytes("X"), Y = pdfBytes("Y"), Z = pdfBytes("Z");
    const server = makeServer();
    server.pdfRefuse = (name) => (name === "Xenon" ? { status: 409, body: { ok: false, error: "Xenon [" + shaHex(X).slice(0, 12) + "].pdf in the backup folder's PDFs folder is not a saved PDF" } } : null);
    const env = makeEnv({ server, collections: [bookOf("bX", "Xenon", X), bookOf("bY", "Yttrium", Y), bookOf("bZ", "Zinc", Z)], docs: { bX: X, bY: Y, bZ: Z } });
    await env.B.start();
    await env.B._idle();
    assert.deepEqual(server.pdfRequests(), [PDF_LIST, PDF_POST, PDF_POST, PDF_POST]);
    assert.deepEqual(server.pdfs.map((f) => f.name.split(" ")[0]), ["Yttrium", "Zinc"]);
    const said = "Could not save the PDF of “Xenon” to the backup folder — Xenon [" + shaHex(X).slice(0, 12) + "].pdf in the backup folder's PDFs folder is not a saved PDF";
    assert.deepEqual(env.toasts.map((t) => [t.id, t.text, (t.actions || []).length]), [["backup-pdfs", said, 0]], "one toast for the run");
    assert.equal(env.state().pdfs.error, said);
    assert.equal(env.state().error, null, "the JSON backup itself worked");
    // the hour after: no backup written, no PDF tried
    await env.tick();
    await env.show("visible", 2 * 60 * 1000);
    await env.B._idle();
    assert.equal(server.pdfRequests().length, 4);
    // no answer: the run stops at the first PDF
    server.pdfRefuse = null;
    server.pdfPostDown = true;
    server.pdfs = [];
    await env.B.runNow();
    await env.B._idle();
    assert.deepEqual(server.pdfRequests().slice(4), [PDF_LIST, PDF_POST], "nothing after a request with no answer");
    assert.equal(env.toasts[env.toasts.length - 1].text, "Could not save the PDF of “Xenon” to the backup folder — Marginalia's server did not answer");
    assert.equal(env.toasts.length, 2);
    // the next day's backup tries again, and a run that saves everything clears the note
    server.pdfPostDown = false;
    server.today = "2026-11-10";
    await env.tick(24 * HOUR);
    await env.B._idle();
    assert.deepEqual(server.pdfs.map((f) => f.name.split(" ")[0]).sort(), ["Xenon", "Yttrium", "Zinc"]);
    assert.equal(env.state().pdfs.error, null);
    assert.equal(env.toasts.length, 2);
  });

  test("an older serve.py without PDF backups: nothing is sent, nothing toasted, and state() says to restart it", async () => {
    const X = pdfBytes("X");
    const server = makeServer({ pdfsStatus: 404 });
    const env = makeEnv({ server, collections: [bookOf("bX", "X", X)], docs: { bX: X } });
    await env.B.start();
    await env.B._idle();
    assert.deepEqual(server.pdfRequests(), [PDF_LIST]);
    assert.deepEqual(env.toasts, []);
    assert.deepEqual(env.state().pdfs, { saved: null, bytes: null, dir: DIR, running: false, left: 0, error: null, outdated: true });
    assert.equal(plain(await env.B.savePdfs()).error, "Marginalia's server cannot save PDFs yet — restart Marginalia (marginalia restart in Terminal)");
    // restarted: Settings' refresh() lists them again
    server.pdfsStatus = 200;
    const s = plain(await env.B.refresh());
    assert.deepEqual([s.pdfs.outdated, s.pdfs.saved], [false, 0]);
  });

  test("at start, a book without its bytes whose PDF the folder holds gets it back through M.library.attachPdf; one toast", async () => {
    const R = pdfBytes("R"), Q = pdfBytes("Q"), N = pdfBytes("N");
    const books = [bookOf("bR", "Restored", R, { hasBytes: false }), bookOf("bQ", "Also restored", Q, { hasBytes: false }),
      bookOf("bN", "Not saved", N, { hasBytes: false }), bookOf("bG", "Gone", pdfBytes("G"), { hasBytes: false, deletedAt: T0 })];
    const server = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }], pdfs: [savedAs("Restored", R), savedAs("Also restored", Q), savedAs("Gone", pdfBytes("G"))] });
    const env = makeEnv({ server, collections: books });
    await env.B.start();
    await env.B._idle();
    assert.deepEqual(server.pdfRequests(), [PDF_LIST, "GET /api/backup/pdf/" + shaHex(R), "GET /api/backup/pdf/" + shaHex(Q)],
      "only the live books the folder holds; nothing for the one it does not");
    assert.deepEqual(env.attached.map((a) => a.id), ["bR", "bQ"]);
    assert.ok(env.attached[0].bytes.equals(Buffer.from(R)), "the saved bytes, as they are");
    assert.deepEqual(env.toasts.map((t) => [t.id, t.text, t.detail || null]), [["backup-restore", "Restored 2 PDFs from your backup folder", null]]);
    assert.deepEqual(books.map((c) => env.M.cache.collection(c.id).hasBytes), [true, true, false, false]);
    // started again with nothing to restore: not even a listing
    const again = makeEnv({ server, collections: env.collections });
    const before = server.pdfRequests().length;
    await again.B.start();
    await again.B._idle();
    assert.equal(server.pdfRequests().length, before + 1, "only the listing: bN is still missing");
    assert.deepEqual(again.toasts, []);
    const none = makeEnv({ server: makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }] }), collections: [BOOK] });
    await none.B.start();
    await none.B._idle();
    assert.deepEqual(none.server.pdfRequests(), [], "no book without its bytes: no request");
  });

  test("a restore the library refuses is named in the toast; a server error or no library restores nothing quietly", async () => {
    const R = pdfBytes("R"), W = pdfBytes("W");
    const server = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }], pdfs: [savedAs("R", R), savedAs("W", W)] });
    const env = makeEnv({ server, collections: [bookOf("bR", "Right", R, { hasBytes: false }), bookOf("bW", "Wrong", W, { hasBytes: false })] });
    env.attach = (id) => {
      if (id === "bW") throw Object.assign(new Error("The PDF is not this book's file (its SHA-256 differs)"), { code: "mismatch" });
      return Object.assign(env.M.cache.collection(id), { hasBytes: true });
    };
    await env.B.start();
    await env.B._idle();
    assert.deepEqual(env.toasts.map((t) => [t.text, t.detail]), [["Restored 1 PDF from your backup folder",
      "“Wrong” could not be restored — it is not this book's file (its SHA-256 differs). Choose file again in the library adds it by hand."]]);
    env.toasts.length = 0;
    const r = plain(await env.B.restorePdfs());
    assert.deepEqual([r.restored, r.failed.map((f) => f.collectionId)], [0, ["bW"]]);
    assert.deepEqual(env.toasts.map((t) => t.text), ["Could not restore the PDF of “Wrong” from your backup folder — it is not this book's file (its SHA-256 differs)"]);
    // the library is busy adding a PDF: skipped, nothing said, tried again next time
    env.toasts.length = 0;
    env.attach = () => { throw Object.assign(new Error("Another PDF is being added"), { code: "busy" }); };
    assert.equal(plain(await env.B.restorePdfs()).failed.length, 0);
    assert.deepEqual(env.toasts, []);
    // a folder the server cannot read: nothing, quietly
    server.pdfsStatus = 500; server.pdfsBody = { ok: false, error: "could not read the backup folder" };
    const n = server.pdfRequests().length;
    assert.equal(plain(await env.B.restorePdfs()).restored, 0);
    assert.deepEqual([server.pdfRequests().length, env.toasts.length], [n + 1, 0]);
    // no M.library.attachPdf (an older bundle): no request at all
    const bare = makeEnv({ server, collections: env.collections, library: false });
    await bare.B.start();
    await bare.B._idle();
    assert.equal(server.pdfRequests().length, n + 1);
  });

  test("after an Import, the books it brought take their PDFs from the folder (the real importJSON; import:finished)", async () => {
    const R = pdfBytes("R");
    const server = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }], pdfs: [savedAs("Restored", R)] });
    const env = makeEnv({ server, collections: [DECK], prompts: [] });
    await env.B.start();
    await env.B._idle();
    assert.deepEqual(server.pdfRequests(), [], "nothing to restore at start");
    const theirs = bookOf("bR", "Restored", R, { hasBytes: true, chunkCount: 1, chunkSize: 8388608 });
    const text = JSON.stringify({ format: "marginalia", version: 1, schedulerVersion: 1, exportedAt: T0, scope: "all", settings: {},
      folders: [], collections: [theirs], prompts: [Object.assign({}, PROMPT, { collectionId: "bR" })], attachments: [] });
    const report = plain(await env.M.exporter.importJSON(text));
    assert.equal(report.collections.added, 1);
    await env.B._idle();
    assert.deepEqual(server.pdfRequests(), [PDF_LIST, "GET /api/backup/pdf/" + shaHex(R)]);
    assert.deepEqual(env.attached.map((a) => a.id), ["bR"]);
    assert.equal(env.toasts[env.toasts.length - 1].text, "Restored 1 PDF from your backup folder");
    // a tab that stepped aside restores nothing after an import
    env.collections.find((c) => c.id === "bR").hasBytes = false;
    env.lock = { reason: "othertab", by: "tab_b", at: 1 };
    env.M.bus.emit("import:finished", { report: null, error: null });
    await env.B._idle();
    assert.equal(server.pdfRequests().length, 2);
  });

  // repair B9-R2: a saved PDF opened and saved in another app (Preview saving highlights into it) keeps its name, so
  // the listing still lists it, but it no longer holds the book's PDF
  const changedCopy = (name, u8, body) => Object.assign(savedAs(name, u8), { bytes: body.length, body: Buffer.from(body) });
  test("a saved PDF changed after it was saved (no longer the book's size) is sent again; the server sets it aside and the listing follows", async () => {
    const A = pdfBytes("A"), G = pdfBytes("G: Thermodynamics"), K = pdfBytes("K");
    const edited = Buffer.concat([Buffer.from(G), Buffer.from("4 0 obj << /Type /Annot /Subtype /Highlight >> endobj\n%%EOF\n")]);
    // Alpha's file is as it was saved; Gamma's was changed; so was Kappa's, but its record (from before byteLength)
    // cannot tell, so its sha12 alone counts, as before
    const server = makeServer({ pdfs: [savedAs("Alpha", A), changedCopy("Gamma", G, edited), changedCopy("Kappa", K, Buffer.concat([Buffer.from(K), Buffer.from("x")]))] });
    const kappa = bookOf("bK", "Kappa", K);
    delete kappa.byteLength;
    const env = makeEnv({ server, collections: [bookOf("bA", "Alpha", A), bookOf("bG", "Gamma", G), kappa], docs: { bA: A, bG: G, bK: K } });
    await env.B.start();
    await env.B._idle();
    assert.deepEqual(server.pdfRequests(), [PDF_LIST, PDF_POST], "only Gamma goes");
    assert.equal(server.requests.find((r) => r.method + " " + r.url === PDF_POST).init.headers["X-Marginalia-Sha256"], shaHex(G));
    const gname = "Gamma [" + shaHex(G).slice(0, 12) + "].pdf";
    assert.deepEqual(server.aside.map((f) => [f.name, f.body.equals(edited)]), [[gname.slice(0, -4) + " (changed).pdf", true]], "the changes are kept aside");
    assert.ok(server.pdfs.find((f) => f.name === gname).body.equals(Buffer.from(G)), "the book's own PDF is in its place");
    // the page's listing drops the file set aside and takes the PDF with its size
    assert.deepEqual(env.state().pdfs, { saved: 3, bytes: A.length + G.length + K.length + 1, dir: DIR, running: false, left: 0, error: null, outdated: false });
    assert.deepEqual(env.toasts, []);
    await env.B.runNow();
    await env.B._idle();
    assert.deepEqual(server.pdfRequests().slice(2), [PDF_LIST], "Back up now finds nothing missing any more");
  });

  test("a restore whose saved copy was changed after it was saved fails out loud, naming that file; so does one gone meanwhile", async () => {
    const R = pdfBytes("R"), C = pdfBytes("C");
    const server = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }],
      pdfs: [savedAs("Restored", R), changedCopy("Changed", C, Buffer.concat([Buffer.from(C), Buffer.from("% a highlight\n")]))] });
    const env = makeEnv({ server, collections: [bookOf("bR", "Restored", R, { hasBytes: false }), bookOf("bC", "Changed", C, { hasBytes: false })] });
    await env.B.start();
    await env.B._idle();
    const why = "its saved copy “Changed [" + shaHex(C).slice(0, 12) + "].pdf” was changed after it was saved, so it is not this book's file any more";
    assert.deepEqual(server.pdfRequests(), [PDF_LIST, "GET /api/backup/pdf/" + shaHex(R), "GET /api/backup/pdf/" + shaHex(C)]);
    assert.deepEqual(env.attached.map((a) => a.id), ["bR"], "nothing is attached from the changed file");
    assert.deepEqual(env.toasts.map((t) => [t.id, t.text, t.detail]), [["backup-restore", "Restored 1 PDF from your backup folder",
      "“Changed” could not be restored — " + why + ". Choose file again in the library adds it by hand."]]);
    env.toasts.length = 0;
    assert.deepEqual(plain(await env.B.restorePdfs()), { ok: false, restored: 0, failed: [{ collectionId: "bC", name: "Changed", error: why }], error: why });
    assert.deepEqual(env.toasts.map((t) => [t.text, t.detail]), [["Could not restore the PDF of “Changed” from your backup folder — " + why,
      "Choose file again in the library adds it by hand."]]);
    assert.equal(env.M.cache.collection("bC").hasBytes, false);
    // listed, then gone before its GET (deleted by hand, or pruned by another browser's backup): said too
    const V = pdfBytes("V");
    const gone = makeServer({ files: [{ name: NAME(TODAY), date: TODAY, bytes: 5 }], pdfs: [savedAs("Vanishing", V)] });
    gone.onPdfGet = () => { gone.pdfs = []; };
    const page = makeEnv({ server: gone, collections: [bookOf("bV", "Vanishing", V, { hasBytes: false })] });
    await page.B.start();
    await page.B._idle();
    assert.deepEqual(page.toasts.map((t) => t.text), ["Could not restore the PDF of “Vanishing” from your backup folder — its saved copy is no longer in the backup folder"]);
  });
});
