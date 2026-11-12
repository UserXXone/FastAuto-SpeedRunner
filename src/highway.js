"use strict";

// Nether'da güvenli yol ("otoyol"): hedefe doğru adım adım ilerler; her adımda
// önündeki iki bloğu kazar, basacağı yerde blok yoksa koyar, yanında lav varsa
// önce onu kapatır. Yol bulucudan yavaş ama ne uçurumdan düşer ne lava girer:
// basmadan önce zemini kendisi garanti eder.

const { Vec3 } = require("vec3");
const A = require("./actions");
const C = require("./combat");

const FILLERS = ["netherrack", "cobblestone", "nether_bricks", "dirt", "cobbled_deepslate", "blackstone", "basalt", "soul_soil", "soul_sand"];
// Kazınca dolgu bloğu veren Nether blokları (nylium kırılınca netherrack düşer).
const MINEABLE = new Set(["netherrack", "blackstone", "basalt", "soul_soil", "soul_sand", "crimson_nylium", "warped_nylium"]);
const NEIGHBORS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const UNBREAKABLE = new Set(["bedrock", "spawner", "chest", "obsidian", "crying_obsidian", "nether_portal", "end_portal_frame"]);

const isFiller = (i) => FILLERS.includes(i.name);
const isSolid = (b) => Boolean(b && b.boundingBox === "block");
const isLava = (b) => Boolean(b && b.name === "lava");
// Su da kapatılır: tünel su dolarsa bot boğuluyor (yeraltı gölleri).
const isLiquid = (b) => Boolean(b && (b.name === "lava" || b.name === "water" || b.name === "bubble_column"));
const isOpen = (b) => Boolean(b && b.boundingBox === "empty" && !isLiquid(b) && b.name !== "fire" && b.name !== "soul_fire");

// Yürümeden, olduğun yerden bir hücreye dolgu bloğu koy. Komşu sağlam blok
// yoksa önce altındaki hücreyi doldurmayı dener.
async function placeFiller(bot, cell, depth = 0) {
  const spot = bot.blockAt(cell);
  if (!spot) return false;
  if (isSolid(spot)) return true;
  // İçine blok koyulamayan şeyler (portal, çit kapısı vb.).
  if (!isOpen(spot) && !isLiquid(spot) && spot.name !== "fire" && spot.name !== "soul_fire") return false;
  if (spot.name === "nether_portal") return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let refused = 0;
    for (const d of NEIGHBORS) {
      const ref = bot.blockAt(cell.offset(d[0], d[1], d[2]));
      if (!isSolid(ref) || ref.name === "spawner" || ref.name === "chest") continue;
      try {
        await A.withHand(bot, async () => {
          const item = bot.inventory.items().find(isFiller);
          if (!item) throw new Error("dolgu bloğu kalmadı");
          if (!bot.heldItem || bot.heldItem.type !== item.type) await bot.equip(item, "hand");
          await bot.placeBlock(ref, new Vec3(-d[0], -d[1], -d[2]));
        });
        if (isSolid(bot.blockAt(cell))) return true;
      } catch (err) {
        A.dbg("blok koyulamadı:", cell.toString(), err.message);
        if (++refused >= 2) break; // orada bir yaratık duruyor olabilir
      }
    }
    if (depth >= 2) break;
    // Tutunacak yer yok: bir altını doldur, sonra tekrar dene.
    if (!(await placeFiller(bot, cell.offset(0, -1, 0), depth + 1))) break;
  }
  return isSolid(bot.blockAt(cell));
}

// Hücrenin komşularındaki lavı blokla kapat (kazınca içeri akmasın).
// Kapatılamayan lav kaldıysa false döner: o hücre kazılmamalı.
async function sealLavaAround(bot, cell, skip) {
  let safe = true;
  for (const d of NEIGHBORS) {
    const n = cell.offset(d[0], d[1], d[2]);
    if (skip.some((s) => s.equals(n))) continue;
    if (isLiquid(bot.blockAt(n))) {
      await placeFiller(bot, n);
      if (isLiquid(bot.blockAt(n))) safe = false;
    }
  }
  return safe;
}

