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
    // Kendi tünelimizin blokları zemin değil.
    if (b && b.boundingBox === "block" && !["cobblestone", "netherrack", "cobbled_deepslate"].includes(b.name)) return y;
  }
  return null;
}

// Ejderha fıskiyeye inmiş mi? Alçaktan geçerken de yakın oluyor (yatak boşa gitti):
// son ~0,8 sn'de neredeyse kıpırdamamış olmalı.
const trail = [];
function perched(bot, top) {
  const d = dragon(bot);
  if (!d) return false;
  const p = d.position;
  const now = Date.now();
  trail.push({ t: now, p: p.clone() });
  while (trail.length && now - trail[0].t > 500) trail.shift();
  const moved = trail.length ? trail[0].p.distanceTo(p) : 99;
  const near = Math.hypot(p.x, p.z) < 8 && p.y < top + 6;
  if (near && (!bot._perchLog || now - bot._perchLog > 1000)) {
    bot._perchLog = now;
    A.dbg(`iniş?: ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} kıpırdama ${moved.toFixed(2)} süre ${now - trail[0].t} tepe ${top}`);
  }
  if (now - (trail[0] ? trail[0].t : now) < 300 || moved > 1.5) return false;
  // İnince gövde tam ortada durmuyor (ölçüldü: (2, 64, 5) gibi; kafası bize dönük).
  return Math.hypot(p.x, p.z) < 8 && p.y < top + 6;
}

/**
 * Adanın ortasına (fıskiyeye `dist` blok, geldiğimiz yönde) git. Dönen: duruş hücresi.
 */
async function reachCenter(bot, dist = 7, say = () => {}) {
  const me = bot.entity.position;
  // Obsidyen kuleler 42 blok yarıçapta, 0°, 36°, 72°... açılarında (vanilla SpikeFeature):
  // düz giden tünel x ekseninde kuleye çarpıp takılıyordu. İki kulenin arasından geç.
  const ang = Math.atan2(me.z, me.x);
  const step = Math.PI / 5;
  const gap = Math.round((ang - step / 2) / step) * step + step / 2;
  const sx = Math.round(Math.cos(gap) * dist);
  const sz = Math.round(Math.sin(gap) * dist);
  say(`Adanın ortasına gidiyorum (${sx}, ${sz}), kuleler arasından`);
  if (Math.hypot(me.x, me.z) > 52) {
    const wx = Math.round(Math.cos(gap) * 56), wz = Math.round(Math.sin(gap) * 56);
    const r0 = await H.longHaul(bot, { x: wx, z: wz }, { range: 3, minY: 50, maxY: 72, maxMs: 400000, harvest: 1 });
    A.dbg("End tüneli (ara nokta):", r0, H.cellOf(bot).toString());
  }
  // Baştan sona kapalı tünel (çoğu yer altında): açıkta yürürken ejderha görüp ateş
  // topu atıyor, defalarca yolda öldük. Tünelin içi görünmez.
  let r = await H.longHaul(bot, { x: sx, z: sz }, { range: 2, minY: 50, maxY: 72, maxMs: 900000, harvest: 1 });
  A.dbg("End tüneli:", r, H.cellOf(bot).toString());
  const gy = groundAt(bot, sx, sz);
  if (gy == null) return { surface: H.cellOf(bot) };
  // Sığınak: ayak gy-2, baş gy-1; tavan gy doğal End taşı (hiç kazılmaz). gy-1'de
  // durunca tavanı kazmak gerekiyordu, boşluktan ateş topu girip üstümüze bulut düştü.
  r = await H.highway(bot, new Vec3(sx, gy - 2, sz), { maxMs: 90000, enclosed: true, descendEarly: true });
  A.dbg("sığınak yeri:", r, H.cellOf(bot).toString());
  return { surface: new Vec3(sx, gy + 1, sz) };

}

