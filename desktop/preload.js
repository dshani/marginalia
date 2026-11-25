"use strict";
// The only thing the page gets from the app: window.marginaliaDesktop = {app: true, version, platform, onOpenPdf},
// exposed through contextBridge (which deep-freezes it and makes the property read-only). No Node, no Electron API.
// The version comes from the main process as an argument of this renderer (webPreferences.additionalArguments), since
// a sandboxed preload cannot read the app's package.json.
//
// One ipc channel, from the main process to the page only (DECISIONS D34): "marginalia:open-pdf" carries {name, bytes}
// of a PDF that macOS handed the app (lib/openfile.js). The page takes it with onOpenPdf(fn): fn(name, bytes) for each
// PDF, the first fn only (later calls get false). PDFs that come before the page asks wait here, at most MAX_WAITING.
// The page cannot send anything through it.
const { contextBridge, ipcRenderer } = require("electron");

const PREFIX = "--marginalia-desktop-version=";
const CHANNEL = "marginalia:open-pdf";          // lib/openfile.js CHANNEL (a sandboxed preload cannot require it)
const MAX_WAITING = 8;                           // lib/openfile.js MAX_WAITING
const MAX_NAME = 255;
const arg = (process.argv || []).find((a) => typeof a === "string" && a.startsWith(PREFIX));
const raw = arg ? arg.slice(PREFIX.length) : "";
const version = /^[0-9A-Za-z.+-]{1,32}$/.test(raw) ? raw : "";

let handler = null;
const waiting = [];

function deliver(m) {
  try { handler(m.name, m.bytes); } catch (e) { /* the page's own error */ }
}

ipcRenderer.on(CHANNEL, (event, msg) => {
  if (!msg || typeof msg.name !== "string" || !(msg.bytes instanceof Uint8Array)) return;
  const m = { name: msg.name.slice(0, MAX_NAME), bytes: msg.bytes };
  if (handler) deliver(m);
  else if (waiting.length < MAX_WAITING) waiting.push(m);
});

function onOpenPdf(fn) {
  if (typeof fn !== "function" || handler) return false;
  handler = fn;
  while (waiting.length) deliver(waiting.shift());
  return true;
}

contextBridge.exposeInMainWorld("marginaliaDesktop", Object.freeze({ app: true, version, platform: process.platform, onOpenPdf }));
