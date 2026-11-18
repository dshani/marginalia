"use strict";
// test/tabs.test.js — one writing Marginalia tab per origin (js/store.js, js/cache.js, js/app.js #tabLock).
// Run: node --test test/tabs.test.js
//
// Regression for "Open in Marginalia opens a second tab, and the older tab's next save silently reverts edits made
// in the new one": every tab of an origin shares one IndexedDB database, but each keeps its own in-memory copy
// (M.cache) and writes whole records from it. Each "tab" here is a vm context running the REAL modules on ONE fake
// IndexedDB of the origin (the idb backend of js/store.js drives it), with a BroadcastChannel hub and a localStorage
// (with storage events) that the origin's tabs share. Nothing here opens a URI, starts a server or touches a vault.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS = path.join(__dirname, "..", "js");
const DATA_MODULES = ["util", "bus", "store", "scheduler", "prompts", "context", "cache"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const plain = (v) => JSON.parse(JSON.stringify(v));      // objects made in a vm context have that context's prototypes
const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };

/* ------------------------------------------------------------------ a fake IndexedDB for one origin */
// Enough of IndexedDB for js/store.js: open (+ upgradeneeded), createObjectStore / createIndex, transactions with
// get / put / delete / getAll / getAllKeys / index(), auto-commit once a macrotask passes with no request pending,
// abort with rollback. Values are structured-cloned on put and on every read, like the real thing.
function idbOrigin() { return { dbs: new Map() }; }

