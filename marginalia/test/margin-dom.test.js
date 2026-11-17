"use strict";
// Marginalia — test/margin-dom.test.js: js/margin.js mounted on a small fake DOM, with the real util, bus,
// settings, store (memory), scheduler, prompts, context, keys, layout, markup, cache and app modules.
//  - A record edited in place and saved (the prompt list's ⋯ → Edit edits M.cache's live object, which the
//    cache re-emits), i.e. a prompt:saved carrying the very object the card already holds, re-renders the
//    card: the margin diffs against what the card shows, not against the record it holds.
//  - Enter (run("toggleAnswer") through app.handleKeydown) toggles the focused card's answer only while no
//    control has the DOM focus, so a toolbar button, card-menu item, ⋯ button, .hl-badge or link keeps its
//    native click (the keydown is not preventDefault()-ed).
//  - reader:mode {mode, compact} with a new --card-w (256 ↔ 192) re-measures the rendered cards and re-runs the
//    cascade inside the event (same frame); .margin--pinned follows the scroller's horizontal overflow and scroll.
//  - the card with the open editor (an existing card's or a new one's) is measured on that width change, not
//    estimated from its saved text, so the cards below never overlap the editor for a frame;
//  - J / K scroll sideways too when the passage would sit under the pinned margin (M.reader.scrollLeftFor), in the
//    same smooth scroll as the vertical move.
// Run: node --test test/margin-dom.test.js
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ---- fake DOM: what margin.js and app.handleKeydown touch -----------------------------------------------
const VOID = /^(br|img|input|hr|meta|link|path|col|source|wbr)$/i;

function bag(target) { return target._listeners || (target._listeners = {}); }
function on(target, type, fn) { (bag(target)[type] = bag(target)[type] || []).push(fn); }
function off(target, type, fn) { const l = bag(target)[type]; const i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); }
function callListeners(target, ev) { (bag(target)[ev.type] || []).slice().forEach((fn) => fn.call(target, ev)); }
function decode(s) { return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&"); }

// Compound selectors ("tag.a.b#id[attr=\"v\"]") in comma lists, no combinators: all that is needed here.
function matchCompound(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  const m = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(sel.trim());
  if (!m) return false;
  if (m[1] && m[1] !== "*" && el.tagName !== m[1].toUpperCase()) return false;
  return (m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || []).every((p) => {
    if (p[0] === ".") return el.classList.contains(p.slice(1));
    if (p[0] === "#") return el.id === p.slice(1);
    const a = /^\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]$/.exec(p);
    if (!a) return false;
    const v = el.getAttribute(a[1]);
    const want = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4];
    return v != null && (want == null || v === want);
  });
}
function matches(el, sel) { return String(sel).split(",").some((s) => matchCompound(el, s)); }

function makeText(s) { return { nodeType: 3, nodeName: "#text", textContent: s, parentNode: null }; }
function parseInto(doc, root, html) {
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g, stack = [root];
  let t;
  while ((t = re.exec(html))) {
    const parent = stack[stack.length - 1];
    if (t[3] !== undefined) { parent.appendChild(makeText(decode(t[3]))); continue; }
    if (t[0][1] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const child = makeElement(doc, t[1]);
    const ar = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = ar.exec(t[2]))) child.setAttribute(a[1], decode(a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : ""));
    parent.appendChild(child);
    if (!/\/\s*$/.test(t[2]) && !VOID.test(t[1])) stack.push(child);
  }
}

function makeElement(doc, tag) {
  const el = {
    nodeType: 1, tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(), ownerDocument: doc,
    parentNode: null, childNodes: [], attributes: {}, style: {}, dataset: {}, id: "", tabIndex: -1,
    scrollTop: 0, clientHeight: 0, offsetHeight: 0, _html: "", _text: null
  };
  const classes = new Set();
  el.classList = {
    add(...c) { c.forEach((x) => classes.add(String(x))); },
    remove(...c) { c.forEach((x) => classes.delete(String(x))); },
    toggle(c, force) { const want = force === undefined ? !classes.has(c) : !!force; if (want) classes.add(c); else classes.delete(c); return want; },
    contains(c) { return classes.has(c); }
  };
  Object.defineProperty(el, "className", {
    get() { return Array.from(classes).join(" "); },
    set(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); }
  });
  Object.defineProperty(el, "children", { get() { return el.childNodes.filter((n) => n.nodeType === 1); } });
  Object.defineProperty(el, "firstChild", { get() { return el.childNodes[0] || null; } });
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(v) { el.childNodes.slice().forEach((c) => el.removeChild(c)); el._html = String(v); el._text = null; parseInto(doc, el, el._html); }
  });
  Object.defineProperty(el, "textContent", {
    get() { return el._text != null ? el._text : el.childNodes.map((c) => c.textContent).join(""); },
    set(v) { el.childNodes.slice().forEach((c) => el.removeChild(c)); el._html = ""; el._text = String(v); }
  });
  el.setAttribute = (k, v) => {
    k = String(k); v = String(v);
    el.attributes[k] = v;
    if (k === "class") el.className = v;
    else if (k === "id") el.id = v;
    else if (k === "tabindex") el.tabIndex = Number(v);
  };
  el.getAttribute = (k) => (k === "id" && el.id ? el.id : Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null);
  el.hasAttribute = (k) => Object.prototype.hasOwnProperty.call(el.attributes, k);
  el.removeAttribute = (k) => { delete el.attributes[k]; };
  el.insertBefore = (c, ref) => {
    if (c.nodeType === 11) { c.childNodes.slice().forEach((k) => el.insertBefore(k, ref)); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? el.childNodes.indexOf(ref) : -1;
    if (i < 0) el.childNodes.push(c); else el.childNodes.splice(i, 0, c);
    c.parentNode = el;
    return c;
  };
  el.appendChild = (c) => el.insertBefore(c, null);
  el.removeChild = (c) => {
    const i = el.childNodes.indexOf(c);
    if (i >= 0) el.childNodes.splice(i, 1);
    c.parentNode = null;
    if (c.nodeType === 1 && c.contains(doc.activeElement)) doc.activeElement = doc.body;   // as a browser does
    return c;
  };
  el.contains = (n) => { for (; n; n = n.parentNode) if (n === el) return true; return false; };
  el.querySelectorAll = (sel) => {
    const out = [];
    (function walk(n) { n.childNodes.forEach((c) => { if (c.nodeType === 1) { if (matches(c, sel)) out.push(c); walk(c); } }); })(el);
    return out;
  };
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  el.closest = (sel) => { for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; };
  el.matches = (sel) => matches(el, sel);
  el.addEventListener = (type, fn) => on(el, type, fn);
  el.removeEventListener = (type, fn) => off(el, type, fn);
  el.dispatchEvent = (ev) => { callListeners(el, ev); return !ev.defaultPrevented; };
  el.focus = () => { doc.activeElement = el; callListeners(el, { type: "focus", target: el }); };
  el.blur = () => { if (doc.activeElement === el) doc.activeElement = doc.body; };
  el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  el.scrollTo = (o) => { if (o && typeof o.top === "number") el.scrollTop = o.top; };
  return el;
}

