"use strict";
// The only thing the page gets from the app: window.marginaliaDesktop = {app: true, version, platform}, exposed
// through contextBridge (which deep-freezes it and makes the property read-only). No ipc channel in part 1, no
// Node, no Electron API. The version comes from the main process as an argument of this renderer
// (webPreferences.additionalArguments), since a sandboxed preload cannot read the app's package.json.
const { contextBridge } = require("electron");

const PREFIX = "--marginalia-desktop-version=";
const arg = (process.argv || []).find((a) => typeof a === "string" && a.startsWith(PREFIX));
const raw = arg ? arg.slice(PREFIX.length) : "";
const version = /^[0-9A-Za-z.+-]{1,32}$/.test(raw) ? raw : "";

contextBridge.exposeInMainWorld("marginaliaDesktop", Object.freeze({ app: true, version, platform: process.platform }));
