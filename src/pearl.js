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
const { goals: { GoalNear, GoalNearXZ, GoalFollow } } = require("mineflayer-pathfinder");
const A = require("./actions");
const C = require("./combat");
const H = require("./highway");

const PEARLS_NEEDED = 12; // 12 göz
const ENDERMAN_EYE = 2.55;
// Sunucu saldırıda göz-hitbox mesafesine bakıyor; 3,0 çok temkinli (deneme: env PEARL_REACH).
const REACH = Number(process.env.PEARL_REACH || 4.2); // 4,2 denendi: sunucu kabul ediyor, öldürme hızı ~3 kat

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

// Yüklü chunk'larda warped forest'ın İÇİ: üstü açık nylium'un en yoğun olduğu yer.
// İlk bulunan nylium çoğu zaman ormanın kenarıdır (ölçüldü: kenarda 1 dakikada 0
// enderman, 80 blok içeride 15-18). minOpen: bu kadar açık nylium yoksa null.
function openNylium(bot, maxDistance) {
  const id = bot.registry.blocksByName.warped_nylium.id;
  return bot.findBlocks({ matching: id, maxDistance, count: 3000 }).filter((p) => {
    // Endermanın sığacağı açıklık: üstünde 3 blok boşluk.
    return [1, 2, 3].every((d) => {
      const x = bot.blockAt(p.offset(0, d, 0));
      return x && x.boundingBox === "empty" && x.name !== "lava";
    });
  });
}

function findWarpedGround(bot, maxDistance = 96, minOpen = 0) {
  const spots = openNylium(bot, maxDistance);
  if (spots.length < Math.max(1, minOpen)) return null;
  // Her aday için 16 blok içindeki açık nylium sayısı; en yoğun olana yakın ve yerden çok yüksek olmayanı seç.
  const me = bot.entity.position;
  let best = null;
  let bestScore = -Infinity;
  const sample = spots.length > 400 ? spots.filter((_, i) => i % Math.ceil(spots.length / 400) === 0) : spots;
  for (const p of sample) {
    let n = 0;
    for (const q of spots) if (Math.abs(q.x - p.x) <= 16 && Math.abs(q.z - p.z) <= 16 && Math.abs(q.y - p.y) <= 8) n++;
    const score = n - p.distanceTo(me) * 0.5;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best ? best.offset(0, 1, 0) : null;
}

// Etrafımız kapalı mı? Değilse kapat (kapsül: ayak ve baş hizasında dört yan + tavan + zemin).
// Komşu bir bloğa tutunarak koy; tutunacak yer yoksa vazgeç.
async function placeNoRecurse(bot, p) {
  return H.placeFiller(bot, p, 99);
}

// Çatı (2 blok yüksek barınak): botun 3x3 çevresinin üstü kapalı, yanlar açık.
// Enderman 2,9 blok boyunda: çatının altına giremez, en yakın 2 blok öteden
// vuramaz (yetişme ~1,4). Biz 4,2 menzille vururuz; yanlar açık olduğu için
// baktığımız enderman bizi görür, kızar ve çatının kenarına gelir.
const MODE = process.env.PEARL_MODE || "direk";
const HUT = MODE === "hut" || MODE === "direk";
const HUT_RAISE = Number(process.env.HUT_RAISE || 2);
async function buildHut(bot) {
  for (let i = 0; i < 20 && !bot.entity.onGround; i++) await A.sleep(50);
  let c = H.cellOf(bot);
  const solidAt0 = (p) => (bot.blockAt(p) || {}).boundingBox === "block";
  const built = [[-1, -1], [1, 1], [0, 0]].every(([dx, dz]) => solidAt0(c.offset(dx, 2, dz)));
  if (!built) {
    // 2 blok yüksel: zemin kenarı aşağıdaki endermanları gizliyordu (ölçüldü: engellerin
    // çoğu 2-3 blok ötedeki nylium). Platformun altı 2 blok: enderman oraya da giremez.
    for (let i = 0; i < HUT_RAISE; i++) if (!(await H.pillarUp(bot))) break;
    for (let i = 0; i < 20 && !bot.entity.onGround; i++) await A.sleep(50);
    c = H.cellOf(bot);
  }
  const mid = c.offset(0.5, 0, 0.5);
  for (let i = 0; i < 12 && Math.hypot(bot.entity.position.x - mid.x, bot.entity.position.z - mid.z) > 0.12; i++) {
    await bot.lookAt(new Vec3(mid.x, bot.entity.position.y + 1.62, mid.z), true);
    bot.setControlState("forward", true);
    await A.sleep(50);
  }
  bot.setControlState("forward", false);
  const ring = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) ring.push([dx, dz]);
  // Zemin: 3x3 dolu (altı boş kenar hücresi 3 blok yüksek olur, enderman sığar).
  const floor = ring.map(([dx, dz]) => c.offset(dx, -1, dz));
  const solidAt = (p) => (bot.blockAt(p) || {}).boundingBox === "block";
  if (floor.every(solidAt) && ring.every(([dx, dz]) => solidAt(c.offset(dx, 2, dz)))) return true;
  // Çatıya tutunmak için geçici bir direk: yan hücreye iki blok.
  const post = [c.offset(1, 0, 0), c.offset(1, 1, 0)];
  const roof = ring.map(([dx, dz]) => c.offset(dx, 2, dz));
  roof.sort((a, b) => (a.equals(c.offset(1, 2, 0)) ? -1 : 0) - (b.equals(c.offset(1, 2, 0)) ? -1 : 0));
  const postWasAir = post.map((p) => (bot.blockAt(p) || {}).boundingBox !== "block");
  await H.placeMany(bot, [...floor, ...post, ...roof], 4);
  // Direği kaldır (yan açık kalsın: görüş hattı).
  for (let i = post.length - 1; i >= 0; i--) {
    if (!postWasAir[i]) continue;
    const b = bot.blockAt(post[i]);
    if (b && b.boundingBox === "block") {
      try {
        await A.withHand(bot, async () => {
          const { item } = A.fastestTool(bot, b);
          if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
          await bot.dig(b, true);
        });
      } catch (err) { /* kalsın */ }
    }
  }
  const open = roof.filter((p) => (bot.blockAt(p) || {}).boundingBox !== "block").length;
  if (open) A.dbg("çatı tamamlanmadı:", open, "açık", c.toString());
  return open === 0;
}

