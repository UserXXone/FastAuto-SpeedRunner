"use strict";

// Yıkık portalı Nether portalına çevirme: yapıyı bul, sandığı al, en ucuz
// çerçeveyi planla, eksik obsidyenleri koy, yak ve içine gir.

const { Vec3 } = require("vec3");
const {
  goals: { GoalNear, GoalGetToBlock, GoalPlaceBlock },
} = require("mineflayer-pathfinder");
const A = require("./actions");
const { clusters } = require("./planner");

// Portalın iç boşluğu en az 2x3 olmalı: dış çerçeve en az 4 geniş, 5 yüksek.
const MIN_W = 4;
const MIN_H = 5;
const MAX_W = 12;
const MAX_H = 12;

// Maliyetler (saniye gibi düşün): plan seçerken kullanılır.
const COST_PLACE = 1.5;
const COST_MISSING = 500; // elimizde olmayan her obsidyen
const COST_LIQUID_IN = 8; // iç boşlukta su/lav (kapat + geri kır)
const COST_LIQUID_FRAME = 2;
const HARD_DIG = 15; // bundan uzun süren kırma "zor" sayılır

const AIR = new Set(["air", "cave_air", "void_air"]);
// Portalın içinde durabilen bloklar (oyun bunları "boş" sayar).
const PORTAL_EMPTY = new Set([...AIR, "fire", "soul_fire", "nether_portal"]);
// Sağ tıklayınca açılan bloklar: bunlara yaslayarak blok koyamayız.
const INTERACTABLE = new Set([
  "chest", "crafting_table", "furnace", "trapped_chest", "barrel", "lodestone",
]);

// ------------------------------------------------------------------ plan (saf)

function cellPos(axis, fixed, u, y) {
  return axis === "x" ? { x: u, y, z: fixed } : { x: fixed, y, z: u };
}

/**
 * En ucuz portal çerçevesini seçer. Minecraft'a bağlı değil, test edilebilir.
 *
 * obsidian: yapıdaki obsidyenler [{x,y,z}]
 * kindAt(x,y,z) -> { kind, dig }
 *    kind: "obsidian" | "air" | "soft" (ot, sarmaşık) | "liquid" | "solid" | "fixed" (kırılmaz)
 *    dig : kırma süresi (sn), "soft" ve "solid" için
 * have: envanterdeki obsidyen sayısı
 *
 * Dönen: { axis, fixed, u0, y0, w, h, place, dig, interior, need, missing, cost } ya da null.
 * Köşeler sayılmaz: oyun köşesiz çerçeveyi de yakar.
 */
function planFrame(obsidian, kindAt, have = 0, opts = {}) {
  const maxW = opts.maxW || MAX_W;
  const maxH = opts.maxH || MAX_H;
  const cache = new Map();
  const kind = (p) => {
    const k = `${p.x},${p.y},${p.z}`;
    let v = cache.get(k);
    if (!v) {
      v = kindAt(p.x, p.y, p.z) || { kind: "fixed" };
      cache.set(k, v);
    }
    return v;
  };

  const planes = new Map();
  for (const p of obsidian) {
    for (const [axis, fixed, u] of [["x", p.z, p.x], ["z", p.x, p.z]]) {
      const k = `${axis}:${fixed}`;
      if (!planes.has(k)) planes.set(k, { axis, fixed, cells: [] });
      planes.get(k).cells.push({ u, y: p.y });
    }
  }
  // En çok obsidyenli birkaç düzlem yeter.
  const candidates = [...planes.values()]
    .sort((a, b) => b.cells.length - a.cells.length)
    .slice(0, 6);

  let best = null;
  for (const pl of candidates) {
    const us = pl.cells.map((c) => c.u);
    const ys = pl.cells.map((c) => c.y);
    const minU = Math.min(...us), maxU = Math.max(...us);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    for (let w = MIN_W; w <= maxW; w++) {
      for (let h = MIN_H; h <= maxH; h++) {
        for (let u0 = minU - w + 1; u0 <= maxU; u0++) {
          for (let y0 = minY - h + 1; y0 <= maxY; y0++) {
            const r = rateFrame(pl, u0, y0, w, h, kind, have, best ? best.cost : Infinity);
            if (r && (!best || r.cost < best.cost)) best = r;
          }
        }
      }
    }
  }
  return best;
}

