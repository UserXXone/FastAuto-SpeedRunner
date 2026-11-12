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
  Aşama                         Süre    Toplam
  Harita + strateji                 2.3s      2.3s
  Odun (6 kütük)                   34.9s     37.2s
  Tahta kazma                       3.7s     41.0s
  Taş kazma                        43.0s    1:23.9
  Demir (3 ham demir)             2:25.9    3:49.9
  Fırın + eritme                   32.0s    4:21.8
  Demir kazma                       0.4s    4:22.2
  ELMAS x2                        1:01.6    5:23.8
```

(Gerçek bir test koşusu, 26.1 sunucusunda. Testlerde sıfırdan elmasa genelde **5–8 dakika** sürüyor. Süreyi en çok etkileyen şey, demir ve elmasın ne kadar derinde olduğu.)

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

## 3) Nether koşusu (Faz 3, yapım aşamasında)

Tam oyunu bitirme yolundaki ilk bölüm: bot doğma noktasından başlar, **Nether'a girer** ve blaze çubuklarını toplar.

```
Odun → Tahta kazma → Taş kazma + kılıç → Yedek kazmalar → Yemek (hayvan avı) → Yıkık portal → Sandık
→ (gerekirse demir + kova + lavla obsidyen) → Çerçeve → Yak → NETHER
→ Blaze spawner'ın altına kapalı tünel → Blaze çiftliği (6 çubuk)
```

Bu mod **Minecraft 1.21.1** kullanır (seed avcısıyla aynı sürüm) ve **Java 21** ister. Sunucuyu kendi açar; sunucu sadece `127.0.0.1`'de dinler.

```bash
npm run nether -- --seed -2192408593595833481
```

- Seed panelde (seed.zeax.dev) görünen bir seed olmalı. Yıkık portalın, fortress'in ve bastion'ın yeri oradan okunur. Panelde olmayan bir seed için `--portal x,z` ver.
- Bot portalı **sandıktaki obsidyenle** tamamlar ve sandıktaki çakmak ya da ateş topuyla yakar. Çakmak yoksa çakmaktaşı + 9 demir parçasından kendi yapar. Sandıktaki obsidyen yetmezse demir, kova ve lavla eksik blokları yerinde dökmeyi dener (aşağıda "deneysel"). Panelde **Portal** sütununda "tamamlanır" ya da "tamam" yazan seed'leri seç.
- Çerçevenin içinde kalan ot, sarmaşık, toprak gibi blokları temizler. Çerçevede ağlayan obsidyen varsa kırar, ama taş kazmayla tanesi yaklaşık 1 dakika sürer.
- Sandıkta altın zırh varsa giyer (Nether'da piglinler saldırmasın diye).
- Koşu sonuçları `kosu/veri/kosular.json` dosyasına yazılır.

| Seçenek | Açıklama |
|---------|----------|
| `--seed <seed>` | Koşulacak seed |
| `--portal <x,z>` | Yıkık portalın yeri (seed panelde yoksa) |
| `--izle <sn>` | Koşu bitince sunucuyu bu kadar açık tut |
| `--tut` | Koşudan sonra dünyayı silme (`kosu/dunya`) |
| `--host`, `--port` | Sunucu açma, var olan bir 1.21.1 sunucusuna bağlan |
| `--hedef nether` | Blaze aşamasını atlar, Nether'a girince durur |
| `--basla dokum` | Test için: portal kısayolu gibi, ayrıca iki kova ve çakmak verir (lavla obsidyen dökmeyi denemek için) |
| `--basla portal` | Test için: alet aşamasını atlar, botu portalın yanına ışınlar ve alet verir. Gerçek koşu sayılmaz. |

Çalışırken bu makinedeki seed avcısı duraklatılır, bitince geri açılır. Seed doğrulaması sürüyorsa koşu başlamaz (ikisine birden RAM yetmez).

**Nether'da nasıl ilerliyor?**

- Bot Nether'da açıkta yürümez: hedefe **kapalı bir tünel** örerek gider (`src/highway.js`). Her adımda önündeki blokları kazar, yanındaki boşlukları ve lavı kapatır.
- Kayanın içinden geçmek bedava, açık havada her adım yaklaşık 6 blok ister. Bu yüzden bot önce tünel kazarak dolgu bloğu (netherrack vb.) toplar, sonra en ucuz yüksekliği seçip o hat boyunca gider.

**Blaze çiftliği**

- Bot spawner'ın çevresindeki 5x5x3 boşluğu kapalı odaya çevirir.
- Kendisi spawner'ın **tam altında** saklanır ve blaze'leri oradan kılıçla keser. Blaze'ler botu göremediği için ateş etmez.
- Yere düşen çubukları odaya girmeden, zeminin altından toplar.

**Deneysel:** Lavla obsidyen dökme (`src/lavacast.js`) yazıldı ama henüz baştan sona doğrulanmadı. Sandıktaki obsidyen yetmeyen seed'lerde bu yola güvenme.

**Dürüst olmak gerekirse:** Bot görüş hattı olmadan blok koyar ve duvarın arkasındaki blaze'e vurur. Sunucu bunu kabul eder ama normal bir oyuncu bunu yapamaz. Bu yüzden bu koşular da **speedrun.com'a gönderilemez**.

**Oyundan izlemek için** (bot uzak bir sunucuda koşuyorsa): kendi bilgisayarında `ssh -L 25565:localhost:25565 kullanici@sunucu` ile tünel aç, Minecraft 1.21.1'de **Multiplayer → Direct Connection → `localhost`** ile gir. Koşuya `--bekle 30` eklersen girmen için 30 saniye bekler.

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
| `--bekle <sn>` | Bağlandıktan sonra bu kadar bekleyip başlasın (oyuna girip izlemek için) |

## Nasıl çalışıyor?

- `src/scanner.js`: Yüklü chunk'lardaki kütük, demir, elmas ve lav bloklarını bulur.
- `src/planner.js`: Strateji. Ağaçları ve cevher damarlarını gruplar. `başlangıç → ağaç → demir → elmas` yolunun maliyetini hesaplar (aşağı kazmak ucuz, yukarı çıkmak pahalı) ve en ucuz rotayı seçer. Lavın dibindeki elmaslara ceza puanı verir, mağaraya açılan elmaslara bonus verir.
- `src/actions.js`: Kazma, drop toplama, crafting, masa ve fırın koyma, eritme.
- `src/speedrun.js`: Aşamalar ve zamanlayıcı. Plan tutmazsa bot canlı aramaya geçer. Görünürde elmas yoksa derine inip keşfe çıkar.
- `src/harita.js`: Seed modu. Geçici sunucuyu açar ve kaşif botu `tp` ile gezdirip tarar.
- `src/portal.js`: Yıkık portal. Yapıyı bulur, en ucuz çerçeveyi planlar (kaç obsidyen koyulacak, ne kırılacak), obsidyenleri koyar, yakar ve içine girer. Aynı planlayıcıyı seed doğrulayıcı da kullanır.
- `src/nether.js`: Nether koşusunun aşamaları.
- `src/highway.js`: Nether'da kapalı tünelle yol alma ve dolgu bloğu toplama. En ucuz yüksekliği seçer.
- `src/fortress.js`: Blaze spawner'ı bulur, çevresini kapalı odaya çevirir, altında saklanıp blaze keser, çubukları toplar.
- `src/combat.js`: Dövüş ve hayatta kalma: yakındaki düşmana vurma, yemek yeme, hayvan avı, kalkan.
- `src/prep.js`: Nether öncesi hazırlık: yedek kazmalar, demir, kova, çakmak, altın zırh.
- `src/lavacast.js`: Kovayla lavdan obsidyen dökme (deneysel).
- `src/kosu.js`: Nether koşusu için sunucuyu açar, botu sokar, sonucu kaydeder.

## Bilinen sınırlar

- **Dövüş yok:** Peaceful veya Easy öner.
- Su altında havası azalırsa yüzeye çıkmaya çalışıyor, ama dar su mağaralarında yine boğulabilir. Planlayıcı, su içindeki cevherleri zaten tercih etmiyor.
- Derine inerken düz aşağı kazıyor. Altında veya yanında lav/su, ya da 3 bloktan derin bir boşluk görürse durup yol bulucuya geçiyor.
- Sorun ayıklamak için: `DEBUG=1 npm start` her adımı ayrıntılı yazar.
- Bot, sunucunun gönderdiği blok verisini okuyor. Yani cevherleri "duvarın arkasından" görüyor. Bu, kendi dünyanda eğlence ve deneme içindir. **Botla yapılan koşular speedrun.com gibi yerlere gönderilemez.** Başkasının sunucusunda kullanmak da hile sayılır ve ban sebebidir.
- 30 saniyelik videolardaki gibi bir süre bu botla beklenmemeli. O videolar genelde set seed, glitch ve TAS kombinasyonu.

## Seed avcısı (Faz 1)

Birden fazla bilgisayarda speedrun'a uygun seed arayan program `seed-avcisi/` klasöründe. Windows 7–11 ve Linux'ta çalışır. Ayrıntılar için: [seed-avcisi/README.md](seed-avcisi/README.md)

## Test

```bash
npm test   # strateji (planner) birim testleri
```
