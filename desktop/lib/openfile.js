"use strict";
// PDFs that macOS hands the app (DECISIONS D34): Finder's Open With, `open -b local.marginalia.desktop <file>`, and
// Zotero's "Open in Marginalia" (zotero/). macOS sends each as Electron's "open-file" event with the file's path.
//
// readPdf(file, fs) → {ok: true, name, bytes} | {ok: false, why}: the file must be an absolute path to a regular file
// (a symlink is followed) of at most MAX_BYTES whose first HEAD_BYTES hold "%PDF-" (as js/library.js looksLikePdf
// reads a PDF). The name is the file's own name, cut to MAX_NAME characters. Nothing else of the file's place leaves
// the main process: the page gets the name and the bytes only.
const path = require("node:path");

const CHANNEL = "marginalia:open-pdf";          // main → page only (preload.js): {name, bytes}
const MAX_BYTES = 300 * 1024 * 1024;            // js/library.js MAX_DOC_BYTES
const HEAD_BYTES = 1024;
const MAX_NAME = 255;
const MAX_WAITING = 8;                           // PDFs kept for a page that is not loaded yet; more are dropped

function nameOf(file) {
  const base = path.basename(file).replace(/[\u0000-\u001f\u007f]/g, "");
  return (base || "document.pdf").slice(0, MAX_NAME);
}

function readPdf(file, fsx) {
  if (typeof file !== "string" || !file || !path.isAbsolute(file)) return { ok: false, why: "not an absolute path" };
  let st;
  try { st = fsx.statSync(file); } catch (e) { return { ok: false, why: "it cannot be read" }; }
  if (!st.isFile()) return { ok: false, why: "it is not a file" };
  if (st.size > MAX_BYTES) return { ok: false, why: "it is larger than 300 MB" };
  let bytes;
  try { bytes = fsx.readFileSync(file); } catch (e) { return { ok: false, why: "it cannot be read" }; }
  if (bytes.length > MAX_BYTES) return { ok: false, why: "it is larger than 300 MB" };
  const head = bytes.subarray(0, HEAD_BYTES).toString("latin1");
  if (head.indexOf("%PDF-") < 0) return { ok: false, why: "it is not a PDF" };
  return { ok: true, name: nameOf(file), bytes };
}

module.exports = { readPdf, nameOf, CHANNEL, MAX_BYTES, HEAD_BYTES, MAX_NAME, MAX_WAITING };
