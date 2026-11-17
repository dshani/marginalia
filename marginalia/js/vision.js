/* js/vision.js — Marginalia vision: LaTeX transcription of snips (SPEC §15 "Vision", §17; BUILD-NOTES INSTRUCTION).
 *
 * Backends: "artifact" (claude.use("sample") with images) or "apikey" (a raw fetch to the Anthropic
 * Messages API with the key stored by M.settings.apiKey). Loads in node without a DOM; every DOM or
 * network access happens inside functions that run after boot.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }

  // BUILD-NOTES "Vision INSTRUCTION" — verbatim.
  var INSTRUCTION = "Transcribe every piece of mathematics in this image into LaTeX exactly as written: same symbols, order, subscripts, superscripts, primes, hats, vectors and alignment. Do not simplify, solve, complete, correct or annotate anything. Return ONLY the LaTeX source: no prose, no explanation, no code fences, and no $ / \\( / \\[ delimiters. Use standard amsmath notation (\\frac, \\sqrt, \\int, \\sum, \\partial, \\nabla, \\hbar, \\left( \\right), \\mathbf, \\vec, \\hat). Leave out equation numbers such as (1.12). Put independent equations on separate lines; use \\begin{aligned} ... \\end{aligned} with \\\\ and & only for a derivation that is aligned across lines in the image. If the image contains no mathematical notation (a diagram, figure, table of words or plain prose), return exactly the single token NO_MATH.";

  var API_URL = "https://api.anthropic.com/v1/messages";
  var API_VERSION = "2026-10-21";
  var API_BETA = "server-side-fallback-2026-07-01";
  var DEFAULT_MODEL = "claude-opus-5-5";
  var MAX_TOKENS = 1024;
  var TIMEOUT_MS = 45000;
  var CODES = ["no_backend", "not_granted", "images_unavailable", "no_math", "refusal", "auth", "rate_limit", "server", "network", "cutoff", "superseded"];
  var sampleCap = null; // the artifact runtime's sample capability, once granted

  // ---------------------------------------------------------------- helpers

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function settingsGet(key) {
    try { return M.settings && typeof M.settings.get === "function" ? M.settings.get(key) : undefined; } catch (e) { return undefined; }
  }
  function apiKey() {
    try {
      var s = M.settings;
      if (s && s.apiKey && typeof s.apiKey.get === "function") {
        var k = s.apiKey.get();
        return typeof k === "string" && k.trim() ? k.trim() : null;
      }
    } catch (e) { /* storage unavailable */ }
    return null;
  }
  function modelId() {
    var m = settingsGet("visionModel");
    return typeof m === "string" && m.trim() ? m.trim() : DEFAULT_MODEL;
  }
  function mediaType(blob) {
    var t = blob && typeof blob.type === "string" ? blob.type : "";
    return /^image\/(png|jpeg|gif|webp)$/.test(t) ? t : "image/png";
  }
  function headerOf(res, name) {
    try { return res && res.headers && typeof res.headers.get === "function" ? res.headers.get(name) : null; } catch (e) { return null; }
  }

  function bytesToBase64(u8) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
    var s = "", CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    if (typeof btoa === "function") return btoa(s);
    var B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", out = "";
    for (var j = 0; j < u8.length; j += 3) {
      var a = u8[j], b = u8[j + 1], c = u8[j + 2], hasB = j + 1 < u8.length, hasC = j + 2 < u8.length;
      out += B[a >> 2] + B[((a & 3) << 4) | (hasB ? b >> 4 : 0)] + (hasB ? B[((b & 15) << 2) | (hasC ? c >> 6 : 0)] : "=") + (hasC ? B[c & 63] : "=");
    }
    return out;
  }
  // Base64 of a Blob: FileReader.readAsDataURL, else arrayBuffer() + chunked btoa.
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      if (!blob) return reject(err("server", "No image to transcribe"));
      if (typeof FileReader === "function") {
        try {
          var r = new FileReader();
          r.onload = function () {
            var s = String(r.result || ""), i = s.indexOf(",");
            resolve(i >= 0 ? s.slice(i + 1) : s);
          };
          r.onerror = function () { reject(err("server", "Could not read the image")); };
          r.readAsDataURL(blob);
          return;
        } catch (e) { /* fall through to arrayBuffer */ }
      }
      if (typeof blob.arrayBuffer === "function") {
        blob.arrayBuffer().then(function (ab) { resolve(bytesToBase64(new Uint8Array(ab))); }, function () { reject(err("server", "Could not read the image")); });
        return;
      }
      reject(err("server", "Unsupported image"));
    });
  }
  function dataUrlToBlob(dataUrl) {
    var i = dataUrl.indexOf(","), head = dataUrl.slice(0, i), b64 = dataUrl.slice(i + 1);
    var mime = (/^data:([^;,]+)/.exec(head) || [])[1] || "image/png";
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
    return new Blob([u8], { type: mime });
  }

  // --------------------------------------------------------------- backends

  // The artifact runtime's sample capability (a callable with .limits()), or null.
  function getSample() {
    if (sampleCap) return Promise.resolve(sampleCap);
    var claude = root.claude;
    if (!claude || typeof claude.use !== "function") return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return claude.use("sample"); })
      .then(function (s) { if (s) sampleCap = s; return s || null; }, function () { return null; });
  }

  function detect() {
    return getSample().then(function (sample) {
      if (!sample) return null;
      var limits = typeof sample.limits === "function"
        ? Promise.resolve().then(function () { return sample.limits(); }).catch(function () { return null; })
        : Promise.resolve(null);
      return limits.then(function (l) { return l && l.images ? "artifact" : null; });
    }).then(function (kind) {
      if (kind) return kind;
      return apiKey() ? "apikey" : null;
    });
  }

  function readResponse(res) {
    var status = res.status;
    return Promise.resolve().then(function () { return res.json(); }).then(null, function () { return null; }).then(function (json) {
      if (status === 401 || status === 403) throw err("auth", "API key rejected — check Settings");
      if (status === 429) {
        var secs = parseInt(headerOf(res, "retry-after"), 10);
        throw err("rate_limit", "Rate limited — try again in " + (secs > 0 ? secs + " s" : "a moment"));
      }
      if (status >= 500) throw err("server", "Claude is overloaded — try again in a moment");
      if (!res.ok) throw err("server", (json && json.error && json.error.message) || ("Request failed (HTTP " + status + ")"));
      if (!json || !Array.isArray(json.content)) throw err("server", "Unexpected response from the API");
      if (json.stop_reason === "refusal") throw err("refusal", "The model declined this image");
      var text = json.content
        .filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; })
        .map(function (b) { return b.text; })
        .join("\n");
      return { text: text, cutOff: json.stop_reason === "max_tokens" };
    });
  }

  // One POST to the Messages API, never retried. Headers and body exactly as SPEC §15.
  function viaApiKey(blob, fetchSignal) {
    var key = apiKey();
    if (!key) return Promise.reject(err("no_backend", "Add an API key in Settings to transcribe equations"));
    if (typeof fetch !== "function") return Promise.reject(err("network", "fetch is not available in this environment"));
    return blobToBase64(blob).then(function (b64) {
      var body = {
        model: modelId(),
        max_tokens: MAX_TOKENS,
        output_config: { effort: "low" },
        fallbacks: "default",
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType(blob), data: b64 } },
            { type: "text", text: INSTRUCTION }
          ]
        }]
      };
      var init = {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": API_BETA
        },
        body: JSON.stringify(body)
      };
      if (fetchSignal) init.signal = fetchSignal;
      return fetch(API_URL, init).then(null, function (e) {
        if (e && e.name === "AbortError") throw e;
        throw err("network", "The browser blocked the request or you are offline");
      });
    }).then(readResponse);
  }

  function passThrough(e) {
    if (e && typeof e.code === "string" && e.code) return e instanceof Error ? e : err(e.code, e.message || e.code);
    return err("server", (e && e.message) || "The artifact runtime could not transcribe the image");
  }
  function viaArtifact(blob) {
    return getSample().then(function (sample) {
      if (!sample) throw err("not_granted", "The artifact runtime did not grant model access");
      return Promise.resolve().then(function () { return sample(INSTRUCTION, { images: [blob], modelTier: "default", cache: false }); });
    }).then(function (r) {
      var text = r && typeof r.text === "string" ? r.text : (typeof r === "string" ? r : "");
      var cutOff = !!(r && (r.stopReason === "max_tokens" || r.stop_reason === "max_tokens" || r.truncated === true));
      return { text: text, cutOff: cutOff };
    }, function (e) { throw passThrough(e); });
  }

  // ------------------------------------------------------------ postprocess

  function stripOnce(s) {
    var pairs = [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]];
    s = s.trim();
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < pairs.length; i++) {
        var o = pairs[i][0], c = pairs[i][1];
        if (s.length >= o.length + c.length && s.slice(0, o.length) === o && s.slice(-c.length) === c && !(c === "$" && s.slice(-2) === "\\$")) {
          s = s.slice(o.length, s.length - c.length).trim();
          changed = true;
        }
      }
    }
    return s;
  }
  function stripDelims(t) {
    var lines = t.split("\n").map(stripOnce);
    return stripOnce(lines.join("\n"));
  }

  var RELATION = /(=|<|>|\\leq?(?![a-zA-Z])|\\geq?(?![a-zA-Z])|\\neq?(?![a-zA-Z])|\\approx|\\equiv|\\simeq|\\sim(?![a-zA-Z])|\\propto|\\to(?![a-zA-Z])|\\rightarrow|\\Rightarrow|\\iff|\\subset|\\in(?![a-zA-Z]))/;
  var TALL = /\\(d?frac|tfrac|int|iint|iiint|oint|sum|prod|coprod|lim|bigcup|bigcap|sqrt|binom|overset|underset|stackrel|cfrac)(?![a-zA-Z])/;

  function postprocess(raw) {
    var t = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").trim();
    var fence = /^```[A-Za-z]*[ \t]*\n?([\s\S]*?)\n?```\s*$/.exec(t);
    if (fence) t = fence[1].trim();
    t = t.replace(/^```[A-Za-z]*[ \t]*\n?/, "").replace(/\n?```\s*$/, "").trim();
    t = t.replace(/^latex\s*:\s*/i, "").trim();
    if (/^\W*NO_MATH\W*$/i.test(t)) throw err("no_math", "No equation found");
    t = stripDelims(t);
    if (!t) throw err("no_math", "No equation found");
    var lines = t.split("\n").map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
    t = lines.join("\n");
    var hasEnv = /\\begin\{/.test(t);
    var display = hasEnv || lines.length > 1 || /\\\\/.test(t) || (RELATION.test(t) && (TALL.test(t) || t.length > 24));
    if (lines.length > 1 && !hasEnv) {
      var aligned = lines.some(function (l) { return /(^|[^\\])&/.test(l); });
      var rows = lines.map(function (l) { return l.replace(/\\\\\s*$/, "").trim(); }).filter(function (l) { return l.length > 0; });
      t = "\\begin{aligned}\n" + rows.map(function (l) { return aligned ? l : "&" + l; }).join(" \\\\\n") + "\n\\end{aligned}";
    }
    return { latex: t, display: display };
  }

  function wrap(latex, display) {
    var t = String(latex == null ? "" : latex);
    return display ? "\n$$\n" + t + "\n$$\n" : "$" + t + "$";
  }

  function katexWarning(latex, display) {
    var k = root.katex;
    if (!k || typeof k.renderToString !== "function") return null;
    try { k.renderToString(latex, { throwOnError: true, displayMode: !!display }); return null; }
    catch (e) { return "May not render: " + ((e && e.message) || "KaTeX error"); }
  }

  function finish(raw, cutOff) {
    var text = String(raw == null ? "" : raw);
    if (cutOff && !text.trim()) throw err("cutoff", "Transcription was cut off — try a smaller region");
    var pp = postprocess(text);
    return { latex: pp.latex, display: pp.display, wrapped: wrap(pp.latex, pp.display), cutOff: !!cutOff, warning: katexWarning(pp.latex, pp.display) };
  }

  function asVisionError(e) {
    if (e && typeof e.code === "string" && e.code) return e instanceof Error ? e : err(e.code, e.message || e.code);
    if (e && e.name === "AbortError") return err("superseded", "Superseded by a newer snip");
    if (e instanceof TypeError) return err("network", "The browser blocked the request or you are offline");
    return err("server", (e && e.message) || "Transcription failed");
  }

  function run(blob, fetchSignal) {
    if (!blob) return Promise.reject(err("server", "No image to transcribe"));
    return detect().then(function (backend) {
      if (backend === "artifact") return viaArtifact(blob);
      if (backend === "apikey") return viaApiKey(blob, fetchSignal);
      throw err("no_backend", "Add an API key in Settings to transcribe equations");
    }).then(function (r) { return finish(r.text, r.cutOff); });
  }

  // transcribe(blob, {signal}) → Promise<{latex, display, wrapped, cutOff, warning}>; 45 s timeout → "network",
  // an aborted signal → "superseded".
  function transcribe(blob, opts) {
    opts = opts || {};
    var signal = opts.signal || null;
    return new Promise(function (resolve, reject) {
      var done = false, timer = null;
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      function settle(ok, v) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
        (ok ? resolve : reject)(v);
      }
      function onAbort() {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* ignore */ } }
        settle(false, err("superseded", "Superseded by a newer snip"));
      }
      if (signal && signal.aborted) return onAbort();
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort);
      timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* ignore */ } }
        settle(false, err("network", "Transcription timed out after 45 s"));
      }, TIMEOUT_MS);
      run(blob, ctrl ? ctrl.signal : undefined).then(function (r) { settle(true, r); }, function (e) { settle(false, asVisionError(e)); });
    });
  }

  // ------------------------------------------------------------------- test

  function renderTestImage() {
    return new Promise(function (resolve, reject) {
      try {
        var c = document.createElement("canvas");
        c.width = 120; c.height = 60;
        var ctx = c.getContext("2d");
        if (!ctx) return reject(err("server", "Canvas is unavailable"));
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 120, 60);
        ctx.fillStyle = "#000000";
        ctx.font = "italic 34px 'Times New Roman', Times, serif"; ctx.fillText("x", 40, 44);
        ctx.font = "20px 'Times New Roman', Times, serif"; ctx.fillText("2", 62, 26);
        if (typeof c.toBlob === "function") {
          c.toBlob(function (b) { if (b) resolve(b); else reject(err("server", "Could not encode the test image")); }, "image/png");
        } else resolve(dataUrlToBlob(c.toDataURL("image/png")));
      } catch (e) { reject(err("server", (e && e.message) || "Canvas failed")); }
    });
  }

  // Renders x² on a 120×60 canvas and transcribes it end to end.
  function test() {
    if (typeof document === "undefined") return Promise.resolve({ ok: false, message: "No canvas available in this environment" });
    return renderTestImage().then(function (blob) { return transcribe(blob); }).then(function (r) {
      return { ok: true, message: "Connected — the test image came back as " + r.latex + (r.warning ? " (" + r.warning + ")" : "") };
    }, function (e) {
      if (e && e.code === "no_math") return { ok: true, message: "Connected, but the model saw no math in the test image" };
      return { ok: false, message: (e && e.message) || "Transcription failed" };
    });
  }

  // --------------------------------------------------------------------- api

  var api = {
    INSTRUCTION: INSTRUCTION,
    CODES: CODES.slice(),
    DEFAULT_MODEL: DEFAULT_MODEL,
    TIMEOUT_MS: TIMEOUT_MS,
    detect: detect,
    transcribe: transcribe,
    postprocess: postprocess,
    wrap: wrap,
    test: test
  };
  M.vision = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17 M.vision):
 *   detect() → Promise<"artifact"|"apikey"|null>
 *   transcribe(blob, {signal}) → Promise<{latex, display, wrapped, cutOff}>   (+ warning: "May not render: …"|null)
 *   postprocess(raw) → {latex, display}   (throws code "no_math")
 *   wrap(latex, display) → string
 *   test() → Promise<{ok, message}>
 *   INSTRUCTION
 * Extras: CODES, DEFAULT_MODEL, TIMEOUT_MS.
 */
