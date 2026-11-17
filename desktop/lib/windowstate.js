"use strict";
// The main window's size, position and full-screen state, remembered in <userData>/window-state.json (pure parts).
//
// sanitize(saved, workAreas, primary) → {x, y, width, height, fullScreen}: a window that can always be seen and moved.
//   - width and height: whole numbers, at least MIN_SIZE, at most the largest display's work area (DEFAULT_SIZE when
//     missing or not numbers);
//   - its title bar (the top TITLE_BAR px) must lie on a display's work area, at least GRAB px of it across, else the
//     window is centred on the primary display (a display that was unplugged, a corrupt file, a saved position far
//     off screen);
//   - on that display it is made to fit inside the work area (smaller and moved in when needed).
const MIN_SIZE = Object.freeze({ width: 480, height: 400 });
const DEFAULT_SIZE = Object.freeze({ width: 1280, height: 860 });
const TITLE_BAR = 28;
const GRAB = 100;

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function area(a) {
  if (!a) return null;
  const x = num(a.x), y = num(a.y), width = num(a.width), height = num(a.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function centred(size, wa) {
  const width = Math.min(size.width, wa.width), height = Math.min(size.height, wa.height);
  return { x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height };
}

function fitInside(b, wa) {
  const width = Math.min(b.width, wa.width), height = Math.min(b.height, wa.height);
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height);
  return { x, y, width, height };
}

function sanitize(saved, workAreas, primary) {
  const s = saved && typeof saved === "object" ? saved : {};
  const areas = (Array.isArray(workAreas) ? workAreas : []).map(area).filter(Boolean);
  const main = area(primary) || areas[0] || { x: 0, y: 0, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  if (!areas.length) areas.push(main);
  const maxW = Math.max(...areas.map((a) => a.width)), maxH = Math.max(...areas.map((a) => a.height));
  let width = num(s.width), height = num(s.height);
  if (width === null || height === null || width <= 0 || height <= 0) { width = DEFAULT_SIZE.width; height = DEFAULT_SIZE.height; }
  width = Math.max(MIN_SIZE.width, Math.min(width, Math.max(maxW, MIN_SIZE.width)));
  height = Math.max(MIN_SIZE.height, Math.min(height, Math.max(maxH, MIN_SIZE.height)));
  const fullScreen = s.fullScreen === true;
  const x = num(s.x), y = num(s.y);
  if (x === null || y === null) return Object.assign(centred({ width, height }, main), { fullScreen });
  // the display that holds most of the title bar
  let best = null, bestArea = 0;
  for (const wa of areas) {
    const across = overlap(x, x + width, wa.x, wa.x + wa.width);
    const down = overlap(y, y + TITLE_BAR, wa.y, wa.y + wa.height);
    if (across >= Math.min(GRAB, width) && down >= TITLE_BAR / 2 && across * down > bestArea) { best = wa; bestArea = across * down; }
  }
  if (!best) return Object.assign(centred({ width, height }, main), { fullScreen });
  return Object.assign(fitInside({ x, y, width, height }, best), { fullScreen });
}

// What to save: the normal (not full-screen, not maximised) bounds and whether the window is full screen.
function snapshot(normalBounds, isFullScreen) {
  const b = area(normalBounds);
  if (!b) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height, fullScreen: !!isFullScreen };
}

function parseSaved(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch (e) { return null; }
}

module.exports = { sanitize, snapshot, parseSaved, MIN_SIZE, DEFAULT_SIZE, TITLE_BAR, GRAB };
