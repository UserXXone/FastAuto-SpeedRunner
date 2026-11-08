# Seed Avcısı 🔎 (Faz 1)

Minecraft **Java 1.21.1** için speedrun'a uygun seed arar. Birden fazla bilgisayarda aynı anda çalışır. Her bilgisayar seed uzayının kendi dilimini tarar, böylece aynı seed iki kere taranmaz. En iyi 1000 seed'i bir txt dosyasına yazar.

## İyi seed ne demek?

Program her seed için **tahmini yol süresini** hesaplar. Düşük süre daha iyi demek:

1. Doğma noktasından **yıkık portala** yürüme (Nether'a hızlı giriş)
2. Nether'da **bastion** (pearl) ve **fortress** (blaze) arasında dolaşma
3. Oradan **kalenin** (stronghold) Nether karşılığına gitme
4. Doğma noktası ağaçsız bir biyomdaysa **+25 sn** ceza

Ağaç kesme, blaze kesme ve ejderha dövüşü gibi görevler her seed'de aşağı yukarı aynı sürdüğü için hesaba katılmıyor. Yani `sn` değeri koşunun tamamı değil, **seed'ler arası karşılaştırma için bir puan**.

**Doğrulama:** İki seed'i gerçek bir Minecraft 1.21.1 sunucusunda kontrol ettik. Yıkık portal, bastion, fortress ve kale konumları birebir tuttu, doğma noktası ±8 blok. Portalın kaç obsidyeni eksik, sandığında ne var gibi ayrıntıları oyunu açmadan hesaplamak mümkün değil. Bunları Faz 2'deki panel gerçek oyunla ölçecek.

## Windows'ta kullanım (Windows 7, 8, 10, 11)

1. `dagitim` klasörünü (`seed-avcisi.exe` + `baslat.bat`) bilgisayara kopyala. Masaüstü olur.
2. `baslat.bat`'a çift tıkla.
3. İlk seferde iki soru sorar:
   - **Bu bilgisayarın numarası:** Her bilgisayara farklı bir numara ver: 1, 2, 3...
   - **Toplam kaç bilgisayar tarıyor:** Hepsinde **aynı** sayıyı yaz.

   Cevaplar `ayar.txt`'ye kaydedilir, bir daha sormaz.
4. Pencere açık kaldıkça tarar. Ekranda canlı olarak hız, bulunan seed sayısı ve en iyi süre görünür.
5. Durdurmak için **Ctrl+C**. Tekrar çalıştırınca **kaldığı yerden devam eder**. Sonuçlar her 30 saniyede bir kaydedilir.

Sonuç dosyası: `seedler-pc1.txt` (numara bilgisayara göre değişir).

> Program varsayılan olarak **düşük öncelikte** çalışır. Bilgisayarı kullanırken (oyun, tarayıcı) yavaşlık hissetmezsin, boşta kalınca tam hız tarar.

### Örnek dağılım (6 makine)

| Makine | Numara | Toplam |
|---|---|---|
| Windows 11 PC'ler | 1, 2, 3, 4 | 6 |
| Windows 7/8 PC | 5 | 6 |
| VDS (Linux) | 6 | 6 |

## Linux / VDS'te kullanım

```bash
cd seed-avcisi
make                      # bin/seed-avcisi oluşur
tmux new -s avci
./bin/seed-avcisi --pc 6 --toplam 6 --cekirdek 4
# Ctrl+b, sonra d: tmux'tan ayrıl, tarama sürer
```

VDS sağlayıcın sürekli %100 CPU kullanımını sevmiyorsa `--cekirdek` ile kaç çekirdek kullanılacağını sınırla.

## Sonuç dosyası

```
# seed	sn	spawn	portal	bastion	fortress	kale	nether	biyom
1436366806154496798	52.5	spawn=72,136	portal=80,144	bastion=0,0	fortress=-80,32	kale=-1484,740	nether=227	biyom=4:forest
```

| Alan | Anlamı |
|---|---|
| `seed` | Minecraft'ta "Seed for the world generator" kutusuna yazılacak sayı |
| `sn` | Tahmini yol süresi (düşük = iyi) |
| `spawn`, `portal`, `kale` | Overworld koordinatları (x,z) |
| `bastion`, `fortress` | **Nether** koordinatları (x,z) |
| `nether` | Nether'da yürünecek toplam blok |
| `biyom` | Doğma noktasının biyomu |

Dosyaları birleştirmek için hepsini aynı klasöre koy. Faz 2'deki panel hepsini okuyup birleştirecek ve sıralayacak.

## Tüm seçenekler

```
--pc N            Bu bilgisayarın numarası (1'den başlar)
--toplam M        Toplam kaç bilgisayar tarıyor
--cekirdek K      Kaç çekirdek kullanılsın (varsayılan: hepsi)
--cikti DOSYA     Sonuç dosyası (varsayılan: seedler-pcN.txt)
--en-iyi K        Dosyada tutulacak seed sayısı (varsayılan: 1000)
--dakika D        D dakika sonra dur
--portal B        Doğma → yıkık portal en fazla B blok (varsayılan: 120)
--nether B        Nether merkezi → bastion/fortress en fazla B blok (varsayılan: 120)
--kale B          Kalenin merkeze uzaklığı en fazla B blok (varsayılan: 1700)
--ust U           Her yapı düzeni için denenecek varyasyon (varsayılan: 4096)
--normal-oncelik  Düşük öncelik yerine tam hız
```

## Derleme (geliştirici için)

```bash
sudo apt install gcc make gcc-mingw-w64-x86-64
make hepsi     # bin/seed-avcisi (Linux) + bin/seed-avcisi.exe (Windows 7+)
```

Dünya üretimi hesapları [cubiomes](https://github.com/Cubitect/cubiomes) kütüphanesiyle yapılıyor (MIT lisansı, `third_party/cubiomes`).
