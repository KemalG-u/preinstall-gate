> 🚧 **Durum: aktif geliştirme.** Yazarın kullanımında çalışıyor; arayüzler değişebilir.

# preinstall-gate

[English README](README.md)

Bir yapay zekâ aracını, beceriyi ya da MCP sunucusunu **kurmadan önce** incelemenize yardım eden yerel web uygulaması. Bir GitHub deposunu, `SKILL.md` dosyasını, ZIP'i ya da yerel dosyaları verirsiniz; araç neler sunuyor, kodda hangi davranışlar ve güvenlik işaretleri görünüyor, nelerin kontrol edilemediği sade Türkçeyle anlatılır. "Kapı" denemesi, küçük bir örnek aracı izin listesiyle ayrı bir ortamda çalıştırabilir ve bir güncellemenin hangi izinleri yeniden istediğini gösterir.

Çalışma adı "Ürün Tanı · Kapı"dır.

## Depoda ne var

| Yol | Ne |
|---|---|
| `uygulama/` | Yerel sunucu (`sunucu.cjs`, 4178 numaralı port), tarayıcı arayüzü, kaynak/depo/iş akışı analiz motorları ve yalıtım yardımcıları. |
| `moduller/model-kapisi/` | Bağımsız, bağımlılıksız modül: bir "rolü" (hızlı-ucuz, derin, uzun bağlam, görsel, vektör...) kullanılabilir bir model ya da CLI ajanına çözer; devre kesici ve anahtar sızdırmayan `.env` okuma içerir. Kendi README'si var. |
| `moduller/proje-hafizasi/` | Bağımsız, bağımlılıksız proje hafızası ve devir-teslim modülü; kanıt denetleyicisi ve küçük canlı pano içerir. Kendi README'si var. |

## Hızlı başlangıç

Gereksinim: Node.js 22.18 ve üstü. Bazı analiz yolları Python 3.12 ister (`python` PATH'te değilse kullanılacak yorumlayıcıyı `URUN_TANI_PYTHON` ile verin). Yalıtılmış denemeler Windows + WSL2 için yazıldı.

```sh
npm start
# sonra http://127.0.0.1:4178/ adresini açın (HTML dosyasını doğrudan açmayın)
```

Port için `URUN_TANI_PORT`. Sunucu yalnız `127.0.0.1` adresini dinler. İlk kullanımda sabitlenmiş üçüncü taraf paketler `uygulama/.cache/` içine indirilir ([THIRD-PARTY.md](THIRD-PARTY.md)); `npm install` gerekmez.

## Testler

```sh
npm test            # 14 geçer, 1 atlanır (canlı ortam testi), ağ gerekmez
npm run test:depo   # depo laboratuvarı testi: GitHub erişimi ve Python 3.12 ister
```

Atlanan test gerçek makineyi sınar (WSL dağıtımları, `gh` oturumu, yerel yönlendirici profili, SSH takma adı); `MODEL_KAPISI_LIVE=1` ile açılır (SSH takma adı `MODEL_KAPISI_SSH_TARGET`, varsayılan `vps`).

## Sınırlar ve doğrulanmamış iddialar

- **Yalıtım ve WSL testleri henüz yapılmadı.** Yalıtım katmanı yazıldı ama bağımsız ve tam bir test turundan geçmedi. "Kapı" denemesini güvenlik sınırı ya da aracın güvenli olduğunun kanıtı saymayın.
- Statik analiz yalnız verilen kodda ve açıklamalarda görünenleri bildirir; temiz rapor garanti değildir.
- Yalnız Windows'ta yazıldı ve denendi. Linux ve macOS denenmedi; CI yalnız Windows'ta koşar.
- Arayüzdeki "Agentic OS örneği" bağlantıları bu depoda bulunmayan dosyalara gider, açılmaz. Laboratuvardaki "Agentic OS" örneği de depoda bulunmayan bir yardımcı modül ister; laboratuvar yalnız belge bulucu örneğini sunar.
- Arayüz yalnız Türkçe.
- Depo laboratuvarı testi gerçek açık depoları indirir; ağa ve kaynak depoların ayakta olmasına bağlıdır.

## Lisans

Apache-2.0, bkz. [LICENSE](LICENSE) ve [NOTICE](NOTICE). Üçüncü taraf notları: [THIRD-PARTY.md](THIRD-PARTY.md).
