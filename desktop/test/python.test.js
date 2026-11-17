"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const python = require("../lib/python");

test("the search order is Homebrew (Apple silicon), then /usr/local, then Apple's python3", () => {
  assert.deepEqual(python.CANDIDATES, ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]);
  assert.deepEqual(python.probeArgs("/x/serve.py"), ["-I", "-B", "/x/serve.py", "--help"]);
});

test("the first python3 that runs serve.py wins", async () => {
  const seen = [];
  const r = await python.findPython({
    serveScript: "/web/tools/serve.py",
    probe: async (p, s) => { seen.push([p, s]); return { ok: p === "/usr/local/bin/python3", reason: "x" }; },
    developerToolsPresent: async () => true
  });
  assert.equal(r.python, "/usr/local/bin/python3");
  assert.deepEqual(seen, [["/opt/homebrew/bin/python3", "/web/tools/serve.py"], ["/usr/local/bin/python3", "/web/tools/serve.py"]]);
  assert.equal(r.tried.length, 2);
});

test("Apple's /usr/bin/python3 is tried only when developer tools are present (else it asks to install them)", async () => {
  const seen = [];
  const probe = async (p) => { seen.push(p); return { ok: p === "/usr/bin/python3" }; };
  let r = await python.findPython({ serveScript: "s", probe, developerToolsPresent: async () => false });
  assert.equal(r.python, null);
  assert.deepEqual(seen, ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"]);
  assert.match(r.tried[2].reason, /skipped/);
  seen.length = 0;
  r = await python.findPython({ serveScript: "s", probe, developerToolsPresent: async () => true });
  assert.equal(r.python, "/usr/bin/python3");
});

test("a probe that throws counts as a failure, not a crash", async () => {
  const r = await python.findPython({ serveScript: "s", candidates: ["/a", "/b"], probe: async (p) => { if (p === "/a") throw new Error("boom"); return { ok: true }; } });
  assert.equal(r.python, "/b");
  assert.equal(r.tried[0].ok, false);
  assert.match(r.tried[0].reason, /boom/);
});

test("the default probe reports a missing interpreter without running anything", async () => {
  const r = await python.defaultProbe("/nonexistent/python3", "/x/serve.py");
  assert.deepEqual(r, { ok: false, reason: "not installed" });
});

test("the install help names Homebrew, python.org and the Command Line Tools", () => {
  assert.match(python.INSTALL_HELP, /brew install python/);
  assert.match(python.INSTALL_HELP, /python\.org/);
  assert.match(python.INSTALL_HELP, /xcode-select --install/);
});