// Çatı modunda kızdırma: görüş hattı açıksa sadece bak.
async function lookLure(bot, target) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const to = target.position.offset(0, ENDERMAN_EYE, 0);
  const dir = to.minus(eye).normalize();
  const hit = bot.world.raycast(eye, dir, eye.distanceTo(to), (b) => b && b.boundingBox === "block");
  if (hit) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < 1200 && bot.entities[target.id]) {
    await bot.lookAt(target.position.offset(0, ENDERMAN_EYE, 0), true);
    await A.sleep(50);
  }
  return true;
}

function canSee(bot, target) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const to = target.position.offset(0, ENDERMAN_EYE, 0);
  if (eye.distanceTo(to) > 60) return false;
  const dir = to.minus(eye).normalize();
  return !bot.world.raycast(eye, dir, eye.distanceTo(to), (b) => b && b.boundingBox === "block");
}

// Direk: 1x1, 3 blok yüksek sütunun tepesi. Enderman 2,9 boyunda: dibinde dururken
// vuruş kutusu ayağımıza (3 blok) yetişmez; biz 4,2 menzille vururuz. Çatı yok,
// yan yok: her yön açık, görüş en iyi (çatı ve zemin kenarı görüşü kapatıyordu).
const PILLAR = 3;
function onPillar(bot) {
  const c = H.cellOf(bot);
  for (let i = 1; i <= PILLAR; i++) if ((bot.blockAt(c.offset(0, -i, 0)) || {}).boundingBox !== "block") return false;
  // Yanlarda sağlam blok olmamalı (enderman oraya çıkıp yanımıza gelir).
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => (bot.blockAt(c.offset(dx, -1, dz)) || {}).boundingBox !== "block");
}
async function buildPillar(bot) {
  if (bot._pillarTop && H.cellOf(bot).equals(bot._pillarTop)) return true;
  for (let i = 0; i < 20 && !bot.entity.onGround; i++) await A.sleep(50);
  for (let i = 0; i < PILLAR + 2; i++) {
    if (!(await H.pillarUp(bot))) break;
    if (i >= PILLAR - 1 && onPillar(bot)) break;
  }
  const ok = onPillar(bot);
  bot._pillarTop = ok ? H.cellOf(bot) : null;
  if (!ok) {
    const c = H.cellOf(bot);
    A.dbg("direk olmadı:", c.toString(), "alt:", [1, 2, 3].map((i) => (bot.blockAt(c.offset(0, -i, 0)) || {}).name).join(","),
      "yan:", [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => (bot.blockAt(c.offset(dx, -1, dz)) || {}).name).join(","));
  }
  return ok;
}
// Direkten in (altımızı kazarak): yere düşen pearl'leri almak için.
async function leavePillar(bot) {
  bot._pillarTop = null;
  for (let i = 0; i < PILLAR + 1; i++) {
    const below = bot.blockAt(H.cellOf(bot).offset(0, -1, 0));
    if (!below || below.boundingBox !== "block" || !H.MINEABLE.has(below.name)) break;
    // Altında bizim koyduğumuz blok değil, doğal zemin varsa dur.
    const under = bot.blockAt(below.position.offset(0, -1, 0));
    if (under && under.boundingBox === "block" && i >= PILLAR - 1) break;
    try {
      await A.withHand(bot, async () => {
        const { item } = A.fastestTool(bot, below);
        if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
        await bot.dig(below, true);
      });
    } catch (err) { break; }
    for (let k = 0; k < 20 && !bot.entity.onGround; k++) await A.sleep(50);
    await A.sleep(100);
  }
}
const shelter = (bot) => (MODE === "direk" ? buildPillar(bot) : HUT ? buildHut(bot) : sealCapsule(bot));

