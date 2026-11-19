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
const BED_RAISE = Number(process.env.BED_RAISE || 2);
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
  const onBar = (b) => { if (b && typeof b.health === "number") bot._dragonHp = b.health; };
  bot.on("bossBarUpdated", onBar);
  bot.on("bossBarCreated", onBar);
  bot.on("entityDead", onDead);
  try {
    let stand = await reachCenter(bot, opts.dist || 9, say);
    // Yolda atılan ateş topunun bulutu tam duracağımız yere düşmüş olabilir (vardığımız
    // an hasar alıp öldük): bulutsuz bir yön seç (fıskiyenin 4 yanından biri).
    const cloudAt = (p, r) => Object.values(bot.entities).some((e) => e.name === "area_effect_cloud" && Math.hypot(e.position.x - p.x - 0.5, e.position.z - p.z - 0.5) < r);
    for (let k = 0; k < 4 && cloudAt(stand, 8); k++) {
      const dist = opts.dist || 9;
      const alts = [[dist, 0], [0, dist], [-dist, 0], [0, -dist]]
        .map(([x, z]) => { const gy = groundAt(bot, x, z); return gy == null ? null : new Vec3(x, gy + 1, z); })
        .filter((p) => p && !cloudAt(p, 8))
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
      if (!alts.length) { await A.sleep(1000); continue; }
      A.dbg("duruş yerinde bulut: başka yana geçiyorum", alts[0].toString());
      await A.goto(bot, new GoalNear(alts[0].x, alts[0].y, alts[0].z, 0), 20000);
      stand = H.cellOf(bot);
    }
    const top = fountainTop(bot) || 62;
    const L = layout(stand);
    say(`Duruş ${stand}, fıskiye tepesi y=${top}, yatak ${L.bedFoot}`);
    await openTube(bot, stand, L);
    // 2 blok yüksel: nefes bulutu yerde ve 0,5 blok yüksek; üstünde kalınca dokunmaz
    // (kaçmaya çalışırken defalarca öldük). Duvar da 4 blok: patlama bize gelmesin.
    const [wx, wz] = L.dir;
    L.wall = [0, 1, 2, 3].map((dy) => stand.offset(wx, dy, wz));
    // Direk yok: kapsül yerde. Kapalıyken ejderha bizi görmüyor, ne ateş topu atıyor ne
    // nefes hücumuna geçiyor. Direğe çıkarken (~2 sn açıkta) her seferinde vurulduk.
    const perch = H.cellOf(bot);
    A.dbg("ejderha duruşu:", perch.toString(), "yükseklik", perch.y - stand.y);
    // Kapsül: zemin, dört yan + tavan. Ejderha görmediği oyuncuya ateş topu
    // atmıyor ve nefes hücumuna geçmiyor (hedef seçerken görüş hattına bakıyor). Ateş
    // topları açıktayken bizi defalarca öldürdü. Yatağı kapsülün dışına, desteğin üstüne koyup
    // tıklarız (sunucu mesafeye bakar, görüşe değil).
    const shell = [perch.offset(0, -1, 0)];
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) shell.push(perch.offset(sx, 0, sz));
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) shell.push(perch.offset(sx, 1, sz));
    // Tavan yan bloklara çapraz kalıyor, tutunamaz: önce yanına bir köprü bloğu.
    shell.push(perch.offset(-wx, 2, -wz), perch.offset(0, 2, 0));
    bot._noFill = [perch, perch.offset(0, 1, 0)];
    const windows = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([sx, sz]) => perch.offset(sx, 1, sz)).filter((w) => !L.wall.some((k) => k.equals(w)));
    const reseal = async () => {
      if (shell.some((c) => (bot.blockAt(c) || {}).boundingBox !== "block")) await H.placeMany(bot, shell, 4);
    };
    await reseal();
    await H.placeMany(bot, L.wall, 4);
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
      const cloud = Object.values(bot.entities).find((e) => e.name === "area_effect_cloud" && bot.entity.position.y - e.position.y < 1.5 && e.position.distanceTo(bot.entity.position) < 6);
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
        if (!under.every(solid) || fiery || (spot && spot.boundingBox === "block")) await clearBedSpot(bot, L);
        let done = await headBomb(bot, d, [...shell, ...L.wall, perch, perch.offset(0, 1, 0)]);
        if (done === null) done = await bedBomb(bot, L);
        if (done) {
          bombs++;
          await A.sleep(150);
          const hx = d.position.x - Math.sin(d.yaw) * 6.5, hz = d.position.z - Math.cos(d.yaw) * 6.5;
          say(`  yatak patladı (${bombs}), ejderha ${d.position.y.toFixed(0)}, can ${bot._dragonHp != null ? Math.round(bot._dragonHp * 200) : "?"}/200, kafa~(${hx.toFixed(1)}, ${hz.toFixed(1)}) yatak ${L.bedFoot.x},${L.bedFoot.z}`);
        }
        await A.sleep(120);
      } else {
        if (bot.food < 18 && C.bestFood(bot)) await C.eat(bot);
        // Havada: önce kafessiz kristaller (iyileştiriyorlar, dururken ejderha az iniyor),
        // bitince menzildeyse ejderhaya ok.
        const me = bot.entity.position;
        // Ok atmak için kapsülde pencere açılıyor: sadece ejderha uzaktayken (bizi
        // görüp ateş topu atmasın). Ejderhaya ok atmıyoruz (pencere açık kalırdı).
        const far = true; // kristaller iyileştiriyor (167→200 ölçüldü): her fırsatta vur
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
  }
  return { killed, bombs, ms: Date.now() - t0 };
}

module.exports = { killDragon, dragon, fountainTop, perched, beds };
