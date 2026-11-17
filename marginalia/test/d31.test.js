"use strict";
// test/d31.test.js — DECISIONS D31 (BUILD-NOTES "Windows"): the windows of the Mac app.
//  1. the handover of the writer role between pages (js/store.js) and what a page reads again (M.cache.reload,
//     M.settings.reload): data-only pages on ONE fake IndexedDB, with a BroadcastChannel hub, a shared localStorage
//     and a shared Web Locks manager (the harness of test/tabs.test.js, plus the locks);
//  2. the real modules in the fake window of tools/smoke.js as pages of the app: the app shell's part, a window's own
//     tabs, the lists of windows that are gone, moving a tab to a window, drag and drop.
// Nothing here opens a URI, starts a server or touches a vault.
// Run: node --test test/d31.test.js
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS = path.join(__dirname, "..", "js");

// The harness of test/tabs.test.js (its first part, up to its first tests): a fake IndexedDB for one origin, the
// channel hub and localStorage that the origin's pages share, and a data-only page.
function loadPagesHarness() {
  const file = path.join(__dirname, "tabs.test.js");
  const src = fs.readFileSync(file, "utf8");
  const end = src.indexOf("/* ------------------------------------------------------------------ the write guard */");
  assert.ok(end > 0, "test/tabs.test.js no longer has its harness before \"the write guard\"; update loadPagesHarness()");
  const body = src.slice(0, end) + "\nreturn { idbOrigin, idbFactory, stored, makeOrigin, eventTarget, dataTab, T0, BOOK, promptRec, wait, plain, unref };\n";
  const factory = vm.runInThisContext("(function (require, __dirname, __filename) {" + body + "\n})", { filename: file });
  return factory(require, path.dirname(file), file);
}
const H = loadPagesHarness();
const { stored, T0, BOOK, promptRec, wait, plain } = H;

// The Web Locks of one origin, as navigator.locks gives them to each page: one holder per name, the others wait in
// line; a lock is held until the promise of its callback ends; {ifAvailable: true} never waits; a page that dies
// lets go of everything.
function lockHub() {
  const hub = { held: new Map(), queue: new Map(), dead: new Set() };
  const grant = (name) => {
    if (hub.held.has(name)) return;
    const q = hub.queue.get(name) || [];
    const next = q.shift();
    if (!next) return;
    const entry = { client: next.client, released: false };
    entry.release = () => {
      if (entry.released) return;
      entry.released = true;
      if (hub.held.get(name) === entry) hub.held.delete(name);
      setImmediate(() => grant(name));
    };
    hub.held.set(name, entry);
    setImmediate(() => {
      if (entry.released) return;                           // its page died before the callback ran
      let p;
      try { p = Promise.resolve(next.cb({ name, mode: "exclusive" })); } catch (e) { p = Promise.reject(e); }
      p.then((v) => { entry.release(); next.resolve(v); }, (e) => { entry.release(); next.reject(e); });
    });
  };
  hub.manager = (client) => ({
    request(name, a, b) {
      const opts = typeof a === "function" ? {} : (a || {}), cb = typeof a === "function" ? a : b;
      return new Promise((resolve, reject) => {
        if (hub.dead.has(client)) return;
        const busy = hub.held.has(name) || (hub.queue.get(name) || []).length > 0;
        if (opts.ifAvailable && busy) { setImmediate(() => { Promise.resolve().then(() => cb(null)).then(resolve, reject); }); return; }
        if (!hub.queue.has(name)) hub.queue.set(name, []);
        hub.queue.get(name).push({ client, cb, resolve, reject });
        grant(name);
      });
    },
    query() {
      return Promise.resolve({ held: Array.from(hub.held, ([name, e]) => ({ name, clientId: e.client, mode: "exclusive" })),
        pending: [].concat(...Array.from(hub.queue, ([name, q]) => q.map((r) => ({ name, clientId: r.client, mode: "exclusive" })))) });
    }
  });
  hub.kill = (client) => {
    hub.dead.add(client);
    hub.queue.forEach((q, name) => hub.queue.set(name, q.filter((r) => r.client !== client)));
    Array.from(hub.held).forEach(([, e]) => { if (e.client === client) e.release(); });
  };
  hub.holder = (name) => (hub.held.has(name) ? hub.held.get(name).client : null);
  return hub;
}

function appOrigin() {
  const origin = H.makeOrigin();
  origin.locks = lockHub();
  return origin;
}

// A data-only page of the app: handover mode asked before its store opens (as M.app does), its events recorded.
function appPage(origin, label, opts) {
  const tab = H.dataTab(origin, label, opts);
  if (!opts || opts.locks !== false) tab.win.navigator = { locks: origin.locks.manager(label) };
  tab.M.store.handover(!opts || opts.handover !== false);
  tab.roles = [];
  tab.M.bus.on("store:writer", (e) => tab.roles.push(e.writer));
  tab.data = [];
  for (const type of ["prompt:saved", "prompt:deleted", "prompt:restored", "collection:changed", "collection:deleted", "folders:changed"]) {
    tab.M.bus.on(type, (e) => tab.data.push(type + " " + (e.prompt ? e.prompt.id + (e.isNew ? " new" : "") : e.promptId || e.collectionId || "")));
  }
  tab.syncs = [];
  // what M.app gives to acquire(): read the library again when another page held the role
  tab.take = () => tab.M.store.acquire((changed) => { tab.syncs.push(changed); return changed ? tab.M.cache.reload() : null; });
  // the window is gone, without a word: its locks go free, it hears nothing, and it says nothing more
  tab.die = () => {
    origin.locks.kill(label);
    origin.frozen.add(label);
    origin.channels.forEach((c) => { if (c.label === label) c.postMessage = () => {}; });
  };
  return tab;
}
// Waits until something is so (a hand-over takes a few turns of the event loop, more on a busy machine).
async function until(pred, what) {
  for (let i = 0; i < 400; i++) { if (pred()) return; await wait(5); }
  throw new Error("timed out waiting for " + (what || pred.toString()));
}
const codeOf = (p) => p.then(() => "resolved", (e) => (e && e.code) || String(e));

describe("the writer role (M.store in handover mode)", () => {
  test("a page of the app starts as a reader: nothing is written, nothing covers the page; acquire() makes it the writer", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    assert.equal(a.M.store.handover(), true);
    assert.equal(a.M.store.writer(), false);
    assert.deepEqual(plain(a.M.store.locked()).reason, "window");
    assert.deepEqual(a.of("store:mode").filter((e) => e.reason === "othertab"), [], "no \"other tab\" notice in the app");
    assert.equal(a.M.store.tab(), null, "no announcement of the legacy rule");
    assert.equal(origin.ls.has("marginalia.tab"), false);
    assert.equal(await codeOf(a.M.cache.savePrompt(promptRec())), "locked");
    assert.equal(await codeOf(a.M.store.collections.put(Object.assign({}, BOOK))), "locked");
    assert.equal(stored(origin.idb, "prompts", "p_1"), undefined);
    // the first acquire: this page never held the role, so it is told to read the library again
    assert.equal(await a.take(), true);
    assert.deepEqual(a.syncs, [true]);
    assert.equal(a.M.store.writer(), true);
    assert.equal(a.M.store.locked(), null);
    assert.deepEqual(a.roles, [true]);
    assert.equal(origin.locks.holder("marginalia.writer"), "A");
    await a.M.cache.saveCollection(Object.assign({}, BOOK));
    await a.M.cache.savePrompt(promptRec());
    assert.equal(stored(origin.idb, "prompts", "p_1").text, promptRec().text);
    // asking again changes nothing and reads nothing
    assert.equal(await a.take(), true);
    assert.deepEqual(a.syncs, [true]);
    assert.deepEqual(a.roles, [true]);
  });

  test("the role goes to the page that asks: the writer stops at once, and the new writer first reads what was written", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    await a.take();
    await a.M.cache.saveCollection(Object.assign({}, BOOK));
    await a.M.cache.savePrompt(promptRec());
    const b = await appPage(origin, "B").boot();           // a second window: it read the library while A wrote on
    await a.M.cache.savePrompt(Object.assign(a.M.cache.prompt("p_1"), { text: "Q. What does V stand for?\nA. The potential" }), { content: true });
    assert.equal(b.M.cache.prompt("p_1").text, promptRec().text, "B's copy is older");
    assert.equal(await b.take(), true);                     // the user clicks in window B
    assert.deepEqual(b.syncs, [true]);
    assert.equal(b.M.cache.prompt("p_1").text, "Q. What does V stand for?\nA. The potential", "B read A's change before it may write");
    assert.deepEqual([a.M.store.writer(), b.M.store.writer()], [false, true]);
    assert.deepEqual(a.roles, [true, false]);
    assert.deepEqual(b.roles, [true]);
    assert.equal(plain(a.M.store.locked()).reason, "window");
    assert.equal(origin.locks.holder("marginalia.writer"), "B");
    // A writes nothing now, and its refused save is no "other tab" case
    assert.equal(await codeOf(a.M.cache.savePrompt(Object.assign({}, a.M.cache.prompt("p_1"), { flagged: true }))), "locked");
    assert.deepEqual(a.of("store:mode").filter((e) => e.reason === "othertab"), []);
    // B flags the prompt; A takes the role back and reads that: neither change is lost
    await b.M.cache.savePrompt(Object.assign(b.M.cache.prompt("p_1"), { flagged: true }), { content: true });
    assert.equal(await a.take(), true);
    assert.deepEqual(a.syncs, [true, true]);
    assert.equal(a.M.cache.prompt("p_1").flagged, true);
    await a.M.cache.savePrompt(Object.assign(a.M.cache.prompt("p_1"), { tags: ["qm"] }), { content: true });
    const final = stored(origin.idb, "prompts", "p_1");
    assert.deepEqual([final.text, final.flagged, final.tags], ["Q. What does V stand for?\nA. The potential", true, ["qm"]]);
  });

  test("a page that keeps the role reads nothing again; a page that takes the role always reads again, whoever held it meanwhile", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    await a.take();
    await a.take();
    assert.deepEqual(a.syncs, [true], "still the writer: nothing to read");
    const b = await appPage(origin, "B").boot();
    await b.take();
    await a.take();
    assert.deepEqual(a.syncs, [true, true], "B held the role in between, whether it wrote or not");
    assert.deepEqual(b.syncs, [true]);
    // a page that asked and got nothing in the end (its window was closed): A gave the role up for it, and reads again
    // when it takes the role back. That costs little and is always safe.
    const c = await appPage(origin, "C").boot();
    c.take();
    c.die();
    await wait(20);
    assert.equal(a.M.store.writer(), false);
    assert.equal(await a.take(), true);
    assert.deepEqual(a.syncs, [true, true, true]);
    // no record outside the lock says who wrote last: localStorage is not in step between pages at every moment
    assert.deepEqual(Array.from(origin.ls.keys()).filter((k) => /writer/.test(k)), []);
  });

  test("writes under way end before the role goes on; a write that starts after the ask is refused", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    await a.take();
    await a.M.cache.saveCollection(Object.assign({}, BOOK));
    const b = await appPage(origin, "B").boot();
    const order = [];
    // a long write in A: one transaction that goes on until the test lets it end (a large PDF goes in chunk by chunk)
    let more = true;
    const big = a.M.store.backend.tx(["prompts"], "readwrite", (s) => {
      const next = () => (more ? s.get("p_0").then(next) : s.put(promptRec({ id: "p_last" })));
      return s.put(promptRec({ id: "p_0" })).then(next);
    }).then(() => order.push("A wrote"), (e) => order.push("A failed " + e.code));
    const took = b.M.store.acquire((changed) => { order.push("B reads"); return b.M.cache.reload(); }).then(() => order.push("B writes"));
    for (let i = 0; i < 500 && a.M.store.writer(); i++) await wait(0);      // until A has heard B's ask
    assert.equal(a.M.store.writer(), false);
    await wait(5);
    assert.deepEqual(order, [], "A's transaction is still under way, and B waits for it");
    assert.equal(b.M.store.writer(), false);
    // A is locked for anything new …
    assert.equal(await codeOf(a.M.store.prompts.put(promptRec({ id: "p_late" }))), "locked");
    assert.equal(await codeOf(a.M.store.backend.tx(["prompts"], "readwrite", (s) => s.put(promptRec({ id: "p_late" })))), "locked");
    // … but the transaction that was under way ends as it began: its last write goes in too
    more = false;
    await Promise.all([big, took]);
    assert.deepEqual(order, ["A wrote", "B reads", "B writes"]);
    assert.deepEqual(plain(b.M.cache.prompts().map((x) => x.id)).sort(), ["p_0", "p_last"], "B has all of A's transaction");
    assert.equal(stored(origin.idb, "prompts", "p_late"), undefined);
    await a.M.store.idle();
  });

  test("work of several writes keeps the role until it ends: the page that asks waits (an import, a PDF being added)", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    await a.take();
    await a.M.cache.saveCollection(Object.assign({}, BOOK));
    const b = await appPage(origin, "B").boot();
    let finish;
    const order = [];
    const work = a.M.store.during(new Promise((r) => { finish = r; }));
    const took = b.take().then((ok) => order.push("B " + ok));
    await wait(20);
    assert.equal(a.M.store.writer(), true, "A keeps the role while its work goes on");
    assert.deepEqual(a.roles, [true]);
    await a.M.cache.savePrompt(promptRec({ id: "p_1" }));   // the work's writes, one after the other
    await a.M.cache.savePrompt(promptRec({ id: "p_2" }));
    assert.deepEqual(order, []);
    finish();
    await work;
    await took;
    assert.deepEqual(order, ["B true"]);
    assert.deepEqual([a.M.store.writer(), b.M.store.writer()], [false, true]);
    assert.equal(b.M.cache.prompts().length, 2, "B read all of the work's writes");
    // work that fails lets the role go just the same
    const failing = b.M.store.during(() => Promise.reject(new Error("the file was no backup")));
    const back = a.take();
    await assert.rejects(failing, /no backup/);
    assert.equal(await back, true);
    // during() gives the work's own promise back, also outside handover mode
    const p = await appPage(appOrigin(), "P", { handover: false }).boot();
    assert.equal(await p.M.store.during(Promise.resolve(7)), 7);
    assert.equal(await p.M.store.during(() => 8), 8);
  });

  test("three windows: the page that asked last ends as the writer; a writer that dies frees the role", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    const b = await appPage(origin, "B").boot();
    const c = await appPage(origin, "C").boot();
    await a.take();
    const tb = b.take();                                    // B is clicked, then C before B has the role
    await wait(2);
    const tc = c.take();
    const [gotB, gotC] = await Promise.all([tb, tc]);
    await wait(20);
    assert.equal(gotC, true);
    assert.deepEqual([a.M.store.writer(), b.M.store.writer(), c.M.store.writer()], [false, false, true]);
    assert.equal(origin.locks.holder("marginalia.writer"), "C");
    // B either never got the role (its ask ended when C asked) or had it for a moment and gave it on
    assert.ok((gotB === false && b.roles.length === 0) || (gotB === true && String(b.roles) === "true,false"), JSON.stringify([gotB, b.roles]));
    // B is used again: its new ask is the latest
    assert.equal(await b.take(), true);
    assert.deepEqual([a.M.store.writer(), b.M.store.writer(), c.M.store.writer()], [false, true, false]);
    // the writer's window is closed (its page dies without a word): the next page that asks gets the role
    b.die();
    assert.equal(await a.take(), true);
    assert.equal(origin.locks.holder("marginalia.writer"), "A");
  });

  test("two asks in the same instant: one page wins, the other is told no, and nothing waits for ever", async () => {
    for (let round = 0; round < 12; round++) {
      const origin = appOrigin();
      const pages = [];
      for (const label of ["A", "B", "C"]) pages.push(await appPage(origin, label).boot());
      await pages[0].take();
      const answers = await Promise.all([pages[1].take(), pages[2].take()]);    // the same millisecond, the same number
      await wait(10);
      const writers = pages.filter((x) => x.M.store.writer()).map((x) => x.label);
      assert.equal(writers.length, 1, "round " + round + ": " + JSON.stringify([answers, writers]));
      assert.ok(writers[0] === "B" || writers[0] === "C");
      assert.equal(origin.locks.holder("marginalia.writer"), writers[0]);
      // the one that lost asks again and gets it
      const loser = pages.find((x) => x.label !== "A" && !x.M.store.writer());
      assert.equal(await loser.take(), true);
      assert.deepEqual(pages.filter((x) => x.M.store.writer()).map((x) => x.label), [loser.label]);
    }
  });

  test("many handovers in any order: never two writers, and no change is lost", async () => {
    const origin = appOrigin();
    const pages = [];
    for (const label of ["A", "B", "C", "D"]) pages.push(await appPage(origin, label).boot());
    await pages[0].take();
    await pages[0].M.cache.saveCollection(Object.assign({}, BOOK));
    await pages[0].M.cache.savePrompt(promptRec({ tags: [] }));
    // every page that becomes the writer is checked against the others at that moment
    let two = 0;
    pages.forEach((x) => x.M.bus.on("store:writer", (e) => { if (e.writer && pages.filter((y) => y.M.store.writer()).length > 1) two++; }));
    let seed = 20261115;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const done = [];
    const jobs = [];
    for (let i = 0; i < 80; i++) {
      const page = pages[rnd(pages.length)], tag = page.label + i;
      jobs.push(page.take().then(async (ok) => {
        if (!ok || !page.M.store.writer()) return;
        // a change made from this page's copy of the record, as an editor does it
        const rec = page.M.cache.prompt("p_1");
        const next = Object.assign({}, rec, { tags: rec.tags.concat([tag]) });
        try { await page.M.cache.savePrompt(next, { content: true }); done.push(tag); } catch (e) { assert.equal(e.code, "locked"); }
      }));
      if (rnd(3) === 0) await wait(rnd(3));
    }
    await Promise.all(jobs);
    await wait(30);
    assert.equal(two, 0, "never two writers");
    assert.ok(pages.filter((x) => x.M.store.writer()).length <= 1);
    const tags = stored(origin.idb, "prompts", "p_1").tags;
    assert.ok(done.length >= 10, "enough writes happened: " + done.length);
    assert.deepEqual(tags.slice().sort(), done.slice().sort(), "every write that was accepted is in the stored record: none overwrote another");
  });

  test("a page whose reading fails stays a reader, its ask says so, and the role stays free for the others", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    const b = await appPage(origin, "B").boot();
    const errors = [];
    a.win.console.error = (...x) => errors.push(x.join(" "));
    await assert.rejects(a.M.store.acquire(() => Promise.reject(new Error("the database did not answer"))),
      (e) => e.code === "sync" && /did not answer/.test(e.cause.message));
    assert.equal(a.M.store.writer(), false);
    assert.equal(plain(a.M.store.locked()).reason, "window");
    assert.deepEqual(a.roles, []);
    assert.match(errors.join("\n"), /could not take the writer role/);
    await wait(5);
    assert.equal(origin.locks.holder("marginalia.writer"), null);
    assert.equal(await b.take(), true);
    assert.equal(await a.take(), true, "and it can try again");
    // a sync that throws at once is the same
    await b.take();
    await assert.rejects(a.M.store.acquire(() => { throw new Error("boom"); }), (e) => e.code === "sync");
    assert.equal(a.M.store.writer(), false);
  });

  test("an ask whose reading hangs does not hold the role back: a later ask ends it, and the lock goes on at once", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    const b = await appPage(origin, "B").boot();
    const hung = a.M.store.acquire(() => new Promise(() => {}));     // the database never answers A
    await wait(10);
    assert.equal(origin.locks.holder("marginalia.writer"), "A", "A has the lock and reads");
    assert.equal(a.M.store.writer(), false, "… and is no writer before it has read");
    assert.equal(await b.take(), true);
    assert.equal(await hung, false);
    assert.deepEqual([a.M.store.writer(), b.M.store.writer()], [false, true]);
    assert.equal(origin.locks.holder("marginalia.writer"), "B");
    assert.deepEqual(a.roles, []);
  });

  test("an ask that was ended while it read does not become the writer when its read ends at last", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    const b = await appPage(origin, "B").boot();
    let finish;
    const slow = a.M.store.acquire(() => new Promise((r) => { finish = r; }));    // A reads, slowly
    await wait(10);
    assert.equal(await b.take(), true);                     // B asks later: A's ask ends, and the lock goes on at once
    assert.equal(await slow, false);
    finish();                                               // now A's read ends
    await wait(20);
    assert.deepEqual([a.M.store.writer(), b.M.store.writer()], [false, true], "one writer");
    assert.equal(plain(a.M.store.locked()).reason, "window");
    assert.deepEqual(a.roles, []);
    assert.equal(origin.locks.holder("marginalia.writer"), "B");
    assert.equal(await codeOf(a.M.cache.saveCollection(Object.assign({}, BOOK)).then(() => { if (stored(origin.idb, "collections", BOOK.id)) throw Object.assign(new Error("x"), { code: "stored" }); })), "resolved",
      "A writes nothing");
  });

  test("a read that a newer read overtook changes nothing when it ends late: the writer's copy stays the newest", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    await a.take();
    await a.M.cache.saveCollection(Object.assign({}, BOOK));
    await a.M.cache.savePrompt(promptRec());
    const b = await appPage(origin, "B").boot();
    await b.take();
    // A takes the role; its read is slow on one store (its picture of the prompts is taken already)
    const all = a.M.store.collections.all;
    let held = true, release;
    a.M.store.collections.all = () => all().then((v) => (held ? new Promise((r) => { release = () => r(v); }) : v));
    const first = a.take();
    await wait(20);
    assert.equal(origin.locks.holder("marginalia.writer"), "A");
    assert.equal(await b.take(), true);                     // B asks later: A's ask ends while it reads
    assert.equal(await first, false);
    await b.M.cache.savePrompt(Object.assign({}, b.M.cache.prompt("p_1"), { text: "Q. Edited in B?\nA. Yes" }), { content: true });
    held = false;
    assert.equal(await a.take(), true);                     // the user is back in A: it reads again, and is the writer
    assert.equal(a.M.cache.prompt("p_1").text, "Q. Edited in B?\nA. Yes");
    release();                                              // only now the first read ends, with the old text
    await wait(30);
    assert.equal(a.M.cache.prompt("p_1").text, "Q. Edited in B?\nA. Yes", "the old read changed nothing");
    assert.equal(a.M.store.writer(), true);
    await a.M.cache.savePrompt(Object.assign({}, a.M.cache.prompt("p_1"), { flagged: true }), { content: true });
    const final = stored(origin.idb, "prompts", "p_1");
    assert.deepEqual([final.text, final.flagged], ["Q. Edited in B?\nA. Yes", true], "B's edit is not overwritten");
    // a read that nothing overtook is used as always
    const again = plain(await a.M.cache.reload());
    assert.deepEqual(again, { prompts: 0, collections: 0, folders: 0 });
  });

  test("an ask that cannot beat the writer's number is told so, and asks again with a later one (a clock that stands behind)", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    vm.runInContext("Date.now = (function (now) { return function () { return now() + 3600000; }; })(Date.now);", a.ctx);   // A's clock: an hour ahead
    await a.take();
    const b = await appPage(origin, "B").boot();           // B started later; it never heard A's ask
    const heard = [];
    origin.channels.forEach((c) => { if (c.label === "B") c.addEventListener("message", (ev) => heard.push(ev.data.type)); });
    assert.equal(await b.take(), true, "B's first number was earlier than A's; A said which number it holds, and B asked again");
    assert.ok(heard.includes("held"), heard.join(" "));
    assert.deepEqual([a.M.store.writer(), b.M.store.writer()], [false, true]);
    // … and A, whose clock is ahead, still gets the role back
    assert.equal(await a.take(), true);
    assert.deepEqual([a.M.store.writer(), b.M.store.writer()], [true, false]);
    // B has seen A's numbers by now: its next ask is above them at once, and nobody has to say "held" again
    const before = heard.filter((x) => x === "held").length;
    assert.equal(await b.take(), true);
    assert.equal(heard.filter((x) => x === "held").length, before);
  });

  test("when work that kept the role ends, the role goes to a page that still waits, and not to one that is gone", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    await a.take();
    const b = await appPage(origin, "B").boot();
    let finish;
    let work = a.M.store.during(new Promise((r) => { finish = r; }));
    b.take();
    await wait(20);
    b.die();                                                // window B was closed while A's import ran
    await wait(1700);                                       // its ask is old by now
    finish();
    await work;
    await wait(30);
    assert.equal(a.M.store.writer(), true, "A keeps the role: nobody waits for it");
    assert.equal(origin.locks.holder("marginalia.writer"), "A");
    assert.deepEqual(a.roles, [true]);
    // a page that still waits after long work says its ask again and again: it gets the role when the work ends
    const c = await appPage(origin, "C").boot();
    work = a.M.store.during(new Promise((r) => { finish = r; }));
    const took = c.take();
    await wait(1700);
    assert.equal(a.M.store.writer(), true);
    finish();
    await work;
    assert.equal(await took, true);
    assert.deepEqual([a.M.store.writer(), c.M.store.writer()], [false, true]);
  });

  test("without Web Locks, in memory mode, or when handover mode was not asked: the legacy rule, unchanged", async () => {
    // no navigator.locks: handover(true) answers false, and the page announces itself as before
    let origin = appOrigin();
    const a = appPage(origin, "A", { locks: false });
    assert.equal(a.M.store.handover(), false);
    await a.boot();
    assert.equal(a.M.store.writer(), true);
    assert.equal(typeof plain(a.M.store.tab()).id, "string");
    assert.equal(await a.M.store.acquire(() => { throw new Error("never called"); }), true);
    const b = await appPage(origin, "B", { locks: false }).boot();
    await wait(5);
    assert.equal(plain(a.M.store.locked()).reason, "othertab", "the older page steps aside for good");
    assert.equal(await a.M.store.acquire(), false);
    assert.equal(b.M.store.writer(), true);
    // memory mode (no IndexedDB): the page's data is its own
    origin = appOrigin();
    const m = await appPage(origin, "M", { idb: false }).boot();
    assert.equal(m.M.store.mode(), "memory");
    assert.equal(m.M.store.handover(), false, "asked, but not in force");
    assert.equal(m.M.store.locked(), null);
    assert.equal(await m.M.store.acquire(), true);
    // not asked (a browser): as before
    origin = appOrigin();
    const p = await appPage(origin, "P", { handover: false }).boot();
    assert.equal(p.M.store.handover(), false);
    assert.equal(typeof plain(p.M.store.tab()).id, "string");
    // asking after open() changes nothing
    assert.equal(p.M.store.handover(true), false);
  });

  test("exclusive(name): one page at a time; hold(name) and held(): which pages are there", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    const b = await appPage(origin, "B").boot();
    let end;
    const got = [];
    const first = a.M.store.exclusive("review", (ok) => { got.push("A " + ok); return new Promise((r) => { end = r; }); });
    await wait(5);
    await b.M.store.exclusive("review", (ok) => { got.push("B " + ok); });
    assert.deepEqual(got, ["A true", "B false"]);
    end();
    await first;
    await wait(5);
    await b.M.store.exclusive("review", (ok) => { got.push("B " + ok); });
    assert.deepEqual(got, ["A true", "B false", "B true"]);
    // each page holds its own name for life
    assert.equal(a.M.store.hold("window."), true);
    assert.equal(b.M.store.hold("window.w2"), true);
    await wait(5);
    assert.deepEqual(plain(await a.M.store.held()).sort(), ["window.", "window.w2"]);
    b.die();
    await wait(5);
    assert.deepEqual(plain(await a.M.store.held()), ["window."]);
    // legacy mode: one page, so fn(true); nothing to hold or to list
    const p = await appPage(appOrigin(), "P", { handover: false }).boot();
    assert.equal(await p.M.store.exclusive("review", (ok) => ok), true);
    assert.equal(p.M.store.hold("window."), false);
    assert.equal(await p.M.store.held(), null);
  });
});

