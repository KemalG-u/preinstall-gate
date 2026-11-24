'use strict';

/**
 * Genişletilebilir Kayıt Defteri (`kayit-defteri.cjs`)
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CATALOG_PATH = path.join(__dirname, '..', 'katalog', 'saglayicilar.varsayilan.json');
const VALID_KINDS = new Set(['http-api', 'local-or-remote-service', 'cli-agent']);
const VALID_DRIVERS = new Set(['openai-compatible', 'anthropic-native', 'gemini-native', 'cli-agent', 'custom-driver']);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function validateProviderSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('Sağlayıcı profili geçerli bir nesne olmalıdır.');
  }
  if (typeof spec.id !== 'string' || !SAFE_ID.test(spec.id)) {
    throw new Error(`Geçersiz sağlayıcı kimliği: "${spec.id}". Küçük harf, rakam ve tire kullanın.`);
  }
  if (typeof spec.title !== 'string' || !spec.title.trim()) {
    throw new Error(`"${spec.id}" sağlayıcısı için başlık (title) zorunludur.`);
  }
  if (!VALID_KINDS.has(spec.kind)) {
    throw new Error(`"${spec.id}" için geçersiz tür (kind): "${spec.kind}".`);
  }
  if (!VALID_DRIVERS.has(spec.driver)) {
    throw new Error(`"${spec.id}" için geçersiz sürücü (driver): "${spec.driver}".`);
  }
  if (spec.kind === 'cli-agent') {
    if (!Array.isArray(spec.binaries) || !spec.binaries.length || spec.binaries.some(b => typeof b !== 'string' || !b.trim())) {
      throw new Error(`"${spec.id}" CLI ajanı için en az bir ikili komut adı (binaries) gereklidir.`);
    }
  } else if (typeof spec.baseUrl !== 'string' || !/^https?:\/\//i.test(spec.baseUrl)) {
    throw new Error(`"${spec.id}" HTTP sağlayıcısı için geçerli bir baseUrl gereklidir.`);
  }
  return true;
}

function createRegistry(options = {}) {
  const rawDefault = JSON.parse(fs.readFileSync(DEFAULT_CATALOG_PATH, 'utf8'));
  const roles = new Map(Object.entries(rawDefault.capabilityRoles || {}));
  const providers = new Map();

  for (const p of rawDefault.providers || []) {
    validateProviderSpec(p);
    providers.set(p.id, structuredClone(p));
  }

  function mergeCatalogObject(customObj) {
    if (!customObj || typeof customObj !== 'object') return;
    if (customObj.capabilityRoles && typeof customObj.capabilityRoles === 'object') {
      for (const [roleId, roleMeta] of Object.entries(customObj.capabilityRoles)) {
        registerRole(roleId, roleMeta);
      }
    }
    if (Array.isArray(customObj.providers)) {
      for (const p of customObj.providers) {
        registerProvider(p);
      }
    }
  }

  function registerRole(roleId, meta) {
    if (typeof roleId !== 'string' || !SAFE_ID.test(roleId)) {
      throw new Error(`Geçersiz yetenek rolü kimliği: "${roleId}".`);
    }
    if (!meta || typeof meta.title !== 'string' || !meta.title.trim()) {
      throw new Error(`"${roleId}" rolü için title alanı zorunludur.`);
    }
    roles.set(roleId, {
      title: meta.title.trim(),
      description: String(meta.description || '').trim(),
      minContextWindow: Number.isFinite(meta.minContextWindow) ? meta.minContextWindow : 16000,
      requiredCapabilities: Array.isArray(meta.requiredCapabilities)
        ? meta.requiredCapabilities.map(String)
        : ['text'],
    });
  }

  function registerProvider(spec) {
    validateProviderSpec(spec);
    const existing = providers.get(spec.id);
    if (!existing) {
      providers.set(spec.id, structuredClone(spec));
      return providers.get(spec.id);
    }
    const mergedModels = [...(existing.models || [])];
    for (const m of spec.models || []) {
      const idx = mergedModels.findIndex(x => x.id === m.id);
      if (idx >= 0) mergedModels[idx] = { ...mergedModels[idx], ...structuredClone(m) };
      else mergedModels.push(structuredClone(m));
    }
    const updated = {
      ...existing,
      ...structuredClone(spec),
      roleDefaults: { ...(existing.roleDefaults || {}), ...(spec.roleDefaults || {}) },
      models: mergedModels,
    };
    providers.set(spec.id, updated);
    return updated;
  }

  if (options.customCatalogPath && fs.existsSync(options.customCatalogPath)) {
    const customRaw = JSON.parse(fs.readFileSync(options.customCatalogPath, 'utf8'));
    mergeCatalogObject(customRaw);
  }
  if (options.customCatalog && typeof options.customCatalog === 'object') {
    mergeCatalogObject(options.customCatalog);
  }

  return {
    catalogUpdatedAt: rawDefault.updatedAt,
    listRoles() {
      return [...roles.entries()].map(([id, meta]) => ({ id, ...structuredClone(meta) }));
    },
    getRole(roleId) {
      const r = roles.get(roleId);
      return r ? { id: roleId, ...structuredClone(r) } : null;
    },
    hasRole(roleId) {
      return roles.has(roleId);
    },
    listProviders() {
      return [...providers.values()].map(p => structuredClone(p));
    },
    getProvider(id) {
      const p = providers.get(id);
      return p ? structuredClone(p) : null;
    },
    registerProvider,
    registerRole,
    mergeCatalogObject,
  };
}

module.exports = {
  createRegistry,
  validateProviderSpec,
  DEFAULT_CATALOG_PATH,
};
