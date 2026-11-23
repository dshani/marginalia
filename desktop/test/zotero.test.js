"use strict";
// Marginalia for Zotero (zotero/, DECISIONS D34): the menu item's rules (zotero/marginalia.js, with stand-ins for Zotero's
// items, its MenuManager and `open`) and the .xpi that scripts/zotero.js packs. Nothing here runs Zotero or `open`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const plugin = require("../zotero/marginalia");
const pack = require("../scripts/zotero");

const ZOTERO = path.join(__dirname, "..", "zotero");

// Zotero's items: an attachment {pdf, file} (file null: not on this Mac) or a regular item {attachments, best}
function fakeZotero() {
  const items = new Map();
  let next = 1;
  const Z = { isMac: true, Items: { get: (id) => items.get(id) || null }, menus: [], unregistered: [] };
  Z.MenuManager = { registerMenu: (o) => { Z.menus.push(o); return "menu-1"; }, unregisterMenu: (id) => { Z.unregistered.push(id); } };
  Z.attachment = (o) => {
    const it = { id: next++, isPDFAttachment: () => o.pdf !== false, isRegularItem: () => false,
      getFilePathAsync: async () => (o.file === undefined ? "/Zotero/storage/" + it.id + "/paper.pdf" : o.file) };
    items.set(it.id, it);
    return it;
  };
  Z.regular = (attachments, best) => {
    const it = { id: next++, isPDFAttachment: () => false, isRegularItem: () => true, getAttachments: () => attachments.map((a) => a.id),
      getBestAttachment: async () => (best === undefined ? attachments[0] || false : best) };
    items.set(it.id, it);
    return it;
  };
  Z.note = () => ({ id: next++, isPDFAttachment: () => false, isRegularItem: () => false });
  return Z;
}
function setup(o) {
  const Z = fakeZotero(), runs = [], alerts = [];
  const p = plugin.make({ Zotero: Z, id: "{plugin}", alert: (title, text) => alerts.push({ title, text }),
    exec: async (cmd, args) => { runs.push([cmd].concat(args)); if (o && o.fail) throw new Error("/usr/bin/open returned exit status 1"); return true; } });
  return { Z, p, runs, alerts };
}

test("the menu item: on the item list's menu, shown only on a Mac for an item with a PDF, taken away on shutdown", () => {
  const { Z, p } = setup();
  assert.equal(p.register(), true);
  assert.equal(p.register(), false, "once");
  const m = Z.menus[0];
  assert.equal(m.target, "main/library/item");
  assert.equal(m.pluginID, "{plugin}");
  assert.equal(m.menus.length, 1);
  assert.equal(m.menus[0].menuType, "menuitem");
  assert.equal(m.menus[0].l10nID, "marginalia-open-in-marginalia");
  const shown = (items) => { let v = null; m.menus[0].onShowing({}, { items, setVisible: (x) => { v = x; } }); return v; };
  const pdf = Z.attachment({}), epub = Z.attachment({ pdf: false });
  assert.equal(shown([pdf]), true);
  assert.equal(shown([Z.regular([epub, pdf])]), true);
  assert.equal(shown([Z.regular([epub])]), false);
  assert.equal(shown([Z.note(), epub]), false);
  assert.equal(shown([]), false);
  Z.isMac = false;
  assert.equal(shown([pdf]), false, "the app is a Mac app");
  p.unregister();
  assert.deepEqual(Z.unregistered, ["menu-1"]);
});

test("the label is in the plugin's Fluent file, which each main window loads and gives back", () => {
  const ftl = fs.readFileSync(path.join(ZOTERO, "locale", "en-US", plugin.FTL), "utf8");
  assert.match(ftl, new RegExp("^" + plugin.L10N_ID + " =\\n    \\.label = Open in Marginalia\\n$"));
  const inserted = [];
  let removed = 0;
  const win = { MozXULElement: { insertFTLIfNeeded: (f) => inserted.push(f) },
    document: { querySelector: (sel) => (sel === '[href="' + plugin.FTL + '"]' ? { remove: () => { removed++; } } : null) } };
  const { p } = setup();
  p.addToWindow(win);
  p.removeFromWindow(win);
  assert.deepEqual(inserted, [plugin.FTL]);
  assert.equal(removed, 1);
});

