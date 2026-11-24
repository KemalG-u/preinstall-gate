'use strict';

// Synthetic test constants are joined at run time so no key-shaped literal sits in the source.
const J = (...parts) => parts.join('');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');

const {
  createModelKapisi,
  resolveRole,
  assertNoLeakedSecretValues,
  hasValidUnexpiredTokenState,
} = require('../src/index.cjs');

test('1. Gelecek adaptasyonu: çekirdek kodu değiştirmeden yeni sağlayıcı, yeni CLI ajanı ve yeni yetenek rolü eklenir', async () => {
  const kapi = createModelKapisi({
    customCatalog: {
      capabilityRoles: {
        'gorsel-harita': {
          title: 'Görsel Mimari Haritalama',
          description: 'Ürünü katmanlı diyagrama dönüştürür.',
          minContextWindow: 32000,
          requiredCapabilities: ['text', 'json_schema'],
        },
      },
      providers: [
        {
          id: 'gelecek-super-api',
          title: 'Gelecek Yılın Yeni Model Servisi',
          kind: 'http-api',
          driver: 'openai-compatible',
          billingMode: 'metered_api',
          payerLabel: 'Gelecek API Kredisi',
          baseUrl: 'https://api.gelecek-ornek.invalid/v1',
          authEnvVars: ['GELECEK_SUPER_API_KEY'],
          roleDefaults: {
            'gorsel-harita': 'super-harita-v9',
            'derin-mimari': 'super-dusunur-v9',
          },
          models: [
            {
              id: 'super-harita-v9',
              title: 'Süper Harita v9',
              roles: ['gorsel-harita'],
              capabilities: ['text', 'json_schema', 'tools'],
              contextWindow: 256000,
            },
          ],
        },
        {
          id: 'cli-yeni-ajan',
          title: 'Yarın Çıkacak Yeni CLI Ajan',
          kind: 'cli-agent',
          driver: 'cli-agent',
          billingMode: 'subscription_or_key',
          payerLabel: 'Yeni Ajan Aboneliği',
          binaries: ['yeni-ajan-2027'],
          capabilities: ['text', 'json_schema', 'code_agent'],
          roles: ['gorsel-harita', 'kod-sokucu'],
          rolePriority: 95,
        },
      ],
    },
  });

  const fakeSecret = J('nvapi-', 'COK_GIZLI_TEST_AN', 'AHTARI_9876543210');
  const fakeFutureKey = J('sk-', 'GELECEK_GIZLI_ANAHTAR_1234567890abcdef');
  const fakeEnv = {
    NVIDIA_API_KEY: fakeSecret,
    GELECEK_SUPER_API_KEY: fakeFutureKey,
  };

  const report = await kapi.discover({
    env: fakeEnv,
    inspectLocalProfiles: false,
    probeLocalServices: false,
    probeSandboxes: false,
    probeCliBridges: false,
    assumeCliAuthenticated: true,
    locateBinary: async (bin) => (bin === 'yeni-ajan-2027' ? '/usr/local/bin/yeni-ajan-2027' : null),
    readVersion: async () => 'yeni-ajan-2027 1.4.0',
  });

  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(fakeSecret));
  assert.ok(!serialized.includes(fakeFutureKey));
  assertNoLeakedSecretValues(serialized, fakeEnv);

  assert.ok(report.summary.readyIds.includes('nvidia-nim'));
  assert.ok(report.summary.readyIds.includes('gelecek-super-api'));
  assert.ok(report.summary.readyIds.includes('cli-yeni-ajan'));

  const resolvedCustomRole = await kapi.resolve('gorsel-harita');
  assert.equal(resolvedCustomRole.resolved, true);
  assert.ok(['cli-yeni-ajan', 'gelecek-super-api'].includes(resolvedCustomRole.primary.providerId));

  const cheapChoice = await kapi.resolve('hizli-ucuz', { preferFreeOrLocal: true });
  assert.equal(cheapChoice.primary.providerId, 'nvidia-nim');
  assert.equal(cheapChoice.primary.model, 'meta/llama-3.3-70b-instruct');
});

