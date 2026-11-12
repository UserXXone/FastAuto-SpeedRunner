"use strict";

// Overworld hazırlığı: Nether'a girmeden önce lazım olanlar.
//   yedek kazmalar (tünel için), demir (kalkan, kova, çakmak), altın zırh,
//   çakmaktaşı. Sandıktan çıkanlara göre neyin eksik olduğuna burada karar verilir.

const { Vec3 } = require("vec3");
const A = require("./actions");
const H = require("./highway");
const { scanLoaded } = require("./scanner");
const { clusters, cost, center } = require("./planner");

const STONE_BLOCKS = ["stone", "deepslate", "cobblestone", "cobbled_deepslate"];
const IRON_ORES = ["iron_ore", "deepslate_iron_ore"];
const PICKAXES_WANTED = 4; // taş kazma 131 blokta kırılır; tünel + blok toplama ~400 blok

const has = (bot, name) => A.count(bot, name) > 0;
const pickaxes = (bot) => A.count(bot, (i) => i.name.endsWith("_pickaxe"));

async function ensureCobble(bot, n) {
  if (A.count(bot, A.isCobble) >= n) return true;
  await A.gatherNearest(bot, STONE_BLOCKS, A.isCobble, n, { maxDistance: 32 });
  return A.count(bot, A.isCobble) >= n;
}

// Yedek taş kazmalar.
async function makeSparePickaxes(bot, want = PICKAXES_WANTED) {
  let table = null;
  while (pickaxes(bot) < want) {
    if (!(await ensureCobble(bot, 3))) break;
    await A.ensureSticks(bot, 2);
    table = table || (await A.ensureTable(bot));
    const before = pickaxes(bot);
    await A.craft(bot, "stone_pickaxe", 1, table);
    if (pickaxes(bot) <= before) break;
  }
  return pickaxes(bot);
}

// 9 demir parçası = 1 külçe.
async function nuggetsToIngots(bot, wantIngots) {
  let table = null;
  while (A.count(bot, "iron_ingot") < wantIngots && A.count(bot, "iron_nugget") >= 9) {
    table = table || (await A.ensureTable(bot));
    const before = A.count(bot, "iron_ingot");
    await A.craft(bot, "iron_ingot", 1, table);
    if (A.count(bot, "iron_ingot") <= before) break;
  }
  return A.count(bot, "iron_ingot");
}

// Bir bloğa ulaşıp kaz. Yol bulucu ulaşamazsa (dağın içi, mağara) dümdüz tünel
// açarak yanına git.
async function reachAndMine(bot, pos, expect) {
  if (await A.mineBlock(bot, pos, { expect })) return true;
  const b = bot.blockAt(pos);
  if (!b || !expect(b)) return false;
  // Cevherin yanındaki bir hücreye tünel aç (ayak hizası cevherle aynı ya da bir altı).
  const me = bot.entity.position;
  const spots = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [0, -1]) spots.push(pos.offset(dx, dy, dz));
  }
  spots.sort((p, q) => p.distanceTo(me) - q.distanceTo(me));
  const r = await H.highway(bot, spots[0], { maxMs: 90000 });
  A.dbg("cevhere tünel:", r, spots[0].toString());
  if (r !== "arrived") return false;
  return A.mineBlock(bot, pos, { expect });
}

