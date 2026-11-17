"use strict";
// Offline copies of the CDN files index.html loads (pure parts; scripts/vendor.js does the downloads and writes).
//
// The project's index.html loads five things from the network:
//   Google Fonts CSS (Outfit)        fonts.googleapis.com, no integrity attribute; its woff2 files on fonts.gstatic.com
//   katex.min.css 0.16.47            cdnjs, integrity sha384; its fonts in fonts/ beside it
//   pdf.min.js 3.11.174              cdnjs, integrity sha384
//   pdf.worker.min.js 3.11.174       cdnjs, named in the inline worker script (WORKER_URL, checked by WORKER_SRI)
//   katex.min.js 0.16.47             cdnjs, integrity sha384
// The app's copy of index.html gets local files instead (vendor/<library>/<version>/<file>, vendor/fonts/…):
//   - every cdnjs file index.html pins (pdf.min.js, katex.min.js, katex.min.css, and the worker through WORKER_SRI)
//     must match that SRI hash, else the build stops; the KaTeX fonts have no hash in index.html: they are exactly the
//     woff2 files the checked katex.min.css names, each checked to be a woff2 file, and the packaged self-test loads
//     every @font-face (a damaged font fails it);
//   - pdf.min.js, katex.min.js and pdf.worker.min.js stay byte for byte as checked, so their tags keep the same
//     integrity values (WORKER_SRI too) and the browser checks them again at every load;
//   - katex.min.css is rewritten to name only its woff2 fonts (as tools/bundle.py --artifact does; Chromium never
//     asks for the woff and ttf fallbacks), and only those woff2 files are kept; its tag gets the new file's sha384;
//   - the Google Fonts CSS (fetched as Chromium would, so it names woff2 files) must hold nothing but @font-face
//     rules whose fonts are woff2 files on https://fonts.gstatic.com; it is rewritten to the local copies of exactly
//     those files, and its tag gets an integrity attribute (sha384 of the local file);
//   - the worker script's WORKER_URL becomes an absolute URL of the local copy, computed from the page's address
//     (the bootstrap fetches it from inside a blob: worker, where a relative URL would not resolve).
// Nothing else in index.html changes (checkOnlyExpectedChanges).
//
// desktop/vendor-lock.json (FEATURES E2.3 e; part of the project, never ignored) pins the sha384 of every file the
// build downloads for the offline copy: the two stylesheets (as downloaded, before the rewrite above), every font, the
// two scripts and the worker, keyed by the URL each comes from. An entry is written when the build first downloads a
// file (or first reads it from a cache made before the lock existed), and every build checks every file against it,
// from the cache or from the network: a mismatch stops the build (scripts/vendor.js). So the Google Fonts CSS and the
// fonts, which index.html pins with no SRI hash, can never change unnoticed, not even after .cache/ is deleted or on
// another Mac. Entries of files the build no longer uses (an older KaTeX, say) are dropped when the lock is written.
// lockProblems(data) → [problem…] (empty for a good lock); lockText(files) → the file's text (keys sorted).
const crypto = require("node:crypto");

const ALLOWED_HOSTS = Object.freeze(["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"]);
const REMOTE_HOST_RE = /cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/i;
const LINK_RE = /<link\b[^>]*>/gi;
const SCRIPT_TAG_RE = /<script\b[^>]*>/gi;
const WORKER_URL_RE = /var WORKER_URL = "([^"\\]+)";/g;
const WORKER_SRI_RE = /var WORKER_SRI = "([^"\\]+)";/g;
const SRI_ALGS = ["sha512", "sha384", "sha256"];   // strongest first (the SRI spec uses the strongest one given)
const WOFF2_MAGIC = "wOF2";
const LOCK_SRI_RE = /^sha384-[A-Za-z0-9+/]{64}$/;
const LOCK_KEYS = ["comment", "files"];
const LOCK_COMMENT = "The sha384 of every file `npm run app` downloads for the app's offline copy of the web app " +
  "(desktop/scripts/vendor.js), keyed by the URL it comes from. Written when a file is first downloaded; checked on " +
  "every build, from the cache or the network, and a mismatch stops the build. Part of the project: to accept a new " +
  "file on purpose (a CDN that now sends something else), check it, then delete its line and build again.";

