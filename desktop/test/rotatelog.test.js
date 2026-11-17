"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RotatingLog, rotationPlan } = require("../lib/rotatelog");

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotatelog-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the rotation plan shifts every kept file up by one, oldest first", () => {
  assert.deepEqual(rotationPlan("/l/server.log", 3), [["/l/server.log.1", "/l/server.log.2"], ["/l/server.log", "/l/server.log.1"]]);
  assert.deepEqual(rotationPlan("/l/server.log", 1), []);
});

test("a log rotates before it passes maxBytes and keeps only `keep` files", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "logs", "server.log");
  const log = new RotatingLog(file, { maxBytes: 100, keep: 3 });
  for (let i = 0; i < 20; i++) log.write("line " + String(i).padStart(2, "0") + " " + "x".repeat(30) + "\n");
  log.close();
  const names = fs.readdirSync(path.dirname(file)).sort();
  assert.deepEqual(names, ["server.log", "server.log.1", "server.log.2"]);
  for (const n of names) assert.ok(fs.statSync(path.join(dir, "logs", n)).size <= 100, n);
  assert.match(fs.readFileSync(file, "utf8"), /line 19/);
  assert.doesNotMatch(fs.readFileSync(file + ".2", "utf8") + fs.readFileSync(file + ".1", "utf8") + fs.readFileSync(file, "utf8"), /line 00/);
  assert.equal((fs.statSync(path.dirname(file)).mode & 0o777), 0o700);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
});

test("a reopened log appends and counts what is already there", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "server.log");
  const a = new RotatingLog(file, { maxBytes: 60 });
  a.write("a".repeat(50) + "\n");
  a.close();
  const b = new RotatingLog(file, { maxBytes: 60 });
  b.write("b".repeat(20) + "\n");
  b.close();
  assert.equal(fs.readFileSync(file, "utf8"), "b".repeat(20) + "\n");
  assert.equal(fs.readFileSync(file + ".1", "utf8"), "a".repeat(50) + "\n");
});

test("app lines carry a timestamp; a log that cannot be written fails quietly", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "server.log");
  const log = new RotatingLog(file);
  assert.equal(log.line("hello  \n"), true);
  log.close();
  assert.match(fs.readFileSync(file, "utf8"), /^\[app \d{4}-\d{2}-\d{2}T[^\]]+\] hello\n$/);
  fs.writeFileSync(path.join(dir, "blocker"), "");
  const bad = new RotatingLog(path.join(dir, "blocker", "x.log"));
  assert.equal(bad.write("x"), false);
});
