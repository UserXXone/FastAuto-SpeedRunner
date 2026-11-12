"use strict";

// Nether: blaze spawner'ı bul, çevresini kapalı odaya çevir, blaze'leri
// odanın zemininin altından kes, çubukları topla.

const {
  goals: { GoalNearXZ },
} = require("mineflayer-pathfinder");
const A = require("./actions");
const C = require("./combat");

const H = require("./highway");

const { placeFiller, isFiller, mineTunnel } = H;
const SCAFFOLD_WANT = 128; // köprüler + blaze odasını kapatmak (~50 blok) için

function findBlazeSpawner(bot) {
  const id = bot.registry.blocksByName.spawner.id;
  const me = bot.entity.position;
  return (
    bot
      .findBlocks({ matching: id, maxDistance: 160, count: 20 })
      // Fortress'teki spawner nether tuğlası platformun üstünde durur (bastion'daki öyle değil).
      .filter((p) => {
        const b = bot.blockAt(p.offset(0, -1, 0));
        return b && b.name.startsWith("nether_brick");
      })
      .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0] || null
  );
}

// (x,z)'ye doğru parça parça yürü; her parçadan sonra cond() doğruysa dur.
async function travelUntil(bot, x, z, range, maxMs, cond) {
  const flat = () => Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z);
  const t0 = Date.now();
  let stalls = 0;
  while (flat() > range && Date.now() - t0 < maxMs && stalls < 4) {
    if (cond && cond()) return true;
    const before = flat();
    await A.goto(bot, new GoalNearXZ(x, z, range), 20000);
    if (before - flat() < 2) stalls++;
    else stalls = 0;
  }
  return cond ? Boolean(cond()) : flat() <= range + 2;
}

// Yüklü chunk'larda spawner yoksa fortress'in çevresinde dolaşarak ara.
async function locateSpawner(bot, info, say) {
  let sp = findBlazeSpawner(bot);
  if (sp) return sp;
  const here = bot.entity.position;
  const [fx, fz] = info.fortress || [Math.round(here.x), Math.round(here.z)];
  const spots = [[fx, fz]];
  for (const r of [72, 128]) {
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      spots.push([fx + dx * r, fz + dz * r]);
    }
  }
  for (const [x, z] of spots) {
    say(`Blaze spawner aranıyor: (${x}, ${z}) yönüne gidiyorum`);
    await travelUntil(bot, x, z, 12, 150000, () => (sp = findBlazeSpawner(bot)));
    if (sp) return sp;
  }
  return null;
}

// Yanımıza blok al: yol bulucunun köprüleri ve blaze odasını kapatmak için.
// Tek tek toplamak yavaş; önce erişebildiğimiz netherrack'leri kır, sonra dökülenleri topla.
async function stockScaffold(bot, want = SCAFFOLD_WANT, toward = null) {
  await mineTunnel(bot, want, 90, toward);
  if (A.count(bot, isFiller) < Math.min(want, 24)) {
    // Tünel açacak yer bulunamadı: yakındaki bloklardan tek tek topla.
    await A.gatherNearest(bot, [...H.MINEABLE], isFiller, Math.min(want, 24), { maxDistance: 24 });
  }
  A.dbg("dolgu bloğu:", A.count(bot, isFiller));
  return A.count(bot, isFiller);
}

function rodDrops(bot, around, radius) {
  return Object.values(bot.entities).filter((e) => {
    if (e.name !== "item" || e.position.distanceTo(around) > radius) return false;
    try {
      const it = e.getDroppedItem();
      return it && it.name === "blaze_rod";
    } catch (err) {
      return false;
    }
  });
}

// ------------------------------------------------------------------ blaze odası

// Spawner'ın çevresindeki 5x5x3 boşluğu kapalı bir odaya çeviririz. Dışarıdaki
// blaze'ler bizi göremez (görmeyen blaze ateş etmez); içeride doğanlar kılıç
// menzilinde olur. Platformun duvarları ve çitleri zaten var; kapıyı, çitlerin
// üstünü ve tavanı kapatmak yetiyor (~50 blok).
const ROOM_R = 2; // iç boşluk: spawner'dan ±2
const ROOM_H = 3; // iç yükseklik

