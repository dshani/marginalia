"use strict";
// test/review-dom.test.js — the review overlay's keyboard and focus paths in a small fake DOM that parses the
// overlay's innerHTML, bubbles events, keeps display:none elements unfocusable and emulates how browsers turn
// Space into a click on a focused <button> (SPEC §3 focus owner and Tab trap; §7 "Session" — Space after reveal is
// inert, after every action focus moves to #review — "Configurable shortcuts", "Go to source"; BUILD-NOTES
// "Key routing"). The real js/app.js dispatcher is the document keydown listener, installed as bindDom() does.
// Covers:
//   - Space on a Tab-focused overlay button reaches M.app's dispatcher (the overlay no longer cancels the keydown),
//     runs the bound review action and does not also click the button, with Chromium/WebKit and Gecko activation;
//   - an unbound Space keeps the focused button's own activation;
//   - Tab cycles #review plus the shown, enabled buttons (the hidden source block is skipped before reveal);
//   - stop() never hands focus to a hidden invoker (the "Resume review" pill): focus lands on #reader.
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ------------------------------------------------------------------ fake DOM

class FakeEvent {
  constructor(type, init) {
    Object.assign(this, {
      bubbles: true, cancelable: true, key: "", code: "", keyCode: 0, repeat: false, isComposing: false,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, relatedTarget: null
    }, init || {});
    this.type = type;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; }
}

function captureFlag(opt) { return opt === true || !!(opt && opt.capture); }

class FakeNode {
  constructor(doc, nodeType) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = [];
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i < 0) throw new Error("removeChild: not a child");
    this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(type, fn, opt) { this.listeners.push({ type, fn, capture: captureFlag(opt) }); }
  removeEventListener(type, fn, opt) {
    const capture = captureFlag(opt);
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  // capture (top → parent), target, bubble (parent → top); stopPropagation() ends it
  dispatchEvent(ev) {
    ev.target = this;
    const chain = [];
    for (let x = this.parentNode; x; x = x.parentNode) chain.push(x);
    const fire = (node, pick) => {
      ev.currentTarget = node;
      node.listeners.filter((l) => l.type === ev.type && pick(l)).forEach((l) => { if (!ev.stopped) l.fn.call(node, ev); });
    };
    for (let i = chain.length - 1; i >= 0 && !ev.stopped; i--) fire(chain[i], (l) => l.capture);
    if (!ev.stopped) fire(this, () => true);
    if (ev.bubbles) for (let i = 0; i < chain.length && !ev.stopped; i++) fire(chain[i], (l) => !l.capture);
    return !ev.defaultPrevented;
  }
}

class FakeText extends FakeNode {
  constructor(doc, text) { super(doc, 3); this.data = String(text); }
  get textContent() { return this.data; }
}

const FOCUSABLE_TAGS = { BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1 };
const VOID_TAGS = { BR: 1, HR: 1, IMG: 1, INPUT: 1, WBR: 1 };
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", "#x27": "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m, e) => ENTITIES[e]);

// Enough of an HTML parser for the overlay's own markup: elements, quoted or bare attributes, void and
// self-closed (SVG) elements, text.
function parseInto(parent, html) {
  const doc = parent.ownerDocument, stack = [parent];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const name = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === name) { stack.length = i; break; }
    } else if (m[2]) {
      const node = doc.createElement(m[2]);
      attrRe.lastIndex = 0;
      let a;
      while ((a = attrRe.exec(m[3] || ""))) {
        node.setAttribute(a[1], decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : ""));
      }
      top.appendChild(node);
      if (!m[4] && !VOID_TAGS[node.tagName]) stack.push(node);
    } else if (m[5] !== undefined) {
      top.appendChild(doc.createTextNode(decode(m[5])));
    }
  }
}

