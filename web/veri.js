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

function durumTopla () {
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
  const enIyiler = [...seedler.values()].sort((a, b) => a.sn - b.sn).slice(0, 100)
  return { zaman: Math.floor(Date.now() / 1000), pcler, enIyiler }
}


module.exports = { VERI_DIZIN, YUKLEME_DIZIN, DOGRULAMA_DIZIN, CEVRIMDISI_SN, durumTopla, dogrulamaOku, jsonOku }