function roomShell(spawner) {
  const cells = [];
  for (let dx = -ROOM_R - 1; dx <= ROOM_R + 1; dx++) {
    for (let dz = -ROOM_R - 1; dz <= ROOM_R + 1; dz++) {
      const m = Math.max(Math.abs(dx), Math.abs(dz));
      if (m <= ROOM_R) {
        cells.push(spawner.offset(dx, -1, dz)); // zemin
        cells.push(spawner.offset(dx, ROOM_H, dz)); // tavan
      } else if (Math.abs(dx) !== Math.abs(dz)) {
        // Duvar halkası (köşeler gerekmez: köşeden içerisi görünmez).
        for (let dy = 0; dy < ROOM_H; dy++) cells.push(spawner.offset(dx, dy, dz));
      }
    }
  }
  return cells;
}

function inRoom(spawner, p) {
  return (
    Math.abs(Math.floor(p.x) - spawner.x) <= ROOM_R &&
    Math.abs(Math.floor(p.z) - spawner.z) <= ROOM_R &&
    p.y >= spawner.y - 0.5 && p.y < spawner.y + ROOM_H
  );
}

const blocksSight = (b) => Boolean(b && b.boundingBox === "block");

function roomGaps(bot, spawner) {
  // Spawner'ın altındaki sütun bizim saklanma yerimiz: orası açık kalır.
  return roomShell(spawner).filter(
    (c) => !(c.x === spawner.x && c.z === spawner.z && c.y < spawner.y) && !blocksSight(bot.blockAt(c)),
  );
}

// Odadaki açıklıkları kapat. Kalan açıklık sayısını döndürür.
async function sealRoom(bot, spawner) {
  if (bot.usingHeldItem) bot.deactivateItem();
  let gaps = roomGaps(bot, spawner).sort((a, b) => a.y - b.y);
  let stuck = 0;
  while (gaps.length && stuck < 2) {
    let placed = 0;
    for (const c of gaps) {
      if (!A.count(bot, isFiller)) return gaps.length;
      const hasRef = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([x, y, z]) => {
        const n = bot.blockAt(c.offset(x, y, z));
        return n && n.boundingBox === "block" && n.name !== "spawner";
      });
      if (!hasRef) continue;
      if (await placeFiller(bot, c)) placed++;
    }
    gaps = roomGaps(bot, spawner).sort((a, b) => a.y - b.y);
    if (!placed && gaps.length) {
      // Tavanın tutunacağı yer yok: duvarın üstüne bir destek bloğu koy.
      stuck++;
      const top = gaps.find((c) => c.y === spawner.y + ROOM_H);
      if (top) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const edge = spawner.offset(dx * (ROOM_R + 1), ROOM_H, dz * (ROOM_R + 1));
          if (blocksSight(bot.blockAt(edge.offset(0, -1, 0))) && (await placeFiller(bot, edge))) break;
        }
      }
    }
  }
  return gaps.length;
}

// ------------------------------------------------------------------ blaze avı

// Spawner'ın tam altındaki saklanma yeri: ayaklar zeminin alt katmanında, baş üst
// katmanında, tepemizde spawner. Hiçbir blaze bizi göremez (görmeyen ateş etmez);
// kılıç ise 3 blok menzille odanın her yerine yetişir.
function hideout(spawner) {
  return spawner.offset(0, -2, 0);
}

function atHideout(bot, spawner) {
  const c = H.cellOf(bot);
  const h = hideout(spawner);
  return c.x === h.x && c.z === h.z && c.y === h.y;
}

