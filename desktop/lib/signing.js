"use strict";
// Which identity signs Marginalia.app, and how (pure; scripts/build.js uses it, node --test covers it; build-only).
//
// The identity (FEATURES E2.3 d):
//   1. MARGINALIA_SIGN_IDENTITY when it is set: its value, trimmed. Set but empty (or "-") means ad hoc, also when
//      desktop/sign-identity names a certificate: `MARGINALIA_SIGN_IDENTITY= npm run app` builds ad hoc.
//   2. else the first non-empty line of desktop/sign-identity, trimmed: the name of a code-signing certificate in the
//      login keychain (a name, not a secret; git ignores the file). A missing file means none.
//   3. none: ad hoc ("-").
// How it signs (osxSign options in scripts/build.js):
//   ad hoc               no certificate, no hardened runtime, nothing looked up. Its designated requirement is the
//                        code's hash, so every build whose content changed is a new app to macOS's privacy settings
//                        (the Documents permission is asked again after such an update).
//   "Developer ID Application: …"   Apple's certificate (it has a Team ID): the hardened runtime on, with
//                        entitlements.plist (V8's JIT), and the identity looked up first (security find-identity -v).
//   any other name       a self-made certificate (Keychain Access › Certificate Assistant › Create a Certificate, type
//                        Code Signing), which has no Team ID: signed WITHOUT the hardened runtime, whose library
//                        validation refuses a framework signed by a certificate without a Team ID, so Electron's
//                        framework would not load and the app would not start. Not looked up first: macOS does not
//                        trust a self-made certificate, so `security find-identity -v` leaves it out; codesign finds it
//                        by its name and the build fails when it cannot. Its designated requirement names the
//                        certificate, which stays the same across builds, so macOS keeps the Documents permission.
const AD_HOC = "-";
const DEVELOPER_ID_PREFIX = "Developer ID Application:";
const ENV_NAME = "MARGINALIA_SIGN_IDENTITY";
const FILE_NAME = "sign-identity";
const MAX_NAME = 512;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// The first line of `text` that holds more than spaces, trimmed; "" when there is none.
function firstLine(text) {
  for (const line of String(text == null ? "" : text).split(/\r\n|\n|\r/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

function checkName(name, where) {
  if (CONTROL_RE.test(name)) throw new Error(where + " holds a control character; give the certificate's name on one line");
  if (name.length > MAX_NAME) throw new Error(where + " is longer than " + MAX_NAME + " characters; give the certificate's name");
  return name;
}

// kind(identity) → "ad-hoc" | "developer-id" | "self-made"
function kind(identity) {
  if (!identity || identity === AD_HOC) return "ad-hoc";
  return identity.startsWith(DEVELOPER_ID_PREFIX) ? "developer-id" : "self-made";
}

// resolveIdentity({env, file, readFile}) → {identity, source: "env"|"file"|"none", kind, hardenedRuntime,
// identityValidation}. readFile(file) → text; a missing file (ENOENT) means none, any other read error is thrown.
function resolveIdentity(o) {
  const x = o || {};
  const env = x.env || {};
  let name = "", source = "none";
  if (Object.prototype.hasOwnProperty.call(env, ENV_NAME) && env[ENV_NAME] !== undefined) {
    name = checkName(String(env[ENV_NAME]).trim(), ENV_NAME);
    source = "env";
  } else if (x.file && typeof x.readFile === "function") {
    let text = null;
    try { text = x.readFile(x.file); } catch (e) {
      if (!e || e.code !== "ENOENT") throw new Error(FILE_NAME + " cannot be read (" + (e && e.message ? e.message : String(e)) + "): fix it or delete it");
    }
    if (text !== null) {
      name = checkName(firstLine(text), FILE_NAME);
      if (name) source = "file";
    }
  }
  const identity = name && name !== AD_HOC ? name : AD_HOC;
  const k = kind(identity);
  return { identity, source, kind: k, hardenedRuntime: k === "developer-id", identityValidation: k === "developer-id" };
}

// One line for the build's output.
function describe(r) {
  const from = r.source === "env" ? " (from " + ENV_NAME + ")" : r.source === "file" ? " (from desktop/" + FILE_NAME + ")" : "";
  if (r.kind === "ad-hoc") return "signing ad hoc" + (r.source === "env" ? " (" + ENV_NAME + " is set to nothing or \"-\")" : "");
  return "signing with " + JSON.stringify(r.identity) + from + (r.hardenedRuntime ? ", hardened runtime on" :
    ", without the hardened runtime (a certificate that is not a Developer ID has no Team ID)");
}

module.exports = { resolveIdentity, describe, firstLine, kind, AD_HOC, DEVELOPER_ID_PREFIX, ENV_NAME, FILE_NAME };
