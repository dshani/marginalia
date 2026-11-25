"use strict";
// Packs Marginalia for Zotero (zotero/, DECISIONS D34) into out/Marginalia-for-Zotero.xpi: `npm run zotero`.
//
//   - the plugin's files (FILES, in this order) go into a zip without compression ("stored"), with a fixed date, so
//     the same files always give the same .xpi; Node's own zlib.crc32 makes each file's checksum (Node 22.2 or later);
//   - a file of zotero/ that FILES does not name stops it, as does a manifest.json without the plugin's id or
//     without a field Zotero requires (REQUIRED: Zotero refuses the plugin as "incompatible" without them);
//   - it installs nothing: the user adds the file in Zotero (Tools › Plugins › Install Plugin From File…).
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "zotero");
const OUT = path.join(ROOT, "out");
const XPI = path.join(OUT, "Marginalia-for-Zotero.xpi");
const FILES = ["manifest.json", "bootstrap.js", "marginalia.js", "locale/en-US/marginalia-zotero.ftl"];
const PLUGIN_ID = "{70c6655c-714e-4bab-acfa-223d00179c0b}";
// Zotero's own rule (its Extension.sys.mjs, on top of Firefox's): every plugin names these in applications.zotero.
// There is no update server: update_url is an address under .invalid (RFC 2606), which never resolves, so Zotero's
// update checks find nothing and a new version is installed by hand.
const REQUIRED = ["id", "update_url", "strict_max_version"];
const DOS_TIME = 0;                              // 00:00:00
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01

function say(text) { process.stdout.write("[zotero] " + text + "\n"); }

// Every file below zotero/, as zip names ("a/b.txt"), sorted.
function listed(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const rel = base ? base + "/" + e.name : e.name;
    if (e.isDirectory()) out.push(...listed(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

// zip([{name, data: Buffer}]) → Buffer: one local header and file per entry, then the central directory.
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                  // version needed: 2.0
    local.writeUInt16LE(0x0800, 6);              // the name is UTF-8
    local.writeUInt16LE(0, 8);                   // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    local.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);               // extra, comment, disk, attributes: 0
    parts.push(local, n, data);
    central.push(dir, n);
    offset += local.length + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat(central, [end]));
}

// The plugin's files as zip entries; throws when zotero/ holds another file or the manifest is not the plugin's.
function entries(src) {
  const found = listed(src, "");
  const extra = found.filter((f) => !FILES.includes(f)), absent = FILES.filter((f) => !found.includes(f));
  if (extra.length) throw new Error("zotero/ holds files the plugin does not name: " + extra.join(", "));
  if (absent.length) throw new Error("zotero/ lacks " + absent.join(", "));
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
  const z = manifest.applications && manifest.applications.zotero;
  if (!z || z.id !== PLUGIN_ID) throw new Error("manifest.json does not carry the plugin's id " + PLUGIN_ID);
  const absentFields = REQUIRED.filter((k) => typeof z[k] !== "string" || !z[k]);
  if (absentFields.length) throw new Error("manifest.json lacks what Zotero requires: applications.zotero." + absentFields.join(", applications.zotero."));
  return FILES.map((name) => ({ name, data: fs.readFileSync(path.join(src, ...name.split("/"))) }));
}

function main() {
  const list = entries(SRC);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(XPI, zip(list));
  const version = JSON.parse(list[0].data.toString("utf8")).version;
  say("wrote " + path.relative(ROOT, XPI) + " (Marginalia for Zotero " + version + ", " + list.length + " files, " + fs.statSync(XPI).size + " bytes)");
  say("add it in Zotero: Tools › Plugins, the gear menu, Install Plugin From File…");
}

if (require.main === module) {
  try { main(); } catch (e) {
    process.stderr.write("[zotero] error: " + (e && e.message ? e.message : String(e)) + "\n");
    process.exitCode = 1;
  }
}

module.exports = { zip, entries, listed, FILES, PLUGIN_ID, REQUIRED, XPI };
