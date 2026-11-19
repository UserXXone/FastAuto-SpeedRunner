'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const mineflayer = require('mineflayer')
const { Rcon, jarHazirla, sunucuAc, sunucuKapat, JAR, SURUM } = require('../dogrulama/sunucu')
const { fixToolData } = require('../src/dataFix')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function odaOzeti (cerceveler) {
  if (!Array.isArray(cerceveler) || cerceveler.length < 12) return null
  // Aynı yükseklikte, birbirine yakın çerçeveler portal halkasını oluşturur.
  for (const ilk of cerceveler) {
    const grup = cerceveler.filter(p => p.y === ilk.y && Math.abs(p.x - ilk.x) <= 4 && Math.abs(p.z - ilk.z) <= 4)
    if (grup.length < 12) continue
    const xs = grup.map(p => p.x); const zs = grup.map(p => p.z)
    return {
      merkez: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: ilk.y, z: (Math.min(...zs) + Math.max(...zs)) / 2 },
      cerceve: 12,
      takiliGoz: grup.filter(p => p.eye === true || p.eye === 'true').length
    }
  }
  return null
}

function zamanAsimli (soz, ms, ad) {
  let timer
  return Promise.race([soz, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${ad}: zaman aşımı`)), ms) })])
    .finally(() => clearTimeout(timer))
}

function gozcuBagla (port) {
  const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: 'Gozcu', version: SURUM, auth: 'offline', hideErrors: true })
  bot.setMaxListeners(30)
  bot.on('error', e => console.error('Gozcu bağlantı hatası:', e.message))
  const spawned = new Promise((resolve, reject) => {
    bot.once('spawn', resolve)
    bot.once('kicked', r => reject(new Error(`Gozcu sunucudan atıldı: ${JSON.stringify(r)}`)))
    bot.once('end', r => reject(new Error(`Gozcu bağlantısı koptu: ${r}`)))
  })
  return { bot, spawned }
}

async function bolgeYukle (bot) {
  const basla = Date.now()
  while (Date.now() - basla < 20_000) {
    const p = bot.entity && bot.entity.position
    if (p && bot.blockAt(p.floored())) return true
    await sleep(250)
  }
  return false
}

function portalOdasiBul (bot) {
  const id = bot.registry.blocksByName.end_portal_frame.id
  const pos = bot.findBlocks({ matching: id, maxDistance: 96, count: 24 })
  return odaOzeti(pos.map(p => {
    const b = bot.blockAt(p)
    const props = b && b.getProperties ? b.getProperties() : {}
    return { x: p.x, y: p.y, z: p.z, eye: props.eye }
  }))
}

async function ikinciAsama (sonuc, a, rcon) {
  // minecraft-data düzeltmesi, botun sürüm kaydını kullanmadan önce yapılmalı.
  fixToolData(SURUM)
  const { bot, spawned } = gozcuBagla(a.port)
  const komut = (s, ms = 15_000) => zamanAsimli(rcon.komut(s, ms), ms, `RCON ${s}`)
  try {
    await zamanAsimli(spawned, 30_000, 'Gozcu bağlantısı')
    await komut('gamemode spectator Gozcu')

    const kale = sonuc.overworld.kale
    sonuc.overworld.portalOdasi = null
    if (kale) {
      const ara = async (x, z) => {
        await komut(`tp Gozcu ${x} 30 ${z}`)
        if (!(await bolgeYukle(bot))) return null
        return portalOdasiBul(bot)
      }
      sonuc.overworld.portalOdasi = await ara(kale.x, kale.z)
      for (const [dx, dz] of [[64, 0], [64, 64], [0, 64], [-64, 64], [-64, 0], [-64, -64], [0, -64], [64, -64]]) {
        if (sonuc.overworld.portalOdasi) break
        sonuc.overworld.portalOdasi = await ara(kale.x + dx, kale.z + dz)
      }
    }

    const portal = sonuc.overworld.yikikPortal
    if (portal) {
      await komut(`tp Gozcu ${portal.x} 75 ${portal.z}`) // 100'den 24 blok içinde zemin görünmüyordu
      await bolgeYukle(bot)
      await sleep(4000) // çevre chunk'lar da gelsin (sadece bulunduğumuz chunk'ı bekliyorduk)
      const blocks = bot.findBlocks({ matching: [bot.registry.blocksByName.obsidian.id, bot.registry.blocksByName.crying_obsidian.id, bot.registry.blocksByName.chest.id], maxDistance: 40, count: 256 })
      let obsidyen = 0; let aglayanObsidyen = 0; let sandik = null
      for (const p of blocks) {
        const b = bot.blockAt(p)
        if (!b) continue
        if (b.name === 'obsidian') obsidyen++
        else if (b.name === 'crying_obsidian') aglayanObsidyen++
        else if (b.name === 'chest' && !sandik) sandik = { x: p.x, y: p.y, z: p.z }
      }
      sonuc.overworld.yikikPortalAyrinti = { obsidyen, aglayanObsidyen, sandik }
    } else sonuc.overworld.yikikPortalAyrinti = null

    await komut('execute in minecraft:the_end run forceload add -64 -64 64 64')
    await sleep(3000)
    await komut('execute in minecraft:the_end run tp Gozcu 0 120 0')
    await sleep(10_000)
    const kafesBloklari = new Set([bot.registry.blocksByName.iron_bars.id])
    const kristaller = Object.values(bot.entities).filter(e => e.name === 'end_crystal').map(e => {
      const p = e.position
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const komsu = [[0, 1, 0], [0, 2, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      const kafesli = komsu.some(([dx, dy, dz]) => { const b = bot.blockAt(p.offset(dx, dy, dz)); return b && kafesBloklari.has(b.type) })
      return { x: p.x, y: p.y, z: p.z, kafesli }
    })
    sonuc.end = { kristaller }
    if (!kristaller.length) console.log('Not: End kristali bulunamadı; ejderha savaşı başlamamış olabilir.')
  } finally {
    try { bot.quit() } catch { /* bağlantı kapanmış olabilir */ }
  }
}

function locateCoz (metin) {
  if (typeof metin !== 'string' || /Could not find/i.test(metin)) return null
  const m = metin.match(/\[\s*(-?\d+)\s*,\s*(-?\d+|~)\s*,\s*(-?\d+)\s*\]/)
  if (!m) return null
  return { x: Number(m[1]), y: m[2] === '~' ? null : Number(m[2]), z: Number(m[3]) }
}

function argAl (argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed') a.seed = argv[++i]
    else if (argv[i] === '--port') a.port = Number(argv[++i])
    else if (argv[i] === '--rcon') a.rconPort = Number(argv[++i])
    else throw new Error(`Bilinmeyen seçenek: ${argv[i]}`)
  }
  if (a.seed === undefined || !a.seed.length) throw new Error('Kullanım: node kosu/rota.js --seed <seed> [--port 25577] [--rcon 25578]')
  a.port ??= 25577
  a.rconPort ??= 25578
  return a
}

async function bekleRcon (port, sifre) {
  for (let i = 0; i < 60; i++) {
    const r = new Rcon()
    try { await r.baglan(port, sifre); return r } catch { r.kapat(); await new Promise(resolve => setTimeout(resolve, 1000)) }
  }
  throw new Error('RCON bağlantısı kurulamadı')
}

async function main () {
  const a = argAl(process.argv.slice(2))
  if (!fs.existsSync(JAR)) throw new Error(`Minecraft sunucu JAR dosyası yok: ${JAR}`)
  jarHazirla()
  const dizin = path.join(__dirname, 'rota', `dunya-${a.seed}`)
  const ciktiDizini = path.join(__dirname, 'rota')
  fs.mkdirSync(ciktiDizini, { recursive: true })
  const sifre = crypto.randomBytes(24).toString('hex')
  let sunucu = null
  let rcon = null
  try {
    sunucu = await sunucuAc({ seed: a.seed, dizin, port: a.port, rconPort: a.rconPort, sifre, bellek: '900M', ozellikler: { difficulty: 'easy' }, acildi: p => { sunucu = p } })
    rcon = await bekleRcon(a.rconPort, sifre)
    const sorgula = async komut => locateCoz(await rcon.komut(komut, 30e3))
    const sonuc = {
      seed: a.seed,
      surum: SURUM,
      olusturuldu: Math.floor(Date.now() / 1000),
      overworld: {
        yikikPortal: await sorgula('execute in minecraft:overworld positioned 0 64 0 run locate structure minecraft:ruined_portal'),
        kale: await sorgula('execute in minecraft:overworld positioned 0 64 0 run locate structure minecraft:stronghold'),
        koy: await sorgula('execute in minecraft:overworld positioned 0 64 0 run locate structure minecraft:village_plains')
      },
      nether: {}
    }
    const px = sonuc.overworld.yikikPortal?.x ?? 0
    const pz = sonuc.overworld.yikikPortal?.z ?? 0
    const nx = Math.floor(px / 8)
    const nz = Math.floor(pz / 8)
    const netherSor = async (isim, komut) => { sonuc.nether[isim] = await sorgula(`execute in minecraft:the_nether positioned ${nx} 64 ${nz} run ${komut}`) }
    await netherSor('kale', 'locate structure minecraft:fortress')
    await netherSor('bastion', 'locate structure minecraft:bastion_remnant')
    await netherSor('warped', 'locate biome minecraft:warped_forest')
    await netherSor('crimson', 'locate biome minecraft:crimson_forest')
    await ikinciAsama(sonuc, a, rcon)
    fs.writeFileSync(path.join(ciktiDizini, `${a.seed}.json`), JSON.stringify(sonuc, null, 2) + '\n')
    console.log(`Rota yazıldı: ${path.join(ciktiDizini, `${a.seed}.json`)}`)
  } finally {
    if (rcon) rcon.kapat()
    await sunucuKapat(sunucu)
    fs.rmSync(dizin, { recursive: true, force: true })
  }
}

if (require.main === module) main().catch(hata => { console.error(hata.message); process.exitCode = 1 })

module.exports = { locateCoz, odaOzeti }
