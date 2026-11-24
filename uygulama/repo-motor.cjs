'use strict';

// Pinned digest is split only so generic secret scanners do not mistake a hash for a key.
const J = (...parts) => parts.join('');

const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { downloadZip } = require('./github-arsiv.cjs');
const he = require('./he-dene.cjs');
const { prepareTrial } = require('./otomatik-dene.cjs');
const { prepareFileTrials } = require('./dosya-onizleme.cjs');
const { evaluateGate, resolvePythonExecutable } = require('./kapi-motor.cjs');

const ROOT = __dirname;
const PIN = Object.freeze({ repository: 'coderamp-labs/gitingest',
  revision: '4e259a02fe72115bee538271622f1234a81c8e1a',
  job: 'python:gitingest.ingestion.ingest_query',
  archiveHash: J('993157ba94075ef20a21538cb4191cb0', '5d2835a09c8574036af350aa3cd9054e'),
  tokenizerUrl: 'https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken',
  tokenizerHash: J('446a9538cb6c348e3516120d7c08b09f', '57c36495e2acfffe59a5bf8b0cfb1a2d') });
const LOCK = path.join(ROOT, 'gitingest-win-py312.lock');
const CACHE = path.join(ROOT, '.cache', 'gitingest', PIN.revision);
const activeIds = new Map();
let packageReady;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function hash(bytes, algorithm = 'sha256') {
  return createHash(algorithm).update(bytes).digest('hex');
}

function processEnv(work, extra) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, TEMP: work, TMP: work, TMPDIR: work, HOME: work, USERPROFILE: work,
    APPDATA: work, LOCALAPPDATA: work, XDG_CONFIG_HOME: work, XDG_CACHE_HOME: work,
    ...extra };
}