async function sealCapsule(bot) {
  // Bloğun ortasında dur: kenardaysak gövdemiz komşu hücreye taşar, sunucu oraya
  // blok koymayı reddeder ve kapsül açık kalır (enderman vuruyor: can 0,2'ye indi).
  for (let i = 0; i < 20 && !bot.entity.onGround; i++) await A.sleep(50);
  const c = H.cellOf(bot);
  const mid = c.offset(0.5, 0, 0.5);
  for (let i = 0; i < 12 && Math.hypot(bot.entity.position.x - mid.x, bot.entity.position.z - mid.z) > 0.12; i++) {
    await bot.lookAt(new Vec3(mid.x, bot.entity.position.y + 1.62, mid.z), true);
    bot.setControlState("forward", true);
    await A.sleep(50);
  }
  bot.setControlState("forward", false);
  await A.sleep(100);
  // Sıra önemli: zemin, yanlar, en son tavan (tavan ancak yan bloklara tutunur).
  const shell = [c.offset(0, -1, 0)];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) shell.push(c.offset(dx, 0, dz));
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) shell.push(c.offset(dx, 1, dz));
  // Tavanın yüzeyden komşusu yoksa (açık havada) tutunamaz: önce yanına bir blok.
  const roof = c.offset(0, 2, 0);
  const roofHasRef = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
    const b = bot.blockAt(roof.offset(dx, 0, dz));
    return b && b.boundingBox === "block";
  }) || ((bot.blockAt(roof.offset(0, 1, 0)) || {}).boundingBox === "block");
  if (!roofHasRef) shell.push(c.offset(1, 2, 0));
  shell.push(roof);
  const own = [c, c.offset(0, 1, 0)];
  let open = 0;
  for (let pass = 0; pass < 2; pass++) {
    open = 0;
    for (const p of shell) {
      const b = bot.blockAt(p);
      if (!b || b.boundingBox === "block") continue;
      // placeFiller tutunamazsa alttaki hücreyi doldurmaya kalkar: kendi hücremize değil.
      const below = p.offset(0, -1, 0);
      const ok = own.some((o) => o.equals(below)) ? await placeNoRecurse(bot, p) : await H.placeFiller(bot, p);
      if (!ok) open++;
    }
    if (!open) break;
  }
  if (open) A.dbg("kapsül kapanmadı:", open, "açık", c.toString(), shell.filter((p) => !(bot.blockAt(p) || {}).boundingBox || bot.blockAt(p).boundingBox !== "block").map((p) => `${p}:${(bot.blockAt(p) || {}).name}`).join(" "));
  return open === 0;
}

