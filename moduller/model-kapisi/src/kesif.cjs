'use strict';

/**
 * Çoklu Ortam Canlı Keşif Motoru (`kesif.cjs` — Evrensel Maymuncuk v3)
 *
 * Sıfır Sabit İsim, Tam Dinamik ve Evrensel Keşif Özellikleri:
 * 1. Dinamik WSL Dağıtım Keşfi (`wsl -l -q`): `Ubuntu` sabit adına bağlı kalmaz; `Debian`,
 *    `Ubuntu-24.04`, `kali` vb. hangi Linux dağıtımı kuruluysa otomatik bulur.
 * 2. Sıfır Sabit Kodlu Uzak/WSL Kimlik Doğrulaması: Katalogdaki TÜM CLI ajanların `authFootprints`
 *    yollarını (`aider`, `goose`, `qwen`, `opencode`, `codex`, `claude`, `gemini` ve gelecekte
 *    eklenecek olanlar) dinamik olarak WSL ve VPS'e gönderip kontrol eder.
 * 3. Token Son Kullanma Tarihi (`expires_at` / `expiresAt`) Kontrolü: Süresi dolmuş ve
 *    `refresh_token` içermeyen ölü kimlik dosyalarını `expired_auth` olarak yakalar!
 * 4. Proje `.env` + Çoklu Anahtar Havuzu (`KEY_1`, `KEY_2`, virgüllü liste) Desteği.
 * 5. GitHub CLI (`gh auth status`) Köprüsü: Bilgisayarda `gh` oturumu açıksa `github-models`
 *    kapısını otomatik hazır hale getirir!
 * 6. Windows Standart Kurulum Yolları Taraması: `PATH` yenilenmemiş olsa bile `Ollama`,
 *    `LM Studio`, `GitHub CLI`, `Bun`, `Scoop`, `Cargo`, `uv` dizinlerindeki araçları bulur.
 * 7. Canlı Model Yetenek Çıkarımı (`inferCapabilitiesFromModelId`): Dinamik keşfedilen yerel/router
 *    modellerin `vision`, `reasoning`, `embedding`, `tools` yeteneklerini otomatik etiketler.
 */

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { scrubSecrets, assertNoLeakedSecretValues } = require('./guvenlik.cjs');
const { loadMergedEnv, inspectEnvKeyPool } = require('./ortam-okuyucu.cjs');

const execFileAsync = promisify(cp.execFile);
const SAFE_SSH_HOST = /^[A-Za-z0-9._@-]{1,120}$/;

function expandHome(p, homeDir = os.homedir()) {
  if (typeof p !== 'string') return '';
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(homeDir, p.slice(2));
  }
  return p;
}

function inferCapabilitiesFromModelId(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/embed|bge-|e5-|nomic-embed|text-embedding/i.test(id)) {
    return ['embedding'];
  }
  const caps = new Set(['text', 'streaming']);
  if (/vision|vl|pixtral|gpt-4o|gpt-4\.1|claude-3|claude-sonnet|claude-opus|claude-haiku|gemini-1\.5|gemini-2|kimi-k2\.5|grok-2-vision/i.test(id)) {
    caps.add('vision');
  }
  if (/r1|reasoner|think|o1|o3|o4|qwq|magistral|gemini-2\.5-pro|deepseek-v4-pro|m2\.7|kimi-k2\.5|claude-opus|claude-sonnet/i.test(id)) {
    caps.add('reasoning');
  }
  if (!/deepseek-r1$|deepseek-reasoner$/i.test(id)) {
    caps.add('tools');
    caps.add('json_schema');
  }
  return [...caps];
}

function collectDeepStringSecrets(node, outList, depth = 0) {
  if (!node || depth > 5) return;
  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (trimmed.length >= 14 && !trimmed.includes(' ') && !/^https?:\/\//i.test(trimmed)) {
      outList.push(trimmed);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 20)) collectDeepStringSecrets(item, outList, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/(token|key|secret|password|refresh|access|bearer|cookie|session)/i.test(k) && typeof v === 'string' && v.trim().length >= 8) {
        outList.push(v.trim());
      } else {
        collectDeepStringSecrets(v, outList, depth + 1);
      }
    }
  }
}

function hasValidUnexpiredTokenState(parsedObj, nowMs = Date.now()) {
  if (!parsedObj || typeof parsedObj !== 'object') return { valid: false, expired: false };

  // İç içe OAuth nesnelerini de kontrol et (ör. `claudeAiOauth`, `tokens`, kök düzey)
  const candidates = [parsedObj, ...Object.values(parsedObj).filter(v => v && typeof v === 'object' && !Array.isArray(v))];
  let sawExpiry = false;
  let allExpiredWithoutRefresh = true;

  for (const obj of candidates) {
    const hasRefresh = Boolean(
      (typeof obj.refreshToken === 'string' && obj.refreshToken.trim().length >= 6) ||
      (typeof obj.refresh_token === 'string' && obj.refresh_token.trim().length >= 6)
    );
    const rawExp = obj.expiresAt ?? obj.expires_at ?? obj.expiry_date ?? null;
    if (rawExp !== null && rawExp !== undefined) {
      let expMs = null;
      if (typeof rawExp === 'number') {
        // Saniye mi milisaniye mi? (1e11 altıysa saniye)
        expMs = rawExp < 1e11 ? rawExp * 1000 : rawExp;
      } else if (typeof rawExp === 'string') {
        const p = Date.parse(rawExp);
        if (!Number.isNaN(p)) expMs = p;
      }
      if (expMs !== null) {
        sawExpiry = true;
        if (expMs > nowMs || hasRefresh) {
          allExpiredWithoutRefresh = false;
        }
      }
    }
  }

  if (sawExpiry && allExpiredWithoutRefresh) {
    return { valid: false, expired: true };
  }
  return { valid: Object.keys(parsedObj).length > 0, expired: false };
}

