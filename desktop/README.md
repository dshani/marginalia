# Marginalia desktop app

`Marginalia.app` is the web app in `../marginalia` in a window of its own, instead of a tab in a browser.
It is an [Electron](https://www.electronjs.org/) app: a copy of Chromium (the engine Brave and Chrome use) that shows
only Marginalia. It starts its own copy of `tools/serve.py` (the same Python server the `marginalia` command runs)
on http://127.0.0.1:8765/ and stops it again when you quit.

Why: a browser's "Clear browsing data › Cookies and other site data" deletes the library, because the library lives
in that browser's storage for http://127.0.0.1:8765. The app keeps the library in its own folder,
`~/Library/Application Support/Marginalia`, which no browser touches and Time Machine backs up.

The contract is FEATURES-E1 and FEATURES-E2 (the user's decisions of 2026-11-11, D22 and D23 in
`../marginalia/docs/DECISIONS.md`) and `../marginalia/docs/BUILD-NOTES.md`, "Desktop app (binding)". Part 1 built and
tested the app. Part 2 connected it: its server takes writes only from the app's own page, a browser shows "Marginalia is
now an app", the app's welcome card imports the library from the newest backup, and `marginalia app` installs it. How
to move your library from a browser is in `../marginalia/README.md`, "Desktop app".

## Install and update

From the project folder:

```bash
cd desktop && npm ci     # once: the build tools, exactly the versions in package-lock.json
marginalia app           # build, self-test, then install as /Applications/Marginalia.app
marginalia               # open it
```

`marginalia app`:

- refuses while the app runs ("Quit Marginalia first (Cmd+Q), then run marginalia app again."), and when the place
  it installs to holds some other app;
- needs `npm ci` to have run once here (it says so, and does not run it for you);
- runs `npm run app` here: the build and the packaged app's self-test (below). It does not run the unit tests
  (`node --test` here and in `../marginalia`): `marginalia test` does;
- only when that passed, installs in three steps: (1) copies the new app with `ditto` next to the installed one, as
  `/Applications/Marginalia.app.new` (not a name macOS takes for an app); (2) moves the installed copy, if any, to
  `out/previous/Marginalia.app`, while an older copy there waits beside it as `Marginalia.app.old`; (3) renames the
  new copy to `/Applications/Marginalia.app` (one rename in the same folder). Only then the older previous copy is
  deleted, the app is registered with macOS (`lsregister -f`), and the build copy and the previous copy are
  unregistered (`lsregister -u`), so `marginalia://` links always open the installed app;
- ends with "Installed Marginalia 1.7.0. Open it with: marginalia". On any failure the installed app and the previous
  copy stay as they were and the exit code is 1; Ctrl+C or closing the Terminal window while it installs puts
  everything back too ("Stopped before the new app was in place, so the installed app was left as it was."). What a
  `kill -9` or a power cut leaves (`Marginalia.app.new`, `Marginalia.app.old`) is cleared by the next run.

To go back to the previous version, quit the app, then move `out/previous/Marginalia.app` back to `/Applications`.

`MARGINALIA_APP` names another place to install to (the command's tests point it into a temp folder). It must be the
whole path of an app, ending in `.app`; a blank or relative value stops the command instead of falling back to
`/Applications`.

Once the app is installed (`/Applications/Marginalia.app` with the bundle id `local.marginalia.desktop`), the
`marginalia` command works on the app. Without it, every command works as before.

| Command | With the app installed |
|---|---|
| `marginalia`, `marginalia start` | stop the command's own server if it runs (the app needs port 8765), then open the app |
| `marginalia stop` | quit the app and wait up to 10 seconds, then stop the command's own server if it runs |
| `marginalia restart` | stop, then start |
| `marginalia status` | the app's version, whether it runs (its pid), and what uses port 8765 |
| `marginalia app` | build, test and install again |

`marginalia stop` asks the app to quit with AppleScript (`osascript`, by its bundle id). If macOS refuses that (Privacy
& Security › Automation), it sends the app SIGTERM, which quits it the same way. It never touches another program on
the port.

The app always runs its server on port 8765 (`open -a` passes no `--port`). `MARGINALIA_PORT` moves only the command's
own server: with the app installed, `marginalia` stops that server too ("the app replaces it"), and `status` names it.
The command's tests set `MARGINALIA_APP_PORT` to stand for 8765, which they never look at.

## Build

You need an Apple-silicon Mac (the app is built for arm64), Node 22.12 or newer and npm. First time only:

```bash
cd desktop
npm ci            # installs exactly the versions in package-lock.json (no install scripts run: .npmrc)
```

Then, after every change to the web app or to the shell (`marginalia app` runs this for you):

```bash
npm run app
```

It prints seven steps and ends with `done … out/Marginalia-darwin-arm64/Marginalia.app` (about 25 seconds once the
downloads are cached). Before step 1 it stops when `package.json`'s version is not digits.digits.digits (the app
passes it to its server as `--app`) or when the signing identity cannot be used (see Signing). A download that fails
on the network is tried three times in all; then the build stops with "could not download …". Run it again: the
files that came are kept in `.cache/cdn`.

1. **Copy the web app** from `../marginalia` into `build/web`: `index.html`, `styles.css`, `css/*.css`, `js/*.js`,
   `tools/serve.py` and `test/sample.pdf` (the library's "Open sample PDF" button loads it). Never the tests, docs,
   `dist/` or caches. The app carries this copy, so half-finished changes in the project folder never reach it.
2. **Vendor the CDN files** (make local copies), so the app works offline: the Outfit font (Google Fonts), KaTeX
   (CSS, its woff2 fonts, script) and PDF.js 3.11.174 (script and worker). Each is downloaded once into `.cache/cdn/`
   and reused from there without network. Every file must match the fingerprint `vendor-lock.json` pins for it (see
   below). The four cdnjs files `index.html` pins with an SRI hash (a fingerprint: `pdf.min.js`, `katex.min.js`,
   `katex.min.css` and the PDF.js worker) must also match that. Fonts must be woff2 files, and the self-test (step 7)
   loads every one of them, so a damaged font fails the build. Only the app's copy of `index.html` changes: five lines
   now point at `vendor/…`.
3. **Stage the app code** (`main.js`, `preload.js`, the runtime modules of `lib/`, a minimal `package.json`) in
   `build/app`.
4. **Draw the icon** (`lib/icon.js`: a paper page, a red margin line, a yellow card in the margin) and make
   `build/icon/Marginalia.icns` with `iconutil`.
5. **Package** `out/Marginalia-darwin-arm64/Marginalia.app` with `@electron/packager` (Electron itself is
   downloaded once into `.cache/electron` and checked against the checksums in the `electron` npm package), turn
   Electron's fuses (switches built into its binary) to this app's settings, and **sign** it (see Signing).
6. **Check** the result: bundle id `local.marginalia.desktop`, the `marginalia://` link scheme, the version, the fuses,
   the signature (`codesign --verify --deep --strict`, ad hoc or the certificate asked for, and the hardened runtime
   exactly for a Developer ID), and that every vendored file matches its integrity attribute.
7. **Self-test** the packaged app (below). The build fails when any check fails.

`MARGINALIA_OFFLINE=1 npm run app` downloads nothing: the CDN files must already be in `.cache/cdn/` and Electron's
zip in `.cache/electron/`. A missing one stops the build and names it (a missing Electron before step 1, since the
packager would otherwise fetch it). The build never installs into `/Applications` and never starts the app except in
self-test mode.

### vendor-lock.json

`vendor-lock.json` pins the sha384 fingerprint of every file the build downloads for the offline copy, keyed by the
URL it comes from: the two stylesheets as downloaded, the 20 KaTeX fonts, the Outfit fonts, `pdf.min.js`,
`katex.min.js` and the PDF.js worker (27 files today). It is part of the project: commit it with the code. The build
says "vendor-lock.json: 27 files pinned and checked".

Every build checks every file against it, from the cache or from the network, and stops on a mismatch:

- **A cached file does not match**: "That cached file is not the one this project pinned: delete it to download it
  again." The message names the file.
- **A download does not match** (the CDN now sends another file): it never enters the cache, and the build stops. If
  the change is expected, check the new file, then delete its line from `vendor-lock.json` and build again.

A URL the lock does not know yet (for example after `index.html` moves to a new KaTeX version) is pinned the first
time it is downloaded, and URLs the build no longer uses are dropped. Look at the lock's changes before you commit
them.

### Signing

By default the app is signed **ad hoc**: a signature without a certificate, enough to run on this Mac. macOS names an
ad hoc app by a hash of its code (its "cdhash"), so every update is a new app to macOS's privacy settings. The first
time an app reaches into `~/Documents` (its page lists the backup folder at every start, so this is the first start
after the first install, before the move from a browser, and again the first start after each update), macOS is likely to
ask "Marginalia would like to access files in your Documents folder" (Apple's documented behaviour; not observed
here, since tests never touch `~/Documents`). Allow it; "Don't Allow" makes backups, the move and Obsidian sends fail with a permission error ("The
backup folder cannot be read — …" on the welcome card, "Could not back up this browser's library — …" in the browser) until
it is turned on in System Settings › Privacy & Security › Files and Folders.

The build takes its signing identity from:

1. `MARGINALIA_SIGN_IDENTITY`, when it is set. Set to nothing, or to `-`, it means ad hoc, even when
   `desktop/sign-identity` names a certificate: `MARGINALIA_SIGN_IDENTITY= npm run app`.
2. Else the first non-empty line of `desktop/sign-identity`: the name of a certificate in your login keychain. A name
   is not a secret, but it is this Mac's choice, so git ignores the file.
3. Else ad hoc.

An identity that starts with "Developer ID Application:" (Apple's certificate, which has a Team ID) is signed with
the hardened runtime and looked up in the keychain first. Any other name, such as a certificate you made yourself, is
signed **without** the hardened runtime: the hardened runtime refuses Electron's framework when the certificate has no
Team ID, and the app would not start. The build prints what it used, for example `signing ad hoc` or
`signing with "Marginalia Local Signing" (from desktop/sign-identity), without the hardened runtime (…)`, and step 6
checks it.

#### Signing with your own certificate

A certificate of your own stops the Documents question after updates. macOS then knows the app by its bundle id and
the certificate, which stay the same from build to build. It asks once more after the first signed update (one more
new app), and then no more. The certificate does not notarize the app, and nothing else needs it: the app is built on
this Mac, never downloaded.

1. Open Keychain Access. In its menu choose Keychain Access › Certificate Assistant › Create a Certificate…
2. Name: `Marginalia Local Signing` (any name works). Identity Type: Self-Signed Root. Certificate Type: Code
   Signing. It is valid for a year: to make it last longer, tick "Let me override defaults" and enter more days.
   Click Create. The certificate goes into your login keychain.
3. In Terminal, in the project folder: `echo "Marginalia Local Signing" > desktop/sign-identity`
4. Run `marginalia app`. At the first build macOS asks whether codesign may sign using the key "Marginalia Local
   Signing" in your keychain. Type your login password and click **Always Allow** (otherwise every build asks).

You do not need to change the certificate's trust settings. Keep the certificate: a new one is a new app to macOS
again. To go back to ad hoc signing, delete `desktop/sign-identity`.

Not verified on this Mac yet (tests never make certificates or touch the keychain): signing with such a certificate,
the Always Allow prompt, the app starting without the hardened runtime, and the Documents permission surviving an
update.

## Run a build copy by hand

`marginalia` opens the installed app. A build copy in `out/` opened by hand would use your real library folder, vault
and backup folder, would need port 8765 (where the installed app runs its server), and macOS would start sending
`marginalia://` links to it. To look at one without any of that, give it throwaway folders and another port:

```bash
open -n out/Marginalia-darwin-arm64/Marginalia.app --args --port=8790 \
  --user-data-dir=/tmp/marginalia-try/data --obsidian-sandbox=/tmp/marginalia-try/vault --backup-dir=/tmp/marginalia-try/backups
# closing its window only hides it: quit it with Cmd+Q. Afterwards, forget that copy for marginalia:// links:
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u out/Marginalia-darwin-arm64/Marginalia.app
```

### Flags

| Flag | What it does |
|---|---|
| `--user-data-dir=<folder>` | where the library lives (default `~/Library/Application Support/Marginalia`) |
| `--port=<n>` | the server's port (default 8765, the address "Open in Marginalia" links in Obsidian use) |
| `--obsidian-sandbox=<folder>` | passed to serve.py: a throwaway vault `<folder>/Sandbox Vault` |
| `--obsidian-config=<obsidian.json>` | passed to serve.py: another vault list |
| `--backup-dir=<folder>` | passed to serve.py: where the daily backup goes |
| `--self-test` | the packaged self-test (below); needs `--user-data-dir`, `--port`, `--obsidian-sandbox`, `--backup-dir` |

Folders must be absolute paths, written `--flag=value`. Without flags the app uses Obsidian's own vault list and
`~/Documents/Marginalia Backups`, exactly like the `marginalia` command.

## What the app does

- **Server**: `python3 -I -B -c <guard> <app>/Contents/Resources/web/tools/serve.py --port 8765 --bind 127.0.0.1
  --dir <app>/Contents/Resources/web --app <version>` (plus the pass-through flags). python3 is the first of
  `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `/usr/bin/python3` that runs `serve.py --help` (Apple's
  `/usr/bin/python3` only when developer tools are installed, else it would pop up an installer). None: a dialog
  "Marginalia needs Python 3" with three ways to install it. The guard is a few lines of Python that run serve.py
  unchanged and stop it when the app's end of a pipe closes, so serve.py never outlives the app, even after a crash
  or a force quit. It reads that pipe with `os.read` (not `sys.stdin`), so a server that cannot start (a taken port,
  a refused option) ends with exit code 1 and its own message, not with a Python crash (SIGABRT) and a crash report.
  Quitting sends SIGTERM (serve.py finishes a note or backup write, at most 2 s), then SIGKILL after 5 s. Its output
  goes to `logs/server.log` in the data folder (512 KB, then `server.log.1`, `server.log.2`).
- **The app's server** (`--app <version>`, the version in `package.json`): it answers `GET /api/app`, so a browser
  tab on the same address shows "Marginalia is now an app" instead of the library. It takes a POST (a backup, a PDF,
  an Obsidian note) only with the header `X-Marginalia-Client: app`, which only the app's own page sends; a browser's one
  backup for the move sends `browser-move`, which only the backup routes take. Anything else gets the answer 409
  "app_only" and nothing is written. So while the app runs, a browser tab can never back up or send to Obsidian next to
  the app's library. The guard is the server's: after Cmd+Q a browser tab that never showed the cover (open since before
  the app ran, not reloaded) can send to Obsidian through `obsidian://` links again (Known limits).
- **Port in use**: the app never stops a program it did not start. A Marginalia server already on the port (the one
  the `marginalia` command started): a dialog says so and how to stop it (`marginalia stop`), with Try again and Quit.
  Anything else: a dialog naming the port, with Try again and Quit.
- **Server stopped** while the app runs: a dialog "Marginalia's server stopped" with Restart and Quit. The page stays
  as it is; it is reloaded only if it had not loaded, and only once the server answers again.
- **Window**: one window on http://127.0.0.1:8765/, title "Marginalia", at least 480 × 400; its size, position and
  full-screen state are kept in `window-state.json` and checked against the screens at every start (never off
  screen). It follows the system's light or dark theme, with the app's own background colour so dark mode starts
  without a white flash.
- **Closing the window hides it** (its red button, Window › Close Window Shift+Cmd+W, and Cmd+W with one tab left).
  That is the last window; with more than one window open, a window closes for good (see **Windows** below).
  The app and its server keep running, as Mac apps do, so "Open in Marginalia" links from Obsidian keep working. A
  window in full screen leaves full screen first. The Dock icon, Window › Marginalia, a second launch and a
  `marginalia://` link show it again (or open a new window if there is none). Cmd+Q, the app menu's Quit, logging out
  and restarting the Mac quit the app and stop its server. One switch decides this: `CLOSE_HIDES` in
  `lib/lifecycle.js` (`false`: closing the window quits the app).
- **Links**: the window only ever shows http://127.0.0.1:8765/. Other web pages (`window.open`, `target=_blank`, a
  link) open in your default browser; `obsidian:` and `mailto:` links go to macOS (link mode opens notes that way);
  any other kind of link is refused. Something opens outside the app only within 5 seconds of your own click or key
  press in the window, and one thing per click or key press (as in a browser, which also blocks tabs and app links that no
  click asked for), so script in the page alone can open nothing. Refusals go to the log.
- **marginalia:// links**: `marginalia://open?hash=#reader/<book>/<prompt>` makes the window go to that place. Only
  the web app's own routes pass (`#library`, `#deck/<id>`, `#reader/<id>`, `#reader/<id>/<prompt id>`, `#stats`), read as
  `js/app.js` reads a hash (a trailing `/` and anything after the prompt id are ignored); ids are taken as the web
  app makes them, also a book added "as a separate book" (`<fingerprint>:<8 hex digits>`, the `:` encoded as `%3A`)
  and fingerprints of any length; only an empty id, `.`, `..`, or one with `/` or a control character is refused.
  Anything else opens the library. The hash is written again with each id percent-encoded. A second launch from
  Terminal hands its link to the running app and quits; on an open page only the hash changes (no reload).
- **In the page**: `window.marginaliaDesktop` tells the page it runs in the app. The page then sends the client
  header with every POST, asks once for persistent storage, and shows the welcome card "Welcome to Marginalia"
  while its library is empty (see `../marginalia/README.md`, "Desktop app").
- **Downloads** (exports, backups saved by hand): a Save dialog that starts in Downloads. File pickers and dragging a
  PDF onto the window work as in a browser.
- **Tabs** (the web app's own, `../marginalia/js/tabs.js`; DECISIONS D30): the Window menu has New Tab (Cmd+T), Close
  Tab (Cmd+W) and Reopen Closed Tab (Shift+Cmd+T), and Show Next Tab and Show Previous Tab for a click. Each runs the
  web app's command in the page (`lib/menu.js` `tabScript`, `main.js` `tabCommand` and `runTab`; no ipc channel). The
  page leaves exactly the three menu keys to the menu, so a key runs once. Every other tab key is the page's own, as
  in a browser: Ctrl+Tab, Ctrl+Shift+Tab, Cmd+Shift+] and [, Cmd+1 to Cmd+9 (a key without Cmd may never reach a menu
  on macOS, so the menu does not own Ctrl+Tab). `lib/lifecycle.js` `tabAction` says what a command does in each state
  of the windows:
  - the main window in front: the page runs the command and answers "done", "last" (it has one tab), "blocked" (more
    tabs, but a review or a dialog is on screen) or "none" (it did not load). Close Tab with one tab left closes the
    window, which hides it; so does Close Tab on a page that did not load. On "blocked" the window stays;
  - the window hidden, minimized or behind another: New Tab and Reopen Closed Tab bring it to the front first (with no
    window at all they open one); Close Tab closes the window that is in front (the About panel, Developer Tools in a
    window of their own); Show Next Tab and Show Previous Tab do nothing.
  The tab commands ask the page each time; they need no server, so they work while the server is down.
- **Windows** (DECISIONS D31; rules in `../marginalia/docs/BUILD-NOTES.md` "Windows"): Window › New Window (Cmd+N)
  opens another window on the app's page with an id of its own (`http://127.0.0.1:8765/?w=<id>`), with the same
  locked-down page settings and preload. A tab that is dragged out of its window, and Window › Move Tab to New Window,
  ask for such a window from the page (`window.open("/?w=<id>")`): `lib/policy.js` (`windowOf`, `windowOpen`,
  `windowFeatures`) lets only that address through, and `main.js` makes the window itself (`openAppWindow`), where
  the tab was dropped. Electron never makes a window of its own. At most 8 windows. A window that the user asked for
  (Cmd+N, a tab that was dragged out) is on screen at once, in the page's background colour; its page follows. Window › Merge All Windows brings
  the tabs of every other window into the window in front (`lib/menu.js` `windowScript`: `dump`, `take`, `drop`; a
  tab that found no room there stays in its window).
  - One window writes to the library at a time, the one that is used; the pages hand that role to each other (the
    web app's `js/store.js`, a Web Lock). `main.js` takes no part in it, except at a close (below).
  - A window that is not the last one closes for good (`lib/lifecycle.js` `closeAction` → "close-window"): its page
    forgets its list of tabs and stores a reading place it held back (`windowScript("leave")`, at most 1.5 s), the
    window is destroyed, and the window in front takes the writer role (`windowScript("role")`). The last window
    hides. A quit asks no page anything, so the tabs of every window come back at the next start, in one window.
  - A window never changes its id: a navigation to another window's address is turned back, and a `marginalia://`
    link goes to the window in front and keeps that window's id.
  - With two or more windows macOS lists them in the Window menu by their names ("Griffiths — Marginalia"); with one,
    Window › Marginalia shows it.
- **Menus**: Marginalia (About, Hide, Hide Others, Show All, Quit), Edit (Undo, Redo, Cut, Copy, Paste, Paste and
  Match Style, Select All), View (Reload, Force Reload, Toggle Developer Tools, Actual Size, Zoom In, Zoom Out, Toggle
  Full Screen), Window (New Window on Cmd+N, Minimize, Zoom, the five tab commands, Move Tab to New Window, Merge All
  Windows, Close Window on Shift+Cmd+W, Bring All to Front, and Marginalia, which shows the window again). The tab
  commands apart, no menu shortcut takes a key the web app uses (Cmd+N is no key of the web app):
  Actual Size, Zoom In and Zoom Out have no shortcut (Cmd+0, Cmd+= and Cmd+- zoom the PDF), and there is no File menu
  (Cmd+O adds a PDF, Cmd+F finds). Cmd+V stays on Paste: that is what delivers the paste the web app reacts to (an
  image, or a free margin note). So in the app Cmd+0 only fits the PDF: where a browser resets its own page zoom at a
  second Cmd+0, the app does that with View › Actual Size.
- **Right-click** (`lib/contextmenu.js`): on a misspelled word (the card editor checks spelling) up to five
  suggestions and Add to Dictionary; in a text field Cut, Copy, Paste, Paste and Match Style and Select All; on
  selected text Copy and Look Up; on a picture or a canvas Copy Image. Nothing else: no Back, Reload, Save, Print or
  Inspect, and no menu where none of these applies.

## Where things live

| What | Where |
|---|---|
| the installed app | `/Applications/Marginalia.app` (`MARGINALIA_APP` names another place) |
| the version before the last `marginalia app` | `desktop/out/previous/Marginalia.app` |
| the library (IndexedDB), settings and the API key (localStorage) | `~/Library/Application Support/Marginalia` |
| the server's log | `~/Library/Application Support/Marginalia/logs/server.log` |
| the window's size and place | `~/Library/Application Support/Marginalia/window-state.json` |
| daily JSON backups and the PDFs | `~/Documents/Marginalia Backups` (serve.py's default; Time Machine copies it) |
| notes to Obsidian | the vault you choose in Settings › Obsidian, from Obsidian's own vault list |
| the signing certificate's name (optional) | `desktop/sign-identity` (not in git) |
| the fingerprints of the vendored files | `desktop/vendor-lock.json` (in git) |

Nothing goes into the keychain: the app runs with Chromium's mock keychain (`--use-mock-keychain`), so a rebuilt app
never asks for keychain access.

## Security

- The page runs with `contextIsolation`, the renderer `sandbox`, no Node (`nodeIntegration: false`, also in workers
  and frames), `webSecurity` on, no `<webview>`, no remote module (Electron removed it). `app.enableSandbox()` applies
  the sandbox to every page.
- `preload.js` gives the page exactly `window.marginaliaDesktop = {app: true, version, platform}`, frozen and
  read-only, and nothing else (no channel to the main process).
- Permissions: clipboard read and write, and persistent storage (so Chromium never clears the library when the disk
  is nearly full), for the app's own origin only; every other request (camera, microphone, location, notifications,
  MIDI, HID, serial, USB, Bluetooth, …) is refused. Persistent storage is one switch: `"persistent-storage"` in
  `ALLOWED_PERMISSIONS` (`lib/policy.js`). The self-test follows it (it expects the grant only while the switch is on),
  so taking it out changes only that line and its unit tests.
- The app's server takes writes only from the app's own page (`--app`, above).
- Electron fuses: off: RunAsNode, NODE_OPTIONS, `--inspect` and friends, extra privileges for `file://`, cookie
  encryption; on: asar integrity validation and loading the app only from `app.asar` (a changed `app.asar` stops the
  app from starting).
- Signing: ad hoc by default, with no hardened runtime; a Developer ID gets the hardened runtime, and the app itself
  then gets only the JIT entitlement V8 needs (`entitlements.plist`); a certificate of your own signs without it (see
  Signing).
- The app never calls `app.setAsDefaultProtocolClient`; the `marginalia://` scheme comes from the app's Info.plist.
- Opening anything outside the app needs the user's own click or key press (Links, above).
- The app cancels PDF.js's requests for its CJK character maps on cdnjs (cdnjs refuses every one of them anyway: see
  Known limits), so showing a PDF never contacts a host other than 127.0.0.1. The Claude features still call the
  Anthropic API.
- `vendor-lock.json` makes the build stop when a CDN file changes, also after `.cache/` is deleted or on another Mac.

## Tests

```bash
node --test                        # the shell's own tests (no Electron needed; a real python3 for the server tests)
node scripts/selftest.js [app]     # the packaged app's self-test (npm run app runs it too)
```

`node --test` (186 tests) covers flags and the self-test guard (also against this disk: firmlink names, letter case,
Unicode forms, symlinks, a changed HOME), the link, permission, click-before-opening and request rules,
`marginalia://` hashes (against `js/app.js`'s own `parseHash`), the python3 search, window placement, the rotating log,
the menu (against `../marginalia/js/keys.js`), the right-click menu, the server (a real `serve.py` with a throwaway
vault: start, stop, the guard that ends it when its app is killed, a taken port ending with exit code 1, and a server
started with `--app` refusing a POST without the header), the CDN rewrite, SRI and lock checks (with a stand-in
download), the self-test's verdict (also with the persistent-storage switch off) and its close probe (it must see the
window's `hide()` run, with stand-in windows and with `main.js`'s own close handler), the runner's LaunchServices and
defaults rules, the icon, the signing rules (`test/signing.test.js`), what closing the window does
(`test/lifecycle.test.js`) and the build's settings (the offline Electron check among them). `test/docs.test.js`
checks that `../CLAUDE.md`, BUILD-NOTES and the two READMEs keep the app's safety rules for agents and what they
promise the user (the review of 2026-11-11). `test/main.test.js` loads `main.js` itself in plain Node with Electron
replaced by a stand-in (the real Electron is never loaded): `marginalia://` links (valid, invalid, before the app is
ready, at the first launch), a second launch, closing the window (hidden, full screen left first, the switch off),
Cmd+Q and SIGTERM stopping the server, the server's `--app` flag, persistent storage, a new window when there was
none, the self-test's close probe against `main.js`'s own close handler, and the tab commands of the Window menu
(the page of the window in front runs them; Cmd+W with one tab left hides the window and does nothing while the page
says "blocked"; the window hidden, behind another window, minimized or gone; nothing while the app quits; after a
refused link, and while the server is down; the self-test's sequence through the real menu items), and several
windows (DECISIONS D31: Cmd+N; a window that is not the last one closes for good after its page forgot its tabs, also
when the page does not answer; a quit; a tab that moves out and the window made where it was dropped; never more than
8 windows or an id twice; a window keeps its id; Move Tab to New Window; Merge All Windows; links and tab commands go
to the window in front; the page-loaded flag per window). `test/policy.test.js` checks which address asks for a
window of the app, and `test/menu.test.js` the scripts that `main.js` runs in a window's page (`windowScript`).
`test/menu.test.js` also checks that the menu's three tab shortcuts are exactly the keys the web app leaves to the
menu (`js/tabs.js` `MENU_KEYS`), and that no other tab key has a menu shortcut.

The `marginalia` command has its own tests in `../marginalia/test/test_command.py` (a copy of the command in a temp
folder, stand-ins for `open`, `osascript`, `lsregister`, `npm` and `pgrep`, an app in that temp folder, free ports in
`MARGINALIA_PORT` and `MARGINALIA_APP_PORT`, a fake `HOME` and backup folder; `marginalia test` runs them).

**The self-test**: `Marginalia.app/Contents/MacOS/Marginalia --self-test --user-data-dir=<dir> --port=<free port>
--obsidian-sandbox=<dir> --backup-dir=<dir>` starts the server, loads the page in a hidden window (no Dock icon),
and checks:

- the page booted; the store is in IndexedDB mode; the backup is "on" with the given folder; Obsidian is in server
  mode with only the sandbox vault; `window.marginaliaDesktop` is exactly as above and the page has no Node; PDF.js
  3.11.174 and KaTeX 0.16.47 load, and every font of the page loads (all 20 KaTeX fonts and Outfit);
- the app's server answers `GET /api/app` with its version; the page is in app mode (no cover); persistent storage is
  granted (only while the switch in `lib/policy.js` allows it; with it off, the self-test expects it denied); a POST
  without the app's header, to the backup and to Obsidian, gets 409 "app_only" and writes nothing;
- the empty library shows the welcome card with "No backup yet". The self-test then puts a prepared backup (one book,
  `test/sample.pdf`, in one folder, with two prompts) and the book's PDF into its throwaway backup folder, as a browser's
  "Back up this browser's library" would. The card then reads "Import the newest backup (today, HH:MM)". A click
  imports it: the import's notice, "Restored 1 PDF from your backup folder" and the API key reminder appear in that
  order, the card goes, and the library holds exactly that book, folder and two prompts. The book's PDF came back
  from the backup folder (the same SHA-256), and it opens in the reader with PDF.js's real worker;
- Back up now (with the app's header) writes today's backup of the imported library; a request for a CJK character
  map on cdnjs is cancelled by the app; a download is saved, and the Save dialog options it got (the same call as for
  you) start in Downloads;
- `window.open`, a `target=_blank` link and a navigation to `https://example.invalid/…` with no input before them are
  refused, then after one key press one `window.open` reaches the recorder that stands in for "open in browser"
  (nothing ever opens) and a second is refused, and a `file:` link is refused; every request went to
  `http://127.0.0.1:<port>/` (or was cancelled by the app); no window was ever shown; the mock keychain is on;
- notifications are asked for and denied; permission queries show the clipboard and persistent storage granted and
  notifications, location and camera denied, and nothing else was granted; the menu has exactly the shortcuts above;
  right-clicks on a canvas and on a text field get Copy Image and the editing items (recorded, never shown);
- **The browser's stand-in**: a second hidden window on the same address without the preload, with storage of its own,
  shows the cover "Marginalia is now an app" in real Chromium: its "Open the app" link is
  `marginalia://open?hash=%23library` (read, never followed), a send to Obsidian is refused, no backup starts, and of
  the server's API it asks only `GET /api/app` (no POST, no other host);
- the window's close button hides the window: the close is prevented and the window's `hide()` runs (the self-test
  watches that call, since it never shows the window and so cannot judge by visibility), and the page and the server
  live on;
- **the tab commands** of the Window menu reach the page, and each does exactly its job: New Tab adds a library tab
  after the tab on screen and the strip shows; Show Next Tab and Show Previous Tab go one tab on and one tab back;
  Close Tab closes the tab on screen, down to one tab, and then the page answers "last" (the app then closes the
  window); Reopen Closed Tab brings back the tab that was closed last; a name that is no tab command of the menu
  never reaches the page;
- **two windows** hand the writer role to each other (DECISIONS D31): a second window (never shown, and slowed down
  as a window in the background is) takes the role as it starts, and the first becomes a reader, where a save is
  refused; a note saved in the second is in the first one's copy only after the first took the role back and read
  the library again; a reader stores its own list of tabs; the second window closes for good, and its list of tabs
  is forgotten. Then a tab moves out of the first window as a dragged tab does (the page's own
  `M.tabs.moveToWindow()` → `window.open` → `lib/policy.js` → `main.js`): a third window with an id of its own holds
  that tab, and closes for good too;
- when the runner's second launch handed over its link, `marginalia://open?hash=%23library` took the open reader to
  the library on the same page (no reload).

It prints one JSON line and exits 0 (all passed), 1 (a check failed) or 2 (it refused to run).

It refuses (exit 2) unless all four flags are given; when a folder is, holds or lies inside `~/Documents` (the real
vault and the real backup folder), `~/Library/Application Support/Marginalia` or Obsidian's settings folder, under any
of its names (symlinks, other letter case, Unicode forms, `/System/Volumes/Data/…`: folders are compared by what the
disk says, device and inode, not only by how the path is written), or runs through a symlink that leads nowhere; when
`HOME` is not this account's home folder (the guard takes the home folder from the user database); when
`--obsidian-config` is given; for port 8765; or for any marginalia:// link but `marginalia://open?hash=%23library`.
Note: Chromium itself creates the `--user-data-dir` folder before the app's code can refuse, so never pass a real
folder there.

`scripts/selftest.js` refuses an installed app (in `/Applications` or `~/Applications`, under any of its names) and a
changed `HOME`, makes the throwaway folders in `$TMPDIR` and a free port, runs the self-test, starts a second app on
the same data folder while the first runs with that one link (it must step aside, the first must log that it got 1
link, and the link-handoff check must pass), then unregisters that build copy and its helper apps from LaunchServices
(`lsregister -u`; macOS registers a helper on its own when it writes a crash report for it, so `marginalia://` never
points at a build folder) and checks `lsregister -dump` no longer names the copy at all, that the server's port is
closed, that no "Marginalia Safe Storage" keychain item exists (checked by exit code only) and that
`~/Library/Application Support/Marginalia` was not created. Chromium writes three settings to
`~/Library/Preferences/local.marginalia.desktop.plist` at every start; when that file holds nothing but those three
after the run, the runner deletes it, whoever wrote it, so runs that overlap leave nothing behind either (a file with
any other setting, such as the installed app's own, is left alone). It removes its temp folder also when something
failed, and prints every check with its detail.

## Versions

| | |
|---|---|
| electron | 45.3.0 (Chromium 156.0.8078.96, Node 24.22.2), the newest stable release on 2026-11-11 |
| @electron/packager | 20.3.0 (brings @electron/osx-sign 2.7.2, @electron/get 5.1.0, @electron/asar 4.3.1) |
| @electron/fuses | 2.1.3 |
| PDF.js / KaTeX / Outfit | 3.11.174 / 0.16.47 / Google Fonts v15 (from the web app's `index.html`; pinned in `vendor-lock.json`) |
| the app | 1.7.0 (`package.json`'s `version`; the server gets it as `--app 1.7.0`) |
| built and tested with | macOS 26.6.2 (arm64), Node 23.7.0, npm 10.9.2, Python 3.14.7 (`/opt/homebrew/bin/python3`) |

All three packages are exact pins in `devDependencies`; the app itself has no npm dependency (only Electron's and
Node's own modules). `npm audit`: 5 moderate findings, all in build-time tools (glob 13.0.7 and minimatch 10.2.6
under @electron/asar 4.3.1, used by @electron/packager 20.3.0 and @electron/universal 3.0.6); none of it ships in the
app, and the only fix npm offers is a downgrade to @electron/packager 18.4.4, so it is left as is.

## Known limits

- **Undo and Redo in the Edit menu act on text only.** Cmd+Z and Shift+Cmd+Z undo and redo the last change to a
  card when no text field has the focus (DECISIONS D33, BUILD-NOTES "Undo and redo"): the page takes the two keys
  itself, as in a browser. The menu items keep Electron's own roles, so a click on Edit › Undo with the pointer
  changes no card. Not yet checked on a real Mac: that the two keys reach the page of the installed app.

- **CJK character maps**: a PDF whose Chinese, Japanese or Korean text uses a font that is not embedded and one of
  PDF.js's predefined character maps (cMaps) shows none of that text, online or offline, in the app and in a browser
  alike. `js/pdfview.js` loads the cMaps from cdnjs (`CMAP_URL`), and cdnjs refuses every `.bcmap` file (HTTP 403,
  "invalid file type", no CORS header), so they never loaded in the web app either. The app cancels those requests, so
  such a PDF shows its other text at once and the app contacts no other host; the browser page still asks cdnjs and
  may wait on the network. Making that text work means shipping the cMaps (for example from the `pdfjs-dist` 3.11.174
  package) and pointing the app's `CMAP_URL` at them: a change beyond `index.html`, left for a decision.
- **After Cmd+Q** nothing answers on port 8765, so an "Open in Marginalia" link from Obsidian finds no server until
  the app runs again. Closing the window instead keeps the app running.
- **A browser tab that was already open** shows the cover only after a reload. Until then, while the app runs, its
  backups and sends are refused (409), and its notices say so in its own words. Once the app quits, nothing answers on
  port 8765, so such a tab (with the code from before part 2, or with the new code but checked before the app ran)
  falls back to `obsidian://` links for a send it starts, and that can add a second block for a card the app's library
  already sent (the never-twice rule holds only while one library sends). The README tells the user to reload or close
  the browser's tabs once the app is installed; a tab that shows the cover keeps refusing after the quit. The browser may also
  block the cover's automatic hand-over of a reader link to the app; "Open the app" is the fallback.
- At start, macOS registers the app as a regular app for a few dozen milliseconds before the self-test hides its
  Dock icon, so a Dock icon can flicker for an instant during a self-test; no window is ever shown.
- A self-test run that crosses midnight fails (the prepared backup's day and "today" disagree); run it again.
- `marginalia app` moves the installed copy to `out/previous` with a rename only when `/Applications` and `desktop/out`
  are on one disk, as on this Mac. Across disks `mv` copies, and a failure partway through that copy is not fully
  undone.
- Not verified here (tests never show a window, install the app, open `marginalia://` links or touch the keychain):
  the visible window (closing hides it, full screen, the Dock icon, Window › Marginalia, Cmd+Q, logging out or
  restarting while it is hidden, dialogs, menus by hand, the right-click menu used by hand, Look Up, Add to
  Dictionary, Copy Image, window placement, dark mode, the Save dialog itself, drag and drop, also of a tab between
  windows and out of a window, Cmd+N as macOS gives it to the menu); `marginalia app` end to
  end into `/Applications` (`open -a`, `lsregister -f/-u`, the AppleScript quit and any Automation prompt it brings);
  `marginalia://` links delivered by macOS, also to an app whose window is hidden, and a browser handing one over; signing
  with a certificate (yours or a Developer ID); and the Documents-folder prompt.
