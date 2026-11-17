/* js/attachments.js — Marginalia image attachments (SPEC §15 "Attachments", §17).
 *
 * Pasted or dropped images become PNG attachment records in the store ({id, mime, bytes, width,
 * height, byteLength, createdAt}) referenced from prompt text as ![snip](att:<id>). url(id) hands
 * out one cached object URL per id (null until the bytes are loaded; "attachment:ready" {id} fires
 * when a URL becomes available so cards can re-render). GC is reference-counted across live prompts
 * and localStorage drafts; sweep() removes day-old attachments nothing references.
 * Paste / drop / Editor.insertAttachment go through attach(blob, editor): a placeholder token
 * ![snip](att:pending-<tag>-<n>) lands at the caret at once (the editor's Save waits for it) and is
 * swapped in place for the stored id when the image is decoded, or removed with a toast when it fails;
 * a placeholder counts as a reference to its attachment for url(), gc() and sweep(). A placeholder that
 * reached a localStorage draft heals there too: rewritten to the stored id (or dropped) when its image
 * settles, resolved after a reload through the placeholder ledger, and dropped by resolveText() and the
 * boot sweep once it can never resolve, so a dead token is never restored or saved.
 * DOM APIs (createImageBitmap, canvas, URL, localStorage) are touched only inside functions.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  var MAX_EDGE = 2400;                       // px, long edge after downscaling
  var MAX_PNG = 4 * 1024 * 1024;             // encoded PNG ceiling
  var STEP = 0.7;                            // downscale factor per step
  var MAX_INPUT = 64 * 1024 * 1024;          // refuse absurd inputs before decoding
  var MAX_STEPS = 16;
  var SWEEP_AGE = 24 * 3600000;              // attachments older than 24 h may be swept
  var MISSING_TTL = 30000;                   // re-check an unknown id after 30 s (imports add attachments later)
  var DRAFT_PREFIX = "marginalia.draft.";
  var TOKEN_SOURCE = "!\\[[^\\]\\n]*\\]\\(att:([A-Za-z0-9_\\-]+)\\)";

  var urls = new Map();        // id → object URL
  var pending = new Map();     // id → Promise<url|null>
  var missing = new Map();     // id → timestamp of the last miss

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

  function toast(text) {
    var app = M.app;
    if (app && typeof app.toast === "function") {
      try { app.toast({ text: text, ttl: 6000, id: "attachment-error" }); } catch (e) { /* ignore */ }
    }
  }

  function store() { return dep("store"); }
  function util() { return dep("util"); }
  function hasDom() { return typeof document !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"; }

  function uniq(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var id = list[i];
      if (typeof id !== "string" || !id || seen[id]) continue;
      seen[id] = true;
      out.push(id);
    }
    return out;
  }

  // Attachment ids referenced by a text (M.prompts.imageIds when loaded, else the token regex).
  function imageIds(text) {
    var t = typeof text === "string" ? text : "";
    var pr = M.prompts || tryDep("prompts");
    if (pr && typeof pr.imageIds === "function") {
      try { return uniq(pr.imageIds(t) || []); } catch (e) { /* fall back to the regex */ }
    }
    var re = new RegExp(TOKEN_SOURCE, "g"), m, out = [];
    while ((m = re.exec(t))) out.push(m[1]);
    return uniq(out);
  }

  function token(id) { return "![snip](att:" + id + ")"; }

  function revoke(u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } }

  function setUrl(id, u) {
    var old = urls.get(id);
    if (old && old !== u) revoke(old);
    urls.set(id, u);
    missing.delete(id);
  }

  /* ------------------------------------------------------------------ pending placeholders */
  // Decoding and storing an image takes a while (~1 s). The editor shows ![snip](att:pending-<tag>-<n>)
  // at the caret right away and swaps in the stored id when attach() resolves. The registry maps every
  // placeholder to its attachment so url() shows it, resolveText() rewrites restored drafts and gc(),
  // sweep() and discard() never delete an attachment that a placeholder still stands for.
  // A placeholder can outlive its editor and its session: the editor writes it into its localStorage draft and
  // may be closed, or the page reloaded, before the image lands. So once the image is stored every draft that
  // names the placeholder is rewritten to the stored id, and the mapping is also kept in the ledger
  // (localStorage "marginalia.placeholder.<pid>" = {id, at}) so a later session still resolves a placeholder an
  // editor wrote back afterwards; a failed image's placeholder is dropped from every draft. A placeholder of ours
  // (PENDING_SHAPE) that is neither decoding in this session nor in the ledger can never resolve: resolveText()
  // and the boot sweep drop it. Ids of any other shape are left alone.
  var PENDING_PREFIX = "pending-";
  var PENDING_SHAPE = /^pending-[0-9a-z]{4}-[1-9][0-9]*$/;   // what beginPending() makes
  var PENDING_TAG_SOURCE = "pending-([0-9a-z]{4})-[1-9][0-9]*";
  var TAG_SPACE = 1679616;                                   // 36^4: four base-36 characters
  var LEDGER_PREFIX = "marginalia.placeholder.";
  var REMOVE = {};                                           // fate(): drop the token
  var pendingSeq = 0;
  var pendingTag = null;                   // session-unique, so a stale draft token never collides
  var pendings = new Map();                // placeholder id → {id: attachment id|null, settled}

  function isPendingId(id) { return typeof id === "string" && id.indexOf(PENDING_PREFIX) === 0; }

  // localStorage, every call guarded (private windows and sandboxes throw; a full quota leaves things as they are).
  function storage() {
    try { var ls = root.localStorage; return ls && typeof ls.getItem === "function" ? ls : null; } catch (e) { return null; }
  }
  function lsGet(k) { var ls = storage(); if (!ls) return null; try { return ls.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { var ls = storage(); if (!ls) return false; try { ls.setItem(k, v); return true; } catch (e) { return false; } }
  function lsRemove(k) { var ls = storage(); if (!ls) return; try { ls.removeItem(k); } catch (e) { /* ignore */ } }
  // The keys starting with prefix, all collected before the caller writes (a write may reorder key(i)).
  function lsKeys(prefix) {
    var out = [], ls = storage();
    if (!ls) return out;
    try {
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (typeof k === "string" && k.indexOf(prefix) === 0) out.push(k);
      }
    } catch (e) { /* private windows, sandboxes */ }
    return out;
  }

  // The ledger entry of a placeholder whose image was stored (in any session): {id, at}, else null.
  function ledgerGet(pid) {
    var raw = lsGet(LEDGER_PREFIX + pid);
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      if (v && typeof v.id === "string" && v.id && !isPendingId(v.id)) return { id: v.id, at: typeof v.at === "number" ? v.at : 0 };
    } catch (e) { /* a corrupt entry resolves nothing; the boot sweep removes it */ }
    return null;
  }

  // Tags that a draft or the ledger still names: a new session must not reuse one (its tokens would collide).
  function usedTags() {
    var used = {};
    function scan(s) { var re = new RegExp(PENDING_TAG_SOURCE, "g"), m; while ((m = re.exec(s))) used[m[1]] = true; }
    lsKeys(LEDGER_PREFIX).forEach(scan);
    draftTexts().forEach(scan);
    return used;
  }

  function beginPending() {
    if (pendingTag === null) {
      var used = usedTags();
      for (var i = 0; i < 16 && (pendingTag === null || used[pendingTag]); i++) {
        pendingTag = ("000" + Math.floor(Math.random() * TAG_SPACE).toString(36)).slice(-4);
      }
    }
    var pid = PENDING_PREFIX + pendingTag + "-" + (++pendingSeq);
    pendings.set(pid, { id: null, settled: false });
    return pid;
  }

  // What a placeholder token becomes: its stored id (this session's registry, else the ledger), REMOVE when it
  // can never resolve (its image failed, or its session ended before the image was stored), or null to keep it
  // (still decoding in this session, or an id of another shape).
  function fate(pid) {
    var e = pendings.get(pid);
    if (e) return e.id || null;
    var l = ledgerGet(pid);
    if (l) return l.id;
    return PENDING_SHAPE.test(pid) ? REMOVE : null;
  }

  function pendingRealId(pid) { var f = fate(pid); return typeof f === "string" ? f : null; }

  // The stored id behind a token id: a placeholder maps to its attachment once decoded, else null.
  function realId(id) {
    if (typeof id !== "string" || !id) return null;
    return isPendingId(id) ? pendingRealId(id) : id;
  }

  // Ids a text references in the store (placeholders count through their resolved attachment).
  function storedIds(text) {
    var out = [];
    imageIds(text).forEach(function (id) { var r = realId(id); if (r) out.push(r); });
    return uniq(out);
  }

  // Applies decide(pid) to every placeholder token of a text: a stored id is swapped in, REMOVE drops the
  // token, anything else keeps it.
  function rewritePending(text, decide) {
    var t = typeof text === "string" ? text : "";
    if (t.indexOf("att:" + PENDING_PREFIX) < 0) return t;
    return t.replace(new RegExp(TOKEN_SOURCE, "g"), function (m, id) {
      if (!isPendingId(id)) return m;
      var f = decide(id);
      if (f === REMOVE) return "";
      return typeof f === "string" && f ? m.slice(0, m.lastIndexOf("(att:")) + "(att:" + f + ")" : m;
    });
  }

  // Rewrites resolved placeholder tokens to their stored ids and drops dead ones (see fate); placeholders still
  // decoding in this session and ids of any other shape are left alone. The editor runs a restored draft and the
  // text it saves through this, so a dead token is never restored or saved.
  function resolveText(text) { return rewritePending(text, fate); }

  // The same kind of rewrite for every localStorage draft (one left blank is removed, as the editor would).
  function rewriteDrafts(decide) {
    lsKeys(DRAFT_PREFIX).forEach(function (k) {
      var v = lsGet(k);
      if (typeof v !== "string") return;
      var nv = rewritePending(v, decide);
      if (nv === v) return;
      if (nv.trim()) lsSet(k, nv); else lsRemove(k);
    });
  }

  // Boot: forget ledger entries older than a day that no draft, live prompt or placeholder of this session names.
  function pruneLedger(now) {
    var keys = lsKeys(LEDGER_PREFIX);
    if (!keys.length) return;
    var cache = M.cache || tryDep("cache");
    if (!cache || typeof cache.prompts !== "function") return;             // references unknown: keep them all
    var texts = draftTexts();
    try {
      cache.prompts().forEach(function (p) {
        if (p && (p.deletedAt === null || p.deletedAt === undefined) && typeof p.text === "string") texts.push(p.text);
      });
    } catch (e) { return; }
    keys.forEach(function (k) {
      var pid = k.slice(LEDGER_PREFIX.length), entry = ledgerGet(pid), needle = "(att:" + pid + ")";
      if (pendings.has(pid)) return;
      if (entry && (now - entry.at < SWEEP_AGE || texts.some(function (t) { return t.indexOf(needle) >= 0; }))) return;
      lsRemove(k);
    });
  }

  /* ------------------------------------------------------------------ decode + encode */

  function decodeViaImage(blob) {
    return new Promise(function (resolve, reject) {
      var u;
      try { u = URL.createObjectURL(blob); } catch (e) { reject(err("decode", "Could not read the image", e)); return; }
      var img = new Image();
      img.onload = function () { revoke(u); resolve(img); };
      img.onerror = function () { revoke(u); reject(err("decode", "Could not decode the image")); };
      img.src = u;
    });
  }

  function decode(blob) {
    if (typeof createImageBitmap === "function") {
      return Promise.resolve().then(function () { return createImageBitmap(blob); })
        .catch(function () { return decodeViaImage(blob); });
    }
    return decodeViaImage(blob);
  }

  function dimensions(img) {
    return { w: img.naturalWidth || img.width || 0, h: img.naturalHeight || img.height || 0 };
  }

  function drawPng(img, cw, ch) {
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      var ctx = canvas.getContext("2d");
      if (!ctx) { reject(err("decode", "Canvas is unavailable")); return; }
      try { ctx.drawImage(img, 0, 0, cw, ch); } catch (e) { reject(err("decode", "Could not draw the image", e)); return; }
      if (typeof canvas.toBlob !== "function") { reject(err("decode", "PNG encoding is unavailable")); return; }
      try {
        canvas.toBlob(function (b) {
          canvas.width = canvas.height = 0;
          if (b) resolve(b); else reject(err("decode", "PNG encoding failed"));
        }, "image/png");
      } catch (e) { reject(err("decode", "PNG encoding failed", e)); }
    });
  }

  // Downscale by 0.7 steps while the long edge exceeds 2400 px or the PNG exceeds 4 MB.
  function encodeFit(img, w, h) {
    var scale = 1;
    while (Math.max(w, h) * scale > MAX_EDGE) scale *= STEP;
    function attempt(s, steps) {
      var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      return drawPng(img, cw, ch).then(function (png) {
        if (png.size <= MAX_PNG) return { png: png, width: cw, height: ch };
        if (steps >= MAX_STEPS || (cw <= 32 && ch <= 32)) throw err("too_large", "The image is still over 4 MB after downscaling");
        return attempt(s * STEP, steps + 1);
      });
    }
    return attempt(scale, 0);
  }

  function fromBlob(blob) {
    if (!hasDom()) return Promise.reject(err("decode", "Images need a browser"));
    if (!blob || typeof blob.size !== "number") return Promise.reject(err("decode", "Not an image"));
    if (blob.type && !/^image\//i.test(blob.type)) return Promise.reject(err("decode", "Not an image"));
    if (blob.size > MAX_INPUT) return Promise.reject(err("too_large", "The image is larger than 64 MB"));
    var bitmap = null;
    return decode(blob).then(function (img) {
      bitmap = img;
      var d = dimensions(img);
      if (!d.w || !d.h) throw err("decode", "The image is empty");
      return encodeFit(img, d.w, d.h);
    }).then(function (res) {
      if (bitmap && typeof bitmap.close === "function") { try { bitmap.close(); } catch (e) { /* ignore */ } }
      return res.png.arrayBuffer().then(function (buf) {
        var att = {
          id: util().uuid("a_"),
          mime: "image/png",
          bytes: buf,
          width: res.width,
          height: res.height,
          byteLength: buf.byteLength,
          createdAt: Date.now()
        };
        return store().attachments.put(att).then(function () {
          setUrl(att.id, URL.createObjectURL(res.png));
          emit("attachment:ready", { id: att.id });
          return att;
        }, function (e) {
          throw err("store", "The image could not be stored", e);
        });
      });
    }, function (e) {
      if (bitmap && typeof bitmap.close === "function") { try { bitmap.close(); } catch (e2) { /* ignore */ } }
      if (e && (e.code === "decode" || e.code === "too_large" || e.code === "store")) throw e;
      throw err("decode", "Could not decode the image", e);
    });
  }

  /* ------------------------------------------------------------------ object URLs */

  // Synchronous: the cached object URL, or null (a load starts in the background and
  // "attachment:ready" {id} fires when the URL exists).
  function url(id) {
    if (!id) return null;
    if (isPendingId(id)) { var rid = pendingRealId(id); return rid ? url(rid) : null; }
    if (urls.has(id)) return urls.get(id);
    var miss = missing.get(id);
    if ((miss === undefined || Date.now() - miss > MISSING_TTL) && !pending.has(id)) load(id).catch(function () { return null; });
    return null;
  }

  function load(id) {
    if (!id) return Promise.resolve(null);
    if (isPendingId(id)) { var rid = pendingRealId(id); return rid ? load(rid) : Promise.resolve(null); }
    if (urls.has(id)) return Promise.resolve(urls.get(id));
    if (pending.has(id)) return pending.get(id);
    if (!hasDom()) return Promise.resolve(null);
    var p = Promise.resolve().then(function () {
      return store().attachments.get(id);
    }).then(function (att) {
      if (!att || !att.bytes) { missing.set(id, Date.now()); return null; }
      if (urls.has(id)) return urls.get(id);
      // never serve a stored record as SVG/HTML (older imports could carry any MIME): raster types only
      var safeType = /^image\/(png|jpeg|gif|webp)$/.test(String(att.mime || "")) ? att.mime : "image/png";
      var u = URL.createObjectURL(new Blob([att.bytes], { type: safeType }));
      setUrl(id, u);
      emit("attachment:ready", { id: id });
      return u;
    }).catch(function () {
      return null;
    }).then(function (u) {
      pending.delete(id);
      return u;
    });
    pending.set(id, p);
    return p;
  }

  function release(id) {
    var u = urls.get(id);
    if (!u) return;
    urls.delete(id);
    revoke(u);
  }

  function releaseAll() {
    urls.forEach(function (u) { revoke(u); });
    urls.clear();
  }

  /* ------------------------------------------------------------------ references + GC */

  function draftTexts() {
    var out = [];
    lsKeys(DRAFT_PREFIX).forEach(function (k) { var v = lsGet(k); if (v) out.push(v); });
    return out;
  }

  // Ids referenced by any live prompt (except opts.promptId), opts.draftIds, opts.extraText, localStorage
  // drafts and every placeholder whose stored id has not yet been written into its editor's text.
  function referencedIds(opts) {
    opts = opts || {};
    var refs = new Set();
    function add(id) { var r = realId(id); if (r) refs.add(r); }
    var cache = M.cache || tryDep("cache");
    if (cache && typeof cache.prompts === "function") {
      cache.prompts().forEach(function (p) {
        if (!p || (p.deletedAt !== null && p.deletedAt !== undefined)) return;
        if (opts.promptId && p.id === opts.promptId) return;
        imageIds(p.text).forEach(add);
      });
    }
    if (opts.extraText) imageIds(opts.extraText).forEach(add);
    if (Array.isArray(opts.draftIds)) opts.draftIds.forEach(add);
    draftTexts().forEach(function (t) { imageIds(t).forEach(add); });
    pendings.forEach(function (e) { if (!e.settled && e.id) refs.add(e.id); });
    return refs;
  }

  function removeAll(ids) {
    var st = store(), removed = [];
    return ids.reduce(function (chain, id) {
      return chain.then(function () {
        return st.attachments.remove(id).then(function () {
          release(id);
          missing.set(id, Date.now());
          removed.push(id);
        }, function () { /* keep going; sweep() will retry later */ });
      });
    }, Promise.resolve()).then(function () { return removed; });
  }

  // Ids that left the text (in oldText, not in newText) are deleted unless another live prompt,
  // opts.draftIds or a localStorage draft still references them. Call it after savePrompt (or pass
  // opts.promptId so the prompt being edited is judged by newText rather than by its cached text).
  function gc(oldText, newText, opts) {
    opts = opts || {};
    var oldIds = storedIds(oldText), newIds = storedIds(newText);
    var left = oldIds.filter(function (id) { return newIds.indexOf(id) < 0; });
    if (!left.length) return Promise.resolve([]);
    var refs = referencedIds({ draftIds: opts.draftIds, promptId: opts.promptId, extraText: newText });
    var dead = left.filter(function (id) { return !refs.has(id); });
    if (!dead.length) return Promise.resolve([]);
    return removeAll(dead);
  }

  // Deletes one attachment unless a live prompt, a draft or an unapplied placeholder still references it
  // (used when a placeholder could not be written: its editor closed or the token was deleted meanwhile).
  function discard(id) {
    if (typeof id !== "string" || !id) return Promise.resolve(false);
    if (referencedIds({}).has(id)) return Promise.resolve(false);
    return removeAll([id]).then(function (removed) { return removed.length > 0; });
  }

  // Boot sweep: attachments older than 24 h that no live prompt or draft references; records meta.lastSweepAt.
  // Drafts heal first (the boot runs it before any editor restores one): placeholders name their stored ids and
  // dead ones are dropped; then ledger entries that nothing names any more are forgotten.
  function sweep(now) {
    var t = typeof now === "number" ? now : Date.now();
    try { rewriteDrafts(fate); pruneLedger(t); } catch (e) { /* the drafts stay as they are */ }
    var st = store();
    var refs = referencedIds({});
    return st.attachments.allIds().then(function (ids) {
      var candidates = (ids || []).filter(function (id) { return typeof id === "string" && !refs.has(id); });
      var dead = [];
      return candidates.reduce(function (chain, id) {
        return chain.then(function () {
          return st.attachments.get(id).then(function (att) {
            if (!att) return undefined;
            var created = typeof att.createdAt === "number" ? att.createdAt : 0;
            if (t - created < SWEEP_AGE) return undefined;
            return st.attachments.remove(id).then(function () {
              release(id);
              missing.set(id, t);
              dead.push(id);
            }, function () { /* retried at the next sweep */ });
          }, function () { /* unreadable record: skip */ });
        });
      }, Promise.resolve()).then(function () {
        return st.meta.set("lastSweepAt", t).catch(function () { return undefined; });
      }).then(function () { return dead; });
    }).catch(function () { return []; });
  }

  /* ------------------------------------------------------------------ paste + drop */

  function isImageFile(f) { return !!f && /^image\//i.test(f.type || ""); }

  function imageFilesFrom(dt) {
    var out = [];
    if (!dt) return out;
    var items = dt.items;
    if (items && items.length) {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || it.kind !== "file" || !/^image\//i.test(it.type || "")) continue;
        var f = null;
        try { f = typeof it.getAsFile === "function" ? it.getAsFile() : null; } catch (e) { f = null; }
        if (f) out.push(f);
      }
    }
    if (!out.length && dt.files && dt.files.length) {
      for (var j = 0; j < dt.files.length; j++) if (isImageFile(dt.files[j])) out.push(dt.files[j]);
    }
    return out;
  }

  // Step 1 (synchronous, inside the paste / drop event): the placeholder token lands at the caret and the
  // editor counts it as pending (its Save waits). An editor without placePending gets the stored token later.
  function place(file, editor) {
    var pid = beginPending(), placed = false;
    if (editor && typeof editor.placePending === "function") {
      try { placed = editor.placePending(pid) === true; } catch (e) { placed = false; }
    }
    return { pid: pid, file: file, placed: placed };
  }

  // Step 3: the editor swaps the placeholder for the stored token (id) or drops it (null); true when written.
  function finish(job, editor, id) {
    var applied = false;
    if (job.placed && editor && typeof editor.resolvePending === "function") {
      try { applied = editor.resolvePending(job.pid, id) === true; } catch (e) { applied = false; }
    }
    var e = pendings.get(job.pid);
    if (e) e.settled = true;
    return applied;
  }

  // Step 2: decode + store (through api.fromBlob so a host can wrap it), then settle. Resolves the attachment,
  // or null when the image failed (toast) or nothing could hold it (the editor closed or the placeholder was
  // deleted meanwhile: the attachment is discarded unless something else references it).
  function process(job, editor) {
    var decoded;
    try { decoded = Promise.resolve(api.fromBlob(job.file)); } catch (e) { decoded = Promise.reject(e); }
    return decoded.then(function (att) {
      if (!att || typeof att.id !== "string" || !att.id) throw err("decode", "Could not decode the image");
      return att;
    }).then(function (att) {
      return stored(job, editor, att);
    }, function (e) {
      failed(job, editor, e);
      return null;
    });
  }

  // The image is stored: the registry and the ledger learn its id and every draft that already holds the
  // placeholder is rewritten to it (the draft of an editor closed meanwhile heals too); then the editor swaps it in.
  function stored(job, editor, att) {
    var e = pendings.get(job.pid);
    if (e) e.id = att.id;
    if (job.placed) {
      lsSet(LEDGER_PREFIX + job.pid, JSON.stringify({ id: att.id, at: Date.now() }));
      rewriteDrafts(function (pid) { return pid === job.pid ? att.id : null; });
    }
    var applied = finish(job, editor, att.id);
    if (!applied && !job.placed && editor && typeof editor.insertAtCaret === "function") {
      try { editor.insertAtCaret(token(att.id)); applied = true; } catch (e2) { applied = false; }
    }
    if (applied) return att;
    return discard(att.id).then(function (gone) {
      if (gone) lsRemove(LEDGER_PREFIX + job.pid);           // nothing names the placeholder any more
      return null;
    });
  }

  // The image failed: the editor drops the placeholder and so does every draft that holds it.
  function failed(job, editor, e) {
    pendings.delete(job.pid);
    finish(job, editor, null);
    if (job.placed) rewriteDrafts(function (pid) { return pid === job.pid ? REMOVE : null; });
    toast(e && e.code === "too_large" ? "Image too large — it is still over 4 MB after downscaling"
      : e && e.code === "store" ? "The image could not be stored" : "Could not read that image");
  }

  // Attach one image to an editor: placeholder now, stored token when ready → Promise<att|null>.
  function attach(blob, editor) { return process(place(blob, editor), editor); }

  // Editor paste: an image file on the clipboard wins over text; the placeholder lands at the caret at once.
  function handlePaste(ev, editor) {
    var files = imageFilesFrom(ev && ev.clipboardData);
    if (!files.length) return false;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    attach(files[0], editor);
    return true;
  }

  // Dropped image files behave like paste: every placeholder lands at once, in order; decoding runs one at a time.
  function handleDrop(ev, editor) {
    var files = imageFilesFrom(ev && ev.dataTransfer);
    if (!files.length) return false;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    var jobs = files.map(function (f) { return place(f, editor); });
    jobs.reduce(function (chain, job) {
      function next() { return process(job, editor); }
      return chain.then(next, next);                         // one image going wrong never strands the others
    }, Promise.resolve());
    return true;
  }

  var api = {
    MAX_EDGE: MAX_EDGE,
    MAX_PNG: MAX_PNG,
    SWEEP_AGE: SWEEP_AGE,
    fromBlob: fromBlob,
    url: url,
    load: load,
    release: release,
    releaseAll: releaseAll,
    gc: gc,
    sweep: sweep,
    handlePaste: handlePaste,
    handleDrop: handleDrop,
    attach: attach,
    discard: discard,
    isPendingId: isPendingId,
    realId: realId,
    resolveText: resolveText,
    imageIds: imageIds,
    token: token,
    PENDING_PREFIX: PENDING_PREFIX
  };

  M.attachments = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17 M.attachments): fromBlob(blob) → Promise<att> (rejects code "decode"|"too_large"); url(id) → objectURL|null;
 * release(id); gc(oldText, newText, {draftIds}) → Promise<deletedIds>; sweep(now) → Promise<deletedIds>;
 * handlePaste(ev, editor) → boolean; handleDrop(ev, editor) → boolean.
 * Extras: load(id) → Promise<url|null> and the "attachment:ready" {id} event; releaseAll(); imageIds(text); token(id);
 * gc also accepts opts.promptId. Placeholders: attach(blob, editor) → Promise<att|null> (uses Editor.placePending(pid)
 * and Editor.resolvePending(pid, id|null)); discard(id) → Promise<boolean>; isPendingId(id); realId(id); resolveText(text)
 * (swaps in stored ids, drops dead placeholders); PENDING_PREFIX. A draft holding a placeholder is rewritten when its
 * image settles; sweep() first heals every draft and prunes the localStorage ledger "marginalia.placeholder.<pid>". */
