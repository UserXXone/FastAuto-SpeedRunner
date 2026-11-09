#!/usr/bin/env node
'use strict'

// Seed avcısı web paneli: sadece görüntüleme, gizli kodla giriş.
// Ek paket yok; sadece 127.0.0.1'de dinler, dışarıya Caddy açar.
//
//   node web/sunucu.js           -> sunucuyu başlat
//   node web/sunucu.js kod       -> yeni rastgele giriş kodu üret
//   node web/sunucu.js kod ABC   -> giriş kodunu ABC yap
//
// Kod değişince tüm açık oturumlar kapanır.

const http = require('http')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')

const PORT = Number(process.env.SEED_PANEL_PORT || 8790)
const HOST = '127.0.0.1'
const AYAR_DIZIN = process.env.SEED_PANEL_AYAR || '/root/.config/fastauto-seed'
const AYAR = path.join(AYAR_DIZIN, 'ayar.json')
const { VERI_DIZIN, YUKLEME_DIZIN, durumTopla, dogrulamaOku, tumSeedler } = require('./veri')
const DAGITIM_DIZIN = path.join(VERI_DIZIN, 'dagitim')
const PANEL_URL = process.env.SEED_PANEL_URL || 'https://seed.zeax.dev'
const MINECRAFT = '1.21.1'
const OTURUM_GUN = 30

// ---------------------------------------------------------------- ayarlar

function ayarOku () {
  try {
    return JSON.parse(fs.readFileSync(AYAR, 'utf8'))
  } catch {
    return null
  }
}

function kodHash (kod, tuz) {
  return crypto.scryptSync(kod, Buffer.from(tuz, 'hex'), 32).toString('hex')
}

function kodBelirle (kod) {
  if (!kod) {
    const harf = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const b = crypto.randomBytes(12)
    kod = Array.from(b, (x) => harf[x % harf.length]).join('')
    kod = `${kod.slice(0, 4)}-${kod.slice(4, 8)}-${kod.slice(8, 12)}`
  }
  if (kod.length < 8) throw new Error('Kod en az 8 karakter olmalı')
  const tuz = crypto.randomBytes(16).toString('hex')
  const ayar = { kodTuz: tuz, kodHash: kodHash(kod, tuz), cerezSirri: crypto.randomBytes(32).toString('hex') }
  fs.mkdirSync(AYAR_DIZIN, { recursive: true, mode: 0o700 })
  fs.writeFileSync(AYAR, JSON.stringify(ayar), { mode: 0o600 })
  return kod
}

// ---------------------------------------------------------------- oturum

function imza (ayar, metin) {
  return crypto.createHmac('sha256', ayar.cerezSirri).update(metin).digest('hex')
}

function oturumOlustur (ayar) {
  const bitis = Date.now() + OTURUM_GUN * 86400e3
  return `${bitis}.${imza(ayar, String(bitis))}`
}

function oturumGecerli (ayar, req) {
  const cerez = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('seed_oturum='))
  if (!cerez) return false
  const [bitis, imz] = cerez.slice('seed_oturum='.length).split('.')
  if (!bitis || !imz || Number(bitis) < Date.now()) return false
  const beklenen = Buffer.from(imza(ayar, bitis))
  const gelen = Buffer.from(imz)
  return beklenen.length === gelen.length && crypto.timingSafeEqual(beklenen, gelen)
}

// Kaba kuvvete karşı: IP başına 5, toplamda 30 hatalı deneme / 15 dk.
const denemeler = new Map()
let genelHata = []
function istemciIp (req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim()
}
function engelliMi (ip) {
  const simdi = Date.now()
  genelHata = genelHata.filter((t) => simdi - t < 15 * 60e3)
  const liste = (denemeler.get(ip) || []).filter((t) => simdi - t < 15 * 60e3)
  denemeler.set(ip, liste)
  return liste.length >= 5 || genelHata.length >= 30
}
function hataKaydet (ip) {
  const simdi = Date.now()
  denemeler.set(ip, [...(denemeler.get(ip) || []), simdi])
  genelHata.push(simdi)
}

// ---------------------------------------------------------------- servis kontrolü

const SERVIS = 'seed-avci'
const DOGRULAMA_BIRIM = 'seed-dogrulama'
const KOK = path.join(__dirname, '..')

function servisDurumu (ad = SERVIS) {
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', ad], { timeout: 5000 }, (err, cikti) => resolve(String(cikti || '').trim() || 'bilinmiyor'))
  })
}

