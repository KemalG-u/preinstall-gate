'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { githubSource } = require('./github-arsiv.cjs');
const { resolvePythonExecutable } = require('./kapi-motor.cjs');

const ROOT = __dirname;
const WSL = 'C:\\Windows\\System32\\wsl.exe';
const SUPERVISOR_CODE = fs.readFileSync(path.join(ROOT, 'lab-yalitim.py'), 'utf8');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SAFE_CLI_FLAG_TOKEN = /^[A-Za-z0-9_.,:=+@/-]{1,64}$/;
const CREDENTIAL_LIKE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[a-zA-Z0-9_]{20,}|github_pat_[a-zA-Z0-9_]{20,}|sk-(?:proj-|live-|ant-)?[a-zA-Z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[a-zA-Z0-9-]{15,})\b/g;

const MAX_SESSIONS = 32;
const SESSION_TTL = 6 * 60 * 60 * 1000;
const MAX_RUNS = 32;
const MAX_SAVED = 128;
const MAX_RECORD_BYTES = 1536 * 1024; // 1.5 MiB
const MAX_INPUT_CHARS = 4000;
const MAX_INTENT_CHARS = 400;
const WHEEL_CACHE_ROOT = path.join(ROOT, '.cache', 'depo-wheels');

const SUPPORTED_SCOPE = Object.freeze({
  runtime: 'WSL2 Ubuntu (Python 3.14.4, glibc 2.43) + Bubblewrap (bwrap) + libseccomp',
  networkDefault: 'Ağ tamamen kapalı (--unshare-net ve seccomp ile tüm soket aileleri EPERM)',
  manifests: [
    'pyproject.toml ([project.scripts], Poetry, Flit)',
    'setup.cfg (console_scripts)',
    'setup.py (yalnız AST ile okunur, çalıştırılmaz)',
    '<paket>/__main__.py (python -m <paket>)',
  ],
  dependencies: 'Standart kütüphane veya ayrı hazırlık aşamasında PEP 508 Linux işaretçileri süzülerek indirilen ve SHA-256 özeti kilitlenen ikili (.whl) paketler (py3-none-any ve manylinux x86_64 cp314/abi3; kaynak derlemesi kapalıdır)',
  unsupported: [
    'Grafik masaüstü arayüzü (PyQt, PySide, tkinter, wxPython, pygame) bekleyen araçlar',
    'Yalnızca Windows API (pywin32, winreg, WMI) kullanan araçlar',
    'Canlı internet/API bağlantısı olmadan hiçbir yerel dönüşüm yapamayan istemciler',
    'Komut satırı girişi olmayan saf kütüphaneler veya doğrulanabilir iç veri akışı bulunmayan betikler',
  ],
  staticFallback: 'Model hesabı (Codex vb.) gerekmez; kaynak kod AST analizi ve JS/TS için mevcut REA statik keşfi doğrudan çalışır.',
});

