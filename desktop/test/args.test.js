"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const args = require("../lib/args");

const HOME = "/Users/someone";
// A stand-in disk: every path exists except under /missing and the paths named in `absent`; `links` are symlinks
// (prefix → target). Like an APFS disk it ignores letter case, and /System/Volumes/Data/<Users|private|Applications>
// is the same folder as /<Users|private|Applications> (macOS firmlinks); realpathSync, like Node's, leaves both as written.
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
const fakeFs = (links, absent) => {
  const follow = (p) => {
    for (const [from, to] of Object.entries(links || {})) {
      if (p === from || p.startsWith(from + "/")) return to + p.slice(from.length);
    }
    return p;
  };
  const exists = (p) => !p.startsWith("/missing") && !(absent || []).some((a) => p.toLowerCase() === a.toLowerCase() || p.toLowerCase().startsWith(a.toLowerCase() + "/"));
  const canon = (p) => p.replace(/^\/system\/volumes\/data(?=\/(users|private|applications)(\/|$))/i, "").toLowerCase();
  return {
    realpathSync(p) { const r = follow(p); if (!exists(r)) throw enoent(); return r; },
    statSync(p) { const r = follow(p); if (!exists(r)) throw enoent(); return { dev: 1, ino: canon(r) }; },
    lstatSync(p) {
      if (Object.prototype.hasOwnProperty.call(links || {}, p)) return { dev: 1, ino: "link:" + p };
      return this.statSync(p);
    }
  };
};
const env = (links, absent) => ({ home: HOME, fs: fakeFs(links, absent) });
const selfTestArgv = (over) => Object.assign({
  "--user-data-dir": "/private/tmp/st/user-data", "--port": "49152",
  "--obsidian-sandbox": "/private/tmp/st/sandbox", "--backup-dir": "/private/tmp/st/backups"
}, over || {});
const toArgv = (o) => ["--self-test"].concat(Object.entries(o).filter(([, v]) => v !== null).map(([k, v]) => k + "=" + v));

test("defaults: port 8765, no folders, no self-test", () => {
  const o = args.parse([]);
  assert.equal(o.port, 8765);
  assert.equal(o.portGiven, false);
  assert.equal(o.selfTest, false);
  assert.equal(o.userDataDir, null);
  assert.deepEqual(o.errors, []);
});

test("value flags take the --flag=value form and absolute folders", () => {
  const o = args.parse(["--port=9000", "--user-data-dir=/tmp/a/../b", "--backup-dir=/tmp/c", "--obsidian-config=/tmp/o.json"]);
  assert.equal(o.port, 9000);
  assert.equal(o.userDataDir, "/tmp/b");
  assert.equal(o.backupDir, "/tmp/c");
  assert.equal(o.obsidianConfig, "/tmp/o.json");
  assert.deepEqual(o.errors, []);
});

test("bad values are errors", () => {
  for (const bad of ["--port=0", "--port=65536", "--port=12ab", "--port=", "--user-data-dir=relative/x", "--backup-dir=", "--backup-dir=  ",
    "--port", "--user-data-dir"]) {
    assert.ok(args.parse([bad]).errors.length > 0, bad);
  }
  assert.ok(args.parse(["--port=1", "--port=2"]).errors.some((e) => /twice/.test(e)));
  assert.ok(args.parse(["--obsidian-sandbox=/tmp/s", "--obsidian-config=/tmp/o.json"]).errors.some((e) => /together/.test(e)));
});

test("marginalia:// arguments are links; anything else is ignored (macOS and Chromium add their own)", () => {
  const o = args.parse(["-psn_0_12345", "--enable-logging", "marginalia://open?hash=library", "MARGINALIA://x"]);
  assert.deepEqual(o.urls, ["marginalia://open?hash=library", "MARGINALIA://x"]);
  assert.deepEqual(o.ignored, ["-psn_0_12345", "--enable-logging"]);
  assert.deepEqual(o.errors, []);
});

test("self-test runs with all four flags pointing at throwaway places", () => {
  const o = args.parse(toArgv(selfTestArgv()));
  assert.equal(o.selfTest, true);
  assert.deepEqual(args.selfTestProblems(o, env()), []);
});