test("open: each item's PDF, once, through `open -b local.marginalia.desktop`; a regular item gives its best PDF attachment", async () => {
  const { Z, p, runs, alerts } = setup();
  const a = Z.attachment({}), b = Z.attachment({}), epub = Z.attachment({ pdf: false });
  const paper = Z.regular([a, b], b);                  // Zotero's best attachment is b
  const book = Z.regular([epub, a], epub);              // the best is no PDF: its first PDF instead
  const r = await p.open([paper, book, a, Z.note()]);
  assert.deepEqual(runs, [["/usr/bin/open", "-b", "local.marginalia.desktop", "/Zotero/storage/" + b.id + "/paper.pdf", "/Zotero/storage/" + a.id + "/paper.pdf"]]);
  assert.deepEqual(r, { opened: 2, missing: 0, cut: false, error: null });
  assert.deepEqual(alerts, []);
  assert.equal(plugin.BUNDLE_ID, require("../scripts/build").BUNDLE_ID);
});

test("open: a PDF that is not on this Mac is left out with a notice; with none to open, nothing runs", async () => {
  const s1 = setup();
  const r1 = await s1.p.open([s1.Z.attachment({ file: false })]);
  assert.deepEqual(s1.runs, []);
  assert.equal(r1.opened, 0);
  assert.deepEqual(s1.alerts.map((x) => x.text), [plugin.TEXT.noFile]);
  const s2 = setup();
  await s2.p.open([s2.Z.attachment({}), s2.Z.attachment({ file: false }), s2.Z.attachment({ file: false })]);
  assert.equal(s2.runs.length, 1);
  assert.deepEqual(s2.alerts.map((x) => x.text), ["2 PDFs were left out: the file is not on this Mac."]);
});

test("open: at most MAX_ITEMS at once (and a notice says so); when `open` fails, the notice says the app may be missing", async () => {
  const s1 = setup();
  const many = Array.from({ length: plugin.MAX_ITEMS + 3 }, () => s1.Z.attachment({}));
  const r = await s1.p.open(many);
  assert.equal(r.opened, plugin.MAX_ITEMS);
  assert.equal(s1.runs[0].length, 3 + plugin.MAX_ITEMS);
  assert.deepEqual(s1.alerts.map((x) => x.text), [plugin.TEXT.tooMany]);
  const s2 = setup({ fail: true });
  const r2 = await s2.p.open([s2.Z.attachment({})]);
  assert.equal(r2.opened, 0);
  assert.match(r2.error, /exit status 1/);
  assert.deepEqual(s2.alerts.map((x) => x.text), [plugin.TEXT.noApp]);
});

test("the manifest: a Zotero plugin with the id the packer checks, for Zotero 8 to 10 (MenuManager)", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ZOTERO, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 2);
  assert.equal(m.applications.zotero.id, pack.PLUGIN_ID);
  assert.match(m.applications.zotero.id, /^\{[0-9a-f-]{36}\}$/, "a GUID, not an address");
  assert.equal(m.applications.zotero.strict_min_version, "8.0");
  // Zotero refuses a plugin without these ("could not be installed … incompatible"); the update address never resolves
  for (const k of pack.REQUIRED) assert.equal(typeof m.applications.zotero[k], "string", k);
  assert.match(m.applications.zotero.update_url, /^https:\/\/example\.invalid\//);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  const boot = fs.readFileSync(path.join(ZOTERO, "bootstrap.js"), "utf8");
  for (const hook of ["install", "startup", "onMainWindowLoad", "onMainWindowUnload", "shutdown", "uninstall"]) {
    assert.match(boot, new RegExp("function " + hook + "\\("), hook);
  }
  assert.match(boot, /loadSubScript\(rootURI \+ "marginalia\.js", scope\)/);
});

