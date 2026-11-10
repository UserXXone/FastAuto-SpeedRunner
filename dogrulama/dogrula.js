#!/usr/bin/env node
'use strict'

// Gerçek oyunla seed doğrulama (Faz 2).
//
// Her seed için: geçici bir Minecraft 1.21.1 sunucusu açar (sadece 127.0.0.1),
// keşif botu girer, doğma noktasındaki ağaçlara, yıkık portalın çerçevesine ve
// sandığına bakar, Nether yapılarını ve kaleyi oyunun kendi /locate'iyle bulur.
// Sonra sunucuyu kapatıp dünyayı siler. Sonuçlar dogrulama/veri/sonuclar.json'a
// yazılır, panel oradan okur.
//
//   node dogrulama/dogrula.js                 en iyi 30 doğrulanmamış seed
//   node dogrulama/dogrula.js --adet 10
//   node dogrulama/dogrula.js --adet tumu     bilinen tüm doğrulanmamış seed'ler
//   node dogrulama/dogrula.js --seed 123 --seed 456
//   node dogrulama/dogrula.js --yeniden       daha önce doğrulananları da tekrar dene
//
// Çalışırken bu sunucudaki seed avcısı duraklatılır (RAM yetsin diye), bitince
// geri açılır.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { tumSeedler, DOGRULAMA_DIZIN, DOGRULAMA_SURUM, guncelSonuc, jsonOku } = require('../web/veri')
const { planFrame, findRuin, kindAtFor } = require('../src/portal')
const { fixToolData } = require('../src/dataFix')

fixToolData('1.21.1')  // taş kazmayla ağlayan obsidyen süresi doğru hesaplansın
const { Rcon, jarHazirla, sunucuAc, sunucuKapat, zamanAsimi } = require('./sunucu')

const DUNYA = path.join(__dirname, 'dunya')
const SONUC = path.join(DOGRULAMA_DIZIN, 'sonuclar.json')
const DURUM = path.join(DOGRULAMA_DIZIN, 'durum.json')
const PORT = 25595
const RCON_PORT = 25585
const BELLEK = process.env.MC_BELLEK || '1G'
const SEED_SURE = 6 * 60e3  // bir seed en fazla bu kadar sürsün
const AVCI = 'seed-avci'

// Hız tahminleri (seed avcısıyla aynı): Overworld koşu, Nether arazisi.
const OW_HIZ = 5.6
const NETHER_HIZ = 4.5

// ---------------------------------------------------------------- yardımcılar

const bekle = (ms) => new Promise((r) => setTimeout(r, ms))
const uzak = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

function yazAtomik (yol, veri) {
  fs.mkdirSync(path.dirname(yol), { recursive: true })
  fs.writeFileSync(yol + '.tmp', JSON.stringify(veri, null, 1))
  fs.renameSync(yol + '.tmp', yol)
}

const durum = { calisiyor: true, pid: process.pid, baslangic: Math.floor(Date.now() / 1000), toplam: 0, biten: 0, simdiki: null, asama: '', sonHata: null }
function durumYaz (ek = {}) {
  Object.assign(durum, ek, { guncellendi: Math.floor(Date.now() / 1000) })
  yazAtomik(DURUM, durum)
}
function log (...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a)
}

// ---------------------------------------------------------------- sunucu

function sunucuBaslat (seed, sifre) {
  return sunucuAc({ seed, sifre, dizin: DUNYA, port: PORT, rconPort: RCON_PORT, bellek: BELLEK, ozellikler: { motd: 'FastAuto dogrulama' }, acildi: (p) => { aktifSunucu = p } })
}

// ---------------------------------------------------------------- bot

function botAc () {
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: PORT, username: 'Kesif', version: '1.21.1', auth: 'offline', viewDistance: 'normal', hideErrors: true })
  bot.on('error', () => {})
  const acildi = new Promise((resolve, reject) => {
    bot.once('spawn', resolve)
    bot.once('kicked', (r) => reject(new Error('bot atıldı: ' + JSON.stringify(r))))
    bot.once('end', (r) => reject(new Error('bot bağlantısı koptu: ' + r)))
  })
  return { bot, acildi }
}

