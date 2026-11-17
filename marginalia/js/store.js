/* js/store.js — Marginalia persistence (SPEC §8, §17; BUILD-NOTES).
 *
 * One seven-call backend interface with two implementations:
 *   idb     — IndexedDB database "marginalia", DB_VERSION 1 (five stores, see MIGRATIONS[1])
 *   memory  — the same schema in Maps; used in node (no indexedDB) and as the fallback when
 *             IndexedDB cannot be opened (SecurityError / UnknownError / anything else).
 * Typed helpers (collections, prompts, docs, attachments, meta) sit on top of a facade that
 * opens the database on first use. Every durable byte of the app goes through this file (D1).
 *
 * One writing tab per origin: every tab of an origin shares the IndexedDB database, but each one keeps its own
 * in-memory copy (M.cache) and writes whole records from it, so an older tab's next save would silently undo what
 * a newer tab stored (an "Open in Marginalia" link in Obsidian opens a new tab while the reading tab stays open).
 * The newest tab wins: once the database is open in idb mode, a tab announces itself on the BroadcastChannel
 * "marginalia" and in localStorage["marginalia.tab"] (the storage event is the fallback; the key also tells a tab
 * that missed the message, e.g. one back from the back-forward cache, on pageshow / visibilitychange). Every
 * older tab then locks this facade at once: from then on every put, delete and readwrite transaction rejects
 * with code "locked" (a transaction already running aborts at its next write), so no pending save, timer or
 * review grade can write afterwards; reads still work. store:mode {mode: "idb", reason: "othertab"} tells M.app
 * to cover the page ("Use this tab" reloads it, and the reloaded tab announces itself in turn). The memory
 * backend never takes part: its data lives only in its own tab.
 *
 * Handover between the windows of the Mac app (DECISIONS D31, BUILD-NOTES "Windows"): there every window is a page
 * of this origin, and all of them stay in use. M.app turns HANDOVER MODE on before open() (handover(true); it needs
 * idb mode and navigator.locks, else the rule above holds). One page is the WRITER: the holder of the Web Lock
 * "marginalia.writer" (it goes free when its page dies, so a closed window never blocks the others). Every other
 * page is a reader: locked() answers {reason: "window"} and every write is refused exactly as above, but nothing
 * covers the page and no store:mode goes out. acquire(sync) makes this page the writer: it asks for the lock and
 * says so on the BroadcastChannel ({type: "want"}, with the ask's number: of two asks the later one wins); the
 * writer then refuses new writes at once, waits until its writes under way have ended (idle()), and lets the lock
 * go. The page that gets the lock first runs sync(changed) (changed is always true: another page may have written,
 * so M.cache reads the library again), and only then may it write; store:writer {writer} tells the page when the
 * role comes and goes.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  var DB_NAME = "marginalia";
  var DB_VERSION = 1;
  var DATA_VERSION = 1;
  var CHUNK_SIZE = 8 * 1024 * 1024;          // 8 MiB slices (§8)
  var MAX_DOC_BYTES = 300 * 1024 * 1024;     // files over 300 MB are refused (§11)
  var BATCH_SIZE = 200;                      // data migrations walk stores in batches of 200 (§8)
  var LOOKAHEAD_FALLBACK = 16 * 3600000;     // M.scheduler.LOOKAHEAD when the scheduler is not loaded
  var MSG_UNAVAILABLE = "Storage unavailable in this view — export often";
  var MSG_VERSIONCHANGE = "Marginalia was updated in another tab — reload";
  var MSG_BLOCKED = "Close other Marginalia tabs so storage can finish updating";
  var MSG_OTHER_TAB = "Marginalia is open in another tab";
  var TAB_CHANNEL = "marginalia";            // the BroadcastChannel every Marginalia tab of this origin listens on
  var TAB_KEY = "marginalia.tab";            // localStorage: {id, at} of the newest tab (storage-event fallback)
  var MSG_OTHER_WINDOW = "Another Marginalia window is writing";
  var LOCK_PREFIX = "marginalia.";           // every Web Lock of the app: "marginalia.writer", "marginalia.review", …
  var WRITER_LOCK = LOCK_PREFIX + "writer";  // handover mode: its holder is the one page that writes
  var WANT_EVERY_MS = 300;                   // a page that waits for the role says so again this often
  var WANT_FRESH_MS = 1500;                  // an ask heard this long ago is still there (a page in the background says it once a second)

  /* ------------------------------------------------------------------ schema */

  // MIGRATIONS[v](db, tx): schema and IDB requests only; a throw aborts the upgrade atomically.
  var MIGRATIONS = {
    1: function (db) {
      var collections = db.createObjectStore("collections", { keyPath: "id" });
      collections.createIndex("byKind", "kind", { unique: false });
      db.createObjectStore("chunks", { keyPath: ["docId", "i"] });
      var prompts = db.createObjectStore("prompts", { keyPath: "id" });
      prompts.createIndex("byCollection", "collectionId", { unique: false });
      prompts.createIndex("byDue", "dueAt", { unique: false });
      prompts.createIndex("byCreated", "createdAt", { unique: false });
      db.createObjectStore("attachments", { keyPath: "id" });
      db.createObjectStore("meta", { keyPath: "key" });
    }
  };

  // DATA_MIGRATIONS[v](api) → Promise: run after open while meta.dataVersion < DATA_VERSION.
  // None are needed for DATA_VERSION 1; the runner (dataMigrate below) is in place for later versions.
  var DATA_MIGRATIONS = {};

  /* ------------------------------------------------------------------ helpers */

  function err(code, message, cause) {
    var e = new Error(message || code);
    e.code = code;
    if (cause !== undefined) e.cause = cause;
    return e;
  }

  function emit(type, payload) {
    var bus = M.bus || tryDep("bus");
    if (bus && typeof bus.emit === "function") {
      try { bus.emit(type, payload); } catch (e) { /* listeners are isolated by the bus */ }
    }
  }

  function notify(mode, reason, message) {
    emit("store:mode", { mode: mode, reason: reason || null, message: message || null });
  }

  function clone(v) {
    if (typeof structuredClone === "function") {
      try { return structuredClone(v); } catch (e) { return v; }
    }
    return v;
  }

  // IndexedDB key ordering: number < Date < string < binary < array.
  function keyType(k) {
    if (typeof k === "number") return 0;
    if (k instanceof Date) return 1;
    if (typeof k === "string") return 2;
    if (Array.isArray(k)) return 4;
    return 3;
  }

  function validKey(k) {
    if (typeof k === "number") return !isNaN(k);
    if (typeof k === "string") return true;
    if (k instanceof Date) return !isNaN(k.getTime());
    if (Array.isArray(k)) {
      for (var i = 0; i < k.length; i++) if (!validKey(k[i])) return false;
      return true;
    }
    if (typeof ArrayBuffer !== "undefined" && (k instanceof ArrayBuffer || ArrayBuffer.isView(k))) return true;
    return false;
  }

  function cmpKey(a, b) {
    var ta = keyType(a), tb = keyType(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (ta === 0 || ta === 1) { a = +a; b = +b; return a < b ? -1 : (a > b ? 1 : 0); }
    if (ta === 2) return a < b ? -1 : (a > b ? 1 : 0);
    if (ta === 4) {
      var n = Math.min(a.length, b.length);
      for (var i = 0; i < n; i++) { var c = cmpKey(a[i], b[i]); if (c) return c; }
      return a.length < b.length ? -1 : (a.length > b.length ? 1 : 0);
    }
    return 0;
  }

  function pathGet(obj, path) {
    var parts = String(path).split("."), v = obj;
    for (var i = 0; i < parts.length; i++) {
      if (v === null || v === undefined) return undefined;
      v = v[parts[i]];
    }
    return v;
  }

  function extractKey(value, keyPath) {
    if (Array.isArray(keyPath)) {
      var out = [];
      for (var i = 0; i < keyPath.length; i++) {
        var part = pathGet(value, keyPath[i]);
        if (!validKey(part)) return undefined;
        out.push(part);
      }
      return out;
    }
    var k = pathGet(value, keyPath);
    return validKey(k) ? k : undefined;
  }

  function canon(key) { return JSON.stringify(key); }

  function isRange(x) {
    return !!x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date) &&
      !(typeof ArrayBuffer !== "undefined" && (x instanceof ArrayBuffer || ArrayBuffer.isView(x))) &&
      ("lower" in x || "upper" in x);
  }

  function inRange(key, r) {
    if (!r) return true;
    if (r.lower !== undefined && r.lower !== null) {
      var c = cmpKey(key, r.lower);
      if (c < 0 || (c === 0 && r.lowerOpen)) return false;
    }
    if (r.upper !== undefined && r.upper !== null) {
      var d = cmpKey(key, r.upper);
      if (d > 0 || (d === 0 && r.upperOpen)) return false;
    }
    return true;
  }

  // Key ranges that work in both backends: a real IDBKeyRange when the platform has one,
  // otherwise a plain {lower, upper, lowerOpen, upperOpen} the memory backend understands.
  function makeRange(lower, upper, lowerOpen, upperOpen) {
    if (typeof root.IDBKeyRange !== "undefined" && root.IDBKeyRange) {
      try {
        if (lower !== undefined && upper !== undefined) return root.IDBKeyRange.bound(lower, upper, !!lowerOpen, !!upperOpen);
        if (lower !== undefined) return root.IDBKeyRange.lowerBound(lower, !!lowerOpen);
        if (upper !== undefined) return root.IDBKeyRange.upperBound(upper, !!upperOpen);
      } catch (e) { /* fall through to the plain object */ }
    }
    return { lower: lower, upper: upper, lowerOpen: !!lowerOpen, upperOpen: !!upperOpen };
  }
  var range = {
    bound: function (lower, upper, lowerOpen, upperOpen) { return makeRange(lower, upper, lowerOpen, upperOpen); },
    lowerBound: function (lower, open) { return makeRange(lower, undefined, open, false); },
    upperBound: function (upper, open) { return makeRange(undefined, upper, false, open); },
    only: function (value) { return makeRange(value, value, false, false); }
  };

  function chunkRange(docId) { return range.bound([docId, 0], [docId, Infinity]); }

  function schedulerVersion() {
    var s = tryDep("scheduler");
    return (s && typeof s.SCHEDULER_VERSION === "number") ? s.SCHEDULER_VERSION : 1;
  }
  function defaultLookahead() {
    var s = tryDep("scheduler");
    return (s && typeof s.LOOKAHEAD === "number") ? s.LOOKAHEAD : LOOKAHEAD_FALLBACK;
  }

  /* ------------------------------------------------------------------ memory backend */

  var memory = (function () {
    var stores = null;   // name → { keyPath, indexes: {name: keyPath}, rows: Map<canon, {key, value}> }

    function fakeSchema(target) {
      function storeHandle(s) {
        return {
          createIndex: function (name, keyPath) { s.indexes[name] = keyPath; return { name: name, keyPath: keyPath }; },
          deleteIndex: function (name) { delete s.indexes[name]; },
          get indexNames() { return Object.keys(s.indexes); }
        };
      }
      var db = {
        objectStoreNames: {
          contains: function (n) { return Object.prototype.hasOwnProperty.call(target, n); },
          get length() { return Object.keys(target).length; }
        },
        createObjectStore: function (name, opts) {
          var s = { keyPath: opts && opts.keyPath !== undefined ? opts.keyPath : "id", indexes: {}, rows: new Map() };
          target[name] = s;
          return storeHandle(s);
        },
        deleteObjectStore: function (name) { delete target[name]; }
      };
      var tx = {
        objectStore: function (name) {
          if (!target[name]) throw err("no_store", "Unknown store " + name);
          return storeHandle(target[name]);
        },
        abort: function () {}
      };
      return { db: db, tx: tx };
    }

    function getStore(name) {
      if (!stores) throw err("not_open", "Store is not open");
      var s = stores[name];
      if (!s) throw err("no_store", "Unknown store " + name);
      return s;
    }

    function putSync(name, value) {
      var s = getStore(name);
      var key = extractKey(value, s.keyPath);
      if (key === undefined) throw err("data", "Record has no valid key for store " + name);
      s.rows.set(canon(key), { key: key, value: clone(value) });
      return key;
    }

    function getSync(name, key) {
      var s = getStore(name);
      if (!validKey(key)) throw err("data", "Invalid key");
      var row = s.rows.get(canon(key));
      return row ? clone(row.value) : undefined;
    }

    function delSync(name, keyOrRange) {
      var s = getStore(name);
      if (isRange(keyOrRange)) {
        var doomed = [];
        s.rows.forEach(function (row, ck) { if (inRange(row.key, keyOrRange)) doomed.push(ck); });
        doomed.forEach(function (ck) { s.rows.delete(ck); });
        return undefined;
      }
      if (!validKey(keyOrRange)) throw err("data", "Invalid key");
      s.rows.delete(canon(keyOrRange));
      return undefined;
    }

    function getAllSync(name, opts) {
      opts = opts || {};
      var s = getStore(name), items = [];
      if (opts.index) {
        var keyPath = s.indexes[opts.index];
        if (keyPath === undefined) throw err("no_index", "Unknown index " + opts.index + " on " + name);
        s.rows.forEach(function (row) {
          var ik = extractKey(row.value, keyPath);
          if (ik === undefined) return;                 // records without the indexed key are not in the index
          if (!inRange(ik, opts.range)) return;
          items.push({ k: ik, pk: row.key, v: row.value });
        });
      } else {
        s.rows.forEach(function (row) {
          if (!inRange(row.key, opts.range)) return;
          items.push({ k: row.key, pk: row.key, v: row.value });
        });
      }
      items.sort(function (a, b) { return cmpKey(a.k, b.k) || cmpKey(a.pk, b.pk); });
      if (typeof opts.count === "number" && opts.count >= 0) items = items.slice(0, opts.count);
      return items.map(function (it) { return opts.keys ? it.pk : clone(it.v); });
    }

    function wrapper(name) {
      return {
        get: function (key) { return promised(function () { return getSync(name, key); }); },
        put: function (value) { return promised(function () { return putSync(name, value); }); },
        del: function (keyOrRange) { return promised(function () { return delSync(name, keyOrRange); }); },
        getAll: function (opts) { return promised(function () { return getAllSync(name, opts); }); }
      };
    }

    function promised(fn) {
      return new Promise(function (resolve, reject) {
        try { resolve(fn()); } catch (e) { reject(e); }
      });
    }

    var impl = {
      name: "memory",
      open: function (version, migrations) {
        if (stores) return Promise.resolve({ mode: "memory" });
        return promised(function () {
          var target = {};
          var fake = fakeSchema(target);
          var v = 1, to = version || DB_VERSION;
          for (; v <= to; v++) {
            if (migrations && typeof migrations[v] === "function") migrations[v](fake.db, fake.tx);
          }
          stores = target;
          return { mode: "memory" };
        });
      },
      get: function (store, key) { return promised(function () { return getSync(store, key); }); },
      put: function (store, value) { return promised(function () { return putSync(store, value); }); },
      del: function (store, keyOrRange) { return promised(function () { return delSync(store, keyOrRange); }); },
      getAll: function (store, opts) { return promised(function () { return getAllSync(store, opts); }); },
      tx: function (storeNames, mode, fn) {
        var names = Array.isArray(storeNames) ? storeNames : [storeNames];
        var snapshots;
        return promised(function () {
          snapshots = names.map(function (n) { var s = getStore(n); return { s: s, rows: new Map(s.rows) }; });
          return names.map(wrapper);
        }).then(function (wrappers) {
          return fn.apply(null, wrappers);
        }).catch(function (e) {
          if (snapshots) snapshots.forEach(function (snap) { snap.s.rows = snap.rows; });   // atomic: roll back
          throw e;
        });
      },
      estimate: function () {
        var usage = 0;
        if (stores) {
          Object.keys(stores).forEach(function (n) {
            stores[n].rows.forEach(function (row) {
              var b = row.value && row.value.bytes;
              if (b && typeof b.byteLength === "number") usage += b.byteLength;
              else usage += 256;
            });
          });
        }
        return Promise.resolve({ usage: usage, quota: null, persisted: false });
      },
      persist: function () { return Promise.resolve(false); },
      close: function () { return Promise.resolve(); },
      clear: function () { stores = null; }          // tests and "forget everything" flows
    };
    return impl;
  })();

  /* ------------------------------------------------------------------ IndexedDB backend */

  var idb = (function () {
    var conn = null, opening = null, stale = false, generation = 0;
    var version = DB_VERSION, migrations = MIGRATIONS;

    function factory() {
      try { return root.indexedDB || null; } catch (e) { return null; }   // sandboxed frames may throw on access
    }

    function wire(db) {
      db.onversionchange = function () {
        stale = true;
        try { db.close(); } catch (e) { /* ignore */ }
        if (conn === db) conn = null;
        notify("idb", "versionchange", MSG_VERSIONCHANGE);
      };
      db.onclose = function () {                       // Safari drops connections; the next call reopens
        if (conn === db) { conn = null; generation++; }
      };
      db.onerror = function () { /* request errors are handled per request */ };
    }

    function connect() {
      if (conn) return Promise.resolve(conn);
      if (stale) return Promise.reject(err("closed", MSG_VERSIONCHANGE));
      if (opening) return opening;
      opening = new Promise(function (resolve, reject) {
        var f = factory();
        if (!f) { reject(err("no_indexeddb", "IndexedDB is not available")); return; }
        var req, upgradeError = null;
        try { req = f.open(DB_NAME, version); } catch (e) { reject(e); return; }
        req.onupgradeneeded = function (ev) {
          var db = req.result, tx = req.transaction;
          var from = ev.oldVersion || 0;
          try {
            for (var v = from + 1; v <= version; v++) {
              if (migrations && typeof migrations[v] === "function") migrations[v](db, tx);
            }
          } catch (e) {
            upgradeError = e;
            try { tx.abort(); } catch (e2) { /* ignore */ }
          }
        };
        req.onblocked = function () { notify("idb", "blocked", MSG_BLOCKED); };
        req.onsuccess = function () {
          var db = req.result;
          wire(db);
          conn = db;
          resolve(db);
        };
        req.onerror = function () { reject(upgradeError || req.error || err("open_failed", "Could not open the database")); };
      });
      var clear = function () { opening = null; };
      opening.then(clear, clear);
      return opening;
    }

    function attempt(db, fn) {
      return new Promise(function (resolve, reject) {
        try { resolve(fn(db)); } catch (e) { reject(e); }
      });
    }

    // Runs fn(db); when the connection was dropped (onclose) or is otherwise unusable, reopens and retries once.
    function withDb(fn) {
      var gen = generation;
      return connect().then(function (db) { return attempt(db, fn); }).catch(function (e) {
        if (stale) throw e;
        var dropped = generation !== gen || conn === null;
        var name = e && e.name;
        if (dropped || name === "InvalidStateError") {
          conn = null;
          return connect().then(function (db) { return attempt(db, fn); });
        }
        throw e;
      });
    }

    function reqDone(req) {
      return new Promise(function (resolve, reject) {
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || err("request_failed", "Request failed")); };
      });
    }

    function getAllReq(src, opts) {
      opts = opts || {};
      var target = opts.index ? src.index(opts.index) : src;
      var q = (opts.range === undefined || opts.range === null) ? undefined : opts.range;
      var hasCount = typeof opts.count === "number";
      if (opts.keys) return hasCount ? target.getAllKeys(q, opts.count) : (q ? target.getAllKeys(q) : target.getAllKeys());
      return hasCount ? target.getAll(q, opts.count) : (q ? target.getAll(q) : target.getAll());
    }

    function single(store, mode, make) {
      return withDb(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(store, mode);
          var req = make(t.objectStore(store));
          var result, failed = false;
          req.onsuccess = function () { result = req.result; if (mode === "readonly") resolve(result); };
          req.onerror = function () { failed = true; reject(req.error || err("request_failed", "Request failed")); };
          t.oncomplete = function () { if (!failed) resolve(result); };
          t.onabort = function () { reject(t.error || err("aborted", "Transaction aborted")); };
          t.onerror = function () { /* handled by onabort */ };
        });
      });
    }

    function storeWrapper(os) {
      return {
        get: function (key) { return reqDone(os.get(key)); },
        put: function (value) { return reqDone(os.put(value)); },
        del: function (keyOrRange) { return reqDone(os.delete(keyOrRange)); },
        getAll: function (opts) { return reqDone(getAllReq(os, opts)); }
      };
    }

    var impl = {
      name: "idb",
      open: function (v, m) {
        if (typeof v === "number") version = v;
        if (m) migrations = m;
        return connect().then(function () { return { mode: "idb" }; });
      },
      get: function (store, key) { return single(store, "readonly", function (os) { return os.get(key); }); },
      put: function (store, value) { return single(store, "readwrite", function (os) { return os.put(value); }); },
      del: function (store, keyOrRange) { return single(store, "readwrite", function (os) { return os.delete(keyOrRange); }); },
      getAll: function (store, opts) { return single(store, "readonly", function (os) { return getAllReq(os, opts); }); },
      tx: function (storeNames, mode, fn) {
        var names = Array.isArray(storeNames) ? storeNames : [storeNames];
        return withDb(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction(names, mode || "readonly");
            var wrappers = names.map(function (n) { return storeWrapper(t.objectStore(n)); });
            var fnErr = null;
            var p = Promise.resolve().then(function () { return fn.apply(null, wrappers); });
            p.then(null, function (e) { fnErr = e; try { t.abort(); } catch (e2) { /* already aborting */ } });
            t.oncomplete = function () { p.then(resolve, reject); };
            t.onabort = function () { reject(fnErr || t.error || err("aborted", "Transaction aborted")); };
            t.onerror = function () { /* the abort handler reports it */ };
          });
        });
      },
      estimate: function () {
        var st = root.navigator && root.navigator.storage;
        var none = { usage: null, quota: null, persisted: null };
        if (!st || typeof st.estimate !== "function") return Promise.resolve(none);
        return Promise.resolve().then(function () { return st.estimate(); }).then(function (e) {
          var persisted = typeof st.persisted === "function"
            ? Promise.resolve().then(function () { return st.persisted(); }).catch(function () { return null; })
            : Promise.resolve(null);
          return persisted.then(function (p) {
            return {
              usage: e && typeof e.usage === "number" ? e.usage : null,
              quota: e && typeof e.quota === "number" ? e.quota : null,
              persisted: p
            };
          });
        }).catch(function () { return none; });
      },
      persist: function () {
        var st = root.navigator && root.navigator.storage;
        if (!st || typeof st.persist !== "function") return Promise.resolve(false);
        return Promise.resolve().then(function () { return st.persist(); }).then(function (ok) { return !!ok; }).catch(function () { return false; });
      },
      close: function () {
        var db = conn;
        conn = null;
        if (db) { try { db.close(); } catch (e) { /* ignore */ } }
        return Promise.resolve();
      },
      isStale: function () { return stale; }
    };
    return impl;
  })();

  /* ------------------------------------------------------------------ facade + open() */

  var active = null, mode = null, openPromise = null;

  function openStore(version, migrations) {
    if (openPromise) return openPromise;
    var v = typeof version === "number" ? version : DB_VERSION;
    var m = migrations || MIGRATIONS;
    openPromise = Promise.resolve().then(function () {
      var hasIdb = false;
      try { hasIdb = !!root.indexedDB; } catch (e) { hasIdb = false; }
      if (!hasIdb) return fallback(null, v, m);
      return idb.open(v, m).then(function () {
        active = idb; mode = "idb";
        notify("idb", null, null);
      }, function (e) { return fallback(e, v, m); });
    }).then(function () {
      return dataMigrate(active);
    }).then(function () {
      // handover mode: this page is a reader until acquire(); else the announcement, before M.cache.load, so that
      // older tabs stop writing first
      if (mode === "idb") { if (!startHandover()) announce(); }
      return { mode: mode };
    });
    openPromise.then(null, function () { openPromise = null; });
    return openPromise;
  }

  function fallback(cause, v, m) {
    return memory.open(v, m).then(function () {
      active = memory; mode = "memory";
      var reason = cause === null ? "no_indexeddb" : ((cause && (cause.name || cause.code)) || "error");
      notify("memory", reason, MSG_UNAVAILABLE);
    });
  }

  function current() { return active ? Promise.resolve(active) : openStore().then(function () { return active; }); }

  // Raw meta access against a given backend implementation (used during open, before the facade is usable).
  function rawMetaGet(b, key) { return b.get("meta", key).then(function (row) { return row ? row.value : undefined; }); }
  function rawMetaSet(b, key, value) { return b.put("meta", { key: key, value: value }).then(function () { return value; }); }

  function dataMigrate(b) {
    return rawMetaGet(b, "dataVersion").then(function (dv) {
      if (typeof dv !== "number") return rawMetaSet(b, "dataVersion", DATA_VERSION);   // fresh database
      var chain = Promise.resolve();
      for (var v = dv + 1; v <= DATA_VERSION; v++) {
        (function (ver) {
          chain = chain.then(function () {
            var fn = DATA_MIGRATIONS[ver];
            return typeof fn === "function" ? fn(api) : undefined;
          }).then(function () { return rawMetaSet(b, "dataVersion", ver); });
        })(v);
      }
      return chain;
    }).then(function () {
      return rawMetaGet(b, "schedulerVersion");
    }).then(function (sv) {
      if (typeof sv !== "number") return rawMetaSet(b, "schedulerVersion", schedulerVersion());
    });
  }

  /* ------------------------------------------------------------------ one writing tab per origin (see header) */

  var lockInfo = null;          // {reason, by, at} once a newer tab took over: this tab writes nothing more
  var tab = null;               // {id, at}: this tab's announcement (idb mode only; made once per page)
  var tabChannel = null;
  var tabsBound = false;
  var channelFactory = defaultChannel;   // name → BroadcastChannel-like object | null (test hook _setTabChannel)

  function lockedError() { return err("locked", lockInfo && lockInfo.reason === "window" ? MSG_OTHER_WINDOW : MSG_OTHER_TAB); }

  // Stops every write from now on (idempotent: the first lock stays) and tells M.app through store:mode.
  function lock(info) {
    if (lockInfo) return Object.assign({}, lockInfo);
    var i = info && typeof info === "object" ? info : {};
    lockInfo = {
      reason: typeof i.reason === "string" && i.reason ? i.reason : "othertab",
      by: i.by == null ? null : String(i.by),
      at: typeof i.at === "number" && isFinite(i.at) ? i.at : Date.now()
    };
    emit("store:mode", { mode: mode || "idb", reason: lockInfo.reason, message: MSG_OTHER_TAB, by: lockInfo.by });
    return Object.assign({}, lockInfo);
  }

  function locked() { return lockInfo ? Object.assign({}, lockInfo) : null; }

  function defaultChannel(name) {
    var BC = null;
    try { BC = root.BroadcastChannel; } catch (e) { BC = null; }
    if (typeof BC !== "function") return null;
    try {
      var ch = new BC(name);
      if (ch && typeof ch.unref === "function") ch.unref();    // node: an open channel never keeps a process alive
      return ch;
    } catch (e) { return null; }
  }

  function localStore() {
    try { var ls = root.localStorage; return ls && typeof ls.getItem === "function" ? ls : null; } catch (e) { return null; }
  }

  function parseTab(v) {
    if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { return null; } }
    if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id || v.id.length > 200) return null;
    if (typeof v.at !== "number" || !isFinite(v.at)) return null;
    return { id: v.id, at: v.at };
  }

  function readTabKey() {
    var ls = localStore();
    if (!ls) return null;
    try { return parseTab(ls.getItem(TAB_KEY)); } catch (e) { return null; }
  }

  // a announced after b: later time, then the larger id (two tabs never tie)
  function newer(a, b) { return a.at > b.at || (a.at === b.at && a.id > b.id); }

  function broadcast(t) {
    if (tabChannel) { try { tabChannel.postMessage({ type: "open", id: t.id, at: t.at }); } catch (e) { /* closed */ } }
    var ls = localStore();
    if (ls) { try { ls.setItem(TAB_KEY, JSON.stringify({ id: t.id, at: t.at })); } catch (e) { /* full or blocked */ } }
  }

  // Another tab announced itself. A later one takes over; an earlier one (a tie, a skewed clock) is told again
  // that this tab is the newer, so exactly one of the two keeps writing. A tab that has not announced yet waits
  // for its own announcement, which comes later and wins.
  function heard(other) {
    var o = parseTab(other);
    if (!o || !tab || lockInfo || o.id === tab.id) return false;
    if (newer(o, tab)) { lock({ reason: "othertab", by: o.id }); return true; }
    broadcast(tab);
    return false;
  }

  // The key names a newer tab than this one: a message this tab missed (frozen, back-forward cache).
  function checkTabs() {
    if (!tab || lockInfo) return !!lockInfo;
    var o = readTabKey();
    if (o && o.id !== tab.id && newer(o, tab)) lock({ reason: "othertab", by: o.id });
    return !!lockInfo;
  }

  function bindTabs() {
    if (tabsBound) return;
    tabsBound = true;
    try { tabChannel = typeof channelFactory === "function" ? channelFactory(TAB_CHANNEL) : null; } catch (e) { tabChannel = null; }
    if (tabChannel) {
      var onMessage = function (ev) { var d = ev && ev.data; if (d && d.type === "open") heard(d); };
      try {
        if (typeof tabChannel.addEventListener === "function") tabChannel.addEventListener("message", onMessage);
        else tabChannel.onmessage = onMessage;
      } catch (e) { /* no messages: the storage event still works */ }
    }
    try {
      if (typeof root.addEventListener === "function") {
        root.addEventListener("storage", function (ev) { if (ev && ev.key === TAB_KEY && ev.newValue) heard(ev.newValue); });
        root.addEventListener("pageshow", function (ev) { if (ev && ev.persisted) checkTabs(); });
      }
      var doc = root.document;
      if (doc && typeof doc.addEventListener === "function") {
        doc.addEventListener("visibilitychange", function () { if (doc.visibilityState === "visible") checkTabs(); });
      }
    } catch (e) { /* no window events: the channel still works */ }
  }

  function announce() {
    if (tab) return tab;
    var u = tryDep("util"), id = null;
    try { id = u && typeof u.uuid === "function" ? u.uuid("tab_") : null; } catch (e) { id = null; }
    if (!id) id = "tab_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 12);
    var at = Date.now(), last = readTabKey();
    if (last && last.at >= at) at = last.at + 1;     // strictly after the last announcement this origin saw
    tab = { id: id, at: at };
    bindTabs();
    broadcast(tab);
    return tab;
  }

  /* ------------------------------------------------------------------ handover between the app's windows (see header) */

  var ho = {
    wanted: false,     // handover(true) was asked before open()
    on: false,         // handover mode is in force (idb mode, navigator.locks)
    id: null,          // this page's id
    writer: false,     // this page holds the role and has read the library
    acquiring: null,   // the promise of an acquire() under way
    abort: null,       // ends that acquire() without the role (a later ask of another page came)
    release: null,     // lets the Web Lock go (while this page holds it)
    mine: 0,           // the number of this page's last ask
    clock: 0,          // the highest ask number this page has seen
    pending: 0,        // writes under way, and work that keeps the role (during())
    waiters: [],       // idle() callbacks
    wantedAt: 0,       // when this page was last asked for the role while work kept it (during()); 0: not asked
    keeping: 0,        // how much such work is under way
    wantTimer: null,
    bound: false
  };

  function lockManager() {
    try {
      var nav = root.navigator, l = nav && nav.locks;
      return l && typeof l.request === "function" ? l : null;
    } catch (e) { return null; }
  }

  function readerInfo() { return { reason: "window", by: null, at: Date.now() }; }

  // M.app asks for handover mode before open(); → whether it is (or will be) in force.
  function handover(on) {
    if (on === undefined) return ho.on;
    if (!openPromise) ho.wanted = on === true && !!lockManager();
    return ho.on || ho.wanted;
  }

  // open(): the page starts as a reader. → false when the legacy rule applies instead.
  function startHandover() {
    if (!ho.wanted || !lockManager()) return false;
    ho.on = true;
    var u = tryDep("util");
    try { ho.id = u && typeof u.uuid === "function" ? u.uuid("win_") : null; } catch (e) { ho.id = null; }
    if (!ho.id) ho.id = "win_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 12);
    lockInfo = readerInfo();
    bindHandover();
    return true;
  }

  function bindHandover() {
    if (ho.bound) return;
    ho.bound = true;
    try { tabChannel = typeof channelFactory === "function" ? channelFactory(TAB_CHANNEL) : null; } catch (e) { tabChannel = null; }
    if (!tabChannel) return;
    var onMessage = function (ev) {
      var d = ev && ev.data;
      if (!d || d.id === ho.id) return;
      if (d.type === "want") onWanted(d);
      else if (d.type === "held") onHeld(d);
    };
    try {
      if (typeof tabChannel.addEventListener === "function") tabChannel.addEventListener("message", onMessage);
      else tabChannel.onmessage = onMessage;
    } catch (e) { /* no messages: this page keeps the role until it dies */ }
  }

  function say(type, at) {
    if (tabChannel) { try { tabChannel.postMessage({ type: type, id: ho.id, at: at }); } catch (e) { /* closed */ } }
  }
  function sayWant() { say("want", ho.mine); }
  function askNumber(d) { return d && typeof d.at === "number" && isFinite(d.at) ? d.at : 0; }

  // Another page asks for the role. Every ask has a number, above every number its page has seen, and of two asks
  // the one with the higher number wins (the page's id decides between equal numbers), whatever the order in which
  // the browser gives the lock. So only an ask that is LATER than this page's own counts here: the writer then stops
  // writing at once and lets the lock go when its writes under way have ended; a page that still waits for the role
  // ends its ask (the lock, when it comes, goes on at once). An earlier ask is ignored: its page hears this page's
  // ask and yields in turn. A writer that ignores an ask says which number it holds ("held"): the page that asked
  // may not know it (it started later, or its clock stands behind), and asks again with a later one (onHeld).
  function onWanted(d) {
    var at = askNumber(d);
    if (at > ho.clock) ho.clock = at;
    if (!(at > ho.mine || (at === ho.mine && String(d.id) > ho.id))) {
      if (ho.writer) say("held", ho.mine);
      return;
    }
    if (ho.writer) giveUp();
    else if (ho.abort) ho.abort();
  }

  // The writer holds a number that this page's ask does not beat: the ask goes out again with a later one.
  function onHeld(d) {
    var at = askNumber(d);
    if (at > ho.clock) ho.clock = at;
    if (!ho.acquiring || at < ho.mine) return;
    ho.mine = ho.clock = at + 1;
    sayWant();
  }

  // The writer lets the role go: no new write from now on, and the lock is free once the writes under way have
  // ended. Work that keeps the role (during(): an import, a PDF being added) ends first; until then this page
  // stays the writer, and the page that asked waits (it says its ask again every WANT_EVERY_MS).
  function giveUp() {
    if (!ho.writer) return;
    if (ho.keeping > 0) { ho.wantedAt = Date.now(); return; }
    ho.wantedAt = 0;
    ho.writer = false;
    lockInfo = readerInfo();
    emit("store:writer", { writer: false });
    idle().then(function () {
      var release = ho.release;
      ho.release = null;
      if (release) release();
    });
  }

  // Work of several writes that must not lose the role half way (an import, a PDF that is added, PDFs that come
  // back from the backup folder): while its promise is pending this page keeps the role, also when another page
  // asks (that page waits). → the same promise. A page that is no writer when the work begins gets no such
  // promise: its writes are refused as always. When the work has ended, the role goes to a page that asked for it
  // within the last WANT_FRESH_MS; a page that asked earlier and is gone (its window was closed) gets nothing, and
  // one that still waits says its ask again within that time.
  function during(work) {
    var p;
    try { p = Promise.resolve(typeof work === "function" ? work() : work); } catch (e) { p = Promise.reject(e); }
    if (!ho.on) return p;
    ho.keeping++;
    var done = function () {
      ho.keeping--;
      if (ho.keeping || !ho.wantedAt) return;
      var fresh = Date.now() - ho.wantedAt <= WANT_FRESH_MS;
      ho.wantedAt = 0;
      if (fresh) giveUp();
    };
    p.then(done, done);
    return p;
  }

  // Resolves when no write of this page is under way.
  function idle() {
    if (!ho.pending) return Promise.resolve();
    return new Promise(function (resolve) { ho.waiters.push(resolve); });
  }

  // Counts a write from its start to its end (commit, abort or refusal), for idle().
  function tracked(promise) {
    ho.pending++;
    var done = function () {
      ho.pending--;
      if (!ho.pending && ho.waiters.length) { var w = ho.waiters; ho.waiters = []; w.forEach(function (fn) { fn(); }); }
    };
    return Promise.resolve(promise).then(function (v) { done(); return v; }, function (e) { done(); throw e; });
  }

  // Makes this page the writer. sync(changed) → Promise|void runs while the lock is held and before any write is
  // allowed. `changed` is always true: a page that takes the role was not the writer just before, so another page
  // may have written, and what this page read of the library may be old (M.app reads it again). No record outside
  // the lock says otherwise: localStorage is not in step between the pages of one origin at every moment.
  // → Promise<boolean>: true when this page is the writer now; false when a later ask of another page ended this
  // one (the page stays a reader and may ask again). It rejects with code "sync" (err.cause) when sync failed: the
  // page stays a reader and the role is free. Legacy mode: true unless a newer tab took over.
  function acquire(sync) {
    if (!ho.on) return Promise.resolve(!lockInfo);
    if (ho.writer) return Promise.resolve(true);
    if (ho.acquiring) return ho.acquiring;
    var locks = lockManager();
    if (!locks) return Promise.resolve(false);
    ho.mine = ho.clock = Math.max(Date.now(), ho.clock + 1);
    var settled = false, answer = null, refuse = null;
    var settle = function (ok, failure) {
      if (settled) return;
      settled = true;
      if (ho.wantTimer) { try { clearInterval(ho.wantTimer); } catch (e) { /* gone */ } ho.wantTimer = null; }
      ho.acquiring = null;
      ho.abort = null;
      if (failure) refuse(failure); else answer(ok);
    };
    ho.acquiring = new Promise(function (resolve, reject) { answer = resolve; refuse = reject; });
    var promise = ho.acquiring;
    ho.abort = function () { settle(false); };              // before the lock has come: when it comes, it goes on at once
    var request;
    try {
      request = locks.request(WRITER_LOCK, function () {
        if (settled) return undefined;                      // this ask ended meanwhile: the lock goes on at once
        return new Promise(function (free) {                // the lock is this page's until free()
          // A later ask of another page while this page still reads: this ask ends and the lock goes on AT ONCE (a
          // read that hangs must not hold the role back from every window). The read may go on; this page reads
          // again when it next takes the role.
          ho.abort = function () { settle(false); free(); };
          Promise.resolve().then(function () {
            return typeof sync === "function" ? sync(true) : undefined;
          }).then(function () {
            if (settled) return;                            // a later ask came while this page read
            ho.writer = true;                               // from here on only this page writes
            lockInfo = null;
            ho.release = free;
            emit("store:writer", { writer: true });
            settle(true);
          }).then(null, function (e) {
            try { console.error("[store] could not take the writer role:", e); } catch (e2) { /* no console */ }
            var failure = err("sync", "The library could not be read again");
            failure.cause = e;
            if (ho.writer && ho.release === free) { ho.writer = false; lockInfo = readerInfo(); ho.release = null; }
            settle(false, failure);
            free();
          });
        });
      });
    } catch (e) { settle(false); return promise; }
    Promise.resolve(request).then(null, function () { settle(false); });
    sayWant();
    try {
      ho.wantTimer = setInterval(function () { if (!settled) sayWant(); }, WANT_EVERY_MS);
      if (ho.wantTimer && typeof ho.wantTimer.unref === "function") ho.wantTimer.unref();
    } catch (e3) { ho.wantTimer = null; }
    return promise;
  }

  // A Web Lock "marginalia.<name>" taken only when it is free: fn(true) holds it until the promise fn gives back
  // has ended; fn(false) when another page holds it. Without handover mode there is one page: fn(true).
  function exclusive(name, fn) {
    var run = function (got) { return Promise.resolve().then(function () { return fn(got); }); };
    var locks = ho.on ? lockManager() : null;
    if (!locks) return run(true);
    try { return Promise.resolve(locks.request(LOCK_PREFIX + String(name), { ifAvailable: true }, function (lock) { return run(!!lock); })); }
    catch (e) { return run(true); }
  }

  // Holds the Web Lock "marginalia.<name>" for this page's whole life (it goes free when the page dies): how the
  // pages of the app tell which of them are there. → true when asked for. Not in legacy mode.
  function hold(name) {
    var locks = ho.on ? lockManager() : null;
    if (!locks) return false;
    try { Promise.resolve(locks.request(LOCK_PREFIX + String(name), function () { return new Promise(function () {}); })).then(null, function () {}); return true; }
    catch (e) { return false; }
  }

  // The names (without the prefix) of the app's Web Locks that some page holds now. → Promise<string[]|null> (null:
  // not known: legacy mode, or the browser cannot say).
  function held() {
    var locks = ho.on ? lockManager() : null;
    if (!locks || typeof locks.query !== "function") return Promise.resolve(null);
    try {
      return Promise.resolve(locks.query()).then(function (q) {
        return ((q && q.held) || []).map(function (l) { return String(l && l.name); })
          .filter(function (n) { return n.indexOf(LOCK_PREFIX) === 0; }).map(function (n) { return n.slice(LOCK_PREFIX.length); });
      }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  // A store object handed to a readwrite transaction's callback: its writes check the lock first, so a
  // transaction that was already running when this tab stepped aside aborts (all of it) at its next write.
  function guardStore(s) {
    return {
      get: function (key) { return s.get(key); },
      getAll: function (opts) { return s.getAll(opts); },
      put: function (value) { return lockInfo ? Promise.reject(lockedError()) : s.put(value); },
      del: function (keyOrRange) { return lockInfo ? Promise.reject(lockedError()) : s.del(keyOrRange); }
    };
  }

  // The seven calls, routed to the active implementation (opening the database on first use). Writes check
  // the lock when they reach the backend, so a save queued before the lock but issued after it is refused too.
  var backend = {
    open: function (version, migrations) { return openStore(version, migrations); },
    get: function (store, key) { return current().then(function (b) { return b.get(store, key); }); },
    put: function (store, value) {
      return current().then(function (b) { if (lockInfo) throw lockedError(); return tracked(b.put(store, value)); });
    },
    del: function (store, keyOrRange) {
      return current().then(function (b) { if (lockInfo) throw lockedError(); return tracked(b.del(store, keyOrRange)); });
    },
    getAll: function (store, opts) { return current().then(function (b) { return b.getAll(store, opts); }); },
    tx: function (stores, txMode, fn) {
      return current().then(function (b) {
        if (txMode === "readonly") return b.tx(stores, txMode, fn);
        if (lockInfo) throw lockedError();
        // Legacy rule: a transaction that runs when this tab steps aside aborts at its next write (guardStore).
        // Handover mode: a transaction that began while this page was the writer ends as it began (a large PDF
        // goes in whole); the role goes on only after it (idle()).
        var guard = ho.on ? function (s) { return s; } : guardStore;
        return tracked(b.tx(stores, txMode, function () {
          return fn.apply(null, Array.prototype.map.call(arguments, guard));
        }));
      });
    },
    estimate: function () { return current().then(function (b) { return b.estimate(); }); }
  };

  var KEY_PATHS = { collections: "id", chunks: ["docId", "i"], prompts: "id", attachments: "id", meta: "key" };

  // Walks a store in batches of `size` records (primary-key order): fn(records) → Promise|void, for data migrations.
  function eachBatch(store, size, fn) {
    var n = typeof size === "number" && size > 0 ? size : BATCH_SIZE;
    var keyPath = KEY_PATHS[store] || "id";
    return current().then(function (b) {
      function step(after) {
        var opts = { count: n };
        if (after !== undefined) opts.range = range.lowerBound(after, true);
        return b.getAll(store, opts).then(function (rows) {
          if (!rows || !rows.length) return undefined;
          return Promise.resolve(fn(rows)).then(function () {
            if (rows.length < n) return undefined;
            var last = extractKey(rows[rows.length - 1], keyPath);
            return last === undefined ? undefined : step(last);
          });
        });
      }
      return step(undefined);
    });
  }

  /* ------------------------------------------------------------------ typed helpers */

  var collections = {
    put: function (c) { return backend.put("collections", c).then(function () { return c; }); },
    get: function (id) { return backend.get("collections", id).then(function (v) { return v === undefined ? null : v; }); },
    all: function () { return backend.getAll("collections"); }
  };

  var prompts = {
    put: function (p) { return backend.put("prompts", p).then(function () { return p; }); },
    putMany: function (ps) {
      var list = Array.isArray(ps) ? ps : [];
      if (!list.length) return Promise.resolve(list);
      return backend.tx(["prompts"], "readwrite", function (s) {
        return Promise.all(list.map(function (p) { return s.put(p); }));
      }).then(function () { return list; });
    },
    get: function (id) { return backend.get("prompts", id).then(function (v) { return v === undefined ? null : v; }); },
    byCollection: function (collectionId) {
      return backend.getAll("prompts", { index: "byCollection", range: range.only(collectionId) });
    },
    // Prompts whose dueAt <= now + lookahead (byDue index; notes, highlights and tombstones have no dueAt).
    // `lookahead` defaults to M.scheduler.LOOKAHEAD (16 h).
    due: function (now, lookahead) {
      var t = typeof now === "number" ? now : Date.now();
      var la = typeof lookahead === "number" ? lookahead : defaultLookahead();
      return backend.getAll("prompts", { index: "byDue", range: range.upperBound(t + la) });
    },
    all: function () { return backend.getAll("prompts"); }
  };

  function isQuotaError(e) {
    if (!e) return false;
    if (e.name === "QuotaExceededError" || e.code === "quota") return true;
    return /quota/i.test(String(e.message || "")) && e.name !== "TypeError";
  }

  var docs = {
    // Metadata first, then 8 MiB chunks (bytes.slice() copies), all in ONE transaction.
    saveDocument: function (record, u8) {
      if (!record || typeof record !== "object" || !record.id) return Promise.reject(err("bad_record", "A document record needs an id"));
      if (!u8 || typeof u8.byteLength !== "number") return Promise.reject(err("bad_bytes", "Expected a Uint8Array"));
      if (u8.byteLength > MAX_DOC_BYTES) return Promise.reject(err("too_large", "This PDF is larger than 300 MB"));
      if (!(u8 instanceof Uint8Array)) {
        if (u8 instanceof ArrayBuffer) u8 = new Uint8Array(u8);
        else if (ArrayBuffer.isView(u8)) u8 = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
        else return Promise.reject(err("bad_bytes", "Expected a Uint8Array"));
      }
      var total = u8.byteLength;
      var chunkCount = Math.ceil(total / CHUNK_SIZE);
      var rec = Object.assign({}, record, { byteLength: total, chunkCount: chunkCount, chunkSize: CHUNK_SIZE, hasBytes: true });
      var bytes = u8;
      return backend.tx(["collections", "chunks"], "readwrite", function (cols, chunks) {
        return cols.put(rec).then(function () {
          return chunks.del(chunkRange(rec.id));          // a replaced file may have had more chunks
        }).then(function () {
          var i = 0;
          function next() {
            if (i >= chunkCount) return Promise.resolve();
            var start = i * CHUNK_SIZE, end = Math.min(total, start + CHUNK_SIZE);
            var slice = bytes.slice(start, end);           // a copy whose .buffer is exactly this chunk
            var row = { docId: rec.id, i: i, bytes: slice.buffer };
            i++;
            return chunks.put(row).then(next);
          }
          return next();
        });
      }).then(function () {
        return rec;
      }, function (e) {
        if (e && (e.code === "too_large" || e.code === "locked")) throw e;   // locked: a newer tab writes, no stub here
        if (isQuotaError(e)) throw err("quota", "Not enough storage space for this PDF", e);
        // Any other failure (e.g. Safari dropping the connection mid-write): the transaction aborted, so keep
        // the book listed without bytes so the library can offer "Choose file again" (§11).
        var stub = Object.assign({}, rec, { hasBytes: false, chunkCount: 0 });
        var fail = function () { throw err("store", "The PDF could not be stored", e); };
        return backend.put("collections", stub).then(fail, fail);
      });
    },
    loadBytes: function (docId) {
      return backend.getAll("chunks", { range: chunkRange(docId) }).then(function (rows) {
        if (!rows || !rows.length) return null;
        rows.sort(function (a, b) { return a.i - b.i; });
        var total = 0;
        for (var k = 0; k < rows.length; k++) {
          if (rows[k].i !== k || !rows[k].bytes) return null;   // a gap means a half-written document
          total += rows[k].bytes.byteLength;
        }
        var out = new Uint8Array(total), off = 0;
        rows.forEach(function (r) {
          var part = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
          out.set(part, off);
          off += part.byteLength;
        });
        return out;
      });
    },
    deleteBytes: function (docId) { return backend.del("chunks", chunkRange(docId)); }
  };

  var attachments = {
    put: function (a) { return backend.put("attachments", a).then(function () { return a; }); },
    get: function (id) { return backend.get("attachments", id).then(function (v) { return v === undefined ? null : v; }); },
    allIds: function () { return backend.getAll("attachments", { keys: true }); },
    remove: function (id) { return backend.del("attachments", id); }
  };

  var meta = {
    get: function (key) { return backend.get("meta", key).then(function (row) { return row ? row.value : undefined; }); },
    set: function (key, value) { return backend.put("meta", { key: key, value: value }).then(function () { return value; }); }
  };

  function estimate() {
    return backend.estimate().catch(function () { return { usage: null, quota: null, persisted: null }; });
  }

  function persist() {
    return current().then(function (b) { return b.persist(); }).then(function (ok) { return !!ok; }).catch(function () { return false; });
  }

  function close() {
    var b = active;
    active = null; mode = null; openPromise = null;
    return b ? b.close() : Promise.resolve();
  }

  var api = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    DATA_VERSION: DATA_VERSION,
    CHUNK_SIZE: CHUNK_SIZE,
    MAX_DOC_BYTES: MAX_DOC_BYTES,
    MIGRATIONS: MIGRATIONS,
    DATA_MIGRATIONS: DATA_MIGRATIONS,
    open: function () { return openStore(DB_VERSION, MIGRATIONS); },
    mode: function () { return mode; },
    backend: backend,
    backends: { idb: idb, memory: memory },
    range: range,
    cmpKey: cmpKey,
    eachBatch: eachBatch,
    collections: collections,
    prompts: prompts,
    docs: docs,
    attachments: attachments,
    meta: meta,
    estimate: estimate,
    persist: persist,
    close: close,
    // one writing tab per origin (see the header)
    lock: lock,
    locked: locked,
    tab: function () { return tab ? { id: tab.id, at: tab.at } : null; },
    checkTabs: checkTabs,
    TAB_CHANNEL: TAB_CHANNEL,
    TAB_KEY: TAB_KEY,
    // handover between the windows of the Mac app (see the header)
    handover: handover,
    acquire: acquire,
    writer: function () { return ho.on ? ho.writer : !lockInfo; },
    idle: idle,
    during: during,
    exclusive: exclusive,
    hold: hold,
    held: held,
    WRITER_LOCK: WRITER_LOCK,
    LOCK_PREFIX: LOCK_PREFIX,
    // test hook: the BroadcastChannel factory (name → channel | null) used when this tab announces itself
    _setTabChannel: function (fn) { channelFactory = typeof fn === "function" ? fn : null; }
  };

  M.store = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17 M.store): open() → Promise<{mode}> (idempotent); backend {open, get, put, del, getAll, tx, estimate};
 * MIGRATIONS; collections.{put, get, all}; prompts.{put, putMany, get, byCollection, due(now, lookahead?), all};
 * docs.{saveDocument(record, u8) one tx, rejects "quota"|"too_large"; loadBytes(docId) → Uint8Array|null; deleteBytes(docId)};
 * attachments.{put, get, allIds, remove}; meta.{get, set}; estimate(); persist().
 * Extras: mode(), backends.{idb, memory}, range, eachBatch, close(), DATA_MIGRATIONS, CHUNK_SIZE, MAX_DOC_BYTES;
 * getAll accepts {keys: true}; store:mode payload carries {mode, reason, message}.
 * One writing tab per origin: open() in idb mode announces this tab ({type: "open", id, at} on BroadcastChannel
 * TAB_CHANNEL "marginalia" + localStorage TAB_KEY "marginalia.tab"; storage event fallback; pageshow (persisted) and
 * visibilitychange re-read the key); a later announcement locks this tab: lock(info) → info, locked() → {reason, by,
 * at}|null; every backend put / del / non-readonly tx (and each write inside a running one) then rejects code
 * "locked"; reads keep working; store:mode {mode, reason: "othertab", message, by} is emitted once. tab() → {id, at}|null;
 * checkTabs() → boolean; test hook _setTabChannel(factory|null). The memory backend never announces or locks itself.
 * Handover (D31, BUILD-NOTES "Windows"): handover(true) before open() → boolean (needs navigator.locks; in force only
 * in idb mode: then no announcement, and the page starts as a reader, locked() → {reason: "window", by: null, at});
 * acquire(sync) → Promise<boolean> (Web Lock WRITER_LOCK "marginalia.writer"; {type: "want", id, at} on the channel,
 * again every 300 ms while it waits, `at` = the ask's number, above every number this page has seen; sync(true)
 * before the first write (always true: another page may have written); then locked() → null and store:writer
 * {writer: true}; it rejects with code "sync" when sync failed; legacy mode: true unless locked); a writer that
 * hears a LATER "want" (a higher number, then the higher id): locked() at once, store:writer {writer: false}, the
 * lock let go after idle(); a writer that hears a want that is not later answers {type: "held", id, at} with its
 * own number, and the page that asked asks again with a later one; a page that waits and hears a later "want" ends
 * its ask with false, also while its sync runs (the lock goes on at once); writer() → boolean; idle() → Promise (no put, del or readwrite tx of this
 * page under way; a transaction that began as the writer ends as it began); during(work) → the work's promise (while
 * it is pending the writer keeps the role, and a page that asks waits; when it ends, the role goes to a page that
 * asked within the last WANT_FRESH_MS 1500 ms);
 * exclusive(name, fn) → Promise (fn(true) holds the lock "marginalia.<name>" until its promise ends; fn(false) when
 * another page holds it; legacy mode: fn(true)); hold(name) → boolean (the lock for this page's life);
 * held() → Promise<string[]|null> (the names some page holds). */
