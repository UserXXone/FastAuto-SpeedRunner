"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { planFrame } = require("../src/portal");

// Küçük sahte dünya: "x,y,z" -> blok türü. Verilmeyen her yer hava, y<64 toprak.
function world(blocks) {
  const m = new Map(Object.entries(blocks));
  return (x, y, z) => {
    const k = m.get(`${x},${y},${z}`);
    if (k === "obsidian") return { kind: "obsidian", dig: 60 };
    if (k === "crying") return { kind: "solid", dig: 60 };
    if (k === "dirt") return { kind: "solid", dig: 0.4 };
    if (k === "grass") return { kind: "soft", dig: 0.05 };
    if (k === "water") return { kind: "liquid" };
    if (k === "bedrock") return { kind: "fixed" };
    if (y < 64) return { kind: "solid", dig: 0.4 };
    return { kind: "air" };
  };
}

// z=0 düzleminde, sol alt köşesi (0,64) olan 4x5 çerçevenin köşesiz 10 bloğu.
function fullFrame() {
  const cells = [];
  for (let u = 0; u < 4; u++)
    for (let y = 64; y < 69; y++) {
      const eu = u === 0 || u === 3, ey = y === 64 || y === 68;
      if ((eu || ey) && !(eu && ey)) cells.push({ x: u, y, z: 0 });
    }
  return cells;
}
const asWorld = (cells, extra = {}) =>
  world({ ...Object.fromEntries(cells.map((c) => [`${c.x},${c.y},${c.z}`, "obsidian"])), ...extra });

test("tam çerçeve: koyulacak blok yok", () => {
  const f = fullFrame();
  const p = planFrame(f, asWorld(f), 0);
  assert.strictEqual(p.need, 0);
  assert.strictEqual(p.missing, 0);
  assert.deepStrictEqual([p.axis, p.fixed, p.u0, p.y0, p.w, p.h], ["x", 0, 0, 64, 4, 5]);
  assert.strictEqual(p.interior.length, 6);
});

test("iki blok eksik: tam o ikisini koyar", () => {
  const f = fullFrame().filter((c) => !(c.x === 3 && c.y === 66) && !(c.x === 1 && c.y === 68));
  const p = planFrame(f, asWorld(f), 2);
  assert.strictEqual(p.need, 2);
  assert.strictEqual(p.missing, 0);
  const keys = p.place.map((c) => `${c.x},${c.y},${c.z}`).sort();
  assert.deepStrictEqual(keys, ["1,68,0", "3,66,0"]);
});

test("obsidyen yetmiyorsa missing > 0", () => {
  const f = fullFrame().slice(0, 6);
  const p = planFrame(f, asWorld(f), 1);
  assert.strictEqual(p.need, 4);
  assert.strictEqual(p.missing, 3);
});

test("ağlayan obsidyen çerçevede: kırılıp yerine konur", () => {
  const f = fullFrame().filter((c) => !(c.x === 0 && c.y === 66));
  const p = planFrame(f, asWorld(f, { "0,66,0": "crying" }), 1);
  assert.strictEqual(p.need, 1);
  assert.deepStrictEqual(p.dig.map((c) => `${c.x},${c.y},${c.z}`), ["0,66,0"]);
});

test("içerideki ot ve toprak temizlenir", () => {
  const f = fullFrame();
  const p = planFrame(f, asWorld(f, { "1,65,0": "grass", "2,65,0": "dirt" }), 0);
  assert.strictEqual(p.need, 0);
  assert.strictEqual(p.dig.length, 2);
});

test("z ekseni boyunca duran portal", () => {
  const f = fullFrame().map((c) => ({ x: 7, y: c.y, z: c.x }));
  const p = planFrame(f, asWorld(f), 0);
  assert.deepStrictEqual([p.axis, p.fixed, p.need], ["z", 7, 0]);
  assert.ok(p.interior.every((c) => c.x === 7));
});

test("büyük yıkık çerçeve: küçük 4x5 daha ucuzsa onu seçer", () => {
  // Sol sütun (4 blok) ve alt sıra (6 blok) duruyor: dev bir portalın köşesi.
  const f = [];
  for (let y = 65; y <= 68; y++) f.push({ x: 0, y, z: 0 });
  for (let u = 1; u <= 6; u++) f.push({ x: u, y: 64, z: 0 });
  const p = planFrame(f, asWorld(f), 5);
  assert.deepStrictEqual([p.w, p.h, p.u0, p.y0], [4, 5, 0, 64]);
  assert.strictEqual(p.need, 5); // sağ sütun 3 + üst sıra 2
  assert.strictEqual(p.missing, 0);
});

test("kırılmaz blok olan çerçeve seçilmez", () => {
  const f = fullFrame().filter((c) => !(c.x === 3 && c.y === 66));
  const p = planFrame(f, asWorld(f, { "3,66,0": "bedrock" }), 5);
  assert.ok(p);
  assert.ok(!p.place.some((c) => c.x === 3 && c.y === 66 && c.z === 0));
});

test("obsidyen yoksa plan yok", () => {
  assert.strictEqual(planFrame([], world({}), 10), null);
});
