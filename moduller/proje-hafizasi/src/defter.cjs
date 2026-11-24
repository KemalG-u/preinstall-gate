'use strict';

/**
 * Çekirdek Hafıza Defteri ve Silinmez Tarihçe Motoru (`defter.cjs`)
 *
 * Sakladığı Yapılar (`<proje>/.proje-hafizasi/` altında veya özel dizinde):
 * 1. `hafiza-defteri.json` : Tek gerçek kaynak (Numaralı maddeler `M1`, `M1.1`, Kararlar `K-01`, Fikir Havuzu `F-01`, Çalışma Kuralları)
 * 2. `gecmis.jsonl`        : Silinmez (append-only) olay günlüğü — kim, ne zaman, hangi maddeyi neden değiştirdi!
 */

const fs = require('node:fs');
const path = require('node:path');
const { scrubDeepObject, atomicWriteText } = require('./guvenlik.cjs');
const {
  VALID_STATUSES,
  VALID_IDEA_STATUSES,
  normalizeItemId,
  compareItemIds,
  auditSingleItem,
  auditAllItems,
} = require('./dogrulayici.cjs');

const DEFAULT_DISCIPLINE_RULES = [
  'Elindeki numaralı maddeyi (ör. M1.2) kanıtıyla bitirmeden veya kullanıcı açıkça "bırak" demeden başka maddeye geçme.',
  'Bir maddeye "tamamlandi" diyebilmek için gerçek dosya yolu ve çalışan test/doğrulama kanıtı zorunludur; öneri veya planı bitmiş iş sayma.',
  'Kullanıcının aklına çalışma sırasında yeni bir fikir gelirse işi bölme; fikri Fikir Havuzuna (F-xx) ilgili madde numarasıyla park et ve eldeki işi bitir.',
  'Daha önce denenip vazgeçilen yolları ("Reddedilen Yollar / Dokunma Nedenleri") okumadan mimariyi değiştirme; aynı hatayı tekrarlama.',
  'Her maddenin "Ne işe yarar?" ve "Neden yaptık?" alanlarını teknik olmayan bir ürün sahibinin tek bakışta anlayacağı sade Türkçeyle yaz.',
  'Gizli API anahtarlarını, parolaları veya belirteçleri asla hafıza defterine, rapora veya terminale yazma.',
];

function createEmptyLedger({ projectName, projectVision, ownerName = 'Proje Sahibi' }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    project: {
      name: String(projectName || 'Adsız Proje').trim(),
      owner: String(ownerName || 'Proje Sahibi').trim(),
      visionPlainLanguage: String(projectVision || 'Projenin sade Türkçe hedefi henüz girilmedi.').trim(),
      currentFocusItemId: null,
      nextStepPlainLanguage: '',
      createdAt: now,
      updatedAt: now,
    },
    disciplineRules: [...DEFAULT_DISCIPLINE_RULES],
    items: [],      // M1, M1.1, M1.2...
    ideas: [],      // F-01, F-02... (Fikir Park Yeri)
    decisions: [],  // K-01, K-02... (Unutulmaması gereken kritik kararlar ve reddedilen yollar)
  };
}

