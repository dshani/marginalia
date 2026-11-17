/* Marginalia — M.settings (SPEC §8, §17.2): localStorage-backed settings + the API key.
   Loads in node with no DOM: without localStorage everything lives in memory.

   - Settings are one JSON object in localStorage["marginalia.settings"]; the API key sits apart in
     localStorage["marginalia.apiKey"] and never appears in all() (so backups never carry it).
   - Every localStorage access is wrapped in try/catch (private windows, sandboxes, quota).
   - get(key) and all() return clones, never live state; reviewKeys is always a full map (missing
     actions fall back to the Default preset; an explicit null means "unbound").
   - set(key, value) validates the known keys (theme/marginMode/snipMode enumerations, booleans,
     visionModel non-empty string, reviewKeys object, obsidianFolder a one-line string of at most 300 characters,
     "" allowed, without leading, trailing or doubled "/"; obsidianVault a vault's name exactly as Obsidian lists it,
     at most 200 characters with no control character, spaces kept as they are, only blanks → ""; obsidian, the switch
     "Connect Marginalia to Obsidian" of DECISIONS D32, only true, false or null, where null means never chosen (a stored
     other value loads as null; js/obsidian.js enabled() reads it); autoBackup only true
     or false, default true, read by js/backup.js; notAlike an array of at most 5000 pair keys of at most 200
     characters each, invalid entries dropped, FEATURES P2.4): an invalid value is ignored with a
     console.warn and set returns false; otherwise it persists, emits settings:changed {key, value}
     through M.bus when M.bus exists, and returns true. Unknown keys are stored as given.
   - In a tab that stepped aside for a newer Marginalia tab (M.store.locked(), js/store.js) set() returns false and
     reset() does nothing: the whole object this tab would write back may be older than the newer tab's.
   - apiKey.set/forget also emit settings:changed {key: "apiKey", value: <boolean has-key>} so the
     snip tool can re-run M.vision.detect(); the key itself is never put on the bus.
   - DEFAULTS.reviewKeys duplicates M.keys.PRESETS.Default on purpose: settings.js loads before
     keys.js (SPEC §18) and must not depend on it. A stored map from before flag and delete existed (FEATURES P1.3)
     gets each of them with its Default key ("f", "Backspace") only when no other action of that map uses the key
     (compared as M.keys.canonical compares); otherwise it stays unbound (null), as in M.keys.reviewMap.
*/
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  void dep; // settings talks to M.bus only when it is present; nothing is required at load time

  var STORAGE_KEY = "marginalia.settings";
  var API_KEY_KEY = "marginalia.apiKey";
  var INVALID = {}; // sentinel

  var DEFAULT_REVIEW_KEYS = {
    showAnswer: "Space", forgot: "1", remembered: "2", undo: "u", skip: "s", goToSource: "g", flag: "f", "delete": "Backspace",
    exit: "Escape"
  };
  // Review actions added after the first seven (FEATURES P1.3): a map stored before lacks them (M.keys.LATE_REVIEW_ACTIONS).
  var LATE_REVIEW_ACTIONS = ["flag", "delete"];
  // A copy of M.keys' binding names (js/keys.js NAMED, MOD_ALIASES), so that the stored map is filled by the same
  // canonical comparison M.keys.reviewMap makes, without depending on keys.js.
  var KEY_NAMES = {
    space: "Space", spacebar: "Space", esc: "Escape", escape: "Escape", enter: "Enter", "return": "Enter",
    backspace: "Backspace", "delete": "Delete", del: "Delete", tab: "Tab", insert: "Insert", home: "Home", end: "End",
    pageup: "PageUp", pagedown: "PageDown", arrowleft: "ArrowLeft", left: "ArrowLeft", arrowright: "ArrowRight",
    right: "ArrowRight", arrowup: "ArrowUp", up: "ArrowUp", arrowdown: "ArrowDown", down: "ArrowDown",
    capslock: "CapsLock", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta"
  };
  var EVENT_MOD_KEYS = { Control: "Ctrl", Alt: "Alt", AltGraph: "Alt", Shift: "Shift", Meta: "Meta", OS: "Meta" };
  var MOD_NAMES = {
    ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift",
    meta: "meta", cmd: "meta", command: "meta", "super": "meta", win: "meta", windows: "meta", mod: "mod"
  };
  var DEFAULTS = deepFreeze({
    theme: "system",
    dimPages: false,
    marginAnswers: true,
    marginMode: "cards",
    snipMode: "image",
    reviewKeys: DEFAULT_REVIEW_KEYS,
    visionModel: "claude-opus-5-5",
    obsidian: null,                    // the Obsidian connection: true | false; null = never chosen (D32, M.obsidian.enabled())
    obsidianVault: "",                 // "" = the only vault Marginalia's server finds (BUILD-NOTES "Obsidian")
    obsidianFolder: "Notes/Marginalia", // inside the vault; "" = the vault root
    autoBackup: true,                  // the daily backup through Marginalia's server (js/backup.js)
    notAlike: []                       // pair keys the user marked "Not alike" (FEATURES P2.4, M.similar.key)
  });
  var ENUMS = { theme: ["system", "light", "dark"], marginMode: ["cards", "markers"], snipMode: ["image", "latex"] };
  var BOOLS = { dimPages: true, marginAnswers: true };
  var STRICT_BOOLS = { autoBackup: true };   // only true or false: anything else is refused (a stored one → the default)
  var TEXTS = { obsidianVault: 200, obsidianFolder: 300 };   // one-line strings: key → max characters
  var NOT_ALIKE_MAX = 5000;          // notAlike keeps at most this many pair keys (the newest)
  var NOT_ALIKE_KEY_MAX = 200;       // characters per pair key

  var state = null;            // merged settings, loaded lazily
  var memoryApiKey = null;     // fallback when localStorage is unavailable or throws

  // ---- helpers ------------------------------------------------------------

  function deepFreeze(o) {
    Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === "object") deepFreeze(o[k]); });
    return Object.freeze(o);
  }

  function clone(v) {
    if (v === null || v === undefined || typeof v !== "object") return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }

  function warn(msg) {
    try { console.warn("[settings] " + msg); } catch (e) { /* no console */ }
  }

  function storage() {
    try {
      var s = root.localStorage;
      return s && typeof s.getItem === "function" ? s : null;
    } catch (e) { return null; }
  }

  function readItem(key) {
    var s = storage();
    if (!s) return null;
    try { return s.getItem(key); } catch (e) { return null; }
  }

  function writeItem(key, value) {
    var s = storage();
    if (!s) return false;
    try { s.setItem(key, value); return true; } catch (e) { return false; }
  }

  function removeItem(key) {
    var s = storage();
    if (!s) return false;
    try { s.removeItem(key); return true; } catch (e) { return false; }
  }

  function emitChanged(key, value) {
    var bus = M.bus;
    if (bus && typeof bus.emit === "function") bus.emit("settings:changed", { key: key, value: value });
  }

  // A binding as one comparable string, as M.keys.canonical writes it ("Mod" stays "Mod": no binding with a modifier
  // ever equals a late action's Default, which has none); "" when it binds no key.
  function bindingId(binding) {
    if (typeof binding !== "string") return "";
    var s = binding === " " ? "Space" : binding.trim();
    if (!s) return "";
    var key, rest;
    if (s.charAt(s.length - 1) === "+") {
      key = "+"; rest = s.slice(0, -1);
      if (rest.charAt(rest.length - 1) === "+") rest = rest.slice(0, -1);
    } else {
      var i = s.lastIndexOf("+");
      if (i < 0) { key = s; rest = ""; } else { key = s.slice(i + 1); rest = s.slice(0, i); }
    }
    var mods = { ctrl: false, alt: false, shift: false, meta: false, mod: false };
    if (rest) rest.split("+").forEach(function (m) { var n = MOD_NAMES[m.trim().toLowerCase()]; if (n) mods[n] = true; });
    var k = key === " " ? "Space" : key, letter = k.length === 1 && k.toLowerCase() !== k.toUpperCase();
    if (k.length === 1) k = letter ? k.toLowerCase() : k;
    else if (KEY_NAMES[k.toLowerCase()]) k = KEY_NAMES[k.toLowerCase()];
    else if (/^f\d{1,2}$/i.test(k)) k = k.toUpperCase();
    else if (EVENT_MOD_KEYS[k]) k = EVENT_MOD_KEYS[k];
    if (!k) return "";
    if (k.length === 1 && !letter) mods.shift = false;
    return (mods.mod ? "Mod+" : "") + (mods.ctrl ? "Ctrl+" : "") + (mods.alt ? "Alt+" : "") + (mods.shift ? "Shift+" : "") +
      (mods.meta ? "Meta+" : "") + k;
  }

  function sanitizeReviewKeys(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return INVALID;
    var out = clone(DEFAULT_REVIEW_KEYS);
    Object.keys(value).forEach(function (action) {
      var b = value[action];
      if (b && typeof b === "object" && !Array.isArray(b)) b = b.binding; // dispatch-shape entry
      if (typeof b === "string" && b) out[action] = b;
      else if (Array.isArray(b)) out[action] = b.filter(function (x) { return typeof x === "string" && x; });
      else out[action] = null; // unbound
    });
    // A late action the stored map lacks gets its Default key only while no other action of that map uses it (the
    // rule of M.keys.reviewMap): never two review actions on one key.
    LATE_REVIEW_ACTIONS.forEach(function (late) {
      if (Object.prototype.hasOwnProperty.call(value, late)) return;
      var want = bindingId(DEFAULT_REVIEW_KEYS[late]);
      var taken = Object.keys(DEFAULT_REVIEW_KEYS).some(function (a) {
        if (a === late || !Object.prototype.hasOwnProperty.call(value, a)) return false;
        var b = out[a];
        return (Array.isArray(b) ? b : [b]).some(function (x) { return bindingId(x) === want; });
      });
      if (taken) out[late] = null;
    });
    return out;
  }

  // A one-line text setting: control characters → spaces, whitespace collapsed, trimmed; "" is allowed.
  function sanitizeText(value, max) {
    if (typeof value !== "string") return INVALID;
    var v = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return v.length <= max ? v : INVALID;
  }

  // obsidianVault: a vault's name exactly as Obsidian lists it (its folder's name), so doubled, leading, trailing and
  // no-break spaces stay; a control character (C0, DEL, C1) makes the value invalid; only blanks is "" (no vault named).
  function sanitizeVaultName(value, max) {
    if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return INVALID;
    if (!value.trim()) return "";
    return value.length <= max ? value : INVALID;
  }

  // notAlike (FEATURES P2.4): an array of pair keys ("<id>|<id>", M.similar.key). Entries that are not strings, are
  // empty or longer than NOT_ALIKE_KEY_MAX characters are dropped, and so are repeats (the first one stays); of more than
  // NOT_ALIKE_MAX keys the last NOT_ALIKE_MAX stay (a mark is appended, so these are the newest). Not an array: invalid.
  function sanitizeNotAlike(value) {
    if (!Array.isArray(value)) return INVALID;
    var seen = Object.create(null), out = [];
    for (var i = 0; i < value.length; i++) {
      var k = value[i];
      if (typeof k !== "string" || !k || k.length > NOT_ALIKE_KEY_MAX || seen[k]) continue;
      seen[k] = true;
      out.push(k);
    }
    return out.length > NOT_ALIKE_MAX ? out.slice(out.length - NOT_ALIKE_MAX) : out;
  }

  function sanitize(key, value) {
    if (ENUMS[key]) return ENUMS[key].indexOf(value) >= 0 ? value : INVALID;
    if (BOOLS[key]) return !!value;
    if (STRICT_BOOLS[key]) return typeof value === "boolean" ? value : INVALID;
    if (key === "obsidian") return value === null || typeof value === "boolean" ? value : INVALID;   // null: never chosen (D32)
    if (key === "visionModel") return typeof value === "string" && value.trim() ? value.trim() : INVALID;
    if (key === "reviewKeys") return sanitizeReviewKeys(value);
    if (key === "notAlike") return sanitizeNotAlike(value);
    if (key === "obsidianVault") return sanitizeVaultName(value, TEXTS.obsidianVault);
    if (TEXTS[key]) {
      var t = sanitizeText(value, TEXTS[key]);
      return key === "obsidianFolder" && t !== INVALID ? t.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "") : t;
    }
    return value; // unknown keys: stored as given
  }

  function merge(stored) {
    var out = clone(DEFAULTS);
    Object.keys(stored).forEach(function (k) {
      var v = sanitize(k, stored[k]);
      if (v !== INVALID) out[k] = clone(v);
    });
    return out;
  }

  function load() {
    if (state) return state;
    var stored = null, raw = readItem(STORAGE_KEY);
    if (raw) {
      try { stored = JSON.parse(raw); } catch (e) { stored = null; warn("stored settings were not valid JSON; using defaults"); }
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) stored = {};
    state = merge(stored);
    return state;
  }

  function persist() {
    var json;
    try { json = JSON.stringify(state); } catch (e) { return false; }
    return writeItem(STORAGE_KEY, json);
  }

  // One writing tab per origin (js/store.js): once a newer Marginalia tab took over, this tab's settings may be older
  // than that tab's, and persist() writes the whole object, so set() and reset() store nothing here.
  function tabLocked() {
    var st = M.store;
    try { return !!(st && typeof st.locked === "function" && st.locked()); } catch (e) { return false; }
  }

  // ---- api ----------------------------------------------------------------

  function get(key) {
    return clone(load()[key]);
  }

  function set(key, value) {
    if (typeof key !== "string" || !key) {
      var e = new TypeError("settings.set: key must be a non-empty string");
      e.code = "bad_key";
      throw e;
    }
    if (tabLocked()) return false;
    var st = load(), v = sanitize(key, value);
    if (v === INVALID) { warn("ignored invalid value for \"" + key + "\""); return false; }
    st[key] = clone(v);
    persist();
    emitChanged(key, clone(v));
    return true;
  }

  function all() {
    return clone(load());
  }

  // Reads the stored settings again (DECISIONS D31: another window of the Mac app changed them) and says
  // settings:changed for each key whose value differs. → the keys that changed. It stores nothing.
  function reload() {
    var before = load(), stored = null, raw = readItem(STORAGE_KEY);
    if (raw) { try { stored = JSON.parse(raw); } catch (e) { stored = null; } }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      if (raw) return [];                                   // not readable: keep what this page has
      stored = {};
    }
    var after = merge(stored), changed = [];
    Object.keys(after).forEach(function (k) {
      var same = false;
      try { same = JSON.stringify(after[k]) === JSON.stringify(before[k]); } catch (e) { same = false; }
      if (!same) changed.push(k);
    });
    state = after;
    changed.forEach(function (k) { emitChanged(k, clone(after[k])); });
    return changed;
  }

  function reset() {
    if (tabLocked()) return;
    state = merge({});
    removeItem(STORAGE_KEY);
    Object.keys(DEFAULTS).forEach(function (k) { emitChanged(k, clone(state[k])); });
  }

  var apiKey = {
    get: function () {
      // The value set in this session wins (storage may have refused the write); else the stored one.
      if (memoryApiKey) return memoryApiKey;
      var v = readItem(API_KEY_KEY);
      return v ? v : null;
    },
    set: function (k) {
      var v = k == null ? "" : String(k).trim();
      if (!v) return apiKey.forget();
      memoryApiKey = v;
      writeItem(API_KEY_KEY, v);
      emitChanged("apiKey", true);
      return true;
    },
    forget: function () {
      memoryApiKey = null;
      removeItem(API_KEY_KEY);
      emitChanged("apiKey", false);
      return true;
    }
  };

  var api = {
    DEFAULTS: DEFAULTS,
    NOT_ALIKE_MAX: NOT_ALIKE_MAX,
    NOT_ALIKE_KEY_MAX: NOT_ALIKE_KEY_MAX,
    get: get,
    set: set,
    all: all,
    reload: reload,
    reset: reset,
    apiKey: apiKey
  };
  M.settings = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.settings): get(key) → value; set(key, value) (persists
   localStorage["marginalia.settings"], emits settings:changed {key, value}); all(); DEFAULTS; reset();
   apiKey.get() | set(k) | forget() on localStorage["marginalia.apiKey"].
   BUILD-NOTES "Prompt craft" (FEATURES P1.3): DEFAULTS.reviewKeys has flag "f" and delete "Backspace"; a stored map
   without them gets them only where no other action of that map uses the key (else null), as M.keys.reviewMap does.
   BUILD-NOTES "Obsidian": DEFAULTS.obsidianVault "" and DEFAULTS.obsidianFolder "Notes/Marginalia", validated (the
   vault name verbatim, spaces and all; a control character refused).
   DECISIONS D32 (BUILD-NOTES "Obsidian", "The switch"): DEFAULTS.obsidian null = never chosen; set takes only true, false
   or null (set → false otherwise; a stored other value loads as null). One of the exporter's backup settings.
   BUILD-NOTES "Automatic backup": DEFAULTS.autoBackup true, only a boolean accepted (set → false otherwise; a stored
   non-boolean loads as the default). It is not one of the exporter's backup settings: each browser keeps its own.
   BUILD-NOTES "One writing tab per origin": set() → false and reset() a no-op while M.store.locked().
   BUILD-NOTES "Prompt craft" (FEATURES P2.4): DEFAULTS.notAlike [] — an array of pair keys; non-strings, empty keys,
   keys over NOT_ALIKE_KEY_MAX (200) characters and repeats dropped; of more than NOT_ALIKE_MAX (5000) the last 5000
   kept; a non-array refused (set → false; a stored one loads as []). One of the exporter's backup settings. */