describe("what a page reads again (M.cache.reload, M.settings.reload)", () => {
  test("reload brings the cache to the store's state; only what changed is replaced, and the views are told", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    await a.take();
    const DECK = { id: "deck_1", kind: "deck", name: "Thermo", sections: [], addedAt: T0, lastOpenedAt: T0, deletedAt: null, v: 1 };
    await a.M.cache.saveCollection(Object.assign({}, BOOK));
    await a.M.cache.saveCollection(Object.assign({}, DECK));
    for (const id of ["p_1", "p_2", "p_3", "p_4"]) await a.M.cache.savePrompt(promptRec({ id }));
    await a.M.cache.removePrompt("p_4");
    const b = await appPage(origin, "B").boot();
    const keep = b.M.cache.prompt("p_1"), old2 = b.M.cache.prompt("p_2");
    b.data.length = 0;
    assert.deepEqual(plain(await b.M.cache.reload()), { prompts: 0, collections: 0, folders: 0 }, "nothing changed: nothing happens");
    assert.deepEqual(b.data, []);
    // window A: an edit, a delete, an undo of a delete, a new prompt, a renamed deck, a deleted book, a folder
    await a.M.cache.savePrompt(Object.assign(a.M.cache.prompt("p_2"), { text: "Q. edited\nA. yes" }), { content: true });
    await a.M.cache.removePrompt("p_3");
    await a.M.cache.restorePrompt("p_4");
    await a.M.cache.savePrompt(promptRec({ id: "p_5", collectionId: "deck_1" }));
    await a.M.cache.saveCollection(Object.assign(a.M.cache.collection("deck_1"), { name: "Thermodynamics" }));
    await a.M.cache.createFolder("Physics");
    const res = plain(await b.M.cache.reload());
    assert.deepEqual(res, { prompts: 4, collections: 1, folders: 1 });
    assert.deepEqual(b.data, ["collection:changed deck_1", "folders:changed ", "prompt:saved p_2", "prompt:deleted p_3", "prompt:restored p_4", "prompt:saved p_5 new"]);
    assert.equal(b.M.cache.prompt("p_1"), keep, "an unchanged record keeps its object: the views hold it");
    assert.notEqual(b.M.cache.prompt("p_2"), old2);
    assert.equal(b.M.cache.prompt("p_2").text, "Q. edited\nA. yes");
    assert.equal(b.M.cache.prompt("p_3").deletedAt !== null, true);
    assert.equal(b.M.cache.prompt("p_4").deletedAt, null);
    assert.equal(b.M.cache.collection("deck_1").name, "Thermodynamics");
    assert.deepEqual(plain(b.M.cache.folders({ live: true }).map((f) => f.name)), ["Physics"]);
    assert.deepEqual(plain(b.M.cache.counts("book_1", T0)), plain(a.M.cache.counts("book_1", T0)), "the counts agree");
    // a deleted book: its prompts go first, then the book, as a local delete says it
    b.data.length = 0;
    await a.M.cache.removeCollection("book_1");
    await b.M.cache.reload();
    assert.equal(b.data[b.data.length - 1], "collection:deleted book_1");
    assert.ok(b.data.indexOf("prompt:deleted p_1") >= 0 && b.data.indexOf("prompt:deleted p_1") < b.data.length - 1);
    // and its undo
    b.data.length = 0;
    await a.M.cache.restoreCollection("book_1");
    await b.M.cache.reload();
    assert.equal(b.data[0], "collection:changed book_1");
    assert.ok(b.data.indexOf("prompt:restored p_1") > 0);
    // the content stamps follow the stored record: a later edit in B moves contentUpdatedAt only for a real change
    await b.take();
    const before = b.M.cache.prompt("p_2").contentUpdatedAt;
    await b.M.cache.savePrompt(b.M.cache.prompt("p_2"), { content: true, now: T0 + 999999 });
    assert.equal(b.M.cache.prompt("p_2").contentUpdatedAt, before, "the same text again is no edit");
    // a reload writes nothing
    const snapshot = JSON.stringify(Array.from(origin.idb.dbs.get("marginalia").stores.get("prompts").rows.values()));
    await a.M.cache.reload();
    assert.equal(JSON.stringify(Array.from(origin.idb.dbs.get("marginalia").stores.get("prompts").rows.values())), snapshot);
  });

  test("a record this page holds but the store does not have goes; a change this page never stored is replaced by the store's", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    await a.take();
    await a.M.cache.saveCollection(Object.assign({}, BOOK));
    await a.M.cache.savePrompt(promptRec());
    const b = await appPage(origin, "B").boot();
    // B, a reader, changed its copy in memory (a refused save leaves the object as the caller made it)
    b.M.cache.prompt("p_1").flagged = true;
    b.data.length = 0;
    await b.M.cache.reload();
    assert.equal(b.M.cache.prompt("p_1").flagged, false, "the store's record");
    assert.deepEqual(b.data, ["prompt:saved p_1"]);
  });

  test("settings: reload() reads what another window stored and says what changed", async () => {
    const origin = appOrigin();
    const a = await appPage(origin, "A").boot();
    const b = await appPage(origin, "B").boot();
    for (const t of [a, b]) vm.runInContext(fs.readFileSync(path.join(JS, "settings.js"), "utf8"), t.ctx, { filename: "js/settings.js" });
    const seen = [];
    b.M.bus.on("settings:changed", (e) => seen.push(e.key + "=" + JSON.stringify(e.value)));
    assert.equal(b.M.settings.get("theme"), "system");
    await a.take();
    assert.equal(a.M.settings.set("theme", "dark"), true);
    assert.equal(b.M.settings.set("theme", "light"), false, "a reader stores no setting");
    assert.equal(b.M.settings.get("theme"), "system");
    assert.deepEqual(plain(b.M.settings.reload()), ["theme"]);
    assert.equal(b.M.settings.get("theme"), "dark");
    assert.deepEqual(seen, ["theme=\"dark\""]);
    assert.deepEqual(plain(b.M.settings.reload()), [], "nothing changed: nothing is said");
    // stored settings that cannot be read leave the page's own
    origin.ls.set("marginalia.settings", "{not json");
    assert.deepEqual(plain(b.M.settings.reload()), []);
    assert.equal(b.M.settings.get("theme"), "dark");
    // a reset in the other window (the key is gone): the defaults
    origin.ls.delete("marginalia.settings");
    assert.deepEqual(plain(b.M.settings.reload()), ["theme"]);
    assert.equal(b.M.settings.get("theme"), "system");
  });
});

// ------------------------------------------------------------------------------------- the real modules, as windows
// The page of test/d30.test.js (the fake window of tools/smoke.js, the real modules, a reader stand-in), made a window
// of the Mac app: the origin's IndexedDB, localStorage, BroadcastChannel and Web Locks, and "?w=<id>" in its address.
function loadPageHarness() {
  const file = path.join(__dirname, "d30.test.js");
  const src = fs.readFileSync(file, "utf8");
  const a = src.indexOf("function loadSmokeHarness() {"), b = src.indexOf("\nconst CMD = ");
  assert.ok(a > 0 && b > a, "test/d30.test.js no longer has its page harness before \"const CMD\"; update loadPageHarness()");
  const body = "const T = require(path.join(__dirname, \"..\", \"js\", \"tabs.js\"));\n" + src.slice(a, b) + "\nreturn { page, BOOK, DECK };\n";
  const factory = vm.runInThisContext("(function (require, process, __dirname, __filename, assert, fs, path, vm) {" + body + "\n})", { filename: file });
  return factory(require, process, path.dirname(file), file, assert, fs, path, vm);
}
const D30 = loadPageHarness();
const TABS = require(path.join(JS, "tabs.js"));
const LIB = { screen: "library", collectionId: null, position: null };
const NOT_SAVED = "Not saved: another Marginalia window was in use. Save again.";

// opts: what test/d30.test.js's page takes, and {w} (the window's id; none: the first window), {search} (the query of
// its address, as given), {app: false} (a browser page). → the page, and: label, key (where its tabs are stored), list() (what is stored there), writer(),
// use() (the user comes to this window: it gets the focus), fire(type) (a key or a click, as the window sees it
// first), opened (what the page asked window.open for), die() (the window is gone, without a word).
async function windowPage(origin, label, opts) {
  opts = opts || {};
  const opened = [];
  // the page's own timers never keep Node alive (they are unref'd): while the page starts (it may wait for the role),
  // this one does
  const alive = setInterval(() => {}, 20);
  const p = await D30.page(Object.assign({ app: true }, opts, {
    setup(W) {
      W.__label = label;
      W.indexedDB = H.idbFactory(origin.idb);
      W.localStorage = origin.localStorage(W);
      W.BroadcastChannel = origin.Channel(label);
      W.navigator.locks = origin.locks.manager(label);
      W.crypto = globalThis.crypto;
      W.location.search = opts.search !== undefined ? opts.search : (opts.w ? "?w=" + opts.w : "");
      W.outerWidth = 1100;
      W.outerHeight = 800;
      W.open = (url, target, features) => { opened.push({ url, target, features }); return null; };
      origin.windows.add(W);
    }
  })).finally(() => clearInterval(alive));
  p.label = label;
  p.opened = opened;
  p.key = TABS.STORE_KEY + (opts.w ? "." + opts.w : "");
  p.list = () => (origin.ls.has(p.key) ? JSON.parse(origin.ls.get(p.key)) : null);
  p.writer = () => p.R.store.writer();
  p.use = async () => { p.W.dispatchEvent({ type: "focus" }); await wait(30); };
  p.fire = (type) => {
    const e = { type, key: "t", metaKey: true, target: p.doc.body, defaultPrevented: false, stopped: false,
      preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.stopped = true; }, stopImmediatePropagation() { e.stopped = true; } };
    p.W.dispatchEvent(e);
    return e;
  };
  p.die = () => { origin.locks.kill(label); origin.frozen.add(label); };
  return p;
}
const SAVE_WAIT = 260;                    // js/tabs.js stores its list SAVE_MS (200 ms) after a change
const DROP_WAIT = 280;                    // … and a tab dropped on nothing waits DROP_WAIT_MS (200 ms) for a window that took it
const OVER_WAIT = 780;                    // … and a page takes a tab that was held over it for gone OVER_MS (700 ms) after the last dragover
const PLACE = { pageIndex: 7, fraction: 0.25, zoom: 1.5 };

// The library and the lists of tabs of "last time": a data-only page writes two books and a deck and dies; the lists
// are put into localStorage as the windows left them.
async function lastTimeBooks(lists) {
  const origin = appOrigin();
  const seed = await appPage(origin, "seed").boot();
  await seed.take();
  for (const c of [D30.BOOK("b1", "Griffiths"), D30.BOOK("b2", "Sakurai"), D30.DECK("d1", "Physics")]) await seed.M.cache.saveCollection(c);
  seed.die();
  await wait(5);
  const all = lists || {};
  for (const k of Object.keys(all)) origin.ls.set(k, typeof all[k] === "string" ? all[k] : JSON.stringify(all[k]));
  return origin;
}

