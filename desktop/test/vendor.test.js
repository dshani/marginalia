"use strict";
// The CDN-tag rewrite and the SRI check (lib/vendor.js), and the download-once cache (scripts/vendor.js) with a
// stand-in fetch: nothing here touches the network.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const v = require("../lib/vendor");
const sv = require("../scripts/vendor");

const REAL_INDEX = path.join(__dirname, "..", "..", "marginalia", "index.html");
const b64 = (alg, s) => alg + "-" + crypto.createHash(alg).update(s).digest("base64");
const WOFF2 = (tag) => Buffer.concat([Buffer.from("wOF2"), Buffer.from(tag)]);

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("sri and sriMatches follow the SRI rules (strongest algorithm given wins)", () => {
  assert.equal(v.sri(Buffer.from("abc")), "sha384-ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn");
  assert.equal(v.sriMatches(Buffer.from("abc"), b64("sha384", "abc")), true);
  assert.equal(v.sriMatches(Buffer.from("abd"), b64("sha384", "abc")), false);
  assert.equal(v.sriMatches(Buffer.from("abc"), b64("sha256", "abc") + " " + b64("sha384", "abc")), true);
  assert.equal(v.sriMatches(Buffer.from("abc"), b64("sha256", "abc") + " " + b64("sha512", "nope")), false);   // sha512 is the strongest given
  assert.equal(v.sriMatches(Buffer.from("abc"), ""), false);
  assert.equal(v.sriMatches(Buffer.from("abc"), "md5-xyz"), false);
});

test("only https from cdnjs, Google Fonts and gstatic may be downloaded", () => {
  for (const ok of ["https://cdnjs.cloudflare.com/ajax/libs/x/1/y.js", "https://fonts.googleapis.com/css2?family=A", "https://fonts.gstatic.com/s/a/v1/b.woff2", "//cdnjs.cloudflare.com/ajax/libs/x/1/y.js"]) {
    assert.doesNotThrow(() => v.checkHost(ok), ok);
  }
  for (const bad of ["http://cdnjs.cloudflare.com/ajax/libs/x/1/y.js", "https://evil.example/x.js", "https://cdnjs.cloudflare.com:444/x",
    "https://user@cdnjs.cloudflare.com/x", "file:///etc/hosts", "nonsense"]) {
    assert.throws(() => v.checkHost(bad), bad);
  }
});

test("local paths mirror the library, version and file, under vendor/", () => {
  assert.equal(v.localPathFor("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"), "vendor/pdf.js/3.11.174/pdf.min.js");
  assert.equal(v.localPathFor("https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/fonts/KaTeX_Main-Regular.woff2"), "vendor/KaTeX/0.16.47/fonts/KaTeX_Main-Regular.woff2");
  assert.equal(v.localPathFor("https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700&display=swap"), "vendor/fonts/outfit.css");
  assert.equal(v.localPathFor("https://fonts.gstatic.com/s/outfit/v14/QGYvz_MVcBeNP4NJtEtq.woff2"), "vendor/fonts/outfit-v14-QGYvz_MVcBeNP4NJtEtq.woff2");
  for (const bad of ["https://cdnjs.cloudflare.com/ajax/libs/x/1/../../etc/passwd", "https://cdnjs.cloudflare.com/other/x.js",
    "https://cdnjs.cloudflare.com/ajax/libs/x/1/y.js?v=2", "https://fonts.googleapis.com/css?family=A"]) {
    assert.throws(() => v.localPathFor(bad), bad);
  }
});

