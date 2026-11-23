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
