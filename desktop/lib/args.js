"use strict";
// Command-line flags of the Marginalia app (pure: no Electron, no file writes; node --test covers it).
//
//   --self-test                   run the packaged self-test (lib/selftest.js) in a hidden window, print one JSON line
//   --user-data-dir=<dir>         where the library lives (default ~/Library/Application Support/Marginalia)
//   --port=<n>                    the server's port (default 8765, the address "Open in Marginalia" links use)
//   --obsidian-sandbox=<dir>      passed to serve.py: a throwaway vault <dir>/Sandbox Vault (tests)
//   --obsidian-config=<file>      passed to serve.py: another obsidian.json (tests; not with --self-test)
//   --backup-dir=<dir>            passed to serve.py: where the daily JSON backups go (tests)
//   marginalia://open?hash=…      a link to open (a second launch passes it on; see lib/hash.js)
//
// Every value flag takes the "--flag=value" form. Unknown arguments are ignored in normal use (macOS and Chromium
// may add their own) and refused in self-test mode, which must run exactly as asked.
const path = require("node:path");

const DEFAULT_PORT = 8765;           // the user's address: Obsidian notes link to http://127.0.0.1:8765/#reader/…
// The one marginalia:// link a self-test takes: the runner's second launch hands it to the first app (it opens the
// library, which the app shows anyway), so the self-test sees a link go through second-instance to the window.
const SELF_TEST_LINK = "marginalia://open?hash=%23library";
const VALUE_FLAGS = {
  "user-data-dir": "userDataDir",
  "port": "port",
  "obsidian-sandbox": "obsidianSandbox",
  "obsidian-config": "obsidianConfig",
  "backup-dir": "backupDir"
};
const DIR_FLAGS = ["userDataDir", "obsidianSandbox", "obsidianConfig", "backupDir"];
const FLAG_OF = { userDataDir: "--user-data-dir", port: "--port", obsidianSandbox: "--obsidian-sandbox",
  obsidianConfig: "--obsidian-config", backupDir: "--backup-dir" };

function parse(argv) {
  const out = { selfTest: false, userDataDir: null, port: DEFAULT_PORT, portGiven: false, obsidianSandbox: null,
    obsidianConfig: null, backupDir: null, urls: [], ignored: [], errors: [] };
  const seen = new Set();
  for (const a of Array.isArray(argv) ? argv : []) {
    if (typeof a !== "string") continue;
    if (a === "--self-test") { out.selfTest = true; continue; }
    const m = /^--([a-z-]+)=([\s\S]*)$/.exec(a);
    if (m && Object.prototype.hasOwnProperty.call(VALUE_FLAGS, m[1])) {
      const key = VALUE_FLAGS[m[1]];
      if (seen.has(key)) { out.errors.push("--" + m[1] + " is given twice"); continue; }
      seen.add(key);
      setValue(out, key, m[2]);
      continue;
    }
    if (/^--([a-z-]+)$/.test(a) && Object.prototype.hasOwnProperty.call(VALUE_FLAGS, a.slice(2))) {
      out.errors.push(a + " needs a value: " + a + "=<value>");
      continue;
    }
    if (/^marginalia:/i.test(a)) { out.urls.push(a); continue; }
    out.ignored.push(a);
  }
  if (out.obsidianSandbox && out.obsidianConfig) out.errors.push("--obsidian-sandbox and --obsidian-config cannot be used together");
  return out;
}

function setValue(out, key, raw) {
  if (key === "port") {
    out.portGiven = true;
    if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
      out.errors.push("--port must be a number from 1 to 65535 (got " + JSON.stringify(raw) + ")");
      return;
    }
    out.port = Number(raw);
    return;
  }
  if (!raw.trim()) { out.errors.push(FLAG_OF[key] + " needs a folder (got an empty value)"); return; }
  if (/[\0\r\n]/.test(raw)) { out.errors.push(FLAG_OF[key] + " contains a control character"); return; }
  if (!path.isAbsolute(raw)) { out.errors.push(FLAG_OF[key] + " must be an absolute path (got " + JSON.stringify(raw) + ")"); return; }
  out[key] = path.resolve(raw);
}