test("the real index.html: five CDN references, rewritten in place, nothing else changed", () => {
  assert.ok(fs.existsSync(REAL_INDEX), "the web app is beside desktop/");
  const html = fs.readFileSync(REAL_INDEX, "utf8");
  const refs = v.remoteRefs(html);
  assert.deepEqual(refs.styles.map((s) => new URL(s.url).hostname), ["fonts.googleapis.com", "cdnjs.cloudflare.com"]);
  assert.equal(refs.styles[0].integrity, null);
  assert.match(refs.styles[1].integrity, /^sha384-/);
  assert.deepEqual(refs.scripts.map((s) => s.url.split("/").pop()), ["pdf.min.js", "katex.min.js"]);
  assert.ok(refs.scripts.every((s) => /^sha384-/.test(s.integrity)));
  assert.equal(refs.worker.url, "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js");
  assert.match(refs.worker.sri, /^sha384-/);
  const map = {};
  for (const r of refs.styles.concat(refs.scripts)) map[r.url] = { path: v.localPathFor(r.url.replace(/&amp;/g, "&")), integrity: r.integrity || "sha384-TEST" };
  const out = v.rewriteIndex(html, map, { path: v.localPathFor(refs.worker.url) });
  assert.deepEqual(v.checkNoRemote(out), []);
  const changed = v.checkOnlyExpectedChanges(html, out);
  assert.equal(changed.length, 5);
  assert.match(out, /var WORKER_URL = new URL\("vendor\/pdf\.js\/3\.11\.174\/pdf\.worker\.min\.js", document\.baseURI\)\.href;/);
  assert.ok(out.includes('var WORKER_SRI = "' + refs.worker.sri + '";'), "WORKER_SRI stays: the worker file is byte for byte");
  assert.match(out, /<script src="vendor\/pdf\.js\/3\.11\.174\/pdf\.min\.js" integrity="sha384-[^"]+" crossorigin="anonymous"><\/script>/);
  assert.match(out, /<link rel="stylesheet" href="vendor\/fonts\/outfit\.css" integrity="sha384-TEST" crossorigin="anonymous">/);
  assert.match(out, /<meta name="marginalia-build" content="local">/);
  assert.deepEqual(v.localIntegrityRefs(out).map((r) => r.path), ["vendor/fonts/outfit.css", "vendor/KaTeX/0.16.47/katex.min.css",
    "vendor/pdf.js/3.11.174/pdf.min.js", "vendor/KaTeX/0.16.47/katex.min.js"]);
});

test("checkOnlyExpectedChanges refuses any other change; checkNoRemote finds leftovers", () => {
  assert.throws(() => v.checkOnlyExpectedChanges("a\nb", "a\nc"), /names no CDN file/);
  assert.throws(() => v.checkOnlyExpectedChanges("a\nb", "a\nb\nc"), /number of lines/);
  assert.ok(v.checkNoRemote('<script src="https://cdnjs.cloudflare.com/x.js"></script>').length > 0);
  assert.ok(v.checkNoRemote('<script>fetch("https://example.com/")</script>').length > 0);
  assert.deepEqual(v.checkNoRemote('<!-- see https://example.com --><script src="js/a.js"></script>'), []);
});

const KATEX_CSS = '.katex{font:normal 1.21em KaTeX_Main}' +
  '@font-face{font-display:block;font-family:KaTeX_AMS;font-style:normal;font-weight:400;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"),url(fonts/KaTeX_AMS-Regular.woff) format("woff"),url(fonts/KaTeX_AMS-Regular.ttf) format("truetype")}' +
  '@font-face{font-display:block;font-family:KaTeX_Main;font-style:normal;font-weight:400;src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),url(fonts/KaTeX_Main-Regular.woff) format("woff"),url(fonts/KaTeX_Main-Regular.ttf) format("truetype")}' +
  '.katex .mord{color:inherit}';

test("katex.min.css keeps only its woff2 sources", () => {
  const r = v.katexWoff2Only(KATEX_CSS);
  assert.deepEqual(r.fonts, ["fonts/KaTeX_AMS-Regular.woff2", "fonts/KaTeX_Main-Regular.woff2"]);
  assert.doesNotMatch(r.css, /\.woff\)|\.ttf/);
  assert.match(r.css, /src:url\(fonts\/KaTeX_AMS-Regular\.woff2\) format\("woff2"\)\}/);
  assert.match(r.css, /^\.katex\{font:normal 1\.21em KaTeX_Main\}/);
  assert.throws(() => v.katexWoff2Only('@font-face{src:url(a.woff) format("woff")}'), /no woff2/);
  assert.throws(() => v.katexWoff2Only(KATEX_CSS + '.x{background:url(img.png)}'), /outside @font-face/);
  assert.throws(() => v.katexWoff2Only('@font-face{src:url(../x.woff2) format("woff2")}'), /unexpected/);
});

