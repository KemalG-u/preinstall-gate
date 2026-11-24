'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const repository = 'mathiasbynens/he';
const revision = 'ab02411089036b31ddc6ec20def9a8712be41622';
const option = '--encode';
const command = 'he ' + option;
const cli = 'bin/he.mjs';
const library = 'src/he.mjs';
const files = Object.freeze({
  'package.json': 'fd52c2036e61914e697f91841f719be9e776a32b78399af162213d6eed39e760',
  'bin/he.mjs': 'c4fe81bc8f3d7ab9329d7685cbf9cf0d5e61cb0c3b6753798c513d364616fafd',
  'src/he.mjs': '52a9a510e3d005e4cd016962ceaa74a54d4ecfc2cd7d203797c57d2da76942ea',
  'src/data.mjs': '84dba87d00672818e54e7e64789d9bb831ac246471a5af229af9ffb07533dcfc',
  'LICENSE-MIT.txt': '483acb265f182907d1caf6cff9c16c96f31325ed23792832cc5d8b12d5f88c8a',
});

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function matches(job, rea, sources) {
  if (rea.status !== 'ok' ||
      !rea.context?.imports?.some(item => item.path === cli && item.target === library) ||
      !rea.context?.functions?.some(item => item.path === library && item.name === 'encode') ||
      !Array.isArray(job.evidence)) return false;

  const conflicting = job.evidence.some(item =>
    (item.role === 'trigger' && item.path === cli &&
      ((item.line >= 15 && item.line <= 20) || (item.line >= 27 && item.line <= 74))) ||
    (item.role === 'producer' && item.path === library && item.line >= 182 && item.line <= 252));
  if (conflicting) return false;

  const lines = new Map(sources.filter(file => file.name === cli || file.name === library)
    .map(file => [file.name, file.text.split(/\r?\n/)]));
  const evidence = job.evidence.filter(item => typeof item.quote === 'string' &&
    lines.get(item.path)?.[item.line - 1]?.trim() === item.quote);
  return evidence.some(item => item.role === 'trigger' && item.path === cli &&
      ((item.line === 22 && item.quote === "'--encode',") || (item.line === 24 && item.quote === "action = 'encode';"))) &&
    evidence.some(item => item.role === 'producer' && item.path === library && item.line >= 93 && item.line <= 177) &&
    evidence.some(item => item.role === 'consumer' && item.path === cli && item.line === 118 &&
      item.quote === 'log(he[action](string, options));');
}

async function load(name, digest, signal) {
  const response = await fetch(`https://raw.githubusercontent.com/${repository}/${revision}/${name}`, { signal, redirect: 'error' });
  if (!response.ok || !response.body) throw error(502, 'Deneme için doğrulanmış he kaynağı indirilemedi.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 160 * 1024) throw error(502, 'he deneme kaynağı boyut sınırını aştı.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw error(502, 'he deneme dosyasının özeti eşleşmedi.');
  return bytes;
}

function invoke(work, input, signal, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${work}`, path.join(work, cli), option], {
      cwd: work, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let size = 0;
    let failure;
    const stop = reason => { failure ||= reason; child.kill(); };
    const abort = () => stop(error(408, 'İstek iptal edildi.'));
    const timeout = setTimeout(() => stop(error(504, 'he komutu süre sınırını aştı.')), 7000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const collect = (bytes, stdout) => {
      size += bytes.length;
      if (size > 64 * 1024) stop(error(502, 'he komutu çıktı sınırını aştı.'));
      else if (stdout) chunks.push(bytes);
    };
    child.stdout.on('data', bytes => collect(bytes, true));
    child.stderr.on('data', bytes => collect(bytes, false));
    child.stdin.on('error', () => {});
    child.on('error', () => { failure ||= error(503, 'he komutu başlatılamadı.'); });
    child.on('close', code => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(error(502, 'he komutu tamamlanamadı.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input, 'utf8');
  });
}

async function run(input, signal, { safeDirectories, processEnv }) {
  // The upstream CLI interprets exact option names even when read from stdin.
  if (/^--(?:encode|decode|escape|use-named-refs|everything|decimal|allow-unsafe|attribute|strict)$/.test(input.trim())) {
    throw error(400, 'he komut seçeneği olarak yorumlanabilecek tek başına bir ifade girildi. İfadeyi örnek metnin içinde kullanın.');
  }
  const download = AbortSignal.timeout(12000);
  const downloadSignal = AbortSignal.any([signal, download]);
  const assets = await Promise.all(Object.entries(files).map(async ([name, digest]) => [name, await load(name, digest, downloadSignal)]))
    .catch(cause => {
      if (signal.aborted) throw error(408, 'İstek iptal edildi.');
      if (download.aborted) throw error(504, 'he kaynağını indirme süresi doldu.');
      throw cause.status ? cause : error(502, 'he kaynağına ulaşılamadı.');
    });
  const cache = path.join(__dirname, '.cache', 'he');
  await safeDirectories(__dirname, cache);
  const work = await fs.mkdtemp(path.join(cache, 'trial-'));
  try {
    await Promise.all(['bin', 'src'].map(name => fs.mkdir(path.join(work, name))));
    await Promise.all(assets.map(([name, bytes]) => fs.writeFile(path.join(work, name), bytes, { flag: 'wx' })));
    const output = await invoke(work, input, signal, processEnv(work));
    return { output, detail: command + ' komutu dönüştürülen metni standart çıktıya yazdı. Aşağıda komutun gerçek çıktısı var.' };
  } finally {
    // work is created here under the app's checked cache directory.
    await fs.rm(work, { recursive: true, force: true });
  }
}

module.exports = { repository, revision, command, matches, run };
