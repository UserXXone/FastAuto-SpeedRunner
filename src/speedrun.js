"use strict";

// Koşu akışı: harita → odun → tahta kazma → taş kazma → demir → eritme → demir kazma → elmas

const { Vec3 } = require("vec3");
const {
  Movements,
  goals: { GoalY, GoalXZ },
} = require("mineflayer-pathfinder");
const A = require("./actions");
const { scanLoaded } = require("./scanner");
const { makePlan } = require("./planner");
const { Timer, fmt } = require("./timer");

const LOGS_NEEDED = 6; // 24 tahta: 2-3 masa, tahta kazma, çubuklar, 3 yakıt
const COBBLE_NEEDED = 11; // taş kazma (3) + fırın (8)
const DIAMOND_Y = -58;

function setupMovements(bot) {
  const m = new Movements(bot);
  m.canDig = true;
  m.allowParkour = true;
  m.allowSprinting = true;
  m.allow1by1towers = true;
  m.scafoldingBlocks = [
    "dirt",
    "cobblestone",
    "cobbled_deepslate",
    "netherrack",
    "andesite",
    "diorite",
    "granite",
    "tuff",
  ]
    .map((n) => bot.registry.itemsByName[n])
    .filter(Boolean)
    .map((i) => i.id);
  // Elması yanlış aletle kırıp boşa harcamasın.
  for (const n of ["diamond_ore", "deepslate_diamond_ore"]) {
    m.blocksCantBreak.add(bot.registry.blocksByName[n].id);
  }
  // Yol bulucu lavı "kırılabilir blok" sanıp içinden geçmeye çalışıyor: yasakla.
  m.blocksCantBreak.add(bot.registry.blocksByName.lava.id);
  // Magma bloğunun üstünde durmak can götürür (yıkık portallarda ve Nether'da çok var).
  // Lav da "sıvı" sayıldığı için yol bulucu üstünde yüzmeye kalkıyor: ikisini de yasakla.
  const magma = bot.registry.blocksByName.magma_block;
  const lava = bot.registry.blocksByName.lava;
  m.exclusionAreasStep.push((block) => {
    if (!block || !block.position) return 0;
    if (block.type === lava.id) return 100;
    const below = bot.blockAt(block.position.offset(0, -1, 0));
    if (below && (below.type === lava.id || (magma && below.type === magma.id))) return 100;
    return 0;
  });
  // Son emniyet: hiçbir adım lavın içine ya da üstüne inmesin (aşağı atlama
  // hamlesi lav gölünün dibini "zemin" sanıyordu).
  const baseNeighbors = m.getNeighbors.bind(m);
  m.getNeighbors = (node) =>
    baseNeighbors(node).filter((n) => {
      const feet = bot.blockAt(new Vec3(n.x, n.y, n.z));
      if (feet && feet.type === lava.id) return false;
      const below = bot.blockAt(new Vec3(n.x, n.y - 1, n.z));
      if (below && below.type === lava.id) return false;
      // Lavın hemen yanından yürümek de riskli (itilince içine düşülüyor): pahalı say.
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [0, -1]) {
          const b = bot.blockAt(new Vec3(n.x + dx, n.y + dy, n.z + dz));
          if (b && b.type === lava.id) n.cost += 6;
        }
      }
      return true;
    });
  // Suyu biraz pahalı say ama çok değil: aşırı pahalıysa yol arama zaman aşımına düşüyor.
  m.liquidCost = 4;
  bot.pathfinder.setMovements(m);
  bot.pathfinder.thinkTimeout = 8000;
  bot.pathfinder.tickTimeout = 60; // tick başına daha çok düşün = daha hızlı rota
  return m;
}

// Hava azalınca yolu bırak ve yukarı yüz.
function airGuard(bot) {
  let rescuing = false;
  bot.on("breath", async () => {
    if (rescuing || bot.oxygenLevel >= 8) return;
    const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0));
    if (!head || head.name !== "water") return;
    rescuing = true;
    console.log(`🫧 Hava azaldı (${bot.oxygenLevel}/20), yüzeye çıkıyorum`);
    bot.pathfinder.setGoal(null);
    bot.setControlState("jump", true);
    bot.setControlState("forward", false);
    const t0 = Date.now();
    while (bot.oxygenLevel < 18 && Date.now() - t0 < 15000) await A.sleep(200);
    bot.setControlState("jump", false);
    rescuing = false;
  });
}

