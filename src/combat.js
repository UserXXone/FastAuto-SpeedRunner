"use strict";

// Dövüş ve hayatta kalma: yakındaki düşmana kılıçla vur, acıkınca ye,
// hayvan avla, kalkan tak.

const {
  goals: { GoalFollow },
} = require("mineflayer-pathfinder");
const A = require("./actions");

// Bize saldıran yaratıklar. zombified_piglin ve enderman bilerek yok: dokunmazsan dokunmazlar.
const HOSTILE = new Set([
  "zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "bogged",
  "spider", "cave_spider", "creeper", "witch", "slime", "silverfish", "phantom",
  "pillager", "vindicator", "blaze", "wither_skeleton", "magma_cube", "hoglin",
  "zoglin", "piglin_brute", "ghast", "endermite",
]);
const RANGED = new Set(["blaze", "skeleton", "stray", "bogged", "ghast", "pillager"]);
const GOLD_ARMOR = /^golden_(helmet|chestplate|leggings|boots)$/;

const WEAPONS = [
  "netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "golden_sword",
  "wooden_sword", "diamond_axe", "iron_axe", "stone_axe",
];
// İyi → kötü. Çiğ tavuk açlık verdiği için en sonda.
const FOODS = [
  "cooked_beef", "cooked_porkchop", "golden_carrot", "cooked_mutton", "bread",
  "cooked_chicken", "cooked_cod", "cooked_salmon", "baked_potato", "beef",
  "porkchop", "mutton", "apple", "carrot", "chicken",
];
const ANIMALS = new Set(["cow", "pig", "sheep", "chicken", "mooshroom"]);
const RAW_MEAT = ["beef", "porkchop", "mutton", "chicken"];
const SWORD_COOLDOWN = 640; // ms

function eyeOf(bot) {
  return bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
}

// Gözden yaratığın kutusuna en kısa mesafe (oyunun vuruş menzili böyle ölçülür: 3 blok).
function reachDistance(bot, e) {
  const eye = eyeOf(bot);
  const w = (e.width || 0.6) / 2;
  const h = e.height || 1.8;
  const cx = Math.max(e.position.x - w, Math.min(eye.x, e.position.x + w));
  const cy = Math.max(e.position.y, Math.min(eye.y, e.position.y + h));
  const cz = Math.max(e.position.z - w, Math.min(eye.z, e.position.z + w));
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz);
}

// Bizi gören en yakın menzilli düşman (iskelet oku, blaze ateşi): kalkanı ona çeviririz.
function rangedThreat(bot, range = 20) {
  const eye = eyeOf(bot);
  for (const e of hostilesNear(bot, range)) {
    if (!RANGED.has(e.name) || e.name === "ghast") continue;
    const to = e.position.offset(0, (e.height || 1.8) * 0.8, 0);
    const d = to.minus(eye);
    const len = d.norm();
    if (len < 0.5 || !bot.world.raycast(eye, d.scaled(1 / len), len)) return e;
  }
  return null;
}

// Yüzümüzü çevirmeden bir noktaya doğru yürü: ileri/geri/sağ/sol tuşlarından
// hedef yöne en yakın bileşimi seç. (Kalkan başka yöne bakarken yürümek için.)
function strafeToward(bot, to) {
  const me = bot.entity.position;
  const want = Math.atan2(-(to.x - me.x), -(to.z - me.z)); // mineflayer yaw'ı: -z ileri
  let diff = want - bot.entity.yaw;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const sector = Math.round(diff / (Math.PI / 4)); // -4..4, 0 = ileri, + = sol
  bot.setControlState("forward", Math.abs(sector) <= 1);
  bot.setControlState("back", Math.abs(sector) >= 3);
  bot.setControlState("left", sector >= 1 && sector <= 3);
  bot.setControlState("right", sector <= -1 && sector >= -3);
}

function stopMoving(bot) {
  for (const c of ["forward", "back", "left", "right", "sprint"]) bot.setControlState(c, false);
}

