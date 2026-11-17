// node --test test/pdfview-loader.test.js — the options M.pdfview.open() hands to pdfjsLib.getDocument.
// CVE-2024-4367: PDF.js before 4.2.67 (the app pins 3.11.174) compiles glyph outlines with `new Function`
// and splices the font's /FontMatrix into that source unless getDocument gets isEvalSupported:false, so a
// crafted PDF could run script in the app origin.  pdfjsLib is stubbed here; nothing renders.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pv = require("../js/pdfview.js");

const CMAP_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/";

// Minimal pdfjsLib: getDocument records its params and resolves a two-page document.
function stubPdfjs() {
  const lib = { calls: [], tasks: [] };
  lib.getDocument = (params) => {
    lib.calls.push(params);
    const page = {
      rotate: 0,
      getViewport: (o) => { const s = (o && o.scale) || 1; return { width: 612 * s, height: 792 * s, scale: s }; },
      cleanup() {}
    };
    const pdf = {
      numPages: 2,
      fingerprints: ["fp-test", null],
      getMetadata: () => Promise.resolve({ info: { Title: "Stub" } }),
      getPageLabels: () => Promise.resolve(null),
      getPage: () => Promise.resolve(page),
      getOutline: () => Promise.resolve(null)
    };
    const task = { promise: Promise.resolve(pdf), destroyed: 0, destroy() { task.destroyed++; return Promise.resolve(); } };
    lib.tasks.push(task);
    return task;
  };
  return lib;
}
function installStub(t) {
  const lib = stubPdfjs();
  globalThis.pdfjsLib = lib;
  t.after(async () => { await pv.close(); delete globalThis.pdfjsLib; });
  return lib;
}

test("open() hands getDocument isEvalSupported:false plus the pinned cMap options", async (t) => {
  const lib = installStub(t);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);   // "%PDF-"
  const doc = await pv.open(bytes);
  assert.equal(doc.numPages, 2);
  assert.equal(doc.fingerprint, "fp-test");
  assert.equal(lib.calls.length, 1);
  const p = lib.calls[0];
  assert.strictEqual(p.isEvalSupported, false);                 // CVE-2024-4367 mitigation
  assert.strictEqual(p.data, bytes);
  assert.equal(p.cMapUrl, CMAP_URL);
  assert.equal(p.cMapPacked, true);
});

test("every open() builds fresh params and caller options cannot re-enable eval", async (t) => {
  const lib = installStub(t);
  await pv.open(new Uint8Array([1]));
  lib.calls[0].isEvalSupported = true;                          // a mutated earlier params object must not leak
  await pv.open(new Uint8Array([2]), { isEvalSupported: true, container: null });
  assert.equal(lib.calls.length, 2);
  assert.notStrictEqual(lib.calls[1], lib.calls[0]);
  assert.strictEqual(lib.calls[1].isEvalSupported, false);
  assert.equal(lib.tasks[0].destroyed, 1);                      // the first document was closed before the second opened
});

test("pdfview.js is the only caller of getDocument (no unhardened loader elsewhere)", () => {
  const root = path.join(__dirname, "..");
  const files = fs.readdirSync(path.join(root, "js")).filter((f) => f.endsWith(".js")).map((f) => "js/" + f);
  files.push("index.html");
  const callers = [];
  for (const rel of files) {
    fs.readFileSync(path.join(root, rel), "utf8").split("\n").forEach((line, i) => {
      const s = line.trim();
      if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) return;
      if (/\bgetDocument\s*\(/.test(line)) callers.push(rel + ":" + (i + 1));
    });
  }
  assert.equal(callers.length, 1, callers.join(", "));
  assert.match(callers[0], /^js\/pdfview\.js:\d+$/);
});