// Duruş yerinin fıskiye yönündeki iki hücre: duvar (1 blok önde, 2 yüksek) ve yatak yeri (2 blok önde).
const BED_RAISE = Number(process.env.BED_RAISE || 2);
const POPUP = process.env.EJDERHA_CIK === "1"; // inişte yüzeye çık (deneysel)
function layout(stand) {
  const d = Math.hypot(stand.x, stand.z) || 1;
  const ux = -stand.x / d;
  const uz = -stand.z / d;
  // Eksene yuvarla: duvar ve yatak düz bir hatta olsun.
  const [dx, dz] = Math.abs(ux) >= Math.abs(uz) ? [Math.sign(ux), 0] : [0, Math.sign(uz)];
  // Yatak yerden 2 blok yukarıda (direğimizin hizasında): ejderhanın kafası inişte
  // yüksekte duruyor; yerdeki yatak kafaya ~7 blok kalıyor, hasar ~5 (ölçüldü).
  const bedFoot = stand.offset(dx * 2, BED_RAISE, dz * 2);
  const supports = [];
  for (let i = 0; i < BED_RAISE; i++) supports.push(stand.offset(dx * 2, i, dz * 2), stand.offset(dx * 3, i, dz * 3));
  return { dir: [dx, dz], wall: [stand.offset(dx, 0, dz), stand.offset(dx, 1, dz)], bedFoot, supports };
}

