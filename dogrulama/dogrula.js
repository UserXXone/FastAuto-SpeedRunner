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
//   node dogrulama/dogrula.js --seed 123 --seed 456
//   node dogrulama/dogrula.js --yeniden       daha önce doğrulananları da tekrar dene
//
// Çalışırken bu sunucudaki seed avcısı duraklatılır (RAM yetsin diye), bitince
// geri açılır.

const fs = require('fs')
const path = require('path')
const net = require('net')
const crypto = require('crypto')
const { spawn, execFileSync } = require('child_process')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { durumTopla, DOGRULAMA_DIZIN, jsonOku } = require('../web/veri')

const JAR = process.env.MC_SUNUCU_JAR || path.join(__dirname, 'sunucu', 'server-1.21.1.jar')
const JAR_SHA1 = '59353fb40c36d304f2035d51e7d6e6baa98dc05c'
const JAR_URL = `https://piston-data.mojang.com/v1/objects/${JAR_SHA1}/server.jar`
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

function zamanAsimi (soz, ms, ad) {
  let t
  return Promise.race([soz, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${ad}: zaman aşımı`)), ms) })])
    .finally(() => clearTimeout(t))
}

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

// ---------------------------------------------------------------- RCON

class Rcon {
  constructor () { this.id = 10; this.bekleyen = new Map(); this.tampon = Buffer.alloc(0) }

  baglan (port, sifre) {
    return new Promise((resolve, reject) => {
      this.s = net.createConnection(port, '127.0.0.1')
      this.s.on('error', reject)
      this.s.on('data', (d) => this.oku(d))
      this.s.on('connect', () => {
        this.bekleyen.set(1, (paket) => (paket.id === -1 ? reject(new Error('RCON şifresi yanlış')) : resolve()))
        this.gonder(1, 3, sifre)
      })
    })
  }

  gonder (id, tur, govde) {
    const g = Buffer.from(govde, 'utf8')
    const b = Buffer.alloc(14 + g.length)
    b.writeInt32LE(10 + g.length, 0); b.writeInt32LE(id, 4); b.writeInt32LE(tur, 8); g.copy(b, 12)
    this.s.write(b)
  }

  oku (d) {
    this.tampon = Buffer.concat([this.tampon, d])
    while (this.tampon.length >= 4) {
      const uz = this.tampon.readInt32LE(0)
      if (this.tampon.length < uz + 4) break
      const id = this.tampon.readInt32LE(4)
      const tur = this.tampon.readInt32LE(8)
      const govde = this.tampon.subarray(12, uz + 2).toString('utf8')
      this.tampon = this.tampon.subarray(uz + 4)
      if (tur === 0 && id === 1) continue  // bazı sürümler auth'tan önce boş paket yollar
      const cb = this.bekleyen.get(id === -1 ? 1 : id)
      if (cb) { this.bekleyen.delete(id === -1 ? 1 : id); cb({ id, tur, govde }) }
    }
  }

  komut (k, ms = 120e3) {
    const id = ++this.id
    const soz = new Promise((resolve) => this.bekleyen.set(id, (p) => resolve(p.govde)))
    this.gonder(id, 2, k)
    return zamanAsimi(soz, ms, `rcon "${k}"`)
  }

  kapat () { try { this.s.destroy() } catch { /* */ } }
}

// ---------------------------------------------------------------- sunucu

function jarHazirla () {
  if (fs.existsSync(JAR)) return
  fs.mkdirSync(path.dirname(JAR), { recursive: true })
  log('Sunucu dosyası indiriliyor (Mojang)...')
  execFileSync('curl', ['-fsSL', '-o', JAR + '.tmp', JAR_URL])
  const sha = crypto.createHash('sha1').update(fs.readFileSync(JAR + '.tmp')).digest('hex')
  if (sha !== JAR_SHA1) { fs.rmSync(JAR + '.tmp'); throw new Error('İndirilen sunucu dosyasının imzası tutmadı') }
  fs.renameSync(JAR + '.tmp', JAR)
}

function portBos (port) {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '0.0.0.0')
  })
}

async function sunucuAc (seed, sifre) {
  for (const p of [PORT, RCON_PORT]) {
    if (!(await portBos(p))) throw new Error(`port ${p} dolu (başka bir sunucu açık kalmış olabilir)`)
  }
  fs.rmSync(DUNYA, { recursive: true, force: true })
  fs.mkdirSync(DUNYA, { recursive: true })
  fs.writeFileSync(path.join(DUNYA, 'eula.txt'), 'eula=true\n')
  fs.writeFileSync(path.join(DUNYA, 'server.properties'), [
    `level-seed=${seed}`,
    'online-mode=false',       // sadece 127.0.0.1'de dinliyor, dışarıdan girilemez
    'server-ip=127.0.0.1',
    `server-port=${PORT}`,
    'enable-rcon=true',
    `rcon.port=${RCON_PORT}`,
    `rcon.password=${sifre}`,
    'view-distance=6',
    'simulation-distance=4',
    'spawn-protection=0',
    'difficulty=peaceful',
    'max-players=2',
    'motd=FastAuto dogrulama',
    'sync-chunk-writes=false',
    'enable-status=false',
    ''
  ].join('\n'))
  const p = spawn('java', [`-Xms256M`, `-Xmx${BELLEK}`, '-XX:+UseSerialGC', '-jar', JAR, 'nogui'], { cwd: DUNYA, stdio: ['pipe', 'pipe', 'pipe'] })
  const son = []
  const hazir = new Promise((resolve, reject) => {
    const satir = (d) => {
      for (const l of String(d).split('\n')) {
        if (!l.trim()) continue
        son.push(l); if (son.length > 30) son.shift()
        if (/RCON running on/.test(l)) resolve()
      }
    }
    p.stdout.on('data', satir)
    p.stderr.on('data', satir)
    p.on('exit', (k) => reject(new Error(`sunucu kapandı (kod ${k}):\n${son.slice(-8).join('\n')}`)))
  })
  p.on('error', () => {})
  aktifSunucu = p
  await zamanAsimi(hazir, 4 * 60e3, 'sunucu açılışı')
  return p
}

async function sunucuKapat (p, rcon) {
  if (!p || p.exitCode !== null) return
  const cikti = new Promise((r) => p.once('exit', r))
  try { if (rcon) await rcon.komut('stop', 10e3) } catch { try { p.stdin.write('stop\n') } catch { /* */ } }
  try {
    await zamanAsimi(cikti, 60e3, 'sunucu kapanışı')
  } catch {
    p.kill('SIGKILL')
    await cikti
  }
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

// ---------------------------------------------------------------- yıkık portal çerçevesi

// Obsidyenlerden portalın düzlemini ve çerçevesini bulur; eksik blok sayısını tahmin eder.
// Çerçeve köşeleri sayılmaz (Minecraft köşesiz portalı da yakar). Ağlayan obsidyen işe yaramaz.
function cerceveAnaliz (obs, aglayan) {
  const hepsi = [...obs.map((p) => ({ p, iyi: true })), ...aglayan.map((p) => ({ p, iyi: false }))]
  if (!hepsi.length) return null
  const gruplar = new Map()
  for (const b of hepsi) {
    for (const [eksen, sabit] of [['x', b.p.z], ['z', b.p.x]]) {
      const k = `${eksen}:${sabit}`
      if (!gruplar.has(k)) gruplar.set(k, { eksen, sabit, bloklar: [] })
      gruplar.get(k).bloklar.push(b)
    }
  }
  const g = [...gruplar.values()].sort((a, b) => b.bloklar.length - a.bloklar.length)[0]
  const u = (p) => (g.eksen === 'x' ? p.x : p.z)
  const izgara = new Map(g.bloklar.map((b) => [`${u(b.p)},${b.p.y}`, b.iyi]))
  const us = g.bloklar.map((b) => u(b.p))
  const ys = g.bloklar.map((b) => b.p.y)
  let u0 = Math.min(...us); let u1 = Math.max(...us)
  let y0 = Math.min(...ys); let y1 = Math.max(...ys)
  // En küçük çalışan çerçeve 4 geniş x 5 yüksek.
  if (u1 - u0 + 1 < 4) u1 = u0 + 3
  if (y1 - y0 + 1 < 5) y1 = y0 + 4
  let cerceve = 0; let var_ = 0
  for (let a = u0; a <= u1; a++) {
    for (let y = y0; y <= y1; y++) {
      const kenar = a === u0 || a === u1 || y === y0 || y === y1
      const kose = (a === u0 || a === u1) && (y === y0 || y === y1)
      if (!kenar || kose) continue
      cerceve++
      if (izgara.get(`${a},${y}`) === true) var_++
    }
  }
  const orta = g.eksen === 'x' ? [Math.round((u0 + u1) / 2), g.sabit] : [g.sabit, Math.round((u0 + u1) / 2)]
  return { eksen: g.eksen, genislik: u1 - u0 + 1, yukseklik: y1 - y0 + 1, cerceve, var: var_, eksik: cerceve - var_, y0, y1, u0, u1, sabit: g.sabit, orta }
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
  const r = { seed, zaman: Math.floor(Date.now() / 1000), yolPuani, notlar: [] }
  try {
    durumYaz({ asama: 'sunucu açılıyor' })
    sunucu = await sunucuAc(seed, sifre)
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
    const merkez = new Vec3(lp.x, 64, lp.z)
    const yakin = (p) => Math.hypot(p.x - lp.x, p.z - lp.z) <= 32
    const bul = (filtre) => bot.findBlocks({ point: merkez, matching: idler(bot, filtre), maxDistance: 140, count: 600 }).filter(yakin)
    const obs = bul((n) => n === 'obsidian')
    const agl = bul((n) => n === 'crying_obsidian')
    const cer = cerceveAnaliz(obs, agl)
    r.portal = {
      tur: lp.tur,
      konum: cer ? cer.orta : [lp.x, lp.z],
      obsidyen: obs.length,
      aglayan: agl.length,
      cerceve: cer ? { genislik: cer.genislik, yukseklik: cer.yukseklik, eksik: cer.eksik, y: cer.y0 } : null
    }
    if (cer) {
      // Su içinde mi, gömülü mü?
      let su = 0; let ust = 0
      for (let a = cer.u0; a <= cer.u1; a++) {
        for (let y = cer.y0; y <= cer.y1 + 1; y++) {
          const p = cer.eksen === 'x' ? new Vec3(a, y, cer.sabit) : new Vec3(cer.sabit, y, a)
          const bl = bot.blockAt(p)
          if (bl && (bl.name === 'water' || bl.name === 'seagrass' || bl.name === 'kelp' || bl.name === 'kelp_plant')) su++
        }
        const pu = cer.eksen === 'x' ? new Vec3(a, cer.y1 + 2, cer.sabit) : new Vec3(cer.sabit, cer.y1 + 2, a)
        const bl = bot.blockAt(pu)
        if (bl && bl.boundingBox === 'block' && !bl.name.includes('leaves')) ust++
      }
      r.portal.suda = su >= 3
      r.portal.gomulu = ust >= Math.ceil((cer.u1 - cer.u0 + 1) / 2)
    }

    // Sandık
    const sandiklar = bul((n) => n === 'chest')
    if (sandiklar.length) {
      durumYaz({ asama: 'portal sandığı' })
      const s = sandiklar.sort((a, c) => a.distanceTo(merkez) - c.distanceTo(merkez))[0]
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

  // Portal: eksik obsidyen ve ateş kaynağı
  const s = r.portal.sandik || {}
  const sandikObs = s.obsidian || 0
  const ates = (s.flint_and_steel || 0) + (s.fire_charge || 0) > 0
  const eksik = r.portal.cerceve ? r.portal.cerceve.eksik : 10
  const tamamlanir = eksik <= sandikObs
  r.portal.ates = ates
  r.portal.yakilabilir = tamamlanir
  if (!tamamlanir) {
    const fark = eksik - sandikObs
    ek += Math.min(150, 60 + fark * 10)
    n.push(`portal ${fark} obsidyen eksik (lav dökmek gerek)`)
  }
  if (!ates) { ek += 40; n.push('sandıkta çakmak yok (demir + çakmaktaşı gerek)') }
  if (r.portal.suda) { ek += 15; n.push('portal su içinde') }
  if (r.portal.gomulu) { ek += 15; n.push('portal gömülü') }

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
    if (v[i] === '--adet') a.adet = Math.max(1, Math.min(200, Number(v[++i]) || 30))
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
  const liste = durumTopla().enIyiler
  const bilgi = new Map(liste.map((s) => [s.seed, s]))
  let hedef = arg.seedler.length
    ? arg.seedler
    : liste.filter((s) => arg.yeniden || !sonuclar[s.seed]).slice(0, arg.adet).map((s) => s.seed)
  hedef = hedef.filter((s) => /^-?\d{1,20}$/.test(s))
  durumYaz({ toplam: hedef.length, biten: 0 })
  if (!hedef.length) { log('Doğrulanacak yeni seed yok.'); return }

  jarHazirla()
  avciDurdur()
  for (const seed of hedef) {
    if (durduruldu) break
    durumYaz({ simdiki: seed, asama: 'başlıyor' })
    log(`[${durum.biten + 1}/${hedef.length}] ${seed}`)
    const t = bilgi.get(seed) || {}
    const r = await zamanAsimi(seedDogrula(seed, t.sn ?? null, t), SEED_SURE, 'seed doğrulama')
      .catch((e) => ({ seed, zaman: Math.floor(Date.now() / 1000), yolPuani: t.sn ?? null, hata: e.message, notlar: [] }))
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