const GOOGLE_CSS = "/* latin-ext */\n@font-face {\n  font-family: 'Outfit';\n  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n" +
  "  src: url(https://fonts.gstatic.com/s/outfit/v14/AAA.woff2) format('woff2');\n  unicode-range: U+0100-02BA;\n}\n" +
  "/* latin */\n@font-face {\n  font-family: 'Outfit';\n  font-style: normal;\n  font-weight: 500;\n  font-display: swap;\n" +
  "  src: url(https://fonts.gstatic.com/s/outfit/v14/BBB.woff2) format('woff2');\n  unicode-range: U+0000-00FF;\n}\n";

test("the Google Fonts CSS points at local copies of exactly the woff2 files it names", () => {
  const r = v.googleFontsLocal(GOOGLE_CSS);
  assert.deepEqual(r.files.map((f) => f.path), ["vendor/fonts/outfit-v14-AAA.woff2", "vendor/fonts/outfit-v14-BBB.woff2"]);
  assert.match(r.css, /src: url\(outfit-v14-AAA\.woff2\) format\('woff2'\);/);
  assert.doesNotMatch(r.css, /gstatic/);
  assert.throws(() => v.googleFontsLocal(GOOGLE_CSS + "body{color:red}"), /more than @font-face/);
  assert.throws(() => v.googleFontsLocal(GOOGLE_CSS.replace("fonts.gstatic.com", "evil.example")), /refusing|not a woff2/);
  assert.throws(() => v.googleFontsLocal(GOOGLE_CSS.replace("AAA.woff2", "AAA.ttf")), /woff2/);
});

// A small index.html shaped like the real one, served by a stand-in fetch.
function fixture() {
  const files = {
    "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500&display=swap": Buffer.from(GOOGLE_CSS),
    "https://fonts.gstatic.com/s/outfit/v14/AAA.woff2": WOFF2("A"),
    "https://fonts.gstatic.com/s/outfit/v14/BBB.woff2": WOFF2("B"),
    "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.css": Buffer.from(KATEX_CSS),
    "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/fonts/KaTeX_AMS-Regular.woff2": WOFF2("ams"),
    "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/fonts/KaTeX_Main-Regular.woff2": WOFF2("main"),
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js": Buffer.from("window.pdfjsLib={};"),
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js": Buffer.from("self.worker=1;"),
    "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.js": Buffer.from("window.katex={};")
  };
  const sriOf = (u) => v.sri(files[u]);
  const html = [
    "<!doctype html>", "<head>",
    '  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500&display=swap">',
    '  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.css" integrity="' + sriOf("https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.css") + '" crossorigin="anonymous">',
    '  <link rel="stylesheet" href="styles.css">', "</head>", "<body>",
    '  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" integrity="' + sriOf("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js") + '" crossorigin="anonymous"></script>',
    "  <script>",
    '      var WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";',
    '      var WORKER_SRI = "' + sriOf("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js") + '";',
    "  </script>",
    '  <script src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.js" integrity="' + sriOf("https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.js") + '" crossorigin="anonymous"></script>',
    '  <script src="js/app.js"></script>', "</body>", ""
  ].join("\n");
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, ua: init && init.headers && init.headers["User-Agent"], redirect: init && init.redirect });
    if (!files[url]) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => files[url] };
  };
  return { files, html, fetchFn, calls };
}

