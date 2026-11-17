"use strict";
// Marginalia — test/split-angles.test.js: FEATURES P2.2 (Split a prompt) and P2.3 ("Another angle" starters) on a
// small fake DOM with the real util, bus, settings, store (memory), scheduler, prompts, context, keys, layout, markup,
// cache, app, editor, margin and list modules.
//  - M.editor.ANGLES (28 starters in the 10 groups of ANGLE_GROUPS), anglesPlace, anglesArea and anglesOut (the
//    picker's side, height and area; its place with a given layout: fixed outside a box that is too low), the
//    Angles button's show / hide rule, the picker (group headings; a pick replaces the text and
//    selects the first "…"; arrows, Tab inside, Esc closes and gives the focus back to the textarea, never to M.app);
//  - the margin card menu: "Split" (Q./A. and cloze only) and "Another angle…" (every kind) right after "Edit";
//  - Split in the margin: save then save (two prompts, same passage, the first keeps its schedule, the second is new
//    and holds the old text), cancel first, cancel second, a cloze edit that drops a blank, a stale draft;
//  - Split in the prompt list: a deck's rows (same deck and section) and a book's rows (same anchor);
//  - no key map gains a key (D20).
// The fake DOM below is test/margin-dom.test.js's, with a textarea's value and selection.
// Run: node --test test/split-angles.test.js
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
  // a textarea's value and selection (what M.editor touches)
  el.value = ""; el.selectionStart = 0; el.selectionEnd = 0; el.scrollHeight = 0; el.placeholder = ""; el.disabled = false; el.title = "";
  el.setSelectionRange = (a, b) => { el.selectionStart = a; el.selectionEnd = b; };
  el.setRangeText = (text, start, end, mode) => {
    const v = el.value;
    el.value = v.slice(0, start) + text + v.slice(end);
    if (mode === "select") { el.selectionStart = start; el.selectionEnd = start + text.length; }
    else { el.selectionStart = el.selectionEnd = start + text.length; }
  };
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
const store = new Map();
const fakeStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
const DAY = 86400000;

before(async () => {
  doc = makeDocument();
  doc.getElementById("app").appendChild(makeElement(doc, "div")).id = "deckHost";
  globalThis.document = doc;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true, writable: true });
  const JS = path.join(__dirname, "..", "js");
  for (const name of ["util", "bus", "settings", "store", "scheduler", "prompts", "context", "keys", "layout", "markup", "cache", "app", "editor", "margin", "list"]) {
    require(path.join(JS, name + ".js"));
  }
  M = globalThis.Marginalia;
  await M.cache.load();
  await M.cache.saveCollection({ id: "book_1", kind: "book", name: "Book" });
  M.app.setFocusOwner("reader");
  M.margin.mount(doc.getElementById("scroller"), doc.getElementById("margin"));
  M.bus.emit("doc:opened", { collectionId: "book_1" });
  M.bus.emit("pages:measured", { pageTops: [0], pageHeights: [1200] });
  await tick();
});

let seq = 0;
// A reviewed prompt of the open book: its card(s) carry a schedule and a log, so "keeps its schedule" means something.
async function seed(text, kind, opts) {
  opts = opts || {};
  const id = "p_s" + (++seq), t0 = Date.UTC(2026, 9, 1);
  const parsed = M.prompts.parse(text);
  const cards = (kind === "qa" || kind === "cloze") ? M.prompts.reconcileCards(null, parsed, t0).cards.map((c) =>
    Object.assign({}, c, { dueAt: t0 + 9 * DAY, intervalMs: 9 * DAY, lastReviewedAt: t0, log: opts.log === false ? [] : [{ at: t0, outcome: "remembered" }] })) : [];
  const anchor = Object.assign({}, ANCHOR, { y: 700 - seq * 40, pages: [{ pageIndex: 0, rects: [[10, 690 - seq * 40, 200, 710 - seq * 40]] }] });
  await M.cache.savePrompt({ id, collectionId: opts.collectionId || "book_1", kind, text, tags: parsed.tags, anchor: opts.anchor === null ? null : anchor,
    context: opts.context || null, cards, createdAt: t0, flagged: false }, { content: true });
  await tick();
  return id;
}
function card(id) { return doc.querySelector('.card[data-id="' + id + '"]'); }
function menuLabels(id) {
  click(card(id).querySelector(".card__menu"));
  const menu = card(id).querySelector(".menu");
  assert.ok(menu, "the card menu opened");
  return { menu, labels: menu.querySelectorAll(".menu__item").map((b) => b.querySelector("span").textContent) };
}
function pick(id, label) {
  const m = menuLabels(id);
  const item = m.menu.querySelectorAll(".menu__item").find((b) => b.querySelector("span").textContent === label);
  assert.ok(item, label + " is in the menu: " + m.labels.join(" | "));
  click(item);
}
function closeMenus() { M.margin.escape && M.margin.escape(); }
function editorOf() { return M.margin.activeEditor(); }
function type(ed, text) { ed.textarea.value = text; ed.textarea.dispatchEvent(new Event("input")); }
function live(collectionId) { return M.cache.promptsOf(collectionId).filter((p) => !p.deletedAt); }
const anglesBtn = (ed) => ed.el.querySelector(".editor__angles");
const picker = (ed) => ed.el.querySelector(".editor__angles-pop");
const shown = (el) => !!el && !el.classList.contains("is-hidden");

// ---- P2.3 a: the list ------------------------------------------------------------------------------------
// The list of 2026-11-11 (D26): every angle of the sources, in the picker's order. [group id, group label, [[id, question]]]
const ANGLE_LIST = [
  ["attributes", "Attributes and tendencies", [["attributes", "What is always true of …?"], ["never", "What is never true of …?"], ["usually", "How is … usually …?"]]],
  ["compare", "Similarities and differences", [["similar", "How is … similar to …?"], ["difference", "How is … different from …?"]]],
  ["parts", "Parts and wholes", [["parts", "What are the parts of …?"], ["kind", "… is a kind of what?"], ["examples", "Name three examples of …"], ["instance", "… is an example of what?"]]],
  ["causes", "Causes and effects", [["cause", "What causes …?"], ["effect", "What does … do?"], ["used", "When is … used?"]]],
  ["meaning", "Significance and implications", [["matters", "Why does … matter?"], ["implies", "What does … imply?"], ["askmyself", "What should I ask myself when …?"]]],
  ["explain", "Explanation", [["why", "Why …?"], ["produce", "How does … produce …?"]]],
  ["procedure", "Procedure", [["when", "When should you …?"], ["after", "What comes after …?"], ["howlong", "How long does … take?"]]],
  ["use", "Use", [["ways", "Name two ways to …"], ["novel", "Name a … you have not named before"], ["do", "What should I do when …?"]]],
  ["depth", "Depth", [["whatif", "What changes if …?"], ["true", "Why is … true?"], ["connect", "How does … connect to …?"]]],
  ["memory", "Memory", [["term", "What is the term for …?"], ["mnemonic", "Mnemonic for …?"]]]
];

test("ANGLES: 28 starters in 10 groups, in the contract's order; each is a Q. line holding “…”, used with \\nA. appended", () => {
  const A = M.editor.ANGLES, G = M.editor.ANGLE_GROUPS;
  assert.deepEqual(G.map((g) => [g.id, g.label]), ANGLE_LIST.map((g) => [g[0], g[1]]));
  const want = [];
  for (const g of ANGLE_LIST) for (const a of g[2]) want.push([a[0], g[0], a[1], "Q. " + a[1]]);
  assert.deepEqual(A.map((a) => [a.id, a.group, a.label, a.text]), want);
  assert.equal(A.length, 28);
  assert.equal(G.length, 10);
  assert.equal(new Set(A.map((a) => a.id)).size, 28, "every id once");
  assert.equal(new Set(G.map((g) => g.id)).size, 10);
  for (const g of G) assert.ok(A.some((a) => a.group === g.id), g.id + ": no empty group");
  // the starters of the first list (2026-11-11, eight entries) keep their ids and their sentences
  const old = { attributes: "Q. What is always true of …?", difference: "Q. How is … different from …?", parts: "Q. What are the parts of …?", cause: "Q. What causes …?",
    effect: "Q. What does … do?", why: "Q. Why …?", matters: "Q. Why does … matter?", whatif: "Q. What changes if …?" };
  for (const id of Object.keys(old)) assert.equal(A.find((a) => a.id === id).text, old[id], id);
  assert.equal(M.editor.ANGLE_ANSWER, "\nA. ");
  for (const a of A) {
    assert.ok(a.text.indexOf("…") > 0, a.id);
    assert.equal(a.text, "Q. " + a.label, a.id + ": the picker shows the question itself");
    const parsed = M.prompts.parse(a.text);
    assert.equal(parsed.kind, "note", a.id + ": a Q. line alone (no A. yet)");
    assert.ok(/^Q\. /.test(a.text) && parsed.question.indexOf("…") >= 0, a.id);
    const used = M.editor.angleStarter(a.id);
    assert.equal(used.text, a.text + "\nA. ");
    assert.equal(M.prompts.parse(used.text + "x").kind, "qa", a.id + ": with its answer it is a Q./A. prompt");
    assert.equal(used.text.slice(used.start, used.end), "…");
    assert.equal(used.start, used.text.indexOf("…"), "the first …");
  }
  assert.equal(M.editor.angleStarter("kind").start, 3, "a starter may begin with its gap (“Q. … is a kind of what?”)");
  assert.equal(M.editor.angleStarter("nope"), null);
});