function idbFactory(origin) {
  const later = (fn) => setImmediate(fn);
  const clone = (v) => structuredClone(v);
  const canon = (k) => JSON.stringify(k);
  const named = (name) => { const e = new Error(name); e.name = name; return e; };
  const typeOf = (k) => (typeof k === "number" ? 0 : typeof k === "string" ? 2 : Array.isArray(k) ? 4 : 3);
  function cmp(a, b) {
    const ta = typeOf(a), tb = typeOf(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (ta === 4) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; }
      return a.length - b.length;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const isRange = (q) => !!q && typeof q === "object" && !Array.isArray(q) && ("lower" in q || "upper" in q);
  function inRange(key, q) {
    if (q === undefined || q === null) return true;
    if (!isRange(q)) return cmp(key, q) === 0;
    if (q.lower !== undefined && q.lower !== null) { const c = cmp(key, q.lower); if (c < 0 || (c === 0 && q.lowerOpen)) return false; }
    if (q.upper !== undefined && q.upper !== null) { const d = cmp(key, q.upper); if (d > 0 || (d === 0 && q.upperOpen)) return false; }
    return true;
  }
  const valid = (k) => typeof k === "string" || (typeof k === "number" && !Number.isNaN(k)) || (Array.isArray(k) && k.every(valid));
  function keyOf(value, keyPath) {
    const one = (p) => String(p).split(".").reduce((v, part) => (v == null ? undefined : v[part]), value);
    const k = Array.isArray(keyPath) ? keyPath.map(one) : one(keyPath);
    return valid(k) ? k : undefined;
  }
  function transaction(db, names, mode) {
    const t = { mode, done: false, pending: 0, undo: [], error: null, oncomplete: null, onabort: null, onerror: null };
    const commit = () => later(() => {
      if (t.done || t.pending) return;
      t.done = true;
      if (t.oncomplete) t.oncomplete({ target: t });
    });
    t.abort = () => {
      if (t.done) return;
      t.done = true;
      for (let i = t.undo.length - 1; i >= 0; i--) t.undo[i]();
      later(() => { if (t.onabort) t.onabort({ target: t }); });
    };
    function request(exec) {
      if (t.done) throw named("TransactionInactiveError");
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      t.pending++;
      later(() => {
        t.pending--;
        if (t.done) return;
        try { req.result = exec(); } catch (e) {
          req.error = e; t.error = e;
          if (req.onerror) req.onerror({ target: req });
          t.abort();
          return;
        }
        if (req.onsuccess) req.onsuccess({ target: req });
        if (!t.pending) commit();
      });
      return req;
    }
    function rows(s, index, q, count, keysOnly) {
      let items = [];
      s.rows.forEach((row) => {
        const k = index ? keyOf(row.value, s.indexes.get(index)) : row.key;
        if (k === undefined || !inRange(k, q)) return;
        items.push({ k, pk: row.key, v: row.value });
      });
      items.sort((a, b) => cmp(a.k, b.k) || cmp(a.pk, b.pk));
      if (typeof count === "number" && count > 0) items = items.slice(0, count);
      return items.map((it) => clone(keysOnly ? it.pk : it.v));
    }
    t.objectStore = (name) => {
      if (names.indexOf(name) < 0) throw named("NotFoundError");
      const s = db.stores.get(name);
      const write = (fn) => { if (mode === "readonly") throw named("ReadOnlyError"); return fn(); };
      return {
        get: (key) => request(() => { const r = s.rows.get(canon(key)); return r ? clone(r.value) : undefined; }),
        put: (value) => {
          const copy = clone(value);
          return request(() => write(() => {
            const key = keyOf(copy, s.keyPath);
            if (key === undefined) throw named("DataError");
            const ck = canon(key), prev = s.rows.get(ck);
            t.undo.push(() => { if (prev) s.rows.set(ck, prev); else s.rows.delete(ck); });
            s.rows.set(ck, { key, value: copy });
            return key;
          }));
        },
        delete: (q) => request(() => write(() => {
          const doomed = [];
          s.rows.forEach((row, ck) => { if (inRange(row.key, q)) doomed.push([ck, row]); });
          doomed.forEach(([ck, row]) => { s.rows.delete(ck); t.undo.push(() => s.rows.set(ck, row)); });
        })),
        getAll: (q, n) => request(() => rows(s, null, q, n, false)),
        getAllKeys: (q, n) => request(() => rows(s, null, q, n, true)),
        index: (ix) => ({
          getAll: (q, n) => request(() => rows(s, ix, q, n, false)),
          getAllKeys: (q, n) => request(() => rows(s, ix, q, n, true))
        })
      };
    };
    later(() => { if (!t.done && !t.pending) commit(); });
    return t;
  }
  return {
    open(name, version) {
      const req = { result: null, error: null, transaction: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        let db = origin.dbs.get(name);
        if (!db) { db = { version: 0, stores: new Map() }; origin.dbs.set(name, db); }
        const conn = {
          onversionchange: null, onclose: null, onerror: null,
          get objectStoreNames() { return { contains: (n) => db.stores.has(n), length: db.stores.size }; },
          createObjectStore(n, o) {
            const s = { keyPath: o && o.keyPath !== undefined ? o.keyPath : null, indexes: new Map(), rows: new Map() };
            db.stores.set(n, s);
            return { createIndex(ix, kp) { s.indexes.set(ix, kp); } };
          },
          transaction(names, mode) {
            const list = [].concat(names);
            list.forEach((n) => { if (!db.stores.has(n)) throw named("NotFoundError"); });
            return transaction(db, list, mode || "readonly");
          },
          close() {}
        };
        req.result = conn;
        const want = typeof version === "number" ? version : Math.max(1, db.version);
        if (want > db.version) {
          const old = db.version;
          db.version = want;
          req.transaction = { abort() {}, objectStore() { throw named("NotFoundError"); } };
          if (req.onupgradeneeded) req.onupgradeneeded({ oldVersion: old, newVersion: want });
        }
        later(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
      });
      return req;
    }
  };
}

function stored(origin, storeName, id) {
  const db = origin.dbs.get("marginalia");
  const s = db && db.stores.get(storeName);
  const row = s && s.rows.get(JSON.stringify(id));
  return row ? structuredClone(row.value) : undefined;
}

/* ------------------------------------------------------------------ one origin: channel hub + localStorage */
// BroadcastChannel delivers to every OTHER channel of that name, as a queued task (setImmediate here); the storage
// event goes to every OTHER tab's window. `frozen` tabs receive neither (a frozen or back-forward-cached page).
function makeOrigin() {
  const o = { idb: idbOrigin(), channels: new Set(), windows: new Set(), ls: new Map(), frozen: new Set() };
  o.Channel = (label) => class FakeChannel {
    constructor(name) { this.name = String(name); this.label = label; this.listeners = []; this.onmessage = null; o.channels.add(this); }
    postMessage(data) {
      const msg = structuredClone(data);
      o.channels.forEach((c) => {
        if (c === this || c.name !== this.name || o.frozen.has(c.label)) return;
        setImmediate(() => c.deliver(msg));
      });
    }
    addEventListener(type, fn) { if (type === "message") this.listeners.push(fn); }
    removeEventListener() {}
    deliver(data) { const ev = { data }; this.listeners.forEach((fn) => fn(ev)); if (typeof this.onmessage === "function") this.onmessage(ev); }
    close() { o.channels.delete(this); }
  };
  o.localStorage = (win) => ({
    getItem: (k) => (o.ls.has(String(k)) ? o.ls.get(String(k)) : null),
    setItem: (k, v) => {
      const key = String(k), old = o.ls.has(key) ? o.ls.get(key) : null, val = String(v);
      o.ls.set(key, val);
      o.windows.forEach((w) => {
        if (w === win || o.frozen.has(w.__label)) return;
        setImmediate(() => w.dispatchEvent({ type: "storage", key, oldValue: old, newValue: val }));
      });
    },
    removeItem: (k) => { o.ls.delete(String(k)); },
    key: (i) => Array.from(o.ls.keys())[i] || null,
    get length() { return o.ls.size; }
  });
  return o;
}

function eventTarget(obj) {
  obj._listeners = {};
  obj.addEventListener = (t, fn) => { (obj._listeners[t] = obj._listeners[t] || []).push(fn); };
  obj.removeEventListener = (t, fn) => { const l = obj._listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  obj.dispatchEvent = (ev) => { (obj._listeners[ev && ev.type] || []).slice().forEach((fn) => fn.call(obj, ev)); return true; };
  return obj;
}

// A data-only tab (no DOM): util, bus, store, scheduler, prompts, context, cache. opts: {broadcast: false} (no
// BroadcastChannel), {storage: false} (no localStorage), {idb: false} (no IndexedDB → memory backend).
function dataTab(origin, label, opts) {
  opts = opts || {};
  const events = [], toasts = [];
  const doc = eventTarget({ visibilityState: "visible" });
  const win = eventTarget({
    __label: label, console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    setTimeout: (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a)), clearTimeout, setInterval: (fn, ms) => unref(setInterval(fn, ms)), clearInterval,
    queueMicrotask, structuredClone, crypto: globalThis.crypto, document: doc
  });
  win.window = win; win.self = win;
  if (opts.idb !== false) win.indexedDB = idbFactory(origin.idb);
  if (opts.storage !== false) win.localStorage = origin.localStorage(win);
  if (opts.broadcast !== false) win.BroadcastChannel = origin.Channel(label);
  origin.windows.add(win);
  const ctx = vm.createContext(win);
  for (const name of DATA_MODULES) vm.runInContext(fs.readFileSync(path.join(JS, name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const M = win.Marginalia;
  M.app = { toast(o) { toasts.push(o && o.text); return { close() {} }; } };
  ["store:mode", "prompt:saved", "prompt:refused", "collection:changed", "prompts:recontexted"].forEach((type) => {
    M.bus.on(type, (payload) => events.push({ type, payload }));
  });
  return {
    label, M, win, doc, ctx, events, toasts,
    async boot() { await M.store.open(); await M.cache.load(); return this; },
    of(type) { return events.filter((e) => e.type === type).map((e) => e.payload); }
  };
}

const T0 = Date.UTC(2026, 10, 1);
const BOOK = { id: "book_1", kind: "book", name: "Griffiths", sections: [], pageLabels: null, hasBytes: true, addedAt: T0, lastOpenedAt: T0, deletedAt: null, v: 1 };
function promptRec(over) {
  return Object.assign({
    id: "p_1", collectionId: BOOK.id, kind: "qa", text: "Q. What does V stand for?\nA. The potentail", tags: [], flagged: false,
    anchor: { pageIndex: 1, pages: [{ pageIndex: 1, rects: [[100, 400, 300, 420]] }], quote: "V(x) is the potential energy", prefix: "", suffix: "", y: 420, lost: false },
    context: null, cards: [{ i: 0, createdAt: T0, lastReviewedAt: null, intervalMs: 432000000, dueAt: T0 + 432000000, log: [] }],
    createdAt: T0, contentUpdatedAt: T0, updatedAt: T0, deletedAt: null, v: 1
  }, over || {});
}

// The user's reading tab A (open all along) with the book and one prompt, then the tab an "Open in Marginalia"
// link opens (B, at #reader/<cid>/<pid>).
async function twoTabs(opts) {
  const origin = makeOrigin();
  const A = await dataTab(origin, "A", opts).boot();
  await A.M.cache.saveCollection(Object.assign({}, BOOK));
  await A.M.cache.savePrompt(promptRec(), { content: true });
  const B = await dataTab(origin, "B", opts).boot();
  await wait(5);                                           // the announcement is a queued task in every other tab
  return { origin, A, B };
}

/* ------------------------------------------------------------------ the write guard */

describe("M.store: once locked, nothing is written", () => {
  test("put, delete, putMany, meta, attachments and readwrite transactions reject code \"locked\"; reads still work", async () => {
    const origin = makeOrigin();
    const A = await dataTab(origin, "A").boot();
    const st = A.M.store;
    await st.prompts.put(promptRec());
    assert.equal(st.locked(), null);
    const info = st.lock({ reason: "othertab", by: "tab_x" });
    assert.equal(info.reason, "othertab");
    assert.equal(info.by, "tab_x");
    assert.equal(st.lock({ by: "tab_y" }).by, "tab_x", "the first lock stays");
    const refused = async (p, what) => { await assert.rejects(p, (e) => e.code === "locked", what); };
    await refused(st.prompts.put(promptRec({ text: "Q. changed\nA. x" })), "prompts.put");
    await refused(st.prompts.putMany([promptRec({ id: "p_2" })]), "prompts.putMany");
    await refused(st.collections.put(Object.assign({}, BOOK)), "collections.put");
    await refused(st.meta.set("lastSweepAt", 1), "meta.set");
    await refused(st.attachments.remove("a_1"), "attachments.remove");
    await refused(st.backend.del("prompts", "p_1"), "backend.del");
    await refused(st.backend.tx(["prompts"], "readwrite", (s) => s.put(promptRec())), "readwrite tx");
    await refused(st.docs.saveDocument(Object.assign({}, BOOK), new Uint8Array([1, 2, 3])), "docs.saveDocument");
    assert.equal(stored(origin.idb, "prompts", "p_1").text, promptRec().text, "the stored record is untouched");
    assert.equal(stored(origin.idb, "prompts", "p_2"), undefined);
    assert.equal((await st.prompts.get("p_1")).text, promptRec().text, "reads still work");
    assert.equal((await st.backend.tx(["prompts"], "readonly", (s) => s.get("p_1"))).id, "p_1", "readonly transactions still work");
    const modes = A.of("store:mode").filter((e) => e.reason === "othertab");
    assert.equal(modes.length, 1, "store:mode {reason: othertab} is emitted once");
    assert.equal(modes[0].message, "Marginalia is open in another tab");
  });

  test("a write requested before the lock but not yet issued is refused, and a running transaction aborts whole", async () => {
    const origin = makeOrigin();
    const A = await dataTab(origin, "A").boot();
    const st = A.M.store;
    const queued = st.prompts.put(promptRec({ id: "p_q" }));          // reaches the backend a microtask later
    st.lock();
    await assert.rejects(queued, (e) => e.code === "locked");
    assert.equal(stored(origin.idb, "prompts", "p_q"), undefined);

    const B = await dataTab(origin, "B2", { broadcast: false, storage: false }).boot();
    const running = B.M.store.backend.tx(["prompts"], "readwrite", (s) => s.put(promptRec({ id: "p_a" })).then(() => {
      B.M.store.lock();                                              // the newer tab's message lands between two writes
      return s.put(promptRec({ id: "p_b" }));
    }));
    await assert.rejects(running, (e) => e.code === "locked");
    assert.equal(stored(origin.idb, "prompts", "p_a"), undefined, "the first write of the transaction is rolled back");
    assert.equal(stored(origin.idb, "prompts", "p_b"), undefined);
  });

  test("the memory backend never announces itself and is never locked by another tab", async () => {
    const origin = makeOrigin();
    const mem = await dataTab(origin, "mem", { idb: false }).boot();
    assert.equal(mem.M.store.mode(), "memory");
    assert.equal(mem.M.store.tab(), null);
    await dataTab(origin, "B").boot();
    await wait(5);
    assert.equal(mem.M.store.locked(), null);
    await mem.M.cache.saveCollection(Object.assign({}, BOOK));
    assert.ok(mem.M.cache.collection(BOOK.id), "its own data still saves");
  });
});

/* ------------------------------------------------------------------ two tabs of one origin */

describe("two tabs of one origin: the newest one writes", () => {
  test("a newly opened tab announces itself and the older one locks at once", async () => {
    const { A, B } = await twoTabs();
    assert.ok(B.M.store.tab() && A.M.store.tab(), "both tabs announced themselves");
    assert.ok(B.M.store.tab().at > A.M.store.tab().at);
    const lock = A.M.store.locked();
    assert.ok(lock, "tab A stepped aside");
    assert.equal(lock.reason, "othertab");
    assert.equal(lock.by, B.M.store.tab().id);
    assert.equal(B.M.store.locked(), null, "tab B keeps writing");
    assert.deepEqual(plain(A.of("store:mode").filter((e) => e.reason === "othertab").map((e) => e.by)), [B.M.store.tab().id]);
  });

  test("F1: the older tab's flag or grade no longer reverts the newer tab's corrected prompt and its Obsidian record", async () => {
    const { origin, A, B } = await twoTabs();
    const fixed = Object.assign({}, B.M.cache.prompt("p_1"), { text: "Q. What does V stand for?\nA. The potential" });
    await B.M.cache.savePrompt(fixed, { content: true });
    await B.M.cache.savePrompt(Object.assign({}, B.M.cache.prompt("p_1"), { obsidianSentAt: T0 + 1, obsidianFile: "Notes/Marginalia/Griffiths.md" }), { content: false });
    const pA = A.M.cache.prompt("p_1");
    assert.ok(pA.text.endsWith("potentail"), "tab A's copy is older (nothing tells it)");
    // margin.js flag(): savePrompt(Object.assign({}, p, {flagged: !p.flagged}))
    await assert.rejects(A.M.cache.savePrompt(Object.assign({}, pA, { flagged: !pA.flagged }), { content: true }), (e) => e.code === "locked" && !!e.prompt);
    // review.js persistCard(): savePrompt(Object.assign({}, prompt, {cards}), {content: false})
    const cards = pA.cards.map((c) => Object.assign({}, c, { lastReviewedAt: T0 + 5, log: [{ at: T0 + 5, outcome: "remembered" }] }));
    await assert.rejects(A.M.cache.savePrompt(Object.assign({}, pA, { cards }), { content: false }), (e) => e.code === "locked");
    const s = stored(origin.idb, "prompts", "p_1");
    assert.equal(s.text, "Q. What does V stand for?\nA. The potential", "tab B's correction is kept");
    assert.equal(s.obsidianSentAt, T0 + 1);
    assert.equal(s.obsidianFile, "Notes/Marginalia/Griffiths.md");
    assert.equal(s.flagged, false);
    assert.equal(A.M.cache.prompt("p_1"), pA, "tab A's maps are left alone");
    assert.equal(A.of("prompt:saved").filter((e) => e.prompt.id === "p_1" && e.prompt.flagged).length, 0, "no prompt:saved for a refused write");
    assert.equal(A.of("prompt:refused").length, 0, "a flag or a grade carries no typed text to rescue");
    assert.deepEqual(A.toasts, [], "a refused write is not a \"Could not save\"");
    const C = await dataTab(origin, "C").boot();               // what a reload of either tab reads
    assert.equal(C.M.cache.prompt("p_1").text, s.text);
  });

  test("F1b: the older tab's reading-position save no longer drops the chapter the newer tab marked; recontext writes nothing", async () => {
    const { origin, A, B } = await twoTabs();
    const marked = Object.assign({}, B.M.cache.collection(BOOK.id), {
      sections: [{ title: "Ch. 2 · Time-independent", label: "Ch. 2 · Time-independent", pageIndex: 1, level: 1, source: "manual" }]
    });
    await B.M.cache.saveCollection(marked);
    await B.M.cache.recontext(BOOK.id);
    assert.equal(stored(origin.idb, "collections", BOOK.id).sections.length, 1);
    const ctxB = stored(origin.idb, "prompts", "p_1").context;
    // reader.js savePosition(): c = M.cache.collection(id); c.lastPosition = …; M.cache.saveCollection(c)
    const cA = A.M.cache.collection(BOOK.id);
    cA.lastPosition = { pageIndex: 3, fraction: 0.2, zoom: "fit" };
    assert.equal(await A.M.cache.saveCollection(cA), cA, "resolves (its callers expect that) without writing");
    assert.equal(await A.M.cache.recontext(BOOK.id), 0);
    assert.equal(await A.M.cache.removePrompt("p_1"), A.M.cache.prompt("p_1"));
    assert.equal(A.M.cache.prompt("p_1").deletedAt, null, "no tombstone in tab A's maps either");
    await A.M.cache.removeCollection(BOOK.id);
    const c = stored(origin.idb, "collections", BOOK.id);
    assert.equal(c.sections.length, 1, "the chapter mark is kept");
    assert.equal(c.deletedAt, null);
    assert.equal(c.lastPosition, undefined, "tab A's position never reached the store");
    assert.deepEqual(plain(stored(origin.idb, "prompts", "p_1").context), plain(ctxB));
    assert.equal(stored(origin.idb, "prompts", "p_1").deletedAt, null);
    assert.equal(A.of("collection:changed").length, 1, "only tab A's own save before tab B opened");
  });

  test("the older tab sends nothing to Obsidian and stores no settings over the newer tab's", async () => {
    const { origin, A, B } = await twoTabs();
    const load = (tab, names) => names.forEach((n) => vm.runInContext(fs.readFileSync(path.join(JS, n + ".js"), "utf8"), tab.ctx, { filename: "js/" + n + ".js" }));
    load(A, ["settings", "markup", "obsidian"]);
    load(B, ["settings"]);
    assert.equal(B.M.settings.set("obsidianFolder", "Study/Physics"), true, "the newer tab stores its settings");
    const saved = origin.ls.get("marginalia.settings");
    // tab A's stale copy: what its Settings panel, the theme button or a backup import would write back whole
    assert.equal(A.M.settings.set("obsidianFolder", "Notes/Marginalia"), false);
    assert.equal(A.M.settings.set("theme", "dark"), false);
    A.M.settings.reset();
    assert.equal(origin.ls.get("marginalia.settings"), saved, "the newer tab's settings are kept");
    const opened = [], fetched = [];
    A.M.obsidian._setOpener((uri) => { opened.push(uri); });
    A.M.obsidian._setFetch((url) => { fetched.push(url); return Promise.reject(new Error("no server")); });
    const res = plain(await A.M.obsidian.send("p_1", { fromGesture: true }));
    assert.deepEqual([res.ok, res.error], [false, "Marginalia is open in another tab"]);
    assert.deepEqual([opened, fetched], [[], []], "no obsidian:// link and no POST with tab A's older copy");
    assert.equal(stored(origin.idb, "prompts", "p_1").obsidianSentAt, undefined);
  });

  test("a refused text edit is announced as prompt:refused, so the notice can show the text", async () => {
    const { origin, A } = await twoTabs();
    const pA = A.M.cache.prompt("p_1");
    const edited = Object.assign({}, pA, { text: "Q. What does V stand for?\nA. The potential energy V(x)" });
    await assert.rejects(A.M.cache.savePrompt(edited, { content: true }), (e) => e.code === "locked");
    await assert.rejects(A.M.cache.savePrompt({ collectionId: BOOK.id, kind: "note", text: "A brand-new note" }, { content: true }), (e) => e.code === "locked");
    await assert.rejects(A.M.cache.savePrompt({ collectionId: BOOK.id, kind: "highlight", text: "  " }, { content: true }), (e) => e.code === "locked");
    assert.deepEqual(plain(A.of("prompt:refused").map((e) => [e.reason, e.prompt.text])), [
      ["locked", "Q. What does V stand for?\nA. The potential energy V(x)"], ["locked", "A brand-new note"]
    ]);
    assert.equal(stored(origin.idb, "prompts", "p_1").text, promptRec().text);
    assert.equal(A.M.cache.prompts().length, 1, "no new prompt in tab A's maps");
  });

  test("\"Use this tab\": the reloaded tab reads the newer tab's data, writes again, and the other tab steps aside", async () => {
    const { origin, A, B } = await twoTabs();
    await B.M.cache.savePrompt(Object.assign({}, B.M.cache.prompt("p_1"), { text: "Q. What does V stand for?\nA. The potential" }), { content: true });
    assert.ok(A.M.store.locked());
    const A2 = await dataTab(origin, "A2").boot();             // location.reload() in tab A
    await wait(5);
    assert.ok(B.M.store.locked(), "tab B stepped aside");
    assert.equal(A2.M.store.locked(), null);
    assert.ok(A2.M.cache.prompt("p_1").text.endsWith("potential"), "fresh data");
    await A2.M.cache.savePrompt(Object.assign({}, A2.M.cache.prompt("p_1"), { flagged: true }), { content: true });
    const s = stored(origin.idb, "prompts", "p_1");
    assert.equal(s.flagged, true);
    assert.ok(s.text.endsWith("potential"));
    await assert.rejects(B.M.cache.savePrompt(Object.assign({}, B.M.cache.prompt("p_1"), { flagged: false }), { content: true }), (e) => e.code === "locked");
    assert.equal(stored(origin.idb, "prompts", "p_1").flagged, true);
  });

  test("without BroadcastChannel the storage event carries the announcement", async () => {
    const { origin, A, B } = await twoTabs({ broadcast: false });
    assert.ok(A.M.store.locked(), "tab A heard it through the storage event");
    assert.equal(B.M.store.locked(), null);
    const key = JSON.parse(origin.ls.get(A.M.store.TAB_KEY));
    assert.deepEqual(key, plain(B.M.store.tab()));
  });

  test("a tab that missed the message (frozen, back-forward cache) steps aside on pageshow or when it becomes visible", async () => {
    const origin = makeOrigin();
    const A = await dataTab(origin, "A").boot();
    origin.frozen.add("A");
    const B = await dataTab(origin, "B").boot();
    await wait(5);
    assert.equal(A.M.store.locked(), null, "frozen: nothing arrived");
    origin.frozen.delete("A");
    A.win.dispatchEvent({ type: "pageshow", persisted: false });
    assert.equal(A.M.store.locked(), null, "a plain pageshow is a fresh load");
    A.win.dispatchEvent({ type: "pageshow", persisted: true });
    assert.equal(A.M.store.locked().by, B.M.store.tab().id, "back from the back-forward cache: the key names a newer tab");

    const other = makeOrigin();                                // a tab that comes back to the front
    const C = await dataTab(other, "C").boot();
    other.frozen.add("C");
    const D = await dataTab(other, "D").boot();
    await wait(5);
    assert.equal(C.M.store.locked(), null);
    C.doc.visibilityState = "hidden";
    C.doc.dispatchEvent({ type: "visibilitychange" });
    assert.equal(C.M.store.locked(), null, "hidden: nothing to check");
    C.doc.visibilityState = "visible";
    C.doc.dispatchEvent({ type: "visibilitychange" });
    assert.equal(C.M.store.locked().by, D.M.store.tab().id);
    assert.equal(D.M.store.locked(), null);
    assert.equal(C.M.store.checkTabs(), true);
  });

  test("two tabs that announce at the same millisecond: exactly one keeps writing (the larger id), the other is told", async () => {
    const origin = makeOrigin();
    const tabs = [dataTab(origin, "X", { storage: false }), dataTab(origin, "Y", { storage: false })];
    tabs.forEach((t) => { vm.runInContext("Date", t.ctx).now = () => T0; });
    await tabs[0].boot();
    await tabs[1].boot();
    await wait(10);
    const ids = tabs.map((t) => t.M.store.tab());
    assert.equal(ids[0].at, ids[1].at);
    const free = tabs.filter((t) => !t.M.store.locked());
    assert.equal(free.length, 1, "exactly one tab writes");
    assert.equal(free[0].M.store.tab().id, ids[0].id > ids[1].id ? ids[0].id : ids[1].id);
  });

  test("an announcement made later on the same clock tick still counts as newer (the key's time + 1)", async () => {
    const origin = makeOrigin();
    const A = dataTab(origin, "A"), B = dataTab(origin, "B");
    [A, B].forEach((t) => { vm.runInContext("Date", t.ctx).now = () => T0; });
    await A.boot();
    await B.boot();
    await wait(5);
    assert.equal(B.M.store.tab().at, A.M.store.tab().at + 1);
    assert.ok(A.M.store.locked());
    assert.equal(B.M.store.locked(), null);
  });

  test("a tab that has not opened the library yet ignores announcements: its own comes later and wins", async () => {
    const origin = makeOrigin();
    const A = dataTab(origin, "A");                             // still loading
    const B = await dataTab(origin, "B").boot();
    await wait(5);
    await A.boot();
    await wait(5);
    assert.equal(A.M.store.locked(), null);
    assert.ok(B.M.store.locked());
  });

  test("_setTabChannel injects the channel (null: the storage event alone)", async () => {
    const origin = makeOrigin();
    const sent = [];
    const A = dataTab(origin, "A", { broadcast: false });
    A.M.store._setTabChannel((name) => ({ postMessage: (m) => sent.push([name, m]), addEventListener() {} }));
    await A.boot();
    assert.deepEqual(plain(sent), [["marginalia", { type: "open", id: A.M.store.tab().id, at: A.M.store.tab().at }]]);
    const B = dataTab(origin, "B");
    B.M.store._setTabChannel(null);
    await B.boot();
    await wait(5);
    assert.ok(A.M.store.locked(), "the storage event still told tab A");
  });

  test("FEATURES A9.4: a send under way when a newer tab opens leaves its marker in the store; the older tab's answer changes nothing there, the newer tab settles it", async () => {
    const origin = makeOrigin();
    const NOTE = "Notes/Marginalia/Griffiths.md";
    const A = await dataTab(origin, "A").boot();
    await A.M.cache.saveCollection(Object.assign({}, BOOK));
    await A.M.cache.savePrompt(promptRec(), { content: true });
    const load = (tab) => ["settings", "markup", "obsidian"].forEach((n) => vm.runInContext(fs.readFileSync(path.join(JS, n + ".js"), "utf8"), tab.ctx, { filename: "js/" + n + ".js" }));
    const page = (tab) => { tab.win.location = { protocol: "http:", origin: "http://127.0.0.1:8765", hostname: "127.0.0.1", search: "", hash: "" }; };
    const vaults = { ok: true, status: 200, json: () => Promise.resolve({ vaults: [{ id: "v1", name: "Test Vault", open: true }], replaceOnly: true }) };
    const written = (file) => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, file, created: false, replaced: true }) });
    load(A); page(A);
    assert.equal(A.M.settings.set("obsidian", true), true);   // DECISIONS D32: the Obsidian connection is switched on
    let release, atRequest;
    const gate = new Promise((r) => { release = r; });
    A.M.obsidian._setOpener(() => { throw new Error("no obsidian:// link in this test"); });
    A.M.obsidian._setFetch((url) => {
      if (/\/vaults$/.test(url)) return Promise.resolve(vaults);
      atRequest = stored(origin.idb, "prompts", "p_1").obsidianPendingFile;
      return gate.then(() => written(NOTE));
    });
    const sending = A.M.obsidian.send("p_1", { fromGesture: true });
    for (let i = 0; i < 50 && atRequest === undefined; i++) await wait(1);
    assert.equal(atRequest, NOTE, "the marker was in the store when the request left");

    const B = await dataTab(origin, "B").boot();               // "Open in Marginalia": the newer tab reads the store
    await wait(5);
    assert.ok(A.M.store.locked(), "tab A stepped aside while its request was on its way");
    release();                                                  // the server wrote it, and tab A hears so
    assert.equal(plain(await sending).ok, true);
    await wait(5);
    const s = stored(origin.idb, "prompts", "p_1");
    assert.deepEqual([s.obsidianPendingFile, s.obsidianSentAt, s.obsidianFile], [NOTE, undefined, undefined],
      "tab A's record of the answer was refused: the marker stays for the active tab");
    assert.equal(B.M.cache.prompt("p_1").obsidianPendingFile, NOTE, "tab B has it");

    load(B); page(B);
    const opened = [];
    B.M.obsidian._setOpener((uri) => { opened.push(uri); });
    B.M.obsidian._setFetch(() => Promise.reject(new TypeError("Failed to fetch")));    // the server is down: links
    const held = plain(await B.M.obsidian.send("p_1", { fromGesture: true }));
    assert.deepEqual([held.ok, held.mode, opened.length], [false, "link", 0], "a link never adds it: it may be in the note already");
    const posted = [];
    B.M.obsidian._setFetch((url, init) => {
      if (/\/vaults$/.test(url)) return Promise.resolve(vaults);
      posted.push(JSON.parse(init.body).file);
      return Promise.resolve(written(JSON.parse(init.body).file));
    });
    const res = plain(await B.M.obsidian.send("p_1", { fromGesture: true }));
    await wait(5);
    assert.deepEqual([res.ok, res.replaced, posted], [true, true, [NOTE]], "the server checks the note: the copy is replaced, never added again");
    const after = stored(origin.idb, "prompts", "p_1");
    assert.deepEqual(["obsidianPendingFile" in after, after.obsidianFile, typeof after.obsidianSentAt], [false, NOTE, "number"], "settled by tab B");
  });
});