function makeDocument() {
  const doc = { nodeType: 9, parentNode: null };
  doc.createElement = (tag) => makeElement(doc, tag);
  doc.createElementNS = (ns, tag) => makeElement(doc, tag);
  doc.createTextNode = (s) => makeText(String(s));
  doc.createDocumentFragment = () => { const f = makeElement(doc, "#fragment"); f.nodeType = 11; return f; };
  doc.documentElement = makeElement(doc, "html");
  doc.body = makeElement(doc, "body");
  doc.documentElement.appendChild(doc.body);
  doc.documentElement.parentNode = doc;
  doc.activeElement = doc.body;
  doc.contains = (n) => doc.documentElement.contains(n);
  doc.getElementById = (id) => doc.documentElement.querySelector("#" + id);
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.addEventListener = (type, fn) => on(doc, type, fn);
  doc.removeEventListener = (type, fn) => off(doc, type, fn);
  // the BUILD-NOTES hosts this test needs: #reader > #toolbar, #scroller > (#pages, #margin), #sheet
  doc.body.innerHTML = '<div id="app"><section id="reader" tabindex="-1"><div id="toolbar" role="toolbar"></div>' +
    '<div id="scroller"><div class="gutter"></div><div id="pages"></div><div id="margin"></div></div>' +
    '<div id="sheet" class="is-hidden"></div></section></div>';
  doc.getElementById("scroller").clientHeight = 800;
  return doc;
}

// ---- events -------------------------------------------------------------------------------------------
function makeEvent(type, target, key) {
  const ev = { type, key, code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false,
    isComposing: false, keyCode: 0, target, defaultPrevented: false, stopped: false };
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  ev.stopPropagation = () => { ev.stopped = true; };
  return ev;
}
function bubble(ev) { for (let n = ev.target; n && n.nodeType === 1 && !ev.stopped; n = n.parentNode) callListeners(n, ev); }
// A keydown as a browser delivers it: element listeners from the target up, then app's one document listener.
function press(key, target) {
  const ev = makeEvent("keydown", target, key);
  bubble(ev);
  const handled = ev.stopped ? false : M.app.handleKeydown(ev);
  return { ev, handled };
}
function click(target) { const ev = makeEvent("click", target); bubble(ev); return ev; }
// Enter on a focused button: when the keydown is not cancelled the browser fires the button's click.
function enterOnButton(button) {
  const r = press("Enter", button);
  if (!r.ev.defaultPrevented) click(button);
  return r;
}
const tick = (n) => new Promise((resolve) => { (function loop(i) { if (i <= 0) return resolve(); setTimeout(() => loop(i - 1), 2); })(n || 6); });

// ---- setup --------------------------------------------------------------------------------------------
let M, doc;
const ANCHOR = { pageIndex: 0, y: 700, quote: "a passage", prefix: "", suffix: "", pages: [{ pageIndex: 0, rects: [[10, 690, 200, 710]] }], lost: false };

before(async () => {
  doc = makeDocument();
  globalThis.document = doc;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  const JS = path.join(__dirname, "..", "js");
  for (const name of ["util", "bus", "settings", "store", "scheduler", "prompts", "context", "keys", "layout", "markup", "cache", "app", "margin"]) {
    require(path.join(JS, name + ".js"));
  }
  M = globalThis.Marginalia;
  await M.cache.load();
  await M.cache.saveCollection({ id: "book_1", kind: "book", name: "Book" });
  await M.cache.savePrompt({ id: "p_1", collectionId: "book_1", kind: "qa", text: "Q. old question\nA. old answer", anchor: ANCHOR, context: null, cards: [] }, { content: true });
  M.app.setFocusOwner("reader");
  M.margin.mount(doc.getElementById("scroller"), doc.getElementById("margin"));
  M.bus.emit("doc:opened", { collectionId: "book_1" });
  M.bus.emit("pages:measured", { pageTops: [0], pageHeights: [1200] });
  await tick();
});

function cardEl() { return doc.querySelector('.card[data-id="p_1"]'); }