function wearsGold(bot) {
  return [5, 6, 7, 8].some((s) => {
    const it = bot.inventory.slots[s];
    return it && GOLD_ARMOR.test(it.name);
  });
}

function isHostile(bot, e) {
  if (!e || e === bot.entity || !e.name || !e.position) return false;
  if (HOSTILE.has(e.name)) return true;
  if (e.name === "piglin") return !wearsGold(bot);
  return false;
}

function hostilesNear(bot, range) {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => isHostile(bot, e) && e.position.distanceTo(me) <= range)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

function bestWeapon(bot) {
  const items = bot.inventory.items();
  for (const n of WEAPONS) {
    const it = items.find((i) => i.name === n);
    if (it) return it;
  }
  return null;
}

function bestFood(bot) {
  const items = bot.inventory.items();
  for (const n of FOODS) {
    const it = items.find((i) => i.name === n);
    if (it) return it;
  }
  return null;
}

function foodCount(bot) {
  return A.count(bot, (i) => FOODS.includes(i.name));
}

async function equipWeapon(bot) {
  const w = bestWeapon(bot);
  if (w && (!bot.heldItem || bot.heldItem.type !== w.type)) {
    try {
      await bot.equip(w, "hand");
    } catch (err) {
      A.dbg("silah alınamadı:", err.message);
    }
  }
  return w;
}

// Kalkanı sol ele tak. Varsa true.
async function equipShield(bot) {
  const off = bot.inventory.slots[45];
  if (off && off.name === "shield") return true;
  const s = bot.inventory.items().find((i) => i.name === "shield");
  if (!s) return false;
  try {
    await bot.equip(s, "off-hand");
    return true;
  } catch (err) {
    A.dbg("kalkan takılamadı:", err.message);
    return false;
  }
}

// Bir şey ye. golden: can çok düşükse altın elma.
async function eat(bot, { golden = false } = {}) {
  const items = bot.inventory.items();
  const item = (golden && items.find((i) => i.name === "golden_apple")) || bestFood(bot);
  if (!item) return false;
  if (item.name !== "golden_apple" && bot.food >= 20) return false;
  return A.withHand(bot, () => eatNow(bot, item));
}

async function eatNow(bot, item) {
  try {
    if (bot.usingHeldItem) bot.deactivateItem(); // kalkan kalkıksa indir
    await bot.equip(item, "hand");
    const before = bot.food;
    try {
      await bot.consume();
    } catch (err) {
      // Sunucu yavaşsa mineflayer erken pes ediyor; yemek yine de bitmiş olabilir.
      if (!/timed out/i.test(err.message)) throw err;
      await A.sleep(700);
      if (bot.food <= before && item.name !== "golden_apple") {
        bot.deactivateItem();
        return false;
      }
    }
    return true;
  } catch (err) {
    A.dbg("yenemedi:", item.name, err.message);
    return false;
  }
}

/**
 * Arka planda çalışan koruma: menzile giren düşmana vurur, acıkınca yer.
 * Yol bulucu çalışırken de açık kalır. Dönen: { stop, pause, resume, stats }.
 */