test("the .xpi is a zip of exactly the plugin's files, stored, the same bytes each time", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zotero-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const list = pack.entries(ZOTERO);
  assert.deepEqual(list.map((e) => e.name), pack.FILES);
  const one = pack.zip(list), two = pack.zip(pack.entries(ZOTERO));
  assert.ok(one.equals(two));
  const file = path.join(dir, "p.xpi");
  fs.writeFileSync(file, one);
  // Python's zipfile reads it back: every name, every byte, every checksum
  const py = spawnSync("python3", ["-I", "-c", "import sys, zipfile, json\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n" +
    "print(json.dumps([[i.filename, i.compress_type, z.read(i).decode('utf-8')] for i in z.infolist()]))", file], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const back = JSON.parse(py.stdout);
  assert.deepEqual(back.map((x) => x[0]), pack.FILES);
  assert.ok(back.every((x) => x[1] === 0), "stored");
  back.forEach((x, i) => assert.equal(x[2], list[i].data.toString("utf8"), x[0]));
  // a stray file in zotero/ stops the packer
  const copy = path.join(dir, "zotero");
  fs.cpSync(ZOTERO, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, "notes.txt"), "x");
  assert.throws(() => pack.entries(copy), /does not name: notes\.txt/);
  fs.rmSync(path.join(copy, "notes.txt"));
  const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
  delete m.applications.zotero.update_url;
  fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m));
  assert.throws(() => pack.entries(copy), /lacks what Zotero requires: applications\.zotero\.update_url/);
});