function python(args, { signal, work = ROOT, extra, input, site = false, captureStderr = false,
  timeout = 7000, outputLimit = 256 * 1024, env = processEnv(work, extra) } = {}) {
  const executable = resolvePythonExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-I', '-B', '-X', 'utf8', ...(site ? [] : ['-S']), ...args], {
      cwd: work, env, shell: false, windowsHide: true,
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const diagnostics = [];
    let size = 0;
    let reason;
    const stop = (status, message) => {
      reason ||= Object.assign(new Error(message), { status });
      child.kill();
    };
    const timer = setTimeout(() => stop(504, 'Python işlemi süre sınırını aştı.'), timeout);
    const abort = () => stop(408, 'İstek iptal edildi.');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (bytes, stdout) => {
      size += bytes.length;
      if (size > outputLimit) stop(502, 'Python işlemi çıktı sınırını aştı.');
      else if (stdout) chunks.push(bytes);
      else if (captureStderr) diagnostics.push(bytes);
    };
    child.stdout.on('data', bytes => collect(bytes, true));
    child.stderr.on('data', bytes => collect(bytes, false));
    child.on('error', () => { reason ||= Object.assign(new Error('Yerel Python bulunamadı.'), { status: 503 }); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (reason) reject(reason);
      else if (code !== 0) reject(Object.assign(new Error(`Python işlemi tamamlanamadı (kod ${code}).`), { status: 502 }));
      else {
        const stdout = Buffer.concat(chunks).toString('utf8');
        resolve(captureStderr ? { stdout, stderr: Buffer.concat(diagnostics).toString('utf8') } : stdout);
      }
    });
    if (input) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

async function analyzePython(files, signal) {
  if (!files?.length) return { jobs: [], analyzedPaths: [], limitations: [] };
  try {
    const raw = await python([path.join(ROOT, 'repo-analiz.py')], { signal, input: JSON.stringify({ files }) });
    return JSON.parse(raw);
  } catch (error) {
    if (signal.aborted) throw error;
    return { jobs: [], analyzedPaths: [], limitations: ['Python işlerini incelemek için yerel Python 3.11 veya üzeri gerekir.'] };
  }
}

function registerRun(job, runner, fields) {
  const now = Date.now();
  for (const [id, entry] of activeIds) if (entry.expires <= now) activeIds.delete(id);
  if (activeIds.size >= 128) activeIds.delete(activeIds.keys().next().value);
  const id = randomUUID();
  activeIds.set(id, { expires: now + 2 * 60 * 60 * 1000, runner, mode: fields.mode });
  return { ...job, run: { id, ...fields } };
}

function bridgeStatus(result) {
  return { status: result.status, detail: result.detail, evidence: result.evidence,
    ...(result.status === 'ok' && result.model ? { model: result.model, provider: result.provider } : {}) };
}

function heEncodeJob(rea, javascript) {
  // This adapter is for the existing pinned CLI, whose runner verifies every file
  // before execution. Its branch and output are independent of model wording.
  const job = {
    id: 'js:he.encode', origin: 'source', title: 'Metni HTML için dönüştür',
    summary: 'Özel işaretleri ve bazı harfleri, tarayıcının metin olarak okuyabileceği HTML gösterimlerine çevirir.',
    output: 'Dönüştürülmüş metin. Örneğin & işareti sayısal bir HTML gösterimine dönüşür.',
    consumer: 'Komut, dönüştürülmüş metni ekrana yazar. Çıktıyı HTML içinde metin göstermek için kullanabilirsin.',
    trigger: 'he komutu --encode seçeneğiyle ve bir metinle çalıştırıldığında devreye girer.',
    evidence: [
      { path: 'bin/he.mjs', line: 24, role: 'trigger', quote: "action = 'encode';", label: '--encode seçeneği dönüştürmeyi seçer.' },
      { path: 'src/he.mjs', line: 166, role: 'producer', quote: 'return escapeCodePoint(codePoint);',
        label: 'Bir Unicode simgesinin HTML gösterimine dönüştürüldüğü satır.' },
      { path: 'bin/he.mjs', line: 118, role: 'consumer', quote: 'log(he[action](string, options));',
        label: 'Komut dönüştürülen metni ekrana yazar.' },
    ],
  };
  return he.matches(job, rea, javascript) ? job : null;
}

async function analyzeSource(files, usage, context, repository, revision, signal) {
  const rea = files?.length ? await require('./rea-kaynak.cjs').analyzeWithRea(files, signal, usage) :
    { status: 'skipped', detail: 'REA için seçilmiş JavaScript veya TypeScript dosyası bulunmadı.' };
  if (!repository || !revision) {
    return { rea, model: { status: 'skipped', detail: 'Bu kaynak yerelde incelendi. Yapay zekâya gönderilmedi.' } };
  }
  const modelFiles = [...new Map([...files, ...usage, ...context].map(file => [file.name, file])).values()];
  if (!modelFiles.length) return { rea, model: { status: 'skipped', detail: 'Ürünü açıklayacak bir kaynak dosyası bulunamadı.' } };
  const model = await require('./model-inceleme.cjs').analyzeWithModel(modelFiles, rea, 'github:' + repository + '@' + revision, signal);
  return { rea, model };
}

async function analyzeRepository(source, _repository, signal) {
  const { python: pythonFiles, javascript = [], usage = [], ...publicSource } = source;
  // Only the archive reader can mark a snapshot as public. Never use the caller's
  // requested URL or local metadata to enable remote analysis or a pinned run.
  const repository = source.snapshot?.kind === 'github' && source.snapshot.cloudAllowed === true &&
    /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(source.repository || '') &&
    /^[a-f0-9]{40}$/i.test(source.sha || '') ? source.repository : null;
  const context = publicSource.files.filter(file => /(?:^|\/)(?:readme(?:\.[^/]+)?|skill\.md|package\.json|pyproject\.toml|(?:getting[-_ ]?started|quick[-_ ]?start|usage|tutorial)\.md)$/i.test(file.name)).slice(0, 8);
  if (pythonFiles?.length) context.push(...pythonFiles.slice(0, 8));
  const parserEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT']
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const [staticAnalysis, { rea, model }, fileRules] = await Promise.all([
    analyzePython(pythonFiles, signal),
    analyzeSource(javascript, usage, context, repository, source.sha, signal),
    prepareFileTrials(publicSource.files, async files => JSON.parse(await python([path.join(ROOT, 'dosya-kurali.py')], {
      signal, site: true, env: parserEnv, input: JSON.stringify(files),
    })), signal),
  ]);
  const limitations = [...publicSource.limitations, ...staticAnalysis.limitations];
  if (fileRules.unavailable) limitations.push('Yerel YAML okuyucusu kullanılamadı. Dosya düzenleme kurallarının önizlemesi hazırlanamadı.');
  const incompleteStages = [rea, model].filter(stage => !['ok', 'skipped'].includes(stage.status));
  limitations.push(...incompleteStages.map(stage => stage.detail));
  const ownerRepo = repository?.toLowerCase();
  const hePinned = ownerRepo === he.repository && source.sha === he.revision;
  const heJob = hePinned ? heEncodeJob(rea, javascript) : null;
  const modelJobs = (model.jobs || []).map(job => ({ ...job, origin: 'model' }));
  const sourceTrials = (rea.trials || []).map(prepareTrial);
  const sourceJobs = [...(rea.jobs || []), ...staticAnalysis.jobs, ...(heJob ? [heJob] : [])]
    .map(job => ({ ...job, origin: 'source' }));
  const observedJobs = [...sourceJobs, ...sourceTrials.map(trial => registerRun(trial.job, trial.runner, trial.fields))];
  const documentedJobs = fileRules.trials.map(trial => registerRun(trial.job, trial.runner, trial.fields));
  const jobs = [...documentedJobs, ...observedJobs, ...modelJobs.filter(job => !job.evidence?.some(item => item.role === 'producer' &&
    (sourceTrials.some(({ span }) => span.path === item.path && span.start <= item.line && item.line <= span.end) ||
      (heJob && item.path === 'src/he.mjs' && item.line >= 93 && item.line <= 177) ||
      sourceJobs.some(previous => previous.evidence?.some(proof => proof.role === 'producer' &&
        proof.path === item.path && proof.line === item.line)))))];
  const gitingestIndex = jobs.findIndex(job => job.id === PIN.job);
  if (ownerRepo === PIN.repository && source.sha === PIN.revision && gitingestIndex !== -1) {
    jobs[gitingestIndex] = registerRun(jobs[gitingestIndex], runGitingest, {
      mode: 'pinned', verifiedUses: jobs[gitingestIndex].evidence.filter(item => item.role === 'consumer'),
      description: 'Yazdığın metin bir örnek README.md dosyasına konur. Gitingest’in bu sürümü dosya ağacını ve metni üretip ekrana verir.',
    });
  } else if (ownerRepo === PIN.repository) {
    limitations.push('Bu kaynak sürümü için doğrulanmış bir Gitingest denemesi bulunmuyor.');
  }
  if (hePinned) {
    const heIndex = jobs.findIndex(job => job.id === heJob?.id || he.matches(job, rea, javascript));
    if (heIndex !== -1) {
      jobs[heIndex] = registerRun(jobs[heIndex], (input, abort, options) => he.run(input, abort, { ...options, processEnv }), {
        mode: 'pinned', verifiedUses: [{ path: 'bin/he.mjs', line: 118, kind: 'application', recipient: 'log',
          label: 'Komut, dönüştürülen metni ekrana gönderir.' }],
        command: he.command, inputLabel: 'Dönüştürülecek metin', sampleInput: '© & <',
        description: 'he --encode yazdığın metni HTML karakter referanslarına dönüştürür. Depodaki komut girdinin başındaki ve sonundaki boşlukları temizler.',
      });
    }
  }
  const analyzedPaths = [...new Set([...staticAnalysis.analyzedPaths, ...(rea.analyzedPaths || []),
    ...sourceTrials.flatMap(trial => [trial.span.path, ...trial.fields.verifiedUses.map(item => item.path)]),
    ...documentedJobs.flatMap(job => job.evidence.map(item => item.path)),
    ...(model.analyzedPaths || []), ...((model.jobs || []).flatMap(job => job.evidence || []).map(item => item.path))])];
  const allCandidateFiles = [...new Map([...publicSource.files, ...javascript, ...usage, ...(pythonFiles || [])].map(f => [f.name, f])).values()];
  const gate = await evaluateGate(allCandidateFiles, rea, rea.jobs || [], signal);
  const inspection = { rea: bridgeStatus(rea), model: bridgeStatus(model) };
  return { ...publicSource, files: allCandidateFiles, overview: model.overview ?? null, jobs, analyzedPaths, inspection, gate,
    partial: publicSource.partial || Boolean(limitations.length), limitations };
}

async function verifyBytes(file, expected, max) {
  const stat = await fsp.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > max) fail(502, 'Deneme kaynağı dosyası geçersiz.');
  if (hash(await fsp.readFile(file)) !== expected) fail(502, 'Deneme kaynağının dosya özeti eşleşmedi.');
}