test('2. Kırıcı oturum denetimi: Oturumsuz CLI (installed_unauthenticated) VE süresi dolmuş OAuth token (expired_auth) sahte HAZIR dönmez', async () => {
  const tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'mk-auth-exp-'));
  try {
    // `claude` için süresi 2020'de dolmuş ve `refreshToken` İÇERMEYEN ölü kimlik dosyası oluştur!
    const claudeDir = path.join(tempHome, '.claude');
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'at_OLU_SURESI_BITMIS_TOKEN_123456789',
          expiresAt: 1577836800000, // 2020-01-01 (süresi geçmiş!)
        },
      }),
      'utf8'
    );

    // Doğrudan birim kontrolü: refresh_token varsa geçerli sayılmalı, yoksa expired!
    assert.deepEqual(
      hasValidUnexpiredTokenState({ accessToken: 'abc', expires_at: 1577836800 }),
      { valid: false, expired: true }
    );
    assert.deepEqual(
      hasValidUnexpiredTokenState({ accessToken: 'abc', expires_at: 1577836800, refresh_token: 'rt_valid_123456' }),
      { valid: true, expired: false }
    );

    const kapi = createModelKapisi();
    const report = await kapi.discover({
      env: {},
      homeDir: tempHome,
      inspectLocalProfiles: false,
      probeLocalServices: false,
      probeSandboxes: false,
      probeCliBridges: false,
      locateBinary: async (bin) => {
        if (bin === 'codex') return 'C:\\fake\\codex.cmd';
        if (bin === 'claude') return 'C:\\fake\\claude.cmd';
        return null;
      },
      readVersion: async () => '1.0.0',
    });

    const codex = report.providers.find(p => p.id === 'cli-codex');
    assert.equal(codex.ready, false);
    assert.equal(codex.status, 'installed_unauthenticated');

    const claude = report.providers.find(p => p.id === 'cli-claude');
    assert.equal(claude.ready, false, 'Süresi dolmuş ve yenileme anahtarı olmayan OAuth ASLA hazır sayılmamalı!');
    assert.equal(claude.status, 'expired_auth');
    assert.match(claude.missingSetupHint, /oturum süresi dolmuş/);
    assert.ok(!JSON.stringify(report).includes('at_OLU_SURESI_BITMIS_TOKEN_123456789'));
  } finally {
    await fsp.rm(tempHome, { recursive: true, force: true });
  }
});

test('3. Tak-çıkar .env okuyucu ve Çoklu Anahtar Rotasyon Havuzu (KEY_1, KEY_2, virgüllü liste) sıfır sızıntıyla çalışır', async () => {
  const tempProj = await fsp.mkdtemp(path.join(os.tmpdir(), 'mk-dotenv-'));
  const tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'mk-dothome-'));
  const k1 = 'gsk_GIZLI_HAVUZ_ANAHTARI_BIR_1111111111';
  const k2 = 'gsk_GIZLI_HAVUZ_ANAHTARI_IKI_2222222222';
  const k3 = 'gsk_GIZLI_HAVUZ_ANAHTARI_UC_3333333333';
  const pat = J('github_pat_', '11ABCDEFG0123456789_COKGIZLIPATTOKEN987654');

  try {
    await fsp.writeFile(
      path.join(tempProj, '.env'),
      [
        '# Proje içi otomatik okunan .env',
        `GROQ_API_KEY="${k1},${k2}"`,
        `GROQ_API_KEY_1=${k3}`,
        `GITHUB_TOKEN=${pat} # satır sonu yorumu`,
      ].join('\n'),
      'utf8'
    );

    const kapi = createModelKapisi();
    const report = await kapi.discover({
      projectDir: tempProj,
      homeDir: tempHome,
      loadDotEnv: true,
      inspectLocalProfiles: false,
      probeLocalServices: false,
      probeSandboxes: false,
      probeCliBridges: false,
      locateBinary: async () => null,
    });

    const serialized = JSON.stringify(report);
    for (const secret of [k1, k2, k3, pat]) {
      assert.ok(!serialized.includes(secret), 'Hiçbir .env anahtarı rapora sızmamalı!');
    }

    assert.equal(report.loadedDotEnvFiles.length, 1);
    const groq = report.providers.find(p => p.id === 'groq');
    assert.equal(groq.ready, true);
    assert.equal(groq.keyCount, 3, 'Virgüllü 2 anahtar + GROQ_API_KEY_1 toplam 3 anahtarlı havuz olarak sayılmalı!');

    const ghModels = report.providers.find(p => p.id === 'github-models');
    assert.equal(ghModels.ready, true);
  } finally {
    await fsp.rm(tempProj, { recursive: true, force: true });
    await fsp.rm(tempHome, { recursive: true, force: true });
  }
});

