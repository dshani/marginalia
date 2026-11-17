"use strict";
// Marginalia — test/layout.test.js (SPEC §12 layout bullets). Run: node --test test/layout.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const layout = require(path.join(__dirname, "..", "js", "layout.js"));
const { compute } = layout;

const O = { gap: 8, maxDrift: 320, collapsedH: 24 };
const EPS = 1e-9;

// Seeded PRNG (same algorithm as M.util.mulberry32; inlined so this test depends on layout.js only).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCards(seed, n, span, shuffle) {
  const rnd = mulberry32(seed);
  const cards = [];
  for (let i = 0; i < n; i++) {
    cards.push({ id: "c" + i, anchorY: Math.floor(rnd() * span), height: 20 + Math.floor(rnd() * 281), collapsed: rnd() < 0.1 });
  }
  if (shuffle) {
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
  }
  return cards;
}

function sortedIds(cards) {
  return cards.map((c, i) => ({ c, i })).sort((a, b) => (a.c.anchorY - b.c.anchorY) || (a.i - b.i)).map((e) => e.c.id);
}

// The §6 invariants: output order, no overlaps (with the gap), no card above its anchor unless it
// is in the contiguous packed chain above the active card, drift bounded unless collapsed.
function checkInvariants(cards, out, o, label) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const h = (r) => (r.collapsed ? o.collapsedH : byId.get(r.id).height);
  assert.deepEqual(out.map((r) => r.id), sortedIds(cards), label + ": output in anchor order");
  for (const r of out) assert.deepEqual(Object.keys(r).sort(), ["collapsed", "id", "top"], label + ": result shape");
  for (let i = 1; i < out.length; i++) {
    const bottom = out[i - 1].top + h(out[i - 1]) + o.gap;
    assert.ok(out[i].top >= bottom - EPS, `${label}: ${out[i - 1].id} and ${out[i].id} overlap (${out[i].top} < ${bottom})`);
  }
  const k = out.findIndex((r) => r.id === o.activeId);
  for (let i = 0; i < out.length; i++) {
    const r = out[i], c = byId.get(r.id);
    assert.ok(r.top >= -EPS, `${label}: ${r.id} above the top of the margin`);
    if (c.collapsed) assert.equal(r.collapsed, true, `${label}: input collapsed flag kept for ${r.id}`);
    if (!r.collapsed && i !== k) assert.ok(r.top - c.anchorY <= o.maxDrift + EPS, `${label}: ${r.id} drifts ${r.top - c.anchorY} without collapsing`);
    if (r.top >= c.anchorY - EPS) continue;
    // above its anchor: only allowed inside the pinned chain, packed tightly up to the active card
    assert.ok(k >= 0 && i < k, `${label}: ${r.id} sits above its anchor outside a pinned chain`);
    for (let j = i; j < k; j++) {
      const packed = out[j].top + h(out[j]) + o.gap;
      assert.ok(Math.abs(out[j + 1].top - packed) < EPS, `${label}: ${r.id} is above its anchor but the chain is not packed at ${out[j].id}`);
    }
  }
  if (k >= 0) {
    const a = byId.get(out[k].id);
    // the active card is at its anchor unless the chain had to slide down (then card 0 sits at 0)
    assert.ok(Math.abs(out[k].top - a.anchorY) < EPS || Math.abs(out[0].top) < EPS, `${label}: active card neither pinned nor slid down`);
    assert.ok(out[k].top >= a.anchorY - EPS, `${label}: active card above its anchor`);
  }
}

function feedBack(cards, out) {
  const flags = new Map(out.map((r) => [r.id, r.collapsed]));
  return cards.map((c) => ({ ...c, collapsed: flags.get(c.id) }));
}

// ------------------------------------------------------------------ 200 random cards