// ---- prompt:saved with the cache's live record ---------------------------------------------------------
test("a record edited in place and saved (the cache's live object) re-renders its card", async () => {
  const card = cardEl();
  assert.ok(card, "the card exists");
  assert.equal(M.margin.readerMode(), "wide");
  assert.equal(card.classList.contains("card--placeholder"), false, "the card is rendered (near the viewport)");
  const body = card.querySelector(".card__body"), pill = card.querySelector(".card__pill");
  assert.match(body.innerHTML, /old question/);

  let held = null;                                          // the record the last prompt:saved carried (the card holds it)
  const offSaved = M.bus.on("prompt:saved", (pl) => { if (pl && pl.prompt && pl.prompt.id === "p_1") held = pl.prompt; });
  try {
    // What list.js saveEdit does: edit the cache's live record in place, then M.cache.savePrompt(it).
    const live = M.cache.prompt("p_1");
    live.text = "Q. new question\nA. new answer";
    await M.cache.savePrompt(live, { content: true });
    assert.match(body.innerHTML, /new question/);
    assert.match(body.innerHTML, /new answer/);
    assert.doesNotMatch(body.innerHTML, /old (question|answer)/);
    assert.match(pill.textContent, /^new question/);

    // At the margin's boundary, whatever M.cache does with records: prompt:saved carrying the very object
    // the card already holds, edited in place (what the cache re-emits for an in-place edit).
    assert.ok(held, "prompt:saved was emitted");
    held.text = "Q. held question\nA. held answer";
    M.bus.emit("prompt:saved", { prompt: held, isNew: false });
    assert.match(body.innerHTML, /held question/);
    assert.match(pill.textContent, /^held question/);

    // The anchor edited in place (the same anchor object): the "Passage not found" chip follows it.
    held.anchor.lost = true;
    M.bus.emit("prompt:saved", { prompt: held, isNew: false });
    assert.ok(card.classList.contains("card--lost"));
    assert.match(body.innerHTML, /Passage not found/);
    held.anchor.lost = false;
    M.bus.emit("prompt:saved", { prompt: held, isNew: false });
    assert.equal(card.classList.contains("card--lost"), false);
    assert.doesNotMatch(body.innerHTML, /Passage not found/);

    // A flag-only change (in place) updates the classes; the body stays as rendered.
    const shown = body.innerHTML;
    held.flagged = true;
    M.bus.emit("prompt:saved", { prompt: held, isNew: false });
    assert.ok(card.classList.contains("card--flagged"));
    assert.equal(body.innerHTML, shown);
    held.flagged = false;
    M.bus.emit("prompt:saved", { prompt: held, isNew: false });
    assert.equal(card.classList.contains("card--flagged"), false);

    // A copy (the margin's own way of saving) re-renders too.
    await M.cache.savePrompt(Object.assign({}, M.cache.prompt("p_1"), { text: "Q. third question\nA. z", flagged: false }), { content: true });
    assert.match(body.innerHTML, /third question/);
  } finally {
    offSaved();
  }
  await tick();
});

// ---- Enter and focused controls ------------------------------------------------------------------------
test("Enter toggles the focused card's answer only while no control has the DOM focus", async () => {
  const card = cardEl();
  assert.equal(M.margin.focus("p_1", { scroll: false }), true);
  assert.equal(doc.activeElement, card);
  assert.equal(M.app.focusOwner(), "card");
  const answerHidden = () => card.classList.contains("card--closed");
  const hidden0 = answerHidden();

  let r = press("Enter", card);
  assert.equal(r.handled, true, "Enter on the focused card is the margin's");
  assert.equal(r.ev.defaultPrevented, true);
  assert.equal(answerHidden(), !hidden0, "the answer toggled");
  const hidden1 = answerHidden();

  // Esc → #reader; the card stays the focused one (roving tabindex); Tab → a toolbar button; Enter → its click.
  r = press("Escape", card);
  assert.equal(r.handled, true);
  assert.equal(doc.activeElement, doc.getElementById("reader"));
  assert.equal(M.margin.focusedId(), "p_1");
  let clicks = 0;
  const back = doc.createElement("button");
  back.className = "tb-btn tb-back";
  back.addEventListener("click", () => { clicks++; });
  doc.getElementById("toolbar").appendChild(back);
  back.focus();
  r = enterOnButton(back);
  assert.equal(r.handled, false, "Enter on a focused toolbar button is not routed to the card");
  assert.equal(r.ev.defaultPrevented, false, "…so the button keeps its native activation");
  assert.equal(clicks, 1);
  assert.equal(answerHidden(), hidden1, "the card did not toggle");
  assert.equal(M.margin.run("toggleAnswer"), false, "run() declines while a control has the focus");

  // A stack-mode .hl-badge, a link and an ARIA option keep their Enter too.
  const badge = doc.createElement("button");
  badge.className = "hl-badge hl-badge--qa";
  badge.tabIndex = 0;
  doc.getElementById("pages").appendChild(badge);
  badge.focus();
  r = press("Enter", badge);
  assert.equal(r.handled, false);
  assert.equal(r.ev.defaultPrevented, false);
  const link = doc.createElement("a");
  link.setAttribute("href", "#library");
  doc.getElementById("toolbar").appendChild(link);
  link.focus();
  assert.equal(press("Enter", link).ev.defaultPrevented, false);
  const option = doc.createElement("div");
  option.setAttribute("role", "option");
  option.tabIndex = 0;
  doc.getElementById("toolbar").appendChild(option);
  option.focus();
  assert.equal(press("Enter", option).ev.defaultPrevented, false);
  assert.equal(answerHidden(), hidden1);

  // The card's own ⋯ button: Enter is its click (opens the menu), not a toggle.
  const menuBtn = card.querySelector(".card__menu");
  menuBtn.focus();
  r = enterOnButton(menuBtn);
  assert.equal(r.handled, false);
  assert.equal(r.ev.defaultPrevented, false);
  assert.equal(answerHidden(), hidden1);
  const menu = card.querySelector(".menu");
  assert.ok(menu, "the native click opened the card menu");

  // ⋯ menu → ArrowDown ×4 → Enter on "Flag": the item fires (the prompt is flagged); the answer stays.
  // (FEATURES P2.2 / P2.3: "Split" and "Another angle…" follow "Edit", so Flag moved from the third to the fifth place.)
  const items = menu.querySelectorAll(".menu__item");
  assert.equal(doc.activeElement, items[0], "the first item has the focus");
  press("ArrowDown", doc.activeElement);
  press("ArrowDown", doc.activeElement);
  press("ArrowDown", doc.activeElement);
  press("ArrowDown", doc.activeElement);
  const flagItem = doc.activeElement;
  assert.equal(flagItem, items[4]);
  assert.match(flagItem.textContent, /^Flag/);
  assert.equal(!!M.cache.prompt("p_1").flagged, false);
  r = enterOnButton(flagItem);
  assert.equal(r.handled, false, "Enter on a menu item is the item's");
  assert.equal(r.ev.defaultPrevented, false);
  await tick();
  assert.equal(M.cache.prompt("p_1").flagged, true, "the Flag item fired");
  assert.ok(card.classList.contains("card--flagged"));
  assert.equal(card.querySelector(".menu"), null, "the menu closed");
  assert.equal(doc.activeElement, card, "focus is back on the card");
  assert.equal(answerHidden(), hidden1, "the answer did not toggle");

  // With the card focused again, Enter is the card's.
  r = press("Enter", card);
  assert.equal(r.handled, true);
  assert.equal(r.ev.defaultPrevented, true);
  assert.equal(answerHidden(), !hidden1);
  await tick();
});

