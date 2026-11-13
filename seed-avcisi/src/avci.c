/*
 * FastAuto Seed Avcısı — Minecraft Java 1.21.1
 *
 * Speedrun için iyi seed arar ve en iyilerini bir txt dosyasına yazar.
 * Birden fazla bilgisayarda çalıştırılabilir: her bilgisayar --pc N --toplam M
 * ile seed uzayının kendi dilimini tarar, aynı seed iki kere taranmaz.
 *
 * İki aşama:
 *  A) Alt 48 bit (yapı tohumu): biyom hesaplamadan yapı konumları.
 *     - Nether merkezine yakın bastion + fortress
 *     - Merkeze yakın yıkık portal
 *     - Merkeze yakın ilk kale (yaklaşık)
 *  B) Geçen her 48-bit için üst 16 bitin 65536 çeşidi: biyom kontrolleri,
 *     gerçek doğma noktası, gerçek kale konumu ve rota süresi tahmini.
 *
 * Puan = tahmini YOL süresi (saniye, düşük = iyi). Görevlerin (ağaç kesme,
 * blaze, ejderha) süresi tüm seed'lerde benzer olduğu için sayılmaz.
 */
#define __USE_MINGW_ANSI_STDIO 1
#include "finders.h"
#include "util.h"

#include <inttypes.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <windows.h>
#include <wininet.h>
#include <wincrypt.h>
typedef HANDLE thread_t;
static CRITICAL_SECTION g_lock;
#define LOCK() EnterCriticalSection(&g_lock)
#define UNLOCK() LeaveCriticalSection(&g_lock)
static void uyku_ms(int ms) { Sleep(ms); }
#else
#include <pthread.h>
#include <unistd.h>
typedef pthread_t thread_t;
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
#define LOCK() pthread_mutex_lock(&g_lock)
#define UNLOCK() pthread_mutex_unlock(&g_lock)
static void uyku_ms(int ms) { usleep(ms * 1000); }
#endif

#define MC MC_1_21_1
#define SURUM "1.21.1"
#define PROGRAM_SURUM "2"   /* tam sayı: otomatik güncelleme bununla karşılaştırır */
#define BLOK 64          /* bir iş parçacığının tek seferde aldığı 48-bit sayısı */
#define MAX_THREAD 256

/* ------------------------------------------------------------------------- */

typedef struct {
    uint64_t seed;
    double sn;              /* tahmini yol süresi */
    int spx, spz;           /* doğma noktası */
    int rpx, rpz;           /* yıkık portal */
    int bx, bz;             /* bastion (nether koordinatı) */
    int fx, fz;             /* fortress (nether koordinatı) */
    int shx, shz;           /* kale (overworld koordinatı) */
    int netherYol;          /* nether'da yürünecek blok */
    int biyom;              /* doğma noktası biyomu */
} Aday;

typedef struct {
    int pc, toplam, threads, topk;
    double dakika;          /* 0 = sınırsız */
    int portalMax;          /* doğma → yıkık portal (blok) */
    int netherMax;          /* nether girişi → bastion/fortress (blok) */
    int kaleMax;            /* kale'nin merkeze uzaklığı (overworld blok) */
    int dusukOncelik;
    int ust;                /* her yapı tohumu için denenecek üst-16 çeşidi */
    char cikti[512];
    char durum[520];
} Ayar;

static Ayar A;
static volatile int g_dur = 0;
static uint64_t g_siradakiBlok = 0;     /* atomik */
static uint64_t g_baslangicBlok = 0;
static uint64_t g_aktifBlok[MAX_THREAD];
static uint64_t g_saySay48[MAX_THREAD];  /* taranan 48-bit */
static uint64_t g_sayGecA[MAX_THREAD];   /* A'yı geçen */
static uint64_t g_saySeed[MAX_THREAD];   /* B'de denenen tam seed */
static uint64_t g_sayBulunan[MAX_THREAD];
static volatile uint64_t g_sonSeed = 0;  /* panelde gösterilecek son denenen seed */
static double g_oncekiSure = 0;           /* önceki oturumların toplam süresi (sn) */
static double g_buOturum = 0;
static int g_ansi = 0;                    /* canlı panel destekleniyor mu */
static int g_sade = 0;
static int g_sessiz = 0;                  /* servis modu: ilerleme yazma */

static Aday *g_top;      /* en iyiler, sn'ye göre artan */
static int g_topN = 0;

/* ------------------------------------------------------------------------- */

static double uzak(double x1, double z1, double x2, double z2)
{
    return sqrt((x1 - x2) * (x1 - x2) + (z1 - z2) * (z1 - z2));
}

static int agacliBiyom(int id)
{
    switch (id) {
    case forest: case flower_forest: case birch_forest: case old_growth_birch_forest:
    case dark_forest: case taiga: case snowy_taiga: case old_growth_pine_taiga:
    case old_growth_spruce_taiga: case jungle: case sparse_jungle: case bamboo_jungle:
    case savanna: case savanna_plateau: case windswept_forest: case windswept_savanna:
    case meadow: case cherry_grove: case grove: case mangrove_swamp: case swamp:
    case wooded_badlands: case plains: case sunflower_plains:
        return 1;
    default:
        return 0;
    }
}

static void topEkle(const Aday *a)
{
    LOCK();
    for (int i = 0; i < g_topN; i++) {
        if (g_top[i].seed == a->seed) { UNLOCK(); return; }
    }
    if (g_topN == A.topk && a->sn >= g_top[g_topN - 1].sn) { UNLOCK(); return; }
    int i = g_topN < A.topk ? g_topN++ : g_topN - 1;
    while (i > 0 && g_top[i - 1].sn > a->sn) { g_top[i] = g_top[i - 1]; i--; }
    g_top[i] = *a;
    UNLOCK();
}

/* --------------------------- A: 48-bit eleme ------------------------------ */

typedef struct {
    Pos b, f, rp;
    int varB, varF, varRP;
} AdayA;

static int asamaA(uint64_t s48, AdayA *o)
{
    memset(o, 0, sizeof(*o));
    double enB = 1e9, enF = 1e9, enRP = 1e9;

    /* Nether: merkeze en yakın bastion ve fortress (aynı ızgarayı paylaşırlar). */
    for (int rx = -1; rx <= 0; rx++) {
        for (int rz = -1; rz <= 0; rz++) {
            Pos p;
            if (getStructurePos(Bastion, MC, s48, rx, rz, &p)) {
                double d = uzak(p.x, p.z, 0, 0);
                if (d < enB) { enB = d; o->b = p; o->varB = 1; }
            } else {
                getStructurePos(Fortress, MC, s48, rx, rz, &p);
                double d = uzak(p.x, p.z, 0, 0);
                if (d < enF) { enF = d; o->f = p; o->varF = 1; }
            }
        }
    }
    if (enB > A.netherMax || enF > A.netherMax) return 0;

    /* İlk kale (yaklaşık, ±112 blok). */
    Pos sh = initFirstStronghold(NULL, MC, s48);
    if (uzak(sh.x, sh.z, 0, 0) > A.kaleMax + 112) {
        /* İlk halkadaki diğer iki kale 120° aralıklı: en yakını kontrol et. */
        StrongholdIter it;
        initFirstStronghold(&it, MC, s48);
        int yakin = 0;
        for (int k = 0; k < 3; k++) {
            if (uzak(it.nextapprox.x, it.nextapprox.z, 0, 0) <= A.kaleMax + 112) yakin = 1;
            nextStronghold(&it, NULL); /* 1.19.3+: biyomsuz yaklaşık ilerleme */
        }
        if (!yakin) return 0;
    }

    /* Merkeze yakın yıkık portal (doğma noktası merkeze yakın olur). */
    for (int rx = -1; rx <= 0; rx++) {
        for (int rz = -1; rz <= 0; rz++) {
            Pos p;
            getStructurePos(Ruined_Portal, MC, s48, rx, rz, &p);
            double d = uzak(p.x, p.z, 0, 0);
            if (d < enRP) { enRP = d; o->rp = p; o->varRP = 1; }
        }
    }
    if (enRP > A.portalMax + 160) return 0;
    return 1;
}

