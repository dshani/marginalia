"use strict";
// A small rotating log: <dir>/server.log holds the server's output and the app's own lines; when it would pass
// maxBytes it becomes server.log.1 (server.log.1 becomes server.log.2, and so on), and only `keep` files are kept.
// Writes are synchronous appends, so nothing is lost when the app ends right after a line.
const nodeFs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 512 * 1024;
const KEEP = 3;   // server.log, server.log.1, server.log.2

// The renames that make room for a fresh file, oldest first: [from, to] pairs (a missing `from` is skipped).
function rotationPlan(file, keep) {
  const plan = [];
  for (let i = keep - 1; i >= 1; i--) plan.push([i === 1 ? file : file + "." + (i - 1), file + "." + i]);
  return plan;
}

class RotatingLog {
  constructor(file, options) {
    const o = options || {};
    this.file = file;
    this.maxBytes = o.maxBytes || MAX_BYTES;
    this.keep = Math.max(1, o.keep || KEEP);
    this.fs = o.fs || nodeFs;
    this.size = 0;
    this.fd = null;
    this.failed = false;
    try {
      this.fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.open();
    } catch (e) { this.failed = true; }
  }

  open() {
    this.fd = this.fs.openSync(this.file, "a", 0o600);
    try { this.size = this.fs.fstatSync(this.fd).size; } catch (e) { this.size = 0; }
  }

  rotate() {
    if (this.fd !== null) { try { this.fs.closeSync(this.fd); } catch (e) { /* ignore */ } this.fd = null; }
    if (this.keep === 1) { try { this.fs.rmSync(this.file, { force: true }); } catch (e) { /* ignore */ } }
    for (const [from, to] of rotationPlan(this.file, this.keep)) {
      try { this.fs.renameSync(from, to); } catch (e) { /* missing: nothing to move */ }
    }
    this.open();
  }

  write(text) {
    if (this.failed) return false;
    const buf = Buffer.from(String(text), "utf8");
    try {
      if (this.size > 0 && this.size + buf.length > this.maxBytes) this.rotate();
      this.fs.writeSync(this.fd, buf);
      this.size += buf.length;
      return true;
    } catch (e) {
      this.failed = true;
      return false;
    }
  }

  line(text) {
    return this.write("[app " + new Date().toISOString() + "] " + String(text).replace(/\s+$/, "") + "\n");
  }

  close() {
    if (this.fd !== null) { try { this.fs.closeSync(this.fd); } catch (e) { /* ignore */ } this.fd = null; }
  }
}

module.exports = { RotatingLog, rotationPlan, MAX_BYTES, KEEP };
