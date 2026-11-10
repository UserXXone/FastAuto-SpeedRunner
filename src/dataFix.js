"use strict";

// minecraft-data'nın bazı sürümlerinde (ör. 1.21.1) demir/altın/elmas cevheri,
// obsidyen gibi blokların "malzemesi" yanlış etikete bağlanmış: sadece tahta
// aletler hızlandırıyor görünüyor. Sonuç: bot taş kazmayla demiri 4 kat, ağlayan
// obsidyeni 2-4 kat yavaş kazıyor. Hepsi kazma bloğu; doğru etikete çeviriyoruz.
function fixToolData(version) {
  const data = require("minecraft-data")(version);
  if (!data || !data.materials || !data.materials["mineable/pickaxe"]) return 0;
  let fixed = 0;
  for (const b of data.blocksArray) {
    if (/^incorrect_for_/.test(b.material || "")) {
      b.material = "mineable/pickaxe";
      fixed++;
    }
  }
  return fixed;
}

module.exports = { fixToolData };