test("self-test refuses missing flags, --obsidian-config, the user's port and extra arguments", () => {
  for (const missing of ["--user-data-dir", "--port", "--obsidian-sandbox", "--backup-dir"]) {
    const o = args.parse(toArgv(selfTestArgv({ [missing]: null })));
    assert.ok(args.selfTestProblems(o, env()).some((p) => p.includes(missing)), missing);
  }
  assert.ok(args.selfTestProblems(args.parse(toArgv(selfTestArgv({ "--port": "8765" }))), env()).some((p) => /8765/.test(p)));
  assert.ok(args.selfTestProblems(args.parse(toArgv(selfTestArgv({ "--port": "80" }))), env()).length > 0);
  const withConfig = args.parse(toArgv(selfTestArgv({ "--obsidian-sandbox": null, "--obsidian-config": "/private/tmp/o.json" })));
  assert.ok(args.selfTestProblems(withConfig, env()).some((p) => /obsidian-config/.test(p)));
  assert.ok(args.selfTestProblems(args.parse(toArgv(selfTestArgv()).concat(["--whatever"])), env()).length > 0);
  assert.ok(args.selfTestProblems(args.parse(toArgv(selfTestArgv()).concat(["marginalia://open"])), env()).length > 0);
});

test("self-test refuses ~/Documents (the real vault and backups), the app's data folder, Obsidian's folder and their parents", () => {
  const refused = [
    HOME + "/Documents", HOME + "/Documents/Obsidian Vault", HOME + "/Documents/Marginalia Backups/x",
    HOME + "/Library/Application Support/Marginalia", HOME + "/Library/Application Support/Marginalia/sub",
    HOME + "/Library/Application Support/obsidian", HOME + "/Library/Application Support", HOME + "/Library", HOME, "/",
    HOME + "/documents/x", HOME + "/Library/application support/marginalia"
  ];
  for (const dir of refused) {
    for (const flag of ["--user-data-dir", "--obsidian-sandbox", "--backup-dir"]) {
      const o = args.parse(toArgv(selfTestArgv({ [flag]: dir })));
      assert.ok(args.selfTestProblems(o, env()).some((p) => p.startsWith(flag)), flag + " " + dir);
    }
  }
  for (const ok of [HOME + "/Desktop/st", HOME + "/Library/Caches/st", "/private/tmp/x", HOME + "/Documentsx"]) {
    const o = args.parse(toArgv(selfTestArgv({ "--user-data-dir": ok })));
    assert.deepEqual(args.selfTestProblems(o, env()), [], ok);
  }
});

test("self-test follows symlinks before deciding, also for folders that do not exist yet", () => {
  const links = { "/private/tmp/link": HOME + "/Documents/Obsidian Vault" };
  const o = args.parse(toArgv(selfTestArgv({ "--backup-dir": "/private/tmp/link/not-yet" })));
  assert.ok(args.selfTestProblems(o, env(links)).some((p) => p.startsWith("--backup-dir")));
  assert.equal(args.realish("/missing/a/b", fakeFs()), "/missing/a/b");
});