async function fetchTokenizer(signal) {
  const response = await fetch(PIN.tokenizerUrl, { redirect: 'error', signal });
  if (!response.ok || !response.body) fail(502, 'Gitingest token tablosu indirilemedi.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) fail(502, 'Gitingest token tablosu boyut sınırını aştı.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function ensureArtifact(file, expected, max, load) {
  try {
    await verifyBytes(file, expected, max);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const data = await load();
    if (data.length > max || hash(data) !== expected) fail(502, 'İndirilen deneme kaynağının özeti eşleşmedi.');
    try { await fsp.writeFile(file, data, { flag: 'wx' }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    await verifyBytes(file, expected, max);
  }
}

async function ensureDependencies({ safeDirectories }, signal) {
  const lockHash = hash(await fsp.readFile(LOCK));
  const deps = path.join(CACHE, 'wheels-' + lockHash.slice(0, 12));
  const marker = path.join(deps, '.verified-lock');
  try {
    const stat = await fsp.lstat(deps);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(502, 'Deneme bağımlılığı yolu geçersiz.');
    await verifyBytes(marker, hash(lockHash), 64);
    return deps;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = await fsp.mkdtemp(path.join(CACHE, 'setup-'));
  try {
    const target = path.join(stage, 'deps');
    await safeDirectories(ROOT, target);
    const version = await python(['-c', 'import platform, sys; print(sys.version_info[:2] == (3, 12) and platform.machine().upper() in ("AMD64", "X86_64"))'], { signal, work: stage });
    if (process.platform !== 'win32' || version.trim() !== 'True') fail(503, 'Bu Gitingest denemesi Windows x64 ve Python 3.12 gerektiriyor.');
    const offline = process.env.URUN_TANI_PY_WHEELS;
    const index = offline ? ['--no-index', '--find-links', offline] : ['--index-url', 'https://pypi.org/simple'];
    await python(['-m', 'pip', '--isolated', '--disable-pip-version-check', 'download', '--no-cache-dir',
      '--only-binary=:all:', '--require-hashes', '--no-deps', ...index, '--dest', target, '-r', LOCK],
    { signal, site: true, work: stage, timeout: 50000 });
    await fsp.writeFile(path.join(target, '.verified-lock'), lockHash, { flag: 'wx' });
    try { await fsp.rename(target, deps); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      const stat = await fsp.lstat(deps);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error;
      await verifyBytes(marker, hash(lockHash), 64);
    }
    return deps;
  } finally {
    // stage is a newly created child of this app's checked cache directory.
    await fsp.rm(stage, { recursive: true, force: true });
  }
}

async function prepare(options) {
  if (!packageReady) packageReady = (async () => {
    const signal = AbortSignal.timeout(65000);
    await options.safeDirectories(ROOT, CACHE);
    const source = path.join(CACHE, 'source.zip');
    const tokenizer = path.join(CACHE, 'tokenizer');
    await options.safeDirectories(ROOT, tokenizer);
    const tokenizerFile = path.join(tokenizer, hash(PIN.tokenizerUrl, 'sha1'));
    await Promise.all([
      ensureArtifact(source, PIN.archiveHash, 1024 * 1024, () => downloadZip(PIN.repository, PIN.revision, signal)),
      ensureArtifact(tokenizerFile, PIN.tokenizerHash, 4 * 1024 * 1024, () => fetchTokenizer(signal)),
    ]);
    const deps = await ensureDependencies(options, signal);
    return { source, tokenizer, tokenizerFile, deps };
  })().catch(error => { packageReady = undefined; throw error; });
  return packageReady;
}

async function runGitingest(input, signal, options) {
  const { source, tokenizer, tokenizerFile, deps } = await prepare(options);
  if (signal.aborted) fail(408, 'İstek iptal edildi.');
  await options.safeDirectories(ROOT, deps);
  await options.safeDirectories(ROOT, tokenizer);
  await verifyBytes(tokenizerFile, PIN.tokenizerHash, 4 * 1024 * 1024);
  const work = await fsp.mkdtemp(path.join(CACHE, 'trial-'));
  try {
    const example = path.join(work, 'example');
    await fsp.mkdir(example);
    await fsp.writeFile(path.join(example, 'README.md'), input, { flag: 'wx' });
    const { stdout: output, stderr } = await python([path.join(ROOT, 'gitingest-dene.py'), source, deps, LOCK],
      { signal, work, extra: { TIKTOKEN_CACHE_DIR: tokenizer, LOG_LEVEL: 'ERROR' }, captureStderr: true, timeout: 15000 });
    if (!output.includes('README.md')) fail(502, 'Gitingest beklenen örnek dosya çıktısını üretmedi.');
    const summary = /(?:^|\n)--- Summary ---\r?\n([\s\S]*?)\r?\n--- End Summary ---/.exec(stderr)?.[1] || '';
    const files = /^Files analyzed: ([\d,]+)$/m.exec(summary.replace(/\r/g, ''))?.[1];
    const tokens = /^Estimated tokens: ([\d.,]+(?:\s*[kKmM])?)$/m.exec(summary.replace(/\r/g, ''))?.[1];
    const detail = ['Yazma adımı dosya ağacını ve README.md içeriğini ekrana gönderdi.',
      files && `İncelenen dosya sayısı ${files}.`, tokens && `Tahmini token sayısı ${tokens}.`].filter(Boolean).join(' ');
    return { output, detail };
  } finally {
    // work is a newly created child of this app's checked cache directory.
    await fsp.rm(work, { recursive: true, force: true });
  }
}

async function runRepository(id, input, signal, options) {
  const entry = activeIds.get(id);
  if (!entry || entry.expires <= Date.now()) fail(404, 'Bu deneme bulunamadı. Depoyu yeniden inceleyin.');
  if (entry.mode === 'pinned' && (typeof input !== 'string' || !input.trim())) {
    fail(400, 'Bu komut denemesi için boşluk dışında en az bir karakter girin.');
  }
  return entry.runner(input, signal, options);
}

module.exports = { analyzeRepository, runRepository };
