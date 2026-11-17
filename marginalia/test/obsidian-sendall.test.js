"use strict";
// test/obsidian-sendall.test.js — M.obsidian.sendAll / planAll (FEATURES A3–A8, BUILD-NOTES "Obsidian"): a whole book
// or deck at once. Reading order (books: page, then top to bottom; decks: section order, then creation), every kind
// (a highlight too), grouping by target note (the single send's targetFile rule), request splitting, the per-block
// fallback for a serve.py from before /notes, obsidianSentAt / obsidianFile recorded with {content: false} for every
// block the server wrote, link mode (only never-sent prompts, ONE obsidian://new link, the title rule, the URI_LIMIT
// copy), the toasts and "Copy notes", a tab that stepped aside, and no second run of the same collection at once.
// A8, never a card twice: sendState (fresh / changed / unchanged by contentUpdatedAt against obsidianSentAt), no
// request at all for unchanged cards (a second send-all right after the first sends nothing), "replaceOnly" for edited
// ones (editing one card makes the next send-all send exactly that card), the server's notFound results (nothing
// recorded, listed, "Copy notes"), an edit made while a send is on its way, the older-server and link-mode rules (a
// serve.py whose GET /vaults lacks "replaceOnly" gets no edited card: its /notes would add one whose block is gone).
// A request with no answer, or a 200 whose body never came, may have written its cards: they remember that note
// (obsidianPendingFile, no send recorded), so after a rename, a folder change or a move to a deck their next send-all
// updates those copies there (also on the per-block /note route; a refusal remembers nothing). Above URI_LIMIT the
// copy's toast names the edited cards a link cannot update, as the link's toast does.
// FEATURES A9: every request writes its cards' markers ahead (obsidianPendingFile, through M.cache.patchPrompts, before
// the request leaves), and its answer settles them (written: the send record; a 4xx JSON refusal or a per-block
// ok: false: put back; a 5xx, no answer, a cut body: kept); a link holds the marked cards back and names them; a marked
// card that is otherwise unchanged goes all the same, with replaceOnly. The records go through patchPrompts (one write
// per request; e.patches lists every change) unless the stub cache lacks it (noPatch: one savePrompt each).
// Repairs of the A9 review (2026-11-10): the cards a request left no telling for are named "may already be in
// Obsidian" and never copied (D2); a rechecked card is never called edited (D5).
// Nothing here opens a URI or touches a vault: the opener and fetch are stubs. Run from the app folder: node --test
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const M = globalThis.Marginalia = globalThis.Marginalia || {};
const JS = path.join(__dirname, "..", "js");
require(path.join(JS, "util.js"));
require(path.join(JS, "scheduler.js"));
require(path.join(JS, "prompts.js"));
require(path.join(JS, "markup.js"));
require(path.join(JS, "exporter.js"));
const O = require(path.join(JS, "obsidian.js"));

const BOOK = { id: "92b1cb87", kind: "book", name: "Griffiths", sections: [], deletedAt: null };
const DECK = { id: "deck_1", kind: "deck", name: "Thermo formulas", sections: [], deletedAt: null };
const EMPTY = { id: "b_empty", kind: "book", name: "Nothing yet", sections: [], deletedAt: null };
const GONE = { id: "b_gone", kind: "book", name: "Deleted book", sections: [], deletedAt: 5 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG64 = Buffer.from(PNG).toString("base64");

// a book prompt on page `page` (0-based) with its anchor's top at PDF y `y` (y grows upwards)
function bp(id, page, y, over) {
  return Object.assign({
    id, collectionId: BOOK.id, kind: "qa", text: "Q. " + id + "?\nA. yes", tags: [], flagged: false,
    anchor: { pageIndex: page, pages: [{ pageIndex: page, rects: [[72, y - 12, 300, y]] }], quote: "quote of " + id, y, lost: false },
    context: { docName: "Griffiths", sectionLabel: null, pageIndex: page, pageLabel: String(page + 1) },
    cards: [], createdAt: 1, contentUpdatedAt: 1, updatedAt: 1, deletedAt: null, v: 1
  }, over || {});
}
// a deck prompt in section `section` created at `t`
function dp(id, section, t, over) {
  return Object.assign({
    id, collectionId: DECK.id, kind: "qa", text: "Q. " + id + "\nA. a", tags: [], flagged: false, anchor: null,
    context: { docName: DECK.name, sectionLabel: section, pageIndex: null, pageLabel: null },
    cards: [], createdAt: t, contentUpdatedAt: t, updatedAt: t, deletedAt: null, v: 1
  }, over || {});
}

function env(opts) {
  opts = opts || {};
  // obsidian: true = the connection is switched on (DECISIONS D32); a test of the switch passes its own value
  const values = Object.assign({ obsidian: true, obsidianVault: "", obsidianFolder: "Notes/Marginalia" }, opts.settings || {});
  const prompts = new Map(), cols = new Map([BOOK, DECK, EMPTY, GONE].map((c) => [c.id, c]));
  // the cache's own records (patchPrompts changes them in place, as js/cache.js does; a test may reuse its list)
  (opts.prompts || []).forEach((p) => prompts.set(p.id, Object.assign({}, p)));
  const e = { toasts: [], opened: [], saves: [], patches: [], writes: 0, fetches: [], copied: [], values, prompts, cols, locked: null };
  const host = opts.hostname || "127.0.0.1";
  globalThis.location = { protocol: opts.protocol || "http:", origin: "http://" + host + ":8765", hostname: host };
  let refusals = opts.refuse || 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
    value: { clipboard: { writeText: (t) => {
      if (refusals > 0) { refusals--; return Promise.reject(new Error("NotAllowedError")); }
      e.copied.push(t); return Promise.resolve();
    } } } });
  M.app = { toast: (o) => { e.toasts.push(o); return { close() {} }; }, isArtifact: () => !!opts.artifact };
  M.settings = { get: (k) => values[k] };
  M.cache = {
    prompt: (id) => prompts.get(id) || null,
    prompts: () => Array.from(prompts.values()),
    promptsOf: (cid) => Array.from(prompts.values()).filter((p) => p.collectionId === cid),
    collection: (id) => cols.get(id) || null,
    savePrompt: (p, o) => { e.saves.push({ p, o }); prompts.set(p.id, p); return Promise.resolve(p); },
    // as js/cache.js: the fields in place (undefined removes one), one store write per call, no event, refused in a tab
    // that stepped aside; e.patches lists every change, e.writes counts the calls (opts.noPatch: a cache without it)
    patchPrompts: opts.noPatch ? undefined : (changes) => {
      if (e.locked) return Promise.reject(Object.assign(new Error("Marginalia is open in another tab"), { code: "locked" }));
      e.writes++;
      changes.forEach((c) => {
        const p = prompts.get(c.id);
        if (!p) return;
        e.patches.push({ id: c.id, fields: Object.assign({}, c.fields) });
        Object.keys(c.fields).forEach((k) => { if (c.fields[k] === undefined) delete p[k]; else p[k] = c.fields[k]; });
      });
      return Promise.resolve(changes.length);
    }
  };
  M.store = {
    attachments: { get: (id) => Promise.resolve(id === "a_1" ? { id, mime: "image/png", bytes: PNG.buffer } : null) },
    locked: () => e.locked
  };
  O._reset();
  O._setOpener((uri) => { e.opened.push(uri); });
  O._setFetch((url, init) => {
    e.fetches.push({ url, init });
    const reply = opts.fetch ? opts.fetch(url, init, e) : { status: 404, body: {} };
    if (reply && typeof reply.then === "function") return reply;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({ ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: () => Promise.resolve(reply.body) });
  });
  return e;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
// GET /api/obsidian/vaults as tools/serve.py answers it now ("replaceOnly": its /notes honours a block's replaceOnly);
// OLD_VAULTS: a serve.py from before that (FEATURES A8), still running after an update
const ONE_VAULT = { status: 200, body: { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "Attachments" }], replaceOnly: true } };
const OLD_VAULTS = { status: 200, body: { vaults: ONE_VAULT.body.vaults } };
// a /notes endpoint that writes every block: replaced when `known` (a Set of block ids already in a note) holds it
function notesServer(known, extra) {
  known = known || new Set();
  return (url, init, e) => {
    if (url === "/api/obsidian/vaults") return ONE_VAULT;
    if (extra) { const r = extra(url, init, e); if (r) return r; }
    if (url !== "/api/obsidian/notes") return { status: 404, body: { ok: false, error: "not found" } };
    const b = JSON.parse(init.body);
    const results = b.blocks.map((x) => { const replaced = known.has(x.blockId); known.add(x.blockId); return { blockId: x.blockId, ok: true, replaced }; });
    return { status: 200, body: { ok: true, file: b.file, created: false, results } };
  };
}
// A stand-in for tools/serve.py that keeps what it writes (note → block ids), so a test can count each card's copies:
// a block the note holds is replaced, else added (a "replaceOnly" one it does not find: notFound, nothing written); /note
// likewise, without replaceOnly. old: /notes answers 404 (a serve.py from before it). srv.lose(url, body) → "drop" (the
// server writes, then the page hears nothing: the server stopped or restarted mid-answer, the connection dropped), "cut"
// (it writes and answers 200, but the body never comes, so json() rejects), "down" (no answer and nothing written).
function vaultServer(opts) {
  opts = opts || {};
  const notes = new Map();
  const srv = { notes, lose: null };
  function write(file, id, replaceOnly) {
    const ids = notes.get(file) || [];
    if (ids.includes(id)) return { blockId: id, ok: true, replaced: true };
    if (replaceOnly) return { blockId: id, ok: false, notFound: true, error: "its earlier copy is no longer in the note" };
    ids.push(id);
    notes.set(file, ids);
    return { blockId: id, ok: true, replaced: false };
  }
  srv.fetch = (url, init) => {
    if (url === "/api/obsidian/vaults") return ONE_VAULT;
    if (url === "/api/obsidian/notes" && opts.old) return { status: 404, body: { ok: false, error: "not found" } };
    if (url !== "/api/obsidian/notes" && url !== "/api/obsidian/note") return { status: 404, body: {} };
    const b = JSON.parse(init.body), how = srv.lose ? srv.lose(url, b) : null;
    if (how === "down") return new Error("Failed to fetch");
    let reply;
    if (url === "/api/obsidian/notes") {
      reply = { status: 200, body: { ok: true, file: b.file, created: false, results: b.blocks.map((x) => write(b.file, x.blockId, x.replaceOnly === true)) } };
    } else {
      reply = { status: 200, body: { ok: true, file: b.file, created: false, replaced: write(b.file, b.blockId, false).replaced } };
    }
    if (how === "drop") return new Error("Failed to fetch");
    if (how === "cut") return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new TypeError("network error")) });
    return reply;
  };
  // where the card's copies are: {note: count}
  srv.copies = (id) => {
    const out = {};
    notes.forEach((ids, f) => { const k = ids.filter((x) => x === id).length; if (k) out[f] = k; });
    return out;
  };
  return srv;
}
const posts = (e, url) => e.fetches.filter((f) => f.url === (url || "/api/obsidian/notes")).map((f) => JSON.parse(f.init.body));
// what M.obsidian wrote, change by change: the send records ([id, file]; each also drops the marker) and the markers
// alone ([id, note]; undefined: removed); markerOf: a card's marker now (undefined: none)
const recordsOf = (e) => e.patches.filter((c) => "obsidianSentAt" in c.fields).map((c) => [c.id, c.fields.obsidianFile]);
const markersOf = (e) => e.patches.filter((c) => !("obsidianSentAt" in c.fields)).map((c) => [c.id, c.fields.obsidianPendingFile]);
const markerOf = (e, id) => e.prompts.get(id).obsidianPendingFile;
const last = (e) => e.toasts[e.toasts.length - 1];
const contentOf = (uri) => decodeURIComponent(/&content=([^&]*)/.exec(uri)[1]);
function cleanup() { O._reset(); delete globalThis.location; delete globalThis.navigator; }

// ------------------------------------------------------------------ reading order

describe("readingOrder", () => {
  test("books: page, then from the top of the page down (PDF y grows upwards), then creation", () => {
    const list = [
      bp("p3", 2, 500), bp("low", 0, 120), bp("high", 0, 700, { createdAt: 9 }),
      bp("free", 0, 400, { anchor: { pageIndex: 0, pages: [], quote: "", y: 400, lost: false } }),
      bp("noY", 1, 0, { anchor: null, context: { docName: "Griffiths", sectionLabel: null, pageIndex: 1 } }),
      bp("p2", 1, 300), bp("tieB", 0, 700, { createdAt: 9 }), bp("tieA", 0, 700, { createdAt: 3 })
    ];
    assert.deepEqual(O.readingOrder(list, BOOK).map((p) => p.id), ["tieA", "high", "tieB", "free", "low", "noY", "p2", "p3"]);
  });
  test("decks: sections in the order they first appear, then creation; the input is left as it was", () => {
    const list = [dp("n2", "Nouns", 40), dp("v1", "Verbs", 10), dp("x1", null, 5), dp("n1", "Nouns", 20), dp("v2", "Verbs", 50), dp("x2", "", 60)];
    const before = list.map((p) => p.id);
    assert.deepEqual(O.readingOrder(list, DECK).map((p) => p.id), ["x1", "x2", "v1", "v2", "n1", "n2"]);
    assert.deepEqual(list.map((p) => p.id), before);
  });
});

