'use strict';

/**
 * Güvenlik ve Gizli Veri Arındırma Yardımcısı (`guvenlik.cjs`)
 *
 * Kural:
 * 1. Ortam değişkenlerindeki API anahtarları, OAuth belirteçleri veya yerel `.json`
 *    yapılandırma dosyalarındaki (`config.json`, `.credentials.json` vb.) parolalar
 *    HİÇBİR ZAMAN keşif raporuna, loga, hataya veya ekrana yazılmaz.
 * 2. Anahtar adını unutsak bile yüksek entropili gizli diziler ve tüm şüpheli env/config
 *    değerleri son güvenlik kapısında yakalanır.
 */

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{10,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{14,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bhf_[A-Za-z0-9]{16,}\b/g,
  /\bxai-[A-Za-z0-9_-]{10,}\b/g,
  /\bcsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/gi,
];

function scrubSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = text;
  for (const rx of SECRET_PATTERNS) {
    out = out.replace(rx, '[GIZLI_ANAHTAR_KORUNDU]');
  }
  return out;
}

function hasNonEmptyEnv(env, varNames = []) {
  const presentNames = [];
  for (const name of varNames) {
    if (typeof name !== 'string' || !name) continue;
    const raw = env[name];
    if (typeof raw === 'string' && raw.trim().length >= 6) {
      presentNames.push(name);
    }
  }
  return {
    configured: presentNames.length > 0,
    presentEnvNames: presentNames, // Yalnızca değişkenin ADI döner; DEĞERİ asla dönmez!
  };
}

function assertNoLeakedSecretValues(serializedReport, env = process.env, extraForbiddenValues = []) {
  if (typeof serializedReport !== 'string') return true;

  // 1. Bilinen anahtar kalıpları doğrudan metinde varsa yakala
  for (const rx of SECRET_PATTERNS) {
    rx.lastIndex = 0;
    if (rx.test(serializedReport)) {
      throw new Error('Güvenlik ihlali engellendi: Tanınan bir API anahtarı kalıbı rapora sızmaya çalıştı!');
    }
  }

  // 2. Ortam değişkenlerindeki gizli değerleri kontrol et
  for (const [key, val] of Object.entries(env || {})) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)) continue;
    if (/^(AUTH_TYPE|KEYRING|SSH_AUTH_SOCK)$/i.test(key)) continue;
    if (typeof val === 'string' && val.trim().length >= 8) {
      if (serializedReport.includes(val.trim())) {
        throw new Error(`Güvenlik ihlali engellendi: ${key} değişkeninin değeri rapora sızmaya çalıştı!`);
      }
    }
  }

  // 3. Yapılandırma dosyalarından okunan ek gizli değerleri (yalnız bellekteki referanslarıyla) kontrol et
  for (const secretVal of extraForbiddenValues) {
    if (typeof secretVal === 'string' && secretVal.trim().length >= 8) {
      if (serializedReport.includes(secretVal.trim())) {
        throw new Error('Güvenlik ihlali engellendi: Yerel yapılandırma dosyasındaki bir anahtar değeri rapora sızmaya çalıştı!');
      }
    }
  }

  return true;
}

module.exports = {
  scrubSecrets,
  hasNonEmptyEnv,
  assertNoLeakedSecretValues,
};