// Yerdeki çubukları odaya girmeden topla: zeminin bir kat altından çubuğun
// altına sürün, başımızın üstündeki zemin bloğunu kır (çubuk üstümüze düşer),
// bloğu geri koy. strike: yol boyunca menzile giren blaze'e vurmak için.
async function collectFromBelow(bot, spawner, strike) {
  const h = hideout(spawner);
  const level = spawner.y - 3; // ayak; baş zeminin alt katmanında, üstümüz kapalı
  const rods = () => A.count(bot, "blaze_rod");
  const digBlock = async (pos) => {
    const b = bot.blockAt(pos);
    if (!b || b.boundingBox !== "block" || b.name === "spawner") return;
    try {
      await A.withHand(bot, async () => {
        const { item } = A.fastestTool(bot, b);
        if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
        await bot.dig(b, true);
      });
    } catch (err) {
      A.dbg("kazılamadı:", pos.toString(), err.message);
    }
  };
  // Saklanma yerinden bir kat aşağı in (altımızdaki kendi koyduğumuz blok).
  if (H.cellOf(bot).y > level) {
    await digBlock(H.cellOf(bot).offset(0, -1, 0));
    for (let i = 0; i < 20 && H.cellOf(bot).y > level; i++) await A.sleep(50);
  }
  const tried = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await strike();
    const me = bot.entity.position;
    const drop = rodDrops(bot, spawner.offset(0.5, 0, 0.5), 6)
      .filter((d) => inRoom(spawner, d.position) && !tried.has(d.id))
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!drop) break;
    tried.add(drop.id);
    const cx = Math.floor(drop.position.x);
    const cz = Math.floor(drop.position.z);
    if (cx === spawner.x && cz === spawner.z) continue;
    const r = await H.highway(bot, { x: cx, y: level, z: cz }, { enclosed: true, maxMs: 15000, onTick: strike });
    A.dbg(`çubuk ${drop.position.x.toFixed(1)},${drop.position.y.toFixed(1)},${drop.position.z.toFixed(1)} altına: ${r} ${H.cellOf(bot)}`);
    if (r !== "arrived") continue;
    const before = rods();
    const lid = new (require("vec3").Vec3)(cx, spawner.y - 1, cz);
    await digBlock(lid);
    for (let i = 0; i < 30 && rods() === before && bot.entities[drop.id]; i++) {
      await strike();
      await A.sleep(50);
    }
    await placeFiller(bot, lid);
  }
  // Saklanma yerine dön.
  await H.highway(bot, { x: h.x, y: level, z: h.z }, { enclosed: true, maxMs: 20000 });
  await H.highway(bot, h, { enclosed: true, maxMs: 15000 });
  return rods();
}

// Saklanma yerine (geri) in.
async function enterHideout(bot, spawner) {
  const h = hideout(spawner);
  if (atHideout(bot, spawner)) return true;
  const c = H.cellOf(bot);
  if (c.y > h.y) return false; // odanın içindeyiz: buraya düşmemeliydik
  await H.highway(bot, { x: h.x, y: Math.min(c.y, h.y - 1), z: h.z }, { enclosed: true, maxMs: 30000 });
  await H.highway(bot, h, { enclosed: true, maxMs: 15000 });
  return atHideout(bot, spawner);
}

/**
 * Blaze çiftliği. Bot spawner'ın altındaki saklanma yerinde durur:
 *  1. Odanın açıklıklarını (kapı, duvar üstü, tavan) oradan kapatır.
 *  2. Kılıç menziline giren her blaze'e vurur (odanın içi tamamen menzilde).
 *  3. Yeterince çubuk yere düşünce ve içeride blaze kalmayınca odaya çıkıp toplar.
 * Blaze'ler bizi hiç görmediği için ateş etmez; can kaybı beklenmez.
 */
