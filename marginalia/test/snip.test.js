// node --test test/snip.test.js — M.snip without a DOM: key routing, mode, describe(), handleRegion flow.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = globalThis.Marginalia = globalThis.Marginalia || {};
const pv = require("../js/pdfview.js");
const snip = require("../js/snip.js");
const H = snip.helpers;

const tick = () => new Promise((r) => setTimeout(r, 5));
function fakeBus() {
  const events = [], handlers = {};
  return { events, on(t, fn) { (handlers[t] = handlers[t] || []).push(fn); return () => {}; }, off() {},
    emit(t, p) { events.push([t, p]); (handlers[t] || []).forEach((fn) => fn(p)); } };
}
function fakeSettings(init) {
  const data = Object.assign({ snipMode: "image" }, init);
  return { get: (k) => data[k], set(k, v) { data[k] = v; if (M.bus) M.bus.emit("settings:changed", { key: k, value: v }); } };
}
function fakeApp() {
  const toasts = [];
  return { toasts, toast(o) { toasts.push(o); return { close() { o.closed = true; } }; } };
}
const pngBlob = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

test("loads without a DOM and exposes the §17 contract", () => {
  for (const f of ["enter", "exit", "isArmed", "mode", "setMode", "toggleMode", "run", "handleRegion", "copyText", "copyBlob"]) assert.equal(typeof snip[f], "function", f);
  assert.equal(M.snip, snip);
  assert.equal(snip.isArmed(), false);
  assert.equal(snip.enter(), false);                 // no document → cannot arm
  assert.equal(snip.exit(), false);
});

test("run(id): snip and snipMode are handled, escape only while armed", () => {
  assert.equal(snip.run("snip"), true);
  assert.equal(snip.run("escape"), false);           // not armed (no DOM to arm with)
  assert.equal(snip.run("prompt"), false);
  assert.equal(snip.run("snipMode"), true);
});

test("mode(), setMode() and toggleMode() go through M.settings and emit snip:state", async () => {
  M.bus = fakeBus(); M.settings = fakeSettings(); M.app = fakeApp();
  M.vision = { detect: () => Promise.resolve("apikey"), transcribe: () => Promise.reject({ code: "no_math" }) };
  await snip.refreshBackend();
  assert.equal(snip.latexAvailable(), true);
  assert.equal(snip.mode(), "image");
  assert.equal(snip.toggleMode(), "latex");
  assert.equal(M.settings.get("snipMode"), "latex");
  assert.equal(snip.setMode("bogus"), "image");
  assert.equal(snip.mode(), "image");
  const st = M.bus.events.filter((e) => e[0] === "snip:state");
  assert.ok(st.length >= 2);
  assert.deepEqual(st[st.length - 1][1], { armed: false, mode: "image", latexAvailable: true });
  // without a vision backend LaTeX cannot be chosen: the hint toast shows and the mode stays image
  M.vision = { detect: () => Promise.resolve(null) };
  await snip.refreshBackend();
  assert.equal(snip.latexAvailable(), false);
  assert.equal(snip.toggleMode(), "image");
  assert.equal(M.app.toasts[M.app.toasts.length - 1].text, H.ERROR_TEXT.no_backend);
});

test("rectFromPoints / clampRect", () => {
  assert.deepEqual(H.rectFromPoints(10, 20, 4, 2), { x: 4, y: 2, w: 6, h: 18 });
  assert.deepEqual(H.clampRect({ x: -5, y: 0, w: 20, h: 50 }, { left: 0, top: 10, right: 12, bottom: 40 }), { x: 0, y: 10, w: 12, h: 30 });
  assert.deepEqual(H.clampRect({ x: 100, y: 100, w: 5, h: 5 }, { left: 0, top: 0, right: 10, bottom: 10 }).w, 0);
});

