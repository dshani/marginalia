"use strict";
// What the docs must keep saying about the app (the review findings of 2026-11-11 that were doc gaps): the safety rules
// agents follow (CLAUDE.md, BUILD-NOTES "Safety rules") and what the README promises the user. It reads the docs of this
// checkout (../CLAUDE.md, ../marginalia/README.md, ../marginalia/docs/BUILD-NOTES.md, README.md here); a rewrite may
// change the words, not these facts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// The text under a Markdown heading (exactly that line), up to the next heading of the same or a higher level.
function section(text, heading) {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, "no heading " + heading);
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}
const bullet = (text, start) => text.split("\n").find((l) => l.startsWith(start)) || "";

test("CLAUDE.md: agents try the command only as a copy on free ports, and load a cover test page only on / or #library (CMD-2, SEC-4, REQ-F)", (t) => {
  // CLAUDE.md sits at the project's root, beside marginalia/ and desktop/; a copy of only those two folders skips this
  if (!fs.existsSync(path.join(ROOT, "CLAUDE.md"))) { t.skip("no CLAUDE.md beside desktop/ in this copy"); return; }
  const claude = read("CLAUDE.md");
  const rule = bullet(section(claude, "## Desktop app"), "- Never run the project's own `bin/marginalia`");
  for (const must of ["copy of `bin/marginalia`", "MARGINALIA_APP", "MARGINALIA_PORT", "MARGINALIA_APP_PORT", "never 8765, 8791 or 8792",
    "`HOME`", "MARGINALIA_BACKUP_DIR", "open, osascript, lsregister, npm and pgrep"]) assert.ok(rule.includes(must), must);
  // a reader hash follows marginalia:// during boot, before a browser tool could stub the opener
  assert.match(bullet(section(claude, "## Run and check"), "- Browser pane:"), /`--app <x\.y\.z>` and load its page only on `\/` or `#library`/);
});

test("BUILD-NOTES \"Safety rules\" say the same (CMD-2, SEC-4, REQ-F)", () => {
  const safety = bullet(read("marginalia", "docs", "BUILD-NOTES.md"), "- **Safety rules**");
  for (const must of ["copy of `bin/marginalia`", "MARGINALIA_APP_PORT", "never 8765, 8791 or 8792"]) assert.ok(safety.includes(must), must);
  assert.match(safety, /loaded only on `\/` or `#library`/);
});

