"use strict";

// Botun temel becerileri: yürü, kaz, topla, craft et, blok koy, erit.

const { Vec3 } = require("vec3");
const {
  goals: { GoalGetToBlock, GoalNear, GoalNearXZ, GoalY, GoalBlock },
} = require("mineflayer-pathfinder");

const dbg = (...a) => {
  if (process.env.DEBUG)
    console.log("  ·", new Date().toISOString().slice(14, 21), ...a);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function itemId(bot, name) {
  const it = bot.registry.itemsByName[name];
  if (!it) throw new Error(`Bilinmeyen eşya: ${name}`);
  return it.id;
}

function count(bot, match) {
  const test = typeof match === "function" ? match : (i) => i.name === match;
  return bot.inventory
    .items()
    .filter(test)
    .reduce((s, i) => s + i.count, 0);
}

const isLog = (i) => i.name.endsWith("_log") && !i.name.startsWith("stripped");
const isPlanks = (i) => i.name.endsWith("_planks");
const isCobble = (i) =>
  ["cobblestone", "cobbled_deepslate", "blackstone"].includes(i.name);

function eyeDistance(bot, pos) {
  return bot.entity.position
    .offset(0, bot.entity.height * 0.9, 0)
    .distanceTo(pos.offset(0.5, 0.5, 0.5));
}

// Yol bulucuyla git. Takılıp kalmasın diye süre sınırı var.
async function goto(bot, goal, timeoutMs = 30000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("zaman aşımı")), timeoutMs);
  });
  try {
    await Promise.race([bot.pathfinder.goto(goal), timeout]);
    return true;
  } catch (err) {
    dbg("yol bulunamadı:", err.message);
    // stop() değil: boşta çağrılınca bir sonraki yolu da iptal ediyor.
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return false;
  } finally {
    clearTimeout(timer);
    // Yol bulucu köprü kurarken eğiliyor ve blok koyamazsa öyle bırakıyor:
    // eğik bot kenardan inemez, yerdeki eşyayı alamaz.
    if (bot.controlState.sneak) bot.setControlState("sneak", false);
  }
}

// Havadayken kazmak 5 kat yavaş (ve mineflayer süreyi baştan öyle hesaplıyor):
// yere basana kadar kısa bir süre bekle.
async function waitOnGround(bot, maxMs = 1200) {
  const t0 = Date.now();
  while (!bot.entity.onGround && !bot.entity.isInWater && Date.now() - t0 < maxMs) await sleep(25);
}

async function equipFor(bot, block) {
  const tool = bot.pathfinder.bestHarvestTool(block);
  if (tool) await bot.equip(tool, "hand");
}

// Envanterdeki en hızlı kıran aleti bul (doğru alet olmasa da; ör. taş kazmayla
// ağlayan obsidyen). Dönen: { item, seconds }.
function fastestTool(bot, block) {
  let best = { item: null, seconds: block.digTime(null, false, false, false, [], {}) / 1000 };
  for (const it of bot.inventory.items()) {
    const seconds = block.digTime(it.type, false, false, false, [], {}) / 1000;
    if (seconds < best.seconds - 1e-6) best = { item: it, seconds };
  }
  return best;
}

