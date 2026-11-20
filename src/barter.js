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
const GOLD_WALK_LIMIT = 96;
const GOLD_ORE_RANGE = 24;

// Cevheri hedef olarak vermek tehlikeli: highway range=1 ile cevherin tam
// üstündeki hücrede de "vardım" diyebilir. Cevher tabandaysa kazma sonrası
// botun zemini açılır ve düşer. Önce cevherin yatay komşularından güvenli bir
// duruş hücresi seç; böylece kazılan blok hiçbir zaman botun ayağının altında
// olmaz.
function goldStand(bot, ore) {
  const candidates = [
    ore.offset(1, 0, 0), ore.offset(-1, 0, 0),
    ore.offset(0, 0, 1), ore.offset(0, 0, -1),
  ];
  return candidates.find((p) => {
    const feet = bot.blockAt(p);
    const head = bot.blockAt(p.offset(0, 1, 0));
    const floor = bot.blockAt(p.offset(0, -1, 0));
    // Bir komşu cevheri yol açmak için istemeden kazmayalım. Dolgu/hava
    // olabilir; highway gereken hücreyi zaten güvenli biçimde hazırlar.
    if (feet?.name === "nether_gold_ore" || head?.name === "nether_gold_ore") return false;
    if (!feet || !head || !floor) return false;
    if (feet.name === "lava" || head.name === "lava" || floor.name === "lava") return false;
    if (feet.name === "fire" || head.name === "fire" || feet.name === "soul_fire" || head.name === "soul_fire") return false;
    return true;
  });
}

function logPiglins(bot, piglins) {
  const list = piglins.slice(0, 3).map(p => {
    const d = p.position.distanceTo(bot.entity.position).toFixed(1);
    const q = p.position;
    return `${p.id}@${q.x.toFixed(0)},${q.y.toFixed(0)},${q.z.toFixed(0)} d=${d}`;
  });
  A.dbg("Takas turu piglinleri:", list.length ? list.join(" | ") : "yok");
}

function visiblePiglinCluster(bot) {
  const me = bot.entity.position;
  const visible = Object.values(bot.entities)
    .filter(e => e.name === "piglin" && e.position && e.position.distanceTo(me) <= 96);
  return visible.map(p => {
    const neighbors = visible.filter(q => q.position.distanceTo(p.position) <= 10);
    return {
      piglin: p,
      count: neighbors.length,
      distance: p.position.distanceTo(me),
    };
  }).sort((a, b) => b.count - a.count || a.distance - b.distance)[0] || null;
}

function logPiglinTarget(bot, kind, target, cluster = null) {
  const p = cluster?.piglin;
  A.dbg("Takas: piglin yeni hedef", kind,
    `piglin=${p ? p.id : "yok"}`,
    cluster ? `küme=${cluster.count}` : "küme=?",
    `hedef=${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z)}`,
    `bot=${H.cellOf(bot).toString()}`);
}

function groundOpenBetween(bot, target) {
  const me = H.cellOf(bot);
  const tx = Math.floor(target.position.x), tz = Math.floor(target.position.z);
  if (Math.abs(Math.floor(target.position.y) - me.y) > 1) return false;
  let x = me.x, z = me.z;
  const xFirst = Math.abs(tx - x) >= Math.abs(tz - z);
  while (x !== tx || z !== tz) {
    if ((xFirst && x !== tx) || z === tz) x += Math.sign(tx - x);
    else z += Math.sign(tz - z);
    const feet = bot.blockAt(new Vec3(x, me.y, z));
    const head = bot.blockAt(new Vec3(x, me.y + 1, z));
    const floor = bot.blockAt(new Vec3(x, me.y - 1, z));
    if (!blockIsOpen(feet) || !blockIsOpen(head) || !floor || floor.boundingBox !== "block" || floor.name === "lava") return false;
  }
  return true;
}