async function isinla (bot, rcon, x, y, z) {
  const once = bot.entity.position.clone()
  await rcon.komut(`tp Kesif ${x} ${y} ${z}`)
  for (let i = 0; i < 50 && bot.entity.position.distanceTo(once) < 1 && Math.hypot(x - once.x, z - once.z) > 1; i++) await bekle(100)
  await zamanAsimi(bot.waitForChunksToLoad(), 60e3, 'chunk yükleme')
  await bekle(1500)
}

function idler (bot, filtre) {
  return Object.values(bot.registry.blocksByName).filter((b) => filtre(b.name)).map((b) => b.id)
}

// ---------------------------------------------------------------- tek seed

function locateAyikla (cevap) {
  const m = /\[(-?\d+), (~|-?\d+), (-?\d+)\]/.exec(cevap)
  if (!m) return null
  const tur = /\((minecraft:[a-z_]+)\) is at/.exec(cevap)
  return { x: Number(m[1]), z: Number(m[3]), tur: tur ? tur[1].replace('minecraft:', '') : null }
}

// /locate her zaman en yakını vermiyor (ızgara halkalarında arıyor). Bu yüzden hem
// başlangıç noktasından hem de avcının tahmin ettiği yerden ararız, merkeze en yakını alırız.
async function enYakinYapi (rcon, boyut, yapi, merkez, tahmin) {
  const ara = async (x, z) => locateAyikla(await rcon.komut(`execute in minecraft:${boyut} positioned ${Math.round(x)} 64 ${Math.round(z)} run locate structure ${yapi}`))
  const adaylar = [await ara(merkez[0], merkez[1])]
  if (tahmin) adaylar.push(await ara(tahmin[0], tahmin[1]))
  const iyi = adaylar.filter(Boolean).sort((a, b) => uzak([a.x, a.z], merkez) - uzak([b.x, b.z], merkez))[0]
  if (!iyi) return null
  iyi.tuttu = tahmin ? uzak([iyi.x, iyi.z], tahmin) <= 48 : null
  return iyi
}