// Magma bloğunun üstündeyken eğil: eğilen oyuncuya magma zarar vermez.
// (Yol bulucu magmadan kaçınıyor ama bot bazen üstünde iş yapmak zorunda kalıyor.)
function magmaGuard(bot) {
  const magma = bot.registry.blocksByName.magma_block;
  if (!magma) return;
  let ours = false; // eğilmeyi biz mi açtık
  bot.on("physicsTick", () => {
    if (!bot.entity) return;
    const below = bot.blockAt(bot.entity.position.offset(0, -0.3, 0));
    const onMagma = Boolean(below && below.type === magma.id);
    if (onMagma && !bot.controlState.sneak) {
      ours = true;
      bot.setControlState("sneak", true);
    } else if (!onMagma && ours) {
      ours = false;
      bot.setControlState("sneak", false);
    }
  });
}

// Lava düştüysek her şeyi bırak, en yakın kuru yere çık. Kaçış sürerken
// bot.inLavaEscape doğrudur; dövüş döngüleri o sırada kontrolü bırakır.
function lavaGuard(bot) {
  const lava = bot.registry.blocksByName.lava;
  let target = null;
  const safeSpot = () => {
    const me = bot.entity.position.floored();
    let best = null;
    for (let dx = -5; dx <= 5; dx++)
      for (let dz = -5; dz <= 5; dz++)
        for (let dy = -1; dy <= 2; dy++) {
          const p = me.offset(dx, dy, dz);
          const floor = bot.blockAt(p.offset(0, -1, 0));
          const feet = bot.blockAt(p);
          const head = bot.blockAt(p.offset(0, 1, 0));
          if (!floor || floor.boundingBox !== "block" || !feet || !head) continue;
          if (feet.boundingBox !== "empty" || head.boundingBox !== "empty") continue;
          if (feet.type === lava.id || head.type === lava.id) continue;
          const d = Math.hypot(dx, dz) + Math.max(0, dy) * 1.5;
          if (!best || d < best.d) best = { d, p };
        }
    return best ? best.p.offset(0.5, 0, 0.5) : null;
  };
  bot.on("physicsTick", () => {
    if (!bot.entity) return;
    // Fizik motorunun isInLava'sı yanlış alarm veriyor (darbe alınca); bloklara bak.
    const feet = bot.blockAt(bot.entity.position);
    const waist = bot.blockAt(bot.entity.position.offset(0, 0.9, 0));
    const inLava = Boolean((feet && feet.type === lava.id) || (waist && waist.type === lava.id));
    if (inLava) {
      if (!bot.inLavaEscape) {
        bot.inLavaEscape = true;
        const p = bot.entity.position;
        const head = bot.blockAt(p.offset(0, 1, 0));
        console.log(
          `🌋 Lavdayım, çıkıyorum! konum ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} | ayak ${feet && feet.name}, baş ${head && head.name}, fizik ${bot.entity.isInLava}`,
        );
        bot.pathfinder.setGoal(null);
        target = safeSpot();
      }
      if (!target || bot.entity.position.distanceTo(target) < 0.5) target = safeSpot();
      if (target) bot.lookAt(target.offset(0, 1.6, 0), true);
      bot.setControlState("forward", true);
      bot.setControlState("jump", true);
      bot.setControlState("sprint", true);
      bot.setControlState("sneak", false);
    } else if (bot.inLavaEscape) {
      bot.inLavaEscape = false;
      target = null;
      bot.clearControlStates();
    }
  });
}

// Ateşin içinde durma: ayağımızdaki ateşi söndür (ateşe vurmak söndürür).
function fireGuard(bot) {
  let busy = false;
  let last = 0;
  bot.on("physicsTick", () => {
    if (busy || !bot.entity || Date.now() - last < 150) return;
    const p = bot.entity.position;
    const here = [bot.blockAt(p), bot.blockAt(p.offset(0, 1, 0))].find(
      (b) => b && (b.name === "fire" || b.name === "soul_fire"),
    );
    if (!here) return;
    busy = true;
    last = Date.now();
    bot.dig(here, "ignore").catch(() => {}).finally(() => {
      busy = false;
    });
  });
}

// Sunucu chunk göndermeyi bitirene kadar bekle.
async function waitForChunks(bot, quietMs = 1000, maxMs = 6000) {
  let last = Date.now();
  const onLoad = () => {
    last = Date.now();
  };
  bot.on("chunkColumnLoad", onLoad);
  const start = Date.now();
  const hereLoaded = () => bot.blockAt(bot.entity.position) !== null;
  while (
    (Date.now() - last < quietMs || !hereLoaded()) &&
    Date.now() - start < maxMs
  )
    await A.sleep(100);
  bot.removeListener("chunkColumnLoad", onLoad);
}

function loadPlanFile(planFile, bot) {
  if (!planFile) return null;
  const data = require(require("path").resolve(planFile));
  if (data.version && data.version !== bot.version) {
    console.log(
      `⚠️  Harita ${data.version} için çıkarılmış, sunucu ${bot.version}. Cevher yerleri tutmayabilir.`,
    );
  }
  return data.plan;
}