// One compound selector: tag, #id, .class, [attr] and :not([attr]) (a comma list is split by the callers).
function matchCompound(el, sel) {
  const m = /^([A-Za-z][\w-]*|\*)?((?:[#.][\w-]+|\[[\w-]+\]|:not\(\[[\w-]+\]\))*)$/.exec(sel);
  if (!m) throw new Error("fake DOM: unsupported selector " + sel);
  if (m[1] && m[1] !== "*" && el.tagName !== m[1].toUpperCase()) return false;
  return (m[2].match(/[#.][\w-]+|\[[\w-]+\]|:not\(\[[\w-]+\]\)/g) || []).every((p) => {
    if (p[0] === "#") return el.id === p.slice(1);
    if (p[0] === ".") return el.classList.contains(p.slice(1));
    if (p[0] === "[") return el.hasAttribute(p.slice(1, -1));
    return !el.hasAttribute(p.slice(6, -2));                 // :not([attr])
  });
}

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc, 1);
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.style = {};
    this.value = "";
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.html = "";
  }
  get nodeName() { return this.tagName; }
  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = String(v); }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = String(v); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { if (v) this.attrs.disabled = ""; else delete this.attrs.disabled; }
  get classList() {
    const el = this;
    const names = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add(...cs) { const s = new Set(names()); cs.forEach((c) => s.add(c)); el.className = Array.from(s).join(" "); },
      remove(...cs) { el.className = names().filter((c) => cs.indexOf(c) < 0).join(" "); },
      toggle(c, force) {
        const has = names().indexOf(c) >= 0, want = force === undefined ? !has : !!force;
        if (want && !has) this.add(c);
        if (!want && has) this.remove(c);
        return want;
      },
      contains(c) { return names().indexOf(c) >= 0; }
    };
  }
  get isConnected() { return this.ownerDocument.contains(this); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) {
    this.childNodes.slice().forEach((c) => this.removeChild(c));
    this.html = "";
    if (String(v)) this.appendChild(this.ownerDocument.createTextNode(v));
  }
  get innerHTML() { return this.html; }
  set innerHTML(v) { this.childNodes.slice().forEach((c) => this.removeChild(c)); this.html = String(v); parseInto(this, this.html); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  // display:none: .is-hidden (styles.css), #review.is-hidden and .review__source.is-hidden (css/review.css), [hidden]
  get rendered() {
    if (!this.isConnected) return false;
    for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.classList.contains("is-hidden") || x.hasAttribute("hidden")) return false;
    return true;
  }
  getClientRects() { return this.rendered ? [{ top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }] : []; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  // As in a browser, focus() is a silent no-op on an element that is not rendered, disabled or not focusable.
  focus() {
    if (this.rendered && !this.disabled && (FOCUSABLE_TAGS[this.tagName] || this.hasAttribute("tabindex"))) this.ownerDocument.setFocus(this);
  }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.setFocus(null); }
  click() { if (!this.disabled) this.dispatchEvent(new FakeEvent("click")); }
  matches(sel) { return String(sel).split(",").some((one) => matchCompound(this, one.trim())); }
  closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.matches(sel)) return x; return null; }
  querySelectorAll(sel) {
    const out = [];
    (function walk(n) { n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); }); })(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  scrollIntoView() {}
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9);
    this.ownerDocument = this;
    this.documentElement = this.appendChild(new FakeElement(this, "html"));
    this.body = this.documentElement.appendChild(new FakeElement(this, "body"));
    this.focused = null;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(this, text); }
  getElementById(id) {
    let hit = null;
    (function walk(n) { n.children.forEach((c) => { if (!hit && c.id === id) hit = c; if (!hit) walk(c); }); })(this);
    return hit;
  }
  // A focused element that leaves the document hands focus to <body> at once; one that only stops being rendered
  // keeps it until the next style update, settle() (Chromium's focus fixup is not synchronous).
  get activeElement() {
    if (this.focused && !this.contains(this.focused)) this.focused = null;
    return this.focused || this.body;
  }
  settle() { if (this.focused && !this.focused.rendered) this.focused = null; }
  setFocus(el) {
    const prev = this.activeElement, next = el && el !== this.body ? el : null;
    if ((next || this.body) === prev) return;
    this.focused = next;
    if (prev !== this.body) {
      prev.dispatchEvent(new FakeEvent("blur", { bubbles: false, cancelable: false, relatedTarget: next }));
      prev.dispatchEvent(new FakeEvent("focusout", { cancelable: false, relatedTarget: next }));
    }
    if (next) {
      const from = prev === this.body ? null : prev;
      next.dispatchEvent(new FakeEvent("focus", { bubbles: false, cancelable: false, relatedTarget: from }));
      next.dispatchEvent(new FakeEvent("focusin", { cancelable: false, relatedTarget: from }));
    }
  }
}

// ------------------------------------------------------------------ the page and the modules

const doc = new FakeDocument();
globalThis.document = doc;
function el(tag, id, parent, attrs) {
  const e = doc.createElement(tag);
  if (id) e.id = id;
  Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
  (parent || doc.body).appendChild(e);
  return e;
}
const appEl = el("div", "app");
const readerEl = el("section", "reader", appEl, { tabindex: "-1" });
const toolbar = el("div", "toolbar", readerEl);
const reviewBtn = el("button", null, toolbar, { type: "button", class: "btn" });                 // a visible invoker
const pill = el("button", null, toolbar, { type: "button", class: "btn reader__pill is-hidden" }); // "Resume review · N left"
el("div", "review", appEl, { class: "is-hidden", tabindex: "-1" });
el("div", "toasts", appEl);

let clock = 1762250000000;
const realNow = Date.now;
Date.now = () => clock;

const errors = [];                                          // M.app reports a throwing M.review call through console.error
const realError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(" ")); };

const M = (globalThis.Marginalia = globalThis.Marginalia || {});
const js = (name) => path.join(__dirname, "..", "js", name + ".js");
["util", "bus", "settings", "scheduler", "prompts", "context", "keys"].forEach((n) => require(js(n)));
const S = M.scheduler, keys = M.keys, settings = M.settings;

const cacheState = { prompts: new Map(), collections: new Map() };
M.cache = {
  prompt: (id) => cacheState.prompts.get(id) || null,
  prompts: () => Array.from(cacheState.prompts.values()),
  collection: (id) => cacheState.collections.get(id) || null,
  savePrompt(p) {
    const saved = Object.assign({}, p, { updatedAt: Date.now() });
    cacheState.prompts.set(p.id, saved);
    M.bus.emit("prompt:saved", { prompt: saved, isNew: false });
    return Promise.resolve(saved);
  },
};
M.store = { meta: { get: () => Promise.resolve(undefined), set: () => Promise.resolve() } };

const app = require(js("app"));
const R = require(js("review"));

const arrivals = [];                                        // each keydown as it reaches the document, before M.app runs
doc.addEventListener("keydown", (ev) => { arrivals.push({ key: ev.key, target: ev.target, prevented: ev.defaultPrevented }); });
doc.addEventListener("keydown", app.handleKeydown);         // M.app's ONE document keydown listener (bindDom)