async function seedDogrula (seed, yolPuani, tahmin = {}) {
  const sifre = crypto.randomBytes(12).toString('hex')
  let sunucu = null; let rcon = null; let bot = null
  const r = { seed, surum: DOGRULAMA_SURUM, zaman: Math.floor(Date.now() / 1000), yolPuani, notlar: [] }
  try {
    durumYaz({ asama: 'sunucu açılıyor' })
    sunucu = await sunucuBaslat(seed, sifre)
    rcon = new Rcon()
    await rcon.baglan(RCON_PORT, sifre)
    await rcon.komut('gamerule spawnRadius 0')
    await rcon.komut('gamerule doDaylightCycle false')
    await rcon.komut('time set day')

    durumYaz({ asama: 'bot giriyor' })
    const b = botAc(); bot = b.bot
    await zamanAsimi(b.acildi, 60e3, 'bot girişi')
    await rcon.komut('op Kesif')
    await rcon.komut('gamemode creative Kesif')
    await zamanAsimi(bot.waitForChunksToLoad(), 60e3, 'chunk yükleme')
    await bekle(1500)

    // Doğma noktası ve ağaçlar
    durumYaz({ asama: 'doğma noktası' })
    const sp = bot.spawnPoint || bot.entity.position
    r.spawn = [Math.floor(sp.x), Math.floor(sp.z)]
    // Biyomu oyuna sor (mineflayer'ın 1.21 biyom eşlemesi güvenilmez).
    r.biyom = '?'
    if (tahmin.biyom && /^[a-z_]+$/.test(tahmin.biyom)) {
      const c = await rcon.komut(`execute if biome ${r.spawn[0]} ${Math.floor(sp.y)} ${r.spawn[1]} minecraft:${tahmin.biyom}`)
      r.biyom = /passed/i.test(c) ? tahmin.biyom : '?'
      if (r.biyom === '?') r.notlar.push(`doğma biyomu ${tahmin.biyom} değil`)
    }
    const kutukler = bot.findBlocks({
      point: new Vec3(sp.x, sp.y, sp.z),
      matching: idler(bot, (n) => n.endsWith('_log') && !n.startsWith('stripped_')),
      maxDistance: 64,
      count: 400
    })
    const kMes = kutukler.map((p) => uzak([p.x, p.z], r.spawn)).sort((a, c) => a - c)
    r.agac = { kutuk: kutukler.length, enYakin: kMes.length ? Math.round(kMes[0]) : null }

    // Yıkık portal
    durumYaz({ asama: 'yıkık portal' })
    const lp = await enYakinYapi(rcon, 'overworld', '#minecraft:ruined_portal', r.spawn, tahmin.portal)
    if (!lp) throw new Error('yıkık portal bulunamadı')
    await isinla(bot, rcon, lp.x, 200, lp.z)
    await zamanAsimi(bot.waitForChunksToLoad(), 60e3, 'chunk yükleme')
    const yikik = findRuin(bot, lp.x, lp.z, 32, 64)
    if (!yikik) throw new Error('yıkık portalda obsidyen yok')
    r.portal = { tur: lp.tur, konum: [lp.x, lp.z], obsidyen: yikik.obsidian.length, aglayan: yikik.crying.length }

    // Sandık
    if (yikik.chest) {
      durumYaz({ asama: 'portal sandığı' })
      const s = yikik.chest
      await isinla(bot, rcon, s.x + 0.5, s.y + 1, s.z + 0.5)
      try {
        const pencere = await zamanAsimi(bot.openContainer(bot.blockAt(s)), 15e3, 'sandık açma')
        const esya = {}
        for (const it of pencere.containerItems()) esya[it.name] = (esya[it.name] || 0) + it.count
        pencere.close()
        r.portal.sandik = esya
      } catch (e) {
        r.notlar.push('sandık açılamadı: ' + e.message)
      }
    } else {
      r.notlar.push('portal sandığı yok')
    }

    // Çerçeve: botun koşuda kullandığı planlayıcının aynısı (taş kazmayla geldiğini varsayar).
    const sandikObs = (r.portal.sandik && r.portal.sandik.obsidian) || 0
    const plan = planFrame(yikik.obsidian, kindAtFor(bot, ['stone_pickaxe']), sandikObs)
    if (plan) {
      const orta = Math.floor(plan.u0 + plan.w / 2)
      r.portal.konum = plan.axis === 'x' ? [orta, plan.fixed] : [plan.fixed, orta]
      // eksik: koyulacak obsidyen. kir: kırılacak blok. zor: kırması uzun süren (ağlayan obsidyen). sure: tahmini inşa süresi (sn).
      // sivi: portalın içindeki lav/su hücresi (bot taşla kapatıp kurutur).
      r.portal.cerceve = { genislik: plan.w, yukseklik: plan.h, eksik: plan.need, kir: plan.dig.length, zor: plan.hard, sivi: plan.liquid.length, sure: plan.seconds, y: plan.y0 }
      // Su içinde mi? Yüzeyin ne kadar altında?
      let su = 0
      const hucre = (a, y) => (plan.axis === 'x' ? new Vec3(a, y, plan.fixed) : new Vec3(plan.fixed, y, a))
      for (let a = plan.u0; a < plan.u0 + plan.w; a++) {
        for (let y = plan.y0; y <= plan.y0 + plan.h; y++) {
          const bl = bot.blockAt(hucre(a, y))
          if (bl && (bl.name === 'water' || bl.name === 'seagrass' || bl.name === 'kelp' || bl.name === 'kelp_plant')) su++
        }
      }
      const tepe = plan.y0 + plan.h - 1
      let yuzey = tepe
      for (let y = 250; y > tepe; y--) {
        const bl = bot.blockAt(hucre(orta, y))
        if (bl && bl.boundingBox === 'block' && !bl.name.includes('leaves') && !bl.name.endsWith('_log')) { yuzey = y; break }
      }
      r.portal.suda = su >= 3
      r.portal.derinlik = yuzey - tepe          // portalın tepesinin üstündeki toprak/taş kalınlığı
      r.portal.gomulu = r.portal.derinlik >= 3
    } else {
      r.portal.cerceve = null
    }

    // Nether yapıları ve kale (oyunun kendi /locate'i)
    durumYaz({ asama: 'nether yapıları' })
    const ng = [Math.round(r.portal.konum[0] / 8), Math.round(r.portal.konum[1] / 8)]
    const bas = await enYakinYapi(rcon, 'the_nether', 'minecraft:bastion_remnant', ng, tahmin.bastion)
    const fort = await enYakinYapi(rcon, 'the_nether', 'minecraft:fortress', ng, tahmin.fortress)
    durumYaz({ asama: 'kale' })
    const kale = await enYakinYapi(rcon, 'overworld', 'minecraft:stronghold', r.spawn, tahmin.kale)
    if (!bas || !fort || !kale) throw new Error('bastion/fortress/kale bulunamadı')
    r.bastion = [bas.x, bas.z]; r.fortress = [fort.x, fort.z]; r.kale = [kale.x, kale.z]
    // Avcının tahminleri oyunda tuttu mu? (48 blok tolerans)
    r.tuttu = { portal: lp.tuttu, bastion: bas.tuttu, fortress: fort.tuttu, kale: kale.tuttu }
    for (const [k, v] of Object.entries(r.tuttu)) if (v === false) r.notlar.push(`${k} avcının tahmininden farklı yerde`)

    puanla(r)
  } catch (e) {
    r.hata = e.message.split('\n')[0]
    r.hataAyrinti = e.message
  } finally {
    try { if (bot) bot.quit() } catch { /* */ }
    durumYaz({ asama: 'sunucu kapanıyor' })
    await sunucuKapat(sunucu, rcon).catch(() => {})
    if (rcon) rcon.kapat()
    fs.rmSync(DUNYA, { recursive: true, force: true })
  }
  return r
}

