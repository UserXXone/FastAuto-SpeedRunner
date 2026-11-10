# Gerçek oyunla seed doğrulama (Faz 2)

Seed avcısının bulduğu en iyi seed'leri gerçek bir **Minecraft 1.21.1** sunucusunda tek tek açıp kontrol eder.

Her seed için:

1. Geçici bir sunucu açılır. Sadece `127.0.0.1`'de dinler, dışarıdan girilemez.
2. Keşif botu (yaratıcı mod) girer ve şunlara bakar:
   - doğma noktasına en yakın ağaç
   - yıkık portalın çerçevesi: kaç obsidyen koymak gerek, kaç blok kırmak gerek (ağlayan obsidyen ayrıca sayılır), su içinde mi, gömülü mü. Çerçeveyi botun koşuda kullandığı planlayıcı (`src/portal.js`) ölçer.
   - portal sandığı: obsidyen, çakmak, ateş topu, altın
3. Bastion, fortress ve kale oyunun kendi `/locate` komutuyla bulunur ve avcının tahminiyle karşılaştırılır.
4. Sunucu kapatılır, dünya silinir.

**Gerçek süre** = yol (oyundan ölçülen) + ağaca yürüme + çerçeveyi tamamlama süresi + portal cezaları. Ceza durumları: sandıktaki obsidyen yetmiyor (lav dökmek gerekir), ateş kaynağı yok, portal suda ya da gömülü. Çerçevedeki her ağlayan obsidyen yaklaşık 1 dakika ekler (taş kazmayla kırılır). Görev süreleri (blaze, pearl, ejderha) henüz dahil değil.

## Kullanım

En kolayı panelden (seed.zeax.dev → **Doğrula**). Elle çalıştırmak için:

```bash
node dogrulama/dogrula.js              # en iyi 30 doğrulanmamış seed
node dogrulama/dogrula.js --adet 10
node dogrulama/dogrula.js --seed 123 --seed 456 --yeniden
```

- Seed başına yaklaşık 40–60 sn sürer, ~1 GB RAM kullanır.
- Çalışırken bu sunucudaki seed avcısı duraklatılır, bitince geri açılır. Önceden durmuşsa durmuş kalır.
- Sonuçlar `dogrulama/veri/sonuclar.json` dosyasına yazılır. Sunucu dosyası `dogrulama/sunucu/` klasöründe durur; yoksa Mojang'dan indirilir ve imzası kontrol edilir.

## Ölçüm sürümü

Sonuçlarda `surum` alanı var. Ölçüm yöntemi değişince sürüm artar. Eski sürümle ölçülen seed'ler panelde "bekleyen" sayılır ve bir sonraki doğrulamada yeniden ölçülür. Şu anki sürüm 2: çerçeve botun planlayıcısıyla ölçülüyor.
