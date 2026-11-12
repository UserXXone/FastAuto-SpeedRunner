#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");

const DEFAULT_VERSION = "26.1"; // harita (elmas) modu için; Nether koşusu 1.21.1 kullanır

const HELP = `
FastAuto SpeedRunner — Minecraft Java elmas speedrun botu

Kullanım:
  npm start -- [seçenekler]            Botu dünyana sokar, sıfırdan elmasa koşar
  npm run harita -- --seed <seed>      Seed'den haritayı çıkarır, strateji kurar

Koşu seçenekleri (kos):
  --host <adres>       Sunucu adresi (varsayılan: localhost)
  --port <port>        Port. Tek oyunculu dünyayı "LAN'a aç" deyince chatte yazan port
  --username <isim>    Botun adı (varsayılan: Speedrunner)
  --plan <dosya>       "harita" komutunun ürettiği .json (seed modu)
  --radius <blok>      Canlı taramada bakılacak yarıçap (varsayılan: 128)
  --diamonds <sayı>    Kaç elmas toplasın (varsayılan: 1)
  --chat               Aşamaları oyun içi chate de yazsın
  --bekle <saniye>     Bağlandıktan sonra bu kadar bekleyip başlasın
  --version <sürüm>    Minecraft sürümü (varsayılan: otomatik algıla)

Nether koşusu (nether) — Minecraft 1.21.1, sunucuyu kendi açar:
  --seed <seed>        Panelde görünen bir seed (yapı konumları oradan okunur)
  --portal <x,z>       Yıkık portalın yeri (seed panelde yoksa)
  --basla portal       TEST: alet aşamasını atla, portalın yanında başla
  --hedef <aşama>      nether | blaze (varsayılan) | pearl (deneysel: enderman avı + ender gözü)
  --izle <saniye>      Koşu bitince sunucuyu bu kadar açık tut
  --tut                Koşudan sonra dünyayı silme (kosu/dunya)
  --host/--port        Sunucu açma, var olan 1.21.1 sunucusuna bağlan
  --chat, --bekle      Koşu seçenekleriyle aynı

Harita seçenekleri (harita):
  --seed <seed>        Dünya seed'i (zorunlu)
  --radius <blok>      Doğma noktası etrafında taranacak alan (varsayılan: 192)
  --version <sürüm>    Varsayılan: ${DEFAULT_VERSION}
  --java <yol>         Java 25+ yolu (Minecraft 26.x için gerekli)
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

async function kos(args) {
  const { run } = require("./speedrun");
  const { renderHtml } = require("./mapRender");
  const bot = mineflayer.createBot({
    host: args.host || "localhost",
    port: Number(args.port || 25565),
    username: args.username || "Speedrunner",
    version: args.version || false,
    auth: "offline",
  });
  bot.loadPlugin(pathfinder);
  bot.on("kicked", (r) =>
    console.error(
      "Sunucudan atıldı:",
      typeof r === "string" ? r : JSON.stringify(r),
    ),
  );
  bot.on("error", (e) => console.error("Bağlantı hatası:", e.message));
  bot.on("death", () => console.log("☠️  Bot öldü!"));

  bot.once("spawn", async () => {
    require("./dataFix").fixToolData(bot.version);
    console.log(`Bağlandı (Minecraft ${bot.version}). Koşu başlıyor!`);
    try {
      await run(bot, {
        planFile: args.plan,
        radius: Number(args.radius || 128),
        diamonds: Number(args.diamonds || 1),
        chat: Boolean(args.chat),
        delay: Number(args.bekle || 0),
        onMap: (resources, plan) => {
          const p = bot.entity.position.floored();
          const out = path.join(__dirname, "..", "harita");
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(
            path.join(out, "son-kosu.html"),
            renderHtml({
              title: "Son koşu — canlı harita",
              spawn: { x: p.x, y: p.y, z: p.z },
              resources,
              plan,
            }),
          );
        },
      });
      process.exitCode = 0;
    } catch (err) {
      console.error("❌ Koşu durdu:", err.message);
      process.exitCode = 1;
    } finally {
      setTimeout(() => bot.quit(), 500);
    }
  });
}

async function harita(args) {
  if (!args.seed || args.seed === true)
    throw new Error("--seed vermelisin. Örnek: npm run harita -- --seed 12345");
  const { makeSeedMap } = require("./harita");
  await makeSeedMap({
    seed: args.seed,
    radius: Number(args.radius || 192),
    version: args.version || DEFAULT_VERSION,
    java: args.java,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "kos";
  if (args.help || cmd === "yardim" || cmd === "help") return console.log(HELP);
  if (cmd === "kos") return kos(args);
  if (cmd === "harita") return harita(args);
  if (cmd === "nether") return require("./kosu").netherKosu(args);
  console.log(HELP);
}

main().then(
  () => {
    // Nether koşusu bitince açık kalan bağlantı/sayaç yüzünden asılı kalmasın.
    if ((process.argv[2] || "") === "nether") process.exit(0);
  },
  (err) => {
    console.error("❌", err.message);
    process.exit(1);
  },
);