/* --------------------------- B: tam seed --------------------------------- */

static double netherRota(Pos giris, Pos b, Pos f, Pos kaleN, int *yol)
{
    double r1 = uzak(giris.x, giris.z, b.x, b.z) + uzak(b.x, b.z, f.x, f.z) + uzak(f.x, f.z, kaleN.x, kaleN.z);
    double r2 = uzak(giris.x, giris.z, f.x, f.z) + uzak(f.x, f.z, b.x, b.z) + uzak(b.x, b.z, kaleN.x, kaleN.z);
    double r = r1 < r2 ? r1 : r2;
    *yol = (int)r;
    return r;
}

#define YAPI_BASINA 3   /* listede aynı yapı düzeninden en fazla bu kadar seed */

static double enKotuSure(void)
{
    /* Kilitsiz okuma: yaklaşık değer yeterli (sadece eleme için). */
    return g_topN < A.topk ? 1e9 : g_top[g_topN - 1].sn;
}

static void asamaB(uint64_t s48, const AdayA *a, Generator *gO, Generator *gN, int t)
{
    Aday yerel[YAPI_BASINA];
    int yerelN = 0;
    Pos giris = { a->rp.x / 8, a->rp.z / 8 };

    /* Üst 16 biti karışık sırada dene: ilk denemeler bile tüm aralığa yayılsın. */
    for (int k = 0; k < A.ust && !g_dur; k++) {
        uint64_t ust = ((uint64_t)k * 40503u + (s48 & 0xffff)) & 0xffff;
        uint64_t seed = (ust << 48) | s48;
        g_saySeed[t]++;
        if (t == 0 && (k & 255) == 0) g_sonSeed = seed;

        /* Nether biyomları: bastion bazalt deltada çıkmaz. */
        applySeed(gN, DIM_NETHER, seed);
        if (!isViableStructurePos(Bastion, gN, a->b.x, a->b.z, 0)) continue;
        if (!isViableStructurePos(Fortress, gN, a->f.x, a->f.z, 0)) continue;

        applySeed(gO, DIM_OVERWORLD, seed);
        if (!isViableStructurePos(Ruined_Portal, gO, a->rp.x, a->rp.z, 0)) continue;

        Pos sp = estimateSpawn(gO, NULL);
        double dPortal = uzak(sp.x, sp.z, a->rp.x, a->rp.z);
        if (dPortal > A.portalMax) continue;

        int biyom = getBiomeAt(gO, 4, sp.x >> 2, 64 >> 2, sp.z >> 2);
        double ceza = agacliBiyom(biyom) ? 0 : 25;

        /* Ucuz alt sınır: kalelerin yaklaşık yerleri (±112 blok → nether'da ±14). */
        StrongholdIter it;
        initFirstStronghold(&it, MC, seed);
        double altSinir = 1e9;
        for (int i = 0; i < 3; i++) {
            Pos kn = { it.nextapprox.x / 8, it.nextapprox.z / 8 };
            int y;
            double r = netherRota(giris, a->b, a->f, kn, &y) - 28;
            if (r < altSinir) altSinir = r;
            nextStronghold(&it, NULL);
        }
        double tahminAlt = dPortal / 5.6 + altSinir / 4.5 + ceza;
        double esik = enKotuSure();
        if (yerelN == YAPI_BASINA && yerel[YAPI_BASINA - 1].sn < esik) esik = yerel[YAPI_BASINA - 1].sn;
        if (tahminAlt >= esik) continue;

        /* İlk halkanın 3 kalesi: gerçek yerleri (biyom kontrollü), en kısa rota. */
        initFirstStronghold(&it, MC, seed);
        double enIyi = 1e9;
        Pos kale = { 0, 0 };
        int yol = 0;
        for (int i = 0; i < 3; i++) {
            nextStronghold(&it, gO);
            if (uzak(it.pos.x, it.pos.z, 0, 0) > A.kaleMax + 64) continue;
            Pos kaleN = { it.pos.x / 8, it.pos.z / 8 };
            int y;
            double r = netherRota(giris, a->b, a->f, kaleN, &y);
            if (r < enIyi) { enIyi = r; kale = it.pos; yol = y; }
        }
        if (enIyi > 1e8) continue;

        Aday c;
        c.seed = seed;
        c.spx = sp.x; c.spz = sp.z;
        c.rpx = a->rp.x; c.rpz = a->rp.z;
        c.bx = a->b.x; c.bz = a->b.z;
        c.fx = a->f.x; c.fz = a->f.z;
        c.shx = kale.x; c.shz = kale.z;
        c.netherYol = yol;
        c.biyom = biyom;
        /* Overworld koşu ~5.6 b/sn, Nether arazisi daha yavaş ~4.5 b/sn.
         * Ağaçsız biyomda başlamak odun için ek yürüme demek. */
        c.sn = dPortal / 5.6 + yol / 4.5 + ceza;
        g_sayBulunan[t]++;

        /* Bu yapı düzeni için en iyi YAPI_BASINA tanesini tut. */
        if (yerelN == YAPI_BASINA && c.sn >= yerel[yerelN - 1].sn) continue;
        int j = yerelN < YAPI_BASINA ? yerelN++ : yerelN - 1;
        while (j > 0 && yerel[j - 1].sn > c.sn) { yerel[j] = yerel[j - 1]; j--; }
        yerel[j] = c;
    }
    for (int i = 0; i < yerelN; i++) topEkle(&yerel[i]);
}

/* --------------------------- iş parçacığı -------------------------------- */

static uint64_t s48Hesapla(uint64_t i)
{
    /* Bilgisayarlar arası dilimleme: i'nci sıra → bu PC'nin seed'i. */
    return (i * (uint64_t)A.toplam + (uint64_t)(A.pc - 1)) & ((1ULL << 48) - 1);
}

static void *calisan(void *arg)
{
    int t = (int)(intptr_t)arg;
    Generator gO, gN;
    setupGenerator(&gO, MC, 0);
    setupGenerator(&gN, MC, 0);
    AdayA a;
    while (!g_dur) {
        uint64_t blok = __atomic_fetch_add(&g_siradakiBlok, 1, __ATOMIC_SEQ_CST);
        g_aktifBlok[t] = blok;
        for (uint64_t j = 0; j < BLOK && !g_dur; j++) {
            uint64_t s48 = s48Hesapla(blok * BLOK + j);
            g_saySay48[t]++;
            if (!asamaA(s48, &a)) continue;
            g_sayGecA[t]++;
            asamaB(s48, &a, &gO, &gN, t);
        }
    }
    g_aktifBlok[t] = UINT64_MAX;
    return NULL;
}

#ifdef _WIN32
static DWORD WINAPI calisanWin(LPVOID arg) { calisan(arg); return 0; }
#endif

/* --------------------------- dosyalar ------------------------------------ */

