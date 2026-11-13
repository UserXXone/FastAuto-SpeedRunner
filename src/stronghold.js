"use strict";

// Faz 3d: Nether'dan dönüş, kale (stronghold), portal odası, gözleri takma.
//
//   1. Geldiğimiz Nether portalına kapalı tünelle dön, içinden geç.
//   2. Overworld'de kalenin (x,z) noktasına yürü.
//   3. Portal çerçevelerini (end_portal_frame) yüklü bölgede bul. Blaze
//      spawner'ında olduğu gibi duvarın arkasını "görerek" buluyoruz; normal bir
//      oyuncu göz atarak ve kazarak bulur.
//   4. Yüzeyden portal odasına merdiven şeklinde kapalı tünel kaz.
//   5. Halkanın ortasında durup boş çerçevelere göz tak. Son gözü takmadan önce
//      halkanın dışına çık: portal açılınca içine düşmeyelim (End, Faz 4'ün işi).

const { Vec3 } = require("vec3");
const {
  goals: { GoalBlock, GoalNearXZ },
} = require("mineflayer-pathfinder");
const A = require("./actions");
const H = require("./highway");

const eyes = (bot) => A.count(bot, "ender_eye");

function portalBlocks(bot, maxDistance = 96) {
  const id = bot.registry.blocksByName.nether_portal.id;
  return bot.findBlocks({ matching: id, maxDistance, count: 12 });
}

// En alttaki portal bloğu (içine yürünecek hücre).
function portalFoot(bot, maxDistance) {
  const all = portalBlocks(bot, maxDistance);
  if (!all.length) return null;
  const me = bot.entity.position;
  all.sort((a, b) => a.y - b.y || a.distanceTo(me) - b.distanceTo(me));
  return all[0];
}

/**
 * Nether portalına dön ve Overworld'e geç. back: Nether'a ilk çıktığımız yer.
 */
async function returnToOverworld(bot, back, say = () => {}) {
  const from = bot.game.dimension;
  let foot = portalFoot(bot, 48);
  if (!foot) {
    if (!back) throw new Error("Dönüş portalının yeri bilinmiyor");
    say(`Portala dönüyorum (${back.x}, ${back.y}, ${back.z})`);
    const r = await H.highway(bot, { x: back.x, y: null, z: back.z }, {
      range: 6, maxMs: 600000, enclosed: true, until: () => Boolean((foot = portalFoot(bot, 24))),
    });
    A.dbg("dönüş otoyolu:", r);
    foot = foot || portalFoot(bot, 64);
  }
  if (!foot) throw new Error("Dönüş portalı bulunamadı");
  const r = await H.highway(bot, foot, { range: 2, maxMs: 240000, enclosed: true, descendEarly: true });
  A.dbg("portalın yanı:", r, H.cellOf(bot).toString(), "portal", foot.toString());
  const t0 = Date.now();
  while (bot.game.dimension === from && Date.now() - t0 < 60000) {
    foot = portalFoot(bot, 16) || foot;
    await A.goto(bot, new GoalBlock(foot.x, foot.y, foot.z), 10000);
    // Portalın içinde 4 sn durmak gerekir.
    for (let i = 0; i < 100 && bot.game.dimension === from; i++) await A.sleep(50);
  }
  bot.clearControlStates();
  return bot.game.dimension !== from;
}

const hasEye = (b) => {
  const p = b && b.getProperties ? b.getProperties() : {};
  return p.eye === true || p.eye === "true";
};

// Yüklü bölgede portal halkası: { frames: Vec3[12], center: Vec3 } (center: halkanın ortası, çerçeve yüksekliğinde)
function findPortalRoom(bot, maxDistance = 128) {
  const id = bot.registry.blocksByName.end_portal_frame.id;
  const all = bot.findBlocks({ matching: id, maxDistance, count: 24 });
  if (!all.length) return null;
  const first = all[0];
  const frames = all.filter((p) => p.y === first.y && Math.abs(p.x - first.x) <= 4 && Math.abs(p.z - first.z) <= 4);
  if (frames.length < 12) return null; // halkanın bir kısmı henüz yüklenmemiş
  const xs = frames.map((p) => p.x);
  const zs = frames.map((p) => p.z);
  const center = new Vec3((Math.min(...xs) + Math.max(...xs)) / 2, first.y, (Math.min(...zs) + Math.max(...zs)) / 2);
  return { frames, center };
}

