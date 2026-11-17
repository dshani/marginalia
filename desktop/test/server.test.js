"use strict";
// lib/server.js: the command line, the environment, and (with a real python3 and the web app's own serve.py beside
// desktop/) a real start and stop, the port probe, and the guard that stops a server whose app was killed.
// The servers here use a throwaway sandbox vault and backup folder in a temp folder and a free port.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const server = require("../lib/server");
const python = require("../lib/python");

const WEB = path.resolve(__dirname, "..", "..", "marginalia");
const SERVE = path.join(WEB, "tools", "serve.py");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "server-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pythonPath;
async function realPython() {
  if (pythonPath !== undefined) return pythonPath;
  pythonPath = fs.existsSync(SERVE) ? (await python.findPython({ serveScript: SERVE })).python : null;
  return pythonPath;
}

test("the server's command line: python3 -I -B, the guard, serve.py and the pass-through flags", () => {
  const a = server.serverArgs({ serveScript: "/W/tools/serve.py", webDir: "/W", port: 8765 });
  assert.deepEqual(a, ["-I", "-B", "-c", server.GUARD, "/W/tools/serve.py", "--port", "8765", "--bind", "127.0.0.1", "--dir", "/W"]);
  const b = server.serverArgs({ serveScript: "/W/s.py", webDir: "/W", port: 1, obsidianSandbox: "/t/sb", backupDir: "/t/bk" });
  assert.deepEqual(b.slice(-4), ["--obsidian-sandbox", "/t/sb", "--backup-dir", "/t/bk"]);
  const c = server.serverArgs({ serveScript: "/W/s.py", webDir: "/W", port: 1, obsidianConfig: "/t/o.json" });
  assert.deepEqual(c.slice(-2), ["--obsidian-config", "/t/o.json"]);
});

test("--app <version>: after --dir, only digits.digits.digits (serve.py's rule), never anything else (E2.3 a)", () => {
  const a = server.serverArgs({ serveScript: "/W/tools/serve.py", webDir: "/W", port: 8765, appVersion: "1.0.0", backupDir: "/t/bk" });
  assert.deepEqual(a.slice(4), ["/W/tools/serve.py", "--port", "8765", "--bind", "127.0.0.1", "--dir", "/W", "--app", "1.0.0", "--backup-dir", "/t/bk"]);
  for (const ok of ["0.0.0", "1.0.0", "12.345.6789"]) assert.equal(server.appVersionOk(ok), true, ok);
  for (const bad of ["1.0", "1.0.0.0", "v1.0.0", "1.0.0-beta", " 1.0.0", "1.0.0\n", "١.٠.٠", "", "1..0", 100, null]) {
    assert.equal(server.appVersionOk(bad), false, String(bad));
    assert.throws(() => server.serverArgs({ serveScript: "/s.py", webDir: "/W", port: 1, appVersion: bad === null ? 7 : bad }), /digits\.digits\.digits/, String(bad));
  }
  assert.ok(!server.serverArgs({ serveScript: "/s.py", webDir: "/W", port: 1 }).includes("--app"), "no version given: no --app (the unit tests' servers)");
});

test("the guard watches stdin and runs serve.py unchanged as __main__", () => {
  assert.match(server.GUARD, /while os\.read\(0, 65536\):/);          // the raw descriptor: no reader lock held at shutdown
  assert.ok(!/sys\.stdin/.test(server.GUARD));
  assert.match(server.GUARD, /os\.kill\(os\.getpid\(\), signal\.SIGTERM\)/);
  assert.match(server.GUARD, /daemon=True/);
  assert.match(server.GUARD, /runpy\.run_path\(sys\.argv\[0\], run_name='__main__'\)/);
});