function lavaWithin(bot, cell, r) {
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -1; dy <= r + 1; dy++)
      for (let dz = -r; dz <= r; dz++) {
        if (isLava(bot.blockAt(cell.offset(dx, dy, dz)))) return true;
      }
  return false;
}

// Hücreyi yürünebilir yap: lav varsa kapat, blok varsa kaz.
async function clearCell(bot, cell, corridor) {
  for (let i = 0; i < 8; i++) {
    const b = bot.blockAt(cell);
    if (!b) return false;
    if (isLiquid(b)) {
      // Sıvının içine blok koy; sonraki turda (komşuları kapatıp) geri kazacağız.
      if (!(await placeFiller(bot, cell))) return false;
      continue;
    }
    if (b.name === "fire" || b.name === "soul_fire") {
      try { await bot.dig(b, true); } catch (err) { /* söndürülemedi */ }
      continue;
    }
    if (isOpen(b)) {
      await sealLavaAround(bot, cell, corridor);
      return true;
    }
    if (UNBREAKABLE.has(b.name) || b.hardness == null || b.hardness < 0) return false;
    if (!(await sealLavaAround(bot, cell, corridor))) {
      A.dbg("otoyol: yanında kapatılamayan lav var, kazmıyorum", cell.toString());
      return false;
    }
    try {
      await A.withHand(bot, async () => {
        const { item } = A.fastestTool(bot, b);
        if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
        await bot.dig(b, true);
      });
    } catch (err) {
      A.dbg("otoyol: kazılamadı", b.name, cell.toString(), err.message);
      await A.sleep(100);
    }
  }
  return isOpen(bot.blockAt(cell));
}

function cellOf(bot) {
  const p = bot.entity.position;
  return new Vec3(Math.floor(p.x), Math.floor(p.y + 0.01), Math.floor(p.z));
}

async function walkInto(bot, to, jump) {
  const center = to.offset(0.5, 0, 0.5);
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < 2500) {
      if (bot.inLavaEscape) return false;
      const p = bot.entity.position;
      const flat = Math.hypot(p.x - center.x, p.z - center.z);
      if (flat < 0.25 && Math.abs(p.y - to.y) < 0.3 && bot.entity.onGround) return true;
      // Bizi gören okçu/blaze varsa yüzümüz (kalkan) ona dönük kalsın, yan yan yürü:
      // kalkana çarpan ok ne can götürür ne de köprüden aşağı iter.
      const threat = C.rangedThreat(bot);
      if (threat) {
        await bot.lookAt(threat.position.offset(0, (threat.height || 1.8) * 0.8, 0), true);
        if (flat > 0.15) C.strafeToward(bot, center);
        else C.stopMoving(bot);
      } else {
        await bot.lookAt(new Vec3(center.x, p.y + 1.62, center.z), true);
        bot.setControlState("forward", flat > 0.15);
      }
      bot.setControlState("jump", Boolean(jump) && p.y < to.y - 0.1);
      await A.sleep(50);
    }
  } finally {
    C.stopMoving(bot);
    bot.setControlState("jump", false);
  }
  const c = cellOf(bot);
  return c.x === to.x && c.z === to.z;
}

