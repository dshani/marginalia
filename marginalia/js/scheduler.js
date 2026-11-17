/*
 * Marginalia — js/scheduler.js
 * Pure spaced-repetition scheduler and review-queue builder (SPEC §7).
 *
 * Attribution: the scheduling rules in this file are a port of the Orbit
 * scheduler by Andy Matuschak (https://github.com/andymatuschak/orbit),
 * released under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Adapted for Marginalia:
 * milliseconds throughout, `now` always passed in. As in Orbit, a card never
 * asked is due at once, and a right first answer on its first day gives 5 days
 * (DECISIONS D4 as changed by D27). A queue holds one card per prompt (D27;
 * Orbit: one component per task).
 *
 * Not Orbit's (DECISIONS D28, D29; BUILD-NOTES "Wrong answers and the next
 * day"): after a wrong answer the wait is 1 day and the card's growth factor
 * drops to three quarters (Andy Matuschak's sketch in his note "Forgotten
 * spaced repetition prompts should probably be reviewed the next day"; Orbit
 * steps one rung back). No card is due again within 16 hours of an answer to
 * it or to another card of its prompt. A card never answered wrong is graded
 * exactly as Orbit grades it.
 *
 * Everything here is synchronous and side-effect free: schedules are never
 * mutated, `grade` returns a new object, so a caller can keep the previous
 * object for a single-level undo. No DOM, no storage. The only dependency is
 * M.util (hash32, localMidnight, dayKey), resolved lazily through dep() so the
 * file loads in node without util.js being present.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }

  // ---- constants (§7) -------------------------------------------------------
  var DAY = 86400000;
  var GROWTH = 2.3;
  var FIRST = 5 * DAY;
  var LAPSE = DAY;                        // D28: the wait after a wrong answer
  var LOOKAHEAD = 16 * 3600000;           // a card that comes due within 16 hours counts as due today
  var NEXT_DAY = 16 * 3600000;            // D29: two answers less than 16 hours apart are on the same day
  var GROWTH_FULL = 2300;                 // the growth factor in thousandths: GROWTH for a card never answered wrong
  var GROWTH_LEAST = 1000;                // D28: wrong answers never bring the factor below 1
  var LEGEND = Object.freeze([5, 11.5, 26.45, 60.835, 139.9205, 321.81715].map(function (d) { return d * DAY; }));
  var LEGEND_LABELS = Object.freeze(["5d", "2wk", "1mo", "2mo", "4mo", "1yr"]);
  var SCHEDULER_VERSION = 1;
  var MAX_ASKS = 3;

  // floor(ms · g / 1000) for a growth factor g in thousandths, in integer arithmetic: the result is the mathematical
  // value (10 d · 2.3 in IEEE doubles is 23 d − 1 ms, which would break the §7 vectors). With g = 2300 it is
  // floor(ms · 23 / 10), Orbit's growth.
  function growBy(ms, g) { return Math.floor(ms / 1000) * g + Math.floor((ms % 1000) * g / 1000); }
  // D28 (Matuschak's sketch): a wrong answer leaves three quarters of the factor, never less than GROWTH_LEAST; a
  // right answer wins back a fifth of what is missing (rounded up, so the factor reaches GROWTH_FULL again).
  function lapsed(g) { return Math.max(GROWTH_LEAST, Math.round(g * 3 / 4)); }
  function recovered(g) { return Math.min(GROWTH_FULL, g + Math.ceil((GROWTH_FULL - g) / 5)); }
  function validGrowth(v) { return typeof v === "number" && v === Math.floor(v) && v >= GROWTH_LEAST && v <= GROWTH_FULL; }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function fail(code, message) { var e = new Error(message); e.code = code; return e; }

  // ---- schedules -------------------------------------------------------------
  // A new card is due at once (D27; before: after FIRST). Its first interval is FIRST all the same: grade() gives
  // max(FIRST, elapsed · GROWTH) for the first right answer, as Orbit does from its interval 0.
  function newSchedule(now) {
    return { createdAt: now, lastReviewedAt: null, intervalMs: FIRST, dueAt: now, growth: GROWTH_FULL, log: [] };
  }

  // A card never answered (a skip is no answer).
  function neverAsked(s) { return !!s && (s.lastReviewedAt === null || s.lastReviewedAt === undefined); }

  // The time from which a card is due: the time it was made while it was never asked (cards made before D27 store
  // dueAt = createdAt + FIRST, and are due at once all the same), else its dueAt. null without that number.
  function dueTime(s) {
    if (!s) return null;
    if (neverAsked(s) && isNum(s.createdAt)) return s.createdAt;
    return isNum(s.dueAt) ? s.dueAt : null;
  }

  function jitter(now) { return (now % 1000) * 600; }            // 0 … 599 400

  // A card never asked is due (D27). Any other card is due when its due time lies within the lookahead AND its own
  // last answer is at least NEXT_DAY old (D29: no card comes again on the day of its answer; a card answered wrong
  // has dueAt = the answer + 1 day, so it is due from 16 hours after that answer).
  function isDue(s, now) {
    if (!s) return false;
    if (neverAsked(s) && isNum(s.createdAt)) return true;                // D27: due until its first answer
    if (!isNum(s.dueAt) || s.dueAt > now + LOOKAHEAD) return false;
    return !isNum(s.lastReviewedAt) || now >= s.lastReviewedAt + NEXT_DAY;
  }

  // ---- the cards of one prompt (D29) ------------------------------------------
  // A sentence's blanks give each other away, so an answer to one card holds the prompt's OTHER cards back until
  // NEXT_DAY after it (Anki: "bury siblings until the next day"). 0 when no other card was answered.
  function heldUntil(p, i) {
    var cards = p && Array.isArray(p.cards) ? p.cards : [], t = 0;
    for (var j = 0; j < cards.length; j++) {
      if (j === i || !cards[j] || !isNum(cards[j].lastReviewedAt)) continue;
      if (cards[j].lastReviewedAt + NEXT_DAY > t) t = cards[j].lastReviewedAt + NEXT_DAY;
    }
    return t;
  }

  // The time from which card i of prompt p can be asked: isReady(p, i, t) is true from this time on, so every text
  // that says WHEN a card comes agrees with the counts that say it is due. A card never asked: the time it was made;
  // isDue calls such a card due whatever that time is (a clock set back), so with `now` given the result is never
  // later than now for it, and then isReady(p, i, now) is true exactly when readyTime(p, i, now) <= now. Any other
  // card: its due time less the lookahead, but not before NEXT_DAY after its own answer. Both: not before heldUntil.
  // null for a card without those numbers.
  function readyTime(p, i, now) {
    var c = p && Array.isArray(p.cards) ? p.cards[i] : null, d;
    if (!c) return null;
    if (neverAsked(c) && isNum(c.createdAt)) d = isNum(now) && c.createdAt > now ? now : c.createdAt;
    else if (isNum(c.dueAt)) {
      d = c.dueAt - LOOKAHEAD;
      if (isNum(c.lastReviewedAt) && c.lastReviewedAt + NEXT_DAY > d) d = c.lastReviewedAt + NEXT_DAY;
    } else return null;
    var h = heldUntil(p, i);
    return h > d ? h : d;
  }

  // Can card i of prompt p be asked now? Every "due" count and text uses this, not isDue alone.
  function isReady(p, i, now) {
    var c = p && Array.isArray(p.cards) ? p.cards[i] : null;
    return !!c && isDue(c, now) && now >= heldUntil(p, i);
  }

  function lastOutcome(s) {
    var log = s && Array.isArray(s.log) ? s.log : [], e = log.length ? log[log.length - 1] : null;
    return e ? e.outcome : null;
  }

  // The time of the card's latest wrong answer (null without one).
  function lastWrongAt(s) {
    var log = s && Array.isArray(s.log) ? s.log : [], at = null;
    for (var i = 0; i < log.length; i++) {
      var e = log[i];
      if (e && e.outcome === "forgot" && isNum(e.at) && (at === null || e.at > at)) at = e.at;
    }
    return at;
  }

  // The wait that the card's next answer is graded from: its stored wait (FIRST when that is no number), and at most
  // LAPSE when its latest answer was wrong (the rule before D28 stored 5 days or more after a wrong answer).
  function waitOf(s) {
    var iv = s && isNum(s.intervalMs) ? s.intervalMs : FIRST;
    return lastOutcome(s) === "forgot" && iv > LAPSE ? LAPSE : iv;
  }

  // A card's growth factor in thousandths. A card stored before D28 has none: its answer log gives it (the wrong
  // answers given before D28 count too). GROWTH_FULL without a log, and for a log that cannot be replayed.
  function growthOf(s) {
    if (!s || typeof s !== "object") return GROWTH_FULL;
    if (validGrowth(s.growth)) return s.growth;
    if (!Array.isArray(s.log) || !s.log.length) return GROWTH_FULL;
    // entries that are no answers (hand-made data) are left out, so that the real wrong answers still count
    var answers = s.log.filter(function (e) { return !!e && isNum(e.at) && (e.outcome === "remembered" || e.outcome === "forgot"); });
    var r;
    try { r = replay(s.createdAt, answers); } catch (e) { return GROWTH_FULL; }
    return validGrowth(r.growth) ? r.growth : GROWTH_FULL;
  }

  // D28. remembered: the wait is the real time since the last answer times the card's growth factor (Orbit's rule
  // with 2.3), at least 5 days, or at least 1 day while the card comes back from a wrong answer (its wait is below
  // 5 days and its factor below the full one); an answer before the wait was over never shortens it. forgot: the
  // wait is 1 day.
  // The growth factor: a wrong answer leaves three quarters of it, but a wrong answer less than NEXT_DAY after
  // another wrong answer is the same lapse and does not count again (the retries of a session, whatever came in
  // between); a right answer to a card that was due wins back a fifth of what is missing (a retry a minute later,
  // or another early answer, proves nothing).
  // A card never answered wrong keeps GROWTH_FULL, and is graded exactly as before D28.
  function grade(s, now, outcome) {
    if (outcome !== "remembered" && outcome !== "forgot") {
      throw fail("bad_outcome", "Unknown review outcome: " + String(outcome));
    }
    if (!s || typeof s !== "object") throw fail("bad_schedule", "grade() needs a schedule object");
    var last = neverAsked(s) ? s.createdAt : s.lastReviewedAt;
    var elapsed = isNum(last) && isNum(now) ? Math.max(0, now - last) : 0;
    var iv = waitOf(s);
    var g = growthOf(s), interval, growth;
    if (outcome === "remembered") {
      var least = iv < FIRST && g < GROWTH_FULL ? LAPSE : FIRST;
      var grown = growBy(elapsed, g);
      interval = elapsed < iv ? Math.max(iv, least, grown) : Math.max(least, grown);
      growth = isDue(s, now) ? recovered(g) : g;
    } else {
      var wrongAt = lastWrongAt(s);
      interval = LAPSE;
      growth = wrongAt !== null && isNum(now) && now - wrongAt < NEXT_DAY ? g : lapsed(g);
    }
    var due = now + jitter(now) + interval;
    var entry = { at: now, outcome: outcome, intervalMs: interval, dueAt: due };
    var log = Array.isArray(s.log) ? s.log.concat([entry]) : [entry];
    return Object.assign({}, s, { lastReviewedAt: now, intervalMs: interval, dueAt: due, growth: growth, log: log });
  }

  function preview(s, now, outcome) { return grade(s, now, outcome).intervalMs; }

  // Fold grade over the log sorted by `at`, starting from a fresh schedule.
  // Only `at` and `outcome` of each entry are read; intervals and due dates
  // are recomputed by the current scheduler. Used for import merges (§9).
  function replay(createdAt, log) {
    var entries = (Array.isArray(log) ? log : []).slice().sort(function (a, b) { return a.at - b.at; });
    var s = newSchedule(createdAt);
    for (var i = 0; i < entries.length; i++) s = grade(s, entries[i].at, entries[i].outcome);
    return s;
  }

  // (first i with LEGEND[i] > ms·1.1) − 1; −1 = below the ladder, 5 = above it.
  function rung(ms) {
    var x = ms * 1.1, i = 0;
    while (i < LEGEND.length && LEGEND[i] <= x) i++;
    return i - 1;
  }

  function rayValue(ms) {
    if (!(ms > 0)) return 0;
    var lo = Math.log2(FIRST), hi = Math.log2(LEGEND[5]);
    var t = (Math.log2(ms) - lo) / (hi - lo);          // lerp(log2 ms, log2 FIRST, log2 LEGEND[5], 0.1, 1)
    return clamp(0.1 + t * 0.9, 0, 1);
  }

  // ---- queue (§7 "Queue") ----------------------------------------------------
  // Reading-order helpers. Books: (pageIndex, −anchor.y, createdAt, cardIndex).
  // A book prompt without an anchor (imported, lost) behaves as lost at
  // context.pageIndex ?? 0 and sits at the page top (§5), so y = +Infinity.
  // Deck prompts have no page, so their keys degrade to (createdAt, cardIndex).
  function pageOf(p) {
    if (p.anchor && isNum(p.anchor.pageIndex)) return p.anchor.pageIndex;
    if (p.context && isNum(p.context.pageIndex)) return p.context.pageIndex;
    return 0;
  }
  function yOf(p) {
    return (p.anchor && isNum(p.anchor.y)) ? p.anchor.y : Infinity;   // no anchor / lost → page top
  }
  function createdOf(p) { return isNum(p.createdAt) ? p.createdAt : 0; }

  function compareKeys(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  function buildQueue(opts) {
    opts = opts || {};
    var prompts = Array.isArray(opts.prompts) ? opts.prompts : [];
    var scope = opts.scope;
    var collectionId = opts.collectionId === undefined ? null : opts.collectionId;
    var now = isNum(opts.now) ? opts.now : Date.now();
    var seed = (opts.seed === undefined || opts.seed === null) ? now : opts.seed;
    if (scope !== "book" && scope !== "deck" && scope !== "today" && scope !== "all") {
      throw fail("bad_scope", "Unknown review scope: " + String(scope));
    }
    var util = dep("util");
    var midnight = scope === "today" ? util.localMidnight(now) : 0;
    var filterByCollection = scope === "book" || scope === "deck" || (scope === "today" && collectionId !== null);

    // Pass 1: candidate prompts.
    var live = [];
    var firstCreatedByCollection = {};
    for (var i = 0; i < prompts.length; i++) {
      var p = prompts[i];
      if (!p || (p.deletedAt !== null && p.deletedAt !== undefined)) continue; // tombstones
      if (p.kind !== "qa" && p.kind !== "cloze") continue;                      // notes, highlights
      if (!Array.isArray(p.cards) || p.cards.length === 0) continue;
      if (filterByCollection && p.collectionId !== collectionId) continue;
      if (scope === "today" && !(createdOf(p) >= midnight)) continue;
      live.push(p);
      var cid = String(p.collectionId);
      if (!(cid in firstCreatedByCollection) || createdOf(p) < firstCreatedByCollection[cid]) {
        firstCreatedByCollection[cid] = createdOf(p);
      }
    }

    // Pass 2: ONE card per prompt (D27) → wrappers with sort keys. A sentence with several blanks gives one blank to
    // a session, so that one blank never gives another away (Matuschak's guide; Orbit: one component per task), and
    // its other blanks wait until the next day (D29: heldUntil). Candidates: the cards that can be asked now
    // (isReady); scope "today" asks due or not, so there every card that no other card holds back. Of the
    // candidates it is the card that is most overdue for its wait: the time since its last answer (since it was
    // made, for a card never asked) divided by its wait. So a blank that was forgotten (wait 1 day) comes back the
    // next day, before blanks never asked (5 days), and a blank that is passed over rises each day, so none is
    // left out however often another blank is forgotten. A tie: the shorter wait, then the smallest dueTime, then
    // the lowest index.
    var wrapped = [];
    for (i = 0; i < live.length; i++) {
      p = live[i];
      var k = -1, best = 0, bestWait = 0, bestOver = 0;
      for (var j = 0; j < p.cards.length; j++) {
        var c = p.cards[j];
        if (!c) continue;
        if (now < heldUntil(p, j)) continue;
        if (scope !== "today" && !isDue(c, now)) continue;
        var dt = dueTime(c);
        if (!isNum(dt)) dt = Infinity;                       // a card without its numbers goes last
        var wait = waitOf(c), since = neverAsked(c) ? c.createdAt : c.lastReviewedAt;
        if (!(wait > 0)) wait = FIRST;
        var over = isNum(since) && now > since ? (now - since) / wait : 0;
        if (k < 0 || over > bestOver || (over === bestOver && (wait < bestWait || (wait === bestWait && dt < best)))) {
          k = j; best = dt; bestWait = wait; bestOver = over;
        }
      }
      if (k < 0) continue;
      var key;
      if (scope === "deck") {
        key = [createdOf(p), k];
      } else if (scope === "book") {
        key = [pageOf(p), -yOf(p), createdOf(p), k];
      } else if (scope === "today") {
        // reading order inside a collection; collections in the order the
        // writer started on them today (only matters from the library).
        key = [firstCreatedByCollection[String(p.collectionId)], String(p.collectionId), pageOf(p), -yOf(p), createdOf(p), k];
      } else { // all: the local day from which the card is due, then a deterministic shuffle
        key = [util.dayKey(isNum(best) ? best : 0), util.hash32(String(seed) + String(p.id) + String(k)), String(p.id), k];
      }
      wrapped.push({ item: { promptId: p.id, cardIndex: k }, key: key });
    }
    wrapped.sort(function (a, b) { return compareKeys(a.key, b.key); });
    return wrapped.map(function (w) { return w.item; });
  }

  // Defer any card whose prompt had a sibling within the previous 5 output
  // positions until 5 items have passed; whatever is still deferred at the
  // end goes there, in order. (buildQueue no longer needs it: since D27 a queue
  // holds one card per prompt. It stays for callers that order lists with siblings.)
  function spread(items) {
    items = Array.isArray(items) ? items : [];
    var out = [], deferred = [];
    function blocked(it) {
      for (var j = Math.max(0, out.length - 5); j < out.length; j++) {
        if (out[j].promptId === it.promptId) return true;
      }
      return false;
    }
    var i = 0;
    while (i < items.length || deferred.length) {
      var placed = false;
      for (var d = 0; d < deferred.length; d++) {
        if (!blocked(deferred[d])) { out.push(deferred[d]); deferred.splice(d, 1); placed = true; break; }
      }
      if (placed) continue;
      if (i < items.length) {
        var it = items[i++];
        if (blocked(it)) deferred.push(it); else out.push(it);
      } else {
        for (var r = 0; r < deferred.length; r++) out.push(deferred[r]);
        deferred = [];
      }
    }
    return out;
  }

  // ---- struggling prompts (FEATURES P1.4; BUILD-NOTES "Prompt craft") ------
  // Nothing is stored: the card's review log is the source, so replay and the import merge stay as they are.
  var STRUGGLE_DAYS = 3;

  // How many different local days (M.util.dayKey) hold a log entry with outcome "forgot" and at >= since.
  function missDays(card, since) {
    var log = card && Array.isArray(card.log) ? card.log : [];
    var from = typeof since === "number" && isFinite(since) ? since : 0;
    var util = dep("util"), days = Object.create(null), n = 0;
    for (var i = 0; i < log.length; i++) {
      var e = log[i];
      if (!e || e.outcome !== "forgot" || typeof e.at !== "number" || !isFinite(e.at) || e.at < from) continue;
      var k = util.dayKey(e.at);
      if (k && !days[k]) { days[k] = true; n++; }
    }
    return n;
  }

  function struggling(card, since) { return missDays(card, since) >= STRUGGLE_DAYS; }

  // A prompt's miss days: the most of any card's, counted since the prompt's text last changed (revisedAt, FIXES-1
  // FIX-5; 0 when absent), so only an edit of the text starts the count again (a flag, tags, a move, a delete and its
  // undo do not). 0 for anything but a live Q./A. or cloze prompt. The prompt struggles when this is >= STRUGGLE_DAYS.
  function promptMissDays(p) {
    if (!p || (p.deletedAt !== null && p.deletedAt !== undefined) || (p.kind !== "qa" && p.kind !== "cloze")) return 0;
    var since = typeof p.revisedAt === "number" && isFinite(p.revisedAt) ? p.revisedAt : 0;
    var cards = Array.isArray(p.cards) ? p.cards : [], best = 0;
    for (var i = 0; i < cards.length; i++) { var n = missDays(cards[i], since); if (n > best) best = n; }
    return best;
  }

  var api = {
    DAY: DAY, GROWTH: GROWTH, FIRST: FIRST, LAPSE: LAPSE, LOOKAHEAD: LOOKAHEAD, NEXT_DAY: NEXT_DAY, LEGEND: LEGEND,
    GROWTH_FULL: GROWTH_FULL, GROWTH_LEAST: GROWTH_LEAST,
    LEGEND_LABELS: LEGEND_LABELS, MAX_ASKS: MAX_ASKS, SCHEDULER_VERSION: SCHEDULER_VERSION,
    newSchedule: newSchedule, neverAsked: neverAsked, dueTime: dueTime, jitter: jitter, isDue: isDue, grade: grade, preview: preview, replay: replay,
    growthOf: growthOf, waitOf: waitOf, heldUntil: heldUntil, readyTime: readyTime, isReady: isReady,
    rung: rung, rayValue: rayValue, buildQueue: buildQueue, spread: spread,
    STRUGGLE_DAYS: STRUGGLE_DAYS, missDays: missDays, struggling: struggling, promptMissDays: promptMissDays
  };
  M.scheduler = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.scheduler): DAY, GROWTH, FIRST, LAPSE, LOOKAHEAD, NEXT_DAY, GROWTH_FULL, GROWTH_LEAST,
 * LEGEND, MAX_ASKS, SCHEDULER_VERSION; newSchedule(now); jitter(now); isDue(s, now); grade(s, now, outcome) (throws
 * code "bad_outcome"); preview(s, now, outcome); replay(createdAt, log); rung(ms); rayValue(ms);
 * buildQueue({prompts, scope, collectionId, now, seed}) → [{promptId, cardIndex}]; spread(items).
 * Extras: LEGEND_LABELS; grade throws code "bad_schedule" without a schedule; buildQueue throws
 * code "bad_scope" for an unknown scope; grade reads a wait that is no number as FIRST and a time that is no number
 * as "no time has passed".
 * D27 (BUILD-NOTES "Scheduling and statistics"): newSchedule(now).dueAt = now; neverAsked(s) → boolean; dueTime(s) →
 * createdAt while never asked, else dueAt (null without the number); isDue is true for a card never asked;
 * buildQueue gives one card per prompt and no longer calls spread.
 * D28, D29 (BUILD-NOTES "Wrong answers and the next day"): no RETRY any more (a wrong answer is due after LAPSE; the
 * session retries by itself); a schedule has `growth` (thousandths; newSchedule: GROWTH_FULL), growthOf(s) reads it or
 * replays the log's answers; waitOf(s) → the wait the next answer is graded from (intervalMs, FIRST when it is no
 * number, at most LAPSE after a wrong answer); isDue also needs now >= lastReviewedAt + NEXT_DAY; heldUntil(p, i) →
 * NEXT_DAY after the latest answer to another card of p (0 without one); readyTime(p, i, now?) → the time from which
 * isReady holds: max(createdAt for a card never asked (never later than `now` when given), else max(dueAt −
 * LOOKAHEAD, own answer + NEXT_DAY); heldUntil), or null; isReady(p, i, now) → isDue && now >= heldUntil; buildQueue
 * takes of a prompt's candidates (isReady; scope today: not held) the one most overdue for its wait ((now − last
 * answer or createdAt) / waitOf), then the shorter wait, then the smallest dueTime, then the lowest index.
 * BUILD-NOTES "Prompt craft" (FEATURES P1.4): STRUGGLE_DAYS 3; missDays(card, since) → the number of local days
 * (M.util.dayKey) with a "forgot" log entry at >= since (default 0); struggling(card, since) → missDays >= STRUGGLE_DAYS.
 * Extension: promptMissDays(p) → max missDays over a live Q./A. or cloze prompt's cards since p.revisedAt (FIXES-1 FIX-5)
 * (0 when absent), else 0. Pure; nothing is stored. */
