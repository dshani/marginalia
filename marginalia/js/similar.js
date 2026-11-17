/* Marginalia — js/similar.js
 * M.similar (FEATURES P2.4, BUILD-NOTES "Prompt craft"): look-alike prompts. Pure: no DOM, no storage; loads in node.
 * The only dependency is M.prompts (parse, tokenize), resolved through dep().
 *
 * Two prompts look alike when the words of their asking sides overlap a lot: such prompts interfere in review (the
 * answer of one comes to mind for the other). Nothing here blocks anything; the prompt list and the editor only inform.
 *
 * - words(text) → the comparison words of a prompt's asking side, each once, in order of first appearance: for a Q./A.
 *   prompt the question; for a cloze the whole body with braces and cues removed (each deletion reads as its hidden
 *   part); [] for notes and highlights. Text runs: lower case, apostrophes (' ’ ʼ) dropped, every other character that is
 *   not a letter, digit or combining mark reads as a blank. Each math run is one word, "$" + its source without blanks
 *   (case kept: E and e are different symbols). Images are ignored. Words of STOP_WORDS are dropped. No stemming.
 * - score(a, b) → |A∩B| / |A∪B| over the two word sets (0 when either is empty); a and b are prompt texts or word lists.
 * - alike(a, b) → score >= MIN_SCORE and |A∩B| >= MIN_SHARED.
 * - pairs(prompts, ignored) → [{a, b, score}] for live Q./A. and cloze prompts (deletedAt null or absent): every
 *   unordered pair that is alike and whose key(a, b) is not in `ignored` (an array, a Set or null); a < b; sorted by
 *   score (highest first), then key. Prompts are indexed by word and only prompts that share a word are compared.
 *   At most MAX_PAIRS pairs are reported: a collection of look-alike questions from one template ("What is the
 *   capital of X?" two thousand times) has a pair for every two prompts, and the list must stay fast and small. The
 *   search stops at that number, so such a collection gets the first MAX_PAIRS pairs found (review safety F1).
 * - nearest(text, prompts, exceptId, ignored) → the most alike live Q./A. or cloze prompt for `text` (alike as above),
 *   or null; never the prompt `exceptId`, never a prompt whose key(exceptId, id) is in `ignored`. Ties: the higher score,
 *   then more shared words, then the earlier prompt.
 * - key(idA, idB) → the two ids sorted and joined with "|".
 * - oneLine(text, max) → the asking side of a prompt as one plain line of at most `max` characters (default
 *   ONE_LINE_CHARS), cut with "…" (math as typed, images as "[image]", a cloze's braces and cues removed with no blank
 *   added where a blank stood, so "{density}." reads "density."; `\::` reads "::"; FIXES-1 FIX-4).
 * - FIXES-1 FIX-7 b: two cloze prompts whose bodies are the same once braces and cues are removed (blanks collapsed) and
 *   whose sets of hidden parts differ are not alike: pairs() and nearest() skip them. Same sentence, same blanks: still
 *   a pair (a duplicate). STOP_WORDS also hold conjunctions, pronouns, modal verbs and a few adverbs (FIX-7 a).
 *
 * words() remembers the words of the last WORDS_MEMO_MAX texts (a plain cache keyed by the text: same text, same words),
 * so a list or an editor that asks again for unchanged prompts does not parse them again.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }

  var MIN_SCORE = 0.6;          // Jaccard index of the two word sets
  var MIN_SHARED = 3;           // and at least this many shared words
  var MAX_PAIRS = 5000;         // pairs() reports at most this many pairs and stops searching there
  var ONE_LINE_CHARS = 90;      // the "≈" line and the editor's note cut the other prompt's question here
  var WORDS_MEMO_MAX = 10000;   // texts whose words are remembered (the memo starts over when full)
  var KEY_SEP = "|";

  // A short English list (FEATURES P2.4): articles; forms of be, do and have; prepositions; question words.
  var STOP_WORDS = [
    "a", "an", "the",
    "be", "am", "is", "are", "was", "were", "been", "being", "isnt", "arent", "wasnt", "werent",
    "do", "does", "did", "done", "doing", "dont", "doesnt", "didnt",
    "have", "has", "had", "having", "havent", "hasnt", "hadnt",
    "about", "above", "across", "after", "against", "along", "among", "around", "as", "at", "before", "behind", "below",
    "beneath", "beside", "besides", "between", "beyond", "by", "despite", "down", "during", "except", "for", "from", "in",
    "inside", "into", "near", "of", "off", "on", "onto", "out", "outside", "over", "past", "per", "since", "through",
    "throughout", "till", "to", "toward", "towards", "under", "underneath", "until", "up", "upon", "via", "with", "within",
    "without",
    "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "whats", "whys", "hows",
    // FIXES-1 FIX-7 a: conjunctions, pronouns, modal verbs and a few adverbs
    "and", "or", "but", "nor", "not", "it", "its", "this", "that", "these", "those", "than", "then", "so", "if", "can",
    "will", "must", "may", "would", "should", "could", "we", "you", "they", "their", "there", "here", "also", "only"
  ];
  var STOP = Object.create(null);
  STOP_WORDS.forEach(function (w) { STOP[w] = true; });

  var APOSTROPHE_RE = /['’ʼ]/g;
  var NOT_WORD_RE = /[^\p{L}\p{M}\p{N}\s]/gu;
  var REVIEWABLE = { qa: true, cloze: true };

  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function prompts() { return dep("prompts"); }
  function live(p) { return !!p && typeof p === "object" && (p.deletedAt === null || p.deletedAt === undefined); }

  // The asking side of a parsed prompt as text: the question, or the cloze body with each deletion replaced by its
  // hidden part (braces and cue gone). null for notes and highlights. `pad` puts a blank on each side of a hidden part
  // (for words(): "a{b}c" gives three words); without it the line reads as typed ("{density}." → "density.", FIX-4).
  // A hidden part before a cue loses its trailing blanks ("{x :: hint}" reads "x").
  function hiddenOf(d) { var t = str(d.text); return typeof d.cue === "string" ? t.replace(/\s+$/, "") : t; }
  function askingSide(parsed, pad) {
    if (!parsed || !REVIEWABLE[parsed.kind]) return null;
    if (parsed.kind === "qa") return str(parsed.question);
    var body = str(parsed.body), dels = Array.isArray(parsed.deletions) ? parsed.deletions : [], out = "", pos = 0;
    var gap = pad === false ? "" : " ";
    for (var i = 0; i < dels.length; i++) {
      var d = dels[i];
      if (!d || typeof d.start !== "number" || typeof d.end !== "number" || d.start < pos || d.end > body.length) continue;
      out += body.slice(pos, d.start) + gap + hiddenOf(d) + gap;
      pos = d.end;
    }
    return out + body.slice(pos);
  }
  // FIX-7 b: a cloze prompt's sentence (its body without braces and cues, blanks collapsed) and its set of hidden parts.
  function clozeShape(parsed) {
    var dels = Array.isArray(parsed.deletions) ? parsed.deletions : [], seen = Object.create(null), hidden = [];
    dels.forEach(function (d) {
      var h = d ? hiddenOf(d).trim().replace(/\s+/g, " ") : "";
      if (!seen[h]) { seen[h] = true; hidden.push(h); }
    });
    hidden.sort();
    return { sentence: str(askingSide(parsed, false)).replace(/\s+/g, " ").trim(), hidden: JSON.stringify(hidden) };
  }
  // Two cloze prompts of the same sentence with different blanks ask different things: they are no look-alikes.
  // (Same sentence and same blanks: a duplicate, still alike. Q./A. prompts never take this path.)
  function sameSentenceOtherBlanks(x, y) {
    return !!(x.shape && y.shape) && x.shape.sentence === y.shape.sentence && x.shape.hidden !== y.shape.hidden;
  }

  var memo = new Map();
  function remember(text, value) {
    if (memo.size >= WORDS_MEMO_MAX) memo.clear();
    memo.set(text, value);
    return value;
  }

  // {kind, words} of a prompt text (memoised by the text).
  function analyse(text) {
    text = str(text);
    var hit = memo.get(text);
    if (hit) return hit;
    var P = prompts(), parsed = null;
    try { parsed = P && typeof P.parse === "function" ? P.parse(text) : null; } catch (e) { parsed = null; }
    var side = askingSide(parsed);
    if (side === null) return remember(text, { kind: parsed ? parsed.kind : "note", words: [], shape: null });
    var runs = P.tokenize(side), seen = Object.create(null), out = [];
    function add(w) { if (w && !STOP[w] && !seen[w]) { seen[w] = true; out.push(w); } }
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      if (run.type === "math") { add("$" + str(run.value).replace(/\s+/g, "")); continue; }
      if (run.type !== "text") continue;            // images are ignored
      var parts = str(run.value).toLowerCase().replace(APOSTROPHE_RE, "").replace(NOT_WORD_RE, " ").split(/\s+/);
      for (var j = 0; j < parts.length; j++) add(parts[j]);
    }
    return remember(text, { kind: parsed.kind, words: out, shape: parsed.kind === "cloze" ? clozeShape(parsed) : null });
  }

  function words(text) { return analyse(text).words.slice(); }

  function asWords(x) { return Array.isArray(x) ? x : analyse(x).words; }

  // {shared, union} of two word lists (each without repeats).
  function overlap(A, B) {
    if (!A.length || !B.length) return { shared: 0, union: A.length + B.length };
    var set = Object.create(null), shared = 0, i, sizeB = 0;
    for (i = 0; i < A.length; i++) set[A[i]] = 1;
    var seenB = Object.create(null);
    for (i = 0; i < B.length; i++) {
      if (seenB[B[i]]) continue;
      seenB[B[i]] = true; sizeB++;
      if (set[B[i]] === 1) shared++;
    }
    var sizeA = Object.keys(set).length;
    return { shared: shared, union: sizeA + sizeB - shared };
  }

  function score(a, b) {
    var o = overlap(asWords(a), asWords(b));
    return o.shared && o.union ? o.shared / o.union : 0;
  }

  function isAlike(shared, union) { return shared >= MIN_SHARED && union > 0 && shared / union >= MIN_SCORE; }

  function alike(a, b) {
    var o = overlap(asWords(a), asWords(b));
    return isAlike(o.shared, o.union);
  }

  function key(idA, idB) {
    var a = str(idA), b = str(idB);
    return a < b ? a + KEY_SEP + b : b + KEY_SEP + a;
  }

  function ignoredSet(ignored) {
    if (!ignored) return null;
    if (ignored instanceof Set) return ignored;
    if (Array.isArray(ignored)) return new Set(ignored.filter(function (k) { return typeof k === "string"; }));
    return null;
  }

  // The live Q./A. and cloze prompts with their words: [{p, words}] (prompts without words left out).
  function candidates(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (p) {
      if (!live(p) || typeof p.id !== "string" || !p.id) return;
      var a = analyse(p.text);
      if (!REVIEWABLE[a.kind] || !a.words.length) return;
      out.push({ p: p, words: a.words, shape: a.shape });
    });
    return out;
  }

  function pairs(list, ignored) {
    var items = candidates(list), skip = ignoredSet(ignored), index = Object.create(null), i, j, k;
    for (i = 0; i < items.length; i++) {
      var ws = items[i].words;
      for (k = 0; k < ws.length; k++) (index[ws[k]] || (index[ws[k]] = [])).push(i);
    }
    var counts = new Int32Array(items.length), touched = [], out = [];
    for (i = 0; i < items.length && out.length < MAX_PAIRS; i++) {
      var wi = items[i].words;
      if (wi.length < MIN_SHARED) continue;
      touched.length = 0;
      for (k = 0; k < wi.length; k++) {
        var posting = index[wi[k]];
        for (var n = 0; n < posting.length; n++) {
          j = posting[n];
          if (j <= i) continue;                    // each unordered pair once
          if (counts[j] === 0) touched.push(j);
          counts[j]++;
        }
      }
      for (n = 0; n < touched.length; n++) {
        j = touched[n];
        var shared = counts[j], union = wi.length + items[j].words.length - shared;
        counts[j] = 0;
        if (!isAlike(shared, union)) continue;
        if (sameSentenceOtherBlanks(items[i], items[j])) continue;   // FIX-7 b
        var a = items[i].p.id, b = items[j].p.id;
        if (a === b) continue;
        var kk = key(a, b);
        if (skip && skip.has(kk)) continue;
        out.push({ a: a < b ? a : b, b: a < b ? b : a, score: shared / union });
        if (out.length >= MAX_PAIRS) break;        // the outer loop ends too: counts is not read again
      }
    }
    out.sort(function (x, y) { return (y.score - x.score) || (key(x.a, x.b) < key(y.a, y.b) ? -1 : key(x.a, x.b) > key(y.a, y.b) ? 1 : 0); });
    return out;
  }

  function nearest(text, list, exceptId, ignored) {
    var mine = analyse(text);
    if (!REVIEWABLE[mine.kind] || mine.words.length < MIN_SHARED) return null;
    var skip = ignoredSet(ignored), except = exceptId === null || exceptId === undefined ? null : str(exceptId);
    var best = null, bestScore = 0, bestShared = 0;
    candidates(list).forEach(function (c) {
      if (except !== null && c.p.id === except) return;
      if (except !== null && skip && skip.has(key(except, c.p.id))) return;
      var o = overlap(mine.words, c.words);
      if (!isAlike(o.shared, o.union)) return;
      if (sameSentenceOtherBlanks(mine, c)) return;                 // FIX-7 b
      var s = o.shared / o.union;
      if (!best || s > bestScore || (s === bestScore && o.shared > bestShared)) { best = c.p; bestScore = s; bestShared = o.shared; }
    });
    return best;
  }

  function oneLine(text, max) {
    var limit = typeof max === "number" && max > 1 ? Math.floor(max) : ONE_LINE_CHARS;
    var P = prompts(), parsed = null;
    try { parsed = P.parse(str(text)); } catch (e) { parsed = null; }
    var side = askingSide(parsed, false);
    if (side === null) side = parsed ? str(parsed.display) : str(text);
    var runs = P.tokenize(side), parts = [];
    for (var i = 0; i < runs.length; i++) {
      var piece = runs[i].type === "image" ? "[image]" : side.slice(runs[i].start, runs[i].end);
      // FIX-4: `\::` (a literal "::") reads "::" outside math, as M.markup shows it (an odd number of backslashes escapes)
      if (runs[i].type === "text") piece = piece.replace(/(\\*)\\::/g, function (m, bs) { return bs.length % 2 === 0 ? bs + "::" : m; });
      parts.push(piece);
    }
    var chars = Array.from(parts.join("").replace(/\s+/g, " ").trim());   // characters, not UTF-16 units
    return chars.length <= limit ? chars.join("") : chars.slice(0, limit - 1).join("").replace(/\s+$/, "") + "…";
  }

  var api = {
    words: words, score: score, alike: alike, pairs: pairs, nearest: nearest, key: key, oneLine: oneLine,
    MIN_SCORE: MIN_SCORE, MIN_SHARED: MIN_SHARED, MAX_PAIRS: MAX_PAIRS, ONE_LINE_CHARS: ONE_LINE_CHARS, STOP_WORDS: STOP_WORDS.slice()
  };
  M.similar = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.similar; FEATURES P2.4; BUILD-NOTES "Prompt craft"): pure, no DOM; depends on M.prompts only.
 * words(text) → [word] (the asking side: a Q./A. question, a cloze body without braces and cues; lower case,
 * punctuation removed, each math run one word "$" + source without blanks, images ignored, STOP_WORDS dropped, no
 * stemming); score(a, b) → |A∩B| / |A∪B| (0 when either is empty); alike(a, b) → score >= MIN_SCORE 0.6 and
 * |A∩B| >= MIN_SHARED 3; pairs(prompts, ignored) → [{a, b, score}] (live Q./A. and cloze prompts, keys in `ignored` left
 * out, compared only through a word index, at most MAX_PAIRS 5000); nearest(text, prompts, exceptId, ignored) → prompt | null;
 * key(idA, idB) → "<smaller id>|<larger id>". Extras: oneLine(text, max), ONE_LINE_CHARS 90, STOP_WORDS (a copy).
 * FIXES-1: oneLine adds no blank around a hidden part and shows `\::` as "::" (FIX-4); pairs() and nearest() skip two
 * cloze prompts of the same sentence with different blanks (FIX-7 b); STOP_WORDS gained and … only (FIX-7 a). */