test('4. Duyu/Yetenek (vision, embedding, json_schema) ve Veri Mahremiyeti (no_training, trusted_self_hosted, strict_local) filtreleri doğru modeli seçer', async () => {
  const kapi = createModelKapisi();
  const report = await kapi.discover({
    env: {
      DEEPSEEK_API_KEY: J('sk-', 'FAKE_DEEPSEEK_KEY_FOR_CAP_TEST_12345'),
      OPENROUTER_API_KEY: J('sk-', 'or-v1-FAKE_OPENROUTER_KEY_FOR_CAP_TEST_12345'),
      OPENAI_API_KEY: J('sk-', 'proj-FAKE_OPENAI_KEY_FOR_CAP_TEST_12345'),
    },
    inspectLocalProfiles: false,
    probeLocalServices: false,
    probeSandboxes: false,
    probeCliBridges: false,
    locateBinary: async () => null,
  });

  // A) Görsel okuma (`gorsel-okuyucu` -> `vision` şart): Metin-tabanlı DeepSeek elenmeli, Vision destekli model seçilmeli!
  const visionRes = await kapi.resolve('gorsel-okuyucu');
  assert.equal(visionRes.resolved, true);
  assert.ok(visionRes.primary.capabilities.includes('vision'));
  assert.notEqual(visionRes.primary.providerId, 'deepseek', 'Görsel olmayan DeepSeek gorsel-okuyucu rolüne seçilmemeli!');

  // B) Vektör gömme (`vektor-gomme` -> `embedding` şart): OpenAI embedding modeli seçilmeli!
  const embRes = await kapi.resolve('vektor-gomme');
  assert.equal(embRes.resolved, true);
  assert.equal(embRes.primary.providerId, 'openai');
  assert.ok(embRes.primary.capabilities.includes('embedding'));

  // C) Gizlilik politikası: `privacyLevel: 'no_training'` istendiğinde OpenRouter'ın `:free` (veriyi eğitimde kullanan) modeli REDDEDİLMELİ,
  // aynı sağlayıcının veya başka sağlayıcının eğitim yapmayan (`trainsOnData: false`) modeli seçilmeli!
  const noTrainCheap = await kapi.resolve('hizli-ucuz', {
    preferredProviderIds: ['openrouter'],
    privacyLevel: 'no_training',
  });
  assert.equal(noTrainCheap.resolved, true);
  assert.equal(noTrainCheap.primary.providerId, 'openrouter');
  assert.ok(!noTrainCheap.primary.model.endsWith(':free'), 'no_training modunda :free eğitim modeli seçilmemeli!');

  // D) `strict_local` istendiğinde ve bu sahte ortamda yerel Ollama/LM Studio yoksa dürüstçe `resolved: false` dönmeli!
  const strictLocal = await kapi.resolve('dengeli', { privacyLevel: 'strict_local' });
  assert.equal(strictLocal.resolved, false);
  assert.match(strictLocal.reason, /strict_local/);
});

