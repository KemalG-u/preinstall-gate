'use strict';

/**
 * Güvenlik, Gizli Veri Maskeleme ve Atomik Dosya Yazıcı (`guvenlik.cjs`)
 *
 * Kurallar:
 * 1. Pano ekranına, JSON defterine, Markdown belgelerine veya tarihçeye ASLA API anahtarı,
 *    parola veya OAuth belirteci sızamaz.
 * 2. İki süreç veya yapay zekâ aynı anda yazarken dosya yarım kalmasın (bozulmasın) diye
 *    tüm yazımlar önce `.tmp` dosyasına yazılıp atomik `renameSync` ile yerine konur,
 *    bir önceki sağlam kopya `.yedek.json` olarak saklanır!
 * 3. Dosya kanıtları kontrol edilirken proje kökü dışına çıkan üst dizin yolları
 *    (`path traversal`) reddedilir.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
    out = out.replace(rx, '[GIZLI_DEGER_KORUNDU]');
  }
  return out;
}

function scrubDeepObject(value) {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubDeepObject);
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      clean[k] = scrubDeepObject(v);
    }
    return clean;
  }
  return value;
}

function assertNoSecretsInString(text) {
  if (typeof text !== 'string') return true;
  for (const rx of SECRET_PATTERNS) {
    rx.lastIndex = 0;
    if (rx.test(text)) {
      throw new Error('Güvenlik kalkanı: Hafıza defterine gizli bir API anahtarı veya token yazılmaya çalışıldı, engellendi!');
    }
  }
  return true;
}

function atomicWriteText(targetPath, content, { keepBackup = false } = {}) {
  assertNoSecretsInString(content);
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);

  if (keepBackup) {
    try {
      fs.copyFileSync(targetPath, `${targetPath}.yedek`);
    } catch { /* ignore backup error */ }
  }
}

function resolveInsideProject(projectRoot, relOrAbsPath) {
  if (typeof relOrAbsPath !== 'string' || !relOrAbsPath.trim()) return null;
  const rootResolved = path.resolve(projectRoot);
  const candidate = path.resolve(rootResolved, relOrAbsPath.trim());
  const rel = path.relative(rootResolved, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { allowed: false, fullPath: candidate, relativePath: relOrAbsPath };
  }
  return {
    allowed: true,
    fullPath: candidate,
    relativePath: rel.split(path.sep).join('/'),
  };
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  scrubSecrets,
  scrubDeepObject,
  assertNoSecretsInString,
  atomicWriteText,
  resolveInsideProject,
  escapeHtml,
};
