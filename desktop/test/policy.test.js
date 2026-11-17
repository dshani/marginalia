"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../lib/policy");

const O = policy.appOrigin(8765);

test("the app's origin is http://127.0.0.1:<port>", () => {
  assert.equal(O, "http://127.0.0.1:8765");
  assert.equal(policy.appOrigin(49152), "http://127.0.0.1:49152");
});

test("classify: the app's own page, other web pages, obsidian: and mailto:, and everything else", () => {
  const cases = [
    ["http://127.0.0.1:8765/", "app"], ["http://127.0.0.1:8765/#reader/abc/p_1", "app"], ["http://127.0.0.1:8765/test/sample.pdf", "app"],
    ["http://127.0.0.1:8766/", "web"], ["http://localhost:8765/", "web"], ["https://127.0.0.1:8765/", "web"],
    ["https://claude.ai/artifact/x", "web"], ["http://example.com/", "web"],
    ["obsidian://open?vault=V&file=F", "external"], ["mailto:someone@example.com", "external"], ["OBSIDIAN://new?x=1", "external"],
    ["file:///etc/hosts", "refuse"], ["javascript:alert(1)", "refuse"], ["data:text/html,hi", "refuse"], ["blob:http://127.0.0.1:8765/x", "refuse"],
    ["ftp://example.com/", "refuse"], ["marginalia://open?hash=library", "refuse"], ["chrome://settings", "refuse"],
    ["about:blank", "refuse"], ["", "refuse"], ["not a url", "refuse"], [null, "refuse"], ["http://user:pw@127.0.0.1:8765/", "refuse"]
  ];
  for (const [url, kind] of cases) assert.equal(policy.classify(url, O), kind, String(url));
});

test("navigation: only the app's origin loads; web and obsidian:/mailto: go outside; the rest is refused", () => {
  assert.deepEqual(policy.navigation("http://127.0.0.1:8765/#library", O), { allow: true, openExternal: false, kind: "app" });
  assert.deepEqual(policy.navigation("https://example.com/", O), { allow: false, openExternal: true, kind: "web" });
  assert.deepEqual(policy.navigation("obsidian://open?vault=V", O), { allow: false, openExternal: true, kind: "external" });
  assert.deepEqual(policy.navigation("file:///etc/hosts", O), { allow: false, openExternal: false, kind: "refuse" });
  assert.deepEqual(policy.navigation("http://127.0.0.1:9999/", O), { allow: false, openExternal: true, kind: "web" });
});

test("window.open never opens a window of Electron's own: the app's page loads in the window that asked, the rest goes outside or nowhere", () => {
  assert.deepEqual(policy.windowOpen("http://127.0.0.1:8765/#deck/d1", O), { load: true, openExternal: false, window: null, kind: "app" });
  assert.deepEqual(policy.windowOpen("https://example.invalid/x", O), { load: false, openExternal: true, window: null, kind: "web" });
  assert.deepEqual(policy.windowOpen("mailto:a@b.c", O), { load: false, openExternal: true, window: null, kind: "external" });
  assert.deepEqual(policy.windowOpen("javascript:void 0", O), { load: false, openExternal: false, window: null, kind: "refuse" });
});

test("a window of the app (DECISIONS D31): only the app's own page \"/?w=<id>\" asks for one, with an id of 6 to 16 of a–z and 0–9", () => {
  const ok = (url, id) => {
    assert.equal(policy.windowOf(url, O), id, url);
    assert.deepEqual(policy.windowOpen(url, O), { load: false, openExternal: false, window: id, kind: "app" }, url);
  };
  ok("http://127.0.0.1:8765/?w=abc123", "abc123");
  ok("http://127.0.0.1:8765/?w=selftest2", "selftest2");
  ok("http://127.0.0.1:8765/?w=0123456789abcdef", "0123456789abcdef");
  ok("http://127.0.0.1:8765/?w=k3x9q2m4p7#reader/b1", "k3x9q2m4p7");      // a place may travel in the hash
  // anything else of the app is the plain page (it loads in the window that asked), never a new window
  for (const url of ["http://127.0.0.1:8765/", "http://127.0.0.1:8765/#library", "http://127.0.0.1:8765/?w=abc12", "http://127.0.0.1:8765/?w=0123456789abcdefg",
    "http://127.0.0.1:8765/?w=ABC123", "http://127.0.0.1:8765/?w=abc-123", "http://127.0.0.1:8765/?w=abc123&x=1", "http://127.0.0.1:8765/?x=1&w=abc123",
    "http://127.0.0.1:8765/?w=abc123&w=def456", "http://127.0.0.1:8765/index.html?w=abc123", "http://127.0.0.1:8765/api/app?w=abc123",
    "http://127.0.0.1:8765/?w=", "http://127.0.0.1:8765/?W=abc123", "http://127.0.0.1:8765/?w=abc%31%32%33"]) {
    assert.equal(policy.windowOf(url, O), null, url);
    assert.equal(policy.windowOpen(url, O).window, null, url);
    assert.equal(policy.windowOpen(url, O).load, true, url);
  }
  // another origin never gets a window of the app
  for (const url of ["http://127.0.0.1:8766/?w=abc123", "http://localhost:8765/?w=abc123", "https://example.com/?w=abc123", "file:///?w=abc123",
    "javascript:location='/?w=abc123'", "", null, undefined]) {
    assert.equal(policy.windowOf(url, O), null, String(url));
    assert.equal(policy.windowOpen(url, O).window, null, String(url));
    assert.equal(policy.windowOpen(url, O).load, false, String(url));
  }
  assert.equal(policy.MAX_WINDOWS, 8);
});

