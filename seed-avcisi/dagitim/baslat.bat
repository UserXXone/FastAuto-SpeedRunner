@echo off
cd /d "%~dp0"
title FastAuto Seed Avcisi
if exist ayar.txt goto oku
echo Ilk calistirma: birkac soru soracagim.
set /p PC=Bu bilgisayarin numarasi (1, 2, 3...): 
set /p TOPLAM=Toplam kac bilgisayar tariyor: 
>ayar.txt echo %PC% %TOPLAM%
:oku
for /f "tokens=1,2" %%a in (ayar.txt) do (set PC=%%a& set TOPLAM=%%b)
echo Bilgisayar %PC% / %TOPLAM% olarak taraniyor. Durdurmak icin Ctrl+C.
seed-avcisi.exe --pc %PC% --toplam %TOPLAM%
pause