// Demir cevheri kaz, fırında erit. n külçe olana kadar.
async function mineIron(bot, n, say = () => {}) {
  const have = () => A.count(bot, "iron_ingot");
  const raw = () => A.count(bot, "raw_iron");
  const missing = n - have();
  if (missing <= 0) return have();
  const isOre = (b) => IRON_ORES.includes(b.name);
  // Yüklü chunk'lardaki cevherler; aşağı inmek ucuz, yukarı çıkmak pahalı sayılır.
  const me = bot.entity.position;
  const ores = scanLoaded(bot, me, 96).iron.filter((o) => !o.wet);
  const veins = clusters(ores, 1.8)
    .map((v) => ({ v, c: cost(me, center(v)) - (v.some((o) => o.exposed) ? 8 : 0) - Math.min(v.length, missing) * 3 }))
    .sort((a, b) => a.c - b.c);
  say(`Demir: ${ores.length} cevher görünüyor, ${missing} tane lazım`);
  let failures = 0;
  for (const { v } of veins) {
    if (raw() >= missing || failures >= 4) break;
    let ok = 0;
    for (const o of v) {
      if (raw() >= missing) break;
      if (await reachAndMine(bot, new Vec3(o.x, o.y, o.z), isOre)) ok++;
      else if (!ok) break; // damara ulaşılamadı: sıradaki damar
    }
    if (!ok) failures++;
  }
  if (!raw()) {
    say("Demir cevherine ulaşılamadı");
    return have();
  }
  if (!has(bot, "furnace")) {
    if (!(await ensureCobble(bot, 8))) {
      say("Fırın için taş yetmedi");
      return have();
    }
    const table = await A.ensureTable(bot);
    await A.craft(bot, "furnace", 1, table);
  }
  const count = raw();
  const fuel = Math.ceil(count / 1.5) + 1; // bir tahta 1,5 eşya eritir
  await A.ensurePlanks(bot, fuel).catch(() => {});
  await A.smelt(bot, "raw_iron", count, A.isPlanks, Math.min(fuel, A.count(bot, A.isPlanks)));
  return have();
}

// Çakmaktaşı: çakıl kaz (her çakılda %10).
async function getFlint(bot, maxGravel = 40) {
  if (has(bot, "flint")) return true;
  const isFlintOrGravel = (i) => i.name === "flint" || i.name === "gravel";
  for (let i = 0; i < maxGravel && !has(bot, "flint"); i++) {
    const before = A.count(bot, isFlintOrGravel);
    const ok = await A.gatherNearest(bot, ["gravel"], isFlintOrGravel, before + 1, { maxDistance: 48 });
    if (!ok) break;
    // Çakıl düştüyse yere koyup tekrar kırmak yerine yenisine git; elde biriken çakıl önemli değil.
  }
  return has(bot, "flint");
}

// Altın zırh yoksa sandıktaki altından çizme yap (4 külçe). Piglinler saldırmasın.
async function makeGoldBoots(bot) {
  const table = await A.ensureTable(bot);
  while (A.count(bot, "gold_ingot") < 4 && A.count(bot, "gold_nugget") >= 9) {
    const before = A.count(bot, "gold_ingot");
    await A.craft(bot, "gold_ingot", 1, table);
    if (A.count(bot, "gold_ingot") <= before) break;
  }
  if (A.count(bot, "gold_ingot") < 4) return false;
  await A.craft(bot, "golden_boots", 1, table);
  return has(bot, "golden_boots");
}

async function makeShield(bot) {
  if (has(bot, "shield") || (bot.inventory.slots[45] && bot.inventory.slots[45].name === "shield")) return true;
  if (!has(bot, "iron_ingot")) return false;
  await A.ensurePlanks(bot, 6);
  const table = await A.ensureTable(bot);
  await A.craft(bot, "shield", 1, table);
  return has(bot, "shield");
}

async function makeBuckets(bot, n) {
  const count = () => A.count(bot, (i) => i.name === "bucket" || i.name === "water_bucket" || i.name === "lava_bucket");
  const table = await A.ensureTable(bot);
  while (count() < n && A.count(bot, "iron_ingot") >= 3) {
    const before = count();
    await A.craft(bot, "bucket", 1, table);
    if (count() <= before) break;
  }
  return count();
}

async function makeFlintAndSteel(bot) {
  if (has(bot, "flint_and_steel")) return true;
  if (!has(bot, "flint") || !has(bot, "iron_ingot")) return false;
  await A.craft(bot, "flint_and_steel", 1);
  return has(bot, "flint_and_steel");
}

module.exports = {
  PICKAXES_WANTED,
  pickaxes,
  ensureCobble,
  makeSparePickaxes,
  nuggetsToIngots,
  mineIron,
  getFlint,
  makeGoldBoots,
  makeShield,
  makeBuckets,
  makeFlintAndSteel,
};
