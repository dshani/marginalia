"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ws = require("../lib/windowstate");

const MAIN = { x: 0, y: 25, width: 1512, height: 920 };          // a laptop screen below the menu bar
const LEFT = { x: -1920, y: 0, width: 1920, height: 1055 };       // an external display to its left

test("no saved state: the default size, centred on the primary display", () => {
  const b = ws.sanitize(null, [MAIN], MAIN);
  assert.deepEqual(b, { x: 116, y: 55, width: 1280, height: 860, fullScreen: false });
});

test("a visible saved window is kept as it was", () => {
  const saved = { x: 100, y: 80, width: 1000, height: 700, fullScreen: false };
  assert.deepEqual(ws.sanitize(saved, [MAIN], MAIN), saved);
  const onLeft = { x: -1800, y: 40, width: 1200, height: 900, fullScreen: true };
  assert.deepEqual(ws.sanitize(onLeft, [MAIN, LEFT], MAIN), onLeft);
});

test("a window whose display is gone, or that lies far off screen, is centred on the primary display", () => {
  const onLeft = { x: -1800, y: 40, width: 1200, height: 900 };
  const b = ws.sanitize(onLeft, [MAIN], MAIN);
  assert.equal(b.x, 156);
  assert.equal(b.width, 1200);
  for (const saved of [{ x: 5000, y: 100, width: 800, height: 600 }, { x: 100, y: 5000, width: 800, height: 600 },
    { x: 100, y: -500, width: 800, height: 600 }, { x: 1450, y: 100, width: 800, height: 600 }]) {
    const c = ws.sanitize(saved, [MAIN], MAIN);
    assert.ok(c.x >= MAIN.x && c.x + c.width <= MAIN.x + MAIN.width, JSON.stringify(saved));
    assert.ok(c.y >= MAIN.y && c.y + c.height <= MAIN.y + MAIN.height, JSON.stringify(saved));
  }
});

test("a window with its title bar just inside is moved fully onto the screen", () => {
  const b = ws.sanitize({ x: 1300, y: 600, width: 800, height: 600 }, [MAIN], MAIN);
  assert.deepEqual(b, { x: 712, y: 345, width: 800, height: 600, fullScreen: false });
});

test("sizes are whole numbers, never below the minimum and never above the largest display", () => {
  const big = ws.sanitize({ x: 0, y: 25, width: 9000, height: 9000 }, [MAIN], MAIN);
  assert.equal(big.width, MAIN.width);
  assert.equal(big.height, MAIN.height);
  const tiny = ws.sanitize({ x: 10, y: 40, width: 50, height: 20 }, [MAIN], MAIN);
  assert.equal(tiny.width, ws.MIN_SIZE.width);
  assert.equal(tiny.height, ws.MIN_SIZE.height);
  const frac = ws.sanitize({ x: 10.4, y: 40.6, width: 900.5, height: 700.2 }, [MAIN], MAIN);
  assert.deepEqual(frac, { x: 10, y: 41, width: 901, height: 700, fullScreen: false });
});

test("junk in the file gives the default window", () => {
  for (const junk of [{ x: "a", y: null, width: NaN, height: Infinity }, [], "x", 7, { width: -5, height: 600, x: 0, y: 0 }]) {
    const b = ws.sanitize(junk, [MAIN], MAIN);
    assert.equal(b.width >= ws.MIN_SIZE.width, true);
    assert.ok(b.x >= MAIN.x && b.y >= MAIN.y, JSON.stringify(junk));
  }
  assert.equal(ws.parseSaved("{not json"), null);
  assert.equal(ws.parseSaved("[1,2]"), null);
  assert.deepEqual(ws.parseSaved('{"x":1}'), { x: 1 });
});

test("full-screen state is remembered only as true or false", () => {
  assert.equal(ws.sanitize({ x: 10, y: 40, width: 900, height: 700, fullScreen: true }, [MAIN], MAIN).fullScreen, true);
  assert.equal(ws.sanitize({ x: 10, y: 40, width: 900, height: 700, fullScreen: "yes" }, [MAIN], MAIN).fullScreen, false);
  assert.deepEqual(ws.snapshot({ x: 1, y: 2, width: 800, height: 600 }, true), { x: 1, y: 2, width: 800, height: 600, fullScreen: true });
  assert.equal(ws.snapshot(null, false), null);
});

test("no display information at all still gives a usable window", () => {
  const b = ws.sanitize({ x: 10, y: 10, width: 900, height: 700 }, [], null);
  assert.equal(b.width, 900);
  assert.ok(Number.isInteger(b.x) && Number.isInteger(b.y));
});
