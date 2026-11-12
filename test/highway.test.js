"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { Vec3 } = require("vec3");
const { planLevel, cellOf } = require("../src/highway");

const SOLID = { name: "netherrack", boundingBox: "block" };
const AIR = { name: "air", boundingBox: "empty" };
const LAVA = { name: "lava", boundingBox: "empty" };

// Sahte bot: kind(y) o yükseklikteki bloğu verir (x,z fark etmez).
function botWith(kind) {
  return { blockAt: (p) => kind(p.y, p.x, p.z) };
}

test("tamamen kaya olan hat: hedef yüksekliği seçilir, açık hava yok", () => {
  const bot = botWith(() => SOLID);
  const r = planLevel(bot, new Vec3(0, 50, 0), new Vec3(10, 50, 0));
  assert.strictEqual(r.y, 50);
  assert.strictEqual(r.air, 0);
  assert.strictEqual(r.lava, 0);
});

test("her yer hava ama bir kaya katmanı var: kaya katmanı tercih edilir", () => {
  // y=45 ve y=46 katı, gerisi hava.
  const bot = botWith((y) => (y === 45 || y === 46 ? SOLID : AIR));
  const r = planLevel(bot, new Vec3(0, 50, 0), new Vec3(10, 50, 0));
  assert.strictEqual(r.y, 45);
  assert.strictEqual(r.air, 0);
});

test("açık hava adım başına sayılır", () => {
  const bot = botWith(() => AIR);
  const r = planLevel(bot, new Vec3(0, 50, 0), new Vec3(10, 50, 0));
  assert.strictEqual(r.air, 10);
  assert.strictEqual(r.y, 50);
});

test("lav olan yükseklik seçilmez", () => {
  // Hedef yükseklikte (y=50..52) lav, geri kalan her yer kaya.
  const bot = botWith((y) => (y >= 50 && y <= 52 ? LAVA : SOLID));
  const r = planLevel(bot, new Vec3(0, 50, 0), new Vec3(10, 50, 0));
  assert.notStrictEqual(r.y, 50);
  assert.strictEqual(r.lava, 0);
});

test("lavın hemen altındaki yükseklik de elenir (üç blok yukarıya bakılır)", () => {
  // y=52 lav: y=50 (y+2) ve y=51 lav sayılır; y=49 temiz.
  const bot = botWith((y) => (y === 52 ? LAVA : SOLID));
  const r = planLevel(bot, new Vec3(0, 50, 0), new Vec3(10, 50, 0));
  assert.strictEqual(r.lava, 0);
  assert.ok(r.y <= 49);
});

test("from === dest: patlamaz, hedef yüksekliği döner", () => {
  const bot = botWith(() => SOLID);
  const p = new Vec3(5, 50, 5);
  const r = planLevel(bot, p, p);
  assert.strictEqual(r.y, 50);
  assert.strictEqual(r.air, 0);
});

test("minY altına inilmez", () => {
  const bot = botWith((y) => (y < 45 ? SOLID : AIR));
  const r = planLevel(bot, new Vec3(0, 50, 0), new Vec3(10, 50, 0), 48);
  assert.ok(r.y >= 48);
});

test("yüklenmemiş (null) bloklar açık hava gibi sayılır", () => {
  const bot = { blockAt: () => null };
  const r = planLevel(bot, new Vec3(0, 50, 0), new Vec3(4, 50, 0));
  assert.strictEqual(r.air, 4);
  assert.strictEqual(r.lava, 0);
});

test("cellOf: konumu tam sayı hücreye yuvarlar (aşağı)", () => {
  const bot = { entity: { position: new Vec3(10.7, 64, -3.2) } };
  const c = cellOf(bot);
  assert.deepStrictEqual([c.x, c.y, c.z], [10, 64, -4]);
});

test("cellOf: y'deki küçük sapma (basamak üstü 0.5) hücreyi değiştirmez, 63.995 yukarı sayılır", () => {
  assert.strictEqual(cellOf({ entity: { position: new Vec3(0.5, 64.5, 0.5) } }).y, 64);
  assert.strictEqual(cellOf({ entity: { position: new Vec3(0.5, 63.995, 0.5) } }).y, 64);
  assert.strictEqual(cellOf({ entity: { position: new Vec3(0.5, 63.9, 0.5) } }).y, 63);
});
