"use strict";

// Seed modu: verilen seed ile arka planda geçici bir vanilla sunucu açar,
// "Kasif" adlı izleyici (spectator) botu dünyanın üstünde gezdirip cevherleri
// tarar, sonra stratejiyi hesaplayıp harita/ klasörüne kaydeder.
// Aynı seed + aynı sürüm = aynı dünya, yani bu plan senin dünyanda da geçerli.

const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn, execFileSync } = require("child_process");
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { scanLoaded, mergeScans } = require("./scanner");
const { makePlan } = require("./planner");
const { renderHtml } = require("./mapRender");
const { waitForChunks } = require("./speedrun");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, ".cache");
const OUT = path.join(ROOT, "harita");
const SEED_LIMITS = { log: 3000, iron: 5000, diamond: 3000, lava: 5000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} indirilemedi (${res.status})`);
  return res.json();
}

// Mojang'ın resmi sunucu dosyasını indirir (bir kere, sonra .cache'ten).
async function ensureServerJar(version) {
  fs.mkdirSync(CACHE, { recursive: true });
  const jar = path.join(CACHE, `server-${version}.jar`);
  const metaFile = path.join(CACHE, `version-${version}.json`);
  if (fs.existsSync(jar) && fs.existsSync(metaFile))
    return { jar, meta: JSON.parse(fs.readFileSync(metaFile)) };
  console.log(
    `Minecraft ${version} sunucu dosyası indiriliyor (bir kereye mahsus)...`,
  );
  const manifest = await fetchJson(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  );
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`Sürüm bulunamadı: ${version}`);
  const meta = await fetchJson(entry.url);
  const res = await fetch(meta.downloads.server.url);
  if (!res.ok) throw new Error("Sunucu dosyası indirilemedi");
  fs.writeFileSync(jar, Buffer.from(await res.arrayBuffer()));
  fs.writeFileSync(metaFile, JSON.stringify({ javaVersion: meta.javaVersion }));
  return { jar, meta };
}

function checkJava(java, needed) {
  let out;
  try {
    out = execFileSync(java, ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    out = (err.stderr || "") + (err.stdout || "");
    if (err.code === "ENOENT")
      throw new Error(
        `Java bulunamadı (${java}). Java ${needed} kur veya --java ile yolunu ver.`,
      );
  }
  const m = /version "(\d+)/.exec(out);
  if (m && Number(m[1]) < needed) {
    throw new Error(
      `Bu Minecraft sürümü Java ${needed} istiyor, sende Java ${m[1]} var. --java ile yeni Java'nın yolunu ver.`,
    );
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer({ java, jar, dir, seed, port, viewDistance }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "eula.txt"), "eula=true\n");
  fs.writeFileSync(
    path.join(dir, "server.properties"),
    [
      `level-seed=${seed}`,
      `server-port=${port}`,
      "server-ip=127.0.0.1",
      "online-mode=false",
      "gamemode=spectator",
      "force-gamemode=true",
      "difficulty=peaceful",
      "spawn-monsters=false",
      `view-distance=${viewDistance}`,
      "simulation-distance=5",
      "max-players=2",
      "pause-when-empty-seconds=-1",
      "motd=FastAuto harita",
    ].join("\n") + "\n",
  );

  const proc = spawn(java, ["-Xmx3G", "-jar", jar, "nogui"], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let log = "";
  await new Promise((resolve, reject) => {
    const onData = (d) => {
      log += d.toString();
      if (log.includes("Done (")) resolve();
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) =>
      reject(new Error(`Sunucu kapandı (kod ${code}).\n${log.slice(-2000)}`)),
    );
  });
  proc.removeAllListeners("exit");
  const command = (cmd) => proc.stdin.write(cmd + "\n");
  const stop = () =>
    new Promise((resolve) => {
      proc.once("exit", resolve);
      command("stop");
      setTimeout(() => {
        proc.kill();
        resolve();
      }, 20000);
    });
  return { proc, command, stop };
}

