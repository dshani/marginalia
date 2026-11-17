/* js/stats.js — M.stats: the statistics page (DECISIONS D27, BUILD-NOTES "Scheduling and statistics", SPEC §17.2).
 *
 * The page answers "is this prompt being asked again, and when?": one row per live Q./A. or cloze prompt with the
 * day it was last asked, the day it is due next, its current wait, its answers and its wrong answers; the totals of
 * the rows; and "Coming due", the cards that come due on each of the next 30 days. It reads M.cache and
 * M.scheduler and writes nothing.
 *
 * open() renders into #stats (M.app routes "stats" ↔ "#stats" here), close() empties it. While it is open it redraws
 * (debounced) when a prompt, a collection or an image changes; while a review runs over it, it waits and redraws once
 * when the review ends. A redraw keeps the focus, the open list and the table's sideways scroll. A click on a prompt opens it in its
 * book (M.app.route "reader"; a deck prompt opens its deck). The column headers sort; the book filter and the
 * "Show" filter (all, due now, never asked, flagged, struggling) narrow the rows, the totals and the chart: "Flagged"
 * is the list of every flagged prompt of the library. No key is added to a key map (D20); Esc goes back to the
 * library (js/app.js).
 *
 * All text reaches the DOM as textContent (the h() helper). The one exception is a prompt's question in the table:
 * M.markup.render draws it (formulas, the marked blanks of a sentence), as the prompt list does.
 *
 * Loads in node without a DOM: open() returns false there; rows, totals, forecast, sortRows and the text helpers
 * are pure.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  var DAY = 86400000;
  var FORECAST_DAYS = 30;             // "Coming due": today and the 29 days after it
  var AXIS_EVERY = 7;                 // a date under every seventh day
  var REDRAW_MS = 150;                // redraws are collected for this long
  var TEXT_CHARS = 110;               // a prompt's one-line text (the row's `text`: sorting, titles, the fallback)
  var HTML_CACHE_MAX = 4000;          // rendered questions kept between redraws (more only while one draw needs more)
  var SUMMARY_DAYS = 8;               // the chart's spoken summary names at most this many days
  // attachment:ready: an image of a question finished loading (its placeholder is drawn again as the image)
  var EVENTS = ["prompt:saved", "prompt:deleted", "prompt:restored", "prompts:recontexted", "collection:changed", "collection:deleted", "review:ended", "attachment:ready"];
  var REVIEW_ENDED = "review:ended";
  var IMAGE_MISSING = "att--missing";   // M.markup's placeholder class for an image whose bytes are not loaded yet
  var TOUCH_TIP_MS = 2500;             // after a tap the hover line goes by itself
  var REVIEWABLE = { qa: true, cloze: true };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // The table's columns, in order. first: the direction of the first click on the header.
  var COLUMNS = [
    { key: "text", label: "Prompt", first: "asc" },
    { key: "book", label: "Book", first: "asc" },
    { key: "cards", label: "Cards", num: true, first: "desc" },
    { key: "lastAskedAt", label: "Last asked", first: "asc" },
    { key: "nextDueAt", label: "Next due", first: "asc" },
    { key: "intervalMs", label: "Wait", first: "asc" },
    { key: "answers", label: "Answers", num: true, first: "desc" },
    { key: "wrong", label: "Wrong", num: true, first: "desc" }
  ];
  var DEFAULT_SORT = { key: "nextDueAt", dir: "asc" };
  // The "Show" filter, in order: which rows a choice keeps.
  var SHOWS = [
    { id: "", label: "All prompts", test: function () { return true; } },
    { id: "due", label: "Due now", test: function (r) { return r.due > 0; } },
    { id: "never", label: "Never asked", test: function (r) { return r.neverAsked > 0; } },
    { id: "flagged", label: "Flagged", test: function (r) { return r.flagged === true; } },
    { id: "struggling", label: "Struggling", test: function (r) { return r.struggling === true; } }
  ];

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function live(x) { return !!x && (x.deletedAt === null || x.deletedAt === undefined); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function column(key) { for (var i = 0; i < COLUMNS.length; i++) if (COLUMNS[i].key === key) return COLUMNS[i]; return null; }
  function showOf(id) { for (var i = 0; i < SHOWS.length; i++) if (SHOWS[i].id === id) return SHOWS[i]; return SHOWS[0]; }
  // The rows a "Show" choice keeps (an unknown choice keeps all).
  function filterRows(list, show) { var s = showOf(show); return (Array.isArray(list) ? list : []).filter(function (r) { return s.test(r); }); }

  // ---- pure: the figures ---------------------------------------------------------------------------------------

  function liveCollections(collections) {
    var map = new Map();
    (Array.isArray(collections) ? collections : []).forEach(function (c) { if (live(c) && c.id !== undefined && c.id !== null) map.set(c.id, c); });
    return map;
  }
  function bookName(c) { return c && c.name ? String(c.name) : (c && c.kind === "deck" ? "Untitled deck" : "Untitled"); }
  function oneLine(text) {
    var sim = tryDep("similar");
    if (sim && typeof sim.oneLine === "function") { try { return sim.oneLine(str(text), TEXT_CHARS); } catch (e) { /* fall through */ } }
    var s = str(text).replace(/\s+/g, " ").trim();
    return s.length <= TEXT_CHARS ? s : s.slice(0, TEXT_CHARS - 1) + "…";
  }

  // The asking side of a prompt as typed: a Q./A. prompt's question, a cloze sentence with its braces (M.markup marks
  // the hidden parts). The table renders it; `text` is its plain one-line form.
  function askingSide(text) {
    var pr = tryDep("prompts"), parsed = null;
    try { parsed = pr && typeof pr.parse === "function" ? pr.parse(str(text)) : null; } catch (e) { parsed = null; }
    if (!parsed) return str(text);
    return parsed.kind === "qa" ? str(parsed.question) : str(parsed.display);
  }

  // One row per live Q./A. or cloze prompt of a live collection that has a card.
  function rows(prompts, collections, now) {
    var sc = dep("scheduler"), t = isNum(now) ? now : Date.now();
    var cols = liveCollections(collections), out = [];
    (Array.isArray(prompts) ? prompts : []).forEach(function (p) {
      if (!live(p) || !REVIEWABLE[p.kind] || !Array.isArray(p.cards)) return;
      var col = cols.get(p.collectionId);
      if (!col) return;
      var cards = 0, never = 0, due = 0, last = null, next = null, nextCard = null, answers = 0, wrong = 0;
      for (var i = 0; i < p.cards.length; i++) {
        var c = p.cards[i];
        if (!c) continue;
        cards++;
        if (sc.neverAsked(c)) never++;
        if (sc.isReady(p, i, t)) due++;                       // D29: due by its schedule, and no other blank holds it back
        if (isNum(c.lastReviewedAt) && (last === null || c.lastReviewedAt > last)) last = c.lastReviewedAt;
        var dt = sc.readyTime(p, i, t);                       // the time from which a session can ask it (never later than now for a card that is due)
        if (isNum(dt) && (next === null || dt < next)) { next = dt; nextCard = c; }
        var log = Array.isArray(c.log) ? c.log : [];
        answers += log.length;
        for (var j = 0; j < log.length; j++) if (log[j] && log[j].outcome === "forgot") wrong++;
      }
      if (!cards) return;
      var miss = typeof sc.promptMissDays === "function" ? sc.promptMissDays(p) : 0;
      out.push({
        id: p.id, collectionId: p.collectionId, book: bookName(col), kind: p.kind, text: oneLine(p.text), source: askingSide(p.text), flagged: p.flagged === true,
        createdAt: isNum(p.createdAt) ? p.createdAt : 0, cards: cards, neverAsked: never, due: due, lastAskedAt: last, nextDueAt: next,
        // the wait of the card that comes next, and its growth factor in thousandths (D28: below 2300 after wrong
        // answers); none while that card was never asked
        intervalMs: nextCard && !sc.neverAsked(nextCard) && isNum(nextCard.intervalMs) ? sc.waitOf(nextCard) : null,
        growth: nextCard && !sc.neverAsked(nextCard) ? sc.growthOf(nextCard) : null,
        answers: answers, wrong: wrong, missDays: miss, struggling: miss >= (isNum(sc.STRUGGLE_DAYS) ? sc.STRUGGLE_DAYS : 3)
      });
    });
    return out;
  }

  function totals(list) {
    var t = { prompts: 0, cards: 0, due: 0, neverAsked: 0, answers: 0, wrong: 0 };
    (Array.isArray(list) ? list : []).forEach(function (r) {
      t.prompts++; t.cards += r.cards; t.due += r.due; t.neverAsked += r.neverAsked; t.answers += r.answers; t.wrong += r.wrong;
    });
    return t;
  }

  // The cards that come due on each of the next `days` local days. Day 0 is today: it holds every card that can be
  // asked now (M.scheduler.isReady, so also a card never asked and a card due within the 16-hour lookahead) and every
  // card that comes due later today. Every other card is in the column of its M.scheduler.readyTime (D29: a blank
  // that waits for its sentence comes the next day). → {days: [{at, dayKey, count}], later (cards after the last
  // day), max, total}.
  function forecast(prompts, collections, now, days) {
    var sc = dep("scheduler"), u = dep("util"), t = isNum(now) ? now : Date.now();
    var n = isNum(days) && days >= 1 ? Math.floor(days) : FORECAST_DAYS;
    var cols = liveCollections(collections), m0 = u.localMidnight(t), d0 = new Date(m0);
    var out = [], later = 0, max = 0, total = 0;
    for (var i = 0; i < n; i++) {
      var at = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i).getTime();   // local midnight, whatever the day's length
      out.push({ at: at, dayKey: u.dayKey(at), count: 0 });
    }
    (Array.isArray(prompts) ? prompts : []).forEach(function (p) {
      if (!live(p) || !REVIEWABLE[p.kind] || !Array.isArray(p.cards) || !cols.has(p.collectionId)) return;
      p.cards.forEach(function (c, ci) {
        if (!c) return;
        var idx;
        if (sc.isReady(p, ci, t)) idx = 0;
        else {
          var dt = sc.readyTime(p, ci, t);
          if (!isNum(dt)) return;
          idx = Math.max(0, Math.round((u.localMidnight(dt) - m0) / DAY));
        }
        total++;
        if (idx >= n) later++; else out[idx].count++;
      });
    });
    for (var k = 0; k < out.length; k++) if (out[k].count > max) max = out[k].count;
    return { days: out, later: later, max: max, total: total };
  }

  // A sorted copy. A value that is missing (never asked: no last answer, no wait) comes first ascending and last
  // descending. Ties: the row that is due first, then the one written first, then the order given.
  function sortRows(list, key, dir) {
    var k = column(key) ? key : DEFAULT_SORT.key, sign = dir === "desc" ? -1 : 1;
    function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
    function cmpNum(a, b) { var an = isNum(a), bn = isNum(b); return an && bn ? cmp(a, b) : an ? 1 : bn ? -1 : 0; }
    return (Array.isArray(list) ? list : []).map(function (r, i) { return { r: r, i: i }; }).sort(function (x, y) {
      var c = (k === "text" || k === "book") ? cmp(str(x.r[k]).toLowerCase(), str(y.r[k]).toLowerCase()) : cmpNum(x.r[k], y.r[k]);
      if (c !== 0) return sign * c;
      return cmpNum(x.r.nextDueAt, y.r.nextDueAt) || cmpNum(x.r.createdAt, y.r.createdAt) || (x.i - y.i);
    }).map(function (w) { return w.r; });
  }

  // ---- pure: the words -------------------------------------------------------------------------------------------

  // A local day beside today: "today" | "yesterday" | "tomorrow" | "12 Nov" | "12 Nov 2025" ("" without a time).
  function dayLabel(ms, now) {
    if (!isNum(ms)) return "";
    var u = dep("util"), ref = isNum(now) ? now : Date.now();
    var days = Math.round((u.localMidnight(ms) - u.localMidnight(ref)) / DAY);
    if (days === 0) return "today";
    if (days === -1) return "yesterday";
    if (days === 1) return "tomorrow";
    var d = new Date(ms), label = d.getDate() + " " + MONTHS[d.getMonth()];
    return d.getFullYear() === new Date(ref).getFullYear() ? label : label + " " + d.getFullYear();
  }
  // "Sat 14 Nov 2026, 10:06" (for the title of a date cell)
  function fullTime(ms) {
    if (!isNum(ms)) return "";
    var d = new Date(ms), mm = d.getMinutes();
    return WEEKDAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() + ", " + d.getHours() + ":" + (mm < 10 ? "0" : "") + mm;
  }
  function lastAskedText(row, now) { return row && isNum(row.lastAskedAt) ? dayLabel(row.lastAskedAt, now) : "never"; }
  function nextDueText(row, now) { return row && row.due > 0 ? "now" : dayLabel(row ? row.nextDueAt : null, now); }
  // "1.7" for a growth factor that reads lower than the full one (D28: a prompt answered wrong grows more slowly);
  // "" for the full factor, for one that rounds to it, and while the next card was never asked.
  function growthText(row) {
    var sc = dep("scheduler"), full = sc && isNum(sc.GROWTH_FULL) ? sc.GROWTH_FULL : 2300;
    if (!row || !isNum(row.growth) || !(row.growth < full)) return "";
    var text = (row.growth / 1000).toFixed(1);
    return text === (full / 1000).toFixed(1) ? "" : text;
  }
  // "5 d", or "1 d · ×1.7" while the wait grows more slowly than 2.3 times
  function waitText(row) {
    if (!row || !isNum(row.intervalMs)) return "—";
    var u = dep("util"), g = growthText(row);
    var wait = u && typeof u.fmtInterval === "function" ? u.fmtInterval(row.intervalMs) : Math.round(row.intervalMs / DAY) + " d";
    return g ? wait + " · ×" + g : wait;
  }
  function waitTitle(row) {
    var g = growthText(row);
    return g ? "After a right answer this wait grows " + g + " times, not 2.3 times: the prompt was answered wrong" : null;
  }
  function totalsText(t) {
    var parts = [plural(t.prompts, "prompt"), plural(t.cards, "card"), t.due + " due now", t.neverAsked + " never asked", plural(t.answers, "answer")];
    parts.push(t.wrong + " wrong" + (t.answers > 0 ? " (" + Math.round(100 * t.wrong / t.answers) + "%)" : ""));
    return parts.join(" · ");
  }
  // The day of a "Coming due" column: "today" | "tomorrow" | "Tue 17 Nov"
  function slotLabel(day, now) {
    var l = dayLabel(day.at, now);
    if (l === "today" || l === "tomorrow") return l;
    return WEEKDAYS[new Date(day.at).getDay()] + " " + l;
  }
  // What the chart says to a screen reader: the days that have cards, the first SUMMARY_DAYS of them.
  function forecastSummary(fc, now) {
    var named = fc.days.filter(function (d) { return d.count > 0; });
    if (!named.length) return "Cards coming due in the next " + fc.days.length + " days: none." + (fc.later ? " Later: " + plural(fc.later, "card") + "." : "");
    var parts = named.slice(0, SUMMARY_DAYS).map(function (d) { return slotLabel(d, now) + " " + d.count; });
    var s = "Cards coming due in the next " + fc.days.length + " days: " + parts.join(", ");
    if (named.length > SUMMARY_DAYS) s += ", and " + plural(named.length - SUMMARY_DAYS, "more day");
    return s + "." + (fc.later ? " Later: " + plural(fc.later, "card") + "." : "");
  }
  // The columns that carry their number: today's and the highest (the others show theirs on hover and in the list).
  function labelled(fc) {
    var set = {}, best = -1;
    if (fc.days.length && fc.days[0].count > 0) set[0] = true;
    for (var i = 0; i < fc.days.length; i++) if (fc.days[i].count > 0 && (best < 0 || fc.days[i].count > fc.days[best].count)) best = i;
    if (best >= 0) set[best] = true;
    return set;
  }

  // ---- DOM ------------------------------------------------------------------------------------------------------------

  var st = { open: false, book: "", show: "", sort: { key: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir }, offs: [], timer: null };

  function hasDom() { return typeof document !== "undefined" && !!document && typeof document.createElement === "function"; }
  function host() { return hasDom() && typeof document.getElementById === "function" ? document.getElementById("stats") : null; }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "text") el.textContent = v;
        else if (k === "class") el.className = v;
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function on(el, type, fn) { el.addEventListener(type, fn); return el; }

  // A prompt's question as HTML, from M.markup.render (mode "list": formulas by KaTeX, a sentence's hidden parts
  // marked, everything else escaped), as the prompt list draws it. null without M.markup: the caller shows the text.
  // Kept between redraws by the question's source. A draw never drops what it needs itself (a store smaller than
  // one page would render every question again on every draw); after a draw, entries that draw did not use go,
  // oldest first, down to HTML_CACHE_MAX.
  var htmlCache = new Map(), htmlUsed = null;            // htmlUsed: the sources of the draw in progress
  function trimHtmlCache(used) {
    if (htmlCache.size <= HTML_CACHE_MAX) return;
    var drop = [];
    htmlCache.forEach(function (v, key) { if (!used || !used.has(key)) drop.push(key); });
    for (var i = 0; i < drop.length && htmlCache.size > HTML_CACHE_MAX; i++) htmlCache.delete(drop[i]);
  }
  function questionHtml(source) {
    var mk = M.markup || tryDep("markup");
    if (!mk || typeof mk.render !== "function") return null;
    var key = str(source);
    if (htmlUsed) htmlUsed.add(key);
    if (htmlCache.has(key)) return htmlCache.get(key);
    var html = null;
    try {
      html = mk.render(key, { mask: null, mode: "list", imageUrl: function (id) {
        var A = M.attachments;
        try { return A && typeof A.url === "function" ? A.url(id) : null; } catch (e) { return null; }
      } });
    } catch (e) { html = null; }
    if (typeof html !== "string") return null;
    if (html.indexOf(IMAGE_MISSING) >= 0) return html;      // an image still loading: not kept, so the next draw shows it
    htmlCache.set(key, html);
    return html;
  }

  function subscribe() {
    var bus = M.bus;
    if (!bus || typeof bus.on !== "function") return;
    EVENTS.forEach(function (type) { try { st.offs.push(bus.on(type, function () { schedule(type); })); } catch (e) { /* ignore */ } });
  }
  function unsubscribe() {
    st.offs.forEach(function (off) { try { if (typeof off === "function") off(); } catch (e) { /* ignore */ } });
    st.offs = [];
  }
  function reviewRuns() {
    var R = M.review;
    try { return !!(R && typeof R.isActive === "function" && R.isActive()); } catch (e) { return false; }
  }
  // A review over the page saves a prompt with every answer. The page is hidden then, so it waits and is drawn
  // again once, when the review ends (review:ended comes at the session's end and at stop()).
  function schedule(type) {
    if (!st.open) return;
    if (type !== REVIEW_ENDED && reviewRuns()) return;
    if (st.timer) return;
    st.timer = setTimeout(function () { st.timer = null; if (st.open) render(); }, REDRAW_MS);
  }

  function open() {
    var el = host();
    if (!el) return false;
    var entering = !st.open;
    if (entering) { st.open = true; subscribe(); }
    render();
    if (entering) {                                        // the page's heading takes the focus, so a screen reader names the page
      var title = el.querySelector(".stats__title");
      if (title) { try { title.focus({ preventScroll: true }); } catch (e) { try { title.focus(); } catch (e2) { /* ignore */ } } }
    }
    return true;
  }
  function close() {
    unsubscribe();
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    var was = st.open;
    st.open = false;
    var el = host();
    if (el) clear(el);
    return was;
  }
  function isOpen() { return st.open; }

  function goLibrary() { var app = M.app; if (app && typeof app.route === "function") { try { app.route("library"); } catch (e) { /* ignore */ } } }
  // Esc on a filter: M.app does not route keys typed in a form field, so the page answers there itself.
  function escToLibrary(ev) {
    if (!ev || ev.key !== "Escape" || ev.defaultPrevented) return;
    try { ev.preventDefault(); } catch (e) { /* synthetic */ }
    goLibrary();
  }
  function openPrompt(row, ev) {
    var app = M.app, params = { collectionId: row.collectionId, promptId: row.id };
    // D30: a Cmd+click (Ctrl off the Mac) opens the prompt's book in a new tab; the page stays here
    try { if (ev && M.tabs && typeof M.tabs.wantsTab === "function" && M.tabs.wantsTab(ev)) { M.tabs.go(ev, "reader", params); return; } } catch (e0) { /* as a plain click */ }
    if (!app || typeof app.route !== "function") return;
    try { app.route("reader", params); } catch (e) { /* ignore */ }   // a deck prompt opens its deck
  }
  function setSort(key) {
    var col = column(key);
    if (!col) return;
    if (st.sort.key === key) st.sort = { key: key, dir: st.sort.dir === "asc" ? "desc" : "asc" };
    else st.sort = { key: key, dir: col.first };
    render();
  }

  // The element that holds the keyboard focus is found again after a redraw by its data-focus value.
  function focusKey(el) {
    var a = hasDom() ? document.activeElement : null;
    for (; a && a !== el && a.nodeType === 1; a = a.parentNode) {
      var k = typeof a.getAttribute === "function" ? a.getAttribute("data-focus") : null;
      if (k) return k;
    }
    return null;
  }
  function refocus(el, key) {
    if (!key) return;
    var list = el.querySelectorAll("[data-focus]");
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute("data-focus") === key) { try { list[i].focus({ preventScroll: true }); } catch (e) { try { list[i].focus(); } catch (e2) { /* ignore */ } } return; }
    }
  }

  function chartEl(fc, now) {
    var marks = labelled(fc);
    var plot = h("div", { class: "stats__plot" }), axis = h("div", { class: "stats__axis", "aria-hidden": "true" });
    var tip = h("div", { class: "stats__tip is-hidden" });
    fc.days.forEach(function (d, i) {
      var slot = h("div", { class: "stats__slot", "data-i": String(i) });
      if (d.count > 0) {
        var pct = Math.round(1000 * d.count / fc.max) / 10;
        var colEl = h("span", { class: "stats__col" });
        colEl.style.height = pct + "%";
        if (marks[i]) {
          var val = h("span", { class: "stats__val", text: String(d.count) });
          val.style.bottom = pct + "%";
          slot.appendChild(val);
        }
        slot.appendChild(colEl);
      }
      plot.appendChild(slot);
      var tick = h("span", { class: "stats__tick" });
      if (i % AXIS_EVERY === 0) tick.appendChild(h("span", { class: "stats__tick-label", text: i === 0 ? "today" : dayLabel(d.at, now) }));
      axis.appendChild(tick);
    });
    function show(slot) {
      var i = Number(slot.getAttribute("data-i")), d = fc.days[i];
      if (!d) return;
      clear(tip);
      tip.appendChild(h("strong", { class: "stats__tip-value", text: plural(d.count, "card") }));
      tip.appendChild(h("span", { class: "stats__tip-label", text: slotLabel(d, now) }));
      tip.classList.remove("is-hidden");
      // centred over its column and kept inside the plot: by its own width when the page has a layout
      var share = (i + 0.5) / fc.days.length, w = tip.offsetWidth || 0, pw = plot.clientWidth || 0;
      if (w > 0 && pw > 0) tip.style.left = Math.round(Math.min(Math.max(pw - w / 2, w / 2), Math.max(w / 2, share * pw))) + "px";
      else tip.style.left = Math.min(92, Math.max(8, share * 100)) + "%";
    }
    function hide() { tip.classList.add("is-hidden"); }
    on(plot, "pointerover", function (ev) {
      var t = ev.target && typeof ev.target.closest === "function" ? ev.target.closest(".stats__slot") : null;
      if (t) show(t);
    });
    on(plot, "pointerleave", hide);
    on(plot, "pointercancel", hide);
    on(plot, "pointerup", function (ev) { if (ev && ev.pointerType === "touch") setTimeout(hide, TOUCH_TIP_MS); });   // a finger never "leaves"
    return h("div", { class: "stats__chart", role: "img", "aria-label": forecastSummary(fc, now) }, [tip, plot, axis]);
  }

  function listEl(fc, now) {
    var items = fc.days.filter(function (d) { return d.count > 0; }).map(function (d) {
      return h("li", null, [h("span", { class: "stats__list-day", text: slotLabel(d, now) }), h("span", { class: "stats__list-n", text: plural(d.count, "card") })]);
    });
    if (fc.later) items.push(h("li", null, [h("span", { class: "stats__list-day", text: "later" }), h("span", { class: "stats__list-n", text: plural(fc.later, "card") })]));
    if (!items.length) items.push(h("li", null, [h("span", { class: "stats__list-day", text: "nothing is scheduled" })]));
    return h("details", { class: "stats__list" }, [h("summary", { "data-focus": "list", text: "Show as a list" }), h("ul", null, items)]);
  }

  function tableEl(sorted, now) {
    var head = h("tr", null, COLUMNS.map(function (col) {
      var active = st.sort.key === col.key;
      var btn = h("button", { type: "button", class: "stats__sort", "data-focus": "sort:" + col.key, "data-sort": col.key,
        title: "Sort by " + col.label.toLowerCase() }, [
        h("span", { text: col.label }),
        h("span", { class: "stats__arrow", "aria-hidden": "true", text: active ? (st.sort.dir === "asc" ? "▲" : "▼") : "" })
      ]);
      on(btn, "click", function () { setSort(col.key); });
      return h("th", { scope: "col", class: col.num ? "stats__num" : null, "aria-sort": active ? (st.sort.dir === "asc" ? "ascending" : "descending") : "none" }, [btn]);
    }));
    var body = h("tbody", null, sorted.map(function (r) {
      var q = h("span", { class: "stats__q" }), html = questionHtml(r.source);
      if (html !== null && html !== "") q.innerHTML = html;      // M.markup.render's output: the page's only HTML
      else q.textContent = r.text || "(empty)";
      var openBtn = h("button", { type: "button", class: "stats__open", "data-focus": "row:" + r.id, title: "Open in its book", "aria-label": (r.text || "(empty)") + " — open in its book" }, [q]);
      on(openBtn, "click", function (ev) { openPrompt(r, ev); });
      var first = h("td", { class: "stats__prompt" }, [
        openBtn,
        r.flagged ? h("span", { class: "stats__flag", title: "Flagged for revision", text: "⚑" }) : null,
        r.struggling ? h("span", { class: "stats__chip", title: "Forgotten on " + plural(r.missDays, "day"), text: "struggling" }) : null
      ]);
      return h("tr", { class: "stats__row" + (r.due > 0 ? " stats__row--due" : ""), "data-id": str(r.id) }, [
        first,
        h("td", { class: "stats__book", text: r.book }),
        h("td", { class: "stats__num", text: String(r.cards) }),
        h("td", { class: "stats__date", title: isNum(r.lastAskedAt) ? fullTime(r.lastAskedAt) : "Never asked", text: lastAskedText(r, now) }),
        h("td", { class: "stats__date", title: r.due > 0 ? plural(r.due, "card") + " due now" : fullTime(r.nextDueAt), text: nextDueText(r, now) }),
        h("td", { class: "stats__date", title: waitTitle(r), text: waitText(r) }),
        h("td", { class: "stats__num", text: String(r.answers) }),
        h("td", { class: "stats__num", text: String(r.wrong) })
      ]);
    }));
    var table = h("table", { class: "stats__table" }, [h("thead", null, [head]), body]);
    return h("div", { class: "stats__scroll" }, [table]);
  }

  function render() {
    var el = host();
    if (!el) return;
    var keep = focusKey(el), now = Date.now(), c = M.cache;
    // what a redraw must not lose: the open "Show as a list" and the table's sideways scroll
    htmlUsed = new Set();
    var oldList = el.querySelector(".stats__list"), oldScroll = el.querySelector(".stats__scroll");
    var listOpen = !!(oldList && oldList.open), scrollLeft = oldScroll && oldScroll.scrollLeft > 0 ? oldScroll.scrollLeft : 0;
    var prompts = c && typeof c.prompts === "function" ? c.prompts() : [];
    var cols = c && typeof c.collections === "function" ? c.collections() : [];
    var all = rows(prompts, cols, now);

    // the books and decks that have a row, by name
    var seen = new Map();
    all.forEach(function (r) { var b = seen.get(r.collectionId); if (b) b.n++; else seen.set(r.collectionId, { id: r.collectionId, name: r.book, n: 1 }); });
    var books = Array.from(seen.values()).sort(function (a, b) { var x = a.name.toLowerCase(), y = b.name.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
    if (st.book && !seen.has(st.book)) st.book = "";
    st.show = showOf(st.show).id;
    var inBook = st.book ? all.filter(function (r) { return r.collectionId === st.book; }) : all;
    var shown = filterRows(inBook, st.show);
    var ids = new Set(shown.map(function (r) { return r.id; }));
    var fc = forecast(prompts.filter(function (p) { return p && ids.has(p.id); }), cols, now, FORECAST_DAYS);

    var back = on(h("button", { type: "button", class: "btn btn--ghost stats__back", "data-focus": "back", text: "‹ Library" }), "click", goLibrary);
    var kids = [h("header", { class: "stats__header" }, [back, h("h1", { class: "stats__title", tabindex: "-1", "data-focus": "title", text: "Statistics" })])];

    if (!all.length) {
      kids.push(h("p", { class: "stats__empty", text: "No prompts to review yet" }));
      kids.push(h("p", { class: "stats__hint", text: "Q./A. and cloze prompts show here once you write them. Notes and highlights are not reviewed." }));
    } else {
      var select = h("select", { class: "stats__select", "data-focus": "book", "aria-label": "Book or deck" },
        [h("option", { value: "", text: "All books and decks (" + all.length + ")" })].concat(books.map(function (b) {
          return h("option", { value: str(b.id), text: b.name + " (" + b.n + ")" });
        })));
      select.value = st.book;
      on(select, "change", function () { st.book = select.value; render(); });
      on(select, "keydown", escToLibrary);
      // "Show": each choice with the number of rows it keeps in the chosen book
      var showSel = h("select", { class: "stats__select", "data-focus": "show", "aria-label": "Show" }, SHOWS.map(function (s) {
        return h("option", { value: s.id, text: s.label + " (" + filterRows(inBook, s.id).length + ")" });
      }));
      showSel.value = st.show;
      on(showSel, "change", function () { st.show = showSel.value; render(); });
      on(showSel, "keydown", escToLibrary);
      kids.push(h("div", { class: "stats__bar" }, [select, showSel, h("p", { class: "stats__totals", text: totalsText(totals(shown)) })]));

      kids.push(h("section", { class: "stats__card stats__due" }, [
        h("h2", { class: "stats__h", text: "Coming due" }),
        h("p", { class: "stats__sub", text: "Cards per day, today and the next " + (FORECAST_DAYS - 1) + " days" }),
        chartEl(fc, now),
        fc.later ? h("p", { class: "stats__later", text: "Later than these " + FORECAST_DAYS + " days: " + plural(fc.later, "card") }) : null,
        listEl(fc, now)
      ]));

      kids.push(h("section", { class: "stats__card stats__prompts" }, [
        h("h2", { class: "stats__h", text: "Prompts" }),
        h("p", { class: "stats__sub", text: "A header sorts the table. A prompt opens in its book." }),
        shown.length ? tableEl(sortRows(shown, st.sort.key, st.sort.dir), now) : h("p", { class: "stats__none", text: "No prompt matches." })
      ]));
    }
    clear(el);
    el.appendChild(h("div", { class: "stats" }, kids));
    var newList = el.querySelector(".stats__list"), newScroll = el.querySelector(".stats__scroll");
    if (listOpen && newList) newList.open = true;
    if (scrollLeft && newScroll) newScroll.scrollLeft = scrollLeft;
    trimHtmlCache(htmlUsed);
    htmlUsed = null;
    refocus(el, keep);
  }

  var api = {
    FORECAST_DAYS: FORECAST_DAYS, COLUMNS: COLUMNS.map(function (c) { return { key: c.key, label: c.label, first: c.first, num: !!c.num }; }),
    SHOWS: SHOWS.map(function (s) { return { id: s.id, label: s.label }; }),
    rows: rows, totals: totals, forecast: forecast, sortRows: sortRows, filterRows: filterRows,
    dayLabel: dayLabel, fullTime: fullTime, lastAskedText: lastAskedText, nextDueText: nextDueText, waitText: waitText,
    growthText: growthText, waitTitle: waitTitle,
    totalsText: totalsText, slotLabel: slotLabel, forecastSummary: forecastSummary, labelled: labelled,
    open: open, close: close, isOpen: isOpen, render: function () { if (st.open) render(); },
    sort: function () { return { key: st.sort.key, dir: st.sort.dir }; },
    filters: function () { return { book: st.book, show: st.show }; },
    // show(id) picks a "Show" choice ("" | "due" | "never" | "flagged" | "struggling") and redraws an open page
    show: function (id) { st.show = showOf(id).id; if (st.open) render(); return st.show; },
    // reset() goes back to all books, all prompts and the first sort order, and redraws an open page
    reset: function () { st.book = ""; st.show = ""; st.sort = { key: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir }; if (st.open) render(); },
    _cacheSize: function () { return htmlCache.size; }      // for the tests: the rendered questions kept now
  };
  M.stats = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.stats; BUILD-NOTES "Scheduling and statistics"):
 * open() → boolean (renders into #stats; false without a DOM or the host); close() → boolean (was it open); isOpen();
 * render() (redraws when open); sort() → {key, dir}.
 * Pure: rows(prompts, collections, now) → [{id, collectionId, book, kind, text, source, flagged, createdAt, cards, neverAsked,
 * due, lastAskedAt|null, nextDueAt|null, intervalMs|null, growth|null, answers, wrong, missDays, struggling}]
 * (D28, D29: due = the cards M.scheduler.isReady, nextDueAt = the smallest M.scheduler.readyTime (the time from which
 * a session can ask a card of the prompt), intervalMs = that card's M.scheduler.waitOf, growth = its growth factor in
 * thousandths);
 * totals(rows) → {prompts, cards, due, neverAsked, answers, wrong};
 * forecast(prompts, collections, now, days = 30) → {days: [{at, dayKey, count}], later, max, total};
 * sortRows(rows, key, dir) → a sorted copy (missing values first ascending); filterRows(rows, show) → the rows a
 * "Show" choice keeps; SHOWS [{id, label}] ("", due, never, flagged, struggling); filters() → {book, show};
 * show(id) → the choice now in force; reset() (all books, all prompts, the first sort order); dayLabel(ms, now); fullTime(ms);
 * lastAskedText(row, now); nextDueText(row, now); waitText(row) ("1 d · ×1.7" while the factor reads below 2.3);
 * growthText(row); waitTitle(row); totalsText(totals); slotLabel(day, now);
 * forecastSummary(forecast, now); labelled(forecast) → {index: true}. FORECAST_DAYS 30; COLUMNS [{key, label, first, num}].
 * Calls only: M.scheduler.{neverAsked, isReady, readyTime, waitOf, growthOf, GROWTH_FULL, promptMissDays, STRUGGLE_DAYS}; M.util.{localMidnight, dayKey,
 * fmtInterval}; M.similar.oneLine; M.prompts.parse; M.markup.render; M.attachments.url; M.cache.{prompts, collections};
 * M.review.isActive; M.bus.on; M.app.route. Writes nothing. */