// Kalenin çevresini gezerek portal odasını ara.
async function locatePortalRoom(bot, kale, say = () => {}) {
  let room = findPortalRoom(bot);
  const [kx, kz] = kale;
  const ring = [[0, 0], [64, 0], [64, 64], [0, 64], [-64, 64], [-64, 0], [-64, -64], [0, -64], [64, -64], [128, 0], [0, 128], [-128, 0], [0, -128]];
  for (const [dx, dz] of ring) {
    if (room) break;
    say(`Portal odası aranıyor (${kx + dx}, ${kz + dz})`);
    await A.goto(bot, new GoalNearXZ(kx + dx, kz + dz, 6), 60000);
    room = findPortalRoom(bot);
  }
  return room;
}

const isAirName = (b) => Boolean(b && b.boundingBox === "empty" && !["lava", "water"].includes(b.name));
const isLavaB = (b) => Boolean(b && b.name === "lava");

// Halkanın ortası (3x3) altı lavlı bir çukur: orada ASLA durma. Göz takmak için
// çerçeve yüksekliğinde, halkanın DIŞINDA hücreler. Zemini sağlamsa maliyet 0;
// boş ya da lavsa (çerçeveler lav havuzunun kıyısında olabilir) otoyol zemini kendisi
// kurar, maliyet 3. Ayak/baş hücresi lav olamaz; sağlam blok ise kazılır.
function standCells(bot, room) {
  const c = room.center;
  const out = [];
  const hard = (b) => b && (b.name === "bedrock" || b.name === "end_portal_frame" || b.name === "spawner");
  for (let dx = -5; dx <= 5; dx++)
    for (let dz = -5; dz <= 5; dz++) {
      if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2 && !(Math.abs(dx) === 2 && Math.abs(dz) === 2)) continue; // halka + içi
      const cell = new Vec3(Math.floor(c.x) + dx, c.y, Math.floor(c.z) + dz);
      const floor = bot.blockAt(cell.offset(0, -1, 0));
      const feet = bot.blockAt(cell);
      const head = bot.blockAt(cell.offset(0, 1, 0));
      if (!floor || !feet || !head || hard(feet) || hard(head) || hard(floor)) continue;
      if (isLavaB(feet) || isLavaB(head) || feet.name === "water" || head.name === "water") continue;
      let cost = floor.boundingBox === "block" && floor.name !== "magma_block" ? 0 : 3;
      if (feet.boundingBox === "block") cost += 1;
      if (head.boundingBox === "block") cost += 1;
      cell.cost = cost;
      out.push(cell);
    }
  return out;
}

const reachOf = (cell, frame) => cell.offset(0.5, 1.62, 0.5).distanceTo(frame.offset(0.5, 0.82, 0.5));

/**
 * Yüzeyden portal odasına (halkanın dışındaki bir duruş noktasına) tünel kaz.
 * Dönen: duruş hücresi ya da null.
 */
