'use strict'

// Seed verisini okur: bu sunucudaki avcının .json dosyaları + Windows PC'lerden
// yüklenenler + gerçek oyunla doğrulama sonuçları. Panel ve doğrulayıcı ortak kullanır.

const fs = require('fs')
const path = require('path')

const VERI_DIZIN = process.env.SEED_VERI_DIZIN || path.join(__dirname, '..', 'seed-avcisi')
const YUKLEME_DIZIN = path.join(VERI_DIZIN, 'yuklenen')
const DOGRULAMA_DIZIN = process.env.SEED_DOGRULAMA_DIZIN || path.join(__dirname, '..', 'dogrulama', 'veri')
const CEVRIMDISI_SN = 90  // Windows PC'ler 30 sn'de bir yükler

function jsonOku (yol, varsayilan) {
  try {
    return JSON.parse(fs.readFileSync(yol, 'utf8'))
  } catch {
    return varsayilan
  }
}

// { sonuclar: { seed: {...} }, durum: {...} }
function dogrulamaOku () {
  return {
    sonuclar: jsonOku(path.join(DOGRULAMA_DIZIN, 'sonuclar.json'), {}),
    durum: jsonOku(path.join(DOGRULAMA_DIZIN, 'durum.json'), null)
  }
}

// ---------------------------------------------------------------- veri

function durumTopla (sinir = 100) {
  const pcler = []
  const seedler = new Map()
  const okunan = new Map()  // pc -> en yeni veri (aynı numara iki yerden gelirse)
  for (const dizin of [VERI_DIZIN, YUKLEME_DIZIN]) {
    let dosyalar = []
    try {
      dosyalar = fs.readdirSync(dizin).filter((f) => f.endsWith('.txt.json'))
    } catch { /* dizin yok */ }
    for (const f of dosyalar) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dizin, f), 'utf8'))
        if (!d.kaynak) d.kaynak = 'yerel'
        const eski = okunan.get(d.pc)
        if (!eski || d.guncellendi > eski.guncellendi) okunan.set(d.pc, d)
      } catch { /* bozuk dosya */ }
    }
  }
  for (const d of okunan.values()) {
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
      minecraft: d.minecraft,
      kaynak: d.kaynak
    })
    for (const s of d.enIyiler || []) {
      const eski = seedler.get(s.seed)
      if (!eski || s.sn < eski.sn) seedler.set(s.seed, { ...s, pc: d.pc })
    }
  }
  pcler.sort((a, b) => a.pc - b.pc)
  const enIyiler = [...seedler.values()].sort((a, b) => a.sn - b.sn).slice(0, sinir)
  return { zaman: Math.floor(Date.now() / 1000), pcler, enIyiler }
}


// Bilinen tüm seed'ler: her PC'nin .json'undaki en iyi 100 + bu sunucudaki
// txt dosyalarındaki en iyi 1000. Doğrulayıcı "tümü" seçilince bunu kullanır.
function tumSeedler () {
  const m = new Map()
  const ekle = (s) => { const e = m.get(s.seed); if (!e || s.sn < e.sn) m.set(s.seed, s) }
  for (const s of durumTopla(Infinity).enIyiler) ekle(s)
  let txtler = []
  try { txtler = fs.readdirSync(VERI_DIZIN).filter((f) => /^seedler-pc\d+\.txt$/.test(f)) } catch { /* */ }
  const xz = (t) => t.split('=')[1].split(',').map(Number)
  for (const f of txtler) {
    let satirlar = []
    try { satirlar = fs.readFileSync(path.join(VERI_DIZIN, f), 'utf8').split('\n') } catch { continue }
    for (const l of satirlar) {
      if (!l || l[0] === '#') continue
      const a = l.split('\t')
      if (a.length < 9 || !/^-?\d{1,20}$/.test(a[0])) continue
      ekle({
        seed: a[0], sn: Number(a[1]), spawn: xz(a[2]), portal: xz(a[3]), bastion: xz(a[4]), fortress: xz(a[5]),
        kale: xz(a[6]), nether: Number(a[7].split('=')[1]), biyom: (a[8].split(':')[1] || '?').trim()
      })
    }
  }
  return [...m.values()].sort((a, b) => a.sn - b.sn)
}

module.exports = { tumSeedler, VERI_DIZIN, YUKLEME_DIZIN, DOGRULAMA_DIZIN, CEVRIMDISI_SN, durumTopla, dogrulamaOku, jsonOku }