// ---- compact card width and the pinned margin (BUILD-NOTES "Post-review decisions") ----------------------
test("a card-width change (reader:mode compact) re-measures and re-lays out at once; .margin--pinned follows the overflow", async () => {
  await M.cache.savePrompt({ id: "p_2", collectionId: "book_1", kind: "qa", text: "Q. second\nA. card", anchor: ANCHOR, context: null, cards: [], createdAt: Date.now() + 1000 }, { content: true });
  await tick();
  const c1 = cardEl(), c2 = doc.querySelector('.card[data-id="p_2"]');
  assert.ok(c1 && c2, "two cards on the same anchor");
  assert.equal(M.margin.cardWidth(), 256);
  const est = M.margin.estimateHeight(M.cache.prompt("p_1").text, null, 256);
  assert.equal(c2.style.top, (est + M.margin.GAP) + "px", "stacked under the first card's estimate");

  let cardW = 192;
  const hadGcs = Object.prototype.hasOwnProperty.call(globalThis, "getComputedStyle"), oldGcs = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: (prop) => (prop === "--card-w" ? " " + cardW + "px" : "") });
  try {
    // .reader--compact narrows the cards: the first one wraps to 76 px; the event re-measures and re-runs the cascade
    c1.offsetHeight = 76; c2.offsetHeight = 40;
    M.bus.emit("reader:mode", { mode: "wide", compact: true });
    assert.equal(M.margin.cardWidth(), 192);
    assert.equal(c2.style.top, (76 + M.margin.GAP) + "px", "moved under the re-measured card in the same frame");
    // and back to 256 px
    cardW = 256; c1.offsetHeight = 40;
    M.bus.emit("reader:mode", { mode: "wide", compact: false });
    assert.equal(M.margin.cardWidth(), 256);
    assert.equal(c2.style.top, (40 + M.margin.GAP) + "px");
    // the same width again: nothing to re-measure
    c1.offsetHeight = 99;
    M.bus.emit("reader:mode", { mode: "wide", compact: false });
    assert.equal(c2.style.top, (40 + M.margin.GAP) + "px");
  } finally {
    if (hadGcs) globalThis.getComputedStyle = oldGcs; else delete globalThis.getComputedStyle;
  }

  // pinned: the row is wider than the scroller and not scrolled to its end → the sticky margin sits over the page
  const sc = doc.getElementById("scroller"), mg = doc.getElementById("margin");
  const pinned = () => mg.classList.contains("margin--pinned");
  assert.equal(pinned(), false);
  sc.clientWidth = 1000; sc.scrollWidth = 1500; sc.scrollLeft = 0;
  M.bus.emit("scale:changed", { scale: 3 });
  assert.equal(pinned(), true, "zoomed past the room beside the margin");
  assert.equal(M.margin.isPinned(), true);
  sc.scrollLeft = 500; sc.dispatchEvent({ type: "scroll", target: sc });
  assert.equal(pinned(), false, "scrolled to the end: the margin is back in its own place, beside the page");
  sc.scrollLeft = 120; sc.dispatchEvent({ type: "scroll", target: sc });
  assert.equal(pinned(), true);
  sc.scrollWidth = 1000; sc.scrollLeft = 0;
  M.bus.emit("scale:changed", { scale: 1 });
  assert.equal(pinned(), false, "the page fits: nothing changes");
  sc.scrollWidth = 1500;
  M.bus.emit("scale:changed", { scale: 3 });
  assert.equal(pinned(), true);
  M.bus.emit("reader:mode", { mode: "stack", compact: false });
  assert.equal(pinned(), false, "stack mode has no margin");
  M.bus.emit("reader:mode", { mode: "wide", compact: false });
  await tick();
});

// ---- the open editor on a card-width change; J / K beside a pinned margin ------------------------------
test("a card-width change measures the card with the open editor (an existing card's or a new one's), not its saved text", async () => {
  const hadEditor = Object.prototype.hasOwnProperty.call(M, "editor"), oldEditor = M.editor;
  // a stand-in editor: margin.js only needs create / focus / destroy / run
  M.editor = { create: (o) => ({ focus() {}, destroy() { o.host.innerHTML = ""; }, run(id) { if (id === "cancel") o.onCancel(); return true; }, getText: () => "" }) };
  let cardW = 256;
  const hadGcs = Object.prototype.hasOwnProperty.call(globalThis, "getComputedStyle"), oldGcs = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: (prop) => (prop === "--card-w" ? " " + cardW + "px" : "") });
  try {
    M.bus.emit("reader:mode", { mode: "wide", compact: false });
    await tick();
    const c1 = cardEl(), c2 = doc.querySelector('.card[data-id="p_2"]');
    assert.ok(M.margin.openEditor({ promptId: "p_1" }), "the editor opens on the first card");
    c2.offsetHeight = 40;
    await tick();
    // narrower cards: the editor (textarea, preview, buttons) wraps to 333 px; its saved text alone estimates far less
    cardW = 192; c1.offsetHeight = 333;
    const estimate = M.margin.estimateHeight(M.cache.prompt("p_1").text, null, 192);
    assert.ok(estimate < 333, "the saved text's estimate (" + estimate + ") is not the editor's height");
    M.bus.emit("reader:mode", { mode: "wide", compact: true });
    assert.equal(c2.style.top, (333 + M.margin.GAP) + "px", "the next card clears the editor in the same frame");
    M.margin.closeEditor({ save: false });
    await tick();

    // a new card's editor (a temp card) is measured the same way
    cardW = 256; c1.offsetHeight = 40;
    M.bus.emit("reader:mode", { mode: "wide", compact: false });
    const ANCHOR2 = Object.assign({}, ANCHOR, { y: 650, pages: [{ pageIndex: 0, rects: [[10, 640, 200, 660]] }] });
    assert.ok(M.margin.openEditor({ promptId: null, anchor: ANCHOR2, initialText: "Q. " }), "a new card's editor");
    const temp = doc.querySelector(".card.card--editing");
    assert.ok(temp && /^new:/.test(temp.getAttribute("data-id")), "a temp card");
    temp.offsetHeight = 260;
    await tick();
    cardW = 192; temp.offsetHeight = 420;
    M.bus.emit("reader:mode", { mode: "wide", compact: true });
    const tempTop = parseFloat(temp.style.top), below = [cardEl(), doc.querySelector('.card[data-id="p_2"]')]
      .filter((c) => parseFloat(c.style.top) > tempTop);
    below.forEach((c) => assert.ok(parseFloat(c.style.top) >= tempTop + 420 + M.margin.GAP, c.getAttribute("data-id") + " clears the new card's editor"));
    M.margin.closeEditor({ save: false });
    assert.equal(doc.querySelector(".card.card--editing"), null);
    cardW = 256;
    M.bus.emit("reader:mode", { mode: "wide", compact: false });
    await tick();
  } finally {
    if (hadGcs) globalThis.getComputedStyle = oldGcs; else delete globalThis.getComputedStyle;
    if (hadEditor) M.editor = oldEditor; else delete M.editor;
  }
});

