"use strict";

const A = require("./actions");
const H = require("./highway");
const E = require("./pearl");
const { Vec3 } = require("vec3");

const neededEyes = (eyes = 0) => Math.max(0, 12 - eyes);
const ingotsFromNuggets = (n) => Math.floor(n / 9);
const drops = (bot, name) => Object.values(bot.entities).filter(e => {
  if (e.name !== "item") return false;
  try { return e.getDroppedItem()?.name === name; } catch (_) { return false; }
});

const piglinsNear = (bot, range = 12) => {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter(e => e.name === "piglin" && e.position.distanceTo(me) <= range)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
};

const blockIsOpen = (b) => Boolean(b && b.boundingBox !== "block" && b.name !== "lava" && b.name !== "fire" && b.name !== "soul_fire");
const flatDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function logPiglins(bot, piglins) {
  const list = piglins.slice(0, 3).map(p => {
    const d = p.position.distanceTo(bot.entity.position).toFixed(1);
    const q = p.position;
    return `${p.id}@${q.x.toFixed(0)},${q.y.toFixed(0)},${q.z.toFixed(0)} d=${d}`;
  });
  A.dbg("Takas turu piglinleri:", list.length ? list.join(" | ") : "yok");
}

async function reachPiglins(bot, target, maxMs) {
  let result = "not-started";
  try {
    result = await H.longHaul(bot, { x: target.x, z: target.z }, {
      // Bastion merkezine girmiyoruz: yol, ilk iki normal piglin 14 blok içine
      // girince kesilir; 20 blok da merkezden güvenli bir son yaklaşma payıdır.
      range: 20,
      maxMs,
      until: () => piglinsNear(bot, 14).length >= 2,
    });
  } catch (err) {
    A.dbg("Takas: piglin yolunda hata", err.message);
    return false;
  }
  const piglins = piglinsNear(bot, 14);
  if (piglins.length < 2) {
    A.dbg("Takas: piglin bölgesine varılamadı", result,
      `konum=${H.cellOf(bot).toString()}`, `yakın=${piglins.length}`, "pearl 0");
    return false;
  }
  A.dbg("Takas: piglin bölgesine varıldı", result, H.cellOf(bot).toString());
  return true;
}

function windowCell(bot, target) {
  const me = H.cellOf(bot);
  const dx = target.x - me.x;
  const dz = target.z - me.z;
  // Köşe bloğunu değil, kapsülün pigline bakan tek bir yan duvarını aç.
  if (Math.abs(dx) >= Math.abs(dz) && dx) return me.offset(Math.sign(dx), 1, 0);
  if (dz) return me.offset(0, 1, Math.sign(dz));
  return null;
}

async function openWindow(bot, target) {
  const wall = windowCell(bot, target);
  if (!wall) return null;
  const before = bot.blockAt(wall);
  if (!blockIsOpen(before)) {
    try {
      await A.withHand(bot, async () => {
        const b = bot.blockAt(wall);
        if (!b || blockIsOpen(b)) return;
        const { item } = A.fastestTool(bot, b);
        if (item) await bot.equip(item, "hand");
        await bot.dig(b, true);
      });
    } catch (err) {
      A.dbg("Takas: pencere açılamadı", wall.toString(), err.message);
    }
  }
  const after = bot.blockAt(wall);
  A.dbg("Takas: pencere", wall.toString(), before && before.name, "→", after && after.name,
    blockIsOpen(after) ? "açık" : "kapalı");
  if (!blockIsOpen(after)) return null;
  return wall;
}

async function closeWindow(bot, wall) {
  if (!wall || !blockIsOpen(bot.blockAt(wall))) return;
  await H.placeFiller(bot, wall);
  if (!blockIsOpen(bot.blockAt(wall))) A.dbg("Takas: pencere kapandı", wall.toString());
}

function nearestGoldDrop(bot, near) {
  return drops(bot, "gold_ingot")
    .filter(e => !near || e.position.distanceTo(near) <= 6)
    .sort((a, b) => a.position.distanceTo(near || bot.entity.position) - b.position.distanceTo(near || bot.entity.position))[0];
}

async function settlePending(bot, pending) {
  const now = Date.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    const trade = pending[i];
    const drop = trade.id != null ? bot.entities[trade.id] : nearestGoldDrop(bot, trade.position);
    if (drop && trade.id == null) trade.id = drop.id;
    if (drop && now - trade.at >= 7000) {
      A.dbg("Takas: 7 sn sonra külçe hâlâ yerde", trade.id, "yeniden topluyorum");
      const wall = await openWindow(bot, drop.position);
      if (wall) {
        await A.collectDrops(bot, drop.position, 6);
        await A.sleep(250);
        await closeWindow(bot, wall);
      }
      const remains = trade.id != null && bot.entities[trade.id];
      if (remains) A.dbg("Takas: külçe alınamadı, pending'den çıkarıldı", trade.id);
      else A.dbg("Takas: külçe geri toplandı", trade.id);
      pending.splice(i, 1);
    } else if (!drop && now - trade.at >= 7000) {
      // Piglin aldıysa veya sunucu drop entity'sini kaldırdıysa takas tamamlanmıştır.
      pending.splice(i, 1);
    }
  }
}

