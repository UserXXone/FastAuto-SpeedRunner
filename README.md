# FastAuto SpeedRunner 💎

Minecraft **Java Edition** için speedrun botu. Bot sıfırdan (boş envanterle) başlıyor ve elmasa kadar koşuyor:

```
Harita + strateji → Odun → Tahta kazma → Taş kazma → Demir → Fırın + eritme → Demir kazma → ELMAS
```

Her aşamada süre tutuyor ve sonunda bir split tablosu yazdırıyor.

İki modu var:

| Mod | Ne yapar |
|-----|----------|
| **Canlı** (`npm start`) | Bot dünyaya girer, sunucunun gönderdiği chunk'ları tarar, en yakın ağaç → demir → elmas rotasını hesaplar ve koşar. |
| **Seed** (`npm run harita`) | Seed'i verirsin. Koşudan **önce**, arka planda aynı seed'le geçici bir dünya açılır. Bir "kaşif" bot dünyanın üstünde uçup geniş bir alanı tarar, en iyi rotayı hesaplar ve `harita/seed-XXX.json` dosyasına kaydeder. Koşuda bot bu planı kullanır, aramaya vakit harcamaz. |

> Aynı seed + aynı sürüm = birebir aynı dünya. Bu yüzden seed modunda çıkarılan cevher koordinatları senin dünyanda da aynı yerde olur.

## Gereksinimler

- **Minecraft Java 26.1.** Bot kütüphanesi (mineflayer) şu an en yeni **26.1**'i destekliyor. Launcher'da "Installations → New → 26.1" seç.
- **Node.js 18 veya üstü:** https://nodejs.org
- **Sadece seed modu için Java 25:** https://adoptium.net (Temurin 25). Minecraft 26.x sunucusu Java 25 istiyor.

## Kurulum

```bash
git clone https://github.com/userxxone/fastauto-speedrunner.git
cd fastauto-speedrunner
npm install
```

## 1) Canlı mod: sıfırdan elmas

Bot, hesabı olmayan ("offline") bir oyuncu olarak bağlanıyor. Normal "Open to LAN" dünyası Mojang hesabı istediği için bot oraya giremez. Bu yüzden en kolay yol, bilgisayarında küçük bir **yerel sunucu** açmak:

1. [minecraft.net/download/server](https://www.minecraft.net/en-us/download/server) adresinden 26.1 `server.jar` dosyasını boş bir klasöre indir. Aynı klasöre `eula.txt` oluştur, içine `eula=true` yaz.
2. Aynı klasörde `server.properties` dosyasını oluştur veya düzenle:
   ```
   online-mode=false
   level-seed=İSTEDİĞİN_SEED     (boş bırakırsan rastgele)
   difficulty=peaceful
   view-distance=12
   ```
3. Sunucuyu başlat: `java -jar server.jar nogui` (Java 25 gerekir).
4. Başka bir terminalde botu çalıştır:

```bash
npm start
```

İzlemek istersen Minecraft'tan **Multiplayer → Direct Connect → `localhost`** ile sen de gir.

Bot oyuna "Speedrunner" adıyla girer ve koşuya başlar. Konsolda şöyle split'ler görürsün:

```
⏱  6.5s  (+6.5s)  Harita + strateji
⏱  31.0s  (+24.5s)  Odun (6 kütük)
...
💎 Elmas bulundu! Süre: 4:12.4
```

Koşudan sonra `harita/son-kosu.html` dosyasını tarayıcıda açarsan botun gördüğü haritayı ve seçtiği rotayı görürsün.

> Başka bir bilgisayardaki sunucuya bağlanmak için: `npm start -- --host 192.168.1.20 --port 25565`

## 2) Seed modu: önce harita, sonra koşu

```bash
# 1. Haritayı çıkar ve stratejiyi kur (koşu süresine sayılmaz)
npm run harita -- --seed 12345

# Java 25 PATH'te değilse yolunu ver:
npm run harita -- --seed 12345 --java "C:\Program Files\Eclipse Adoptium\jre-25\bin\java.exe"
```

Çıktı şuna benzer:

```
Doğma noktası: 96 72 -32. ±192 blok taranıyor...
  Bölge 9/9 — 41 elmas, 2950 demir

=== STRATEJİ ===
Başlangıç : 96 72 -32
Ağaç      : 101 70 -27 (6 kütük)
Demir     : 120 34 -12 (3 cevher)
Elmas     : 131 -58 -5 (4 blokluk damar)
```

İki dosya oluşur:

- `harita/seed-12345.json`: bot bunu kullanır.
- `harita/seed-12345.html`: tarayıcıda aç. Kuşbakışı harita gelir: yeşil kütük, turuncu demir, mavi elmas, beyaz kesik çizgi rota.

```bash
# 2. Yerel sunucuyu aynı seed'le (level-seed=12345) başlat ve planla koş
npm start -- --plan harita/seed-12345.json
```

## Tüm seçenekler

```bash
npm start -- --help
```

| Seçenek | Açıklama |
|---------|----------|
| `--host`, `--port` | Sunucu adresi ve portu |
| `--username` | Botun adı (varsayılan `Speedrunner`) |
| `--plan <dosya>` | Seed modunun ürettiği plan |
| `--diamonds <n>` | Kaç elmas toplasın (varsayılan 1) |
| `--radius <blok>` | Canlı taramanın yarıçapı |
| `--chat` | Aşamaları oyun içi chate de yazsın |

## Nasıl çalışıyor?

- `src/scanner.js`: Yüklü chunk'lardaki kütük, demir, elmas ve lav bloklarını bulur.
- `src/planner.js`: Strateji. Ağaçları ve cevher damarlarını gruplar. `başlangıç → ağaç → demir → elmas` yolunun maliyetini hesaplar (aşağı kazmak ucuz, yukarı çıkmak pahalı) ve en ucuz rotayı seçer. Lavın dibindeki elmaslara ceza puanı verir, mağaraya açılan elmaslara bonus verir.
- `src/actions.js`: Kazma, drop toplama, crafting, masa ve fırın koyma, eritme.
- `src/speedrun.js`: Aşamalar ve zamanlayıcı. Plan tutmazsa bot canlı aramaya geçer. Görünürde elmas yoksa derine inip keşfe çıkar.
- `src/harita.js`: Seed modu. Geçici sunucuyu açar ve kaşif botu `tp` ile gezdirip tarar.

## Bilinen sınırlar

- **Dövüş yok:** Peaceful veya Easy öner.
- Su altında havası azalırsa yüzeye çıkmaya çalışıyor, ama dar su mağaralarında yine boğulabilir.
- Bot, sunucunun gönderdiği blok verisini okuyor. Yani cevherleri "duvarın arkasından" görüyor. Bu, kendi dünyanda eğlence ve deneme içindir. **Botla yapılan koşular speedrun.com gibi yerlere gönderilemez.** Başkasının sunucusunda kullanmak da hile sayılır ve ban sebebidir.
- 30 saniyelik videolardaki gibi bir süre bu botla beklenmemeli. O videolar genelde set seed, glitch ve TAS kombinasyonu.

## Test

```bash
npm test   # strateji (planner) birim testleri
```
