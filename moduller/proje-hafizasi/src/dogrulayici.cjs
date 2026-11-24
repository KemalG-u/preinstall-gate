'use strict';

/**
 * Kanıt ve Dürüstlük Denetçisi (`dogrulayici.cjs`)
 *
 * En Büyük Kör Noktayı Çözer: "Belgede Bitti Yazıyor Ama Dosya Yok / Bozulmuş!"
 *
 * Kurallar:
 * 1. Bir maddeye `tamamlandi` (Tamamlandı) denebilmesi için en az bir somut dosya kanıtı (`files`)
 *    veya doğrulama komutu/sonucu (`verifyCommand` / `evidenceSummary`) ZORUNLUDUR!
 * 2. Denetçi her okuma/yenilemede diskteki dosyaları gerçek zamanlı kontrol eder:
 *    - Dosya silindiyse, içi boşaldıysa (`0 byte`) veya proje kökü dışına kaçmaya çalışıyorsa
 *      madde otomatik olarak `kanit_bozuldu` (🔴 DİKKAT: Kanıt Eksik/Bozuk!) olarak işaretlenir!
 * 3. Hiçbir yapay zekâ boş vaatle bir maddeyi yeşile boyayamaz.
 */

const fs = require('node:fs');
const { resolveInsideProject } = require('./guvenlik.cjs');

const VALID_STATUSES = new Set([
  'bekliyor',       // 🔵 Sırada Bekliyor
  'devam_ediyor',   // 🟡 Şu An Üzerinde Çalışılıyor
  'tamamlandi',     // 🟢 Tamamlandı ve Kanıtlandı
  'engelli',        // 🟠 Engel / Karar Bekliyor
]);

const VALID_IDEA_STATUSES = new Set([
  'park_edildi',    // 💡 Fikir Havuzunda (Sırayı bozmamak için park edildi)
  'planlandi',      // 📌 İlgili maddeye bağlandı, sırası gelince yapılacak
  'uygulandi',      // ✅ Hayata geçirildi
  'vazgecildi',     // 🗄️ Vazgeçildi (nedeniyle birlikte saklanır)
]);

const SAFE_ITEM_ID = /^M\d+(?:\.\d+)*$/i;
const SAFE_IDEA_ID = /^F-\d{2,4}$/i;
const SAFE_DECISION_ID = /^K-\d{2,4}$/i;

function normalizeItemId(id) {
  const clean = String(id || '').trim().toUpperCase();
  if (!SAFE_ITEM_ID.test(clean)) {
    throw new Error(`Geçersiz madde numarası: "${id}". Örnek doğru biçimler: M1, M1.1, M2.3.1`);
  }
  return clean;
}

function compareItemIds(a, b) {
  const pa = String(a).replace(/^M/i, '').split('.').map(Number);
  const pb = String(b).replace(/^M/i, '').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? -1;
    const vb = pb[i] ?? -1;
    if (va !== vb) return va - vb;
  }
  return 0;
}

function auditSingleItem(item, projectRoot) {
  const issues = [];
  const fileChecks = [];
  const files = Array.isArray(item.files) ? item.files : [];

  for (const f of files) {
    const resolved = resolveInsideProject(projectRoot, f);
    if (!resolved || !resolved.allowed) {
      fileChecks.push({ path: f, exists: false, size: 0, error: 'Proje kökü dışı geçersiz yol' });
      issues.push(`Geçersiz dosya yolu (proje dışı): ${f}`);
      continue;
    }
    try {
      const st = fs.statSync(resolved.fullPath);
      if (st.isDirectory()) {
        const entries = fs.readdirSync(resolved.fullPath);
        const ok = entries.length > 0;
        fileChecks.push({ path: resolved.relativePath, exists: ok, isDir: true, count: entries.length });
        if (!ok) issues.push(`Klasör boş: ${resolved.relativePath}`);
      } else if (st.isFile()) {
        const ok = st.size > 0;
        fileChecks.push({ path: resolved.relativePath, exists: ok, isDir: false, size: st.size });
        if (!ok) issues.push(`Dosya 0 bayt (içi boş): ${resolved.relativePath}`);
      }
    } catch {
      fileChecks.push({ path: resolved.relativePath, exists: false, size: 0 });
      issues.push(`Kanıt dosyası diskte bulunamadı: ${resolved.relativePath}`);
    }
  }

  if (!String(item.whatItDoes || '').trim()) {
    issues.push('Sade Türkçe "Bu nedir / ne işe yarar?" açıklaması eksik.');
  }
  if (!String(item.whyWeDidIt || '').trim()) {
    issues.push('"Neden yapıyoruz / hangi sorunu çözüyor?" açıklaması eksik.');
  }

  if (item.status === 'tamamlandi') {
    if (files.length === 0) {
      issues.push('Tamamlandı işaretli maddede en az 1 gerçek dosya/klasör kanıtı zorunludur!');
    }
    if (!String(item.evidenceSummary || '').trim() && !String(item.verifyCommand || '').trim()) {
      issues.push('Tamamlandı işaretli maddede doğrulama komutu veya test kanıt özeti zorunludur!');
    }
  }

  const evidenceBroken = item.status === 'tamamlandi' && issues.length > 0;
  const effectiveStatus = evidenceBroken ? 'kanit_bozuldu' : item.status;

  return {
    id: item.id,
    declaredStatus: item.status,
    effectiveStatus,
    healthy: issues.length === 0,
    evidenceBroken,
    fileChecks,
    issues,
  };
}

function auditAllItems(ledger, projectRoot) {
  const items = Array.isArray(ledger?.items) ? ledger.items : [];
  const itemAudits = {};
  const brokenIds = [];
  const activeIds = [];
  let completedHealthyCount = 0;

  for (const item of items) {
    const res = auditSingleItem(item, projectRoot);
    itemAudits[item.id] = res;
    if (res.evidenceBroken) brokenIds.push(item.id);
    if (res.effectiveStatus === 'tamamlandi') completedHealthyCount++;
    if (res.effectiveStatus === 'devam_ediyor') activeIds.push(item.id);
  }

  const warningAlerts = [];
  if (brokenIds.length > 0) {
    warningAlerts.push(`DİKKAT: Tamamlandı görünen ${brokenIds.length} maddenin kanıt dosyası eksik veya bozulmuş (${brokenIds.join(', ')})!`);
  }
  if (activeIds.length > 2) {
    warningAlerts.push(`SIRA DİSİPLİNİ UYARISI: Aynı anda ${activeIds.length} madde "devam_ediyor" görünüyor (${activeIds.join(', ')}). Odak dağılmaması için önce eldeki madde bitirilmeli!`);
  }

  return {
    checkedAt: new Date().toISOString(),
    totalItems: items.length,
    completedHealthyCount,
    brokenCount: brokenIds.length,
    brokenIds,
    activeIds,
    allHealthy: brokenIds.length === 0,
    warningAlerts,
    byItemId: itemAudits,
  };
}

module.exports = {
  VALID_STATUSES,
  VALID_IDEA_STATUSES,
  SAFE_ITEM_ID,
  SAFE_IDEA_ID,
  SAFE_DECISION_ID,
  normalizeItemId,
  compareItemIds,
  auditSingleItem,
  auditAllItems,
};
