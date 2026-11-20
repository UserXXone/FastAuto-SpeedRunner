#!/bin/bash
# Test koşusu: durdur, başlat, bitişi bekle, özet yaz. Kullanım: kos.sh <basla> [ek argümanlar]
cd /root/FastAuto-SpeedRunner
systemctl stop seed-kosu 2>/dev/null; sleep 3
systemd-run --unit=seed-kosu --collect --quiet --property=WorkingDirectory=$PWD --property=TimeoutStopSec=30 --setenv=DEBUG=1 --setenv=ALTIN_VER=$ALTIN_VER --setenv=SOV=$SOV --property=StandardOutput=truncate:$PWD/kosu/veri/son-kosu.log --property=StandardError=inherit $(which node) src/index.js nether --seed 4609152743962676157 --basla "$@" --izle ${IZLE:-300}
sleep 8
T0=$(date +%s); until [ $(( $(date +%s) - T0 )) -gt ${SURE:-99999} ] || grep -qE "Ender gözü \(|❌|was slain|fell from|Oyun bitti|Ejderha öldü|End portalı açıldı" kosu/veri/son-kosu.log || ! systemctl is-active -q seed-kosu; do sleep 5; done
sleep 2
grep -E "^⏱|❌|slain|fell from|ender pearl [0-9]|🏁|🐉" kosu/veri/son-kosu.log | tail -12 | cut -c1-150
echo "takas aldı $(grep -c 'külçeyi aldı' kosu/veri/son-kosu.log) atış $(grep -cE 'külçe atışı|bekle atış' kosu/veri/son-kosu.log) | hasar $(grep -c '💔' kosu/veri/son-kosu.log)"