function rateFrame(pl, u0, y0, w, h, kind, have, limit) {
  const place = [];
  const dig = [];
  const interior = [];
  const liquid = []; // iç boşluktaki lav/su hücreleri
  let hard = 0; // kırması uzun süren blok (ağlayan obsidyen gibi)
  let cost = w * h * 0.01; // eşitlikte küçük çerçeve
  let have_ = 0;
  for (let u = u0; u < u0 + w; u++) {
    for (let y = y0; y < y0 + h; y++) {
      const edgeU = u === u0 || u === u0 + w - 1;
      const edgeY = y === y0 || y === y0 + h - 1;
      if (edgeU && edgeY) continue; // köşe
      const p = cellPos(pl.axis, pl.fixed, u, y);
      const k = kind(p);
      if (edgeU || edgeY) {
        if (k.kind === "obsidian") {
          have_++;
          continue;
        }
        if (k.kind === "fixed") return null;
        place.push(p);
        cost += COST_PLACE;
        if (k.kind === "liquid") cost += COST_LIQUID_FRAME;
        else if (k.kind !== "air") {
          dig.push(p);
          cost += (k.dig || 0) + 0.5;
          if (k.dig > HARD_DIG) hard++;
        }
      } else {
        interior.push(p);
        if (k.kind === "air") continue;
        if (k.kind === "fixed") return null;
        if (k.kind === "liquid") {
          liquid.push(p);
          cost += COST_LIQUID_IN;
        } else {
          dig.push(p);
          cost += (k.kind === "obsidian" ? k.dig || 250 : k.dig || 0) + 0.5;
          if (k.kind === "obsidian" || k.dig > HARD_DIG) hard++;
        }
      }
      if (cost >= limit) return null;
    }
  }
  if (have_ === 0) return null; // hiç obsidyeni olmayan çerçeve bu yapıya ait değil
  const missing = Math.max(0, place.length - have);
  const seconds = Math.round(cost); // koyma + kırma süresi tahmini (eksik obsidyen hariç)
  cost += missing * COST_MISSING;
  return {
    axis: pl.axis, fixed: pl.fixed, u0, y0, w, h,
    place, dig, interior, liquid, need: place.length, missing, hard, seconds, cost,
  };
}

// ------------------------------------------------------------------ dünyayı oku

function idsOf(bot, names) {
  return names.map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id);
}

// (x,z) çevresindeki yıkık portalı bulur. Yeraltındaki doğal obsidyenle
// karışmasın diye sandığa/ağlayan obsidyene en yakın kümeyi seçer.
function findRuin(bot, x, z, radius = 40, y = null) {
  const point = new Vec3(x, y == null ? bot.entity.position.y : y, z);
  const near = (p) => Math.hypot(p.x - x, p.z - z) <= radius;
  const find = (names, count) =>
    bot.findBlocks({ point, matching: idsOf(bot, names), maxDistance: 140, count }).filter(near);
  const obsidian = find(["obsidian"], 600);
  const crying = find(["crying_obsidian"], 300);
  const chests = find(["chest"], 20);
  if (!obsidian.length) return null;

  const groups = clusters([...obsidian, ...crying], 4.5);
  const score = (g) => {
    const c = g[0];
    const chestNear = chests.some((ch) => ch.distanceTo(c) <= 14);
    const hasCrying = g.some((p) => crying.includes(p));
    return g.length + (chestNear ? 100 : 0) + (hasCrying ? 50 : 0);
  };
  const g = groups.sort((a, b) => score(b) - score(a))[0];
  const inGroup = new Set(g);
  const obs = obsidian.filter((p) => inGroup.has(p));
  const center = obs.reduce((s, p) => s.plus(p), new Vec3(0, 0, 0)).scaled(1 / obs.length);
  const chest = chests
    .filter((c) => c.distanceTo(center) <= 16)
    .sort((a, b) => a.distanceTo(center) - b.distanceTo(center))[0];
  return { obsidian: obs, crying: crying.filter((p) => inGroup.has(p)), chest: chest || null, center };
}

