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

function visibleTradePiglins(bot, range = 96) {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter(e => e.name === "piglin" && e.position && e.position.distanceTo(me) <= range);
}

function tradeMobNear(bot, position, range = 16) {
  return Object.values(bot.entities).some(e =>
    ["piglin_brute", "hoglin"].includes(e.name) && e.position && e.position.distanceTo(position) <= range);
}

const blockIsOpen = (b) => Boolean(b && b.boundingBox !== "block" && b.name !== "lava" && b.name !== "fire" && b.name !== "soul_fire");
const flatDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const GOLD_WALK_LIMIT = 400; // 96 ile 13 külçede kalıyordu; takas için ~30 lazım
const GOLD_ORE_RANGE = 40; // 24'te çölde 200 cevher varken 'cevher yok' diyordu
const FORTRESS_BLOCKS = new Set(["nether_bricks", "nether_brick_fence", "nether_brick_stairs"]);
const GOLD_DANGERS = new Set(["blaze", "ghast", "skeleton", "wither_skeleton", "hoglin", "piglin_brute"]);

function fortressNear(bot, p, radius = 4) {
  for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (FORTRESS_BLOCKS.has(bot.blockAt(p.offset(dx, dy, dz))?.name)) return true;
    }
  }
  return false;
}

function goldDanger(bot, range = 16) {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter(e => GOLD_DANGERS.has(e.name) && e.position && e.position.distanceTo(me) <= range)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null;
}

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

