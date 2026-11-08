# FastAuto seed avcısı derleme dosyası
#   make          -> Linux programı (bin/seed-avcisi)
#   make windows  -> Windows programı (bin/seed-avcisi.exe, Windows 7 ve üstü)
#   make hepsi    -> ikisi birden

CUB    = third_party/cubiomes
SRC    = src/avci.c $(CUB)/noise.c $(CUB)/biomes.c $(CUB)/layers.c $(CUB)/biomenoise.c \
         $(CUB)/generator.c $(CUB)/finders.c $(CUB)/util.c $(CUB)/quadbase.c
FLAGS  = -O3 -fwrapv -I$(CUB) -Wall -Wno-unused-function

WINCC  = x86_64-w64-mingw32-gcc
# Windows 7 (0x0601) API seviyesi, tek dosya (static) exe: başka DLL gerekmez.
WINFLAGS = -D_WIN32_WINNT=0x0601 -static -static-libgcc

.PHONY: all linux windows hepsi temizle

all: linux
hepsi: linux windows

linux: bin/seed-avcisi
windows: bin/seed-avcisi.exe

bin/seed-avcisi: $(SRC)
	mkdir -p bin
	gcc $(FLAGS) -march=x86-64 -o $@ $(SRC) -lm -lpthread

bin/seed-avcisi.exe: $(SRC)
	mkdir -p bin
	$(WINCC) $(FLAGS) $(WINFLAGS) -march=x86-64 -o $@ $(SRC) -lm

temizle:
	rm -rf bin
