"use strict";

// Kovayla obsidyen dökme: sandıktaki obsidyen portalı tamamlamaya yetmediğinde
// eksik çerçeve bloklarını yerinde üretir.
//
// Bir blok için düzen (çerçeve düzlemine dik kesit, hepsi aynı yükseklikte):
//
//        bot (bir blok yukarıda durur, su ona ulaşamaz)
//   [P] [W] [V]      P: obsidyen olacak hücre     W: suyun konacağı hücre
//   [S] [B] [.]      S: P'nin altı (lav buna tıklanır)   B: W'nin altı (su buna tıklanır)
//
// Önce W'ye su konur, sonra P'ye lav: lav kaynağı suya değdiği an obsidyen olur.
// Lav hiç akmaz. Sonra su kovayla geri alınır.

const { Vec3 } = require("vec3");
const {
  goals: { GoalBlock, GoalNear },
} = require("mineflayer-pathfinder");
const A = require("./actions");
const H = require("./highway");

const isSolid = (b) => Boolean(b && b.boundingBox === "block");
const isOpen = (b) => Boolean(b && b.boundingBox === "empty" && b.name !== "lava" && b.name !== "water");
const buckets = (bot) => A.count(bot, (i) => ["bucket", "water_bucket", "lava_bucket"].includes(i.name));

function rayClear(bot, from, to) {
  const d = to.minus(from);
  const len = d.norm();
  if (len < 0.05) return true;
  return !bot.world.raycast(from, d.scaled(1 / len), Math.max(0.05, len - 0.05));
}

function standable(bot, c) {
  const floor = bot.blockAt(c.offset(0, -1, 0));
  return isSolid(floor) && floor.name !== "magma_block" && isOpen(bot.blockAt(c)) && isOpen(bot.blockAt(c.offset(0, 1, 0)));
}

// Elindeki eşyayı bir noktaya bakarak kullan (kova). done() doğru olana kadar birkaç kez dener.
async function useItemAt(bot, itemName, point, done) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await A.withHand(bot, async () => {
      const item = bot.inventory.items().find((i) => i.name === itemName);
      if (!item) throw new Error(`Envanterde yok: ${itemName}`);
      await bot.equip(item, "hand");
      await bot.lookAt(point, true);
      await A.sleep(150); // bakış sunucuya ulaşsın: kova, sunucunun gördüğü bakış yönüne göre çalışır
      bot.activateItem();
      await A.sleep(100);
      bot.deactivateItem();
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 1200 && !done()) await A.sleep(50);
    if (done()) return true;
    A.dbg("kova tutmadı, tekrar:", itemName, point.toString());
  }
  return done();
}

// Kaynağı (akmayan su/lav) görebileceğimiz, durulabilir en yakın yer.
function vantage(bot, src) {
  const target = src.offset(0.5, 0.5, 0.5);
  const me = bot.entity.position;
  let best = null;
  for (let dx = -3; dx <= 3; dx++)
    for (let dz = -3; dz <= 3; dz++)
      for (let dy = 0; dy <= 2; dy++) {
        const c = src.offset(dx, dy, dz);
        if (!standable(bot, c)) continue;
        const eye = c.offset(0.5, 1.62, 0.5);
        if (eye.distanceTo(target) > 4.0 || !rayClear(bot, eye, target)) continue;
        const d = c.distanceTo(me) + dy * 0.5;
        if (!best || d < best.d) best = { d, c };
      }
  return best ? best.c : null;
}

// Kovayı doldur: kind = "water" | "lava". center çevresindeki en yakın kaynaktan.
async function fill(bot, kind, center, maxDistance = 96) {
  const full = `${kind}_bucket`;
  if (A.count(bot, full) > 0) return true;
  if (A.count(bot, "bucket") === 0) throw new Error("Boş kova yok");
  const id = bot.registry.blocksByName[kind].id;
  const sources = bot
    .findBlocks({ matching: id, useExtraInfo: (b) => b.metadata === 0, maxDistance, count: 400, point: center })
    .filter((p) => isOpen(bot.blockAt(p.offset(0, 1, 0)))) // üstü açık: yüzeyden alınabilir
    .sort((a, b) => a.distanceTo(center) - b.distanceTo(center));
  A.dbg(`${kind} kaynağı: ${sources.length} aday`);
  let tried = 0;
  for (const src of sources) {
    if (tried >= 10) break;
    // Uzaktaysa önce yaklaş ki çevresi yüklensin ve duracak yer hesaplanabilsin.
    if (bot.entity.position.distanceTo(src) > 12) await A.goto(bot, new GoalNear(src.x, src.y, src.z, 5), 60000);
    const b = bot.blockAt(src);
    if (!b || b.type !== id || b.metadata !== 0) continue;
    const v = vantage(bot, src);
    if (!v) continue;
    tried++;
    if (!(await A.goto(bot, new GoalBlock(v.x, v.y, v.z), 30000))) continue;
    if (await useItemAt(bot, "bucket", src.offset(0.5, 0.5, 0.5), () => A.count(bot, full) > 0)) return true;
  }
  return false;
}