// Yerdeki eşyaları (drop) topla.
async function collectDrops(bot, near, radius = 4) {
  // Yol hesaplamak yavaş: önce eşyaya bakıp düz yürü (takılınca zıpla). Olmazsa
  // (bot bir çukurda, eşya başka bir çukurda) yol bulucuya bırak.
  if (bot.controlState.sneak) bot.setControlState("sneak", false);
  await sleep(120);
  const nearestDrop = () =>
    Object.values(bot.entities)
      .filter((e) => e.name === "item" && e.position.distanceTo(near) <= radius)
      .sort(
        (a, b) =>
          a.position.distanceTo(bot.entity.position) -
          b.position.distanceTo(bot.entity.position),
      )[0];
  for (let i = 0; i < 3; i++) {
    const drop = nearestDrop();
    if (!drop) return;
    if (drop.position.distanceTo(bot.entity.position) < 1.2) {
      await sleep(150);
      continue;
    }
    const t0 = Date.now();
    bot.setControlState("forward", true);
    while (
      Date.now() - t0 < 1200 &&
      bot.entities[drop.id] &&
      drop.position.distanceTo(bot.entity.position) > 0.9
    ) {
      await bot.lookAt(drop.position, true);
      bot.setControlState("jump", bot.entity.isCollidedHorizontally);
      await sleep(50);
    }
    bot.clearControlStates();
    if (bot.entities[drop.id] && drop.position.distanceTo(bot.entity.position) > 1.2) {
      const p = drop.position;
      await goto(bot, new GoalNear(p.x, p.y, p.z, 1), 4000);
      await sleep(150);
    }
  }
}

const isLiquid = (b) => b && (b.name === "lava" || b.name === "water");

