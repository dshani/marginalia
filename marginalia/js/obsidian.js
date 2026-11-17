/* js/obsidian.js — M.obsidian: a copy of a margin note or prompt in Obsidian (BUILD-NOTES "Obsidian").
 *
 * One Obsidian note per book (deck: per deck): <settings.obsidianFolder>/<nickname>.md, each prompt one block
 *   <!-- marginalia:<promptId> -->
 *   ### <section label · p. 12>            (deck: its section, else the deck name)
 *   > <anchor quote, every line>           (left out without a quote)
 *
 *   <M.markup.toObsidian(text)>            (left out for a highlight or empty text)
 *
 *   [Open in Marginalia](<origin>/#reader/<collectionId>/<promptId>) · YYYY-MM-DD   (the link only on localhost)
 *   <!-- /marginalia -->
 * The Marginalia record stays as it is: Obsidian gets a copy when it is sent, and sending again updates that copy
 * where it lives: in the note its last send recorded (prompt.obsidianFile), also after a rename, a folder change or a
 * move to a deck (the toast names that note); a prompt never sent goes to <folder>/<current nickname>.md.
 * The block is always well-formed text (a lone surrogate, e.g. a quote cut inside 𝑥, becomes U+FFFD) in the shape
 * tools/serve.py finds again: marker-like text is written "&lt;!--", a body line that would read as the date line
 * (or, fenced or not, starts with the block's own link and a date) gets an escaped "-", and a code fence the body
 * leaves open is closed. The anchor quote is the PDF's text and never
 * Obsidian syntax (no tag, heading, comment, wiki link, highlight, block id or math): see quoteText().
 *
 * Two ways in, chosen by detect() (cached; Settings re-checks, and so does a send while the cached answer is "link" on
 * a page served from 127.0.0.1 or localhost, so a server restarted since is found):
 * - "server": tools/serve.py answers GET /api/obsidian/vaults → POST /api/obsidian/note writes the block silently
 *   (replaced in place when the note already holds it) and the images into the vault's attachment folder.
 * - "link": no such server (an older serve.py, file://, the claude.ai artifact) → obsidian://new?…&append=true&silent,
 *   opened by a temporary <a href> click inside the user's gesture (images become "[image]"; a re-send appends a
 *   second copy, which the toast says; a note no sent prompt records starts with "# <name>"). A URI over URI_LIMIT
 *   characters is never opened: the block is copied instead. An older serve.py (the page's own server on 127.0.0.1 or
 *   localhost answers 404, 405 or 501) is told apart from no server at all (detect's outdated: true): the Settings line
 *   (METHOD_RESTART) and the toasts then say to run "marginalia restart" in Terminal. A card whose server send did not
 *   finish (its marker, below) never goes through a link (FEATURES A9.1): no link, no copy, and the toast says
 *   "1 card may already be in Obsidian: …" (heldLine).
 * On success prompt.obsidianSentAt = now and prompt.obsidianFile = the note's path, and a toast offers "Open in
 * Obsidian"; a failure names the reason and offers "Copy note" (whatever failed, once the block exists; the block with
 * images as "[image]", since a failed send wrote none), and a copy the clipboard refuses offers "Copy note" again. A
 * card that may be in its note already is never offered to copy (a copy invites the second copy): a server send that
 * left no telling (no answer, a 5xx, a 2xx that could not be read) says "May already be in Obsidian — <reason>" and to
 * send it again, and a card that holds the marker (below) gets no "Copy note" whatever failed (repair D2, 2026-11-10).
 * The send record (obsidianSentAt, obsidianFile, obsidianPendingFile) is never a content edit and goes through
 * writeRecords: M.cache.patchPrompts, in place, one store write for a whole request, no prompt:saved (a cache without
 * it gets one M.cache.savePrompt(copy, {content: false}) per record).
 * Write-ahead (FEATURES A9.2): a request that may write blocks (POST /api/obsidian/note or /notes) can write them and
 * never be answered (the server stopped or restarted mid-request, the connection dropped, the tab was closed or
 * reloaded, or stepped aside), and the page cannot tell. So before it leaves, every card in it gets
 * prompt.obsidianPendingFile = the request's note (the marker; writeAhead, stored first) unless it already holds that
 * value, and the answer settles it: a block the server wrote records the send and drops the marker; one it definitely
 * did not write (a 4xx JSON answer for the request, or a per-block ok: false result, notFound included) gets the
 * marker back as it was before this request (none: removed); anything else (a 5xx, no answer, a cut or unparseable
 * body) leaves it. obsidianSentAt stays as it was meanwhile, so a card never sent stays new. A marked card's next send
 * goes to that note (targetFile: the recorded note, then that one, then <folder>/<nickname>.md), where the server
 * replaces the copy the lost request wrote, else adds it once, never a second copy in the note a rename, a folder
 * change or a move picks now; a send-all sends it even when it is otherwise unchanged (A9.3), so the server settles it.
 * When the store refuses the write-ahead (a full disk), nothing is sent: "Marginalia could not save, so nothing was
 * sent" (repair A9-R3). A JSON backup carries the marker; js/exporter.js merges it (the local record's first, else the
 * backup's) and keeps it through an import that runs while a send is on its way (repairs D1, D4).
 *
 * A tab that stepped aside for a newer Marginalia tab (M.store.locked(), js/store.js) sends nothing: no POST, no link,
 * also when it steps aside while a send checks the server or before the toast's "Add to Obsidian" is clicked (checked
 * again right before a link opens, repair D6); the markers it wrote while it was the active tab stay in the store for
 * the active tab to settle (A9.4).
 *
 * While an import is saving (M.exporter.isImporting(), FEATURES A10.1) no send leaves either: single send, O's save,
 * Send all, server mode and link mode. Until the import's last record is saved a card may still lack the marker its
 * backup carries, so the send toasts "Wait until the import finishes, then send again." (no actions) and the card stays
 * as it is: no marker, no record, nothing to copy. It is checked when a send starts, once detect() has answered, right
 * before each request's write-ahead (from then on the send is on its way, and importJSON keeps its marker or record,
 * repair D4) and right before a link opens; planAll answers {importing: true}. A send-all's link that waits for its
 * toast's "Add to Obsidian" looks at every planned card again at the click (FEATURES A10.2): one marked meanwhile is
 * held back and named by the A9.1 line, one sent meanwhile is already there, one deleted meanwhile is left out.
 *
 * Send all (a whole book or deck: sendAll, planAll; the library's ⋯ menus): the live prompts, each kind, in reading
 * order, as the blocks send() writes, and never a card twice (sendState, FEATURES A8): a card never sent is added; one
 * sent before and edited since (its content stamp, contentUpdatedAt, is newer than obsidianSentAt) replaces its own
 * block ("replaceOnly": when that block is no longer in the note the server writes nothing for it, and it is listed
 * with "Copy notes", never added again); one sent before and not edited since goes in no request. With nothing to
 * send there is no check and no request, only a toast. Server: one POST /api/obsidian/notes per target note (the
 * targetFile rule, so earlier copies are updated where they live), split above about 20 MB (one POST
 * /api/obsidian/note per never-sent card on a serve.py from before /notes, which cannot replace only, so edited cards
 * wait for a restart there; they wait too on a serve.py whose GET /api/obsidian/vaults does not answer "replaceOnly":
 * true, detect's replaceOnly, since its /notes would add one whose block is gone). A card with the marker is never
 * "already there": it goes too (sent before: replaceOnly into the note that holds it; never sent: added to the
 * marker's note, where the server replaces the copy the lost request wrote). Link: only the prompts never sent and not
 * marked, in one obsidian://new link (copied above URI_LIMIT, marked cards never in the copy); the toast, the copy's
 * too, counts the edited ones a link cannot update and names the marked ones it held back. The cards a request left
 * no telling for are named apart ("may already be in Obsidian") and never copied (repair D2), and a marked card sent
 * before and not edited since is named "whose last send did not finish", never "edited" (repair D5). A second
 * send-all of a collection whose send-all still runs is refused. A send is dated before any edit made while its
 * block was on its way (sentChange), so the next send-all still updates that edit; the write-ahead markers (above)
 * cover every request.
 *
 * The desktop app (FEATURES E2.2, js/desktop.js; BUILD-NOTES "Desktop app (binding)"): every POST (/note, /notes)
 * carries the headers M.desktop.headers() gives, "X-Marginalia-Client: app" in the app and nothing more elsewhere (the
 * app's server refuses a POST without it: 409 "app_only", whose "message" is the reason shown). In a browser page the app
 * replaced (M.desktop cover mode) every send is refused, single or Send all, server or link, also at the click of a
 * waiting link: the toast "Marginalia is now an app — open it to send to Obsidian." (COVERED), no request, no link, the
 * card as it is; while that page's app check still runs (at boot, at most 3 s) a send waits for its answer.
 *
 * The switch (DECISIONS D32; BUILD-NOTES "Obsidian", "The switch"): the connection is an option, Settings › Obsidian ›
 * "Connect Marginalia to Obsidian" (settings.obsidian: true, false, or null = never chosen). enabled() answers it:
 * the stored choice; never chosen: on only while the library holds a send record (a card sent before, or one whose
 * send did not finish, deleted cards included), so a library that used Obsidian before the switch existed keeps the
 * connection and a new library starts without it. While it is off no send leaves: send and sendAll toast OFF "The
 * Obsidian connection is off — turn it on in Settings › Obsidian." (error OFF, no request, no link, no marker, the
 * card as it is), planAll answers {ok: false, error: OFF, off: true}, and the pages offer no Obsidian command (each
 * UI module asks enabled()). It is checked after the tab lock and the desktop app's cover, and before anything else,
 * when a send starts: a send that is under way when the switch goes off finishes (a send-all's next requests too).
 * A toast's button that is clicked after the switch went off opens nothing and says OFF: "Open in Obsidian"
 * (openNote), and "Add to Obsidian" of a send without a gesture (single and send-all).
 * detect() is not gated: Settings asks it only while the connection is on.
 *
 * Pure helpers (fileName, notePath, blockFor, uriFor, openUriFor) load in node with no DOM; the opener, fetch and the
 * API base are injectable for tests (_setOpener, _setFetch, _setApiBase, _reset). No obsidian:// URI is opened by
 * anything but the opener.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  var API_BASE = "/api/obsidian";
  var URI_LIMIT = 60000;                     // longer obsidian:// URIs are copied, never opened
  var MAX_BODY = 25 * 1024 * 1024;           // tools/serve.py refuses larger requests
  var NAME_MAX = 120;
  var DEFAULT_FOLDER = "Notes/Marginalia";
  var TOAST_ID = "obsidian";
  var TOAST_TTL = 8000;
  var BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  var ATT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;   // marginalia-<id>.<ext> must pass the server's name rule
  // dropped from file and folder names (Obsidian / macOS / link syntax), with every control character
  var FORBIDDEN_RE = /[\\/:*?"<>|#^\[\]\u0000-\u001f\u007f-\u009f]/g;
  var EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  var METHOD_SERVER = "Writes straight into the vault";
  var METHOD_LINK = "Opens obsidian:// links — start Marginalia with the marginalia command to write silently";
  // an older serve.py serves the page: plain "marginalia" only reopens the page, so the advice names the restart
  var METHOD_RESTART = "Opens obsidian:// links — restart Marginalia (marginalia restart in Terminal) to write silently";
  var RESTART = "restart Marginalia (marginalia restart in Terminal)";
  var OLD_SERVER_STATUS = { 404: true, 405: true, 501: true };   // a serve.py from before the Obsidian endpoints
  var RECORDED_MAX = 1024;                   // a recorded note path longer than this is not one Marginalia wrote
  // a valid surrogate pair, else one lone surrogate (no lookbehind: older Safari would not parse the file)
  var SURROGATE_RE = /[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g;
  // tools/serve.py's block rules (find_block, check_block): a block's last line before its end marker is its only date
  // line outside code fences, and its own (no other line starts with its own link: ownLinkRe), and code fences follow
  // CommonMark (up to three spaces, ``` or ~~~, closed by a longer-or-equal run)
  var DATE_LINE_RE = /^(\[Open in Marginalia\]\([^)\r\n]*\) · )?\d{4}-\d{2}-\d{2}[ \t]*$/;
  var FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
  var FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

  // ---------------------------------------------------------------- small helpers
  function noop() {}
  function str(v) { return v == null ? "" : String(v); }
  // Text that can always be percent-encoded and written as UTF-8: a lone surrogate (a quote cut inside a math letter
  // such as 𝑥, U+1D465) becomes U+FFFD. encodeURIComponent throws on one, and serve.py refuses it.
  function wellFormed(s) {
    s = str(s);
    if (typeof s.toWellFormed === "function") return s.toWellFormed();
    return s.replace(SURROGATE_RE, function (m) { return m.length === 2 ? m : "\ufffd"; });
  }
  function oneLine(s) { return str(s).replace(/\s+/g, " ").trim(); }
  function cutChars(s, max) { var a = Array.from(s); return a.length > max ? a.slice(0, max).join("") : s; }
  function trimSpacesDots(s) { return s.replace(/^[\s.]+|[\s.]+$/g, ""); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function localDate(ms) { var d = new Date(ms); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function encId(s) { return encodeURIComponent(str(s)).replace(/\(/g, "%28").replace(/\)/g, "%29"); }
  function setting(key, dflt) {
    var S = M.settings, v;
    try { v = S && typeof S.get === "function" ? S.get(key) : undefined; } catch (e) { v = undefined; }
    return v === undefined || v === null ? dflt : v;
  }
  function toast(opts) {
    var app = M.app;
    if (!app || typeof app.toast !== "function") return null;
    try { return app.toast(Object.assign({ id: TOAST_ID, ttl: TOAST_TTL }, opts)); } catch (e) { return null; }
  }
  function isArtifact() {
    try { return !!(M.app && typeof M.app.isArtifact === "function" && M.app.isArtifact()); } catch (e) { return false; }
  }
  function loc() { try { return root.location || null; } catch (e) { return null; } }

  // ---------------------------------------------------------------- pure helpers
  // One file or folder name: whitespace collapsed, forbidden and control characters dropped, spaces and dots
  // trimmed, runs of dots inside → "…" (tools/serve.py refuses any ".." in a path), at most NAME_MAX characters.
  function cleanSegment(s) {
    var t = wellFormed(s).replace(/\s+/g, " ").replace(FORBIDDEN_RE, "").replace(/\s+/g, " ");
    t = trimSpacesDots(t).replace(/\.{2,}/g, "…");
    return trimSpacesDots(cutChars(t, NAME_MAX));
  }
  // fileName(nickname) → the note's file name without ".md" ("Untitled" when nothing is left)
  function fileName(name) { return cleanSegment(name) || "Untitled"; }
  function folderPath(folder) {
    return str(folder).replace(/\\/g, "/").split("/").map(cleanSegment).filter(Boolean).join("/");
  }
  // notePath(folder, nickname) → "Notes/Marginalia/Griffiths.md" (vault-relative; no folder: the vault root)
  function notePath(folder, name) {
    var f = folderPath(folder), n = fileName(name) + ".md";
    return f ? f + "/" + n : n;
  }
  function withoutMd(file) { return str(file).replace(/\.md$/i, ""); }

  function pageLabelOf(p) {
    var ctx = p && p.context;
    if (ctx && ctx.pageLabel != null && str(ctx.pageLabel).trim()) return oneLine(ctx.pageLabel);
    var i = p && p.anchor && typeof p.anchor.pageIndex === "number" ? p.anchor.pageIndex
      : (ctx && typeof ctx.pageIndex === "number" ? ctx.pageIndex : null);
    return i === null ? "" : String(i + 1);
  }
  // "Ch. 1 · The Wave Function · p. 12" (book) | section or deck name (deck)
  function headingFor(p, col) {
    var section = oneLine(p && p.context && p.context.sectionLabel);
    if (col && col.kind === "deck") return section || oneLine(col.name) || "Deck";
    var page = pageLabelOf(p), parts = [];
    if (section) parts.push(section);
    if (page) parts.push("p. " + page);
    return parts.join(" · ") || oneLine(col && (col.name || col.title)) || "Note";
  }
  // Text that must never read as a block marker (the server finds blocks by them). The same text as
  // <!--\s*\/?\s*marginalia, written as serve.py's LOOSE_MARKER_RE so a long run of spaces after "<!--" takes linear
  // time (two \s* around an optional "/" try every split of the run).
  function neutralize(s) { return str(s).replace(/<!--(\s*(?:\/\s*)?marginalia)/gi, "&lt;!--$1"); }
  // One line of the anchor quote: the PDF's text as it reads, never Obsidian syntax (decision of 2026-11-07). A
  // backslash, # $ ^ [ and ] are backslash-escaped (no #tag, heading, $math$, ^block-id, [[wiki link]], embed or link),
  // so is every = and % of a run of two or more (no ==highlight==, no %%comment%%), a < that would open HTML (a tag,
  // a <!-- comment) is written &lt;, a leading > (a nested quote) and a line of only - or = (a heading underline) are
  // escaped. Obsidian shows each of these characters unchanged.
  function quoteText(l) {
    var t = l.replace(/[\\#$^\[\]]/g, "\\$&")
      .replace(/={2,}|%{2,}/g, function (m) { return m.replace(/[=%]/g, "\\$&"); })
      .replace(/<(?=[A-Za-z!\/?])/g, "&lt;");
    if (/^ *[-=]+ *$/.test(t)) t = t.replace(/[-=]/, "\\$&");
    return t.replace(/^( *)>/, "$1\\>");
  }
  function quoteLines(q) {
    return str(q).replace(/\r\n?/g, "\n").split("\n").map(function (l) { return "> " + quoteText(l.replace(/\s+$/, "")); }).join("\n");
  }
  function isLocalHost(h) { return h === "127.0.0.1" || h === "localhost"; }
  // tools/serve.py's own_link_re: a line that starts (after spaces) with block `id`'s own "Open in Marginalia" link and
  // a date, whatever follows. The server reads it as that block's date line (or what a hand edit left of one) wherever
  // it stands, fenced or not, so a block may hold only its real one.
  function ownLinkRe(id) {
    return new RegExp("^\\s*\\[Open in Marginalia\\]\\([^)\\r\\n]*#reader\\/[^\\/)\\r\\n]*\\/" +
      str(id).replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&") + "\\) · \\d{4}-\\d{2}-\\d{2}");
  }
  // The body in the shape tools/serve.py needs to find the block again on the next send: a line outside code fences
  // that would read as the block's date line gets its date's first "-" escaped ("2026\-11-06", which Obsidian shows
  // as 2026-11-06), and so does a line anywhere, fenced or not, that starts with the block's own link and a date (in
  // code the "\" shows); a code fence left open is closed (else the block's own last lines would fall inside it).
  function guardBody(text, id) {
    var lines = str(text).split("\n"), fence = null, m, own = ownLinkRe(id);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (own.test(l)) lines[i] = l = l.replace(/(\) · \d{4})-/, "$1\\-");
      if (fence) {
        m = FENCE_CLOSE_RE.exec(l);
        if (m && m[1].charAt(0) === fence.charAt(0) && m[1].length >= fence.length) fence = null;
        continue;
      }
      m = FENCE_OPEN_RE.exec(l);
      if (m && !(m[1].charAt(0) === "`" && m[2].indexOf("`") >= 0)) { fence = m[1]; continue; }
      if (DATE_LINE_RE.test(l)) lines[i] = l.replace(/(\d{4})-(\d{2}-\d{2}[ \t]*)$/, "$1\\-$2");
    }
    if (fence) lines.push(fence);
    return lines.join("\n");
  }
  function bodyOf(p, images) {
    var mk = tryDep("markup"), text = str(p && p.text);
    if (!text.trim()) return "";
    var out = text;
    if (mk && typeof mk.toObsidian === "function") { try { out = mk.toObsidian(text, { images: images }); } catch (e) { out = text; } }
    return guardBody(neutralize(str(out).replace(/\r\n?/g, "\n")).replace(/\s+$/, ""), p && p.id);
  }
  // blockFor(prompt, collection, {images, now, origin, hostname}) → the block's Markdown, markers included, no final
  // newline, always well-formed text. images: as M.markup.toObsidian (true | id → name | false); origin / hostname
  // default to location's.
  function blockFor(p, col, opts) {
    opts = opts || {};
    var l = loc();
    var origin = opts.origin != null ? str(opts.origin) : (l && l.origin ? str(l.origin) : "");
    var host = opts.hostname != null ? str(opts.hostname) : (l && l.hostname ? str(l.hostname) : "");
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var quote = p && p.anchor && typeof p.anchor.quote === "string" ? p.anchor.quote.replace(/\s+$/, "") : "";
    var lines = ["<!-- marginalia:" + str(p && p.id) + " -->", "### " + neutralize(headingFor(p, col))];
    if (quote.trim()) lines.push(neutralize(quoteLines(quote)));
    lines.push("");
    var body = bodyOf(p, opts.images);
    if (body) lines.push(body, "");
    var date = localDate(now);
    lines.push(isLocalHost(host) && origin
      ? "[Open in Marginalia](" + origin.replace(/\/+$/, "") + "/#reader/" + encId(p && p.collectionId) + "/" + encId(p && p.id) + ") · " + date
      : date);
    lines.push("<!-- /marginalia -->");
    return wellFormed(lines.join("\n"));
  }
  // A note's title: its file name without the folder and ".md" (what notePath made of the nickname).
  function noteTitle(file) { var f = withoutMd(file); return f.slice(f.lastIndexOf("/") + 1) || "Untitled"; }
  // The first line or lines of a note that obsidian://new creates: "# <name>" and a blank line, as serve.py writes them.
  function titleFor(file) { return "# " + noteTitle(file) + "\n\n"; }
  // A vault's name exactly as Obsidian lists it (its folder's name: doubled, leading or trailing spaces stay); only
  // blank is no name.
  function vaultName(v) { var s = wellFormed(v); return s.trim() ? s : ""; }
  // uriFor(vault, file, content) → obsidian://new?vault=…&file=<path without .md>&content=…&append=true&silent
  // (every value percent-encoded: "/" → %2F, " " → %20; no vault: Obsidian takes the vault it has open)
  function uriFor(vault, file, content) {
    var q = [], v = vaultName(vault);
    if (v) q.push("vault=" + encodeURIComponent(v));
    q.push("file=" + encodeURIComponent(withoutMd(wellFormed(file))), "content=" + encodeURIComponent(wellFormed(content)), "append=true", "silent");
    return "obsidian://new?" + q.join("&");
  }
  // openUriFor(vault, file) → obsidian://open?vault=…&file=…
  function openUriFor(vault, file) {
    var q = [], v = vaultName(vault);
    if (v) q.push("vault=" + encodeURIComponent(v));
    q.push("file=" + encodeURIComponent(withoutMd(wellFormed(file))));
    return "obsidian://open?" + q.join("&");
  }

  // ---------------------------------------------------------------- opener, fetch (injectable)
  function defaultOpener(uri) {
    if (typeof document === "undefined" || !document || !document.body) return false;
    var a = document.createElement("a");
    a.href = uri;
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    document.body.appendChild(a);
    try { a.click(); } finally { setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0); }
    return true;
  }
  var opener = defaultOpener, fetchFn = null, apiBase = API_BASE;
  function openUri(uri) { try { return opener(uri) !== false; } catch (e) { return false; } }
  function doFetch(url, init) {
    var f = fetchFn || root.fetch;
    return Promise.resolve().then(function () { return f.call(root, url, init); });
  }

  // ---------------------------------------------------------------- the desktop app (FEATURES E2.2, js/desktop.js)
  // the headers of a POST: "X-Marginalia-Client: app" joins them in the desktop app; elsewhere they stay as given
  function postHeaders(base) {
    var D = M.desktop;
    if (D && typeof D.headers === "function") { try { return D.headers(base); } catch (e) { /* below */ } }
    return base;
  }
  // M.desktop's mode: "checking" while the page's app check runs (at boot), "cover" in a browser page the app replaced
  function desktopMode() {
    var D = M.desktop;
    try { return D && typeof D.mode === "function" ? D.mode() : null; } catch (e) { return null; }
  }
  var COVERED = "Marginalia is now an app — open it to send to Obsidian.";
  function coverRefusal(mode, file) {
    toast({ text: COVERED });
    return { ok: false, mode: mode || null, file: file || null, error: COVERED };
  }
  // A send in a page whose app check still runs waits for it; in cover mode it is refused (refuse()); else go().
  function desktopGate(go, refuse) {
    var dm = desktopMode();
    if (dm === "cover") return Promise.resolve(refuse());
    if (dm !== "checking") return go();
    var D = M.desktop;
    return Promise.resolve().then(function () { return D.ready(); }).then(null, noop).then(function () {
      return desktopMode() === "cover" ? refuse() : go();
    });
  }

  // ---------------------------------------------------------------- detect
  var detected = null, last = null, detectedAt = 0;   // detectedAt: when the cached check started (sendAll's FRESH_MS)
  function serverPossible() {
    if (isArtifact()) return false;
    var l = loc(), proto = l ? str(l.protocol) : "";
    if (proto !== "http:" && proto !== "https:") return false;
    return typeof (fetchFn || root.fetch) === "function";
  }
  // The page comes from a server on this Mac (127.0.0.1 or localhost, as Marginalia's own serve.py serves it).
  function localServerPage() {
    var l = loc();
    return serverPossible() && isLocalHost(l ? str(l.hostname) : "");
  }
  function cleanVaults(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (v) {
      if (!v || typeof v.name !== "string" || !v.name.trim()) return;
      out.push({ id: str(v.id), name: v.name, open: v.open === true, attachmentFolder: typeof v.attachmentFolder === "string" ? v.attachmentFolder : "/" });
    });
    return out;
  }
  // detect({force}) → Promise<{mode: "server"|"link", vaults, server, outdated, replaceOnly?}> (server: Marginalia's
  // server answered, even with no vault, in which case the mode is "link"; outdated: the page's own server on 127.0.0.1
  // or localhost is a serve.py from before the Obsidian endpoints, answering 404, 405 or 501, which a restart replaces;
  // replaceOnly: true when its GET /vaults says its /notes honours a block's replaceOnly). Cached until forced.
  function detect(opts) {
    if (detected && !(opts && opts.force)) return detected;
    var p;
    detectedAt = Date.now();
    if (!serverPossible()) p = Promise.resolve({ mode: "link", vaults: [], server: false, outdated: false });
    else {
      p = doFetch(apiBase + "/vaults", { method: "GET", headers: { "X-Marginalia": "1" }, cache: "no-store", credentials: "same-origin" })
        .then(function (r) {
          if (r && OLD_SERVER_STATUS[r.status] === true && localServerPage()) return { mode: "link", vaults: [], server: false, outdated: true };
          if (!r || !r.ok) throw new Error("HTTP " + (r ? r.status : "error"));
          return Promise.resolve(r.json()).then(function (j) {
            var vaults = cleanVaults(j && j.vaults);
            var d = { mode: vaults.length ? "server" : "link", vaults: vaults, server: true, outdated: false };
            // replaceOnly (the key only when true): this serve.py's /notes honours a block's "replaceOnly" (FEATURES A8);
            // one from before it ignores the field and would add an edited card whose earlier block is gone
            if (j && j.replaceOnly === true) d.replaceOnly = true;
            return d;
          });
        })
        .catch(function () { return { mode: "link", vaults: [], server: false, outdated: false }; });
    }
    detected = p;
    p.then(function (d) { if (detected === p) last = d; });
    return p;
  }

  // ---------------------------------------------------------------- send
  function base64(u8) {
    var X = tryDep("exporter");
    if (X && typeof X.bytesToBase64 === "function") return X.bytesToBase64(u8);
    var s = "", CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return root.btoa(s);
  }
  function sniff(b) {
    if (!b || b.length < 4) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
    return null;
  }
  // [{id, name, data}] for the image tokens of `text` whose bytes are stored (others become "[image]")
  function collectImages(text) {
    var P = tryDep("prompts"), store = M.store;
    var ids = P && typeof P.imageIds === "function" ? P.imageIds(str(text)) : [];
    if (!ids.length || !store || !store.attachments || typeof store.attachments.get !== "function") return Promise.resolve([]);
    return Promise.all(ids.map(function (id) {
      if (!ATT_ID_RE.test(id)) return null;
      return Promise.resolve().then(function () { return store.attachments.get(id); }).then(function (att) {
        if (!att || !att.bytes) return null;
        var u8 = att.bytes instanceof Uint8Array ? att.bytes : new Uint8Array(att.bytes);
        var ext = EXT[sniff(u8) || str(att.mime).toLowerCase()];
        return ext ? { id: id, name: "marginalia-" + id + "." + ext, data: base64(u8) } : null;
      }, function () { return null; });
    })).then(function (list) { return list.filter(Boolean); });
  }
  // What a sent block was built from: the prompt's content stamp (contentUpdatedAt) read when the block was built (a
  // value, not the record: some writers change the cached record in place, such as a move to a deck).
  function builtFrom(p) { return { stamp: p ? p.contentUpdatedAt : undefined }; }

  // ---- the send record: obsidianSentAt, obsidianFile, obsidianPendingFile (BUILD-NOTES "Obsidian"; FEATURES A8, A9)
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  // Every change to the send record goes through here: changes = [{id, fields}] (a field set to undefined is removed).
  // M.cache.patchPrompts writes them in place, in ONE store write, with no prompt:saved and never as a content edit,
  // so a send-all of a few hundred cards re-renders nothing per card; a cache without it (a test double, an older
  // one) gets one M.cache.savePrompt(copy, {content: false}) per record that changes. storeRecords → Promise<number>
  // that rejects when the store did not take the write (code "store", or "locked" in a tab that stepped aside), which
  // the write-ahead needs: no request leaves on a marker that was not stored (repair A9-R3 of 2026-11-10).
  // writeRecords → the same, never rejecting (a store failure is the cache's own "Could not save").
  function storeRecords(changes) {
    var C = M.cache, list = (Array.isArray(changes) ? changes : []).filter(Boolean);
    if (!list.length || !C) return Promise.resolve(0);
    if (typeof C.patchPrompts === "function") {
      try { return Promise.resolve(C.patchPrompts(list)); } catch (e) { return Promise.reject(e); }
    }
    if (typeof C.prompt !== "function" || typeof C.savePrompt !== "function") return Promise.resolve(0);
    return Promise.all(list.map(function (c) {
      var cur = C.prompt(c.id), same = true;
      if (!cur) return null;
      var next = Object.assign({}, cur);
      Object.keys(c.fields).forEach(function (k) {
        var v = c.fields[k];
        if (v === undefined) { if (hasOwn(next, k)) { delete next[k]; same = false; } }
        else if (!hasOwn(next, k) || next[k] !== v) { next[k] = v; same = false; }
      });
      if (same) return null;
      return Promise.resolve().then(function () { return C.savePrompt(next, { content: false }); });
    })).then(function (r) { return r.filter(Boolean).length; });
  }
  function writeRecords(changes) { return storeRecords(changes).catch(function () { return 0; }); }
  // A sent prompt records when and to which note (vault-relative path) it went, and the record replaces the marker
  // (obsidianPendingFile). `built` (builtFrom, taken with the sent block): when the prompt was edited while that block
  // was on its way (its content stamp moved since), the send is dated just before that edit, so the edit stays newer
  // than the send and the next "Send all" updates it (sendState) instead of taking it for a card already in Obsidian.
  // → the change for writeRecords, or null (a prompt gone or deleted meanwhile records nothing).
  function sentChange(id, file, built) {
    var C = M.cache, cur = C && typeof C.prompt === "function" ? C.prompt(id) : null;
    if (!cur || cur.deletedAt) return null;
    var at = Date.now(), cu = cur.contentUpdatedAt;
    if (built && isNum(cu) && cu !== built.stamp) at = Math.min(at, cu - 1);
    return { id: str(id), fields: { obsidianSentAt: at, obsidianFile: str(file), obsidianPendingFile: undefined } };
  }
  function markSent(id, file, built) { return writeRecords([sentChange(id, file, built)]); }

  // ---- write-ahead (FEATURES A9.2): before a request that may write blocks (POST /api/obsidian/note or /notes)
  // leaves, every card in it gets obsidianPendingFile = the request's note (the marker), stored first, unless it
  // already holds that value: a request can write its blocks and never be answered (the server stopped or restarted
  // mid-request, the connection dropped, the tab was closed or reloaded, or it stepped aside), and the page cannot tell.
  // The answer then settles each card (settle): "written" → its send record (sentChange; the marker goes); "not
  // written" (a 4xx JSON answer for the request, or a per-block ok: false result, notFound included) → the marker goes
  // back to what it was before this request (removed when there was none); "unsure" (a 5xx, no answer, a cut or
  // unparseable body, anything unexpected) → it stays. targetFile sends a marked card to that note, where the server
  // replaces the copy the lost request wrote, else adds it once; a link never sends it (heldLine).
  // inflight: promptId → {n: the requests of it on their way, before: its marker before the first of them}, so a
  // "not written" puts the marker back only once no other request of that prompt is on its way, and an "unsure" one
  // keeps it for good (before = that note).
  var inflight = new Map();
  // writeAhead(prompts, file) → Promise<flight> once the markers are stored ({file, open: ids not settled yet}). When the
  // store refuses that write (a full disk: storeRecords rejects), nothing may go: the flight is settled at once as "not
  // written" (the markers go back to what they were) and carries `unsaved`, and the caller sends nothing (repair A9-R3).
  function writeAhead(list, file) {
    var C = M.cache, changes = [], fl = { file: str(file), open: new Set(), unsaved: null };
    list.forEach(function (p) {
      var id = str(p && p.id), cur = C && typeof C.prompt === "function" ? C.prompt(id) : null;
      if (!id || fl.open.has(id)) return;
      fl.open.add(id);
      var f = inflight.get(id);
      if (f) f.n++;
      else inflight.set(id, { n: 1, before: cur ? cur.obsidianPendingFile : undefined });
      if (cur && cur.obsidianPendingFile !== fl.file) changes.push({ id: id, fields: { obsidianPendingFile: fl.file } });
    });
    return storeRecords(changes).then(function () { return fl; }, function (e) {
      settle(fl, "not", Array.from(fl.open));
      fl.unsaved = e || new Error(NOT_SAVED);
      return fl;
    });
  }
  // settle(flight, how, entries): how "written" (entries [{id, file, built}]: the note the server named and what the
  // block was built from), "not" or "unsure" (entries: ids). Each card of a flight is settled once (later calls for it
  // do nothing), so a catch-all (settle(fl, "unsure", Array.from(fl.open))) never undoes an answer. → Promise.
  function settle(fl, how, entries) {
    var C = M.cache, changes = [];
    (entries || []).forEach(function (x) {
      var id = str(how === "written" ? x.id : x);
      if (!fl || !fl.open.delete(id)) return;
      var f = inflight.get(id);
      if (f) { f.n--; if (f.n <= 0) inflight.delete(id); }
      if (how === "written") { changes.push(sentChange(id, x.file, x.built)); return; }
      if (how === "unsure") { if (f) f.before = fl.file; return; }      // the doubt stands, whatever another request answers
      var cur = C && typeof C.prompt === "function" ? C.prompt(id) : null;
      if (!f || f.n > 0 || !cur || cur.obsidianPendingFile !== fl.file || f.before === fl.file) return;
      changes.push({ id: id, fields: { obsidianPendingFile: f.before } });
    });
    return writeRecords(changes);
  }
  // A whole request refused with an answer: a 4xx whose body is JSON (tools/serve.py's {ok: false, error}) wrote
  // nothing. A 5xx (its "unexpected error" may come after a write), a body that is not JSON or never came, and no
  // answer at all leave the doubt.
  function refusedAll(r, j) { return !!r && r.status >= 400 && r.status < 500 && !!j && typeof j === "object" && j.ok !== true; }

  // FEATURES A9.1: what the toast (a single send) and the send-all confirm and toasts say about the cards an
  // obsidian:// link holds back because a send of them to the server did not finish (js/library.js words its confirm
  // the same way). The advice is to restart instead when an older serve.py answered (detect's outdated).
  var HELD = "a send to Marginalia's server did not finish";
  function heldLine(n, outdated) {
    return plural(n, "card") + " may already be in Obsidian: " + HELD + ". " +
      (outdated ? "Restart Marginalia (marginalia restart in Terminal)" : "Start Marginalia with the marginalia command") +
      " and send again: it checks the note and never adds a second copy.";
  }
  // Whether Marginalia has written `file` before: a prompt (deleted ones too) records a send to it. Sends from before
  // obsidianFile was recorded say nothing about where they went; they count for this book's note only while no send of
  // the book has a recorded file (after that, the recorded files tell which notes exist). An obsidian:// link cannot
  // ask Obsidian whether the note exists, so this decides whether the link's content starts with its "# <name>" title.
  function knownFile(p, col, file) {
    var C = M.cache, all = [], cid = col && col.id;
    try { all = C && typeof C.prompts === "function" ? C.prompts() : []; } catch (e) { all = []; }
    if (!Array.isArray(all)) all = [];
    all = all.concat([p]).filter(function (q) { return q && q.obsidianSentAt; });
    function recorded(q) { return typeof q.obsidianFile === "string" && q.obsidianFile !== ""; }
    if (all.some(function (q) { return recorded(q) && q.obsidianFile === file; })) return true;
    if (all.some(function (q) { return recorded(q) && q.collectionId === cid; })) return false;
    return all.some(function (q) { return !recorded(q) && q.collectionId === cid; });
  }
  function errorText(e) { return e && e.message ? "unexpected error (" + String(e.message) + ")" : "unexpected error"; }
  // f when it is a vault-relative note path Marginalia writes (each segment as notePath leaves it, ".md" last, at most
  // RECORDED_MAX characters), else null
  function writtenPath(f) {
    if (typeof f !== "string" || !f || f.length > RECORDED_MAX || !/\.md$/.test(f)) return null;
    var parts = f.split("/"), base = parts.pop().slice(0, -3), folder = parts.join("/");
    return base && fileName(base) === base && folderPath(folder) === folder ? f : null;
  }
  // The note a prompt's copy lives in: the path its last send recorded, when Marginalia writes such a path, else null
  // (never sent, sent before obsidianFile was recorded, or a record from elsewhere; a file without obsidianSentAt is
  // no send).
  function recordedFile(p) { return p && p.obsidianSentAt ? writtenPath(p.obsidianFile) : null; }
  // The marker: the note a server send that did not finish (still on its way, or never answered) was writing to
  // (writeAhead), which may hold the card's copy, else null. A card with one never goes through a link (A9.1).
  function pendingFile(p) { return p ? writtenPath(p.obsidianPendingFile) : null; }
  // Where a send goes: sending again updates the copy where it lives (the recorded note, even after a rename, a
  // folder change or a move to a deck), then the note a send that did not finish was writing to (it may hold the copy);
  // any other prompt goes to <folder>/<current nickname>.md.
  function targetFile(p, col) {
    return recordedFile(p) || pendingFile(p) || notePath(setting("obsidianFolder", DEFAULT_FOLDER), col.name || col.title);
  }
  // Copy inside the click that asked for it: writeText, else a selected textarea + execCommand("copy"). A copy the
  // clipboard refuses offers "Copy note" again, so a fresh click can retry until one succeeds. many: several blocks
  // (a send-all), so the toasts say "notes" and the button "Copy notes". detail (optional): a line both toasts carry,
  // the retry's too (a send-all copied above URI_LIMIT names the edited cards a link cannot update).
  function copyNote(block, file, many, detail) {
    function said(opts) { if (typeof detail === "string" && detail) opts.detail = detail; return opts; }
    function done() { toast(said({ text: (many ? "Notes copied — paste them into " : "Note copied — paste it into ") + file })); return true; }
    function fallback() {
      var ok = false;
      if (typeof document !== "undefined" && document && document.body) {
        var prev = document.activeElement, ta = document.createElement("textarea");
        ta.value = block; ta.readOnly = true; ta.setAttribute("aria-hidden", "true");
        ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.top = "0";
        document.body.appendChild(ta);
        try { ta.focus(); ta.select(); ok = !!(document.execCommand && document.execCommand("copy")); } catch (e) { ok = false; }
        if (ta.parentNode) ta.parentNode.removeChild(ta);
        try { if (prev && typeof prev.focus === "function") prev.focus({ preventScroll: true }); } catch (e2) { /* ignore */ }
      }
      if (ok) return done();
      toast(said({ text: "The browser blocked the clipboard — the " + (many ? "notes were" : "note was") + " not copied", ttl: 12000,
        actions: [{ label: many ? "Copy notes" : "Copy note", run: function () { copyNote(block, file, many, detail); } }] }));
      return false;
    }
    try {
      var nav = root.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        return Promise.resolve(nav.clipboard.writeText(block)).then(done, fallback);
      }
    } catch (e) { /* fall back */ }
    return Promise.resolve(fallback());
  }
  function fail(reason, block, file, mode) {
    toast({ text: "Could not add to Obsidian — " + reason, ttl: 12000,
      actions: block ? [{ label: "Copy note", run: function () { copyNote(block, file); } }] : [] });
    return { ok: false, mode: mode || null, file: file || null, error: reason };
  }
  function succeed(res, vault) {
    toast({ text: (res.replaced ? "Updated in Obsidian · " : "Added to Obsidian · ") + res.file, detail: res.detail || null,
      actions: [{ label: "Open in Obsidian", run: function () { openNote(vault, res.file); } }] });
    return res;
  }
  // The "Open in Obsidian" button of a toast: an obsidian://open link, only while the connection is still on (D32: the
  // toast can outlive the switch; then the click says OFF and opens nothing).
  function openNote(vault, file) {
    if (!enabled()) { offRefusal(); return false; }
    return openUri(openUriFor(vault, file));
  }
  // FEATURES A9.1: a card with the marker (pendingFile: a server send of it did not finish, so its note may hold it)
  // never goes through an obsidian:// link, which can only add: no link, no copy (a copy invites the second copy; the
  // card menu's own copy items stay), and the toast says why and what to do. The card stays in the margin as always.
  function holdBack(file, outdated) {
    toast({ text: heldLine(1, outdated), ttl: 12000 });
    return { ok: false, mode: "link", file: file || null, error: HELD };
  }
  // The card holds the marker now: a server send of it may have written it to a note with nothing recorded (this
  // request left no telling, or an earlier one did not finish, or another is still on its way). Such a card is never
  // offered to copy, since a copy invites the second copy (as for A9.1; repair D2 of the A9 review, 2026-11-10).
  function markedNow(id) {
    var C = M.cache, p = null;
    try { p = C && typeof C.prompt === "function" ? C.prompt(str(id)) : null; } catch (e) { p = null; }
    return !!pendingFile(p);
  }
  // A server send that definitely wrote nothing (a 4xx JSON refusal, an older server, nothing sent at all): "Copy note"
  // as for any failure, unless the card holds the marker (so does every other failure of a send: send(), viaServer).
  function failServer(reason, plain, file, id) { return fail(reason, markedNow(id) ? null : plain, file, "server"); }
  // A server send that left no telling (no answer, a 5xx, a 2xx that could not be read, anything unexpected once the
  // request left) may have written the card: it keeps the marker, the toast says it may already be in Obsidian and
  // what to do, and nothing is offered to copy (repair D2).
  function maybeThere(reason, file) {
    toast({ text: "May already be in Obsidian — " + reason,
      detail: "Send it again once Marginalia's server answers: it checks " + file + " and never adds a second copy.", ttl: 12000 });
    return { ok: false, mode: "server", file: file || null, error: reason };
  }
  // The vault to write into: settings.obsidianVault exactly as stored (a vault's name as Obsidian lists it, spaces
  // and all), or the only vault Marginalia's server found when that is blank.
  function chooseVault(d) {
    var wanted = vaultName(setting("obsidianVault", ""));
    if (d.mode !== "server") return { name: wanted };
    if (wanted) {
      for (var i = 0; i < d.vaults.length; i++) if (d.vaults[i].name === wanted) return { name: d.vaults[i].name };
      return { error: "the vault “" + wanted + "” was not found — choose one in Settings › Obsidian" };
    }
    if (d.vaults.length === 1) return { name: d.vaults[0].name };
    return { error: "choose a vault in Settings › Obsidian" };
  }
  // the server's "error"; the app's server refusing a page that is not the app (409 "app_only", FEATURES E2.1c) says why
  // in its "message" ("Marginalia is now an app. Open the Marginalia app to do this.")
  function appOnly(j) { return j && j.error === "app_only" && typeof j.message === "string" && j.message ? j.message : null; }
  function serverReason(status, j) {
    var msg = appOnly(j) || (j && typeof j.error === "string" && j.error ? j.error : null);
    if (status === 413) return "the note and its images are larger than 25 MB";
    if (OLD_SERVER_STATUS[status] === true) return "Marginalia's server has no Obsidian support — " + RESTART;
    return msg || ("the server answered " + status);
  }

  // plain: the block with images as "[image]", the one a failure offers to copy (a failed send wrote no image), unless
  // the card may be in the note already (failServer, maybeThere)
  function viaServer(p, col, vault, file, plain) {
    return collectImages(p.text).then(function (imgs) {
      var names = {};
      imgs.forEach(function (im) { names[im.id] = im.name; });
      var built = builtFrom(p), block = blockFor(p, col, { images: function (id) { return names[id] || null; } });
      var body = JSON.stringify({ vault: vault, file: file, title: noteTitle(file), blockId: p.id, markdown: block,
        images: imgs.map(function (im) { return { name: im.name, data: im.data }; }) });
      if (body.length > MAX_BODY) return failServer("the note and its images are larger than 25 MB", plain, file, p.id);
      // an import began while the images were read (A10.1): nothing leaves. Checked in the same task as writeAhead,
      // which puts the marker on the cached record before it awaits anything
      if (importBusy()) return waitImport("server", file);
      // the marker is stored before the request leaves (writeAhead), and the answer settles it
      return writeAhead([p], file).then(function (fl) {
        if (tabLocked()) {                              // stepped aside meanwhile: nothing goes (its writes are refused)
          settle(fl, "unsure", Array.from(fl.open));
          return fail(LOCKED, null, null, "server");
        }
        if (fl.unsaved) return failServer(NOT_SAVED, plain, file, p.id);   // the marker was not stored: nothing goes
        return doFetch(apiBase + "/note", {
          method: "POST", body: body, cache: "no-store", credentials: "same-origin",
          headers: postHeaders({ "Content-Type": "application/json", "X-Marginalia": "1" })
        }).then(function (r) {
          var jp;
          try { jp = r.json(); } catch (e) { jp = null; }
          return Promise.resolve(jp).catch(function () { return null; }).then(function (j) {
            if (r.ok && j && j.ok) {
              var written = typeof j.file === "string" && j.file ? j.file : file;
              settle(fl, "written", [{ id: p.id, file: written, built: built }]);
              return succeed({ ok: true, mode: "server", file: written, created: !!j.created, replaced: !!j.replaced }, vault);
            }
            var old = OLD_SERVER_STATUS[r.status] === true, definite = refusedAll(r, j);
            if (old) detected = null;                   // an older server: check again
            // a 4xx JSON refusal wrote nothing; a 5xx, or a 2xx whose answer never came, may have written the note
            settle(fl, definite ? "not" : "unsure", [p.id]);
            var why = r.ok && !j ? UNREAD : serverReason(r.status, j);
            return definite || old ? failServer(why, plain, file, p.id) : maybeThere(why, file);
          });
        }, function () {
          detected = null;
          settle(fl, "unsure", [p.id]);                 // no answer: it may have written the note all the same
          return maybeThere(NO_ANSWER, file);
        }).then(null, function (e) {
          settle(fl, "unsure", [p.id]);                 // whatever broke, the request went: the marker stays
          return maybeThere(errorText(e), file);
        });
      });
    });
  }

  // d: detect()'s answer (d.outdated: an older serve.py serves the page, so the advice is to restart it); built: what
  // the block was built from (builtFrom)
  function viaLink(p, col, vault, file, fromGesture, block, d, built) {
    var outdated = !!(d && d.outdated);
    if (pendingFile(p)) return Promise.resolve(holdBack(file, outdated));
    if (typeof block !== "string") return Promise.resolve(fail("unexpected error", null, file, "link"));
    // where the last send went: undefined = never sent, null = a note not recorded (a send from before obsidianFile)
    var was = !p.obsidianSentAt ? undefined : (typeof p.obsidianFile === "string" && p.obsidianFile ? p.obsidianFile : null);
    // obsidian://new creates a missing note with exactly this content, so a note Marginalia has not written before
    // starts with its "# <name>" title (append=true adds it after the note's text when the note exists after all)
    var content = knownFile(p, col, file) ? block : titleFor(file) + block;
    var uri;
    try { uri = uriFor(vault, file, content); }
    catch (e) { return Promise.resolve(fail(errorText(e), block, file, "link")); }
    if (uri.length > URI_LIMIT) {
      return Promise.resolve(copyNote(block, file)).then(function () {
        return { ok: false, mode: "copy", file: file, error: "too_long", uri: null };
      });
    }
    // "a second copy" only when the earlier send went to this note; an earlier copy elsewhere is named
    var detail = was === null || was === file
      ? "Sent through an obsidian:// link, which can only append: the note now holds a second copy — delete the older one in Obsidian."
      : typeof was === "string"
        ? "Sent through an obsidian:// link. The earlier copy stays in " + was + "."
        : "Sent through an obsidian:// link. " + (outdated ? "Restart Marginalia (marginalia restart in Terminal)" : "Start Marginalia with the marginalia command") +
          " to write silently and update in place.";
    function go() {
      if (desktopMode() === "cover") return coverRefusal("link", file);   // FEATURES E2.2c: the app sends, never this page
      // a tab that stepped aside meanwhile (while detect() asked the server, or before the toast's button was clicked)
      // opens no link: the active tab would not know of it and could add the card again (repair D6)
      if (tabLocked()) return fail(LOCKED, null, null, "link");
      if (!enabled()) return offRefusal();                       // D32: the switch went off before the toast's button was clicked
      if (importBusy()) return waitImport("link", file);         // an import is saving (A10.1): the link waits too
      var C = M.cache, now = C && typeof C.prompt === "function" ? C.prompt(p.id) : null;
      if (now && pendingFile(now)) return holdBack(file, outdated);      // a server send of it began meanwhile
      if (!openUri(uri)) return fail("this browser cannot open obsidian:// links" + (outdated ? " — " + RESTART + " to write silently" : ""), block, file, "link");
      markSent(p.id, file, built);
      return succeed({ ok: true, mode: "link", file: file, created: false, replaced: false, uri: uri, detail: detail }, vault);
    }
    if (fromGesture) return Promise.resolve(go());
    // no user gesture to open a link in: the toast's button is one
    toast({ text: "Ready for Obsidian · " + file, ttl: 20000, actions: [{ label: "Add to Obsidian", run: function () { go(); } }] });
    return Promise.resolve({ ok: false, mode: "link", file: file, error: "needs_click", uri: uri });
  }

  // One writing tab per origin (js/store.js): once a newer Marginalia tab took over, this tab's copy may be older than
  // what that tab stored, so it sends nothing to Obsidian either.
  function tabLocked() {
    var st = M.store;
    try { return !!(st && typeof st.locked === "function" && st.locked()); } catch (e) { return false; }
  }

  // FEATURES A10.1: while an import is saving its merged records (M.exporter.isImporting(): from before its first write
  // to after its last, success or failure), no send leaves, in either mode: a card may still lack the marker its backup
  // carries (obsidianPendingFile), so a link could add a copy its note holds already and a server send could write it
  // into another note. The send toasts WAIT_IMPORT (no actions) and the card stays as it is (no marker, no record,
  // nothing copied). It is checked when a send starts, again once the server has answered detect(), right before a
  // request's write-ahead (the moment a server send leaves: from then on it is a send on its way, which importJSON's
  // re-merge keeps, repair D4) and right before a link opens.
  var IMPORTING = "an import is still saving";
  var WAIT_IMPORT = "Wait until the import finishes, then send again.";
  function importBusy() {
    var X = M.exporter;
    try { return !!(X && typeof X.isImporting === "function" && X.isImporting()); } catch (e) { return false; }
  }
  function waitImport(mode, file) {
    toast({ text: WAIT_IMPORT });
    return { ok: false, mode: mode || null, file: file || null, error: IMPORTING };
  }

  // DECISIONS D32: the connection is an option (settings.obsidian: true | false; null = never chosen). enabled() →
  // the stored choice; never chosen: true only while the library holds a send record (obsidianSentAt, or the marker
  // obsidianPendingFile, on any record, deleted ones included), so a library that already used Obsidian keeps it.
  var OFF = "The Obsidian connection is off — turn it on in Settings › Obsidian.";
  function usedBefore() {
    var C = M.cache, all;
    try { all = C && typeof C.prompts === "function" ? C.prompts() : []; } catch (e) { all = []; }
    return (Array.isArray(all) ? all : []).some(function (p) {
      return !!p && ((typeof p.obsidianSentAt === "number" && p.obsidianSentAt > 0) ||
        (typeof p.obsidianPendingFile === "string" && p.obsidianPendingFile !== ""));
    });
  }
  function enabled() {
    var v = setting("obsidian", null);
    return v === true || (v !== false && usedBefore());
  }
  function offRefusal() {
    toast({ text: OFF });
    return { ok: false, mode: null, file: null, error: OFF };
  }

  // send(promptId, {fromGesture}) → Promise<{ok, mode, file, created?, replaced?, uri?, error?}> (never rejects).
  // FEATURES E2.2: refused in a browser page the desktop app replaced, and waits for the app check while it runs.
  function send(promptId, opts) {
    return desktopGate(function () { return sendNow(promptId, opts); }, function () { return coverRefusal(null, null); });
  }
  function sendNow(promptId, opts) {
    opts = opts || {};
    if (tabLocked()) return Promise.resolve(fail("Marginalia is open in another tab", null, null));
    if (!enabled()) return Promise.resolve(offRefusal());         // D32: the connection is switched off
    if (importBusy()) return Promise.resolve(waitImport(null, null));
    var C = M.cache;
    var p = C && typeof C.prompt === "function" ? C.prompt(promptId) : null;
    if (!p || p.deletedAt) return Promise.resolve(fail("that note is no longer here", null, null));
    var col = typeof C.collection === "function" ? C.collection(p.collectionId) : null;
    if (!col || col.deletedAt) return Promise.resolve(fail("its book or deck is no longer in the library", null, null));
    if (!BLOCK_ID_RE.test(str(p.id))) return Promise.resolve(fail("this note's id cannot mark an Obsidian block", null, null));
    if (!str(p.text).trim() && !(p.anchor && str(p.anchor.quote).trim())) return Promise.resolve(fail("the note is empty", null, null));
    var file = targetFile(p, col);
    var fromGesture = !!opts.fromGesture;
    // built first, so that whatever fails later the toast still offers "Copy note" with it
    var block = null, built = builtFrom(p);
    try { block = blockFor(p, col, { images: false }); } catch (e) { block = null; }
    var cached = !!detected;
    return detect().then(function (d) {
      // a cached "link" on a page Marginalia's own server serves is checked again: the server may have been
      // restarted (marginalia restart) with the Obsidian endpoints since
      return cached && d && d.mode === "link" && localServerPage() ? detect({ force: true }) : d;
    }).then(function (d) {
      if (importBusy()) return waitImport(d.mode, file);         // an import began while the server was asked (A10.1)
      var v = chooseVault(d);
      if (v.error) return fail(v.error, markedNow(p.id) ? null : block, file, d.mode);
      return d.mode === "server" ? viaServer(p, col, v.name, file, block) : viaLink(p, col, v.name, file, fromGesture, block, d, built);
    }).catch(function (e) {
      return fail(errorText(e), markedNow(p.id) ? null : block, file);
    });
  }

  // ---------------------------------------------------------------- send all (a whole book or deck at once)
  // sendAll(collectionId, {fromGesture}) sends the live prompts of a book or deck, each kind (qa, cloze, note,
  // highlight), in reading order, as the very blocks send() writes (blockFor, the same targetFile rule, the same
  // images), and never a card twice (FEATURES A8; sendState): a card never sent is added, one sent before and edited
  // since its last send updates its copy where it lives and nothing else, one sent before and not edited since goes in
  // no request ("already there").
  // - Server: one POST /api/obsidian/notes per target note {vault, file, title, blocks: [{blockId, markdown,
  //   replaceOnly?}], images}, split into requests of at most SPLIT_BYTES (about 20 MB; a block bigger than that alone
  //   goes alone, up to the server's NOTES_MAX_BODY) and NOTES_MAX_BLOCKS blocks. An edited card's block carries
  //   "replaceOnly": true: the server replaces its earlier block, and when that block is no longer in the note it writes
  //   nothing for it and answers {blockId, ok: false, notFound: true, error} (the card keeps its earlier record, is
  //   listed in the toast, and "Copy notes" offers it). The answer's results say per block whether it was written
  //   (replaced = updated); each written block records obsidianSentAt / obsidianFile like a single send. A serve.py from
  //   before /notes (404, 405 or 501 there) gets one POST /api/obsidian/note per never-sent card instead, so a server that
  //   was not restarted since still sends the new cards; /note always adds a block it does not find, so the edited
  //   cards wait for a restart (listed, never sent there). Every request writes its cards' markers ahead and settles
  //   them by its answer (writeAhead, settle). A card with the marker whose stamps say "unchanged" goes all the same,
  //   with "replaceOnly" (FEATURES A9.3, plan.recheck), so the server settles the doubt and the marker goes.
  // - Link: only prompts never sent before (an obsidian:// link can only add) and without the marker (A9.1: those are
  //   held back, plan.marked, and named), all their blocks in ONE obsidian://new link to the book's note, "# <name>"
  //   first by the title rule of a single link send; above URI_LIMIT the joined blocks are copied instead ("paste them
  //   into <file>"). The toast counts the edited cards a link cannot update and names the held-back ones.
  // planAll(collectionId) answers what sendAll would do now, for the confirm the library shows first (whose click is
  // the gesture a link needs). With no card fresh, changed or marked both answer at once: no check, no request. A tab
  // that stepped aside sends nothing, and a second send-all of a collection whose send-all still runs is refused.
  var NOTES_MAX_BODY = 100 * 1024 * 1024;    // tools/serve.py refuses a larger POST /api/obsidian/notes
  var NOTES_MAX_BLOCKS = 2000;               // and more blocks than this in one request
  var SPLIT_BYTES = 20 * 1024 * 1024;        // a target note's blocks go out in requests of about this size at most
  var FRESH_MS = 10000;                      // a detect() answer this young is not checked again by sendAll
  var LOCKED = "Marginalia is open in another tab";
  var NO_ANSWER = "Marginalia's server did not answer";
  var UNREAD = "the server's answer could not be read";            // a 2xx whose body was cut off or is not JSON
  var LEFT_OUT = "the server's answer left it out";                // a block missing from a /notes answer's results
  var NOT_SAVED = "Marginalia could not save, so nothing was sent"; // the store refused the write-ahead (repair A9-R3)
  var BAD_ID = "this note's id cannot mark an Obsidian block";
  var BUSY = "already sending";
  var NOT_FOUND = "its earlier copy is no longer in the note";   // serve.py's words for a replaceOnly block it did not find
  var LINK_ADDS = "links can only add";
  var allRunning = new Map();                // collectionId → true while its send-all runs

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function livePromptsOf(cid) {
    var C = M.cache, all;
    try {
      all = C && typeof C.promptsOf === "function" ? C.promptsOf(cid) : (C && typeof C.prompts === "function" ? C.prompts() : []);
    } catch (e) { all = []; }
    return (Array.isArray(all) ? all : []).filter(function (p) { return p && p.collectionId === cid && !p.deletedAt; });
  }
  function sectionOf(p) { return oneLine(p && p.context && p.context.sectionLabel); }
  function pageOf(p) {
    if (p.anchor && isNum(p.anchor.pageIndex)) return p.anchor.pageIndex;
    if (p.context && isNum(p.context.pageIndex)) return p.context.pageIndex;
    return 0;
  }
  function yOf(p) { return p.anchor && isNum(p.anchor.y) ? p.anchor.y : Infinity; }   // none: the top of its page
  function createdOf(p) { return isNum(p.createdAt) ? p.createdAt : 0; }
  function byCreation(a, b) {
    var d = createdOf(a) - createdOf(b), x = str(a.id), y = str(b.id);
    return d || (x < y ? -1 : x > y ? 1 : 0);
  }
  // readingOrder(prompts, collection) → a new array. Books: page, then from the top of the page down (PDF y grows
  // upwards; no y = the page's top), then creation (the prompt list's order). Decks: section, in the order the
  // sections first appear, then creation.
  function readingOrder(list, col) {
    var out = (Array.isArray(list) ? list : []).filter(Boolean).slice().sort(byCreation);
    if (col && col.kind === "deck") {
      var rank = new Map();
      out.forEach(function (p) { var s = sectionOf(p); if (!rank.has(s)) rank.set(s, rank.size); });
      return out.sort(function (a, b) { return (rank.get(sectionOf(a)) - rank.get(sectionOf(b))) || byCreation(a, b); });
    }
    return out.sort(function (a, b) {
      var d = pageOf(a) - pageOf(b), ya = yOf(a), yb = yOf(b);
      return d || (ya !== yb ? (yb > ya ? 1 : -1) : byCreation(a, b));
    });
  }
  // UTF-8 bytes of a string (the server's body limits count bytes)
  function utf8Length(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  // The file of a {file, prompts} group list (primaryIn: of a file → count map) that holds the most (the first such):
  // the note the confirm and the toast name first.
  function primaryOf(groups) {
    var best = null;
    groups.forEach(function (g) { if (!best || g.prompts.length > best.prompts.length) best = g; });
    return best ? best.file : null;
  }
  function primaryIn(counts) {
    var best = null, n = -1;
    counts.forEach(function (k, f) { if (k > n) { best = f; n = k; } });
    return best;
  }
  function linkAdvice(outdated) {
    return (outdated ? "Restart Marginalia (marginalia restart in Terminal)" : "Start Marginalia with the marginalia command") +
      " to write silently and update in place.";
  }
  // a book's or deck's name as the toasts quote it
  function colName(col) { return oneLine(col && (col.name || col.title)) || (col && col.kind === "deck" ? "this deck" : "this book"); }
  // "2 edited cards were not updated: <why>" (one: "1 edited card was not updated: <why>"); rechecked: cards sent before
  // and not edited since whose last send did not finish (plan.recheck, A9.3), "1 card whose last send did not finish was
  // not updated: <why>", never called edited (repair D5 of the A9 review, 2026-11-10)
  function notUpdatedLine(n, why, rechecked) {
    return (rechecked ? plural(n, "card") + " whose last send did not finish" : plural(n, "edited card")) + " " +
      (n === 1 ? "was" : "were") + " not updated: " + why;
  }
  function notFoundWhy(n) { return (n === 1 ? "its" : "their") + " earlier copy is no longer in the note"; }
  function hasContent(p) { return !!(str(p.text).trim() || (p.anchor && str(p.anchor.quote).trim())); }

  // sendState(prompt) → "fresh" | "changed" | "unchanged" (pure; FEATURES A8): what a send-all does with a card.
  // "fresh": never sent (no obsidianSentAt), so it is added. "changed": sent before and edited since its last send —
  // its content stamp, contentUpdatedAt, is newer than obsidianSentAt (M.cache.savePrompt moves that stamp when a
  // person changes the kind, text, tags, flag, collection or passage, and on a restore; a send's own {content: false}
  // record, a context snapshot or a re-found anchor never moves it) — or the send has no time: its earlier block is
  // replaced in place and never added again. "unchanged": sent before and not edited since: no request carries it.
  function sendState(p) {
    if (!p || !p.obsidianSentAt) return "fresh";
    if (!isNum(p.obsidianSentAt)) return "changed";
    return isNum(p.contentUpdatedAt) && p.contentUpdatedAt > p.obsidianSentAt ? "changed" : "unchanged";
  }

  // What a send-all of `col` would send now: every live prompt in reading order that has something to send (`list`: text
  // or a quote; `empty` the rest), each by sendState (`fresh`, `changed`, `unchanged`), except that a card with the
  // marker (pendingFile: a server send of it did not finish) whose stamps say "unchanged" is in `recheck` instead
  // (FEATURES A9.3: it is not known to be there); `sentBefore` = changed + unchanged + recheck; `marked`: every card
  // with the marker, whatever its state (`markedIds` their ids; a link holds them back, A9.1). The cards a server send
  // carries (`send`: fresh, changed and recheck, in reading order; `replace`: the ids of the changed and recheck ones,
  // whose blocks go with replaceOnly) grouped by target note (`groups`), and the book's own note (`linkFile`: where
  // never-sent prompts and link mode go). `mode` is set once detect() has answered.
  function planFor(col) {
    var plan = { col: col, mode: null, list: [], empty: [], fresh: [], changed: [], unchanged: [], recheck: [], marked: [],
      markedIds: new Set(), sentBefore: 0, send: [], replace: new Set(), groups: [],
      linkFile: notePath(setting("obsidianFolder", DEFAULT_FOLDER), col.name || col.title) };
    var byFile = new Map();
    readingOrder(livePromptsOf(col.id), col).forEach(function (p) {
      if (!hasContent(p)) { plan.empty.push(p); return; }
      plan.list.push(p);
      var s = sendState(p);
      if (pendingFile(p)) {
        plan.marked.push(p);
        plan.markedIds.add(str(p.id));
        if (s === "unchanged") s = "recheck";           // sent before, not edited since, but its last send did not finish
      }
      plan[s].push(p);
      if (s !== "fresh") plan.sentBefore++;
      if (s === "unchanged") return;                    // already there: no request carries it
      if (s !== "fresh") plan.replace.add(str(p.id));
      plan.send.push(p);
      var f = targetFile(p, col);
      if (!byFile.has(f)) { byFile.set(f, { file: f, prompts: [] }); plan.groups.push(byFile.get(f)); }
      byFile.get(f).prompts.push(p);
    });
    return plan;
  }
  // Link mode's share of a plan (A9.1): the never-sent cards without the marker go; the edited ones without it are not
  // updated (a link can only add); every marked card is held back (plan.marked).
  function linkFresh(plan) { return plan.fresh.filter(function (p) { return !plan.markedIds.has(str(p.id)); }); }
  function linkChanged(plan) { return plan.changed.filter(function (p) { return !plan.markedIds.has(str(p.id)); }); }
  // The one obsidian://new link of a link-mode send-all: the blocks of the never-sent prompts without the marker, a blank
  // line apart, "# <name>" first when the note is new to Marginalia (knownFile, the rule of a single link send); `built`:
  // what each item's block was built from (builtFrom), and `blocks` the blocks, both in the order of `items`.
  function linkPayload(plan, vault) {
    var items = linkFresh(plan).filter(function (p) { return BLOCK_ID_RE.test(str(p.id)); });
    return linkUri({ file: plan.linkFile, items: items, built: items.map(builtFrom),
      blocks: items.map(function (p) { return blockFor(p, plan.col, { images: false }); }) }, plan, vault);
  }
  // pay's joined blocks and its URI, the title decided by knownFile as it stands now (also at the click, A10.2)
  function linkUri(pay, plan, vault) {
    pay.joined = pay.blocks.join("\n\n");
    var content = knownFile(null, plan.col, pay.file) ? pay.joined : titleFor(pay.file) + pay.joined;
    pay.uri = pay.items.length ? uriFor(vault, pay.file, content) : "";
    return pay;
  }
  function tooLong(plan, vault) {
    try { return linkPayload(plan, vault).uri.length > URI_LIMIT; } catch (e) { return false; }
  }

  // Whether a send-all of the collection may start: not in a tab that stepped aside, not while an import is saving
  // (A10.1: importing), not while one runs, and only for a live book or deck.
  function gateAll(collectionId) {
    if (tabLocked()) return { error: LOCKED };
    if (!enabled()) return { error: OFF, off: true };            // D32: the connection is switched off
    if (importBusy()) return { error: IMPORTING, importing: true };
    var C = M.cache, col = null;
    try { col = C && typeof C.collection === "function" ? C.collection(collectionId) : null; } catch (e) { col = null; }
    var name = col ? colName(col) : "";
    if (allRunning.has(str(collectionId))) return { error: BUSY, busy: true, name: name };
    if (!col || col.deletedAt) return { error: "its book or deck is no longer in the library" };
    return { col: col, key: str(collectionId), name: name };
  }
  // detect() as a send-all uses it: a cached "link" on a page Marginalia's own server serves is checked again, as a
  // single send does, and so is a cached server without replaceOnly (a serve.py from before it, which a restart may
  // have replaced since), unless (young) the answer is younger than FRESH_MS (sendAll right after planAll's check).
  function modeFor(young) {
    var cached = !!detected, fresh = young && cached && Date.now() - detectedAt < FRESH_MS;
    return detect().then(function (d) {
      var recheck = d && (d.mode === "link" ? localServerPage() : d.mode === "server" && !d.replaceOnly);
      return cached && !fresh && recheck ? detect({ force: true }) : d;
    });
  }

  // planAll(collectionId) → Promise<{ok, mode, count, fresh, changed, unchanged, rechecked, held, sentBefore, total,
  // skipped, file, files, tooLong, outdated, error?, busy?}> (never rejects): count = the cards sendAll would send now
  // (server: the fresh, the changed and the rechecked ones; link mode: only the fresh ones without the marker), fresh /
  // changed / unchanged = the cards by sendState, rechecked = (server) the cards sent before and not edited since whose
  // last send did not finish (the marker; they go too, A9.3), held = (link mode) the cards with the marker, which a link
  // holds back (A9.1; in link mode fresh and changed leave them out), sentBefore = changed + unchanged + rechecked, total
  // = every card with something to send, skipped = those no request would carry (empty and unchanged ones; in link mode
  // the changed and held ones too), file = the note named first (the one that gets the most), files = every target
  // note, outdated = detect()'s. With no card fresh, changed or marked it answers at once with count 0: no check and no
  // request (mode and outdated: the last check's, null / false before any).
  function planAll(collectionId) {
    // FEATURES E2.2: in a browser page the desktop app replaced nothing is planned ({covered: true}; the caller says so)
    return desktopGate(function () { return planAllNow(collectionId); }, function () {
      return { ok: false, mode: null, count: 0, fresh: 0, changed: 0, unchanged: 0, rechecked: 0, held: 0, sentBefore: 0,
        total: 0, skipped: 0, file: null, files: [], tooLong: false, outdated: false, error: COVERED, covered: true };
    });
  }
  function planAllNow(collectionId) {
    var none = { ok: false, mode: null, count: 0, fresh: 0, changed: 0, unchanged: 0, rechecked: 0, held: 0, sentBefore: 0,
      total: 0, skipped: 0, file: null, files: [], tooLong: false, outdated: false };
    var g = gateAll(collectionId);
    if (g.error) return Promise.resolve(Object.assign(none, { error: g.error, busy: !!g.busy }, g.importing ? { importing: true } : {}, g.off ? { off: true } : {}));
    // the cards by what this mode does with them: server sends the marked ones (fresh, changed or rechecked), a link
    // holds them back (held) and leaves them out of fresh and changed
    function counts(plan, link) {
      var fresh = link ? linkFresh(plan).length : plan.fresh.length, changed = link ? linkChanged(plan).length : plan.changed.length;
      var rechecked = link ? 0 : plan.recheck.length, held = link ? plan.marked.length : 0, unchanged = plan.unchanged.length;
      return { fresh: fresh, changed: changed, unchanged: unchanged, rechecked: rechecked, held: held,
        sentBefore: changed + unchanged + rechecked, total: plan.list.length,
        skipped: plan.empty.length + (link ? plan.list.length - fresh : unchanged), file: plan.linkFile };
    }
    var pre;
    try { pre = planFor(g.col); } catch (e) { return Promise.resolve(Object.assign(none, { error: errorText(e) })); }
    if (!pre.send.length) return Promise.resolve(Object.assign(none, counts(pre, false), { ok: true, mode: last ? last.mode : null, outdated: !!(last && last.outdated) }));
    return modeFor(false).then(function (d) {
      var v = chooseVault(d), plan = planFor(g.col), link = d.mode !== "server";
      var out = Object.assign(none, counts(plan, link), { mode: d.mode, outdated: !!d.outdated });
      if (v.error) return Object.assign(out, { error: v.error });
      if (!link) {
        var first = primaryOf(plan.groups) || plan.linkFile;
        return Object.assign(out, { ok: true, count: plan.send.length, file: first,
          files: plan.groups.map(function (x) { return x.file; }).sort(function (a, b) { return (b === first) - (a === first); }) });
      }
      var n = out.fresh;
      return Object.assign(out, { ok: true, count: n, file: plan.linkFile, files: n ? [plan.linkFile] : [], tooLong: n > 0 && tooLong(plan, v.name) });
    }).catch(function (e) { return Object.assign(none, { error: errorText(e) }); });
  }

  // ---- the result of a send-all, and its toast
  // notFound: edited cards the server did not update because their earlier block is no longer in the note (nothing
  // written, nothing recorded); notUpdated: edited cards no request carried (a link can only add; a serve.py from before
  // /notes cannot replace only); held: cards with the marker a link held back (A9.1). skipped counts every card no
  // request carried (empty, unchanged, notUpdated and held ones).
  function newResult(mode, plan) {
    return { ok: false, mode: mode, sent: 0, added: 0, updated: 0, unchanged: plan ? plan.unchanged.length : 0,
      skipped: plan ? plan.empty.length + plan.unchanged.length : 0, notFound: [], notUpdated: [], held: [], failed: [], files: [],
      file: null, _copy: [], _lost: [], _per: new Map(), _done: new Set(), _marks: [], _unsure: new Set() };
  }
  function publicResult(res) {
    var out = Object.assign({}, res);
    delete out._copy; delete out._lost; delete out._per; delete out._done; delete out._marks; delete out._unsure;
    return out;
  }
  // a written block, counted; its record (obsidianSentAt, obsidianFile, dated before an edit made since its block was
  // built: sentChange) is written by the caller, one write for all the blocks of a request (settle "written"; a link's
  // writeRecords), and saved before the toast (res._marks)
  function countSent(res, p, file, replaced) {
    if (res._done.has(p.id)) return;
    res._done.add(p.id);
    res.sent++;
    if (replaced) res.updated++; else res.added++;
    if (!res._per.has(file)) { res._per.set(file, 0); res.files.push(file); }
    res._per.set(file, res._per.get(file) + 1);
  }
  // a card with the marker an obsidian:// link held back (A9.1): nothing sent, nothing offered to copy
  function heldOne(res, p) {
    if (res._done.has(p.id)) return;
    res._done.add(p.id);
    res.held.push({ promptId: p.id, error: HELD });
  }
  function plainBlock(plan, p) { try { return blockFor(p, plan.col, { images: false }); } catch (e) { return null; } }
  // a block that could not be sent: its reason, and its block with images as "[image]" for "Copy notes"
  function failOne(res, plan, p, reason, file) {
    if (res._done.has(p.id)) return;
    res._done.add(p.id);
    res.failed.push({ promptId: p.id, error: reason });
    res._copy.push({ id: str(p.id), block: plainBlock(plan, p), file: file });
  }
  // a block a request may have written although no answer said so (no answer, a 5xx, a 2xx that could not be read, left
  // out of the results): a failure too, but its card keeps the marker, and the toast names it apart ("may already be in
  // Obsidian") and never offers it to copy (repair D2 of the A9 review, 2026-11-10)
  function unsureOne(res, plan, p, reason, file) {
    if (res._done.has(p.id)) return;
    res._unsure.add(str(p.id));
    failOne(res, plan, p, reason, file);
  }
  // an edited card whose earlier block the server no longer found in its note (replaceOnly): nothing was written, so its
  // record keeps the earlier obsidianSentAt / obsidianFile; listed in the toast, whose "Copy notes" offers its block
  function notFoundOne(res, plan, p, reason, file) {
    if (res._done.has(p.id)) return;
    res._done.add(p.id);
    res.notFound.push({ promptId: p.id, error: reason });
    res._lost.push({ block: plainBlock(plan, p), file: file });
  }
  // an edited card no request carried (its earlier copy stays as it is, so nothing is offered to copy)
  function notUpdatedOne(res, p, reason) {
    if (res._done.has(p.id)) return;
    res._done.add(p.id);
    res.notUpdated.push({ promptId: p.id, error: reason });
  }
  function copyAction(list) {
    var blocks = list.map(function (c) { return c.block; }).filter(Boolean);
    var where = list.length ? list[0].file : null;
    return blocks.length ? [{ label: "Copy notes", run: function () { copyNote(blocks.join("\n\n"), where, blocks.length > 1); } }] : [];
  }
  // Toasts (id "obsidian"): "Sent to Obsidian · <file>: A added, U updated, K already there" (the edited cards the server
  // no longer found, or a link or an older server could not update, and the cards a link held back, in its detail;
  // "Copy notes" for those not found); "N sent, F could not be sent — <first reason>" with "Copy notes"; "N sent, U may
  // already be in Obsidian — <reason>" for the cards a request may have written all the same (repair D2: named apart,
  // never copied); with nothing written: the held-back line (heldLine), the not-updated line, or "Everything in
  // “<name>” is already in Obsidian", or (a link, nothing never sent) "Nothing new to send — …". A card sent before and
  // not edited since whose last send did not finish (plan.recheck) is never called edited (repair D5).
  function finishAll(res, vault, plan, outdated) {
    return Promise.all(res._marks).then(function () {
      res.ok = !res.failed.length && !res.error;
      res.file = res.files.length ? primaryIn(res._per) : (plan.mode === "server" ? primaryOf(plan.groups) : plan.linkFile) || plan.linkFile;
      var file = res.file, link = res.mode === "link", name = colName(plan.col);
      var open = res.sent ? [{ label: "Open in Obsidian", run: function () { openNote(vault, file); } }] : [];
      var rechecked = new Set((plan.recheck || []).map(function (p) { return str(p.id); }));
      function split(list) {
        var r = list.filter(function (x) { return rechecked.has(str(x.promptId)); }).length;
        return { edited: list.length - r, rechecked: r };
      }
      function restartWhy(n) { return RESTART + " to update " + (n === 1 ? "it" : "them") + " in place"; }
      var nf = res.notFound.length, nu = res.notUpdated.length, nh = res.held.length, lines = [];
      var gone = split(res.notFound), waiting = split(res.notUpdated);
      if (gone.edited) lines.push(notUpdatedLine(gone.edited, notFoundWhy(gone.edited)));
      if (gone.rechecked) lines.push(notUpdatedLine(gone.rechecked, notFoundWhy(gone.rechecked), true));
      if (nu && link) lines.push(notUpdatedLine(nu, LINK_ADDS));
      if (!link && waiting.edited) lines.push(notUpdatedLine(waiting.edited, restartWhy(waiting.edited)));
      if (!link && waiting.rechecked) lines.push(notUpdatedLine(waiting.rechecked, restartWhy(waiting.rechecked), true));
      var said = lines.map(function (l) { return l + "."; }).join(" "), held = nh ? heldLine(nh, outdated) : "";
      // the failed cards a request may have written all the same (unsureOne) are named apart; no card that holds the
      // marker is offered to copy, whatever its reason this time (repair D2), and neither is one held back because an
      // import was saving (A10.1: its marker from the backup may not be merged yet)
      var unsure = res.failed.filter(function (x) { return res._unsure.has(str(x.promptId)); });
      var sure = res.failed.filter(function (x) { return !res._unsure.has(str(x.promptId)); });
      var waiting = new Set(res.failed.filter(function (x) { return x.error === IMPORTING; }).map(function (x) { return str(x.promptId); }));
      var copyable = res._copy.filter(function (c) { return !markedNow(c.id) && !waiting.has(str(c.id)); }).concat(res._lost);
      if (res.failed.length && waiting.size === res.failed.length && !res.sent) {
        // an import began before anything went (A10.1): nothing written, nothing to copy, send again afterwards
        if (!res.error) res.error = IMPORTING;
        toast({ text: WAIT_IMPORT, detail: [said, held].filter(Boolean).join(" ") || null });
      } else if (res.failed.length) {
        var again = unsure.length ? "Send " + (unsure.length === 1 ? "it" : "them") + " again once Marginalia's server answers: it checks the note and never adds a second copy." : "";
        if (sure.length && unsure.length) again = unsure.length + " may already be in Obsidian (" + unsure[0].error + "). " + again;
        toast({ text: res.sent + " sent, " + (sure.length ? sure.length + " could not be sent — " + sure[0].error : unsure.length + " may already be in Obsidian — " + unsure[0].error),
          detail: [said, again, held, waiting.size ? WAIT_IMPORT : ""].filter(Boolean).join(" ") || null, ttl: 12000, actions: copyAction(copyable).concat(open) });
      } else if (res.sent) {
        var others = res.files.filter(function (f) { return f !== file; });
        var detail = link ? ["Sent through an obsidian:// link.", said, held || linkAdvice(outdated)].filter(Boolean).join(" ")
          : [said, others.length ? "Also in " + others.join(", ") + "." : ""].filter(Boolean).join(" ") || null;
        toast({ text: "Sent to Obsidian · " + file + ": " + res.added + " added, " + res.updated + " updated, " + res.unchanged + " already there",
          detail: detail, ttl: nf || nh ? 12000 : TOAST_TTL, actions: copyAction(res._lost).concat(open) });
      } else if (nh) {
        // nothing went: what a link could send waits for Marginalia's server (A9.1); nothing is offered to copy
        toast({ text: held, detail: said || null, ttl: 12000 });
      } else if (link && nu) {
        toast({ text: "Nothing new to send — every card of “" + name + "” was sent before, and an obsidian:// link can only add",
          detail: plural(nu, "edited card") + " " + (nu === 1 ? "was" : "were") + " not updated. " + linkAdvice(outdated) });
      } else if (lines.length) {
        // nothing written: the edited cards' earlier copies are gone (or only an older server answers), the rest is there
        toast({ text: lines[0], detail: lines.slice(1).map(function (l) { return l + "."; }).join(" ") || null, ttl: 12000, actions: copyAction(res._lost) });
      } else if (plan.list.length) {
        toast({ text: "Everything in “" + name + "” is already in Obsidian", detail: "Every card was sent before and none was edited since." });
      } else {
        toast({ text: "Nothing in “" + name + "” to send to Obsidian" });
      }
      return publicResult(res);
    });
  }

  // ---- server mode
  function postInit(body) {
    return { method: "POST", body: body, cache: "no-store", credentials: "same-origin",
      headers: postHeaders({ "Content-Type": "application/json", "X-Marginalia": "1" }) };
  }
  function readJson(r) {
    var jp;
    try { jp = r.json(); } catch (e) { jp = null; }
    return Promise.resolve(jp).catch(function () { return null; });
  }
  function notesReason(status, j) {
    if (status === 413) return "the notes and their images are larger than 100 MB";
    return appOnly(j) || (j && typeof j.error === "string" && j.error ? j.error : "the server answered " + status);
  }
  // a block ready to go: its Markdown with embeds for the images whose bytes are stored ("[image]" for the rest),
  // those images, what it was built from (builtFrom), its entry in a /notes request ({blockId, markdown}, with
  // "replaceOnly": true for an edited or rechecked card that must only replace its earlier block) and that entry's share of the
  // request body in bytes
  function prepare(col, p, replaceOnly) {
    return collectImages(p.text).then(function (imgs) {
      var names = Object.create(null);
      imgs.forEach(function (im) { names[im.id] = im.name; });
      var built = builtFrom(p), block = blockFor(p, col, { images: function (id) { return names[id] || null; } });
      var entry = { blockId: str(p.id), markdown: block };
      if (replaceOnly) entry.replaceOnly = true;
      return { p: p, block: block, built: built, imgs: imgs, entry: entry, replaceOnly: !!replaceOnly, bytes: utf8Length(JSON.stringify(entry)) + 1 };
    });
  }
  // ctl: {stop: a reason that ends every later request (no answer, an older server, the tab stepped aside),
  // single: true once /notes is missing (one POST /note per block from then on)}
  function sendGroup(plan, g, vault, res, ctl) {
    var list = g.prompts, i = 0, pending = null, title = noteTitle(g.file);
    var envelope = utf8Length(JSON.stringify({ vault: vault, file: g.file, title: title, blocks: [], images: [] }));
    function failRest(reason) {
      if (pending) { failOne(res, plan, pending.p, reason, g.file); pending = null; }
      for (; i < list.length; i++) failOne(res, plan, list[i], reason, g.file);
    }
    function newBytes(chunk, pc) {
      var n = 0;
      pc.imgs.forEach(function (im) { if (!chunk.names.has(im.name)) n += im.name.length + im.data.length + 24; });
      return n;
    }
    function place(chunk, pc) {
      var extra = pc.bytes + newBytes(chunk, pc);
      if (chunk.items.length && (chunk.items.length >= NOTES_MAX_BLOCKS || chunk.bytes + extra > SPLIT_BYTES)) { pending = pc; return Promise.resolve(chunk); }
      if (!chunk.items.length && chunk.bytes + extra > NOTES_MAX_BODY) {
        failOne(res, plan, pc.p, "the note and its images are larger than 100 MB", g.file);
        return fill(chunk);
      }
      chunk.items.push(pc);
      chunk.bytes += extra;
      pc.imgs.forEach(function (im) {
        if (chunk.names.has(im.name)) return;
        chunk.names.add(im.name);
        chunk.images.push({ name: im.name, data: im.data });
      });
      return fill(chunk);
    }
    function fill(chunk) {
      if (pending) { var pc = pending; pending = null; return place(chunk, pc); }
      if (i >= list.length) return Promise.resolve(chunk);
      var p = list[i++];
      if (res._done.has(p.id)) return fill(chunk);    // accounted for already (an edited card held back: allViaServer)
      if (!BLOCK_ID_RE.test(str(p.id))) { failOne(res, plan, p, BAD_ID, g.file); return fill(chunk); }
      return prepare(plan.col, p, plan.replace.has(str(p.id))).then(function (x) { return place(chunk, x); },
        function (e) { failOne(res, plan, p, errorText(e), g.file); return fill(chunk); });
    }
    function errorOf(x) { return x && typeof x.error === "string" && x.error ? x.error : null; }
    function idsOf(items) { return items.map(function (it) { return str(it.p.id); }); }
    // a block the server did not write: an edited card whose earlier block it did not find (notFound) is listed and
    // keeps its record; any other is a failure with the server's reason
    function unwritten(it, x, why) {
      if (x && x.notFound === true) notFoundOne(res, plan, it.p, errorOf(x) || NOT_FOUND, g.file);
      else failOne(res, plan, it.p, errorOf(x) || why, g.file);
    }
    // the markers settled by the answer (settle), saved before the toast
    function settled(fl, how, entries) { res._marks.push(settle(fl, how, entries)); }
    // A request that wrote, per block as its results say: ok: true → written (counted; the records of the whole request
    // in ONE write); ok: false (notFound included) → definitely not written, the marker goes back; missing from the
    // results → no telling, the marker stays (unsureOne: "the server's answer left it out").
    function accept(fl, items, j) {
      var written = typeof j.file === "string" && j.file ? j.file : g.file, byId = new Map(), sent = [], back = [], unsure = [];
      (Array.isArray(j.results) ? j.results : []).forEach(function (x) {
        if (x && typeof x.blockId === "string" && !byId.has(x.blockId)) byId.set(x.blockId, x);
      });
      items.forEach(function (it) {
        var x = byId.get(str(it.p.id));
        if (x && x.ok === true) {
          countSent(res, it.p, written, !!x.replaced);
          sent.push({ id: it.p.id, file: written, built: it.built });
          return;
        }
        if (x && x.ok === false) { back.push(str(it.p.id)); unwritten(it, x, "the server did not write it"); return; }
        unsure.push(str(it.p.id));
        unsureOne(res, plan, it.p, errorOf(x) || LEFT_OUT, g.file);
      });
      settled(fl, "written", sent);
      settled(fl, "not", back);
      settled(fl, "unsure", unsure);
    }
    function postChunk(chunk) {
      // an import began while the blocks were prepared (A10.1): this request and every later one stay home, nothing
      // is marked (checked in the same task as writeAhead, which marks the cached records before it awaits anything)
      if (!ctl.stop && importBusy()) ctl.stop = IMPORTING;
      if (ctl.stop === IMPORTING) {
        chunk.items.forEach(function (it) { failOne(res, plan, it.p, IMPORTING, g.file); });
        return Promise.resolve(null);
      }
      var body = JSON.stringify({ vault: vault, file: g.file, title: title,
        blocks: chunk.items.map(function (it) { return it.entry; }), images: chunk.images });
      // the cards' markers are stored before the request leaves (writeAhead); its answer settles them
      return writeAhead(chunk.items.map(function (it) { return it.p; }), g.file).then(function (fl) {
        if (tabLocked()) {                                // stepped aside meanwhile: nothing goes (its writes are refused)
          ctl.stop = LOCKED;
          settled(fl, "unsure", idsOf(chunk.items));
          chunk.items.forEach(function (it) { failOne(res, plan, it.p, LOCKED, g.file); });
          return null;
        }
        if (fl.unsaved) {                                 // the store refused the markers: nothing goes (repair A9-R3)
          ctl.stop = NOT_SAVED;
          chunk.items.forEach(function (it) { failOne(res, plan, it.p, NOT_SAVED, g.file); });
          return null;
        }
        return doFetch(apiBase + "/notes", postInit(body)).then(function (r) {
          return readJson(r).then(function (j) {
            if (r.ok && j && j.ok) { accept(fl, chunk.items, j); return null; }
            // a 4xx JSON refusal wrote nothing: the markers go back; a 5xx, or a 2xx whose answer never came, may have
            // written the blocks: the markers stay
            var definite = refusedAll(r, j);
            settled(fl, definite ? "not" : "unsure", idsOf(chunk.items));
            if (OLD_SERVER_STATUS[r.status] === true) { ctl.single = true; return postEach(chunk); }   // a serve.py from before /notes
            if (!definite) {                              // no telling: they may be in the note (unsureOne)
              var unread = r.ok && !j ? UNREAD : notesReason(r.status, j);
              chunk.items.forEach(function (it) { unsureOne(res, plan, it.p, unread, g.file); });
              return null;
            }
            // refused, nothing written: each block's own reason when the answer lists one (no valid block; notFound: an
            // edited card's earlier block is gone), else the request's
            var why = notesReason(r.status, j), own = new Map();
            (j && Array.isArray(j.results) ? j.results : []).forEach(function (x) {
              if (x && typeof x.blockId === "string" && x.ok !== true && (errorOf(x) || x.notFound === true) && !own.has(x.blockId)) own.set(x.blockId, x);
            });
            chunk.items.forEach(function (it) { unwritten(it, own.get(str(it.p.id)), why); });
            return null;
          });
        }, function () {
          detected = null;                                // check again next time
          ctl.stop = NO_ANSWER;
          settled(fl, "unsure", idsOf(chunk.items));      // no answer: the blocks may have been written all the same
          chunk.items.forEach(function (it) { unsureOne(res, plan, it.p, NO_ANSWER, g.file); });
        }).then(null, function (e) {
          var open = Array.from(fl.open);
          settled(fl, "unsure", open);                    // whatever broke, the request went: the markers stay
          open.forEach(function (id) { res._unsure.add(id); });
          throw e;
        });
      });
    }
    // an older serve.py: the single send's endpoint, one block at a time, each written ahead and settled like a single
    // send. /note adds a block it does not find, so an edited card (replaceOnly) never goes there: it waits for a
    // restart (listed, its record as it was).
    function postEach(chunk) {
      var k = 0;
      function one() {
        if (k >= chunk.items.length) return Promise.resolve();
        var it = chunk.items[k++], id = str(it.p.id);
        if (!ctl.stop && tabLocked()) ctl.stop = LOCKED;
        if (!ctl.stop && importBusy()) ctl.stop = IMPORTING;     // A10.1; the same task as this block's writeAhead
        if (ctl.stop) { failOne(res, plan, it.p, ctl.stop, g.file); return one(); }
        if (it.replaceOnly) {
          if (!res._done.has(it.p.id)) res.skipped++;
          notUpdatedOne(res, it.p, RESTART + " to update it in place");
          return one();
        }
        var body = JSON.stringify({ vault: vault, file: g.file, title: title, blockId: id, markdown: it.block,
          images: it.imgs.map(function (im) { return { name: im.name, data: im.data }; }) });
        if (utf8Length(body) > MAX_BODY) { failOne(res, plan, it.p, "the note and its images are larger than 25 MB", g.file); return one(); }
        return writeAhead([it.p], g.file).then(function (fl) {
          if (tabLocked()) {
            ctl.stop = LOCKED;
            settled(fl, "unsure", [id]);
            failOne(res, plan, it.p, LOCKED, g.file);
            return null;
          }
          if (fl.unsaved) {                               // the store refused the marker: nothing goes (repair A9-R3)
            ctl.stop = NOT_SAVED;
            failOne(res, plan, it.p, NOT_SAVED, g.file);
            return null;
          }
          return doFetch(apiBase + "/note", postInit(body)).then(function (r) {
            return readJson(r).then(function (j) {
              if (r.ok && j && j.ok) {
                var written = typeof j.file === "string" && j.file ? j.file : g.file;
                countSent(res, it.p, written, !!j.replaced);
                settled(fl, "written", [{ id: id, file: written, built: it.built }]);
                return;
              }
              var why = r.ok && !j ? UNREAD : serverReason(r.status, j), old = OLD_SERVER_STATUS[r.status] === true, definite = refusedAll(r, j);
              if (old) { detected = null; ctl.stop = why; }
              settled(fl, definite ? "not" : "unsure", [id]);    // a 2xx whose answer never came: unsure
              (definite || old ? failOne : unsureOne)(res, plan, it.p, why, g.file);
            });
          }, function () {
            detected = null;
            ctl.stop = NO_ANSWER;
            settled(fl, "unsure", [id]);
            unsureOne(res, plan, it.p, NO_ANSWER, g.file);
          }).then(null, function (e) {
            settled(fl, "unsure", [id]);
            res._unsure.add(id);
            throw e;
          });
        }).then(one);
      }
      return one();
    }
    function post(chunk) {
      return (ctl.single ? postEach(chunk) : postChunk(chunk)).then(null, function (e) {
        var why = errorText(e);                           // whatever broke, every block of the chunk is accounted for
        chunk.items.forEach(function (it) { failOne(res, plan, it.p, why, g.file); });
      });
    }
    function round() {
      if (!pending && i >= list.length) return Promise.resolve();
      if (!ctl.stop && tabLocked()) ctl.stop = LOCKED;
      if (!ctl.stop && importBusy()) ctl.stop = IMPORTING;       // A10.1: the rest waits for the import
      if (ctl.stop) { failRest(ctl.stop); return Promise.resolve(); }
      return fill({ items: [], images: [], names: new Set(), bytes: envelope }).then(function (chunk) {
        return chunk.items.length ? post(chunk) : null;
      }).then(round);
    }
    return round();
  }
  // d: detect()'s answer. A serve.py from before "replaceOnly" (its GET /vaults does not answer "replaceOnly": true; one
  // still running after an update) has /notes but ignores that field, so it would add an edited card whose earlier
  // block is gone, a second copy: there the edited cards (and the rechecked ones, whose blocks also go with
  // replaceOnly) go in no request and wait for a restart (notUpdated; a marker stays), as on a serve.py from before
  // /notes.
  function allViaServer(plan, vault, d) {
    var res = newResult("server", plan), ctl = { stop: null, single: false }, chain = Promise.resolve();
    if (!(d && d.replaceOnly)) {
      plan.send.forEach(function (p) {
        if (!plan.replace.has(str(p.id))) return;
        res.skipped++;
        notUpdatedOne(res, p, RESTART + " to update it in place");
      });
    }
    var going = plan.send.length - res.notUpdated.length;
    if (going) toast({ text: "Sending " + plural(going, "card") + " to Obsidian…", ttl: 0 });
    plan.groups.forEach(function (g) { chain = chain.then(function () { return sendGroup(plan, g, vault, res, ctl); }); });
    return chain.then(function () { return finishAll(res, vault, plan, false); });
  }

  // ---- link mode
  // Only the cards never sent and without the marker: an edited one is skipped (its earlier copy stays as it is) and
  // named in the toast; a marked one (a server send of it did not finish, so its note may hold it) is held back and
  // named (A9.1), in the link and in the copy above URI_LIMIT alike.
  function allViaLink(plan, vault, fromGesture, d) {
    var res = newResult("link", plan), outdated = !!(d && d.outdated), fresh = linkFresh(plan);
    plan.marked.forEach(function (p) { heldOne(res, p); });
    linkChanged(plan).forEach(function (p) { notUpdatedOne(res, p, LINK_ADDS); });
    res.skipped = plan.empty.length + plan.list.length - fresh.length;
    fresh.forEach(function (p) { if (!BLOCK_ID_RE.test(str(p.id))) failOne(res, plan, p, BAD_ID, plan.linkFile); });
    var pay;
    try { pay = linkPayload(plan, vault); }
    catch (e) {
      fresh.forEach(function (p) { failOne(res, plan, p, errorText(e), plan.linkFile); });
      return finishAll(res, vault, plan, outdated);
    }
    if (!pay.items.length) return finishAll(res, vault, plan, outdated);
    // never opened: copied for the user to paste (a copy is not a send: nothing is recorded); the edited cards a link
    // cannot update and the held-back ones are left out of it, and its toast names them as the link's would
    function copyInstead(p2) {
      res.mode = "copy";
      res.error = "too_long";
      var nu = res.notUpdated.length, nh = res.held.length, parts = [];
      if (nu) parts.push(notUpdatedLine(nu, LINK_ADDS) + ".");
      if (nh) parts.push(heldLine(nh, outdated)); else if (nu) parts.push(linkAdvice(outdated));
      return Promise.resolve(copyNote(p2.joined, p2.file, p2.items.length > 1, parts.join(" ") || null)).then(function () { return publicResult(res); });
    }
    if (pay.uri.length > URI_LIMIT) return copyInstead(pay);
    // The click (the confirm's, or the "Ready for Obsidian" toast's "Add to Obsidian" up to 20 s later) looks at the tab
    // and at every planned card again, as the single send's go() does (FEATURES A10.2): a tab that stepped aside opens
    // nothing; while an import is saving nothing opens either (A10.1); a card that has the marker now (a server send of
    // it began meanwhile, or an import brought one) is held back and named by the A9.1 line; one sent meanwhile is
    // already there and one deleted meanwhile is left out (the never-twice rule, A8). The link carries the rest, its
    // title decided again (knownFile).
    function go() {
      if (desktopMode() === "cover") {                // FEATURES E2.2c: the app sends, never this page
        res.error = COVERED;
        toast({ text: COVERED });
        return Promise.resolve(publicResult(res));
      }
      if (tabLocked()) {
        pay.items.forEach(function (p) { failOne(res, plan, p, LOCKED, pay.file); });
        return finishAll(res, vault, plan, outdated);
      }
      if (!enabled()) {                               // D32: the switch went off before the toast's button was clicked
        res.error = OFF;
        toast({ text: OFF });
        return Promise.resolve(publicResult(res));
      }
      if (importBusy()) {
        res.error = IMPORTING;
        toast({ text: WAIT_IMPORT });
        return Promise.resolve(publicResult(res));
      }
      var C = M.cache, now = { file: pay.file, items: [], built: [], blocks: [] }, link = null;
      pay.items.forEach(function (p, k) {
        var cur = C && typeof C.prompt === "function" ? C.prompt(p.id) : p;
        if (cur && pendingFile(cur)) { heldOne(res, p); res.skipped++; return; }
        if (!cur || cur.deletedAt) { res._done.add(p.id); res.skipped++; return; }
        if (cur.obsidianSentAt) { res._done.add(p.id); res.unchanged++; res.skipped++; return; }
        now.items.push(p); now.built.push(pay.built[k]); now.blocks.push(pay.blocks[k]);
      });
      if (!now.items.length) return finishAll(res, vault, plan, outdated);
      try { link = linkUri(now, plan, vault); }
      catch (e) {
        now.items.forEach(function (p) { failOne(res, plan, p, errorText(e), now.file); });
        return finishAll(res, vault, plan, outdated);
      }
      if (link.uri.length > URI_LIMIT) return copyInstead(link);
      if (!openUri(link.uri)) {
        var why = "this browser cannot open obsidian:// links" + (outdated ? " — " + RESTART + " to write silently" : "");
        link.items.forEach(function (p) { failOne(res, plan, p, why, link.file); });
      } else {
        res.uri = link.uri;
        var records = link.items.map(function (p, k) { countSent(res, p, link.file, false); return sentChange(p.id, link.file, link.built[k]); });
        res._marks.push(writeRecords(records));           // every card's record in one write
      }
      return finishAll(res, vault, plan, outdated);
    }
    if (fromGesture) return go();
    // no user gesture to open a link in: the toast's button is one
    toast({ text: "Ready for Obsidian · " + plural(pay.items.length, "card") + " · " + pay.file, ttl: 20000,
      actions: [{ label: "Add to Obsidian", run: function () { res.error = null; go(); } }] });
    res.error = "needs_click";
    res.uri = pay.uri;
    return Promise.resolve(publicResult(res));
  }

  // sendAll(collectionId, {fromGesture}) → Promise<{ok, mode, sent, added, updated, unchanged, skipped, notFound:
  // [{promptId, error}], notUpdated: [{promptId, error}], held: [{promptId, error}], failed: [{promptId, error}], files,
  // file, error?, uri?}> (never rejects; toasts through M.app.toast; held: the marked cards a link held back, A9.1). With
  // no card fresh, changed or marked it only toasts: no check, no request.
  function sendAll(collectionId, opts) {
    // FEATURES E2.2: refused in a browser page the desktop app replaced, and waits for the app check while it runs
    return desktopGate(function () { return sendAllNow(collectionId, opts); }, function () {
      toast({ text: COVERED });
      return publicResult(Object.assign(newResult(null, null), { error: COVERED }));
    });
  }
  function sendAllNow(collectionId, opts) {
    opts = opts || {};
    var g = gateAll(collectionId);
    if (g.error) {
      if (g.importing) toast({ text: WAIT_IMPORT });
      else if (g.off) toast({ text: OFF });
      else toast({ text: g.busy ? "Already sending “" + g.name + "” to Obsidian" : "Could not send to Obsidian — " + g.error, ttl: 8000 });
      return Promise.resolve(publicResult(Object.assign(newResult(null, null), { error: g.error })));
    }
    var fromGesture = !!opts.fromGesture, out;
    allRunning.set(g.key, true);
    try {
      var pre = planFor(g.col);
      if (!pre.send.length) {
        pre.mode = last ? last.mode : null;
        out = finishAll(newResult(pre.mode, pre), null, pre, !!(last && last.outdated));
      } else {
        out = modeFor(true).then(function (d) {
          if (importBusy()) {                             // an import began while the server was asked (A10.1)
            toast({ text: WAIT_IMPORT });
            return publicResult(Object.assign(newResult(d.mode, null), { error: IMPORTING }));
          }
          var plan = planFor(g.col), v = chooseVault(d);
          plan.mode = d.mode;
          if (v.error) {
            var res = newResult(d.mode, plan);
            plan.send.forEach(function (p) { failOne(res, plan, p, v.error, targetFile(p, g.col)); });
            return finishAll(res, v.name, plan, false);
          }
          return d.mode === "server" ? allViaServer(plan, v.name, d) : allViaLink(plan, v.name, fromGesture, d);
        });
      }
    } catch (e) { out = Promise.reject(e); }
    return out.catch(function (e) {
      toast({ text: "Could not send to Obsidian — " + errorText(e), ttl: 12000 });
      return publicResult(Object.assign(newResult(null, null), { error: errorText(e) }));
    }).then(function (res) { allRunning.delete(g.key); return res; });
  }
  function isSendingAll(collectionId) { return allRunning.has(str(collectionId)); }

  // ---------------------------------------------------------------- api
  var api = {
    fileName: fileName,
    notePath: notePath,
    blockFor: blockFor,
    uriFor: uriFor,
    openUriFor: openUriFor,
    detect: detect,
    send: send,
    enabled: enabled,
    // extensions
    sendAll: sendAll,
    planAll: planAll,
    isSendingAll: isSendingAll,
    readingOrder: readingOrder,
    sendState: sendState,
    state: function () { return last; },
    headingFor: headingFor,
    copyNote: copyNote,
    URI_LIMIT: URI_LIMIT,
    SPLIT_BYTES: SPLIT_BYTES,
    NOTES_MAX_BODY: NOTES_MAX_BODY,
    NOTES_MAX_BLOCKS: NOTES_MAX_BLOCKS,
    DEFAULT_FOLDER: DEFAULT_FOLDER,
    METHOD_SERVER: METHOD_SERVER,
    METHOD_LINK: METHOD_LINK,
    METHOD_RESTART: METHOD_RESTART,
    WAIT_IMPORT: WAIT_IMPORT,
    COVERED: COVERED,
    OFF: OFF,
    // test hooks
    _setOpener: function (fn) { opener = typeof fn === "function" ? fn : defaultOpener; },
    _setFetch: function (fn) { fetchFn = typeof fn === "function" ? fn : null; detected = null; last = null; },
    _setApiBase: function (base) { apiBase = typeof base === "string" && base ? base.replace(/\/+$/, "") : API_BASE; detected = null; last = null; },
    // smaller request limits for the send-all splitting tests (no argument: the real ones)
    _setSplit: function (bytes, blocks) {
      SPLIT_BYTES = isNum(bytes) && bytes > 0 ? bytes : 20 * 1024 * 1024;
      NOTES_MAX_BLOCKS = isNum(blocks) && blocks > 0 ? blocks : 2000;
    },
    _reset: function () {
      opener = defaultOpener; fetchFn = null; apiBase = API_BASE; detected = null; last = null; detectedAt = 0;
      SPLIT_BYTES = 20 * 1024 * 1024; NOTES_MAX_BLOCKS = 2000; allRunning.clear(); inflight.clear();
    }
  };
  M.obsidian = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (BUILD-NOTES "Obsidian"; a module beside SPEC §17.2): pure fileName(name) → string; notePath(folder, name)
 * → "<folder>/<name>.md"; blockFor(prompt, collection, {images, now, origin, hostname}) → block Markdown (well-formed,
 * in serve.py's block shape, the quote escaped so it is never Obsidian syntax); uriFor(vault, file, content) →
 * obsidian://new URI; openUriFor(vault, file) → obsidian://open URI (both well-formed before encoding, the vault name
 * as given, spaces kept). detect({force}) → Promise<{mode: "server"|"link", vaults, server, outdated, replaceOnly?}>
 * (cached, forced by Settings and by a send while the cached mode is "link" on a 127.0.0.1 / localhost page; outdated:
 * an older serve.py answered 404, 405 or 501 there; replaceOnly: true, the key only then, when GET /api/obsidian/vaults
 * says its /notes honours "replaceOnly"); send(promptId, {fromGesture}) → Promise<result> (to the note the prompt's
 * last send recorded, else the note its marker names, else <folder>/<nickname>.md; server: POST /api/obsidian/note;
 * link: obsidian://new through the opener, "# <name>" first for a note no sent prompt records, copy above URI_LIMIT,
 * and never for a card with the marker (FEATURES A9.1: no link, no copy, toast "1 card may already be in Obsidian: a
 * send to Marginalia's server did not finish. Start Marginalia with the marginalia command and send again: it checks
 * the note and never adds a second copy.", "Restart Marginalia (marginalia restart in Terminal) and send again: …"
 * after an older serve.py answered; result {ok: false, mode: "link", error: "a send to Marginalia's server did not
 * finish"}); the send record (obsidianSentAt, obsidianFile, obsidianPendingFile) via M.cache.patchPrompts (in place,
 * one store write per request, no prompt:saved, never a content edit; a cache without it: M.cache.savePrompt(copy,
 * {content: false}) per record), the send dated just before an edit made while its block was on its way; write-ahead
 * (A9.2) before every POST /api/obsidian/note or /notes: obsidianPendingFile = the request's note for every card in
 * it, stored before the request leaves, then a written block → obsidianSentAt / obsidianFile, marker removed; a 4xx
 * JSON refusal or a per-block ok: false (notFound included) → the marker as it was before the request; a 5xx, no
 * answer, a cut or unparseable body → the marker stays; a write-ahead the store refuses → nothing sent ("Marginalia
 * could not save, so nothing was sent", repair A9-R3); toasts through M.app.toast, "Copy note" with the "[image]"
 * block on every server failure once the block exists, and again when the clipboard refuses a copy, except for a card
 * that may be in its note already: "May already be in Obsidian — <reason>" after a send that left no telling, and no
 * "Copy note" for any card that holds the marker (repair D2); nothing at all while M.store.locked(): "Marginalia is
 * open in another tab", no link either when the tab steps aside during the send (repair D6), its markers left for the
 * active tab, A9.4).
 * Extensions: sendAll(collectionId, {fromGesture}) → Promise<{ok, mode, sent, added, updated, unchanged, skipped,
 * notFound: [{promptId, error}], notUpdated: [{promptId, error}], held: [{promptId, error}], failed: [{promptId,
 * error}], files, file, error?, uri?}> (the live prompts in reading order, never a card twice: by sendState, a fresh
 * card is added, a changed one replaces its own block, an unchanged one goes in no request unless it has the marker
 * (A9.3: then it goes with replaceOnly too); nothing fresh, changed or marked: no check, no request, only a toast;
 * server: POST /api/obsidian/notes {vault, file, title, blocks: [{blockId, markdown, replaceOnly?}], images} per target
 * note, written ahead and settled per block, a changed or rechecked card's block with "replaceOnly": true, ≤
 * SPLIT_BYTES and ≤ NOTES_MAX_BLOCKS per request, per-block POST /api/obsidian/note for the fresh cards when /notes
 * answers 404/405/501 (the replaceOnly ones go to notUpdated there; so do they, in no request, when detect() has no
 * replaceOnly, a serve.py from before it, which a send-all checks again), obsidianSentAt / obsidianFile for every block
 * the server wrote, nothing recorded for a notFound result; link: the never-sent prompts without the marker in one
 * obsidian://new link, copied above URI_LIMIT (that toast's detail names the changed and the held-back ones too), the
 * changed ones in notUpdated, the marked ones in held; toasts "Sent to Obsidian · <file>: A added, U updated, K already
 * there" (with not-found ones "M edited cards were not updated: their earlier copy is no longer in the note" — "M
 * cards whose last send did not finish were not updated: …" for the rechecked ones, repair D5 — and "Copy notes";
 * held-back ones named by the A9.1 line) / "N sent, F could not be sent — <reason>" with "Copy notes" (never a card
 * that holds the marker) / "N sent, U may already be in Obsidian — <reason>" for the cards a request left no telling
 * for (repair D2) / the A9.1 line when a link held back every card it could send / "Everything in “<name>” is already
 * in Obsidian"; refused
 * while M.store.locked() or while that collection's send-all runs); planAll(collectionId) → Promise<{ok, mode, count,
 * fresh, changed, unchanged, rechecked, held, sentBefore, total, skipped, file, files, tooLong, outdated, error?,
 * busy?}> (for the confirm; count 0 without a check when nothing is fresh, changed or marked; rechecked: server, the
 * marked cards sent before and not edited since; held: link, the marked cards it holds back); sendState(prompt) →
 * "fresh" | "changed" | "unchanged" (pure: obsidianSentAt against the content stamp contentUpdatedAt);
 * isSendingAll(collectionId) → boolean; readingOrder(prompts, collection) (pure); SPLIT_BYTES, NOTES_MAX_BODY,
 * NOTES_MAX_BLOCKS; state(), headingFor(), copyNote(block, file, many, detail?), URI_LIMIT, DEFAULT_FOLDER,
 * METHOD_SERVER, METHOD_LINK, METHOD_RESTART, WAIT_IMPORT; test hooks _setOpener(fn), _setFetch(fn), _setApiBase(base),
 * _setSplit(bytes, blocks), _reset() (also forgets the requests on their way).
 * FEATURES A10: while M.exporter.isImporting() no send leaves (send, sendAll, both modes; checked at the start, after
 * detect(), right before each write-ahead and right before a link opens): toast WAIT_IMPORT "Wait until the import
 * finishes, then send again." (no actions), result error "an import is still saving", the card unchanged, nothing
 * copied; planAll → {ok: false, error, importing: true}. A send-all link opened from its toast re-checks at the click
 * the lock, the import and every planned card: marked meanwhile → held (A9.1 line), sent meanwhile → already there,
 * deleted meanwhile → left out.
 * FEATURES E2.2 (the desktop app, js/desktop.js): POST /note and /notes headers through M.desktop.headers(base)
 * ("X-Marginalia-Client: app" in the app, unchanged elsewhere); a 409 "app_only" shows the server's "message"; in cover
 * mode (M.desktop.mode() "cover") send / sendAll / a waiting link's click refuse with the toast COVERED "Marginalia is now
 * an app — open it to send to Obsidian." (error COVERED, no request, no link) and planAll answers {ok: false, error:
 * COVERED, covered: true}; while the mode is "checking" they wait for M.desktop.ready().
 * DECISIONS D32 (the switch): enabled() → boolean (settings.obsidian true | false; null, never chosen: true only while
 * a record of the library holds obsidianSentAt or obsidianPendingFile); OFF "The Obsidian connection is off — turn it
 * on in Settings › Obsidian."; while not enabled() send and sendAll toast OFF and answer {ok: false, error: OFF} (no
 * request, no link, no marker; checked after the tab lock and the cover, before the import check) and planAll answers
 * {ok: false, error: OFF, off: true}. detect() is not gated. A send under way finishes. The toast buttons "Open in
 * Obsidian" and "Add to Obsidian" (a send without a gesture, single or send-all), clicked while not enabled(), open no
 * link, record nothing and toast OFF. */