const graded = [];
M.bus.on("review:graded", (e) => graded.push([e.promptId, e.outcome]));

test.after(() => {
  if (R.isActive() || R.isSuspended()) R.stop();
  console.error = realError;
  Date.now = realNow;
  delete globalThis.document;
});

// ------------------------------------------------------------------ helpers

const host = () => doc.getElementById("review");
// Assertions compare these labels, never the fake elements: a failing assert.equal would make Node's
// AssertionError inspect the element graph with getters on (new arrays on every call), which never ends.
function label(n) {
  if (!n) return "none";
  if (n === doc.body) return "<body>";
  if (n === pill) return "pill";
  if (n === reviewBtn) return "toolbar button";
  if (n.id) return "#" + n.id;
  return n.getAttribute("data-action") || n.tagName;
}
const nameOf = label;
const focused = () => label(doc.activeElement);
function actionBtn(action) {
  const b = host().querySelectorAll("button").filter((x) => x.getAttribute("data-action") === action)[0];
  assert.ok(b, "no overlay button with data-action=" + action);
  return b;
}
function keyEvent(type, key, target, init) {
  const ev = new FakeEvent(type, Object.assign({ key }, init || {}));
  target.dispatchEvent(ev);
  return ev;
}
// Space on whatever has focus, with the activation behaviour of a focused <button>:
//  - "blink" (Chromium, WebKit): a keydown nobody cancelled arms the button; the keyup clicks the armed button
//    unless the keyup is cancelled;
//  - "gecko" (Firefox before it matched Chromium): the keyup clicks the focused button unless the keyup is
//    cancelled, whatever happened to the keydown.
// The keyup goes to the element focused by then (the action may have moved focus to #review).
function pressSpace(engine) {
  const target = doc.activeElement;
  const down = keyEvent("keydown", " ", target);
  const armed = !down.defaultPrevented && target.tagName === "BUTTON" ? target : null;
  const upTarget = doc.activeElement;
  const up = keyEvent("keyup", " ", upTarget);
  const clicks = !up.defaultPrevented && upTarget.tagName === "BUTTON" && (engine === "gecko" || upTarget === armed);
  if (clicks) upTarget.click();
  return { down, up, clicked: clicks ? upTarget : null };
}
// Any other key on whatever has focus; an uncancelled Enter clicks a focused button (keypress activation).
function press(key, init) {
  const target = doc.activeElement;
  const down = keyEvent("keydown", key, target, init);
  if (key === "Enter" && !down.defaultPrevented && target.tagName === "BUTTON") target.click();
  keyEvent("keyup", key, doc.activeElement, init);
  return down;
}
function tab(shift) {
  const down = press("Tab", { shiftKey: !!shift });
  assert.equal(down.defaultPrevented, true, "the overlay traps Tab");
  return doc.activeElement;
}
function tabTo(action) {
  for (let i = 0; i < 12; i++) { const a = tab(); if (nameOf(a) === action) return a; }
  throw new Error("Tab never reached " + action);
}
function tabOrder(n, shift) { const out = []; for (let i = 0; i < n; i++) out.push(nameOf(tab(shift))); return out; }
// A mouse click: Chromium focuses a clicked <button> on mousedown, then the click runs.
function mouseClick(b) { b.focus(); b.click(); }
function noErrors() { assert.deepEqual(errors.splice(0), [], "no M.review call threw"); }

const DAY = S.DAY;
function mkPrompt(id, pageIndex) {
  const card = { createdAt: clock - 30 * DAY, lastReviewedAt: null, intervalMs: S.FIRST, dueAt: clock - 1000, log: [] };
  return {
    id, collectionId: "b1", kind: "qa", text: "Q. What is " + id + "?\nA. 42", tags: [], flagged: false,
    anchor: { pageIndex, pages: [{ pageIndex, rects: [[72, 600, 300, 612]] }], quote: "x is 42", prefix: "", suffix: "", items: null, y: 612, lost: false },
    context: { docName: "Griffiths", sectionLabel: "Ch. 1", pageIndex, pageLabel: String(pageIndex + 1) },
    createdAt: clock - 30 * DAY, contentUpdatedAt: clock - 30 * DAY, updatedAt: clock - 30 * DAY, deletedAt: null, v: 1,
    cards: [card], dueAt: card.dueAt,
  };
}
// A "book" review of p_a (page 4) then p_b (page 6), started from the reader with focus on `invoker`.
async function begin(opts) {
  opts = opts || {};
  if (R.isActive() || R.isSuspended()) R.stop();
  settings.set("reviewKeys", Object.assign({}, keys.PRESETS.Default, opts.reviewKeys || {}));
  cacheState.prompts.clear();
  cacheState.collections.clear();
  cacheState.collections.set("b1", { id: "b1", kind: "book", name: "Griffiths", hasBytes: opts.hasBytes !== false, sections: [] });
  (opts.prompts || [mkPrompt("p_a", 3), mkPrompt("p_b", 5)]).forEach((p) => cacheState.prompts.set(p.id, p));
  pill.classList.add("is-hidden");
  reviewBtn.disabled = false;
  app.setFocusOwner("reader");
  (opts.invoker || readerEl).focus();
  graded.length = 0;
  arrivals.length = 0;
  errors.length = 0;
  await R.start({ scope: "book", collectionId: "b1" });
  assert.equal(focused(), "#review", "start() focuses #review");
  assert.equal(app.focusOwner(), "review");
}

