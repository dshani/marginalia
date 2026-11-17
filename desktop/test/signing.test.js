"use strict";
// lib/signing.js and how scripts/build.js uses it (FEATURES E2.3 d): where the identity comes from, and the hardened
// runtime only for a Developer ID. No certificate, keychain or codesign is touched here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const signing = require("../lib/signing");
const build = require("../scripts/build");

const FILE = "/desk/sign-identity";
const missing = () => { const e = new Error("ENOENT: no such file"); e.code = "ENOENT"; throw e; };
const file = (text) => (f) => { assert.equal(f, FILE); return text; };
const resolve = (env, readFile) => signing.resolveIdentity({ env, file: FILE, readFile });

test("no variable and no file: ad hoc, no hardened runtime, nothing looked up", () => {
  assert.deepEqual(resolve({}, missing), { identity: "-", source: "none", kind: "ad-hoc", hardenedRuntime: false, identityValidation: false });
  assert.deepEqual(resolve({ PATH: "/bin" }, file("\n   \n\t\n")), { identity: "-", source: "none", kind: "ad-hoc", hardenedRuntime: false, identityValidation: false });
});

test("the variable wins over the file; set to nothing (or \"-\") it means ad hoc", () => {
  const r = resolve({ MARGINALIA_SIGN_IDENTITY: "  Marginalia Local Signing  " }, file("Other Name\n"));
  assert.deepEqual(r, { identity: "Marginalia Local Signing", source: "env", kind: "self-made", hardenedRuntime: false, identityValidation: false });
  for (const blank of ["", "   ", "-", " - "]) {
    const a = resolve({ MARGINALIA_SIGN_IDENTITY: blank }, file("Marginalia Local Signing\n"));
    assert.equal(a.identity, "-", JSON.stringify(blank));
    assert.equal(a.source, "env");
    assert.equal(a.hardenedRuntime, false);
  }
  assert.match(signing.describe(resolve({ MARGINALIA_SIGN_IDENTITY: "" }, missing)), /^signing ad hoc \(MARGINALIA_SIGN_IDENTITY is set/);
});

test("the file: its first non-empty line, trimmed (a name, not a secret)", () => {
  const r = resolve({}, file("\n\n   Marginalia Local Signing \r\nsecond line\n"));
  assert.deepEqual(r, { identity: "Marginalia Local Signing", source: "file", kind: "self-made", hardenedRuntime: false, identityValidation: false });
  assert.match(signing.describe(r), /^signing with "Marginalia Local Signing" \(from desktop\/sign-identity\), without the hardened runtime/);
  assert.equal(signing.firstLine("a\nb"), "a");
  assert.equal(signing.firstLine(""), "");
  assert.equal(signing.firstLine(null), "");
});

test("the hardened runtime only for \"Developer ID Application:\" identities, which are also looked up first", () => {
  const dev = resolve({ MARGINALIA_SIGN_IDENTITY: "Developer ID Application: Alex Example (AB12CD34EF)" }, missing);
  assert.deepEqual(dev, { identity: "Developer ID Application: Alex Example (AB12CD34EF)", source: "env", kind: "developer-id",
    hardenedRuntime: true, identityValidation: true });
  assert.match(signing.describe(dev), /hardened runtime on$/);
  for (const other of ["Apple Development: Alex (X1)", "developer id application: lower case", "Marginalia", "3rd Party Mac Developer Application: X",
    "0123456789ABCDEF0123456789ABCDEF01234567"]) {
    const r = resolve({ MARGINALIA_SIGN_IDENTITY: other }, missing);
    assert.equal(r.kind, "self-made", other);
    assert.equal(r.hardenedRuntime, false, other);
    assert.equal(r.identityValidation, false, other);
  }
});

test("a sign-identity that cannot be read, or a name with a control character, stops the build", () => {
  assert.throws(() => resolve({}, () => { const e = new Error("EISDIR: illegal operation on a directory"); e.code = "EISDIR"; throw e; }), /sign-identity cannot be read/);
  assert.throws(() => resolve({ MARGINALIA_SIGN_IDENTITY: "Name\u0007" }, missing), /control character/);
  assert.throws(() => resolve({}, file("Name\u0000x\n")), /sign-identity holds a control character/);
  assert.throws(() => resolve({ MARGINALIA_SIGN_IDENTITY: "x".repeat(600) }, missing), /longer than/);
});

test("scripts/build.js signs with those rules: the hardened runtime and the look-up follow the identity's kind", () => {
  const ent = "/desk/entitlements.plist";
  const adhoc = build.osxSignOptions(resolve({}, missing), ent);
  assert.equal(adhoc.identity, "-");
  assert.equal(adhoc.identityValidation, false);
  assert.equal(adhoc.continueOnError, false);
  assert.deepEqual(adhoc.optionsForFile("/out/Marginalia.app"), { hardenedRuntime: false, timestamp: "none", entitlements: ent });
  assert.deepEqual(adhoc.optionsForFile("/out/Marginalia.app/Contents/Frameworks/Marginalia Helper.app"), { hardenedRuntime: false, timestamp: "none", entitlements: undefined });
  const self = build.osxSignOptions(resolve({ MARGINALIA_SIGN_IDENTITY: "Marginalia Local Signing" }, missing), ent);
  assert.equal(self.identity, "Marginalia Local Signing");
  assert.equal(self.identityValidation, false);
  assert.equal(self.optionsForFile("/out/Marginalia.app").hardenedRuntime, false);
  const dev = build.osxSignOptions(resolve({ MARGINALIA_SIGN_IDENTITY: "Developer ID Application: D (AB12CD34EF)" }, missing), ent);
  assert.equal(dev.identityValidation, true);
  assert.equal(dev.optionsForFile("/out/Marginalia.app").hardenedRuntime, true);
  assert.equal(build.SIGN_IDENTITY_FILE, path.join(__dirname, "..", "sign-identity"));
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "build.js"), "utf8");
  assert.match(src, /osxSign: osxSignOptions\(sign, entitlements\)/);
  assert.ok(!/MARGINALIA_SIGN_IDENTITY \|\|/.test(src), "the identity comes only through lib/signing.js");
});

test("the build reads codesign's answer: ad hoc or the certificate, and whether the hardened runtime is on", () => {
  const adhoc = "Executable=/x/Marginalia.app/Contents/MacOS/Marginalia\nIdentifier=local.marginalia.desktop\nFormat=app bundle with Mach-O thin (arm64)\n" +
    "CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=28+7 location=embedded\nSignature=adhoc\n";
  assert.deepEqual(build.signatureInfo(adhoc), { signature: "adhoc", runtime: false, flags: "adhoc" });
  const dev = "CodeDirectory v=20500 size=9 flags=0x10000(runtime) hashes=1+7 location=embedded\nAuthority=Developer ID Application: D (AB12CD34EF)\n" +
    "Authority=Developer ID Certification Authority\nAuthority=Apple Root CA\n";
  assert.deepEqual(build.signatureInfo(dev), { signature: "Developer ID Application: D (AB12CD34EF)", runtime: true, flags: "runtime" });
  const self = "CodeDirectory v=20400 size=9 flags=0x0(none) hashes=1+7 location=embedded\nAuthority=Marginalia Local Signing\n";
  assert.deepEqual(build.signatureInfo(self), { signature: "Marginalia Local Signing", runtime: false, flags: "none" });
});

test("desktop/sign-identity is ignored by git; vendor-lock.json is not", () => {
  const ignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(ignore.includes("/sign-identity"));
  assert.ok(!ignore.some((l) => /vendor-lock/.test(l)));
});