function checkAuthFootprintsDetailed(authFootprints = [], homeDir = os.homedir(), forbiddenSecretsCollector = []) {
  const verifiedFiles = [];
  const expiredFiles = [];

  for (const fp of authFootprints) {
    const full = expandHome(fp, homeDir);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size < 8) continue;
      const content = fs.readFileSync(full, 'utf8');

      // YAML / düz yapılandırma dosyası (ör. `.aider.conf.yml`, `config.yaml`)
      if (/\.(ya?ml|conf|ini|toml)$/i.test(full)) {
        const nonCommentLines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        for (const line of nonCommentLines) {
          const parts = line.split(/[:=]/, 2);
          if (parts.length === 2 && /(key|token|secret)/i.test(parts[0]) && parts[1].trim().length >= 8) {
            forbiddenSecretsCollector.push(parts[1].trim().replace(/^['"]|['"]$/g, ''));
          }
        }
        if (nonCommentLines.length > 0) verifiedFiles.push(fp);
        continue;
      }

      const parsed = JSON.parse(content);
      collectDeepStringSecrets(parsed, forbiddenSecretsCollector);
      const tokenCheck = hasValidUnexpiredTokenState(parsed);
      if (tokenCheck.valid) {
        verifiedFiles.push(fp);
      } else if (tokenCheck.expired) {
        expiredFiles.push(fp);
      }
    } catch {
      // Dosya yok veya okunamadı
    }
  }

  return { verifiedFiles, expiredFiles };
}

function inspectLocalRouterProfiles(homeDir, forbiddenSecretsCollector) {
  const candidates = [
    { kind: 'ccr', file: path.join(homeDir, '.claude-code-router', 'config.json') },
    { kind: 'omniroute', file: path.join(homeDir, '.omniroute', 'config.json') },
  ];
  const result = {
    foundConfigFiles: [],
    hasRouterGatewayKey: false,
    routerPort: null,
    routerRoleMap: {},
    configuredProviders: new Map(),
  };

  for (const item of candidates) {
    if (!fs.existsSync(item.file)) continue;
    try {
      const raw = fs.readFileSync(item.file, 'utf8');
      const parsed = JSON.parse(raw);
      result.foundConfigFiles.push(item.file);

      if (typeof parsed.APIKEY === 'string' && parsed.APIKEY.trim().length >= 6) {
        result.hasRouterGatewayKey = true;
        forbiddenSecretsCollector.push(parsed.APIKEY.trim());
      }
      if (Number.isInteger(parsed.PORT)) {
        result.routerPort = parsed.PORT;
      }
      if (parsed.Router && typeof parsed.Router === 'object') {
        if (parsed.Router.background) result.routerRoleMap['hizli-ucuz'] = String(parsed.Router.background);
        if (parsed.Router.default) result.routerRoleMap.dengeli = String(parsed.Router.default);
        if (parsed.Router.think || parsed.Router.default) {
          result.routerRoleMap['derin-mimari'] = String(parsed.Router.think || parsed.Router.default);
          result.routerRoleMap['kod-sokucu'] = String(parsed.Router.default);
        }
        if (parsed.Router.longContext) result.routerRoleMap['uzun-baglam'] = String(parsed.Router.longContext);
      }

      const list = Array.isArray(parsed.Providers) ? parsed.Providers : [];
      for (const prov of list) {
        if (!prov || typeof prov.name !== 'string') continue;
        const keyVal = typeof prov.api_key === 'string' ? prov.api_key.trim() : '';
        const hasRealKey = keyVal.length >= 8 && !keyVal.startsWith('$') && !keyVal.includes('YOUR_');
        if (hasRealKey) {
          forbiddenSecretsCollector.push(keyVal);
          const alias = prov.name.trim().toLowerCase();
          result.configuredProviders.set(alias, {
            sourceLabel: `~/.claude-code-router/config.json (${prov.name})`,
            baseUrl: typeof prov.api_base_url === 'string' ? prov.api_base_url.replace(/\/chat\/completions\/?$/i, '') : null,
            models: Array.isArray(prov.models) ? prov.models.map(String) : [],
            keyCount: 1,
          });
        }
      }
    } catch {
      // Bozuk JSON varsa atla
    }
  }
  return result;
}

function standardWindowsFallbacks(binName, homeDir = os.homedir(), env = process.env) {
  if (process.platform !== 'win32') return [];
  const localApp = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const roamingApp = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const progFiles = env.ProgramFiles || 'C:\\Program Files';

  const dirs = [
    path.join(roamingApp, 'npm'),
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, 'scoop', 'shims'),
    path.join(homeDir, '.opencode', 'bin'),
    path.join(homeDir, '.lmstudio', 'bin'),
    path.join(localApp, 'Programs', 'Ollama'),
    path.join(progFiles, 'GitHub CLI'),
  ];
  const exts = ['.cmd', '.exe', '.bat'];
  const candidates = [];
  for (const d of dirs) {
    for (const ext of exts) {
      candidates.push(path.join(d, binName + ext));
    }
  }
  return candidates;
}

async function locateLocalBinary(binName, env = process.env, homeDir = os.homedir()) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(binName)) return null;
  const isWin = process.platform === 'win32';
  const locator = isWin ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(locator, [binName], {
      env,
      timeout: 3000,
      windowsHide: true,
    });
    const lines = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length) {
      return isWin ? (lines.find(l => /\.(cmd|exe|bat)$/i.test(l)) || lines[0]) : lines[0];
    }
  } catch {
    // PATH üzerinde bulunamadı; bilinen standart kurulum dizinlerine bak!
  }

  if (isWin) {
    for (const full of standardWindowsFallbacks(binName, homeDir, env)) {
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch { /* ignore */ }
    }
  } else {
    for (const dir of [path.join(homeDir, '.local', 'bin'), path.join(homeDir, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
      const full = path.join(dir, binName);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch { /* ignore */ }
    }
  }
  return null;
}

async function checkCliTokenBridge(bridgeSpec, customLocateBinary, env = process.env, forbiddenSecretsCollector = []) {
  if (!bridgeSpec || typeof bridgeSpec.binary !== 'string') return { ready: false };
  const binPath = await customLocateBinary(bridgeSpec.binary);
  if (!binPath) return { ready: false, binaryFound: false };

  const isWinCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binPath);
  const statusArgs = Array.isArray(bridgeSpec.statusArgs) ? bridgeSpec.statusArgs : ['auth', 'token'];
  try {
    const cmd = isWinCmd ? 'cmd.exe' : binPath;
    const args = isWinCmd ? ['/d', '/s', '/c', `"${binPath}" ${statusArgs.join(' ')}`] : statusArgs;
    const { stdout } = await execFileAsync(cmd, args, {
      env,
      timeout: 3500,
      windowsHide: true,
      windowsVerbatimArguments: isWinCmd,
    });
    const outTrimmed = String(stdout || '').trim();
    if (!outTrimmed) {
      return { ready: false, binaryFound: true, binaryPath: binPath };
    }
    // Belirteç döndüyse (ör. `gh auth token`), DEĞERİNİ ASLA KAYDETME; yalnız sızıntı kalkanına ekle!
    const firstLine = outTrimmed.split(/\r?\n/)[0].trim();
    if (firstLine.length >= 8 && !firstLine.includes(' ')) {
      forbiddenSecretsCollector.push(firstLine);
    }
    return {
      ready: true,
      binaryFound: true,
      binaryPath: binPath,
      sourceLabel: `${bridgeSpec.binary} CLI yerel oturumu`,
    };
  } catch {
    return { ready: false, binaryFound: true, binaryPath: binPath };
  }
}

