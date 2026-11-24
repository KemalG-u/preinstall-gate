#!/usr/bin/env node
'use strict';

// Çalıştır: cd uygulama; node sunucu.cjs
// Aç: http://127.0.0.1:4178/  (file:// kullanmayın).
// Resmî metadata, 2026-11-13:
// https://registry.npmjs.org/modern-web-guidance/1.0.0
// gitHead: 544c250575f7811d87fef8b1c064bc9571cbfb80
// Apache-2.0 yazılım; rehberlerin CC-BY-4.0 atıfları paket içinde korunur.
// npm/npx/install/lifecycle çalıştırılmaz; yalnız sabit search + retrieve.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { githubSource, uploadedSource, localFilesSource, MAX_ZIP } = require('./github-arsiv.cjs');
const { MAX_SOURCE_REQUEST } = require('./kaynak-paketi.cjs');
const { readWebDocument } = require('./web-kaynak.cjs');
const { analyzeRepository, runRepository } = require('./repo-motor.cjs');
const { inspectWorkflows } = require('./workflow-analiz.cjs');
const { rerunCanaryById, PRESET_SCENARIOS } = require('./kapi-motor.cjs');
const { createLaboratuvar } = require('./laboratuvar.cjs');
const { createDepoLaboratuvar } = require('./depo-laboratuvar.cjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env.URUN_TANI_PORT || '4178');
const ROOT = __dirname;
const PROJECT = path.dirname(ROOT);
const CACHE = path.join(ROOT, '.cache', 'modern-web-guidance', '1.0.0');
const PIN = Object.freeze({
  name: 'modern-web-guidance', version: '1.0.0',
  url: 'https://registry.npmjs.org/modern-web-guidance/-/modern-web-guidance-1.0.0.tgz',
  integrity: 'sha512-vafIZwC8AS6QjM2yyoflZbnc7n3/TVOMLbEMRdPTwcFy0f9/Tq8s5rJQ8UIqRt2KPl9ixravyaMR4nTGuUrcmg==',
  entry: 'skills/modern-web-guidance/modern-web.mjs',
});
const LIMIT = Object.freeze({ request: 4096, query: 500, archive: 24 * 1024 * 1024,
  unpack: 40 * 1024 * 1024, file: 24 * 1024 * 1024, output: 1024 * 1024,
  guide: 512 * 1024, static: 4 * 1024 * 1024, downloadMs: 30000,
  cliMs: 20000, requestMs: 70000 });
const ID = /^[a-z0-9][a-z0-9-]{0,119}$/;
const EXAMPLES = new Set([
  '/ornekler/agentic-os-3.0.0/AGENTIC-OS-3.0.0-INCELEME.md',
  '/ornekler/agentic-os-3.0.0/calisma/notlar/windows-surec.md',
  '/ornekler/agentic-os-3.0.0/calisma/notlar/windows-voice-tr.md',
  '/ornekler/agentic-os-3.0.0/calisma/urun/scripts/setup.ts',
  '/ornekler/agentic-os-3.0.0/calisma/urun/src/data/live-data.example.json',
  '/ornekler/agentic-os-3.0.0/calisma/urun/src/lib/model-lane.ts',
]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon' };
let packageReady;
let busy = false;
let activeSources = 0;
let runningRepository = false;
let runningGateFlow = false;
const children = new Set();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HttpError(status, message); }
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
async function safeDirectories(root, target) {
  if (!inside(root, target)) fail(500, 'Geçersiz yerel klasör.');
  const base = await fsp.lstat(root);
  if (base.isSymbolicLink() || !base.isDirectory()) fail(500, 'Güvenli kök bulunamadı.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fsp.mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(500, 'Klasör bağlantısına izin yok.');
  }
}
async function regularFile(file, max) {
  const stat = await fsp.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > max) fail(502, 'Dosya türü veya boyutu geçersiz.');
  return stat;
}
function verifyArchive(bytes) {
  const actual = 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
  if (actual !== PIN.integrity) fail(502, 'Resmî paketin SHA-512 doğrulaması başarısız.');
}
async function download(signal) {
  // Sabit HTTPS hedefi; yönlendirme yok, proxy/kimlik bilgisi yok.
  let response;
  try {
    response = await fetch(PIN.url, { redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(LIMIT.downloadMs)]) });
  } catch { fail(503, 'Sabit resmî npm paketi indirilemedi. Ağ erişimini kontrol edin.'); }
  if (!response.ok || !response.body) fail(502, 'Resmî npm paketi alınamadı.');
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMIT.archive) { await response.body.cancel().catch(() => {}); fail(502, 'Paket boyut sınırını aştı.'); }
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail(503, 'Paket indirmesi tamamlanamadı.');
  }
  return Buffer.concat(chunks);
}
function tarFiles(archive) {
  let tar;
  try { tar = zlib.gunzipSync(archive, { maxOutputLength: LIMIT.unpack }); }
  catch { fail(502, 'Paket açılamadı veya açılmış boyut sınırını aştı.'); }
  const files = new Map(); let count = 0; let ended = false;
  const field = (b, a, n) => b.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every(x => x === 0)) { ended = true; break; }
    if (++count > 1024) fail(502, 'Paket dosya sayısı sınırını aştı.');
    const octal = (a, n) => {
      const s = field(h, a, n).trim();
      if (!/^[0-7]+$/.test(s)) fail(502, 'Desteklenmeyen tar sayısı.');
      return parseInt(s, 8);
    };
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i];
    if (checksum !== octal(148, 8)) fail(502, 'Tar başlık doğrulaması başarısız.');
    const prefix = field(h, 345, 155);
    const name = (prefix ? prefix + '/' : '') + field(h, 0, 100);
    const size = octal(124, 12);
    const type = h[156];
    // Link, PAX, aygıt ve Windows ADS/aygıt adları reddedilir.
    if (!name.startsWith('package/') || /[\\:\x00-\x1f]/.test(name) || size > LIMIT.file ||
        name.split('/').some(s => s === '.' || s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
      fail(502, 'Güvenli olmayan paket yolu.');
    }
    if (![0, 48, 53].includes(type)) fail(502, 'Paket bağlantısı veya özel tar girdisi reddedildi.');
    const begin = offset + 512;
    if (begin + size > tar.length) fail(502, 'Eksik tar girdisi.');
    if (type !== 53) {
      const relative = name.slice(8);
      if (!relative || files.has(relative)) fail(502, 'Tekrarlanan paket girdisi.');
      files.set(relative, tar.subarray(begin, begin + size));
    }
    offset = begin + Math.ceil(size / 512) * 512;
  }
  if (!ended || !files.has(PIN.entry) || !files.has('package.json')) fail(502, 'Paket giriş dosyası eksik.');
  const manifest = JSON.parse(files.get('package.json').toString('utf8'));
  if (manifest.name !== PIN.name || manifest.version !== PIN.version ||
      manifest.bin?.[PIN.name] !== PIN.entry || Object.keys(manifest.dependencies || {}).length) {
    fail(502, 'Paket sözleşmesi değişmiş.');
  }
  return files;
}
async function ensurePackage(signal) {
  if (!packageReady) packageReady = (async () => {
    await safeDirectories(ROOT, CACHE);
    const archivePath = path.join(CACHE, 'official.tgz');
    let archive;
    try { await regularFile(archivePath, LIMIT.archive); archive = await fsp.readFile(archivePath); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!archive) {
      archive = await download(signal);
      verifyArchive(archive);
      // wx: mevcut/symlink dosyasının üzerine yazılmaz.
      await fsp.writeFile(archivePath, archive, { flag: 'wx' });
    }
    verifyArchive(archive);
    const files = tarFiles(archive);
    const unpack = path.join(CACHE, 'unpack');
    await safeDirectories(ROOT, unpack);
    // Her sunucu başlangıcında çalışacak dosyalar doğrulanmış arşivle karşılaştırılır.
    for (const [relative, bytes] of files) {
      signal.throwIfAborted();
      const target = path.join(unpack, relative);
      if (!inside(unpack, target)) fail(502, 'Paket yolu sınır dışı.');
      await safeDirectories(ROOT, path.dirname(target));
      try {
        await regularFile(target, LIMIT.file);
        if (!(await fsp.readFile(target)).equals(bytes)) fail(502, 'Yerel paket değiştirilmiş; çalıştırılmadı.');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        await fsp.writeFile(target, bytes, { flag: 'wx' });
      }
    }
    return path.join(unpack, PIN.entry);
  })().catch(e => { packageReady = undefined; throw e; });
  return packageReady;
}
function cli(entry, command, arg, work, signal) {
  if (!['search', 'retrieve'].includes(command) || (command === 'retrieve' && !ID.test(arg))) {
    fail(400, 'İzin verilmeyen CLI girdisi.');
  }
  return new Promise((resolve, reject) => {
    // Ortamı miras alma: NODE_OPTIONS, token, kullanıcı HOME ve ajan ayarları yok.
    const env = { DISABLE_TELEMETRY: '1', TEMP: work, TMP: work, TMPDIR: work,
      HOME: work, USERPROFILE: work, APPDATA: work, LOCALAPPDATA: work,
      XDG_CONFIG_HOME: work, XDG_CACHE_HOME: work, NO_COLOR: '1', CI: '1' };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    // Node izin modeli CLI'nin kullanıcı dosyalarını okumasını engeller.
    // Node 22.18+; daha eski Node'da sessizce korumasız çalışmaya geçilmez.
    const child = spawn(process.execPath, ['--permission',
      `--allow-fs-read=${path.join(CACHE, 'unpack')}`,
      `--allow-fs-read=${work}`, `--allow-fs-write=${work}`,
      entry, command, '--', arg], {
      shell: false, windowsHide: true, cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    const chunks = []; let bytes = 0; let reason;
    const stop = error => { reason ||= error; child.kill(); };
    const timer = setTimeout(() => stop(new HttpError(504, 'CLI süre sınırını aştı.')), LIMIT.cliMs);
    const abort = () => stop(new HttpError(408, 'İstek iptal edildi veya süresi doldu.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const consume = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > LIMIT.output) stop(new HttpError(502, 'CLI çıktı boyutu sınırını aştı.'));
      else if (stdout) chunks.push(chunk);
    };
    child.stdout.on('data', b => consume(b, true));
    child.stderr.on('data', b => consume(b, false));
    child.once('error', () => { reason ||= new HttpError(503, 'Node CLI süreci başlatılamadı.'); });
    child.once('close', code => {
      clearTimeout(timer); children.delete(child); signal.removeEventListener('abort', abort);
      if (reason) reject(reason);
      else if (code !== 0) reject(new HttpError(502, `Resmî CLI ${command} işlemini tamamlayamadı (kod ${code}).`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
async function guidance(query, signal) {
  const entry = await ensurePackage(signal);
  await safeDirectories(ROOT, path.join(CACHE, 'requests'));
  const work = await fsp.mkdtemp(path.join(CACHE, 'requests', 'request-'));
  try {
    // CLI üst klasörlerde veya gerçek kullanıcı HOME'unda .mwgrc aramasın.
    await fsp.writeFile(path.join(work, '.mwgrc'), '{}', { flag: 'wx' });
    const raw = await cli(entry, 'search', query, work, signal);
    let matches;
    try { matches = JSON.parse(raw); } catch { fail(502, 'CLI arama çıktısı geçerli JSON değil.'); }
    if (!Array.isArray(matches) || matches.length > 50 || matches.some(m =>
      !m || typeof m.id !== 'string' || !ID.test(m.id) || typeof m.description !== 'string' || m.description.length > 10000)) {
      fail(502, 'CLI arama çıktı sözleşmesi geçersiz.');
    }
    matches = matches.map(({ id, description }) => ({ id, description }));
    if (!matches.length) return { matches, guide: null };
    const id = matches[0].id; // İstemci id/komut/yol seçemez; yalnız gerçek aramanın ilk sonucu.
    let text = await cli(entry, 'retrieve', id, work, signal);
    // Büyük retrieve çıktısı: yalnız kendi TMP klasörümüzdeki beklenen dosya.
    if (text.startsWith('Output (')) {
      const match = /^Output \([^\r\n]+\) saved to (.+) to prevent CLI stdout truncation\.\r?\n/.exec(text);
      if (!match) fail(502, 'CLI geçici çıktı biçimi tanınmadı.');
      const file = path.resolve(match[1]);
      if (path.dirname(file) !== work || !/^mwg-guide-\d+-\d+\.md$/.test(path.basename(file))) {
        fail(502, 'CLI geçici dosyası istek klasörü dışında.');
      }
      await regularFile(file, LIMIT.guide);
      if (await fsp.realpath(file) !== file) fail(502, 'CLI geçici dosya bağlantısı reddedildi.');
      text = await fsp.readFile(file, 'utf8');
    }
    if (Buffer.byteLength(text) > LIMIT.guide || !text.trimStart().startsWith(`--- Guide for ${id} ---`)) {
      fail(502, 'CLI rehber içeriği veya boyutu geçersiz.');
    }
    return { matches, guide: { id, text } };
  } finally {
    // work yalnız mkdtemp çıktısı; ortak TEMP veya kullanıcı klasörü silinmez.
    if (inside(path.join(CACHE, 'requests'), work) && path.basename(work).startsWith('request-')) {
      await fsp.rm(work, { recursive: true, force: true });
    }
  }
}
function send(res, status, body, type = 'application/json; charset=utf-8', head = false) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY' });
  res.end(head ? undefined : bytes);
}
function requestPath(req) {
  if (typeof req.url !== 'string' || req.url.length > 2048 || !req.url.startsWith('/') || req.url.startsWith('//')) fail(400, 'Geçersiz istek yolu.');
  let decoded;
  try { decoded = decodeURIComponent(req.url.split('?')[0]); } catch { fail(400, 'Geçersiz URL kodlaması.'); }
  if (/[\\:%\x00-\x1f\x7f]/.test(decoded) || decoded.split('/').some(s => s === '..' || s === '.')) fail(403, 'İzin verilmeyen yol.');
  return decoded;
}
function readBody(req, limit, time, sizeError) {
  if (req.headers['content-encoding']) fail(415, 'Sıkıştırılmış istek kabul edilmez.');
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail(413, sizeError);
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('aborted', aborted); req.removeListener('error', errored);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const data = b => { size += b.length; if (size > limit) finish(new HttpError(413, sizeError)); else chunks.push(b); };
    const end = () => finish(null, Buffer.concat(chunks, size));
    const aborted = () => finish(new HttpError(400, 'İstek yarıda kesildi.'));
    const errored = () => finish(new HttpError(400, 'İstek okunamadı.'));
    const timer = setTimeout(() => finish(new HttpError(408, 'İstek gövdesi süre sınırını aştı.')), time);
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', errored);
  });
}
async function bodyJson(req, max = LIMIT.request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) fail(415, 'application/json gerekli.');
  const data = await readBody(req, max, 5000, `İstek ${max} baytı aşamaz.`);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)); }
  catch { fail(400, 'Geçerli JSON gerekli.'); }
}
async function sourceRequest(req, res, kind) {
  if (req.method !== 'POST') fail(405, 'POST gerekli.');
  if (activeSources >= 2) fail(429, 'Kaynak incelemeleri sürüyor. Bir inceleme tamamlanınca tekrar deneyin.');
  activeSources++;
  const controller = new AbortController();
  res.setTimeout(145000);
  const timer = setTimeout(() => controller.abort(new HttpError(504, 'Kaynak inceleme süresi doldu.')), 140000);
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', abort);
  try {
    let source;
    let repository;
    if (kind === 'github') {
      const body = await bodyJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.url !== 'string') {
        fail(400, 'GitHub depo bağlantısı gerekli.');
      }
      source = await githubSource(body.url, controller.signal);
      repository = body.url.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/i, '');
    } else if (kind === 'preset') {
      const body = await bodyJson(req);
      const scenario = body && typeof body.preset === 'string' && Object.hasOwn(PRESET_SCENARIOS, body.preset)
        ? PRESET_SCENARIOS[body.preset] : null;
      if (!scenario) fail(400, 'Geçerli bir hazır deneme senaryosu seçin.');
      source = localFilesSource({ kind: 'folder', files: scenario.files });
      source.title = scenario.title;
    } else if (kind === 'files') {
      source = localFilesSource(await bodyJson(req, MAX_SOURCE_REQUEST));
    } else {
      if (!/^application\/(?:zip|x-zip-compressed|octet-stream)$/i.test(req.headers['content-type'] || '')) fail(415, 'Bir ZIP dosyası seçin.');
      const data = await readBody(req, MAX_ZIP, 10000, 'ZIP dosyası 32 MB sınırını aşıyor.');
      source = uploadedSource(data);
    }
    const [analysis, { workflowGraphs, workflowNotes }] = await Promise.all([
      analyzeRepository(source, repository, controller.signal),
      inspectWorkflows(source, controller.signal),
    ]);
    controller.signal.throwIfAborted();
    send(res, 200, { ...analysis, workflowGraphs, partial: analysis.partial || workflowNotes.length > 0,
      limitations: [...analysis.limitations, ...workflowNotes] });
  } catch (error) {
    throw controller.signal.reason?.status ? controller.signal.reason : error;
  } finally {
    activeSources--;
    clearTimeout(timer);
    res.removeListener('close', abort);
  }
}
async function webSourceRequest(req, res) {
  if (req.method !== 'POST') fail(405, 'POST gerekli.');
  if (activeSources >= 2) fail(429, 'Kaynak incelemeleri sürüyor. Bir inceleme tamamlanınca tekrar deneyin.');
  activeSources++;
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', abort);
  try {
    const body = await bodyJson(req, 8192);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.url !== 'string') {
      fail(400, 'Belge bağlantısı gerekli.');
    }
    const document = await readWebDocument(body.url, controller.signal);
    if (!res.destroyed) send(res, 200, document);
  } finally {
    activeSources--;
    res.removeListener('close', abort);
  }
}