// planFrame için: dünyadaki bloğu sınıflandırır.
// assumeTools verilirse kırma süresi o aletlere göre hesaplanır (doğrulayıcı için:
// keşif botunun envanteri boş, koşudaki bot ise taş kazmayla gelir). Verilmezse
// botun envanterindeki en hızlı alet kullanılır.
function kindAtFor(bot, assumeTools = null) {
  const types = assumeTools
    ? assumeTools.map((n) => bot.registry.itemsByName[n]).filter(Boolean).map((i) => i.id)
    : null;
  const digSeconds = (b) => {
    if (!types) return A.fastestTool(bot, b).seconds;
    return Math.min(...[null, ...types].map((t) => b.digTime(t, false, false, false, [], {}))) / 1000;
  };
  return (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) return { kind: "fixed" };
    if (PORTAL_EMPTY.has(b.name)) return { kind: "air" };
    if (b.name === "water" || b.name === "lava" || b.name === "bubble_column") return { kind: "liquid" };
    if (b.hardness == null || b.hardness < 0) return { kind: "fixed" };
    const dig = digSeconds(b);
    if (b.name === "obsidian") return { kind: "obsidian", dig };
    return { kind: b.boundingBox === "empty" ? "soft" : "solid", dig, name: b.name };
  };
}

// ------------------------------------------------------------------ sandık

// Yıkık portal sandığından işe yarayanları al.
const CHEST_WANT = (name) =>
  [
    "obsidian", "flint_and_steel", "fire_charge", "flint", "iron_nugget",
    "gold_nugget", "gold_ingot", "gold_block", "golden_apple",
    "enchanted_golden_apple", "golden_carrot", "golden_helmet",
    "golden_chestplate", "golden_leggings", "golden_boots", "golden_sword",
    "golden_axe", "golden_pickaxe", "golden_shovel",
  ].includes(name);

async function lootChest(bot, pos) {
  const above = bot.blockAt(pos.offset(0, 1, 0));
  if (above && above.boundingBox === "block") {
    // Üstü kapalı sandık açılmaz.
    await A.mineBlock(bot, above.position, { collect: false, force: true });
  }
  for (let i = 0; i < 3 && A.eyeDistance(bot, pos) > 3.5; i++) {
    await A.goto(bot, new GoalGetToBlock(pos.x, pos.y, pos.z), 30000);
    if (A.eyeDistance(bot, pos) > 3.5) await A.goto(bot, new GoalNear(pos.x, pos.y, pos.z, 3), 30000);
  }
  if (A.eyeDistance(bot, pos) > 5) throw new Error("Sandığa ulaşılamadı");
  const win = await bot.openContainer(bot.blockAt(pos));
  const taken = {};
  try {
    for (const it of win.containerItems()) {
      if (!CHEST_WANT(it.name)) continue;
      try {
        await win.withdraw(it.type, null, it.count, it.nbt);
        taken[it.name] = (taken[it.name] || 0) + it.count;
      } catch (err) {
        A.dbg("sandıktan alınamadı:", it.name, err.message);
      }
    }
  } finally {
    win.close();
  }
  await A.sleep(200);
  return taken;
}

// Yeraltındaki yıkık portalın yanına in: yapının hemen yanındaki bir sütundan düz
// aşağı kaz (sandığın ya da çerçevenin üstüne değil), olmazsa yol bulucuya bırak.
async function descendTo(bot, ruin) {
  const c = ruin.center.floored();
  const target = ruin.chest || c;
  const taken = new Set([...ruin.obsidian, ...ruin.crying, ...(ruin.chest ? [ruin.chest] : [])].map((p) => `${p.x},${p.z}`));
  let spot = null;
  for (let r = 2; r <= 5 && !spot; r++) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      if (!taken.has(`${target.x + dx},${target.z + dz}`)) {
        spot = new Vec3(target.x + dx, target.y, target.z + dz);
        break;
      }
    }
  }
  if (spot) await A.approach(bot, spot);
  if (bot.entity.position.y - c.y > 6)
    await A.goto(bot, new GoalNear(c.x, c.y, c.z, 4), 90000);
}