// ---- step 2 (D34): the tag and the note ----------------------------------------------------------------------------
// A Zotero library with tags and child notes: items by libraryID and key, saveTx() counted, notes made with new Item("note").
function libraryZotero() {
  const items = new Map(), byKey = new Map();
  let next = 1;
  const Z = { isMac: true, saves: 0 };
  function add(it) {
    it.id = next++; it.libraryID = it.libraryID || 1; it.key = it.key || "K" + String(it.id).padStart(7, "0");
    it.deleted = false; it.tags = it.tags || [];
    it.hasTag = (t) => it.tags.includes(t);
    it.addTag = (t) => { if (!it.tags.includes(t)) it.tags.push(t); };
    it.removeTag = (t) => { it.tags = it.tags.filter((x) => x !== t); };
    it.saveTx = async () => { Z.saves++; if (!items.has(it.id)) { items.set(it.id, it); byKey.set(it.libraryID + "/" + it.key, it); } return it.id; };
    items.set(it.id, it);
    byKey.set(it.libraryID + "/" + it.key, it);
    return it;
  }
  Z.Items = { get: (id) => items.get(id) || false, getByLibraryAndKey: (lib, key) => byKey.get(lib + "/" + key) || false };
  Z.Item = function (type) {
    const it = { itemType: type, isPDFAttachment: () => false, isRegularItem: () => false, html: null };
    it.setNote = (h) => { it.html = h; };
    it.id = next++; it.libraryID = 1; it.key = "N" + String(it.id).padStart(7, "0"); it.deleted = false; it.tags = [];
    it.saveTx = async () => { Z.saves++; items.set(it.id, it); byKey.set(it.libraryID + "/" + it.key, it); it.parentItemID = it.parentID; return it.id; };
    return it;
  };
  Z.regular = () => add({ isPDFAttachment: () => false, isRegularItem: () => true, getAttachments: () => [] });
  Z.pdf = (parent, file) => {
    const it = add({ isPDFAttachment: () => true, isRegularItem: () => false, parentItemID: parent ? parent.id : null,
      getFilePathAsync: async () => file });
    if (parent) { const prev = parent.getAttachments(); parent.getAttachments = () => prev.concat([it.id]); parent.getBestAttachment = async () => it; }
    return it;
  };
  Z.notesOf = (parent) => Array.from(items.values()).filter((x) => x.itemType === "note" && x.parentID === parent.id && !x.deleted);
  return Z;
}
function syncSetup(answer) {
  const Z = libraryZotero(), pref = { text: null }, later = [], every = [], fetched = [];
  const env = {
    Zotero: Z, id: "{plugin}", alert: () => {}, exec: async () => true,
    sha256: async (file) => file.replace(/^.*\//, "").replace(/\.pdf$/, "").padEnd(64, "0"),
    fetchBooks: async (url) => { fetched.push(url); const a = typeof answer.value === "function" ? answer.value() : answer.value; if (a instanceof Error) throw a; return a; },
    prefs: { get: () => pref.text, set: (t) => { pref.text = t; } },
    every: (ms, fn) => { every.push({ ms, fn }); return () => { every.length = 0; }; },
    later: (ms, fn) => { later.push({ ms, fn }); return () => {}; }
  };
  return { Z, p: plugin.make(env), pref, later, every, fetched };
}
const SHA_A = "a".padEnd(64, "0"), SHA_B = "b".padEnd(64, "0");

test("step 2: an open remembers each PDF by its SHA-256 with its attachment, and syncs 15 s and 60 s later", async () => {
  const s = syncSetup({ value: null });
  const paper = s.Z.regular(), att = s.Z.pdf(paper, "/storage/X/a.pdf");
  await s.p.open([paper]);
  const state = JSON.parse(s.pref.text);
  assert.deepEqual(state.books, { [SHA_A]: [{ libraryID: 1, key: att.key }] });
  assert.deepEqual(s.later.map((x) => x.ms), plugin.AFTER_OPEN_MS);
  assert.deepEqual(plugin.AFTER_OPEN_MS, [15000, 60000]);
  await s.p.open([att]);                               // the same PDF again: remembered once
  assert.deepEqual(JSON.parse(s.pref.text).books[SHA_A].length, 1);
  assert.equal(plugin.PREF, "extensions.marginalia.zotero");
});

test("step 2: with prompts the item gets the tag and one note; a new count changes the note; none takes both away", async () => {
  const answer = { value: { ok: true, books: { [SHA_A]: 12 }, at: 1 } };
  const s = syncSetup(answer);
  const paper = s.Z.regular();
  s.Z.pdf(paper, "/storage/X/a.pdf");
  await s.p.open([paper]);
  let r = await s.p.sync();
  assert.deepEqual(r, { ok: true, tagged: 1, untagged: 0, notes: 1, forgotten: 0, colored: 0 });
  assert.equal(s.fetched[0], "http://127.0.0.1:8765/api/zotero/books");
  assert.deepEqual(paper.tags, ["Marginalia"]);
  let notes = s.Z.notesOf(paper);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].html, "<p>12 prompts in Marginalia</p>");
  const saves = s.Z.saves;
  r = await s.p.sync();                                // the same list ("at" 1): the plugin stops there
  assert.deepEqual(r, { ok: true, unchanged: true });
  assert.equal(s.Z.saves, saves);
  answer.value = { ok: true, books: { [SHA_A]: 12 }, at: 2 };
  r = await s.p.sync();                                // a newer list with the same counts: applied, nothing saved
  assert.deepEqual(r, { ok: true, tagged: 0, untagged: 0, notes: 0, forgotten: 0, colored: 0 });
  assert.equal(s.Z.saves, saves);
  answer.value = { ok: true, books: { [SHA_A]: 1 }, at: 3 };
  await s.p.sync();
  notes = s.Z.notesOf(paper);
  assert.deepEqual(notes.map((n) => n.html), ["<p>1 prompt in Marginalia</p>"], "the same note, changed");
  answer.value = { ok: true, books: { [SHA_A]: 0 }, at: 4 };
  r = await s.p.sync();
  assert.deepEqual(r, { ok: true, tagged: 0, untagged: 1, notes: 1, forgotten: 0, colored: 0 });
  assert.deepEqual(paper.tags, []);
  assert.deepEqual(s.Z.notesOf(paper), [], "the note went to Zotero's trash");
  // the book is not in the library any more: the same as no prompts; prompts again: a new note
  answer.value = { ok: true, books: {}, at: 5 };
  assert.equal((await s.p.sync()).untagged, 0);
  answer.value = { ok: true, books: { [SHA_A]: 3 }, at: 6 };
  await s.p.sync();
  assert.deepEqual(paper.tags, ["Marginalia"]);
  assert.deepEqual(s.Z.notesOf(paper).map((n) => n.html), ["<p>3 prompts in Marginalia</p>"]);
});