// ---- small helpers ----------------------------------------------------------------------------------------------

function attr(tag, name) {
  const m = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))", "i").exec(tag);
  if (!m) return null;
  return (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]).trim();
}

function setAttr(tag, name, value) {
  const re = new RegExp("(\\s" + name + "\\s*=\\s*)(\"[^\"]*\"|'[^']*'|[^\\s\"'=<>`]+)", "i");
  if (re.test(tag)) return tag.replace(re, (all, pre) => pre + "\"" + value + "\"");
  return tag.replace(/\s*\/?>$/, (end) => " " + name + "=\"" + value + "\"" + end);
}

function isRemote(url) {
  return /^(https?:)?\/\//i.test(url || "");
}

function sri(bytes, alg) {
  const a = alg || "sha384";
  return a + "-" + crypto.createHash(a).update(bytes).digest("base64");
}

// sriMatches(bytes, "sha384-… sha512-…"): true when a hash of the strongest algorithm given matches.
function sriMatches(bytes, integrity) {
  const tokens = String(integrity || "").trim().split(/\s+/).filter(Boolean)
    .map((t) => /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)(?:\?.*)?$/.exec(t)).filter(Boolean);
  for (const alg of SRI_ALGS) {
    const own = tokens.filter((m) => m[1] === alg);
    if (own.length) {
      const got = sri(bytes, alg);
      return own.some((m) => m[1] + "-" + m[2] === got);
    }
  }
  return false;
}

function checkHost(url) {
  let u;
  try { u = new URL(url.startsWith("//") ? "https:" + url : url); } catch (e) { throw new Error("not a URL: " + url); }
  if (u.protocol !== "https:" || ALLOWED_HOSTS.indexOf(u.hostname) < 0 || u.username || u.password || u.port) {
    throw new Error("refusing to download from " + url + " (only https from " + ALLOWED_HOSTS.join(", ") + ")");
  }
  return u;
}

function safeSegment(s) {
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") throw new Error("unexpected path segment " + JSON.stringify(s));
  return s;
}

// localPathFor(url) → the path in the app's web folder (always under vendor/).
function localPathFor(url) {
  const u = checkHost(url);
  if (u.hostname === "cdnjs.cloudflare.com") {
    const m = /^\/ajax\/libs\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (!m || u.search) throw new Error("unexpected cdnjs URL " + url);
    return ["vendor", safeSegment(m[1]), safeSegment(m[2])].concat(m[3].split("/").map(safeSegment)).join("/");
  }
  if (u.hostname === "fonts.gstatic.com") {
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs[0] !== "s" || segs.length < 2 || u.search) throw new Error("unexpected fonts.gstatic.com URL " + url);
    return "vendor/fonts/" + segs.slice(1).map(safeSegment).join("-");
  }
  // fonts.googleapis.com/css2?family=Outfit:wght@400;500;700&display=swap → vendor/fonts/outfit.css
  const fam = u.searchParams.get("family");
  if (u.pathname !== "/css2" || !fam) throw new Error("unexpected Google Fonts URL " + url);
  return "vendor/fonts/" + safeSegment(fam.split(":")[0].replace(/\s+/g, "-").toLowerCase()) + ".css";
}

// ---- reading index.html ------------------------------------------------------------------------------------------

// remoteRefs(html) → {styles: [{tag, url, integrity}], scripts: [{tag, url, integrity}], worker: {url, sri}}
function remoteRefs(html) {
  const styles = [], scripts = [];
  for (const tag of html.match(LINK_RE) || []) {
    const rel = (attr(tag, "rel") || "").toLowerCase().split(/\s+/);
    const href = attr(tag, "href");
    if (rel.indexOf("stylesheet") >= 0 && isRemote(href)) styles.push({ tag, url: href, integrity: attr(tag, "integrity") });
    else if (isRemote(href)) throw new Error("index.html links to " + href + " (not a stylesheet): the build does not know how to vendor it");
  }
  for (const tag of html.match(SCRIPT_TAG_RE) || []) {
    const src = attr(tag, "src");
    if (isRemote(src)) scripts.push({ tag, url: src, integrity: attr(tag, "integrity") });
  }
  const urls = [...html.matchAll(WORKER_URL_RE)], sris = [...html.matchAll(WORKER_SRI_RE)];
  if (urls.length !== 1 || sris.length !== 1) throw new Error("index.html must set WORKER_URL and WORKER_SRI exactly once each (found " + urls.length + " and " + sris.length + ")");
  return { styles, scripts, worker: { url: urls[0][1], sri: sris[0][1], line: urls[0][0] } };
}

