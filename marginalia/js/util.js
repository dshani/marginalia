/* Marginalia — M.util (SPEC §10, §17.2): ids, hashes, timing helpers, formatters.
   Pure module: loads in node with no DOM; nothing here touches window/document.

   Documented choices
   - uuid(prefix): prefix + crypto.randomUUID(); when randomUUID is missing (insecure
     context) a v4 UUID is built from crypto.getRandomValues, and from Math.random as a
     last resort.
   - sha256(u8): crypto.subtle.digest("SHA-256"); rejects with code "no_subtle" when
     crypto.subtle is unavailable so callers can fall back to fnv1a (SPEC §3).
   - fnv1a(u8): 16 lowercase hex chars = two independent 32-bit FNV-1a passes over the
     same bytes, computed in one loop: pass 1 with the standard offset basis 0x811c9dc5,
     pass 2 with its bitwise complement 0x7ee3623a. It is "64-bit-ish": NOT the FNV-1a 64
     of the input, but stable and documented, and only a fallback for the sha256.
   - hash32(str): 32-bit FNV-1a over the string's UTF-16 code units (equals the byte-wise
     hash for ASCII), returned unsigned. Non-strings are stringified.
   - fmtInterval(ms) thresholds (round half up at each unit):
       < 59.5 min → "N min";  < 23.5 h → "N h";  < 13.5 d → "N d" (11.5 d reads "12 d");
       < 3.5 wk → "N wk";  < 10.5 mo (30.4375-day months) → "N mo";  else "N yr" (365.25 d).
     Negative/NaN → "0 min". The starburst legend labels of §7 are fixed strings, not this.
   - fmtBytes(n): 1024-based B/KB/MB/GB/TB, one decimal below 10 ("1.2 MB", "61 MB").
   - nextDayLabel(ms, now): by local calendar-day difference: ≤ 0 → "today", 1 → "tomorrow",
     2…6 → English weekday name, else "12 Nov" (plus " YYYY" when the year differs from now's).
*/
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  void dep; // util has no module dependencies; the helper is kept for the §17.1 skeleton

  var MIN = 60000, HOUR = 3600000, DAY = 86400000, WEEK = 7 * DAY, MONTH = 30.4375 * DAY, YEAR = 365.25 * DAY;
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var FNV_PRIME = 16777619, FNV_BASIS = 0x811c9dc5, FNV_BASIS_2 = 0x7ee3623a;
  var HEX = [];
  for (var h = 0; h < 256; h++) HEX.push((h < 16 ? "0" : "") + h.toString(16));

  // ---- errors -------------------------------------------------------------

  function error(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  // ---- bytes & hex --------------------------------------------------------

  function cryptoObj() {
    try { return root.crypto || null; } catch (e) { return null; }
  }

  function hexOf(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
    return s;
  }

  function hex32(n) {
    var s = (n >>> 0).toString(16);
    while (s.length < 8) s = "0" + s;
    return s;
  }

  function toU8(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== "undefined") {
      if (input instanceof ArrayBuffer) return new Uint8Array(input);
      if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof input === "string") return new TextEncoder().encode(input);
    throw error("bad_input", "expected a Uint8Array, ArrayBuffer or string");
  }

  function randomBytes(n) {
    var out = new Uint8Array(n), c = cryptoObj();
    if (c && typeof c.getRandomValues === "function") {
      try { c.getRandomValues(out); return out; } catch (e) { /* fall through to Math.random */ }
    }
    for (var i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  // ---- ids ----------------------------------------------------------------

  function uuid(prefix) {
    var c = cryptoObj(), id = null;
    if (c && typeof c.randomUUID === "function") {
      try { id = c.randomUUID(); } catch (e) { id = null; }
    }
    if (!id) {
      var b = randomBytes(16);
      b[6] = (b[6] & 0x0f) | 0x40; // version 4
      b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
      var x = hexOf(b);
      id = x.slice(0, 8) + "-" + x.slice(8, 12) + "-" + x.slice(12, 16) + "-" + x.slice(16, 20) + "-" + x.slice(20);
    }
    return (prefix == null ? "" : String(prefix)) + id;
  }

  // ---- hashes -------------------------------------------------------------

  function sha256(u8) {
    var bytes;
    try { bytes = toU8(u8); } catch (e) { return Promise.reject(e); }
    var c = cryptoObj();
    if (!c || !c.subtle || typeof c.subtle.digest !== "function") {
      return Promise.reject(error("no_subtle", "crypto.subtle is unavailable (insecure context?)"));
    }
    var p;
    try { p = Promise.resolve(c.subtle.digest("SHA-256", bytes)); } catch (e) { return Promise.reject(e); }
    return p.then(function (buf) { return hexOf(new Uint8Array(buf)); });
  }

  function fnv1a(u8) {
    var b = toU8(u8), h1 = FNV_BASIS | 0, h2 = FNV_BASIS_2 | 0;
    for (var i = 0; i < b.length; i++) {
      var x = b[i];
      h1 = Math.imul(h1 ^ x, FNV_PRIME);
      h2 = Math.imul(h2 ^ x, FNV_PRIME);
    }
    return hex32(h1) + hex32(h2);
  }

  function hash32(str) {
    var s = String(str), h32 = FNV_BASIS | 0;
    for (var i = 0; i < s.length; i++) h32 = Math.imul(h32 ^ s.charCodeAt(i), FNV_PRIME);
    return h32 >>> 0;
  }

  function mulberry32(seed) {
    var a = typeof seed === "number" ? (seed >>> 0) : hash32(seed);
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- timing -------------------------------------------------------------

  function debounce(fn, ms) {
    if (typeof fn !== "function") throw error("bad_fn", "debounce expects a function");
    var timer = null, ctx = null, args = null, wait = ms == null ? 0 : +ms;
    function fire() {
      timer = null;
      var c = ctx, a = args;
      ctx = null; args = null;
      fn.apply(c, a);
    }
    function debounced() {
      ctx = this; args = arguments;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, wait);
    }
    debounced.cancel = function () {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      ctx = null; args = null;
    };
    debounced.flush = function () {
      if (timer !== null) { clearTimeout(timer); fire(); }
    };
    debounced.pending = function () { return timer !== null; };
    return debounced;
  }

  // ---- small helpers ------------------------------------------------------

  function clamp(x, lo, hi) {
    x = +x;
    if (x !== x) return lo; // NaN
    return Math.min(hi, Math.max(lo, x));
  }

  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, function (ch) { return ESC[ch]; });
  }

  // ---- dates --------------------------------------------------------------

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function localMidnight(now) {
    var d = new Date(now == null ? Date.now() : now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dayKey(ms) {
    var d = new Date(ms == null ? Date.now() : ms);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function nextDayLabel(ms, now) {
    var ref = now == null ? Date.now() : now;
    var d = new Date(ms);
    if (isNaN(d.getTime()) || isNaN(new Date(ref).getTime())) return "";
    var days = Math.round((localMidnight(ms) - localMidnight(ref)) / DAY);
    if (days <= 0) return "today";
    if (days === 1) return "tomorrow";
    if (days <= 6) return WEEKDAYS[d.getDay()];
    var label = d.getDate() + " " + MONTHS[d.getMonth()];
    if (d.getFullYear() !== new Date(ref).getFullYear()) label += " " + d.getFullYear();
    return label;
  }

  // ---- formatters ---------------------------------------------------------

  function fmtInterval(ms) {
    var v = +ms;
    if (!(v > 0)) v = 0;
    if (v < 59.5 * MIN) return Math.round(v / MIN) + " min";
    if (v < 23.5 * HOUR) return Math.round(v / HOUR) + " h";
    if (v < 13.5 * DAY) return Math.round(v / DAY) + " d";
    if (v < 3.5 * WEEK) return Math.round(v / WEEK) + " wk";
    if (v < 10.5 * MONTH) return Math.round(v / MONTH) + " mo";
    return Math.round(v / YEAR) + " yr";
  }

  function fmtBytes(n) {
    var v = +n;
    if (!(v >= 0)) v = 0;
    var units = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    var s = i === 0 ? String(Math.round(v)) : (v < 9.95 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v)));
    return s + " " + units[i];
  }

  // Line icons for the four prompt kinds, drawn on a 24-px grid with currentColor (shapes after Tabler Icons,
  // MIT License, (c) Pawel Kuna): a pencil for notes, a question mark in a circle for Q./A. prompts, brackets for
  // cloze prompts, a marker pen for highlights. Constant markup with no user text, so it may go into innerHTML.
  var KIND_ICON_PATHS = {
    note: '<path d="M4 20h4l10.5-10.5a2.83 2.83 0 1 0-4-4L4 16v4"/><path d="M13.5 6.5l4 4"/>',
    qa: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0"/><path d="M12 16v.01"/>' +
        '<path d="M12 13a2 2 0 0 0 .91-3.78a1.98 1.98 0 0 0-2.41.48"/>',
    cloze: '<path d="M8 4H5v16h3"/><path d="M16 4h3v16h-3"/>',
    highlight: '<path d="M3 19h4l10.5-10.5a2.83 2.83 0 1 0-4-4L3 15v4"/><path d="M12.5 5.5l4 4"/>' +
        '<path d="M4.5 13.5l4 4"/><path d="M21 15v4h-8l4-4z"/>'
  };

  function kindIcon(kind) {
    var k = Object.prototype.hasOwnProperty.call(KIND_ICON_PATHS, kind) ? kind : "note";
    return '<svg class="kind-icon kind-icon--' + k + '" viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
      'focusable="false">' + KIND_ICON_PATHS[k] + "</svg>";
  }

  var api = {
    uuid: uuid,
    sha256: sha256,
    fnv1a: fnv1a,
    hash32: hash32,
    mulberry32: mulberry32,
    debounce: debounce,
    clamp: clamp,
    escapeHtml: escapeHtml,
    localMidnight: localMidnight,
    dayKey: dayKey,
    fmtInterval: fmtInterval,
    fmtBytes: fmtBytes,
    nextDayLabel: nextDayLabel,
    error: error,
    kindIcon: kindIcon
  };
  M.util = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.util): uuid(prefix) → string; sha256(u8) → Promise<hex>; fnv1a(u8) → hex;
   hash32(str) → uint32; mulberry32(seed) → () → float; debounce(fn, ms) (+ .cancel(), .flush(), .pending());
   clamp(x, lo, hi); escapeHtml(s); localMidnight(now) → ms; dayKey(ms) → "YYYY-MM-DD" (local);
   fmtInterval(ms) → "10 min" | "5 d" | "2 wk" | "1 mo" | "1 yr"; fmtBytes(n); nextDayLabel(ms, now) → "today" |
   "tomorrow" | weekday | "12 Nov". Extensions: error(code, message) → Error with .code; kindIcon(kind) → the
   constant SVG markup of the kind's line icon ("note" | "qa" | "cloze" | "highlight"; anything else draws the note
   pencil), class "kind-icon kind-icon--<kind>", 14 px, stroke currentColor, aria-hidden. */
