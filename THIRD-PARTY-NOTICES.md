# Third-party notices

Marginalia's own code is under the MIT licence (see `LICENSE`). The parts below come from other projects and keep their own licences.

## In this repository

| Part | From | Licence |
|---|---|---|
| the scheduling rules in `marginalia/js/scheduler.js` | a port of the scheduler of [Orbit](https://github.com/andymatuschak/orbit) by Andy Matuschak. The header of the file says what Marginalia changed. | Apache License 2.0; a copy is in `LICENSES/Apache-2.0.txt` |

## Not in this repository

These files are downloaded: by the browser when the page loads, and by the build of the Mac app, which puts them into the app (`desktop/vendor-lock.json` lists each file with its fingerprint).

| Part | Version | Licence |
|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js) (Mozilla) | 3.11.174 | Apache License 2.0 |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.47 | MIT; its fonts: SIL Open Font License 1.1 |
| [Outfit](https://fonts.google.com/specimen/Outfit) (the font of the headings) | from Google Fonts | SIL Open Font License 1.1 |
| [Electron](https://github.com/electron/electron) (the Mac app only) | 45.3.0 | MIT; it contains Chromium and Node.js, which have their own licences |

The build tools `@electron/packager` and `@electron/fuses` (both MIT) are used to make the Mac app. They are not part of it.