test("J / K bring the passage into the page band beside a pinned margin (M.reader.scrollLeftFor), in one smooth scroll", async () => {
  const sc = doc.getElementById("scroller"), calls = [];
  const oldScrollTo = sc.scrollTo, hadReader = Object.prototype.hasOwnProperty.call(M, "reader"), oldReader = M.reader;
  sc.scrollTo = (o) => { calls.push(Object.assign({}, o)); if (typeof o.top === "number") sc.scrollTop = o.top; if (typeof o.left === "number") sc.scrollLeft = o.left; };
  let reveal = 337;
  const asked = [];
  M.reader = { scrollLeftFor: (a) => { asked.push(a); return reveal; }, mode: () => "wide" };
  try {
    sc.scrollTop = 0; sc.clientHeight = 800;
    M.margin.focus("p_1");
    assert.equal(asked.length, 1);
    assert.equal(asked[0], M.cache.prompt("p_1").anchor, "asked with the card's anchor");
    let last = calls[calls.length - 1];
    assert.ok(last && last.left === 337 && last.behavior === "smooth", JSON.stringify(calls));
    // far below the viewport (K back up): top and left in the same smooth scroll
    sc.scrollTop = 5000; calls.length = 0;
    assert.equal(M.margin.run("prev") || M.margin.run("next"), true);
    last = calls[calls.length - 1];
    assert.ok(last && typeof last.top === "number" && last.top < 5000 && last.left === 337 && last.behavior === "smooth", JSON.stringify(calls));
    assert.equal(calls.length, 1, "one scroll, not a sideways jump that cancels the smooth one");
    // in view sideways (scrollLeftFor → null): the scroll leaves scrollLeft alone
    reveal = null; sc.scrollTop = 5000; calls.length = 0;
    M.margin.focus("p_1");
    assert.ok(calls.length === 1 && !("left" in calls[0]), JSON.stringify(calls));
  } finally {
    sc.scrollTo = oldScrollTo;
    if (hadReader) M.reader = oldReader; else delete M.reader;
    M.margin.escape();
    M.app.setFocusOwner("reader");
  }
});

// ---- Obsidian (BUILD-NOTES "Obsidian") --------------------------------------------------------------------
test("the O editor reads “Save + Obsidian”: its save stores the note like any other, then sends it; N's does not", async () => {
  const hadEditor = Object.prototype.hasOwnProperty.call(M, "editor"), oldEditor = M.editor;
  const hadObs = Object.prototype.hasOwnProperty.call(M, "obsidian"), oldObs = M.obsidian;
  const made = [], sent = [];
  M.editor = { create: (o) => { made.push(o); return { focus() {}, destroy() { o.host.innerHTML = ""; }, run() { return true; }, getText: () => "" }; } };
  M.obsidian = { send: (id, opts) => { sent.push([id, opts]); return Promise.resolve({ ok: true }); } };
  try {
    const A = Object.assign({}, ANCHOR, { y: 300, quote: "the O passage", pages: [{ pageIndex: 0, rects: [[10, 290, 200, 310]] }] });
    assert.ok(M.margin.openEditor({ promptId: null, anchor: A, initialText: "", obsidian: true }));
    const o = made[made.length - 1];
    assert.equal(o.saveLabel, "Save + Obsidian");
    assert.equal(o.initialText, "");
    assert.ok(doc.querySelector(".card.card--editing.card--obsidian"), "the card shows it is the Obsidian editor");
    await o.onSave("A note with $x^2$\n#tag", { another: false });
    await tick();
    const rec = M.cache.promptsOf("book_1").find((p) => p.text === "A note with $x^2$\n#tag");
    assert.ok(rec, "stored like any margin note");
    assert.equal(rec.kind, "note", "kind from M.prompts.parse");
    assert.deepEqual(rec.tags, ["tag"]);
    assert.equal(rec.anchor.quote, "the O passage");
    assert.deepEqual(sent, [[rec.id, { fromGesture: true }]], "then sent to Obsidian");
    assert.equal(doc.querySelector(".card--obsidian"), null);

    // N's editor: the plain Save, nothing sent
    assert.ok(M.margin.openEditor({ promptId: null, anchor: Object.assign({}, A, { y: 250 }), initialText: "Q. " }));
    const n = made[made.length - 1];
    assert.equal(n.saveLabel, undefined);
    await n.onSave("Q. plain\nA. prompt", { another: false });
    await tick();
    assert.equal(sent.length, 1);
  } finally {
    if (hadEditor) M.editor = oldEditor; else delete M.editor;
    if (hadObs) M.obsidian = oldObs; else delete M.obsidian;
  }
});