// Düz aşağı kaz (speedrunner usulü). Lav/su yanındaysa ya da altında derin
// boşluk varsa güvenli değil: durur ve false döner.
async function digDown(bot, targetY) {
  const p0 = bot.entity.position.floored();
  await goto(bot, new GoalBlock(p0.x, p0.y, p0.z), 5000); // bloğun ortasına geç
  let stuck = 0;
  while (bot.entity.position.y > targetY + 0.5) {
    const feet = bot.entity.position.floored();
    const below = bot.blockAt(feet.offset(0, -1, 0));
    if (!below) return false;
    // Kazacağımız bloğun etrafı ve altı güvenli mi?
    const around = [
      [0, -2, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
    ].map(([x, y, z]) => bot.blockAt(feet.offset(x, y, z)));
    if (isLiquid(below) || around.some(isLiquid)) {
      dbg("aşağıda sıvı var, düz inişi bırakıyorum");
      return false;
    }
    if (!bot.entity.onGround) {
      await sleep(50);
      continue;
    }
    if (below.boundingBox === "empty") {
      // Boşluk: ne kadar düşeceğiz?
      let depth = 1;
      while (depth < 6 && bot.blockAt(feet.offset(0, -1 - depth, 0))?.boundingBox === "empty") depth++;
      if (depth > 3) {
        dbg("altında derin boşluk, düz inişi bırakıyorum");
        return false;
      }
      await sleep(250);
      if (++stuck > 12) return false;
      continue;
    }
    await equipFor(bot, below);
    const held = bot.heldItem ? bot.heldItem.type : null;
    if (!below.canHarvest(held) || below.hardness == null || below.hardness < 0) return false;
    const y0 = bot.entity.position.y;
    try {
      await bot.dig(below, true);
    } catch (err) {
      return false;
    }
    const t0 = Date.now();
    // Havadayken kazmak 5 kat yavaş: yere basana kadar bekle.
    while (
      (bot.entity.position.y >= y0 - 0.5 || !bot.entity.onGround) &&
      Date.now() - t0 < 1500
    )
      await sleep(25);
    if (bot.entity.position.y >= y0 - 0.5 && ++stuck > 12) return false;
  }
  return true;
}

// Derindeki/uzaktaki bir bloğa tek seferde yol hesaplamak çok yavaş.
// Önce hedefin yanındaki sütuna yürü, düz aşağı kaz, sonra yanına geç.
async function approach(bot, pos) {
  const me = bot.entity.position;
  const dy = me.y - pos.y;
  const flat = Math.hypot(me.x - pos.x, me.z - pos.z);
  if (dy > 6) {
    if (flat > 2) await goto(bot, new GoalNearXZ(pos.x + 0.5, pos.z + 0.5, 1.5), 40000);
    const ok = await digDown(bot, pos.y);
    if (!ok) await goto(bot, new GoalY(pos.y + 1), 60000);
  } else if (flat > 24) {
    await goto(bot, new GoalNear(pos.x, pos.y, pos.z, 6), 40000);
  }
  return goto(bot, new GoalGetToBlock(pos.x, pos.y, pos.z), 30000);
}

// Bir bloğa git, en iyi aletle kaz, drop'u topla.
// force: alet "doğru" olmasa da kır (eşya düşmez; sadece bloğu kaldırmak için).
async function mineBlock(bot, pos, { expect, collect = true, force = false } = {}) {
  pos = new Vec3(pos.x, pos.y, pos.z);
  let block = bot.blockAt(pos);
  if (!block || block.name === "air" || block.name === "cave_air") return false;
  if (expect && !expect(block)) return false;

  if (eyeDistance(bot, pos) > 4.3) {
    const ok =
      (await approach(bot, pos)) ||
      (await goto(bot, new GoalNear(pos.x, pos.y, pos.z, 2), 20000));
    if (!ok) {
      dbg("ulaşılamadı:", block.name, pos.toString());
      return false;
    }
  }
  block = bot.blockAt(pos);
  if (!block || (expect && !expect(block))) return false;
  if (eyeDistance(bot, pos) > 5) {
    dbg("çok uzak:", block.name, eyeDistance(bot, pos).toFixed(1));
    return false;
  }

  if (force) {
    const { item } = fastestTool(bot, block);
    if (item) await bot.equip(item, "hand");
  } else await equipFor(bot, block);
  const held = bot.heldItem ? bot.heldItem.type : null;
  if (!force && !block.canHarvest(held)) {
    dbg("bu aletle kırılmaz:", block.name, bot.heldItem && bot.heldItem.name);
    return false;
  }
  await waitOnGround(bot);
  try {
    await bot.dig(block, true);
  } catch (err) {
    dbg("kazılamadı:", block.name, err.message);
    return false;
  }
  dbg("kazıldı:", block.name, pos.toString());
  const tc = Date.now();
  if (collect) await collectDrops(bot, pos);
  dbg("toplama süresi", Date.now() - tc);
  return true;
}

// Belirli bir bloktan yakındaki en iyi adayları kazarak "count" adet eşya topla.
async function gatherNearest(
  bot,
  blockNames,
  itemTest,
  needed,
  { maxDistance = 48, avoid = new Set() } = {},
) {
  const ids = blockNames
    .map((n) => bot.registry.blocksByName[n])
    .filter(Boolean)
    .map((b) => b.id);
  let tries = 0;
  while (count(bot, itemTest) < needed && tries < needed * 4) {
    tries++;
    const positions = bot
      .findBlocks({ matching: ids, maxDistance, count: 64 })
      .filter((p) => !avoid.has(p.toString()))
      .sort(
        (a, b) =>
          a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position),
      );
    if (!positions.length) {
      dbg("yakında bulunamadı:", blockNames.join(","));
      return false;
    }
    const p = positions[0];
    const ok = await mineBlock(bot, p);
    if (!ok) {
      // Ulaşılamadıysa çevresindekiler de büyük ihtimalle ulaşılamaz.
      for (const q of positions) {
        if (q.distanceTo(p) <= 3) avoid.add(q.toString());
      }
    }
  }
  return count(bot, itemTest) >= needed;
}