// ------------------------------------------------------------------ server mode

describe("sendAll through Marginalia's server (POST /api/obsidian/notes)", () => {
  afterEach(cleanup);

  test("every kind in reading order, one request for the book's note, the single send's blocks and images", async () => {
    const list = [
      bp("p_hl", 4, 300, { kind: "highlight", text: "" }),
      bp("p_cloze", 0, 200, { kind: "cloze", text: "The {wave function} and ![snip](att:a_1)" }),
      bp("p_note", 0, 650, { kind: "note", text: "A note ![snip](att:a_1) ![snip](att:a_gone)" }),
      bp("p_qa", 2, 400),
      bp("p_empty", 1, 100, { kind: "highlight", text: "", anchor: { pageIndex: 1, pages: [], quote: "", y: 100, lost: false } }),
      bp("p_dead", 0, 700, { deletedAt: 3 }),
      dp("d_other", "Verbs", 1)
    ];
    const e = env({ prompts: list, fetch: notesServer() });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.opened.length, 0, "a silent write opens nothing");
    const sent = posts(e);
    assert.equal(sent.length, 1, "one request per target note");
    const body = sent[0];
    assert.equal(body.vault, "Test Vault");
    assert.equal(body.file, "Notes/Marginalia/Griffiths.md");
    assert.equal(body.title, "Griffiths");
    assert.deepEqual(body.blocks.map((b) => b.blockId), ["p_note", "p_cloze", "p_qa", "p_hl"], "reading order; no deleted, empty or other-book prompt");
    const names = (id) => (id === "a_1" ? "marginalia-a_1.png" : null);
    body.blocks.forEach((b) => assert.equal(b.markdown, O.blockFor(e.prompts.get(b.blockId), BOOK, { images: names }), b.blockId));
    assert.match(body.blocks[0].markdown, /\nA note !\[\[marginalia-a_1\.png\]\] \[image\]\n/, "a missing attachment is [image]");
    assert.deepEqual(body.images, [{ name: "marginalia-a_1.png", data: PNG64 }], "each image once per request");
    const post = e.fetches.find((f) => f.url === "/api/obsidian/notes");
    assert.equal(post.init.method, "POST");
    assert.deepEqual([post.init.headers["Content-Type"], post.init.headers["X-Marginalia"]], ["application/json", "1"]);
    assert.deepEqual({ ok: res.ok, mode: res.mode, sent: res.sent, added: res.added, updated: res.updated, skipped: res.skipped, failed: res.failed, files: res.files, file: res.file },
      { ok: true, mode: "server", sent: 4, added: 4, updated: 0, skipped: 1, failed: [], files: ["Notes/Marginalia/Griffiths.md"], file: "Notes/Marginalia/Griffiths.md" });
    // recorded like a single send, not a content edit: the markers written ahead in one write, the records in another
    const ids = ["p_cloze", "p_hl", "p_note", "p_qa"];
    assert.deepEqual(markersOf(e).map((m) => m[0]).sort(), ids);
    assert.ok(markersOf(e).every((m) => m[1] === "Notes/Marginalia/Griffiths.md"));
    assert.deepEqual(recordsOf(e).map((r) => r[0]).sort(), ids);
    assert.equal(e.writes, 2, "one write before the request, one after");
    ids.forEach((id) => {
      const p = e.prompts.get(id);
      assert.deepEqual([typeof p.obsidianSentAt, p.obsidianFile, "obsidianPendingFile" in p, p.contentUpdatedAt],
        ["number", "Notes/Marginalia/Griffiths.md", false, 1], id);
    });
    assert.equal(e.toasts[0].text, "Sending 4 cards to Obsidian…", "a sticky progress toast first");
    const t = last(e);
    assert.equal(t.text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 4 added, 0 updated, 0 already there");
    assert.equal(t.detail, null);
    assert.ok(body.blocks.every((b) => !("replaceOnly" in b)), "a card never sent is simply added");
    assert.equal(t.id, "obsidian", "it replaces the progress toast");
    assert.deepEqual(t.actions.map((a) => a.label), ["Open in Obsidian"]);
    t.actions[0].run();
    assert.equal(e.opened[0], "obsidian://open?vault=Test%20Vault&file=Notes%2FMarginalia%2FGriffiths");
  });

  test("edited copies sent before go to the note that holds them (a request per target note), replaceOnly; updated ones are counted", async () => {
    const old = "Notes/Marginalia/Introduction to Quantum.md";
    // a, c, d, e were sent at 10 and edited at 20; f was sent at 10 and not edited since
    const edited = (file) => ({ obsidianSentAt: 10, obsidianFile: file, contentUpdatedAt: 20 });
    const list = [
      bp("a", 0, 700, edited(old)), bp("b", 0, 600), bp("c", 1, 700, edited(old)),
      bp("d", 2, 700, edited("Notes/Marginalia/Griffiths.md")), bp("e", 3, 700, edited("../bad.md")),
      bp("f", 3, 600, { obsidianSentAt: 10, obsidianFile: old, contentUpdatedAt: 10 })
    ];
    const e = env({ prompts: list, fetch: notesServer(new Set(["a", "c", "d", "e", "f"])) });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    const sent = posts(e);
    assert.deepEqual(sent.map((b) => [b.file, b.title, b.blocks.map((x) => [x.blockId, x.replaceOnly === true])]), [
      [old, "Introduction to Quantum", [["a", true], ["c", true]]],
      ["Notes/Marginalia/Griffiths.md", "Griffiths", [["b", false], ["d", true], ["e", true]]]
    ], "a recorded path Marginalia could not have written is not reused; f (not edited since) is in no request");
    assert.deepEqual([res.sent, res.added, res.updated, res.unchanged, res.skipped], [5, 1, 4, 1, 1]);
    assert.deepEqual(res.files, [old, "Notes/Marginalia/Griffiths.md"]);
    assert.equal(res.file, "Notes/Marginalia/Griffiths.md", "the note that got the most");
    assert.equal(e.prompts.get("a").obsidianFile, old);
    assert.equal(e.prompts.get("e").obsidianFile, "Notes/Marginalia/Griffiths.md");
    assert.deepEqual([e.prompts.get("f").obsidianSentAt, e.patches.some((c) => c.id === "f")], [10, false], "f is left as it was");
    const t = last(e);
    assert.equal(e.toasts[0].text, "Sending 5 cards to Obsidian…");
    assert.equal(t.text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 1 added, 4 updated, 1 already there");
    assert.equal(t.detail, "Also in " + old + ".");
  });

  test("a deck: section order, then creation, to the deck's note", async () => {
    const e = env({ prompts: [dp("n1", "Nouns", 30), dp("v1", "Verbs", 10), dp("v2", "Verbs", 40)], settings: { obsidianFolder: "" }, fetch: notesServer() });
    const res = await O.sendAll(DECK.id, { fromGesture: true });
    const body = posts(e)[0];
    assert.equal(body.file, "Thermo formulas.md");
    assert.deepEqual(body.blocks.map((b) => b.blockId), ["v1", "v2", "n1"]);
    assert.match(body.blocks[0].markdown, /^<!-- marginalia:v1 -->\n### Verbs\n/);
    assert.equal(res.sent, 3);
  });

  test("a group is split into requests of at most SPLIT_BYTES and NOTES_MAX_BLOCKS, in order; a block bigger than that goes alone", async () => {
    const text = (n) => "Q. " + "x".repeat(n) + "\nA. y";
    const list = [bp("s1", 0, 700, { text: text(300) }), bp("s2", 0, 600, { text: text(300) }), bp("s3", 0, 500, { text: text(5000) }),
      bp("s4", 0, 400, { text: text(300) }), bp("s5", 0, 300, { text: "Q. é€😀 " + "ü".repeat(400) + "\nA. y" })];
    const e = env({ prompts: list, fetch: notesServer() });
    const LIMIT = 2600;
    O._setSplit(LIMIT, 1000);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    const raw = e.fetches.filter((f) => f.url === "/api/obsidian/notes").map((f) => f.init.body);
    const ids = posts(e).map((b) => b.blocks.map((x) => x.blockId));
    assert.deepEqual(ids, [["s1", "s2"], ["s3"], ["s4", "s5"]], "consecutive chunks keep the reading order");
    raw.forEach((b, i) => { if (ids[i].length > 1) assert.ok(Buffer.byteLength(b, "utf8") <= LIMIT, "request " + i + " is " + Buffer.byteLength(b, "utf8") + " bytes"); });
    assert.ok(Buffer.byteLength(raw[1], "utf8") > LIMIT, "the big block alone");
    assert.equal(res.sent, 5);

    const e2 = env({ prompts: list, fetch: notesServer() });
    O._setSplit(1e9, 2);
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(posts(e2).map((b) => b.blocks.map((x) => x.blockId)), [["s1", "s2"], ["s3", "s4"], ["s5"]], "at most NOTES_MAX_BLOCKS per request");
    assert.equal(O.SPLIT_BYTES, 20 * 1024 * 1024);
    assert.equal(O.NOTES_MAX_BLOCKS, 2000);
    assert.equal(O.NOTES_MAX_BODY, 100 * 1024 * 1024);
  });

  test("images travel with the request of their block (each once per request)", async () => {
    const list = [bp("i1", 0, 700, { text: "Q. ![snip](att:a_1)\nA. x" }), bp("i2", 0, 600, { text: "Q. " + "y".repeat(400) + "\nA. x" }),
      bp("i3", 0, 500, { text: "Q. ![snip](att:a_1) again\nA. x" })];
    const e = env({ prompts: list, fetch: notesServer() });
    O._setSplit(1e9, 1);
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(posts(e).map((b) => [b.blocks.map((x) => x.blockId), b.images.map((im) => im.name)]),
      [[["i1"], ["marginalia-a_1.png"]], [["i2"], []], [["i3"], ["marginalia-a_1.png"]]]);
    const e2 = env({ prompts: list, fetch: notesServer() });
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(posts(e2).map((b) => [b.blocks.length, b.images]), [[3, [{ name: "marginalia-a_1.png", data: PNG64 }]]]);
  });

  test("a block the server could not write is a failure with its reason; Copy notes copies the failed blocks with [image]", async () => {
    const list = [bp("ok1", 0, 700), bp("bad", 0, 600, { text: "Q. ![snip](att:a_1) broken\nA. x" }), bp("ok2", 0, 500)];
    const e = env({ prompts: list, fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      const b = JSON.parse(init.body);
      return { status: 200, body: { ok: true, file: b.file, created: true, results: b.blocks.map((x) => (x.blockId === "bad"
        ? { blockId: x.blockId, ok: false, error: "the block's text is not well-formed" } : { blockId: x.blockId, ok: true, replaced: false })) } };
    } });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([res.ok, res.sent, res.failed], [false, 2, [{ promptId: "bad", error: "the block's text is not well-formed" }]]);
    assert.deepEqual(recordsOf(e).map((r) => r[0]), ["ok1", "ok2"], "only the written blocks are recorded");
    assert.equal(markerOf(e, "bad"), undefined, "a block the server did not write (ok: false) gets its marker back: none");
    const t = last(e);
    assert.equal(t.text, "2 sent, 1 could not be sent — the block's text is not well-formed");
    assert.deepEqual(t.actions.map((a) => a.label), ["Copy notes", "Open in Obsidian"]);
    t.actions[0].run();
    await tick();
    assert.deepEqual(e.copied, [O.blockFor(e.prompts.get("bad"), BOOK, { images: false })]);
    assert.match(e.copied[0], /\nQ\. \[image\] broken\n/);
    assert.equal(last(e).text, "Note copied — paste it into Notes/Marginalia/Griffiths.md");
  });

  test("a refused request fails its blocks with the server's words; no answer stops the rest; Copy notes joins the blocks no request may have written", async () => {
    // groups in the order their first card reads: Griffiths.md (a, c), Old.md (b), Older.md (d); b and d edited since
    const list = [bp("a", 0, 700), bp("b", 1, 700, { obsidianSentAt: 1, obsidianFile: "Notes/Marginalia/Old.md", contentUpdatedAt: 2 }), bp("c", 2, 700),
      bp("d", 3, 700, { obsidianSentAt: 1, obsidianFile: "Notes/Marginalia/Older.md", contentUpdatedAt: 2 })];
    const tried = [];
    const e = env({ prompts: list, fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      tried.push(JSON.parse(init.body).file);
      if (tried.length === 1) return { status: 409, body: { ok: false, error: "the note is read-only (locked in Finder or chmod)" } };
      return new Error("connection refused");
    } });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(tried, ["Notes/Marginalia/Griffiths.md", "Notes/Marginalia/Old.md"], "after no answer nothing more is tried");
    assert.deepEqual(res.failed, [
      { promptId: "a", error: "the note is read-only (locked in Finder or chmod)" }, { promptId: "c", error: "the note is read-only (locked in Finder or chmod)" },
      { promptId: "b", error: "Marginalia's server did not answer" }, { promptId: "d", error: "Marginalia's server did not answer" }]);
    assert.deepEqual(recordsOf(e), []);
    // the 409 wrote nothing: a and c have no marker; b's request got no answer: b keeps its note; d never went
    assert.deepEqual(["a", "b", "c", "d"].map((id) => markerOf(e, id)), [undefined, "Notes/Marginalia/Old.md", undefined, undefined]);
    const t = last(e);
    // b's request got no answer, so b may be in Old.md already: named apart and never copied (repair D2)
    assert.equal(t.text, "0 sent, 3 could not be sent — the note is read-only (locked in Finder or chmod)");
    assert.equal(t.detail, "1 may already be in Obsidian (Marginalia's server did not answer). Send it again once Marginalia's server answers: it checks the note and never adds a second copy.");
    assert.deepEqual(t.actions.map((a) => a.label), ["Copy notes"]);
    t.actions[0].run();
    await tick();
    assert.deepEqual(e.copied, [["a", "c", "d"].map((id) => O.blockFor(e.prompts.get(id), BOOK, { images: false })).join("\n\n")]);
    assert.equal(last(e).text, "Notes copied — paste them into Notes/Marginalia/Griffiths.md");
    // the next send asks the server again (it may be back)
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.fetches.filter((f) => f.url === "/api/obsidian/vaults").length, 2);
  });

  test("a request refused with per-block results (no valid block) fails each block with its own reason", async () => {
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 0, 600)], fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      const b = JSON.parse(init.body);
      return { status: 400, body: { ok: false, error: "no block could be written: the block has a code fence left open",
        results: b.blocks.map((x) => ({ blockId: x.blockId, ok: false, error: x.blockId === "a" ? "the block has a code fence left open" : "bad blockId" })) } };
    } });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(res.failed, [{ promptId: "a", error: "the block has a code fence left open" }, { promptId: "b", error: "bad blockId" }]);
    assert.deepEqual([recordsOf(e), markerOf(e, "a"), markerOf(e, "b")], [[], undefined, undefined], "a refusal wrote nothing: the markers go");
  });

  test("a 413 names the 100 MB limit and the next request still goes; a block the answer leaves out is not recorded", async () => {
    const list = [bp("a", 0, 700), bp("b", 0, 600), bp("c", 0, 500)];
    let n = 0;
    const e = env({ prompts: list, fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      n++;
      if (n === 1) return { status: 413, body: { ok: false, error: "too large" } };
      const b = JSON.parse(init.body);
      return { status: 200, body: { ok: true, file: b.file, results: b.blocks.filter((x) => x.blockId !== "c").map((x) => ({ blockId: x.blockId, ok: true })) } };
    } });
    O._setSplit(1e9, 1);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(n, 3);
    assert.deepEqual(res.failed, [{ promptId: "a", error: "the notes and their images are larger than 100 MB" }, { promptId: "c", error: "the server's answer left it out" }]);
    assert.deepEqual(recordsOf(e).map((r) => r[0]), ["b"]);
    assert.deepEqual(["a", "b", "c"].map((id) => markerOf(e, id)), [undefined, undefined, "Notes/Marginalia/Griffiths.md"],
      "a: refused (413), b: recorded, c: left out of the answer, so no telling");
    assert.equal(last(e).text, "1 sent, 1 could not be sent — the notes and their images are larger than 100 MB");
    assert.equal(last(e).detail, "1 may already be in Obsidian (the server's answer left it out). Send it again once Marginalia's server answers: it checks the note and never adds a second copy.");
  });

  test("a serve.py from before /notes (404, 405 or 501) gets one POST /api/obsidian/note per never-sent card; edited ones wait for a restart", async () => {
    for (const status of [404, 405, 501]) {
      // a and c never sent; b sent and edited since (/note would add it again where its block is gone); u sent, not edited
      const list = [bp("a", 0, 700, { text: "Q. ![snip](att:a_1)\nA. x" }), bp("b", 1, 700, { obsidianSentAt: 1, contentUpdatedAt: 2 }),
        bp("u", 1, 600, { obsidianSentAt: 5, contentUpdatedAt: 5 }), bp("c", 2, 700)];
      const e = env({ prompts: list, fetch: (url, init) => {
        if (url === "/api/obsidian/vaults") return ONE_VAULT;
        if (url === "/api/obsidian/notes") return { status, body: { ok: false, error: "not found" } };
        const b = JSON.parse(init.body);
        return { status: 200, body: { ok: true, file: b.file, created: false, replaced: false } };
      } });
      const res = await O.sendAll(BOOK.id, { fromGesture: true });
      assert.deepEqual(posts(e).map((b) => b.blocks.map((x) => [x.blockId, x.replaceOnly === true])), [[["a", false], ["b", true], ["c", false]]], "/notes was asked first");
      const single = posts(e, "/api/obsidian/note");
      assert.deepEqual(single.map((b) => [b.blockId, b.file, b.title]), [["a", "Notes/Marginalia/Griffiths.md", "Griffiths"], ["c", "Notes/Marginalia/Griffiths.md", "Griffiths"]], String(status));
      assert.ok(single.every((b) => !("replaceOnly" in b)), "the single endpoint never sees replaceOnly");
      assert.deepEqual(single[0].images, [{ name: "marginalia-a_1.png", data: PNG64 }]);
      assert.equal(single[0].markdown, O.blockFor(e.prompts.get("a"), BOOK, { images: (id) => (id === "a_1" ? "marginalia-a_1.png" : null) }));
      assert.deepEqual([res.ok, res.sent, res.added, res.updated, res.unchanged, res.skipped], [true, 2, 2, 0, 1, 2]);
      assert.deepEqual(res.notUpdated, [{ promptId: "b", error: "restart Marginalia (marginalia restart in Terminal) to update it in place" }]);
      assert.deepEqual(recordsOf(e).map((r) => r[0]), ["a", "c"], "b keeps its earlier record");
      assert.equal(e.prompts.get("b").obsidianSentAt, 1);
      // /notes refused with a 4xx JSON answer wrote nothing, so b (in that request only) has no marker; a 5xx leaves it
      assert.equal(markerOf(e, "b"), status === 501 ? "Notes/Marginalia/Griffiths.md" : undefined, String(status));
      assert.deepEqual([markerOf(e, "a"), markerOf(e, "c")], [undefined, undefined], "recorded");
      const t = last(e);
      assert.equal(t.text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 2 added, 0 updated, 1 already there");
      assert.equal(t.detail, "1 edited card was not updated: restart Marginalia (marginalia restart in Terminal) to update it in place.");
      assert.deepEqual(t.actions.map((a) => a.label), ["Open in Obsidian"], "nothing to copy: b's earlier copy is still in the note");
    }
  });
  test("a serve.py from before /notes with only edited cards to send: nothing goes, the toast says to restart", async () => {
    const e = env({ prompts: [bp("b1", 0, 700, { obsidianSentAt: 1, contentUpdatedAt: 2 }), bp("b2", 1, 700, { obsidianSentAt: 1, contentUpdatedAt: 3 })],
      fetch: (url) => (url === "/api/obsidian/vaults" ? ONE_VAULT : { status: 404, body: { ok: false, error: "not found" } }) });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(posts(e, "/api/obsidian/note").length, 0);
    assert.deepEqual([res.ok, res.sent, res.notUpdated.map((x) => x.promptId)], [true, 0, ["b1", "b2"]]);
    const t = last(e);
    assert.equal(t.text, "2 edited cards were not updated: restart Marginalia (marginalia restart in Terminal) to update them in place");
    assert.deepEqual(t.actions, []);
    assert.deepEqual([recordsOf(e), markerOf(e, "b1"), markerOf(e, "b2")], [[], undefined, undefined]);
  });
  test("a serve.py from before replaceOnly (its GET /vaults has no such flag): edited cards go in no request and wait for a restart; never-sent ones go", async () => {
    // b sent and edited since: that /notes ignores replaceOnly and would add b again where its block is gone
    const list = [bp("a", 0, 700), bp("b", 1, 700, { obsidianSentAt: 1, contentUpdatedAt: 2 }),
      bp("u", 1, 600, { obsidianSentAt: 5, contentUpdatedAt: 5 }), bp("c", 2, 700)];
    const e = env({ prompts: list, fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return OLD_VAULTS;
      const b = JSON.parse(init.body);
      return { status: 200, body: { ok: true, file: b.file, created: false, results: b.blocks.map((x) => ({ blockId: x.blockId, ok: true, replaced: false })) } };
    } });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(posts(e).map((b) => b.blocks.map((x) => [x.blockId, "replaceOnly" in x])), [[["a", false], ["c", false]]]);
    assert.equal(posts(e, "/api/obsidian/note").length, 0);
    assert.deepEqual([res.ok, res.sent, res.added, res.updated, res.unchanged, res.skipped], [true, 2, 2, 0, 1, 2]);
    assert.deepEqual(res.notUpdated, [{ promptId: "b", error: "restart Marginalia (marginalia restart in Terminal) to update it in place" }]);
    assert.deepEqual([res.notFound, res.failed], [[], []]);
    assert.deepEqual(recordsOf(e).map((r) => r[0]), ["a", "c"], "b keeps its earlier record");
    assert.ok(!e.patches.some((c) => c.id === "b"), "b went in no request: no marker either");
    assert.equal(O.sendState(e.prompts.get("b")), "changed");
    assert.equal(e.toasts[e.toasts.length - 2].text, "Sending 2 cards to Obsidian…");
    const t = last(e);
    assert.equal(t.text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 2 added, 0 updated, 1 already there");
    assert.equal(t.detail, "1 edited card was not updated: restart Marginalia (marginalia restart in Terminal) to update it in place.");
    assert.deepEqual(t.actions.map((a) => a.label), ["Open in Obsidian"], "nothing to copy: b's earlier copy is as it was");
  });
  test("only edited cards on such a server: only the check goes; after a restart the next send-all checks again and updates them in place", async () => {
    let restarted = false;
    const list = [bp("b1", 0, 700, { obsidianSentAt: 1, contentUpdatedAt: 2 }), bp("b2", 1, 700, { obsidianSentAt: 1, contentUpdatedAt: 3 })];
    const e = env({ prompts: list, fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return restarted ? ONE_VAULT : OLD_VAULTS;
      const b = JSON.parse(init.body);
      return { status: 200, body: { ok: true, file: b.file, created: false, results: b.blocks.map((x) => ({ blockId: x.blockId, ok: true, replaced: x.replaceOnly === true })) } };
    } });
    const gets = () => e.fetches.filter((f) => f.url === "/api/obsidian/vaults").length;
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.ok, plan.mode, plan.changed], [true, "server", 2]);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([gets(), e.fetches.length], [1, 1], "only planAll's check: no block goes to a /notes that ignores replaceOnly");
    assert.deepEqual([res.ok, res.sent, res.skipped, res.notUpdated.map((x) => x.promptId)], [true, 0, 2, ["b1", "b2"]]);
    assert.equal(last(e).text, "2 edited cards were not updated: restart Marginalia (marginalia restart in Terminal) to update them in place");
    assert.deepEqual(last(e).actions, []);
    assert.equal(e.patches.length, 0);
    // `marginalia restart`: the cached answer has no replaceOnly, so the next confirm checks the server again
    restarted = true;
    const again = await O.planAll(BOOK.id);
    assert.deepEqual([gets(), again.count], [2, 2]);
    const done = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(gets(), 2, "sendAll right after planAll does not ask again");
    assert.deepEqual(posts(e).map((b) => b.blocks.map((x) => [x.blockId, x.replaceOnly])), [[["b1", true], ["b2", true]]]);
    assert.deepEqual([done.ok, done.sent, done.updated, done.notUpdated], [true, 2, 2, []]);
    assert.equal(last(e).text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 0 added, 2 updated, 0 already there");
  });

  test("several vaults and none chosen: nothing is written and Settings is named", async () => {
    const two = { status: 200, body: { vaults: [{ id: "a", name: "A" }, { id: "b", name: "B" }] } };
    const e = env({ prompts: [bp("a", 0, 700)], fetch: (url) => (url === "/api/obsidian/vaults" ? two : { status: 500, body: {} }) });
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.ok, plan.error], [false, "choose a vault in Settings › Obsidian"]);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.fetches.filter((f) => f.url !== "/api/obsidian/vaults").length, 0);
    assert.equal(res.failed[0].error, "choose a vault in Settings › Obsidian");
    assert.match(last(e).text, /^0 sent, 1 could not be sent — choose a vault in Settings › Obsidian$/);
  });
});