test("200 random cards: no overlaps, top >= anchorY unless in the pinned chain, idempotent", () => {
  let runs = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
    for (const span of [3000, 20000, 200000]) {
      for (const shuffle of [false, true]) {
        const cards = randomCards(seed * 1000 + span, 200, span, shuffle);
        const ids = sortedIds(cards);
        const preCollapsed = cards.find((c) => c.collapsed);
        const actives = [null, ids[0], ids[99], ids[199], preCollapsed ? preCollapsed.id : ids[42], "missing-id"];
        for (const activeId of actives) {
          const o = { ...O, activeId };
          const label = `seed ${seed} span ${span} shuffle ${shuffle} active ${activeId}`;
          const snapshot = JSON.stringify(cards);
          const out = compute(cards, o);
          assert.equal(JSON.stringify(cards), snapshot, label + ": input not mutated");
          assert.equal(out.length, 200);
          checkInvariants(cards, out, o, label);
          const again = compute(feedBack(cards, out), o);
          assert.deepEqual(again, out, label + ": idempotent");
          runs++;
        }
      }
    }
  }
  assert.ok(runs > 200);
});

test("random cards with custom gap / maxDrift / collapsedH", () => {
  const o = { activeId: "c7", gap: 12, maxDrift: 150, collapsedH: 30 };
  for (const seed of [11, 12, 13]) {
    const cards = randomCards(seed, 200, 15000, false);
    const out = compute(cards, o);
    checkInvariants(cards, out, o, "custom " + seed);
    assert.deepEqual(compute(feedBack(cards, out), o), out, "custom idempotent " + seed);
  }
});

// ------------------------------------------------------------------ pass A

test("pass A: forward cascade keeps every card at or below its anchor, no active card", () => {
  const cards = [
    { id: "a", anchorY: 0, height: 100, collapsed: false },
    { id: "b", anchorY: 50, height: 100, collapsed: false },
    { id: "c", anchorY: 300, height: 50, collapsed: false },
    { id: "d", anchorY: 310, height: 50, collapsed: true }
  ];
  assert.deepEqual(compute(cards, O), [
    { id: "a", top: 0, collapsed: false },
    { id: "b", top: 108, collapsed: false },
    { id: "c", top: 300, collapsed: false },
    { id: "d", top: 358, collapsed: true } // collapsed input card occupies collapsedH (24), not its height
  ]);
  // a collapsed card is 24 px for the card after it
  const next = compute(cards.concat([{ id: "e", anchorY: 320, height: 10, collapsed: false }]), O);
  assert.equal(next[4].id, "e");
  assert.equal(next[4].top, 358 + 24 + 8);
});

test("defensive stable sort: unsorted input, ties keep the caller's order", () => {
  const cards = [
    { id: "late", anchorY: 500, height: 40, collapsed: false },
    { id: "first", anchorY: 100, height: 40, collapsed: false },
    { id: "second", anchorY: 100, height: 40, collapsed: false },
    { id: "third", anchorY: 100, height: 40, collapsed: false }
  ];
  assert.deepEqual(compute(cards, O), [
    { id: "first", top: 100, collapsed: false },
    { id: "second", top: 148, collapsed: false },
    { id: "third", top: 196, collapsed: false },
    { id: "late", top: 500, collapsed: false }
  ]);
});

// ------------------------------------------------------------------ pass B

