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
const { goals: { GoalNearXZ, GoalNear } } = require("mineflayer-pathfinder");
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
  // İnince gövde tam ortada durmuyor (ölçüldü: (2, 64, 5) gibi; kafası bize dönük).
  return Math.hypot(p.x, p.z) < 8 && p.y < top + 6;
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
  if (!ground || ground.boundingBox !== "block") { A.dbg("yatak zemini yok:", L.bedFoot.toString()); return false; }
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

// --- Ok ---------------------------------------------------------------------
// Tam gerilmiş ok: hız 3 blok/tik, yerçekimi 0,05/tik, sürtünme 0,99/tik.
// Hedefin yatay uzaklığında yüksekliği tutturan eğimi deneme ile bul.
function arrowPitch(dx, dy) {
  let best = null;
  for (let deg = -30; deg <= 80; deg += 0.25) {
    const a = (deg * Math.PI) / 180;
    let vx = 3 * Math.cos(a), vy = 3 * Math.sin(a), x = 0, y = 0, t = 0;
    while (x < dx && t < 200) { x += vx; y += vy; vx *= 0.99; vy = vy * 0.99 - 0.05; t++; }
    if (x < dx) continue;
    const err = Math.abs(y - dy);
    if (!best || err < best.err) best = { a, err, t };
  }
  return best; // { a: radyan, t: uçuş tiki }
}

const bow = (bot) => bot.inventory.items().find((i) => i.name === "bow");
const arrows = (bot) => A.count(bot, (i) => i.name === "arrow");

// Bir hedefe ok at (hareketliyse önüne). Dönen: atıldı mı.
async function shoot(bot, target, height = 0.5, opts = {}) {
  const b = bow(bot);
  if (!b || !arrows(bot)) return false;
  let ok = false;
  await A.withHand(bot, async () => {
    await bot.equip(b, "hand");
    bot.activateItem(); // germeye başla
    await A.sleep(1100);
    const eye = bot.entity.position.offset(0, 1.62, 0);
    let to = target.position.offset(0, height, 0);
    let sol = null;
    for (let k = 0; k < 3; k++) {
      const dx = Math.hypot(to.x - eye.x, to.z - eye.z);
      sol = arrowPitch(dx, to.y - eye.y);
      if (!sol) break;
      const v = target.velocity || { x: 0, y: 0, z: 0 };
      to = target.position.offset(v.x * sol.t, height + v.y * sol.t, v.z * sol.t);
    }
    if (!sol) { bot.deactivateItem(); return; }
    const yaw = Math.atan2(-(to.x - eye.x), -(to.z - eye.z));
    // Okun ilk 4 bloğu açık mı? Kapalı tüpün içindeysek oklar duvara gidiyordu.
    const dir = new Vec3(-Math.sin(yaw) * Math.cos(sol.a), Math.sin(sol.a), -Math.cos(yaw) * Math.cos(sol.a));
    const hit = bot.world.raycast(eye, dir, 4, (bl) => bl && bl.boundingBox === "block");
    if (hit) {
      bot.deactivateItem();
      const keep = opts.keep || [];
      if (!["bedrock", "obsidian", "end_portal_frame"].includes(hit.name) && !keep.some((k) => k.equals(hit.position))) {
        A.dbg("ok yolu kapalı, açıyorum:", hit.name, hit.position.toString());
        try {
          const { item } = A.fastestTool(bot, hit);
          if (item) await bot.equip(item, "hand");
          await bot.dig(hit, true);
        } catch (err) { /* */ }
      }
      return;
    }
    await bot.look(yaw, sol.a, true);
    await A.sleep(60);
    bot.deactivateItem(); // bırak
    ok = true;
  });
  return ok;
}

// Kristaller: kulelerin tepesinde. Kafesli olanlara ok geçmez (demir parmaklık); atlarız.
function crystals(bot) {
  return Object.values(bot.entities).filter((e) => e.name === "end_crystal");
}
function caged(bot, c) {
  const p = c.position.floored();
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 2, 0]]) {
    const b = bot.blockAt(p.offset(dx, dy, dz));
    if (b && b.name === "iron_bars") return true;
  }
  return false;
}