// ------------------------------------------------------------------ link mode

describe("sendAll through one obsidian:// link (no server)", () => {
  afterEach(cleanup);

  test("only prompts never sent, all in ONE link to the book's note, titled while no send records that note", async () => {
    // s1 went to another note (before a rename): the book's note itself is new to Marginalia, so it gets its title
    const list = [bp("n2", 1, 700), bp("s1", 0, 700, { obsidianSentAt: 5, obsidianFile: "Notes/Marginalia/Intro.md" }),
      bp("n1", 0, 300, { kind: "highlight", text: "" }), bp("n3", 2, 700)];
    const e = env({ prompts: list, settings: { obsidianVault: "Obsidian Vault" } });
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.ok, plan.mode, plan.count, plan.sentBefore, plan.file, plan.tooLong], [true, "link", 3, 1, "Notes/Marginalia/Griffiths.md", false]);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.opened.length, 1, "one link for the whole book");
    const uri = e.opened[0];
    assert.ok(uri.startsWith("obsidian://new?vault=Obsidian%20Vault&file=Notes%2FMarginalia%2FGriffiths&content="), uri);
    const blocks = ["n1", "n2", "n3"].map((id) => O.blockFor(e.prompts.get(id), BOOK, { images: false }));
    assert.equal(contentOf(uri), "# Griffiths\n\n" + blocks.join("\n\n"), "the s1 block sent before is skipped: links can only add");
    assert.equal(uri, O.uriFor("Obsidian Vault", "Notes/Marginalia/Griffiths.md", contentOf(uri)));
    assert.deepEqual([res.ok, res.mode, res.sent, res.added, res.updated, res.unchanged, res.skipped, res.files], [true, "link", 3, 3, 0, 1, 1, ["Notes/Marginalia/Griffiths.md"]]);
    assert.deepEqual(recordsOf(e).sort(),
      [["n1", "Notes/Marginalia/Griffiths.md"], ["n2", "Notes/Marginalia/Griffiths.md"], ["n3", "Notes/Marginalia/Griffiths.md"]]);
    assert.deepEqual([markersOf(e), e.writes], [[], 1], "a link writes nothing ahead; its records go in one write");
    const t = last(e);
    assert.equal(t.text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 3 added, 0 updated, 1 already there");
    assert.equal(t.detail, "Sent through an obsidian:// link. Restart Marginalia (marginalia restart in Terminal) to write silently and update in place.");
    t.actions[0].run();
    assert.equal(e.opened[1], "obsidian://open?vault=Obsidian%20Vault&file=Notes%2FMarginalia%2FGriffiths");

    // the next send-all has nothing new and nothing edited: no link, no request at all
    const asked = e.fetches.length;
    const again = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.opened.length, 2);
    assert.equal(e.fetches.length, asked, "not even the server check");
    assert.deepEqual([again.ok, again.sent, again.unchanged, again.skipped], [true, 0, 4, 4]);
    assert.deepEqual([last(e).text, last(e).detail], ["Everything in “Griffiths” is already in Obsidian", "Every card was sent before and none was edited since."]);
  });

  test("an edited card is not sent through a link (links can only add) and the toast names it; with nothing never sent, no link at all", async () => {
    const list = [bp("n1", 0, 700), bp("ed", 1, 700, { obsidianSentAt: 5, obsidianFile: "Notes/Marginalia/Griffiths.md", contentUpdatedAt: 9 }),
      bp("un", 2, 700, { obsidianSentAt: 5, obsidianFile: "Notes/Marginalia/Griffiths.md", contentUpdatedAt: 5 })];
    const e = env({ prompts: list, hostname: "claude.ai", protocol: "https:", artifact: true });
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.mode, plan.count, plan.fresh, plan.changed, plan.unchanged, plan.sentBefore, plan.skipped], ["link", 1, 1, 1, 1, 2, 2]);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.opened.length, 1);
    assert.equal(contentOf(e.opened[0]), O.blockFor(e.prompts.get("n1"), BOOK, { images: false }), "only the card never sent");
    assert.deepEqual([res.sent, res.unchanged, res.skipped, res.notUpdated], [1, 1, 2, [{ promptId: "ed", error: "links can only add" }]]);
    assert.deepEqual(recordsOf(e).map((r) => r[0]), ["n1"]);
    const t = last(e);
    assert.equal(t.text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 1 added, 0 updated, 1 already there");
    assert.equal(t.detail, "Sent through an obsidian:// link. 1 edited card was not updated: links can only add. Start Marginalia with the marginalia command to write silently and update in place.");
    assert.deepEqual(t.actions.map((a) => a.label), ["Open in Obsidian"], "no Copy notes: the earlier copy is still in the note");

    // n1 is there now: only the edited card is left, and a link cannot update it
    const again = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.opened.length, 1, "no link");
    assert.deepEqual([again.sent, again.notUpdated.map((x) => x.promptId)], [0, ["ed"]]);
    assert.equal(last(e).text, "Nothing new to send — every card of “Griffiths” was sent before, and an obsidian:// link can only add");
    assert.equal(last(e).detail, "1 edited card was not updated. Start Marginalia with the marginalia command to write silently and update in place.");
    assert.equal(e.prompts.get("ed").obsidianSentAt, 5, "the edited card keeps its record");
  });

  test("no title once a send records that note (or an old send without a file, for its book); claude.ai and file:// ask no server", async () => {
    const list = [bp("s1", 0, 700, { obsidianSentAt: 5, obsidianFile: "Notes/Marginalia/Griffiths.md" }), bp("n1", 1, 700)];
    let e = env({ prompts: list, artifact: true, hostname: "claude.ai", protocol: "https:" });
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.fetches.length, 0);
    assert.equal(contentOf(e.opened[0]), O.blockFor(e.prompts.get("n1"), BOOK, { images: false }));
    assert.ok(!contentOf(e.opened[0]).includes("Open in Marginalia"), "away from 127.0.0.1 the block has just its date");
    assert.match(last(e).detail, /Start Marginalia with the marginalia command to write silently and update in place\.$/);
    e = env({ prompts: [bp("s1", 0, 700, { obsidianSentAt: 5 }), bp("n1", 1, 700)], protocol: "file:" });
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.fetches.length, 0);
    assert.equal(e.opened.length, 1);
    assert.ok(contentOf(e.opened[0]).startsWith("<!-- marginalia:n1 -->"), "a send from before obsidianFile made the book's note");
  });

  test("above URI_LIMIT the joined blocks are copied, never opened, and nothing is recorded", async () => {
    const big = (id, page) => bp(id, page, 700, { text: "Q. " + "w".repeat(25000) + "\nA. x" });
    const e = env({ prompts: [big("b1", 0), big("b2", 1), big("b3", 2)] });
    const plan = await O.planAll(BOOK.id);
    assert.equal(plan.tooLong, true);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    assert.deepEqual([res.ok, res.mode, res.error, res.sent], [false, "copy", "too_long", 0]);
    assert.equal(e.opened.length, 0);
    assert.equal(e.patches.length, 0, "a copy is not a send");
    assert.deepEqual(e.copied, [["b1", "b2", "b3"].map((id) => O.blockFor(e.prompts.get(id), BOOK, { images: false })).join("\n\n")]);
    assert.equal(last(e).text, "Notes copied — paste them into Notes/Marginalia/Griffiths.md");
  });

  test("a refused copy offers Copy notes again", async () => {
    const big = (id, page) => bp(id, page, 700, { text: "Q. " + "w".repeat(40000) + "\nA. x" });
    const e = env({ prompts: [big("b1", 0), big("b2", 1)], refuse: 1 });
    await O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    const t = last(e);
    assert.deepEqual([t.text, t.actions.map((a) => a.label)], ["The browser blocked the clipboard — the notes were not copied", ["Copy notes"]]);
    t.actions[0].run();
    await tick();
    assert.equal(e.copied.length, 1);
    assert.equal(last(e).text, "Notes copied — paste them into Notes/Marginalia/Griffiths.md");
  });

  test("without a user gesture nothing opens: the toast's button does it", async () => {
    const e = env({ prompts: [bp("n1", 0, 700), bp("n2", 1, 700)] });
    const res = await O.sendAll(BOOK.id, { fromGesture: false });
    assert.deepEqual([res.ok, res.error, res.sent], [false, "needs_click", 0]);
    assert.equal(e.opened.length, 0);
    const t = last(e);
    assert.equal(t.text, "Ready for Obsidian · 2 cards · Notes/Marginalia/Griffiths.md");
    t.actions[0].run();
    await tick();
    assert.equal(e.opened.length, 1);
    assert.equal(recordsOf(e).length, 2);
    assert.equal(last(e).text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 2 added, 0 updated, 0 already there");
  });

  test("a browser that cannot open the link: every card fails, Copy notes offers them", async () => {
    const e = env({ prompts: [bp("n1", 0, 700), bp("n2", 1, 700)] });
    O._setOpener(() => false);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(res.failed.length, 2);
    assert.equal(last(e).text, "0 sent, 2 could not be sent — this browser cannot open obsidian:// links — restart Marginalia (marginalia restart in Terminal) to write silently");
    assert.equal(e.patches.length, 0);
  });
});

