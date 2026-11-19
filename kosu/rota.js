'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Rcon, jarHazirla, sunucuAc, sunucuKapat, JAR, SURUM } = require('../dogrulama/sunucu')

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
    fs.writeFileSync(path.join(ciktiDizini, `${a.seed}.json`), JSON.stringify(sonuc, null, 2) + '\n')
    console.log(`Rota yazıldı: ${path.join(ciktiDizini, `${a.seed}.json`)}`)
  } finally {
    if (rcon) rcon.kapat()
    await sunucuKapat(sunucu)
    fs.rmSync(dizin, { recursive: true, force: true })
  }
}

if (require.main === module) main().catch(hata => { console.error(hata.message); process.exitCode = 1 })

module.exports = { locateCoz }