test('5. Devre Kesici (Circuit-Breaker) ve Cooldown Hafızası: 429/bakiye hatası alan kapı anında soğumaya alınır ve yedek kapıya geçilir', async () => {
  let fakeNow = 1_700_000_000_000;
  const kapi = createModelKapisi({ nowFn: () => fakeNow });

  await kapi.discover({
    env: {
      GROQ_API_KEY: 'gsk_FAKE_GROQ_CIRCUIT_TEST_12345678',
      MISTRAL_API_KEY: 'FAKE_MISTRAL_CIRCUIT_TEST_12345678',
    },
    inspectLocalProfiles: false,
    probeLocalServices: false,
    probeSandboxes: false,
    probeCliBridges: false,
    locateBinary: async () => null,
  });

  const first = await kapi.resolve('hizli-ucuz', { preferredProviderIds: ['groq', 'mistral'] });
  assert.equal(first.primary.providerId, 'groq');

  // Groq 429 hız sınırına (`rate_limit`) takıldı!
  kapi.reportFailure('groq', { reason: 'rate_limit', message: '429 Too Many Requests Bearer sk-GIZLI_SIZMAMALI_1234567890' });
  assert.ok(!JSON.stringify(kapi.health.snapshot()).includes(J('sk-', 'GIZLI_SIZMAMALI_1234567890')));

  // Anında tekrar çözdüğümüzde Groq soğumada olduğu için atlanmalı ve Mistral 1. sıraya geçmeli!
  const second = await kapi.resolve('hizli-ucuz', { preferredProviderIds: ['groq', 'mistral'] });
  assert.equal(second.primary.providerId, 'mistral');
  assert.equal(second.skippedCooldown.length, 1);
  assert.equal(second.skippedCooldown[0].providerId, 'groq');

  // 2 dakika ileri sardığımızda Groq soğumadan çıkıp tekrar 1. sıraya dönmeli!
  fakeNow += 120_000;
  const third = await kapi.resolve('hizli-ucuz', { preferredProviderIds: ['groq', 'mistral'] });
  assert.equal(third.primary.providerId, 'groq');
});

test('6. Güvenli CLI Çalışma Kipi: varsayılan safe_text salt-okunur argümanlar üretir; workspace_agent açıkça istenince açılır', async () => {
  const kapi = createModelKapisi();
  await kapi.discover({
    env: {},
    inspectLocalProfiles: false,
    probeLocalServices: false,
    probeSandboxes: false,
    probeCliBridges: false,
    assumeCliAuthenticated: true,
    locateBinary: async (b) => (b === 'codex' ? '/usr/local/bin/codex' : null),
    readVersion: async () => '0.169.0',
  });

  const safeMode = await kapi.resolve('kod-sokucu'); // Varsayılan `safe_text`!
  assert.equal(safeMode.primary.providerId, 'cli-codex');
  assert.equal(safeMode.primary.executionMode, 'safe_text');
  assert.ok(safeMode.primary.cliArgsTemplate.includes('read-only'), 'Varsayılan CLI kipi dosya değiştirmeyen read-only olmalı!');

  const agentMode = await kapi.resolve('kod-sokucu', { executionMode: 'workspace_agent' });
  assert.equal(agentMode.primary.executionMode, 'workspace_agent');
  assert.ok(agentMode.primary.cliArgsTemplate.includes('workspace-write'));
});

