"use strict";

// Kaynak haritasını ve rotayı tarayıcıda açılan tek bir HTML dosyasına çizer.

function renderHtml({ title, spawn, resources, plan }) {
  const data = JSON.stringify({ spawn, resources, plan });
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; font: 14px system-ui, sans-serif; background: #15171c; color: #e8e8e8; }
  header { padding: 12px 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .legend span { display: inline-block; margin-right: 14px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 4px; vertical-align: middle; }
  canvas { display: block; width: 100%; max-width: 900px; margin: 0 auto; background: #1f232b; }
  #info { padding: 8px 16px; color: #aab; min-height: 20px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="legend">
    <span><i class="dot" style="background:#4caf50"></i>Kütük</span>
    <span><i class="dot" style="background:#d9a066"></i>Demir</span>
    <span><i class="dot" style="background:#4dd0e1"></i>Elmas</span>
    <span><i class="dot" style="background:#ff5722"></i>Lav</span>
    <span><i class="dot" style="background:#fff"></i>Başlangıç</span>
    <span>━ Rota</span>
  </div>
  <div id="reason"></div>
</header>
<canvas id="c" width="900" height="900"></canvas>
<div id="info">Fareyi bir noktanın üstüne getir: koordinat ve yükseklik görünür.</div>
<script>
const D = ${data};
const c = document.getElementById('c'), g = c.getContext('2d');
document.getElementById('reason').textContent = D.plan ? D.plan.reason : '';
const all = [D.spawn, ...Object.values(D.resources).flat()];
const xs = all.map(p => p.x), zs = all.map(p => p.z);
const minX = Math.min(...xs) - 8, maxX = Math.max(...xs) + 8, minZ = Math.min(...zs) - 8, maxZ = Math.max(...zs) + 8;
const span = Math.max(maxX - minX, maxZ - minZ, 32);
const sx = x => (x - minX) / span * c.width, sz = z => (z - minZ) / span * c.height;
const pts = [];
function dot(p, color, r) { g.fillStyle = color; g.beginPath(); g.arc(sx(p.x), sz(p.z), r, 0, 7); g.fill(); pts.push([p, r]); }
g.strokeStyle = '#2b303a';
for (let x = Math.ceil(minX / 16) * 16; x < maxX; x += 16) { g.beginPath(); g.moveTo(sx(x), 0); g.lineTo(sx(x), c.height); g.stroke(); }
for (let z = Math.ceil(minZ / 16) * 16; z < maxZ; z += 16) { g.beginPath(); g.moveTo(0, sz(z)); g.lineTo(c.width, sz(z)); g.stroke(); }
(D.resources.lava || []).forEach(p => dot(p, 'rgba(255,87,34,.35)', 1.5));
(D.resources.log || []).forEach(p => dot(p, '#4caf50', 2));
(D.resources.iron || []).forEach(p => dot(p, '#d9a066', 2.5));
(D.resources.diamond || []).forEach(p => dot(p, '#4dd0e1', 4));
if (D.plan) {
  const route = [D.spawn, ...(D.plan.trees || []).slice(0, 1), ...(D.plan.iron || []).slice(0, 1), ...(D.plan.diamonds || []).slice(0, 1)];
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.setLineDash([6, 4]); g.beginPath();
  route.forEach((p, i) => i ? g.lineTo(sx(p.x), sz(p.z)) : g.moveTo(sx(p.x), sz(p.z))); g.stroke(); g.setLineDash([]);
  (D.plan.diamonds || []).forEach(p => { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(sx(p.x), sz(p.z), 8, 0, 7); g.stroke(); });
}
dot(D.spawn, '#fff', 6);
c.addEventListener('mousemove', e => {
  const r = c.getBoundingClientRect(), mx = (e.clientX - r.left) * c.width / r.width, my = (e.clientY - r.top) * c.height / r.height;
  const hit = pts.find(([p, rad]) => Math.hypot(sx(p.x) - mx, sz(p.z) - my) <= rad + 3);
  document.getElementById('info').textContent = hit ? (hit[0].name || 'başlangıç') + ' — x ' + Math.round(hit[0].x) + ', y ' + Math.round(hit[0].y) + ', z ' + Math.round(hit[0].z) : '';
});
</script>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
  );
}

module.exports = { renderHtml };
