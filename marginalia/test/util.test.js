"use strict";
// Tests for js/util.js (SPEC §17.2 M.util). Run: node --test test/util.test.js
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const util = require("../js/util.js");

const MIN = 60000, HOUR = 3600000, DAY = 86400000;

describe("hash32", () => {
  test("is a stable 32-bit FNV-1a (known vectors)", () => {
    assert.equal(util.hash32(""), 2166136261);        // 0x811c9dc5, the offset basis
    assert.equal(util.hash32("a"), 3826002220);       // 0xe40c292c
    assert.equal(util.hash32("foobar"), 3214735720);  // 0xbf9cf968
  });
  test("returns an unsigned integer and is deterministic", () => {
    const s = "1762150000000p_3f9a0c1e0";
    const h = util.hash32(s);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
    assert.equal(util.hash32(s), h);
    assert.notEqual(util.hash32(s + "1"), h);
    assert.equal(util.hash32(12), util.hash32("12")); // non-strings are stringified
  });
});

describe("fnv1a", () => {
  test("returns 16 lowercase hex chars whose first half is the standard FNV-1a 32", () => {
    const h = util.fnv1a(new TextEncoder().encode("a"));
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(h.slice(0, 8), "e40c292c");
    assert.equal(util.fnv1a(new Uint8Array(0)).slice(0, 8), "811c9dc5");
  });
  test("is deterministic, input-sensitive and accepts ArrayBuffers", () => {
    const a = new TextEncoder().encode("hello world");
    assert.equal(util.fnv1a(a), util.fnv1a(a.buffer.slice(0)));
    assert.notEqual(util.fnv1a(a), util.fnv1a(new TextEncoder().encode("hello worle")));
  });
});

describe("sha256", () => {
  test("hashes 'abc' to the known digest (lowercase hex)", async () => {
    const hex = await util.sha256(new TextEncoder().encode("abc"));
    assert.equal(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("accepts an ArrayBuffer and a subarray view", async () => {
    const bytes = new TextEncoder().encode("xxabcxx");
    const view = bytes.subarray(2, 5);
    assert.equal(await util.sha256(view), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(await util.sha256(new TextEncoder().encode("abc").buffer), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("rejects with code no_subtle when crypto.subtle is missing", async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true, writable: true });
    try {
      await assert.rejects(util.sha256(new Uint8Array([1, 2, 3])), (e) => e.code === "no_subtle");
    } finally {
      Object.defineProperty(globalThis, "crypto", desc);
    }
  });
});

describe("uuid", () => {
  test("prefixes a v4 UUID and never repeats", () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const id = util.uuid("p_");
      assert.match(id, /^p_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(id);
    }
    assert.equal(seen.size, 1000);
    assert.match(util.uuid(), /^[0-9a-f-]{36}$/);
    assert.match(util.uuid("deck_"), /^deck_[0-9a-f-]{36}$/);
  });
  test("falls back to getRandomValues when randomUUID is missing", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: (a) => real.getRandomValues(a) }, configurable: true, writable: true
    });
    try {
      const a = util.uuid("a_"), b = util.uuid("a_");
      assert.match(a, /^a_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.notEqual(a, b);
    } finally {
      Object.defineProperty(globalThis, "crypto", desc);
    }
  });
});

describe("mulberry32", () => {
  test("is deterministic per seed and yields floats in [0, 1)", () => {
    const a = util.mulberry32(42), b = util.mulberry32(42), c = util.mulberry32(43);
    const sa = [a(), a(), a(), a()], sb = [b(), b(), b(), b()], sc = [c(), c(), c(), c()];
    assert.deepEqual(sa, sb);
    assert.notDeepEqual(sa, sc);
    sa.forEach((x) => assert.ok(x >= 0 && x < 1));
    const big = util.mulberry32(1762150000000);
    assert.ok(big() >= 0 && big() < 1);
    assert.equal(util.mulberry32("seed")(), util.mulberry32("seed")());
  });
});

describe("debounce", () => {
  test("fires once with the last arguments after the delay; cancel and flush work", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const ctx = { name: "ctx" };
    const fn = util.debounce(function (x) { calls.push([this, x]); }, 100);
    fn.call(ctx, 1); fn.call(ctx, 2);
    t.mock.timers.tick(99);
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], ctx);
    assert.equal(calls[0][1], 2);
    fn(3); fn.cancel();
    t.mock.timers.tick(500);
    assert.equal(calls.length, 1);
    fn(4); fn.flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1], 4);
    fn.flush(); // nothing pending: no extra call
    assert.equal(calls.length, 2);
    t.mock.timers.reset();
  });
});

describe("clamp", () => {
  test("clamps into [lo, hi] and maps NaN to lo", () => {
    assert.equal(util.clamp(5, 0, 3), 3);
    assert.equal(util.clamp(-1, 0, 3), 0);
    assert.equal(util.clamp(2, 0, 3), 2);
    assert.equal(util.clamp(NaN, 0, 3), 0);
    assert.equal(util.clamp("2.5", 0, 3), 2.5);
  });
});