// ------------------------------------------------------------------ planAll

describe("planAll (what the confirm says)", () => {
  afterEach(cleanup);
  test("server: the cards never sent and those edited since (updated in place); those not edited are skipped; the note with the most first", async () => {
    const old = "Notes/Marginalia/Intro.md";
    const e = env({ prompts: [bp("a", 0, 700, { obsidianSentAt: 1, obsidianFile: old, contentUpdatedAt: 2 }), bp("b", 1, 700), bp("c", 2, 700),
      bp("u", 2, 600, { obsidianSentAt: 4, obsidianFile: "Notes/Marginalia/Other.md", contentUpdatedAt: 3 }),
      bp("x", 3, 700, { kind: "highlight", text: "", anchor: { pageIndex: 3, pages: [], quote: "", y: 1 } })], fetch: notesServer() });
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.ok, plan.mode, plan.count, plan.fresh, plan.changed, plan.unchanged, plan.sentBefore, plan.total, plan.skipped, plan.file, plan.files],
      [true, "server", 3, 2, 1, 1, 2, 4, 2, "Notes/Marginalia/Griffiths.md", ["Notes/Marginalia/Griffiths.md", old]],
      "u's note is no target: nothing goes there");
    assert.equal(e.fetches.filter((f) => f.url !== "/api/obsidian/vaults").length, 0, "planning sends nothing");
  });
  test("a cached link answer is checked again on a 127.0.0.1 page before the confirm, and sendAll right after does not ask twice", async () => {
    let up = false;
    const e = env({ prompts: [bp("a", 0, 700)], fetch: (url, init, env2) => (!up ? { status: 404, body: {} } : notesServer()(url, init, env2)) });
    assert.equal((await O.detect()).mode, "link");
    up = true;                                                  // marginalia restart since
    const plan = await O.planAll(BOOK.id);
    assert.equal(plan.mode, "server");
    const gets = () => e.fetches.filter((f) => f.url === "/api/obsidian/vaults").length;
    assert.equal(gets(), 2);
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(gets(), 2, "the answer is fresh");
    assert.equal(posts(e).length, 1);
  });
  test("refused: a deleted or unknown collection, nothing at all to send", async () => {
    env({ prompts: [], fetch: notesServer() });
    assert.equal((await O.planAll(GONE.id)).error, "its book or deck is no longer in the library");
    assert.equal((await O.planAll("nope")).ok, false);
    const empty = await O.planAll(EMPTY.id);
    assert.deepEqual([empty.ok, empty.count, empty.files], [true, 0, []]);
  });
});

// ------------------------------------------------------------------ one writing tab, one run at a time

describe("a tab that stepped aside, and a second send-all while one runs", () => {
  afterEach(cleanup);
  test("a tab that stepped aside sends nothing: no request, no link, no record", async () => {
    for (const fetch of [notesServer(), undefined]) {
      const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700)], fetch });
      e.locked = { reason: "othertab", by: "tab_b", at: 1 };
      const plan = await O.planAll(BOOK.id);
      assert.deepEqual([plan.ok, plan.error], [false, "Marginalia is open in another tab"]);
      const res = await O.sendAll(BOOK.id, { fromGesture: true });
      assert.deepEqual([res.ok, res.error, res.sent], [false, "Marginalia is open in another tab", 0]);
      assert.deepEqual([e.fetches.length, e.opened.length, e.patches.length, e.saves.length], [0, 0, 0, 0]);
    }
  });
  test("a tab that steps aside during a send-all sends nothing more", async () => {
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700), bp("c", 2, 700)], fetch: notesServer(null, (url, init, env2) => {
      if (url === "/api/obsidian/notes") { env2.locked = { reason: "othertab", by: "tab_b", at: 2 }; }
      return null;
    }) });
    O._setSplit(1e9, 1);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(posts(e).length, 1, "the request already under way, nothing after it");
    assert.deepEqual(res.failed.map((f) => [f.promptId, f.error]), [["b", "Marginalia is open in another tab"], ["c", "Marginalia is open in another tab"]]);
    assert.equal(res.sent, 1);
  });
  test("while a send-all of a collection runs, a second one is refused; another collection may go", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const e = env({ prompts: [bp("a", 0, 700), dp("d1", null, 1)], fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      const b = JSON.parse(init.body);
      const reply = { ok: true, status: 200, json: () => Promise.resolve({ ok: true, file: b.file, results: b.blocks.map((x) => ({ blockId: x.blockId, ok: true })) }) };
      return b.file.endsWith("Griffiths.md") ? gate.then(() => reply) : Promise.resolve(reply);
    } });
    const first = O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    assert.equal(O.isSendingAll(BOOK.id), true);
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.ok, plan.busy], [false, true]);
    const second = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([second.ok, second.error, second.sent], [false, "already sending", 0]);
    assert.equal(last(e).text, "Already sending “Griffiths” to Obsidian");
    assert.equal((await O.sendAll(DECK.id, { fromGesture: true })).sent, 1, "a deck at the same time");
    assert.equal(posts(e).filter((b) => b.file.endsWith("Griffiths.md")).length, 1, "no double send");
    release();
    assert.equal((await first).sent, 1);
    assert.equal(O.isSendingAll(BOOK.id), false);
    const again = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([again.ok, again.error, again.sent, again.unchanged], [true, undefined, 0, 1], "free again once it ended (and a is in Obsidian now)");
    assert.equal(last(e).text, "Everything in “Griffiths” is already in Obsidian");
  });
});