// Plandaki blokları sırayla kaz. Bir bloğa ulaşılamazsa aynı ağacı/damarı
// (3 blok yakınındakileri) atla; boşuna yol aramasın.
async function mineList(bot, positions, expect, enough) {
  const unreachable = [];
  for (const p of positions) {
    if (enough()) return;
    const v = new Vec3(p.x, p.y, p.z);
    if (unreachable.some((u) => u.distanceTo(v) <= 3)) continue;
    const ok = await A.mineBlock(bot, v, { expect });
    const b = bot.blockAt(v);
    if (!ok && b && expect(b)) unreachable.push(v);
  }
}

const STONE_BLOCKS = ["stone", "deepslate", "cobblestone", "cobbled_deepslate"];

// Plandaki ağaçları kes; yetmezse yakındaki en yakın kütüklere git.
async function gatherWood(bot, trees, needed) {
  // Yol bulucu kütükleri kendi kazmasın: ağacın tepesinde doğunca gövdeyi baştan
  // sona kazarak iniyordu (20 kütük, 1,5 dakika). Kütükleri sadece biz keselim.
  const cant = bot.pathfinder.movements.blocksCantBreak;
  const logIds = bot.registry.blocksArray
    .filter((b) => b.name.endsWith("_log") && !cant.has(b.id))
    .map((b) => b.id);
  for (const id of logIds) cant.add(id);
  try {
    await gatherWoodInner(bot, trees, needed);
  } finally {
    for (const id of logIds) cant.delete(id);
  }
}

async function gatherWoodInner(bot, trees, needed) {
  // Ağacın tepesinde doğduysak plandaki (yerdeki) kütüğe inmek için gövdeyi
  // baştan sona kazmak yerine, yanımızdaki kütüklerden başla.
  const first = (trees || [])[0];
  if (first && bot.entity.position.y - first.y > 6) trees = [];
  await mineList(
    bot,
    trees || [],
    (b) => b.name.endsWith("_log"),
    () => A.count(bot, A.isLog) >= needed,
  );
  if (A.count(bot, A.isLog) < needed) {
    const logNames = Object.keys(bot.registry.blocksByName).filter(
      (n) => n.endsWith("_log") && !n.startsWith("stripped"),
    );
    await A.gatherNearest(bot, logNames, A.isLog, needed, { maxDistance: 64 });
  }
  if (A.count(bot, A.isLog) < 3) throw new Error("Yeterli ağaç bulunamadı");
}

async function makeWoodenPickaxe(bot) {
  await A.ensurePlanks(bot, 4);
  const table = await A.ensureTable(bot);
  await A.ensurePlanks(bot, 3);
  await A.ensureSticks(bot, 6);
  await A.ensurePlanks(bot, 3);
  await A.craft(bot, "wooden_pickaxe", 1, table);
  return table;
}

// cobbleNeeded kadar taş topla (en az 3), taş kazmayı yap. Masayı döndürür.
async function makeStonePickaxe(bot, cobbleNeeded) {
  await A.gatherNearest(bot, STONE_BLOCKS, A.isCobble, cobbleNeeded, {
    maxDistance: 32,
  });
  if (A.count(bot, A.isCobble) < cobbleNeeded) {
    // Yakında ulaşılabilir taş yoksa biraz aşağı kaz ve tekrar dene.
    const y = Math.floor(bot.entity.position.y);
    await A.goto(bot, new GoalY(y - 6));
    await A.gatherNearest(bot, STONE_BLOCKS, A.isCobble, cobbleNeeded, {
      maxDistance: 48,
    });
  }
  if (A.count(bot, A.isCobble) < 3) throw new Error("Taş bulunamadı");
  const table = await A.ensureTable(bot);
  await A.craft(bot, "stone_pickaxe", 1, table);
  return table;
}