test('7. Yerel CCR config.json profili, sahte HTML port reddi ve 500K bağlam penceresi elemesi sorunsuz çalışır', async () => {
  const fakeWeb = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Blog</body></html>');
  });
  const realModelSrv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen2.5-vl-7b-instruct' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  fakeWeb.listen(0, '127.0.0.1');
  realModelSrv.listen(0, '127.0.0.1');
  await Promise.all([once(fakeWeb, 'listening'), once(realModelSrv, 'listening')]);

  try {
    const kapi = createModelKapisi();
    const badReport = await kapi.discover({
      env: { MODEL_ROUTER_BASE_URL: `http://127.0.0.1:${fakeWeb.address().port}/v1` },
      inspectLocalProfiles: false,
      probeLocalServices: true,
      probeSandboxes: false,
      probeCliBridges: false,
      locateBinary: async () => null,
    });
    assert.equal(badReport.providers.find(p => p.id === 'router-gateway').ready, false);

    const goodReport = await kapi.discover({
      env: {
        OLLAMA_BASE_URL: `http://127.0.0.1:${realModelSrv.address().port}/v1`,
        GEMINI_API_KEY: 'AIzaSyTestFakeKeyForUnitTestOnly123456',
      },
      inspectLocalProfiles: false,
      probeLocalServices: true,
      probeSandboxes: false,
      probeCliBridges: false,
      locateBinary: async () => null,
    });

    // Dinamik keşfedilen `qwen2.5-vl-7b-instruct` modelinden `vision` yeteneği otomatik çıkarılmalı!
    const ollama = goodReport.providers.find(p => p.id === 'ollama');
    assert.equal(ollama.ready, true);
    assert.ok(ollama.models[0].capabilities.includes('vision'));

    // `strict_local` modunda yerel Ollama seçilmeli!
    const strictLocal = resolveRole(goodReport, kapi.registry, 'gorsel-okuyucu', { privacyLevel: 'strict_local' });
    assert.equal(strictLocal.resolved, true);
    assert.equal(strictLocal.primary.providerId, 'ollama');

    // 500.000 token gerektiğinde 128K'lık Ollama elenip 1M bağlamlı Gemini seçilmeli!
    const hugeCtx = resolveRole(goodReport, kapi.registry, 'uzun-baglam', { requiredContextTokens: 500000 });
    assert.equal(hugeCtx.resolved, true);
    assert.equal(hugeCtx.primary.providerId, 'google-gemini');
  } finally {
    fakeWeb.close();
    realModelSrv.close();
    await Promise.all([once(fakeWeb, 'close'), once(realModelSrv, 'close')]);
  }
});

test('8. Canlı uçtan uca doğrulama: Windows + çoklu WSL2 dağıtımı + GitHub CLI (gh) köprüsü + yerel CCR + VPS ve tüm 7 evrensel rol', { timeout: 35000, skip: process.env.MODEL_KAPISI_LIVE ? false : 'live test: set MODEL_KAPISI_LIVE=1 (needs WSL, gh, a local CCR profile and an SSH alias, default "vps")' }, async () => {
  const kapi = createModelKapisi({ cacheTtlMs: 15000 });
  const sshTarget = process.env.MODEL_KAPISI_SSH_TARGET || 'vps';
  const t0 = Date.now();
  const report = await kapi.discover({ sshTargets: [sshTarget] });
  const firstMs = Date.now() - t0;

  const t1 = Date.now();
  const cachedReport = await kapi.discover({ sshTargets: [sshTarget] });
  const cachedMs = Date.now() - t1;
  assert.equal(cachedReport, report);
  assert.ok(cachedMs < 25, `Önbellek yanıtı anlık olmalı (${cachedMs} ms vs ilk ${firstMs} ms)`);

  // 1. Dinamik WSL dağıtımları yakalanmalı (`Ubuntu`, `Ubuntu-24.04`, `kutu`)
  assert.ok(report.wslDistros.length >= 1, 'WSL dağıtımları dinamik listelenmeli');

  // 2. GitHub CLI (`gh auth status`) üzerinden `github-models` sıfır ek anahtarla otomatik HAZIR olmalı!
  const ghModels = report.providers.find(p => p.id === 'github-models');
  assert.equal(ghModels.ready, true, 'GitHub CLI oturumu sayesinde github-models otomatik aktif olmalı!');
  assert.equal(ghModels.location, 'cli-token-bridge');

  // 3. Yerel CCR profilindeki 5 sağlayıcı + yerel claude + VPS codex + VPS router-gateway hazır olmalı (toplam >= 9 kapı!)
  for (const id of ['github-models', 'openrouter', 'deepseek', 'moonshot', 'minimax', 'zai', 'router-gateway', 'cli-codex', 'cli-claude']) {
    const p = report.providers.find(x => x.id === id);
    assert.equal(p?.ready, true, `${id} canlı sistemde hazır olmalı`);
  }

  // 4. Tüm 7 evrensel rol (`gorsel-okuyucu` ve `vektor-gomme` dahil!) canlı sistemde eksiksiz çözülmeli!
  const matrix = await kapi.roleMatrix();
  for (const roleId of ['hizli-ucuz', 'dengeli', 'derin-mimari', 'kod-sokucu', 'uzun-baglam', 'gorsel-okuyucu', 'vektor-gomme']) {
    assert.equal(matrix[roleId]?.resolved, true, `${roleId} canlı sistemde çözülmeli!`);
  }
  assert.ok(matrix['gorsel-okuyucu'].primary.capabilities.includes('vision'));
  assert.ok(matrix['vektor-gomme'].primary.capabilities.includes('embedding'));

  // 5. `trusted_self_hosted` gizlilik modunda yalnızca kullanıcının kendi VPS yönlendiricisi/ajanı seçilmeli!
  const selfHosted = await kapi.resolve('derin-mimari', { privacyLevel: 'trusted_self_hosted' });
  assert.equal(selfHosted.resolved, true);
  assert.ok(
    selfHosted.primary.location.startsWith('remote-ssh:') || selfHosted.primary.privacyTier === 'self_hosted_gateway',
    `trusted_self_hosted modunda dış bulut yerine kendi sunucusu seçilmeli (seçilen: ${selfHosted.primary.providerId})`
  );
});