// from'dan bitişik to hücresine güvenli geç (dy: -1, 0, +1).
// enclosed: yeni hücrelerin bütün açık komşularını (zemin, yan duvarlar, tavan,
// ön) blokla kapat. Böylece açık havada bile kapalı bir tüpün içinde ilerleriz:
// hiçbir yaratık bizi göremez, vuramaz, köprüden itemez.
async function step(bot, from, to, enclosed = false) {
  const corridor = [to, to.offset(0, 1, 0)];
  if (to.y > from.y) corridor.push(from.offset(0, 2, 0)); // zıplarken başımız çarpmasın
  if (to.y < from.y) corridor.push(to.offset(0, 2, 0));
  const keep = [...corridor, from, from.offset(0, 1, 0)];
  const kept = (n) => keep.some((k) => k.equals(n));
  if (enclosed) {
    // Önce kazacağımız hücrelerin dışını kapat (kazınca dışarısı açılmasın).
    // Zemin ilk sırada: diğerleri ona tutunur.
    const shell = [to.offset(0, -1, 0)];
    for (const c of corridor) {
      for (const d of NEIGHBORS) {
        const n = c.offset(d[0], d[1], d[2]);
        if (!kept(n) && !shell.some((x) => x.equals(n))) shell.push(n);
      }
    }
    for (const n of shell) {
      const b = bot.blockAt(n);
      if (!b) return false;
      if (!isSolid(b)) await placeFiller(bot, n);
    }
  }
  for (const c of corridor) {
    if (!(await clearCell(bot, c, keep))) return false;
  }
  const floor = to.offset(0, -1, 0);
  if (!isSolid(bot.blockAt(floor))) {
    if (!(await placeFiller(bot, floor))) return false;
  }
  return walkInto(bot, to, to.y > from.y);
}

// Olduğun yerde bir blok yüksel (zıpla, altına blok koy).
async function pillarUp(bot) {
  const base = cellOf(bot);
  if (!(await clearCell(bot, base.offset(0, 2, 0), [base, base.offset(0, 1, 0), base.offset(0, 2, 0)]))) return false;
  const ref = bot.blockAt(base.offset(0, -1, 0));
  if (!isSolid(ref)) return false;
  for (let attempt = 0; attempt < 4 && cellOf(bot).y === base.y; attempt++) {
    // Bloğun ortasında dur: kenardaysak koyduğumuz blok bize çarpar.
    const c = base.offset(0.5, 0, 0.5);
    for (let i = 0; i < 10 && Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z) > 0.12; i++) {
      await bot.lookAt(new Vec3(c.x, bot.entity.position.y + 1.62, c.z), true);
      bot.setControlState("forward", true);
      await A.sleep(50);
    }
    bot.setControlState("forward", false);
    await A.withHand(bot, async () => {
      const item = bot.inventory.items().find(isFiller);
      if (!item) return;
      if (!bot.heldItem || bot.heldItem.type !== item.type) await bot.equip(item, "hand");
      await bot.lookAt(base.offset(0.5, -0.5, 0.5), true);
      bot.setControlState("jump", true);
      const t0 = Date.now();
      try {
        while (Date.now() - t0 < 700) {
          if (bot.entity.position.y >= base.y + 1.08) {
            try {
              await bot.placeBlock(ref, new Vec3(0, 1, 0));
              break;
            } catch (err) {
              if (bot.entity.velocity.y < -0.2) break; // düşüyoruz, bu zıplamada olmadı
            }
          }
          await A.sleep(15);
        }
      } finally {
        bot.setControlState("jump", false);
      }
    });
    await A.sleep(300);
  }
  return cellOf(bot).y === base.y + 1;
}

/**
 * dest hücresine kadar otoyol yap. dest.y verilmezse (null) bulunduğun yükseklikte gider.
 * opts.until(): doğru dönerse erken durur. opts.range: hedefe bu kadar yaklaşınca yeter.
 * Dönen: "arrived" | "until" | "blocked" | "timeout" | "no-blocks"
 */
