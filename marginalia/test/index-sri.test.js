// node --test test/index-sri.test.js — Subresource Integrity for the cdnjs files of index.html.
// Every cdnjs <script>/<link> carries the pinned SHA-384 digest plus crossorigin="anonymous". The PDF.js
// worker cannot be pinned by an attribute (a Worker URL has none), so index.html sets workerSrc to a
// bootstrap that fetches pdf.worker.min.js with that digest, and replaces PDF.js's main-thread fallback
// loader with an integrity-checked script element. The inline script runs here against stubs; no network.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const LIVE = HTML.replace(/<!--[\s\S]*?-->/g, "");            // commented-out markup does not count
const CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
const PDF_URL = CDN + "pdf.js/3.11.174/pdf.min.js";
const WORKER_URL = CDN + "pdf.js/3.11.174/pdf.worker.min.js";
const KATEX_JS = CDN + "KaTeX/0.16.47/katex.min.js";
const KATEX_CSS = CDN + "KaTeX/0.16.47/katex.min.css";
// SHA-384 of the pinned files; the SHA-512 of the same bytes equals the SRI cdnjs publishes for them.
// A version bump changes the URL, so this table (and index.html) must get the new file's digest.
const PINNED = {
  [PDF_URL]: "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e",
  [WORKER_URL]: "sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2",
  [KATEX_JS]: "sha384-CwjPRVHTvLiMBFjEoij+QZViMV5rhTOIp7CJzl24JEqpRDA1sJFHVXXLURktbYYp",
  [KATEX_CSS]: "sha384-nH0MfJ44wi1dd7w6jinlyBgljjS8EJAh2JBoRad8a3VDw2K69vfaaqm4WnR+gXtA"
};

function attr(tag, name) {
  const m = new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))", "i").exec(tag);
  return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : null;
}
function scripts() {
  return [...LIVE.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .map((m) => ({ tag: "<script" + m[1] + ">", src: attr(m[1], "src"), body: m[2] }));
}
function links() {
  return [...LIVE.matchAll(/<link\b[^>]*>/gi)].map((m) => ({ tag: m[0], href: attr(m[0], "href") }));
}
const isRemote = (u) => /^(https?:)?\/\//i.test(u || "");
const tick = () => new Promise((r) => setImmediate(r));

// The inline script that follows pdf.min.js (SPEC §18: pdf.min.js + an inline workerSrc script).
function workerScript() {
  const list = scripts();
  const i = list.findIndex((s) => s.src === PDF_URL);
  assert.ok(i >= 0, "index.html loads pdf.min.js 3.11.174");
  const next = list[i + 1];
  assert.ok(next && !next.src, "an inline script follows pdf.min.js");
  return next.body;
}

// Runs that inline script in a page-like context with a stub pdfjsLib.
function runPage(href) {
  const appended = [];
  const objectUrls = [];
  const head = {
    appendChild(el) { appended.push(el); el.parentNode = head; return el; },
    removeChild(el) { const k = appended.indexOf(el); if (k >= 0) appended.splice(k, 1); el.parentNode = null; return el; }
  };
  const document = {
    head, documentElement: head,
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), attributes: {}, parentNode: null, setAttribute(k, v) { this.attributes[k] = String(v); } };
    }
  };
  class PDFWorker { static get _setupFakeWorkerGlobal() { return "pdf.js loadScript(workerSrc)"; } }
  const pdfjsLib = { GlobalWorkerOptions: { workerSrc: "", workerPort: null }, PDFWorker };
  class PageURL extends URL {}
  PageURL.createObjectURL = (blob) => {
    const origin = new URL(href).origin;
    const u = "blob:" + (origin === "null" ? "null" : origin) + "/" + crypto.randomUUID();
    objectUrls.push({ url: u, blob, revoked: false });
    return u;
  };
  PageURL.revokeObjectURL = (u) => { for (const o of objectUrls) if (o.url === u) o.revoked = true; };
  const win = { pdfjsLib, location: { href }, document };
  win.window = win;
  const ctx = vm.createContext({ window: win, document, URL: PageURL, Blob });
  vm.runInContext(workerScript(), ctx, { filename: "index.html#worker-script" });
  return { win, pdfjsLib, PDFWorker, appended, objectUrls };
}