// ---------------------------------------------------------------- puan

// Gerçek ölçümlerle "tahmini koşu yolu süresi". Yol puanıyla aynı ölçek (saniye),
// ama oyundan okunan değerlerle ve portal/ağaç cezalarıyla. Görev süreleri
// (blaze, pearl, ejderha) yine dahil değil; onları Faz 3-4'te bot ölçecek.
function puanla (r) {
  const kaleN = [r.kale[0] / 8, r.kale[1] / 8]
  const g = [r.portal.konum[0] / 8, r.portal.konum[1] / 8]
  const r1 = uzak(g, r.bastion) + uzak(r.bastion, r.fortress) + uzak(r.fortress, kaleN)
  const r2 = uzak(g, r.fortress) + uzak(r.fortress, r.bastion) + uzak(r.bastion, kaleN)
  r.netherYol = Math.round(Math.min(r1, r2))
  r.portalYol = Math.round(uzak(r.spawn, r.portal.konum))

  let ek = 0
  const n = r.notlar
  // Odun: en yakın ağaca yürüme (yoksa uzun arama)
  if (r.agac.enYakin == null) { ek += 45; n.push('64 blok içinde ağaç yok') } else ek += r.agac.enYakin / OW_HIZ

  // Portal: çerçeveyi tamamlama süresi, eksik obsidyen ve ateş kaynağı
  const s = r.portal.sandik || {}
  const sandikObs = s.obsidian || 0
  const ates = (s.flint_and_steel || 0) + (s.fire_charge || 0) > 0 ||
    ((s.flint || 0) > 0 && (s.iron_nugget || 0) >= 9)  // çakmaktaşı + 9 demir parçası = çakmak
  const c = r.portal.cerceve
  const eksik = c ? c.eksik : 10
  const tamamlanir = eksik <= sandikObs && !r.portal.suda
  r.portal.ates = ates
  r.portal.yakilabilir = tamamlanir
  if (c) {
    ek += c.sure
    if (c.zor > 0) n.push(`çerçevede kırılması gereken ${c.zor} ağlayan obsidyen var (taş kazmayla tanesi ~1 dk)`)
  }
  if (eksik > sandikObs) {
    const fark = eksik - sandikObs
    ek += Math.min(150, 60 + fark * 10)
    n.push(`portal ${fark} obsidyen eksik (lav dökmek gerek)`)
  }
  if (!ates) { ek += 40; n.push('sandıkta ateş kaynağı yok (demir + çakmaktaşı gerek)') }
  if (r.portal.suda) { ek += 60; n.push('portal su içinde (bot henüz su altında çalışamıyor)') }
  if (r.portal.gomulu) {
    const d = r.portal.derinlik || 0
    ek += Math.max(15, Math.round(d * 0.7))
    n.push(d >= 12 ? `portal yeraltında (${d} blok aşağıda)` : 'portal gömülü')
  }

  r.cezaSn = Math.round(ek)
  r.gercekSure = Math.round((r.portalYol / OW_HIZ + r.netherYol / NETHER_HIZ + ek) * 10) / 10
}