async function highway(bot, dest, opts = {}) {
  const maxMs = opts.maxMs || 240000;
  const range = opts.range || 0;
  const t0 = Date.now();
  const enclosed = Boolean(opts.enclosed);
  let fails = 0;
  let steps = 0;
  let plugged = false;
  bot.pathfinder.setGoal(null);
  for (;;) {
    if (Date.now() - t0 > maxMs) return "timeout";
    if (opts.until && opts.until()) return "until";
    if (opts.onTick) await opts.onTick();
    if (bot.inLavaEscape) {
      await A.sleep(100);
      continue;
    }
    if (!bot.entity.onGround) {
      await A.sleep(50);
      continue;
    }
    const cur = cellOf(bot);
    const ty = dest.y == null ? cur.y : dest.y;
    const rx = dest.x - cur.x;
    const rz = dest.z - cur.z;
    const flat = Math.abs(rx) + Math.abs(rz);
    if (Math.hypot(rx, rz) <= range && Math.abs(ty - cur.y) <= (range ? 1 : 0)) return "arrived";
    if (A.count(bot, isFiller) < 4) return "no-blocks";

    if (flat === 0) {
      // Tam altındayız/üstündeyiz.
      if (ty > cur.y) {
        if (!(await pillarUp(bot)) && ++fails > 6) return "blocked";
        continue;
      }
      return "blocked"; // aşağısı: buraya düşmemeliydik
    }
    // Yükseklik: alçaktaysak hemen çık (yukarısı daha güvenli), yüksekteysek sona doğru in.
    let dy = 0;
    if (cur.y < ty) dy = 1;
    else if (cur.y > ty && (opts.descendEarly || flat <= cur.y - ty + 1)) dy = -1;
    // Yatay: kalan mesafesi büyük olan eksende ilerle (arada sırayla → çapraz hat).
    const alongX = Math.abs(rx) >= Math.abs(rz);
    const moves = alongX
      ? [[Math.sign(rx), 0], [0, Math.sign(rz) || 1], [0, -(Math.sign(rz) || 1)]]
      : [[0, Math.sign(rz)], [Math.sign(rx) || 1, 0], [-(Math.sign(rx) || 1), 0]];
    const tries = [];
    tries.push([moves[0], dy]);
    if (moves[1][0] !== 0 || moves[1][1] !== 0) tries.push([moves[1], dy]);
    tries.push([moves[0], 1]); // engeli üstünden aş
    let moved = false;
    for (const [[mx, mz], my] of tries.slice(0, fails ? 3 : 1)) {
      if (mx === 0 && mz === 0) continue;
      const to = cur.offset(mx, my, mz);
      if (await step(bot, cur, to, enclosed)) {
        moved = true;
        if (enclosed && !plugged) {
          // Tüpün girişini kapat: arkamızdan kimse girmesin.
          plugged = true;
          await placeFiller(bot, cur);
          await placeFiller(bot, cur.offset(0, 1, 0));
        }
        break;
      }
    }
    if (moved) {
      fails = 0;
      steps++;
      if (opts.onStep && steps % 8 === 0) opts.onStep(cur);
    } else if (++fails > 8) {
      return "blocked";
    }
  }
}

// (x,z) hattı boyunca hangi yükseklikte gitmek en ucuz? Kayanın içinden geçmek
// bedava (tünel), açık havada her adım ~6 blok ister (kapalı tüp). Dönen:
// { y, air } — air: o yükseklikte açık havadan geçilecek adım sayısı.
function planLevel(bot, from, dest, minY = 36) {
  const cells = [];
  let x = from.x;
  let z = from.z;
  while (x !== dest.x || z !== dest.z) {
    if (Math.abs(dest.x - x) >= Math.abs(dest.z - z)) x += Math.sign(dest.x - x);
    else z += Math.sign(dest.z - z);
    cells.push([x, z]);
  }
  let best = null;
  for (let y = Math.max(minY, dest.y - 14); y <= dest.y + 1; y++) {
    let air = 0;
    let lava = 0;
    let unknown = 0;
    for (const [cx, cz] of cells) {
      const feet = bot.blockAt(new Vec3(cx, y, cz));
      const head = bot.blockAt(new Vec3(cx, y + 1, cz));
      if (!feet || !head) { unknown++; continue; }
      if (isLava(feet) || isLava(head) || isLava(bot.blockAt(new Vec3(cx, y + 2, cz)))) lava++;
      else if (!isSolid(feet) || !isSolid(head)) air++;
    }
    // Yükseklik farkını merdivenle kapatmak da adım ister (kaya içindeyse ucuz).
    const cost = air * 6 + lava * 40 + unknown * 6 + Math.abs(dest.y - y) * 2 + Math.abs(from.y - y);
    if (!best || cost < best.cost) best = { y, air: air + unknown, lava, cost };
  }
  return best;
}