// Tünelin kapalı tavanını/yanlarını aç: ejderhayı görmemiz gerekmiyor ama yatak
// yeri ve önü açık olmalı (yatak 2 blok: ayak + baş, fıskiye yönünde).
async function clearBedSpot(bot, L) {
  const [dx, dz] = L.dir;
  const cells = [L.bedFoot, L.bedFoot.offset(dx, 0, dz), L.bedFoot.offset(0, 1, 0), L.bedFoot.offset(dx, 1, dz)];
  for (const c of cells) {
    const b = bot.blockAt(c);
    // Patlama ateş bırakıyor: ateşli hücreye ne yatak ne blok koyulur (sunucu 5 sn cevap
    // vermiyordu, bot bekliyor gibi duruyordu). Ateşi vurarak söndür.
    if (b && (b.name === "fire" || b.name === "soul_fire")) {
      try { await bot.dig(b, true); } catch (err) { /* */ }
      continue;
    }
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
  // Yatağın altı sağlam olmalı (yükseltilmişse destek sütunları).
  await H.placeMany(bot, [...(L.supports || []), L.bedFoot.offset(0, -1, 0), L.bedFoot.offset(dx, -1, dz)], 4);
}

// Yatağı yerine koy (tıklamadan).
async function placeBed(bot, L) {
  const [dx, dz] = L.dir;
  const item = bot.inventory.items().find(isBed);
  const ground = bot.blockAt(L.bedFoot.offset(0, -1, 0));
  if (!item || !ground || ground.boundingBox !== "block") return false;
  const spot = bot.blockAt(L.bedFoot);
  if (spot && spot.boundingBox === "block") return false;
  await A.withHand(bot, async () => {
    await bot.equip(item, "hand");
    await bot.look(Math.atan2(-dx, -dz), 0, true);
    try { await bot._placeBlockWithOptions(ground, new Vec3(0, 1, 0), { forceLook: "ignore", swingArm: "right" }); } catch (err) { /* */ }
  });
  return Boolean(bot.blockAt(L.bedFoot)?.name?.endsWith("_bed"));
}

// Yatak koy (ayağı bedFoot'ta, başı fıskiye yönünde) ve hemen tıkla.
async function bedBomb(bot, L) {
  const [dx, dz] = L.dir;
  const item = bot.inventory.items().find(isBed);
  if (!item) return false;
  const ground = bot.blockAt(L.bedFoot.offset(0, -1, 0));
  if (!ground || ground.boundingBox !== "block") { A.dbg("yatak zemini yok:", L.bedFoot.toString()); return false; }
  let ok = false;
  const ready = bot.blockAt(L.bedFoot);
  if (ready && /_bed$/.test(ready.name)) {
    try { await bot.activateBlock(ready); return true; } catch (err) { A.dbg("yatak tıklanamadı:", err.message); }
  }
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

// Ejderhanın kafası (vanilla: gövde + (sin yRot, -cos yRot)·6,5; mineflayer yaw = π − yRot;
// inişte kafa gövdenin 1 blok altında).
function headOf(d) {
  return new Vec3(d.position.x + Math.sin(d.yaw) * 6.5, d.position.y - 1, d.position.z + Math.cos(d.yaw) * 6.5);
}

// Kafanın hemen altına yatak koy ve patlat. Uygun değilse null (sabit yere koyarız).
async function headBomb(bot, d, avoid) {
  const h = headOf(d);
  const foot = new Vec3(Math.floor(h.x), Math.floor(h.y) - 1, Math.floor(h.z));
  const eye = bot.entity.position.offset(0, 1.62, 0);
  if (eye.distanceTo(foot.offset(0.5, 0.5, 0.5)) > 4.4) return null;
  // Yatağın başı gövdeye doğru (kafadan gövdeye).
  const gx = d.position.x - h.x, gz = d.position.z - h.z;
  const [dx, dz] = Math.abs(gx) >= Math.abs(gz) ? [Math.sign(gx) || 1, 0] : [0, Math.sign(gz) || 1];
  const cells = [foot, foot.offset(dx, 0, dz)];
  if (cells.some((c) => avoid.some((a) => a.equals(c)))) return null;
  A.dbg(`kafa ${h.x.toFixed(1)},${h.y.toFixed(1)},${h.z.toFixed(1)} gövde ${d.position.x.toFixed(1)},${d.position.y.toFixed(1)},${d.position.z.toFixed(1)} yaw ${d.yaw.toFixed(2)} → yatak ${foot}`);
  await clearBedSpot(bot, { dir: [dx, dz], bedFoot: foot, supports: [] });
  return bedBomb(bot, { dir: [dx, dz], bedFoot: foot });
}

// Yolda kurduğumuz kapalı tüpü aç (kırıktaş/netherrack): içinde kalınca nefesten
// kaçamadık. Duvar hücrelerine dokunma.
async function openTube(bot, stand, L) {
  const keep = L ? L.wall : [];
  for (let dy = 0; dy <= 2; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const c = stand.offset(dx, dy, dz);
        if (keep.some((k) => k.equals(c))) continue;
        const b = bot.blockAt(c);
        if (!b || !["cobblestone", "netherrack", "cobbled_deepslate"].includes(b.name)) continue;
        try {
          await A.withHand(bot, async () => {
            const { item } = A.fastestTool(bot, b);
            if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
            await bot.dig(b, true);
          });
        } catch (err) { /* */ }
      }
}

// Buluttan uzağa düz koş (zıplayarak, sprint). Önümüz kapalıysa yan dön.
async function fleeFrom(bot, cloud) {
  // Nefes bulutu büyüyor (yarıçap ~3'ten 6+'ya): 9 blok uzaklaşana kadar koş.
  const cloudsNear = () => Object.values(bot.entities).filter((e) => e.name === "area_effect_cloud" && e.position.distanceTo(bot.entity.position) < 9);
  const base = Math.atan2(bot.entity.position.x - cloud.position.x, bot.entity.position.z - cloud.position.z);
  const tries = [0, 0, Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4, 0];
  for (const off of tries) {
    if (!cloudsNear().length) break;
    const ang = (Math.hypot(bot.entity.position.x - cloud.position.x, bot.entity.position.z - cloud.position.z) < 1
      ? Math.atan2(bot.entity.position.x, bot.entity.position.z) : base) + off;
    // mineflayer yaw: bakış yönü (-sin y, -cos y); "ang" yönüne bakmak için:
    const yaw = Math.atan2(-Math.sin(ang), -Math.cos(ang));
    await bot.look(yaw, 0, true);
    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);
    bot.setControlState("jump", true);
    const p0 = bot.entity.position.clone();
    await A.sleep(1300);
    C.stopMoving(bot);
    bot.setControlState("sprint", false);
    bot.setControlState("jump", false);
    if (bot.entity.position.distanceTo(p0) < 2) {
      // Önümüz kapalı: önündeki iki bloğu kaz (taş tüp/duvar), sonra tekrar koş.
      A.dbg("kaçış yönü kapalı, önü açıyorum");
      const c = H.cellOf(bot);
      const dx = Math.round(Math.sin(ang)), dz = Math.round(Math.cos(ang));
      for (const dy of [0, 1]) {
        const b = bot.blockAt(c.offset(dx, dy, dz));
        if (b && b.boundingBox === "block" && b.name !== "bedrock" && b.name !== "obsidian") {
          try {
            await A.withHand(bot, async () => {
              const { item } = A.fastestTool(bot, b);
              if (item) await bot.equip(item, "hand");
              await bot.dig(b, true);
            });
          } catch (err) { /* */ }
        }
      }
    }
  }
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
  const aim = () => {
    const eye = bot.entity.position.offset(0, 1.62, 0);
    let to = target.position.offset(0, height, 0);
    let sol = null;
    for (let k = 0; k < 3; k++) {
      sol = arrowPitch(Math.hypot(to.x - eye.x, to.z - eye.z), to.y - eye.y);
      if (!sol) return null;
      const v = target.velocity || { x: 0, y: 0, z: 0 };
      to = target.position.offset(v.x * sol.t, height + v.y * sol.t, v.z * sol.t);
    }
    const yaw = Math.atan2(-(to.x - eye.x), -(to.z - eye.z));
    const dir = new Vec3(-Math.sin(yaw) * Math.cos(sol.a), Math.sin(sol.a), -Math.cos(yaw) * Math.cos(sol.a));
    return { eye, yaw, pitch: sol.a, dir };
  };
  const keep = opts.keep || [];
  // Okun ilk 4 bloğu açık olmalı (kendi kapsülümüz/tüpümüz): gerekirse pencere aç.
  for (let i = 0; i < 3; i++) {
    const s0 = aim();
    if (!s0) return false;
    const hit = bot.world.raycast(s0.eye, s0.dir, 4, (bl) => bl && bl.boundingBox === "block");
    if (!hit) break;
    if (["bedrock", "obsidian", "end_portal_frame"].includes(hit.name) || keep.some((k) => k.equals(hit.position))) return false;
    // Sadece izin verilen pencereler (kapsülün yan, göz hizası): tavanı açınca ejderha
    // bizi görüp ateş topu attı.
    if (opts.windows && !opts.windows.some((w) => w.equals(hit.position))) return false;
    A.dbg("ok yolu kapalı, pencere:", hit.name, hit.position.toString());
    try {
      await A.withHand(bot, async () => {
        const { item } = A.fastestTool(bot, hit);
        if (item) await bot.equip(item, "hand");
        await bot.dig(hit, true);
      });
    } catch (err) { return false; }
  }
  let ok = false;
  await A.withHand(bot, async () => {
    await bot.equip(b, "hand");
    bot.activateItem(); // germeye başla
    await A.sleep(1100);
    const s1 = aim();
    if (!s1) { bot.deactivateItem(); return; }
    await bot.look(s1.yaw, s1.pitch, true);
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
    // Ejderha yaklaşırsa bırak (görünce ateş topu atıyor).
    const d = dragon(bot);
    if (d && d.position.distanceTo(me) < 50) { await A.sleep(500); continue; }
    const list = crystals(bot).filter((c) => !caged(bot, c) && (tried.get(c.id) || 0) < 4 && c.position.distanceTo(me) < 110)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
    if (!list.length) break;
    const c = list[0];
    tried.set(c.id, (tried.get(c.id) || 0) + 1);
    await shoot(bot, c, 1.0);
    await A.sleep(1200 + c.position.distanceTo(me) * 15); // uzak hedefte ok geç varıyor
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
  const onBar = (b) => { if (b && typeof b.health === "number") bot._dragonHp = b.health; };
  const onHurt = (who, src) => {
    if (who !== bot.entity || !src || src.name !== "ender_dragon") return;
    bot._dragonHurtAt = Date.now();
    const me = bot.entity.position;
    const cl = Object.values(bot.entities).filter((e) => e.name === "area_effect_cloud" && e.position.distanceTo(me) < 12)
      .map((e) => `${e.position.x.toFixed(1)},${e.position.y.toFixed(1)},${e.position.z.toFixed(1)}`);
    A.dbg(`ejderha vurdu: ben ${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)} | bulutlar: ${cl.join(" ") || "yok"} | ejderha ${src.position.x.toFixed(0)},${src.position.y.toFixed(0)},${src.position.z.toFixed(0)}`);
  };
  bot.on("entityHurt", onHurt);
  bot.on("bossBarUpdated", onBar);
  bot.on("bossBarCreated", onBar);
  bot.on("entityDead", onDead);
  try {
    // Kristaller ejderhayı iyileştiriyor (yataklar 200→140 indirdi, uçarken 200'e döndü):
    // tünele girmeden giriş platformundan okla vur.
    if (bow(bot) && arrows(bot)) {
      for (let i = 0; i < 40 && !crystals(bot).length; i++) await A.sleep(250); // varlıklar yüklensin
      A.dbg("görünen kristal:", crystals(bot).length, crystals(bot).map((c) => c.position.distanceTo(bot.entity.position).toFixed(0)).join(" "));
      const k = await shootCrystals(bot, say, opts.crystalMs || 120000);
      say(`Kristaller (platformdan): ${k.broken} patladı, ${k.left} kaldı`);
    }
    const stand = (await reachCenter(bot, opts.dist || 9, say)).surface;
    const top = fountainTop(bot) || 62;
    const L = layout(stand);
    // Sığınak: duruş yerinde 2 blok aşağı kaz, üstünü kapat. Yer altında ejderha bizi
    // görmüyor (ne ateş topu ne nefes); yatak 2 blok önde, yerin üstünde: patlama ile
    // aramızda toprak var. Yerüstünde kapsül/direk denendi: kurarken ya da ok atarken
    // görüp vurdu.
    L.bedFoot = stand.offset(L.dir[0] * 2, 0, L.dir[1] * 2);
    L.supports = [];
    L.wall = [];
    say(`Duruş ${stand}, fıskiye tepesi y=${top}, yatak ${L.bedFoot}`);
    const [wx, wz] = L.dir;
    for (let i = 0; i < 3 && H.cellOf(bot).y > stand.y - 3; i++) {
      const below = bot.blockAt(H.cellOf(bot).offset(0, -1, 0));
      if (!below || below.boundingBox !== "block" || below.name === "bedrock") break;
      try {
        await A.withHand(bot, async () => {
          const { item } = A.fastestTool(bot, below);
          if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
          await bot.dig(below, true);
        });
      } catch (err) { break; }
      for (let k = 0; k < 20 && !bot.entity.onGround; k++) await A.sleep(50);
    }
    const perch = H.cellOf(bot);
    A.dbg("ejderha sığınağı:", perch.toString(), "derinlik", stand.y - perch.y);
    const shell = [perch.offset(0, -1, 0)];
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) shell.push(perch.offset(sx, 0, sz));
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) shell.push(perch.offset(sx, 1, sz));
    // Tavan: yanında tutunacak blok yoksa önce bir köprü bloğu (arkamızda, yatağın tersinde).
    shell.push(perch.offset(-wx, 2, -wz), perch.offset(0, 2, 0));
    bot._noFill = [perch, perch.offset(0, 1, 0)];
    const windows = [];
    let up = false; // sığınaktan yüzeye çıktık mı (ejderha bizi görsün diye)
    let upAt = 0;
    const reseal = async () => {
      if (up) return;
      if (shell.some((c) => (bot.blockAt(c) || {}).boundingBox !== "block")) await H.placeMany(bot, shell, 4);
    };
    const digCell = async (c) => {
      const b = bot.blockAt(c);
      if (!b || b.boundingBox !== "block" || b.name === "bedrock") return;
      try {
        await A.withHand(bot, async () => {
          const { item } = A.fastestTool(bot, b);
          if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
          await bot.dig(b, true);
        });
      } catch (err) { /* */ }
    };
    // Yüzeye çık: tavanı kaz, iki blok yüksel. Ejderha görmediği oyuncu için fıskiyede
    // ancak 5 sn oturuyor; görünce ~30-50 sn oturup nefes atıyor (yatak zamanı).
    // Yüzeydeyken yatak yanda (1 önde, 2 yanda), patlama ile aramızda yan duvar; fıskiyeye
    // bakan taraf açık kalır (ejderha bizi görsün).
    const [px, pz] = [-wz, wx];
    const top2 = perch.offset(0, 2, 0); // yüzeyde ayaklarımızın hücresi
    const Lup = { dir: [wx, wz], bedFoot: top2.offset(wx + 2 * px, 0, wz + 2 * pz), supports: [] };
    const sideWall = [top2.offset(px, 0, pz), top2.offset(px, 1, pz), top2.offset(wx + px, 1, wz + pz)];
    const popUp = async () => {
      bot._noFill = null;
      await digCell(perch.offset(0, 2, 0));
      for (let i = 0; i < 3 && H.cellOf(bot).y < perch.y + 2; i++) await H.pillarUp(bot);
      up = H.cellOf(bot).y >= perch.y + 2;
      upAt = Date.now();
      if (up) {
        bot._noFill = [H.cellOf(bot), H.cellOf(bot).offset(0, 1, 0)];
        await H.placeMany(bot, sideWall, 3);
        await clearBedSpot(bot, Lup);
      }
      A.dbg("yüzeye çıktım:", up, H.cellOf(bot).toString(), "yatak", Lup.bedFoot.toString());
    };
    // Sığınağa in: altımızdaki iki bloğu kaz, tavanı kapat.
    const dropDown = async (why) => {
      A.dbg("sığınağa iniyorum:", why);
      for (let i = 0; i < 3 && H.cellOf(bot).y > perch.y; i++) {
        await digCell(H.cellOf(bot).offset(0, -1, 0));
        for (let k = 0; k < 20 && !bot.entity.onGround; k++) await A.sleep(50);
      }
      up = false;
      bot._noFill = [perch, perch.offset(0, 1, 0)];
      await H.placeMany(bot, shell, 4);
    };
    await reseal();
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
      await reseal();
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        A.dbg(`ejderha can ${bot._dragonHp != null ? Math.round(bot._dragonHp * 200) : "?"}/200 |`, `${d ? `${d.position.x.toFixed(0)},${d.position.y.toFixed(0)},${d.position.z.toFixed(0)}` : "yok"} can ${bot.health.toFixed(0)} yatak ${beds(bot)} patlama ${bombs}`);
      }
      // Ejderha ateş topunun mor bulutu (nefes) üstümüzdeyse kaç: içinde durunca öldük.
      // Bulut yerde: ayağımız ondan 1,5 blok yukarıdaysa (direkteyiz) dokunmaz.
      // Sadece gerçekten vuruluyorsak kaç: sığınaktayken üstümüzdeki bulut dokunmuyor,
      // kaçmaya kalkınca dışarı çıkıp öldük.
      const hurtRecently = Date.now() - (bot._dragonHurtAt || 0) < 1500;
      const cloud = hurtRecently && Object.values(bot.entities).find((e) => e.name === "area_effect_cloud" && e.position.distanceTo(bot.entity.position) < 8);
      if (up && (hurtRecently || cloud)) { await dropDown("vuruldum"); continue; }
      if (cloud) {
        // Bulutun merkezi tam üstümüzdeyse "uzağı" yok: fıskiyeden dışarı doğru kaç.
        let away = bot.entity.position.minus(cloud.position);
        if (Math.hypot(away.x, away.z) < 1) away = bot.entity.position.clone();
        const n = Math.hypot(away.x, away.z) || 1;
        const tx = Math.round(bot.entity.position.x + (away.x / n) * 8);
        const tz = Math.round(bot.entity.position.z + (away.z / n) * 8);
        A.dbg("nefes bulutu: kaçıyorum", tx, tz);
        // Yol bulucu bulutun içinde saniyelerce düşünüyordu (öldük): düz koş, zıplayarak.
        await fleeFrom(bot, cloud);
        const cloudNearStand = () => Object.values(bot.entities).some((e) => e.name === "area_effect_cloud" && e.position.distanceTo(stand) < 7);
        // Bulut dağılana kadar boş bekleme: bu sırada kristale/ejderhaya ok at.
        const tw = Date.now();
        while (Date.now() - tw < 15000 && cloudNearStand() && !killed) {
          const me = bot.entity.position;
          const c = bow(bot) && arrows(bot) ? crystals(bot).filter((x) => !caged(bot, x) && (crystalTries.get(x.id) || 0) < 6)
            .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] : null;
          const dd = dragon(bot);
          if (c) {
            crystalTries.set(c.id, (crystalTries.get(c.id) || 0) + 1);
            await shoot(bot, c, 1.0, { keep: L.wall, windows });
            await A.sleep(400);
            if (!bot.entities[c.id]) { crystalsBroken++; say(`  kristal patladı (${crystalsBroken}), ${crystals(bot).length} kaldı`); }
          } else if (dd && bow(bot) && arrows(bot) > 16 && dd.position.distanceTo(me) < 40) await shoot(bot, dd, 1.5);
          else await A.sleep(250);
        }
        await A.goto(bot, new GoalNear(stand.x, stand.y, stand.z, 0), 8000);
        for (let i = 0; i < 2 && H.cellOf(bot).y < perch.y; i++) if (!(await H.pillarUp(bot))) break;
        continue;
      }
      // İniyor mu? Fıskiyeye yakın ve alçakta: yüzeye çık ki bizi görüp otursun.
      const landing = d && Math.hypot(d.position.x, d.position.z) < 14 && d.position.y < top + 12;
      if (POPUP && !up && landing && Date.now() - upAt > 3000) { await popUp(); continue; }
      // Yatak hazırda dursun: ejderha oturunca sadece tıklarız (görmezse 5 sn oturuyor).
      if (!up && !bot.blockAt(L.bedFoot)?.name?.endsWith("_bed") && beds(bot) && (!d || !perched(bot, top))) await placeBed(bot, L);
      if (up && !landing && Date.now() - upAt > 6000) { await dropDown("ejderha kalktı"); continue; }
      if (d && perched(bot, top)) {
        // İniş ~50 sn: art arda patlat (duvarı sadece yıkıldıysa onar). Yavaş kalınca
        // (tur başına 5 sn) ejderha kafasıyla bizi öldürdü.
        const solid = (p) => (bot.blockAt(p) || {}).boundingBox === "block";
        if (!L.wall.every(solid)) await H.placeMany(bot, L.wall, 2);
        // Patlama yatağın altındaki zemini de götürüyor: zemin ya da yer dolmuşsa düzelt.
        const [ddx, ddz] = L.dir;
        const under = [L.bedFoot.offset(0, -1, 0), L.bedFoot.offset(ddx, -1, ddz)];
        const spot = bot.blockAt(L.bedFoot);
        const head = bot.blockAt(L.bedFoot.offset(ddx, 0, ddz));
        const fiery = [spot, head].some((x) => x && /fire$/.test(x.name));
        const ready = spot && /_bed$/.test(spot.name);
        if (!ready && (!under.every(solid) || fiery || (spot && spot.boundingBox === "block"))) await clearBedSpot(bot, L);
        let done;
        if (up) {
          if (!sideWall.every(solid)) await H.placeMany(bot, sideWall, 2);
          const ub = bot.blockAt(Lup.bedFoot);
          const uu = bot.blockAt(Lup.bedFoot.offset(0, -1, 0));
          if (!solid(uu) || (ub && (ub.boundingBox === "block" || /fire$/.test(ub.name)))) await clearBedSpot(bot, Lup);
          done = await bedBomb(bot, Lup);
        } else {
          done = await bedBomb(bot, L);
        }
        if (done) {
          bombs++;
          const hx = d.position.x - Math.sin(d.yaw) * 6.5, hz = d.position.z - Math.cos(d.yaw) * 6.5;
          say(`  ${new Date().toISOString().slice(14, 21)} yatak patladı (${bombs}), ejderha ${d.position.y.toFixed(0)}, can ${bot._dragonHp != null ? Math.round(bot._dragonHp * 200) : "?"}/200, kafa~(${hx.toFixed(1)}, ${hz.toFixed(1)}) yatak ${L.bedFoot.x},${L.bedFoot.z}`);
        }
        await A.sleep(40);
      } else {
        if (bot.food < 18 && C.bestFood(bot)) await C.eat(bot);
        // Havada: önce kafessiz kristaller (iyileştiriyorlar, dururken ejderha az iniyor),
        // bitince menzildeyse ejderhaya ok.
        const me = bot.entity.position;
        // Ok atmak için kapsülde pencere açılıyor: sadece ejderha uzaktayken (bizi
        // görüp ateş topu atmasın). Ejderhaya ok atmıyoruz (pencere açık kalırdı).
        const far = false; // sığınaktan ok atılamıyor (görüş yok)
        const c = far && bow(bot) && arrows(bot) ? crystals(bot).filter((x) => !caged(bot, x) && (crystalTries.get(x.id) || 0) < 6)
          .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] : null;
        if (c) {
          crystalTries.set(c.id, (crystalTries.get(c.id) || 0) + 1);
          await shoot(bot, c, 1.0, { keep: L.wall, windows });
          await reseal();
          await A.sleep(300);
          if (!bot.entities[c.id]) { crystalsBroken++; say(`  kristal patladı (${crystalsBroken}), ${crystals(bot).length} kaldı`); }
        } else await A.sleep(200);
      }
    }
  } finally {
    bot._noFill = null;
    bot.removeListener("entityDead", onDead);
    bot.removeListener("entityHurt", onHurt);
  }
  return { killed, bombs, ms: Date.now() - t0 };
}