test("a download that fails on the network is tried three times in all; an HTTP error is final; the build then says to run it again", async (t) => {
  const dir = tmp(t);
  const f = fixture();
  assert.equal(sv.ATTEMPTS, 3);
  // the first two tries of the first file fail on the network, the third one comes
  let failures = 2;
  const seen = [], logs = [];
  const flaky = async (url, init) => { seen.push(url); if (failures > 0) { failures--; throw new Error("fetch failed"); } return f.fetchFn(url, init); };
  const r = await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "web"), cacheDir: path.join(dir, "cache"), fetchFn: flaky, retryPauseMs: 0, log: (m) => logs.push(m) });
  assert.equal(r.stats.downloaded, 9, "the build went on and got every file");
  assert.equal(seen.filter((u) => u === seen[0]).length, 3, "the first file: two failures, then it came");
  assert.equal(seen.length, 9 + 2, "no other file was asked twice");
  assert.equal(logs.filter((m) => /^download failed \(fetch failed\), trying again: /.test(m)).length, 2);
  // a file that never comes: three tries, then the build stops and says what to do; nothing half-written stays
  let calls = 0;
  const cache2 = path.join(dir, "cache2");
  await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "web2"), cacheDir: cache2, retryPauseMs: 0,
    fetchFn: async () => { calls++; throw new Error("fetch failed"); } }),
  /^Error: could not download \S+: fetch failed \(tried 3 times; run the build again: it keeps the files that it has\)$/);
  assert.equal(calls, 3);
  assert.deepEqual(fs.existsSync(cache2) ? fs.readdirSync(cache2) : [], []);
  // an answer with an HTTP error is final: one try
  let hits = 0;
  await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "web3"), cacheDir: path.join(dir, "cache3"), retryPauseMs: 0,
    fetchFn: async () => { hits++; return { ok: false, status: 404 }; } }), /could not download \S+: HTTP 404$/);
  assert.equal(hits, 1);
  // the files that came before a stop stay: the next build asks only for the rest
  let left = 3, asked = 0;
  const cache4 = path.join(dir, "cache4");
  const stopsAfterThree = async (url, init) => { if (left-- > 0) return f.fetchFn(url, init); throw new Error("fetch failed"); };
  await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "web4"), cacheDir: cache4, retryPauseMs: 0, fetchFn: stopsAfterThree }), /tried 3 times/);
  const again = await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "web5"), cacheDir: cache4, retryPauseMs: 0,
    fetchFn: async (url, init) => { asked++; return f.fetchFn(url, init); } });
  assert.deepEqual([again.stats.cached, again.stats.downloaded, asked], [3, 6, 6]);
});

test("vendorWeb downloads each file once, checks it, writes vendor/ and a local index.html; a second build runs offline", async (t) => {
  const dir = tmp(t);
  const f = fixture();
  const web = path.join(dir, "web"), cache = path.join(dir, "cache");
  const r = await sv.vendorWeb({ html: f.html, webDir: web, cacheDir: cache, fetchFn: f.fetchFn });
  assert.equal(r.stats.downloaded, 9);
  assert.ok(f.calls.every((c) => c.redirect === "error"));
  assert.equal(f.calls.find((c) => c.url.includes("googleapis")).ua, sv.GOOGLE_FONTS_UA);
  fs.writeFileSync(path.join(web, "index.html"), r.html);
  assert.deepEqual(sv.verifyWeb(web), []);
  assert.deepEqual(fs.readdirSync(path.join(web, "vendor", "KaTeX", "0.16.47", "fonts")).sort(), ["KaTeX_AMS-Regular.woff2", "KaTeX_Main-Regular.woff2"]);
  assert.equal(fs.readFileSync(path.join(web, "vendor", "pdf.js", "3.11.174", "pdf.worker.min.js"), "utf8"), "self.worker=1;");
  assert.match(r.html, /href="vendor\/KaTeX\/0\.16\.47\/katex\.min\.css" integrity="sha384-[^"]+"/);
  const offline = await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "web2"), cacheDir: cache,
    fetchFn: async () => { throw new Error("offline"); } });
  assert.equal(offline.stats.downloaded, 0);
  assert.equal(offline.stats.cached, 9);
  assert.equal(offline.html, r.html);
  await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "web3"), cacheDir: path.join(dir, "empty"), offline: true, fetchFn: f.fetchFn }), /offline/);
});

test("a file that does not match its integrity stops the build, also from the cache", async (t) => {
  const dir = tmp(t);
  const f = fixture();
  const bad = Object.assign({}, f.files, { "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js": Buffer.from("tampered") });
  const fetchBad = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => bad[url] });
  await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w"), cacheDir: path.join(dir, "c"), fetchFn: fetchBad }), /does not match the integrity/);
  const cache = path.join(dir, "c2");
  await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w2"), cacheDir: cache, fetchFn: f.fetchFn });
  const cached = path.join(cache, sv.cacheName("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"));
  fs.writeFileSync(cached, "changed on disk");
  await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w3"), cacheDir: cache, fetchFn: f.fetchFn }), /delete it to download it again/);
  const notFont = Object.assign({}, f.files, { "https://fonts.gstatic.com/s/outfit/v14/BBB.woff2": Buffer.from("<html>") });
  await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w4"), cacheDir: path.join(dir, "c4"),
    fetchFn: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => notFont[url] }) }), /not a woff2/);
});