function visiblePiglinCluster(bot, accept = () => true) {
  const me = bot.entity.position;
  const visible = visibleTradePiglins(bot)
    .filter(p => !tradeMobNear(bot, p.position, 16))
    .filter(accept);
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
  // Tek piglin de seri takas yapabilir; iki entity beklemek güvenli alanın
  // kenarında gereksiz yere erişim zaman aşımına yol açıyordu.
  const nearEnough = () => piglinsNear(bot, 12).length >= 1;
  const remaining = () => Math.max(1000, deadline - Date.now());
  let fallbackRetryAt = 0;
  const searchOrigin = H.cellOf(bot);
  const searchY = searchOrigin.y;
  const searchPoints = [
    { x: searchOrigin.x + 40, z: searchOrigin.z },
    { x: searchOrigin.x, z: searchOrigin.z + 40 },
    { x: searchOrigin.x - 40, z: searchOrigin.z },
    { x: searchOrigin.x, z: searchOrigin.z - 40 },
  ];
  let searchIndex = 0;

  // longHaul'ın planladığı 40 blokluk parçalar yüksekten piglin katına
  // inerken tek bir tıkanmada dakikalarca bekleyebiliyor. Kısa, kapalı
  // parçalarla ilerle; y farkı büyükse her parça aynı anda bir merdiven basamağı
  // indirir ve son parça doğrudan targetY'ye varır.
  const shortTradeHighway = async (targetXZ, targetY, budget) => {
    const end = Date.now() + budget;
    let last = H.cellOf(bot);
    for (let i = 0; i < 24 && Date.now() < end; i++) {
      const cur = H.cellOf(bot);
      const rx = targetXZ.x - cur.x, rz = targetXZ.z - cur.z;
      const flat = Math.hypot(rx, rz);
      const yGap = targetY - cur.y;
      // Son birkaç blokta açık zemin yaklaşımına geçeceğiz; aksi halde 8
      // blokluk minimum merdiven adımı hedefi aşıp ileri-geri salınabilir.
      if (flat <= 8 && Math.abs(yGap) <= 8) return "arrived";

      const wanted = Math.max(8, Math.min(24, Math.max(flat, Math.abs(yGap))));
      const len = Math.max(1, wanted);
      const n = flat || 1;
      let x = Math.round(cur.x + (flat ? rx / n : 1) * len);
      let z = Math.round(cur.z + (flat ? rz / n : 0) * len);
      if (x === cur.x && z === cur.z) x++;
      const dy = Math.sign(yGap) * Math.min(Math.abs(yGap), Math.floor(len));
      const dest = { x, y: cur.y + dy, z };
      const threat = tradeDanger(bot);
      if (threat) {
        await retreatTrade(bot, threat);
        return "threat";
      }
      A.dbg("Takas: kısa güvenli yol", `hedef=${dest.x},${dest.y},${dest.z}`, `targetY=${targetY}`, H.cellOf(bot).toString());
      let result;
      try {
        result = await H.highway(bot, dest, {
          enclosed: true,
          descendEarly: true,
          range: 0,
          maxMs: Math.min(15000, Math.max(1000, end - Date.now())),
          onTick: async () => {
            const danger = tradeDanger(bot);
            if (danger) throw new Error(`trade-threat:${danger.name}`);
          },
        });
      } catch (err) {
        A.dbg("Takas: kısa güvenli yol hatası", err.message, H.cellOf(bot).toString());
        const danger = tradeDanger(bot);
        if (danger) await retreatTrade(bot, danger);
        return danger ? "threat" : "error";
      }
      A.dbg("Takas: kısa güvenli yol sonucu", result, `targetY=${targetY}`, H.cellOf(bot).toString());
      if (result !== "arrived" && result !== "until") return result;
      const now = H.cellOf(bot);
      if (now.equals(last)) return "blocked";
      last = now;
    }
    return "timeout";
  };

  while (Date.now() < deadline) {
    const threat = tradeDanger(bot);
    if (threat) {
      await retreatTrade(bot, threat);
      continue;
    }
    if (nearEnough() && await ensureTradeRange(bot, Math.min(30000, remaining()))) {
      A.dbg("Takas: piglin bölgesine varıldı", "until", H.cellOf(bot).toString());
      return true;
    }

    // Bilinen güvenli Nether çölü gibi açıkça verilen bir ticaret alanı varsa,
    // yüklenmiş chunk'lardaki uzak/yüksek bir piglin kümesine kapılma. Önce
    // hedef bölgeye kapalı tünelle ulaş; oradaki entity'ler sonra seçilir.
    if (target && flatDistance(bot.entity.position, target) > 8) {
      const dest = { x: target.x, z: target.z };
      const targetY = target.y ?? searchY;
      logPiglinTarget(bot, "bilinen ticaret alanı", { x: dest.x, y: targetY, z: dest.z });
      let result = "not-started";
      try {
        result = await shortTradeHighway(dest, targetY, Math.min(60000, remaining()));
      } catch (err) {
        A.dbg("Takas: bilinen alana yol hatası", err.message);
      }
      A.dbg("Takas: bilinen alan sonucu", result, H.cellOf(bot).toString());
      if (result === "no-blocks") return false;
      if (nearEnough() && await ensureTradeRange(bot, Math.min(30000, remaining()))) return true;
      await A.sleep(Math.min(500, remaining()));
      continue;
    }

    // Hedef alanın chunk'ı yüklendiğinde oradaki kümeyi seç. Orada piglin
    // yoksa, aynı kotta görünen güvenli kümeye kontrollü fallback yap; eski
    // davranış uzak ama yüksek kümeye saplanıp üç dakikayı tüketiyordu.
    const localCluster = target
      ? visiblePiglinCluster(bot, p => flatDistance(p.position, target) <= 32)
      : null;
    const sameLevelCluster = target
      ? visiblePiglinCluster(bot, p => Math.abs(p.position.y - bot.entity.position.y) <= 14)
      : null;
    const safeFallbackCluster = target ? visiblePiglinCluster(bot) : null;
    const cluster = localCluster || sameLevelCluster || safeFallbackCluster || (!target ? visiblePiglinCluster(bot) : null);
    if (target && !localCluster && sameLevelCluster) {
      A.dbg("Takas: aynı kotta güvenli piglin fallback", `mesafe=${flatDistance(sameLevelCluster.piglin.position, bot.entity.position).toFixed(1)}`);
    }
    if (target && !localCluster && !sameLevelCluster && safeFallbackCluster) {
      A.dbg("Takas: uzak ama güvenli piglin fallback", `mesafe=${flatDistance(safeFallbackCluster.piglin.position, bot.entity.position).toFixed(1)}`, `y=${Math.round(safeFallbackCluster.piglin.position.y)}`);
    }
    if (cluster) {
      fallbackRetryAt = 0;
      const p = cluster.piglin.position;
      const piglinY = Math.round(p.y);
      const dest = { x: Math.round(p.x), y: piglinY, z: Math.round(p.z) };
      logPiglinTarget(bot, "görünen küme", dest, cluster);
      let result;
      try {
        const cur = H.cellOf(bot);
        if (cur.y >= piglinY + 8) {
          A.dbg("Takas: piglin seviyesine erken iniyorum", `şimdiY=${cur.y}`, `hedefY=${piglinY}`, H.cellOf(bot).toString());
        }
        result = await shortTradeHighway({ x: dest.x, z: dest.z }, piglinY, Math.min(60000, remaining()));
        A.dbg("Takas: piglin kısa yolu", result, `hedefY=${piglinY}`, H.cellOf(bot).toString());
        if (nearEnough() && await ensureTradeRange(bot, Math.min(30000, remaining()))) return true;

        // Otoyol son hücreye güvenli tünelle geldikten sonra açık zemindeki
        // son birkaç bloğu pathfinder'a bırak; piglinin gerçek katına inmişizdir.
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

    // Bastion hedefi olmayan Nether'da piglinler çevredeki açık çölde
    // görünür. Önce kümeyi denedik; hiç görünmüyorsa başlangıç noktasının dört
    // yönündeki 40 blokluk kapalı otoyol noktalarını sırayla tarıyoruz.
    if (!target) {
      const point = searchPoints[searchIndex++ % searchPoints.length];
      const scan = { x: point.x, y: searchY, z: point.z };
      logPiglinTarget(bot, "hedef yok, çevre taraması", scan);
      let result = "not-started";
      try {
        result = await shortTradeHighway(point, searchY, Math.min(20000, remaining()));
      } catch (err) {
        A.dbg("Takas: çevre tarama yolunda hata", err.message);
      }
      A.dbg("Takas: çevre tarama sonucu", result, H.cellOf(bot).toString());
      if (nearEnough() && await ensureTradeRange(bot, Math.min(30000, remaining()))) return true;
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
    const fallback = { x: target.x, y: target.y ?? 60, z: target.z };
    logPiglinTarget(bot, "piglin görünmüyor, bastion taraması", fallback);
    let result = "not-started";
    try {
      result = await shortTradeHighway({ x: target.x, z: target.z }, fallback.y, Math.min(20000, remaining()));
      if (!nearEnough() && Math.hypot(target.x - H.cellOf(bot).x, target.z - H.cellOf(bot).z) <= 30 && Date.now() < deadline) {
        result = await A.goto(bot, new GoalNear(fallback.x, fallback.y, fallback.z, 10), Math.min(15000, remaining()));
      }
    } catch (err) {
      A.dbg("Takas: bastion tarama yolunda hata", err.message);
    }
    A.dbg("Takas: bastion tarama sonucu", result, H.cellOf(bot).toString());
    if (result === "no-blocks") return false;
    fallbackRetryAt = Date.now() + 20000;
    if (nearEnough() && await ensureTradeRange(bot, Math.min(30000, remaining()))) return true;
    await A.sleep(Math.min(500, remaining()));
  }

  const piglins = piglinsNear(bot, 12);
  A.dbg("Takas: piglin bölgesine varılamadı", "timeout",
    `konum=${H.cellOf(bot).toString()}`, `yakın=${piglins.length}`, "pearl 0");
  return false;
}

async function wearGoldBoots(bot) {
  try {
    const tb = await A.ensureTable(bot);
    for (let k = 0; k < 4 && A.count(bot, "gold_ingot") < 4 && A.count(bot, "gold_nugget") >= 9; k++) await A.craft(bot, "gold_ingot", 1, tb);
    if (A.count(bot, "gold_ingot") >= 4) await A.craft(bot, "golden_boots", 1, tb);
    const boots = bot.inventory.items().find((i) => i.name === "golden_boots");
    if (boots) { await bot.equip(boots, "feet"); A.dbg("altın: altın bot giyildi"); }
    // Madencilik sırasında masa geride kalırsa, aşama sonunda yeni masa için
    // kütük arayıp koşuyu düşürmesin. Geçici olarak koyduğumuz masayı geri al.
    const placed = bot.blockAt(tb.position);
    if (placed?.name === "crafting_table" && A.count(bot, "crafting_table") === 0) {
      await A.withHand(bot, async () => bot.dig(placed, true));
      await A.sleep(250);
      await A.collectDrops(bot, placed.position, 2);
      A.dbg("altın: crafting table envantere alındı");
    }
  } catch (err) { A.dbg("altın bot yapılamadı:", err.message); }
}

async function mineGold(bot, wantNuggets, say = () => {}, opts = {}) {
  let emptyTries = 0, walked = 0;
  const maxWalk = opts.maxWalk ?? GOLD_WALK_LIMIT;
  const tried = new Set();
  const end = Date.now() + (opts.maxMs || 240000), id = bot.registry.blocksByName.nether_gold_ore.id;
  const targetY = opts.targetY ?? 70;
  while (Date.now() < end && walked < maxWalk && A.count(bot, "gold_nugget") < wantNuggets) {
    if (bot.health != null && bot.health <= 0) {
      A.dbg("altın: bot öldü, kazıyı durdur", H.cellOf(bot).toString(), "nugget", A.count(bot, "gold_nugget"));
      break;
    }
    // Elle kazılan nether altın cevheri hiçbir şey düşürmüyor; son kazmayı da kale için sakla.
    if (bot.inventory.items().filter(i => i.name.endsWith("_pickaxe")).length <= 1) {
      A.dbg("altın: son kazma kaldı, kazıyı bırakıyorum", "nugget", A.count(bot, "gold_nugget"));
      break;
    }
    const danger = goldDanger(bot);
    if (danger) {
      A.dbg("altın: düşmandan kaçıyorum", danger.name, H.cellOf(bot).toString());
      const me = bot.entity.position, d = danger.position.distanceTo(me) || 1;
      await A.goto(bot, new GoalNearXZ(Math.round(me.x + (me.x - danger.position.x) / d * 20), Math.round(me.z + (me.z - danger.position.z) / d * 20)), 10000);
      continue;
    }
    const ores = bot.findBlocks({ matching: id, maxDistance: 48, count: 128 })
      .map(p => new Vec3(p.x, p.y, p.z)).filter(p => ![[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z]) => bot.blockAt(p.offset(x,y,z))?.name === "lava"))
      .filter(p => !opts.bastion || flatDistance(p, opts.bastion) <= 80)
      .filter(p => Math.abs(p.y - bot.entity.position.y) <= 12 && (!opts.bastion || Math.abs(p.y - targetY) <= 12)) // Y hedefi sadece bastion'da
      // Piglin görürken altın cevheri kazınca piglinler (altın botla bile) saldırıyor (öldük):
      // 18 blok içinde piglin/brute olan cevheri alma.
      .filter(p => !Object.values(bot.entities).some(e => /^piglin/.test(e.name || "") && e.position.distanceTo(p) < 18))
      .filter(p => !fortressNear(bot, p))
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
    let r = "error";
    try {
      r = await H.highway(bot, stand, {
        enclosed: true,
        range: 0,
        maxMs: Math.min(60000, end-Date.now()),
        onTick: async () => {
          const danger = goldDanger(bot);
          if (danger) throw new Error(`gold-danger:${danger.name}`);
        },
      });
    } catch (err) {
      const danger = goldDanger(bot);
      if (danger) {
        A.dbg("altın: yol sırasında düşman, cevher atlandı", danger.name, H.cellOf(bot).toString());
        const me = bot.entity.position, d = danger.position.distanceTo(me) || 1;
        await A.goto(bot, new GoalNearXZ(Math.round(me.x + (me.x - danger.position.x) / d * 20), Math.round(me.z + (me.z - danger.position.z) / d * 20)), 10000);
        r = "danger";
      } else {
        A.dbg("altın: yol hatası", err.message, H.cellOf(bot).toString());
      }
    }
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
    // Altın zırh yoksa piglinler saldırıyor (kazarken öldük): 36 parçacık olunca hemen altın bot.
    if (!C.wearsGold(bot) && A.count(bot, "gold_nugget") >= 36) await wearGoldBoots(bot);
  }
  A.dbg("altın: kazma bitti", `bot=${H.cellOf(bot).toString()}`, `konum=${bot.entity.position.toString()}`, "nugget", A.count(bot, "gold_nugget"));
  return A.count(bot,"gold_nugget");
}

function walkableTradePiglins(bot, range = 48) {
  const me = bot.entity.position;
  const myY = Math.floor(me.y);
  return Object.values(bot.entities)
    .filter(e => e.name === "piglin" && e.position && e.position.distanceTo(me) <= range)
    .filter(e => !tradeMobNear(bot, e.position, 16))
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
  const ranged = new Set(["skeleton", "wither_skeleton"]);
  const melee = new Set(["piglin_brute", "hoglin"]);
  return Object.values(bot.entities)
    .filter(e => e.position && (
      melee.has(e.name) ? e.position.distanceTo(me) <= 12 :
      ranged.has(e.name) ? e.position.distanceTo(me) <= 8 :
      // Blaze görüyorsa 20 blokta kaç. Ghast'tan kaçmak işe yaramıyor (64 bloktan atıyor, kaçarken piglinlerden uzaklaşıp parkur yapıyordu).
      e.name === "blaze" && e.position.distanceTo(me) <= 20 && seesFrom(bot, e)))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || fireNear(bot);
}
function seesFrom(bot, e) {
  if (!bot.world?.raycast) return true;
  const eye = bot.entity.position.offset(0, 1.62, 0), to = e.position.offset(0, (e.height || 1.8) * 0.8, 0);
  const d = to.minus(eye), len = d.norm();
  return !len || !bot.world.raycast(eye, d.scaled(1 / len), len, b => b && b.boundingBox === "block");
}
// Yanımızda ateş (blaze topu yaktı) varsa oradan uzaklaş.
function fireNear(bot) {
  const me = bot.entity.position.floored();
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    const b = bot.blockAt(me.offset(x, y, z));
    if (b && (b.name === "fire" || b.name === "soul_fire")) return { name: "ateş", position: b.position.offset(0.5, 0, 0.5) };
  }
  return null;
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
  const gold = drops(bot, "gold_ingot");
  const pearl = drops(bot, "ender_pearl")
    .filter(e => e.position.distanceTo(bot.entity.position) <= 6)
    .filter(e => gold.every(g => e.position.distanceTo(g.position) >= 1.5))
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

async function throwTradeGold(bot, piglin, waitMode = false) {
  const p = bot.entities[piglin.id] || piglin;
  const item = bot.inventory.items().find(i => i.name === "gold_ingot");
  if (!p || !item) return null;
  // Piglinin ayaklarına nişanlamak külçeyi duvara/ayağa bırakabiliyor. Vanilla
  // oyuncu testinde çalışan geometri: botun baktığı yatay yönde yaklaşık iki
  // blok ileri, göz hizası. Böylece eşya piglinin hemen önüne düşer.
  const me = bot.entity.position;
  let dx = p.position.x - me.x, dz = p.position.z - me.z;
  const flat = Math.hypot(dx, dz) || 1;
  dx /= flat; dz /= flat;
  const aim = new Vec3(me.x + dx * 2, me.y + (waitMode ? 0.2 : 1.5), me.z + dz * 2);
  await bot.lookAt(aim, true);
  const before = A.count(bot, "gold_ingot");
  const beforeDrops = new Set(drops(bot, "gold_ingot").map(e => e.id));
  await bot.toss(item.type, null, 1);
  let drop = null;
  const observeUntil = Date.now() + 900;
  while (Date.now() < observeUntil) {
    drop = drops(bot, "gold_ingot").find(e => !beforeDrops.has(e.id));
    if (drop) break;
    if (A.count(bot, "gold_ingot") < before) {
      A.dbg("Takas: külçe atışı piglin hemen aldı", `piglin=${piglin.id}`);
      return { id: null, piglin: piglin.id, at: Date.now(), position: aim };
    }
    await A.sleep(100);
  }
  const after = A.count(bot, "gold_ingot");
  A.dbg("Takas: külçe atışı", `önce=${before}`, `sonra=${after}`, `piglin=${piglin.id}`,
    `nişan=${aim.x.toFixed(1)},${aim.y.toFixed(1)},${aim.z.toFixed(1)}`,
    drop ? `drop=${drop.id}@${drop.position.toString()}` : "drop=?");
  if (after >= before && !drop) return null;
  return { id: drop?.id ?? null, piglin: piglin.id, at: Date.now(), position: drop?.position?.clone?.() || aim };
}

// Bebek piglin altını alıp hiçbir şey vermiyor. 1.21 metadata: 17 = bebek.
const isBabyPiglin = p => p.isBaby || p.metadata?.[17] === true;
function waitTradePiglins(bot, thrown, failed, attempts) {
  const me = bot.entity.position;
  const eye = me.offset(0, bot.entity.eyeHeight || 1.62, 0);
  return Object.values(bot.entities)
    // Aynı piglin tekrar takas yapabilir: kalıcı yasak yok, piglin külçeye ~6 sn bakıp verir, sonra yine aday.
    .filter(p => p.name === "piglin" && !isBabyPiglin(p) && !(Date.now() - (thrown.get(p.id) || 0) < 6000) &&
      !attempts.some(a => a.piglin === p.id) && p.position)
    .filter(p => flatDistance(p.position, me) <= 9 && Math.abs(p.position.y - me.y) <= 2)
    .filter(p => {
      if (!bot.world?.raycast) return false;
      const to = p.position.offset(0, (p.height || 1.8) * 0.85, 0);
      const d = to.minus(eye), len = d.norm();
      return len > 0 && !bot.world.raycast(eye, d.scaled(1 / len), len,
        b => b && b.boundingBox === "block");
    })
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

async function approachWaitTradePiglin(bot, piglin) {
  const p = bot.entities[piglin.id] || piglin;
  if (!p?.position) return false;
  const me = bot.entity.position;
  const dx = p.position.x - me.x, dz = p.position.z - me.z;
  const d = Math.hypot(dx, dz) || 1, len = Math.min(16, d);
  const dest = { x: me.x + dx / d * len, z: me.z + dz / d * len };
  A.dbg("Takas: bekle kısa yaklaşım", `piglin=${p.id}`, `mesafe=${d.toFixed(1)}`);
  try { await A.goto(bot, new GoalNearXZ(Math.round(dest.x), Math.round(dest.z), 3), 15000); }
  catch (err) { A.dbg("Takas: bekle kısa yaklaşım hatası", err.message); return false; }
  return true;
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
  const t0=Date.now(), maxMs=opts.maxMs||360000, target=opts.tradeTarget || opts.bastion;
  const mode = opts.mode || process.env.TAKAS_MOD || "bekle";
  const waitMode = mode !== "git";
  if (!waitMode) {
    // Kazma bütün netherrack'i yedi: kapalı yol 'no-blocks' deyip 3 dk boşa döndü. Önce blok topla.
    if (A.count(bot, H.isFiller) < 32) { const b0 = A.count(bot, H.isFiller); await H.mineTunnel(bot, 64, 50); A.dbg("Takas: blok toplandı", b0, "→", A.count(bot, H.isFiller)); }
    const travelMs = Math.min(180000, Math.max(1000, maxMs - (Date.now() - t0)));
    // bastion null olabilir: bu durumda da doğrudan çevre piglinlerini bulup yaklaş.
    if (!(await reachPiglins(bot, target, travelMs))) {
      return {pearls:E.pearls(bot),ingotsUsed:0,ms:Date.now()-t0};
    }
  }
  // Fortress dibinde iskelet/blaze/ghast öldürdü: takası en az 64 blok uzakta yap.
  const fort = opts.fortress && { x: opts.fortress[0], z: opts.fortress[1] };
  const fortDist = p => fort ? flatDistance(p, fort) : Infinity;
  if (waitMode && fortDist(bot.entity.position) < 64) {
    const me = bot.entity.position, d = fortDist(me) || 1;
    const away = { x: Math.round(fort.x + (me.x - fort.x) / d * 80), z: Math.round(fort.z + (me.z - fort.z) / d * 80) };
    A.dbg("Takas: fortress'ten uzaklaşıyorum", `mesafe=${d.toFixed(0)}`, `hedef=${away.x},${away.z}`);
    try { await A.goto(bot, new GoalNearXZ(away.x, away.z, 4), 60000); } catch (err) { A.dbg("Takas: fortress'ten uzaklaşma hatası", err.message); }
  }
  const deadline=t0+maxMs, start=A.count(bot,"gold_ingot");
  const attempts=[], failed=new Set(), thrown=new Map();
  let waitFallbackUsed=false;
  let lastPiglin=Date.now(), last=Date.now(), lastAccepted=0;
  const hasNearbyPearl=()=>drops(bot,"ender_pearl")
    .filter(e=>e.position.distanceTo(bot.entity.position)<=6)
    .some(e=>drops(bot,"gold_ingot").every(g=>e.position.distanceTo(g.position)>=1.5));
  const accepted=()=>{lastAccepted=Date.now();};
  const logTradeStatus=()=>{
    if (Date.now()-last<10000) return;
    last=Date.now();
    const visible=visibleTradePiglins(bot);
    const nearest=visible.sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0];
    A.dbg(`Takas: görünen piglin=${visible.length}`, `en yakın=${nearest ? nearest.position.distanceTo(bot.entity.position).toFixed(1) : "yok"}`, `uygun=${walkableTradePiglins(bot).length}`, `pearl=${E.pearls(bot)}`);
  };

  while (Date.now()<deadline && E.pearls(bot)<needPearls &&
    (A.count(bot,"gold_ingot")>0 || attempts.length || hasNearbyPearl() ||
      (lastAccepted && Date.now()-lastAccepted<10000))) {
    logTradeStatus();
    if (bot.health<10 && !(await recoverTradeHealth(bot, deadline))) break;
    updateTradeAttempts(bot, attempts, failed, accepted);

    const danger=tradeDanger(bot);
    if (danger && /skeleton/.test(danger.name) && danger.position.distanceTo(bot.entity.position) <= 10) {
      // Kaçış yolu bulamayınca yerinde durup ok yiyerek öldü: iskelete kılıçla git.
      A.dbg("Takas: iskelete saldırıyorum", danger.name);
      try { await C.killEntity(bot, danger, 15000); } catch (err) { A.dbg("Takas: iskelet dövüşü hatası", err.message); }
      continue;
    }
    if (danger) {
      await retreatTrade(bot,danger);
      lastPiglin=Date.now();
      continue;
    }
    await collectTradePearl(bot);
    if (E.pearls(bot)>=needPearls) break;

    let candidates=waitMode ? waitTradePiglins(bot, thrown, failed, attempts) : walkableTradePiglins(bot).filter(p =>
      !failed.has(p.id) && !attempts.some(a=>a.piglin===p.id));
    if (candidates.length) lastPiglin=Date.now();
    if (!candidates.length) {
      if (waitMode && Date.now()-lastPiglin>=15000) {
        const visible = visibleTradePiglins(bot).filter(p => !isBabyPiglin(p) && p.position && fortDist(p.position) >= 48)
          .sort((a,b) => a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position));
        if (visible.length) await approachWaitTradePiglin(bot, visible[0]);
        else if (!waitFallbackUsed) {
          waitFallbackUsed=true;
          await reachPiglins(bot, null, Math.min(60000, Math.max(1000, deadline-Date.now())));
        }
        lastPiglin=Date.now();
        continue;
      }
      if (!waitMode && Date.now()-lastPiglin>=15000) {
        A.dbg(target ? "Takas: 15 sn uygun piglin yok, yeniden yaklaşıyorum" : "Takas: 15 sn piglin yok, çevreyi yeniden arıyorum", H.cellOf(bot).toString());
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
      candidates=waitMode ? waitTradePiglins(bot, thrown, failed, attempts) : walkableTradePiglins(bot).filter(p =>
        !failed.has(p.id) && !attempts.some(a=>a.piglin===p.id));
      const p=candidates[0];
      if (!p) break;
      if (!waitMode && !(await approachOpenTradePiglin(bot,p))) {
        failed.add(p.id);
        A.dbg("Takas: pigline yaklaşamadım, tekrar denemiyorum", `piglin=${p.id}`);
        continue;
      }
      const current=bot.entities[p.id]||p;
      if (tradeDanger(bot) || !current.position || (!waitMode && current.position.distanceTo(bot.entity.position)>3.5)) continue;
      const dist=flatDistance(current.position,bot.entity.position), dy=current.position.y-bot.entity.position.y;
      const attempt=await throwTradeGold(bot,current,waitMode);
      if (!attempt) { failed.add(p.id); continue; }
      attempts.push(attempt);
      if (waitMode) {
        thrown.set(p.id, Date.now());
        A.dbg("Takas: bekle atış", `piglin=${p.id}`, `mesafe=${dist.toFixed(1)}`, `dy=${dy.toFixed(1)}`, `külçe=${A.count(bot,"gold_ingot")}`);
      } else await retreatAfterTrade(bot,current);
    }

    updateTradeAttempts(bot, attempts, failed, accepted);
    logTradeStatus();
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