async function readCliVersion(binPath, versionArgs = ['--version'], env = process.env) {
  if (!binPath) return null;
  const isWinCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binPath);
  try {
    const cmd = isWinCmd ? 'cmd.exe' : binPath;
    const args = isWinCmd ? ['/d', '/s', '/c', `"${binPath}" ${versionArgs.join(' ')}`] : versionArgs;
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      env,
      timeout: 4000,
      windowsHide: true,
      windowsVerbatimArguments: isWinCmd,
    });
    const first = scrubSecrets(String(stdout || stderr || '').trim().split(/\r?\n/)[0] || '');
    return first.slice(0, 120) || 'kurulu';
  } catch {
    return 'kurulu (sürüm okunamadı)';
  }
}

async function probeHttpEndpoint(url, { timeoutMs = 1800, fetchImpl = globalThis.fetch, allowAuthProtectedRouter = false } = {}) {
  if (typeof fetchImpl !== 'function') {
    return { reachable: false, httpStatus: null };
  }
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();

    if (res.status === 200) {
      let body = null;
      try { body = await res.json(); } catch { return { reachable: false, httpStatus: 200, reason: 'non-json-200' }; }
      const discoveredModels = Array.isArray(body?.data)
        ? body.data.map(m => m?.id).filter(Boolean).slice(0, 32)
        : (Array.isArray(body?.models) ? body.models.map(m => m?.name || m?.id).filter(Boolean).slice(0, 32) : null);
      if (!discoveredModels) {
        return { reachable: false, httpStatus: 200, reason: 'not-a-model-server' };
      }
      return {
        reachable: true,
        requiresAuth: false,
        httpStatus: 200,
        url,
        discoveredModels,
      };
    }

    if ((res.status === 401 || res.status === 403) && allowAuthProtectedRouter) {
      let looksLikeApiAuth = contentType.includes('application/json') || contentType.includes('text/plain');
      if (!looksLikeApiAuth) {
        const txt = (await res.text().catch(() => '')).slice(0, 200).toLowerCase();
        looksLikeApiAuth = txt.includes('unauthorized') || txt.includes('api') || txt.includes('key') || txt.includes('token');
      }
      if (looksLikeApiAuth) {
        return {
          reachable: true,
          requiresAuth: true,
          httpStatus: res.status,
          url,
          discoveredModels: [],
        };
      }
    }

    return { reachable: false, requiresAuth: false, httpStatus: res.status, url, discoveredModels: [] };
  } catch {
    return { reachable: false, requiresAuth: false, httpStatus: null, url, discoveredModels: [] };
  }
}

async function listWslDistros(wslBin, sysRoot, env) {
  try {
    const { stdout } = await execFileAsync(wslBin, ['-l', '-q'], {
      cwd: fs.existsSync(path.join(sysRoot, 'System32')) ? path.join(sysRoot, 'System32') : undefined,
      env: { SystemRoot: sysRoot, WINDIR: sysRoot, PATH: env.PATH || '' },
      encoding: 'buffer',
      timeout: 4500,
      windowsHide: true,
    });
    // `wsl -l -q` UTF-16LE döndürür; NUL baytlarını temizle
    const decoded = Buffer.isBuffer(stdout) ? stdout.toString('utf16le') : String(stdout || '');
    const distros = decoded
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !/^docker-desktop/i.test(s));
    return distros;
  } catch {
    return [];
  }
}

