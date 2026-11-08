"use strict";

// Yüklü chunk'lardaki işe yarar blokları tarar ve bir kaynak haritası çıkarır.
// Bot, sunucunun gönderdiği chunk'ları zaten bellekte tutuyor; burada sadece
// onları kategorilere ayırıyoruz.

const CATEGORIES = {
  log: [
    "oak_log",
    "spruce_log",
    "birch_log",
    "jungle_log",
    "acacia_log",
    "cherry_log",
    "dark_oak_log",
    "pale_oak_log",
    "mangrove_log",
  ],
  iron: ["iron_ore", "deepslate_iron_ore"],
  diamond: ["diamond_ore", "deepslate_diamond_ore"],
  lava: ["lava"],
};

const LIMITS = { log: 400, iron: 400, diamond: 200, lava: 400 };

// findBlocks mesafeyi 3 boyutlu ölçer. Elmaslar derinde (y -64..16), ağaçlar
// yüzeyde olduğu için her kategoriyi kendi tipik yüksekliğinden tarıyoruz.
const SCAN_Y = { log: 70, iron: 16, diamond: -40, lava: -40 };
const VERTICAL_SLACK = 50;

function idsFor(registry, names) {
  return names
    .map((n) => registry.blocksByName[n])
    .filter(Boolean)
    .map((b) => b.id);
}

// center: Vec3, maxDistance: blok cinsinden yarıçap.
// limits: kategori başına en fazla kaç blok (seed modunda daha geniş tarıyoruz).
function scanLoaded(bot, center, maxDistance, limits = LIMITS) {
  const out = {};
  for (const [cat, names] of Object.entries(CATEGORIES)) {
    const ids = idsFor(bot.registry, names);
    const found = bot.findBlocks({
      point: center.offset(0, SCAN_Y[cat] - center.y, 0),
      matching: ids,
      maxDistance: maxDistance + VERTICAL_SLACK,
      count: limits[cat],
    });
    out[cat] = found.map((p) => {
      const b = bot.blockAt(p);
      return {
        x: p.x,
        y: p.y,
        z: p.z,
        name: b ? b.name : names[0],
        exposed: isExposed(bot, p),
        wet: cat === "log" || cat === "lava" ? false : isWet(bot, p),
      };
    });
  }
  return out;
}

// Elmasın yanında hava/mağara varsa ulaşması kolaydır.
function isExposed(bot, p) {
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (const [dx, dy, dz] of dirs) {
    const b = bot.blockAt(p.offset(dx, dy, dz));
    if (b && (b.name === "air" || b.name === "cave_air")) return true;
  }
  return false;
}

// Cevherin 2 blok çevresinde su varsa (yeraltı gölü/aquifer) ulaşmak zor ve tehlikeli.
function isWet(bot, p) {
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -1; dy <= 2; dy++)
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(p.offset(dx, dy, dz));
        if (b && b.name === "water") return true;
      }
  return false;
}

// Birden fazla taramayı birleştirir (tekrarları atar).
function mergeScans(a, b) {
  const out = {};
  for (const cat of Object.keys(CATEGORIES)) {
    const seen = new Set();
    out[cat] = [];
    for (const r of [...(a[cat] || []), ...(b[cat] || [])]) {
      const k = `${r.x},${r.y},${r.z}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out[cat].push(r);
    }
  }
  return out;
}

module.exports = { scanLoaded, mergeScans, CATEGORIES };