// Runs the worker bootstrap source in a worker-like context.
async function runBootstrap(source, { fetchImpl, inWorker = true }) {
  const imported = [], timers = [], calls = [], made = [];
  class WorkerURL extends URL {}
  WorkerURL.createObjectURL = (b) => { made.push(b); return "blob:worker/" + made.length; };
  WorkerURL.revokeObjectURL = () => {};
  const g = {
    fetch: (...a) => { calls.push(a); return fetchImpl(...a); },
    URL: WorkerURL, Blob,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }
  };
  if (inWorker) g.importScripts = (...u) => { imported.push(...u); };
  vm.runInContext(source, vm.createContext(g), { filename: "worker-bootstrap" });
  for (let i = 0; i < 5; i++) await tick();
  return { imported, timers, calls, made };
}
async function bootstrapSource(env) {
  const src = env.pdfjsLib.GlobalWorkerOptions.workerSrc;
  if (src.startsWith("data:")) return decodeURIComponent(src.slice(src.indexOf(",") + 1));
  const o = env.objectUrls.find((x) => x.url === src);
  assert.ok(o, "workerSrc is an object URL made by the inline script");
  return o.blob.text();
}

test("every cdnjs script and stylesheet carries the pinned SHA-384 integrity and crossorigin=anonymous", () => {
  const remote = [
    ...scripts().filter((s) => isRemote(s.src)).map((s) => ({ url: s.src, tag: s.tag })),
    ...links().filter((l) => isRemote(l.href) && !/^(https?:)?\/\/fonts\.googleapis\.com\//i.test(l.href))
      .map((l) => ({ url: l.href, tag: l.tag }))
  ];
  assert.deepEqual(remote.map((r) => r.url).sort(), [KATEX_CSS, KATEX_JS, PDF_URL].sort());
  for (const r of remote) {
    assert.ok(PINNED[r.url], r.url + ": no pinned digest; add the SHA-384 of the new file here and in index.html");
    assert.equal(attr(r.tag, "integrity"), PINNED[r.url], r.url + ": integrity attribute");
    assert.equal(attr(r.tag, "crossorigin"), "anonymous", r.url + ": crossorigin attribute");
  }
});

test("SPEC §18 order is kept: katex.min.css link, pdf.min.js, inline worker script, katex.min.js, js/util.js", () => {
  const list = scripts();
  const pdf = list.findIndex((s) => s.src === PDF_URL);
  assert.ok(pdf >= 0);
  assert.equal(list[pdf + 1].src, null);
  assert.equal(list[pdf + 2].src, KATEX_JS);
  assert.equal(list[pdf + 3].src, "js/util.js");
  const hrefs = links().map((l) => l.href);
  assert.ok(hrefs.indexOf(KATEX_CSS) >= 0 && hrefs.indexOf(KATEX_CSS) < hrefs.indexOf("styles.css"));
});

test("workerSrc never names the cdnjs worker file directly (PDF.js would importScripts it unchecked)", () => {
  assert.doesNotMatch(LIVE, /workerSrc\s*=\s*["'`]https?:/);
  for (const href of ["http://127.0.0.1:8000/index.html", "file:///Users/x/marginalia/index.html"]) {
    const src = runPage(href).pdfjsLib.GlobalWorkerOptions.workerSrc;
    assert.ok(/^(blob|data):/.test(src), href + " -> " + src.slice(0, 40));
  }
});

test("http(s) page: workerSrc is a same-origin blob bootstrap that fetches the worker with the pinned digest", async () => {
  const env = runPage("http://127.0.0.1:8000/index.html");
  const src = env.pdfjsLib.GlobalWorkerOptions.workerSrc;
  assert.match(src, /^blob:http:\/\/127\.0\.0\.1:8000\//);   // PDF.js starts it directly: same origin
  const boot = await bootstrapSource(env);
  assert.ok(boot.includes(JSON.stringify(WORKER_URL)));
  assert.ok(boot.includes(JSON.stringify(PINNED[WORKER_URL])));
  new vm.Script(boot);                                       // valid JavaScript on its own
});

test("file:// page: workerSrc is a data: URL carrying the same bootstrap (PDF.js wraps it in importScripts)", async () => {
  const env = runPage("file:///Users/x/marginalia/index.html");
  const src = env.pdfjsLib.GlobalWorkerOptions.workerSrc;
  assert.match(src, /^data:text\/javascript;charset=utf-8,/);
  assert.doesNotMatch(src, /["\\\s]/);                       // safe inside PDF.js's importScripts("…") wrapper
  assert.ok(env.objectUrls.every((o) => o.revoked), "the unused blob URL is revoked");
  const http = runPage("http://127.0.0.1:8000/index.html");
  assert.equal(await bootstrapSource(env), await bootstrapSource(http));
});

test("bootstrap: integrity-checked fetch, then importScripts of exactly the fetched bytes", async () => {
  const boot = await bootstrapSource(runPage("http://127.0.0.1:8000/index.html"));
  const body = new Blob(["self.pdfjsWorkerStub = 1;"]);
  const r = await runBootstrap(boot, { fetchImpl: () => Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(body) }) });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0][0], WORKER_URL);
  assert.deepEqual({ ...r.calls[0][1] }, { integrity: PINNED[WORKER_URL], mode: "cors", credentials: "omit" });
  assert.deepEqual(r.imported, ["blob:worker/1"]);
  assert.equal(await r.made[0].text(), "self.pdfjsWorkerStub = 1;");
  assert.equal(r.timers.length, 0);
});

test("bootstrap: integrity mismatch or HTTP error imports nothing and rethrows for the Worker error event", async () => {
  const boot = await bootstrapSource(runPage("http://127.0.0.1:8000/index.html"));
  const bad = new TypeError("Failed to fetch (integrity mismatch)");
  const r1 = await runBootstrap(boot, { fetchImpl: () => Promise.reject(bad) });
  assert.deepEqual(r1.imported, []);
  assert.equal(r1.timers.length, 1);
  assert.throws(() => r1.timers[0](), (e) => e === bad);
  const r2 = await runBootstrap(boot, { fetchImpl: () => Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve(new Blob([""])) }) });
  assert.deepEqual(r2.imported, []);
  assert.equal(r2.timers.length, 1);
  assert.throws(() => r2.timers[0](), /HTTP 404/);
  const r3 = await runBootstrap(boot, { inWorker: false, fetchImpl: () => assert.fail("no fetch outside a worker") });
  assert.equal(r3.calls.length, 0);                          // inert when loaded as a page script
});

