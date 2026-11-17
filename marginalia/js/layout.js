/* Marginalia — js/layout.js
 * M.layout (pure, SPEC §6 / §17.2): the margin cascade. compute() places every card at or below
 * its anchor, pins the active card to its anchor by pushing the minimal chain above it up, slides
 * that chain down when there is no room, and collapses cards that would drift more than maxDrift
 * below their anchor. No DOM, no dependencies, never mutates its input.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); } // eslint-disable-line no-unused-vars

  var DEFAULTS = { gap: 8, maxDrift: 320, collapsedH: 24 };

  function num(v, fallback) { return typeof v === "number" && isFinite(v) ? v : fallback; }

  // cards: [{id, anchorY, height, collapsed}] (sorted by anchorY; sorted again here, stably)
  // options: {activeId, gap = 8, maxDrift = 320, collapsedH = 24}
  // → [{id, top, collapsed}] in anchor order
  function compute(cards, options) {
    var o = options && typeof options === "object" ? options : {};
    var gap = num(o.gap, DEFAULTS.gap);
    var maxDrift = num(o.maxDrift, DEFAULTS.maxDrift);
    var collapsedH = num(o.collapsedH, DEFAULTS.collapsedH);
    var activeId = o.activeId == null ? null : o.activeId;

    var work = [];
    var list = Array.isArray(cards) ? cards : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || typeof c !== "object") continue;
      var collapsed = !!c.collapsed;
      work.push({
        id: c.id,
        anchorY: num(c.anchorY, 0),
        height: collapsed ? collapsedH : Math.max(0, num(c.height, 0)),
        collapsed: collapsed,
        top: 0,
        order: work.length
      });
    }
    // defensive stable sort: anchorY, then the caller's order (which is (anchorY, createdAt))
    work.sort(function (a, b) { return (a.anchorY - b.anchorY) || (a.order - b.order); });

    var n = work.length, k = -1;
    if (activeId != null) {
      for (var j = 0; j < n; j++) if (work[j].id === activeId) { k = j; break; }
    }

    function cascade(from, prev) {
      for (var i = from; i < n; i++) {
        var c = work[i];
        c.top = Math.max(c.anchorY, prev + gap);
        prev = c.top + c.height;
      }
    }

    // A — forward cascade: no card above its anchor
    function passA() { cascade(0, -Infinity); }

    // B — the active card is pinned; push the minimal chain above it up, slide down when out of room
    function passB() {
      if (k < 0) return;
      var a = work[k];
      a.top = a.anchorY;
      var limit = a.top - gap;
      for (var i = k - 1; i >= 0; i--) {
        var c = work[i];
        if (c.top + c.height <= limit) break;
        c.top = limit - c.height;
        limit = c.top - gap;
      }
      if (work[0].top < 0) {
        var shift = -work[0].top;
        for (var m = 0; m <= k; m++) work[m].top += shift;
      }
      cascade(k + 1, a.top + a.height);
    }

    // C — degrade instead of drifting
    function passC() {
      var changed = false;
      for (var i = 0; i < n; i++) {
        var c = work[i];
        if (c.collapsed || i === k) continue;
        if (c.top - c.anchorY > maxDrift) {
          c.collapsed = true;
          c.height = collapsedH;
          changed = true;
        }
      }
      return changed;
    }

    // Collapsing only ever adds collapsed cards, so this reaches a fixed point in at most n + 1
    // rounds (one extra pass in practice), which makes compute idempotent on its own output.
    for (var round = 0; round <= n; round++) {
      passA();
      passB();
      if (!passC()) break;
    }

    return work.map(function (c) { return { id: c.id, top: c.top, collapsed: c.collapsed }; });
  }

  var api = { compute: compute, DEFAULTS: DEFAULTS };
  M.layout = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.layout)
 *   compute(cards, {activeId, gap, maxDrift, collapsedH}) → [{id, top, collapsed}]
 *   DEFAULTS {gap: 8, maxDrift: 320, collapsedH: 24}   (constants of §6, exported for the margin driver)
 */