// Pencereyi aç, endermanın gözüne bak, pencereyi kapat.
// Gözümüzden endermanın gözüne giden ışın: önündeki ilk sağlam blok (kendi
// kapsülümüzün duvarı olmalı) dışında açık mı? Açıksa o duvar bloğu "pencere".
// Enderman sadece onu gerçekten görebiliyorsak kızar (sunucu görüş hattına bakar).
function windowFor(bot, target) {
  const c = H.cellOf(bot);
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const to = target.position.offset(0, ENDERMAN_EYE, 0);
  const dist = eye.distanceTo(to);
  if (dist > 60) return null;
  const dir = to.minus(eye).normalize();
  const shell = [c.offset(0, 2, 0)];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) shell.push(c.offset(dx, 1, dz));
  const solid = (b) => b && b.boundingBox === "block";
  const first = bot.world.raycast(eye, dir, dist, solid);
  if (!first) return null; // kapsül açık? (olmamalı)
  const win = shell.find((p) => p.equals(first.position));
  if (!win) return null;
  const past = bot.world.raycast(eye, dir, dist, (b) => solid(b) && !b.position.equals(win));
  return past ? null : win;
}

async function lure(bot, target) {
  const win = windowFor(bot, target);
  if (!win) return false;
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
      return false;
    }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 1200 && bot.entities[target.id]) {
    await bot.lookAt(target.position.offset(0, ENDERMAN_EYE, 0), true);
    await A.sleep(50);
  }
  // Pencere kapanmazsa enderman görüş hattından vurur: kapanana kadar dene.
  for (let i = 0; i < 8 && !(await H.placeFiller(bot, win)); i++) await A.sleep(150);
  if (!((bot.blockAt(win) || {}).boundingBox === "block")) A.dbg("pencere kapanmadı!", win.toString());
  return true;
}

/**
 * need kadar ender pearl topla. Bot kapsülün içinde kalır.
 * Dönen: { pearls, kills, ms }
 */