test("a starter filled in by the user gets no writing hint for its own wording (but the hints still judge the answer)", () => {
  // The user replaces every … and writes a short answer: the starter's words alone must not trip a hint.
  const fill = { examples: null, ways: null, novel: null };   // open-list starters: see below
  for (const a of M.editor.ANGLES) {
    if (a.id in fill) continue;
    const text = a.text.replace(/…/g, "entropy") + "\nA. A short reply";
    const codes = M.prompts.lint(M.prompts.parse(text), new Date(2026, 10, 11)).map((l) => l.code);
    assert.deepEqual(codes, [], a.id + ": " + JSON.stringify(text));
  }
  // "Name three examples of …" asks for examples on purpose: the example hint (and only it) reminds the user to also
  // ask from an instance to the idea, which is the starter "… is an example of what?".
  const ex = M.prompts.lint(M.prompts.parse("Q. Name three examples of bosons\nA. A short reply"), new Date(2026, 10, 11)).map((l) => l.code);
  assert.deepEqual(ex, ["example_prompt"]);
  for (const id of ["ways", "novel"]) {
    const t = M.editor.ANGLES.find((a) => a.id === id).text.replace(/…/g, "entropy") + "\nA. A short reply";
    assert.deepEqual(M.prompts.lint(M.prompts.parse(t), new Date(2026, 10, 11)).map((l) => l.code), [], id);
  }
});

test("anglesPlace: below when it fits, else above when it fits, else the side with more room with a height cap; right-aligned at the right edge", () => {
  const place = M.editor.anglesPlace, WIN = { top: 0, left: 0, right: 1280, bottom: 768 };
  const ed = (top, bottom, left, right) => ({ top, bottom, left: left == null ? 900 : left, right: right == null ? 1220 : right });
  const size = (height, width) => ({ height, width: width == null ? 280 : width });
  assert.deepEqual(place(ed(100, 300), size(234), WIN), { up: false, right: false, maxHeight: null }, "it fits below");
  assert.deepEqual(place(ed(100, 526), size(234), WIN), { up: false, right: false, maxHeight: null }, "exactly: 768 - 526 - 8 = 234");
  assert.deepEqual(place(ed(400, 527), size(234), WIN), { up: true, right: false, maxHeight: null }, "one px short below, room above");
  assert.deepEqual(place(ed(242, 600), size(234), WIN), { up: true, right: false, maxHeight: null }, "exactly above: 242 - 8 = 234");
  assert.deepEqual(place(ed(241, 600), size(234), WIN), { up: true, right: false, maxHeight: 233 }, "neither side holds it: above has more room (233 > 160), capped");
  assert.deepEqual(place(ed(100, 300), size(752), WIN), { up: false, right: false, maxHeight: 460 }, "the long list: below has more room (460 > 92)");
  assert.deepEqual(place(ed(500, 700), size(752), WIN), { up: true, right: false, maxHeight: 492 }, "the long list low on the page: above");
  assert.deepEqual(place(ed(300, 468), size(752), WIN), { up: false, right: false, maxHeight: 292 }, "equal room (292 each): below");
  assert.deepEqual(place(ed(60, 700), size(752), WIN), { up: false, right: false, maxHeight: 120 }, "never capped under 120 px");
  // the area is the window cut by a clipping ancestor (the reader's scroller under the toolbar, a card popover)
  assert.deepEqual(place(ed(300, 500), size(400), { top: 48, left: 0, right: 1280, bottom: 768 }), { up: false, right: false, maxHeight: 260 }, "below 260 > above 244");
  assert.deepEqual(place(ed(300, 500), size(400), { top: 48, left: 0, right: 1280, bottom: 700 }), { up: true, right: false, maxHeight: 244 }, "above 244 > below 192");
  assert.deepEqual(place(ed(300, 500), size(240), { top: 48, left: 0, right: 1280, bottom: 700 }), { up: true, right: false, maxHeight: null }, "it fits above under the toolbar");
  // the right edge
  assert.equal(place(ed(100, 300, 1000, 1264), size(234, 280), WIN).right, true, "1000 + 280 passes 1272; 1264 - 280 stays inside");
  assert.equal(place(ed(100, 300, 992, 1264), size(234, 280), WIN).right, false, "992 + 280 = 1272: it just fits left-aligned");
  assert.equal(place(ed(100, 300, 1000, 1264), size(234, 1260), WIN).right, false, "too wide for either side: it stays left-aligned");
  assert.equal(place(ed(100, 300, 700, 900), size(234, 280), { top: 0, left: 640, right: 940, bottom: 768 }).right, false, "right-aligned would pass the area's left edge (900 - 280 < 648)");
  assert.equal(place(ed(100, 300, 700, 936), size(234, 280), { top: 0, left: 640, right: 940, bottom: 768 }).right, true);
  // no layout (the node tests, a hidden editor): below, left-aligned, no cap
  const none = { up: false, right: false, maxHeight: null };
  assert.deepEqual(place(null, size(234), WIN), none);
  assert.deepEqual(place(ed(100, 300), null, WIN), none);
  assert.deepEqual(place(ed(100, 300), size(234), null), none);
  assert.deepEqual(place(ed(0, 0, 0, 0), size(0, 0), { top: 0, left: 0, right: 0, bottom: 0 }), none);
  assert.equal(M.editor.anglesOpenUp, undefined, "the first rule's function is gone");
});

test("anglesArea and anglesOut: the picker stays inside the clipping boxes that leave it 120 px, and leaves the nearest ones that do not", () => {
  const area = M.editor.anglesArea, WIN = { top: 0, left: 0, right: 640, bottom: 700 };
  const ED = { top: 176, bottom: 388, left: 288, right: 579 };
  const SCROLLER = { top: 44, bottom: 700, left: 0, right: 640, x: true, y: true };
  const POPOVER = { top: 165, bottom: 399, left: 268, right: 588, x: true, y: true };      // a card popover: just around its editor
  // wide: the scroller alone gives room (304 below) → inside it
  assert.deepEqual(area(ED, [SCROLLER], WIN), { bounds: { top: 44, bottom: 700, left: 0, right: 640 }, escape: 0 });
  // rail: the popover gives 3 px above and below → the picker leaves it and uses the scroller's area
  assert.deepEqual(area(ED, [POPOVER, SCROLLER], WIN), { bounds: { top: 44, bottom: 700, left: 0, right: 640 }, escape: 1 });
  // it cannot leave (a transform holds a fixed box): the cut of all boxes
  assert.deepEqual(area(ED, [POPOVER, SCROLLER], WIN, true), { bounds: { top: 165, bottom: 399, left: 268, right: 588 }, escape: 0 });
  // a box with exactly 120 px on one side is enough (388 + 8 + 120 = 516); one px less is not
  assert.equal(area(ED, [{ top: 170, bottom: 516, left: 0, right: 640, x: true, y: true }, SCROLLER], WIN).escape, 0);
  assert.equal(area(ED, [{ top: 170, bottom: 515, left: 0, right: 640, x: true, y: true }, SCROLLER], WIN).escape, 1);
  assert.equal(area(ED, [{ top: 48, bottom: 392, left: 0, right: 640, x: true, y: true }, SCROLLER], WIN).escape, 0, "120 px above (176 - 48 - 8)");
  // stack: the sheet's body is low, no other box is → the window
  assert.deepEqual(area({ top: 506, bottom: 702, left: 48, right: 401 }, [{ top: 492, bottom: 720, left: 17, right: 413, x: true, y: true }], { top: 0, left: 0, right: 430, bottom: 720 }),
    { bounds: { top: 0, bottom: 720, left: 0, right: 430 }, escape: 1 });
  // two low boxes, then a good one: it leaves both
  assert.equal(area(ED, [POPOVER, { top: 160, bottom: 404, left: 260, right: 600, x: true, y: true }, SCROLLER], WIN).escape, 2);
  // even the window is too low: it leaves every box (and is capped to 120 px there)
  assert.deepEqual(area({ top: 60, bottom: 180, left: 10, right: 300 }, [{ top: 50, bottom: 190, left: 0, right: 400, x: true, y: true }], { top: 0, left: 0, right: 400, bottom: 200 }),
    { bounds: { top: 0, bottom: 200, left: 0, right: 400 }, escape: 1 });
  // a box that clips one axis only cuts that axis
  assert.deepEqual(area(ED, [{ top: 100, bottom: 600, left: 250, right: 600, x: true, y: false }], WIN).bounds, { top: 0, bottom: 700, left: 250, right: 600 });
  assert.deepEqual(area(ED, [{ top: 100, bottom: 600, left: 250, right: 600, x: false, y: true }], WIN).bounds, { top: 100, bottom: 600, left: 0, right: 640 });
  // no boxes, no layout
  assert.deepEqual(area(ED, [], WIN), { bounds: WIN, escape: 0 });
  assert.deepEqual(area(ED, null, WIN), { bounds: WIN, escape: 0 });
  assert.deepEqual(area(null, [POPOVER], WIN), { bounds: { top: 165, bottom: 399, left: 268, right: 588 }, escape: 0 });
  assert.deepEqual(area(ED, [POPOVER], null), { bounds: null, escape: 0 });
  assert.deepEqual(M.editor.anglesPlace(ED, { width: 254, height: 600 }, null), { up: false, right: false, maxHeight: null }, "anglesPlace takes the missing area");
  // anglesOut: the editor has left the area (a fixed picker closes then); touching the edge is out, one px inside is not
  const out = M.editor.anglesOut, A = { top: 44, bottom: 700, left: 0, right: 640 };
  assert.equal(out(ED, A), false);
  assert.equal(out({ top: -168, bottom: 44, left: 288, right: 579 }, A), true, "above the area");
  assert.equal(out({ top: -167, bottom: 45, left: 288, right: 579 }, A), false);
  assert.equal(out({ top: 700, bottom: 912, left: 288, right: 579 }, A), true, "below it");
  assert.equal(out({ top: 699, bottom: 911, left: 288, right: 579 }, A), false);
  assert.equal(out({ top: 176, bottom: 388, left: 640, right: 931 }, A), true, "right of it");
  assert.equal(out({ top: 176, bottom: 388, left: -291, right: 0 }, A), true, "left of it");
  assert.equal(out(null, A), false);
  assert.equal(out(ED, null), false);
});