test("windowFeatures: where and how large window.open asked the window to be (a tab dropped outside its window)", () => {
  const F = policy.windowFeatures;
  assert.deepEqual(F("popup=yes,width=1100,height=800,left=240,top=120"), { x: 240, y: 120, width: 1100, height: 800 });
  assert.deepEqual(F("popup=yes,width=1100,height=800"), { x: null, y: null, width: 1100, height: 800 });
  assert.deepEqual(F("left=-300, top = 40"), { x: -300, y: 40, width: null, height: null });
  assert.deepEqual(F("screenX=10,screenY=20"), { x: 10, y: 20, width: null, height: null });
  assert.deepEqual(F("left=5,screenX=10"), { x: 5, y: null, width: null, height: null }, "left goes before screenX");
  for (const none of ["", "popup=yes", "noopener", "width=abc", "left=1e3", "width=1234567", "left=1.5", "left=0x10", null, undefined, 7, {}, "width=900,".repeat(300)]) {
    assert.equal(F(none), null, String(none).slice(0, 20));
  }
});

test("permissions: clipboard read and write, and persistent storage (E2.3 c), for the app's own origin only", () => {
  assert.equal(policy.permissionAllowed("clipboard-read", "http://127.0.0.1:8765/#library", O), true);
  assert.equal(policy.permissionAllowed("clipboard-sanitized-write", "http://127.0.0.1:8765", O), true);
  assert.equal(policy.permissionAllowed("persistent-storage", "http://127.0.0.1:8765/#library", O), true);
  assert.equal(policy.permissionAllowed("clipboard-read", "http://127.0.0.1:8766/", O), false);
  assert.equal(policy.permissionAllowed("clipboard-read", "https://example.com/", O), false);
  assert.equal(policy.permissionAllowed("clipboard-read", "", O), false);
  for (const other of ["http://127.0.0.1:8766/", "http://localhost:8765/", "https://example.com/", "", null]) {
    assert.equal(policy.permissionAllowed("persistent-storage", other, O), false, String(other));
  }
  assert.deepEqual(Array.from(policy.ALLOWED_PERMISSIONS).sort(), ["clipboard-read", "clipboard-sanitized-write", "persistent-storage"]);
  for (const p of ["media", "geolocation", "notifications", "midi", "midiSysex", "hid", "serial", "usb", "openExternal",
    "fullscreen", "pointerLock", "keyboardLock", "display-capture", "storage-access", "window-management",
    "idle-detection", "deprecated-sync-clipboard-read", "local-fonts", "unknown"]) {
    assert.equal(policy.permissionAllowed(p, "http://127.0.0.1:8765/", O), false, p);
  }
});

// ---- SEC-3: nothing opens outside the app without the user's own click or key press ----------------------------
test("an outside link needs real input in the last 5 s (Chromium's user activation), and each input opens one", () => {
  for (const t of ["mouseDown", "rawKeyDown", "keyDown", "gestureTap", "touchEnd"]) assert.equal(policy.activatesUser(t), true, t);
  for (const t of ["mouseMove", "mouseUp", "keyUp", "char", "mouseWheel", "contextMenu", "undefined", undefined]) assert.equal(policy.activatesUser(t), false, String(t));
  assert.equal(policy.USER_ACTIVATION_MS, 5000);
  assert.equal(policy.userActivated(1000, 1000), true);
  assert.equal(policy.userActivated(1000, 6000), true);
  assert.equal(policy.userActivated(1000, 6001), false);
  assert.equal(policy.userActivated(0, 1000), false);              // consumed (or never any input)
  assert.equal(policy.userActivated(null, 1000), false);
  assert.equal(policy.userActivated(2000, 1000), false);           // a clock that went back
  const main = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /if \(!policy\.userActivated\(state\.lastInputAt, now\)\) \{/);
  assert.match(main, /state\.lastInputAt = 0;\s+\/\/ one outside open per click or key press/);
  assert.match(main, /wc\.on\("input-event", \(event, input\) => \{ if \(policy\.activatesUser\(input && input\.type\)\) state\.lastInputAt = Date\.now\(\); \}\);/);
});

// ---- OFF-1: PDF.js's CJK character maps on cdnjs (cdnjs refuses every .bcmap: 403, no CORS header) ----------------
test("the app cancels PDF.js's cMap requests to cdnjs, which can never succeed, and nothing else", () => {
  assert.equal(policy.blockedRequest("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/UniJIS-UCS2-H.bcmap"), true);
  assert.equal(policy.blockedRequest("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/Adobe-Japan1-UCS2.bcmap"), true);
  for (const ok of ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js", "http://127.0.0.1:8765/vendor/pdf.js/3.11.174/pdf.min.js",
    "https://api.anthropic.com/v1/messages", "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.js", "not a url", null]) {
    assert.equal(policy.blockedRequest(ok), false, String(ok));
  }
});