test("main-thread fallback loads the worker through an integrity-checked script element, retrying after a failure", async () => {
  const env = runPage("http://127.0.0.1:8000/index.html");
  const p1 = env.PDFWorker._setupFakeWorkerGlobal;
  assert.equal(typeof p1.then, "function", "PDF.js's loader is replaced");
  assert.strictEqual(env.PDFWorker._setupFakeWorkerGlobal, p1);   // one load while pending
  assert.equal(env.appended.length, 1);
  const s1 = env.appended[0];
  assert.equal(s1.tagName, "SCRIPT");
  assert.equal(s1.src, WORKER_URL);
  assert.equal(s1.attributes.integrity, PINNED[WORKER_URL]);
  assert.equal(s1.attributes.crossorigin, "anonymous");

  s1.onerror();                                              // blocked by SRI (or offline)
  await assert.rejects(p1, /integrity mismatch/);
  assert.equal(env.appended.length, 0, "the failed element is removed");
  await tick();
  const p2 = env.PDFWorker._setupFakeWorkerGlobal;           // a later open retries
  assert.notStrictEqual(p2, p1);
  const s2 = env.appended[0];
  s2.onload();                                               // loaded but no pdfjsWorker global
  await assert.rejects(p2, /did not define pdfjsWorker/);
  await tick();

  const p3 = env.PDFWorker._setupFakeWorkerGlobal;
  const handler = { setup() {} };
  env.win.pdfjsWorker = { WorkerMessageHandler: handler };
  env.appended[env.appended.length - 1].onload();
  assert.strictEqual(await p3, handler);
  const before = env.appended.length;
  assert.strictEqual(await env.PDFWorker._setupFakeWorkerGlobal, handler);   // reused, no new element
  assert.equal(env.appended.length, before);
});

test("the katex.min.css that tools/bundle.py --artifact inlines matches the pinned digest", (t) => {
  const name = KATEX_CSS.replace(/^(https?:)?\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_");
  const file = path.join(ROOT, "tools", ".cache", name);
  if (!fs.existsSync(file)) { t.skip("tools/.cache has no katex.min.css (run python3 -I tools/bundle.py --artifact)"); return; }
  const digest = "sha384-" + crypto.createHash("sha384").update(fs.readFileSync(file)).digest("base64");
  assert.equal(digest, PINNED[KATEX_CSS]);
});
