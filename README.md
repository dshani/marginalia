# Marginalia

Marginalia is a PDF reader for studying. You read a book, select a passage, and write a question about it in the margin, next to the text. Marginalia asks you these questions again after some days, and then after longer and longer waits, so that you remember what you read. This method is called spaced repetition.

The idea comes from Andy Matuschak, who writes such prompts while he reads. His guide [How to write good prompts](https://andymatuschak.org/prompts/) explains what makes a prompt good. Marginalia puts the book, the prompts and the review in one place.

Marginalia runs on your own computer. It has no account, no server on the internet and no tracking.

## What you can do with it

- **Read a PDF and write prompts beside the text.** Select a passage and press N for a question and an answer, C for a sentence with a blank, or H for a highlight.
- **Review.** Marginalia asks the prompts of one book, or of all your books, when they are due. A prompt that you forget comes back the next day.
- **Get help with the wording.** Hints under the editor name common faults (a question that is too long, a yes/no question, a list as an answer), and a list of starter questions gives you other angles on a passage.
- **Keep order.** Decks for prompts without a PDF, folders, tabs, and in the Mac app several windows.
- **See how it goes.** A statistics page shows when each prompt was asked and when it comes back.
- **Take your data with you.** Export to Anki, Markdown or a JSON backup. Marginalia also saves a backup by itself every day.
- **Copy an equation as LaTeX** (optional; this needs your own Anthropic API key).
- **Copy notes into Obsidian** (optional; it is off until you turn it on).

The full guide is [marginalia/README.md](marginalia/README.md).

## What you need

| To use | You need |
|---|---|
| the Mac app | a Mac with an Apple chip (M1 or later), Python 3, and Node.js 22.12 or later to build the app |
| Marginalia in a browser | Python 3 and a browser such as Chrome or Brave |

macOS does not come with Python 3 or Node.js:

- **Python 3**: install it with [Homebrew](https://brew.sh) (`brew install python`) or with the installer from [python.org](https://www.python.org/downloads/). The Mac app looks for `python3` in three places only, in this order: `/opt/homebrew/bin` (Homebrew), `/usr/local/bin` (python.org) and `/usr/bin`. In `/usr/bin` is Apple's own Python 3.9, which comes with Apple's Command Line Tools; Marginalia is not tested with it. The app does not find a Python from pyenv, conda or asdf.
- **Node.js**: install it from [nodejs.org](https://nodejs.org) or with Homebrew (`brew install node`). It must be the Node.js for Apple chips (arm64): the build stops with a Node.js for Intel.

Marginalia is made and tested on macOS (macOS 26, Python 3.13 and 3.14, Node.js 23). See "Known limits" for what nobody has checked.

## Install the Mac app

You build the app on your own Mac. This takes a few minutes and needs the internet once.

1. Get the code. On the GitHub page, click **Code**, then **Download ZIP**, and unpack the file. With git: `git clone`, then the address of this repository.
2. Open Terminal and go to the project folder.
3. Install the build tools, once:

   ```bash
   cd desktop && npm ci && cd ..
   ```

4. Build the app, test it and install it as `/Applications/Marginalia.app`:

   ```bash
   ./bin/marginalia app
   ```

5. Open it:

   ```bash
   ./bin/marginalia
   ```

   Finder, Spotlight and the Dock open it too.

What happens:

- **The first build downloads its parts**: Electron (about 110 MB), PDF.js, KaTeX and one font. It checks each file against a list of fingerprints (`desktop/vendor-lock.json`). After that the app works without the internet. If a download fails, the build tries it three times and then stops with "could not download". Run the command again: it keeps the files that it has.
- **At the first start, macOS asks** whether Marginalia may access files in your Documents folder. Click **Allow**: the daily backups go to `~/Documents/Marginalia Backups`.
- **If the app says "Marginalia needs Python 3"**, install Python as the dialog tells you, then open the app again.
- **The app starts with "Welcome to Marginalia".** Click **Start with an empty library**, then **Add PDF**.

To update, get the new code, quit the app, and run `./bin/marginalia app` again. Your library stays.

To type `marginalia` in place of `./bin/marginalia`, link the command into a folder that is on your PATH, for example:

```bash
mkdir -p ~/.local/bin && ln -s "$PWD/bin/marginalia" ~/.local/bin/marginalia
```

## Use it in a browser, without the app

On a Mac, in the project folder:

```bash
./bin/marginalia
```

This starts a small server on your computer and opens http://127.0.0.1:8765/ in Chrome (or in Brave, or in your default browser). `./bin/marginalia stop` stops the server, and `./bin/marginalia help` lists the other commands. Once the Mac app is installed, the same command opens the app.

On another system, start the server yourself, then open http://127.0.0.1:8765/ in the browser:

```bash
cd marginalia && python3 -I tools/serve.py
```

Two things to know:

- **Use the same address every time.** A browser keeps a separate library for every address.
- **The library is in that browser's storage.** The browser's "Clear browsing data" (cookies and site data) deletes it. The daily backup in `~/Documents/Marginalia Backups` is then what you have left. The Mac app keeps its library in a folder of its own, so it does not have this risk.

## Where your data is

| What | Where |
|---|---|
| books, prompts and review history (Mac app) | `~/Library/Application Support/Marginalia` |
| books, prompts and review history (browser) | that browser's storage for http://127.0.0.1:8765 |
| the daily backup, and a copy of each PDF | `~/Documents/Marginalia Backups` |
| your Anthropic API key, if you enter one | the app's (or the browser's) local storage; no backup or export contains it |

Marginalia sends your data nowhere, with one exception that you start yourself: a snip in LaTeX mode sends that one picture to the Anthropic API, with your key.

In a browser, the page loads PDF.js and KaTeX from cdnjs and one font from Google Fonts. The Mac app has its own copies and asks no outside server for them.

## Obsidian (optional)

Marginalia can copy your notes and prompts into an [Obsidian](https://obsidian.md) vault, one Obsidian note per book. Turn it on in Settings › Obsidian › **Connect Marginalia to Obsidian**, then choose the vault. While it is off, Marginalia shows no Obsidian command. See "Obsidian" in the [guide](marginalia/README.md).

## For developers

```bash
./bin/marginalia test
```

This runs the unit tests of the web app and of the Mac app, the code checks, a headless start of the app and the server's tests. It needs Node.js and Python 3, and no other package.

| Folder | What is in it |
|---|---|
| `marginalia/` | the web app: plain HTML, CSS and JavaScript, no build step, no npm |
| `marginalia/tools/serve.py` | the local server (files, backups, Obsidian) |
| `marginalia/docs/` | the specification (`SPEC.md`), the binding rules (`BUILD-NOTES.md`) and the design decisions (`DECISIONS.md`) |
| `desktop/` | the Mac app: an Electron window around the web app ([desktop/README.md](desktop/README.md)) |
| `bin/marginalia` | the command |
| `CLAUDE.md` | the rules for AI coding assistants that work on this project |

Most of the code was written with Claude Code. The documents in `marginalia/docs/` record each decision and why it was made.

The code comments and the documents cite labels such as `FEATURES P1.3`, `repair A9-R3` or `REQ-B`. These are the numbers of the work orders and of the review findings from the time when each part was built. Those papers are not in the repository. The rule that came out of each one is in `marginalia/docs/BUILD-NOTES.md`.

## Known limits

- **The Mac app builds only on a Mac with an Apple chip.** On an Intel Mac, use Marginalia in a browser.
- **Not checked**: Windows and Linux (the browser version is plain Python and JavaScript, but nobody has tried it there), Safari, Firefox, and Python older than 3.13 (this includes Apple's own Python 3.9 in `/usr/bin`).
- **Obsidian's Live Preview shows two comment lines around each note** that Marginalia writes (`<!-- marginalia:… -->`). The reading view hides them. Marginalia needs these lines to update a note in place.
- **Apple did not sign the app.** You build it yourself, so macOS starts it without a warning. There is no ready-made download.
- **Chinese, Japanese and Korean PDFs**: some show no text in those languages.
- More limits are in [desktop/README.md](desktop/README.md), "Known limits".

## Licence

Marginalia is under the [MIT licence](LICENSE). Copyright (c) 2026 dshani.

The scheduler is a port of the scheduler of [Orbit](https://github.com/andymatuschak/orbit) by Andy Matuschak (Apache License 2.0). The other code that Marginalia uses is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