function startGuard(bot, opts = {}) {
  const say = opts.say || (() => {});
  const stats = { hits: 0, kills: 0, eaten: 0 };
  let paused = 0;
  let busy = false;
  let lastAttack = 0;
  let lastTargetId = null;

  const tick = async () => {
    if (paused || busy || !bot.entity || bot.health <= 0 || bot.inLavaEscape) return;
    busy = true;
    try {
      // 1) Düşman menzilde mi?
      const target = hostilesNear(bot, 6).find((e) => reachDistance(bot, e) <= 3.0);
      if (target) {
        if (Date.now() - lastAttack >= SWORD_COOLDOWN) {
          await A.withHand(bot, async () => {
            // Kılıcı yeni aldıysak hemen vurma: eşya değişince vuruş gücü sıfırlanır.
            const w = bestWeapon(bot);
            if (w && (!bot.heldItem || bot.heldItem.type !== w.type)) await bot.equip(w, "hand");
            else bot.attack(target);
          });
          lastAttack = Date.now();
          lastTargetId = target.id;
          stats.hits++;
        }
        return;
      }
      // Kalkan: ateş eden bir şey yakındaysa kalkık dursun (önden gelen her şeyi keser).
      const off = bot.inventory.slots[45];
      if (off && off.name === "shield" && !bot.usingHeldItem && hostilesNear(bot, 32).some((e) => RANGED.has(e.name)))
        bot.activateItem(true);
      // 2) Yemek: açlık düşünce, ya da can azken tokluk doluyken iyileşmek için.
      const danger = hostilesNear(bot, 8).length > 0;
      if (bot.health <= 8 && A.count(bot, "golden_apple") > 0) {
        if (await eat(bot, { golden: true })) stats.eaten++;
      } else if (!danger && (bot.food <= 14 || (bot.health <= 14 && bot.food < 18))) {
        if (await eat(bot)) stats.eaten++;
      }
    } catch (err) {
      A.dbg("koruma hatası:", err.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 50);
  const onGone = (e) => {
    if (e.id === lastTargetId) {
      stats.kills++;
      lastTargetId = null;
    }
  };
  bot.on("entityDead", onGone);
  void say;
  return {
    stats,
    pause: () => { paused++; },
    resume: () => { paused = Math.max(0, paused - 1); },
    stop: () => {
      clearInterval(timer);
      bot.removeListener("entityDead", onGone);
    },
  };
}

// Yakındaki hayvanları avla: Nether'da can yenilemek için et lazım.
async function huntFood(bot, want = 6, { radius = 40, budgetMs = 60000 } = {}) {
  const t0 = Date.now();
  const meat = () => A.count(bot, (i) => RAW_MEAT.includes(i.name) || i.name.startsWith("cooked_"));
  const skipped = new Set();
  while (meat() < want && Date.now() - t0 < budgetMs) {
    const me = bot.entity.position;
    const prey = Object.values(bot.entities)
      .filter((e) => ANIMALS.has(e.name) && !skipped.has(e.id) && e.position.distanceTo(me) <= radius)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!prey) break;
    const deathPos = await killEntity(bot, prey, 15000);
    if (!deathPos) {
      skipped.add(prey.id);
      continue;
    }
    await A.sleep(300);
    await A.collectDrops(bot, deathPos, 5);
  }
  return meat();
}

// Bir yaratığı kovalayıp öldür. Öldüyse son konumunu döndürür.
async function killEntity(bot, target, maxMs = 15000) {
  const t0 = Date.now();
  let lastAttack = 0;
  let following = false;
  await equipWeapon(bot);
  try {
    while (bot.entities[target.id] && Date.now() - t0 < maxMs) {
      const d = reachDistance(bot, target);
      if (d <= 2.9) {
        if (Date.now() - lastAttack >= SWORD_COOLDOWN) {
          await bot.lookAt(target.position.offset(0, (target.height || 1) * 0.6, 0), true);
          await equipWeapon(bot);
          bot.attack(target);
          lastAttack = Date.now();
        }
      } else if (!following) {
        bot.pathfinder.setGoal(new GoalFollow(target, 1.5), true);
        following = true;
      }
      if (d <= 2 && following) {
        bot.pathfinder.setGoal(null);
        following = false;
      }
      await A.sleep(50);
    }
  } finally {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }
  return bot.entities[target.id] ? null : target.position.clone();
}

module.exports = {
  HOSTILE,
  RANGED,
  rangedThreat,
  strafeToward,
  stopMoving,
  eyeOf,
  FOODS,
  SWORD_COOLDOWN,
  reachDistance,
  isHostile,
  hostilesNear,
  wearsGold,
  bestWeapon,
  bestFood,
  foodCount,
  equipWeapon,
  equipShield,
  eat,
  startGuard,
  huntFood,
  killEntity,
};
