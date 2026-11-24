# `proje-hafizasi` — Bağımsız Tak-Çıkar Proje Hafızası, Kanıtlı İş Takibi ve Devir-Teslim Modülü (`v1.0.0`)

Sıfır dış paket bağımlılığıyla (`node_modules` istemez) her projeye tek klasör olarak kopyalanıp takılabilen, **hem ürün sahibinin sade Türkçeyle projeyi canlı izlemesini sağlayan**, hem de **projeyi devralan herhangi bir yapay zekâyı (Claude, Codex, Gemini, Antigravity, OpenCode, Cursor vb.) aynı çalışma disiplinine kilitleyen** hafıza sistemidir.

## Çözdüğü 6 Kör Nokta

1. **Numaralı Harita (`M1`, `M1.1`, `M2`...):** Her ana faz ve alt özellik sabit bir numaraya sahiptir; aklınıza bir fikir geldiğinde yalnızca *"M1.2'ye bakalım"* demeniz yeterlidir.
2. **Sade Türkçe "Ne & Neden?" Hafızası:** Teknik terim yığını yerine her parçanın *ne işe yaradığını*, *neden bu yolun seçildiğini* ve *vazgeçilen yanlış yolları* saklar.
3. **Kanıt & Dürüstlük Bekçisi (`dogrulayici.cjs`):** Gerçek dosyası veya doğrulama komutu olmayan bir maddeye **TAMAMLANDI** denmesine izin vermez; sonradan dosya silinirse panoda otomatik **🔴 KANIT BOZUK** alarmı yakar.
4. **Fikir Park Yeri (`F-01`...):** Çalışırken gelen yeni fikirler eldeki işi bölmeden ilgili madde numarasına çivilenerek saklanır; hiçbir fikir unutulmaz.
5. **Çoklu Yapay Zekâ Devir-Teslim Protokolü (`AI-DEVIR-TESLIM.md`):** Başka bir yapay zekâ aracı projeye girdiğinde 30 saniyede son durumu, kırmızı çizgileri ve girilmeyecek çıkmaz sokakları okur.
6. **Canlı Görsel Pano (`CANLI-PANO.html` + `pano` sunucusu):** Yan ekranda tarayıcıda açıldığında durumu canlı gösterir, arama ve filtreleme yapar.

## Herhangi Bir Projede Hızlı Kurulum

```bash
# Yeni bir projede sıfırdan başlatmak için:
node moduller/proje-hafizasi/src/cli.cjs baslat --kok "/path/to/your-new-project" --proje "Yeni Projem" --hedef "Projenin sade Türkçe amacı"

# Durumu ve kanıt sağlığını kontrol etmek için:
node moduller/proje-hafizasi/src/cli.cjs durum --kok .

# Canlı görsel takip panosunu tarayıcıda açmak için:
node moduller/proje-hafizasi/src/cli.cjs pano --kok .
```