test("step 2: two PDFs of one item add up; a standalone PDF gets the tag but no note; a removed attachment is forgotten", async () => {
  const answer = { value: { ok: true, books: { [SHA_A]: 2, [SHA_B]: 5 }, at: 1 } };
  const s = syncSetup(answer);
  const paper = s.Z.regular(), a = s.Z.pdf(paper, "/storage/X/a.pdf"), b = s.Z.pdf(paper, "/storage/Y/b.pdf");
  const alone = s.Z.pdf(null, "/storage/Z/b.pdf");
  await s.p.open([a, b, alone]);
  await s.p.sync();
  assert.deepEqual(s.Z.notesOf(paper).map((n) => n.html), ["<p>7 prompts in Marginalia</p>"]);
  assert.deepEqual(alone.tags, ["Marginalia"]);
  assert.deepEqual(s.Z.notesOf(alone), []);
  b.deleted = true;
  answer.value = { ok: true, books: { [SHA_A]: 2, [SHA_B]: 5 }, at: 2 };   // the next list the app says
  const r = await s.p.sync();
  assert.equal(r.forgotten, 1);
  assert.deepEqual(s.Z.notesOf(paper).map((n) => n.html), ["<p>2 prompts in Marginalia</p>"]);
  assert.deepEqual(JSON.parse(s.pref.text).books[SHA_B], [{ libraryID: 1, key: alone.key }]);
});

test("step 2: nothing changes while the app does not answer, before any open, or after the plugin was turned off", async () => {
  const answer = { value: { ok: true, books: { [SHA_A]: 4 }, at: 1 } };
  const s = syncSetup(answer);
  assert.deepEqual(await s.p.sync(), { ok: false, why: "no PDF was opened in Marginalia yet" });
  assert.deepEqual(s.fetched, [], "nothing is asked");
  const paper = s.Z.regular();
  s.Z.pdf(paper, "/storage/X/a.pdf");
  await s.p.open([paper]);
  await s.p.sync();
  for (const bad of [new Error("connection refused"), null, { ok: false }, { ok: true, books: null }]) {
    answer.value = bad;
    const r = await s.p.sync();
    assert.deepEqual(r, { ok: false, why: "the Marginalia app did not answer" }, String(bad));
    assert.deepEqual(paper.tags, ["Marginalia"], "the tag stays while the app is closed");
  }
  answer.value = { ok: true, books: {}, at: 2 };
  s.p.start();
  assert.deepEqual(s.every.map((x) => x.ms), [plugin.SYNC_MS]);
  assert.equal(s.later[s.later.length - 1].ms, plugin.FIRST_SYNC_MS);
  s.p.stop();
  assert.deepEqual(await s.p.sync(), { ok: false, why: "the plugin was turned off" });
  assert.deepEqual(paper.tags, ["Marginalia"]);
});

test("step 2: a stored state that is not the plugin's own is read as empty, and an item that cannot be saved is left alone", async () => {
  const answer = { value: { ok: true, books: { [SHA_A]: 4 }, at: 1 } };
  const s = syncSetup(answer);
  for (const junk of ["not json", "[]", JSON.stringify({ books: { short: [{ libraryID: 1, key: "X" }] }, notes: "x" })]) {
    s.pref.text = junk;
    assert.deepEqual(await s.p.sync(), { ok: false, why: "no PDF was opened in Marginalia yet" }, junk);
  }
  s.pref.text = null;
  const paper = s.Z.regular();
  s.Z.pdf(paper, "/storage/X/a.pdf");
  await s.p.open([paper]);
  paper.saveTx = async () => { throw new Error("read-only library"); };
  const r = await s.p.sync();
  assert.equal(r.ok, true, "one item that cannot be changed does not stop the sync");
});