test("the child's environment loses MARGINALIA_OBSIDIAN_CONFIG and MARGINALIA_BACKUP_DIR", () => {
  const env = server.childEnv({ PATH: "/bin", MARGINALIA_OBSIDIAN_CONFIG: "/x", MARGINALIA_BACKUP_DIR: "/y", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

test("isMarginaliaPage needs a 200 with the marginalia-build meta", () => {
  assert.equal(server.isMarginaliaPage({ status: 200, body: '<meta name="marginalia-build" content="local">' }), true);
  assert.equal(server.isMarginaliaPage({ status: 404, body: '<meta name="marginalia-build" content="local">' }), false);
  assert.equal(server.isMarginaliaPage({ status: 200, body: "<title>Marginalia</title>" }), false);
});

test("probePort: free, another program, and a Marginalia page", async (t) => {
  const port = await freePort();
  assert.equal(await server.probePort(port), "free");
  for (const [body, want] of [["hello", "other"], ['<meta name="marginalia-build" content="local">', "marginalia"]]) {
    const srv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(body); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try { assert.equal(await server.probePort(srv.address().port), want); } finally { await new Promise((r) => srv.close(r)); }
  }
  const raw = net.createServer((sock) => { sock.on("error", () => {}); sock.end("garbage\r\n\r\n"); });
  await new Promise((r) => raw.listen(0, "127.0.0.1", r));
  try { assert.equal(await server.probePort(raw.address().port), "other"); } finally { raw.close(); }   // no wait: a reset socket can keep close() from calling back
});

test("a real serve.py starts, answers, stops on SIGTERM and leaves the port free", async (t) => {
  const py = await realPython();
  if (!py) { t.skip("no python3 that runs serve.py"); return; }
  const dir = tmp(t);
  const port = await freePort();
  const lines = [];
  const srv = new server.ServerProcess({ python: py, serveScript: SERVE, webDir: WEB, port, obsidianSandbox: path.join(dir, "sandbox"),
    backupDir: path.join(dir, "backups"), env: process.env, log: { write: (c) => lines.push(String(c)), line: (l) => lines.push(l + "\n") } });
  t.after(() => srv.stop());
  srv.start();
  assert.equal(await srv.waitUntilReady(15000), true, lines.join(""));
  assert.equal(srv.started, true);
  assert.equal(await server.probePort(port), "marginalia");
  const backup = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/api/backup" }, (res) => {
      let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
  assert.equal(backup.ok, true);
  const home = os.homedir(), want = path.join(dir, "backups");   // serve.py shows the home folder as "~"
  assert.equal(backup.dir, want.startsWith(home + path.sep) ? "~" + want.slice(home.length) : want);
  const vaults = await server.httpGet(port, "/api/obsidian/vaults");
  assert.deepEqual(JSON.parse(vaults.body).vaults.map((v) => v.name), ["Sandbox Vault"]);
  const exit = await srv.stop();
  assert.ok(exit && (exit.signal === "SIGTERM" || exit.code !== null), JSON.stringify(exit));
  assert.equal(srv.running, false);
  assert.equal(await server.probePort(port), "free");
  assert.match(lines.join(""), /Marginalia: http:\/\/127\.0\.0\.1:\d+\//);
});

// FEATURES E2.3 a with E2.1: the server main.js starts (--app <version>) is the app's server.
test("a real serve.py started as the app's server answers GET /api/app and takes a POST only from the app's page", async (t) => {
  const py = await realPython();
  if (!py) { t.skip("no python3 that runs serve.py"); return; }
  const dir = tmp(t);
  const port = await freePort();
  const lines = [];
  const srv = new server.ServerProcess({ python: py, serveScript: SERVE, webDir: WEB, port, appVersion: "1.0.0", obsidianSandbox: path.join(dir, "sandbox"),
    backupDir: path.join(dir, "backups"), env: process.env, log: { write: (c) => lines.push(String(c)), line: (l) => lines.push(l + "\n") } });
  t.after(() => srv.stop());
  srv.start();
  assert.equal(await srv.waitUntilReady(15000), true, lines.join(""));
  assert.match(lines.join(""), /App: the server of the Marginalia app 1\.0\.0/);
  const app = await server.httpGet(port, "/api/app");
  assert.equal(app.status, 200);
  assert.deepEqual(JSON.parse(app.body), { ok: true, app: true, version: "1.0.0" });
  const origin = "http://127.0.0.1:" + port;
  const post = (client) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ mode: "manual", backup: { format: "marginalia", version: 1, collections: [], prompts: [] } });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Marginalia": "1", Origin: origin };
    if (client) headers["X-Marginalia-Client"] = client;
    const req = http.request({ host: "127.0.0.1", port, path: "/api/backup", method: "POST", headers }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const refused = await post(null);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "app_only");
  assert.equal(fs.existsSync(path.join(dir, "backups")), false, "nothing was written");
  const taken = await post("app");
  assert.equal(taken.status, 200, JSON.stringify(taken.json));
  assert.equal(taken.json.ok, true);
  assert.deepEqual(fs.readdirSync(path.join(dir, "backups")).filter((n) => n.endsWith(".json")).length, 1);
});

test("a server whose app is killed (no JavaScript runs) stops by itself: the guard sees stdin close", async (t) => {
  const py = await realPython();
  if (!py) { t.skip("no python3 that runs serve.py"); return; }
  const dir = tmp(t);
  const port = await freePort();
  const code = `
    const server = require(${JSON.stringify(path.join(__dirname, "..", "lib", "server.js"))});
    const srv = new server.ServerProcess({ python: ${JSON.stringify(py)}, serveScript: ${JSON.stringify(SERVE)}, webDir: ${JSON.stringify(WEB)},
      port: ${port}, obsidianSandbox: ${JSON.stringify(path.join(dir, "sandbox"))}, backupDir: ${JSON.stringify(path.join(dir, "backups"))} });
    srv.start();
    srv.waitUntilReady(15000).then((ok) => { process.stdout.write((ok ? "ready " + srv.child.pid : "failed") + "\\n"); });
    setInterval(() => {}, 1000);`;
  const app = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { try { app.kill("SIGKILL"); } catch (e) { /* gone */ } });
  const first = await new Promise((resolve) => { let out = ""; app.stdout.on("data", (c) => { out += c; if (out.includes("\n")) resolve(out.trim()); }); });
  assert.match(first, /^ready \d+$/);
  const childPid = Number(first.split(" ")[1]);
  assert.equal(await server.probePort(port), "marginalia");
  app.kill("SIGKILL");                                  // like a crash: the app runs no cleanup at all
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) {
    await sleep(100);
    try { process.kill(childPid, 0); } catch (e) { gone = true; }
  }
  assert.equal(gone, true, "serve.py outlived its app");
  assert.equal(await server.probePort(port), "free");
});

test("a server that cannot start (its port is taken) ends, and waitUntilReady says so", async (t) => {
  const py = await realPython();
  if (!py) { t.skip("no python3 that runs serve.py"); return; }
  const dir = tmp(t);
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => blocker.close(r)));
  const srv = new server.ServerProcess({ python: py, serveScript: SERVE, webDir: WEB, port: blocker.address().port,
    obsidianSandbox: path.join(dir, "sandbox"), backupDir: path.join(dir, "backups"), log: { write() {}, line() {} } });
  srv.start();
  assert.equal(await srv.waitUntilReady(15000), false);
  await srv.waitForExit(5000);
  assert.equal(srv.running, false);
  // a plain exit code 1, not a signal: the guard's watcher thread must not make Python abort at shutdown (SIGABRT,
  // "Fatal Python error: _enter_buffered_busy" and a crash report on the Mac) when serve.py ends by itself
  assert.deepEqual({ code: srv.exited.code, signal: srv.exited.signal }, { code: 1, signal: null });
});
