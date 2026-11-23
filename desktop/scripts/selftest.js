#!/usr/bin/env node
"use strict";
// Runs a packaged Marginalia.app's self-test with throwaway folders, then cleans up after it:
//
//   node scripts/selftest.js [path/to/Marginalia.app] [--keep] [--json <file>]
//
//   - refuses an installed app (one in /Applications or ~/Applications, under any of its names: symlinks, other letter
//     case, /System/Volumes/Data), a project folder that lies there itself (not supported) and a changed $HOME (the app's own guard would refuse it too);
//   - makes a temp folder (in $TMPDIR) holding user-data/, obsidian-sandbox/ and backups/, and picks a free port
//     (never 8765, 8791 or 8792);
//   - starts <app>/Contents/MacOS/Marginalia --self-test --user-data-dir=… --port=… --obsidian-sandbox=… --backup-dir=…
//     and reads the one JSON line it prints (it exits 0 when every check passed);
//   - while it runs, starts a second app on the same --user-data-dir (as soon as the first holds Electron's
//     single-instance lock) with the one link a self-test takes, marginalia://open?hash=%23library: that one must step
//     aside with exit code 2, and the first must log that it got 1 link and show where it led (its link-handoff check);
//   - unregisters that app copy and its helper apps from LaunchServices (lsregister -u; macOS registers a helper as a
//     record of its own when it writes a crash report for it), so marginalia:// never points at a build folder, and
//     checks `lsregister -dump` no longer names the copy at all;
//   - checks that nothing listens on the port any more (the app stopped its server), that no "Marginalia Safe Storage"
//     keychain item exists (by exit code only; the app runs with the mock keychain) and that the app's real data
//     folder ~/Library/Application Support/Marginalia was not created by the run;
//   - cleans the user defaults: Chromium writes three keys (AppleTextDirection, NSForceRightToLeftWritingDirection,
//     NSTreatUnknownArgumentsAsOpen) to ~/Library/Preferences/<bundle id>.plist at every start, through cfprefsd, which
//     no folder flag redirects. When that domain holds nothing but those three keys after the run, it is deleted
//     (`defaults delete`, then the empty file), whoever wrote it: so runs that overlap (each sees the other's file)
//     still leave nothing behind. A domain with any other setting (the installed app's own) is left alone;
//   - removes the temp folder (unless --keep), also when something failed on the way.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const args = require("../lib/args");

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const RESERVED_PORTS = new Set([8765, 8791, 8792]);
const PROJECT_DIR = path.resolve(__dirname, "..", "..");   // the folder that holds marginalia/ and desktop/
const BUNDLE_ID = "local.marginalia.desktop";       // scripts/build.js BUNDLE_ID
const TIMEOUT_MS = 180000;
const STARTUP_DEFAULTS = Object.freeze(["AppleTextDirection", "NSForceRightToLeftWritingDirection", "NSTreatUnknownArgumentsAsOpen"]);

function freePort() {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const port = srv.address().port;
        srv.close(() => (RESERVED_PORTS.has(port) && n < 10 ? tryOnce(n + 1) : resolve(port)));
      });
    };
    tryOnce(0);
  });
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

function keychainItemExists(service) {
  // exit code only: 0 = found, 44 = not found; nothing is printed and no secret is read
  const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service], { stdio: "ignore" });
  return r.status === 0;
}

// ---- LaunchServices ---------------------------------------------------------------------------------------------
function appNames(appPath) {
  let real = appPath;
  try { real = fs.realpathSync(appPath); } catch (e) { real = appPath; }
  return Array.from(new Set([appPath, real]));
}

// listedUnder(dump, names) → the records (`path:` lines of `lsregister -dump`) of the app itself or of a bundle
// inside it, and the number of dump lines that name it at all.
function listedUnder(dump, names) {
  const records = new Set();
  let mentions = 0;
  for (const line of String(dump || "").split("\n")) {
    if (!names.some((n) => line.indexOf(n) >= 0)) continue;
    mentions++;
    const m = /^path:\s+(.+?)(?:\s+\(0x[0-9a-f]+\))?\s*$/i.exec(line);
    if (m && names.some((n) => m[1] === n || m[1].startsWith(n + "/"))) records.add(m[1]);
  }
  return { records: Array.from(records), mentions };
}