test("the README promises only what marginalia app does, and names the Documents prompt before the move (CMD-5, REQ-B, F4, REQ-E)", () => {
  const readme = read("marginalia", "README.md");
  assert.ok(!/all its tests pass/.test(readme));
  assert.match(section(readme, "### Update it"), /the build and the packaged app's self-test pass[^\n]*run `marginalia test` first/);
  assert.match(section(readme, "### Install it"), /access files in your Documents folder/);
  assert.match(section(readme, "### Move your library from a browser"), /^1\. [^\n]*Documents folder/m);
});

test("the docs say that a browser tab never reloaded can send through obsidian:// links once the app quits (REQ-A)", () => {
  const browser = section(read("marginalia", "README.md"), "### What the browser shows now");
  assert.match(browser, /after you quit the app, such a tab can send to Obsidian again, through `obsidian:\/\/` links/);
  assert.match(browser, /reload or close every browser tab/);
  assert.match(section(read("desktop", "README.md"), "## Known limits"), /falls back to `obsidian:\/\/` links/);
  assert.match(bullet(read("marginalia", "docs", "BUILD-NOTES.md"), "- **Limits** (part 2)"), /falls back to link mode/);
});

test("with the Mac app, Open in Marginalia goes to the app's window, not a new writing tab (REQ-C)", () => {
  const readme = read("marginalia", "README.md");
  assert.match(bullet(section(readme, "## Obsidian"), "- **Open in Marginalia**"), /With the Mac app/);
  assert.match(section(readme, "## Run it"), /With the Mac app installed, `marginalia` opens the app/);
});

test("the docs say what Cmd+W does since the tabs: it closes a tab, and hides the window only with one tab left (D30)", () => {
  const readme = read("marginalia", "README.md");
  const tabs = section(readme, "## Tabs");
  assert.match(tabs, /With one tab left, Cmd\+W hides the window/);
  assert.match(tabs, /Close Window \(Shift\+Cmd\+W\)/);
  assert.match(tabs, /kept on this Mac only, not in a backup/);
  assert.match(bullet(section(readme, "### Use it"), "- **Cmd+W closes a tab.**"), /With one tab left it closes the window \(Marginalia keeps running\)/);
  const desk = section(read("desktop", "README.md"), "## What the app does");
  const flat = desk.replace(/\s+/g, " ");               // the README wraps its lines
  assert.match(bullet(desk, "- **Closing the window hides it**"), /Close Window Shift\+Cmd\+W, and Cmd\+W with one tab left/);
  assert.match(flat, /Close Tab with one tab left closes the window, which hides it/);
  assert.match(flat, /On "blocked" the window stays/);
  // … and nothing changes tabs during a review or a dialog; Cmd+W then hides the window only with one tab
  assert.match(tabs, /During a review, and while a dialog is open, the tab commands and the tab strip do nothing/);
  assert.match(tabs, /With more than one tab open, Cmd\+W also does nothing then; with one tab it hides the window as always/);
  // the decision itself, and its note on the older one
  const decisions = read("marginalia", "docs", "DECISIONS.md");
  assert.match(decisions, /^D30 Tabs \(2026-11-15\)/m);
  assert.match(decisions, /Changed by D30 \(2026-11-15\): part \(1\) holds, but Cmd\+W now closes a tab first/);
  // the menu's own words
  const menu = require("../lib/menu");
  assert.equal(menu.ACCEL.closeTab, "Command+W");
  assert.equal(menu.ACCEL.close, "Shift+Command+W");
});

test("the docs say how the windows work: one window saves at a time, a window that is not the last one closes, the tabs come back in one window (D31)", () => {
  const readme = read("marginalia", "README.md");
  const windows = section(readme, "## Windows");
  assert.match(windows, /Cmd\+N/);
  assert.match(windows, /One window saves at a time: the window that you use/);
  assert.match(windows, /drag the tab down out of the strip and let it go, inside or outside the window/);
  assert.match(windows, /a small picture of it follows the pointer/);
  assert.match(windows, /A window that is not the last one closes, and its tabs go\. The last window hides/);
  assert.match(windows, /After a restart\*\* Marginalia opens one window/);
  assert.match(windows, /up to 8 windows/);
  assert.match(windows, /In a browser\*\* \(without the Mac app\) there are no such windows/);
  assert.match(bullet(section(readme, "### Use it"), "- **Cmd+N opens a new window.**"), /One window saves at a time/);
  assert.match(section(readme, "## Tabs"), /With more than one window open, a window closes instead: see "Windows"/);
  // the decision in the user's words, and its note on the older one
  const decisions = read("marginalia", "docs", "DECISIONS.md");
  assert.match(decisions, /^D31 Windows \(2026-11-15\)/m);
  assert.match(decisions, /"I want it the way preview works\. So that you can drag a tab to a new window and command N\s+opens a new window"/);
  assert.match(decisions, /Changed by D31 \(2026-11-15\): part \(1\) holds for the last window/);
  // the rules, and what they replace only for the Mac app
  const notes = read("marginalia", "docs", "BUILD-NOTES.md");
  const rules = section(notes, "## Windows (binding; added 2026-11-15)");
  assert.match(rules, /the Web Lock "marginalia\.writer"/);
  assert.match(rules, /Not verified on the real Mac: the drag gestures between real windows/);
  assert.match(section(notes, "## One writing tab per origin (binding; added 2026-11-07)"), /Since D31 the pages of the Mac app do not use this rule/);
  const claude = read("CLAUDE.md");
  assert.match(claude, /\(D1–D33\)/);
  assert.match(claude, /Windows \(D31\) in the real Mac app/);
  const desk = section(read("desktop", "README.md"), "## What the app does").replace(/\s+/g, " ");
  assert.match(desk, /A window that is not the last one closes for good/);
  assert.match(desk, /Electron never makes a window of its own/);
  assert.match(desk, /At most 8 windows/);
  // the menu's own words, and the limits as the code has them
  const menu = require("../lib/menu");
  assert.equal(menu.ACCEL.newWindow, "Command+N");
  assert.equal(require("../lib/policy").MAX_WINDOWS, 8);
  assert.equal(require(path.join(ROOT, "marginalia", "js", "tabs.js")).WINDOWS_MAX, 8);
  const win = menu.buildTemplate({})[3].submenu.filter((i) => i.label).map((i) => i.label);
  for (const label of ["New Window", "Move Tab to New Window", "Merge All Windows"]) {
    assert.ok(win.includes(label), label);
    assert.ok(windows.includes("Window › " + label), "the README names Window › " + label);
  }
});

test("no file of the project holds a home folder's path or an e-mail address (DECISIONS D32: the project is public)", () => {
  // Only the project's own parts are read, never the folder around them: marginalia/, desktop/, bin/, LICENSES/, .claude/
  // and the files at the top. What a build makes is left out, as .gitignore leaves it out.
  const SKIP = new Set(["node_modules", ".cache", "build", "out", "dist", "__pycache__", ".git"]);
  const LOCAL = new Set(["settings.local.json", "sign-identity"]);   // the files of one Mac, which git leaves out too
  const TEXT = /\.(js|json|md|py|css|html|plist|txt)$/;
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name)); }
      else if (e.isFile() && !LOCAL.has(e.name) && (TEXT.test(e.name) || !e.name.includes(".") || e.name === ".gitignore" || e.name === ".npmrc")) files.push(path.join(dir, e.name));
    }
  };
  for (const part of ["marginalia", "desktop", "bin", "LICENSES", ".claude"]) if (fs.existsSync(path.join(ROOT, part))) walk(path.join(ROOT, part));
  for (const name of ["README.md", "CLAUDE.md", "LICENSE", "THIRD-PARTY-NOTICES.md", ".gitignore"]) {
    if (fs.existsSync(path.join(ROOT, name))) files.push(path.join(ROOT, name));
  }
  assert.ok(files.length > 150, "the project's files were found: " + files.length);
  assert.ok(files.some((f) => f.endsWith(path.join("bin", "marginalia"))) && files.some((f) => f.endsWith(path.join("js", "obsidian.js"))));
  // a home folder is written ~/…: the only whole paths are the made-up homes of the tests
  const HOMES = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g, MADE_UP = new Set(["someone", "x", "me"]);
  const MAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  const NOT_MAIL = /^someone@example\.com$|^user@cdnjs\.cloudflare\.com$|@2x\.png$/;   // a made-up address, a test URL, icon names
  const found = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8"), rel = path.relative(ROOT, file);
    for (const m of text.matchAll(HOMES)) if (!MADE_UP.has(m[1])) found.push(rel + ": " + m[0]);
    for (const m of text.matchAll(MAIL)) if (!NOT_MAIL.test(m[0])) found.push(rel + ": " + m[0]);
  }
  assert.deepEqual(found, [], "write ~/… for a home folder, and use made-up names and addresses");
  // the licence the user chose, and the notice for the code of other projects
  if (fs.existsSync(path.join(ROOT, "LICENSE"))) {
    assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) \d{4} \S/);
    assert.equal(require("../package.json").license, "MIT");
    assert.match(read("THIRD-PARTY-NOTICES.md"), /Orbit[^\n]*Andy Matuschak[^\n]*Apache License 2\.0/);
    assert.match(read("LICENSES", "Apache-2.0.txt"), /Apache License\s+Version 2\.0, January 2004/);
  }
});

test("undo and redo (D33): the decision, the rules, and what is not verified on a real Mac are written down", () => {
  const decisions = read("marginalia", "docs", "DECISIONS.md");
  assert.match(decisions, /^D33 Undo and redo for cards \(2026-11-18\)/m);
  assert.match(decisions, /the Edit menu of the Mac app is\s+unchanged/);
  const rules = section(read("marginalia", "docs", "BUILD-NOTES.md"), "## Undo and redo (binding; added 2026-11-18)");
  assert.match(rules, /`revertPrompts\(changes, \{now\}\)`/);
  assert.match(rules, /ONE store write \(`prompts\.putMany`, one transaction\)/);
  assert.match(rules, /The Edit menu of the Mac app is unchanged/);
  assert.match(rules, /A click on Edit › Undo with the pointer acts on text only/);
  assert.match(rules, /Not verified on the real Mac/);
  assert.match(read("CLAUDE.md"), /Undo and redo \(D33\) in the real Mac app/);
  const desk = section(read("desktop", "README.md"), "## Known limits").replace(/\s+/g, " ");
  assert.match(desk, /Undo and Redo in the Edit menu act on text only/);
});
