'use strict';

/**
 * Yetenek Rolü Çözücü (`rol-cozucu.cjs` — Evrensel Maymuncuk v3)
 *
 * Desteklediği Akıllı Seçim Kriterleri:
 * 1. Yetenek ve Duyu Filtresi (`requiredCapabilities`: `vision`, `json_schema`, `tools`, `reasoning`, `embedding`, `audio`, `code_agent`)
 * 2. Bağlam Penceresi Filtresi (`requiredContextTokens` — ör. 500.000 tokenlık iş 128K modeli otomatik eler)
 * 3. Devre Kesici / Soğuma Hafızası (`healthMemory` — `429` veya `$0` bakiye nedeniyle soğumada olan kapıları atlar!)
 * 4. Veri Gizliliği ve Mahremiyet Seviyesi (`privacyLevel`: `any` | `no_training` | `trusted_self_hosted` | `strict_local`)
 * 5. Çoklu Anahtar Havuzu Ödülü (`keyCount > 1` olan sağlayıcılar yoğun kullanımda ek puan alır)
 * 6. Güvenli CLI Çalışma Kipi Seçimi (`executionMode`: `safe_text` salt-okunur vs `workspace_agent`)
 */

const { inferCapabilitiesFromModelId } = require('./kesif.cjs');

function modelCapabilities(provider, modelId) {
  if (provider.kind === 'cli-agent') {
    return Array.isArray(provider.capabilities) ? provider.capabilities : ['text', 'code_agent'];
  }
  const found = (provider.models || []).find(m => m.id === modelId);
  if (found && Array.isArray(found.capabilities)) {
    return found.capabilities;
  }
  return inferCapabilitiesFromModelId(modelId);
}

function modelTrainsOnData(provider, modelId) {
  if (provider.privacyTier === 'private_local' || provider.privacyTier === 'zero_training_enterprise') {
    return false;
  }
  const found = (provider.models || []).find(m => m.id === modelId);
  if (found && typeof found.trainsOnData === 'boolean') {
    return found.trainsOnData;
  }
  return String(modelId || '').endsWith(':free');
}

function effectiveContextWindow(provider, chosenModelId) {
  if (provider.kind === 'cli-agent') {
    return provider.contextWindow || 128000;
  }
  const found = (provider.models || []).find(m => m.id === chosenModelId);
  if (found && Number.isFinite(found.contextWindow)) {
    return found.contextWindow;
  }
  return 128000;
}

function satisfiesCapabilities(capsList, requiredCaps = []) {
  if (!requiredCaps.length) return true;
  const set = new Set(capsList || []);
  return requiredCaps.every(req => set.has(req));
}

function satisfiesPrivacy(provider, modelId, privacyLevel = 'any') {
  if (!privacyLevel || privacyLevel === 'any') return true;

  const isLocal = provider.location === 'local-service' || provider.location === 'local-cli' || provider.location === 'wsl2-cli';
  const isTrustedRemote = String(provider.location || '').startsWith('remote-ssh:');

  if (privacyLevel === 'strict_local') {
    // Yalnızca bu makinede (yerel donanımda) çalışan açık ağırlıklı servisler (`ollama`, `lmstudio`)
    return provider.privacyTier === 'private_local' && isLocal;
  }
  if (privacyLevel === 'trusted_self_hosted') {
    // Yalnızca yerel servisler veya kullanıcının kendi kişisel VPS sunucusu (`remote-ssh:*` / `router-gateway`)
    return provider.privacyTier === 'private_local' || provider.privacyTier === 'self_hosted_gateway' || isTrustedRemote;
  }
  if (privacyLevel === 'no_training') {
    // Veriyi model eğitiminde kullanan `:free` / açık eğitim uçlarını kesin olarak reddet!
    return !modelTrainsOnData(provider, modelId);
  }
  return true;
}