// ---- D30: a tab that comes back gets its editor back (js/tabs.js asks editing() and gives it to openEditor) ------
test("editing() gives the options that open the open editor once more, for each kind of editor; null without one", async () => {
  const hadEditor = Object.prototype.hasOwnProperty.call(M, "editor"), oldEditor = M.editor;
  const hadObs = Object.prototype.hasOwnProperty.call(M, "obsidian"), oldObs = M.obsidian;
  M.obsidian = { enabled: () => true };                    // DECISIONS D32: the Obsidian connection is switched on
  const made = [];
  M.editor = { create: (o) => { made.push(o); return { focus() {}, destroy() { o.host.innerHTML = ""; }, run(id) { if (id === "cancel") o.onCancel(); return true; }, getText: () => "" }; } };
  const again = async (opts, want) => {
    assert.ok(M.margin.openEditor(opts), "it opens: " + JSON.stringify(opts));
    const got = M.margin.editing();
    assert.deepEqual(got, want);
    const first = made[made.length - 1];
    // the reader closes with its book (M.margin's own reset does the same): the editor goes, its card too
    M.margin.closeEditor({ save: false });
    await tick();
    assert.equal(M.margin.editing(), null);
    assert.equal(M.margin.activeEditor(), null);
    // … and the tab that comes back opens it with what editing() gave
    assert.ok(M.margin.openEditor(got), "it opens again");
    const second = made[made.length - 1];
    assert.notEqual(second, first);
    for (const k of ["prompt", "anchor", "initialText", "saveLabel", "note", "draftKey", "keepDraft", "batch"]) assert.deepEqual(second[k], first[k], k);
    assert.deepEqual(M.margin.editing(), want, "and reports the same once more");
    M.margin.closeEditor({ save: false });
    await tick();
  };
  try {
    assert.equal(M.margin.editing(), null, "no editor is open");
    const A = Object.assign({}, ANCHOR, { y: 510, quote: "a passage for a tab", pages: [{ pageIndex: 0, rects: [[10, 500, 200, 520]] }] });
    // E on a card
    await again({ promptId: "p_1" }, { promptId: "p_1", anchor: M.cache.prompt("p_1").anchor || null });
    // N on a selection, with the text the reader put in
    await again({ promptId: null, anchor: A, initialText: "Q. " }, { promptId: null, anchor: A, initialText: "Q. " });
    // C: the sentence around the selection
    await again({ promptId: null, anchor: A, initialText: "The {sentence} around it." }, { promptId: null, anchor: A, initialText: "The {sentence} around it." });
    // O: the "Save + Obsidian" editor stays one
    await again({ promptId: null, anchor: A, initialText: "", obsidian: true }, { promptId: null, anchor: A, initialText: "", obsidian: true });
    // a split's first editor, and an editor with a note, a draft key of its own and a kept draft
    await again({ promptId: "p_1", split: true }, { promptId: "p_1", anchor: M.cache.prompt("p_1").anchor || null, splitText: M.cache.prompt("p_1").text });
    await again({ promptId: null, anchor: A, initialText: "second half", note: "The second half of the split", draftKey: "split:p_1", keepDraft: true },
      { promptId: null, anchor: A, initialText: "second half", note: "The second half of the split", draftKey: "split:p_1", keepDraft: true });
    // what it gives is a copy: changing it changes nothing in the margin
    assert.ok(M.margin.openEditor({ promptId: null, anchor: A, initialText: "Q. " }));
    const copy = M.margin.editing();
    copy.promptId = "p_2"; copy.obsidian = true;
    assert.deepEqual(M.margin.editing(), { promptId: null, anchor: A, initialText: "Q. " });
    M.margin.closeEditor({ save: false });
    await tick();
    // a prompt that is gone meanwhile: nothing opens
    assert.equal(M.margin.openEditor({ promptId: "p_gone", anchor: A }), null);
    assert.equal(M.margin.editing(), null);
  } finally {
    if (hadEditor) M.editor = oldEditor; else delete M.editor;
    if (hadObs) M.obsidian = oldObs; else delete M.obsidian;
  }
});

test("a blank free note (O or N without a selection) is neither stored nor sent: the editor stays open and says why", async () => {
  const hadEditor = Object.prototype.hasOwnProperty.call(M, "editor"), oldEditor = M.editor;
  const hadObs = Object.prototype.hasOwnProperty.call(M, "obsidian"), oldObs = M.obsidian;
  const made = [], sent = [], hints = [], saved = [];
  M.editor = { create: (o) => { const ed = { focus() {}, destroy() { o.host.innerHTML = ""; }, run() { return true; }, getText: () => "", hint: (m) => hints.push(m) }; made.push(o); return ed; } };
  M.obsidian = { send: (id, opts) => { sent.push([id, opts]); return Promise.resolve({ ok: true }); } };
  const offSaved = M.bus.on("prompt:saved", (e) => saved.push(e.prompt.id));
  try {
    const before = M.cache.promptsOf("book_1").length;
    const FREE = { pageIndex: 0, pages: [], quote: "", prefix: "", suffix: "", items: null, y: 420, lost: false };   // fromMarginY
    const ed = M.margin.openEditor({ promptId: null, anchor: FREE, initialText: "", obsidian: true });
    assert.ok(ed);
    const o = made[made.length - 1];
    for (const text of ["", "   \n ", "#tag"]) {                       // nothing to say: M.prompts.parse gives "highlight"
      assert.equal(await o.onSave(text, { another: false }), null);
      await tick();
      assert.equal(M.margin.activeEditor(), ed, "the editor stays open for " + JSON.stringify(text));
    }
    assert.deepEqual(hints, ["Type a note first", "Type a note first", "Type a note first"]);
    assert.deepEqual(sent, [], "nothing went to Obsidian");
    assert.deepEqual(saved, [], "nothing was stored");
    assert.equal(M.cache.promptsOf("book_1").length, before);
    assert.ok(doc.querySelector(".card.card--editing.card--obsidian"), "still the O editor");

    await o.onSave("Now a real note", { another: false });            // then a note is saved and sent as usual
    await tick();
    const rec = M.cache.promptsOf("book_1").find((p) => p.text === "Now a real note");
    assert.ok(rec && rec.kind === "note");
    assert.deepEqual(sent, [[rec.id, { fromGesture: true }]]);
    assert.equal(M.margin.activeEditor(), null);

    // a selection's empty save is still a highlight (H's meaning), and is sent
    const A = Object.assign({}, ANCHOR, { y: 380, quote: "kept as a highlight", pages: [{ pageIndex: 0, rects: [[10, 370, 200, 390]] }] });
    M.margin.openEditor({ promptId: null, anchor: A, initialText: "", obsidian: true });
    await made[made.length - 1].onSave("", { another: false });
    await tick();
    const hl = M.cache.promptsOf("book_1").find((p) => p.anchor && p.anchor.quote === "kept as a highlight");
    assert.ok(hl && hl.kind === "highlight");
    assert.equal(sent[1][0], hl.id);
    assert.equal(hints.length, 3);
  } finally {
    offSaved();
    if (hadEditor) M.editor = oldEditor; else delete M.editor;
    if (hadObs) M.obsidian = oldObs; else delete M.obsidian;
  }
});

