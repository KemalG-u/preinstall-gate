# `model-kapisi` — Bağımsız Evrensel Yapay Zekâ Model ve CLI Ajan Kapısı (`v1.2.0` "Maymuncuk")

`model-kapisi`, sıfır dış paket bağımlılığıyla (`node_modules` gerektirmez) çalışan, hem **CommonJS (`require`)** hem **ESM (`import`)** projelerine tek klasör olarak kopyalanıp takılabilen evrensel yapay zekâ keşif, yetenek/duyu yönlendirme, gizlilik politikası ve devre kesici (circuit-breaker) altyapısıdır.

## Neden Sabit Model Adı Yerine "Evrensel Yetenek Rolü + Duyu Etiketi" Kullanır?

Projelerin içine `"deepseek-r1"` veya `"claude-sonnet-4"` gibi sabit model adları yazıldığında, yeni model çıktığında, kota dolduğunda ya da görsel/JSON şeması gerektiğinde kod kırılır.

`model-kapisi` kullanan projeler sabit model adı vermez; **işin rolünü**, **gereken duyuları (`requiredCapabilities`)** ve **veri mahremiyet seviyesini (`privacyLevel`)** ister:
- `hizli-ucuz`: Ön tarama, sınıflandırma, etiketleme
- `dengeli`: Günlük dille modül anlatımı, genel sohbet ve analiz
- `derin-mimari`: Ürünü anlamlı organlara ayırma, iddia vs gerçek kod denetimi (`reasoning`)
- `kod-sokucu`: Seçilen özelliği başka projeye taşınabilir tarif/pakete dönüştürme
- `uzun-baglam`: 120K+ / 500K+ token üstü geniş bağlamlı çok dosyalı incelemeler
- `gorsel-okuyucu`: Ekran görüntüsü, fatura, arayüz tasarımı ve diyagram okuma (`vision`)
- `vektor-gomme`: Anlamsal arama, RAG ve hafıza indeksleme (`embedding`)

## Faz 1 (`v1.2.0`) Kapsamı — "Maymuncuk" Yetenekleri

1. **26 Yerleşik Sağlayıcı ve CLI Ajan Profili (`katalog/saglayicilar.varsayilan.json`):**
   - **16 HTTP API:** `OpenRouter`, `GitHub Models` (`gh` CLI oturum köprüsüyle sıfır ek ayarla aktif!), `NVIDIA NIM`, `DeepSeek`, `Moonshot Kimi`, `MiniMax`, `Z.ai GLM`, `Groq`, `Mistral / Codestral`, `Cerebras`, `SambaNova`, `xAI Grok`, `Together / Fireworks`, `Google Gemini`, `OpenAI`, `Anthropic`.
   - **3 Yerel/Uzak Sunucu Ailesi:** `OmniRoute / Claude Code Router / LiteLLM`, `Ollama`, `LM Studio / vLLM / Llama.cpp`.
   - **7 Başsız CLI Ajanı:** `codex`, `claude`, `opencode`, `gemini`, `aider`, `goose`, `qwen`.
2. **Sıfır Sabit Kodlu Çoklu Ortam Keşfi (`src/kesif.cjs`):**
   - **Dinamik WSL Dağıtım Keşfi (`wsl -l -q`):** Sabit `Ubuntu` ismine bağlı kalmaz; `Debian`, `Ubuntu-24.04`, `Kali` vb. hangi Linux dağıtımı kuruluysa otomatik bulur.
   - **Oturum ve Son Kullanma Tarihi (`expires_at`) Denetimi:** Yalnızca komutun kurulu olmasına (`installed_unauthenticated`) kanmaz; süresi dolmuş ve `refresh_token` içermeyen ölü OAuth dosyalarını `expired_auth` olarak yakalar (yerel, WSL2 ve VPS üzerinde).
   - **Windows Standart Kurulum Yolları Taraması:** `PATH` yenilenmemiş olsa bile `Ollama`, `LM Studio`, `GitHub CLI`, `Bun`, `Scoop`, `Cargo`, `uv` dizinlerindeki ikili dosyaları bulur.
3. **Sıfır Bağımlılıklı `.env` ve Çoklu Anahtar Havuzu (`src/ortam-okuyucu.cjs`):**
   - Takıldığı projenin `.env`, `.env.local` ve `~/.model-kapisi/.env` dosyalarını otomatik okur (`process.env` değerlerini ezmez).
   - Çoklu anahtar rotasyon havuzlarını (`API_KEY="k1,k2"` veya `API_KEY_1`..`API_KEY_9`) algılar ve değer sızdırmadan anahtar sayısını (`keyCount`) raporlar.
4. **Devre Kesici ve Sağlık Hafızası (`src/saglik-hafizasi.cjs`):**
   - `429 rate_limit`, `quota_exhausted`, `auth_failed`, `timeout` bildirimlerinde (`kapi.reportFailure(...)`) bozuk kapıyı üstel geri çekilmeyle soğumaya alır; bir sonraki `resolve()` çağrısı milisaniyesinde sağlıklı yedek kapıya geçer.
5. **Veri Gizliliği ve Güvenli CLI Çalışma Kipi (`src/rol-cozucu.cjs`):**
   - `privacyLevel`: `'any'` | `'no_training'` (`:free` eğitim uçlarını reddeder) | `'trusted_self_hosted'` (yalnız yerel veya kendi VPS sunucun) | `'strict_local'` (yalnız bu makinedeki yerel model).
   - `executionMode`: `'safe_text'` (varsayılan salt-okunur/araçsız metin kipi — muhasebe/analiz projelerinde dosya değiştirmez!) vs `'workspace_agent'` (kod yazma kipi).
6. **Sızıntı Önleyici Güvenlik Kilidi (`src/guvenlik.cjs`):** Ortam değişkenlerindeki, `.env` dosyalarındaki, YAML ayarlarındaki ve iç içe JSON OAuth kimliklerindeki hiçbir gizli değerin rapora sızmasına izin vermez.

## Hızlı Kullanım

```bash
# Canlı keşif raporunu (yerel + WSL2 + GitHub CLI + VPS) görmek için:
node src/cli-kesif.cjs --ssh vps

# Otomatik düşmanca/kırıcı ve canlı test paketini çalıştırmak için:
npm test
```