function pickBestModelForProvider(provider, roleId, minContextTokens, requiredCaps, privacyLevel) {
  if (provider.kind === 'cli-agent') {
    const caps = modelCapabilities(provider, null);
    if (!satisfiesCapabilities(caps, requiredCaps)) return null;
    if (!satisfiesPrivacy(provider, provider.id, privacyLevel)) return null;
    const bin = provider.localBinary?.authenticated
      ? provider.localBinary.name
      : (provider.wslBinary?.authenticated
        ? provider.wslBinary.binary
        : (provider.remoteBinaries?.find(r => r.authenticated)?.binary || provider.id));
    return `${bin}:varsayilan`;
  }

  const allModels = provider.models || [];
  const defaultId = provider.roleDefaults?.[roleId] || null;

  // Önce varsayılan model tüm şartları (pencere + yetenek + gizlilik) sağlıyor mu bak
  if (defaultId) {
    const defMeta = allModels.find(m => m.id === defaultId);
    const hasDiscoveredList = Boolean(provider.localService?.discoveredModels?.length);
    if (!hasDiscoveredList || defMeta) {
      const defCaps = defMeta?.capabilities || inferCapabilitiesFromModelId(defaultId);
      const defCtx = defMeta?.contextWindow || 128000;
      if (
        (!minContextTokens || defCtx >= minContextTokens) &&
        satisfiesCapabilities(defCaps, requiredCaps) &&
        satisfiesPrivacy(provider, defaultId, privacyLevel)
      ) {
        return defaultId;
      }
    }
  }

  // Varsayılan model uymuyorsa (ör. `no_training` istendi ve varsayılan `:free` idi, ya da `vision` istendi),
  // sağlayıcının diğer modelleri arasından tüm şartları sağlayan en uygun modeli seç!
  const eligible = allModels.filter(m => {
    const caps = m.capabilities || inferCapabilitiesFromModelId(m.id);
    const ctx = m.contextWindow || 128000;
    return (
      (!minContextTokens || ctx >= minContextTokens) &&
      satisfiesCapabilities(caps, requiredCaps) &&
      satisfiesPrivacy(provider, m.id, privacyLevel)
    );
  });

  if (eligible.length > 0) {
    const roleMatch = eligible.find(m => Array.isArray(m.roles) && m.roles.includes(roleId));
    return (roleMatch || eligible[0]).id;
  }

  // Hiçbir model tanımlı değilse (boş yönlendirici) ve özel yetenek/gizlilik engeli yoksa varsayılanı dön
  if (!allModels.length && defaultId && satisfiesCapabilities(inferCapabilitiesFromModelId(defaultId), requiredCaps)) {
    if (satisfiesPrivacy(provider, defaultId, privacyLevel)) return defaultId;
  }

  return null;
}

function candidateScore(provider, roleId, chosenModelId, minRequiredTokens, policy = {}, healthInfo = null) {
  const ctxWin = effectiveContextWindow(provider, chosenModelId);
  if (minRequiredTokens > 0 && ctxWin < minRequiredTokens) {
    return -1000;
  }

  let score = 50;

  if (Array.isArray(policy.preferredProviderIds)) {
    const idx = policy.preferredProviderIds.indexOf(provider.id);
    if (idx >= 0) score += 100 - idx * 10;
  }

  if (provider.kind === 'cli-agent') {
    if (Array.isArray(provider.roles) && provider.roles.includes(roleId)) {
      score += (provider.rolePriority || 80) - 50;
    } else {
      score -= 25;
    }
    if (provider.location === 'local-cli') score += 10;
    else if (provider.location === 'wsl2-cli') score += 6;
  } else {
    const hasExplicitRoleDefault = Boolean(provider.roleDefaults && provider.roleDefaults[roleId]);
    if (hasExplicitRoleDefault) score += 25;
    if (['local-service', 'env-key', 'local-router-profile', 'cli-token-bridge'].includes(provider.location)) {
      score += 10;
    }
  }

  // Çoklu anahtar rotasyon havuzu ödülü (kota aşımına dayanıklılık)
  if ((provider.keyCount || 0) > 1) {
    score += Math.min(12, (provider.keyCount - 1) * 4);
  }

  // Hız geçmişi ödülü (daha önce hızlı yanıt vermiş kapıyı öne çek)
  if (healthInfo?.avgLatencyMs && healthInfo.avgLatencyMs < 1500) {
    score += 6;
  }

  if (roleId === 'uzun-baglam' && ctxWin >= 200000) {
    score += 22;
  }

  const chosenMeta = (provider.models || []).find(m => m.id === chosenModelId);
  const isZeroCostModel = Boolean(
    chosenMeta && chosenMeta.inputUsdPer1M === 0 && chosenMeta.outputUsdPer1M === 0
  ) || String(chosenModelId || '').endsWith(':free');

  if (policy.preferFreeOrLocal) {
    if (provider.billingMode === 'free_local' || isZeroCostModel) score += 45;
    else if (provider.billingMode === 'metered_or_free_tier') score += 25;
    else if (provider.billingMode === 'subscription_or_key' || provider.billingMode === 'subscription_or_free_tier') score += 20;
  } else if (policy.preferSubscription !== false) {
    if (roleId === 'hizli-ucuz' && (provider.billingMode === 'free_local' || isZeroCostModel || provider.billingMode === 'metered_or_free_tier')) {
      score += 24;
    }
    if ((roleId === 'derin-mimari' || roleId === 'kod-sokucu') && provider.kind === 'cli-agent') {
      score += 18;
    }
  }

  return score;
}