// ------------------------------------------------------------------ Space on a Tab-focused button

for (const engine of ["blink", "gecko"]) {
  test(`Space on the Tab-focused "Exit review" button reaches M.app's dispatcher: the answer shows, nothing exits (${engine})`, async () => {
    await begin();
    const exitBtn = tab();
    assert.equal(nameOf(exitBtn), "exit");
    const r = pressSpace(engine);
    assert.deepEqual(arrivals.map((a) => [a.key, a.target === exitBtn, a.prevented]).filter((a) => a[0] === " "), [[" ", true, false]],
      "the overlay leaves the Space keydown uncancelled for M.app");
    assert.equal(r.down.defaultPrevented, true, "M.app's dispatcher took Space (showAnswer)");
    assert.equal(label(r.clicked), "none", "the focused button is not clicked as well");
    assert.equal(R.isActive(), true, "Exit review did not run");
    assert.equal(R.current().revealed, true);
    assert.ok(host().querySelector(".review__a").classList.contains("is-shown"));
    assert.equal(focused(), "#review", "focus moves to #review after the action");
    noErrors();
  });

  test(`Space on the Tab-focused "Show answer" and "Skip" buttons reveals through the dispatcher; Skip does not run (${engine})`, async () => {
    await begin();
    tab();
    const showBtn = tab();
    assert.equal(nameOf(showBtn), "reveal", "the hidden source buttons are not Tab stops");
    let r = pressSpace(engine);
    assert.equal(r.down.defaultPrevented, true);
    assert.equal(label(r.clicked), "none");
    assert.equal(R.current().revealed, true);
    assert.equal(focused(), "#review");

    await begin();
    assert.deepEqual([nameOf(tab(true)), nameOf(tab(true))], ["delete", "flag"], "Shift+Tab from #review wraps to the last button (P1.3: Delete, then Flag)");
    const skipBtn = tab(true);
    assert.equal(nameOf(skipBtn), "skip");
    r = pressSpace(engine);
    assert.equal(label(r.clicked), "none");
    assert.equal(R.current().item.promptId, "p_a", "not skipped");
    assert.equal(R.current().revealed, true, "Space is showAnswer");
    assert.equal(focused(), "#review");
    noErrors();
  });

  test(`after reveal, Space on a Tab-focused grade button is inert: no grade and no click (${engine})`, async () => {
    await begin();
    pressSpace(engine);                                    // on #review: Show answer
    assert.equal(R.current().revealed, true);
    tabTo("forgot");
    const r = pressSpace(engine);
    assert.equal(r.down.defaultPrevented, true, "M.app took Space (showAnswer, inert after reveal)");
    assert.equal(r.up.defaultPrevented, true, "the keyup activation is cancelled as well");
    assert.equal(label(r.clicked), "none");
    assert.deepEqual(graded, []);
    assert.equal(R.current().item.promptId, "p_a");
    assert.equal(focused(), "forgot", "nothing ran, nothing moved focus");
    noErrors();
  });

  test(`with Remembered bound to Space, Space on the focused "Forgot" button grades Remembered once (${engine})`, async () => {
    await begin({ reviewKeys: { showAnswer: "Enter", remembered: "Space" } });
    press("Enter");                                        // on #review: Show answer
    assert.equal(R.current().revealed, true);
    tabTo("forgot");
    const r = pressSpace(engine);
    assert.equal(r.down.defaultPrevented, true);
    assert.equal(label(r.clicked), "none", "Forgot is not clicked");
    assert.deepEqual(graded, [["p_a", "remembered"]]);
    assert.equal(R.current().item.promptId, "p_b");
    assert.equal(focused(), "#review");
    noErrors();
  });

  test(`an unbound Space keeps the focused button's own activation: Space on "Skip" skips (${engine})`, async () => {
    await begin({ reviewKeys: { showAnswer: "Enter" } });
    tab(true); tab(true);                                  // past Delete and Flag (FEATURES P1.3 b)
    const skipBtn = tab(true);
    assert.equal(nameOf(skipBtn), "skip");
    const r = pressSpace(engine);
    assert.equal(r.down.defaultPrevented, false, "no review binding took Space");
    assert.equal(r.up.defaultPrevented, false);
    assert.equal(label(r.clicked), "skip");
    assert.equal(R.current().item.promptId, "p_b", "skipped to the next card");
    assert.equal(R.current().revealed, false);
    assert.equal(focused(), "#review");
    noErrors();
  });
}

// ------------------------------------------------------------------ the Tab trap

test("Tab cycles #review and the shown, enabled buttons; the hidden source block is skipped until reveal", async () => {
  await begin();
  // FEATURES P1.3 b: the card's quiet Flag and Delete buttons come last, before and after reveal
  assert.deepEqual(tabOrder(6), ["exit", "reveal", "skip", "flag", "delete", "#review"]);
  assert.deepEqual(tabOrder(6, true), ["delete", "flag", "skip", "reveal", "exit", "#review"]);
  pressSpace("blink");                                     // on #review: Show answer
  assert.deepEqual(tabOrder(8), ["exit", "goToSource", "copyLatex", "forgot", "remembered", "flag", "delete", "#review"]);
  press("2");                                              // Remembered: the next card, with Undo
  assert.equal(focused(), "#review");
  assert.deepEqual(tabOrder(7), ["exit", "reveal", "skip", "undo", "flag", "delete", "#review"]);
  assert.deepEqual(tabOrder(7, true), ["delete", "flag", "undo", "skip", "reveal", "exit", "#review"]);

  await begin({ hasBytes: false });                        // "PDF not in library": a disabled Go to source
  pressSpace("blink");
  assert.equal(actionBtn("goToSource").disabled, true);
  assert.deepEqual(tabOrder(7), ["exit", "copyLatex", "forgot", "remembered", "flag", "delete", "#review"]);
  noErrors();
});