// ---- self-test guard ----------------------------------------------------------------------------------------
// The folders a self-test (or any test) must never use: the user's documents (the real vault and the real backup
// folder live there), the app's real data folder and Obsidian's own settings folder. A folder is refused when it is
// one of them, inside one of them, or holds one of them (the home folder, ~/Library, "/"). `home` is the account's
// home folder from the user database (main.js: os.userInfo().homedir), never $HOME, which a caller can change.
//
// A folder has many names on macOS, so the guard does not trust how a path is written. It refuses when either test
// says so:
//   - by name: symlinks resolved (realish), letters compared in lower case, and both the plain name and the
//     /System/Volumes/Data name of each folder tried (/Users, /private, /Applications and others are firmlinks: the
//     same folder under two names, which realpath does not merge);
//   - by identity: the existing part of each path is compared by device and inode (stat), so another letter case, a
//     Unicode form or any other alias of the same folder is caught; the part that does not exist yet is compared by
//     name (lower case, Unicode NFC), as APFS compares names.
// A path that runs through a symlink leading nowhere is refused too: nobody can tell where it would write.
function protectedRoots(home) {
  return [
    path.join(home, "Documents"),
    path.join(home, "Library", "Application Support", "Marginalia"),
    path.join(home, "Library", "Application Support", "obsidian")
  ];
}

const DATA_VOLUME = "/System/Volumes/Data";
const DATA_VOLUME_RE = /^\/System\/Volumes\/Data(?=\/|$)/i;

// The real path of `p`: symlinks resolved on the longest part that exists, the rest appended as written.
function realish(p, fsx) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fsx.realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// The names one folder goes by: as written and, for a path on the data volume, without or with /System/Volumes/Data.
function aliases(p) {
  const out = [p];
  if (DATA_VOLUME_RE.test(p)) out.push(p.replace(DATA_VOLUME_RE, "") || "/");
  else if (p.startsWith("/")) out.push(p === "/" ? DATA_VOLUME : DATA_VOLUME + p);
  return out;
}