test("describe(): toast contents for every snip state (§15 texts and actions)", () => {
  const ctx = { editor: false, paste: "Cmd+V" };
  const labels = (d) => d.actions.map((a) => a.label);
  let d = H.describe({ mode: "image", blob: null, copied: null }, ctx);
  assert.equal(d.text, "Capturing…"); assert.equal(d.pending, true);
  d = H.describe({ mode: "image", blob: {}, copied: true }, ctx);
  assert.equal(d.text, "Image copied — press Cmd+V where you want it"); assert.deepEqual(labels(d), ["Switch to LaTeX"]);
  d = H.describe({ mode: "image", blob: {}, copied: false }, { editor: true, paste: "Ctrl+V" });
  assert.deepEqual(labels(d), ["Copy", "Insert at cursor", "Switch to LaTeX"]);
  d = H.describe({ mode: "image", blob: {}, copied: true }, { editor: true });
  assert.deepEqual(labels(d), ["Add to prompt", "Switch to LaTeX"]);
  d = H.describe({ mode: "latex", blob: {}, latex: null, copied: null }, ctx);
  assert.equal(d.text, "Transcribing… (the clipboard updates when done)"); assert.equal(d.pending, true);
  d = H.describe({ mode: "latex", blob: {}, latex: { latex: "x^2", display: false, wrapped: "$x^2$" }, copied: true }, ctx);
  assert.equal(d.text, "LaTeX copied — press Cmd+V where you want it"); assert.equal(d.latex, "x^2"); assert.deepEqual(labels(d), ["Switch to Image"]);
  d = H.describe({ mode: "latex", blob: {}, latex: { latex: "x", wrapped: "$x$", cutOff: true }, copied: false, katexError: "bad" }, ctx);
  assert.equal(d.text, "LaTeX ready — the clipboard was unavailable");
  assert.equal(d.hint, "Transcription was cut off — try a smaller region · May not render: bad");
  assert.deepEqual(labels(d), ["Copy", "Switch to Image"]);
  d = H.describe({ mode: "latex", blob: {}, error: { code: "no_math" } }, ctx);
  assert.equal(d.text, "No equation found"); assert.deepEqual(labels(d), ["Copy image", "Switch to Image"]);
  assert.equal(H.describe({ mode: "latex", blob: {}, error: { code: "refusal" } }, ctx).text, "The model declined this image");
  assert.equal(H.describe({ mode: "latex", blob: {}, error: { code: "cutoff", message: "x" } }, ctx).text, "Transcription was cut off — try a smaller region");
  assert.equal(H.describe({ mode: "latex", blob: {}, error: { code: "auth", message: "API key rejected — check Settings" } }, ctx).text, "API key rejected — check Settings");
  assert.equal(H.describe({ mode: "latex", blob: {}, error: { code: "rate_limit" } }, ctx).text, "Rate limited — try again shortly");
  d = H.describe({ mode: "latex", blob: {}, error: { code: "no_backend" } }, ctx);
  assert.equal(d.hint, H.ERROR_TEXT.no_backend);
  d = H.describe({ mode: "image", captureError: { code: "capture" }, hint: "" }, ctx);
  assert.equal(d.text, "Could not capture the region — try again"); assert.equal(d.error, "capture");
  d = H.describe({ mode: "image", blob: {}, copied: true, hint: "Add an API key in Settings to transcribe LaTeX" }, ctx);
  assert.equal(d.hint, "Add an API key in Settings to transcribe LaTeX");
});

test("handleRegion: image mode without ClipboardItem keeps the result with Copy / Insert at cursor", async () => {
  M.bus = fakeBus(); M.settings = fakeSettings({ snipMode: "image" }); M.app = fakeApp();
  M.pdfview = Object.assign({}, pv, { capture: (i, r, o) => { assert.equal(o.k, 3); assert.deepEqual(r, { x: 1, y: 2, w: 30, h: 20 }); return Promise.resolve(pngBlob()); } });
  M.margin = { activeEditor: () => ({ insertAtCaret() {}, insertAttachment: () => Promise.resolve() }) };
  assert.equal(snip.handleRegion(0, { x: 1, y: 2, w: 30, h: 20 }), true);
  assert.equal(snip.handleRegion(0, { x: 0, y: 0, w: 0, h: 5 }), false);
  await tick();
  const last = M.app.toasts[M.app.toasts.length - 1];
  assert.equal(last.id, "snip");
  assert.equal(last.text, "Image captured — the clipboard was unavailable");
  assert.deepEqual(last.actions.map((a) => a.label), ["Copy", "Insert at cursor", "Switch to LaTeX"]);
  assert.equal(typeof last.actions[0].run, "function");
  assert.equal(last.actions[0].keep, true);                 // Copy re-renders the toast itself
  assert.equal(last.node, null);                            // built only with a DOM
  assert.ok(M.app.toasts.length >= 2 && M.app.toasts[0].text.startsWith("Capturing"));
  M.margin = null;
  M.pdfview = pv;
});

