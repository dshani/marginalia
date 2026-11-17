"use strict";
// Where the main window may go, what opens outside the app, and which permissions the page gets (pure).
//
//   classify(url, origin) → "app"      the app's own page: http://127.0.0.1:<port>/…
//                           "web"      any other http(s) page: opens in the default browser
//                           "external" obsidian: (how link mode opens notes) and mailto: — handed to macOS
//                           "refuse"   everything else (file:, javascript:, data:, custom schemes, junk): nothing happens
//   navigation(url, origin)  → {allow, openExternal}    for will-navigate / will-redirect of the main window
//   windowOpen(url, origin)  → {load, openExternal, window}   for window.open and target=_blank. `window` (DECISIONS
//       D31): the id when the page asks for a window of the app, "http://127.0.0.1:<port>/?w=<id>" (windowOf); main.js
//       then makes that window itself. Any other page of the app loads in the window that asked; nothing else ever
//       opens a window.
//   windowOf(url, origin) → the id of the app's window that this URL names (the app's page "/" with the query
//       "?w=<id>" and nothing else, 6 to 16 of a–z and 0–9), else null (the first window has no id)
//   windowFeatures(features) → {x, y, width, height} | null   what window.open asked for ("left=..,top=..,width=..,height=..")
//   permissionAllowed(permission, requesting, origin)  clipboard read and write, and persistent storage (FEATURES E2.3 c:
//       navigator.storage.persist() and persisted(), so Chromium never evicts the library when the disk is nearly full),
//       for the app's own origin; nothing else
//   activatesUser(inputType), userActivated(lastInputAt, now)
//       an outside open ("web" or "external") needs the user's own click or key press in the last USER_ACTIVATION_MS
//       (Chromium's transient user activation: Brave lets a page open a tab or hand obsidian: to macOS only then), and
//       each such input allows one open (main.js consumes it), so page script alone can open nothing outside the app
//   blockedRequest(url)  requests the app cancels: PDF.js's CJK character maps on cdnjs, which cdnjs refuses for every
//       .bcmap file (403, no CORS header), online or not; cancelled, they fail at once instead of waiting on the
//       network, and the app contacts no host but 127.0.0.1 while it shows a PDF
const HOST = "127.0.0.1";
const USER_ACTIVATION_MS = 5000;
const ACTIVATING_INPUT = new Set(["mouseDown", "rawKeyDown", "keyDown", "gestureTap", "touchEnd"]);
const BLOCKED_REQUEST_RE = /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/[^/?#]+\/cmaps\//;
const EXTERNAL_SCHEMES = new Set(["obsidian:", "mailto:"]);
const ALLOWED_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "persistent-storage"]);

function appOrigin(port) {
  return "http://" + HOST + ":" + port;
}

function parseUrl(url) {
  if (typeof url !== "string" || !url || url.length > 65536) return null;
  try { return new URL(url); } catch (e) { return null; }
}

function classify(url, origin) {
  const u = parseUrl(url);
  if (!u) return "refuse";
  if (u.protocol === "http:" || u.protocol === "https:") {
    if (u.username || u.password) return u.origin === origin ? "refuse" : "web";
    return u.origin === origin ? "app" : "web";
  }
  if (EXTERNAL_SCHEMES.has(u.protocol)) return "external";
  return "refuse";
}

function navigation(url, origin) {
  const c = classify(url, origin);
  if (c === "app") return { allow: true, openExternal: false, kind: c };
  return { allow: false, openExternal: c === "web" || c === "external", kind: c };
}

const WINDOW_QUERY_RE = /^\?w=([a-z0-9]{6,16})$/;
const MAX_WINDOWS = 8;

function windowOf(url, origin) {
  if (classify(url, origin) !== "app") return null;
  const u = parseUrl(url);
  if (!u || u.pathname !== "/") return null;
  const m = WINDOW_QUERY_RE.exec(u.search);
  return m ? m[1] : null;
}

function windowOpen(url, origin) {
  const c = classify(url, origin);
  const window = c === "app" ? windowOf(url, origin) : null;
  return { load: c === "app" && !window, openExternal: c === "web" || c === "external", window, kind: c };
}

// "popup=yes,width=1100,height=800,left=240,top=120" → {x: 240, y: 120, width: 1100, height: 800}; a number that is
// missing is null; null when no position and no size was asked. lib/windowstate.js makes it fit a screen.
function windowFeatures(features) {
  if (typeof features !== "string" || !features || features.length > 2048) return null;
  const got = {};
  for (const part of features.split(",")) {
    const m = /^\s*(left|top|width|height|screenX|screenY)\s*=\s*(-?\d{1,6})\s*$/.exec(part);
    if (m) got[m[1]] = Number(m[2]);
  }
  const pick = (a, b) => (Number.isFinite(got[a]) ? got[a] : Number.isFinite(got[b]) ? got[b] : null);
  const out = { x: pick("left", "screenX"), y: pick("top", "screenY"), width: pick("width", "width"), height: pick("height", "height") };
  return out.x === null && out.y === null && out.width === null && out.height === null ? null : out;
}

function originOf(value) {
  const u = parseUrl(value);
  if (!u) return null;
  return u.origin === "null" ? null : u.origin;
}

function permissionAllowed(permission, requesting, origin) {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  return originOf(requesting) === origin;
}

function activatesUser(type) {
  return ACTIVATING_INPUT.has(type);
}

function userActivated(lastInputAt, now) {
  return typeof lastInputAt === "number" && lastInputAt > 0 && now >= lastInputAt && now - lastInputAt <= USER_ACTIVATION_MS;
}

function blockedRequest(url) {
  return typeof url === "string" && BLOCKED_REQUEST_RE.test(url);
}

module.exports = { appOrigin, classify, navigation, windowOpen, windowOf, windowFeatures, permissionAllowed, originOf, activatesUser, userActivated,
  blockedRequest, HOST, EXTERNAL_SCHEMES, ALLOWED_PERMISSIONS, USER_ACTIVATION_MS, MAX_WINDOWS };