test("anglesShown: a new prompt whose text is empty or just “Q. ” (trailing blanks or not); never an existing one or a batch", () => {
  for (const t of ["", " ", "Q.", "Q. ", "Q.   ", "Q. \n", "\n"]) assert.equal(M.editor.anglesShown(t, true, false), true, JSON.stringify(t));
  for (const t of ["Q. x", "x", "Q. What", "A. ", "Q. \nA. ", " Q. x", "{x}"]) assert.equal(M.editor.anglesShown(t, true, false), false, JSON.stringify(t));
  assert.equal(M.editor.anglesShown("Q. ", false, false), false, "an existing prompt never");
  assert.equal(M.editor.anglesShown("", true, true), false, "the deck's batch box never");
});

// ---- P2.3 c: the button and the picker -------------------------------------------------------------------
test("the Angles button shows for a new prompt at “Q. ”, goes away once the editor holds other text, and comes back", async () => {
  const ed = M.margin.openEditor({ promptId: null, anchor: Object.assign({}, ANCHOR, { y: 20 }), initialText: "Q. " });
  try {
    assert.ok(ed);
    assert.equal(shown(anglesBtn(ed)), true, "shown for Q. ");
    type(ed, "Q. W");
    assert.equal(shown(anglesBtn(ed)), false, "gone with other text (at once, not after the preview's debounce)");
    type(ed, "Q.  ");
    assert.equal(shown(anglesBtn(ed)), true);
    type(ed, "");
    assert.equal(shown(anglesBtn(ed)), true, "empty");
    ed.setText("A sentence");
    assert.equal(shown(anglesBtn(ed)), false, "setText too");
  } finally { ed.run("cancel"); await tick(); }
});

test("an existing prompt's editor never shows the Angles button, not even emptied to “Q. ”", async () => {
  const id = await seed("Q. existing\nA. one", "qa");
  const ed = M.margin.openEditor({ promptId: id });
  try {
    assert.equal(shown(anglesBtn(ed)), false);
    type(ed, "Q. ");
    assert.equal(shown(anglesBtn(ed)), false);
    assert.equal(ed.openAngles(), false, "and the picker does not open");
    assert.equal(picker(ed), null);
    // a highlight's "Write prompt" edits an existing record too
    const hl = await seed("", "highlight");
    ed.run("cancel");
    const ed2 = M.margin.openEditor({ promptId: hl });
    assert.equal(shown(anglesBtn(ed2)), false, "a highlight being written is an existing prompt");
    ed2.run("cancel");
  } finally { if (editorOf()) editorOf().run("cancel"); await tick(); }
});

test("the picker: 28 questions under 10 headings, arrows and Tab stay inside and skip the headings, Enter picks: the text becomes the starter with its first “…” selected", async () => {
  const ed = M.margin.openEditor({ promptId: null, anchor: Object.assign({}, ANCHOR, { y: 30 }), initialText: "Q. " });
  try {
    click(anglesBtn(ed));
    const pop = picker(ed);
    assert.ok(pop, "the picker opened");
    assert.equal(anglesBtn(ed).getAttribute("aria-expanded"), "true");
    const items = pop.querySelectorAll(".editor__angle");
    assert.deepEqual(items.map((b) => b.textContent), M.editor.ANGLES.map((a) => a.label));
    assert.equal(items.length, 28);
    assert.equal(items[0].textContent, "What is always true of …?", "each item is the question itself");
    // the headings: one per group, in order, each over its own starters; a heading is no menu item and takes no focus
    const sets = pop.querySelectorAll(".editor__angle-set");
    assert.deepEqual(sets.map((x) => x.getAttribute("aria-label")), M.editor.ANGLE_GROUPS.map((g) => g.label));
    assert.deepEqual(pop.querySelectorAll(".editor__angle-group").map((h) => h.textContent), M.editor.ANGLE_GROUPS.map((g) => g.label));
    sets.forEach((set, gi) => {
      assert.equal(set.getAttribute("role"), "group");
      const head = set.children[0];
      assert.ok(head.classList.contains("editor__angle-group"), "the heading comes first in its group");
      assert.equal(head.getAttribute("aria-hidden"), "true", "the group's aria-label names it once");
      assert.equal(head.tagName, "DIV");
      assert.equal(head.hasAttribute("tabindex"), false);
      assert.equal(head.hasAttribute("data-angle"), false);
      assert.deepEqual(set.querySelectorAll(".editor__angle").map((b) => b.getAttribute("data-angle")),
        M.editor.ANGLES.filter((a) => a.group === M.editor.ANGLE_GROUPS[gi].id).map((a) => a.id));
    });
    for (const b of items) { assert.equal(b.getAttribute("role"), "menuitem"); assert.equal(b.getAttribute("tabindex"), "-1"); }
    assert.equal(doc.activeElement, items[0], "the first question has the focus");
    let r = press("ArrowDown", doc.activeElement);
    assert.equal(doc.activeElement, items[1]);
    assert.equal(r.ev.stopped, true, "the picker's keys are its own");
    assert.equal(r.handled, false, "M.app never sees them");
    press("ArrowUp", doc.activeElement); press("ArrowUp", doc.activeElement);
    assert.equal(doc.activeElement, items[27], "↑ wraps to the last");
    press("Tab", doc.activeElement);
    assert.equal(doc.activeElement, items[0], "Tab cycles inside (focus trap)");
    const shiftTab = makeEvent("keydown", doc.activeElement, "Tab"); shiftTab.shiftKey = true; bubble(shiftTab);
    assert.equal(doc.activeElement, items[27], "Shift+Tab too");
    press("Home", doc.activeElement);
    assert.equal(doc.activeElement, items[0]);
    press("End", doc.activeElement);
    assert.equal(doc.activeElement, items[27]);
    press("Home", doc.activeElement);
    for (let i = 0; i < 3; i++) press("ArrowDown", doc.activeElement);
    assert.equal(doc.activeElement.getAttribute("data-angle"), "similar", "↓ goes from a group's last question to the next group's first (the heading is skipped)");
    for (let i = 0; i < 6; i++) press("ArrowDown", doc.activeElement);
    assert.equal(items[9].getAttribute("data-angle"), "cause");
    assert.equal(doc.activeElement, items[9]);
    r = press("Enter", doc.activeElement);
    assert.equal(r.ev.defaultPrevented, true);
    assert.equal(ed.textarea.value, "Q. What causes …?\nA. ");
    assert.equal(ed.textarea.value.slice(ed.textarea.selectionStart, ed.textarea.selectionEnd), "…", "the first … is selected");
    assert.equal(ed.textarea.selectionStart, "Q. What causes ".length);
    assert.equal(doc.activeElement, ed.textarea, "typing replaces the …");
    assert.equal(picker(ed), null, "the picker closed");
    assert.equal(shown(anglesBtn(ed)), false, "the button goes: the editor holds other text");
    assert.equal(editorOf(), ed, "the editor stays open");
  } finally { if (editorOf()) editorOf().run("cancel"); await tick(); }
});

