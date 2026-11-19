"use strict";

// Faz 4: End, Ender Ejderhası. Yöntem: yatak patlatma (speedrun yöntemi).
//
// End'de yatak kullanılınca patlar (güç 5). Ejderha ara ara fıskiyenin tepesine iner
// (ölçüldü: gövde ~(1, 63, 0), ~50 sn kalıyor) ve kafasını en yakın oyuncuya çevirir.
//   1. Giriş platformundan adanın ortasına kapalı tünelle git (endermanlar bizi görmez).
//   2. Fıskiyeden ~7 blok uzakta dur, önüne 2 blok yüksek bir duvar ör.
//   3. Ejderha inince duvarın arkasından, duvarın önüne yatak koy ve tıkla: patlama
//      kafaya gelir, duvar bizi korur (patlama hasarı görüş ışınlarıyla hesaplanır).
//      Sunucu yatak koyma/tıklamada görüş hattına bakmaz, sadece mesafeye bakar.
//   4. Ejderha ölene kadar tekrarla.

const { Vec3 } = require("vec3");
const { goals: { GoalNearXZ } } = require("mineflayer-pathfinder");
const A = require("./actions");
const C = require("./combat");
const H = require("./highway");

const isBed = (i) => i && /_bed$/.test(i.name);
const beds = (bot) => A.count(bot, isBed);

function dragon(bot) {
  return Object.values(bot.entities).find((e) => e.name === "ender_dragon") || null;
}

// Fıskiyenin (çıkış portalı) tepesi: (0, y, 0) sütunundaki en üst bedrock.
function fountainTop(bot) {
  for (let y = 90; y > 30; y--) {
    const b = bot.blockAt(new Vec3(0, y, 0));
    if (b && b.name === "bedrock") return y;
  }
  return null;
}

// (x, z) sütununda üstü açık en yüksek sağlam blok: üstünde durulur.
function groundAt(bot, x, z, fromY = 90) {
  for (let y = fromY; y > 0; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (b && b.boundingBox === "block") return y;
  }
  return null;
}

// Ejderha fıskiyeye inmiş mi?
function perched(bot, top) {
  const d = dragon(bot);
  if (!d) return false;
  const p = d.position;
  return Math.hypot(p.x, p.z) < 4 && p.y < top + 4;
}

/**
 * Adanın ortasına (fıskiyeye `dist` blok, geldiğimiz yönde) git. Dönen: duruş hücresi.
 */
async function reachCenter(bot, dist = 7, say = () => {}) {
  const me = bot.entity.position;
  const d = Math.hypot(me.x, me.z) || 1;
  const sx = Math.round((me.x / d) * dist);
  const sz = Math.round((me.z / d) * dist);
  say(`Adanın ortasına gidiyorum (${sx}, ${sz})`);
  // Kafamızda balkabağı varsa endermanlar bize kızmaz: adanın üstünden yürü (End
  // taşını kazmak yavaş: blok başına ~1,1 sn). Yoksa kapalı tünel.
  const head = bot.inventory.slots[5];
  let r;
  if (head && head.name === "carved_pumpkin") {
    // Uzun yolu yol bulucu tek seferde çözemiyor: 20 bloklık parçalar.
    for (let i = 0; i < 12; i++) {
      const p = bot.entity.position;
      const left = Math.hypot(sx - p.x, sz - p.z);
      if (left <= 3) { r = "arrived"; break; }
      const k = Math.min(1, 20 / left);
      const wx = Math.round(p.x + (sx - p.x) * k);
      const wz = Math.round(p.z + (sz - p.z) * k);
      if (!(await A.goto(bot, new GoalNearXZ(wx, wz, 2), 40000))) {
        // Yol bulucu olmadı: bu parçayı açık havada kapalı tüple geç (yüzey hizasında).
        const gy = groundAt(bot, wx, wz);
        await H.highway(bot, { x: wx, y: gy != null ? gy + 1 : null, z: wz }, { range: 2, enclosed: true, maxMs: 60000 });
      }
    }
  }
  if (r !== "arrived") r = await H.highway(bot, { x: sx, y: null, z: sz }, { range: 2, enclosed: true, maxMs: 300000, descendEarly: true, harvest: 64 });
  A.dbg("End otoyolu:", r, H.cellOf(bot).toString());
  const gy = groundAt(bot, sx, sz);
  if (gy != null) {
    r = await H.highway(bot, new Vec3(sx, gy + 1, sz), { maxMs: 60000, enclosed: true, descendEarly: true });
    A.dbg("duruş yeri:", r, H.cellOf(bot).toString());
  }
  return H.cellOf(bot);
}