test("bootstrap.js hands the plugin a file hash, the app's answer, a preference and timers, and cancels every timer", () => {
  const boot = fs.readFileSync(path.join(ZOTERO, "bootstrap.js"), "utf8");
  for (const k of ["sha256:", "fetchBooks:", "prefs:", "every:", "later:"]) assert.ok(boot.includes(k), k);
  assert.match(boot, /hash\.init\(Ci\.nsICryptoHash\.SHA256\)/);
  assert.match(boot, /Zotero\.HTTP\.request\("GET", url, \{ headers: \{ "X-Marginalia": "1" \}/);
  assert.match(boot, /plugin\.start\(\);/);
  assert.match(boot, /function shutdown\(\) \{\n  for \(const t of timers\) t\.cancel\(\);/);
  assert.match(boot, /plugin\.stop\(\);/);
  assert.equal(plugin.BOOKS_URL, "http://127.0.0.1:8765/api/zotero/books");
});

test("step 2: the tag gets Marginalia's red once per library, never over the user's colour or past Zotero's 9", async () => {
  const answer = { value: { ok: true, books: { [SHA_A]: 1 }, at: 1 } };
  function withTags(colors) {
    const s = syncSetup(answer);
    s.set = [];
    s.Z.Tags = { MAX_COLORED_TAGS: 9, colors: new Map(colors || []),
      getColor(lib, name) { return this.colors.get(name) || false; },
      getColors() { return this.colors; },
      async setColor(lib, name, color) { s.set.push([lib, name, color]); this.colors.set(name, { color, position: this.colors.size }); } };
    return s;
  }
  async function opened(s) { const paper = s.Z.regular(); s.Z.pdf(paper, "/storage/X/a.pdf"); await s.p.open([paper]); return paper; }
  const s1 = withTags();
  await opened(s1);
  assert.equal((await s1.p.sync()).colored, 1);
  assert.deepEqual(s1.set, [[1, "Marginalia", "#E04A2F"]]);
  assert.equal(plugin.TAG_COLOR, "#E04A2F");
  // the user takes the colour away in Zotero: it stays away (each library is coloured once)
  s1.Z.Tags.colors.delete("Marginalia");
  answer.value = { ok: true, books: { [SHA_A]: 2 }, at: 9 };
  assert.equal((await s1.p.sync()).colored, 0);
  answer.value = { ok: true, books: { [SHA_A]: 1 }, at: 1 };
  assert.deepEqual(JSON.parse(s1.pref.text).colored, [1]);
  // a colour of the user's own stays
  const s2 = withTags([["Marginalia", { color: "#576DD9", position: 0 }]]);
  await opened(s2);
  await s2.p.sync();
  assert.deepEqual(s2.set, []);
  // nine coloured tags already: none more
  const s3 = withTags(Array.from({ length: 9 }, (_, i) => ["t" + i, { color: "#999999", position: i }]));
  await opened(s3);
  await s3.p.sync();
  assert.deepEqual(s3.set, []);
  // no prompts: no colour (the tag is not there)
  const s4 = withTags();
  answer.value = { ok: true, books: { [SHA_A]: 0 }, at: 2 };
  await opened(s4);
  await s4.p.sync();
  assert.deepEqual(s4.set, []);
  // a library where setColor fails (read-only) is not tried again, and the sync goes on
  answer.value = { ok: true, books: { [SHA_A]: 1 }, at: 3 };
  const s5 = withTags();
  s5.Z.Tags.setColor = async () => { throw new Error("read-only"); };
  await opened(s5);
  assert.equal((await s5.p.sync()).ok, true);
  assert.deepEqual(JSON.parse(s5.pref.text).colored, [1]);
});

test("the plugin asks every 30 seconds, and applies a list only when it is newer or a PDF was just opened", async () => {
  assert.equal(plugin.SYNC_MS, 30000);
  const answer = { value: { ok: true, books: { [SHA_A]: 1, [SHA_B]: 2 }, at: 7 } };
  const s = syncSetup(answer);
  const one = s.Z.regular();
  s.Z.pdf(one, "/storage/X/a.pdf");
  await s.p.open([one]);
  assert.equal((await s.p.sync()).tagged, 1);
  assert.deepEqual(await s.p.sync(), { ok: true, unchanged: true });
  // another PDF opened from Zotero: the same list ("at" 7) is applied again, so the new item gets its tag at once
  const two = s.Z.regular();
  s.Z.pdf(two, "/storage/Y/b.pdf");
  await s.p.open([two]);
  const r = await s.p.sync();
  assert.equal(r.tagged, 1);
  assert.deepEqual(two.tags, ["Marginalia"]);
  // a server that does not say "at" (null): every list is applied
  answer.value = { ok: true, books: { [SHA_A]: 1, [SHA_B]: 2 }, at: null };
  assert.equal((await s.p.sync()).ok, true);
  assert.equal((await s.p.sync()).unchanged, undefined);
});