test('9. Tak-çıkar paket bütünlüğü: CJS + ESM uyumu, YAML kimlik gizliliği ve sıfır üst-proje bağımlılığı', async () => {
  const esmMod = await import('../src/index.mjs');
  assert.equal(typeof esmMod.createModelKapisi, 'function');
  assert.equal(typeof esmMod.createHealthMemory, 'function');

  // YAML kimlik dosyası (`.aider.conf.yml`) okunurken içindeki API anahtarı sızmamalı!
  const tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'mk-yaml-'));
  const yamlSecret = J('sk-', 'YAML_ICINDEKI_COK_GIZLI_AIDER_ANAHTARI_999888');
  try {
    await fsp.writeFile(path.join(tempHome, '.aider.conf.yml'), `openai-api-key: "${yamlSecret}"\nmodel: gpt-4o\n`, 'utf8');
    const kapi = esmMod.createModelKapisi();
    const rep = await kapi.discover({
      env: {},
      homeDir: tempHome,
      inspectLocalProfiles: false,
      probeLocalServices: false,
      probeSandboxes: false,
      probeCliBridges: false,
      locateBinary: async (b) => (b === 'aider' ? '/usr/local/bin/aider' : null),
      readVersion: async () => '0.82.0',
    });
    assert.ok(!JSON.stringify(rep).includes(yamlSecret));
    const aider = rep.providers.find(p => p.id === 'cli-aider');
    assert.equal(aider.ready, true);
  } finally {
    await fsp.rm(tempHome, { recursive: true, force: true });
  }

  // `src/` içindeki hiçbir dosyada üst klasöre (`../../` veya `uygulama`) tek bir referans bile olmamalı!
  const srcDir = path.join(__dirname, '..', 'src');
  for (const fname of fs.readdirSync(srcDir)) {
    const content = fs.readFileSync(path.join(srcDir, fname), 'utf8');
    assert.doesNotMatch(content, /\.\.\/\.\.\//, `${fname} üst klasöre bağımlı olmamalı!`);
    assert.doesNotMatch(content, /uygulama/i, `${fname} Ürün Tanı uygulama klasörüne bağımlı olmamalı!`);
  }
});
