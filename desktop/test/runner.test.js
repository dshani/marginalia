"use strict";
// scripts/selftest.js, the self-test runner: its pure parts (the packaged run itself is `npm run app`, step 7).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runner = require("../scripts/selftest");

const APP = "/private/tmp/b/out/Marginalia-darwin-arm64/Marginalia.app";
const dumpLine = (p, id) => "path:                       " + p + " (0x" + id + ")";

test("listedUnder finds the app's own record and its helpers' records, and counts every line that names it (OFF-2)", () => {
  const dump = [
    dumpLine("/Applications/Brave Browser.app", "3a80"),
    dumpLine(APP + "/Contents/Frameworks/Marginalia Helper (Renderer).app", "5994"),
    "executable:                 " + APP + "/Contents/Frameworks/Marginalia Helper (Renderer).app/Contents/MacOS/Marginalia Helper (Renderer)",
    dumpLine(APP + "x/Other.app", "1")
  ].join("\n");
  const r = runner.listedUnder(dump, [APP]);
  assert.deepEqual(r.records, [APP + "/Contents/Frameworks/Marginalia Helper (Renderer).app"]);
  assert.equal(r.mentions, 3);                    // the record, its executable line, and a look-alike path (counted: strict)
  assert.deepEqual(runner.listedUnder(dumpLine("/Applications/Brave Browser.app", "1"), [APP]), { records: [], mentions: 0 });
  assert.deepEqual(runner.listedUnder(dumpLine(APP, "abc"), [APP]).records, [APP]);
});

test("bundlesOf names the app and each helper app in Contents/Frameworks", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-")));
  try {
    const app = path.join(dir, "Marginalia.app");
    for (const h of ["Marginalia Helper.app", "Marginalia Helper (Renderer).app", "Electron Framework.framework"]) {
      fs.mkdirSync(path.join(app, "Contents", "Frameworks", h), { recursive: true });
    }
    assert.deepEqual(runner.bundlesOf(app).sort(), [app, path.join(app, "Contents", "Frameworks", "Marginalia Helper (Renderer).app"),
      path.join(app, "Contents", "Frameworks", "Marginalia Helper.app")].sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("detailText prints a check without a detail instead of throwing (OFF-2)", () => {
  assert.equal(runner.detailText(undefined), "null");
  assert.equal(runner.detailText({ a: 1 }), '{"a":1}');
  assert.equal(runner.detailText("x".repeat(500)).length, 400);
  const loop = {}; loop.self = loop;
  assert.equal(typeof runner.detailText(loop), "string");
});

test("a defaults domain is removed when it holds only Chromium's three start-up keys, whoever wrote it (OFF-4)", () => {
  assert.equal(runner.onlyStartupDefaults(["AppleTextDirection", "NSForceRightToLeftWritingDirection", "NSTreatUnknownArgumentsAsOpen"]), true);
  assert.equal(runner.onlyStartupDefaults([]), true);                                           // an empty file
  assert.equal(runner.onlyStartupDefaults(["AppleTextDirection", "NSNavLastRootDirectory"]), false);  // the installed app's own
  assert.equal(runner.onlyStartupDefaults(null), false);                                        // unreadable: left alone
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-")));
  try {
    assert.deepEqual(runner.defaultsKeys(path.join(dir, "none.plist")), { exists: false, keys: null });
    const f = path.join(dir, "x.plist");
    fs.writeFileSync(f, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>AppleTextDirection</key><true/>' +
      "<key>NSTreatUnknownArgumentsAsOpen</key><string>NO</string></dict></plist>\n");
    assert.deepEqual(runner.defaultsKeys(f), { exists: true, keys: ["AppleTextDirection", "NSTreatUnknownArgumentsAsOpen"] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the runner refuses an installed app under any of its names, and a changed HOME (SEC-1)", () => {
  const home = os.userInfo().homedir;
  const projectDir = fs.realpathSync(os.tmpdir());       // a project folder outside Applications (refused on its own: next test)
  const env = { home, envHome: home, projectDir };
  for (const app of ["/Applications/Marginalia.app", "/applications/Marginalia.app", "/System/Volumes/Data/Applications/Marginalia.app",
    path.join(home, "Applications", "Marginalia.app")]) {
    assert.throws(() => runner.refuseToRun(app, env), /never an installed app/, app);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-")));
  try {
    fs.symlinkSync("/Applications", path.join(dir, "Apps"));
    assert.throws(() => runner.refuseToRun(path.join(dir, "Apps", "Marginalia.app"), env), /never an installed app/);
    assert.doesNotThrow(() => runner.refuseToRun(path.join(dir, "out", "Marginalia.app"), env));
    assert.throws(() => runner.refuseToRun(path.join(dir, "out", "Marginalia.app"), { home, envHome: dir, projectDir }), /real HOME/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a project folder inside /Applications or ~/Applications is refused with a clear message (not supported)", () => {
  const home = os.userInfo().homedir;
  for (const dir of [path.join(home, "Applications", "someproject"), "/Applications/someproject", path.join(home, "applications", "x", "y")]) {
    assert.throws(() => runner.refuseProjectInApplications(home, dir), /inside an Applications folder.*not supported.*Move the project folder/, dir);
    assert.throws(() => runner.refuseToRun(path.join(dir, "desktop", "out", "Marginalia.app"), { home, envHome: home, projectDir: dir }),
      /not supported/, dir);
  }
  assert.doesNotThrow(() => runner.refuseProjectInApplications(home, path.join(home, "Projects", "someproject")));
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "build.js"), "utf8");
  assert.ok(src.indexOf("refuseProjectInApplications(") < src.indexOf("copyWeb();"), "the build checks before step 1");
});

test("the second launch carries the one link a self-test takes, and the guard lets exactly that one through (R5)", () => {
  const args = require("../lib/args");
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "selftest.js"), "utf8");
  assert.match(src, /"--backup-dir=" \+ path\.join\(root, "backups-2"\), args\.SELF_TEST_LINK\]/);
  assert.match(src, /handedOver === "1" && !!handoff && handoff\.ok === true/);
  assert.equal(args.SELF_TEST_LINK, "marginalia://open?hash=%23library");
  const base = ["--self-test", "--user-data-dir=/private/tmp/st/u", "--port=49152", "--obsidian-sandbox=/private/tmp/st/s", "--backup-dir=/private/tmp/st/b"];
  const env = { home: "/Users/someone", fs: { realpathSync: (p) => p, statSync: (p) => ({ dev: 1, ino: p.toLowerCase() }) } };
  assert.deepEqual(args.selfTestProblems(args.parse(base.concat([args.SELF_TEST_LINK])), env), []);
  for (const extra of [["marginalia://open?hash=%23reader%2Fx"], [args.SELF_TEST_LINK, args.SELF_TEST_LINK]]) {
    assert.ok(args.selfTestProblems(args.parse(base.concat(extra)), env).some((p) => /marginalia:\/\//.test(p)), extra.join(" "));
  }
});