async function makeSeedMap(opts) {
  const version = opts.version;
  const seed = String(opts.seed);
  const radius = opts.radius || 192;
  const viewDistance = 10;
  const java = opts.java || process.env.JAVA || "java";

  const { jar, meta } = await ensureServerJar(version);
  checkJava(java, (meta.javaVersion && meta.javaVersion.majorVersion) || 21);

  const port = await freePort();
  const dir = path.join(
    CACHE,
    `dunya-${version}-${seed.replace(/[^\w-]/g, "_")}`,
  );
  console.log(
    `Seed ${seed} için dünya oluşturuluyor (arka planda, ${version})...`,
  );
  const server = await startServer({
    java,
    jar,
    dir,
    seed,
    port,
    viewDistance,
  });

  const scout = mineflayer.createBot({
    host: "127.0.0.1",
    port,
    username: "Kasif",
    version,
    auth: "offline",
  });
  try {
    await new Promise((resolve, reject) => {
      scout.once("spawn", resolve);
      scout.once("error", reject);
      scout.once("kicked", (r) =>
        reject(new Error("Kaşif atıldı: " + JSON.stringify(r))),
      );
    });
    await waitForChunks(scout);
    const sp = scout.spawnPoint || scout.entity.position;
    const spawn = {
      x: Math.floor(sp.x),
      y: Math.floor(sp.y),
      z: Math.floor(sp.z),
    };
    console.log(
      `Doğma noktası: ${spawn.x} ${spawn.y} ${spawn.z}. ±${radius} blok taranıyor...`,
    );

    const step = (viewDistance - 2) * 16;
    const offsets = [];
    for (let dx = -radius + step / 2; dx < radius; dx += step) {
      for (let dz = -radius + step / 2; dz < radius; dz += step)
        offsets.push([dx, dz]);
    }
    offsets.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));

    let resources = { log: [], iron: [], diamond: [], lava: [] };
    for (let i = 0; i < offsets.length; i++) {
      const [dx, dz] = offsets[i];
      const x = spawn.x + Math.round(dx);
      const z = spawn.z + Math.round(dz);
      server.command(`tp Kasif ${x} 200 ${z}`);
      const t0 = Date.now();
      while (
        scout.entity.position.distanceTo(new Vec3(x, 200, z)) > 4 &&
        Date.now() - t0 < 10000
      )
        await sleep(100);
      await waitForChunks(scout, 1500, 30000);
      const found = scanLoaded(scout, new Vec3(x, 0, z), step, SEED_LIMITS);
      resources = mergeScans(resources, found);
      process.stdout.write(
        `\r  Bölge ${i + 1}/${offsets.length} — ${resources.diamond.length} elmas, ${resources.iron.length} demir`,
      );
    }
    process.stdout.write("\n");

    // Sadece istenen yarıçapın içini tut; ağaçlar zaten doğma noktası yakınından seçiliyor.
    const inside = (p) =>
      Math.abs(p.x - spawn.x) <= radius && Math.abs(p.z - spawn.z) <= radius;
    for (const k of Object.keys(resources))
      resources[k] = resources[k].filter(inside);

    const plan = makePlan(resources, spawn, { logsNeeded: 6 });
    fs.mkdirSync(OUT, { recursive: true });
    const base = path.join(OUT, `seed-${seed.replace(/[^\w-]/g, "_")}`);
    const result = {
      seed,
      version,
      spawn,
      radius,
      createdAt: new Date().toISOString(),
      plan,
      resources,
    };
    fs.writeFileSync(base + ".json", JSON.stringify(result, null, 1));
    fs.writeFileSync(
      base + ".html",
      renderHtml({
        title: `Seed ${seed} — elmas rotası`,
        spawn,
        resources,
        plan,
      }),
    );
    printPlan(plan, spawn);
    console.log(
      `\nKaydedildi:\n  ${base}.json  (bot bunu kullanır)\n  ${base}.html  (tarayıcıda aç, haritayı gör)`,
    );
    return result;
  } finally {
    scout.quit();
    await server.stop();
  }
}

function printPlan(plan, spawn) {
  const p = (q) => (q ? `${q.x} ${q.y} ${q.z}` : "-");
  console.log("\n=== STRATEJİ ===");
  console.log(`Başlangıç : ${p(spawn)}`);
  console.log(`Ağaç      : ${p(plan.trees[0])} (${plan.trees.length} kütük)`);
  console.log(`Demir     : ${p(plan.iron[0])} (${plan.iron.length} cevher)`);
  console.log(
    `Elmas     : ${p(plan.diamonds[0])} (${plan.diamonds.length} blokluk damar)`,
  );
  console.log(plan.reason);
}

module.exports = { makeSeedMap, printPlan };
