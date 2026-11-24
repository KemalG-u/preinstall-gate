'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { crc32, inflateRawSync } = require('node:zlib');
const { MAX_TEXT, privatePath, textName, pathRegistry, virtualEntries, sourceSnapshot, comparePaths } = require('./kaynak-paketi.cjs');

const MAX_ZIP = 32 * 1024 * 1024;
const MAX_ENTRIES = 15000;
const MAX_PATH_BYTES = 2 * 1024 * 1024;
const MAX_DECLARED_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_SKILLS = 8;
const MAX_WORKFLOWS = 16;
const MAX_PYTHON_FILES = 160;
const MAX_PYTHON_FILE_BYTES = 512 * 1024;
const MAX_PYTHON_BYTES = 2 * 1024 * 1024;
const MAX_PYTHON_PACKAGE_DATA_FILES = 32;
const MAX_PYTHON_PACKAGE_DATA_BYTES = 256 * 1024;
const MAX_JAVASCRIPT_FILES = 48;
const MAX_JAVASCRIPT_BYTES = 768 * 1024;
const MAX_OTHER_FILES = 12;
const MAX_OTHER_BYTES = 192 * 1024;
const usageJavascriptPath = /(?:^|\/)(?:tests?|__tests__|examples?)\/|(?:^|\/)(?:test|example)\.[^.]+$|\.(?:test|spec)\.[^.]+$/i;
const GIT_TIMEOUT = 12000;
const DOWNLOAD_TIMEOUT = 25000;
const TRANSIENT_TRANSPORT = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const cache = new Map();
let cacheBytes = 0;
const run = promisify(execFile);
const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const zipHelp = 'GitHub sayfasında Code → Download ZIP ile indirip ZIP dosyasını seçebilirsiniz.';

function failure(status, message) {
  throw Object.assign(new Error(message), { status });
}

function parseRepository(raw) {
  const match = typeof raw === 'string' && raw.trim().match(/^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,104})\/?$/i);
  const repo = match && match[2].replace(/\.git$/i, '');
  if (!repo || repo.length > 100 || repo === '.' || repo === '..') {
    failure(400, 'Herkese açık GitHub deposunun ana bağlantısını girin. Örnek https://github.com/sahip/depo');
  }
  return match[1] + '/' + repo;
}

function gitEnvironment() {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_PROTOCOL_FROM_USER: '0', LC_ALL: 'C' };
}

async function currentRevision(repository, signal) {
  // An explicit nonexistent git-dir keeps Git out of every local repository.
  const gitDir = path.join(process.execPath, '.git');
  const args = ['--git-dir', gitDir, '-c', 'credential.helper=',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      '-c', 'http.followRedirects=false', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=9',
      'ls-remote', '--symref', 'https://github.com/' + repository + '.git', 'HEAD'];
  const options = { cwd: path.dirname(process.execPath), env: gitEnvironment(), windowsHide: true,
    timeout: GIT_TIMEOUT, maxBuffer: 16384, signal };
  let stdout;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ({ stdout } = await run('git', args, options));
      break;
    } catch (error) {
      const stderr = error.stderr || '';
      if (error.code === 'ENOENT') failure(503, 'Git bilgisayarda bulunamadı. ' + zipHelp);
      const timeout = error.killed || signal.aborted || /timed out|timeout was reached|operation too slow/i.test(stderr);
      const transient = timeout || /failed to connect|could not resolve host|connection reset|early EOF/i.test(stderr);
      if (!attempt && !signal.aborted && transient) continue;
      if (timeout) failure(504, 'GitHub sürüm kontrolü zamanında tamamlanamadı. ' + zipHelp);
      if (/repository not found|could not read username|authentication|requested url returned error: (?:401|403|404|429)/i.test(stderr)) {
        failure(403, 'GitHub depoya otomatik erişim vermedi. Depo özel olabilir veya GitHub geçici olarak erişimi kısıtlamış olabilir. ' + zipHelp);
      }
      failure(502, 'GitHub sürümü alınamadı. Bağlantıyı kontrol edin veya ZIP yükleyin. ' + zipHelp);
    }
  }
  const sha = /^([0-9a-f]{40})\tHEAD\r?$/im.exec(stdout)?.[1]?.toLowerCase();
  const branch = /^ref: refs\/heads\/([^\x00-\x1f\x7f]{1,240})\tHEAD\r?$/m.exec(stdout)?.[1];
  if (!sha || !branch) failure(422, 'GitHub deposunun incelenebilir varsayılan sürümü bulunamadı. ' + zipHelp);
  return { sha, branch };
}