/* ------------------------------------------------------------------ the notice (#tabLock) in the real app */
// The 31 modules in the fake window of tools/smoke.js (compiled here without its final main() call, as in
// test/app.test.js), given this origin's IndexedDB, localStorage and BroadcastChannel. The window has no fetch, so
// M.backup stays "unavailable" (no_fetch) and asks no server.

function loadSmokeHarness() {
  const file = path.join(__dirname, "..", "tools", "smoke.js");
  const src = fs.readFileSync(file, "utf8").replace(/^#!.*\n/, "");
  assert.match(src, /\nmain\(\);\s*$/, "tools/smoke.js no longer ends with main(); update loadSmokeHarness()");
  const body = src.replace(/\nmain\(\);\s*$/, "\nreturn { makeWindow: makeWindow, ORDER: ORDER };\n");
  const factory = vm.runInThisContext("(function (require, process, __dirname, __filename) {" + body + "\n})", { filename: file });
  return factory(require, process, path.dirname(file), file);
}

function appTab(origin, label) {
  const H = loadSmokeHarness(), W = H.makeWindow(), logs = [];
  W.__label = label;
  W.setTimeout = (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a));
  W.setInterval = (fn, ms, ...a) => unref(setInterval(fn, ms, ...a));
  W.requestAnimationFrame = (fn) => W.setTimeout(() => fn(Date.now()), 0);
  W.requestIdleCallback = (fn) => W.setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: false }), 0);
  W.console = { log() {}, info() {}, debug() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  W.indexedDB = idbFactory(origin.idb);
  W.localStorage = origin.localStorage(W);
  W.BroadcastChannel = origin.Channel(label);
  W.crypto = globalThis.crypto;
  const copied = [];
  W.navigator.clipboard = { writeText: (t) => { copied.push(t); return W.__clipboardFails ? Promise.reject(new Error("denied")) : Promise.resolve(); } };
  origin.windows.add(W);
  const ctx = vm.createContext(W);
  for (const name of H.ORDER) vm.runInContext(fs.readFileSync(path.join(JS, name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const R = W.Marginalia, reloads = [];
  R.app._setReload(() => reloads.push(Date.now()));
  return { W, R, doc: W.document, logs, copied, reloads };
}

function hidden(el) { return String(el.className).split(/\s+/).indexOf("is-hidden") >= 0; }
function find(rootEl, pred) {
  let out = null;
  (function walk(n) { (n.childNodes || []).forEach((c) => { if (!out && c.nodeType === 1) { if (pred(c)) out = c; else walk(c); } }); })(rootEl);
  return out;
}
const byClass = (rootEl, cls) => find(rootEl, (el) => String(el.className).split(/\s+/).indexOf(cls) >= 0);
const byText = (rootEl, tag, text) => find(rootEl, (el) => el.tagName === tag && el.childNodes.some((c) => c.textContent === text));
function keydown(key, target, mods) {
  const e = Object.assign({ type: "keydown", key, code: "", keyCode: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    repeat: false, isComposing: false, defaultPrevented: false, target, stopped: false }, mods || {});
  e.preventDefault = () => { e.defaultPrevented = true; };
  e.stopPropagation = () => { e.stopped = true; };
  return e;
}

describe("the notice in the older tab (#tabLock, real modules, fake DOM of tools/smoke.js)", () => {
  async function lockedApp(setup) {
    const origin = makeOrigin();
    const A = appTab(origin, "A");
    assert.equal(await A.R.app.boot(), true, A.logs.join("\n"));
    assert.equal(A.R.store.mode(), "idb");
    await A.R.cache.saveCollection(Object.assign({}, BOOK));
    await A.R.cache.savePrompt(promptRec(), { content: true });
    if (setup) setup(A);
    const B = await dataTab(origin, "B").boot();
    await wait(5);
    return { origin, A, B, host: A.doc.getElementById("tabLock") };
  }

  test("covers the app: alertdialog, the title, one \"Use this tab\" button that reloads, everything else inert", async () => {
    const { A, B, host } = await lockedApp();
    assert.ok(host, "#tabLock is shown");
    assert.equal(host.parentNode, A.doc.getElementById("app"));
    const panel = host.childNodes[0];
    assert.equal(panel.getAttribute("role"), "alertdialog");
    assert.equal(panel.getAttribute("aria-modal"), "true");
    assert.equal(panel.getAttribute("aria-labelledby"), "tabLockTitle");
    assert.equal(panel.getAttribute("aria-describedby"), "tabLockBody");
    assert.equal(A.doc.getElementById("tabLockTitle").textContent, "Marginalia is open in another tab");
    const use = byText(panel, "BUTTON", "Use this tab"), copy = byText(panel, "BUTTON", "Copy text");
    assert.ok(use && copy);
    assert.equal(hidden(copy), true, "no unsaved text: only \"Use this tab\"");
    assert.equal(hidden(use), false);
    assert.equal(A.doc.activeElement, use, "focus is on the button");
    for (const id of ["banner", "library", "deck", "reader", "review", "settings", "shortcuts", "toasts", "confirm", "fileInput"]) {
      assert.equal(A.doc.getElementById(id).hasAttribute("inert"), true, "#" + id + " is inert");
    }
    assert.equal(host.hasAttribute("inert"), false);
    assert.deepEqual(plain(A.R.app.tabLock()), { texts: [], by: B.M.store.tab().id });
    use.click();
    assert.equal(A.reloads.length, 1, "\"Use this tab\" reloads the page");
  });

  test("keys: nothing routes, Escape is swallowed, Tab stays inside, a key aimed elsewhere brings focus back", async () => {
    const { A, host } = await lockedApp();
    const runs = [];
    A.R.reader.run = (id) => { runs.push(id); return true; };
    A.R.app.setFocusOwner("reader");
    const panel = host.childNodes[0];
    const use = byText(panel, "BUTTON", "Use this tab");
    const lib = A.doc.getElementById("library");
    const n = keydown("n", lib);
    A.W.dispatchEvent(n);                                    // the capture-phase guard on window
    assert.equal(n.stopped, true);
    assert.equal(n.defaultPrevented, true);
    assert.equal(A.doc.activeElement, use, "focus is back in the notice");
    assert.equal(A.R.app.handleKeydown(keydown("n", lib)), true);
    assert.deepEqual(runs, [], "M.reader.run never sees a key");
    const esc = keydown("Escape", use);
    A.W.dispatchEvent(esc);
    assert.equal(esc.defaultPrevented, true);
    assert.ok(A.doc.getElementById("tabLock"), "Escape does not close it");
    const enter = keydown("Enter", use);
    A.W.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, false, "Enter on the button keeps its native click");
    assert.equal(enter.stopped, true);
    const reload = keydown("r", lib, { metaKey: true });
    A.W.dispatchEvent(reload);
    assert.equal(reload.defaultPrevented, false, "browser shortcuts (Cmd+R) still work");
    use.getClientRects = () => [{}];                          // the fake DOM lays nothing out: these two are "visible"
    panel.getClientRects = () => [{}];
    A.doc.activeElement = use;
    const tab = keydown("Tab", use);
    A.W.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(A.doc.activeElement, use, "Tab cycles inside the notice (one visible button)");
    const paste = { type: "paste", target: lib, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    A.W.dispatchEvent(paste);
    assert.equal(paste.stopped, true, "a paste never reaches the reader's free-note handler");
    const inLib = A.doc.getElementById("library");
    A.doc.dispatchEvent({ type: "focusin", target: inLib });
    assert.equal(A.doc.activeElement, use, "focus that lands behind the notice comes back");
    assert.equal(await A.R.app.route("library", {}), false, "no more routing");
    assert.equal(await A.R.app.confirm({ title: "Delete?" }), false, "a confirm is answered at once");
    const toasts = A.doc.getElementById("toasts"), before = toasts.childNodes.length;
    const t = A.R.app.toast({ text: "Could not save the card" });
    assert.equal(typeof t.close, "function");
    assert.equal(toasts.childNodes.length, before, "no toast shows up behind the notice");
  });

  test("unsaved editor text is shown through escapeHtml with \"Copy text\"; saved or bare text is not", async () => {
    const typed = "Q. Why <b>is</b> \"V\" & 'x' real?\nA. Because";
    const deckBox = "Q. a\nA. b";
    const { A, host } = await lockedApp((T) => {
      T.R.margin.activeEditor = () => ({ getText: () => typed, prompt: null, batch: false, isDestroyed: () => false });
      T.R.library.activeEditor = () => ({ getText: () => deckBox, prompt: null, batch: true, isDestroyed: () => false });
    });
    const panel = host.childNodes[0];
    const copy = byText(panel, "BUTTON", "Copy text");
    assert.equal(hidden(copy), false);
    assert.deepEqual(plain(A.R.app.tabLock().texts), [typed, deckBox]);
    const label = A.doc.getElementById("tabLockTextLabel");
    assert.equal(label.textContent, "This text was not saved. Copy it before you use this tab:");
    const wrap = label.parentNode.childNodes[1];
    assert.equal(wrap.innerHTML, '<textarea class="tablock__text" readonly rows="6" spellcheck="false" aria-labelledby="tabLockTextLabel">\n' +
      "Q. Why &lt;b&gt;is&lt;/b&gt; &quot;V&quot; &amp; &#39;x&#39; real?\nA. Because\n\nQ. a\nA. b</textarea>");
    assert.equal(A.doc.activeElement, copy, "with text to rescue, focus starts on Copy text (Enter does not reload)");
    copy.click();
    await wait(1);
    assert.deepEqual(plain(A.copied), [typed + "\n\n" + deckBox]);
    const status = byClass(panel, "tablock__status");
    assert.equal(status.getAttribute("role"), "status");
    assert.equal(status.textContent, "Copied");
    A.W.__clipboardFails = true;
    copy.click();
    await wait(1);
    assert.match(status.textContent, /^Could not copy here — select the text and press /);
    assert.equal(A.reloads.length, 0, "copying never reloads");
  });

  test("an open edit of a stored prompt counts only when its text differs; the bare \"Q. \" of Save and another never", async () => {
    const editing = (text) => (T) => {
      T.R.margin.activeEditor = () => ({ getText: () => text, prompt: T.R.cache.prompt("p_1"), batch: false, isDestroyed: () => false });
      T.R.library.activeEditor = () => ({ getText: () => "Q. ", prompt: null, batch: false, isDestroyed: () => false });
    };
    const same = await lockedApp(editing(promptRec().text));
    assert.deepEqual(plain(same.A.R.app.tabLock().texts), [], "the editor holds what is stored");
    assert.equal(hidden(byText(same.host.childNodes[0], "BUTTON", "Copy text")), true);
    const edited = await lockedApp(editing("Q. What does V stand for?\nA. The potential"));
    assert.deepEqual(plain(edited.A.R.app.tabLock().texts), ["Q. What does V stand for?\nA. The potential"]);
    const gone = await lockedApp((T) => {
      T.R.margin.activeEditor = () => ({ getText: () => "Q. typed", prompt: null, batch: false, isDestroyed: () => true });
    });
    assert.deepEqual(plain(gone.A.R.app.tabLock().texts), [], "a destroyed editor holds nothing");
  });

  test("a save the lock refuses afterwards adds its text to the notice", async () => {
    const { A, host } = await lockedApp();
    const copy = byText(host.childNodes[0], "BUTTON", "Copy text");
    assert.equal(hidden(copy), true);
    await assert.rejects(A.R.cache.savePrompt({ collectionId: BOOK.id, kind: "note", text: "Typed just as the tab stepped aside <3" }, { content: true }), (e) => e.code === "locked");
    assert.deepEqual(plain(A.R.app.tabLock().texts), ["Typed just as the tab stepped aside <3"]);
    assert.equal(hidden(copy), false);
    assert.match(A.doc.getElementById("tabLockTextLabel").parentNode.childNodes[1].innerHTML, /Typed just as the tab stepped aside &lt;3<\/textarea>$/);
  });

  test("the newest tab shows no notice", async () => {
    const origin = makeOrigin();
    const A = await dataTab(origin, "A").boot();
    const B = appTab(origin, "B");
    assert.equal(await B.R.app.boot(), true, B.logs.join("\n"));
    await wait(5);
    assert.ok(A.M.store.locked());
    assert.equal(B.R.app.tabLock(), null);
    assert.equal(B.doc.getElementById("tabLock"), null);
  });
});

/* ------------------------------------------------------------------ styles */

describe("css/app.css: the notice sits above everything and uses theme tokens", () => {
  // js/app.js builds the notice, so its rules live in css/app.css (BUILD-NOTES "CSS ownership"), next to the toasts,
  // the confirm dialog and the ? sheet it must cover; styles.css holds none of them
  const css = fs.readFileSync(path.join(__dirname, "..", "css", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const appCss = css;
  test("styles.css keeps to its own list: no rule of the notice", () => {
    const shared = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(shared, /#tabLock|\.tablock__/);
  });
  const rule = (src, sel) => {
    const m = new RegExp("(^|\\})\\s*" + sel.replace(/[.#]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(src);
    return m ? m[2] : null;
  };
  const z = (body) => Number((/z-index:\s*(\d+)/.exec(body || "") || [])[1]);

  test("#tabLock is a fixed full-viewport layer above the toasts, the confirm dialog and the ? sheet", () => {
    const host = rule(css, "#tabLock");
    assert.ok(host, "#tabLock rule");
    assert.match(host, /position:\s*fixed/);
    assert.match(host, /inset:\s*0/);
    for (const sel of ["#toasts", "#confirm", "#shortcuts"]) assert.ok(z(host) > z(rule(appCss, sel)), "above " + sel);
  });

  test("the panel takes its colours from the tokens, so both themes restyle it", () => {
    const panel = rule(css, ".tablock__panel"), text = rule(css, ".tablock__text");
    assert.match(panel, /background:\s*var\(--surface\)/);
    assert.match(panel, /color:\s*var\(--ink\)/);
    assert.match(panel, /border:\s*1px solid var\(--line\)/);
    assert.match(text, /background:\s*var\(--surface-2\)/);
    for (const sel of [".tablock__panel", ".tablock__title", ".tablock__body", ".tablock__label", ".tablock__text", ".tablock__status"]) {
      assert.doesNotMatch(rule(css, sel) || "", /#[0-9a-f]{3,6}\b/i, sel + " has no fixed colour");
    }
  });
});

/* ------------------------------------------------------------------ FEATURES L1.8: folders follow the same rule */

describe("folders (FEATURES L1.8): a tab that stepped aside creates, renames, moves and deletes no folder", () => {
  test("every folder writer of the older tab rejects \"locked\" and changes nothing, in its copy or in the store; the newer tab's land", async () => {
    const origin = makeOrigin();
    const A = await dataTab(origin, "A").boot();
    await A.M.cache.saveCollection(Object.assign({}, BOOK));
    const f = await A.M.cache.createFolder("Physics", null);
    const g = await A.M.cache.createFolder("QM", f.id);
    await A.M.cache.moveCollection(BOOK.id, g.id);
    const B = await dataTab(origin, "B").boot();
    await wait(5);
    assert.ok(A.M.store.locked(), "tab A stepped aside");
    const storedFolders = () => plain(stored(origin.idb, "meta", "folders").value);
    const before = { folders: storedFolders(), book: stored(origin.idb, "collections", BOOK.id), mine: plain(A.M.cache.folders()) };
    const refused = async (p, what) => { await assert.rejects(p, (e) => e.code === "locked", what); };
    await refused(A.M.cache.createFolder("New", null), "createFolder");
    await refused(A.M.cache.renameFolder(f.id, "Renamed"), "renameFolder");
    await refused(A.M.cache.moveFolder(g.id, null), "moveFolder");
    await refused(A.M.cache.moveCollection(BOOK.id, null), "moveCollection");
    await refused(A.M.cache.removeFolder(f.id), "removeFolder");
    await refused(A.M.cache.restoreFolder(f.id, { folders: [], collections: [] }), "restoreFolder");
    await refused(A.M.cache.saveFolders([{ id: "folder_x", name: "X", parentId: null, createdAt: 1, updatedAt: 1, deletedAt: null }]), "saveFolders");
    assert.deepEqual(plain(A.M.cache.folders()), before.mine, "tab A's copy is as it was");
    assert.equal(A.M.cache.folderOf(BOOK.id), g.id);
    assert.deepEqual(storedFolders(), before.folders, "the store is untouched");
    assert.deepEqual(stored(origin.idb, "collections", BOOK.id), before.book);
    assert.equal(A.toasts.length, 0, "a refusal by the lock is never toasted");

    assert.deepEqual(plain(B.M.cache.folders()).map((x) => x.name), ["Physics", "QM"], "tab B read the folders");
    await B.M.cache.moveCollection(BOOK.id, f.id);
    await B.M.cache.renameFolder(g.id, "Quantum");
    assert.equal(stored(origin.idb, "collections", BOOK.id).folderId, f.id);
    assert.deepEqual(storedFolders().map((x) => x.name), ["Physics", "Quantum"]);
  });
});