function lsregisterDump() {
  const r = spawnSync(LSREGISTER, ["-dump"], { encoding: "utf8", maxBuffer: 1 << 30 });
  return String(r.stdout || "");
}

function lsregisterListed(appPath) {
  return listedUnder(lsregisterDump(), appNames(appPath));
}

// The app and every helper app inside it (Contents/Frameworks/*.app), under each of its names.
function bundlesOf(appPath) {
  const out = [];
  for (const n of appNames(appPath)) {
    out.push(n);
    let entries = [];
    try { entries = fs.readdirSync(path.join(n, "Contents", "Frameworks")); } catch (e) { entries = []; }
    for (const e of entries) if (e.endsWith(".app")) out.push(path.join(n, "Contents", "Frameworks", e));
  }
  return out;
}

function unregister(paths) {
  for (const p of paths) spawnSync(LSREGISTER, ["-u", p], { stdio: "ignore" });   // an unregistered bundle: exit 1, ignored
}

// Unregisters the app and its helpers, then any other record the dump still shows under it; returns the last listing.
function unregisterAll(appPath) {
  unregister(bundlesOf(appPath));
  let listed = lsregisterListed(appPath);
  if (listed.records.length) { unregister(listed.records); listed = lsregisterListed(appPath); }
  return listed;
}

// ---- user defaults --------------------------------------------------------------------------------------------------
// {exists, keys}: keys null when the file cannot be read as JSON (a date or data value: more than Chromium writes).
function defaultsKeys(file) {
  if (!fs.existsSync(file)) return { exists: false, keys: null };
  const r = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
  try { return { exists: true, keys: r.status === 0 ? Object.keys(JSON.parse(r.stdout)) : null }; }
  catch (e) { return { exists: true, keys: null }; }
}

function onlyStartupDefaults(keys) {
  return Array.isArray(keys) && keys.every((k) => STARTUP_DEFAULTS.indexOf(k) >= 0);
}

// Deletes the bundle's defaults domain, then the file once it is empty.
function removeDefaults(file) {
  if (!fs.existsSync(file)) return;
  spawnSync("/usr/bin/defaults", ["delete", BUNDLE_ID], { stdio: "ignore" });
  const now = defaultsKeys(file);
  if (now.exists && Array.isArray(now.keys) && now.keys.length === 0) fs.rmSync(file, { force: true });
}

// ---- running ----------------------------------------------------------------------------------------------------------
function launch(bin, argv, env, timeoutMs) {
  const child = spawn(bin, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  const done = new Promise((resolve) => {
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, signal: null, out, err: err + String(e) }); });
  });
  return { child, done };
}

// Starts a second app on the first one's --user-data-dir as soon as the first holds Electron's single-instance lock
// (Chromium's SingletonLock link in that folder names its pid), with the self-test's one link, and reports how it ended.
async function secondLaunch(bin, first, userData, root, env) {
  const lockLink = path.join(userData, "SingletonLock");
  let held = false, ended = false;
  first.done.then(() => { ended = true; });
  for (let i = 0; i < 400 && !held && !ended; i++) {
    await new Promise((r) => setTimeout(r, 25));
    try { held = fs.readlinkSync(lockLink).endsWith("-" + first.child.pid); } catch (e) { held = false; }
  }
  if (!held) return { code: null, out: "", whileFirstRan: false, error: "the first app never held the lock" };
  const port = await freePort();
  const argv = ["--self-test", "--user-data-dir=" + userData, "--port=" + port, "--obsidian-sandbox=" + path.join(root, "obsidian-sandbox-2"),
    "--backup-dir=" + path.join(root, "backups-2"), args.SELF_TEST_LINK];
  const r = await launch(bin, argv, env, 60000).done;
  return { code: r.code, out: r.out.trim(), whileFirstRan: !ended };
}