async function redirectedRepository(repository, signal) {
  const visited = new Set([repository.toLowerCase()]);
  let current = repository;
  let redirected = false;
  for (let hops = 0; hops < 5; hops++) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const response = await fetch('https://github.com/' + current, {
      method: 'HEAD', redirect: 'manual', signal: requestSignal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (redirected && response.ok) return current;
      return null;
    }
    const location = response.headers.get('location');
    let destination;
    try {
      destination = new URL(location, 'https://github.com/' + current);
    } catch {
      failure(502, 'GitHub yönlendirmesi geçerli bir depo adresi içermiyor.');
    }
    if (!location || destination.protocol !== 'https:' || destination.hostname !== 'github.com' ||
        destination.port || destination.username || destination.password || destination.search || destination.hash) {
      failure(502, 'GitHub yönlendirmesi güvenilir bir depo adresine gitmiyor.');
    }
    let next;
    try {
      next = parseRepository(destination.href);
    } catch {
      failure(502, 'GitHub yönlendirmesi geçerli bir depo adresi içermiyor.');
    }
    const key = next.toLowerCase();
    if (visited.has(key)) failure(502, 'GitHub depo yönlendirmesi döngü oluşturuyor.');
    visited.add(key);
    current = next;
    redirected = true;
  }
  failure(502, 'GitHub depo yönlendirmesi çok fazla adım içeriyor.');
}

async function downloadZip(repository, sha, signal) {
  const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT);
  const requestSignal = AbortSignal.any([signal, deadline]);
  const url = 'https://codeload.github.com/' + repository + '/zip/' + sha;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'error', signal: requestSignal });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        failure(502, 'GitHub bu sürümün arşivini gönderemedi. ' + zipHelp);
      }
      if (Number(res.headers.get('content-length')) > MAX_ZIP) {
        await res.body.cancel().catch(() => {});
        failure(413, 'GitHub arşivi 32 MB sınırını aşıyor.');
      }
      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > MAX_ZIP) failure(413, 'GitHub arşivi 32 MB sınırını aşıyor.');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      if (error.status) throw error;
      if (requestSignal.aborted) failure(504, 'GitHub arşivi zamanında indirilemedi. ' + zipHelp);
      if (attempt || !TRANSIENT_TRANSPORT.has(error.cause?.code || error.code)) {
        failure(502, 'GitHub arşivi indirilemedi. ' + zipHelp);
      }
    }
  }
}

function badZip() {
  failure(422, 'ZIP okunamadı. Tek parçalı, şifresiz ve geçerli bir ZIP dosyası seçin.');
}

function centralDirectory(bytes) {
  if (bytes.length > MAX_ZIP) failure(413, 'ZIP dosyası 32 MB sınırını aşıyor.');
  const earliest = Math.max(0, bytes.length - 22 - 65535);
  for (let pos = bytes.length - 22; pos >= earliest; pos--) {
    if (bytes.readUInt32LE(pos) !== 0x06054b50 || pos + 22 + bytes.readUInt16LE(pos + 20) !== bytes.length) continue;
    const count = bytes.readUInt16LE(pos + 10);
    const start = bytes.readUInt32LE(pos + 16);
    const size = bytes.readUInt32LE(pos + 12);
    if (bytes.readUInt16LE(pos + 4) || bytes.readUInt16LE(pos + 6) ||
        bytes.readUInt16LE(pos + 8) !== count || !count || count > MAX_ENTRIES || start + size !== pos) badZip();
    return { count, start, end: pos };
  }
  badZip();
}

