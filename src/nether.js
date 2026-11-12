"use strict";

// Faz 3 koşu akışı:
//   odun → tahta kazma → taş kazma + kılıç → yemek → yıkık portal → sandık → çerçeve → yak → NETHER
//   → blaze spawner → blaze çubukları
// Sonraki bölümler (pearl, kaleye dönüş) buraya eklenecek.

const {
  goals: { GoalNearXZ, GoalNear },
} = require("mineflayer-pathfinder");
const A = require("./actions");
const P = require("./portal");
const S = require("./speedrun");
const C = require("./combat");
const F = require("./fortress");
const H = require("./highway");
const L = require("./lavacast");
const R = require("./prep");
const { Vec3 } = require("vec3");
const { scanLoaded } = require("./scanner");
const { makePlan } = require("./planner");
const { Timer, fmt } = require("./timer");

const LOGS_NEEDED = 10; // aletler, 4 kazmanın çubukları, fırın yakıtı, yedek
const COBBLE_NEEDED = 16; // kazma 3 + kılıç 2 + 3 yedek kazma 9 + yedek
const RODS_NEEDED = 6; // 12 göz için 12 toz = 6 çubuk (kalenin yeri belli, göz atmıyoruz)
const FOOD_WANTED = 6;

// Uzak bir (x,z) noktasına parça parça yürü; ilerleme durursa bırak.
async function travelXZ(bot, x, z, range, maxMs = 240000) {
  const flat = () => Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z);
  const t0 = Date.now();
  let stalls = 0;
  while (flat() > range && Date.now() - t0 < maxMs && stalls < 4) {
    const before = flat();
    await A.goto(bot, new GoalNearXZ(x, z, range), 45000);
    if (before - flat() < 3) stalls++;
    else stalls = 0;
  }
  return flat() <= range + 2;
}

async function stageTools(bot, timer) {
  await S.waitForChunks(bot);
  const here = bot.entity.position;
  const resources = scanLoaded(bot, here, 64);
  const plan = makePlan({ log: resources.log }, here, { logsNeeded: LOGS_NEEDED });
  await S.gatherWood(bot, plan.trees, LOGS_NEEDED);
  timer.split(`Odun (${A.count(bot, A.isLog)} kütük)`);

  await S.makeWoodenPickaxe(bot);
  timer.split("Tahta kazma");

  const table = await S.makeStonePickaxe(bot, COBBLE_NEEDED);
  if (A.count(bot, A.isCobble) >= 2) {
    await A.ensureSticks(bot, 1);
    await A.craft(bot, "stone_sword", 1, table);
  }
  timer.split("Taş kazma + kılıç");
  // Nether'daki tünel için yedek kazmalar (taş kazma 131 blokta kırılır).
  const n = await R.makeSparePickaxes(bot);
  timer.split(`Yedek kazmalar (${n} kazma)`);
}