describe("the windows of the Mac app (the real modules, as pages of one origin)", () => {
  test("the first window starts as the writer, with its tabs under the plain key; a browser page keeps the rule of one writing tab", async () => {
    const origin = appOrigin();
    const a = await windowPage(origin, "A");
    assert.equal(a.R.store.handover(), true);
    assert.equal(a.writer(), true);
    assert.equal(a.R.store.locked(), null);
    assert.equal(a.R.tabs.windowId(), null);
    assert.equal(origin.locks.holder("marginalia.writer"), "A");
    assert.equal(origin.locks.holder("marginalia.window."), "A", "the page says that it is there");
    assert.equal(a.R.app.tabLock(), null);
    assert.equal(a.R.store.tab(), null, "no announcement of the browser's rule");
    await wait(SAVE_WAIT);
    assert.deepEqual(a.list(), { v: 1, active: 0, tabs: [LIB] });
    assert.equal(a.doc.title, "Marginalia");
    assert.deepEqual(a.logs, []);
    // a browser page (not the app) on an origin of its own: the legacy rule, no role, no window lock
    const web = appOrigin();
    const b = await windowPage(web, "B", { app: false });
    assert.equal(b.R.store.handover(), false);
    assert.equal(b.R.store.locked(), null);
    assert.notEqual(b.R.store.tab(), null);
    assert.equal(web.locks.holder("marginalia.writer"), null);
    assert.equal(web.locks.holder("marginalia.window."), null);
    assert.equal(await b.R.app.takeRole(), true, "nothing to take outside the app");
    // a second browser page makes the first step aside for good, as before
    const c = await windowPage(web, "C", { app: false });
    await wait(20);
    assert.equal(plain(b.R.store.locked()).reason, "othertab");
    assert.notEqual(b.R.app.tabLock(), null, "the notice of the browser version");
    assert.equal(c.R.store.locked(), null);
  });

  test("a second window takes the role as it starts; the first stays on screen as a reader and takes the role back when it is used", async () => {
    const origin = appOrigin();
    const a = await windowPage(origin, "A");
    await a.add(D30.BOOK("b1", "Griffiths"));
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    assert.equal(b.writer(), true);
    assert.equal(a.writer(), false);
    assert.equal(plain(a.R.store.locked()).reason, "window");
    assert.equal(a.R.app.tabLock(), null, "no notice covers the first window");
    assert.equal(a.R.app.modal(), false);
    assert.equal(b.R.tabs.windowId(), "win2abcdef");
    assert.equal(origin.locks.holder("marginalia.window.win2abcdef"), "B");
    assert.equal(b.R.cache.collection("b1").name, "Griffiths", "it read the library after the first window's writes");
    // what the second window writes is in the first one's copy only when that window has the role again
    await b.add(D30.BOOK("b2", "Sakurai"));
    assert.equal(a.R.cache.collection("b2"), null);
    await a.use();
    assert.equal(a.writer(), true);
    assert.equal(b.writer(), false);
    assert.equal(a.R.cache.collection("b2").name, "Sakurai");
    assert.equal(b.R.app.tabLock(), null);
    // the user stays in the window: nothing changes hands, nothing is read again
    const before = a.R.cache.collection("b2");
    await a.use();
    assert.equal(a.writer(), true);
    assert.ok(a.R.cache.collection("b2") === before);
    assert.deepEqual(a.logs.concat(b.logs), []);
  });

  test("a key or a click in a window that is not the writer is not acted on: the window takes the role first", async () => {
    const origin = appOrigin();
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    assert.equal(a.writer(), false);
    const first = a.fire("keydown");
    assert.deepEqual([first.defaultPrevented, first.stopped], [true, true], "this page's copy of the library may be old");
    await wait(30);
    assert.equal(a.writer(), true);
    const second = a.fire("keydown");
    assert.deepEqual([second.defaultPrevented, second.stopped], [false, false], "the writer's keys go through");
    // every kind of input that can change something
    for (const type of ["keydown", "keypress", "pointerdown", "mousedown", "click", "dblclick", "contextmenu", "paste", "cut", "drop"]) {
      const reader = a.writer() ? b : a;
      const e = reader.fire(type);
      assert.deepEqual([e.defaultPrevented, e.stopped], [true, true], type);
      await wait(30);
      assert.equal(reader.writer(), true, type + " took the role");
    }
    // looking is free: the wheel and the pointer do not take the role (the keys still go to the other window)
    const reader = a.writer() ? b : a;
    for (const type of ["wheel", "mousemove", "pointermove", "scroll", "keyup"]) {
      const e = reader.fire(type);
      assert.deepEqual([e.defaultPrevented, e.stopped], [false, false], type);
    }
    await wait(30);
    assert.equal(reader.writer(), false);
  });

  test("a save that comes while another window has the role: a notice that stays, the text is not lost, and this window does not take the role by itself", async () => {
    const origin = appOrigin();
    const a = await windowPage(origin, "A");
    await a.add(D30.BOOK("b1", "Griffiths"));
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    const refused = [];
    a.R.bus.on("prompt:refused", (e) => refused.push(e.prompt.text));
    assert.equal(await codeOf(a.R.cache.savePrompt({ collectionId: "b1", kind: "note", text: "typed in the first window" }, { content: true })), "locked");
    assert.deepEqual(refused, ["typed in the first window"], "the editor's own handling keeps the text (js/margin.js)");
    assert.ok(a.toasts.includes(NOT_SAVED), a.toasts.join(" | "));
    assert.equal(a.R.app.tabLock(), null, "not the notice of the browser version");
    await wait(60);
    assert.equal(a.writer(), false, "the window that is in use keeps the role");
    assert.equal(b.writer(), true);
    assert.equal(a.elements(a.doc.getElementById("toasts"), (n) => /toast__text/.test(n.className || "")).some((n) => n.textContent === NOT_SAVED), true,
      "the notice is still there when the user comes back");
    // back at the window, the same save goes through
    await a.use();
    const p = await a.R.cache.savePrompt({ collectionId: "b1", kind: "note", text: "typed in the first window" }, { content: true });
    assert.equal(stored(origin.idb, "prompts", p.id).text, "typed in the first window");
  });

  test("what another window changed shows when this window has the role again: a new name on its tab, a deleted book's tab back in the library", async () => {
    const origin = appOrigin();
    const a = await windowPage(origin, "A");
    await a.add(D30.BOOK("b1", "Griffiths"), D30.BOOK("b2", "Sakurai"));
    await a.R.app.route("reader", { collectionId: "b1" });
    a.R.tabs.open({ screen: "reader", collectionId: "b2" }, { background: true });
    await wait(5);
    assert.equal(a.names(), "Griffiths* | Sakurai");
    assert.equal(a.doc.title, "Griffiths \u2014 Marginalia");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    await b.R.cache.saveCollection(Object.assign({}, b.R.cache.collection("b1"), { name: "Griffiths QM" }));
    await b.R.cache.removeCollection("b2");
    assert.equal(a.names(), "Griffiths* | Sakurai", "not yet");
    await a.use();
    assert.equal(a.names(), "Griffiths QM* | Library");
    assert.equal(a.doc.title, "Griffiths QM \u2014 Marginalia");
    assert.deepEqual(a.logs, []);
  });

  test("each window keeps its own list of tabs, also while it is not the writer; a window that closes for good forgets its list", async () => {
    const origin = appOrigin();
    const a = await windowPage(origin, "A");
    await a.add(D30.BOOK("b1", "Griffiths"), D30.DECK("d1", "Physics"));
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(SAVE_WAIT);
    assert.deepEqual(a.list(), { v: 1, active: 0, tabs: [LIB] });
    assert.deepEqual(b.list(), { v: 1, active: 0, tabs: [LIB] });
    assert.equal(a.key, "marginalia.tabs");
    assert.equal(b.key, "marginalia.tabs.win2abcdef");
    // the first window is a reader now; a tab comes into it (as a tab dropped on its strip): its list is stored all the same
    assert.equal(a.writer(), false);
    assert.equal(a.R.tabs.adopt([{ screen: "deck", collectionId: "d1", position: null, editing: null }]), 1);
    await wait(SAVE_WAIT);
    assert.deepEqual(a.list().tabs.map((x) => x.screen), ["library", "deck"]);
    assert.equal(a.writer(), false, "its own list needs no role");
    assert.equal(b.list().tabs.length, 1, "the other window's list is not touched");
    // the second window closes for good: its list goes, and nothing is stored after that
    assert.equal(b.R.tabs.forget(), true);
    assert.equal(b.list(), null);
    b.R.tabs.open();
    await wait(SAVE_WAIT);
    b.W.dispatchEvent({ type: "pagehide" });
    assert.equal(b.list(), null);
    assert.deepEqual(a.list().tabs.length, 2);
  });

  const lastTime = lastTimeBooks;

  test("after a restart the first window takes over the tabs of the windows that are gone, and of no window that is there", async () => {
    const origin = await lastTime({
      "marginalia.tabs": { v: 1, active: 1, tabs: [LIB, { screen: "reader", collectionId: "b1", position: { pageIndex: 4, fraction: 0.5, zoom: "fit" } }] },
      "marginalia.tabs.gonewin111": { v: 1, active: 0, tabs: [{ screen: "reader", collectionId: "b2", position: PLACE }, LIB] },
      "marginalia.tabs.gonewin222": { v: 1, active: 0, tabs: [{ screen: "deck", collectionId: "d1", position: null }] },
      "marginalia.tabs.herewin333": { v: 1, active: 0, tabs: [{ screen: "reader", collectionId: "b2", position: null }] },
      "marginalia.tabs.NOT-A-WINDOW": "x",
      "marginalia.tabsmith": "x"
    });
    origin.locks.manager("H").request("marginalia.window.herewin333", () => new Promise(() => {}));     // a window that is there
    await wait(5);
    const a = await windowPage(origin, "A");
    await wait(40);
    assert.equal(a.names(), "Library | Griffiths* | Sakurai | Physics", "its own tabs first, then the tabs that came; a library tab of a closed window holds nothing");
    assert.deepEqual(a.opens[a.opens.length - 1], ["b1", { position: { pageIndex: 4, fraction: 0.5, zoom: "fit" } }], "the tab that was on screen stays on screen");
    assert.equal(origin.ls.has("marginalia.tabs.gonewin111"), false);
    assert.equal(origin.ls.has("marginalia.tabs.gonewin222"), false);
    assert.equal(origin.ls.has("marginalia.tabs.herewin333"), true, "a window that is open keeps its list");
    assert.equal(origin.ls.get("marginalia.tabs.NOT-A-WINDOW"), "x");
    assert.equal(origin.ls.get("marginalia.tabsmith"), "x");
    // a tab that came keeps its place
    a.R.tabs.select(a.R.tabs.list()[2].id);
    await wait(5);
    assert.deepEqual(a.opens[a.opens.length - 1], ["b2", { position: PLACE }]);
    await wait(SAVE_WAIT);
    assert.deepEqual(a.list().tabs.map((x) => x.collectionId), [null, "b1", "b2", "d1"]);
    assert.deepEqual(a.logs, []);
    // a window with an id never takes lists over
    origin.ls.set("marginalia.tabs.gonewin444", JSON.stringify({ v: 1, active: 0, tabs: [{ screen: "deck", collectionId: "d1", position: null }] }));
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(40);
    assert.equal(b.names(), "Library*");
    assert.equal(origin.ls.has("marginalia.tabs.gonewin444"), true, "it waits for the first window of the next start");
  });

  test("a first window with nothing of its own shows the tabs that came; with a link, or with 20 tabs, its own go first", async () => {
    // nothing stored for the first window (it was closed before the quit): the tabs that came take its place
    const fresh = await lastTime({ "marginalia.tabs.gonewin111": { v: 1, active: 1, tabs: [{ screen: "reader", collectionId: "b2", position: PLACE }, { screen: "deck", collectionId: "d1", position: null }] } });
    const a = await windowPage(fresh, "A");
    await wait(40);
    assert.equal(a.names(), "Sakurai* | Physics");
    assert.deepEqual(a.opens[a.opens.length - 1], ["b2", { position: PLACE }]);
    assert.equal(a.doc.title, "Sakurai \u2014 Marginalia");
    // only library tabs came: nothing to take, the first window keeps its library tab
    const empty = await lastTime({ "marginalia.tabs.gonewin111": { v: 1, active: 0, tabs: [LIB, LIB] } });
    const e = await windowPage(empty, "A");
    await wait(40);
    assert.equal(e.names(), "Library*");
    assert.equal(empty.ls.has("marginalia.tabs.gonewin111"), false);
    // the app was opened with a link: its place is on screen, and the tabs that came stand after it
    const linked = await lastTime({ "marginalia.tabs.gonewin111": { v: 1, active: 0, tabs: [{ screen: "deck", collectionId: "d1", position: null }] } });
    const l = await windowPage(linked, "A", { hash: "#reader/b1" });
    await wait(40);
    assert.equal(l.names(), "Griffiths* | Physics");
    // no room: the first window's own 20 tabs stay, and what found no room stays stored for a later start
    const many = { v: 1, active: 0, tabs: Array.from({ length: 19 }, () => LIB).concat([{ screen: "reader", collectionId: "b1", position: null }]) };
    const full = await lastTime({ "marginalia.tabs": many, "marginalia.tabs.gonewin111": { v: 1, active: 0, tabs: [{ screen: "deck", collectionId: "d1", position: null }] } });
    const f = await windowPage(full, "A");
    await wait(40);
    assert.equal(f.R.tabs.list().length, 20);
    assert.equal(f.R.tabs.list().some((x) => x.screen === "deck"), false);
    assert.deepEqual(JSON.parse(full.ls.get("marginalia.tabs.gonewin111")).tabs, [{ screen: "deck", collectionId: "d1", position: null }]);
    // the app starts again with fewer tabs of its own: now the tab comes
    f.die();
    full.ls.set("marginalia.tabs", JSON.stringify({ v: 1, active: 0, tabs: [LIB, { screen: "reader", collectionId: "b1", position: null }] }));
    const g = await windowPage(full, "A2");
    await wait(40);
    assert.equal(g.names(), "Library* | Griffiths | Physics");
    assert.equal(full.ls.has("marginalia.tabs.gonewin111"), false);
  });

  test("more tabs than one window holds: 20 come back at once (a first window with nothing of its own gives up its library tab), the rest later", async () => {
    const fifteen = (id) => Array.from({ length: 15 }, (x, i) => ({ screen: "reader", collectionId: id, position: { pageIndex: i, fraction: 0, zoom: "fit" } }));
    const origin = await lastTime({
      "marginalia.tabs.gonewin111": { v: 1, active: 3, tabs: fifteen("b1") },
      "marginalia.tabs.gonewin222": { v: 1, active: 0, tabs: fifteen("b2") }
    });
    const a = await windowPage(origin, "A");
    await wait(40);
    assert.equal(a.R.tabs.list().length, 20, "all 15 of the first list, and 5 of the second");
    assert.deepEqual(a.R.tabs.list().map((x) => x.collectionId).join(" "), Array(15).fill("b1").concat(Array(5).fill("b2")).join(" "));
    assert.equal(origin.ls.has("marginalia.tabs.gonewin111"), false);
    const rest = JSON.parse(origin.ls.get("marginalia.tabs.gonewin222"));
    assert.deepEqual(rest.tabs.map((x) => x.position.pageIndex), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14], "the ten that found no room, in order, with their places");
    assert.deepEqual(a.logs, []);
  });

  test("the stored list keeps the place of the tab on screen, so a window finds its place after a restart also when it was not the writer", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    await a.R.app.route("reader", { collectionId: "b1" });
    const b = await windowPage(origin, "B", { w: "win2abcdef" });      // the first window is a reader from here on
    await wait(20);
    assert.equal(a.writer(), false);
    await wait(SAVE_WAIT);                                   // no save of the list is on its way now
    assert.deepEqual(a.list().tabs[0].position, { pageIndex: 0, fraction: 0, zoom: "fit" });
    a.reader.pos = { pageIndex: 8, fraction: 0.3, zoom: "fit" };       // scrolled with the wheel, the pointer over the window
    await wait(SAVE_WAIT);
    assert.deepEqual(a.list().tabs[0].position, { pageIndex: 0, fraction: 0, zoom: "fit" }, "nothing is stored before the scroll has settled");
    a.R.bus.emit("scroll:settled", { pageIndex: 8, fraction: 0.3 });
    await wait(SAVE_WAIT);
    assert.deepEqual(a.list(), { v: 1, active: 0, tabs: [{ screen: "reader", collectionId: "b1", position: { pageIndex: 8, fraction: 0.3, zoom: "fit" } }] });
    assert.equal(a.writer(), false, "scrolling does not take the role");
    // the app quits and starts again
    a.die(); b.die();
    await wait(5);
    const again = await windowPage(origin, "A2");
    await wait(40);
    assert.equal(again.names(), "Griffiths*");
    assert.deepEqual(again.opens[0], ["b1", { position: { pageIndex: 8, fraction: 0.3, zoom: "fit" } }]);
  });

  test("Move Tab to New Window: the tab's list is written under a new id, the window is asked for, and the tab leaves this window", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    await a.R.app.route("reader", { collectionId: "b1" });
    a.reader.pos = { pageIndex: 5, fraction: 0.4, zoom: 2 };
    a.R.tabs.open();                                         // a library tab; the book's tab keeps its place
    await wait(5);
    assert.equal(a.names(), "Griffiths | Library*");
    const book = a.R.tabs.list()[0].id;
    assert.equal(await a.R.tabs.moveToWindow(book, { x: 900, y: 300 }), true);
    assert.equal(a.names(), "Library*");
    assert.equal(a.opened.length, 1);
    const m = /^\/\?w=([a-z0-9]{10})$/.exec(a.opened[0].url);
    assert.ok(m, "the address of the new window: " + a.opened[0].url);
    assert.equal(a.opened[0].target, "_blank");
    assert.equal(a.opened[0].features, "popup=yes,width=1100,height=800,left=820,top=280", "as large as this window, where the tab was dropped");
    assert.deepEqual(JSON.parse(origin.ls.get("marginalia.tabs." + m[1])), { v: 1, active: 0,
      tabs: [{ screen: "reader", collectionId: "b1", position: { pageIndex: 5, fraction: 0.4, zoom: 2 }, editing: null }] });
    assert.deepEqual(a.R.tabs.run("reopenTab"), false, "a tab that moved out is no closed tab");
    // the new window starts on that list: the book, at its place
    const b = await windowPage(origin, "B", { w: m[1] });
    await wait(20);
    assert.equal(b.names(), "Griffiths*");
    assert.deepEqual(b.opens[b.opens.length - 1], ["b1", { position: { pageIndex: 5, fraction: 0.4, zoom: 2 } }]);
    assert.equal(b.doc.title, "Griffiths \u2014 Marginalia");
    assert.equal(b.writer(), true, "the new window is the one in use");
    await wait(600);
    assert.equal(a.names(), "Library*", "the window came: nothing comes back");
    assert.deepEqual(a.toasts.filter((x) => /new window/.test(String(x))), []);
    // the tab on screen moves out with the menu command (no place given): next to this window
    await a.use();
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, {});
    await wait(5);
    assert.equal(a.names(), "Library | Physics*");
    assert.equal(await a.R.tabs.moveToWindow(), true);
    assert.equal(a.names(), "Library*");
    assert.equal(a.opened[1].features, "popup=yes,width=1100,height=800");
    assert.deepEqual(a.logs.concat(b.logs), []);
  });

  test("a tab does not move out with one tab, behind a dialog, outside the Mac app, with 8 windows, or when the window cannot be asked for", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    assert.equal(await a.R.tabs.moveToWindow(), false, "one tab");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    const keys = () => Array.from(origin.ls.keys()).filter((k) => k.indexOf("marginalia.tabs.") === 0);
    const modal = a.R.app.modal;
    a.R.app.modal = () => true;                              // a dialog is up
    assert.equal(await a.R.tabs.moveToWindow(), false);
    a.R.app.modal = modal;
    assert.equal(await a.R.tabs.moveToWindow("no-such-tab"), false);
    // 8 windows are open (this one and seven more)
    for (let i = 1; i <= 7; i++) origin.locks.manager("W" + i).request("marginalia.window.otherwin0" + i, () => new Promise(() => {}));
    await wait(10);
    assert.equal(await a.R.tabs.moveToWindow(), false);
    assert.ok(a.toasts.includes("Close a window first: 8 windows are open"), a.toasts.join(" | "));
    origin.locks.kill("W7");
    await wait(10);
    // the window cannot be asked for: the tab stays, and no list is left behind
    a.W.open = () => { throw new Error("blocked"); };
    assert.equal(await a.R.tabs.moveToWindow(), false);
    assert.equal(a.names(), "Library | Griffiths*");
    assert.deepEqual(keys(), []);
    assert.deepEqual(a.opened, []);
    // a browser page has no windows of the app
    const web = appOrigin();
    const b = await windowPage(web, "B", { app: false });
    b.R.tabs.open();
    assert.equal(await b.R.tabs.moveToWindow(), false);
    assert.deepEqual(b.opened, []);
    assert.equal(b.R.tabs.list().length, 2);
  });

  test("a window that never comes: its tab is back in this window, with a notice; a window that is there keeps its tab", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    a.reader.pos = { pageIndex: 2, fraction: 0.1, zoom: "fit" };
    assert.equal(await a.R.tabs.moveToWindow(), true);      // this window will never come
    assert.equal(a.names(), "Library | Physics*");
    const id = /w=([a-z0-9]+)$/.exec(a.opened[0].url)[1];
    assert.equal(origin.ls.has("marginalia.tabs." + id), true);
    assert.equal(await a.R.tabs.moveToWindow(), true);      // this one comes: its page says that it is there
    assert.equal(a.names(), "Library*");
    const there = /w=([a-z0-9]+)$/.exec(a.opened[1].url)[1];
    origin.locks.manager("W").request("marginalia.window." + there, () => new Promise(() => {}));
    await wait(4600);                                        // WINDOW_WAIT_MS
    assert.equal(a.names(), "Library* | Griffiths", "the tab of the window that never came is back; the other tab is in its window");
    assert.equal(a.toasts.filter((x) => x === "The new window did not open: its tab is back in this window").length, 1);
    assert.equal(origin.ls.has("marginalia.tabs." + id), false, "no list is left for the next start");
    assert.equal(origin.ls.has("marginalia.tabs." + there), true, "the list of the window that is there is its own");
    a.R.tabs.select(a.R.tabs.list()[1].id);
    await wait(5);
    assert.deepEqual(a.opens[a.opens.length - 1], ["b1", { position: { pageIndex: 2, fraction: 0.1, zoom: "fit" } }], "with its place");
  });

  test("Merge All Windows, as the pages do it: dump() gives the tabs with their places, take() says which came in, drop() lets exactly those go", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    await a.R.app.route("reader", { collectionId: "b1" });
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    await wait(5);
    a.reader.pos = { pageIndex: 3, fraction: 0.6, zoom: 1.25 };
    const dumped = plain(a.R.tabs.dump());
    assert.deepEqual(dumped, [{ screen: "reader", collectionId: "b1", position: { pageIndex: 3, fraction: 0.6, zoom: 1.25 }, editing: null },
      { screen: "deck", collectionId: "d1", position: null, editing: null }], "the tab on screen gives the place it has now");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    assert.deepEqual(plain(b.R.tabs.take(dumped)), [0, 1]);
    assert.equal(b.names(), "Library* | Griffiths | Physics", "after the tab on screen, which stays on screen");
    b.R.tabs.select(b.R.tabs.list()[1].id);
    await wait(5);
    assert.deepEqual(b.opens[b.opens.length - 1], ["b1", { position: { pageIndex: 3, fraction: 0.6, zoom: 1.25 } }]);
    // the window that gave them lets them go: all of them → its list is forgotten (the Mac app then closes it)
    await wait(SAVE_WAIT);
    assert.notEqual(a.list(), null);
    assert.equal(a.R.tabs.drop([0, 1]), 0);
    assert.equal(a.list(), null);
    // drop() goes by the last dump(): without one, or with something that is no list, nothing goes
    assert.equal(b.R.tabs.drop([0]), -1, "no dump before");
    assert.deepEqual(plain(b.R.tabs.dump()).map((x) => x.screen), ["library", "reader", "deck"]);
    for (const junk of [1, "0", null, undefined, {}]) assert.equal(b.R.tabs.drop(junk), -1, String(junk));
    assert.equal(b.R.tabs.drop([7, -1, 1.5, "1", null]), 3, "indexes that name no tab of the dump: nothing goes");
    assert.equal(b.R.tabs.drop([0]), -1, "a dump is good for one drop");
    // a window that gave only some keeps the rest; the tab on screen went: the next one that stays takes the screen
    b.R.tabs.dump();
    assert.equal(b.R.tabs.drop([1, 1]), 2);
    assert.equal(b.names(), "Library | Physics*");
    assert.deepEqual(b.logs.concat(a.logs), []);
  });

  test("the window in front takes only the tabs it knows and has room for, and the other window keeps the rest (no tab twice, none lost)", async () => {
    const origin = await lastTime({});
    const front = await windowPage(origin, "A");
    const other = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    other.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    other.R.tabs.open({ screen: "reader", collectionId: "b2" }, { background: true });
    await wait(5);
    assert.equal(other.names(), "Library* | Sakurai | Griffiths");
    // in the window in front the user deletes Sakurai; the other window's copy still has it
    await front.use();
    await front.R.cache.removeCollection("b2");
    const dumped = plain(other.R.tabs.dump());
    const took = plain(front.R.tabs.take(dumped));
    assert.deepEqual(took, [0, 2], "not the tab of the book that is gone");
    assert.equal(front.names(), "Library* | Library | Griffiths");
    assert.equal(other.R.tabs.drop(took), 1);
    assert.equal(other.names(), "Sakurai*", "exactly the tabs that came in went; this one stays until its window reads the library again");
    await other.use();
    assert.equal(other.names(), "Library*", "… and then its book is gone here too");
    // no room in front for all: what came in goes, the rest stays in its window
    const third = await windowPage(origin, "C", { w: "win3abcdef" });
    await wait(20);
    third.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    third.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    await front.use();
    assert.equal(front.R.tabs.adopt(Array.from({ length: 30 }, () => LIB)), 17);
    assert.equal(front.R.tabs.list().length, 20);
    assert.deepEqual(plain(front.R.tabs.take(plain(third.R.tabs.dump()))), []);
    assert.ok(front.toasts.includes("Close a tab first: 20 tabs are open"));
    assert.equal(third.R.tabs.list().length, 3);
    front.R.tabs.close(front.R.tabs.list()[19].id);
    front.R.tabs.close(front.R.tabs.list()[18].id);
    const some = plain(front.R.tabs.take(plain(third.R.tabs.dump())));
    assert.deepEqual(some, [0, 1], "room for two of the three");
    assert.equal(third.R.tabs.drop(some), 1);
    assert.equal(third.names(), "Griffiths*");
    // what is no tab of this library does not come in
    assert.deepEqual(plain(third.R.tabs.take([null, "x", { screen: "reader", collectionId: "no-such-book" }, { screen: "bogus" }])), []);
    assert.equal(third.R.tabs.adopt("x"), 0);
    assert.equal(third.R.tabs.adopt([]), 0);
    assert.deepEqual(plain(third.R.tabs.take("x")), []);
  });

  test("a window with a review or a dialog on screen gives no tabs and takes none (its tabs stay where they are)", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    const modal = a.R.app.modal;
    a.R.app.modal = () => true;                              // Settings is open there
    assert.equal(a.R.tabs.dump(), null);
    assert.equal(a.R.tabs.adopt([LIB]), 0);
    assert.deepEqual(plain(a.R.tabs.take([LIB])), []);
    assert.equal(a.R.tabs.list().length, 2);
    a.R.app.modal = modal;
    a.R.review.isActive = () => true;                       // a review
    assert.equal(a.R.tabs.dump(), null);
    assert.equal(a.R.tabs.adopt([LIB]), 0);
    a.R.review.isActive = () => false;
    assert.equal(plain(a.R.tabs.dump()).length, 2);
    assert.equal(a.R.tabs.adopt([LIB]), 1);
    // at a place in the strip, and on screen
    assert.equal(a.R.tabs.adopt([{ screen: "reader", collectionId: "b2", position: PLACE, editing: null }], 0, { active: true }), 1);
    await wait(5);
    assert.equal(a.names(), "Sakurai* | Library | Library | Griffiths");
    assert.deepEqual(a.opens[a.opens.length - 1], ["b2", { position: PLACE }]);
  });

  test("M.app.leave(): a window that closes for good forgets its tabs at once; a place it held back is stored first, with the role", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(SAVE_WAIT);
    assert.equal(a.writer(), false);
    assert.notEqual(a.list(), null);
    // nothing held back: the list goes, and the role stays where it is
    assert.equal(await a.R.app.leave(), true);
    assert.equal(a.list(), null);
    assert.equal(a.writer(), false);
    assert.equal(b.writer(), true);
    // a place was held back: the window takes the role (which stores it), then it is done
    const c = await windowPage(origin, "C", { w: "win3abcdef" });
    await wait(20);
    await b.use();
    assert.equal(c.writer(), false);
    const order = [];
    c.R.reader.unsaved = () => true;
    c.R.bus.on("store:writer", (e) => order.push("writer:" + e.writer));
    const left = c.R.app.leave().then((v) => { order.push("left:" + v); });
    assert.equal(origin.ls.has("marginalia.tabs.win3abcdef"), false, "the list goes at once");
    await left;
    assert.deepEqual(order, ["writer:true", "left:true"]);
    assert.equal(b.writer(), false);
  });

  test("a window that waits for the role says so; the notice goes when the role comes", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    let done;
    a.R.store.during(new Promise((r) => { done = r; }));     // the first window adds a PDF (or imports): it keeps the role
    const WAITING = "Waiting for another Marginalia window to finish its work\u2026";
    const b = await windowPage(origin, "B", { w: "win2abcdef" });       // it starts as a reader after its own wait
    assert.equal(b.writer(), false);
    assert.equal(a.writer(), true);
    assert.ok(b.toasts.includes(WAITING), b.toasts.join(" | "));
    const e = b.fire("keydown");
    assert.deepEqual([e.defaultPrevented, e.stopped], [true, true], "what the user does there is not acted on yet");
    assert.equal(b.toasts.filter((x) => x === WAITING).length, 1, "said once");
    const shown = () => b.elements(b.doc.getElementById("toasts"), (n) => /toast__text/.test(n.className || "")).some((n) => n.textContent === WAITING);
    assert.equal(shown(), true);
    done();
    await wait(60);
    assert.equal(b.writer(), true);
    assert.equal(a.writer(), false);
    assert.equal(shown(), false);
  });

  test("one review at a time among the windows: the second window is told why it cannot start one", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    const fake = (p) => {
      p.review = { on: false, starts: 0 };
      p.R.review.start = async () => { p.review.starts++; p.review.on = true; return { ok: true }; };
      p.R.review.isActive = () => p.review.on;
      p.R.review.isSuspended = () => false;
      p.end = () => { p.review.on = false; p.R.bus.emit("review:ended", {}); };
    };
    fake(a); fake(b);
    assert.deepEqual(plain(await a.R.app.startReview("all")), { ok: true });
    assert.equal(origin.locks.holder("marginalia.review"), "A");
    assert.equal(await b.R.app.startReview("all"), null);
    assert.equal(b.review.starts, 0);
    assert.ok(b.toasts.includes("A review is open in another window"), b.toasts.join(" | "));
    // the first window's review ends: the second may start one
    a.end();
    await wait(20);
    assert.equal(origin.locks.holder("marginalia.review"), null);
    assert.deepEqual(plain(await b.R.app.startReview("all")), { ok: true });
    assert.equal(origin.locks.holder("marginalia.review"), "B");
    // a window that is gone in the middle of its review does not block the others
    b.die();
    await wait(20);
    assert.deepEqual(plain(await a.R.app.startReview("all")), { ok: true });
    assert.equal(a.review.starts, 2);
  });

  test("an import takes the role first and keeps it until it has ended", async () => {
    const origin = await lastTime({});
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    assert.equal(a.writer(), false);
    const text = a.R.exporter.toJSON({ collections: [D30.BOOK("b9", "Imported")], prompts: [], attachments: [], settings: {}, folders: [] });
    // the second window changes a book that the first one's copy does not know yet
    await b.R.cache.saveCollection(Object.assign({}, b.R.cache.collection("b1"), { name: "Griffiths QM" }));
    const kept = [];
    const during = a.R.store.during;
    a.R.store.during = (work) => { kept.push("during"); return during(work); };
    const report = await a.R.exporter.importJSON(text, {});
    assert.ok(report, "the import ran");
    assert.deepEqual(kept, ["during"]);
    assert.equal(a.writer(), true, "it took the role");
    assert.equal(b.writer(), false);
    assert.equal(a.R.cache.collection("b1").name, "Griffiths QM", "and read the library as it was before it merged");
    assert.equal(stored(origin.idb, "collections", "b9").name, "Imported");
    assert.equal(stored(origin.idb, "collections", "b1").name, "Griffiths QM");
  });
});