// ---------------------------------------------------------------- avcıyı duraklat / aç

let aktifSunucu = null
let avciBizDurdurduk = false
function avciDurdur () {
  try {
    const a = execFileSync('systemctl', ['is-active', AVCI]).toString().trim()
    if (a === 'active') {
      log('Seed avcısı duraklatılıyor (RAM için)...')
      execFileSync('systemctl', ['stop', AVCI])
      avciBizDurdurduk = true
    }
  } catch { /* zaten durmuş (is-active 3 döner) */ }
}
function avciAc () {
  if (!avciBizDurdurduk) return
  avciBizDurdurduk = false
  try { execFileSync('systemctl', ['start', AVCI]); log('Seed avcısı tekrar açıldı.') } catch (e) { log('Avcı açılamadı:', e.message) }
}

// ---------------------------------------------------------------- ana

function argumanlar () {
  const a = { adet: 30, seedler: [], yeniden: false }
  const v = process.argv.slice(2)
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--adet') { const x = v[++i]; a.adet = x === 'tumu' ? Infinity : Math.max(1, Number(x) || 30) }
    else if (v[i] === '--seed') a.seedler.push(String(v[++i]))
    else if (v[i] === '--yeniden') a.yeniden = true
    else { console.error('Bilinmeyen seçenek:', v[i]); process.exit(1) }
  }
  return a
}

let durduruldu = false
async function main () {
  const arg = argumanlar()
  const sonuclar = jsonOku(SONUC, {})
  const liste = tumSeedler()
  const bilgi = new Map(liste.map((s) => [s.seed, s]))
  let hedef = arg.seedler.length
    ? arg.seedler
    : liste.filter((s) => arg.yeniden || !guncelSonuc(sonuclar[s.seed])).slice(0, arg.adet).map((s) => s.seed)
  hedef = hedef.filter((s) => /^-?\d{1,20}$/.test(s))
  durumYaz({ toplam: hedef.length, biten: 0 })
  if (!hedef.length) { log('Doğrulanacak yeni seed yok.'); return }

  jarHazirla(log)
  avciDurdur()
  for (const seed of hedef) {
    if (durduruldu) break
    durumYaz({ simdiki: seed, asama: 'başlıyor' })
    log(`[${durum.biten + 1}/${hedef.length}] ${seed}`)
    const t = bilgi.get(seed) || {}
    const r = await zamanAsimi(seedDogrula(seed, t.sn ?? null, t), SEED_SURE, 'seed doğrulama')
      .catch((e) => ({ seed, surum: DOGRULAMA_SURUM, zaman: Math.floor(Date.now() / 1000), yolPuani: t.sn ?? null, hata: e.message, notlar: [] }))
    const guncel = jsonOku(SONUC, {})
    guncel[seed] = r
    yazAtomik(SONUC, guncel)
    log(r.hata ? `  HATA: ${r.hata}` : `  yol puanı ${r.yolPuani} -> gerçek ${r.gercekSure} sn | portal eksik ${r.portal.cerceve?.eksik}, sandık obs ${r.portal.sandik?.obsidian || 0}, ateş ${r.portal.ates ? 'var' : 'yok'} | ağaç ${r.agac.enYakin} b`)
    durumYaz({ biten: durum.biten + 1, sonHata: r.hata || durum.sonHata })
  }
}

async function bitir (kod) {
  if (aktifSunucu && aktifSunucu.exitCode === null) aktifSunucu.kill('SIGKILL')
  avciAc()
  fs.rmSync(DUNYA, { recursive: true, force: true })
  durumYaz({ calisiyor: false, simdiki: null, asama: durduruldu ? 'durduruldu' : 'bitti', bitis: Math.floor(Date.now() / 1000) })
  process.exit(kod)
}

for (const sinyal of ['SIGINT', 'SIGTERM']) {
  process.on(sinyal, () => {
    if (durduruldu) return
    durduruldu = true
    log('Durduruluyor: mevcut seed bitince kapanacak (en fazla birkaç dakika)...')
    durumYaz({ asama: 'durduruluyor' })
    setTimeout(() => { log('Zorla kapatılıyor.'); bitir(1) }, 90e3).unref()
  })
}

main().then(() => bitir(0), (e) => { console.error(e); durumYaz({ sonHata: e.message }); bitir(1) })
