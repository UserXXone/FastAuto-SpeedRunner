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

const PORT = Number(process.env.SEED_PANEL_PORT || 8790)
const HOST = '127.0.0.1'
const AYAR_DIZIN = process.env.SEED_PANEL_AYAR || '/root/.config/fastauto-seed'
const AYAR = path.join(AYAR_DIZIN, 'ayar.json')
const VERI_DIZIN = process.env.SEED_VERI_DIZIN || path.join(__dirname, '..', 'seed-avcisi')
const OTURUM_GUN = 30
const CEVRIMDISI_SN = 60

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

function servisDurumu () {
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', SERVIS], { timeout: 5000 }, (err, cikti) => resolve(String(cikti || '').trim() || 'bilinmiyor'))
  })
}

function servisKomut (komut) {
  return new Promise((resolve, reject) => {
    execFile('systemctl', [komut, SERVIS], { timeout: 30000 }, (err) => (err ? reject(err) : resolve()))
  })
}

// ---------------------------------------------------------------- veri

function durumTopla () {
  const pcler = []
  const seedler = new Map()
  let dosyalar = []
  try {
    dosyalar = fs.readdirSync(VERI_DIZIN).filter((f) => f.endsWith('.txt.json'))
  } catch { /* dizin yok */ }
  for (const f of dosyalar) {
    let d
    try {
      d = JSON.parse(fs.readFileSync(path.join(VERI_DIZIN, f), 'utf8'))
    } catch {
      continue
    }
    const yas = Date.now() / 1000 - d.guncellendi
    pcler.push({
      pc: d.pc,
      toplam: d.toplam,
      cekirdek: d.cekirdek,
      cevrimici: yas < CEVRIMDISI_SN,
      sonGorulme: d.guncellendi,
      oturumSn: d.oturumSn,
      toplamSn: d.toplamSn,
      hiz: d.hiz,
      taranan: d.taranan,
      dilim: d.dilim,
      sonSeed: d.sonSeed,
      denenenSeed: d.denenenSeed,
      uygunSeed: d.uygunSeed,
      minecraft: d.minecraft
    })
    for (const s of d.enIyiler || []) {
      const eski = seedler.get(s.seed)
      if (!eski || s.sn < eski.sn) seedler.set(s.seed, { ...s, pc: d.pc })
    }
  }
  pcler.sort((a, b) => a.pc - b.pc)
  const enIyiler = [...seedler.values()].sort((a, b) => a.sn - b.sn).slice(0, 100)
  return { zaman: Math.floor(Date.now() / 1000), pcler, enIyiler }
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
  <h2>En iyi seed'ler <span class="soluk">(sn = tahmini yol süresi, düşük = iyi)</span></h2>
  <div class="tablo-kutu"><table id="seedler"><thead><tr>
    <th>#</th><th>Seed</th><th>sn</th><th>Biyom</th><th>Portal</th><th>Nether yolu</th><th>Kale</th><th>PC</th>
  </tr></thead><tbody></tbody></table></div>
  <p class="soluk" id="guncelleme"></p>
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
    return gonder(res, 200, 'application/json; charset=utf-8', JSON.stringify(d))
  }
  if (url.pathname === '/api/tarama' && req.method === 'POST') {
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
