'use strict';

/**
 * Sıfır Bağımlılıklı Güvenli `.env` ve Çoklu Anahtar Havuzu Okuyucu (`ortam-okuyucu.cjs`)
 *
 * Kurallar:
 * - Başka bir projeye takıldığında `dotenv` paketine ihtiyaç duymadan projenin `.env` / `.env.local`
 *   dosyalarını ve kullanıcı ana dizinindeki küresel `~/.model-kapisi/.env` dosyasını okur.
 * - `process.env` içindeki mevcut değerleri ASLA ezmez (sistem ortam değişkeni her zaman önceliklidir).
 * - Çoklu anahtar rotasyonunu (`OPENROUTER_API_KEY="key1,key2"` veya `OPENROUTER_API_KEY_1`, `_2`, `_3`)
 *   otomatik sayar ve HİÇBİR anahtar değerini dışarıya sızdırmadan yalnızca anahtar adedini (`keyCount`) bildirir!
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseDotEnvText(content) {
  const result = {};
  if (typeof content !== 'string') return result;
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      // Tırnaksız satır sonu yorumunu temizle (`KEY=abc # yorum`)
      const hashIdx = val.indexOf(' #');
      if (hashIdx >= 0) val = val.slice(0, hashIdx).trim();
    }
    if (val) result[key] = val;
  }
  return result;
}

function loadMergedEnv({ baseEnv = process.env, projectDir = process.cwd(), homeDir = os.homedir(), loadDotEnv = true } = {}) {
  const merged = { ...baseEnv };
  const loadedFiles = [];
  const collectedSecrets = [];

  if (loadDotEnv) {
    const candidates = [
      projectDir ? path.join(projectDir, '.env.local') : null,
      projectDir ? path.join(projectDir, '.env') : null,
      homeDir ? path.join(homeDir, '.model-kapisi', '.env') : null,
    ].filter(Boolean);

    for (const file of candidates) {
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > 256 * 1024) continue;
        const parsed = parseDotEnvText(fs.readFileSync(file, 'utf8'));
        let usedFromThisFile = false;
        for (const [k, v] of Object.entries(parsed)) {
          if (/(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(k) && v.length >= 8) {
            collectedSecrets.push(v);
          }
          if (merged[k] === undefined || merged[k] === '') {
            merged[k] = v;
            usedFromThisFile = true;
          }
        }
        if (usedFromThisFile) loadedFiles.push(file);
      } catch {
        // Dosya yoksa geç
      }
    }
  }

  return { env: merged, loadedDotEnvFiles: loadedFiles, dotEnvSecrets: collectedSecrets };
}

function inspectEnvKeyPool(env, varNames = [], forbiddenCollector = []) {
  const presentEnvNames = [];
  let totalKeys = 0;

  for (const baseName of varNames) {
    if (typeof baseName !== 'string' || !baseName) continue;

    // 1. Ana değişken (`API_KEY="k1,k2"` virgülle ayrılmış havuz destekli)
    const directVal = typeof env[baseName] === 'string' ? env[baseName].trim() : '';
    if (directVal.length >= 6 && !directVal.startsWith('$') && !directVal.includes('YOUR_')) {
      const parts = directVal.split(/[,;\s]+/).map(s => s.trim()).filter(s => s.length >= 6);
      if (parts.length > 0) {
        presentEnvNames.push(baseName);
        totalKeys += parts.length;
        for (const p of parts) if (p.length >= 8) forbiddenCollector.push(p);
      }
    }

    // 2. Numaralı anahtar havuzu (`API_KEY_1`, `API_KEY_2` ... `API_KEY_9`)
    for (let i = 1; i <= 9; i++) {
      const numberedName = `${baseName}_${i}`;
      const numVal = typeof env[numberedName] === 'string' ? env[numberedName].trim() : '';
      if (numVal.length >= 6 && !numVal.startsWith('$') && !numVal.includes('YOUR_')) {
        presentEnvNames.push(numberedName);
        totalKeys += 1;
        if (numVal.length >= 8) forbiddenCollector.push(numVal);
      }
    }
  }

  return {
    configured: totalKeys > 0,
    keyCount: totalKeys,
    presentEnvNames, // Yalnızca değişken İSİMLERİ döner, DEĞERLERİ asla dönmez!
  };
}

module.exports = {
  parseDotEnvText,
  loadMergedEnv,
  inspectEnvKeyPool,
};