// Altın zırh: piglinler saldırmasın (Nether için).
async function wearGold(bot) {
  const slots = { golden_helmet: "head", golden_chestplate: "torso", golden_leggings: "legs", golden_boots: "feet" };
  for (const it of bot.inventory.items()) {
    if (!slots[it.name]) continue;
    try {
      await bot.equip(it, slots[it.name]);
      return it.name;
    } catch (err) {
      A.dbg("zırh giyilemedi:", err.message);
    }
  }
  return null;
}

// ------------------------------------------------------------------ blok koyma

const NEIGHBORS = [
  [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0],
];

function solidRefs(bot, pos) {
  const out = [];
  for (const d of NEIGHBORS) {
    const b = bot.blockAt(pos.offset(d[0], d[1], d[2]));
    if (b && b.boundingBox === "block" && !INTERACTABLE.has(b.name)) {
      out.push({ block: b, face: new Vec3(-d[0], -d[1], -d[2]), dir: new Vec3(d[0], d[1], d[2]) });
    }
  }
  return out;
}

function eyePos(bot) {
  return bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
}

function standingIn(bot, pos) {
  const p = bot.entity.position;
  return (
    p.x + 0.3 > pos.x && p.x - 0.3 < pos.x + 1 &&
    p.z + 0.3 > pos.z && p.z - 0.3 < pos.z + 1 &&
    p.y + 1.8 > pos.y && p.y < pos.y + 1
  );
}

// pos'a itemName bloğunu koyar. Komşu sağlam blok yoksa false döner.
async function placeBlockAt(bot, pos, itemName) {
  pos = new Vec3(pos.x, pos.y, pos.z);
  for (let attempt = 0; attempt < 4; attempt++) {
    const spot = bot.blockAt(pos);
    if (spot && spot.name === itemName) return true;
    if (spot && !AIR.has(spot.name) && spot.name !== "water" && spot.name !== "lava") {
      await A.mineBlock(bot, pos, { collect: false, force: true });
    }
    const refs = solidRefs(bot, pos);
    if (!refs.length) return false;
    const goal = new GoalPlaceBlock(pos, bot.world, {
      range: attempt < 2 ? 4 : 3,
      faces: refs.map((r) => r.dir),
      LOS: false,
    });
    await A.goto(bot, goal, 25000);
    if (standingIn(bot, pos)) {
      await A.goto(bot, new GoalNear(pos.x, pos.y, pos.z, 2), 5000);
      if (standingIn(bot, pos)) continue;
    }
    const eye = eyePos(bot);
    const ref = refs
      .map((r) => ({ ...r, d: eye.distanceTo(r.block.position.offset(0.5 + r.face.x * 0.5, 0.5 + r.face.y * 0.5, 0.5 + r.face.z * 0.5)) }))
      .sort((a, b) => a.d - b.d)[0];
    if (ref.d > 5) continue;
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) throw new Error(`Envanterde yok: ${itemName}`);
    try {
      await bot.equip(item, "hand");
      await bot.placeBlock(ref.block, ref.face);
    } catch (err) {
      A.dbg("blok koyulamadı:", itemName, pos.toString(), err.message);
      await A.sleep(250);
    }
  }
  const b = bot.blockAt(pos);
  return Boolean(b && b.name === itemName);
}

const FILLERS = ["cobblestone", "dirt", "netherrack", "cobbled_deepslate", "stone", "andesite", "diorite", "granite"];

