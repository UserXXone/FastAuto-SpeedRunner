'use strict'

// Giriş yapılmamışken gösterilen sayfa: Zeax Okul Zili tanıtımı.
//
// Sayfadaki hiçbir düğme ya da bağlantı bir şey yapmaz (href yok, olay yok).
// Tek istisna sayfa sonundaki "©" işareti: ona basınca gizli kod penceresi açılır
// ve kod mevcut giriş akışına (POST /giris) gider. İçerik Okul Zili'nin gerçek
// tanıtım metnidir; panelin görsel dili ve ayrı stil dosyası (tanitim.css) kullanılır.

const kacis = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const OZELLIKLER = [
  ['Zil çizelgesi kendi kendine işler',
    'Hafta içi, cuma ve sınav günleri için ayrı çizelgeler kurarsınız. Resmî tatillerde zil susar, ara tatilden sonra kaldığı yerden devam eder. Program okul bilgisayarında çalıştığı için internet kesilse de kayıtlı saatlerde zil çalar.'],
  ['Koridor ekranı her sabah hazır',
    'Okul bilgisayarına bağlı TV’de saat, sıradaki zil, nöbetçi öğretmenler, günün yemeği, sınav takvimi ve sınavlara kalan gün görünür. Nöbet çizelgesini ve yemek listesini PDF ya da Excel olarak bir kez yüklersiniz; pano her gün kendini günceller.'],
  ['Acil durumda herkese aynı anda',
    'Deprem, yangın ya da tahliye için tek dokunuş: bütün okul ekranlarında uyarı belirir, isterseniz alarm sesi çalar, okulun bütün yöneticilerine bildirim gider. Durum çözülünce ekranlar kendiliğinden eski hâline döner.'],
  ['Telefondan yönetin',
    'Zil saatlerini değiştirmek, özel bir anons çalmak ya da koridor ekranına duyuru eklemek için okulda olmanız gerekmez. Panel telefona uygulama gibi kurulur; hangi bilgisayarın açık olduğunu ve ekranında ne göründüğünü oradan görürsünüz.']
]

const ADIMLAR = [
  ['Başvurun', 'Başvuru formunu doldurun. Yetkinizi okulun resmî kaydındaki telefon ya da e-posta üzerinden teyit ederiz.'],
  ['Kurulum', 'Zil programı okul bilgisayarına kurulur ve onaylı eşleştirmeyle panelinize bağlanır.'],
  ['Yönetin', 'Zil saatlerini, koridor ekranını ve duyuruları panelden, telefondan ya da bilgisayardan yönetirsiniz.']
]

const DAHIL = [
  ['Kurulum ve eşleştirme', 'Zil programını okul bilgisayarına biz kurar, panelinize onaylı eşleştirmeyle bağlarız.'],
  ['Okul bilgisayarı için zil programı', 'Windows’ta çalışır; internet kesilse de çizelgeye göre çalar.'],
  ['Yönetim paneli', 'Telefondan ve bilgisayardan; uygulama gibi ana ekrana eklenebilir.'],
  ['Koridor ekranı', 'Sıradaki zil, nöbetçi öğretmen, günün yemeği, hava durumu ve duyurular.'],
  ['Sesli ve yazılı anons', 'Telefondan konuşun ya da yazın; anons okulun hoparlöründen duyulsun.'],
  ['Acil durum ve deprem uyarısı', 'Tek dokunuşla acil durum duyurusu; isteğe bağlı otomatik deprem alarmı.'],
  ['Kendiliğinden güncellemeler', 'Yeni sürümler okul bilgisayarlarına kendiliğinden gelir; elle kurulum gerekmez.'],
  ['Destek', 'Panelden destek talebi açın; yanıtı yine panelde görün.']
]

