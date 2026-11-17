/* Marginalia — M.bus (SPEC §10, §17.2, §17.3): the one event bus modules talk through.
   Pure module: loads in node with no DOM.

   - on(type, fn) → off(): subscribes; the returned function unsubscribes that one subscription.
   - off(type, fn): removes one subscription (off(type) with no fn removes every listener of type).
   - emit(type, payload): synchronous; each listener runs in its own try/catch (a throw is
     console.error'ed and the others still run). Listeners may subscribe or unsubscribe during
     emit: the emit walks a snapshot of the list and skips listeners removed meanwhile; listeners
     added meanwhile are not called for the emit in progress.
*/
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  void dep; // bus has no module dependencies; the helper is kept for the §17.1 skeleton

  var listeners = Object.create(null); // type → [fn, …]

  function bad(code, message) {
    var e = new TypeError(message);
    e.code = code;
    return e;
  }

  function on(type, fn) {
    if (typeof type !== "string" || !type) throw bad("bad_type", "bus.on: type must be a non-empty string");
    if (typeof fn !== "function") throw bad("bad_listener", "bus.on: listener must be a function");
    var list = listeners[type] || (listeners[type] = []);
    list.push(fn);
    var active = true;
    return function off() {
      if (!active) return;
      active = false;
      api.off(type, fn);
    };
  }

  function off(type, fn) {
    var list = listeners[type];
    if (!list) return;
    if (fn == null) { delete listeners[type]; return; }
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) delete listeners[type];
  }

  function emit(type, payload) {
    var list = listeners[type];
    if (!list || !list.length) return;
    var snapshot = list.slice();
    for (var i = 0; i < snapshot.length; i++) {
      var fn = snapshot[i], live = listeners[type];
      if (!live || live.indexOf(fn) < 0) continue; // unsubscribed during this emit
      try {
        fn(payload);
      } catch (err) {
        try { console.error("[bus] listener for \"" + type + "\" threw:", err); } catch (e2) { /* no console */ }
      }
    }
  }

  var api = { on: on, off: off, emit: emit };
  M.bus = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.bus): on(type, fn) → off(); off(type, fn); emit(type, payload) — sync,
   listeners isolated by try/catch, safe to unsubscribe during emit. */
