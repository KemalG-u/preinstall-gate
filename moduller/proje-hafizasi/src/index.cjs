'use strict';

/**
 * `proje-hafizasi` — Bağımsız Tak-Çıkar Proje Hafızası, Kanıtlı İş Takibi ve Devir-Teslim Modülü (`index.cjs` v1.0.0)
 */

const { createMemoryStore, createEmptyLedger, DEFAULT_DISCIPLINE_RULES } = require('./defter.cjs');
const {
  VALID_STATUSES,
  VALID_IDEA_STATUSES,
  normalizeItemId,
  compareItemIds,
  auditSingleItem,
  auditAllItems,
} = require('./dogrulayici.cjs');
const {
  renderMarkdownGuide,
  renderAiHandoverMarkdown,
  renderDashboardHtml,
  generateAllViews,
} = require('./sunum-uretici.cjs');
const { startLiveDashboardServer } = require('./canli-pano-sunucu.cjs');
const { scrubSecrets, scrubDeepObject, atomicWriteText, resolveInsideProject } = require('./guvenlik.cjs');

function createProjeHafizasi(options = {}) {
  const store = createMemoryStore(options);

  function syncViews(viewOpts = {}) {
    return generateAllViews(store, {
      writeRootHandoverFile: options.writeRootHandoverFile ?? viewOpts.writeRootHandoverFile ?? false,
    });
  }

  return {
    store,
    init(initOpts = {}) {
      const ledger = store.initProject(initOpts);
      const views = syncViews();
      return { ledger, views };
    },
    updateMeta(patch, metaOpts) {
      const ledger = store.updateProjectMeta(patch, metaOpts);
      const views = syncViews();
      return { ledger, views };
    },
    upsertItem(itemSpec, itemOpts) {
      const ledger = store.upsertItem(itemSpec, itemOpts);
      const views = syncViews();
      return { ledger, views };
    },
    addIdea(ideaSpec, ideaOpts) {
      const ledger = store.addIdea(ideaSpec, ideaOpts);
      const views = syncViews();
      return { ledger, views };
    },
    addDecision(decSpec, decOpts) {
      const ledger = store.addDecision(decSpec, decOpts);
      const views = syncViews();
      return { ledger, views };
    },
    audit: () => store.audit(),
    search: (q) => store.search(q),
    load: () => store.load(),
    history: (limit) => store.readRecentHistory(limit),
    syncViews,
    startDashboard: (srvOpts) => startLiveDashboardServer(store, srvOpts),
  };
}

module.exports = {
  createProjeHafizasi,
  createMemoryStore,
  createEmptyLedger,
  DEFAULT_DISCIPLINE_RULES,
  VALID_STATUSES,
  VALID_IDEA_STATUSES,
  normalizeItemId,
  compareItemIds,
  auditSingleItem,
  auditAllItems,
  renderMarkdownGuide,
  renderAiHandoverMarkdown,
  renderDashboardHtml,
  generateAllViews,
  startLiveDashboardServer,
  scrubSecrets,
  scrubDeepObject,
  atomicWriteText,
  resolveInsideProject,
};
