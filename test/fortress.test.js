"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { Vec3 } = require("vec3");
const { inRoom, hideout, atHideout } = require("../src/fortress");

const S = new Vec3(100, 70, -50);

test("inRoom: spawner'ın ±2 yatay ve üstündeki 3 katlık oda içeride", () => {
  assert.ok(inRoom(S, new Vec3(100.5, 70, -49.5)));
  assert.ok(inRoom(S, new Vec3(102.9, 72.9, -47.1))); // x=102, z=-48 hücresi
  assert.ok(inRoom(S, new Vec3(98, 71, -52)));
});

test("inRoom: yatayda 3 blok uzak dışarıda", () => {
  assert.ok(!inRoom(S, new Vec3(103.5, 70, -50)));
  assert.ok(!inRoom(S, new Vec3(100, 70, -53)));
  assert.ok(!inRoom(S, new Vec3(97.5, 70, -50)));
});

test("inRoom: dikeyde spawner.y-0.5 ile spawner.y+3 arası", () => {
  assert.ok(inRoom(S, new Vec3(100.5, 69.5, -49.5)));
  assert.ok(!inRoom(S, new Vec3(100.5, 69.4, -49.5)));
  assert.ok(inRoom(S, new Vec3(100.5, 72.99, -49.5)));
  assert.ok(!inRoom(S, new Vec3(100.5, 73, -49.5)));
});

test("hideout: spawner'ın tam 2 altı", () => {
  const h = hideout(S);
  assert.deepStrictEqual([h.x, h.y, h.z], [100, 68, -50]);
});

test("hideout: spawner'ı değiştirmez", () => {
  hideout(S);
  assert.deepStrictEqual([S.x, S.y, S.z], [100, 70, -50]);
});

test("atHideout: saklanma hücresinde doğru, başka yerde yanlış", () => {
  const at = (x, y, z) => atHideout({ entity: { position: new Vec3(x, y, z) } }, S);
  assert.ok(at(100.5, 68, -49.5));
  assert.ok(!at(101.5, 68, -49.5)); // yan hücre
  assert.ok(!at(100.5, 69, -49.5)); // bir kat yukarı
  assert.ok(!at(100.5, 67, -49.5)); // bir kat aşağı
});
