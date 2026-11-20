"use strict";

const A = require("./actions");
const H = require("./highway");
const E = require("./pearl");
const C = require("./combat");
const { Vec3 } = require("vec3");
const { goals: { GoalNear, GoalNearXZ } } = require("mineflayer-pathfinder");

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

async function approachTradePiglin(bot, cluster, maxMs) {
  const p = cluster?.piglin;
  if (!p) return false;
  if (p.position.distanceTo(bot.entity.position) <= 4) return true;
  const dest = { x: Math.round(p.position.x), y: Math.round(p.position.y), z: Math.round(p.position.z) };
  A.dbg("Takas: 4 blok içine yaklaşıyorum", `piglin=${p.id}`, `hedef=${dest.x},${dest.y},${dest.z}`, H.cellOf(bot).toString());
  let result = "not-started";
  try {
    result = await A.goto(bot, new GoalNear(dest.x, dest.y, dest.z, 3), Math.min(15000, Math.max(1000, maxMs)));
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
        // inmek gerekir; son yaklaşım açık zeminde pathfinder ile yapılır.
        const d = Math.hypot(dest.x - H.cellOf(bot).x, dest.z - H.cellOf(bot).z);
        if (d <= 30 && Date.now() < deadline) {
          result = await A.goto(bot, new GoalNear(dest.x, dest.y, dest.z, 3), Math.min(15000, remaining()));
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
        result = await A.goto(bot, new GoalNear(fallback.x, fallback.y, fallback.z, 10), Math.min(15000, remaining()));
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

function walkableTradePiglins(bot, range = 48) {
  const me = bot.entity.position;
  const myY = Math.floor(me.y);
  return Object.values(bot.entities)
    .filter(e => e.name === "piglin" && e.position && e.position.distanceTo(me) <= range)
    .filter(e => Math.abs(Math.floor(e.position.y) - myY) <= 2)
    .filter(e => {
      const c = new Vec3(Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z));
      const feet = bot.blockAt(c), head = bot.blockAt(c.offset(0, 1, 0)), floor = bot.blockAt(c.offset(0, -1, 0));
      return blockIsOpen(feet) && blockIsOpen(head) && floor && floor.boundingBox === "block" && floor.name !== "lava";
    })
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

function tradeDanger(bot) {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter(e => ["piglin_brute", "hoglin"].includes(e.name) && e.position.distanceTo(me) <= 12)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null;
}

async function retreatTrade(bot, danger) {
  const me = bot.entity.position;
  let dx = me.x - danger.position.x, dz = me.z - danger.position.z;
  const d = Math.hypot(dx, dz);
  if (!d) { dx = 1; dz = 0; }
  const len = d || 1;
  dx /= len; dz /= len;
  const dest = { x: Math.round(me.x + dx * 20), z: Math.round(me.z + dz * 20) };
  A.dbg("Takas: tehlikeden 20 blok kaçıyorum", danger.name, `hedef=${dest.x},${dest.z}`, H.cellOf(bot).toString());
  const result = await A.goto(bot, new GoalNearXZ(dest.x, dest.z, 2), 15000);
  A.dbg("Takas: tehlikeden kaçış", result ? "tamam" : "başarısız", H.cellOf(bot).toString());
  return result;
}

async function recoverTradeHealth(bot, deadline) {
  A.dbg("Takas: can düşük, durup yiyorum", `can=${bot.health.toFixed(1)}`, H.cellOf(bot).toString());
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  let noFood = 0;
  while (bot.health < 10 && Date.now() < deadline) {
    if (bot.food < 20 && C.foodCount(bot) > 0) {
      if (await C.eat(bot)) A.dbg("Takas: yemek yendi", `can=${bot.health.toFixed(1)}`);
      else if (++noFood >= 3) break;
    } else {
      await A.sleep(500);
    }
  }
  A.dbg("Takas: can kontrolü", `can=${bot.health.toFixed(1)}`);
  return bot.health >= 10;
}

async function collectTradePearl(bot) {
  const pearl = drops(bot, "ender_pearl")
    .filter(e => e.position.distanceTo(bot.entity.position) <= 6)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  if (!pearl || tradeDanger(bot)) return false;
  A.dbg("Takas: pearl yürüyüşü", pearl.id, pearl.position.toString(), H.cellOf(bot).toString());
  const result = await A.goto(bot, new GoalNear(pearl.position.x, pearl.position.y, pearl.position.z, 1), 8000);
  if (result && bot.entities[pearl.id]) await A.collectDrops(bot, pearl.position, 1.5);
  A.dbg("Takas: pearl toplandı", !bot.entities[pearl.id], `pearl=${E.pearls(bot)}`);
  return !bot.entities[pearl.id];
}

async function approachOpenTradePiglin(bot, piglin) {
  const p = bot.entities[piglin.id] || piglin;
  if (!p || !p.position) return false;
  A.dbg("Takas: açık zeminde pigline yaklaşıyorum", `piglin=${p.id}`, p.position.toString(), H.cellOf(bot).toString());
  const dest = p.position;
  const result = await A.goto(bot, new GoalNear(dest.x, dest.y, dest.z, 3), 15000);
  const now = bot.entities[piglin.id] || p;
  const near = Boolean(now && now.position && now.position.distanceTo(bot.entity.position) <= 3.5);
  A.dbg("Takas: piglin yaklaşımı", result && near ? "tamam" : "başarısız", `piglin=${piglin.id}`, H.cellOf(bot).toString());
  return result && near;
}

async function throwTradeGold(bot, piglin) {
  const p = bot.entities[piglin.id] || piglin;
  const item = bot.inventory.items().find(i => i.name === "gold_ingot");
  if (!p || !item) return null;
  await bot.lookAt(p.position.offset(0, 0.3, 0), true);
  const before = A.count(bot, "gold_ingot");
  const beforeDrops = new Set(drops(bot, "gold_ingot").map(e => e.id));
  await bot.toss(item.type, null, 1);
  await A.sleep(250);
  const after = A.count(bot, "gold_ingot");
  const drop = drops(bot, "gold_ingot").find(e => !beforeDrops.has(e.id));
  A.dbg("Takas: külçe atışı", `önce=${before}`, `sonra=${after}`, `piglin=${piglin.id}`, drop ? `drop=${drop.id}` : "drop=?");
  if (after >= before && !drop) return null;
  return { id: drop?.id ?? null, piglin: piglin.id, at: Date.now(), position: drop?.position?.clone?.() || bot.entity.position.clone() };
}

async function retreatAfterTrade(bot, piglin) {
  const p = bot.entities[piglin.id] || piglin;
  if (!p?.position) return;
  const me = bot.entity.position;
  let dx = me.x - p.position.x, dz = me.z - p.position.z;
  const d = Math.hypot(dx, dz);
  if (!d) { dx = 1; dz = 0; }
  const len = d || 1;
  const dest = { x: Math.round(me.x + dx / len * 2), z: Math.round(me.z + dz / len * 2) };
  A.dbg("Takas: atış sonrası 2 blok geri çekiliyorum", `piglin=${piglin.id}`, `hedef=${dest.x},${dest.z}`);
  const result = await A.goto(bot, new GoalNearXZ(dest.x, dest.z, 0.5), 5000);
  A.dbg("Takas: geri çekilme", result ? "tamam" : "başarısız", H.cellOf(bot).toString());
}

function updateTradeAttempts(bot, attempts, failed, onTaken = () => {}) {
  const now = Date.now();
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (a.id == null || !bot.entities[a.id]) {
      A.dbg("Takas: piglin külçeyi aldı", `piglin=${a.piglin}`, `bekleme=${now - a.at}ms`);
      onTaken();
      attempts.splice(i, 1);
    } else if (now - a.at >= 12000) {
      failed.add(a.piglin);
      A.dbg("Takas: piglin külçeyi 12 sn içinde almadı", `piglin=${a.piglin}`);
      attempts.splice(i, 1);
    }
  }
}

async function barter(bot, needPearls, say = () => {}, opts = {}) {
  const t0=Date.now(), maxMs=opts.maxMs||360000, target=opts.bastion;
  if (target) {
    const travelMs = Math.min(180000, Math.max(1000, maxMs - (Date.now() - t0)));
    if (!(await reachPiglins(bot, target, travelMs))) {
      return {pearls:E.pearls(bot),ingotsUsed:0,ms:Date.now()-t0};
    }
  }
  const deadline=t0+maxMs, start=A.count(bot,"gold_ingot");
  const attempts=[], failed=new Set();
  let lastPiglin=Date.now(), last=Date.now(), lastAccepted=0;
  const hasNearbyPearl=()=>drops(bot,"ender_pearl").some(e=>e.position.distanceTo(bot.entity.position)<=6);
  const accepted=()=>{lastAccepted=Date.now();};

  while (Date.now()<deadline && E.pearls(bot)<needPearls &&
    (A.count(bot,"gold_ingot")>0 || attempts.length || hasNearbyPearl() ||
      (lastAccepted && Date.now()-lastAccepted<10000))) {
    if (bot.health<10 && !(await recoverTradeHealth(bot, deadline))) break;
    updateTradeAttempts(bot, attempts, failed, accepted);

    const danger=tradeDanger(bot);
    if (danger) {
      await retreatTrade(bot,danger);
      lastPiglin=Date.now();
      continue;
    }
    await collectTradePearl(bot);
    if (E.pearls(bot)>=needPearls) break;

    let candidates=walkableTradePiglins(bot).filter(p =>
      !failed.has(p.id) && !attempts.some(a=>a.piglin===p.id));
    if (candidates.length) lastPiglin=Date.now();
    if (!candidates.length) {
      if (target && Date.now()-lastPiglin>=15000) {
        A.dbg("Takas: 15 sn uygun piglin yok, yeniden yaklaşıyorum", H.cellOf(bot).toString());
        const retryMs=Math.min(60000,Math.max(1000,deadline-Date.now()));
        if (!(await reachPiglins(bot,target,retryMs))) break;
        lastPiglin=Date.now();
        continue;
      }
      await A.sleep(250);
      continue;
    }

    while (attempts.length<3 && A.count(bot,"gold_ingot")>0 && Date.now()<deadline) {
      if (bot.health<10 && !(await recoverTradeHealth(bot, deadline))) break;
      const dangerNow=tradeDanger(bot);
      if (dangerNow) { await retreatTrade(bot,dangerNow); break; }
      candidates=walkableTradePiglins(bot).filter(p =>
        !failed.has(p.id) && !attempts.some(a=>a.piglin===p.id));
      const p=candidates[0];
      if (!p) break;
      if (!(await approachOpenTradePiglin(bot,p))) {
        failed.add(p.id);
        A.dbg("Takas: pigline yaklaşamadım, tekrar denemiyorum", `piglin=${p.id}`);
        continue;
      }
      const current=bot.entities[p.id]||p;
      if (tradeDanger(bot) || !current.position || current.position.distanceTo(bot.entity.position)>3.5) continue;
      const attempt=await throwTradeGold(bot,current);
      if (!attempt) { failed.add(p.id); continue; }
      attempts.push(attempt);
      await retreatAfterTrade(bot,current);
    }

    updateTradeAttempts(bot, attempts, failed, accepted);
    if (Date.now()-last>=10000) {
      last=Date.now();
      A.dbg(`Takas: ${E.pearls(bot)} pearl, ${A.count(bot,"gold_ingot")} külçe, ${attempts.length} bekleyen, ${walkableTradePiglins(bot).length} uygun piglin`);
    }
    await A.sleep(250);
  }

  // Son atışların vanilla'daki yaklaşık 6-10 saniyelik cevabını ve yerdeki
  // pearl'leri bekle; altını geri toplamaya çalışma.
  while ((attempts.length || (lastAccepted && Date.now()-lastAccepted<10000) || hasNearbyPearl()) &&
    Date.now()<deadline && E.pearls(bot)<needPearls) {
    if (bot.health<10 && !(await recoverTradeHealth(bot, deadline))) break;
    if (!tradeDanger(bot)) await collectTradePearl(bot);
    updateTradeAttempts(bot, attempts, failed, accepted);
    if (attempts.length || (lastAccepted && Date.now()-lastAccepted<10000)) await A.sleep(250);
  }
  return {pearls:E.pearls(bot),ingotsUsed:start-A.count(bot,"gold_ingot"),ms:Date.now()-t0};
}

module.exports={mineGold,barter,neededEyes,ingotsFromNuggets};