// ------------------------------------------------------------------------------------------------- a tab that is dragged
// One DataTransfer for the whole gesture, as the pages of the origin see it: what the strip that takes the tab sets
// as dropEffect is what the tab's own window reads when the drag ends.
function transfer() {
  const data = new Map();
  return { types: [], effectAllowed: "none", dropEffect: "none",
    setData(type, value) { data.set(type, String(value)); if (!this.types.includes(type)) this.types.push(type); },
    getData(type) { return data.has(type) ? data.get(type) : ""; } };
}
function dragEvent(type, dt, o) {
  const e = Object.assign({ type, dataTransfer: dt, clientX: 0, clientY: 0, screenX: 0, screenY: 0, defaultPrevented: false, stopped: false }, o || {});
  e.preventDefault = () => { e.defaultPrevented = true; };
  e.stopPropagation = () => { e.stopped = true; };
  e.stopImmediatePropagation = e.stopPropagation;
  return e;
}
const hasClass = (el, c) => (" " + (el.className || "") + " ").indexOf(" " + c + " ") >= 0;
const tabEls = (p) => Array.from(p.host().querySelectorAll(".tabs__tab"));
// the tabs stand 100 wide, side by side from the left edge
const layout = (p) => tabEls(p).forEach((el, i) => { el.getBoundingClientRect = () => ({ left: i * 100, top: 0, width: 100, height: 30 }); });
const dragStart = (p, i, dt) => { const el = tabEls(p)[i], e = dragEvent("dragstart", dt); el.dispatchEvent(e); return { el, e }; };
const dragOver = (p, dt, x) => { layout(p); const e = dragEvent("dragover", dt, { clientX: x }); p.host().dispatchEvent(e); return e; };
const dropOn = (p, dt, x) => { layout(p); const e = dragEvent("drop", dt, { clientX: x }); p.host().dispatchEvent(e); return e; };
const dragEnd = (el, dt, o) => { const e = dragEvent("dragend", dt, o); el.dispatchEvent(e); return e; };
// the strip is 34 high and as wide as the window; its tabs stand 100 wide
const stripAt = (p) => { p.host().getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 34, width: 1000, height: 34 }); layout(p); };
// an event on the page (not on the strip), as the document sees it first
const onPage = (p, type, dt, o) => { stripAt(p); const e = dragEvent(type, dt, Object.assign({ target: p.doc.body }, o || {})); p.doc.dispatchEvent(e); return e; };
// what the windows say to each other about tabs, as one more page of the origin hears it; and a word from such a page
const words = (origin) => { const heard = [], ch = new (origin.Channel("ear"))("marginalia.tabs"); ch.addEventListener("message", (ev) => heard.push(ev.data)); return heard; };
const say = (origin, data) => new (origin.Channel("voice"))("marginalia.tabs").postMessage(data);
const numberOf = (dt) => JSON.parse(dt.getData(TABS.TAB_TYPE)).drag;
const anyLifted = (p) => tabEls(p).some((el) => hasClass(el, "is-dragging"));

