"use strict";
// The app's own server: its copy of tools/serve.py, started as a child process and stopped with the app.
//
//   <python3> -I -B -c <GUARD> <web>/tools/serve.py --port <n> --bind 127.0.0.1 --dir <web> --app <version>
//             [--obsidian-sandbox <dir> | --obsidian-config <file>] [--backup-dir <dir>]
//
// --app <version> (FEATURES E2.3 a; the app's version, desktop/package.json, digits.digits.digits as serve.py requires)
// makes it the app's server: GET /api/app answers {ok: true, app: true, version}, so a Brave tab on the same address
// shows "Marginalia is now an app", and every POST needs the header "X-Marginalia-Client: app", which only the app's own
// page sends (POST /api/backup and /api/backup/pdf also take "browser-move", the cover's one backup); anything else gets
// 409 app_only and nothing is written.
//
// -I (isolated: no PYTHON* variables, no user site-packages, no script folder on sys.path) and -B (no .pyc files:
// nothing is ever written into the signed app bundle). GUARD runs serve.py unchanged (runpy, as `python3 serve.py`
// would) after starting one daemon thread that reads the child's stdin, a pipe from the app: when the app ends in
// any way, also a crash or a kill -9 that runs no JavaScript, the pipe closes and the thread sends the server
// SIGTERM, so a stray serve.py never outlives the app. The thread reads file descriptor 0 with os.read, never through
// sys.stdin: a daemon thread blocked in sys.stdin.buffer.read holds that reader's lock, and when serve.py ends by itself
// (a taken port, an option it refuses) Python then aborts at shutdown (SIGABRT, a crash report) instead of exiting 1. serve.py's own SIGTERM handler lets a note or backup write
// finish first (at most 2 s). The child gets its own process group (a Ctrl+C in a Terminal that started the app
// reaches the app, which then stops the server itself), and the app stops it with SIGTERM, then SIGKILL after
// STOP_GRACE_MS. MARGINALIA_OBSIDIAN_CONFIG and MARGINALIA_BACKUP_DIR are removed from the child's environment: the
// app's flags are the only way to point the server elsewhere.
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const HOST = "127.0.0.1";
const STOP_GRACE_MS = 5000;     // serve.py waits at most 2 s for a write in progress
const KILL_WAIT_MS = 2000;
const READY_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 1500;
const MARKER_RE = /<meta\b[^>]*\bname\s*=\s*["']?marginalia-build\b/i;
const STRIPPED_ENV = ["MARGINALIA_OBSIDIAN_CONFIG", "MARGINALIA_BACKUP_DIR"];
const APP_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;   // serve.py's --app rule (APP_VERSION_RE there: ASCII digits)

const GUARD = [
  "import os, runpy, signal, sys, threading",
  "def _watch_parent():",
  "    try:",
  "        while os.read(0, 65536):",
  "            pass",
  "    except BaseException:",
  "        pass",
  "    os.kill(os.getpid(), signal.SIGTERM)",
  "threading.Thread(target=_watch_parent, name='marginalia-app-watch', daemon=True).start()",
  "sys.argv = sys.argv[1:]",
  "runpy.run_path(sys.argv[0], run_name='__main__')"
].join("\n");

// appVersionOk("1.0.0") → true: a version serve.py takes for --app (anything else stops it with exit 2)
function appVersionOk(v) {
  return typeof v === "string" && v.length <= 64 && APP_VERSION_RE.test(v);
}

function serverArgs(o) {
  const args = ["-I", "-B", "-c", GUARD, o.serveScript, "--port", String(o.port), "--bind", HOST, "--dir", o.webDir];
  if (o.appVersion !== undefined && o.appVersion !== null) {
    if (!appVersionOk(o.appVersion)) {
      throw new Error("the app's version must be digits.digits.digits for serve.py --app (got " + JSON.stringify(o.appVersion) + ")");
    }
    args.push("--app", o.appVersion);
  }
  if (o.obsidianSandbox) args.push("--obsidian-sandbox", o.obsidianSandbox);
  if (o.obsidianConfig) args.push("--obsidian-config", o.obsidianConfig);
  if (o.backupDir) args.push("--backup-dir", o.backupDir);
  return args;
}

function childEnv(env) {
  const out = Object.assign({}, env || {});
  for (const k of STRIPPED_ENV) delete out[k];
  return out;
}

// GET http://127.0.0.1:<port><path> → Promise<{status, body}> (body cut at 64 KB); rejects on connection errors.
function httpGet(port, pathName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port, path: pathName || "/", timeout: timeoutMs || PROBE_TIMEOUT_MS,
      headers: { "Cache-Control": "no-cache" } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { if (size < 65536) { chunks.push(c); size += c.length; } });
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function isMarginaliaPage(res) {
  return !!res && res.status === 200 && MARKER_RE.test(res.body || "");
}

// probePort(port) → Promise<"free" | "marginalia" | "other">: "free" when nothing accepts a connection on
// 127.0.0.1:<port>; "marginalia" when it answers GET / with a Marginalia page (for example the server the
// `marginalia` command started); "other" for anything else.
function probePort(port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs || PROBE_TIMEOUT_MS, () => finish("other"));
    sock.on("connect", () => {
      done = true;
      sock.destroy();
      httpGet(port, "/", timeoutMs).then((res) => resolve(isMarginaliaPage(res) ? "marginalia" : "other"), () => resolve("other"));
    });
    sock.on("error", (e) => finish(e && e.code === "ECONNREFUSED" ? "free" : "other"));
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class ServerProcess extends EventEmitter {
  constructor(o) {
    super();
    this.python = o.python;
    this.args = serverArgs(o);
    this.port = o.port;
    this.env = childEnv(o.env || process.env);
    this.log = o.log || { write() {}, line() {} };
    this.child = null;
    this.exited = null;      // {code, signal} once the child has ended
    this.started = false;    // the child printed its "Marginalia: http://127.0.0.1:<port>/" line (the port is bound)
    this.stopping = false;
  }

  get running() { return !!this.child && !this.exited; }

  start() {
    this.exited = null;
    this.started = false;
    this.stopping = false;
    const child = spawn(this.python, this.args, { env: this.env, stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true });
    this.child = child;
    let head = "";
    const onOut = (chunk) => {
      this.log.write(chunk);
      if (!this.started) {
        head = (head + chunk.toString("utf8")).slice(-4096);
        if (head.indexOf("Marginalia: http://" + HOST + ":" + this.port + "/") >= 0) { this.started = true; this.emit("bound"); }
      }
    };
    child.stdout.on("data", onOut);
    child.stderr.on("data", (c) => this.log.write(c));
    child.stdin.on("error", () => { /* the server ended first */ });
    const ended = (info) => {
      if (this.child !== child || this.exited) return;   // once per child (a spawn error may also report an exit)
      this.exited = info;
      this.emit("exit", info);
    };
    child.on("error", (e) => {
      this.log.line("server could not start: " + (e && e.message));
      ended({ code: null, signal: null, error: String(e && e.message) });
    });
    child.on("exit", (code, signal) => {
      this.log.line("server ended (" + (signal ? "signal " + signal : "exit code " + code) + ")");
      ended({ code, signal });
    });
    this.log.line("server starting: " + this.python + " " + this.args.map((a) => (a === GUARD ? "<guard>" : a)).join(" "));
    return child;
  }

  // Resolves true once the child has bound the port and GET / answers with the Marginalia page; false when the child
  // ends first or nothing answers within timeoutMs.
  async waitUntilReady(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (!this.running) return false;
      if (this.started) {
        try { if (isMarginaliaPage(await httpGet(this.port, "/", PROBE_TIMEOUT_MS))) return this.running; } catch (e) { /* not yet */ }
      }
      await delay(100);
    }
    return false;
  }

  waitForExit(ms) {
    if (!this.child || this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.removeListener("exit", on); resolve(false); }, ms);
      const on = () => { clearTimeout(t); resolve(true); };
      this.once("exit", on);
    });
  }

  // SIGTERM, then SIGKILL after graceMs; resolves with {code, signal} (or null when it was not running).
  async stop(graceMs, killWaitMs) {
    if (!this.child || this.exited) return this.exited;
    this.stopping = true;
    this.log.line("stopping the server (SIGTERM)");
    try { this.child.kill("SIGTERM"); } catch (e) { /* gone */ }
    if (!(await this.waitForExit(graceMs || STOP_GRACE_MS))) {
      this.log.line("the server did not stop: SIGKILL");
      try { this.child.kill("SIGKILL"); } catch (e) { /* gone */ }
      await this.waitForExit(killWaitMs || KILL_WAIT_MS);
    }
    return this.exited;
  }
}

module.exports = { ServerProcess, serverArgs, appVersionOk, childEnv, probePort, httpGet, isMarginaliaPage, GUARD, HOST, STRIPPED_ENV,
  APP_VERSION_RE, STOP_GRACE_MS, READY_TIMEOUT_MS };