// Ejderha ölünce fıskiyede çıkış portalı açılır: içine gir (jenerik, sonra Overworld).
async function enterExitPortal(bot, say = () => {}, maxMs = 90000) {
  const t0 = Date.now();
  const id = bot.registry.blocksByName.end_portal.id;
  bot._noFill = null;
  // Portala girince sunucu "oyunu kazandın" (jenerik) gönderir; jeneriği geçip Overworld'e dön.
  let won = false;
  const onState = (p) => {
    if (p && (p.reason === 4 || p.reason === "win_game")) {
      won = true;
      try { bot._client.write("client_command", { actionId: 0 }); } catch (e) { /* */ }
    }
  };
  bot._client.on("game_state_change", onState);
  try {
  while (!won && bot.game.dimension === "the_end" && Date.now() - t0 < maxMs) {
    const p = bot.findBlock({ matching: id, maxDistance: 24 });
    if (!p) { await A.sleep(1000); continue; }
    say(`Çıkış portalı: ${p.position}`);
    // Portal yere gömülü (bedrock çanağın içinde): üstüne yürüyüp düşeriz.
    const r = await H.highway(bot, p.position.offset(0, 1, 0), { maxMs: 30000, range: 0 });
    A.dbg("çıkış portalına:", r, H.cellOf(bot).toString());
    if (bot.game.dimension === "the_end") await A.goto(bot, new GoalNear(p.position.x, p.position.y, p.position.z, 0), 8000);
    for (let i = 0; i < 40 && !won && bot.game.dimension === "the_end"; i++) await A.sleep(100);
  }
  } finally {
    bot._client.removeListener("game_state_change", onState);
  }
  return won || bot.game.dimension !== "the_end";
}

module.exports = { enterExitPortal, killDragon, dragon, fountainTop, perched, beds };