// ------------------------------------------------------------------ A8: never a card twice

describe("never a card twice (FEATURES A8): fresh, changed and unchanged cards", () => {
  afterEach(cleanup);
  // what the cache does on a person's edit: a new record whose content stamp moves (M.cache.savePrompt {content: true})
  function edit(e, id, text, at) {
    const cur = e.prompts.get(id);
    e.prompts.set(id, Object.assign({}, cur, { text, contentUpdatedAt: at === undefined ? Date.now() : at }));
  }

  test("sendState: fresh without obsidianSentAt; changed when the content stamp is newer than the send; unchanged otherwise", () => {
    assert.equal(O.sendState(bp("a", 0, 1)), "fresh");
    assert.equal(O.sendState(bp("a", 0, 1, { obsidianSentAt: 0 })), "fresh");
    assert.equal(O.sendState(bp("a", 0, 1, { obsidianSentAt: 10, contentUpdatedAt: 11 })), "changed");
    assert.equal(O.sendState(bp("a", 0, 1, { obsidianSentAt: 10, contentUpdatedAt: 10 })), "unchanged", "an edit saved right before its send");
    assert.equal(O.sendState(bp("a", 0, 1, { obsidianSentAt: 10, contentUpdatedAt: 3 })), "unchanged");
    assert.equal(O.sendState(bp("a", 0, 1, { obsidianSentAt: 10, contentUpdatedAt: undefined })), "unchanged", "no stamp: no edit known");
    assert.equal(O.sendState(bp("a", 0, 1, { obsidianSentAt: true, contentUpdatedAt: 3 })), "changed", "a send with no time: updated in place, never added");
    assert.equal(O.sendState(null), "fresh");
  });

  test("server: a second send-all right after the first sends nothing — no confirm count, no request at all", async () => {
    const list = [bp("a", 0, 700), bp("b", 1, 700, { kind: "highlight", text: "" }), bp("c", 2, 700, { kind: "cloze", text: "The {x}" })];
    const e = env({ prompts: list, fetch: notesServer() });
    const first = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([first.sent, first.added], [3, 3]);
    const asked = e.fetches.length, toasts = e.toasts.length;
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.ok, plan.mode, plan.count, plan.fresh, plan.changed, plan.unchanged, plan.total, plan.skipped, plan.files],
      [true, "server", 0, 0, 0, 3, 3, 3, []]);
    const again = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.fetches.length, asked, "no request: not even the server check");
    assert.deepEqual([again.ok, again.sent, again.unchanged, again.skipped, again.failed, again.notFound], [true, 0, 3, 3, [], []]);
    assert.equal(e.toasts.length, toasts + 1, "one toast, no progress toast");
    assert.deepEqual([last(e).text, last(e).detail, last(e).id], ["Everything in “Griffiths” is already in Obsidian", "Every card was sent before and none was edited since.", "obsidian"]);
    assert.equal(e.patches.length, 6, "nothing written again (3 markers ahead, 3 records)");
  });

  test("editing one card makes the next send-all send exactly that card, with replaceOnly, to the note that holds it", async () => {
    const list = [bp("a", 0, 700), bp("b", 1, 700), bp("c", 2, 700), dp("d_other", "Verbs", 1)];
    const e = env({ prompts: list, fetch: notesServer() });
    await O.sendAll(BOOK.id, { fromGesture: true });
    const sentAt = e.prompts.get("b").obsidianSentAt;
    await new Promise((r) => setTimeout(r, 5));
    edit(e, "b", "Q. b, edited?\nA. yes");                   // stamped now, as M.cache.savePrompt does
    assert.ok(e.prompts.get("b").contentUpdatedAt > sentAt);
    assert.equal(O.sendState(e.prompts.get("b")), "changed");
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.count, plan.fresh, plan.changed, plan.unchanged, plan.file], [1, 0, 1, 2, "Notes/Marginalia/Griffiths.md"]);
    e.fetches.length = 0;
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    const sent = posts(e);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].blocks, [{ blockId: "b", markdown: O.blockFor(e.prompts.get("b"), BOOK, { images: () => null }), replaceOnly: true }]);
    assert.match(sent[0].blocks[0].markdown, /\nQ\. b, edited\?\nA\. yes\n/);
    assert.deepEqual([res.ok, res.sent, res.added, res.updated, res.unchanged], [true, 1, 0, 1, 2]);
    assert.ok(e.prompts.get("b").obsidianSentAt >= e.prompts.get("b").contentUpdatedAt, "recorded again");
    assert.equal(O.sendState(e.prompts.get("b")), "unchanged");
    assert.equal(e.toasts[e.toasts.length - 2].text, "Sending 1 card to Obsidian…");
    assert.equal(last(e).text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 0 added, 1 updated, 2 already there");
    // and then nothing again
    e.fetches.length = 0;
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.fetches.length, 0);
  });

  test("notFound: an edited card whose earlier block is gone is not written, keeps its record, is listed, and Copy notes offers it", async () => {
    const old = "Notes/Marginalia/Griffiths.md";
    const list = [bp("n", 0, 700), bp("r", 1, 700, { obsidianSentAt: 5, obsidianFile: old, contentUpdatedAt: 8 }),
      bp("g", 2, 700, { obsidianSentAt: 5, obsidianFile: old, contentUpdatedAt: 8, text: "Q. ![snip](att:a_1) gone\nA. x" }),
      bp("u", 3, 700, { obsidianSentAt: 5, obsidianFile: old, contentUpdatedAt: 5 })];
    const e = env({ prompts: list, fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      const b = JSON.parse(init.body);
      return { status: 200, body: { ok: true, file: b.file, created: false, results: b.blocks.map((x) => (x.blockId === "g"
        ? { blockId: "g", ok: false, notFound: true, error: "its earlier copy is no longer in the note" }
        : { blockId: x.blockId, ok: true, replaced: x.replaceOnly === true })) } };
    } });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(posts(e)[0].blocks.map((x) => [x.blockId, x.replaceOnly === true]), [["n", false], ["r", true], ["g", true]]);
    assert.deepEqual([res.ok, res.sent, res.added, res.updated, res.unchanged, res.failed], [true, 2, 1, 1, 1, []]);
    assert.deepEqual(res.notFound, [{ promptId: "g", error: "its earlier copy is no longer in the note" }]);
    assert.deepEqual(recordsOf(e).map((r) => r[0]), ["n", "r"], "nothing recorded for g");
    assert.equal(markerOf(e, "g"), undefined, "notFound: definitely not written, so g's marker goes again");
    assert.deepEqual([e.prompts.get("g").obsidianSentAt, e.prompts.get("g").obsidianFile], [5, old]);
    assert.equal(O.sendState(e.prompts.get("g")), "changed", "still edited since its last send");
    const t = last(e);
    assert.equal(t.text, "Sent to Obsidian · Notes/Marginalia/Griffiths.md: 1 added, 1 updated, 1 already there");
    assert.equal(t.detail, "1 edited card was not updated: its earlier copy is no longer in the note.");
    assert.deepEqual(t.actions.map((a) => a.label), ["Copy notes", "Open in Obsidian"]);
    t.actions[0].run();
    await tick();
    assert.deepEqual(e.copied, [O.blockFor(e.prompts.get("g"), BOOK, { images: false })], "its block, images as [image]");
    assert.match(e.copied[0], /\nQ\. \[image\] gone\n/);
    assert.equal(last(e).text, "Note copied — paste it into Notes/Marginalia/Griffiths.md");
  });

  test("every edited card not found: nothing written or recorded; the toast says so (200 with results, or a refusal listing them)", async () => {
    const old = "Notes/Marginalia/Old name.md";
    for (const status of [200, 400, 409]) {
      const list = [bp("r1", 0, 700, { obsidianSentAt: 5, obsidianFile: old, contentUpdatedAt: 8 }),
        bp("r2", 1, 700, { obsidianSentAt: 5, obsidianFile: old, contentUpdatedAt: 8 }), bp("u", 2, 700, { obsidianSentAt: 5, contentUpdatedAt: 5 })];
      const e = env({ prompts: list, fetch: (url, init) => {
        if (url === "/api/obsidian/vaults") return ONE_VAULT;
        const b = JSON.parse(init.body);
        const results = b.blocks.map((x) => ({ blockId: x.blockId, ok: false, notFound: true, error: "its earlier copy is no longer in the note" }));
        return status === 200 ? { status, body: { ok: true, file: b.file, created: false, results } }
          : { status, body: { ok: false, error: "no block could be written: its earlier copy is no longer in the note", results } };
      } });
      const res = await O.sendAll(BOOK.id, { fromGesture: true });
      assert.deepEqual(posts(e).map((b) => [b.file, b.blocks.map((x) => x.blockId)]), [[old, ["r1", "r2"]]], String(status));
      assert.deepEqual([res.ok, res.sent, res.failed, res.notFound.map((x) => x.promptId), res.files], [true, 0, [], ["r1", "r2"], []], String(status));
      assert.deepEqual([recordsOf(e), markerOf(e, "r1"), markerOf(e, "r2")], [[], undefined, undefined], String(status));
      const t = last(e);
      assert.equal(t.text, "2 edited cards were not updated: their earlier copy is no longer in the note", String(status));
      assert.equal(t.detail, null);
      assert.deepEqual(t.actions.map((a) => a.label), ["Copy notes"]);
      t.actions[0].run();
      await tick();
      assert.deepEqual(e.copied, [["r1", "r2"].map((id) => O.blockFor(e.prompts.get(id), BOOK, { images: false })).join("\n\n")]);
      assert.equal(last(e).text, "Notes copied — paste them into " + old);
      cleanup();
    }
  });

  test("a failure and a card not found: the failure toast names both, and Copy notes copies both", async () => {
    const f = "Notes/Marginalia/Griffiths.md";
    const list = [bp("ok", 0, 700), bp("bad", 1, 700), bp("gone", 2, 700, { obsidianSentAt: 5, obsidianFile: f, contentUpdatedAt: 6 })];
    const e = env({ prompts: list, fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      const b = JSON.parse(init.body);
      return { status: 200, body: { ok: true, file: b.file, results: b.blocks.map((x) => (x.blockId === "ok" ? { blockId: "ok", ok: true }
        : x.blockId === "bad" ? { blockId: "bad", ok: false, error: "the block has a code fence left open" }
          : { blockId: x.blockId, ok: false, notFound: true, error: "its earlier copy is no longer in the note" })) } };
    } });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([res.ok, res.sent, res.failed.map((x) => x.promptId), res.notFound.map((x) => x.promptId)], [false, 1, ["bad"], ["gone"]]);
    const t = last(e);
    assert.equal(t.text, "1 sent, 1 could not be sent — the block has a code fence left open");
    assert.equal(t.detail, "1 edited card was not updated: its earlier copy is no longer in the note.");
    assert.deepEqual(t.actions.map((a) => a.label), ["Copy notes", "Open in Obsidian"]);
    t.actions[0].run();
    await tick();
    assert.deepEqual(e.copied, [["bad", "gone"].map((id) => O.blockFor(e.prompts.get(id), BOOK, { images: false })).join("\n\n")]);
  });

  test("an edit made while its block is on its way stays newer than the send: the next send-all updates it", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700)], fetch: (url, init, env2) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      const reply = notesServer()(url, init, env2);
      return gate.then(() => ({ ok: true, status: 200, json: () => Promise.resolve(reply.body) }));
    } });
    const running = O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    await tick();
    assert.equal(posts(e).length, 1, "the request is under way");
    edit(e, "b", "Q. b, edited while sending?\nA. yes");     // stamped now, as M.cache.savePrompt does
    const editedAt = e.prompts.get("b").contentUpdatedAt;
    await new Promise((r) => setTimeout(r, 5));               // the answer comes later than the edit
    release();
    const res = await running;
    assert.equal(res.sent, 2);
    assert.equal(e.prompts.get("b").obsidianFile, "Notes/Marginalia/Griffiths.md", "the earlier text was written and is recorded");
    assert.ok(e.prompts.get("b").obsidianSentAt < editedAt, "dated before the edit");
    assert.equal(e.prompts.get("b").text, "Q. b, edited while sending?\nA. yes", "the edit is kept");
    assert.deepEqual([O.sendState(e.prompts.get("a")), O.sendState(e.prompts.get("b"))], ["unchanged", "changed"]);
    e.fetches.length = 0;
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(posts(e).map((b) => b.blocks.map((x) => [x.blockId, x.replaceOnly === true])), [[["b", true]]]);
  });

  test("the same when the cached record itself is changed in place while its block is on its way (as a move to a deck does)", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700)], fetch: (url, init, env2) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      const reply = notesServer()(url, init, env2);
      return gate.then(() => ({ ok: true, status: 200, json: () => Promise.resolve(reply.body) }));
    } });
    const running = O.sendAll(BOOK.id, { fromGesture: true });
    for (let i = 0; i < 5 && !posts(e).length; i++) await tick();
    assert.equal(posts(e).length, 1, "the request is under way");
    const rec = e.prompts.get("b");                          // the very object the send-all planned with
    rec.text = "Q. b, changed in place?\nA. yes";
    rec.contentUpdatedAt = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    release();
    assert.equal((await running).sent, 2);
    assert.equal(e.prompts.get("b").obsidianSentAt, rec.contentUpdatedAt - 1, "dated just before the change");
    assert.deepEqual([O.sendState(e.prompts.get("a")), O.sendState(e.prompts.get("b"))], ["unchanged", "changed"]);
  });

  test("several vaults and none chosen: only the cards that would go fail; with nothing to send no vault is needed", async () => {
    const two = { status: 200, body: { vaults: [{ id: "a", name: "A" }, { id: "b", name: "B" }] } };
    const e = env({ prompts: [bp("n", 0, 700), bp("u", 1, 700, { obsidianSentAt: 5, contentUpdatedAt: 5 })],
      fetch: (url) => (url === "/api/obsidian/vaults" ? two : { status: 500, body: {} }) });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([res.failed, res.unchanged], [[{ promptId: "n", error: "choose a vault in Settings › Obsidian" }], 1]);
    assert.equal(last(e).text, "0 sent, 1 could not be sent — choose a vault in Settings › Obsidian");
    e.prompts.delete("n");
    const asked = e.fetches.length;
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.ok, plan.count, plan.unchanged, plan.error], [true, 0, 1, undefined]);
    assert.equal(e.fetches.length, asked);
  });

  test("a deck: the same rules, and the toast quotes the deck's name", async () => {
    const e = env({ prompts: [dp("v1", "Verbs", 10, { obsidianSentAt: 20, obsidianFile: "Notes/Marginalia/Thermo formulas.md", contentUpdatedAt: 15 })], fetch: notesServer() });
    const res = await O.sendAll(DECK.id, { fromGesture: true });
    assert.deepEqual([res.sent, res.unchanged, e.fetches.length], [0, 1, 0]);
    assert.equal(last(e).text, "Everything in “Thermo formulas” is already in Obsidian");
    const none = await O.sendAll(EMPTY.id, { fromGesture: true });
    assert.deepEqual([none.ok, none.sent], [true, 0]);
    assert.equal(last(e).text, "Nothing in “Nothing yet” to send to Obsidian");
  });
});

