"use strict";

// Strateji: kaynak haritasından en kısa "ağaç → demir → elmas" rotasını seçer.
// Saf fonksiyonlar; Minecraft'a bağlı değil, test edilebilir.

const IRON_NEEDED = 3;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// Yaklaşık yol maliyeti: yatay yürümek ucuz, dikey kazmak/çıkmak pahalı.
function cost(a, b) {
  const h = Math.hypot(a.x - b.x, a.z - b.z);
  const dy = b.y - a.y;
  return h + (dy < 0 ? -dy * 1.6 : dy * 2.2);
}

// Birbirine değen (veya çok yakın) blokları gruplar: ağaç, damar, vs.
function clusters(points, link = 1.8) {
  const left = points.slice();
  const out = [];
  while (left.length) {
    const group = [left.pop()];
    for (let i = 0; i < group.length; i++) {
      for (let j = left.length - 1; j >= 0; j--) {
        if (dist(group[i], left[j]) <= link) group.push(left.splice(j, 1)[0]);
      }
    }
    out.push(group);
  }
  return out;
}

function center(group) {
  const n = group.length;
  return {
    x: group.reduce((s, p) => s + p.x, 0) / n,
    y: group.reduce((s, p) => s + p.y, 0) / n,
    z: group.reduce((s, p) => s + p.z, 0) / n,
  };
}

function nearestFirst(points, from) {
  return points.slice().sort((a, b) => cost(from, a) - cost(from, b));
}

// Yeterli odun için en yakın ağaç(lar)ı seç.
function pickTrees(logs, start, logsNeeded) {
  const trees = clusters(logs, 1.8).filter((t) => t.length >= 3);
  const pool = trees.length ? trees : clusters(logs, 1.8);
  const sorted = pool.sort(
    (a, b) => cost(start, center(a)) - cost(start, center(b)),
  );
  const chosen = [];
  let total = 0;
  for (const t of sorted) {
    // Gövdeyi aşağıdan yukarı kes, ulaşılabilecek yükseklikle sınırlı kal.
    const base = Math.min(...t.map((p) => p.y));
    const reachable = t
      .filter((p) => p.y <= base + 5)
      .sort((a, b) => a.y - b.y);
    chosen.push(...reachable);
    total += reachable.length;
    if (total >= logsNeeded) break;
  }
  return chosen;
}

// En az IRON_NEEDED cevher: bir damardan başla, yetmezse en yakınlarını ekle.
function ironSetFrom(seedVein, allIron) {
  const set = seedVein.slice(0, IRON_NEEDED);
  if (set.length >= IRON_NEEDED) return set;
  const c = center(seedVein);
  const rest = allIron
    .filter((p) => !set.includes(p))
    .sort((a, b) => dist(c, a) - dist(c, b));
  for (const p of rest) {
    if (set.length >= IRON_NEEDED) break;
    if (dist(c, p) > 24) break;
    set.push(p);
  }
  return set.length >= IRON_NEEDED ? set : null;
}

// Su içindeki/yanındaki cevherler: yol bulucu zorlanıyor, boğulma riski var.
const WET_PENALTY = 60;
const wetPenalty = (group) =>
  group.some((p) => p.wet) ? WET_PENALTY : 0;

function lavaPenalty(target, lava) {
  let pen = 0;
  for (const l of lava) {
    const d = dist(target, l);
    if (d < 3) pen += 40;
    else if (d < 6) pen += 8;
  }
  return Math.min(pen, 200);
}

/**
 * resources: { log:[], iron:[], diamond:[], lava:[] } (her biri {x,y,z,exposed})
 * start: {x,y,z}
 * Dönen plan: { trees, iron, diamonds, estimatedCost, reason }
 */
function makePlan(resources, start, opts = {}) {
  const logsNeeded = opts.logsNeeded || 5;
  const candidates = opts.candidates || 25;
  const logs = resources.log || [];
  const iron = resources.iron || [];
  const diamonds = resources.diamond || [];
  const lava = resources.lava || [];

  const trees = pickTrees(logs, start, logsNeeded);
  const treeEnd = trees.length ? trees[trees.length - 1] : start;

  const ironVeins = clusters(iron, 1.8);
  const ironSets = ironVeins.map((v) => ironSetFrom(v, iron)).filter(Boolean);
  const diamondVeins = clusters(diamonds, 1.8);

  let best = null;
  const dCands = nearestFirst(
    diamondVeins.map((vein) => ({ ...center(vein), vein })),
    treeEnd,
  ).slice(0, candidates);
  for (const dc of dCands) {
    const vein = dc.vein;
    const exposedBonus = vein.some((p) => p.exposed) ? 12 : 0;
    const dCost = lavaPenalty(dc, lava) - exposedBonus;
    for (const set of ironSets) {
      const ic = center(set);
      const total =
        cost(start, treeEnd) +
        cost(treeEnd, ic) +
        cost(ic, dc) +
        dCost +
        wetPenalty(set) +
        wetPenalty(vein);
      if (!best || total < best.estimatedCost) {
        best = { trees, iron: set, diamonds: vein, estimatedCost: total };
      }
    }
  }

  if (!best) {
    return {
      trees,
      iron:
        ironSets
          .slice()
          .sort(
            (a, b) => cost(treeEnd, center(a)) - cost(treeEnd, center(b)),
          )[0] || [],
      diamonds: [],
      estimatedCost: null,
      reason: diamonds.length
        ? "Uygun demir bulunamadı"
        : "Taranan alanda elmas görünmüyor; dal madenciliği (branch mining) yapılacak",
    };
  }
  best.reason = `Ağaç ${trees.length} kütük, demir ${best.iron.length} cevher, elmas damarı ${best.diamonds.length} blok`;
  return best;
}

module.exports = { makePlan, clusters, cost, dist, center, IRON_NEEDED };
