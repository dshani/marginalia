"use strict";
// lib/openfile.js: what the app takes from a file that macOS hands it (DECISIONS D34).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const of = require("../lib/openfile");

test("readPdf takes a PDF by its contents and gives its name and bytes only", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openfile-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  const good = of.readPdf(write("A paper.pdf", "%PDF-1.4\n1 0 obj"), fs);
  assert.equal(good.ok, true);
  assert.deepEqual(Object.keys(good).sort(), ["bytes", "name", "ok"]);
  assert.equal(good.name, "A paper.pdf");
  assert.equal(good.bytes.toString("latin1"), "%PDF-1.4\n1 0 obj");
  // the header may come after some bytes, within the first 1024 (as PDF readers allow)
  assert.equal(of.readPdf(write("late.PDF", " ".repeat(500) + "%PDF-1.7"), fs).ok, true);
  assert.equal(of.readPdf(write("too-late.pdf", " ".repeat(1100) + "%PDF-1.7"), fs).why, "it is not a PDF");
  // a PDF with another extension is still a PDF; a file named .pdf that is none is not
  assert.equal(of.readPdf(write("download", "%PDF-1.5"), fs).ok, true);
  assert.equal(of.readPdf(write("fake.pdf", "<html>"), fs).why, "it is not a PDF");
  assert.equal(of.readPdf(path.join(dir, "missing.pdf"), fs).why, "it cannot be read");
  assert.equal(of.readPdf(dir, fs).why, "it is not a file");
  for (const bad of ["", "relative.pdf", null, 5]) assert.equal(of.readPdf(bad, fs).why, "not an absolute path", String(bad));
  const link = path.join(dir, "link.pdf");
  fs.symlinkSync(path.join(dir, "A paper.pdf"), link);
  assert.equal(of.readPdf(link, fs).name, "link.pdf", "a symlink is followed; the name is the one macOS gave");
});

test("readPdf refuses a file over 300 MB before it reads it", () => {
  let read = false;
  const fake = { statSync: () => ({ isFile: () => true, size: of.MAX_BYTES + 1 }), readFileSync: () => { read = true; return Buffer.from("%PDF-"); } };
  assert.equal(of.readPdf("/x/big.pdf", fake).why, "it is larger than 300 MB");
  assert.equal(read, false);
  assert.equal(of.MAX_BYTES, 300 * 1024 * 1024);
});

test("nameOf keeps the file's own name, without control characters and at most 255 characters", () => {
  assert.equal(of.nameOf("/a/b/Smith 2020 – On things.pdf"), "Smith 2020 – On things.pdf");
  assert.equal(of.nameOf("/a/b\u0007c.pdf"), "bc.pdf");
  assert.equal(of.nameOf("/a/" + "x".repeat(300) + ".pdf").length, 255);
  assert.equal(of.nameOf("/"), "document.pdf");
});