test("the picker: a click picks; Esc closes it, gives the focus back to the textarea and does not cancel the editor", async () => {
  let ed = M.margin.openEditor({ promptId: null, anchor: Object.assign({}, ANCHOR, { y: 40 }), initialText: "" });
  try {
    click(anglesBtn(ed));
    click(picker(ed).querySelectorAll(".editor__angle").find((b) => b.getAttribute("data-angle") === "difference"));
    assert.equal(ed.textarea.value, "Q. How is … different from …?\nA. ");
    assert.equal(ed.textarea.selectionStart, "Q. How is ".length, "the FIRST … of two");
    assert.equal(ed.textarea.selectionEnd, "Q. How is …".length);
    ed.run("cancel");
    await tick();

    ed = M.margin.openEditor({ promptId: null, anchor: Object.assign({}, ANCHOR, { y: 45 }), initialText: "Q. " });
    click(anglesBtn(ed));
    assert.ok(picker(ed));
    const r = press("Escape", doc.activeElement);
    assert.equal(r.ev.stopped, true);
    assert.equal(r.handled, false, "Esc never reached M.app (it would cancel the editor)");
    assert.equal(picker(ed), null, "closed");
    assert.equal(doc.activeElement, ed.textarea, "focus is back in the editor");
    assert.equal(editorOf(), ed, "the editor is still open");
    assert.equal(ed.textarea.value, "Q. ", "nothing picked");
    assert.equal(anglesBtn(ed).getAttribute("aria-expanded"), "false");
    // a second click on the button toggles it closed
    click(anglesBtn(ed)); assert.ok(picker(ed));
    click(anglesBtn(ed)); assert.equal(picker(ed), null);
  } finally { if (editorOf()) editorOf().run("cancel"); await tick(); }
});