async function tunnelToRoom(bot, room, say = () => {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cells = standCells(bot, room);
    if (!cells.length) {
      A.dbg("duruş noktası yok: halkanın çevresi henüz yüklenmemiş olabilir");
      await A.sleep(1500);
      continue;
    }
    const me = bot.entity.position;
    cells.sort((a, b) => a.distanceTo(me) + a.cost * 4 - (b.distanceTo(me) + b.cost * 4));
    const T = cells[0];
    const drop = me.y - T.y;
    const flat = Math.hypot(me.x - T.x, me.z - T.z);
    // Merdiven her adımda bir blok iner: yeterince uzaktan başlamak gerek.
    if (drop > 0 && flat < drop + 6) {
      const ang = flat > 1 ? Math.atan2(me.z - T.z, me.x - T.x) : 0;
      const d = drop + 8;
      await A.goto(bot, new GoalNearXZ(Math.round(T.x + Math.cos(ang) * d), Math.round(T.z + Math.sin(ang) * d), 2), 60000);
    }
    say(`Portal odasına tünel: duruş ${T.x}, ${T.y}, ${T.z}`);
    let r = await H.highway(bot, T, { range: 6, maxMs: 420000, enclosed: true, descendEarly: true });
    A.dbg("kale tüneli:", r, H.cellOf(bot).toString());
    r = await H.highway(bot, T, { maxMs: 90000 });
    A.dbg("duruş noktası:", r, H.cellOf(bot).toString());
    const c = H.cellOf(bot);
    if (c.y === room.center.y && !isLavaB(bot.blockAt(c.offset(0, -1, 0)))) return c;
  }
  return null;
}

async function insertEye(bot, pos) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const b = bot.blockAt(pos);
    if (!b || b.name !== "end_portal_frame") return false;
    if (hasEye(b)) return true;
    await A.withHand(bot, async () => {
      const item = bot.inventory.items().find((i) => i.name === "ender_eye");
      if (!item) return;
      await bot.equip(item, "hand");
      await bot.lookAt(pos.offset(0.5, 0.82, 0.5), true);
      await A.sleep(150);
      try {
        await bot.activateBlock(b, new Vec3(0, 1, 0));
      } catch (err) {
        A.dbg("göz takılamadı:", err.message);
      }
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 1200 && !hasEye(bot.blockAt(pos))) await A.sleep(50);
  }
  return hasEye(bot.blockAt(pos));
}

// Çerçeveye elimiz yetişmiyorsa halkanın dışında, ona en yakın duruş noktasına geç.
async function moveNear(bot, room, frame) {
  const cur = H.cellOf(bot);
  if (reachOf(cur, frame) <= 3.9) return true;
  const best = standCells(bot, room)
    .filter((c) => reachOf(c, frame) <= 3.9)
    .sort((a, b) => a.distanceTo(cur) + a.cost * 4 - (b.distanceTo(cur) + b.cost * 4))[0];
  if (!best) { A.dbg("yakın duruş hücresi yok:", frame.toString(), "aday", standCells(bot, room).length); return false; }
  const r = await H.highway(bot, best, { maxMs: 60000 });
  A.dbg("çerçeveye yaklaşma:", r, H.cellOf(bot).toString());
  const now = H.cellOf(bot);
  return now.y === room.center.y && reachOf(now, frame) <= 4.2;
}

/**
 * Boş çerçevelere göz tak; hep halkanın dışında dur. Dönen: { placed, open }
 */
async function fillPortal(bot, room, say = () => {}) {
  const empty = () => room.frames.filter((p) => !hasEye(bot.blockAt(p)));
  let todo = empty();
  if (eyes(bot) < todo.length) throw new Error(`Göz yetmiyor: ${eyes(bot)} var, ${todo.length} lazım`);
  let placed = 0;
  while (todo.length) {
    // Elimizin yettiği çerçeveden başla: gereksiz yürümeyiz.
    const cur = H.cellOf(bot);
    todo.sort((a, b) => reachOf(cur, a) - reachOf(cur, b));
    const p = todo.shift();
    if (!(await moveNear(bot, room, p))) throw new Error(`Çerçeveye yaklaşılamadı: ${p}`);
    if (!(await insertEye(bot, p))) throw new Error(`Göz takılamadı: ${p}`);
    placed++;
    say(`  göz ${12 - empty().length}/12`);
  }
  await A.sleep(700);
  const mid = bot.blockAt(room.center);
  return { placed, open: Boolean(mid && mid.name === "end_portal") };
}

module.exports = { returnToOverworld, findPortalRoom, locatePortalRoom, tunnelToRoom, fillPortal, eyes };