static void kaydet(int bitti)
{
    /* Devam noktası: hâlâ işlenen en küçük blok (biraz tekrar iş, kayıp yok). */
    uint64_t devam = __atomic_load_n(&g_siradakiBlok, __ATOMIC_SEQ_CST);
    for (int t = 0; t < A.threads; t++)
        if (g_aktifBlok[t] < devam) devam = g_aktifBlok[t];

    char tmp[600];
    snprintf(tmp, sizeof tmp, "%s.tmp", A.cikti);
    FILE *f = fopen(tmp, "w");
    if (!f) { fprintf(stderr, "\nYazılamadı: %s\n", tmp); return; }
    uint64_t s48 = 0, gecA = 0, seed = 0, bul = 0;
    for (int t = 0; t < A.threads; t++) {
        s48 += g_saySay48[t]; gecA += g_sayGecA[t]; seed += g_saySeed[t]; bul += g_sayBulunan[t];
    }
    fprintf(f, "# FastAuto seed avcisi v%s | Minecraft %s | pc %d/%d | %s\n",
            PROGRAM_SURUM, SURUM, A.pc, A.toplam, bitti ? "bitti" : "devam ediyor");
    fprintf(f, "# bu oturumda: %" PRIu64 " yapi tohumu, %" PRIu64 " aday, %" PRIu64 " tam seed denendi, %" PRIu64 " uygun\n",
            s48, gecA, seed, bul);
    fprintf(f, "# sn = tahmini yol suresi (dusuk = iyi). Koordinatlar: spawn/portal/kale overworld, bastion/fortress nether.\n");
    fprintf(f, "# seed\tsn\tspawn\tportal\tbastion\tfortress\tkale\tnether\tbiyom\n");
    LOCK();
    for (int i = 0; i < g_topN; i++) {
        Aday *c = &g_top[i];
        const char *ad = biome2str(MC, c->biyom);
        fprintf(f, "%" PRId64 "\t%.1f\tspawn=%d,%d\tportal=%d,%d\tbastion=%d,%d\tfortress=%d,%d\tkale=%d,%d\tnether=%d\tbiyom=%d:%s\n",
                (int64_t)c->seed, c->sn, c->spx, c->spz, c->rpx, c->rpz, c->bx, c->bz,
                c->fx, c->fz, c->shx, c->shz, c->netherYol, c->biyom, ad ? ad : "?");
    }
    UNLOCK();
    fclose(f);
    remove(A.cikti);
    if (rename(tmp, A.cikti) != 0) fprintf(stderr, "\nDosya adı değiştirilemedi: %s\n", A.cikti);

    FILE *d = fopen(A.durum, "w");
    if (d) {
        fprintf(d, "%d %d %" PRIu64 " %.0f\n", A.pc, A.toplam, devam, g_oncekiSure + g_buOturum);
        fclose(d);
    }
}

static void oncekiniYukle(void)
{
    FILE *d = fopen(A.durum, "r");
    if (d) {
        int pc, toplam;
        uint64_t blok;
        double sure = 0;
        int n = fscanf(d, "%d %d %" SCNu64 " %lf", &pc, &toplam, &blok, &sure);
        if (n >= 3) {
            if (pc != A.pc || toplam != A.toplam) {
                fprintf(stderr, "Uyarı: %s başka bir ayarla (pc %d/%d) kaydedilmiş. Baştan başlıyorum.\n",
                        A.durum, pc, toplam);
            } else {
                g_siradakiBlok = g_baslangicBlok = blok;
                if (n == 4) g_oncekiSure = sure;
                printf("Kaldığı yerden devam: blok %" PRIu64 "\n", blok);
            }
        }
        fclose(d);
    }
    FILE *f = fopen(A.cikti, "r");
    if (!f) return;
    char satir[1024];
    while (fgets(satir, sizeof satir, f)) {
        if (satir[0] == '#') continue;
        Aday c;
        int64_t s;
        char ad[64];
        if (sscanf(satir, "%" SCNd64 "\t%lf\tspawn=%d,%d\tportal=%d,%d\tbastion=%d,%d\tfortress=%d,%d\tkale=%d,%d\tnether=%d\tbiyom=%d:%63s",
                   &s, &c.sn, &c.spx, &c.spz, &c.rpx, &c.rpz, &c.bx, &c.bz, &c.fx, &c.fz,
                   &c.shx, &c.shz, &c.netherYol, &c.biyom, ad) >= 14) {
            c.seed = (uint64_t)s;
            topEkle(&c);
        }
    }
    fclose(f);
    if (g_topN) printf("Önceki sonuçlardan %d seed yüklendi.\n", g_topN);
}

/* --------------------------- ana program --------------------------------- */

/* --------------------------- canlı panel --------------------------------- */

static void binlik(char *out, size_t n, uint64_t v)
{
    char tmp[32];
    snprintf(tmp, sizeof tmp, "%" PRIu64, v);
    int len = (int)strlen(tmp), o = 0;
    for (int i = 0; i < len && o < (int)n - 2; i++) {
        if (i && (len - i) % 3 == 0) out[o++] = '.';
        out[o++] = tmp[i];
    }
    out[o] = 0;
}

static void sureYaz(char *out, size_t n, double sn)
{
    uint64_t s = (uint64_t)sn;
    unsigned gun = (unsigned)(s / 86400), sa = (unsigned)(s % 86400 / 3600);
    unsigned dk = (unsigned)(s % 3600 / 60), sec = (unsigned)(s % 60);
    if (gun) snprintf(out, n, "%u gun %02u:%02u:%02u", gun, sa, dk, sec);
    else snprintf(out, n, "%02u:%02u:%02u", sa, dk, sec);
}

static void kalanYaz(char *out, size_t n, double sn)
{
    double yil = sn / (365.25 * 86400);
    if (yil >= 1e9) snprintf(out, n, "~%.1f milyar yil", yil / 1e9);
    else if (yil >= 1e6) snprintf(out, n, "~%.1f milyon yil", yil / 1e6);
    else if (yil >= 1) snprintf(out, n, "~%.0f yil", yil);
    else { sureYaz(out, n, sn); }
}

/* ------------------------------------------------------------------------- */
/* Panele otomatik yükleme (sadece Windows). Aynı klasörde panel.txt varsa
 * (1. satır: https://okul.zeax.dev, 2. satır: yükleme anahtarı) .json
 * durum dosyası 30 sn'de bir panele gönderilir. */

static int g_yukAcik = 0;            /* panel.txt bulundu mu */
static volatile int g_yukDurum = 0;  /* 0: henüz yok, 1: tamam, 2: hata */
static volatile long g_yukKod = 0;   /* son HTTP kodu ya da Windows hata kodu */
static volatile time_t g_yukZaman = 0;

#ifdef _WIN32
static char g_panelHost[256], g_anahtar[128];
static INTERNET_PORT g_panelPort = 443;
static int g_panelHttps = 1;

static void kirp(char *t)
{
    size_t n = strlen(t);
    while (n && (t[n - 1] == '\r' || t[n - 1] == '\n' || t[n - 1] == ' ' || t[n - 1] == '\t')) t[--n] = 0;
}

static void panelAyarOku(void)
{
    FILE *f = fopen("panel.txt", "r");
    if (!f) return;
    char url[300] = "", key[160] = "";
    if (!fgets(url, sizeof url, f) || !fgets(key, sizeof key, f)) { fclose(f); return; }
    fclose(f);
    kirp(url); kirp(key);
    const char *h = url;
    if (!strncmp(h, "https://", 8)) { h += 8; g_panelHttps = 1; g_panelPort = 443; }
    else if (!strncmp(h, "http://", 7)) { h += 7; g_panelHttps = 0; g_panelPort = 80; }
    snprintf(g_panelHost, sizeof g_panelHost, "%s", h);
    char *e = strchr(g_panelHost, '/'); if (e) *e = 0;
    e = strchr(g_panelHost, ':'); if (e) { *e = 0; g_panelPort = (INTERNET_PORT)atoi(e + 1); }
    snprintf(g_anahtar, sizeof g_anahtar, "%s", key);
    g_yukAcik = g_panelHost[0] && g_anahtar[0];
}

