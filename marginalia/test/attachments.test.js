"use strict";
// Marginalia — test/attachments.test.js: image placeholders that outlive their editor or their session
// (js/attachments.js). A draft that holds ![snip](att:pending-…) is rewritten when the image settles, the
// localStorage ledger resolves a placeholder after a reload, and a placeholder that can never resolve is
// dropped (resolveText, boot sweep) instead of being restored or saved.
// Run: node --test test/attachments.test.js
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "js", "attachments.js");
const DAY = 24 * 3600000;
const DRAFT = "marginalia.draft.p_1";
const LEDGER = "marginalia.placeholder.";

// localStorage and the attachment table survive a reload; module state does not (boot() re-evaluates the file).
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: (k) => { ls.delete(k); },
  get length() { return ls.size; },
  key: (i) => { const k = Array.from(ls.keys())[i]; return k === undefined ? null : k; }
};
const table = new Map(), removed = [], toasts = [];
let livePrompts = [];
const M = globalThis.Marginalia = globalThis.Marginalia || {};
M.store = {
  attachments: {
    get: async (id) => table.get(id) || null,
    put: async (a) => { table.set(a.id, a); },
    remove: async (id) => { table.delete(id); removed.push(id); },
    allIds: async () => Array.from(table.keys())
  },
  meta: { get: async () => null, set: async () => undefined }
};
const liveCache = { prompts: () => livePrompts };
M.cache = liveCache;
M.app = { toast: (o) => { toasts.push(o.text); } };

function boot() {
  delete require.cache[require.resolve(FILE)];
  return require(FILE);
}
function deferred() { const d = {}; d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; }); return d; }
// What fromBlob resolves: the record is in the store already (the real fromBlob stores it before resolving).
function storedAtt(id, createdAt) {
  const a = { id, mime: "image/png", bytes: new ArrayBuffer(1), width: 1, height: 1, byteLength: 1, createdAt: createdAt || Date.now() };
  table.set(id, a);
  return a;
}
// An editor stand-in: placePending puts the token in its text and, with a key, writes the draft the way the
// editor's 300 ms draft write does; open = false is a destroyed editor (resolvePending → false).
function fakeEditor(key, before, after) {
  const ed = {
    pid: null, open: true, text: "",
    placePending(pid) {
      ed.pid = pid;
      ed.text = before + "![snip](att:" + pid + ")" + (after || "");
      if (key) ls.set(key, ed.text);
      return true;
    },
    resolvePending(pid, id) {
      if (!ed.open) return false;
      ed.text = ed.text.split("![snip](att:" + pid + ")").join(id ? "![snip](att:" + id + ")" : "");
      return !!id;
    }
  };
  return ed;
}
const ledgerKeys = () => Array.from(ls.keys()).filter((k) => k.startsWith(LEDGER));
const PNG = { size: 1, type: "image/png" };

beforeEach(() => { ls.clear(); table.clear(); removed.length = 0; toasts.length = 0; livePrompts = []; M.cache = liveCache; });

test("an editor closed while its image decodes: the draft is rewritten to the stored id, which survives a reload and the sweep", async () => {
  let A = boot();
  const decode = deferred();
  A.fromBlob = () => decode.promise;
  const ed = fakeEditor(DRAFT, "Q. see\nA. ");
  const done = A.attach(PNG, ed);
  const pid = ed.pid;
  assert.equal(ls.get(DRAFT), "Q. see\nA. ![snip](att:" + pid + ")");
  ed.open = false;                                               // a route change: editor.destroy() keeps the draft
  decode.resolve(storedAtt("a_real", Date.now() - 2 * DAY));
  assert.equal(await done, null);                                // no editor took it …
  assert.deepEqual(removed, []);                                 // … but the draft holds it
  assert.equal(ls.get(DRAFT), "Q. see\nA. ![snip](att:a_real)");

  A = boot();                                                    // reload
  assert.equal(A.realId(pid), "a_real");
  assert.equal(A.resolveText("x ![snip](att:" + pid + ")"), "x ![snip](att:a_real)");
  assert.deepEqual(await A.sweep(Date.now()), []);
  assert.ok(table.has("a_real"));
  assert.equal(ls.get(DRAFT), "Q. see\nA. ![snip](att:a_real)");
});