test("realish resolves real symlinks on this disk", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "args-test-")));
  try {
    fs.mkdirSync(path.join(dir, "real"));
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
    assert.equal(args.realish(path.join(dir, "link", "x", "y"), fs), path.join(dir, "real", "x", "y"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- SEC-1: the guard compares folders by what the disk says, not by how a path is written -------------------------

test("self-test refuses the /System/Volumes/Data names of the protected folders (macOS firmlinks) and what holds them", () => {
  const refused = [
    "/System/Volumes/Data" + HOME + "/Documents/Marginalia Backups", "/system/volumes/data" + HOME.toLowerCase() + "/documents/obsidian vault/x",
    "/System/Volumes/Data" + HOME + "/Library/Application Support/Marginalia", "/System/Volumes/Data" + HOME + "/Library/Application Support/obsidian",
    "/System/Volumes/Data" + HOME, "/System/Volumes/Data/Users", "/System/Volumes/Data", "/System/Volumes", "/System"
  ];
  for (const dir of refused) {
    for (const flag of ["--user-data-dir", "--obsidian-sandbox", "--backup-dir"]) {
      const o = args.parse(toArgv(selfTestArgv({ [flag]: dir })));
      assert.ok(args.selfTestProblems(o, env()).some((p) => p.startsWith(flag)), flag + " " + dir);
    }
  }
  const ok = args.parse(toArgv(selfTestArgv({ "--backup-dir": "/System/Volumes/Data/private/tmp/st/backups" })));
  assert.deepEqual(args.selfTestProblems(ok, env()), []);
});

test("self-test refuses a protected folder that does not exist yet, under any of its names", () => {
  const absent = [HOME + "/Library/Application Support/Marginalia"];
  for (const dir of [HOME + "/Library/Application Support/Marginalia", HOME + "/Library/Application Support/MARGINALIA/x",
    "/System/Volumes/Data" + HOME + "/Library/Application Support/Marginalia/sub"]) {
    const o = args.parse(toArgv(selfTestArgv({ "--user-data-dir": dir })));
    assert.ok(args.selfTestProblems(o, env(null, absent)).some((p) => p.startsWith("--user-data-dir")), dir);
  }
});

test("self-test refuses a path through a symlink that leads nowhere (it cannot tell where it would write)", () => {
  const links = { "/private/tmp/dangling": "/missing/x" };
  const o = args.parse(toArgv(selfTestArgv({ "--backup-dir": "/private/tmp/dangling/b" })));
  assert.ok(args.selfTestProblems(o, env(links)).some((p) => p.startsWith("--backup-dir") && /symlink/.test(p)));
});

test("self-test needs the account's real home: a changed or unknown HOME is refused", () => {
  const o = args.parse(toArgv(selfTestArgv()));
  assert.deepEqual(args.selfTestProblems(o, Object.assign(env(), { envHome: HOME })), []);
  assert.deepEqual(args.selfTestProblems(o, Object.assign(env(), { envHome: HOME + "/" })), []);
  assert.deepEqual(args.selfTestProblems(o, Object.assign(env(), { envHome: undefined })), []);
  assert.ok(args.selfTestProblems(o, Object.assign(env(), { envHome: "/private/tmp/fakehome" })).some((p) => /HOME/.test(p)));
  assert.ok(args.selfTestProblems(o, Object.assign(env(), { envHome: "/missing/home" })).some((p) => /HOME/.test(p)));
  assert.ok(args.selfTestProblems(o, { home: null, envHome: HOME, fs: fakeFs() }).some((p) => /home folder/.test(p)));
});

test("insideAny: an app in /Applications or ~/Applications under any name (runner's install check)", () => {
  const roots = ["/Applications", HOME + "/Applications"];
  const links = { "/private/tmp/links/Linked.app": "/Applications/Marginalia.app" };
  for (const p of ["/Applications/Marginalia.app", "/applications/Marginalia.app", "/System/Volumes/Data/Applications/Marginalia.app",
    HOME + "/Applications/Marginalia.app", "/private/tmp/links/Linked.app"]) {
    assert.equal(args.insideAny(p, roots, fakeFs(links)), true, p);
  }
  for (const p of ["/private/tmp/out/Marginalia.app", HOME + "/Desktop/Marginalia.app", "/Applicationsx/Marginalia.app"]) {
    assert.equal(args.insideAny(p, roots, fakeFs(links)), false, p);
  }
});

test("on this disk: firmlink names, other letter case, Unicode forms and symlinks of a protected folder are all refused", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "args-guard-")));
  try {
    const home = path.join(dir, "Zo\u00eb");                                   // a home folder whose name has an accent
    fs.mkdirSync(path.join(home, "Documents", "Obsidian Vault"), { recursive: true });
    fs.mkdirSync(path.join(home, "Library", "Application Support"), { recursive: true });
    fs.mkdirSync(path.join(dir, "elsewhere"));
    fs.symlinkSync(path.join(home, "Documents"), path.join(dir, "docs-link"));
    const realEnv = { home, envHome: undefined, fs };
    const refused = [
      path.join(home, "Documents", "Marginalia Backups"),
      "/System/Volumes/Data" + path.join(home, "Documents", "Marginalia Backups"),
      "/System/Volumes/Data" + path.join(home, "Library", "Application Support", "Marginalia", "x"),
      path.join(home, "DOCUMENTS", "x"),
      path.join(dir, "Zoe\u0308", "Documents", "x"),                         // the same name, decomposed (NFD)
      path.join(dir, "docs-link", "x"),
      "/System/Volumes/Data" + home
    ];
    for (const p of refused) assert.equal(args.guardedFolder(p, realEnv).refused, true, p);
    for (const p of [path.join(dir, "elsewhere", "x"), "/System/Volumes/Data" + path.join(dir, "elsewhere")]) {
      assert.equal(args.guardedFolder(p, realEnv).refused, false, p);
    }
    // HOME through a symlink to the real home is the same folder; another folder is not
    fs.symlinkSync(home, path.join(dir, "home-link"));
    const o = args.parse(toArgv(selfTestArgv({ "--user-data-dir": path.join(dir, "elsewhere", "ud") })));
    assert.deepEqual(args.selfTestProblems(o, { home, envHome: path.join(dir, "home-link"), fs }).filter((p) => /HOME/.test(p)), []);
    assert.ok(args.selfTestProblems(o, { home, envHome: path.join(dir, "elsewhere"), fs }).some((p) => /HOME/.test(p)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