const GUVENLIK = [
  ['Okullar birbirini göremez', 'Her okulun yöneticisi yalnızca kendi okulunun bilgisayarlarını ve verisini görür.'],
  ['İki adımlı doğrulama', 'Panele girişte telefondaki doğrulama uygulamasından kod istenebilir.'],
  ['Onaylı eşleştirme', 'Bir bilgisayar, yönetici panelde ekranda görünen kodu onaylamadan bağlanamaz.'],
  ['Bağlantıya muhtaç değil', 'Zil çizelgesi bilgisayarda saklanır; internet yalnızca uzaktan yönetim için gerekir.']
]

const ROLLER = [
  ['Müdür', 'Okulun her şeyini yönetir; hesap açar, rol verir, erişimi kapatır.'],
  ['Müdür yardımcısı', 'Zil çizelgesi, koridor ekranı, duyurular, nöbet planı ve acil durum.'],
  ['Öğretmen', 'Telefondan sesli ya da yazılı anons, duyuru ve kayan yazı; nöbet planını ve panoyu görür.'],
  ['Teknik sorumlu', 'Bilgisayar eşleştirme, TV ve ekran kontrolü, uzaktan program kurulumu, destek talepleri.']
]

const PAKETLER = [
  { ad: 'Temel', fiyat: '4.900', not: 'Tek zil bilgisayarı olan okullar için.', oneri: false,
    maddeler: ['1 okul bilgisayarı (zil programı)', 'Zil çizelgesi ve tatil takvimi', 'Telefondan ve bilgisayardan yönetim paneli', 'Kendiliğinden güncellemeler', 'Panelden destek talebi'] },
  { ad: 'Standart', fiyat: '9.900', not: 'Zil ve koridor ekranı birlikte.', oneri: true,
    maddeler: ['Temel paketteki her şey', '1 koridor ekranı (TV)', 'Sesli ve yazılı anons', 'Acil durum ve deprem uyarısı', 'Müdür, yardımcı, öğretmen ve teknik sorumlu hesapları'] },
  { ad: 'Kurumsal', fiyat: '19.900', not: 'Birden çok bina ya da ekranı olan okullar için.', oneri: false,
    maddeler: ['Standart paketteki her şey', '3 cihaza kadar (bilgisayar ya da TV)', 'Öncelikli destek', 'Uzaktan kurulum ve kısa eğitim', 'Okul verisinin düzenli yedeği'] }
]

const SSS = [
  ['İnternet kesilirse zil çalar mı?', 'Evet. Zil programı okul bilgisayarında çalışır ve kayıtlı çizelgeyi yerelde tutar. İnternet yalnızca panelden yaptığınız değişikliklerin bilgisayara ulaşması ve uzaktan izleme için gerekir.'],
  ['Hangi bilgisayar gerekiyor?', 'Windows 10 ya da 11 (64 bit) yüklü, zil hoparlörüne bağlı bir bilgisayar yeterlidir. Koridor ekranı için aynı bilgisayara bir TV ya da monitör bağlanır.'],
  ['Başvurudan sonra ne oluyor?', 'İlk yanıt 4 saat içinde gelir. Yetkinizi okulun resmî kaydındaki iletişim bilgileri üzerinden teyit ettikten sonra hesabınız açılır ve kurulum planlanır.'],
  ['Okulda birden fazla yönetici olabilir mi?', 'Evet. Müdür ve müdür yardımcıları ayrı hesaplarla aynı okulu yönetebilir; her hesap için iki adımlı doğrulama açılabilir.'],
  ['Ders saatlerimiz farklı, uyar mı?', 'Evet. Ders ve teneffüs süreleri, cuma çizelgesi, sınav günleri ve özel günler okulunuza göre ayarlanır. Mevcut zil çizelgenizi dosyadan da aktarabilirsiniz.']
]

const ZIL_SAATLERI = [['1. ders', '08:30'], ['2. ders', '09:20'], ['3. ders', '10:10'], ['4. ders', '11:00'], ['5. ders', '11:50'], ['6. ders', '13:10']]

const IKON = {
  zil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M12 3v2"/></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
}