// Dolgu bloğu topla: netherrack'in içine doğru tünel kaz; her adımda yan
// duvarları ve tavanı da al (adım başına ~7 blok). Kazılanlar yanımıza düşer,
// yürürken toplanır: tek tek toplamaktan çok daha hızlı.
async function mineTunnel(bot, want, maxSteps = 90, toward = null) {
  const have = () => A.count(bot, isFiller);
  // Hedefe doğru kazarsak kazdığımız yol aynı zamanda yol olur.
  const bias = (dx, dz) => {
    if (!toward) return 0;
    const c = cellOf(bot);
    return Math.sign(toward.x - c.x) === dx && dx !== 0 ? 6 : Math.sign(toward.z - c.z) === dz && dz !== 0 ? 6 : -4;
  };
  const density = (dx, dz) => {
    const c = cellOf(bot);
    let n = 0;
    for (let i = 1; i <= 10; i++) {
      for (const dy of [0, 1]) {
        const b = bot.blockAt(c.offset(dx * i, dy, dz * i));
        if (b && MINEABLE.has(b.name)) n++;
        else if (b && (b.name === "lava" || UNBREAKABLE.has(b.name))) n -= 3;
      }
      const floor = bot.blockAt(c.offset(dx * i, -1, dz * i));
      if (!isSolid(floor)) n -= 2;
      if (i <= 4 && lavaWithin(bot, c.offset(dx * i, 0, dz * i), 2)) n -= 20; // lav cebine yaklaşma
    }
    return n;
  };
  const safeToDig = (p) => {
    const b = bot.blockAt(p);
    if (!b || !MINEABLE.has(b.name)) return false;
    // Arkasında lav ya da boşluk (dışarısı) varsa dokunma.
    return !NEIGHBORS.some(([x, y, z]) => isLava(bot.blockAt(p.offset(x, y, z))));
  };
  let steps = 0;
  let sunk = 0;
  let dir = null;
  while (have() < want && steps < maxSteps) {
    if (bot.inLavaEscape) return have();
    if (!dir || density(dir[0], dir[1]) < 3) {
      const best = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map((d) => ({ d, n: density(d[0], d[1]), s: density(d[0], d[1]) + bias(d[0], d[1]) }))
        .sort((a, b) => b.s - a.s)[0];
      if (best.n < 3) {
        // Açık arazideyiz: önce merdivenle iki-üç blok yere gir, kaya orada.
        if (sunk >= 4) break;
        sunk++;
        const c = cellOf(bot);
        const down = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map((d) => c.offset(d[0], -1, d[1]))
          .find((p) => MINEABLE.has((bot.blockAt(p) || {}).name) && isSolid(bot.blockAt(p.offset(0, -1, 0))) && !lavaWithin(bot, p, 2));
        if (!down || !(await step(bot, c, down))) break;
        steps++;
        continue;
      }
      dir = best.d;
    }
    const cur = cellOf(bot);
    const nxt = cur.offset(dir[0], 0, dir[1]);
    if (lavaWithin(bot, nxt, 2) || !(await step(bot, cur, nxt))) {
      dir = null;
      steps++;
      continue;
    }
    // Yanlar (iki seviye) ve tavan.
    const here = cellOf(bot);
    const side = [dir[1], dir[0]];
    const extra = [
      here.offset(side[0], 0, side[1]), here.offset(-side[0], 0, -side[1]),
      here.offset(side[0], 1, side[1]), here.offset(-side[0], 1, -side[1]),
      here.offset(0, 2, 0),
    ];
    for (const p of extra) {
      if (!safeToDig(p)) continue;
      try {
        await A.withHand(bot, async () => {
          const b = bot.blockAt(p);
          const { item } = A.fastestTool(bot, b);
          if (item && (!bot.heldItem || bot.heldItem.type !== item.type)) await bot.equip(item, "hand");
          await bot.dig(b, true);
        });
      } catch (err) {
        A.dbg("tünel: kazılamadı", err.message);
      }
    }
    steps++;
  }
  await A.sleep(300);
  return have();
}

module.exports = { highway, mineTunnel, planLevel, step, walkInto, MINEABLE, placeFiller, clearCell, pillarUp, cellOf, FILLERS, isFiller };