test("stop() removes every listener the overlay put on #review, keyup included", async () => {
  await begin();
  assert.ok(host().listeners.some((l) => l.type === "keyup"));
  R.stop();
  assert.deepEqual(host().listeners.map((l) => l.type), []);
  assert.ok(host().classList.contains("is-hidden"));
  noErrors();
});

// ------------------------------------------------------------------ focus after stop()

// Go to source, then the "Resume review" pill: reader.resumeReview() hides the pill (which a mouse click focused in
// Chromium) before M.review.resume() records document.activeElement, so the session's invoker is a hidden button.
async function resumeFromPill() {
  await begin({ prompts: [mkPrompt("p_a", 3)] });
  R.suspend();
  assert.equal(app.focusOwner(), "reader");
  pill.classList.remove("is-hidden");
  pill.focus();
  pill.classList.add("is-hidden");
  R.resume();
  assert.equal(app.focusOwner(), "review");
  assert.equal(focused(), "#review");
  pressSpace("blink");                                     // Show answer
  press("2");                                              // Remembered: the end screen
  assert.ok(host().classList.contains("review--done"));
  assert.equal(app.focusOwner(), "review", "the end screen keeps the review owner");
}

test("after Resume review, Back to reading on the end screen focuses #reader, not the hidden pill or <body>", async () => {
  await resumeFromPill();
  const back = actionBtn("back");
  assert.equal(back.textContent, "Back to reading");
  mouseClick(back);
  doc.settle();
  assert.equal(R.isActive(), false);
  assert.equal(focused(), "#reader");
  assert.equal(app.focusOwner(), "reader");
  noErrors();
});

test("after Resume review, the exit binding on the end screen focuses #reader", async () => {
  await resumeFromPill();
  press("Escape");
  doc.settle();
  assert.equal(R.isActive(), false);
  assert.equal(focused(), "#reader");
  assert.equal(app.focusOwner(), "reader");
  noErrors();
});

test("stop() gives focus back to a visible invoker, and falls back to #reader when the invoker cannot take it", async () => {
  await begin({ invoker: reviewBtn });
  mouseClick(actionBtn("exit"));
  doc.settle();
  assert.equal(focused(), "toolbar button");

  await begin({ invoker: reviewBtn });
  reviewBtn.disabled = true;                               // focus() on it is a no-op now
  press("Escape");
  doc.settle();
  assert.equal(focused(), "#reader");
  reviewBtn.disabled = false;
  noErrors();
});

// ------------------------------------------------------------------ a blank's cue (FEATURES P1.1)

test("a cloze card shows its blank with the cue beside it; the shown answer is the hidden part without the cue", async () => {
  const hadMarkup = Object.prototype.hasOwnProperty.call(M, "markup"), oldMarkup = M.markup;
  M.markup = require(js("markup"));                         // the overlay renders through M.markup when it is loaded
  try {
    const p = mkPrompt("p_cue", 3);
    p.kind = "cloze";
    p.text = "The {wave function::two words} is {complex::not real}.";
    p.cards = [Object.assign({ i: 0 }, p.cards[0]), Object.assign({ i: 1 }, p.cards[0], { dueAt: clock + 30 * DAY })];   // only card 0 is due
    await begin({ prompts: [p] });
    assert.equal(R.current().item.cardIndex, 0);
    const column = host().querySelector(".review__column");
    const blank = '<span class="cloze-blank" style="display:inline-block;width:7.2em" data-len="13"></span>';
    assert.ok(column.innerHTML.includes('<div class="review__q">The ' + blank + ' <span class="cloze-cue">(two words)</span> is complex.</div>'), column.innerHTML);
    assert.equal(host().querySelectorAll(".cloze-cue").length, 1, "the asked blank's cue only: the other deletion shows its hidden part");
    assert.equal(host().querySelector(".cloze-cue").textContent, "(two words)");
    pressSpace("blink");                                    // Show answer
    const q = host().querySelector(".review__q");
    assert.equal(q.innerHTML, 'The <mark class="cloze-reveal">wave function</mark> is complex.');
    assert.equal(host().querySelectorAll(".cloze-cue").length, 0, "no cue once the answer shows");
    assert.equal(q.textContent, "The wave function is complex.");
    press("2");                                             // Remembered: the session ends (one due card)
    noErrors();
  } finally {
    if (R.isActive() || R.isSuspended()) R.stop();
    if (hadMarkup) M.markup = oldMarkup; else delete M.markup;
  }
});

// ------------------------------------------------------------------ flag, delete, struggling (FEATURES P1.3, P1.4)