async function inspectWslEnvironment(cliProviders, env = process.env) {
  if (process.platform !== 'win32') return { available: false, distro: null, bwrapReady: false, binaries: {}, auth: {} };
  const sysRoot = env.SystemRoot || 'C:\\Windows';
  const wslCandidate = path.join(sysRoot, 'System32', 'wsl.exe');
  const wslBin = fs.existsSync(wslCandidate) ? wslCandidate : await locateLocalBinary('wsl', env);
  if (!wslBin) return { available: false, distro: null, bwrapReady: false, binaries: {}, auth: {} };

  const distros = await listWslDistros(wslBin, sysRoot, env);
  if (!distros.length) return { available: false, distro: null, bwrapReady: false, reason: 'Kurulu WSL Linux dağıtımı bulunamadı', binaries: {}, auth: {} };

  // Ubuntu varsa öncelik ver, yoksa kullanıcının ilk Linux dağıtımını seç (Debian, Arch, Kali vb. dinamik!)
  const preferredDistro = distros.find(d => /^ubuntu$/i.test(d)) || distros.find(d => /ubuntu|debian/i.test(d)) || distros[0];

  const cliBinNames = [...new Set(cliProviders.flatMap(p => p.binaries || []))];
  const dynamicAuthMap = {};
  for (const p of cliProviders) {
    dynamicAuthMap[p.id] = p.authFootprints || [];
  }

  const pyProbe = [
    'import json, os, shutil, sys, time',
    'def valid_auth_file(p):',
    '    p = os.path.expanduser(p)',
    '    if not os.path.isfile(p) or os.path.getsize(p) <= 8: return False',
    '    if p.lower().endswith((".yml", ".yaml", ".conf", ".ini", ".toml")):',
    '        try: return any(ln.strip() and not ln.strip().startswith("#") for ln in open(p, "r", encoding="utf-8").read().splitlines())',
    '        except Exception: return False',
    '    try:',
    '        d = json.load(open(p, "r", encoding="utf-8"))',
    '        if not isinstance(d, dict) or not d: return False',
    '        now_ms, saw_exp, all_exp = time.time() * 1000.0, False, True',
    '        for obj in [d] + [v for v in d.values() if isinstance(v, dict)]:',
    '            has_ref = bool(str(obj.get("refreshToken") or obj.get("refresh_token") or "").strip())',
    '            exp = obj.get("expiresAt", obj.get("expires_at", obj.get("expiry_date")))',
    '            if isinstance(exp, (int, float)):',
    '                saw_exp = True',
    '                if (exp * 1000.0 if exp < 1e11 else float(exp)) > now_ms or has_ref: all_exp = False',
    '        return not (saw_exp and all_exp)',
    '    except Exception: return False',
    'bins = ' + JSON.stringify(cliBinNames),
    'auth_specs = ' + JSON.stringify(dynamicAuthMap),
    'extra_paths = [os.path.expanduser("~/.local/bin"), os.path.expanduser("~/.npm-global/bin"), "/usr/local/bin", "/usr/bin", "/bin"]',
    'search_path = ":".join(extra_paths)',
    'found = {}',
    'for b in bins:',
    '    p = shutil.which(b, path=search_path)',
    '    if p: found[b] = p',
    'auth_res = {}',
    'for pid, fps in auth_specs.items():',
    '    auth_res[pid] = any(valid_auth_file(fp) for fp in fps)',
    'print(json.dumps({',
    '    "bwrap": os.access("/usr/bin/bwrap", os.X_OK),',
    '    "python": sys.version.split()[0],',
    '    "binaries": found,',
    '    "auth": auth_res,',
    '}))',
  ].join('\n');

  try {
    const { stdout } = await execFileAsync(
      wslBin,
      ['-d', preferredDistro, '--exec', 'python3', '-c', pyProbe],
      {
        cwd: fs.existsSync(path.join(sysRoot, 'System32')) ? path.join(sysRoot, 'System32') : undefined,
        env: { SystemRoot: sysRoot, WINDIR: sysRoot, PATH: env.PATH || '' },
        timeout: 12000,
        windowsHide: true,
      }
    );
    const clean = String(stdout || '').replace(/\0/g, '').trim();
    const parsed = JSON.parse(clean.split(/\r?\n/).at(-1));
    return {
      available: true,
      distro: preferredDistro,
      allDistros: distros,
      bwrapReady: Boolean(parsed.bwrap),
      pythonVersion: parsed.python,
      binaries: parsed.binaries || {},
      auth: parsed.auth || {},
    };
  } catch (err) {
    return {
      available: false,
      distro: preferredDistro,
      allDistros: distros,
      bwrapReady: false,
      reason: scrubSecrets(err.message || '').slice(0, 120),
      binaries: {},
      auth: {},
    };
  }
}

async function detectLocalSandboxes(env = process.env, wslInfo = null, reachableRemotes = []) {
  const sandboxes = [];
  const platform = process.platform;

  if (platform === 'win32') {
    const wsl = wslInfo || await inspectWslEnvironment([], env);
    sandboxes.push({
      id: 'wsl2-bwrap',
      title: `WSL2 (${wsl.distro || 'Linux'}) + Bubblewrap (Ağsız Kum Havuzu)`,
      ready: Boolean(wsl.bwrapReady),
      distro: wsl.distro || null,
      detail: wsl.bwrapReady
        ? `${wsl.distro}: /usr/bin/bwrap (Python ${wsl.pythonVersion})`
        : (wsl.reason || 'WSL/bwrap hazır değil'),
    });
  } else if (platform === 'linux') {
    const bwrap = await locateLocalBinary('bwrap', env);
    sandboxes.push({
      id: 'linux-bwrap',
      title: 'Linux Bubblewrap Kum Havuzu',
      ready: Boolean(bwrap),
      detail: bwrap || 'bwrap kurulu değil',
    });
  } else if (platform === 'darwin') {
    const sbExec = fs.existsSync('/usr/bin/sandbox-exec');
    sandboxes.push({
      id: 'macos-sandbox-exec',
      title: 'macOS Yerel Kum Havuzu',
      ready: sbExec,
      detail: sbExec ? '/usr/bin/sandbox-exec' : 'bulunamadı',
    });
  }

  const dockerBin = await locateLocalBinary('docker', env);
  if (dockerBin) {
    let daemonUp = false;
    try {
      await execFileAsync(dockerBin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 3500, windowsHide: true });
      daemonUp = true;
    } catch { /* daemon down */ }
    sandboxes.push({
      id: 'docker',
      title: 'Docker Konteyner Kum Havuzu',
      ready: daemonUp,
      detail: daemonUp ? `Docker aktif (${dockerBin})` : 'Docker kurulu ancak servis kapalı',
    });
  } else {
    sandboxes.push({
      id: 'docker',
      title: 'Docker Konteyner Kum Havuzu',
      ready: false,
      detail: 'Bu makinede Docker kurulu değil (isteğe bağlı)',
    });
  }

  for (const rem of reachableRemotes) {
    if (rem.sandboxes?.bwrap) {
      sandboxes.push({
        id: `remote-bwrap:${rem.host}`,
        title: `Uzak Sunucu (${rem.host}) Bubblewrap Kum Havuzu`,
        ready: true,
        detail: `${rem.host}: bwrap hazır`,
      });
    }
    if (rem.sandboxes?.docker) {
      sandboxes.push({
        id: `remote-docker:${rem.host}`,
        title: `Uzak Sunucu (${rem.host}) Docker Kum Havuzu`,
        ready: true,
        detail: `${rem.host}: docker hazır`,
      });
    }
  }

  return sandboxes;
}

