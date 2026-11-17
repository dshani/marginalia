/* js/exporter.js — Marginalia exporter (SPEC §9, §17).
 *
 * Pure formats (toJSON, toAnkiTSV, toMarkdown) and the pure merge() load in node
 * without a DOM; importJSON/prepare talk to M.cache and M.store; deliver() and
 * openDialog() touch the DOM only when called after boot.
 *
 * State shape used by merge() and the backup: {collections, prompts, attachments, folders}
 * where attachments are [{id, mime, width, height, data: base64}] (local attachments
 * may be given as [{id}] or ["id"] — only the id matters on the local side) and folders
 * are the library's folder records {id, name, parentId, createdAt, updatedAt, deletedAt}
 * (FEATURES L1.7), tombstones included; a backup of one book or deck carries folders: [].
 * A caller of merge() passes the local folders too: without them every book and deck in a
 * folder would come back at the top level.
 *
 * A backup is untrusted input (it may be hand-made, corrupted or come from someone else):
 * an attachment is only ever a raster image (PNG, JPEG, GIF or WebP, recognised by its
 * signature, never by its declared mime) within the attachment size limit, and one import
 * is bounded in records and image bytes.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function opt(name) { try { return dep(name); } catch (e) { return undefined; } }

  var FORMAT = "marginalia";
  var VERSION = 1;
  var COPY_LIMIT = 50 * 1024 * 1024;
  var SETTINGS_KEYS = ["reviewKeys", "snipMode", "marginMode", "marginAnswers", "visionModel", "obsidian", "obsidianVault", "obsidianFolder", "notAlike"];
  var CHUNK_FIELDS = ["chunkCount", "chunkSize"];
  // Fields that describe what is stored locally; they never come from a backup when the record exists locally.
  var COLLECTION_LOCAL_FIELDS = ["id", "kind", "hasBytes", "chunkCount", "chunkSize", "byteLength", "sha256", "hashAlgo",
    "fileName", "pageCount", "pageLabels", "addedAt", "v"];
  // revisedAt (FIXES-1 FIX-5: when the text last changed) travels with the text of the side that wins; when that side has
  // none, the merged record has none either.
  var PROMPT_CONTENT_FIELDS = ["text", "kind", "anchor", "tags", "flagged", "context", "collectionId", "contentUpdatedAt", "revisedAt"];
  var IMAGE_TOKEN = /!\[[^\]]*\]\(att:([\w-]+)\)/g;
  var TAGS_LINE = /^(?:#[\w-]{2,})(?:[ \t]+#[\w-]{2,})*[ \t]*$/;
  var MIME = { json: "application/json", anki: "text/plain", markdown: "text/markdown" };
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // User-authored collection fields: they follow the newer content stamp, not the newer write (see mergeCollection).
  var COLLECTION_CONTENT_FIELDS = ["name", "description", "sections", "contentUpdatedAt"];
  // Where a book or deck sits (FEATURES L1): folderId follows the newer folderUpdatedAt, its own stamp (see mergeCollection).
  var COLLECTION_FOLDER_FIELDS = ["folderId", "folderUpdatedAt"];
  // Import limits.
  var MAX_IMPORT_RECORDS = 200000;                // collections + prompts + attachments + folders in one backup
  var MAX_IMPORT_BYTES = 256 * 1024 * 1024;       // image bytes one import may add
  var MAX_IMPORT_FILE = 512 * 1024 * 1024;        // backup file (or pasted text) size
  var DEFAULT_MAX_IMAGE = 4 * 1024 * 1024;        // M.attachments.MAX_PNG when attachments.js is not loaded
  var MAX_IMAGE_DIM = 100000;                     // px; a stored width/height is null or a finite number in [1, this]
  var ATT_ID = /^[A-Za-z0-9_-]{1,128}$/;          // the id alphabet of ![snip](att:<id>) tokens
  var B64_DATA = /^[A-Za-z0-9+/]*={0,2}$/;

  // ---------------------------------------------------------------- helpers

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
  // A tombstone stamp: a positive finite number, else null (a backup's malformed deletedAt never half-deletes a record).
  function stampOf(v) { return typeof v === "number" && isFinite(v) && v > 0 ? v : null; }
  function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function live(p) { return !!p && !p.deletedAt; }
  function deps() { return { util: opt("util"), markup: opt("markup"), prompts: opt("prompts"), context: opt("context"), scheduler: opt("scheduler") }; }

  function escapeHtml(s) {
    var u = opt("util");
    if (u && typeof u.escapeHtml === "function") { try { return u.escapeHtml(String(s == null ? "" : s)); } catch (e) { /* fall through */ } }
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function keysOf(o) { return Object.keys(o).filter(function (k) { return o[k] !== undefined; }); }
  // Structural equality over JSON-like values; undefined-valued keys are ignored.
  function same(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a !== a && b !== b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
      return true;
    }
    var ka = keysOf(a), kb = keysOf(b);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) {
      var k = ka[j];
      if (!hasOwn(b, k) || b[k] === undefined || !same(a[k], b[k])) return false;
    }
    return true;
  }

  function byAdded(a, b) { var d = num(a.addedAt) - num(b.addedAt); return d || cmpStr(a.id, b.id); }
  function byCreated(a, b) { var d = num(a.createdAt) - num(b.createdAt); return d || cmpStr(a.id, b.id); }
  function byName(a, b) { return cmpStr(String(a.name || a.title || ""), String(b.name || b.title || "")) || cmpStr(a.id, b.id); }
  function cmpStr(a, b) { a = String(a == null ? "" : a); b = String(b == null ? "" : b); return a < b ? -1 : a > b ? 1 : 0; }
  function pageOf(p) {
    if (p.anchor && typeof p.anchor.pageIndex === "number") return p.anchor.pageIndex;
    if (p.context && typeof p.context.pageIndex === "number") return p.context.pageIndex;
    return 0;
  }
  function yOf(p) { return p.anchor && typeof p.anchor.y === "number" ? p.anchor.y : -1e15; }
  function readingOrderFor(col) {
    var deck = !!col && col.kind === "deck";
    return function (a, b) {
      if (!deck) {
        var pa = pageOf(a), pb = pageOf(b);
        if (pa !== pb) return pa - pb;
        var ya = yOf(a), yb = yOf(b);
        if (ya !== yb) return yb - ya;
      }
      return byCreated(a, b);
    };
  }

  function cacheCollections() {
    try { return M.cache && typeof M.cache.collections === "function" ? (M.cache.collections() || []) : []; } catch (e) { return []; }
  }
  function cachePrompts() {
    try { return M.cache && typeof M.cache.prompts === "function" ? (M.cache.prompts() || []) : []; } catch (e) { return []; }
  }
  function cacheFolders() {
    try { return M.cache && typeof M.cache.folders === "function" ? (M.cache.folders() || []) : []; } catch (e) { return []; }
  }
  function settingsAll() {
    try { return M.settings && typeof M.settings.all === "function" ? (M.settings.all() || {}) : {}; } catch (e) { return {}; }
  }
  function pickSettings(all) {
    var out = {};
    if (!all || typeof all !== "object") return out;
    SETTINGS_KEYS.forEach(function (k) { if (all[k] !== undefined) out[k] = clone(all[k]); });
    return out;
  }
  function toast(text, actions) {
    if (M.app && typeof M.app.toast === "function") { try { M.app.toast({ text: text, actions: actions, ttl: 5000 }); } catch (e) { /* ignore */ } }
  }

  // Scope resolution: {scope: "all"|"collection", collectionId, collections, prompts}
  function inScope(opts) {
    var scoped = opts.scope === "collection" && !!opts.collectionId;
    var cols = (Array.isArray(opts.collections) ? opts.collections : cacheCollections()).slice();
    var prompts = (Array.isArray(opts.prompts) ? opts.prompts : cachePrompts()).slice();
    if (scoped) {
      cols = cols.filter(function (c) { return c && c.id === opts.collectionId; });
      prompts = prompts.filter(function (p) { return p && p.collectionId === opts.collectionId; });
    }
    return { scope: scoped ? "collection" : "all", collectionId: scoped ? opts.collectionId : null, collections: cols, prompts: prompts };
  }

  function imageIds(text, d) {
    if (d && d.prompts && typeof d.prompts.imageIds === "function") {
      try { var r = d.prompts.imageIds(String(text || "")); if (Array.isArray(r)) return r; } catch (e) { /* fall through */ }
    }
    var ids = [], m, re = new RegExp(IMAGE_TOKEN.source, "g"), s = String(text || "");
    while ((m = re.exec(s))) if (ids.indexOf(m[1]) < 0) ids.push(m[1]);
    return ids;
  }
  function stripImages(text) { return String(text == null ? "" : text).replace(new RegExp(IMAGE_TOKEN.source, "g"), "[image]"); }

  // ------------------------------------------------------------ attachments

  function maxImageBytes() {
    var a = M.attachments;
    return a && typeof a.MAX_PNG === "number" && isFinite(a.MAX_PNG) && a.MAX_PNG > 0 ? a.MAX_PNG : DEFAULT_MAX_IMAGE;
  }
  // The mime of a raster image recognised by its signature, else null (SVG, HTML, anything else).
  function sniffImage(b) {
    if (!b || b.length < 3) return null;
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
    return null;
  }
  // {data, size}: canonical base64 (whitespace removed) and its decoded byte count, or null when `data` is not
  // base64 or decodes to nothing or to more than `max` bytes. The length is checked before anything is copied.
  function cleanBase64(data, max) {
    if (typeof data !== "string" || !data || data.length > 2 * max + 64) return null;
    var s = /\s/.test(data) ? data.replace(/\s+/g, "") : data;
    if (!s || s.length % 4 === 1 || !B64_DATA.test(s)) return null;
    var pad = s.charAt(s.length - 1) !== "=" ? 0 : s.charAt(s.length - 2) === "=" ? 2 : 1;
    if (pad && s.length % 4 !== 0) return null;
    var size = Math.floor((s.length - pad) * 3 / 4);
    return size >= 1 && size <= max ? { data: s, size: size } : null;
  }
  function headOf(b64) {
    try { return base64ToBytes(b64.slice(0, 16)); } catch (e) { return new Uint8Array(0); }
  }
  function dimOk(v) { return v == null || (typeof v === "number" && isFinite(v) && v >= 1 && v <= MAX_IMAGE_DIM); }
  function dimOf(v) { return typeof v === "number" && isFinite(v) && v >= 1 && v <= MAX_IMAGE_DIM ? v : null; }
  // Import side (strict): {record: {id, mime, width, height, data}, size}, or null when the backup record is not an
  // image we may store — a non-raster or mislabelled payload, bad base64, over the size limit, or bad dimensions.
  function importableAttachment(a, max) {
    if (!a || typeof a !== "object" || typeof a.id !== "string" || !ATT_ID.test(a.id)) return null;
    if (!dimOk(a.width) || !dimOk(a.height)) return null;
    var b = cleanBase64(a.data, max);
    var mime = b && sniffImage(headOf(b.data));
    if (!mime) return null;
    if (a.mime != null && a.mime !== "" && (typeof a.mime !== "string" || a.mime.trim().toLowerCase() !== mime)) return null;
    return { record: { id: a.id, mime: mime, width: dimOf(a.width), height: dimOf(a.height), data: b.data }, size: b.size };
  }
  // Export side (lenient): the same image checks; the mime is the sniffed one and a bad width/height becomes null.
  function exportableAttachment(a, max) {
    if (!a || typeof a !== "object" || typeof a.id !== "string" || !ATT_ID.test(a.id)) return null;
    var b = cleanBase64(a.data, max);
    var mime = b && sniffImage(headOf(b.data));
    return mime ? { id: a.id, mime: mime, width: dimOf(a.width), height: dimOf(a.height), data: b.data } : null;
  }

  // A callable map: images(id) and images[id] both give the data: URL (M.markup may use either form).
  // Only raster images become data: URLs, whatever mime the record claims.
  function imageMap(attachments, includeImages) {
    var map = {}, max = maxImageBytes();
    if (includeImages) (attachments || []).forEach(function (a) {
      var x = exportableAttachment(a, max);
      if (x && !hasOwn(map, x.id)) map[x.id] = "data:" + x.mime + ";base64," + x.data;
    });
    var fn = function (id) { return hasOwn(map, id) ? map[id] : null; };
    Object.keys(map).forEach(function (k) { fn[k] = map[k]; });
    return fn;
  }
  function urlFrom(images, id) {
    if (typeof images === "function") return images(id);
    return images && hasOwn(images, id) ? images[id] : null;
  }

  // ----------------------------------------------------- prompt text helpers

  function splitTags(text) {
    var t = String(text == null ? "" : text).replace(/\s+$/, "");
    var lines = t.split("\n"), tags = [];
    if (lines.length && TAGS_LINE.test(lines[lines.length - 1].trim())) {
      tags = lines.pop().trim().split(/\s+/).map(function (x) { return x.slice(1); });
    }
    return { body: lines.join("\n"), tags: tags };
  }
  function stripTagsLine(text, d) {
    if (d && d.prompts && typeof d.prompts.stripTags === "function") {
      try { var r = d.prompts.stripTags(String(text == null ? "" : text)); if (typeof r === "string") return r; } catch (e) { /* fall through */ }
    }
    return splitTags(text).body;
  }

  // Length of a math run or image token starting at i, else 0 (fallback tokenizer).
  function runAt(s, i) {
    var c = s[i];
    if (c === "!" && s[i + 1] === "[") {
      var img = /^!\[[^\]]*\]\(att:[\w-]+\)/.exec(s.slice(i));
      return img ? img[0].length : 0;
    }
    if (c === "\\") {
      if (s[i + 1] === "[") { var e1 = s.indexOf("\\]", i + 2); return e1 < 0 ? 0 : e1 + 2 - i; }
      if (s[i + 1] === "(") { var e2 = s.indexOf("\\)", i + 2); return e2 < 0 ? 0 : e2 + 2 - i; }
      return 0;
    }
    if (c === "$") {
      if (s[i + 1] === "$") { var e3 = s.indexOf("$$", i + 2); return e3 < 0 ? 0 : e3 + 2 - i; }
      var next = s[i + 1];
      if (!next || /\s/.test(next)) return 0;
      for (var j = i + 1; j < s.length; j++) {
        if (s[j] === "\\") { j++; continue; }
        if (s[j] === "\n") return 0;
        if (s[j] === "$" && !/\s/.test(s[j - 1])) return j + 1 - i;
      }
      return 0;
    }
    return 0;
  }
  // The cue separator of M.prompts ("::" without it).
  function cueSep() {
    var P = opt("prompts");
    return P && typeof P.CUE_SEP === "string" && P.CUE_SEP ? P.CUE_SEP : "::";
  }
  // Fallback cloze scanner: outer braces win, \{ is literal, braces inside math runs and image tokens are ignored,
  // a brace opened in text and closed after a math run is one deletion. Cues as M.prompts.parse (FEATURES P1.1):
  // the last unescaped "::" at the top level of a deletion splits it into `text` (the hidden part as typed) and
  // `cue` (trimmed); `\::` is a literal "::"; a blank hidden part or cue means no cue.
  function scanDeletions(s) {
    var out = [], i = 0, depth = 0, start = -1, sep = -1, SEP = cueSep(), L = SEP.length;
    while (i < s.length) {
      var len = runAt(s, i);
      if (len) { i += len; continue; }
      var ch = s[i];
      if (ch === "\\") { i += s.startsWith(SEP, i + 1) ? 1 + L : 2; continue; }
      if (ch === "{") { if (depth === 0) { start = i; sep = -1; } depth++; }
      else if (ch === "}" && depth > 0) {
        depth--;
        if (depth === 0) {
          var del = { start: start, end: i + 1, text: s.slice(start + 1, i) };
          if (sep >= 0) {
            var hidden = s.slice(start + 1, sep), cue = s.slice(sep + L, i).trim();
            if (hidden.trim() && cue) { del.text = hidden; del.cue = cue; }
          }
          out.push(del);
          start = -1;
        }
      }
      else if (depth === 1 && s.startsWith(SEP, i)) sep = i;
      i++;
    }
    return out;
  }
  function fallbackParse(text) {
    var st = splitTags(text), body = st.body, lines = body.split("\n"), qi = -1, ai = -1;
    for (var i = 0; i < lines.length; i++) {
      if (qi < 0 && /^\s*Q\./.test(lines[i])) qi = i;
      else if (qi >= 0 && /^\s*A\./.test(lines[i])) { ai = i; break; }
    }
    var base = { question: "", answer: "", body: body, deletions: [], tags: st.tags, display: body, lints: [] };
    if (qi >= 0 && ai > qi) {
      base.kind = "qa";
      base.question = [lines[qi].replace(/^\s*Q\.\s?/, "")].concat(lines.slice(qi + 1, ai)).join("\n").trim();
      base.answer = [lines[ai].replace(/^\s*A\.\s?/, "")].concat(lines.slice(ai + 1)).join("\n").trim();
      return base;
    }
    if (!body.trim()) { base.kind = "highlight"; return base; }
    if (qi >= 0) { base.kind = "note"; base.lints.push({ code: "no_answer", msg: "Add an A. line to make this reviewable" }); return base; }
    base.deletions = scanDeletions(body);
    base.kind = base.deletions.length ? "cloze" : "note";
    return base;
  }
  function parsePrompt(text, d) {
    if (d && d.prompts && typeof d.prompts.parse === "function") {
      try { var r = d.prompts.parse(String(text == null ? "" : text)); if (r && typeof r === "object" && r.kind) return r; } catch (e) { /* fall through */ }
    }
    return fallbackParse(text);
  }

  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  // Where a parsed deletion's cue separator sits inside `inner` (the text between its braces), −1 without a cue.
  // M.prompts.parse gives {text: the hidden part as typed, cue: trimmed}, so the separator follows the hidden part.
  function sepIn(inner, dl) {
    if (typeof dl.cue !== "string" || !dl.cue || typeof dl.text !== "string") return -1;
    var SEP = cueSep(), at = dl.text.length;
    return inner.slice(0, at) === dl.text && inner.startsWith(SEP, at) && inner.slice(at + SEP.length).trim() === dl.cue ? at : -1;
  }
  // Resolve parsed deletions to brace-inclusive spans in `text`, tolerating either offset convention. A span also
  // says where its cue separator is (`sep`, an offset into `text`; −1 without a cue).
  function resolveSpans(text, deletions) {
    var spans = [], pos = 0;
    (deletions || []).forEach(function (dl) {
      if (!dl) return;
      var inner = typeof dl.text === "string" ? dl.text : null, s = dl.start, e = dl.end;
      if (typeof s === "number" && typeof e === "number" && s >= pos && e > s && e <= text.length) {
        var seg = text.slice(s, e);
        if (seg[0] === "{" && seg[seg.length - 1] === "}") {
          var at = sepIn(seg.slice(1, -1), dl);
          if (inner === null || at >= 0 || norm(seg.slice(1, -1)) === norm(inner)) {
            spans.push({ start: s, end: e, sep: at < 0 ? -1 : s + 1 + at }); pos = e; return;
          }
        }
        if (inner !== null && text[s - 1] === "{" && text[e] === "}" && norm(seg) === norm(inner)) {
          spans.push({ start: s - 1, end: e + 1, sep: -1 }); pos = e + 1; return;
        }
      }
      if (inner !== null) {
        var idx = text.indexOf("{" + inner + "}", pos);
        if (idx >= 0) { spans.push({ start: idx, end: idx + inner.length + 2, sep: -1 }); pos = idx + inner.length + 2; }
      }
    });
    return spans;
  }
  // Anki reads the first "::" inside {{cN::…}} as the start of the hint. guardColons writes `colon` for every colon
  // that follows a colon (only in a typed `\::` when `escapedOnly` is true; else all of them, and a last colon too,
  // because the separator comes right after the hidden part), so no "::" is left for Anki to split at.
  // With colon ":" (no marker) the text comes back unchanged.
  function guardColons(s, colon, escapedOnly) {
    if (colon === ":") return s;
    if (escapedOnly) return s.indexOf("::") < 0 ? s : s.replace(/\\::/g, function () { return "\\:" + colon; });
    s = s.replace(/:{2,}/g, function (m) { return ":" + new Array(m.length).join(colon); });
    return s.charAt(s.length - 1) === ":" ? s.slice(0, -1) + colon : s;
  }
  // {x} → {{cN::x}}, N = 1-based deletion index; {x::cue} → {{cN::x::cue}}, Anki's hint form (FEATURES P1.1 d):
  // the hidden part as typed without the blanks before the separator, "::", the trimmed cue.
  // A "::" that belongs to the hidden part must not reach Anki as its separator: `colon` (default ":", which
  // changes nothing) is written for the second colon of every "::" in the hidden part of a deletion that has a cue,
  // and of every typed `\::` inside a deletion that has none. ankiRow passes a marker character and turns it into
  // &#58; once the HTML exists. A text with neither comes out exactly as it did before cues existed.
  function numberClozes(text, deletions, colon) {
    var spans = resolveSpans(text, deletions), out = "", cur = 0, L = cueSep().length;
    var c = typeof colon === "string" && colon ? colon : ":";
    spans.forEach(function (sp, k) {
      var inner = sp.sep >= 0
        ? guardColons(text.slice(sp.start + 1, sp.sep).replace(/\s+$/, ""), c, false) + "::" + text.slice(sp.sep + L, sp.end - 1).trim()
        : guardColons(text.slice(sp.start + 1, sp.end - 1), c, true);
      out += text.slice(cur, sp.start) + "{{c" + (k + 1) + "::" + inner + "}}";
      cur = sp.end;
    });
    return out + text.slice(cur);
  }
  // A private-use character that `text` does not hold: it stands for a guarded colon until the Anki HTML exists.
  // null when the text has no "::" at all (nothing to guard) or, absurdly, holds every candidate.
  function colonMark(text) {
    if (text.indexOf("::") < 0) return null;
    for (var code = 0xE000; code <= 0xF8FF; code++) {
      var ch = String.fromCharCode(code);
      if (text.indexOf(ch) < 0) return ch;
    }
    return null;
  }

  function fallbackAnki(text, images) {
    return escapeHtml(text).replace(new RegExp(IMAGE_TOKEN.source, "g"), function (m, id) {
      var u = urlFrom(images, id);
      return u ? '<img src="' + escapeHtml(u) + '">' : '<span class="att--missing">[image]</span>';
    }).replace(/\t/g, "").replace(/\r?\n/g, "<br>");
  }
  function fallbackMarkdown(text, images) {
    return String(text == null ? "" : text).replace(new RegExp(IMAGE_TOKEN.source, "g"), function (m, id) {
      var u = urlFrom(images, id);
      return u ? "![snip](" + u + ")" : m;
    });
  }
  function ankiHtml(text, d, images) {
    var html = null;
    if (d && d.markup && typeof d.markup.toAnki === "function") {
      try { html = d.markup.toAnki(String(text == null ? "" : text), images); } catch (e) { html = null; }
    }
    if (typeof html !== "string") html = fallbackAnki(text, images);
    return html.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
  }
  function mdText(text, d, images) {
    if (d && d.markup && typeof d.markup.toMarkdown === "function") {
      try { var r = d.markup.toMarkdown(String(text == null ? "" : text), images); if (typeof r === "string") return r; } catch (e) { /* fall through */ }
    }
    return fallbackMarkdown(text, images);
  }
  function contextLine(col, p, d) {
    if (d && d.context && typeof d.context.line === "function" && col) {
      try { var l = d.context.line(col, p); if (l) return String(l); } catch (e) { /* fall through */ }
    }
    var ctx = (p && p.context) || {}, name = ctx.docName || (col && (col.name || col.title)) || "";
    if (ctx.sectionLabel) return name ? name + " · " + ctx.sectionLabel : String(ctx.sectionLabel);
    if (ctx.pageLabel != null && ctx.pageLabel !== "" && !(col && col.kind === "deck")) return name ? name + " · p. " + ctx.pageLabel : "p. " + ctx.pageLabel;
    return name;
  }
  function pageLabelOf(p) {
    if (p.context && p.context.pageLabel != null && p.context.pageLabel !== "") return String(p.context.pageLabel);
    if (p.anchor && typeof p.anchor.pageIndex === "number") return String(p.anchor.pageIndex + 1);
    return null;
  }

  // -------------------------------------------------------------- JSON backup

  function stripChunkFields(c) {
    var out = clone(c);
    CHUNK_FIELDS.forEach(function (k) { delete out[k]; });
    return out;
  }
  // Referenced attachments only, each a raster image an import will accept.
  function pickAttachments(attachments, prompts, d) {
    var wanted = {}, max = maxImageBytes();
    prompts.forEach(function (p) { imageIds(p.text, d).forEach(function (id) { wanted[id] = true; }); });
    var seen = {}, out = [];
    (attachments || []).forEach(function (a) {
      if (!a || typeof a.id !== "string" || !hasOwn(wanted, a.id) || hasOwn(seen, a.id)) return;
      var x = exportableAttachment(a, max);
      if (!x) return;
      seen[x.id] = true;
      out.push(x);
    });
    return out.sort(function (a, b) { return cmpStr(a.id, b.id); });
  }

  function toJSON(opts) {
    opts = opts || {};
    var d = deps(), s = inScope(opts);
    var includeImages = opts.includeImages !== false;
    var prompts = s.prompts.map(clone).sort(byCreated);
    var backup = {
      format: FORMAT,
      version: VERSION,
      schedulerVersion: (d.scheduler && typeof d.scheduler.SCHEDULER_VERSION === "number") ? d.scheduler.SCHEDULER_VERSION : 1,
      exportedAt: typeof opts.now === "number" ? opts.now : Date.now(),
      scope: s.scope
    };
    if (s.scope === "collection") backup.collectionId = s.collectionId;
    backup.settings = pickSettings(opts.settings !== undefined ? opts.settings : settingsAll());
    // the library's folders (FEATURES L1.7), tombstones included; a one-collection export carries none (its folderId
    // finds its folder again only in a library that has it, else the import puts it at the top level)
    backup.folders = s.scope === "all" ? (Array.isArray(opts.folders) ? opts.folders : cacheFolders()).filter(isFolderRecord).map(clone).sort(byCreated) : [];
    backup.collections = s.collections.map(stripChunkFields).sort(byAdded);
    backup.prompts = prompts;
    backup.attachments = includeImages ? pickAttachments(opts.attachments, prompts, d) : [];
    return JSON.stringify(backup, null, 2);
  }

  // ---------------------------------------------------------------- Anki TSV

  function slugify(name) {
    var s = String(name == null ? "" : name).toLowerCase();
    try { s = s.normalize("NFKD").replace(/[̀-ͯ]/g, ""); } catch (e) { /* no normalize */ }
    return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function sanitizeDeck(name) {
    return String(name == null ? "" : name).replace(/::/g, ":").replace(/[\t\r\n]+/g, " ").trim() || "Inbox";
  }
  function cell(s) {
    s = String(s == null ? "" : s).replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
    if (s.indexOf('"') >= 0) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function sourceExtra(p, col, d) {
    var parts = [], line = contextLine(col, p, d), quote = p.anchor && p.anchor.quote ? String(p.anchor.quote) : "";
    if (line) parts.push(escapeHtml(line));
    if (quote) parts.push(escapeHtml(quote));
    return parts.join("<br>");
  }
  function ankiRow(p, col, d, images, includeImages) {
    var text = includeImages ? String(p.text || "") : stripImages(p.text);
    var parsed = parsePrompt(text, d), kind = parsed.kind;
    if (kind !== "qa" && kind !== "cloze") return null;
    var deck = "Marginalia::" + sanitizeDeck(col ? (col.name || col.title) : "");
    var tags = ["marginalia"], slug = slugify(col && (col.name || col.title));
    if (slug) tags.push(slug);
    (Array.isArray(parsed.tags) ? parsed.tags : (Array.isArray(p.tags) ? p.tags : [])).forEach(function (t) {
      t = String(t).replace(/\s+/g, "-");
      if (t && tags.indexOf(t) < 0) tags.push(t);
    });
    var extra = sourceExtra(p, col, d);
    if (kind === "qa") {
      var front = ankiHtml(parsed.question, d, images), back = ankiHtml(parsed.answer, d, images);
      if (extra) back += (back ? "<br><br>" : "") + extra;
      return ["Basic", cell(deck), cell(front), cell(back), cell(tags.join(" "))];
    }
    var mark = colonMark(text);
    var body = stripTagsLine(numberClozes(text, parsed.deletions, mark), d);
    var html = ankiHtml(body, d, images);
    if (mark) html = html.split(mark).join("&#58;");       // a guarded colon: Anki shows ":" and finds no "::" there
    return ["Cloze", cell(deck), cell(html), cell(extra), cell(tags.join(" "))];
  }
  // Live prompts grouped by live collection in reading order, then prompts with no known collection. A deleted
  // collection contributes nothing (as in toMarkdown and M.cache.counts), even if a prompt in it is still live.
  function groupedPrompts(s) {
    var cols = s.collections.slice().sort(byAdded), byId = {}, out = [];
    cols.forEach(function (c) { byId[c.id] = c; });
    cols.forEach(function (c) {
      if (!live(c)) return;
      out = out.concat(s.prompts.filter(function (p) { return live(p) && p.collectionId === c.id; }).sort(readingOrderFor(c)));
    });
    out = out.concat(s.prompts.filter(function (p) { return live(p) && !byId[p.collectionId]; }).sort(byCreated));
    return { list: out, byId: byId };
  }

  function toAnkiTSV(opts) {
    opts = opts || {};
    var d = deps(), s = inScope(opts), includeImages = opts.includeImages !== false;
    var images = imageMap(opts.attachments, includeImages), g = groupedPrompts(s);
    var lines = ["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:5"];
    g.list.forEach(function (p) {
      var row = ankiRow(p, g.byId[p.collectionId] || null, d, images, includeImages);
      if (row) lines.push(row.join("\t"));
    });
    return lines.join("\n") + "\n";
  }

  // ----------------------------------------------------------------- Markdown

  function mdHeading(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function quoteBlock(s) { return String(s == null ? "" : s).split("\n").map(function (l) { return "> " + l; }).join("\n"); }

  function toMarkdown(opts) {
    opts = opts || {};
    var d = deps(), s = inScope(opts), includeImages = opts.includeImages !== false;
    var images = imageMap(opts.attachments, includeImages), out = [];
    s.collections.slice().sort(byAdded).forEach(function (col) {
      if (!live(col)) return;
      var ps = s.prompts.filter(function (p) { return live(p) && p.collectionId === col.id; }).sort(readingOrderFor(col));
      if (!ps.length) return;
      out.push("# " + mdHeading(col.name || col.title || "Untitled"), "");
      var section = null;
      ps.forEach(function (p) {
        var label = (p.context && p.context.sectionLabel) || null;
        if (label !== section) { section = label; if (label) out.push("## " + mdHeading(label), ""); }
        var text = includeImages ? String(p.text || "") : stripImages(p.text);
        var parsed = parsePrompt(text, d), body = mdText(text, d, images).replace(/\s+$/, "");
        if (parsed.kind === "note") body = quoteBlock(body);
        else if (parsed.kind === "highlight" || !body.trim()) {
          var q = p.anchor && p.anchor.quote ? String(p.anchor.quote) : "";
          if (!q) return;
          body = quoteBlock(q);
        }
        out.push(body, "");
        var page = col.kind === "deck" ? null : pageLabelOf(p);
        if (page) out.push("*(p. " + page + ")*", "");
      });
    });
    return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  }

  // -------------------------------------------------------------------- merge

  function unionLogs(a, b) {
    var seen = {}, out = [];
    (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach(function (e) {
      if (!e || typeof e.at !== "number") return;
      if (seen[e.at]) return;
      seen[e.at] = true;
      out.push(clone(e));
    });
    return out.sort(function (x, y) { return x.at - y.at; });
  }
  function sameLog(a, b) {
    a = Array.isArray(a) ? a : []; b = Array.isArray(b) ? b : [];
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!b[i] || a[i].at !== b[i].at || a[i].outcome !== b[i].outcome) return false;
    return true;
  }
  function deriveDueAt(p) {
    if (!p.deletedAt && (p.kind === "qa" || p.kind === "cloze") && Array.isArray(p.cards) && p.cards.length) {
      var min = Infinity;
      p.cards.forEach(function (c) { if (c && typeof c.dueAt === "number" && c.dueAt < min) min = c.dueAt; });
      if (min !== Infinity) { p.dueAt = min; return p; }
    }
    delete p.dueAt;
    return p;
  }
  function normalizePrompt(p) {
    if (!Array.isArray(p.cards)) p.cards = [];
    if (!Array.isArray(p.tags)) p.tags = [];
    if (typeof p.flagged !== "boolean") p.flagged = !!p.flagged;
    p.deletedAt = stampOf(p.deletedAt);
    if (typeof p.contentUpdatedAt !== "number") p.contentUpdatedAt = num(p.createdAt);
    if (typeof p.updatedAt !== "number") p.updatedAt = p.contentUpdatedAt;
    if (typeof p.createdAt !== "number") p.createdAt = p.contentUpdatedAt;
    if (hasOwn(p, "revisedAt") && !(typeof p.revisedAt === "number" && isFinite(p.revisedAt))) delete p.revisedAt;   // FIXES-1 FIX-5
    return deriveDueAt(p);
  }
  function normalizeCollection(c) {
    c.deletedAt = stampOf(c.deletedAt);
    if (!Array.isArray(c.sections)) c.sections = [];
    if (typeof c.updatedAt !== "number") c.updatedAt = num(c.addedAt);
    return c;
  }

  // When the user-authored fields last changed: contentUpdatedAt when the record carries one, else updatedAt
  // (an upper bound: every write, scroll-position and last-opened saves included, stamps updatedAt).
  function contentStamp(c) { return typeof c.contentUpdatedAt === "number" && isFinite(c.contentUpdatedAt) ? c.contentUpdatedAt : num(c.updatedAt); }
  function isManualMark(s) { return !!s && typeof s === "object" && s.source === "manual" && typeof s.pageIndex === "number" && isFinite(s.pageIndex); }
  // The content winner's sections plus the other side's manual chapter marks on pages where the winner has none
  // (outline items come from the PDF and follow the winner). Used when the two sides cannot be ordered by a
  // content stamp: a mark is user data and an import never drops one (a mark removed on one side may come back).
  function mergeSections(win, other) {
    var out = (Array.isArray(win) ? win : []).map(clone), marked = {};
    out.forEach(function (s) { if (isManualMark(s)) marked[s.pageIndex] = true; });
    var extra = (Array.isArray(other) ? other : []).filter(function (s) {
      if (!isManualMark(s) || marked[s.pageIndex]) return false;
      marked[s.pageIndex] = true;
      return true;
    });
    if (!extra.length) return out;
    function page(s) { return s && typeof s.pageIndex === "number" && isFinite(s.pageIndex) ? s.pageIndex : 0; }
    return out.concat(extra.map(clone)).map(function (s, k) { return { s: s, k: k }; })
      .sort(function (a, b) { return (page(a.s) - page(b.s)) || (a.k - b.k); })
      .map(function (e) { return e.s; });
  }

  // View state and other fields (lastPosition, lastOpenedAt, title, …) follow the newer updatedAt; the nickname and
  // deck description follow the newer content stamp; storage fields stay local. Sections follow the content winner
  // when both sides carry contentUpdatedAt (so a removed mark stays removed), else the manual marks of both sides
  // are kept — either way a scroll or an open on one side never discards a mark made on the other.
  function mergeCollection(local, inc) {
    var lUp = num(local.updatedAt), iUp = num(inc.updatedAt);
    var lDel = stampOf(local.deletedAt), iDel = stampOf(inc.deletedAt);
    var winner = iUp > lUp ? inc : local, merged = clone(local);
    Object.keys(winner).forEach(function (k) {
      if (COLLECTION_LOCAL_FIELDS.indexOf(k) >= 0 || COLLECTION_CONTENT_FIELDS.indexOf(k) >= 0 || COLLECTION_FOLDER_FIELDS.indexOf(k) >= 0 || k === "deletedAt") return;
      merged[k] = clone(winner[k]);
    });
    // the folder follows the newer folderUpdatedAt (FEATURES L1.7): a move is an edit of its own, which neither a
    // scroll on the other side (updatedAt) nor a rename (contentUpdatedAt) outranks
    var lF = num(local.folderUpdatedAt), iF = num(inc.folderUpdatedAt);
    if (iF > lF) {
      merged.folderId = typeof inc.folderId === "string" && inc.folderId ? inc.folderId : null;
      merged.folderUpdatedAt = iF;
    }
    var lC = contentStamp(local), iC = contentStamp(inc), cWin = iC > lC ? inc : local, cLose = cWin === inc ? local : inc;
    var stamped = typeof local.contentUpdatedAt === "number" && typeof inc.contentUpdatedAt === "number";
    ["name", "description"].concat(stamped ? ["sections"] : []).forEach(function (k) { if (hasOwn(cWin, k)) merged[k] = clone(cWin[k]); });
    if (!stamped && (Array.isArray(local.sections) || Array.isArray(inc.sections))) merged.sections = mergeSections(cWin.sections, cLose.sections);
    if (typeof local.contentUpdatedAt === "number" || typeof inc.contentUpdatedAt === "number") merged.contentUpdatedAt = Math.max(lC, iC);
    if (lDel && iDel) merged.deletedAt = Math.max(lDel, iDel);
    else if (lDel) merged.deletedAt = lDel > iUp ? lDel : null;
    else if (iDel) merged.deletedAt = iDel > lUp ? iDel : null;
    else merged.deletedAt = null;
    merged.updatedAt = Math.max(lUp, iUp);
    return merged;
  }

  // The cards a prompt's text implies, as M.prompts.reconcileCards keeps them: qa 1, cloze one per deletion;
  // null for notes and highlights (their cards persist through kind changes) or when text and kind disagree.
  function impliedCards(p, d) {
    if (!p || (p.kind !== "qa" && p.kind !== "cloze") || typeof p.text !== "string") return null;
    var parsed = parsePrompt(p.text, d);
    if (!parsed || parsed.kind !== p.kind) return null;
    if (p.kind === "qa") return 1;
    return Array.isArray(parsed.deletions) ? parsed.deletions.length : null;
  }
  // Drops cards beyond what the text implies (a merge can carry the losing side's extra cards; a surplus card has no blank).
  function capCards(p, d) {
    var n = impliedCards(p, d);
    if (n !== null && Array.isArray(p.cards) && p.cards.length > n) p.cards = p.cards.slice(0, n);
    return p;
  }

  // The send record (BUILD-NOTES "Obsidian"; not content) on `merged`, from the library's record `local` and the
  // backup's `inc`:
  // - when and where the note last went to Obsidian: the later send of either side, with its note path (the other
  //   side's when the later send recorded none);
  // - the pending marker (obsidianPendingFile, FEATURES A9: the note a server send that did not finish was writing to,
  //   which may hold the card's copy): the doubt of either side counts, the local record's first, else the backup's,
  //   so a library that already holds the card (a claude.ai copy that imported it before) learns of the other
  //   library's unfinished send, and its obsidian:// links leave the card alone. A marker goes only when the other
  //   side shows that doubt settled: it holds no marker and recorded a send into that very note later than the
  //   marker's side did (repair D1 of the A9 review, 2026-11-10).
  function fileOf(p) { return typeof p.obsidianFile === "string" && p.obsidianFile ? p.obsidianFile : null; }
  function pendingOf(p) { return typeof p.obsidianPendingFile === "string" && p.obsidianPendingFile ? p.obsidianPendingFile : null; }
  function mergeSendRecord(merged, local, inc) {
    var lS = num(local.obsidianSentAt), iS = num(inc.obsidianSentAt), sent = Math.max(lS, iS);
    if (sent > 0) merged.obsidianSentAt = sent;
    var lF = fileOf(local), iF = fileOf(inc);
    var sentFile = iS > lS ? (iF || lF) : (lF || iF);
    if (sentFile) merged.obsidianFile = sentFile; else delete merged.obsidianFile;
    var pend = pendingOf(local) || pendingOf(inc), side = pendingOf(local) ? local : inc, other = side === local ? inc : local;
    if (pend && !pendingOf(other) && num(other.obsidianSentAt) > num(side.obsidianSentAt) && fileOf(other) === pend) pend = null;
    if (pend) merged.obsidianPendingFile = pend; else delete merged.obsidianPendingFile;
    return merged;
  }

  function mergePrompt(local, inc, scheduler, d) {
    var lC = num(local.contentUpdatedAt), iC = num(inc.contentUpdatedAt);
    var lDel = stampOf(local.deletedAt), iDel = stampOf(inc.deletedAt);
    var winner = iC > lC ? inc : local, merged = clone(local);
    PROMPT_CONTENT_FIELDS.forEach(function (k) { if (hasOwn(winner, k)) merged[k] = clone(winner[k]); });
    if (!hasOwn(winner, "revisedAt")) delete merged.revisedAt;
    if (lDel && iDel) merged.deletedAt = Math.max(lDel, iDel);
    else if (lDel) merged.deletedAt = lDel > iC ? lDel : null;
    else if (iDel) merged.deletedAt = iDel > lC ? iDel : null;
    else merged.deletedAt = null;
    var lc = Array.isArray(local.cards) ? local.cards : [], ic = Array.isArray(inc.cards) ? inc.cards : [];
    var n = Math.max(lc.length, ic.length), cards = [];
    for (var i = 0; i < n; i++) {
      var a = lc[i], b = ic[i];
      if (!b) { cards.push(clone(a)); continue; }
      if (!a) { cards.push(clone(b)); continue; }
      var union = unionLogs(a.log, b.log);
      if (sameLog(union, a.log)) { cards.push(clone(a)); continue; }
      if (!scheduler || typeof scheduler.replay !== "function") throw err("no_scheduler", "M.scheduler.replay is required to merge review logs");
      var createdAt = Math.min(typeof a.createdAt === "number" ? a.createdAt : Infinity, typeof b.createdAt === "number" ? b.createdAt : Infinity);
      if (createdAt === Infinity) createdAt = num(local.createdAt) || num(inc.createdAt);
      var replayed = scheduler.replay(createdAt, union);
      cards.push(Object.assign({ i: typeof a.i === "number" ? a.i : i }, clone(replayed)));
    }
    merged.cards = cards;
    capCards(merged, d);
    mergeSendRecord(merged, local, inc);
    merged.updatedAt = Math.max(num(local.updatedAt), num(inc.updatedAt));
    if (typeof merged.createdAt !== "number") merged.createdAt = num(inc.createdAt);
    return deriveDueAt(merged);
  }

  // ------------------------------------------------------------ folders (FEATURES L1.7; BUILD-NOTES "Library folders")

  function isFolderRecord(f) { return !!f && typeof f === "object" && typeof f.id === "string" && !!f.id && f.id.length <= 200; }
  function folderLive(f) { return !stampOf(f.deletedAt); }
  // A backup's folder as the merge reads it: name a string, parentId a string or null (never the folder itself), the
  // stamps numbers, deletedAt a tombstone stamp or null; any other field rides along.
  function normalizeFolder(f) {
    var out = clone(f);
    out.name = typeof f.name === "string" ? f.name : String(f.name == null ? "" : f.name);
    out.parentId = typeof f.parentId === "string" && f.parentId && f.parentId !== f.id ? f.parentId : null;
    if (typeof out.createdAt !== "number" || !isFinite(out.createdAt)) out.createdAt = num(f.updatedAt);
    if (typeof out.updatedAt !== "number" || !isFinite(out.updatedAt)) out.updatedAt = num(out.createdAt);
    out.deletedAt = stampOf(f.deletedAt);
    if (hasOwn(out, "__proto__")) delete out["__proto__"];           // a hand-made backup never sets a prototype
    return out;
  }
  // The later updatedAt wins for the name and the parent (every field but the stamps); a tombstone wins over the other
  // side's record when it is newer than that side's updatedAt, as for collections.
  function mergeFolder(local, inc) {
    var lUp = num(local.updatedAt), iUp = num(inc.updatedAt);
    var lDel = stampOf(local.deletedAt), iDel = stampOf(inc.deletedAt);
    var win = iUp > lUp ? inc : local, merged = clone(local);
    Object.keys(win).forEach(function (k) {
      if (k !== "id" && k !== "createdAt" && k !== "updatedAt" && k !== "deletedAt" && k !== "__proto__") merged[k] = clone(win[k]);
    });
    if (lDel && iDel) merged.deletedAt = Math.max(lDel, iDel);
    else if (lDel) merged.deletedAt = lDel > iUp ? lDel : null;
    else if (iDel) merged.deletedAt = iDel > lUp ? iDel : null;
    else merged.deletedAt = null;
    merged.updatedAt = Math.max(lUp, iUp);
    return merged;
  }
  // Folders by id, then every live folder's parent made to name a live folder: a parent missing after the merge → the
  // top level, a deleted one → the nearest live folder above it (a tombstone keeps its parent, so this is where the
  // folder's delete moved its contents), and a loop is cut at its newest folder (updatedAt, then id), which goes to the
  // top level. The stamps stay as merged: an import is not an edit. → {list, resolve(ref) → live folder id|null}; the
  // report gets folders {added, updated, unchanged, skipped, removed} and changed.folders (the records to store).
  function mergeFolders(localList, incList, report) {
    var locals = (Array.isArray(localList) ? localList : []).filter(isFolderRecord);
    var list = [], at = {}, localById = {}, mentioned = {};
    locals.forEach(function (f) { if (hasOwn(at, f.id)) return; at[f.id] = list.length; list.push(f); localById[f.id] = f; });
    (Array.isArray(incList) ? incList : []).forEach(function (raw) {
      if (!isFolderRecord(raw)) { report.folders.skipped++; return; }
      var inc = normalizeFolder(raw);
      mentioned[inc.id] = true;
      if (!hasOwn(at, inc.id)) { at[inc.id] = list.length; list.push(inc); return; }
      list[at[inc.id]] = mergeFolder(list[at[inc.id]], inc);
    });
    var byId = {};
    list.forEach(function (f) { byId[f.id] = f; });
    function resolve(ref) {
      var cur = ref, steps = 0;
      while (typeof cur === "string" && cur && steps++ <= list.length) {
        var f = byId[cur];
        if (!f) return null;
        if (folderLive(f)) return cur;
        cur = f.parentId;
      }
      return null;
    }
    var parent = {}, state = {};
    list.forEach(function (f) { if (folderLive(f)) parent[f.id] = resolve(f.parentId); });
    Object.keys(parent).forEach(function (start) {
      if (state[start] === 2) return;
      var path = [], cur = start;
      while (cur !== null && state[cur] !== 2) {
        if (state[cur] === 1) {
          var loop = path.slice(path.indexOf(cur)), cut = loop[0];
          loop.forEach(function (id) {
            var a = byId[id], b = byId[cut];
            if (num(a.updatedAt) > num(b.updatedAt) || (num(a.updatedAt) === num(b.updatedAt) && cmpStr(a.id, b.id) > 0)) cut = id;
          });
          parent[cut] = null;
          break;
        }
        state[cur] = 1;
        path.push(cur);
        cur = parent[cur];
      }
      path.forEach(function (id) { state[id] = 2; });
    });
    list = list.map(function (f) {
      if (!folderLive(f) || !hasOwn(parent, f.id)) return f;
      var stored = typeof f.parentId === "string" && f.parentId ? f.parentId : null;
      if (parent[f.id] === stored) return f;
      var rec = clone(f);
      rec.parentId = parent[f.id];
      byId[f.id] = rec;
      return rec;
    });
    list.forEach(function (f) {
      var l = hasOwn(localById, f.id) ? localById[f.id] : null;
      if (!l) { report.folders.added++; report.changed.folders.push(f); return; }
      if (same(f, l)) { if (mentioned[f.id]) report.folders.unchanged++; return; }
      report.folders.updated++;
      if (folderLive(l) && !folderLive(f)) report.folders.removed++;
      report.changed.folders.push(f);
    });
    return { list: list, resolve: resolve };
  }

  // report: added/updated/unchanged/skipped count the backup's prompts; cascaded counts local prompts tombstoned
  // because their collection is deleted by this import; collections.removed counts collections it deletes;
  // attachments.bytes is the decoded size of the images it adds.
  function merge(localState, backup) {
    localState = localState || {}; backup = backup || {};
    var scheduler = opt("scheduler"), d = deps();
    var report = {
      added: 0, updated: 0, unchanged: 0, skipped: 0, cascaded: 0,
      collections: { added: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0 },
      attachments: { added: 0, unchanged: 0, skipped: 0, bytes: 0 },
      folders: { added: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0 },
      changed: { collections: [], prompts: [], attachments: [], folders: [] }
    };
    // Folders first (FEATURES L1.7): the books and decks below are put in the folders as merged
    var fm = mergeFolders(localState.folders, backup.folders, report);

    // Collections: by id, then books by sha256, else created (hasBytes: false).
    var cols = (Array.isArray(localState.collections) ? localState.collections : []).slice();
    var colIdx = {}, shaIdx = {}, idMap = {}, killed = Object.create(null), changedAt = {}, sameAt = {};
    var wasLive = cols.map(function (c) { return live(c); });
    cols.forEach(function (c, i) {
      if (!c || typeof c.id !== "string") return;
      colIdx[c.id] = i;
      if (c.kind === "book" && typeof c.sha256 === "string" && c.sha256 && (!hasOwn(shaIdx, c.sha256) || (cols[shaIdx[c.sha256]].deletedAt && !c.deletedAt))) shaIdx[c.sha256] = i;
    });
    // A local collection is matched once: the sha256 fallback never takes one that an incoming record matches by id
    // (two separate books of one PDF share a sha256), so a tombstone of one copy can never delete the other.
    var claimed = {};
    (Array.isArray(backup.collections) ? backup.collections : []).forEach(function (inc) {
      if (inc && typeof inc === "object" && typeof inc.id === "string" && hasOwn(colIdx, inc.id)) claimed[colIdx[inc.id]] = true;
    });
    (Array.isArray(backup.collections) ? backup.collections : []).forEach(function (inc) {
      if (!inc || typeof inc !== "object" || typeof inc.id !== "string" || !inc.id) { report.collections.skipped++; return; }
      var idx = hasOwn(colIdx, inc.id) ? colIdx[inc.id] : -1;
      if (idx < 0 && inc.kind === "book" && typeof inc.sha256 === "string" && inc.sha256 && hasOwn(shaIdx, inc.sha256) && !claimed[shaIdx[inc.sha256]]) {
        idx = shaIdx[inc.sha256];
        claimed[idx] = true;
      }
      if (idx < 0) {
        var created = stripChunkFields(inc);
        if (created.kind === "book") created.hasBytes = false;
        normalizeCollection(created);
        idMap[inc.id] = created.id;
        claimed[cols.length] = true;
        colIdx[created.id] = cols.length;
        if (created.kind === "book" && created.sha256 && !hasOwn(shaIdx, created.sha256)) shaIdx[created.sha256] = cols.length;
        changedAt[cols.length] = report.changed.collections.length;
        cols.push(created);
        report.collections.added++;
        report.changed.collections.push(created);
        return;
      }
      var local = cols[idx];
      idMap[inc.id] = local.id;
      var merged = mergeCollection(local, inc);
      if (same(merged, local)) { report.collections.unchanged++; sameAt[idx] = true; return; }
      if (sameAt[idx]) { report.collections.unchanged--; delete sameAt[idx]; }
      cols[idx] = merged;
      report.collections.updated++;
      // one entry per collection, its final merged state (a backup listing a record twice is written once)
      if (hasOwn(changedAt, idx)) report.changed.collections[changedAt[idx]] = merged;
      else { changedAt[idx] = report.changed.collections.length; report.changed.collections.push(merged); }
    });
    // A live book or deck sits in a live folder or at the top level (FEATURES L1.7): a folderId that names a folder
    // deleted after the merge means the nearest live folder above it, one that names no folder the top level.
    cols.forEach(function (c, i) {
      if (!c || !live(c) || typeof c.folderId !== "string" || !c.folderId) return;
      var to = fm.resolve(c.folderId);
      if (to === c.folderId) return;
      if (hasOwn(changedAt, i)) { c.folderId = to; return; }       // a record this merge made: ours to change
      var rec = clone(c);
      rec.folderId = to;
      cols[i] = rec;
      if (sameAt[i]) { report.collections.unchanged--; delete sameAt[i]; }
      report.collections.updated++;
      changedAt[i] = report.changed.collections.length;
      report.changed.collections.push(rec);
    });
    // Collections this import deletes: live here before, a tombstone after the merge.
    wasLive.forEach(function (was, i) {
      if (was && cols[i].deletedAt) { killed[cols[i].id] = cols[i].deletedAt; report.collections.removed++; }
    });

    // A prompt never stays live in a deleted collection (§8: deleting a collection tombstones its prompts): a backup
    // prompt that resolves to a collection that is a tombstone after the merge is tombstoned with that collection's
    // deletedAt (the stamp M.cache.removeCollection uses and restoreCollection matches).
    var deadAt = Object.create(null);
    cols.forEach(function (c) { if (c && typeof c.id === "string" && c.deletedAt) deadAt[c.id] = c.deletedAt; });
    function entomb(p) {
      if (live(p) && typeof p.collectionId === "string" && hasOwn(deadAt, p.collectionId)) { p.deletedAt = deadAt[p.collectionId]; deriveDueAt(p); }
      return p;
    }

    // Prompts: by id.
    var prompts = (Array.isArray(localState.prompts) ? localState.prompts : []).slice();
    var pIdx = {}, touched = Object.create(null);
    prompts.forEach(function (p, i) { if (p && typeof p.id === "string") pIdx[p.id] = i; });
    (Array.isArray(backup.prompts) ? backup.prompts : []).forEach(function (raw) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) { report.skipped++; return; }
      var inc = clone(raw);
      if (typeof inc.collectionId === "string" && hasOwn(idMap, inc.collectionId)) inc.collectionId = idMap[inc.collectionId];
      if (!hasOwn(pIdx, inc.id)) {
        // unknown prompt: it needs a resolvable collection (local, matched or just created)
        if (typeof inc.collectionId !== "string" || !hasOwn(colIdx, inc.collectionId)) { report.skipped++; return; }
        var added = deriveDueAt(entomb(capCards(normalizePrompt(inc), d)));
        touched[added.id] = true;
        pIdx[added.id] = prompts.length;
        prompts.push(added);
        report.added++;
        report.changed.prompts.push(added);
        return;
      }
      var local = prompts[pIdx[inc.id]];
      touched[inc.id] = true;
      var merged = mergePrompt(local, inc, scheduler, d);
      if (typeof merged.collectionId !== "string" || !hasOwn(colIdx, merged.collectionId)) merged.collectionId = local.collectionId;
      entomb(merged);
      if (same(merged, local)) { report.unchanged++; return; }
      prompts[pIdx[inc.id]] = merged;
      report.updated++;
      report.changed.prompts.push(merged);
    });
    // The cascade for local prompts the backup does not mention, in collections this import deletes.
    if (Object.keys(killed).length) prompts.forEach(function (p, i) {
      if (!live(p) || typeof p.id !== "string" || hasOwn(touched, p.id) || typeof p.collectionId !== "string" || !hasOwn(killed, p.collectionId)) return;
      var t = clone(p);
      t.deletedAt = killed[p.collectionId];
      deriveDueAt(t);
      prompts[i] = t;
      report.cascaded++;
      report.changed.prompts.push(t);
    });

    // Attachments: by id, existing kept. A new one is stored only when it is a raster image (its signature, not its
    // declared mime, decides: SVG/HTML never get in) within the attachment size limit, with sane dimensions.
    var atts = (Array.isArray(localState.attachments) ? localState.attachments : []).map(function (a) { return typeof a === "string" ? { id: a } : a; });
    var aIds = Object.create(null), maxImage = maxImageBytes();
    atts.forEach(function (a) { if (a && typeof a.id === "string") aIds[a.id] = true; });
    (Array.isArray(backup.attachments) ? backup.attachments : []).forEach(function (a) {
      if (!a || typeof a !== "object" || typeof a.id !== "string" || !ATT_ID.test(a.id)) { report.attachments.skipped++; return; }
      if (aIds[a.id]) { report.attachments.unchanged++; return; }
      var ok = importableAttachment(a, maxImage);
      if (!ok) { report.attachments.skipped++; return; }
      aIds[a.id] = true;
      atts.push(ok.record);
      report.attachments.added++;
      report.attachments.bytes += ok.size;
      report.changed.attachments.push(ok.record);
    });

    return { state: { collections: cols, prompts: prompts, attachments: atts, folders: fm.list }, report: report };
  }

  // ------------------------------------------------------------------- bytes

  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (typeof ArrayBuffer !== "undefined" && bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (bytes && bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
    return new Uint8Array(0);
  }
  function bytesToBase64(u8) {
    u8 = toU8(u8);
    if (typeof btoa === "function") {
      var s = "", CH = 0x8000;
      for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(s);
    }
    var out = "";
    for (var j = 0; j < u8.length; j += 3) {
      var a = u8[j], b = u8[j + 1], c = u8[j + 2], hasB = j + 1 < u8.length, hasC = j + 2 < u8.length;
      out += B64[a >> 2] + B64[((a & 3) << 4) | (hasB ? b >> 4 : 0)] + (hasB ? B64[((b & 15) << 2) | (hasC ? c >> 6 : 0)] : "=") + (hasC ? B64[c & 63] : "=");
    }
    return out;
  }
  function base64ToBytes(b64) {
    var s = String(b64 == null ? "" : b64).replace(/[^A-Za-z0-9+/=]/g, "");
    if (typeof atob === "function") {
      var bin = atob(s), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    var clean = s.replace(/=+$/, ""), out = [], bits = 0, acc = 0;
    for (var j = 0; j < clean.length; j++) {
      var v = B64.indexOf(clean[j]);
      if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
    }
    return new Uint8Array(out);
  }
  function utf8Length(str) {
    if (typeof TextEncoder === "function") { try { return new TextEncoder().encode(str).length; } catch (e) { /* fall through */ } }
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = "0" + s; return s; }
  function localDate(now) { var d = new Date(now); return pad(d.getFullYear(), 4) + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fmtBytes(n) {
    var u = opt("util");
    if (u && typeof u.fmtBytes === "function") { try { return u.fmtBytes(n); } catch (e) { /* fall through */ } }
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function normalizeFormat(format) {
    var f = String(format == null ? "json" : format).toLowerCase();
    if (f === "md") f = "markdown";
    if (f === "tsv" || f === "anki-tsv") f = "anki";
    if (!MIME[f]) throw err("bad_format", "Unknown export format: " + format);
    return f;
  }
  function filenameFor(format, now) {
    if (format === "json") return "marginalia-backup-" + localDate(now) + ".json";
    if (format === "anki") return "marginalia-anki.txt";
    return "marginalia.md";
  }

  // ------------------------------------------------------------- async parts

  function parseBackup(text) {
    var backup;
    if (text && typeof text === "object") backup = text;
    else {
      try { backup = JSON.parse(String(text == null ? "" : text)); } catch (e) { throw err("invalid_json", "That is not valid JSON"); }
    }
    if (!backup || typeof backup !== "object" || backup.format !== FORMAT) throw err("bad_format", "Not a Marginalia backup");
    if (backup.version !== VERSION) throw err("unsupported_version", "This backup needs a newer Marginalia (backup version " + backup.version + ")");
    var records = 0;
    ["collections", "prompts", "attachments", "folders"].forEach(function (k) { if (Array.isArray(backup[k])) records += backup[k].length; });
    if (records > MAX_IMPORT_RECORDS) {
      throw err("too_many_records", "This backup holds " + records + " items (collections, prompts and images); one import takes at most " + MAX_IMPORT_RECORDS + ". Export one book or deck at a time.");
    }
    return backup;
  }
  // `a` is a record merge() accepted (importableAttachment): canonical base64 of a raster image of the sniffed mime.
  function toStoredAttachment(a) {
    var u8 = base64ToBytes(a.data);
    return { id: a.id, mime: a.mime, bytes: u8.buffer, width: dimOf(a.width), height: dimOf(a.height), byteLength: u8.length, createdAt: Date.now() };
  }
  // A collection that was live here and is a tombstone after the merge goes through M.cache.removeCollection with
  // the backup's deletedAt (§8 cascade: its live prompts tombstoned with that stamp, a book's chunks deleted,
  // hasBytes false), then the merged record is saved with the storage fields the cascade left.
  async function removeAsImported(cache, store, col) {
    if (typeof cache.removeCollection === "function") await cache.removeCollection(col.id, { now: col.deletedAt });
    else if (col.kind === "book" && store && store.docs && typeof store.docs.deleteBytes === "function") await store.docs.deleteBytes(col.id);
    if (col.kind === "book") { col.hasBytes = false; col.chunkCount = 0; }
    await cache.saveCollection(col, { now: num(col.updatedAt), content: false });
  }

  // FEATURES A10.1 (BUILD-NOTES "Obsidian"): while an import runs, M.obsidian sends nothing. The merge below is made
  // from the library as it is when the import begins and its records are saved one after another, so until the last
  // one is saved a card may still lack the marker its backup carries (obsidianPendingFile: a server send of it did not
  // finish, so its note may hold it already), and a send in that window could add it to Obsidian a second time. The
  // count goes up synchronously when importJSON is called (an async function runs up to its first await at once, so
  // before the first write) and down in a finally, so no error, early refusal or late failure leaves it up.
  // isImporting() → true while any import runs. When it ends, success or failure, "import:finished" {report, error}
  // (report: the import's report or null; error: the failure's code or "error", or null) tells M.backup to reconnect
  // the PDFs of the books it added from the backup folder (FEATURES B9.5).
  var importsRunning = 0;
  function isImporting() { return importsRunning > 0; }
  // D31 (the windows of the Mac app): an import is many writes. This window takes the writer role first, so the
  // backup is merged into the library as it is now, and keeps the role until the import has ended (M.store.during).
  // Outside the Mac app both do nothing.
  function ownRole() {
    var a = opt("app");
    try { return a && typeof a.takeRole === "function" ? Promise.resolve(a.takeRole()) : Promise.resolve(true); }
    catch (e) { return Promise.resolve(true); }
  }
  function keepRole(work) {
    var s = M.store;
    return s && typeof s.during === "function" ? s.during(work) : Promise.resolve().then(work);
  }
  async function importJSON(text, opts) {
    importsRunning++;
    var report = null, failure = null;
    try {
      report = await keepRole(function () {
        return ownRole().then(function (ok) {
          if (ok !== true) throw err("locked", "Another Marginalia window is writing. Try the import again.");
          return importInto(text, opts);
        });
      });
      return report;
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      importsRunning = importsRunning > 0 ? importsRunning - 1 : 0;
      var bus = opt("bus");
      if (bus && typeof bus.emit === "function") {
        try { bus.emit("import:finished", { report: report, error: failure ? String((failure && failure.code) || "error") : null }); }
        catch (e2) { /* listeners are isolated by the bus */ }
      }
    }
  }
  async function importInto(text, opts) {
    opts = opts || {};
    if (typeof text === "string" && text.length > MAX_IMPORT_FILE) throw err("too_large", "This backup is larger than " + fmtBytes(MAX_IMPORT_FILE) + " and cannot be imported.");
    var backup = parseBackup(text);
    var cache = M.cache, store = M.store;
    if (!cache || typeof cache.savePrompt !== "function" || typeof cache.saveCollection !== "function") throw err("no_store", "Storage is not ready");
    var attIds = [];
    try { if (store && store.attachments && typeof store.attachments.allIds === "function") attIds = (await store.attachments.allIds()) || []; } catch (e) { attIds = []; }
    var localCols = cacheCollections(), wasLive = Object.create(null);
    localCols.forEach(function (c) { if (live(c) && typeof c.id === "string") wasLive[c.id] = true; });
    var local = {
      collections: localCols,
      prompts: cachePrompts(),
      attachments: attIds.map(function (id) { return typeof id === "string" ? { id: id } : id; }),
      folders: cacheFolders()
    };
    var result = merge(local, backup), report = result.report, ch = report.changed, failed = 0, i;
    if (report.attachments.bytes > MAX_IMPORT_BYTES) {
      throw err("too_large", "This backup would add " + fmtBytes(report.attachments.bytes) + " of images; one import takes at most " + fmtBytes(MAX_IMPORT_BYTES) + ". Export one book or deck at a time, or untick “Include images”.");
    }
    // Folders first (FEATURES L1.7), with their merged stamps, so the books and decks saved next find theirs.
    if (ch.folders.length) {
      try {
        if (typeof cache.saveFolders === "function") await cache.saveFolders(ch.folders);
        else failed += ch.folders.length;
      } catch (e) { failed += ch.folders.length; }
    }
    // Collections keep the merged stamps ({now}): an import is not an edit, so it must not outrank later changes.
    for (i = 0; i < ch.collections.length; i++) {
      var col = ch.collections[i];
      try {
        if (col.deletedAt && wasLive[col.id]) await removeAsImported(cache, store, col);
        else await cache.saveCollection(col, { now: num(col.updatedAt), content: false });
      } catch (e) { failed++; }
    }
    for (i = 0; i < ch.attachments.length; i++) {
      try {
        if (store && store.attachments && typeof store.attachments.put === "function") await store.attachments.put(toStoredAttachment(ch.attachments[i]));
        else failed++;
      } catch (e) { failed++; }
    }
    // The merge was made from the records as they were when the import began, and saving takes a while: a send of a
    // prompt meanwhile changes its send record in place (the marker written ahead of a request, the record of its
    // answer; M.cache.patchPrompts). So each merged record takes the send record merged again from the backup's and
    // the record as it is right now, never an older one (repair D4 of the A9 review, 2026-11-10).
    var incSend = Object.create(null);
    (Array.isArray(backup.prompts) ? backup.prompts : []).forEach(function (raw) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return;
      incSend[raw.id] = hasOwn(incSend, raw.id) ? mergeSendRecord({}, incSend[raw.id], raw) : mergeSendRecord({}, {}, raw);
    });
    for (i = 0; i < ch.prompts.length; i++) {
      var rec = ch.prompts[i], cur = typeof cache.prompt === "function" ? cache.prompt(rec.id) : null;
      if (cur && cur !== rec) mergeSendRecord(rec, cur, hasOwn(incSend, rec.id) ? incSend[rec.id] : {});
      try { await cache.savePrompt(rec, { content: false }); } catch (e) { failed++; }
    }
    // a merged prompt may carry the other device's context line (old nickname or chapter marks): rebuild it from
    // the collection records here (the context line is derived, so a failure keeps the merged one)
    var touched = {};
    ch.prompts.forEach(function (p) { if (p && p.collectionId) touched[p.collectionId] = true; });
    (ch.collections || []).forEach(function (c) { if (c && c.id) touched[c.id] = true; });
    for (var tid in touched) {
      if (!Object.prototype.hasOwnProperty.call(touched, tid) || typeof cache.recontext !== "function") continue;
      var tc = typeof cache.collection === "function" ? cache.collection(tid) : null;
      if (!tc || tc.deletedAt) continue;
      try { await cache.recontext(tid); } catch (e) { /* keep the merged context */ }
    }
    if (opts.restoreSettings && backup.settings && typeof backup.settings === "object" && M.settings && typeof M.settings.set === "function") {
      SETTINGS_KEYS.forEach(function (k) {
        if (backup.settings[k] === undefined) return;
        // D32: the Obsidian switch is restored only when the backup holds a choice (true or false); null there means
        // never chosen, and this library's own choice stays
        if (k === "obsidian" && typeof backup.settings[k] !== "boolean") return;
        try { M.settings.set(k, clone(backup.settings[k])); } catch (e) { /* ignore */ }
      });
    }
    report.failed = failed;
    toast(importSummary(report));
    return report;
  }
  function importSummary(rep) {
    var total = rep.added + rep.updated + rep.unchanged, cols = rep.collections || {}, atts = rep.attachments || {}, fols = rep.folders || {};
    var s = "Imported " + total + " prompt" + (total === 1 ? "" : "s") + " (" + rep.added + " new, " + rep.updated + " updated, " + rep.unchanged + " unchanged" + (rep.skipped ? ", " + rep.skipped + " skipped" : "") + ")";
    if (cols.added) s += " · " + cols.added + " new collection" + (cols.added === 1 ? "" : "s");
    if (fols.added) s += " · " + fols.added + " new folder" + (fols.added === 1 ? "" : "s");
    if (fols.removed) s += " · " + fols.removed + " folder" + (fols.removed === 1 ? "" : "s") + " deleted, as in the backup";
    if (cols.removed) s += " · " + cols.removed + " collection" + (cols.removed === 1 ? "" : "s") + " deleted, as in the backup";
    if (rep.cascaded) s += " · " + rep.cascaded + " more prompt" + (rep.cascaded === 1 ? "" : "s") + " deleted with " + (cols.removed === 1 ? "it" : "them");
    if (atts.added) s += " · " + atts.added + " image" + (atts.added === 1 ? "" : "s");
    if (atts.skipped) s += " · " + atts.skipped + " image" + (atts.skipped === 1 ? "" : "s") + " skipped (not a PNG, JPEG, GIF or WebP image of at most " + fmtBytes(maxImageBytes()) + ")";
    if (rep.failed) s += " · " + rep.failed + " could not be saved";
    return s;
  }

  async function prepare(format, opts) {
    opts = opts || {};
    format = normalizeFormat(format);
    var d = deps(), s = inScope(opts), includeImages = opts.includeImages !== false, now = Date.now();
    var attachments = Array.isArray(opts.attachments) ? opts.attachments.slice() : [];
    if (includeImages && !attachments.length && M.store && M.store.attachments && typeof M.store.attachments.get === "function") {
      var source = format === "json" ? s.prompts : s.prompts.filter(live), ids = [], max = maxImageBytes();
      source.forEach(function (p) { imageIds(p.text, d).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); }); });
      for (var i = 0; i < ids.length; i++) {
        try {
          var att = await M.store.attachments.get(ids[i]);
          var u8 = att && att.bytes ? toU8(att.bytes) : null;
          // Only a raster image within the attachment limit is encoded (checked before the costly base64 step);
          // a stored record that is anything else was not made by Marginalia and is left out like a missing one.
          var mime = u8 && u8.length <= max ? sniffImage(u8) : null;
          if (mime) attachments.push({ id: ids[i], mime: mime, width: dimOf(att.width), height: dimOf(att.height), data: bytesToBase64(u8) });
        } catch (e) { /* missing attachment: the token renders as .att--missing on import */ }
      }
    }
    var args = Object.assign({}, opts, { scope: s.scope, collectionId: s.collectionId, collections: s.collections, prompts: s.prompts, attachments: attachments, includeImages: includeImages, now: now });
    var text = format === "json" ? toJSON(args) : format === "anki" ? toAnkiTSV(args) : toMarkdown(args);
    return { text: text, bytes: utf8Length(text), filename: filenameFor(format, now), mime: MIME[format] };
  }

  function isArtifact() {
    try { return !!(M.app && typeof M.app.isArtifact === "function" && M.app.isArtifact()); } catch (e) { return false; }
  }
  function anchorDownload(filename, text, mime) {
    try {
      if (typeof document === "undefined" || typeof Blob !== "function" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "fallback";
      var blob = new Blob([text], { type: mime || "text/plain" }), url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename; a.rel = "noopener"; a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 60000);
      return "saved";
    } catch (e) { return "fallback"; }
  }
  function deliver(filename, text, mime) {
    var claude = root.claude;
    if (claude && typeof claude.use === "function") {
      return Promise.resolve()
        .then(function () { return claude.use("downloads"); })
        .then(function (dl) {
          if (!dl || typeof dl.save !== "function") throw err("not_granted", "Downloads are not available here");
          return dl.save({ filename: filename, data: text });
        })
        .then(function () { return "saved"; }, function (e) {
          toast("Download failed" + (e && (e.message || e.code) ? ": " + (e.message || e.code) : "") + " — copy the text instead");
          return isArtifact() ? "fallback" : anchorDownload(filename, text, mime);
        });
    }
    return Promise.resolve(anchorDownload(filename, text, mime));
  }

  // ------------------------------------------------------------------ dialog

  var BACKDROP_STYLE = "position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(0,0,0,.45)";
  var PANEL_STYLE = "background:var(--surface,#faf8f3);color:var(--ink,#1f1d1a);width:100%;max-width:min(640px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;border-radius:var(--r3,12px);padding:var(--s5,24px);box-sizing:border-box;box-shadow:0 8px 32px rgba(0,0,0,.3)";
  var TEXTAREA_STYLE = "display:block;width:100%;min-height:160px;box-sizing:border-box;margin-top:8px;font:12px/1.4 var(--font-mono,monospace);resize:vertical;overflow-wrap:anywhere";
  var HEAD_STYLE = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px";
  var TABS_STYLE = "display:flex;gap:4px;margin:0 0 12px";
  var ACTIONS_STYLE = "display:flex;gap:8px;flex-wrap:wrap;margin:8px 0";

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "disabled" || k === "checked" || k === "readOnly" || k === "selected") el[k] = !!v;
      else if (k === "value") el.value = v;
      else el.setAttribute(k, String(v));
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }
  function setText(el, s) { el.textContent = s; }
  function modKey() {
    try { return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "") ? "⌘" : "Ctrl"; } catch (e) { return "Ctrl"; }
  }
  function readFileText(file) {
    if (file && typeof file.text === "function") return file.text();
    return new Promise(function (resolve, reject) {
      try {
        var r = new FileReader();
        r.onload = function () { resolve(String(r.result || "")); };
        r.onerror = function () { reject(r.error || new Error("read failed")); };
        r.readAsText(file);
      } catch (e) { reject(e); }
    });
  }
  function importError(e) {
    var code = e && e.code;
    if (code === "invalid_json") return "That file is not valid JSON.";
    if (code === "bad_format") return "That is not a Marginalia backup.";
    if (code === "unsupported_version") return (e && e.message) || "Unsupported backup version.";
    if (code === "too_large" || code === "too_many_records") return (e && e.message) || "That backup is too large to import.";
    return "Import failed" + (e && e.message ? ": " + e.message : "") + ".";
  }
  function trapTab(ev, panel) {
    var nodes = panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
    var list = [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].offsetParent !== null || nodes[i] === document.activeElement) list.push(nodes[i]);
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (ev.shiftKey && (active === first || !panel.contains(active))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (active === last || !panel.contains(active))) { ev.preventDefault(); first.focus(); }
  }

  function openDialog(opts) {
    if (typeof document === "undefined") return null;
    opts = opts || {};
    var host = opts.host && typeof opts.host.appendChild === "function" ? opts.host : document.body;
    var invoker = document.activeElement, prevOwner = null;
    try {
      if (M.app && typeof M.app.focusOwner === "function") prevOwner = M.app.focusOwner();
      if (M.app && typeof M.app.setFocusOwner === "function") M.app.setFocusOwner("settings");
    } catch (e) { /* ignore */ }

    var state = {
      scope: opts.scope === "collection" && opts.collectionId ? "collection" : "all",
      collectionId: opts.scope === "collection" && opts.collectionId ? opts.collectionId : null,
      format: "json",
      includeImages: opts.includeImages !== false,
      tab: opts.tab === "import" ? "import" : "export"
    };
    try { state.format = normalizeFormat(opts.format || "json"); } catch (e) { state.format = "json"; }
    var current = null, seq = 0, fileText = null, closed = false, stale = false;

    // ---- export pane
    var scopeSelect = h("select", { class: "dialog__select", "aria-label": "Scope" });
    function fillScope() {
      while (scopeSelect.firstChild) scopeSelect.removeChild(scopeSelect.firstChild);
      scopeSelect.appendChild(h("option", { value: "all", text: "Everything" }));
      cacheCollections().filter(live).sort(byName).forEach(function (c) {
        scopeSelect.appendChild(h("option", { value: c.id, text: (c.kind === "deck" ? "Deck · " : "Book · ") + (c.name || c.title || "Untitled") }));
      });
      var want = state.scope === "collection" ? state.collectionId : "all";
      scopeSelect.value = want;
      if (scopeSelect.value !== want) { state.scope = "all"; state.collectionId = null; scopeSelect.value = "all"; }
    }
    fillScope();
    scopeSelect.addEventListener("change", function () {
      var v = scopeSelect.value;
      state.scope = v === "all" ? "all" : "collection";
      state.collectionId = v === "all" ? null : v;
      schedulePrepare();
    });
    var formatRadios = [["json", "JSON backup"], ["anki", "Anki TSV"], ["markdown", "Markdown"]].map(function (f) {
      var input = h("input", { type: "radio", name: "marginalia-export-format", value: f[0] });
      input.checked = state.format === f[0];
      input.addEventListener("change", function () { if (input.checked) { state.format = f[0]; schedulePrepare(); } });
      return h("label", { class: "dialog__radio" }, [input, " " + f[1]]);
    });
    var imagesCheck = h("input", { type: "checkbox" });
    imagesCheck.checked = state.includeImages;
    imagesCheck.addEventListener("change", function () { state.includeImages = imagesCheck.checked; schedulePrepare(); });
    var status = h("div", { class: "dialog__status", "aria-live": "polite", text: "Preparing…" });
    var hint = h("div", { class: "dialog__hint is-hidden" });
    var copyBtn = h("button", { type: "button", class: "btn btn--primary", text: "Copy to clipboard" });
    var dlBtn = h("button", { type: "button", class: "btn", text: "Download" });
    var selBtn = h("button", { type: "button", class: "btn btn--ghost", text: "Select all" });
    copyBtn.disabled = true; dlBtn.disabled = true;
    var textarea = h("textarea", { class: "dialog__textarea", "aria-label": "Export text", spellcheck: "false", style: TEXTAREA_STYLE });
    textarea.readOnly = true;
    function selectAll() { try { textarea.focus(); textarea.select(); } catch (e) { /* ignore */ } }
    function schedulePrepare() {
      var my = ++seq;
      current = null; stale = false;
      copyBtn.disabled = true; dlBtn.disabled = true;
      hint.classList.add("is-hidden");
      textarea.value = "";
      setText(status, "Preparing…");
      prepare(state.format, { scope: state.scope, collectionId: state.collectionId, includeImages: state.includeImages }).then(function (r) {
        if (closed || my !== seq) return;
        current = r;
        textarea.value = r.text;
        setText(status, "Ready · " + fmtBytes(r.bytes) + " · " + r.filename);
        dlBtn.disabled = false;
        if (r.bytes > COPY_LIMIT) {
          copyBtn.disabled = true;
          setText(hint, "Too large for the clipboard — download or exclude images");
          hint.classList.remove("is-hidden");
        } else copyBtn.disabled = false;
      }, function (e) {
        if (closed || my !== seq) return;
        setText(status, "Could not prepare the export: " + ((e && e.message) || "unknown error"));
      });
    }
    copyBtn.addEventListener("click", function () {
      if (!current) return;
      var r = current, p;
      try {
        p = (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function")
          ? navigator.clipboard.writeText(r.text) : Promise.reject(new Error("Clipboard unavailable"));
      } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function () {
        setText(status, "Copied " + fmtBytes(r.bytes) + " to the clipboard");
        toast("Copied " + r.filename + " to the clipboard");
      }, function () {
        selectAll();
        setText(status, "Copy failed — the text is selected below; press " + modKey() + "+C");
      });
    });
    dlBtn.addEventListener("click", function () {
      if (!current) return;
      var r = current;
      deliver(r.filename, r.text, r.mime).then(function (res) {
        if (closed) return;
        if (res === "saved") { setText(status, "Saved " + r.filename); toast("Saved " + r.filename); }
        else { selectAll(); setText(status, "Download unavailable here — the text is selected below; copy it into a file named " + r.filename); }
      });
    });
    selBtn.addEventListener("click", selectAll);
    var exportPane = h("div", { class: "dialog__pane dialog__pane--export" }, [
      h("div", { class: "dialog__row" }, [h("label", { class: "dialog__label" }, ["Scope ", scopeSelect])]),
      h("fieldset", { class: "dialog__formats" }, [h("legend", { text: "Format" })].concat(formatRadios)),
      h("div", { class: "dialog__row" }, [h("label", { class: "dialog__check" }, [imagesCheck, " Include images"])]),
      status,
      h("div", { class: "dialog__actions", style: ACTIONS_STYLE }, [copyBtn, dlBtn, selBtn]),
      hint,
      textarea
    ]);

    // ---- import pane
    var fileInput = h("input", { type: "file", accept: ".json,application/json", class: "dialog__file", "aria-label": "Backup file" });
    var fileName = h("span", { class: "dialog__filename" });
    var pasteBox = h("textarea", { class: "dialog__textarea", placeholder: "…or paste a backup here", "aria-label": "Paste a backup", spellcheck: "false", style: TEXTAREA_STYLE });
    var restoreCheck = h("input", { type: "checkbox" });
    var importStatus = h("div", { class: "dialog__status", "aria-live": "polite" });
    var importBtn = h("button", { type: "button", class: "btn btn--primary", text: "Import" });
    importBtn.disabled = true;
    function refreshImportBtn() { importBtn.disabled = !(fileText || pasteBox.value.trim()); }
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      fileText = null;
      setText(fileName, f ? " " + f.name : "");
      refreshImportBtn();
      if (!f) return;
      if (typeof f.size === "number" && f.size > MAX_IMPORT_FILE) {
        setText(importStatus, f.name + " · " + fmtBytes(f.size) + " · too large to import (at most " + fmtBytes(MAX_IMPORT_FILE) + ")");
        return;
      }
      readFileText(f).then(function (t) {
        fileText = t;
        setText(importStatus, f.name + " · " + fmtBytes(f.size) + " · ready to import");
        refreshImportBtn();
      }, function () { setText(importStatus, "Could not read " + f.name); });
    });
    pasteBox.addEventListener("input", refreshImportBtn);
    importBtn.addEventListener("click", function () {
      var text = pasteBox.value.trim() ? pasteBox.value : fileText;
      if (!text) return;
      importBtn.disabled = true;
      setText(importStatus, "Importing…");
      importJSON(text, { restoreSettings: !!restoreCheck.checked }).then(function (rep) {
        if (closed) return;
        setText(importStatus, importSummary(rep));
        fillScope();
        if (state.tab === "export") schedulePrepare(); else stale = true;
        refreshImportBtn();
      }, function (e) {
        if (closed) return;
        setText(importStatus, importError(e));
        refreshImportBtn();
      });
    });
    var importPane = h("div", { class: "dialog__pane dialog__pane--import is-hidden" }, [
      h("div", { class: "dialog__row" }, [h("label", { class: "dialog__label" }, ["Backup file (.json) ", fileInput]), fileName]),
      pasteBox,
      h("div", { class: "dialog__row" }, [h("label", { class: "dialog__check" }, [restoreCheck, " Also restore settings (review shortcuts, snip mode, margin options, vision model, the Obsidian connection with its vault and folder, “Not alike” marks)"])]),
      importStatus,
      h("div", { class: "dialog__actions", style: ACTIONS_STYLE }, [importBtn])
    ]);

    // ---- frame
    var tabExport = h("button", { type: "button", role: "tab", class: "dialog__tab", text: "Export" });
    var tabImport = h("button", { type: "button", role: "tab", class: "dialog__tab", text: "Import" });
    function showTab(t) {
      state.tab = t;
      var ex = t === "export";
      exportPane.classList.toggle("is-hidden", !ex);
      importPane.classList.toggle("is-hidden", ex);
      tabExport.setAttribute("aria-selected", ex ? "true" : "false");
      tabImport.setAttribute("aria-selected", ex ? "false" : "true");
      tabExport.classList.toggle("dialog__tab--active", ex);
      tabImport.classList.toggle("dialog__tab--active", !ex);
      if (ex && (stale || (!current && seq === 0))) schedulePrepare();
    }
    tabExport.addEventListener("click", function () { showTab("export"); });
    tabImport.addEventListener("click", function () { showTab("import"); });
    var closeBtn = h("button", { type: "button", class: "btn btn--ghost dialog__close", "aria-label": "Close", text: "✕" });
    var panel = h("div", { class: "dialog__panel", style: PANEL_STYLE }, [
      h("div", { class: "dialog__head", style: HEAD_STYLE }, [h("h2", { class: "dialog__title", text: "Export / Import", style: "margin:0" }), closeBtn]),
      h("div", { class: "dialog__tabs", role: "tablist", style: TABS_STYLE }, [tabExport, tabImport]),
      exportPane,
      importPane
    ]);
    var el = h("div", { class: "dialog export-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Export and import", style: BACKDROP_STYLE }, [panel]);
    function close() {
      if (closed) return;
      closed = true; seq++;
      try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* ignore */ }
      try { if (typeof prevOwner === "string" && M.app && typeof M.app.setFocusOwner === "function") M.app.setFocusOwner(prevOwner); } catch (e) { /* ignore */ }
      try { if (invoker && typeof invoker.focus === "function" && document.contains(invoker)) invoker.focus(); } catch (e) { /* ignore */ }
      if (typeof opts.onClose === "function") { try { opts.onClose(); } catch (e) { /* ignore */ } }
    }
    closeBtn.addEventListener("click", close);
    el.addEventListener("mousedown", function (ev) { if (ev.target === el) close(); });
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); return; }
      if (ev.key === "Tab") trapTab(ev, panel);
      ev.stopPropagation(); // the dialog owns its keys; the app's document listener never sees them
    });
    host.appendChild(el);
    showTab(state.tab);
    try { (state.tab === "export" ? tabExport : tabImport).focus(); } catch (e) { /* ignore */ }
    return { el: el, close: close, refresh: schedulePrepare };
  }

  // --------------------------------------------------------------------- api

  var api = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    COPY_LIMIT: COPY_LIMIT,
    MAX_IMPORT_RECORDS: MAX_IMPORT_RECORDS,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    MAX_IMPORT_FILE: MAX_IMPORT_FILE,
    SETTINGS_KEYS: SETTINGS_KEYS.slice(),
    toJSON: toJSON,
    toAnkiTSV: toAnkiTSV,
    toMarkdown: toMarkdown,
    merge: merge,
    importJSON: importJSON,
    isImporting: isImporting,
    prepare: prepare,
    deliver: deliver,
    openDialog: openDialog,
    // exposed for tests and siblings
    numberClozes: numberClozes,
    scanDeletions: scanDeletions,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    utf8Length: utf8Length,
    importSummary: importSummary
  };
  M.exporter = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17 M.exporter):
 *   toJSON({scope, collectionId, includeImages, attachments, folders}) → string
 *   toAnkiTSV({...}) → string
 *   toMarkdown({...}) → string
 *   merge(localState, backup) → {state, report}   (pure)
 *   importJSON(text, {restoreSettings}) → Promise<report>
 *   prepare(format, opts) → Promise<{text, bytes, filename, mime}>
 *   deliver(filename, text, mime) → Promise<"saved"|"fallback">
 *   openDialog(opts)
 * Extras: FORMAT, VERSION, COPY_LIMIT, MAX_IMPORT_RECORDS, MAX_IMPORT_BYTES, MAX_IMPORT_FILE, SETTINGS_KEYS, numberClozes,
 * scanDeletions, bytesToBase64, base64ToBytes, utf8Length, importSummary; isImporting() → boolean (FEATURES A10.1: true
 * from the moment importJSON is called, before its first write, until it ends, success or failure, cleared in a finally;
 * M.obsidian sends nothing meanwhile) and the bus event "import:finished" {report|null, error|null} when an import ends
 * (an addition to the SPEC §17.3 table, exporter → backup: FEATURES B9.5 reconnects the PDFs the import's books need).
 * Every book of a JSON backup carries its sha256 and hashAlgo (only chunkCount and chunkSize are left out), which the
 * PDF backup needs (FEATURES B9.7: the server keeps a saved PDF while a kept backup lists its sha256 for a live book,
 * or for a book deleted less than 30 days ago: D23).
 * Folders (FEATURES L1.7, BUILD-NOTES "Library folders"): toJSON's whole-library backup carries "folders" (opts.folders,
 * else M.cache.folders(), tombstones included; [] for one book or deck) and every collection keeps its folderId and
 * folderUpdatedAt. merge(localState, backup) takes localState.folders and returns state.folders, report.folders {added,
 * updated, unchanged, skipped, removed} and report.changed.folders; mergeFolders merges by id (the later updatedAt wins
 * for name and parent; a parent missing after the merge → the top level, a deleted one → the nearest live folder above
 * it, a loop cut at its newest folder), and a collection's folderId follows the later folderUpdatedAt. importJSON saves
 * the changed folders first, in one M.cache.saveFolders call, then the collections; MAX_IMPORT_RECORDS counts folders
 * too; the import toast adds "N new folder(s)" and "N folder(s) deleted, as in the backup".
 * Import hardening: attachments are raster images by signature (PNG/JPEG/GIF/WebP) within M.attachments.MAX_PNG with
 * sane dimensions, else skipped; record ceiling and image-byte budget refuse with codes "too_many_records" / "too_large";
 * a collection the import deletes goes through M.cache.removeCollection; prompts never stay live in a deleted
 * collection; merged cards are capped at what the text implies; collection content follows contentUpdatedAt when present.
 * FIXES-1 FIX-5: a prompt's revisedAt is a content field (it goes with the text of the side that wins; none when that side
 * has none; a value that is not a finite number is dropped on import).
 * BUILD-NOTES "Obsidian": the backup settings carry obsidian (the switch of DECISIONS D32; an import with "Also restore
 * settings" sets it only when the backup holds true or false), obsidianVault and obsidianFolder; a prompt's obsidianSentAt and
 * obsidianFile ride in the record and a merge keeps the later send of both sides with its file. obsidianPendingFile
 * (the marker: the note a server send that did not finish was writing to, written ahead of every request, js/obsidian.js,
 * FEATURES A9) rides in the record too; it is not content, and a merge keeps the local record's first, else the
 * backup's (a prompt new to the library keeps the backup's), and drops it only when the other side holds none and
 * recorded a later send into that very note (mergeSendRecord; repair D1 of 2026-11-10). importJSON merges each
 * prompt's send record again with the record as it is right before saving it, so a send made while the import runs
 * keeps its marker or its record (repair D4).
 * Look-alikes (FEATURES P2.4): the backup settings also carry notAlike (the "Not alike" pair keys); "Also restore
 * settings" replaces the library's list with the backup's, as it does for the other settings.
 * Cues (FEATURES P1.1 d): the Anki TSV writes {x::cue} as {{cN::x::cue}} (Anki's hint form: the hidden part as typed
 * without the blanks before the separator, "::", the trimmed cue). numberClozes(text, deletions, colon) takes the
 * deletions of M.prompts.parse ({start, end, text: hidden part, cue?}). Anki splits at the first "::", so in the Anki
 * row a colon of the hidden part that would make one is written &#58;: in a deletion with a cue every colon that
 * follows a colon and a last colon of the hidden part; in a deletion without a cue the second colon of a typed `\::`
 * only. A text with neither gives the same row as before. The Markdown export and the JSON backup keep the text as
 * typed. The fallback scanner scanDeletions(s) follows the cue rule of M.prompts.parse ({start, end, text, cue?}).
 */