// M.cache's delete and restore, as the cache does them in memory: at once, with their events.
M.cache.removePrompt = (id) => {
  const p = cacheState.prompts.get(id);
  if (p && !p.deletedAt) { p.deletedAt = Date.now(); M.bus.emit("prompt:deleted", { promptId: id, collectionId: p.collectionId }); }
  return Promise.resolve(p);
};
M.cache.restorePrompt = (id) => {
  const p = cacheState.prompts.get(id);
  if (p && p.deletedAt) { p.deletedAt = null; p.contentUpdatedAt = Date.now(); M.bus.emit("prompt:restored", { promptId: id, collectionId: p.collectionId }); }
  return Promise.resolve(p);
};
const toastsEl = () => doc.getElementById("toasts");
const toastTexts = () => toastsEl().querySelectorAll(".toast__text").map((t) => t.textContent);
function clearToasts() { toastsEl().childNodes.slice().forEach((c) => toastsEl().removeChild(c)); }
const kbdOf = (b) => { const k = b.querySelector(".review__kbd"); return k ? k.textContent : ""; };
const labelOf = (b) => { const t = b.textContent, k = kbdOf(b); return (k && t.endsWith(k) ? t.slice(0, -k.length) : t).trim(); };
// a card forgotten on `days` different days (one miss each, 9:00 local) before `clock`
function missLog(days) {
  const out = [];
  for (let i = days; i >= 1; i--) { const t = clock - i * DAY; out.push({ at: t, outcome: "forgot", intervalMs: 600000, dueAt: t + 600000 }); }
  return out;
}

test("the card has quiet Flag / Delete buttons with their keys before and after reveal; F shows ⚑ Flagged and Unflag", async () => {
  await begin();
  assert.deepEqual([labelOf(actionBtn("flag")), kbdOf(actionBtn("flag"))], ["Flag", "F"]);
  assert.deepEqual([labelOf(actionBtn("delete")), kbdOf(actionBtn("delete"))], ["Delete", "⌫"]);
  assert.equal(host().querySelector(".review__flag"), null);
  press("f");
  assert.equal(cacheState.prompts.get("p_a").flagged, true);
  assert.equal(host().querySelector(".review__flag").textContent, "⚑ Flagged");
  assert.deepEqual([labelOf(actionBtn("flag")), kbdOf(actionBtn("flag"))], ["Unflag", "F"]);
  assert.equal(focused(), "#review");
  pressSpace("blink");
  assert.equal(R.current().revealed, true);
  assert.ok(actionBtn("flag") && actionBtn("delete"), "still there after reveal");
  mouseClick(actionBtn("flag"));                           // the button does what F does
  assert.equal(cacheState.prompts.get("p_a").flagged, false);
  assert.equal(host().querySelector(".review__flag"), null);
  assert.equal(R.current().revealed, true, "the answer stays shown");
  assert.equal(focused(), "#review");
  noErrors();
  R.stop();
});

test("an unbound flag key shows no key hint; a rebound one shows its key", async () => {
  await begin({ reviewKeys: { flag: null, delete: "x" } });
  assert.equal(kbdOf(actionBtn("flag")), "");
  assert.equal(kbdOf(actionBtn("delete")), "X");
  press("f");
  assert.equal(cacheState.prompts.get("p_a").flagged, false, "f is unbound");
  R.stop();
});

test("Backspace deletes at once: a toast with Undo, the link reads Undo delete, U restores prompt and card", async () => {
  clearToasts();
  await begin();
  pressSpace("blink");
  press("Backspace");
  assert.ok(cacheState.prompts.get("p_a").deletedAt);
  assert.equal(R.current().item.promptId, "p_b");
  assert.equal(R.current().revealed, false);
  assert.deepEqual(toastTexts(), ["Prompt deleted"]);
  assert.deepEqual(toastsEl().querySelectorAll(".toast__action").map((b) => b.textContent), ["Undo"]);
  assert.deepEqual([labelOf(actionBtn("undo")), kbdOf(actionBtn("undo"))], ["Undo delete", "U"]);
  assert.equal(focused(), "#review");
  press("u");
  assert.equal(cacheState.prompts.get("p_a").deletedAt, null);
  assert.equal(R.current().item.promptId, "p_a");
  assert.equal(R.current().revealed, true, "as it was before the delete");
  assert.deepEqual(toastsEl().querySelectorAll(".toast").map((t) => t.classList.contains("toast--out")), [true], "the toast goes with the undo");
  noErrors();
  R.stop();
});

test("delete on the last card: the end screen counts it apart and offers Undo delete", async () => {
  clearToasts();
  await begin();
  pressSpace("blink"); press("2");                         // p_a remembered
  press("Backspace");                                      // p_b deleted: the session ends
  assert.equal(R.current(), null);
  const summary = host().querySelector(".review__summary").textContent;
  assert.ok(summary.startsWith("1 reviewed · 1 remembered · 0 forgot · 1 deleted · "), summary);
  assert.equal(host().querySelector(".review__done-caption").textContent, "1 prompt reviewed");
  assert.equal(labelOf(actionBtn("undo")), "Undo delete");
  toastsEl().querySelectorAll(".toast__action")[0].click();  // the toast's Undo is the session's undo here
  assert.equal(R.current().item.promptId, "p_b");
  assert.equal(cacheState.prompts.get("p_b").deletedAt, null);
  noErrors();
  R.stop();
});