/* Panele bir HTTP isteği. out verilirse cevabın gövdesi oraya okunur. */
static int httpIstek(const char *metod, const char *yol, const char *govde, DWORD gn,
                     char *out, DWORD cap, DWORD *outN, long *kodOut)
{
    int ok = 0;
    long kodSon = 0;
    DWORD zaman = 20000;
    HINTERNET net = InternetOpenA("FastAuto-SeedAvcisi/" PROGRAM_SURUM, INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
    if (!net) { *kodOut = (long)GetLastError(); return 0; }
    /* Windows 7/8'de TLS 1.1/1.2 WinINet'te kapalı gelebiliyor; Cloudflare ise
     * eski TLS'i reddediyor. 184 = INTERNET_OPTION_SECURE_PROTOCOLS,
     * 0xA80 = TLS 1.0 | 1.1 | 1.2. (Windows 11'de zaten açık, zararsız.) */
    DWORD protokol = 0x80 | 0x200 | 0x800;
    InternetSetOptionA(net, 184, &protokol, sizeof protokol);
    InternetSetOptionA(net, INTERNET_OPTION_CONNECT_TIMEOUT, &zaman, sizeof zaman);
    InternetSetOptionA(net, INTERNET_OPTION_SEND_TIMEOUT, &zaman, sizeof zaman);
    InternetSetOptionA(net, INTERNET_OPTION_RECEIVE_TIMEOUT, &zaman, sizeof zaman);
    HINTERNET con = InternetConnectA(net, g_panelHost, g_panelPort, NULL, NULL, INTERNET_SERVICE_HTTP, 0, 0);
    if (con) {
        DWORD bayrak = INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE | INTERNET_FLAG_NO_COOKIES | INTERNET_FLAG_NO_UI;
        if (g_panelHttps) bayrak |= INTERNET_FLAG_SECURE;
        HINTERNET req = HttpOpenRequestA(con, metod, yol, NULL, NULL, NULL, bayrak, 0);
        if (req) {
            char baslik[300];
            snprintf(baslik, sizeof baslik, "%sX-Yukleme-Anahtari: %s\r\n",
                     govde ? "Content-Type: application/json\r\n" : "", g_anahtar);
            if (HttpSendRequestA(req, baslik, (DWORD)-1L, (LPVOID)govde, gn)) {
                DWORD kod = 0, sz = sizeof kod;
                if (HttpQueryInfoA(req, HTTP_QUERY_STATUS_CODE | HTTP_QUERY_FLAG_NUMBER, &kod, &sz, NULL)) {
                    kodSon = (long)kod;
                    ok = kod == 200;
                }
                if (ok && out) {
                    DWORD top = 0, r = 0;
                    while (top < cap && InternetReadFile(req, out + top, cap - top, &r) && r) top += r;
                    if (top >= cap) ok = 0;  /* beklenenden büyük */
                    *outN = top;
                }
            } else kodSon = (long)GetLastError();
            InternetCloseHandle(req);
        } else kodSon = (long)GetLastError();
        InternetCloseHandle(con);
    } else kodSon = (long)GetLastError();
    InternetCloseHandle(net);
    *kodOut = kodSon;
    return ok;
}

static int yukle(void)
{
    char yol[600];
    snprintf(yol, sizeof yol, "%s.json", A.cikti);
    FILE *f = fopen(yol, "rb");
    if (!f) return 0;
    static char buf[256 * 1024];
    size_t n = fread(buf, 1, sizeof buf, f);
    fclose(f);
    if (!n) return 0;
    long kod = 0;
    int ok = httpIstek("POST", "/api/yukle", buf, (DWORD)n, NULL, 0, NULL, &kod);
    g_yukKod = kod;
    return ok;
}

/* ---- Otomatik güncelleme: panel daha yeni bir sürüm dağıtıyorsa indir. ---- */

__attribute__((used)) static const char g_isaret[] = "FASTAUTO-SURUM:" PROGRAM_SURUM ":";
#define YENI_DOSYA "seed-avcisi.yeni"
static int g_gunAcik = 1;
static volatile int g_gunDurum = 0;  /* 0: bakılmadı, 1: güncel, 2: indiriliyor, 3: hazır, 4: hata */
static volatile int g_yeniSurum = 0;

static int sha256Hex(const BYTE *d, DWORD n, char *hex)
{
    HCRYPTPROV p; HCRYPTHASH h; BYTE o[32]; DWORD on = sizeof o; int ok = 0;
    if (!CryptAcquireContextA(&p, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return 0;
    if (CryptCreateHash(p, CALG_SHA_256, 0, 0, &h)) {
        if (CryptHashData(h, d, n, 0) && CryptGetHashParam(h, HP_HASHVAL, o, &on, 0) && on == 32) {
            for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", o[i]);
            ok = 1;
        }
        CryptDestroyHash(h);
    }
    CryptReleaseContext(p, 0);
    return ok;
}

static void guncellemeBak(void)
{
    char cevap[512]; DWORD n = 0; long kod = 0;
    if (!g_panelHttps) return;  /* sadece şifreli bağlantıdan */
    if (!httpIstek("GET", "/api/surum", NULL, 0, cevap, sizeof cevap - 1, &n, &kod)) return;
    cevap[n] = 0;
    int surum = 0; long boyut = 0; char sha[80] = "";
    const char *a = strstr(cevap, "\"surum\":"), *b = strstr(cevap, "\"sha256\":\""), *c = strstr(cevap, "\"boyut\":");
    if (!a || !b || !c) return;
    surum = atoi(a + 8); boyut = atol(c + 8);
    snprintf(sha, 65, "%s", b + 10);
    if (surum <= atoi(PROGRAM_SURUM)) { g_gunDurum = 1; return; }
    if (boyut < 100000 || boyut > 32 * 1024 * 1024 || strlen(sha) != 64) { g_gunDurum = 4; return; }
    g_gunDurum = 2;
    DWORD cap = (DWORD)boyut + 16, bn = 0;
    char *buf = (char *)malloc(cap), hex[80] = "";
    int ok = buf && httpIstek("GET", "/api/exe", NULL, 0, buf, cap, &bn, &kod) && (long)bn == boyut &&
             buf[0] == 'M' && buf[1] == 'Z' && sha256Hex((const BYTE *)buf, bn, hex) && !strcmp(hex, sha);
    if (ok) {
        FILE *f = fopen(YENI_DOSYA, "wb");
        ok = f && fwrite(buf, 1, bn, f) == bn;
        if (f) ok = !fclose(f) && ok;
    }
    free(buf);
    if (ok) { g_yeniSurum = surum; g_gunDurum = 3; }
    else g_gunDurum = 4;
}

static DWORD WINAPI guncelleyici(LPVOID arg)
{
    (void)arg;
    Sleep(15000);
    for (;;) {
        if (g_gunAcik && g_yukAcik && g_gunDurum != 3) guncellemeBak();
        Sleep(30 * 60 * 1000);
    }
    return 0;
}

static void kendiniBaslat(void)
{
    char ben[MAX_PATH];
    STARTUPINFOA si; PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof si); si.cb = sizeof si;
    GetModuleFileNameA(NULL, ben, sizeof ben);
    char *komut = _strdup(GetCommandLineA());
    if (CreateProcessA(ben, komut, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    }
    ExitProcess(0);
}

/* İndirilen sürümü yerine koy ve yeniden başla. Motor durdurulmuş ve kaydedilmiş olmalı.
 * Çalışan exe silinemez ama adı değiştirilebilir: eskiyi .eski yap, yeniyi yerine koy. */
static void guncellemeUygula(void)
{
    char ben[MAX_PATH], eski[MAX_PATH + 8];
    GetModuleFileNameA(NULL, ben, sizeof ben);
    snprintf(eski, sizeof eski, "%s.eski", ben);
    DeleteFileA(eski);
    if (MoveFileA(ben, eski)) {
        if (!MoveFileA(YENI_DOSYA, ben)) MoveFileA(eski, ben);
    }
    DeleteFileA(YENI_DOSYA);
    kendiniBaslat();
}

static void eskiyiSil(void)
{
    char ben[MAX_PATH], eski[MAX_PATH + 8];
    GetModuleFileNameA(NULL, ben, sizeof ben);
    snprintf(eski, sizeof eski, "%s.eski", ben);
    for (int i = 0; i < 10 && GetFileAttributesA(eski) != INVALID_FILE_ATTRIBUTES && !DeleteFileA(eski); i++) Sleep(300);
}

static void yukleVeIsaretle(void)
{
    int ok = yukle();
    g_yukDurum = ok ? 1 : 2;
    if (ok) g_yukZaman = time(NULL);
}

static DWORD WINAPI yukleyici(LPVOID arg)
{
    (void)arg;
    int bekle = 8;  /* ilk yükleme: ilk .json yazıldıktan hemen sonra */
    while (!g_dur) {
        for (int i = 0; i < bekle * 10 && !g_dur; i++) Sleep(100);
        if (g_dur) break;
        yukleVeIsaretle();
        bekle = 30;
    }
    return 0;
}
#endif

static void yuklemeYazi(char *out, size_t n)
{
    if (!g_yukAcik) { snprintf(out, n, "kapali (panel.txt yok)"); return; }
    if (g_yukDurum == 0) { snprintf(out, n, "bekliyor..."); return; }
    if (g_yukDurum == 1) {
        struct tm *t = localtime((const time_t *)&g_yukZaman);
        snprintf(out, n, "tamam, son yukleme %02d:%02d:%02d", t ? t->tm_hour : 0, t ? t->tm_min : 0, t ? t->tm_sec : 0);
        return;
    }
    if (g_yukKod == 401) snprintf(out, n, "HATA: anahtar yanlis (panelden paketi yeniden indir)");
    else if (g_yukKod >= 100 && g_yukKod < 600) snprintf(out, n, "HATA: panel %ld dondu, tekrar denenecek", g_yukKod);
    else snprintf(out, n, "HATA: baglanti yok (kod %ld), tekrar denenecek", g_yukKod);
}

#define SATIR "\033[K\n"

static void paneliCiz(double gecen, double hiz)
{
    uint64_t dilim = ((1ULL << 48) + (uint64_t)A.toplam - 1) / (uint64_t)A.toplam;
    uint64_t taranan = __atomic_load_n(&g_siradakiBlok, __ATOMIC_SEQ_CST) * BLOK;
    if (taranan > dilim) taranan = dilim;
    uint64_t kalan = dilim - taranan;
    uint64_t gecA = 0, seed = 0, bul = 0;
    for (int t = 0; t < A.threads; t++) { gecA += g_sayGecA[t]; seed += g_saySeed[t]; bul += g_sayBulunan[t]; }

    char b1[40], b2[40], b3[40], b4[40], b5[40], s1[40], s2[40], k1[40];
    binlik(b1, sizeof b1, taranan);
    binlik(b2, sizeof b2, kalan);
    binlik(b3, sizeof b3, seed);
    binlik(b4, sizeof b4, bul);
    binlik(b5, sizeof b5, gecA);
    sureYaz(s1, sizeof s1, gecen);
    sureYaz(s2, sizeof s2, g_oncekiSure + gecen);
    kalanYaz(k1, sizeof k1, hiz > 0 ? kalan / hiz : 0);
    double yuzde = 100.0 * (double)taranan / (double)dilim;

    printf("\033[H");
    printf("================ FastAuto Seed Avcisi - Minecraft %s ================" SATIR, SURUM);
    printf(SATIR);
    printf("  Bilgisayar     : %d / %d   (%d cekirdek)" SATIR, A.pc, A.toplam, A.threads);
    printf("  Sure           : bu oturum %s  |  toplam %s" SATIR, s1, s2);
    printf("  Hiz            : %.0f yapi duzeni/sn" SATIR, hiz);
    printf("  Taranan        : %s yapi duzeni" SATIR, b1);
    printf("  Yuzde          : %%%.10f  (bu bilgisayarin dilimi)" SATIR, yuzde);
    printf("  Kalan          : %s yapi duzeni  (%s)" SATIR, b2, k1);
    printf("  Son denenen    : %" PRId64 SATIR, (int64_t)g_sonSeed);
    printf("  Bu oturumda    : %s seed denendi, %s aday duzen, %s uygun seed" SATIR, b3, b5, b4);
    printf("  Sonuc dosyasi  : %s  (30 sn'de bir kaydedilir)" SATIR, A.cikti);
    if (g_yukAcik) {
        char y[120];
        yuklemeYazi(y, sizeof y);
        printf("  Panele yukleme : %s" SATIR, y);
    }
    printf(SATIR);
    printf("  EN IYI SEED'LER  (sn = tahmini yol suresi, dusuk = iyi)" SATIR);
    printf("  ---------------------------------------------------------------------------" SATIR);
    printf("   #  %-21s %6s  %-18s %7s %7s  %s" SATIR, "seed", "sn", "biyom", "portal", "nether", "kale");
    LOCK();
    int n = g_topN < 15 ? g_topN : 15;
    for (int i = 0; i < n; i++) {
        Aday *c = &g_top[i];
        const char *ad = biome2str(MC, c->biyom);
        printf("  %2d. %-21" PRId64 " %6.1f  %-18.18s %6.0fb %6db  %d,%d" SATIR, i + 1, (int64_t)c->seed, c->sn,
               ad ? ad : "?", uzak(c->spx, c->spz, c->rpx, c->rpz), c->netherYol, c->shx, c->shz);
    }
    UNLOCK();
    if (!n) printf("  (henuz bulunmadi, birkac dakika surebilir)" SATIR);
    printf(SATIR "  Ctrl+C: durdur ve kaydet (tekrar calistirinca kaldigi yerden devam eder)" SATIR);
    printf("\033[J");
    fflush(stdout);
}

/* Web paneli için istatistikleri JSON olarak yaz (5 sn'de bir). */
static void jsonYaz(double gecen, double hiz)
{
    char yol[600], tmp[620];
    snprintf(yol, sizeof yol, "%s.json", A.cikti);
    snprintf(tmp, sizeof tmp, "%s.tmp", yol);
    FILE *f = fopen(tmp, "w");
    if (!f) return;
    uint64_t dilim = ((1ULL << 48) + (uint64_t)A.toplam - 1) / (uint64_t)A.toplam;
    uint64_t taranan = __atomic_load_n(&g_siradakiBlok, __ATOMIC_SEQ_CST) * BLOK;
    if (taranan > dilim) taranan = dilim;
    uint64_t gecA = 0, seed = 0, bul = 0;
    for (int t = 0; t < A.threads; t++) { gecA += g_sayGecA[t]; seed += g_saySeed[t]; bul += g_sayBulunan[t]; }
    fprintf(f, "{\"program\":\"%s\",\"minecraft\":\"%s\",\"pc\":%d,\"toplam\":%d,\"cekirdek\":%d,"
               "\"guncellendi\":%lld,\"oturumSn\":%.0f,\"toplamSn\":%.0f,\"hiz\":%.1f,"
               "\"taranan\":%" PRIu64 ",\"dilim\":%" PRIu64 ",\"sonSeed\":\"%" PRId64 "\","
               "\"denenenSeed\":%" PRIu64 ",\"adayDuzen\":%" PRIu64 ",\"uygunSeed\":%" PRIu64 ",\"enIyiler\":[",
            PROGRAM_SURUM, SURUM, A.pc, A.toplam, A.threads, (long long)time(NULL), gecen,
            g_oncekiSure + gecen, hiz, taranan, dilim, (int64_t)g_sonSeed, seed, gecA, bul);
    LOCK();
    int n = g_topN < 100 ? g_topN : 100;
    for (int i = 0; i < n; i++) {
        Aday *c = &g_top[i];
        const char *ad = biome2str(MC, c->biyom);
        fprintf(f, "%s{\"seed\":\"%" PRId64 "\",\"sn\":%.1f,\"spawn\":[%d,%d],\"portal\":[%d,%d],"
                   "\"bastion\":[%d,%d],\"fortress\":[%d,%d],\"kale\":[%d,%d],\"nether\":%d,\"biyom\":\"%s\"}",
                i ? "," : "", (int64_t)c->seed, c->sn, c->spx, c->spz, c->rpx, c->rpz, c->bx, c->bz,
                c->fx, c->fz, c->shx, c->shz, c->netherYol, ad ? ad : "?");
    }
    UNLOCK();
    fprintf(f, "]}\n");
    fclose(f);
    remove(yol);
    rename(tmp, yol);
}

static void durdur(int sig) { (void)sig; g_dur = 1; }

static int cekirdekSayisi(void)
{
#ifdef _WIN32
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return (int)si.dwNumberOfProcessors;
#else
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return n > 0 ? (int)n : 1;
#endif
}

static void yardim(void)
{
    printf(
        "FastAuto seed avcisi v" PROGRAM_SURUM " (Minecraft " SURUM ")\n\n"
        "Kullanim: seed-avcisi --pc <no> --toplam <bilgisayar sayisi> [secenekler]\n\n"
        "  --pc N          Bu bilgisayarin numarasi (1'den baslar)\n"
        "  --toplam M      Toplam kac bilgisayar tariyor\n"
        "  --cekirdek K    Kac cekirdek kullanilsin (varsayilan: hepsi)\n"
        "  --cikti DOSYA   Sonuc dosyasi (varsayilan: seedler-pcN.txt)\n"
        "  --en-iyi K      Dosyada tutulacak en iyi seed sayisi (varsayilan: 1000)\n"
        "  --dakika D      D dakika sonra dur (varsayilan: Ctrl+C'ye kadar)\n"
        "  --portal B      Dogma -> yikik portal en fazla B blok (varsayilan: 120)\n"
        "  --nether B      Nether merkezi -> bastion/fortress en fazla B blok (varsayilan: 120)\n"
        "  --kale B        Kalenin merkeze uzakligi en fazla B blok (varsayilan: 1700)\n"
        "  --ust U         Her yapi tohumu icin denenecek ust-16 cesidi (varsayilan: 4096, en fazla 65536)\n"
        "  --normal-oncelik Bilgisayari yavaslatma pahasina tam hiz\n"
        "  --sade          Canli panel yerine tek satir ilerleme\n"
        "  --sessiz        Ilerleme yazma (servis olarak calistirmak icin)\n"
        "Windows: secenek verilmezse pencere (GUI) acilir.\n\n"
        "Ctrl+C ile durdurabilirsin; tekrar calistirinca kaldigi yerden devam eder.\n");
}

/* ------------------------------------------------------------------------- */
/* Motor: tarama iş parçacıkları. Konsol ve pencere aynı işlevleri kullanır. */

static thread_t g_th[MAX_THREAD];
static time_t g_bas, g_sonKayit;

static void ayarVarsayilan(void)
{
    memset(&A, 0, sizeof A);
    A.topk = 1000;
    A.portalMax = 120; A.netherMax = 120; A.kaleMax = 1700; A.dusukOncelik = 1; A.ust = 4096;
}

static void ayarDuzelt(void)
{
    if (A.threads <= 0) A.threads = cekirdekSayisi();
    if (A.threads > MAX_THREAD) A.threads = MAX_THREAD;
    if (A.topk < 10) A.topk = 10;
    if (A.ust < 1) A.ust = 1;
    if (A.ust > 65536) A.ust = 65536;
    if (!A.cikti[0]) snprintf(A.cikti, sizeof A.cikti, "seedler-pc%d.txt", A.pc);
    snprintf(A.durum, sizeof A.durum, "%s.durum", A.cikti);
}

static void motorBaslat(void)
{
    g_top = (Aday *)calloc((size_t)A.topk, sizeof(Aday));
#ifdef _WIN32
    if (A.dusukOncelik) SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
#else
    if (A.dusukOncelik && nice(10) == -1) { /* önemli değil */ }
#endif
    for (int t = 0; t < MAX_THREAD; t++) g_aktifBlok[t] = UINT64_MAX;
    oncekiniYukle();
    for (int t = 0; t < A.threads; t++) {
#ifdef _WIN32
        g_th[t] = CreateThread(NULL, 0, calisanWin, (LPVOID)(intptr_t)t, 0, NULL);
#else
        pthread_create(&g_th[t], NULL, calisan, (void *)(intptr_t)t);
#endif
    }
#ifdef _WIN32
    if (g_yukAcik) CreateThread(NULL, 0, yukleyici, NULL, 0, NULL);
#endif
    g_bas = g_sonKayit = time(NULL);
}

/* Saniyede bir çağrılır: sayaçları toplar, dosyaları yazar. */
static void motorTik(double *gecenOut, double *hizOut)
{
    time_t simdi = time(NULL);
    double gecen = difftime(simdi, g_bas);
    g_buOturum = gecen;
    uint64_t s48 = 0;
    for (int t = 0; t < A.threads; t++) s48 += g_saySay48[t];
    double hiz = gecen > 0 ? s48 / gecen : 0;
    if ((long long)gecen % 5 == 0) jsonYaz(gecen, hiz);
    if (difftime(simdi, g_sonKayit) >= 30) { kaydet(0); g_sonKayit = simdi; }
    if (A.dakika > 0 && gecen >= A.dakika * 60) g_dur = 1;
    *gecenOut = gecen; *hizOut = hiz;
}

static void motorDurdur(void)
{
    g_dur = 1;
    for (int t = 0; t < A.threads; t++) {
#ifdef _WIN32
        WaitForSingleObject(g_th[t], INFINITE);
#else
        pthread_join(g_th[t], NULL);
#endif
    }
    kaydet(1);
#ifdef _WIN32
    if (g_yukAcik) {
        jsonYaz(g_buOturum, 0);
        yukleVeIsaretle();
    }
#endif
}

#ifdef _WIN32
/* ------------------------------------------------------------------------- */
/* Pencere (GUI). Seçenek verilmeden açılınca çalışır.
 * ayar.txt: "PC TOPLAM [CEKIRDEK] [GUNCELLE]" — varsa kendiliğinden başlar. */

enum { ID_PC = 101, ID_TOPLAM, ID_CEKIRDEK, ID_BASLAT, ID_DURDUR, ID_GUNCELLE, ID_DURUM, ID_LISTE };
static HWND g_pen;
static int g_calisiyor = 0, g_durduruldu = 0;
static char g_oncekiListe[8192];

static void yaziKoy(HWND h, const char *utf8)
{
    static WCHAR w[8192];
    MultiByteToWideChar(CP_UTF8, 0, utf8, -1, w, 8192);
    SetWindowTextW(h, w);
}

static int sayiAl(int id)
{
    char t[32] = "";
    GetDlgItemTextA(g_pen, id, t, sizeof t);
    return atoi(t);
}

static void ayarKaydet(int pc, int toplam, int cekirdek)
{
    FILE *f = fopen("ayar.txt", "w");
    if (!f) return;
    fprintf(f, "%d %d %d %d\n", pc, toplam, cekirdek, g_gunAcik);
    fclose(f);
}

static void dugmeleriAyarla(void)
{
    EnableWindow(GetDlgItem(g_pen, ID_PC), !g_calisiyor);
    EnableWindow(GetDlgItem(g_pen, ID_TOPLAM), !g_calisiyor);
    EnableWindow(GetDlgItem(g_pen, ID_CEKIRDEK), !g_calisiyor);
    EnableWindow(GetDlgItem(g_pen, ID_BASLAT), !g_calisiyor);
    EnableWindow(GetDlgItem(g_pen, ID_DURDUR), g_calisiyor);
}

static void guiBaslat(void)
{
    int pc = sayiAl(ID_PC), toplam = sayiAl(ID_TOPLAM), cek = sayiAl(ID_CEKIRDEK);
    if (toplam < 1 || pc < 1 || pc > toplam) {
        MessageBoxW(g_pen, L"Bilgisayar no 1 ile Toplam PC arasında olmalı.\nÖrnek: Bilgisayar no 3, Toplam PC 6.",
                    L"Seed Avcısı", MB_OK | MB_ICONWARNING);
        return;
    }
    if (cek < 0) cek = 0;
    ayarKaydet(pc, toplam, cek);
    /* Durdurulduktan sonra yeniden başlat: en temizi programı baştan açmak. */
    if (g_durduruldu) kendiniBaslat();
    A.pc = pc; A.toplam = toplam; A.threads = cek;
    ayarDuzelt();
    motorBaslat();
    g_calisiyor = 1;
    dugmeleriAyarla();
}

static void guiDurdur(void)
{
    if (!g_calisiyor) return;
    yaziKoy(GetDlgItem(g_pen, ID_DURUM), "Durduruluyor, kaydediliyor...");
    UpdateWindow(g_pen);
    motorDurdur();
    g_calisiyor = 0; g_durduruldu = 1;
    dugmeleriAyarla();
}

static void guiCiz(void)
{
    char d[2048], y[160], gun[120] = "";
    if (g_gunDurum == 1) snprintf(gun, sizeof gun, "güncel");
    else if (g_gunDurum == 2) snprintf(gun, sizeof gun, "yeni sürüm indiriliyor...");
    else if (g_gunDurum == 3) snprintf(gun, sizeof gun, "sürüm %d indirildi, yeniden başlıyor", g_yeniSurum);
    else if (g_gunDurum == 4) snprintf(gun, sizeof gun, "indirilemedi, sonra tekrar denenecek");
    else snprintf(gun, sizeof gun, "%s", !g_yukAcik ? "kapalı (panel.txt yok)" : g_gunAcik ? "bakılacak" : "kapalı");
    yuklemeYazi(y, sizeof y);
    if (!g_calisiyor) {
        snprintf(d, sizeof d, "%s\n\nPanele yükleme : %s\nGüncelleme     : %s",
                 g_durduruldu ? "Durduruldu ve kaydedildi. \"Başlat\" kaldığı yerden devam eder."
                              : "Bilgisayar numarasını ve toplam PC sayısını yazıp \"Başlat\"a bas.\n"
                                "Her bilgisayara farklı numara ver; toplam hepsinde aynı olmalı.",
                 y, gun);
        yaziKoy(GetDlgItem(g_pen, ID_DURUM), d);
        return;
    }
    double gecen, hiz;
    motorTik(&gecen, &hiz);
    uint64_t dilim = ((1ULL << 48) + (uint64_t)A.toplam - 1) / (uint64_t)A.toplam;
    uint64_t taranan = __atomic_load_n(&g_siradakiBlok, __ATOMIC_SEQ_CST) * BLOK;
    if (taranan > dilim) taranan = dilim;
    uint64_t kalan = dilim - taranan, gecA = 0, seed = 0, bul = 0;
    for (int t = 0; t < A.threads; t++) { gecA += g_sayGecA[t]; seed += g_saySeed[t]; bul += g_sayBulunan[t]; }
    char b1[40], b2[40], b3[40], b4[40], b5[40], s1[40], s2[40], k1[40];
    binlik(b1, sizeof b1, taranan); binlik(b2, sizeof b2, kalan); binlik(b3, sizeof b3, seed);
    binlik(b4, sizeof b4, bul); binlik(b5, sizeof b5, gecA);
    sureYaz(s1, sizeof s1, gecen); sureYaz(s2, sizeof s2, g_oncekiSure + gecen);
    kalanYaz(k1, sizeof k1, hiz > 0 ? kalan / hiz : 0);
    snprintf(d, sizeof d,
             "Bilgisayar     : %d / %d   (%d çekirdek)\n"
             "Süre           : bu oturum %s  |  toplam %s\n"
             "Hız            : %.0f yapı düzeni/sn\n"
             "Taranan        : %s  (%%%.8f)\n"
             "Kalan          : %s  (%s)\n"
             "Son denenen    : %" PRId64 "\n"
             "Bu oturumda    : %s seed denendi, %s aday, %s uygun\n"
             "Sonuç dosyası  : %s\n"
             "Panele yükleme : %s\n"
             "Güncelleme     : %s",
             A.pc, A.toplam, A.threads, s1, s2, hiz, b1, 100.0 * (double)taranan / (double)dilim, b2, k1,
             (int64_t)g_sonSeed, b3, b5, b4, A.cikti, g_yukAcik ? y : "kapalı (panel.txt yok)", gun);
    yaziKoy(GetDlgItem(g_pen, ID_DURUM), d);

    static char l[8192];
    int o = snprintf(l, sizeof l, " #  %-21s %6s  %-18s %7s %7s  %s\r\n", "seed", "sn", "biyom", "portal", "nether", "kale");
    LOCK();
    int n = g_topN < 40 ? g_topN : 40;
    for (int i = 0; i < n && o < (int)sizeof l - 200; i++) {
        Aday *c = &g_top[i];
        const char *ad = biome2str(MC, c->biyom);
        o += snprintf(l + o, sizeof l - o, "%2d. %-21" PRId64 " %6.1f  %-18.18s %6.0fb %6db  %d,%d\r\n", i + 1,
                      (int64_t)c->seed, c->sn, ad ? ad : "?", uzak(c->spx, c->spz, c->rpx, c->rpz), c->netherYol, c->shx, c->shz);
    }
    UNLOCK();
    if (!n) snprintf(l + o, sizeof l - o, "(henüz bulunmadı, birkaç dakika sürebilir)\r\n");
    if (strcmp(l, g_oncekiListe)) {  /* sadece değişince yaz: seçim ve kaydırma bozulmasın */
        snprintf(g_oncekiListe, sizeof g_oncekiListe, "%s", l);
        yaziKoy(GetDlgItem(g_pen, ID_LISTE), l);
    }
}

static LRESULT CALLBACK penIslem(HWND h, UINT m, WPARAM w, LPARAM l)
{
    switch (m) {
    case WM_COMMAND:
        if (LOWORD(w) == ID_BASLAT) guiBaslat();
        else if (LOWORD(w) == ID_DURDUR) guiDurdur();
        else if (LOWORD(w) == ID_GUNCELLE) {
            g_gunAcik = IsDlgButtonChecked(h, ID_GUNCELLE) == BST_CHECKED;
            if (sayiAl(ID_PC) > 0) ayarKaydet(sayiAl(ID_PC), sayiAl(ID_TOPLAM), sayiAl(ID_CEKIRDEK));
        }
        return 0;
    case WM_TIMER:
        if (g_gunDurum == 3 && g_gunAcik) {
            guiCiz();
            if (g_calisiyor) motorDurdur();
            guncellemeUygula();
        }
        guiCiz();
        return 0;
    case WM_CLOSE:
        guiDurdur();
        DestroyWindow(h);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

static HWND kontrol(const WCHAR *sinif, const WCHAR *yazi, DWORD stil, int x, int y, int gen, int yuk, int id, HFONT f)
{
    HWND c = CreateWindowExW(!lstrcmpW(sinif, L"EDIT") ? WS_EX_CLIENTEDGE : 0, sinif, yazi, WS_CHILD | WS_VISIBLE | stil,
                             x, y, gen, yuk, g_pen, (HMENU)(intptr_t)id, GetModuleHandleW(NULL), NULL);
    SendMessageW(c, WM_SETFONT, (WPARAM)f, TRUE);
    return c;
}

static int guiCalistir(void)
{
    HANDLE tek = CreateMutexA(NULL, FALSE, "FastAutoSeedAvcisi");
    DWORD bek = WaitForSingleObject(tek, 8000);  /* güncellemede eski süreç kapanana kadar bekle */
    if (bek != WAIT_OBJECT_0 && bek != WAIT_ABANDONED) {
        MessageBoxW(NULL, L"Seed Avcısı zaten çalışıyor.", L"Seed Avcısı", MB_OK | MB_ICONINFORMATION);
        return 1;
    }
    int pc = 0, toplam = 0, cek = 0, gun = 1;
    FILE *f = fopen("ayar.txt", "r");
    if (f) {
        if (fscanf(f, "%d %d %d %d", &pc, &toplam, &cek, &gun) < 2) pc = toplam = 0;
        fclose(f);
    }
    g_gunAcik = gun != 0;
    panelAyarOku();

    WNDCLASSW wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = penIslem;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hIcon = LoadIcon(NULL, IDI_APPLICATION);
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    wc.lpszClassName = L"FastAutoSeedAvcisi";
    RegisterClassW(&wc);
    RECT r = { 0, 0, 760, 620 };
    DWORD stil = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    AdjustWindowRect(&r, stil, FALSE);
    g_pen = CreateWindowExW(0, wc.lpszClassName, L"FastAuto Seed Avcısı v" PROGRAM_SURUM " — Minecraft " SURUM, stil,
                            CW_USEDEFAULT, CW_USEDEFAULT, r.right - r.left, r.bottom - r.top, NULL, NULL, wc.hInstance, NULL);
    HFONT fn = CreateFontW(-15, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    HFONT fm = CreateFontW(-14, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, FIXED_PITCH, L"Consolas");
    WCHAR t[16];
    kontrol(L"STATIC", L"Bilgisayar no:", 0, 14, 17, 96, 20, 0, fn);
    wsprintfW(t, L"%d", pc);
    kontrol(L"EDIT", pc ? t : L"", ES_NUMBER, 112, 14, 48, 24, ID_PC, fn);
    kontrol(L"STATIC", L"Toplam PC:", 0, 176, 17, 76, 20, 0, fn);
    wsprintfW(t, L"%d", toplam);
    kontrol(L"EDIT", toplam ? t : L"", ES_NUMBER, 254, 14, 48, 24, ID_TOPLAM, fn);
    kontrol(L"STATIC", L"Çekirdek (0 = hepsi):", 0, 318, 17, 140, 20, 0, fn);
    wsprintfW(t, L"%d", cek);
    kontrol(L"EDIT", t, ES_NUMBER, 460, 14, 48, 24, ID_CEKIRDEK, fn);
    kontrol(L"BUTTON", L"Başlat", BS_DEFPUSHBUTTON, 530, 12, 104, 28, ID_BASLAT, fn);
    kontrol(L"BUTTON", L"Durdur", 0, 642, 12, 104, 28, ID_DURDUR, fn);
    kontrol(L"BUTTON", L"Otomatik güncelle (yeni sürümü panelden indirir ve yeniden başlar)", BS_AUTOCHECKBOX, 14, 48, 600, 22, ID_GUNCELLE, fn);
    CheckDlgButton(g_pen, ID_GUNCELLE, g_gunAcik ? BST_CHECKED : BST_UNCHECKED);
    kontrol(L"STATIC", L"", 0, 14, 80, 732, 196, ID_DURUM, fm);
    kontrol(L"STATIC", L"En iyi seed'ler  (sn = tahmini yol süresi, düşük = iyi; kopyalanabilir)", 0, 14, 284, 732, 20, 0, fn);
    kontrol(L"EDIT", L"", ES_MULTILINE | ES_READONLY | ES_AUTOHSCROLL | WS_VSCROLL, 14, 306, 732, 300, ID_LISTE, fm);
    dugmeleriAyarla();
    ShowWindow(g_pen, SW_SHOW);
    if (pc >= 1 && toplam >= 1 && pc <= toplam) guiBaslat();
    guiCiz();
    CreateThread(NULL, 0, guncelleyici, NULL, 0, NULL);
    SetTimer(g_pen, 1, 1000, NULL);
    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        if (IsDialogMessageW(g_pen, &msg)) continue;
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    ReleaseMutex(tek);
    return 0;
}
#endif

int main(int argc, char **argv)
{
    ayarVarsayilan();
#ifdef _WIN32
    InitializeCriticalSection(&g_lock);
    {   /* Dosyalar (ayar.txt, panel.txt, sonuçlar) hep exe'nin klasöründe. */
        char ben[MAX_PATH];
        GetModuleFileNameA(NULL, ben, sizeof ben);
        char *e = strrchr(ben, '\\');
        if (e) { *e = 0; SetCurrentDirectoryA(ben); }
    }
    eskiyiSil();
    if (argc < 2) return guiCalistir();
    /* Seçenek verildi: konsol modu. Exe pencere programı olarak derlendiği için konsolu kendimiz bağlarız. */
    if (!AttachConsole(ATTACH_PARENT_PROCESS)) AllocConsole();
    freopen("CONOUT$", "w", stdout);
    freopen("CONOUT$", "w", stderr);
#endif

    for (int i = 1; i < argc; i++) {
        const char *k = argv[i];
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
#define SAYI(ad, hedef) else if (!strcmp(k, ad) && v) { hedef = atoi(v); i++; }
        if (!strcmp(k, "--yardim") || !strcmp(k, "--help") || !strcmp(k, "-h")) { yardim(); return 0; }
        SAYI("--pc", A.pc)
        SAYI("--toplam", A.toplam)
        SAYI("--cekirdek", A.threads)
        SAYI("--en-iyi", A.topk)
        SAYI("--portal", A.portalMax)
        SAYI("--nether", A.netherMax)
        SAYI("--kale", A.kaleMax)
        SAYI("--ust", A.ust)
        else if (!strcmp(k, "--dakika") && v) { A.dakika = atof(v); i++; }
        else if (!strcmp(k, "--cikti") && v) { snprintf(A.cikti, sizeof A.cikti, "%s", v); i++; }
        else if (!strcmp(k, "--normal-oncelik")) A.dusukOncelik = 0;
        else if (!strcmp(k, "--sade")) g_sade = 1;
        else if (!strcmp(k, "--sessiz")) g_sessiz = 1;
        else { fprintf(stderr, "Bilinmeyen secenek: %s\n\n", k); yardim(); return 1; }
#undef SAYI
    }
    if (A.pc < 1 || A.toplam < 1 || A.pc > A.toplam) {
        yardim();
        fprintf(stderr, "\nHata: --pc ve --toplam gerekli (ornek: --pc 1 --toplam 5)\n");
        return 1;
    }
    ayarDuzelt();
#ifdef _WIN32
    SetConsoleOutputCP(65001);
    {   /* Windows 10+: renkli/canlı panel için VT modu. Windows 7/8'de olmaz, sade moda düşer. */
        HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
        DWORD m;
        if (GetConsoleMode(h, &m) && SetConsoleMode(h, m | 0x0004)) g_ansi = 1;
    }
    panelAyarOku();
    if (g_yukAcik) {
        printf("Panele yukleme acik: %s\n", g_panelHost);
        CreateThread(NULL, 0, guncelleyici, NULL, 0, NULL);
    }
#else
    g_ansi = isatty(1);
#endif
    if (g_sade || g_sessiz) g_ansi = 0;
    signal(SIGINT, durdur);
    signal(SIGTERM, durdur);

    printf("Minecraft %s | pc %d/%d | %d cekirdek | cikti: %s\n", SURUM, A.pc, A.toplam, A.threads, A.cikti);
    printf("Durdurmak icin Ctrl+C (sonuclar kaydedilir, sonra kaldigi yerden devam eder).\n\n");
    motorBaslat();

    if (g_ansi) printf("\033[2J");
    while (!g_dur) {
        uyku_ms(1000);
        double gecen, hiz;
        motorTik(&gecen, &hiz);
#ifdef _WIN32
        if (g_gunDurum == 3) break;
#endif
        if (g_ansi) {
            paneliCiz(gecen, hiz);
        } else if (!g_sessiz) {
            uint64_t gecA = 0, bul = 0;
            for (int t = 0; t < A.threads; t++) { gecA += g_sayGecA[t]; bul += g_sayBulunan[t]; }
            double enIyi = g_topN ? g_top[0].sn : 0;
            /* Kısa tutulur: dar pencerede satır kesilmesin, hata kodu görünsün. */
            char py[40] = "";
            if (g_yukAcik) {
                if (g_yukDurum == 1) snprintf(py, sizeof py, " | panel tamam");
                else if (g_yukDurum == 2) snprintf(py, sizeof py, " | panel HATA %ld", g_yukKod);
                else snprintf(py, sizeof py, " | panel ...");
            }
            printf("\r%5.0fs | %.0f/sn | aday %" PRIu64 " | seed %" PRIu64 " | en iyi %.1f%s    ",
                   gecen, hiz, gecA, bul, enIyi, py);
            fflush(stdout);
        }
    }
    if (g_ansi) printf("\033[2J\033[H");
    printf("\nDurduruluyor...\n");
    motorDurdur();
    printf("Kaydedildi: %s (%d seed)\n", A.cikti, g_topN);
#ifdef _WIN32
    if (g_yukAcik) printf("Panele son durum %s.\n", g_yukDurum == 1 ? "gonderildi" : "GONDERILEMEDI");
    if (g_gunDurum == 3) {
        printf("Yeni surum (%d) indirildi, yeniden baslatiliyor...\n", g_yeniSurum);
        guncellemeUygula();
    }
#endif
    return 0;
}