function createMemoryStore(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const dataDir = path.resolve(options.dataDir || path.join(projectRoot, '.proje-hafizasi'));
  const ledgerPath = path.join(dataDir, 'hafiza-defteri.json');
  const historyPath = path.join(dataDir, 'gecmis.jsonl');

  function appendHistory(eventType, actor, summary, meta = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    const cleanEntry = scrubDeepObject({
      at: new Date().toISOString(),
      actor: String(actor || 'sistem').slice(0, 60),
      eventType,
      summary: String(summary || '').slice(0, 300),
      ...meta,
    });
    fs.appendFileSync(historyPath, `${JSON.stringify(cleanEntry)}\n`, 'utf8');
  }

  function load() {
    if (!fs.existsSync(ledgerPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(ledgerPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      // Ana dosya bozulduysa otomatik `.yedek` dosyasından kurtarmayı dene!
      const backupPath = `${ledgerPath}.yedek`;
      if (fs.existsSync(backupPath)) {
        const recovered = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        appendHistory('kurtarma', 'sistem', 'hafiza-defteri.json yedekten otomatik kurtarıldı.');
        return recovered;
      }
      throw new Error(`Hafıza defteri okunamadı: ${err.message}`);
    }
  }

  function save(ledger, { actor = 'ajan', summary = 'Hafıza güncellendi', eventType = 'guncelleme', meta = {} } = {}) {
    const cleanLedger = scrubDeepObject(ledger);
    cleanLedger.project.updatedAt = new Date().toISOString();
    cleanLedger.items.sort((a, b) => compareItemIds(a.id, b.id));
    atomicWriteText(ledgerPath, `${JSON.stringify(cleanLedger, null, 2)}\n`, { keepBackup: true });
    appendHistory(eventType, actor, summary, meta);
    return cleanLedger;
  }

  function initProject({ projectName, projectVision, ownerName = 'Proje sahibi', actor = 'kurulum', force = false } = {}) {
    const existing = load();
    if (existing && !force) {
      return existing;
    }
    const fresh = createEmptyLedger({ projectName, projectVision, ownerName });
    return save(fresh, {
      actor,
      eventType: 'kurulum',
      summary: `"${fresh.project.name}" için proje hafızası başlatıldı.`,
    });
  }

  function updateProjectMeta(patch = {}, { actor = 'ajan' } = {}) {
    const ledger = load();
    if (!ledger) throw new Error('Önce initProject ile hafıza defteri başlatılmalıdır.');
    if (typeof patch.name === 'string' && patch.name.trim()) ledger.project.name = patch.name.trim();
    if (typeof patch.owner === 'string' && patch.owner.trim()) ledger.project.owner = patch.owner.trim();
    if (typeof patch.visionPlainLanguage === 'string') ledger.project.visionPlainLanguage = patch.visionPlainLanguage.trim();
    if (patch.currentFocusItemId !== undefined) {
      ledger.project.currentFocusItemId = patch.currentFocusItemId ? normalizeItemId(patch.currentFocusItemId) : null;
    }
    if (typeof patch.nextStepPlainLanguage === 'string') {
      ledger.project.nextStepPlainLanguage = patch.nextStepPlainLanguage.trim();
    }
    if (Array.isArray(patch.disciplineRules) && patch.disciplineRules.length > 0) {
      ledger.disciplineRules = patch.disciplineRules.map(String);
    }
    return save(ledger, {
      actor,
      eventType: 'proje_ozeti',
      summary: 'Proje hedefi ve odak bilgisi güncellendi.',
    });
  }

  function upsertItem(itemSpec, { actor = 'ajan', strictEvidence = true } = {}) {
    const ledger = load();
    if (!ledger) throw new Error('Önce initProject ile hafıza defteri başlatılmalıdır.');

    const id = normalizeItemId(itemSpec.id);
    const parentParts = id.split('.');
    const inferredParentId = parentParts.length > 1 ? parentParts.slice(0, -1).join('.') : null;
    const idx = ledger.items.findIndex(x => x.id === id);
    const prev = idx >= 0 ? ledger.items[idx] : null;

    const status = itemSpec.status || prev?.status || 'bekliyor';
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`"${id}" için geçersiz durum: "${status}". Geçerli: ${[...VALID_STATUSES].join(', ')}`);
    }

    const merged = {
      id,
      parentId: itemSpec.parentId !== undefined ? itemSpec.parentId : (prev?.parentId ?? inferredParentId),
      title: String(itemSpec.title ?? prev?.title ?? '').trim(),
      status,
      moduleTag: String(itemSpec.moduleTag ?? prev?.moduleTag ?? 'genel').trim(),
      whatItDoes: String(itemSpec.whatItDoes ?? prev?.whatItDoes ?? '').trim(),
      whyWeDidIt: String(itemSpec.whyWeDidIt ?? prev?.whyWeDidIt ?? '').trim(),
      howItWorksSimple: String(itemSpec.howItWorksSimple ?? prev?.howItWorksSimple ?? '').trim(),
      rejectedAlternatives: Array.isArray(itemSpec.rejectedAlternatives)
        ? itemSpec.rejectedAlternatives.map(String)
        : (prev?.rejectedAlternatives || []),
      doNotTouchWarnings: Array.isArray(itemSpec.doNotTouchWarnings)
        ? itemSpec.doNotTouchWarnings.map(String)
        : (prev?.doNotTouchWarnings || []),
      files: Array.isArray(itemSpec.files)
        ? itemSpec.files.map(String)
        : (prev?.files || []),
      verifyCommand: String(itemSpec.verifyCommand ?? prev?.verifyCommand ?? '').trim(),
      evidenceSummary: String(itemSpec.evidenceSummary ?? prev?.evidenceSummary ?? '').trim(),
      updatedBy: actor,
      updatedAt: new Date().toISOString(),
    };

    if (!merged.title) {
      throw new Error(`"${id}" maddesi için başlık (title) zorunludur.`);
    }

    // Kırıcı Kanıt Kapısı: `strictEvidence: true` iken dosyası/kanıtı olmayan madde `tamamlandi` yapılamaz!
    if (strictEvidence && merged.status === 'tamamlandi') {
      const check = auditSingleItem(merged, projectRoot);
      if (!check.healthy) {
        throw new Error(
          `"${id}" maddesine kanıtsız TAMAMLANDI denemez! Eksikler: ${check.issues.join(' | ')}`
        );
      }
    }

    if (idx >= 0) ledger.items[idx] = merged;
    else ledger.items.push(merged);

    if (merged.status === 'devam_ediyor') {
      ledger.project.currentFocusItemId = merged.id;
    }

    return save(ledger, {
      actor,
      eventType: prev ? 'madde_guncellendi' : 'madde_eklendi',
      summary: `${id} (${merged.title}) -> ${merged.status}`,
      meta: { itemId: id, status: merged.status },
    });
  }

  function addIdea(ideaSpec, { actor = 'kullanici' } = {}) {
    const ledger = load();
    if (!ledger) throw new Error('Önce initProject ile hafıza defteri başlatılmalıdır.');

    const nextNum = ledger.ideas.length + 1;
    const id = ideaSpec.id ? String(ideaSpec.id).trim().toUpperCase() : `F-${String(nextNum).padStart(2, '0')}`;
    const relatedItemId = ideaSpec.relatedItemId ? normalizeItemId(ideaSpec.relatedItemId) : null;
    const status = ideaSpec.status || 'park_edildi';
    if (!VALID_IDEA_STATUSES.has(status)) {
      throw new Error(`Geçersiz fikir durumu: "${status}"`);
    }

    const entry = {
      id,
      title: String(ideaSpec.title || '').trim(),
      detailPlainLanguage: String(ideaSpec.detailPlainLanguage || '').trim(),
      whyValuable: String(ideaSpec.whyValuable || '').trim(),
      relatedItemId,
      whenToRevisit: String(ideaSpec.whenToRevisit || (relatedItemId ? `${relatedItemId} maddesine geçildiğinde` : 'İlgili faz başında')).trim(),
      status,
      createdAt: new Date().toISOString(),
      createdBy: actor,
    };

    if (!entry.title) throw new Error('Fikir başlığı (title) zorunludur.');

    const existingIdx = ledger.ideas.findIndex(x => x.id === id);
    if (existingIdx >= 0) ledger.ideas[existingIdx] = { ...ledger.ideas[existingIdx], ...entry };
    else ledger.ideas.push(entry);

    return save(ledger, {
      actor,
      eventType: 'fikir_park_edildi',
      summary: `Yeni fikir kaydedildi: ${id} (${entry.title})${relatedItemId ? ` -> ilgili madde: ${relatedItemId}` : ''}`,
      meta: { ideaId: id, relatedItemId },
    });
  }

  function addDecision(decisionSpec, { actor = 'ajan' } = {}) {
    const ledger = load();
    if (!ledger) throw new Error('Önce initProject ile hafıza defteri başlatılmalıdır.');

    const nextNum = ledger.decisions.length + 1;
    const id = decisionSpec.id ? String(decisionSpec.id).trim().toUpperCase() : `K-${String(nextNum).padStart(2, '0')}`;
    const relatedItemId = decisionSpec.relatedItemId ? normalizeItemId(decisionSpec.relatedItemId) : null;

    const entry = {
      id,
      title: String(decisionSpec.title || '').trim(),
      chosenApproach: String(decisionSpec.chosenApproach || '').trim(),
      whyPlainLanguage: String(decisionSpec.whyPlainLanguage || '').trim(),
      rejectedApproaches: Array.isArray(decisionSpec.rejectedApproaches) ? decisionSpec.rejectedApproaches.map(String) : [],
      consequenceIfViolated: String(decisionSpec.consequenceIfViolated || '').trim(),
      relatedItemId,
      decidedAt: new Date().toISOString(),
      decidedBy: actor,
    };

    if (!entry.title || !entry.chosenApproach) {
      throw new Error('Karar başlığı (title) ve seçilen yol (chosenApproach) zorunludur.');
    }

    const idx = ledger.decisions.findIndex(x => x.id === id);
    if (idx >= 0) ledger.decisions[idx] = { ...ledger.decisions[idx], ...entry };
    else ledger.decisions.push(entry);

    return save(ledger, {
      actor,
      eventType: 'mimari_karar',
      summary: `Karar kayda geçti: ${id} (${entry.title})`,
      meta: { decisionId: id, relatedItemId },
    });
  }

  function readRecentHistory(limit = 30) {
    if (!fs.existsSync(historyPath)) return [];
    const lines = fs.readFileSync(historyPath, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).reverse().map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  function search(query) {
    const ledger = load();
    if (!ledger) return { items: [], ideas: [], decisions: [] };
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { items: ledger.items, ideas: ledger.ideas, decisions: ledger.decisions };

    const matchObj = (obj) => JSON.stringify(obj).toLowerCase().includes(q);
    return {
      items: ledger.items.filter(matchObj),
      ideas: ledger.ideas.filter(matchObj),
      decisions: ledger.decisions.filter(matchObj),
    };
  }

  function audit() {
    const ledger = load();
    if (!ledger) throw new Error('Hafıza defteri henüz oluşturulmamış.');
    return auditAllItems(ledger, projectRoot);
  }

  return {
    projectRoot,
    dataDir,
    ledgerPath,
    historyPath,
    load,
    save,
    initProject,
    updateProjectMeta,
    upsertItem,
    addIdea,
    addDecision,
    readRecentHistory,
    search,
    audit,
  };
}

module.exports = {
  createMemoryStore,
  createEmptyLedger,
  DEFAULT_DISCIPLINE_RULES,
};