test("verifyWeb catches a vendored file changed after the build and a CSS naming a missing font", async (t) => {
  const dir = tmp(t);
  const f = fixture();
  const web = path.join(dir, "web");
  const r = await sv.vendorWeb({ html: f.html, webDir: web, cacheDir: path.join(dir, "cache"), fetchFn: f.fetchFn });
  fs.writeFileSync(path.join(web, "index.html"), r.html);
  fs.appendFileSync(path.join(web, "vendor", "KaTeX", "0.16.47", "katex.min.js"), "//x");
  fs.rmSync(path.join(web, "vendor", "fonts", "outfit-v14-AAA.woff2"));
  const problems = sv.verifyWeb(web);
  assert.ok(problems.some((p) => /katex\.min\.js does not match/.test(p)), problems.join("; "));
  assert.ok(problems.some((p) => /missing file outfit-v14-AAA\.woff2/.test(p)), problems.join("; "));
});

test("cache names are safe file names", () => {
  assert.equal(sv.cacheName("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"), "cdnjs.cloudflare.com_ajax_libs_pdf.js_3.11.174_pdf.min.js");
  assert.ok(!sv.cacheName("https://fonts.googleapis.com/css2?family=../../x").includes("/"));
  assert.ok(sv.cacheName("https://fonts.gstatic.com/" + "a".repeat(300)).length <= 150);
});

// ---- vendor-lock.json (FEATURES E2.3 e) ------------------------------------------------------------------------------
const lockOf = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the lock: every file pinned on its first download, checked on every build; a second build reads it unchanged", async (t) => {
  const dir = tmp(t);
  const f = fixture();
  const lockFile = path.join(dir, "vendor-lock.json");
  const r = await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w1"), cacheDir: path.join(dir, "cache"), fetchFn: f.fetchFn, lockFile });
  assert.equal(r.lock.pinned, 9);
  assert.equal(r.lock.added.length, 9);
  assert.equal(r.lock.written, true);
  const lock = lockOf(lockFile);
  assert.deepEqual(Object.keys(lock), ["comment", "files"]);
  assert.deepEqual(Object.keys(lock.files), Object.keys(f.files).sort(), "keyed by URL, sorted");
  for (const [url, bytes] of Object.entries(f.files)) assert.equal(lock.files[url], v.sri(bytes, "sha384"), url);
  assert.deepEqual(v.lockProblems(lock), []);
  const text = fs.readFileSync(lockFile, "utf8");
  const again = await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w2"), cacheDir: path.join(dir, "cache"), fetchFn: f.fetchFn, lockFile });
  assert.deepEqual({ added: again.lock.added, removed: again.lock.removed, written: again.lock.written }, { added: [], removed: [], written: false });
  assert.equal(fs.readFileSync(lockFile, "utf8"), text);
  // the cache gone, a new download of the same files: still the same lock
  const fresh = await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w3"), cacheDir: path.join(dir, "cache2"), fetchFn: f.fetchFn, lockFile });
  assert.equal(fresh.stats.downloaded, 9);
  assert.equal(fresh.lock.written, false);
});

test("a download that differs from the lock stops the build and never enters the cache (a font Google changed)", async (t) => {
  const dir = tmp(t);
  const f = fixture();
  const lockFile = path.join(dir, "vendor-lock.json");
  await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w1"), cacheDir: path.join(dir, "cache"), fetchFn: f.fetchFn, lockFile });
  const before = fs.readFileSync(lockFile, "utf8");
  const font = "https://fonts.gstatic.com/s/outfit/v14/BBB.woff2";
  const changed = Object.assign({}, f.files, { [font]: WOFF2("B, version 2") });
  const fetchChanged = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => changed[url] });
  const cache = path.join(dir, "cache-new");
  await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w2"), cacheDir: cache, fetchFn: fetchChanged, lockFile }),
    /BBB\.woff2 does not match vendor-lock\.json .*the download is sha384-.*delete its line from desktop\/vendor-lock\.json/);
  assert.equal(fs.existsSync(path.join(cache, sv.cacheName(font))), false, "the changed file is not cached");
  assert.equal(fs.readFileSync(lockFile, "utf8"), before, "the lock is left as it was");
});