// The picker's place with a layout (the fake DOM has none: this test gives the editor, its boxes and the picker rects,
// and a window that takes listeners and cancels frames, as a browser's does).
// Found in a real browser on 2026-11-11: in the rail layout the card popover is just around its editor and hid the list.
test("the picker in a box too low for it: position fixed at the editor's edge, placed again on a scroll or a resize, closed when the editor leaves the area; held by a transform it stays inside; closing removes its listeners and its frame", async () => {
  const g = globalThis, realCreate = doc.createElement, scroller = doc.getElementById("scroller");
  const names = ["getComputedStyle", "innerWidth", "innerHeight", "addEventListener", "removeEventListener", "cancelAnimationFrame", "requestAnimationFrame"];
  const saved = {}; for (const k of names) saved[k] = Object.prototype.hasOwnProperty.call(g, k) ? { v: g[k] } : null;
  const savedRect = scroller.getBoundingClientRect;
  const px = (v) => parseFloat(v);
  const WIN = { top: 0, left: 0, right: 640, bottom: 700 };
  const winL = {}, frames = new Set(), cancelled = [];
  const resizeCount = () => (winL.resize || []).length, scrollCount = () => (doc._listeners.scroll || []).length;
  let edRect = { top: 176, bottom: 388, left: 288, right: 579 }, trap = false, host = null;
  const hostRect = () => ({ top: edRect.top - 11, bottom: edRect.bottom + 11, left: 268, right: 588, width: 320, height: 234 });
  const ed = M.margin.openEditor({ promptId: null, anchor: Object.assign({}, ANCHOR, { y: 50 }), initialText: "Q. " });
  try {
    g.innerWidth = 640; g.innerHeight = 700;
    g.getComputedStyle = (n) => ({ overflowX: n.__clip ? "auto" : "visible", overflowY: n.__clip ? "auto" : "visible", getPropertyValue: () => "" });
    g.addEventListener = (type, fn) => { (winL[type] = winL[type] || []).push(fn); };
    g.removeEventListener = (type, fn) => { const l = winL[type] || [], i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
    g.requestAnimationFrame = (fn) => { const id = setTimeout(() => { frames.delete(id); fn(Date.now()); }, 0); frames.add(id); return id; };
    g.cancelAnimationFrame = (id) => { cancelled.push(id); frames.delete(id); clearTimeout(id); };
    const resize = () => (winL.resize || []).slice().forEach((fn) => fn({ type: "resize", target: g }));
    const scroll = (target) => callListeners(doc, { type: "scroll", target });
    ed.el.getBoundingClientRect = () => Object.assign({ width: 291, height: 212 }, edRect);
    host = ed.el.parentNode;                               // stands for the card popover
    host.__clip = true; host.getBoundingClientRect = hostRect;
    scroller.__clip = true; scroller.getBoundingClientRect = () => ({ top: 44, bottom: 700, left: 0, right: 640, width: 640, height: 656 });
    const sizes = [];                                      // the max-height in force each time the picker is measured
    doc.createElement = (tag) => {                         // the picker's layout: 254 px wide, 1048 px of rows, capped by max-height
      const n = realCreate(tag);
      n.getBoundingClientRect = () => {
        if (!n.classList.contains("editor__angles-pop")) return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
        const cap = n.style.maxHeight, w = 254, h = cap === "none" ? 1048 : Math.min(1048, cap ? px(cap) : g.innerHeight - 16);
        sizes.push(cap || "");
        const up = n.classList.contains("editor__angles-pop--up"), right = n.classList.contains("editor__angles-pop--right");
        let top, left;
        if (n.classList.contains("editor__angles-pop--fixed")) {   // a transform on an ancestor makes it the fixed box's frame
          const cb = trap ? hostRect() : WIN;
          top = up ? cb.bottom - px(n.style.bottom) - 4 - h : cb.top + px(n.style.top) + 4;
          left = right ? cb.right - px(n.style.right) - w : cb.left + px(n.style.left);
        } else { top = up ? edRect.top - 4 - h : edRect.bottom + 4; left = right ? edRect.right - w : edRect.left; }
        return { top, bottom: top + h, left, right: left + w, width: w, height: h };
      };
      return n;
    };
    const cls = (pop) => ["up", "right", "fixed"].filter((c) => pop.classList.contains("editor__angles-pop--" + c)).join(" ");
    const inline = (pop) => [pop.style.top, pop.style.bottom, pop.style.left, pop.style.right, pop.style.maxHeight];
    const resize0 = resizeCount(), scroll0 = scrollCount();

    click(anglesBtn(ed));
    let pop = picker(ed);
    assert.ok(pop);
    assert.equal(sizes[0], "none", "its size is taken without the stylesheet's height cap (all 1048 px of rows)");
    assert.equal(cls(pop), "fixed", "it leaves the low box; below the editor (304 px there, 124 above)");
    assert.deepEqual(inline(pop), ["388px", "auto", "288px", "auto", "304px"]);
    assert.equal(doc.activeElement, pop.querySelectorAll(".editor__angle")[0]);
    assert.equal(scrollCount(), scroll0 + 1, "one scroll listener");
    assert.equal(resizeCount(), resize0 + 1, "one resize listener");

    // the page scrolls 60 px: the editor moves, the picker is placed again (one frame later)
    edRect = { top: 116, bottom: 328, left: 288, right: 579 };
    scroll(scroller);
    scroll(scroller);
    assert.equal(frames.size, 1, "one frame for any number of scroll events");
    assert.equal(pop.style.top, "388px", "not before the frame");
    await tick();
    assert.deepEqual(inline(pop), ["328px", "auto", "288px", "auto", "364px"]);
    // the picker's own scroll places nothing
    edRect = { top: 110, bottom: 322, left: 288, right: 579 };
    scroll(pop);
    assert.equal(frames.size, 0);
    await tick();
    assert.equal(pop.style.top, "328px");
    // the editor low in the window: above it (378 px there, 50 below)
    edRect = { top: 430, bottom: 642, left: 288, right: 579 };
    scroll(scroller);
    await tick();
    assert.equal(cls(pop), "up fixed");
    assert.deepEqual(inline(pop), ["auto", "270px", "288px", "auto", "378px"]);
    // at the window's right edge: right-aligned (640 - 630 = 10 px from the right)
    edRect = { top: 176, bottom: 388, left: 400, right: 630 };
    scroll(scroller);
    await tick();
    assert.equal(cls(pop), "right fixed");
    assert.deepEqual(inline(pop), ["388px", "auto", "auto", "10px", "304px"]);
    // a resize places it again too: the window is 100 px lower
    g.innerHeight = 600; WIN.bottom = 600;
    scroller.getBoundingClientRect = () => ({ top: 44, bottom: 600, left: 0, right: 640, width: 640, height: 556 });
    resize();
    await tick();
    assert.deepEqual(inline(pop), ["388px", "auto", "auto", "10px", "204px"]);
    g.innerHeight = 700; WIN.bottom = 700;
    scroller.getBoundingClientRect = () => ({ top: 44, bottom: 700, left: 0, right: 640, width: 640, height: 656 });
    resize();
    await tick();
    assert.deepEqual(inline(pop), ["388px", "auto", "auto", "10px", "304px"]);

    // Esc with a frame waiting: the frame is cancelled, the listeners are gone, a later scroll or resize does nothing
    edRect = { top: 150, bottom: 362, left: 400, right: 630 };
    scroll(scroller);
    assert.equal(frames.size, 1);
    press("Escape", doc.activeElement);
    assert.equal(picker(ed), null);
    assert.equal(cancelled.length, 1, "the waiting frame was cancelled");
    assert.equal(frames.size, 0);
    assert.equal(scrollCount(), scroll0, "no scroll listener left");
    assert.equal(resizeCount(), resize0, "no resize listener left");
    scroll(scroller); resize();
    assert.equal(frames.size, 0, "nothing asks for a frame");
    await tick();
    assert.equal(pop.style.top, "388px", "the closed picker was not placed again");

    // the editor scrolls out of the area (under the toolbar): a fixed picker has no place and closes; the focus goes
    // back to the textarea
    edRect = { top: 176, bottom: 388, left: 288, right: 579 };
    click(anglesBtn(ed));
    pop = picker(ed);
    assert.equal(cls(pop), "fixed");
    edRect = { top: -120, bottom: 92, left: 288, right: 579 };   // partly under the toolbar: still open, below the editor
    scroll(scroller);
    await tick();
    assert.equal(picker(ed), pop);
    assert.deepEqual(inline(pop), ["92px", "auto", "288px", "auto", "600px"]);
    edRect = { top: -168, bottom: 44, left: 288, right: 579 };    // its last px left the area (the scroller starts at 44)
    scroll(scroller);
    await tick();
    assert.equal(picker(ed), null, "closed");
    assert.equal(doc.activeElement, ed.textarea, "the focus is back in the editor");
    assert.equal(anglesBtn(ed).getAttribute("aria-expanded"), "false");
    assert.equal(scrollCount(), scroll0); assert.equal(resizeCount(), resize0);
    assert.equal(editorOf(), ed, "the editor stays open");
    // … and the picker does not open while its editor is out of the area
    assert.equal(ed.openAngles(), false);
    assert.equal(picker(ed), null);
    assert.equal(scrollCount(), scroll0, "no listener from the refused opening"); assert.equal(resizeCount(), resize0);

    // a transform on the box holds a fixed child: the picker goes back inside (absolute, the 120 px minimum)
    edRect = { top: 176, bottom: 388, left: 288, right: 579 };
    trap = true;
    click(anglesBtn(ed));
    pop = picker(ed);
    assert.equal(cls(pop), "", "not fixed");
    assert.deepEqual(inline(pop), ["", "", "", "", "120px"]);
    scroll(scroller);
    assert.equal(frames.size, 0, "a scroll moves an absolute picker with its editor: nothing to place");
    await tick();
    assert.deepEqual(inline(pop), ["", "", "", "", "120px"]);
    press("Escape", doc.activeElement);

    // a box with room (the wide layout: the scroller only): absolute, inside it, capped to the room below; out of the
    // area it stays open (it is clipped with its editor)
    trap = false;
    delete host.__clip;
    click(anglesBtn(ed));
    pop = picker(ed);
    assert.equal(cls(pop), "");
    assert.deepEqual(inline(pop), ["", "", "", "", "304px"]);
    edRect = { top: -400, bottom: -188, left: 288, right: 579 };
    resize();
    await tick();
    assert.equal(picker(ed), pop, "an absolute picker is not closed");
    press("Escape", doc.activeElement);
    assert.equal(scrollCount(), scroll0); assert.equal(resizeCount(), resize0);
  } finally {
    doc.createElement = realCreate;
    if (host) { delete host.__clip; }
    delete scroller.__clip; scroller.getBoundingClientRect = savedRect;
    for (const k of names) { if (saved[k]) g[k] = saved[k].v; else delete g[k]; }
    if (editorOf()) editorOf().run("cancel");
    await tick();
  }
});

test("a press on a heading or between the groups takes no focus (the focused question keeps the keys); a press on a question is the browser's", async () => {
  const ed = M.margin.openEditor({ promptId: null, anchor: Object.assign({}, ANCHOR, { y: 55 }), initialText: "Q. " });
  try {
    click(anglesBtn(ed));
    const pop = picker(ed), items = pop.querySelectorAll(".editor__angle");
    const down = (target) => { const ev = makeEvent("mousedown", target); callListeners(doc, ev); bubble(ev); return ev; };
    assert.equal(down(pop.querySelectorAll(".editor__angle-group")[2]).defaultPrevented, true, "a heading");
    assert.equal(down(pop.querySelectorAll(".editor__angle-set")[1]).defaultPrevented, true, "the gap between two groups");
    assert.equal(down(pop).defaultPrevented, true, "the picker's own padding");
    assert.equal(down(items[4]).defaultPrevented, false, "a question");
    assert.equal(picker(ed), pop, "none of them closes the picker");
    assert.equal(doc.activeElement, items[0], "the focus did not move");
    const r = press("Escape", doc.activeElement);
    assert.equal(r.handled, false, "Esc is still the picker's key");
    assert.equal(picker(ed), null);
    assert.equal(editorOf(), ed);
  } finally { if (editorOf()) editorOf().run("cancel"); await tick(); }
});

// ---- P2.2 a / P2.3 b: the card menu -----------------------------------------------------------------------
test("the card menu: Split for Q./A. and cloze cards only, Another angle… for every kind, both right after Edit", async () => {
  const ids = { qa: await seed("Q. menu qa\nA. x", "qa"), cloze: await seed("Menu {cloze} text", "cloze"),
    note: await seed("A plain note", "note"), highlight: await seed("", "highlight") };
  for (const kind of Object.keys(ids)) {
    const m = menuLabels(ids[kind]);
    const want = kind === "highlight" ? ["Write prompt", "Another angle…"] : kind === "note" ? ["Edit", "Another angle…"] : ["Edit", "Split", "Another angle…"];
    assert.deepEqual(m.labels.slice(0, want.length), want, kind + ": " + m.labels.join(" | "));
    assert.equal(m.labels.includes("Split"), kind === "qa" || kind === "cloze", kind);
    press("Escape", doc.activeElement);
  }
});

test("Another angle… opens the new-prompt editor at the same passage with “Q. ” and the picker open", async () => {
  for (const kind of ["qa", "highlight"]) {
    const id = await seed(kind === "qa" ? "Q. angle source\nA. x" : "", kind);
    const before = live("book_1").length;
    pick(id, "Another angle…");
    const ed = editorOf();
    assert.ok(ed, kind + ": an editor opened");
    assert.equal(ed.prompt, null, "for a NEW prompt");
    assert.equal(ed.textarea.value, "Q. ");
    assert.deepEqual(ed.anchor, M.cache.prompt(id).anchor, "at the same passage");
    assert.ok(picker(ed), "with the picker open");
    assert.equal(doc.activeElement, picker(ed).querySelectorAll(".editor__angle")[0]);
    for (let i = 0; i < 4; i++) press("ArrowDown", doc.activeElement);
    assert.equal(doc.activeElement.getAttribute("data-angle"), "difference", "the fifth question, in the second group");
    press("Enter", doc.activeElement);
    assert.equal(ed.textarea.value, "Q. How is … different from …?\nA. ");
    const typed = "Q. How is a boson different from a fermion (" + kind + ")?\nA. spin";
    type(ed, typed);
    ed.run("save");
    await tick();
    const all = live("book_1");
    assert.equal(all.length, before + 1, "one new prompt");
    const made = all.find((p) => p.text === typed);
    assert.ok(made && made.id !== id);
    assert.deepEqual(made.anchor, M.cache.prompt(id).anchor);
    assert.equal(made.anchor === M.cache.prompt(id).anchor, false, "a copy, not the same object");
  }
});

// ---- P2.2 b–d: Split in the margin --------------------------------------------------------------------------
test("Split, save then save: two prompts at the same passage; the first keeps its schedule, the second is new and opened with the old text", async () => {
  const OLD = "Q. What are the two halves of this prompt?\nA. the first and the second\n#split-me";
  const id = await seed(OLD, "qa");
  const firstBefore = JSON.parse(JSON.stringify(M.cache.prompt(id)));
  const before = live("book_1").length;
  pick(id, "Split");
  const first = editorOf();
  assert.ok(first && first.prompt && first.prompt.id === id, "the normal editor on the prompt");
  assert.equal(first.textarea.value, OLD);
  assert.equal(first.el.querySelector(".editor__note"), null, "the first editor has no split line");
  type(first, "Q. What is the first half of this prompt?\nA. the first\n#split-me");
  first.run("save");
  await tick();
  // the first prompt: edited, same card, same schedule
  const p1 = M.cache.prompt(id);
  assert.equal(p1.text, "Q. What is the first half of this prompt?\nA. the first\n#split-me");
  assert.deepEqual(p1.cards, firstBefore.cards, "reconcileCards keeps its card and schedule");
  // the second editor at once
  const second = editorOf();
  assert.ok(second && second !== first, "a second editor opened at once");
  assert.equal(second.prompt, null, "for a NEW prompt");
  assert.equal(second.textarea.value, OLD, "the text from BEFORE the edit, tags line included");
  assert.deepEqual(second.anchor, firstBefore.anchor, "the same passage");
  const note = second.el.querySelector(".editor__note");
  assert.ok(note, "the quiet line");
  assert.equal(note.textContent, "Second half of the split — keep what the first prompt no longer asks");
  assert.equal(shown(anglesBtn(second)), false, "no Angles button: the editor holds text");
  assert.equal(live("book_1").length, before, "nothing stored before the second save");
  type(second, "Q. What is the second half of this prompt?\nA. the second\n#split-me");
  second.run("save");
  await tick();
  assert.equal(editorOf(), null, "no third editor");
  assert.equal(second.el.parentNode, null, "the line went with its editor");
  const all = live("book_1");
  assert.equal(all.length, before + 1);
  const p2 = all.find((p) => p.text.indexOf("second half") >= 0);
  assert.ok(p2 && p2.id !== id);
  assert.equal(p2.collectionId, "book_1");
  assert.equal(p2.kind, "qa");
  assert.deepEqual(p2.tags, ["split-me"]);
  assert.deepEqual(p2.anchor, firstBefore.anchor, "same anchor");
  assert.notEqual(p2.anchor, M.cache.prompt(id).anchor, "a copy of it");
  assert.equal(p2.flagged, false);
  assert.ok(!p2.obsidianSentAt, "not sent to Obsidian");
  assert.equal(p2.cards.length, 1);
  assert.deepEqual(p2.cards[0].log, [], "a fresh schedule");
  assert.equal(p2.cards[0].lastReviewedAt == null, true);
  assert.equal(p2.context.pageIndex, 0);
  assert.deepEqual(M.cache.prompt(id).cards, firstBefore.cards, "the first prompt's schedule is untouched by the second save");
});

test("Split, cancel in the first editor: nothing happens (no second editor, no change, no copy)", async () => {
  const id = await seed("Q. cancel first?\nA. yes it is", "qa");
  const snap = JSON.stringify(M.cache.prompt(id)), before = live("book_1").length;
  pick(id, "Split");
  const first = editorOf();
  type(first, "Q. something else\nA. x");
  first.run("cancel");
  await tick();
  assert.equal(editorOf(), null, "no second editor");
  assert.equal(JSON.stringify(M.cache.prompt(id)), snap, "the prompt is as it was");
  assert.equal(live("book_1").length, before, "no copy");
});

test("Split, cancel in the second editor: the first edit stays and no second prompt is made", async () => {
  const id = await seed("Q. cancel second?\nA. the second", "qa");
  const cards = JSON.stringify(M.cache.prompt(id).cards), before = live("book_1").length;
  pick(id, "Split");
  type(editorOf(), "Q. first half only?\nA. the first");
  editorOf().run("save");
  await tick();
  const second = editorOf();
  assert.ok(second);
  type(second, "Q. typed and then dropped\nA. x");
  second.run("cancel");
  await tick();
  assert.equal(editorOf(), null);
  assert.equal(M.cache.prompt(id).text, "Q. first half only?\nA. the first", "the first edit stays");
  assert.equal(JSON.stringify(M.cache.prompt(id).cards), cards, "its schedule too");
  assert.equal(live("book_1").length, before, "no copy");
  assert.equal(M.cache.prompts().filter((p) => /dropped|cancel second/.test(p.text)).length, 0, "nothing of the second editor was stored, not even as a tombstone");
  assert.equal(store.has("marginalia.draft.split:" + id), false, "and its draft is gone");
});

test("Split of a cloze whose first edit removes a blank: that card is dropped as edits drop it; the second editor still shows the old text", async () => {
  const OLD = "The {Aare} flows through {Bern}.";
  const id = await seed(OLD, "cloze");
  const old = M.cache.prompt(id);
  assert.equal(old.cards.length, 2);
  const keep = JSON.parse(JSON.stringify(old.cards[0]));
  const asked = [];
  const oldConfirm = M.app.confirm;
  M.app.confirm = (o) => { asked.push(o); return Promise.resolve(true); };
  try {
    pick(id, "Split");
    type(editorOf(), "The {Aare} flows through Bern.");
    editorOf().run("save");
    await tick();
    assert.equal(asked.length, 1, "the usual question for a card with reviews");
    assert.match(asked[0].body, /removes a card with 1 review/);
    const p1 = M.cache.prompt(id);
    assert.equal(p1.text, "The {Aare} flows through Bern.");
    assert.equal(p1.cards.length, 1, "the Bern card is dropped");
    assert.deepEqual(p1.cards[0], keep, "the Aare card keeps its schedule");
    const second = editorOf();
    assert.ok(second, "the second editor opened after the confirmed save");
    assert.equal(second.textarea.value, OLD, "with the old text");
    type(second, "The Aare flows through {Bern}.");
    second.run("save");
    await tick();
    const p2 = live("book_1").find((p) => p.text === "The Aare flows through {Bern}.");
    assert.ok(p2);
    assert.equal(p2.kind, "cloze");
    assert.equal(p2.cards.length, 1);
    assert.deepEqual(p2.cards[0].log, [], "the new prompt's card is new");
  } finally { M.app.confirm = oldConfirm; }
});

test("Split, “Keep editing” at the dropped-card question: no save and no second editor yet", async () => {
  const id = await seed("A {b} and a {c}.", "cloze");
  const oldConfirm = M.app.confirm;
  M.app.confirm = () => Promise.resolve(false);
  try {
    pick(id, "Split");
    const first = editorOf();
    type(first, "A {b} and a c.");
    first.run("save");
    await tick();
    assert.equal(editorOf(), first, "still the first editor");
    assert.equal(M.cache.prompt(id).text, "A {b} and a {c}.");
    first.run("cancel");
    await tick();
    assert.equal(editorOf(), null);
  } finally { M.app.confirm = oldConfirm; }
});

test("Split: a stale draft of a new prompt at the same passage never replaces the old text in the second editor", async () => {
  const OLD = "Q. drafts and splits?\nA. kept apart";
  const id = await seed(OLD, "qa");
  const anchor = M.cache.prompt(id).anchor;
  store.set(M.editor.draftKey(null, anchor), "Q. an old unsaved new prompt here\nA. stale");
  pick(id, "Split");
  type(editorOf(), "Q. drafts?\nA. kept");
  editorOf().run("save");
  await tick();
  assert.equal(editorOf().textarea.value, OLD);
  editorOf().run("cancel");
  await tick();
  assert.equal(store.get(M.editor.draftKey(null, anchor)), "Q. an old unsaved new prompt here\nA. stale", "that draft is left alone");
  store.clear();
});

// ---- P2.2 e: Split in the prompt list (a deck's rows and a book's rows) -----------------------------------
function rows(host) { return host.querySelectorAll(".list__row"); }
function rowOf(host, id) { return host.querySelector('.list__row[data-id="' + id + '"]'); }
function listMenu(host, id) {
  click(rowOf(host, id).querySelector(".list__more"));
  const menu = host.querySelector(".list__menu");
  assert.ok(menu, "the row menu opened");
  return menu;
}
function listPick(host, id, label) {
  const b = listMenu(host, id).querySelectorAll(".list__menu-item").find((x) => x.textContent === label);
  assert.ok(b, label);
  click(b);
}

test("the list's row menu: Split right after Edit for Q./A. and cloze rows, none for notes and highlights", async () => {
  await M.cache.saveCollection({ id: "deck_m", kind: "deck", name: "Menu deck" });
  const ctx = { docName: "Menu deck", sectionLabel: null, pageIndex: null, pageLabel: null };
  const ids = { qa: await seed("Q. a\nA. b", "qa", { collectionId: "deck_m", anchor: null, context: ctx }),
    cloze: await seed("A {c} d", "cloze", { collectionId: "deck_m", anchor: null, context: ctx }),
    note: await seed("just a note", "note", { collectionId: "deck_m", anchor: null, context: ctx }) };
  const host = doc.getElementById("deckHost");
  assert.equal(M.list.open("deck_m", { host }), true);
  try {
    for (const kind of Object.keys(ids)) {
      const labels = listMenu(host, ids[kind]).querySelectorAll(".list__menu-item").map((b) => b.textContent);
      if (kind === "note") assert.deepEqual(labels.slice(0, 2), ["Edit", "Flag"], labels.join(" | "));
      else assert.deepEqual(labels.slice(0, 3), ["Edit", "Split", "Flag"], kind);
      press("Escape", doc.activeElement);
    }
    const hl = await seed("", "highlight");               // a highlight lives in a book
    M.list.close();
    assert.equal(M.list.open("book_1", { host }), true);
    const labels = listMenu(host, hl).querySelectorAll(".list__menu-item").map((b) => b.textContent);
    assert.equal(labels[0], "Write prompt");
    assert.equal(labels.includes("Split"), false);
    press("Escape", doc.activeElement);
  } finally { M.list.close(); }
});

test("a deck prompt: Split in the list keeps the deck's way: the second editor sits in a row after the first, its save makes a new prompt in the same deck and section", async () => {
  await M.cache.saveCollection({ id: "deck_s", kind: "deck", name: "Verbs deck" });
  const ctx = { docName: "Verbs deck", sectionLabel: "Verbs", pageIndex: null, pageLabel: null };
  const OLD = "Q. to run / to walk\nA. laufen / gehen";
  const id = await seed(OLD, "qa", { collectionId: "deck_s", anchor: null, context: ctx });
  const cards = JSON.stringify(M.cache.prompt(id).cards);
  const host = doc.getElementById("deckHost");
  assert.equal(M.list.open("deck_s", { host }), true);
  try {
    listPick(host, id, "Split");
    let ed = M.list.activeEditor();
    assert.ok(ed && ed.prompt && ed.prompt.id === id, "the row's own editor");
    type(ed, "Q. to run\nA. laufen");
    ed.run("save");
    await tick();
    assert.equal(M.cache.prompt(id).text, "Q. to run\nA. laufen");
    assert.equal(JSON.stringify(M.cache.prompt(id).cards), cards, "schedule kept");
    ed = M.list.activeEditor();
    assert.ok(ed && !ed.prompt, "a second editor for a new prompt");
    assert.equal(ed.textarea.value, OLD);
    assert.equal(ed.el.querySelector(".editor__note").textContent, "Second half of the split — keep what the first prompt no longer asks");
    const r = rows(host), at = r.indexOf(rowOf(host, id));
    assert.ok(r[at + 1].classList.contains("list__row--split"), "right after the first prompt's row");
    assert.equal(live("deck_s").length, 1, "nothing stored yet");
    type(ed, "Q. to walk\nA. gehen");
    ed.run("save");
    await tick();
    assert.equal(M.list.activeEditor(), null);
    const all = live("deck_s");
    assert.equal(all.length, 2);
    const p2 = all.find((p) => p.id !== id);
    assert.equal(p2.text, "Q. to walk\nA. gehen");
    assert.equal(p2.anchor, null);
    assert.equal(p2.context.sectionLabel, "Verbs", "the same section");
    assert.equal(p2.context.docName, "Verbs deck");
    assert.equal(p2.flagged, false);
    assert.deepEqual(p2.cards[0].log, []);
    assert.ok(rowOf(host, p2.id), "its row is in the list");
    assert.equal(host.querySelector(".list__row--split"), null, "the editor's row is gone");

    // cancel in the second editor: no copy; cancel in the first: nothing
    listPick(host, id, "Split");
    type(M.list.activeEditor(), "Q. to run (edited)\nA. laufen");
    M.list.activeEditor().run("save");
    await tick();
    M.list.activeEditor().run("cancel");
    await tick();
    assert.equal(live("deck_s").length, 2, "no copy");
    assert.equal(M.cache.prompt(id).text, "Q. to run (edited)\nA. laufen", "the first edit stays");
    assert.equal(host.querySelector(".list__row--split"), null);
    listPick(host, id, "Split");
    M.list.activeEditor().run("cancel");
    await tick();
    assert.equal(M.list.activeEditor(), null, "cancel first: no second editor");
    assert.equal(live("deck_s").length, 2);
    // a blank second half stores nothing
    listPick(host, id, "Split");
    M.list.activeEditor().run("save");
    await tick();
    type(M.list.activeEditor(), "   ");
    M.list.activeEditor().run("save");
    await tick();
    assert.equal(live("deck_s").length, 2, "a blank second half is no prompt");
    assert.equal(M.list.activeEditor(), null);
  } finally { M.list.close(); }
});

test("Split started from the list of a book: the second prompt gets the same anchor and page; the margin shows it", async () => {
  const OLD = "Q. list split in a book?\nA. both halves";
  const id = await seed(OLD, "qa");
  const anchor = JSON.parse(JSON.stringify(M.cache.prompt(id).anchor));
  const host = doc.getElementById("deckHost");
  assert.equal(M.list.open("book_1", { host }), true);
  try {
    listPick(host, id, "Split");
    type(M.list.activeEditor(), "Q. list split?\nA. one half");
    M.list.activeEditor().run("save");
    await tick();
    type(M.list.activeEditor(), "Q. in a book?\nA. other half");
    M.list.activeEditor().run("save");
    await tick();
    const p2 = live("book_1").find((p) => p.text === "Q. in a book?\nA. other half");
    assert.ok(p2);
    assert.deepEqual(p2.anchor, anchor);
    assert.equal(p2.context.pageIndex, 0);
    assert.equal(p2.context.docName, "Book");
    assert.deepEqual(p2.cards[0].log, []);
    assert.ok(card(p2.id), "the margin has its card");
    assert.equal(M.cache.prompt(id).text, "Q. list split?\nA. one half");
  } finally { M.list.close(); }
});

// ---- D20 / P2.3 d: no key added --------------------------------------------------------------------------
test("no key map gains an action (D20): the editor map is save, saveAnother, cancel, wrapCloze; the reader map has no split or angle", () => {
  assert.deepEqual(Object.keys(M.keys.EDITOR_MAP).sort(), ["cancel", "save", "saveAnother", "wrapCloze"]);
  const reader = Object.keys(M.keys.READER_MAP);
  assert.equal(reader.length, 31);
  for (const id of reader) assert.equal(/split|angle/i.test(id), false, id);
});

// ---- FIXES-1 FIX-1: the second half of a split is never lost and never replaced by a stale draft ---------------------
const SPLIT_KEY = (id) => "marginalia.draft.split:" + id;
const menuHas = (id, label) => { const m = menuLabels(id); closeMenus(); press("Escape", doc.activeElement); return m.labels.includes(label); };
function cardMenuLabels(id) { const m = menuLabels(id); const labels = m.labels.slice(); press("Escape", m.menu.querySelector(".menu__item")); return labels; }
async function splitOnce(id, firstText) {
  pick(id, "Split");
  type(editorOf(), firstText);
  editorOf().run("save");
  await tick();
  return editorOf();
}

test("FIX-1 margin: an untouched second half is kept from the moment it opens, survives another editor, and “Finish split” brings it back", async () => {
  const OLD = "Q. What are the energies and states of the ISW?\nA. $E_n$ and $\\psi_n$";
  const id = await seed(OLD, "qa");
  const other = await seed("Q. Another prompt here?\nA. indeed", "qa");
  const second = await splitOnce(id, "Q. What are the energies of the ISW?\nA. $E_n$");
  assert.equal(second.keepDraft, true);
  assert.equal(store.get(SPLIT_KEY(id)), OLD, "kept as the draft at once, untouched (a reload keeps it)");
  pick(other, "Edit");                                    // the user goes on with something else
  await tick();
  assert.equal(store.get(SPLIT_KEY(id)), OLD, "another editor opening keeps it");
  editorOf().run("cancel");
  await tick();
  const labels = cardMenuLabels(id);
  assert.ok(labels.includes("Finish split") && !labels.includes("Split"), labels.join(" | "));
  assert.deepEqual(labels.slice(0, 3), ["Edit", "Finish split", "Another angle…"], "in the place of Split");
  assert.deepEqual(cardMenuLabels(other).slice(0, 2), ["Edit", "Split"], "only that prompt");
  pick(id, "Finish split");
  const again = editorOf();
  assert.ok(again && again.prompt === null, "a new prompt's editor; the first prompt is not edited again");
  assert.equal(again.textarea.value, OLD);
  assert.equal(again.el.querySelector(".editor__note").textContent, "Second half of the split — keep what the first prompt no longer asks");
  assert.deepEqual(again.anchor, M.cache.prompt(id).anchor, "at the same passage");
  assert.equal(M.cache.prompt(id).text, "Q. What are the energies of the ISW?\nA. $E_n$");
  again.run("cancel");
  await tick();
  assert.equal(store.has(SPLIT_KEY(id)), false, "Cancel removes the draft");
  assert.deepEqual(cardMenuLabels(id).slice(0, 2), ["Edit", "Split"], "and the menu shows Split again");
});

test("FIX-1 margin: a typed second half survives a route change; Finish split, then Save stores it and removes the draft", async () => {
  const OLD = "Q. What do $a_+$ and $a_-$ do?\nA. raise and lower";
  const id = await seed(OLD, "qa");
  const second = await splitOnce(id, "Q. What does $a_+$ do?\nA. raises");
  type(second, "Q. What does $a_-$ do?\nA. lowers");
  M.bus.emit("doc:closed", { collectionId: "book_1" });     // the book closes (a route change) before the 300 ms draft write
  assert.equal(editorOf(), null);
  assert.equal(store.get(SPLIT_KEY(id)), "Q. What does $a_-$ do?\nA. lowers", "destroy keeps the typed text");
  M.bus.emit("doc:opened", { collectionId: "book_1" });
  M.bus.emit("pages:measured", { pageTops: [0], pageHeights: [1200] });
  await tick();
  const before = live("book_1").length;
  pick(id, "Finish split");
  assert.equal(editorOf().textarea.value, "Q. What does $a_-$ do?\nA. lowers");
  editorOf().run("save");
  await tick();
  assert.equal(live("book_1").length, before + 1);
  const p2 = live("book_1").find((p) => p.text === "Q. What does $a_-$ do?\nA. lowers");
  assert.ok(p2 && p2.id !== id);
  assert.deepEqual(p2.anchor, M.cache.prompt(id).anchor);
  assert.equal(store.has(SPLIT_KEY(id)), false, "Save removes the draft");
  assert.deepEqual(cardMenuLabels(id).slice(0, 2), ["Edit", "Split"]);
});

test("FIX-1 margin: a stale “split:<id>” draft never shows in a new split of the same prompt", async () => {
  const OLD = "Q. stale halves?\nA. never shown";
  const id = await seed(OLD, "qa");
  pick(id, "Split");                                      // the menu showed Split: no draft yet
  store.set(SPLIT_KEY(id), "Q. a stale second half\nA. from long ago");   // e.g. written meanwhile by another window
  type(editorOf(), "Q. stale?\nA. never");
  editorOf().run("save");
  await tick();
  assert.equal(editorOf().textarea.value, OLD, "the text the prompt had before THIS edit");
  assert.equal(store.get(SPLIT_KEY(id)), OLD);
  editorOf().run("cancel");
  await tick();
  assert.equal(store.has(SPLIT_KEY(id)), false);
});

test("FIX-1: deleting the first prompt removes its split draft; a deleted prompt's draft is never offered", async () => {
  const id = await seed("Q. to be deleted?\nA. soon", "qa");
  await splitOnce(id, "Q. deleted?\nA. soon");            // the second half is left by a route change: its draft waits
  M.bus.emit("doc:closed", { collectionId: "book_1" });
  M.bus.emit("doc:opened", { collectionId: "book_1" });
  M.bus.emit("pages:measured", { pageTops: [0], pageHeights: [1200] });
  await tick();
  assert.ok(store.has(SPLIT_KEY(id)), "the draft waits");
  await M.cache.removePrompt(id);
  await tick();
  assert.equal(store.has(SPLIT_KEY(id)), false, "the delete removed it");
  await M.cache.restorePrompt(id);
  await tick();
  assert.deepEqual(cardMenuLabels(id).slice(0, 2), ["Edit", "Split"], "after an undo the menu offers Split, not a stale half");
  // a draft left for a prompt that no longer lives is not offered anywhere (no card, no row)
  store.set(SPLIT_KEY("p_gone"), "Q. orphan\nA. x");
  assert.equal(card("p_gone"), null);
  store.delete(SPLIT_KEY("p_gone"));
});

test("FIX-1 list (book): an untouched second half survives closing the list; Finish split in the row menu brings it back; Save removes the draft", async () => {
  const OLD = "Q. list halves in a book?\nA. both";
  const id = await seed(OLD, "qa");
  const host = doc.getElementById("deckHost");
  assert.equal(M.list.open("book_1", { host }), true);
  try {
    listPick(host, id, "Split");
    type(M.list.activeEditor(), "Q. list halves?\nA. one");
    M.list.activeEditor().run("save");
    await tick();
    assert.equal(M.list.activeEditor().keepDraft, true);
    assert.equal(store.get(SPLIT_KEY(id)), OLD, "kept from the moment it opens");
    M.list.close();
    assert.equal(store.get(SPLIT_KEY(id)), OLD, "closing the list keeps it");
    assert.equal(M.list.open("book_1", { host }), true);
    const labels = listMenu(host, id).querySelectorAll(".list__menu-item").map((b) => b.textContent);
    press("Escape", doc.activeElement);
    assert.deepEqual(labels.slice(0, 3), ["Edit", "Finish split", "Flag"], labels.join(" | "));
    listPick(host, id, "Finish split");
    const ed = M.list.activeEditor();
    assert.ok(ed && !ed.prompt);
    assert.equal(ed.textarea.value, OLD);
    assert.ok(host.querySelector(".list__row--split"), "in a row of its own");
    assert.equal(M.cache.prompt(id).text, "Q. list halves?\nA. one", "the first prompt is not edited again");
    type(ed, "Q. in a book?\nA. both");
    ed.run("save");
    await tick();
    assert.ok(live("book_1").some((p) => p.text === "Q. in a book?\nA. both"));
    assert.equal(store.has(SPLIT_KEY(id)), false, "Save removes the draft");
    const after = listMenu(host, id).querySelectorAll(".list__menu-item").map((b) => b.textContent);
    press("Escape", doc.activeElement);
    assert.deepEqual(after.slice(0, 2), ["Edit", "Split"]);
  } finally { M.list.close(); }
});

test("FIX-1 list (deck): a typed second half survives another row's editor; Finish split brings it back; Cancel removes the draft", async () => {
  await M.cache.saveCollection({ id: "deck_f", kind: "deck", name: "Finish deck" });
  const ctx = { docName: "Finish deck", sectionLabel: "S", pageIndex: null, pageLabel: null };
  const OLD = "Q. to go / to come\nA. gehen / kommen";
  const id = await seed(OLD, "qa", { collectionId: "deck_f", anchor: null, context: ctx });
  const other = await seed("Q. to see\nA. sehen", "qa", { collectionId: "deck_f", anchor: null, context: ctx });
  const host = doc.getElementById("deckHost");
  assert.equal(M.list.open("deck_f", { host }), true);
  try {
    listPick(host, id, "Split");
    type(M.list.activeEditor(), "Q. to go\nA. gehen");
    M.list.activeEditor().run("save");
    await tick();
    type(M.list.activeEditor(), "Q. to come\nA. kommen");
    listPick(host, other, "Edit");                          // another row's editor closes the split's
    assert.equal(M.list.activeEditor().prompt.id, other);
    assert.equal(store.get(SPLIT_KEY(id)), "Q. to come\nA. kommen");
    M.list.activeEditor().run("cancel");
    await tick();
    listPick(host, id, "Finish split");
    assert.equal(M.list.activeEditor().textarea.value, "Q. to come\nA. kommen");
    assert.equal(live("deck_f").length, 2, "nothing stored yet");
    M.list.activeEditor().run("cancel");
    await tick();
    assert.equal(store.has(SPLIT_KEY(id)), false, "Cancel removes the draft");
    assert.equal(live("deck_f").length, 2, "and stores nothing");
    const labels = listMenu(host, id).querySelectorAll(".list__menu-item").map((b) => b.textContent);
    press("Escape", doc.activeElement);
    assert.deepEqual(labels.slice(0, 2), ["Edit", "Split"]);
  } finally { M.list.close(); }
});

test("FIX-1: other editors keep the old draft rule (a draft only when the text differs; a stored draft wins)", async () => {
  const id = await seed("Q. plain drafts?\nA. as before", "qa");
  pick(id, "Edit");
  assert.equal(editorOf().keepDraft, false);
  assert.equal(store.has("marginalia.draft." + id), false, "an untouched edit writes no draft");
  type(editorOf(), "Q. plain drafts, typed?\nA. as before");
  M.bus.emit("doc:closed", { collectionId: "book_1" });
  assert.equal(store.get("marginalia.draft." + id), "Q. plain drafts, typed?\nA. as before");
  M.bus.emit("doc:opened", { collectionId: "book_1" });
  M.bus.emit("pages:measured", { pageTops: [0], pageHeights: [1200] });
  await tick();
  pick(id, "Edit");
  assert.equal(editorOf().textarea.value, "Q. plain drafts, typed?\nA. as before", "the stored draft wins");
  editorOf().run("cancel");
  await tick();
  assert.equal(store.has("marginalia.draft." + id), false);
});

// ---- FIXES-1 FIX-7 c: a cloze split into two blanks of one sentence makes no look-alike pair -----------------------
test("FIX-7 c: the two halves of a cloze split (one sentence, different blanks) are no look-alikes; the chip leaves them out", async () => {
  await M.cache.saveCollection({ id: "book_lk", kind: "book", name: "Look book" });
  M.bus.emit("doc:closed", { collectionId: "book_1" });
  M.bus.emit("doc:opened", { collectionId: "book_lk" });
  M.bus.emit("pages:measured", { pageTops: [0], pageHeights: [1200] });
  await tick();
  try {
    // (no review history, so the first edit that drops the Bern card asks nothing)
    const id = await seed("The {Aare} flows through {Bern} in Switzerland.", "cloze", { collectionId: "book_lk", log: false });
    await tick();
    const second = await splitOnce(id, "The {Aare} flows through Bern in Switzerland.");
    type(second, "The Aare flows through {Bern} in Switzerland.");
    second.run("save");
    await tick();
    const all = live("book_lk");
    assert.equal(all.length, 2);
    assert.deepEqual(M.similar ? M.similar.pairs(all, []) : [], [], "no pair");
    const host = doc.getElementById("deckHost");
    assert.equal(M.list.open("book_lk", { host }), true);
    try {
      const chip = host.querySelector('.list__chip[data-chip="alike"]');
      assert.ok(chip.classList.contains("is-hidden"), "no Look-alikes chip");
      assert.equal(chip.querySelector(".list__chip-count").textContent, "0");
    } finally { M.list.close(); }
  } finally {
    M.bus.emit("doc:closed", { collectionId: "book_lk" });
    M.bus.emit("doc:opened", { collectionId: "book_1" });
    M.bus.emit("pages:measured", { pageTops: [0], pageHeights: [1200] });
    await tick();
  }
});