async function mineGold(bot, wantNuggets, say = () => {}, opts = {}) {
  let emptyTries = 0;
  const end = Date.now() + (opts.maxMs || 240000), id = bot.registry.blocksByName.nether_gold_ore.id;
  while (Date.now() < end && A.count(bot, "gold_nugget") < wantNuggets) {
    const ores = bot.findBlocks({ matching: id, maxDistance: 48, count: 128 })
      .map(p => new Vec3(p.x, p.y, p.z)).filter(p => ![[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z]) => bot.blockAt(p.offset(x,y,z))?.name === "lava"))
      .filter(p => !opts.bastion || flatDistance(p, opts.bastion) <= 80)
      .sort((a,b) => {
        const score = p => p.distanceTo(bot.entity.position) + (opts.bastion ? 0.5 * flatDistance(p, opts.bastion) : 0);
        return score(a) - score(b);
      });
    const ore = ores[0];
    if (!ore) {
      // Işınlandıktan/vardıktan hemen sonra chunk'lar yüklenmemiş olabiliyor (0 cevher bulup çıkıyorduk).
      if (++emptyTries <= 5) { await A.sleep(1500); continue; }
      break;
    }
    const r = await H.highway(bot, ore, { enclosed: true, range: 1, maxMs: Math.min(60000, end-Date.now()) });
    if (r !== "arrived") break;
    const b = bot.blockAt(ore); if (!b || b.name !== "nether_gold_ore") continue;
    try { await A.withHand(bot, async () => { const {item}=A.fastestTool(bot,b); if(item) await bot.equip(item,"hand"); await bot.dig(b,true); }); } catch (_) { continue; }
    await A.sleep(500); await A.collectDrops(bot, bot.entity.position, 4);
  }
  return A.count(bot,"gold_nugget");
}

async function barter(bot, needPearls, say = () => {}, opts = {}) {
  const t0=Date.now(), maxMs=opts.maxMs||360000, target=opts.bastion;
  if (target) {
    const travelMs = Math.min(180000, Math.max(1000, maxMs - (Date.now() - t0)));
    if (!(await reachPiglins(bot, target, travelMs))) {
      return {pearls:E.pearls(bot),ingotsUsed:0,ms:Date.now()-t0};
    }
  }
  await E.sealCapsule(bot);
  const start=A.count(bot,"gold_ingot"); let pending=[], last=Date.now();
  while(Date.now()-t0<maxMs && E.pearls(bot)<needPearls && A.count(bot,"gold_ingot")>0) {
    const me=bot.entity.position;
    await settlePending(bot, pending);
    const piglins=piglinsNear(bot, 12);
    logPiglins(bot, piglins);
    const brutes=Object.values(bot.entities).filter(e=>["piglin_brute","hoglin"].includes(e.name)&&e.position.distanceTo(me)<6);
    if(pending.length<3&&piglins.length) {
      const p=piglins.find(e=>!pending.some(x=>x.piglin===e.id));
      if(p){
        const wall=await openWindow(bot,p.position);
        const stillNear=piglinsNear(bot,12).find(e=>e.id===p.id);
        if(wall && stillNear) {
          await bot.lookAt(p.position.offset(0,1,0),true);
          const item=bot.inventory.items().find(i=>i.name==="gold_ingot");
          if(item){
            const before=A.count(bot,"gold_ingot");
            const beforeDrops=new Set(drops(bot,"gold_ingot").map(e=>e.id));
            await bot.toss(item.type,null,1);
            await A.sleep(250);
            const after=A.count(bot,"gold_ingot");
            const drop= drops(bot,"gold_ingot").find(e=>!beforeDrops.has(e.id)) || nearestGoldDrop(bot,me);
            A.dbg("Takas: külçe atışı", `önce=${before}`, `sonra=${after}`, `piglin=${p.id}`, drop ? `drop=${drop.id}` : "drop=?");
            if(after<before || drop) pending.push({id:drop?.id??null,piglin:p.id,at:Date.now(),position:drop?.position?.clone?.()||me.clone()});
          }
        }
        await closeWindow(bot,wall);
      }
    }
    await A.sleep(1000);
    if(Date.now()-last>=10000){last=Date.now();A.dbg(`Takas: ${E.pearls(bot)} pearl, ${A.count(bot,"gold_ingot")} külçe, ${piglins.length} piglin`);}
    if(brutes.length) await A.sleep(1000);
  }
  // Başarılı tur bitse bile son atılan külçenin 7 saniyelik teslim penceresini bekle.
  while (pending.length && Date.now()-t0<maxMs) {
    await settlePending(bot, pending);
    if (pending.length) await A.sleep(250);
  }
  return {pearls:E.pearls(bot),ingotsUsed:start-A.count(bot,"gold_ingot"),ms:Date.now()-t0};
}

module.exports={mineGold,barter,neededEyes,ingotsFromNuggets};