function readDirectory(bytes) {
  const directory = centralDirectory(bytes);
  const entries = [];
  const registerPath = pathRegistry(badZip);
  let offset = directory.start;
  let declared = 0;
  let pathBytes = 0;
  for (let i = 0; i < directory.count; i++) {
    if (offset + 46 > directory.end || bytes.readUInt32LE(offset) !== 0x02014b50) badZip();
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const attributes = bytes.readUInt32LE(offset + 38);
    const local = bytes.readUInt32LE(offset + 42);
    const nameOffset = offset + 46;
    const next = nameOffset + nameSize + extraSize + commentSize;
    if (next > directory.end || !nameSize || bytes.readUInt16LE(offset + 34) ||
        flags & 0x2061 || size === 0xffffffff || compressed === 0xffffffff ||
        local + 30 > directory.start || bytes.readUInt32LE(local) !== 0x04034b50) badZip();
    const nameBytes = bytes.subarray(nameOffset, nameOffset + nameSize);
    let name;
    try { name = decode.decode(nameBytes); } catch { badZip(); }
    const folder = name.endsWith('/');
    registerPath(folder ? name.slice(0, -1) : name, folder);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > directory.start || bytes.readUInt16LE(local + 6) !== flags ||
        bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 26) !== nameSize ||
        !bytes.subarray(local + 30, local + 30 + nameSize).equals(nameBytes)) badZip();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== checksum ||
        bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) badZip();
    declared += size;
    pathBytes += nameSize;
    if (declared > MAX_DECLARED_BYTES || pathBytes > MAX_PATH_BYTES) failure(413, 'ZIP içeriği inceleme boyutu sınırını aşıyor.');
    const host = bytes.readUInt16LE(offset + 4) >>> 8;
    const mode = attributes >>> 28;
    const regular = !folder && !(attributes & 0x10) && (!(host === 3 || host === 19) || mode === 0 || mode === 8);
    entries.push({ name, regular, folder, method, checksum, size, start, compressed, local });
    offset = next;
  }
  if (offset !== directory.end) badZip();
  const byOffset = [...entries].sort((a, b) => a.local - b.local);
  for (let i = 1; i < byOffset.length; i++) {
    const previous = byOffset[i - 1];
    if (previous.start + previous.compressed > byOffset[i].local) badZip();
  }
  return entries;
}

function textOf(bytes, file) {
  const maxAllowed = file.name.endsWith('.py') ? MAX_PYTHON_FILE_BYTES : MAX_TEXT;
  if (file.size > maxAllowed || (file.method !== 0 && file.method !== 8)) return null;
  const compressed = bytes.subarray(file.start, file.start + file.compressed);
  let content;
  try {
    content = file.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, file.size) });
  } catch { badZip(); }
  if (content.length !== file.size || crc32(content) !== file.checksum) badZip();
  let text;
  try { text = decode.decode(content); } catch { return null; }
  return text.includes('\0') ? null : (file.name.endsWith('/__init__.py') || file.name === '__init__.py' ? (text || '# package\n') : (!text.trim() ? null : text));
}

const readmeName = /^(?:(?:\.github|docs)\/)?README(?:\.[^/]+)?$/i;
const skillName = /^(?:[^/.][^/]*\/)*SKILL\.md$/;
const workflowName = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const projectManifest = /^(?:package\.json|pyproject\.toml|requirements(?:[-_.][^/]*)?\.txt|setup\.(?:py|cfg)|Pipfile|Cargo\.toml|go\.mod|composer\.json|Gemfile|pom\.xml|Dockerfile)$/i;
const sourceAtRoot = name => projectManifest.test(name) || readmeName.test(name) || skillName.test(name) || workflowName.test(name);

function skillSupport(items, files) {
  const byName = new Map(items.map(item => [item.name, item]));
  const supported = new Set();
  for (const file of files.filter(file => skillName.test(file.name))) {
    const parent = file.name.slice(0, -'SKILL.md'.length);
    const references = file.text.matchAll(/(?:`|\]\()(\.?\/?(?:scripts|references|assets)\/[a-zA-Z0-9_.\/-]{1,180})(?=`|\)|\s)/g);
    for (const match of references) {
      const relative = match[1].replace(/^\.\//, '');
      if (relative.split('/').some(part => !part || part === '.' || part === '..')) continue;
      const item = byName.get(parent + relative);
      if (item && supported.size < 24) supported.add(item);
    }
  }
  return supported;
}

