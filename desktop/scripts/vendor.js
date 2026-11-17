"use strict";
// Downloads (once) and writes the offline copies of index.html's CDN files; the rules are in lib/vendor.js.
// Every download lands in desktop/.cache/cdn/<a safe name made from the URL> and is reused from there, so a second
// build needs no network. A cached file that fails its check stops the build (delete that file to download it again).
// With lockFile (scripts/build.js always passes desktop/vendor-lock.json) every file, from the cache or the network,
// must match the sha384 the lock pins for its URL; a URL the lock does not name yet is pinned (TOFU: trust on first
// use, as the cache always was), a download that does not match never enters the cache, and the lock is written once
// the whole vendoring succeeded, with exactly the URLs this build used.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const v = require("../lib/vendor");

// Google Fonts sends woff2 files (in unicode-range subsets) only to a browser it recognises.
const GOOGLE_FONTS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const USER_AGENT = "marginalia-desktop-build/1.0";
const TIMEOUT_MS = 60000;
const ATTEMPTS = 3;            // a download that fails on the network (no answer, a reset, a timeout) is tried this often
const RETRY_PAUSE_MS = 1500;   // the wait before the second try; twice that before the third

function cacheName(url) {
  let name = url.replace(/^(https?:)?\/\//i, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "");
  if (name.length > 150) {
    const digest = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    name = name.slice(0, 80) + "_" + digest + "_" + name.slice(-50);
  }
  return name || "download";
}

function htmlUrl(raw) {
  return raw.replace(/&amp;/g, "&");
}

// makeFetcher({cacheDir, fetchFn?, offline?, log?, verify?, retryPauseMs?}): verify(url, bytes, {cached, file}) runs on
// every file before it is used (and, for a download, before it is cached); it throws to stop the build. A download that
// fails on the network is tried ATTEMPTS times in all (retryPauseMs: the wait between tries, for the tests); an HTTP
// error answer is final. The files that came stay in the cache, so a build that stopped goes on where it was.
function makeFetcher(o) {
  const cacheDir = o.cacheDir;
  const fetchFn = o.fetchFn || globalThis.fetch;
  const log = o.log || (() => {});
  const verify = typeof o.verify === "function" ? o.verify : () => {};
  const stats = { downloaded: 0, cached: 0 };
  const pauseMs = typeof o.retryPauseMs === "number" && o.retryPauseMs >= 0 ? o.retryPauseMs : RETRY_PAUSE_MS;
  async function get(url, extraHeaders) {
    v.checkHost(url);
    const file = path.join(cacheDir, cacheName(url));
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      verify(url, bytes, { cached: true, file });
      stats.cached++;
      return { bytes, file };
    }
    if (o.offline) throw new Error("not in the cache, and the build runs offline: " + url);
    log("downloading " + url);
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetchFn(url, { headers: Object.assign({ "User-Agent": USER_AGENT }, extraHeaders || {}), redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS) });
        break;
      } catch (e) {
        const why = (e && e.message) || "no answer";
        if (attempt >= ATTEMPTS) {
          throw new Error("could not download " + url + ": " + why + " (tried " + ATTEMPTS + " times; run the build again: it keeps the files that it has)");
        }
        log("download failed (" + why + "), trying again: " + url);
        await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
      }
    }
    if (!res.ok) throw new Error("could not download " + url + ": HTTP " + res.status);
    const bytes = Buffer.from(await res.arrayBuffer());
    verify(url, bytes, { cached: false, file });
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = file + ".part";
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    stats.downloaded++;
    return { bytes, file };
  }
  return { get, stats };
}

// ---- vendor-lock.json ----------------------------------------------------------------------------------------------

// readLock(file) → {file, files: {url: sha384}, used: Set, added: [], existed}; a missing file is an empty lock, any
// other problem (unreadable, not JSON, not a lock) stops the build.
function readLock(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e && e.code === "ENOENT") return { file, files: {}, used: new Set(), added: [], existed: false };
    throw new Error(path.basename(file) + " cannot be read: " + (e && e.message));
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(path.basename(file) + " is not valid JSON (" + e.message + "): fix it, or delete it to pin every file again"); }
  const problems = v.lockProblems(data);
  if (problems.length) throw new Error(path.basename(file) + " is not a lock file this build reads: " + problems.slice(0, 5).join("; "));
  return { file, files: Object.assign({}, data.files), used: new Set(), added: [], existed: true };
}

// The check every file goes through: pinned → it must match; not pinned yet → pinned now.
function lockVerifier(lock) {
  return (url, bytes, where) => {
    lock.used.add(url);
    const want = lock.files[url];
    const got = v.sri(bytes, "sha384");
    if (want === undefined) { lock.files[url] = got; lock.added.push(url); return; }
    if (want === got) return;
    const name = path.basename(lock.file);
    if (where && where.cached) {
      throw new Error(url + " does not match " + name + " (it pins " + want + "; the copy in " + where.file + " is " + got + "). " +
        "That cached file is not the one this project pinned: delete it to download it again.");
    }
    throw new Error(url + " does not match " + name + " (it pins " + want + "; the download is " + got + "). The CDN now sends " +
      "another file than the one this project pinned, so the build stops. If that is expected, check the new file, then " +
      "delete its line from desktop/" + name + " and build again.");
  };
}