async function probeRemoteSshHost(sshTarget, providers) {
  if (!sshTarget || !SAFE_SSH_HOST.test(sshTarget)) {
    return { host: String(sshTarget || ''), reachable: false, reason: 'Geçersiz SSH hedef adı.' };
  }

  const cliProviders = providers.filter(p => p.kind === 'cli-agent');
  const cliBins = [...new Set(
    cliProviders.flatMap(p => p.binaries || []).filter(b => /^[A-Za-z0-9._-]+$/.test(b))
  )];
  const dynamicAuthSpecs = {};
  for (const cpSpec of cliProviders) {
    dynamicAuthSpecs[cpSpec.id] = cpSpec.authFootprints || [];
  }

  const ports = [...new Set(
    providers
      .filter(p => p.kind === 'local-or-remote-service')
      .flatMap(p => p.remoteProbePorts || [])
      .filter(n => Number.isInteger(n) && n > 0 && n < 65536)
  )];

  // %100 dinamik uzak keşif: HİÇBİR araç adı sabit kodlanmamıştır!
  const remotePy = `
import json, os, shutil, time, urllib.request, urllib.error

def valid_auth_file(p):
    p = os.path.expanduser(p)
    if not os.path.isfile(p) or os.path.getsize(p) <= 8:
        return False
    if p.lower().endswith((".yml", ".yaml", ".conf", ".ini", ".toml")):
        try:
            lines = [ln.strip() for ln in open(p, "r", encoding="utf-8").read().splitlines() if ln.strip() and not ln.strip().startswith("#")]
            return len(lines) > 0
        except Exception:
            return False
    try:
        d = json.load(open(p, "r", encoding="utf-8"))
        if not isinstance(d, dict) or not d:
            return False
        now_ms = time.time() * 1000.0
        saw_exp = False
        all_exp = True
        for obj in [d] + [v for v in d.values() if isinstance(v, dict)]:
            has_ref = bool(str(obj.get("refreshToken") or obj.get("refresh_token") or "").strip())
            exp = obj.get("expiresAt", obj.get("expires_at", obj.get("expiry_date")))
            if isinstance(exp, (int, float)):
                saw_exp = True
                exp_ms = exp * 1000.0 if exp < 1e11 else float(exp)
                if exp_ms > now_ms or has_ref:
                    all_exp = False
        if saw_exp and all_exp:
            return False
        return True
    except Exception:
        return False

extra = [os.path.expanduser("~/.local/bin"), os.path.expanduser("~/.npm-global/bin"), "/usr/local/bin", "/usr/bin", "/bin"]
spath = ":".join(extra)
bins = {}
for b in ${JSON.stringify([...cliBins, 'docker', 'bwrap', 'gh'])}:
    p = shutil.which(b, path=spath)
    if p:
        bins[b] = p

auth_specs = ${JSON.stringify(dynamicAuthSpecs)}
auth = {}
for pid, fps in auth_specs.items():
    auth[pid] = any(valid_auth_file(fp) for fp in fps)

ccr_info = None
for cfg_rel in ["~/.claude-code-router/config.json", "~/.omniroute/config.json"]:
    ccr_path = os.path.expanduser(cfg_rel)
    if os.path.isfile(ccr_path):
        try:
            d = json.load(open(ccr_path, "r", encoding="utf-8"))
            r = d.get("Router") or {}
            provs = []
            for p in d.get("Providers") or []:
                k = str(p.get("api_key") or "").strip()
                if len(k) >= 8 and not k.startswith("$"):
                    provs.append({"name": str(p.get("name") or "").lower(), "models": [str(m) for m in (p.get("models") or [])]})
            ccr_info = {
                "port": d.get("PORT", 3456),
                "hasGatewayKey": bool(str(d.get("APIKEY") or "").strip()),
                "router": {str(rk): str(rv) for rk, rv in r.items() if isinstance(rv, str)},
                "providers": provs,
            }
            break
        except Exception:
            pass

active_ports = {}
for port in ${JSON.stringify(ports)}:
    url = f"http://127.0.0.1:{port}/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=1.2) as resp:
            raw = resp.read(16384).decode("utf-8", "replace")
            parsed = json.loads(raw)
            if isinstance(parsed.get("data"), list) or isinstance(parsed.get("models"), list):
                active_ports[str(port)] = {"status": 200, "verifiedModelApi": True}
    except urllib.error.HTTPError as he:
        if he.code in (401, 403):
            is_known_ccr = bool(ccr_info and int(ccr_info.get("port", 3456)) == int(port))
            active_ports[str(port)] = {"status": he.code, "verifiedModelApi": is_known_ccr}
    except Exception:
        pass

print(json.dumps({
    "binaries": bins,
    "cliAuthenticated": auth,
    "ccr": ccr_info,
    "activePorts": active_ports,
}))
`;

  const remoteScript = `python3 - <<'PY_EOF'\n${remotePy}\nPY_EOF\nexit 0\n`;

  try {
    const stdout = await new Promise((resolve, reject) => {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      const winSsh = path.join(sysRoot, 'System32', 'OpenSSH', 'ssh.exe');
      const sshBin = (process.platform === 'win32' && fs.existsSync(winSsh)) ? winSsh : 'ssh';
      const child = cp.spawn(
        sshBin,
        ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=7', sshTarget, 'bash -s'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      const chunks = [];
      const errs = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('SSH keşif zaman aşımı (14 sn)'));
      }, 14000);
      child.stdout.on('data', d => chunks.push(d));
      child.stderr.on('data', d => errs.push(d));
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(Buffer.concat(errs).toString('utf8').trim() || `SSH çıkış kodu: ${code}`));
        } else {
          resolve(Buffer.concat(chunks).toString('utf8'));
        }
      });
      child.stdin.end(remoteScript);
    });

    const lastJsonLine = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
    const parsed = JSON.parse(lastJsonLine);
    const activePorts = {};
    for (const [portStr, info] of Object.entries(parsed.activePorts || {})) {
      if (info && info.verifiedModelApi) {
        activePorts[Number(portStr)] = info.status;
      }
    }

    return {
      host: sshTarget,
      reachable: true,
      trustedSelfHosted: true,
      binaries: parsed.binaries || {},
      cliAuthenticated: parsed.cliAuthenticated || {},
      ccr: parsed.ccr || null,
      activePorts,
      sandboxes: {
        docker: Boolean(parsed.binaries?.docker),
        bwrap: Boolean(parsed.binaries?.bwrap),
      },
    };
  } catch (err) {
    return {
      host: sshTarget,
      reachable: false,
      trustedSelfHosted: true,
      reason: scrubSecrets(err.message || 'SSH bağlantısı kurulamadı').slice(0, 160),
      binaries: {},
      cliAuthenticated: {},
      ccr: null,
      activePorts: {},
      sandboxes: { docker: false, bwrap: false },
    };
  }
}

