#!/usr/bin/env node
'use strict'

// Toplu seed denemesi: doğrulanmış en iyi N seed'i sırayla koşturur.
//   node kosu/toplu.js --adet 5 --hedef blaze
// İlerleme kosu/veri/toplu.json dosyasına yazılır. SIGTERM: o anki koşuyu öldürüp çıkar.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { dogrulamaOku, guncelSonuc } = require('../web/veri')

const KOK = path.join(__dirname, '..')
const VERI = path.join(__dirname, 'veri')
const DURUM = path.join(VERI, 'toplu.json')
const LOG = path.join(VERI, 'son-kosu.log')

function arg (ad, varsayilan) {
  const i = process.argv.indexOf('--' + ad)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : varsayilan
}

const adet = Math.max(1, Math.min(50, Math.floor(Number(arg('adet', 5))) || 5))
const hedef = arg('hedef', 'blaze')

// Panelle aynı sıra: gerçek süreye göre; hatalı ya da yakılamayan portallar atlanır.
function seedSec (n) {
  const { sonuclar } = dogrulamaOku()
  return Object.values(sonuclar)
    .filter(guncelSonuc)
    .filter((r) => !r.hata && r.portal && r.portal.yakilabilir && r.portal.ates)
    .sort((a, b) => a.gercekSure - b.gercekSure)
    .slice(0, n)
    .map((r) => String(r.seed))
}

const durum = { calisiyor: true, hedef, sira: seedSec(adet), indeks: 0, basladi: Date.now() }
function yaz () {
  fs.mkdirSync(VERI, { recursive: true })
  fs.writeFileSync(DURUM + '.tmp', JSON.stringify(durum))
  fs.renameSync(DURUM + '.tmp', DURUM)
}

let cocuk = null
let durdu = false

function bitir () {
  durum.calisiyor = false
  if (!durdu) durum.bitti = Date.now()
  yaz()
  process.exit(0)
}

process.on('SIGTERM', () => {
  durdu = true
  if (cocuk) cocuk.kill('SIGTERM')
  setTimeout(bitir, 20000).unref()
  if (!cocuk) bitir()
})
process.on('SIGINT', () => process.emit('SIGTERM'))

function kos (seed) {
  return new Promise((resolve) => {
    const log = fs.openSync(LOG, 'a')
    cocuk = spawn(process.execPath, [path.join(KOK, 'src', 'index.js'), 'nether', '--seed', seed, '--hedef', hedef], {
      cwd: KOK, env: { ...process.env, DEBUG: '1' }, stdio: ['ignore', log, log]
    })
    cocuk.on('exit', () => { fs.closeSync(log); cocuk = null; resolve() })
    cocuk.on('error', () => { try { fs.closeSync(log) } catch { /* */ } cocuk = null; resolve() })
  })
}

async function ana () {
  yaz()
  for (let i = 0; i < durum.sira.length && !durdu; i++) {
    durum.indeks = i
    yaz()
    await kos(durum.sira[i])
  }
  if (!durdu) durum.indeks = durum.sira.length
  bitir()
}
ana()