function detailText(detail) {
  try { return String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 400); } catch (e) { return String(detail).slice(0, 400); }
}

// Throws when the project folder (`dir`, default the one holding desktop/) lies in /Applications or ~/Applications:
// not supported, since its build copy in desktop/out would be there too, and the self-test never runs an app from
// there (it cannot tell it from an installed one). The build calls this before step 1.
function refuseProjectInApplications(home, dir) {
  const project = dir || PROJECT_DIR;
  const roots = ["/Applications", path.join(home, "Applications")];
  if (!args.insideAny(project, roots, fs)) return;
  throw new Error("this project folder is inside an Applications folder (" + project + "), and that is not supported: " +
    "the self-test never runs an app from /Applications or ~/Applications, so it cannot test the build there. " +
    "Move the project folder somewhere else, such as ~/Projects/marginalia, and run marginalia app again.");
}

// Throws when this is no build copy to test: an installed app, or a run with a changed $HOME.
function refuseToRun(app, env) {
  const home = env.home;
  if (!args.homeIsAccountHome(env.envHome, home, fs)) {
    throw new Error("the self-test runs only with the real HOME (HOME is " + JSON.stringify(env.envHome) + ", this account's home folder is " + home + ")");
  }
  refuseProjectInApplications(home, env.projectDir);
  if (args.insideAny(app, ["/Applications", path.join(home, "Applications")], fs)) {
    throw new Error("the self-test runs a build copy, never an installed app: " + app);
  }
}

