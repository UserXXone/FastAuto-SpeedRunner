"use strict";

// Faz 3 koşusunu baştan sona çalıştırır:
//   seed'in bilgilerini (portal, bastion, fortress, kale) panel verisinden okur,
//   o seed'le geçici bir 1.21.1 sunucusu açar (sadece 127.0.0.1), botu sokar ve koşturur.
// --host verilirse sunucu açmaz, var olan sunucuya bağlanır.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const { Rcon, jarHazirla, sunucuAc, sunucuKapat, SURUM } = require("../dogrulama/sunucu");
const { tumSeedler, dogrulamaOku } = require("../web/veri");
const nether = require("./nether");
const { fixToolData } = require("./dataFix");

fixToolData(SURUM);

const ROOT = path.join(__dirname, "..");
const WORLD = path.join(ROOT, "kosu", "dunya");
const RESULTS = path.join(ROOT, "kosu", "veri", "kosular.json");
const STATUS = path.join(ROOT, "kosu", "veri", "durum.json");
const PORT = 25565;
const RCON_PORT = 25575;
const HUNTER = "seed-avci";
const VERIFIER = "seed-dogrulama";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { GOALS } = nether; // koşunun nereye kadar gideceği (--hedef)

function parseXZ(s) {
  const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(String(s || ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Seed'in yapı konumları: önce gerçek oyunla doğrulanmış sonuç, yoksa avcının tahmini.
function seedInfo(seed, args) {
  const info = { seed };
  const verified = dogrulamaOku().sonuclar[seed];
  if (verified && !verified.hata) {
    Object.assign(info, {
      portal: verified.portal.konum,
      bastion: verified.bastion,
      fortress: verified.fortress,
      kale: verified.kale,
      kaynak: "doğrulama",
    });
  } else {
    const s = tumSeedler().find((x) => x.seed === seed);
    if (s) Object.assign(info, { portal: s.portal, bastion: s.bastion, fortress: s.fortress, kale: s.kale, kaynak: "avcı tahmini" });
  }
  if (args.portal) info.portal = parseXZ(args.portal);
  if (!info.portal)
    throw new Error(
      "Bu seed'in portal konumu bilinmiyor. Panelde olan bir seed ver ya da --portal x,z ekle.",
    );
  return info;
}

function serviceActive(name) {
  try {
    return execFileSync("systemctl", ["is-active", name], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "active";
  } catch {
    return false;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 1));
  fs.renameSync(file + ".tmp", file);
}

// Panel canlı durumu buradan okur.
const status = { calisiyor: true, pid: process.pid, seed: null, baslangic: 0, asama: "", asamalar: [], notlar: [] };
function setStatus(patch = {}) {
  Object.assign(status, patch, { guncellendi: Math.floor(Date.now() / 1000) });
  try { writeJson(STATUS, status); } catch { /* durum yazılamasa da koşu sürsün */ }
}

function saveResult(r) {
  let all = [];
  try {
    all = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  } catch { /* ilk koşu */ }
  all.push(r);
  writeJson(RESULTS, all.slice(-200));
}

function connect(host, port, username) {
  const bot = mineflayer.createBot({ host, port, username, version: SURUM, auth: "offline", hideErrors: true });
  bot.loadPlugin(pathfinder);
  bot.setMaxListeners(60);
  bot.on("error", (e) => console.error("Bağlantı hatası:", e.message));
  const spawned = new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    bot.once("kicked", (r) => reject(new Error("Sunucudan atıldı: " + JSON.stringify(r))));
    bot.once("end", (r) => reject(new Error("Bağlantı koptu: " + r)));
  });
  return { bot, spawned };
}

// Can azalınca nedenini yaz: ölüm sebebini bulmak için.
function watchHealth(bot) {
  const HOSTILE = /zombie|skeleton|creeper|spider|drowned|witch|enderman|slime|phantom|pillager|piglin|hoglin|blaze|ghast|magma_cube|wither|husk|stray|silverfish/;
  let last = bot.health;
  bot.on("health", () => {
    if (bot.health < last - 0.01) {
      const me = bot.entity.position;
      const near = Object.values(bot.entities)
        .filter((e) => e !== bot.entity && e.name && HOSTILE.test(e.name) && e.position.distanceTo(me) < 12)
        .map((e) => `${e.name}@${e.position.distanceTo(me).toFixed(1)}`);
      const feet = bot.blockAt(me.offset(0, -0.2, 0));
      const body = bot.blockAt(me);
      console.log(
        `💔 can ${bot.health.toFixed(1)}/20 (−${(last - bot.health).toFixed(1)}), açlık ${bot.food} | altında ${feet && feet.name}, içinde ${body && body.name}` +
          (bot.entity.isInLava ? ", LAVDA" : "") + (near.length ? ` | yakında: ${near.join(", ")}` : ""),
      );
    }
    last = bot.health;
  });
  bot.on("messagestr", (m, pos) => {
    if (pos !== "game_info" && m && m.includes(bot.username)) console.log(`[oyun] ${m}`);
  });
}

async function netherKosu(args) {
  const username = args.username || "Speedrunner";
  // Test kısayolları: "portal" alet aşamasını atlar; "dokum" ayrıca iki kova ve çakmak verir.
  const cast = args.basla === "dokum";
  const kaleTest = args.basla === "kale"; // doğrudan kale aşaması (12 göz verilir)
  if (kaleTest) args.hedef = "kale";
  const start = kaleTest ? "kale" : args.basla === "portal" || cast ? "portal" : "bastan";
  const external = Boolean(args.host);
  if (!external && (!args.seed || args.seed === true))
    throw new Error("--seed vermelisin. Örnek: npm run nether -- --seed 123");
  const seed = args.seed && args.seed !== true ? String(args.seed) : null;
  const info = seedInfo(seed, args);
  console.log(
    `Seed ${seed || "(sunucununki)"} — portal ${info.portal.join(", ")}` +
      (info.fortress ? `, fortress ${info.fortress.join(", ")}, bastion ${info.bastion.join(", ")}` : "") +
      (info.kaynak ? ` [${info.kaynak}]` : ""),
  );

  const result = { seed, zaman: Math.floor(Date.now() / 1000), hedef: GOALS.includes(args.hedef) ? args.hedef : "blaze", basla: start, basarili: false };
  let server = null;
  let rcon = null;
  let hunterStopped = false;
  let bot = null;
  const cleanup = async () => {
    try { if (bot) bot.quit(); } catch { /* */ }
    if (args.izle && server && server.exitCode === null) {
      console.log(`Sunucu ${args.izle} sn açık kalıyor (izlemek için).`);
      await sleep(Number(args.izle) * 1000 || 0);
    }
    await sunucuKapat(server, rcon).catch(() => {});
    if (rcon) rcon.kapat();
    if (server && !args.tut) fs.rmSync(WORLD, { recursive: true, force: true });
    if (hunterStopped) {
      try { execFileSync("systemctl", ["start", HUNTER]); console.log("Seed avcısı tekrar açıldı."); } catch { /* */ }
    }
  };
  const onSignal = () => {
    setStatus({ calisiyor: false, asama: "durduruldu" });
    try { saveResult({ ...result, hata: "durduruldu" }); } catch { /* */ }
    if (server && server.exitCode === null) server.kill("SIGKILL");
    if (hunterStopped) try { execFileSync("systemctl", ["start", HUNTER]); } catch { /* */ }
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  setStatus({ seed, baslangic: result.zaman, asama: "sunucu açılıyor" });
  try {
    if (!external) {
      if (serviceActive(VERIFIER))
        throw new Error("Seed doğrulaması çalışıyor; ikisine birden RAM yetmez. Önce panelden durdur.");
      if (serviceActive(HUNTER)) {
        console.log("Seed avcısı duraklatılıyor (RAM ve işlemci için)...");
        execFileSync("systemctl", ["stop", HUNTER]);
        hunterStopped = true;
      }
      jarHazirla(console.log);
      const sifre = crypto.randomBytes(12).toString("hex");
      console.log("Sunucu açılıyor...");
      server = await sunucuAc({
        seed, sifre, dizin: WORLD, port: PORT, rconPort: RCON_PORT,
        bellek: process.env.MC_BELLEK || "1G",
        ozellikler: {
          difficulty: args.zorluk || "easy",
          "view-distance": 6,
          "simulation-distance": 4,
          "max-players": 3,
          motd: "FastAuto kosu",
        },
      });
      rcon = new Rcon();
      await rcon.baglan(RCON_PORT, sifre);
    }

    // Warped forest'ın yeri (enderman avı için). Seed'den belli olan bir bilgi;
    // oyunun kendi /locate komutuyla öğreniyoruz.
    if (rcon && ["pearl", "kale"].includes(args.hedef) && !kaleTest && !info.warped) {
      const nx = Math.round(info.portal[0] / 8);
      const nz = Math.round(info.portal[1] / 8);
      const cevap = await rcon.komut(`execute in minecraft:the_nether positioned ${nx} 64 ${nz} run locate biome minecraft:warped_forest`);
      const m = /\[(-?\d+), (?:~|-?\d+), (-?\d+)\]/.exec(cevap);
      if (m) info.warped = [Number(m[1]), Number(m[2])];
      console.log(info.warped ? `Warped forest: ${info.warped.join(", ")} (Nether)` : "Warped forest bulunamadı");
    }

    const c = connect(args.host || "127.0.0.1", Number(args.port || PORT), username);
    bot = c.bot;
    await c.spawned;
    console.log(`Bağlandı (Minecraft ${bot.version}).`);
    watchHealth(bot);
    const failed = new Promise((_, reject) => {
      bot.once("death", () => reject(new Error("Bot öldü")));
      bot.once("end", (r) => reject(new Error("Bağlantı koptu: " + r)));
    });
    failed.catch(() => {});

    if (start === "portal" && rcon) {
      // Test kısayolu: önceki aşamaları atla. Gerçek koşu sayılmaz.
      console.log("TEST: portala ışınlanıyor, aletler veriliyor (gerçek koşu değil).");
      const [x, z] = info.portal;
      await rcon.komut(`spreadplayers ${x} ${z} 0 4 false ${username}`);
      for (const it of ["stone_pickaxe", "stone_pickaxe", "stone_pickaxe", "stone_pickaxe", "stone_sword", "oak_log 4", "cobblestone 12", "shield", "cooked_beef 12", "golden_boots"])
        await rcon.komut(`give ${username} ${it}`);
      if (cast) for (const it of ["bucket 2", "flint_and_steel"]) await rcon.komut(`give ${username} ${it}`);
      await sleep(1500);
    }

    if (kaleTest && rcon) {
      if (!info.kale) throw new Error("Bu seed'in kale konumu bilinmiyor");
      console.log("TEST: kaleye ışınlanıyor, gözler veriliyor (gerçek koşu değil).");
      await rcon.komut(`spreadplayers ${info.kale[0]} ${info.kale[1]} 0 4 false ${username}`);
      for (const it of ["stone_pickaxe", "stone_pickaxe", "stone_pickaxe", "stone_sword", "cobblestone 64", "shield", "cooked_beef 12", "ender_eye 12"])
        await rcon.komut(`give ${username} ${it}`);
      await sleep(1500);
    }

    setStatus({ asama: "koşu başladı", kosuBaslangic: Date.now() });
    const timer = await Promise.race([
      nether.run(bot, info, {
        start,
        goal: GOALS.includes(args.hedef) ? args.hedef : "blaze",
        chat: Boolean(args.chat),
        delay: Number(args.bekle || 0),
        onSplit: (s, all) => { result.asamalar = all; setStatus({ asama: s.name, asamalar: all }); },
        onSay: (msg) => setStatus({ notlar: [...status.notlar, msg].slice(-6) }),
      }),
      failed,
    ]);
    result.basarili = true;
    result.asamalar = timer.splits;
    result.sureMs = timer.splits.length ? timer.splits[timer.splits.length - 1].total : timer.elapsed();
  } catch (err) {
    result.hata = err.message;
    throw err;
  } finally {
    setStatus({ calisiyor: false, asama: result.basarili ? "bitti" : "hata: " + result.hata });
    if (bot && bot.entity) {
      const p = bot.entity.position.floored();
      result.sonKonum = [p.x, p.y, p.z, bot.game && bot.game.dimension];
    }
    saveResult(result);
    if (rcon && process.env.DEBUG) {
      // Sunucu ne kadar yavaş çalıştı? (20 TPS = tik başına 50 ms)
      try { console.log("  · sunucu:", (await rcon.komut("tick query", 5000)).replace(/\n/g, " | ").slice(0, 300)); } catch { /* */ }
    }
    await cleanup();
  }
}

module.exports = { netherKosu, seedInfo };
