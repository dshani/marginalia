"use strict";
// Headless boot smoke: loads the 30 scripts (SPEC §18 + obsidian, BUILD-NOTES "Obsidian", backup, BUILD-NOTES
// "Automatic backup", desktop, BUILD-NOTES "Desktop app (binding)", FEATURES E2.2, and similar, BUILD-NOTES "Prompt craft",
// FEATURES P2.4) in order inside a fake window
// (tools/smoke.js), calls Marginalia.app.boot() and expects it to resolve with every namespace present.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SMOKE = path.join(__dirname, "..", "tools", "smoke.js");
const NAMESPACES = ["util", "bus", "settings", "store", "scheduler", "prompts", "similar", "context", "keys", "layout", "anchors",
  "markup", "exporter", "obsidian", "backup", "cache", "attachments", "pdfview", "reader", "editor", "margin", "list", "snip",
  "vision", "review", "stats", "library", "tabs", "desktop", "app"];

test("all 30 modules load without a DOM and app.boot() resolves", () => {
  const r = spawnSync(process.execPath, [SMOKE], { encoding: "utf8", timeout: 20000 });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 0, "smoke exit code\n" + out);
  assert.match(out, /Loaded 30\/30 namespaces/, out);
  assert.match(out, /boot\(\): resolved/, out);
  assert.match(out, /SMOKE OK/, out);
  // boot started M.backup once the store was open; the smoke window's store runs in memory mode, so it did nothing
  assert.match(out, /Backup after boot: unavailable \(memory\)/, out);
});

test("smoke --keys lists every namespace of SPEC §18, M.obsidian, M.backup and M.desktop", () => {
  const r = spawnSync(process.execPath, [SMOKE, "--keys"], { encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const info = JSON.parse(r.stdout);
  assert.deepEqual(info.missing, []);
  assert.deepEqual(info.loadErrors, []);
  assert.equal(info.namespaces.length, 30);
  assert.deepEqual(info.namespaces, NAMESPACES, "load order");
  for (const ns of NAMESPACES) assert.ok(info.keys[ns], "namespace " + ns);
  for (const fn of ["fileName", "notePath", "blockFor", "uriFor", "openUriFor", "detect", "send", "_setOpener"]) {
    assert.equal(info.keys.obsidian[fn], "function", "M.obsidian." + fn);
  }
  for (const fn of ["start", "state", "runNow", "setEnabled", "refresh", "_setFetch", "_setNow", "_setTimers", "_reset"]) {
    assert.equal(info.keys.backup[fn], "function", "M.backup." + fn);
  }
  // FEATURES E2.2: M.backup's extensions for the desktop app, and M.desktop itself
  for (const fn of ["latest", "idle", "libraryPdfs"]) assert.equal(info.keys.backup[fn], "function", "M.backup." + fn);
  for (const fn of ["isApp", "start", "ready", "mode", "covered", "state", "headers", "refusesWrite", "askPersist", "coverLink",
    "showCover", "backUp", "welcome", "importLatest", "dismissWelcome", "_setFetch", "_setOpener", "_setCheckMs", "_setNow", "_reset"]) {
    assert.equal(info.keys.desktop[fn], "function", "M.desktop." + fn);
  }
  assert.equal(info.keys.desktop.CLIENT_HEADER, "string");
  // FEATURES P2.4: M.similar
  for (const fn of ["words", "score", "alike", "pairs", "nearest", "key", "oneLine"]) assert.equal(info.keys.similar[fn], "function", "M.similar." + fn);
});

test("index.html loads js/backup.js after exporter.js and obsidian.js and before cache.js and app.js, as tools/smoke.js does", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const scripts = Array.from(html.matchAll(/<script src="js\/([a-z]+)\.js"><\/script>/g), (m) => m[1]);
  assert.deepEqual(scripts, NAMESPACES, "the same 30 local scripts, in the same order");
  const at = (n) => scripts.indexOf(n);
  assert.ok(at("exporter") < at("backup") && at("obsidian") < at("backup") && at("backup") < at("app"));
  // FEATURES E2.2: js/desktop.js after the modules it calls at run time and right before js/app.js, whose boot starts it
  assert.ok(at("library") < at("desktop") && at("desktop") === at("app") - 1);
  // FEATURES P2.4: js/similar.js right after js/prompts.js, the one module it depends on
  assert.ok(at("similar") === at("prompts") + 1);
  // D27: js/stats.js (the statistics page) after the modules it reads at run time and before js/library.js, whose button opens it
  assert.ok(at("review") < at("stats") && at("stats") < at("library"));
  // D30: js/tabs.js (the tabs) after js/library.js, whose buttons it opens tabs for, and before js/desktop.js and js/app.js
  assert.ok(at("library") < at("tabs") && at("tabs") < at("desktop") && at("tabs") < at("app"));
});