test("a placeholder written back after its image landed resolves after a reload; the boot sweep heals the draft and later forgets the ledger entry", async () => {
  let A = boot();
  A.fromBlob = () => Promise.resolve(storedAtt("a_b", Date.now() - 2 * DAY));
  const ed = fakeEditor(null, "Q. ");
  assert.equal((await A.attach(PNG, ed)).id, "a_b");
  const pid = ed.pid;
  assert.equal(ed.text, "Q. ![snip](att:a_b)");
  // a second editor restored the draft while the image decoded and writes its text back afterwards
  ls.set(DRAFT, "Q. ![snip](att:" + pid + ")\nA. b");
  ls.set(LEDGER + "pending-zzzz-1", "{not json");                // a corrupt entry resolves nothing and is dropped

  A = boot();
  assert.equal(A.realId(pid), "a_b");
  assert.equal(A.resolveText(ls.get(DRAFT)), "Q. ![snip](att:a_b)\nA. b");
  assert.equal(A.resolveText("![snip](att:pending-zzzz-1)"), "");
  assert.deepEqual(await A.sweep(Date.now()), []);
  assert.equal(ls.get(DRAFT), "Q. ![snip](att:a_b)\nA. b");      // healed before any editor restores it
  assert.deepEqual(ledgerKeys(), [LEDGER + pid]);                // recent: kept
  assert.deepEqual(await A.sweep(Date.now() + 2 * DAY), []);     // a day on, nothing names the placeholder
  assert.deepEqual(ledgerKeys(), []);
  assert.ok(table.has("a_b"));
});

test("a prompt saved with a placeholder keeps its image across reloads: the ledger entry stays while the prompt names it", async () => {
  let A = boot();
  A.fromBlob = () => Promise.resolve(storedAtt("a_p", Date.now() - 2 * DAY));
  const ed = fakeEditor(null, "");
  await A.attach(PNG, ed);
  livePrompts = [{ id: "p_9", text: "Q. ![snip](att:" + ed.pid + ")\nA. x", deletedAt: null }];

  A = boot();
  assert.deepEqual(await A.sweep(Date.now() + 2 * DAY), []);
  assert.ok(table.has("a_p"));
  assert.deepEqual(ledgerKeys(), [LEDGER + ed.pid]);
  assert.equal(A.realId(ed.pid), "a_p");
  livePrompts = [];                                              // the prompt is gone: so are the entry and the image
  assert.deepEqual(await A.sweep(Date.now() + 2 * DAY), ["a_p"]);
  assert.deepEqual(ledgerKeys(), []);
});

test("a reload mid-decode: the dead placeholder is dropped by resolveText and the boot sweep, so it is never restored or saved", async () => {
  let A = boot();
  A.fromBlob = () => new Promise(() => {});                     // the page reloads before the image is stored
  const ed = fakeEditor(DRAFT, "Q. see ", "\nA. x");
  A.attach(PNG, ed);
  const pid = ed.pid, draft = ls.get(DRAFT);
  assert.equal(A.resolveText(draft), draft);                     // still decoding in this session: kept
  assert.deepEqual(await A.sweep(Date.now()), []);
  assert.equal(ls.get(DRAFT), draft);

  A = boot();
  assert.equal(A.realId(pid), null);
  assert.equal(A.url(pid), null);
  assert.equal(A.resolveText(draft), "Q. see \nA. x");
  const foreign = "![snip](att:pending-never-1) ![snip](att:pending-ab-1)";
  assert.equal(A.resolveText(foreign), foreign);                 // ids of another shape are left alone
  ls.set("marginalia.draft.new:1", "![snip](att:" + pid + ")");  // a draft that held only the placeholder
  assert.deepEqual(await A.sweep(Date.now()), []);
  assert.equal(ls.get(DRAFT), "Q. see \nA. x");
  assert.equal(ls.has("marginalia.draft.new:1"), false);
});

test("a failed image leaves its placeholder in no draft, and this session's resolveText drops it too", async () => {
  const A = boot();
  const decode = deferred();
  A.fromBlob = () => decode.promise;
  const ed = fakeEditor(DRAFT, "a ", " b");
  const done = A.attach(PNG, ed);
  ed.open = false;
  ls.set("marginalia.draft.p_2", "![snip](att:" + ed.pid + ") copy");
  decode.reject(Object.assign(new Error("nope"), { code: "decode" }));
  assert.equal(await done, null);
  assert.equal(ls.get(DRAFT), "a  b");
  assert.equal(ls.get("marginalia.draft.p_2"), " copy");
  assert.equal(A.resolveText("x ![snip](att:" + ed.pid + ")"), "x ");
  assert.equal(A.realId(ed.pid), null);
  assert.match(toasts[0], /could not read/i);
  assert.deepEqual(ledgerKeys(), []);
});

