#!/usr/bin/env node
"use strict";
// npm run app — builds Marginalia.app from the current web app, in one step:
//   1. copies the web app from ../marginalia into build/web: index.html, styles.css, css/, js/, tools/serve.py and
//      test/sample.pdf (the library's "Open sample PDF" on 127.0.0.1 loads it); never the tests, docs, dist/ or caches
//   2. vendors the CDN files into build/web/vendor and rewrites the copy of index.html to them (lib/vendor.js);
//      downloads go to .cache/cdn once and are reused offline; every file must match the sha384 vendor-lock.json pins
//      for its URL (a new URL is pinned there; a mismatch stops the build)
//   3. stages the app code (main.js, preload.js, the runtime lib/ modules, a minimal package.json) in build/app
//   4. draws the icon (lib/icon.js) and makes build/icon/Marginalia.icns with iconutil
//   5. packages out/Marginalia-darwin-arm64/Marginalia.app with @electron/packager (Electron from .cache/electron,
//      checked against the electron package's checksums.json), turns the Electron fuses off (lib in the hook below)
//      and signs it (lib/signing.js): ad hoc by default; else with the identity in MARGINALIA_SIGN_IDENTITY or, when
//      that is not set, the first non-empty line of desktop/sign-identity; the hardened runtime only for a
//      "Developer ID Application: …" identity (a self-made certificate has no Team ID: it is signed without it)
// MARGINALIA_OFFLINE=1 downloads nothing: the CDN files must be in .cache/cdn and Electron's zip in .cache/electron
// (checked before step 1, since @electron/packager would otherwise download a missing Electron).
//   6. checks the result (Info.plist, fuses, signature, web files)
//   7. runs the packaged app's self-test (scripts/selftest.js)
// It never installs anything into /Applications and never starts the app without --self-test.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { vendorWeb, verifyWeb } = require("./vendor");
const icon = require("../lib/icon");
const signing = require("../lib/signing");
const { appVersionOk } = require("../lib/server");

const ROOT = path.resolve(__dirname, "..");
const PROJECT_WEB = path.resolve(ROOT, "..", "marginalia");
const BUILD = path.join(ROOT, "build");
const WEB = path.join(BUILD, "web");
const STAGE = path.join(BUILD, "app");
const ICON_DIR = path.join(BUILD, "icon");
const TMP = path.join(BUILD, "tmp");
const OUT = path.join(ROOT, "out");
const CACHE = path.join(ROOT, ".cache");
const LOCK_FILE = path.join(ROOT, "vendor-lock.json");          // part of the project (not ignored): FEATURES E2.3 e
const SIGN_IDENTITY_FILE = path.join(ROOT, signing.FILE_NAME);   // a certificate's name, ignored by git: E2.3 d
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ELECTRON_PKG = path.join(ROOT, "node_modules", "electron");
const BUNDLE_ID = "local.marginalia.desktop";
const APP_NAME = "Marginalia";
const RUNTIME_LIB = ["args.js", "contextmenu.js", "hash.js", "lifecycle.js", "menu.js", "policy.js", "python.js", "rotatelog.js", "selftest.js",
  "server.js", "windowstate.js"];
const OFFLINE = process.env.MARGINALIA_OFFLINE === "1";
const WEB_FILES = ["index.html", "styles.css", "tools/serve.py", "test/sample.pdf"];   // plus css/*.css and js/*.js
const FUSES = {   // @electron/fuses FuseV1Options: what this app turns off and on
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
  EnableCookieEncryption: false
};

function say(text) { process.stdout.write("[build] " + text + "\n"); }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copy(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }

// ---- 1. the web app ----------------------------------------------------------------------------------------------
function copyWeb() {
  if (!fs.existsSync(path.join(PROJECT_WEB, "index.html"))) throw new Error("no web app at " + PROJECT_WEB);
  rmrf(WEB);
  fs.mkdirSync(WEB, { recursive: true });
  const copied = [];
  for (const rel of WEB_FILES) {
    const from = path.join(PROJECT_WEB, rel);
    if (!fs.existsSync(from)) { if (rel === "styles.css") continue; throw new Error("missing " + from); }
    if (rel !== "index.html") { copy(from, path.join(WEB, rel)); copied.push(rel); }
  }
  for (const [dir, ext] of [["css", ".css"], ["js", ".js"]]) {
    for (const e of fs.readdirSync(path.join(PROJECT_WEB, dir), { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith(".") || !e.name.endsWith(ext)) continue;
      copy(path.join(PROJECT_WEB, dir, e.name), path.join(WEB, dir, e.name));
      copied.push(dir + "/" + e.name);
    }
  }
  return copied;
}

// Every local stylesheet and script index.html names must be in the copy.
function localRefs(html) {
  const refs = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const href = /\shref\s*=\s*"([^"]+)"/i.exec(tag);
    if (href && !/^(https?:)?\/\//i.test(href[1])) refs.push(href[1]);
  }
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) {
    const src = /\ssrc\s*=\s*"([^"]+)"/i.exec(tag);
    if (src && !/^(https?:)?\/\//i.test(src[1])) refs.push(src[1]);
  }
  return refs;
}

