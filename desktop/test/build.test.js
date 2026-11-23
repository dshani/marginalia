"use strict";
// scripts/build.js and the app's own files: what goes into the app, and the security settings main.js and preload.js
// promise (read from their source, since they need Electron to run; the packaged self-test runs them for real).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const build = require("../scripts/build");

const os = require("node:os");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("package.json pins exact versions of electron, @electron/packager and @electron/fuses, and nothing else", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ["@electron/fuses", "@electron/packager", "electron"]);
  for (const v of Object.values(pkg.devDependencies)) assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts.app, "node scripts/build.js");
  const lock = JSON.parse(read("package-lock.json"));
  for (const [name, v] of Object.entries(pkg.devDependencies)) assert.equal(lock.packages["node_modules/" + name].version, v, name);
  assert.match(read(".npmrc"), /^ignore-scripts=true$/m);
});

test("the web copy takes the app's files and never the tests, docs, dist or caches", () => {
  assert.deepEqual(build.WEB_FILES, ["index.html", "styles.css", "tools/serve.py", "test/sample.pdf"]);
  const src = read("scripts/build.js");
  assert.match(src, /\[\["css", "\.css"\], \["js", "\.js"\]\]/);
  for (const never of ["docs", "dist", ".cache", "test_serve.py", ".test.js", "bundle.py", "smoke.js", "xref"]) {
    assert.ok(!build.WEB_FILES.some((f) => f.includes(never)), never);
  }
  assert.deepEqual(build.localRefs('<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="https://x.y/z.css"><script src="js/a.js"></script><script src="//cdn/x.js"></script>'),
    ["styles.css", "js/a.js"]);
});

test("the app bundles only the runtime modules", () => {
  const files = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).sort();
  const buildOnly = files.filter((f) => !build.RUNTIME_LIB.includes(f));
  assert.deepEqual(buildOnly, ["icon.js", "signing.js", "vendor.js"]);
  const main = read("main.js");
  for (const f of build.RUNTIME_LIB) assert.ok(main.includes('require("./lib/' + f.replace(/\.js$/, "") + '")'), f);
});

test("the fuses: no RunAsNode, no NODE_OPTIONS, no --inspect; asar integrity on; no file:// privileges", () => {
  assert.equal(build.FUSES.RunAsNode, false);
  assert.equal(build.FUSES.EnableNodeOptionsEnvironmentVariable, false);
  assert.equal(build.FUSES.EnableNodeCliInspectArguments, false);
  assert.equal(build.FUSES.EnableEmbeddedAsarIntegrityValidation, true);
  assert.equal(build.FUSES.OnlyLoadAppFromAsar, true);
  assert.equal(build.FUSES.GrantFileProtocolExtraPrivileges, false);
  assert.match(build.BUNDLE_ID, /^[a-z]+(\.[a-z]+)+$/);
});

test("main.js keeps the window locked down", () => {
  const main = read("main.js");
  for (const needle of ["contextIsolation: true", "sandbox: true", "nodeIntegration: false", "webSecurity: true", "webviewTag: false",
    "nodeIntegrationInWorker: false", "allowRunningInsecureContent: false", "app.enableSandbox()", 'appendSwitch("use-mock-keychain")',
    "setPermissionRequestHandler", "setPermissionCheckHandler", "setDevicePermissionHandler", "setWindowOpenHandler",
    'return { action: "deny" }', '"will-navigate"', '"will-redirect"', '"will-attach-webview"', "requestSingleInstanceLock"]) {
    assert.ok(main.includes(needle), needle);
  }
  assert.ok(!/setAsDefaultProtocolClient\s*\(/.test(main), "never registers the dev binary for marginalia://");
  assert.ok(!/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/.test(main));
  // shell.openExternal is reached only through openOutside, which is a recorder in self-test mode
  const calls = main.match(/shell\.openExternal\(/g) || [];
  assert.equal(calls.length, 1);
  assert.match(main, /if \(SELF_TEST\) \{ state\.externalOpens\.push\(\{ url, opened: true \}\); return; \}\n[^\n]*\n  shell\.openExternal\(url\)/);
  // the userData path is set before the single-instance lock and before anything else reads it
  assert.ok(main.indexOf('app.setPath("userData"') < main.indexOf("requestSingleInstanceLock"));
});

test("the self-test follows the persistent-storage switch and sees the close hide the window (repairs REQ-D and F2)", () => {
  const main = read("main.js");
  // the verdict learns the switch from lib/policy.js itself, so turning it off needs no change to the self-test
  assert.match(main, /persistentStorage: policy\.ALLOWED_PERMISSIONS\.has\("persistent-storage"\)/);
  // the close is probed through lib/selftest.js closeProbe (it watches the window's hide(); the window is never shown)
  assert.match(main, /return selftest\.closeProbe\(win, \{ settle: \(\) => delay\(300\), serverRunning: \(\) => !!\(state\.server && state\.server\.running\) \}\);/);
  assert.ok(!/visible: !destroyed && win\.isVisible\(\)/.test(main), "main.js no longer judges the close by isVisible() alone");
});

test("preload.js exposes only {app, version, platform, onOpenPdf} through contextBridge, and one ipc channel that only listens (D34)", () => {
  const pre = read("preload.js");
  assert.match(pre, /contextBridge\.exposeInMainWorld\("marginaliaDesktop", Object\.freeze\(\{ app: true, version, platform: process\.platform, onOpenPdf \}\)\);/);
  assert.equal((pre.match(/exposeInMainWorld/g) || []).length, 1);
  assert.ok(!/require\("(?!electron")/.test(pre));
  // the page can only listen: no send, invoke, postMessage or sendSync, and the one channel is lib/openfile.js's
  assert.deepEqual(pre.match(/ipcRenderer\.\w+/g), ["ipcRenderer.on"]);
  assert.match(pre, /const CHANNEL = "marginalia:open-pdf";/);
  assert.equal(require("../lib/openfile").CHANNEL, "marginalia:open-pdf");
  assert.equal(require("../lib/openfile").MAX_WAITING, 8);
  assert.match(pre, /const MAX_WAITING = 8;/);
});

test("an offline build stops before packaging when Electron is not in .cache/electron, and names it (R3)", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "build-test-")));
  try {
    const name = "electron-v45.3.0-darwin-arm64.zip";
    assert.equal(build.cachedElectronZip(dir, "45.3.0"), null);
    assert.equal(build.cachedElectronZip(path.join(dir, "none"), "45.3.0"), null);
    fs.mkdirSync(path.join(dir, "32d6810b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "32d6810b", "electron-v45.2.0-darwin-arm64.zip"), "x");
    assert.equal(build.cachedElectronZip(dir, "45.3.0"), null);
    fs.writeFileSync(path.join(dir, "32d6810b", name), "x");
    assert.equal(build.cachedElectronZip(dir, "45.3.0"), path.join(dir, "32d6810b", name));
    assert.throws(() => build.checkOfflineElectron(path.join(dir, "none"), "45.3.0"), /electron-v45\.3\.0-darwin-arm64\.zip is not in .*and the build runs offline/);
    assert.doesNotThrow(() => build.checkOfflineElectron(dir, "45.3.0"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.match(read("scripts/build.js"), /if \(OFFLINE\) checkOfflineElectron\(path\.join\(CACHE, "electron"\), electronVersion\(\)\);/);
});