test("a placeholder still decoding is kept by resolveText and the sweep, then healed in every draft that holds it", async () => {
  const A = boot();
  const decode = deferred();
  A.fromBlob = () => decode.promise;
  const ed = fakeEditor(DRAFT, "Q. ");
  const done = A.attach(PNG, ed);
  ed.open = false;
  const tok = "![snip](att:" + ed.pid + ")";
  ls.set("marginalia.draft.p_2", "Q. " + tok);                   // another editor restored it early
  assert.equal(A.resolveText(tok), tok);
  assert.deepEqual(await A.sweep(Date.now()), []);
  assert.equal(ls.get(DRAFT), "Q. " + tok);
  decode.resolve(storedAtt("a_late"));
  assert.equal(await done, null);
  assert.equal(ls.get(DRAFT), "Q. ![snip](att:a_late)");
  assert.equal(ls.get("marginalia.draft.p_2"), "Q. ![snip](att:a_late)");
  assert.deepEqual(removed, []);
});

test("an image nothing holds any more is discarded together with its ledger entry", async () => {
  const A = boot();
  const decode = deferred();
  A.fromBlob = () => decode.promise;
  const ed = fakeEditor(DRAFT, "Q. ");
  const done = A.attach(PNG, ed);
  ed.open = false;
  ls.delete(DRAFT);                                              // Esc: the editor cleared its draft
  decode.resolve(storedAtt("a_gone"));
  assert.equal(await done, null);
  assert.deepEqual(removed, ["a_gone"]);
  assert.deepEqual(ledgerKeys(), []);
});

test("a host fromBlob that resolves no attachment fails like a decode error: the placeholder never hangs", async () => {
  const A = boot();
  A.fromBlob = () => Promise.resolve(null);
  const calls = [];
  const ed = { placePending(p) { calls.push(["place", p]); return true; }, resolvePending(p, id) { calls.push(["resolve", p, id]); return false; } };
  assert.equal(await A.attach(PNG, ed), null);
  assert.deepEqual(calls[1], ["resolve", calls[0][1], null]);
  assert.match(toasts[0], /could not read/i);
  assert.equal(A.resolveText("![snip](att:" + calls[0][1] + ")"), "");
});

test("a new session never reuses a placeholder tag that a draft or the ledger still names", () => {
  ls.set("marginalia.draft.p_9", "Q. ![snip](att:pending-abcd-1)");
  ls.set(LEDGER + "pending-wxyz-2", JSON.stringify({ id: "a_w", at: Date.now() }));
  const A = boot();
  const at = (tag) => (parseInt(tag, 36) + 0.5) / 1679616;
  const seq = [at("abcd"), at("wxyz"), at("k3x9")], orig = Math.random;
  let pid = null;
  Math.random = () => (seq.length ? seq.shift() : orig());
  try {
    A.fromBlob = () => new Promise(() => {});
    A.attach(PNG, { placePending(p) { pid = p; return true; }, resolvePending() { return false; } });
  } finally { Math.random = orig; }
  assert.equal(pid, "pending-k3x9-1");
});

test("handleDrop: an image whose settling throws does not strand the placeholders after it", async () => {
  const A = boot();
  const blobs = [deferred(), deferred()];
  let n = 0;
  A.fromBlob = () => blobs[n++].promise;
  const resolved = [];
  const ed = { placePending() { return true; }, resolvePending(p, id) { resolved.push(id); return id === "a_2"; } };
  M.cache = { prompts: () => { throw new Error("cache down"); } };   // discard() of the first image throws
  const ev = { dataTransfer: { items: [], files: [{ type: "image/png", size: 1 }, { type: "image/png", size: 1 }] }, preventDefault() {} };
  assert.equal(A.handleDrop(ev, ed), true);
  blobs[0].resolve(storedAtt("a_1"));
  blobs[1].resolve(storedAtt("a_2"));
  for (let i = 0; i < 20 && resolved.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(resolved, ["a_1", "a_2"]);
});