// ---- CSS ---------------------------------------------------------------------------------------------------------

const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/gi;
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

// katex.min.css → {css, fonts}: every @font-face keeps only its woff2 source; fonts = the relative woff2 paths.
function katexWoff2Only(css) {
  const fonts = [];
  const out = css.replace(FONT_FACE_RE, (face) => face.replace(/src\s*:[^;}]*/i, (decl) => {
    const m = /url\(\s*(['"]?)([^'")]+?\.woff2)\1\s*\)\s*format\(\s*(['"])woff2\3\s*\)/i.exec(decl);
    if (!m) throw new Error("a KaTeX @font-face has no woff2 source: " + decl.slice(0, 120));
    const rel = m[2];
    if (isRemote(rel) || /^(data:|\/)/i.test(rel) || rel.split("/").some((s) => s === "..")) throw new Error("unexpected KaTeX font URL " + rel);
    if (fonts.indexOf(rel) < 0) fonts.push(rel);
    return "src:url(" + rel + ") format(\"woff2\")";
  }));
  const outside = out.replace(FONT_FACE_RE, "");
  const stray = outside.match(URL_RE);
  if (stray) throw new Error("katex.min.css has url() outside @font-face, which the build does not vendor: " + stray[0]);
  if (!fonts.length) throw new Error("katex.min.css names no fonts");
  return { css: out, fonts };
}

// The Google Fonts CSS → {css, files: [{url, path}]} with url(<local file name>) in place of each fonts.gstatic.com URL.
function googleFontsLocal(css) {
  const rest = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(FONT_FACE_RE, "").trim();
  if (rest) throw new Error("the Google Fonts CSS holds more than @font-face rules: " + rest.slice(0, 120));
  const files = [];
  const out = css.replace(FONT_FACE_RE, (face) => {
    let n = 0;
    const f = face.replace(URL_RE, (all, q, url) => {
      n++;
      const u = checkHost(url);
      if (u.hostname !== "fonts.gstatic.com" || !/\.woff2$/i.test(u.pathname)) throw new Error("the Google Fonts CSS names " + url + ", not a woff2 file on fonts.gstatic.com");
      const local = localPathFor(url);
      if (!files.some((x) => x.url === url)) files.push({ url, path: local });
      return "url(" + local.split("/").pop() + ")";
    });
    if (n !== 1) throw new Error("a Google Fonts @font-face names " + n + " files (expected 1)");
    if (!/format\(\s*['"]woff2['"]\s*\)/i.test(f)) throw new Error("a Google Fonts @font-face is not woff2");
    return f;
  });
  if (!files.length) throw new Error("the Google Fonts CSS names no fonts");
  return { css: out, files };
}

function isWoff2(bytes) {
  return !!bytes && bytes.length > 4 && Buffer.from(bytes.subarray(0, 4)).toString("latin1") === WOFF2_MAGIC;
}

// ---- writing index.html ------------------------------------------------------------------------------------------

// rewriteIndex(html, map, worker) → html with each remote href/src replaced by map[url].path and its integrity by
// map[url].integrity (crossorigin kept); worker = {path} for WORKER_URL.
function rewriteIndex(html, map, worker) {
  const swap = (tag, name) => {
    const url = attr(tag, name);
    if (!isRemote(url)) return tag;
    const to = map[url];
    if (!to) throw new Error("no local copy for " + url);
    let t = setAttr(tag, name, to.path);
    t = setAttr(t, "integrity", to.integrity);
    if (!attr(t, "crossorigin")) t = setAttr(t, "crossorigin", "anonymous");
    return t;
  };
  let out = html.replace(LINK_RE, (tag) => swap(tag, "href"));
  out = out.replace(SCRIPT_TAG_RE, (tag) => swap(tag, "src"));
  const refs = [...out.matchAll(WORKER_URL_RE)];
  if (refs.length !== 1) throw new Error("WORKER_URL not found once");
  out = out.replace(WORKER_URL_RE, () => "var WORKER_URL = new URL(" + JSON.stringify(worker.path) + ", document.baseURI).href;");
  return out;
}

// Every line that differs must be one that held a remote URL; nothing else in index.html may change.
function checkOnlyExpectedChanges(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length !== b.length) throw new Error("the rewrite changed the number of lines in index.html");
  const changed = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!REMOTE_HOST_RE.test(a[i])) throw new Error("the rewrite changed line " + (i + 1) + ", which names no CDN file");
    changed.push(i + 1);
  }
  return changed;
}