// ------------------------------------------------------------------ a send whose answer never came (A8: never a card twice)

describe("a send-all whose answer never came: the server may have written it, so no card is added twice", () => {
  afterEach(cleanup);
  const NOTE = "Notes/Marginalia/Griffiths.md", RENAMED = "Notes/Marginalia/Griffiths (2nd ed.).md";
  const rename = (e) => e.cols.set(BOOK.id, Object.assign({}, BOOK, { name: "Griffiths (2nd ed.)" }));
  // the cards' records now: [id, marker, obsidianSentAt, obsidianFile, content stamp]
  const remembered = (e, ids) => ids.map((id) => { const p = e.prompts.get(id); return [id, p.obsidianPendingFile, p.obsidianSentAt, p.obsidianFile, p.contentUpdatedAt]; });

  test("the cards remember the note it was writing to; after a rename the next send-all updates their copies there", async () => {
    const srv = vaultServer();
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700, { kind: "highlight", text: "" }), bp("s", 2, 700, { obsidianSentAt: 5, obsidianFile: NOTE })], fetch: srv.fetch });
    srv.lose = () => "drop";
    let res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(res.failed, [{ promptId: "a", error: "Marginalia's server did not answer" }, { promptId: "b", error: "Marginalia's server did not answer" }]);
    assert.deepEqual([srv.copies("a"), srv.copies("b")], [{ [NOTE]: 1 }, { [NOTE]: 1 }], "written all the same");
    assert.deepEqual([last(e).text, last(e).actions.map((a) => a.label)], ["0 sent, 2 may already be in Obsidian — Marginalia's server did not answer", []]);
    // a reminder, not a send: obsidianSentAt stays unset (the cards are still new) and nothing counts as an edit
    assert.deepEqual(remembered(e, ["a", "b"]), [["a", NOTE, undefined, undefined, 1], ["b", NOTE, undefined, undefined, 1]]);
    assert.deepEqual(markersOf(e), [["a", NOTE], ["b", NOTE]], "written ahead, and left as they were: s was in no request");
    assert.deepEqual(["a", "b"].map((id) => O.sendState(e.prompts.get(id))), ["fresh", "fresh"]);

    rename(e);
    srv.lose = null;
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.count, plan.fresh, plan.file, plan.files], [2, 2, NOTE, [NOTE]], "the confirm names that note");
    res = await O.sendAll(BOOK.id, { fromGesture: true });
    const sent = posts(e)[1];
    assert.equal(sent.file, NOTE);
    assert.deepEqual(sent.blocks.map((x) => [x.blockId, x.replaceOnly === true]), [["a", false], ["b", false]],
      "sent as new: the server replaces the copy it finds there, else adds it");
    assert.deepEqual([res.ok, res.sent, res.added, res.updated, res.unchanged, res.files], [true, 2, 0, 2, 1, [NOTE]]);
    assert.deepEqual([srv.copies("a"), srv.copies("b")], [{ [NOTE]: 1 }, { [NOTE]: 1 }], "one copy each, in the note that held it");
    assert.equal(last(e).text, "Sent to Obsidian · " + NOTE + ": 0 added, 2 updated, 1 already there");
    const a = e.prompts.get("a");
    assert.deepEqual([typeof a.obsidianSentAt, a.obsidianFile, "obsidianPendingFile" in a], ["number", NOTE, false], "the record replaces the reminder");
    assert.equal(O.sendState(a), "unchanged");

    e.prompts.set("n", bp("n", 3, 700));                       // a card never sent still goes to the new name
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([posts(e)[2].file, posts(e)[2].blocks.map((x) => x.blockId)], [RENAMED, ["n"]]);
  });

  test("the same after a folder change or a move to a deck", async () => {
    for (const change of ["folder", "deck"]) {
      const srv = vaultServer();
      const e = env({ prompts: [bp("a", 0, 700)], fetch: srv.fetch });
      srv.lose = () => "drop";
      await O.sendAll(BOOK.id, { fromGesture: true });
      srv.lose = null;
      let cid = BOOK.id;
      if (change === "folder") e.values.obsidianFolder = "Notes/Elsewhere";
      else {
        cid = DECK.id;
        e.prompts.set("a", Object.assign({}, e.prompts.get("a"), { collectionId: DECK.id, anchor: null, contentUpdatedAt: Date.now(),
          context: { docName: DECK.name, sectionLabel: null, pageIndex: null, pageLabel: null } }));
      }
      const res = await O.sendAll(cid, { fromGesture: true });
      assert.equal(posts(e)[1].file, NOTE, change);
      assert.deepEqual([res.added, res.updated], [0, 1], change);
      assert.deepEqual(srv.copies("a"), { [NOTE]: 1 }, change + ": one copy");
    }
  });

  test("an answer cut short (200, but its body never came) counts as no answer", async () => {
    const srv = vaultServer();
    const e = env({ prompts: [bp("a", 0, 700)], fetch: srv.fetch });
    srv.lose = () => "cut";
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(res.failed.map((f) => f.promptId), ["a"]);
    assert.deepEqual(remembered(e, ["a"]), [["a", NOTE, undefined, undefined, 1]]);
    rename(e);
    srv.lose = null;
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(posts(e)[1].file, NOTE);
    assert.deepEqual(srv.copies("a"), { [NOTE]: 1 });
  });

  test("a serve.py from before /notes: a POST /note with no answer is remembered too, and nothing more goes", async () => {
    const srv = vaultServer({ old: true });
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700)], fetch: srv.fetch });
    srv.lose = (url) => (url === "/api/obsidian/note" ? "drop" : null);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(res.failed.map((f) => f.promptId), ["a", "b"]);
    assert.equal(posts(e, "/api/obsidian/note").length, 1, "b never went");
    assert.deepEqual(remembered(e, ["a", "b"]), [["a", NOTE, undefined, undefined, 1], ["b", undefined, undefined, undefined, 1]], "only the card that went");
    rename(e);
    srv.lose = null;
    const again = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(posts(e, "/api/obsidian/note").slice(1).map((b) => [b.blockId, b.file]), [["a", NOTE], ["b", RENAMED]]);
    assert.deepEqual([again.added, again.updated], [1, 1]);
    assert.deepEqual([srv.copies("a"), srv.copies("b")], [{ [NOTE]: 1 }, { [RENAMED]: 1 }]);
  });

  test("a refused request wrote nothing: nothing is remembered, and after a rename the cards go to the new name", async () => {
    const e = env({ prompts: [bp("a", 0, 700)], fetch: (url) => (url === "/api/obsidian/vaults" ? ONE_VAULT
      : { status: 409, body: { ok: false, error: "the note is read-only (locked in Finder or chmod)" } }) });
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([recordsOf(e), markersOf(e), markerOf(e, "a")], [[], [["a", NOTE], ["a", undefined]], undefined],
      "written ahead, then put back: the 409 wrote nothing");
    rename(e);
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(posts(e)[1].file, RENAMED);
  });

  test("when the lost request never reached the server, the next send adds the cards to that note, once", async () => {
    const srv = vaultServer();
    const e = env({ prompts: [bp("a", 0, 700)], fetch: srv.fetch });
    srv.lose = () => "down";
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([srv.copies("a"), remembered(e, ["a"])], [{}, [["a", NOTE, undefined, undefined, 1]]], "the page cannot tell");
    rename(e);
    srv.lose = null;
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([posts(e)[1].file, res.added, res.updated], [NOTE, 1, 0]);
    assert.deepEqual(srv.copies("a"), { [NOTE]: 1 });
  });
});

describe("Send all through a link, too long for one: the copy's toast names the edited cards a link cannot update", () => {
  afterEach(cleanup);
  const big = (id, page) => bp(id, page, 700, { text: "Q. " + "w".repeat(40000) + "\nA. x" });
  const edited = () => bp("ed", 3, 700, { obsidianSentAt: 5, obsidianFile: "Notes/Marginalia/Griffiths.md", contentUpdatedAt: 9 });
  const LINE = "1 edited card was not updated: links can only add. Start Marginalia with the marginalia command to write silently and update in place.";

  test("copied: the toast's detail names it; its block is not in the copy, and its record stays", async () => {
    const e = env({ prompts: [big("b1", 0), big("b2", 1), edited()], hostname: "claude.ai", protocol: "https:", artifact: true });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    assert.deepEqual([res.mode, res.error, res.notUpdated], ["copy", "too_long", [{ promptId: "ed", error: "links can only add" }]]);
    assert.deepEqual([e.opened.length, e.patches.length], [0, 0]);
    assert.deepEqual(e.copied, [["b1", "b2"].map((id) => O.blockFor(e.prompts.get(id), BOOK, { images: false })).join("\n\n")]);
    assert.deepEqual([last(e).text, last(e).detail], ["Notes copied — paste them into Notes/Marginalia/Griffiths.md", LINE]);
    assert.equal(e.prompts.get("ed").obsidianSentAt, 5);
  });

  test("a refused copy says it too, and so does the copy its Copy notes makes; with no edited card there is no such line", async () => {
    const e = env({ prompts: [big("b1", 0), big("b2", 1), edited()], hostname: "claude.ai", protocol: "https:", artifact: true, refuse: 1 });
    await O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    let t = last(e);
    assert.deepEqual([t.text, t.detail, t.actions.map((a) => a.label)], ["The browser blocked the clipboard — the notes were not copied", LINE, ["Copy notes"]]);
    t.actions[0].run();
    await tick();
    t = last(e);
    assert.deepEqual([t.text, t.detail, e.copied.length], ["Notes copied — paste them into Notes/Marginalia/Griffiths.md", LINE, 1]);

    const plain = env({ prompts: [big("b1", 0), big("b2", 1)], hostname: "claude.ai", protocol: "https:", artifact: true });
    await O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    assert.deepEqual([last(plain).text, last(plain).detail == null], ["Notes copied — paste them into Notes/Marginalia/Griffiths.md", true]);
  });

  test("an older server answered: the line says to restart", async () => {
    const e = env({ prompts: [big("b1", 0), big("b2", 1), edited()] });     // GET /vaults 404 on 127.0.0.1: outdated
    await O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    assert.equal(last(e).detail, "1 edited card was not updated: links can only add. Restart Marginalia (marginalia restart in Terminal) to write silently and update in place.");
  });
});