test("pass B: the active card is pinned and only the minimal chain above it moves up", () => {
  const cards = [
    { id: "A", anchorY: 0, height: 50, collapsed: false },
    { id: "B", anchorY: 400, height: 100, collapsed: false },
    { id: "C", anchorY: 450, height: 100, collapsed: false },
    { id: "D", anchorY: 480, height: 50, collapsed: false },
    { id: "E", anchorY: 500, height: 50, collapsed: false }
  ];
  // without an active card: plain cascade
  assert.deepEqual(compute(cards, O).map((r) => r.top), [0, 400, 508, 616, 674]);
  // D active: C and B are pushed up just enough, A is untouched, E cascades from D
  const out = compute(cards, { ...O, activeId: "D" });
  assert.deepEqual(out, [
    { id: "A", top: 0, collapsed: false },
    { id: "B", top: 264, collapsed: false },
    { id: "C", top: 372, collapsed: false },
    { id: "D", top: 480, collapsed: false },
    { id: "E", top: 538, collapsed: false }
  ]);
  // B active: nothing above it needs to move; the cards below cascade from its anchor
  assert.deepEqual(compute(cards, { ...O, activeId: "B" }).map((r) => r.top), [0, 400, 508, 616, 674]);
  // an active card that is already at its anchor changes nothing
  assert.deepEqual(compute(cards, { ...O, activeId: "A" }).map((r) => r.top), [0, 400, 508, 616, 674]);
});

test("pass B: slide down when there is no room above the pinned card", () => {
  const cards = [
    { id: "A", anchorY: 0, height: 100, collapsed: false },
    { id: "B", anchorY: 50, height: 100, collapsed: false },
    { id: "C", anchorY: 100, height: 100, collapsed: false },
    { id: "D", anchorY: 120, height: 40, collapsed: false }
  ];
  const out = compute(cards, { ...O, activeId: "C" });
  assert.deepEqual(out, [
    { id: "A", top: 0, collapsed: false },
    { id: "B", top: 108, collapsed: false },
    { id: "C", top: 216, collapsed: false }, // below its anchor: the chain could not fit above
    { id: "D", top: 324, collapsed: false }
  ]);
  // partial room: the chain is packed from the top of the margin
  const cards2 = [
    { id: "A", anchorY: 0, height: 100, collapsed: false },
    { id: "B", anchorY: 50, height: 100, collapsed: false },
    { id: "C", anchorY: 150, height: 100, collapsed: false }
  ];
  assert.deepEqual(compute(cards2, { ...O, activeId: "C" }).map((r) => r.top), [0, 108, 216]);
  const cards3 = [
    { id: "A", anchorY: 0, height: 100, collapsed: false },
    { id: "B", anchorY: 50, height: 100, collapsed: false },
    { id: "C", anchorY: 220, height: 100, collapsed: false }
  ];
  // B's bottom (208) already clears the limit (212): nothing above the pinned card moves
  assert.deepEqual(compute(cards3, { ...O, activeId: "C" }).map((r) => r.top), [0, 108, 220]);
  const cards4 = [
    { id: "A", anchorY: 0, height: 34, collapsed: false },
    { id: "B", anchorY: 100, height: 100, collapsed: false },
    { id: "C", anchorY: 150, height: 100, collapsed: false }
  ];
  // exactly enough room: B is pushed up to 150 - 8 - 100 = 42 and A's bottom (34) meets the limit
  assert.deepEqual(compute(cards4, { ...O, activeId: "C" }).map((r) => r.top), [0, 42, 150]);
});

test("pass B: a collapsed active card is pinned with its pill height", () => {
  const cards = [
    { id: "A", anchorY: 100, height: 100, collapsed: false },
    { id: "B", anchorY: 120, height: 100, collapsed: true },
    { id: "C", anchorY: 130, height: 100, collapsed: false }
  ];
  const out = compute(cards, { ...O, activeId: "B" });
  assert.deepEqual(out, [
    { id: "A", top: 12, collapsed: false },
    { id: "B", top: 120, collapsed: true },
    { id: "C", top: 152, collapsed: false }
  ]);
});

// ------------------------------------------------------------------ pass C