// D27: a session takes one blank of a sentence; the end screen names the blanks that wait
test("the end screen: a sentence's other blanks wait until the next day and are named (D29); nothing is due at once, so it reads “All caught up”", async () => {
  const sentence = (id, n) => {
    const p = mkPrompt(id, 4);
    const parts = ["{wave}", "{complex}", "{normalised}"].slice(0, n);
    p.kind = "cloze"; p.text = "The " + parts.join(" and ") + " one.";
    p.cards = parts.map(() => Object.assign({}, p.cards[0]));
    return p;
  };
  // 16 hours after the answer is "tomorrow" or "later today", by the time zone the tests run in
  const DAYWORD = "(tomorrow|later today)";
  // the small text of an answer button (the fake DOM has no descendant selectors)
  const sub = (action) => {
    const b = host().querySelectorAll("button").filter((x) => x.getAttribute("data-action") === action)[0], el = b ? b.querySelector(".review__sub") : null;
    return el ? el.textContent : null;
  };
  await begin({ prompts: [mkPrompt("p_a", 3), sentence("p_z", 3)] });
  assert.equal(R.current().total, 2, "one card of the sentence, one of p_a");
  pressSpace("blink"); press("2");
  pressSpace("blink"); press("2");
  assert.equal(R.current(), null);
  assert.equal(host().querySelector("h1").textContent, "All caught up");
  let summary = host().querySelector(".review__summary").textContent;
  assert.match(summary, new RegExp("^2 reviewed · 2 remembered · 0 forgot · 2 more blanks wait until " + DAYWORD + " · nothing else due until "), summary);
  assert.ok(!/more due now/.test(summary), "the held blanks are not “more due now”: " + summary);
  R.stop();

  await begin({ prompts: [sentence("p_y", 2)] });
  assert.equal(sub("forgot"), null, "no answer buttons before the answer shows");
  pressSpace("blink");
  assert.equal(sub("forgot"), "· again this session");
  assert.equal(sub("remembered"), "· next in 2 mo", "the fixture's card was made 30 days ago and never asked: 30 days times 2.3");
  press("1");                                              // wrong: it comes back, and stays shaky after three asks
  pressSpace("blink");
  assert.equal(sub("forgot"), "· again this session");
  assert.equal(sub("remembered"), "· next in 1 d", "after a wrong answer the wait is 1 day (D28)");
  press("1");
  pressSpace("blink");
  assert.equal(sub("forgot"), "· again in 1 d", "the third ask is the session's last");
  press("1");
  assert.equal(R.current(), null);
  summary = host().querySelector(".review__summary").textContent;
  assert.match(summary, new RegExp("^1 reviewed · 0 remembered · 3 forgot · 1 still shaky \\(due again tomorrow\\) · 1 more blank waits until " + DAYWORD + " · nothing else due until tomorrow$"), summary);
  assert.equal(host().querySelector("h1").textContent, "All caught up", "the card answered wrong comes tomorrow, not at once (D28)");
  R.stop();

  await begin({ prompts: [mkPrompt("p_a", 3), sentence("p_x", 1)] });
  pressSpace("blink"); press("2");
  pressSpace("blink"); press("2");
  assert.equal(host().querySelector("h1").textContent, "All caught up");
  summary = host().querySelector(".review__summary").textContent;
  assert.ok(!/blank/.test(summary), summary);
  assert.ok(/ · nothing due until /.test(summary) && !/nothing else due/.test(summary), summary);
  noErrors();
  R.stop();
});

test("the end line says truly when things come back: 16 hours after a session at 7:30 is that evening, after one at noon the next day", async () => {
  const saved = clock;
  const sentence = (id) => {
    const p = mkPrompt(id, 4);
    p.kind = "cloze"; p.text = "The {wave} and {complex} one.";
    p.cards = [Object.assign({}, p.cards[0]), Object.assign({}, p.cards[0])];
    return p;
  };
  try {
    // local times, so that the words are the same in every time zone the tests run in
    for (const [hour, word] of [[7, "later today"], [0, "later today"], [8, "tomorrow"], [12, "tomorrow"], [23, "tomorrow"]]) {
      clock = new Date(2026, 10, 14, hour, 30, 0).getTime();
      await begin({ prompts: [mkPrompt("p_a", 3), sentence("p_z")] });
      pressSpace("blink"); press("1");                     // p_a wrong
      pressSpace("blink"); press("2");                     // one blank of the sentence right: the other blank is held
      pressSpace("blink"); press("1");                     // p_a wrong again …
      pressSpace("blink"); press("1");                     // … and a third time: still shaky
      assert.equal(R.current(), null);
      assert.equal(host().querySelector(".review__summary").textContent,
        "2 reviewed · 1 remembered · 3 forgot · 1 still shaky (due again " + word + ") · 1 more blank waits until " + word + " · nothing else due until " + word,
        "a session at " + hour + ":30");
      assert.equal(host().querySelector("h1").textContent, "All caught up");
      R.stop();
    }
    noErrors();
  } finally { clock = saved; }
});

test("a blank that was skipped away holds nothing back: its sentence's blanks are still due, and the end screen says so", async () => {
  const p = mkPrompt("p_z", 4);
  p.kind = "cloze"; p.text = "The {wave} and {complex} one.";
  p.cards = [Object.assign({}, p.cards[0]), Object.assign({}, p.cards[0])];
  await begin({ prompts: [p] });
  press("s"); press("s");                                  // once to the end, twice out of the session: no answer
  assert.equal(R.current(), null);
  assert.equal(host().querySelector("h1").textContent, "Done for now");
  const summary = host().querySelector(".review__summary").textContent;
  assert.equal(summary, "0 reviewed · 0 remembered · 0 forgot · 1 skipped · more due now", "no blank is named as waiting: nothing was answered");
  noErrors();
  R.stop();
});