const INTENT_CONCEPTS = [
  {
    id: 'table_csv',
    label: 'tablo / CSV / satır-sütun biçimlendirme',
    tr: ['tablo', 'sutun', 'sütun', 'satir', 'satır', 'csv', 'tsv', 'excel', 'liste', 'hizala'],
    en: ['table', 'tabular', 'csv', 'tsv', 'column', 'row', 'delimit', 'grid', 'align'],
  },
  {
    id: 'sql',
    label: 'SQL sorgu ayrıştırma / biçimlendirme',
    tr: ['sql', 'sorgu', 'veritabani', 'veritabanı', 'select', 'tablo sorgusu'],
    en: ['sql', 'query', 'queries', 'statement', 'ddl', 'dml', 'select'],
  },
  {
    id: 'html_md',
    label: 'HTML / Markdown belge dönüşümü',
    tr: ['html', 'markdown', 'etiket', 'belge', 'not', 'web metni', 'metne cevir', 'metne çevir'],
    en: ['html', 'markdown', 'md', 'markup', 'document', 'tag', 'heading'],
  },
  {
    id: 'json_yaml_toml',
    label: 'JSON / YAML / TOML yapılandırma ve veri denetimi',
    tr: ['json', 'yaml', 'yml', 'toml', 'yapilandirma', 'yapılandırma', 'sema', 'şema', 'dogrula', 'doğrula', 'kural', 'lint'],
    en: ['json', 'yaml', 'yml', 'toml', 'config', 'schema', 'validate', 'lint', 'check'],
  },
  {
    id: 'file_organize',
    label: 'dosya / klasör düzenleme ve özetleme',
    tr: ['dosya', 'klasor', 'klasör', 'ayir', 'ayır', 'duzenle', 'düzenle', 'fatura', 'arsiv', 'arşiv', 'agac', 'ağaç'],
    en: ['file', 'folder', 'directory', 'organize', 'move', 'rename', 'tree', 'archive', 'path'],
  },
  {
    id: 'media_gui',
    label: 'görsel / video / ses / grafik pencere işleme',
    tr: ['resim', 'gorsel', 'görsel', 'fotograf', 'fotoğraf', 'video', 'ses', 'mp3', 'mp4', 'kirp', 'kırp', 'pencere', 'oyun'],
    en: ['image', 'photo', 'video', 'audio', 'crop', 'resize', 'gui', 'window', 'game'],
  },
  {
    id: 'network_api',
    label: 'canlı internet / uzak API indirme',
    tr: ['indir', 'siteye baglan', 'siteye bağlan', 'canli veri', 'canlı veri', 'hava durumu', 'borsa', 'eposta gonder'],
    en: ['http', 'download', 'scrape', 'crawl', 'webhook', 'weather', 'fetch url'],
  },
];

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function requireCond(cond, status, message, extra) {
  if (!cond) throw httpError(status, message, extra);
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isUuid(v) {
  return typeof v === 'string' && v.length === 36 && UUID.test(v);
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sanitizeText(raw, maxLen) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}

function parseExtraFlags(rawFlags) {
  if (rawFlags === undefined || rawFlags === null || rawFlags === '') return [];
  const tokens = Array.isArray(rawFlags)
    ? rawFlags.map(x => String(x).trim()).filter(Boolean)
    : String(rawFlags).trim().split(/\s+/).filter(Boolean);
  requireCond(tokens.length <= 8, 400, 'En fazla 8 ek komut seçeneği (bayrak) verilebilir.');
  for (const tok of tokens) {
    requireCond(
      SAFE_CLI_FLAG_TOKEN.test(tok) && !tok.includes('..') && !tok.startsWith('/'),
      400,
      `Güvenli olmayan komut seçeneği reddedildi: "${tok.slice(0, 32)}". Yalnızca basit seçenek bayrakları (ör. --help veya -v) kullanılabilir.`
    );
  }
  return tokens;
}

const REPO_META_MANIFESTS = new Set(['pyproject.toml', 'setup.cfg', 'setup.py', 'requirements.txt']);

function isMountableRepoSourceFile(f) {
  return Boolean(
    f &&
    typeof f.name === 'string' &&
    typeof f.text === 'string' &&
    !REPO_META_MANIFESTS.has(f.name)
  );
}

function computeSourceEvidenceSha256(pyFiles) {
  const pairs = pyFiles
    .filter(isMountableRepoSourceFile)
    .map(f => [f.name, sha256Text(f.text)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Text(JSON.stringify(pairs));
}

function runHostPython(args, { input, timeout = 15000, signal, site = false } = {}) {
  const executable = resolvePythonExecutable();
  const env = {};
  for (const k of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-I', '-B', '-X', 'utf8', ...(site ? [] : ['-S']), ...args], {
      cwd: ROOT,
      env,
      shell: false,
      windowsHide: true,
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    let bytes = 0;
    let settled = false;
    const finish = (e, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (e) reject(e);
      else resolve(val);
    };
    const onAbort = () => {
      child.kill();
      finish(httpError(408, 'İstek iptal edildi.'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(httpError(504, 'Statik Python çözümlemesi süre sınırını aştı.'));
    }, timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', b => {
      bytes += b.length;
      if (bytes > 2 * 1024 * 1024) {
        child.kill();
        finish(httpError(502, 'Çözümleme çıktısı boyut sınırını aştı.'));
      } else out.push(b);
    });
    child.stderr.on('data', b => {
      if (err.length < 32) err.push(b);
    });
    child.on('error', () => finish(httpError(503, 'Yerel Python yorumlayıcısı çalıştırılamadı.')));
    child.on('close', code => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) finish(httpError(502, `Python işlemi tamamlanamadı (kod ${code}).`, { stderr: stderr.slice(-800) }));
      else finish(null, { stdout, stderr });
    });
    if (input) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

async function analyzePythonStatic(pythonFiles, signal) {
  if (!pythonFiles?.length) {
    return {
      jobs: [],
      analyzedPaths: [],
      limitations: [],
      pythonMeta: {
        name: null,
        version: '0.0.0',
        description: null,
        license: null,
        requiresPython: null,
        dependencies: [],
        entrypoints: [],
        support: {
          supported: false,
          code: 'NO_PYTHON_SOURCE',
          reason: 'Bu depoda incelenebilir Python kaynak dosyası bulunamadı.',
          nextStep: 'Herkese açık bir Python komut satırı (CLI) deposu bağlantısı verin veya JS/TS kaynakları için statik bulguları inceleyin.',
        },
      },
    };
  }
  const { stdout } = await runHostPython([path.join(ROOT, 'repo-analiz.py')], {
    input: JSON.stringify({ files: pythonFiles }),
    signal,
    timeout: 14000,
  });
  return JSON.parse(stdout);
}

/**
 * Select general, non-hardcoded CLI flags strictly from AST-discovered `invocation.options`!
 * For example, if ANY CLI defines a boolean reindent/pretty/header flag in its own `argparse`/`click` AST,
 * we can surface those options in UI and pick safe zero-flag or AST-discovered formatting flags without ever
 * mentioning or checking any repository name!
 */
function pickDiscoveredDefaultFlags(options, fmt) {
  const opts = Array.isArray(options) ? options : [];
  const chosen = [];
  for (const opt of opts) {
    const flags = Array.isArray(opt.flags) ? opt.flags : [];
    const help = String(opt.help || '').toLowerCase();
    if (!flags.length) continue;
    const preferredFlag = flags.find(f => f.startsWith('--')) || flags[0];
    if (!SAFE_CLI_FLAG_TOKEN.test(preferredFlag)) continue;
    // If an SQL or formatter CLI explicitly exposes a boolean `reindent` / `pretty` flag in its own AST, enable it
    if (opt.isFlag && fmt === 'sql' && /\breindent\b|\bpretty\b/.test(preferredFlag + ' ' + help)) {
      chosen.push(preferredFlag);
    }
    if (chosen.length >= 2) break;
  }
  return chosen;
}

function buildTrialDefaults(job) {
  const spec = job?.flowSpec || {};
  const inv = spec.invocation || {};
  const fmt = inv.sampleFormat || 'text';
  const mode = inv.inputMode || 'file_arg';
  const cli = spec.cli || 'komut';
  const subcommand = spec.subcommand || null;
  const groupFileFlag = inv.groupFileFlag || null;
  const reqPosCount = (inv.positionalArgs || []).filter(p => p.required).length;
  const discoveredFlags = pickDiscoveredDefaultFlags(inv.options, fmt);

  let inputA = '';
  let inputB = '';
  let inputFileName = 'ornek-girdi.txt';
  let inputLabel = 'Deney girdisi (yapay örnek veri)';
  let usageHint = '';

  if (mode === 'multi_positional_tokens') {
    inputFileName = fmt === 'dotenv' ? 'ornek.env' : 'ornek-durum.txt';
    inputA = 'ORNEK_ANAHTAR birinci_deger\n';
    inputB = 'ORNEK_ANAHTAR guncellenmis_deger\n';
    inputLabel = `Komut satırı konumlu parametreleri (${reqPosCount} argüman)`;
    usageHint = 'Verilen konumlu argümanları hedef yapılandırma dosyasına veya standart çıktıya işlemek için kullanılır.';
  } else if (fmt === 'csv') {
    inputFileName = 'ornek-veri.csv';
    inputA = 'urun_kodu,kategori,adet,durum\nKALEM-01,Kirtasiye,12,Hazir\nDEFTER-02,Kirtasiye,5,Bekliyor\n';
    inputB = 'urun_kodu,kategori,adet,durum\nKALEM-01,Kirtasiye,12,Hazir\nDEFTER-02,Ofis,25,Tamamlandi\nSILGI-03,Kirtasiye,40,Yeni\n';
    inputLabel = 'Virgülle ayrılmış (CSV) örnek tablo verisi';
    usageHint = 'Ham CSV tablolarını süzmek, sütun seçmek, doğrulamak veya okunabilir rapor çıktısına dönüştürmek için kullanılır.';
  } else if (fmt === 'table') {
    inputFileName = 'ornek-tablo.txt';
    inputA = 'Urun_Kodu\tAdet\tDurum\nKALEM-01\t12\tHazir\nDEFTER-02\t5\tBekliyor\n';
    inputB = 'Urun_Kodu\tAdet\tDurum\nKALEM-01\t12\tHazir\nDEFTER-02\t25\tTamamlandi\nSILGI-03\t40\tYeni\n';
    inputLabel = 'Sekme/boşluk ayrılmış satır ve sütun verisi';
    usageHint = 'Ham satır-sütun çıktısını raporlarda, README belgelerinde veya konsol ekranında düzgün hizalanmış tabloya çevirmek için kullanılır.';
  } else if (fmt === 'sql') {
    inputFileName = 'ornek-sorgu.sql';
    inputA = 'select id, isim, sehir from musteriler where aktif = 1 order by isim;\n';
    inputB = 'select siparis_no, toplam_tutar from siparisler where toplam_tutar >= 250 and durum = \'onayli\' order by toplam_tutar desc;\n';
    inputLabel = 'Örnek SQL sorgu metni';
    usageHint = 'Tek satıra sıkışmış veya karmaşık SQL sorgularını kod incelemesi, günlük analizi ve veri tabanı taşıma dosyaları için ayrıştırıp düzenlemek amacıyla kullanılır.';
  } else if (fmt === 'yaml') {
    inputFileName = 'ornek-ayar.yaml';
    inputA = '---\nuygulama: urun-tani\nsurum: 1\naktif: true\nportlar:\n  - 4178\n';
    inputB = '---\nuygulama: urun-tani\nsurum: 2\nuygulama: cift-anahtar\nportlar:\n    - 4178\n';
    inputLabel = 'Örnek YAML yapılandırma dosyası';
    usageHint = 'YAML yapılandırma ve iş akışı dosyalarını dağıtım öncesinde sözdizimi, girinti ve kural hatalarına karşı denetlemek veya dönüştürmek için kullanılır.';
  } else if (fmt === 'toml') {
    inputFileName = 'ornek-ayar.toml';
    inputA = '[proje]\nad = "urun-tani"\nsurum = "1.0.0"\naktif = true\n';
    inputB = '[proje]\nad = "urun-tani"\nsurum = "2.0.0"\naktif = false\netiketler = ["yalitim", "deney"]\n';
    inputLabel = 'Örnek TOML yapılandırma verisi';
    usageHint = 'TOML biçimli yapılandırma dosyalarını ayrıştırmak, doğrulamak veya başka veri biçimlerine aktarmak için kullanılır.';
  } else if (fmt === 'html') {
    inputFileName = 'ornek-sayfa.html';
    inputA = '<h1>Urun Ozeti</h1><p>Bu arac <strong>HTML</strong> metnini isler.</p><ul><li>Hizli</li><li>Yalitilmis</li></ul>\n';
    inputB = '<h1>Guncel Rapor</h1><p>Ikinci denemede <a href="https://ornek.yerel/rapor">baglanti</a> ve yeni madde eklendi.</p>\n';
    inputLabel = 'Örnek HTML belge metni';
    usageHint = 'Web sayfalarından veya e-postalardan gelen HTML içeriklerini etiket karmaşasından arındırıp düz metin/Markdown olarak işlemek için kullanılır.';
  } else if (fmt === 'markdown') {
    inputFileName = 'ornek-not.md';
    inputA = '# Toplanti Notu\n\n- **Karar:** Yalitilmis test acik.\n- *Durum:* Hazir.\n';
    inputB = '# Teslim Plani\n\n1. Kaynagi incele\n2. **A ve B** girdilerini karsilastir\n3. Kaydi sakla\n';
    inputLabel = 'Örnek Markdown belge metni';
    usageHint = 'Markdown ile yazılmış not ve belgeleri HTML veya hedef belge biçimine dönüştürmek ve denetlemek için kullanılır.';
  } else if (fmt === 'json') {
    inputFileName = 'ornek-veri.json';
    inputA = '{"birim": "depo", "sayac": 2, "aktif": true}\n';
    inputB = '{"birim": "uretim", "sayac": 5, "aktif": false, "etiket": "yeni"}\n';
    inputLabel = 'Örnek JSON verisi';
    usageHint = 'Yapılandırılmış JSON girdilerini doğrulamak, süzmek veya okunabilir çıktıya dönüştürmek için kullanılır.';
  } else if (fmt === 'xml') {
    inputFileName = 'ornek-belge.xml';
    inputA = '<kayitlar><urun kod="K-01" adet="12"/><urun kod="D-02" adet="5"/></kayitlar>\n';
    inputB = '<kayitlar><urun kod="K-01" adet="12"/><urun kod="S-03" adet="40" durum="yeni"/></kayitlar>\n';
    inputLabel = 'Örnek XML verisi';
    usageHint = 'XML belgelerini ayrıştırıp yapılandırılmış veri veya rapora dönüştürmek için kullanılır.';
  } else if (fmt === 'dotenv') {
    inputFileName = 'ornek.env';
    inputA = 'UYGULAMA_MODU=yerel\nMAKS_DENEME=3\n';
    inputB = 'UYGULAMA_MODU=uretim\nMAKS_DENEME=10\nEK_BAYRAK=acik\n';
    inputLabel = 'Örnek anahtar=değer (.env) satırları';
    usageHint = 'Anahtar-değer biçimindeki yapılandırma satırlarını ayrıştırıp doğrulamak için kullanılır.';
  } else {
    inputFileName = 'ornek-girdi.txt';
    inputA = 'Birinci deneme satiri: Merhaba Urun Tani\nIkinci satir: 42\n';
    inputB = 'Degistirilmis deneme satiri: Yeni deger 99\nUcuncu satir: Ek kontrol\n';
    inputLabel = 'Örnek metin girdisi';
    usageHint = 'Verilen metin veya dosya girdisini aracın tanımladığı kurallarla işleyip bir sonraki adıma veya standart çıktıya aktarmak için kullanılır.';
  }

  const groupPrefix = groupFileFlag ? [cli, groupFileFlag, inputFileName] : [cli];
  const baseCmd = subcommand ? [...groupPrefix, subcommand] : groupPrefix;
  let argvTemplate;
  if (mode === 'stdin') {
    argvTemplate = [...baseCmd, ...discoveredFlags];
  } else if (mode === 'positional_text' || mode === 'multi_positional_tokens') {
    argvTemplate = [...baseCmd, ...discoveredFlags, '__INLINE_INPUT__'];
  } else {
    argvTemplate = groupFileFlag ? [...baseCmd, ...discoveredFlags] : [...baseCmd, ...discoveredFlags, inputFileName];
  }

  return {
    sampleFormat: fmt,
    inputMode: mode,
    subcommand,
    groupFileFlag,
    requiredPosCount: reqPosCount,
    discoveredFlags,
    availableOptions: (inv.options || []).slice(0, 12),
    inputFileName,
    inputLabel,
    argvTemplate,
    inputA,
    inputB,
    usageHint,
  };
}

function evaluateIntentFitAndRankJobs(intent, jobs, pythonMeta, readmeText, supported) {
  const intentLower = (intent || '').toLowerCase();
  const repoCorpus = [
    pythonMeta?.name || '',
    pythonMeta?.description || '',
    readmeText.slice(0, 2500),
    ...jobs.map(j => `${j.title} ${j.summary} ${j.output} ${j.flowSpec?.invocation?.sampleFormat || ''}`),
  ].join(' ').toLowerCase();

  const userConcepts = INTENT_CONCEPTS.filter(c =>
    c.tr.some(w => intentLower.includes(w)) || c.en.some(w => intentLower.includes(w))
  );
  const repoConcepts = INTENT_CONCEPTS.filter(c =>
    c.tr.some(w => repoCorpus.includes(w)) || c.en.some(w => repoCorpus.includes(w))
  );

  // Score jobs by overlap with user's intent words so the most relevant job is selected first!
  const intentWords = intentLower
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(w => w.length >= 3);

  const scoredJobs = jobs.map((job, idx) => {
    const jobBlob = `${job.title} ${job.summary} ${job.output} ${job.consumer} ${job.flowSpec?.subcommand || ''}`.toLowerCase();
    let score = (jobs.length - idx) * 2;
    for (const w of intentWords) {
      if (jobBlob.includes(w)) score += 6;
    }
    if (job.isNaturalRepoConsumer) score += 4;
    return { job, score };
  });
  scoredJobs.sort((a, b) => b.score - a.score);
  const rankedJobs = scoredJobs.map(x => x.job);

  if (!supported) {
    return {
      rankedJobs,
      intentFit: {
        verdict: 'destek_disi',
        badge: 'Canlı deneme kapsamı dışında',
        explanation: `Yazdığın amaç ("${intent}") için depo incelendi ancak bu kaynak şu anki güvenli Linux Python CLI yalıtım kapsamında doğrudan çalıştırılamıyor. Aşağıdaki statik bulgularla yapısını inceleyebilirsin.`,
      },
    };
  }

  const asksMediaOrGui = userConcepts.some(c => c.id === 'media_gui') && !repoConcepts.some(c => c.id === 'media_gui');
  const asksLiveNetwork = userConcepts.some(c => c.id === 'network_api');
  if (asksMediaOrGui) {
    return {
      rankedJobs,
      intentFit: {
        verdict: 'uyumsuz_gorunuyor',
        badge: 'Amacınla örtüşmüyor olabilir',
        explanation: `Dikkat: "${intent}" amacında görsel/medya veya pencere arayüzü işlemi geçiyor; oysa bu deponun kaynak kodunda yalnızca metin/veri işleyen komut satırı akışları bulundu. Yine de aracın kendi gerçek işini aşağıda deneyebilirsin.`,
      },
    };
  }
  if (asksLiveNetwork) {
    return {
      rankedJobs,
      intentFit: {
        verdict: 'kismi',
        badge: 'Yalnız yerel veriyle denenebilir (ağ kapalı)',
        explanation: `"${intent}" amacında dış bağlantı/indirme ifadesi var. Güvenlik gereği deney ortamında internet tamamen kapalıdır; aracın yalnızca yerel dosya/metin işleme adımlarını deneyebilirsin.`,
      },
    };
  }

  const overlapping = userConcepts.filter(uc => repoConcepts.some(rc => rc.id === uc.id));
  if (overlapping.length > 0) {
    return {
      rankedJobs,
      intentFit: {
        verdict: 'uyumlu',
        badge: 'Amacınla doğrudan uyumlu',
        explanation: `Evet — yazdığın amaç ("${intent}") ile bu deponun kaynak kodunda doğrulanan **${overlapping.map(o => o.label).join(', ')}** yeteneği örtüşüyor. En ilgili iş otomatik seçildi.`,
      },
    };
  }

  if (userConcepts.length > 0 && repoConcepts.length > 0 && overlapping.length === 0) {
    return {
      rankedJobs,
      intentFit: {
        verdict: 'uyumsuz_gorunuyor',
        badge: 'Farklı bir iş yapıyor olabilir',
        explanation: `Not: Sen "${intent}" istedin (${userConcepts.map(c => c.label).join(', ')}), ancak bu deponun kaynak kodundaki komutlar **${repoConcepts.map(c => c.label).join(', ')}** üzerine kurulu. Aracın gerçekte ne yaptığını aşağıdaki iş akışından görebilirsin.`,
      },
    };
  }

  return {
    rankedJobs,
    intentFit: {
      verdict: 'genel_inceleme',
      badge: 'Kaynak akışı doğrulandı',
      explanation: `Yazdığın amaç ("${intent}") doğrultusunda depodaki gerçek komut girişleri ve veri dönüşüm adımları çıkarıldı; seçili işi aşağıda kendi girdinle deneyebilirsin.`,
    },
  };
}

function buildPlainTurkishOverview({ repository, intent, pythonMeta, reaSummary, files, jobs, intentFit }) {
  const readme = files.find(f => /readme/i.test(f.name))?.text || '';
  const cleanReadmeFirstPara = readme
    .split(/\r?\n\r?\n/)
    .map(p => p.replace(/[#>*`[\]]/g, '').replace(/\s+/g, ' ').trim())
    .find(p => p.length >= 35 && !/^!\[|^https?:/i.test(p)) || '';

  const desc = pythonMeta?.description || cleanReadmeFirstPara || '';
  const firstJob = jobs[0] || null;
  const defaults = firstJob ? firstJob.trialDefaults : null;

  let whoAndWhat = '';
  if (firstJob && defaults) {
    const fmtDescriptions = {
      csv: 'elindeki virgülle ayrılmış (CSV) satır-sütun verilerini komut satırından hızlıca süzmek, dönüştürmek veya raporlamak isteyen veri analistlerine, geliştiricilere ve ofis kullanıcılarına',
      table: 'ham satır ve sütun verilerini insanların kolayca okuyabileceği düzgün hizalanmış metin veya belge tablolarına çevirmek isteyen geliştiricilere ve rapor hazırlayan kişilere',
      sql: 'karmaşık veya tek satıra sıkışmış SQL sorgularını kurallarına göre ayrıştırıp okunabilir ve düzenli biçime getirmek isteyen yazılımcılara ve veri mühendislerine',
      yaml: 'YAML yapılandırma dosyalarındaki yazım, girinti ve kural hatalarını çalıştırma öncesinde yakalamak veya ayrıştırmak isteyen sistem yöneticilerine ve geliştiricilere',
      toml: 'TOML biçimli yapılandırma dosyalarını ayrıştırıp doğrulamak veya dönüştürmek isteyen geliştiricilere',
      html: 'HTML etiketleriyle dolu web veya e-posta metinlerini etiket karmaşasından arındırıp sade, okunabilir metne dönüştürmek isteyen kullanıcılara',
      markdown: 'Markdown işaretleriyle yazılmış notları ve belgeleri standart çıktı biçimlerine (ör. HTML) dönüştürmek isteyen yazarlara ve geliştiricilere',
      json: 'JSON biçimli veri dosyalarını komut satırında doğrulamak, süzmek veya biçimlendirmek isteyen kullanıcılara',
      xml: 'XML belgelerini ayrıştırıp düzenli veri çıktısına dönüştürmek isteyen kullanıcılara',
      dotenv: 'anahtar=değer (.env) yapılandırma satırlarını ayrıştırıp yönetmek isteyen geliştiricilere',
      text: 'komut satırından verilen metin veya dosya girdisini otomatik kurallarla işleyip düzenli çıktıya dönüştürmek isteyen kullanıcılara',
    };
    const audience = fmtDescriptions[defaults.sampleFormat] || fmtDescriptions.text;
    whoAndWhat = `${repository} aracı, ${audience} yardımcı olur.${desc ? ` (Paket özeti: ${desc.slice(0, 180)})` : ''}`;
  } else if (reaSummary) {
    whoAndWhat = `${repository} deposu bir JavaScript/TypeScript kaynağı içeriyor. ${reaSummary}`;
  } else {
    whoAndWhat = `${repository} deposu incelendi.${desc ? ' Kaynak tanımı: ' + desc.slice(0, 220) : ' Bu depoda doğrudan çalıştırılabilir bir Python komut satırı akışı bulunamadı.'}`;
  }

  let examplePreview = null;
  if (firstJob && defaults) {
    const cmdStr = [...defaults.argvTemplate].join(' ');
    examplePreview = {
      origin: 'source_example',
      badge: 'Kaynak yapısına dayalı açıklayıcı örnek — henüz gerçek çalıştırma yapılmadı',
      given: defaults.inputA.trim(),
      expectedKind: `Komut: ${cmdStr}\nBeklenen etki: ${firstJob.output}\nSonraki doğal adım: ${firstJob.consumer}`,
      note: 'Bu kutu aracın ne alıp ne ürettiğini kod çalıştırmadan önce hızlıca göstermek içindir. Gerçek süreç çıktısını görmek için aşağıdaki 3 ve 4. adımda A / B girdilerini çalıştırın.',
    };
  }

  return {
    whoAndWhat,
    intentConnection: intentFit.explanation,
    intentFit,
    rawDescription: desc.slice(0, 300),
    modelStatus: 'Model hesabı kullanılmadı — açıklama, komut şeması ve iş akışı doğrudan kaynak kod AST kanıtlarından üretildi.',
    examplePreview,
  };
}

function decorateJobForUi(job) {
  const defaults = buildTrialDefaults(job);
  const spec = job.flowSpec || {};
  const prod = spec.producer || {};
  const cons = spec.consumer || {};
  const isNatural = Boolean(cons.isNaturalRepoConsumer);
  const cmdDisplay = spec.subcommand ? `${spec.cli} ${spec.subcommand}` : (spec.cli || 'cli');

  const boxes = [
    {
      step: 1,
      role: 'trigger',
      title: '1. Başlangıç ve Girdi',
      detail: `Kullanıcı \`${cmdDisplay}\` komutuna örnek girdi verir (${spec.entrypoint?.path || 'giriş'}:${spec.entrypoint?.line || 1}).`,
      originBadge: 'Kaynakta görülen',
    },
    {
      step: 2,
      role: 'producer',
      title: `2. Üretici Adım: ${prod.qualname || job.title}`,
      detail: `\`${prod.module}.${prod.qualname}\` çalışır ve \`${(prod.variables || ['çıktı']).join(', ')}\` ara değerini üretir (${prod.path}:${prod.line}).`,
      originBadge: 'Kaynakta görülen',
    },
    {
      step: 3,
      role: 'handoff',
      title: '3. Ara Çıktı Devri',
      detail: `Üretilen \`${(cons.variables || prod.variables || ['değer']).join(', ')}\` nesnesi aynı süreç içinde sonraki adıma aktarılır (${spec.orchestrator?.path || prod.path}:${cons.callLine || prod.callLine}).`,
      originBadge: 'Kaynakta görülen',
    },
    {
      step: 4,
      role: 'consumer',
      title: isNatural
        ? `4. Doğal Tüketici: ${cons.qualname}`
        : `4. Çıktı Yazıcı: ${cons.qualname}`,
      detail: isNatural
        ? `Deponun kendi sonraki adımı olan \`${cons.module}.${cons.qualname}\` ara çıktıyı doğrudan parametre olarak alır (${cons.path}:${cons.line}).`
        : `Ara çıktı deponun başka bir iç işlevine girmeden doğrudan \`${cons.qualname}\` ile standart çıktıya yazılır (ayrı iç tüketici yok).`,
      originBadge: isNatural ? 'Kaynakta görülen (Denemede doğrulanacak)' : 'Kaynakta görülen (Yalnız çıktı akışı)',
    },
  ];

  return {
    id: job.id,
    origin: job.origin || 'source',
    originLabel: job.origin === 'model' ? 'Modelin çıkarımı' : 'Kaynakta görülen',
    pipelineOrigin: 'natural_repo_flow',
    title: job.title,
    summary: job.summary,
    trigger: job.trigger,
    input: job.input,
    output: job.output,
    consumer: job.consumer,
    isNaturalRepoConsumer: isNatural,
    boxes,
    evidence: job.evidence || [],
    flowSpec: spec,
    trialDefaults: defaults,
  };
}

async function prepareDependenciesOnHost(dependencies, signal) {
  const rawDeps = (dependencies || [])
    .map(d => String(d).trim())
    .filter(Boolean);

  if (!rawDeps.length) {
    return {
      status: 'ready',
      mode: 'stdlib-only',
      summary: 'Ek dış paket bağımlılığı yok; yalnızca Python standart kütüphanesi ile çalışır.',
      wheels: [],
    };
  }

  for (const dep of rawDeps) {
    if (dep.startsWith('-') || /[\r\n\0]/.test(dep) || dep.length > 200) {
      return {
        status: 'blocked',
        mode: 'invalid-dependency-spec',
        summary: `Güvenli olmayan bağımlılık tanımı reddedildi: ${dep.slice(0, 60)}`,
        wheels: [],
      };
    }
  }

  const keyHash = sha256Text('v2-linux-cp314:' + JSON.stringify([...rawDeps].sort())).slice(0, 16);
  const targetDir = path.join(WHEEL_CACHE_ROOT, keyHash);
  await fsp.mkdir(targetDir, { recursive: true });

  // Evaluate PEP 508 markers against target Linux WSL Python 3.14 environment BEFORE invoking pip download,
  // and allow modern PEP 600 manylinux_2_28 / manylinux_2_17 / manylinux2014 + pure-Python `any` binary wheels!
  const inspectScript = `
import hashlib, json, os, subprocess, sys, zipfile
from email.parser import Parser

target_dir = sys.argv[1]
raw_deps = json.loads(sys.argv[2])

linux_env = {
    'python_version': '3.14',
    'python_full_version': '3.14.4',
    'os_name': 'posix',
    'sys_platform': 'linux',
    'platform_release': '6.6.0',
    'platform_system': 'Linux',
    'platform_version': '#1 SMP',
    'platform_machine': 'x86_64',
    'platform_python_implementation': 'CPython',
    'implementation_name': 'cpython',
    'implementation_version': '3.14.4',
    'extra': '',
}

filtered_deps = []
try:
    from packaging.requirements import Requirement
    for raw in raw_deps:
        try:
            req = Requirement(raw)
        except Exception as exc:
            print(json.dumps({'ok': False, 'reason': f'Bağımlılık tanımı ayrıştırılamadı: {raw}', 'detail': str(exc)}))
            sys.exit(0)
        if req.url:
            print(json.dumps({'ok': False, 'reason': f'Doğrudan URL bağımlılığı güvenlik gereği reddedildi: {req.name}', 'detail': raw}))
            sys.exit(0)
        if req.marker and not req.marker.evaluate(linux_env):
            continue
        clean_spec = req.name + (f"[{','.join(sorted(req.extras))}]" if req.extras else '') + str(req.specifier)
        filtered_deps.append(clean_spec)
except ImportError:
    for raw in raw_deps:
        if 'extra ==' in raw or 'extra==' in raw:
            continue
        if 'win32' in raw and 'linux' not in raw and '!=' not in raw:
            continue
        filtered_deps.append(raw.split(';', 1)[0].strip())

if not filtered_deps:
    print(json.dumps({'ok': True, 'wheels': [], 'filteredEmpty': True}))
    sys.exit(0)

existing = [f for f in os.listdir(target_dir) if f.endswith('.whl')]
if not existing:
    cmd = [
        sys.executable, '-m', 'pip', 'download',
        '--only-binary=:all:',
        '--platform', 'manylinux_2_28_x86_64',
        '--platform', 'manylinux_2_17_x86_64',
        '--platform', 'manylinux2014_x86_64',
        '--platform', 'any',
        '--implementation', 'cp',
        '--python-version', '3.14',
        '--abi', 'cp314',
        '--abi', 'abi3',
        '--abi', 'none',
        '--dest', target_dir,
        '--disable-pip-version-check',
        '--no-input',
        '--',
        *filtered_deps,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=55)
    if proc.returncode != 0:
        print(json.dumps({
            'ok': False,
            'reason': 'Uyumlu ikili (.whl) paket indirilemedi (kaynak derlemesi güvenlik gereği kapalıdır).',
            'detail': (proc.stderr or proc.stdout)[-700:],
        }))
        sys.exit(0)

wheels = []
for fname in sorted(os.listdir(target_dir)):
    if not fname.endswith('.whl'):
        continue
    fpath = os.path.join(target_dir, fname)
    raw = open(fpath, 'rb').read()
    sha = hashlib.sha256(raw).hexdigest()
    pkg_name, pkg_ver, pkg_lic = fname.split('-')[0], '', 'Belirtilmemiş'
    with zipfile.ZipFile(fpath) as zf:
        for m in zf.namelist():
            if m.endswith('.dist-info/METADATA'):
                meta_txt = zf.read(m).decode('utf-8', 'replace')
                headers = Parser().parsestr(meta_txt)
                pkg_name = headers.get('Name') or pkg_name
                pkg_ver = headers.get('Version') or pkg_ver
                pkg_lic = headers.get('License-Expression') or headers.get('License') or pkg_lic
                if pkg_lic:
                    pkg_lic = pkg_lic.splitlines()[0].strip()
                if not pkg_lic or pkg_lic == 'Belirtilmemiş':
                    classifiers = [c for c in headers.get_all('Classifier', []) if 'License ::' in c]
                    if classifiers:
                        pkg_lic = classifiers[0].split('::')[-1].strip()
                break
    wheels.append({
        'filename': fname,
        'name': pkg_name,
        'version': pkg_ver,
        'license': (pkg_lic or 'Belirtilmemiş')[:160],
        'sizeBytes': len(raw),
        'sha256': sha,
        'hostPath': fpath,
    })

print(json.dumps({'ok': True, 'wheels': wheels}))
`;

  const { stdout } = await runHostPython(['-c', inspectScript, targetDir, JSON.stringify(rawDeps)], {
    site: true,
    timeout: 60000,
    signal,
  });
  const parsed = JSON.parse(stdout.trim());
  if (!parsed.ok) {
    return {
      status: 'blocked',
      mode: 'wheel-unavailable',
      summary: parsed.reason,
      detail: parsed.detail || '',
      wheels: [],
    };
  }
  if (!parsed.wheels.length) {
    return {
      status: 'ready',
      mode: 'stdlib-only-linux',
      summary: 'Linux hedef ortamı için ek dış paket gerekmiyor (koşullu bağımlılıklar süzüldü); standart kütüphane ile çalışır.',
      wheels: [],
    };
  }
  return {
    status: 'ready',
    mode: 'verified-wheels',
    summary: `${parsed.wheels.length} ikili bağımlılık paketi (.whl) ayrı aşamada doğrulandı ve SHA-256 özetleri kilitlendi (${parsed.wheels.map(w => `${w.name} ${w.version}`).slice(0, 4).join(', ')}${parsed.wheels.length > 4 ? '…' : ''}); çalıştırma aşamasında ağ kapalı kalır.`,
    wheels: parsed.wheels,
  };
}

let activeWslRun = false;

const TINY_WSL_BOOTSTRAP = 'import json,sys;d=json.loads(sys.stdin.read());ns={"__name__":"__loader__"};exec(compile(d["supervisor"],"<lab_yalitim>","exec"),ns);ns["main"](d["payload"])';

async function invokeWslSandbox(payload, signal) {
  requireCond(!activeWslRun, 429, 'Başka bir yalıtılmış WSL denemesi çalışıyor; tamamlandığında tekrar deneyin.');
  activeWslRun = true;
  try {
    return await new Promise((resolve, reject) => {
      const onWindows = process.platform === 'win32';
      const localArgs = ['/usr/bin/python3', '-I', '-B', '-S', '-c', TINY_WSL_BOOTSTRAP];
      const command = onWindows ? WSL : '/usr/bin/env';
      const args = onWindows
        ? ['-d', 'Ubuntu', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin', 'LANG=C.UTF-8', ...localArgs]
        : ['-i', 'PATH=/usr/bin', 'LANG=C.UTF-8', ...localArgs];

      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: onWindows ? 'C:\\Windows\\System32' : '/',
        env: onWindows ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' } : {},
      });

      const out = [];
      const err = [];
      let bytes = 0;
      let done = false;
      const finish = (e, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (e) reject(e);
        else resolve(val);
      };
      const onAbort = () => {
        child.kill();
        finish(httpError(408, 'Yalıtılmış çalıştırma iptal edildi.'));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(httpError(504, 'WSL2 yalıtılmış çalıştırma süre sınırını aştı.'));
      }, 22000);
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', b => {
        bytes += b.length;
        if (bytes > 2 * 1024 * 1024) {
          child.kill();
          finish(httpError(502, 'Yalıtılmış süreç çıktısı boyut sınırını aştı.'));
        } else out.push(b);
      });
      child.stderr.on('data', b => {
        if (err.length < 24) err.push(b);
      });
      child.stdin.on('error', () => {});
      child.on('error', () => finish(httpError(503, 'WSL2 Ubuntu yalıtım ortamına erişilemedi.')));
      child.on('close', code => {
        const stdout = Buffer.concat(out).toString('utf8').trim();
        const stderr = Buffer.concat(err).toString('utf8').trim();
        if (!stdout) {
          return finish(httpError(503, `Yalıtım denetçisi yanıt üretmedi (kod ${code}).`, { stderr: stderr.slice(-600) }));
        }
        try {
          const lastLine = stdout.split(/\r?\n/).filter(Boolean).at(-1);
          finish(null, JSON.parse(lastLine));
        } catch {
          finish(httpError(502, 'Yalıtım denetçisi geçersiz JSON döndürdü.'));
        }
      });

      child.stdin.end(JSON.stringify({
        supervisor: SUPERVISOR_CODE,
        payload: JSON.stringify(payload),
      }));
    });
  } finally {
    activeWslRun = false;
  }
}

function summarizeFsChanges(fsDiff, inputFileName) {
  if (!fsDiff) return [];
  const items = [];
  for (const c of fsDiff.created || []) {
    if (c.path === inputFileName) continue;
    items.push({ kind: 'oluşturuldu', path: c.path, bytes: c.bytes, preview: (c.preview || '').slice(0, 240) });
  }
  for (const m of fsDiff.modified || []) {
    items.push({ kind: 'değiştirildi', path: m.path, bytes: m.bytes, preview: (m.preview || '').slice(0, 240) });
  }
  for (const d of fsDiff.deleted || []) {
    items.push({ kind: 'silindi', path: d, bytes: 0, preview: '' });
  }
  return items;
}

function summarizeRunOutcome(runRecord, job) {
  const trace = runRecord.trace || {};
  const exitOk = runRecord.exitCode === 0;
  let consumerVerdict = '';
  let consumerBadge = '';

  if (trace.status === 'verified_natural_consumer') {
    consumerBadge = 'Bu denemede doğrulandı';
    consumerVerdict = `Aynı koşuda (${runRecord.runId.slice(0, 8)}) \`${job.flowSpec.producer.qualname}\` işlevinin ürettiği ara çıktının nesne kimliği (objectId=${trace.producerReturn?.objectId}) ve SHA-256 özeti (${trace.producerReturn?.sha256?.slice(0, 12)}…), deponun kendi doğal sonraki adımı olan \`${job.flowSpec.consumer.qualname}\` işlevinin \`${trace.matchedArgName}\` parametresinde birebir yakalandı (kimlik eşleşmesi: ${trace.identityMatch ? 'EVET' : 'HAYIR'}, değer eşleşmesi: ${trace.valueMatch ? 'EVET' : 'HAYIR'}).`;
  } else if (trace.status === 'mismatch_or_stale') {
    consumerBadge = 'Doğrulanamadı — Uyuşmazlık / Bayat Değer';
    consumerVerdict = `Üretici ara çıktı üretti (${trace.producerReturn?.sha256?.slice(0, 12)}…), ancak tüketici \`${job.flowSpec.consumer.qualname}\` farklı veya bayat bir değer (${trace.consumerReceived?.sha256?.slice(0, 12)}…) aldı! Ürün bu ilişkiyi doğrulanmış saymaz.`;
  } else if (trace.status === 'producer_only_runtime_sink') {
    consumerBadge = 'Yalnız çalışma zamanı çıktısı (iç doğal tüketici yok)';
    consumerVerdict = `Üretici \`${job.flowSpec.producer.qualname}\` ara değeri üretti (${trace.producerReturn?.sha256?.slice(0, 12)}…) ve doğrudan standart çıktıya yazıldı; depoda ayrı bir iç tüketici işlev bulunmuyor.`;
  } else {
    consumerBadge = 'Girdi işlendi; seçili yan biçimlendirici bu koşuda gerekmedi';
    consumerVerdict = exitOk
      ? 'Komut hatasız (çıkış kodu: 0) tamamlandı; girdi geçerli olduğu için rapor/uyarı üretici alt işlevi çağrılmadı.'
      : 'Komut uyarı/hata koduyla tamamlandı ve seçili yan biçimlendirici yerine varsayılan çıktı dalı çalıştı.';
  }

  const fileChanges = summarizeFsChanges(runRecord.fsDiff, runRecord.inputFileName);
  let outputDisplay = runRecord.stdout || '';
  if (!outputDisplay && fileChanges.length > 0) {
    outputDisplay = fileChanges
      .map(f => `[Dosya ${f.kind}: ${f.path} (${f.bytes} bayt)]${f.preview ? '\n' + f.preview : ''}`)
      .join('\n\n');
  } else if (!outputDisplay && runRecord.stderr) {
    outputDisplay = `[Standart hata / uyarı çıktısı]:\n${runRecord.stderr}`;
  } else if (!outputDisplay) {
    outputDisplay = '(Standart çıktı boş; çıkış kodu: ' + runRecord.exitCode + ')';
  }

  return {
    given: runRecord.inputText,
    prediction: runRecord.prediction || '',
    output: outputDisplay,
    stderr: runRecord.stderr || '',
    fileChanges,
    exitCode: runRecord.exitCode,
    consumerBadge,
    consumerVerdict,
    whereUsed: job.trialDefaults?.usageHint || job.consumer,
  };
}

function normalizeLineWhitespace(line) {
  return line.replace(/\s+/g, ' ').trim();
}

function isPureBorderSeparatorLine(line) {
  return /^[-=+*|:_\s]+$/.test(line.trim());
}

function buildAbComparison(runA, runB, job) {
  if (!runA || !runB) return null;
  const outA = runA.stdout || '';
  const outB = runB.stdout || '';
  const linesA = outA.split(/\r?\n/).filter(l => l.trim().length > 0);
  const linesB = outB.split(/\r?\n/).filter(l => l.trim().length > 0);

  // Ignore pure table-padding whitespace shifts and pure ASCII border lines so we highlight real content changes first!
  const normSetA = new Set(linesA.map(normalizeLineWhitespace));
  const normSetB = new Set(linesB.map(normalizeLineWhitespace));
  const semanticAddedInB = linesB
    .filter(l => !isPureBorderSeparatorLine(l) && !normSetA.has(normalizeLineWhitespace(l)))
    .slice(0, 8);
  const semanticRemovedFromA = linesA
    .filter(l => !isPureBorderSeparatorLine(l) && !normSetB.has(normalizeLineWhitespace(l)))
    .slice(0, 8);
  const exactAddedInB = linesB.filter(l => !linesA.includes(l)).slice(0, 8);

  const addedInB = semanticAddedInB.length ? semanticAddedInB : exactAddedInB;
  const removedFromA = semanticRemovedFromA;

  const filesA = summarizeFsChanges(runA.fsDiff, runA.inputFileName);
  const filesB = summarizeFsChanges(runB.fsDiff, runB.inputFileName);
  const filesChanged = JSON.stringify(filesA) !== JSON.stringify(filesB);

  const prodHashA = runA.trace?.producerReturn?.sha256 || null;
  const prodHashB = runB.trace?.producerReturn?.sha256 || null;
  const intermediateChanged = Boolean(prodHashA && prodHashB && prodHashA !== prodHashB);

  let changedSummary = '';
  if (outA === outB && !filesChanged && runA.exitCode === runB.exitCode) {
    changedSummary = 'A ve B girdileri aynı süreç çıktısını ve dosya durumunu üretti; gözlenen sonuç değişmedi.';
  } else {
    const parts = [];
    if (runA.exitCode !== runB.exitCode) {
      parts.push(`Çıkış kodu ${runA.exitCode} iken ${runB.exitCode} oldu.`);
    }
    if (outA !== outB) {
      parts.push(`Standart çıktı ${outA.length} karakterden (${linesA.length} dolu satır) ${outB.length} karaktere (${linesB.length} dolu satır) değişti.`);
    }
    if (filesChanged) {
      parts.push(`Deney klasöründe oluşan/değişen dosya sayısı A’da ${filesA.length}, B’de ${filesB.length} oldu.`);
    }
    if (intermediateChanged) {
      parts.push(`Üreticinin doğal tüketiciye devrettiği ara çıktının SHA-256 özeti değişti (${prodHashA.slice(0, 10)}… → ${prodHashB.slice(0, 10)}…) ve her iki koşuda da doğal tüketici kendi koşusundaki güncel değeri aldı.`);
    }
    if (addedInB.length) {
      parts.push(`B çıktısında yeni/değişen anlamlı satır: "${addedInB[0].trim().slice(0, 120)}"`);
    }
    changedSummary = parts.join(' ');
  }

  return {
    jobId: job.id,
    runAId: runA.runId,
    runBId: runB.runId,
    givenA: runA.inputText,
    givenB: runB.inputText,
    outputA: runA.explanation?.output || outA,
    outputB: runB.explanation?.output || outB,
    exitCodeA: runA.exitCode,
    exitCodeB: runB.exitCode,
    outputChanged: outA !== outB || filesChanged || runA.exitCode !== runB.exitCode,
    intermediateChanged,
    addedInB,
    removedFromA,
    changedSummary,
    purposeAndUsage: job.trialDefaults?.usageHint || job.consumer,
  };
}

function collectAllSessionRuns(sessionState) {
  const archived = Array.isArray(sessionState?.archivedRuns)
    ? sessionState.archivedRuns.flatMap(g => Array.isArray(g?.preservedRuns) ? g.preservedRuns : [])
    : [];
  const active = Array.isArray(sessionState?.runs) ? sessionState.runs : [];
  return [...archived, ...active];
}

function buildSanitizedExportBundle(state) {
  const scrub = val => typeof val === 'string' ? val.replace(CREDENTIAL_LIKE, '[GIZLI_VERI_TEMIZLENDI]') : val;
  const allRuns = collectAllSessionRuns(state).map(r => ({
    runId: r.runId,
    slot: r.slot,
    jobId: r.jobId,
    createdAt: r.createdAt,
    isCleanRerunOf: r.isCleanRerunOf || null,
    argv: r.argv,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    inputText: scrub(r.inputText),
    stdout: scrub(r.stdout),
    stderr: scrub(r.stderr),
    stdoutSha256: r.stdoutSha256,
    sourceEvidenceSha256: r.sourceEvidenceSha256,
    verifiedWheels: r.verifiedWheels,
    fsDiff: r.fsDiff,
    trace: r.trace,
    boundary: r.boundary,
  }));

  return {
    schema: 'urun-tani-kanit-ozeti/v2',
    exportedAt: new Date().toISOString(),
    carriesExecutionPermission: false,
    securityNotice: 'Bu dışa aktarılan kayıt yalnızca inceleme ve deney kanıtı taşır; hiçbir çalıştırma izni devretmez.',
    repository: state.repository,
    url: state.url,
    branch: state.branch,
    commitSha: state.commitSha,
    archiveSha256: state.archiveSha256,
    sourceEvidenceSha256: state.sourceEvidenceSha256,
    intent: scrub(state.intent),
    intentFit: state.overview?.intentFit || null,
    supported: state.supported,
    supportInfo: state.supportInfo,
    limitations: state.limitations,
    selectedJobId: state.selectedJobId,
    dependencies: state.dependencyPrep?.wheels || [],
    totalRuns: allRuns.length,
    runs: allRuns,
    abComparison: state.abComparison || state.archivedRuns?.findLast?.(g => g.preservedAbComparison)?.preservedAbComparison || null,
    cleanReruns: state.cleanReruns || [],
  };
}

function createRepoStorage(baseDataDir) {
  const repoDir = path.join(path.resolve(baseDataDir), 'depo-kayitlari');
  const storageErr = () => httpError(503, 'Depo laboratuvarı kayıt klasörüne erişilemedi.');

  async function ensureDir(create) {
    try {
      if (create) await fsp.mkdir(repoDir, { recursive: true });
      const st = await fsp.lstat(repoDir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw storageErr();
      return true;
    } catch (e) {
      if (e.code === 'ENOENT' && !create) return false;
      throw storageErr();
    }
  }

  function validSavedRecord(rec, expectedId) {
    return isObject(rec) &&
      rec.schemaVersion === 2 &&
      rec.id === expectedId &&
      typeof rec.name === 'string' && rec.name.length > 0 && rec.name.length <= 120 &&
      typeof rec.savedAt === 'string' &&
      isObject(rec.snapshot) &&
      typeof rec.snapshot.repository === 'string' &&
      typeof rec.snapshot.commitSha === 'string' &&
      typeof rec.snapshot.sourceEvidenceSha256 === 'string' &&
      isObject(rec.sessionState);
  }

  async function list() {
    if (!await ensureDir(false)) return [];
    const entries = await fsp.readdir(repoDir, { withFileTypes: true });
    const items = [];
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const id = ent.name.slice(0, -5);
      if (!isUuid(id)) continue;
      try {
        const dst = path.join(repoDir, ent.name);
        const st = await fsp.lstat(dst);
        if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_RECORD_BYTES) continue;
        const raw = await fsp.readFile(dst, 'utf8');
        const rec = JSON.parse(raw);
        if (!validSavedRecord(rec, id)) continue;
        const allRuns = collectAllSessionRuns(rec.sessionState);
        items.push({
          id: rec.id,
          kind: 'github-repo',
          schemaVersion: 2,
          name: rec.name,
          repository: rec.snapshot.repository,
          commitSha: rec.snapshot.commitSha,
          intent: rec.snapshot.intent,
          savedAt: rec.savedAt,
          supported: Boolean(rec.sessionState.supported),
          runCount: allRuns.length,
        });
      } catch {
        // Ignore corrupted file without crashing listing
      }
    }
    items.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
    return items.slice(0, MAX_SAVED);
  }

  async function write(record) {
    await ensureDir(true);
    const existing = await list();
    requireCond(existing.length < MAX_SAVED, 409, 'Depo kayıt sınırı doldu.');
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    requireCond(bytes.length <= MAX_RECORD_BYTES, 413, 'Bu inceleme kaydı boyut sınırını aşıyor.');
    const tmp = path.join(repoDir, `.${record.id}.tmp`);
    const dst = path.join(repoDir, `${record.id}.json`);
    await fsp.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await fsp.rename(tmp, dst);
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
  }

  async function read(id) {
    requireCond(isUuid(id), 400, 'Geçersiz kayıt kimliği.');
    if (!await ensureDir(false)) return null;
    const dst = path.join(repoDir, `${id}.json`);
    try {
      const st = await fsp.lstat(dst);
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_RECORD_BYTES) return null;
      const rec = JSON.parse(await fsp.readFile(dst, 'utf8'));
      return validSavedRecord(rec, id) ? rec : null;
    } catch {
      return null;
    }
  }

  async function remove(id) {
    requireCond(isUuid(id), 400, 'Geçersiz kayıt kimliği.');
    if (!await ensureDir(false)) throw httpError(404, 'Silinecek kayıt bulunamadı.');
    const dst = path.join(repoDir, `${id}.json`);
    try {
      const st = await fsp.lstat(dst);
      if (st.isSymbolicLink() || !st.isFile()) throw httpError(404, 'Silinecek kayıt bulunamadı.');
      await fsp.unlink(dst);
    } catch (e) {
      if (e.status) throw e;
      throw httpError(404, 'Silinecek kayıt bulunamadı.');
    }
  }

  return { list, write, read, remove, repoDir };
}

function publicStateView(session) {
  const { _pythonFiles, _preparedWheelFiles, ...rest } = session;
  return structuredClone(rest);
}

function createDepoLaboratuvar(options = {}) {
  const defaultDataDir = path.join(ROOT, '..', '.laboratuvar-kayitlari');
  const dataDir = options.dataDir ?? (process.env.URUN_TANI_LAB_DATA || defaultDataDir);
  const store = createRepoStorage(dataDir);
  const sessions = new Map();
  const customSourceLoader = options.sourceLoader || null;

  function sweepSessions() {
    const cutoff = Date.now() - SESSION_TTL;
    for (const [id, entry] of sessions) {
      if (!entry.busy && entry.touchedAt < cutoff) sessions.delete(id);
    }
  }

  function putSession(sessionState) {
    sweepSessions();
    if (sessions.size >= MAX_SESSIONS) {
      const idle = [...sessions.entries()].filter(([, v]) => !v.busy).sort((a, b) => a[1].touchedAt - b[1].touchedAt);
      requireCond(idle.length > 0, 429, 'Açık inceleme oturumları dolu; lütfen biraz sonra tekrar deneyin.');
      sessions.delete(idle[0][0]);
    }
    sessions.set(sessionState.id, { state: sessionState, busy: false, touchedAt: Date.now() });
    return sessionState;
  }

  async function inspectRepo(request, signal) {
    const url = sanitizeText(request.url, 300);
    const intent = sanitizeText(request.intent, MAX_INTENT_CHARS);
    requireCond(url.length > 0, 400, 'İncelenecek herkese açık GitHub deposunun bağlantısını girin.');
    requireCond(intent.length >= 2, 400, 'Neyi anlamak veya denemek istediğinizi kısaca yazın (en az 2 karakter).');

    let source;
    if (customSourceLoader && url.startsWith('https://github.com/yerel-test/')) {
      source = await customSourceLoader(url, signal);
    } else {
      source = await githubSource(url, signal);
    }

    const pyStatic = await analyzePythonStatic(source.python || [], signal);
    let reaSummary = null;
    let jsJobs = [];
    if ((!source.python || !source.python.length) && source.javascript?.length) {
      const rea = await require('./rea-kaynak.cjs').analyzeWithRea(source.javascript, signal, source.usage || []);
      if (rea.status === 'ok' && rea.jobs?.length) {
        jsJobs = rea.jobs.slice(0, 6).map(j => ({
          id: j.id,
          origin: 'source',
          originLabel: 'Kaynakta görülen (JS/TS REA statik keşfi)',
          pipelineOrigin: 'static_rea',
          title: j.title,
          summary: j.summary,
          trigger: j.trigger,
          input: 'Statik JS/TS keşfi (canlı WSL denemesi yalnızca Python CLI depoları içindir)',
          output: j.output,
          consumer: j.consumer,
          isNaturalRepoConsumer: false,
          boxes: [],
          evidence: j.evidence || [],
          flowSpec: null,
          trialDefaults: null,
        }));
        reaSummary = `REA statik çözümleyicisi ${rea.jobs.length} JavaScript/TypeScript işi buldu; ancak ilk canlı WSL laboratuvar kapsamı yalnızca Python CLI depoları içindir.`;
      } else {
        reaSummary = 'Depoda Python CLI girişi yok; JavaScript/TypeScript dosyaları statik olarak tarandı.';
      }
    }

    const rawDecorated = (pyStatic.jobs || []).map(decorateJobForUi);
    let supportInfo = pyStatic.pythonMeta?.support || {
      supported: false,
      code: 'UNSUPPORTED',
      reason: 'Bu depo desteklenen Python CLI kapsamında değil.',
      nextStep: 'Herkese açık bir Python CLI deposu seçin.',
    };
    if (source.pythonTruncated && supportInfo.supported) {
      supportInfo = {
        supported: false,
        code: 'PARTIAL_PYTHON_PACKAGE',
        reason: `Bu depoda ${source.pythonCandidateTotal} Python paket dosyası var; güvenlik ve bellek sınırı (2 MiB / 160 dosya) nedeniyle yalnızca ${source.pythonSelectedCount} dosya okundu. Eksik alt modüllerle yanıltıcı/yarım çalıştırma yapmamak için canlı deneme durduruldu.`,
        nextStep: 'Aşağıda keşfedilen gerçek iş akışını ve kod kanıtlarını statik olarak inceleyebilir veya tek odaklı bir Python CLI deposu deneyebilirsiniz.',
      };
    }
    const supported = Boolean(supportInfo.supported && rawDecorated.length > 0);
    const readmeText = (source.files || []).find(f => /readme/i.test(f.name))?.text || '';

    const { rankedJobs, intentFit } = evaluateIntentFitAndRankJobs(
      intent,
      rawDecorated,
      pyStatic.pythonMeta,
      readmeText,
      supported
    );
    const allJobs = rankedJobs.length ? rankedJobs : jsJobs;

    const sourceEvidenceSha256 = computeSourceEvidenceSha256(source.python || []);
    const overview = buildPlainTurkishOverview({
      repository: source.repository,
      intent,
      pythonMeta: pyStatic.pythonMeta,
      reaSummary,
      files: source.files || [],
      jobs: rankedJobs,
      intentFit,
    });

    const firstJob = rankedJobs[0] || null;
    const id = crypto.randomUUID();
    const sessionState = {
      id,
      revision: 0,
      createdAt: new Date().toISOString(),
      url,
      intent,
      repository: source.repository,
      branch: source.branch,
      commitSha: source.sha,
      archiveSha256: source.snapshot?.artifactSha256 || source.snapshot?.archiveSha256 || null,
      sourceEvidenceSha256,
      readFileCount: source.snapshot?.readCount || 0,
      totalEntryCount: source.snapshot?.fileCount || source.snapshot?.entryCount || 0,
      limitations: [...(source.limitations || []), ...(pyStatic.limitations || [])],
      supported,
      supportInfo,
      pythonMeta: {
        name: pyStatic.pythonMeta?.name || source.repository.split('/').pop(),
        version: pyStatic.pythonMeta?.version || '0.0.0',
        description: pyStatic.pythonMeta?.description || null,
        license: pyStatic.pythonMeta?.license || 'Kaynakta açık belirtilmedi',
        requiresPython: pyStatic.pythonMeta?.requiresPython || 'Belirtilmemiş',
        dependencies: pyStatic.pythonMeta?.dependencies || [],
        entrypoints: pyStatic.pythonMeta?.entrypoints || [],
      },
      overview,
      jobs: allJobs,
      selectedJobId: firstJob ? firstJob.id : (allJobs[0]?.id || null),
      draftInputs: firstJob
        ? { A: firstJob.trialDefaults.inputA, B: firstJob.trialDefaults.inputB }
        : { A: '', B: '' },
      draftFlags: firstJob ? [...firstJob.trialDefaults.discoveredFlags] : [],
      customFlags: firstJob ? [...firstJob.trialDefaults.discoveredFlags] : [],
      permission: {
        granted: false,
        approvedJobId: null,
        approvedCommitSha: null,
        approvedSourceSha256: null,
        approvedAt: null,
      },
      dependencyPrep: null,
      workspaceClean: true,
      runs: [],
      archivedRuns: [],
      abComparison: null,
      cleanReruns: [],
      resetCount: 0,
      reopenedFromRecordId: null,
      _pythonFiles: (source.python || []).filter(isMountableRepoSourceFile),
      _preparedWheelFiles: [],
    };

    putSession(sessionState);
    return {
      state: publicStateView(sessionState),
      supportedScope: SUPPORTED_SCOPE,
    };
  }

  async function withSession(request, fn) {
    requireCond(isUuid(request.id), 400, 'Geçerli bir inceleme oturumu kimliği gerekli.');
    requireCond(Number.isSafeInteger(request.revision) && request.revision >= 0, 400, 'Geçerli bir oturum sürümü (revision) gerekli.');
    sweepSessions();
    const entry = sessions.get(request.id);
    requireCond(entry, 404, 'Açık inceleme oturumu bulunamadı. Depoyu yeniden inceleyebilir veya kayıtlı çalışmayı açabilirsiniz.');
    requireCond(!entry.busy && entry.state.revision === request.revision, 409,
      'Oturum durumu değişmiş veya başka bir işlem sürüyor; ekranı güncelleyip tekrar deneyin.');
    entry.busy = true;
    try {
      const extra = await fn(entry.state);
      entry.state.revision++;
      entry.touchedAt = Date.now();
      return { state: publicStateView(entry.state), ...(extra || {}) };
    } finally {
      entry.busy = false;
      entry.touchedAt = Date.now();
    }
  }

  async function executeSlotRun(
    state,
    { slot, inputText, prediction = '', extraFlags, isCleanRerunOf = null, originalArgv = null, simulateStaleConsumer = false },
    signal
  ) {
    requireCond(state.supported, 422, `Bu depo canlı Python WSL yalıtımında çalıştırılamaz: ${state.supportInfo?.reason || 'Destek dışı.'}`);
    const job = state.jobs.find(j => j.id === state.selectedJobId);
    requireCond(job && job.flowSpec, 404, 'Çalıştırılacak doğrulanmış Python işi bulunamadı.');

    // Strict permission check: bound to THIS session (`state`), exact job, exact commit SHA, and exact source evidence hash!
    const perm = state.permission || {};
    requireCond(
      perm.granted === true &&
      perm.approvedJobId === job.id &&
      perm.approvedCommitSha === state.commitSha &&
      perm.approvedSourceSha256 === state.sourceEvidenceSha256,
      403,
      'Bu oturum, depo sürümü ve seçilen iş için henüz açık çalıştırma onayı verilmedi veya kaynak/iş değişti. Önce yalıtım kapsamını onaylayın.'
    );
    requireCond(state.dependencyPrep && state.dependencyPrep.status === 'ready', 409,
      `Bağımlılık hazırlığı tamamlanmadığı için çalıştırma durduruldu: ${state.dependencyPrep?.summary || 'Önce hazırlık aşamasını tamamlayın.'}`);
    requireCond(Array.isArray(state._pythonFiles) && state._pythonFiles.length > 0, 409,
      'Çalıştırılacak doğrulanmış kaynak dosyaları oturumda bulunamadı.');
    requireCond(state.runs.length < MAX_RUNS, 409, 'Bu oturumdaki deneme sayısı sınırına ulaşıldı; çalışma alanını sıfırlayın.');

    const cleanInput = typeof inputText === 'string' ? inputText.replace(/\0/g, '') : '';
    requireCond(cleanInput.length > 0 && cleanInput.length <= MAX_INPUT_CHARS, 400,
      `Deneme girdisi 1 ile ${MAX_INPUT_CHARS} karakter arasında olmalıdır.`);
    const cleanPrediction = sanitizeText(prediction, 240);

    const wheelPayloads = [];
    for (const w of state._preparedWheelFiles || []) {
      let raw;
      try {
        raw = await fsp.readFile(w.hostPath);
      } catch {
        throw httpError(409, `Hazırlanan bağımlılık paketi (${w.filename}) bulunamadı; çalıştırma durduruldu.`);
      }
      wheelPayloads.push({
        filename: w.filename,
        sha256: w.sha256,
        contentBase64: raw.toString('base64'),
      });
    }

    const defaults = job.trialDefaults;
    const runId = crypto.randomUUID();
    const workspaceFiles = {};
    if (defaults.inputMode === 'multi_positional_tokens') {
      // Seed a clean initial config file so subcommands like `set KEY VALUE` modify a valid starting file
      workspaceFiles[defaults.inputFileName] = defaults.sampleFormat === 'dotenv'
        ? 'BASLANGIC_MODU=hazir\n'
        : '';
    } else {
      workspaceFiles[defaults.inputFileName] = cleanInput;
    }
    const stdinText = defaults.inputMode === 'stdin' ? cleanInput : '';

    let argv;
    if (Array.isArray(originalArgv) && originalArgv.length > 0) {
      argv = [...originalArgv];
    } else {
      const chosenFlags = extraFlags !== undefined ? parseExtraFlags(extraFlags) : (state.customFlags || defaults.discoveredFlags || []);
      state.customFlags = chosenFlags;
      state.draftFlags = chosenFlags;
      const groupPrefix = defaults.groupFileFlag ? [job.flowSpec.cli, defaults.groupFileFlag, defaults.inputFileName] : [job.flowSpec.cli];
      const baseCmd = defaults.subcommand ? [...groupPrefix, defaults.subcommand] : groupPrefix;
      if (defaults.inputMode === 'stdin') {
        argv = [...baseCmd, ...chosenFlags];
      } else if (defaults.inputMode === 'multi_positional_tokens') {
        const toks = cleanInput.trim().split(/\s+/).filter(Boolean).slice(0, Math.max(2, defaults.requiredPosCount || 2));
        while (toks.length < (defaults.requiredPosCount || 2)) toks.push('deger');
        argv = [...baseCmd, ...chosenFlags, ...toks];
      } else if (defaults.inputMode === 'positional_text') {
        argv = [...baseCmd, ...chosenFlags, cleanInput.trim().slice(0, 500)];
      } else {
        argv = defaults.groupFileFlag ? [...baseCmd, ...chosenFlags] : [...baseCmd, ...chosenFlags, defaults.inputFileName];
      }
    }

    const wslPayload = {
      expectedSourceSha256: state.sourceEvidenceSha256,
      sourceFiles: state._pythonFiles,
      packageMeta: {
        name: state.pythonMeta?.name,
        version: state.pythonMeta?.version,
        description: state.pythonMeta?.description,
        entrypoints: state.pythonMeta?.entrypoints,
      },
      wheels: wheelPayloads,
      timeoutSec: 12,
      spec: {
        runId,
        entrypoint: {
          module: job.flowSpec.entrypoint.module,
          callable: job.flowSpec.entrypoint.callable,
        },
        argv,
        stdinText,
        workspaceFiles,
        simulateStaleConsumer: Boolean(simulateStaleConsumer),
        trace: {
          producerModule: job.flowSpec.producer.module,
          producerQualname: job.flowSpec.producer.qualname,
          consumerModule: job.flowSpec.consumer.module,
          consumerQualname: job.flowSpec.consumer.qualname,
          isNaturalRepoConsumer: Boolean(job.flowSpec.consumer.isNaturalRepoConsumer),
        },
      },
    };

    const sandboxRes = await invokeWslSandbox(wslPayload, signal);
    if (!sandboxRes.ok) {
      throw httpError(409, sandboxRes.message || 'Yalıtılmış çalıştırma güvenlik kontrolü tarafından durduruldu.', {
        errorCode: sandboxRes.errorCode || 'SANDBOX_HALTED',
      });
    }

    const runRecord = {
      runId,
      slot,
      jobId: job.id,
      createdAt: new Date().toISOString(),
      isCleanRerunOf,
      retryOf: isCleanRerunOf,
      prediction: cleanPrediction,
      extraFlags: state.customFlags || [],
      inputText: cleanInput,
      inputFileName: defaults.inputFileName,
      argv,
      exitCode: sandboxRes.exitCode,
      durationMs: sandboxRes.durationMs,
      stdout: sandboxRes.stdout,
      stderr: sandboxRes.stderr,
      runtimeError: sandboxRes.runtimeError,
      stdoutSha256: sha256Text(sandboxRes.stdout || ''),
      sourceEvidenceSha256: sandboxRes.sourceEvidenceSha256,
      verifiedWheels: sandboxRes.verifiedWheels || [],
      boundary: sandboxRes.boundary,
      sandboxSpec: sandboxRes.sandboxSpec,
      fsDiff: sandboxRes.fsDiff,
      trace: sandboxRes.trace,
    };
    runRecord.explanation = summarizeRunOutcome(runRecord, job);

    state.workspaceClean = false;
    state.runs.push(runRecord);
    if ((slot === 'A' || slot === 'B') && !isCleanRerunOf) {
      state.draftInputs[slot] = cleanInput;
    }

    // Recompute A/B comparison across active runs first, falling back to archived slot counterpart if only one slot ran since reset!
    const combinedRuns = collectAllSessionRuns(state);
    const latestActiveA = [...state.runs].reverse().find(r => r.slot === 'A' && r.jobId === job.id && !r.isCleanRerunOf);
    const latestActiveB = [...state.runs].reverse().find(r => r.slot === 'B' && r.jobId === job.id && !r.isCleanRerunOf);
    const anyLatestA = latestActiveA || [...combinedRuns].reverse().find(r => r.slot === 'A' && r.jobId === job.id && !r.isCleanRerunOf);
    const anyLatestB = latestActiveB || [...combinedRuns].reverse().find(r => r.slot === 'B' && r.jobId === job.id && !r.isCleanRerunOf);
    if (anyLatestA && anyLatestB) {
      state.abComparison = buildAbComparison(anyLatestA, anyLatestB, job);
    }

    return runRecord;
  }

  async function get() {
    const saved = await store.list();
    return {
      saved,
      supportedScope: SUPPORTED_SCOPE,
    };
  }

  async function post(request, signal = AbortSignal.timeout(85000)) {
    requireCond(isObject(request) && typeof request.action === 'string', 400, 'Geçerli bir depo laboratuvarı isteği gönderin.');
    const { action } = request;

    if (action === 'inspect') {
      return inspectRepo(request, signal);
    }

    if (action === 'open') {
      const rec = await store.read(request.recordId);
      requireCond(rec, 404, 'Seçilen depo inceleme kaydı bulunamadı veya bozulmuş.');
      const savedSession = structuredClone(rec.sessionState);
      const pyFiles = Array.isArray(rec.bundledPythonFiles) ? rec.bundledPythonFiles : [];
      const computedSha = computeSourceEvidenceSha256(pyFiles);
      const sourceVerified = pyFiles.length > 0 && computedSha === rec.snapshot.sourceEvidenceSha256;

      savedSession.id = crypto.randomUUID();
      savedSession.revision = 0;
      savedSession.reopenedFromRecordId = rec.id;
      savedSession.reopenedRecordName = rec.name;
      savedSession.reopenedSourceVerified = sourceVerified;
      savedSession._pythonFiles = sourceVerified ? pyFiles : [];
      savedSession._preparedWheelFiles = [];
      // Re-opening a saved record NEVER auto-grants execution permission (`permission.granted = false`),
      // while preserving 100% of past runs, archived runs, A/B comparisons, and clean rerun proofs!
      savedSession.permission = {
        granted: false,
        approvedJobId: null,
        approvedCommitSha: null,
        approvedSourceSha256: null,
        approvedAt: null,
      };
      putSession(savedSession);
      return {
        state: publicStateView(savedSession),
        reopenedRecord: {
          id: rec.id,
          name: rec.name,
          savedAt: rec.savedAt,
          sourceVerified,
        },
        supportedScope: SUPPORTED_SCOPE,
      };
    }

    if (action === 'deleteRecord') {
      await store.remove(request.recordId);
      const saved = await store.list();
      return { deletedRecordId: request.recordId, saved };
    }

    if (action === 'exportReport') {
      if (request.recordId !== undefined) {
        const rec = await store.read(request.recordId);
        requireCond(rec, 404, 'Dışa aktarılacak kayıt bulunamadı.');
        const bundle = buildSanitizedExportBundle(rec.sessionState);
        return { report: bundle, exportBundle: bundle };
      }
      requireCond(isUuid(request.id), 400, 'Geçerli bir oturum veya kayıt kimliği gerekli.');
      sweepSessions();
      const entry = sessions.get(request.id);
      requireCond(entry, 404, 'Açık inceleme oturumu bulunamadı.');
      const bundle = buildSanitizedExportBundle(entry.state);
      return { report: bundle, exportBundle: bundle };
    }

    if (action === 'selectJob') {
      return withSession(request, async state => {
        const job = state.jobs.find(j => j.id === request.jobId);
        requireCond(job, 404, 'Seçilen iş bu depoda bulunamadı.');
        state.selectedJobId = job.id;
        if (job.trialDefaults) {
          state.draftInputs = {
            A: job.trialDefaults.inputA,
            B: job.trialDefaults.inputB,
          };
          state.draftFlags = [...(job.trialDefaults.discoveredFlags || [])];
          state.customFlags = [...(job.trialDefaults.discoveredFlags || [])];
        }
        state.permission = {
          granted: false,
          approvedJobId: null,
          approvedCommitSha: null,
          approvedSourceSha256: null,
          approvedAt: null,
        };
        const combinedRuns = collectAllSessionRuns(state);
        const prevA = [...combinedRuns].reverse().find(r => r.slot === 'A' && r.jobId === job.id && !r.isCleanRerunOf);
        const prevB = [...combinedRuns].reverse().find(r => r.slot === 'B' && r.jobId === job.id && !r.isCleanRerunOf);
        state.abComparison = (prevA && prevB) ? buildAbComparison(prevA, prevB, job) : null;
      });
    }

    if (action === 'prepareAndApprove') {
      return withSession(request, async state => {
        requireCond(state.supported, 422, `Bu depo canlı çalıştırma kapsamı dışındadır: ${state.supportInfo?.reason || ''}`);
        const job = state.jobs.find(j => j.id === state.selectedJobId);
        requireCond(job && job.flowSpec, 404, 'Onaylanacak geçerli bir Python işi seçin.');
        requireCond(request.expectedCommitSha === undefined || request.expectedCommitSha === state.commitSha, 409,
          'Onaylanmak istenen commit özeti oturumdaki kaynakla eşleşmiyor.');
        requireCond(request.expectedJobId === undefined || request.expectedJobId === job.id, 409,
          'Onaylanmak istenen iş kimliği seçili işle eşleşmiyor.');

        const actualSourceSha = computeSourceEvidenceSha256(state._pythonFiles || []);
        requireCond(actualSourceSha === state.sourceEvidenceSha256, 409,
          'Kaynak dosyalarının özeti incelenen sürümle eşleşmedi; çalıştırma izni verilmedi.');

        const prep = await prepareDependenciesOnHost(state.pythonMeta.dependencies, signal);
        state.dependencyPrep = {
          status: prep.status,
          mode: prep.mode,
          summary: prep.summary,
          detail: prep.detail || '',
          wheels: prep.wheels.map(({ hostPath, ...pub }) => pub),
        };
        state._preparedWheelFiles = prep.wheels;

        if (prep.status !== 'ready') {
          state.permission = {
            granted: false,
            approvedJobId: null,
            approvedCommitSha: null,
            approvedSourceSha256: null,
            approvedAt: null,
          };
          throw httpError(422, `Bağımlılık koşulu sağlanamadığı için çalıştırma durduruldu: ${prep.summary}`);
        }

        state.permission = {
          granted: true,
          approvedJobId: job.id,
          approvedCommitSha: state.commitSha,
          approvedSourceSha256: state.sourceEvidenceSha256,
          approvedAt: new Date().toISOString(),
        };
      });
    }

    if (action === 'run') {
      return withSession(request, async state => {
        const slot = request.slot === 'B' ? 'B' : (request.slot === 'A' ? 'A' : null);
        requireCond(slot !== null, 400, 'Deneme yuvası A veya B olmalıdır.');
        requireCond(request.expectedJobId === undefined || request.expectedJobId === state.selectedJobId, 409,
          'İstekteki iş kimliği oturumdaki seçili işle eşleşmiyor (yanlış A/B ilişkilendirmesi engellendi).');
        const runRecord = await executeSlotRun(state, {
          slot,
          inputText: request.inputText,
          prediction: request.prediction,
          extraFlags: request.extraFlags,
          simulateStaleConsumer: Boolean(request._testSimulateStaleConsumer),
        }, signal);
        return { lastRun: structuredClone(runRecord) };
      });
    }

    if (action === 'reset') {
      return withSession(request, async state => {
        const job = state.jobs.find(j => j.id === state.selectedJobId);
        if (state.runs.length > 0) {
          state.archivedRuns.push({
            resetNumber: state.resetCount + 1,
            resetAt: new Date().toISOString(),
            preservedRuns: structuredClone(state.runs),
            preservedAbComparison: structuredClone(state.abComparison),
          });
          if (state.archivedRuns.length > 8) state.archivedRuns.shift();
        }
        state.runs = [];
        state.abComparison = null;
        state.workspaceClean = true;
        if (job?.trialDefaults) {
          state.draftInputs = {
            A: job.trialDefaults.inputA,
            B: job.trialDefaults.inputB,
          };
          state.draftFlags = [...(job.trialDefaults.discoveredFlags || [])];
          state.customFlags = [...(job.trialDefaults.discoveredFlags || [])];
        }
        state.resetCount++;
      });
    }

    if (action === 'cleanRerun') {
      return withSession(request, async state => {
        requireCond(isUuid(request.runId), 400, 'Tekrar çalıştırılacak geçerli bir deneme kimliği (runId) seçin.');
        const allKnownRuns = collectAllSessionRuns(state);
        const original = allKnownRuns.find(r => r.runId === request.runId);
        requireCond(original, 404, 'Karşılaştırılacak önceki deneme bu oturumda bulunamadı.');
        requireCond(original.jobId === state.selectedJobId, 409, 'Önceki deneme farklı bir işe ait; önce ilgili işi seçin.');

        const rerun = await executeSlotRun(state, {
          slot: original.slot,
          inputText: original.inputText,
          prediction: original.prediction,
          isCleanRerunOf: original.runId,
          originalArgv: original.argv,
        }, signal);

        const exitMatches = rerun.exitCode === original.exitCode;
        const stdoutMatches = rerun.stdoutSha256 === original.stdoutSha256;
        const traceMatches = (rerun.trace?.producerReturn?.sha256 || null) === (original.trace?.producerReturn?.sha256 || null) &&
          rerun.trace?.status === original.trace?.status;
        const consistent = exitMatches && stdoutMatches && traceMatches;

        const comparison = {
          id: crypto.randomUUID(),
          comparedAt: new Date().toISOString(),
          originalRunId: original.runId,
          cleanRerunId: rerun.runId,
          slot: original.slot,
          inputText: original.inputText,
          consistent,
          exitMatches,
          stdoutMatches,
          traceMatches,
          originalStdoutSha256: original.stdoutSha256,
          rerunStdoutSha256: rerun.stdoutSha256,
          summary: consistent
            ? `Temiz ortam tekrarı doğrulandı: Sıfırlanmış taze /work/deney tmpfs alanında aynı girdi (${original.slot}) ve aynı komut (${JSON.stringify(original.argv)}) tekrar çalıştırıldı; çıkış kodu (${rerun.exitCode}), süreç çıktısı SHA-256 özeti (${rerun.stdoutSha256.slice(0, 12)}…) ve doğal tüketici ara değer özeti önceki koşuyla birebir aynıdır.`
            : `Fark saptandı: Temiz ortamda tekrar çalıştırılan denemenin çıktısı veya ara değeri önceki koşudan farklılık gösterdi (çıkış eşleşmesi: ${exitMatches}, çıktı eşleşmesi: ${stdoutMatches}, ara değer eşleşmesi: ${traceMatches}).`,
        };
        state.cleanReruns.push(comparison);
        return { cleanRerunComparison: structuredClone(comparison), lastRun: structuredClone(rerun) };
      });
    }

    if (action === 'save') {
      return withSession(request, async state => {
        const rawName = sanitizeText(request.name || '', 120);
        const defaultName = `${state.repository} — ${state.intent}`.slice(0, 120);
        const name = rawName || defaultName;
        const recordId = crypto.randomUUID();
        const bundledBytes = Buffer.byteLength(JSON.stringify(state._pythonFiles || []), 'utf8');
        const bundledPythonFiles = bundledBytes <= 768 * 1024 ? structuredClone(state._pythonFiles || []) : [];

        const record = {
          schemaVersion: 2,
          id: recordId,
          name,
          savedAt: new Date().toISOString(),
          snapshot: {
            url: state.url,
            repository: state.repository,
            branch: state.branch,
            commitSha: state.commitSha,
            archiveSha256: state.archiveSha256,
            sourceEvidenceSha256: state.sourceEvidenceSha256,
            intent: state.intent,
          },
          sessionState: publicStateView(state),
          bundledPythonFiles,
        };
        await store.write(record);
        const saved = await store.list();
        return { savedRecordId: recordId, saved };
      });
    }

    throw httpError(400, `Tanınmayan depo laboratuvarı işlemi: ${action}`);
  }

  function _debugGetInternalSession(id) {
    return sessions.get(id)?.state || null;
  }

  return {
    get,
    post,
    SUPPORTED_SCOPE,
    _debugGetInternalSession,
  };
}

module.exports = {
  createDepoLaboratuvar,
  computeSourceEvidenceSha256,
  SUPPORTED_SCOPE,
};
