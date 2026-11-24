'use strict';

/**
 * `model-kapisi` — Evrensel Maymuncuk Ana Giriş Noktası (`index.cjs` v1.2.0)
 */

const { createRegistry, validateProviderSpec, DEFAULT_CATALOG_PATH } = require('./kayit-defteri.cjs');
const {
  discoverEnvironment,
  inspectLocalRouterProfiles,
  inferCapabilitiesFromModelId,
  hasValidUnexpiredTokenState,
  locateLocalBinary,
  probeHttpEndpoint,
  detectLocalSandboxes,
  probeRemoteSshHost,
} = require('./kesif.cjs');
const {
  resolveRole,
  resolveAllRoles,
  modelCapabilities,
  satisfiesCapabilities,
  satisfiesPrivacy,
} = require('./rol-cozucu.cjs');
const { scrubSecrets, hasNonEmptyEnv, assertNoLeakedSecretValues } = require('./guvenlik.cjs');
const { parseDotEnvText, loadMergedEnv, inspectEnvKeyPool } = require('./ortam-okuyucu.cjs');
const { createHealthMemory, DEFAULT_COOLDOWN_BY_REASON } = require('./saglik-hafizasi.cjs');

function createModelKapisi(options = {}) {
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : 30000;
  const registry = createRegistry({
    customCatalogPath: options.customCatalogPath,
    customCatalog: options.customCatalog,
  });
  const health = createHealthMemory({ nowFn: options.nowFn });

  let lastDiscovery = null;
  let lastStandardDiscovery = null;
  let lastStandardDiscoveryAt = 0;
  let lastCacheKey = '';

  async function discover(discoverOpts = {}) {
    const mergedOpts = {
      ...options.discoveryDefaults,
      ...discoverOpts,
    };
    const isCustomProbe = Boolean(
      discoverOpts.env ||
      discoverOpts.homeDir ||
      discoverOpts.projectDir ||
      discoverOpts.locateBinary ||
      discoverOpts.probeRemoteFn
    );
    const cacheKey = JSON.stringify({
      sshTargets: mergedOpts.sshTargets || [],
      probeLocalServices: mergedOpts.probeLocalServices !== false,
      probeSandboxes: mergedOpts.probeSandboxes !== false,
      inspectLocalProfiles: mergedOpts.inspectLocalProfiles !== false,
      probeCliBridges: mergedOpts.probeCliBridges !== false,
    });

    const forceRefresh = Boolean(discoverOpts.forceRefresh);
    if (
      !forceRefresh &&
      !isCustomProbe &&
      lastStandardDiscovery &&
      cacheKey === lastCacheKey &&
      (Date.now() - lastStandardDiscoveryAt) < cacheTtlMs
    ) {
      lastDiscovery = lastStandardDiscovery;
      return lastStandardDiscovery;
    }

    const report = await discoverEnvironment(registry, mergedOpts);
    lastDiscovery = report;
    if (!isCustomProbe) {
      lastStandardDiscovery = report;
      lastStandardDiscoveryAt = Date.now();
      lastCacheKey = cacheKey;
    }
    return report;
  }

  async function resolve(roleId, policy = {}) {
    const report = lastDiscovery || await discover();
    return resolveRole(report, registry, roleId, policy, health);
  }

  async function roleMatrix(policy = {}) {
    const report = lastDiscovery || await discover();
    return resolveAllRoles(report, registry, policy, health);
  }

  return {
    registry,
    health,
    discover,
    resolve,
    roleMatrix,
    reportFailure: (providerId, opts) => health.recordFailure(providerId, opts),
    reportSuccess: (providerId, opts) => health.recordSuccess(providerId, opts),
    invalidateCache: () => { lastDiscovery = null; lastStandardDiscovery = null; lastStandardDiscoveryAt = 0; },
    getLastDiscovery: () => lastDiscovery,
  };
}

module.exports = {
  createModelKapisi,
  createRegistry,
  validateProviderSpec,
  discoverEnvironment,
  inspectLocalRouterProfiles,
  inferCapabilitiesFromModelId,
  hasValidUnexpiredTokenState,
  resolveRole,
  resolveAllRoles,
  modelCapabilities,
  satisfiesCapabilities,
  satisfiesPrivacy,
  scrubSecrets,
  hasNonEmptyEnv,
  assertNoLeakedSecretValues,
  parseDotEnvText,
  loadMergedEnv,
  inspectEnvKeyPool,
  createHealthMemory,
  DEFAULT_COOLDOWN_BY_REASON,
  locateLocalBinary,
  probeHttpEndpoint,
  detectLocalSandboxes,
  probeRemoteSshHost,
  DEFAULT_CATALOG_PATH,
};
