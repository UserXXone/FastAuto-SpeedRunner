'use strict'

const $ = (s) => document.querySelector(s)
const bin = (n) => Number(n).toLocaleString('tr-TR')

function sure (sn) {
  sn = Math.floor(sn)
  const g = Math.floor(sn / 86400)
  const s = Math.floor((sn % 86400) / 3600)
  const d = Math.floor((sn % 3600) / 60)
  const pad = (x) => String(x).padStart(2, '0')
  return (g ? `${g} gün ` : '') + `${pad(s)}:${pad(d)}:${pad(sn % 60)}`
}

function kalan (sn) {
  const yil = sn / (365.25 * 86400)
  if (!isFinite(yil)) return '—'
  if (yil >= 1e9) return `~${(yil / 1e9).toFixed(1)} milyar yıl`
  if (yil >= 1e6) return `~${(yil / 1e6).toFixed(1)} milyon yıl`
  if (yil >= 1) return `~${Math.round(yil)} yıl`
  return sure(sn)
}

function once (zaman, simdi) {
  const f = simdi - zaman
  if (f < 60) return `${f} sn önce`
  if (f < 3600) return `${Math.floor(f / 60)} dk önce`
  return `${Math.floor(f / 3600)} saat önce`
}

function el (etiket, sinif, metin) {
  const e = document.createElement(etiket)
  if (sinif) e.className = sinif
  if (metin != null) e.textContent = metin
  return e
}

function kart (etiket, deger) {
  const k = el('div', 'kart')
  k.append(el('div', 'etiket', etiket), el('div', 'deger', deger))
  return k
}

function kontrolCiz (servis) {
  const b = $('#duraklat')
  if (!b) return
  const calisiyor = servis === 'active'
  b.dataset.eylem = calisiyor ? 'duraklat' : 'surdur'
  b.textContent = calisiyor ? '⏸ Taramayı duraklat' : (servis === 'inactive' ? '▶ Taramayı sürdür' : `▶ Başlat (${servis})`)
  b.classList.toggle('duraklatildi', !calisiyor)
  b.disabled = false
}

$('#duraklat') && $('#duraklat').addEventListener('click', async (e) => {
  const b = e.currentTarget
  const eylem = b.dataset.eylem
  b.disabled = true
  b.textContent = eylem === 'duraklat' ? 'Duraklatılıyor…' : 'Başlatılıyor…'
  try {
    const r = await fetch('/api/tarama', { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ eylem }) })
    if (r.ok) kontrolCiz((await r.json()).servis)
    else { b.textContent = 'Hata, tekrar dene'; b.disabled = false }
  } catch { b.textContent = 'Bağlantı yok'; b.disabled = false }
})

$('#elleDosya') && $('#elleDosya').addEventListener('change', async (e) => {
  const f = e.target.files[0]
  if (!f) return
  const sonuc = $('#elleSonuc')
  sonuc.textContent = 'Yükleniyor…'
  try {
    const r = await fetch('/api/yukle-elle', { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: await f.text() })
    sonuc.textContent = await r.text()
    sonuc.className = r.ok ? '' : 'hata'
    if (r.ok) yenile()
  } catch { sonuc.textContent = 'Bağlantı yok'; sonuc.className = 'hata' }
  e.target.value = ''
})

function seedDugmesi (seed) {
  const b = el('button', 'seed', seed)
  b.title = 'Kopyalamak için tıkla'
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(seed)
      b.classList.add('kopyalandi'); b.textContent = 'kopyalandı ✓'
      setTimeout(() => { b.textContent = seed; b.classList.remove('kopyalandi') }, 1200)
    } catch { /* pano izni yok */ }
  })
  return b
}

function portalYazi (p) {
  if (!p) return '—'
  const c = p.cerceve
  const eksik = c ? c.eksik : '?'
  return (p.yakilabilir ? 'tamamlanır' : `${eksik} eksik`) + (p.ates ? ', ateş ✓' : ', ateş yok') + (p.suda ? ', suda' : '') + (p.gomulu ? ', gömülü' : '')
}

