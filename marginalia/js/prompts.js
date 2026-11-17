/*
 * Marginalia — js/prompts.js
 * Pure prompt syntax module (SPEC §4, §14 batch, §16 tokenizer).
 *
 * tokenize(text) splits raw prompt text into runs of text, math and image
 * tokens; parse(text) is the single source of truth for a prompt's kind,
 * question/answer, cloze deletions, tags and lints. Nothing here produces
 * HTML (M.markup does, from these tokens and deletions) and nothing touches
 * the DOM. The only dependency is M.scheduler.newSchedule, resolved lazily
 * through dep() inside reconcileCards().
 *
 * Offsets: every `start`/`end` (runs and deletions) is an offset into the raw
 * string that was passed in. `display` (text without the tags line) is always
 * a prefix of the raw text, so deletion offsets apply to text, display and
 * body alike.
 *
 * Cues (FEATURES P1.1): `{hidden::cue}`. A deletion is {start, end, text, cue?}:
 * `text` is the hidden part as typed (everything between `{` and the
 * separator; the whole inside when there is no cue), `cue` the trimmed cue.
 * With a cue the separator therefore sits at start + 1 + text.length. A card
 * is identified by its hidden part alone (reconcileCards). The writing hints
 * of FEATURES P1.2 (either_or, list_answer, long_cloze, the wider yes_no) and
 * P2.1 (example_prompt, book_bound, undated) are in lint(parsed, now); every
 * threshold and word list is a named constant.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }

  var IMAGE_RE = /!\[[^\]\n]*\]\(att:([^)\s]+)\)/y;
  var TAG_TOKEN_RE = /#[\w-]{2,}/g;
  var TAG_LINE_RE = /^\s*#[\w-]{2,}(?:\s+#[\w-]{2,})*\s*$/;
  var Q_LINE_RE = /^\s*Q\./;
  var Q_LINE_ANYWHERE_RE = /^\s*Q\./m;
  var A_LINE_RE = /^\s*A\./;
  var SECTION_LINE_RE = /^#\s+(\S.*)$/;
  var YES_NO_RE = /^(is|are|do|does|can|did|was|were|has|have|had|will|would|should|could|must)\b/i;
  var YES_NO_ANSWERS = { yes: true, no: true, "true": true, "false": true };

  // Choices that are one constant each (FEATURES P1.1, P1.2), so they can change in one place.
  var CUE_SEP = "::";              // {hidden::cue}: the cue separator (Anki's hint separator; "|" occurs in physics text)
  var LONG_ANSWER_WORDS = 15;      // long_answer: more words than this
  var LONG_QUESTION_WORDS = 25;    // long_question: more words than this
  var MANY_DELETIONS = 3;          // many_deletions: this many deletions or more
  var EITHER_OR_WORDS = 6;         // either_or: the answer has at most this many words
  var LIST_MIN_ITEMS = 3;          // list_answer: this many items or more
  var LIST_ITEM_WORDS = 5;         // list_answer: an item (a part of one line, or an unmarked line) has at most this many words
  var LONG_CLOZE_WORDS = 30;       // long_cloze: more words than this (cues not counted)
  var LIST_SHORT_PART_WORDS = 2;   // list_answer (ii): a comma line whose parts all have at most this many words is a list
  var LIST_MANY_PARTS = 4;         // list_answer (ii): so is a line of this many parts or more, whatever joins them
  var LIST_SEMICOLONS = 2;         // list_answer (ii): and a line with this many semicolons or more
  var LIST_FORMULA_LINES = 2;      // list_answer (i): this many formula-only lines join the item lines (no sentence, no intro)
  var PLACEHOLDER = "\uFFFC";      // stands for one formula or image where text is split into lines, items or words

  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function isWs(ch) { return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v"; }

  // true when text[j] is preceded by an odd number of backslashes
  function escapedAt(text, j) {
    var n = 0, k = j - 1;
    while (k >= 0 && text[k] === "\\") { n++; k--; }
    return n % 2 === 1;
  }

  // First unescaped `close` at or after `from`; −1 when none (or when
  // sameLine and a newline comes first). `accept(j)` can reject a candidate.
  function findClose(text, from, close, sameLine, accept) {
    var nl = sameLine ? text.indexOf("\n", from) : -1;
    var j = from;
    for (;;) {
      j = text.indexOf(close, j);
      if (j < 0) return -1;
      if (nl >= 0 && nl < j) return -1;
      if (escapedAt(text, j) || (accept && !accept(j))) { j += 1; continue; }
      return j;
    }
  }

  // ---- tokenize (§16 step 1) -------------------------------------------------
  // Runs cover the whole string contiguously. Math runs: value = inner source
  // (delimiters excluded), display = true for $$…$$ and \[…\], delim = the
  // opening delimiter; start/end span the delimiters. Image runs: value = the
  // whole token, id = the attachment id. Text runs: value = the raw slice
  // (`\$` and `\{` stay as typed; the renderer shows them as `$` / `{`).
  function tokenize(text) {
    text = str(text);
    var runs = [], n = text.length, i = 0, textStart = 0;
    function flushText(upto) {
      if (upto > textStart) runs.push({ type: "text", value: text.slice(textStart, upto), start: textStart, end: upto });
    }
    function pushMath(start, end, inner, display, delim) {
      flushText(start);
      runs.push({ type: "math", value: inner, display: display, delim: delim, start: start, end: end });
      i = end; textStart = end;
    }
    while (i < n) {
      var ch = text[i];
      if (ch === "\\") {
        var nx = text[i + 1];
        if (nx === "[" || nx === "(") {
          var disp = nx === "[";
          var j = findClose(text, i + 2, disp ? "\\]" : "\\)", !disp, null);
          if (j >= 0) { pushMath(i, j + 2, text.slice(i + 2, j), disp, disp ? "\\[" : "\\("); continue; }
        }
        i += 2;                                  // escaped character (\$, \{, \\, …) stays in the text run
        continue;
      }
      if (ch === "$") {
        if (text[i + 1] === "$") {
          var j2 = findClose(text, i + 2, "$$", false, null);
          if (j2 >= 0) { pushMath(i, j2 + 2, text.slice(i + 2, j2), true, "$$"); continue; }
          i += 2;                                // unclosed "$$" is literal
          continue;
        }
        if (i + 1 < n && !isWs(text[i + 1])) {   // opening $ not followed by whitespace
          var j3 = findClose(text, i + 1, "$", true, function (j) { return j > i + 1 && !isWs(text[j - 1]); });
          if (j3 >= 0) { pushMath(i, j3 + 1, text.slice(i + 1, j3), false, "$"); continue; }
        }
        i += 1;                                  // literal dollar
        continue;
      }
      if (ch === "!" && text[i + 1] === "[") {
        IMAGE_RE.lastIndex = i;
        var m = IMAGE_RE.exec(text);
        if (m) {
          flushText(i);
          runs.push({ type: "image", value: m[0], id: m[1], start: i, end: i + m[0].length });
          i += m[0].length; textStart = i;
          continue;
        }
      }
      i += 1;
    }
    flushText(n);
    return runs;
  }

  // ---- tags (§4) ---------------------------------------------------------------
  // The final non-blank line, when it consists only of #tokens, is the tags
  // line. Returns display = text before it, trailing whitespace trimmed.
  function splitTags(text) {
    text = str(text);
    var end = text.length;
    while (end > 0 && isWs(text[end - 1])) end--;
    var lineStart = text.lastIndexOf("\n", end - 1) + 1;
    var line = text.slice(lineStart, end);
    var tags = [];
    var display;
    if (end > 0 && TAG_LINE_RE.test(line)) {
      var seen = {};
      var toks = line.match(TAG_TOKEN_RE) || [];
      for (var t = 0; t < toks.length; t++) {
        var tag = toks[t].slice(1);
        if (!seen[tag]) { seen[tag] = true; tags.push(tag); }
      }
      display = text.slice(0, lineStart).replace(/\s+$/, "");
    } else {
      display = text.replace(/\s+$/, "");
    }
    return { display: display, tags: tags };
  }

  function stripTags(text) { return splitTags(text).display; }

  // ---- cloze deletions (§4, §16 step 2) ---------------------------------------
  // Scanned over text runs only. A brace opened in text may close after a
  // math or image run (the run is then part of that one deletion); braces
  // inside math never count; `\{` and `\}` are literals; nested braces give
  // the outer span. Blank deletions ("{}" or "{ }") are ignored.
  //
  // Cue (FEATURES P1.1 a): the LAST unescaped CUE_SEP at the top level of a
  // deletion (in a text run, depth 1: not inside math, an image token or nested
  // braces) splits it into the hidden part and the cue. A backslash escapes
  // the next character as before; `\::` is one literal `::` (both colons are
  // skipped). Both parts must be non-blank after trimming, else there is no cue
  // and the deletion is as it always was. js/markup.js scanDeletions and the
  // fallback scanner in js/exporter.js follow the same rule.
  function scanDeletions(display, runs) {
    var dels = [], depth = 0, openAt = -1, sepAt = -1, L = CUE_SEP.length;
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      if (run.type !== "text") continue;
      var s = run.value, base = run.start;
      for (var k = 0; k < s.length; k++) {
        var ch = s[k];
        if (ch === "\\") { k += s.startsWith(CUE_SEP, k + 1) ? L : 1; continue; }
        if (ch === "{") {
          if (depth === 0) { openAt = base + k; sepAt = -1; }
          depth++;
        } else if (ch === "}" && depth > 0) {
          depth--;
          if (depth === 0) {
            var end = base + k + 1;
            var inner = display.slice(openAt + 1, end - 1);
            if (inner.trim()) dels.push(deletion(display, openAt, end, sepAt));
          }
        } else if (depth === 1 && s.startsWith(CUE_SEP, k)) sepAt = base + k;   // the last one wins
      }
    }
    return dels;
  }
  // {start, end, text, cue?} for the braces at [openAt, end) and the last top-level separator (−1: none).
  function deletion(display, openAt, end, sepAt) {
    var d = { start: openAt, end: end, text: display.slice(openAt + 1, end - 1) };
    if (sepAt >= 0) {
      var hidden = display.slice(openAt + 1, sepAt), cue = display.slice(sepAt + CUE_SEP.length, end - 1).trim();
      if (hidden.trim() && cue) { d.text = hidden; d.cue = cue; }
    }
    return d;
  }

  // escapeCues(text, from, to) → text in which no "::" of the text runs inside [from, to) can act as a cue
  // separator: each one that is not escaped yet is written `\::`. Math runs and image tokens are left alone
  // (a "::" inside them never separates, and a backslash would change the formula); the rest of the text is
  // untouched. The cloze commands (C in the reader, Alt+Shift+C in the editor) pass the text they have just
  // wrapped in braces, so a selection never makes an accidental cue (FEATURES P1.1 e).
  function escapeCues(text, from, to) {
    text = str(text);
    var n = text.length, L = CUE_SEP.length;
    from = typeof from === "number" && from > 0 ? Math.min(from, n) : 0;
    to = typeof to === "number" && to < n ? Math.max(to, from) : n;
    var runs = tokenize(text), out = "", pos = 0;
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      if (run.type !== "text" || run.end <= from || run.start >= to) continue;
      var s = run.value, base = run.start;
      for (var k = 0; k < s.length; k++) {                        // from the run's start, so backslash pairs line up
        if (s[k] === "\\") { k += s.startsWith(CUE_SEP, k + 1) ? L : 1; continue; }
        if (!s.startsWith(CUE_SEP, k) || base + k < from || base + k + L > to) continue;
        out += text.slice(pos, base + k) + "\\";
        pos = base + k;
        k += L - 1;                                             // the pair just escaped is one literal now
      }
    }
    return out + text.slice(pos);
  }

  // ---- parse (§4) --------------------------------------------------------------
  function parse(text) {
    text = str(text);
    var st = splitTags(text);
    var display = st.display;
    var out = { kind: "note", question: "", answer: "", body: display, deletions: [], tags: st.tags, display: display, lints: [] };
    if (!display.trim()) {
      out.kind = "highlight";
      out.body = "";
      out.lints = lint(out);
      return out;
    }
    var lines = display.split("\n");
    var qi = -1, ai = -1, l;
    for (l = 0; l < lines.length; l++) {
      if (qi < 0) { if (Q_LINE_RE.test(lines[l])) qi = l; }
      else if (A_LINE_RE.test(lines[l])) { ai = l; break; }
    }
    if (qi >= 0) {
      var qEnd = ai >= 0 ? ai : lines.length;
      var qLines = [lines[qi].replace(Q_LINE_RE, "")];
      for (l = qi + 1; l < qEnd; l++) qLines.push(lines[l]);
      out.question = qLines.join("\n").trim();
      if (ai >= 0) {
        var aLines = [lines[ai].replace(A_LINE_RE, "")];
        for (l = ai + 1; l < lines.length; l++) aLines.push(lines[l]);
        out.answer = aLines.join("\n").trim();
        out.kind = "qa";
      } else {
        out.kind = "note";                       // Q. without A. → note + lint no_answer
      }
    } else {
      var dels = scanDeletions(display, tokenize(display));
      if (dels.length) { out.kind = "cloze"; out.deletions = dels; }
      else out.kind = "note";
      out.question = display;                    // the question side of a cloze/note is its body
    }
    out.lints = lint(out);
    return out;
  }

  // ---- lints (§4; FEATURES P1.2) --------------------------------------------------
  var SEVERITY = { no_answer: 0, empty_answer: 1, yes_no: 2, either_or: 3, example_prompt: 4, list_answer: 5, long_answer: 6,
    long_question: 7, book_bound: 8, undated: 9, multi_sentence_cloze: 10, long_cloze: 11, many_deletions: 12 };

  function wordCount(s) {
    var runs = tokenize(s), n = 0;
    for (var i = 0; i < runs.length; i++) {
      if (runs[i].type === "text") n += (runs[i].value.match(/\S+/g) || []).length;
      else n += 1;                               // a formula or an image counts as one word
    }
    return n;
  }

  function plainText(s) {
    var runs = tokenize(s), parts = [];
    for (var i = 0; i < runs.length; i++) parts.push(runs[i].type === "text" ? runs[i].value : "x");
    return parts.join("");
  }

  // FIXES-1 FIX-6 g: the period of a common abbreviation (SENTENCE_ABBREVS: e.g., i.e., cf., vs., etc., Eq., Eqs., Fig.,
  // Figs., Sec., Ch., Dr., Prof., any case; and No. with a capital N) ends no sentence: "By Eq. (2.3) the {energy} is
  // quantized." is one sentence.
  var SENTENCE_ABBREVS = ["e.g", "i.e", "cf", "vs", "etc", "eq", "eqs", "fig", "figs", "sec", "ch", "dr", "prof"];
  var ABBREV_RE = new RegExp("(^|[^\\p{L}\\p{N}])(" + SENTENCE_ABBREVS.map(function (w) { return w.replace(/\./g, "\\."); }).join("|") +
    ")\\.", "giu");
  var NO_ABBREV_RE = /(^|[^\p{L}\p{N}])No\./gu;
  function isMultiSentence(body) {
    var plain = plainText(body).replace(ABBREV_RE, "$1$2").replace(NO_ABBREV_RE, "$1No");
    var pieces = plain.split(/[.!?]+\s+(?=[A-Z"'(\[“‘])/);
    var n = 0;
    for (var i = 0; i < pieces.length; i++) if (pieces[i].trim()) n++;
    return n > 1;
  }

  // The cloze body without its cues: for each deletion with a cue, the separator, the cue and the blanks before
  // the separator are cut out, so `{x :: hint}` reads `{x}`. The cloze hints look at this text (a cue's words
  // are not counted and its punctuation ends no sentence). A text without a cue comes back unchanged.
  function withoutCues(body, dels) {
    var out = "", pos = 0;
    for (var i = 0; i < dels.length; i++) {
      var d = dels[i];
      if (!d || typeof d.cue !== "string" || typeof d.text !== "string" || typeof d.start !== "number" || typeof d.end !== "number") continue;
      var cut = d.start + 1 + d.text.replace(/\s+$/, "").length;
      if (cut < pos || cut > d.end - 1 || d.end > body.length) continue;
      out += body.slice(pos, cut);
      pos = d.end - 1;
    }
    return out + body.slice(pos);
  }

  // yes_no, second half: the answer itself is yes, no, true or false (lower-cased, closing punctuation dropped).
  // FIXES-1 FIX-6 e: also an answer that starts with "yes" or "no" followed by a comma, a period or its end ("No, never",
  // "Yes. Always"); "No net force acts" is no yes/no answer.
  var YES_NO_LEAD_RE = /^(?:yes|no)(?:[,.]|$)/i;
  function isYesNoAnswer(answer) {
    var t = str(answer).trim();
    var a = t.toLowerCase().replace(/[\s.!?…,;:]+$/, "");
    return YES_NO_ANSWERS[a] === true || YES_NO_LEAD_RE.test(t);
  }

  // The words of a prompt side for matching: lower case, apostrophes dropped, every other character that is not a
  // letter, a digit or a combining mark read as a blank, and each formula or image as one word of its own (two
  // formulas are the same word only when their source is the same, blanks aside; two images when their id is).
  var APOSTROPHE_RE = /['’ʼ]/g;
  var NOT_WORD_RE = /[^\p{L}\p{M}\p{N}\s]/gu;
  function normWords(s) {
    var runs = tokenize(s), words = [];
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      if (run.type === "math") { words.push("$" + run.value.replace(/\s+/g, "")); continue; }
      if (run.type === "image") { words.push("!" + run.id); continue; }
      var parts = run.value.toLowerCase().replace(APOSTROPHE_RE, "").replace(NOT_WORD_RE, " ").split(/\s+/);
      for (var j = 0; j < parts.length; j++) if (parts[j]) words.push(parts[j]);
    }
    return words;
  }
  function hasPhrase(words, phrase) {
    for (var i = 0; i + phrase.length <= words.length; i++) {
      var j = 0;
      while (j < phrase.length && words[i + j] === phrase[j]) j++;
      if (j === phrase.length) return true;
    }
    return false;
  }
  // either_or: the answer (1 to EITHER_OR_WORDS words) stands in the question as a whole-word phrase, and the
  // question holds the word "or".
  function offersAnswer(question, answer) {
    var a = normWords(answer);
    if (!a.length || a.length > EITHER_OR_WORDS) return false;
    var q = normWords(question);
    return q.indexOf("or") >= 0 && hasPhrase(q, a);
  }

  // list_answer: how many items the answer lists, 0 when it is no list of LIST_MIN_ITEMS or more. Each formula and
  // image is first replaced by one placeholder word, so a line break, a comma or an "and" inside math never splits.
  // (i) several non-blank lines: a line is an item when it starts with a list marker ("- ", "* ", "• ", "1. ",
  // "a) "), or has at most LIST_ITEM_WORDS words, does not end with a colon (an intro such as "Ingredients:") and is
  // more than a formula or image alone. LIST_MIN_ITEMS or more such lines are a list. So are LIST_MIN_ITEMS or more
  // lines that are each one formula or image, when no line is an item of words (a list of equations). A sentence, a
  // formula and a second sentence are therefore no list. When no line is a sentence or an intro and at least
  // LIST_FORMULA_LINES lines are a formula alone, those lines count as items too (FIXES-1 FIX-6 c: "$V(x)$" /
  // "$\Psi(x,0)$" / "boundary conditions" is a list of 3). (ii) exactly one non-blank line that splits into
  // LIST_MIN_ITEMS or more non-blank parts at semicolons, commas (not a comma between two digits, as in 1,000),
  // " and " and " or ", each part of at most LIST_ITEM_WORDS words, and (FIXES-1 FIX-6 b) whose last joint is " and " or
  // " or ", or which holds LIST_SEMICOLONS or more semicolons (one semicolon joins two clauses: "Uniform inside, $x$; a
  // dipole outside" is no list), or whose parts all have at most LIST_SHORT_PART_WORDS words, or which has
  // LIST_MANY_PARTS or more parts (four law names with commas are a list).
  function flatText(s) {
    var runs = tokenize(s), out = "";
    for (var i = 0; i < runs.length; i++) out += runs[i].type === "text" ? runs[i].value : " " + PLACEHOLDER + " ";
    return out;
  }
  function isDigit(ch) { return ch >= "0" && ch <= "9"; }
  // → {parts, lastJoint, semicolon}: the non-blank parts of one line, the joint before its last part ("andor" when an
  // " and " or " or " stands there, also after a comma as in "a, b, and c"; else "," or ";"), and whether a semicolon split it.
  function listParts(line) {
    var chunks = [], seps = [], cur = "", i, j, semicolon = false, semicolons = 0;
    for (i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === ";" || (ch === "," && !(isDigit(line[i - 1]) && isDigit(line[i + 1])))) {
        chunks.push(cur); seps.push(ch); cur = "";
        if (ch === ";") { semicolon = true; semicolons++; }
      }
      else cur += ch;
    }
    chunks.push(cur);
    var parts = [], pending = [], lastJoint = null;
    for (i = 0; i < chunks.length; i++) {
      if (i > 0) pending.push(seps[i - 1]);
      var sub = chunks[i].split(/\s(?:and|or)\s/i);
      for (j = 0; j < sub.length; j++) {
        if (j > 0) pending.push("andor");
        if (!sub[j].trim()) continue;
        if (parts.length) lastJoint = pending.indexOf("andor") >= 0 ? "andor" : pending.indexOf(";") >= 0 ? ";" : ",";
        pending = [];
        parts.push(sub[j].trim());
      }
    }
    return { parts: parts, lastJoint: lastJoint, semicolon: semicolon, semicolons: semicolons };
  }
  var LIST_MARKER_RE = /^\s*(?:[-*\u2022\u2013]|\d{1,2}[.)]|[a-z][.)])\s+\S/i;
  function listItems(answer) {
    var all = flatText(answer).split("\n"), lines = [], i;
    for (i = 0; i < all.length; i++) if (all[i].trim()) lines.push(all[i]);
    if (lines.length > 1) {
      var words = 0, alone = 0, other = 0;      // items of words; lines that are one formula or image alone; the rest
      for (i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (LIST_MARKER_RE.test(t)) words++;
        else if (t === PLACEHOLDER) alone++;
        else if (t.charAt(t.length - 1) !== ":" && (t.match(/\S+/g) || []).length <= LIST_ITEM_WORDS) words++;
        else other++;                           // a sentence or an intro line
      }
      // FIXES-1 FIX-6 c: no sentence and no intro, and at least LIST_FORMULA_LINES lines a formula alone: those count too
      if (other === 0 && alone >= LIST_FORMULA_LINES && words + alone >= LIST_MIN_ITEMS) return words + alone;
      if (words >= LIST_MIN_ITEMS) return words;
      return words === 0 && alone >= LIST_MIN_ITEMS ? alone : 0;
    }
    if (lines.length !== 1) return 0;
    var split = listParts(lines[0]), parts = split.parts, short = true;
    if (parts.length < LIST_MIN_ITEMS) return 0;
    for (i = 0; i < parts.length; i++) {
      var n = (parts[i].match(/\S+/g) || []).length;
      if (n > LIST_ITEM_WORDS) return 0;
      if (n > LIST_SHORT_PART_WORDS) short = false;
    }
    // FIXES-1 FIX-6 b: a comma sentence ("The electric field, not the potential, is discontinuous") is no list: the last
    // joint is " and " / " or ", or the line holds a semicolon, or every part is short
    if (split.lastJoint !== "andor" && split.semicolons < LIST_SEMICOLONS && !short && parts.length < LIST_MANY_PARTS) return 0;
    return parts.length;
  }

  // ---- FEATURES P2.1: example_prompt, book_bound, undated ------------------------------------------------
  // example_prompt (qa): the question asks for examples. Over the question's words (normWords: lower case,
  // punctuation removed, each formula one word), "example" or "examples" comes at the start of the question or after
  // a trigger (EXAMPLE_TRIGGERS: give, name, list, state, provide, "what is", "what are") with at most EXAMPLE_GAP
  // words between, none of them in EXAMPLE_BREAKS (articles that point at one thing, prepositions, question words,
  // forms of be / do). An article or a number word between is no break (FIXES-1 FIX-6 f: "Give the standard example of
  // …" fires). So "Name an example of a stock", "Give two examples of …", "What are examples of …" fire, and
  // "In which example does …", "What is the force in the example above?" do not.
  var EXAMPLE_TRIGGERS = [["give"], ["name"], ["list"], ["state"], ["provide"], ["what", "is"], ["what", "are"]];
  var EXAMPLE_GAP = 3;
  var EXAMPLE_BREAKS = toSet("this that these those in on at of from for with by to into about under over as is are " +
    "was were be been does do did which what where when why how and or if it its not");
  function toSet(s) { var o = {}; s.split(/\s+/).forEach(function (w) { if (w) o[w] = true; }); return o; }
  function isExampleWord(w) { return w === "example" || w === "examples"; }
  function examplesAfter(words, from) {
    for (var k = from; k < words.length && k <= from + EXAMPLE_GAP; k++) {
      if (isExampleWord(words[k])) return true;
      if (EXAMPLE_BREAKS[words[k]]) return false;
    }
    return false;
  }
  // A possessive ("the example's assumption", "the examples' feature") names the word in another role: it is read as a
  // different word, so dropping "the" from EXAMPLE_BREAKS (FIXES-1 FIX-6 f) does not make it fire.
  var EXAMPLE_POSSESSIVE_RE = /\b(examples?)['’ʼ](?:s\b)?/gi;
  function asksForExamples(question) {
    var words = normWords(str(question).replace(EXAMPLE_POSSESSIVE_RE, "$1possessive"));
    if (!words.length) return false;
    if (examplesAfter(words, 0)) return true;            // "Examples of …?", "Two examples of …?"
    for (var i = 0; i < words.length; i++) {
      for (var t = 0; t < EXAMPLE_TRIGGERS.length; t++) {
        var trig = EXAMPLE_TRIGGERS[t], j = 0;
        while (j < trig.length && words[i + j] === trig[j]) j++;
        if (j === trig.length && examplesAfter(words, i + j)) return true;
      }
    }
    return false;
  }

  // Runs a global, case-insensitive regular expression over the text runs of `s` (never inside math or an image
  // token) and returns the first match by position, as typed: braces dropped, blanks collapsed. Braces read as
  // blanks while matching (offsets stay), so "the {author}" in a cloze matches "the author".
  function firstInText(s, re) {
    var runs = tokenize(s);
    for (var i = 0; i < runs.length; i++) {
      if (runs[i].type !== "text") continue;
      var v = runs[i].value;
      re.lastIndex = 0;
      var m = re.exec(v.replace(/[{}]/g, " "));
      if (m) return v.slice(m.index, m.index + m[0].length).replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
    }
    return null;
  }

  // book_bound (qa: the question; cloze: the body): wording that only makes sense beside the source.
  // - "this" + BOOK_NOUNS (chapter, section, book, paper, article, text, passage, author, authors); "the" + chapter,
  //   author, authors; "the" + one of BOOK_LOOSE (section, book, paper, article, text, passage: words that also name
  //   things, as in "a force on the book" or "the section of a cone") only as a reference: after BOOK_PREPS (in,
  //   from, according to, as in, throughout), before a verb of saying (BOOK_VERBS: say, state, call, define, …, with
  //   or without -s/-es) or as a possessive ("the article's thesis");
  // - "the following", "the previous", "earlier in";
  // - "above" / "below" used as a reference: after "the", after a word that names a part of a text (REF_NOUNS:
  //   equation, figure, example, …) or after a verb of showing (REF_VERBS: see, as, shown, given, …). "The energy
  //   above the gap", "below $T_c$" and "from above" are physics, not references, and do not fire; nor does "above" or
  //   "below" before a hyphen ("the above-barrier …") or after "cross section" (FIXES-1 FIX-6 d);
  // - in / from + "the" + figure, diagram, table, example or problem; "the" + last, next or following + chapter or
  //   section (FIXES-1 FIX-6 d);
  // - a numbered reference: Figure / Fig. / Table / Equation / Eqn. / Eq. / Section / Sec. / Chapter / Ch. / page / p. /
  //   pg. / Example / Problem / Prob. / Exercise (and their plurals) + a number, also in parentheses ("Eq. (1.5)",
  //   "Fig. 2.3", "p. 12", "Eq. (A.3)", "Example 2.6", "Sec. 4.3"); a bare number may end in one letter ("Figure 3a")
  //   but must not run on into a further letter or an operator ("the equation 2x = 4" does not fire).
  // Whole words, any case, never inside math. A named source ("according to Griffiths") does not fire.
  var BOOK_NOUNS = "chapter|section|book|paper|article|text|passage|author|authors";
  var BOOK_LOOSE = "section|book|paper|article|text|passage";
  var BOOK_PREPS = "in|from|according\\s+to|as\\s+in|throughout";
  var BOOK_VERBS = "(?:say|state|claim|argue|define|show|give|use|call|describe|derive|mention|note|explain|introduce|" +
    "prove|discuss|present|assume|conclude|suggest|mean|measure|report|find|propose|write|refer|list|cover|treat|" +
    "contain|include)(?:es|s)?";
  var REF_NOUNS = "equation|equations|eqn\\.|eq\\.|expression|formula|figure|fig\\.|diagram|table|example|examples|passage|" +
    "paragraph|sentence|section|chapter|text|list|definition|result|derivation|argument|discussion|statement|quote|" +
    "quotation|proof|problem|exercise|graph|plot|sketch";
  var REF_VERBS = "see|as|shown|given|described|mentioned|defined|discussed|derived|stated|listed|quoted|cited|noted|" +
    "explained|introduced|presented|outlined|illustrated|depicted|written|displayed";
  var REF_LABELS = "figures?|figs?\\.?|tables?|equations?|eqns?\\.?|eqs?\\.?|sections?|secs?\\.|chapters?|chs?\\.|pages?|pp?\\.|pg\\.|" +
    "examples?|problems?|prob\\.|exercises?";
  // A bare number may end in one letter ("Figure 3a", "Eq. 2.4b") when no word character and no operator follows it, so
  // "the equation 2x = 4" stays without a hint (FIXES-1 FIX-8 f).
  var REF_NUMBER = "(?:\\(\\s*(?:[a-z]\\.)?\\d+(?:[.\\-–]\\d+)*[a-z]?\\s*\\)|(?:[a-z]\\.)?\\d+(?:[.\\-–]\\d+)*" +
    "(?:[a-z](?![\\w=+*/^]|\\s*[=+\\-*/^<>]))?(?![\\w=+*/^]))";
  var REF_IN_NOUNS = "figure|diagram|table|example|problem";   // in / from + the + one of these (FIXES-1 FIX-6 d)
  var BOOK_BOUND_RE = new RegExp(
    "\\b(?:this\\s+(?:" + BOOK_NOUNS + ")\\b" +
    "|the\\s+(?:chapter|authors?)\\b" +
    "|(?:" + BOOK_PREPS + ")\\s+the\\s+(?:" + BOOK_LOOSE + ")\\b" +
    "|the\\s+(?:" + BOOK_LOOSE + ")(?=['\u2019]s\\b|\\s+" + BOOK_VERBS + "\\b)" +
    "|(?:in|from)\\s+the\\s+(?:" + REF_IN_NOUNS + ")\\b" +
    "|the\\s+(?:last|next|following)\\s+(?:chapter|section)\\b" +
    "|the\\s+following\\b|the\\s+previous\\b|earlier\\s+in\\b" +
    "|(?<!\\bcross[\\s-]+)(?:the|" + REF_NOUNS + "|" + REF_VERBS + ")\\s+(?:above|below)\\b(?!-)" +
    "|(?:" + REF_LABELS + ")\\s*" + REF_NUMBER + ")", "gi");

  // undated (qa: question and answer; cloze: the body): a word that will age (UNDATED_WORDS), whole words, any case,
  // never inside math, while the prompt's text holds no year (YEAR_RE: a 4-digit number from YEAR_MIN to YEAR_MAX,
  // not part of a longer number or a decimal).
  // FIXES-1 FIX-6 a: "so far" does not fire before from, away, as, that, beyond or out (SO_FAR_NOT_BEFORE), nor after
  // "in" ("in so far as"); "latest", "newest", "most recent" and "most recently" (UNDATED_BEFORE_NOUN) fire only directly
  // before a word of UNDATED_NOUNS ("the latest measurement", not "the latest time"); "recently" right after "most" is
  // that phrase, not the word alone.
  var UNDATED_WORDS = ["most recently", "most recent", "currently", "nowadays", "at present", "latest", "newest", "recently",
    "so far", "to date", "this year", "last year", "state of the art", "state-of-the-art", "as of now"];
  var UNDATED_BEFORE_NOUN = ["most recently", "most recent", "latest", "newest"];
  var UNDATED_NOUNS = ["measurement", "measurements", "value", "values", "result", "results", "data", "experiment",
    "experiments", "record", "records", "model", "models", "estimate", "estimates", "version", "versions", "edition",
    "editions", "findings", "limit", "limits", "bound", "bounds"];
  var SO_FAR_NOT_BEFORE = ["from", "away", "as", "that", "beyond", "out"];
  function wordsRe(list) { return list.map(function (w) { return w.replace(/ /g, "\\s+"); }).join("|"); }
  var UNDATED_RE = new RegExp("\\b(?:" +
    "(?:" + wordsRe(UNDATED_BEFORE_NOUN) + ")\\b(?=\\s+(?:" + UNDATED_NOUNS.join("|") + ")\\b)" +
    "|(?<!\\bin\\s+)so\\s+far\\b(?!\\s+(?:" + SO_FAR_NOT_BEFORE.join("|") + ")\\b)" +
    "|(?<!\\bmost\\s+)recently\\b" +
    "|(?:" + wordsRe(UNDATED_WORDS.filter(function (w) {
      return UNDATED_BEFORE_NOUN.indexOf(w) < 0 && w !== "so far" && w !== "recently";
    })) + ")\\b)", "gi");
  var YEAR_MIN = 1500, YEAR_MAX = 2199;
  var YEAR_RE = /(?<![\d.,])\d{4}(?![\d]|[.,]\d)/g;
  function holdsYear(s) {
    var m;
    YEAR_RE.lastIndex = 0;
    while ((m = YEAR_RE.exec(s))) { var y = +m[0]; if (y >= YEAR_MIN && y <= YEAR_MAX) return true; }
    return false;
  }
  function yearOf(now) {
    var t = typeof now === "number" && isFinite(now) ? now : (now instanceof Date ? now.getTime() : Date.now());
    var y = new Date(t).getFullYear();
    return isFinite(y) ? y : new Date().getFullYear();
  }

  function lint(parsed, now) {
    var out = [];
    if (!parsed || typeof parsed !== "object") return out;
    var kind = parsed.kind;
    var body = str(parsed.body || parsed.display);
    var question = str(parsed.question), answer = str(parsed.answer);
    if (kind === "note" && Q_LINE_ANYWHERE_RE.test(body)) {      // a Q. line that never got its A.
      out.push({ code: "no_answer", msg: "Add an A. line to make this reviewable" });
    }
    if (kind === "qa") {
      if (!answer.trim()) out.push({ code: "empty_answer", msg: "The answer is empty" });
      // FIXES-1 FIX-3: either_or first. When the question offers the answer as a choice and the answer is no yes / no /
      // true / false, the hint is either_or, also for a question that starts with a yes/no word ("Are electrons bosons
      // or fermions?" / "Fermions"). yes_no only when either_or does not hold; never both.
      var yesNoAnswer = isYesNoAnswer(answer);
      if (!yesNoAnswer && offersAnswer(question, answer)) out.push({ code: "either_or", msg: "The question offers the answer as a choice — ask for the fact itself" });
      else if (yesNoAnswer || YES_NO_RE.test(question.trim())) out.push({ code: "yes_no", msg: "Yes/no questions are easy to guess — ask for the fact itself" });
      if (asksForExamples(question)) out.push({ code: "example_prompt", msg: "Example questions train one remembered instance — also ask from an instance to the idea" });
      var items = listItems(answer);
      if (items) out.push({ code: "list_answer", msg: "The answer is a list of " + items + " items — a whole list is hard to recall; make one {blank} per item" });
      var aw = wordCount(answer);
      if (aw > LONG_ANSWER_WORDS) out.push({ code: "long_answer", msg: "Long answer (" + aw + " words) — split it into several prompts" });
      var qw = wordCount(question);
      if (qw > LONG_QUESTION_WORDS) out.push({ code: "long_question", msg: "Long question (" + qw + " words) — shorter prompts are easier to recall" });
    }
    if (kind === "cloze") {
      var dels = Array.isArray(parsed.deletions) ? parsed.deletions : [];
      var bare = withoutCues(body, dels);
      if (isMultiSentence(bare)) out.push({ code: "multi_sentence_cloze", msg: "Several sentences in one cloze — one sentence per prompt reviews better" });
      else {
        var cw = wordCount(bare);
        if (cw > LONG_CLOZE_WORDS) out.push({ code: "long_cloze", msg: "Long cloze (" + cw + " words) — keep only the words around the blank" });
      }
      if (dels.length >= MANY_DELETIONS) out.push({ code: "many_deletions", msg: "Makes " + dels.length + " cards" });
    }
    if (kind === "qa" || kind === "cloze") {
      var bound = firstInText(kind === "qa" ? question : body, BOOK_BOUND_RE);
      if (bound) out.push({ code: "book_bound", msg: "The wording points into the book (“" + bound + "”) — phrase it so it stands alone" });
      var sides = kind === "qa" ? [question, answer] : [body], aged = null;
      for (var si = 0; si < sides.length && !aged; si++) aged = firstInText(sides[si], UNDATED_RE);
      if (aged && !holdsYear(sides.join("\n"))) {
        out.push({ code: "undated", msg: "“" + aged + "” will age — add a date (for example “as of " + yearOf(now) + "”)" });
      }
    }
    out.sort(function (a, b) { return SEVERITY[a.code] - SEVERITY[b.code]; });   // worst first
    return out;
  }

  // ---- batch (§14) -------------------------------------------------------------
  // Blank lines separate blocks; a "# Section" line sets the section for the
  // blocks that follow (and ends the current block). Each block is parsed.
  function parseBatch(text) {
    var lines = str(text).split("\n"), blocks = [], section = null, cur = [];
    function flush() {
      if (!cur.length) return;
      var t = cur.join("\n");
      blocks.push({ text: t, section: section, parsed: parse(t) });
      cur = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].replace(/\r$/, "");
      if (!ln.trim()) { flush(); continue; }
      var m = SECTION_LINE_RE.exec(ln);
      if (m) { flush(); section = m[1].trim(); continue; }
      cur.push(ln);
    }
    flush();
    return blocks;
  }

  // ---- cards under edits (§4) ---------------------------------------------------
  function normHidden(s) { return str(s).trim().replace(/\s+/g, " "); }
  function indexOfCard(card, pos) { return (card && typeof card.i === "number") ? card.i : pos; }
  function withIndex(card, i) { return Object.assign({}, card, { i: i }); }

  function reconcileCards(prompt, parsed, now) {
    var existing = (prompt && Array.isArray(prompt.cards)) ? prompt.cards.filter(function (c) { return !!c; }) : [];
    var kind = parsed && parsed.kind;
    var scheduler = dep("scheduler");
    function fresh(i) { return Object.assign({ i: i }, scheduler.newSchedule(now)); }
    var cards, dropped, e, k;

    if (kind === "cloze") {
      var oldDels = [];
      if (prompt && typeof prompt.text === "string") {
        var old = parse(prompt.text);
        if (old.kind === "cloze") oldDels = old.deletions;
      }
      var oldKeys = existing.map(function (c, pos) {
        var d = oldDels[indexOfCard(c, pos)];
        return d ? normHidden(d.text) : null;
      });
      var used = existing.map(function () { return false; });
      var dels = Array.isArray(parsed.deletions) ? parsed.deletions : [];
      cards = new Array(dels.length);
      for (k = 0; k < dels.length; k++) {                       // 1. hidden-text equality
        var key = normHidden(dels[k].text);
        for (e = 0; e < existing.length; e++) {
          if (!used[e] && oldKeys[e] !== null && oldKeys[e] === key) { cards[k] = withIndex(existing[e], k); used[e] = true; break; }
        }
      }
      for (k = 0; k < dels.length; k++) {                       // 2. same index for the remainder
        if (cards[k]) continue;
        for (e = 0; e < existing.length; e++) {
          if (!used[e] && indexOfCard(existing[e], e) === k) { cards[k] = withIndex(existing[e], k); used[e] = true; break; }
        }
      }
      for (k = 0; k < dels.length; k++) if (!cards[k]) cards[k] = fresh(k);   // 3. new deletions
      dropped = existing.filter(function (c, pos) { return !used[pos]; });
      return { cards: cards, dropped: dropped };
    }

    if (kind === "qa") {
      var keep = -1;
      for (e = 0; e < existing.length; e++) if (indexOfCard(existing[e], e) === 0) { keep = e; break; }
      if (keep < 0 && existing.length) keep = 0;
      cards = [keep >= 0 ? withIndex(existing[keep], 0) : fresh(0)];
      dropped = existing.filter(function (c, pos) { return pos !== keep; });
      return { cards: cards, dropped: dropped };
    }

    // note / highlight: cards persist on the record through kind changes;
    // reviewability is decided by `kind` alone.
    return { cards: existing.slice(), dropped: [] };
  }

  // ---- images (§15) --------------------------------------------------------------
  function imageIds(text) {
    var runs = tokenize(text), ids = [], seen = {};
    for (var i = 0; i < runs.length; i++) {
      if (runs[i].type === "image" && !seen[runs[i].id]) { seen[runs[i].id] = true; ids.push(runs[i].id); }
    }
    return ids;
  }

  var api = {
    tokenize: tokenize, parse: parse, parseBatch: parseBatch, lint: lint,
    reconcileCards: reconcileCards, imageIds: imageIds, stripTags: stripTags,
    escapeCues: escapeCues,
    CUE_SEP: CUE_SEP, LONG_ANSWER_WORDS: LONG_ANSWER_WORDS, LONG_QUESTION_WORDS: LONG_QUESTION_WORDS,
    MANY_DELETIONS: MANY_DELETIONS, EITHER_OR_WORDS: EITHER_OR_WORDS, LIST_MIN_ITEMS: LIST_MIN_ITEMS,
    LIST_ITEM_WORDS: LIST_ITEM_WORDS, LONG_CLOZE_WORDS: LONG_CLOZE_WORDS,
    EXAMPLE_GAP: EXAMPLE_GAP, YEAR_MIN: YEAR_MIN, YEAR_MAX: YEAR_MAX, UNDATED_WORDS: UNDATED_WORDS.slice(),
    UNDATED_NOUNS: UNDATED_NOUNS.slice(), LIST_SHORT_PART_WORDS: LIST_SHORT_PART_WORDS, LIST_MANY_PARTS: LIST_MANY_PARTS, LIST_SEMICOLONS: LIST_SEMICOLONS, LIST_FORMULA_LINES: LIST_FORMULA_LINES,
    EXAMPLE_TRIGGERS: EXAMPLE_TRIGGERS.map(function (t) { return t.join(" "); })
  };
  M.prompts = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.prompts): tokenize(text) → [{type: "text"|"math"|"image", value, display?, id?,
 * start, end}]; parse(text) → {kind, question, answer, body, deletions: [{start, end, text, cue?}], tags, display,
 * lints: [{code, msg}]}; parseBatch(text) → [{text, section, parsed}]; lint(parsed, now) → Lint[];
 * reconcileCards(prompt, parsed, now) → {cards, dropped}; imageIds(text) → string[]; stripTags(text) → string.
 * Extras: math runs also carry `delim` ("$$", "\\[", "\\(", "$").
 * FEATURES P1.1 (cues): a deletion's `text` is the hidden part as typed and `cue` the trimmed cue (absent when
 * there is none); the separator is the last unescaped CUE_SEP ("::") at the top level of the deletion, `\::` is a
 * literal `::`, and a blank hidden part or cue means no cue. reconcileCards matches cards by the hidden part only.
 * escapeCues(text, from, to) → string writes every unescaped "::" of the text runs in [from, to) as `\::` (the
 * cloze commands). Constants: CUE_SEP, LONG_ANSWER_WORDS 15, LONG_QUESTION_WORDS 25, MANY_DELETIONS 3,
 * EITHER_OR_WORDS 6, LIST_MIN_ITEMS 3, LIST_ITEM_WORDS 5, LONG_CLOZE_WORDS 30.
 * FEATURES P1.2 (hints), worst first: no_answer, empty_answer, yes_no (also has/have/had/will/would/should/could/
 * must, and an answer that is yes/no/true/false), either_or (never with yes_no), list_answer, long_answer,
 * long_question, multi_sentence_cloze, long_cloze (never with multi_sentence_cloze; cues not counted),
 * many_deletions.
 * FEATURES P2.1: lint(parsed, now) — `now` (ms or Date, default the clock) gives the year in undated's message.
 * New codes: example_prompt (qa; EXAMPLE_TRIGGERS, EXAMPLE_GAP 3, EXAMPLE_BREAKS), book_bound (qa: question, cloze: body;
 * BOOK_BOUND_RE: this + BOOK_NOUNS, the + chapter/author(s), the + BOOK_LOOSE only after BOOK_PREPS, before BOOK_VERBS or as a
 * possessive, the following, the previous, earlier in, above/below as a reference, numbered
 * references), undated (qa: question and answer, cloze: body; UNDATED_WORDS, silenced by a year YEAR_MIN 1500 to
 * YEAR_MAX 2199). Order worst first: no_answer, empty_answer, yes_no, either_or, example_prompt, list_answer,
 * long_answer, long_question, book_bound, undated, multi_sentence_cloze, long_cloze, many_deletions. Extra exports:
 * EXAMPLE_GAP, YEAR_MIN, YEAR_MAX, UNDATED_WORDS (a copy). Text in math or image tokens never fires them.
 * FIXES-1 (2026-11-11): either_or before yes_no (FIX-3); yes_no also for an answer "yes"/"no" + comma, period or end
 * (FIX-6 e); undated narrowed (UNDATED_NOUNS after latest / newest / most recent(ly); "so far" not before from, away, as,
 * that, beyond, out, nor after "in"); list_answer (ii) needs a last joint and / or, a semicolon or parts of at most
 * LIST_SHORT_PART_WORDS 2 words, (i) counts formula lines too when no line is a sentence or an intro and at least
 * LIST_FORMULA_LINES 2 are formulas; book_bound: Example, Problem, Exercise, Sec., Ch., pg., Prob. labels, a trailing
 * letter ("Figure 3a"), in / from the figure / diagram / table / example / problem, the last / next / following chapter /
 * section, no above / below before a hyphen or after "cross section"; example_prompt: an article is no break;
 * multi_sentence_cloze: an abbreviation's period (SENTENCE_ABBREVS) ends no sentence. Extra exports: UNDATED_NOUNS,
 * LIST_SHORT_PART_WORDS, LIST_MANY_PARTS 4 (a line of four or more parts is a list), LIST_SEMICOLONS 2 (so is a line with
 * two or more semicolons; one semicolon is not enough), LIST_FORMULA_LINES, EXAMPLE_TRIGGERS (phrases). */