// ------------------------------------------------------------------ A9: a send that did not finish is never added twice

describe("FEATURES A9: the marker of a server send that did not finish (obsidianPendingFile)", () => {
  afterEach(cleanup);
  const NOTE = "Notes/Marginalia/Griffiths.md";
  const HELD = "a send to Marginalia's server did not finish";
  const held = (n, restart) => (n === 1 ? "1 card" : n + " cards") + " may already be in Obsidian: a send to Marginalia's server did not finish. " +
    (restart ? "Restart Marginalia (marginalia restart in Terminal)" : "Start Marginalia with the marginalia command") +
    " and send again: it checks the note and never adds a second copy.";
  const down = () => new Error("Failed to fetch");          // Marginalia's server stopped: obsidian:// links (not an older server)
  // n1 never sent; m1 never sent, marked; m2 sent, not edited, marked; ed sent, edited; m3 sent, edited, marked
  const mixed = () => [bp("n1", 0, 700), bp("m1", 1, 700, { obsidianPendingFile: NOTE }),
    bp("m2", 2, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 5, obsidianPendingFile: NOTE }),
    bp("ed", 3, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 9 }),
    bp("m3", 4, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 9, obsidianPendingFile: NOTE })];

  test("link (A9.1): marked cards are never in the link, whatever their state; they are held back, named, and keep their marker", async () => {
    const e = env({ prompts: mixed(), fetch: down });
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.ok, plan.mode, plan.outdated, plan.count, plan.fresh, plan.changed, plan.unchanged, plan.rechecked, plan.held, plan.sentBefore, plan.total, plan.skipped, plan.files],
      [true, "link", false, 1, 1, 1, 0, 0, 3, 1, 5, 4, [NOTE]]);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.opened.length, 1);
    assert.equal(contentOf(e.opened[0]), O.blockFor(e.prompts.get("n1"), BOOK, { images: false }), "only n1 goes (no title: sends record the note)");
    assert.deepEqual(res.held, ["m1", "m2", "m3"].map((id) => ({ promptId: id, error: HELD })));
    assert.deepEqual([res.ok, res.mode, res.sent, res.added, res.skipped, res.notUpdated], [true, "link", 1, 1, 4, [{ promptId: "ed", error: "links can only add" }]]);
    assert.deepEqual(recordsOf(e), [["n1", NOTE]]);
    assert.deepEqual(markersOf(e), [], "a link writes no marker and settles none");
    assert.deepEqual(["m1", "m2", "m3"].map((id) => markerOf(e, id)), [NOTE, NOTE, NOTE]);
    const t = last(e);
    assert.equal(t.text, "Sent to Obsidian · " + NOTE + ": 1 added, 0 updated, 0 already there");
    assert.equal(t.detail, "Sent through an obsidian:// link. 1 edited card was not updated: links can only add. " + held(3));
    assert.equal(t.ttl, 12000);
    assert.deepEqual(t.actions.map((a) => a.label), ["Open in Obsidian"], "nothing to copy");
  });

  test("link (A9.1): when every card a link could send is marked, nothing opens and the toast is the A9.1 line; planAll counts 0", async () => {
    for (const outdated of [false, true]) {
      const e = env({ prompts: [bp("m1", 0, 700, { obsidianPendingFile: NOTE }), bp("ed", 1, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 9 })],
        fetch: outdated ? undefined : down });                 // undefined: GET /vaults answers 404 on 127.0.0.1, an older serve.py
      const plan = await O.planAll(BOOK.id);
      assert.deepEqual([plan.ok, plan.mode, plan.outdated, plan.count, plan.held, plan.changed, plan.tooLong], [true, "link", outdated, 0, 1, 1, false]);
      const res = await O.sendAll(BOOK.id, { fromGesture: true });
      assert.deepEqual([res.sent, res.held.map((x) => x.promptId), res.notUpdated.map((x) => x.promptId), e.opened.length, e.patches.length],
        [0, ["m1"], ["ed"], 0, 0]);
      const t = last(e);
      assert.deepEqual([t.text, t.detail, t.actions || []], [held(1, outdated), "1 edited card was not updated: links can only add.", []], String(outdated));
      cleanup();
    }
  });

  test("link (A9.1), too long for one link: the marked cards are not in the copied text, and the copy's toast names them", async () => {
    const big = (id, page, over) => bp(id, page, 700, Object.assign({ text: "Q. " + id + " " + "w".repeat(40000) + "\nA. x" }, over || {}));
    const e = env({ prompts: [big("b1", 0), big("m1", 1, { obsidianPendingFile: NOTE }), big("b2", 2),
      bp("ed", 3, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 9 })], fetch: down });
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.count, plan.held, plan.tooLong], [2, 1, true]);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    assert.deepEqual([res.mode, res.error, res.held.map((x) => x.promptId), e.opened.length, e.patches.length], ["copy", "too_long", ["m1"], 0, 0]);
    assert.equal(e.copied.length, 1);
    assert.equal(e.copied[0], ["b1", "b2"].map((id) => O.blockFor(e.prompts.get(id), BOOK, { images: false })).join("\n\n"));
    assert.ok(!e.copied[0].includes("marginalia:m1"), "the marked card is not in the copy: copying it invites the second copy");
    assert.deepEqual([last(e).text, last(e).detail], ["Notes copied — paste them into " + NOTE, "1 edited card was not updated: links can only add. " + held(1)]);
    // the same with no edited card: only the A9.1 line
    const e2 = env({ prompts: [big("b1", 0), big("m1", 1, { obsidianPendingFile: NOTE }), big("b2", 2)], fetch: down });
    await O.sendAll(BOOK.id, { fromGesture: true });
    await tick();
    assert.deepEqual([e2.copied.length, last(e2).detail], [1, held(1)]);
  });

  test("server (A9.2): every card's marker is in place, in one write, when the request leaves; the records replace them after", async () => {
    let atRequest = null;
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700, { kind: "highlight", text: "" }), bp("c", 2, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 9 })],
      fetch: notesServer(null, (url, init, env2) => {
        if (url === "/api/obsidian/notes") atRequest = { markers: ["a", "b", "c"].map((id) => env2.prompts.get(id).obsidianPendingFile), writes: env2.writes };
        return null;
      }) });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(atRequest, { markers: [NOTE, NOTE, NOTE], writes: 1 }, "stored before the request left, in one write");
    assert.deepEqual([res.ok, res.sent, e.writes], [true, 3, 2]);
    assert.deepEqual(["a", "b", "c"].map((id) => markerOf(e, id)), [undefined, undefined, undefined], "cleared by the records");
    assert.deepEqual(recordsOf(e).map((r) => r[0]), ["a", "b", "c"]);
    assert.ok(["a", "b"].every((id) => e.prompts.get(id).contentUpdatedAt === 1) && e.prompts.get("c").contentUpdatedAt === 9, "no content edit");
  });

  test("server (A9.2): the answer settles each marker — written: cleared; a 4xx or a per-block ok: false (notFound too): put back; a 5xx, no answer, a cut body or a block left out of the results: kept", async () => {
    const OLDF = "Notes/Marginalia/Old.md";
    // r1 was marked by an earlier send that did not finish: put back means back to that marker, not removed
    const list = () => [bp("w", 0, 700), bp("x", 1, 700), bp("r1", 2, 700, { obsidianPendingFile: NOTE }),
      bp("g", 3, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 9 }), bp("s", 4, 700), bp("o", 5, 700, { obsidianSentAt: 5, obsidianFile: OLDF, contentUpdatedAt: 9 })];
    // per block: w written, x refused (ok: false), r1 refused, g not found, s left out of the results; o's request (Old.md) as `old`
    const perBlock = (old) => (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      const b = JSON.parse(init.body);
      if (b.file === OLDF) return old();
      return { status: 200, body: { ok: true, file: b.file, results: b.blocks.filter((y) => y.blockId !== "s").map((y) =>
        y.blockId === "w" ? { blockId: "w", ok: true, replaced: false }
          : y.blockId === "g" ? { blockId: "g", ok: false, notFound: true, error: "its earlier copy is no longer in the note" }
            : { blockId: y.blockId, ok: false, error: "the block has a code fence left open" }) } };
    };
    const cases = [
      ["409", () => ({ status: 409, body: { ok: false, error: "the note is read-only (locked in Finder or chmod)" } }), undefined],
      ["400 with results", () => ({ status: 400, body: { ok: false, error: "no block could be written", results: [{ blockId: "o", ok: false, error: "bad" }] } }), undefined],
      ["500", () => ({ status: 500, body: { ok: false, error: "unexpected error" } }), OLDF],
      ["no answer", () => new Error("Failed to fetch"), OLDF],
      ["cut body", () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new TypeError("network error")) }), OLDF]
    ];
    for (const [name, old, oMarker] of cases) {
      const e = env({ prompts: list(), fetch: perBlock(old) });
      const res = await O.sendAll(BOOK.id, { fromGesture: true });
      assert.deepEqual(posts(e).map((b) => b.file), [NOTE, OLDF], name);
      assert.deepEqual(recordsOf(e).map((r) => r[0]), ["w"], name);
      assert.deepEqual(["w", "x", "r1", "g", "s", "o"].map((id) => markerOf(e, id)), [undefined, undefined, NOTE, undefined, NOTE, oMarker], name);
      assert.deepEqual([res.sent, res.notFound.map((y) => y.promptId), res.failed.map((y) => y.promptId)], [1, ["g"], ["x", "r1", "s", "o"]], name);
    }
  });

  test("server (A9.3): a marked card that is otherwise unchanged goes all the same, with replaceOnly, and its marker goes", async () => {
    const e = env({ prompts: [bp("u", 0, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 5, obsidianPendingFile: NOTE }),
      bp("x", 1, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 5 })], fetch: notesServer(new Set(["u", "x"])) });
    assert.equal(O.sendState(e.prompts.get("u")), "unchanged", "by its stamps alone");
    const plan = await O.planAll(BOOK.id);
    assert.deepEqual([plan.mode, plan.count, plan.fresh, plan.changed, plan.rechecked, plan.unchanged, plan.held, plan.sentBefore, plan.skipped, plan.files],
      ["server", 1, 0, 0, 1, 1, 0, 2, 1, [NOTE]]);
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(posts(e).map((b) => [b.file, b.blocks.map((y) => [y.blockId, y.replaceOnly === true])]), [[NOTE, [["u", true]]]]);
    assert.deepEqual([res.ok, res.sent, res.added, res.updated, res.unchanged], [true, 1, 0, 1, 1]);
    const u = e.prompts.get("u");
    assert.deepEqual(["obsidianPendingFile" in u, u.obsidianFile, u.obsidianSentAt > 5], [false, NOTE, true], "settled: the record, no marker");
    assert.equal(last(e).text, "Sent to Obsidian · " + NOTE + ": 0 added, 1 updated, 1 already there");
    // and then it is unchanged for good: nothing more goes
    e.fetches.length = 0;
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(e.fetches.length, 0);
  });

  test("server (A9.3): a marked unchanged card whose copy is gone is listed, keeps its record and its marker; an older server holds it back", async () => {
    const e = env({ prompts: [bp("u", 0, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 5, obsidianPendingFile: NOTE })],
      fetch: (url, init) => (url === "/api/obsidian/vaults" ? ONE_VAULT : { status: 200, body: { ok: true, file: NOTE, results: [
        { blockId: "u", ok: false, notFound: true, error: "its earlier copy is no longer in the note" }] } }) });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([res.sent, res.notFound.map((y) => y.promptId)], [0, ["u"]]);
    assert.deepEqual([markerOf(e, "u"), e.prompts.get("u").obsidianSentAt], [NOTE, 5], "the marker goes back to what it was before this request");
    // a serve.py from before replaceOnly: no request carries it, and the marker stays
    const e2 = env({ prompts: [bp("u", 0, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 5, obsidianPendingFile: NOTE }), bp("n", 1, 700)],
      fetch: (url, init) => (url === "/api/obsidian/vaults" ? OLD_VAULTS : notesServer()(url, init)) });
    const res2 = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(posts(e2).map((b) => b.blocks.map((y) => y.blockId)), [["n"]]);
    assert.deepEqual([res2.sent, res2.notUpdated.map((y) => y.promptId), markerOf(e2, "u")], [1, ["u"], NOTE]);
  });

  test("no re-render storm: a 200-card send-all writes the send record in two calls, whatever the number of cards; no savePrompt", async () => {
    const list = [];
    for (let i = 0; i < 200; i++) list.push(bp("c" + i, i, 700));
    const e = env({ prompts: list, fetch: notesServer() });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([res.ok, res.sent, posts(e).length], [true, 200, 1]);
    assert.deepEqual([e.writes, e.saves.length, e.patches.length], [2, 0, 400], "the markers in one call, the records in one more");
    // through a link: one call for the records
    const e2 = env({ prompts: list, fetch: down });
    const res2 = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([res2.mode, res2.sent, e2.writes, e2.saves.length], ["link", 200, 1, 0]);
  });

  test("a cache without patchPrompts gets one savePrompt(copy, {content: false}) per record that changes", async () => {
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700)], noPatch: true, fetch: notesServer() });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([res.ok, res.sent], [true, 2]);
    assert.deepEqual(e.saves.map((s) => [s.p.id, s.p.obsidianPendingFile, typeof s.p.obsidianSentAt, s.o.content]),
      [["a", NOTE, "undefined", false], ["b", NOTE, "undefined", false], ["a", undefined, "number", false], ["b", undefined, "number", false]]);
    assert.ok(["a", "b"].every((id) => !("obsidianPendingFile" in e.prompts.get(id))));
  });

  test("A9.4: a tab that steps aside while the markers are stored sends nothing; the markers stay for the active tab", async () => {
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700)], fetch: notesServer() });
    const patch = M.cache.patchPrompts;
    M.cache.patchPrompts = (changes) => { const r = patch(changes); e.locked = { reason: "othertab", by: "tab_b", at: 2 }; return r; };
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(posts(e).length, 0, "the request never left");
    assert.deepEqual(res.failed.map((y) => [y.promptId, y.error]), [["a", "Marginalia is open in another tab"], ["b", "Marginalia is open in another tab"]]);
    assert.deepEqual([markerOf(e, "a"), markerOf(e, "b")], [NOTE, NOTE], "written while it was the active tab: left for the active tab to settle");
  });
});

