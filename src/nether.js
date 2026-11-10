"use strict";

// Faz 3 koşu akışı. Şimdilik ilk bölüm:
//   odun → tahta kazma → taş kazma + kılıç → yıkık portal → sandık → çerçeve → yak → NETHER
// Sonraki bölümler (fortress/blaze, pearl, kaleye dönüş) buraya eklenecek.

const {
  goals: { GoalNearXZ },
} = require("mineflayer-pathfinder");
const A = require("./actions");
const P = require("./portal");
const S = require("./speedrun");
const { scanLoaded } = require("./scanner");
const { makePlan } = require("./planner");
const { Timer, fmt } = require("./timer");

const LOGS_NEEDED = 8; // aletler + Nether'da masa/çubuk için yedek
const COBBLE_NEEDED = 12; // kazma 3 + kılıç 2 + yol için yedek

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
  if (plan.missing > 0)
    throw new Error(
      `Portala ${plan.missing} obsidyen yetmiyor (lav dökerek yapma henüz yok). Sandığı yeterli bir seed seç.`,
    );
  await P.buildFrame(bot, plan, say);
  timer.split("Çerçeve");

  if (!(await P.lightPortal(bot, plan))) throw new Error("Portal yanmadı");
  timer.split("Portal yandı");

  if (!(await P.enterPortal(bot, plan))) throw new Error("Portaldan geçilemedi");
  timer.split("NETHER'a giriş");
  await S.waitForChunks(bot, 800, 15000);
  return plan;
}

/**
 * info: { portal: [x, z], bastion, fortress, kale }  (seed avcısı / doğrulamadan)
 * opts: { start: "bastan" | "portal", chat, delay }
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
  S.setupMovements(bot);
  S.airGuard(bot);
  S.magmaGuard(bot);

  if (opts.start !== "portal") await stageTools(bot, timer);
  await stagePortal(bot, info, timer, say);

  const p = bot.entity.position.floored();
  say(`🔥 Nether'dayım (${p.x}, ${p.y}, ${p.z}). Süre: ${fmt(timer.elapsed())}`);
  console.log("\n" + timer.table());
  return timer;
}

module.exports = { run, travelXZ };