async function shootCrystals(bot, say, maxMs = 180000) {
  const t0 = Date.now();
  const tried = new Map();
  let broken = 0;
  while (Date.now() - t0 < maxMs && arrows(bot)) {
    const me = bot.entity.position;
    const list = crystals(bot).filter((c) => !caged(bot, c) && (tried.get(c.id) || 0) < 6)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
    if (!list.length) break;
    const c = list[0];
    tried.set(c.id, (tried.get(c.id) || 0) + 1);
    await shoot(bot, c, 1.0);
    await A.sleep(1500);
    if (!bot.entities[c.id]) { broken++; say(`  kristal patladı (${broken})`); }
  }
  return { broken, left: crystals(bot).length };
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
    const stand = await reachCenter(bot, opts.dist || 9, say);
    const top = fountainTop(bot) || 62;
    const L = layout(stand);
    say(`Duruş ${stand}, fıskiye tepesi y=${top}, yatak ${L.bedFoot}`);
    await H.placeMany(bot, L.wall, 3);
    await clearBedSpot(bot, L);
    // Kristalleri döngü içinde, ejderha havadayken teker teker vururuz: kristale
    // kilitlenip inen ejderhayı kaçırıyorduk.
    const crystalTries = new Map();
    let crystalsBroken = 0;
    let lastLog = 0;
    while (!killed) {
      if (Date.now() - t0 > maxMs) throw new Error(`Ejderha çok uzun sürdü (${bombs} yatak)`);
      if (!beds(bot)) throw new Error(`Yatak bitti (${bombs} patlatıldı)`);
      const d = dragon(bot);
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        A.dbg(`ejderha: ${d ? `${d.position.x.toFixed(0)},${d.position.y.toFixed(0)},${d.position.z.toFixed(0)}` : "yok"} can ${bot.health.toFixed(0)} yatak ${beds(bot)} patlama ${bombs}`);
      }
      // Ejderha ateş topunun mor bulutu (nefes) üstümüzdeyse kaç: içinde durunca öldük.
      const cloud = Object.values(bot.entities).find((e) => e.name === "area_effect_cloud" && e.position.distanceTo(bot.entity.position) < 4.5);
      if (cloud) {
        const away = bot.entity.position.minus(cloud.position);
        const n = Math.hypot(away.x, away.z) || 1;
        const tx = Math.round(bot.entity.position.x + (away.x / n) * 6);
        const tz = Math.round(bot.entity.position.z + (away.z / n) * 6);
        A.dbg("nefes bulutu: kaçıyorum", tx, tz);
        await A.goto(bot, new GoalNearXZ(tx, tz, 1), 5000);
        for (let i = 0; i < 40 && bot.entities[cloud.id] && cloud.position.distanceTo(stand) < 4.5; i++) await A.sleep(250);
        await A.goto(bot, new GoalNear(stand.x, stand.y, stand.z, 0), 8000);
        continue;
      }
      if (d && perched(bot, top)) {
        // İniş ~50 sn: art arda patlat (duvarı sadece yıkıldıysa onar). Yavaş kalınca
        // (tur başına 5 sn) ejderha kafasıyla bizi öldürdü.
        const solid = (p) => (bot.blockAt(p) || {}).boundingBox === "block";
        if (!L.wall.every(solid)) await H.placeMany(bot, L.wall, 2);
        // Patlama yatağın altındaki zemini de götürüyor: zemin ya da yer dolmuşsa düzelt.
        const [ddx, ddz] = L.dir;
        const under = [L.bedFoot.offset(0, -1, 0), L.bedFoot.offset(ddx, -1, ddz)];
        const spot = bot.blockAt(L.bedFoot);
        if (!under.every(solid) || (spot && spot.boundingBox === "block")) await clearBedSpot(bot, L);
        if (await bedBomb(bot, L)) {
          bombs++;
          say(`  yatak patladı (${bombs}), ejderha ${d.position.y.toFixed(0)}`);
        }
        await A.sleep(120);
      } else {
        if (bot.food < 18 && C.bestFood(bot)) await C.eat(bot);
        // Havada: önce kafessiz kristaller (iyileştiriyorlar, dururken ejderha az iniyor),
        // bitince menzildeyse ejderhaya ok.
        const me = bot.entity.position;
        const c = bow(bot) && arrows(bot) ? crystals(bot).filter((x) => !caged(bot, x) && (crystalTries.get(x.id) || 0) < 6)
          .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] : null;
        if (c) {
          crystalTries.set(c.id, (crystalTries.get(c.id) || 0) + 1);
          await shoot(bot, c, 1.0, { keep: L.wall });
          await A.sleep(600);
          if (!bot.entities[c.id]) { crystalsBroken++; say(`  kristal patladı (${crystalsBroken}), ${crystals(bot).length} kaldı`); }
        } else if (d && bow(bot) && arrows(bot) > 16 && d.position.distanceTo(me) < 40) await shoot(bot, d, 1.5, { keep: L.wall });
        else await A.sleep(200);
      }
    }
  } finally {
    bot.removeListener("entityDead", onDead);
  }
  return { killed, bombs, ms: Date.now() - t0 };
}

module.exports = { killDragon, dragon, fountainTop, perched, beds };