function tanitimSayfasi (mesaj) {
  const ac = Boolean(mesaj)
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Okulların zil çizelgesi, koridor ekranı ve acil durum duyuruları tek panelden. İnternet kesilse de zil çalar; kurulumu biz yapıyoruz.">
<meta name="theme-color" content="#087f8c">
<title>Zeax Okul Zili · Okul zili, koridor ekranı ve duyuru sistemi</title>
<link rel="stylesheet" href="/tanitim.css">
</head>
<body class="tanitim">
<header class="ust">
  <div class="ust-ic">
    <span class="marka"><span class="isaret">${IKON.zil}</span><span>Zeax <b>Okul Zili</b></span></span>
    <nav class="menu" aria-label="Ana menü">
      <span>Özellikler</span><span>Nasıl çalışır?</span><span>Paketler</span><span>Sorular</span><span>İletişim</span>
    </nav>
    <button type="button" class="dugme kucuk">Okuluma istiyorum</button>
  </div>
</header>

<main>
  <section class="kahraman">
    <div class="kahraman-yazi">
      <p class="rozet"><i aria-hidden="true"></i>Okul ekranı · zil · sesli anons</p>
      <h1>Okulunuzun ekranı, zili ve anonsu <em>tek panelde.</em></h1>
      <p class="giris">Okulunuzun zili çalarken koridordaki ekran sıradaki zili, nöbetçiyi ve günün yemeğini gösterir. İnternet kesilse de zil çalar; kurulumu biz yapıyoruz.</p>
      <div class="dugmeler">
        <button type="button" class="dugme">Okuluma istiyorum</button>
        <button type="button" class="dugme sessiz">Nasıl çalışır?</button>
      </div>
    </div>
    <div class="sahne" aria-label="Örnek okul günü: koridor ekranı">
      <div class="tv">
        <div class="ekran">
          <div class="ekran-ust"><b>Örnek Ortaokulu</b><span>Bugün</span><strong>10:47</strong></div>
          <div class="siradaki"><span>${IKON.zil}Sıradaki zil</span><strong>02:40</strong><small>3. ders bitişi · 10:50</small></div>
          <div class="kutular">
            <div><small>Nöbetçi</small><b>Bahçe · Ayşe Öğretmen</b></div>
            <div><small>Yemek</small><b>Mercimek çorbası, pilav</b></div>
            <div><small>LGS’ye</small><b>214 gün</b></div>
          </div>
          <ol class="saatler">${ZIL_SAATLERI.map(([a, s]) => `<li class="${a === '3. ders' ? 'su-an' : ''}">${a}<small>${s}</small></li>`).join('')}</ol>
          <div class="kayan">Veli toplantısı cuma 14.00’te konferans salonunda · Kitap fuarı pazartesi başlıyor · Servisler 15.40’ta kalkar · Okul kütüphanesi öğle arasında açık</div>
        </div>
      </div>
    </div>
  </section>

  <section class="bolum">
    <h2>Bir zilden fazlası, ama karmaşık değil.</h2>
    <div class="izgara dort">
      ${OZELLIKLER.map(([b, m]) => `<article class="kart"><h3>${b}</h3><p>${m}</p></article>`).join('\n      ')}
    </div>
  </section>

  <section class="bolum acik">
    <h2>Üç adımda okulunuzda.</h2>
    <ol class="adimlar">
      ${ADIMLAR.map(([b, m], i) => `<li><span class="no">${i + 1}</span><div><h3>${b}</h3><p>${m}</p></div></li>`).join('\n      ')}
    </ol>
  </section>

  <section class="bolum">
    <h2>Hizmete neler dahil?</h2>
    <p class="alt">Okulunuz için ayrıca bir şey kurmanız ya da satın almanız gerekmez; kurulumdan desteğe her adımda yanınızdayız.</p>
    <ul class="dahil">
      ${DAHIL.map(([b, m]) => `<li><span class="tik">${IKON.ok}</span><div><b>${b}</b><span>${m}</span></div></li>`).join('\n      ')}
    </ul>
  </section>

  <section class="bolum acik">
    <h2>Okulun verisi okulda kalır.</h2>
    <div class="izgara dort">
      ${GUVENLIK.map(([b, m]) => `<article class="kart"><h3>${b}</h3><p>${m}</p></article>`).join('\n      ')}
    </div>
    <h2 class="ikinci">Herkes kendi işini görür.</h2>
    <p class="alt">Okuldaki her görevli panele kendi hesabıyla girer ve yalnızca kendi işine ait bölümleri görür. Hesapları ve rolleri müdür belirler.</p>
    <div class="izgara dort">
      ${ROLLER.map(([b, m]) => `<article class="kart"><h3>${b}</h3><p>${m}</p></article>`).join('\n      ')}
    </div>
  </section>

  <section class="bolum">
    <h2>Paketler ve fiyatlar</h2>
    <p class="alt">Yıllık, okul başına fiyatlar. Kurulum, eşleştirme ve güncellemeler her pakete dahildir. Erken erişim dönemindeyiz: çevrim içi satın alma ve ödeme henüz açık değil, fiyatlar bilgi amaçlıdır.</p>
    <div class="izgara uc">
      ${PAKETLER.map((p) => `<article class="paket${p.oneri ? ' oneri' : ''}">
        ${p.oneri ? '<span class="etiket">Önerilen</span>' : ''}
        <h3>${p.ad}</h3>
        <p class="fiyat"><b>${p.fiyat} ₺</b> / yıl</p>
        <p class="not">${p.not}</p>
        <ul>${p.maddeler.map((m) => `<li>${m}</li>`).join('')}</ul>
        <button type="button" class="dugme${p.oneri ? '' : ' sessiz'}">Teklif iste</button>
      </article>`).join('\n      ')}
    </div>
    <p class="alt kucuk-yazi">Ek okul bilgisayarı ya da ek koridor ekranı: 990 ₺ / yıl. Fiyatlara KDV dahil değildir; erken erişim süresince değişebilir.</p>
  </section>

  <section class="bolum acik">
    <h2>Sık sorulanlar</h2>
    <dl class="sss">
      ${SSS.map(([s, c]) => `<div><dt>${s}</dt><dd>${c}</dd></div>`).join('\n      ')}
    </dl>
  </section>

  <section class="bolum iletisim">
    <h2>Bize ulaşın.</h2>
    <p class="alt">Sorunuz, iş birliği teklifiniz ya da okulunuz için bir isteğiniz mi var?</p>
    <div class="izgara uc">
      <article class="kart"><h3>E-posta</h3><p>iletisim<span>@</span>zeax.dev</p></article>
      <article class="kart"><h3>Okulunuz için başvurun</h3><p>Yetkiniz teyit edildikten sonra hesabınız açılır.</p></article>
      <article class="kart"><h3>Zeax kullanan okullar</h3><p>Panelde Destek bölümünden talep açın; talebiniz okulunuzun kaydıyla gelir.</p></article>
    </div>
  </section>
</main>

<footer class="alt-bilgi">
  <p><button type="button" class="gizli" id="kod-ac" tabindex="-1" aria-hidden="true">©</button> Zeax · Okul Zili. Bütün hakları saklıdır.</p>
</footer>

<dialog id="kod-pencere" class="pencere" data-ac="${ac ? '1' : '0'}">
  <form method="post" action="/giris" autocomplete="off">
    <label for="kod">Gizli kod</label>
    <input id="kod" name="kod" type="password" autocomplete="current-password" placeholder="XXXX-XXXX-XXXX" required>
    ${mesaj ? `<p class="hata" role="alert">${kacis(mesaj)}</p>` : ''}
    <div class="pencere-alt">
      <button type="button" class="dugme sessiz" id="kod-kapat">Vazgeç</button>
      <button type="submit" class="dugme">Giriş</button>
    </div>
  </form>
</dialog>
<script src="/tanitim.js"></script>
</body>
</html>`
}

module.exports = { tanitimSayfasi }