async function approachTradePiglin(bot, cluster, maxMs) {
  const p = cluster?.piglin;
  if (!p) return false;
  if (p.position.distanceTo(bot.entity.position) <= 4) return true;
  const dest = { x: Math.round(p.position.x), y: Math.round(p.position.y), z: Math.round(p.position.z) };
  A.dbg("Takas: 4 blok içine yaklaşıyorum", `piglin=${p.id}`, `hedef=${dest.x},${dest.y},${dest.z}`, H.cellOf(bot).toString());
  let result = "not-started";
  try {
    result = await H.highway(bot, dest, {
      enclosed: true,
      range: 3,
      maxMs,
      until: () => piglinsNear(bot, 4).length > 0,
    });
  } catch (err) {
    A.dbg("Takas: yakına yaklaşım hatası", err.message);
  }
  A.dbg("Takas: 4 blok yaklaşım sonucu", result, H.cellOf(bot).toString());
  return piglinsNear(bot, 4).length > 0;
}

async function ensureTradeRange(bot, maxMs) {
  if (piglinsNear(bot, 4).length) return true;
  const cluster = visiblePiglinCluster(bot);
  return Boolean(cluster && await approachTradePiglin(bot, cluster, maxMs));
}

async function reachPiglins(bot, target, maxMs) {
  const deadline = Date.now() + maxMs;
  const nearEnough = () => piglinsNear(bot, 12).length >= 2;
  const remaining = () => Math.max(1000, deadline - Date.now());
  let fallbackRetryAt = 0;

  while (Date.now() < deadline) {
    if (nearEnough() && await ensureTradeRange(bot, Math.min(30000, remaining()))) {
      A.dbg("Takas: piglin bölgesine varıldı", "until", H.cellOf(bot).toString());
      return true;
    }

    const cluster = visiblePiglinCluster(bot);
    if (cluster) {
      fallbackRetryAt = 0;
      const p = cluster.piglin.position;
      const piglinY = Math.round(p.y);
      const dest = { x: Math.round(p.x), y: piglinY, z: Math.round(p.z) };
      logPiglinTarget(bot, "görünen küme", dest, cluster);
      let result;
      try {
        // longHaul hedefe son 30 blok kala dönsün; yükseklik aralığı piglinin
        // seviyesini zorlar, planLevel yine o aralıkta en ucuz katı seçer.
        result = await H.longHaul(bot, { x: dest.x, z: dest.z }, {
          range: 30,
          minY: Math.max(20, piglinY - 3),
          maxY: piglinY + 3,
          maxMs: Math.min(30000, remaining()),
          until: nearEnough,
        });
        A.dbg("Takas: piglin uzun yolu", result, `hedefY=${piglinY}`, H.cellOf(bot).toString());
        if (nearEnough() && await ensureTradeRange(bot, Math.min(30000, remaining()))) return true;

        // longHaul y'yi seçse de hedefe yaklaşınca piglinin gerçek katına
        // inmek gerekir; range 10 içinde iki piglin varsa until keser.
        const d = Math.hypot(dest.x - H.cellOf(bot).x, dest.z - H.cellOf(bot).z);
        if (d <= 30 && Date.now() < deadline) {
          result = await H.highway(bot, dest, {
            enclosed: true,
            range: 10,
            maxMs: Math.min(30000, remaining()),
            until: nearEnough,
          });
          A.dbg("Takas: piglin son yaklaşım", result, `hedefY=${piglinY}`, H.cellOf(bot).toString());
        }
      } catch (err) {
        A.dbg("Takas: piglin yolunda hata", err.message);
      }
      if (nearEnough() && await ensureTradeRange(bot, Math.min(30000, remaining()))) {
        A.dbg("Takas: piglin bölgesine varıldı", "until", H.cellOf(bot).toString());
        return true;
      }
      // Bir küme görüldü ama 12 blok içinde iki piglin yoksa, yeni entity
      // güncellemelerini bekleyip yeniden küme seç.
      await A.sleep(Math.min(500, remaining()));
      continue;
    }

    // Entity henüz görünmüyorsa yapının içine, bastion merkezi yüksekliğine
    // yaklaş. En fazla 20 saniyelik bu dilimde entity'leri yeniden kontrol et;
    // görünür oldukları anda bir sonraki turda piglin kümesine geçilir.
    if (Date.now() < fallbackRetryAt) {
      await A.sleep(Math.min(500, remaining()));
      continue;
    }
    const fallback = { x: target.x, y: 60, z: target.z };
    logPiglinTarget(bot, "piglin görünmüyor, bastion taraması", fallback);
    let result = "not-started";
    try {
      result = await H.longHaul(bot, { x: target.x, z: target.z }, {
        range: 0,
        minY: 56,
        maxY: 64,
        maxMs: Math.min(20000, remaining()),
        until: nearEnough,
      });
      if (!nearEnough() && Math.hypot(target.x - H.cellOf(bot).x, target.z - H.cellOf(bot).z) <= 30 && Date.now() < deadline) {
        result = await H.highway(bot, fallback, {
          enclosed: true,
          range: 10,
          maxMs: Math.min(30000, remaining()),
          until: nearEnough,
        });
      }
    } catch (err) {
      A.dbg("Takas: bastion tarama yolunda hata", err.message);
    }
    A.dbg("Takas: bastion tarama sonucu", result, H.cellOf(bot).toString());
    fallbackRetryAt = Date.now() + 20000;
    if (nearEnough() && await ensureTradeRange(bot, Math.min(30000, remaining()))) return true;
    await A.sleep(Math.min(500, remaining()));
  }

  const piglins = piglinsNear(bot, 12);
  A.dbg("Takas: piglin bölgesine varılamadı", "timeout",
    `konum=${H.cellOf(bot).toString()}`, `yakın=${piglins.length}`, "pearl 0");
  return false;
}