// macOS disks ignore letter case by default, so the comparison by name does too.
function within(child, parent) {
  const c = child.toLowerCase(), p = parent.toLowerCase();
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

function identity(p, fsx) {
  try { const st = fsx.statSync(p); return st.dev + ":" + st.ino; } catch (e) { return null; }
}

function fold(name) {
  return name.normalize("NFC").toLowerCase();
}

// {base, id, tail, broken}: the nearest existing folder at or above `p` (as written), its identity, the folded names
// below it that do not exist yet, and whether an entry on the way is a symlink that leads nowhere.
function locate(p, fsx) {
  let cur = path.resolve(p);
  const tail = [];
  let broken = false;
  for (;;) {
    const id = identity(cur, fsx);
    if (id) return { base: cur, id, tail: tail.reverse(), broken };
    if (typeof fsx.lstatSync === "function") {
      try { fsx.lstatSync(cur); broken = true; } catch (e) { /* it really is not there */ }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return { base: cur, id: null, tail: tail.reverse(), broken };
    tail.push(fold(path.basename(cur)));
    cur = parent;
  }
}

// Is `child` the folder `parent` or inside it, by identity? Both should come from realish (symlinks resolved).
function sameOrInside(child, parent, fsx) {
  const c = locate(child, fsx), p = locate(parent, fsx);
  if (!c.id || !p.id) return false;
  if (!p.tail.length) {                                     // the parent exists: is it c's folder or one above it?
    for (let a = c.base; ; a = path.dirname(a)) {
      if (identity(a, fsx) === p.id) return true;
      if (path.dirname(a) === a) return false;
    }
  }
  return c.id === p.id && p.tail.every((name, i) => c.tail[i] === name);   // the parent does not exist yet
}

// Every name and real path `p` goes by.
function namesOf(p, fsx) {
  const out = new Set();
  for (const a of aliases(path.resolve(p))) {
    out.add(a);
    const r = realish(a, fsx);
    for (const b of aliases(r)) out.add(b);
  }
  return Array.from(out);
}

function canStat(fsx) {
  return !!fsx && typeof fsx.statSync === "function";
}

// insideAny(p, roots, fs) → true when `p` is one of `roots` or inside one, under any of its names.
function insideAny(p, roots, fsx) {
  const mine = namesOf(p, fsx);
  for (const root of roots) {
    const theirs = namesOf(root, fsx);
    for (const a of mine) {
      for (const b of theirs) {
        if (within(a, b) || (canStat(fsx) && sameOrInside(a, b, fsx))) return true;
      }
    }
  }
  return false;
}

// guardedFolder(dir, {home, fs}) → {refused, real, root?, why?}
function guardedFolder(dir, env) {
  const fsx = env.fs;
  const real = realish(dir, fsx);
  if (canStat(fsx) && locate(real, fsx).broken) {
    return { refused: true, real, root: real, why: "it runs through a symlink that leads nowhere" };
  }
  const mine = namesOf(dir, fsx);
  for (const root of protectedRoots(env.home)) {
    const theirs = namesOf(root, fsx);
    for (const a of mine) {
      for (const b of theirs) {
        if (within(a, b) || within(b, a)) return { refused: true, real, root };
        if (canStat(fsx) && (sameOrInside(a, b, fsx) || sameOrInside(b, a, fsx))) return { refused: true, real, root };
      }
    }
  }
  return { refused: false, real };
}

// Is $HOME the account's own home folder? (unset: yes; Node and Chromium then use the user database too)
function homeIsAccountHome(envHome, home, fsx) {
  if (envHome === undefined || envHome === null || envHome === "") return true;
  if (!path.isAbsolute(envHome)) return false;
  if (path.resolve(envHome) === path.resolve(home)) return true;
  if (!canStat(fsx)) return false;
  const a = identity(envHome, fsx), b = identity(home, fsx);
  return !!a && a === b;
}

// selfTestProblems(opts, {home, envHome, fs}) → [reason…]; empty when the self-test may run.
function selfTestProblems(opts, env) {
  const problems = [];
  if (!opts || !opts.selfTest) return problems;
  problems.push(...opts.errors);
  if (!opts.userDataDir) problems.push("--self-test needs --user-data-dir=<a throwaway folder>");
  if (!opts.portGiven) problems.push("--self-test needs --port=<a free port>");
  if (!opts.obsidianSandbox) problems.push("--self-test needs --obsidian-sandbox=<a throwaway folder>");
  if (!opts.backupDir) problems.push("--self-test needs --backup-dir=<a throwaway folder>");
  if (opts.obsidianConfig) problems.push("--self-test takes --obsidian-sandbox, never --obsidian-config");
  if (opts.portGiven && opts.port === DEFAULT_PORT) problems.push("--self-test never uses port " + DEFAULT_PORT + " (the user's Marginalia address)");
  if (opts.portGiven && opts.port < 1024) problems.push("--self-test needs a port from 1024 to 65535");
  const links = opts.urls.filter((u) => u !== SELF_TEST_LINK);
  if (links.length || opts.urls.length > 1) problems.push("--self-test opens no marginalia:// link but " + SELF_TEST_LINK);
  if (opts.ignored.length) problems.push("--self-test does not take: " + opts.ignored.join(" "));
  if (!env || typeof env.home !== "string" || !path.isAbsolute(env.home)) {
    problems.push("--self-test cannot tell this account's home folder, so it cannot keep away from the real folders");
    return problems;
  }
  if (!homeIsAccountHome(env.envHome, env.home, env.fs)) {
    problems.push("--self-test runs only with the real HOME: HOME is " + JSON.stringify(env.envHome) + ", but this account's home folder is " + env.home);
  }
  for (const key of ["userDataDir", "obsidianSandbox", "backupDir"]) {
    if (!opts[key]) continue;
    const g = guardedFolder(opts[key], env);
    if (g.refused) problems.push(FLAG_OF[key] + " " + opts[key] + (g.why ? ": " + g.why : " is or holds or is inside " + g.root + ", which tests never touch"));
  }
  return problems;
}

module.exports = { parse, selfTestProblems, protectedRoots, guardedFolder, insideAny, sameOrInside, homeIsAccountHome, realish, within,
  aliases, DEFAULT_PORT, DIR_FLAGS, SELF_TEST_LINK };