async function farmBlazes(bot, spawner, need, say, opts = {}) {
  const maxMs = opts.maxMs || 15 * 60e3;
  const rods = () => A.count(bot, "blaze_rod");
  const center = spawner.offset(0.5, 0, 0.5);
  const t0 = Date.now();
  let lastAttack = 0;
  let lastSeal = 0;
  let sealWait = 0;
  let lastLog = 0;
  let sealed = false;
  let kills = 0;
  let trips = 0;
  let lastKillAt = Date.now();
  let lastTrip = 0;
  const seen = new Set();
  const onGone = (e) => {
    if (seen.delete(e.id)) {
      kills++;
      lastKillAt = Date.now();
    }
  };
  bot.on("entityGone", onGone);
  // Menzildeki düşmana vur (önce blaze). Görüş hattı gerekmez: sunucu sadece mesafeye bakar.
  const strike = async () => {
    const target = C.hostilesNear(bot, 8)
      .filter((e) => e.name !== "ghast" && C.reachDistance(bot, e) <= 3.0)
      .sort((a, b) => (a.name === "blaze" ? 0 : 1) - (b.name === "blaze" ? 0 : 1))[0];
    if (target && Date.now() - lastAttack >= C.SWORD_COOLDOWN) {
      if (target.name === "blaze") seen.add(target.id);
      await A.withHand(bot, async () => {
        // Eldeki eşya değişince vuruş gücü sıfırlanır (hemen vurursak hasar 1/5):
        // kılıcı yeni aldıysak bir vuruş süresi bekle.
        const w = C.bestWeapon(bot);
        if (w && (!bot.heldItem || bot.heldItem.type !== w.type)) await bot.equip(w, "hand");
        else bot.attack(target);
      });
      lastAttack = Date.now();
    }
    return target;
  };
  try {
    while (rods() < need) {
      if (Date.now() - t0 > maxMs) throw new Error(`Blaze avı çok uzun sürdü (${rods()}/${need} çubuk)`);
      if (!atHideout(bot, spawner) && !(await enterHideout(bot, spawner))) {
        throw new Error("Spawner'ın altındaki yere girilemedi");
      }
      const hostiles = C.hostilesNear(bot, 16);
      const blazes = hostiles.filter((e) => e.name === "blaze");
      const inside = blazes.filter((b) => inRoom(spawner, b.position));
      for (const b of inside) seen.add(b.id);
      // Spawner'ın tepesine düşen çubuğa alttan ulaşılamaz: sayma, yoksa boş tur atılır.
      const floorRods = rodDrops(bot, center, 6).filter(
        (d) => inRoom(spawner, d.position) && !(Math.floor(d.position.x) === spawner.x && Math.floor(d.position.z) === spawner.z),
      );

      // Odayı kapat / tamir et. Bir yaratığın durduğu hücreye blok koyulamaz; o
      // zaman seyrek dene: her deneme kılıcı elden bırakır, vuruşlar zayıflar.
      if (Date.now() - lastSeal > sealWait) {
        const before = roomGaps(bot, spawner).length;
        if (before) {
          const left = await sealRoom(bot, spawner);
          if (!left) say(`  blaze odası kapatıldı (${before} blok)`);
          sealed = left === 0;
          sealWait = left ? (left < before ? 1500 : Math.min(8000, sealWait + 2000)) : 5000;
        } else {
          sealed = true;
          sealWait = 5000;
        }
        lastSeal = Date.now();
      }

      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now();
        A.dbg(
          `çiftlik: can ${bot.health.toFixed(0)} açlık ${bot.food} çubuk ${rods()} (+${floorRods.length} yerde) öldürülen ${kills}`,
          `blaze ${blazes.length} (içeride ${inside.length}) oda ${sealed ? "kapalı" : "AÇIK"} dolgu ${A.count(bot, isFiller)}`,
          inside.slice(0, 4).map((b) => `[${b.position.x.toFixed(1)},${b.position.y.toFixed(1)},${b.position.z.toFixed(1)} menzil ${C.reachDistance(bot, b).toFixed(1)}]`).join(" "),
          roomGaps(bot, spawner).slice(0, 6).map((c) => `${c}:${(bot.blockAt(c) || {}).name}`).join(" "),
        );
      }

      const target = await strike();

      // Toplama zamanı mı? Yeterli çubuk yerde ve içerisi boşsa; ya da uzun süredir
      // içeride blaze yok ama yerde çubuk bekliyorsa (5 dakikada kaybolur).
      const enough = rods() + floorRods.length >= need;
      const idle = floorRods.length > 0 && Date.now() - lastKillAt > 45000;
      void enough;
      void idle;
      // Yerde çubuk var ve içeride vuracak blaze kalmadıysa hemen al (bekletince
      // sonraki dalga gelir; çubuklar 5 dakikada kaybolur).
      if (floorRods.length && !inside.length && Date.now() - lastTrip > 5000) {
        trips++;
        const got = await collectFromBelow(bot, spawner, strike);
        say(`  çubuklar alttan toplandı: ${got}/${need}`);
        lastTrip = Date.now();
        continue;
      }
      if (!target && bot.food < 18 && C.bestFood(bot)) await C.eat(bot);
      await A.sleep(50);
    }
  } finally {
    bot.removeListener("entityGone", onGone);
    C.stopMoving(bot);
    if (bot.usingHeldItem) bot.deactivateItem();
  }
  return { rods: rods(), kills, trips, ms: Date.now() - t0 };
}

module.exports = {
  inRoom,
  hideout,
  atHideout,
  findBlazeSpawner,
  locateSpawner,
  travelUntil,
  stockScaffold,
  farmBlazes,
};
