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
  // Su altından geçmek boğulmaya yol açıyor: suyu mümkünse dolaş.
  m.liquidCost = 25;
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
  await mineList(
    bot,
    plan.trees,
    (b) => b.name.endsWith("_log"),
    () => A.count(bot, A.isLog) >= LOGS_NEEDED,
  );
  if (A.count(bot, A.isLog) < LOGS_NEEDED) {
    const logNames = Object.keys(bot.registry.blocksByName).filter(
      (n) => n.endsWith("_log") && !n.startsWith("stripped"),
    );
    await A.gatherNearest(bot, logNames, A.isLog, LOGS_NEEDED, {
      maxDistance: 64,
    });
  }
  if (A.count(bot, A.isLog) < 3) throw new Error("Yeterli ağaç bulunamadı");
  timer.split(`Odun (${A.count(bot, A.isLog)} kütük)`);

  // 3) TAHTA KAZMA
  await A.ensurePlanks(bot, 4);
  let table = await A.ensureTable(bot);
  await A.ensurePlanks(bot, 3);
  await A.ensureSticks(bot, 6);
  await A.ensurePlanks(bot, 3);
  await A.craft(bot, "wooden_pickaxe", 1, table);
  timer.split("Tahta kazma");

  // 4) TAŞ KAZMA
  const stoneBlocks = [
    "stone",
    "deepslate",
    "cobblestone",
    "cobbled_deepslate",
  ];
  await A.gatherNearest(bot, stoneBlocks, A.isCobble, COBBLE_NEEDED, {
    maxDistance: 32,
  });
  if (A.count(bot, A.isCobble) < COBBLE_NEEDED) {
    // Yakında ulaşılabilir taş yoksa biraz aşağı kaz ve tekrar dene.
    const y = Math.floor(bot.entity.position.y);
    await A.goto(bot, new GoalY(y - 6));
    await A.gatherNearest(bot, stoneBlocks, A.isCobble, COBBLE_NEEDED, {
      maxDistance: 48,
    });
  }
  if (A.count(bot, A.isCobble) < 3) throw new Error("Taş bulunamadı");
  table = await A.ensureTable(bot);
  await A.craft(bot, "stone_pickaxe", 1, table);
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
    await A.gatherNearest(bot, stoneBlocks, A.isCobble, 8, { maxDistance: 16 });
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
    if (bot.entity.position.y > DIAMOND_Y + 4)
      await A.goto(bot, new GoalY(DIAMOND_Y));
    const [dx, dz] = dirs[step % dirs.length];
    const p = bot.entity.position;
    await A.goto(bot, new GoalXZ(p.x + dx * 48, p.z + dz * 48));
    await waitForChunks(bot, 800, 6000);
  }
}

module.exports = { run, setupMovements, waitForChunks };
