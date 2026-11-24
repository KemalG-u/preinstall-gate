'use strict';

/**
 * Devre Kesici ve Sağlık / Soğuma Hafızası (`saglik-hafizasi.cjs`)
 *
 * Amaç:
 * Bir kapı kota sınırına (`429 rate_limit`), kredi bitmesine (`402 quota_exceeded`),
 * süresi dolmuş anahtara (`401 auth_failed`) veya sunucu çökmesine (`503 timeout`)
 * takıldığında modül inatla aynı bozuk kapıyı 1. sıraya koymaya devam etmez!
 * İlgili kapıyı nedenine uygun süreyle soğumaya (cooldown) alır ve `resolveRole`
 * bir sonraki milisaniyede otomatik olarak sağlıklı yedek kapıya geçer.
 */

const { scrubSecrets } = require('./guvenlik.cjs');

const DEFAULT_COOLDOWN_BY_REASON = {
  rate_limit: 60 * 1000,         // 1 dk soğuma (429 hız sınırı)
  quota_exhausted: 30 * 60 * 1000, // 30 dk soğuma (bakiye / günlük kota bitti)
  auth_failed: 60 * 60 * 1000,   // 60 dk soğuma (geçersiz/iptal edilmiş anahtar)
  timeout: 30 * 1000,            // 30 sn soğuma (geçici ağ gecikmesi)
  server_error: 45 * 1000,       // 45 sn soğuma (500/502/503)
};

function createHealthMemory(options = {}) {
  const nowFn = options.nowFn || (() => Date.now());
  const records = new Map(); // key (`providerId` veya `providerId:model`) -> { failures, reason, cooldownUntil, lastLatencyMs }

  function recordFailure(providerId, { model = null, reason = 'server_error', cooldownMs = null, message = '' } = {}) {
    const key = model ? `${providerId}:${model}` : providerId;
    const prev = records.get(key) || { failures: 0, successes: 0, avgLatencyMs: null };
    const failures = prev.failures + 1;
    const baseMs = cooldownMs ?? (DEFAULT_COOLDOWN_BY_REASON[reason] || 45000);
    // Üstel geri çekilme (exponential backoff, en fazla 2 saat)
    const effectiveCooldown = cooldownMs !== null
      ? cooldownMs
      : Math.min(2 * 60 * 60 * 1000, baseMs * Math.pow(2, Math.min(4, failures - 1)));

    const entry = {
      ...prev,
      providerId,
      model,
      failures,
      lastFailureReason: reason,
      lastFailureMessage: scrubSecrets(String(message || '')).slice(0, 160),
      cooldownUntil: nowFn() + effectiveCooldown,
      updatedAt: nowFn(),
    };
    records.set(key, entry);
    return entry;
  }

  function recordSuccess(providerId, { model = null, latencyMs = null } = {}) {
    for (const key of [providerId, model ? `${providerId}:${model}` : null].filter(Boolean)) {
      const prev = records.get(key) || { failures: 0, successes: 0, avgLatencyMs: null };
      const avgLatencyMs = Number.isFinite(latencyMs)
        ? (prev.avgLatencyMs === null ? latencyMs : Math.round(prev.avgLatencyMs * 0.7 + latencyMs * 0.3))
        : prev.avgLatencyMs;
      records.set(key, {
        providerId,
        model: key.includes(':') ? model : null,
        failures: 0,
        successes: (prev.successes || 0) + 1,
        avgLatencyMs,
        lastFailureReason: null,
        lastFailureMessage: null,
        cooldownUntil: 0,
        updatedAt: nowFn(),
      });
    }
  }

  function getHealth(providerId, model = null) {
    const now = nowFn();
    const provRec = records.get(providerId);
    const modRec = model ? records.get(`${providerId}:${model}`) : null;

    const activeCooldown = [provRec, modRec]
      .filter(r => r && r.cooldownUntil > now)
      .sort((a, b) => b.cooldownUntil - a.cooldownUntil)[0];

    if (activeCooldown) {
      return {
        healthy: false,
        inCooldown: true,
        remainingMs: activeCooldown.cooldownUntil - now,
        reason: activeCooldown.lastFailureReason,
        failures: activeCooldown.failures,
        avgLatencyMs: modRec?.avgLatencyMs ?? provRec?.avgLatencyMs ?? null,
      };
    }

    return {
      healthy: true,
      inCooldown: false,
      remainingMs: 0,
      reason: null,
      failures: 0,
      avgLatencyMs: modRec?.avgLatencyMs ?? provRec?.avgLatencyMs ?? null,
    };
  }

  function clearHealth(providerId = null) {
    if (!providerId) {
      records.clear();
      return;
    }
    for (const k of [...records.keys()]) {
      if (k === providerId || k.startsWith(`${providerId}:`)) records.delete(k);
    }
  }

  function snapshot() {
    const now = nowFn();
    const out = {};
    for (const [k, v] of records.entries()) {
      out[k] = {
        ...v,
        inCooldown: v.cooldownUntil > now,
        remainingMs: Math.max(0, v.cooldownUntil - now),
      };
    }
    return out;
  }

  return {
    recordFailure,
    recordSuccess,
    getHealth,
    clearHealth,
    snapshot,
  };
}

module.exports = {
  createHealthMemory,
  DEFAULT_COOLDOWN_BY_REASON,
};