async function runSelfTest(appPath, options) {
  const o = options || {};
  const say = o.log || ((t) => process.stdout.write("[self-test] " + t + "\n"));
  const app = path.resolve(appPath);
  const bin = path.join(app, "Contents", "MacOS", "Marginalia");
  if (!fs.existsSync(bin)) throw new Error("no app at " + app);
  const home = os.userInfo().homedir;                  // the user database, never $HOME
  refuseToRun(app, { home, envHome: process.env.HOME });
  const realData = path.join(home, "Library", "Application Support", "Marginalia");
  const realDataBefore = fs.existsSync(realData);
  const realPrefs = path.join(home, "Library", "Preferences", BUNDLE_ID + ".plist");
  const prefsBefore = defaultsKeys(realPrefs);
  const keychainBefore = keychainItemExists("Marginalia Safe Storage");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-selftest-")));
  let launched = false, cleaned = false;
  try {
    const dirs = { userData: path.join(root, "user-data"), sandbox: path.join(root, "obsidian-sandbox"), backups: path.join(root, "backups") };
    fs.mkdirSync(dirs.userData, { recursive: true });
    const port = await freePort();
    const argv = ["--self-test", "--user-data-dir=" + dirs.userData, "--port=" + port, "--obsidian-sandbox=" + dirs.sandbox, "--backup-dir=" + dirs.backups];
    const env = Object.assign({}, process.env);
    delete env.MARGINALIA_OBSIDIAN_CONFIG;
    delete env.MARGINALIA_BACKUP_DIR;
    delete env.ELECTRON_RUN_AS_NODE;
    say("starting " + path.relative(process.cwd(), bin) + " on port " + port + " with folders in " + root);
    const t0 = Date.now();
    launched = true;
    const first = launch(bin, argv, env, TIMEOUT_MS);
    // While it runs, a second launch on the same --user-data-dir must step aside (exit 2) and hand its link over.
    const second = secondLaunch(bin, first, dirs.userData, root, env);
    const res = await first.done;
    const single = await second;
    const line = res.out.split("\n").filter((l) => l.trim().startsWith("{")).pop();
    let report = null;
    try { report = line ? JSON.parse(line) : null; } catch (e) { report = null; }
    let handedOver = null;
    try { handedOver = (/a second launch handed over (\d+) link\(s\)/.exec(fs.readFileSync(path.join(dirs.userData, "logs", "server.log"), "utf8")) || [])[1] || null; }
    catch (e) { handedOver = null; }
    const handoff = report && report.checks ? report.checks["link-handoff"] || null : null;
    // after the run: LaunchServices, server, keychain, real data folder, user defaults
    const listed = unregisterAll(app);
    cleaned = true;
    const portOpen = await portAnswers(port);
    const keychainAfter = keychainItemExists("Marginalia Safe Storage");
    const realDataAfter = fs.existsSync(realData);
    const prefsAtEnd = defaultsKeys(realPrefs);
    const removed = prefsAtEnd.exists && onlyStartupDefaults(prefsAtEnd.keys);
    if (removed) removeDefaults(realPrefs);
    const prefsAfter = defaultsKeys(realPrefs);
    const after = {
      "lsregister-unregistered": { ok: listed.mentions === 0, detail: listed },
      "server-stopped": { ok: !portOpen, detail: { port } },
      "no-keychain-item": { ok: keychainBefore || !keychainAfter, detail: { before: keychainBefore, after: keychainAfter } },
      "real-data-untouched": { ok: realDataBefore || !realDataAfter, detail: { existedBefore: realDataBefore, existsAfter: realDataAfter } },
      "real-preferences-clean": { ok: !prefsAfter.exists || !onlyStartupDefaults(prefsAfter.keys),
        detail: { existedBefore: prefsBefore.exists, removed, existsAfter: prefsAfter.exists, keysAfter: prefsAfter.keys } },
      "exit-code": { ok: report ? (report.ok ? res.code === 0 : res.code === 1) : false, detail: { code: res.code, signal: res.signal } },
      "single-instance": { ok: single.code === 2 && /another Marginalia already runs/.test(single.out) && single.whileFirstRan &&
          handedOver === "1" && !!handoff && handoff.ok === true,
        detail: { code: single.code, refused: single.out.slice(0, 200), whileFirstRan: single.whileFirstRan, linksHandedOver: handedOver,
          linkHandoff: handoff ? handoff.detail : null, error: single.error || null } }
    };
    const ok = !!report && report.ok === true && Object.values(after).every((c) => c.ok);
    const summary = { ok, seconds: Math.round((Date.now() - t0) / 100) / 10, app: report, afterRun: after };
    if (!report) summary.stderrTail = res.err.split("\n").slice(-20).join("\n");
    for (const [name, c] of Object.entries(Object.assign({}, report ? report.checks : {}, after))) {
      say((c.ok ? "ok   " : "FAIL ") + name + (c.ok ? "" : "  " + detailText(c.detail)));
    }
    if (report && report.error) say("error: " + report.error);
    if (!report) say("no self-test report; the app's stderr ends with:\n" + summary.stderrTail);
    if (o.keep) say("kept " + root);
    say(ok ? "self-test passed" : "self-test FAILED");
    if (o.jsonOut) fs.writeFileSync(o.jsonOut, JSON.stringify(summary, null, 2) + "\n");
    return summary;
  } finally {
    if (launched && !cleaned) { try { unregisterAll(app); } catch (e) { /* reported by the caller's error */ } }
    if (!o.keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const jsonIdx = argv.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
  const appArg = argv.find((a, i) => !a.startsWith("--") && (jsonIdx < 0 || i !== jsonIdx + 1)) ||
    path.join(__dirname, "..", "out", "Marginalia-darwin-arm64", "Marginalia.app");
  runSelfTest(appArg, { keep, jsonOut }).then((r) => { process.exitCode = r.ok ? 0 : 1; },
    (e) => { process.stderr.write("[self-test] error: " + (e && e.message) + "\n"); process.exitCode = 1; });
}

module.exports = { runSelfTest, freePort, listedUnder, lsregisterListed, bundlesOf, unregisterAll, keychainItemExists, refuseToRun, refuseProjectInApplications,
  defaultsKeys, onlyStartupDefaults, detailText, LSREGISTER, STARTUP_DEFAULTS, BUNDLE_ID };
