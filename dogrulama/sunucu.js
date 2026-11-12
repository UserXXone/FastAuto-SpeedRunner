'use strict'

// Geçici Minecraft 1.21.1 sunucusu aç/kapat + RCON istemcisi.
// Doğrulayıcı (dogrula.js) ve bot koşuları (src/kosu.js) ortak kullanır.
// Sunucu her zaman sadece 127.0.0.1'de dinler: online-mode=false olduğu için
// dışarıya açılmamalı.

const fs = require('fs')
const path = require('path')
const net = require('net')
const crypto = require('crypto')
const { spawn, execFileSync } = require('child_process')

const JAR = process.env.MC_SUNUCU_JAR || path.join(__dirname, 'sunucu', 'server-1.21.1.jar')
const JAR_SHA1 = '59353fb40c36d304f2035d51e7d6e6baa98dc05c'
const JAR_URL = `https://piston-data.mojang.com/v1/objects/${JAR_SHA1}/server.jar`
const SURUM = '1.21.1'

function zamanAsimi (soz, ms, ad) {
  let t
  return Promise.race([soz, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${ad}: zaman aşımı`)), ms) })])
    .finally(() => clearTimeout(t))
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

function jarHazirla (log = () => {}) {
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

// ayar: { seed, dizin, port, rconPort, sifre, bellek = '1G', ozellikler = {}, koru = false }
// Dönen: java süreci. Dünya klasörü (dizin) baştan oluşturulur.
async function sunucuAc (ayar) {
  const { seed, dizin, port, rconPort, sifre, bellek = '1G', ozellikler = {} } = ayar
  for (const p of [port, rconPort]) {
    if (!(await portBos(p))) throw new Error(`port ${p} dolu (başka bir sunucu açık kalmış olabilir)`)
  }
  if (!ayar.koru) fs.rmSync(dizin, { recursive: true, force: true })  // koru: var olan dünyayı aç (inceleme için)
  fs.mkdirSync(dizin, { recursive: true })
  fs.writeFileSync(path.join(dizin, 'eula.txt'), 'eula=true\n')
  const oz = {
    'level-seed': seed,
    'online-mode': 'false',       // sadece 127.0.0.1'de dinliyor, dışarıdan girilemez
    'server-ip': '127.0.0.1',
    'server-port': port,
    'enable-rcon': 'true',
    'rcon.port': rconPort,
    'rcon.password': sifre,
    'view-distance': 6,
    'simulation-distance': 4,
    'spawn-protection': 0,
    difficulty: 'peaceful',
    'max-players': 2,
    motd: 'FastAuto',
    'sync-chunk-writes': 'false',
    'enable-status': 'false',
    ...ozellikler
  }
  fs.writeFileSync(path.join(dizin, 'server.properties'), Object.entries(oz).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  const p = spawn('java', ['-Xms256M', `-Xmx${bellek}`, '-XX:+UseSerialGC', '-jar', JAR, 'nogui'], { cwd: dizin, stdio: ['pipe', 'pipe', 'pipe'] })
  // RAM biterse çekirdek önce bu sunucuyu kapatsın, makinedeki başka işlere dokunmasın.
  try { fs.writeFileSync(`/proc/${p.pid}/oom_score_adj`, '900') } catch { /* Linux değil ya da izin yok */ }
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
  if (ayar.acildi) ayar.acildi(p)
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

module.exports = { Rcon, jarHazirla, portBos, sunucuAc, sunucuKapat, zamanAsimi, SURUM, JAR }