test("a cached file that differs from the lock stops the build and names the file to delete", async (t) => {
  const dir = tmp(t);
  const f = fixture();
  const lockFile = path.join(dir, "vendor-lock.json");
  const cache = path.join(dir, "cache");
  await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w1"), cacheDir: cache, fetchFn: f.fetchFn, lockFile });
  // the Google Fonts CSS has no SRI in index.html: only the lock catches a change to it
  const css = path.join(cache, sv.cacheName("https://fonts.googleapis.com/css2?family=Outfit:wght@400;500&display=swap"));
  fs.writeFileSync(css, GOOGLE_CSS.replace("U+0100-02BA", "U+0100-02BB"));
  await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w2"), cacheDir: cache, fetchFn: f.fetchFn, lockFile }),
    /does not match vendor-lock\.json .*the copy in .*delete it to download it again/);
});

test("a file the build no longer uses leaves the lock; a lock that is not one stops the build", async (t) => {
  const dir = tmp(t);
  const f = fixture();
  const lockFile = path.join(dir, "vendor-lock.json");
  const old = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.46/katex.min.js";
  fs.writeFileSync(lockFile, v.lockText({ [old]: v.sri(Buffer.from("old katex"), "sha384") }));
  const r = await sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w1"), cacheDir: path.join(dir, "cache"), fetchFn: f.fetchFn, lockFile });
  assert.deepEqual(r.lock.removed, [old]);
  assert.equal(r.lock.written, true);
  assert.equal(lockOf(lockFile).files[old], undefined);
  for (const [bad, why] of [["not json", /not valid JSON/], ['{"files": []}', /"files" is not an object/], ['{"files": {}, "extra": 1}', /unknown key "extra"/],
    ['{"files": {"https://evil.example/x.js": "sha384-' + "A".repeat(64) + '"}}', /not a URL the build downloads/],
    ['{"files": {"https://cdnjs.cloudflare.com/ajax/libs/x/1/y.js": "sha256-abc"}}', /not a sha384 hash/]]) {
    fs.writeFileSync(lockFile, bad);
    await assert.rejects(sv.vendorWeb({ html: f.html, webDir: path.join(dir, "w2"), cacheDir: path.join(dir, "cache"), fetchFn: f.fetchFn, lockFile }), why, bad);
  }
});

test("desktop/vendor-lock.json: part of the project, read by every build, and it agrees with index.html's SRI hashes", () => {
  const LOCK = path.join(__dirname, "..", "vendor-lock.json");
  assert.ok(fs.existsSync(LOCK), "desktop/vendor-lock.json exists (npm run app writes it at the first build)");
  const lock = lockOf(LOCK);
  assert.deepEqual(v.lockProblems(lock), []);
  assert.equal(fs.readFileSync(LOCK, "utf8"), v.lockText(lock.files), "written by lockText: sorted, with the comment");
  const refs = v.remoteRefs(fs.readFileSync(REAL_INDEX, "utf8"));
  const pinned = refs.scripts.concat(refs.styles.filter((s) => s.integrity)).map((r) => [r.url.replace(/&amp;/g, "&"), r.integrity])
    .concat([[refs.worker.url, refs.worker.sri]]);
  for (const [url, integrity] of pinned) assert.equal(lock.files[url], integrity, url + ": the lock and index.html pin the same file");
  for (const s of refs.styles) assert.ok(lock.files[s.url.replace(/&amp;/g, "&")], "the lock pins " + s.url);
  const urls = Object.keys(lock.files);
  assert.equal(urls.filter((u) => /\/KaTeX\/0\.16\.47\/fonts\/KaTeX_[A-Za-z0-9-]+\.woff2$/.test(u)).length, 20, "the 20 KaTeX fonts");
  assert.ok(urls.filter((u) => /^https:\/\/fonts\.gstatic\.com\/s\/outfit\//.test(u)).length >= 1, "Outfit's fonts");
  assert.equal(urls.length, pinned.length + 1 + 20 + urls.filter((u) => /fonts\.gstatic\.com/.test(u)).length, "nothing else");
  const build = fs.readFileSync(path.join(__dirname, "..", "scripts", "build.js"), "utf8");
  assert.match(build, /const LOCK_FILE = path\.join\(ROOT, "vendor-lock\.json"\);/);
  assert.match(build, /vendorWeb\(\{ html, webDir: WEB, cacheDir: path\.join\(CACHE, "cdn"\), offline: OFFLINE, lockFile: LOCK_FILE,/);
});