async function discoverEnvironment(registry, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const projectDir = options.projectDir || process.cwd();
  const loadDotEnv = options.loadDotEnv !== false && !options.env;

  const { env, loadedDotEnvFiles, dotEnvSecrets } = loadMergedEnv({
    baseEnv: options.env || process.env,
    projectDir,
    homeDir,
    loadDotEnv,
  });

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const probeLocalServices = options.probeLocalServices !== false;
  const probeSandboxes = options.probeSandboxes !== false;
  const inspectLocalProfiles = options.inspectLocalProfiles !== false;
  const probeCliBridges = options.probeCliBridges !== false;
  const sshTargets = Array.isArray(options.sshTargets) ? options.sshTargets : [];
  const customLocateBinary = options.locateBinary || ((b) => locateLocalBinary(b, env, homeDir));
  const customReadVersion = options.readVersion || ((bp, va) => readCliVersion(bp, va, env));

  const forbiddenSecrets = [...dotEnvSecrets];
  const localProfileInfo = inspectLocalProfiles
    ? inspectLocalRouterProfiles(homeDir, forbiddenSecrets)
    : { foundConfigFiles: [], hasRouterGatewayKey: false, routerPort: null, routerRoleMap: {}, configuredProviders: new Map() };

  const providerSpecs = registry.listProviders();
  const cliProviders = providerSpecs.filter(p => p.kind === 'cli-agent');

  const [remoteResults, wslInfo] = await Promise.all([
    Promise.all(
      sshTargets.map(target =>
        options.probeRemoteFn ? options.probeRemoteFn(target, providerSpecs) : probeRemoteSshHost(target, providerSpecs)
      )
    ),
    probeSandboxes && process.platform === 'win32'
      ? inspectWslEnvironment(cliProviders, env)
      : Promise.resolve({ available: false, distro: null, bwrapReady: false, binaries: {}, auth: {} }),
  ]);

  const reachableRemotes = remoteResults.filter(r => r.reachable);
  const discoveredProviders = [];

  for (const spec of providerSpecs) {
    const envPool = inspectEnvKeyPool(env, spec.authEnvVars || [], forbiddenSecrets);
    const footprints = (spec.configFootprints || []).filter(fp => {
      try { return fs.existsSync(expandHome(fp, homeDir)); } catch { return false; }
    });

    const effectiveBaseUrl = (spec.envBaseUrl && env[spec.envBaseUrl]) ? env[spec.envBaseUrl].trim() : (spec.baseUrl || null);

    // 1. Doğrudan HTTP API Sağlayıcıları (+ GitHub CLI `gh` gibi Token Köprüleri!)
    if (spec.kind === 'http-api') {
      const aliases = (spec.ccrProviderAliases || [spec.id]).map(a => a.toLowerCase());
      let profileHit = null;
      for (const al of aliases) {
        if (localProfileInfo.configuredProviders.has(al)) {
          profileHit = localProfileInfo.configuredProviders.get(al);
          break;
        }
      }

      let cliBridgeHit = null;
      if (!envPool.configured && !profileHit && spec.cliTokenBridge && probeCliBridges) {
        const bridgeRes = await checkCliTokenBridge(spec.cliTokenBridge, customLocateBinary, env, forbiddenSecrets);
        if (bridgeRes.ready) cliBridgeHit = bridgeRes;
      }

      const ready = Boolean(envPool.configured || profileHit || cliBridgeHit);
      const keyCount = envPool.configured
        ? envPool.keyCount
        : (profileHit ? (profileHit.keyCount || 1) : (cliBridgeHit ? 1 : 0));

      let status = 'unconfigured';
      let location = 'unconfigured';
      let credentialSource = null;
      if (envPool.configured) {
        status = 'ready_env_key';
        location = 'env-key';
        credentialSource = `Ortam değişkeni / .env (${envPool.presentEnvNames.join(', ')}; ${keyCount} anahtar)`;
      } else if (profileHit) {
        status = 'ready_local_profile_key';
        location = 'local-router-profile';
        credentialSource = profileHit.sourceLabel;
      } else if (cliBridgeHit) {
        status = 'ready_cli_token_bridge';
        location = 'cli-token-bridge';
        credentialSource = cliBridgeHit.sourceLabel;
      }

      const mergedModels = (spec.models || []).map(m => ({
        ...m,
        capabilities: Array.isArray(m.capabilities) ? m.capabilities : inferCapabilitiesFromModelId(m.id),
      }));

      if (profileHit?.models?.length) {
        for (const mId of profileHit.models) {
          if (!mergedModels.some(m => m.id === mId)) {
            mergedModels.unshift({
              id: mId,
              title: `${mId} (yerel profilden)`,
              roles: ['hizli-ucuz', 'dengeli', 'derin-mimari', 'kod-sokucu', 'uzun-baglam'],
              capabilities: inferCapabilitiesFromModelId(mId),
              trainsOnData: mId.endsWith(':free'),
              contextWindow: 128000,
            });
          }
        }
      }

      const roleDefaults = { ...(spec.roleDefaults || {}) };
      if (profileHit?.models?.length && !envPool.configured) {
        const allowed = profileHit.models;
        const fastCandidate = allowed.find(m => /:free$|flash|mini|air|haiku/i.test(m)) || allowed[0];
        const coderCandidate = allowed.find(m => /coder/i.test(m)) || allowed[0];
        const deepCandidate = allowed.find(m => /pro|r1|reasoner|opus|sonnet|m2\.7$|k2\.5$/i.test(m)) || allowed[0];

        if (!allowed.includes(roleDefaults['hizli-ucuz'])) roleDefaults['hizli-ucuz'] = fastCandidate;
        if (!allowed.includes(roleDefaults.dengeli)) roleDefaults.dengeli = allowed[0];
        if (!allowed.includes(roleDefaults['derin-mimari'])) roleDefaults['derin-mimari'] = deepCandidate;
        if (!allowed.includes(roleDefaults['kod-sokucu'])) roleDefaults['kod-sokucu'] = coderCandidate;
        if (!allowed.includes(roleDefaults['uzun-baglam'])) roleDefaults['uzun-baglam'] = deepCandidate;
      }

      discoveredProviders.push({
        id: spec.id,
        title: spec.title,
        kind: spec.kind,
        driver: spec.driver,
        billingMode: spec.billingMode,
        privacyTier: spec.privacyTier || 'standard_api',
        payerLabel: spec.payerLabel,
        ready,
        status,
        location,
        keyCount,
        baseUrl: profileHit?.baseUrl || effectiveBaseUrl,
        presentEnvNames: envPool.presentEnvNames,
        credentialSource,
        missingSetupHint: ready
          ? null
          : `${(spec.authEnvVars || []).join(' veya ')} ortam/.env değişkeni tanımlandığında${spec.cliTokenBridge ? ` (veya "${spec.cliTokenBridge.binary} auth login" yapıldığında)` : ''} otomatik aktif olur.`,
        roleDefaults,
        models: mergedModels,
      });
      continue;
    }

    // 2. Yerel veya Uzak Yönlendirici / Model Servisleri (OmniRoute, CCR, LiteLLM, Ollama, LM Studio, vLLM)
    if (spec.kind === 'local-or-remote-service') {
      const isRouterGateway = spec.id === 'router-gateway';
      const hasKnownRouterConfig = isRouterGateway && (localProfileInfo.foundConfigFiles.length > 0 || envPool.configured);
      let localHit = null;

      if (probeLocalServices) {
        const urlsToTry = (spec.envBaseUrl && env[spec.envBaseUrl])
          ? [`${env[spec.envBaseUrl].replace(/\/$/, '')}/models`]
          : (spec.probeUrls || []);
        for (const u of urlsToTry) {
          const res = await probeHttpEndpoint(u, {
            timeoutMs: 1500,
            fetchImpl,
            allowAuthProtectedRouter: hasKnownRouterConfig,
          });
          if (res.reachable) {
            localHit = res;
            break;
          }
        }
      }

      const remoteHits = [];
      let remoteCcrMeta = null;
      for (const rem of reachableRemotes) {
        for (const port of spec.remoteProbePorts || []) {
          if (rem.activePorts && rem.activePorts[port]) {
            remoteHits.push({ host: rem.host, port, httpStatus: rem.activePorts[port] });
            if (isRouterGateway && rem.ccr) remoteCcrMeta = rem.ccr;
          }
        }
      }

      const ready = Boolean(localHit || remoteHits.length > 0);
      const location = localHit
        ? 'local-service'
        : (remoteHits.length ? `remote-ssh:${remoteHits[0].host}:${remoteHits[0].port}` : 'offline');

      const roleDefaults = { ...(spec.roleDefaults || {}) };
      if (isRouterGateway) {
        const activeRouterMap = (localHit && Object.keys(localProfileInfo.routerRoleMap).length)
          ? localProfileInfo.routerRoleMap
          : (remoteCcrMeta?.router
            ? {
                'hizli-ucuz': remoteCcrMeta.router.background || remoteCcrMeta.router.default,
                dengeli: remoteCcrMeta.router.default,
                'derin-mimari': remoteCcrMeta.router.think || remoteCcrMeta.router.default,
                'kod-sokucu': remoteCcrMeta.router.default,
                'uzun-baglam': remoteCcrMeta.router.longContext || remoteCcrMeta.router.default,
              }
            : {});
        for (const [rk, rv] of Object.entries(activeRouterMap)) {
          if (rv) roleDefaults[rk] = rv;
        }
      }

      const discoveredModelObjs = localHit?.discoveredModels?.length
        ? localHit.discoveredModels.map(id => ({
            id,
            title: id,
            roles: ['hizli-ucuz', 'dengeli', 'derin-mimari', 'kod-sokucu', 'uzun-baglam'],
            capabilities: inferCapabilitiesFromModelId(id),
            trainsOnData: false,
            contextWindow: 128000,
          }))
        : (remoteCcrMeta?.providers?.length
          ? remoteCcrMeta.providers.flatMap(p =>
              (p.models || []).map(m => ({
                id: `${p.name},${m}`,
                title: `${p.name}/${m}`,
                roles: ['hizli-ucuz', 'dengeli', 'derin-mimari', 'kod-sokucu', 'uzun-baglam'],
                capabilities: inferCapabilitiesFromModelId(m),
                trainsOnData: m.endsWith(':free'),
                contextWindow: 128000,
              }))
            )
          : (spec.models || []));

      discoveredProviders.push({
        id: spec.id,
        title: spec.title,
        kind: spec.kind,
        driver: spec.driver,
        billingMode: spec.billingMode,
        privacyTier: spec.privacyTier || 'private_local',
        payerLabel: spec.payerLabel,
        ready,
        status: ready ? 'ready_service' : (footprints.length ? 'configured_but_service_stopped' : 'offline'),
        location,
        keyCount: ready ? 1 : 0,
        baseUrl: effectiveBaseUrl,
        localService: localHit,
        remoteServices: remoteHits,
        configFootprintsFound: footprints,
        presentEnvNames: envPool.presentEnvNames,
        missingSetupHint: ready
          ? null
          : footprints.length
            ? `Yapılandırma bulundu (${footprints.join(', ')}) ancak yerel servis (${effectiveBaseUrl}) şu an çalışmıyor.`
            : `Yerel servis kapalı (${effectiveBaseUrl}). Başlatıldığında veya uzak sunucu bağlandığında aktif olur.`,
        roleDefaults,
        models: discoveredModelObjs,
      });
      continue;
    }

    // 3. Başsız (Headless) CLI Ajanları (`codex`, `claude`, `opencode`, `gemini`, `aider`, `goose`, `qwen`...)
    if (spec.kind === 'cli-agent') {
      let localBinPath = null;
      let matchedBinName = null;
      for (const b of spec.binaries || []) {
        const found = await customLocateBinary(b);
        if (found) {
          localBinPath = found;
          matchedBinName = b;
          break;
        }
      }
      const versionText = localBinPath ? await customReadVersion(localBinPath, spec.versionArgs || ['--version']) : null;

      const authDetail = options.assumeCliAuthenticated
        ? { verifiedFiles: ['test-assumed-auth'], expiredFiles: [] }
        : checkAuthFootprintsDetailed(spec.authFootprints || [], homeDir, forbiddenSecrets);

      const localAuthenticated = Boolean(
        localBinPath && (envPool.configured || authDetail.verifiedFiles.length > 0)
      );

      let wslBinaryHit = null;
      if (wslInfo?.available) {
        for (const b of spec.binaries || []) {
          if (wslInfo.binaries?.[b]) {
            wslBinaryHit = { binary: b, path: wslInfo.binaries[b], authenticated: Boolean(wslInfo.auth?.[spec.id]) };
            break;
          }
        }
      }

      const remoteBins = [];
      for (const rem of reachableRemotes) {
        for (const b of spec.binaries || []) {
          if (rem.binaries && rem.binaries[b]) {
            remoteBins.push({
              host: rem.host,
              binary: b,
              path: rem.binaries[b],
              authenticated: Boolean(rem.cliAuthenticated?.[spec.id]),
            });
          }
        }
      }
      const authenticatedRemote = remoteBins.find(r => r.authenticated) || null;

      const ready = Boolean(localAuthenticated || wslBinaryHit?.authenticated || authenticatedRemote);
      let location = 'not-installed';
      let status = 'not_installed';
      if (localAuthenticated) {
        location = 'local-cli';
        status = 'ready_authenticated';
      } else if (wslBinaryHit?.authenticated) {
        location = 'wsl2-cli';
        status = 'ready_authenticated_wsl';
      } else if (authenticatedRemote) {
        location = `remote-ssh:${authenticatedRemote.host}`;
        status = 'ready_authenticated_remote';
      } else if (authDetail.expiredFiles.length > 0 && localBinPath) {
        location = 'local-cli-expired';
        status = 'expired_auth';
      } else if (localBinPath || remoteBins.length > 0) {
        location = localBinPath ? 'local-cli-unauthenticated' : `remote-ssh-unauthenticated:${remoteBins[0].host}`;
        status = 'installed_unauthenticated';
      }

      let missingSetupHint = null;
      if (!ready) {
        if (status === 'expired_auth') {
          missingSetupHint = `"${matchedBinName}" kimlik dosyasının (${authDetail.expiredFiles.join(', ')}) oturum süresi dolmuş ve yenileme anahtarı yok. Tekrar giriş yapıldığında aktif olur.`;
        } else if (status === 'installed_unauthenticated') {
          missingSetupHint = `"${matchedBinName || (spec.binaries || [])[0]}" komutu kurulu (${versionText || 'bulundu'}) ancak aktif oturum/kimlik dosyası (${(spec.authFootprints || []).join(' veya ')}) bulunamadı.`;
        } else if (footprints.length) {
          missingSetupHint = `Ayar izi (${footprints.join(', ')}) bulundu ancak "${(spec.binaries || [])[0]}" komutu PATH veya standart kurulum yollarında bulunamadı.`;
        } else {
          missingSetupHint = `"${(spec.binaries || [])[0]}" CLI aracı kurulup oturum açıldığında otomatik tanınır.`;
        }
      }

      discoveredProviders.push({
        id: spec.id,
        title: spec.title,
        kind: spec.kind,
        driver: spec.driver,
        billingMode: spec.billingMode,
        privacyTier: spec.privacyTier || 'standard_api',
        payerLabel: spec.payerLabel,
        ready,
        status,
        location,
        keyCount: ready ? Math.max(1, envPool.keyCount) : 0,
        contextWindow: spec.contextWindow || 128000,
        capabilities: Array.isArray(spec.capabilities) ? spec.capabilities : ['text', 'code_agent'],
        executionModes: spec.executionModes || { safe_text: spec.headlessTemplate || [], workspace_agent: spec.headlessTemplate || [] },
        localBinary: localBinPath
          ? { name: matchedBinName, path: localBinPath, version: versionText, authenticated: localAuthenticated }
          : null,
        wslBinary: wslBinaryHit,
        remoteBinaries: remoteBins,
        verifiedLocalAuthFiles: authDetail.verifiedFiles,
        expiredLocalAuthFiles: authDetail.expiredFiles,
        configFootprintsFound: footprints,
        presentEnvNames: envPool.presentEnvNames,
        roles: spec.roles || ['dengeli'],
        rolePriority: spec.rolePriority || 70,
        missingSetupHint,
      });
    }
  }

  const sandboxes = probeSandboxes ? await detectLocalSandboxes(env, wslInfo, reachableRemotes) : [];

  const report = {
    discoveredAt: new Date().toISOString(),
    hostPlatform: process.platform,
    nodeVersion: process.version,
    loadedDotEnvFiles,
    wslDistros: wslInfo?.allDistros || [],
    summary: {
      totalRegisteredProviders: discoveredProviders.length,
      readyCount: discoveredProviders.filter(p => p.ready).length,
      readyIds: discoveredProviders.filter(p => p.ready).map(p => p.id),
      installedUnauthenticatedIds: discoveredProviders.filter(p => p.status === 'installed_unauthenticated' || p.status === 'expired_auth').map(p => p.id),
      sandboxesReady: sandboxes.filter(s => s.ready).map(s => s.id),
      remoteHostsReachable: reachableRemotes.map(r => r.host),
    },
    providers: discoveredProviders,
    remoteHosts: remoteResults,
    sandboxes,
  };

  assertNoLeakedSecretValues(JSON.stringify(report), env, forbiddenSecrets);
  return report;
}

module.exports = {
  discoverEnvironment,
  inspectLocalRouterProfiles,
  inferCapabilitiesFromModelId,
  hasValidUnexpiredTokenState,
  locateLocalBinary,
  probeHttpEndpoint,
  detectLocalSandboxes,
  probeRemoteSshHost,
};