async function huntEndermen(bot, need, say, opts = {}) {
  const maxMs = opts.maxMs || 20 * 60e3;
  const t0 = Date.now();
  let lastAttack = 0;
  let lastLure = 0;
  let lastLog = 0;
  let lastCount = pearls(bot);
  let kills = 0;
  const hit = new Set();
  const lured = new Map(); // id -> kızdırma zamanı
  let lastSuccess = Date.now();
  let lastStock = 0;
  let lastHp = bot.health;
  const tries = new Map(); // id -> kaç kez kızdırıldı
  // Aynı anda en çok 3 kızgın enderman: hepsi kapsülün dibine gelip sırayla kesilir.
  const angryCount = () => [...lured.entries()].filter(([id, t]) => bot.entities[id] && Date.now() - t < 30000).length;
  const onGone = (e) => {
    if (hit.delete(e.id)) kills++;
  };
  bot.on("entityGone", onGone);
  try {
    await shelter(bot);
    while (pearls(bot) < need) {
      if (Date.now() - t0 > maxMs) throw new Error(`Enderman avı çok uzun sürdü (${pearls(bot)}/${need} pearl)`);
      if (bot.inLavaEscape) {
        await A.sleep(100);
        continue;
      }
      // Blok azaldı: kapsülün altından aşağı doğru kazarak topla (nylium/netherrack).
      if (A.count(bot, H.isFiller) < 16 && !endermen(bot, 5).length && Date.now() - lastStock > 30000) {
        lastStock = Date.now();
        const before = A.count(bot, H.isFiller);
        await H.mineTunnel(bot, 64, 40);
        A.dbg(`enderman avı: blok azaldı, toplandı ${before} → ${A.count(bot, H.isFiller)}`);
        await shelter(bot);
        continue;
      }
      if (pearls(bot) !== lastCount) {
        lastCount = pearls(bot);
        say(`  ender pearl ${lastCount}/${need}`);
      }
      const near = endermen(bot, 64);
      // Menzildeki enderman ya da başka düşman (piglin vb.: av sırasında koruma kapalı).
      const inReach = near.find((e) => C.reachDistance(bot, e) <= REACH) || C.hostilesNear(bot, 6).find((e) => C.reachDistance(bot, e) <= 3.0);
      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now();
        A.dbg(
          `enderman avı: can ${bot.health.toFixed(0)} pearl ${pearls(bot)}/${need} öldürülen ${kills} görünen ${near.length}`,
          near[0] ? `en yakın ${near[0].position.distanceTo(bot.entity.position).toFixed(1)}` : "",
          "engel:", (() => { const eye = bot.entity.position.offset(0, 1.62, 0); const m = {}; for (const e of near.slice(0, 15)) { const to = e.position.offset(0, ENDERMAN_EYE, 0); const h = bot.world.raycast(eye, to.minus(eye).normalize(), eye.distanceTo(to), (b) => b && b.boundingBox === "block"); const k = h ? `${h.name}@${h.position.distanceTo(eye).toFixed(0)}` : "AÇIK"; m[k] = (m[k] || 0) + 1; } return JSON.stringify(m); })(),
          "kızgınlar(menzil):", [...lured.keys()].filter((id) => bot.entities[id]).map((id) => C.reachDistance(bot, bot.entities[id]).toFixed(1)).join(" "),
        );
      }
      if (inReach) {
        if (Date.now() - lastAttack >= C.SWORD_COOLDOWN) {
          hit.add(inReach.id);
          await A.withHand(bot, async () => {
            const w = C.bestWeapon(bot);
            if (w && (!bot.heldItem || bot.heldItem.type !== w.type)) await bot.equip(w, "hand");
            else {
          // İzleyen/yayın için: vurduğumuz yere bak (sunucu için gerekmez).
          await bot.lookAt(inReach.position.offset(0, (inReach.height || 1) * 0.6, 0), true).catch(() => {});
          bot.attack(inReach);
        }
          });
          lastAttack = Date.now();
        }
      } else {
        // Yerde pearl varsa ve yanımızda kızgın enderman yoksa kapsülü oraya yürüt.
        const drop = pearlDrops(bot, 12)[0];
        if (drop && drop.position.distanceTo(bot.entity.position) > 1.4 && angryCount() === 0 && bot.health >= 12 && !near.some((e) => e.position.distanceTo(bot.entity.position) < 8)) {
          const p = drop.position;
          const cell = new Vec3(Math.floor(p.x), Math.floor(p.y + 0.3), Math.floor(p.z));
          if (MODE === "direk") await leavePillar(bot);
          // Warped forest'ta düşman yok (enderman bakmazsan dokunmaz): açıktan yürü, blok harcama.
          const r = await A.goto(bot, new GoalNear(cell.x, cell.y, cell.z, 0.5), 15000);
          A.dbg("pearl'e yürüündü:", r);
          await shelter(bot);
        } else if (near.length && bot.health >= 12 && Date.now() - lastLure > 2000 && angryCount() < 3 && Date.now() - lastSuccess <= 30000) {
          // Kızdıracak enderman: bize yakın ve aşağı yukarı aynı yükseklikte olan.
          // Kızdıracak enderman: kapsülün bir duvar bloğunu açınca görülebilen.
          // İki kez kızdırılıp gelmeyen (yolu yok) endermanı bırak.
          // Kızgın enderman 16 bloktan uzaktaysa yanımıza ışınlanır; yakındakiler yürümeye
          // çalışıp takılıyor (ölçüldü: 10-15 blokta kızgın bekliyorlar). Uzaktakini seç.
          const far = near.filter((e) => e.position.distanceTo(bot.entity.position) >= 17).concat(near.filter((e) => e.position.distanceTo(bot.entity.position) < 17));
          const target = far.find((e) => e.position.distanceTo(bot.entity.position) >= 3 && (tries.get(e.id) || 0) < 2 && !(Date.now() - (lured.get(e.id) || 0) < 20000) && (HUT ? canSee(bot, e) : windowFor(bot, e)));
          if (target) tries.set(target.id, (tries.get(target.id) || 0) + 1);
          if (target && !(await shelter(bot))) {
            // Kapsül kapanmıyor: bir yana kay, sonra tekrar dene.
            const c = H.cellOf(bot);
            await A.goto(bot, new GoalNearXZ(c.x + (Math.random() < 0.5 ? 2 : -2), c.z + (Math.random() < 0.5 ? 2 : -2), 0), 8000);
            await shelter(bot);
            lastLure = Date.now() - 4000;
          } else if (target && (await (HUT ? lookLure(bot, target) : lure(bot, target)))) {
            lured.set(target.id, Date.now());
            lastSuccess = Date.now();
            A.dbg("enderman kızdırıldı:", target.position.distanceTo(bot.entity.position).toFixed(1), "blok");
            lastLure = Date.now();
          } else lastLure = Date.now() - 4000; // görülen yok: 2 sn sonra tekrar bak
        } else if ((!near.length && Date.now() - lastLure > 30000) || Date.now() - lastSuccess > 30000) {
          lastSuccess = Date.now();
          // Görünürde enderman yok: biraz yer değiştir.
          lastLure = Date.now();
          // Endermanların toplandığı yere (görünenlerin ortası) yürü; yoksa 24 blok rastgele.
          const c = H.cellOf(bot);
          // Görülebilecek bir enderman bulana kadar en yakın (denenmemiş) endermana doğru yürü.
          // En çok (denenmemiş) endermanı görebileceğimiz açık nylium noktasına git.
          const pool = endermen(bot, 80).filter((e) => (tries.get(e.id) || 0) < 2);
          const spots = openNylium(bot, 40).filter((p) => p.distanceTo(c) > 6);
          let best = null;
          let bestN = -1;
          for (const sp of spots.filter((_, i) => i % Math.max(1, Math.ceil(spots.length / 60)) === 0)) {
            const eye = sp.offset(0.5, 2.62, 0.5);
            let n = 0;
            for (const e of pool) {
              const to = e.position.offset(0, ENDERMAN_EYE, 0);
              const d = eye.distanceTo(to);
              if (d < 6 || d > 48) continue;
              if (!bot.world.raycast(eye, to.minus(eye).normalize(), d, (b) => b && b.boundingBox === "block")) n++;
            }
            const score = n - sp.distanceTo(c) / 20;
            if (score > bestN) { bestN = score; best = sp; }
          }
          const gx = best ? best.x : c.x + [24, 0, -24, 0][Math.floor(Math.random() * 4)];
          const gz = best ? best.z : c.z + [0, 24, 0, -24][Math.floor(Math.random() * 4)];
          if (MODE === "direk") await leavePillar(bot);
          A.dbg("enderman avı: yer değiştiriyorum", gx, gz, `(${pool.length} enderman, oradan görünen ~${bestN.toFixed(1)})`);
          // Direk modunda: en yakın endermana, onu görebildiğimiz ~12 bloğa kadar sokul.
          const prey = MODE === "direk" ? pool.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] : null;
          if (prey) A.dbg("enderman avı: sokuluyorum", prey.position.distanceTo(bot.entity.position).toFixed(1));
          bot.pathfinder.setGoal(prey ? new GoalFollow(prey, 8) : best ? new GoalNear(best.x, best.y + 1, best.z, 1) : new GoalNearXZ(gx, gz, 3), Boolean(prey));
          const tw = Date.now();
          while (Date.now() - tw < 25000 && bot.pathfinder.isMoving()) {
            if (endermen(bot, 40).some((e) => (tries.get(e.id) || 0) < 2 && e.position.distanceTo(bot.entity.position) > 4 && e.position.distanceTo(bot.entity.position) < 16 && canSee(bot, e))) break;
            await A.sleep(200);
          }
          bot.pathfinder.setGoal(null);
          bot.clearControlStates();
          await shelter(bot);
        }
      }
      if (!inReach && (bot.food < 18 || (bot.health < 14 && bot.food < 20)) && C.bestFood(bot)) await C.eat(bot);
      // Vurulduysak kapsülde delik var: kapat.
      if (bot.health < lastHp) await shelter(bot);
      lastHp = bot.health;
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

module.exports = { PEARLS_NEEDED, findWarpedGround, openNylium, sealCapsule, huntEndermen, craftEyes, pearls };
