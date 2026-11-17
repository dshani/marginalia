"use strict";
// test/settings.test.js — M.settings validation of the Obsidian keys (BUILD-NOTES "Obsidian") and of autoBackup
// (BUILD-NOTES "Automatic backup"). The vault name is kept exactly as Obsidian lists it (its folder's name: doubled,
// leading, trailing and no-break spaces stay), a control character makes it invalid, only blanks is "" (no vault named);
// the folder keeps its one-line rules; autoBackup is true by default and takes only true or false. Runs with no DOM
// and, unless a test installs one, no localStorage (memory only). Run from the app folder: node --test
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "js", "settings.js");
let settings = require(FILE);
const warn = console.warn;
beforeEach(() => { console.warn = () => {}; settings.reset(); });
afterEach(() => { console.warn = warn; });

test("obsidianVault keeps a vault's name exactly as listed: doubled, leading, trailing and no-break spaces stay", () => {
  for (const name of ["Obsidian Vault", "My  Vault", " Lead Vault", "Trail Vault ", "NB Vault", "Ideo　Vault", "Ünïcødé 𝑥"]) {
    assert.equal(settings.set("obsidianVault", name), true, JSON.stringify(name));
    assert.equal(settings.get("obsidianVault"), name);
  }
});

test("obsidianVault: a control character makes the value invalid, only blanks is \"\", at most 200 characters", () => {
  settings.set("obsidianVault", "Kept");
  for (const bad of ["Tab\tVault", "New\nline", "CR\r", "Bell\u0007", "Del\u007f", "C1\u0085", "C1\u009f", 42, null, {}]) {
    assert.equal(settings.set("obsidianVault", bad), false, JSON.stringify(bad));
    assert.equal(settings.get("obsidianVault"), "Kept", "an invalid value leaves the stored one");
  }
  assert.equal(settings.set("obsidianVault", "    "), true);
  assert.equal(settings.get("obsidianVault"), "", "only blanks: no vault named");
  assert.equal(settings.set("obsidianVault", "x".repeat(200)), true);
  assert.equal(settings.set("obsidianVault", "x".repeat(201)), false);
});

test("obsidianFolder keeps its one-line rules (whitespace collapsed, no leading, trailing or doubled /)", () => {
  assert.equal(settings.set("obsidianFolder", " Study//Physics/ "), true);
  assert.equal(settings.get("obsidianFolder"), "Study/Physics");
  assert.equal(settings.set("obsidianFolder", "Tab\there"), true);
  assert.equal(settings.get("obsidianFolder"), "Tab here");
});

test("a stored vault name loads as it was stored (and an invalid stored one falls back to the default)", () => {
  const store = { "marginalia.settings": JSON.stringify({ obsidianVault: "My  Vault ", obsidianFolder: "Notes" }) };
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: ls });
  try {
    delete require.cache[require.resolve(FILE)];
    let fresh = require(FILE);
    assert.equal(fresh.get("obsidianVault"), "My  Vault ");
    assert.equal(fresh.set("obsidianVault", " Other  Vault"), true);
    assert.equal(JSON.parse(store["marginalia.settings"]).obsidianVault, " Other  Vault", "persisted verbatim");
    store["marginalia.settings"] = JSON.stringify({ obsidianVault: "Bad\u0001Vault" });
    delete require.cache[require.resolve(FILE)];
    fresh = require(FILE);
    assert.equal(fresh.get("obsidianVault"), "", "a stored value with a control character is not used");
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage;
    delete require.cache[require.resolve(FILE)];
    settings = require(FILE);
  }
});

test("a tab that stepped aside for a newer Marginalia tab (M.store.locked()) stores nothing: set() → false, reset() does nothing", () => {
  const store = { "marginalia.settings": JSON.stringify({ theme: "dark", obsidianFolder: "Study" }) };
  const writes = [];
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { writes.push(k); store[k] = String(v); }, removeItem: (k) => { writes.push("-" + k); delete store[k]; } };
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: ls });
  const M = globalThis.Marginalia, hadStore = M.store;
  try {
    delete require.cache[require.resolve(FILE)];
    const fresh = require(FILE);
    M.store = { locked: () => ({ reason: "othertab", by: "tab_b", at: 1 }) };
    assert.equal(fresh.set("theme", "light"), false, "this tab's whole settings object may be older than the newer tab's");
    assert.equal(fresh.set("obsidianFolder", "Notes/Marginalia"), false);
    fresh.reset();
    assert.deepEqual(writes, [], "nothing written over the newer tab's settings");
    assert.equal(fresh.get("theme"), "dark");
    M.store = { locked: () => null };
    assert.equal(fresh.set("theme", "light"), true, "a tab that may write still stores");
    assert.equal(JSON.parse(store["marginalia.settings"]).theme, "light");
  } finally {
    if (hadStore === undefined) delete M.store; else M.store = hadStore;
    if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage;
    delete require.cache[require.resolve(FILE)];
    settings = require(FILE);
  }
});

// ---- settings.autoBackup (BUILD-NOTES "Automatic backup"; js/backup.js reads it) ----------------------------------------