// ------------------------------------------------------------------ repairs after the A9 review (2026-11-10)

describe("repairs: cards a request left unsure, rechecked cards in the toast (the A9 review of 2026-11-10)", () => {
  afterEach(cleanup);
  const NOTE = "Notes/Marginalia/Griffiths.md", OLDF = "Notes/Marginalia/Old.md";
  const AGAIN = (n) => "Send " + (n === 1 ? "it" : "them") + " again once Marginalia's server answers: it checks the note and never adds a second copy.";

  test("D2: cards a request may have written (no answer, a 5xx, a cut body, left out of the results) are named as such and never copied", async () => {
    const lost = [["no answer", () => new Error("Failed to fetch"), "Marginalia's server did not answer"],
      ["500", () => ({ status: 500, body: { ok: false, error: "unexpected error" } }), "unexpected error"],
      ["cut body", () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new TypeError("network error")) }), "the server's answer could not be read"]];
    for (const [name, reply, why] of lost) {
      const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700)], fetch: (url) => (url === "/api/obsidian/vaults" ? ONE_VAULT : reply()) });
      const res = await O.sendAll(BOOK.id, { fromGesture: true });
      assert.deepEqual(res.failed, [{ promptId: "a", error: why }, { promptId: "b", error: why }], name);
      const t = last(e);
      assert.deepEqual([t.text, t.detail, t.actions.map((x) => x.label), t.ttl], ["0 sent, 2 may already be in Obsidian — " + why, AGAIN(2), [], 12000], name);
      assert.deepEqual([markerOf(e, "a"), markerOf(e, "b")], [NOTE, NOTE], name);
      cleanup();
    }
    // a block the answer leaves out: no telling either
    const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700)], fetch: (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      return { status: 200, body: { ok: true, file: NOTE, results: [{ blockId: "a", ok: true, replaced: false }] } };
    } });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(res.failed, [{ promptId: "b", error: "the server's answer left it out" }]);
    assert.deepEqual([last(e).text, last(e).detail, last(e).actions.map((x) => x.label)],
      ["1 sent, 1 may already be in Obsidian — the server's answer left it out", AGAIN(1), ["Open in Obsidian"]]);
  });

  test("D2: with definite failures too, only the cards nothing of which can be in the note are copied", async () => {
    // a and c (Griffiths.md): refused (409); b (Old.md): no answer; d (Older.md): never sent, since nothing more goes after no answer
    const list = [bp("a", 0, 700), bp("b", 1, 700, { obsidianSentAt: 1, obsidianFile: OLDF, contentUpdatedAt: 2 }), bp("c", 2, 700),
      bp("d", 3, 700, { obsidianSentAt: 1, obsidianFile: "Notes/Marginalia/Older.md", contentUpdatedAt: 2 })];
    let n = 0;
    const e = env({ prompts: list, fetch: (url) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      return ++n === 1 ? { status: 409, body: { ok: false, error: "the note is read-only (locked in Finder or chmod)" } } : new Error("connection refused");
    } });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual(res.failed.map((f) => f.promptId), ["a", "c", "b", "d"]);
    const t = last(e);
    assert.equal(t.text, "0 sent, 3 could not be sent — the note is read-only (locked in Finder or chmod)");
    assert.equal(t.detail, "1 may already be in Obsidian (Marginalia's server did not answer). " + AGAIN(1));
    assert.deepEqual(t.actions.map((x) => x.label), ["Copy notes"]);
    t.actions[0].run();
    await tick();
    assert.deepEqual(e.copied, [["a", "c", "d"].map((id) => O.blockFor(e.prompts.get(id), BOOK, { images: false })).join("\n\n")], "b is not copied");
    // a card refused now whose earlier send did not finish is not copied either
    const e2 = env({ prompts: [bp("a", 0, 700), bp("r", 1, 700, { obsidianPendingFile: NOTE })],
      fetch: (url) => (url === "/api/obsidian/vaults" ? ONE_VAULT : { status: 409, body: { ok: false, error: "the note is read-only (locked in Finder or chmod)" } }) });
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(last(e2).text, "0 sent, 2 could not be sent — the note is read-only (locked in Finder or chmod)");
    last(e2).actions[0].run();
    await tick();
    assert.deepEqual(e2.copied, [O.blockFor(e2.prompts.get("a"), BOOK, { images: false })], "only a: r's note may hold it");
  });

  test("D5: a card sent before and not edited since, whose last send did not finish, is never called edited", async () => {
    const marked = () => bp("u", 0, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 5, obsidianPendingFile: NOTE });
    const e = env({ prompts: [marked()], fetch: (url) => (url === "/api/obsidian/vaults" ? ONE_VAULT : { status: 200, body: { ok: true, file: NOTE, results: [
      { blockId: "u", ok: false, notFound: true, error: "its earlier copy is no longer in the note" }] } }) });
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([last(e).text, last(e).actions.map((x) => x.label)],
      ["1 card whose last send did not finish was not updated: its earlier copy is no longer in the note", ["Copy notes"]]);
    // with an edited card gone too, each is named for what it is
    const e2 = env({ prompts: [marked(), bp("ed", 1, 700, { obsidianSentAt: 5, obsidianFile: NOTE, contentUpdatedAt: 9 })],
      fetch: (url, init) => (url === "/api/obsidian/vaults" ? ONE_VAULT : { status: 200, body: { ok: true, file: NOTE, results: JSON.parse(init.body).blocks.map((x) =>
        ({ blockId: x.blockId, ok: false, notFound: true, error: "its earlier copy is no longer in the note" })) } }) });
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([last(e2).text, last(e2).detail], ["1 edited card was not updated: its earlier copy is no longer in the note",
      "1 card whose last send did not finish was not updated: its earlier copy is no longer in the note."]);
    // a serve.py from before replaceOnly holds it back: named the same way
    const e3 = env({ prompts: [marked(), bp("n", 1, 700)], fetch: (url, init) => (url === "/api/obsidian/vaults" ? OLD_VAULTS : notesServer()(url, init)) });
    await O.sendAll(BOOK.id, { fromGesture: true });
    assert.equal(last(e3).detail, "1 card whose last send did not finish was not updated: restart Marginalia (marginalia restart in Terminal) to update it in place.");
  });
});

// ------------------------------------------------------------------ the switch (DECISIONS D32)

describe("the switch (DECISIONS D32): while the Obsidian connection is off a send-all sends nothing", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  const quiet = (e) => [e.fetches.length, e.opened.length, e.patches.length, e.saves.length, e.copied.length];

  test("planAll answers {off: true} and sendAll toasts where to turn it on: no check, no request, no link, no marker", async () => {
    for (const fetch of [notesServer(), undefined]) {        // server mode, then link mode (404)
      const e = env({ prompts: [bp("a", 0, 700), bp("b", 1, 700)], settings: { obsidian: false }, fetch });
      const plan = await O.planAll(BOOK.id);
      assert.deepEqual([plan.ok, plan.error, plan.off, plan.count, plan.total], [false, O.OFF, true, 0, 0]);
      assert.equal(e.toasts.length, 0, "planAll says nothing itself: the library does");
      const res = await O.sendAll(BOOK.id, { fromGesture: true });
      assert.deepEqual([res.ok, res.error, res.sent], [false, O.OFF, 0]);
      assert.deepEqual(quiet(e), [0, 0, 0, 0, 0]);
      assert.deepEqual(e.toasts.map((t) => t.text), [O.OFF]);
      assert.equal(O.isSendingAll(BOOK.id), false);
      assert.ok(Array.from(e.prompts.values()).every((p) => p.obsidianPendingFile === undefined && p.obsidianSentAt === undefined), "no card is marked");
      e.values.obsidian = true;                              // switched on in Settings
      const on = await O.planAll(BOOK.id);
      assert.deepEqual([on.ok, on.off, on.count], [true, undefined, 2], "on: it plans the two cards");
    }
  });

  test("never chosen: off for a library with no send record; on once a card of any book or deck was sent", async () => {
    let e = env({ prompts: [bp("a", 0, 700)], settings: { obsidian: null }, fetch: notesServer() });
    assert.equal((await O.planAll(BOOK.id)).off, true);
    assert.deepEqual(quiet(e), [0, 0, 0, 0, 0]);
    e = env({ prompts: [bp("a", 0, 700), bp("d", 0, 10, { collectionId: DECK.id, anchor: null, obsidianSentAt: 5, obsidianFile: "Notes/Marginalia/Thermo formulas.md" })],
      settings: { obsidian: null }, fetch: notesServer() });
    const res = await O.sendAll(BOOK.id, { fromGesture: true });
    assert.deepEqual([res.ok, res.sent], [true, 1], JSON.stringify(res));
  });

  test("a send-all toast's button that is clicked after the switch went off opens no link: Add to Obsidian, and Open in Obsidian", async () => {
    // link mode without a gesture: "Ready for Obsidian · 2 cards" waits for its button, and the switch goes off meanwhile
    let e = env({ prompts: [bp("n1", 0, 700), bp("n2", 1, 700)] });
    assert.equal((await O.sendAll(BOOK.id, { fromGesture: false })).error, "needs_click");
    const add = last(e).actions[0];
    assert.equal(add.label, "Add to Obsidian");
    e.values.obsidian = false;
    add.run();
    await tick();
    assert.deepEqual([e.opened.length, recordsOf(e).length, e.patches.length], [0, 0, 0], "no link, nothing recorded");
    assert.equal(last(e).text, O.OFF);
    e.values.obsidian = true;
    add.run();
    await tick();
    assert.equal(e.opened.length, 1, "on again: the one link opens");
    assert.equal(recordsOf(e).length, 2);

    // server mode: sent, then the switch goes off, then "Open in Obsidian" of the result's toast
    e = env({ prompts: [bp("a", 0, 700)], fetch: notesServer() });
    assert.equal((await O.sendAll(BOOK.id, { fromGesture: true })).sent, 1);
    const open = last(e).actions.find((a) => a.label === "Open in Obsidian");
    assert.ok(open, "the result's toast offers Open in Obsidian");
    e.values.obsidian = false;
    open.run();
    assert.equal(e.opened.length, 0);
    assert.equal(last(e).text, O.OFF);
    e.values.obsidian = true;
    open.run();
    assert.equal(e.opened.length, 1);
    assert.match(e.opened[0], /^obsidian:\/\/open\?/);
  });

  test("a tab that stepped aside says so before the switch is looked at", async () => {
    const e = env({ prompts: [bp("a", 0, 700)], settings: { obsidian: false }, fetch: notesServer() });
    e.locked = { reason: "othertab", by: "tab_b", at: 2 };
    assert.equal((await O.planAll(BOOK.id)).error, "Marginalia is open in another tab");
    assert.equal((await O.planAll(BOOK.id)).off, undefined);
  });
});