describe("a tab that is dragged (HTML drag and drop on the strip)", () => {
  test("along its own strip the tab takes another place; nothing else happens to it", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    await wait(5);
    assert.equal(a.names(), "Library* | Physics | Griffiths");
    assert.deepEqual(tabEls(a).map((el) => el.getAttribute("draggable")), ["true", "true", "true"]);
    // the library tab goes to the end
    let dt = transfer(), d = dragStart(a, 0, dt);
    assert.equal(d.e.defaultPrevented, false);
    assert.equal(dt.effectAllowed, "move");
    const o = dragOver(a, dt, 160);
    assert.equal(o.defaultPrevented, true);
    assert.deepEqual(tabEls(a).map((el) => hasClass(el, "is-drop")), [false, false, true], "the mark: before the tab whose middle is right of the pointer");
    dragOver(a, dt, 290);
    assert.deepEqual(tabEls(a).map((el) => hasClass(el, "is-drop")), [false, false, false]);
    assert.equal(hasClass(a.host().querySelector(".tabs__new"), "is-drop"), true, "at the end: on +");
    assert.equal(dropOn(a, dt, 290).defaultPrevented, true);
    assert.equal(a.names(), "Physics | Griffiths | Library*");
    assert.equal(hasClass(a.host().querySelector(".tabs__new"), "is-drop"), false);
    dragEnd(d.el, dt, { clientX: 290, clientY: 10 });        // its own strip took it (dropEffect "move"): it does not leave
    await wait(20);
    assert.equal(a.names(), "Physics | Griffiths | Library*");
    assert.deepEqual(a.opened, []);
    // back to the front; between two tabs
    dt = transfer(); d = dragStart(a, 2, dt);
    dropOn(a, dt, 10);
    dragEnd(d.el, dt, {});
    assert.equal(a.names(), "Library* | Physics | Griffiths");
    dt = transfer(); d = dragStart(a, 0, dt);
    dropOn(a, dt, 160);
    dragEnd(d.el, dt, {});
    assert.equal(a.names(), "Physics | Library* | Griffiths");
    // dropped where it is: nothing changes
    dt = transfer(); d = dragStart(a, 1, dt);
    dropOn(a, dt, 120);
    dragEnd(d.el, dt, {});
    dt = transfer(); d = dragStart(a, 1, dt);
    dropOn(a, dt, 180);
    dragEnd(d.el, dt, {});
    assert.equal(a.names(), "Physics | Library* | Griffiths");
    await wait(SAVE_WAIT);
    assert.deepEqual(a.list().tabs.map((x) => x.collectionId), ["d1", null, "b1"]);
    assert.equal(a.list().active, 1);
    assert.equal(a.R.tabs.move(a.R.tabs.list()[2].id, 0), true, "M.tabs.move does the same");
    assert.equal(a.names(), "Griffiths | Physics | Library*");
    assert.equal(a.R.tabs.move("no-such-tab", 0), false);
    assert.deepEqual(a.logs, []);
  });

  test("onto another window's strip the tab moves into that window, where it was dropped, with its place", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    await a.R.app.route("reader", { collectionId: "b1" });
    a.R.tabs.open({}, { background: true });
    await wait(5);
    const b = await windowPage(origin, "B", { w: "win2abcdef" });     // one tab: it shows no strip
    await wait(20);
    await a.use();                                           // the user is in the first window
    assert.equal(a.names(), "Griffiths* | Library");
    a.reader.pos = { pageIndex: 6, fraction: 0.2, zoom: "fit" };
    assert.equal(b.hidden(), true);
    const dt = transfer(), d = dragStart(a, 0, dt);
    const carried = JSON.parse(dt.getData(TABS.TAB_TYPE));
    assert.match(carried.drag, /^[a-z0-9]{10}$/, "the drag's number");
    assert.deepEqual(dt.types, [TABS.TAB_TYPE, TABS.DRAG_TYPE + carried.drag], "the tab, and a type of this drag's own");
    assert.deepEqual(carried.tab, { screen: "reader", collectionId: "b1", position: { pageIndex: 6, fraction: 0.2, zoom: "fit" }, editing: null });
    assert.equal(carried.w, "", "the first window");
    // over the other window: its strip shows, as the place to drop
    b.doc.dispatchEvent(dragEvent("dragover", dt));
    assert.equal(b.hidden(), false);
    assert.equal(hasClass(b.host(), "is-dropzone"), true);
    assert.equal(dragOver(b, dt, 20).defaultPrevented, true, "the strip takes the tab");
    assert.equal(dt.dropEffect, "move");
    // the drop as the window sees it first: a window that is not the writer lets a tab through (and takes the role)
    assert.equal(b.writer(), false);
    const seen = dragEvent("drop", dt);
    b.W.dispatchEvent(seen);
    assert.deepEqual([seen.defaultPrevented, seen.stopped], [false, false]);
    assert.equal(dropOn(b, dt, 20).defaultPrevented, true);
    await wait(40);
    assert.equal(b.names(), "Griffiths* | Library", "before the tab it was dropped on, and on screen");
    assert.deepEqual(b.opens[b.opens.length - 1], ["b1", { position: { pageIndex: 6, fraction: 0.2, zoom: "fit" } }]);
    assert.equal(hasClass(b.host(), "is-dropzone"), false);
    assert.equal(b.writer(), true);
    // the tab's own window lets it go when the drag ends
    dragEnd(d.el, dt, { clientX: -300, clientY: 20, screenX: 900, screenY: 200 });
    await wait(20);
    assert.equal(a.names(), "Library*");
    assert.deepEqual(a.opened, [], "no window of its own: the other window has it");
    assert.equal(a.R.tabs.run("reopenTab"), false, "it is no closed tab");
    await wait(SAVE_WAIT);
    assert.deepEqual(a.list().tabs.map((x) => x.screen), ["library"]);
    assert.deepEqual(b.list().tabs.map((x) => x.screen), ["reader", "library"]);
    // a drag that only passed over a window with one tab: its strip goes again
    const c = await windowPage(origin, "C", { w: "win3abcdef" });
    await wait(20);
    const dt2 = transfer();
    dragStart(b, 1, dt2);
    c.doc.dispatchEvent(dragEvent("dragover", dt2));
    assert.equal(c.hidden(), false);
    await wait(400);
    assert.equal(c.hidden(), false, "an engine may let half a second pass between two dragovers: the strip stays that long");
    await wait(OVER_WAIT - 400);
    assert.equal(c.hidden(), true);
    assert.deepEqual(a.logs.concat(b.logs, c.logs), []);
  });

  test("dropped outside every window the tab gets a window of its own there; a drag that ends over its own window with no drop (Escape) changes nothing", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    await wait(5);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    // the drag ends over its own window and no drop came (the page takes its own tab, so this is a drag that was
    // cancelled with Escape): nothing
    let dt = transfer(), d = dragStart(a, 1, dt);
    dragEnd(d.el, dt, { clientX: 400, clientY: 300, screenX: 600, screenY: 500 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    assert.deepEqual(a.opened, []);
    // left of the window (the desktop, or another program): a window at that point of the screen
    dt = transfer(); d = dragStart(a, 1, dt);
    dragEnd(d.el, dt, { clientX: -120, clientY: 300, screenX: 1500, screenY: 240 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Library | Physics*");
    assert.equal(a.opened.length, 1);
    assert.match(a.opened[0].url, /^\/\?w=[a-z0-9]{10}$/);
    assert.equal(a.opened[0].features, "popup=yes,width=1100,height=800,left=1420,top=220");
    // below the window; a tab that is not on screen
    dt = transfer(); d = dragStart(a, 0, dt);
    dragEnd(d.el, dt, { clientX: 300, clientY: 900, screenX: 320, screenY: 950 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Physics*");
    assert.equal(a.opened.length, 2);
    // a drop that another program took as a copy is no move: with the pointer inside the window nothing happens
    a.R.tabs.open();
    await wait(5);
    dt = transfer(); d = dragStart(a, 0, dt);
    dt.dropEffect = "copy";
    dragEnd(d.el, dt, { clientX: 100, clientY: 100 });
    await wait(DROP_WAIT);
    assert.equal(a.R.tabs.list().length, 2);
    assert.equal(a.opened.length, 2);
    // a dialog is up: the drag does not start
    const modal = a.R.app.modal;
    a.R.app.modal = () => true;
    dt = transfer(); d = dragStart(a, 0, dt);
    assert.equal(d.e.defaultPrevented, true);
    assert.deepEqual(dt.types, []);
    a.R.app.modal = modal;
    dragEnd(d.el, dt, { clientX: -50, clientY: -50 });
    await wait(DROP_WAIT);
    assert.equal(a.opened.length, 2, "a drag that never started moves nothing");
    assert.deepEqual(a.logs, []);
  });

  test("a strip with 20 tabs takes no tab of another window, and the tab is not lost; a browser page takes no tab of another page", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    assert.equal(b.R.tabs.adopt(Array.from({ length: 19 }, () => LIB)), 19);
    const heard = words(origin);
    const dt = transfer(), d = dragStart(a, 1, dt);
    // the strip's own handlers take nothing, and mark no place …
    assert.equal(dragOver(b, dt, 50).defaultPrevented, false, "the strip does not take it");
    assert.equal(dt.dropEffect, "none");
    assert.equal(dropOn(b, dt, 50).defaultPrevented, false);
    assert.equal(tabEls(b).some((el) => hasClass(el, "is-drop")), false);
    assert.equal(b.R.tabs.list().length, 20);
    // … but the page takes the drop there as anywhere else on it, and says where the tab was let go: the tab gets a
    // window of its own at once (also when this window lies over the tab's own window)
    const over = dragEvent("dragover", dt, { clientX: 50, clientY: 10, target: tabEls(b)[0] });
    b.doc.dispatchEvent(over);
    assert.equal(over.defaultPrevented, true);
    assert.equal(dt.dropEffect, "move");
    assert.equal(tabEls(b).some((el) => hasClass(el, "is-drop")), false);
    const drop = dragEvent("drop", dt, { clientX: 50, clientY: 10, screenX: 1900, screenY: 160, target: tabEls(b)[0] });
    b.doc.dispatchEvent(drop);
    assert.deepEqual([drop.defaultPrevented, drop.stopped], [true, true]);
    await wait(40);
    assert.deepEqual(heard, [{ type: "letgo", drag: numberOf(dt), x: 1900, y: 160 }]);
    assert.equal(b.R.tabs.list().length, 20);
    assert.equal(a.names(), "Library*");
    assert.equal(a.opened.length, 1, "the tab went to a window of its own");
    assert.equal(a.opened[0].features, "popup=yes,width=1100,height=800,left=1820,top=140");
    dragEnd(d.el, dt, { clientX: 400, clientY: 60, screenX: 1900, screenY: 160 });
    await wait(DROP_WAIT);
    assert.equal(a.opened.length, 1);
    // held just under that full strip, on the page: no place is marked (the strip has no room). Let go there, the
    // tab gets a window of its own at that point at once: the page says so
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    heard.length = 0;
    const dt2 = transfer(), d2 = dragStart(a, 1, dt2);
    assert.equal(onPage(b, "dragover", dt2, { clientX: 50, clientY: 50 }).defaultPrevented, true, "the page takes it");
    assert.equal(tabEls(b).some((el) => hasClass(el, "is-drop")), false);
    onPage(b, "drop", dt2, { clientX: 50, clientY: 50, screenX: 640, screenY: 480 });
    await wait(40);
    assert.deepEqual(heard, [{ type: "letgo", drag: numberOf(dt2), x: 640, y: 480 }]);
    assert.equal(b.R.tabs.list().length, 20);
    assert.equal(a.names(), "Library*");
    assert.equal(a.opened.length, 2);
    assert.equal(a.opened[1].features, "popup=yes,width=1100,height=800,left=560,top=460");
    dragEnd(d2.el, dt2, { clientX: 1700, clientY: 60 });
    // the strip's own tabs can still be put in another order
    const own = transfer(), e = dragStart(b, 0, own);
    assert.equal(dragOver(b, own, 550).defaultPrevented, true);
    dropOn(b, own, 550);
    dragEnd(e.el, own, {});
    assert.equal(b.R.tabs.list().length, 20);
    // a browser page (no windows of the app): a tab that was not dragged from this strip is nothing to it
    const web = appOrigin();
    const w = await windowPage(web, "W", { app: false });
    w.R.tabs.open();
    await wait(5);
    const foreign = transfer();
    foreign.setData(TABS.TAB_TYPE, JSON.stringify({ w: "", id: "tab99", tab: LIB }));
    assert.equal(dragOver(w, foreign, 50).defaultPrevented, false);
    assert.equal(dropOn(w, foreign, 50).defaultPrevented, false);
    assert.equal(w.R.tabs.list().length, 2);
    // … and its own tab dropped outside the page opens no window
    const mine = transfer(), m = dragStart(w, 0, mine);
    dragEnd(m.el, mine, { clientX: -80, clientY: 40, screenX: 5, screenY: 5 });
    await wait(DROP_WAIT);
    assert.equal(w.R.tabs.list().length, 2);
    assert.deepEqual(w.opened, []);
    // … while its own strip still takes it
    const again = transfer(), g = dragStart(w, 0, again);
    assert.equal(dragOver(w, again, 290).defaultPrevented, true);
    assert.equal(dropOn(w, again, 290).defaultPrevented, true);
    dragEnd(g.el, again, {});
    assert.equal(w.R.tabs.list().length, 2);
    // something else that is dragged over the strip (a file, a text) is not a tab
    const file = transfer();
    file.setData("text/plain", "x");
    assert.equal(dragOver(a, file, 50).defaultPrevented, false);
    assert.equal(dropOn(a, file, 50).defaultPrevented, false);
    // a tab's text that is no JSON, or no object, is dropped without a trace
    for (const junk of ["{", "7", "null", "\"x\""]) {
      const bad = transfer();
      bad.setData(TABS.TAB_TYPE, junk);
      const c = await windowPage(origin, "J" + junk.length + junk.charCodeAt(0), { w: "junk" + junk.length + "abcd" + junk.charCodeAt(0) });
      dropOn(c, bad, 50);
      assert.equal(c.names(), "Library*", junk);
      assert.deepEqual(c.logs, [], junk);
    }
  });

  test("the library is no place to drop a tab; a PDF file dropped on the library of a window that is not the writer goes through", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    assert.equal(a.writer(), false);
    const lib = a.doc.getElementById("library");
    // a tab over the library: the library does not take it, and says nothing about PDF files
    const dt = transfer();
    dt.setData(TABS.TAB_TYPE, JSON.stringify({ w: "win2abcdef", id: "tab1", tab: LIB }));
    const over = dragEvent("dragover", dt, { target: lib });
    lib.dispatchEvent(over);
    assert.equal(over.defaultPrevented, false);
    assert.equal(dt.dropEffect, "none");
    const dropped = dragEvent("drop", dt, { target: lib });
    lib.dispatchEvent(dropped);
    assert.equal(dropped.defaultPrevented, false);
    assert.deepEqual(a.toasts.filter((x) => /Drop a PDF/.test(String(x))), []);
    // a file on the library, as the window sees it first: it goes through (M.library.addPdf takes the role itself)
    const files = transfer();
    files.types.push("Files");
    files.files = [];
    const fileDrop = dragEvent("drop", files, { target: lib });
    a.W.dispatchEvent(fileDrop);
    assert.deepEqual([fileDrop.defaultPrevented, fileDrop.stopped], [false, false]);
    await wait(30);
    assert.equal(a.writer(), true, "and the window takes the role");
    // a file dropped somewhere else in a window that is not the writer (the editor takes images): not acted on
    await b.use();
    assert.equal(a.writer(), false);
    const elsewhere = dragEvent("drop", files, { target: a.doc.body });
    a.W.dispatchEvent(elsewhere);
    assert.deepEqual([elsewhere.defaultPrevented, elsewhere.stopped], [true, true]);
    await wait(30);                                          // (it took the role, as any input does)
    assert.equal(a.writer(), true);
    // a text that is dropped: not acted on either
    await b.use();
    assert.equal(a.writer(), false);
    const text = transfer();
    text.setData("text/plain", "x");
    const textDrop = dragEvent("drop", text, { target: lib });
    a.W.dispatchEvent(textDrop);
    assert.deepEqual([textDrop.defaultPrevented, textDrop.stopped], [true, true]);
  });
});

// ------------------------------------------------------------------------- what the two reviews of 2026-11-15 found
describe("the windows: cases the two independent reviews found (repaired)", () => {
  const FAILED = "This window could not read the library again. Close the window, or choose View \u203a Reload.";
  const WAITING = "Waiting for another Marginalia window to finish its work\u2026";
  const noticed = (p, text) => p.elements(p.doc.getElementById("toasts"), (n) => /toast__text/.test(n.className || "")).some((n) => n.textContent === text);

  test("a window that starts while another keeps the role: it says at once that it is there, and when the role comes during its first read it reads once more", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    let finish;
    const work = a.R.store.during(new Promise((r) => { finish = r; }));          // the first window imports: it keeps the role
    // The second window starts. After its own wait it goes on as a reader and reads the library; that read is slow
    // here (a large library): its picture of the store is taken, and its answer comes 700 ms later.
    const starting = windowPage(origin, "B", { w: "win2abcdef", beforeBoot(R) {
      const all = R.store.prompts.all;
      R.store.prompts.all = () => all().then((v) => new Promise((r) => setTimeout(() => r(v), 700)));
    } });
    await wait(300);
    assert.equal(origin.locks.holder("marginalia.window.win2abcdef"), "B", "its window lock comes first, long before it reads its list of tabs");
    await wait(1350);                                       // the second window's first read is under way now
    await a.R.cache.saveCollection(D30.BOOK("b9", "From the import"));           // the first window's last write
    finish();
    await work;
    const b = await starting;
    assert.equal(b.writer(), false, "the window is on screen; the role comes when it has read once more (that read is slow too)");
    assert.equal(await b.R.app.takeRole(), true);
    assert.equal(b.writer(), true);
    assert.equal(a.writer(), false);
    assert.ok(b.R.cache.collection("b9"), "the writer's copy has what the first window wrote last");
    assert.equal(b.R.cache.collection("b9").name, "From the import");
    assert.ok(b.toasts.includes(WAITING));
    assert.equal(noticed(b, WAITING), false, "the notice went when the role came");
    // … so a save from its copy does not put an old record over a newer one
    await b.R.cache.saveCollection(Object.assign({}, b.R.cache.collection("b9"), { name: "Renamed in the second window" }));
    assert.equal(stored(origin.idb, "collections", "b9").name, "Renamed in the second window");
    assert.deepEqual(a.logs.concat(b.logs), []);
  });

  // M.review as js/review.js behaves. start() replaces a session that runs, is set aside or shows its end screen
  // (stop() first). review:ended goes out once for a session: when its last card is done (finish(): the end screen
  // stays up, and isActive() stays true), or when the session is left before that (stop()).
  function fakeReview(p) {
    const r = p.review = { session: false, aside: false, ended: false, starts: 0, nothingDue: false };
    const stop = () => {
      if (!r.session) return;
      const said = r.ended;
      r.session = false; r.aside = false; r.ended = false;
      if (!said) p.R.bus.emit("review:ended", {});
    };
    p.R.review.start = async () => {
      stop();
      if (r.nothingDue) throw new Error("Nothing is due");
      r.starts++; r.session = true;
      return { ok: true };
    };
    p.R.review.isActive = () => r.session && !r.aside;
    p.R.review.isSuspended = () => r.session && r.aside;
    p.finish = () => { r.ended = true; p.R.bus.emit("review:ended", {}); };       // the last card is done: the end screen is up
    p.leave = stop;                                                               // Esc, or Done on the end screen
  }

  test("the hold on the review ends with the session, also while its end screen is still up; the next window may then review", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    fakeReview(a); fakeReview(b);
    await a.use();
    assert.deepEqual(plain(await a.R.app.startReview("all")), { ok: true });
    assert.equal(origin.locks.holder("marginalia.review"), "A");
    a.finish();                                             // the last card: the end screen stays up
    await wait(30);
    assert.equal(a.R.review.isActive(), true, "the end screen is on screen");
    assert.equal(origin.locks.holder("marginalia.review"), null, "… and the review is over: the hold is gone");
    a.leave();                                              // Done: nothing more is said
    await wait(30);
    assert.deepEqual(plain(await b.R.app.startReview("all")), { ok: true });
    assert.deepEqual(b.toasts.filter((x) => /another window/.test(String(x))), []);
    // a review that is left before its end lets the hold go too
    b.leave();
    await wait(30);
    assert.equal(origin.locks.holder("marginalia.review"), null);
    // with the end screen still up, this window starts its next review with a hold of its own
    assert.deepEqual(plain(await a.R.app.startReview("all")), { ok: true });
    a.finish();
    await wait(30);
    assert.deepEqual(plain(await a.R.app.startReview("all")), { ok: true });
    assert.equal(origin.locks.holder("marginalia.review"), "A");
    assert.equal(await b.R.app.startReview("all"), null);
  });

  test("a window whose own review is set aside (Go to source) starts its next review as always; the other windows still wait for the end", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    fakeReview(a); fakeReview(b);
    await a.use();
    assert.deepEqual(plain(await a.R.app.startReview("all")), { ok: true });
    a.review.aside = true;                                  // "Go to source": the session is set aside, the book is on screen
    assert.deepEqual(plain(await a.R.app.startReview("book", "b1")), { ok: true }, "as in a browser: the new review takes the place of the old one");
    assert.equal(a.review.starts, 2);
    assert.deepEqual(a.toasts.filter((x) => /another window/.test(String(x))), []);
    await wait(30);
    assert.equal(origin.locks.holder("marginalia.review"), "A", "the end of the replaced session did not let the hold go");
    assert.equal(await b.R.app.startReview("all"), null);
    assert.ok(b.toasts.includes("A review is open in another window"));
    // the review ends for good: now the other window may start one
    a.finish();
    await wait(30);
    assert.equal(origin.locks.holder("marginalia.review"), null);
    assert.deepEqual(plain(await b.R.app.startReview("all")), { ok: true });
    assert.equal(origin.locks.holder("marginalia.review"), "B");
    b.leave();
    await wait(30);
    // a next review that does not start (nothing is due) after it ended the session that was set aside: no hold is left
    a.leave();
    assert.deepEqual(plain(await a.R.app.startReview("all")), { ok: true });
    a.review.aside = true;
    a.review.nothingDue = true;
    assert.equal(await a.R.app.startReview("book", "b1"), null);
    await wait(30);
    assert.equal(a.R.review.isActive() || a.R.review.isSuspended(), false);
    assert.equal(origin.locks.holder("marginalia.review"), null, "the hold ended with the session that the failed start ended");
    assert.deepEqual(plain(await b.R.app.startReview("all")), { ok: true });
  });

  test("a window that cannot read the library again says so, lets its keys through, and takes the role when the store answers again", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    const reload = a.R.cache.reload;
    a.R.cache.reload = () => Promise.reject(new Error("the database did not answer"));
    const first = a.fire("keydown");
    assert.deepEqual([first.defaultPrevented, first.stopped], [true, true], "the first key: nothing is known yet");
    await wait(60);
    assert.equal(a.writer(), false);
    assert.ok(a.toasts.includes(FAILED), a.toasts.join(" | "));
    assert.equal(noticed(a, FAILED), true, "the notice stays");
    assert.equal(origin.locks.holder("marginalia.writer"), null, "the role is free for the other windows");
    // from now on its keys go through (the user can read and copy; a save is refused); each of them tries again
    const second = a.fire("keydown");
    assert.deepEqual([second.defaultPrevented, second.stopped], [false, false]);
    await wait(60);
    assert.equal(a.writer(), false);
    assert.equal(await codeOf(a.R.cache.saveCollection(D30.BOOK("bx", "Not stored")).then(() => { if (stored(origin.idb, "collections", "bx")) throw Object.assign(new Error("stored"), { code: "stored" }); })), "resolved",
      "a quiet write of a reader changes nothing");
    // the other window is not held up
    await b.use();
    assert.equal(b.writer(), true);
    // the store answers again: the next click takes the role, and the notice goes
    a.R.cache.reload = reload;
    const third = a.fire("click");
    assert.deepEqual([third.defaultPrevented, third.stopped], [false, false]);
    await wait(60);
    assert.equal(a.writer(), true);
    assert.equal(noticed(a, FAILED), false);
    // … and from then on a reader's first key is held back again
    await b.use();
    const fourth = a.fire("keydown");
    assert.deepEqual([fourth.defaultPrevented, fourth.stopped], [true, true]);
  });

  test("the window's id is the whole query of its address, as the Mac app reads it: anything else is the first window", async () => {
    for (const search of ["?w=win2abcdef&x=1", "?x=1&w=win2abcdef", "?w=win2abcdef&w=win3abcdef", "?w=WIN2ABCDEF", "?w=abc", "?pdf=sample.pdf"]) {
      const origin = await lastTimeBooks();
      const p = await windowPage(origin, "P", { search });
      assert.equal(p.R.tabs.windowId(), null, search);
      assert.equal(origin.locks.holder("marginalia.window."), "P", search);
      assert.equal(origin.locks.holder("marginalia.window.win2abcdef"), null, search);
      await wait(SAVE_WAIT);
      assert.deepEqual(Array.from(origin.ls.keys()).filter((k) => k.indexOf("marginalia.tabs") === 0), ["marginalia.tabs"], search);
    }
    const origin = await lastTimeBooks();
    const q = await windowPage(origin, "Q", { search: "?w=win2abcdef" });
    assert.equal(q.R.tabs.windowId(), "win2abcdef");
  });

  test("a tab dropped on a window that does not know its book yet stays in its own window; that window reads the library again, and the next drag works", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    // the second window is the writer: it adds a book that the first window's copy does not have, and opens it in a tab
    await b.add(D30.BOOK("b9", "New book"));
    b.R.tabs.open({ screen: "reader", collectionId: "b9" }, {});
    await wait(5);
    assert.equal(b.names(), "Library | New book*");
    assert.equal(a.R.cache.collection("b9"), null);
    let dt = transfer(), d = dragStart(b, 1, dt);
    a.doc.dispatchEvent(dragEvent("dragover", dt));
    assert.equal(dragOver(a, dt, 20).defaultPrevented, true);
    const seen = dragEvent("drop", dt);
    a.W.dispatchEvent(seen);                                // the window's own guard lets a tab through, and takes the role
    assert.deepEqual([seen.defaultPrevented, seen.stopped], [false, false]);
    dropOn(a, dt, 20);
    dragEnd(d.el, dt, { clientX: -300, clientY: 20, screenX: 100, screenY: 100 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Library*", "nothing came in: a tab comes in at the drop, or not at all");
    assert.equal(b.names(), "Library | New book*", "the tab is where it was");
    assert.deepEqual(b.opened, [], "and it got no window of its own");
    assert.ok(a.toasts.includes("Drag the tab once more: this window did not know that book yet"), a.toasts.join(" | "));
    assert.ok(a.R.cache.collection("b9"), "the window has read the library again");
    // the second try
    dt = transfer(); d = dragStart(b, 1, dt);
    dragOver(a, dt, 20);
    dropOn(a, dt, 20);
    dragEnd(d.el, dt, { clientX: -300, clientY: 20, screenX: 100, screenY: 100 });
    await wait(60);
    assert.equal(a.names(), "New book* | Library");
    assert.equal(b.names(), "Library*");
    assert.deepEqual(a.logs.concat(b.logs), []);
  });

  test("a tab that another window took before the drag ended: the drag is over for its window, also when no end of the drag follows", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    const c = await windowPage(origin, "C", { w: "win3abcdef" });
    await wait(20);
    c.R.tabs.open({ screen: "deck", collectionId: "d1" }, {});
    await a.use();
    assert.equal(a.names(), "Library | Griffiths*");
    const dt = transfer();
    dragStart(a, 1, dt);
    dragOver(b, dt, 20);
    dropOn(b, dt, 20);
    await wait(40);                                          // the second window says "took"; no dragend comes for the element that left the page
    assert.equal(a.names(), "Library*");
    assert.equal(a.hidden(), true);
    // the first window, with one tab now, shows its strip for the next tab that passes over it
    const dt2 = transfer();
    dragStart(c, 1, dt2);
    a.doc.dispatchEvent(dragEvent("dragover", dt2));
    assert.equal(a.hidden(), false, "it can take a dragged tab again");
    assert.equal(dragOver(a, dt2, 20).defaultPrevented, true);
  });

  test("a second drag of the same tab that begins while the first one still waits: the first one's window is not made", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    let dt = transfer(), d = dragStart(a, 1, dt);
    dragEnd(d.el, dt, { clientX: -120, clientY: 300, screenX: 1500, screenY: 240 });     // dropped outside: a window in 200 ms
    dt = transfer(); d = dragStart(a, 1, dt);                                               // … but the tab is dragged again at once
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });                                      // and let go inside the window
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Library | Griffiths*");
    assert.deepEqual(a.opened, []);
  });

  test("an import in a window that cannot get the role stores nothing and says why", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    const text = a.R.exporter.toJSON({ collections: [D30.BOOK("b9", "Imported")], prompts: [], attachments: [], settings: {}, folders: [] });
    a.R.app.takeRole = () => Promise.resolve(false);        // another window keeps the role, and this ask was ended
    const failed = await a.R.exporter.importJSON(text, {}).then(() => null, (e) => e);
    assert.equal(failed && failed.code, "locked");
    assert.match(failed.message, /Another Marginalia window is writing/);
    assert.equal(stored(origin.idb, "collections", "b9"), undefined);
    assert.equal(b.writer(), true);
  });

  test("lists of closed windows: a list that cannot be written again stays whole, and none of its tabs comes in twice", async () => {
    const many = { v: 1, active: 0, tabs: Array.from({ length: 18 }, () => LIB).concat([{ screen: "reader", collectionId: "b1", position: null }]) };
    const three = { v: 1, active: 0, tabs: [{ screen: "deck", collectionId: "d1", position: null }, { screen: "reader", collectionId: "b2", position: PLACE }, { screen: "reader", collectionId: "b1", position: null }] };
    const origin = await lastTimeBooks({ "marginalia.tabs": many, "marginalia.tabs.gonewin111": three });
    const a = await windowPage(origin, "A", { beforeBoot(R, W) {
      const set = W.localStorage.setItem;
      W.localStorage.setItem = (k, v) => { if (k === "marginalia.tabs.gonewin111") throw new Error("the storage is full"); return set(k, v); };
    } });
    await wait(40);
    assert.equal(a.R.tabs.list().length, 19, "room for one of the three, but the rest could not be written: none came in");
    assert.deepEqual(JSON.parse(origin.ls.get("marginalia.tabs.gonewin111")), three, "the list is whole, for the next start");
    assert.deepEqual(a.logs, []);
  });

  test("a window whose try to read failed once holds its keys back again as soon as the store has answered", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    const reload = a.R.cache.reload;
    a.R.cache.reload = () => Promise.reject(new Error("the database did not answer"));
    a.fire("keydown");
    await until(() => noticed(a, FAILED), "the notice");
    // The store answers again, but slowly. The window's next key goes through and tries again; while it still reads,
    // the other window is used: that later ask ends this one. The store HAS answered: the notice goes.
    a.R.cache.reload = () => new Promise((r) => setTimeout(r, 400)).then(() => reload());
    const through = a.fire("keydown");
    assert.deepEqual([through.defaultPrevented, through.stopped], [false, false]);
    await wait(40);                                          // the first window has the lock and reads; its ask was heard
    assert.equal(origin.locks.holder("marginalia.writer"), "A");
    assert.equal(a.writer(), false);
    b.W.dispatchEvent({ type: "focus" });                    // a later ask (two asks in the same instant: either may win)
    await until(() => b.writer(), "the other window to take the role");
    assert.equal(a.writer(), false);
    await until(() => !noticed(a, FAILED), "the notice to go");
    const held = a.fire("keydown");
    assert.deepEqual([held.defaultPrevented, held.stopped], [true, true], "and a reader's keys are held back again");
  });

  test("a tab leaves its window only when another window says that it took it: a drop that took nothing leaves the tab where it was", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    assert.equal(a.names(), "Library | Griffiths*");
    // another program took the drop as a move (a page in a browser that takes every drag): nothing says "took"
    let dt = transfer(), d = dragStart(a, 1, dt);
    dt.dropEffect = "move";
    dragEnd(d.el, dt, { clientX: -200, clientY: 40, screenX: 3000, screenY: 200 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Library | Griffiths*", "the tab stays");
    assert.deepEqual(a.opened, [], "and no window opens for it");
    // a window whose copy of the library has no such book (it was deleted there) takes nothing: the tab stays
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    await b.R.cache.removeCollection("b1");
    dt = transfer(); d = dragStart(a, 1, dt);
    b.doc.dispatchEvent(dragEvent("dragover", dt));
    dragOver(b, dt, 20);
    dropOn(b, dt, 20);
    dragEnd(d.el, dt, { clientX: -200, clientY: 40, screenX: 3000, screenY: 200 });
    await wait(DROP_WAIT);
    assert.equal(b.names(), "Library*");
    assert.equal(a.R.tabs.list().length, 2, "still in its own window (which shows it until it reads the library again)");
    assert.deepEqual(a.opened, []);
  });

  test("the word of the window that took the tab counts, whenever it comes and whatever the drag's end reports", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    await a.use();
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    // the drag ends in the same moment as the drop: the "took" comes after the end
    let dt = transfer(), d = dragStart(a, 2, dt);
    dragOver(b, dt, 20);
    dropOn(b, dt, 20);
    dragEnd(d.el, dt, { clientX: -200, clientY: 40, screenX: 3000, screenY: 200 });
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    await wait(60);
    assert.equal(a.names(), "Library | Griffiths*");
    assert.equal(b.names(), "Physics* | Library");
    // an engine that reports no effect for a drop that the other strip did take: the tab moves once, and gets no window of its own
    dt = transfer(); d = dragStart(a, 1, dt);
    dragOver(b, dt, 20);
    dropOn(b, dt, 20);
    dt.dropEffect = "none";
    dragEnd(d.el, dt, { clientX: -200, clientY: 40, screenX: 3000, screenY: 200 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Library*");
    assert.equal(b.names(), "Griffiths* | Physics | Library");
    assert.deepEqual(a.opened.concat(b.opened), []);
    // the "took" of a drag that is long over, or of another window's drag, moves nothing
    const ch = new (origin.Channel("X"))("marginalia.tabs");
    ch.postMessage({ type: "took", drag: "notmydrag1" });
    ch.postMessage({ type: "took" });
    ch.postMessage({ type: "other", drag: "x" });
    await wait(30);
    assert.equal(b.R.tabs.list().length, 3);
    assert.deepEqual(a.logs.concat(b.logs), []);
  });

  test("a tab put at another place of its strip: the drag is over with the drop, also when no end of the drag follows", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    assert.equal(b.R.tabs.adopt(Array.from({ length: 19 }, () => LIB)), 19);
    // the second window's own tab goes to another place; the strip is drawn again, and no dragend comes for the element that left the page
    const own = transfer();
    dragStart(b, 0, own);
    assert.equal(dropOn(b, own, 550).defaultPrevented, true);
    // a tab of the first window over that full strip: not accepted (the stuck drag of before would have let it in, and lost it)
    const dt = transfer(), d = dragStart(a, 1, dt);
    assert.equal(dragOver(b, dt, 50).defaultPrevented, false);
    assert.equal(dropOn(b, dt, 50).defaultPrevented, false);
    assert.equal(b.R.tabs.list().length, 20);
    dragEnd(d.el, dt, { clientX: 400, clientY: 300 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Library | Griffiths*");
    // … and a window with one tab shows its strip for a tab that passes over it, right after its own drop
    const c = await windowPage(origin, "C", { w: "win3abcdef" });
    await wait(20);
    c.R.tabs.open();
    const mine = transfer();
    dragStart(c, 0, mine);
    dropOn(c, mine, 290);
    c.R.tabs.close(c.R.tabs.list()[0].id);
    assert.equal(c.hidden(), true);
    const dt2 = transfer();
    dragStart(a, 1, dt2);
    c.doc.dispatchEvent(dragEvent("dragover", dt2));
    assert.equal(c.hidden(), false);
  });
});

// ------------------------------------------------------------------ a tab that is dragged down (the user, 2026-11-15)
// After trying 1.5.0 the user: "dragging a tab down doesn't seem to auto move it to a new window" and "preview's
// interface is more seamless where it \"previews\" as you drag it down with a mini thing".
describe("a tab that is dragged down: a window at the point where it is let go, and a small picture that follows the pointer", () => {
  test("its own tab let go on the page of its window gets a window at that point, at once; close to the strip it stays in the strip", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    await wait(5);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    // dragged down over the page: the page takes it (the pointer shows "move"), with no mark in the strip
    let dt = transfer(), d = dragStart(a, 1, dt);
    const over = onPage(a, "dragover", dt, { clientX: 400, clientY: 300 });
    assert.equal(over.defaultPrevented, true);
    assert.equal(dt.dropEffect, "move");
    assert.deepEqual(tabEls(a).map((el) => hasClass(el, "is-drop")), [false, false, false]);
    assert.equal(hasClass(a.host().querySelector(".tabs__new"), "is-drop"), false, "far from the strip: no place in the strip is marked");
    // the same events over the strip itself are the strip's own to handle: the page's handlers leave them alone
    const onTab = dragEvent("dragover", dt, { clientX: 150, clientY: 10, target: tabEls(a)[1] });
    a.doc.dispatchEvent(onTab);
    assert.equal(onTab.defaultPrevented, false);
    const dropOnTab = dragEvent("drop", dt, { clientX: 150, clientY: 10, target: tabEls(a)[1].querySelector(".tabs__select") });
    a.doc.dispatchEvent(dropOnTab);
    assert.deepEqual([dropOnTab.defaultPrevented, dropOnTab.stopped], [false, false]);
    assert.deepEqual(a.opened, []);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    // let go there: a window at that point of the screen, without a wait
    const drop = onPage(a, "drop", dt, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    assert.deepEqual([drop.defaultPrevented, drop.stopped], [true, true], "no other part of the page gets this drop");
    await wait(20);
    assert.equal(a.names(), "Library | Physics*");
    assert.equal(a.opened.length, 1);
    assert.match(a.opened[0].url, /^\/\?w=[a-z0-9]{10}$/);
    assert.equal(a.opened[0].features, "popup=yes,width=1100,height=800,left=820,top=480");
    // the drag is over for this page with that drop: its end, and a word about it that comes late, change nothing more
    say(origin, { type: "letgo", drag: numberOf(dt), x: 10, y: 10 });
    dragEnd(d.el, dt, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    await wait(DROP_WAIT);
    assert.equal(a.opened.length, 1);
    assert.equal(a.names(), "Library | Physics*");
    // let go a little below the strip (within 24 px): the tab was not meant to leave; it takes the place it was held over
    dt = transfer(); d = dragStart(a, 0, dt);
    const near = onPage(a, "dragover", dt, { clientX: 150, clientY: 50 });
    assert.equal(near.defaultPrevented, true);
    assert.equal(hasClass(a.host().querySelector(".tabs__new"), "is-drop"), true, "the mark shows where it would go");
    // (the tab leaves the window from there: no dragover comes any more, and the mark goes; the drag is still on)
    await wait(OVER_WAIT);
    assert.equal(hasClass(a.host().querySelector(".tabs__new"), "is-drop"), false);
    assert.equal(anyLifted(a), true);
    onPage(a, "dragover", dt, { clientX: 150, clientY: 50 });
    assert.equal(hasClass(a.host().querySelector(".tabs__new"), "is-drop"), true);
    onPage(a, "drop", dt, { clientX: 150, clientY: 50, screenX: 600, screenY: 200 });
    await wait(20);
    assert.equal(a.names(), "Physics* | Library");
    assert.equal(a.opened.length, 1, "no window");
    assert.equal(hasClass(a.host().querySelector(".tabs__new"), "is-drop"), false);
    assert.equal(anyLifted(a), false, "the drag is over with the drop, also when no end of the drag follows: no tab looks lifted");
    // just beyond that distance it leaves
    dt = transfer(); d = dragStart(a, 1, dt);
    onPage(a, "dragover", dt, { clientX: 150, clientY: 59 });
    onPage(a, "drop", dt, { clientX: 150, clientY: 59, screenX: 600, screenY: 209 });
    await wait(20);
    assert.equal(a.names(), "Physics*");
    assert.equal(a.opened.length, 2);
    assert.deepEqual(a.logs, []);
  });

  test("a tab let go on the page of another window gets a window of its own at that point: that page says so, and the tab's window makes it", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    const deck = () => { b.R.tabs.open({ screen: "deck", collectionId: "d1" }, {}); return wait(5); };
    await deck();
    await b.use();                                           // the user is in the second window, and drags its deck tab
    assert.equal(a.names(), "Library | Griffiths*");
    assert.equal(b.names(), "Library | Physics*");
    const heard = words(origin);
    let dt = transfer(), d = dragStart(b, 1, dt), nonce = numberOf(dt);
    // over the first window's page, far from its strip: the page takes it (the pointer shows "move"); no place is marked
    const over = onPage(a, "dragover", dt, { clientX: 400, clientY: 300 });
    assert.equal(over.defaultPrevented, true);
    assert.equal(dt.dropEffect, "move");
    assert.equal(tabEls(a).some((el) => hasClass(el, "is-drop")), false);
    assert.equal(hasClass(a.host().querySelector(".tabs__new"), "is-drop"), false);
    // let go there. The window sees the drop first: it is not the writer, and lets a tab through
    assert.equal(a.writer(), false);
    const seen = dragEvent("drop", dt, { target: a.doc.body });
    a.W.dispatchEvent(seen);
    assert.deepEqual([seen.defaultPrevented, seen.stopped], [false, false]);
    const drop = onPage(a, "drop", dt, { clientX: 400, clientY: 300, screenX: 1300, screenY: 420 });
    assert.deepEqual([drop.defaultPrevented, drop.stopped], [true, true], "no other part of the page gets this drop");
    await wait(40);
    // the page said so, with the point; nothing came into this window
    assert.deepEqual(heard, [{ type: "letgo", drag: nonce, x: 1300, y: 420 }]);
    assert.equal(a.names(), "Library | Griffiths*");
    assert.deepEqual(a.opened, []);
    // … and the tab's own window gave it a window there, before the drag's end came
    assert.equal(b.names(), "Library*");
    assert.equal(b.opened.length, 1);
    assert.match(b.opened[0].url, /^\/\?w=[a-z0-9]{10}$/);
    assert.equal(b.opened[0].features, "popup=yes,width=1100,height=800,left=1220,top=400");
    dragEnd(d.el, dt, { clientX: -200, clientY: 300, screenX: 1300, screenY: 420 });
    say(origin, { type: "letgo", drag: nonce, x: 1, y: 1 });  // the same word once more
    await wait(DROP_WAIT);
    assert.equal(b.opened.length, 1, "one window for one tab");
    // the drag's end comes before the word (the two travel apart): the tab's window waits for the word, then makes the window
    await deck();
    dt = transfer(); d = dragStart(b, 1, dt);
    onPage(a, "dragover", dt, { clientX: 400, clientY: 300 });
    onPage(a, "drop", dt, { clientX: 400, clientY: 300, screenX: 700, screenY: 300 });      // the word is on its way …
    dragEnd(d.el, dt, { clientX: -200, clientY: 300, screenX: 90, screenY: 90 });           // … and the end is here first
    assert.equal(b.opened.length, 1);
    await wait(DROP_WAIT);
    assert.equal(b.opened.length, 2);
    assert.equal(b.opened[1].features, "popup=yes,width=1100,height=800,left=620,top=280", "at the point where it was let go");
    assert.equal(b.names(), "Library*");
    // … also when the engine reports that nothing took the drop: one window, at the point that the page gave
    await deck();
    dt = transfer(); d = dragStart(b, 1, dt);
    onPage(a, "drop", dt, { clientX: 400, clientY: 300, screenX: 500, screenY: 600 });
    dt.dropEffect = "none";
    dragEnd(d.el, dt, { clientX: -200, clientY: 300, screenX: 90, screenY: 90 });
    await wait(DROP_WAIT);
    assert.equal(b.opened.length, 3);
    assert.equal(b.opened[2].features, "popup=yes,width=1100,height=800,left=420,top=580");
    // a word about another drag, a word with no number, another kind of word: nothing
    await deck();
    dt = transfer(); d = dragStart(b, 1, dt); nonce = numberOf(dt);
    say(origin, { type: "letgo", drag: "nosuchdrag", x: 5, y: 5 });
    say(origin, { type: "letgo", x: 5, y: 5 });
    say(origin, { type: "moved", drag: nonce, x: 5, y: 5 });
    await wait(30);
    assert.equal(b.opened.length, 3);
    assert.equal(b.names(), "Library | Physics*");
    // a word without a point: the window comes next to this one
    say(origin, { type: "letgo", drag: nonce, x: null, y: 40 });
    await wait(30);
    assert.equal(b.opened.length, 4);
    assert.equal(b.opened[3].features, "popup=yes,width=1100,height=800");
    assert.equal(anyLifted(b), false);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    assert.deepEqual(a.logs.concat(b.logs), []);
  });

  test("close to another window's strip the tab comes into that strip; a window with one tab, a window behind a dialog, a browser page", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    const deck = () => { b.R.tabs.open({ screen: "deck", collectionId: "d1" }, {}); return wait(5); };
    await deck();
    await b.use();
    const heard = words(origin);
    // held close under the other window's strip (24 px or less from it): the tab was meant for that strip. The place
    // is marked, and the tab comes in there (as a drop on the strip): no window
    let dt = transfer(), d = dragStart(b, 1, dt), nonce = numberOf(dt);
    const near = onPage(a, "dragover", dt, { clientX: 120, clientY: 50 });
    assert.equal(near.defaultPrevented, true);
    assert.deepEqual(tabEls(a).map((el) => hasClass(el, "is-drop")), [false, true]);
    const drop = onPage(a, "drop", dt, { clientX: 120, clientY: 50, screenX: 800, screenY: 200 });
    assert.deepEqual([drop.defaultPrevented, drop.stopped], [true, true]);
    await wait(40);
    assert.equal(a.names(), "Library | Physics* | Griffiths");
    assert.equal(tabEls(a).some((el) => hasClass(el, "is-drop")), false);
    assert.deepEqual(heard, [{ type: "took", drag: nonce }]);
    assert.equal(b.names(), "Library*");
    assert.deepEqual(a.opened.concat(b.opened), [], "no window");
    dragEnd(d.el, dt, { clientX: -200, clientY: 50 });
    // just beyond that distance: no place is marked, and the tab gets a window
    await deck();
    dt = transfer(); d = dragStart(b, 1, dt);
    onPage(a, "dragover", dt, { clientX: 120, clientY: 59 });
    assert.equal(tabEls(a).some((el) => hasClass(el, "is-drop")), false);
    onPage(a, "drop", dt, { clientX: 120, clientY: 59, screenX: 800, screenY: 209 });
    await wait(40);
    assert.equal(a.names(), "Library | Physics* | Griffiths");
    assert.equal(b.opened.length, 1);
    dragEnd(d.el, dt, { clientX: -200, clientY: 59 });
    // a window with one tab shows its strip while the tab is over its page; let go on the page, the tab gets its
    // window, and that strip goes again
    const c = await windowPage(origin, "C", { w: "win3abcdef" });
    await wait(20);
    await deck();
    dt = transfer(); d = dragStart(b, 1, dt);
    assert.equal(c.hidden(), true);
    assert.equal(onPage(c, "dragover", dt, { clientX: 400, clientY: 300 }).defaultPrevented, true);
    assert.equal(c.hidden(), false);
    onPage(c, "drop", dt, { clientX: 400, clientY: 300, screenX: 300, screenY: 300 });
    assert.equal(c.hidden(), true);
    await wait(40);
    assert.equal(c.names(), "Library*");
    assert.equal(b.opened.length, 2);
    dragEnd(d.el, dt, { clientX: -200, clientY: 300 });
    // held close under the other window's strip, and then gone (Escape, or let go somewhere else): that window hears
    // no end of the drag, and its mark goes a moment after the last dragover
    await deck();
    dt = transfer(); d = dragStart(b, 1, dt);
    onPage(a, "dragover", dt, { clientX: 120, clientY: 50 });
    assert.deepEqual(tabEls(a).map((el) => hasClass(el, "is-drop")), [false, true, false]);
    dt.dropEffect = "none";
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });      // (cancelled over its own window)
    await wait(OVER_WAIT);
    assert.equal(tabEls(a).some((el) => hasClass(el, "is-drop")), false);
    assert.equal(b.opened.length, 2);
    // a dialog is up in the window under the pointer: that window takes no tab (no place is marked close to its
    // strip), but its page says where the tab was let go, and the tab gets its window at once
    const modal = a.R.app.modal;
    dt = transfer(); d = dragStart(b, 1, dt);
    a.R.app.modal = () => true;
    assert.equal(onPage(a, "dragover", dt, { clientX: 120, clientY: 50 }).defaultPrevented, true);
    assert.equal(tabEls(a).some((el) => hasClass(el, "is-drop")), false);
    heard.length = 0;
    const relayed = onPage(a, "drop", dt, { clientX: 120, clientY: 50, screenX: 100, screenY: 400 });
    assert.deepEqual([relayed.defaultPrevented, relayed.stopped], [true, true]);
    await wait(40);
    assert.deepEqual(heard, [{ type: "letgo", drag: numberOf(dt), x: 100, y: 400 }]);
    assert.equal(a.names(), "Library | Physics* | Griffiths", "nothing came into the window with the dialog");
    assert.equal(b.opened.length, 3);
    assert.equal(b.opened[2].features, "popup=yes,width=1100,height=800,left=20,top=380");
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    // … on its strip too: the strip's own handlers take nothing behind a dialog, the document's take the drop
    await deck();
    dt = transfer(); d = dragStart(b, 1, dt);
    assert.equal(dragOver(a, dt, 120).defaultPrevented, false);
    const onStrip = dragEvent("dragover", dt, { clientX: 120, clientY: 10, target: tabEls(a)[1] });
    a.doc.dispatchEvent(onStrip);
    assert.equal(onStrip.defaultPrevented, true);
    const stripDrop = dragEvent("drop", dt, { clientX: 120, clientY: 10, screenX: 300, screenY: 90, target: tabEls(a)[1] });
    a.doc.dispatchEvent(stripDrop);
    assert.deepEqual([stripDrop.defaultPrevented, stripDrop.stopped], [true, true]);
    await wait(40);
    assert.equal(a.names(), "Library | Physics* | Griffiths");
    assert.equal(b.opened.length, 4);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    // … and a window with one tab and a dialog up shows no strip as a place to drop
    c.R.app.modal = () => true;
    await deck();
    dt = transfer(); d = dragStart(b, 1, dt);
    assert.equal(onPage(c, "dragover", dt, { clientX: 400, clientY: 300 }).defaultPrevented, true);
    assert.equal(c.hidden(), true);
    onPage(c, "drop", dt, { clientX: 400, clientY: 300, screenX: 300, screenY: 300 });
    await wait(40);
    assert.equal(b.opened.length, 5);
    assert.equal(c.names(), "Library*");
    c.R.app.modal = modal;
    a.R.app.modal = modal;
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    // … and behind a dialog the page does not take its own window's tab either
    dt = transfer(); d = dragStart(a, 2, dt);
    a.R.app.modal = () => true;
    assert.equal(onPage(a, "dragover", dt, { clientX: 400, clientY: 300 }).defaultPrevented, false);
    assert.equal(onPage(a, "drop", dt, { clientX: 400, clientY: 300 }).defaultPrevented, false);
    a.R.app.modal = modal;
    dragEnd(d.el, dt, { clientX: 400, clientY: 300 });
    assert.equal(a.names(), "Library | Physics* | Griffiths");
    assert.deepEqual(a.opened, []);
    // something else that is dragged over the page (a file) is not the page's to take here
    const file = transfer();
    file.types.push("Files");
    assert.equal(onPage(a, "dragover", file, { clientX: 400, clientY: 300 }).defaultPrevented, false);
    assert.deepEqual(a.logs.concat(b.logs, c.logs), []);
    // a browser page: its own tab let go on the page stays (there are no windows); close to the strip it takes its place
    const web = appOrigin();
    const w = await windowPage(web, "W", { app: false });
    w.R.tabs.open();
    await wait(5);
    const ids = () => Array.from(w.R.tabs.list(), (x) => x.id);
    const first = ids();
    let own = transfer();
    dragStart(w, 0, own);
    assert.equal(onPage(w, "dragover", own, { clientX: 400, clientY: 300 }).defaultPrevented, true, "it shows \"move\", so that Escape differs from letting go");
    onPage(w, "drop", own, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    await wait(20);
    assert.deepEqual(ids(), first);
    assert.deepEqual(w.opened, []);
    own = transfer();
    dragStart(w, 0, own);
    onPage(w, "drop", own, { clientX: 250, clientY: 40 });
    assert.deepEqual(ids(), [first[1], first[0]], "the first tab went to the end of the strip");
    assert.deepEqual(w.opened, []);
    // … a tab of another page of the app is not this page's to take: not on its page, not close to its strip
    const strange = transfer();
    strange.setData(TABS.TAB_TYPE, JSON.stringify({ w: "", id: "tab9", drag: "otherdrag2", tab: LIB }));
    assert.equal(onPage(w, "dragover", strange, { clientX: 400, clientY: 300 }).defaultPrevented, false);
    const left = onPage(w, "drop", strange, { clientX: 120, clientY: 40 });
    assert.deepEqual([left.defaultPrevented, left.stopped], [false, false]);
    assert.equal(w.R.tabs.list().length, 2);
    // … and a browser page with one tab shows no place to drop for it
    const web2 = appOrigin();
    const single = await windowPage(web2, "S", { app: false });
    assert.equal(onPage(single, "dragover", strange, { clientX: 400, clientY: 300 }).defaultPrevented, false);
    assert.equal(single.hidden(), true);
    assert.deepEqual(w.logs.concat(single.logs), []);
  });

  test("a drag whose end never came (its strip was drawn again meanwhile) is over when another drag's tab comes, or at the next move of the mouse", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    const b = await windowPage(origin, "B", { w: "win2abcdef" });
    await wait(20);
    const book = () => { b.R.tabs.open({ screen: "reader", collectionId: "b2" }, {}); return wait(5); };
    await book();
    await a.use();
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    const lifted = () => tabEls(a).map((el) => hasClass(el, "is-dragging"));
    // This window's second tab is dragged. Its strip is drawn again (a book got another name), so the element that
    // was dragged is no longer in the page, and no end of the drag comes to the page.
    const stale = async () => {
      const dt = transfer(), d = dragStart(a, 1, dt);
      await wait(10);
      a.R.tabs.render();
      assert.equal(lifted()[1], true);
      dt.el = d.el;                                          // (the element that was dragged: no longer in the page)
      return dt;
    };
    const heard = words(origin);
    await stale();
    // a tab of the second window comes over this page and is let go on it: that is not this page's drag
    let other = transfer(), od = dragStart(b, 1, other);
    assert.equal(onPage(a, "dragover", other, { clientX: 400, clientY: 300 }).defaultPrevented, true);
    assert.equal(anyLifted(a), false, "this page's own drag is over");
    onPage(a, "drop", other, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    await wait(40);
    assert.deepEqual(a.opened, [], "this window's own tab was not let go: it stays");
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    assert.deepEqual(heard, [{ type: "letgo", drag: numberOf(other), x: 900, y: 500 }]);
    assert.equal(b.opened.length, 1, "the second window's tab got its window");
    dragEnd(od.el, other, { clientX: -200, clientY: 300 });
    // … the same when the drop is the first that this page sees of the other drag
    await stale();
    await book();
    other = transfer(); od = dragStart(b, 1, other);
    onPage(a, "drop", other, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    assert.equal(anyLifted(a), false);
    await wait(40);
    assert.deepEqual(a.opened, []);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    assert.equal(b.opened.length, 2);
    dragEnd(od.el, other, { clientX: -200, clientY: 300 });
    // … and when the other tab is only held over this window's strip
    await stale();
    await book();
    other = transfer(); od = dragStart(b, 1, other);
    assert.equal(dragOver(a, other, 20).defaultPrevented, true);
    assert.equal(anyLifted(a), false);
    other.dropEffect = "none";
    dragEnd(od.el, other, { clientX: 300, clientY: 300 });   // (that drag is cancelled)
    // the mouse moves, or is pressed: no drag is under way then, and the drag that never ended is over
    await stale();
    a.doc.dispatchEvent(dragEvent("mousemove", null, { target: a.doc.body }));
    assert.equal(anyLifted(a), false);
    let old = await stale();
    a.doc.dispatchEvent(dragEvent("mousedown", null, { target: a.doc.body }));
    assert.equal(anyLifted(a), false);
    // If that drag goes on all the same (an engine that sends a mouse event during a drag), its tab is still this
    // window's own, by what it carries. Let go on its strip, it takes its place and is not there twice …
    assert.equal(dragOver(a, old, 290).defaultPrevented, true);
    assert.equal(dropOn(a, old, 290).defaultPrevented, true);
    await wait(20);
    assert.equal(a.names(), "Library | Physics | Griffiths*");
    assert.equal(a.R.tabs.list().length, 3);
    // … close to the strip the same …
    old = await stale();
    a.doc.dispatchEvent(dragEvent("mousemove", null, { target: a.doc.body }));
    assert.equal(onPage(a, "drop", old, { clientX: 290, clientY: 50 }).defaultPrevented, true);
    await wait(20);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    assert.equal(a.R.tabs.list().length, 3);
    // … and let go on the page, it gets its window
    old = await stale();
    a.doc.dispatchEvent(dragEvent("mousemove", null, { target: a.doc.body }));
    onPage(a, "drop", old, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    await wait(40);
    assert.equal(a.names(), "Library | Physics*");
    assert.equal(a.opened.length, 1);
    assert.equal(a.opened[0].features, "popup=yes,width=1100,height=800,left=820,top=480");
    assert.equal(heard.length, 2, "this window said nothing to the others about its own tab");
    // … when another window took its tab, that window's word still counts (the tab is not in two windows) …
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    await wait(5);
    assert.equal(a.names(), "Library | Physics* | Griffiths");
    old = await stale();
    a.doc.dispatchEvent(dragEvent("mousemove", null, { target: a.doc.body }));
    say(origin, { type: "took", drag: numberOf(old) });
    await wait(30);
    assert.equal(a.names(), "Library | Griffiths*");
    assert.equal(a.opened.length, 1);
    // … and when it ends outside the window with nothing taken, its tab gets its window after the wait
    old = await stale();
    a.doc.dispatchEvent(dragEvent("mousemove", null, { target: a.doc.body }));
    dragEnd(old.el, old, { clientX: -300, clientY: 300, screenX: 40, screenY: 60 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Library*");
    assert.equal(a.opened.length, 2);
    assert.equal(a.opened[1].features, "popup=yes,width=1100,height=800,left=-40,top=40");
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, {});
    await wait(5);
    assert.equal(a.names(), "Library | Physics*");
    // the drag that was taken for over is forgotten when the next drag begins: the end of a new drag of that tab is
    // not taken for the end of the old one
    old = await stale();
    a.doc.dispatchEvent(dragEvent("mousemove", null, { target: a.doc.body }));
    const next = transfer(), nd = dragStart(a, 1, next);
    assert.equal(dropOn(a, next, 120).defaultPrevented, true);                 // let go where the tab is: nothing moves
    next.dropEffect = "none";
    dragEnd(nd.el, next, { clientX: -300, clientY: 300, screenX: 40, screenY: 60 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Library | Physics*");
    assert.equal(a.opened.length, 2, "no window for a tab that was only put back in its place");
    // a mouse event in the first moment of a drag (an engine may send one) ends nothing: the element that is dragged
    // is in the strip, and the drag goes on
    let dt = transfer(), d = dragStart(a, 1, dt);
    a.doc.dispatchEvent(dragEvent("mousemove", null, { target: a.doc.body }));
    await wait(10);
    assert.equal(lifted()[1], true);
    onPage(a, "drop", dt, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    await wait(40);
    assert.equal(a.opened.length, 3, "the tab got its window");
    assert.equal(a.names(), "Library*");
    dragEnd(d.el, dt, { clientX: 400, clientY: 300 });
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    await wait(5);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    // on this window's strip the other tab comes in as the tab of another window that it is. The document sees the
    // drop first and leaves it to the strip; the drag that never ended is over before the strip takes the tab.
    await stale();
    other = transfer(); od = dragStart(b, 1, other);
    const first = dragEvent("drop", other, { clientX: 20, clientY: 10, target: tabEls(a)[0] });
    a.doc.dispatchEvent(first);
    assert.deepEqual([first.defaultPrevented, first.stopped], [false, false]);
    assert.equal(anyLifted(a), false);
    await stale();                                           // (and without the document's part: the strip sees it itself)
    assert.equal(dropOn(a, other, 20).defaultPrevented, true);
    assert.equal(anyLifted(a), false);
    await wait(40);
    assert.equal(a.names(), "Sakurai* | Library | Griffiths | Physics", "the other window's tab came in; this window's tabs kept their places");
    assert.deepEqual(heard[heard.length - 1], { type: "took", drag: numberOf(other) });
    assert.equal(b.names(), "Library*");
    dragEnd(od.el, other, { clientX: -200, clientY: 10 });
    assert.deepEqual(a.logs.concat(b.logs), []);
    // a browser page: a tab of another page of the app is no tab of this page, also when it has the id of the tab
    // whose drag never ended here
    const web = appOrigin();
    const w = await windowPage(web, "W", { app: false });
    w.R.tabs.open();
    await wait(5);
    const ids = () => Array.from(w.R.tabs.list(), (x) => x.id);
    const before = ids();
    const own = transfer();
    dragStart(w, 0, own);
    await wait(10);
    w.R.tabs.render();
    assert.equal(anyLifted(w), true);
    const same = transfer();
    same.setData(TABS.TAB_TYPE, JSON.stringify(Object.assign(JSON.parse(own.getData(TABS.TAB_TYPE)), { drag: "otherdrag9" })));
    same.setData(TABS.DRAG_TYPE + "otherdrag9", "1");
    assert.equal(dropOn(w, same, 290).defaultPrevented, false);
    assert.deepEqual(ids(), before, "no tab changed place");
    assert.equal(anyLifted(w), false);
    // … while its own drag, taken for over and going on all the same, still moves its tab along the strip
    assert.equal(dragOver(w, own, 290).defaultPrevented, true);
    assert.equal(dropOn(w, own, 290).defaultPrevented, true);
    assert.deepEqual(ids(), [before[1], before[0]]);
    assert.deepEqual(w.logs, []);
  });

  test("a tab of another page that carries this window's id and the id of one of its tabs is not this window's own", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    await wait(5);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    const mine = Array.from(a.R.tabs.list(), (x) => x.id);
    const places = () => Array.from(a.R.tabs.list(), (x) => x.id).filter((id) => mine.includes(id));
    const heard = words(origin);
    // as a page without a window id writes it (a browser page of Marginalia): w "", and the id of this window's second tab
    const other = transfer();
    other.setData(TABS.TAB_TYPE, JSON.stringify({ w: "", id: mine[1], drag: "otherpage01", tab: { screen: "deck", collectionId: "d1", position: null, editing: null } }));
    other.setData(TABS.DRAG_TYPE + "otherpage01", "1");
    // let go on the page: this window's own tab with that id stays where it is; the page says where the other tab was let go
    assert.equal(onPage(a, "dragover", other, { clientX: 400, clientY: 300 }).defaultPrevented, true);
    onPage(a, "drop", other, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    await wait(40);
    assert.equal(a.names(), "Library | Griffiths* | Physics");
    assert.deepEqual(a.opened, []);
    assert.deepEqual(heard, [{ type: "letgo", drag: "otherpage01", x: 900, y: 500 }]);
    // while this window's own drag of that very tab is open, the other tab is still not its own
    const dt = transfer(), d = dragStart(a, 1, dt);
    await wait(10);
    assert.equal(dropOn(a, other, 20).defaultPrevented, true);
    await wait(40);
    assert.equal(a.names(), "Physics* | Library | Griffiths | Physics", "it came in as the tab of another page that it is");
    assert.deepEqual(places(), mine, "no tab of this window changed place");
    assert.deepEqual(heard[heard.length - 1], { type: "took", drag: "otherpage01" });
    assert.deepEqual(a.opened, []);
    // … and that drag of this window's own tab still ends as its own: let go outside, the tab gets its window
    dt.dropEffect = "none";
    dragEnd(d.el, dt, { clientX: -200, clientY: 300, screenX: 30, screenY: 30 });
    await wait(DROP_WAIT);
    assert.equal(a.names(), "Physics* | Library | Physics");
    assert.equal(a.opened.length, 1);
    assert.deepEqual(a.logs, []);
  });

  test("with 8 windows open a tab that is let go on the page stays in its strip, with a notice, and its drag is over", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    for (let i = 1; i <= 7; i++) origin.locks.manager("W" + i).request("marginalia.window.otherwin0" + i, () => new Promise(() => {}));
    await wait(10);
    const dt = transfer(), d = dragStart(a, 1, dt);
    await wait(10);
    assert.equal(anyLifted(a), true);
    const drop = onPage(a, "drop", dt, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    assert.equal(drop.defaultPrevented, true);
    assert.equal(anyLifted(a), false);
    await wait(30);
    assert.ok(a.toasts.includes("Close a window first: 8 windows are open"), a.toasts.join(" | "));
    assert.equal(a.names(), "Library | Griffiths*");
    assert.deepEqual(a.opened, []);
    // nothing waits for that drag any more
    say(origin, { type: "letgo", drag: numberOf(dt), x: 10, y: 10 });
    dragEnd(d.el, dt, { clientX: -300, clientY: 300, screenX: 20, screenY: 20 });
    await wait(DROP_WAIT);
    assert.deepEqual(a.opened, []);
    assert.equal(a.toasts.filter((x) => x === "Close a window first: 8 windows are open").length, 1);
    // the same when the tab was let go on another window's page (that page's word comes): the tab stays, and its
    // drag is over, also when no end of the drag follows
    const dt2 = transfer();
    dragStart(a, 1, dt2);
    await wait(10);
    assert.equal(anyLifted(a), true);
    say(origin, { type: "letgo", drag: numberOf(dt2), x: 10, y: 10 });
    await wait(30);
    assert.equal(a.toasts.filter((x) => x === "Close a window first: 8 windows are open").length, 2);
    assert.equal(anyLifted(a), false);
    a.R.tabs.render();
    assert.equal(anyLifted(a), false);
    assert.equal(a.names(), "Library | Griffiths*");
    assert.deepEqual(a.opened, []);
    // … and when that word comes after the drag's end, while the wait for it runs: the word is acted on once, and
    // the end of the wait does nothing more (one notice, not two)
    const dt3 = transfer(), d3 = dragStart(a, 1, dt3);
    dragEnd(d3.el, dt3, { clientX: -300, clientY: 300, screenX: 20, screenY: 20 });
    say(origin, { type: "letgo", drag: numberOf(dt3), x: 10, y: 10 });
    await wait(DROP_WAIT);
    assert.equal(a.toasts.filter((x) => x === "Close a window first: 8 windows are open").length, 3);
    assert.deepEqual(a.opened, []);
    assert.deepEqual(a.logs, []);
  });

  // A canvas as the page makes it, with a context that keeps what was drawn.
  function withCanvas(p) {
    const made = [];
    const create = p.doc.createElement.bind(p.doc);
    p.doc.createElement = (tag) => {
      const el = create(tag);
      if (String(tag).toLowerCase() !== "canvas") return el;
      const drawn = { texts: [], images: [] };
      const g = { scale() {}, beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, save() {}, restore() {}, clip() {}, stroke() {}, fillRect() {},
        measureText: (s) => ({ width: String(s).length * 7 }), fillText: (s) => drawn.texts.push(String(s)), drawImage: (...a) => drawn.images.push(a) };
      el.getContext = () => g;
      el.drawn = drawn;
      made.push(el);
      return el;
    };
    return made;
  }
  const withImage = (dt) => { dt.images = []; dt.setDragImage = (el, x, y) => dt.images.push({ el, x, y, inPage: !!el.parentNode }); return dt; };

  test("a small picture of the tab follows the pointer: its name on a bar, and what the book shows; the tab in the strip looks lifted", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    await a.R.app.route("reader", { collectionId: "b1" });
    a.R.tabs.open({}, { background: true });
    await wait(5);
    assert.equal(a.names(), "Griffiths* | Library");
    const made = withCanvas(a);
    const shot = { width: 440, height: 252 }, asked = [];
    a.R.reader.snapshot = (w, h) => { asked.push([w, h]); return shot; };
    // the tab on screen: its book as it is now
    let dt = withImage(transfer()), d = dragStart(a, 0, dt);
    assert.equal(dt.images.length, 1);
    const pic = dt.images[0];
    assert.ok(pic.el === made[0], "the picture is a canvas");
    assert.deepEqual([pic.x, pic.y, pic.inPage], [28, 12, true], "held by its bar; in the page while the system takes it");
    assert.deepEqual([pic.el.style.width, pic.el.style.height, pic.el.style.left], ["220px", "150px", "-10000px"]);
    assert.deepEqual(asked, [[220, 126]]);
    assert.ok(pic.el.drawn.images.length === 1 && pic.el.drawn.images[0][0] === shot, "what the book shows");
    assert.deepEqual(pic.el.drawn.images[0].slice(1), [0, 24, 220, 126]);
    assert.deepEqual(pic.el.drawn.texts, ["Griffiths"]);
    assert.equal(hasClass(d.el, "is-dragging"), false, "the strip does not change while the drag begins");
    await wait(10);
    assert.equal(pic.el.parentNode, null, "the picture leaves the page again");
    assert.equal(hasClass(d.el, "is-dragging"), true, "the tab looks lifted out of the strip");
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    assert.equal(tabEls(a).some((el) => hasClass(el, "is-dragging")), false);
    // a tab that is no book: its kind in the place of the pages
    dt = withImage(transfer()); d = dragStart(a, 1, dt);
    assert.deepEqual(dt.images[0].el.drawn.texts, ["Library", "Library"]);
    assert.equal(dt.images[0].el.drawn.images.length, 0);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    // a book tab that left the screen keeps the picture of what it showed
    a.R.tabs.select(a.R.tabs.list()[1].id);
    await wait(5);
    asked.length = 0;
    dt = withImage(transfer()); d = dragStart(a, 0, dt);
    assert.ok(dt.images[0].el.drawn.images[0][0] === shot);
    assert.deepEqual(asked, [], "it is not on screen: nothing is asked of the reader now");
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    // a book that was never on screen in this window: its name, and "Book"
    a.R.tabs.open({ screen: "reader", collectionId: "b2" }, { background: true });
    await wait(5);
    dt = withImage(transfer()); d = dragStart(a, 2, dt);
    assert.deepEqual(dt.images[0].el.drawn.texts, ["Book", "Sakurai"]);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    // the strip is drawn again while a tab is dragged (a book got another name): the tab still looks lifted
    dt = withImage(transfer()); d = dragStart(a, 2, dt);
    await wait(10);
    a.R.tabs.render();
    assert.deepEqual(tabEls(a).map((el) => hasClass(el, "is-dragging")), [false, false, true]);
    dragEnd(tabEls(a)[2], dt, { clientX: 300, clientY: 300 });
    assert.equal(tabEls(a).some((el) => hasClass(el, "is-dragging")), false);
    // a long name is cut to fit the bar
    await a.R.cache.saveCollection(Object.assign({}, a.R.cache.collection("b2"), { name: "A very long name of a book that cannot fit on the small bar at all" }));
    dt = withImage(transfer()); d = dragStart(a, 2, dt);
    const text = dt.images[0].el.drawn.texts[1];
    assert.ok(/\u2026$/.test(text) && text.length < 40, text);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    await a.R.cache.saveCollection(Object.assign({}, a.R.cache.collection("b2"), { name: "Sakurai" }));
    // a tab that goes to another place (‹ Library) has no picture of the book it showed before: at once, on screen
    a.R.tabs.select(a.R.tabs.list()[0].id);                 // the book tab is on screen again (it kept its picture)
    await wait(5);
    await a.R.app.route("library");
    asked.length = 0;
    dt = withImage(transfer()); d = dragStart(a, 0, dt);
    assert.equal(dt.images[0].el.drawn.images.length, 0, "no page of the book that this tab no longer shows");
    assert.deepEqual(dt.images[0].el.drawn.texts, ["Library", "Library"]);
    assert.deepEqual(asked, [], "no book is on screen: nothing is asked of the reader");
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    // a second tab of the book that is on screen, which was never on screen itself: the picture of the tab on screen
    // is not its picture
    await a.R.app.route("reader", { collectionId: "b1" });
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    await wait(5);
    assert.equal(a.names(), "Griffiths* | Griffiths | Library | Sakurai");
    asked.length = 0;
    dt = withImage(transfer()); d = dragStart(a, 1, dt);
    assert.deepEqual(dt.images[0].el.drawn.texts, ["Book", "Griffiths"]);
    assert.equal(dt.images[0].el.drawn.images.length, 0);
    assert.deepEqual(asked, []);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    // a book that is deleted while its tab is not on screen: the tab goes back to the library, without the book's picture
    a.R.tabs.select(a.R.tabs.list()[3].id);                 // Sakurai on screen …
    await wait(5);
    a.R.tabs.select(a.R.tabs.list()[2].id);                 // … and off again: it keeps its picture
    await wait(5);
    dt = withImage(transfer()); d = dragStart(a, 3, dt);
    assert.ok(dt.images[0].el.drawn.images[0][0] === shot);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    await a.R.cache.removeCollection("b2");
    await wait(5);
    assert.equal(a.names(), "Griffiths | Griffiths | Library* | Library");
    dt = withImage(transfer()); d = dragStart(a, 3, dt);
    assert.equal(dt.images[0].el.drawn.images.length, 0);
    assert.deepEqual(dt.images[0].el.drawn.texts, ["Library", "Library"]);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    // 20 tabs are open, and a link comes: the tab on screen takes the link's place, without its book's picture
    a.R.tabs.select(a.R.tabs.list()[0].id);                 // Griffiths on screen
    await wait(5);
    for (let i = 0; i < 16; i++) a.R.tabs.open({}, { background: true });
    assert.equal(a.R.tabs.list().length, 20);
    assert.equal(a.R.tabs.link({ screen: "deck", collectionId: "d1" }), true);
    await wait(5);
    assert.ok(a.toasts.includes("20 tabs are open: this tab took the link"), a.toasts.join(" | "));
    assert.equal(a.R.tabs.list()[0].title, "Physics");
    dt = withImage(transfer()); d = dragStart(a, 0, dt);
    assert.equal(dt.images[0].el.drawn.images.length, 0, "no page of the book that this tab showed before the link");
    assert.deepEqual(dt.images[0].el.drawn.texts, ["Deck", "Physics"]);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    assert.deepEqual(a.logs, []);
  });

  test("a tab that leaves its window for good is not pictured: closed, moved to a window, taken by another window, merged", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    await a.R.app.route("reader", { collectionId: "b1" });
    a.R.tabs.open({}, { background: true });
    await wait(5);
    const asked = [];
    a.R.reader.snapshot = (w, h) => { asked.push([w, h]); return { width: 440, height: 252 }; };
    const book = async () => { a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {}); await wait(5); asked.length = 0; };
    // (a tab that only leaves the screen is pictured: that is what the count below is compared with)
    a.R.tabs.select(a.R.tabs.list()[1].id);
    await wait(5);
    assert.deepEqual(asked, [[220, 126]]);
    a.R.tabs.select(a.R.tabs.list()[0].id);
    await wait(5);
    asked.length = 0;
    // closed
    assert.equal(a.R.tabs.close(a.R.tabs.active()), true);
    await wait(5);
    assert.equal(a.names(), "Library*");
    assert.deepEqual(asked, []);
    // moved to a window of its own
    await book();
    assert.equal(a.names(), "Library | Griffiths*");
    assert.equal(await a.R.tabs.moveToWindow(), true);
    assert.equal(a.names(), "Library*");
    assert.deepEqual(asked, []);
    // taken by another window (its word comes): the one picture is the picture for the drag
    await book();
    const dt = transfer(), d = dragStart(a, 1, dt);
    assert.equal(asked.length, 0, "this transfer takes no picture");
    say(origin, { type: "took", drag: numberOf(dt) });
    await wait(30);
    assert.equal(a.names(), "Library*");
    assert.deepEqual(asked, []);
    dragEnd(d.el, dt, { clientX: -200, clientY: 300 });
    // merged into another window (Merge All Windows: dump(), then drop())
    await book();
    assert.equal(a.R.tabs.dump().length, 2);
    assert.equal(a.R.tabs.drop([1]), 1);
    await wait(5);
    assert.equal(a.names(), "Library*");
    assert.deepEqual(asked, []);
    assert.deepEqual(a.logs, []);
  });

  test("the lifted look ends with the drag, however it ends; without a canvas the drag works as before", async () => {
    const origin = await lastTimeBooks();
    const a = await windowPage(origin, "A");
    a.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    a.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    await wait(5);
    const lifted = () => tabEls(a).map((el) => hasClass(el, "is-dragging"));
    // no canvas in this page (the test window has none), and a transfer that takes no picture: the drag starts all the same
    let dt = transfer(), d = dragStart(a, 0, dt);
    assert.equal(d.e.defaultPrevented, false);
    assert.deepEqual(dt.types, [TABS.TAB_TYPE, TABS.DRAG_TYPE + numberOf(dt)]);
    await wait(10);
    assert.deepEqual(lifted(), [true, false, false]);
    // … a drop on its own strip: the strip is drawn again, without the lifted look
    dropOn(a, dt, 290);
    assert.deepEqual(lifted(), [false, false, false]);
    dragEnd(d.el, dt, {});
    // … a drop on its own strip at the place where the tab is already: nothing is drawn again, and the look goes all the same
    dt = transfer(); d = dragStart(a, 0, dt);
    await wait(10);
    assert.deepEqual(lifted(), [true, false, false]);
    dropOn(a, dt, 20);
    assert.deepEqual(lifted(), [false, false, false]);
    dragEnd(d.el, dt, {});
    // … a drop on the page
    dt = transfer(); d = dragStart(a, 0, dt);
    await wait(10);
    onPage(a, "drop", dt, { clientX: 400, clientY: 300, screenX: 900, screenY: 500 });
    await wait(20);
    assert.equal(lifted().some(Boolean), false);
    // … a drag that is cancelled
    dt = transfer(); d = dragStart(a, 0, dt);
    await wait(10);
    assert.equal(lifted()[0], true);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    assert.equal(lifted().some(Boolean), false);
    // … a drag that ends in the moment in which it began: the tab never looks lifted
    dt = transfer(); d = dragStart(a, 0, dt);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    await wait(10);
    assert.equal(lifted().some(Boolean), false);
    // a drag that cannot take its data (the engine refuses it) is cancelled, not half begun
    const deaf = transfer();
    deaf.setData = () => { throw new Error("no data"); };
    d = dragStart(a, 0, deaf);
    assert.equal(d.e.defaultPrevented, true);
    await wait(10);
    assert.equal(lifted().some(Boolean), false);
    assert.deepEqual(deaf.types, []);
    // a picture that cannot be made (the canvas throws) does not stop the drag
    a.doc.createElement = (function (create) { return (tag) => { const el = create(tag); if (tag === "canvas") el.getContext = () => { throw new Error("no canvas"); }; return el; }; })(a.doc.createElement.bind(a.doc));
    dt = withImage(transfer()); d = dragStart(a, 0, dt);
    assert.equal(d.e.defaultPrevented, false);
    assert.deepEqual(dt.images, []);
    assert.deepEqual(dt.types, [TABS.TAB_TYPE, TABS.DRAG_TYPE + numberOf(dt)]);
    dragEnd(d.el, dt, { clientX: 300, clientY: 300 });
    assert.deepEqual(a.logs, []);
  });
});