// Portala git, sandığı al, çerçeveyi tamamla, yak, gir.
async function stagePortal(bot, info, timer, say) {
  const [px, pz] = info.portal;
  if (!(await travelXZ(bot, px, pz, 8)))
    throw new Error(`Yıkık portala ulaşılamadı (${px}, ${pz})`);
  await S.waitForChunks(bot, 600, 4000);
  const ruin = P.findRuin(bot, px, pz);
  if (!ruin) throw new Error(`(${px}, ${pz}) çevresinde yıkık portal yok`);
  timer.split("Yıkık portala varış");

  // Yeraltındaki (mağara) portallar için: önce yapının yanına in.
  if (bot.entity.position.y - ruin.center.y > 6) {
    say(`Portal yeraltında (y=${Math.round(ruin.center.y)}), iniyorum`);
    await P.descendTo(bot, ruin);
  }
  if (ruin.chest) {
    const taken = await P.lootChest(bot, ruin.chest);
    const list = Object.entries(taken).map(([n, c]) => `${n} x${c}`).join(", ");
    say(`Sandık: ${list || "işe yarar bir şey yok"}`);
    const worn = await P.wearGold(bot);
    if (worn) say(`Giyildi: ${worn} (piglinler saldırmaz)`);
  } else {
    say("Portalın sandığı yok");
  }
  timer.split("Sandık");

  const have = A.count(bot, "obsidian");
  const plan = P.planFrame(ruin.obsidian, P.kindAtFor(bot), have);
  if (!plan) throw new Error("Portal çerçevesi planlanamadı");
  say(
    `Çerçeve ${plan.w}x${plan.h}: ${plan.need} obsidyen eksik (elde ${have}), ${plan.dig.length} blok temizlenecek` +
      (plan.hard ? `, ${plan.hard} tanesi ağlayan obsidyen` : "") +
      (plan.liquid.length ? `, içinde ${plan.liquid.length} lav/su` : ""),
  );

  // Eksikler: sandık yetmiyorsa kovayla lav dökeceğiz (2 kova = 6 demir);
  // ateş kaynağı yoksa çakmak (1 demir + çakmaktaşı).
  const hasFire = () => A.count(bot, "flint_and_steel") + A.count(bot, "fire_charge") > 0;
  const castCount = plan.missing;
  let ironNeed = (castCount > 0 ? Math.max(0, 2 - L.buckets(bot)) * 3 : 0) + (hasFire() ? 0 : 1);
  if (ironNeed > 0) {
    await R.nuggetsToIngots(bot, ironNeed);
    if (A.count(bot, "iron_ingot") < ironNeed) {
      say(`Demir lazım: ${ironNeed} külçe (${castCount ? "2 kova" : ""}${castCount && !hasFire() ? " + " : ""}${hasFire() ? "" : "çakmak"})`);
      await R.mineIron(bot, ironNeed, say);
    }
    if (!hasFire()) {
      if (!(await R.getFlint(bot))) throw new Error("Çakmaktaşı bulunamadı (portalı yakacak bir şey yok)");
      if (!(await R.makeFlintAndSteel(bot))) throw new Error("Çakmak yapılamadı (demir yok)");
    }
    if (castCount > 0 && (await R.makeBuckets(bot, 2)) < 2)
      throw new Error(`Portala ${castCount} obsidyen yetmiyor ve iki kova için demir bulunamadı`);
    timer.split(`Demir (${ironNeed} külçe)`);
    // Demir ararken uzaklaşmış olabiliriz.
    await travelXZ(bot, ruin.center.x, ruin.center.z, 10);
  }
  if (!C.wearsGold(bot) && !(await P.wearGold(bot)) && A.count(bot, "gold_ingot") * 9 + A.count(bot, "gold_nugget") >= 36) {
    if (await R.makeGoldBoots(bot)) say(`Altın çizme yapıldı ve giyildi: ${await P.wearGold(bot)}`);
  }

  await P.prepareFrame(bot, plan, say);
  // Elimizdeki obsidyenleri üst hücrelere koyacağız (koymak her yerde kolay);
  // alttakileri lavla dökeceğiz (dökmek için üstünden bakmak gerekiyor).
  const cells = plan.place.slice().sort((a, b) => a.y - b.y);
  const castCells = cells.slice(0, castCount);
  const itemCells = cells.slice(castCount);
  if (castCells.length) {
    say(`${castCells.length} obsidyen lavla dökülecek`);
    const center = ruin.center.floored();
    if (!(await L.fill(bot, "water", center))) throw new Error("Yakında su bulunamadı (obsidyen dökmek için gerekli)");
    const normal = plan.axis === "x" ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
    let done = 0;
    for (const cell of castCells) {
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (!(await L.fill(bot, "lava", center))) throw new Error("Yakında lav bulunamadı (obsidyen dökmek için gerekli)");
        ok = await L.castAt(bot, cell, normal);
      }
      if (!ok) throw new Error(`Obsidyen dökülemedi: ${cell.x}, ${cell.y}, ${cell.z}`);
      say(`  obsidyen döküldü (${++done}/${castCells.length})`);
    }
    timer.split(`Lavla obsidyen (${castCells.length})`);
  }
  await P.buildFrame(bot, plan, say, itemCells);
  timer.split("Çerçeve");

  if (!(await P.lightPortal(bot, plan))) throw new Error("Portal yanmadı");
  timer.split("Portal yandı");

  if (!(await P.enterPortal(bot, plan))) throw new Error("Portaldan geçilemedi");
  timer.split("NETHER'a giriş");
  await S.waitForChunks(bot, 800, 15000);
  return plan;
}