// Doğrulayıcı geçici bir systemd birimi olarak çalışır: panel yeniden başlasa da sürer.
function dogrulamaBaslat (adet) {
  return new Promise((resolve, reject) => {
    execFile('systemd-run', [
      `--unit=${DOGRULAMA_BIRIM}`, '--collect', '--quiet',
      `--property=WorkingDirectory=${KOK}`, '--property=TimeoutStopSec=150', '--property=Nice=5',
      process.execPath, path.join(KOK, 'dogrulama', 'dogrula.js'), '--adet', String(adet)
    ], { timeout: 15000 }, (err, out, hata) => (err ? reject(new Error(String(hata || err.message))) : resolve()))
  })
}

function servisKomut (komut) {
  return new Promise((resolve, reject) => {
    execFile('systemctl', [komut, SERVIS], { timeout: 30000 }, (err) => (err ? reject(err) : resolve()))
  })
}

// ---------------------------------------------------------------- yükleme (Windows PC'ler)

// Anahtar giriş kodundan türetilir: kod değişince eski paketler de geçersiz olur.
function yuklemeAnahtari (ayar) {
  return imza(ayar, 'yukleme-anahtari').slice(0, 32).toUpperCase()
}

function anahtarDogru (ayar, gelen) {
  const a = Buffer.from(yuklemeAnahtari(ayar))
  const b = Buffer.from(String(gelen || '').trim().toUpperCase())
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const tam = (x, min, max) => Number.isInteger(x) && x >= min && x <= max
const nokta = (p) => Array.isArray(p) && p.length === 2 && p.every((v) => tam(v, -30000000, 30000000))
const SEED_RE = /^-?\d{1,20}$/

// Gelen JSON'dan sadece bilinen alanları alır; gerisini atar.
function yuklemeTemizle (d) {
  if (!d || typeof d !== 'object') return null
  if (!tam(d.pc, 1, 64) || !tam(d.toplam, 1, 64) || d.pc > d.toplam) return null
  if (d.minecraft !== MINECRAFT) return null
  const o = {
    program: String(d.program || '').slice(0, 20),
    minecraft: MINECRAFT,
    pc: d.pc,
    toplam: d.toplam,
    guncellendi: Math.floor(Date.now() / 1000),  // PC saati yanlış olabilir
    kaynak: 'yukleme',
    sonSeed: SEED_RE.test(d.sonSeed) ? d.sonSeed : '0'
  }
  for (const k of ['cekirdek', 'oturumSn', 'toplamSn', 'hiz', 'taranan', 'dilim', 'denenenSeed', 'adayDuzen', 'uygunSeed']) {
    o[k] = typeof d[k] === 'number' && isFinite(d[k]) && d[k] >= 0 ? d[k] : 0
  }
  o.enIyiler = (Array.isArray(d.enIyiler) ? d.enIyiler.slice(0, 100) : [])
    .filter((x) => x && SEED_RE.test(x.seed) && typeof x.sn === 'number' && isFinite(x.sn) &&
      nokta(x.spawn) && nokta(x.portal) && nokta(x.bastion) && nokta(x.fortress) && nokta(x.kale) && tam(x.nether, 0, 1e6))
    .map((x) => ({
      seed: x.seed, sn: x.sn, spawn: x.spawn, portal: x.portal, bastion: x.bastion, fortress: x.fortress,
      kale: x.kale, nether: x.nether, biyom: String(x.biyom || '?').slice(0, 40)
    }))
  return o
}

function yuklemeKaydet (o) {
  fs.mkdirSync(YUKLEME_DIZIN, { recursive: true })
  const yol = path.join(YUKLEME_DIZIN, `seedler-pc${o.pc}.txt.json`)
  fs.writeFileSync(yol + '.tmp', JSON.stringify(o))
  fs.renameSync(yol + '.tmp', yol)
}

const sonYukleme = new Map()  // ip -> zaman (çok sık yüklemeyi engelle)

// ---------------------------------------------------------------- windows paketi (zip)

function zipYap (dosyalar) {
  const t = new Date()
  const saat = (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1)
  const gun = ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate()
  const parca = []
  const merkez = []
  let ofs = 0
  for (const f of dosyalar) {
    const ad = Buffer.from(f.ad)
    const crc = zlib.crc32(f.veri)
    const sik = zlib.deflateRawSync(f.veri, { level: 9 })
    const y = Buffer.alloc(30)
    y.writeUInt32LE(0x04034b50, 0); y.writeUInt16LE(20, 4); y.writeUInt16LE(8, 8)
    y.writeUInt16LE(saat, 10); y.writeUInt16LE(gun, 12); y.writeUInt32LE(crc, 14)
    y.writeUInt32LE(sik.length, 18); y.writeUInt32LE(f.veri.length, 22); y.writeUInt16LE(ad.length, 26)
    const m = Buffer.alloc(46)
    m.writeUInt32LE(0x02014b50, 0); m.writeUInt16LE(20, 4); m.writeUInt16LE(20, 6); m.writeUInt16LE(8, 10)
    m.writeUInt16LE(saat, 12); m.writeUInt16LE(gun, 14); m.writeUInt32LE(crc, 16)
    m.writeUInt32LE(sik.length, 20); m.writeUInt32LE(f.veri.length, 24); m.writeUInt16LE(ad.length, 28)
    m.writeUInt32LE(ofs, 42)
    parca.push(y, ad, sik)
    merkez.push(m, ad)
    ofs += 30 + ad.length + sik.length
  }
  const md = Buffer.concat(merkez)
  const son = Buffer.alloc(22)
  son.writeUInt32LE(0x06054b50, 0); son.writeUInt16LE(dosyalar.length, 8); son.writeUInt16LE(dosyalar.length, 10)
  son.writeUInt32LE(md.length, 12); son.writeUInt32LE(ofs, 16)
  return Buffer.concat([...parca, md, son])
}

function windowsPaketi (ayar) {
  const crlf = (x) => Buffer.from(x.replace(/\r?\n/g, '\r\n'))
  return zipYap([
    { ad: 'seed-avcisi/seed-avcisi.exe', veri: fs.readFileSync(path.join(DAGITIM_DIZIN, 'seed-avcisi.exe')) },
    { ad: 'seed-avcisi/baslat.bat', veri: crlf(fs.readFileSync(path.join(DAGITIM_DIZIN, 'baslat.bat'), 'utf8')) },
    { ad: 'seed-avcisi/panel.txt', veri: crlf(`${PANEL_URL}\n${yuklemeAnahtari(ayar)}\n`) },
    {
      ad: 'seed-avcisi/OKU-BENI.txt',
      veri: crlf(`FastAuto Seed Avcisi - Windows paketi

1. Bu klasoru masaustune cikar (zip icinden calistirma).
2. baslat.bat'a cift tikla.
3. Ilk seferde iki soru sorar:
   - Bu bilgisayarin numarasi: her PC'ye farkli numara (1, 2, 3, 4, 5).
     VDS 6 numarali, onu kullanma.
   - Toplam kac bilgisayar: hepsinde ayni sayi (6).
4. Sonuclar 30 saniyede bir ${PANEL_URL} paneline otomatik gider.
   Ekranda "Panele yukleme: tamam" yazmali.

panel.txt gizli yukleme anahtarini icerir, kimseyle paylasma.
`)
    }
  ])
}

// ---------------------------------------------------------------- sayfalar

const STIL = fs.readFileSync(path.join(__dirname, 'stil.css'), 'utf8')
const UYGULAMA = fs.readFileSync(path.join(__dirname, 'uygulama.js'), 'utf8')

function sayfa (baslik, govde) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${baslik}</title><link rel="stylesheet" href="/stil.css"></head><body>${govde}</body></html>`
}

function girisSayfasi (mesaj) {
  return sayfa('Seed Avcısı', `
<main class="giris">
  <h1>Seed Avcısı</h1>
  <p class="soluk">Devam etmek için gizli kodu gir.</p>
  <form method="post" action="/giris">
    <input name="kod" type="password" autocomplete="current-password" placeholder="XXXX-XXXX-XXXX" autofocus required>
    <button type="submit">Giriş</button>
  </form>
  ${mesaj ? `<p class="hata">${mesaj}</p>` : ''}
</main>`)
}

function panelSayfasi () {
  return sayfa('Seed Avcısı — Panel', `
<header><h1>Seed Avcısı <span class="soluk">Minecraft 1.21.1</span></h1>
<a class="cikis" href="/cikis">Çıkış</a></header>
<main>
  <section id="ozet" class="kartlar"></section>
  <div class="kontrol"><button id="duraklat" type="button" disabled>…</button>
  <span class="soluk" id="kontrolBilgi">Sadece bu sunucudaki (VDS) taramayı yönetir. Duraklatınca ilerleme kaydedilir, devam edince kaldığı yerden sürer.</span></div>
  <h2>Bilgisayarlar</h2>
  <section id="pcler" class="kartlar"></section>
  <h2>Gerçek oyunla doğrulama <span class="soluk">(Minecraft 1.21.1 sunucusunda tek tek açıp bakar)</span></h2>
  <div class="kart">
    <div class="kontrol">
      <label>En iyi <select id="dAdet"><option>10</option><option selected>30</option><option>50</option><option>100</option><option>200</option><option>500</option><option>1000</option><option value="tumu">Tümü</option></select> doğrulanmamış seed'i</label>
      <button id="dBaslat" type="button">Doğrula</button>
      <button id="dDurdur" type="button" class="ikincil">Durdur</button>
      <span id="dBilgi" class="soluk"></span>
    </div>
    <p class="soluk">Seed başına ~40 sn (100 seed ≈ 1 saat, 1000 seed ≈ 11 saat). Çalışırken bu sunucudaki avcı duraklatılır, bitince kendiliğinden açılır.
    <b>Gerçek süre</b> = oyundan ölçülen yol + ağaca yürüme + portal cezaları (eksik obsidyen, çakmak yok, su/gömülü).
    Görev süreleri (blaze, pearl, ejderha) henüz dahil değil.</p>
  </div>
  <div class="tablo-kutu"><table id="dogrulanan"><thead><tr>
    <th>#</th><th>Seed</th><th>Gerçek</th><th>Yol puanı</th><th>Portal</th><th>Sandık</th><th>Ağaç</th><th>Nether yolu</th><th>Notlar</th>
  </tr></thead><tbody></tbody></table></div>

  <h2>En iyi seed'ler <span class="soluk">(yol puanı = tahmini yol süresi saniye, düşük = iyi; oyunun tamamı değil)</span></h2>
  <div class="tablo-kutu"><table id="seedler"><thead><tr>
    <th>#</th><th>Seed</th><th>Yol puanı</th><th>Gerçek</th><th>Biyom</th><th>Portal</th><th>Nether yolu</th><th>Kale</th><th>PC</th>
  </tr></thead><tbody></tbody></table></div>
  <p class="soluk" id="guncelleme"></p>
  <h2>Windows bilgisayar ekle</h2>
  <div class="kart yardim">
    <p><a class="dugme" href="/indir/seed-avcisi-windows.zip">Windows paketini indir (.zip)</a></p>
    <ol>
      <li>Zip'i bilgisayarda masaüstüne çıkar, <b>baslat.bat</b>'a çift tıkla.</li>
      <li>Numara sorunca her PC'ye farklı numara ver (<b>1–5</b>; VDS 6 numara). Toplam: <b>6</b>.</li>
      <li>Sonuçlar 30 sn'de bir buraya kendiliğinden gelir. Program ekranında “Panele yükleme: tamam” yazmalı.</li>
    </ol>
    <p class="soluk">Paket gizli yükleme anahtarını içerir, paylaşma. Giriş kodunu değiştirirsen paketi yeniden indir.</p>
    <p class="soluk">Otomatik yükleme çalışmazsa (eski Windows 7): PC'deki <code>seedler-pcN.txt.json</code> dosyasını buradan yükle:
      <input type="file" id="elleDosya" accept=".json"> <span id="elleSonuc"></span></p>
  </div>
</main>
<script src="/uygulama.js"></script>`)
}

// ---------------------------------------------------------------- sunucu

function gonder (res, kod, tur, govde, ek = {}) {
  res.writeHead(kod, {
    'Content-Type': tur,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'",
    ...ek
  })
  res.end(govde)
}

function govdeOku (req, sinir = 2048) {
  return new Promise((resolve, reject) => {
    let veri = ''
    req.on('data', (p) => {
      veri += p
      if (veri.length > sinir) {
        reject(new Error('çok büyük'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(veri))
    req.on('error', reject)
  })
}

async function istek (req, res) {
  const ayar = ayarOku()
  if (!ayar) return gonder(res, 503, 'text/plain; charset=utf-8', 'Panel kodu belirlenmemiş: node web/sunucu.js kod')
  const url = new URL(req.url, 'http://x')
  const girisli = oturumGecerli(ayar, req)

  if (url.pathname === '/stil.css') return gonder(res, 200, 'text/css; charset=utf-8', STIL)

  if (url.pathname === '/giris' && req.method === 'POST') {
    const ip = istemciIp(req)
    if (engelliMi(ip)) return gonder(res, 429, 'text/html; charset=utf-8', girisSayfasi('Çok fazla hatalı deneme. 15 dakika sonra tekrar dene.'))
    let kod = ''
    try {
      kod = new URLSearchParams(await govdeOku(req)).get('kod') || ''
    } catch {
      return gonder(res, 413, 'text/plain', 'çok büyük')
    }
    const beklenen = Buffer.from(ayar.kodHash, 'hex')
    const gelen = Buffer.from(kodHash(kod.trim().toUpperCase(), ayar.kodTuz), 'hex')
    if (!crypto.timingSafeEqual(beklenen, gelen)) {
      hataKaydet(ip)
      await new Promise((r) => setTimeout(r, 800))
      return gonder(res, 401, 'text/html; charset=utf-8', girisSayfasi('Kod yanlış.'))
    }
    return gonder(res, 303, 'text/plain', '', {
      Location: '/',
      'Set-Cookie': `seed_oturum=${oturumOlustur(ayar)}; Path=/; Max-Age=${OTURUM_GUN * 86400}; HttpOnly; Secure; SameSite=Strict`
    })
  }

  if (url.pathname === '/api/yukle' && req.method === 'POST') {
    const ip = istemciIp(req)
    if (engelliMi(ip)) return gonder(res, 429, 'text/plain; charset=utf-8', 'Çok fazla hatalı deneme')
    if (!anahtarDogru(ayar, req.headers['x-yukleme-anahtari'])) {
      hataKaydet(ip)
      return gonder(res, 401, 'text/plain; charset=utf-8', 'Anahtar yanlış')
    }
    const simdi = Date.now()
    if (simdi - (sonYukleme.get(ip) || 0) < 3000) return gonder(res, 429, 'text/plain; charset=utf-8', 'Çok sık')
    sonYukleme.set(ip, simdi)
    let o
    try {
      o = yuklemeTemizle(JSON.parse(await govdeOku(req, 256 * 1024)))
    } catch {
      return gonder(res, 400, 'text/plain; charset=utf-8', 'Hatalı JSON')
    }
    if (!o) return gonder(res, 400, 'text/plain; charset=utf-8', 'Geçersiz veri (sürüm ya da pc numarası)')
    yuklemeKaydet(o)
    return gonder(res, 200, 'text/plain; charset=utf-8', 'tamam')
  }

  if (url.pathname === '/cikis') {
    return gonder(res, 303, 'text/plain', '', { Location: '/', 'Set-Cookie': 'seed_oturum=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict' })
  }

  if (!girisli) {
    if (url.pathname === '/') return gonder(res, 200, 'text/html; charset=utf-8', girisSayfasi())
    return gonder(res, 401, 'text/plain; charset=utf-8', 'Giriş gerekli')
  }

  if (url.pathname === '/') return gonder(res, 200, 'text/html; charset=utf-8', panelSayfasi())
  if (url.pathname === '/uygulama.js') return gonder(res, 200, 'text/javascript; charset=utf-8', UYGULAMA)
  if (url.pathname === '/api/durum') {
    const d = durumTopla()
    d.servis = await servisDurumu()
    const dg = dogrulamaOku()
    const liste = Object.values(dg.sonuclar)
    d.dogrulama = {
      calisiyor: (await servisDurumu(DOGRULAMA_BIRIM)) === 'active',
      durum: dg.durum,
      sayi: liste.length,
      bekleyen: tumSeedler().filter((x) => !dg.sonuclar[x.seed]).length,
      enIyiler: liste.filter((r) => !r.hata).sort((a, b) => a.gercekSure - b.gercekSure).slice(0, 50),
      hatalar: liste.filter((r) => r.hata).slice(-5)
    }
    for (const s of d.enIyiler) {
      const r = dg.sonuclar[s.seed]
      if (r) s.dogrulama = r.hata ? { hata: r.hata } : { gercekSure: r.gercekSure, portal: r.portal, notlar: r.notlar }
    }
    return gonder(res, 200, 'application/json; charset=utf-8', JSON.stringify(d))
  }
  if (url.pathname === '/indir/seed-avcisi-windows.zip') {
    let zip
    try {
      zip = windowsPaketi(ayar)
    } catch (err) {
      console.error(err)
      return gonder(res, 500, 'text/plain; charset=utf-8', 'Paket hazırlanamadı (seed-avcisi/dagitim eksik)')
    }
    return gonder(res, 200, 'application/zip', zip, { 'Content-Disposition': 'attachment; filename="seed-avcisi-windows.zip"' })
  }
  if (url.pathname === '/api/yukle-elle' && req.method === 'POST') {
    if (req.headers['x-panel'] !== '1') return gonder(res, 403, 'text/plain; charset=utf-8', 'Yasak')
    let o
    try {
      o = yuklemeTemizle(JSON.parse(await govdeOku(req, 256 * 1024)))
    } catch {
      return gonder(res, 400, 'text/plain; charset=utf-8', 'Dosya okunamadı (seedler-pcN.txt.json olmalı)')
    }
    if (!o) return gonder(res, 400, 'text/plain; charset=utf-8', 'Geçersiz dosya (sürüm 1.21.1 ve pc numarası olmalı)')
    o.guncellendi = 0  // elle yüklenen PC çevrimiçi sayılmasın
    yuklemeKaydet(o)
    return gonder(res, 200, 'text/plain; charset=utf-8', `PC ${o.pc} yüklendi (${o.enIyiler.length} seed)`)
  }
  if (url.pathname === '/api/dogrulama' && req.method === 'POST') {
    if (req.headers['x-panel'] !== '1') return gonder(res, 403, 'text/plain; charset=utf-8', 'Yasak')
    let g
    try {
      g = JSON.parse(await govdeOku(req))
    } catch {
      return gonder(res, 400, 'text/plain; charset=utf-8', 'Hatalı istek')
    }
    const aktif = (await servisDurumu(DOGRULAMA_BIRIM)) === 'active'
    try {
      if (g.eylem === 'baslat') {
        if (aktif) return gonder(res, 409, 'text/plain; charset=utf-8', 'Zaten çalışıyor')
        const adet = g.adet === 'tumu' ? 'tumu' : Math.max(1, Math.min(100000, Math.floor(Number(g.adet)) || 30))
        await dogrulamaBaslat(adet)
      } else if (g.eylem === 'durdur') {
        if (aktif) execFile('systemctl', ['stop', DOGRULAMA_BIRIM], { timeout: 200000 }, () => {})
      } else {
        return gonder(res, 400, 'text/plain; charset=utf-8', 'Hatalı eylem')
      }
    } catch (err) {
      console.error(err)
      return gonder(res, 500, 'text/plain; charset=utf-8', 'Başlatılamadı: ' + err.message.slice(0, 200))
    }
    return gonder(res, 200, 'text/plain; charset=utf-8', 'tamam')
  }
  if (url.pathname === '/api/tarama' && req.method === 'POST') {
    if ((await servisDurumu(DOGRULAMA_BIRIM)) === 'active') {
      return gonder(res, 409, 'application/json; charset=utf-8', JSON.stringify({ hata: 'Doğrulama sürerken avcı otomatik yönetiliyor' }))
    }
    // Çerez SameSite=Strict; ayrıca özel başlık şart (başka siteden form gönderilemez).
    if (req.headers['x-panel'] !== '1') return gonder(res, 403, 'text/plain; charset=utf-8', 'Yasak')
    let eylem = ''
    try {
      eylem = JSON.parse(await govdeOku(req)).eylem
    } catch {
      return gonder(res, 400, 'text/plain; charset=utf-8', 'Hatalı istek')
    }
    if (eylem !== 'duraklat' && eylem !== 'surdur') return gonder(res, 400, 'text/plain; charset=utf-8', 'Hatalı eylem')
    try {
      await servisKomut(eylem === 'duraklat' ? 'stop' : 'start')
    } catch (err) {
      console.error(err)
      return gonder(res, 500, 'application/json; charset=utf-8', JSON.stringify({ hata: 'systemctl başarısız' }))
    }
    return gonder(res, 200, 'application/json; charset=utf-8', JSON.stringify({ servis: await servisDurumu() }))
  }
  return gonder(res, 404, 'text/plain; charset=utf-8', 'Bulunamadı')
}

// ---------------------------------------------------------------- başlat

if (process.argv[2] === 'kod') {
  const kod = kodBelirle(process.argv[3] && process.argv[3].trim().toUpperCase())
  console.log(`Yeni giriş kodu: ${kod}\n(Eski oturumların hepsi kapandı.)`)
} else {
  http.createServer((req, res) => {
    istek(req, res).catch((err) => {
      console.error(err)
      if (!res.headersSent) gonder(res, 500, 'text/plain', 'Sunucu hatası')
    })
  }).listen(PORT, HOST, () => console.log(`Seed paneli: http://${HOST}:${PORT}  (veri: ${VERI_DIZIN})`))
}