test("a prompt written while the session ran is due at once: the end screen reads “Done for now · … · more due now”", async () => {
  await begin();                                           // p_a, p_b
  pressSpace("blink"); press("2");
  cacheState.prompts.set("p_new", mkPrompt("p_new", 9));   // written meanwhile (never asked: due)
  pressSpace("blink"); press("2");
  assert.equal(R.current(), null);
  assert.equal(host().querySelector("h1").textContent, "Done for now");
  const summary = host().querySelector(".review__summary").textContent;
  assert.ok(summary.endsWith(" · more due now"), summary);
  assert.ok(!/blank/.test(summary), "no blank is held: " + summary);
  noErrors();
  R.stop();
});

test("the end screen lists the prompts flagged for revision; a still-shaky flagged one shows once, with ⚑", async () => {
  const c = mkPrompt("p_c", 7);
  await begin({ prompts: [mkPrompt("p_a", 3), mkPrompt("p_b", 5), c] });
  press("f");                                              // p_a flagged
  pressSpace("blink"); press("2");
  press("f");                                              // p_b flagged and forgotten three times: still shaky
  pressSpace("blink"); press("1");
  pressSpace("blink"); press("2");                         // p_c, not flagged
  for (let i = 0; i < 2; i++) { pressSpace("blink"); press("1"); }
  assert.equal(R.current(), null);
  const lists = host().querySelectorAll("ul.review__shaky");
  assert.equal(lists.length, 2);
  assert.equal(host().querySelector(".review__flagged-title").textContent, "Flagged for revision");
  const ids = (ul) => ul.querySelectorAll("button").map((b) => b.getAttribute("data-id"));
  assert.deepEqual(ids(lists[0]), ["p_b"], "still shaky");
  assert.ok(lists[0].querySelector(".review__shaky-flag"), "with the ⚑ mark");
  assert.deepEqual(ids(lists[1]), ["p_a"], "flagged for revision, not p_b again");
  assert.ok(lists[1].classList.contains("review__flagged"));
  assert.equal(lists[1].querySelector(".review__shaky-flag"), null);
  assert.deepEqual(lists[1].querySelectorAll("button").map((b) => [b.getAttribute("data-action"), b.textContent]), [["edit", "Edit"]]);
  noErrors();
  R.stop();
});

test("a struggling card says so once the answer shows, never before; an edit of the prompt makes the line go", async () => {
  const p = mkPrompt("p_s", 3);
  p.cards[0].log = missLog(3);
  await begin({ prompts: [p, mkPrompt("p_b", 5)] });
  assert.equal(R.current().item.promptId, "p_s");
  assert.equal(host().querySelector(".review__struggle"), null, "not before the answer shows");
  pressSpace("blink");
  assert.equal(host().querySelector(".review__struggle").textContent, "Forgotten on 3 days — split it or add a cue");
  // FIXES-1 FIX-5: M.cache sets revisedAt when a content save changes the text (this test double takes it as given)
  M.cache.savePrompt(Object.assign({}, cacheState.prompts.get("p_s"), { text: "Q. What is p_s, really?\nA. 42", contentUpdatedAt: clock, revisedAt: clock }));
  assert.equal(R.current().revealed, true);
  assert.ok(host().querySelector(".review__struggle") === null, "an edit of the text restarts the count");
  noErrors();
  R.stop();
});

// FIXES-1 FIX-5 (was "flagging … makes the line go", P1.4 b): only a change of the text restarts the count
test("flagging a struggling prompt keeps the line (a flag is no change of the text: FIXES-1 FIX-5)", async () => {
  const realSave = M.cache.savePrompt;
  M.cache.savePrompt = (q, opts) => {                       // as M.cache: contentUpdatedAt on a person's edit, revisedAt on a new text
    const old = cacheState.prompts.get(q.id);
    const next = Object.assign({}, q);
    if (opts && opts.content && old && old.flagged !== q.flagged) next.contentUpdatedAt = Date.now();
    if (opts && opts.content && old && old.text !== q.text) next.revisedAt = Date.now();
    return realSave(next, opts);
  };
  try {
    const p = mkPrompt("p_s", 3);
    p.cards[0].log = missLog(4);
    await begin({ prompts: [p] });
    pressSpace("blink");
    assert.equal(host().querySelector(".review__struggle").textContent, "Forgotten on 4 days — split it or add a cue");
    press("f");
    assert.equal(host().querySelector(".review__struggle").textContent, "Forgotten on 4 days — split it or add a cue");
    assert.equal(host().querySelector(".review__flag").textContent, "⚑ Flagged");
    noErrors();
  } finally { M.cache.savePrompt = realSave; R.stop(); }
});

test("a card forgotten three times on one day, or on two days, is not struggling", async () => {
  const p = mkPrompt("p_s", 3), t = clock - 2 * DAY;
  p.cards[0].log = [0, 1, 2].map((i) => ({ at: t + i * 60000, outcome: "forgot", intervalMs: 600000, dueAt: t + i * 60000 + 600000 }));
  const q = mkPrompt("p_t", 5);
  q.cards[0].log = missLog(2);
  await begin({ prompts: [p, q] });
  pressSpace("blink");
  assert.equal(host().querySelector(".review__struggle"), null);
  press("2");
  pressSpace("blink");
  assert.equal(host().querySelector(".review__struggle"), null);
  R.stop();
});