// Writes the lock when this build pinned a new URL or no longer uses one; → {file, pinned, added, removed, written}.
function finishLock(lock) {
  const removed = Object.keys(lock.files).filter((u) => !lock.used.has(u));
  for (const u of removed) delete lock.files[u];
  const written = !lock.existed || lock.added.length > 0 || removed.length > 0;
  if (written) {
    const tmp = lock.file + ".tmp";
    fs.writeFileSync(tmp, v.lockText(lock.files));
    fs.renameSync(tmp, lock.file);
  }
  return { file: lock.file, pinned: Object.keys(lock.files).length, added: lock.added.slice(), removed, written };
}

// vendorWeb({html, webDir, cacheDir, fetchFn?, offline?, log?, lockFile?}) → {html, files: [{path, bytes}], stats, lock}
// (lock: finishLock's answer, or null without lockFile)
async function vendorWeb(o) {
  const html = o.html;
  const lock = o.lockFile ? readLock(o.lockFile) : null;
  const net = makeFetcher(Object.assign({}, o, { verify: lock ? lockVerifier(lock) : null }));
  const refs = v.remoteRefs(html);
  const map = {};
  const files = [];
  const write = (rel, bytes) => {
    if (!/^vendor\//.test(rel) || rel.split("/").some((s) => s === ".." || s === "")) throw new Error("bad vendor path " + rel);
    const dest = path.join(o.webDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    files.push({ path: rel, bytes: bytes.length });
  };
  const checked = async (url, integrity, what) => {
    if (!integrity) throw new Error(what + " " + url + " has no integrity attribute in index.html");
    const { bytes, file } = await net.get(url);
    if (!v.sriMatches(bytes, integrity)) {
      throw new Error(url + " does not match the integrity " + integrity + " that index.html names (got " + v.sri(bytes) +
        "). The file in " + file + " is not the one index.html pins; delete it to download it again.");
    }
    return bytes;
  };
  const woff2 = async (url) => {
    const { bytes, file } = await net.get(url);
    if (!v.isWoff2(bytes)) throw new Error(url + " is not a woff2 font (" + file + ")");
    return bytes;
  };

  for (const s of refs.scripts) {
    const url = htmlUrl(s.url);
    const bytes = await checked(url, s.integrity, "the script");
    const rel = v.localPathFor(url);
    write(rel, bytes);
    map[s.url] = { path: rel, integrity: s.integrity };           // byte for byte: the same integrity
  }
  for (const st of refs.styles) {
    const url = htmlUrl(st.url);
    const host = new URL(url).hostname;
    const rel = v.localPathFor(url);
    let css;
    if (host === "cdnjs.cloudflare.com") {
      const bytes = await checked(url, st.integrity, "the stylesheet");
      const r = v.katexWoff2Only(bytes.toString("utf8"));
      const dir = rel.split("/").slice(0, -1).join("/");
      for (const f of r.fonts) {
        const fontUrl = new URL(f, url).href;
        const fontRel = v.localPathFor(fontUrl);
        if (fontRel !== dir + "/" + f) throw new Error("unexpected font path " + f);
        write(fontRel, await woff2(fontUrl));
      }
      css = r.css;
    } else if (host === "fonts.googleapis.com") {
      const { bytes } = await net.get(url, { "User-Agent": GOOGLE_FONTS_UA });
      const r = v.googleFontsLocal(bytes.toString("utf8"));
      for (const f of r.files) write(f.path, await woff2(f.url));
      css = r.css;
    } else {
      throw new Error("index.html loads a stylesheet from " + host + ", which the build does not vendor");
    }
    const out = Buffer.from(css, "utf8");
    write(rel, out);
    map[st.url] = { path: rel, integrity: v.sri(out) };
  }
  const wurl = refs.worker.url;
  const wbytes = await checked(wurl, refs.worker.sri, "the PDF.js worker");
  const wrel = v.localPathFor(wurl);
  write(wrel, wbytes);
  const out = v.rewriteIndex(html, map, { path: wrel });
  v.checkOnlyExpectedChanges(html, out);
  const problems = v.checkNoRemote(out);
  if (problems.length) throw new Error("the app's index.html still loads from the network: " + problems.join("; "));
  return { html: out, files, stats: net.stats, lock: lock ? finishLock(lock) : null };
}

// Every local file index.html pins with an integrity attribute matches it, and every url() in the vendored CSS
// names a file that exists. Returns a list of problems (empty when all is well).
function verifyWeb(webDir) {
  const problems = [];
  const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  problems.push(...v.checkNoRemote(html));
  for (const ref of v.localIntegrityRefs(html)) {
    const file = path.join(webDir, ...ref.path.split("/"));
    if (!fs.existsSync(file)) { problems.push("missing " + ref.path); continue; }
    if (!v.sriMatches(fs.readFileSync(file), ref.integrity)) problems.push(ref.path + " does not match its integrity attribute");
  }
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const vendorDir = path.join(webDir, "vendor");
  for (const file of fs.existsSync(vendorDir) ? walk(vendorDir) : []) {
    if (!file.endsWith(".css")) continue;
    const css = fs.readFileSync(file, "utf8");
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      if (v.isRemote(m[2]) || /^data:/i.test(m[2])) { problems.push(path.relative(webDir, file) + " names " + m[2]); continue; }
      if (!fs.existsSync(path.resolve(path.dirname(file), m[2]))) problems.push(path.relative(webDir, file) + " names a missing file " + m[2]);
    }
  }
  return problems;
}

module.exports = { vendorWeb, verifyWeb, makeFetcher, cacheName, readLock, lockVerifier, finishLock, GOOGLE_FONTS_UA, ATTEMPTS };