// ---- 3. the app code ---------------------------------------------------------------------------------------------
function stageApp() {
  rmrf(STAGE);
  copy(path.join(ROOT, "main.js"), path.join(STAGE, "main.js"));
  copy(path.join(ROOT, "preload.js"), path.join(STAGE, "preload.js"));
  for (const f of RUNTIME_LIB) copy(path.join(ROOT, "lib", f), path.join(STAGE, "lib", f));
  const pkg = { name: "marginalia", productName: APP_NAME, version: PKG.version, description: PKG.description,
    private: true, license: PKG.license, main: "main.js" };
  fs.writeFileSync(path.join(STAGE, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

// ---- 4. the icon -------------------------------------------------------------------------------------------------
function makeIcon() {
  rmrf(ICON_DIR);
  const set = path.join(ICON_DIR, APP_NAME + ".iconset");
  fs.mkdirSync(set, { recursive: true });
  const memo = new Map();
  for (const [name, size] of icon.ICONSET) {
    if (!memo.has(size)) memo.set(size, icon.encodePng(size, icon.render(size)));
    fs.writeFileSync(path.join(set, name), memo.get(size));
  }
  const icns = path.join(ICON_DIR, APP_NAME + ".icns");
  execFileSync("/usr/bin/iconutil", ["-c", "icns", "-o", icns, set], { stdio: "inherit" });
  return icns;
}

// ---- 5. packaging, fuses, signing --------------------------------------------------------------------------------
function electronVersion() {
  return JSON.parse(fs.readFileSync(path.join(ELECTRON_PKG, "package.json"), "utf8")).version;
}

// The cached Electron zip @electron/get would use (<cacheRoot>/<sha256 of the download folder's URL>/<zip>), or null.
function cachedElectronZip(cacheRoot, version) {
  const name = "electron-v" + version + "-darwin-arm64.zip";
  let dirs = [];
  try { dirs = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (e) { return null; }
  for (const d of dirs) {
    const f = path.join(cacheRoot, d.name, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function checkOfflineElectron(cacheRoot, version) {
  if (cachedElectronZip(cacheRoot, version)) return;
  throw new Error("electron-v" + version + "-darwin-arm64.zip is not in " + cacheRoot + ", and the build runs offline " +
    "(MARGINALIA_OFFLINE=1): run `npm run app` once with the network to download it");
}

async function flipFuses(appPath) {
  const fuses = await import("@electron/fuses");
  const cfg = { version: fuses.FuseVersion.V1, strictlyRequireAllFuses: false };
  for (const [name, on] of Object.entries(FUSES)) cfg[fuses.FuseV1Options[name]] = on;
  await fuses.flipFuses(appPath, cfg);
}

async function readFuses(appPath) {
  const fuses = await import("@electron/fuses");
  const wire = await fuses.getCurrentFuseWire(appPath);
  const out = {};
  for (const name of Object.keys(FUSES)) {
    const s = wire[fuses.FuseV1Options[name]];
    out[name] = s === fuses.FuseState.ENABLE ? true : s === fuses.FuseState.DISABLE ? false : "state " + s;
  }
  return out;
}

// The signing identity and its rules (lib/signing.js): MARGINALIA_SIGN_IDENTITY, else desktop/sign-identity, else ad hoc.
function signingIdentity() {
  return signing.resolveIdentity({ env: process.env, file: SIGN_IDENTITY_FILE, readFile: (f) => fs.readFileSync(f, "utf8") });
}

// osxSign's options for an identity: the hardened runtime and the keychain look-up only for a Developer ID; the app
// bundle gets entitlements.plist, the helpers osx-sign's own defaults; no timestamp (nothing is notarized).
function osxSignOptions(sign, entitlements) {
  return {
    identity: sign.identity,
    identityValidation: sign.identityValidation,
    continueOnError: false,
    optionsForFile: (filePath) => ({
      hardenedRuntime: sign.hardenedRuntime,
      timestamp: "none",
      entitlements: filePath.endsWith(APP_NAME + ".app") ? entitlements : undefined
    })
  };
}

async function packageApp(icns, sign) {
  const { packager } = await import("@electron/packager");
  const version = electronVersion();
  const checksums = JSON.parse(fs.readFileSync(path.join(ELECTRON_PKG, "checksums.json"), "utf8"));
  const entitlements = path.join(ROOT, "entitlements.plist");
  fs.mkdirSync(TMP, { recursive: true });
  say("packaging with Electron " + version + "; " + signing.describe(sign));
  const paths = await packager({
    dir: STAGE,
    out: OUT,
    overwrite: true,
    platform: "darwin",
    arch: "arm64",
    electronVersion: version,
    name: APP_NAME,
    executableName: APP_NAME,
    appBundleId: BUNDLE_ID,
    appVersion: PKG.version,
    buildVersion: PKG.version,
    appCategoryType: "public.app-category.education",
    icon: icns,
    asar: true,
    prune: true,
    junk: true,
    extraResource: [WEB],
    protocols: [{ name: "Marginalia link", schemes: ["marginalia"] }],
    download: { cacheRoot: path.join(CACHE, "electron"), checksums, tempDirectory: TMP },
    tmpdir: TMP,
    afterCopyExtraResources: [async ({ buildPath }) => {
      const appPath = path.join(buildPath, APP_NAME + ".app");
      await flipFuses(appPath);
      say("fuses set: " + JSON.stringify(await readFuses(appPath)));
    }],
    osxSign: osxSignOptions(sign, entitlements)
  });
  rmrf(TMP);                                            // the packager's and the download's temp folders
  if (!paths || paths.length !== 1) throw new Error("packager made " + (paths ? paths.length : 0) + " apps");
  return path.join(paths[0], APP_NAME + ".app");
}

// ---- 6. checks ---------------------------------------------------------------------------------------------------
function plist(file) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
}

// What `codesign -dv` says about a signature: {signature: "adhoc" | the first Authority, runtime: hardened runtime on}.
function signatureInfo(stderr) {
  const text = String(stderr || "");
  const flags = (/^CodeDirectory\b.*\bflags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text) || [])[1] || "";
  const signature = (/^Signature=(.+)$/m.exec(text) || [])[1] || (/^Authority=(.+)$/m.exec(text) || [])[1] || "";
  return { signature, runtime: flags.split(",").map((f) => f.trim()).includes("runtime"), flags };
}

async function checkApp(appPath, sign) {
  const problems = [];
  const info = plist(path.join(appPath, "Contents", "Info.plist"));
  if (info.CFBundleIdentifier !== BUNDLE_ID) problems.push("bundle id " + info.CFBundleIdentifier);
  if (info.CFBundleName !== APP_NAME) problems.push("bundle name " + info.CFBundleName);
  const schemes = (info.CFBundleURLTypes || []).flatMap((t) => t.CFBundleURLSchemes || []);
  if (JSON.stringify(schemes) !== JSON.stringify(["marginalia"])) problems.push("URL schemes " + JSON.stringify(schemes));
  if (!info.ElectronAsarIntegrity || !info.ElectronAsarIntegrity["Resources/app.asar"]) problems.push("no ElectronAsarIntegrity for app.asar");
  const fuses = await readFuses(appPath);
  for (const [name, want] of Object.entries(FUSES)) if (fuses[name] !== want) problems.push("fuse " + name + " is " + fuses[name]);
  try {
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
  } catch (e) { problems.push("codesign --verify failed: " + String(e.stderr || e.message).trim()); }
  const shown = spawnSync("/usr/bin/codesign", ["-dv", appPath], { encoding: "utf8" });   // codesign -dv writes to stderr
  const sig = signatureInfo(shown.stderr);
  const signature = sig.signature;
  if (sign) {
    if (sign.kind === "ad-hoc" && signature !== "adhoc") problems.push("signed with " + JSON.stringify(signature) + ", not ad hoc");
    // codesign takes a unique part of a certificate's name, or its SHA-1 hash: the leaf's name holds the part given
    const byHash = /^[0-9A-Fa-f]{40}$/.test(sign.identity);
    if (sign.kind !== "ad-hoc" && (!signature || signature === "adhoc" || (!byHash && signature.indexOf(sign.identity) < 0))) {
      problems.push("signed by " + JSON.stringify(signature || "nothing") + ", not by " + JSON.stringify(sign.identity));
    }
    if (sig.runtime !== sign.hardenedRuntime) problems.push("the hardened runtime is " + (sig.runtime ? "on" : "off") + " (flags " + sig.flags + "); it must be " + (sign.hardenedRuntime ? "on" : "off"));
  }
  const web = path.join(appPath, "Contents", "Resources", "web");
  for (const rel of ["index.html", "tools/serve.py", "test/sample.pdf", "js/app.js"]) {
    if (!fs.existsSync(path.join(web, rel))) problems.push("missing web/" + rel);
  }
  for (const p of verifyWeb(web)) problems.push("web: " + p);
  if (fs.existsSync(path.join(appPath, "Contents", "Resources", "app"))) problems.push("an unpacked Resources/app folder exists");
  if (info.CFBundleShortVersionString !== PKG.version) problems.push("version " + info.CFBundleShortVersionString + ", not " + PKG.version);
  return { problems, info, fuses, signature, runtime: sig.runtime };
}

// ---- main ----------------------------------------------------------------------------------------------------------
// desktop/package.json's version is the app's version, which main.js passes to serve.py as --app <version>.
function checkVersion(version) {
  if (!appVersionOk(version)) {
    throw new Error("desktop/package.json's version must be digits.digits.digits, such as 1.0.0 (the app passes it to serve.py as " +
      "--app, which takes nothing else); it is " + JSON.stringify(version));
  }
  return version;
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("this build makes the arm64 Mac app and runs on an arm64 Mac");
  const t0 = Date.now();
  checkVersion(PKG.version);
  const sign = signingIdentity();                      // before anything is built: a bad sign-identity stops it at once
  if (OFFLINE) checkOfflineElectron(path.join(CACHE, "electron"), electronVersion());
  say("1/7 copying the web app from " + PROJECT_WEB);
  const copied = copyWeb();
  say("    " + copied.length + " files");
  say("2/7 vendoring the CDN files (cache: " + path.relative(ROOT, path.join(CACHE, "cdn")) + ")");
  const html = fs.readFileSync(path.join(PROJECT_WEB, "index.html"), "utf8");
  const vendored = await vendorWeb({ html, webDir: WEB, cacheDir: path.join(CACHE, "cdn"), offline: OFFLINE, lockFile: LOCK_FILE,
    log: (t) => say("    " + t) });
  fs.writeFileSync(path.join(WEB, "index.html"), vendored.html);
  const missing = localRefs(vendored.html).filter((r) => !fs.existsSync(path.join(WEB, ...r.split("/"))));
  if (missing.length) throw new Error("index.html names files the copy lacks: " + missing.join(", "));
  const webProblems = verifyWeb(WEB);
  if (webProblems.length) throw new Error("the web copy failed its checks: " + webProblems.join("; "));
  say("    " + vendored.files.length + " files vendored (" + vendored.stats.downloaded + " downloaded, " + vendored.stats.cached + " from the cache)");
  const lk = vendored.lock;
  say("    " + path.basename(lk.file) + ": " + lk.pinned + " files pinned and checked" + (lk.added.length ? ", " + lk.added.length + " newly pinned" : "") +
    (lk.removed.length ? ", " + lk.removed.length + " no longer used and dropped" : "") + (lk.written ? " (written)" : ""));
  say("3/7 staging the app code");
  stageApp();
  say("4/7 drawing the icon");
  const icns = makeIcon();
  say("5/7 packaging, setting the fuses and signing");
  const appPath = await packageApp(icns, sign);
  say("    " + appPath);
  say("6/7 checking the app");
  const check = await checkApp(appPath, sign);
  if (check.problems.length) throw new Error("the app failed its checks:\n  " + check.problems.join("\n  "));
  say("    bundle " + check.info.CFBundleIdentifier + " " + check.info.CFBundleShortVersionString + ", signature " + (check.signature || "?") +
    (check.runtime ? " (hardened runtime)" : "") + ", fuses " + JSON.stringify(check.fuses));
  say("7/7 running the packaged app's self-test");
  const { runSelfTest } = require("./selftest");
  const result = await runSelfTest(appPath, { log: say });
  say((result.ok ? "done" : "FAILED") + " in " + Math.round((Date.now() - t0) / 1000) + " s: " + appPath);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write("[build] error: " + (e && e.message ? e.message : String(e)) + "\n");
    process.exitCode = 1;
  });
}

module.exports = { copyWeb, localRefs, stageApp, makeIcon, packageApp, checkApp, readFuses, cachedElectronZip, checkOfflineElectron,
  signingIdentity, osxSignOptions, signatureInfo, checkVersion, BUNDLE_ID, FUSES, RUNTIME_LIB, WEB_FILES, LOCK_FILE, SIGN_IDENTITY_FILE };