async function repositoryRunRequest(req, res) {
  if (req.method !== 'POST') fail(405, 'POST gerekli.');
  const body = await bodyJson(req, 16 * 1024);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 ||
      typeof body.id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(body.id) ||
      typeof body.input !== 'string' || body.input.length > 2000 || body.input.includes('\0')) {
    fail(400, 'Geçerli bir deneme ve en fazla 2.000 karakterlik örnek metin gerekli.');
  }
  if (runningRepository) fail(429, 'Bir depo denemesi zaten çalışıyor. Tamamlandıktan sonra tekrar deneyin.');
  runningRepository = true;
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', abort);
  try {
    send(res, 200, await runRepository(body.id, body.input, controller.signal, { safeDirectories }));
  } finally {
    runningRepository = false;
    res.removeListener('close', abort);
  }
}

async function gateCanaryRequest(req, res) {
  if (req.method !== 'POST') fail(405, 'POST gerekli.');
  const body = await bodyJson(req, 16 * 1024);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 ||
      typeof body.id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(body.id) ||
      typeof body.input !== 'string' || body.input.length > 2000 || body.input.includes('\0')) {
    fail(400, 'Geçerli bir kanarya oturumu ve en fazla 2.000 karakterlik örnek çalışma girdisi gerekli.');
  }
  if (runningRepository) fail(429, 'Bir kanarya denemesi zaten çalışıyor. Tamamlandıktan sonra tekrar deneyin.');
  runningRepository = true;
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', abort);
  try {
    send(res, 200, await rerunCanaryById(body.id, body.input, controller.signal));
  } finally {
    runningRepository = false;
    res.removeListener('close', abort);
  }
}
async function gateFlowRequest(req, res) {
  if (req.method !== 'POST') fail(405, 'POST gerekli.');
  if (runningGateFlow) fail(429, 'Bir Kapı denemesi sürüyor. Tamamlandıktan sonra tekrar deneyin.');
  runningGateFlow = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HttpError(504, 'Kapı denemesi süre sınırını aştı.')), 140000);
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', abort);
  res.setTimeout(145000);
  try {
    // 64 KB içerikte JSON kaçışları ve UTF-8 için ek pay; asıl alan sınırları motorda doğrulanır.
    const body = await bodyJson(req, 256 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['inspect', 'run'].includes(body.action)) {
      fail(400, 'Geçerli bir Kapı işlemi gerekli.');
    }
    const { gateFlow } = require('./kapi-akis.cjs');
    const result = await gateFlow(body, controller.signal);
    controller.signal.throwIfAborted();
    if (!res.destroyed) send(res, 200, result);
  } catch (error) {
    throw controller.signal.reason?.status ? controller.signal.reason : error;
  } finally {
    runningGateFlow = false;
    clearTimeout(timer);
    res.removeListener('close', abort);
  }
}
async function staticFile(req, res, requested) {
  let file; let type;
  if (EXAMPLES.has(requested)) {
    file = path.join(PROJECT, requested.slice(1)); type = 'text/plain; charset=utf-8';
  } else {
    const local = requested.replace(/^\/uygulama(?=\/|$)/, '') || '/';
    const name = local === '/' ? 'index.html' : local.slice(1);
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name) || !TYPES[path.extname(name)]) fail(404, 'Dosya bulunamadı.');
    file = path.join(ROOT, name); type = TYPES[path.extname(name)];
  }
  const anchor = EXAMPLES.has(requested) ? PROJECT : ROOT;
  let current = anchor;
  for (const part of path.relative(anchor, file).split(path.sep)) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) fail(403, 'Dosya bağlantısına izin yok.');
  }
  if (!inside(anchor, await fsp.realpath(file))) fail(403, 'Dosya sınır dışında.');
  await regularFile(file, LIMIT.static);
  const bytes = await fsp.readFile(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
function createServer(options = {}) {
  let lab = options.lab;
  let depoLab = options.depoLab;
  const server = http.createServer(async (req, res) => {
    try {
      const port = req.socket.localPort;
      const hosts = [HOST + ':' + port, 'localhost:' + port];
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !hosts.includes(req.headers.host)) fail(403, 'Yalnız yerel bağlantı kabul edilir.');
      if (req.headers.origin !== undefined && req.headers.origin !== 'http://' + req.headers.host) fail(403, 'Origin kabul edilmedi.');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) fail(403, 'Çapraz kaynak isteği kabul edilmedi.');
      const requested = requestPath(req);
      if (requested === '/api/laboratuvar') {
        if (req.method !== 'GET' && req.method !== 'POST') fail(405, 'GET veya POST gerekli.');
        lab ??= createLaboratuvar(options.dataDir ? { dataDir: options.dataDir } : undefined);
        const response = req.method === 'GET' ? await lab.get() : await lab.post(await bodyJson(req, 8192));
        send(res, 200, response);
      } else if (requested === '/api/depo-laboratuvar') {
        if (req.method !== 'GET' && req.method !== 'POST') fail(405, 'GET veya POST gerekli.');
        depoLab ??= createDepoLaboratuvar(options.dataDir ? { dataDir: options.dataDir } : undefined);
        res.setTimeout(95000);
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', abort);
        try {
          const response = req.method === 'GET'
            ? await depoLab.get()
            : await depoLab.post(await bodyJson(req, 32 * 1024), controller.signal);
          if (!res.destroyed) send(res, 200, response);
        } finally {
          res.removeListener('close', abort);
        }
      } else if (requested === '/api/github-source') {
        await sourceRequest(req, res, 'github');
      } else if (requested === '/api/web-source') {
        await webSourceRequest(req, res);
      } else if (requested === '/api/source-zip') {
        await sourceRequest(req, res, 'zip');
      } else if (requested === '/api/source-files') {
        await sourceRequest(req, res, 'files');
      } else if (requested === '/api/gate-preset') {
        await sourceRequest(req, res, 'preset');
      } else if (requested === '/api/repo-run') {
        await repositoryRunRequest(req, res);
      } else if (requested === '/api/gate-flow') {
        await gateFlowRequest(req, res);
      } else if (requested === '/api/gate-canary') {
        await gateCanaryRequest(req, res);
      } else if (requested === '/api/modern-web-guidance') {
        if (req.method !== 'POST') fail(405, 'POST gerekli.');
        const body = await bodyJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'query') ||
            typeof body.query !== 'string') fail(400, 'Yalnız {query: string} kabul edilir.');
        const query = body.query.trim();
        // Tek argv değeri; kabuk yok; flag, kontrol karakteri ve kod/yol girdisi yok.
        if (!query || query.length > LIMIT.query || !/^[\p{L}\p{N}][\p{L}\p{N} .,:?()'"+\/-]*$/u.test(query)) fail(400, '1–500 karakterlik doğal dil arama sorgusu gerekli.');
        if (busy) fail(429, 'Bir arama zaten çalışıyor. Tamamlandıktan sonra tekrar deneyin.');
        busy = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LIMIT.requestMs);
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', abort);
        try { send(res, 200, await guidance(query, controller.signal)); }
        finally { busy = false; clearTimeout(timer); res.removeListener('close', abort); }
      } else {
        if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'GET veya HEAD gerekli.');
        await staticFile(req, res, requested);
      }
    } catch (e) {
      const status = e.status || (['ENOENT', 'ENOTDIR'].includes(e.code) ? 404 : 500);
      if (!res.headersSent && !res.destroyed) send(res, status, { error: e.status ? e.message : (status === 404 ? 'Dosya bulunamadı.' : 'Yerel sunucu işlemi tamamlanamadı.') }, undefined, req.method === 'HEAD');
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.timeout = 80000; server.keepAliveTimeout = 2000; server.maxHeadersCount = 40;
  server.on('checkContinue', (req, res) => send(res, 417, { error: 'Expect desteklenmiyor.' }));
  server.on('clientError', (_, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  return server;
}
function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  // npm engines >=22.0.0; izole çalışma için kararlı izin modeli >=22.18.0.
  if (major < 22 || (major === 22 && minor < 18)) throw new Error('Node.js 22.18+ gerekli.');
}
if (require.main === module) {
  checkNode();
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Geçerli bir yerel port gerekli.');
  const server = createServer();
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `${PORT} portu kullanımda; mevcut süreç korunuyor.` : 'Yerel HTTP sunucusu başlatılamadı.'); process.exitCode = 1; });
  server.listen(PORT, HOST, () => console.log(`Ürün Tanı: http://${HOST}:${PORT}/\nResmî CLI: ${PIN.name}@${PIN.version} (ilk aramada doğrulanarak proje cache alanına alınır).`));
  const shutdown = () => { for (const child of children) child.kill(); server.close(); server.closeAllConnections(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
module.exports = { createServer, checkNode, PIN };
