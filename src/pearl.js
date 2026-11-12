"use strict";

// Faz 3c: ender pearl. Warped forest'ta enderman avı.
//
// Yöntem blaze'deki ile aynı fikir: bot kapalı bir hücrede (kapsül) durur.
//   1. Baş hizasında tek blokluk bir pencere açar, en yakın endermanın gözüne
//      bakar (bakılan enderman kızar), pencereyi kapatır.
//   2. Kızan enderman yanımıza gelir ama içeri giremez (2,9 blok boyunda, kapsül
//      2 blok) ve bizi göremediği için vuramaz.
//   3. Kılıç menziline (3 blok) girince duvarın arkasından vururuz.
//   4. Pearl yanımıza düşer; uzağa düştüyse kapsülü oraya yürütüp alırız.
// Sunucu vuruşta görüş hattına bakmadığı için çalışır; normal bir oyuncu yapamaz.

const { Vec3 } = require("vec3");
const A = require("./actions");
const C = require("./combat");
const H = require("./highway");

const PEARLS_NEEDED = 12; // 12 göz
const ENDERMAN_EYE = 2.55;

const pearls = (bot) => A.count(bot, "ender_pearl");

function endermen(bot, range) {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => e.name === "enderman" && e.position.distanceTo(me) <= range)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

function pearlDrops(bot, range) {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => {
      if (e.name !== "item" || e.position.distanceTo(me) > range) return false;
      try {
        const it = e.getDroppedItem();
        return it && it.name === "ender_pearl";
      } catch (err) {
        return false;
      }
    })
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

// Yüklü chunk'larda warped forest zemini (warped_nylium) var mı? En yakınının üstü.
function findWarpedGround(bot, maxDistance = 96) {
  const id = bot.registry.blocksByName.warped_nylium.id;
  const me = bot.entity.position;
  const spots = bot
    .findBlocks({ matching: id, maxDistance, count: 200 })
    .filter((p) => {
      const a = bot.blockAt(p.offset(0, 1, 0));
      const b = bot.blockAt(p.offset(0, 2, 0));
      const c = bot.blockAt(p.offset(0, 3, 0));
      // Endermanın sığacağı açıklık: üstünde 3 blok boşluk.
      return [a, b, c].every((x) => x && x.boundingBox === "empty" && x.name !== "lava");
    })
    .sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
  return spots.length ? spots[0].offset(0, 1, 0) : null;
}

// Etrafımız kapalı mı? Değilse kapat (kapsül: ayak ve baş hizasında dört yan + tavan + zemin).
async function sealCapsule(bot) {
  const c = H.cellOf(bot);
  const shell = [c.offset(0, -1, 0), c.offset(0, 2, 0)];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    shell.push(c.offset(dx, 0, dz), c.offset(dx, 1, dz));
  }
  let open = 0;
  for (const p of shell) {
    const b = bot.blockAt(p);
    if (b && b.boundingBox !== "block") {
      if (!(await H.placeFiller(bot, p))) open++;
    }
  }
  return open === 0;
}

// Pencereyi aç, endermanın gözüne bak, pencereyi kapat.
async function lure(bot, target) {
  const c = H.cellOf(bot);
  const dx = target.position.x - (c.x + 0.5);
  const dz = target.position.z - (c.z + 0.5);
  const side = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
  const win = c.offset(side[0], 1, side[1]);
  const b = bot.blockAt(win);
  if (b && b.boundingBox === "block") {
    try {
      await A.withHand(bot, async () => {
        const { item } = A.fastestTool(bot, b);
        if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
        await bot.dig(b, true);
      });
    } catch (err) {
      A.dbg("pencere açılamadı:", err.message);
      return;
    }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 900 && bot.entities[target.id]) {
    await bot.lookAt(target.position.offset(0, ENDERMAN_EYE, 0), true);
    await A.sleep(50);
  }
  await H.placeFiller(bot, win);
}

/**
 * need kadar ender pearl topla. Bot kapsülün içinde kalır.
 * Dönen: { pearls, kills, ms }
 */