function sandikYazi (s) {
  if (!s) return '—'
  const onemli = ['obsidian', 'flint_and_steel', 'fire_charge', 'gold_ingot', 'iron_nugget', 'flint']
  const k = Object.entries(s).filter(([a]) => onemli.includes(a)).map(([a, n]) => `${a.replace('_and_', '&').replace(/_/g, ' ')} ${n}`)
  return k.length ? k.join(', ') : 'işe yarar yok'
}

async function dogrulamaIstek (govde) {
  const r = await fetch('/api/dogrulama', { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(govde) })
  $('#dBilgi').textContent = r.ok ? 'İstek gönderildi…' : await r.text()
  setTimeout(yenile, 1500)
}
$('#dBaslat') && $('#dBaslat').addEventListener('click', () => dogrulamaIstek({ eylem: 'baslat', adet: $('#dAdet').value === 'tumu' ? 'tumu' : Number($('#dAdet').value) }))
$('#dDurdur') && $('#dDurdur').addEventListener('click', () => dogrulamaIstek({ eylem: 'durdur' }))

function dogrulamaCiz (dg) {
  if (!dg || !$('#dogrulanan')) return
  const du = dg.durum
  $('#dBaslat').disabled = dg.calisiyor
  $('#dDurdur').disabled = !dg.calisiyor
  $('#duraklat').disabled = dg.calisiyor
  let bilgi = `${dg.sayi} seed doğrulandı, ${bin(dg.bekleyen)} seed sırada bekliyor.`
  if (dg.calisiyor && du) bilgi = `Çalışıyor: ${du.biten}/${du.toplam} — ${du.simdiki || ''} (${du.asama})`
  else if (du && du.asama === 'durduruldu') bilgi += ' Son çalışma durduruldu.'
  $('#dBilgi').textContent = bilgi
  const satirlar = dg.enIyiler.map((r, i) => {
    const tr = el('tr', i < 3 ? 'ilk' : '')
    const td = (x, c) => { const t = el('td', c || null); typeof x === 'string' ? (t.textContent = x) : t.append(x); return t }
    tr.append(td(`${i + 1}.`, 'sira'), td(seedDugmesi(r.seed)), td(`${r.gercekSure} sn`, 'vurgu'),
      td(r.yolPuani == null ? '—' : String(r.yolPuani)), td(portalYazi(r.portal)), td(sandikYazi(r.portal && r.portal.sandik)),
      td(r.agac.enYakin == null ? 'yok' : `${r.agac.enYakin} blok`), td(`${r.netherYol} blok`), td((r.notlar || []).join('; '), 'not'))
    return tr
  })
  if (!satirlar.length) {
    const tr = el('tr'); const t = el('td', 'soluk', 'Henüz doğrulanan seed yok. “Doğrula”ya bas.'); t.colSpan = 9; tr.append(t); satirlar.push(tr)
  }
  $('#dogrulanan tbody').replaceChildren(...satirlar)
}

