#!/usr/bin/env node
/* Runtime-backed cross-reference check.
 *
 * Loads the modules through tools/smoke.js --keys to learn each namespace's REAL exported keys,
 * then scans js/*.js for member uses through:
 *   M.ns.name / Marginalia.ns.name
 *   var X = M.ns | dep("ns") | M.ns || dep("ns") | tryDep("ns")      → X.name
 *   function X() { return dep("ns") | M.ns ... }                      → X().name
 * and reports every name that the target namespace does not export, and every js/*.js that tools/smoke.js does not
 * load as a namespace.
 * Usage: node tools/xref-rt.js   (exit 1 when anything is missing)
 */
"use strict";
var fs = require("fs"), path = require("path"), cp = require("child_process");
var ROOT = path.resolve(__dirname, "..");
var info = JSON.parse(cp.execFileSync(process.execPath, [path.join(__dirname, "smoke.js"), "--keys"], { encoding: "utf8" }));
var KEYS = info.keys;
var NS = Object.keys(KEYS);
var JS_PROPS = new Set(["length", "then", "catch", "finally", "call", "apply", "bind", "name", "prototype", "toString", "hasOwnProperty"]);

var problems = [];
// every js/<name>.js is one namespace M.<name> that tools/smoke.js loads (30 modules with js/backup.js, js/desktop.js, js/similar.js, js/stats.js and js/tabs.js)
fs.readdirSync(path.join(ROOT, "js")).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) {
  var n = f.slice(0, -3);
  if (!KEYS[n]) problems.push(["js/" + f, 1, "NOT LOADED as M." + n + " by tools/smoke.js (ORDER)", ""]);
});
fs.readdirSync(path.join(ROOT, "js")).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) {
  var text = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
  var lines = text.split("\n");
  var aliases = {};   // alias → ns  (direct object aliases)
  var fnAliases = {}; // alias → ns  (function returning the module)
  var nsRef = "(?:M\\.([a-z][A-Za-z0-9]*)|(?:try)?[dD]ep\\(\"([a-z]+)\"\\))";
  var re1 = new RegExp("(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" + nsRef + "(?:\\s*\\|\\|\\s*" + nsRef + ")?\\s*[;,)]", "g");
  var re2 = new RegExp("function\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\)\\s*\\{\\s*return\\s+" + nsRef, "g");
  var m;
  while ((m = re1.exec(text))) { var ns = m[2] || m[3] || m[4] || m[5]; if (ns && KEYS[ns]) aliases[m[1]] = ns; }
  while ((m = re2.exec(text))) { var ns2 = m[2] || m[3]; if (ns2 && KEYS[ns2]) fnAliases[m[1]] = ns2; }
  // also "var X = M.ns, Y = M.ns2" chains and ternaries "M.ns && M.ns.foo" are covered by the direct pattern below
  // drop aliases whose name is declared again (another var/let/const or a parameter) elsewhere in the file: their
  // uses cannot be attributed to the module without scope analysis
  function declaredMoreThanOnce(a) {
    var esc = a.replace(/\$/g, "\\$");
    var decl = (text.match(new RegExp("\\b(?:var|let|const)\\s+" + esc + "\\s*=", "g")) || []).length;
    var param = (text.match(new RegExp("function\\s*[\\w$]*\\s*\\([^)]*\\b" + esc + "\\b[^)]*\\)", "g")) || []).length;
    var arrow = (text.match(new RegExp("\\(([^)]*\\b" + esc + "\\b[^)]*)\\)\\s*=>", "g")) || []).length;
    return decl + param + arrow > 1;
  }
  Object.keys(aliases).forEach(function (a) { if (declaredMoreThanOnce(a)) delete aliases[a]; });
  var direct = /\b(?:M|Marginalia)\.([a-z][A-Za-z0-9]*)\.([A-Za-z_$][\w$]*)/g;
  lines.forEach(function (line, i) {
    var t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    var mm;
    while ((mm = direct.exec(line))) {
      var ns = mm[1], name = mm[2];
      if (!KEYS[ns]) { if (NS.indexOf(ns) < 0 && ["bus", "util"].indexOf(ns) < 0) problems.push([f, i + 1, "NO MODULE M." + ns, t]); continue; }
      if (!(name in KEYS[ns]) && !JS_PROPS.has(name)) problems.push([f, i + 1, "MISSING M." + ns + "." + name, t]);
    }
    Object.keys(aliases).forEach(function (a) {
      var re = new RegExp("(?<![\\w$.])" + a.replace(/\$/g, "\\$") + "\\.([A-Za-z_$][\\w$]*)", "g");
      var x;
      while ((x = re.exec(line))) { var n = x[1]; if (!(n in KEYS[aliases[a]]) && !JS_PROPS.has(n)) problems.push([f, i + 1, "MISSING (" + a + "=M." + aliases[a] + ")." + n, t]); }
    });
    Object.keys(fnAliases).forEach(function (a) {
      var re = new RegExp("(?<![\\w$.])" + a.replace(/\$/g, "\\$") + "\\(\\)\\.([A-Za-z_$][\\w$]*)", "g");
      var x;
      while ((x = re.exec(line))) { var n = x[1]; if (!(n in KEYS[fnAliases[a]]) && !JS_PROPS.has(n)) problems.push([f, i + 1, "MISSING (" + a + "()=M." + fnAliases[a] + ")." + n, t]); }
    });
  });
});
problems.forEach(function (p) { console.log(p[2] + "  " + p[0] + ":" + p[1] + "    " + p[3].slice(0, 140)); });
console.log(NS.length + " namespaces loaded, " + problems.length + " unresolved member references");
process.exit(problems.length ? 1 : 0);