test("pass C: cards drifting more than 320 px collapse, the rest keep their height", () => {
  const cards = [];
  for (let i = 0; i < 10; i++) cards.push({ id: "c" + i, anchorY: 100, height: 100, collapsed: false });
  const out = compute(cards, O);
  assert.deepEqual(out.map((r) => r.collapsed), [false, false, false, true, true, true, true, true, true, true]);
  assert.deepEqual(out.map((r) => r.top), [100, 208, 316, 424, 456, 488, 520, 552, 584, 616]);
  // exactly 320 px of drift is still allowed
  const edge = [];
  for (let i = 0; i < 5; i++) edge.push({ id: "e" + i, anchorY: 0, height: 152, collapsed: false });
  const outEdge = compute(edge, O);
  assert.deepEqual(outEdge.map((r) => r.top), [0, 160, 320, 480, 512]);
  assert.deepEqual(outEdge.map((r) => r.collapsed), [false, false, false, true, true]);
});

test("pass C: the active card never collapses, even when it slid down past maxDrift", () => {
  const cards = [];
  for (let i = 0; i < 8; i++) cards.push({ id: "c" + i, anchorY: 10, height: 100, collapsed: false });
  const out = compute(cards, { ...O, activeId: "c7" });
  const active = out.find((r) => r.id === "c7");
  assert.equal(active.collapsed, false);
  assert.ok(active.top > 10 + 320, "slid far below its anchor");
  // after the slide-down c3 sits at 324 (drift 314 <= 320) and stays expanded; c4..c6 collapse
  assert.deepEqual(out.map((r) => r.top), [0, 108, 216, 324, 432, 464, 496, 528]);
  assert.deepEqual(out.slice(0, 7).map((r) => r.collapsed), [false, false, false, false, true, true, true]);
  assert.deepEqual(compute(feedBack(cards, out), { ...O, activeId: "c7" }), out);
});

test("pass C: collapsing frees room so later cards need not collapse (reruns to a fixed point)", () => {
  const cards = [
    { id: "a", anchorY: 0, height: 300, collapsed: false },
    { id: "b", anchorY: 0, height: 300, collapsed: false },
    { id: "c", anchorY: 0, height: 300, collapsed: false }, // pass A drift 616 → collapses
    { id: "d", anchorY: 700, height: 100, collapsed: false }
  ];
  const out = compute(cards, O);
  assert.deepEqual(out, [
    { id: "a", top: 0, collapsed: false },
    { id: "b", top: 308, collapsed: false },
    { id: "c", top: 616, collapsed: true },
    { id: "d", top: 700, collapsed: false }
  ]);
  assert.deepEqual(compute(feedBack(cards, out), O), out);
});

// ------------------------------------------------------------------ idempotence & robustness

test("idempotence: feeding the collapsed flags back reproduces the same layout", () => {
  const cards = randomCards(99, 60, 2500, false);
  for (const activeId of [null, "c0", "c30", "c59"]) {
    const o = { ...O, activeId };
    const out1 = compute(cards, o);
    const out2 = compute(feedBack(cards, out1), o);
    const out3 = compute(feedBack(cards, out2), o);
    assert.deepEqual(out2, out1);
    assert.deepEqual(out3, out1);
  }
});

test("robustness: empty input, missing options, garbage entries, defaults", () => {
  assert.deepEqual(compute([], O), []);
  assert.deepEqual(compute(null), []);
  assert.deepEqual(compute(undefined, null), []);
  assert.deepEqual(compute([{ id: "x", anchorY: 10, height: 20 }]), [{ id: "x", top: 10, collapsed: false }]);
  const out = compute([null, 5, { id: "x", anchorY: NaN, height: "tall" }, { id: "y", anchorY: 10, height: 20, collapsed: 1 }], {});
  assert.deepEqual(out, [{ id: "x", top: 0, collapsed: false }, { id: "y", top: 10, collapsed: true }]);
  assert.deepEqual(layout.DEFAULTS, { gap: 8, maxDrift: 320, collapsedH: 24 });
});

/* SELF-CHECK: covers SPEC §12 layout bullets — 200 random cards with a seeded PRNG (no overlaps,
 * top >= anchorY unless in the pinned chain), minimal upward chain, slide-down when out of room,
 * collapse beyond 320, idempotence — plus pass A/B/C edge cases and input robustness. */
