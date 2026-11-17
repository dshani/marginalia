/* Marginalia — js/editor.js
 * M.editor (SPEC §3 "Editor", §4, §15 Cmd+V, §17.2; BUILD-NOTES "Key routing"): the one prompt
 * editor component, reused by the margin card, the rail popover, the bottom sheet and the deck
 * "Add prompts" box (batch mode).
 *
 * create({host, prompt|null, initialText, anchor, batch, onSave(text, {another}), onCancel}) → Editor
 * Editor: el, textarea, insertAtCaret(text), insertAttachment(blob) → Promise, getText(), setText(t),
 *         focus(), destroy(), run(id) → boolean   (ids: save, saveAnother, cancel, wrapCloze)
 *
 * - Raw textarea that auto-grows (height = scrollHeight); live preview below through
 *   M.markup.render(text, {mode: "preview", imageUrl: M.attachments.url}) debounced 120 ms; one quiet
 *   lint line ("Cloze · 3 cards · Makes 3 cards"); buttons [{}] [Save ⌘↩] [Cancel esc] with
 *   M.keys.label caps. Batch mode lists the blocks of M.prompts.parseBatch with per-block lints and
 *   the Save button reads "Add N prompts".
 * - Tab / Shift+Tab are handled here (not through the key map) and only captured while the text is
 *   empty, parses as qa, or holds a Q. line (so Tab in a Q.-only editor inserts "A. ").
 * - Save / saveAnother / cancel / wrapCloze arrive through Editor.run(id) from M.app's document
 *   keydown listener (EDITOR_MAP). The textarea also dispatches EDITOR_MAP itself as a fallback and
 *   stops propagation for a matched action, so an action never runs twice.
 * - Auto-repeat (SPEC §3: ev.repeat is ignored): the repeat of a matched action or of a captured Tab is
 *   consumed and never runs it again (a held Alt+Shift+C wraps once, a held Cmd+Shift+Enter saves once).
 *   A key already held when the textarea took the focus (the N / E / C that opened the editor) does not
 *   repeat into it either: those repeats are swallowed until the first fresh keydown in the textarea
 *   (real typing always starts with one).
 * - paste → M.attachments.handlePaste(ev, editor) (false → native text paste); drop → handleDrop. Both,
 *   like insertAttachment(blob), go through M.attachments.attach: placePending(pid) puts a
 *   ![snip](att:pending-…) token at the caret at once (an "Adding image…" chip in the preview, the Save
 *   button disabled with that label) and resolvePending(pid, id|null) swaps the stored id in place or drops
 *   the token. Save waits: Cmd+Enter while an image is pending queues the save until every pending settles.
 * - Drafts: localStorage["marginalia.draft.<promptId|new:<anchorHash>>"] at most every 300 ms while
 *   typing, restored on create, cleared on save / cancel. Blur never saves. opts.keepDraft (FIXES-1 FIX-1, a split's
 *   second half under draftKey "split:<id>"): the text is the draft from the moment the editor opens until its Save or
 *   Cancel, also when it equals initialText; destroy() keeps it. M.bus prompt:deleted drops "split:<id>".
 * - onSave may return a promise: further saves wait until it settles. A host that returns nothing (the deck
 *   box) resets the editor with setText() once its writes land, or never (nothing to add, a failed write):
 *   only a re-save of the same, unedited text is held back, while the host may still be writing it (1.5 s
 *   plus 50 ms per further prompt of a batch), so a double press stores it once. An edit, setText() or the
 *   end of that window releases it: the editor is never left locked, and a retry reaches the host again.
 * - Before saving an existing prompt whose edit drops a card with review history, M.app.confirm asks
 *   "This edit removes a card with N reviews. Save anyway?" (M.prompts.reconcileCards).
 * - FEATURES P2.3 "Another angle": a quiet "Angles" button (.editor__angles, in the bar after {}) shows only for a new
 *   prompt (not a batch box) whose text is empty or just "Q." (anglesShown); it opens a picker (.editor__angles-pop,
 *   role menu, one .editor__angle button per ANGLES entry, under one heading per ANGLE_GROUPS entry) below the editor,
 *   or above it when there is more room (anglesPlace); in a box too low for it (a card popover, the sheet) it is
 *   position: fixed over the page (anglesArea). Its keys are local and never reach
 *   M.app: ↑↓ Home End move, Tab / Shift+Tab cycle inside, Enter (or Space, or a click) picks, Esc closes and gives the
 *   focus back to the textarea. A pick replaces the text with the starter + "\nA. " and selects its first "…".
 *   Editor.openAngles() opens it from the host (the margin's "Another angle…").
 * - FEATURES P2.2: opts.note puts a quiet .editor__note line at the top of the editor (a split's second half).
 * - FEATURES P2.4 "Look-alikes": in single mode, while the text is a Q./A. or cloze prompt of a book or deck
 *   (opts.collectionId, else the edited prompt's collectionId), a quiet .editor__similar line under the lint line reads
 *   "Similar prompt: “<question, one line>” (p. N)" for M.similar.nearest over that collection's prompts (never the
 *   prompt being edited, never a pair in settings.notAlike; the page only for a book prompt that has one). It is
 *   computed with the preview and the lints (their debounce), inside a try: it never blocks a save.
 *
 * Loads in node with no DOM: create() throws {code: "no_dom"} there; the pure helpers work anywhere.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }

  var DRAFT_PREFIX = "marginalia.draft.";
  var SPLIT_DRAFT_PREFIX = "split:";      // a split's second half keeps its text under draftKey "split:<first prompt's id>"
  var DRAFT_EVERY_MS = 300;
  var PREVIEW_DEBOUNCE_MS = 120;
  var GLYPHS = { qa: "✦", cloze: "{}", note: "▭", highlight: "·" };
  var KIND_LABELS = { qa: "Q/A", cloze: "Cloze", note: "Note · not reviewed", highlight: "Highlight" };
  var PENDING_LABEL = "Adding image…";
  var QUEUED_NOTE = "Saves when the image is added";
  var HOLD_MS = 1500;                    // after a hand-off to a host that returned no promise, an unedited re-save
  var HOLD_PER_PROMPT_MS = 50;           // waits this long, plus this per further prompt the host writes one by one

  // "Another angle" starters (FEATURES P2.3; the list of 2026-11-11, D26): one place, easy to change. 28 starters in 10
  // groups, one for every angle of the sources: Matuschak's five lenses for a concept (attributes and tendencies,
  // similarities and differences, parts and wholes, causes and effects, significance and implications), his other
  // prompt kinds (explanation, procedure, and "use": open lists, creative and behaviour prompts), Nielsen's depth
  // questions, and Wozniak's two directions and mnemonics ("… is an example of what?" is Bjornstad's direction). The
  // picker shows ANGLE_GROUPS as headings. label = the question as the picker shows it; text = the Q. line. Each text
  // gets ANGLE_ANSWER appended when it is used; a pick replaces the editor's text and selects the first ANGLE_GAP so
  // that typing replaces it.
  var ANGLE_GROUPS = [
    { id: "attributes", label: "Attributes and tendencies" },
    { id: "compare", label: "Similarities and differences" },
    { id: "parts", label: "Parts and wholes" },
    { id: "causes", label: "Causes and effects" },
    { id: "meaning", label: "Significance and implications" },
    { id: "explain", label: "Explanation" },
    { id: "procedure", label: "Procedure" },
    { id: "use", label: "Use" },
    { id: "depth", label: "Depth" },
    { id: "memory", label: "Memory" }
  ];
  var ANGLES = [
    { id: "attributes", group: "attributes", label: "What is always true of …?", text: "Q. What is always true of …?" },
    { id: "never", group: "attributes", label: "What is never true of …?", text: "Q. What is never true of …?" },
    { id: "usually", group: "attributes", label: "How is … usually …?", text: "Q. How is … usually …?" },
    { id: "similar", group: "compare", label: "How is … similar to …?", text: "Q. How is … similar to …?" },
    { id: "difference", group: "compare", label: "How is … different from …?", text: "Q. How is … different from …?" },
    { id: "parts", group: "parts", label: "What are the parts of …?", text: "Q. What are the parts of …?" },
    { id: "kind", group: "parts", label: "… is a kind of what?", text: "Q. … is a kind of what?" },
    { id: "examples", group: "parts", label: "Name three examples of …", text: "Q. Name three examples of …" },
    { id: "instance", group: "parts", label: "… is an example of what?", text: "Q. … is an example of what?" },
    { id: "cause", group: "causes", label: "What causes …?", text: "Q. What causes …?" },
    { id: "effect", group: "causes", label: "What does … do?", text: "Q. What does … do?" },
    { id: "used", group: "causes", label: "When is … used?", text: "Q. When is … used?" },
    { id: "matters", group: "meaning", label: "Why does … matter?", text: "Q. Why does … matter?" },
    { id: "implies", group: "meaning", label: "What does … imply?", text: "Q. What does … imply?" },
    { id: "askmyself", group: "meaning", label: "What should I ask myself when …?", text: "Q. What should I ask myself when …?" },
    { id: "why", group: "explain", label: "Why …?", text: "Q. Why …?" },
    { id: "produce", group: "explain", label: "How does … produce …?", text: "Q. How does … produce …?" },
    { id: "when", group: "procedure", label: "When should you …?", text: "Q. When should you …?" },
    { id: "after", group: "procedure", label: "What comes after …?", text: "Q. What comes after …?" },
    { id: "howlong", group: "procedure", label: "How long does … take?", text: "Q. How long does … take?" },
    { id: "ways", group: "use", label: "Name two ways to …", text: "Q. Name two ways to …" },
    { id: "novel", group: "use", label: "Name a … you have not named before", text: "Q. Name a … you have not named before" },
    { id: "do", group: "use", label: "What should I do when …?", text: "Q. What should I do when …?" },
    { id: "whatif", group: "depth", label: "What changes if …?", text: "Q. What changes if …?" },
    { id: "true", group: "depth", label: "Why is … true?", text: "Q. Why is … true?" },
    { id: "connect", group: "depth", label: "How does … connect to …?", text: "Q. How does … connect to …?" },
    { id: "term", group: "memory", label: "What is the term for …?", text: "Q. What is the term for …?" },
    { id: "mnemonic", group: "memory", label: "Mnemonic for …?", text: "Q. Mnemonic for …?" }
  ];
  var ANGLE_ANSWER = "\nA. ";
  var ANGLE_GAP = "…";
  var ANGLES_LABEL = "Angles";
  var ANGLES_OPEN_RE = /^(?:Q\.)?\s*$/;   // the button shows while a new prompt's text is empty or just "Q. "
  var SIMILAR_LABEL = "Similar prompt: ";   // FEATURES P2.4: the editor's look-alike line

  // ---------------------------------------------------------------- small helpers
  function str(v) { return v == null ? "" : String(v); }
  function error(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function hasDom() { return typeof document !== "undefined" && document && typeof document.createElement === "function"; }
  function escapeHtml(s) {
    var util = M.util || dep("util");
    if (util && typeof util.escapeHtml === "function") return util.escapeHtml(s);
    return str(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
    });
  }
  function prompts() { return M.prompts || dep("prompts"); }
  function parseText(text) {
    var P = prompts();
    if (P && typeof P.parse === "function") return P.parse(text);
    return { kind: str(text).trim() ? "note" : "highlight", question: str(text), answer: "", body: str(text), deletions: [], tags: [], display: str(text), lints: [] };
  }
  function storage() {
    try { var s = root.localStorage; return s && typeof s.getItem === "function" ? s : null; } catch (e) { return null; }
  }
  function readDraft(key) { var s = storage(); if (!s) return null; try { return s.getItem(key); } catch (e) { return null; } }
  function writeDraft(key, text) { var s = storage(); if (!s) return false; try { s.setItem(key, text); return true; } catch (e) { return false; } }
  function removeDraft(key) { var s = storage(); if (!s) return false; try { s.removeItem(key); return true; } catch (e) { return false; } }
  function keyLabel(binding, fallback) {
    var K = M.keys || dep("keys");
    try { if (K && typeof K.label === "function") { var l = K.label(binding); if (l) return l; } } catch (e) { /* fall through */ }
    return fallback;
  }
  function imageUrlFn() {
    return function (id) {
      var A = M.attachments;
      if (A && typeof A.url === "function") { try { return A.url(id); } catch (e) { return null; } }
      return null;
    };
  }
  function renderHtml(text, opts) {
    var mk = M.markup || dep("markup");
    if (mk && typeof mk.render === "function") {
      try { return str(mk.render(text, opts || { mode: "preview" })); } catch (e) { /* fall back to plain */ }
    }
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  // ---------------------------------------------------------------- pure helpers (exported, tested)
  // The number of review cards a parsed prompt makes.
  function cardCount(parsed) {
    if (!parsed) return 0;
    if (parsed.kind === "qa") return 1;
    if (parsed.kind === "cloze") return Array.isArray(parsed.deletions) ? parsed.deletions.length : 0;
    return 0;
  }

  // A stable hash of the anchor for the draft key of a new prompt ("new:<anchorHash>").
  function anchorHash(anchor) {
    if (!anchor || typeof anchor !== "object") return "0";
    var essentials = { pageIndex: anchor.pageIndex, y: anchor.y, quote: anchor.quote, pages: anchor.pages };
    var s;
    try { s = JSON.stringify(essentials); } catch (e) { s = String(anchor.pageIndex) + ":" + String(anchor.y); }
    var util = M.util || dep("util");
    if (util && typeof util.hash32 === "function") return util.hash32(s).toString(16);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  }

  function draftKey(prompt, anchor, override) {
    if (typeof override === "string" && override) return DRAFT_PREFIX + override;
    if (prompt && prompt.id) return DRAFT_PREFIX + prompt.id;
    return DRAFT_PREFIX + "new:" + anchorHash(anchor);
  }

  var Q_MARK_RE = /^[ \t]*Q\.[ \t]*/m;
  var A_MARK_RE = /^[ \t]*A\.[ \t]*/m;

  // Tab is captured while the text is empty, parses as qa, or holds a Q. line (Q.-only notes).
  function tabCapturable(text) {
    text = str(text);
    if (!text.trim()) return true;
    if (Q_MARK_RE.test(text)) return true;
    return parseText(text).kind === "qa";
  }

  // What Tab does: {action: "insert"|"append"|"caret", text?, caret} or null when not captured.
  function tabTarget(text) {
    text = str(text);
    if (!text.trim()) return { action: "insert", text: "Q. ", caret: 3 };
    var qm = Q_MARK_RE.exec(text);
    if (!qm) return null;
    var afterQ = qm.index + qm[0].length;
    A_MARK_RE.lastIndex = 0;
    var rest = text.slice(afterQ), am = A_MARK_RE.exec(rest);
    if (am && (am.index === 0 || rest.charAt(am.index - 1) === "\n" || rest.charAt(am.index - 1) === "\r")) {
      return { action: "caret", caret: afterQ + am.index + am[0].length };
    }
    var trimmed = text.replace(/\s+$/, "");
    var insert = "\nA. ";
    return { action: "append", text: insert, base: trimmed, caret: trimmed.length + insert.length };
  }

  // What Shift+Tab does: the caret after "Q. ", or null.
  function shiftTabTarget(text) {
    text = str(text);
    var qm = Q_MARK_RE.exec(text);
    if (!qm) return null;
    return { action: "caret", caret: qm.index + qm[0].length };
  }

  // Wrap [start, end) in braces; the result selects the wrapped text (or sits between "{}"). Every "::" of the
  // wrapped text is written `\::` (M.prompts.escapeCues: text runs only, an escaped one stays as it is), so a
  // selection never makes an accidental cue (FEATURES P1.1 e); the selection grows by the backslashes added.
  function wrapBraces(text, start, end) {
    text = str(text);
    var n = text.length;
    start = Math.max(0, Math.min(n, start | 0));
    end = Math.max(start, Math.min(n, end | 0));
    var sel = text.slice(start, end);
    var wrapped = text.slice(0, start) + "{" + sel + "}" + text.slice(end), out = wrapped, P = prompts();
    if (P && typeof P.escapeCues === "function") {
      try { var esc = P.escapeCues(wrapped, start + 1, end + 1); if (typeof esc === "string") out = esc; } catch (e) { out = wrapped; }
    }
    return { text: out, start: start + 1, end: end + 1 + (out.length - wrapped.length) };
  }

  // FEATURES P2.3: whether the Angles button shows: a new prompt (not a batch box) whose text is empty or just "Q."
  // with or without trailing blanks.
  function anglesShown(text, isNew, batch) {
    return !!isNew && !batch && ANGLES_OPEN_RE.test(str(text));
  }
  // Where the picker goes (found in a real browser on 2026-11-11: an editor low on the page cut the last starters off,
  // and the long list needs it more): below the editor when it fits there, else above when it fits there, else on the
  // side with more room, its height capped to that room (it scrolls inside; never under ANGLES_MIN_HEIGHT). It is
  // right-aligned to the editor when it would pass the area's right edge and fits that way. All in viewport px:
  // editorRect {top, bottom, left, right}; popSize {width, height} = the picker's natural size (all its rows, no height
  // cap); bounds {top, bottom, left, right} = the area the picker may use (anglesArea).
  // → {up, right, maxHeight (null: no cap)}.
  var ANGLES_EDGE = 8;                 // px kept free between the picker and the area's edge (its 4 px gap included)
  var ANGLES_MIN_HEIGHT = 120;         // px: the picker is never capped lower than this
  function anglesPlace(editorRect, popSize, bounds) {
    var out = { up: false, right: false, maxHeight: null };
    if (!editorRect || !popSize || !bounds || !(bounds.bottom > bounds.top)) return out;
    var below = bounds.bottom - editorRect.bottom - ANGLES_EDGE, above = editorRect.top - bounds.top - ANGLES_EDGE;
    if (popSize.height <= below) out.up = false;
    else if (popSize.height <= above) out.up = true;
    else out.up = above > below;
    var room = out.up ? above : below;
    if (popSize.height > room) out.maxHeight = Math.max(ANGLES_MIN_HEIGHT, Math.floor(room));
    if (bounds.right > bounds.left && editorRect.left + popSize.width > bounds.right - ANGLES_EDGE &&
        editorRect.right - popSize.width >= bounds.left + ANGLES_EDGE) out.right = true;
    return out;
  }
  // The area the picker may use (viewport px). clips: the boxes of the editor's ancestors that clip their content,
  // nearest first, each {top, bottom, left, right, x, y} (x / y: it clips on that axis); win: the window's box. The
  // picker stays inside all of them when that leaves it ANGLES_MIN_HEIGHT above or below the editor. Else it leaves
  // the nearest boxes, as few as possible (a card popover and the sheet are no higher than their editor), and is
  // then placed with position: fixed. stay: it cannot leave them. → {bounds, escape (how many boxes it leaves)}.
  function anglesArea(editorRect, clips, win, stay) {
    var list = Array.isArray(clips) ? clips : [];
    function cut(from) {
      var b = { top: win.top, bottom: win.bottom, left: win.left, right: win.right };
      for (var i = from; i < list.length; i++) {
        var c = list[i];
        if (!c) continue;
        if (c.y) { b.top = Math.max(b.top, c.top); b.bottom = Math.min(b.bottom, c.bottom); }
        if (c.x) { b.left = Math.max(b.left, c.left); b.right = Math.min(b.right, c.right); }
      }
      return b;
    }
    if (!win) return { bounds: null, escape: 0 };
    if (!editorRect || stay) return { bounds: cut(0), escape: 0 };
    for (var k = 0; k < list.length; k++) {
      var b = cut(k);
      if (Math.max(b.bottom - editorRect.bottom, editorRect.top - b.top) - ANGLES_EDGE >= ANGLES_MIN_HEIGHT) return { bounds: b, escape: k };
    }
    return { bounds: cut(list.length), escape: list.length };
  }
  // The editor is out of the area (scrolled out of sight): a fixed picker has no place then and closes. (An absolute
  // one moves out with its editor and is clipped with it.)
  function anglesOut(editorRect, bounds) {
    if (!editorRect || !bounds) return false;
    return editorRect.bottom <= bounds.top || editorRect.top >= bounds.bottom || editorRect.right <= bounds.left || editorRect.left >= bounds.right;
  }
  // The starter of an angle: {text, start, end} with [start, end) the first "…" (null for an unknown id).
  function angleStarter(id) {
    for (var i = 0; i < ANGLES.length; i++) {
      if (ANGLES[i].id !== id) continue;
      var text = ANGLES[i].text + ANGLE_ANSWER, at = text.indexOf(ANGLE_GAP);
      return { text: text, start: at < 0 ? text.length : at, end: at < 0 ? text.length : at + ANGLE_GAP.length };
    }
    return null;
  }

  // The worst lint of a parsed prompt (M.prompts.lint sorts worst first), or null.
  function worstLint(parsed) {
    var P = prompts(), lints = null;
    if (P && typeof P.lint === "function") { try { lints = P.lint(parsed); } catch (e) { lints = null; } }
    if (!lints && parsed && Array.isArray(parsed.lints)) lints = parsed.lints;
    return lints && lints.length ? lints[0] : null;
  }

  // The quiet status line under the preview.
  function statusLine(parsed, hasAnchorRects) {
    if (!parsed) return "";
    var parts = [], n = cardCount(parsed);
    if (parsed.kind === "highlight") parts.push(hasAnchorRects ? "Empty · saves as a highlight" : "Empty");
    else parts.push(KIND_LABELS[parsed.kind] || parsed.kind);
    if (parsed.kind === "qa" || parsed.kind === "cloze") parts.push(n + (n === 1 ? " card" : " cards"));
    var lint = worstLint(parsed);
    if (lint && lint.msg) parts.push(lint.msg);
    return parts.join(" · ");
  }

  function tokenOf(id) { return "![snip](att:" + id + ")"; }

  // The preview renders a pending placeholder (no URL yet) as an "Adding image…" chip instead of
  // M.markup's "Image missing" chip; ids holds the placeholders this editor is still waiting for.
  var MISSING_CHIP_RE = /<span class="att att--missing" data-id="([^"]*)">[^<]*<\/span>/g;
  function pendingChips(html, ids) {
    html = str(html);
    if (!ids || !ids.length || html.indexOf("att--missing") < 0) return html;
    return html.replace(MISSING_CHIP_RE, function (m, id) {
      return ids.indexOf(id) >= 0 ? '<span class="chip att--pending" data-id="' + escapeHtml(id) + '">' + PENDING_LABEL + "</span>" : m;
    });
  }

  function saveLabel(batch, blockCount) {
    if (!batch) return "Save";
    if (!blockCount) return "Add prompts";
    return "Add " + blockCount + (blockCount === 1 ? " prompt" : " prompts");
  }

  // Review history among dropped cards → the confirm body, or null when nothing has history.
  function droppedMessage(dropped) {
    var withHistory = (dropped || []).filter(function (c) { return c && Array.isArray(c.log) && c.log.length > 0; });
    if (!withHistory.length) return null;
    var reviews = 0;
    for (var i = 0; i < withHistory.length; i++) reviews += withHistory[i].log.length;
    var cards = withHistory.length === 1 ? "a card" : withHistory.length + " cards";
    return "This edit removes " + cards + " with " + reviews + (reviews === 1 ? " review" : " reviews") + ". Save anyway?";
  }

  // The page of a book prompt for the look-alike line: its page label, else its anchor's or context's page index + 1;
  // null for a deck prompt or a prompt without a page.
  function promptPage(q) {
    if (!q || typeof q !== "object") return null;
    var C = M.cache, col = null;
    if (C && typeof C.collection === "function") { try { col = C.collection(q.collectionId); } catch (e) { col = null; } }
    if (col && col.kind !== "book") return null;
    var ctx = q.context && typeof q.context === "object" ? q.context : {};
    if (ctx.pageLabel !== null && ctx.pageLabel !== undefined && str(ctx.pageLabel).trim()) return str(ctx.pageLabel).trim();
    var a = q.anchor && typeof q.anchor === "object" ? q.anchor : null;
    if (a && typeof a.pageIndex === "number" && isFinite(a.pageIndex)) return String(a.pageIndex + 1);
    if (typeof ctx.pageIndex === "number" && isFinite(ctx.pageIndex)) return String(ctx.pageIndex + 1);
    return null;
  }

  // FEATURES P2.4: the editor's look-alike line for `text` among `candidates` (a collection's prompts), or "" when no
  // prompt looks alike. exceptId: the prompt being edited (null for a new one); ignored: settings.notAlike.
  function similarLine(text, candidates, exceptId, ignored) {
    var S = M.similar || dep("similar");
    if (!S || typeof S.nearest !== "function") return "";
    var q = S.nearest(text, candidates, exceptId, ignored);
    if (!q) return "";
    var page = promptPage(q);
    return SIMILAR_LABEL + "“" + S.oneLine(str(q.text)) + "”" + (page ? " (p. " + page + ")" : "");
  }

  // ---------------------------------------------------------------- the component
  function create(opts) {
    if (!hasDom()) throw error("no_dom", "M.editor.create needs a document");
    opts = opts && typeof opts === "object" ? opts : {};
    var prompt = opts.prompt && typeof opts.prompt === "object" ? opts.prompt : null;
    var anchor = opts.anchor && typeof opts.anchor === "object" ? opts.anchor : (prompt ? prompt.anchor : null);
    var batch = !!opts.batch;
    var onSave = typeof opts.onSave === "function" ? opts.onSave : function () {};
    var onCancel = typeof opts.onCancel === "function" ? opts.onCancel : function () {};
    var key = draftKey(prompt, anchor, opts.draftKey);
    // opts.keepDraft (single mode; FIXES-1 FIX-1, a split's second half): the editor is dirty from the start. Its text is
    // the draft from the moment it opens until its Save or Cancel, whatever else closes it (destroy keeps it).
    var keepDraft = !batch && opts.keepDraft === true, persist = keepDraft;
    var initialText = opts.initialText != null ? str(opts.initialText) : (prompt ? str(prompt.text) : "");
    var hasRects = !!(anchor && Array.isArray(anchor.pages) && anchor.pages.length);
    var destroyed = false, saving = false, draftTimer = null, draftDirty = false;
    var lastParsed = null, lastBlocks = null;
    var pendingIds = [];                                   // placeholder ids still being decoded
    var queuedSave = null;                                 // {another, confirmed} while a save waits for them
    var held = null;                                       // {text, until}: a hand-off to a host that returned no promise
    var keyFresh = false;                                  // a keydown began here since the textarea last took the focus
    // opts.saveLabel (single mode): the Save button's text, "Save + Obsidian" for the O editor (BUILD-NOTES "Obsidian")
    var customLabel = !batch && typeof opts.saveLabel === "string" && opts.saveLabel.trim() ? opts.saveLabel.trim() : null;
    var saveBase = { label: customLabel || saveLabel(batch, 0), disabled: false };
    // opts.note (single mode): a quiet line at the top of the editor that goes with it (FEATURES P2.2: the second half
    // of a split). opts.angles: the "Angles" picker opens once the editor is mounted, when the button may show (P2.3).
    var note = !batch && typeof opts.note === "string" && opts.note.trim() ? opts.note.trim() : null;
    var picker = null;                                     // {el, onDown, onMove, size, fixed, trapped, raf} while the angle picker is open
    // opts.collectionId (FEATURES P2.4): the book or deck whose prompts the look-alike line looks among
    var collectionId = typeof opts.collectionId === "string" && opts.collectionId ? opts.collectionId
      : (prompt && typeof prompt.collectionId === "string" ? prompt.collectionId : null);

    // ---- DOM
    var el = document.createElement("div");
    el.className = "editor" + (batch ? " editor--batch" : "");
    el.innerHTML =
      (note ? '<div class="editor__note">' + escapeHtml(note) + "</div>" : "") +
      '<textarea class="editor__textarea" rows="2" spellcheck="true" aria-label="' + (batch ? "Prompts" : "Prompt text") + '"></textarea>' +
      '<div class="editor__preview"></div>' +
      '<div class="editor__lint" aria-live="polite"></div>' +
      (batch ? "" : '<div class="editor__similar is-hidden"></div>') +
      '<div class="editor__bar">' +
        '<button type="button" class="btn btn--ghost editor__wrap" title="Wrap the selection in {braces} (' + escapeHtml(keyLabel("Alt+Shift+c", "Alt+Shift+C")) + ')" aria-label="Wrap selection in cloze braces">{}</button>' +
        '<button type="button" class="btn btn--ghost editor__angles is-hidden" aria-haspopup="menu" aria-expanded="false" title="Start from another angle">' + ANGLES_LABEL + "</button>" +
        '<span class="editor__spacer"></span>' +
        '<button type="button" class="btn btn--primary editor__save"></button>' +
        '<button type="button" class="btn editor__cancel">Cancel <kbd class="kbd">' + escapeHtml(keyLabel("Escape", "esc")) + "</kbd></button>" +
      "</div>";
    var textarea = el.querySelector(".editor__textarea");
    var previewEl = el.querySelector(".editor__preview");
    var lintEl = el.querySelector(".editor__lint");
    var similarEl = batch ? null : el.querySelector(".editor__similar");
    var wrapBtn = el.querySelector(".editor__wrap");
    var anglesBtn = el.querySelector(".editor__angles");
    var saveBtn = el.querySelector(".editor__save");
    var cancelBtn = el.querySelector(".editor__cancel");
    var saveCap = escapeHtml(keyLabel("Mod+Enter", "⌘↩"));
    textarea.placeholder = batch
      ? "Q. question\nA. answer\n\n# Section\nA sentence with {cloze} braces"
      : "Q. question ⇥ A. answer — or a sentence with {cloze} braces";

    // ---- preview & status
    function refresh() {
      if (destroyed) return;
      var text = textarea.value;
      autosize();
      if (batch) renderBatch(text); else renderSingle(text);
    }
    function renderSingle(text) {
      var parsed = parseText(text);
      lastParsed = parsed;
      var imageUrl = imageUrlFn(), html = "";
      if (parsed.kind === "qa") {
        html = '<div class="editor__pq">' + renderHtml(parsed.question, { mode: "preview", imageUrl: imageUrl, mask: null }) + "</div>" +
               '<div class="editor__pa">' + renderHtml(parsed.answer, { mode: "preview", imageUrl: imageUrl, mask: null }) + "</div>";
      } else if (parsed.kind === "cloze") {
        html = '<div class="editor__pq">' + renderHtml(parsed.display, { mode: "preview", imageUrl: imageUrl, mask: { index: 0, reveal: false } }) + "</div>";
      } else if (parsed.kind === "note") {
        html = '<div class="editor__pq editor__pq--note">' + renderHtml(parsed.display, { mode: "preview", imageUrl: imageUrl, mask: null }) + "</div>";
      }
      if (parsed.tags && parsed.tags.length) {
        html += '<div class="editor__tags">' + parsed.tags.map(function (t) { return '<span class="chip">#' + escapeHtml(t) + "</span>"; }).join("") + "</div>";
      }
      previewEl.innerHTML = pendingChips(html, pendingIds);
      var lint = worstLint(parsed);
      lintEl.textContent = withQueuedNote(statusLine(parsed, hasRects));
      lintEl.className = "editor__lint" + (lint ? " editor__lint--warn" : "");
      renderSimilar(text, parsed);
      saveBase = { label: customLabel || saveLabel(false, 0), disabled: false };
      applySaveState();
    }
    // The look-alike line (FEATURES P2.4): only for a Q./A. or cloze text of a book or deck; any failure hides it.
    function renderSimilar(text, parsed) {
      if (!similarEl) return;
      var line = "";
      if (collectionId && parsed && (parsed.kind === "qa" || parsed.kind === "cloze")) {
        try {
          var C = M.cache, list = C && typeof C.promptsOf === "function" ? C.promptsOf(collectionId) : [];
          var ignored = null;
          if (prompt && M.settings && typeof M.settings.get === "function") ignored = M.settings.get("notAlike");
          line = similarLine(text, list, prompt ? prompt.id : null, ignored);
        } catch (e) { line = ""; }
      }
      similarEl.textContent = line;
      similarEl.classList.toggle("is-hidden", !line);
    }
    function renderBatch(text) {
      var P = prompts(), blocks = [];
      if (P && typeof P.parseBatch === "function") { try { blocks = P.parseBatch(text) || []; } catch (e) { blocks = []; } }
      lastBlocks = blocks;
      var imageUrl = imageUrlFn(), html = "", section = null, cards = 0, i;
      for (i = 0; i < blocks.length; i++) {
        var b = blocks[i], p = b.parsed || parseText(b.text);
        if (b.section !== section) {
          section = b.section;
          if (section) html += '<div class="editor__section">' + escapeHtml(section) + "</div>";
        }
        cards += cardCount(p);
        var lint = worstLint(p);
        var qhtml = p.kind === "qa"
          ? renderHtml(p.question, { mode: "preview", imageUrl: imageUrl, mask: null })
          : renderHtml(p.display, { mode: "preview", imageUrl: imageUrl, mask: p.kind === "cloze" ? { index: 0, reveal: false } : null });
        html += '<div class="editor__block editor__block--' + escapeHtml(p.kind) + '">' +
          '<span class="editor__glyph">' + escapeHtml(GLYPHS[p.kind] || "") + "</span>" +
          '<div class="editor__blockbody"><div class="editor__pq">' + qhtml + "</div>" +
          (p.kind === "qa" ? '<div class="editor__pa">' + renderHtml(p.answer, { mode: "preview", imageUrl: imageUrl, mask: null }) + "</div>" : "") +
          (lint ? '<span class="chip editor__chip">' + escapeHtml(lint.msg || lint.code) + "</span>" : "") +
          "</div></div>";
      }
      previewEl.innerHTML = pendingChips(html, pendingIds);
      var n = blocks.length;
      lintEl.textContent = withQueuedNote(n ? n + (n === 1 ? " prompt" : " prompts") + " · " + cards + (cards === 1 ? " card" : " cards") : "");
      lintEl.className = "editor__lint";
      saveBase = { label: saveLabel(true, n), disabled: n === 0 };
      applySaveState();
    }
    function withQueuedNote(status) {
      if (!queuedSave) return status;
      return status ? status + " · " + QUEUED_NOTE : QUEUED_NOTE;
    }
    // The Save button: "Adding image…" (disabled) while a placeholder is pending, else the mode's label.
    function applySaveState() {
      if (pendingIds.length) {
        saveBtn.innerHTML = escapeHtml(PENDING_LABEL);
        saveBtn.disabled = true;
        saveBtn.setAttribute("aria-busy", "true");
        saveBtn.title = queuedSave ? QUEUED_NOTE : "Wait for the image to be added";
      } else {
        saveBtn.innerHTML = escapeHtml(saveBase.label) + ' <kbd class="kbd">' + saveCap + "</kbd>";
        saveBtn.disabled = !!saveBase.disabled;
        saveBtn.removeAttribute("aria-busy");
        saveBtn.title = "";
      }
    }
    var util = M.util || dep("util");
    var refreshSoon = util && typeof util.debounce === "function" ? util.debounce(refresh, PREVIEW_DEBOUNCE_MS) : (function () {
      var t = null;
      var f = function () { if (t) clearTimeout(t); t = setTimeout(function () { t = null; refresh(); }, PREVIEW_DEBOUNCE_MS); };
      f.cancel = function () { if (t) { clearTimeout(t); t = null; } };
      return f;
    })();

    function refreshNow() {
      if (refreshSoon.cancel) refreshSoon.cancel();
      refresh();
    }

    function autosize() {
      try {
        textarea.style.height = "auto";
        var h = textarea.scrollHeight;
        if (h > 0) textarea.style.height = h + "px";
      } catch (e) { /* detached */ }
    }

    // ---- drafts (throttled: at most one write per 300 ms, trailing)
    function saveDraftNow() {
      draftTimer = null;
      if (destroyed || !draftDirty) return;
      draftDirty = false;
      var text = textarea.value;
      if (persist) writeDraft(key, text);
      else if (text === initialText || !text.trim()) removeDraft(key); else writeDraft(key, text);
    }
    function scheduleDraft() {
      draftDirty = true;
      if (draftTimer === null) draftTimer = setTimeout(saveDraftNow, DRAFT_EVERY_MS);
    }
    function clearDraft() {
      if (draftTimer !== null) { clearTimeout(draftTimer); draftTimer = null; }
      draftDirty = false;
      persist = false;                                     // Save or Cancel: a kept draft ends here
      removeDraft(key);
    }

    // ---- editing helpers
    function dispatchInput() {
      try { textarea.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) { onInput(); }
    }
    function setCaret(pos) {
      try { textarea.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    }
    function insertAtCaret(text) {
      if (destroyed) return;
      text = str(text);
      var start = textarea.selectionStart, end = textarea.selectionEnd;
      if (typeof start !== "number") { start = end = textarea.value.length; }
      try { textarea.setRangeText(text, start, end, "end"); }
      catch (e) {
        var v = textarea.value;
        textarea.value = v.slice(0, start) + text + v.slice(end);
        setCaret(start + text.length);
      }
      dispatchInput();
      textarea.focus();
    }
    function wrapSelection() {
      if (destroyed) return;
      var start = textarea.selectionStart, end = textarea.selectionEnd;
      if (typeof start !== "number") { start = end = textarea.value.length; }
      var r = wrapBraces(textarea.value, start, end);
      try { textarea.setRangeText(r.text.slice(start, r.end + 1), start, end, "select"); }   // "{" + the selection (its "::" escaped) + "}"
      catch (e) { textarea.value = r.text; }
      try { textarea.setSelectionRange(r.start, r.end); } catch (e2) { /* ignore */ }
      dispatchInput();
      textarea.focus();
    }
    function handleTab(shift) {
      var text = textarea.value;
      if (!tabCapturable(text)) return false;
      var t = shift ? shiftTabTarget(text) : tabTarget(text);
      if (!t) return false;
      if (t.action === "insert") { textarea.value = t.text + text; setCaret(t.caret); }
      else if (t.action === "append") { textarea.value = t.base + t.text; setCaret(t.caret); }
      else setCaret(t.caret);
      if (t.action !== "caret") dispatchInput();
      return true;
    }
    // Replace every occurrence of `from` in the textarea, keeping the selection where it was (setRangeText
    // "preserve" semantics; a manual fallback shifts the caret by the length difference). Returns the count.
    function replaceAll(from, to) {
      var n = 0, v = textarea.value, idx = from ? v.indexOf(from) : -1;
      while (idx >= 0) {
        var end = idx + from.length, done = false;
        try { textarea.setRangeText(to, idx, end, "preserve"); done = textarea.value.slice(idx, idx + to.length) === to; }
        catch (e) { done = false; }
        if (!done) {
          var s = textarea.selectionStart, se = textarea.selectionEnd, delta = to.length - from.length;
          textarea.value = v.slice(0, idx) + to + v.slice(end);
          if (typeof s === "number" && typeof se === "number") {
            var ns = s > end ? s + delta : (s > idx ? idx : s);
            var ne = se > end ? se + delta : (se > idx ? idx + to.length : se);
            try { textarea.setSelectionRange(ns, ne); } catch (e2) { /* ignore */ }
          }
        }
        n++;
        v = textarea.value;
        idx = v.indexOf(from, idx + to.length);
      }
      if (n) dispatchInput();
      return n;
    }
    // M.attachments.attach step 1: the placeholder token lands at the caret and Save waits for it.
    function placePending(pid) {
      if (destroyed || typeof pid !== "string" || !pid) return false;
      if (pendingIds.indexOf(pid) < 0) pendingIds.push(pid);
      insertAtCaret(tokenOf(pid));
      refreshNow();
      return true;
    }
    // Step 3: swap the placeholder for the stored token (id) or drop it (null); the queued save runs once
    // the last placeholder has settled. Returns true when the stored token was written into the text.
    function resolvePending(pid, id) {
      var i = pendingIds.indexOf(pid);
      if (i >= 0) pendingIds.splice(i, 1);
      if (destroyed) return false;
      var applied = false;
      if (id) applied = replaceAll(tokenOf(pid), tokenOf(id)) > 0;
      else replaceAll(tokenOf(pid), "");
      refreshNow();
      if (!pendingIds.length && queuedSave) {
        var q = queuedSave;
        queuedSave = null;
        doSave(q.another, q.confirmed);
      }
      return applied;
    }
    function insertAttachment(blob) {
      var A = M.attachments;
      if (!A || typeof A.fromBlob !== "function") return Promise.reject(error("no_attachments", "M.attachments is not loaded"));
      if (destroyed) return Promise.reject(error("destroyed", "The editor is closed"));
      try {
        if (typeof A.attach === "function") return Promise.resolve(A.attach(blob, editor));
        return Promise.resolve(A.fromBlob(blob)).then(function (att) {
          if (att && att.id) insertAtCaret(tokenOf(att.id));
          return att;
        });
      } catch (e) { return Promise.reject(e); }
    }

    // ---- the "Another angle" picker (FEATURES P2.3): a popover inside the editor, below it. Its keys are its own
    // (↑↓ Home End move, Enter picks, Tab cycles inside, Esc closes and gives the focus back to the textarea) and never
    // reach M.app's key maps; a mousedown outside closes it.
    function updateAnglesButton() {
      var show = !destroyed && anglesShown(textarea.value, !prompt, batch);
      anglesBtn.classList.toggle("is-hidden", !show);
      if (!show && picker) closeAngles(false);
    }
    function closeAngles(refocus) {
      var pk = picker;
      if (!pk) return false;
      picker = null;
      try { document.removeEventListener("mousedown", pk.onDown, true); } catch (e) { /* ignore */ }
      try { document.removeEventListener("scroll", pk.onMove, true); } catch (e) { /* ignore */ }
      try { if (typeof root.removeEventListener === "function") root.removeEventListener("resize", pk.onMove); } catch (e) { /* ignore */ }
      try { if (pk.raf && typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(pk.raf); } catch (e) { /* ignore */ }
      pk.raf = 0;
      if (pk.el.parentNode) pk.el.parentNode.removeChild(pk.el);
      anglesBtn.setAttribute("aria-expanded", "false");
      if (refocus && !destroyed) { try { textarea.focus({ preventScroll: true }); } catch (e) { try { textarea.focus(); } catch (e2) { /* ignore */ } } }
      return true;
    }
    function pickAngle(id) {
      var a = angleStarter(id);
      closeAngles(false);
      if (!a || destroyed) return false;
      textarea.value = a.text;
      try { textarea.focus({ preventScroll: true }); } catch (e) { try { textarea.focus(); } catch (e2) { /* ignore */ } }
      try { textarea.setSelectionRange(a.start, a.end); } catch (e) { /* ignore */ }
      dispatchInput();
      try { textarea.setSelectionRange(a.start, a.end); } catch (e) { /* ignore */ }
      return true;
    }
    // The editor's ancestors that clip their content, nearest first (the reader's scroller, the prompt list's rows, a
    // card popover, the sheet): their boxes in viewport px, for anglesArea.
    function anglesClips() {
      var out = [], de = document.documentElement;
      if (typeof root.getComputedStyle !== "function") return out;
      for (var n = el.parentNode; n && n.nodeType === 1 && n !== document.body && n !== de; n = n.parentNode) {
        var cs = root.getComputedStyle(n);
        var y = !!cs && !!cs.overflowY && cs.overflowY !== "visible", x = !!cs && !!cs.overflowX && cs.overflowX !== "visible";
        if (!x && !y) continue;
        var r = n.getBoundingClientRect();
        out.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, x: x, y: y });
      }
      return out;
    }
    // Puts the open picker in its place (anglesArea, anglesPlace). Inside its boxes it is an absolute child of the
    // editor and moves with it. When it had to leave a box it is position: fixed at the editor's edge, and a scroll
    // or a resize puts it there again (picker.onMove), or closes it once the editor is out of the area (anglesOut).
    // No layout (the Node tests): it stays below, left-aligned.
    function placeAngles() {
      var pk = picker;
      if (!pk || !pk.size) return;
      try {
        var pop = pk.el, st = pop.style, er = el.getBoundingClientRect(), de = document.documentElement;
        var win = { top: 0, left: 0, right: (de && de.clientWidth) || root.innerWidth || 0, bottom: (de && de.clientHeight) || root.innerHeight || 0 };
        var area = anglesArea(er, anglesClips(), win, pk.trapped);
        if (area.escape > 0 && anglesOut(er, area.bounds)) { closeAngles(true); return; }   // the editor scrolled out of sight
        var place = anglesPlace(er, pk.size, area.bounds), fixed = area.escape > 0;
        pop.classList.toggle("editor__angles-pop--up", place.up);
        pop.classList.toggle("editor__angles-pop--right", place.right);
        pop.classList.toggle("editor__angles-pop--fixed", fixed);
        st.maxHeight = place.maxHeight ? place.maxHeight + "px" : "";
        st.top = !fixed ? "" : place.up ? "auto" : er.bottom + "px";
        st.bottom = !fixed ? "" : place.up ? (win.bottom - er.top) + "px" : "auto";
        st.left = !fixed ? "" : place.right ? "auto" : er.left + "px";
        st.right = !fixed ? "" : place.right ? (win.right - er.right) + "px" : "auto";
        pk.fixed = fixed;
        if (fixed) {                                       // an ancestor with a transform holds a fixed box: then stay inside
          var r = pop.getBoundingClientRect();
          var dx = place.right ? r.right - er.right : r.left - er.left, dy = place.up ? er.top - r.bottom : r.top - er.bottom;
          if (Math.abs(dx) > 2 || dy < -2 || dy > ANGLES_EDGE + 2) { pk.trapped = true; placeAngles(); }
        }
      } catch (e) { /* keep it below */ }
    }
    function openAngles() {
      if (destroyed || picker || !anglesShown(textarea.value, !prompt, batch)) return false;
      var pop = document.createElement("div");
      pop.className = "editor__angles-pop";
      pop.setAttribute("role", "menu");
      pop.setAttribute("aria-label", "Another angle");
      pop.innerHTML = ANGLE_GROUPS.map(function (g) {
        var rows = ANGLES.filter(function (a) { return a.group === g.id; });
        if (!rows.length) return "";
        return '<div class="editor__angle-set" role="group" aria-label="' + escapeHtml(g.label) + '">' +
          '<div class="editor__angle-group" aria-hidden="true">' + escapeHtml(g.label) + "</div>" +
          rows.map(function (a) {
            return '<button type="button" class="editor__angle" role="menuitem" tabindex="-1" data-angle="' + escapeHtml(a.id) + '">' + escapeHtml(a.label) + "</button>";
          }).join("") + "</div>";
      }).join("");
      function items() { return Array.prototype.slice.call(pop.querySelectorAll(".editor__angle")); }
      pop.addEventListener("click", function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest(".editor__angle") : ev.target;
        if (!b || typeof b.getAttribute !== "function" || !b.getAttribute("data-angle")) return;
        ev.preventDefault();
        ev.stopPropagation();
        pickAngle(b.getAttribute("data-angle"));
      });
      pop.addEventListener("keydown", function (ev) {
        var list = items(), i = list.indexOf(document.activeElement), k = ev.key;
        ev.stopPropagation();                              // local keys: never M.app's maps (Esc must not cancel the editor)
        if (ev.isComposing) return;
        if (k === "ArrowDown" || (k === "Tab" && !ev.shiftKey)) { ev.preventDefault(); if (list.length) list[(i + 1) % list.length].focus(); }
        else if (k === "ArrowUp" || (k === "Tab" && ev.shiftKey)) { ev.preventDefault(); if (list.length) list[(i - 1 + list.length) % list.length].focus(); }
        else if (k === "Home") { ev.preventDefault(); if (list.length) list[0].focus(); }
        else if (k === "End") { ev.preventDefault(); if (list.length) list[list.length - 1].focus(); }
        else if (k === "Enter" || k === " ") {
          ev.preventDefault();
          if (ev.repeat) return;
          var cur = i >= 0 ? list[i] : null;
          if (cur) pickAngle(cur.getAttribute("data-angle"));
        }
        else if (k === "Escape") { ev.preventDefault(); closeAngles(true); }
      });
      pop.addEventListener("mousedown", function (ev) {    // a press on a heading or between the groups takes no focus:
        var t = ev.target;                                 // the focused question keeps it, so the keys stay the picker's
        if (!(t && typeof t.closest === "function" && t.closest(".editor__angle"))) ev.preventDefault();
      });
      var onDown = function (ev) { if (!pop.contains(ev.target) && ev.target !== anglesBtn) closeAngles(false); };
      var pk = { el: pop, onDown: onDown, onMove: null, size: null, fixed: false, trapped: false, raf: 0 };
      pk.onMove = function (ev) {                          // a resize, or a scroll while the picker is fixed: place it again
        if (picker !== pk || pk.raf) return;
        if (ev && ev.type === "scroll" && (!pk.fixed || ev.target === pop)) return;
        var run = function () { pk.raf = 0; if (picker === pk) placeAngles(); };
        if (typeof root.requestAnimationFrame === "function") pk.raf = root.requestAnimationFrame(run); else run();
      };
      el.appendChild(pop);
      try {                                                // its natural size: all the rows, without the stylesheet's height cap
        pop.style.maxHeight = "none";
        var pr = pop.getBoundingClientRect();
        pk.size = { width: pr.width, height: pr.height };
        pop.style.maxHeight = "";
      } catch (e) { /* no layout */ }
      picker = pk;
      placeAngles();
      if (picker !== pk) return false;                     // the editor is out of sight: nothing to open
      document.addEventListener("mousedown", onDown, true);
      try { document.addEventListener("scroll", pk.onMove, true); } catch (e) { /* ignore */ }
      try { if (typeof root.addEventListener === "function") root.addEventListener("resize", pk.onMove); } catch (e) { /* ignore */ }
      anglesBtn.setAttribute("aria-expanded", "true");
      var first = items()[0];
      if (first) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
      return true;
    }
    function toggleAngles() { if (picker) closeAngles(true); else openAngles(); }

    // ---- save / cancel
    function finishSave(text, another, count) {
      var handed = textarea.value;
      // A placeholder restored from a draft while its image was still decoding is rewritten once stored.
      var A = M.attachments;
      if (A && typeof A.resolveText === "function") { try { text = A.resolveText(text); } catch (e) { /* keep the text */ } }
      clearDraft();
      held = null;
      saving = true;
      var result;
      try { result = onSave(text, { another: !!another }); }
      catch (e) { saving = false; throw e; }
      if (result && typeof result.then === "function") {
        result.then(function () { saving = false; }, function () { saving = false; });
      } else if (saving) {
        // No promise to wait for, and the host did not reset the editor during onSave: it resets it with setText()
        // once its own writes land (the deck box), or never (nothing to add, a failed write). So only a re-save of
        // this same, unedited text is held back, and only while the host may still be writing it (a double press
        // must not store a batch twice); an edit, the host's reset or the end of that window releases it.
        saving = false;
        held = { text: handed, until: Date.now() + HOLD_MS + HOLD_PER_PROMPT_MS * Math.max(0, (count | 0) - 1) };
      }
    }
    // confirmed: the dropped-card question was already answered (a save re-run after pending images settled).
    function doSave(another, confirmed) {
      if (destroyed || saving) return true;
      if (held) {
        if (textarea.value === held.text && Date.now() < held.until) { textarea.focus(); return true; }  // a double press
        held = null;
      }
      if (pendingIds.length) {                             // an image is still being added: save when it lands
        queuedSave = { another: !!another, confirmed: !!confirmed };
        refreshNow();
        return true;
      }
      var text = textarea.value;
      if (batch) {
        var P = prompts(), blocks = [];
        if (P && typeof P.parseBatch === "function") { try { blocks = P.parseBatch(text) || []; } catch (e) { blocks = []; } }
        if (!blocks.length) { textarea.focus(); return true; }
        finishSave(text, another, blocks.length);
        return true;
      }
      if (prompt && !confirmed) {
        var P2 = prompts(), app = M.app, msg = null;
        if (P2 && typeof P2.reconcileCards === "function") {
          try { msg = droppedMessage(P2.reconcileCards(prompt, parseText(text), Date.now()).dropped); } catch (e) { msg = null; }
        }
        if (msg && app && typeof app.confirm === "function") {
          saving = true;
          var q;
          try { q = Promise.resolve(app.confirm({ title: "Save anyway?", body: msg, ok: "Save anyway", cancel: "Keep editing", danger: true })); }
          catch (e) { q = Promise.resolve(true); }
          q.then(function (ok) {
            saving = false;
            if (destroyed) return;
            if (!ok) { textarea.focus(); return; }
            if (pendingIds.length) { queuedSave = { another: !!another, confirmed: true }; refreshNow(); return; }
            finishSave(text, another);
          }, function () { saving = false; if (!destroyed) textarea.focus(); });
          return true;
        }
      }
      finishSave(text, another);
      return true;
    }
    function doCancel() {
      if (destroyed) return true;
      queuedSave = null;
      var text = textarea.value;
      clearDraft();
      var A = M.attachments;
      if (A && typeof A.gc === "function") {
        try { Promise.resolve(A.gc(text, prompt ? str(prompt.text) : "", { draftIds: [] })).then(null, function () {}); } catch (e) { /* ignore */ }
      }
      try { onCancel(); } catch (e) { try { console.error("[editor] onCancel threw:", e); } catch (e2) { /* no console */ } }
      return true;
    }
    function run(id) {
      if (destroyed) return false;
      switch (id) {
        case "save": return doSave(false);
        case "saveAnother": return doSave(true);
        case "cancel": return doCancel();
        case "wrapCloze": wrapSelection(); return true;
        default: return false;
      }
    }

    // ---- events
    function onInput() {
      if (destroyed) return;
      held = null;                                         // edited after a hand-off: it may be saved again at once
      updateAnglesButton();
      autosize();
      scheduleDraft();
      refreshSoon();
    }
    function consume(ev) { ev.preventDefault(); ev.stopPropagation(); }
    // A key held while the focus moved in (the N / E / C that opened this editor, a held Cmd+Shift+Enter that
    // reopened it, Tab arriving here) only auto-repeats into the textarea: until a keydown starts here, its
    // repeats are swallowed instead of being typed or run. Re-armed whenever the textarea takes the focus.
    function onFocus() { keyFresh = false; }
    function onKeydown(ev) {
      if (destroyed) return;
      if (!ev.repeat) keyFresh = true;
      else if (!keyFresh) { consume(ev); return; }
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Tab" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (ev.repeat) { if (tabCapturable(textarea.value)) consume(ev); return; }  // a held Tab acts once
        if (handleTab(ev.shiftKey)) consume(ev);
        return;
      }
      var K = M.keys || dep("keys");
      if (!K || typeof K.dispatch !== "function" || !K.EDITOR_MAP) return;
      var id = K.dispatch(ev, [K.EDITOR_MAP]);
      if (!id) return;
      // Single-shot actions ignore auto-repeat (SPEC §3). This listener runs before M.app's document listener and
      // stops a matched key, so M.app's repeat guard never sees it: the repeat is consumed here, without running.
      if (ev.repeat) { consume(ev); return; }
      if (run(id)) consume(ev);
    }
    function onPaste(ev) {
      if (destroyed) return;
      var A = M.attachments;
      if (A && typeof A.handlePaste === "function") {
        var handled = false;
        try { handled = A.handlePaste(ev, editor); } catch (e) { handled = false; }
        if (handled) { if (!ev.defaultPrevented) ev.preventDefault(); return; }
      }
      // native text paste: the draft and the preview follow through the input event
    }
    function onDragover(ev) {
      var dt = ev.dataTransfer;
      if (dt && dt.types && Array.prototype.indexOf.call(dt.types, "Files") >= 0) { ev.preventDefault(); el.classList.add("editor--dragover"); }
    }
    function onDragleave() { el.classList.remove("editor--dragover"); }
    function onDrop(ev) {
      el.classList.remove("editor--dragover");
      if (destroyed) return;
      var A = M.attachments;
      if (A && typeof A.handleDrop === "function") {
        var handled = false;
        try { handled = A.handleDrop(ev, editor); } catch (e) { handled = false; }
        if (handled) { if (!ev.defaultPrevented) ev.preventDefault(); }
      }
    }
    function onButtonMousedown(ev) { ev.preventDefault(); } // keep the textarea's selection for {}

    textarea.addEventListener("input", onInput);
    textarea.addEventListener("keydown", onKeydown);
    textarea.addEventListener("focus", onFocus);
    textarea.addEventListener("paste", onPaste);
    el.addEventListener("dragover", onDragover);
    el.addEventListener("dragleave", onDragleave);
    el.addEventListener("drop", onDrop);
    wrapBtn.addEventListener("mousedown", onButtonMousedown);
    wrapBtn.addEventListener("click", function () { wrapSelection(); });
    anglesBtn.addEventListener("click", function (ev) { ev.stopPropagation(); toggleAngles(); });
    saveBtn.addEventListener("click", function () { doSave(false); });
    cancelBtn.addEventListener("click", function () { doCancel(); });

    // ---- public surface
    var editor = {
      el: el,
      textarea: textarea,
      batch: batch,
      prompt: prompt,
      anchor: anchor,
      draftKey: key,
      keepDraft: keepDraft,
      insertAtCaret: insertAtCaret,
      insertAttachment: insertAttachment,
      placePending: placePending,
      resolvePending: resolvePending,
      pendingCount: function () { return pendingIds.length; },
      getText: function () { return destroyed ? "" : textarea.value; },
      setText: function (t) {
        if (destroyed) return;
        saving = false;                                    // the host reset the editor for another round
        held = null;
        textarea.value = str(t);
        setCaret(textarea.value.length);
        scheduleDraft();
        updateAnglesButton();
        refreshSoon.cancel && refreshSoon.cancel();
        refresh();
      },
      focus: function () {
        if (destroyed) return;
        try { textarea.focus({ preventScroll: true }); } catch (e) { try { textarea.focus(); } catch (e2) { /* ignore */ } }
        autosize();
      },
      // the host's word on a save it declined ("Type a note first"): shown in the lint line until the next edit
      hint: function (msg) {
        if (destroyed) return;
        if (refreshSoon.cancel) refreshSoon.cancel();
        lintEl.textContent = str(msg);
        lintEl.className = "editor__lint editor__lint--warn";
        if (keepDraft && !persist) { persist = true; writeDraft(key, textarea.value); }   // the save was declined: keep it
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        closeAngles(false);
        if (draftTimer !== null) { clearTimeout(draftTimer); draftTimer = null; }
        if (persist) { draftDirty = false; writeDraft(key, textarea.value); }
        else if (draftDirty) { draftDirty = false; var t = textarea.value; if (t !== initialText && t.trim()) writeDraft(key, t); else removeDraft(key); }
        if (refreshSoon.cancel) refreshSoon.cancel();
        textarea.removeEventListener("input", onInput);
        textarea.removeEventListener("keydown", onKeydown);
        textarea.removeEventListener("focus", onFocus);
        textarea.removeEventListener("paste", onPaste);
        el.removeEventListener("dragover", onDragover);
        el.removeEventListener("dragleave", onDragleave);
        el.removeEventListener("drop", onDrop);
        if (el.parentNode) el.parentNode.removeChild(el);
      },
      run: run,
      openAngles: openAngles,
      closeAngles: function () { return closeAngles(true); },
      anglesOpen: function () { return !!picker; },
      isDestroyed: function () { return destroyed; },
      parsed: function () { return lastParsed; },
      blocks: function () { return lastBlocks; }
    };

    // ---- initial text (a draft wins when present), mount, caret at the end
    var draft = readDraft(key), A0 = M.attachments;
    if (typeof draft === "string" && A0 && typeof A0.resolveText === "function") {
      try { draft = A0.resolveText(draft); } catch (e) { /* keep the draft as it is */ }
    }
    var text = (typeof draft === "string" && draft.trim() && draft !== initialText) ? draft : initialText;
    textarea.value = text;
    if (persist) writeDraft(key, text);                    // FIXES-1 FIX-1: kept from the moment it opens
    if (opts.host && typeof opts.host.appendChild === "function") opts.host.appendChild(el);
    refresh();
    setCaret(text.length);
    updateAnglesButton();
    return editor;
  }

  // FIXES-1 FIX-1: a host reads or drops a draft by the key create() would use for opts.draftKey `override`.
  function draftText(override) {
    if (typeof override !== "string" || !override) return null;
    var d = readDraft(draftKey(null, null, override));
    return typeof d === "string" ? d : null;
  }
  function dropDraft(override) {
    if (typeof override !== "string" || !override) return false;
    return removeDraft(draftKey(null, null, override));
  }
  // FIXES-1 FIX-1 d: deleting a prompt drops its split draft (best effort: only while M.bus is loaded before this file).
  (function () {
    var B = M.bus;
    if (!B || typeof B.on !== "function") return;
    try { B.on("prompt:deleted", function (e) { if (e && typeof e.promptId === "string" && e.promptId) dropDraft(SPLIT_DRAFT_PREFIX + e.promptId); }); }
    catch (e) { /* no bus */ }
  })();

  var api = {
    create: create,
    draftText: draftText,
    dropDraft: dropDraft,
    SPLIT_DRAFT_PREFIX: SPLIT_DRAFT_PREFIX,
    // pure helpers (extensions, used by tests and by the margin)
    draftKey: draftKey,
    anchorHash: anchorHash,
    tabCapturable: tabCapturable,
    tabTarget: tabTarget,
    shiftTabTarget: shiftTabTarget,
    wrapBraces: wrapBraces,
    cardCount: cardCount,
    statusLine: statusLine,
    saveLabel: saveLabel,
    droppedMessage: droppedMessage,
    pendingChips: pendingChips,
    anglesShown: anglesShown,
    anglesPlace: anglesPlace,
    anglesArea: anglesArea,
    anglesOut: anglesOut,
    angleStarter: angleStarter,
    similarLine: similarLine,
    SIMILAR_LABEL: SIMILAR_LABEL,
    ANGLES: ANGLES,
    ANGLE_GROUPS: ANGLE_GROUPS,
    ANGLE_ANSWER: ANGLE_ANSWER,
    DRAFT_PREFIX: DRAFT_PREFIX,
    PENDING_LABEL: PENDING_LABEL
  };
  M.editor = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.editor + BUILD-NOTES):
 *   create({host, prompt|null, initialText, anchor, batch, onSave(text, {another}), onCancel}) → Editor
 *   Editor: el, textarea, insertAtCaret(text), insertAttachment(blob) → Promise, getText(), setText(t),
 *           focus(), destroy(), run(id) → boolean for save | saveAnother | cancel | wrapCloze
 *   Extensions: draftKey(prompt, anchor, override), anchorHash(anchor), tabCapturable(text), tabTarget(text),
 *   shiftTabTarget(text), wrapBraces(text, start, end) (FEATURES P1.1 e: a "::" inside the wrapped text becomes
 *   `\::` through M.prompts.escapeCues, so the wrap never makes a cue), cardCount(parsed), statusLine(parsed, hasRects),
 *   saveLabel(batch, n), droppedMessage(dropped), pendingChips(html, ids), DRAFT_PREFIX, PENDING_LABEL; Editor
 *   also exposes batch, prompt, anchor, draftKey, isDestroyed(), parsed(), blocks(), placePending(pid),
 *   resolvePending(pid, id|null), pendingCount(), hint(msg) (a host's message in the lint line until the next edit:
 *   the margin's "Type a note first" for a blank free note). create() accepts an optional draftKey override (deck box)
 *   and saveLabel (single mode: the Save button's text before its ⌘↩ cap, "Save + Obsidian" for BUILD-NOTES "Obsidian").
 *   FEATURES P2.2 / P2.3: create() also accepts note (single mode: the .editor__note line) and angles is opened by the
 *   host through Editor.openAngles() → boolean (false unless anglesShown); Editor.closeAngles(), anglesOpen(). Pure:
 *   ANGLE_GROUPS [{id, label}] (10 groups), ANGLES [{id, group, label, text}] (28 starters), ANGLE_ANSWER "\nA. ",
 *   anglesShown(text, isNew, batch), anglesPlace(editorRect, popSize, bounds) → {up, right, maxHeight} (the picker's
 *   side, classes .editor__angles-pop--up and --right, and its height cap when neither side holds the whole list),
 *   anglesArea(editorRect, clips, win, stay) → {bounds, escape} (the area inside the clipping ancestors; escape > 0:
 *   the picker leaves the nearest ones, class .editor__angles-pop--fixed), anglesOut(editorRect, bounds) → boolean (a
 *   fixed picker closes when its editor has left the area),
 *   angleStarter(id) → {text, start, end}|null ([start, end) = the first "…"). No key map changes (D20).
 *   FEATURES P2.4: create() accepts collectionId (default: the edited prompt's); single mode shows .editor__similar
 *   "Similar prompt: “…” (p. N)" from M.similar.nearest (with the lints' debounce; hidden when there is none; the prompt
 *   being edited and its notAlike pairs left out). Pure: similarLine(text, candidates, exceptId, ignored) → string,
 *   SIMILAR_LABEL "Similar prompt: ".
 *   FIXES-1 FIX-1: create() accepts keepDraft (single mode: the text is the draft from the moment the editor opens until
 *   its Save or Cancel, whatever else closes it; Editor.keepDraft). Pure: draftText(override) → string|null,
 *   dropDraft(override) → boolean (the draft create() keeps for opts.draftKey `override`), SPLIT_DRAFT_PREFIX "split:".
 *   A prompt:deleted on M.bus drops that prompt's "split:<id>" draft.
 */