// Havada kalan çerçeve bloğu için yanına geçici bir destek bloğu koyar.
async function placeSupport(bot, pos, forbidden) {
  const filler = bot.inventory.items().find((i) => FILLERS.includes(i.name));
  if (!filler) return false;
  for (const d of NEIGHBORS) {
    const q = pos.offset(d[0], d[1], d[2]);
    if (forbidden.has(q.toString())) continue;
    const b = bot.blockAt(q);
    if (!b || !A.isAirLike(b)) continue;
    if (!solidRefs(bot, q).length) continue;
    if (await placeBlockAt(bot, q, filler.name)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ çerçeveyi tamamla

const isLiquidBlock = (b) => Boolean(b && (b.name === "lava" || b.name === "water"));

function fillerItem(bot) {
  return bot.inventory.items().find((i) => FILLERS.includes(i.name));
}

// Portalın içindeki lav/suyu kurutur: önce içeriye sıvı taşıyan komşu hücreleri
// (çerçeve düzleminin iki yanı) kalıcı olarak taşla kapatır, sonra içerideki sıvı
// hücrelerine taş koyup geri kırar.
async function dryInterior(bot, plan, say) {
  const v = (p) => new Vec3(p.x, p.y, p.z);
  const normal = plan.axis === "x" ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  say(`  portalın içinde ${plan.liquid.length} lav/su var, kurutuyorum`);
  for (let round = 0; round < 3; round++) {
    const wet = plan.interior.map(v).filter((p) => isLiquidBlock(bot.blockAt(p)));
    if (!wet.length) return;
    // Yanlardan ve üstten içeriye akabilecek sıvılar.
    const sides = [];
    for (const p of plan.interior.map(v)) {
      for (const q of [p.plus(normal), p.minus(normal)]) {
        if (isLiquidBlock(bot.blockAt(q))) sides.push(q);
      }
    }
    for (const q of sides.sort((a, b) => a.y - b.y)) {
      const f = fillerItem(bot);
      if (!f) throw new Error("Lavı/suyu kapatacak blok kalmadı");
      await placeBlockAt(bot, q, f.name);
    }
    for (const p of wet.sort((a, b) => a.y - b.y)) {
      const f = fillerItem(bot);
      if (!f) throw new Error("Lavı/suyu kapatacak blok kalmadı");
      if (await placeBlockAt(bot, p, f.name))
        await A.mineBlock(bot, p, { collect: false, force: true });
    }
    await A.sleep(600); // akan sıvı çekilsin
  }
}

async function buildFrame(bot, plan, say = () => {}) {
  const v = (p) => new Vec3(p.x, p.y, p.z);

  // 1) Engelleri kaldır (iç boşluk tamamen boş olmalı).
  for (const p of plan.dig) {
    const b = bot.blockAt(v(p));
    if (!b || PORTAL_EMPTY.has(b.name)) continue;
    const ok = await A.mineBlock(bot, v(p), { collect: false, force: true });
    if (!ok) A.dbg("engel kaldırılamadı:", b.name, v(p).toString());
  }

  // 1b) İç boşlukta lav/su varsa kurut.
  if (plan.liquid.length) await dryInterior(bot, plan, say);

  // 2) Eksik obsidyenleri koy: aşağıdan yukarı, her seferinde komşusu olan bir hücre.
  const forbidden = new Set([...plan.interior, ...plan.place].map((p) => v(p).toString()));
  const pending = plan.place.map(v).sort((a, b) => a.y - b.y);
  let supports = 0;
  while (pending.length) {
    let i = pending.findIndex((p) => solidRefs(bot, p).length > 0);
    if (i < 0) {
      if (supports++ > 6 || !(await placeSupport(bot, pending[0], forbidden)))
        throw new Error("Portal çerçevesi havada kalıyor, destek bloğu koyulamadı");
      continue;
    }
    const p = pending.splice(i, 1)[0];
    if (!(await placeBlockAt(bot, p, "obsidian")))
      throw new Error(`Obsidyen koyulamadı: ${p}`);
    say(`  obsidyen kondu (${plan.place.length - pending.length}/${plan.place.length})`);
  }

  // 3) Son kontrol: iç boşlukta bir şey kaldı mı (dökülen blok, yeni büyüyen ot)?
  for (const p of plan.interior) {
    const b = bot.blockAt(v(p));
    if (b && !PORTAL_EMPTY.has(b.name) && b.name !== "water" && b.name !== "lava")
      await A.mineBlock(bot, v(p), { collect: false, force: true });
  }
  const blocked = plan.interior.map(v).map((p) => bot.blockAt(p)).filter((b) => b && !PORTAL_EMPTY.has(b.name));
  if (blocked.length)
    throw new Error(`Portalın içi boşaltılamadı: ${blocked[0].name} ${blocked[0].position}`);
}

// ------------------------------------------------------------------ yak + gir

// Çakmak ya da ateş topu var mı; yoksa çakmaktaşı + demirden çakmak yap.
async function ensureFire(bot) {
  const has = (n) => A.count(bot, n) > 0;
  if (has("flint_and_steel")) return "flint_and_steel";
  if (has("fire_charge")) return "fire_charge";
  if (!has("flint")) return null;
  if (!has("iron_ingot") && A.count(bot, "iron_nugget") >= 9) {
    const table = await A.ensureTable(bot);
    await A.craft(bot, "iron_ingot", 1, table);
  }
  if (!has("iron_ingot")) return null;
  await A.craft(bot, "flint_and_steel", 1);
  return has("flint_and_steel") ? "flint_and_steel" : null;
}

function bottomCells(plan) {
  const y = plan.y0 + 1;
  return plan.interior.filter((p) => p.y === y).map((p) => new Vec3(p.x, p.y, p.z));
}

function isLit(bot, plan) {
  return bottomCells(plan).some((p) => {
    const b = bot.blockAt(p);
    return b && b.name === "nether_portal";
  });
}

async function lightPortal(bot, plan) {
  if (isLit(bot, plan)) return true;
  const fire = await ensureFire(bot);
  if (!fire) throw new Error("Portalı yakacak bir şey yok (çakmak / ateş topu / çakmaktaşı + demir)");
  const cells = bottomCells(plan);
  for (let attempt = 0; attempt < 4; attempt++) {
    const cell = cells[attempt % cells.length];
    const floor = bot.blockAt(cell.offset(0, -1, 0));
    if (!floor || floor.name !== "obsidian") continue;
    if (A.eyeDistance(bot, floor.position) > 3.5) {
      await A.goto(bot, new GoalNear(cell.x, cell.y, cell.z, 2), 20000);
    }
    const item = bot.inventory.items().find((i) => i.name === fire);
    if (!item) break;
    await bot.equip(item, "hand");
    await bot.activateBlock(floor, new Vec3(0, 1, 0));
    for (let i = 0; i < 20 && !isLit(bot, plan); i++) await A.sleep(100);
    if (isLit(bot, plan)) return true;
    A.dbg("portal yanmadı, tekrar deniyorum");
  }
  return false;
}

// Portalın içine yürü ve boyut değişene kadar bekle.
async function enterPortal(bot, plan, timeoutMs = 45000) {
  const from = bot.game.dimension;
  const cells = bottomCells(plan);
  const target = cells[Math.floor((cells.length - 1) / 2)];
  const center = target.offset(0.5, 0, 0.5);
  const t0 = Date.now();
  while (bot.game.dimension === from && Date.now() - t0 < timeoutMs) {
    const p = bot.entity.position;
    const flat = Math.hypot(p.x - center.x, p.z - center.z);
    if (flat > 3 || Math.abs(p.y - center.y) > 1.5) {
      await A.goto(bot, new GoalNear(target.x, target.y, target.z, 1), 15000);
    } else if (flat > 0.35) {
      await bot.lookAt(center.offset(0, 1.6, 0), true);
      bot.setControlState("forward", true);
      bot.setControlState("jump", bot.entity.isCollidedHorizontally);
    } else {
      bot.clearControlStates();
    }
    await A.sleep(50);
  }
  bot.clearControlStates();
  return bot.game.dimension !== from;
}

module.exports = {
  planFrame,
  findRuin,
  kindAtFor,
  lootChest,
  descendTo,
  wearGold,
  placeBlockAt,
  buildFrame,
  ensureFire,
  lightPortal,
  enterPortal,
  MIN_W,
  MIN_H,
};