function resolveRole(discoveryReport, registry, roleId, policy = {}, healthMemory = null) {
  const roleMeta = registry.getRole(roleId);
  if (!roleMeta) {
    throw new Error(`Tanınmayan yetenek rolü: "${roleId}". Geçerli roller: ${registry.listRoles().map(r => r.id).join(', ')}`);
  }

  const excludedSet = new Set(Array.isArray(policy.excludeProviderIds) ? policy.excludeProviderIds : []);
  const allowedLocations = Array.isArray(policy.allowedLocations) ? policy.allowedLocations : null;
  const privacyLevel = policy.privacyLevel || (policy.localOnly ? 'trusted_self_hosted' : 'any');
  const executionMode = policy.executionMode === 'workspace_agent' ? 'workspace_agent' : 'safe_text';

  const requiredCaps = [
    ...new Set([
      ...(roleMeta.requiredCapabilities || []),
      ...(Array.isArray(policy.requiredCapabilities) ? policy.requiredCapabilities : []),
    ]),
  ];

  const minRequiredTokens = Math.max(
    Number(policy.requiredContextTokens) || 0,
    Number(roleMeta.minContextWindow) || 0
  );

  const readyProviders = (discoveryReport?.providers || []).filter(p => {
    if (!p.ready) return false;
    if (excludedSet.has(p.id)) return false;
    if (policy.localOnly && String(p.location || '').startsWith('remote-ssh:')) return false;
    if (allowedLocations && !allowedLocations.some(loc => p.location === loc || String(p.location).startsWith(loc))) return false;
    return true;
  });

  if (!readyProviders.length) {
    return {
      roleId,
      resolved: false,
      primary: null,
      fallbacks: [],
      skippedCooldown: [],
      reason: 'Şu an hazır hiçbir yapay zekâ API anahtarı, yerel model sunucusu veya oturumu açık CLI ajanı bulunamadı. Statik analiz moduyla devam edilebilir.',
    };
  }

  const skippedCooldown = [];
  const ranked = [];

  for (const p of readyProviders) {
    const model = pickBestModelForProvider(p, roleId, minRequiredTokens, requiredCaps, privacyLevel);
    if (!model) continue;

    const health = healthMemory ? healthMemory.getHealth(p.id, model) : { healthy: true, inCooldown: false };
    if (health.inCooldown && !policy.ignoreCooldown) {
      skippedCooldown.push({
        providerId: p.id,
        model,
        reason: health.reason,
        remainingMs: health.remainingMs,
      });
      continue;
    }

    const contextWindow = effectiveContextWindow(p, model);
    const capabilities = modelCapabilities(p, model);
    const score = candidateScore(p, roleId, model, Number(policy.requiredContextTokens) || 0, policy, health);
    if (score <= -500) continue;

    ranked.push({
      providerId: p.id,
      providerTitle: p.title,
      kind: p.kind,
      driver: p.driver,
      location: p.location,
      model,
      capabilities,
      contextWindow,
      keyCount: p.keyCount || 1,
      privacyTier: p.privacyTier,
      executionMode: p.kind === 'cli-agent' ? executionMode : null,
      cliArgsTemplate: p.kind === 'cli-agent' ? (p.executionModes?.[executionMode] || []) : null,
      billingMode: p.billingMode,
      payerLabel: p.payerLabel,
      score,
    });
  }

  ranked.sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    const cooldownNote = skippedCooldown.length
      ? ` (${skippedCooldown.length} kapı geçici kota/hata soğumasında: ${skippedCooldown.map(s => s.providerId).join(', ')})`
      : '';
    return {
      roleId,
      resolved: false,
      primary: null,
      fallbacks: [],
      skippedCooldown,
      reason: `Hazır kapılar var ancak hiçbiri istenen şartları (yetenekler: [${requiredCaps.join(', ')}], bağlam: ${minRequiredTokens} token, gizlilik: ${privacyLevel}) karşılamıyor${cooldownNote}.`,
    };
  }

  return {
    roleId,
    resolved: true,
    requiredCapabilities: requiredCaps,
    privacyLevel,
    primary: ranked[0],
    fallbacks: ranked.slice(1, 5),
    skippedCooldown,
    reason: `"${roleId}" rolü için "${ranked[0].providerTitle}" (${ranked[0].model}, ${Math.round(ranked[0].contextWindow / 1000)}K bağlam) seçildi; ${Math.max(0, ranked.length - 1)} yedek kapı hazır.`,
  };
}

function resolveAllRoles(discoveryReport, registry, policy = {}, healthMemory = null) {
  const map = {};
  for (const role of registry.listRoles()) {
    map[role.id] = resolveRole(discoveryReport, registry, role.id, policy, healthMemory);
  }
  return map;
}

module.exports = {
  resolveRole,
  resolveAllRoles,
  modelCapabilities,
  satisfiesCapabilities,
  satisfiesPrivacy,
};