// Sunucudan envanterin gerçek halini iste. Mineflayer tıklamaları tahminle
// işliyor; tahmin kayarsa (ör. craft sırasında yerden eşya alınınca) craft
// sessizce boşa çıkıyor. Bu çağrıdan sonra bot.inventory kesin doğrudur.
async function syncInventory(bot) {
  if (!bot._syncWindow || bot.currentWindow) return;
  let timer;
  try {
    await Promise.race([
      bot._syncWindow(bot.inventory),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
  } catch (err) {
    dbg("envanter eşitlenemedi:", err.message);
  } finally {
    clearTimeout(timer);
  }
}

function invDump(bot) {
  const w = bot.inventory;
  const slots = w.slots
    .map((it, i) => (it ? `${i}:${it.name}x${it.count}` : null))
    .filter(Boolean)
    .join(" ");
  return `[${slots}] imleç=${w.selectedItem ? w.selectedItem.name : "-"}`;
}

// Craft ızgarasında kalan malzemeyi envantere geri döndür.
async function resetCraftGrid(bot) {
  try {
    bot.closeWindow(bot.currentWindow || bot.inventory);
  } catch (err) {
    /* pencere zaten kapalı */
  }
  await sleep(250);
  await syncInventory(bot);
}

// Craft et ve sunucunun gerçekten verdiğini doğrula; vermediyse düzeltip tekrar dene.
async function craft(bot, name, times = 1, table = null) {
  const id = itemId(bot, name);
  await syncInventory(bot); // tahmin kaymışsa baştan düzelt
  const before = count(bot, name);
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      // Izgarada ya da imleçte kalan eşya envantere dönsün; belki craft olmuştur.
      await resetCraftGrid(bot);
      if (count(bot, name) > before) return;
    }
    const recipes = bot.recipesFor(id, null, 1, table);
    if (!recipes.length) {
      if (!lastErr)
        throw new Error(`Craft edilemiyor: ${name} (malzeme eksik ya da masa yok)`);
      dbg("tarif yok:", name, invDump(bot));
      continue;
    }
    try {
      await bot.craft(recipes[0], times, table);
    } catch (err) {
      lastErr = err;
      dbg("craft tekrar deneniyor:", name, err.message);
      continue;
    }
    await syncInventory(bot);
    if (count(bot, name) > before) return;
    // Eşitleme, daha önceki bir tıklamanın cevabıyla erken dönmüş olabilir.
    await sleep(300);
    await syncInventory(bot);
    if (count(bot, name) > before) return;
    lastErr = new Error("sunucu eşyayı vermedi");
    dbg("craft tutmadı, tekrar:", name, invDump(bot));
  }
  throw new Error(`${name} craft edilemedi: ${lastErr ? lastErr.message : "malzeme eksik"}`);
}

// Tariflerde tahtalar aynı türden olmalı (ör. kazma için 3 meşe tahtası).
// En çok olan tahta türünden "needed" adet olana kadar kütük çevirir.
function plankGroups(bot) {
  const groups = {};
  for (const i of bot.inventory.items().filter(isPlanks))
    groups[i.name] = (groups[i.name] || 0) + i.count;
  return groups;
}

async function ensurePlanks(bot, needed) {
  for (;;) {
    const groups = plankGroups(bot);
    const best = Object.keys(groups).sort((a, b) => groups[b] - groups[a])[0];
    if (best && groups[best] >= needed) return;
    const logs = bot.inventory.items().filter(isLog);
    const log =
      logs.find((l) => l.name.replace(/_log$/, "_planks") === best) || logs[0];
    if (!log) throw new Error("Tahta için kütük kalmadı");
    await craft(bot, log.name.replace(/_log$/, "_planks"), 1);
  }
}

async function ensureSticks(bot, needed) {
  while (count(bot, "stick") < needed) {
    await ensurePlanks(bot, 2);
    await craft(bot, "stick", 1);
  }
}

function isAirLike(b) {
  return b && b.boundingBox === "empty" && !["lava", "water"].includes(b.name);
}