// Blaze spawner'ı bul, yanına git, çubukları topla.
async function stageFortress(bot, info, timer, say, guard) {
  // Nether'da atlayarak geçiş (parkur) lava düşürüyor: kapat.
  bot.pathfinder.movements.allowParkour = false;
  if (!C.wearsGold(bot)) {
    const worn = await P.wearGold(bot);
    if (worn) say(`Giyildi: ${worn}`);
    else say("⚠️  Altın zırh yok: piglinler saldıracak");
  }
  if (await C.equipShield(bot)) say("Kalkan takıldı");
  else say("⚠️  Kalkan yok: blaze ateşi doğrudan gelecek");
  const pickaxes = A.count(bot, (i) => i.name.endsWith("_pickaxe"));
  if (pickaxes < 3) say(`⚠️  ${pickaxes} kazma var: tünel için 3-4 tane lazım (taş kazma 131 blokta kırılır)`);

  // Spawner görünmüyorsa fortress'e doğru kapalı tünelle ilerle.
  let sp = F.findBlazeSpawner(bot);
  if (!sp && info.fortress) {
    const [fx, fz] = info.fortress;
    await F.stockScaffold(bot, 128, { x: fx, z: fz });
    say(`Fortress'e gidiyorum (${fx}, ${fz})`);
    const r = await H.highway(bot, { x: fx, y: null, z: fz }, {
      range: 6, maxMs: 300000, enclosed: true, until: () => Boolean((sp = F.findBlazeSpawner(bot))),
    });
    A.dbg("fortress otoyolu:", r);
  }
  if (!sp) sp = await F.locateSpawner(bot, info, say);
  if (!sp) throw new Error("Blaze spawner bulunamadı");
  say(`Blaze spawner bulundu: ${sp.x}, ${sp.y}, ${sp.z}`);

  // Spawner'ın tam altına git: en çok kayanın içinden geçen yükseklikten kapalı
  // tünelle ilerle, sonra zeminin içine doğru yüksel. Odaya hiç girmiyoruz.
  const hide = F.hideout(sp);
  const arrived = () => F.atHideout(bot, sp);
  for (let i = 0; i < 4 && !arrived(); i++) {
    const here = H.cellOf(bot);
    const lvl = H.planLevel(bot, here, { x: hide.x, y: hide.y - 2, z: hide.z }) || { y: hide.y - 2, air: 40 };
    lvl.y = Math.min(lvl.y, hide.y - 2); // odanın zeminini yandan delme: alttan gel
    const need = Math.min(320, lvl.air * 6 + 64);
    say(`Spawner'ın altına tünel: y=${lvl.y}, ${lvl.air} adım açık hava, ~${need} blok lazım (elde ${A.count(bot, H.isFiller)})`);
    if (A.count(bot, H.isFiller) < need) await F.stockScaffold(bot, need, hide);
    let r = await H.highway(bot, { x: hide.x, y: lvl.y, z: hide.z }, { maxMs: 240000, enclosed: true, descendEarly: true });
    A.dbg("yatay tünel:", r, H.cellOf(bot).toString(), "kalan dolgu", A.count(bot, H.isFiller));
    if (r === "arrived") {
      // Odayı kapatmaya ~50 blok lazım: yukarı çıkmadan önce tamamla.
      if (A.count(bot, H.isFiller) < 60) {
        await F.stockScaffold(bot, 72);
        await H.highway(bot, { x: hide.x, y: lvl.y, z: hide.z }, { maxMs: 60000, enclosed: true });
      }
      r = await H.highway(bot, hide, { maxMs: 90000, enclosed: true });
      A.dbg("çıkış:", r, H.cellOf(bot).toString());
    }
  }
  if (!arrived()) throw new Error("Blaze spawner'ın altına ulaşılamadı");
  timer.split("Blaze spawner'a varış");

  guard.pause(); // bu aşamada dövüşü fightBlazes yönetir
  let r;
  try {
    r = await F.farmBlazes(bot, sp, RODS_NEEDED, say);
  } finally {
    guard.resume();
  }
  timer.split(`Blaze (${r.rods} çubuk, ${r.kills} blaze)`);
}

/**
 * info: { portal: [x, z], bastion, fortress, kale }  (seed avcısı / doğrulamadan)
 * opts: { start: "bastan" | "portal", goal: "blaze" | "nether", chat, delay }
 */
async function run(bot, info, opts = {}) {
  if (opts.delay) {
    console.log(`${opts.delay} saniye sonra başlıyor...`);
    await A.sleep(opts.delay * 1000);
  }
  const timer = new Timer();
  timer.onSplit = opts.onSplit;
  timer.begin();
  const say = (msg) => {
    console.log(msg);
    if (opts.onSay) opts.onSay(msg);
    if (opts.chat) bot.chat(msg);
  };
  A.safeDigTime(bot);
  S.setupMovements(bot);
  S.airGuard(bot);
  S.magmaGuard(bot);
  S.lavaGuard(bot);
  S.fireGuard(bot);
  const guard = C.startGuard(bot, { say });
  try {
    if (opts.start !== "portal") {
      await stageTools(bot, timer);
      const meat = await C.huntFood(bot, FOOD_WANTED, { radius: 32, budgetMs: 30000 });
      timer.split(`Yemek (${meat} et)`);
    }
    await stagePortal(bot, info, timer, say);
    const p = bot.entity.position.floored();
    say(`🔥 Nether'dayım (${p.x}, ${p.y}, ${p.z}). Süre: ${fmt(timer.elapsed())}`);
    if (opts.goal !== "nether") {
      await stageFortress(bot, info, timer, say, guard);
      say(`🔥 Blaze çubukları tamam. Süre: ${fmt(timer.elapsed())}`);
    }
  } finally {
    guard.stop();
    say(`Dövüş: ${guard.stats.hits} vuruş, ${guard.stats.eaten} yemek | can ${Math.round(bot.health)}/20, açlık ${bot.food}/20`);
  }
  console.log("\n" + timer.table());
  return timer;
}

module.exports = { run, travelXZ };