async function huntEndermen(bot, need, say, opts = {}) {
  const maxMs = opts.maxMs || 15 * 60e3;
  const t0 = Date.now();
  let lastAttack = 0;
  let lastLure = 0;
  let lastLog = 0;
  let lastCount = pearls(bot);
  let kills = 0;
  const hit = new Set();
  const onGone = (e) => {
    if (hit.delete(e.id)) kills++;
  };
  bot.on("entityGone", onGone);
  try {
    await sealCapsule(bot);
    while (pearls(bot) < need) {
      if (Date.now() - t0 > maxMs) throw new Error(`Enderman avı çok uzun sürdü (${pearls(bot)}/${need} pearl)`);
      if (bot.inLavaEscape) {
        await A.sleep(100);
        continue;
      }
      if (pearls(bot) !== lastCount) {
        lastCount = pearls(bot);
        say(`  ender pearl ${lastCount}/${need}`);
      }
      const near = endermen(bot, 48);
      const inReach = near.find((e) => C.reachDistance(bot, e) <= 3.0);
      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now();
        A.dbg(
          `enderman avı: can ${bot.health.toFixed(0)} pearl ${pearls(bot)}/${need} öldürülen ${kills} görünen ${near.length}`,
          near[0] ? `en yakın ${near[0].position.distanceTo(bot.entity.position).toFixed(1)}` : "",
        );
      }
      if (inReach) {
        if (Date.now() - lastAttack >= C.SWORD_COOLDOWN) {
          hit.add(inReach.id);
          await A.withHand(bot, async () => {
            const w = C.bestWeapon(bot);
            if (w && (!bot.heldItem || bot.heldItem.type !== w.type)) await bot.equip(w, "hand");
            else bot.attack(inReach);
          });
          lastAttack = Date.now();
        }
      } else {
        // Yerde pearl varsa ve yanımızda kızgın enderman yoksa kapsülü oraya yürüt.
        const drop = pearlDrops(bot, 12)[0];
        if (drop && drop.position.distanceTo(bot.entity.position) > 1.4 && !near.some((e) => e.position.distanceTo(bot.entity.position) < 6)) {
          const p = drop.position;
          const cell = new Vec3(Math.floor(p.x), Math.floor(p.y + 0.3), Math.floor(p.z));
          const r = await H.highway(bot, cell, { enclosed: true, maxMs: 20000 });
          A.dbg("pearl'e kapsülle gidildi:", r);
          await sealCapsule(bot);
        } else if (near.length && Date.now() - lastLure > 6000) {
          // Kızdıracak enderman: bize yakın ve aşağı yukarı aynı yükseklikte olan.
          const me = bot.entity.position;
          const target = near.find((e) => Math.abs(e.position.y - me.y) <= 6 && e.position.distanceTo(me) >= 3);
          if (target) await lure(bot, target);
          lastLure = Date.now();
        } else if (!near.length && Date.now() - lastLure > 30000) {
          // Görünürde enderman yok: biraz yer değiştir.
          lastLure = Date.now();
          const c = H.cellOf(bot);
          const dir = [[12, 0], [0, 12], [-12, 0], [0, -12]][Math.floor(Math.random() * 4)];
          await H.highway(bot, { x: c.x + dir[0], y: null, z: c.z + dir[1] }, { enclosed: true, maxMs: 30000, range: 1 });
          await sealCapsule(bot);
        }
      }
      if (!inReach && bot.food < 18 && C.bestFood(bot)) await C.eat(bot);
      await A.sleep(50);
    }
  } finally {
    bot.removeListener("entityGone", onGone);
  }
  return { pearls: pearls(bot), kills, ms: Date.now() - t0 };
}

// Blaze çubuklarını toza çevir, pearl ile birleştirip ender gözü yap.
async function craftEyes(bot) {
  const want = Math.min(pearls(bot), A.count(bot, "blaze_rod") * 2 + A.count(bot, "blaze_powder"));
  while (A.count(bot, "blaze_powder") < want && A.count(bot, "blaze_rod") > 0) {
    const before = A.count(bot, "blaze_powder");
    await A.craft(bot, "blaze_powder", 1);
    if (A.count(bot, "blaze_powder") <= before) break;
  }
  for (let i = 0; i < want; i++) {
    if (!pearls(bot) || !A.count(bot, "blaze_powder")) break;
    const before = A.count(bot, "ender_eye");
    await A.craft(bot, "ender_eye", 1);
    if (A.count(bot, "ender_eye") <= before) break;
  }
  return A.count(bot, "ender_eye");
}

module.exports = { PEARLS_NEEDED, findWarpedGround, sealCapsule, huntEndermen, craftEyes, pearls };