// Botun yanında bir bloğu koyabileceği yer bulur ve koyar.
async function placeNear(bot, itemName) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new Error(`Envanterde yok: ${itemName}`);
  const feet = bot.entity.position.floored();
  const offsets = [];
  for (const r of [1, 2]) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) === r) offsets.push([dx, dz]);
      }
    }
  }
  for (const dy of [0, -1, 1]) {
    for (const [dx, dz] of offsets) {
      const target = feet.offset(dx, dy, dz);
      const ref = bot.blockAt(target.offset(0, -1, 0));
      const spot = bot.blockAt(target);
      if (!ref || ref.boundingBox !== "block" || !isAirLike(spot)) continue;
      if (eyeDistance(bot, target) > 4) continue;
      try {
        await bot.equip(item, "hand");
        await bot.placeBlock(ref, new Vec3(0, 1, 0));
        const placed = bot.blockAt(target);
        if (placed && placed.name === itemName) return placed;
      } catch (err) {
        /* başka yer dene */
      }
    }
  }
  // Tünel içindeysek: yandaki bloğu kazıp yer aç.
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const target = feet.offset(dx, 0, dz);
    const ref = bot.blockAt(target.offset(0, -1, 0));
    if (!ref || ref.boundingBox !== "block") continue;
    const b = bot.blockAt(target);
    if (b && !isAirLike(b)) {
      await equipFor(bot, b);
      try {
        await bot.dig(b, true);
      } catch (err) {
        continue;
      }
    }
    try {
      await bot.equip(item, "hand");
      await bot.placeBlock(ref, new Vec3(0, 1, 0));
      const placed = bot.blockAt(target);
      if (placed && placed.name === itemName) return placed;
    } catch (err) {
      /* devam */
    }
  }
  throw new Error(`${itemName} koyacak yer bulunamadı`);
}

// Yakında masa varsa onu kullan, yoksa koy (gerekirse craft et).
async function ensureTable(bot) {
  const tableId = bot.registry.blocksByName.crafting_table.id;
  const near = bot.findBlock({ matching: tableId, maxDistance: 20 });
  if (near) {
    if (eyeDistance(bot, near.position) > 4) {
      await goto(
        bot,
        new GoalGetToBlock(near.position.x, near.position.y, near.position.z),
      );
    }
    if (eyeDistance(bot, near.position) <= 4.5)
      return bot.blockAt(near.position);
  }
  if (count(bot, "crafting_table") === 0) {
    await ensurePlanks(bot, 4);
    await craft(bot, "crafting_table", 1);
  }
  return placeNear(bot, "crafting_table");
}

// Fırın koy, ham demiri erit, külçeleri al.
async function smelt(bot, inputName, amount, fuelTest, fuelAmount) {
  if (count(bot, "furnace") === 0) throw new Error("Önce fırın craft edilmeli");
  const furnaceBlock = await placeNear(bot, "furnace");
  const furnace = await bot.openFurnace(furnaceBlock);
  // En büyük yakıt yığınından koy; yetmezse aşağıdaki döngü yakıt bitince ekler.
  const addFuel = async (n) => {
    // Pencere açıkken envanterin güncel hali pencerenin içinde.
    const fuel = furnace
      .items()
      .filter(fuelTest)
      .sort((x, y) => y.count - x.count)[0];
    if (!fuel) return 0;
    const k = Math.min(n, fuel.count);
    await furnace.putFuel(fuel.type, null, k);
    return k;
  };
  try {
    if ((await addFuel(fuelAmount)) === 0) throw new Error("Yakıt yok");
    await furnace.putInput(itemId(bot, inputName), null, amount);
    const deadline = Date.now() + amount * 10000 + 20000;
    while (Date.now() < deadline) {
      const out = furnace.outputItem();
      if (out && out.count >= amount) break;
      // Yakıt bitti ama eritilecek cevher kaldıysa bir tane daha ekle.
      if (!furnace.fuelItem() && furnace.fuel <= 0 && furnace.inputItem()) {
        if ((await addFuel(1)) === 0) break; // yakıt kalmadı
        dbg("yakıt eklendi");
      }
      await sleep(250);
    }
    const out = furnace.outputItem();
    dbg("fırın çıktısı:", out ? out.count : 0);
    if (out) await furnace.takeOutput();
  } finally {
    furnace.close();
  }
  return furnaceBlock;
}

module.exports = {
  dbg,
  approach,
  sleep,
  itemId,
  eyeDistance,
  equipFor,
  fastestTool,
  isAirLike,
  digDown,
  count,
  isLog,
  isPlanks,
  isCobble,
  goto,
  mineBlock,
  gatherNearest,
  collectDrops,
  craft,
  syncInventory,
  ensurePlanks,
  ensureSticks,
  ensureTable,
  placeNear,
  smelt,
};
