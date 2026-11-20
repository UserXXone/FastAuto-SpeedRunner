#!/bin/bash
# Yayın şovu: bölümleri art arda oynat. Kullanım: bash kosu/sov.sh [takas|kale|end ...]
# Varsayılan sıra: takas (30 hazır külçe + enderman avı, en fazla 20 dk) → kale (End portalı) → end (ejderha).
cd /root/FastAuto-SpeedRunner
BOLUMLER=${@:-takas kale end}
for b in $BOLUMLER; do
  echo "===== BÖLÜM: $b ($(date +%H:%M)) ====="
  case $b in
    takas) ALTIN_VER=30 IZLE=20 SURE=1200 bash kosu/kos.sh bastion ;;
    kale)  IZLE=20 SURE=1200 bash kosu/kos.sh kale ;;
    end)   IZLE=60 SURE=1500 bash kosu/kos.sh end --kristal-yok --zirh ;;
    bastan) IZLE=60 SURE=3600 bash kosu/kos.sh bastan ;;
  esac
  systemctl stop seed-kosu 2>/dev/null; sleep 5
done
echo "===== ŞOV BİTTİ $(date +%H:%M) ====="
