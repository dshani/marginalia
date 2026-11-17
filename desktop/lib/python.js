"use strict";
// Which python3 runs the app's copy of tools/serve.py.
//
// A Mac app started from Finder gets no shell PATH, so the app looks in fixed places, in this order:
//   /opt/homebrew/bin/python3   Homebrew on Apple silicon (serve.py is tested with Python 3.14)
//   /usr/local/bin/python3      Homebrew on Intel Macs, and the python.org installer
//   /usr/bin/python3            Apple's, part of the Command Line Tools
// and takes the first that runs serve.py: `<python> -I -B <serve.py> --help` must exit 0 within 10 s (it imports
// every module serve.py needs, and a Python too old for its syntax fails here). /usr/bin/python3 is only tried when
// `xcode-select -p` finds developer tools: without them that stub opens Apple's "install the command line developer
// tools" window instead of running.
const fs = require("node:fs");
const { execFile } = require("node:child_process");

const CANDIDATES = Object.freeze(["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]);
const APPLE_STUB = "/usr/bin/python3";
const PROBE_TIMEOUT_MS = 10000;

function probeArgs(serveScript) {
  return ["-I", "-B", serveScript, "--help"];
}

// findPython({serveScript, candidates, probe, developerToolsPresent}) → Promise<{python|null, tried: [{path, ok, reason}]}>
// probe(path, serveScript) → Promise<{ok, reason}>; developerToolsPresent() → Promise<boolean>. Both are injectable.
async function findPython(options) {
  const opts = options || {};
  const candidates = opts.candidates || CANDIDATES;
  const probe = opts.probe || defaultProbe;
  const devTools = opts.developerToolsPresent || defaultDeveloperToolsPresent;
  const tried = [];
  for (const candidate of candidates) {
    if (candidate === APPLE_STUB && !(await devTools())) {
      tried.push({ path: candidate, ok: false, reason: "skipped: no developer tools (running it would ask to install them)" });
      continue;
    }
    let r;
    try { r = await probe(candidate, opts.serveScript); } catch (e) { r = { ok: false, reason: String(e && e.message || e) }; }
    tried.push({ path: candidate, ok: !!(r && r.ok), reason: (r && r.reason) || "" });
    if (r && r.ok) return { python: candidate, tried };
  }
  return { python: null, tried };
}

function defaultProbe(python, serveScript) {
  return new Promise((resolve) => {
    try { fs.accessSync(python, fs.constants.X_OK); } catch (e) { resolve({ ok: false, reason: "not installed" }); return; }
    execFile(python, probeArgs(serveScript), { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (!err) { resolve({ ok: true, reason: "runs serve.py" }); return; }
        const tail = String(stderr || stdout || err.message || "").trim().split("\n").slice(-1)[0];
        resolve({ ok: false, reason: (err.killed ? "timed out" : "exit " + err.code) + (tail ? ": " + tail.slice(0, 200) : "") });
      });
  });
}

function defaultDeveloperToolsPresent() {
  return new Promise((resolve) => {
    execFile("/usr/bin/xcode-select", ["-p"], { timeout: 5000 }, (err) => resolve(!err));
  });
}

const INSTALL_HELP = "Marginalia runs a small local server written in Python 3, and no working python3 was found in " +
  "/opt/homebrew/bin, /usr/local/bin or /usr/bin.\n\nInstall it in one of these ways, then open Marginalia again:\n" +
  "• Homebrew (brew.sh): in Terminal, run  brew install python\n" +
  "• python.org: download the macOS installer from https://www.python.org/downloads/\n" +
  "• Apple's Command Line Tools: in Terminal, run  xcode-select --install";

module.exports = { findPython, probeArgs, defaultProbe, CANDIDATES, APPLE_STUB, INSTALL_HELP };