function ciz (d) {
  kontrolCiz(d.servis)
  dogrulamaCiz(d.dogrulama)
  const aktif = d.pcler.filter((p) => p.cevrimici)
  const toplamHiz = aktif.reduce((s, p) => s + p.hiz, 0)
  const toplamTaranan = d.pcler.reduce((s, p) => s + p.taranan, 0)
  const toplamUygun = d.pcler.reduce((s, p) => s + p.uygunSeed, 0)

  $('#ozet').replaceChildren(
    kart('Çevrimiçi bilgisayar', `${aktif.length} / ${d.pcler.length}`),
    kart('Toplam hız', `${bin(Math.round(toplamHiz))} düzen/sn`),
    kart('Taranan yapı düzeni', bin(toplamTaranan)),
    kart('En iyi yol puanı', d.enIyiler.length ? d.enIyiler[0].sn.toFixed(1) : '—'),
    kart('Uygun seed (bu oturumlar)', bin(toplamUygun))
  )
  const toplamlar = new Set(d.pcler.map((p) => p.toplam))
  if (toplamlar.size > 1) {
    $('#ozet').append(el('div', 'kart uyari', `Dikkat: PC'lerde "toplam" farklı (${[...toplamlar].join(', ')}). Hepsinde aynı olmalı, yoksa bazı seed'ler iki kez taranır ya da atlanır.`))
  }

  $('#pcler').replaceChildren(...d.pcler.map((p) => {
    const k = el('div', 'kart pc')
    const baslik = el('div', 'deger')
    baslik.append(el('span', 'durum' + (p.cevrimici ? ' acik' : '')), `PC ${p.pc} / ${p.toplam}`)
    const dl = el('dl')
    const satir = (a, b) => dl.append(el('dt', null, a), el('dd', null, b))
    satir('Kaynak', p.kaynak === 'yukleme' ? 'Windows (yükleme)' : 'VDS')
    satir('Durum', p.cevrimici ? `çalışıyor (${p.cekirdek} çekirdek)` : `kapalı — ${once(p.sonGorulme, d.zaman)}`)
    satir('Hız', `${bin(Math.round(p.hiz))} düzen/sn`)
    satir('Bu oturum', sure(p.oturumSn))
    satir('Toplam süre', sure(p.toplamSn))
    satir('Taranan', bin(p.taranan))
    satir('Yüzde', `%${(100 * p.taranan / p.dilim).toFixed(10)}`)
    satir('Kalan', `${bin(p.dilim - p.taranan)} (${p.hiz > 0 ? kalan((p.dilim - p.taranan) / p.hiz) : '—'})`)
    satir('Son denenen', p.sonSeed)
    satir('Uygun seed', bin(p.uygunSeed))
    k.append(baslik, dl)
    return k
  }))

  $('#seedler tbody').replaceChildren(...d.enIyiler.map((s, i) => {
    const tr = el('tr', i < 3 ? 'ilk' : '')
    const seedBtn = el('button', 'seed', s.seed)
    seedBtn.title = 'Kopyalamak için tıkla'
    seedBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(s.seed)
        seedBtn.classList.add('kopyalandi')
        seedBtn.textContent = 'kopyalandı ✓'
        setTimeout(() => { seedBtn.textContent = s.seed; seedBtn.classList.remove('kopyalandi') }, 1200)
      } catch { /* pano izni yok */ }
    })
    const td = (x, c) => { const t = el('td', c || null); typeof x === 'string' ? (t.textContent = x) : t.append(x); return t }
    const portal = Math.round(Math.hypot(s.spawn[0] - s.portal[0], s.spawn[1] - s.portal[1]))
    const dg = s.dogrulama
    const gercek = !dg ? '—' : dg.hata ? 'hata' : `${dg.gercekSure}`
    tr.append(td(`${i + 1}.`, 'sira'), td(seedBtn), td(s.sn.toFixed(1)), td(gercek, dg && !dg.hata ? 'vurgu' : ''), td(s.biyom), td(`${portal} blok`),
      td(`${s.nether} blok`), td(`${s.kale[0]}, ${s.kale[1]}`), td(String(s.pc)))
    return tr
  }))
  if (!d.enIyiler.length) {
    const tr = el('tr'); const t = el('td', 'soluk', 'Henüz seed yok.'); t.colSpan = 9; tr.append(t)
    $('#seedler tbody').replaceChildren(tr)
  }
  $('#guncelleme').textContent = `Son güncelleme: ${new Date(d.zaman * 1000).toLocaleTimeString('tr-TR')} — 5 saniyede bir yenilenir.`
}

async function yenile () {
  try {
    const r = await fetch('/api/durum', { cache: 'no-store' })
    if (r.status === 401) { location.reload(); return }
    ciz(await r.json())
  } catch {
    $('#guncelleme').textContent = 'Bağlantı yok, tekrar deneniyor...'
  }
}

yenile()
setInterval(yenile, 5000)