// What must hold for the app's index.html: no CDN host anywhere, every stylesheet and script local.
function checkNoRemote(html) {
  const problems = [];
  const host = REMOTE_HOST_RE.exec(html);
  if (host) problems.push("index.html still names " + host[0]);
  for (const tag of html.match(LINK_RE) || []) if (isRemote(attr(tag, "href"))) problems.push("remote link " + attr(tag, "href"));
  for (const tag of html.match(SCRIPT_TAG_RE) || []) if (isRemote(attr(tag, "src"))) problems.push("remote script " + attr(tag, "src"));
  if (/https?:\/\//i.test(html.replace(/<!--[\s\S]*?-->/g, ""))) problems.push("index.html holds an http(s) URL outside comments");
  return problems;
}

// [{path, integrity}] for every local stylesheet and script tag that carries an integrity attribute.
function localIntegrityRefs(html) {
  const out = [];
  for (const tag of (html.match(LINK_RE) || []).concat(html.match(SCRIPT_TAG_RE) || [])) {
    const ref = attr(tag, "href") || attr(tag, "src");
    const integrity = attr(tag, "integrity");
    if (ref && integrity && !isRemote(ref)) out.push({ path: ref, integrity });
  }
  return out;
}

// ---- vendor-lock.json ----------------------------------------------------------------------------------------------

// lockProblems(data) → what is wrong with a parsed vendor-lock.json: {comment?: string, files: {<https URL on an
// allowed host>: "sha384-<64 base64 characters>"}} and nothing else.
function lockProblems(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["it is not a JSON object"];
  const problems = [];
  for (const k of Object.keys(data)) if (LOCK_KEYS.indexOf(k) < 0) problems.push("unknown key " + JSON.stringify(k));
  if (data.comment !== undefined && typeof data.comment !== "string") problems.push("\"comment\" is not a string");
  const files = data.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) { problems.push("\"files\" is not an object"); return problems; }
  for (const [url, hash] of Object.entries(files)) {
    try { checkHost(url); } catch (e) { problems.push("not a URL the build downloads: " + url.slice(0, 200)); continue; }
    if (typeof hash !== "string" || !LOCK_SRI_RE.test(hash)) problems.push(url + " is pinned to " + JSON.stringify(hash).slice(0, 120) + ", not a sha384 hash");
  }
  return problems;
}

// lockText(files) → the text of vendor-lock.json: the comment, then the files with their URLs sorted.
function lockText(files) {
  const sorted = {};
  for (const url of Object.keys(files || {}).sort()) sorted[url] = files[url];
  return JSON.stringify({ comment: LOCK_COMMENT, files: sorted }, null, 2) + "\n";
}

module.exports = {
  ALLOWED_HOSTS, attr, setAttr, isRemote, sri, sriMatches, checkHost, localPathFor, remoteRefs, katexWoff2Only,
  googleFontsLocal, isWoff2, rewriteIndex, checkOnlyExpectedChanges, checkNoRemote, localIntegrityRefs,
  lockProblems, lockText, LOCK_COMMENT, LOCK_SRI_RE
};