const javascriptName = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const excludedJavascriptPath = /(?:^|\/)(?:node_modules|\.git|\.github|tests?|__tests__|fixtures?|coverage|docs?|examples?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i;

function exportTargets(value, depth = 0, targets = []) {
  if (depth > 5 || targets.length >= 24 || value === null) return targets;
  if (typeof value === 'string' && value.startsWith('./')) targets.push(value);
  if (value && typeof value === 'object') {
    for (const item of Object.values(value).slice(0, 24)) {
      exportTargets(item, depth + 1, targets);
      if (targets.length >= 24) break;
    }
  }
  return targets;
}

function javascriptSelection(readText, items, manifest, limitations) {
  const preferred = new Set();
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest.text);
      const bins = typeof parsed?.bin === 'string' ? [parsed.bin] :
        parsed?.bin && typeof parsed.bin === 'object' ? Object.values(parsed.bin).slice(0, 24) : [];
      const exports = parsed?.exports;
      for (const name of [...bins, parsed?.main, parsed?.module, ...exportTargets(exports?.['.'] ?? exports)]) {
        if (typeof name !== 'string') continue;
        const relative = name.replace(/^\.\//, '');
        if (!relative.split('/').some(part => !part || part === '.' || part === '..') &&
            !/[\\:*\x00-\x1f\x7f]/.test(relative) &&
            (javascriptName.test(relative) || /^[^/.]+(?:\/[^/.]+)*$/.test(relative))) preferred.add(relative);
      }
    } catch { /* The regular source view retains the unparsed manifest text. */ }
  }
  const candidates = items.filter(item => !excludedJavascriptPath.test(item.name) &&
    (preferred.has(item.name) || javascriptName.test(item.name)));
  if (!candidates.length) return [];
  const ranks = new Map([...preferred].map((name, index) => [name, index]));
  candidates.sort((a, b) => (ranks.get(a.name) ?? Infinity) - (ranks.get(b.name) ?? Infinity) ||
    a.name.split('/').length - b.name.split('/').length);
  const selected = manifest ? [manifest] : [];
  let budget = MAX_JAVASCRIPT_BYTES;
  let count = 0;
  for (const candidate of candidates) {
    if (candidate.name === manifest?.name || count >= MAX_JAVASCRIPT_FILES || candidate.size > budget) continue;
    const file = readText(candidate);
    if (!file || (!javascriptName.test(candidate.name) && !/^#![^\r\n]*\bnode\b/.test(file.text))) continue;
    selected.push(file);
    budget -= candidate.size;
    count++;
  }
  if (count < candidates.length) limitations.push(`REA için ${candidates.length} JavaScript adayından ${count} tanesinin metni açıldı.`);
  return count ? selected : [];
}

function javascriptUsage(readText, items, selected) {
  const known = new Set(selected.map(file => file.name));
  const candidates = items.filter(item => !known.has(item.name) && javascriptName.test(item.name) &&
    usageJavascriptPath.test(item.name) && !/(?:^|\/)(?:node_modules|\.git|coverage|fixtures?)\//i.test(item.name) &&
    item.size <= 12 * 1024).slice(0, 8);
  return candidates.map(readText).filter(Boolean);
}

function readZip(bytes, remote = false) {
  const entries = readDirectory(bytes);
  const regular = entries.filter(entry => entry.regular);
  if (!regular.length) failure(422, 'ZIP içinde okunabilecek dosya bulunamadı.');
  const outer = regular[0].name.split('/')[0];
  const prefix = outer + '/';
  const common = regular.every(entry => entry.name.startsWith(prefix));
  if (remote && !common) badZip();
  const knownDirectory = ['.github', 'docs', 'examples', 'lib', 'skills', 'src', 'test', 'tests'].includes(outer.toLowerCase());
  const removePrefix = common && (remote || (!knownDirectory && !privatePath(outer) &&
    (/-[\da-f]{40}$/i.test(outer) || regular.some(entry => sourceAtRoot(entry.name.slice(prefix.length))))));
  const items = regular.map(entry => ({ ...entry, name: removePrefix ? entry.name.slice(prefix.length) : entry.name }));
  const nonRegular = entries.filter(entry => !entry.regular && !entry.folder).length;
  return selectSource(items, file => textOf(bytes, file), remote ? 'github' : 'zip', bytes, nonRegular);
}

const lfsPointer = /^\uFEFF?version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n(?:[^\r\n]+\r?\n){0,8}oid sha256:[\da-f]{64}\r?\nsize \d+(?:\r?\n)?$/i;

function selectSource(allItems, readContent, kind, artifact, nonRegular = 0) {
  const virtual = kind === 'file' || kind === 'folder';
  const publicItems = allItems.filter(item => !privatePath(item.name));
  const items = (virtual ? publicItems.filter(item => textName.test(item.name)) : publicItems).sort((a, b) => comparePaths(a.name, b.name));
  const privateCount = allItems.length - publicItems.length;
  const unsupportedCount = publicItems.length - items.length;
  const readme = items.filter(item => readmeName.test(item.name)).sort((a, b) =>
    readmePriority(a.name) - readmePriority(b.name))[0];
  const skills = items.filter(item => item.name !== 'SKILL.md' && skillName.test(item.name));
  const workflows = items.filter(item => workflowName.test(item.name));
  const manifests = items.filter(item => projectManifest.test(item.name));
  const picks = [readme, ...manifests.slice(0, 8), items.find(item => item.name === 'SKILL.md'),
    ...skills.slice(0, MAX_SKILLS), ...workflows.slice(0, MAX_WORKFLOWS)].filter(Boolean);
  const files = [];
  const limitations = [];
  if (privateCount) limitations.push(`${privateCount} gizli dosya veya bağımlılık kaydı inceleme dışında bırakıldı.`);
  if (unsupportedCount) limitations.push(`${unsupportedCount} dosyanın türü metin olarak desteklenmiyor.`);
  if (nonRegular) limitations.push(`${nonRegular} bağlantı veya normal dosya olmayan arşiv kaydı açılmadı.`);
  if (skills.length > MAX_SKILLS) limitations.push(`${skills.length} beceriden ilk ${MAX_SKILLS} tanesinin içeriği seçildi.`);
  if (workflows.length > MAX_WORKFLOWS) limitations.push(`${workflows.length} GitHub Actions dosyasından ilk ${MAX_WORKFLOWS} tanesinin içeriği seçildi.`);
  const reads = new Map();
  let lfsCount = 0;
  const readText = item => {
    if (reads.has(item.name)) return reads.get(item.name);
    const text = readContent(item);
    const pointer = typeof text === 'string' && lfsPointer.test(text);
    if (pointer) lfsCount++;
    const result = text === null || pointer ? null : { name: item.name, text };
    reads.set(item.name, result);
    return result;
  };
  const pick = item => {
    const file = readText(item);
    if (file) files.push(file);
  };
  for (const item of picks) pick(item);
  for (const item of skillSupport(items, files)) pick(item);
  const javascript = javascriptSelection(readText, items, files.find(file => file.name === 'package.json'), limitations);
  const usage = javascript.length ? javascriptUsage(readText, items, javascript) : [];

  let pythonCandidateTotal = 0;
  let pythonSelectedCount = 0;
  const python = [];
  const pyManifestNames = new Set(['pyproject.toml', 'setup.cfg', 'setup.py', 'requirements.txt']);
  const pyManifestItems = items.filter(item => pyManifestNames.has(item.name));
  const candidates = items.filter(item => /^(?:src\/)?(?:[A-Za-z_]\w*\/)*[A-Za-z_]\w*\.py$/.test(item.name) &&
    !/^(?:src\/)?(?:tests?|docs?|examples?)\//i.test(item.name) && item.name !== 'setup.py');
  pythonCandidateTotal = candidates.length;
  if (pyManifestItems.length || candidates.length) {
    for (const mItem of pyManifestItems) {
      const mFile = readText(mItem);
      if (mFile) {
        python.push(mFile);
      } else if (mItem.name === 'pyproject.toml') {
        limitations.push('pyproject.toml okunamadı.');
      }
    }
    candidates.sort((a, b) => Number(!a.name.startsWith('src/')) - Number(!b.name.startsWith('src/')) ||
      a.name.split('/').length - b.name.split('/').length);
    let budget = MAX_PYTHON_BYTES;
    let pyCount = 0;
    const packagePrefixes = new Set();
    for (const file of candidates) {
      if (pyCount >= MAX_PYTHON_FILES || file.size > budget) continue;
      const candidate = readText(file);
      if (!candidate) continue;
      python.push(candidate);
      pyCount++;
      budget -= file.size;
      const slashIdx = file.name.indexOf('/');
      if (slashIdx > 0) {
        const parts = file.name.split('/');
        const pkgRoot = parts[0] === 'src' && parts.length > 2 ? `src/${parts[1]}/` : `${parts[0]}/`;
        packagePrefixes.add(pkgRoot);
      }
    }
    pythonSelectedCount = pyCount;
    if (pyCount < candidates.length) limitations.push(`${candidates.length} Python dosyasından ${pyCount} tanesinin metni açıldı.`);

    // Include small text package-data files (.yaml/.yml/.json/.toml/.cfg/.ini/.txt) inside Python packages (e.g. default configs)
    if (packagePrefixes.size > 0) {
      const pkgDataRegex = /\.(?:ya?ml|json|toml|cfg|ini|txt)$/i;
      let dataBudget = MAX_PYTHON_PACKAGE_DATA_BYTES;
      let dataCount = 0;
      for (const item of items) {
        if (dataCount >= MAX_PYTHON_PACKAGE_DATA_FILES || item.size > dataBudget) continue;
        if (!pkgDataRegex.test(item.name) || /^(?:src\/)?(?:tests?|docs?|examples?)\//i.test(item.name)) continue;
        if (![...packagePrefixes].some(pref => item.name.startsWith(pref))) continue;
        const dFile = readText(item);
        if (!dFile) continue;
        python.push(dFile);
        dataCount++;
        dataBudget -= item.size;
      }
    }
  }
  const selectedNames = new Set([...files, ...javascript, ...usage, ...python].map(file => file.name));
  let otherBudget = MAX_OTHER_BYTES;
  let otherCount = 0;
  for (const item of items) {
    if (otherCount >= MAX_OTHER_FILES || item.size > otherBudget || !textName.test(item.name)) continue;
    if (selectedNames.has(item.name) && (kind !== 'file' || files.length)) continue;
    const file = readText(item);
    if (!file) continue;
    files.push(file);
    otherCount++;
    otherBudget -= item.size;
  }
  const selected = [...files, ...python, ...javascript, ...usage];
  const snapshot = sourceSnapshot(kind, selected, allItems.length + nonRegular, artifact);
  if (lfsCount) limitations.push(`${lfsCount} Git LFS işaretçisinin asıl dosyası bu kaynakta yer almıyor.`);
  const unreadable = [...reads.values()].filter(file => !file).length - lfsCount;
  if (unreadable) limitations.push(`${unreadable} dosya boş, metin olarak okunamadı veya dosya boyutu sınırını aştı.`);
  const unselected = items.length - snapshot.readCount;
  if (unselected) limitations.push(`${unselected} dosya seçilen metinler arasına girmedi. İnceleme ${snapshot.readCount} dosyanın içeriğine dayanıyor.`);
  return { files, python, javascript, usage, paths: items.map(item => item.name), limitations,
    partial: Boolean(limitations.length), snapshot,
    pythonTruncated: pythonCandidateTotal > pythonSelectedCount,
    pythonCandidateTotal, pythonSelectedCount };
}

function readmePriority(name) {
  const lower = name.toLowerCase();
  const location = lower.startsWith('.github/') ? 1 : lower.startsWith('docs/') ? 2 : 0;
  return location * 3 + (/README\.md$/i.test(name) ? 0 : /README$/i.test(name) ? 1 : 2);
}

function putCache(key, data) {
  const size = Buffer.byteLength(JSON.stringify(data));
  if (size > MAX_CACHE_BYTES) return;
  while (cache.size && (cache.size >= 6 || cacheBytes + size > MAX_CACHE_BYTES)) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).size;
    cache.delete(oldest);
  }
  cache.set(key, { data, size });
  cacheBytes += size;
}

async function githubSource(url, signal) {
  let repository = parseRepository(url);
  try {
    repository = await redirectedRepository(repository, signal) || repository;
  } catch (error) {
    if (error.status || signal.aborted) throw error;
  }
  const revision = await currentRevision(repository, signal);
  const key = repository.toLowerCase() + '/' + revision.sha;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return { ...cached.data, ...revision, repository, cached: true };
  }
  const bytes = await downloadZip(repository, revision.sha, signal);
  const data = readZip(bytes, true);
  if (!cache.has(key)) putCache(key, data);
  return { ...data, ...revision, repository, cached: false };
}

function uploadedSource(bytes) {
  return { ...readZip(bytes), cached: false };
}

function localFilesSource(input) {
  const entries = virtualEntries(input);
  if (!entries.some(item => !privatePath(item.name) && textName.test(item.name))) {
    failure(422, 'Seçimde desteklenen, gizli olmayan bir metin dosyası bulunamadı.');
  }
  const source = selectSource(entries, file => file.text.trim() ? file.text : null,
    input.kind, input.kind === 'file' ? Buffer.from(entries[0].text) : undefined);
  if (!source.snapshot.readCount) failure(422, 'Seçilen dosyalarda okunabilir metin bulunamadı.');
  return source;
}

module.exports = { githubSource, uploadedSource, localFilesSource, downloadZip, MAX_ZIP };