test("autoBackup defaults to true and takes only true or false", () => {
  assert.equal(settings.DEFAULTS.autoBackup, true);
  assert.equal(settings.get("autoBackup"), true);
  assert.equal(settings.all().autoBackup, true);
  assert.equal(settings.set("autoBackup", false), true);
  assert.equal(settings.get("autoBackup"), false);
  for (const bad of ["false", "no", 0, 1, null, undefined, {}, []]) {
    assert.equal(settings.set("autoBackup", bad), false, JSON.stringify(bad) + " is refused");
    assert.equal(settings.get("autoBackup"), false, "an invalid value leaves the stored one");
  }
  assert.equal(settings.set("autoBackup", true), true);
  assert.equal(settings.get("autoBackup"), true);
  settings.set("autoBackup", false);
  settings.reset();
  assert.equal(settings.get("autoBackup"), true, "reset() turns it back on");
});

test("autoBackup: settings:changed tells M.backup, a stored false stays off, a stored non-boolean loads as the default", () => {
  const bus = require(path.join(__dirname, "..", "js", "bus.js"));
  const seen = [];
  const off = bus.on("settings:changed", (e) => { if (e.key === "autoBackup") seen.push(e.value); });
  try {
    settings.set("autoBackup", false);
    settings.set("autoBackup", true);
    assert.deepEqual(seen, [false, true]);
  } finally { off(); }

  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: ls });
  try {
    for (const [stored, want] of [[false, false], [true, true], ["false", true], [0, true], [null, true]]) {
      store["marginalia.settings"] = JSON.stringify({ autoBackup: stored });
      delete require.cache[require.resolve(FILE)];
      assert.equal(require(FILE).get("autoBackup"), want, "stored " + JSON.stringify(stored));
    }
    delete require.cache[require.resolve(FILE)];
    const fresh = require(FILE);
    fresh.set("autoBackup", false);
    assert.equal(JSON.parse(store["marginalia.settings"]).autoBackup, false, "persisted");
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage;
    delete require.cache[require.resolve(FILE)];
    settings = require(FILE);
  }
});

test("autoBackup is not stored by a tab that stepped aside (M.store.locked())", () => {
  const M = globalThis.Marginalia, hadStore = M.store;
  try {
    M.store = { locked: () => ({ reason: "othertab", by: "tab_b", at: 1 }) };
    assert.equal(settings.set("autoBackup", false), false);
    assert.equal(settings.get("autoBackup"), true);
  } finally {
    if (hadStore === undefined) delete M.store; else M.store = hadStore;
  }
});

// ---- settings.obsidian (DECISIONS D32: the switch "Connect Marginalia to Obsidian"; js/obsidian.js enabled() reads it) ----

test("obsidian (the Obsidian connection) is null until it is chosen, and takes only true, false or null", () => {
  assert.equal(settings.DEFAULTS.obsidian, null);
  assert.equal(settings.get("obsidian"), null, "never chosen");
  assert.ok(Object.prototype.hasOwnProperty.call(settings.all(), "obsidian"));
  assert.equal(settings.all().obsidian, null);
  for (const v of [true, false, null, true]) {
    assert.equal(settings.set("obsidian", v), true, String(v));
    assert.equal(settings.get("obsidian"), v);
  }
  for (const bad of ["true", "on", 1, 0, "", undefined, {}, []]) {
    assert.equal(settings.set("obsidian", bad), false, JSON.stringify(bad) + " is refused");
    assert.equal(settings.get("obsidian"), true, "an invalid value leaves the stored one");
  }
  settings.reset();
  assert.equal(settings.get("obsidian"), null, "reset(): never chosen again");
});

test("obsidian: settings:changed says each choice; a stored choice stays; a stored other value loads as never chosen", () => {
  const bus = require(path.join(__dirname, "..", "js", "bus.js"));
  const seen = [];
  const off = bus.on("settings:changed", (e) => { if (e.key === "obsidian") seen.push(e.value); });
  try {
    settings.set("obsidian", true);
    settings.set("obsidian", false);
    settings.set("obsidian", null);
    assert.deepEqual(seen, [true, false, null]);
  } finally { off(); }

  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: ls });
  try {
    for (const [stored, want] of [[true, true], [false, false], [null, null], ["true", null], [1, null], [0, null], [{}, null]]) {
      store["marginalia.settings"] = JSON.stringify({ obsidian: stored });
      delete require.cache[require.resolve(FILE)];
      assert.equal(require(FILE).get("obsidian"), want, "stored " + JSON.stringify(stored));
    }
    store["marginalia.settings"] = JSON.stringify({ obsidianFolder: "Reading" });   // settings stored before the switch existed
    delete require.cache[require.resolve(FILE)];
    assert.equal(require(FILE).get("obsidian"), null, "no stored choice: never chosen");
    delete require.cache[require.resolve(FILE)];
    const fresh = require(FILE);
    fresh.set("obsidian", true);
    assert.equal(JSON.parse(store["marginalia.settings"]).obsidian, true, "persisted");
    fresh.set("obsidian", false);
    assert.equal(JSON.parse(store["marginalia.settings"]).obsidian, false, "an off choice is stored as false, not left out");
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage;
    delete require.cache[require.resolve(FILE)];
    settings = require(FILE);
  }
});