function windowCell(bot, target) {
  const me = H.cellOf(bot);
  const dx = target.x - me.x;
  const dz = target.z - me.z;
  // Piglinin yürüyeceği zemine külçe bırak: baş hizası penceresi itemi
  // kapsülün üstüne/duvara sektiriyor ve piglinin yanımıza gelmesini engelliyor.
  if (Math.abs(dx) >= Math.abs(dz) && dx) return me.offset(Math.sign(dx), 0, 0);
  if (dz) return me.offset(0, 0, Math.sign(dz));
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

function hostileTradeNear(bot) {
  const me = bot.entity.position;
  return Object.values(bot.entities).some(e =>
    ["piglin_brute", "hoglin"].includes(e.name) && e.position.distanceTo(me) < 5);
}

function nearbyPearl(bot) {
  return drops(bot, "ender_pearl")
    .filter(e => e.position.distanceTo(bot.entity.position) <= 3)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
}

async function withDeadline(promise, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return null;
  return Promise.race([
    promise.catch(() => null),
    A.sleep(left).then(() => null),
  ]);
}

async function collectDropQuick(bot, drop, deadline) {
  try {
    while (bot.entities[drop.id] && Date.now() < deadline) {
      const current = bot.entities[drop.id];
      if (current.position.distanceTo(bot.entity.position) <= 1.35) {
        await A.sleep(Math.min(200, Math.max(25, deadline - Date.now())));
        continue;
      }
      await bot.lookAt(current.position, true).catch(() => {});
      bot.setControlState("forward", true);
      await A.sleep(75);
      bot.setControlState("forward", false);
    }
  } finally {
    bot.setControlState("forward", false);
    bot.setControlState("jump", false);
  }
  return !bot.entities[drop.id];
}

// Piglinin bıraktığı pearl kapsülün dibine geldiyse iki saniyelik kısa bir
// toplama penceresi aç. Brute/hoglin yakındaysa pencereyi açıp botu dışarı
// çıkarmıyoruz.
async function collectNearbyPearl(bot) {
  const pearl = nearbyPearl(bot);
  if (!pearl || hostileTradeNear(bot)) return false;
  const deadline = Date.now() + 2000;
  const wall = await withDeadline(openWindow(bot, pearl.position), deadline);
  if (!wall || hostileTradeNear(bot)) return false;
  A.dbg("Takas: pearl yakında, pencere açıldı", pearl.id, H.cellOf(bot).toString());
  const got = await collectDropQuick(bot, pearl, deadline);
  if (Date.now() < deadline - 250) await withDeadline(closeWindow(bot, wall), deadline);
  A.dbg("Takas: pearl toplama", got ? "tamam" : "bekle bitti", `pearl=${E.pearls(bot)}`);
  return got;
}

async function settlePending(bot, pending) {
  const retryDeadline = Date.now() + 8000;
  for (let i = pending.length - 1; i >= 0; i--) {
    const trade = pending[i];
    const now = Date.now();
    const drop = trade.id != null ? bot.entities[trade.id] : nearestGoldDrop(bot, trade.position);
    if (drop && trade.id == null) trade.id = drop.id;
    if (drop && now - trade.at >= 7000) {
      A.dbg("Takas: 7 sn sonra külçe hâlâ yerde", trade.id, "yeniden topluyorum");
      // Sunucu cevap vermediğinde openWindow/collectDrops uzun süre bloklanabiliyor.
      // Bu kurtarma denemesi toplamda sekiz saniyeyi geçmesin; pencere açık kalırsa
      // sonraki normal atışta yeniden kapatılır.
      try {
        const wall = await withDeadline(openWindow(bot, drop.position), retryDeadline);
        if (wall) await collectDropQuick(bot, drop, retryDeadline);
      } finally {
        const remains = trade.id != null && bot.entities[trade.id];
        if (remains) A.dbg("Takas: külçe alınamadı, 8 sn kurtarma bitti", trade.id);
        else A.dbg("Takas: külçe geri toplandı", trade.id);
        pending.splice(i, 1);
      }
    } else if (!drop && now - trade.at >= 7000) {
      // Piglin aldıysa veya sunucu drop entity'sini kaldırdıysa takas tamamlanmıştır.
      pending.splice(i, 1);
    }
  }
}

async function mineGold(bot, wantNuggets, say = () => {}, opts = {}) {
  let emptyTries = 0, walked = 0;
  const maxWalk = opts.maxWalk ?? GOLD_WALK_LIMIT;
  const tried = new Set();
  const end = Date.now() + (opts.maxMs || 240000), id = bot.registry.blocksByName.nether_gold_ore.id;
  while (Date.now() < end && walked < maxWalk && A.count(bot, "gold_nugget") < wantNuggets) {
    if (bot.health != null && bot.health <= 0) {
      A.dbg("altın: bot öldü, kazıyı durdur", H.cellOf(bot).toString(), "nugget", A.count(bot, "gold_nugget"));
      break;
    }
    const ores = bot.findBlocks({ matching: id, maxDistance: 48, count: 128 })
      .map(p => new Vec3(p.x, p.y, p.z)).filter(p => ![[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z]) => bot.blockAt(p.offset(x,y,z))?.name === "lava"))
      .filter(p => !opts.bastion || flatDistance(p, opts.bastion) <= 80)
      .filter(p => p.distanceTo(bot.entity.position) <= GOLD_ORE_RANGE)
      .filter(p => !tried.has(p.toString()))
      .sort((a,b) => {
        const score = p => p.distanceTo(bot.entity.position) + (opts.bastion ? 0.5 * flatDistance(p, opts.bastion) : 0);
        return score(a) - score(b);
      });
    const ore = ores[0];
    if (!ore) {
      if (walked >= maxWalk) break;
      // Işınlandıktan/vardıktan hemen sonra chunk'lar yüklenmemiş olabiliyor (0 cevher bulup çıkıyorduk).
      if (++emptyTries <= 5) { await A.sleep(1500); continue; }
      A.dbg("altın: cevher yok", H.cellOf(bot).toString(), "64 blokta (filtresiz)", bot.findBlocks({ matching: id, maxDistance: 64, count: 200 }).length);
      break;
    }
    const stand = goldStand(bot, ore);
    const before = bot.entity.position.clone();
    const beforeCell = H.cellOf(bot);
    const route = Math.abs(stand?.x - beforeCell.x) + Math.abs(stand?.y - beforeCell.y) + Math.abs(stand?.z - beforeCell.z);
    const dist = ore.distanceTo(before);
    if (!stand || route + walked > maxWalk) {
      tried.add(ore.toString());
      A.dbg("altın: cevher", ore.toString(), "bot", H.cellOf(bot).toString(), `highway=atlandı(${!stand ? "güvenli duruş yok" : "yürüme limiti"})`, "nugget", A.count(bot, "gold_nugget"));
      continue;
    }
    A.dbg("altın: cevher", ore.toString(), "bot", H.cellOf(bot).toString(), `mesafe=${dist.toFixed(1)}`, "highway=başlıyor", "nugget", A.count(bot, "gold_nugget"));
    const r = await H.highway(bot, stand, { enclosed: true, range: 0, maxMs: Math.min(60000, end-Date.now()) });
    // Otoyol düz çizgiden değil, hücre hücre (Manhattan) yürür; limiti
    // iyimser Öklid mesafesiyle aşmamayı garanti etmek için planlanan rotayı
    // say. Başarısız/yarım rota da bütçeyi tüketir.
    walked += route;
    tried.add(ore.toString());
    A.dbg("altın: cevher", ore.toString(), "bot", H.cellOf(bot).toString(), "highway", r, "nugget", A.count(bot, "gold_nugget"), `yürüme=${walked.toFixed(1)}/${maxWalk}`);
    if (r !== "arrived") {
      if (bot.health != null && bot.health <= 0) break;
      continue;
    }
    const b = bot.blockAt(ore); if (!b || b.name !== "nether_gold_ore") continue;
    try { await A.withHand(bot, async () => { const {item}=A.fastestTool(bot,b); if(item) await bot.equip(item,"hand"); await bot.dig(b,true); }); } catch (_) { continue; }
    await A.sleep(500); await A.collectDrops(bot, bot.entity.position, 4);
    A.dbg("altın: cevher", ore.toString(), "bot", H.cellOf(bot).toString(), "highway=kazıldı", "nugget", A.count(bot, "gold_nugget"));
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
  const start=A.count(bot,"gold_ingot"); let pending=[], last=Date.now(), lastPiglin=Date.now();
  while(Date.now()-t0<maxMs && E.pearls(bot)<needPearls && A.count(bot,"gold_ingot")>0) {
    await collectNearbyPearl(bot);
    const me=bot.entity.position;
    await settlePending(bot, pending);
    const piglins=piglinsNear(bot, 12);
    logPiglins(bot, piglins);
    if (piglins.length) lastPiglin=Date.now();
    if (!piglins.length && target && Date.now()-lastPiglin >= 15000) {
      A.dbg("Takas: 15 sn piglin yok, yeniden yaklaşıyorum", H.cellOf(bot).toString());
      const retryMs=Math.min(60000,Math.max(1000,maxMs-(Date.now()-t0)));
      if (!(await reachPiglins(bot,target,retryMs))) break;
      lastPiglin=Date.now();
      continue;
    }
    const brutes=Object.values(bot.entities).filter(e=>["piglin_brute","hoglin"].includes(e.name)&&e.position.distanceTo(me)<6);
    const closePiglins=piglinsNear(bot,4);
    if(pending.length<3&&closePiglins.length) {
      const p=closePiglins.find(e=>!pending.some(x=>x.piglin===e.id));
      if(p){
        const wall=await openWindow(bot,p.position);
        const stillNear=piglinsNear(bot,4).find(e=>e.id===p.id);
        // Zemin şartı çok katıydı (bastionda piglinler hep 1-5 blok farklı yükseklikte: hiç atış yapılmadı).
        // Yeter ki 3 blok yükseklik farkı içinde olsun; piglin altını aşağıya inip alabilir.
        const ground=stillNear && Math.abs(stillNear.position.y-bot.entity.position.y)<=3;
        if(wall && stillNear && ground) {
          // Yukarı doğru at: dibimize düşen külçeyi 2 sn sonra kendimiz geri topluyorduk (ölçüldü: 78 atış, 0 takas).
          { const e=bot.entity.position.offset(0,1.62,0); const v=p.position.minus(bot.entity.position); const n=Math.hypot(v.x,v.z)||1;
            await bot.lookAt(e.offset(v.x/n*3,1.6,v.z/n*3),true); }
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
        } else A.dbg("Takas: külçe atılmadı", p.id, `4blok=${Boolean(stillNear)}`, `zemin=${Boolean(ground)}`);
        await closeWindow(bot,wall);
      }
    } else if (piglins.length && !closePiglins.length && target) {
      A.dbg("Takas: 4 blokta piglin yok, yeniden yaklaşıyorum", H.cellOf(bot).toString());
      const retryMs=Math.min(30000,Math.max(1000,maxMs-(Date.now()-t0)));
      if (!(await reachPiglins(bot,target,retryMs))) break;
      lastPiglin=Date.now();
      continue;
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
