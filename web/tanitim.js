'use strict'

// Tanıtım sayfasının tek çalışan düğmesi: sayfa sonundaki "©" işareti gizli kod
// penceresini açar. Başka hiçbir düğme ya da bağlantı bir şey yapmaz.

const pencere = document.getElementById('kod-pencere')
const ac = document.getElementById('kod-ac')
const kapat = document.getElementById('kod-kapat')
const kod = document.getElementById('kod')

function acPencere () {
  if (!pencere) return
  if (typeof pencere.showModal === 'function') pencere.showModal()
  else pencere.setAttribute('open', '')
  if (kod) kod.focus()
}

if (ac) ac.addEventListener('click', acPencere)
if (kapat) kapat.addEventListener('click', () => pencere.close ? pencere.close() : pencere.removeAttribute('open'))

// Boş alana basınca kapansın.
if (pencere) {
  pencere.addEventListener('click', (e) => {
    if (e.target === pencere && pencere.close) pencere.close()
  })
  // Yanlış kod sonrası sayfa yeniden yüklenince pencere açık gelsin.
  if (pencere.dataset.ac === '1') acPencere()
}

// Sayfadaki diğer bütün tıklamalar etkisiz: bağlantı ve düğmeler sadece görüntü.
document.addEventListener('click', (e) => {
  const hedef = e.target.closest('a, button')
  if (hedef && hedef.id !== 'kod-ac' && hedef.id !== 'kod-kapat' && hedef.type !== 'submit') e.preventDefault()
})