test("the card ⋯ menu offers Send to Obsidian, and Update in Obsidian once the copy exists", async () => {
  const hadObs = Object.prototype.hasOwnProperty.call(M, "obsidian"), oldObs = M.obsidian;
  const sent = [];
  M.obsidian = { send: (id, opts) => { sent.push([id, opts]); return Promise.resolve({ ok: true }); } };
  try {
    function menuLabels() {
      click(cardEl().querySelector(".card__menu"));
      const menu = cardEl().querySelector(".menu");
      assert.ok(menu, "the menu opened");
      return { menu, labels: menu.querySelectorAll(".menu__item").map((b) => b.textContent) };
    }
    let m = menuLabels();
    assert.ok(m.labels.includes("Send to Obsidian"), m.labels.join(" | "));
    // FEATURES P2.2 / P2.3: "Split" and "Another angle…" come right after "Edit"; Delete and Flag follow them
    assert.deepEqual(m.labels.slice(0, 3), ["EditE", "Split", "Another angle…"], "the labels with their key caps");
    assert.match(m.labels[4], /^(Flag|Unflag)/, "Edit, Split, Another angle…, Delete, Flag keep their places");
    click(m.menu.querySelectorAll(".menu__item").find((b) => b.textContent === "Send to Obsidian"));
    assert.deepEqual(sent, [["p_1", { fromGesture: true }]]);
    assert.equal(cardEl().querySelector(".menu"), null, "the menu closed");

    await M.cache.savePrompt(Object.assign({}, M.cache.prompt("p_1"), { obsidianSentAt: Date.now() }), { content: false });
    await tick();
    m = menuLabels();
    assert.ok(m.labels.includes("Update in Obsidian"), m.labels.join(" | "));
    assert.ok(!m.labels.includes("Send to Obsidian"));
    click(m.menu.querySelectorAll(".menu__item").find((b) => b.textContent === "Update in Obsidian"));
    assert.deepEqual(sent[1], ["p_1", { fromGesture: true }]);

    // a highlight has it too (every kind)
    await M.cache.savePrompt({ id: "p_hl", collectionId: "book_1", kind: "highlight", text: "", anchor: Object.assign({}, ANCHOR, { y: 100 }), context: null, cards: [] }, { content: true });
    await tick();
    const hl = doc.querySelector('.card[data-id="p_hl"]');
    click(hl.querySelector(".card__menu"));
    const labels = hl.querySelector(".menu").querySelectorAll(".menu__item").map((b) => b.textContent);
    assert.ok(labels.includes("Send to Obsidian"), labels.join(" | "));
    assert.ok(labels.some((l) => l.startsWith("Write prompt")), "a highlight's menu");
    click(hl.querySelector(".menu").querySelectorAll(".menu__item").find((b) => b.textContent === "Send to Obsidian"));
    assert.deepEqual(sent[2], ["p_hl", { fromGesture: true }]);
  } finally {
    if (hadObs) M.obsidian = oldObs; else delete M.obsidian;
  }
  await tick();
});

test("with the Obsidian connection off (DECISIONS D32) a card's ⋯ menu has no Obsidian item, and the O editor is a plain editor", async () => {
  const hadEditor = Object.prototype.hasOwnProperty.call(M, "editor"), oldEditor = M.editor;
  const hadObs = Object.prototype.hasOwnProperty.call(M, "obsidian"), oldObs = M.obsidian;
  const made = [], sent = [];
  let on = false;
  M.editor = { create: (o) => { made.push(o); return { focus() {}, destroy() { o.host.innerHTML = ""; }, run() { return true; }, getText: () => "" }; } };
  M.obsidian = { enabled: () => on, send: (id, opts) => { sent.push([id, opts]); return Promise.resolve({ ok: true }); } };
  try {
    const labels = (id) => {
      const card = doc.querySelector('.card[data-id="' + id + '"]');
      click(card.querySelector(".card__menu"));
      const menu = card.querySelector(".menu");
      assert.ok(menu, "the menu opened");
      const out = menu.querySelectorAll(".menu__item").map((b) => b.textContent);
      click(card.querySelector(".card__menu"));              // close it again
      return out;
    };
    const p1 = M.cache.prompt("p_1");
    assert.ok(p1.obsidianSentAt, "p_1 was sent before (the test above): off hides Update in Obsidian too");
    for (const id of ["p_1", "p_hl"]) {
      const off = labels(id);
      assert.ok(!off.some((l) => /Obsidian/.test(l)), id + ": " + off.join(" | "));
      assert.ok(off.some((l) => /^Delete/.test(l)) && off.some((l) => /^(Flag|Unflag)/.test(l)), "the other items stay");
    }
    // the O editor (a tab brings one back after the switch went off): a plain editor, and its save sends nothing
    const A = Object.assign({}, ANCHOR, { y: 420, quote: "a passage while Obsidian is off", pages: [{ pageIndex: 0, rects: [[10, 410, 200, 430]] }] });
    assert.ok(M.margin.openEditor({ promptId: null, anchor: A, initialText: "", obsidian: true }));
    const o = made[made.length - 1];
    assert.equal(o.saveLabel, undefined, "the plain Save");
    assert.equal(doc.querySelector(".card--obsidian"), null);
    assert.deepEqual(M.margin.editing(), { promptId: null, anchor: A, initialText: "" }, "no Obsidian editor to bring back");
    await o.onSave("a note kept in the margin", { another: false });
    await tick();
    assert.ok(M.cache.promptsOf("book_1").find((p) => p.text === "a note kept in the margin"), "stored like any margin note");
    assert.deepEqual(sent, [], "nothing sent");

    // a page without M.obsidian: no Obsidian item either
    delete M.obsidian;
    assert.ok(!labels("p_1").some((l) => /Obsidian/.test(l)));
    M.obsidian = { enabled: () => on, send: (id, opts) => { sent.push([id, opts]); return Promise.resolve({ ok: true }); } };

    // switched on: the items are back
    on = true;
    assert.ok(labels("p_1").includes("Update in Obsidian"));
    assert.ok(labels("p_hl").some((l) => /^(Send to|Update in) Obsidian$/.test(l)));
    assert.ok(M.margin.openEditor({ promptId: null, anchor: Object.assign({}, A, { y: 380 }), initialText: "", obsidian: true }));
    assert.equal(made[made.length - 1].saveLabel, "Save + Obsidian");
    M.margin.closeEditor({ save: false });
    await tick();
  } finally {
    if (hadEditor) M.editor = oldEditor; else delete M.editor;
    if (hadObs) M.obsidian = oldObs; else delete M.obsidian;
  }
  await tick();
});