// Duruş yerinin fıskiye yönündeki iki hücre: duvar (1 blok önde, 2 yüksek) ve yatak yeri (2 blok önde).
function layout(stand) {
  const d = Math.hypot(stand.x, stand.z) || 1;
  const ux = -stand.x / d;
  const uz = -stand.z / d;
  // Eksene yuvarla: duvar ve yatak düz bir hatta olsun.
  const [dx, dz] = Math.abs(ux) >= Math.abs(uz) ? [Math.sign(ux), 0] : [0, Math.sign(uz)];
  return {
    dir: [dx, dz],
    wall: [stand.offset(dx, 0, dz), stand.offset(dx, 1, dz)],
    bedFoot: stand.offset(dx * 2, 0, dz * 2),
  };
}

// Tünelin kapalı tavanını/yanlarını aç: ejderhayı görmemiz gerekmiyor ama yatak
// yeri ve önü açık olmalı (yatak 2 blok: ayak + baş, fıskiye yönünde).
async function clearBedSpot(bot, L) {
  const [dx, dz] = L.dir;
  const cells = [L.bedFoot, L.bedFoot.offset(dx, 0, dz), L.bedFoot.offset(0, 1, 0), L.bedFoot.offset(dx, 1, dz)];
  for (const c of cells) {
    const b = bot.blockAt(c);
    if (b && b.boundingBox === "block" && b.name !== "bedrock") {
      try {
        await A.withHand(bot, async () => {
          const { item } = A.fastestTool(bot, b);
          if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
          await bot.dig(b, true);
        });
      } catch (err) { A.dbg("yatak yeri açılamadı:", c.toString(), err.message); }
    }
  }
  // Yatağın altı sağlam olmalı.
  await H.placeMany(bot, [L.bedFoot.offset(0, -1, 0), L.bedFoot.offset(dx, -1, dz)], 3);
}

// Yatak koy (ayağı bedFoot'ta, başı fıskiye yönünde) ve hemen tıkla.
async function bedBomb(bot, L) {
  const [dx, dz] = L.dir;
  const item = bot.inventory.items().find(isBed);
  if (!item) return false;
  const ground = bot.blockAt(L.bedFoot.offset(0, -1, 0));
  if (!ground || ground.boundingBox !== "block") return false;
  let ok = false;
  await A.withHand(bot, async () => {
    await bot.equip(item, "hand");
    // Yatağın yönü bakış yönümüzden gelir: fıskiyeye bak.
    await bot.look(Math.atan2(-dx, -dz), 0, true);
    try {
      await bot._placeBlockWithOptions(ground, new Vec3(0, 1, 0), { forceLook: "ignore", swingArm: "right" });
    } catch (err) { A.dbg("yatak koyulamadı:", err.message); }
    const b = bot.blockAt(L.bedFoot);
    if (b && /_bed$/.test(b.name)) {
      try {
        await bot.activateBlock(b);
        ok = true;
      } catch (err) { A.dbg("yatak tıklanamadı:", err.message); }
    }
  });
  return ok;
}

/**
 * Ejderhayı öldür. Dönen: { killed, bombs, ms }
 */
async function killDragon(bot, say = () => {}, opts = {}) {
  const maxMs = opts.maxMs || 15 * 60e3;
  const t0 = Date.now();
  let killed = false;
  let bombs = 0;
  const onDead = (e) => { if (e.name === "ender_dragon") killed = true; };
  bot.on("entityDead", onDead);
  try {
    const stand = await reachCenter(bot, opts.dist || 7, say);
    const top = fountainTop(bot) || 62;
    const L = layout(stand);
    say(`Duruş ${stand}, fıskiye tepesi y=${top}, yatak ${L.bedFoot}`);
    await H.placeMany(bot, L.wall, 3);
    await clearBedSpot(bot, L);
    let lastLog = 0;
    while (!killed) {
      if (Date.now() - t0 > maxMs) throw new Error(`Ejderha çok uzun sürdü (${bombs} yatak)`);
      if (!beds(bot)) throw new Error(`Yatak bitti (${bombs} patlatıldı)`);
      const d = dragon(bot);
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        A.dbg(`ejderha: ${d ? `${d.position.x.toFixed(0)},${d.position.y.toFixed(0)},${d.position.z.toFixed(0)}` : "yok"} can ${bot.health.toFixed(0)} yatak ${beds(bot)} patlama ${bombs}`);
      }
      if (d && perched(bot, top)) {
        // Duvar yerinde mi? (patlama kırabilir)
        await H.placeMany(bot, L.wall, 2);
        await clearBedSpot(bot, L);
        if (await bedBomb(bot, L)) {
          bombs++;
          say(`  yatak patladı (${bombs}), ejderha ${d.position.y.toFixed(0)}`);
          await A.sleep(400);
        } else await A.sleep(300);
      } else {
        if (bot.food < 18 && C.bestFood(bot)) await C.eat(bot);
        await A.sleep(200);
      }
    }
  } finally {
    bot.removeListener("entityDead", onDead);
  }
  return { killed, bombs, ms: Date.now() - t0 };
}

module.exports = { killDragon, dragon, fountainTop, perched, beds };