describe("escapeHtml", () => {
  test("escapes & < > \" and '", () => {
    assert.equal(util.escapeHtml("<a href=\"x\">&'</a>"), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
    assert.equal(util.escapeHtml("plain text"), "plain text");
    assert.equal(util.escapeHtml(null), "");
    assert.equal(util.escapeHtml(undefined), "");
    assert.equal(util.escapeHtml(42), "42");
  });
});

describe("localMidnight / dayKey", () => {
  test("localMidnight is 00:00:00.000 local of the same day", () => {
    const now = new Date(2026, 10, 3, 15, 4, 5, 678).getTime();
    assert.equal(util.localMidnight(now), new Date(2026, 10, 3).getTime());
    assert.equal(util.localMidnight(new Date(2026, 10, 3).getTime()), new Date(2026, 10, 3).getTime());
    assert.equal(util.localMidnight(new Date(2026, 10, 3, 23, 59, 59, 999).getTime()), new Date(2026, 10, 3).getTime());
  });
  test("dayKey is local YYYY-MM-DD, zero-padded, and flips at local midnight", () => {
    const midnight = new Date(2026, 10, 3).getTime();
    assert.equal(util.dayKey(midnight), "2026-11-03");
    assert.equal(util.dayKey(midnight - 1), "2026-11-02");
    assert.equal(util.dayKey(midnight + DAY - 1), "2026-11-03");
    assert.equal(util.dayKey(new Date(2026, 0, 5, 9).getTime()), "2026-01-05");
    assert.equal(util.dayKey(new Date(2027, 11, 31, 23, 30).getTime()), "2027-12-31");
  });
});

describe("fmtInterval", () => {
  test("picks the documented unit thresholds", () => {
    assert.equal(util.fmtInterval(10 * MIN), "10 min");
    assert.equal(util.fmtInterval(0), "0 min");
    assert.equal(util.fmtInterval(45 * 1000), "1 min");
    assert.equal(util.fmtInterval(59 * MIN), "59 min");
    assert.equal(util.fmtInterval(3 * HOUR), "3 h");
    assert.equal(util.fmtInterval(23.5 * HOUR), "1 d");
    assert.equal(util.fmtInterval(5 * DAY), "5 d");
    assert.equal(util.fmtInterval(11.5 * DAY), "12 d");
    assert.equal(util.fmtInterval(13 * DAY), "13 d");
    assert.equal(util.fmtInterval(14 * DAY), "2 wk");
    assert.equal(util.fmtInterval(23 * DAY), "3 wk");
    assert.equal(util.fmtInterval(26.45 * DAY), "1 mo");
    assert.equal(util.fmtInterval(60.835 * DAY), "2 mo");
    assert.equal(util.fmtInterval(139.9205 * DAY), "5 mo");
    assert.equal(util.fmtInterval(321.81715 * DAY), "1 yr");
    assert.equal(util.fmtInterval(365 * DAY), "1 yr");
    assert.equal(util.fmtInterval(730 * DAY), "2 yr");
    assert.equal(util.fmtInterval(-5), "0 min");
    assert.equal(util.fmtInterval(NaN), "0 min");
  });
});

describe("fmtBytes", () => {
  test("formats with 1024-based units and one decimal under 10", () => {
    assert.equal(util.fmtBytes(0), "0 B");
    assert.equal(util.fmtBytes(512), "512 B");
    assert.equal(util.fmtBytes(1024), "1 KB");
    assert.equal(util.fmtBytes(1536), "1.5 KB");
    assert.equal(util.fmtBytes(10200), "10 KB");
    assert.equal(util.fmtBytes(1.2 * 1024 * 1024), "1.2 MB");
    assert.equal(util.fmtBytes(61 * 1024 * 1024), "61 MB");
    assert.equal(util.fmtBytes(3.5 * 1024 * 1024 * 1024), "3.5 GB");
    assert.equal(util.fmtBytes(-3), "0 B");
  });
});

describe("nextDayLabel", () => {
  test("today / tomorrow / weekday within 6 days / '12 Nov' beyond", () => {
    const now = new Date(2026, 10, 3, 10, 0).getTime(); // Tuesday 3 Nov 2026
    assert.equal(util.nextDayLabel(now + 2 * HOUR, now), "today");
    assert.equal(util.nextDayLabel(now - 3 * DAY, now), "today");       // overdue reads as today
    assert.equal(util.nextDayLabel(new Date(2026, 10, 4, 0, 30).getTime(), now), "tomorrow");
    assert.equal(util.nextDayLabel(new Date(2026, 10, 5, 8).getTime(), now), "Thursday");
    assert.equal(util.nextDayLabel(new Date(2026, 10, 9, 8).getTime(), now), "Monday"); // +6 days
    assert.equal(util.nextDayLabel(new Date(2026, 10, 10, 8).getTime(), now), "10 Nov"); // +7 days
    assert.equal(util.nextDayLabel(new Date(2026, 10, 12, 8).getTime(), now), "12 Nov");
    assert.equal(util.nextDayLabel(new Date(2027, 1, 1, 8).getTime(), now), "1 Feb 2027"); // other year
    assert.equal(util.nextDayLabel(NaN, now), "");
  });
});

describe("error", () => {
  test("builds an Error carrying a code", () => {
    const e = util.error("quota", "Storage full");
    assert.ok(e instanceof Error);
    assert.equal(e.code, "quota");
    assert.equal(e.message, "Storage full");
  });
});

describe("kindIcon", () => {
  test("draws one constant line icon per prompt kind, the pencil for anything else", () => {
    for (const kind of ["note", "qa", "cloze", "highlight"]) {
      const svg = util.kindIcon(kind);
      assert.match(svg, new RegExp('^<svg class="kind-icon kind-icon--' + kind + '"'));
      assert.match(svg, /stroke="currentColor"/);
      assert.match(svg, /aria-hidden="true"/);
      assert.match(svg, /<\/svg>$/);
    }
    assert.notEqual(util.kindIcon("qa"), util.kindIcon("note"), "prompts and notes look different");
    assert.equal(util.kindIcon("<script>"), util.kindIcon("note"), "an unknown kind never reaches the markup");
    assert.equal(util.kindIcon(undefined), util.kindIcon("note"));
    assert.equal(util.kindIcon("toString"), util.kindIcon("note"), "no inherited property names");
  });
});