// ---- kind icons ---------------------------------------------------------------------------------------
test("each card starts with its kind's line icon (M.util.kindIcon), redrawn when the kind changes", async () => {
  const glyph = (id) => doc.querySelector('.card[data-id="' + id + '"]').querySelector(".card__glyph");
  assert.match(glyph("p_1").innerHTML, /kind-icon--qa/, "a Q./A. prompt shows the question-mark icon");
  assert.equal(glyph("p_1").getAttribute("data-kind"), "qa");
  assert.doesNotMatch(glyph("p_1").innerHTML, /✦|▭/, "no old text glyph");
  await M.cache.savePrompt({ id: "p_icon", collectionId: "book_1", kind: "note", text: "Just a note", anchor: Object.assign({}, ANCHOR, { y: 300 }), context: null, cards: [] }, { content: true });
  await tick();
  assert.match(glyph("p_icon").innerHTML, /kind-icon--note/, "a note shows the pencil");
  await M.cache.savePrompt(Object.assign({}, M.cache.prompt("p_icon"), { kind: "cloze", text: "A {cloze} line" }), { content: true });
  await tick();
  assert.match(glyph("p_icon").innerHTML, /kind-icon--cloze/, "a cloze shows the brackets");
  assert.equal(glyph("p_icon").getAttribute("data-kind"), "cloze");
  if (doc.querySelector('.card[data-id="p_hl"]')) assert.match(glyph("p_hl").innerHTML, /kind-icon--highlight/, "a highlight shows the marker pen");
});

// ---- cues (FEATURES P1.1) -----------------------------------------------------------------------------
test("a cloze card shows a blank's cue beside its mark, with the answers hidden too; a Q./A. card keeps {a::b} as typed", async () => {
  const at = (y) => Object.assign({}, ANCHOR, { y, pages: [{ pageIndex: 0, rects: [[10, y - 10, 200, y + 10]] }] });
  await M.cache.savePrompt({ id: "p_cue", collectionId: "book_1", kind: "cloze", text: "The {wave function::two words} is {complex}.\n#qm", anchor: at(650), context: null, cards: [] }, { content: true });
  await M.cache.savePrompt({ id: "p_qa_cue", collectionId: "book_1", kind: "qa", text: "Q. What does {a::b} mean?\nA. c\\::d", anchor: at(600), context: null, cards: [] }, { content: true });
  await tick();
  const card = doc.querySelector('.card[data-id="p_cue"]');
  assert.ok(card && !card.classList.contains("card--placeholder"), "the card is rendered");
  const body = card.querySelector(".card__body");            // the element whose innerHTML the margin sets
  assert.equal(body.innerHTML, '<div class="card__q card__q--cloze">The <mark class="cloze-mark">wave function</mark> <span class="cloze-cue">(two words)</span>' +
    ' is <mark class="cloze-mark">complex</mark>.</div><div class="card__tags"><span class="chip">#qm</span></div>');
  assert.equal(card.querySelector(".card__q--cloze").textContent, "The wave function (two words) is complex.");
  assert.equal(card.querySelectorAll(".cloze-cue").length, 1, "one cue, beside the deletion that has one");
  assert.equal(card.querySelector(".cloze-cue").textContent, "(two words)");
  assert.equal(card.querySelector(".card__pill").textContent, "The {wave function::two words} is {compl…", "the collapsed pill keeps the text as typed");
  assert.equal(card.querySelector(".card__chips"), null, "a cue is no reason for a hint");

  // A (hide answers in the margin) hides answer lines only: the cue stays where it is
  const before = body.innerHTML;
  M.margin.setAnswersHidden(true);
  assert.ok(doc.getElementById("margin").classList.contains("margin--no-answers"));
  assert.equal(body.innerHTML, before);
  assert.equal(card.querySelector(".cloze-cue").textContent, "(two words)");
  M.margin.setAnswersHidden(false);

  // editing the cue re-renders the card and keeps its place among the cards
  await M.cache.savePrompt(Object.assign({}, M.cache.prompt("p_cue"), { text: "The {wave function::a state} is {complex::not real}." }), { content: true });
  await tick();
  assert.deepEqual(card.querySelectorAll(".cloze-cue").map((el) => el.textContent), ["(a state)", "(not real)"]);

  // in a Q./A. card braces are text, so nothing is a cue and \:: stays as typed
  const qa = doc.querySelector('.card[data-id="p_qa_cue"]');
  assert.equal(qa.querySelector(".card__body").innerHTML, '<div class="card__q">What does {a::b} mean?</div><div class="card__a">c\\::d</div>');
  assert.equal(qa.querySelectorAll(".cloze-cue").length, 0);
});
