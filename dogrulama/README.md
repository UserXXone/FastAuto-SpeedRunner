# Gerçek oyunla seed doğrulama (Faz 2)

Seed avcısının bulduğu en iyi seed'leri gerçek bir **Minecraft 1.21.1** sunucusunda tek tek açıp kontrol eder.

Her seed için:

1. Geçici bir sunucu açılır. Sadece `127.0.0.1`'de dinler, dışarıdan girilemez.
2. Keşif botu (yaratıcı mod) girer ve şunlara bakar:
   - doğma noktasına en yakın ağaç
   - yıkık portalın çerçevesi: kaç obsidyen eksik, su içinde mi, gömülü mü
   - portal sandığı: obsidyen, çakmak, ateş topu, altın
3. Bastion, fortress ve kale oyunun kendi `/locate` komutuyla bulunur ve avcının tahminiyle karşılaştırılır.
4. Sunucu kapatılır, dünya silinir.

**Gerçek süre** = yol (oyundan ölçülen) + ağaca yürüme + portal cezaları. Ceza durumları: eksik obsidyen (lav dökmek gerekir), sandıkta çakmak yok, portal suda ya da gömülü. Görev süreleri (blaze, pearl, ejderha) henüz dahil değil.

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