test("handleRegion: LaTeX mode transcribes, shows the LaTeX, and a second snip supersedes the first", async () => {
  M.bus = fakeBus(); M.settings = fakeSettings({ snipMode: "latex" }); M.app = fakeApp();
  const seen = [];
  M.vision = {
    detect: () => Promise.resolve("apikey"),
    transcribe(blob, opts) {
      seen.push(opts.signal);
      return new Promise((resolve, reject) => {
        if (opts.signal) opts.signal.addEventListener("abort", () => reject({ code: "superseded" }));
        setTimeout(() => resolve({ latex: "\\frac{a}{b}", display: false, wrapped: "$\\frac{a}{b}$", cutOff: false }), 10);
      });
    }
  };
  await snip.refreshBackend();
  M.pdfview = Object.assign({}, pv, { capture: () => Promise.resolve(pngBlob()) });
  snip.handleRegion(2, { x: 0, y: 0, w: 40, h: 40 });
  await tick();
  assert.match(M.app.toasts[M.app.toasts.length - 1].text, /^Transcribing…/);
  snip.handleRegion(3, { x: 0, y: 0, w: 40, h: 40 });      // supersedes: the first transcription is aborted
  assert.equal(seen[0].aborted, true);                     // aborted synchronously inside the new gesture
  await tick();                                            // the second capture resolves, then transcribe runs
  assert.equal(seen.length, 2);
  assert.equal(seen[1].aborted, false);
  await new Promise((r) => setTimeout(r, 30));
  const last = M.app.toasts[M.app.toasts.length - 1];
  assert.equal(last.text, "LaTeX ready — the clipboard was unavailable");
  assert.equal(last.detail, undefined);
  assert.deepEqual(last.actions.map((a) => a.label), ["Copy", "Switch to Image"]);
  // the error path: no_math
  M.vision.transcribe = () => Promise.reject({ code: "no_math", message: "NO_MATH" });
  snip.handleRegion(3, { x: 0, y: 0, w: 40, h: 40 });
  await tick();
  const e = M.app.toasts[M.app.toasts.length - 1];
  assert.equal(e.text, "No equation found");
  assert.deepEqual(e.actions.map((a) => a.label), ["Copy image", "Switch to Image"]);
  // a capture failure
  M.pdfview = Object.assign({}, pv, { capture: () => Promise.reject(Object.assign(new Error("x"), { code: "capture" })) });
  snip.handleRegion(1, { x: 0, y: 0, w: 40, h: 40 });
  await tick();
  assert.equal(M.app.toasts[M.app.toasts.length - 1].text, "Could not capture the region — try again");
  // a capture cancelled by the document closing (not by a newer snip) must not leave "Capturing…" behind
  M.pdfview = Object.assign({}, pv, { capture: () => Promise.reject(Object.assign(new Error("Capture cancelled"), { code: "cancelled" })) });
  snip.handleRegion(1, { x: 0, y: 0, w: 40, h: 40 });
  await tick();
  assert.equal(M.app.toasts[M.app.toasts.length - 1].text, "Could not capture the region — try again");
  M.pdfview = pv;
});

test("copyText / copyBlob resolve false without a clipboard and never throw", async () => {
  assert.equal(await snip.copyText("hello"), false);
  assert.equal(await snip.copyBlob(null), false);
  assert.equal(await snip.copyBlob(pngBlob()), false);
});