async function run(bot, opts = {}) {
  if (opts.delay) {
    console.log(`${opts.delay} saniye sonra başlıyor...`);
    await A.sleep(opts.delay * 1000);
  }
  const timer = new Timer();
  timer.begin();
  const say = (msg) => {
    console.log(msg);
    if (opts.chat) bot.chat(msg);
  };

  A.safeDigTime(bot);
  setupMovements(bot);
  airGuard(bot);

  // 1) HARİTA + STRATEJİ
  let plan = loadPlanFile(opts.planFile, bot);
  if (plan) {
    say(`Hazır harita yüklendi: ${plan.reason}`);
  } else {
    await waitForChunks(bot);
    const resources = scanLoaded(bot, bot.entity.position, opts.radius || 128);
    plan = makePlan(resources, bot.entity.position, {
      logsNeeded: LOGS_NEEDED,
    });
    say(
      `Harita çıkarıldı (${resources.log.length} kütük, ${resources.iron.length} demir, ${resources.diamond.length} elmas görüldü). ${plan.reason}`,
    );
    if (opts.onMap) opts.onMap(resources, plan);
  }
  timer.split("Harita + strateji");

  // 2) ODUN
  await gatherWood(bot, plan.trees, LOGS_NEEDED);
  timer.split(`Odun (${A.count(bot, A.isLog)} kütük)`);

  // 3) TAHTA KAZMA
  await makeWoodenPickaxe(bot);
  timer.split("Tahta kazma");

  // 4) TAŞ KAZMA
  let table = await makeStonePickaxe(bot, COBBLE_NEEDED);
  timer.split("Taş kazma");

  // 5) DEMİR
  const isIronOre = (b) =>
    b.name === "iron_ore" || b.name === "deepslate_iron_ore";
  await mineList(
    bot,
    plan.iron || [],
    isIronOre,
    () => A.count(bot, "raw_iron") >= 3,
  );
  if (A.count(bot, "raw_iron") < 3) {
    await A.gatherNearest(
      bot,
      ["iron_ore", "deepslate_iron_ore"],
      (i) => i.name === "raw_iron",
      3,
      { maxDistance: 96 },
    );
  }
  if (A.count(bot, "raw_iron") < 3) throw new Error("Yeterli demir bulunamadı");
  timer.split("Demir (3 ham demir)");

  // 6) ERİTME
  if (A.count(bot, A.isCobble) < 8) {
    await A.gatherNearest(bot, STONE_BLOCKS, A.isCobble, 8, { maxDistance: 16 });
  }
  table = await A.ensureTable(bot);
  await A.craft(bot, "furnace", 1, table);
  await A.ensurePlanks(bot, 3);
  await A.smelt(bot, "raw_iron", 3, A.isPlanks, 3);
  if (A.count(bot, "iron_ingot") < 3) throw new Error("Demir eritilemedi");
  timer.split("Fırın + eritme");

  // 7) DEMİR KAZMA
  await A.ensureSticks(bot, 2);
  table = await A.ensureTable(bot);
  await A.craft(bot, "iron_pickaxe", 1, table);
  for (const n of ["diamond_ore", "deepslate_diamond_ore"]) {
    bot.pathfinder.movements.blocksCantBreak.delete(
      bot.registry.blocksByName[n].id,
    );
  }
  timer.split("Demir kazma");

  // 8) ELMAS
  const isDiamondOre = (b) =>
    b.name === "diamond_ore" || b.name === "deepslate_diamond_ore";
  const target = opts.diamonds || 1;
  const enough = () => A.count(bot, "diamond") >= target;
  await mineList(bot, plan.diamonds || [], isDiamondOre, enough);
  if (!enough()) await findDiamondsLive(bot, target, say);
  if (!enough()) throw new Error("Elmas bulunamadı");
  timer.split(`ELMAS x${A.count(bot, "diamond")}`);

  say(`💎 Elmas bulundu! Süre: ${fmt(timer.elapsed())}`);
  console.log("\n" + timer.table());
  return timer;
}

// Plan yoksa ya da plan tutmadıysa: yüklü chunk'larda ara, yoksa keşfe çık.
async function findDiamondsLive(bot, target, say) {
  const enough = () => A.count(bot, "diamond") >= target;
  const names = ["diamond_ore", "deepslate_diamond_ore"];
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  for (let step = 0; step < 8 && !enough(); step++) {
    await A.gatherNearest(bot, names, (i) => i.name === "diamond", target, {
      maxDistance: 128,
    });
    if (enough()) return;
    // Görünürde elmas yok: derine in ve yeni chunk'lar yüklemek için ilerle.
    say("Görünürde elmas yok, keşfe çıkıyorum...");
    if (bot.entity.position.y > DIAMOND_Y + 4) {
      if (!(await A.digDown(bot, DIAMOND_Y)))
        await A.goto(bot, new GoalY(DIAMOND_Y), 90000);
    }
    const [dx, dz] = dirs[step % dirs.length];
    const p = bot.entity.position;
    await A.goto(bot, new GoalXZ(p.x + dx * 48, p.z + dz * 48), 90000);
    await waitForChunks(bot, 800, 6000);
  }
}

module.exports = {
  run,
  setupMovements,
  airGuard,
  magmaGuard,
  lavaGuard,
  fireGuard,
  waitForChunks,
  gatherWood,
  makeWoodenPickaxe,
  makeStonePickaxe,
};