/**
 * P hücresine obsidyen dök. normal: çerçeve düzlemine dik birim vektör.
 * Elde su kovası ve lav kovası olmalı. Başarılıysa true (su kovası geri alınmış olur).
 */
async function castAt(bot, P, normal) {
  P = new Vec3(P.x, P.y, P.z);
  const S = P.offset(0, -1, 0);
  // Hangi yandan? W açık (ya da kazılabilir) olmalı.
  const sides = [1, -1]
    .map((sgn) => {
      const W = P.plus(normal.scaled(sgn));
      const V = P.plus(normal.scaled(2 * sgn)).offset(0, 1, 0);
      const wb = bot.blockAt(W);
      const score = (isOpen(wb) ? 0 : 5) + (standable(bot, V) ? 0 : 1) + V.distanceTo(bot.entity.position) * 0.01;
      return { W, V, score, wb };
    })
    .filter((s) => s.wb && s.wb.name !== "obsidian" && s.wb.name !== "bedrock")
    .sort((a, b) => a.score - b.score);
  if (!sides.length) return false;
  const { W, V } = sides[0];
  const B = W.offset(0, -1, 0);

  // Yerimize geç (gerekirse sütun dikerek).
  if (bot.entity.position.distanceTo(V) > 6) await A.goto(bot, new GoalNear(V.x, V.y, V.z, 3), 45000);
  const r = await H.highway(bot, V, { maxMs: 40000 });
  if (r !== "arrived") {
    A.dbg("döküm yerine geçilemedi:", r, V.toString());
    return false;
  }
  bot.setControlState("sneak", true); // kenardan kaymayalım
  try {
    // Hazırlık: S ve B sağlam, P ve W (ve üstleri) boş.
    if (!isSolid(bot.blockAt(S)) && !(await H.placeFiller(bot, S))) return false;
    if (!isSolid(bot.blockAt(B)) && !(await H.placeFiller(bot, B))) return false;
    for (const c of [W, W.offset(0, 1, 0), P]) {
      const b = bot.blockAt(c);
      if (b && !isOpen(b) && b.name !== "water" && !(await H.clearCell(bot, c, [W, W.offset(0, 1, 0), P]))) return false;
    }
    const nameAt = (c) => {
      const b = bot.blockAt(c);
      return b ? b.name : "";
    };
    // 1) Su.
    if (!(await useItemAt(bot, "water_bucket", B.offset(0.5, 1, 0.5), () => nameAt(W) === "water"))) {
      A.dbg("su konamadı:", W.toString());
      return false;
    }
    // 2) Lav: suya değdiği an obsidyen olur.
    const lavaPlaced = await useItemAt(bot, "lava_bucket", S.offset(0.5, 1, 0.5), () => ["obsidian", "lava"].includes(nameAt(P)));
    for (let i = 0; i < 30 && nameAt(P) === "lava"; i++) await A.sleep(50);
    // 3) Suyu geri al.
    await useItemAt(bot, "bucket", W.offset(0.5, 0.5, 0.5), () => A.count(bot, "water_bucket") > 0);
    if (!lavaPlaced) A.dbg("lav konamadı:", P.toString(), nameAt(P));
    if (nameAt(P) === "lava") {
      // Olmadı (su değmedi): lavı kovaya geri al ki akmasın.
      await useItemAt(bot, "bucket", P.offset(0.5, 0.5, 0.5), () => A.count(bot, "lava_bucket") > 0);
    }
    return nameAt(P) === "obsidian";
  } finally {
    bot.setControlState("sneak", false);
  }
}

module.exports = { fill, castAt, buckets, useItemAt };
